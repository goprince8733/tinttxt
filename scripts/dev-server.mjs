#!/usr/bin/env node
/**
 * dev-server.mjs —— 零依赖 Node 静态开发服务器（含 COOP/COEP 头）
 *
 * 用法：
 *   node scripts/dev-server.mjs                 # 默认 8080 端口，监听文件变化
 *   node scripts/dev-server.mjs --port 9000
 *   node scripts/dev-server.mjs --no-watch      # 关闭文件变化监听
 *   node scripts/dev-server.mjs --root <目录>   # 指定静态根（默认项目根）
 *
 * 关键响应头（多线程 WASM / SharedArrayBuffer 必需）：
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: credentialless（放行百度统计等跨域资源，保持隔离）
 *   Cross-Origin-Resource-Policy: same-origin
 * 另有 Permissions-Policy（不限制本应用所需能力）、Cache-Control、nosniff。
 *
 * 其他能力：MIME 覆盖、路径穿越防护、SPA fallback（无扩展名路径回 index.html）、
 * Range 请求（大文件/音频可拖动）、HEAD、局域网 IP 提示（手机真机调试）。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let port = 8080;
let watch = true;
let root = DEFAULT_ROOT;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' || a === '-p') {
    const v = Number(args[++i]);
    if (!Number.isInteger(v) || v < 0 || v > 65535) {
      console.error('无效端口：', args[i]);
      process.exit(1);
    }
    port = v;
  } else if (a.startsWith('--port=')) {
    port = Number(a.slice(7));
  } else if (a === '--no-watch') {
    watch = false;
  } else if (a === '--root') {
    root = path.resolve(args[++i]);
  } else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/dev-server.mjs [--port 8080] [--no-watch] [--root <目录>]');
    process.exit(0);
  } else {
    console.error('未知参数：', a, '（--help 查看用法）');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// MIME 表
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// 固定响应头
// ---------------------------------------------------------------------------
function baseHeaders(reqPath, isHtml) {
  const headers = {
    // —— SharedArrayBuffer / 多线程 WASM 必需 ——
    'Cross-Origin-Opener-Policy': 'same-origin',
    // credentialless（≠ require-corp）：允许加载不带 CORP 的跨域资源（百度统计 hm.js/信标），
    // 同时保持 crossOriginIsolated=true；旧浏览器不识别该值 → 不隔离 → piper 优雅降级单线程。
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // —— 不限制本应用所需能力（权限策略仅示例收敛，避免影响 TTS/播放）——
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=(), autoplay=(self)',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (isHtml) {
    headers['Cache-Control'] = 'no-cache'; // html 不缓存，保证 SW/资源更新即时生效
  } else if (reqPath.startsWith('/models/') || reqPath.startsWith('/tts/')) {
    headers['Cache-Control'] = 'public, max-age=86400'; // 大文件可长缓存
  } else {
    headers['Cache-Control'] = 'public, max-age=300'; // 其余资源短缓存（开发期可感知变更）
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------
const ROOT_REAL = fs.realpathSync(root);

/** 路径穿越防护：normalize 后必须仍在静态根内 */
function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  // 去掉查询串/hash 已由 URL 处理；这里再防反斜杠绕过
  decoded = decoded.replace(/\\/g, '/');
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(ROOT_REAL, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  const rel = path.relative(ROOT_REAL, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 越界
  return abs;
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function sendFile(req, res, filePath, reqPath, stat) {
  const isHtml = /\.html?$/i.test(filePath);
  const headers = baseHeaders(reqPath, isHtml);
  headers['Content-Type'] = mimeFor(filePath);

  const range = req.headers.range;
  // Range 支持（大文件拖动 / 音频 seek；单区间即可）
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : null;
      const end = m[2] ? parseInt(m[2], 10) : null;
      if (start !== null && (end === null || end >= start) && start < stat.size) {
        const realEnd = end === null || end >= stat.size ? stat.size - 1 : end;
        headers['Content-Range'] = `bytes ${start}-${realEnd}/${stat.size}`;
        headers['Accept-Ranges'] = 'bytes';
        headers['Content-Length'] = realEnd - start + 1;
        res.writeHead(206, headers);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(filePath, { start, end: realEnd }).pipe(res);
        return;
      }
    }
    // 不合法的 Range：按 200 处理
  }

  headers['Content-Length'] = stat.size;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, baseHeaders(reqPath, false));
    res.end('500 Read Error');
  });
  stream.pipe(res);
}

