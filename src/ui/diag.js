/**
 * UI 层 —— 后台播放自检页（#diag）
 * 订阅 Events.DIAG 心跳 + player._diag() 快照，实时渲染；显示最近 30 条日志。
 * MediaSession / Wake Lock 缺失时显示「不支持」而非报错。
 * @module ui/diag
 */

import { $, clear, supportsMediaSession, supportsWakeLock } from './dom.js';

const LOG_LIMIT = 30;

/** @param {object} ctx */
export function createDiag(ctx) {
  const app = ctx.app;

  const fields = {
    audio: $('#d-audio'),
    media: $('#d-media'),
    wake: $('#d-wake'),
    heartbeat: $('#d-heartbeat'),
    chunk: $('#d-chunk'),
    visibility: $('#d-visibility'),
    connection: $('#d-connection'),
    inflight: $('#d-inflight'),
    ep: $('#d-ep'),
    visHistory: $('#d-vis-history'),
    rtfResult: $('#d-rtf-result'),
    btnRtf: $('#btn-rtf-test'),
    btnListenPiper: $('#btn-listen-piper'),
    btnListenSherpa: $('#btn-listen-sherpa'),
    listenStatus: $('#listen-status'),
    audioCount: $('#d-audio-count'),
    want: $('#d-want'),
    updated: $('#d-updated'),
  };
  const logEl = $('#diag-log');

  // —— 熄屏/恢复记录（真机验收 §3：锁屏 10 秒恢复后的状态证据）——
  let lastHide = null;
  let lastShow = null;
  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.hidden) lastHide = now;
    else lastShow = now;
  });

  // —— 在途 fetch 计数（自检页 §6：区分「网络断了」与「页面被冻结」）——
  // 页面被冻结时本计数与心跳一起停止更新；网络挂起时心跳照走而计数停在 >0。
  // 只包装一次，透明转发（不改请求语义、不吞错误）。
  let inflight = 0;
  if (!globalThis.__tinttxtFetchPatched) {
    globalThis.__tinttxtFetchPatched = true;
    const orig = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (...args) => {
      inflight++;
      const done = () => {
        inflight = Math.max(0, inflight - 1);
      };
      return orig(...args).then(
        (r) => { done(); return r; },
        (e) => { done(); throw e; },
      );
    };
  }

  /** 实际生效的推理 EP：适配器可通过 globalThis.__TINTTXT_EP 显式声明（WebGPU 路径会设）；
   *  未声明时按当前引擎推断，保证该字段永远有值。 */
  function effectiveEP() {
    if (globalThis.__TINTTXT_EP) return String(globalThis.__TINTTXT_EP);
    const id = app.registry && app.registry.active ? app.registry.active.id : '';
    if (id === 'local-sherpa') return 'wasm · sherpa-onnx（单线程 CPU）';
    if (id === 'local-piper') return 'wasm · onnxruntime（≤4 线程）';
    if (id === 'cloud-http') return 'n/a（云端合成）';
    if (id === 'speech-preview') return 'n/a（系统 TTS）';
    return id || '—';
  }

  function setVal(node, text, tone) {
    if (!node) return;
    node.textContent = text;
    node.className = tone ? `is-${tone}` : '';
  }

  /** @param {any} snap */
  function render(snap) {
    if (!snap) return;
    const audioState = `${snap.status || '—'}${snap.audioPaused != null ? ` / audio ${snap.audioPaused ? 'paused' : 'playing'}` : ''}`;
    setVal(fields.audio, audioState, snap.status === 'playing' ? 'ok' : snap.status === 'error' ? 'bad' : 'warn');

    if (supportsMediaSession()) {
      setVal(fields.media, String(snap.mediaSession ?? '—'), snap.mediaSession === 'playing' ? 'ok' : 'warn');
    } else {
      setVal(fields.media, '不支持');
    }

    const w = snap.wakeLock || {};
    if (w.supported === false || !supportsWakeLock()) {
      setVal(fields.wake, '不支持');
    } else {
      setVal(fields.wake, `${w.active ? '已持有' : '未持有'} / 开关 ${w.enabled ? '开' : '关'}`, w.active ? 'ok' : 'warn');
    }

    setVal(fields.heartbeat, String(snap.heartbeat || '—'));
    setVal(fields.chunk, `${snap.chunkIndex ?? 0} / ${snap.chunkTotal ?? 0} / 缓存 [${(snap.cachedChunks || []).join(',')}]`);
    setVal(fields.visibility, String(snap.visibility || '—'), snap.visibility === 'visible' ? 'ok' : 'warn');
    setVal(fields.connection, String(snap.connection || 'n/a'),
      snap.connection && snap.connection !== 'online' ? 'warn' : 'ok');
    setVal(fields.inflight, String(inflight), inflight > 0 ? 'warn' : 'ok');
    setVal(fields.ep, effectiveEP());
    if (lastHide || lastShow) {
      const fmt = (t) => (t ? new Date(t).toLocaleTimeString() : '—');
      const nowHidden = lastHide && (!lastShow || lastHide > lastShow);
      setVal(fields.visHistory, `隐藏 ${fmt(lastHide)} → 恢复 ${fmt(lastShow)}`, nowHidden ? 'warn' : 'ok');
    } else {
      setVal(fields.visHistory, '本次会话尚未熄屏');
    }
    setVal(fields.audioCount, String(snap.domAudioCount ?? 0));
    setVal(fields.want, String(snap.wantPlaying), snap.wantPlaying ? 'ok' : '');
    setVal(fields.updated, new Date(snap.ts || Date.now()).toLocaleTimeString());
  }

  function renderLog() {
    const log = app.diag.getLog().slice(0, LOG_LIMIT);
    clear(logEl);
    if (!log.length) {
      logEl.append(Object.assign(document.createElement('li'), { textContent: '暂无日志（打开书籍或进入本页后开始心跳）' }));
      return;
    }
    for (const s of log) {
      const t = new Date(s.ts || Date.now()).toLocaleTimeString();
      const line = `${t} | ${s.status} | 块 ${s.chunkIndex}/${s.chunkTotal} | vis=${s.visibility} | ms=${s.mediaSession} | audio=${s.audioPaused ? 'paused' : 'playing'} | 心跳 ${s.heartbeat}`;
      const li = document.createElement('li');
      li.textContent = line;
      logEl.append(li);
    }
  }

  /** 进入自检页：确保心跳在跑并立即刷新一帧。 */
  function enter() {
    try {
      app.diag.start();
    } catch { /* 已在运行 */ }
    refresh();
  }

  function refresh() {
    try {
      render(app.diag.snapshot());
    } catch (e) {
      ctx.toast(`快照失败：${e && e.message ? e.message : e}`, 'error');
    }
    renderLog();
  }

  /** Events.DIAG 转发入口 */
  function onDiag(snap) {
    if (document.body.dataset.route !== 'diag') return;
    render(snap);
    renderLog();
  }

  // ------------------------------------------------------------------
  // 速度自测（真机验收 §3）：固定文本、不缩句、不调参 —— 数字如实上报。
  // ------------------------------------------------------------------
  /** 固定三段文本（与桌面探针同一组，便于跨设备对比；改动需同步 .tooling/e2e/kokoro-probe.mjs）。 */
  const RTF_TEXTS = [
    '清晨的阳光照进窗户，李明睁开了眼睛。',
    '他走过一家书店，门口挂着一块牌子：新书八折，他决定进去看看。',
    '街道上人来人往，热闹非凡。他走过一家书店，门口挂着一块牌子：新书八折。他走进去，随手翻开一本书，书里写着一段关于远方的故事，让他想起了很多年前的夏天。',
  ];

  /** 最小 WAV 时长解析（不引依赖；durationSeconds 缺失时的兜底）。 */
  function wavSec(buf) {
    try {
      const v = new DataView(buf);
      if (buf.byteLength < 44) return 0;
      const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      if (tag(0) !== 'RIFF') return 0;
      let o = 12;
      let byteRate = 0;
      let dataLen = 0;
      while (o + 8 <= buf.byteLength) {
        const id = tag(o);
        const size = v.getUint32(o + 4, true);
        if (id === 'fmt ') byteRate = v.getUint32(o + 16, true);
        if (id === 'data') { dataLen = size; break; }
        o += 8 + size + (size % 2);
      }
      return byteRate ? dataLen / byteRate : 0;
    } catch {
      return 0;
    }
  }

  async function runRtfTest() {
    const lines = [];
    const push = (s) => {
      lines.push(s);
      if (fields.rtfResult) fields.rtfResult.textContent = lines.join('\n');
    };
    fields.btnRtf.disabled = true;
    try {
      push(`开始: ${new Date().toLocaleString()}`);
      push('提示：合成在主线程运行，测试期间页面会明显卡顿 —— 属预期现象，不是故障；请勿锁屏。');
      push(`UA: ${navigator.userAgent}`);
      push(`hardwareConcurrency: ${navigator.hardwareConcurrency}`);

      // 1) GPU 能力（WebGPU 路线的前提；当前引擎不用 GPU 也如实记录）
      let gpu = 'navigator.gpu 不存在';
      if (navigator.gpu) {
        try {
          const ga = await navigator.gpu.requestAdapter();
          gpu = ga
            ? `有适配器 vendor=${(ga.info && ga.info.vendor) || '?'} arch=${(ga.info && ga.info.architecture) || '?'}`
            : 'requestAdapter() = null（本设备无可用 GPU 适配器）';
        } catch (e) {
          gpu = `异常: ${e && e.message}`;
        }
      }
      push(`navigator.gpu: ${gpu}`);
      push(`生效推理 EP: ${effectiveEP()}`);

      // 2) 引擎就绪检查
      const engine = app.registry && app.registry.active;
      const ready = engine ? await Promise.resolve(engine.isReady()).catch(() => false) : false;
      if (!ready) {
        push('当前引擎未就绪（先到播放页下载模型）——中止。');
        return;
      }
      if (engine.previewOnly) {
        push('当前是系统预览档（无音频 Blob）——无法测 RTF，请先下载模型。');
        return;
      }

      // 3) 固定三段 RTF（第一段单列为「预热/实例化」耗时）
      let firstMs = 0;
      for (let i = 0; i < RTF_TEXTS.length; i++) {
        const text = RTF_TEXTS[i];
        const t0 = performance.now();
        const res = await engine.synthesize(text, { rate: 1 });
        const ms = performance.now() - t0;
        if (i === 0) firstMs = ms;
        let sec = res.durationSeconds && res.durationSeconds > 0 ? res.durationSeconds : 0;
        if (!sec && res.blob) sec = wavSec(await res.blob.arrayBuffer());
        const rtf = sec > 0 ? ms / 1000 / sec : NaN;
        push(`段${i + 1} ${text.length}字: 合成 ${Math.round(ms)}ms / 音频 ${sec.toFixed(2)}s / RTF ${rtf.toFixed(2)}`);
      }
      push(`首次合成（含预热/实例化）: ${Math.round(firstMs)}ms`);

      // 4) 连续 60 秒：前 30s vs 后 30s 平均 RTF —— 降速比作为发热代理指标
      if (engine.requiresNetwork) {
        push('云端引擎跳过 60 秒连续测试（避免烧额度）。');
      } else {
        push('连续 60 秒合成开始（期间请勿锁屏）…');
        const start = performance.now();
        const early = [];
        const late = [];
        let n = 0;
        while (performance.now() - start < 60000) {
          const t0 = performance.now();
          const res = await engine.synthesize(RTF_TEXTS[1], { rate: 1 });
          const ms = performance.now() - t0;
          let sec = res.durationSeconds && res.durationSeconds > 0 ? res.durationSeconds : 0;
          if (!sec && res.blob) sec = wavSec(await res.blob.arrayBuffer());
          if (sec > 0) {
            const r = ms / 1000 / sec;
            (performance.now() - start < 30000 ? early : late).push(r);
          }
          n++;
          await new Promise((r) => setTimeout(r, 0)); // 让出主线程，贴近真实节奏
        }
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
        const e1 = avg(early);
        const l1 = avg(late);
        const ratio = e1 > 0 ? l1 / e1 : NaN;
        push(`连续60s: 共 ${n} 段；前30s平均RTF ${e1.toFixed(2)} / 后30s平均RTF ${l1.toFixed(2)} / 降速比 ${ratio.toFixed(2)}×（>1.3 疑似发热降速）`);
      }
      push('完成 —— 请连同上方字段、熄屏/恢复记录一并截图。');
    } catch (e) {
      push(`出错: ${e && e.message ? e.message : e}`);
    } finally {
      fields.btnRtf.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // 发音试听 A/B（真机音质定性）：同句文本 → 两个引擎分别合成并播放，
  // 用耳朵回答「Piper 是否鸟语 / sherpa 是否清晰」——仪器测不了主观音质。
  // ------------------------------------------------------------------
  const LISTEN_TEXT = '清晨的阳光照进窗户，李明睁开了眼睛。他决定去城里看看。';
  /** @type {HTMLAudioElement|null} */
  let listenAudio = null;

  async function listen(engineId) {
    const label = engineId === 'local-piper' ? 'Piper' : 'sherpa';
    const ad = app.registry && app.registry.get ? app.registry.get(engineId) : null;
    if (!ad) {
      fields.listenStatus.textContent = '引擎不可用';
      return;
    }
    fields.btnListenPiper.disabled = true;
    fields.btnListenSherpa.disabled = true;
    if (listenAudio) {
      try { listenAudio.pause(); } catch { /* ignore */ }
      listenAudio = null;
    }
    try {
      const ready = await Promise.resolve(ad.isReady()).catch(() => false);
      if (!ready) {
        fields.listenStatus.textContent = `${label} 模型未下载 —— 请先到设置页点下载按钮`;
        return;
      }
      fields.listenStatus.textContent = `正在用 ${label} 合成…（sherpa 首次约十几秒，页面不会卡）`;
      const t0 = performance.now();
      const res = await ad.synthesize(LISTEN_TEXT, { rate: 1 });
      const ms = Math.round(performance.now() - t0);
      fields.listenStatus.textContent = `合成 ${ms}ms / 音频 ${(res.durationSeconds || 0).toFixed(1)}s —— 正在播放 ${label}…`;
      const url = URL.createObjectURL(res.blob);
      const audio = new Audio(url);
      listenAudio = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        if (listenAudio === audio) listenAudio = null;
        fields.listenStatus.textContent += '（完毕）';
      };
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', () => {
        done();
        fields.listenStatus.textContent = '播放失败（浏览器拒绝了音频流）';
      }, { once: true });
      await audio.play();
    } catch (e) {
      fields.listenStatus.textContent = `失败：${(e && e.message) || e}`;
    } finally {
      fields.btnListenPiper.disabled = false;
      fields.btnListenSherpa.disabled = false;
    }
  }

  $('#btn-diag-refresh').addEventListener('click', refresh);
  $('#btn-diag-back').addEventListener('click', () => ctx.router.go('#shelf'));

  // 复制系统语音的逐句事件日志：排查"息屏跳块"时，这是唯一能看到设备真实事件的证据
  const btnTrace = $('#btn-diag-trace');
  if (btnTrace) {
    btnTrace.addEventListener('click', () => {
      void (async () => {
        const info = app.getBuildInfo ? app.getBuildInfo() : { build: 'dev' };
        const trace = app.player && app.player._trace ? app.player._trace() : [];
        const head = `build=${info.build} ua=${navigator.userAgent} at=${new Date().toISOString()}`;
        const text = [head, ...trace.map((x) => JSON.stringify(x))].join('\n');
        let ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            ok = true;
          }
        } catch { /* 走兜底 */ }
        if (!ok) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            ta.remove();
          } catch { ok = false; }
        }
        if (ok) ctx.toast(`已复制播放日志（${trace.length} 条），发给开发者即可定位`, 'success');
        else ctx.toast('复制失败：请长按下方日志手动复制', 'warn');
        // 无论复制成败都把日志渲染到页面，便于手动选择
        const pre = document.getElementById('diag-trace-out');
        if (pre) {
          pre.hidden = false;
          pre.textContent = text.slice(-8000);
        }
      })();
    });
  }
  $('#btn-rtf-test').addEventListener('click', () => {
    void runRtfTest();
  });
  $('#btn-listen-piper').addEventListener('click', () => {
    void listen('local-piper');
  });
  $('#btn-listen-sherpa').addEventListener('click', () => {
    void listen('local-sherpa');
  });

  return { enter, refresh, onDiag };
}
