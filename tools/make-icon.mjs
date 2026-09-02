#!/usr/bin/env node
// 生成应用图标 assets/icon.png（1024×1024）。
// 和游戏里的美术一样，不引入任何外部素材：纯程序绘制海面 + 帆，
// 再手写 PNG 编码（zlib 来自 Node 标准库）。electron-builder 会据此派生 .icns/.ico。

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// 点在三角形内（重心坐标符号一致法）
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const SKY_TOP = [12, 38, 61];
const SKY_LOW = [38, 104, 133];
const SEA_TOP = [23, 84, 110];
const SEA_LOW = [9, 33, 51];
const SAIL = [244, 246, 242];
const SAIL_SHADE = [198, 214, 219];
const HULL = [214, 168, 74];

const HORIZON = SIZE * 0.62;
const MAST_X = SIZE * 0.40;
const MAST_TOP = SIZE * 0.15;
const BOOM_Y = SIZE * 0.695;
const CLEW_X = SIZE * 0.78;

function sample(x, y) {
  // 背景：天空到海面的两段渐变，海面叠一点波纹亮度
  let rgb;
  if (y < HORIZON) {
    rgb = mix(SKY_TOP, SKY_LOW, y / HORIZON);
  } else {
    const t = (y - HORIZON) / (SIZE - HORIZON);
    rgb = mix(SEA_TOP, SEA_LOW, t);
    const wave = Math.sin((x / SIZE) * 26 + t * 9) * Math.cos((y / SIZE) * 34);
    const lift = Math.round(wave * 10 * (1 - t));
    rgb = [rgb[0] + lift, rgb[1] + lift, rgb[2] + lift];
  }

  // 主帆：桅杆 → 帆顶 → 帆脚索，弦线略外凸表示吃风
  const luff = [MAST_X, MAST_TOP];
  const head = [MAST_X, BOOM_Y];
  const clew = [CLEW_X, BOOM_Y - SIZE * 0.03];
  if (inTriangle(x, y, luff, head, clew)) {
    const across = (x - MAST_X) / (CLEW_X - MAST_X);
    rgb = mix(SAIL, SAIL_SHADE, Math.min(1, Math.max(0, across)) * 0.85);
  }

  // 桅杆
  if (x >= MAST_X - SIZE * 0.010 && x <= MAST_X + SIZE * 0.010
    && y >= MAST_TOP - SIZE * 0.01 && y <= BOOM_Y + SIZE * 0.02) {
    rgb = [232, 236, 238];
  }

  // 船体：横躺的浅弧
  const hullY = SIZE * 0.705;
  const hullHalf = SIZE * 0.245;
  const dx = (x - SIZE * 0.50) / hullHalf;
  if (Math.abs(dx) <= 1) {
    const top = hullY - SIZE * 0.012;
    const bottom = hullY + SIZE * 0.055 * (1 - dx * dx);
    if (y >= top && y <= bottom) rgb = mix(HULL, [150, 110, 40], (y - top) / (bottom - top + 1));
  }

  return rgb;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let offset = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[offset] = 0; // 过滤器 None
  offset += 1;
  for (let x = 0; x < SIZE; x += 1) {
    const [r, g, b] = sample(x + 0.5, y + 0.5);
    // 圆角方形遮罩，避免各平台缩略图里出现生硬直角
    const radius = SIZE * 0.16;
    const cx = Math.min(Math.max(x, radius), SIZE - radius);
    const cy = Math.min(Math.max(y, radius), SIZE - radius);
    const dist = Math.hypot(x - cx, y - cy);
    const alpha = dist <= radius ? 255 : 0;
    raw[offset] = Math.min(255, Math.max(0, r));
    raw[offset + 1] = Math.min(255, Math.max(0, g));
    raw[offset + 2] = Math.min(255, Math.max(0, b));
    raw[offset + 3] = alpha;
    offset += 4;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, png);
process.stdout.write(`${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)\n`);
