/**
 * 腾讯云 · 通用语音合成（非流式） —— 接入桩（v2 方案主力②，等 API Key 联调）。
 *
 * 定位（docs/cloud-tts-payment-plan.md v2 §7.2）：
 *   精品音色免费包 800 万字符（3 个月、一次性、仅通用接口、**不含长文本**）；
 *   单次合成官方建议 ≤300 字 → Worker 侧分段合成 + WAV 拼接（util.pcm16MonoToWav）。
 *
 * 接入清单（M1，key 拿到当天完成）：
 * 1. secrets：`npx wrangler secret put TENCENT_SECRET_ID` + `TENCENT_SECRET_KEY`；
 * 2. 签名：TC3-HMAC-SHA256（官方签名算法，注意 Worker 内用 WebCrypto 实现，
 *    服务端签名，key 永不下发）；或用官方临时凭证（推荐，泄露影响面小）。
 * 3. 协议：POST https://tts.tencentcloudapi.com TextToVoice
 *    body: { Text: ≤300字, SessionId: uuid, Volume: 0-10, Speed: -2~6,
 *            VoiceType: 音色id, Codec: "wav", SampleRate: 16000 }
 *    → 返回 base64 Audio（完整音频，非流式）
 *    atob → Uint8Array → 若为裸 PCM 则包 WAV 头；Codec=wav 时直接透传。
 * 4. 分段拼接：按句切 ≤300 字段，逐段调用，PCM 拼接后统一包头；
 *    注意各段 SampleRate 必须一致，段间可插 SENTENCE_GAP_MS 静音（与本地引擎行为一致）。
 * 5. voices()：101001（智云·女）等音色表，联调时从官方枚举页核对。
 * 6. 计费坑（重要）：扣费顺序 = 免费资源包 → 付费资源包 → 后付费，**用完不会自动停**。
 *    我方全局日预算熔断（quota.js dailyBudgetChars）必须低于免费包余量估算，
 *    绝不依赖腾讯侧提醒。
 *
 * 在此之前 configured() = false，index.js 回落 mock 并在 /api/health 标注。
 * @module worker/providers/tencent
 */

export const name = 'tencent';

export function configured(env = {}) {
  return !!(env.TENCENT_SECRET_ID && env.TENCENT_SECRET_KEY);
}

export function voices() {
  // 音色枚举（官方口径，联调时核对全表）
  return [
    { id: '101001', label: '智瑜（女·通用）' },
    { id: '101002', label: '智聆（女·通用）' },
    { id: '101003', label: '智美（女·通用）' },
  ];
}

export async function synthesize() {
  throw new Error('tencent provider 尚未接入：待 TENCENT_SECRET_ID/KEY 到手后按本文件接入清单实现（TC3 签名 + TextToVoice + 分段拼接）');
}
