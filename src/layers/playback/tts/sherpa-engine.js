/**
 * 播放层 —— sherpa-onnx 引擎（在 Web Worker 内运行，页面主线程零阻塞）
 *
 * 从 sherpa.js 拆出的「重活」：模型/运行时下载（Cache Storage + 分块 + 三段式镜像）、
 * Emscripten 运行时装载、OfflineTts 实例管理、合成与 WAV 编码。
 *
 * Worker 化要点（为什么这样写）：
 * - 本文件**零 DOM 依赖**：不用 window/document；胶水脚本用 `fetch + new Function`
 *   执行（`new Function` 让无论源码是否 'use strict'，其声明都在函数作用域内可见；
 *   胶水头部 `var Module = typeof Module != "undefined" ? Module : {}` 与形参
 *   `Module` 同绑定，因此把预构造的 Module 作为形参注入即可拿到我们的配置）。
 * - 合成同步阻塞的是 **Worker 线程**：主线程的点击/滚动永远流畅（根治「死机感」）。
 * - 进度/日志经 hooks 上报，由 sherpa-worker.js 转 postMessage 给主线程。
 *
 * @module playback/tts/sherpa-engine
 */
import { abortError, throwIfAborted } from './index.js';
import {
  getChunkPlan,
  fetchChunked,
  assertBinaryResponse,
  createStallWatchdog,
  createThroughputProbe,
} from './asset-chunks.js';

/** 模型档位（与 scripts/fetch-sherpa-assets.mjs --tier 一一对应）。 */
export const SHERPA_TIERS = Object.freeze({
  int8: {
    id: 'int8',
    label: 'int8 量化（39MB，推荐）',
    file: 'vits-aishell3.int8.onnx',
    bytes: 39870124,
  },
  full: {
    id: 'full',
    label: '全精度（121MB）',
    file: 'vits-aishell3.onnx',
    bytes: 121383104,
  },
});

export const CACHE_NAME = 'tinttxt-tts-sherpa-v1';
export const RUNTIME_BASE = '/tts/sherpa/';
export const MODEL_BASE = '/models/sherpa-zh/';
/** 运行时 JS（经 Cache Storage 预热，供 isReady 判定与离线复用）。 */
export const RUNTIME_JS = ['sherpa-onnx-wasm-main-tts.js', 'sherpa-onnx-tts.js'];
/** 运行时 wasm 文件名（镜像与同源同名）。 */
export const WASM_FILE = 'sherpa-onnx-wasm-main-tts.wasm';
/** 单次合成的分块上限（词边界优先切分）。 */
export const CHUNK_LIMIT = 200;
/** Emscripten 初始化超时（模型已在同源就位，正常几秒内完成）。 */
export const INIT_TIMEOUT_MS = 120000;
/** 卡死看门狗：连续 N 毫秒收不到任何字节 → 中止本次尝试、换下一个来源。 */
const STALL_TIMEOUT_MS = 10000;

/**
 * 国内可直连镜像（hf-mirror.com = HuggingFace 国内中转）。
 * 下载策略为**三段式**：① 同源（4s 吞吐探针）→ ② 镜像（仅卡死看门狗，允许涓流）
 * → ③ 同源涓流兜底。详见 asset-chunks.js。
 * ⚠️ 只镜像「逐字节下载」的文件：运行时两个 JS 打过 noPreload 补丁，不走镜像。
 */
const MODEL_MIRROR = 'https://hf-mirror.com/csukuangfj/vits-zh-aishell3/resolve/main/';
const WASM_MIRROR = 'https://hf-mirror.com/spaces/k2-fsa/web-assembly-zh-en-tts-zipvoice/resolve/main/';

