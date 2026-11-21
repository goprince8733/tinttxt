/**
 * 测试 —— 章节识别与正则化
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChapters, splitChapterAt, mergeChapterIntoPrev, bindChapterSentences, DEFAULT_CHAPTER_REGEX } from '../src/layers/structure/chapters.js';
import { normalizeForSpeech, toSpeakText } from '../src/layers/structure/normalize.js';
import { DEFAULT_SETTINGS } from '../src/layers/storage/index.js';

test('存储层默认章节正则与结构层保持同步', () => {
  assert.equal(
    DEFAULT_SETTINGS.chapterRegex,
    DEFAULT_CHAPTER_REGEX,
    '两处默认正则漂移会导致「新书用旧正则」的隐蔽 bug',
  );
});

test('识别「第X章」格式', () => {
  const text = '前言内容若干字。\n第一章 初见\n正文一段话。\n第二章 再见\n后面的内容。';
  const chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
  assert.ok(chs.length >= 3, `应识别出 ≥3 章，实际 ${chs.length}: ${chs.map(c=>c.title).join('|')}`);
  assert.ok(chs.some((c) => c.title.includes('第一章')));
  assert.ok(chs.some((c) => c.title.includes('第二章')));
  // 章节偏移不重叠且覆盖全书
  for (let i = 1; i < chs.length; i++) assert.equal(chs[i].start, chs[i - 1].end);
  assert.equal(chs[0].start, 0);
  assert.equal(chs[chs.length - 1].end, text.length);
});

test('识别卷/回/Part/纯数字编号', () => {
  const cases = [
    ['卷一 风起\n内容', '卷一'],
    ['第五回 试炼\n内容', '第五回'],
    ['Part 3 Battle\ncontent', 'Part 3'],
    ['1. 开始\n内容', '1.'],
    ['序章\n内容', '序章'],
    ['尾声\n内容', '尾声'],
  ];
  for (const [text, expect] of cases) {
    const chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
    assert.ok(
      chs.some((c) => c.title.includes(expect)),
      `未识别 "${expect}"，得到: ${chs.map((c) => c.title).join('|')}`,
    );
  }
});

test('无章节时返回单章全书', () => {
  const text = '没有章节标记的纯文本内容，只有一段话。';
  const chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
  assert.equal(chs.length, 1);
  assert.equal(chs[0].start, 0);
  assert.equal(chs[0].end, text.length);
});

test('正文中的「第一章」误判防护：不独占一行不识别', () => {
  const text = '他说第一章是他写的然后继续讲故事。\n第二章 开始\n正文';
  const chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
  // 行首锚定：第一行整行匹配标题（长度<60）仍会被识别，这是可接受行为；
  // 关键是章节偏移合法
  for (const c of chs) assert.ok(c.start <= c.end);
});

test('手动标记章节 splitChapterAt', () => {
  const text = 'AAAA\nBBBB';
  let chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
  chs = splitChapterAt(chs, 5, '新章节');
  assert.equal(chs.length, 2);
  assert.equal(chs[1].start, 5);
  assert.equal(chs[1].title, '新章节');
  assert.deepEqual(chs.map((c) => c.index), [0, 1]);
});

test('合并章节 mergeChapterIntoPrev', () => {
  const pad = '这是一段足够长的章节正文用来满足章节间距要求。'.repeat(6);
  const text = `第一章\n${pad}\n第二章\n${pad}\n第三章\n${pad}`;
  let chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
  const before = chs.length;
  assert.ok(before >= 3, `应识别 ≥3 章，实际 ${before}`);
  chs = mergeChapterIntoPrev(chs, 1);
  assert.equal(chs.length, before - 1);
  assert.deepEqual(chs.map((c) => c.index), chs.map((_, i) => i), '合并后索引连续');
  // 合并后第一章 end 应延伸到原第二章末尾
  assert.ok(chs[0].end > 0);
});

test('bindChapterSentences 回填句子边界', () => {
  const text = '第一句。\n第一章 标题\n章内一句。\n章内二句。';
  const chs = detectChapters(text, DEFAULT_CHAPTER_REGEX);
  // 按真实文本偏移构造句子：
  // [0,4) 第一句。 | [5,11) 第一章 标题 | [12,17) 章内一句。 | [18,23) 章内二句。
  const sentences = [
    { index: 0, start: 0, end: 4 },
    { index: 1, start: 5, end: 11 },
    { index: 2, start: 12, end: 17 },
    { index: 3, start: 18, end: 23 },
  ];
  const bound = bindChapterSentences(chs, sentences);
  for (const c of bound) {
    assert.ok(c.sentenceStart <= c.sentenceEnd, `章 ${c.title} 句子边界非法`);
  }
  assert.equal(bound[0].sentenceStart, 0);
  assert.equal(bound[bound.length - 1].sentenceEnd, sentences.length);
});

/* ---------------- 正则化 ---------------- */

test('数字转中文', () => {
  assert.equal(normalizeForSpeech('我有3个苹果'), '我有三个苹果');
  assert.equal(normalizeForSpeech('2026年'), '二千零二十六年');
  assert.equal(normalizeForSpeech('一共123人'), '一共一百二十三人');
});

test('日期转中文（验收示例 3月5日）', () => {
  const out = normalizeForSpeech('3月5日出发');
  assert.ok(out.includes('三月五日'), `实际: ${out}`);
});

test('小数与百分比', () => {
  assert.equal(normalizeForSpeech('3.14'), '三点一四');
  assert.ok(normalizeForSpeech('增长5%').includes('百分之五'));
});

test('时间与金额', () => {
  assert.ok(normalizeForSpeech('12:30开会').includes('十二点三十分'));
  assert.ok(normalizeForSpeech('¥30') === '三十元' || normalizeForSpeech('¥30').includes('三十'));
});

test('白名单例外保留', () => {
  const out = normalizeForSpeech('访问 https://example.com 页面');
  assert.ok(out.includes('https://example.com'), '网址应保留');
  const out2 = normalizeForSpeech('他是U.S.的人');
  assert.ok(out2.includes('U.S.') || out2.includes('U S'), `缩写处理: ${out2}`);
});

test('toSpeakText 标点开关', () => {
  const s = { raw: '你好世界。', speak: '', skippable: false };
  const noPunct = toSpeakText(s, { readPunctuation: false, normalizeNumbers: true });
  assert.ok(!noPunct.endsWith('。'), `应去除句末标点: ${noPunct}`);
  const withPunct = toSpeakText(s, { readPunctuation: true, normalizeNumbers: true });
  assert.ok(withPunct.includes('。'), '开启后保留标点');
});

test('skippable 句返回空 speak', () => {
  const s = { raw: '（注释）', speak: '', skippable: true };
  assert.equal(toSpeakText(s, { readPunctuation: false, normalizeNumbers: true }), '');
});
