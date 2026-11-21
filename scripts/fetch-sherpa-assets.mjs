#!/usr/bin/env node
/**
 * fetch-sherpa-assets.mjs —— sherpa-onnx 中文 TTS 资源下载器（零依赖，国内镜像）
 *
 * 用途：把「网页 TXT 听书器」默认 TTS 引擎（sherpa-onnx wasm + vits-zh-aishell3）
 * 所需的运行时与模型落到工作区，运行期零外联（全部同源自托管）。
 *
 * 用法：
 *   node scripts/fetch-sherpa-assets.mjs                     # 运行时 + 模型（int8 省流档）
 *   node scripts/fetch-sherpa-assets.mjs --only runtime      # 仅运行时（tts/sherpa/）
 *   node scripts/fetch-sherpa-assets.mjs --only models       # 仅模型（models/sherpa-zh/）
 *   node scripts/fetch-sherpa-assets.mjs --tier full         # 121MB 全精度模型（默认 int8 39MB）
 *   node scripts/fetch-sherpa-assets.mjs --with-rule-far     # 额外下载 rule.far（180MB，默认不下载）
 *   node scripts/fetch-sherpa-assets.mjs --force             # 忽略已存在文件，强制重新下载
 *
 * 产物：
 *   tts/sherpa/sherpa-onnx-tts.js                 应用胶水（OfflineTts 封装，自托管副本）
 *   tts/sherpa/sherpa-onnx-wasm-main-tts.js       Emscripten 胶水（已做「不预载上游资源」补丁）
 *   tts/sherpa/sherpa-onnx-wasm-main-tts.wasm     运行时 wasm（13,473,435 字节）
 *   tts/sherpa/sherpa-onnx-wasm-main-tts.data     0 字节占位（见下方「.data 说明」）
 *   models/sherpa-zh/vits-aishell3.int8.onnx      39,870,124 字节（默认档）
 *   models/sherpa-zh/lexicon.txt tokens.txt       中文 lexicon 文本前端
 *   models/sherpa-zh/phone.fst date.fst number.fst new_heteronym.fst   文本正则化 FST
 *   models/sherpa-zh/rule.far                     180,717,014 字节（仅 --with-rule-far）
 *   models/sherpa-zh/MANIFEST.json                清单（文件名/字节数/来源 URL/sha256/下载时间）
 *
 * 下载特性：流式写盘、断点续传（.part + Range，镜像支持时）、3 次重试、
 * 校验（优先 hf-mirror tree API 的 `lfs.oid`＝sha256 与 `size`，其次 HEAD
 * content-length，最后脚本内置字节数；resolve 直链的 ETag 是 xet 哈希，不用来校验）。
 *
 * 镜像说明：
 *   - 运行时：hf-mirror.com 上 k2-fsa 的官方静态 Space（实测可达，纯文件无 LFS 认证问题）
 *   - 模型：hf-mirror.com/csukuangfj/vits-zh-aishell3（license: apache-2.0）
 *   - 不使用境外 CDN；github.com 仅在错误提示里作为人工兜底路径出现。
 *
 * .data 说明（重要）：
 *   上游构建用 `--preload-file assets@.`，会把「模型 + espeak-ng-data」预载进 .data
 *   （Space 版 204MB、GitHub release 版约 71MB，都是英文/zipvoice 模型，我们不需要，
 *   且 espeak-ng-data 属于许可不明数据，绝不能分发）。本脚本改为生成 0 字节占位 .data，
 *   并给 Emscripten 胶水打上 `metadata["files"] => []` 补丁（标记 tinttxt-no-preload），
 *   由 src/layers/playback/tts/sherpa.js 在运行时用 Module.FS_createDataFile
 *   把 /models/sherpa-zh/ 的模型写进虚拟文件系统。详见 docs/engine-switch-notes.md §5。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MODELS_DIR = path.join(ROOT, 'models', 'sherpa-zh');
const TTS_DIR = path.join(ROOT, 'tts', 'sherpa');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let only = 'all';
let tier = 'int8';
let withRuleFar = false;
let force = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--only') only = String(argv[++i] || 'all');
  else if (a.startsWith('--only=')) only = a.slice(7);
  else if (a === '--tier') tier = String(argv[++i] || 'int8');
  else if (a.startsWith('--tier=')) tier = a.slice(7);
  else if (a === '--with-rule-far') withRuleFar = true;
  else if (a === '--force') force = true;
  else if (a === '--help' || a === '-h') {
    console.log(
      '用法: node scripts/fetch-sherpa-assets.mjs [--only runtime|models|all] [--tier int8|full] [--with-rule-far] [--force]',
    );
    process.exit(0);
  } else {
    console.error('未知参数：', a);
    process.exit(1);
  }
}
if (!['all', 'runtime', 'models'].includes(only)) {
  console.error('--only 只能是 runtime | models | all');
  process.exit(1);
}
if (!['int8', 'full'].includes(tier)) {
  console.error('--tier 只能是 int8 | full');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 常量：下载源与目标
//
// 字节数为 2026-11-19 实测（hf-mirror tree API `size`），作为上游变动的基线；
// 运行时优先用 tree API 的 `lfs.oid`（sha256）与 `size` 做权威校验，
// 非 LFS 小文件没有 sha256，退化为字节数校验，本地 sha256 仍写入 MANIFEST.json。
// ---------------------------------------------------------------------------
const SPACE_BASE = 'https://hf-mirror.com/spaces/k2-fsa/web-assembly-zh-en-tts-zipvoice/resolve/main/';
const SPACE_TREE_API = 'https://hf-mirror.com/api/spaces/k2-fsa/web-assembly-zh-en-tts-zipvoice/tree/main';
const HF_MODEL_BASE = 'https://hf-mirror.com/csukuangfj/vits-zh-aishell3/resolve/main/';
const HF_MODEL_API = 'https://hf-mirror.com/api/models/csukuangfj/vits-zh-aishell3';
const HF_MODEL_TREE_API = 'https://hf-mirror.com/api/models/csukuangfj/vits-zh-aishell3/tree/main';

/** sherpa-onnx wasm 运行时（同版本三件套，必须整套取自同一构建） */
const RUNTIME_FILES = [
  {
    name: 'sherpa-onnx-tts.js',
    dest: 'tts/sherpa/sherpa-onnx-tts.js',
    expectBytes: 33227,
  },
  {
    name: 'sherpa-onnx-wasm-main-tts.js',
    dest: 'tts/sherpa/sherpa-onnx-wasm-main-tts.js',
    expectBytes: 111298,
    patch: 'noPreload',
  },
  {
    name: 'sherpa-onnx-wasm-main-tts.wasm',
    dest: 'tts/sherpa/sherpa-onnx-wasm-main-tts.wasm',
    expectBytes: 13473435,
  },
];

