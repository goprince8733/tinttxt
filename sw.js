/* eslint-disable no-restricted-globals */
/**
 * TintTXT Service Worker（PWA 渐进增强层）
 *
 * 设计要点：
 * 1. 版本化缓存：改 CACHE_VERSION 即整体换代；activate 删除旧版本缓存。
 * 2. 更新流程：install 不 skipWaiting（不打断正在播放的页面）；
 *    页面确认后发 {type:'SKIP_WAITING'} → 新 SW 立即接管 → activate 时
 *    向所有窗口 postMessage {type:'SW_UPDATED'} → scripts/sw-bridge.js 把它
 *    转发为 window 上的 CustomEvent('__SW_UPDATE__')（main.js 已监听该事件）。
 *    ⚠️ index.html 必须引入：<script src="/scripts/sw-bridge.js"></script>
 * 3. 断网可继续听：
 *    - 应用壳（index.html / src / styles / manifest / icons）与 TTS 运行时
 *      （/tts/、/models/）都在缓存策略覆盖内，离线可打开、可合成；
 *    - 已合成的音频以 Blob URL 形式交给 <audio>，Blob URL 不经过 SW，
 *      播放本身不依赖网络；SW 负责保证「打开应用 + 模型/运行时」离线可用。
 * 4. 多线程 WASM（onnxruntime-web）需要 SharedArrayBuffer，依赖
 *    COOP/COEP 响应头（见 server-headers.conf）；SW 不做任何降级决策，
 *    页面用 crossOriginIsolated 自行降级。
 *
 * 注意：SW 只是渐进增强。华为浏览器「添加到桌面」可能只生成网址快捷方式
 * （不走 manifest/SW），核心功能不得依赖本文件。
 */
'use strict';

const CACHE_VERSION = 'tinttxt-v1'; // 部署脚本每次会自动改写为构建号（见 scripts/deploy-cloudflare.mjs）
const PRECACHE = `tinttxt-precache-${CACHE_VERSION}`;
const RUNTIME = `tinttxt-runtime-${CACHE_VERSION}`;
const OFFLINE_URL = '/index.html';

/**
 * 应用壳显式预缓存列表（SW 内不能用 glob，src 下所有 js 已逐条列全；
 * 另外 install 时会解析 index.html 的 src/href 与 JS 模块 import 图做补全，
 * 新增文件无需手工维护，但此列表保证「已知核心文件」一定在列）。
 */
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/scripts/sw-bridge.js',
  // —— 应用入口 ——
  '/src/main.js',
  '/src/app.js',
  // —— core ——
  '/src/core/contracts.js',
  // —— layers/file ——
  '/src/layers/file/encoding.js',
  // —— layers/playback ——
  '/src/layers/playback/player.js',
  '/src/layers/playback/system.js',
  '/src/layers/playback/wav.js',
  // —— layers/playback/tts ——
  '/src/layers/playback/tts/asset-chunks.js',
  '/src/layers/playback/tts/audio-cache.js',
  '/src/layers/playback/tts/cloud.js',
  '/src/layers/playback/tts/index.js',
  '/src/layers/playback/tts/local.js',
  // sherpa Worker 化：worker/engine 不在 index.html 的模块图里，必须显式预缓存
  // （否则断网后点播放会因 Worker 文件404 而无法合成）
  '/src/layers/playback/tts/sherpa.js',
  '/src/layers/playback/tts/sherpa-engine.js',
  '/src/layers/playback/tts/sherpa-worker.js',
  '/src/layers/playback/tts/sherpa.js',
  // —— layers/storage ——
  '/src/layers/storage/index.js',
  // —— layers/structure ——
  '/src/layers/structure/chapters.js',
  '/src/layers/structure/normalize.js',
  '/src/layers/structure/sentences.js',
  // —— ui ——
  '/src/ui/dom.js',
  '/src/ui/modal.js',
  '/src/ui/toast.js',
  '/src/ui/router.js',
  '/src/ui/shelf.js',
  '/src/ui/reader.js',
  '/src/ui/mini.js',
  '/src/ui/settings.js',
  '/src/ui/marks.js',
  '/src/ui/diag.js',
  '/src/ui/onboarding.js',
  // —— 样式（缺失时 install 容错跳过；index.html 解析会补全实际文件，
  //    见 discoverFromHtml ——）——
  '/styles/base.css',
  '/styles/layout.css',
  '/styles/components.css',
  '/styles/views.css',
  // —— 图标 ——
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/favicon-32.png',
  '/icons/favicon.ico',
];

