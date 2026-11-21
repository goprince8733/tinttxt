/**
 * 百度智能云 · 长文本在线合成 —— 接入桩（v2 方案主力①，等 API Key 联调）。
 *
 * 为什么是主力（docs/cloud-tts-payment-plan.md v2 §7.2）：
 *   官方口径「最高支持 10 万字一次性合成、异步返回音频、支持下载，
 *   适用于阅读听书」——与「整章预合成」结构性吻合，无需分段拼接。
 *
 * 接入清单（M1，key 拿到当天完成）：
 * 1. secrets：`npx wrangler secret put BAIDU_API_KEY`（+ BAIDU_SECRET_KEY，按鉴权方式）；
 * 2. 协议（官方文档 https://ai.baidu.com/tech/speech/long_tts）：
 *    a) POST https://aip.baidubce.com/rpc/2.0/tts/v1/create
 *       body: { text: [段落数组], format: "wav", voice: <音库id>, lang: "zh",
 *               speed: 5, enable_subtitle: 可选 }
 *       → 返回 { task_id }（注意 text 是**数组**，多段间自动插 1s 静音）
 *    b) 轮询 POST .../tts/v1/query { task_id }：
 *       status=Success → result.audio_url（完整音频下载地址，有过期时间，需及时拉回）
 *       status=Running → 继续轮询（5万字官方口径最快约5分钟）
 *    c) fetch(audio_url) 拉回音频 → 直接透传（要求 wav；若选 mp3 需改播放层或转码）
 * 3. Worker 超时注意：单次请求等待轮询可能超 Cloudflare Workers CPU/时长限制
 *    （免费版单请求上限）——方案A：客户端分章≤500字×本桩同步合成短链路；
 *    方案B：把「create→轮询→存KV」做成后台任务，客户端只查状态。M1 先做A（分章够用）。
 * 4. voices()：基础音库（度小宇=0/度小美=1/度逍遥=3/度丫丫=4）+ 精品音库表，
 *    key 到手后从官方文档核对枚举并写进配置。
 * 5. 免费额度：实名/企业认证后控制台领取（价格页口径「企业认证领10万字」，
 *    个人额度以控制台实际显示为准——**接入前必须核实**，避免误判成本）。
 *
 * 在此之前 configured() = false，index.js 回落 mock 并在 /api/health 标注。
 * @module worker/providers/baidu
 */

export const name = 'baidu';

export function configured(env = {}) {
  return !!(env.BAIDU_API_KEY || env.BAIDU_ACCESS_TOKEN);
}

export function voices() {
  // 基础音库枚举（官方文档口径，联调时核对精品音库表）
  return [
    { id: '0', label: '度小宇（基础·男）' },
    { id: '1', label: '度小美（基础·女）' },
    { id: '3', label: '度逍遥（基础·男·情感）' },
    { id: '4', label: '度丫丫（基础·童声）' },
  ];
}

export async function synthesize() {
  throw new Error('baidu provider 尚未接入：待 BAIDU_API_KEY 到手后按本文件接入清单实现（create→query→audio_url 三步）');
}
