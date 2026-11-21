/**
 * UI 层 —— 首次使用引导（4 步）与「帮助」重开
 * localStorage 记录已读；帮助按钮可随时重开。
 * @module ui/onboarding
 */

import { $, $$ } from './dom.js';

const STORAGE_KEY = 'tinttxt.onboarded';

/** @param {object} ctx */
export function createOnboarding(ctx) {
  const root = $('#onboarding');
  const titleEl = $('#ob-title');
  const steps = $$('.ob-step');
  const dots = $$('.ob-dot');
  const btnPrev = $('#ob-prev');
  const btnNext = $('#ob-next');
  const btnSkip = $('#ob-skip');

  let current = 1;
  const total = steps.length || 4;

  function goto(n) {
    current = Math.max(1, Math.min(n, total));
    for (const s of steps) s.hidden = Number(s.dataset.step) !== current;
    dots.forEach((d, i) => d.classList.toggle('is-on', i === current - 1));
    titleEl.textContent = `快速上手（${current}/${total}）`;
    btnPrev.disabled = current === 1;
    btnNext.textContent = current === total ? '开始听书' : '下一步';
  }

  function show() {
    goto(1);
    root.hidden = false;
    setTimeout(() => btnNext.focus(), 50);
  }

  function close() {
    root.hidden = true;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch { /* 隐私模式忽略 */ }
    ctx.onOnboardingClosed();
  }

  function shouldAutoShow() {
    try {
      return !localStorage.getItem(STORAGE_KEY);
    } catch {
      return false; // 读不到就不自动打扰
    }
  }

  function onNext() {
    if (current >= total) close();
    else goto(current + 1);
  }
  function onPrev() {
    goto(current - 1);
  }
  function onSkip() {
    close();
  }

  btnNext.addEventListener('click', onNext);
  btnPrev.addEventListener('click', onPrev);
  btnSkip.addEventListener('click', onSkip);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) close();
  });

  return { show, close, shouldAutoShow };
}
