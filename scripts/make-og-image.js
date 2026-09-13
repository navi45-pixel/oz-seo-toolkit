#!/usr/bin/env node
'use strict';
/**
 * make-og-image.js — generate public/og-image.png (1200x630) with zero
 * dependencies: raw RGB pixel buffer -> zlib deflate -> PNG chunks (CRC32).
 *
 * Design: the site's dark-green radial gradient, the green "Oz" badge,
 * "OZSEO TOOLKIT" wordmark and a subline, all rendered with a built-in
 * 5x7 bitmap font scaled up. Re-run after brand changes: node scripts/make-og-image.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 1200, H = 630;
const buf = Buffer.alloc(W * H * 3);

/* ---------- colour helpers (matching the site palette) ---------- */
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex('#0a1210'), BG_GLOW = hex('#14352a'), PANEL = hex('#12211c');
const GREEN = hex('#2fd57b'), GREEN_DARK = hex('#149a5b'), GOLD = hex('#f5c542'), TEXT = hex('#e8f3ee');
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

function setPx(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
}
function fillRect(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(x, y, c);
}
function fillRoundRect(x0, y0, w, h, r, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const dx = Math.max(x0 + r - x, x - (x0 + w - 1 - r), 0);
    const dy = Math.max(y0 + r - y, y - (y0 + h - 1 - r), 0);
    if (dx * dx + dy * dy <= r * r) setPx(x, y, c);
  }
}

/* ---------- background: radial gradient like the site ---------- */
const CX = W * 0.8, CY = -H * 0.1, RAD = W;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - CX, y - CY) / RAD;
    setPx(x, y, mix(BG_GLOW, BG, Math.min(d, 1)));
  }
}

/* ---------- 5x7 bitmap font (A-Z, space, dash, bullet, dot) ---------- */
const FONT = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01110','10001','10000','10000','10000','10001','01110'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  G: ['01110','10001','10000','10111','10001','10001','01110'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  W: ['10001','10001','10001','10101','10101','11011','10001'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '-': ['00000','00000','00000','01110','00000','00000','00000'],
  '.': ['00000','00000','00000','00000','00000','01100','01100'],
};
function drawText(str, x0, y0, scale, color) {
  let cx = x0;
  for (const ch of str) {
    const g = FONT[ch];
    if (g) {
      for (let ry = 0; ry < 7; ry++) for (let rx = 0; rx < 5; rx++) {
        if (g[ry][rx] === '1') fillRect(cx + rx * scale, y0 + ry * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

/* ---------- composition ---------- */
// Green "Oz" badge (site logo shape): rounded square + bitmap letters.
fillRoundRect(100, 240, 150, 150, 34, GREEN);
drawText('OZ', 125, 265, 10, BG);       // dark letters on the green badge
// Wordmark + subline (13 chars at scale 11 = 858px wide, fits from x=300)
drawText('OZSEO TOOLKIT', 300, 250, 11, TEXT);
drawText('FREE AUDITS FOR AUSTRALIA', 300, 250 + 7 * 11 + 24, 5, mix(TEXT, BG, 0.35));
// Green gradient rule (green -> gold) under the wordmark
for (let x = 300; x < 1050; x++) {
  const t = (x - 300) / 750;
  fillRect(x, 400, 1, 6, mix(GREEN, GOLD, t));
}
// Footer chips panel, like the site's card style
fillRoundRect(300, 470, 700, 80, 18, PANEL);
drawText('NO SIGN-UP. NO CATCH.', 330, 498, 5, GOLD);

/* ---------- PNG encode ---------- */
function crc32(bufv) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < bufv.length; i++) c = table[(c ^ bufv[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour RGB
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0; // filter: none
  buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'public', 'og-image.png');
fs.writeFileSync(out, png);
console.log(`make-og-image: wrote ${out} (${png.length} bytes, ${W}x${H})`);
