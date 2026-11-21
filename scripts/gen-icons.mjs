#!/usr/bin/env node
/**
 * gen-icons.mjs —— 纯 Node（零依赖）生成 PWA 图标。
 *
 * 不依赖任何外部图片/字体：手写 PNG 编码器（zlib deflate + CRC32），
 * 图标内容为「纯色圆角底 + 白色音符」的像素绘制（4×4 超采样抗锯齿）。
 *
 * 用法：
 *   node scripts/gen-icons.mjs            # 生成到 <项目根>/icons/
 *   node scripts/gen-icons.mjs --out 目录
 *
 * 产物：
 *   icons/icon-192.png / icon-512.png           —— manifest any 用途（圆角）
 *   icons/icon-maskable-192.png / -512.png      —— manifest maskable 用途（满幅底 + 内缩图形）
 *   icons/apple-touch-icon-180.png              —— iOS/Android 添加到主屏（满幅不透明）
 *   icons/favicon-32.png / favicon.ico          —— 浏览器标签页图标
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let outDir = path.join(ROOT, 'icons');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out' && argv[i + 1]) {
    outDir = path.resolve(ROOT, argv[++i]);
  } else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('用法: node scripts/gen-icons.mjs [--out <目录>]');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// PNG 编码（签名 + IHDR + IDAT + IEND，颜色类型 6 = RGBA8）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** @param {Buffer} rgba 长度必须为 w*h*4 */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// 像素绘制（4×4 超采样；设计空间为归一化 [0,1]²）
// ---------------------------------------------------------------------------
const SS = 4; // supersampling factor
const BG = [0x1a, 0x1a, 0x2e]; // theme_color #1a1a2e
const FG = [0xff, 0xff, 0xff]; // 白色音符

/** 圆角矩形（maskable 时 radius=0，满幅） */
function insideBackground(u, v, radius) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (radius <= 0) return true;
  const dx = Math.min(u, 1 - u);
  const dy = Math.min(v, 1 - v);
  if (dx >= radius || dy >= radius) return true;
  const ex = radius - dx;
  const ey = radius - dy;
  return ex * ex + ey * ey <= radius * radius;
}

/**
 * 白色八分音符（设计空间 [0,1]²，超出返回 false）。
 * 由符头（椭圆）+ 符干（矩形）+ 符尾（sqrt 曲线三角）组成。
 */
function insideNote(x, y) {
  // 符头
  const hx = (x - 0.34) / 0.30;
  const hy = (y - 0.76) / 0.21;
  if (hx * hx + hy * hy <= 1) return true;
  // 符干（贴符头右侧，向上）
  if (x >= 0.575 && x <= 0.655 && y >= 0.14 && y <= 0.78) return true;
  // 符尾（自符干顶端向右下垂的弧边三角）
  if (x >= 0.655 && y >= 0.14 && y <= 0.44) {
    const t = (y - 0.14) / 0.30; // 0..1
    const w = 0.30 * Math.sqrt(Math.max(0, 1 - t * t));
    if (x <= 0.655 + w) return true;
  }
  return false;
}

/**
 * 渲染一个图标。
 * @param {number} size 边长（px）
 * @param {{maskable?: boolean, cornerRatio?: number}} opts
 *   maskable=true：满幅不透明底、图形内缩到安全区（约 46% 边长）
 *   maskable=false：圆角底（半径 22% 边长）、图形约 64% 边长
 * @returns {Buffer} RGBA 像素
 */
function renderIcon(size, opts = {}) {
  const maskable = !!opts.maskable;
  const corner = maskable ? 0 : (opts.cornerRatio ?? 0.22);
  const glyphScale = maskable ? 0.46 : 0.64;
  const rgba = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          // 图形局部坐标：以图标中心为轴，映射到 [0,1]²
          const lx = (u - 0.5) / glyphScale + 0.5;
          const ly = (v - 0.5) / glyphScale + 0.5;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          if (insideNote(lx, ly)) {
            r = FG[0]; g = FG[1]; b = FG[2]; a = 1;
          } else if (insideBackground(u, v, corner)) {
            r = BG[0]; g = BG[1]; b = BG[2]; a = 1;
          }
          sumA += a;
          sumR += r * a;
          sumG += g * a;
          sumB += b * a;
        }
      }
      const n = SS * SS;
      const alpha = sumA / n;
      const i = (py * size + px) * 4;
      if (alpha > 0) {
        rgba[i] = Math.round(sumR / sumA);
        rgba[i + 1] = Math.round(sumG / sumA);
        rgba[i + 2] = Math.round(sumB / sumA);
        rgba[i + 3] = Math.round(alpha * 255);
      } else {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
      }
    }
  }
  return rgba;
}

/** ICO 容器（单条目，内嵌 PNG —— 现代浏览器均支持） */
function encodeICO(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12); // offset = 6 + 16
  return Buffer.concat([header, entry, pngBuffer]);
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
const TARGETS = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-192.png', size: 192, maskable: true },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon-180.png', size: 180, maskable: true },
  { name: 'favicon-32.png', size: 32, maskable: false },
];

fs.mkdirSync(outDir, { recursive: true });

const written = [];
for (const t of TARGETS) {
  const rgba = renderIcon(t.size, { maskable: t.maskable });
  const png = encodePNG(t.size, t.size, rgba);
  const file = path.join(outDir, t.name);
  fs.writeFileSync(file, png);
  written.push({ file, bytes: png.length, size: t.size, maskable: t.maskable });
}

// favicon.ico（内嵌 32px PNG）
const faviconPng = encodePNG(32, 32, renderIcon(32, { maskable: false }));
const icoFile = path.join(outDir, 'favicon.ico');
fs.writeFileSync(icoFile, encodeICO(faviconPng, 32));
written.push({ file: icoFile, bytes: icoFile.length, size: 32, maskable: false });

// 自检：PNG 签名（前 8 字节）
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
for (const w of written) {
  const buf = fs.readFileSync(w.file);
  const ok = buf.length >= 8 && SIG.every((b, i) => buf[i] === b);
  if (!ok && w.file.endsWith('.png')) {
    console.error(`✗ PNG 签名校验失败: ${w.file}`);
    process.exit(1);
  }
  const rel = path.relative(ROOT, w.file);
  console.log(`✓ ${rel}  ${w.size}x${w.size}${w.maskable ? ' maskable' : ''}  ${w.bytes} bytes`);
}

console.log(`完成：${written.length} 个图标文件 → ${path.relative(ROOT, outDir) || '.'}`);
