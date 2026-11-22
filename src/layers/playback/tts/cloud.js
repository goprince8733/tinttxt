/**
 * 播放层 —— 云端 TTS 适配器（百度语音合成）
 * API：POST /api/tts {text, voice, rate} → WAV 音频
 * 认证：X-Device-Id（免费档）或 Bearer token（通行证）
 *
 * 关键设计：
 * - 同一句的请求全局共享（inflightSynth）：用户暂停/连点只是"不再等"，底层请求继续跑完进缓存，
 *   避免同一句被反复发往云端（按字计费，实测同一句被合成 5 次）。
 * - 调用方中止（AbortSignal）只影响自己，不取消底层请求。
 * @module playback/tts/cloud
 */

import { throwIfAborted, abortError } from './index.js';
import { memoAudio, peekAudio } from './audio-cache.js';

/** 获取设备 ID（localStorage 持久化）。 */
function getDeviceId() {
  const rand = () => {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    } catch { /* 旧内核无 randomUUID */ }
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  };
  try {
    let id = localStorage.getItem('tinttxt-device-id');
    if (!id) {
      id = 'dev-' + rand();
      localStorage.setItem('tinttxt-device-id', id);
    }
    return id;
  } catch {
    // 隐私模式取不到 localStorage：也要每次随机，不能所有人共用一个固定 id（会互相挤额度）
    return 'dev-' + rand();
  }
}

/** 全局共享的「同一句正在合成」表：key = text|voice|rate。 */
const inflightSynth = new Map();

/** 等 shared，但调用方 signal 中止时只放弃等待（不取消底层请求）。 */
function raceAbort(shared, signal) {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * @param {{endpoint: string, apiKey?: string, onSuccess?:Function, onFailure?:Function}} config
 * @returns {import('../../core/contracts.js').TtsAdapter}
 */
export function createCloudTtsAdapter(config) {
  let failureReported = false;
  const fail = (e) => {
    e.cloudFailure = true;
    if (!failureReported) {
      failureReported = true;
      config.onFailure?.(e);
    }
    return e;
  };

  /** 真正发一次请求（不被调用方的 abort 影响，自带 20 秒超时）。 */
  async function doSynthesize(text, opts) {
    if (!config.endpoint) throw new Error('云端 TTS 未启用');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('云端请求超时（20 秒）')), 20000);
    try {
      let res;
      try {
        res = await fetch(config.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-device-id': getDeviceId(),
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            text,
            voice: opts.voice || '0',
            rate: opts.rate || 1,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const e = fail(new Error(err.error || `云端 TTS HTTP ${res.status}`));
        e.httpStatus = res.status;
        throw e;
      }
      // 防呆：端点未部署/被 SPA 兜底时可能返回 HTML——绝不能当音频播放
      const ctype = res.headers.get('content-type') || '';
      if (!/^audio\//i.test(ctype) && !/^application\/octet-stream/i.test(ctype)) {
        throw fail(new Error(`云端返回非音频内容（${ctype || '未知类型'}）`));
      }
      const blob = await res.blob();
      if (!blob || blob.size < 100) throw fail(new Error('云端返回音频为空'));
      failureReported = false; // 成功一次后重置，后续失败仍能上报
      // 关键：即使调用方已经 abort（暂停/跳到别处），也要把结果记进内存缓存。
      // 否则"请求成功但没人接"的音频会被丢弃，下次重建同一句又要重新计费合成。
      // 键必须与 player 的 cacheVoiceKey() 一致：`${引擎id}:${voice||'default'}`。
      memoAudio(text, `cloud-http:${opts.voice || 'default'}`, opts.rate || 1, blob);
      config.onSuccess?.();
      // 与服务端额度口径一致：按码位计数（emoji/生僻字不拆半）
      return { blob, mime: blob.type || 'audio/wav', durationSeconds: 0, chars: [...text].length };
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e;
      if (!e.cloudFailure) fail(e); // 网络异常/超时等未归类错误
      throw e;
    }
  }

  return {
    id: 'cloud-http',
    label: '云端合成（百度语音）',
    requiresNetwork: true,

    async prepare() {
      if (!config.endpoint) throw new Error('未配置云端 TTS 端点');
    },

    async synthesize(text, opts = {}) {
      throwIfAborted(opts.signal);
      if (!config.endpoint) throw new Error('云端 TTS 未启用');
      const cacheVoice = `cloud-http:${opts.voice || 'default'}`;
      const rate = opts.rate || 1;
      // 最后一道确认：内存里已有就直接复用（关掉"刚合成完但还没落库"的竞态窗口）
      const cachedBlob = peekAudio(text, cacheVoice, rate);
      if (cachedBlob) {
        return { blob: cachedBlob, mime: cachedBlob.type || 'audio/wav', durationSeconds: 0, chars: [...text].length };
      }
      const dedupeKey = `${text}|${opts.voice || '0'}|${rate}`;
      let shared = inflightSynth.get(dedupeKey);
      if (!shared) {
        shared = doSynthesize(text, opts);
        inflightSynth.set(dedupeKey, shared);
        // 完成后移出表（成功的结果由 player 的内存层 + IndexedDB 接手）
        shared.then(
          () => inflightSynth.delete(dedupeKey),
          () => inflightSynth.delete(dedupeKey),
        );
      }
      return await raceAbort(shared, opts.signal);
    },

    async listVoices() {
      try {
        if (!config.endpoint) return [];
        // 用 URL 解析而非字符串替换：自建端点不以 /api/tts 结尾时也能正确推导
        let base = '';
        try {
          base = new URL('voices', config.endpoint.replace(/\/[^/]*$/, '/')).toString();
        } catch {
          return [];
        }
        const res = await fetch(base, { cache: 'no-store' });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.voices || []).map((v) => ({
          id: v.id,
          label: v.label,
          kind: 'cloud',
          dialogueCapable: false,
        }));
      } catch {
        return [];
      }
    },

    async isReady() {
      return !!config.endpoint;
    },
  };
}

/**
 * 预览降级：Web Speech API。
 * ⚠️ 明确标注：speechSynthesis 只出声、不产生音频流，无法进入 <audio>，
 * 享受不到系统媒体后台豁免，熄屏/切后台会被中断 —— 不满足硬约束，
 * 仅用于「本地模型尚未下载完」时的临时预览。
 * @returns {import('../../core/contracts.js').TtsAdapter}
 */
export function createSpeechPreviewAdapter() {
  return {
    id: 'speech-preview',
    label: '手机自带语音（系统默认）',
    requiresNetwork: false,
    previewOnly: true,

    async prepare() {},
    async isReady() {
      return typeof window !== 'undefined' && 'speechSynthesis' in window;
    },
    async listVoices() {
      if (typeof window === 'undefined' || !window.speechSynthesis) return [];
      return window.speechSynthesis.getVoices().map((v) => ({
        id: v.voiceURI,
        label: `${v.name}（${v.lang}）`,
        kind: 'local',
        dialogueCapable: false,
      }));
    },
    synthesize(text, opts = {}) {
      // 该适配器无法产出 Blob；返回一个 0 时长占位并由播放层走 preview 播放路径
      if (opts.signal?.aborted) return Promise.reject(abortError());
      return Promise.resolve({
        blob: null,
        mime: 'text/plain',
        durationSeconds: Math.max(1, text.length / 4.5),
        chars: text.length,
        preview: true,
      });
    },
  };
}
