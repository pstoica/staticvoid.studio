// main.js, the live-coding shell and the particle renderer.
//
// You type a pattern expression; we eval it (with the DSL in scope) into a
// Pattern. A clock advances cyclic time; each frame we query the pattern for the
// slice of time that just elapsed and spawn a glyph for every event onset. Glyphs
// bloom and fade as particles over a trailed canvas, so rhythm becomes geometry.

import { DSL } from './pattern.js';
import { GLRenderer } from './gl/renderer.js';

const $ = (sel) => document.querySelector(sel);
const TAU = Math.PI * 2;
const canvas = $('#stage');
const ctx = canvas.getContext('2d');

// ── renderer selection ──────────────────────────────────────────────────────────
// The WebGL renderer (on #glstage) is the default; the legacy Canvas2D path is
// kept as an escape hatch via ?gl=0 (it lacks the shader FX chain (blur,
// feedback, kaleido, etc.) and renders only pixelate on groups).
const USE_GL = new URLSearchParams(location.search).get('gl') !== '0';
const glCanvas = $('#glstage');
const glr = USE_GL ? new GLRenderer(glCanvas) : null;
if (USE_GL) { canvas.hidden = true; glCanvas.hidden = false; }
const activeCanvas = USE_GL ? glCanvas : canvas;   // the visible canvas drives sizing
const editor = $('#code');
const hl = $('#hl');
const errBar = $('#err');
const cpsLabel = $('#cpsval');

// ── syntax highlighting ────────────────────────────────────────────────────────────
// A transparent <textarea> sits over a <pre>; we re-render coloured HTML into the
// <pre> on every edit and keep their scroll positions synced.
const HL_FN = new Set(['shape','s','n','stack','cat','slowcat','fastcat','seq','sequence','timecat',
  'pure','silence','run','range','mini','euclid','fast','slow','rev','choose','irand','osc','palette','bg','group']);
const HL_SIG = new Set(['sine','cosine','saw','isaw','tri','square','rand','perlin','fbm','brown','gauss','white']);
const HL_METHOD = new Set(['fast','slow','rev','every','iter','palindrome','jux','superimpose','off','degrade','degradeBy',
  'unDegradeBy','sometimes','sometimesBy','often','rarely','early','late','range','add','sub','mul','div',
  'color','size','x','y','radius','angle','grid','rotate','rotateX','rotateY','spin','blend','alpha','opacity','pan','jitter','fill','stroke','weight','pixelate',
  'blur','feedback','trails','hue','brightness','contrast','saturate','negative','invert','displace','kaleido','mirror',
  'cap','join','open','vertex','attack','decay','life','set','spread','phase','rate','quantize']);
const HL_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|=>|\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*|[(){}\[\],.]/g;
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function classOf(tok) {
  if (tok.startsWith('//') || tok.startsWith('/*')) return 't-com';
  const c = tok[0];
  if (c === '"' || c === "'" || c === '`') return 't-str';
  if (/\d/.test(c)) return 't-num';
  if (tok === '=>') return 't-op';
  if (c === '.') return HL_METHOD.has(tok.slice(1)) ? 't-ctrl' : 't-method';
  if (HL_SIG.has(tok)) return 't-sig';
  if (HL_FN.has(tok)) return 't-fn';
  if ('(){}[],.'.includes(tok)) return 't-punct';
  return null;
}
function highlight(code) {
  let out = '', last = 0, m;
  HL_RE.lastIndex = 0;
  while ((m = HL_RE.exec(code))) {
    out += escHtml(code.slice(last, m.index));
    const tok = m[0], cls = classOf(tok);
    out += cls ? `<span class="${cls}">${escHtml(tok)}</span>` : escHtml(tok);
    last = m.index + tok.length;
  }
  // wrap in an inline span so a per-line background hugs the text (box-decoration-break),
  // legible over busy art without washing the whole panel dark. trailing \n stays outside.
  return `<span class="hlwrap">${out}${escHtml(code.slice(last))}</span>\n`;
}
function refreshHL() {
  hl.innerHTML = highlight(editor.value);
  hl.scrollTop = editor.scrollTop;
  hl.scrollLeft = editor.scrollLeft;
}

// ── canvas sizing (DPR-aware) ───────────────────────────────────────────────────
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const r = activeCanvas.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // paint an opaque base so the first trail-fade has something to eat
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, W, H);
  if (glr) glr.resize(W, H, DPR);
}
new ResizeObserver(resize).observe(activeCanvas);

// ── the pattern + clock ──────────────────────────────────────────────────────────
let pattern = DSL.silence;
let cps = 0.6;          // cycles per second
let cycle = 0;          // current position in cycles (fractional)
let elapsed = 0;        // wall-clock seconds since start, for global-time FX params
let playing = true;
let decayScale = 1.5;   // master multiplier on a new glyph's decay (how long it lingers)
const DEFAULT_BG = '#0a0a0a';
let bgColor = DEFAULT_BG; // resolved canvas background for the current frame
let bgSource = DEFAULT_BG; // raw bg arg (string/number/pattern/osc), resolved each frame, so bg() is patternable
let showClock = localStorage.getItem('loom.clock') !== '0'; // playhead sweep on/off
let traceMode = false; // trace path, UI toggle removed for now; renderer support stays
let lastT = performance.now();

const particles = [];

// ── compile user code into a Pattern ──────────────────────────────────────────────
function compile(code) {
  const names = Object.keys(DSL);
  const vals = names.map((k) => DSL[k]);
  // Wrap as an expression so a bare `stack(...)` evaluates to a value.
  const body = `"use strict";\nreturn (\n${code}\n);`;
  const fn = new Function(...names, body);
  const result = fn(...vals);
  if (!result || typeof result.query !== 'function') throw new Error('expression did not evaluate to a pattern');
  return result;
}

function run() {
  try {
    bgSource = DEFAULT_BG;                // bg("…") in the patch overrides this during compile
    pattern = compile(editor.value);
    // re-run starts fresh: drop glyphs from the previous patch so their (now
    // stale) group FX (feedback history especially) don't linger after you
    // remove an effect. Old group render targets are pruned once their glyphs go.
    particles.length = 0;
    errBar.textContent = '';
    errBar.classList.remove('show');
    localStorage.setItem('loom.code', editor.value);
    syncURL();
  } catch (e) {
    errBar.textContent = String(e.message || e);
    errBar.classList.add('show');
  }
}

// ── glyph spawning ────────────────────────────────────────────────────────────────
const PALETTE = ['#ff5d73', '#ffd166', '#6df0c2', '#56b6ff', '#b58cff', '#ff9d5c'];

