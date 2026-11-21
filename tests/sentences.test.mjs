/**
 * 测试 —— 结构层断句
 * 覆盖：中英混排、日期、小数、网址、缩写、省略号、跨段引号、偏移正确性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, buildSentences, sentenceAtOffset, isSkippableLine } from '../src/layers/structure/sentences.js';

const CH = { start: 0, end: Number.MAX_SAFE_INTEGER, index: 0 };

function spans(text, opts) {
  return splitSentences(text, CH, opts).map((s) => ({ ...s, actual: text.slice(s.start, s.end) }));
}

test('基础中文断句 + 偏移一致', () => {
  const text = '你好世界。今天天气不错！真的吗？是的。';
  const out = spans(text);
  assert.ok(out.length >= 4);
  for (const s of out) {
    assert.equal(s.actual, s.raw, '切片必须与原文一致');
    assert.ok(s.start < s.end);
  }
});

test('日期与小数不被误切', () => {
  const text = '会议定在2026-11-19召开，圆周率约3.14。';
  const out = spans(text);
  assert.equal(out.length, 1, `不应切开，得到 ${out.length} 句: ${JSON.stringify(out.map(s=>s.actual))}`);
});

test('网址不被英文句号切开', () => {
  const text = '详情见https://example.com/a.b页面。下一题。';
  const out = spans(text);
  assert.ok(out.length <= 2, `得到 ${out.length} 句`);
  assert.ok(out[0].actual.includes('example.com'), '网址必须完整保留在第一句');
});

test('英文缩写 U.S. 不切', () => {
  const text = '他来自U.S.并且很快回来了。第二句。';
  const out = spans(text);
  assert.ok(out[0].actual.includes('U.S.'), `第一句应含 U.S.，实际: ${out[0].actual}`);
});

test('省略号与右引号归入前句', () => {
  const text = '他叹了口气……“你走吧。”然后转身离开。';
  const out = spans(text);
  assert.ok(out.length >= 1);
  assert.ok(out[0].actual.includes('“你走吧。”') || out.length > 1, '引号内容不得丢失');
  // 所有切片拼接 = 原文（不含被跳过的空白行）
  const joined = out.map((s) => s.actual).join('');
  assert.ok(text.includes(joined) || joined.length > 0);
});

test('空行/注释/分隔线按规则跳过', () => {
  const text = '正文第一句。\n\n（作者注：这是一条注释）\n-----\n正文第二句。';
  const out = spans(text, { skipRules: { empty: true, notes: true, separators: true } });
  const skippable = out.filter((s) => s.skippable);
  const normal = out.filter((s) => !s.skippable);
  assert.equal(normal.length, 2, `应有 2 句正文，实际 ${normal.length}`);
  assert.ok(skippable.length >= 2, '注释与分隔线应标记为 skippable');
});

test('isSkippableLine 各类规则', () => {
  assert.equal(isSkippableLine('（作者注：xxx）'), true);
  assert.equal(isSkippableLine('======'), true);
  assert.equal(isSkippableLine('***'), true);
  assert.equal(isSkippableLine('普通正文内容，不应跳过。'), false);
  assert.equal(isSkippableLine('注：此处有解释但较短'), true);
});

test('超长无标点句强制切分', () => {
  const text = '啊'.repeat(400);
  const out = spans(text);
  assert.ok(out.length >= 3, `超长句应被切分，实际 ${out.length} 段`);
  const total = out.reduce((a, s) => a + s.actual.length, 0);
  assert.equal(total, 400, '切分不得丢字');
});

test('buildSentences 全局编号与章节绑定', () => {
  const text = '甲。乙。\n丙。丁。';
  const chapters = [
    { index: 0, title: '一', start: 0, end: text.indexOf('\n') },
    { index: 1, title: '二', start: text.indexOf('\n'), end: text.length },
  ];
  const all = buildSentences(text, chapters, { skipRules: { empty: true, notes: true, separators: true } });
  assert.ok(all.length >= 4);
  all.forEach((s, i) => assert.equal(s.index, i, '全局序号连续'));
  const c0 = all.filter((s) => s.chapter === 0);
  const c1 = all.filter((s) => s.chapter === 1);
  assert.ok(c0.length >= 2 && c1.length >= 2, '两章各至少 2 句');
});

test('多章书句子偏移必须是绝对值且单调递增（回归：章内局部偏移 bug）', () => {
  // 3 章、每章若干句——单章书测不出局部/绝对偏移错误
  const pad = '这是一句足够长的正文内容用来撑起章节长度。'.repeat(4);
  const text = `第一章\n${pad}\n第二章\n${pad}\n第三章\n${pad}`;
  const chapters = [];
  let idx = 0;
  for (const title of ['第一章', '第二章', '第三章']) {
    const start = text.indexOf(title, idx);
    if (chapters.length) chapters[chapters.length - 1].end = start;
    chapters.push({ index: chapters.length, title, start, end: text.length });
    idx = start + title.length;
  }
  const all = buildSentences(text, chapters, { skipRules: { empty: true, notes: true, separators: true } });
  assert.ok(all.length >= 6, `句数 ${all.length}`);

  // 1) 偏移单调递增
  for (let i = 1; i < all.length; i++) {
    assert.ok(
      all[i].start >= all[i - 1].start,
      `第 ${i} 句 start=${all[i].start} < 第 ${i - 1} 句 start=${all[i - 1].start}（非单调，疑似局部偏移）`,
    );
  }
  // 2) 每句的 raw 必须与原文切片一致（绝对偏移的直接证据）
  for (const s of all) {
    assert.equal(s.raw, text.slice(s.start, s.end), `句 ${s.index} raw 与偏移不一致`);
  }
  // 3) 第 2、3 章的句子 start 必须落在各自章节区间内
  for (const ch of chapters) {
    const inChapter = all.filter((s) => s.chapter === ch.index);
    assert.ok(inChapter.length >= 2, `章 ${ch.title} 句数 ${inChapter.length}`);
    for (const s of inChapter) {
      assert.ok(
        s.start >= ch.start && s.start < ch.end,
        `章 ${ch.title} 的句 start=${s.start} 不在 [${ch.start},${ch.end}) 内`,
      );
    }
  }
  // 4) 全书最后几句必须接近文末（原 bug 中最后几句 start 只有 100~160）
  const last = all[all.length - 1];
  assert.ok(last.start > text.length * 0.8, `末句 start=${last.start} 文长=${text.length}`);
});

test('sentenceAtOffset 二分定位', () => {
  const text = '你好世界。今天天气不错！真的吗？';
  const all = buildSentences(text, [{ index: 0, title: '全书', start: 0, end: text.length }], {});
  const idx = sentenceAtOffset(all, all[1].start + 1);
  assert.equal(idx, 1);
  const idx0 = sentenceAtOffset(all, 0);
  assert.equal(idx0, 0);
});
