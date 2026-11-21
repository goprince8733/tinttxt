/**
 * 结构层 —— 章节识别
 * 支持可配置正则（默认覆盖：第X章/卷/回/节/篇、Part、Chapter、纯数字编号、序章/尾声等）。
 * 手动标记与微调通过 UI 层调用 splitChaptersAt 完成。
 * @module layers/structure/chapters
 */

/** @typedef {import('../../core/contracts.js').Chapter} Chapter */
/** @typedef {import('../../core/contracts.js').Sentence} Sentence */

/** 内置默认正则（与存储层 DEFAULT_SETTINGS.chapterRegex 保持一致）。 */
export const DEFAULT_CHAPTER_REGEX =
  '^(?:第[零一二三四五六七八九十百千万两\\d]+[章卷回节篇]|卷[零一二三四五六七八九十百千万两\\d]+|[\\d]+[\\.、]\\s*\\S{0,20}|Part\\s+\\d+|Chapter\\s+\\d+|附录.{0,10}|(?:序章|楔子|尾声|后记|前言|简介)(?:\\s|$|：|:))';

/**
 * 将全文按正则切成章节。找不到任何章节时返回单章节（全书）。
 * @param {string} text
 * @param {string} regexSource
 * @param {{minChapterChars?: number}} [opts] minChapterChars 相邻标题最小间距（默认 50，
 *   用于把目录簇与正文误判剔除；过小的间距视为目录/误判）
 * @returns {Chapter[]}
 */
export function detectChapters(text, regexSource, opts = {}) {
  const minGap = opts.minChapterChars ?? 50;
  let re;
  try {
    re = new RegExp(regexSource, 'm');
  } catch (e) {
    re = new RegExp(DEFAULT_CHAPTER_REGEX, 'm');
  }
  /** @type {Array<{start:number,end:number,title:string}>} */
  const hits = [];
  // 逐行扫描：章节标题必须独占一行（行首锚定），避免正文误判
  const lines = splitLines(text);
  for (const line of lines) {
    if (!line.content.trim()) continue;
    const trimmed = line.content.trim();
    if (trimmed.length > 60) continue; // 标题不会太长
    if (re.test(trimmed)) {
      hits.push({ start: line.start, end: line.end, title: trimmed });
    }
  }

  // 目录簇剔除：≥3 个命中彼此间距都 < minGap（典型目录），整簇丢弃
  const clusterDropped = new Set();
  for (let i = 0; i < hits.length; i++) {
    let len = 1;
    while (
      i + len < hits.length &&
      hits[i + len].start - hits[i + len - 1].end < minGap
    ) {
      len++;
    }
    if (len >= 3) {
      for (let k = i; k < i + len; k++) clusterDropped.add(k);
      i += len - 1;
    }
  }

  // 保留非目录簇的命中（不再做逐个间距过滤：真实短章节合法，目录风险由簇规则覆盖）
  const filtered = hits.filter((_, i) => !clusterDropped.has(i));

  if (!filtered.length) {
    return [
      {
        index: 0,
        title: '全书',
        start: 0,
        end: text.length,
        sentenceStart: 0,
        sentenceEnd: 0, // 由 buildSentenceIndex 回填
      },
    ];
  }

  /** @type {Chapter[]} */
  const chapters = [];
  let idx = 0;
  if (filtered[0].start > 0) {
    chapters.push({
      index: 0,
      title: '开头',
      start: 0,
      end: filtered[0].start,
      sentenceStart: 0,
      sentenceEnd: 0,
    });
    idx = 1;
  }
  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i];
    const nextStart = i + 1 < filtered.length ? filtered[i + 1].start : text.length;
    chapters.push({
      index: idx++,
      title: cur.title,
      start: cur.start,
      end: nextStart,
      sentenceStart: 0,
      sentenceEnd: 0,
    });
  }
  return chapters;
}

/**
 * 在指定字符偏移处手动切一章（用户「在此标记章节」）。
 * @param {Chapter[]} chapters
 * @param {number} offset
 * @param {string} title
 * @returns {Chapter[]}
 */
export function splitChapterAt(chapters, offset, title) {
  const target = chapters.findIndex((c) => offset > c.start && offset < c.end);
  if (target < 0) return chapters;
  const c = chapters[target];
  const left = { ...c, end: offset, title: offset - c.start < (c.end - c.start) / 2 ? c.title : title || c.title };
  const right = {
    ...c,
    index: c.index + 1,
    start: offset,
    title: title || `第 ${c.index + 2} 章`,
    sentenceStart: 0,
    sentenceEnd: 0,
  };
  const out = [...chapters];
  out.splice(target, 1, left, right);
  return out.map((ch, i) => ({ ...ch, index: i }));
}

/**
 * 合并某章到前一章（用户「合并章节」微调）。
 * @param {Chapter[]} chapters
 * @param {number} index
 */
export function mergeChapterIntoPrev(chapters, index) {
  if (index <= 0 || index >= chapters.length) return chapters;
  const out = chapters.slice();
  out[index - 1] = { ...out[index - 1], end: out[index].end, sentenceEnd: out[index].sentenceEnd };
  out.splice(index, 1);
  return out.map((ch, i) => ({ ...ch, index: i }));
}

/** 按换行切分并记录偏移（统一换行后为 \n）。 */
export function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      out.push({ start, end: i, content: text.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

/**
 * 回填每章的 sentenceStart/sentenceEnd。
 * @param {Chapter[]} chapters
 * @param {Sentence[]} sentences
 */
export function bindChapterSentences(chapters, sentences) {
  let s = 0;
  return chapters.map((c) => {
    while (s < sentences.length && sentences[s].start < c.start) s++;
    const startS = s;
    while (s < sentences.length && sentences[s].start < c.end) s++;
    return { ...c, sentenceStart: startS, sentenceEnd: s };
  });
}