function spawn(value, onset) {
  const v = value || {};
  const minDim = Math.min(W, H);
  const phase = onset - Math.floor(onset);

  // jitter offsets captured once (a control may be an osc; sample it at birth)
  const jit = numAt(v.jitter || 0, 0);
  const jx = jit ? (Math.random() - 0.5) * jit : 0;
  const jy = jit ? (Math.random() - 0.5) * jit : 0;

  // position inputs may be numbers or live oscillators, recomputed each frame
  // only when one is an osc; otherwise the spawn position stands.
  const pin = { x: v.x, y: v.y, radius: v.radius, angle: v.angle, gridX: v.gridX, gridY: v.gridY, pan: v.pan, phase };
  const posLive = isOsc(v.x) || isOsc(v.y) || isOsc(v.radius) || isOsc(v.angle) || isOsc(v.gridX) || isOsc(v.gridY) || isOsc(v.pan);

  // scalar/colour controls that are oscillators keep running over the lifetime
  const mods = [];
  for (const f of MOD_FIELDS) if (isOsc(v[f])) mods.push({ field: f, osc: v[f].__osc });

  const p = {
    pin, posLive, jx, jy, phase,
    shape: v.shape || 'dot',
    color: isOsc(v.color) ? oscColor(v.color.__osc, 0, phase) : resolveColor(v.color, phase),
    size: numAt(v.size != null ? v.size : 0.06, 0, phase) * minDim,
    rotTurns: numAt(v.rotate != null ? v.rotate : 0, 0, phase),       // Z, turns
    rotX: numAt(v.rotateX != null ? v.rotateX : 0, 0, phase) * TAU,   // tilt (radians)
    rotY: numAt(v.rotateY != null ? v.rotateY : 0, 0, phase) * TAU,
    spin: (v.spin != null ? v.spin : 0) * TAU,                 // turns/sec (Z), age-driven
    fill: v.fill != null ? v.fill : 1,
    stroke: v.stroke != null ? v.stroke : 0,
    vertex: v.vertex != null ? v.vertex : 0,
    weight: numAt(v.weight != null ? v.weight : 0.006, 0, phase),
    cap: v.cap || 'square',
    join: v.join || 'miter',
    open: numAt(v.open != null ? v.open : 0, 0, phase),
    alpha: numAt(v.alpha != null ? v.alpha : 1, 0, phase),
    blend: v.blend || 'source-over',
    age: 0,
    attack: v.attack != null ? v.attack : 0.06,
    // fade-out seconds; default ~1 cycle. The master slider is baked in HERE so
    // each glyph keeps the decay it was born with.
    decay: ((v.decay != null ? v.decay : 1.0) / cps) * decayScale,
    mods: mods.length ? mods : null,
    gid: v._gid || 0,          // group layer id (0 = ungrouped, drawn to main canvas)
    fx: v._fx || null,         // group effect params (e.g. { pixelate })
  };
  const xy = resolvePos(p, minDim, 0);
  p.x = xy[0]; p.y = xy[1];
  particles.push(p);
}

const NAMED = { red: '#ff5d73', orange: '#ff9d5c', yellow: '#ffd166', green: '#6df0c2',
  cyan: '#56e0ff', blue: '#56b6ff', purple: '#b58cff', pink: '#ff8ad1', white: '#f4f6fb', black: '#06070a' };

function resolveColor(c, phase) {
  if (c && typeof c === 'object' && c.__pal) return interpPal(c.__pal, c.t != null ? c.t : phase);
  if (typeof c === 'string') {
    if (c[0] === '#') return c;
    if (NAMED[c]) return NAMED[c];
    let h = 0; for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) % 360; // word → stable hue
    return `hsl(${h} 80% 64%)`;
  }
  if (typeof c === 'number') return `hsl(${(((c * 360) % 360) + 360) % 360} 82% 64%)`;
  // default: hue follows position in the cycle → a rainbow ring
  return PALETTE[Math.floor(phase * PALETTE.length) % PALETTE.length];
}

// ── colour → rgb, for palette interpolation ──
function hslRGB(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const a = s * Math.min(l, 1 - l);
  const f = (k) => Math.round(255 * (l - a * Math.max(-1, Math.min((k + h * 12) % 12 - 3, 9 - (k + h * 12) % 12, 1))));
  return [f(0), f(8), f(4)];
}
function parseRGB(c) {
  if (typeof c === 'number') return hslRGB(((c * 360) % 360 + 360) % 360, 0.82, 0.64);
  if (typeof c === 'string') {
    const s = c[0] === '#' ? c : NAMED[c];
    if (s && s[0] === '#') { let h = s.slice(1); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    let hh = 0; for (let i = 0; i < c.length; i++) hh = (hh * 31 + c.charCodeAt(i)) % 360;
    return hslRGB(hh, 0.8, 0.64);
  }
  return [240, 243, 250];
}
// ── OKLab/OKLCH, perceptually-uniform colour, for clean palette interpolation ──
const _lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const _gam = (c) => Math.max(0, Math.min(255, Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255)));
function rgbToLch([r, g, b]) {
  const R = _lin(r), G = _lin(g), B = _lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];   // L, Chroma, Hue
}
function lchToRgb(L, C, h) {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return `rgb(${_gam(+4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)},${_gam(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)},${_gam(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_)})`;
}
const _palCache = new WeakMap();
function palStops(colors) { let r = _palCache.get(colors); if (!r) { r = colors.map((c) => rgbToLch(parseRGB(c))); _palCache.set(colors, r); } return r; }
function interpPal(colors, t) {
  const lch = palStops(colors), n = lch.length;
  if (n === 0) return '#fff';
  if (n === 1) return lchToRgb(lch[0][0], lch[0][1], lch[0][2]);
  const u = t - Math.floor(t);                        // wrap so signals loop the gradient
  const x = u * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i, A = lch[i], B = lch[i + 1];
  const L = A[0] + (B[0] - A[0]) * f;
  const C = A[1] + (B[1] - A[1]) * f;
  let h;                                              // interpolate hue along the shortest arc
  if (A[1] < 1e-4) h = B[2]; else if (B[1] < 1e-4) h = A[2];
  else { let dh = B[2] - A[2]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI; h = A[2] + dh * f; }
  return lchToRgb(L, C, h);
}

// ── live oscillators (LFOs): evaluated each frame against a glyph's age, so a
// control keeps moving over the glyph's lifetime instead of freezing at spawn. ──
const isOsc = DSL.isOsc;
const MOD_FIELDS = ['size', 'color', 'rotate', 'rotateX', 'rotateY', 'open', 'alpha', 'weight'];
const _h1 = (x) => { const s = Math.sin((x + 0.123) * 12.9898) * 43758.5453; return s - Math.floor(s); };
const _snoise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return _h1(i) * (1 - u) + _h1(i + 1) * u; };
const _fbm = (x) => { let s = 0, a = 1, fr = 1, n = 0; for (let o = 0; o < 4; o++) { s += _snoise(x * fr) * a; n += a; fr *= 2; a *= 0.5; } return s / n; };
function evalOsc(d, age, gp = 0) {
  // every parameter may itself be an oscillator → cross-modulation (FM via rate,
  // PM via phase, AM via range lo/hi). gp = the glyph's onset phase.
  const rate = numAt(d.rate, age, gp);
  const t = age * rate + numAt(d.phase || 0, age, gp) + numAt(d.spread || 0, age, gp) * gp;
  const f = t - Math.floor(t);
  let v;
  switch (d.shape) {
    case 'saw': v = f; break;
    case 'isaw': v = 1 - f; break;
    case 'tri': v = f < 0.5 ? f * 2 : 2 - f * 2; break;
    case 'square': v = f < 0.5 ? 0 : 1; break;
    case 'rand': v = _h1(Math.floor(t)); break;          // stepped, per cycle
    case 'perlin': case 'noise': v = _snoise(t); break;  // smooth, lively
    case 'fbm': v = _fbm(t); break;                       // organic, multi-octave
    default: v = (Math.sin(TAU * t) + 1) / 2;             // sine
  }
  const lo = numAt(d.lo, age, gp), hi = numAt(d.hi, age, gp);
  let r = lo + v * (hi - lo);
  if (d.ops) for (const [op, x] of d.ops) {            // .add/.sub/.mul/.div/.quantize (x may be an osc)
    const y = numAt(x, age, gp);
    r = op === '*' ? r * y : op === '+' ? r + y : op === '-' ? r - y : op === '/' ? r / y : op === 'q' ? Math.round(r * y) / y : r;
  }
  return r;
}
const numAt = (a, age, gp = 0) => (isOsc(a) ? evalOsc(a.__osc, age, gp) : a);
// resolve an oscillator-driven colour: through a palette if attached, else as hue
const oscColor = (d, age, gp) => (d.pal ? interpPal(d.pal, evalOsc(d, age, gp)) : resolveColor(evalOsc(d, age, gp), gp));