/** 结构化错误：带 code，跨 postMessage 传输后由 sherpa.js 重建。 */
function err(code, message, cause) {
  const e = new Error(`[${code}] ${message}`);
  e.name = 'SherpaTTSError';
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/**
 * 需要写进 Emscripten 虚拟 FS 的文件（fsName → {url, mirror, bytes}）。
 * 页面侧 isReady 也用它核对缓存（sherpa.js 导入）。
 * @param {string} tier
 */
export function fsManifest(tier) {
  const t = SHERPA_TIERS[tier] || SHERPA_TIERS.int8;
  const m = (name) => MODEL_MIRROR + name;
  return [
    { fs: 'model.onnx', url: MODEL_BASE + t.file, mirror: m(t.file), bytes: t.bytes },
    { fs: 'lexicon.txt', url: MODEL_BASE + 'lexicon.txt', mirror: m('lexicon.txt'), bytes: 2042943 },
    { fs: 'tokens.txt', url: MODEL_BASE + 'tokens.txt', mirror: m('tokens.txt'), bytes: 1671 },
    { fs: 'phone.fst', url: MODEL_BASE + 'phone.fst', mirror: m('phone.fst'), bytes: 88630 },
    { fs: 'date.fst', url: MODEL_BASE + 'date.fst', mirror: m('date.fst'), bytes: 59154 },
    { fs: 'number.fst', url: MODEL_BASE + 'number.fst', mirror: m('number.fst'), bytes: 64482 },
  ];
}

/**
 * 下载并缓存二进制资源（Cache Storage，all-or-nothing）。
 * 候选地址按序尝试，最后一项是规范同源地址（也是缓存 key）：
 * `fetchCached([同源, 镜像, 同源], opts)`；第一跳挂早期吞吐探针，其后仅卡死看门狗。
 * @param {string|string[]} urls
 * @param {{signal?: AbortSignal, onProgress?: (p:number)=>void}} [opts]
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchCached(urls, opts = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  const canonical = list[list.length - 1];
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(canonical);
  if (hit) {
    opts.onProgress?.(1);
    return hit.arrayBuffer();
  }
  throwIfAborted(opts.signal);
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    throwIfAborted(opts.signal);
    const wd = createStallWatchdog(opts.signal, STALL_TIMEOUT_MS);
    const probe = i === 0 && list.length > 1 ? createThroughputProbe({ onCancel: (e) => wd.cancel(e) }) : null;
    try {
      const plan = await getChunkPlan(url);
      if (plan) {
        const buf = await fetchChunked(plan, { signal: wd.signal, onProgress: opts.onProgress, onBytes: wd.arm, probe });
        await cache.put(canonical, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
        opts.onProgress?.(1);
        return buf;
      }
      const res = await fetch(url, { signal: wd.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
      assertBinaryResponse(res, url);
      wd.arm();
      const total = Number(res.headers.get('content-length')) || 0;
      let buf;
      if (!res.body || !total) {
        buf = await res.arrayBuffer();
        opts.onProgress?.(1);
      } else {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          wd.arm();
          if (received < total) probe?.tick(value.length);
          opts.onProgress?.(Math.min(0.99, received / total));
        }
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        buf = merged.buffer;
        opts.onProgress?.(1);
      }
      await cache.put(canonical, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
      return buf;
    } catch (e) {
      if (wd.stalled) {
        lastErr = new Error(`卡死已中断（${STALL_TIMEOUT_MS}ms 无任何字节）@ ${url}`);
        continue;
      }
      if (e && e.name === 'ProbeSlowError') {
        lastErr = e;
        continue;
      }
      if (e && e.name === 'AbortError') throw abortError(opts.signal?.reason);
      lastErr = e;
    } finally {
      wd.dispose();
    }
  }
  throw err(
    'SHERPA_ASSET_FETCH_FAILED',
    `资源下载失败（全部来源不可达，共 ${list.length} 个）：${(lastErr && lastErr.message) || lastErr}。` +
      '可运行 node scripts/fetch-sherpa-assets.mjs 补齐本地 tts/sherpa/ 与 models/sherpa-zh/，或检查网络后重试。',
    lastErr,
  );
}

/** 让出一个事件循环（Worker 内仍需要：处理排队中的 cancel 消息）。 */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 把文本切成适合单次推理的块（优先标点，兜底硬切）。
 * @param {string} text @param {number} max
 * @returns {string[]}
 */
function splitChunks(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const parts = t.match(/[^。！？!?；;，,、]+[。！？!?；;，,、]*\s*/g) || [t];
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + p).length > max) {
      chunks.push(cur);
      cur = '';
    }
    if (p.length > max) {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max));
      continue;
    }
    cur += p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/**
 * voice id → 说话人 sid（aishell3 多说话人）：
 *   'aishell3-int8' / null → 0；'aishell3-int8-s3' → 3
 */
