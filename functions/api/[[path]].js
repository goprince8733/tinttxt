/**
 * Cloudflare Pages Functions —— 云端 TTS API（与前端同域 tinttxt.pages.dev，国内可达）
 * 路由：/api/health /api/voices /api/tts /api/trial /api/me
 * 复用 worker/src/ 的供应商与额度逻辑。
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
} from '../../worker/src/quota.js';
import * as mockProvider from '../../worker/src/providers/mock.js';
import * as baiduProvider from '../../worker/src/providers/baidu.js';
import * as tencentProvider from '../../worker/src/providers/tencent.js';

const PROVIDERS = { mock: mockProvider, baidu: baiduProvider, tencent: tencentProvider };
const DEFAULT_ALLOWED = 'https://tinttxt.pages.dev,http://127.0.0.1:8123,http://localhost:8123';

function resolveProvider(env) {
  const want = env.TTS_PROVIDER || 'baidu';
  const p = PROVIDERS[want];
  if (p && p.configured(env)) return p;
  return mockProvider;
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

function withCors(res, cors) {
  const out = new Response(res.body, { status: res.status, headers: res.headers });
  for (const [k, v] of cors) out.headers.set(k, v);
  return out;
}

async function getJson(env, key) {
  if (!env.DATA) return null;
  const raw = await env.DATA.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function putJson(env, key, value) {
  if (!env.DATA) return;
  await env.DATA.put(key, JSON.stringify(value));
}

async function bump(env, key, by = 0) {
  if (!env.DATA) return by;
  const cur = Number((await env.DATA.get(key)) || 0);
  const next = cur + by;
  await env.DATA.put(key, String(next));
  return next;
}

function deviceIdOf(request) {
  const id = request.headers.get('x-device-id') || '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

async function handleTts(request, env, { trial = false } = {}) {
  const limits = limitsFromEnv(env);
  const provider = resolveProvider(env);
  const now = Date.now();

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体必须是 JSON' }, 400); }
  const textErr = validateText(body && body.text, limits);
  if (textErr) return json({ error: textErr }, 400);
  if (trial && [...body.text].length > limits.trialMaxChars) {
    return json({ error: `试听单句最多 ${limits.trialMaxChars} 字` }, 400);
  }
  const chars = [...body.text].length;

  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const device = deviceIdOf(request);
  let pass = null;
  if (auth) {
    pass = await getJson(env, `pass:${auth}`);
    if (!pass || (pass.exp && pass.exp < now)) return json({ error: '通行证无效或已过期' }, 401);
  } else if (!device) {
    return json({ error: '缺少鉴权' }, 401);
  }

  // 限流（先写计数，失败也占次数）
  const ip = (request.headers.get('cf-connecting-ip') || '0.0.0.0').slice(0, 40);
  const rateKey = `rate:${ip}:${minuteKey(now)}`;
  const rateUsed = env.DATA ? Number((await env.DATA.get(rateKey)) || 0) : 0;
  if (!allowByRate(rateUsed, limits)) return json({ error: '请求过于频繁' }, 429);
  if (env.DATA) await env.DATA.put(rateKey, String(rateUsed + 1));

  // 日预算熔断
  const day = dayKey(now);
  const budgetUsed = env.DATA ? Number((await env.DATA.get(`budget:${day}`)) || 0) : 0;
  const circuit = checkCircuit(budgetUsed, limits);
  if (circuit.open) return json({ error: '今日云端额度已用完' }, 503);

  // 字符额度
  let quota;
  if (pass) {
    pass.day = pass.day || {};
    const usedBefore = Number(pass.day[day] || 0);
    const dailyLimit = (pass.plan && pass.plan.dailyChars) || limits.freeCharsPerDay * 10;
    quota = applyCharQuota(usedBefore, chars, dailyLimit);
    if (!quota.allowed) return json({ error: '今日额度已用完' }, 402, quotaHeaders(quota, circuit));
  } else if (trial) {
    const usedSentences = env.DATA ? Number((await env.DATA.get(`trial:${device}:${day}`)) || 0) : 0;
    if (usedSentences >= limits.trialPerDevicePerDay) return json({ error: '免费试听今天已用完' }, 402);
    quota = applyCharQuota(0, 0, limits.freeCharsPerDay);
  } else {
    const usedBefore = env.DATA ? Number((await env.DATA.get(`free:${device}:${day}`)) || 0) : 0;
    quota = applyCharQuota(usedBefore, chars, limits.freeCharsPerDay);
    if (!quota.allowed) return json({ error: '今日免费额度已用完' }, 402, quotaHeaders(quota, circuit));
  }

  // 合成
  let out;
  try {
    out = await provider.synthesize({ text: body.text, voice: body.voice, rate: Number(body.rate) || 1, env });
  } catch (e) {
    return json({ error: `合成失败：${(e && e.message) || e}` }, 502);
  }

  // 落账
  if (trial) await bump(env, `trial:${device}:${day}`, 1);
  if (pass) { pass.day[day] = Number(pass.day[day] || 0) + chars; await putJson(env, `pass:${auth}`, pass); }
  else if (!trial && env.DATA) await env.DATA.put(`free:${device}:${day}`, String(quota.used));
  await bump(env, `budget:${day}`, chars);

  const headers = quotaHeaders(quota, checkCircuit(budgetUsed + chars, limits));
  headers.set('content-type', out.mime || 'audio/wav');
  headers.set('x-tts-provider', out.provider || provider.name);
  return new Response(out.wav, { status: 200, headers });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  const path = url.pathname.replace(/^\/api/, '');

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    if (path === '/health') {
      const provider = resolveProvider(env);
      return withCors(json({ ok: true, provider: provider.name, configured: provider.configured(env), time: new Date().toISOString() }), cors);
    }
    if (path === '/voices' && request.method === 'GET') {
      const provider = resolveProvider(env);
      return withCors(json({ provider: provider.name, configured: provider.configured(env), voices: provider.voices() }), cors);
    }
    if (path === '/tts' && request.method === 'POST') return withCors(await handleTts(request, env), cors);
    if (path === '/trial' && request.method === 'POST') return withCors(await handleTts(request, env, { trial: true }), cors);
    return withCors(json({ error: 'not found' }, 404), cors);
  } catch (e) {
    return withCors(json({ error: `服务器错误：${(e && e.message) || e}` }, 500), cors);
  }
}
