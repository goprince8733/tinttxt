/**
 * 火山引擎（豆包）供应商 —— 接入桩（v2 定位：**仅做音色试听**，不作整章主力）。
 *
 * 选型背景（docs/cloud-tts-payment-plan.md v2 §7.2）：
 *   主力 = 百度长文本（10万字异步整段，听书场景原生）> 腾讯通用（800万字符、分段拼接）；
 *   火山免费仅约 2 万字符且为 WS 流式 —— 只用于「200 字试听挑音色 AB」按钮。
 *
 * 试听接入清单（M1，key 拿到当天完成）：
 * 1. `wrangler secret put VOLC_TTS_TOKEN`（或官方 AK/SK，按其鉴权方式）；
 * 2. 按官方文档实现 synthesize()：
 *    - 火山语音合成大模型 API 为 WebSocket 双向流式协议（首包300-400ms），
 *      Worker 侧用 WebSocket 连接网关，下发文本与音频参数，收流拼接；
 *    - 输出要求 **PCM/WAV**（播放层按 WAV 头解析时间轴；若只支持 mp3 需在
 *      此处转码或换厂商，见方案文档 §7「M1 首个验收项」）；
 *    - 音色列表从配置读取（voices() 返回），UI 下拉框自动生效。
 * 3. 价格口径（以官方计费页为准）：资源包 ≈0.28 元/千字，按量约1元/千字上下。
 *
 * 在此之前 configured() = false，index.js 会回落到 mock 并在 /api/health 标注。
 * @module worker/providers/volcano
 */

export const name = 'volcano';

export function configured(env = {}) {
  return !!(env.VOLC_TTS_TOKEN || env.VOLC_APP_ID);
}

export function voices() {
  // key 到手联调时从厂商接口拉取并缓存（方案文档 §4）
  return [];
}

export async function synthesize() {
  throw new Error('volcano provider 尚未接入：待 VOLC_TTS_TOKEN 到手后按官方 API 实现（见本文件接入清单）');
}
