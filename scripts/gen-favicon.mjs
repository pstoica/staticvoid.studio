// Regenerate public/favicon.png — the still "rest" frame of the animated favicon
// in index.html: a 4x4 grid of round dots in a diagonal oklch rainbow. The
// runtime version sends raindrop rings across the grid while the tab is visible;
// this committed frame is what shows on first paint, in link unfurls, and in
// background tabs. Keep the constants in sync with index.html.
//
//   node scripts/gen-favicon.mjs        (also: npm run favicon)
//
// Zero dependencies: rasterizes antialiased circles into a buffer and encodes a
// PNG by hand via the built-in zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N = 64, M = 4, CELL = N / M;
const R_REST = CELL * 0.27, R_PEAK = CELL * 0.48;
const A = 0.55;                                      // rest amplitude (matches draw(null))

// oklch -> linear sRGB -> gamma-encoded 0..255 (clamped)
function oklchToRgb(L, C, hDeg) {
  const h = hDeg * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return lin.map(v => {
    v = Math.max(0, Math.min(1, v));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  });
}

const dots = [];
for (let y = 0; y < M; y++)
  for (let x = 0; x < M; x++) {
    const hue = ((x + y) * 45 + 330 + A * 50) % 360;
    dots.push({
      cx: (x + 0.5) * CELL, cy: (y + 0.5) * CELL,
      r: R_REST + (R_PEAK - R_REST) * A,
      rgb: oklchToRgb(0.85, 0.17, hue),
      alpha: 0.3 + 0.7 * A,
    });
  }

const buf = Buffer.alloc(N * N * 4);
for (let py = 0; py < N; py++)
  for (let px = 0; px < N; px++) {
    const x = px + 0.5, y = py + 0.5;
    for (const d of dots) {
      const cov = Math.max(0, Math.min(1, d.r - Math.hypot(x - d.cx, y - d.cy) + 0.5));
      if (cov <= 0) continue;
      const i = (py * N + px) * 4;                   // dots never overlap: write directly
      buf[i] = Math.round(d.rgb[0]); buf[i + 1] = Math.round(d.rgb[1]);
      buf[i + 2] = Math.round(d.rgb[2]); buf[i + 3] = Math.round(255 * d.alpha * cov);
    }
  }

// --- minimal PNG encoder (RGBA, no filter) ---
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit, RGBA
const raw = Buffer.alloc(N * (N * 4 + 1));       // +1 filter byte per row
for (let y = 0; y < N; y++) buf.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = fileURLToPath(new URL('../public/favicon.png', import.meta.url));
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${N}x${N})`);
