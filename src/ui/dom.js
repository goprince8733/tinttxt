/**
 * UI 层 —— DOM 与格式化工具（无业务逻辑）
 * 所有用户数据一律通过 textContent 写入，杜绝 XSS。
 * @module ui/dom
 */

/** @param {string} sel @param {ParentNode} [root] */
export function $(sel, root = document) {
  return root.querySelector(sel);
}

/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement[]} */
export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/**
 * 创建元素。文本一律走 textContent（安全）。
 * @param {string} tag
 * @param {{class?:string, text?:string, title?:string, attrs?:Record<string,string>, dataset?:Record<string,string>, onClick?:EventListener}} [props]
 * @param {(Node|string)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text != null) node.textContent = props.text;
  if (props.title != null) node.setAttribute('title', props.title);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.onClick) node.addEventListener('click', props.onClick);
  for (const c of children) node.append(c);
  return node;
}

/** @param {Element} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 时长（毫秒）→ 「N小时M分」/「N分钟」（统计条用）。 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 60000));
  if (total < 1) return '0分钟';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h < 1) return `${total}分钟`;
  if (h < 24) return m ? `${h}小时${m}分` : `${h}小时`;
  const d = Math.floor(h / 24);
  return `${d}天${h % 24}小时`;
}

/** 剩余时长（秒）→ 「N小时M分」/「N分钟」。 */
export function formatSeconds(sec) {
  return formatDuration(Math.max(0, sec) * 1000);
}

/** 字数 → 「12.3万字」/「8600字」。 */
export function formatChars(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万字`;
  return `${v}字`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 最后收听时间 → 刚刚 / N分钟前 / N小时前 / 昨天 / 日期。 */
export function relativeTime(ts) {
  if (!ts) return '从未收听';
  const now = new Date();
  const d = new Date(ts);
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return '刚刚';
  if (sameDay(now, d)) {
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}分钟前`;
    return `${Math.floor(mins / 60)}小时前`;
  }
  const y = new Date(now.getTime() - 86400000);
  if (sameDay(y, d)) return '昨天';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return now.getFullYear() === d.getFullYear() ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

/** 时间戳 → 「MM-DD HH:mm」（书签列表用）。 */
export function formatDateTime(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 毫秒 → 「mm:ss」或 「h:mm:ss」（定时倒计时）。 */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 触发浏览器下载（同源 Blob，无外部 URL）。 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/** 下载 JSON 备份。 */
export function downloadJson(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  downloadBlob(new Blob([text], { type: 'application/json' }), filename);
}

/** 由书名生成稳定的封面占位色（白字对比度 ≥ 4.5:1）。 */
const COVER_PALETTE = ['#2f6fe0', '#0f766e', '#7c3aed', '#b45309', '#be123c', '#0369a1', '#4d7c0f', '#9333ea'];
export function coverColor(title) {
  let h = 0;
  const s = String(title || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COVER_PALETTE[h % COVER_PALETTE.length];
}

/** 文件名安全化（用于下载命名）。 */
export function safeFileName(name) {
  return String(name || 'book').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);
}

/** 特性检测：MediaSession（iOS/Safari 可能缺失）。 */
export function supportsMediaSession() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

/** 特性检测：Wake Lock。 */
export function supportsWakeLock() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/** 防抖。 */
export function debounce(fn, wait = 200) {
  let t = 0;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** 去抖帧节流（高频 progress 事件用）。 */
export function throttleFrame(fn) {
  let pending = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}