// ── colour → rgb float triples (0..1), for the WebGL renderer ──────────────────
// The Canvas2D path works in CSS colour strings; WebGL wants float rgb. These
// mirror resolveColor / interpPal / oscColor but return [r,g,b] in 0..1 (sRGB).
function hexToRGB01(s) {
  let h = s[0] === '#' ? s.slice(1) : s;
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function lchToRgb01(L, C, h) {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    _gam(+4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_) / 255,
    _gam(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_) / 255,
    _gam(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_) / 255,
  ];
}
function interpPalRGB(colors, t) {
  const lch = palStops(colors), n = lch.length;
  if (n === 0) return [1, 1, 1];
  if (n === 1) return lchToRgb01(lch[0][0], lch[0][1], lch[0][2]);
  const u = t - Math.floor(t);
  const x = u * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i, A = lch[i], B = lch[i + 1];
  const L = A[0] + (B[0] - A[0]) * f, C = A[1] + (B[1] - A[1]) * f;
  let h;
  if (A[1] < 1e-4) h = B[2]; else if (B[1] < 1e-4) h = A[2];
  else { let dh = B[2] - A[2]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI; h = A[2] + dh * f; }
  return lchToRgb01(L, C, h);
}
function resolveColorRGB(c, phase) {
  if (c && typeof c === 'object' && c.__pal) return interpPalRGB(c.__pal, c.t != null ? c.t : phase);
  if (typeof c === 'string') {
    if (c[0] === '#') return hexToRGB01(c);
    if (NAMED[c]) return hexToRGB01(NAMED[c]);
    let h = 0; for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) % 360;
    const rgb = hslRGB(h, 0.8, 0.64); return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  }
  if (typeof c === 'number') { const rgb = hslRGB(((c * 360) % 360 + 360) % 360, 0.82, 0.64); return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]; }
  const rgb = hexToRGB01(PALETTE[Math.floor(phase * PALETTE.length) % PALETTE.length]); return rgb;
}
const oscColorRGB = (d, age, gp) => (d.pal ? interpPalRGB(d.pal, evalOsc(d, age, gp)) : resolveColorRGB(evalOsc(d, age, gp), gp));
// parse a captured CSS colour string (resolveColor output: '#…', 'rgb(…)', 'hsl(h s% l%)')
function cssToRGB(s) {
  if (typeof s !== 'string') return [1, 1, 1];
  if (s[0] === '#') return hexToRGB01(s);
  const m = s.match(/[\d.]+/g);
  if (!m) return [1, 1, 1];
  if (s[0] === 'r') return [(+m[0]) / 255, (+m[1]) / 255, (+m[2]) / 255];
  if (s[0] === 'h') { const rgb = hslRGB(+m[0], (+m[1]) / 100, (+m[2]) / 100); return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]; }
  return [1, 1, 1];
}

// ── pack a particle into the WebGL instance scratch (live oscillators applied).
// Mirrors drawGlyph's mod resolution but emits numbers + float rgb for the GPU.
const SHAPE_ID = { dot: 0, circle: 0, ring: 1, arc: 2, square: 3, box: 3, tri: 4, pent: 5, hex: 6, star: 7, plus: 8, line: 9, cross: 10 };
const OUTLINE_IDS = new Set([1, 2, 9, 10]);
const CAP_ID = { round: 0, butt: 1, square: 2 };   // line/cross caps (spawn defaults cap to 'square')
const JOIN_ID = { miter: 0, round: 1, bevel: 2 };  // polygon corners (default miter = sharp)
function glResolve(p, minDim, out) {
  const age = p.age;
  let sizePx = p.size, rotTurns = p.rotTurns, rotX = p.rotX, rotY = p.rotY, open = p.open, alpha = p.alpha, weight = p.weight, color = null;
  if (p.mods) for (const m of p.mods) {
    const val = evalOsc(m.osc, age, p.phase);
    if (m.field === 'size') sizePx = val * minDim;
    else if (m.field === 'color') color = oscColorRGB(m.osc, age, p.phase);
    else if (m.field === 'rotate') rotTurns = val;
    else if (m.field === 'rotateX') rotX = val * TAU;
    else if (m.field === 'rotateY') rotY = val * TAU;
    else if (m.field === 'open') open = val;
    else if (m.field === 'alpha') alpha = val;
    else if (m.field === 'weight') weight = val;
  }
  if (!color) { if (!p._rgb) p._rgb = cssToRGB(p.color); color = p._rgb; }
  out.x = p.x; out.y = p.y;
  out.r = sizePx;
  out.rot = rotTurns * TAU + p.spin * age;
  out.rotX = rotX; out.rotY = rotY;
  out.rgb = color;
  out.alpha = Math.max(0, Math.min(1, alpha * p._env));
  out.weight = Math.max(0.75, weight * minDim);
  out.open = open;
  const id = SHAPE_ID[p.shape] != null ? SHAPE_ID[p.shape] : 0;
  out.shape = id;
  // mirror the 2D draw-mode logic: outline shapes (ring/arc/line/cross) stroke
  // unless they're vertex-only; other shapes honour fill/stroke directly.
  const outline = OUTLINE_IDS.has(id);
  out.stroke = outline ? ((p.stroke || !p.vertex) ? 1 : 0) : (p.stroke ? 1 : 0);
  out.fill = outline ? 0 : (p.fill ? 1 : 0);
  out.vertex = p.vertex ? 1 : 0;
  out.cap = CAP_ID[p.cap] != null ? CAP_ID[p.cap] : 2;   // default square, matching spawn
  out.join = JOIN_ID[p.join] != null ? JOIN_ID[p.join] : 0;   // default miter (sharp corners)
  out.blend = p.blend;
}

// resolve an FX parameter against GLOBAL time, FX run per-layer-per-frame, not
// per-glyph, so oscs evaluate at elapsed seconds (not glyph age) and patterns are
// sampled at the current cycle. Numbers pass through.
function evalGlobal(param, cycle, elapsed) {
  if (param == null) return param;
  if (isOsc(param)) return evalOsc(param.__osc, elapsed, 0);
  if (param instanceof DSL.Pattern) {
    // a tiny forward window, not a zero-width span: discrete patterns (mini
    // sequences) collapse to their first step when sampled at an instant.
    const hs = param.query(DSL.span(cycle, cycle + 1e-4));
    for (const h of hs) if (h.value != null) return +h.value;
    return 0;
  }
  return param;
}

// resolve the (possibly patterned) background to a CSS colour for this frame.
// Like a control's colour: number/string/palette = constant, osc = live (elapsed),
// pattern = sampled at the cycle, so bg("<#000 #103>"), bg(osc(...)) etc. animate.
function bgEval(src, cycle, elapsed) {
  if (isOsc(src)) return oscColor(src.__osc, elapsed, 0);
  if (src instanceof DSL.Pattern) {
    const hs = src.query(DSL.span(cycle, cycle + 1e-4));
    for (const h of hs) if (h.value != null) return resolveColor(h.value, 0);
    return DEFAULT_BG;
  }
  return resolveColor(src, 0);
}

