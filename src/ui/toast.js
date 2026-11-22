/**
 * UI 层 —— Toast 系统
 * 订阅 Events.TOAST {message, level}；同时挂载断网提示与 SW 更新提示。
 * @module ui/toast
 */

import { Events } from '../core/contracts.js';
import { el } from './dom.js';

const DURATIONS = { info: 3200, success: 3200, warn: 4500, error: 6500 };
const MAX_VISIBLE = 4;

/**
 * @param {{bus:ReturnType<import('../core/contracts.js').createBus>}} ctx
 */
export function createToast(ctx) {
  const root = document.getElementById('toast-root');

  /**
   * @param {{message:string, level?:'info'|'success'|'warn'|'error', action?:{label:string, onClick:()=>void}}} opts
   */
  function show(opts) {
    const level = opts.level && DURATIONS[opts.level] ? opts.level : 'info';
    const node = el('div', { class: `toast toast-${level}`, attrs: { role: level === 'error' ? 'alert' : 'status' } });
    node.append(el('span', { text: opts.message }));

    let timer = 0;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 260);
    };

    if (opts.action) {
      const btn = el('button', {
        class: 'toast-action',
        text: opts.action.label,
        attrs: { type: 'button' },
        onClick: (e) => {
          e.stopPropagation();
          dismiss();
          opts.action.onClick();
        },
      });
      node.append(btn);
      // 整条可点（SW 更新提示：点击刷新）
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => {
        dismiss();
        opts.action.onClick();
      });
    }

    root.appendChild(node);
    // 超出上限：移除最旧的
    while (root.children.length > MAX_VISIBLE) root.firstElementChild.remove();
    timer = setTimeout(dismiss, opts.action ? 12000 : DURATIONS[level]);
    return { dismiss };
  }

  /** 便捷方法：toast('文本', 'warn', {label,onClick}) */
  function toast(message, level = 'info', action = null) {
    return show({ message, level, action });
  }

  // 1) 业务层 Toast 事件
  ctx.bus.on(Events.TOAST, (p) => {
    if (!p || !p.message) return;
    show({ message: String(p.message), level: p.level || 'info' });
  });

  // 2) 断网 / 恢复提示
  window.addEventListener('offline', () => toast('网络已断开：本地模型可继续朗读，模型下载与云端 TTS 不可用', 'warn'));
  window.addEventListener('online', () => toast('网络已恢复', 'success'));

  // 3) SW 更新提示（由 sw-bridge.js dispatch window.__SW_UPDATE__）
  // 点击「刷新」不能直接 location.reload()：Chrome 不会因 reload 激活 waiting worker，
  // 必须先让新 SW 接管（SKIP_WAITING → activate → controllerchange），再刷新。
  window.addEventListener('__SW_UPDATE__', (e) => {
    const v = e && e.detail && e.detail.version ? `（${e.detail.version}）` : '';
    toast(`新版本可用${v}，点击刷新`, 'warn', { label: '刷新', onClick: activateAndUpdate });
  });

  function activateAndUpdate() {
    const bridge = window.__SW_BRIDGE__;
    const waiting = bridge && bridge.registration && bridge.registration.waiting;
    if (!waiting || !('serviceWorker' in navigator)) {
      location.reload();
      return;
    }
    let reloaded = false;
    const doReload = () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    };
    window.addEventListener('__SW_CONTROLLING__', doReload, { once: true });
    bridge.skipWaiting(); // → sw.js 收 SKIP_WAITING → skipWaiting → activate → claim → controllerchange
    setTimeout(doReload, 3000); // 兜底：接管事件迟迟不来也完成刷新
  }

  // ctx.toast 必须是「可调用函数」：ctx.toast('消息', 'warn')；show 作为属性挂在函数上
  return Object.assign(toast, { show });
}
