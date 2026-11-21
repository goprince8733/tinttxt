/**
 * 播放层 —— 云端 TTS 适配器（可选，默认关闭）
 * 硬约束：必须显式开关；文本上云前由 UI 层弹隐私提示确认。
 * 本适配器只负责把已确认的文本发往用户配置的 HTTP 端点。
 * @module playback/tts/cloud
 */

import { throwIfAborted, abortError } from './index.js';

/**
 * @param {{endpoint: string, apiKey?: string}} config
 * @returns {import('../../core/contracts.js').TtsAdapter}
 */
export function createCloudTtsAdapter(config) {
  return {
    id: 'cloud-http',
    label: '云端合成（需手动开启）',
    requiresNetwork: true,

    async prepare() {
      if (!config.endpoint) throw new Error('未配置云端 TTS 端点');
    },

    async synthesize(text, opts = {}) {
      throwIfAborted(opts.signal);
      if (!config.endpoint) throw new Error('云端 TTS 未启用');
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          text,
          voice: opts.voice || 'default',
          rate: opts.rate || 1,
          format: 'wav',
        }),
        signal: opts.signal,
      });
      if (!res.ok) throw new Error(`云端 TTS HTTP ${res.status}`);
      const blob = await res.blob();
      throwIfAborted(opts.signal);
      const mime = blob.type || 'audio/wav';
      return { blob, mime, durationSeconds: 0, chars: text.length };
    },

    async listVoices() {
      return [{ id: 'cloud-default', label: '云端默认音色', kind: 'cloud', dialogueCapable: false }];
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
