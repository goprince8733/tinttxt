/**
 * 按句音频缓存（IndexedDB 持久化）——规则1+4：缓存粒度=句，键=md5(normalizedText+voiceId+rate)
 *
 * 设计：
 * - 一句合成一次，永久缓存（刷新/关页/改语速回切都不重复合成）；
 * - 键包含 rate：改语速→新键→新缓存条目；切回旧语速→命中旧缓存；
 * - 按句缓存（非整章）：跳章/回退/重听单句全命中，不重复合成；
 * - 非「热门书预合成 CDN」模式（单用户单本，无重复命中规模，纯浪费额度）。
 *
 * 存储：独立 IndexedDB 库（tinttxt-audio-cache），与主库隔离，避免音频大对象拖慢主库。
 * 逐出策略：LRU（get 时刷新 lastUsed），超过 MAX_ENTRIES 时删除最久未用条目。
 *
 * @module playback/tts/audio-cache
 */

const DB_NAME = 'tinttxt-audio-cache';
const STORE_NAME = 'audio';
const DB_VERSION = 1;
/** 最大缓存句数（约 2000 句 × 5 秒 ≈ 10000 秒 ≈ 2.8 小时音频） */
const MAX_ENTRIES = 2000;

/** @type {IDBDatabase|null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const s = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        s.createIndex('lastUsed', 'lastUsed', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/**
 * 归一化文本（供缓存键）：去首尾空白、合并连续空白。
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
}

/**
 * 缓存键：md5(normalizedText + '|' + voiceId + '|' + rate)。
 * 用 SHA-256（浏览器内置，无依赖）代替 md5——键唯一性目的相同，且无需手写哈希。
 * 带 3 秒超时：crypto.subtle.digest 在某些浏览器可能挂起。
 * @param {string} text @param {string|null|undefined} voiceId @param {number} rate
 * @returns {Promise<string>} hex 摘要
 */
async function cacheKey(text, voiceId, rate) {
  const input = `${normalizeText(text)}|${voiceId || 'default'}|${rate || 1}`;
  const data = new TextEncoder().encode(input);
  const hash = await Promise.race([
    crypto.subtle.digest('SHA-256', data),
    new Promise((_, reject) => setTimeout(() => reject(new Error('hash timeout')), 3000)),
  ]);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 查缓存（命中刷新 LRU 时间戳）。带 3 秒超时——IndexedDB 在某些浏览器可能挂起，
 * 超时退化为不缓存（返回 null），避免 buildChunk 永远卡住导致播放按钮永久转圈。
 * @param {string} text @param {string|null} voiceId @param {number} rate
 * @returns {Promise<Blob|null>}
 */
export async function getAudio(text, voiceId, rate) {
  try {
    const key = await cacheKey(text, voiceId, rate);
    const db = await openDb();
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => done(null), 3000);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        clearTimeout(timer);
        const row = req.result;
        if (!row) { done(null); return; }
        try { tx.objectStore(STORE_NAME).put({ ...row, lastUsed: Date.now() }); } catch { /* ignore */ }
        done(row.blob);
      };
      req.onerror = () => { clearTimeout(timer); done(null); };
    });
  } catch {
    return null; // 隐私模式/crypto 不可用时退化为不缓存
  }
}

/**
 * 写缓存（LRU 逐出）。
 * @param {string} text @param {string|null} voiceId @param {number} rate @param {Blob} blob
 * @returns {Promise<void>}
 */
export async function putAudio(text, voiceId, rate, blob) {
  if (!blob || !blob.size) return;
  try {
    const key = await cacheKey(text, voiceId, rate);
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({
        key,
        blob,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/**
 * LRU 逐出：超过 MAX_ENTRIES 时按 lastUsed 索引删除最久未用的条目。
 * @returns {Promise<number>} 删除条数
 */
export async function evictLru() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const total = countReq.result;
        if (total <= MAX_ENTRIES) {
          resolve(0);
          return;
        }
        const toDelete = total - MAX_ENTRIES;
        // 用 lastUsed 索引按时间升序遍历，直接删最旧的 toDelete 条
        const idx = store.index('lastUsed');
        const cursorReq = idx.openCursor();
        let deleted = 0;
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && deleted < toDelete) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            resolve(deleted);
          }
        };
        cursorReq.onerror = () => resolve(0);
      };
      countReq.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

/**
 * 清空缓存（设置页「清理缓存」按钮调用）。
 * @returns {Promise<void>}
 */
export async function clearAudioCache() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/**
 * 缓存统计（诊断页显示）。
 * @returns {Promise<{count:number, totalBytes:number}>}
 */
export async function audioCacheStats() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      let totalBytes = 0;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          totalBytes += cursor.value.blob ? cursor.value.blob.size : 0;
          cursor.continue();
        }
      };
      countReq.onsuccess = () => {
        // 等游标扫完再返回（简单同步：count 通常先完成）
        setTimeout(() => resolve({ count: countReq.result, totalBytes }), 100);
      };
    });
  } catch {
    return { count: 0, totalBytes: 0 };
  }
}