/** vits-zh-aishell3 模型包公共文件（license: apache-2.0） */
const MODEL_COMMON = [
  { name: 'lexicon.txt', dest: 'models/sherpa-zh/lexicon.txt', expectBytes: 2042943 },
  { name: 'tokens.txt', dest: 'models/sherpa-zh/tokens.txt', expectBytes: 1671 },
  { name: 'phone.fst', dest: 'models/sherpa-zh/phone.fst', expectBytes: 88630 },
  { name: 'date.fst', dest: 'models/sherpa-zh/date.fst', expectBytes: 59154 },
  { name: 'number.fst', dest: 'models/sherpa-zh/number.fst', expectBytes: 64482 },
  { name: 'new_heteronym.fst', dest: 'models/sherpa-zh/new_heteronym.fst', expectBytes: 21974 },
];

/** 档位：默认 int8（39.8MB 省流），full 为 121.4MB 全精度 */
const MODEL_TIERS = {
  int8: { name: 'vits-aishell3.int8.onnx', dest: 'models/sherpa-zh/vits-aishell3.int8.onnx', expectBytes: 39870124 },
  full: { name: 'vits-aishell3.onnx', dest: 'models/sherpa-zh/vits-aishell3.onnx', expectBytes: 121383104 },
};

/**
 * rule.far：180,717,014 字节，是上游英文文本正则化的 FAR 归档。
 * 中文走 phone/date/number 三个 FST 即可（适配器 ruleFars 传空串），默认不下载；
 * 需要时用 --with-rule-far 补齐。
 */
const RULE_FAR = { name: 'rule.far', dest: 'models/sherpa-zh/rule.far', expectBytes: 180717014 };

/** 运行时缺失时给运维的人工兜底路径（不参与自动下载）。 */
const FALLBACK_HINT =
  'GitHub release（含同版本三件套，需本机 tar 解 .tar.bz2）：' +
  'https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.1 下载 ' +
  'sherpa-onnx-wasm-simd-2.0.1-vits-piper-en_US-libritts_r-medium.tar.bz2，' +
  '解出 sherpa-onnx-tts.js / sherpa-onnx-wasm-main-tts.js / sherpa-onnx-wasm-main-tts.wasm 放入 tts/sherpa/。';

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

