/**
 * UI 层 —— 书架页
 * 导入（含编码失败重试）、搜索/排序、卡片操作、备份导入导出、统计条、空状态。
 * 回调只做转发：业务流程都在本模块的具名函数里，事件监听器仅调用它们。
 * @module ui/shelf
 */

import { $, el, clear, formatDuration, formatChars, relativeTime, downloadJson, safeFileName, coverColor } from './dom.js';
import { Events } from '../core/contracts.js';

/** @param {object} ctx */
export function createShelf(ctx) {
  const app = ctx.app;

  const listEl = $('#book-list');
  const emptyEl = $('#empty-state');
  const searchInput = $('#search-input');
  const sortSelect = $('#sort-select');
  const statToday = $('#stat-today');
  const statTotal = $('#stat-total');
  const statStreak = $('#stat-streak');
  const fileInput = $('#file-input');
  const backupInput = $('#backup-input');
  const progressPanel = $('#import-progress');
  const progressText = $('#import-progress-text');
  const progressBar = $('#import-progress-bar');

  /** @type {Array<any>} */
  let books = [];

  /* ---------------- 播放队列条（多文件排队播放） ---------------- */

  const queueBar = el('div', { class: 'queue-bar', attrs: { 'aria-label': '播放队列' } });
  queueBar.hidden = true;
  listEl.parentElement.insertBefore(queueBar, listEl);

  function renderQueueBar() {
    const queue = app.getQueue();
    clear(queueBar);
    if (!queue.length) {
      queueBar.hidden = true;
      return;
    }
    queueBar.hidden = false;
    const titles = queue
      .map((id) => books.find((b) => b.id === id))
      .filter(Boolean)
      .map((b) => `《${b.title}》`);
    queueBar.append(
      el('span', {
        class: 'queue-label',
        text: `队列 ${queue.length} 本：${titles.length ? titles.join(' → ') : '（书中有些已不在书架）'}`,
      }),
    );
    const btns = el('span', { class: 'queue-btns' });
    btns.append(
      el('button', {
        class: 'btn btn-sm btn-primary',
        attrs: { type: 'button' },
        text: '开始排队播放',
        onClick: () => void startQueue(),
      }),
      el('button', {
        class: 'btn btn-sm',
        attrs: { type: 'button' },
        text: '清空',
        onClick: () => void app.clearQueue(),
      }),
    );
    queueBar.append(btns);
  }

  async function startQueue() {
    try {
      const ok = await app.playQueueNow();
      if (!ok) ctx.toast('队列为空', 'warn');
    } catch (e) {
      ctx.toast(`排队播放失败：${(e && e.message) || e}`, 'error');
    }
  }

  async function toggleQueue(b) {
    try {
      const added = await app.enqueueBook(b.id);
      ctx.toast(added ? `已加入队列：《${b.title}》` : `《${b.title}》已在队列中`, added ? 'success' : 'info');
    } catch (e) {
      ctx.toast(`加入队列失败：${(e && e.message) || e}`, 'error');
    }
  }

  ctx.bus.on(Events.QUEUE, renderQueueBar);

  /* ---------------- 渲染 ---------------- */

  async function render() {
    try {
      books = await app.listBooks();
    } catch (e) {
      ctx.toast(`读取书架失败：${e.message}`, 'error');
      books = [];
    }
    renderStats();
    renderList();
    renderQueueBar();
  }

  async function renderStats() {
    try {
      const s = await app.getStats();
      statToday.textContent = formatDuration(s.todayMs);
      statTotal.textContent = formatDuration(s.totalMs);
      statStreak.textContent = `${s.streak} 天`;
    } catch {
      statToday.textContent = '—';
      statTotal.textContent = '—';
      statStreak.textContent = '—';
    }
  }

  function currentQuery() {
    return (searchInput.value || '').trim().toLowerCase();
  }

  function sortedFiltered() {
    const q = currentQuery();
    let out = books.slice();
    if (q) out = out.filter((b) => String(b.title || '').toLowerCase().includes(q));
    switch (sortSelect.value) {
      case 'recent-import':
        out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        break;
      case 'title':
        out.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'));
        break;
      case 'chars':
        out.sort((a, b) => (b.chars || 0) - (a.chars || 0));
        break;
      case 'recent-listen':
      default:
        out.sort((a, b) => (b.lastListenAt || 0) - (a.lastListenAt || 0) || (b.addedAt || 0) - (a.addedAt || 0));
        break;
    }
    return out;
  }

  function renderList() {
    clear(listEl);
    emptyEl.hidden = books.length > 0;
    const rows = sortedFiltered();
    if (!rows.length && books.length > 0) {
      listEl.append(el('li', { class: 'book-sub', text: '没有匹配的书籍。' }));
      return;
    }
    for (const b of rows) listEl.append(buildCard(b));
  }

  /** @param {any} b */
  function buildCard(b) {
    const li = el('li', { class: 'book-card', dataset: { id: b.id } });

    const openBtn = el('button', {
      class: 'book-open',
      attrs: { type: 'button', 'aria-label': `打开《${b.title}》` },
      onClick: () => void openBook(b),
    });

    const cover = el('span', { class: 'cover', text: (String(b.title || '').trim().charAt(0)) || '书', attrs: { 'aria-hidden': 'true' } });
    cover.style.backgroundColor = coverColor(b.title);

    const meta = el('span', { class: 'book-meta' });
    meta.append(el('span', { class: 'book-title', text: String(b.title || '未命名') }));

    const sub = el('span', { class: 'book-sub' });
    sub.append(el('span', { text: formatChars(b.chars) }));
    sub.append(el('span', { class: 'dot', text: '·' }));
    const prog = el('span', { class: 'book-progress-inline', text: `进度 ${Math.round(b.progress || 0)}%` });
    sub.append(prog);
    sub.append(el('span', { class: 'dot', text: '·' }));
    sub.append(el('span', { text: b.lastListenAt ? `收听于 ${relativeTime(b.lastListenAt)}` : `导入于 ${relativeTime(b.addedAt)}` }));
    meta.append(sub);

    openBtn.append(cover, meta);
    li.append(openBtn);

    const actions = el('div', { class: 'book-actions' });
    const inQueue = app.getQueue().includes(b.id);
    actions.append(
      iconAction('ic-edit', `重命名《${b.title}》`, () => void renameBook(b)),
      iconAction('ic-trash', `删除《${b.title}》`, () => void deleteBook(b)),
      iconAction('ic-backup', `导出《${b.title}》JSON`, () => void exportOneBook(b)),
      iconAction('ic-queue', inQueue ? `《${b.title}》已在播放队列` : `把《${b.title}》加入播放队列`, () => void toggleQueue(b)),
    );
    if (inQueue) li.classList.add('in-queue');
    li.append(actions);
    return li;
  }

  function iconAction(icon, label, onClick) {
    const btn = el('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': label, title: label }, onClick });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${icon}`);
    svg.append(use);
    btn.append(svg);
    return btn;
  }

  /* ---------------- 打开书籍 ---------------- */

  async function openBook(b) {
    try {
      ctx.setBusy(`正在打开《${b.title}》…`);
      await ctx.openBookById(b.id);
      ctx.router.go('#player');
    } catch (e) {
      ctx.toast(`打开失败：${e && e.message ? e.message : e}`, 'error');
    } finally {
      ctx.setBusy(null);
    }
  }

  /* ---------------- 卡片操作 ---------------- */

  async function renameBook(b) {
    const name = await ctx.modal.prompt({
      title: '重命名书籍',
      label: '书名',
      value: b.title,
      confirmLabel: '保存',
    });
    if (name == null || !name || name === b.title) return;
    try {
      await app.renameBook(b.id, name);
      ctx.onBookRenamed(b.id, name);
      ctx.toast('已重命名', 'success');
      await render();
    } catch (e) {
      ctx.toast(`重命名失败：${e.message}`, 'error');
    }
  }

  async function deleteBook(b) {
    const ans = await ctx.modal.confirm({
      title: '删除书籍',
      message: `确定删除《${b.title}》吗？播放进度与书签会一并删除，此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (ans !== 'confirm') return;
    try {
      await app.deleteBook(b.id);
      ctx.onBookDeleted(b.id);
      ctx.toast('已删除', 'success');
      await render();
    } catch (e) {
      ctx.toast(`删除失败：${e.message}`, 'error');
    }
  }

  /* ---------------- 导入 ---------------- */

  function pickFiles() {
    fileInput.value = '';
    fileInput.click(); // 用户手势 → FileList
  }

  function setProgress(cur, total, name) {
    progressPanel.hidden = false;
    progressText.textContent = `正在导入（${cur}/${total}）：${name}`;
    progressBar.style.width = `${Math.round((cur / total) * 100)}%`;
  }

  /**
   * 逐个文件导入以便显示进度，并在编码失败时弹出候选编码选择。
   * @param {FileList|File[]} fileList
   */
  async function runImport(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    let force = null;
    /** @type {Array<{id:string,title:string}>} 本次新导入的书（用于排队播放提示） */
    const addedBooks = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress(i + 1, files.length, file.name);
      try {
        const results = await app.importFiles([file], force ? { forceEncoding: force } : undefined);
        force = null;
        for (const r of results) {
          if (r.warning) ctx.toast(r.warning, 'warn');
          if (r.added) addedBooks.push({ id: r.book.id, title: r.book.title });
        }
      } catch (err) {
        if (err && err.code === 'DECODE_FAILED') {
          progressPanel.hidden = true;
          const choice = await askEncoding(err);
          if (choice === 'cancel') break;
          if (choice === 'skip') {
            force = null;
            continue;
          }
          force = choice; // 带 forceEncoding 重试同一文件
          i--;
          continue;
        }
        ctx.toast(`导入失败：${err && err.message ? err.message : err}`, 'error');
        force = null;
      }
    }
    progressPanel.hidden = true;
    await render();
    // 多文件导入 → 提供排队播放（需求 A：多文件排队播放）
    if (addedBooks.length >= 2) {
      ctx.toast(`已导入 ${addedBooks.length} 本书`, 'success', {
        label: '排队播放',
        onClick: () => void queueImported(addedBooks),
      });
    }
  }

  /** 把刚导入的书依次加入队列并开始播放。 */
  async function queueImported(list) {
    try {
      for (const b of list) await app.enqueueBook(b.id);
      const ok = await app.playQueueNow();
      if (ok) ctx.router.go('#player');
    } catch (e) {
      ctx.toast(`排队播放失败：${(e && e.message) || e}`, 'error');
    }
  }

  /** 编码失败弹窗：错误信息 + 候选编码下拉 + 重试/跳过/取消。 */
  function askEncoding(err) {
    return new Promise((resolve) => {
      const list = [...new Set((err.candidates && err.candidates.length)
        ? err.candidates
        : ['utf-8', 'gb18030', 'gbk', 'big5', 'utf-16le', 'utf-16be'])];
      const select = el('select', { attrs: { 'aria-label': '候选编码' } });
      for (const c of list) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        select.append(o);
      }
      const content = el('div', { class: 'modal-field' }, [
        el('span', { text: `文件：${err.fileName || '未知文件'}` }),
        el('p', { text: String(err.message || '无法识别文件编码') }),
        el('span', { text: '选择一个候选编码后重试：' }),
        select,
      ]);
      ctx.modal.open({
        title: '文件编码无法识别',
        content,
        actions: [
          { label: '取消导入', value: 'cancel', ghost: true },
          { label: '跳过该文件', value: 'skip' },
          { label: '用所选编码重试', value: 'retry', primary: true },
        ],
        onAction: (value, close) => {
          const out = value === 'retry' ? select.value : value;
          resolve(out); // 先结算
          close();
        },
        onClose: () => resolve('cancel'),
      });
    });
  }

  /* ---------------- 备份 ---------------- */

  async function exportBackup() {
    try {
      ctx.setBusy('正在生成完整备份…');
      const data = await app.exportBackup();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadJson(data, `tinttxt-backup-${stamp}.json`);
      ctx.toast(`已导出 ${((data.books || []).length)} 本书的完整备份`, 'success');
    } catch (e) {
      ctx.toast(`备份失败：${e && e.message ? e.message : e}`, 'error');
    } finally {
      ctx.setBusy(null);
    }
  }

  function pickBackupFile() {
    backupInput.value = '';
    backupInput.click();
  }

  /** @param {File} file */
  async function importBackupFile(file) {
    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
      if (!data || data.app !== 'tinttxt') throw new Error('不是有效的 TintTXT 备份文件');
    } catch (e) {
      ctx.toast(`备份读取失败：${e && e.message ? e.message : e}`, 'error');
      return;
    }
    const count = (data.books || []).length;
    const mode = await new Promise((resolve) => {
      ctx.modal.open({
        title: '导入备份',
        content: el('div', {}, [
          el('p', { text: `备份包含 ${count} 本书，导出于 ${data.exportedAt || '未知时间'}。` }),
          el('p', { text: '合并：同 ID 书籍覆盖，保留书架现有其它数据。' }),
          el('p', { text: '替换：先清空书架（含进度、书签、统计），再完整恢复该备份。' }),
        ]),
        actions: [
          { label: '取消', value: null, ghost: true },
          { label: '合并', value: 'merge', primary: true },
          { label: '替换全部', value: 'replace', danger: true },
        ],
        onAction: (value, close) => {
          resolve(value); // 先结算
          close();
        },
        onClose: () => resolve(null),
      });
    });
    if (!mode) return;
    try {
      ctx.setBusy('正在导入备份…');
      await app.importBackup(data, mode);
      ctx.toast(mode === 'replace' ? '已按备份替换书架' : '备份已合并导入', 'success');
      ctx.onBackupImported();
      await render();
    } catch (e) {
      ctx.toast(`导入失败：${e && e.message ? e.message : e}`, 'error');
    } finally {
      ctx.setBusy(null);
    }
  }

  /** 播放页「更多 → 导出该书 JSON」也走这里（同一实现）。 */
  async function exportOneBook(b) {
    try {
      ctx.setBusy('正在生成该书 JSON…');
      const data = await app.exportBackup();
      const book = (data.books || []).find((x) => x.id === b.id);
      if (!book) throw new Error('书籍不存在或已被删除');
      const payload = {
        app: 'tinttxt',
        version: 1,
        exportedAt: new Date().toISOString(),
        books: [book],
        states: (data.states || []).filter((s) => s.bookId === b.id),
        marks: (data.marks || []).filter((m) => m.bookId === b.id),
        // 单书备份不携带 settings：导入一本书不应把当前设置回滚到导出时刻
        settings: null,
        stats: [],
      };
      downloadJson(payload, `${safeFileName(book.title)}.tinttxt.json`);
      ctx.toast('已导出该书 JSON（可再导入恢复）', 'success');
    } catch (e) {
      ctx.toast(`导出失败：${e && e.message ? e.message : e}`, 'error');
    } finally {
      ctx.setBusy(null);
    }
  }

  /* ---------------- 备份菜单 ---------------- */

  function openBackupMenu() {
    ctx.modal.open({
      title: '备份与恢复',
      content: el('div', {}, [
        el('p', { text: '导出完整 JSON 备份（书架 + 进度 + 书签 + 设置 + 统计），或从备份恢复。' }),
      ]),
      actions: [
        { label: '关闭', value: null, ghost: true },
        { label: '导入备份…', value: 'import' },
        { label: '导出完整备份', value: 'export', primary: true },
      ],
      onAction: (value, close) => {
        close();
        if (value === 'export') void exportBackup();
        if (value === 'import') pickBackupFile();
      },
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  $('#btn-import').addEventListener('click', pickFiles);
  $('#btn-empty-import').addEventListener('click', pickFiles);
  $('#btn-empty-guide').addEventListener('click', () => ctx.openOnboarding());
  $('#btn-backup').addEventListener('click', openBackupMenu);
  searchInput.addEventListener('input', renderList);
  sortSelect.addEventListener('change', renderList);
  fileInput.addEventListener('change', () => {
    void runImport(fileInput.files);
  });
  backupInput.addEventListener('change', () => {
    const f = backupInput.files && backupInput.files[0];
    if (f) void importBackupFile(f);
  });

  return {
    render,
    renderStats,
    runImport,
    renameBook,
    deleteBook,
    exportOneBook,
    exportBackup,
    importBackupFile,
  };
}
