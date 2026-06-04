// Regenerate public/favicon.png — a still frame of the animated favicon: a small grid
// of big pastel "pixels" with gaps between them, colored as an alternating warm/cool
// basketweave in the same palette as the runtime version in index.html. The runtime
// version is generative (Conway's Life brightens/dims each pixel); this committed frame
// is a clean, full-brightness grid for the deploy / first paint / link unfurls.
//
//   node scripts/gen-favicon.mjs        (also: npm run favicon)
//
// Zero dependencies: draws into a float buffer (tile cores + soft glow, like the
// canvas shadowBlur) and encodes a PNG by hand via the built-in zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N = 64, M = 3, CELL = N / M;
const T = 0;                    // frozen frame (seconds)
const GLOW = CELL * 0.18, GAP = 3;   // big gaps between pixels
const WARM = [350, 25, 48], COOL = [150, 200, 275];   // alternating warm / cool pastels
const hueFor = (x, y) => ((x + y) & 1 ? COOL : WARM)[((x - y) % 3 + 3) % 3] + T * 10;

function hslToRgb(h, s, l) {    // h:deg, s/l:0..1 -> [r,g,b] 0..255
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map(v => v * 255);
}

// big pastel pixels on a 3x3 grid — every pixel bright, gaps between
const tiles = [];
for (let y = 0; y < M; y++)
  for (let x = 0; x < M; x++) {
    const hue = hueFor(x, y);
    const light = 74 + 5 * Math.sin(T * 0.8 + x * 1.1 + y * 0.7);
    const [rr, gg, bb] = hslToRgb(hue, 0.85, light / 100);
    const x0 = Math.round(x * CELL) + GAP, x1 = Math.round((x + 1) * CELL) - GAP;
    const y0 = Math.round(y * CELL) + GAP, y1 = Math.round((y + 1) * CELL) - GAP;
    tiles.push({ x0, y0, x1, y1, r: rr, g: gg, b: bb });
  }

// per-pixel accumulation: opaque cores + additive (screen-ish) glow falloff
const buf = Buffer.alloc(N * N * 4);
for (let py = 0; py < N; py++) {
  for (let px = 0; px < N; px++) {
    let R = 0, G = 0, B = 0, A = 0;
    const x = px + 0.5, y = py + 0.5;
    for (const t of tiles) {
      let w;
      if (x >= t.x0 && x < t.x1 && y >= t.y0 && y < t.y1) {
        w = 1;                                          // core
      } else {
        const dx = Math.max(t.x0 - x, 0, x - t.x1);
        const dy = Math.max(t.y0 - y, 0, y - t.y1);
        w = Math.max(0, 1 - Math.hypot(dx, dy) / GLOW) ** 2 * 0.7;   // glow
      }
      if (w <= 0) continue;
      R = Math.max(R, t.r * w); G = Math.max(G, t.g * w); B = Math.max(B, t.b * w);
      A = Math.min(255, A + w * 255);
    }
    const i = (py * N + px) * 4;
    buf[i] = Math.round(R); buf[i + 1] = Math.round(G);
    buf[i + 2] = Math.round(B); buf[i + 3] = Math.round(A);
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
