/**
 * 云端 TTS —— 额度 / 限流 / 熔断（纯函数，无 I/O）
 *
 * 设计原则（见 docs/cloud-tts-payment-plan.md v2 §4）：
 * - 单请求长度上限 → 防一次打爆；
 * - 每 IP 每分钟次数限流 → 防刷；
 * - 每设备每日字符额度（免费档）→ 防免费额度被穿；
 * - 全局日预算熔断 → 成本护栏：当日消耗超过预算直接关云端，宁可不可用也不烧钱。
 * 所有默认值可用环境变量覆盖（index.js 注入 limits），KV 读写在 index.js。
 *
 * @module worker/quota
 */

export const DEFAULT_LIMITS = Object.freeze({
  /** 单请求最大字符数 */
  maxCharsPerRequest: 500,
  /** 每 IP 每分钟最大请求数 */
  perIpPerMinute: 10,
  /** 免费试听：每设备每天句数 */
  trialPerDevicePerDay: 3,
  /** 免费试听：单句最大字符数 */
  trialMaxChars: 50,
  /** 无通行证：每设备每天字符数（约 15 分钟中文朗读） */
  freeCharsPerDay: 3600,
  /** 全局日预算（字符）：熔断阈值，按厂商单价折算预留 ≥3 倍毛利 */
  dailyBudgetChars: 500000,
});

/** 配置键 → 环境变量名（显式映射：toUpperCase 不会产生下划线，曾因此导致覆盖全部失效）。 */
const ENV_KEYS = Object.freeze({
  maxCharsPerRequest: 'MAX_CHARS_PER_REQUEST',
  perIpPerMinute: 'PER_IP_PER_MINUTE',
  trialPerDevicePerDay: 'TRIAL_PER_DEVICE_PER_DAY',
  trialMaxChars: 'TRIAL_MAX_CHARS',
  freeCharsPerDay: 'FREE_CHARS_PER_DAY',
  dailyBudgetChars: 'DAILY_BUDGET_CHARS',
});

/** 从环境变量覆盖默认限额（字符串→数字，非法值忽略）。 */
export function limitsFromEnv(env = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, envKey] of Object.entries(ENV_KEYS)) {
    const v = Number(env[envKey]);
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** UTC 日期键（额度按天重置，与用户时区无关，避免时区刷额度）。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${mm}${dd}`;
}

/** UTC 分钟键（限流窗口）。 */
export function minuteKey(ts = Date.now()) {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dayKey(ts)}${hh}${mi}`;
}

/**
 * 请求体校验。
 * @param {any} text @param {typeof DEFAULT_LIMITS} limits
 * @returns {string|null} 错误信息，null = 通过
 */
export function validateText(text, limits = DEFAULT_LIMITS) {
  if (typeof text !== 'string' || !text.trim()) return 'text 不能为空';
  const len = [...text].length; // 按码位计数，emoji/生僻字不拆半
  if (len > limits.maxCharsPerRequest) {
    return `单次最多 ${limits.maxCharsPerRequest} 字（当前 ${len} 字），请分段请求`;
  }
  return null;
}

/**
 * 频率限制：传入本窗口已用次数（不含本次），返回是否放行。
 * @param {number} usedInWindow @param {typeof DEFAULT_LIMITS} limits
 */
export function allowByRate(usedInWindow, limits = DEFAULT_LIMITS) {
  return usedInWindow < limits.perIpPerMinute;
}

/**
 * 字符额度（免费档或通行证额度）。
 * @param {number} usedBefore 今日已用
 * @param {number} chars 本次消耗
 * @param {number} dailyLimit
 * @returns {{used:number, allowed:boolean, remaining:number, dailyLimit:number}}
 */
export function applyCharQuota(usedBefore, chars, dailyLimit) {
  const used = usedBefore + chars;
  const remaining = Math.max(0, dailyLimit - used);
  return { used, allowed: used <= dailyLimit, remaining, dailyLimit };
}

/**
 * 全局日预算熔断。
 * @param {number} budgetUsed 今日全局已消耗字符
 * @param {typeof DEFAULT_LIMITS} limits
 * @returns {{open:boolean, remaining:number}}
 */
export function checkCircuit(budgetUsed, limits = DEFAULT_LIMITS) {
  const open = budgetUsed >= limits.dailyBudgetChars;
  return { open, remaining: Math.max(0, limits.dailyBudgetChars - budgetUsed) };
}

/** 汇总响应头：让客户端拿到剩余额度（UI 显示"今日还可听 X 分钟"）。 */
export function quotaHeaders(q, circuit) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (q) {
    h.set('X-Quota-Used', String(q.used));
    h.set('X-Quota-Limit', String(q.dailyLimit));
    h.set('X-Quota-Remaining', String(q.remaining));
  }
  if (circuit) h.set('X-Budget-Remaining', String(circuit.remaining));
  return h;
}
