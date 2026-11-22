/**
 * 存储层 —— IndexedDB 持久化
 * 表：books / state / marks / settings / stats
 * 播放层与 UI 层均不得直接操作 IndexedDB，只能经由本层。
 * @module layers/storage
 */

const DB_NAME = 'tinttxt';
const DB_VERSION = 1;

/** @typedef {import('../../core/contracts.js').Book} Book */
/** @typedef {import('../../core/contracts.js').Mark} Mark */
/** @typedef {import('../../core/contracts.js').Settings} Settings */

/** @type {IDBDatabase|null} */
let dbPromise = null;
let opening = null;

function openDb() {
  if (dbPromise) return Promise.resolve(dbPromise);
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const s = db.createObjectStore('books', { keyPath: 'id' });
        s.createIndex('title', 'title', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains('marks')) {
        const s = db.createObjectStore('marks', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('stats')) {
        db.createObjectStore('stats', { keyPath: 'day' });
      }
    };
    req.onsuccess = () => {
      dbPromise = req.result;
      dbPromise.onclose = () => {
        dbPromise = null;
        opening = null;
      };
      resolve(dbPromise);
    };
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
  }).finally(() => {
    opening = null;
  });
  return opening;
}

/** @param {string} name @param {IDBTransactionMode} mode */
async function tx(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const store = t.objectStore(name);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
}

/** 简单 promise 包装 request。 */
function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------------- books ---------------- */

/** @param {Book} book */
export async function putBook(book) {
  await tx('books', 'readwrite', (s) => s.put(book));
  return book;
}

/** @returns {Promise<Book[]>} */
export async function listBooks() {
  const db = await openDb();
  const t = db.transaction('books', 'readonly');
  return reqP(t.objectStore('books').getAll());
}

/** @param {string} id @returns {Promise<Book|undefined>} */
export async function getBook(id) {
  const db = await openDb();
  const t = db.transaction('books', 'readonly');
  return reqP(t.objectStore('books').get(id));
}

/** @param {string} id */
export async function deleteBook(id) {
  await tx('books', 'readwrite', (s) => s.delete(id));
  await tx('state', 'readwrite', (s) => s.delete(id));
  const db = await openDb();
  const t = db.transaction('marks', 'readwrite');
  const idx = t.objectStore('marks').index('bookId');
  const marks = await reqP(idx.getAll(IDBKeyRange.only(id)));
  for (const m of marks) t.objectStore('marks').delete(m.id);
}

/** @param {string} id @param {Partial<Book>} patch */
export async function patchBook(id, patch) {
  const db = await openDb();
  const t = db.transaction('books', 'readwrite');
  const s = t.objectStore('books');
  const cur = await reqP(s.get(id));
  if (!cur) return undefined;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  s.put(next);
  return next;
}

/* ---------------- state（播放进度） ---------------- */

/**
 * @typedef {Object} BookState
 * @property {string} bookId
 * @property {number} charOffset
 * @property {number} sentenceIndex
 * @property {number} chunkIndex
 * @property {number} rate
 * @property {string|null} voice
 * @property {number} volume
 * @property {number} updatedAt
 */

/** @param {BookState} st */
export async function putState(st) {
  await tx('state', 'readwrite', (s) => s.put(st));
}

/** @param {string} bookId @returns {Promise<BookState|undefined>} */
export async function getState(bookId) {
  const db = await openDb();
  const t = db.transaction('state', 'readonly');
  return reqP(t.objectStore('state').get(bookId));
}

/** @returns {Promise<BookState[]>} 所有书的进度（用于恢复上次收听） */
export async function getAllStates() {
  const db = await openDb();
  const t = db.transaction('state', 'readonly');
  return reqP(t.objectStore('state').getAll());
}

/* ---------------- marks（书签） ---------------- */

/** @param {Mark} mark */
export async function putMark(mark) {
  await tx('marks', 'readwrite', (s) => s.put(mark));
}

/** @param {string} id */
export async function deleteMark(id) {
  await tx('marks', 'readwrite', (s) => s.delete(id));
}

/** @param {string} bookId @returns {Promise<Mark[]>} */
export async function listMarks(bookId) {
  const db = await openDb();
  const t = db.transaction('marks', 'readonly');
  const idx = t.objectStore('marks').index('bookId');
  return reqP(idx.getAll(IDBKeyRange.only(bookId)));
}