/** 是否为「更新安装」（已存在旧 SW）；仅更新时才广播 SW_UPDATED */
let isUpdateInstall = false;

// ---------------------------------------------------------------------------
// install：容错预缓存（单个 404 不导致安装失败）
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  isUpdateInstall = !!(self.registration && self.registration.active);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      const urls = new Set(PRECACHE_URLS);
      /** index.html 里发现的 JS 模块（作为模块图遍历的种子） */
      const seedJs = [];

      // 1) 解析 index.html：把同源 src/href 全部纳入（styles/ 具体文件名由此发现）
      try {
        const res = await fetch('/index.html', { cache: 'no-cache' });
        if (res.ok) {
          const html = await res.text();
          for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
            const u = normalizeLocalUrl(m[1]);
            if (u) {
              urls.add(u);
              if (/\.m?js$/.test(u)) seedJs.push(u);
            }
          }
        }
      } catch {
        /* index.html 尚未生成或网络瞬断：跳过，仍按显式列表预缓存 */
      }

      // 2) 逐个容错写入（显式列表里 404 的项不阻断安装）
      await Promise.all([...urls].map((u) => putIfFetchable(cache, u)));

      // 3) 沿 JS 模块 import 图递归补全（保证 src/ 下所有文件都被覆盖，
      //    包括未来新增的模块 —— 解析已缓存的 main.js 及其依赖）
      await precacheModuleGraph(cache, seedJs);
    })().catch((err) => {
      // 预缓存整体失败才中止安装（例如 SW 脚本本身加载异常）
      console.warn('[sw] install 预缓存失败：', err);
      throw err;
    })
  );
});

// ---------------------------------------------------------------------------
// activate：清理旧版本缓存 + claim + 广播更新
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PRECACHE, RUNTIME]);
      // 只清理 SW 自管的版本化缓存（旧版 precache/runtime）。
      // ⚠️ 绝不能按 `tinttxt-` 前缀全删：TTS 模型缓存 tinttxt-tts-sherpa-v1 /
      // tinttxt-tts-v1 / tinttxt-tts-custom-v1 也带该前缀，误删会导致
      // 「模型已下载」状态丢失与断网后无法朗读（验收项 6）。
      const swManagedPrefixes = ['tinttxt-precache-', 'tinttxt-runtime-'];
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => swManagedPrefixes.some((p) => n.startsWith(p)) && !keep.has(n))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
      // 只有「更新安装」才通知页面有新版本（首次安装不打扰）
      if (isUpdateInstall) {
        const list = await self.clients.matchAll({ type: 'window' });
        for (const client of list) client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// message：页面确认后激活等待中的新版本
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});

// ---------------------------------------------------------------------------
// fetch：按路径分策略
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // 跨域请求不拦截（pass-through）
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // 导航：network-first，失败回退缓存的应用壳（保证断网可打开）
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // 大文件（模型 / TTS 运行时）：cache-first，命中即返回，避免重复下载
  if (path.startsWith('/models/') || path.startsWith('/tts/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 应用静态资源：stale-while-revalidate（先回缓存，后台更新）
  if (path.startsWith('/src/') || path.startsWith('/styles/') || path.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 其余同源 GET：network-first + 缓存兜底
  event.respondWith(networkFirst(req));
});

// ---------------------------------------------------------------------------
// 策略实现
// ---------------------------------------------------------------------------

/** 导航 network-first；离线回退缓存的 index.html，最后兜底内置离线页 */
async function networkFirstNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      // 只有 HTML 才刷新应用壳：否则 /manifest.webmanifest、/icons/*.png 等
      // 顶层导航会把 /index.html 缓存污染成非 HTML，离线回退即白屏/乱码
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        try {
          const cache = await caches.open(PRECACHE);
          await cache.put('/index.html', res.clone());
        } catch {
          /* 存储失败忽略 */
        }
      }
    }
    return res;
  } catch {
    const cache = await caches.open(PRECACHE);
    const hit = (await cache.match('/index.html')) || (await cache.match('/')) || (await cache.match(OFFLINE_URL));
    if (hit) return hit;
    return offlineFallbackPage();
  }
}

