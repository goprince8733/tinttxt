/**
 * 文件层 —— 编码探测与解码
 *
 * 硬性要求：绝不默认 UTF-8。探测顺序：
 *   1. BOM（UTF-8 / UTF-16LE / UTF-16BE）
 *   2. UTF-8 严格解码（multibyte 序列合法）
 *   3. GB18030（GBK 超集）解码合理性检查
 *   4. ANSI/本地代码页兜底（windows-1252 / gbk 试探）
 * 任何一步失败都返回结构化结果，由 UI 层提供「手动选编码」入口。
 */

/** @typedef {{ ok: true, text: string, encoding: string, confidence: number, bom: boolean, warnings: string[] }} DecodeSuccess */
/** @typedef {{ ok: false, encoding: string, error: string, candidates: string[] }} DecodeFailure */
/** @typedef {DecodeSuccess | DecodeFailure} DecodeResult */

export const COMMON_ENCODINGS = [
  'utf-8',
  'gb18030',
  'gbk',
  'big5',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'iso-8859-1',
];

/** 贪婪匹配中文/常见字符的可读性启发式分值（0..1）。 */
function cjkReadabilityScore(text) {
  if (!text) return 0;
  let sampleLen = 0;
  let good = 0;
  let replacement = 0;
  const step = Math.max(1, Math.floor(text.length / 5000));
  for (let i = 0; i < text.length; i += step) {
    const ch = text.charCodeAt(i);
    sampleLen++;
    if (ch === 0xfffd) {
      replacement++;
      continue;
    }
    // 控制字符（除 \t \r \n）计为坏
    if (ch < 32 && ch !== 9 && ch !== 10 && ch !== 13) continue;
    good++;
  }
  if (!sampleLen) return 0;
  if (replacement > 0) return Math.max(0, 0.5 - replacement / sampleLen);
  return good / sampleLen;
}

/** UTF-8 严格性检查：用 fatal 解码，失败即非法。 */
function strictUtf8(bytes) {
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    const text = dec.decode(bytes);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function decodeWith(encoding, bytes) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch (e) {
    return null;
  }
}

function stripBom(text) {
  if (text.charCodeAt(0) === 0xfeff) return { text: text.slice(1), had: true };
  return { text, had: false };
}

/**
 * 探测并解码。
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{ forceEncoding?: string|null }} [opts]
 * @returns {DecodeSuccess|DecodeFailure}
 */
export function decodeTextFile(input, opts = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings = [];
  const candidates = [];

  // ---- 0. 手动强制编码 ----
  if (opts.forceEncoding) {
    const text = decodeWith(opts.forceEncoding, bytes);
    if (text == null) {
      return {
        ok: false,
        encoding: opts.forceEncoding,
        error: `编码 ${opts.forceEncoding} 在此浏览器不可用`,
        candidates: COMMON_ENCODINGS,
      };
    }
    const stripped = stripBom(text);
    const score = cjkReadabilityScore(stripped.text.slice(0, 20000));
    if (score < 0.6) {
      return {
        ok: false,
        encoding: opts.forceEncoding,
        error: `按 ${opts.forceEncoding} 解码后乱码比例过高，可能选错了编码`,
        candidates: COMMON_ENCODINGS,
      };
    }
    return {
      ok: true,
      text: normalizeNewlines(stripped.text),
      encoding: opts.forceEncoding,
      confidence: score,
      bom: stripped.had,
      warnings,
    };
  }

  // ---- 1. BOM ----
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const r = strictUtf8(bytes.subarray(3));
    if (r.ok) {
      return { ok: true, text: normalizeNewlines(r.text), encoding: 'utf-8', confidence: 1, bom: true, warnings };
    }
    warnings.push('检测到 UTF-8 BOM 但内容非法，转为继续探测');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const t = decodeWith('utf-16le', bytes.subarray(2));
    if (t != null) {
      return { ok: true, text: normalizeNewlines(t), encoding: 'utf-16le', confidence: 1, bom: true, warnings };
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const t = decodeWith('utf-16be', bytes.subarray(2));
    if (t != null) {
      return { ok: true, text: normalizeNewlines(t), encoding: 'utf-16be', confidence: 1, bom: true, warnings };
    }
  }

  // ---- 2. UTF-8 严格解码（无 BOM） ----
  const strict = strictUtf8(bytes);
  if (strict.ok) {
    return { ok: true, text: normalizeNewlines(strict.text), encoding: 'utf-8', confidence: 1, bom: false, warnings };
  }

  // ---- 3. GB18030 / Big5 ----
  const gbkText = decodeWith('gb18030', bytes);
  if (gbkText != null) {
    const score = cjkReadabilityScore(gbkText.slice(0, 20000));
    candidates.push('gb18030');
    if (score >= 0.75) {
      return { ok: true, text: normalizeNewlines(gbkText), encoding: 'gb18030', confidence: score, bom: false, warnings };
    }
  }

  const big5Text = decodeWith('big5', bytes);
  if (big5Text != null) {
    const score = cjkReadabilityScore(big5Text.slice(0, 20000));
    candidates.push('big5');
    if (score >= 0.85) {
      return { ok: true, text: normalizeNewlines(big5Text), encoding: 'big5', confidence: score, bom: false, warnings };
    }
  }

  // ---- 4. ANSI 兜底 ----
  for (const enc of ['windows-1252', 'gbk']) {
    const t = decodeWith(enc, bytes);
    if (t == null) continue;
    candidates.push(enc);
    const score = cjkReadabilityScore(t.slice(0, 20000));
    if (score >= 0.6) {
      warnings.push(`按 ${enc} 兜底解码，建议人工确认编码`);
      return { ok: true, text: normalizeNewlines(t), encoding: enc, confidence: score, bom: false, warnings };
    }
  }

  return {
    ok: false,
    encoding: 'unknown',
    error: '无法识别文件编码（可能已损坏或不是纯文本）',
    candidates: [...new Set(candidates), ...COMMON_ENCODINGS],
  };
}

/** 统一换行 + 去 BOM + 去零宽字符。 */
export function normalizeNewlines(text) {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 零宽字符（ZWSP/ZWNJ/ZWJ/方向控制/BOM 变体）会干扰断句与偏移，一律去除
  t = t.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '');
  return t;
}

/**
 * 用 File/Blob 读取为 ArrayBuffer（必须由用户手势触发）。
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(/** @type {ArrayBuffer} */ (fr.result));
    fr.onerror = () => reject(new Error(fr.error ? fr.error.message : '读取文件失败'));
    fr.readAsArrayBuffer(file);
  });
}
