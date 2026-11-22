#!/usr/bin/env node
/**
 * deploy-cloudflare.mjs —— 把 TintTXT 一键部署到 Cloudflare Pages（你的 CF 账户）
 *
 * 用法：
 *   node scripts/deploy-cloudflare.mjs                 # 构建 + 切块 + 写 _headers + 上传
 *   node scripts/deploy-cloudflare.mjs --no-build      # 复用现有 dist/（只切块+上传）
 *   node scripts/deploy-cloudflare.mjs --dry-run       # 只做本地处理，不上传
 *   node scripts/deploy-cloudflare.mjs --project NAME  # 换项目名（默认 tinttxt）
 *
 * 做了四件事（对应 Cloudflare Pages 的硬约束）：
 *   1. `build.mjs --with-assets` 产出完整 dist/（含 models/ 与 tts/）；
 *   2. **切块**：Pages 单文件上限 25 MiB，而 TTS 模型 39.9MB / 63.2MB 超限 ——
 *      超过 20 MiB 的文件在 dist/ 里切成 `<file>.p0/.p1/…` 并生成站点根
 *      `/asset-chunks.json`；前端 `src/layers/playback/tts/asset-chunks.js`
 *      下载时按清单拼装（本地 dev 不生成清单 → 走原路径，互不影响）；
 *   3. 写 `_headers`：COOP/COEP 等必需响应头（多线程 WASM / SharedArrayBuffer）；
 *   4. `wrangler pages deploy` 上传（需 Node ≥22，脚本会自动找 .tooling 里的）。
 *
 * 凭据：优先环境变量 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，
 *       否则读 `../.credentials.yaml`（workbuddy 统一凭据，CF_TOKEN / CF_ACCOUNT）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const CREDENTIALS = path.resolve(ROOT, '..', '.credentials.yaml');

/** 切块阈值与分片大小：20 MiB（平台上限 25 MiB，留 5 MiB 余量）。 */
const CHUNK_SIZE = 20 * 1024 * 1024;
/** Cloudflare Pages / Workers 单文件硬上限：25 MiB。 */
const HARD_LIMIT = 25 * 1024 * 1024;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const dryRun = has('--dry-run');
const noBuild = has('--no-build');
const projectIdx = args.indexOf('--project');
const PROJECT = projectIdx >= 0 && args[projectIdx + 1] ? args[projectIdx + 1] : 'tinttxt';

if (has('--help') || has('-h')) {
  console.log('用法: node scripts/deploy-cloudflare.mjs [--no-build] [--dry-run] [--project NAME]');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`[deploy] ${msg}`);
}

