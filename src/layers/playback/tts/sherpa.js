/**
 * 播放层 —— sherpa-onnx 中文 TTS 适配器（页面侧代理）
 *
 * 架构（Worker 化）：
 *   本文件只做「协议代理 + 页面态」：把 prepare/synthesize 转发给 sherpa-worker.js
 *   （模块 Worker），重活 —— 下载、Emscripten 装载、同步 wasm 合成 —— 全部在
 *   Worker 线程执行。**主线程永不阻塞**：点击、滚动、切页永远即时响应，
 *   单句合成再慢也只影响「下一句什么时候出声」，不再冻结界面（根治死机感）。
 *
 * 页面侧保留的职责：
 * - isReady()：直接查 Cache Storage（与 Worker 同源共享缓存，零消息往返）；
 * - listVoices()/档位与说话人镜像状态：不触发下载（沿用原契约）；
 * - 错误重建：Worker 传回 {code, message}，这里用结构化 err() 还原，
 *   UI 层按 code 分支的逻辑完全不变。
 *
 * @module playback/tts/sherpa
 */
import { abortError } from './index.js';
import {
  SHERPA_TIERS,
  CACHE_NAME,
  RUNTIME_BASE,
  RUNTIME_JS,
  WASM_FILE,
  fsManifest,
} from './sherpa-engine.js';

export { SHERPA_TIERS };

