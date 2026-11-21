/**
 * 测试 —— WAV 解析与合并（分块预合成的句级时间轴基础）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, mergeWavParts, buildSentenceTimeline, wavDuration, silenceWav } from '../src/layers/playback/wav.js';

/** 构造合法 PCM WAV。 */
function makeWav(seconds, sampleRate = 22050, channels = 1, bits = 16) {
  const frames = Math.round(seconds * sampleRate);
  const blockAlign = (channels * bits) / 8;
  const dataLen = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bits, true);
  w(36, 'data');
  v.setUint32(40, dataLen, true);
  // 填正弦波（非零，便于校验）
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * blockAlign, Math.round(Math.sin(i / 10) * 3000), true);
  }
  return buf;
}

test('parseWav 解析头信息', () => {
  const wav = makeWav(1.5);
  const info = parseWav(wav);
  assert.ok(info);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.numChannels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.ok(Math.abs(wavDuration(wav) - 1.5) < 0.01);
});

test('parseWav 对非 WAV 返回 null', () => {
  assert.equal(parseWav(new ArrayBuffer(100)), null);
  assert.equal(parseWav(new Uint8Array([1, 2, 3]).buffer), null);
});

test('mergeWavParts 合并两段并保持总时长', () => {
  const a = makeWav(1.0);
  const b = makeWav(2.0);
  const merged = mergeWavParts([a, b]);
  assert.ok(merged);
  const dur = wavDuration(merged.buffer);
  assert.ok(Math.abs(dur - 3.0) < 0.01, `总时长应≈3s，实际 ${dur}`);
  assert.equal(merged.partOffsets.length, 2);
  assert.equal(merged.partOffsets[0].seconds, 0);
  assert.ok(Math.abs(merged.partOffsets[1].seconds - 1.0) < 0.01, '第二段起始秒数应≈1s');
});

test('mergeWavParts 采样率不一致返回 null', () => {
  const a = makeWav(0.5, 22050);
  const b = makeWav(0.5, 16000);
  assert.equal(mergeWavParts([a, b]), null);
});

test('mergeWavParts 单段与多段', () => {
  const a = makeWav(1.0);
  const one = mergeWavParts([a]);
  assert.ok(one);
  assert.ok(Math.abs(wavDuration(one.buffer) - 1.0) < 0.01);
});

test('buildSentenceTimeline 生成句级时间轴', () => {
  const offsets = [
    { byte: 0, seconds: 0 },
    { byte: 100, seconds: 1.5 },
    { byte: 200, seconds: 3.0 },
  ];
  const tl = buildSentenceTimeline(offsets, [10, 11, 12]);
  assert.equal(tl.length, 3);
  assert.equal(tl[0].sentenceIndex, 10);
  assert.equal(tl[0].startSec, 0);
  assert.equal(tl[0].endSec, 1.5);
  assert.equal(tl[1].startSec, 1.5);
  assert.equal(tl[2].endSec, Infinity, '最后一句 end 为 Infinity（由总时长兜底）');
});

test('合并后 data 大小正确（无字节丢失）', () => {
  const a = makeWav(1.0);
  const b = makeWav(1.0);
  const merged = mergeWavParts([a, b]);
  const info = parseWav(merged.buffer);
  const expected = 44 + (a.byteLength - 44) + (b.byteLength - 44);
  assert.equal(merged.buffer.byteLength, expected);
  assert.equal(info.dataLength, expected - 44);
});

test('silenceWav 生成可解析的静音段（16-bit 单声道、全 0）', () => {
  const s = silenceWav(300, 22050);
  const info = parseWav(s);
  assert.ok(info);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.numChannels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.ok(Math.abs(wavDuration(s) - 0.3) < 0.01, `静音应≈0.3s，实际 ${wavDuration(s)}`);
  const u8 = new Uint8Array(s, 44);
  assert.ok(u8.every((b) => b === 0), '静音段 data 区应全 0');
});

test('句间停顿合并：总时长含停顿，句子偏移正确（player 交错序列）', () => {
  // 与 player.buildChunk 的交错序列一致：句1, 静音, 句2
  const a = makeWav(1.0, 22050);
  const gap = silenceWav(300, 22050);
  const b = makeWav(2.0, 22050);
  const merged = mergeWavParts([a, gap, b]);
  assert.ok(merged);
  const dur = wavDuration(merged.buffer);
  assert.ok(Math.abs(dur - 3.3) < 0.01, `总时长应≈3.3s（1s+0.3s停顿+2s），实际 ${dur}`);

  const isSentence = [true, false, true];
  const sentOffsets = merged.partOffsets.filter((_, i) => isSentence[i]);
  assert.equal(sentOffsets.length, 2, '过滤后只剩句子偏移');
  assert.equal(sentOffsets[0].seconds, 0);
  assert.ok(Math.abs(sentOffsets[1].seconds - 1.3) < 0.01, `第二句应在 1.3s 开始，实际 ${sentOffsets[1].seconds}`);

  const tl = buildSentenceTimeline(sentOffsets, [7, 8]);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].sentenceIndex, 7);
  assert.ok(Math.abs(tl[1].startSec - 1.3) < 0.01, '时间轴与含停顿的偏移一致');
});
