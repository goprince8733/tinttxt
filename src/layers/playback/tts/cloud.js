/**
 * 播放层 —— 云端 TTS 适配器（百度语音合成）
 * API：POST /api/tts {text, voice, rate} → WAV 音频
 * 认证：X-Device-Id（免费档）或 Bearer token（通行证）
 * @module playback/tts/cloud
 */

import { throwIfAborted, abortError } from './index.js';

/** 获取设备 ID（localStorage 持久化）。 */
function getDeviceId() {
  try {
    let id = localStorage.getItem('tinttxt-device-id');
    if (!id) {
      id = 'dev-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      localStorage.setItem('tinttxt-device-id', id);
    }
    return id;
  } catch {
    return 'dev-anonymous';
  }
}

/**
 * @param {{endpoint: string, apiKey?: string}} config
 * @returns {import('../../core/contracts.js').TtsAdapter}
 */
export function createCloudTtsAdapter(config) {
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
      try {
        const res = await fetch(config.endpoint, {
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
          signal: opts.signal,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const e = new Error(err.error || `云端 TTS HTTP ${res.status}`);
          config.onFailure?.(e);
          throw e;
        }
        // 防呆：端点未部署/被 SPA 兜底时可能返回 HTML——绝不能当音频播放
        const ctype = res.headers.get('content-type') || '';
        if (!/^audio\//i.test(ctype) && !/^application\/octet-stream/i.test(ctype)) {
          const e = new Error(`云端返回非音频内容（${ctype || '未知类型'}）`);
          config.onFailure?.(e);
          throw e;
        }
        const blob = await res.blob();
        throwIfAborted(opts.signal);
        if (!blob || blob.size < 100) {
          const e = new Error('云端返回音频为空');
          config.onFailure?.(e);
          throw e;
        }
        config.onSuccess?.();
        return { blob, mime: blob.type || 'audio/wav', durationSeconds: 0, chars: text.length };
      } catch (e) {
        // 主动中止不算失败（用户切块/暂停）
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e;
        if (!(e && /云端/.test(e.message || ''))) config.onFailure?.(e);
        throw e;
      }
    },

    async listVoices() {
      try {
        const base = config.endpoint ? config.endpoint.replace(/\/api\/tts$/, '/api/voices') : '';
        if (!base) return [];
        const res = await fetch(base);
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
    label: '系统朗读预览（不支持熄屏，仅临时用）',
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
