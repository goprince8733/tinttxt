/**
 * 播放层 —— 大文件分块清单支持（Cloudflare Pages 单文件 25 MiB 上限的对策）
 *
 * 静态托管平台对单文件体积有硬上限（Cloudflare Pages / Workers 均为 25 MiB），
 * 而 TTS 模型（sherpa int8 39.9MB、piper medium 63.2MB）超限，无法整文件上传。
 * `scripts/deploy-cloudflare.mjs` 会在部署前把这些文件在 dist/ 里切成
 * `<url>.p0 / .p1 / …` 分片，并在站点根写入 `/asset-chunks.json`：
 *
 * ```json
 * { "version": 1,
 *   "files": { "/models/sherpa-zh/vits-aishell3.int8.onnx":
 *              { "bytes": 39870124,
 *                "parts": ["/models/sherpa-zh/vits-aishell3.int8.onnx.p0", "…p1"],
 *                "partBytes": [20971520, 18898604] } } }
 * ```
 *
 * 本模块供 TTS 适配器（sherpa.js / local.js）在下载前查询：命中分块计划则
 * 按片顺序拉取并拼装，结果仍以**原始 URL（或调用方给的 cache key）**写入
 * Cache Storage —— 上层 isReady()、离线复用、进度上报全部无感。
 *
 * 兼容性约定：
 * - 本地开发 / 未切块部署：清单不存在或 404 → 视为「无分块」，走原有整文件下载；
 * - 清单只加载一次（进程内缓存）；加载失败不抛错，交由整文件路径兜底；
 * - 运行期仍然零外联：清单与分片全部同源。
 * @module playback/tts/asset-chunks
 */

/** 清单地址（站点根，部署脚本生成；本地 dev-server 未生成时返回 404）。 */
const MANIFEST_URL = '/asset-chunks.json';

/**
 * @typedef {Object} ChunkPlan
 * @property {number} bytes 原始文件总字节数
 * @property {string[]} parts 分片 URL（同源绝对路径，按序）
 * @property {number[]} partBytes 各分片字节数（与 parts 一一对应）
 */

/** @type {Promise<Record<string, ChunkPlan>|null>|null} 清单（只加载一次） */
let manifestPromise = null;

/**
 * 加载并缓存清单；404 / 非 JSON / 网络失败一律退化为 null（无分块）。
 * @returns {Promise<Record<string, ChunkPlan>|null>}
 */
function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j.files : null))
      .catch(() => null);
  }
  return manifestPromise;
}

/**
 * 查询某个 URL 的分块计划。
 * @param {string} url 同源绝对路径（如 /models/sherpa-zh/vits-aishell3.int8.onnx）
 * @returns {Promise<ChunkPlan|null>} 无分块返回 null
 */
export async function getChunkPlan(url) {
  const files = await loadManifest();
  if (!files) return null;
  const plan = files[url];
  if (!plan || !Array.isArray(plan.parts) || !plan.parts.length) return null;
  return plan;
}

/**
 * 拒绝「看似 200、实为 HTML 兜底页」的响应。
 * Cloudflare Pages 等平台对不存在的路径会返回 200 + index.html（SPA 兜底），
 * 直接当二进制写进 Cache Storage 会把模型静默写坏 —— 必须按 Content-Type 拦下。
 * @param {Response} res
 * @param {string} url 出错信息里回显的地址
 */
export function assertBinaryResponse(res, url) {
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    throw new Error(`HTTP 200 但返回的是 HTML 兜底页（资源不存在？）@ ${url}`);
  }
}

/**
 * 网络卡死看门狗 —— 「镜像优先」策略的保险丝。
 *
 * 镜像快就用镜像，但镜像可能**卡住而不报错**（连接挂着：不返回也不失败），
 * 浏览器 fetch 没有总超时，会永远等下去。本看门狗：每收到一次字节就续期；
 * 连续 `stallMs` 毫秒没有任何字节 → abort 本次尝试，调用方随即换下一个来源。
 *
 * 两种中止必须区分：
 * - `wd.stalled === true` → 看门狗判死，调用方应**换源重试**；
 * - 否则的 AbortError → 用户主动中止（外部 signal），原样上抛。
 *
 * @param {AbortSignal} [externalSignal] 用户的中止信号（透传进来）
 * @param {number} stallMs 连续无字节多久判死
 * @returns {{signal: AbortSignal, arm: () => void, dispose: () => void, stalled: boolean}}
 */
