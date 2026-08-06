// packrender.js — how a drawn pack's coarse pixel grid becomes its rendered texture.
//
// Shared by the GL renderer (loom/gl/renderer.js, when a pack frame is uploaded as a
// sprite) and the draw editor's board, so what you paint on is exactly what Loom draws.
// The `mode` picks how CELLS CONNECT:
//
//   pixels    raw chunky grid — the Animal-Crossing / QR look (nearest upscale)
//   smooth    Scale2x/EPX cascaded to 8× — the classic pixel-art upscaler: diagonals
//             become clean stair-free edges while every cell keeps its exact colour.
//             (Andrea Mazzoleni's Scale2x / Eric Johnston's EPX, the reference algorithm
//             emulators use; no blur, no colour invention — unlike a blob field.)
//   rounded   a disc per cell + capsule bridges to orthogonal neighbours
//   metaball  a threshold field — cells fuse into organic blobs, diagonals included
//
// Returns a canvas (scale× the grid), ready for CanvasTexture / drawImage.
export const PACK_MODES = ['pixels', 'smooth', 'rounded', 'metaball'];

// read a frame's cells once: {S, u32} where u32[i] is the packed RGBA of cell i
function readGrid(img) {
  const S = img.width || 32;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, S, S);
  return { S, u32: new Uint32Array(data.data.buffer), bytes: data.data };
}

// ── Scale2x / EPX: one doubling pass ─────────────────────────────────────────────
// For each source pixel P, look at its 4 orthogonal neighbours (A up, C left, B right,
// D down). Where two adjacent neighbours agree and the opposite pair doesn't, that
// corner of the 2×2 output takes the neighbour's colour — which rounds a staircase into
// a diagonal. Everything else stays P, so colours are never invented or blurred.
function scale2x(src, S) {
  const out = new Uint32Array(S * 2 * S * 2), W = S * 2;
  const at = (x, y) => src[(y < 0 ? 0 : y >= S ? S - 1 : y) * S + (x < 0 ? 0 : x >= S ? S - 1 : x)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const P = src[y * S + x];
    const A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
    let e0 = P, e1 = P, e2 = P, e3 = P;
    if (C === A && C !== D && A !== B) e0 = A;
    if (A === B && A !== C && B !== D) e1 = B;
    if (D === C && D !== B && C !== A) e2 = C;
    if (B === D && B !== A && D !== C) e3 = D;
    const o = (y * 2) * W + x * 2;
    out[o] = e0; out[o + 1] = e1; out[o + W] = e2; out[o + W + 1] = e3;
  }
  return out;
}

export function renderPackFrame(img, mode, scale = 8) {
  const SC = scale;
  const { S, u32, bytes } = readGrid(img);
  const O = S * SC;
  const rc = document.createElement('canvas'); rc.width = rc.height = O;
  const ctx = rc.getContext('2d');

  if (!mode || mode === 'pixels') {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, O, O);
    return rc;
  }

  if (mode === 'smooth') {
    // cascade doublings up to the requested scale (8 → three passes), then nearest-
    // upscale whatever's left. Pure cell colours throughout: crisp at any zoom.
    let cur = u32, size = S;
    while (size * 2 <= O) { cur = scale2x(cur, size); size *= 2; }
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = size;
    const tctx = tmp.getContext('2d');
    const id = tctx.createImageData(size, size);
    new Uint32Array(id.data.buffer).set(cur);
    tctx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, O, O);
    return rc;
  }

  const d = bytes;
  const on = (x, y) => { if (x < 0 || y < 0 || x >= S || y >= S) return -1;
    const i = (y * S + x) * 4; return d[i + 3] > 8 ? i : -1; };

  if (mode === 'rounded') {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = on(x, y); if (i < 0) continue;
      ctx.fillStyle = `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3] / 255})`;
      const px = (x + 0.5) * SC, py = (y + 0.5) * SC, r = SC * 0.5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      if (on(x + 1, y) >= 0) ctx.fillRect(px, py - r, SC, r * 2);
      if (on(x, y + 1) >= 0) ctx.fillRect(px - r, py, r * 2, SC);
    }
    return rc;
  }

  // ── metaball ───────────────────────────────────────────────────────────────────
  // SPLAT, don't scan: each lit cell adds its kernel to the pixels inside its radius,
  // so cost tracks the drawing (lit cells × kernel area) instead of the canvas area —
  // that's what makes a full-resolution pass affordable on every frame.
  const R = 1.25, RPX = R * SC, T = 0.42, AA = 0.14;
  const gsum = new Float32Array(O * O), asum = new Float32Array(O * O);
  const rs = new Float32Array(O * O), gs = new Float32Array(O * O), bs = new Float32Array(O * O);
  for (let cy = 0; cy < S; cy++) for (let cx = 0; cx < S; cx++) {
    const i = on(cx, cy); if (i < 0) continue;
    const sa = d[i + 3] / 255, cr = d[i], cg = d[i + 1], cb = d[i + 2];
    const px = (cx + 0.5) * SC, py = (cy + 0.5) * SC;
    const x0 = Math.max(0, Math.ceil(px - RPX)), x1 = Math.min(O - 1, Math.floor(px + RPX));
    const y0 = Math.max(0, Math.ceil(py - RPX)), y1 = Math.min(O - 1, Math.floor(py + RPX));
    for (let oy = y0; oy <= y1; oy++) {
      const dy = (oy + 0.5 - py) / SC;
      for (let ox = x0; ox <= x1; ox++) {
        const dx = (ox + 0.5 - px) / SC;
        const q = (dx * dx + dy * dy) / (R * R);
        if (q >= 1) continue;
        const g = (1 - q) * (1 - q), w = g * sa, o = oy * O + ox;
        gsum[o] += g; asum[o] += w; rs[o] += cr * w; gs[o] += cg * w; bs[o] += cb * w;
      }
    }
  }
  const outImg = ctx.createImageData(O, O), od = outImg.data;
  for (let o = 0, p = 0; o < gsum.length; o++, p += 4) {
    const gv = gsum[o]; if (gv <= 0) continue;
    // threshold the GEOMETRIC field (shape independent of transparency), then scale by
    // the average source alpha so a 40% stroke reads 40% instead of solid
    const cov = Math.max(0, Math.min(1, (gv - T) / AA));
    if (cov <= 0) continue;
    const aw = asum[o]; if (aw <= 0) continue;
    const a = cov * (aw / gv);
    if (a <= 0.002) continue;
    od[p] = rs[o] / aw; od[p + 1] = gs[o] / aw; od[p + 2] = bs[o] / aw; od[p + 3] = a * 255;
  }
  ctx.putImageData(outImg, 0, 0);
  return rc;
}
