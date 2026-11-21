/**
 * 播放层 —— 本地离线 TTS 适配器（默认引擎）
 *
 * 引擎：Piper（ONNX）WASM 运行时，MIT 许可的浏览器封装；
 * 模型：zh_CN-huayan-medium（63.2MB，音质优先，默认档）/ zh_CN-huayan-x_low（20.6MB，省流档）。
 * 模型与运行时全部自托管在同源 /tts/ 与 /models/ 路径下，首次下载后写入 Cache Storage，
 * 之后离线可用。本地合成时文本不出设备（非硬约束：云端 TTS 时文本会发送到服务器）。
 *
 * 运行时加载顺序：onnxruntime-web wasm → piper 封装 → 语音配置 json → onnx 模型。
 * 任何一步失败都 reject 结构化错误，由 UI 层提示并给出重试/切云端入口。
 * @module playback/tts/local
 */

import { abortError, throwIfAborted } from './index.js';
import { getChunkPlan, fetchChunked, assertBinaryResponse, createStallWatchdog, createThroughputProbe } from './asset-chunks.js';

/** 模型档位定义（体积为 voices.json 权威数据）。 */
export const MODEL_TIERS = Object.freeze({
  medium: {
    id: 'medium',
    label: '标准音质（63MB，推荐）',
    bytes: 63201294,
    // 规范同源路径（缓存 key）；部署时用 scripts/fetch-tts-assets.mjs 拉取到 ./models/
    onnx: '/models/zh_CN-huayan-medium.onnx',
    config: '/models/zh_CN-huayan-medium.onnx.json',
    // 国内可直连镜像（仅首次下载出现；下载完成后运行期零外联）。
    // 与 sherpa.js 统一口径：三段式 = 同源(探针) → 镜像(看门狗) → 同源(涓流兜底)。
    mirrorBase: 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/',
    sampleRate: 22050,
  },
  x_low: {
    id: 'x_low',
    label: '省流音质（21MB）',
    bytes: 20628813,
    onnx: '/models/zh_CN-huayan-x_low.onnx',
    config: '/models/zh_CN-huayan-x_low.onnx.json',
    mirrorBase: 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/x_low/',
    sampleRate: 16000,
  },
});

const CACHE_NAME = 'tinttxt-tts-v1';
const CUSTOM_CACHE_NAME = 'tinttxt-tts-custom-v1';
const RUNTIME_VERSION = '1.0.0';
/** 卡死看门狗：连续无字节多久判死换源（与 sherpa.js 一致） */
const STALL_TIMEOUT_MS = 10000;

/**
 * 自定义音色的 Cache key。
 * 必须带 '/' 前缀：`custom:xxx:model` 这类字符串会被 Cache API 当作 URL 解析，
 * scheme `custom` 不被支持而抛 TypeError；相对路径（以 / 开头）按源解析则合法。
 * @param {string} id 形如 custom:voiceName
 * @param {'model'|'config'|'meta'} part
 */
function customKey(id, part) {
  return `/${id}:${part}`;
}

