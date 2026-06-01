// Small shared primitives with no dependencies.
export const clampi = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// mirrored x so screen coords match the selfie view
export const MX = lm => 1 - lm.x;
// thumb(4)+index(8) pinch distance — the one gesture MediaPipe reads reliably
export const pinchDistOf = lm => Math.hypot(lm[8].x - lm[4].x, lm[8].y - lm[4].y);
