/**
 * Mock 供应商 —— 无厂商 key 也能打通全链路（开发/验收用）。
 *
 * 生成与文本时长匹配的**占位提示音**（非真实人声，绝不可用于正式对外）：
 * 目的是让「应用 → Worker → 额度 → WAV → 播放层」整条管线在没有 key 时就能验证，
 * 包括句间停顿、时间轴、缓存与配额头。
 *
 * @module worker/providers/mock
 */
import { pcm16MonoToWav } from './util.js';

export const name = 'mock';

export function configured() {
  return true;
}

export function voices() {
  return [{ id: 'mock-default', label: 'Mock 占位音色（仅联调，非真实人声）' }];
}

/**
 * @param {{text:string, rate?:number}} opts
 * @returns {Promise<{wav:ArrayBuffer, mime:string, provider:string, durationSeconds:number}>}
 */
export async function synthesize({ text, rate = 1 }) {
  const sr = 16000;
  const chars = [...String(text || '')].length;
  const duration = Math.min(60, Math.max(0.5, chars / 4.5 / Math.max(0.5, Math.min(2, rate))));
  const n = Math.round(duration * sr);
  const samples = new Int16Array(n);
  // 220Hz 基音 + 每字轻微音高摆动 + 简单包络 —— 听感上"有节奏的占位音"，能分辨句读
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const wobble = 1 + 0.08 * Math.sin(2 * Math.PI * 3 * t);
    const env = Math.min(1, t * 8) * Math.min(1, (duration - t) * 8);
    const v = Math.sin(2 * Math.PI * 220 * wobble * t) * 0.25 * env;
    samples[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  return { wav: pcm16MonoToWav(samples, sr), mime: 'audio/wav', provider: 'mock', durationSeconds: duration };
}
