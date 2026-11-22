/**
 * 应用装配层：把五层接起来，暴露给 UI 层一个 App 对象。
 * UI 层只调用 app.xxx()，不直接 import 存储/播放内部实现。
 * @module app
 */

import { Events, createBus } from './core/contracts.js';
import { decodeTextFile, readFileAsArrayBuffer } from './layers/file/encoding.js';
import { detectChapters, bindChapterSentences, splitChapterAt, mergeChapterIntoPrev, DEFAULT_CHAPTER_REGEX } from './layers/structure/chapters.js';
import { buildSentences } from './layers/structure/sentences.js';
import { toSpeakText } from './layers/structure/normalize.js';
import * as store from './layers/storage/index.js';
import { createStateWriter } from './layers/storage/index.js';
import { createPlayer } from './layers/playback/player.js';
import { createWakeLockManager, createDiagnostics } from './layers/playback/system.js';
import { createLocalSherpaAdapter, SHERPA_TIERS } from './layers/playback/tts/sherpa.js';
import { createLocalPiperAdapter, MODEL_TIERS } from './layers/playback/tts/local.js';
import { createCloudTtsAdapter, createSpeechPreviewAdapter } from './layers/playback/tts/cloud.js';
import { TtsRegistry } from './layers/playback/tts/index.js';
import { clearAudioCache } from './layers/playback/tts/audio-cache.js';
import { getOwnerKey, setOwnerKey, isCloudUnlocked } from './core/owner.js';

