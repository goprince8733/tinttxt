/**
 * 本人专属开关：云端（百度）语音是否对本机开放。
 *
 * 为什么需要它：站点公开分享后，任何访客都能点「百度语音」消耗站长额度（额度=钱）。
 * 因此默认对所有设备隐藏；站长用专属链接 `?owner=<key>` 打开一次后，
 * key 存进 localStorage，本机才显示并使用百度语音。
 * 服务端同时校验同一个 key（环境变量 CLOUD_OWNER_KEY），
 * 所以绕过界面直接调 /api/tts 也会被 403。
 */

const STORAGE_KEY = 'tinttxt:owner-key';

/** @returns {string} 本机保存的密钥（没有则为空串） */
export function getOwnerKey() {
  try {
    return (window.localStorage && window.localStorage.getItem(STORAGE_KEY)) || '';
  } catch {
    return '';
  }
}

/** @param {string} key */
export function setOwnerKey(key) {
  try {
    if (key) window.localStorage.setItem(STORAGE_KEY, String(key));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式等：忽略（等价于未解锁） */
  }
}

/** 本机是否已解锁云端语音。 */
export function isCloudUnlocked() {
  return !!getOwnerKey();
}
