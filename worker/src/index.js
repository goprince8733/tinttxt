/**
 * 蝈蝈听书 · 云端 TTS Worker（Cloudflare Worker，M1 骨架）
 *
 * 职责（方案文档 docs/cloud-tts-payment-plan.md）：
 *   GET  /api/health   健康检查 + 当前供应商/是否已配置 key
 *   GET  /api/voices   音色列表（UI 下拉框；供应商未接入时返回占位）
 *   POST /api/tts      合成：鉴权 → 限流 → 熔断 → 额度 → 供应商 → WAV
 *   POST /api/trial    免费试听（每设备每天 N 句，句长受限）
 *   GET  /api/me       通行证/额度状态（UI 显示"今日还可听 X 分钟"）
 *   POST /api/pay/*    M2 支付（当前501 占位）
 *   POST /api/activate 兑换码/订单号激活（M2 占位）
 *
 * 安全：
 *   - 厂商 key 只存 Worker secret（VOLC_TTS_TOKEN 等），永不下发行程；
 *   - CORS 白名单（ALLOWED_ORIGINS）；
 *   - 额度/限流/熔断见 quota.js（纯函数可单测），KV 读写集中在此文件。
 *
 * 部署：
 *   cd worker && npx wrangler kv:namespace create DATA   # 把 id 填进 wrangler.toml
 *   npx wrangler secret put VOLC_TTS_TOKEN               # key 到手后
 *   npx wrangler deploy
 */
import {
  limitsFromEnv,
  dayKey,
  minuteKey,
  validateText,
  allowByRate,
  applyCharQuota,
  checkCircuit,
  quotaHeaders,
} from './quota.js';
import * as mockProvider from './providers/mock.js';
import * as baiduProvider from './providers/baidu.js';
import * as tencentProvider from './providers/tencent.js';
import * as volcanoProvider from './providers/volcano.js';

const PROVIDERS = {
  mock: mockProvider,
  baidu: baiduProvider,
  tencent: tencentProvider,
  volcano: volcanoProvider,
};

const DEFAULT_ALLOWED = 'https://tinttxt.pages.dev,http://127.0.0.1:8123,http://localhost:8123';

function resolveProvider(env) {
  const want = env.TTS_PROVIDER || 'volcano';
  const p = PROVIDERS[want];
  if (p && p.configured(env)) return p;
  return mockProvider; // key 未配置 → mock 打通全链路（/api/health 会标注）
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allow = (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED).split(',').map((s) => s.trim());
  const h = new Headers();
  if (origin && allow.includes(origin)) {
    h.set('access-control-allow-origin', origin);
    h.set('vary', 'Origin');
    h.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    h.set('access-control-allow-headers', 'content-type,authorization,x-device-id');
    h.set('access-control-max-age', '86400');
  }
  return h;
}

function json(data, status = 200, extraHeaders) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (extraHeaders) for (const [k, v] of extraHeaders) h.set(k, v);
  return new Response(JSON.stringify(data), { status, headers: h });
}

/* ---------------- KV 小工具 ---------------- */

