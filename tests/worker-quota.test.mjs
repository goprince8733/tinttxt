/**
 * 云端 TTS Worker —— 额度/限流/熔断 纯函数测试 + 路由集成测试（Mock KV，无网络）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS,
  limitsFromEnv,
  dayKey,
  minuteKey,
  validateText,
  allowByRate,
  applyCharQuota,
  checkCircuit,
} from '../worker/src/quota.js';
import worker from '../worker/src/index.js';

/* ---------------- quota 纯函数 ---------------- */

test('dayKey/minuteKey 输出定长键', () => {
  const t = Date.UTC(2026, 10, 20, 8, 5);
  assert.equal(dayKey(t), '20261120');
  assert.equal(minuteKey(t), '202611200805');
});

test('limitsFromEnv 覆盖与非法值忽略', () => {
  const l = limitsFromEnv({ FREE_CHARS_PER_DAY: '100', PER_IP_PER_MINUTE: 'abc' });
  assert.equal(l.freeCharsPerDay, 100);
  assert.equal(l.perIpPerMinute, DEFAULT_LIMITS.perIpPerMinute);
});

test('validateText：空/超长/emoji 计数', () => {
  assert.ok(validateText(''));
  assert.ok(validateText('   '));
  assert.equal(validateText('你好'), null);
  assert.ok(validateText('字'.repeat(DEFAULT_LIMITS.maxCharsPerRequest + 1)));
  // emoji 按码位计1，不因 surrogate 拆半而误判
  assert.equal(validateText('😀'.repeat(10)), null);
});

test('allowByRate 边界：等于上限即拒绝', () => {
  const limits = { perIpPerMinute: 3 };
  assert.equal(allowByRate(2, limits), true);
  assert.equal(allowByRate(3, limits), false);
});

test('applyCharQuota：额度内放行、超限拒绝、remaining 不为负', () => {
  assert.equal(applyCharQuota(0, 100, 100).allowed, true); // 恰好用满允许
  const over = applyCharQuota(100, 1, 100);
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 0);
});

test('checkCircuit：达到预算即熔断', () => {
  const limits = { dailyBudgetChars: 1000 };
  assert.equal(checkCircuit(999, limits).open, false);
  assert.equal(checkCircuit(1000, limits).open, true);
});

/* ---------------- 路由集成（Mock KV） ---------------- */

function mockKV() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
    _map: m,
  };
}

function makeEnv(overrides = {}) {
  return { DATA: mockKV(), ALLOWED_ORIGINS: 'https://tinttxt.pages.dev', TTS_PROVIDER: 'mock', ...overrides };
}

const ORIGIN = { origin: 'https://tinttxt.pages.dev' };

test('health 返回供应商与配置状态', async () => {
  const res = await worker.fetch(new Request('http://x/api/health'), makeEnv(), {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.provider, 'mock');
  assert.equal(j.configured, true);
});

test('OPTIONS 预检：白名单 origin 放行', async () => {
  const res = await worker.fetch(new Request('http://x/api/tts', { method: 'OPTIONS', headers: ORIGIN }), makeEnv(), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://tinttxt.pages.dev');
});

test('tts 无鉴权 → 401', async () => {
  const res = await worker.fetch(
    new Request('http://x/api/tts', { method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }) }),
    makeEnv(),
    {},
  );
  assert.equal(res.status, 401);
});

test('tts 免费档全流程：200 + RIFF WAV + 额度头', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    new Request('http://x/api/tts', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', 'x-device-id': 'device-abcdef123456' },
      body: JSON.stringify({ text: '清晨的阳光照进窗户。', rate: 1 }),
    }),
    env,
    {},
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('x-tts-provider'), 'mock');
  assert.ok(res.headers.get('x-quota-remaining'));
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.equal(String.fromCharCode(buf[0], buf[1], buf[2], buf[3]), 'RIFF', '应为 WAV');
  assert.ok(buf.byteLength > 44);
});

test('额度耗尽 → 402（env 覆盖日额度）', async () => {
  const env = makeEnv({ FREE_CHARS_PER_DAY: '100' });
  const req = (text) =>
    new Request('http://x/api/tts', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', 'x-device-id': 'device-abcdef123456' },
      body: JSON.stringify({ text }),
    });
  const first = await worker.fetch(req('字'.repeat(100)), env, {});
  assert.equal(first.status, 200, await first.clone().text());
  const second = await worker.fetch(req('超了'), env, {});
  assert.equal(second.status, 402);
  assert.equal(second.headers.get('x-quota-remaining'), '0');
});

test('限流 → 429（env 覆盖每分钟上限）', async () => {
  const env = makeEnv({ PER_IP_PER_MINUTE: '2' });
  const req = () =>
    new Request('http://x/api/tts', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', 'x-device-id': 'device-abcdef123456' },
      body: JSON.stringify({ text: '限流测试' }),
    });
  assert.equal((await worker.fetch(req(), env, {})).status, 200);
  assert.equal((await worker.fetch(req(), env, {})).status, 200);
  const third = await worker.fetch(req(), env, {});
  assert.equal(third.status, 429);
});

test('日预算熔断 → 503（env 覆盖预算）', async () => {
  const env = makeEnv({ DAILY_BUDGET_CHARS: '50' });
  const req = (text) =>
    new Request('http://x/api/tts', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', 'x-device-id': 'device-abcdef123456' },
      body: JSON.stringify({ text }),
    });
  // 首次消耗60 字 > 预算50 → 预算在合成后累计，第二次请求触发熔断
  const first = await worker.fetch(req('字'.repeat(60)), env, {});
  assert.equal(first.status, 200, await first.clone().text());
  const second = await worker.fetch(req('熔断测试'), env, {});
  assert.equal(second.status, 503);
});