/** 普通同源 GET 的 network-first + 缓存兜底 */
async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      try {
        const cache = await caches.open(RUNTIME);
        await cache.put(request, res.clone());
      } catch {
        /* 配额不足等：忽略，不影响本次响应 */
      }
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // 仅导航/HTML 请求离线回退 HTML 页面；JS/CSS 等回 404，
    // 否则未缓存的脚本会拿到 text/html → 语法错误而非干净的失败
    const accept = request.headers.get('accept') || '';
    if (request.mode === 'navigate' || accept.includes('text/html')) return offlineFallbackPage();
    return new Response('', { status: 404, statusText: 'Offline and not cached' });
  }
}

/** /src /styles /icons：stale-while-revalidate */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (res) => {
      if (res && res.ok) {
        try {
          await cache.put(request, res.clone());
        } catch {
          /* 忽略写缓存失败 */
        }
      }
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  // 关键兜底：首次安装时模块/CSS 由浏览器在 SW 接管前取走，只进了 PRECACHE。
  // 只查 RUNTIME 会让「首次安装后第一次离线刷新」白屏——必须回退到全局匹配（含 PRECACHE）。
  const inAnyCache = await caches.match(request);
  if (inAnyCache) return inAnyCache;
  const res = await network;
  if (res) return res;
  return Response.error();
}

/** /models /tts：cache-first，命中任意缓存即返回；网络失败不再回写 RUNTIME。
 *  模型/运行时由应用层（tinttxt-tts-*）单点缓存——SW 再存一份会让 39MB 模型占双倍配额；
 *  离线时 caches.match 全局查找同样能命中应用层缓存。 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    return res;
  } catch {
    const again = await caches.match(request);
    if (again) return again;
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
}

// ---------------------------------------------------------------------------
// 预缓存工具
// ---------------------------------------------------------------------------

/** 把 src/href 中的同源相对地址规范为绝对路径；跨域/非资源返回 null */
function normalizeLocalUrl(raw) {
  if (!raw || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('mailto:')) return null;
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin !== self.location.origin) return null;
    // 跳过带 hash 的锚点链接与查询串外链
    if (/\.(md|pdf|zip)$/i.test(u.pathname)) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

/** 容错抓取并写入缓存（404/网络失败都不抛） */
async function putIfFetchable(cache, url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res && res.ok) await cache.put(url, res.clone());
    return res && res.ok;
  } catch {
    return false;
  }
}

/**
 * 沿已缓存的 JS 模块 import 图递归预缓存：
 * 解析 from '...' / import('...') / import '...' / export ... from '...'
 * 仅跟随同源、位于 /src/ 或 /styles/ 下的相对路径。
 */
async function precacheModuleGraph(cache, seeds) {
  const visited = new Set();
  const queue = ['/src/main.js', ...(Array.isArray(seeds) ? seeds : [])];

  const extract = (code, baseUrl) => {
    const specs = new Set();
    const patterns = [
      /\bfrom\s*['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
    ];
    for (const re of patterns) {
      for (const m of code.matchAll(re)) specs.add(m[1]);
    }
    const out = [];
    for (const spec of specs) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // 裸模块名：本项目无第三方依赖
      try {
        const u = new URL(spec, baseUrl);
        if (u.origin !== self.location.origin) continue;
        if (!u.pathname.startsWith('/src/') && !u.pathname.startsWith('/styles/')) continue;
        out.push(u.pathname);
      } catch {
        /* 非法相对路径：忽略 */
      }
    }
    return out;
  };

  while (queue.length) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    let ok = false;
    let text = '';
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (res && res.ok) {
        text = await res.text();
        await cache.put(path, new Response(text, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }));
        ok = true;
      }
    } catch {
      /* 抓取失败：跳过该模块 */
    }
    if (ok && (path.endsWith('.js') || path.endsWith('.mjs'))) {
      const base = new URL(path, self.location.origin).href;
      for (const next of extract(text, base)) queue.push(next);
    }
  }
  // 诊断信息（可在 DevTools → Service Workers 控制台查看）
  try {
    console.info(`[sw] 模块图预缓存 ${visited.size} 个文件：`, [...visited].sort());
  } catch {
    /* ignore */
  }
}

/** 内置离线兜底页（连缓存都没有时的最后防线） */
function offlineFallbackPage() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>离线 — 蝈蝈听书</title>
<style>body{background:#1a1a2e;color:#eee;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
div{padding:24px}h1{font-size:20px}p{opacity:.8;line-height:1.7}</style></head>
<body><div><h1>当前处于离线状态</h1>
<p>应用壳未能从缓存中读取。请联网后重新打开，已下载的书籍与语音模型在联网一次后可离线使用。</p></div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