/** sha-256 hex，用于内容哈希与文件改动检测。 */
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createApp() {
  const bus = createBus();

  // 专属链接解锁：?owner=<key> —— 只有站长自己会打开这个链接。
  // 解锁后本机才显示百度语音；同时把 key 从地址栏抹掉，避免被书签/分享带出去。
  try {
    const u = new URL(window.location.href);
    const k = u.searchParams.get('owner');
    if (k) {
      setOwnerKey(k);
      u.searchParams.delete('owner');
      window.history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      // 后台校验密钥是否真的有效：错的 key 会让百度语音一直报 403，
      // 所以校验失败就清掉并提示，而不是留个"看得见用不了"的入口。
      fetch('/api/owner-check', { headers: { 'x-tinttxt-owner': k } })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && j.locked && !j.ok) {
            setOwnerKey('');
            bus.emit(Events.TOAST, { message: '专属链接无效，百度语音保持关闭', level: 'warn' });
            setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 1200);
          } else if (j && j.ok && j.locked) {
            bus.emit(Events.TOAST, { message: '百度语音已在本机启用（仅本机可见）', level: 'success' });
          }
        })
        .catch(() => { /* 离线：保留乐观解锁，联网后再判 */ });
    }
  } catch { /* 解析失败：忽略 */ }

  let settings = await store.getSettings();
  // 默认关闭云端语音：旧设备存着 ttsEngine='cloud' 也要拉回系统语音（否则会一直吃额度）
  if (settings.ttsEngine === 'cloud' && !isCloudUnlocked()) {
    settings = await store.saveSettings({ ttsEngine: 'system', cloudTtsEnabled: false, voice: null });
  }
  /** 构建号（部署时注入到 index.html 的 meta）：用于确认设备上跑的是哪一版。 */
  const buildInfo = (() => {
    try {
      const m = document.querySelector('meta[name="app-build"]');
      return { build: m && m.content ? m.content : 'dev', sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
    } catch {
      return { build: 'dev', sw: false };
    }
  })();

  /* ---------------- TTS 注册 ---------------- */
  const registry = new TtsRegistry();
  const sherpaAdapter = createLocalSherpaAdapter(); // 默认：全 Apache-2.0，无 GPL 链
  const localAdapter = createLocalPiperAdapter();   // 可选：含 espeak-ng GPL 与 huayan 许可限制
  const previewAdapter = createSpeechPreviewAdapter();
  // 云端适配器持有可变配置对象：端点存于 settings.cloudEndpoint，随时可改
  // 云端 TTS 端点：默认用当前域名的 /api/tts（Pages Functions，国内可达）
  // 本地开发服务器没有该接口 → localhost 下默认不用云端（除非显式配置端点）
  const isLocalHost = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(location.hostname);
  const defaultCloudEndpoint = (typeof location !== 'undefined' && !isLocalHost) ? `${location.origin}/api/tts` : '';
  /** 连续云端失败次数：≥2 则临时回落本地；60 秒后自动重试云端 */
  let cloudFailStreak = 0;
  let cloudFallbackNotified = false;
  let cloudRetryTimer = 0;
  const resetCloudHealth = () => {
    if (cloudRetryTimer) { clearTimeout(cloudRetryTimer); cloudRetryTimer = 0; }
    cloudFailStreak = 0;
    cloudFallbackNotified = false;
  };
  const cloudConfig = {
    endpoint: settings.cloudEndpoint || defaultCloudEndpoint,
    onSuccess: () => { cloudFailStreak = 0; cloudFallbackNotified = false; },
    onFailure: (e) => {
      cloudFailStreak += 1;
      if (cloudFailStreak < 2) return;
      if (!cloudFallbackNotified) {
        cloudFallbackNotified = true;
        const why = e && e.message ? `（${e.message}）` : '';
        bus.emit(Events.TOAST, {
          message: `云端语音暂不可用${why}，已临时改用本地语音，1 分钟后自动重试`,
          level: 'warn',
        });
      }
      // 不永久降级：60 秒后自动再试云端（网络恢复即自动切回真人音色）
      if (!cloudRetryTimer) {
        cloudRetryTimer = setTimeout(() => { cloudRetryTimer = 0; cloudFailStreak = 0; cloudFallbackNotified = false; }, 60000);
      }
    },
  };
  const cloudAdapter = createCloudTtsAdapter(cloudConfig);
  registry.register(sherpaAdapter); // 必须先于 localAdapter（首个注册即默认 active）
  registry.register(localAdapter);
  registry.register(previewAdapter);
  registry.register(cloudAdapter);

  /** 切换活跃引擎；引擎变化时广播一次 STATE（音色列表等 UI 需要知道引擎变了）。 */
  function activateEngine(id) {
    const prev = registry.active ? registry.active.id : '';
    registry.setActive(id);
    if (registry.active && registry.active.id !== prev) {
      bus.emit(Events.STATE, { engine: registry.active.id });
    }
    return registry.active;
  }

  /**
   * 解析当前应使用的引擎。
   * 优先级完全由用户选择决定（v4）：
   *   'system'      → 手机自带语音（默认；真机反馈音色最好）
   *   'cloud'       → 百度云端（默认关闭；失败时回落系统语音）
   *   'local-sherpa'/'local-piper' → 本地离线（默认关闭，选中才下载模型/预热）
   */
  async function resolveAdapter() {
    const engine = settings.ttsEngine || 'system';

    if (engine === 'cloud') {
      // 默认关闭云端语音：只有本机用专属链接解锁过才允许。别人打开站点只会看到系统语音。
      if (!isCloudUnlocked()) return activateEngine('speech-preview');
      if (cloudConfig.endpoint && cloudFailStreak < 2) return activateEngine('cloud-http');
      // 云端暂不可用（网络/额度）→ 回落系统语音，不强制下载本地模型
      return activateEngine('speech-preview');
    }

    if (engine === 'local-piper') {
      const piperReady = await localAdapter.isReady().catch(() => false);
      if (piperReady) return activateEngine('local-piper');
      if (modelState.status === 'downloading') return activateEngine('local-piper');
      // 未下载：先用系统语音出声，同时后台下载（用户显式选了本地才下载）
      const active = activateEngine('speech-preview');
      if (modelState.status === 'idle' && !autoDownloadStarted) {
        autoDownloadStarted = true;
        void downloadModel().then(() => {
          if (modelState.status === 'ready') {
            bus.emit(Events.TOAST, { message: '✓ Piper 模型已下载，正在初始化…', level: 'info' });
            void resolveAdapter();
          }
        });
      }
      return active;
    }

    if (engine === 'local-sherpa') {
      const ready = await sherpaAdapter.isReady().catch(() => false);
      const warmedUp = sherpaAdapter.isWarmedUp();
      if (ready && warmedUp) return activateEngine('local-sherpa');
      if (modelState.status === 'downloading') return activateEngine('local-sherpa');
      if (ready && !warmedUp) {
        const a = activateEngine('speech-preview');
        if (!warmupStarted) {
          warmupStarted = true;
          void sherpaAdapter.warmup().then(() => {
            warmupStarted = false;
            bus.emit(Events.TOAST, { message: '✓ 本地语音已就绪，已自动切换', level: 'info' });
            void resolveAdapter();
          }).catch(() => { warmupStarted = false; });
        }
        return a;
      }
      // 未下载：先用系统语音出声，同时后台下载
      const active = activateEngine('speech-preview');
      if (modelState.status === 'idle' && !autoDownloadStarted) {
        autoDownloadStarted = true;
        void downloadModel().then(() => {
          if (modelState.status === 'ready') {
            bus.emit(Events.TOAST, { message: '✓ 语音模型已下载，正在初始化…', level: 'info' });
            void resolveAdapter();
          }
        });
      }
      return active;
    }

    // 默认：手机自带语音。不下载、不预热、不联网。
    return activateEngine('speech-preview');
  }

  /* ---------------- 播放器 ---------------- */
  const stateWriter = createStateWriter();
  const player = createPlayer({
    getAdapter: resolveAdapter,
    settings,
    bus,
    stateWriter,
    onStatePatch: (patch) => {
      bus.emit(Events.STATE, patch);
      if (patch.sentenceIndex !== undefined) refreshStatsBeat();
    },
  });

  const wakeLock = createWakeLockManager(bus);
  const diag = createDiagnostics(bus, () => player._diag(), () => ({
    supported: wakeLock.isSupported(),
    active: wakeLock.isActive(),
    enabled: settings.wakelockEnabled,
  }));

  /* ---------------- 书籍处理管线 ---------------- */

  /**
   * 解析文本 → 章节 → 句子（含 speak 字段），并回填章节句子边界。
   * @param {string} text
   * @param {Partial<import('./core/contracts.js').Settings>} [overrides]
   * @param {import('./core/contracts.js').Chapter[]} [existingChapters] 手动微调过的章节（优先复用）
   */
  function buildStructure(text, overrides = {}, existingChapters = null) {
    const st = { ...settings, ...overrides };
    // 手动标记/合并过的章节优先；否则按正则重新检测
    const chapters = existingChapters && existingChapters.length
      ? existingChapters.map((c) => ({ ...c }))
      : detectChapters(text, st.chapterRegex || DEFAULT_CHAPTER_REGEX);
    const sentences = buildSentences(text, chapters, {
      skipRules: {
        empty: st.skipEmptyLines,
        notes: st.skipNotes,
        separators: st.skipSeparators,
      },
    });
    // 生成 speak（正则化 + 标点策略）
    for (const s of sentences) s.speak = toSpeakText(s, st);
    const bound = bindChapterSentences(chapters, sentences);
    return { chapters: bound, sentences };
  }

  /**
   * 导入文件（必须由用户手势触发）。支持多选批量。
   * 批量语义：逐文件隔离错误——单个文件失败不中断其余文件；
   * 全部处理完后若有失败则抛出第一个错误（单文件调用时行为与旧版一致）。
   * @param {File[]} files
   * @param {{forceEncoding?: string}} [opts]
   * @returns {Promise<Array<{book: object, warning?: string}>>}
   */
  async function importFiles(files, opts = {}) {
    const results = [];
    /** @type {Error[]} */
    const errors = [];
    const known = await store.listBooks(); // 用于「同名文件内容已变更」检测
    for (const file of files) {
      try {
        const buf = await readFileAsArrayBuffer(file);
        const decoded = decodeTextFile(buf, { forceEncoding: opts.forceEncoding });
        if (!decoded.ok) {
          const err = new Error(decoded.error);
          err.code = 'DECODE_FAILED';
          err.candidates = decoded.candidates;
          err.fileName = file.name;
          throw err;
        }
        const text = decoded.text;
        const contentHash = await sha256Hex(text);
        const id = `${file.name}#${contentHash.slice(0, 16)}`;

        // 同 id 已存在则跳过
        const existing = await store.getBook(id);
        if (existing) {
          results.push({ book: existing, added: false, warning: `${file.name} 已在书架中` });
          continue;
        }

        // 文件改动检测（需求 D）：同名但哈希不同 = 文件被修改过，导入为新书并明确提示
        const sameName = known.filter((b) => b.id.startsWith(`${file.name}#`));
        let changeNote;
        if (sameName.length) {
          changeNote = `检测到「${file.name}」内容已变更，已作为新书导入（原书及其进度保留）`;
        }

        const { chapters, sentences } = buildStructure(text);
        const chars = text.replace(/\s/g, '').length;
        const book = {
          id,
          title: file.name.replace(/\.txt$/i, ''),
          text,
          chapters,
          sentenceCount: sentences.length,
          size: file.size,
          chars,
          encoding: decoded.encoding,
          contentHash,
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await store.putBook(book);
        known.push(book);
        bus.emit(Events.BOOKS, {}); // 每成功一个立即刷新，批量中途失败也不丢已导入项
        const warns = [];
        if (changeNote) warns.push(changeNote);
        if (decoded.warnings.length) warns.push(decoded.warnings.join('；'));
        results.push({ book, added: true, warning: warns.length ? warns.join('；') : undefined });
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      const first = errors[0];
      first.message = `${first.message}（另有 ${errors.length - 1} 个文件失败）`;
      first.errors = errors;
      throw first;
    }
    return results;
  }

  /** 打开书籍：重建句子结构并加载播放器。 */
  async function openBook(bookId, opts = {}) {
    const book = await store.getBook(bookId);
    if (!book) throw new Error('书籍不存在');
    // 换书后旧的「读完本章」章索引失效，先取消（避免在新书上误触发）
    if (sleepMode && sleepMode.kind === 'chapter') clearSleepTimer();
    const st = await store.getState(bookId);
    // 手动微调过的章节优先复用；否则按当前章节正则重新检测（改设置后重开书即生效）
    const { chapters, sentences } = buildStructure(book.text, {}, book.chaptersManual ? book.chapters : null);
    book.chapters = chapters;
    book.sentences = sentences;

    // 恢复位置解析：显式跳转 > 显式偏移 > 存档字符偏移（绝对坐标，设置变更不漂移）> 存档句序 > 开头
    // 任何有存档的情况都不得落到开头（需求 D：绝不允许回到开头）
    const resumePos =
      opts.sentenceIndex != null
        ? { sentenceIndex: opts.sentenceIndex }
        : opts.charOffset != null
          ? { charOffset: opts.charOffset }
          : st && st.charOffset != null
            ? { charOffset: st.charOffset }
            : st && st.sentenceIndex != null
              ? { sentenceIndex: st.sentenceIndex }
              : {};
    // 本书记忆的语速/音色/音量随 loadBook 一起生效（避免"先按旧语速合成再重来"）
    await player.loadBook(book, {
      ...resumePos,
      rate: st && st.rate ? st.rate : settings.rate,
      volume: st && st.volume != null ? st.volume : settings.volume,
      voice: st && st.voice !== undefined ? st.voice : settings.voice,
      autoplay: opts.autoplay ?? false,
    });
    if (settings.wakelockEnabled && document.visibilityState === 'visible') void wakeLock.request();
    // 开书即预热：云端引擎后台合成首块（点播放几乎立刻出声）；本地引擎由 resolveAdapter 触发后台下载/预热
    void (async () => {
      const ad = await resolveAdapter().catch(() => null);
      if (ad && ad.id === 'cloud-http') player.warmCurrentChunk();
    })();
    diag.start();
    return { book, state: st };
  }

  /* ---------------- 书架管理 ---------------- */

  async function listBooks() {
    const [books, states] = await Promise.all([store.listBooks(), store.getAllStates()]);
    const stateMap = new Map(states.map((s) => [s.bookId, s]));
    return books
      .map((b) => {
        const st = stateMap.get(b.id);
        const progress = st && b.sentenceCount ? Math.min(100, Math.round((st.sentenceIndex / Math.max(1, b.sentenceCount)) * 1000) / 10) : 0;
        return {
          id: b.id,
          title: b.title,
          chars: b.chars,
          size: b.size,
          encoding: b.encoding,
          addedAt: b.addedAt,
          updatedAt: b.updatedAt,
          lastListenAt: st ? st.updatedAt : 0,
          progress,
          state: st || null,
        };
      })
      .sort((a, b) => b.lastListenAt - a.lastListenAt || b.addedAt - a.addedAt);
  }

  async function renameBook(id, title) {
    await store.patchBook(id, { title });
    bus.emit(Events.BOOKS, {});
  }

  async function deleteBook(id) {
    if (player.getState().bookId === id) await player.stop();
    await store.deleteBook(id);
    // 被删的书不能留在播放队列里
    if (playQueue.includes(id)) await setQueue(playQueue.filter((x) => x !== id));
    bus.emit(Events.BOOKS, {});
  }

  /* ---------------- 播放队列（多文件排队播放） ---------------- */

  /** @type {string[]} 待播书籍 id 队列（持久化在 settings.playQueue） */
  let playQueue = Array.isArray(settings.playQueue) ? settings.playQueue.filter((x) => typeof x === 'string') : [];

  async function setQueue(next) {
    playQueue = next;
    settings = await store.saveSettings({ playQueue: next });
    bus.emit(Events.QUEUE, { queue: [...next] });
  }

  /** 加入队列（幂等）。 @returns {Promise<boolean>} true=新加入 */
  async function enqueueBook(id) {
    if (playQueue.includes(id)) return false;
    await setQueue([...playQueue, id]);
    return true;
  }

  async function removeFromQueue(id) {
    if (!playQueue.includes(id)) return;
    await setQueue(playQueue.filter((x) => x !== id));
  }

  async function clearQueue() {
    if (!playQueue.length) return;
    await setQueue([]);
  }

  const getQueue = () => [...playQueue];

  /** 立即开始播放队列：打开队列第一本并续播后续。 @returns {Promise<boolean>} */
  async function playQueueNow() {
    if (!playQueue.length) return false;
    const first = playQueue[0];
    await setQueue(playQueue.slice(1));
    await openBook(first, { autoplay: true });
    return true;
  }

  /**
   * 队列续播时的「打开并刷新 UI」钩子。
   * app 层只管播放器，标题栏/章节目录/书签在装配层（main.js ctx.openBookById），
   * 不接这个钩子就会出现：书已经换了一本，界面还停在上一本，章节按钮按旧坐标乱跳。
   */
  let bookOpenHook = null;
  function setBookOpenHook(fn) {
    bookOpenHook = typeof fn === 'function' ? fn : null;
  }

  // 一本书自然读完 → 自动续播队列下一本书（需求 A：多文件排队播放）
  bus.on(Events.BOOK_END, async () => {
    if (!playQueue.length) return;
    const nextId = playQueue[0];
    try {
      const book = await store.getBook(nextId);
      if (!book) {
        await setQueue(playQueue.filter((x) => x !== nextId));
        bus.emit(Events.TOAST, { message: '队列中的下一本书已不存在，已移出队列', level: 'warn' });
        return;
      }
      await setQueue(playQueue.slice(1));
      if (bookOpenHook) await bookOpenHook(nextId, { autoplay: true });
      else await openBook(nextId, { autoplay: true });
      bus.emit(Events.TOAST, { message: `继续播放：${book.title}`, level: 'info' });
    } catch (e) {
      bus.emit(Events.ERROR, { message: `排队播放失败：${(e && e.message) || e}`, recoverable: false });
    }
  });

  /* ---------------- 书签 ---------------- */

  async function addMark(note = '') {
    const st = player.getState();
    if (!st.bookId) return null;
    const mark = {
      id: `mark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bookId: st.bookId,
      offset: st.charOffset,
      sentenceIndex: st.sentenceIndex,
      note,
      createdAt: Date.now(),
    };
    await store.putMark(mark);
    bus.emit(Events.TOAST, { message: '已添加书签', level: 'info' });
    return mark;
  }

  async function listMarks(bookId) {
    return store.listMarks(bookId);
  }

  async function removeMark(id) {
    await store.deleteMark(id);
  }

  async function jumpToMark(mark) {
    // 书签优先用字符偏移定位（绝对坐标，不受断句设置变更影响）；老数据无 offset 时回退句序
    const pos = mark.offset != null ? { charOffset: mark.offset } : { sentenceIndex: mark.sentenceIndex };
    if (player.getState().bookId !== mark.bookId) {
      await openBook(mark.bookId, { ...pos, autoplay: true });
    } else if (mark.offset != null) {
      await player.seekToCharOffset(mark.offset);
      if (player.getState().status !== 'playing') await player.play();
    } else {
      await player.seekToSentence(mark.sentenceIndex, { play: true });
    }
  }

  /* ---------------- 设置 ---------------- */

  async function updateSettings(patch) {
    const prev = settings; // 必须在保存前取快照：saveSettings 后 settings 已含 patch，
    // 若拿 patch 与新 settings 比较恒相等，下面的切换分支将永远不执行
    settings = await store.saveSettings(patch);
    bus.emit(Events.SETTINGS, settings);
    // 影响播放的设置即时生效
    if (patch.rate !== undefined) player.setRate(patch.rate);
    if (patch.volume !== undefined) player.setVolume(patch.volume);
    if (patch.voice !== undefined) player.setVoice(patch.voice);
    if (patch.wakelockEnabled !== undefined) {
      if (patch.wakelockEnabled) void wakeLock.request();
      else wakeLock.release();
    }
    if (patch.modelTier !== undefined && patch.modelTier !== prev.modelTier) {
      localAdapter.setTier(patch.modelTier);
      player.invalidateAudio(); // Piper 档位变化：旧块作废
    }
    if (patch.sherpaTier !== undefined && patch.sherpaTier !== prev.sherpaTier) {
      // sherpa 档位切换：失效运行时与已合成的音频块（不同档位采样率可能不同）
      sherpaAdapter.setTier(patch.sherpaTier);
      player.invalidateAudio();
      await resolveAdapter();
      await checkModel().catch(() => {}); // await：fire-and-forget 会被同步合成阻塞，调用方读到旧状态
    }
    // 云端语音默认对所有人关闭：没解锁的设备即使调用也强制回落系统语音
    if (patch.ttsEngine === 'cloud' && !isCloudUnlocked()) {
      patch = { ...patch, ttsEngine: 'system' };
      bus.emit(Events.TOAST, { message: '云端语音未开放（节省额度），已使用系统语音', level: 'info' });
    }
    if (patch.ttsEngine !== undefined && patch.ttsEngine !== prev.ttsEngine) {
      // 引擎切换：重置下载状态、作废旧音频块并重新解析适配器
      modelState.status = 'idle';
      // 换引擎必须允许重新自动下载：否则从 sherpa 切到 Piper 时
      // autoDownloadStarted 仍是 true，Piper 永远不会开始下载（实测卡在 idle）。
      autoDownloadStarted = false;
      warmupStarted = false;
      player.invalidateAudio();
      // cloudTtsEnabled 与 ttsEngine 保持单一事实来源：必须落盘，
      // 只改内存的话刷新后会不一致（曾导致百度音色分组被误判为未开启而整组消失）。
      if (settings.cloudTtsEnabled !== (patch.ttsEngine === 'cloud')) {
        settings = await store.saveSettings({ cloudTtsEnabled: patch.ttsEngine === 'cloud' });
        bus.emit(Events.SETTINGS, settings);
      }
      if (patch.ttsEngine === 'cloud' || prev.ttsEngine === 'cloud') resetCloudHealth();
      // 音色 ID 跨引擎不互通（百度 per / 系统 voiceURI / 本地音色）→ 清空为默认
      if (settings.voice) {
        settings.voice = null;
        player.setVoice(null);
        bus.emit(Events.TOAST, { message: '已切换语音来源，音色已重置（请重新选择音色）', level: 'info' });
      }
      await resolveAdapter();
      await checkModel().catch(() => {});
      bus.emit(Events.STATE, { model: { ...modelState } });
    }
    // 端点留空 → 回落到同域默认端点（不要清空，否则云端静默失效）
    if (patch.cloudEndpoint !== undefined) {
      cloudConfig.endpoint = patch.cloudEndpoint || defaultCloudEndpoint;
      resetCloudHealth();
      player.invalidateAudio();
      await resolveAdapter();
    }
    if (patch.cloudTtsEnabled !== undefined) {
      // 兼容旧开关：开启云端 = 选百度引擎；关闭 = 回到系统语音
      const wantCloud = !!patch.cloudTtsEnabled;
      const nextEngine = wantCloud ? 'cloud' : (settings.ttsEngine === 'cloud' ? 'system' : settings.ttsEngine);
      if (nextEngine !== settings.ttsEngine) {
        await updateSettings({ ttsEngine: nextEngine });
        return settings;
      }
      if (settings.cloudTtsEnabled && !cloudConfig.endpoint) {
        bus.emit(Events.TOAST, { message: '未找到云端语音端点，暂用系统语音', level: 'warn' });
      }
      player.invalidateAudio();
      await resolveAdapter();
    }
    return settings;
  }

  const getSettings = () => ({ ...settings });
  /** 版本信息（构建号 + 是否已被 SW 接管），排查问题时非常关键。 */
  const getBuildInfo = () => ({ ...buildInfo, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller) });

  /* ---------------- 模型下载 ---------------- */

  const modelState = { status: 'idle', progress: 0, error: null, tier: settings.sherpaTier || 'int8', startTime: 0, bytesDownloaded: 0 };
  /** 防止重复触发自动下载 */
  let autoDownloadStarted = false;
  /** 防止重复触发引擎预热 */
  let warmupStarted = false;

  /**
   * 下载当前引擎所需的模型资产。
   * @param {string} [tier] sherpa: 'int8'|'full'；piper: 'medium'|'x_low'（由 settings.ttsEngine 决定引擎）
   */
  async function downloadModel(tier) {
    if (modelState.status === 'downloading') return modelState;
    const usePiper = settings.ttsEngine === 'local-piper';
    const effectiveTier = tier || (usePiper ? settings.modelTier : settings.sherpaTier) || (usePiper ? 'medium' : 'int8');
    modelState.status = 'downloading';
    modelState.progress = 0;
    modelState.error = null;
    modelState.startTime = Date.now();
    modelState.tier = effectiveTier;
    modelState.engine = usePiper ? 'local-piper' : 'local-sherpa';
    bus.emit(Events.STATE, { model: { ...modelState } });
    try {
      const adapter = usePiper ? localAdapter : sherpaAdapter;
      await adapter.prepare({
        tier: effectiveTier,
        onProgress: (p) => {
          modelState.progress = Math.round(p * 100);
          bus.emit(Events.STATE, { model: { ...modelState } });
        },
      });
      modelState.status = 'ready';
      modelState.progress = 100;
      await resolveAdapter();
      bus.emit(Events.TOAST, { message: '本地模型已就绪（离线可用）', level: 'success' });
    } catch (e) {
      modelState.status = 'error';
      modelState.error = e.message;
      bus.emit(Events.ERROR, { message: `模型下载失败：${e.message}`, recoverable: true });
    }
    bus.emit(Events.STATE, { model: { ...modelState } });
    return modelState;
  }

  /**
   * 清除已下载的离线模型（sherpa / piper / 自定义音色）。
   * 用途：换机/省空间/以及"测试系统语音时确保不会误用已下载模型"。
   * 注意：wasm 运行时仍在内存里，调用后建议刷新页面才彻底干净。
   */
  async function clearOfflineModels() {
    const names = ['tinttxt-tts-sherpa-v1', 'tinttxt-tts-v1', 'tinttxt-tts-custom-v1'];
    let deleted = 0;
    for (const n of names) {
      try { if (await caches.delete(n)) deleted += 1; } catch { /* ignore */ }
    }
    modelState.status = 'idle';
    modelState.progress = 0;
    modelState.error = null;
    modelState.bytesDownloaded = 0;
    autoDownloadStarted = false;
    warmupStarted = false;
    bus.emit(Events.STATE, { model: { ...modelState } });
    bus.emit(Events.TOAST, {
      message: deleted > 0 ? `已清除 ${deleted} 组离线模型，正在刷新…` : '本来就没有下载过离线模型',
      level: deleted > 0 ? 'success' : 'info',
    });
    return deleted;
  }

  /** 清除朗读音频缓存（按句缓存的 WAV）。 */
  async function clearSpeechCache() {
    // 先停播：否则内存里的合并块还会继续播旧音频，用户会以为"清除没生效"
    const wasPlaying = player.getState().status === 'playing' || player.getState().status === 'loading';
    if (wasPlaying) player.pause();
    await clearAudioCache();
    player.invalidateAudio(); // 丢掉内存块 + blob URL，确保下一次真的重新合成
    bus.emit(Events.TOAST, {
      message: wasPlaying ? '已清除朗读缓存（已暂停，点播放会重新合成）' : '已清除朗读缓存',
      level: 'success',
    });
  }
  async function checkModel() {    const usePiper = settings.ttsEngine === 'local-piper';
    const adapter = usePiper ? localAdapter : sherpaAdapter;
    const ready = await adapter.isReady().catch(() => false);
    modelState.status = ready ? 'ready' : 'idle';
    modelState.engine = usePiper ? 'local-piper' : 'local-sherpa';
    bus.emit(Events.STATE, { model: { ...modelState } });
    return modelState;
  }

  /* ---------------- 定时关闭 ---------------- */

  let sleepTimer = 0;
  let sleepMode = null; // {kind:'duration'|'chapter', minutes?, chapterIndex?}
  /** 读完本章模式：设定时所处的章节 index（播放跨过该章即触发） */
  let sleepChapterIndex = null;

  function clearSleepTimer(emitState = true) {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = 0;
    }
    sleepMode = null;
    sleepChapterIndex = null;
    if (emitState) bus.emit(Events.STATE, { sleep: null });
  }

  async function fireSleepTimer(message) {
    clearSleepTimer(false);
    bus.emit(Events.STATE, { sleep: null });
    await player.fadeOut(3000);
    bus.emit(Events.TOAST, { message, level: 'info' });
  }

  function setSleepTimer(mode) {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = 0;
    }
    sleepMode = mode;
    sleepChapterIndex = null;
    if (!mode || mode.kind === 'off') {
      bus.emit(Events.STATE, { sleep: null });
      return;
    }
    if (mode.kind === 'duration') {
      sleepTimer = setTimeout(() => {
        void fireSleepTimer('定时结束，已淡出停止');
      }, mode.minutes * 60 * 1000);
    } else if (mode.kind === 'chapter') {
      // 记录当前章：播放进入其它章（本章读完或用户跳走）时触发
      const st = player.getState();
      const cur = player.getSentences()[st.sentenceIndex];
      if (!cur || !st.bookId) {
        sleepMode = null;
        bus.emit(Events.STATE, { sleep: null });
        bus.emit(Events.TOAST, { message: '请先打开书籍，再设置「读完本章」', level: 'warn' });
        return;
      }
      sleepChapterIndex = cur.chapter;
      mode = { ...mode, chapterIndex: cur.chapter };
      sleepMode = mode;
    }
    bus.emit(Events.STATE, { sleep: { ...mode, remainingMs: mode.kind === 'duration' ? mode.minutes * 60000 : null } });
  }

  // 「读完本章」触发器：只在"向前"跨章时停止。
  // 原来用 !== 判断，用户往回跳章会被误判为读完本章直接淡出。
  bus.on(Events.SENTENCE, ({ sentence }) => {
    if (!sleepMode || sleepMode.kind !== 'chapter' || sleepChapterIndex == null || !sentence) return;
    if (sentence.chapter > sleepChapterIndex) void fireSleepTimer('本章已读完，定时停止');
  });
  // 最后一章读完时只有 BOOK_END、没有下一句的 SENTENCE 事件：
  // 不在这里兜底，"读完本章"在最后一章永远不触发（定时残留、不淡出）。
  bus.on(Events.BOOK_END, () => {
    if (sleepMode && sleepMode.kind === 'chapter' && sleepChapterIndex != null) {
      void fireSleepTimer('本章已读完，定时停止');
    }
  });

  /* ---------------- 统计 ---------------- */

  let lastBeat = 0;
  function refreshStatsBeat() {
    const now = Date.now();
    if (player.getState().status !== 'playing') {
      lastBeat = now;
      return;
    }
    if (lastBeat) {
      const delta = Math.min(5000, now - lastBeat); // 单次最多计 5 秒，防后台冻结后跳变
      if (delta > 0) void store.addStat(dayKey(now), delta);
    }
    lastBeat = now;
  }
  setInterval(() => {
    if (player.getState().status === 'playing') refreshStatsBeat();
  }, 5000);

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function getStats() {
    const rows = await store.listStats();
    const today = dayKey(Date.now());
    const todayMs = rows.find((r) => r.day === today)?.ms || 0;
    const totalMs = rows.reduce((a, r) => a + r.ms, 0);
    // 连续天数
    let streak = 0;
    const daySet = new Set(rows.filter((r) => r.ms > 0).map((r) => r.day));
    const cursor = new Date();
    if (!daySet.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
    for (;;) {
      if (daySet.has(dayKey(cursor.getTime()))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else break;
      if (streak > 3650) break;
    }
    return { todayMs, totalMs, streak, days: rows.length };
  }

  /** 按语速估算收听时长。 */
  function estimateDuration(chars, rate = settings.rate) {
    // 中文常速约 4.5 字/秒（与播放层 CHARS_PER_SEC 一致）
    const seconds = chars / (4.5 * rate);
    return seconds;
  }

  /* ---------------- 导出音频 ---------------- */

  /**
   * 整本/当前章导出 WAV（浏览器直出；mp3 需要额外编码器，此处给合并后下载方案）。
   * @param {{scope:'chapter'|'book', onProgress?:(p:number)=>void, signal?:AbortSignal}} opts
   * @returns {Promise<Blob>}
   */
  async function exportAudio(opts) {
    const st = player.getState();
    if (!st.bookId) throw new Error('未打开书籍');
    const book = await store.getBook(st.bookId);
    const { chapters, sentences } = buildStructure(book.text, {}, book.chaptersManual ? book.chapters : null);
    let start = 0;
    let end = player._chunkCount();
    if (opts.scope === 'chapter') {
      const cur = sentences[st.sentenceIndex];
      const ch = (cur && chapters.find((c) => c.index === cur.chapter)) || chapters[0];
      const firstSentence = Math.max(0, ch.sentenceStart);
      const lastSentence = Math.max(firstSentence, ch.sentenceEnd - 1);
      start = player._chunkIndexForSentence(firstSentence);
      end = player._chunkIndexForSentence(lastSentence) + 1;
    }
    const parts = [];
    for (let i = start; i < end; i++) {
      if (opts.signal?.aborted) throw new Error('导出已取消');
      // 与在途合成竞速：取消时立即返回，不等当前块（约 100 秒音频）合成完
      const blob = await Promise.race([
        player._getChunkBlob(i),
        new Promise((_, reject) => {
          if (opts.signal?.aborted) {
            reject(new Error('导出已取消'));
            return;
          }
          opts.signal?.addEventListener('abort', () => reject(new Error('导出已取消')), { once: true });
        }),
      ]).catch((e) => {
        if (opts.signal?.aborted) throw new Error('导出已取消');
        throw e;
      });
      if (blob && blob.size > 44) parts.push(await blob.arrayBuffer());
      opts.onProgress?.((i - start + 1) / (end - start));
    }
    if (!parts.length) throw new Error('没有可导出的音频（先播放一次生成缓存）');
    const { mergeWavParts } = await import('./layers/playback/wav.js');
    const merged = mergeWavParts(parts);
    if (!merged) throw new Error('音频格式不一致，无法合并');
    return new Blob([merged.buffer], { type: 'audio/wav' });
  }

  /* ---------------- 备份 ---------------- */

  const exportBackup = () => store.exportAll();
  const importBackup = (data, mode) => store.importAll(data, { mode }).then(() => bus.emit(Events.BOOKS, {}));

  /* ---------------- 文件改动检测 ---------------- */

  async function verifyBookHash(book) {
    const current = await sha256Hex(book.text);
    return current === book.contentHash;
  }

  /* ---------------- 页面生命周期 ---------------- */

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stateWriter.flush();
      diag.touchHeartbeat();
    } else {
      lastBeat = Date.now();
    }
  });
  window.addEventListener('pagehide', () => stateWriter.flush());
  window.addEventListener('beforeunload', () => stateWriter.flush());

  // 崩溃恢复：记录「上次打开的书」
  async function rememberLastBook(id) {
    await store.saveSettings({ ...settings, lastBookId: id });
  }

  return {
    bus,
    player,
    wakeLock,
    diag,
    registry,
    resolveAdapter,
    setBookOpenHook,
    getBuildInfo,
    isCloudUnlocked,
    unlockCloud: (key) => setOwnerKey(key),
    lockCloud: () => setOwnerKey(''),
    clearOfflineModels,
    clearSpeechCache,
    // 导入/书架
    importFiles,
    openBook,
    listBooks,
    renameBook,
    deleteBook,
    // 排队播放（多文件）
    getQueue,
    enqueueBook,
    removeFromQueue,
    clearQueue,
    playQueueNow,
    buildStructure,
    verifyBookHash,
    // 章节手动微调（改完持久化，需重开书生效）
    splitChapterAt,
    mergeChapterIntoPrev,
    detectChapters,
    /** 手动标记/合并章节并写回书籍。 @param {string} bookId @param {number} offset @param {string} title */
    markChapterAt: async (bookId, offset, title) => {
      const book = await store.getBook(bookId);
      if (!book) throw new Error('书籍不存在');
      const { chapters } = buildStructure(book.text, {}, book.chaptersManual ? book.chapters : null);
      const next = splitChapterAt(chapters, offset, title);
      await store.patchBook(bookId, { chapters: next, chaptersManual: true });
      bus.emit(Events.BOOKS, {});
      return next;
    },
    /** 合并第 index 章到前一章并写回。 */
    mergeChapter: async (bookId, index) => {
      const book = await store.getBook(bookId);
      if (!book) throw new Error('书籍不存在');
      const { chapters } = buildStructure(book.text, {}, book.chaptersManual ? book.chapters : null);
      const next = mergeChapterIntoPrev(chapters, index);
      await store.patchBook(bookId, { chapters: next, chaptersManual: true });
      bus.emit(Events.BOOKS, {});
      return next;
    },
    // 进度/书签
    addMark,
    listMarks,
    removeMark,
    jumpToMark,
    // 设置
    getSettings,
    updateSettings,
    // 模型
    downloadModel,
    checkModel,
    modelState: () => ({ ...modelState }),
    MODEL_TIERS,
    SHERPA_TIERS,
    // 自定义音色模型（用户自备文件，应用不分发）
    importVoiceModel: (files) => localAdapter.importVoiceModel(files),
    listCustomVoices: () => localAdapter.listCustomVoices(),
    useCustomVoice: async (id) => {
      await localAdapter.useCustomVoice(id);
      if (id) {
        // 自定义模型是 Piper 格式 onnx，必须走 local-piper 引擎才加载它们
        if (settings.ttsEngine !== 'local-piper') {
          settings = await store.saveSettings({ ttsEngine: 'local-piper' });
          modelState.status = 'idle';
          bus.emit(Events.SETTINGS, settings);
        }
        player.invalidateAudio();
        await resolveAdapter();
        await checkModel().catch(() => {});
      }
    },
    removeCustomVoice: async (id) => {
      await localAdapter.removeCustomVoice(id);
      player.invalidateAudio();
      await resolveAdapter();
      await checkModel().catch(() => {});
    },
    getActiveCustomVoice: () => localAdapter.getCustomVoiceId(),
    // 定时
    setSleepTimer,
    clearSleepTimer,
    getSleepTimer: () => sleepMode,
    // 统计
    getStats,
    estimateDuration,
    // 导出
    exportAudio,
    exportBackup,
    importBackup,
    rememberLastBook,
    getLastBookId: () => settings.lastBookId || null,
  };
}