/** @returns {Promise<Mark[]>} */
export async function listAllMarks() {
  const db = await openDb();
  const t = db.transaction('marks', 'readonly');
  return reqP(t.objectStore('marks').getAll());
}

/* ---------------- settings ---------------- */

/**
 * 设置结构版本。
 * v1：默认引擎 local-sherpa（许可证干净档）。
 * v2：默认改 local-piper（性能：多线程 RTF≈0.1 vs sherpa 单线程≈1.5）。
 * v3：默认改回 local-sherpa —— 真机 A/B 试听结论：Piper 发音不可懂（"鸟语"，
 *     x_low 档还额外缺声调），sherpa 吐字清晰。听得懂 > 流畅；速度问题由
 *     Worker（界面不卡）+ 云端 TTS（后续）解决。
 */
const SETTINGS_VERSION = 4;

export const DEFAULT_SETTINGS = Object.freeze({
  rate: 1.0,
  voice: null,
  volume: 1.0,
  theme: 'system',
  chapterRegex:
    '^(?:第[零一二三四五六七八九十百千万两\\d]+[章卷回节篇]|卷[零一二三四五六七八九十百千万两\\d]+|[\\d]+[\\.、]\\s*\\S{0,20}|Part\\s+\\d+|Chapter\\s+\\d+|附录.{0,10}|(?:序章|楔子|尾声|后记|前言|简介)(?:\\s|$|：|:))',
  skipEmptyLines: true,
  skipNotes: true,
  skipSeparators: true,
  readPunctuation: false,
  normalizeNumbers: true,
  dialogueVoice: false,
  dialogueVoiceId: null,
  cloudTtsEnabled: false, // 百度云端默认关闭（默认用手机自带语音）
  cloudEndpoint: '', // 留空 → 自动使用同域 /api/tts（Pages Functions）
  ttsEngine: 'system', // v4 默认：用手机自带语音（华为等机型系统音色最好听）；百度/本地按需选
  settingsVersion: SETTINGS_VERSION,
  sherpaTier: 'int8',        // int8 ~39MB（默认）/ full ~121MB
  chunkSeconds: 30, // 单块目标时长（秒）；播放器另把「首块」压到 8 秒内以便秒出声
  prefetchDepth: 2,
  modelTier: 'medium', // Piper 档（仅 ttsEngine='local-piper' 时生效）：63.2MB；x_low 20.6MB 省流
  wakelockEnabled: true,
  playQueue: [], // 播放队列（书 id 顺序列表，多文件排队播放）
});

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const db = await openDb();
  const t = db.transaction('settings', 'readonly');
  const row = await reqP(t.objectStore('settings').get('app'));
  const raw = row ? row.value : null;
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // 注：所有设备默认 medium —— 实测 x_low 词表(130)没有声调数字键，声调符号会被
  // 丢弃导致发音缺损（"听不懂"），省流量不能牺牲听得懂，故不做移动端降档。
  // v3→v4 迁移：真机反馈「手机自带语音最好听，连语音包反而难听」。
  // 统一改成默认=系统语音、百度关闭；本地 sherpa/Piper 保留为可选（默认不下载模型）。
  // 这是一次性重置：用户随时可在阅读页「语音来源」里切回百度或本地。
  if (raw && (raw.settingsVersion == null || raw.settingsVersion < SETTINGS_VERSION)) {
    merged.ttsEngine = 'system';
    merged.cloudTtsEnabled = false;
    merged.settingsVersion = SETTINGS_VERSION;
    const t2 = db.transaction('settings', 'readwrite');
    t2.objectStore('settings').put({ key: 'app', value: merged });
    await new Promise((res, rej) => {
      t2.oncomplete = res;
      t2.onerror = () => rej(t2.error);
      t2.onabort = () => rej(t2.error);
    });
  }
  return merged;
}

/** @param {Partial<Settings>} patch */
export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await tx('settings', 'readwrite', (s) => s.put({ key: 'app', value: next }));
  return next;
}

/* ---------------- stats（听书统计） ---------------- */

/**
 * @typedef {Object} StatRow
 * @property {string} day   YYYY-MM-DD
 * @property {number} ms    当日收听毫秒
 * @property {number} streakDays 连续天数（写入时计算）
 */