/** 结构化错误（与引擎同款；跨 postMessage 后在此重建）。 */
function err(code, message, cause) {
  const e = new Error(`[${code}] ${message}`);
  e.name = 'SherpaTTSError';
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/**
 * sherpa-onnx 中文离线适配器（Worker 代理）。
 * @returns {import('../../core/contracts.js').TtsAdapter}
 */
export function createLocalSherpaAdapter() {
  /** @type {Worker|null} */
  let worker = null;
  let nextId = 1;
  /** @type {Map<number, {resolve:Function, reject:Function, onProgress?:(p:number)=>void}>} */
  const pending = new Map();
  let currentTier = 'int8';
  let instanceSid = 0;
  /** 引擎预热状态：isReady() 只看文件在不在缓存；warmupDone = wasm 编译+模型加载+实例创建全部完成 */
  let warmupDone = false;
  let warmupPromise = null;

  /** 懒创建 Worker（首次 prepare/synthesize 时才建，不拖慢首屏）。 */
  function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(new URL('./sherpa-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'log') {
        if (msg.level === 'warn') console.warn('[sherpa-onnx]', msg.text);
        else console.log('[sherpa-onnx]', msg.text);
        return;
      }
      const p = msg.id != null ? pending.get(msg.id) : null;
      if (!p) return; // 已取消/已超时：丢弃
      if (msg.type === 'progress') {
        p.onProgress?.(msg.p);
      } else if (msg.type === 'ok') {
        pending.delete(msg.id);
        p.resolve(undefined);
      } else if (msg.type === 'result') {
        pending.delete(msg.id);
        p.resolve(msg);
      } else if (msg.type === 'error') {
        pending.delete(msg.id);
        p.reject(err(msg.code || 'SHERPA_WORKER_ERROR', msg.message || 'worker 错误'));
      }
    };
    w.onerror = (e) => {
      // Worker 级失败：逐个拒绝在途请求并弃用该实例（下次调用重建）
      const message = (e && e.message) || 'sherpa worker 启动失败';
      for (const [, p] of pending) p.reject(err('SHERPA_WORKER_ERROR', message));
      pending.clear();
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  }

  /**
   * 发起一次 Worker 调用。
   * @param {string} op
   * @param {object} args
   * @param {{signal?:AbortSignal, onProgress?:(p:number)=>void}} [opts]
   * @returns {Promise<any>}
   */
  function call(op, args, opts = {}) {
    const id = nextId++;
    let w;
    try {
      w = ensureWorker();
    } catch (e) {
      return Promise.reject(err('SHERPA_WORKER_ERROR', `无法创建合成线程：${(e && e.message) || e}。请刷新页面重试，或切换到其他引擎。`, e));
    }
    // 超时保护：Worker 不响应时永不挂起（曾导致播放按钮永久转圈）
    const timeoutMs = op === 'synthesize' ? 60000 : 120000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(err('SHERPA_TIMEOUT', `合成超时（${timeoutMs / 1000}秒）——请检查网络后重试，或切换到系统语音引擎`));
        }
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        onProgress: opts.onProgress,
      });
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          pending.delete(id);
          reject(abortError(opts.signal.reason));
          return;
        }
        opts.signal.addEventListener(
          'abort',
          () => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(abortError(opts.signal.reason));
            }
            try {
              w.postMessage({ op: 'cancel', targetId: id });
            } catch {
              /* worker 可能已亡 */
            }
          },
          { once: true },
        );
      }
      try {
        w.postMessage({ id, op, args });
      } catch (e) {
        pending.delete(id);
        reject(err('SHERPA_WORKER_ERROR', `消息发送失败：${(e && e.message) || e}`, e));
      }
    });
  }

  return {
    id: 'local-sherpa',
    label: '本地离线（sherpa-onnx 中文）',
    requiresNetwork: false,

    /**
     * 下载/初始化（在 Worker 内执行；进度经 onProgress 转发）。
     * @param {{signal?:AbortSignal, tier?:string, onProgress?:(p:number)=>void}} [opts]
     */
    async prepare(opts = {}) {
      const tier = opts.tier || currentTier;
      if (!SHERPA_TIERS[tier]) {
        throw err('SHERPA_UNKNOWN_TIER', `未知模型档位: ${tier}`);
      }
      currentTier = tier;
      await call('prepare', { tier, sid: instanceSid }, opts);
      warmupDone = true; // prepare 完成 = 引擎已预热（wasm+模型+实例全就绪）
    },

    /**
     * 后台预热引擎（不合成，只初始化）：wasm 编译 + 模型加载 + 实例创建。
     * 在 resolveAdapter 中调用——文件已下载但引擎未预热时，先用 speech-preview 出声，
     * 同时预热，完成后自动切换到高质量引擎。
     */
    async warmup() {
      if (warmupDone) return;
      if (warmupPromise) return warmupPromise;
      warmupPromise = this.prepare()
        .then(() => {
          warmupDone = true;
        })
        .catch((e) => {
          warmupPromise = null; // 失败可重试
          throw e;
        });
      return warmupPromise;
    },

    /** 引擎是否已预热（wasm+模型+实例全就绪，可以快速合成）。 */
    isWarmedUp() {
      return warmupDone;
    },

    /**
     * 合成一段文本 → 16-bit PCM WAV Blob（合成在 Worker 内执行）。
     * @param {string} text
     * @param {{voice?:string, rate?:number, signal?:AbortSignal, onProgress?:(p:number)=>void}} opts
     * @returns {Promise<import('../../core/contracts.js').TtsResult>}
     */
    async synthesize(text, opts = {}) {
      const t = String(text == null ? '' : text);
      if (!t.trim()) {
        return { blob: new Blob([], { type: 'audio/wav' }), mime: 'audio/wav', durationSeconds: 0, chars: 0 };
      }
      const r = await call('synthesize', { text: t, rate: opts.rate || 1, voice: opts.voice || null }, opts);
      const buffer = r.buffer && r.buffer.byteLength ? r.buffer : new ArrayBuffer(0);
      return {
        blob: new Blob([buffer], { type: 'audio/wav' }),
        mime: 'audio/wav',
        durationSeconds: r.durationSeconds || 0,
        chars: t.length,
      };
    },

    /**
     * 列出可用音色（**绝不在此触发下载**：设置/播放页渲染下拉框时会调用）。
     * aishell3 多说话人：默认 sid 0 + 备选音色，voice id `-s<N>` 后缀映射 sid。
     * @returns {Promise<import('../../core/contracts.js').VoiceInfo[]>}
     */
    async listVoices() {
      let ready = false;
      try {
        ready = await this.isReady();
      } catch {
        ready = false;
      }
      const suffix = ready ? '' : '（模型未下载）';
      const out = [
        {
          id: `aishell3-${currentTier}`,
          label: `🎙️ 慧妍 · 女声·标准${suffix}`,
          kind: 'local',
          dialogueCapable: false,
        },
      ];
      // 备选说话人（同模型内不同音色；id 形如 aishell3-int8-s3）
      const speakerLabels = ['沉稳·男声', '清亮·女声', '浑厚·男声', '温柔·女声'];
      for (let si = 0; si < speakerLabels.length; si++) {
        out.push({
          id: `aishell3-${currentTier}-s${si + 1}`,
          label: `🎙️ ${speakerLabels[si]}${suffix}`,
          kind: 'local',
          dialogueCapable: false,
        });
      }
      return out;
    },

    /**
     * 模型与运行时是否都已就位（直接查 Cache Storage —— 与 Worker 同源共享，无需往返）。
     * 缓存 key 与引擎写入的 canonical 同源 URL 一致。
     */
    async isReady() {
      try {
        const cache = await caches.open(CACHE_NAME);
        for (const f of fsManifest(currentTier)) {
          if (!(await cache.match(f.url))) return false;
        }
        for (const f of [...RUNTIME_JS, WASM_FILE]) {
          if (!(await cache.match(RUNTIME_BASE + f))) return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    /** 切换模型档位（Worker 释放旧实例；下次 prepare 按新档位重建）。 */
    setTier(tier) {
      if (!SHERPA_TIERS[tier] || tier === currentTier) return;
      currentTier = tier;
      if (worker) void call('setTier', { tier }).catch(() => {});
    },

    getTier() {
      return currentTier;
    },

    /** 切换说话人（aishell3 多说话人模型）。 */
    setSpeakerId(sid) {
      const n = Number(sid) || 0;
      if (n === instanceSid) return;
      instanceSid = n;
      if (worker) void call('setSpeaker', { sid: n }).catch(() => {});
    },

    getSpeakerId() {
      return instanceSid;
    },

    /** 释放推理实例（切书/长时间不用时调用）。 */
    unload() {
      if (worker) void call('unload', {}).catch(() => {});
    },
  };
}
