/**
 * TintTXT 网页版 TXT 听书器 —— UI 层入口
 *
 * 启动流程（硬性约束 10）：
 *   createApp() → 恢复上次书籍（getLastBookId → listBooks → openBook，不自动播放）
 *   → 渲染书架 → 订阅全部事件 → 挂载 SW（失败静默）→ checkModel()
 *
 * 视图切换只用 display + hash 路由（#shelf #player #settings #diag），
 * 绝不 location.href 整页跳转（会销毁播放实例）。
 * @module main
 */

import { Events } from './core/contracts.js';
import { createApp } from './app.js';
import { $ } from './ui/dom.js';
import { createToast } from './ui/toast.js';
import { createModal } from './ui/modal.js';
import { createRouter } from './ui/router.js';
import { createShelf } from './ui/shelf.js';
import { createPlayerView } from './ui/reader.js';
import { createMiniPlayer } from './ui/mini.js';
import { createSettings } from './ui/settings.js';
import { createMarks } from './ui/marks.js';
import { createDiag } from './ui/diag.js';
import { createOnboarding } from './ui/onboarding.js';

async function boot() {
  document.documentElement.dataset.boot = 'starting';
  const app = await createApp();

  /** UI 层共享上下文：模块之间只通过它互相引用，回调只做转发。 */
  const ctx = {
    app,
    bus: app.bus,
    /** @type {any|null} 当前打开的书（openBook 返回的完整对象，含 text/chapters/sentences） */
    currentBook: null,
  };

  /* ---- 模块装配（顺序：基础设施 → 视图） ---- */
  ctx.toast = createToast(ctx);
  ctx.modal = createModal($('#modal-root'));
  ctx.router = createRouter(ctx);
  ctx.settings = createSettings(ctx);
  ctx.marks = createMarks(ctx);
  ctx.shelf = createShelf(ctx);
  ctx.reader = createPlayerView(ctx);
  ctx.mini = createMiniPlayer(ctx);
  ctx.diag = createDiag(ctx);
  ctx.onboarding = createOnboarding(ctx);

  /* ---- 通用助手（供各视图调用，保持回调只转发） ---- */

  ctx.setBusy = (msg) => {
    const overlay = $('#busy-overlay');
    if (msg) {
      $('#busy-text').textContent = String(msg);
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }
  };

  ctx.openOnboarding = () => ctx.onboarding.show();
  ctx.onOnboardingClosed = () => { /* 引导关闭后的焦点可在此扩展 */ };

  /** 打开书籍：加载播放器 + 记住上次书籍 + 刷新各视图（不自动播放）。 */
  ctx.openBookById = async (id, opts = {}) => {
    const res = await app.openBook(id, opts);
    ctx.currentBook = res.book;
    await app.rememberLastBook(id);
    ctx.reader.render();
    ctx.mini.refresh();
    void ctx.marks.refresh();
    return res;
  };

  ctx.refreshMarks = () => ctx.marks.refresh();
  ctx.openMarks = () => ctx.marks.open();

  ctx.onBookRenamed = (id, title) => {
    if (ctx.currentBook && ctx.currentBook.id === id) {
      ctx.currentBook.title = title;
      app.player.setTitle(title); // 同步锁屏卡片/通知栏标题
      ctx.reader.render();
      ctx.mini.refresh();
    }
  };

  ctx.onBookDeleted = (id) => {
    if (ctx.currentBook && ctx.currentBook.id === id) {
      ctx.currentBook = null;
      ctx.reader.render();
      ctx.mini.refresh();
      void ctx.marks.refresh();
      ctx.router.go('#shelf');
    }
  };

  ctx.onBackupImported = async () => {
    try {
      const books = await app.listBooks();
      if (ctx.currentBook && !books.some((b) => b.id === ctx.currentBook.id)) {
        ctx.currentBook = null;
        ctx.reader.render();
        ctx.mini.refresh();
        void ctx.marks.refresh();
      }
    } catch { /* 忽略：书架刷新失败不影响导入结果 */ }
  };

  ctx.onVoicesChanged = () => { void ctx.reader.refreshVoices(); };
  ctx.onModelChanged = () => ctx.reader.updateModelBanner();

  /* ---- 主题（设置层持久化 dataset + localStorage + app.updateSettings） ---- */
  ctx.settings.applyTheme(app.getSettings().theme);

  /* ---- 视图切换（hash 路由） ---- */
  ctx.router.on((raw, view) => {
    if (raw === 'settings') ctx.settings.open();
    else ctx.settings.close();
    if (view === 'diag') ctx.diag.enter();
  });

  /* ---- 抽屉遮罩 / Esc 关闭 ---- */
  const backdrop = $('#drawer-backdrop');
  backdrop.addEventListener('click', () => {
    if (ctx.marks.isOpen()) {
      ctx.marks.close();
      return;
    }
    if (ctx.settings.isOpen()) ctx.router.go(`#${ctx.router.prevView()}`);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 弹窗打开时 Esc 只关弹窗（document 级监听器无法被 stopPropagation 隔离）
    if (ctx.modal.isOpen()) return;
    if (ctx.marks.isOpen()) ctx.marks.close();
    else if (ctx.settings.isOpen()) ctx.router.go(`#${ctx.router.prevView()}`);
  });

  /* ---- 顶栏按钮 ---- */
  $('#btn-help').addEventListener('click', () => ctx.onboarding.show());
  $('#btn-header-settings').addEventListener('click', () => ctx.router.go('#settings'));

  /* ================= 恢复上次书籍 ================= */
  const lastId = app.getLastBookId();
  if (lastId) {
    try {
      const books = await app.listBooks();
      if (books.some((b) => b.id === lastId)) {
        const res = await ctx.openBookById(lastId); // 不自动播放
        // 需求 D：明确告知恢复位置 + 提供回退 N 秒（绝不回到开头）
        const st = res.state;
        if (st && (st.charOffset > 0 || st.sentenceIndex > 0)) {
          const sents = res.book.sentences || [];
          const s = sents[Math.min(st.sentenceIndex, sents.length - 1)];
          const ch = s ? res.book.chapters[s.chapter] : null;
          const posLabel = ch ? `${ch.title} · 第${st.sentenceIndex + 1}句` : `第${st.sentenceIndex + 1}句`;
          ctx.toast(`已恢复到 ${posLabel}`, 'info', {
            label: '回退15秒',
            onClick: () => void app.player.seekRelative(-15),
          });
        }
      }
    } catch (e) {
      console.warn('[main] 恢复上次书籍失败', e);
    }
  }

  /* ================= 渲染书架 ================= */
  await ctx.shelf.render();
  ctx.reader.render();   // 无书时显示空状态，有书时同步章节/控件
  ctx.mini.refresh();

  /* ================= 订阅全部事件 ================= */
  const { bus } = app;

  bus.on(Events.STATE, (patch) => {
    ctx.reader.onState(patch);
    ctx.mini.onState(patch);
  });

  bus.on(Events.SENTENCE, () => {
    ctx.reader.onSentence();
    ctx.mini.onSentence();
  });

  bus.on(Events.PROGRESS, () => {
    ctx.reader.onProgress();
    ctx.mini.onProgress();
  });

  bus.on(Events.ERROR, (p) => {
    if (p && p.message) ctx.toast(String(p.message), 'error');
  });

  bus.on(Events.BOOKS, () => {
    void ctx.shelf.render();
  });

  bus.on(Events.SETTINGS, (settings) => {
    ctx.settings.syncFromSettings();
    if (settings && settings.theme) ctx.settings.applyTheme(settings.theme);
  });

  bus.on(Events.WAKELOCK, () => {
    if (document.body.dataset.route === 'diag') ctx.diag.refresh();
  });

  bus.on(Events.DIAG, (snap) => ctx.diag.onDiag(snap));

  /* ================= 路由启动 ================= */
  ctx.router.start();

  /* ================= 首次使用引导 ================= */
  if (ctx.onboarding.shouldAutoShow()) ctx.onboarding.show();

  /* ================= 挂载 Service Worker =================
   * 注册统一由 /scripts/sw-bridge.js 负责（它同时负责更新事件桥接；
   * 这里重复注册会造成「有 SW 但无事件桥」的不一致状态，且注册失败本就静默降级）。 */

  /* ================= 模型状态 ================= */
  try {
    await app.checkModel();
  } catch { /* 检测失败不阻塞 UI */ }
  ctx.reader.updateModelBanner();

  // 系统朗读预览的音色列表是异步加载的：首次 getVoices() 常为空，需监听 voiceschanged
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.addEventListener?.('voiceschanged', () => ctx.onVoicesChanged());
  }

  /* ================= 统计条定时刷新 ================= */
  setInterval(() => {
    if (document.body.dataset.route === 'shelf') void ctx.shelf.renderStats();
  }, 60000);

  document.documentElement.dataset.boot = 'ok';

  // 调试句柄：仅当 URL 带 ?debug 时暴露（供自动化冒烟测试 / 控制台排查），普通使用不注入全局变量
  if (location.search.includes('debug')) window.__TINTTXT__ = ctx;
}

boot().catch((e) => {
  console.error('[main] 启动失败', e);
  document.documentElement.dataset.boot = `error:${e && e.message ? e.message : e}`;
  const root = document.getElementById('toast-root');
  if (root) {
    const div = document.createElement('div');
    div.className = 'toast toast-error';
    div.setAttribute('role', 'alert');
    div.textContent = `启动失败：${e && e.message ? e.message : e}`;
    root.appendChild(div);
  }
});