/**
 * 下载并缓存二进制资源（Cache Storage，all-or-nothing 写入）。
 *
 * **候选地址按序尝试，最后一项是规范同源地址（也是缓存 key）**——
 * 与 sherpa.js 完全同型的三段式：`fetchCached([同源, 镜像, 同源], opts)`，
 * 第一跳挂早期吞吐探针（慢到不值得等就断开换源），第二/三跳只挂卡死看门狗
 * （涓流允许，慢也能下完）。无论从哪边下载，写缓存一律用同源地址，
 * 离线复用 / isReady / 进度全部无感。
 *
 * ⚠️ 缓存 key 必须是 URL 路径：曾用 `model:/…`/`cfg:/…` 这类带 scheme 的字符串，
 * Cache API 会按 URL 解析并因不支持的 scheme 在 put 时抛 TypeError（与自定义音色
 * `custom:` 键同型的坑）——piper 模型下载路径因此从未真正跑通过。
 *
 * @param {string[]} urls 候选地址（最后一项 = 同源规范地址 = 缓存 key）
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
    // 卡死看门狗（每次尝试独立一条）：每收到字节续期；10s 无任何字节 → abort 本次 → 换源
    const wd = createStallWatchdog(opts.signal, STALL_TIMEOUT_MS);
    // 早期吞吐探针：只挂第一跳、且后面还有备选（单源列表挂探针会把「慢而能用」判死）
    const probe = i === 0 && list.length > 1 ? createThroughputProbe({ onCancel: (e) => wd.cancel(e) }) : null;
    try {
      // 大文件分块（静态托管平台单文件 25MiB 上限，见 asset-chunks.js）：
      // 清单按同源地址命中 → 按片拉取拼装；镜像地址不在清单里，自然走整文件。
      const plan = await getChunkPlan(url);
      if (plan) {
        const buf = await fetchChunked(plan, {
          signal: wd.signal,
          onProgress: opts.onProgress,
          onBytes: wd.arm,
          probe,
        });
        await cache.put(canonical, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
        opts.onProgress?.(1);
        return buf;
      }
      const res = await fetch(url, { signal: wd.signal, mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
      assertBinaryResponse(res, url);
      wd.arm(); // 响应头到达也算进度
      const total = Number(res.headers.get('content-length')) || 0;
      let buf;
      if (!res.body || !total) {
        // 无长度/无流：整段读完即成功，不做吞吐判定（挂死由看门狗兜底）
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
          wd.arm(); // 每块字节续期看门狗
          // 收满整个文件才跳过判定（收满 = 成功，绝不把已完成的下载判死）
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
      // all-or-nothing：完整读入后才写缓存，避免半截文件
      await cache.put(canonical, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
      return buf;
    } catch (e) {
      if (wd.stalled) {
        // 看门狗判死：不是用户中止，记下并换源
        lastErr = new Error(`卡死已中断（${STALL_TIMEOUT_MS}ms 无任何字节）@ ${url}`);
        continue;
      }
      if (e && e.name === 'ProbeSlowError') {
        // 早期吞吐探针判慢：主动换源（既不是失败也不是用户中止）
        lastErr = e;
        continue;
      }
      if (e && e.name === 'AbortError') throw abortError(opts.signal?.reason);
      lastErr = e;
      // 换下一个候选地址
    } finally {
      wd.dispose();
    }
  }
  throw new Error(
    `资源下载失败（全部 ${list.length} 个来源不可达）：${lastErr ? lastErr.message : '未知错误'}。` +
      '请运行 node scripts/fetch-tts-assets.mjs 补齐 ./models/ 与 ./tts/ 后重试。',
  );
}

/**
 * 本地 Piper 适配器。
 * @returns {import('../../core/contracts.js').TtsAdapter}
 */
