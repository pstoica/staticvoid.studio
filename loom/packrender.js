// packrender.js — how a drawn pack's coarse pixel grid becomes its rendered texture.
//
// Shared by the GL renderer (loom/gl/renderer.js, when a pack frame is uploaded as a
// sprite) and the draw editor's live preview (loom/draw/), so what you see while drawing
// is exactly what Loom draws. The `mode` picks how CELLS CONNECT:
//
//   pixels    raw chunky grid — the Animal-Crossing / QR look (nearest upscale)
//   rounded   a disc per cell + capsule bridges to orthogonal neighbours (rounded QR)
//   metaball  a threshold field — adjacent AND diagonal cells fuse into organic blobs
//
// Returns a canvas (8x the grid), ready for CanvasTexture / drawImage.
export const PACK_MODES = ['pixels', 'rounded', 'metaball'];

export function renderPackFrame(img, mode, scale = 8) {
  const S = img.width || 32, SC = scale, O = S * SC;
  const rc = document.createElement('canvas'); rc.width = rc.height = O;
  const ctx = rc.getContext('2d');
  if (!mode || mode === 'pixels') {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, O, O);
    return rc;
  }
  // read the grid once
  const cc = document.createElement('canvas'); cc.width = cc.height = S;
  const cx = cc.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, S, S).data;
  const at = (x, y) => (x < 0 || y < 0 || x >= S || y >= S) ? -1 : ((y * S + x) * 4);
  const on = (x, y) => { const i = at(x, y); return i >= 0 && d[i + 3] > 8 ? i : -1; };

  if (mode === 'rounded') {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = on(x, y); if (i < 0) continue;
      ctx.fillStyle = `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3] / 255})`;
      const px = (x + 0.5) * SC, py = (y + 0.5) * SC, r = SC * 0.5;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      if (on(x + 1, y) >= 0) ctx.fillRect(px, py - r, SC, r * 2);      // bridge right
      if (on(x, y + 1) >= 0) ctx.fillRect(px - r, py, r * 2, SC);      // bridge down
    }
    return rc;
  }

  // metaball: every lit cell contributes a smooth falloff; threshold the summed field so
  // near cells MERGE (including diagonals) with soft necks, like liquid drops touching.
  const out = ctx.createImageData(O, O);
  const R = 1.25, R2 = R * R, T = 0.42, AA = 0.14;
  for (let oy = 0; oy < O; oy++) {
    const gy = (oy + 0.5) / SC;
    const y0 = Math.max(0, Math.floor(gy - R - 0.5)), y1 = Math.min(S - 1, Math.ceil(gy + R + 0.5));
    for (let ox = 0; ox < O; ox++) {
      const gx = (ox + 0.5) / SC;
      const x0 = Math.max(0, Math.floor(gx - R - 0.5)), x1 = Math.min(S - 1, Math.ceil(gx + R + 0.5));
      let field = 0, br = 0, bg = 0, bb = 0, bw = 0;
      for (let cy = y0; cy <= y1; cy++) for (let cxi = x0; cxi <= x1; cxi++) {
        const i = on(cxi, cy); if (i < 0) continue;
        const dx = gx - (cxi + 0.5), dy = gy - (cy + 0.5);
        const q = (dx * dx + dy * dy) / R2;
        if (q >= 1) continue;
        const w = (1 - q) * (1 - q) * (d[i + 3] / 255);    // smooth, compact-support kernel
        field += w; br += d[i] * w; bg += d[i + 1] * w; bb += d[i + 2] * w; bw += w;
      }
      if (bw <= 0) continue;
      const a = Math.max(0, Math.min(1, (field - T) / AA));
      if (a <= 0) continue;
      const o = (oy * O + ox) * 4;
      out.data[o] = br / bw; out.data[o + 1] = bg / bw; out.data[o + 2] = bb / bw;
      out.data[o + 3] = a * 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return rc;
}
