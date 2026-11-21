#!/usr/bin/env node
/**
 * fetch-kokoro-assets.mjs —— Kokoro v1.1 中文 TTS 资源下载器（零依赖，国内镜像）
 *
 * 用法：
 *   node scripts/fetch-kokoro-assets.mjs                # 下载并校验到 models/kokoro/
 *   node scripts/fetch-kokoro-assets.mjs --tier fp32    # 换用 FP32 模型（310MB，默认 int8 109MB）
 *   node scripts/fetch-kokoro-assets.mjs --force        # 已存在也强制重下
 *
 * 来源（hf-mirror 直链，2026-11-20 调研实测可达）：
 *   https://hf-mirror.com/csukuangfj/kokoro-int8-multi-lang-v1_1/resolve/main/<file>
 *   https://hf-mirror.com/csukuangfj/kokoro-multi-lang-v1_1/resolve/main/<file>
 * 许可：Apache-2.0（仓库 LICENSE 实测）；分发需保留 LICENSE 与来源标注。
 *
 * 下载实现遵循「无人值守」约定：一律 spawn curl.exe（全名，-L 跟随跳转、--retry 重试、
 * 超时上限），不用 PowerShell Invoke-WebRequest（PS5.1 会弹 IE 安全框卡死）。
 * 校验：字节数必查；hf tree API 提供 LFS sha256 时一并核对；失败自动重下并记日志。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEST_DIR = path.join(ROOT, 'models', 'kokoro');

const args = process.argv.slice(2);
const force = args.includes('--force');
const tierIdx = args.indexOf('--tier');
const tier = tierIdx >= 0 && args[tierIdx + 1] ? args[tierIdx + 1] : 'int8';
if (!['int8', 'fp32'].includes(tier)) {
  console.error('--tier 只能是 int8 | fp32');
  process.exit(1);
}

const INT8_REPO = 'csukuangfj/kokoro-int8-multi-lang-v1_1';
const FP32_REPO = 'csukuangfj/kokoro-multi-lang-v1_1';
const repo = tier === 'fp32' ? FP32_REPO : INT8_REPO;
const BASE = `https://hf-mirror.com/${repo}/resolve/main/`;
const TREE_API = `https://hf-mirror.com/api/models/${repo}/tree/main`;

/** 模型（按 tier 二选一）+ 必需伴生文件（调研报告 §1/§4 实测字节数）。 */
const FILES = [
  { name: tier === 'fp32' ? 'model.onnx' : 'model.int8.onnx', dest: `model.${tier === 'fp32' ? 'onnx' : 'int8.onnx'}`, expectBytes: tier === 'fp32' ? 325561476 : 114203914 },
  { name: 'voices.bin', dest: 'voices.bin', expectBytes: 53790720 },
  { name: 'tokens.txt', dest: 'tokens.txt', expectBytes: 1111 },
  { name: 'lexicon-zh.txt', dest: 'lexicon-zh.txt', expectBytes: 2120131 },
  { name: 'lexicon-us-en.txt', dest: 'lexicon-us-en.txt', expectBytes: 5956885 },
  { name: 'number-zh.fst', dest: 'number-zh.fst', expectBytes: 64482 },
  { name: 'date-zh.fst', dest: 'date-zh.fst', expectBytes: 59154 },
  { name: 'phone-zh.fst', dest: 'phone-zh.fst', expectBytes: 88630 },
  { name: 'LICENSE', dest: 'LICENSE', expectBytes: 0 }, // 无内置大小：以远端为准
  // espeak-ng-data 核心（旧版运行时 <v2.0.0 的 kokoro Validate() 强制要求 dataDir，
  // 实测缺它报 "Please provide --kokoro-data-dir"）。只取必需集 ≈2.4MB：
  // espeak 初始化四件套 + 中/英词典（cmn_dict 是中文，en_dict 是英文）。
  // name = 仓库内完整路径（拼 URL 用）；tree 元数据同时按完整路径与basename索引。
  { name: 'espeak-ng-data/phondata', dest: 'espeak-ng-data/phondata', expectBytes: 550424 },
  { name: 'espeak-ng-data/phondata-manifest', dest: 'espeak-ng-data/phondata-manifest', expectBytes: 21821 },
  { name: 'espeak-ng-data/phonindex', dest: 'espeak-ng-data/phonindex', expectBytes: 39074 },
  { name: 'espeak-ng-data/phontab', dest: 'espeak-ng-data/phontab', expectBytes: 55796 },
  { name: 'espeak-ng-data/intonations', dest: 'espeak-ng-data/intonations', expectBytes: 2040 },
  { name: 'espeak-ng-data/cmn_dict', dest: 'espeak-ng-data/cmn_dict', expectBytes: 1566335 },
  { name: 'espeak-ng-data/en_dict', dest: 'espeak-ng-data/en_dict', expectBytes: 166944 },
];

function log(msg) {
  console.log(`[kokoro] ${msg}`);
}

/** spawn curl.exe 全名下载（无人值守：跟随跳转 + 重试 + 超时）。 */
function curlDownload(url, outPath) {
  return new Promise((resolve) => {
    const p = spawn('curl.exe', [
      '-L', '--fail', '--silent', '--show-error',
      '--retry', '3', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '20', '--max-time', '1800',
      '-o', outPath, url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, err: String(e) }));
    p.on('close', (code) => resolve({ ok: code === 0, err: err.trim() }));
  });
}