export function createStallWatchdog(externalSignal, stallMs = 10000) {
  const ctrl = new AbortController();
  let timer = 0;
  let stalled = false;

  const onExternalAbort = () => {
    if (!ctrl.signal.aborted) ctrl.abort(externalSignal.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const arm = () => {
    if (ctrl.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort(new DOMException(`网络 ${stallMs}ms 无进度（判为卡死）`, 'AbortError'));
    }, stallMs);
  };
  arm(); // 立即上膛：首字节超时也受保护

  /** 主动中止本次尝试（**不**置 stalled）：供早期吞吐探针判慢后立刻断开慢源。 */
  const cancel = (reason) => {
    if (!ctrl.signal.aborted) ctrl.abort(reason);
  };

  const dispose = () => {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  };

  return {
    signal: ctrl.signal,
    arm,
    cancel,
    dispose,
    get stalled() {
      return stalled;
    },
  };
}

/** 早期吞吐探针默认参数：前 4 秒平均 < 100KB/s 判为「太慢」→ 换下一个来源。 */
export const PROBE_WINDOW_MS = 4000;
export const PROBE_MIN_BPS = 100 * 1024;

/**
 * 早期吞吐探针 —— 三段式下载里「第一跳」的专属保险丝。
 *
 * 卡死看门狗只能防「完全不动」，防不了「慢速蠕动」（一直有字节就永不触发）。
 * 探针解决的正是这个：**只挂在第一跳（同源）**，从尝试开始计时，
 * 窗口期满时算平均吞吐 —— 不达标就立刻断开本次连接、换下一个来源
 * （镜像/同源兜底），不让用户在慢源上干耗。
 *
 * 关键约束：
 * - 只用于**还有备选**的候选（单源列表不挂探针，否则慢而能用会被判死）；
 * - 窗口未满就下完的文件（小文件）永远不会被判定 —— 下完即成功；
 * - 判慢抛 `ProbeSlowError`（≠ AbortError），调用方据此「换源」而非「上抛中止」。
 *
 * @param {{ms?: number, minBps?: number, onCancel?: (e: Error) => void}} [opts]
 *   `onCancel` 在判慢时先于 throw 调用，用于中止底层连接（看门狗的 `cancel`）。
 * @returns {{tick: (n: number) => void}} 每收到 n 字节调用一次
 */
export function createThroughputProbe({ ms = PROBE_WINDOW_MS, minBps = PROBE_MIN_BPS, onCancel } = {}) {
  const start = Date.now();
  let bytes = 0;
  let decided = false;
  return {
    tick(n) {
      if (decided) return;
      bytes += n;
      const el = Date.now() - start;
      if (el < ms) return;
      decided = true;
      const bps = (bytes * 1000) / el;
      if (bps < minBps) {
        const e = new Error(
          `早期吞吐 ${Math.round(bps / 1024)}KB/s < ${Math.round(minBps / 1024)}KB/s（前 ${ms}ms 判定，换源）`,
        );
        e.name = 'ProbeSlowError';
        onCancel?.(e); // 立刻断开慢源连接，不浪费带宽
        throw e;
      }
    },
  };
}

/**
 * 按分块计划顺序拉取全部分片并拼装成完整二进制。
 * 进度按「已收字节 / 总字节」上报，与整文件下载的 onProgress 语义一致。
 *
 * 分片正文按流读取：每收到一块就回调 `onBytes`（卡死看门狗靠它续期），
 * 同时也把进度细化到字节级（而不是一片一跳）。
 * `probe`（若传入）在每块后 tick —— 只在「还没收满整个文件」时判定，
 * 收满即成功，绝不把已完成的下载判死。
 *
 * @param {ChunkPlan} plan
 * @param {{signal?: AbortSignal, onProgress?: (p: number) => void, onBytes?: () => void,
 *          probe?: {tick: (n: number) => void}}} [opts]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchChunked(plan, opts = {}) {
  const { signal, onProgress, onBytes, probe } = opts;
  const partBytes = Array.isArray(plan.partBytes) ? plan.partBytes : [];
  const total = plan.bytes || partBytes.reduce((s, n) => s + (n || 0), 0);
  if (!total) throw new Error('分块计划缺少字节数（asset-chunks.json 损坏？）');

  /** @type {Uint8Array[]} */
  const bufs = [];
  let received = 0;
  for (let i = 0; i < plan.parts.length; i++) {
    if (signal?.aborted) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
    const res = await fetch(plan.parts[i], { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${plan.parts[i]}`);
    assertBinaryResponse(res, plan.parts[i]);
    onBytes?.(); // 响应头到达也算进度

    let part;
    if (!res.body) {
      part = new Uint8Array(await res.arrayBuffer());
      onBytes?.();
    } else {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onBytes?.();
        // 还没收满整个文件才做吞吐判定（收满 = 成功，不判死）
        if (received + got < total) probe?.tick(value.length);
      }
      part = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) {
        part.set(c, off);
        off += c.length;
      }
    }
    bufs.push(part);
    received += part.length;
    // min(0.99…)：与整文件路径一致，留 1% 给「写缓存」收尾
    onProgress?.(Math.min(0.99, received / total));
  }

  if (received !== total) {
    // 字节数不符：仍按实际收到的拼装（宁可让下游模型加载报错，也不静默截断）
    console.warn(`[asset-chunks] 字节数不符：期望 ${total}，实际 ${received}`);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  onProgress?.(1);
  return out.buffer;
}
