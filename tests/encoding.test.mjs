/**
 * 测试 —— 文件层编码探测
 * 覆盖验收项 1：导入 GBK 编码 txt 不乱码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextFile, normalizeNewlines } from '../src/layers/file/encoding.js';

/** 用 TextEncoder 无法产出 GBK；手工构造 GBK 字节（用已知 GBK 码表片段）。 */
function gbkEncode(str) {
  // 简化：仅覆盖常用汉字区，用 Node 内置 Buffer（Windows 上 Buffer 默认 utf8，
  // 这里用 iconv 不可用时的替代：直接硬编码若干 GBK 字节对）
  // GBK "听书测试" 等字节：
  const table = {
    '听': [0xcc, 0xfd],
    '书': [0xca, 0xe9],
    '测': [0xb2, 0xe2],
    '试': [0xca, 0xd4],
    '中': [0xd6, 0xd0],
    '文': [0xce, 0xc4],
    '第': [0xb5, 0xda],
    '一': [0xd2, 0xbb],
    '章': [0xd5, 0xc2],
    '好': [0xba, 0xc3],
    '的': [0xb5, 0xc4],
    '是': [0xca, 0xc7],
    '了': [0xc1, 0xcb],
    '，': [0xa3, 0xac],
    '。': [0xa1, 0xa3],
    '\n': [0x0a],
    ' ': [0x20],
  };
  const out = [];
  for (const ch of str) {
    const bytes = table[ch];
    if (bytes) out.push(...bytes);
    else if (ch.charCodeAt(0) < 128) out.push(ch.charCodeAt(0));
    else out.push(0x3f); // '?'
  }
  return new Uint8Array(out);
}

test('GBK 文件正确解码（验收项 1）', () => {
  const text = '第一章 好的\n这是中文测试，';
  const bytes = gbkEncode(text);
  const r = decodeTextFile(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.encoding, 'gb18030');
  assert.ok(r.text.includes('第一章'));
  assert.ok(r.text.includes('中文测试'));
  assert.ok(!r.text.includes('�'), '不得出现替换字符');
});

test('UTF-8 BOM 正确识别', () => {
  const body = new TextEncoder().encode('第一章');
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  const r = decodeTextFile(withBom);
  assert.equal(r.ok, true);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.bom, true);
  assert.equal(r.text, '第一章');
});

test('无 BOM UTF-8 正确识别', () => {
  const bytes = new TextEncoder().encode('hello 世界 123');
  const r = decodeTextFile(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.encoding, 'utf-8');
});

test('UTF-16LE BOM 正确识别', () => {
  const body = new Uint16Array([0x7b2c, 0x4e00, 0x7ae0]); // 第一章
  const bytes = new Uint8Array(2 + body.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  new Uint8Array(body.buffer).forEach((b, i) => {
    bytes[2 + i] = b;
  });
  const r = decodeTextFile(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.encoding, 'utf-16le');
  assert.ok(r.text.includes('第一章'));
});

test('强制编码模式', () => {
  const bytes = gbkEncode('中文内容');
  const wrong = decodeTextFile(bytes, { forceEncoding: 'utf-8' });
  // utf-8 强制解码 GBK 中文会得到乱码 → 拒绝
  assert.equal(wrong.ok, false);
  const right = decodeTextFile(bytes, { forceEncoding: 'gb18030' });
  assert.equal(right.ok, true);
});

test('换行统一与零宽字符去除', () => {
  const input = 'a\r\nb\rc';
  assert.equal(normalizeNewlines(input), 'a\nb\nc');
  // 中 + ZWSP + 文 + ZWJ + 字 → 去除零宽后为「中文字」
  const zw = '中​文‍字';
  assert.equal(zw.length, 5, '前置：输入应含 2 个零宽字符');
  assert.equal(normalizeNewlines(zw), '中文字');
});

test('纯 ASCII 视为 utf-8', () => {
  const r = decodeTextFile(new TextEncoder().encode('plain ascii text\nline2'));
  assert.equal(r.ok, true);
  assert.equal(r.encoding, 'utf-8');
});
