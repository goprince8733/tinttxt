/**
 * UI 层 —— 阅读播放页
 * 逐句高亮与跟随滚动、进度条定位、六态状态机 UI、模型横幅、书签、导出音频、更多菜单。
 * 所有按钮只转发到 app / player 方法；章节微调用结构层纯函数（splitChapterAt / mergeChapterIntoPrev）。
 * @module ui/reader
 */

import { $, el, clear, formatDuration, formatSeconds, formatClock, safeFileName, downloadBlob, throttleFrame } from './dom.js';
import { bindChapterSentences } from '../layers/structure/chapters.js';

const STATUS_TEXT = {
  idle: '未播放',
  loading: '🎙️ 正在合成语音…（约 10~30 秒）',
  playing: '播放中',
  paused: '已暂停',
  buffering: '缓冲中',
  error: '出错',
};

/** @param {object} ctx */
export function createPlayerView(ctx) {
  const app = ctx.app;
  const player = app.player;

  const view = $('#view-player');
  const banner = $('#model-banner');
  const bannerText = $('#model-banner-text');
  const bannerTrack = $('#model-banner-track');
  const bannerBar = $('#model-banner-bar');
  const downloadText = $('#btn-download-model-text');

  const titleEl = $('#player-title');
  const chapterSelect = $('#chapter-select');
  const followToggle = $('#follow-toggle');
  const followHint = $('#follow-hint');
  const readerScroll = $('#reader-scroll');
  const readerContent = $('#reader-content');
  const readerEmpty = $('#reader-empty');

  const badge = $('#state-badge');
  const sleepLabel = $('#sleep-label');
  const sleepText = $('#sleep-countdown');
  const errorPanel = $('#error-panel');
  const errorText = $('#error-text');
  const posInfo = $('#pos-info');
  const chapterProgress = $('#chapter-progress');
  const bookProgress = $('#book-progress');
  const remainInfo = $('#remain-info');
  const seekRange = $('#seek-range');

  const btnPlay = $('#btn-play');
  const rateRange = $('#rate-range');
  const rateVal = $('#rate-val');
  const volRange = $('#vol-range');
  const volVal = $('#vol-val');
  const voiceSelect = $('#voice-select');
  const sleepSelect = $('#sleep-select');


  /* ---------------- 滚动跟随状态 ---------------- */

  let followOn = true;
  let manualPaused = false;   // 用户手动滚动过 → 软暂停（8 秒无操作自动恢复）
  let progTop = null;         // 本次"程序化滚动"的目标位置
  let progClearTimer = 0;
  let lastProgAt = 0;         // 上次程序化滚动的发起时间
  let resumeTimer = 0;
  let lastScrollTop = 0;      // 用于区分"用户滑动"与"句子渲染引起的微小位移"
  let activeSpan = null;
  /** 手动滑动后自动恢复跟随的等待时长 */
  const FOLLOW_RESUME_MS = 8000;

  /* ---------------- 进度条拖动状态 ---------------- */

  let seekDragging = false;

  /* ---------------- 定时关闭倒计时 ---------------- */

  let sleepEndAt = 0;
  let sleepTick = 0;

  /* ================= 渲染 ================= */

  function render() {
    const book = ctx.currentBook;
    const has = !!book && !!(book.sentences && book.sentences.length);
    readerEmpty.hidden = has;
    readerContent.hidden = !has;
    titleEl.textContent = book ? book.title : '未打开书籍';
    rebuildChapterSelect();
    if (!has) {
      clear(readerContent);
      activeSpan = null;
      updateProgressUI();
      updateModelBanner();
      return;
    }
    renderChapter(detectChapterIndex());
    syncAll();
    updateModelBanner();
    void refreshVoices();
    syncEngineUI();
    updateSleepQuick();
    void ctx.refreshMarks();
  }

  /** 同步「语音来源」按钮的选中态（系统语音 / 百度语音）。 */
  function syncEngineUI() {
    const el = $('#engine-switch');
    if (!el) return;
    const cur = app.getSettings().ttsEngine || 'system';
    // 百度语音默认对所有人隐藏（额度=钱）：只有站长用专属链接解锁过的设备才看得到。
    // 只剩系统语音时整行「语音来源」都不显示——单个选项没有意义，还占屏幕。
    const unlocked = app.isCloudUnlocked ? app.isCloudUnlocked() : false;
    const cloudBtn = el.querySelector('[data-engine="cloud"]');
    if (cloudBtn) cloudBtn.hidden = !unlocked;
    const row = $('#engine-row-source');
    if (row) row.hidden = !unlocked;
    for (const b of el.querySelectorAll('[data-engine]')) {
      b.setAttribute('aria-checked', String(b.dataset.engine === cur));
    }
  }

  /** 当前句所属章节下标（按字符区间判定，章节微调后依然正确）。 */
  function detectChapterIndex() {
    const book = ctx.currentBook;
    if (!book || !book.chapters || !book.chapters.length) return 0;
    const st = player.getState();
    const sentences = player.getSentences();
    const s = sentences[st.sentenceIndex];
    const off = s ? s.start : st.charOffset;
    for (let i = 0; i < book.chapters.length; i++) {
      const c = book.chapters[i];
      if (off >= c.start && off < c.end) return i;
    }
    return book.chapters.length - 1;
  }

  function rebuildChapterSelect() {
    const book = ctx.currentBook;
    clear(chapterSelect);
    if (!book || !book.chapters || !book.chapters.length) {
      chapterSelect.disabled = true;
      chapterSelect.append(el('option', { text: '—' }));
      return;
    }
    chapterSelect.disabled = false;
    book.chapters.forEach((ch, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = ch.title || `第 ${i + 1} 章`;
      chapterSelect.append(o);
    });
    chapterSelect.value = String(detectChapterIndex());
  }

  /** @param {number} chIdx */
  // 规则3：按屏懒加载——只渲染可视块±1，禁止整章全文入 DOM。
  // 每 RENDER_BLOCK_SENTENCES 句为一个渲染块；滚动/高亮越界时增量渲染。
  const RENDER_BLOCK_SENTENCES = 30;
  /** 已渲染的句索引范围（闭区间） */
  let renderFrom = -1;
  let renderTo = -1;

  function renderChapter(chIdx) {
    const book = ctx.currentBook;
    clear(readerContent);
    clearSpans();
    renderedChIdx = chIdx;
    if (!book || !book.chapters || !book.chapters.length) return;
    const ch = book.chapters[Math.max(0, Math.min(chIdx, book.chapters.length - 1))];
    if (!ch) return;

    readerContent.append(el('h2', { class: 'chapter-heading', text: ch.title || `第 ${ch.index + 1} 章` }));

    const sentences = player.getSentences();
    const from = Math.max(0, ch.sentenceStart || 0);
    const to = Math.min(sentences.length, ch.sentenceEnd != null ? ch.sentenceEnd : sentences.length);

    // 规则3：初始只渲染当前可视块 ± 1（约 RENDER_BLOCK_SENTENCES*3 句），不渲整章
    const st = player.getState();
    const active = st.sentenceIndex;
    const blockIdx = Math.floor(Math.max(0, active - from) / RENDER_BLOCK_SENTENCES);
    const visFrom = Math.max(from, from + (blockIdx - 1) * RENDER_BLOCK_SENTENCES);
    const visTo = Math.min(to, from + (blockIdx + 2) * RENDER_BLOCK_SENTENCES);

    renderSentenceRange(sentences, from, visFrom, visTo);
    renderFrom = visFrom;
    renderTo = visTo;
    readerContent.dataset.chIdx = String(chIdx);
    chapterSelect.value = String(chIdx);
    highlightActive();
  }

  /** 渲染指定句区间（追加到 readerContent）。 */
  function renderSentenceRange(sentences, chFrom, from, to) {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) {
      const s = sentences[i];
      if (spans.has(i)) continue; // 已渲染跳过
      const span = el('span', {
        class: `sentence${s.skippable ? ' skippable' : ''}`,
        text: s.raw,
        dataset: { idx: String(i) },
      });
      span.addEventListener('click', () => onSentenceClick(i));
      spans.set(i, span);
      frag.append(span);
    }
    if (!frag.childNodes.length) return;
    // 向后补渲染（from 小于已渲染起点）必须插到最前面：
    // 原先一律 append 到章末，会导致往回看时句子顺序错乱。
    if (from < renderFrom && firstSpanEl && firstSpanEl.parentNode === readerContent) {
      readerContent.insertBefore(frag, firstSpanEl);
      firstSpanEl = readerContent.firstChild;
    } else {
      readerContent.append(frag);
      if (!firstSpanEl) firstSpanEl = readerContent.firstChild;
    }
    if (renderFrom < 0 || from < renderFrom) renderFrom = from;
    if (to > renderTo) renderTo = to;
  }

  /** 按需扩展渲染范围（高亮/滚动越界时调用）。 */
  function ensureRendered(idx) {
    if (idx < 0) return;
    const sentences = player.getSentences();
    const book = ctx.currentBook;
    if (!book || !book.chapters || !book.chapters.length) return;
    const ch = book.chapters[Math.max(0, Math.min(renderedChIdx, book.chapters.length - 1))];
    const chFrom = Math.max(0, ch.sentenceStart || 0);
    const chTo = Math.min(sentences.length, ch.sentenceEnd != null ? ch.sentenceEnd : sentences.length);

    // 需要渲染的范围：idx 所在块 ± 1
    const blockIdx = Math.floor(Math.max(0, idx - chFrom) / RENDER_BLOCK_SENTENCES);
    const needFrom = Math.max(chFrom, chFrom + (blockIdx - 1) * RENDER_BLOCK_SENTENCES);
    const needTo = Math.min(chTo, chFrom + (blockIdx + 2) * RENDER_BLOCK_SENTENCES);

    if (needFrom < renderFrom || needTo > renderTo) {
      renderSentenceRange(sentences, chFrom, Math.min(needFrom, renderFrom), Math.max(needTo, renderTo));
    }
  }

  /** @type {Map<number, HTMLElement>} */
  const spans = new Map();
  /** 已渲染的章节下标（-1 = 未渲染） */
  let renderedChIdx = -1;
  /** 正文里最靠前的句子节点：向前补渲染时插到它前面，保证正文顺序不乱。 */
  let firstSpanEl = null;
  function clearSpans() {
    spans.clear();
    activeSpan = null;
    renderedChIdx = -1;
    renderFrom = -1;
    renderTo = -1;
    firstSpanEl = null;
  }

  function onSentenceClick(idx) {
    resumeFollow(); // 点正文句子 = 想跟这附近读，恢复跟随
    void player.seekToSentence(idx);
  }

  function highlightActive() {
    const st = player.getState();
    const idx = st.sentenceIndex;
    if (activeSpan) activeSpan.classList.remove('active');
    // 规则3：高亮句可能在已渲染范围之外 → 增量扩展渲染
    ensureRendered(idx);
    let span = spans.get(idx);
    if (!span && renderedChIdx !== detectChapterIndex()) {
      // 跨章：重渲染当前章（renderChapter 会先写 renderedChIdx，不会递归）
      renderChapter(detectChapterIndex());
      span = spans.get(idx);
    }
    if (span) {
      span.classList.add('active');
      activeSpan = span;
      maybeScrollToActive();
    } else {
      activeSpan = null;
    }
  }

  /**
   * 把"正在朗读的句子"滚到容器高度约 35% 处。
   * 之前用 scrollIntoView({block:'nearest'})：只要句子还在屏幕里就完全不滚，
   * 结果当前句长期贴在底部（甚至被控制区压住），看起来就是"没跟住"。
   */
  function targetTopFor(span) {
    const cRect = readerScroll.getBoundingClientRect();
    const sRect = span.getBoundingClientRect();
    const want = readerScroll.scrollTop + (sRect.top - cRect.top) - cRect.height * 0.35 + sRect.height / 2;
    const max = Math.max(0, readerScroll.scrollHeight - readerScroll.clientHeight);
    return Math.max(0, Math.min(want, max));
  }

  function maybeScrollToActive() {
    if (!followOn || manualPaused || !activeSpan) return;
    const top = targetTopFor(activeSpan);
    if (Math.abs(readerScroll.scrollTop - top) < 4) return; // 已在位，别抖
    progTop = top;
    lastProgAt = Date.now();
    lastScrollTop = top;
    clearTimeout(progClearTimer);
    progClearTimer = setTimeout(() => { progTop = null; }, 1500);
    try {
      readerScroll.scrollTo({ top, behavior: 'smooth' });
    } catch {
      readerScroll.scrollTop = top;
    }
  }

  function updateFollowHint() {
    if (!followHint) return;
    const show = followOn && manualPaused;
    followHint.hidden = !show;
    followHint.classList.toggle('counting', show);
  }

  /** 恢复跟随（点提示 / 点句子 / 重新勾选） */
  function resumeFollow() {
    clearTimeout(resumeTimer);
    manualPaused = false;
    updateFollowHint();
    maybeScrollToActive();
  }

  /** 软暂停：提示可点，8 秒无操作自动恢复 */
  function pauseFollow() {
    if (!followOn) return;
    manualPaused = true;
    updateFollowHint();
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(resumeFollow, FOLLOW_RESUME_MS);
  }

  readerScroll.addEventListener('scroll', () => {
    if (!followOn) return;
    const top = readerScroll.scrollTop;
    const delta = Math.abs(top - lastScrollTop);
    lastScrollTop = top;
    // 自己滚的：目标位置已到（±8px）或刚发起 250ms 内 → 不算手动
    if (progTop != null && (Math.abs(top - progTop) < 8 || Date.now() - lastProgAt < 250)) return;
    if (Date.now() - lastProgAt < 250) return;
    // 只把"明显滑动"当作用户操作：句子渲染/换行会带来几像素的位移，
    // 若也重置 8 秒计时，朗读过程中会永远回不到跟随状态（实测踩过）。
    if (delta >= 24) pauseFollow();
  });

  if (followHint) {
    followHint.addEventListener('click', () => resumeFollow());
  }

  followToggle.addEventListener('change', () => {
    followOn = followToggle.checked;
    clearTimeout(resumeTimer);
    manualPaused = false;
    updateFollowHint();
    if (followOn) maybeScrollToActive();
  });

  /* ================= 状态同步 ================= */

  function syncAll() {
    const st = player.getState();
    setStatusUI(st.status, st.error);
    setPlayIcon(st.status);
    highlightActive();
    chapterSelect.value = String(detectChapterIndex());
    updateRateUI(st.rate);
    updateVolumeUI(st.volume);
    updateProgressUI();
  }

  function setStatusUI(status, error) {
    const key = STATUS_TEXT[status] ? status : 'idle';
    // loading 时显示动态合成提示（让用户知道在干什么、还要多久）
    if (status === 'loading') {
      const st = player.getState();
      const sent = player.getSentences();
      const cur = sent[st.sentenceIndex];
      const hint = cur ? `「${cur.raw.slice(0, 15)}…」` : '';
      const engineId = app && app.registry && app.registry.active ? app.registry.active.id : '';
      // 云端 1~5 秒；本地 wasm 合成慢很多，明确告知"不是故障"
      const eta = engineId === 'cloud-http'
        ? '约 3~8 秒'
        : '约 10~30 秒，请耐心等待，不是故障';
      badge.textContent = `🎙️ 正在合成语音…${hint}（${eta}）`;
    } else {
      badge.textContent = STATUS_TEXT[key];
    }
    badge.className = `badge badge-${key}`;
    const hasErr = key === 'error';
    errorPanel.hidden = !hasErr;
    if (hasErr) errorText.textContent = error || '播放出错，请重试';
  }

  function setPlayIcon(status) {
    const playing = status === 'playing';
    const loading = status === 'loading' || status === 'buffering';
    const use = btnPlay.querySelector('use');
    if (use) use.setAttribute('href', playing ? '#ic-pause' : '#ic-play');
    btnPlay.setAttribute('aria-label', playing ? '暂停' : loading ? '加载中' : '播放');
    btnPlay.classList.toggle('is-loading', loading);
  }

  function updateRateUI(rate) {
    const r = Number(rate) || 1;
    rateRange.value = String(r);
    rateVal.textContent = `${r.toFixed(2)}×`;
    const setRateEl = $('#set-rate');
    const setRateVal = $('#set-rate-val');
    if (setRateEl) setRateEl.value = String(r);
    if (setRateVal) setRateVal.textContent = `${r.toFixed(2)}×`;
  }

  function updateVolumeUI(v) {
    const vol = Number(v);
    const val = Number.isFinite(vol) ? vol : 1;
    volRange.value = String(val);
    volVal.textContent = `${Math.round(val * 100)}%`;
    const setVolEl = $('#set-vol');
    const setVolVal = $('#set-vol-val');
    if (setVolEl) setVolEl.value = String(val);
    if (setVolVal) setVolVal.textContent = `${Math.round(val * 100)}%`;
  }

  function updateProgressUI() {
    const book = ctx.currentBook;
    const st = player.getState();
    if (!book) {
      posInfo.textContent = '第 0 / 0 句';
      chapterProgress.textContent = '本章 —';
      bookProgress.textContent = '全书 —';
      remainInfo.textContent = '剩余 —';
      seekRange.disabled = true;
      seekRange.max = '1';
      seekRange.value = '0';
      return;
    }
    seekRange.disabled = false;
    const total = Math.max(1, book.text.length);
    const off = Math.max(0, Math.min(st.charOffset, total));
    seekRange.max = String(total);
    if (!seekDragging) seekRange.value = String(off);

    bookProgress.textContent = `全书 ${Math.round((off / total) * 100)}%`;

    const ch = ctx.currentBook.chapters[detectChapterIndex()];
    if (ch) {
      const span = Math.max(1, ch.end - ch.start);
      const pct = Math.round(Math.max(0, Math.min(1, (off - ch.start) / span)) * 100);
      chapterProgress.textContent = `本章 ${pct}%`;
    }

    const sentences = player.getSentences();
    posInfo.textContent = `第 ${sentences.length ? st.sentenceIndex + 1 : 0} / ${sentences.length} 句`;

    const remainChars = Math.max(0, total - off);
    remainInfo.textContent = `剩余 ${formatSeconds(app.estimateDuration(remainChars, st.rate))}`;
  }

  const throttledProgress = throttleFrame(() => updateProgressUI());

  /* ================= 事件入口（由 main 转发） ================= */

  function onSentence() {
    const st = player.getState();
    const sentences = player.getSentences();
    const s = sentences[st.sentenceIndex];
    const chIdx = detectChapterIndex();
    if (chapterSelect.value !== String(chIdx)) chapterSelect.value = String(chIdx);
    // 当前章变化 → 重渲染
    const renderedIdx = readerContent.dataset.chIdx;
    if (renderedIdx !== String(chIdx)) {
      renderChapter(chIdx);
    } else {
      highlightActive();
    }
    if (s) throttledProgress();
    updateProgressUI();
  }

  /**
   * @param {any} patch STATE 事件载荷（可能是全量状态、局部补丁，或 {model}/{sleep}）
   */
  /** 上次渲染音色列表时的活跃引擎（引擎变化需重刷，否则会残留别的引擎的音色）。 */
  let lastVoiceEngine = '';
  /** 音色列表刷新代号：并发调用时只让最后一次渲染生效。 */
  let voicesGen = 0;

  function onState(patch) {
    if (!patch) return;
    if (patch.status) setStatusUI(patch.status, patch.error);
    if (patch.status) setPlayIcon(patch.status);
    if (patch.model) {
      updateModelBanner();
      void refreshVoices(); // 模型状态变化时刷新音色列表（去掉/加上"未下载"标签）
    }
    // 活跃引擎切换（云端 ↔ 本地）时刷新音色列表：不同引擎音色 ID 不通用，混在一起会「选男声出女声」
    const engineId = app.registry && app.registry.active ? app.registry.active.id : '';
    if (engineId && engineId !== lastVoiceEngine) {
      lastVoiceEngine = engineId;
      syncEngineUI();
      void refreshVoices();
    }
    if ('sleep' in patch) updateSleepUI(patch.sleep);
    if (patch.rate !== undefined) updateRateUI(patch.rate);
    if (patch.volume !== undefined) updateVolumeUI(patch.volume);
    if (patch.sentenceIndex !== undefined || patch.charOffset !== undefined || patch.status) syncAll();
    if (patch.error && patch.status === 'error') {
      setStatusUI('error', patch.error);
    }
  }

  function onProgress() {
    throttledProgress();
  }

  /* ================= 模型横幅 ================= */

  /**
   * 模型横幅：只在「本地离线引擎」真正需要模型时出现（下载中 / 初始化中 / 出错）。
   * v4 起默认是系统语音，不再自动下载任何模型——原来的"正在自动下载…"文案是假的，必须去掉。
   * 下载入口只保留在设置页（离线模型区）。
   */
  function updateModelBanner() {
    const settings = app.getSettings();
    const engine = settings.ttsEngine || 'system';
    const isLocal = engine === 'local-sherpa' || engine === 'local-piper';
    const ms = app.modelState();
    const activeId = app.registry && app.registry.active ? app.registry.active.id : '';

    if (!isLocal) {
      banner.hidden = true;
      return;
    }

    const usePiper = engine === 'local-piper';
    const tierLabel = usePiper
      ? (settings.modelTier === 'x_low' ? 'Piper 省流档 21MB' : 'Piper 标准档 63MB')
      : (settings.sherpaTier === 'full' ? '标准档 121MB' : '省流档 39MB');
    const downloading = ms.status === 'downloading';
    const error = ms.status === 'error';
    const warmingUp = !downloading && !error && ms.status === 'ready' && activeId === 'speech-preview';
    const needDownload = !downloading && !error && !warmingUp && ms.status !== 'ready';

    banner.hidden = !(downloading || error || warmingUp || needDownload);
    banner.classList.remove('is-preview');
    bannerTrack.hidden = !downloading;

    if (downloading) {
      const elapsed = ms.startTime ? (Date.now() - ms.startTime) / 1000 : 0;
      let eta = '';
      if (ms.progress > 2 && elapsed > 1) {
        const remaining = Math.round((elapsed / ms.progress) * (100 - ms.progress));
        if (remaining > 60) eta = `，预计还需 ${Math.ceil(remaining / 60)} 分钟`;
        else if (remaining > 0) eta = `，预计还需 ${remaining} 秒`;
      }
      bannerText.textContent = `⏳ 正在下载${tierLabel}（${ms.progress}%）${eta} —— 下载期间用系统语音先听，只需下载一次。`;
      bannerBar.style.width = `${ms.progress}%`;
      downloadText.textContent = `${ms.progress}%`;
      $('#btn-download-model').disabled = true;
    } else if (warmingUp) {
      bannerText.textContent = '🎙️ 正在初始化本地语音引擎…（约 5~15 秒）—— 先用系统语音朗读，完成后自动切换';
      downloadText.textContent = '初始化中…';
      $('#btn-download-model').disabled = true;
    } else if (error) {
      bannerText.textContent = `❌ 本地模型下载失败：${ms.error || '未知错误'}。当前用系统语音朗读，可点右侧重试。`;
      downloadText.textContent = '重试下载';
      $('#btn-download-model').disabled = false;
    } else if (needDownload) {
      // 用户显式选了本地引擎但模型还没下：给一个明确按钮（设置页也有）
      bannerText.textContent = `离线引擎需要先下载${tierLabel}（${tierLabel.includes('121') ? '较大' : '约 39~63MB'}），当前用系统语音先听。`;
      downloadText.textContent = `下载 ${tierLabel}`;
      $('#btn-download-model').disabled = false;
    }
  }

  function onDownloadModel() {
    const settings = app.getSettings();
    // 引擎未就绪时默认下载当前引擎的默认档；用户在设置里选的档位由 downloadModel 内部读取
    const tier = settings.ttsEngine === 'local-piper' ? settings.modelTier : settings.sherpaTier;
    updateModelBanner();
    void app.downloadModel(tier);
  }

  /* ================= 定时关闭 ================= */

  /** 把下拉框同步回 app 里真实的定时状态（取消自定义时也能回正）。 */
  function restoreSleepSelect() {
    const cur = app.getSleepTimer();
    if (!cur || cur.kind === 'off') {
      sleepSelect.value = 'off';
      return;
    }
    if (cur.kind === 'chapter') {
      sleepSelect.value = 'chapter';
      return;
    }
    const hasOption = [...sleepSelect.options].some((o) => o.value === String(cur.minutes));
    sleepSelect.value = hasOption ? String(cur.minutes) : 'custom';
  }

  function updateSleepUI(sleep) {
    updateSleepQuick();
    if (!sleep || sleep.kind === 'off') {
      if (sleepTick) clearInterval(sleepTick);
      sleepTick = 0;
      sleepEndAt = 0;
      sleepLabel.hidden = true;
      sleepSelect.value = 'off';
      return;
    }
    sleepLabel.hidden = false;
    if (sleep.kind === 'chapter') {
      if (sleepTick) clearInterval(sleepTick);
      sleepTick = 0;
      sleepText.textContent = '读完本章停止';
      sleepSelect.value = 'chapter';
      return;
    }
    // duration：本地倒计时（app 只在设定时给一次 remainingMs）
    sleepEndAt = Date.now() + (sleep.remainingMs != null ? sleep.remainingMs : (sleep.minutes || 0) * 60000);
    restoreSleepSelect();
    const tick = () => {
      const left = sleepEndAt - Date.now();
      if (left <= 0) {
        if (sleepTick) clearInterval(sleepTick);
        sleepTick = 0;
        sleepLabel.hidden = true;
        sleepSelect.value = 'off';
        return;
      }
      sleepText.textContent = `定时 ${formatClock(left)}`;
    };
    tick();
    if (sleepTick) clearInterval(sleepTick);
    sleepTick = setInterval(tick, 1000);
  }

  async function onSleepSelect() {
    const v = sleepSelect.value;
    if (v === 'off') {
      app.setSleepTimer({ kind: 'off' });
      return;
    }
    if (v === 'chapter') {
      app.setSleepTimer({ kind: 'chapter' });
      return;
    }
    if (v === 'custom') {
      const input = await ctx.modal.prompt({
        title: '自定义定时关闭',
        label: '多少分钟后停止（1–600）',
        value: '45',
        inputType: 'number',
        confirmLabel: '开始计时',
      });
      if (input == null) {
        restoreSleepSelect();
        return;
      }
      const minutes = Math.max(1, Math.min(600, parseInt(input, 10) || 0));
      if (!minutes) {
        ctx.toast('请输入 1–600 之间的分钟数', 'warn');
        restoreSleepSelect();
        return;
      }
      app.setSleepTimer({ kind: 'duration', minutes });
      return;
    }
    app.setSleepTimer({ kind: 'duration', minutes: Number(v) });
  }

  /* ================= 音色 ================= */

  async function refreshVoices() {
    const settings = app.getSettings();
    // 只展示「当前活跃引擎」的音色：音色 ID 跨引擎不通用（选了本地音色传给云端会被兜底成默认音色）
    const activeId = app.registry && app.registry.active ? app.registry.active.id : '';
    // 先把数据全部取完，再一次性替换 DOM：
    // 原实现先 clear 再逐组 await，refreshVoices 被多处并发调用时会互相插队，
    // 结果下拉框里出现多份重复分组（实测 3 份同源 optgroup）。
    const gen = ++voicesGen;
    const groups = [];
    for (const adapter of app.registry.list()) {
      if (activeId && adapter.id !== activeId) continue;
      let voices = [];
      if (adapter.id === 'local-piper') {
        // 不调用其 listVoices()：未就绪时它会触发模型下载（下拉框渲染不该下载 63MB）
        const ms = app.modelState();
        const customId = app.getActiveCustomVoice();
        if (customId) {
          // 自定义音色生效中（用户自备模型）
          voices = [{
            id: customId,
            label: `自定义 · ${String(customId).replace(/^custom:/, '')}${ms.status === 'ready' ? '' : '（未下载/未就绪）'}`,
            kind: 'local',
            dialogueCapable: false,
          }];
        } else {
          const tier = settings.modelTier;
          const meta = app.MODEL_TIERS[tier];
          voices = [{
            id: `huayan-${tier}`,
            label: `慧妍 · ${meta ? meta.label : tier}${ms.status === 'ready' ? '' : '（未下载）'}`,
            kind: 'local',
            dialogueCapable: false,
          }];
        }
      } else if (adapter.id === 'cloud-http' && settings.ttsEngine !== 'cloud') {
        continue; // 不是百度引擎时不展示其音色（以 ttsEngine 为准，cloudTtsEnabled 只是镜像）
      } else {
        try {
          voices = await adapter.listVoices();
        } catch {
          voices = [];
        }
      }
      if (!voices.length) continue;
      groups.push({ label: adapter.label, voices });
    }
    // 期间又有新的刷新请求（引擎/模型变化）→ 丢弃本次结果，避免旧数据覆盖新数据
    if (gen !== voicesGen) return;

    clear(voiceSelect);
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '默认';
    voiceSelect.append(def);
    for (const g of groups) {
      const group = document.createElement('optgroup');
      group.label = g.label;
      for (const v of g.voices) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.label;
        group.append(o);
      }
      voiceSelect.append(group);
    }
    const wanted = settings.voice || '';
    voiceSelect.value = wanted;
    if (voiceSelect.value !== wanted) voiceSelect.value = '';

    // 音色行自适应：没有可选音色时整行隐藏（系统语音不暴露列表，用户也换不了；
    // 指引放在设置→TTS 引擎里，避免播放页多一行看不懂的提示）
    const total = groups.reduce((n, g) => n + g.voices.length, 0);
    const previewBtn = $('#btn-voice-preview');
    const voiceRow = $('#voice-row');
    if (total === 0) {
      voiceSelect.hidden = true;
      if (previewBtn) previewBtn.hidden = true;
      if (voiceRow) voiceRow.hidden = true;
    } else {
      voiceSelect.hidden = false;
      if (previewBtn) previewBtn.hidden = false;
      if (voiceRow) voiceRow.hidden = false;
    }
  }

  /* ================= 控制绑定 ================= */

  function togglePlay() {
    const st = player.getState();
    // loading/buffering 也算「正在播」：云端合成有 3~8 秒窗口，若此时点按钮不响应，
    // 用户会判定"按钮坏了、停不下来"。这里统一走 pause（会中止在途合成）。
    if (st.status === 'playing' || st.status === 'loading' || st.status === 'buffering') {
      player.pause();
    } else {
      // 立即变暂停图标（不等异步状态事件）
      const use = btnPlay.querySelector('use');
      if (use) use.setAttribute('href', '#ic-pause');
      btnPlay.setAttribute('aria-label', '暂停');
      btnPlay.classList.remove('is-loading');
      // 关键：在用户手势上下文内同步调 speechSynthesis（否则 360Browser 不出声）
      if (typeof speechSynthesis !== 'undefined') {
        try {
          const warm = new SpeechSynthesisUtterance('。');
          warm.volume = 0;
          speechSynthesis.speak(warm); // 无声预热，激活浏览器语音引擎
        } catch { /* ignore */ }
      }
      void player.play();
    }
  }

  btnPlay.addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', () => void player.prevSentence());
  $('#btn-next').addEventListener('click', () => void player.nextSentence());
  // 章节按钮：无书时给出提示，不要静默无反应（用户会以为按钮坏了）
  $('#btn-prev-ch').addEventListener('click', () => {
    const book = ctx.currentBook;
    if (!book) { ctx.toast('还没有打开的书', 'warn'); return; }
    void player.prevChapter(book.chapters);
  });
  $('#btn-next-ch').addEventListener('click', () => {
    const book = ctx.currentBook;
    if (!book) { ctx.toast('还没有打开的书', 'warn'); return; }
    void player.nextChapter(book.chapters);
  });
  $('#btn-retry').addEventListener('click', () => void player.play());
  $('#btn-back').addEventListener('click', () => ctx.router.go('#shelf'));
  $('#btn-go-shelf').addEventListener('click', () => ctx.router.go('#shelf'));
  $('#btn-download-model').addEventListener('click', onDownloadModel);

  // 语速：拖动时只更新数字显示，松手（change）才真正改语速。
  // 原因：setRate 会作废当前块并重新合成，input 每帧都调会导致"反复掐断+重复合成"，
  // 云端按字计费，一次拖动能烧掉几十句的额度，声音也会一直卡断。
  rateRange.addEventListener('input', () => {
    const r = Number(rateRange.value);
    rateVal.textContent = `${r.toFixed(2)}×`;
    const setRateEl = $('#set-rate');
    const setRateVal = $('#set-rate-val');
    if (setRateEl) setRateEl.value = String(r);
    if (setRateVal) setRateVal.textContent = `${r.toFixed(2)}×`;
  });
  rateRange.addEventListener('change', () => {
    const r = Number(rateRange.value);
    player.setRate(r); // 松手才生效（一次）
    rateVal.textContent = `${r.toFixed(2)}×`;
    void app.updateSettings({ rate: r }); // 持久化
  });

  volRange.addEventListener('input', () => {
    const v = Number(volRange.value);
    player.setVolume(v);
    volVal.textContent = `${Math.round(v * 100)}%`;
    const setVolEl = $('#set-vol');
    const setVolVal = $('#set-vol-val');
    if (setVolEl) setVolEl.value = String(v);
    if (setVolVal) setVolVal.textContent = `${Math.round(v * 100)}%`;
  });
  volRange.addEventListener('change', () => {
    void app.updateSettings({ volume: Number(volRange.value) });
  });

  // 系统语音的音色列表是异步填充的（Chrome 首次 getVoices() 为空，会触发 voiceschanged）
  if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.addEventListener) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      const eng = app.getSettings().ttsEngine || 'system';
      if (eng === 'system') void refreshVoices();
    });
  }

  voiceSelect.addEventListener('change', () => {
    const id = voiceSelect.value || null;
    player.setVoice(id);
    void app.updateSettings({ voice: id });
  });

  // 语音来源切换（系统语音 / 百度语音）——常驻可见，手机上也能点到
  const engineSwitch = $('#engine-switch');
  if (engineSwitch) {
    engineSwitch.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-engine]') : null;
      if (!btn) return;
      const engine = btn.dataset.engine;
      const cur = app.getSettings().ttsEngine || 'system';
      if (engine === cur) return;
      void (async () => {
        await app.updateSettings({ ttsEngine: engine });
        syncEngineUI();
        ctx.toast(engine === 'cloud' ? '已切换到百度语音' : '已切换到手机自带语音', 'success');
        ctx.onVoicesChanged();
      })();
    });
  }

  sleepSelect.addEventListener('change', () => void onSleepSelect());

  chapterSelect.addEventListener('change', () => {
    const book = ctx.currentBook;
    if (!book) return;
    const ch = book.chapters[Number(chapterSelect.value)];
    if (ch) void player.seekToSentence(ch.sentenceStart);
  });

  /* 进度条：input 预览、change 定位（seekToCharOffset） */
  seekRange.addEventListener('pointerdown', () => { seekDragging = true; });
  seekRange.addEventListener('pointerup', () => { seekDragging = false; });
  seekRange.addEventListener('input', () => { seekDragging = true; });
  seekRange.addEventListener('change', () => {
    seekDragging = false;
    if (!ctx.currentBook) return;
    void player.seekToCharOffset(Number(seekRange.value));
  });

  /* ================= 书签 ================= */

  async function addMark() {
    if (!ctx.currentBook) {
      ctx.toast('请先打开书籍', 'warn');
      return;
    }
    const note = await ctx.modal.prompt({
      title: '添加书签',
      label: '备注（可留空）',
      placeholder: '例如：这一段很精彩',
      confirmLabel: '保存',
    });
    if (note == null) return;
    await app.addMark(note);
    await ctx.refreshMarks();
  }

  $('#btn-add-mark').addEventListener('click', () => void addMark());
  $('#btn-bookmarks').addEventListener('click', () => ctx.openMarks());

  /* ================= 导出音频 ================= */

  async function exportAudio(scope) {
    const book = ctx.currentBook;
    if (!book) {
      ctx.toast('请先打开书籍', 'warn');
      return;
    }
    const ac = new AbortController();
    const bar = el('div', { class: 'progress-fill', text: '' });
    bar.style.width = '0%';
    const track = el('div', { class: 'progress-track' }, [bar]);
    const label = el('p', { text: '正在合成并合并 WAV…（未缓存的块会现场合成，整本导出耗时较长，可取消）' });
    const pct = el('p', { text: '0%' });
    const m = ctx.modal.open({
      title: scope === 'chapter' ? '导出当前章音频' : '导出全书音频',
      content: el('div', {}, [label, track, pct]),
      actions: [{ label: '取消', value: 'cancel', ghost: true }],
      onAction: (_v, close) => {
        ac.abort();
        close();
      },
    });
    try {
      const blob = await app.exportAudio({
        scope,
        signal: ac.signal,
        onProgress: (p) => {
          const v = Math.round(Math.max(0, Math.min(1, p)) * 100);
          bar.style.width = `${v}%`;
          pct.textContent = `${v}%`;
        },
      });
      const ch = ctx.currentBook.chapters[detectChapterIndex()];
      const suffix = scope === 'chapter' && ch ? `-${safeFileName(ch.title || 'chapter')}` : '-全书';
      downloadBlob(blob, `${safeFileName(book.title)}${suffix}.wav`);
      m.close();
      ctx.toast('音频已导出（WAV）', 'success');
    } catch (e) {
      m.close();
      if (ac.signal.aborted) ctx.toast('已取消导出', 'info');
      else ctx.toast(`导出失败：${e && e.message ? e.message : e}`, 'error');
    }
  }

  $('#btn-export-chapter').addEventListener('click', () => void exportAudio('chapter'));
  $('#btn-export-book').addEventListener('click', () => void exportAudio('book'));

  /* ================= 更多控件（定时/书签/导出） ================= */
  // 展开后若超出可视区（矮屏机型），自动把它滚进视野，避免"只显示一半"
  const ctlMoreEl = document.querySelector('.ctl-more');
  if (ctlMoreEl) {
    ctlMoreEl.addEventListener('toggle', () => {
      if (!ctlMoreEl.open) return;
      const first = ctlMoreEl.querySelector('.btn, button');
      if (!first) return;
      requestAnimationFrame(() => {
        try { first.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      });
    });
  }

  /* ================= 本书操作 ================= */
  // 正文区的「⋯」下拉菜单已移除：窄屏时该行会换行把它挤到左边，
  // 菜单以 right:0 展开，左半截跑到屏幕外（看起来"空盒子"），还白占一行高度。
  // 功能统一挪到「设置 → 本书操作」，这里保留空实现供各操作项复用。
  function closeMenu() { /* 菜单已移除：无需收起 */ }

  /* ---- 手动标记章节 ---- */

  async function splitChapter() {
    const book = ctx.currentBook;
    if (!book) return;
    const st = player.getState();
    const sentences = player.getSentences();
    const cur = sentences[st.sentenceIndex];
    const defaultOffset = cur ? cur.start : 1;
    const maxOffset = Math.max(1, book.text.length - 1);

    const offsetInput = el('input', { attrs: { type: 'number', min: '1', max: String(maxOffset), 'aria-label': '切分字符偏移' } });
    offsetInput.value = String(defaultOffset);
    const titleInput = el('input', { attrs: { type: 'text', placeholder: '新章节名，如：第三章 风起', 'aria-label': '新章节名' } });
    const content = el('div', { class: 'modal-field' }, [
      el('span', { text: '字符偏移（默认当前句起始位置）' }),
      offsetInput,
      el('span', { text: '新章节名' }),
      titleInput,
      el('p', { text: '将从该偏移处切出新的一章（仅在本章内部有效）。' }),
    ]);

    ctx.modal.open({
      title: '手动标记章节',
      content,
      actions: [
        { label: '取消', value: null, ghost: true },
        { label: '在此标记章节', value: 'ok', primary: true },
      ],
      onAction: (value, close) => {
        if (value !== 'ok') {
          close();
          return;
        }
        const offset = parseInt(offsetInput.value, 10);
        const title = titleInput.value.trim();
        close();
        applyChapterSplit(offset, title);
      },
    });
  }

  function applyChapterSplit(offset, title) {
    const book = ctx.currentBook;
    if (!book) return;
    if (!Number.isFinite(offset) || offset <= 0 || offset >= book.text.length) {
      ctx.toast('偏移必须在 1 到正文长度之间', 'warn');
      return;
    }
    void commitChapters(() => app.markChapterAt(book.id, offset, title), '已在此处标记新章节');
  }

  async function mergeChapter() {
    const book = ctx.currentBook;
    if (!book) return;
    const st = player.getState();
    const sentences = player.getSentences();
    const cur = sentences[st.sentenceIndex];
    const off = cur ? cur.start : st.charOffset;
    let idx = -1;
    for (let i = 0; i < book.chapters.length; i++) {
      const c = book.chapters[i];
      if (off >= c.start && off < c.end) { idx = i; break; }
    }
    if (idx <= 0) {
      ctx.toast('当前已是第一章，没有可合并的上一章', 'warn');
      return;
    }
    void commitChapters(() => app.mergeChapter(book.id, idx), '已合并到上一章');
  }

  /**
   * 通过 app 的章节写回 API（markChapterAt / mergeChapter：持久化 + 触发 BOOKS 事件），
   * 成功后在会话内回填句子边界并重绘，让当前播放位置立即可用。
   * @param {() => Promise<Array>} op
   * @param {string} message 成功提示前缀
   */
  async function commitChapters(op, message) {
    const book = ctx.currentBook;
    try {
      const next = await op();
      if (!book || !next || !next.length) return;
      const sentences = player.getSentences();
      const bound = bindChapterSentences(next, sentences);
      book.chapters = bound;
      for (const s of sentences) {
        for (const c of bound) {
          if (s.start >= c.start && s.start < c.end) {
            s.chapter = c.index;
            break;
          }
        }
      }
      rebuildChapterSelect();
      renderChapter(detectChapterIndex());
      ctx.toast(`${message}（已写回书库，重新打开仍保留）`, 'success');
    } catch (e) {
      ctx.toast(`章节操作失败：${e && e.message ? e.message : e}`, 'error');
    }
  }

  /* ---- 重命名 / 删除 / 统计 ---- */

  async function showStats() {
    const s = await app.getStats();
    ctx.modal.open({
      title: '收听统计',
      content: el('div', {}, [
        el('p', { text: `今日收听：${formatDuration(s.todayMs)}` }),
        el('p', { text: `累计收听：${formatDuration(s.totalMs)}` }),
        el('p', { text: `连续收听：${s.streak} 天` }),
        el('p', { text: `有记录天数：${s.days} 天` }),
      ]),
      actions: [{ label: '关闭', value: 'close', primary: true }],
    });
  }

  $('#btn-m-split').addEventListener('click', () => { closeMenu(); void splitChapter(); });
  $('#btn-m-merge').addEventListener('click', () => { closeMenu(); void mergeChapter(); });
  $('#btn-m-rename').addEventListener('click', () => {
    closeMenu();
    if (ctx.currentBook) void ctx.shelf.renameBook(ctx.currentBook);
  });
  $('#btn-m-delete').addEventListener('click', () => {
    closeMenu();
    if (ctx.currentBook) void ctx.shelf.deleteBook(ctx.currentBook);
  });
  $('#btn-m-stats').addEventListener('click', () => { closeMenu(); void showStats(); });

  /* ================= 字号与行距 ================= */
  const fontPanel = $('#font-panel');
  const fontSizeRange = $('#font-size-range');
  const lineHeightRange = $('#line-height-range');
  const fontSizeVal = $('#font-size-val');
  const lineHeightVal = $('#line-height-val');

  function applyFontSettings() {
    const fs = fontSizeRange.value;
    const lh = lineHeightRange.value;
    document.documentElement.style.setProperty('--reader-fs', `${fs}rem`);
    document.documentElement.style.setProperty('--reader-lh', lh);
    fontSizeVal.textContent = `${fs}rem`;
    lineHeightVal.textContent = lh;
    try {
      localStorage.setItem('tinttxt.readerFont', JSON.stringify({ fs: Number(fs), lh: Number(lh) }));
    } catch { /* 隐私模式 */ }
  }

  function restoreFontSettings() {
    try {
      const raw = localStorage.getItem('tinttxt.readerFont');
      if (raw) {
        const { fs, lh } = JSON.parse(raw);
        if (fs) fontSizeRange.value = fs;
        if (lh) lineHeightRange.value = lh;
      }
    } catch { /* ignore */ }
    applyFontSettings();
  }
  restoreFontSettings();

  fontSizeRange.addEventListener('input', applyFontSettings);
  lineHeightRange.addEventListener('input', applyFontSettings);
  $('#btn-font-reset').addEventListener('click', () => {
    fontSizeRange.value = 1.05;
    lineHeightRange.value = 1.95;
    applyFontSettings();
  });
  $('#btn-font-close').addEventListener('click', () => {
    fontPanel.hidden = true;
  });
  fontPanel.addEventListener('click', (e) => {
    if (e.target === fontPanel) fontPanel.hidden = true;
  });
  $('#btn-m-font').addEventListener('click', () => {
    closeMenu();
    fontPanel.hidden = false;
  });

  /* ================= 音色试听 ================= */
  $('#btn-voice-preview').addEventListener('click', async () => {
    const btn = $('#btn-voice-preview');
    const voiceId = voiceSelect.value || null;
    // 正在播放时不允许试听（speechSynthesis.cancel 会打断朗读）
    if (player.getState().status === 'playing') {
      ctx.toast('正在播放中，请先暂停再试听', 'warn');
      return;
    }
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const adapter = app.registry.active;
      if (!adapter) throw new Error('引擎不可用');
      const sample = '你好，我是当前音色，试听这段话来感受效果。';
      const res = await adapter.synthesize(sample, {
        voice: voiceId || undefined,
        rate: player.getState().rate,
      });
      if (res.preview) {
        // speechSynthesis 试听（仅在非播放状态，不会打断）
        const u = new SpeechSynthesisUtterance(sample);
        if (voiceId && typeof speechSynthesis !== 'undefined') {
          const v = speechSynthesis.getVoices().find((x) => x.voiceURI === voiceId);
          if (v) u.voice = v;
        }
        speechSynthesis.speak(u);
      } else if (res.blob && res.blob.size) {
        const url = URL.createObjectURL(res.blob);
        const audio = new Audio(url);
        audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
        audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        await audio.play();
      }
    } catch (e) {
      ctx.toast(`试听失败：${(e && e.message) || e}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '▶';
    }
  });

  /* ================= 睡眠定时快捷入口 ================= */
  const sleepQuickBtn = $('#btn-sleep-quick');
  // 快捷按钮循环档位（与设置面板下拉框一致的语义）
  const SLEEP_CYCLE = ['off', '15', '30', '60', 'chapter'];
  const SLEEP_LABELS = { off: '定时', '15': '15分钟', '30': '30分钟', '60': '60分钟', 'chapter': '读完章' };

  /** 根据 timer 状态推算当前在 SLEEP_CYCLE 中的位置。 */
  function sleepCyclePos(timer) {
    if (!timer || !timer.kind || timer.kind === 'off') return 0;
    if (timer.kind === 'chapter') return SLEEP_CYCLE.indexOf('chapter');
    // kind='duration'：按 minutes 匹配档位
    const m = String(timer.minutes || '');
    const idx = SLEEP_CYCLE.indexOf(m);
    return idx >= 0 ? idx : 0; // 自定义值不在循环里 → 从头开始
  }

  /** 只管理快捷按钮外观（不碰倒计时标签——那是 updateSleepUI 的职责）。 */
  function updateSleepQuick() {
    const timer = app.getSleepTimer();
    const kind = timer && timer.kind && timer.kind !== 'off' ? timer.kind : 'off';
    const labelKey = kind === 'duration' ? String(timer.minutes || '') : kind;
    sleepQuickBtn.querySelector('span').textContent = SLEEP_LABELS[labelKey] || '定时';
    sleepQuickBtn.classList.toggle('is-active', kind !== 'off');
  }

  sleepQuickBtn.addEventListener('click', () => {
    cycleSleepTimer(sleepQuickBtn);
  });
  // mini-player 行内的定时按钮（同一套循环逻辑）
  const miniSleepBtn = $('#btn-mini-sleep');
  if (miniSleepBtn) miniSleepBtn.addEventListener('click', () => cycleSleepTimer(miniSleepBtn));

  /** 睡眠菜单的「点外部关闭」监听器清理函数（所有关闭路径都要调，避免监听器累积）。 */
  let sleepPopupCleanup = null;

  function cycleSleepTimer(anchorBtn) {
    // 弹出选择菜单（不是静默循环——用户要看到选项）
    const existing = $('#sleep-popup');
    if (existing) {
      existing.remove();
      if (sleepPopupCleanup) { sleepPopupCleanup(); sleepPopupCleanup = null; }
      return; // 再点关闭
    }
    const popup = document.createElement('div');
    popup.id = 'sleep-popup';
    popup.className = 'sleep-popup';
    const opts = [
      { val: 'off', label: '关闭定时' },
      { val: '15', label: '15 分钟后停止' },
      { val: '30', label: '30 分钟后停止' },
      { val: '60', label: '60 分钟后停止' },
      { val: 'chapter', label: '读完本章停止' },
    ];
    const timer = app.getSleepTimer();
    const current = timer && timer.kind === 'duration' ? String(timer.minutes || '') : (timer && timer.kind === 'chapter') ? 'chapter' : 'off';
    for (const o of opts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `sleep-popup-item${o.val === current ? ' is-active' : ''}`;
      btn.textContent = o.label;
      btn.addEventListener('click', () => {
        popup.remove();
        if (sleepPopupCleanup) { sleepPopupCleanup(); sleepPopupCleanup = null; }
        if (o.val === 'off') {
          app.clearSleepTimer?.();
        } else if (o.val === 'chapter') {
          app.setSleepTimer?.({ kind: 'chapter' });
        } else {
          app.setSleepTimer?.({ kind: 'duration', minutes: Number(o.val) });
        }
        const sel = $('#sleep-select');
        if (sel) sel.value = o.val;
        updateSleepQuick();
        ctx.toast(o.val === 'off' ? '已关闭定时' : `定时关闭：${o.label}`, 'info');
      });
      popup.append(btn);
    }
    // 定位到被点击的按钮上方
    const btnRect = (anchorBtn || sleepQuickBtn).getBoundingClientRect();
    popup.style.cssText = `position:fixed;bottom:${window.innerHeight - btnRect.top + 8}px;right:1rem;z-index:300;`;
    document.body.append(popup);
    // 点外部关闭
    setTimeout(() => {
      const close = (e) => {
        if (!popup.contains(e.target)) {
          popup.remove();
          document.removeEventListener('click', close);
          sleepPopupCleanup = null;
        }
      };
      sleepPopupCleanup = () => document.removeEventListener('click', close);
      document.addEventListener('click', close);
    }, 50);
  }

  /* ================= 对外 ================= */

  return {
    render,
    onSentence,
    onState,
    onProgress,
    updateModelBanner,
    refreshVoices,
    syncAll,
    closeMenu,
  };
}