/**
 * 校验已落盘文件：字节数必查；sha256（服务端给出时）必查。
 * @returns {Promise<{ok:boolean, why:string, sha256:string, bytes:number}>}
 */
async function verifyFile(file, expectBytes, expectSha256) {
  if (!fs.existsSync(file)) return { ok: false, why: '文件不存在', sha256: '', bytes: 0 };
  const size = fs.statSync(file).size;
  if (expectBytes && size !== expectBytes) {
    return { ok: false, why: `大小不符：${size} ≠ ${expectBytes}`, sha256: '', bytes: size };
  }
  const sha256 = await hashFile(file, 'sha256');
  if (expectSha256 && sha256.toLowerCase() !== String(expectSha256).toLowerCase()) {
    return { ok: false, why: `sha256 不符：${sha256}`, sha256, bytes: size };
  }
  return {
    ok: true,
    why: expectSha256 ? 'sha256+字节校验通过' : expectBytes ? '字节校验通过（服务端未提供 sha256）' : '未提供校验值（仅存在性）',
    sha256,
    bytes: size,
  };
}

/** tree API 结果缓存（同一 URL 只请求一次）。 */
const treeCache = new Map();

/**
 * 取 HF tree API 元数据：`lfs.oid` 即 LFS 文件的 sha256（实测与本地 Get-FileHash 一致），
 * `size` 为字节数。
 * 注意：resolve 直链最终响应的 `ETag` 是 xet 哈希、不是 sha256，不能用来校验；
 * 非 LFS 小文件没有 lfs 字段（其 oid 是 git sha1），此时只用字节数校验。
 * @param {string} apiUrl
 * @returns {Promise<Map<string, {bytes:number, sha256:string}>>}
 */
function getTreeMeta(apiUrl) {
  if (!treeCache.has(apiUrl)) {
    treeCache.set(
      apiUrl,
      (async () => {
        const map = new Map();
        try {
          const res = await fetch(apiUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const arr = await res.json();
          for (const e of arr) {
            if (!e || typeof e.path !== 'string') continue;
            const oid = e.lfs && e.lfs.oid ? String(e.lfs.oid) : '';
            map.set(e.path, {
              bytes: Number(e.size) || 0,
              sha256: /^[0-9a-f]{64}$/i.test(oid) ? oid : '',
            });
          }
        } catch (e) {
          console.log(`  · tree API 不可用（${e.message}），退化为字节数校验`);
        }
        return map;
      })(),
    );
  }
  return treeCache.get(apiUrl);
}

/**
 * 兜底：HEAD 最终响应的 content-length（tree API 不可用时）。
 * @returns {Promise<number>} 0 表示拿不到
 */
async function headSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) return 0;
    return Number(res.headers.get('content-length') || 0);
  } catch {
    return 0;
  }
}

/**
 * 解析某个文件的校验期望值：tree API（size + lfs sha256）→ HEAD size → 内置值。
 * @param {string} apiUrl tree API
 * @param {string} url 文件直链
 * @param {string} name tree 中的路径名
 * @param {number} fallbackBytes 脚本内置的字节数（2026-11-19 实测）
 * @returns {Promise<{bytes:number, sha256:string, how:string}>}
 */
async function resolveExpect(apiUrl, url, name, fallbackBytes) {
  const t = (await getTreeMeta(apiUrl)).get(name);
  if (t && t.bytes) {
    if (fallbackBytes && t.bytes !== fallbackBytes) {
      console.log(`  · ${name}: 服务端字节数 ${t.bytes} ≠ 内置期望 ${fallbackBytes}，以服务端为准`);
    }
    return {
      bytes: t.bytes,
      sha256: t.sha256,
      how: t.sha256 ? 'tree API（size + lfs sha256）' : 'tree API（size，非 LFS 无 sha256）',
    };
  }
  const hs = await headSize(url);
  if (hs) {
    if (fallbackBytes && hs !== fallbackBytes) {
      console.log(`  · ${name}: HEAD 字节数 ${hs} ≠ 内置期望 ${fallbackBytes}，以 HEAD 为准`);
    }
    return { bytes: hs, sha256: '', how: 'HEAD（size）' };
  }
  return { bytes: fallbackBytes, sha256: '', how: '内置字节数' };
}

