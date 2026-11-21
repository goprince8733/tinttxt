/**
 * UI 层 —— hash 路由（#shelf #player #settings #diag）
 * 只用 display 切换视图 + location.hash（同文档导航），绝不 location.href 整页跳转，
 * 否则会销毁播放实例。
 * @module ui/router
 */

const ROUTES = ['shelf', 'player', 'settings', 'diag'];

/**
 * @param {{}} ctx
 */
export function createRouter(ctx) {
  /** @type {Set<(raw:string, view:string)=>void>} */
  const subs = new Set();
  /** 打开设置抽屉前所在视图 */
  let prevView = 'shelf';

  function parse() {
    const h = (location.hash || '').replace(/^#/, '');
    return ROUTES.includes(h) ? h : 'shelf';
  }

  function apply() {
    const raw = parse();
    const view = raw === 'settings' ? prevView : raw;
    if (raw !== 'settings') prevView = raw;

    document.body.dataset.route = view;
    const activeTab = raw === 'settings' ? 'settings' : view;
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.tab === activeTab;
      tab.classList.toggle('is-active', on);
      if (on) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    for (const f of subs) {
      try { f(raw, view); } catch (e) { console.error('[router] subscriber threw', e); }
    }
  }

  /** @param {string} hash 形如 '#player' */
  function go(hash) {
    const target = hash.startsWith('#') ? hash : `#${hash}`;
    if (location.hash === target) apply();
    else location.hash = target; // 同文档导航，触发 hashchange → apply
  }

  function start() {
    if (!location.hash) history.replaceState(null, '', '#shelf');
    window.addEventListener('hashchange', apply);
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => go(`#${tab.dataset.tab}`));
    }
    document.getElementById('btn-skip')?.addEventListener('click', () => {
      const main = document.getElementById('main');
      main?.focus();
      main?.scrollIntoView({ block: 'start' });
    });
    apply();
  }

  return {
    start,
    go,
    parse,
    /** 当前原始 hash 路由（含 settings） */
    current: parse,
    /** 设置抽屉打开前的视图 */
    prevView: () => prevView,
    /** raw = 原始路由；view = 实际显示的视图 */
    on: (fn) => subs.add(fn),
  };
}
