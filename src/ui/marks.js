/**
 * UI 层 —— 书签抽屉（备注 / 时间 / 句预览，点击跳转、删除）
 * @module ui/marks
 */

import { $, el, clear, formatDateTime } from './dom.js';

/** @param {object} ctx */
export function createMarks(ctx) {
  const app = ctx.app;
  const drawer = $('#marks-drawer');
  const listEl = $('#marks-list');
  const emptyEl = $('#marks-empty');

  async function refresh() {
    const book = ctx.currentBook;
    clear(listEl);
    if (!book) {
      emptyEl.hidden = false;
      emptyEl.textContent = '还没有打开书籍。';
      return;
    }
    let marks = [];
    try {
      marks = await app.listMarks(book.id);
    } catch (e) {
      ctx.toast(`读取书签失败：${e.message}`, 'error');
    }
    marks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    emptyEl.hidden = marks.length > 0;
    if (!marks.length) emptyEl.textContent = '还没有书签，播放时点「加书签」记录当前位置。';

    const sentences = app.player.getSentences();
    for (const m of marks) {
      const s = sentences[m.sentenceIndex];
      const preview = s ? s.raw.replace(/\s+/g, ' ').trim() : `第 ${(m.sentenceIndex || 0) + 1} 句`;
      const item = el('li', { class: 'mark-item' });

      const head = el('div', { class: 'mark-head' }, [
        el('span', { text: formatDateTime(m.createdAt || Date.now()) }),
        el('span', { text: `#${(m.sentenceIndex || 0) + 1}` }),
      ]);
      item.append(head);
      if (m.note) item.append(el('div', { class: 'mark-note', text: m.note }));
      item.append(el('div', { class: 'mark-preview', text: preview }));

      const actions = el('div', { class: 'mark-actions' });
      actions.append(
        el('button', {
          class: 'btn btn-sm btn-primary',
          text: '跳转',
          attrs: { type: 'button' },
          onClick: () => void jump(m),
        }),
        el('button', {
          class: 'btn btn-sm',
          text: '删除',
          attrs: { type: 'button' },
          onClick: () => void remove(m),
        }),
      );
      item.append(actions);
      listEl.append(item);
    }
  }

  async function jump(m) {
    try {
      await app.jumpToMark(m);
      close();
      ctx.router.go('#player');
    } catch (e) {
      ctx.toast(`跳转失败：${e && e.message ? e.message : e}`, 'error');
    }
  }

  async function remove(m) {
    const ans = await ctx.modal.confirm({
      title: '删除书签',
      message: m.note ? `确定删除书签「${m.note}」吗？` : '确定删除该书签吗？',
      confirmLabel: '删除',
      danger: true,
    });
    if (ans !== 'confirm') return;
    try {
      await app.removeMark(m.id);
      await refresh();
      ctx.toast('书签已删除', 'success');
    } catch (e) {
      ctx.toast(`删除失败：${e && e.message ? e.message : e}`, 'error');
    }
  }

  function open() {
    void refresh();
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    ctx.settings.syncBackdrop();
    setTimeout(() => $('#btn-marks-close')?.focus(), 60);
  }

  function close() {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    ctx.settings.syncBackdrop();
  }

  function isOpen() {
    return drawer.classList.contains('is-open');
  }

  $('#btn-marks-close').addEventListener('click', close);

  return { open, close, isOpen, refresh };
}
