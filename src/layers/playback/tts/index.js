/**
 * 播放层 —— TTS 适配器统一接口
 * synthesize(text, {voice, rate, signal}) → Promise<TtsResult>
 * 播放层只消费 Blob；换引擎不改上层。
 * @module playback/tts
 */

/** @typedef {import('../../core/contracts.js').TtsAdapter} TtsAdapter */
/** @typedef {import('../../core/contracts.js').TtsResult} TtsResult */
/** @typedef {import('../../core/contracts.js').VoiceInfo} VoiceInfo */

/** 中止错误归一化：所有适配器必须在 signal.aborted 时 reject 这个错误。 */
export function abortError(reason) {
  const e = new Error(reason || '已取消');
  e.name = 'AbortError';
  return e;
}

/** @param {AbortSignal} [signal] */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal.reason);
}

/**
 * 适配器注册表：播放层按 id 取用，UI 层用它列出可选项。
 */
export class TtsRegistry {
  constructor() {
    /** @type {Map<string, TtsAdapter>} */
    this.adapters = new Map();
    this.activeId = null;
  }

  /** @param {TtsAdapter} adapter */
  register(adapter) {
    this.adapters.set(adapter.id, adapter);
    if (!this.activeId) this.activeId = adapter.id;
    return this;
  }

  /** @param {string} id */
  setActive(id) {
    if (!this.adapters.has(id)) throw new Error(`未知 TTS 适配器: ${id}`);
    this.activeId = id;
  }

  /** @returns {TtsAdapter} */
  get active() {
    const a = this.adapters.get(this.activeId);
    if (!a) throw new Error('没有可用的 TTS 适配器');
    return a;
  }

  get(id) {
    return this.adapters.get(id);
  }

  list() {
    return [...this.adapters.values()];
  }
}

/**
 * 通用超时 + 中止包装。
 * @template T
 * @param {Promise<T>} p
 * @param {AbortSignal} [signal]
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export function withAbort(p, signal, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    let timer = 0;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`TTS 合成超时（${timeoutMs}ms）`));
      }, timeoutMs);
    }
    p.then(
      (v) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
