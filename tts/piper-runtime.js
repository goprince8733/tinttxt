/**
 * tts/piper-runtime.js —— PiperTTS 浏览器适配层
 *
 * ⚠️ 本文件由 scripts/fetch-tts-assets.mjs 生成，请勿手改；重跑该脚本即可再生。
 *
 * 对外 API（src/layers/playback/tts/local.js 依赖）：
 *   const piper = await window.PiperTTS.create({ wasmPaths: '/tts/', numThreads: 4 });
 *   await piper.loadVoice(configJsonString, modelArrayBuffer);
 *   const wavArrayBuffer = await piper.synthesize(text, { lengthScale, noiseScale, noiseW });
 *
 * 资源（全部同源自托管，见 tts/ASSETS.json）：
 *   /tts/ort.wasm.min.js + /tts/ort-wasm*.wasm     onnxruntime-web 1.18.0
 *   /tts/piper_phonemize.{js,wasm,data}            espeak-ng 音素化（含 cmn 词典）
 *
 * 降级与错误码：
 *   ERR_ORT_UNAVAILABLE / ERR_ORT_LOAD_FAILED     onnxruntime 缺失或加载失败
 *   ERR_PHONEMIZER_UNAVAILABLE                    音素化运行时缺失
 *   ERR_PHONEMIZE_FAILED                          音素化执行失败（含 espeak 原始报错）
 *   ERR_PHONEMIZER_DEGRADED_FALLBACK              音素化不可用，已按字符直映射（发音质量下降）
 *   ERR_VOICE_NOT_LOADED / ERR_VOICE_LOAD         语音未加载/加载失败
 *   ERR_TEXT_UNPROCESSABLE                        文本无法映射为音素
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULT_WASM_PATHS = '/tts/';
  var ORT_JS = 'ort.wasm.min.js';
  var PHONEMIZE_JS = 'piper_phonemize.js';
  var CHUNK_LIMIT = 300; // 单次合成的最大字符数（超长文本切块，避免 WASM 内存峰值）

  function makeError(code, message, cause) {
    var err = new Error('[' + code + '] ' + message);
    err.name = 'PiperTTSError';
    err.code = code;
    if (cause) err.cause = cause;
    return err;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-piper="' + src + '"]')) {
        // 已插入过：轮询等待全局变量就绪
        var tries = 0;
        var timer = setInterval(function () {
          tries++;
          if (global.ort || global.createPiperPhonemize) {
            clearInterval(timer);
            resolve();
          } else if (tries > 600) {
            clearInterval(timer);
            reject(makeError('ERR_ORT_LOAD_FAILED', '脚本加载超时: ' + src));
          }
        }, 100);
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-piper', src);
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(makeError('ERR_ORT_LOAD_FAILED',
          '脚本加载失败: ' + src + ' —— 请确认已运行 node scripts/fetch-tts-assets.mjs 下载自托管资源。'));
      };
      document.head.appendChild(s);
    });
  }

  var ortPromise = null;
  function ensureOrt(opts) {
    if (global.ort) return Promise.resolve(global.ort);
    if (ortPromise) return ortPromise;
    ortPromise = loadScript(DEFAULT_WASM_PATHS + ORT_JS)
      .then(function () {
        if (!global.ort) {
          throw makeError('ERR_ORT_UNAVAILABLE', 'onnxruntime-web 全局对象未定义（ort.wasm.min.js 异常）');
        }
        var ort = global.ort;
        ort.env.wasm.wasmPaths = opts.wasmPaths;
        // 多线程需要 SharedArrayBuffer：仅在 crossOriginIsolated 时启用，
        // 否则强制单线程（COOP/COEP 未配置时的降级路径）
        var threads = Math.max(1, opts.numThreads | 0 || 1);
        if (typeof global.crossOriginIsolated !== 'undefined' && !global.crossOriginIsolated) {
          threads = 1;
        }
        ort.env.wasm.numThreads = threads;
        return ort;
      })
      .catch(function (e) {
        ortPromise = null;
        if (e && e.code) throw e;
        throw makeError('ERR_ORT_LOAD_FAILED', 'onnxruntime-web 加载失败：' + (e && e.message), e);
      });
    return ortPromise;
  }

  var phonemizeFactoryPromise = null;
  function ensurePhonemizeFactory() {
    if (global.createPiperPhonemize) return Promise.resolve(global.createPiperPhonemize);
    if (phonemizeFactoryPromise) return phonemizeFactoryPromise;
    phonemizeFactoryPromise = loadScript(DEFAULT_WASM_PATHS + PHONEMIZE_JS)
      .then(function () {
        if (!global.createPiperPhonemize) {
          throw makeError('ERR_PHONEMIZER_UNAVAILABLE',
            '音素化运行时未定义（piper_phonemize.js 异常）');
        }
        return global.createPiperPhonemize;
      })
      .catch(function (e) {
        phonemizeFactoryPromise = null;
        if (e && e.code) throw e;
        throw makeError('ERR_PHONEMIZER_UNAVAILABLE',
          'espeak 音素化运行时加载失败：' + (e && e.message) +
          ' —— 请运行 node scripts/fetch-tts-assets.mjs 补齐 /tts/ 资源。', e);
      });
    return phonemizeFactoryPromise;
  }

  /** 把文本切成适合单次推理的块（优先在标点处断开） */
  function splitChunks(text, max) {
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (text.length <= max) return [text];
    var parts = text.match(/[^。！？!?；;，,\n]+[。！？!?；;，,]*\s*/g) || [text];
    var chunks = [];
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (cur && (cur + p).length > max) {
        chunks.push(cur);
        cur = '';
      }
      while (p.length > max) {
        chunks.push(p.slice(0, max));
        p = p.slice(max);
      }
      cur += p;
    }
    if (cur.trim()) chunks.push(cur);
    return chunks;
  }

  /** Float32 PCM → 16-bit 单声道 WAV */
  function encodeWav(pcm, sampleRate) {
    var n = pcm.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function str(off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    }
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);      // PCM 头长度
    v.setUint16(20, 1, true);       // format = PCM
    v.setUint16(22, 1, true);       // channels = 1
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true);       // block align
    v.setUint16(34, 16, true);      // bits per sample
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    var off = 44;
    for (var i = 0; i < n; i++) {
      var s = pcm[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      off += 2;
    }
    return buf;
  }

  function PiperInstance(opts) {
    opts = opts || {};
    this.opts = {
      wasmPaths: opts.wasmPaths || DEFAULT_WASM_PATHS,
      numThreads: opts.numThreads || 1,
    };
    this.voice = null;
    this.session = null;
    this.phonemizeMod = null;
    this._printed = null;
    this._printErrs = [];
    this._lastPhonemizeError = '';
    this.degraded = false;
  }

  PiperInstance.prototype.loadVoice = function (configJson, modelArrayBuffer) {
    var self = this;
    var cfg;
    try {
      cfg = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
    } catch (e) {
      return Promise.reject(makeError('ERR_VOICE_LOAD', '语音配置 JSON 解析失败：' + e.message, e));
    }
    if (!modelArrayBuffer) {
      return Promise.reject(makeError('ERR_VOICE_LOAD', '缺少模型数据（modelArrayBuffer 为空）'));
    }
    if (!cfg || !cfg.audio || !cfg.audio.sample_rate) {
      return Promise.reject(makeError('ERR_VOICE_LOAD', '语音配置缺少 audio.sample_rate 字段'));
    }

    return Promise.all([ensureOrt(self.opts), ensurePhonemizeFactory()])
      .then(function (pair) {
        var ort = pair[0];
        var factory = pair[1];
        self.voice = cfg;
        return Promise.all([
          ort.InferenceSession.create(modelArrayBuffer, { executionProviders: ['wasm'] }),
          factory({
            locateFile: function (p) { return self.opts.wasmPaths + p; },
            print: function (data) {
              try {
                var j = JSON.parse(data);
                if (j && (j.phoneme_ids || j.phonemes)) self._printed = j;
              } catch (e) {
                /* espeak 的普通输出/警告：忽略 */
              }
            },
            printErr: function (message) {
              self._printErrs.push(String(message));
            },
          }),
        ]);
      })
      .then(function (pair) {
        self.session = pair[0];
        self.phonemizeMod = pair[1];
        return self;
      })
      .catch(function (e) {
        self.session = null;
        if (e && e.code) throw e;
        throw makeError('ERR_VOICE_LOAD', '语音模型加载失败：' + (e && e.message), e);
      });
  };

  /**
   * 文本 → 音素 ID 数组。
   * 首选 espeak 音素化输出的 phonemes 字符串，按模型自己的 phoneme_id_map 重映射；
   * 失败且 phoneme_id_map 覆盖输入字符时按字符直映射（降级）。
   * @returns {Promise<number[]>}
   */
  PiperInstance.prototype._phonemeIds = function (text) {
    var self = this;
    var map = (self.voice && self.voice.phoneme_id_map) || {};

    function charFallback() {
      var ids = [];
      var missing = 0;
      var chars = Array.from(text);
      for (var i = 0; i < chars.length; i++) {
        var v = map[chars[i]];
        if (v == null) missing++;
        else ids.push(Array.isArray(v) ? v[0] : v);
      }
      // 只有映射覆盖率足够高才允许降级出声
      if (ids.length && missing <= Math.floor(chars.length * 0.2)) {
        self.degraded = true;
        return ids;
      }
      return null;
    }

    if (!self.phonemizeMod) {
      var fb = charFallback();
      if (fb) {
        self._lastPhonemizeError = '音素化模块不可用，已按字符直映射（发音质量下降）';
        return Promise.resolve(fb);
      }
      return Promise.reject(makeError('ERR_PHONEMIZER_UNAVAILABLE',
        '音素化运行时不可用，且文本无法按字符直映射。请运行 node scripts/fetch-tts-assets.mjs 补齐 /tts/ 资源，或在 UI 中切换到云端 TTS。'));
    }

    var voiceName = (self.voice.espeak && self.voice.espeak.voice) || 'cmn';
    self._printed = null;
    self._printErrs = [];
    try {
      self.phonemizeMod.callMain([
        '-l', voiceName,
        '--input', JSON.stringify([{ text: text }]),
        '--espeak_data', '/espeak-ng-data',
      ]);
    } catch (e) {
      self._lastPhonemizeError = (e && e.message) || String(e);
      var fb2 = charFallback();
      if (fb2) return Promise.resolve(fb2);
      return Promise.reject(makeError('ERR_PHONEMIZE_FAILED',
        '音素化执行失败：' + self._lastPhonemizeError +
        (self._printErrs.length ? '；espeak 输出：' + self._printErrs.join(' | ').slice(0, 300) : ''), e));
    }

    // ⚠️ 不能用 piper_phonemize 的 phoneme_ids：那是 **espeak 内部 id 空间**
    // （实测 ŋ=135 > 模型词表 num_symbols=130，且是 int64 两两展平的），
    // 直接喂 OrtRun 必然「indices element out of data bounds」崩溃。
    // 模型认的是自己 phoneme_id_map 的 id —— 必须拿 phonemes 字符串按模型的表重映射。
    // 声调数字（"5"/"1"/"2"）不在模型词表（训练时即无声调符号）→ 丢弃即可。
    if (self._printed && self._printed.phonemes && self._printed.phonemes.length) {
      var ids = [];
      var dropped = 0;
      var phs = [].concat(self._printed.phonemes);
      for (var pi = 0; pi < phs.length; pi++) {
        var mv = map[phs[pi]];
        if (mv == null) { dropped++; continue; }
        ids.push(Array.isArray(mv) ? mv[0] : mv);
      }
      if (ids.length) {
        if (dropped) self._toneDropped = (self._toneDropped || 0) + dropped;
        return Promise.resolve(ids);
      }
      // 一个音素都没映射上（voice 的表与 espeak 输出完全对不上）→ 落到下面的字符直映射
    }

    // 无输出：尝试字符直映射降级
    var fb3 = charFallback();
    if (fb3) return Promise.resolve(fb3);
    return Promise.reject(makeError('ERR_PHONEMIZE_FAILED',
      '音素化无有效输出。espeak 报错：' +
      (self._printErrs.join(' | ') || '（无）').slice(0, 300) +
      '；请确认 /tts/piper_phonemize.data 已下载且语言 voice=cmn 可用。'));
  };

  PiperInstance.prototype._synthChunk = function (text, opts) {
    var self = this;
    var ort = global.ort;
    return self._phonemeIds(text).then(function (ids) {
      if (!ids.length) return new Float32Array(0);
      var inf = (self.voice && self.voice.inference) || {};
      var feeds = {
        input: new ort.Tensor('int64', ids, [1, ids.length]),
        input_lengths: new ort.Tensor('int64', [ids.length]),
        scales: new ort.Tensor('float32', [
          opts.noiseScale != null ? opts.noiseScale : (inf.noise_scale != null ? inf.noise_scale : 0.667),
          opts.lengthScale != null ? opts.lengthScale : (inf.length_scale != null ? inf.length_scale : 1),
          opts.noiseW != null ? opts.noiseW : (inf.noise_w != null ? inf.noise_w : 0.8),
        ]),
      };
      // 多说话人模型需要 sid 输入（huayan 为单说话人，不带此输入）
      if (self.voice && self.voice.speaker_id_map && Object.keys(self.voice.speaker_id_map).length) {
        feeds.sid = new ort.Tensor('int64', [0]);
      }
      return self.session.run(feeds).then(function (results) {
        var out = results.output;
        return out ? out.data : new Float32Array(0);
      });
    });
  };

  PiperInstance.prototype.synthesize = function (text, opts) {
    var self = this;
    opts = opts || {};
    if (!self.session) {
      return Promise.reject(makeError('ERR_VOICE_NOT_LOADED', '语音尚未加载：请先调用 loadVoice()'));
    }
    var chunks = splitChunks(text, CHUNK_LIMIT);
    if (!chunks.length) {
      return Promise.resolve(encodeWav(new Float32Array(0), self.voice.audio.sample_rate));
    }
    var parts = [];
    return chunks
      .reduce(function (chain, chunk) {
        return chain.then(function () {
          return self._synthChunk(chunk, opts).then(function (pcm) {
            if (pcm && pcm.length) parts.push(pcm);
          });
        });
      }, Promise.resolve())
      .then(function () {
        if (!parts.length) {
          return encodeWav(new Float32Array(0), self.voice.audio.sample_rate);
        }
        var total = 0;
        for (var i = 0; i < parts.length; i++) total += parts[i].length;
        var merged = new Float32Array(total);
        var off = 0;
        for (var j = 0; j < parts.length; j++) {
          merged.set(parts[j], off);
          off += parts[j].length;
        }
        return encodeWav(merged, self.voice.audio.sample_rate);
      })
      .catch(function (e) {
        if (e && e.code) throw e;
        throw makeError('ERR_TEXT_UNPROCESSABLE', '合成失败：' + (e && e.message), e);
      });
  };

  /** 释放推理会话（切书/长时间不用时调用） */
  PiperInstance.prototype.close = function () {
    var self = this;
    if (self.session && typeof self.session.release === 'function') {
      try { self.session.release(); } catch (e) { /* ignore */ }
    }
    self.session = null;
    self.voice = null;
  };

  global.PiperTTS = {
    version: VERSION,
    create: function (opts) {
      return new PiperInstance(opts);
    },
  };
})(window);
