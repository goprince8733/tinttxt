/**
 * 播放层 —— 核心播放引擎
 * 分层职责：本模块只消费 Sentence[] / TtsAdapter / Blob，不读 UI DOM（audio 元素归播放层私有）。
 *
 * 熄屏续播设计（对应硬约束）：
 *  - 所有声音来自真实 <audio> 媒体流（WAV Blob URL），享受系统媒体后台豁免；
 *  - 分块预合成：播当前块时预取下一块（默认块目标 100 秒、预取深度 2）；
 *  - 双 <audio> 元素交替：A 播完前 B 已加载就绪，ended 时立即切换，块间空隙最小化；
 *  - JS 冻结不影响已加载媒体继续播放；队列在可见时推进。
 *
 * @module playback/player
 */

import { Events } from '../../core/contracts.js';
import { mergeWavParts, buildSentenceTimeline, wavDuration, parseWav, silenceWav } from './wav.js';
import { getAudio, putAudio, memoAudio, evictLru } from './tts/audio-cache.js';

/** 句间呼吸停顿（毫秒）：插在块内相邻句子之间，消除逐句连播的"赶稿感"（可按喜好调这里）。 */
const SENTENCE_GAP_MS = 300;
import { abortError, throwIfAborted } from './tts/index.js';

/** @typedef {import('../../core/contracts.js').Sentence} Sentence */
/** @typedef {import('../../core/contracts.js').PlaybackState} PlaybackState */
/** @typedef {import('../../core/contracts.js').TtsAdapter} TtsAdapter */

const CHARS_PER_SEC = 4.5; // 中文 TTS 常速估算（rate=1）

/**
 * @param {Object} deps
 * @param {() => Promise<TtsAdapter>} deps.getAdapter
 * @param {import('../../core/contracts.js').Settings} deps.settings
 * @param {ReturnType<import('../../core/contracts.js').createBus>} deps.bus
 * @param {{schedule:(s:any)=>void, flush:()=>Promise<any>}} [deps.stateWriter]
 * @param {(patch:object)=>void} [deps.onStatePatch] UI 层进度回调（不读 DOM）
 */