function sendBuffer(res, status, reqPath, body, type) {
  const headers = baseHeaders(reqPath, type === 'text/html; charset=utf-8');
  headers['Content-Type'] = type;
  headers['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...baseHeaders('/', false) });
      res.end('405 Method Not Allowed');
      return;
    }

    const u = new URL(req.url, 'http://localhost');
    let pathname = u.pathname;
    if (pathname.endsWith('/') ) pathname += 'index.html';

    let filePath = resolveSafe(pathname);
    if (!filePath) {
      sendBuffer(res, 403, pathname, '403 Forbidden', 'text/plain; charset=utf-8');
      return;
    }

    let stat = await statOrNull(filePath);
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await statOrNull(filePath);
    }

    if (stat && stat.isFile()) {
      sendFile(req, res, filePath, pathname, stat);
      return;
    }

    // SPA fallback：非文件路径且无扩展名 → index.html
    const ext = path.extname(pathname);
    if (!ext) {
      const idx = path.join(ROOT_REAL, 'index.html');
      const idxStat = await statOrNull(idx);
      if (idxStat && idxStat.isFile()) {
        sendFile(req, res, idx, pathname, idxStat);
        return;
      }
      sendBuffer(
        res,
        404,
        pathname,
        '404 Not Found（index.html 尚未生成 —— 请先由主工程产出根目录 index.html）',
        'text/plain; charset=utf-8'
      );
      return;
    }

    sendBuffer(res, 404, pathname, `404 Not Found: ${pathname}`, 'text/plain; charset=utf-8');
  } catch (err) {
    console.error('[dev-server] 处理请求出错：', err);
    try {
      res.writeHead(500, baseHeaders('/', false));
      res.end('500 Internal Server Error');
    } catch {
      /* headers 已发出 */
    }
  }
});

// ---------------------------------------------------------------------------
// 文件变化监听（简单 mtime 扫描，无 websocket）
// ---------------------------------------------------------------------------
const WATCH_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.tooling', '.acl-recovery', 'dist', 'models', 'tts']);
let mtimes = new Map();

function scanMtimes(dir, out = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (WATCH_EXCLUDE_DIRS.has(e.name)) continue;
      scanMtimes(full, out);
    } else if (e.isFile()) {
      try {
        out.set(full, fs.statSync(full).mtimeMs);
      } catch {
        /* 竞争删除：忽略 */
      }
    }
  }
  return out;
}

let watchTimer = null;
function startWatch() {
  mtimes = scanMtimes(ROOT_REAL);
  console.log(`[watch] 已启动 mtime 扫描（间隔 1500ms，排除 ${[...WATCH_EXCLUDE_DIRS].join(', ')}）`);
  watchTimer = setInterval(() => {
    const next = scanMtimes(ROOT_REAL);
    const changed = [];
    for (const [f, t] of next) {
      if (mtimes.get(f) !== t) changed.push(f);
    }
    for (const f of mtimes.keys()) {
      if (!next.has(f)) changed.push(f + ' (删除)');
    }
    mtimes = next;
    for (const c of changed) {
      console.log(`[watch] 变更: ${path.relative(ROOT_REAL, c)}`);
    }
  }, 1500);
}

// ---------------------------------------------------------------------------
// 启动 + URL 提示
// ---------------------------------------------------------------------------
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ip of ifaces[name] || []) {
      if (ip.family === 'IPv4' && !ip.internal) out.push({ name, address: ip.address });
    }
  }
  return out;
}

server.listen(port, '0.0.0.0', () => {
  const actual = server.address().port;
  console.log('');
  console.log('  TintTXT 开发服务器（零依赖，COOP/COEP 已启用）');
  console.log('  ────────────────────────────────────────────');
  console.log(`  本机访问:   http://localhost:${actual}/`);
  console.log(`  回环访问:   http://127.0.0.1:${actual}/`);
  const lan = lanAddresses();
  if (lan.length) {
    for (const { name, address } of lan) {
      console.log(`  局域网访问: http://${address}:${actual}/   (${name})  ← 手机真机调试`);
    }
    console.log('  提示: 手机与电脑需同一 Wi-Fi；SW/MediaSession/WakeLock 仅在');
    console.log('        HTTPS 或 localhost 下可用，局域网 IP 下请用 chrome://flags 或');
    console.log('        自签证书，核心功能不依赖 SW。');
  } else {
    console.log('  未发现局域网 IPv4 地址。');
  }
  console.log(`  静态根:     ${ROOT_REAL}`);
  console.log(`  文件监听:   ${watch ? '开（--no-watch 关闭）' : '关'}`);
  console.log('');

  if (watch) startWatch();
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，换一个：node scripts/dev-server.mjs --port ${port + 1}`);
  } else {
    console.error('[dev-server] 启动失败：', err);
  }
  process.exit(1);
});

function shutdown() {
  if (watchTimer) clearInterval(watchTimer);
  server.close(() => process.exit(0));
  // 兜底：2s 后强制退出
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