/** @param {string} day @returns {Promise<StatRow|undefined>} */
export async function getStat(day) {
  const db = await openDb();
  const t = db.transaction('stats', 'readonly');
  return reqP(t.objectStore('stats').get(day));
}

/** 等待事务完成（用于串行化读改写，避免并发覆盖）。 */
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
}

/** 统计写入串行链：并发 addStat 若同时读到旧值会互相覆盖（丢失更新），必须排队执行。 */
let statWriteChain = Promise.resolve();

/**
 * 累加当日收听时长（串行执行，杜绝读改写竞态）。
 * @param {string} day @param {number} addMs
 * @returns {Promise<StatRow>}
 */
export function addStat(day, addMs) {
  const run = async () => {
    const db = await openDb();
    const t = db.transaction('stats', 'readwrite');
    const s = t.objectStore('stats');
    const cur = await reqP(s.get(day));
    const row = { day, ms: (cur ? cur.ms : 0) + addMs, streakDays: 1 };
    s.put(row);
    await txDone(t);
    return row;
  };
  const p = statWriteChain.then(run, run);
  statWriteChain = p.catch(() => {}); // 失败不阻断后续排队
  return p;
}

/** @returns {Promise<StatRow[]>} */
export async function listStats() {
  const db = await openDb();
  const t = db.transaction('stats', 'readonly');
  return reqP(t.objectStore('stats').getAll());
}

/* ---------------- 防抖落盘（不丢最后位置） ---------------- */

/**
 * 写进度：普通写防抖 800ms 合并；flush() 立即强制写。
 * 页面隐藏/卸载时必须调用 flush，保证最后位置不丢。
 */
export function createStateWriter() {
  /** @type {BookState|null} */
  let pending = null;
  let timer = 0;
  let writing = Promise.resolve();

  function doWrite() {
    if (!pending) return writing;
    const payload = pending;
    pending = null;
    writing = writing.then(() => putState(payload)).catch((e) => console.error('[storage] 写进度失败', e));
    return writing;
  }

  return {
    /** @param {BookState} st */
    schedule(st) {
      pending = st;
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        doWrite();
      }, 800);
    },
    /** 立即强制落盘（visibilitychange/pagehide/beforeunload 调用）。 */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      return doWrite();
    },
  };
}

/* ---------------- 导出 / 导入 JSON（备份） ---------------- */

/**
 * 导出：books + state + marks + settings + stats 全量。
 * @returns {Promise<object>}
 */
export async function exportAll() {
  const [books, states, marks, settings, stats] = await Promise.all([
    listBooks(),
    getAllStates(),
    listAllMarks(),
    getSettings(),
    listStats(),
  ]);
  return {
    app: 'tinttxt',
    version: 1,
    exportedAt: new Date().toISOString(),
    books,
    states,
    marks,
    settings,
    stats,
  };
}

/**
 * 导入。
 * - replace：全量恢复（清空后写入，含设置与统计）——「还原备份」语义；
 * - merge：合并书架/进度/书签，**不覆盖当前设置**（用户导入一本书不该被回滚设置），
 *   统计按「同日取较大值」合并（避免用旧备份覆盖当天已积累的收听时长）。
 * @param {object} data
 * @param {{mode?: 'merge'|'replace'}} [opts]
 */
export async function importAll(data, opts = {}) {
  if (!data || data.app !== 'tinttxt') throw new Error('不是有效的 TintTXT 备份文件');
  const mode = opts.mode || 'merge';
  const db = await openDb();
  if (mode === 'replace') {
    for (const name of ['books', 'state', 'marks', 'settings', 'stats']) {
      const t = db.transaction(name, 'readwrite');
      t.objectStore(name).clear();
      await new Promise((res, rej) => {
        t.oncomplete = res;
        t.onerror = rej;
      });
    }
  }
  for (const b of data.books || []) await putBook(b);
  for (const s of data.states || []) await putState(s);
  for (const m of data.marks || []) await putMark(m);
  if (data.settings && mode === 'replace') {
    await tx('settings', 'readwrite', (st) => st.put({ key: 'app', value: { ...DEFAULT_SETTINGS, ...data.settings } }));
  }
  for (const row of data.stats || []) {
    if (mode === 'merge') {
      const cur = await getStat(row.day);
      if (cur && cur.ms >= row.ms) continue; // 已有更大值：不回退
    }
    await tx('stats', 'readwrite', (st) => st.put(row));
  }
}
