/**
 * 百度智能云 · 语音合成供应商
 *
 * API 文档：https://cloud.baidu.com/doc/SPEECH/s/Jlbxdezuf
 * - 获取 token：POST https://aip.baidubce.com/oauth/2.0/token
 * - 合成：POST https://tsn.baidu.com/text2audio（同步返回完整音频）
 *
 * 支持音色（per 参数）：
 *   0=度小美(女) 1=度小宇(男) 3=度逍遥(男·情感) 4=度丫丫(童声)
 *   5=度小娇(女) 5118=度小贤(男) 5117=度小鹿(女) 5119=度小乔(女)
 *   5120=度小萌(女) 5121=度小喆(男) 5122=度小斌(男) 5123=度小洁(女)
 *
 * 接入清单（已完成）：
 *   ✅ token 获取与缓存（KV，25天过期自动续）
 *   ✅ text2audio 合成（WAV 输出，aue=6）
 *   ✅ 多音色支持（per 参数）
 *   ✅ 语速/音调/音量参数
 * @module worker/providers/baidu
 */
import { pcm16MonoToWav } from './util.js';

export const name = 'baidu';

const TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';
const TTS_URL = 'https://tsn.baidu.com/text2audio';
/** token 有效期 30 天，提前 5 天刷新 */
const TOKEN_TTL_MS = 25 * 24 * 60 * 60 * 1000;
/** 合法音色（per）。旧版存下的 sherpa 音色 ID 会落回默认女声，避免 400 报错。 */
const ALLOWED_VOICES = new Set(['0', '1', '3', '4', '5', '5118', '5117', '5119', '5120', '5121', '5122', '5123']);

export function configured(env = {}) {
  return !!(env.BAIDU_API_KEY && env.BAIDU_SECRET_KEY);
}

export function voices() {
  return [
    { id: '0', label: '度小美（女声·标准）' },
    { id: '1', label: '度小宇（男声·标准）' },
    { id: '3', label: '度逍遥（男声·情感）' },
    { id: '4', label: '度丫丫（童声）' },
    { id: '5', label: '度小娇（女声·温柔）' },
    { id: '5118', label: '度小贤（男声·磁性）' },
    { id: '5117', label: '度小鹿（女声·活泼）' },
    { id: '5119', label: '度小乔（女声·知性）' },
    { id: '5121', label: '度小喆（男声·沉稳）' },
    { id: '5123', label: '度小洁（女声·清亮）' },
  ];
}

/** 出站请求超时信号（Workers/workerd 支持 AbortSignal.timeout）；不支持时回退 undefined。 */
function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

/** 清除缓存的 token（token 失效时调用，避免 25 天内一直用坏 token）。 */
async function clearToken(env) {
  const KV = env.KV_STORE || env.DATA;
  if (!KV) return;
  try { await KV.delete('baidu:token'); } catch { /* ignore */ }
}

/** 获取 access_token（缓存在 KV，25 天过期自动刷新；无 KV 时每次实时获取）。 */
async function getToken(env) {
  const KV = env.KV_STORE || env.DATA;
  // 尝试从缓存读取
  if (KV) {
    try {
      const cached = await KV.get('baidu:token');
      if (cached) {
        const { token, expiresAt } = JSON.parse(cached);
        if (token && Date.now() < expiresAt) return token;
      }
    } catch { /* ignore */ }
  }

  // 重新获取
  const resp = await fetch(`${TOKEN_URL}?grant_type=client_credentials&client_id=${env.BAIDU_API_KEY}&client_secret=${env.BAIDU_SECRET_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: timeoutSignal(8000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`百度 token 获取失败: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`百度 token 获取失败: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // 缓存 token
  if (KV) {
    try {
      await KV.put('baidu:token', JSON.stringify({
        token: data.access_token,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      }), { expirationTtl: 30 * 24 * 60 * 60 });
    } catch { /* ignore */ }
  }
  return data.access_token;
}

/**
 * 合成文本 → WAV 音频。
 * 内置：token 失效（110/111）自动刷新重试一次、出站超时、RIFF 头校验。
 * @param {{text:string, voice?:string, rate?:number, env:object}} opts
 * @returns {Promise<{wav:ArrayBuffer, mime:string, provider:string, durationSeconds:number}>}
 */
export async function synthesize({ text, voice, rate = 1, env }) {
  const wanted = String(voice ?? '');
  const per = ALLOWED_VOICES.has(wanted) ? wanted : '0';
  const spd = Math.round(Math.min(15, Math.max(0, (rate - 0.5) / 1.5 * 15))); // rate 0.5~2 → spd 0~15

  const callOnce = async (token) => {
    const body = new URLSearchParams({
      tex: text,
      tok: token,
      cuid: 'tinttxt',
      ctp: '1',
      lan: 'zh',
      per,
      spd: String(spd),
      pit: '5',
      vol: '5',
      aue: '6', // 6=wav
    });
    const resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      // 出站超时：没有超时会导致请求半开、chunk 永久 "合成中"（用户看到一直转圈）
      signal: timeoutSignal(20000),
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const err = await resp.json().catch(() => ({}));
      const e = new Error(`百度合成失败: ${err.err_no || resp.status} ${err.err_msg || '未知错误'}`);
      e.baiduErrNo = Number(err.err_no) || 0;
      throw e;
    }
    if (!resp.ok) throw new Error(`百度合成 HTTP ${resp.status}`);
    const wav = await resp.arrayBuffer();
    return wav;
  };

  let token = await getToken(env);
  let wav;
  try {
    wav = await callOnce(token);
  } catch (e) {
    // token 失效（110=access token 无效, 111=过期）：清缓存后重取一次
    if (e && (e.baiduErrNo === 110 || e.baiduErrNo === 111)) {
      await clearToken(env);
      token = await getToken(env);
      wav = await callOnce(token);
    } else {
      throw e;
    }
  }

  if (wav.byteLength < 100) {
    throw new Error(`百度合成返回数据过小（${wav.byteLength} bytes），可能文本为空或参数错误`);
  }
  // 防呆：错误页/HTML 被当音频返回 → 播放层会报"音频播放失败"，这里提前拦。
  // 注意：wav 是 ArrayBuffer，不能用 wav[0] 取值（恒 undefined），必须先建 Uint8Array 视图。
  const head = new Uint8Array(wav, 0, 4);
  const riff = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (riff !== 'RIFF') {
    throw new Error(`百度返回的不是 WAV（头部=${JSON.stringify(riff)}）`);
  }

  // 估算时长（WAV 头 44 字节 + 16-bit 单声道 16kHz）
  const durationSeconds = Math.max(0.5, (wav.byteLength - 44) / (16000 * 2));

  return {
    wav,
    mime: 'audio/wav',
    provider: 'baidu',
    durationSeconds,
  };
}