// place a glyph: explicit x/y (0..1) win, else lay it on a ring by onset phase.
// Inputs may be live oscillators, so this is re-run each frame for moving glyphs.
// Unified layout: position = centre (x/y) + polar offset (radius, angle). x/y
// default to screen centre; radius defaults to the mandala ring (0.34) only when
// nothing else is set, else 0, so you can mix freely: x/y alone = cartesian,
// radius/angle alone = ring, both = orbit around (x,y).
function resolvePos(p, minDim, age) {
  const { x, y, radius, angle, gridX, gridY, pan, phase } = p.pin;
  let px, py;
  if (gridX != null) {                                 // grid: cell from onset phase
    const cols = Math.max(1, Math.round(numAt(gridX, age)));
    const rows = Math.max(1, Math.round(numAt(gridY != null ? gridY : gridX, age)));
    const cell = Math.min(cols * rows - 1, Math.floor((((phase % 1) + 1) % 1) * cols * rows));
    px = ((cell % cols) + 0.5) / cols * W;
    py = ((Math.floor(cell / cols) % rows) + 0.5) / rows * H;
  } else {
    px = (x != null ? numAt(x, age, phase) : 0.5) * W;
    py = (y != null ? numAt(y, age, phase) : 0.5) * H;
  }
  const defR = (gridX == null && x == null && y == null && radius == null) ? 0.34 : 0;
  const rad = (radius != null ? numAt(radius, age, phase) : defR) * minDim;
  if (rad !== 0) {
    const ang = (angle != null ? numAt(angle, age, phase) : phase) * TAU - Math.PI / 2;
    px += Math.cos(ang) * rad;
    py += Math.sin(ang) * rad;
  }
  if (pan != null) px += (numAt(pan, age, phase) - 0.5) * W * 0.42;
  return [px + p.jx * minDim, py + p.jy * minDim];
}

// ── shape drawing ───────────────────────────────────────────────────────────────
function poly(g, n, r, rot, star = 0) {
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot - Math.PI / 2 + (i / n) * Math.PI * 2;
    const rr = star && i % 2 ? r * star : r;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
}
// Build the shape's path, then fill and/or stroke it per the (independent)
// `fill`/`stroke` flags. `ring`/`arc`/`line`/`cross` are outlines (no fill), so
// they honour `stroke` only. Vertex dots are drawn separately by the caller.
function drawShape(g, name, r, o) {
  g.lineWidth = o.lw; g.lineCap = o.cap; g.lineJoin = o.join;
  switch (name) {
    case 'ring': if (o.stroke) { g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke(); } return;
    case 'arc': if (o.stroke) { const span = (1 - (o.open || 0)) * TAU; g.beginPath(); g.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + span); g.stroke(); } return;
    case 'line': if (o.stroke) { const h = (1 - (o.open || 0)) * r; g.beginPath(); g.moveTo(-h, 0); g.lineTo(h, 0); g.stroke(); } return; // open clips length
    case 'cross': if (o.stroke) { g.beginPath(); g.moveTo(-r, -r); g.lineTo(r, r); g.moveTo(r, -r); g.lineTo(-r, r); g.stroke(); } return;
    case 'circle': case 'dot': g.beginPath(); g.arc(0, 0, r, 0, TAU); break;
    case 'square': case 'box': g.beginPath(); g.rect(-r, -r, r * 2, r * 2); break;
    case 'tri': poly(g, 3, r, 0); break;
    case 'pent': poly(g, 5, r, 0); break;
    case 'hex': poly(g, 6, r, 0); break;
    case 'star': poly(g, 10, r, 0, 0.45); break;
    case 'plus': {
      const t = r * 0.38;
      g.beginPath();
      g.moveTo(-t, -r); g.lineTo(t, -r); g.lineTo(t, -t); g.lineTo(r, -t); g.lineTo(r, t);
      g.lineTo(t, t); g.lineTo(t, r); g.lineTo(-t, r); g.lineTo(-t, t); g.lineTo(-r, t);
      g.lineTo(-r, -t); g.lineTo(-t, -t); g.closePath();
      break;
    }
    default: g.beginPath(); g.arc(0, 0, r, 0, TAU);
  }
  if (o.fill) g.fill();
  if (o.stroke) g.stroke();
}

const OUTLINE_SHAPES = new Set(['ring', 'arc', 'line', 'cross']);
// vertex draw mode: a filled dot at each of the shape's vertices (2D, no tilt)
function drawVertices(g, geom, vr) {
  for (const path of geom.paths) for (const [x, y] of path) { g.beginPath(); g.arc(x, y, vr, 0, TAU); g.fill(); }
}

// ── 3D path: real perspective for tilted glyphs ─────────────────────────────────
// Each shape is a list of polylines in its local z=0 plane. We rotate the
// vertices in 3D (Z then X then Y) and project them through a pinhole camera,
// a genuine projective transform, not the affine scale Canvas2D can express.
function shapeGeom(name, r, open) {
  const pts = (n, star = 0) => { const a = []; for (let i = 0; i < n; i++) { const t = -Math.PI / 2 + (i / n) * TAU, rr = star && i % 2 ? r * star : r; a.push([Math.cos(t) * rr, Math.sin(t) * rr]); } return a; };
  const circle = (n = 48) => { const a = []; for (let i = 0; i < n; i++) { const t = (i / n) * TAU; a.push([Math.cos(t) * r, Math.sin(t) * r]); } return a; };
  switch (name) {
    case 'circle': case 'dot': return { paths: [circle()], closed: true };
    case 'ring': return { paths: [circle()], closed: true, strokeOnly: true };
    case 'arc': { const span = (1 - (open || 0)) * TAU, n = Math.max(2, Math.round(48 * (1 - (open || 0)))), a = []; for (let i = 0; i <= n; i++) { const t = -Math.PI / 2 + (i / n) * span; a.push([Math.cos(t) * r, Math.sin(t) * r]); } return { paths: [a], closed: false, strokeOnly: true }; }
    case 'square': case 'box': return { paths: [[[-r, -r], [r, -r], [r, r], [-r, r]]], closed: true };
    case 'tri': return { paths: [pts(3)], closed: true };
    case 'pent': return { paths: [pts(5)], closed: true };
    case 'hex': return { paths: [pts(6)], closed: true };
    case 'star': return { paths: [pts(10, 0.45)], closed: true };
    case 'plus': { const t = r * 0.38; return { paths: [[[-t, -r], [t, -r], [t, -t], [r, -t], [r, t], [t, t], [t, r], [-t, r], [-t, t], [-r, t], [-r, -t], [-t, -t]]], closed: true }; }
    case 'line': { const h = (1 - (open || 0)) * r; return { paths: [[[-h, 0], [h, 0]]], closed: false, strokeOnly: true }; }
    case 'cross': return { paths: [[[-r, -r], [r, r]], [[r, -r], [-r, r]]], closed: false, strokeOnly: true };
    default: return { paths: [circle()], closed: true };
  }
}
function drawShape3D(g, name, r, rz, rx, ry, o, vertex) {
  const geom = shapeGeom(name, r, o.open);
  const cz = Math.cos(rz), sz = Math.sin(rz), cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  const d = 2.6 * Math.max(1, r);                       // camera distance, in units of r
  // Tilt the flat shape in 3D (X then Y) and project it, THEN spin it in the
  // picture plane (Z). Keeping Z out of the 3D pipeline means the tilt produces
  // a clean perspective trapezoid instead of a sheared parallelogram.
  const project = (px, py) => {
    let x = px, y = py * cx, z = py * sx;                   // X rotation (world horizontal axis)
    const x2 = x * cy + z * sy; z = -x * sy + z * cy; x = x2; // Y rotation (world vertical axis)
    const s = d / (d - z);                                  // perspective divide
    const X = x * s, Y = y * s;
    return [X * cz - Y * sz, X * sz + Y * cz];               // Z spin, in screen space
  };
  g.lineWidth = o.lw; g.lineCap = o.cap; g.lineJoin = o.join;
  const vr = Math.max(2, o.lw * 1.5);
  for (const path of geom.paths) {
    const proj = path.map(([x, y]) => project(x, y));
    g.beginPath();
    for (let i = 0; i < proj.length; i++) { const [X, Y] = proj[i]; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }
    if (geom.closed) g.closePath();
    if (geom.strokeOnly) { if (o.stroke) g.stroke(); }
    else { if (o.fill) g.fill(); if (o.stroke) g.stroke(); }
    if (vertex) for (const [X, Y] of proj) { g.beginPath(); g.arc(X, Y, vr, 0, TAU); g.fill(); }
  }
}

