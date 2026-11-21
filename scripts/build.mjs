#!/usr/bin/env node
/**
 * build.mjs —— 零依赖构建脚本：复制源码到 dist/ + 内容哈希清单 + 部署说明
 *
 * 用法：
 *   node scripts/build.mjs                  # 常规构建（不含大体积模型/语音资源）
 *   node scripts/build.mjs --with-assets    # 连同 models/ 与 tts/ 一并复制
 *   node scripts/build.mjs --clean          # 仅清空 dist/（默认也会先清空）
 *
 * 产物：
 *   dist/index.html  dist/src/**  dist/styles/**  dist/manifest.webmanifest
 *   dist/sw.js  dist/scripts/sw-bridge.js  dist/icons/**  dist/README.md
 *   dist/server-headers.conf  dist/build-manifest.json  dist/DEPLOY.md
 *   （--with-assets 时另有 dist/models/**  dist/tts/**）
 *
 * 轻量压缩（保守、安全）：仅去除行尾空白与文件末尾多余空行；
 * 不做会破坏代码语义的压缩（不删注释、不改标识符、不合并行）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const KNOWN_ARGS = new Set(['--with-assets', '--no-clean', '--clean', '--help', '-h']);
for (const a of args) {
  if (!KNOWN_ARGS.has(a)) {
    console.error(`未知参数：${a}（可用：${[...KNOWN_ARGS].join(' ')}）`);
    process.exit(1);
  }
}
const withAssets = args.includes('--with-assets');
const noClean = args.includes('--no-clean');
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: node scripts/build.mjs [--with-assets] [--no-clean] [--clean]');
  process.exit(0);
}
if (args.includes('--clean')) {
  // 仅清空 dist/ 后退出（不执行构建）
  if (fs.existsSync(DIST)) {
    const resolved = path.resolve(DIST);
    if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) {
      console.error('安全检查失败：拒绝清理项目根之外的目录');
      process.exit(1);
    }
    fs.rmSync(DIST, { recursive: true, force: true });
    console.log('dist/ 已清空');
  } else {
    console.log('dist/ 不存在，无需清空');
  }
  process.exit(0);
}

/** 参与「轻量压缩」的文本扩展名 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.json', '.webmanifest', '.txt', '.md', '.svg', '.map']);

/** 保守压缩：去行尾空白 + 去文件尾空行（不碰注释与代码语义） */
function lightMinify(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 递归列出目录下所有文件（相对路径，POSIX 分隔符） */
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

/** 复制单个文件；文本文件做保守压缩；返回清单条目 */
async function copyOne(srcFile, destFile) {
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  const orig = await fsp.readFile(srcFile);
  const ext = path.extname(srcFile).toLowerCase();
  let buf = orig;
  let minified = false;
  if (TEXT_EXT.has(ext)) {
    const text = orig.toString('utf8');
    const next = lightMinify(text);
    if (Buffer.byteLength(next, 'utf8') !== orig.length || next !== text) minified = true;
    buf = Buffer.from(next, 'utf8');
  }
  await fsp.writeFile(destFile, buf);
  return { bytes: buf.length, minified, sha256: sha256(buf).slice(0, 16) };
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();

  if (!noClean && fs.existsSync(DIST)) {
    // 安全检查：只删除项目根下的 dist/
    const real = fs.realpathSync(DIST);
    if (real !== path.join(ROOT, 'dist') && !real.startsWith(ROOT + path.sep)) {
      throw new Error(`拒绝清理非项目内目录: ${real}`);
    }
    await fsp.rm(DIST, { recursive: true, force: true });
  }
  await fsp.mkdir(DIST, { recursive: true });

  /** @type {Record<string,{bytes:number,minified?:boolean,sha256:string}>} */
  const manifest = {};
  let copied = 0;
  const skipped = [];

  async function add(srcFile, destFile) {
    if (!(await exists(srcFile))) {
      skipped.push(path.relative(ROOT, srcFile));
      return;
    }
    const info = await copyOne(srcFile, destFile);
    manifest[path.relative(ROOT, destFile).split(path.sep).join('/')] = info;
    copied++;
  }

  // —— 单文件 ——
  await add(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
  await add(path.join(ROOT, 'manifest.webmanifest'), path.join(DIST, 'manifest.webmanifest'));
  await add(path.join(ROOT, 'sw.js'), path.join(DIST, 'sw.js'));
  await add(path.join(ROOT, 'README.md'), path.join(DIST, 'README.md'));
  await add(path.join(ROOT, 'server-headers.conf'), path.join(DIST, 'server-headers.conf'));
  // —— 合规声明（分发必附，见 THIRD_PARTY_LICENSES.md §5）——
  await add(path.join(ROOT, 'THIRD_PARTY_LICENSES.md'), path.join(DIST, 'THIRD_PARTY_LICENSES.md'));
  await add(path.join(ROOT, 'NOTICE'), path.join(DIST, 'NOTICE'));
  const licDir = path.join(ROOT, 'licenses');
  if (await exists(licDir)) {
    for (const rel of await walk(licDir)) {
      await add(path.join(licDir, rel), path.join(DIST, 'licenses', rel));
    }
  } else {
    skipped.push('licenses/');
  }
  // SW 桥接脚本：URL 必须保持 /scripts/sw-bridge.js（sw.js 预缓存列表按此书写）
  await add(path.join(ROOT, 'scripts', 'sw-bridge.js'), path.join(DIST, 'scripts', 'sw-bridge.js'));

  // —— 目录 ——
  for (const dir of ['src', 'styles', 'icons']) {
    const srcDir = path.join(ROOT, dir);
    if (!(await exists(srcDir))) {
      skipped.push(dir + '/');
      continue;
    }
    const files = await walk(srcDir);
    if (!files.length) {
      skipped.push(dir + '/ (空)');
      continue;
    }
    for (const rel of files) {
      const info = await copyOne(path.join(srcDir, rel), path.join(DIST, dir, rel));
      manifest[`dist/${dir}/${rel}`] = info;
      copied++;
    }
  }

  // —— 可选：大体积模型与 TTS 运行时 ——
  if (withAssets) {
    // models/kokoro/（~170MB，尚未接入适配器）默认不进 dist，防止误传上站；
    // 接入 kokoro 引擎后用 --with-kokoro 显式带上（超限文件由 deploy-cloudflare 切块）。
    const withKokoro = args.includes('--with-kokoro');
    for (const dir of ['models', 'tts']) {
      const srcDir = path.join(ROOT, dir);
      if (!(await exists(srcDir))) {
        skipped.push(`${dir}/ (--with-assets 但目录不存在)`);
        continue;
      }
      let files = await walk(srcDir);
      if (dir === 'models' && !withKokoro) {
        const before = files.length;
        files = files.filter((f) => !f.startsWith('kokoro/'));
        if (before !== files.length) skipped.push(`models/kokoro/ (${before - files.length} 个文件，加 --with-kokoro 才包含)`);
      }
      for (const rel of files) {
        const info = await copyOne(path.join(srcDir, rel), path.join(DIST, dir, rel));
        manifest[`dist/${dir}/${rel}`] = info;
        copied++;
      }
      console.log(`  + ${dir}/ (${files.length} 个文件)`);
    }
  } else {
    console.log('  · models/ 与 tts/ 未复制（加 --with-assets 包含，或按 DEPLOY.md 手动放置）');
  }

  // —— 从 sw.js 读取缓存版本，写入清单 ——
  let cacheVersion = 'unknown';
  try {
    const swText = await fsp.readFile(path.join(DIST, 'sw.js'), 'utf8');
    const m = /const\s+CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(swText);
    if (m) cacheVersion = m[1];
  } catch {
    /* 忽略 */
  }

  // —— 部署说明（先写盘并入清单，再序列化清单：fileCount 与实际文件数一致）——
  const deploy = buildDeployDoc(cacheVersion, withAssets);
  await fsp.writeFile(path.join(DIST, 'DEPLOY.md'), deploy, 'utf8');
  console.log('  + DEPLOY.md');
  const deployBuf = Buffer.from(deploy, 'utf8');
  manifest['dist/DEPLOY.md'] = { bytes: deployBuf.length, sha256: sha256(deployBuf).slice(0, 16) };
  // 清单自身的条目：内容包含自身哈希会自指，故 sha256/bytes 置 null（自洽由外部校验消费）
  manifest['dist/build-manifest.json'] = { bytes: null, sha256: null, self: true };

  const buildManifest = {
    name: 'tinttxt-build',
    builtAt: new Date().toISOString(),
    cacheVersion,
    withAssets,
    fileCount: Object.keys(manifest).length,
    files: manifest,
  };
  const bmBuf = Buffer.from(JSON.stringify(buildManifest, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(DIST, 'build-manifest.json'), bmBuf);

  console.log('');
  console.log(`构建完成：dist/ — ${copied} 个文件，耗时 ${Date.now() - t0}ms`);
  console.log(`  清单: dist/build-manifest.json（cacheVersion=${cacheVersion}）`);
  if (skipped.length) console.log(`  跳过（源不存在）: ${skipped.join(', ')}`);
}

function buildDeployDoc(cacheVersion, withAssets) {
  return `# TintTXT 部署说明（dist/）

构建时间：${new Date().toISOString()}
SW 缓存版本：\`${cacheVersion}\`
包含大文件资源：${withAssets ? '是（models/ + tts/）' : '否（需手动放置，见下）'}

## 0. Cloudflare Pages 一键部署

\`\`\`bash
node scripts/deploy-cloudflare.mjs          # 构建 + 切块 + _headers + 上传
node scripts/deploy-cloudflare.mjs --dry-run
\`\`\`

Cloudflare Pages 单文件上限 **25 MiB**：脚本会把超限模型在 dist/ 切成
\`.p0/.p1…\` 分片并生成 \`/asset-chunks.json\`，前端 \`asset-chunks.js\` 自动拼装；
同时写入 \`_headers\`（COOP/COEP 等）与 \`404.html\`。详见 README §1.4。

## 1. 目录结构

\`\`\`
dist/
├── index.html              # 应用壳（主工程产出）
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # Service Worker（缓存版本 ${cacheVersion}）
├── scripts/sw-bridge.js    # SW ↔ 页面 事件桥
├── src/  styles/  icons/   # 源码 / 样式 / 图标
├── models/                 # Piper 中文模型（若未随包，手动放置，见下）
├── tts/                    # TTS 运行时（onnxruntime wasm + piper_phonemize + piper-runtime.js）
├── server-headers.conf     # nginx 配置示例（含全部必需响应头）
├── build-manifest.json     # 内容哈希清单（sha256 前 16 位）
└── DEPLOY.md               # 本文件
\`\`\`

## 2. 必需响应头（否则多线程 TTS 不可用）

| 头 | 值 | 原因 |
| --- | --- | --- |
| \`Cross-Origin-Opener-Policy\` | \`same-origin\` | 与下一条一起启用 SharedArrayBuffer |
| \`Cross-Origin-Embedder-Policy\` | \`credentialless\` | 保持 crossOriginIsolated（piper 多线程），同时放行百度统计等不带 CORP 的跨域资源；旧浏览器不识别 → 不隔离 → piper 降级单线程 |
| \`Cross-Origin-Resource-Policy\` | \`same-origin\` | 配合 COEP，防止跨源资源被降级 |
| \`Permissions-Policy\` | 见 server-headers.conf | 不得禁用本应用所需能力 |

- 页面可用 \`crossOriginIsolated\` 检测；为 false 时 TTS 层应把 numThreads 降为 1
  （piper-runtime.js 已内置该降级），UI 侧建议提示「已降级为单线程合成」。
- 完整 nginx 示例见 \`server-headers.conf\`（复制到 nginx conf.d/ 并按域名修改）。

## 3. HTTPS 硬要求

Service Worker、MediaSession、Wake Lock、剪贴板等 API 仅在
**HTTPS 或 localhost** 下可用：

- 境内服务器：用 Let's Encrypt / 各云厂商免费证书，开启 HTTP/2（或 HTTP/3）；
- 内网调试：\`node scripts/dev-server.mjs\` 已带 COOP/COEP，localhost 即可；
- 华为浏览器「添加到桌面」可能只生成网址快捷方式（不走 manifest/SW）——
  属浏览器行为，SW 仅为渐进增强，核心功能（解析/合成/播放/离线存储）不依赖它。

## 4. 模型与 TTS 资源放置

本地一键下载（国内镜像，可断点续传 + 校验）：

\`\`\`bash
node scripts/fetch-tts-assets.mjs          # 下载到项目根 models/ 与 tts/
node scripts/build.mjs --with-assets       # 再整体打进 dist/
\`\`\`

若手动放置，路径必须与代码中的自托管路径一致：

\`\`\`
/models/zh_CN-huayan-medium.onnx            (63,201,294 字节)
/models/zh_CN-huayan-medium.onnx.json
/models/zh_CN-huayan-x_low.onnx             (20,628,813 字节)
/models/zh_CN-huayan-x_low.onnx.json
/tts/piper-runtime.js                       # PiperTTS 适配层（fetch-tts-assets.mjs 生成）
/tts/ort.wasm.min.js  /tts/ort-wasm-simd*.wasm  /tts/ort.wasm.wasm
/tts/piper_phonemize.js  /tts/piper_phonemize.wasm  /tts/piper_phonemize.data
\`\`\`

## 5. 缓存策略（对应 sw.js）

| 路径 | 策略 | 说明 |
| --- | --- | --- |
| 导航（HTML） | network-first，失败回退 \`/index.html\` | 断网可打开应用壳 |
| \`/src/ /styles/ /icons/\` | stale-while-revalidate | 先回缓存、后台更新 |
| \`/models/ /tts/\` | cache-first | 大文件命中即返回，避免重复下载 |
| 其他同源 GET | network-first + 缓存兜底 | |
| 跨域请求 | 不拦截（pass-through） | |

- 升级 SW：改 \`sw.js\` 里的 \`CACHE_VERSION\`（当前 \`${cacheVersion}\`），
  activate 会删除旧版本缓存；页面收到 \`__SW_UPDATE__\` 事件后提示刷新。
- 模型层另有 \`tinttxt-tts-v1\` Cache Storage（应用层自己管理），
  与 SW 缓存互为兜底；若配额紧张，删除其一即可。

## 6. gzip / brotli 注意

- **不要 gzip \`application/wasm\`**（\`ort-wasm*.wasm\`、\`piper_phonemize.wasm\`）：
  浏览器要求 wasm 以 \`application/wasm\` 类型 + 正确压缩才走流式编译；
  nginx 示例已对 wasm 关闭 gzip。若启用 brotli，同样跳过 wasm 与 onnx。
- \`*.onnx\`（20–63MB）建议直接关闭压缩（收益低、CPU 开销大），
  靠长缓存 + HTTP/2 多路复用即可。

## 7. 上线自检

1. \`curl -I https://域名/\` → 确认 COOP/COEP 存在；
2. 打开页面 → DevTools Console 执行 \`crossOriginIsolated\` 应为 \`true\`；
3. \`navigator.serviceWorker.getRegistration()\` 存在（安全上下文下）；
4. 断网刷新 → 应用壳可打开，已缓存模型可继续合成；
5. 离线场景下 \`/models/*.onnx\` 首次必须联网下载完成。
`;
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exit(1);
});
