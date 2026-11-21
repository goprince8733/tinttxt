/**
 * 全局共享类型契约（JSDoc）。五层之间只通过这些结构与事件总线通信。
 * 播放层禁止读 DOM；UI 层禁止直接碰 IndexedDB（走存储层）。
 * @module core/contracts
 */

/**
 * @typedef {Object} Sentence
 * @property {number} index      在全书句子序列中的序号（0 起）
 * @property {number} start      原文字符偏移（含）
 * @property {number} end        原文字符偏移（不含）
 * @property {number} chapter    所属章节序号
 * @property {string} raw        原文切片
 * @property {string} speak      朗读文本（已做标点剔除/正则化）
 * @property {boolean} skippable 是否为可跳过的空行/注释/分隔线/广告行
 */

/**
 * @typedef {Object} Chapter
 * @property {number} index
 * @property {string} title
 * @property {number} start      字符偏移
 * @property {number} end        字符偏移
 * @property {number} sentenceStart
 * @property {number} sentenceEnd
 */

/**
 * @typedef {Object} Book
 * @property {string} id         文件名 + 内容哈希
 * @property {string} title
 * @property {string} text       全文正文（持久化）
 * @property {Chapter[]} chapters
 * @property {number} size       字节数
 * @property {number} chars      字数
 * @property {string} encoding   探测到的编码
 * @property {string} contentHash sha-256 hex（用于发现文件改动）
 * @property {number} addedAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} PlaybackState
 * @property {'idle'|'loading'|'playing'|'paused'|'buffering'|'error'} status
 * @property {string|null} bookId
 * @property {number} charOffset   当前字符偏移
 * @property {number} sentenceIndex
 * @property {number} chunkIndex   当前音频块索引
 * @property {number} rate         语速 0.5–2.0
 * @property {string|null} voice   音色 id
 * @property {number} volume       0–1
 * @property {string|null} error
 */

/**
 * @typedef {Object} Mark
 * @property {string} id
 * @property {string} bookId
 * @property {number} offset
 * @property {number} sentenceIndex
 * @property {string} note
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Settings
 * @property {number} rate
 * @property {string|null} voice
 * @property {number} volume
 * @property {'system'|'light'|'dark'} theme
 * @property {string} chapterRegex
 * @property {boolean} skipEmptyLines
 * @property {boolean} skipNotes
 * @property {boolean} skipSeparators
 * @property {boolean} readPunctuation
 * @property {boolean} normalizeNumbers
 * @property {boolean} dialogueVoice   引号内对话切另一音色
 * @property {string|null} dialogueVoiceId
 * @property {boolean} cloudTtsEnabled 显式开关，默认 false
 * @property {number} chunkSeconds     音频块目标秒数（默认 100，1–3 分钟区间内）
 * @property {number} prefetchDepth    预取块数（默认 2）
 * @property {string} modelTier        'medium' | 'x_low'
 * @property {boolean} wakelockEnabled
 */

/**
 * TTS 适配器统一接口。播放层只消费 Blob，换引擎不改上层。
 * @typedef {Object} TtsAdapter
 * @property {string} id
 * @property {string} label
 * @property {boolean} requiresNetwork
 * @property {(opts?: {signal?: AbortSignal}) => Promise<void>} prepare  下载/初始化模型
 * @property {(text: string, opts: {voice?: string, rate?: number, signal?: AbortSignal, onProgress?: (p:number)=>void}) => Promise<TtsResult>} synthesize
 * @property {() => Promise<VoiceInfo[]>} listVoices
 * @property {() => Promise<boolean>} isReady
 */

/**
 * @typedef {Object} TtsResult
 * @property {Blob} blob
 * @property {string} mime
 * @property {number} durationSeconds 估算/实测时长
 * @property {number} chars           输入字符数
 */

/**
 * @typedef {Object} VoiceInfo
 * @property {string} id
 * @property {string} label
 * @property {'local'|'cloud'} kind
 * @property {boolean} dialogueCapable 支持多说话人（对话音色）
 */

/** 事件总线事件名（字符串常量，避免层间隐式耦合）。 */
export const Events = Object.freeze({
  STATE: 'playback:state',          // PlaybackState 变更
  SENTENCE: 'playback:sentence',    // { sentence: Sentence }
  PROGRESS: 'playback:progress',    // { charOffset, positionSec, durationSec }
  ERROR: 'playback:error',          // { message, recoverable }
  BOOK_END: 'playback:bookEnd',     // { bookId } 本书读完（排队播放据此续播下一本书）
  BOOKS: 'books:changed',           // 书架变更
  QUEUE: 'queue:changed',           // 播放队列变更
  SETTINGS: 'settings:changed',     // Settings 变更
  TOAST: 'ui:toast',                // { message, level, action? }
  WAKELOCK: 'system:wakelock',      // { supported, active }
  DIAG: 'system:diag',              // 后台自检心跳数据
});

/**
 * 极简事件总线：层间唯一通信机制。
 * @returns {{on:(e:string,h:Function)=>()=>void, emit:(e:string,p?:any)=>void}}
 */
export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();
  return {
    on(e, h) {
      if (!map.has(e)) map.set(e, new Set());
      map.get(e).add(h);
      return () => map.get(e)?.delete(h);
    },
    emit(e, p) {
      const set = map.get(e);
      if (!set) return;
      for (const h of [...set]) {
        try {
          h(p);
        } catch (err) {
          console.error(`[bus] handler for ${e} threw`, err);
        }
      }
    },
  };
}
