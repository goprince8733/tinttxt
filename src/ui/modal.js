/**
 * UI 层 —— 通用弹窗（confirm / prompt / 自定义内容）
 * 一次只开一个；Esc 与遮罩点击关闭；焦点管理（打开聚焦、关闭还原）。
 * @module ui/modal
 */

import { el } from './dom.js';

/**
 * @param {HTMLElement} root #modal-root
 */
export function createModal(root) {
  /** @type {{close:Function}|null} */
  let current = null;

  function closeCurrent() {
    if (current) {
      current.close();
      current = null;
    }
  }

  /**
   * 打开弹窗。
   * @param {{
   *   title:string,
   *   content?:Node|((close:Function)=>Node),
   *   actions?:Array<{label:string, primary?:boolean, danger?:boolean, ghost?:boolean, value?:any}>,
   *   onAction?:(value:any, close:Function)=>void,
   *   onClose?:()=>void
   * }} opts
   * @returns {{close:()=>void}}
   */
  function open(opts) {
    closeCurrent();

    const prevFocus = document.activeElement;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } });
    const head = el('div', { class: 'modal-head' }, [el('h2', { class: 'modal-title', text: opts.title })]);
    const body = el('div', { class: 'modal-body' });
    const actions = el('div', { class: 'modal-actions' });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (current && current.close === close) current = null;
      opts.onClose?.();
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch { /* 元素已移除 */ }
      }
    };

    if (typeof opts.content === 'function') body.append(opts.content(close));
    else if (opts.content) body.append(opts.content);

    for (const a of opts.actions || []) {
      const cls = ['btn'];
      if (a.primary) cls.push('btn-primary');
      if (a.danger) cls.push('btn-danger');
      if (a.ghost) cls.push('btn-ghost');
      const btn = el('button', {
        class: cls.join(' '),
        text: a.label,
        attrs: { type: 'button' },
        onClick: () => {
          if (opts.onAction) opts.onAction(a.value, close);
          else close();
        },
      });
      actions.append(btn);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        // 简易焦点陷阱
        const focusables = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((n) => !n.disabled && n.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    box.append(head, body, actions);
    backdrop.append(box);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    root.append(backdrop);
    current = { close };

    const initial = box.querySelector('input, textarea, select') || box.querySelector('button');
    if (initial) setTimeout(() => initial.focus(), 30);

    return { close };
  }

  /**
   * 确认框。
   * @param {{title:string, message:string, confirmLabel?:string, cancelLabel?:string, danger?:boolean, extra?:{label:string, value:any, primary?:boolean}}} opts
   * @returns {Promise<'confirm'|'cancel'|string>} extra.value | 'confirm' | 'cancel'
   */
  function confirm(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const actions = [];
      if (opts.extra) {
        actions.push({ label: opts.extra.label, value: opts.extra.value, primary: !!opts.extra.primary, danger: opts.danger });
      }
      actions.push({ label: opts.cancelLabel || '取消', value: 'cancel', ghost: true });
      actions.push({ label: opts.confirmLabel || '确定', value: 'confirm', primary: !opts.extra || !opts.extra.primary, danger: opts.danger });
      open({
        title: opts.title,
        content: el('p', { text: opts.message }),
        actions,
        onAction: (value, close) => {
          done(value); // 先结算，再关闭（close 会触发 onClose）
          close();
        },
        onClose: () => done('cancel'),
      });
    });
  }

  /**
   * 单输入弹窗。回车/确定返回输入值，取消或 Esc 返回 null。
   * @param {{title:string, label?:string, value?:string, placeholder?:string, confirmLabel?:string, inputType?:string}} opts
   * @returns {Promise<string|null>}
   */
  function prompt(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const input = el('input', {
        attrs: {
          type: opts.inputType || 'text',
          placeholder: opts.placeholder || '',
          'aria-label': opts.label || opts.title,
        },
      });
      input.value = opts.value || '';
      const content = el('div', { class: 'modal-field' }, [
        el('span', { text: opts.label || '' }),
        input,
      ]);
      const m = open({
        title: opts.title,
        content,
        actions: [
          { label: '取消', value: null, ghost: true },
          { label: opts.confirmLabel || '确定', value: '__ok', primary: true },
        ],
        onAction: (value, close) => {
          const result = value === '__ok' ? input.value.trim() : null;
          done(result); // 先结算，再关闭
          close();
        },
        onClose: () => done(null),
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value.trim();
          done(v); // 先结算，再关闭
          m.close();
        }
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 30);
    });
  }

  return {
    open,
    confirm,
    prompt,
    close: closeCurrent,
    isOpen: () => !!current,
  };
}
