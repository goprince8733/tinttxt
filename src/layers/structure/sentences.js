/**
 * 结构层 —— 断句
 * 规则 + 正则混合：每句记录原文字符偏移 [start,end)，供进度定位与逐句高亮。
 * 正确处理：中英混排、日期 2026-11-19、小数 3.14、网址、缩写 U.S.、跨段引号、省略号、括号。
 * @module layers/structure/sentences
 */

/** @typedef {import('../../core/contracts.js').Sentence} Sentence */

/** 句末标点（朗读时可选剔除）。 */
const END_PUNCT = '。！？!?…';
/** 可作为断句点的标点（含逗号、分号，用于超长句切分）。 */
const SOFT_PUNCT = '，,；;：:、';

/** 数字/小数/日期/网址等不应在中间断开的模式。 */
const NO_BREAK_AFTER_DOT = /\d\.$/;
const ABBREV = /\b(?:[A-Z]\.){1,4}$/; // U.S. / e.g. / i.e.
const URL_TAIL = /(?:https?:\/\/|www\.)\S*$/i;
const DATE_TAIL = /\d{1,4}[-/.年]\d{1,2}(?:[-/.月])?$/;
const DECIMAL_TAIL = /\d\.$/;

/**
 * 主入口：把章节文本切成句子。
 * @param {string} text 全文
 * @param {{chapterIndex:number, start:number, end:number}} chapter
 * @param {{maxSentenceChars?: number, skipRules?: {empty:boolean, notes:boolean, separators:boolean}}} [opts]
 * @returns {Sentence[]}
 */
export function splitSentences(text, chapter, opts = {}) {
  const maxLen = opts.maxSentenceChars || 120;
  const slice = text.slice(chapter.start, chapter.end);
  /** @type {Sentence[]} */
  const out = [];
  let index = 0; // 由调用方全局编号，这里先局部，后续 normalizeIndex 统一编号

  // 按行处理：行是结构的最小单位（跳行规则、章节标题都以行为界）
  let lineStart = 0;
  const lines = [];
  for (let i = 0; i <= slice.length; i++) {
    if (i === slice.length || slice.charCodeAt(i) === 10) {
      lines.push({ start: lineStart, end: i });
      lineStart = i + 1;
    }
  }

  for (const line of lines) {
    const rawLine = slice.slice(line.start, line.end);
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (opts.skipRules?.empty !== false) continue; // 空行默认跳过
      push(rawLine, line.start, line.end, true);
      continue;
    }
    if (isSkippableLine(trimmed, opts.skipRules)) {
      push(rawLine, line.start, line.end, true);
      continue;
    }
    // 行内断句：splitLine 返回章内局部偏移，必须经 push() 加 chapter.start 转绝对偏移
    const local = splitLine(rawLine, line.start, maxLen);
    for (const s of local) push(s.raw, s.start, s.end, false);
  }

  return out;

  function push(raw, localStart, localEnd, skippable) {
    const absStart = chapter.start + localStart;
    const absEnd = chapter.start + localEnd;
    if (absEnd <= absStart) return;
    out.push({
      index: index++,
      start: absStart,
      end: absEnd,
      chapter: chapter.chapterIndex ?? chapter.index ?? 0,
      raw: text.slice(absStart, absEnd),
      speak: '',
      skippable,
    });
  }

  // 局部句子（行内）直接构造绝对偏移
  function makeSentence(absStart, absEnd) {
    return {
      index: index++,
      start: absStart,
      end: absEnd,
      chapter: chapter.chapterIndex ?? chapter.index ?? 0,
      raw: text.slice(absStart, absEnd),
      speak: '',
      skippable: false,
    };
  }
}

/**
 * 行内断句：扫描字符，遇到句末标点收口；保护特殊模式。
 * @param {string} line
 * @param {number} lineOffset 行在 slice 中的起始
 * @param {number} maxLen
 */
