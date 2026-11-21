/**
 * 播放层 —— sherpa 引擎 Worker（消息循环壳）
 *
 * 协议（main ↔ worker）：
 *   main → worker: {id, op:'prepare'|'synthesize'|'setTier'|'setSpeaker'|'unload', args}
 *                  {op:'cancel', targetId}          // 中止在途操作（同步 wasm 段不可打断，
 *                                                   // 会取消其后的等待并丢弃结果）
 *   worker → main: {id, type:'progress', p}         // 下载/合成进度 0..1
 *                  {id, type:'ok'}                  // prepare/setTier/... 完成
 *                  {id, type:'result', buffer, durationSeconds, sampleRate}
 *                  {id, type:'error', code, message}
 *                  {type:'log', level, text}        // 胶水 print/printErr 转发
 *
 * 意义：合成（同步 wasm，单句可长达数十秒）全部发生在这个线程里，
 * 主线程永远可以响应点击与滚动 —— 这就是「死机感」的根治。
 *
 * @module playback/tts/sherpa-worker
 */
import { createEngine } from './sherpa-engine.js';

const engine = createEngine({
  onLog: (level, text) => self.postMessage({ type: 'log', level, text }),
});

/** 每个在途操作一个 AbortController；cancel 消息按 targetId 中止。 */
const ops = new Map();

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.op === 'cancel') {
    const c = ops.get(msg.targetId);
    if (c) {
      try {
        c.abort(new DOMException('aborted', 'AbortError'));
      } catch {
        c.abort();
      }
    }
    return;
  }
  run(msg.id, msg.op, msg.args || {}).catch((err) => {
    self.postMessage({
      id: msg.id,
      type: 'error',
      code: (err && err.code) || 'SHERPA_WORKER_ERROR',
      message: (err && err.message) || String(err),
    });
  });
};

async function run(id, op, args) {
  const controller = new AbortController();
  ops.set(id, controller);
  try {
    switch (op) {
      case 'prepare': {
        await engine.prepare({
          tier: args.tier,
          sid: args.sid,
          signal: controller.signal,
          onProgress: (p) => self.postMessage({ id, type: 'progress', p }),
        });
        self.postMessage({ id, type: 'ok' });
        break;
      }
      case 'synthesize': {
        const r = await engine.synthesize(args.text, {
          voice: args.voice,
          rate: args.rate,
          signal: controller.signal,
          onProgress: (p) => self.postMessage({ id, type: 'progress', p }),
        });
        if (controller.signal.aborted) break; // 已取消：丢弃结果
        self.postMessage(
          { id, type: 'result', buffer: r.buffer, durationSeconds: r.durationSeconds, sampleRate: r.sampleRate },
          [r.buffer], // 零拷贝移交
        );
        break;
      }
      case 'setTier':
        engine.setTier(args.tier);
        self.postMessage({ id, type: 'ok' });
        break;
      case 'setSpeaker':
        engine.setSpeakerId(args.sid);
        self.postMessage({ id, type: 'ok' });
        break;
      case 'unload':
        engine.unload();
        self.postMessage({ id, type: 'ok' });
        break;
      default:
        throw new Error(`未知操作: ${op}`);
    }
  } finally {
    ops.delete(id);
  }
}