async function getJson(env, key) {
  const raw = await env.DATA.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function putJson(env, key, value) {
  await env.DATA.put(key, JSON.stringify(value));
}

/** 计数器自增（读-改-写；KV 最终一致，个人规模够用，见方案 §4）。 */
async function bump(env, key, by = 0) {
  const cur = Number((await env.DATA.get(key)) || 0);
  const next = cur + by;
  await env.DATA.put(key, String(next));
  return next;
}

function deviceIdOf(request) {
  const id = request.headers.get('x-device-id') || '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

/* ---------------- 处理器 ---------------- */

async function handleTts(request, env, { trial = false } = {}) {
  const limits = limitsFromEnv(env);
  const provider = resolveProvider(env);
  const now = Date.now();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }
  const textErr = validateText(body && body.text, limits);
  if (textErr) return json({ error: textErr }, 400);
  if (trial && [...body.text].length > limits.trialMaxChars) {
    return json({ error: `试听单句最多 ${limits.trialMaxChars} 字` }, 400);
  }
  const chars = [...body.text].length;

  // —— 鉴权：通行证（Bearer）优先，否则设备号免费档；试听必须设备号 ——
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const device = deviceIdOf(request);
  let pass = null;
  if (auth) {
    pass = await getJson(env, `pass:${auth}`);
    if (!pass || (pass.exp && pass.exp < now)) {
      return json({ error: '通行证无效或已过期' }, 401);
    }
  } else if (!device) {
    return json({ error: '缺少鉴权：请携带 X-Device-Id（免费档）或 Bearer 通行证' }, 401);
  }

  // —— 限流（每 IP 每分钟）——
  // 注意：检查通过后【立即】写计数（而非合成成功后）——否则被 402/502 拒绝的
  // 请求不占次数，恶意刷失败请求可无限打（每次仍耗 KV 读与 Workers 请求额）。
  const ip = (request.headers.get('cf-connecting-ip') || '0.0.0.0').slice(0, 40);
  const rateKey = `rate:${ip}:${minuteKey(now)}`;
  const rateUsed = Number((await env.DATA.get(rateKey)) || 0);
  if (!allowByRate(rateUsed, limits)) {
    return json({ error: `请求过于频繁（每分钟上限 ${limits.perIpPerMinute} 次），请稍后再试` }, 429);
  }
  await env.DATA.put(rateKey, String(rateUsed + 1));

  // —— 全局日预算熔断（成本护栏）——
  const day = dayKey(now);
  const budgetUsed = Number((await env.DATA.get(`budget:${day}`)) || 0);
  const circuit = checkCircuit(budgetUsed, limits);
  if (circuit.open) {
    return json({ error: '今日云端额度已用完，明天再来（本地朗读不受影响）' }, 503, [
      ['retry-after', '3600'],
    ]);
  }

  // —— 字符额度 ——
  let quota;
  let quotaKey;
  if (pass) {
    pass.day = pass.day || {};
    const usedBefore = Number(pass.day[day] || 0);
    const dailyLimit = (pass.plan && pass.plan.dailyChars) || limits.freeCharsPerDay * 10;
    quota = applyCharQuota(usedBefore, chars, dailyLimit);
    if (!quota.allowed) {
      return json({ error: '今日额度已用完，明天0点（UTC）重置' }, 402, quotaHeaders(quota, circuit));
    }
    quotaKey = null; // 通行证额度写回 pass 对象
  } else if (trial) {
    // 试听次数【合成成功后】才落账（见下方落账段）——失败不扣句数，
    // 与「合成成功才计费」原则一致；此处仅预检是否已超。
    const usedSentences = Number((await env.DATA.get(`trial:${device}:${day}`)) || 0);
    if (usedSentences >= limits.trialPerDevicePerDay) {
      return json({ error: `免费试听今天已用完（每天 ${limits.trialPerDevicePerDay} 句）` }, 402);
    }
    // 回报真实的免费档余量（试听不占字符额度，X-Quota-Used 不虚报本次字符）
    const freeUsed = Number((await env.DATA.get(`free:${device}:${day}`)) || 0);
    quota = applyCharQuota(freeUsed, 0, limits.freeCharsPerDay);
    quotaKey = null;
  } else {
    quotaKey = `free:${device}:${day}`;
    const usedBefore = Number((await env.DATA.get(quotaKey)) || 0);
    quota = applyCharQuota(usedBefore, chars, limits.freeCharsPerDay);
    if (!quota.allowed) {
      return json({ error: '今日免费额度已用完（明天0 点 UTC 重置）；开通通行证可提升' }, 402, quotaHeaders(quota, circuit));
    }
  }

  // —— 合成 ——
  let out;
  try {
    out = await provider.synthesize({
      text: body.text,
      voice: body.voice || (provider.voices()[0] || {}).id,
      rate: Number(body.rate) || 1,
      env,
    });
  } catch (e) {
    return json({ error: `合成失败：${(e && e.message) || e}` }, 502);
  }

  // —— 用量落账（合成成功才计费）——
  if (quotaKey) await env.DATA.put(quotaKey, String(quota.used));
  if (trial) await bump(env, `trial:${device}:${day}`, 1); // 成功才占试听句数
  if (pass) {
    pass.day[day] = Number(pass.day[day] || 0) + chars;
    pass.usedTotal = (pass.usedTotal || 0) + chars;
    await putJson(env, `pass:${auth}`, pass);
  }
  await bump(env, `budget:${day}`, chars);

  const headers = quotaHeaders(quota, checkCircuit(budgetUsed + chars, limits));
  headers.set('content-type', out.mime || 'audio/wav');
  headers.set('x-tts-provider', out.provider || provider.name);
  return new Response(out.wav, { status: 200, headers });
}

async function handleVoices(request, env) {
  const provider = resolveProvider(env);
  return json({
    provider: provider.name,
    configured: provider.configured(env),
    voices: provider.voices(),
  }, 200, corsHeaders(request, env));
}

async function handleMe(request, env) {
  const now = Date.now();
  const day = dayKey(now);
  const limits = limitsFromEnv(env);
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const device = deviceIdOf(request);
  const budgetUsed = Number((await env.DATA.get(`budget:${day}`)) || 0);
  const circuit = checkCircuit(budgetUsed, limits);
  if (auth) {
    const pass = await getJson(env, `pass:${auth}`);
    // 与 handleTts 一致：过期通行证在此就报 401，而不是等合成时才被拒
    if (!pass || (pass.exp && pass.exp < now)) {
      return json({ error: '通行证无效或已过期' }, 401);
    }
    const used = Number((pass.day && pass.day[day]) || 0);
    const dailyLimit = (pass.plan && pass.plan.dailyChars) || limits.freeCharsPerDay * 10;
    const q = applyCharQuota(used, 0, dailyLimit);
    return json({ type: 'pass', plan: pass.plan || {}, quota: q, circuit }, 200, corsHeaders(request, env));
  }
  if (!device) return json({ error: '缺少 X-Device-Id' }, 401);
  const used = Number((await env.DATA.get(`free:${device}:${day}`)) || 0);
  const q = applyCharQuota(used, 0, limits.freeCharsPerDay);
  return json({ type: 'free', quota: q, circuit }, 200, corsHeaders(request, env));
}

/* ---------------- 入口 ---------------- */

/**
 * 统一补 CORS：所有响应（含处理器内部返回的 4xx/5xx）都经这里包装，
 * 否则浏览器会拦掉无 CORS 头的错误响应，前端只能读到 TypeError 而非错误信息。
 */
function withCors(res, cors) {
  const out = new Response(res.body, { status: res.status, headers: res.headers });
  for (const [k, v] of cors) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/health') {
        const provider = resolveProvider(env);
        return withCors(json(
          { ok: true, provider: provider.name, configured: provider.configured(env), time: new Date().toISOString() },
          200,
        ), cors);
      }
      if (url.pathname === '/api/voices' && request.method === 'GET') {
        return withCors(await handleVoices(request, env), cors);
      }
      if (url.pathname === '/api/me' && request.method === 'GET') {
        return withCors(await handleMe(request, env), cors);
      }
      if (url.pathname === '/api/tts' && request.method === 'POST') {
        return withCors(await handleTts(request, env, { trial: false }), cors);
      }
      if (url.pathname === '/api/trial' && request.method === 'POST') {
        return withCors(await handleTts(request, env, { trial: true }), cors);
      }
      // M2 占位：支付/激活
      if (url.pathname.startsWith('/api/pay/') || url.pathname === '/api/activate') {
        return withCors(json({ error: '支付/兑换功能将在 M2 开通（方案已定：虎皮椒回调 + 设备通行证）' }, 501), cors);
      }
      return withCors(json({ error: 'not found' }, 404), cors);
    } catch (e) {
      return withCors(json({ error: `服务器错误：${(e && e.message) || e}` }, 500), cors);
    }
  },
};