// ---------------------------------------------------------------------------
// 断点续传下载（流式写盘）
// ---------------------------------------------------------------------------
/**
 * @param {string} url
 * @param {string} dest 相对 ROOT 的目标路径
 * @param {{expectBytes?:number, expectSha256?:string, label?:string}} [opts]
 * @returns {Promise<{status:'ok'|'skip'|'fail', bytes?:number, sha256?:string, error?:string}>}
 */
async function downloadToFile(url, dest, { expectBytes = 0, expectSha256 = '', label = '' } = {}) {
  const abs = path.join(ROOT, dest);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const name = label || dest;

  // 已存在且校验通过 → 跳过
  if (!force && fs.existsSync(abs)) {
    const v = await verifyFile(abs, expectBytes, expectSha256);
    if (v.ok) {
      record(name, 'skip', `已存在（${fmtBytes(v.bytes)}，${v.why}）`);
      return { status: 'skip', bytes: v.bytes, sha256: v.sha256 };
    }
    console.log(`  · 已存在但校验失败，重新下载：${v.why}`);
    await fsp.rm(abs, { force: true });
  }

  const part = abs + '.part';
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // 仅 4xx 才丢弃断点：5xx/网络抖动保留 .part 续传进度（一次 502 不该作废几十 MB 断点）
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
    const v = await verifyFile(part, expectBytes, expectSha256);
    if (v.ok) {
      await fsp.rename(part, abs);
      record(name, 'ok', `续传完成（${fmtBytes(v.bytes)}，${v.why}）`);
      return { status: 'ok', bytes: v.bytes, sha256: v.sha256 };
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
    start = 0; // 镜像不支持 Range：从头来
    resumed = false;
  }
  if (resumed) {
    // 校验 Content-Range 起点与请求一致：不符则整档重下（避免在错误偏移 append 产出损坏文件）
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
  const total =
    expectBytes ||
    (res.status === 206 ? Number((res.headers.get('content-range') || '').split('/')[1]) || 0 : contentLen);

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
        process.stdout.write(
          `  … ${name}: ${fmtBytes(received)}${total ? ' / ' + fmtBytes(total) : ''} (${pct}) ${speed} MB/s\r`,
        );
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

  const v = await verifyFile(part, expectBytes, expectSha256);
  if (!v.ok) {
    record(name, 'fail', `下载完成但校验失败：${v.why}（保留 .part 供续传/排查）`);
    return { status: 'fail', error: v.why, bytes: received };
  }

  await fsp.rm(abs, { force: true });
  await fsp.rename(part, abs);
  record(name, 'ok', `${fmtBytes(received)}${resumed ? '（断点续传）' : ''}，${v.why}`);
  return { status: 'ok', bytes: v.bytes, sha256: v.sha256 };
}

// ---------------------------------------------------------------------------
// 运行时后处理
// ---------------------------------------------------------------------------
/** Emscripten 预载补丁标记（幂等：已打过就跳过）。 */
const NO_PRELOAD_MARK = '/*tinttxt-no-preload*/';

/**
 * 给 Emscripten 胶水打补丁：把 `metadata["files"]` 换成空数组。
 *
 * 上游 `--preload-file assets@.` 会把模型与 espeak-ng-data 目录清单写进胶水，
 * 运行时据此在虚拟 FS 里建 ~600 个文件（含 /espeak-ng-data/**）。
 * 我们不预载任何上游资源（模型由适配器运行时写入），故清空清单。
 *
 * 只替换 JSON 数据字面量，不改任何控制流；两处出现位置都是
 * `for (var file of metadata["files"])`。
 * @param {string} dest 相对 ROOT 的路径
 */
function patchEmscriptenGlue(dest) {
  const abs = path.join(ROOT, dest);
  let text = fs.readFileSync(abs, 'utf8');
  if (text.includes(NO_PRELOAD_MARK)) {
    record(dest, 'skip', '预载补丁已存在（幂等）');
    return true;
  }
  const before = (text.match(/metadata\["files"\]/g) || []).length;
  if (before === 0) {
    record(dest, 'fail', '未找到 metadata["files"]，上游结构可能已变化，请人工核对');
    return false;
  }
  text = text.split(`metadata["files"]`).join(`[]${NO_PRELOAD_MARK}`);
  fs.writeFileSync(abs, text, 'utf8');
  record(dest, 'ok', `已打「不预载上游资源」补丁（替换 ${before} 处 metadata["files"]）`);
  return true;
}

/**
 * 生成 0 字节占位 .data。
 * 适配器会挂 Module.getPreloadedPackage 直接短路下载；此文件仅作兜底
 * （没有它时 Emscripten 会 fetch 该路径，404 会让运行时初始化失败）。
 * @param {string} dest 相对 ROOT 的路径
 */
function writeEmptyData(dest) {
  const abs = path.join(ROOT, dest);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, Buffer.alloc(0));
  record(dest, existed ? 'skip' : 'ok', '0 字节占位（上游预载包不分发，模型运行时注入）');
}