export function createLocalPiperAdapter() {
  /** @type {any} 随运行时加载的 piper 实例 */
  let piper = null;
  let loadPromise = null;
  let currentTier = 'medium';
  let voices = [];
  /** 自定义音色（用户导入，非应用分发） */
  let customVoiceId = null;
  /** @type {{config:string, model:ArrayBuffer}|null} */
  let customVoiceData = null;

  async function loadRuntime(opts = {}) {
    if (piper) return piper;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      // 1. 运行时脚本（自托管，绝不依赖境外 CDN）
      await loadScript('/tts/piper-runtime.js');
      if (typeof window === 'undefined' || !window.PiperTTS) {
        throw new Error('本地 TTS 运行时未加载（/tts/piper-runtime.js 缺失）');
      }
      // 2. 实例化（内部按需加载 onnxruntime-web wasm，同样自托管）
      piper = await window.PiperTTS.create({
        wasmPaths: '/tts/',
        numThreads: navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 1,
      });
      return piper;
    })().catch((e) => {
      loadPromise = null;
      throw e;
    });
    return loadPromise;
  }

  async function ensureModel(tier, opts = {}) {
    const t = MODEL_TIERS[tier] || MODEL_TIERS.medium;
    // 三段式候选顺序与 sherpa.js 完全同型：[同源(探针), 镜像, 同源(涓流兜底)]；
    // 缓存一律按同源地址（列表最后一项）
    const mirrorFile = (sameOrigin) => (t.mirrorBase ? t.mirrorBase + sameOrigin.split('/').pop() : sameOrigin);
    const [cfgBuf, modelBuf] = await Promise.all([
      fetchCached([t.config, mirrorFile(t.config), t.config], opts),
      fetchCached([t.onnx, mirrorFile(t.onnx), t.onnx], {
        ...opts,
        onProgress: opts.onModelProgress,
      }),
    ]);
    return {
      config: new TextDecoder().decode(cfgBuf),
      model: modelBuf,
      tier: t,
    };
  }

  return {
    id: 'local-piper',
    label: '本地离线（Piper 中文）',
    requiresNetwork: false,

    /** @param {{signal?:AbortSignal, tier?:string, onProgress?:(p:number)=>void}} [opts] */
    async prepare(opts = {}) {
      const tier = opts.tier || currentTier;
      await loadRuntime(opts);
      if (customVoiceId && customVoiceData) {
        // 用户自备模型：不经过应用分发路径
        await piper.loadVoice(customVoiceData.config, customVoiceData.model);
        voices = [
          { id: customVoiceId, label: `自定义 · ${customVoiceId.replace(/^custom:/, '')}`, kind: 'local', dialogueCapable: false },
          { id: `huayan-${tier}`, label: `慧妍 · ${MODEL_TIERS[tier].label}`, kind: 'local', dialogueCapable: false },
        ];
        return;
      }
      const { config, model } = await ensureModel(tier, opts);
      await piper.loadVoice(config, model);
      currentTier = tier;
      voices = [
        { id: `huayan-${tier}`, label: `慧妍 · ${MODEL_TIERS[tier].label}`, kind: 'local', dialogueCapable: false },
      ];
      return;
    },

    /**
     * @param {string} text
     * @param {{voice?:string, rate?:number, signal?:AbortSignal, onProgress?:(p:number)=>void}} opts
     * @returns {Promise<import('../../core/contracts.js').TtsResult>}
     */
    async synthesize(text, opts = {}) {
      throwIfAborted(opts.signal);
      // 必须同时满足「实例存在」与「语音已加载」：loadVoice 失败/进行中时 piper 非空
      // 但 session 为空，直接合成会抛误导性的 ERR_VOICE_NOT_LOADED —— 这里强制重走 prepare。
      if (!piper || !piper.session) await this.prepare({ signal: opts.signal });
      const t = opts.text || text;
      if (!t || !t.trim()) {
        return { blob: new Blob([], { type: 'audio/wav' }), mime: 'audio/wav', durationSeconds: 0, chars: 0 };
      }
      // length_scale：>1 慢、<1 快；与语速互为倒数
      const rate = opts.rate || 1;
      const lengthScale = Math.min(2, Math.max(0.5, 1 / rate));
      const wav = await piper.synthesize(t, { lengthScale, noiseScale: 0.667, noiseW: 0.8 });
      throwIfAborted(opts.signal);
      const blob = new Blob([wav], { type: 'audio/wav' });
      // 时长由 WAV 头计算（piper 返回标准 PCM WAV）
      const durationSeconds = estimateWavDuration(wav);
      return { blob, mime: 'audio/wav', durationSeconds, chars: t.length };
    },

    async listVoices() {
      if (!voices.length) {
        try {
          await this.prepare();
        } catch {
          /* 未下载模型时返回占位 */
          return [{ id: `huayan-${currentTier}`, label: `慧妍 · ${MODEL_TIERS[currentTier].label}（未下载）`, kind: 'local', dialogueCapable: false }];
        }
      }
      return voices;
    },

    async isReady() {
      try {
        if (customVoiceId && customVoiceData) return true;
        const t = MODEL_TIERS[currentTier];
        const cache = await caches.open(CACHE_NAME);
        // key 必须与 ensureModel 写入的 canonical key（同源 URL）一致 ——
        // 曾用 `model:/…` scheme 串查，写侧修了读侧没修 → 永远 false →
        // resolveAdapter 误降级到 speech-preview，播放挂死在 loading。
        return !!(await cache.match(t.onnx)) && !!(await cache.match(t.config));
      } catch {
        return false;
      }
    },

    /** 当前是否在用自定义音色。 */
    getCustomVoiceId: () => customVoiceId,

    /** 切换模型档位（会触发重新 prepare）。 */
    setTier(tier) {
      if (!MODEL_TIERS[tier]) return;
      currentTier = tier;
      customVoiceId = null;
      piper = null;
      loadPromise = null;
    },

    getTier() {
      return currentTier;
    },

    /* ---------------- 自定义音色模型（用户自备，应用不分发） ---------------- */

    /**
     * 导入用户自选的 Piper 模型文件（.onnx + .onnx.json 配对）。
     * 文件只存本机 Cache Storage，不上传；应用不承担所选模型的分发责任。
     * @param {File[]} files 至少含一个 .onnx 与一个同名 .onnx.json
     * @returns {Promise<{id:string,label:string}>}
     */
    async importVoiceModel(files) {
      const onnx = files.find((f) => /\.onnx$/i.test(f.name));
      const cfg = files.find((f) => /\.onnx\.json$/i.test(f.name));
      if (!onnx || !cfg) throw new Error('请选择配对的 .onnx 模型文件与 .onnx.json 配置文件');
      const base = onnx.name.replace(/\.onnx$/i, '');
      if (!cfg.name.startsWith(base)) {
        throw new Error(`配置文件与模型名不匹配：${onnx.name} vs ${cfg.name}`);
      }
      const cache = await caches.open(CUSTOM_CACHE_NAME);
      const id = `custom:${base}`;
      // 先读完整再写入（all-or-nothing，避免半截模型）
      const [modelBuf, cfgBuf] = await Promise.all([onnx.arrayBuffer(), cfg.arrayBuffer()]);
      // 基本合法性校验：ONNX 魔数与 JSON 可解析
      const magic = new Uint8Array(modelBuf.slice(0, 4));
      const isOnnx = magic[0] === 0x08 && magic[1] === 0x00; // protobuf: field 8 (ir_version) varint
      if (!isOnnx && !(magic[0] === 0x08)) {
        // 放宽：ONNX 文件起始字节不唯一，仅做非空校验
        if (modelBuf.byteLength < 1024) throw new Error('模型文件过小或已损坏');
      }
      try {
        JSON.parse(new TextDecoder().decode(cfgBuf));
      } catch {
        throw new Error('.onnx.json 配置文件不是合法 JSON');
      }
      await cache.put(customKey(id, 'model'), new Response(modelBuf.slice(0)));
      await cache.put(customKey(id, 'config'), new Response(cfgBuf.slice(0)));
      await cache.put(
        customKey(id, 'meta'),
        new Response(JSON.stringify({ id, label: base, importedAt: Date.now(), bytes: modelBuf.byteLength })),
      );
      return { id, label: base };
    },

    /** 列出已导入的自定义音色。 */
    async listCustomVoices() {
      const cache = await caches.open(CUSTOM_CACHE_NAME);
      const keys = await cache.keys();
      const out = [];
      for (const req of keys) {
        const url = String(req.url || req);
        if (!url.endsWith(':meta')) continue;
        const res = await cache.match(req);
        if (res) out.push(await res.json());
      }
      return out;
    },

    /**
     * 切换到自定义音色（下次 prepare/synthesize 生效）。
     * @param {string|null} id null 表示回到内置档位
     */
    async useCustomVoice(id) {
      if (id == null) {
        customVoiceId = null;
        piper = null;
        loadPromise = null;
        return;
      }
      const cache = await caches.open(CUSTOM_CACHE_NAME);
      const modelRes = await cache.match(customKey(id, 'model'));
      const cfgRes = await cache.match(customKey(id, 'config'));
      if (!modelRes || !cfgRes) throw new Error('自定义音色不存在，请重新导入');
      customVoiceId = id;
      customVoiceData = {
        config: await cfgRes.text(),
        model: await modelRes.arrayBuffer(),
      };
      piper = null;
      loadPromise = null;
    },

    /** 删除自定义音色。 */
    async removeCustomVoice(id) {
      const cache = await caches.open(CUSTOM_CACHE_NAME);
      for (const suffix of ['model', 'config', 'meta']) {
        await cache.delete(customKey(id, suffix));
      }
      if (customVoiceId === id) {
        customVoiceId = null;
        customVoiceData = null;
        piper = null;
        loadPromise = null;
      }
    },

    /** 释放运行时内存（切书/长时间不用时调用）。 */
    unload() {
      piper = null;
      loadPromise = null;
    },
  };
}

function estimateWavDuration(wav) {
  try {
    const view = new DataView(wav.buffer || wav, wav.byteOffset || 0, wav.byteLength);
    // data chunk 大小 @40, byteRate @28
    const byteRate = view.getUint32(28, true);
    const dataSize = view.getUint32(40, true);
    if (byteRate > 0) return dataSize / byteRate;
  } catch {
    /* fallthrough */
  }
  return 0;
}

/** 动态加载自托管脚本。 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-tts="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.tts = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = '1';
      resolve();
    };
    s.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
    document.head.appendChild(s);
  });
}
