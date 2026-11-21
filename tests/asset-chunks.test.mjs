/**
 * asset-chunks.js —— 卡死看门狗 + 早期吞吐探针 单元测试。
 * 只测不依赖浏览器/fetch 的部分：续期、判死、外部中止透传、吞吐判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatchdog, createThroughputProbe } from '../src/layers/playback/tts/asset-chunks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('无进度到点判死：stalled=true 且 signal 被 abort', async () => {
  const wd = createStallWatchdog(undefined, 60);
  assert.equal(wd.signal.aborted, false);
  await sleep(120);
  assert.equal(wd.stalled, true);
  assert.equal(wd.signal.aborted, true);
  assert.equal(wd.signal.reason?.name, 'AbortError');
  wd.dispose();
});

test('持续 arm 续期：只要一直有字节就不会判死', async () => {
  const wd = createStallWatchdog(undefined, 60);
  const t = setInterval(() => wd.arm(), 20);
  await sleep(150);
  assert.equal(wd.stalled, false);
  assert.equal(wd.signal.aborted, false);
  clearInterval(t);
  wd.dispose();
});

test('外部中止透传：stalled 保持 false（调用方据此区分「用户取消」）', async () => {
  const ext = new AbortController();
  const wd = createStallWatchdog(ext.signal, 1000);
  ext.abort();
  await sleep(20);
  assert.equal(wd.signal.aborted, true);
  assert.equal(wd.stalled, false);
  wd.dispose();
});

test('dispose 后不再判死（防止换源后旧定时器误伤）', async () => {
  const wd = createStallWatchdog(undefined, 50);
  wd.dispose();
  await sleep(120);
  assert.equal(wd.stalled, false);
  assert.equal(wd.signal.aborted, false);
});

test('看门狗 cancel：主动中止不置 stalled（探针判慢 ≠ 卡死）', () => {
  const wd = createStallWatchdog(undefined, 1000);
  const why = new Error('probe');
  why.name = 'ProbeSlowError';
  wd.cancel(why);
  assert.equal(wd.signal.aborted, true);
  assert.equal(wd.signal.reason, why);
  assert.equal(wd.stalled, false);
  wd.dispose();
});

// ---------------------------------------------------------------------------
// 早期吞吐探针（三段式下载第一跳的保险丝）
// ---------------------------------------------------------------------------
test('探针判慢：窗口期满平均吞吐不达标 → 抛 ProbeSlowError 并触发 onCancel', async () => {
  let cancelled = null;
  const probe = createThroughputProbe({ ms: 60, minBps: 100 * 1024, onCancel: (e) => (cancelled = e) });
  probe.tick(100); // 窗口内：不判定
  await sleep(90); // 过窗口
  assert.throws(() => probe.tick(1), (e) => e.name === 'ProbeSlowError' && /换源/.test(e.message));
  assert.ok(cancelled && cancelled.name === 'ProbeSlowError');
});

test('探针放行：窗口期满吞吐达标 → 不抛，且此后不再判定', async () => {
  const probe = createThroughputProbe({ ms: 60, minBps: 100 * 1024 });
  probe.tick(10 * 1024 * 1024); // 10MB
  await sleep(90);
  probe.tick(1); // 平均 >> 100KB/s → 放行
  probe.tick(1); // decided：不再判定，恒通过
});

test('探针窗口未满不判定（慢启动但没到点 = 无动作）', async () => {
  const probe = createThroughputProbe({ ms: 5000, minBps: 100 * 1024 });
  probe.tick(1);
  await sleep(30);
  probe.tick(1); // 仍在窗口内
});
