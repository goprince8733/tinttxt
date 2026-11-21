/**
 * 播放层 —— 系统集成：Wake Lock、打断恢复、诊断心跳
 * @module playback/system
 */

import { Events } from '../../core/contracts.js';

/**
 * Wake Lock 管理：亮屏收听时防自动熄屏。
 * 规范要点：仅可见文档可申请；文档隐藏时自动释放；重新可见必须重新 request()。
 * 不可用时优雅降级（仅提示）。
 * @param {ReturnType<import('../../core/contracts.js').createBus>} bus
 */
export function createWakeLockManager(bus) {
  let sentinel = null;
  let enabled = true;
  let supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  function emit() {
    bus.emit(Events.WAKELOCK, { supported, active: !!sentinel, enabled });
  }

  async function request() {
    if (!supported || !enabled) {
      emit();
      return false;
    }
    try {
      if (sentinel) return true;
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
        emit();
      });
      emit();
      return true;
    } catch (e) {
      // 用户手动熄屏 / 省电模式会拒绝——属预期，不报错
      sentinel = null;
      emit();
      return false;
    }
  }

  function release() {
    try {
      sentinel?.release();
    } catch {
      /* ignore */
    }
    sentinel = null;
    emit();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void request();
  });

  return {
    request,
    release,
    setEnabled(v) {
      enabled = !!v;
      if (!enabled) release();
      else if (document.visibilityState === 'visible') void request();
      emit();
    },
    isActive: () => !!sentinel,
    isSupported: () => supported,
    emit,
  };
}

/**
 * 后台播放自检诊断：心跳、audio 状态、MediaSession 状态、WakeLock 状态、当前块。
 * @param {ReturnType<import('../../core/contracts.js').createBus>} bus
 * @param {() => object} getPlayerDiag
 * @param {() => {supported:boolean, active:boolean}} getWake
 */
export function createDiagnostics(bus, getPlayerDiag, getWake) {
  let lastHeartbeat = Date.now();
  let timer = 0;
  /** @type {object[]} */
  const log = [];

  function snapshot() {
    const p = getPlayerDiag();
    const w = getWake();
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession ? navigator.mediaSession.playbackState : 'unsupported';
    const audioTag = document.querySelector('audio');
    return {
      ts: Date.now(),
      heartbeat: new Date(lastHeartbeat).toLocaleTimeString(),
      status: p.status,
      chunkIndex: p.chunkIndex,
      chunkTotal: p.chunkTotal,
      cachedChunks: p.cachedChunks,
      inflight: p.inflight,
      audioPaused: p.activePaused,
      audioTime: Number(p.activeTime.toFixed(2)),
      audioSrc: p.activeSrc,
      domAudioCount: document.querySelectorAll('audio').length,
      domAudioPaused: audioTag ? audioTag.paused : null,
      mediaSession: ms,
      wakeLock: w,
      visibility: document.visibilityState,
      connection: navigator.connection ? navigator.connection.effectiveType : 'n/a',
      wantPlaying: p.wantPlaying,
    };
  }

  function pushLog(entry) {
    log.unshift(entry);
    if (log.length > 100) log.pop();
  }

  return {
    /** 每秒心跳（用于「最后心跳时间」排查；页面被冻结时心跳停止即证据）。 */
    start(intervalMs = 1000) {
      if (timer) return;
      timer = setInterval(() => {
        lastHeartbeat = Date.now();
        const snap = snapshot();
        pushLog(snap);
        bus.emit(Events.DIAG, snap);
      }, intervalMs);
    },
    stop() {
      clearInterval(timer);
      timer = 0;
    },
    snapshot,
    getLog: () => log.slice(),
    touchHeartbeat() {
      lastHeartbeat = Date.now();
    },
  };
}