export function createPlayer(deps) {
  const { getAdapter, settings, bus, stateWriter, onStatePatch } = deps;

  /** @type {Sentence[]} */
  let sentences = [];
  let bookId = null;
  let bookTitle = '';

  /** @type {PlaybackState} */
  const state = {
    status: 'idle',
    bookId: null,
    charOffset: 0,
    sentenceIndex: 0,
    chunkIndex: 0,
    rate: settings.rate || 1,
    voice: settings.voice || null,
    volume: settings.volume ?? 1,
    error: null,
  };

  // 双音频元素（归播放层私有）。挂入隐藏容器而非游离：
  // ① 部分浏览器对不在 DOM 中的媒体元素后台行为不保证；
  // ② 诊断页需要 querySelector('audio') 取到真实状态。
  const audioHost = document.createElement('div');
  audioHost.id = 'tinttxt-audio-host';
  audioHost.setAttribute('aria-hidden', 'true');
  audioHost.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;';
  // 规则5：单 <audio> + 预排 Blob 队列（不再双 A/B 切换）。
  // 块间切换由 onended 事件驱动（媒体事件不被后台节流），不依赖 JS 定时器。
  const audioA = new Audio();
  audioA.preload = 'auto';
  audioA.crossOrigin = 'anonymous';
  audioHost.appendChild(audioA);
  (document.body || document.documentElement).appendChild(audioHost);
  let activeEl = audioA;
  /** @type {string[]} 需要 revoke 的 blob URL */
  const blobUrls = [];

  /**
   * 块：sentences[i..j) 预合成后的单个音频。
   * @typedef {Object} Chunk
   * @property {number} index
   * @property {number} sentenceStart
   * @property {number} sentenceEnd
   * @property {Blob} blob
   * @property {string} url
   * @property {number} durationSec
   * @property {Array<{sentenceIndex:number,startSec:number,endSec:number}>} timeline
   * @property {'loading'|'ready'|'error'} status
   */

  /** @type {Map<number, Chunk>} */
  const chunkCache = new Map();
  /** @type {Map<number, AbortController>} */
  const inflight = new Map();
  const MAX_CACHE = 4; // 只保留附近块，控制内存（WAV 较大）

  // 规则2：预取深度（句）：播当前句时合成后续 3~5 句
  // 预取深度上限 2：云端按字计费，预取过深会在用户暂停/切书时白烧额度
  let prefetchDepth = Math.min(Number(settings.prefetchDepth) || 2, 2);
  /** 播放块目标时长（秒）：首块 3~8 秒先出声（规则2），块小→首声快。 */
  // 块大小上限 30 秒：块越大首块合成越久（云端每句 1~3 秒），也越难在块的播放时长内预取完下一块。
  // 老存档里的 100 秒也夹到 30，避免"点播放要等半分钟"。
  let chunkSeconds = Math.min(Number(settings.chunkSeconds) || 30, 30);
  /**
   * 当前合成引擎 ID：参与音频缓存键。
   * 必须区分引擎——云端（百度）与本地（sherpa/piper）音色完全不同的声音，
   * 若共用同一缓存键，切换引擎后会播出上一个引擎的音频（人声对不上）。
   */
  let activeEngineId = '';
  /** 用户主动定位（跳句/跳章/拖进度）的代号：块播完的自动前进不得覆盖它。 */
  let seekGen = 0;
  /** 跨块定位的"开始合成"防抖定时器（连点只合成最终目标）。 */
  let seekBuildTimer = 0;
  /** 引擎作用域下的缓存音色键。 */
  const cacheVoiceKey = () => `${activeEngineId || 'unknown'}:${state.voice || 'default'}`;
  // 注：chunkSeconds 在上方声明（规则2：首块 3~8 秒）

  /** 当前正在播放的块 */
  let currentChunk = null;
  /** 用户期望的播放意图（区别于实际状态：loading/buffering 时仍为 true） */
  let wantPlaying = false;
  /** 中止所有合成（切书/跳章/改语速） */
  let sessionAbort = new AbortController();
  /** 状态机防抖写盘句柄 */
  let destroy = false;

  /* ---------------- 状态机 ---------------- */

  /** @param {PlaybackState['status']} status @param {string|null} [error] */
  function setStatus(status, error = null) {
    if (destroy) return;
    const prev = state.status;
    state.status = status;
    state.error = error;
    if (status === 'playing' || status === 'paused' || status === 'idle') {
      syncMediaSession();
    }
    bus.emit(Events.STATE, { ...state, prev });
    onStatePatch?.({ status, error });
  }

  function patchState(partial) {
    Object.assign(state, partial);
    bus.emit(Events.STATE, { ...state });
    onStatePatch?.(partial);
    if (partial.charOffset !== undefined || partial.sentenceIndex !== undefined || partial.chunkIndex !== undefined) {
      persistProgress();
    }
  }

  function persistProgress() {
    if (!bookId || !stateWriter) return;
    stateWriter.schedule({
      bookId,
      charOffset: state.charOffset,
      sentenceIndex: state.sentenceIndex,
      chunkIndex: state.chunkIndex,
      rate: state.rate,
      voice: state.voice,
      volume: state.volume,
      updatedAt: Date.now(),
    });
  }

  /* ---------------- 分块 ---------------- */

  /** 把句子按目标时长（秒）打包成块边界。 */
  /**
   * 块时长爬坡：8s → 15s → chunkSeconds。
   * 云端每句合成 1~3 秒（并发 2），而每句音频约 3 秒：
   * 首块必须极短才能秒出声；第二块也要短，否则「正在合成下一块」赶不上上一块播完。
   */
  const CHUNK_LADDER = [8, 15];
  function limitForChunk(chunkIdx) {
    const base = chunkIdx < CHUNK_LADDER.length ? CHUNK_LADDER[chunkIdx] : chunkSeconds;
    return Math.min(base, chunkSeconds);
  }

  function planChunks() {
    /** @type {Array<{start:number,end:number}>} */
    const bounds = [];
    let start = 0;
    let est = 0;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.skippable) {
        if (est === 0) start = i + 1;
        continue;
      }
      const dur = (s.speak.length || s.raw.length) / (CHARS_PER_SEC * state.rate);
      const limit = limitForChunk(bounds.length);
      if (est > 0 && est + dur > limit) {
        bounds.push({ start, end: i });
        start = i;
        est = 0;
      }
      est += dur;
      // 单句超长强制独立成块
      if (dur > limit * 1.5) {
        bounds.push({ start: i, end: i + 1 });
        start = i + 1;
        est = 0;
      }
    }
    if (start < sentences.length) bounds.push({ start, end: sentences.length });
    return bounds;
  }

  /** @type {Array<{start:number,end:number}>} */
  let chunkBounds = [];

  function chunkOfSentence(idx) {
    // 二分
    let lo = 0;
    let hi = chunkBounds.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chunkBounds[mid].start <= idx) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /* ---------------- 合成 ---------------- */

  /**
   * 合成指定块（可取消）。
   * 并发契约：同一块的并发调用必须拿到同一个 Promise——若误返回 AbortController，
   * 调用方会把它当 Chunk 用（url 为空 → currentChunk 被污染成 NaN 块索引）。
   * @param {number} index
   * @returns {Promise<Chunk>}
   */
  function ensureChunk(index) {
    const cached = chunkCache.get(index);
    if (cached && cached.status === 'ready') return Promise.resolve(cached);
    const existing = inflight.get(index);
    if (existing) return existing.promise;

    const bound = chunkBounds[index];
    if (!bound) return Promise.reject(new Error(`块越界: ${index}`));

    const controller = new AbortController();
    /** @type {{controller: AbortController, promise: Promise<any>}} */
    const entry = { controller, promise: null };
    inflight.set(index, entry);
    entry.promise = buildChunk(index, bound, controller).finally(() => {
      // 只清理自己的条目（cancelAll 已 clear 或新任务已接管时不误删）
      if (inflight.get(index) === entry) inflight.delete(index);
    });
    return entry.promise;
  }

  /**
   * 实际执行合成（由 ensureChunk 驱动）。
   * @param {number} index
   * @param {{start:number,end:number}} bound
   * @param {AbortController} controller
   * @returns {Promise<Chunk>}
   */
  async function buildChunk(index, bound, controller) {
    const onOuterAbort = () => controller.abort(sessionAbort.signal.reason);
    sessionAbort.signal.addEventListener('abort', onOuterAbort, { once: true });

    const chunk = {
      index,
      sentenceStart: bound.start,
      sentenceEnd: bound.end,
      blob: null,
      url: '',
      durationSec: 0,
      timeline: [],
      status: 'loading',
    };
    chunkCache.set(index, chunk);

    try {
      const adapter = await getAdapter();
      activeEngineId = adapter.id || activeEngineId;
      const parts = [];
      const ids = [];
      if (adapter.requiresNetwork) {
        // 云端引擎：按句并发合成（串行每句 2~4 秒，首块要 10 秒以上）。
        // 并发 2：足够把首块压到 ~4 秒，又不至于撞厂商 QPS 限制。
        const CONCURRENCY = 2;
        const bufByIndex = new Map();
        const targets = [];
        for (let i = bound.start; i < bound.end; i++) {
          const s = sentences[i];
          if (s.skippable || !s.speak) continue;
          const cachedBlob = await getAudio(s.speak, cacheVoiceKey(), state.rate);
          if (cachedBlob && cachedBlob.size > 44) bufByIndex.set(i, await cachedBlob.arrayBuffer());
          else targets.push(i);
        }
        let previewAt = -1;
        let previewRes = null;
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            const k = cursor++;
            if (k >= targets.length) return;
            const i = targets[k];
            throwIfAborted(controller.signal);
            const res = await adapter.synthesize(sentences[i].speak, {
              voice: state.voice || undefined,
              rate: state.rate,
              signal: controller.signal,
            });
            if (res.preview) { previewAt = i; previewRes = res; return; }
            memoAudio(sentences[i].speak, cacheVoiceKey(), state.rate, res.blob); // 先占内存，abort 重建不再重复合成
            bufByIndex.set(i, await res.blob.arrayBuffer());
            void putAudio(sentences[i].speak, cacheVoiceKey(), state.rate, res.blob).then(() => evictLru());
          }
        };
        const poolSize = Math.max(1, Math.min(CONCURRENCY, targets.length));
        await Promise.all(Array.from({ length: poolSize }, () => worker()));
        throwIfAborted(controller.signal);
        if (previewRes) {
          chunk.status = 'ready';
          chunk.blob = null;
          chunk.durationSec = previewRes.durationSeconds;
          chunk.timeline = [{ sentenceIndex: previewAt, startSec: 0, endSec: Infinity }];
          chunk.preview = true;
          chunk.previewText = sentences.slice(bound.start, bound.end).map((x) => x.speak).join(' ');
          return chunk;
        }
        // 按句序组装（并发完成顺序不定，时间轴必须与句子顺序一致）
        for (let i = bound.start; i < bound.end; i++) {
          const buf = bufByIndex.get(i);
          if (buf) { parts.push(buf); ids.push(i); }
        }
      } else
      for (let i = bound.start; i < bound.end; i++) {
        throwIfAborted(controller.signal);
        const s = sentences[i];
        if (s.skippable || !s.speak) continue;

        // 规则1+4：按句缓存（键=md5(text+voice+rate)），命中直接取 Blob 跳过合成
        const cachedBlob = await getAudio(s.speak, cacheVoiceKey(), state.rate);
        if (cachedBlob && cachedBlob.size > 44) {
          const buf = await cachedBlob.arrayBuffer();
          parts.push(buf);
          ids.push(i);
          continue;
        }

        const res = await adapter.synthesize(s.speak, {
          voice: state.voice || undefined,
          rate: state.rate,
          signal: controller.signal,
        });
        if (res.preview) {
          // 预览降级：无法产出 Blob，整块标记为 preview，由 preview 播放路径处理
          chunk.status = 'ready';
          chunk.blob = null;
          chunk.durationSec = res.durationSeconds;
          chunk.timeline = [{ sentenceIndex: i, startSec: 0, endSec: Infinity }];
          chunk.preview = true;
          chunk.previewText = sentences.slice(bound.start, bound.end).map((x) => x.speak).join(' ');
          return chunk;
        }
        const buf = await res.blob.arrayBuffer();
        memoAudio(s.speak, cacheVoiceKey(), state.rate, res.blob); // 先占内存，abort 重建不再重复合成
        parts.push(buf);
        ids.push(i);
        // 写入按句缓存（规则1+4）：下次回退/重听/跳章直接命中
        void putAudio(s.speak, cacheVoiceKey(), state.rate, res.blob).then(() => evictLru());
        // 句间强制让出主线程（宏任务）：合成是同步 wasm —— Piper ~0.5s/句、sherpa 更久，
        // 整块连续合成会把点击/渲染饿死（实测主线程单次连卡 14–18s，即「死机感」来源）。
        // 每句后让一次，单次阻塞上限 = 一句话的合成时长。
        await new Promise((r) => setTimeout(r, 0));
      }

      throwIfAborted(controller.signal);
      if (!parts.length) {
        chunk.status = 'ready';
        chunk.blob = new Blob([], { type: 'audio/wav' });
        chunk.url = '';
        chunk.durationSec = 0;
        return chunk;
      }

      // 句间呼吸停顿：相邻句子之间插入静音（SENTENCE_GAP_MS），节奏不再"赶稿"。
      // 静音段与句子一起进合并器 → partOffsets 自动包含停顿时长；
      // 时间轴只保留句子段的偏移（停顿期间高亮停留在前一句，不会提前跳走）。
      const info0 = parseWav(parts[0]);
      const gapWav = parts.length > 1 && info0 ? silenceWav(SENTENCE_GAP_MS, info0.sampleRate) : null;
      const inputs = [];
      const isSentence = [];
      for (let k = 0; k < parts.length; k++) {
        if (k > 0 && gapWav) {
          inputs.push(gapWav);
          isSentence.push(false);
        }
        inputs.push(parts[k]);
        isSentence.push(true);
      }

      const merged = inputs.length === 1
        ? { buffer: inputs[0], partOffsets: [{ byte: 0, seconds: 0 }] }
        : mergeWavParts(inputs);

      if (!merged) {
        // 采样率不一致等罕见情况：回退为逐句播放（上层按句子切）
        const first = parts[0];
        chunk.status = 'ready';
        chunk.blob = new Blob(parts, { type: 'audio/wav' });
        chunk.url = URL.createObjectURL(chunk.blob);
        blobUrls.push(chunk.url);
        chunk.durationSec = parts.reduce((a, b) => a + wavDuration(b), 0);
        chunk.timeline = buildSentenceTimeline(
          ids.map((_, i) => ({ byte: 0, seconds: parts.slice(0, i).reduce((a, b) => a + wavDuration(b), 0) })),
          ids,
        );
        return chunk;
      }

      chunk.blob = new Blob([merged.buffer], { type: 'audio/wav' });
      chunk.url = URL.createObjectURL(chunk.blob);
      blobUrls.push(chunk.url);
      chunk.durationSec = wavDuration(merged.buffer);
      // 只取句子段偏移（丢弃插入的静音段），与 ids 一一对应
      const sentOffsets = inputs.length > 1 && inputs.length === merged.partOffsets.length
        ? merged.partOffsets.filter((_, i) => isSentence[i])
        : merged.partOffsets;
      chunk.timeline = buildSentenceTimeline(sentOffsets, ids);
      chunk.status = 'ready';
      evictCache(index);
      return chunk;
    } catch (e) {
      chunkCache.delete(index);
      if (e && e.name === 'AbortError') throw e;
      chunk.status = 'error';
      throw e;
    } finally {
      // inflight 条目由 ensureChunk 的 entry.promise.finally 安全清理
      // （这里不能无条件 delete：cancelAll 清空后可能已有同索引的新任务接管）
      sessionAbort.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  function evictCache(keepIndex) {
    if (chunkCache.size <= MAX_CACHE) return;
    const keys = [...chunkCache.keys()].sort((a, b) => Math.abs(b - keepIndex) - Math.abs(a - keepIndex));
    for (const k of keys) {
      if (chunkCache.size <= MAX_CACHE) break;
      const c = chunkCache.get(k);
      if (c && c.status === 'ready' && k !== currentChunk?.index) {
        if (c.url) {
          URL.revokeObjectURL(c.url);
          const i = blobUrls.indexOf(c.url);
          if (i >= 0) blobUrls.splice(i, 1);
        }
        chunkCache.delete(k);
      }
    }
  }

  /**
   * 预合成「当前块」（开书后后台跑）。
   * 云端引擎每次合成 2~4 秒，开书即预热可让用户点播放时几乎立刻出声。
   * 仅在当前适配器能产出真实音频时调用（preview 块无缓存价值，会污染块缓存）。
   */
  function warmCurrentChunk() {
    if (destroy || !sentences.length || !chunkBounds.length) return;
    const idx = chunkOfSentence(state.sentenceIndex);
    const cached = chunkCache.get(idx);
    if (cached && cached.status === 'ready') return;
    void ensureChunk(idx).catch(() => {});
  }

  /** 预取单飞标志：多处（play/seek/advance/onVisible/setRate）都会调，不单飞会并发预取多块。 */
  let prefetchRunning = false;
  async function prefetch() {
    if (prefetchRunning) return;
    // 只有"确实想听"才预取：暂停/未播时预取纯属烧额度（云端按字计费）
    if (!wantPlaying || destroy) return;
    prefetchRunning = true;
    try {
      const from = state.chunkIndex;
      for (let d = 1; d <= prefetchDepth; d++) {
        const idx = from + d;
        if (idx >= chunkBounds.length) break;
        let chunk = chunkCache.get(idx);
        if (!chunk || chunk.status !== 'ready') {
          try {
            chunk = await ensureChunk(idx);
          } catch (e) {
            if (e && e.name === 'AbortError') return;
            console.warn('[player] 预取失败', idx, e);
            return;
          }
        }
        if (destroy || sessionAbort.signal.aborted || !wantPlaying) return;
        // 预取下一块：合成完成后已就绪，onended 时由 advanceChunk 直接加载（规则5）
      }
    } finally {
      prefetchRunning = false;
    }
  }

  /* ---------------- 播放控制 ---------------- */

  function currentSentenceInChunk(chunk, timeSec) {
    for (let i = chunk.timeline.length - 1; i >= 0; i--) {
      if (timeSec >= chunk.timeline[i].startSec) return chunk.timeline[i].sentenceIndex;
    }
    return chunk.sentenceStart;
  }

  function attachListeners(el) {
    el.ontimeupdate = () => {
      if (el !== activeEl || !currentChunk) return;
      // 守卫一：等待新块合成/加载期间，旧音频的进度不能改写用户刚选的句子
      if (state.status === 'loading') return;
      // 守卫二：目标块尚未接管播放（currentChunk 还是旧块）时同样不算数
      if (currentChunk.index !== state.chunkIndex) return;
      const t = el.currentTime;
      const sid = currentSentenceInChunk(currentChunk, t);
      if (sid !== state.sentenceIndex) {
        const s = sentences[sid];
        if (s) {
          state.sentenceIndex = sid;
          state.charOffset = s.start;
          bus.emit(Events.SENTENCE, { sentence: s });
          persistProgress();
          onStatePatch?.({ sentenceIndex: sid, charOffset: s.start });
        }
      }
      bus.emit(Events.PROGRESS, {
        charOffset: state.charOffset,
        positionSec: t,
        durationSec: currentChunk.durationSec,
        chunkIndex: currentChunk.index,
        sentenceIndex: sid,
      });
    };
    el.onended = () => {
      if (el !== activeEl) return;
      // 暂停在块尾时不要继续合成下一块（合成完也会被丢弃，白烧额度）
      if (!wantPlaying) return;
      void advanceChunk();
    };
    el.onplaying = () => {
      if (el !== activeEl) return;
      // 用户已按暂停（但上一次 play() 的 promise 可能在此刻解析）：不要覆盖暂停意图
      if (!wantPlaying) return;
      if (state.status !== 'playing') setStatus('playing');
    };
    el.onwaiting = () => {
      if (el === activeEl && state.status === 'playing') setStatus('buffering');
    };
    el.onerror = () => {
      if (el !== activeEl) return;
      const msg = `音频播放失败（${el.error ? el.error.code : '未知'}）`;
      setStatus('error', msg);
      bus.emit(Events.ERROR, { message: msg, recoverable: true });
    };
  }
  attachListeners(audioA);

  /** 播放下一块（双元素切换）。 */
  async function advanceChunk() {
    const nextIdx = currentChunk ? currentChunk.index + 1 : state.chunkIndex;
    if (nextIdx >= chunkBounds.length) {
      // 本书读完
      wantPlaying = false;
      stopKeepAlive(); // 读完必须停保活，否则静音音频会一直循环（耗电 + 媒体通知卡住）
      setStatus('paused');
      patchState({ charOffset: sentences.length ? sentences[sentences.length - 1].end : state.charOffset });
      bus.emit(Events.TOAST, { message: '本书已读完', level: 'info' });
      bus.emit(Events.BOOK_END, { bookId }); // 排队播放：交给装配层续播下一本书
      return;
    }
    // 块自然播完的"自动前进"可能和用户的下一句/跳章同时发生：合成期间用户一旦定位，
    // 就必须放弃这次自动前进，否则会把用户选中的句子覆盖成块起点（表现为"点了没反应"）。
    const gen = seekGen;
    try {
      const next = await ensureChunk(nextIdx);
      if (destroy || !wantPlaying || gen !== seekGen) return;
      await playChunk(next, { autoplay: true });
      void prefetch();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus('error', `下一块合成失败: ${e.message}`);
      bus.emit(Events.ERROR, { message: e.message, recoverable: true });
    }
  }

  /**
   * 播放指定块。
   * @param {Chunk} chunk
   * @param {{autoplay?: boolean, startSentence?: number}} [opts]
   */
  async function playChunk(chunk, opts = {}) {
    if (currentChunk && currentChunk !== chunk && currentChunk.url) {
      // 挂起当前块（不 revoke，缓存内复用）
      activeEl.pause();
    }
    currentChunk = chunk;
    // 块切换：先结算上一块"应有 vs 实际"朗读时长（能直接暴露引擎内部丢内容）
    if (chunkStat.idx >= 0 && chunkStat.idx !== chunk.index) {
      trace({
        kind: 'chunkStat',
        idx: chunkStat.idx,
        expected: Math.round(chunkStat.expected),
        spoken: Math.round(chunkStat.spoken),
        ratio: chunkStat.expected > 0 ? Number((chunkStat.spoken / chunkStat.expected).toFixed(2)) : null,
      });
    }
    chunkStat = { idx: chunk.index, expected: 0, spoken: 0 };
    // 块切换必须记在最前面：系统语音（preview）在下面会提前 return，
    // 原来把日志放在后面导致"跳块"恰恰没被记录（诊断失效）。
    trace({ kind: 'chunk', idx: chunk.index, preview: !!chunk.preview, from: opts.startSentence != null ? opts.startSentence : null, chunkStart: chunk.sentenceStart, chunkEnd: chunk.sentenceEnd });
    // 规则5：单元素，无 A/B 切换
    const el = activeEl;
    attachListeners(el);
    el.volume = state.volume;

    if (chunk.preview) {
      // 预览降级：直接走 speechSynthesis（不满足熄屏约束，UI 已标注）
      // 暂停状态下跳句只定位不出声：否则会无声却显示"播放中"（onend 因 wantPlaying=false 不前进）
      if (!wantPlaying && !opts.autoplay) {
        if (state.status === 'loading') setStatus('paused');
        return;
      }
      return previewSpeak(chunk);
    }

    if (!chunk.url) {
      // 空块（整块都是跳过行/纯标点）：绝不能留 loading（会永久转圈）
      if (opts.autoplay && wantPlaying) return advanceChunk();
      if (state.status === 'loading') setStatus('paused');
      return;
    }

    if (el.src !== chunk.url) el.src = chunk.url;

    // 定位到句
    let seekTo = 0;
    if (opts.startSentence != null) {
      const t = chunk.timeline.find((x) => x.sentenceIndex >= opts.startSentence);
      if (t) seekTo = t.startSec;
    } else if (chunk.index === state.chunkIndex && opts.autoplay !== true) {
      // 恢复：用当前句在块内的位置
      const t = chunk.timeline.find((x) => x.sentenceIndex >= state.sentenceIndex);
      if (t) seekTo = t.startSec;
    }
    if (seekTo > 0 && Number.isFinite(chunk.durationSec)) {
      try {
        el.currentTime = Math.min(seekTo, Math.max(0, chunk.durationSec - 0.05));
      } catch {
        /* 元素未就绪时忽略 */
      }
    }

    state.chunkIndex = chunk.index;
    onStatePatch?.({ chunkIndex: chunk.index });

    if (opts.autoplay || wantPlaying) {
      try {
        setStatus('loading');
        await el.play();
        setStatus('playing');
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // autoplay 被策略拒绝：等待用户手势
        setStatus('paused');
        bus.emit(Events.TOAST, { message: '浏览器阻止了自动播放，点一下播放按钮继续', level: 'warn' });
      }
    } else if (state.status === 'loading') {
      // 暂停状态下跳句/切块：只定位不播放，状态必须回到 paused（否则 UI 永久转圈）
      setStatus('paused');
    }
  }

  /**
   * 系统语音朗读（默认引擎）。
   * 关键：**逐句朗读**，而不是整块一次性念完——
   * 否则高亮不会逐句推进、暂停/跳句的粒度也变成"一整块"（用户会觉得不受控）。
   */
  /**
   * 熄屏保活（实验）：系统语音（speechSynthesis）本身拿不到媒体后台豁免，熄屏会被系统停掉。
   * 这里循环播放一段"静音音频"，让页面保持媒体播放状态，尽量争取熄屏后系统语音继续。
   * 成功率依赖浏览器/系统实现（华为 ArkWeb 未验证），失败不影响正常播放。
   * 可用 ?nokeepalive 关闭（便于 A/B 对比）。
   */
  const KEEPALIVE_DISABLED = typeof location !== 'undefined' && /[?&]nokeepalive/.test(location.search);
  let keepAliveEl = null;

  function silentWavUrl() {
    const sr = 8000;
    const n = sr; // 1 秒静音
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function startKeepAlive() {
    if (KEEPALIVE_DISABLED) return;
    if (keepAliveEl) {
      if (keepAliveEl.paused) void keepAliveEl.play().catch(() => {});
      return;
    }
    try {
      const el = new Audio(silentWavUrl());
      el.loop = true;
      el.volume = 0; // 完全静音，只用来维持媒体会话
      el.setAttribute('playsinline', '');
      keepAliveEl = el;
      // 有用户手势时允许直接播；若被自动播放策略拒绝，退化为 muted（浏览器允许静音自动播放）
      el.play().catch(() => {
        try {
          el.muted = true;
          el.play().catch(() => {});
        } catch { /* ignore */ }
      });
      if (typeof navigator !== 'undefined' && navigator.mediaSession) {
        try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
      }
    } catch { /* 不支持则忽略 */ }
  }

  function stopKeepAlive() {
    if (!keepAliveEl) return;
    try { keepAliveEl.pause(); } catch { /* ignore */ }
    try { if (keepAliveEl.src) URL.revokeObjectURL(keepAliveEl.src); } catch { /* ignore */ }
    keepAliveEl = null;
    if (typeof navigator !== 'undefined' && navigator.mediaSession) {
      try { navigator.mediaSession.playbackState = 'paused'; } catch { /* ignore */ }
    }
  }

  function isKeepAliveOn() {
    return !!(keepAliveEl && !keepAliveEl.paused);
  }

  function previewSpeak(chunk) {
    const inChunk = state.sentenceIndex >= chunk.sentenceStart && state.sentenceIndex < chunk.sentenceEnd;
    return previewSpeakFrom(chunk, inChunk ? state.sentenceIndex : chunk.sentenceStart);
  }

  /** 系统语音事件环形日志（排查"息屏跳块"用；最多 200 条）。 */
  const traceLog = [];
  function trace(ev) {
    try {
      traceLog.push({ t: Date.now(), ...ev });
      if (traceLog.length > 200) traceLog.shift();
    } catch { /* ignore */ }
  }
  /** 上一句结束时间（算句间空隙，判断是否"听起来跳了"）。 */
  let lastSpeakEndAt = 0;
  /**
   * 每块累计「应有朗读时长 vs 实际朗读时长」。
   * 作用：即使每句都报"正常结束"，只要整块实际时长远短于应有，
   * 就说明引擎内部丢了内容 → 记 chunkStat 供定位。
   */
  let chunkStat = { idx: -1, expected: 0, spoken: 0 };
  /**
   * 自适应语速（字/秒）：用实际完成的句子反推，代替写死的 4.5。
   * 为什么：不同机型/音色的真实语速差异很大（实测 4~6 字/秒），
   * 用固定值会把"正常念完"误判成"被打断"，或反过来漏判真正的截断。
   */
  let speechRateCps = 4.5;
  const rateSamples = [];
  function noteSpeechRate(chars, ms, rate) {
    if (!(ms > 700) || !(chars >= 4)) return;
    // 归一化到 1× 语速：样本里已包含当前倍速，若不除掉会和 expectedMs 再乘一次倍速，
    // 造成 2× 时预期时长被除以两次（阈值被放大一倍，截断再也检测不到）。
    const r = rate > 0 ? rate : 1;
    const cps = chars / (ms / 1000) / r;
    if (!(cps > 1.5 && cps < 12)) return;
    rateSamples.push(cps);
    if (rateSamples.length > 30) rateSamples.shift();
    const sorted = rateSamples.slice().sort((a, b) => a - b);
    speechRateCps = sorted[Math.floor(sorted.length / 2)] || 4.5;
  }

  /** 系统语音会话代号：暂停/跳句/切块都会 +1，作废旧 utterance 的回调。 */
  let previewGen = 0;
  /** 当前句的重试计数（同一句最多重念 2 次；换句归零）。 */
  const retryState = { i: -1, n: 0 };
  /** 息屏挂起（引擎被系统冻结）的检测：每 4 秒探一次，最多重念 3 次。 */
  let stallTimer = 0;
  const stallState = { i: -1, n: 0 };
  const STALL_WAIT_MS = 4000;
  const STALL_MAX = 3;
  function clearStallTimer() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; }
  }
  /** 被系统打断（多为熄屏）时停在的句子：恢复时从这句重讲，绝不静默跳过。 */
  let previewResumeIdx = -1;
  /** 被打断时所在的块（跨块恢复用）。 */
  let previewChunkRef = null;

  function previewSpeakFrom(chunk, startIdx) {
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
      setStatus('error', '当前浏览器不支持系统语音');
      return;
    }
    if (wantPlaying) startKeepAlive(); // 从跳句/续播进入系统语音时也保活
    const gen = ++previewGen;
    previewChunkRef = chunk;
    previewResumeIdx = -1; // 新一轮朗读：清掉上次断点（真正的断点由 handleInterrupted 记录）
    retryState.i = -1; // 新会话重置重试计数（否则"重念同一句"的计数会跨会话残留）
    retryState.n = 0;
    let i = Math.max(chunk.sentenceStart, Math.min(startIdx, chunk.sentenceEnd - 1));

    const stopIfStale = () => destroy || gen !== previewGen || !wantPlaying;

    const speakNext = () => {
      if (stopIfStale()) {
        if (!wantPlaying && !destroy) setStatus('paused');
        return;
      }
      // 跳过不可朗读的句子（纯标点/分隔行）
      while (i < chunk.sentenceEnd) {
        const s = sentences[i];
        if (s && s.speak && !s.skippable) break;
        i += 1;
      }
      if (i >= chunk.sentenceEnd) { void advanceChunk(); return; }

      const s = sentences[i];
      // 逐句高亮 + 进度落盘（系统语音没有 <audio> 时间轴，只能在这里推进）
      if (state.sentenceIndex !== i) {
        state.sentenceIndex = i;
        state.charOffset = s.start;
        bus.emit(Events.SENTENCE, { sentence: s });
        persistProgress();
        onStatePatch?.({ sentenceIndex: i, charOffset: s.start });
      }

      const u = new SpeechSynthesisUtterance(s.speak);
      u.lang = 'zh-CN';
      u.rate = state.rate;
      u.volume = state.volume;
      if (state.voice && typeof window.speechSynthesis.getVoices === 'function') {
        const v = window.speechSynthesis.getVoices().find((x) => x.voiceURI === state.voice);
        if (v) {
          u.voice = v;
          if (v.lang) u.lang = v.lang;
        }
      }

      let spoke = false;
      const speakT0 = Date.now();
      const speakRate = state.rate || 1;
      const expectedMs = Math.max(500, (s.speak.length / (speechRateCps * speakRate)) * 1000);
      const isHidden = () => {
        try { return document.visibilityState === 'hidden'; } catch { return false; }
      };
      // 同一句的重试计数：换句就归零
      if (retryState.i !== i) { retryState.i = i; retryState.n = 0; }
      // "息屏后语音引擎被系统挂起"的重试计数：换句归零
      if (stallState.i !== i) { stallState.i = i; stallState.n = 0; }
      trace({ kind: 'speak', idx: i, chars: s.speak.length, expectedMs: Math.round(expectedMs), hidden: isHidden(), attempt: retryState.n, chunk: chunk.index, gapMs: lastSpeakEndAt ? Date.now() - lastSpeakEndAt : null });

      /* ---------------- 息屏挂起检测与重试 ----------------
       * 华为在息屏一段时间后会把 TTS 引擎/页面挂起：speak() 之后迟迟不触发 onstart，
       * 表现为"念到一半就再也不出声"（直到亮屏）。这里在息屏期间每 4 秒检查一次，
       * 若确认没在念就 cancel + 重念同一句（最多 3 次），把挂起救回来。 */
      const clearStall = () => clearStallTimer();
      const armStall = () => {
        clearStall();
        stallTimer = setTimeout(() => {
          stallTimer = 0;
          if (gen !== previewGen || destroy) return;
          if (spoke) return;
          if (!isHidden()) { armStall(); return; } // 亮屏时交给 2 秒看门狗，这里只观察
          let speaking = false;
          try { speaking = !!(window.speechSynthesis && window.speechSynthesis.speaking); } catch { /* ignore */ }
          if (speaking) { armStall(); return; } // 确实在念（只是没触发 onstart）
          if (stallState.n >= STALL_MAX) {
            trace({ kind: 'stallGiveUp', idx: i, attempt: stallState.n, chunk: chunk.index });
            return;
          }
          stallState.n += 1;
          trace({ kind: 'stall', idx: i, waitedMs: Date.now() - speakT0, attempt: stallState.n, chunk: chunk.index });
          // 标记后取消：避免 cancel 触发的 onerror/onend 走进"被打断→重试"逻辑造成双重播放
          u._stalled = true;
          try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
          setTimeout(() => {
            if (gen !== previewGen || destroy || !wantPlaying) return;
            trace({ kind: 'stallRetry', idx: i, attempt: stallState.n, chunk: chunk.index });
            speakNext();
          }, 300);
        }, STALL_WAIT_MS);
      };


      const watchdog = setTimeout(() => {
        if (gen !== previewGen || spoke) return;
        // 息屏后台时系统可能临时挂起 TTS：此时不能判"没声音"（误报会让播放中断）
        if (isHidden()) return;
        // 有些浏览器不触发 onstart：只要 speechSynthesis.speaking 为真就算已经在念
        try {
          if (window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) return;
        } catch { /* ignore */ }
        trace({ kind: 'watchdog', idx: i, hidden: isHidden(), chunk: chunk.index });
        // 2 秒还没开始出声：多半是系统没有中文语音包/被系统静音 → 明确告知而不是假装在播
        setStatus('error', '系统语音没有出声：可能是手机缺少中文语音包，或该浏览器不支持。可在手机设置里搜索「文字转语音」检查发音人。');
        bus.emit(Events.ERROR, {
          message: '系统语音未出声，请检查手机语音设置（设置里搜「文字转语音」）',
          recoverable: true,
        });
        wantPlaying = false;
        stopKeepAlive(); // 没出声就不要再维持媒体会话
      }, 2000);

      u.onstart = () => {
        if (gen !== previewGen || destroy) return;
        spoke = true;
        clearTimeout(watchdog);
        clearStall();
        trace({ kind: 'start', idx: i, afterMs: Date.now() - speakT0, chunk: chunk.index });
      };

      /**
       * 核心修复：区分「真的念完了」和「被系统打断」。
       * 华为 ArkWeb 在熄屏瞬间会打断当前 utterance（onerror=interrupted/canceled，或提前 onend）。
       * 旧逻辑把它当"念完了"继续 i++，就会把整块剩余句子静默跳过 → 表现成"熄屏跳过一个语音块"。
       * 现在：耗时明显短于该句应有长度 → 判定被打断 → **重念同一句**（最多 2 次）而不是推进。
       */
      const suspiciousEnd = (elapsed) => (spoke ? elapsed < expectedMs * 0.6 : elapsed < 400);

      const handleInterrupted = (reason, elapsed) => {
        trace({ kind: 'interrupted', idx: i, reason, elapsed: Math.round(elapsed), expectedMs: Math.round(expectedMs), hidden: isHidden(), attempt: retryState.n, chunk: chunk.index });
        if (retryState.n < 2) {
          retryState.n += 1;
          trace({ kind: 'retry', idx: i, attempt: retryState.n, chunk: chunk.index });
          setTimeout(() => {
            if (gen !== previewGen || destroy || !wantPlaying) return;
            speakNext();
          }, 260);
          return;
        }
        // 重试用尽
        if (isHidden()) {
          // 息屏中系统确实挂起了 TTS：停在原句，等亮屏继续，绝不跳块
          previewResumeIdx = i;
          previewChunkRef = chunk;
          trace({ kind: 'suspend', idx: i, chunk: chunk.index });
          setStatus('playing');
          return;
        }
        trace({ kind: 'giveup', idx: i, chunk: chunk.index });
        lastSpeakEndAt = Date.now();
        i += 1;
        if (wantPlaying) speakNext();
        else setStatus('paused');
      };

      u.onend = () => {
        clearTimeout(watchdog);
        if (u._stalled) return; // 我们主动 cancel 的（挂起重试），别当正常结束
        if (gen !== previewGen || destroy) return; // 旧会话的回调：绝不能清掉新会话的 stallTimer
        clearStall();
        const elapsed = Date.now() - speakT0;
        lastSpeakEndAt = Date.now();
        trace({ kind: 'end', idx: i, elapsed: Math.round(elapsed), expectedMs: Math.round(expectedMs), cps: elapsed > 300 ? Number((s.speak.length / (elapsed / 1000)).toFixed(1)) : null, spoke, hidden: isHidden(), chunk: chunk.index });
        if (suspiciousEnd(elapsed)) { handleInterrupted(spoke ? 'short-end' : 'no-start-end', elapsed); return; }
        // 正常结束：累计本块"应有/实际"时长，并学习真实语速
        noteSpeechRate(s.speak.length, elapsed, speakRate);
        chunkStat.expected += expectedMs;
        chunkStat.spoken += elapsed;
        i += 1;
        if (wantPlaying) speakNext();
        else setStatus('paused');
      };
      u.onerror = (e) => {
        clearTimeout(watchdog);
        if (u._stalled) return; // 主动 cancel 的，忽略
        if (gen !== previewGen || destroy) return; // 旧会话：不清新会话的 stallTimer
        clearStall();
        const kind = (e && e.error) || 'error';
        const elapsed = Date.now() - speakT0;
        trace({ kind: 'error', idx: i, error: kind, elapsed: Math.round(elapsed), hidden: isHidden(), chunk: chunk.index });
        const hard = kind === 'interrupted' || kind === 'canceled' || kind === 'audio-busy';
        if (hard || suspiciousEnd(elapsed)) { handleInterrupted(kind, elapsed); return; }
        lastSpeakEndAt = Date.now();
        i += 1; // 真正失败的句子不卡死，继续下一句
        if (wantPlaying) speakNext();
      };

      try {
        window.speechSynthesis.speak(u);
        setStatus('playing');
        armStall();
      } catch {
        clearTimeout(watchdog);
        // 某些浏览器 cancel 后立刻 speak 会抛：清空队列后重试一次
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
        setTimeout(() => {
          if (gen !== previewGen || destroy || !wantPlaying) return;
          try { window.speechSynthesis.speak(u); } catch { /* ignore */ }
          armStall();
        }, 200);
        setStatus('playing');
      }
    };

    speakNext();
  }

  /* ---------------- Media Session ---------------- */

  function syncMediaSession() {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: bookTitle || '蝈蝈听书',
        artist: currentSentenceLabel(),
        album: bookTitle || '',
        artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.playbackState =
        state.status === 'playing' ? 'playing' : state.status === 'paused' || state.status === 'buffering' ? 'paused' : 'none';
    } catch {
      /* 某些浏览器实现不完整 */
    }
  }

  function currentSentenceLabel() {
    const s = sentences[state.sentenceIndex];
    if (!s) return '';
    const raw = s.raw.trim();
    return raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
  }

  /** 书名变更（重命名）后同步锁屏/通知栏标题。 */
  function setTitle(title) {
    bookTitle = title || '';
    syncMediaSession();
  }

  function setupMediaSessionHandlers() {
    if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    const safe = (fn) => (details) => {
      try {
        fn(details);
      } catch (e) {
        console.warn('[mediasession] handler error', e);
      }
    };
    const defs = {
      play: () => void play(),
      pause: () => pause(),
      seekbackward: (d) => void seekRelative(-(d && d.seekOffset ? d.seekOffset : 10)),
      seekforward: (d) => void seekRelative(d && d.seekOffset ? d.seekOffset : 10),
      seekto: (d) => {
        if (d && typeof d.seekTime === 'number') void seekToSeconds(d.seekTime);
      },
      previoustrack: () => void prevSentence(),
      nexttrack: () => void nextSentence(),
      stop: () => pause(),
    };
    for (const [action, fn] of Object.entries(defs)) {
      try {
        ms.setActionHandler(action, safe(fn));
      } catch {
        /* 不支持的 action 忽略 */
      }
    }
  }

  /* ---------------- 对外控制 ---------------- */

  async function loadBook(book, opts = {}) {
    previewGen += 1; // 换书：作废旧书的系统语音逐句回调（否则旧书会继续念）
    clearStallTimer();
    stopKeepAlive();
    // 取消旧任务，防串音（含预览档的 speechSynthesis——否则旧书朗读会继续出声）
    cancelAll();
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    if (activeEl) {
      activeEl.pause();
      activeEl.removeAttribute('src');
      activeEl.load();
    }
    // 规则5：单元素，无需 standby 清理
    for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
    chunkCache.clear();
    currentChunk = null;
    wantPlaying = false;

    bookId = book.id;
    bookTitle = book.title;
    // 每书独立记忆的语速/音色/音量：必须在 planChunks 之前生效，
    // 否则会先按旧语速规划，再由外部 setRate 推翻重规划（白合成一块）。
    if (opts.rate != null) state.rate = Math.min(2, Math.max(0.5, Number(opts.rate) || 1));
    if (opts.voice !== undefined) state.voice = opts.voice || null;
    if (opts.volume != null) {
      state.volume = Math.min(1, Math.max(0, Number(opts.volume)));
      audioA.volume = state.volume;
    }
    sentences = book.sentences || [];
    chunkBounds = planChunks();

    const startIdx = opts.sentenceIndex != null
      ? opts.sentenceIndex
      : opts.charOffset != null
        ? nearestSentence(opts.charOffset)
        : 0;
    const clamped = Math.max(0, Math.min(startIdx, sentences.length - 1));
    const s = sentences[clamped];
    patchState({
      bookId,
      sentenceIndex: clamped,
      charOffset: s ? s.start : 0,
      chunkIndex: chunkBounds.length ? chunkOfSentence(clamped) : 0,
      rate: state.rate,
      volume: state.volume,
      voice: state.voice,
    });
    setStatus('idle');
    syncMediaSession();
    if (opts.autoplay) await play();
  }

  function nearestSentence(offset) {
    let lo = 0;
    let hi = sentences.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sentences[mid].start <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** 给任意 Promise 加超时（防止永久挂起——曾导致 play() 卡死）。 */
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}秒）`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  async function play() {
    if (!sentences.length) {
      setStatus('error', '没有可朗读的内容——请先打开一本书');
      bus.emit(Events.ERROR, { message: '没有可朗读的内容，请先打开一本书', recoverable: true });
      return;
    }
    wantPlaying = true;
    setStatus('loading');

    // 取消可能卡住的旧合成 —— 但若目标块正在合成（开书预热），必须复用它，不能取消重来。
    // 仅在状态已出错时才清（正常跳转不 abort 在途合成，避免重复计费）。
    const pendingIdx = chunkBounds.length ? chunkOfSentence(state.sentenceIndex) : 0;
    if (!inflight.has(pendingIdx) && state.status === 'error') cancelAll();

    // 关键：在 await 之前同步调 speechSynthesis（360Browser 需要用户手势上下文）。
    // 用静音预热（volume=0）激活语音引擎，真正的朗读由 previewSpeak/<audio> 接管——
    // 避免与 previewSpeak 双声道重叠（手势说第一句 + preview 说整块 = 第一句重复）。
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        const warm = new SpeechSynthesisUtterance('。');
        warm.volume = 0;
        warm.onend = () => {};
        warm.onerror = () => {};
        window.speechSynthesis.speak(warm);
      } catch { /* ignore */ }
    }

    try {
      const adapter = await withTimeout(getAdapter(), 15000, '语音引擎初始化');
      if (adapter.previewOnly) {
        // 系统语音：尝试"静音保活"，争取熄屏后不被系统停掉（实验特性，失败无副作用）
        startKeepAlive();
        // 不再弹"使用手机自带语音朗读…"的一次性提示：
        // 实测熄屏已能连续播放，且文案里提到的备选引擎对普通访客不可用，纯属干扰。
      } else {
        // <audio> 路径：不需要保活，且要取消手势上下文里的预热语音，避免双声道重叠
        stopKeepAlive();
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      }
    } catch (e) {
      setStatus('error', e.message);
      bus.emit(Events.ERROR, { message: e.message, recoverable: true });
      return;
    }

    // 统一走 seekToSentence（与 nextSentence/prevSentence 同一路径——用户实测这条能工作）
    // 但先检查：audio 还在播就直接续播（不 seek）——避免息屏恢复后从句头重播
    if (activeEl && !activeEl.paused && activeEl.currentTime > 0 && currentChunk && currentChunk.status === 'ready' && currentChunk.url) {
      setStatus('playing');
      void prefetch();
      return;
    }
    // 引擎初始化期间用户可能已按了暂停：此时不要再启动合成（省额度）
    if (!wantPlaying || destroy) return;

    seekToSentence(state.sentenceIndex, { play: true }).catch((e) => {
      if (e && e.name === 'AbortError') return;
      setStatus('error', `播放失败: ${e.message}`);
      bus.emit(Events.ERROR, { message: e.message, recoverable: true });
    });
  }

  function pause() {
    wantPlaying = false;
    previewGen += 1; // 作废系统语音的逐句回调（否则暂停后仍会念下一句）
    clearStallTimer();
    previewResumeIdx = -1;
    stopKeepAlive(); // 暂停就不该继续占用媒体会话
    // 暂停即中止在途合成：否则整块剩余句子仍会继续向云端要音频（白烧额度/流量/电），
    // 已合成的句子都在缓存里，重新播放时不会重合成。
    cancelAll();
    activeEl.pause();
    // 强力取消所有语音（含 trySpeak 轮询中的 + 手势预热的）
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      // 某些浏览器 cancel 后 speeching 标志不立即清除，强制再 cancel 一次
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        setTimeout(() => window.speechSynthesis.cancel(), 100);
      }
    }
    setStatus('paused');
    persistProgress();
    stateWriter?.flush();
  }

  function cancelAll() {
    if (seekBuildTimer) { clearTimeout(seekBuildTimer); seekBuildTimer = 0; }
    sessionAbort.abort();
    sessionAbort = new AbortController();
    for (const [, e] of inflight) e.controller.abort();
    inflight.clear();
  }

  async function stop() {
    wantPlaying = false;
    previewGen += 1;
    clearStallTimer();
    stopKeepAlive();
    cancelAll();
    activeEl.pause();
    // 规则5：单元素
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    setStatus('idle');
  }

  function destroy_() {
    destroy = true;
    wantPlaying = false;
    previewGen += 1;
    clearStallTimer();
    stopKeepAlive();
    cancelAll();
    for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
    audioA.pause();
    audioA.src = '';
    stateWriter?.flush();
  }

  /** 跳到指定句子。 */
  async function seekToSentence(idx, opts = {}) {
    if (!sentences.length) return;
    seekGen++; // 用户主动定位：作废进行中的「块播完自动前进」
    const clamped = Math.max(0, Math.min(idx, sentences.length - 1));
    const s = sentences[clamped];
    const targetChunk = chunkOfSentence(clamped);
    // 立即更新 UI（0ms 响应）——不管合成多慢，用户看到的是即时反馈
    patchState({ sentenceIndex: clamped, charOffset: s.start, chunkIndex: targetChunk });
    bus.emit(Events.SENTENCE, { sentence: s });
    persistProgress();

    if (currentChunk && currentChunk.index === targetChunk && currentChunk.status === 'ready') {
      // 同块内跳转：直接 seek（瞬间完成）
      // preview 块没有 <audio> 源——必须走 previewSpeak 而非 activeEl.play()
      if (currentChunk.preview) {
        if (wantPlaying && opts.play !== false) {
          // 统一走逐句朗读：从目标句开始，后续逐句推进高亮（不再整块一次性念完）
          previewSpeakFrom(currentChunk, clamped);
        } else {
          setStatus('paused');
        }
        return;
      }
      const t = currentChunk.timeline.find((x) => x.sentenceIndex >= clamped);
      if (t && Number.isFinite(t.startSec)) {
        try {
          activeEl.currentTime = t.startSec;
        } catch {
          /* ignore */
        }
        if (wantPlaying && opts.play !== false) {
          try {
            await activeEl.play();
            setStatus('playing');
          } catch (e) {
            // 恢复播放失败（Safari/360 的 NotAllowedError，或并发 pause 的 AbortError）：
            // 绝不能静默吞掉——否则 status 永久停在 loading（"一直转圈"）。
            setStatus('paused');
            if (!e || e.name !== 'AbortError') {
              bus.emit(Events.TOAST, { message: '浏览器阻止了播放，请再点一次播放按钮', level: 'warn' });
            }
          }
        }
        return;
      }
      // 同块内但时间轴上找不到目标句（跳过行/空 speak 落在块尾）：
      // 直接停在块内最后可播位置，不要掉进跨块分支重建同一块（重复合成 + 从句首重放）。
      if (state.status === 'loading') setStatus(wantPlaying ? 'playing' : 'paused');
      return;
    }

    // 该块已在合成中（如开书预热）：直接等它，避免取消后从头再合成一遍
    const gen = seekGen;
    const pending = inflight.get(targetChunk);
    if (pending) {
      setStatus('loading');
      // 必须先停掉旧音频：否则旧块继续播放，它的 timeupdate 会用旧时间轴
      // 反复把 sentenceIndex 写回旧值（表现为「点下一句没反应」）。
      try { activeEl.pause(); } catch { /* ignore */ }
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      }
      pending.promise.then((chunk) => {
        // 合成期间用户又点了别的句子/章节 → 放弃这次播放，否则会用旧起点覆盖用户选择
        if (destroy || gen !== seekGen) return;
        return playChunk(chunk, { startSentence: clamped, autoplay: wantPlaying || opts.play === true });
      }).then(() => {
        if (!destroy) void prefetch();
      }).catch((e) => {
        if (e && e.name === 'AbortError') return;
        setStatus('error', `跳转失败: ${e.message}`);
        bus.emit(Events.ERROR, { message: e.message, recoverable: true });
      });
      return;
    }

    // 跨块：停掉当前声音 → 后台合成目标块（用户可继续操作）
    // 注意：这里**不 abort 在途合成**。abort 只是放弃结果，请求已经发到云端照样计费，
    // 重跳回来又得重发（实测同一句被合成 5 次）。让它在后台跑完进缓存，反而更省。
    // 过期结果由 seekGen 守卫丢弃，不会干扰当前播放。
    activeEl.pause();
    // 同时停 speechSynthesis（preview 模式的声音来源是 speechSynthesis，不是 <audio>）
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setStatus('loading');
    const startBuild = () => {
      // 关键：不 await！合成在后台跑，用户随时可以再点按钮打断
      ensureChunk(targetChunk).then((chunk) => {
        // 同 pending 分支：用户已改主意就不要用旧起点播放
        if (destroy || gen !== seekGen) return;
        return playChunk(chunk, { startSentence: clamped, autoplay: wantPlaying || opts.play === true });
      }).then(() => {
        if (!destroy) void prefetch();
      }).catch((e) => {
        if (e && e.name === 'AbortError') return;
        setStatus('error', `跳转失败: ${e.message}`);
        bus.emit(Events.ERROR, { message: e.message, recoverable: true });
      });
    };
    // 150ms 防抖：连点"下一句/下一章"时每次点击都会 cancelAll 再重建，
    // 结果同一句被反复发往云端（实测同句 4 次），既慢又烧额度。
    // 防抖只推迟"开始合成"，UI 高亮仍是 0ms 立即更新。
    if (seekBuildTimer) clearTimeout(seekBuildTimer);
    seekBuildTimer = setTimeout(() => {
      seekBuildTimer = 0;
      if (gen !== seekGen || destroy) return;
      startBuild();
    }, 150);
  }

  async function nextSentence() {
    await seekToSentence(state.sentenceIndex + 1);
  }
  async function prevSentence() {
    // 播放超过 3 秒时先回到本句开头（类原生听书行为）
    // preview 模式（speechSynthesis）没有 <audio> 进度，用时间估算
    const chunkReady = currentChunk && currentChunk.status === 'ready' && currentChunk.url;
    const elapsed = chunkReady ? activeEl.currentTime : 0;
    if (elapsed > 3) {
      const t = currentChunk?.timeline.find((x) => x.sentenceIndex === state.sentenceIndex);
      if (t) {
        try {
          activeEl.currentTime = t.startSec;
        } catch {
          /* ignore */
        }
        return;
      }
    }
    await seekToSentence(state.sentenceIndex - 1);
  }

  async function nextChapter(chapters) {
    const cur = sentences[state.sentenceIndex];
    if (!cur) return;
    const next = chapters.find((c) => c.start > cur.start);
    if (!next) {
      bus.emit(Events.TOAST, { message: '已经是最后一章', level: 'info' });
      return;
    }
    await seekToSentence(next.sentenceStart, { play: wantPlaying });
  }

  async function prevChapter(chapters) {
    const cur = sentences[state.sentenceIndex];
    if (!cur) return;
    // 若当前句已播超过 2 秒，先回本章开头
    if (activeEl.currentTime > 2) {
      const c = chapters.find((c) => c.index === cur.chapter);
      if (c) {
        await seekToSentence(c.sentenceStart, { play: wantPlaying });
        return;
      }
    }
    const prevs = chapters.filter((c) => c.start < cur.start);
    const prev = prevs[prevs.length - 1];
    if (!prev) {
      bus.emit(Events.TOAST, { message: '已经是第一章', level: 'info' });
      return;
    }
    await seekToSentence(prev.sentenceStart, { play: wantPlaying });
  }

  /** 拖动进度条：按字符偏移定位。 */
  async function seekToCharOffset(offset) {
    await seekToSentence(nearestSentence(offset));
  }

  /** 相对秒数定位（锁屏 seekbackward/forward + 「回退15秒」）：换算成句内偏移。 */
  async function seekRelative(deltaSec) {
    // 还没开始播过（currentChunk 为空）时，seekToSeconds 会直接 return，
    // 表现为「点了回退15秒没反应」。这里按字速估算目标句，保证按钮一定有效。
    if (!currentChunk) {
      const charsPerSec = CHARS_PER_SEC * (state.rate || 1);
      const targetOffset = Math.max(0, (state.charOffset || 0) + deltaSec * charsPerSec);
      await seekToSentence(nearestSentence(targetOffset), { play: wantPlaying });
      return;
    }
    const t = activeEl.currentTime + deltaSec;
    await seekToSeconds(t);
  }

  async function seekToSeconds(secInChunk) {
    if (!currentChunk) return;
    const fromChunk = currentChunk;
    let target = fromChunk.sentenceStart;
    for (const item of fromChunk.timeline) {
      if (secInChunk >= item.startSec) target = item.sentenceIndex;
    }
    await seekToSentence(target);
    // 仅当仍停留在原块时做句内精确定位：secInChunk 是「旧块内」的秒数，
    // 跨块后新块的秒数轴完全不同，套用会跳到错误位置（锁屏快进跨块场景）。
    if (currentChunk === fromChunk && currentChunk && currentChunk.index === state.chunkIndex) {
      const t = currentChunk.timeline.find((x) => x.sentenceIndex === target);
      if (t) {
        try {
          activeEl.currentTime = Math.max(0, Math.min(secInChunk, currentChunk.durationSec - 0.05));
        } catch {
          /* ignore */
        }
      }
    }
  }

  function setRate(rate) {
    const old = state.rate;
    state.rate = Math.min(2, Math.max(0.5, rate));
    if (state.rate === old) return;
    // 语速变化影响分块与合成参数：取消旧任务重新规划，不从头开始
    cancelAll();
    chunkBounds = planChunks();
    const resume = wantPlaying;
    const sid = state.sentenceIndex;
    chunkCache.clear();
    currentChunk = null;
    activeEl.pause();
    activeEl.removeAttribute('src');
    activeEl.load();
    // 规则5：单元素
    // 规则5：单元素
    for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
    wantPlaying = resume;
    patchState({ rate: state.rate, chunkIndex: chunkBounds.length ? chunkOfSentence(sid) : 0 });
    if (resume) {
      setStatus('loading');
      void (async () => {
        try {
          const chunk = await ensureChunk(state.chunkIndex);
          if (destroy || !wantPlaying) return;
          await playChunk(chunk, { startSentence: sid, autoplay: true });
          void prefetch();
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          setStatus('error', e.message);
        }
      })();
    } else {
      setStatus('paused');
    }
  }

  /**
   * 使音频缓存整体失效（引擎/模型档位切换后调用）：
   * 不同引擎或档位的采样率可能不同，新旧块混用会导致 WAV 合并失败。
   * 保持当前位置与播放意图，从当前句按新引擎重新合成。
   */
  function invalidateAudio() {
    previewGen += 1;
    clearStallTimer();
    stopKeepAlive();
    cancelAll();
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    const resume = wantPlaying;
    const sid = state.sentenceIndex;
    chunkCache.clear();
    currentChunk = null;
    activeEl.pause();
    activeEl.removeAttribute('src');
    activeEl.load();
    // 规则5：单元素
    // 规则5：单元素
    for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
    wantPlaying = resume;
    if (resume) {
      void seekToSentence(sid, { play: true });
    } else if (state.status !== 'idle') {
      setStatus('paused');
    }
  }

  function setVoice(voiceId) {
    const next = voiceId || null;
    // 同值短路：选音色时会经 reader + updateSettings 两条路各调一次，
    // 不短路就会重复 cancelAll + 清缓存 + 重新合成（白烧一次额度）。
    if (state.voice === next) return;
    state.voice = next;
    // 音色变化：合成缓存失效，但保持当前位置继续
    cancelAll();
    const resume = wantPlaying;
    const sid = state.sentenceIndex;
    chunkCache.clear();
    currentChunk = null;
    activeEl.pause();
    for (const u of blobUrls.splice(0)) URL.revokeObjectURL(u);
    wantPlaying = resume;
    patchState({ voice: voiceId });
    if (resume) void seekToSentence(sid, { play: true });
    else setStatus('paused');
  }

  function setVolume(v) {
    state.volume = Math.min(1, Math.max(0, v));
    audioA.volume = state.volume;
    patchState({ volume: state.volume });
  }

  /** 定时关闭淡出。用 setTimeout 而非 rAF：熄屏时 rAF 被冻结，淡出将永不完成；
   *  而正在出声的页面豁免后台定时器节流（Chrome 官方），setTimeout 在锁屏下仍可靠。 */
  async function fadeOut(ms = 2000) {
    const start = state.volume;
    const t0 = Date.now();
    const tickMs = 100;
    return new Promise((resolve) => {
      const step = () => {
        const p = Math.min(1, (Date.now() - t0) / ms);
        setVolume(start * (1 - p));
        if (p < 1) {
          setTimeout(step, tickMs);
        } else {
          pause();
          setVolume(start);
          resolve();
        }
      };
      setTimeout(step, tickMs);
    });
  }

  /* ---------------- 初始化 ---------------- */

  function attachVisibilityFallback() {
    // 规则5：hidden 即 abort —— 熄屏后停止合成（省电），已建 Blob 队列继续播放。
    // 系统豁免的是播放本身，不是 JS 调度；不依赖后台定时器做任何调度。
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        // 记录可见性变化：排查"熄屏跳块"时，必须能把事件和熄屏时刻对齐
        trace({ kind: 'vis', hidden: true, status: state.status, sentenceIndex: state.sentenceIndex, chunk: state.chunkIndex, speaking: !!(window.speechSynthesis && window.speechSynthesis.speaking) });
        // 中止在途合成（已缓存的句子不受影响）；播放由 <audio> 自行继续
        sessionAbort.abort(new DOMException('页面隐藏', 'AbortError'));
        sessionAbort = new AbortController();
        return;
      }
      trace({ kind: 'vis', hidden: false, status: state.status, sentenceIndex: state.sentenceIndex, chunk: state.chunkIndex, speaking: !!(window.speechSynthesis && window.speechSynthesis.speaking) });
      // 亮屏：同步 UI 状态到实际播放位置（息屏期间 advanceChunk 可能推了 sentenceIndex）
      // 注意：系统语音（preview）不走 <audio>，碰 activeEl 会误触发 waiting → 状态卡在 buffering。
      const isPreviewEngine = activeEngineId === 'speech-preview';
      if (!isPreviewEngine && activeEl && !activeEl.paused && currentChunk && currentChunk.status === 'ready' && currentChunk.url) {
        const t = activeEl.currentTime;
        const sid = currentSentenceInChunk(currentChunk, t);
        if (sid !== state.sentenceIndex && sentences[sid]) {
          const s = sentences[sid];
          state.sentenceIndex = sid;
          state.charOffset = s.start;
          bus.emit(Events.SENTENCE, { sentence: s });
          onStatePatch?.({ sentenceIndex: sid, charOffset: s.start });
        }
        if (wantPlaying && state.status !== 'playing') setStatus('playing');
      } else if (!isPreviewEngine && wantPlaying && activeEl.paused && state.status !== 'error') {
        void activeEl.play().catch(() => {});
      }
      // 系统语音：亮屏时若保活被系统暂停/回收，重新拉起，尽量维持后台能力
      if (wantPlaying && activeEngineId === 'speech-preview') {
        startKeepAlive();
        // 息屏期间 TTS 被系统打断（可能连 onend/onerror 都不触发）：亮屏后从被打断的那句继续，
        // 绝不"跳过整块"。仅在确实没在念的时候恢复，避免与正常播放抢话。
        let speaking = false;
        try {
          speaking = !!(window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending));
        } catch { /* ignore */ }
        if (!speaking && state.status !== 'error') {
          const idx = previewResumeIdx >= 0 ? previewResumeIdx : state.sentenceIndex;
          const ref = previewChunkRef;
          const chunk = (ref && idx >= ref.sentenceStart && idx < ref.sentenceEnd) ? ref : currentChunk;
          previewResumeIdx = -1;
          if (chunk && chunk.preview && idx >= chunk.sentenceStart && idx < chunk.sentenceEnd) {
            previewSpeakFrom(chunk, idx);
          }
        }
      }
      // 恢复预取（hidden 时中止了）
      if (wantPlaying) void prefetch();
      stateWriter?.flush();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', () => stateWriter?.flush());
    window.addEventListener('beforeunload', () => stateWriter?.flush());
    // 音频焦点被抢（来电/其他 App）：pause 事件时保留 wantPlaying，回页恢复。
    // 双元素都要监听：任一元素在播放时被打断都能捕获。
    // 自身主动 pause() 时 status 已先变为 paused，故下面的 status==='playing' 判断天然排除自触发。
    const onInterruptionPause = (el) => () => {
      if (wantPlaying && !el.ended && el === activeEl && document.visibilityState === 'visible') {
        if (state.status === 'playing') {
          setStatus('paused');
          bus.emit(Events.TOAST, { message: '播放被系统中断，点继续恢复', level: 'warn' });
        }
      }
    };
    audioA.addEventListener('pause', onInterruptionPause(audioA));
  }

  setupMediaSessionHandlers();
  attachVisibilityFallback();

  return {
    // 状态
    getState: () => ({ ...state }),
    getSentences: () => sentences,
    // 控制
    loadBook,
    setTitle,
    play,
    pause,
    stop,
    nextSentence,
    prevSentence,
    nextChapter,
    prevChapter,
    seekToSentence,
    seekToCharOffset,
    seekRelative,
    warmCurrentChunk,
    invalidateAudio,
    setRate,
    setVoice,
    setVolume,
    fadeOut,
    destroy: destroy_,
    // 供诊断页
    _diag: () => ({
      chunkIndex: state.chunkIndex,
      chunkTotal: chunkBounds.length,
      cachedChunks: [...chunkCache.keys()],
      inflight: [...inflight.keys()],
      activeSrc: (activeEl.currentSrc || activeEl.src || '').slice(0, 64),
      activePaused: activeEl.paused,
      activeTime: activeEl.currentTime,
      wantPlaying,
      status: state.status,
      error: state.error || null,
      keepAlive: isKeepAliveOn(),
      engine: activeEngineId,
      trace: traceLog.slice(-30),
    }),
    /** 完整系统语音事件日志（供自检页「复制播放日志」） */
    _trace: () => traceLog.slice(),
    // 供导出音频：按块取 blob
    _getChunkBlob: async (index) => (await ensureChunk(index)).blob,
    _chunkCount: () => chunkBounds.length,
    _chunkIndexForSentence: (idx) => (chunkBounds.length ? chunkOfSentence(idx) : 0),
  };
}