/** 递归列出目录下所有文件（相对路径，POSIX 分隔符）。 */
async function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    p.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    p.on('error', (e) => resolve({ code: -1, out: out + String(e) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

// ---------------------------------------------------------------------------
// 1) 凭据
// ---------------------------------------------------------------------------
function loadCredentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  if (token && account) return { token, account };
  if (!fs.existsSync(CREDENTIALS)) {
    throw new Error(`未找到凭据：${CREDENTIALS}（或设置 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）`);
  }
  const text = fs.readFileSync(CREDENTIALS, 'utf8');
  const pick = (key) => (new RegExp(`${key}:\\s*"([^"]+)"`).exec(text) || [])[1] || '';
  const t = token || pick('CF_TOKEN');
  const a = account || pick('CF_ACCOUNT');
  if (!t || !a) throw new Error(`${CREDENTIALS} 里缺少 CF_TOKEN / CF_ACCOUNT`);
  return { token: t, account: a };
}

// ---------------------------------------------------------------------------
// 2) 运行时定位（wrangler 4.x 要求 Node ≥22；本机默认 Node 在 .tooling 里）
// ---------------------------------------------------------------------------
async function findNode22() {
  const tooling = path.join(ROOT, '.tooling');
  let names = [];
  try {
    names = fs.readdirSync(tooling);
  } catch {
    names = [];
  }
  const candidates = names
    .filter((n) => /^node-v(\d+)\..*win-x64$/.test(n) && Number(/^node-v(\d+)\./.exec(n)[1]) >= 22)
    .map((n) => path.join(tooling, n, 'node.exe'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function findWranglerJs() {
  const candidates = [
    path.resolve(ROOT, '..', '.tools', 'cf', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    path.resolve(ROOT, '..', '.tools', 'cf', 'node_modules', 'wrangler', 'bin', 'cf-wrangler.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('未找到 wrangler（期望 ../.tools/cf/node_modules/wrangler）');
}

// ---------------------------------------------------------------------------
// 3) 构建
// ---------------------------------------------------------------------------
async function build() {
  log('构建 dist/（build.mjs --with-assets）…');
  const r = await run(process.execPath, [path.join(HERE, 'build.mjs'), '--with-assets'], { cwd: ROOT });
  if (r.code !== 0) throw new Error(`构建失败（exit ${r.code}）`);
}

// ---------------------------------------------------------------------------
// 4) 切块 + _headers + 清单
// ---------------------------------------------------------------------------
const HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=(), autoplay=(self)
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: SAMEORIGIN

/
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache

/asset-chunks.json
  Cache-Control: no-cache

/manifest.webmanifest
  Content-Type: application/manifest+json; charset=utf-8
  Cache-Control: no-cache

/models/*
  Cache-Control: public, max-age=2592000

/tts/*
  Cache-Control: public, max-age=2592000

/src/*
  Cache-Control: public, max-age=300

/styles/*
  Cache-Control: public, max-age=300

/icons/*
  Cache-Control: public, max-age=604800
`;

/** 缺失资源的 404 页（无外链、无脚本，COEP 下也不会有子资源问题）。 */
const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>404 · 蝈蝈听书</title>
  <style>
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #0f1216; color: #e6edf3; font: 16px/1.7 system-ui, sans-serif; text-align: center; }
    a { color: #6cb6ff; }
    code { color: #9aa7b4; }
  </style>
</head>
<body>
  <main>
    <h1>404</h1>
    <p>资源不存在，或该文件已被分块部署（<code>*.onnx.p0/.p1…</code>）。</p>
    <p><a href="/">返回蝈蝈听书首页</a></p>
  </main>
</body>
</html>
`;

/** @type {Record<string,{bytes:number,parts:string[],partBytes:number[]}>} */
const chunkFiles = {};

async function splitOversized() {
  const files = await walk(DIST);
  let splitCount = 0;
  for (const rel of files) {
    if (rel === 'asset-chunks.json' || rel === '_headers') continue;
    const abs = path.join(DIST, rel);
    const { size } = await fsp.stat(abs);
    if (size <= CHUNK_SIZE) continue;

    const buf = await fsp.readFile(abs);
    const parts = [];
    const partBytes = [];
    for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
      const slice = buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.length));
      const partRel = `${rel}.p${parts.length}`;
      await fsp.writeFile(path.join(DIST, partRel), slice);
      parts.push('/' + partRel);
      partBytes.push(slice.length);
    }
    await fsp.unlink(abs); // 原整文件必须删除：超限文件上传会被平台直接拒绝
    chunkFiles['/' + rel] = { bytes: buf.length, parts, partBytes };
    splitCount++;
    log(`  切块 ${rel}：${buf.length} 字节 → ${parts.length} 片（每片 ≤ ${CHUNK_SIZE}）`);
  }
  if (splitCount) log(`共切块 ${splitCount} 个文件`);
}

async function writeSupportFiles() {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chunkSize: CHUNK_SIZE,
    files: chunkFiles,
  };
  await fsp.writeFile(path.join(DIST, 'asset-chunks.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(DIST, '_headers'), HEADERS, 'utf8');
  // 404.html：Cloudflare Pages 对不存在的路径默认返回 200 + index.html（SPA 兜底），
  // 会把「模型分片缺失」伪装成成功响应 → 前端虽有 Content-Type 兜底，这里再从
  // 服务端给一次干净的 404（本应用路由是 hash 路由，不受影响）。
  await fsp.writeFile(path.join(DIST, '404.html'), NOT_FOUND_HTML, 'utf8');
  log('已写入 _headers、asset-chunks.json 与 404.html');

  // 终检：任何文件都不得超平台上限
  const files = await walk(DIST);
  let maxFile = { rel: '', size: 0 };
  for (const rel of files) {
    const { size } = await fsp.stat(path.join(DIST, rel));
    if (size > maxFile.size) maxFile = { rel, size };
    if (size > HARD_LIMIT) throw new Error(`超限文件未处理：${rel} = ${size} 字节（> ${HARD_LIMIT}）`);
  }
  const total = files.reduce((s, rel) => s + fs.statSync(path.join(DIST, rel)).size, 0);
  log(`dist/ 检查通过：${files.length} 个文件，共 ${(total / 1024 / 1024).toFixed(1)} MiB，最大 ${maxFile.rel}（${(maxFile.size / 1024 / 1024).toFixed(1)} MiB）`);
}

// ---------------------------------------------------------------------------
// 5) 上传
// ---------------------------------------------------------------------------
async function deploy(creds) {
  const node22 = await findNode22();
  const wranglerJs = findWranglerJs();
  if (!node22) {
    throw new Error('未找到 Node ≥22（期望 .tooling/node-v22*-win-x64/node.exe）—— wrangler 4.x 硬性要求');
  }
  log(`node: ${node22}`);
  log(`wrangler: ${wranglerJs}`);

  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: creds.token,
    CLOUDFLARE_ACCOUNT_ID: creds.account,
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true',
  };
  const wr = (extra) => run(node22, [wranglerJs, ...extra], { cwd: ROOT, env });

  // 5.1 项目不存在则创建（已存在 → 忽略报错继续）
  log(`确保 Pages 项目存在：${PROJECT}`);
  const created = await wr(['pages', 'project', 'create', PROJECT, '--production-branch=main']);
  if (created.code !== 0 && !/already exists|already_exists/i.test(created.out)) {
    throw new Error(`创建 Pages 项目失败（exit ${created.code}）：\n${created.out}`);
  }

  // 5.2 上传 dist/（含 Pages Functions：复制 functions/ → dist/functions/）
  log(`上传 dist/ → ${PROJECT} …`);
  const fnsSrc = path.join(ROOT, 'functions');
  const fnsDst = path.join(DIST, 'functions');
  if (fs.existsSync(fnsSrc)) {
    await fsp.rm(fnsDst, { recursive: true, force: true });
    await fsp.cp(fnsSrc, fnsDst, { recursive: true });
    log('已复制 functions/ → dist/functions/（Pages Functions 云端 TTS API）');
  }
  const up = await wr(['pages', 'deploy', DIST, '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true']);
  if (up.code !== 0) throw new Error(`部署失败（exit ${up.code}）`);

  const url = `https://${PROJECT}.pages.dev`;
  log(`部署完成：${url}`);
  return url;
}

// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const creds = loadCredentials();
  log(`账户 ${creds.account}，项目 ${PROJECT}${dryRun ? '（dry-run，不上传）' : ''}`);

  if (!noBuild) await build();
  else log('跳过构建（--no-build）');

  await splitOversized();
  await writeSupportFiles();

  let url = '';
  if (dryRun) {
    log('dry-run 结束（未上传）');
  } else {
    url = await deploy(creds);
  }
  log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (url) console.log(`\n✅ ${url}\n`);
}

main().catch((err) => {
  console.error('[deploy] 失败：', err && err.message ? err.message : err);
  process.exit(1);
});