// ---------------------------------------------------------------------------
// 1) 运行时下载
// ---------------------------------------------------------------------------
/** @type {{file:string, bytes:number, sha256:string, source:string}[]} */
const MANIFEST = [];

async function fetchRuntime() {
  console.log('\n== sherpa-onnx wasm 运行时（hf-mirror Space） ==');

  for (const f of RUNTIME_FILES) {
    const url = SPACE_BASE + f.name;
    // 已打过补丁的胶水：跳过重新下载（否则字节数校验会因补丁增量而失败）
    const abs = path.join(ROOT, f.dest);
    if (
      f.patch === 'noPreload' &&
      !force &&
      fs.existsSync(abs) &&
      fs.readFileSync(abs, 'utf8').includes(NO_PRELOAD_MARK)
    ) {
      const bytes = fs.statSync(abs).size;
      const sha256 = await hashFile(abs, 'sha256');
      record(f.dest, 'skip', `已打「不预载上游资源」补丁（${fmtBytes(bytes)}）`);
      MANIFEST.push({ file: f.dest, bytes, sha256, source: url });
      continue;
    }
    const exp = await resolveExpect(SPACE_TREE_API, url, f.name, f.expectBytes);
    const r = await downloadToFile(url, f.dest, { expectBytes: exp.bytes, expectSha256: exp.sha256 });
    if (r.status === 'fail') {
      record(f.dest, 'fail', `运行时获取失败：${r.error} —— ${FALLBACK_HINT}`);
      continue;
    }
    if (f.patch === 'noPreload') patchEmscriptenGlue(f.dest);
    MANIFEST.push({ file: f.dest, bytes: r.bytes || 0, sha256: r.sha256 || '', source: url });
  }

  // 0 字节占位 .data（不走网络）
  const dataRel = 'tts/sherpa/sherpa-onnx-wasm-main-tts.data';
  writeEmptyData(dataRel);
  MANIFEST.push({
    file: dataRel,
    bytes: 0,
    sha256: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    source: '本地生成（上游 --preload-file 预载包不分发）',
  });
}

// ---------------------------------------------------------------------------
// 2) 模型下载
// ---------------------------------------------------------------------------
async function fetchModels() {
  console.log('\n== vits-zh-aishell3 模型（hf-mirror.com，license: apache-2.0） ==');

  // 尽力取一次模型仓元数据：记录 license / 仓 sha，供 MANIFEST 溯源
  let repoMeta = null;
  try {
    const res = await fetch(HF_MODEL_API);
    if (res.ok) {
      const j = await res.json();
      repoMeta = {
        id: j.id || '',
        license: (j.cardData && j.cardData.license) || '',
        sha: j.sha || '',
        lastModified: j.lastModified || '',
      };
      console.log(`  · 仓库 ${repoMeta.id} license=${repoMeta.license || '?'} sha=${repoMeta.sha.slice(0, 12) || '?'}…`);
    }
  } catch (e) {
    console.log(`  · 模型仓 API 获取失败（${e.message}），退化为字节/sha 校验`);
  }

  const list = [];
  if (only !== 'runtime') {
    list.push(MODEL_TIERS[tier]);
    list.push(...MODEL_COMMON);
    if (withRuleFar) list.push(RULE_FAR);
    else {
      record(RULE_FAR.dest, 'skip', `默认不下载（${fmtBytes(RULE_FAR.expectBytes)}，适配器 ruleFars 传空；需要时加 --with-rule-far）`);
    }
  }

  for (const f of list) {
    const url = HF_MODEL_BASE + f.name;
    const exp = await resolveExpect(HF_MODEL_TREE_API, url, f.name, f.expectBytes);
    const r = await downloadToFile(url, f.dest, { expectBytes: exp.bytes, expectSha256: exp.sha256 });
    if (r.status === 'fail') continue;
    MANIFEST.push({ file: f.dest, bytes: r.bytes || 0, sha256: r.sha256 || '', source: url });
  }

  return repoMeta;
}