function sidFromVoice(voice) {
  if (typeof voice !== 'string' || !voice) return 0;
  const m = voice.match(/-s(\d{1,3})$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.min(173, Math.max(0, n)) : 0;
}

/**
 * 把 Float32 PCM 编码成 16-bit 单声道 WAV（RIFF/PCM，44 字节头）。
 * @param {Float32Array} samples @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    off += 2;
  }
  return buf;
}

/**
 * 创建 sherpa 引擎（仅在 Worker 内调用）。
 * @param {{onProgress?:(p:number)=>void, onLog?:(level:string, text:string)=>void}} [hooks]
 */
export function createEngine(hooks = {}) {
  /** @type {any} OfflineTts 实例 */
  let tts = null;
  /**
   * Emscripten Module 状态（Worker 内只创建一次：胶水以形参方式拿到本对象，
   * 重复执行胶水不会再生效，所以重试只补执行尚未成功的那一步）。
   * @type {{module:any, ready:Promise<any>, resolveReady:Function, ok:boolean, failure:Error|null}|null}
   */
  let moduleState = null;
  const scriptsLoaded = { emscripten: false, glue: false };
  let loadPromise = null;
  let currentTier = 'int8';
  let instanceTier = null;
  let instanceSid = 0;
  /** 预取好的 wasm 字节（镜像优先下载；instantiateWasm 钩子直接用它实例化）。 */
  let wasmBytes = null;
  /** 执行 wrapper 脚本后拿到的 createOfflineTts（Worker 内没有 window）。 */
  let createOfflineTtsFn = null;

  /**
   * 拉取运行时脚本文本并以函数作用域执行。
   * 用 `new Function` 而非 importScripts（模块 Worker 无 importScripts），
   * 且无论源码是否含 'use strict'，其顶层声明都对同一函数体尾部可见。
   * @param {string} url @param {'glue'|'wrapper'} kind
   */
  async function evalRuntimeScript(url, kind) {
    const res = await fetch(url);
    if (!res.ok) {
      throw err('SHERPA_RUNTIME_SCRIPT_MISSING', `运行时脚本加载失败: HTTP ${res.status} @ ${url}`);
    }
    const src = await res.text();
    try {
      if (kind === 'glue') {
        // 胶水头部：`var Module = typeof Module != "undefined" ? Module : {}` ——
        // var 形参与参数同绑定 → 取到我们注入的预构造 Module（locateFile/instantiateWasm…）。
        new Function('Module', src)(moduleState.module);
      } else {
        createOfflineTtsFn = new Function(
          `${src}\n;return typeof createOfflineTts === 'function' ? createOfflineTts : null;`,
        )();
        if (typeof createOfflineTtsFn !== 'function') {
          throw new Error('createOfflineTts 未定义');
        }
      }
    } catch (e) {
      throw err('SHERPA_RUNTIME_SCRIPT_MISSING', `运行时脚本执行失败: ${url} — ${(e && e.message) || e}`, e);
    }
  }

  /**
   * 构造 Emscripten Module（必须先于胶水执行）。
   * `ready` 只在成功时 resolve、永不 reject —— 超时/中止由 awaitRuntime 竞速决定。
   * @param {{onProgress?:(p:number)=>void}} opts
   */
  function createModule(opts) {
    const state = {
      module: null,
      ready: null,
      resolveReady: null,
      ok: false,
      failure: null,
    };
    state.ready = new Promise((resolve) => {
      state.resolveReady = resolve;
    });
    state.ready.catch(() => {});

    state.module = {
      locateFile: (p) => RUNTIME_BASE + p,
      // 上游 --preload-file 生成的 .data 不分发：给空包让 Emscripten 走
      // getPreloadedPackage 分支不再发网络请求；模型稍后由 FS_createDataFile 写入。
      getPreloadedPackage: () => new ArrayBuffer(0),
      // wasm 已由本引擎预取（镜像优先），instantiateWasm 直接用预取字节实例化：
      // 13.5MB 的下载既不占初始化超时窗口，也不在任何线程上阻塞页面。
      instantiateWasm: (imports, receiveInstance) => {
        if (!wasmBytes) {
          state.module.onAbort?.('wasm 字节未预取（instantiateWasm 提前触发）');
          return {};
        }
        WebAssembly.instantiate(wasmBytes, imports)
          .then((r) => receiveInstance(r.instance, r.module))
          .catch((e) => state.module.onAbort?.(`wasm 实例化失败：${(e && e.message) || e}`));
        return {};
      },
      setStatus: (s) => {
        if (typeof s === 'string' && /Running/i.test(s)) hooks.onProgress?.(0.97);
      },
      print: (m) => hooks.onLog?.('log', String(m)),
      printErr: (m) => hooks.onLog?.('warn', String(m)),
      onRuntimeInitialized: () => {
        state.ok = true;
        state.resolveReady(state.module);
      },
      onAbort: (m) => {
        if (!state.ok) {
          state.failure = err('SHERPA_WASM_ABORT', `wasm 初始化失败：${m}（请刷新页面后重试）`);
          state.resolveReady(null);
        }
      },
    };
    return state;
  }

  /**
   * 等待 wasm 实例化完成（超时/中止只影响本次调用，不销毁仍在推进的初始化）。
   * @param {{ready:Promise<any>, ok:boolean, failure:Error|null}} state
   * @param {{signal?:AbortSignal}} opts
   */
  async function awaitRuntime(state, opts) {
    let timer = 0;
    let onAbort = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(err('SHERPA_WASM_TIMEOUT', `wasm 初始化超时（${INIT_TIMEOUT_MS}ms），请稍后重试`)),
        INIT_TIMEOUT_MS,
      );
    });
    const aborted = new Promise((_, reject) => {
      if (!opts.signal) return;
      onAbort = () => reject(abortError(opts.signal.reason));
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([state.ready, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
    throwIfAborted(opts.signal);
    if (state.failure) throw state.failure;
    if (!state.ok) throw err('SHERPA_WASM_TIMEOUT', 'wasm 初始化未完成，请稍后重试');
  }

  /**
   * 加载运行时（幂等；失败后重试只补没成功的那一步）。
   * @param {{signal?:AbortSignal, onProgress?:(p:number)=>void}} opts
   */
  async function loadRuntime(opts = {}) {
    if (tts) return tts;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      throwIfAborted(opts.signal);
      // 1) 同源拉运行时 JS（144KB 小文件；写入 Cache Storage 供离线复用）
      await Promise.all(
        RUNTIME_JS.map((f) =>
          fetchCached(RUNTIME_BASE + f, {
            signal: opts.signal,
            onProgress: opts.onProgress ? (p) => opts.onProgress(0.9 + p * 0.02) : undefined,
          }),
        ),
      );
      throwIfAborted(opts.signal);

      // 2) wasm 本体（13.5MB）：镜像优先预取，带进度（0.92→0.99）
      if (!wasmBytes) {
        wasmBytes = await fetchCached(
          [RUNTIME_BASE + WASM_FILE, WASM_MIRROR + WASM_FILE, RUNTIME_BASE + WASM_FILE],
          {
            signal: opts.signal,
            onProgress: opts.onProgress ? (p) => opts.onProgress(0.92 + p * 0.07) : undefined,
          },
        );
      }
      throwIfAborted(opts.signal);

      // 3) 执行胶水（形参注入 Module）+ OfflineTts 封装
      if (!moduleState) moduleState = createModule(opts);
      if (!scriptsLoaded.emscripten) {
        await evalRuntimeScript(RUNTIME_BASE + 'sherpa-onnx-wasm-main-tts.js', 'glue');
        scriptsLoaded.emscripten = true;
      }
      throwIfAborted(opts.signal);
      if (!scriptsLoaded.glue) {
        await evalRuntimeScript(RUNTIME_BASE + 'sherpa-onnx-tts.js', 'wrapper');
        scriptsLoaded.glue = true;
      }
      throwIfAborted(opts.signal);

      // 4) 等 wasm 实例化完成（字节已在本地，只剩编译 + 初始化，秒级）
      await awaitRuntime(moduleState, opts);

      opts.onProgress?.(0.99);
      return tts;
    })().catch((e) => {
      loadPromise = null;
      tts = null;
      throw e;
    });
    return loadPromise;
  }

  /**
   * 拉取模型资产到 Cache Storage（all-or-nothing）。
   * @param {string} tier
   * @param {{signal?:AbortSignal, onProgress?:(p:number)=>void}} opts
   */
  async function ensureAssets(tier, opts = {}) {
    const list = fsManifest(tier);
    const total = list.reduce((s, f) => s + f.bytes, 0);
    let completed = 0;
    const out = [];
    for (const f of list) {
      throwIfAborted(opts.signal);
      let fileDone = 0;
      const buf = await fetchCached(f.mirror ? [f.url, f.mirror, f.url] : f.url, {
        signal: opts.signal,
        onProgress: (p) => {
          const next = f.bytes * Math.min(1, Math.max(0, p));
          completed += next - fileDone;
          fileDone = next;
          opts.onProgress?.(Math.min(0.9, (completed / total) * 0.9));
        },
      });
      completed += f.bytes - fileDone;
      out.push({ ...f, buffer: buf });
    }
    opts.onProgress?.(0.9);
    return out;
  }

  /**
   * 把模型文件写进 Emscripten 虚拟 FS（幂等：已存在则先删再建）。
   * @param {any} mod
   * @param {{fs:string, buffer:ArrayBuffer}[]} files
   */
  function writeFilesToFs(mod, files) {
    if (!mod || typeof mod.FS_createDataFile !== 'function') {
      throw err('SHERPA_FS_UNAVAILABLE', '运行时未暴露 FS_createDataFile（胶水版本不匹配）');
    }
    for (const f of files) {
      const u8 = new Uint8Array(f.buffer);
      const path = '/' + f.fs;
      try {
        mod.FS_createDataFile('/', f.fs, u8, true, true, true);
      } catch (e) {
        try {
          if (typeof mod.FS_unlink !== 'function') throw e;
          mod.FS_unlink(path);
          mod.FS_createDataFile('/', f.fs, u8, true, true, true);
        } catch (e2) {
          const why = (e2 && (e2.message || e2.errno)) || e2;
          throw err('SHERPA_FS_WRITE_FAILED', `写入 ${path} 失败：${why}`, e2);
        }
      }
    }
  }

  /**
   * 创建 OfflineTts 实例。config 走 lexicon 前端，dataDir 置空。
   * @param {any} mod @param {string} tier @param {number} sid
   */
  function createInstance(mod, tier, sid) {
    const cfg = {
      offlineTtsModelConfig: {
        offlineTtsVitsModelConfig: {
          model: './model.onnx',
          lexicon: './lexicon.txt',
          tokens: './tokens.txt',
          dataDir: '',
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1.0,
        },
        // 本 wasm 构建未启用 -pthread，恒单线程 → 统一 1。
        numThreads: 1,
        debug: 0,
        provider: 'cpu',
      },
      ruleFsts: './phone.fst,./date.fst,./number.fst',
      ruleFars: '',
      maxNumSentences: 1,
    };

    let inst;
    try {
      inst = createOfflineTtsFn(mod, cfg);
    } catch (e) {
      throw err('SHERPA_INIT_FAILED', `TTS 实例创建失败：${(e && e.message) || e}`, e);
    }
    if (!inst || !inst.handle) {
      throw err('SHERPA_INIT_FAILED', 'TTS 实例创建失败（句柄为空），多半是模型文件缺失或损坏');
    }
    tts = inst;
    instanceTier = tier;
    instanceSid = sid;
    return inst;
  }

  /** 释放当前实例（不动 Module：胶水已执行，wasm 无法卸载）。 */
  function freeInstance() {
    if (tts) {
      try {
        tts.free();
      } catch {
        /* ignore */
      }
    }
    tts = null;
    loadPromise = null;
    instanceTier = null;
  }

  return {
    /**
     * 下载/初始化：模型与运行时同源自托管，首次拉取后写 Cache Storage。
     * @param {{signal?:AbortSignal, tier?:string, sid?:number, onProgress?:(p:number)=>void}} [opts]
     */
    async prepare(opts = {}) {
      const tier = opts.tier || currentTier;
      if (!SHERPA_TIERS[tier]) {
        throw err('SHERPA_UNKNOWN_TIER', `未知模型档位: ${tier}`);
      }
      throwIfAborted(opts.signal);

      const assets = await ensureAssets(tier, opts);
      throwIfAborted(opts.signal);

      await loadRuntime(opts);
      throwIfAborted(opts.signal);

      if (!tts || instanceTier !== tier) {
        if (!moduleState) {
          throw err('SHERPA_RUNTIME_INVALID', '运行时未初始化（Module 缺失）');
        }
        writeFilesToFs(moduleState.module, assets);
        createInstance(moduleState.module, tier, opts.sid != null ? opts.sid : instanceSid);
      }

      currentTier = tier;
      opts.onProgress?.(1);
      return undefined;
    },

    /**
     * 合成一段文本 → WAV 字节（由 Worker 移交给主线程组装 Blob）。
     * @param {string} text
     * @param {{voice?:string, rate?:number, signal?:AbortSignal, onProgress?:(p:number)=>void}} opts
     * @returns {Promise<{buffer:ArrayBuffer, durationSeconds:number, sampleRate:number}>}
     */
    async synthesize(text, opts = {}) {
      throwIfAborted(opts.signal);
      const t = String(text == null ? '' : text);
      if (!t.trim()) {
        return { buffer: new ArrayBuffer(0), durationSeconds: 0, sampleRate: 0 };
      }
      if (!tts) await this.prepare({ signal: opts.signal, onProgress: opts.onProgress });
      throwIfAborted(opts.signal);

      const rate = opts.rate || 1;
      const speed = Math.min(2, Math.max(0.5, rate));
      const chunks = splitChunks(t, CHUNK_LIMIT);
      const parts = [];
      let sampleRate = tts.sampleRate || 0;
      const sid = sidFromVoice(opts.voice);

      for (let i = 0; i < chunks.length; i++) {
        throwIfAborted(opts.signal);
        let audio;
        try {
          audio = tts.generate({ text: chunks[i], sid, speed });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          throw err('SHERPA_GENERATE_FAILED', `合成失败：${(e && e.message) || e}`, e);
        }
        throwIfAborted(opts.signal);
        if (audio && audio.sampleRate) sampleRate = audio.sampleRate;
        if (audio && audio.samples && audio.samples.length) parts.push(audio.samples);
        opts.onProgress?.(Math.min(0.99, (i + 1) / chunks.length));
        await yieldToEventLoop();
        throwIfAborted(opts.signal);
      }

      if (!parts.length || !sampleRate) {
        return { buffer: new ArrayBuffer(0), durationSeconds: 0, sampleRate: 0 };
      }

      let total = 0;
      for (const p of parts) total += p.length;
      const merged = new Float32Array(total);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }

      const wav = encodeWav(merged, sampleRate);
      return { buffer: wav, durationSeconds: merged.length / sampleRate, sampleRate };
    },

    setTier(tier) {
      if (!SHERPA_TIERS[tier] || tier === currentTier) return;
      currentTier = tier;
      freeInstance();
    },
    getTier() {
      return currentTier;
    },
    setSpeakerId(sid) {
      const n = Number(sid) || 0;
      if (n === instanceSid) return;
      instanceSid = n;
      freeInstance();
    },
    getSpeakerId() {
      return instanceSid;
    },
    unload() {
      freeInstance();
    },
  };
}