test('试听：句长限制与每日次数', async () => {
  const env = makeEnv({ TRIAL_PER_DEVICE_PER_DAY: '2' });
  const req = (text) =>
    new Request('http://x/api/trial', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', 'x-device-id': 'device-abcdef123456' },
      body: JSON.stringify({ text }),
    });
  assert.equal((await worker.fetch(req('字'.repeat(51)), env, {})).status, 400);
  assert.equal((await worker.fetch(req('短句'), env, {})).status, 200);
  assert.equal((await worker.fetch(req('短句'), env, {})).status, 200);
  assert.equal((await worker.fetch(req('短句'), env, {})).status, 402);
});

test('me 返回免费额度状态；pay 占位 501；未知路由 404', async () => {
  const env = makeEnv();
  const me = await worker.fetch(new Request('http://x/api/me', { headers: { ...ORIGIN, 'x-device-id': 'device-abcdef123456' } }), env, {});
  assert.equal(me.status, 200);
  const meJson = await me.json();
  assert.equal(meJson.type, 'free');
  assert.ok(meJson.quota.dailyLimit > 0);

  const pay = await worker.fetch(new Request('http://x/api/pay/create', { method: 'POST', headers: ORIGIN }), env, {});
  assert.equal(pay.status, 501);

  const nf = await worker.fetch(new Request('http://x/api/nope', { headers: ORIGIN }), env, {});
  assert.equal(nf.status, 404);
});

test('voices 返回供应商音色列表（mock）', async () => {
  const res = await worker.fetch(new Request('http://x/api/voices', { headers: ORIGIN }), makeEnv(), {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.provider, 'mock');
  assert.equal(j.configured, true);
  assert.ok(Array.isArray(j.voices) && j.voices.length > 0);
});

test('回归：错误响应也带 CORS 头（否则浏览器拦截、前端读不到错误信息）', async () => {
  const env = makeEnv();
  // /api/me 无鉴权 → 401，必须仍带 CORS 头
  const me401 = await worker.fetch(new Request('http://x/api/me', { headers: ORIGIN }), env, {});
  assert.equal(me401.status, 401);
  assert.equal(me401.headers.get('access-control-allow-origin'), 'https://tinttxt.pages.dev');
  // /api/tts 无鉴权 → 401，同样必须带
  const tts401 = await worker.fetch(
    new Request('http://x/api/tts', { method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }) }),
    env,
    {},
  );
  assert.equal(tts401.status, 401);
  assert.equal(tts401.headers.get('access-control-allow-origin'), 'https://tinttxt.pages.dev');
});

test('回归：失败请求（402）也消耗限流次数（防刷失败请求打爆免费额度）', async () => {
  const env = makeEnv({ FREE_CHARS_PER_DAY: '100', PER_IP_PER_MINUTE: '2' });
  const req = (text) =>
    new Request('http://x/api/tts', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', 'x-device-id': 'device-abcdef123456' },
      body: JSON.stringify({ text }),
    });
  // 第1次成功（100字用满），第2次额度超限402（也计rate=2），第3次必须是429——
  // 若失败不计数，第3次还会是402，限流对失败流量形同虚设
  assert.equal((await worker.fetch(req('字'.repeat(100)), env, {})).status, 200);
  assert.equal((await worker.fetch(req('再来一句'), env, {})).status, 402);
  const third = await worker.fetch(req('又一句'), env, {});
  assert.equal(third.status, 429, '失败请求必须消耗限流次数');
});

test('通行证：鉴权、额度写回、超额402、过期401', async () => {
  const env = makeEnv({ FREE_CHARS_PER_DAY: '100' });
  const day = dayKey();
  const token = 'test-pass-token-abcdef01';
  const pass = {
    deviceId: 'device-abcdef123456',
    plan: { dailyChars: 150 },
    exp: Date.now() + 86400000,
    day: {},
    usedTotal: 0,
  };
  await env.DATA.put(`pass:${token}`, JSON.stringify(pass));

  const req = (text) =>
    new Request('http://x/api/tts', {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });

  // 额度内：200 + day 计数写回 KV（整100字）
  const first = await worker.fetch(req('字'.repeat(100)), env, {});
  assert.equal(first.status, 200, await first.clone().text());
  assert.ok(first.headers.get('x-quota-remaining'));
  const after = JSON.parse(await env.DATA.get(`pass:${token}`));
  assert.equal(after.day[day], 100);
  assert.equal(after.usedTotal, 100);

  // 超过 plan.dailyChars=150 → 402
  const second = await worker.fetch(req('字'.repeat(60)), env, {});
  assert.equal(second.status, 402);

  // /api/me：有效通行证返回 pass 状态
  const me = await worker.fetch(new Request('http://x/api/me', { headers: { ...ORIGIN, authorization: `Bearer ${token}` } }), env, {});
  assert.equal(me.status, 200);
  const meJson = await me.json();
  assert.equal(meJson.type, 'pass');
  assert.equal(meJson.quota.dailyLimit, 150);

  // 过期通行证：/api/tts 与 /api/me 都必须 401（曾有不一致：me 不查 exp）
  const expired = { ...pass, exp: Date.now() - 1000 };
  await env.DATA.put(`pass:${token}`, JSON.stringify(expired));
  assert.equal((await worker.fetch(req('过期测试'), env, {})).status, 401);
  const meExpired = await worker.fetch(new Request('http://x/api/me', { headers: { ...ORIGIN, authorization: `Bearer ${token}` } }), env, {});
  assert.equal(meExpired.status, 401, '/api/me 必须也拒绝过期通行证');
});