async function hashFile(p) {
  const h = crypto.createHash('sha256');
  const fh = await fsp.open(p);
  const buf = Buffer.alloc(1 << 20);
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, null);
    if (!bytesRead) break;
    h.update(buf.subarray(0, bytesRead));
  }
  await fh.close();
  return h.digest('hex');
}

/** hf tree API：文件名 → {size, sha256(LFS)}；网络失败返回 null（退化为仅字节数校验）。 */
async function fetchTreeMeta() {
  try {
    const res = await fetch(TREE_API, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const arr = await res.json();
    const map = new Map();
    for (const e of arr) {
      if (e.type !== 'file') continue;
      const base = e.path.split('/').pop();
      const rec = { size: e.size || 0, sha256: e.lfs && /^[0-9a-f]{64}$/.test(e.lfs.oid || '') ? e.lfs.oid : '' };
      map.set(e.path, rec); // 完整路径（espeak-ng-data/xxx）
      if (!map.has(base)) map.set(base, rec); // basename 兜底
    }
    return map;
  } catch {
    return null;
  }
}

async function verify(file, meta) {
  const abs = path.join(DEST_DIR, file.dest);
  if (!fs.existsSync(abs)) return { ok: false, why: 'missing', size: 0 };
  const size = fs.statSync(abs).size;
  if (file.expectBytes && size !== file.expectBytes) return { ok: false, why: `size ${size} != ${file.expectBytes}`, size };
  const remote = meta ? meta.get(file.name) : null;
  if (remote && remote.size && size !== remote.size) return { ok: false, why: `remote size ${remote.size} != local ${size}`, size };
  if (remote && remote.sha256) {
    const sha = await hashFile(abs);
    if (sha !== remote.sha256) return { ok: false, why: `sha256 mismatch ${sha.slice(0, 16)} != ${remote.sha256.slice(0, 16)}`, size };
    return { ok: true, how: 'bytes+sha256', size };
  }
  return { ok: true, how: 'bytes', size };
}

async function main() {
  await fsp.mkdir(DEST_DIR, { recursive: true });
  log(`repo=${repo} tier=${tier}`);
  const meta = await fetchTreeMeta();
  log(meta ? 'tree API 元数据已取（含 LFS sha256）' : 'tree API 不可用：退化为字节数校验');

  let okCount = 0;
  const failures = [];
  for (const file of FILES) {
    const abs = path.join(DEST_DIR, file.dest);
    await fsp.mkdir(path.dirname(abs), { recursive: true }); // espeak-ng-data/ 子目录
    if (!force) {
      const v = await verify(file, meta);
      if (v.ok) {
        log(`skip ${file.dest} — ${v.how} check pass (${(v.size / 1048576).toFixed(1)} MB)`);
        okCount++;
        continue;
      }
      if (v.why !== 'missing') log(`re-download ${file.dest} — ${v.why}`);
    }
    const part = abs + '.part';
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      log(`download ${file.dest} (attempt ${attempt}) ...`);
      const r = await curlDownload(BASE + file.name, part);
      if (!r.ok) {
        log(`  curl failed: ${r.err.slice(0, 200)}`);
        await fsp.rm(part, { force: true });
        continue;
      }
      // 下载后立即校验，不合格自动重下（用户约定第5条）
      const tmpFile = { ...file, dest: path.basename(part) };
      const size = (await fsp.stat(part)).size;
      const remote = meta ? meta.get(file.name) : null;
      let why = '';
      if (file.expectBytes && size !== file.expectBytes) why = `size ${size} != ${file.expectBytes}`;
      else if (remote && remote.size && size !== remote.size) why = `remote size ${remote.size} != ${size}`;
      if (!why && remote && remote.sha256) {
        const sha = await hashFile(part);
        if (sha !== remote.sha256) why = 'sha256 mismatch';
      }
      if (why) {
        log(`  verify FAIL: ${why} — re-downloading`);
        await fsp.rm(part, { force: true });
        continue;
      }
      await fsp.rename(part, abs);
      done = true;
      log(`ok ${file.dest} (${(size / 1048576).toFixed(1)} MB) — ${remote && remote.sha256 ? 'bytes+sha256' : 'bytes'} pass`);
      okCount++;
    }
    if (!done) failures.push(file.dest);
  }

  // 写清单（供审计/前端校验）
  const manifest = { repo, tier, generatedAt: new Date().toISOString(), files: [] };
  for (const file of FILES) {
    const abs = path.join(DEST_DIR, file.dest);
    if (!fs.existsSync(abs)) continue;
    manifest.files.push({ file: file.dest, bytes: fs.statSync(abs).size, sha256: await hashFile(abs) });
  }
  await fsp.writeFile(path.join(DEST_DIR, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('');
  if (failures.length) {
    console.error(`结果：${okCount} 成功，失败：${failures.join(', ')}`);
    process.exit(1);
  }
  log(`全部 ${okCount} 项就位 ✓ → ${path.relative(ROOT, DEST_DIR).split(path.sep).join('/')}/`);
  log('下一步：浏览器内做 kokoro 配置 + NaN 验收探针（int8 有上游 NaN 已知 bug，见调研 §3）。');
}

main().catch((e) => {
  console.error('[kokoro] 失败：', e);
  process.exit(1);
});