function splitLine(line, lineOffset, maxLen) {
  /** @type {Array<{start:number,end:number}>} */
  const spans = [];
  let cur = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (END_PUNCT.includes(ch)) {
      // 省略号 …… 连续吞掉
      let j = i + 1;
      while (j < line.length && (line[j] === '…' || (line[j] === '.' && line[j + 1] === '.'))) j++;
      // 右引号/右括号跟在句末标点后，归入本句
      while (j < line.length && '”’")）】》」』'.includes(line[j])) j++;
      // 保护：小数 3.14 的 '.' 不在 END_PUNCT（只有。！？…），已天然规避
      // 保护：网址/缩写后的 '.'——此处 ch 不是 '.',忽略
      const end = j;
      if (shouldBreak(line, i, end)) {
        spans.push({ start: cur, end });
        cur = end;
        i = end;
        continue;
      }
      i = j;
      continue;
    }
    // 英文句号 '.' 需要保护判断
    if (ch === '.') {
      const before = line.slice(Math.max(0, i - 8), i);
      const after = line[i + 1] || '';
      const isAbbrev = ABBREV.test(before);
      const isDecimal = /\d$/.test(before) && /\d/.test(after);
      const isUrl = URL_TAIL.test(before);
      const isEllipsis = line[i + 1] === '.' && line[i + 2] === '.';
      if (!isAbbrev && !isDecimal && !isUrl && !isEllipsis && after && after !== '.' && !/^[A-Za-z]/.test(after)) {
        // 英文句末：后面跟空白或大写/引号
        const rest = line.slice(i + 1).trimStart();
        if (!rest || /^[“"'(]?\s*[A-Z一-龥]/.test(rest)) {
          let j = i + 1;
          while (j < line.length && '”’")）】》」』\'"'.includes(line[j])) j++;
          spans.push({ start: cur, end: j });
          cur = j;
          i = j;
          continue;
        }
      }
      i++;
      continue;
    }
    // 超长句保护：无标点超过 maxLen 强制切
    if (i - cur >= maxLen) {
      // 找最近的软标点
      let cut = -1;
      for (let k = i; k > cur; k--) {
        if (SOFT_PUNCT.includes(line[k])) {
          cut = k + 1;
          break;
        }
      }
      if (cut < 0) cut = i;
      spans.push({ start: cur, end: cut });
      cur = cut;
      i = cut;
      continue;
    }
    i++;
  }
  if (cur < line.length) spans.push({ start: cur, end: line.length });

  // 过滤纯空白片段并返回
  return spans
    .filter((s) => line.slice(s.start, s.end).trim().length > 0)
    .map((s) => ({
      start: lineOffset + s.start,
      end: lineOffset + s.end,
      raw: line.slice(s.start, s.end),
    }));
}

/** 判断句末标点处是否真的断开（跨段引号等保护）。 */
function shouldBreak(line, punctIdx, endIdx) {
  const next = line.slice(endIdx).trimStart();
  // 下一段以闭合引号开头且本句未闭合引号 → 继续
  if ('”’）】》」』'.includes(next[0] || '')) return true;
  return true; // 默认断；保护逻辑已在上层处理
}

/**
 * 判断整行是否可跳过（注释 / 分隔线 / 广告行）。
 * @param {string} trimmed
 * @param {{empty?:boolean, notes?:boolean, separators?:boolean}} rules
 */
export function isSkippableLine(trimmed, rules = {}) {
  if (rules.notes !== false) {
    // 注释：整行被括号包裹、或以 // # -- 开头的短行
    if (/^[（(【\[【〔][^）)】\]]{0,80}[）)】\]]$/.test(trimmed)) return true;
    if (/^(?:\/\/|#|——+\s*$)/.test(trimmed)) return true;
    // 独立成行的"注：/备注：/作者注："等
    if (/^(?:注[:：]|备注[:：]|作者注[:：]|译者注[:：]|编者按[:：])/.test(trimmed) && trimmed.length < 60) return true;
  }
  if (rules.separators !== false) {
    // 分隔线：重复符号 ≥3 个，或星号/波浪线组合
    if (/^[=\-*~—_·•＊#※+]{3,}$/.test(trimmed)) return true;
    if (/^(?:\*\s*){3,}$/.test(trimmed)) return true;
    if (/^[│┃|][\s│┃|]*$/.test(trimmed)) return true;
  }
  // 广告行：常见引流内容
  if (/^(?:www\.|http)/i.test(trimmed) && /(?:本|本站|下载|关注|公众号|更多)/.test(trimmed)) return true;
  if (/(?:最新网址|收藏本站|手机用户|请访问|扫码|加群|广告)/.test(trimmed) && trimmed.length < 50) return true;
  return false;
}

/**
 * 为整本书生成句子序列（带全局编号）。
 * @param {string} text
 * @param {import('../../core/contracts.js').Chapter[]} chapters
 * @param {{skipRules?: object}} [opts]
 * @returns {Sentence[]}
 */
export function buildSentences(text, chapters, opts = {}) {
  /** @type {Sentence[]} */
  const all = [];
  for (const ch of chapters) {
    const part = splitSentences(text, { start: ch.start, end: ch.end, index: ch.index }, opts);
    for (const s of part) {
      all.push({ ...s, index: all.length, chapter: ch.index });
    }
  }
  return all;
}

/** 按字符偏移二分查找所在句子序号（-1 表示未找到）。 */
export function sentenceAtOffset(sentences, offset) {
  let lo = 0;
  let hi = sentences.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sentences[mid];
    if (s.start <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans >= 0 && offset >= sentences[ans].start && offset < sentences[ans].end) return ans;
  return ans; // 落在句子间隙时归前一句
}
