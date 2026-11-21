#!/usr/bin/env node
/**
 * fetch-tts-assets.mjs —— 自托管 TTS 资源下载器（零依赖，国内镜像）
 *
 * 用法：
 *   node scripts/fetch-tts-assets.mjs                 # 下载全部（模型 + 运行时）
 *   node scripts/fetch-tts-assets.mjs --only models   # 仅 Piper 中文模型
 *   node scripts/fetch-tts-assets.mjs --only runtime  # 仅运行时（onnxruntime + espeak 音素化 + 生成适配层）
 *   node scripts/fetch-tts-assets.mjs --force         # 忽略已存在文件，强制重新下载
 *
 * 产物（项目根，与 dev-server 静态根一致）：
 *   models/zh_CN-huayan-medium.onnx(.json)     63,201,294 字节（标准档）
 *   models/zh_CN-huayan-x_low.onnx(.json)      20,628,813 字节（省流档）
 *   tts/ort.wasm.min.js + ort-wasm*.wasm       onnxruntime-web 1.18.0（npmmirror 镜像）
 *   tts/piper_phonemize.{js,wasm,data}         Piper/espeak-ng 音素化 WASM（npmmirror 镜像）
 *   tts/piper-runtime.js                       PiperTTS 适配层（本脚本生成）
 *   tts/ASSETS.json                            已下载资源清单（大小 + sha256）
 *
 * 下载特性：流式写盘、断点续传（.part + Range，若镜像支持）、
 * 校验（voices.json 权威 md5_digest；拿不到则按字节数校验；运行时文件按 tgz 内声明大小）。
 *
 * 镜像说明：
 *   - 模型：hf-mirror.com（HuggingFace 国内镜像，实测可达）
 *   - npm 包：registry.npmmirror.com（阿里云 npm 镜像，实测可达）
 *   - 境外源（github/jsdelivr/cdnjs）在目标网络可能不通，本脚本不使用。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODELS_DIR = path.join(ROOT, 'models');
const TTS_DIR = path.join(ROOT, 'tts');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let only = 'all';
let force = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--only') only = String(argv[++i] || 'all');
  else if (a.startsWith('--only=')) only = a.slice(7);
  else if (a === '--force') force = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/fetch-tts-assets.mjs [--only models|runtime|all] [--force]');
    process.exit(0);
  } else {
    console.error('未知参数：', a);
    process.exit(1);
  }
}
if (!['all', 'models', 'runtime'].includes(only)) {
  console.error('--only 只能是 models | runtime | all');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 常量：下载源与目标
// ---------------------------------------------------------------------------
const VOICES_JSON_URL = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/voices.json';
const HF_BASE = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/';

/** Piper 中文模型（体积为 voices.json 权威数据） */
const MODEL_FILES = [
  {
    hfPath: 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx',
    dest: 'models/zh_CN-huayan-medium.onnx',
    expectBytes: 63201294,
  },
  {
    hfPath: 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json',
    dest: 'models/zh_CN-huayan-medium.onnx.json',
    expectBytes: 4822,
  },
  {
    hfPath: 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx',
    dest: 'models/zh_CN-huayan-x_low.onnx',
    expectBytes: 20628813,
  },
  {
    hfPath: 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx.json',
    dest: 'models/zh_CN-huayan-x_low.onnx.json',
    // 内置字节数（voices.json 不可达时的兜底校验；0 = 无校验会让错误页蒙混过关）
    expectBytes: 4164,
  },
];

/** onnxruntime-web 1.18.0（npmmirror） */
const ORT_TGZ = 'https://registry.npmmirror.com/onnxruntime-web/-/onnxruntime-web-1.18.0.tgz';
const ORT_JS_ENTRY = 'package/dist/ort.wasm.min.js';
/** 从 ort.wasm.min.js 里发现的 wasm 名；发现失败时的兜底集合 */
const ORT_WASM_FALLBACK = [
  'package/dist/ort-wasm-simd-threaded.wasm', // 多线程 + SIMD（COOP/COEP 就绪时）
  'package/dist/ort-wasm-simd.wasm', // 单线程 + SIMD（默认降级路径）
  'package/dist/ort-wasm.wasm', // 无 SIMD 兜底
];

