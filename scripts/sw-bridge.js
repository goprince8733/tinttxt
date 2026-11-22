/**
 * sw-bridge.js —— Service Worker ↔ 页面 事件桥（零依赖，需在 index.html 引入）
 *
 * ⚠️ 接入方（index.html）必须加上：
 *     <script src="/scripts/sw-bridge.js"></script>
 *   建议放在 </body> 前、main.js 之前或之后均可（main.js 只监听 window 事件）。
 *
 * 职责：
 * 1. 注册 /sw.js（仅在安全上下文：HTTPS 或 localhost；失败静默降级 ——
 *    华为浏览器「添加到桌面」的网址快捷方式场景下 SW 可能不可用，属预期）。
 * 2. 收到 SW 的 {type:'SW_UPDATED'} postMessage 后，转发为 main.js 已监听的
 *    window CustomEvent('__SW_UPDATE__')（SW 无法直接 dispatch 页面事件，
 *    必须有这一层桥接）。
 * 3. 页面可通过 dispatchEvent(new CustomEvent('__SW_SKIP_WAITING__'))
 *    请求激活等待中的新版本（桥接后向 waiting worker 发 {type:'SKIP_WAITING'}）。
 * 4. 额外广播 __SW_CONTROLLING__（新 SW 首次接管）与 __SW_CACHE_READY__。
 *
 * 对外只读状态：window.__SW_BRIDGE__ = { version, registration, updated }
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var bridge = {
    version: '1.0.0',
    registration: null,
    updated: false, // 收到过 SW_UPDATED
    supported: 'serviceWorker' in window.navigator,
  };
  window.__SW_BRIDGE__ = bridge;

  function dispatch(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, detail ? { detail: detail } : undefined));
    } catch (e) {
      /* 老浏览器无 CustomEvent 构造：忽略 */
    }
  }

  // ---- 1. 注册 SW（安全上下文才尝试）----
  /** 检测「等待中的新版本」并广播 __SW_UPDATE__（更新提示的触发源）。 */
  function watchUpdates(reg) {
    if (!reg || !bridge.supported) return;
    var notified = false;
    function notify() {
      if (notified) return;
      notified = true;
      dispatch('__SW_UPDATE__', {});
    }
    function watchInstalling() {
      var inst = reg.installing;
      if (!inst) return;
      inst.addEventListener('statechange', function () {
        // installed + 已有旧 SW 控制 = 新版本进入 waiting（此时还没激活，可提示用户）
        if (inst.state === 'installed' && window.navigator.serviceWorker.controller) notify();
      });
    }
    try {
      reg.addEventListener('updatefound', watchInstalling);
    } catch (e) {
      /* 老实现无 updatefound：退化为轮询 waiting */
      var poll = setInterval(function () {
        if (reg.waiting) {
          clearInterval(poll);
          notify();
        }
      }, 2000);
      setTimeout(function () {
        clearInterval(poll);
      }, 60000);
    }
    watchInstalling();
    // 上次会话遗留下、尚未激活的 waiting 版本
    if (reg.waiting && window.navigator.serviceWorker.controller) notify();
  }

  /** 页面自身的构建号（部署时注入 meta）；用它给 SW 脚本 URL 加版本查询串。 */
  function pageBuild() {
    try {
      var m = document.querySelector('meta[name="app-build"]');
      return m && m.content ? m.content : '';
    } catch (e) { return ''; }
  }

  function register() {
    if (!bridge.supported) return Promise.resolve(null);
    if (!window.isSecureContext) {
      // 非 HTTPS/localhost：SW 不可用，静默降级（核心功能不依赖 SW）
      return Promise.resolve(null);
    }
    if (bridge.registration) return Promise.resolve(bridge.registration);
    var v = pageBuild();
    // 关键：SW 脚本 URL 带构建号。部署后构建号变 → URL 变 → 浏览器必然安装新 SW，
    // 不受"更新检查节流"影响（reg.update() 会被浏览器节流，实测经常不生效）。
    var url = '/sw.js' + (v ? '?v=' + encodeURIComponent(v) : '');
    return window.navigator.serviceWorker
      .register(url, { scope: '/' })
      .then(function (reg) {
        bridge.registration = reg;
        watchUpdates(reg);
        // 主动问一次当前 SW 的版本号（供 checkForUpdate 比对）
        try { if (reg.active) reg.active.postMessage({ type: 'GET_VERSION' }); } catch (e) { /* ignore */ }
        return reg;
      })
      .catch(function (err) {
        // 注册失败（如浏览器不支持/被策略拦截）：降级为纯网络模式
        if (window.console) console.warn('[sw-bridge] Service Worker 注册失败，已降级：', err && err.message);
        return null;
      });
  }

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }

  // ---- 2. SW → 页面 事件转发 ----
  if (bridge.supported) {
    window.navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type === 'SW_UPDATED') {
        bridge.updated = true;
        dispatch('__SW_UPDATE__', { version: data.version });
      } else if (data.type === 'VERSION') {
        bridge.activeVersion = data.version || '';
        dispatch('__SW_VERSION__', { version: data.version });
      }
    });

    // 新 SW 首次接管当前页面（skipWaiting + clients.claim 之后）
    window.navigator.serviceWorker.addEventListener('controllerchange', function () {
      dispatch('__SW_CONTROLLING__');
      // 新 SW 接管后刷新一次版本号
      try {
        var reg = bridge.registration;
        if (reg && reg.active) reg.active.postMessage({ type: 'GET_VERSION' });
      } catch (e) { /* ignore */ }
    });
  }

  // ---- 3. 页面 → SW：请求激活新版本 ----
  window.addEventListener('__SW_SKIP_WAITING__', function () {
    if (!bridge.supported) return;
    window.navigator.serviceWorker
      .getRegistration()
      .then(function (reg) {
        if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      })
      .catch(function () {});
  });

  // ---- 4. 便捷 API ----
  bridge.register = register;
  bridge.skipWaiting = function () {
    window.dispatchEvent(new CustomEvent('__SW_SKIP_WAITING__'));
  };


  /**
   * 兜底更新：注销所有 SW + 清掉 SW 自管缓存 + 刷新。
   * 用于"确实有新版本，但新 SW 迟迟没进 waiting"的情况（安装被节流/中断）。
   * 只清 tinttxt-precache-/tinttxt-runtime-，不碰 TTS 模型缓存与书库。
   */
  bridge.hardUpdate = function () {
    var p = bridge.supported && window.navigator.serviceWorker.getRegistrations
      ? window.navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister().catch(function () {}); }));
        })
      : Promise.resolve();
    return p
      .catch(function () {})
      .then(function () { return caches.keys().catch(function () { return []; }); })
      .then(function (names) {
        var targets = (names || []).filter(function (n) {
          return n.indexOf('tinttxt-precache-') === 0 || n.indexOf('tinttxt-runtime-') === 0;
        });
        return Promise.all(targets.map(function (n) { return caches.delete(n).catch(function () {}); }));
      })
      .catch(function () {})
      .then(function () { try { location.reload(); } catch (e) { /* ignore */ } });
  };

  /**
   * 主动检查更新：resolve { supported, hasUpdate, deployed }。
   * 判断依据是线上 /build-info.json 的构建号 vs 页面自身构建号（meta），
   * 纯网络比对，不受 reg.update() 节流与安装时机影响，结果确定。
   */
  bridge.checkForUpdate = function () {
    if (!bridge.supported) return Promise.resolve({ supported: false, hasUpdate: false });
    var current = pageBuild() || bridge.activeVersion || '';
    return fetch('/build-info.json', { cache: 'no-store' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (info) {
        var deployed = (info && info.build) || '';
        var hasUpdate = !!(deployed && current && deployed !== current);
        return { supported: true, hasUpdate: hasUpdate, deployed: deployed, current: current, waiting: !!(bridge.registration && bridge.registration.waiting) };
      });
  };

  // 回到前台时自动检查一次（10 分钟节流），让手机上不必手动刷新
  bridge.lastUpdateCheck = 0;
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    var now = Date.now();
    if (now - bridge.lastUpdateCheck < 10 * 60 * 1000) return;
    bridge.lastUpdateCheck = now;
    bridge.checkForUpdate();
  });
})();
