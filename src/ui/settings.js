/**
 * UI 层 —— 设置抽屉（右侧滑出，移动端全屏）
 * 主题三态持久化（dataset.theme + localStorage + app.updateSettings）、朗读参数、
 * 跳行规则、章节正则测试、对话音色降级标注、云端 TTS 隐私确认、模型档位、Wake Lock、关于。
 * @module ui/settings
 */

import { $, $$, el, supportsWakeLock, formatDateTime } from './dom.js';
import { DEFAULT_CHAPTER_REGEX } from '../layers/structure/chapters.js';

/** @param {object} ctx */
export function createSettings(ctx) {
  const app = ctx.app;

  const drawer = $('#settings-drawer');
  const backdrop = $('#drawer-backdrop');

  const segBtns = $$('.seg-btn[data-theme-value]');
  const setRate = $('#set-rate');
  const setRateVal = $('#set-rate-val');
  const setVol = $('#set-vol');
  const setVolVal = $('#set-vol-val');
  const chkPunct = $('#chk-punct');
  const chkNumbers = $('#chk-numbers');
  const chkSkipEmpty = $('#chk-skip-empty');
  const chkSkipNotes = $('#chk-skip-notes');
  const chkSkipSep = $('#chk-skip-separators');
  const txtRegex = $('#txt-regex');
  const regexResult = $('#regex-result');
  const chkDialogue = $('#chk-dialogue');
  const dialogueNote = $('#dialogue-note');
  const chkWakelock = $('#chk-wakelock');
  const wakelockNote = $('#wakelock-note');
  const tierRadios = $$('input[name="model-tier"]');
  const engineRadios = $$('input[name="tts-engine"]');
  const tierSherpaGroup = $('#tier-sherpa-group');
  const tierPiperGroup = $('#tier-piper-group');

  /* 自定义音色模型 */
  const voiceList = $('#custom-voice-list');
  const voiceEmpty = $('#custom-voice-empty');
  const voiceFileInput = $('#voice-file-input');
  const voiceImportHint = $('#voice-import-hint');

  const wakeSupported = supportsWakeLock();

  /* ---------------- 主题 ---------------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('tinttxt.theme', theme);
    } catch { /* 隐私模式忽略 */ }
  }

  function onThemePick(e) {
    const btn = e.currentTarget;
    const theme = btn.dataset.themeValue;
    if (!theme) return;
    for (const b of segBtns) b.setAttribute('aria-checked', String(b === btn));
    applyTheme(theme);
    void app.updateSettings({ theme });
  }

  /* ---------------- 对话音色能力（降级标注） ---------------- */

  async function refreshDialogueNote() {
    const active = app.registry.active;
    let capable = false;
    if (active.id !== 'local-piper') {
      // local-piper 不调用 listVoices()：未就绪时会触发模型下载
      try {
        const voices = await active.listVoices();
        capable = voices.some((v) => v.dialogueCapable);
      } catch {
        capable = false;
      }
    }
    if (capable) {
      dialogueNote.hidden = true;
    } else {
      dialogueNote.hidden = false;
      dialogueNote.textContent = '当前引擎不支持对话音色，已降级忽略';
    }
  }

  /* ---------------- 自定义音色模型（用户自备文件，应用不分发） ---------------- */

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  /** 列表展示：名称 / 大小 / 导入时间 + 使用·删除；当前使用的高亮。 */
  async function refreshCustomVoices() {
    if (!voiceList) return;
    let items = [];
    try {
      items = await app.listCustomVoices();
    } catch (e) {
      if (typeof caches === 'undefined') {
        // 特性缺失：显示「不支持」而不是反复弹错
        if (voiceEmpty) {
          voiceEmpty.hidden = false;
          voiceEmpty.textContent = '当前浏览器不支持本地缓存，无法导入自定义音色（不支持）。';
        }
        return;
      }
      ctx.toast(`读取自定义音色失败：${e && e.message ? e.message : e}`, 'error');
      items = [];
    }
    const activeId = app.getActiveCustomVoice();
    // 只移除列表项，保留空状态占位（voiceEmpty 是 voiceList 的子节点）
    for (const child of [...voiceList.children]) {
      if (child !== voiceEmpty) child.remove();
    }
    if (voiceEmpty) {
      voiceEmpty.hidden = items.length > 0;
      if (voiceEmpty.parentNode !== voiceList) voiceList.append(voiceEmpty);
    }

    for (const v of items) {
      const row = el('div', { class: `voice-item${v.id === activeId ? ' is-active' : ''}`, attrs: { role: 'listitem' } });

      const meta = el('div', { class: 'voice-meta' });
      const name = el('span', { class: 'voice-name', text: String(v.label || v.id || '未命名') });
      if (v.id === activeId) name.append(el('span', { class: 'voice-badge', text: '使用中' }));
      meta.append(name);
      const bits = [formatBytes(v.bytes), v.importedAt ? `导入于 ${formatDateTime(v.importedAt)}` : ''];
      meta.append(el('span', { class: 'voice-sub', text: bits.filter(Boolean).join(' · ') }));
      row.append(meta);

      const actions = el('div', { class: 'voice-actions' });
      const useBtn = el('button', {
        class: 'btn btn-sm btn-primary',
        text: v.id === activeId ? '使用中' : '使用',
        attrs: { type: 'button', 'aria-label': `使用自定义音色 ${v.label || v.id}` },
        onClick: () => void useCustomVoice(v.id),
      });
      if (v.id === activeId) useBtn.disabled = true;
      actions.append(
        useBtn,
        el('button', {
          class: 'btn btn-sm',
          text: '删除',
          attrs: { type: 'button', 'aria-label': `删除自定义音色 ${v.label || v.id}` },
          onClick: () => void removeCustomVoice(v),
        }),
      );
      row.append(actions);
      voiceList.append(row);
    }
  }

  /** 文件 input 必须由按钮手势触发（accept=".onnx,.json" multiple）。 */
  function pickVoiceFiles() {
    voiceFileInput.value = '';
    voiceFileInput.click();
  }

  async function importVoiceModels() {
    const files = [...(voiceFileInput.files || [])];
    if (!files.length) return;
    try {
      const res = await app.importVoiceModel(files);
      ctx.toast(`已导入音色模型：${res && res.label ? res.label : ''}`.trim(), 'success');
      await refreshCustomVoices();
      ctx.onVoicesChanged();
    } catch (e) {
      // app 抛出的已是中文可读文案
      ctx.toast(e && e.message ? e.message : String(e), 'error');
    } finally {
      voiceFileInput.value = '';
    }
  }

  async function useCustomVoice(id) {
    try {
      await app.useCustomVoice(id);
      ctx.toast('已切换到该自定义音色', 'success');
      await refreshCustomVoices();
      ctx.onVoicesChanged();
    } catch (e) {
      ctx.toast(e && e.message ? e.message : String(e), 'error');
    }
  }

  async function useBuiltinVoice() {
    try {
      await app.useCustomVoice(null);
      ctx.toast('已回到内置音色', 'success');
      await refreshCustomVoices();
      ctx.onVoicesChanged();
    } catch (e) {
      ctx.toast(e && e.message ? e.message : String(e), 'error');
    }
  }

  async function removeCustomVoice(v) {
    const ans = await ctx.modal.confirm({
      title: '删除自定义音色',
      message: `确定删除「${v.label || v.id}」吗？模型文件会从本机缓存移除（可重新导入）。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (ans !== 'confirm') return;
    try {
      await app.removeCustomVoice(v.id);
      ctx.toast('已删除自定义音色', 'success');
      await refreshCustomVoices();
      ctx.onVoicesChanged();
    } catch (e) {
      ctx.toast(e && e.message ? e.message : String(e), 'error');
    }
  }

  /* ---------------- 同步 UI ---------------- */

  function syncFromSettings() {
    const s = app.getSettings();
    for (const b of segBtns) b.setAttribute('aria-checked', String(b.dataset.themeValue === s.theme));

    const rate = Number(s.rate) || 1;
    setRate.value = String(rate);
    setRateVal.textContent = `${rate.toFixed(2)}×`;
    const vol = Number(s.volume);
    const v = Number.isFinite(vol) ? vol : 1;
    setVol.value = String(v);
    setVolVal.textContent = `${Math.round(v * 100)}%`;

    chkPunct.checked = !!s.readPunctuation;
    chkNumbers.checked = !!s.normalizeNumbers;
    chkSkipEmpty.checked = !!s.skipEmptyLines;
    chkSkipNotes.checked = !!s.skipNotes;
    chkSkipSep.checked = !!s.skipSeparators;
    txtRegex.value = s.chapterRegex || DEFAULT_CHAPTER_REGEX;
    chkDialogue.checked = !!s.dialogueVoice;

    chkWakelock.checked = !!s.wakelockEnabled;
    if (!wakeSupported) {
      chkWakelock.disabled = true;
      wakelockNote.hidden = false;
      wakelockNote.textContent = '当前浏览器不支持 Wake Lock（不支持）';
    } else {
      wakelockNote.hidden = true;
    }

    // 引擎与档位：四选一（system / cloud / local-sherpa / local-piper）
    const engine = ['system', 'cloud', 'local-piper', 'local-sherpa'].includes(s.ttsEngine) ? s.ttsEngine : 'system';
    for (const r of engineRadios) r.checked = r.value === engine;
    const usePiper = engine === 'local-piper';
    // 档位只对本地引擎有意义；系统/云端时整块隐藏
    if (tierSherpaGroup) tierSherpaGroup.hidden = engine !== 'local-sherpa';
    if (tierPiperGroup) tierPiperGroup.hidden = !usePiper;
    const activeTier = usePiper ? s.modelTier : s.sherpaTier;
    for (const r of tierRadios) r.checked = r.value === activeTier;
    // 下载入口只在「本地离线」引擎下出现；系统/百度语音不需要模型
    const isLocal = engine === 'local-sherpa' || engine === 'local-piper';
    const modelHint = $('#model-section-hint');
    if (modelHint) modelHint.hidden = isLocal;
    const dlBtn = $('#btn-settings-download');
    const dlRow = dlBtn && dlBtn.parentElement;
    if (dlRow) dlRow.hidden = !isLocal;
    if (dlBtn) dlBtn.disabled = !isLocal;
    void refreshDialogueNote();
    void refreshCustomVoices();

    // 百度语音只对解锁过的设备可见（额度=钱，公开站点默认全隐藏）
    const unlocked = app.isCloudUnlocked ? app.isCloudUnlocked() : false;
    const cloudRow = $('#engine-cloud-row');
    if (cloudRow) cloudRow.hidden = !unlocked;
    const engineNote = $('#engine-note');
    if (engineNote) {
      engineNote.textContent = unlocked
        ? '默认使用手机自带语音：不联网、不花钱、音色最好。百度语音仅本机可见（按字消耗额度，请按需使用）。'
        : '默认使用手机自带语音：不联网、不花钱、音色最好。百度语音已关闭（避免消耗额度）。';
    }

    // 版本号：排查问题时要靠它确认设备跑的是哪一版（避免被浏览器缓存骗了）
    const buildEl = $('#app-build');
    if (buildEl) {
      const info = app.getBuildInfo ? app.getBuildInfo() : { build: 'dev', sw: false };
      buildEl.textContent = info.build || 'dev';
      buildEl.title = info.sw ? '已由 Service Worker 接管' : '未接管（将每次联网加载最新代码）';
    }

    // 本书操作：只在有打开的书时出现（原来在正文区放「⋯」下拉，窄屏会溢出屏幕外）
    const bookGroup = $('#book-actions-group');
    if (bookGroup) {
      let hasBook = false;
      try {
        const st = app.player && app.player.getState ? app.player.getState() : null;
        hasBook = !!(st && st.bookId);
      } catch { hasBook = false; }
      bookGroup.hidden = !hasBook;
    }
  }

  /* ---------------- 开关 ---------------- */

  function open() {
    syncFromSettings();
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    syncBackdrop();
    setTimeout(() => $('#btn-settings-close')?.focus(), 60);
  }

  function close() {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    syncBackdrop();
  }

  function isOpen() {
    return drawer.classList.contains('is-open');
  }

  function syncBackdrop() {
    const marksOpen = $('#marks-drawer')?.classList.contains('is-open');
    const any = isOpen() || marksOpen;
    backdrop.hidden = !any;
    backdrop.classList.toggle('is-on', any);
  }

  /* ---------------- 事件绑定 ---------------- */

  for (const b of segBtns) b.addEventListener('click', onThemePick);

  // 语速：拖动只更新显示，松手才真正生效（setRate 会作废当前块并重新合成，逐帧调用=反复重合成）
  setRate.addEventListener('input', () => {
    const r = Number(setRate.value);
    setRateVal.textContent = `${r.toFixed(2)}×`;
    const p = $('#rate-range');
    const pv = $('#rate-val');
    if (p) p.value = String(r);
    if (pv) pv.textContent = `${r.toFixed(2)}×`;
  });
  setRate.addEventListener('change', () => {
    const r = Number(setRate.value);
    app.player.setRate(r);
    setRateVal.textContent = `${r.toFixed(2)}×`;
    void app.updateSettings({ rate: r });
  });

  setVol.addEventListener('input', () => {
    const v = Number(setVol.value);
    app.player.setVolume(v);
    setVolVal.textContent = `${Math.round(v * 100)}%`;
    const p = $('#vol-range');
    const pv = $('#vol-val');
    if (p) p.value = String(v);
    if (pv) pv.textContent = `${Math.round(v * 100)}%`;
  });
  setVol.addEventListener('change', () => void app.updateSettings({ volume: Number(setVol.value) }));

  chkPunct.addEventListener('change', async () => {
    await app.updateSettings({ readPunctuation: chkPunct.checked });
    ctx.toast('标点朗读已更新，需重新打开书籍生效', 'info');
  });
  chkNumbers.addEventListener('change', async () => {
    await app.updateSettings({ normalizeNumbers: chkNumbers.checked });
    ctx.toast('数字正则化已更新，需重新打开书籍生效', 'info');
  });

  const onSkipChange = async () => {
    await app.updateSettings({
      skipEmptyLines: chkSkipEmpty.checked,
      skipNotes: chkSkipNotes.checked,
      skipSeparators: chkSkipSep.checked,
    });
    ctx.toast('跳行规则已更新，需重新打开书籍生效', 'info');
  };
  chkSkipEmpty.addEventListener('change', onSkipChange);
  chkSkipNotes.addEventListener('change', onSkipChange);
  chkSkipSep.addEventListener('change', onSkipChange);

  /* 章节正则 */
  function persistRegex() {
    const value = txtRegex.value.trim() || DEFAULT_CHAPTER_REGEX;
    void app.updateSettings({ chapterRegex: value });
    regexResult.textContent = '章节正则已保存，需重新打开书籍生效。';
    return value;
  }
  txtRegex.addEventListener('change', persistRegex);

  $('#btn-regex-default').addEventListener('click', () => {
    txtRegex.value = DEFAULT_CHAPTER_REGEX;
    persistRegex();
    ctx.toast('已恢复默认章节正则', 'success');
  });

  $('#btn-regex-test').addEventListener('click', () => {
    const value = persistRegex();
    const book = ctx.currentBook;
    if (!book || !book.text) {
      regexResult.textContent = '请先打开一本书，再用它的正文测试正则。';
      return;
    }
    try {
      const chapters = app.detectChapters(book.text, value);
      regexResult.textContent = `测试完成：当前书《${book.title}》识别到 ${chapters.length} 章（${chapters.slice(0, 3).map((c) => c.title).join(' / ')}${chapters.length > 3 ? ' …' : ''}）。`;
    } catch (e) {
      regexResult.textContent = `正则测试失败：${e && e.message ? e.message : e}`;
    }
  });

  /* 自定义音色模型 */
  $('#btn-import-voice').addEventListener('click', pickVoiceFiles);
  $('#btn-use-builtin-voice').addEventListener('click', () => void useBuiltinVoice());
  voiceFileInput.addEventListener('change', () => void importVoiceModels());

  /* 对话音色 */
  chkDialogue.addEventListener('change', async () => {
    await app.updateSettings({ dialogueVoice: chkDialogue.checked });
    void refreshDialogueNote();
    if (chkDialogue.checked && dialogueNote.hidden === false) {
      ctx.toast('当前引擎不支持对话音色，已降级忽略', 'warn');
    }
  });

  /*
   * 原先这里有一个「云端语音（默认开启）」开关 —— 已删除。
   * 原因：它和上面的「TTS 引擎」单选框重复，而且"默认开启"的描述早已不成立
   * （百度语音现在默认对所有人关闭，只有站长用专属链接解锁）。留着只会让人以为
   * 打开开关就能用百度，实际会被服务端 403。引擎选择以单选框为唯一入口。
   */

  /* TTS 引擎切换 */
  const ENGINE_LABELS = {
    system: '手机自带语音',
    cloud: '百度云端语音',
    'local-sherpa': '本地 sherpa-onnx',
    'local-piper': '本地 Piper 中文',
  };
  for (const r of engineRadios) {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      const engine = r.value;
      await app.updateSettings({ ttsEngine: engine });
      ctx.toast(`已切换语音来源：${ENGINE_LABELS[engine] || engine}`, 'success');
      syncFromSettings();
      ctx.onModelChanged();
      ctx.onVoicesChanged();
    });
  }

  // 存储清理：离线模型 / 朗读缓存
  const btnClearModels = $('#btn-clear-models');
  if (btnClearModels) {
    btnClearModels.addEventListener('click', () => {
      void (async () => {
        if (app.modelState().status === 'downloading') {
          ctx.toast('正在下载模型，请等下载完成后（或先切到系统语音）再清除', 'warn');
          return;
        }
        const ans = await ctx.modal.confirm({
          title: '清除已下载的离线模型？',
          message: '会删除 sherpa / Piper / 自定义音色模型文件（释放 39~121MB）。之后想用本地语音需要重新下载。',
          confirmLabel: '清除',
          cancelLabel: '取消',
        });
        if (ans !== 'confirm') return;
        try { await app.clearOfflineModels(); } catch (e) { ctx.toast(`清除失败：${(e && e.message) || e}`, 'error'); return; }
        syncFromSettings();
        // 运行时（wasm/内存）还在，刷新才算真干净
        setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 800);
      })();
    });
  }
  const btnClearSpeech = $('#btn-clear-speech');
  if (btnClearSpeech) {
    btnClearSpeech.addEventListener('click', () => {
      void (async () => {
        try { await app.clearSpeechCache(); } catch (e) { ctx.toast(`清除失败：${(e && e.message) || e}`, 'error'); }
      })();
    });
  }

  // 检查更新（设置 → 关于）
  const btnCheckUpdate = $('#btn-check-update');
  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', () => {
      void (async () => {
        const status = $('#update-status');
        const bridge = window.__SW_BRIDGE__;
        if (!bridge || !bridge.supported) {
          if (status) status.textContent = '当前浏览器不支持 Service Worker（不影响朗读）';
          return;
        }
        if (status) status.textContent = '检查中…（最多 15 秒）';
        const res = await bridge.checkForUpdate();
        if (res && res.hasUpdate) {
          if (status) status.textContent = '发现新版本，正在更新…';
          ctx.toast('发现新版本，正在更新…', 'info');
          const reg = window.__SW_BRIDGE__ && window.__SW_BRIDGE__.registration;
          if (reg && reg.waiting) {
            // 新 SW 已就绪：先让它接管再刷新
            let reloaded = false;
            const doReload = () => {
              if (reloaded) return;
              reloaded = true;
              try { location.reload(); } catch { /* ignore */ }
            };
            window.addEventListener('__SW_CONTROLLING__', doReload, { once: true });
            try { bridge.skipWaiting(); } catch { /* ignore */ }
            setTimeout(doReload, 3000);
          } else {
            // 新 SW 没进 waiting（安装被节流/中断）：硬重置——注销 SW + 清 SW 缓存 + 刷新
            await bridge.hardUpdate();
          }
        } else {
          const v = app.getBuildInfo ? app.getBuildInfo().build : 'dev';
          if (status) status.textContent = `已是最新版本（${v}）`;
          ctx.toast(`已是最新版本（${v}）`, 'success');
        }
      })();
    });
  }

  /* 模型下载按钮（产品规则：凡涉及下载必须有明确按钮 + 实时看得懂的进度提示） */
  const btnSettingsDownload = $('#btn-settings-download');
  const settingsDownloadText = $('#btn-settings-download-text');
  const settingsDownloadStatus = $('#settings-download-status');
  let downloadTick = 0;

  function renderDownloadStatus() {
    if (!btnSettingsDownload) return;
    const ms = app.modelState();
    const s = app.getSettings();
    const label = s.ttsEngine === 'local-piper'
      ? (s.modelTier === 'x_low' ? 'Piper 省流档 x_low · 21MB' : 'Piper 标准档 medium · 63MB')
      : (s.sherpaTier === 'full' ? 'sherpa 标准档 full · 121MB' : 'sherpa 省流档 int8 · 39MB');
    if (ms.status === 'downloading') {
      settingsDownloadText.textContent = `下载中 ${ms.progress}%`;
      btnSettingsDownload.disabled = true;
      settingsDownloadStatus.textContent = `正在下载 ${label}：${ms.progress}% —— 完成后自动生效，可离开本页`;
    } else if (ms.status === 'ready') {
      settingsDownloadText.textContent = '下载当前档位模型';
      btnSettingsDownload.disabled = false;
      settingsDownloadStatus.textContent = `${label} 已就绪，可直接使用 ✓`;
    } else if (ms.status === 'error') {
      settingsDownloadText.textContent = '重试下载';
      btnSettingsDownload.disabled = false;
      settingsDownloadStatus.textContent = `下载失败：${ms.error || '未知错误'} —— 点按钮重试`;
    } else {
      settingsDownloadText.textContent = `下载 ${label}`;
      btnSettingsDownload.disabled = false;
      settingsDownloadStatus.textContent = '尚未下载。点击后这里会显示实时进度。';
    }
  }

  function startDownloadTick() {
    renderDownloadStatus();
    if (app.modelState().status === 'downloading' && !downloadTick) {
      downloadTick = setTimeout(() => {
        downloadTick = 0;
        startDownloadTick();
      }, 500);
    }
  }

  // 自动下载（开书/引擎回落/切档位）也要在设置面板显示实时进度：
  // 原来只有点本面板的下载按钮才启动轮询，自动下载时面板里一直显示"尚未下载"。
  app.bus.on('playback:state', (patch) => {
    if (patch && patch.model) startDownloadTick();
  });

  btnSettingsDownload.addEventListener('click', () => {
    const s = app.getSettings();
    const tier = s.ttsEngine === 'local-piper' ? s.modelTier : s.sherpaTier;
    void app.downloadModel(tier); // 状态同步置为 downloading，随后开轮询刷新进度
    startDownloadTick();
  });
  renderDownloadStatus(); // 打开设置即显示当前状态

  /* 模型档位（按当前引擎写入对应设置项） */
  for (const r of tierRadios) {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      const usePiper = app.getSettings().ttsEngine === 'local-piper';
      if (usePiper) {
        await app.updateSettings({ modelTier: r.value });
        const label = r.value === 'x_low' ? '省流档 x_low（21MB）' : '标准档 medium（63MB）';
        ctx.toast(`已切换到${label}，需重新下载模型后生效`, 'warn');
      } else {
        await app.updateSettings({ sherpaTier: r.value });
        const label = r.value === 'full' ? '标准档 full（121MB）' : '省流档 int8（39MB）';
        ctx.toast(`已切换到${label}，需重新下载模型后生效`, 'warn');
      }
      ctx.onModelChanged();
      ctx.onVoicesChanged(); // 音色标签随档位变化（如 aishell3-int8 → full）
    });
  }

  /* Wake Lock */
  chkWakelock.addEventListener('change', async () => {
    await app.updateSettings({ wakelockEnabled: chkWakelock.checked });
    ctx.toast(chkWakelock.checked ? '已开启保持亮屏' : '已关闭保持亮屏', 'info');
  });

  $('#btn-settings-close').addEventListener('click', () => ctx.router.go(`#${ctx.router.prevView()}`));

  return { open, close, isOpen, syncFromSettings, syncBackdrop, applyTheme, refreshDialogueNote, refreshCustomVoices };
}