/** Piper/espeak-ng 音素化 WASM（npmmirror）—— 解决 phonemize 数据自托管 */
const PIPER_WASM_TGZ = 'https://registry.npmmirror.com/@diffusionstudio/piper-wasm/-/piper-wasm-1.0.0.tgz';
const PIPER_WASM_ENTRIES = [
  ['package/build/piper_phonemize.js', 'tts/piper_phonemize.js'],
  ['package/build/piper_phonemize.wasm', 'tts/piper_phonemize.wasm'],
  ['package/build/piper_phonemize.data', 'tts/piper_phonemize.data'],
];

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
/** @type {{name:string,status:string,detail:string}[]} */
const REPORT = [];
function record(name, status, detail = '') {
  REPORT.push({ name, status, detail });
  const mark = status === 'ok' ? '✓' : status === 'skip' ? '·' : '✗';
  console.log(`${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ---------------------------------------------------------------------------
// 校验工具
// ---------------------------------------------------------------------------
function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function verifyFile(file, expectBytes, expectMd5) {
  if (!fs.existsSync(file)) return { ok: false, why: '文件不存在' };
  const size = fs.statSync(file).size;
  if (expectBytes && size !== expectBytes) {
    return { ok: false, why: `大小不符：${size} ≠ ${expectBytes}` };
  }
  if (expectMd5) {
    const md5 = await hashFile(file, 'md5');
    if (md5.toLowerCase() !== String(expectMd5).toLowerCase()) {
      return { ok: false, why: `md5 不符：${md5}` };
    }
  }
  return { ok: true, why: expectMd5 ? 'md5+大小校验通过' : expectBytes ? '大小校验通过' : '未提供校验值（仅存在性）' };
}

// ---------------------------------------------------------------------------
// 断点续传下载（流式写盘）
// ---------------------------------------------------------------------------
async function downloadToFile(url, dest, { expectBytes = 0, expectMd5 = '', label = '' } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const name = label || path.relative(ROOT, dest);

  // 已存在且校验通过 → 跳过
  if (!force && fs.existsSync(dest)) {
    const v = await verifyFile(dest, expectBytes, expectMd5);
    if (v.ok) {
      record(name, 'skip', `已存在（${fmtBytes(fs.statSync(dest).size)}，${v.why}）`);
      return { status: 'skip', bytes: fs.statSync(dest).size };
    }
    console.log(`  · 已存在但校验失败，重新下载：${v.why}`);
    await fsp.rm(dest, { force: true });
  }

  const part = dest + '.part';
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 重试：镜像偶发 502/网络抖动；若 Range 请求失败则清掉 .part 改为整文件下载
  let res = null;
  let lastWhy = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(url, start > 0 ? { headers: { Range: `bytes=${start}-` } } : {});
    } catch (e) {
      res = null;
      lastWhy = e.message;
      if (attempt === 3) break;
      await sleep(1500 * attempt);
      continue;
    }
    if (res.status === 206 || res.status === 200 || res.status === 416) break;
    lastWhy = `HTTP ${res.status}`;
    const isClientErr = res.status >= 400 && res.status < 500;
    if (start > 0 && isClientErr) {
      // 仅 4xx（Range 被拒 / 资源换址）才丢弃断点：5xx/网络抖动保留 .part 续传进度，
      // 否则一次 502 就把几十 MB 断点全部作废，与「断点续传」目标相悖
      await fsp.rm(part, { force: true });
      start = 0;
    }
    if (attempt < 3) {
      console.log(`  · ${name}: ${lastWhy}，${attempt + 1}/3 次重试…`);
      await sleep(1500 * attempt);
    }
  }
  if (!res || (res.status !== 206 && res.status !== 200 && res.status !== 416)) {
    record(name, 'fail', `${lastWhy || '网络错误'}（保留 .part 可续传，重跑重试）`);
    return { status: 'fail', error: lastWhy };
  }

  if (res.status === 416) {
    // 请求范围越界：.part 很可能已完整
    const v = await verifyFile(part, expectBytes, expectMd5);
    if (v.ok) {
      await fsp.rename(part, dest);
      record(name, 'ok', `续传完成（${fmtBytes(fs.statSync(dest).size)}）`);
      return { status: 'ok', bytes: fs.statSync(dest).size };
    }
    await fsp.rm(part, { force: true });
    start = 0;
    res = await fetch(url);
    if (!res.ok) {
      record(name, 'fail', `HTTP ${res.status}（416 后重下失败）`);
      return { status: 'fail', error: `HTTP ${res.status}` };
    }
  }

  let resumed = res.status === 206 && start > 0;
  if (res.status === 200 && start > 0) {
    // 镜像不支持 Range：从头来
    start = 0;
    resumed = false;
  }
  if (resumed) {
    // 校验 Content-Range 起点与请求一致：不符则整档重下，
    // 否则会在错误偏移上 append，产出损坏文件（字节校验发现不了这种交错）
    const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') || '');
    if (!m || Number(m[1]) !== start) {
      try {
        await res.body?.cancel();
      } catch { /* ignore */ }
      await fsp.rm(part, { force: true });
      start = 0;
      resumed = false;
      res = await fetch(url);
      if (!res.ok) {
        record(name, 'fail', `HTTP ${res.status}（Content-Range 起点不符后重下失败）`);
        return { status: 'fail', error: `HTTP ${res.status}` };
      }
    }
  }

  const contentLen = Number(res.headers.get('content-length') || 0);
  const total = expectBytes || (res.status === 206 ? Number((res.headers.get('content-range') || '').split('/')[1]) || 0 : contentLen);

  if (!res.body) {
    record(name, 'fail', '响应无 body');
    return { status: 'fail', error: 'no body' };
  }

  const handle = await fsp.open(part, start > 0 ? 'a' : 'w');
  const reader = res.body.getReader();
  let received = start;
  let lastPrint = Date.now();
  let lastBytes = start;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      received += value.length;
      const now = Date.now();
      if (now - lastPrint > 2000) {
        const speed = ((received - lastBytes) / 1024 / 1024 / ((now - lastPrint) / 1000)).toFixed(1);
        const pct = total ? ((received / total) * 100).toFixed(1) + '%' : '?';
        process.stdout.write(`  … ${name}: ${fmtBytes(received)}${total ? ' / ' + fmtBytes(total) : ''} (${pct}) ${speed} MB/s\r`);
        lastPrint = now;
        lastBytes = received;
      }
    }
  } catch (e) {
    await handle.close();
    record(name, 'fail', `传输中断：${e.message}（已保存 ${fmtBytes(received)}，重跑可续传）`);
    return { status: 'fail', error: e.message, bytes: received };
  }
  await handle.close();
  process.stdout.write('\n');

  const v = await verifyFile(part, expectBytes, expectMd5);
  if (!v.ok) {
    record(name, 'fail', `下载完成但校验失败：${v.why}（保留 .part 供续传/排查）`);
    return { status: 'fail', error: v.why, bytes: received };
  }

  await fsp.rm(dest, { force: true });
  await fsp.rename(part, dest);
  record(name, 'ok', `${fmtBytes(received)}${resumed ? '（断点续传）' : ''}，${v.why}`);
  return { status: 'ok', bytes: received };
}

// ---------------------------------------------------------------------------
// tgz 下载 + 选择性解包（零依赖 tar 解析）
// ---------------------------------------------------------------------------
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 从 tgz 中按条目名解出文件。
 * @param {string} url
 * @param {Array<[tgzPath:string, dest:string]>} entries
 * @returns {Promise<Array<{dest:string,bytes:number,sha256:string}>>}
 */
async function extractTgzEntries(url, entries) {
  const want = new Map(entries);
  const done = [];
  const gz = zlib.gunzipSync(await fetchBuffer(url));
  let off = 0;
  while (off + 512 <= gz.length) {
    const hdr = gz.subarray(off, off + 512);
    const name = hdr.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    if (!name) break;
    const sizeField = hdr.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeField || '0', 8) || 0;
    const type = String.fromCharCode(hdr[156]);
    // GNU 扩展名（长文件名）暂不需要：本项目目标条目均 <100 字符
    if ((type === '0' || type === '\0' || type === '') && want.has(name)) {
      const data = gz.subarray(off + 512, off + 512 + size);
      const dest = want.get(name);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
      done.push({
        dest,
        bytes: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
      });
      want.delete(name);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  if (want.size) {
    throw new Error(`tgz 中缺少条目: ${[...want.keys()].join(', ')}`);
  }
  return done;
}

// ---------------------------------------------------------------------------
// 1) 模型下载
// ---------------------------------------------------------------------------
async function fetchModels() {
  console.log('\n== Piper 中文模型（hf-mirror.com） ==');
  let voices = null;
  try {
    const res = await fetch(VOICES_JSON_URL);
    if (res.ok) voices = await res.json();
    else console.log(`  · voices.json 获取失败 HTTP ${res.status}，退化为字节数校验`);
  } catch (e) {
    console.log(`  · voices.json 获取失败：${e.message}，退化为字节数校验`);
  }

  // voices.json 结构：{ "zh_CN-huayan-medium": { files: { "<路径>": { size_bytes, md5_digest } }, ... } }
  // files 挂在各 voice 条目下（不在顶层）；合并所有条目以覆盖 medium/x_low 两个档位。
  let fileMeta = null;
  if (voices && typeof voices === 'object') {
    const merged = {};
    let hit = 0;
    for (const v of Object.values(voices)) {
      if (v && typeof v === 'object' && v.files) {
        Object.assign(merged, v.files);
        hit++;
      }
    }
    if (hit) fileMeta = merged;
    else console.log('  · voices.json 结构未识别，退化为字节数校验');
  }

  for (const f of MODEL_FILES) {
    let expectBytes = f.expectBytes;
    let expectMd5 = '';
    if (fileMeta) {
      const meta = fileMeta[f.hfPath];
      if (meta) {
        if (meta.size_bytes) expectBytes = meta.size_bytes;
        if (meta.md5_digest) expectMd5 = meta.md5_digest;
      }
    }
    await downloadToFile(HF_BASE + f.hfPath, path.join(ROOT, f.dest), {
      expectBytes,
      expectMd5,
      label: f.dest,
    });
  }
}

// ---------------------------------------------------------------------------
// 2) 运行时下载（onnxruntime-web + piper_phonemize）+ 生成适配层
// ---------------------------------------------------------------------------
async function fetchRuntime() {
  console.log('\n== 运行时（registry.npmmirror.com） ==');

  // --- onnxruntime-web ---
  const ortJsDest = path.join(TTS_DIR, 'ort.wasm.min.js');
  try {
    const ortDone = await extractTgzEntries(ORT_TGZ, [[ORT_JS_ENTRY, ortJsDest]]);
    for (const d of ortDone) {
      record(path.relative(ROOT, d.dest), 'ok', `onnxruntime-web 1.18.0，${fmtBytes(d.bytes)}`);
    }
  } catch (e) {
    record('tts/ort.wasm.min.js', 'fail', e.message);
  }

  // 从 ort.wasm.min.js 里发现实际引用的 wasm 文件名（保证覆盖运行时所需）
  const wantedWasm = new Set();
  try {
    const ortJsText = await fsp.readFile(ortJsDest, 'utf8');
    for (const m of ortJsText.matchAll(/ort-wasm[a-zA-Z0-9._-]*\.wasm/g)) {
      const n = m[0];
      if (/jsep|training/i.test(n)) continue; // 本项目只用 wasm EP
      wantedWasm.add('package/dist/' + n);
    }
  } catch {
    console.log('  · 无法读取 ort.wasm.min.js 做发现，仅用兜底集合');
  }
  // 兜底集合与发现集合取并集（发现集合可能不全，例如按 flags 拼接构造的名字）
  for (const p of ORT_WASM_FALLBACK) wantedWasm.add(p);

  try {
    const wasmEntries = [...wantedWasm].map((p) => [p, path.join(TTS_DIR, path.basename(p))]);
    const wasmDone = await extractTgzEntries(ORT_TGZ, wasmEntries);
    for (const d of wasmDone) record(path.relative(ROOT, d.dest), 'ok', fmtBytes(d.bytes));
  } catch (e) {
    record('tts/ort-wasm*.wasm', 'fail', e.message);
  }

  // --- piper_phonemize（espeak-ng 音素化）---
  try {
    const phDone = await extractTgzEntries(
      PIPER_WASM_TGZ,
      PIPER_WASM_ENTRIES.map(([a, b]) => [a, path.join(ROOT, b)])
    );
    for (const d of phDone) record(path.relative(ROOT, d.dest), 'ok', fmtBytes(d.bytes));
  } catch (e) {
    record('tts/piper_phonemize.*', 'fail', e.message);
  }

  // --- 生成适配层（无论上面成败都生成：缺失资源时页面会得到可读错误码）---
  const runtimeDest = path.join(TTS_DIR, 'piper-runtime.js');
  await fsp.writeFile(runtimeDest, PIPER_RUNTIME_SOURCE, 'utf8');
  record('tts/piper-runtime.js', 'ok', '已生成 PiperTTS 适配层');

  // --- 资源清单 ---
  const assets = { generatedAt: new Date().toISOString(), files: {} };
  for (const f of await walkFiles(TTS_DIR)) {
    const buf = await fsp.readFile(f);
    assets.files[path.relative(ROOT, f).split(path.sep).join('/')] = {
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  }
  await fsp.writeFile(path.join(TTS_DIR, 'ASSETS.json'), JSON.stringify(assets, null, 2) + '\n', 'utf8');
  record('tts/ASSETS.json', 'ok', `${Object.keys(assets.files).length} 个文件`);
}

async function walkFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, base, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成 tts/piper-runtime.js（浏览器适配层）
//
// 实现要点：
//  - window.PiperTTS.create({wasmPaths, numThreads}) → 实例
//  - 实例.loadVoice(configJsonString, modelArrayBuffer)
//  - 实例.synthesize(text, {lengthScale, noiseScale, noiseW}) → WAV ArrayBuffer
//  - 音素化：piper_phonemize（espeak-ng WASM，含 cmn 中文词典），输入/输出协议
//    与官方 piper-phonemize 一致：callMain(['-l', voice, '--input', json,
//    '--espeak_data', '/espeak-ng-data']) → print 输出 {"phonemes":[...],"phoneme_ids":[...]}
//    （phoneme_ids 是 espeak 内部 id 空间，不可直接喂模型 —— 用 phonemes 按模型表重映射）
//  - 降级链：音素化不可用 → 若 phoneme_id_map 能覆盖输入字符则按字符直映射
//    （发音质量下降但可出声）→ 否则抛出结构化可读错误（UI 可提示改用云端 TTS）
//  - 无 crossOriginIsolated 时强制 numThreads=1（SharedArrayBuffer 不可用）
// ---------------------------------------------------------------------------
const PIPER_RUNTIME_SOURCE = `/**
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
    text = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
    if (!text) return [];
    if (text.length <= max) return [text];
    var parts = text.match(/[^。！？!?；;，,\\n]+[。！？!?；;，,]*\\s*/g) || [text];
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
`;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log(`TintTXT TTS 资源下载（only=${only}${force ? '，force' : ''}）`);
  console.log(`模型目录: ${MODELS_DIR}`);
  console.log(`运行时目录: ${TTS_DIR}`);

  const tasks = [];
  if (only === 'all' || only === 'models') {
    tasks.push(fetchModels().catch((e) => record('模型下载（整体）', 'fail', e.message)));
  }
  if (only === 'all' || only === 'runtime') {
    tasks.push(fetchRuntime().catch((e) => record('运行时下载（整体）', 'fail', e.message)));
  }
  await Promise.all(tasks);

  // 汇总
  const ok = REPORT.filter((r) => r.status === 'ok' || r.status === 'skip').length;
  const fail = REPORT.filter((r) => r.status === 'fail');
  console.log('');
  console.log(`结果：${ok} 项成功/跳过，${fail.length} 项失败`);
  if (fail.length) {
    for (const f of fail) console.log(`  ✗ ${f.name} — ${f.detail}`);
    console.log('提示：失败项会保留 .part 断点文件，重跑本脚本可续传。');
    process.exitCode = 1;
  }

  // 目录体检
  const required = [
    'models/zh_CN-huayan-medium.onnx',
    'models/zh_CN-huayan-medium.onnx.json',
    'models/zh_CN-huayan-x_low.onnx',
    'models/zh_CN-huayan-x_low.onnx.json',
    'tts/ort.wasm.min.js',
    'tts/piper_phonemize.js',
    'tts/piper_phonemize.wasm',
    'tts/piper_phonemize.data',
    'tts/piper-runtime.js',
  ];
  const missing = required.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (missing.length) {
    console.log('');
    console.log('缺失文件（本地 TTS 需要全部就位）：');
    for (const m of missing) console.log('  - ' + m);
    console.log('替代建议：若 npmmirror/hf-mirror 不可达，可改用 sherpa-onnx 官方 wasm 包');
    console.log('  https://github.com/k2-fsa/sherpa-onnx/releases 或 ModelScope 镜像');
    console.log('  （https://www.modelscope.cn ）下载等价资源后放入同路径。');
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('全部必需文件就位 ✓ —— 页面可通过 /tts/piper-runtime.js 使用本地 Piper TTS。');
  }
}

main().catch((err) => {
  console.error('执行失败：', err);
  process.exit(1);
});