// draw a single glyph to any context (main canvas or a group buffer), applying
// its live oscillators. Shared by ungrouped and grouped rendering.
function drawGlyph(g, p, minDim) {
  const age = p.age;
  let sizePx = p.size, color = p.color, rotTurns = p.rotTurns,
      rotX = p.rotX, rotY = p.rotY, open = p.open, alpha = p.alpha, weight = p.weight;
  if (p.mods) for (const m of p.mods) {
    const val = evalOsc(m.osc, age, p.phase);
    if (m.field === 'size') sizePx = val * minDim;
    else if (m.field === 'color') color = oscColor(m.osc, age, p.phase);
    else if (m.field === 'rotate') rotTurns = val;
    else if (m.field === 'rotateX') rotX = val * TAU;
    else if (m.field === 'rotateY') rotY = val * TAU;
    else if (m.field === 'open') open = val;
    else if (m.field === 'alpha') alpha = val;
    else if (m.field === 'weight') weight = val;
  }
  g.save();
  g.translate(p.x, p.y);
  g.globalCompositeOperation = p.blend;
  g.globalAlpha = Math.max(0, Math.min(1, alpha * p._env));
  g.fillStyle = color; g.strokeStyle = color;
  const zRot = rotTurns * TAU + p.spin * age;
  const lw = Math.max(0.75, weight * minDim);
  const outline = OUTLINE_SHAPES.has(p.shape);
  const stroke = outline ? (p.stroke || !p.vertex) : p.stroke;
  const fill = outline ? 0 : p.fill;
  const o = { fill, stroke, lw, cap: p.cap, join: p.join, open };
  if (rotX || rotY) {
    drawShape3D(g, p.shape, sizePx, zRot, rotX, rotY, o, p.vertex);
  } else {
    g.rotate(zRot);
    if (fill || stroke) drawShape(g, p.shape, sizePx, o);
    if (p.vertex) drawVertices(g, shapeGeom(p.shape, sizePx, open), Math.max(2, lw * 1.5));
  }
  g.restore();
}

// ── group layers: each renders to its own buffer so a layer effect (pixelate)
// can be applied before it's composited onto the main canvas. ──
const groupCanvases = new Map();
const _tmpCanvas = document.createElement('canvas');
function groupCtx(gid) {
  let g = groupCanvases.get(gid);
  if (!g) { const c = document.createElement('canvas'); groupCanvases.set(gid, g = { canvas: c, ctx: c.getContext('2d') }); }
  if (g.canvas.width !== canvas.width || g.canvas.height !== canvas.height) { g.canvas.width = canvas.width; g.canvas.height = canvas.height; }
  g.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.ctx.clearRect(0, 0, W, H);
  return g.ctx;
}
function compositeGroup(gid, fx) {
  const gc = groupCanvases.get(gid).canvas;
  if (fx && fx.pixelate > 1) {                          // downscale → upscale, no smoothing = blocky
    const b = fx.pixelate;
    const sw = Math.max(1, Math.round(W / b)), sh = Math.max(1, Math.round(H / b));
    if (_tmpCanvas.width !== sw) _tmpCanvas.width = sw;
    if (_tmpCanvas.height !== sh) _tmpCanvas.height = sh;
    const t = _tmpCanvas.getContext('2d');
    t.clearRect(0, 0, sw, sh); t.imageSmoothingEnabled = true;
    t.drawImage(gc, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_tmpCanvas, 0, 0, sw, sh, 0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
  } else {
    ctx.drawImage(gc, 0, 0, W, H);
  }
}

// ── main loop ─────────────────────────────────────────────────────────────────────
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  tick(dt);
  requestAnimationFrame(frame);
}

function tick(dt) {
  elapsed += dt;   // advances even when paused (like glyph age), so FX keep living
  bgColor = bgEval(bgSource, cycle, elapsed);   // bg() is patternable, resolve per frame
  if (glr) glr.setBackground(bgColor);
  // Clean redraw: wipe the buffer completely every frame, then repaint only the
  // live particles. Nothing is ever baked in, so there's no alpha residue/ghosting.
  // "Trails" come from particles fading out over their own lifetime, not from a veil.
  if (!USE_GL) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);
  }

  if (playing) {
    const prev = cycle;
    cycle += dt * cps;
    // query the pattern for the slice of time that just elapsed; spawn onsets.
    try {
      const haps = pattern.query(DSL.span(prev, cycle));
      for (const h of haps) {
        if (DSL.hasOnset(h) && h.whole.begin >= prev - 1e-9 && h.whole.begin < cycle) {
          spawn(h.value, h.whole.begin);
        }
      }
    } catch (e) { /* a bad pattern shouldn't kill the loop */ }
  }

  const minDim = Math.min(W, H);

  // playhead, a faint clock hand sweeping the cycle phase, drawn *behind* the
  // glyphs. Toggleable, and freezes when paused (it reads `cycle`).
  if (showClock && !USE_GL) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const phase = cycle - Math.floor(cycle);
    const ang = phase * Math.PI * 2 - Math.PI / 2;
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#9db4ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2, H / 2);
    ctx.lineTo(W / 2 + Math.cos(ang) * minDim * 0.4, H / 2 + Math.sin(ang) * minDim * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  // age + cull first, building the live list oldest→newest. Each glyph runs the
  // attack→decay envelope it captured at spawn (the decay slider only affects
  // glyphs born after you move it). Expired glyphs are compacted out in place.
  let w = 0;
  const live = [];
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.age += dt;
    if (p.age >= p.attack + p.decay) continue;        // expired → drop
    const env = p.age < p.attack
      ? (p.attack > 0 ? p.age / p.attack : 1)          // attack rise
      : 1 - (p.age - p.attack) / p.decay;              // decay fall
    p._env = Math.max(0, Math.min(1, env));
    p._a = p._env * p.alpha;                           // for trace mode
    if (p.posLive) { const r = resolvePos(p, minDim, p.age); p.x = r[0]; p.y = r[1]; }
    particles[w++] = p;
    live.push(p);
  }
  particles.length = w;

  // trace mode: thread a line through the live points in spawn order, behind
  // the glyphs, rhythm becomes a connected path / constellation.
  if (traceMode && live.length > 1 && !USE_GL) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = Math.max(1, 0.0014 * minDim);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < live.length; i++) {
      const a = live[i - 1], b = live[i];
      ctx.globalAlpha = Math.min(a._a, b._a) * 0.6;
      ctx.strokeStyle = b.color;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // draw glyphs (newest on top, since live is oldest→newest). Ungrouped glyphs
  // go straight to the main canvas; grouped glyphs render to a per-group buffer
  // so a layer effect (pixelate) can be applied before compositing.
  if (USE_GL) {
    glr.render({ live, minDim, resolve: glResolve, evalGlobal, elapsed, W, H, cycle, showClock, traceMode });
  } else {
    const buckets = new Map();   // gid -> particle[]
    for (const p of live) {
      if (p.gid) { let b = buckets.get(p.gid); if (!b) buckets.set(p.gid, b = []); b.push(p); }
      else drawGlyph(ctx, p, minDim);
    }
    for (const [gid, parts] of buckets) {
      const gctx = groupCtx(gid);
      for (const p of parts) drawGlyph(gctx, p, minDim);
      compositeGroup(gid, parts[0].fx);
    }
    for (const gid of [...groupCanvases.keys()]) if (!buckets.has(gid)) groupCanvases.delete(gid); // prune
  }

  $('#cycle').textContent = Math.floor(cycle).toString();
}

