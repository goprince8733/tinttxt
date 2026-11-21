/**
 * 播放层 —— WAV 解析与合并
 * 本地 TTS 引擎输出 PCM WAV；把一个音频块内逐句合成的 WAV 拼接成单个块文件，
 * 同时记录每句在块内的时间轴（用于逐句高亮同步）。
 * 句间可插入静音段（呼吸停顿，见 silenceWav）——时间轴偏移自然包含停顿时长。
 * @module playback/wav
 */

/**
 * @typedef {Object} WavInfo
 * @property {number} sampleRate
 * @property {number} numChannels
 * @property {number} bitsPerSample
 * @property {number} byteRate
 * @property {number} dataOffset  data 区在 buffer 中的偏移
 * @property {number} dataLength
 */

/** 解析 WAV 头。非 WAV 返回 null。 */
export function parseWav(buf) {
  const view = new DataView(buf);
  if (buf.byteLength < 44) return null;
  const tag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (tag !== 'RIFF') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.byteLength) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(offset + 8, true),
        numChannels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        byteRate: view.getUint32(offset + 16, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      data = { offset: offset + 8, length: size };
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return {
    sampleRate: fmt.sampleRate,
    numChannels: fmt.numChannels,
    bitsPerSample: fmt.bitsPerSample,
    byteRate: fmt.byteRate,
    dataOffset: data.offset,
    dataLength: Math.min(data.length, buf.byteLength - data.offset),
  };
}

/**
 * 合并多个 WAV ArrayBuffer 为一个（要求同采样率/声道/位深）。
 * @param {ArrayBuffer[]} parts
 * @returns {{buffer: ArrayBuffer, info: WavInfo, partOffsets: Array<{byte:number, seconds:number}>}|null}
 * partOffsets：每个 part 的 data 起始字节与起始秒数，供句级时间轴计算。
 */
export function mergeWavParts(parts) {
  if (!parts.length) return null;
  const parsed = parts.map(parseWav);
  if (parsed.some((p) => !p)) return null;
  const first = parsed[0];
  const compatible = parsed.every(
    (p) => p.sampleRate === first.sampleRate && p.numChannels === first.numChannels && p.bitsPerSample === first.bitsPerSample,
  );
  if (!compatible) return null;

  let total = 44;
  const datas = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parsed[i];
    datas.push({ buf: parts[i], offset: p.dataOffset, length: p.dataLength });
    total += p.dataLength;
  }

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const u8 = new Uint8Array(out);

  // RIFF 头
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, first.numChannels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.byteRate, true);
  view.setUint16(32, (first.numChannels * first.bitsPerSample) / 8, true);
  view.setUint16(34, first.bitsPerSample, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, total - 44, true);

  let cursor = 44;
  /** @type {Array<{byte:number, seconds:number}>} */
  const partOffsets = [];
  for (let i = 0; i < datas.length; i++) {
    const d = datas[i];
    partOffsets.push({ byte: cursor - 44, seconds: (cursor - 44) / first.byteRate });
    u8.set(new Uint8Array(d.buf, d.offset, d.length), cursor);
    cursor += d.length;
  }

  return {
    buffer: out,
    info: { ...first, dataOffset: 44, dataLength: total - 44 },
    partOffsets,
  };
}

function writeStr(view, off, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
}

/**
 * 合并分块结果：给定 partOffsets 与对应句子，生成「块内句级时间轴」。
 * @param {Array<{byte:number, seconds:number}>} partOffsets
 * @param {number[]} sentenceIds 与 parts 一一对应的句子全局序号
 */
export function buildSentenceTimeline(partOffsets, sentenceIds) {
  return partOffsets.map((p, i) => ({
    sentenceIndex: sentenceIds[i],
    startSec: p.seconds,
    // endSec 由调用方用下一项的 start 或总时长补齐
    endSec: 0,
  })).map((t, i, arr) => ({
    ...t,
    endSec: i + 1 < arr.length ? arr[i + 1].startSec : Infinity,
  }));
}

/** 读取 WAV 时长（秒）。 */
export function wavDuration(buf) {
  const info = parseWav(buf);
  if (!info || !info.byteRate) return 0;
  return info.dataLength / info.byteRate;
}

/**
 * 生成一段静音 WAV（16-bit 单声道 PCM，与 TTS 输出同格式），
 * 用于句间呼吸停顿 —— 直接放进 mergeWavParts 的输入序列即可，
 * partOffsets 会自动把停顿时长计入后续句子的起始秒数。
 *
 * @param {number} ms 停顿时长（毫秒）
 * @param {number} sampleRate 采样率（必须与被合并的句子一致）
 * @returns {ArrayBuffer} 标准 44 字节头的 WAV
 */
export function silenceWav(ms, sampleRate) {
  const rate = Math.max(8000, Math.round(sampleRate || 22050));
  const samples = Math.max(1, Math.round((ms / 1000) * rate));
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  str(36, 'data');
  view.setUint32(40, dataBytes, true);
  // data 区默认全 0 = 数字静音
  return buf;
}
