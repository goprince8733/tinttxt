/**
 * 结构层 —— 文本正则化（朗读前处理）
 * 数字 / 符号 / 英文转可读中文，避免 TTS 读怪。提供例外白名单。
 * 偏移安全：本模块只改写 speak 文本，不改 raw，不影响字符偏移定位。
 * @module layers/structure/normalize
 */

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_UNITS = ['', '十', '百', '千'];

/** 例外白名单：这些内容不做转换（正则命中原样保留）。 */
export const DEFAULT_EXCEPTIONS = [
  /\b(?:U\.S\.|U\.K\.|e\.g\.|i\.e\.|etc\.|vs\.|Dr\.|Mr\.|Mrs\.|Prof\.|No\.)\b/g,
  /\b(?:CPU|GPU|USB|APP|API|GPS|LED|LCD|WiFi|Wi-Fi|OK|FAQ|PDF|VIP|GDP|CT|MRI)\b/g,
  /https?:\/\/\S+/g,
  /www\.\S+/g,
  /[A-Za-z]{2,}\d+[A-Za-z\d]*/g, // 型号类 Abc123
];

/** 个位数字汉字。 */
function digit(n) {
  return CN_NUM[n];
}

/** 0–99 的中文读法（一十 → 十 for10-19 in casual reading）。 */
function read2(n, formal) {
  if (n < 10) return CN_NUM[n];
  if (n < 20) return (formal ? '一十' : '十') + (n % 10 ? CN_NUM[n % 10] : '');
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return CN_NUM[tens] + '十' + (ones ? CN_NUM[ones] : '');
}

/** 0–99999999 的中文读法。 */
function readInt(n) {
  if (n === 0) return '零';
  if (n < 0) return '负' + readInt(-n);
  if (n > 99999999) return String(n).split('').map(digit).join('');
  const yi = Math.floor(n / 100000000);
  const wan = Math.floor((n % 100000000) / 10000);
  const rest = n % 10000;
  let out = '';
  if (yi) out += readInt(yi) + '亿';
  if (wan) out += (wan < 1000 && yi ? '零' : '') + readSection(wan) + '万';
  if (rest) out += (wan && rest < 1000 ? '零' : '') + readSection(rest);
  return out;
}

function readSection(n) {
  // n < 10000
  const thousands = Math.floor(n / 1000);
  const hundreds = Math.floor((n % 1000) / 100);
  const tensOnes = n % 100;
  let out = '';
  if (thousands) out += CN_NUM[thousands] + '千';
  if (hundreds) out += (thousands && !hundreds ? '零' : '') + CN_NUM[hundreds] + '百';
  else if (thousands && tensOnes) out += '零';
  if (tensOnes) out += (hundreds && tensOnes < 10 ? '零' : '') + read2(tensOnes, false);
  return out;
}

/** 小数：3.14 → 三点一四 */
function readDecimal(s) {
  const [i, d] = s.split('.');
  return readInt(parseInt(i, 10)) + '点' + d.split('').map(digit).join('');
}

/** 百分比：3.5% → 百分之三点五 */
function readPercent(s) {
  const num = s.replace(/%$/, '');
  return '百分之' + (num.includes('.') ? readDecimal(num) : readInt(parseInt(num, 10)));
}

/** 日期：2026-11-19 / 2026年11月19日 / 11-19 */
function readDate(s) {
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) {
    return `${readInt(+m[1])}年${readInt(+m[2])}月${readInt(+m[3])}日`;
  }
  const m2 = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m2) return `${readInt(+m2[1])}月${readInt(+m2[2])}日`;
  const m3 = s.match(/^(\d{4})[-/.年](\d{1,2})月?$/);
  if (m3) return `${readInt(+m3[1])}年${readInt(+m3[2])}月`;
  return null;
}

/** 时间：12:30 / 8:05:09 */
function readTime(s) {
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const h = parseInt(parts[0], 10);
  const mm = parts[1].padStart(2, '0');
  const base = readInt(h) + '点' + (mm === '00' ? '整' : readInt(parseInt(mm, 10)) + '分');
  if (parts.length === 3) {
    const ss = parseInt(parts[2], 10);
    return base + (ss ? readInt(ss) + '秒' : '');
  }
  return base;
}

/** 金额：12.5元 / ¥30 / $5 */
function readMoney(s) {
  const m = s.match(/^([¥$€£])\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const unit = { '¥': '元', '$': '美元', '€': '欧元', '£': '英镑' }[m[1]];
    const num = m[2];
    return (num.includes('.') ? readDecimal(num) : readInt(parseInt(num, 10))) + unit;
  }
  const m2 = s.match(/^(\d+(?:\.\d+)?)\s*元$/);
  if (m2) return (m2[1].includes('.') ? readDecimal(m2[1]) : readInt(parseInt(m2[1], 10))) + '元';
  return null;
}

/** 单位数量：1500米 / 30kg / 60km/h */
const UNIT_MAP = {
  米: '米', 公里: '公里', 千米: '千米', 吨: '吨', 斤: '斤', 克: '克', 千克: '千克',
  kg: '千克', g: '克', km: '千米', m: '米', cm: '厘米', mm: '毫米',
  人: '人', 岁: '岁', 个: '个', 元: '元', 次: '次', 天: '天', 年: '年', 小时: '小时', 分钟: '分钟',
};

