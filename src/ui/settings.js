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
  const chkCloud = $('#chk-cloud');
  const cloudNote = $('#cloud-note');
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
    chkCloud.checked = !!s.cloudTtsEnabled;
    cloudNote.hidden = !s.cloudTtsEnabled;
    if (cloudEndpointRow) cloudEndpointRow.hidden = !s.cloudTtsEnabled;
    if (cloudEndpointInput) cloudEndpointInput.value = s.cloudEndpoint || '';

    chkWakelock.checked = !!s.wakelockEnabled;
    if (!wakeSupported) {
      chkWakelock.disabled = true;
      wakelockNote.hidden = false;
      wakelockNote.textContent = '当前浏览器不支持 Wake Lock（不支持）';
    } else {
      wakelockNote.hidden = true;
    }

    // 引擎与档位：档位选项按引擎分组显示，值分别写入 ttsEngine / sherpaTier / modelTier
    const engine = s.ttsEngine === 'local-piper' ? 'local-piper' : 'local-sherpa';
    for (const r of engineRadios) r.checked = r.value === engine;
    const usePiper = engine === 'local-piper';
    if (tierSherpaGroup) tierSherpaGroup.hidden = usePiper;
    if (tierPiperGroup) tierPiperGroup.hidden = !usePiper;
    const activeTier = usePiper ? s.modelTier : s.sherpaTier;
    for (const r of tierRadios) r.checked = r.value === activeTier;
    void refreshDialogueNote();
    void refreshCustomVoices();
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

  setRate.addEventListener('input', () => {
    const r = Number(setRate.value);
    app.player.setRate(r);
    setRateVal.textContent = `${r.toFixed(2)}×`;
    const p = $('#rate-range');
    const pv = $('#rate-val');
    if (p) p.value = String(r);
    if (pv) pv.textContent = `${r.toFixed(2)}×`;
  });
  setRate.addEventListener('change', () => void app.updateSettings({ rate: Number(setRate.value) }));

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

  /* 云端 TTS：必须隐私确认 + 必须先配置端点（否则开启即报错） */
  const cloudEndpointRow = $('#cloud-endpoint-row');
  const cloudEndpointInput = $('#cloud-endpoint');

  chkCloud.addEventListener('change', () => {
    if (chkCloud.checked) {
      void (async () => {
        const ans = await ctx.modal.confirm({
          title: '开启云端 TTS？',
          message: '开启后每段文本将发送到你配置的云端服务器，本地模型则完全离线。确认开启？',
          confirmLabel: '确认开启',
          cancelLabel: '保持关闭',
        });
        if (ans !== 'confirm') {
          chkCloud.checked = false; // 未确认 → 保持关闭
          cloudNote.hidden = true;
          return;
        }
        // 端点缺失时要求填写，取消则不启用（避免开启即报错）
        let endpoint = (cloudEndpointInput.value || '').trim();
        if (!endpoint) {
          endpoint = (await ctx.modal.prompt({
            title: '配置云端 TTS 端点',
            message: '请输入接受 POST JSON 并返回音频的接口地址：',
            placeholder: 'https://your-server.example.com/tts',
            confirmLabel: '保存并开启',
          }) || '').trim();
        }
        if (!endpoint) {
          chkCloud.checked = false;
          cloudNote.hidden = true;
          ctx.toast('未填写端点，云端 TTS 保持关闭', 'warn');
          return;
        }
        cloudEndpointInput.value = endpoint;
        await app.updateSettings({ cloudEndpoint: endpoint, cloudTtsEnabled: true });
        cloudNote.hidden = false;
        cloudEndpointRow.hidden = false;
        ctx.toast('云端 TTS 已开启', 'warn');
        ctx.onVoicesChanged();
      })();
    } else {
      void (async () => {
        await app.updateSettings({ cloudTtsEnabled: false });
        cloudNote.hidden = true;
        ctx.toast('云端 TTS 已关闭，恢复本地朗读', 'success');
        ctx.onVoicesChanged();
      })();
    }
  });

  // 端点即时保存（仅存本机设置，不发网络）
  cloudEndpointInput.addEventListener('change', () => {
    const v = (cloudEndpointInput.value || '').trim();
    void app.updateSettings({ cloudEndpoint: v });
    if (v) ctx.toast('云端端点已保存', 'success');
  });

  /* TTS 引擎切换 */
  for (const r of engineRadios) {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      const engine = r.value;
      await app.updateSettings({ ttsEngine: engine });
      const label = engine === 'local-piper'
        ? 'Piper 中文档（默认：合成快、音色自然；仅个人非商业）'
        : 'sherpa-onnx 档（Apache-2.0 可商用，单线程合成较慢）';
      ctx.toast(`已切换引擎：${label}`, engine === 'local-piper' ? 'success' : 'warn');
      syncFromSettings();
      ctx.onModelChanged();
      ctx.onVoicesChanged();
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