// debug stepper, lets tooling drive frames when the tab is backgrounded (the
// browser pauses requestAnimationFrame while hidden). Harmless in production.
window.loom = { tick, step: (n = 60, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); }, particles, setDecay: (v) => { decayScale = v; }, glr };

// ── presets ───────────────────────────────────────────────────────────────────────
const PRESETS = {
  // gestural line field, perspective tumble, breathing weight, streaks
  'threads': `shape("line")
  .fast("256 128 256 128")
  .radius(
    sine.range(0.1, 0.2).fast(10)
      .add(sine.range(-0.5, 0.3).fast(7))
  )
  .angle(saw.range(0, 2))
  .open(sine.range(0, 0.6).slow(8))
  .sometimes(x => x.open(5))
  .color(palette("neon").at(saw.range(0, 4)))
  .size(sine.range(0.01, 0.1).fast(2))
  .slow(4)
  .attack(sine.range(0, 0.1))
  .decay(sine.range(0.01, 1).slow(7))
  .rotate(saw.range(-1, 9).slow(4))
  .rotateX(saw.range(-1, 1).slow(9))
  .rotateY(saw.range(-1, 1).slow(2))
  .weight(sine.range(0.001, 0.01).slow(8))
  .cap("square")`,

  // a five-turn spiral of dots over a slow pulsing ring (angle winds the ring)
  'spiral': `stack(
  bg("#04060d"),
  shape("dot*72")
    .angle(saw.range(0, 5))
    .radius(saw.range(0.02, 0.46))
    .color(palette("ice").at(saw.range(0, 1)))
    .size(sine.range(0.004, 0.018).fast(5))
    .decay(2.5),
  shape("ring*3")
    .radius(osc(0.05, "tri").range(0.12, 0.46))
    .color("#90e0ef").weight(0.004).decay(3)
)`,

  // euclid + parallel voices, 3-of-8 stars, with a reversed copy panned beside it
  // (jux), plus a recoloured echo a beat later (off)
  'weave': `stack(
  bg("#070512"),
  shape("star(3,8)")
    .radius(0.28).size(0.07)
    .rotate(saw.range(0, 1).slow(3))
    .color(palette("neon").at(saw.range(0, 1)))
    .jux(p => p.rev())
    .off(0.2, p => p.color("#6df0c2").size(0.03))
    .decay(2)
)`,

  // 3D perspective, polymeter polygons drifting and tumbling (rotateX / rotateY)
  'lattice': `stack(
  bg("#060309"),
  shape("{square tri hex pent}%9")
    .x(perlin.range(0.1, 0.9).fast(2))
    .y(perlin.range(0.1, 0.9).fast(2))
    .rotateX(osc(0.07, "saw").range(0, 1))
    .rotateY(osc(0.05, "saw").range(0, 1))
    .color(palette("candy").at(perlin.range(0, 1)))
    .size(sine.range(0.03, 0.08).slow(2))
    .fill(0).stroke().weight(0.006)
    .decay(1.8).fast(2)
)`,

  // wandering dots, live oscillators on position, hue, and size
  'drift': `stack(
  bg("#05050a"),
  shape("circle*10")
    .x(osc(0.13, "perlin").range(0.12, 0.88))
    .y(osc(0.17, "perlin").range(0.12, 0.88))
    .color(palette("candy").at(osc(0.2).range(0, 1)))
    .size(osc(0.6, "tri").range(0.012, 0.06))
    .decay(5)
)`,

  // cross-modulation: the radius oscillator's RATE is itself driven by another
  // osc (FM), so the spiral warps (speeds up and slows down) as it breathes
  'warp': `stack(
  bg("#070310"),
  shape("dot*64")
    .angle(saw.range(0, 2))
    .radius(osc(0.1).rate(osc(0.06).range(0.1, 0.5)).spread(3).range(0.08, 0.45))
    .color(palette("neon").at(osc(0.5).spread(2).range(0, 1)))
    .size(0.013)
    .decay(1)
)`,

  // a ring whose hue + size form a wave AROUND it (osc .spread by onset phase),
  // the whole gradient slowly rotating
  'halo': `stack(
  bg("#05060d"),
  shape("circle*32")
    .radius(sine.range(0.1, 0.34).slow(3))
    .color(palette("rainbow").at(osc(0.08).spread(1).range(0, 1)))
    .size(osc(0.5, "sine").spread(2).range(0.01, 0.05))
    .decay(2)
)`,

  // ── shader FX (WebGL): each group() runs a post-process chain on its layer ──

  // feedback tunnel, rings fed back with zoom + rotation leave a spiralling trail
  'tunnel': `group(stack(
  bg("#03030a"),
  shape("ring*5")
    .radius(saw.range(0.04, 0.4))
    .color(palette("neon").at(saw.range(0, 1)))
    .weight(0.008).decay(1.5)
)).feedback(0.94, 1.05, 0.03)`,

  // kaleidoscopic feedback storm, lines tumbling in perspective, the whole FX
  // chain (kaleido / feedback / pixelate) stuttered by patterned params
  'vortex': `group(
shape("line dot")
  .fast("64 | 128 | 256 | 128")
  .radius(
    sine.range(0.3, 0.2).fast(10)
      .add(sine.range(-0.5, 0.3).fast(3))
  )
  .angle(saw.range(0, 2))
  .open(sine.range(0, 5).slow(8))
  .sometimes(x => x.open(5))
  .color(
    palette("rainbow")
      .at(osc(0.1).spread(2).range(0, 4))
  )
  .size(sine.range(0.01, 0.4).slow(4))
  .decay(sine.range(0.1, 0.5).slow(7))
  .rotate(saw.range(-1, 9).slow(4))
  .rotateX(sine.range(-1, 1).slow(9))
  .rotateY(sine.range(-1, 1).slow(2))
  .weight(sine.range(0.001, 0.001).slow(8))
  .cap("square")
)
.kaleido("[0 | 4 | 8 | 16 | 32]*8")
.feedback(0.99, "[0.8 | 0.99]/4")
.pixelate("[0 | 0 | 32]*8")`,
};

// a gentle starting point, a rainbow ring of pulsing dots
const DEFAULT_PATCH = `shape("circle*6")
  .color(saw.range(0, 1))
  .size(sine.range(0.04, 0.09).fast(2))
  .radius(0.3)`;

// ── preset list + CRUD (built-in PRESETS + user presets in localStorage) ──
const USER_KEY = 'loom.presets';
const loadUser = () => { try { return JSON.parse(localStorage.getItem(USER_KEY)) || {}; } catch { return {}; } };
const saveUser = (obj) => localStorage.setItem(USER_KEY, JSON.stringify(obj));

