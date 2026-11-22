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
  // API 响应绝不缓存（额度/音色/健康状态都是实时的）
  out.headers.set('cache-control', 'no-store');
  return out;
}

/* ---------------- 轻量存储层（Cache API + 进程内内存） ----------------
 * 为什么不直接用 KV：Cloudflare KV 免费额度每天只有「1000 次写」，
 * 而我们每合成一句就要写 3~4 次（限流/设备额度/全局预算），听一小时就爆，
 * 触发 429 后 API 会整体降级。计数器属于"近似值即可"的数据，
 * 放进 Cache API（不占 KV 配额）+ 进程内内存（隔离实例内强一致）完全够用。
 * KV 只保留"旧数据只读兜底"，基本不再写。
 */
const memStore = new Map(); // key -> { v: string, exp: number }
const CACHE_ORIGIN = 'https://kv-internal.tinttxt.invalid/';
const cacheApi = (() => {
  try { return typeof caches !== 'undefined' && caches.default ? caches.default : null; } catch { return null; }
})();
const urlFor = (key) => CACHE_ORIGIN + encodeURIComponent(key);

/** get/put/delete 的存储门面，接口与 KV 兼容（provider 可无缝使用）。 */
const store = {
  async get(key) {
    const m = memStore.get(key);
    if (m) {
      if (m.exp > Date.now()) return m.v;
      memStore.delete(key);
    }
    if (cacheApi) {
      try {
        const r = await cacheApi.match(urlFor(key));
        if (r) {
          const text = await r.text();
          const ttl = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 300);
          memStore.set(key, { v: text, exp: Date.now() + ttl * 1000 });
          return text;
        }
      } catch { /* ignore */ }
    }
    // 不再回读 KV：KV 免费额度每天只有 1000 次写，读也会加速耗尽；
    // 计数器是"近似即可"的数据，丢了最多让某人当天多用几句，不影响正确性。
    return null;
  },
  async put(key, value, opts) {
    const ttl = (opts && opts.expirationTtl) || 600;
    memStore.set(key, { v: value, exp: Date.now() + ttl * 1000 });
    if (cacheApi) {
      try {
        await cacheApi.put(urlFor(key), new Response(value, {
          headers: { 'cache-control': `max-age=${ttl}`, 'content-type': 'text/plain; charset=utf-8' },
        }));
      } catch { /* ignore */ }
    }
  },
  async delete(key) {
    memStore.delete(key);
    if (cacheApi) {
      try { await cacheApi.delete(urlFor(key)); } catch { /* ignore */ }
    }
  },
};

/** 兼容旧调用点：返回存储门面（不再依赖 request 级 env）。 */
function bindEnv(env) {
  return store;
}

async function getJson(env, key) {
  const raw = await bindEnv(env).get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function putJson(env, key, value, ttlSeconds) {
  await bindEnv(env).put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

/** 写入（尽力而为）：任何存储异常都不能让合成请求失败。 */
async function safePut(env, key, value, ttlSeconds) {
  try {
    await bindEnv(env).put(key, String(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch { /* ignore */ }
}

const TTL = Object.freeze({
  rate: 180,          // 限流窗口 3 分钟
  counter: 3 * 24 * 3600, // 日额度键保留 3 天
  pass: 90 * 24 * 3600,
});

async function bump(env, key, by = 0, ttlSeconds) {
  let cur = 0;
  try { cur = Number((await bindEnv(env).get(key)) || 0); } catch { /* ignore */ }
  const next = cur + by;
  await safePut(env, key, next, ttlSeconds);
  return next;
}

function deviceIdOf(request) {
  const id = request.headers.get('x-device-id') || '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

async function handleTts(request, env, { trial = false } = {}) {
  const limits = limitsFromEnv(env);
  const provider = resolveProvider(env);
  // 供应商未配置时明确报错（不要静默返回 mock 占位音，用户会以为自己耳朵坏了）
  if (provider.name === 'mock' && (env.TTS_PROVIDER || 'baidu') !== 'mock') {
    return json({ error: '云端语音未配置（服务端缺少供应商密钥），已改用本地语音' }, 503);
  }
  // 跨站请求直接拒绝：额度按设备算，device id 是客户端自造的，跨站刷额度必须挡住
  const site = request.headers.get('sec-fetch-site') || '';
  if (site === 'cross-site') return json({ error: '不允许跨站调用' }, 403);
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
  const rateUsed = Number((await bindEnv(env).get(rateKey)) || 0);
  if (!allowByRate(rateUsed, limits)) return json({ error: '请求过于频繁' }, 429);
  await safePut(env, rateKey, String(rateUsed + 1), TTL.rate);

  // 日预算熔断
  const day = dayKey(now);
  const budgetUsed = Number((await bindEnv(env).get(`budget:${day}`)) || 0);
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
    const usedSentences = Number((await bindEnv(env).get(`trial:${device}:${day}`)) || 0);
    if (usedSentences >= limits.trialPerDevicePerDay) return json({ error: '免费试听今天已用完' }, 402);
    quota = applyCharQuota(0, 0, limits.freeCharsPerDay);
  } else {
    const usedBefore = Number((await bindEnv(env).get(`free:${device}:${day}`)) || 0);
    quota = applyCharQuota(usedBefore, chars, limits.freeCharsPerDay);
    if (!quota.allowed) return json({ error: '今日免费额度已用完' }, 402, quotaHeaders(quota, circuit));
  }

  // 合成
  let out;
  try {
    // provider 也走同一存储（token 缓存），不再写 KV
    out = await provider.synthesize({ text: body.text, voice: body.voice, rate: Number(body.rate) || 1, env: { ...env, KV_STORE: bindEnv(env) } });
  } catch (e) {
    return json({ error: `合成失败：${(e && e.message) || e}` }, 502);
  }

  // 落账
  if (trial) await bump(env, `trial:${device}:${day}`, 1, TTL.counter);
  if (pass) { pass.day[day] = Number(pass.day[day] || 0) + chars; await putJson(env, `pass:${auth}`, pass, TTL.pass); }
  else if (!trial) await safePut(env, `free:${device}:${day}`, String(quota.used), TTL.counter);
  await bump(env, `budget:${day}`, chars, TTL.counter);

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