// ---------------------------------------------------------------------------
// 3) 清单
// ---------------------------------------------------------------------------
async function writeManifest(repoMeta) {
  // 与已有清单合并：--only runtime / --only models 分次跑时互不覆盖
  let prev = null;
  try {
    prev = JSON.parse(await fsp.readFile(path.join(MODELS_DIR, 'MANIFEST.json'), 'utf8'));
  } catch {
    prev = null;
  }
  const merge = (a, b) => {
    const map = new Map();
    for (const m of [...(a || []), ...(b || [])]) map.set(m.file, m);
    return [...map.values()];
  };
  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/fetch-sherpa-assets.mjs',
    tier,
    repo: repoMeta || (prev && prev.repo) || null,
    note:
      'ruleFars 未使用：中文文本正则化只依赖 phone/date/number 三个 FST；' +
      'rule.far（180,717,014 字节）为上游英文归档，未下载时不在本清单内。',
    runtime: merge(prev && prev.runtime, MANIFEST.filter((m) => m.file.startsWith('tts/'))),
    files: merge(prev && prev.files, MANIFEST.filter((m) => m.file.startsWith('models/'))),
  };
  const dest = path.join(MODELS_DIR, 'MANIFEST.json');
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  await fsp.writeFile(dest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  record('models/sherpa-zh/MANIFEST.json', 'ok', `${manifest.files.length} 个模型文件 + ${manifest.runtime.length} 个运行时文件`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log(`TintTXT sherpa-onnx TTS 资源下载（only=${only}，tier=${tier}${withRuleFar ? '，含 rule.far' : ''}${force ? '，force' : ''}）`);
  console.log(`运行时目录: ${path.relative(ROOT, TTS_DIR).split(path.sep).join('/')}/`);
  console.log(`模型目录:   ${path.relative(ROOT, MODELS_DIR).split(path.sep).join('/')}/`);

  let repoMeta = null;
  if (only === 'all' || only === 'runtime') {
    await fetchRuntime().catch((e) => record('运行时下载（整体）', 'fail', e.message));
  }
  if (only === 'all' || only === 'models') {
    repoMeta = await fetchModels().catch((e) => {
      record('模型下载（整体）', 'fail', e.message);
      return null;
    });
  }
  // 清单只覆盖本次实际处理的文件（--only 时不写半份清单）
  if (MANIFEST.length) await writeManifest(repoMeta);

  const ok = REPORT.filter((r) => r.status === 'ok' || r.status === 'skip').length;
  const fail = REPORT.filter((r) => r.status === 'fail');
  console.log('');
  console.log(`结果：${ok} 项成功/跳过，${fail.length} 项失败`);
  if (fail.length) {
    for (const f of fail) console.log(`  ✗ ${f.name} — ${f.detail}`);
    console.log('提示：失败项会保留 .part 断点文件，重跑本脚本可续传。');
    process.exitCode = 1;
  }

  // 目录体检（按本次 only 档位）
  const required = [];
  if (only === 'all' || only === 'runtime') {
    required.push(
      'tts/sherpa/sherpa-onnx-tts.js',
      'tts/sherpa/sherpa-onnx-wasm-main-tts.js',
      'tts/sherpa/sherpa-onnx-wasm-main-tts.wasm',
      'tts/sherpa/sherpa-onnx-wasm-main-tts.data',
    );
  }
  if (only === 'all' || only === 'models') {
    required.push(
      `models/sherpa-zh/${MODEL_TIERS[tier].name}`,
      'models/sherpa-zh/lexicon.txt',
      'models/sherpa-zh/tokens.txt',
      'models/sherpa-zh/phone.fst',
      'models/sherpa-zh/date.fst',
      'models/sherpa-zh/number.fst',
      'models/sherpa-zh/new_heteronym.fst',
      'models/sherpa-zh/MANIFEST.json',
    );
  }
  const missing = required.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (missing.length) {
    console.log('');
    console.log('缺失文件（sherpa 本地 TTS 需要全部就位）：');
    for (const m of missing) console.log('  - ' + m);
    process.exitCode = 1;
  } else if (!fail.length) {
    console.log('');
    console.log('全部必需文件就位 ✓ —— 页面可通过 /tts/sherpa/ 使用本地 sherpa-onnx 中文 TTS。');
  }
}

main().catch((err) => {
  console.error('执行失败：', err);
  process.exit(1);
});