const presList = $('#preslist');
let activeVal = '';
function setActive(val) {
  activeVal = val;
  presList.querySelectorAll('.presrow').forEach((r) => r.classList.toggle('active', r.dataset.val === val));
}
function rebuildPresetList() {
  const user = loadUser();
  presList.innerHTML = '';
  const label = (t) => { const d = document.createElement('div'); d.className = 'preslabel'; d.textContent = t; presList.appendChild(d); };
  const row = (name, val, deletable) => {
    const r = document.createElement('div'); r.className = 'presrow'; r.dataset.val = val;
    const load = document.createElement('button'); load.className = 'load'; load.textContent = name;
    load.addEventListener('click', () => { applyPreset(val); setActive(val); if (isMobile()) setSide(false); });
    r.appendChild(load);
    if (deletable) {
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = 'delete';
      del.addEventListener('click', () => {
        if (!confirm(`Delete preset "${name}"?`)) return;
        const u = loadUser(); delete u[name]; saveUser(u);
        if (activeVal === val) activeVal = '';
        rebuildPresetList();
      });
      r.appendChild(del);
    }
    presList.appendChild(r);
  };
  label('built-in');
  // feature a few favourites at the top, then the rest in definition order
  const featured = ['threads', 'vortex', 'halo'].filter((n) => n in PRESETS);
  const ordered = [...featured, ...Object.keys(PRESETS).filter((n) => !featured.includes(n))];
  for (const name of ordered) row(name, 'b:' + name, false);
  const names = Object.keys(user);
  if (names.length) { label('saved'); for (const name of names) row(name, 'u:' + name, true); }
  setActive(activeVal);
}

function applyPreset(val) {
  if (!val) return;
  const i = val.indexOf(':'); const kind = val.slice(0, i), name = val.slice(i + 1);
  const code = kind === 'u' ? loadUser()[name] : PRESETS[name];
  if (code == null) return;
  editor.value = code; refreshHL(); run();
}

// ── shareable URLs: ?p=<name> for a built-in preset, ?c=<base64> for any custom
// code. The address bar is the share link — it updates on every run/load. ──
const b64e = (s) => btoa(encodeURIComponent(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = (s) => decodeURIComponent(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
const builtinFor = (code) => Object.keys(PRESETS).find((n) => PRESETS[n].trim() === code.trim()) || null;
function syncURL() {
  const name = builtinFor(editor.value);
  const qs = name ? 'p=' + encodeURIComponent(name) : 'c=' + b64e(editor.value);
  try { history.replaceState(null, '', location.pathname + '?' + qs); } catch { /* ignore */ }
}

// ── wiring ──────────────────────────────────────────────────────────────────────────
function setCps(v) { cps = Math.max(0.1, Math.min(2, v)); cpsLabel.textContent = cps.toFixed(2); }
// a number field: drag horizontally, scroll-wheel, or click to type a value.
function attachScrub(el, { min, max, step, get, set }) {
  const sens = (max - min) / 180;   // px → value
  const snap = (v) => { const s = Math.round(Math.max(min, Math.min(max, v)) / step) * step; return Math.round(s * 1000) / 1000; };
  const valEl = el.querySelector('b');
  let dragging = false, sx = 0, sv = 0, moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (valEl.isContentEditable) return;                 // mid-edit, let the caret work
    dragging = true; moved = false; sx = e.clientX; sv = get(); el.setPointerCapture?.(e.pointerId);
    el.classList.add('drag'); document.body.style.userSelect = 'none'; e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - sx) > 2) moved = true;
    set(snap(sv + (e.clientX - sx) * sens));
  });
  const reset = () => { dragging = false; el.classList.remove('drag'); document.body.style.userSelect = ''; };
  el.addEventListener('pointerup', () => { const wasDragging = dragging, didMove = moved; reset(); if (wasDragging && !didMove) editValue(); });
  el.addEventListener('pointercancel', reset);
  el.addEventListener('wheel', (e) => { if (valEl.isContentEditable) return; e.preventDefault(); set(snap(get() + (e.deltaY < 0 ? step : -step))); }, { passive: false });

  function editValue() {
    valEl.contentEditable = 'true'; valEl.classList.add('editing'); valEl.focus();
    const r = document.createRange(); r.selectNodeContents(valEl);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const commit = () => {
      valEl.removeEventListener('blur', commit); valEl.removeEventListener('keydown', onKey);
      valEl.contentEditable = 'false'; valEl.classList.remove('editing');
      const n = parseFloat(valEl.textContent);
      set(isNaN(n) ? get() : snap(n));                   // set() re-renders the label
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); valEl.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); valEl.textContent = ''; valEl.blur(); }
    };
    valEl.addEventListener('blur', commit); valEl.addEventListener('keydown', onKey);
  }
}

editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); flash(); }
  // tab inserts two spaces instead of leaving the field
  if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText('  ', s, editor.selectionEnd, 'end'); refreshHL(); }
});
editor.addEventListener('input', refreshHL);
editor.addEventListener('scroll', () => { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; });

let flashT = 0;
// the wordmark is one solid colour per letter; each run shifts the palette by one
// discrete steps that fit the app's solid-colour glyphs better than a gradient.
const LOGO_COLORS = ['#ff5d73', '#ffd166', '#6df0c2', '#56b6ff', '#b58cff'];
const logoSpans = [...$('#brand h1').querySelectorAll('span')];
const LN = LOGO_COLORS.length;
let logoOffset = 0, slotGen = 0;
function paintLogo() { logoSpans.forEach((s, i) => { s.style.color = LOGO_COLORS[(logoOffset + i) % LN]; }); }
paintLogo();
// slot-machine spin on run: each letter cycles colours quickly, decelerates, and
// the reels lock left→right onto the new resting palette. Brief and brand-coloured.
function slotLogo() {
  logoOffset++;
  const gen = ++slotGen;
  logoSpans.forEach((span, i) => {
    const finalColor = LOGO_COLORS[(logoOffset + i) % LN];
    const stop = 360 + i * 100;     // reels stop staggered, left→right
    let elapsed = 0, k = 0;
    span.style.transition = 'none'; // instant flips while spinning
    const tick = () => {
      if (gen !== slotGen) return;  // a newer run superseded this spin
      if (elapsed >= stop) { span.style.transition = 'color .26s var(--ease)'; span.style.color = finalColor; return; }
      span.style.color = LOGO_COLORS[(k + i + 1) % LN];
      k++;
      const interval = 50 + elapsed * 0.22;   // decelerate
      elapsed += interval;
      setTimeout(tick, interval);
    };
    tick();
  });
}
function flash() {
  const el = $('#runbtn'); el.classList.add('lit'); clearTimeout(flashT);
  flashT = setTimeout(() => el.classList.remove('lit'), 220);
  slotLogo();                   // spin the wordmark like a slot machine
  $('#hint').hidden = true;     // "edit the pattern" hint has served its purpose
}

$('#runbtn').addEventListener('click', () => { run(); flash(); });
// the play/pause toggle doubles as the "stop the animation now" button, so it
// lights up solid (inverted) while live — an obvious, panic-friendly target.
function setPlaying(on) {
  playing = on;
  const b = $('#playbtn');
  b.classList.toggle('live', playing);
  b.dataset.tip = playing ? 'pause the animation' : 'resume';
  b.setAttribute('aria-label', playing ? 'pause' : 'play');
}
$('#playbtn').addEventListener('click', () => setPlaying(!playing));
setPlaying(playing);
$('#clearbtn').addEventListener('click', () => {
  particles.length = 0; ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H);
});
const decayLabel = $('#decayval');
function setDecay(v) { decayScale = Math.max(0.25, Math.min(6, v)); decayLabel.textContent = decayScale % 1 ? decayScale.toFixed(2) : decayScale.toString(); }
attachScrub($('#cpsnum'), { min: 0.1, max: 2, step: 0.05, get: () => cps, set: setCps });
attachScrub($('#persistnum'), { min: 0.25, max: 6, step: 0.05, get: () => decayScale, set: setDecay });
// double-click a number field to reset it to its default
$('#cpsnum').addEventListener('dblclick', () => setCps(0.6));
$('#persistnum').addEventListener('dblclick', () => setDecay(1.5));

