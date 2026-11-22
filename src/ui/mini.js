/**
 * UI 层 —— 底部常驻播放条（书架页与播放页都显示）
 * 点击展开进播放页；订阅 STATE / SENTENCE / PROGRESS 维护迷你进度。
 * @module ui/mini
 */

import { $ } from './dom.js';

/** @param {object} ctx */
export function createMiniPlayer(ctx) {
  const app = ctx.app;
  const player = app.player;

  const bar = $('#mini-player');
  const titleEl = $('#mini-title');
  const sentenceEl = $('#mini-sentence');
  const fill = $('#mini-progress-bar');
  const btnPlay = $('#btn-mini-play');

  function setIcon(playing) {
    const use = btnPlay.querySelector('use');
    if (use) use.setAttribute('href', playing ? '#ic-pause' : '#ic-play');
    btnPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
    btnPlay.classList.toggle('is-loading', !playing && player.getState().status === 'loading');
  }

  function refresh() {
    const book = ctx.currentBook;
    const st = player.getState();
    const has = !!book;
    bar.hidden = !has;
    if (!has) return;
    titleEl.textContent = book.title;
    setIcon(st.status === 'playing');
    updateSentence();
    updateProgress();
  }

  function updateSentence() {
    const sentences = player.getSentences();
    const st = player.getState();
    const s = sentences[st.sentenceIndex];
    sentenceEl.textContent = s ? s.raw.replace(/\s+/g, ' ').trim() : '点击开始听书';
  }

  function updateProgress() {
    const book = ctx.currentBook;
    if (!book) return;
    const st = player.getState();
    const total = Math.max(1, book.text.length);
    const pct = Math.max(0, Math.min(100, (st.charOffset / total) * 100));
    fill.style.width = `${pct}%`;
  }

  /* 事件入口（由 main 转发） */
  function onState(patch) {
    if (!ctx.currentBook) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (patch && patch.status) {
      setIcon(patch.status === 'playing');
      // loading 状态也更新按钮（转圈反馈）
      btnPlay.classList.toggle('is-loading', patch.status === 'loading');
    }
    if (patch && (patch.sentenceIndex !== undefined || patch.charOffset !== undefined)) updateSentence();
    updateProgress();
  }

  function onSentence() {
    updateSentence();
    updateProgress();
  }

  function onProgress() {
    updateProgress();
  }

  function togglePlay() {
    const st = player.getState();
    // 与 reader 一致：loading/buffering 也视为「正在播」，再点就是暂停（中止合成）
    if (st.status === 'playing' || st.status === 'loading' || st.status === 'buffering') {
      player.pause();
    } else {
      // 立即变暂停图标（不等异步状态）
      const use = btnPlay.querySelector('use');
      if (use) use.setAttribute('href', '#ic-pause');
      btnPlay.classList.remove('is-loading');
      // 在用户手势上下文内同步预热 speechSynthesis（360Browser 需要）
      if (typeof speechSynthesis !== 'undefined') {
        try {
          const warm = new SpeechSynthesisUtterance('。');
          warm.volume = 0;
          speechSynthesis.speak(warm);
        } catch { /* ignore */ }
      }
      void player.play();
    }
  }

  $('#mini-open').addEventListener('click', () => ctx.router.go('#player'));
  btnPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });
  $('#btn-mini-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    void player.prevSentence();
  });
  $('#btn-mini-next').addEventListener('click', (e) => {
    e.stopPropagation();
    void player.nextSentence();
  });

  // 整条点击（除按钮外）→ 展开播放页
  bar.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    ctx.router.go('#player');
  });

  return { refresh, onState, onSentence, onProgress, setIcon };
}
