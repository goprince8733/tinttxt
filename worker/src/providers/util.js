/**
 * 供应商工具：PCM → WAV 封装（16-bit 单声道标准 RIFF）。
 * 各厂商返回裸 PCM 时统一在这里包装，播放层（按 WAV 头取时长/采样率）无需感知厂商。
 * @module worker/providers/util
 */

/**
 * @param {Int16Array} samples 16-bit PCM
 * @param {number} sampleRate
 * @returns {ArrayBuffer} 标准44字节头 WAV
 */
export function pcm16MonoToWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  const u8 = new Uint8Array(buf, 44);
  for (let i = 0; i < n; i++) u8[i * 2] = samples[i] & 0xff;
  for (let i = 0; i < n; i++) u8[i * 2 + 1] = (samples[i] >> 8) & 0xff;
  return buf;
}