const clockBtn = $('#clockbtn');
function renderClock() { clockBtn.classList.toggle('on', showClock); clockBtn.classList.toggle('off', !showClock); }
clockBtn.addEventListener('click', () => {
  showClock = !showClock;
  localStorage.setItem('loom.clock', showClock ? '1' : '0');
  renderClock();
});
renderClock();

// trace button removed for now; the mode stays off (renderer code remains, dormant)

function newPatch() {
  editor.value = DEFAULT_PATCH; refreshHL(); run(); setActive('');
  if (isMobile()) setSide(false);
}
$('#newbtn').addEventListener('click', newPatch);
$('#prenew').addEventListener('click', newPatch);   // the in-panel "+ new" button

$('#savebtn').addEventListener('click', () => {
  const cur = activeVal.startsWith('u:') ? activeVal.slice(2) : '';
  const name = (prompt('Save preset as:', cur) || '').trim();
  if (!name) return;
  const user = loadUser(); user[name] = editor.value; saveUser(user);
  rebuildPresetList(); setActive('u:' + name); syncURL();
});

// ── right sidebar (swappable presets / guide) ──
const side = $('#side');
const panes = [...side.querySelectorAll('.tabpane')];
const tabs = [...side.querySelectorAll('.tab')];
function showTab(name) {
  panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  localStorage.setItem('loom.sidetab', name);
}
// keep the top-right toolbar docked just left of the panel while it's open
function syncSideW() {
  const open = !side.classList.contains('hidden');
  document.documentElement.style.setProperty('--side-w', open ? side.offsetWidth + 'px' : '0px');
}
function setSide(open, tab) {
  if (tab) showTab(tab);
  side.classList.toggle('hidden', !open);
  document.body.classList.toggle('side-open', open);
  syncSideW();
  // highlight only the button for the tab that's actually showing (or neither when closed)
  const onGuide = open && !!side.querySelector('[data-pane="guide"]:not([hidden])');
  $('#panelbtn').classList.toggle('on', open && !onGuide);
  $('#helpbtn').classList.toggle('on', onGuide);
  localStorage.setItem('loom.side', open ? '1' : '0');
}
tabs.forEach((t) => t.addEventListener('click', () => setSide(true, t.dataset.tab)));
$('#sideclose').addEventListener('click', () => setSide(false));
// presets / guide each open the sidebar on their tab (and toggle it shut when already there)
const onTab = (name) => !side.classList.contains('hidden') && side.querySelector(`[data-pane="${name}"]:not([hidden])`);
$('#panelbtn').addEventListener('click', () => setSide(!onTab('presets'), 'presets'));
$('#helpbtn').addEventListener('click', () => setSide(!onTab('guide'), 'guide'));
// fully hide all chrome (⌘/Ctrl+Shift+H or ⌘/Ctrl+.) so the drawing has the whole
// screen; any of Escape / the same combo brings it back.
function setChromeHidden(on) { document.body.classList.toggle('chrome-hidden', on); }
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === '.' || ((e.shiftKey) && (e.key === 'H' || e.key === 'h')))) {
    e.preventDefault(); setChromeHidden(!document.body.classList.contains('chrome-hidden')); return;
  }
  if (e.key === 'Escape') {
    if (document.body.classList.contains('chrome-hidden')) { setChromeHidden(false); return; }
    setSide(false);
  }
});
const isMobile = () => window.matchMedia('(max-width:760px)').matches;
// tap the canvas (outside the sidebar and the control rail) to close the sidebar
document.addEventListener('pointerdown', (e) => {
  if (side.classList.contains('hidden')) return;
  if (side.contains(e.target) || e.target.closest('#rail, #toolbar')) return;
  setSide(false);
});

// resizable sidebar, drag the left-edge grabber; width persists in localStorage
const sideGrab = $('#sidegrab');
const SIDE_W_KEY = 'loom.sidewidth';
const clampSideW = (w) => Math.max(300, Math.min(window.innerWidth * 0.92, w));
const savedSideW = parseInt(localStorage.getItem(SIDE_W_KEY) || '', 10);
if (savedSideW) side.style.width = clampSideW(savedSideW) + 'px';
let sideDragging = false;
sideGrab.addEventListener('pointerdown', (e) => {
  sideDragging = true; sideGrab.classList.add('drag'); sideGrab.setPointerCapture(e.pointerId);
  document.body.style.userSelect = 'none'; e.preventDefault();
});
sideGrab.addEventListener('pointermove', (e) => {
  if (!sideDragging) return;
  side.style.width = clampSideW(window.innerWidth - e.clientX) + 'px';
  syncSideW();
});
sideGrab.addEventListener('pointerup', () => {
  if (!sideDragging) return;
  sideDragging = false; sideGrab.classList.remove('drag'); document.body.style.userSelect = '';
  localStorage.setItem(SIDE_W_KEY, parseInt(side.style.width, 10));
});

// ── fade the control overlay when idle, so the drawing has the screen ──
const rail = $('#rail');
const hintEl = $('#hint');
const toolbar = $('#toolbar');
let idleTimer;
function setIdle(on) { rail.classList.toggle('idle', on); hintEl.classList.toggle('idle', on); toolbar.classList.toggle('idle', on); }
function activity() {
  setIdle(false);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (document.activeElement !== editor) setIdle(true); }, 2600);
}
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, activity, { passive: true }));
editor.addEventListener('focus', () => { document.body.classList.add('editing'); activity(); });
editor.addEventListener('blur', () => { document.body.classList.remove('editing'); activity(); });
// mouse leaving the window → fade right away (unless we're mid-edit)
document.addEventListener('mouseleave', () => { if (document.activeElement !== editor) setIdle(true); });

// ── boot ────────────────────────────────────────────────────────────────────────────
// one-time photosensitivity disclosure, shown until acknowledged (saved in localStorage)
const warn = $('#warn');
const needsWarning = localStorage.getItem('loom.epilepsy') !== '1';
let engineStarted = false;
// only compile + start animating once the photosensitivity disclosure is acknowledged,
// so there's never an active (flashing) canvas behind the warning.
function startEngine() {
  if (engineStarted) return;
  engineStarted = true;
  run();
  activity();   // start the idle countdown
  requestAnimationFrame((t) => { lastT = t; frame(t); });
}
$('#warnok').addEventListener('click', () => { localStorage.setItem('loom.epilepsy', '1'); warn.hidden = true; startEngine(); });

DSL._setBgSink((c) => { bgSource = c; });   // bg("…") stores its (raw) arg here at compile time; resolved per-frame in tick
resize();
setCps(cps);
setDecay(decayScale);
rebuildPresetList();
showTab(localStorage.getItem('loom.sidetab') || 'presets');
setSide(localStorage.getItem('loom.side') !== '0');
// boot source priority: ?c=<custom> → ?p=<built-in> → last-worked-on → threads
const _params = new URLSearchParams(location.search);
const _urlC = _params.get('c'), _urlP = _params.get('p');
let _booted = false;
if (_urlC) { try { editor.value = b64d(_urlC); _booted = true; } catch { /* malformed link */ } }
else if (_urlP && PRESETS[_urlP]) { editor.value = PRESETS[_urlP]; setActive('b:' + _urlP); _booted = true; }
if (!_booted) {
  const saved = localStorage.getItem('loom.code');   // restore last-worked-on patch; threads if none
  editor.value = saved || PRESETS.threads;
  if (!saved) setActive('b:threads');
}
refreshHL();
// hold the engine behind the photosensitivity warning; startEngine() runs on ack
if (needsWarning) warn.hidden = false;
else startEngine();