function readNumberUnit(s) {
  const m = s.match(/^(\d+(?:\.\d+)?)([一-龥A-Za-z/%]+)$/);
  if (!m) return null;
  const unit = UNIT_MAP[m[2]] || UNIT_MAP[m[2].toLowerCase()];
  if (!unit) return null;
  const num = m[1];
  return (num.includes('.') ? readDecimal(num) : readInt(parseInt(num, 10))) + unit;
}

/** 电话/编号类纯数字串：逐位读。 */
function readDigits(s) {
  return s.split('').map(digit).join('');
}

/**
 * 对单句 speak 文本做正则化。
 * @param {string} text
 * @param {{exceptions?: RegExp[], keepEnglish?: boolean}} [opts]
 * @returns {string}
 */
export function normalizeForSpeech(text, opts = {}) {
  let t = text;
  const exceptions = opts.exceptions || DEFAULT_EXCEPTIONS;
  /** @type {Array<{range:[number,number], text:string}>} */
  const marks = [];

  // 1. 先标记白名单区域，转换时跳过
  for (const re of exceptions) {
    re.lastIndex = 0;
    let m;
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = r.exec(t)) !== null) {
      marks.push({ range: [m.index, m.index + m[0].length], text: m[0] });
      if (m[0].length === 0) r.lastIndex++;
    }
  }
  const inException = (start, end) => marks.some((x) => start < x.range[1] && end > x.range[0]);

  // 2. 从右往左替换，保持索引稳定
  /** @type {Array<{start:number,end:number,text:string}>} */
  const reps = [];
  const push = (start, end, val) => {
    if (val == null || inException(start, end)) return;
    // 重叠拒绝：patterns 按优先级排序，先命中者赢，后续重叠区间丢弃，
    // 避免同一段字符被多条规则重复替换（如 "2026年" 被单位/整数两条同时命中）
    for (const r of reps) {
      if (start < r.end && end > r.start) return;
    }
    reps.push({ start, end, text: val });
  };

  const patterns = [
    // 日期（在数字前）
    [/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/.月]\d{1,2}日|\d{4}年\d{1,2}月/g, (m, off) => readDate(m) || null],
    // 时间
    [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (m) => readTime(m)],
    // 百分比
    [/\d+(?:\.\d+)?%/g, (m) => readPercent(m)],
    // 金额
    [/[¥$€£]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?元/g, (m) => readMoney(m)],
    // 小数
    [/\d+\.\d+/g, (m) => readDecimal(m)],
    // 带单位数量
    [/\d+(?:\.\d+)?(?:米|公里|千米|吨|斤|克|千克|kg|g|km|cm|mm|人|岁|个|次|天|年|小时|分钟|公里\/小时|km\/h)/g, (m) => readNumberUnit(m)],
    // 大整数（≥4 位，不含小数点）
    [/\d{4,}/g, (m) => (m.length > 9 ? readDigits(m) : readInt(parseInt(m, 10)))],
    // 普通整数
    [/\d+/g, (m) => readInt(parseInt(m, 10))],
    // 英文单词 → 逐字母拼读（TTS 无法发音英文时的兜底；保留白名单）
    [/\b[A-Za-z]+\b/g, (m) => (opts.keepEnglish ? m : spellEnglish(m))],
    // 符号
    [/[&]/g, () => '和'],
    [/[+]/g, () => '加'],
    [/@]/g, () => '艾特'],
    [/%]/g, () => '百分之'],
    [/[×✕xX]\s*(?=\d)/g, () => '乘'],
    [/=/g, () => '等于'],
    [/~/g, () => '到'],
    [/[、]/g, () => '，'],
  ];

  for (const [re, fn] of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const val = fn(m[0], m.index, m);
      if (val != null && val !== m[0]) push(m.index, m.index + m[0].length, val);
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  reps.sort((a, b) => b.start - a.start);
  for (const r of reps) t = t.slice(0, r.start) + r.text + t.slice(r.end);

  // 3. 收尾：压缩空白
  return t.replace(/\s+/g, ' ').trim();
}

/** 英文逐字母拼读：TTS 引擎不含英文音素时的兜底（"iPhone" → "I P h o n e"）。 */
function spellEnglish(word) {
  // 常见词直接保留（引擎多支持基础英文）
  const COMMON = new Set([
    'ok', 'app', 'api', 'gps', 'usb', 'wifi', 'online', 'offline', 'file', 'txt', 'pdf',
    'ip', 'tv', 'pc', 'ai', 'id', 'no', 'yes', 'hi', 'hello', 'thanks', 'note', 'book',
  ]);
  if (COMMON.has(word.toLowerCase())) return word;
  return word.split('').join(' ');
}

/**
 * 生成朗读文本：跳行规则 + 标点剔除 + 正则化。
 * @param {import('../../core/contracts.js').Sentence} sentence
 * @param {import('../../core/contracts.js').Settings} settings
 * @returns {string}
 */
export function toSpeakText(sentence, settings) {
  if (sentence.skippable) return '';
  let raw = sentence.raw.trim();
  if (!raw) return '';
  if (!settings.readPunctuation) {
    // 剔除句末与朗读无意义的标点，保留结构逗号（停顿自然）
    raw = raw.replace(/[。！？!?…]+$/g, '');
    raw = raw.replace(/[【】《》〈〉"'“”‘’（）()〔〕\[\]]/g, '');
    raw = raw.replace(/[…·]{2,}/g, '，');
    raw = raw.replace(/[=\-—_=~※#＊*]/g, '，');
    raw = raw.replace(/，{2,}/g, '，');
  }
  if (!settings.normalizeNumbers) return raw.trim();
  return normalizeForSpeech(raw);
}
