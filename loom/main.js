// main.js, the live-coding shell and the particle renderer.
//
// You type a pattern expression; we eval it (with the DSL in scope) into a
// Pattern. A clock advances cyclic time; each frame we query the pattern for the
// slice of time that just elapsed and spawn a glyph for every event onset. Glyphs
// bloom and fade as particles over a trailed canvas, so rhythm becomes geometry.

import { DSL } from './pattern.js';
import { GLRenderer } from './gl/renderer.js';
import { ensureRapier, rapierReady, PhysWorld } from './physics.js';
import { createEditor } from './editor.js';
import REFERENCE from './REFERENCE.md?raw';   // full cheatsheet text, for the "copy for LLM" button

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
const errBar = $('#err');
const cpsLabel = $('#cpsval');
const cpsRange = $('#cpsrange');       // speed/decay are inline range sliders; setCps/setDecay keep the thumb in sync
const decayRange = $('#decayrange');

// ── the code editor (CodeMirror 6; see editor.js) ────────────────────────────────────
// Drives like the old textarea via a small API: editor.getCode() / setCode() / insert() /
// focus() / hasFocus(). ⌘↵ runs; tab inserts spaces; highlighting + undo are built in.
const editor = createEditor($('#editwrap'), {
  onRun: () => { run(); flash(); },
  onFocus: (focused) => { document.body.classList.toggle('editing', focused); activity(); },
  rerun: () => run(),   // inline slider drags re-run live (no flash)
});

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
let activeGroupFx = new Map();   // gid → fx for the running patch; live glyphs read their group's CURRENT fx
const physWorlds = new Map();    // pid → PhysWorld (lazy; one rapier2d world per physics() group)
let activePhys = new Map();      // pid → opts for the running patch (params resolved per frame)
const GBASE = 2000;              // gravity multiplier 1 → px/s² downward (tuned for screen scale)
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
const pointerState = { x: 0.5, y: 0.5, down: 0 };   // live pointer, mirrored to the mouseX/Y signals + editor badges

const particles = [];

// ── compile user code into a Pattern ──────────────────────────────────────────────
let activeLayers = [];   // names of the running patch's $(...) layers (substrate for the mixer)
// live mute / solo: layers are skipped at DRAW time (not spawn), so toggling hides/shows
// glyphs already on screen instantly and unmute is immediate. Solo wins over mute.
const mutedLayers = new Set();
const soloLayers = new Set();
const anyLayerHidden = () => soloLayers.size > 0 || mutedLayers.size > 0;
function audible(name) {
  if (soloLayers.size) return name != null && soloLayers.has(name);   // solo isolates (bare glyphs hidden too)
  return !(name != null && mutedLayers.has(name));
}
function compile(code) {
  DSL._resetGroups();                    // stable group ids by creation order (live-FX diffing)
  DSL._resetLayers();                    // $(...) layer registry, collected below
  DSL._resetPhysics();                   // physics() group registry (stable pids → live world editing)
  const names = Object.keys(DSL);
  const vals = names.map((k) => DSL[k]);
  let result;
  try {
    // Bare-expression patch (or a single $() call): wrap so `stack(...)` evaluates to a value.
    result = new Function(...names, `"use strict";\nreturn (\n${code}\n);`)(...vals);
  } catch (e) {
    // A multi-line $-layer patch is several statements, not one expression — that's a
    // parse error in expression mode (thrown at construction, before any code runs, so no
    // double side effects). Re-run as a statement block; the $() calls register as we go.
    if (!(e instanceof SyntaxError)) throw e;
    new Function(...names, `"use strict";\n${code}`)(...vals);
    result = null;
  }
  // If the patch used $(...), it IS the stack of those layers (a bare top-level value is
  // ignored — don't nest $ inside other combinators). Otherwise it's the bare expression.
  const layers = DSL._getLayers();
  if (layers.length) {
    activeLayers = layers.map((l) => l.name);
    return layers.length === 1 ? layers[0].pat : DSL.stack(...layers.map((l) => l.pat));
  }
  activeLayers = [];
  if (!result || typeof result.query !== 'function') throw new Error('expression did not evaluate to a pattern');
  return result;
}

function run() {
  try {
    bgSource = DEFAULT_BG;                // bg("…") in the patch overrides this during compile
    pattern = compile(editor.getCode());
    // Soft re-run: keep the live glyphs so editing the patch doesn't blank the screen.
    // Group ids are stable by creation order, so each frame the live glyphs re-read their
    // group's CURRENT fx (see the tick loop) — editing/removing an effect line applies to
    // glyphs already on screen, no wipe and no waiting for them to decay. Their CONTENT
    // (shape/colour/…) stays as captured at spawn, so it still cross-fades as new glyphs
    // take over. A hard reset is still a click away (clear/new buttons), and switching
    // preset/new wipes explicitly. On a compile error we keep the old patch + its fx map
    // untouched (the snapshot below and `pattern` are only updated on success).
    activeGroupFx = new Map(DSL._groupFx);
    // echo() generation cap: this compile mints one new generation per echo family, so
    // keep at most cap-1 of the existing (older) generations and drop the rest now — a
    // hard cap so accumulating effects can't pile up unbounded.
    for (const { fam, cap } of DSL._echoGroups) {
      const gens = [...new Set(particles.filter((p) => p.echoFam === fam).map((p) => p.gid))].sort((a, b) => b - a);
      if (gens.length > cap - 1) {
        const keep = new Set(gens.slice(0, Math.max(0, cap - 1)));
        for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; if (p.echoFam === fam && !keep.has(p.gid)) particles.splice(i, 1); }
      }
    }
    // drop mute/solo state for layers the new patch no longer has, then refresh the chips
    // (mute on a still-present layer persists across a live ⌘⏎ re-run; preset/new clears it).
    for (const set of [mutedLayers, soloLayers]) for (const nm of [...set]) if (!activeLayers.includes(nm)) set.delete(nm);
    renderLayerChips();
    // physics: snapshot the patch's physics() groups + their (patternable) params. Kick the
    // lazy Rapier load on first use; drop worlds for physics groups the patch no longer has.
    activePhys = new Map(DSL._physReg);
    if (activePhys.size) ensureRapier();
    for (const pid of [...physWorlds.keys()]) if (!activePhys.has(pid)) { physWorlds.get(pid).dispose(); physWorlds.delete(pid); }
    errBar.textContent = '';
    errBar.classList.remove('show');
    localStorage.setItem('loom.code', editor.getCode());
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

  // springs: stateful per-glyph modifiers. Capture initial state (start AT the target's
  // birth value so there's no spawn jolt) + the spring constants; tick() integrates them
  // each frame into p._spr, which resolvePos / glResolve read. A spring also makes
  // position live (so resolvePos re-runs) and gives the base field a clean number (numAt
  // would otherwise hand the spring object straight through and NaN it).
  const springs = [];
  const sprInit = {};
  for (const f of SPRING_FIELDS) if (isSpring(v[f])) {
    const sd = v[f].__spring;
    const x0 = numAt(sd.target, 0, phase, elapsed, 0, cycle);
    springs.push({ field: f, target: sd.target, k: sd.k, d: sd.d, x: x0, v: 0 });
    sprInit[f] = x0;
  }
  const baseNum = (f, def) => (sprInit[f] != null ? sprInit[f] : numAt(v[f] != null ? v[f] : def, 0, phase));

  // position inputs may be numbers or live oscillators, recomputed each frame
  // only when one is an osc/spring; otherwise the spawn position stands. A physics body
  // owns its own position (the sim drives x/y), so live-position resolution is off for it —
  // x/y/radius/angle only set the spawn POINT.
  const pin = { x: v.x, y: v.y, radius: v.radius, angle: v.angle, gridX: v.gridX, gridY: v.gridY, pan: v.pan, phase };
  const posLive = !v._pid && (isOsc(v.x) || isOsc(v.y) || isOsc(v.radius) || isOsc(v.angle) || isOsc(v.gridX) || isOsc(v.gridY) || isOsc(v.pan)
    || springs.some((s) => SPRING_POS.has(s.field)));

  // scalar/colour controls that are oscillators keep running over the lifetime
  const mods = [];
  for (const f of MOD_FIELDS) if (isOsc(v[f])) mods.push({ field: f, osc: freezeOscParams(v[f].__osc, onset) });

  const p = {
    pin, posLive, jx, jy, phase,
    shape: v.shape || 'dot',
    color: isOsc(v.color) ? oscColor(freezeOscParams(v.color.__osc, onset), 0, phase) : resolveColor(v.color, phase),
    size: baseNum('size', 0.06) * minDim,
    rotTurns: baseNum('rotate', 0),       // Z, turns
    rotX: baseNum('rotateX', 0) * TAU,     // tilt (radians)
    rotY: baseNum('rotateY', 0) * TAU,
    spin: (v.spin != null ? v.spin : 0) * TAU,                 // turns/sec (Z), age-driven
    fill: v.fill != null ? v.fill : 1,
    stroke: v.stroke != null ? v.stroke : 0,
    vertex: v.vertex != null ? v.vertex : 0,
    weight: baseNum('weight', 0.006),
    outline: (sprInit.outline != null || v.outline != null) ? baseNum('outline', 0) : null,   // stroke as a fraction of radius (overrides weight)
    // 3D shading amount. 3D primitives (cube/sphere/torus/octa, id 11–14) default
    // to a matte shaded look so they read as 3D (like a p5 sphere); 2D shapes stay
    // flat (0). Override either way with .shade(n).
    shade: sprInit.shade != null ? sprInit.shade : numAt(v.shade != null ? v.shade : (SHAPE_ID[v.shape] >= 11 ? 0.85 : 0), 0, phase),
    cap: v.cap || 'square',
    join: v.join || 'miter',
    open: baseNum('open', 0),
    alpha: baseNum('alpha', 1),
    blend: v.blend || 'source-over',
    age: 0,
    ageCycles: 0,              // age in CYCLES, accumulated per frame → tempo-synced oscs survive a live cps change
    attack: v.attack != null ? v.attack : 0.06,
    // fade-out seconds; default ~1 cycle. The master slider is baked in HERE so
    // each glyph keeps the decay it was born with.
    decay: ((v.decay != null ? v.decay : 1.0) / cps) * decayScale,
    // optional Penner curve names for the attack/decay envelope segments (else linear)
    attackEase: v.attackEase || null,
    decayEase: v.decayEase || null,
    mods: mods.length ? mods : null,
    springs: springs.length ? springs : null,             // [{field,target,k,d,x,v}] integrated in tick()
    _spr: springs.length ? { ...sprInit } : null,         // field → current spring value (read by resolvePos/glResolve)
    spawnT: elapsed,           // global seconds at spawn → osc().drift() (free) reads this
    spawnCycle: cycle,         // global cycle at spawn → osc().drift() (synced) reads this
    gid: v._gid || 0,          // group layer id (0 = ungrouped, drawn to main canvas)
    fx: v._fx || null,         // group effect params (e.g. { pixelate })
    echoFam: v._echoFam || 0,  // echo() family (0 = not an echo layer); gid is its frozen generation
    echoCap: v._echoCap || 0,  // max generations to keep for this family
    layer: v._layer || null,   // $(...) layer name (null = ungrouped) → live mute/solo
    pid: v._pid || 0,          // physics() group id (0 = not a body); body created lazily in tick
    body: null,                // rapier rigid body handle once created
    physRot: 0,                // body rotation (rad), synced from the sim each frame
  };
  const xy = resolvePos(p, minDim, 0);
  p.x = xy[0]; p.y = xy[1];
  particles.push(p);
}

// hard-clear all live glyphs (clear button / preset switch / new). Must also free any
// rapier bodies first, or they'd be orphaned in the world and keep colliding invisibly.
function clearParticles() {
  for (const p of particles) if (p.body && p.pid) { const wd = physWorlds.get(p.pid); if (wd) wd.remove(p.body); }
  particles.length = 0;
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
const isSpring = DSL.isSpring;
const applyEase = DSL.ease;   // named Penner curve, 0..1 → 0..1 (shared with pattern.js)
const MOD_FIELDS = ['size', 'color', 'rotate', 'rotateX', 'rotateY', 'open', 'alpha', 'weight', 'outline', 'shade'];
// fields a .spring() can drive: position (resolved in resolvePos) + the scalar mods
// (resolved in glResolve/drawGlyph). NOT color (non-scalar). Each holds per-glyph state.
const SPRING_FIELDS = ['x', 'y', 'radius', 'angle', 'pan', 'size', 'rotate', 'rotateX', 'rotateY', 'open', 'alpha', 'weight', 'outline', 'shade'];
const SPRING_POS = new Set(['x', 'y', 'radius', 'angle', 'pan']);
const _h1 = (x) => { const s = Math.sin((x + 0.123) * 12.9898) * 43758.5453; return s - Math.floor(s); };
const _snoise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return _h1(i) * (1 - u) + _h1(i + 1) * u; };
const _fbm = (x) => { let s = 0, a = 1, fr = 1, n = 0; for (let o = 0; o < 4; o++) { s += _snoise(x * fr) * a; n += a; fr *= 2; a *= 0.5; } return s / n; };
// 2D value noise + its curl, for the turbulence force-field (a divergence-free flow, so
// bodies swirl along streamlines instead of all draining one way).
function _noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
const _curl2 = (x, y) => {                       // ∇×φ in 2D = (∂φ/∂y, −∂φ/∂x)
  const e = 0.1;
  return [(_noise2(x, y + e) - _noise2(x, y - e)) / (2 * e), -(_noise2(x + e, y) - _noise2(x - e, y)) / (2 * e)];
};
function evalOsc(d, age, gp = 0, st = 0, ageC = null, stC = null) {
  // every parameter may itself be an oscillator → cross-modulation (FM via rate,
  // PM via phase, AM via range lo/hi). gp = the glyph's onset phase. The osc's running
  // time is measured in CYCLES by default (rate is cycles-per-cycle), so the drawn
  // structure is the same at any tempo. ageC/stC are the cycle-accumulated age and spawn
  // cycle — passed by live callers so a tempo change doesn't retroactively warp anything;
  // they fall back to age*cps for frozen/initial evaluation. .free() switches back to real
  // seconds (rate in Hz). phase/spread are already cycle-relative, so they're unscaled.
  let v;
  if (d.env) {
    // attack/decay envelope keyed to the glyph's REAL-time age (seconds): 0→1 over `a`,
    // then 1→0 over `de`, each segment optionally Penner-eased. Animates over the glyph's
    // life like an osc; routes into any param. (alpha is also × the lifetime envelope.)
    const a = numAt(d.env.a, age, gp, st, ageC, stC), de = numAt(d.env.d, age, gp, st, ageC, stC);
    if (age < a) { const tt = a > 0 ? age / a : 1; v = d.env.ei ? applyEase(d.env.ei, tt) : tt; }
    else { const tt = de > 0 ? (age - a) / de : 1; const rem = tt < 1 ? 1 - tt : 0; v = d.env.eo ? applyEase(d.env.eo, rem) : rem; }
    v = v < 0 ? 0 : v > 1 ? 1 : v;
  } else {
    const trun = d.free ? age : (ageC != null ? ageC : age * cps);
    const tdrift = d.free ? st : (stC != null ? stC : st * cps);
    const rate = numAt(d.rate, age, gp, st, ageC, stC);
    const t = trun * rate + numAt(d.phase || 0, age, gp, st, ageC, stC) + numAt(d.spread || 0, age, gp, st, ageC, stC) * gp + numAt(d.drift || 0, age, gp, st, ageC, stC) * tdrift;
    const f = t - Math.floor(t);
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
  }
  if (d.ease) v = applyEase(d.ease, v);                   // shape the 0..1 waveform BEFORE range
  const lo = numAt(d.lo, age, gp, st, ageC, stC), hi = numAt(d.hi, age, gp, st, ageC, stC);
  let r = lo + v * (hi - lo);
  if (d.ops) for (const [op, x] of d.ops) {            // .add/.sub/.mul/.div/.quantize (x may be an osc)
    const y = numAt(x, age, gp, st, ageC, stC);
    r = op === '*' ? r * y : op === '+' ? r + y : op === '-' ? r - y : op === '/' ? r / y : op === 'q' ? Math.round(r * y) / y : r;
  }
  return r;
}
const numAt = (a, age, gp = 0, st = 0, ageC = null, stC = null) => (isOsc(a) ? evalOsc(a.__osc, age, gp, st, ageC, stC) : a);
// freeze SIGNAL-valued osc params to their value at the glyph's onset, so a live osc can be based
// on a per-glyph signal: osc(r).range(note(1), note(1).add(.1)) keeps the waveform LIVE but
// captures the note's hue ONCE at spawn (numAt only evals numbers/oscs, so a raw signal param
// would NaN). Nested oscs stay live (recursed); numbers pass through untouched.
function freezeOscParams(o, onset) {
  const fp = (x) => {
    if (isOsc(x)) return { __osc: freezeOscParams(x.__osc, onset) };
    if (x instanceof DSL.Pattern) { for (const h of x.query(DSL.span(onset, onset))) if (h.value != null) return +h.value; return 0; }
    return x;
  };
  const r = { ...o };
  for (const k of ['rate', 'lo', 'hi', 'phase', 'spread', 'drift']) if (r[k] != null) r[k] = fp(r[k]);
  if (r.ops) r.ops = r.ops.map(([op, x]) => [op, fp(x)]);
  if (r.env) r.env = { ...r.env, a: fp(r.env.a), d: fp(r.env.d) };   // env(attack, decay) bounds may be per-glyph signals
  return r;
}
// resolve an oscillator-driven colour: through a palette if attached, else as hue
const oscColor = (d, age, gp, st = 0, ageC = null, stC = null) => (d.pal ? interpPal(d.pal, evalOsc(d, age, gp, st, ageC, stC)) : resolveColor(evalOsc(d, age, gp, st, ageC, stC), gp));

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
const oscColorRGB = (d, age, gp, st = 0, ageC = null, stC = null) => (d.pal ? interpPalRGB(d.pal, evalOsc(d, age, gp, st, ageC, stC)) : resolveColorRGB(evalOsc(d, age, gp, st, ageC, stC), gp));
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
const SHAPE_ID = { dot: 0, circle: 0, ring: 1, arc: 2, square: 3, box: 3, tri: 4, pent: 5, hex: 6, star: 7, plus: 8, line: 9, cross: 10,
  // 3D raymarched shapes (normal-shaded, tumbled by rotateX/rotateY/spin)
  cube: 11, box3: 11, sphere: 12, ball: 12, torus: 13, donut: 13, octa: 14, octahedron: 14,
  // imported FBX meshes (renderer maps id >= 15 to a model, lazy-loaded on first use)
  bong: 15, knot: 16, amongus: 17, sus: 17, balloons: 18, balloon: 18, chain: 19 };
const OUTLINE_IDS = new Set([1, 2, 9, 10]);
const CAP_ID = { round: 0, butt: 1, square: 2 };   // line/cross caps (spawn defaults cap to 'square')
const JOIN_ID = { miter: 0, round: 1, bevel: 2 };  // polygon corners (default miter = sharp)
function glResolve(p, minDim, out) {
  const age = p.age, ageC = p.ageCycles, stC = p.spawnCycle;
  let sizePx = p.size, rotTurns = p.rotTurns, rotX = p.rotX, rotY = p.rotY, open = p.open, alpha = p.alpha, weight = p.weight, olw = p.outline, shade = p.shade, color = null;
  if (p.mods) for (const m of p.mods) {
    const val = evalOsc(m.osc, age, p.phase, p.spawnT, ageC, stC);
    if (m.field === 'size') sizePx = val * minDim;
    else if (m.field === 'color') color = oscColorRGB(m.osc, age, p.phase, p.spawnT, ageC, stC);
    else if (m.field === 'rotate') rotTurns = val;
    else if (m.field === 'rotateX') rotX = val * TAU;
    else if (m.field === 'rotateY') rotY = val * TAU;
    else if (m.field === 'open') open = val;
    else if (m.field === 'alpha') alpha = val;
    else if (m.field === 'weight') weight = val;
    else if (m.field === 'outline') olw = val;
    else if (m.field === 'shade') shade = val;
  }
  if (p._spr) {                                          // springs (state integrated in tick), same field→unit mapping as mods
    const s = p._spr;
    if (s.size != null) sizePx = s.size * minDim;
    if (s.rotate != null) rotTurns = s.rotate;
    if (s.rotateX != null) rotX = s.rotateX * TAU;
    if (s.rotateY != null) rotY = s.rotateY * TAU;
    if (s.open != null) open = s.open;
    if (s.alpha != null) alpha = s.alpha;
    if (s.weight != null) weight = s.weight;
    if (s.outline != null) olw = s.outline;
    if (s.shade != null) shade = s.shade;
  }
  if (!color) { if (!p._rgb) p._rgb = cssToRGB(p.color); color = p._rgb; }
  out.x = p.x; out.y = p.y;
  out.r = sizePx;
  out.rot = rotTurns * TAU + p.spin * age + p.physRot;   // physRot = rigid-body tumble (0 for non-physics)
  out.rotX = rotX; out.rotY = rotY;
  out.rgb = color;
  out.alpha = Math.max(0, Math.min(1, alpha * p._env));
  out.weight = olw != null ? Math.max(0.75, olw * sizePx) : Math.max(0.75, weight * minDim);
  out.shade = shade;
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
  if (isOsc(param)) return evalOsc(param.__osc, elapsed, 0, 0, cycle, 0);   // cycle = tempo-synced time
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
  if (isOsc(src)) return oscColor(src.__osc, elapsed, 0, 0, cycle, 0);   // cycle = tempo-synced time
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
  const st = p.spawnT || 0;                            // spawn time → osc().drift() (free)
  const ageC = p.ageCycles, stC = p.spawnCycle;        // cycle-time → tempo-synced oscs
  const sp = p._spr;                                   // spring values, pre-integrated in tick()
  // gv: a spring field reads its integrated value; otherwise sample the control (osc/number).
  const gv = (name, raw) => (sp && sp[name] != null ? sp[name] : numAt(raw, age, phase, st, ageC, stC));
  let px, py;
  if (gridX != null) {                                 // grid: cell from onset phase
    const cols = Math.max(1, Math.round(numAt(gridX, age, phase, st, ageC, stC)));
    const rows = Math.max(1, Math.round(numAt(gridY != null ? gridY : gridX, age, phase, st, ageC, stC)));
    const cell = Math.min(cols * rows - 1, Math.floor((((phase % 1) + 1) % 1) * cols * rows));
    px = ((cell % cols) + 0.5) / cols * W;
    py = ((Math.floor(cell / cols) % rows) + 0.5) / rows * H;
  } else {
    px = (x != null ? gv('x', x) : 0.5) * W;
    py = (y != null ? gv('y', y) : 0.5) * H;
  }
  const defR = (gridX == null && x == null && y == null && radius == null) ? 0.34 : 0;
  const rad = (radius != null ? gv('radius', radius) : defR) * minDim;
  if (rad !== 0) {
    const ang = (angle != null ? gv('angle', angle) : phase) * TAU - Math.PI / 2;
    px += Math.cos(ang) * rad;
    py += Math.sin(ang) * rad;
  }
  if (pan != null) px += (gv('pan', pan) - 0.5) * W * 0.42;
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

// physics collider for a glyph shape: a tight convex polygon for the polygons (built from
// the same vertices we draw), a box for squares, a ball for round / outline / 3D shapes.
// The hull matches the drawn shape, so triangles/hexes wedge and pack instead of rolling
// and gapping like discs (a ball circumscribes a triangle very loosely).
function bodyCollider(name, rPx) {
  const id = SHAPE_ID[name];
  if (id === 3) return { kind: 'cuboid', hx: rPx, hy: rPx };               // square / box
  if (id === 4 || id === 5 || id === 6 || id === 7 || id === 8) {          // tri / pent / hex / star / plus
    const path = shapeGeom(name, rPx, 0).paths[0];
    const pts = new Float32Array(path.length * 2);
    for (let i = 0; i < path.length; i++) { pts[i * 2] = path[i][0]; pts[i * 2 + 1] = path[i][1]; }
    return { kind: 'hull', pts, r: rPx };                                  // r = ball fallback if degenerate
  }
  return { kind: 'ball', r: rPx };                                         // dot/circle/ring/arc/line/cross/3D/mesh
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
  const age = p.age, ageC = p.ageCycles, stC = p.spawnCycle;
  let sizePx = p.size, color = p.color, rotTurns = p.rotTurns,
      rotX = p.rotX, rotY = p.rotY, open = p.open, alpha = p.alpha, weight = p.weight, olw = p.outline;
  if (p.mods) for (const m of p.mods) {
    const val = evalOsc(m.osc, age, p.phase, p.spawnT, ageC, stC);
    if (m.field === 'size') sizePx = val * minDim;
    else if (m.field === 'color') color = oscColor(m.osc, age, p.phase, p.spawnT, ageC, stC);
    else if (m.field === 'rotate') rotTurns = val;
    else if (m.field === 'rotateX') rotX = val * TAU;
    else if (m.field === 'rotateY') rotY = val * TAU;
    else if (m.field === 'open') open = val;
    else if (m.field === 'alpha') alpha = val;
    else if (m.field === 'weight') weight = val;
    else if (m.field === 'outline') olw = val;
  }
  if (p._spr) {                                          // springs (state integrated in tick)
    const s = p._spr;
    if (s.size != null) sizePx = s.size * minDim;
    if (s.rotate != null) rotTurns = s.rotate;
    if (s.rotateX != null) rotX = s.rotateX * TAU;
    if (s.rotateY != null) rotY = s.rotateY * TAU;
    if (s.open != null) open = s.open;
    if (s.alpha != null) alpha = s.alpha;
    if (s.weight != null) weight = s.weight;
    if (s.outline != null) olw = s.outline;
  }
  g.save();
  g.translate(p.x, p.y);
  g.globalCompositeOperation = p.blend;
  g.globalAlpha = Math.max(0, Math.min(1, alpha * p._env));
  g.fillStyle = color; g.strokeStyle = color;
  const zRot = rotTurns * TAU + p.spin * age + p.physRot;   // physRot = rigid-body tumble (0 for non-physics)
  const lw = olw != null ? Math.max(0.75, olw * sizePx) : Math.max(0.75, weight * minDim);
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
  DSL._jugDecay(dt);   // age the juggling throw/catch/tap pulses (decays even when paused)
  DSL._midiFrame();    // snapshot this frame's MIDI note-ons for onNote() (one glyph per note)
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
    p.ageCycles += dt * cps;                          // accumulates at the live tempo (no retroactive warp)
    if (p.age >= p.attack + p.decay) {                // expired → drop (and free its body)
      if (p.body && p.pid) { const wd = physWorlds.get(p.pid); if (wd) wd.remove(p.body); p.body = null; }
      continue;
    }
    // attack rises 0→1, decay falls 1→0; an optional Penner curve shapes either
    // segment. For decay we ease the "amount remaining" (1−t) so the curve reads as
    // the shape of the fade. Clamp to 0..1: env drives alpha, so overshoot (outBack/
    // elastic) flat-tops rather than blowing out. (Future: route overshoot into a
    // size pop for a true bounce-in — see ROADMAP.)
    let env;
    if (p.age < p.attack) {
      const t = p.attack > 0 ? p.age / p.attack : 1;
      env = p.attackEase ? applyEase(p.attackEase, t) : t;
    } else {
      const t = (p.age - p.attack) / p.decay;
      env = p.decayEase ? applyEase(p.decayEase, 1 - t) : 1 - t;
    }
    p._env = Math.max(0, Math.min(1, env));
    p._a = p._env * p.alpha;                           // for trace mode
    // springs: integrate each glyph's {x,v} toward its (live) target this frame, with
    // semi-implicit Euler + substeps so stiff springs stay stable at large dt. Filled
    // into p._spr for resolvePos / glResolve to read. Must run before resolvePos below.
    if (p.springs) {
      const sub = Math.min(8, Math.max(1, Math.ceil(dt / 0.008)));
      const h = dt / sub;
      for (const s of p.springs) {
        const tgt = numAt(s.target, p.age, p.phase, p.spawnT, p.ageCycles, p.spawnCycle);
        for (let k = 0; k < sub; k++) {
          s.v += (s.k * (tgt - s.x) - s.d * s.v) * h;
          s.x += s.v * h;
        }
        if (!Number.isFinite(s.x)) { s.x = tgt; s.v = 0; }   // guard absurd constants
        p._spr[s.field] = s.x;
      }
    }
    if (p.posLive) { const r = resolvePos(p, minDim, p.age); p.x = r[0]; p.y = r[1]; }
    particles[w++] = p;
    live.push(p);
  }
  particles.length = w;

  // Live FX: re-point each glyph's group fx to the running patch's CURRENT fx for its gid
  // (stable by group order). Editing an effect line updates what the on-screen glyphs
  // render with; a removed group → no fx. Content stays as captured, so it still
  // cross-fades. Cheap: one map lookup per live glyph.
  for (let i = 0; i < live.length; i++) { const p = live[i]; if (p.echoFam) continue; p.fx = p.gid ? (activeGroupFx.get(p.gid) || null) : null; }

  // physics: lazy rigid-body sim. One rapier2d world per physics() group; params resolved
  // against global time each frame (so gravity/bounce/… can be patterns/oscs). Bodies are
  // created for physics glyphs once Rapier + the world exist (so unloaded/just-spawned
  // glyphs simply sit at their spawn point until then); after stepping, the body transforms
  // are written back into x/y/rotation. Loom owns spawn + lifetime; the sim owns position.
  if (activePhys.size && rapierReady()) {
    const R = rapierReady();
    const fields = new Map();                          // pid → resolved force-field params (once/frame)
    for (const [pid, opts] of activePhys) {
      let wd = physWorlds.get(pid);
      if (!wd) physWorlds.set(pid, wd = new PhysWorld(R));
      wd.setBounds(W, H);
      const gmul = evalGlobal(opts.gravity != null ? opts.gravity : 1, cycle, elapsed);
      const wind = evalGlobal(opts.windx != null ? opts.windx : 0, cycle, elapsed);
      wd.setGravity(wind * GBASE, gmul * GBASE);
      wd.setBounce(Math.max(0, Math.min(1, evalGlobal(opts.bounce != null ? opts.bounce : 0.6, cycle, elapsed))));
      // force-fields (all patternable): attract/swirl pull toward / orbit a point (ax,ay);
      // turbulence is a curl-noise flow. Resolved once per group, applied per body below.
      fields.set(pid, {
        attract: evalGlobal(opts.attract != null ? opts.attract : 0, cycle, elapsed),
        swirl: evalGlobal(opts.swirl != null ? opts.swirl : 0, cycle, elapsed),
        turb: evalGlobal(opts.turbulence != null ? opts.turbulence : 0, cycle, elapsed),
        tscale: evalGlobal(opts.turbScale != null ? opts.turbScale : 3, cycle, elapsed),
        cx: evalGlobal(opts.ax != null ? opts.ax : 0.5, cycle, elapsed) * W,
        cy: evalGlobal(opts.ay != null ? opts.ay : 0.5, cycle, elapsed) * H,
      });
    }
    for (const p of live) {                            // give each new physics glyph a body
      if (!p.pid || p.body) continue;
      const wd = physWorlds.get(p.pid); if (!wd) continue;
      const opts = activePhys.get(p.pid) || {};
      const speed = evalGlobal(opts.vel != null ? opts.vel : 0, cycle, elapsed) * minDim;   // vel 1 ≈ minDim px/s
      const a = Math.random() * TAU;
      const av = evalGlobal(opts.spin != null ? opts.spin : 0, cycle, elapsed) * (Math.random() - 0.5) * 2 * TAU;
      const drag = Math.max(0, evalGlobal(opts.drag != null ? opts.drag : 0.05, cycle, elapsed));
      p.body = wd.addBody(p.x, p.y, Math.cos(a) * speed, Math.sin(a) * speed, av, drag, bodyCollider(p.shape, p.size));
    }
    for (const p of live) {                            // force-fields → per-body acceleration
      if (!p.pid || !p.body) continue;
      const f = fields.get(p.pid); if (!f || (!f.attract && !f.swirl && !f.turb)) continue;
      let ax = 0, ay = 0;
      if (f.attract || f.swirl) {
        const dx = f.cx - p.x, dy = f.cy - p.y, d = Math.hypot(dx, dy) || 1;
        if (f.attract) { ax += f.attract * GBASE * dx / d; ay += f.attract * GBASE * dy / d; }   // toward point (−repels)
        if (f.swirl)   { ax += f.swirl * GBASE * -dy / d; ay += f.swirl * GBASE * dx / d; }       // tangential (orbit)
      }
      if (f.turb) {
        const c = _curl2(p.x / minDim * f.tscale + elapsed * 0.15, p.y / minDim * f.tscale);
        ax += f.turb * GBASE * c[0]; ay += f.turb * GBASE * c[1];
      }
      physWorlds.get(p.pid).applyAccel(p.body, ax, ay, dt);
    }
    for (const wd of physWorlds.values()) wd.step(dt);
    for (const p of live) {                            // sim → glyph transform
      if (!p.pid || !p.body) continue;
      const wd = physWorlds.get(p.pid); if (!wd) continue;
      const r = wd.read(p.body); p.x = r.x; p.y = r.y; p.physRot = r.rot;
    }
  }

  // mute / solo: drop muted (or non-soloed) $-layer glyphs from what gets drawn this
  // frame. Skipping at draw time (not spawn) means toggling hides/shows on-screen glyphs
  // instantly and they keep aging, so unmute is immediate. (Glyphs still spawn + decay.)
  const vis = anyLayerHidden() ? live.filter((p) => audible(p.layer)) : live;

  // trace mode: thread a line through the live points in spawn order, behind
  // the glyphs, rhythm becomes a connected path / constellation.
  if (traceMode && vis.length > 1 && !USE_GL) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = Math.max(1, 0.0014 * minDim);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < vis.length; i++) {
      const a = vis[i - 1], b = vis[i];
      ctx.globalAlpha = Math.min(a._a, b._a) * 0.6;
      ctx.strokeStyle = b.color;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // draw glyphs (newest on top, since live is oldest→newest). Ungrouped glyphs
  // go straight to the main canvas; grouped glyphs render to a per-group buffer
  // so a layer effect (pixelate) can be applied before compositing. `vis` excludes
  // muted / non-soloed layers.
  if (USE_GL) {
    glr.render({ live: vis, minDim, resolve: glResolve, evalGlobal, elapsed, W, H, cycle, showClock, traceMode });
  } else {
    const buckets = new Map();   // gid -> particle[]
    for (const p of vis) {
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
window.loom = { tick, step: (n = 60, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); }, particles, setDecay: (v) => { decayScale = v; }, setCps, glr,
  get layers() { return activeLayers.slice(); }, get muted() { return [...mutedLayers]; }, get soloed() { return [...soloLayers]; },
  mute: (n) => toggleMute(n), solo: (n) => toggleSolo(n),
  ensurePhysics: () => ensureRapier(), physReady: () => !!rapierReady(),
  get bodies() { return particles.filter((p) => p.body).length; }, get pointer() { return pointerState; },
  midi: (status, d1, d2, dev) => DSL._midiInput(status, d1, d2, dev),   // inject a MIDI message (for tooling/testing; `dev` = optional device name for dev() scope)
  jug: (m) => DSL._jugInput(m),   // inject a juggling-feed message (for tooling/testing)
  // current value of a signal fn (cc/gate/vel/note/pc/bend/ballX/…) — drives the editor live badges
  sig: (name, ...args) => { try { const fn = DSL[name]; if (typeof fn !== 'function') return null; const h = fn(...args).query(DSL.span(0, 0)); return h.length ? +h[0].value : 0; } catch { return null; } },
  feed: {   // juggling-feed config (host:port, on/off, selfie flip, camera overlay) — persists
    get host() { return feedHost; },
    set host(h) { feedHost = h; localStorage.setItem(FEED_HOST_KEY, h); applyVideo(); if (feedOn) feedReset(); syncFeedUI(); },
    get enabled() { return feedOn; },
    set enabled(v) { feedOn = !!v; localStorage.setItem(FEED_ON_KEY, v ? '1' : '0'); if (v) { localStorage.setItem('loom.feedShow', '1'); const b = $('#feedbtn'); if (b) b.hidden = false; feedConnect(); } else if (feedWS) { try { feedWS.close(); } catch {} } setFeedStatus(); syncFeedUI(); },
    get connected() { return !!feedWS && feedWS.readyState === 1; },
    get flipX() { return DSL._jug.flipX; },
    set flipX(v) { DSL._jug.flipX = !!v; localStorage.setItem(FEED_FLIP_KEY, v ? '1' : '0'); applyVideo(); syncFeedUI(); },
    get video() { return feedVideo; },
    set video(v) { feedVideo = !!v; localStorage.setItem(FEED_VID_KEY, v ? '1' : '0'); applyVideo(); syncFeedUI(); },
    get balls() { return DSL._jug.balls; } } };

// ── $-layer mute / solo chips ───────────────────────────────────────────────────────
// One chip per live $ layer: click the name to mute (dimmed + struck), click the dot to
// solo (isolate). Both toggle live — the renderer skips muted/non-soloed layers per frame,
// so on-screen glyphs hide/show instantly. Hidden entirely for a bare (no-$) patch.
const layersEl = $('#layers');
function toggleMute(name) { if (!activeLayers.includes(name)) return; mutedLayers.has(name) ? mutedLayers.delete(name) : mutedLayers.add(name); renderLayerChips(); }
function toggleSolo(name) { if (!activeLayers.includes(name)) return; soloLayers.has(name) ? soloLayers.delete(name) : soloLayers.add(name); renderLayerChips(); }
function renderLayerChips() {
  if (!layersEl) return;
  if (!activeLayers.length) { layersEl.hidden = true; layersEl.innerHTML = ''; return; }
  layersEl.hidden = false;
  layersEl.innerHTML = '';
  const solo = soloLayers.size > 0;
  for (const name of activeLayers) {
    const muted = mutedLayers.has(name), soloed = soloLayers.has(name);
    const off = soloed ? false : (solo ? true : muted);    // dimmed when not heard this frame
    const chip = document.createElement('div');
    chip.className = 'laychip' + (off ? ' off' : '') + (soloed ? ' solo' : '');
    const dot = document.createElement('button');
    dot.className = 'laysolo'; dot.title = soloed ? 'unsolo' : 'solo (isolate)';
    dot.addEventListener('click', (e) => { e.stopPropagation(); toggleSolo(name); });
    const lbl = document.createElement('button');
    lbl.className = 'layname'; lbl.textContent = name; lbl.title = muted ? 'unmute' : 'mute';
    lbl.addEventListener('click', () => toggleMute(name));
    chip.appendChild(dot); chip.appendChild(lbl);
    layersEl.appendChild(chip);
  }
}

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

  // tumbling rainbow bongs over a segmented rainbow wash; random burst density,
  // drifting tumble, square-wave flat/shaded flicker, halftone-dotted layer
  'bong': `group(
stack(
  bg(palette("rainbow")
    .at(tri.fast(0.5).segment(4).range(0, 1))),
  shape("bong").fast("10 | 30 | 60")
    .radius(perlin.range(0.1, 0.3).slow(10))
    .color(palette("rainbow")
      .at(osc(0.01).spread(1).range(0, 1)))
    .rotate(osc(0.1, "saw")
      .range(0, 1).slow(0.5).drift(0.1))
    .rotateY(osc(0.5, "saw")
      .range(0, 1).slow(1).drift(0.1))
    .rotateX(osc(0.2, "sine")
      .range(0, 1).slow(2).drift(0.1))
    .size(osc(0.5, "sine").spread(3).range(0.1, 0.3))
    .fill(1).stroke(0)
    .decay(1)
    .shade(osc(0.5, "square").range(0, 1).drift(0.5))
)
)
.dots("[1 | 1 | 1 | 1 | 32]*4")`,

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

  // easing curves SHAPE a 0..1 signal before it's ranged (fast-out / slow-settle /
  // overshoot a linear ramp can't). radius rides an outExpo saw (bunched spiral),
  // hue eases inOutSine, the live size-osc breathes through inOutCubic, and each
  // glyph blooms with an outBack attack then fades on an inOutSine decay.
  'easing': `stack(
  bg("#06060f"),
  shape("dot*28")
    .angle(saw.range(0, 1))
    .radius(saw.ease("outExpo").range(0.04, 0.46))
    .color(palette("aurora").at(saw.ease("inOutSine").range(0, 1)))
    .size(osc(0.5, "tri").ease("inOutCubic").range(0.012, 0.055))
    .attack(0.4, "outBack")
    .decay(2.4, "inOutSine")
)`,

  // named layers: each $ line is its own editable voice, auto-stacked — no giant
  // stack(...). Edit/mute one without touching the others (substrate for the mixer).
  'layers': `$("sky", bg("#06060f"))
$("ring", shape("ring*4").radius(0.32)
  .color("#56b6ff").weight(0.006).decay(3))
$("orbits", shape("dot*16")
  .angle(saw.range(0, 2))
  .radius(saw.ease("outExpo").range(0.06, 0.46))
  .color(palette("neon").at(saw.range(0, 1)))
  .size(0.02).decay(2))
$("spark", shape("plus*3").radius(0.12)
  .rotate(saw.range(0, 1).slow(4))
  .color("#ffd166").size(0.05)
  .attack(0.3, "outBack").decay(1.5))`,

  // spring: a stateful modifier that CHASES a (stepped) target with momentum — overshoot
  // + settle that osc/easing can't. The dots lurch between 8 quantized x-columns and
  // ring down; the rings spring toward fresh random radii. stiffness/damping tune the bounce.
  'spring': `$("sky", bg("#06060f"))
$("steps", shape("dot*7")
  .x(osc(0.18, "saw").spread(1).quantize(8).spring(150, 11))
  .y(saw.range(0.16, 0.84))
  .color(palette("neon").at(saw.range(0, 1)))
  .size(0.035).decay(3))
$("rings", shape("ring*5")
  .radius(osc(0.3, "rand").spread(1).range(0.12, 0.44).spring(120, 9))
  .color("#56b6ff").weight(0.005).decay(2.5))`,

  // physics: each onset spawns a rapier2d rigid BODY (the engine is lazy-loaded on first
  // use). Shapes rain from the top, bounce off the floor/walls and COLLIDE with each other
  // — the inter-body dynamics spring/osc can't do. opts (gravity/bounce/drag/vel/spin) are
  // patternable: try gravity:"<1 -1>" to flip it each cycle, or windx for a side breeze.
  'gravity': `stack(
  bg("#06060f"),
  physics(
    shape("circle hex tri").fast(2)
      .x(rand.range(0.15, 0.85)).y(0.08)
      .size(rand.range(0.03, 0.07))
      .color(palette("candy").at(rand))
      .decay(7),
    { gravity: 1, bounce: 0.66, drag: 0.03, vel: 0.12, spin: 0.4 }
  )
)`,

  // force-fields: no gravity — instead the bodies are pulled toward a slowly-drifting
  // point (attract, the point ax/ay driven by oscs), orbit it (swirl), and wander through
  // a curl-noise flow (turbulence). Emergent, organic swarming the kinematic primitives
  // can't do. Every field param is patternable, so the whole flow can move.
  'swarm': `stack(
  bg("#06060f"),
  physics(
    shape("dot*3").fast(2)
      .x(rand).y(rand)
      .size(rand.range(0.012, 0.035))
      .color(palette("neon").at(rand))
      .decay(9),
    { gravity: 0, drag: 1.2, bounce: 0.3,
      attract: 0.5,
      ax: osc(0.05).range(0.25, 0.75),
      ay: osc(0.07, "tri").range(0.25, 0.75),
      swirl: 0.3,
      turbulence: 0.45, turbScale: 4 }
  )
)`,

  // interactive: mouseX/mouseY are live pointer signals. The swarm CHASES the cursor (the
  // attractor centre is the pointer, re-read each frame), while the ring layer spawns AT the
  // pointer as each ring is born (frozen at onset → a trail along the path). Move the mouse
  // (or drag on a phone). mouseX works anywhere a signal does — position, colour, size, FX.
  'cursor': `stack(
  bg("#06060f"),
  physics(
    shape("dot*3").fast(2).x(rand).y(rand)
      .size(rand.range(0.012, 0.03))
      .color(palette("neon").at(rand)).decay(7),
    { gravity: 0, drag: 1.2, attract: 0.7,
      ax: mouseX, ay: mouseY,
      swirl: 0.35, turbulence: 0.25, turbScale: 4 }
  ),
  shape("ring*8").x(mouseX).y(mouseY)
    .size(sine.range(0.02, 0.05).fast(3))
    .color(palette("ice").at(saw.range(0, 1)))
    .weight(0.004).decay(1.6)
)`,

  // mousepress → FX chain: mouseDown is a 0/1 signal, and FX params resolve live, so range it
  // into each effect (off-value at 0, on-value at 1). Hold the mouse / touch and the whole
  // feedback + kaleido + prism chain switches on; release and it's clean rings again.
  'press': `group(
  shape("ring*5").radius(saw.range(0.04, 0.4))
    .color(palette("neon").at(saw.range(0, 1)))
    .weight(0.006).decay(1.5)
)
.feedback(mouseDown.range(0, 0.92), 1.05, 0.03)
.kaleido(mouseDown.range(0, 8))
.rgbshift(mouseDown.range(0, 0.012))`,

  // mouse-painted rainbow physics bloom: tumbling shapes spray from the cursor (attract to it),
  // additive (lighter) blend, and hold the mouse to bleed everything into feedback. Every knob
  // is a slider — drag them to tune the spray.
  'bloom': `group(stack(
  bg("#06060f"),
  physics(
    shape("circle hex tri").fast(slider(30, 1, 30))
      .x(mouseX).y(mouseY)
      .rotateX(osc(0.5, "sine").range(0, 1))
      .rotateY(osc(0.33, "sine").range(0, 1))
      .rotate(osc(0.23, "sine").range(0, 1))
      .size(rand.range(0.001, slider(0.02, 0.01, 0.3)))
      .color(palette("rainbow").at(osc(2).spread(1)))
      .decay(slider(2.00, 0.1, 2)),
    {
      gravity: slider(0.06, 0, 1),
      bounce: slider(0.19, 0, 1),
      drag: slider(0.00, 0, 1),
      vel: slider(0.01, 0, 1),
      spin: slider(0.11, 0, 1),
      attract: slider(0.66, 0, 1),
      ax: mouseX,
      ay: mouseY
    }
  )
).blend("lighter"))
.feedback(mouseDown.range(0, 1),
  mouseDown.range(0.9, mouseX.range(0.99, 1)), 0)`,

  // inline sliders: each slider(value, min, max) renders a draggable control right in the
  // code — drag it to retune the patch live (it rewrites the number + re-runs). The number
  // you see IS the control; share the URL and the values travel with it.
  'sliders': `stack(
  bg("#06060f"),
  shape("circle*8")
    .radius(slider(0.3, 0, 0.45))
    .size(slider(0.05, 0.01, 0.12))
    .color(palette("neon").at(saw.range(0, 1)))
    .spin(slider(0.1, -1, 1))
    .decay(slider(2.5, 0.5, 6))
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
const COLLAPSE_KEY = 'loom.presetCollapsed';
const loadCollapsed = () => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch { return {}; } };
const saveCollapsed = (o) => localStorage.setItem(COLLAPSE_KEY, JSON.stringify(o));
function makePresRow(name, val, deletable) {
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
  return r;
}
function rebuildPresetList() {
  const user = loadUser(), collapsed = loadCollapsed();
  presList.innerHTML = '';
  const section = (key, title, entries) => {
    if (!entries.length) return;
    const sec = document.createElement('div'); sec.className = 'pressection';
    if (collapsed[key]) sec.classList.add('collapsed');
    const head = document.createElement('button'); head.className = 'preshead'; head.type = 'button';
    head.innerHTML = `<span class="caret">▾</span><span>${title}</span><span class="prescount"></span>`;
    head.querySelector('.prescount').textContent = entries.length;
    head.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      const c = loadCollapsed(); c[key] = sec.classList.contains('collapsed'); saveCollapsed(c);
    });
    const rows = document.createElement('div'); rows.className = 'presrows';
    for (const [name, val, del] of entries) rows.appendChild(makePresRow(name, val, del));
    sec.append(head, rows); presList.appendChild(sec);
  };
  // your saved patches first — they're what you reach for; built-ins are the reference set below
  section('saved', 'saved', Object.keys(user).map((n) => [n, 'u:' + n, true]));
  const featured = ['threads', 'vortex', 'halo'].filter((n) => n in PRESETS);   // a few favourites, then the rest
  const ordered = [...featured, ...Object.keys(PRESETS).filter((n) => !featured.includes(n))];
  section('builtin', 'built-in', ordered.map((n) => [n, 'b:' + n, false]));
  setActive(activeVal);
}

function applyPreset(val) {
  if (!val) return;
  const i = val.indexOf(':'); const kind = val.slice(0, i), name = val.slice(i + 1);
  const code = kind === 'u' ? loadUser()[name] : PRESETS[name];
  if (code == null) return;
  mutedLayers.clear(); soloLayers.clear();                          // clean slate: drop mute/solo
  editor.setCode(code); clearParticles(); run();                   // preset switch = clean slate
}

// ── shareable URLs: ?p=<name> for a built-in preset, ?c=<base64> for any custom
// code. The address bar is the share link — it updates on every run/load. ──
const b64e = (s) => btoa(encodeURIComponent(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = (s) => decodeURIComponent(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
const builtinFor = (code) => Object.keys(PRESETS).find((n) => PRESETS[n].trim() === code.trim()) || null;
function syncURL() {
  const name = builtinFor(editor.getCode());
  const qs = name ? 'p=' + encodeURIComponent(name) : 'c=' + b64e(editor.getCode());
  try { history.replaceState(null, '', location.pathname + '?' + qs); } catch { /* ignore */ }
}

// ── wiring ──────────────────────────────────────────────────────────────────────────
function setCps(v) { cps = Math.max(0.1, Math.min(2, v)); cpsLabel.textContent = cps.toFixed(2); if (cpsRange) cpsRange.value = cps; }

// ⌘↵ to run, Tab → spaces, undo/redo, highlighting + scroll are all handled inside the
// CodeMirror editor (see editor.js); no textarea event wiring needed here.

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
  retireRunTip();               // the "edit the pattern" intro has done its job — for good
}
// first-run intro tip anchored to the run button: shows for first-timers, retires once you've run
// a patch (or already have a saved preset). Persisted across sessions via `loom.ranOnce`.
const RAN_KEY = 'loom.ranOnce';
const runtipEl = $('#runtip');
function retireRunTip() { if (runtipEl) runtipEl.classList.remove('show'); localStorage.setItem(RAN_KEY, '1'); }
function initRunTip() {
  if (!runtipEl) return;
  if (localStorage.getItem(RAN_KEY) === '1' || Object.keys(loadUser()).length) return;
  setTimeout(() => runtipEl.classList.add('show'), 500);   // a beat after load so it reads as an intro
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
function clearCanvas() { clearParticles(); ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
$('#clearbtn').addEventListener('click', clearCanvas);
const decayLabel = $('#decayval');
function setDecay(v) { decayScale = Math.max(0.25, Math.min(6, v)); decayLabel.textContent = decayScale % 1 ? decayScale.toFixed(2) : decayScale.toString(); if (decayRange) decayRange.value = decayScale; }
// speed + decay are inline range sliders (same widget language as the editor's slider()).
cpsRange.value = cps; decayRange.value = decayScale;
cpsRange.addEventListener('input', () => setCps(+cpsRange.value));
decayRange.addEventListener('input', () => setDecay(+decayRange.value));
$('#cpssl').addEventListener('dblclick', () => setCps(0.6));      // double-click the row → default
$('#decaysl').addEventListener('dblclick', () => setDecay(1.5));

const clockBtn = $('#clockbtn');
const cycEl = document.querySelector('.cyc');   // the cycle readout rides with the playhead toggle
function renderClock() {
  clockBtn.classList.toggle('on', showClock); clockBtn.classList.toggle('off', !showClock);
  if (cycEl) cycEl.style.display = showClock ? '' : 'none';   // hide the counter when the playhead is off
}
clockBtn.addEventListener('click', () => {
  showClock = !showClock;
  localStorage.setItem('loom.clock', showClock ? '1' : '0');
  renderClock();
});
renderClock();

// trace button removed for now; the mode stays off (renderer code remains, dormant)

function newPatch() {
  mutedLayers.clear(); soloLayers.clear();                                                  // clean slate: drop mute/solo
  editor.setCode(DEFAULT_PATCH); clearParticles(); run(); setActive('');                    // new = clean slate
  if (isMobile()) setSide(false);
}
$('#newbtn').addEventListener('click', newPatch);
$('#prenew').addEventListener('click', newPatch);   // the in-panel "+ new" button

// save story: "save" commits to the preset you're editing (silent overwrite) — or, if you're on a
// built-in / fresh patch, prompts for a name. "save as" always prompts for a new copy.
function savePreset(forceNew) {
  const onUser = activeVal.startsWith('u:');
  let name;
  if (onUser && !forceNew) name = activeVal.slice(2);                 // overwrite the active preset, no prompt
  else { name = (prompt('Save preset as:', onUser ? activeVal.slice(2) : '') || '').trim(); if (!name) return; }
  const user = loadUser(); user[name] = editor.getCode(); saveUser(user);
  rebuildPresetList(); setActive('u:' + name); syncURL(); flashSaved();
}
function flashSaved() {
  const b = $('#presave'); if (!b) return;
  const t = b.dataset.label || (b.dataset.label = b.textContent);
  b.textContent = 'saved ✓'; clearTimeout(b._t);
  b._t = setTimeout(() => { b.textContent = t; }, 900);
}
$('#savebtn').addEventListener('click', () => savePreset(false));
$('#presave').addEventListener('click', () => savePreset(false));    // in-panel save (overwrite current)
$('#presaveas').addEventListener('click', () => savePreset(true));   // always a new copy
// the presets toolbar is sticky; section heads stick just below it (offset = its height)
{ const pb = $('#presbar');
  if (pb) new ResizeObserver(() => document.documentElement.style.setProperty('--presbar-h', pb.offsetHeight + 'px')).observe(pb); }

// ── right sidebar (swappable presets / guide) ──
const side = $('#side');
const panes = [...side.querySelectorAll('.tabpane')];
function showTab(name) {
  panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
  if (name === 'feed') syncFeedUI();             // reflect current feed state into the controls
  localStorage.setItem('loom.sidetab', name);
}

// ── guide: filterable rows, LLM-copy, palette swatches ──────────────────────────────
function setupGuide() {
  const sections = [...document.querySelectorAll('#side section')];
  // wrap each entry (a <code> block + its following description siblings) into a .grow
  // row, so the filter can show/hide them individually.
  for (const sec of sections) {
    let cur = null;
    for (const ch of [...sec.children]) {
      if (ch.tagName === 'H3') continue;
      if (ch.tagName === 'CODE' || !cur) { cur = document.createElement('div'); cur.className = 'grow'; sec.insertBefore(cur, ch); }
      cur.appendChild(ch);
    }
  }

  // section nav: a chip per section that jumps to it, coloured by the section's --cat. Skip the
  // lineage/credits. The sticky head's height drives the sticky-header offset + scroll-margin.
  const navEl = $('#guidenav'), navChips = new Map();
  if (navEl) for (const sec of sections) {
    if (sec.classList.contains('lineage')) continue;
    const h3 = sec.querySelector('h3'); if (!h3) continue;
    const label = (h3.childNodes[0] && h3.childNodes[0].textContent || h3.textContent).trim();
    const chip = document.createElement('button');
    chip.className = 'gnav'; chip.type = 'button'; chip.textContent = label;
    const cat = getComputedStyle(sec).getPropertyValue('--cat').trim();
    if (cat) chip.style.setProperty('--gc', cat);
    // jump to the section — scroll the pane explicitly (offset by the sticky head) rather than
    // scrollIntoView, which lands the title under the head and reads as "nothing moved".
    chip.addEventListener('click', () => {
      const headH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--guidehead-h')) || 96;
      const top = gpane.scrollTop + (sec.getBoundingClientRect().top - gpane.getBoundingClientRect().top) - headH;
      gpane.scrollTop = Math.max(0, top);   // jump straight there — no smooth scroll
    });
    navEl.appendChild(chip);
    navChips.set(sec, chip);
  }
  // the single-row nav scrolls horizontally; translate a vertical wheel to horizontal so a mouse
  // (no trackpad swipe) can reach pills the autoscroll has pushed off the left/right edge.
  if (navEl) navEl.addEventListener('wheel', (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    navEl.scrollLeft += d; e.preventDefault();
  }, { passive: false });
  const head = document.querySelector('.guidehead');
  if (head) new ResizeObserver(() => document.documentElement.style.setProperty('--guidehead-h', head.offsetHeight + 'px')).observe(head);
  // scrollspy: light up the nav chip of the section currently under the head
  const gpane = document.querySelector('#side .tabpane[data-pane="guide"]');
  // keep the active chip within the single-row nav's horizontal view. scrollIntoView reads no
  // geometry itself (immune to the unsettled-layout 0-width reads); we only gate it on a rect
  // check so we don't re-scroll a chip that's already visible. Ungated by a "changed" flag so a
  // tick that fired mid-transition (no-op) self-heals on the next real scroll. inline-only:
  // block:'nearest' keeps it from nudging the vertical page scroll.
  const revealChip = (chip) => {
    const c = chip.getBoundingClientRect(), n = navEl.getBoundingClientRect();
    if (n.width && (c.left < n.left || c.right > n.right))
      chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });   // instant, no smooth glide
  };
  function syncActiveNav() {
    if (!gpane || !navChips.size) return;
    const headH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--guidehead-h')) || 100;
    // measure each section against the scroll viewport (getBoundingClientRect), not offsetTop —
    // offsetTop is relative to the positioned #side, so it carries a constant skew vs scrollTop.
    const paneTop = gpane.getBoundingClientRect().top;
    let active = null;
    for (const sec of sections) {
      if (sec.hidden || sec.classList.contains('lineage')) continue;
      if (sec.getBoundingClientRect().top - paneTop <= headH + 4) active = sec;
    }
    active = active || sections.find((s) => navChips.has(s));
    navChips.forEach((chip, sec) => chip.classList.toggle('active', sec === active));
    const chip = navChips.get(active); if (chip) revealChip(chip);
  }
  if (gpane) { gpane.addEventListener('scroll', syncActiveNav, { passive: true }); requestAnimationFrame(syncActiveNav); }

  // palette swatches → click inserts palette("name") at the cursor
  const pals = DSL.PALETTES, palc = $('#palswatches');
  if (pals && palc) for (const name of Object.keys(pals)) {
    const grad = `linear-gradient(90deg, ${pals[name].join(', ')})`;
    const row = document.createElement('div');
    row.className = 'palrow';
    row.innerHTML = `<span class="palname"></span><span class="palgrad"></span><span class="palhint">insert</span>`;
    row.querySelector('.palname').textContent = name;
    row.querySelector('.palgrad').style.background = grad;
    row.addEventListener('click', () => {
      editor.insert(`palette("${name}")`);   // insert at the cursor (replaces any selection) + focus
      row.classList.add('copied'); setTimeout(() => row.classList.remove('copied'), 700);
    });
    palc.appendChild(row);
  }

  // filter bar
  const filter = $('#guidefilter'), empty = document.querySelector('.guideempty');
  filter && filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    let anyVisible = false;
    for (const sec of sections) {
      const h3 = sec.querySelector('h3'), htext = h3 ? h3.textContent.toLowerCase() : '';
      const hMatch = !!q && htext.includes(q);
      let secVis = false;
      for (const r of sec.querySelectorAll('.grow')) {
        const m = !q || hMatch || r.textContent.toLowerCase().includes(q);
        r.hidden = !m; if (m) secVis = true;
      }
      sec.hidden = q ? (!secVis && !hMatch) : false;
      const chip = navChips.get(sec); if (chip) chip.hidden = sec.hidden;
      if (!sec.hidden) anyVisible = true;
    }
    if (empty) empty.hidden = anyVisible || !q;
    syncActiveNav();
  });

  // copy the full reference for pasting into an LLM
  const copyBtn = $('#guidecopy');
  copyBtn && copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(REFERENCE); }
    catch { const t = document.createElement('textarea'); t.value = REFERENCE; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    copyBtn.classList.add('done'); copyBtn.textContent = 'copied ✓';
    setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.textContent = 'copy for LLM'; }, 1500);
  });
}
setupGuide();
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
  // light the toolbar button whose pane is actually showing (presets / guide / feed), or none
  const active = open ? side.querySelector('.tabpane:not([hidden])')?.dataset.pane : null;
  $('#panelbtn').classList.toggle('on', active === 'presets');
  $('#helpbtn').classList.toggle('on', active === 'guide');
  $('#feedbtn').classList.toggle('on', active === 'feed');
  localStorage.setItem('loom.side', open ? '1' : '0');
}
// presets / guide each open the sidebar on their tab (and toggle it shut when already there)
const onTab = (name) => !side.classList.contains('hidden') && side.querySelector(`[data-pane="${name}"]:not([hidden])`);
$('#panelbtn').addEventListener('click', () => setSide(!onTab('presets'), 'presets'));
$('#helpbtn').addEventListener('click', () => setSide(!onTab('guide'), 'guide'));
// a transient toast (e.g. the "Esc to bring it back" hint when chrome hides)
const toastEl = $('#toast');
let toastT;
function showToast(msg, dur = 2800) {
  if (!toastEl) return;
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), dur);
}
// fully hide all chrome (the hide button, ⌘/Ctrl+Shift+H or ⌘/Ctrl+.) so the drawing has the whole
// screen; any of Escape / the same combo brings it back. A toast says how to get out.
function setChromeHidden(on) {
  document.body.classList.toggle('chrome-hidden', on);
  if (on) showToast('Esc to bring back the controls');
  else if (toastEl) { toastEl.classList.remove('show'); clearTimeout(toastT); }
}
$('#hidebtn').addEventListener('click', () => setChromeHidden(true));
// Perform mode (⌘/Ctrl+Shift+E or the eye button): dim the editor + make it click-through, so
// you can trigger mouseDown / drive the canvas without selecting code. Controls stay live.
function setPerform(on) {
  document.body.classList.toggle('perform', on);
  $('#performbtn').classList.toggle('on', on);
  // editor text is click-through (set inline — reliable); the CODE is ghosted + the slider
  // widgets stay bright/live via CSS (see body.perform rules). Sliders re-enable their own
  // pointer-events, so they're still grabbable through the click-through editor.
  $('#editwrap').style.pointerEvents = on ? 'none' : '';
}
const togglePerform = () => setPerform(!document.body.classList.contains('perform'));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === '.' || ((e.shiftKey) && (e.key === 'H' || e.key === 'h')))) {
    e.preventDefault(); setChromeHidden(!document.body.classList.contains('chrome-hidden')); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
    e.preventDefault(); togglePerform(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
    e.preventDefault(); clearCanvas(); return;             // clear the canvas (works mid-edit too)
  }
  if (e.key === 'Escape') {
    if (document.body.classList.contains('chrome-hidden')) { setChromeHidden(false); return; }
    if (document.body.classList.contains('perform')) { setPerform(false); return; }
    setSide(false);
  }
});
$('#performbtn').addEventListener('click', togglePerform);
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
const toolbar = $('#toolbar');
let idleTimer;
function setIdle(on) { rail.classList.toggle('idle', on); toolbar.classList.toggle('idle', on); }
function activity() {
  setIdle(false);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!editor.hasFocus()) setIdle(true); }, 2600);
}
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, activity, { passive: true }));
// editor focus/blur (→ editing class + activity) is wired via the editor's onFocus callback.
// mouse leaving the window → fade right away (unless we're mid-edit)
document.addEventListener('mouseleave', () => { if (!editor.hasFocus()) setIdle(true); });

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

// feed the live pointer (mouse + touch) into the mouseX/mouseY/mouseDown signals. Position
// is 0..1 of the canvas; clamped so off-canvas reads stay in range. Pointer events cover
// touch, so it works on phones too. We keep the last position so a release holds it.
const syncPointer = () => DSL._setPointer(pointerState.x, pointerState.y, pointerState.down);
function feedPointer(e) {
  const r = activeCanvas.getBoundingClientRect();
  pointerState.x = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  pointerState.y = Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)));
  syncPointer();
}
// mouseDown fires on a press over the canvas/background — NOT on the UI chrome (toolbar, rail/
// editor, side panel), so clicking a button or dragging a slider never trips it. To trigger
// without selecting code, use Perform mode (below): it makes the editor click-through, so the
// whole screen becomes a clean trigger surface (presses then land on the canvas, not #rail).
const onChrome = (e) => !!(e.target && e.target.closest && e.target.closest('#rail, #toolbar, #side'));
window.addEventListener('pointermove', feedPointer, { passive: true });
window.addEventListener('pointerdown', (e) => { feedPointer(e); if (!onChrome(e)) { pointerState.down = 1; syncPointer(); } }, { passive: true });
window.addEventListener('pointerup', () => { pointerState.down = 0; syncPointer(); }, { passive: true });
window.addEventListener('pointercancel', () => { pointerState.down = 0; syncPointer(); }, { passive: true });

// ── MIDI input (Web MIDI) → the cc/gate/vel/note/bend signals ──────────────────────
// Request access on load; pump every message from every input into the DSL. No-ops cleanly
// when Web MIDI is unavailable or denied. window.loom.midi(status, d1, d2) lets tooling inject
// messages without hardware.
function initMidi() {
  if (!navigator.requestMIDIAccess) return;
  navigator.requestMIDIAccess().then((access) => {
    // pass the port name through so dev("name") can scope to a specific device
    const hook = (port) => { if (port && port.type === 'input') port.onmidimessage = (e) => DSL._midiInput(e.data[0], e.data[1], e.data[2], port.name); };
    access.inputs.forEach(hook);
    access.onstatechange = (e) => hook(e.port);   // hot-plugged devices
  }).catch(() => { /* no MIDI / denied — signals just stay 0 */ });
}
initMidi();

// ── juggling feed (WebSocket ball tracking) → the ballX/ballY/thrown/caught/... signals ──────
// A separate local app broadcasts ball positions + throw/catch/tap events as JSON over a
// WebSocket (see REFERENCE.md). Read-only: loom never sends, only listens. Auto-reconnects (~1s)
// so the host can come and go. Offline = signals just hold their defaults, no errors.
//   • OFF by default (this is a public web app — we don't want every visitor's browser dialling
//     ws://localhost, which https would block as mixed content anyway). Enable per-session.
//   • Turn on with ?feed (default host) / ?feed=host:port in the URL, or window.loom.feed.enabled
//     = true. The choice + host persist in localStorage.
//   • window.loom.jug(msg) injects a feed message for testing without the host.
const FEED_HOST_KEY = 'loom.feedHost', FEED_ON_KEY = 'loom.feedOn', FEED_FLIP_KEY = 'loom.feedFlip',
  FEED_VID_KEY = 'loom.feedVideo', FEED_OP_KEY = 'loom.feedOpacity';
let feedHost = localStorage.getItem(FEED_HOST_KEY) || 'localhost:8080';
let feedOn = localStorage.getItem(FEED_ON_KEY) === '1';
let feedVideo = localStorage.getItem(FEED_VID_KEY) === '1';
let feedOpacity = parseFloat(localStorage.getItem(FEED_OP_KEY)); if (!(feedOpacity >= 0 && feedOpacity <= 1)) feedOpacity = 1;
let feedWS = null;
DSL._jug.flipX = localStorage.getItem(FEED_FLIP_KEY) === '1';
{ const f = new URLSearchParams(location.search).get('feed'); if (f != null) { feedOn = true; if (f) feedHost = f; } }   // ?feed or ?feed=host:port
// the feed is a niche local-only tool — keep its toolbar button off the public UI. Reveal (and
// remember) it once anyone has touched the feed: ?feed in the URL, or it was enabled before.
const FEED_SHOW_KEY = 'loom.feedShow';
const feedShow = feedOn || localStorage.getItem(FEED_SHOW_KEY) === '1';
if (feedShow) localStorage.setItem(FEED_SHOW_KEY, '1');

const feedCam = $('#feedcam');
// camera overlay: stream the host's MJPEG behind the canvas and clear the canvas transparent so
// it shows through (GL only). flipX mirrors it to match the selfie ballX flip.
function applyVideo() {
  if (!feedCam) return;
  if (feedVideo) {
    const src = 'http://' + feedHost + '/camera.mjpg?raw=1';   // raw frame, no host-drawn ball overlays
    if (feedCam.getAttribute('src') !== src) feedCam.src = src;   // the <img> just decodes the stream
    feedCam.hidden = false;
    if (glr) glr.setCameraSource(feedCam, !!DSL._jug.flipX, feedOpacity);   // gl draws it behind the glyphs
  } else {
    feedCam.hidden = true; feedCam.removeAttribute('src');        // drop the stream when off
    if (glr) glr.setCameraSource(null);
  }
}
function setFeedStatus() {
  if (!fp || !fp.dot) return;
  const st = !feedOn ? 'off' : (feedWS && feedWS.readyState === 1) ? 'on' : 'wait';
  fp.dot.className = 'fpdot' + (st === 'on' ? ' on' : st === 'wait' ? ' wait' : '');
  fp.stat.textContent = st === 'on' ? 'live' : st === 'wait' ? 'connecting…' : 'off';
}
function feedConnect() {
  if (!feedOn || feedWS) { setFeedStatus(); return; }
  setFeedStatus();
  try { feedWS = new WebSocket('ws://' + feedHost + '/feed'); }
  catch { feedWS = null; setFeedStatus(); return; }
  feedWS.onopen = () => setFeedStatus();
  feedWS.onmessage = (e) => { try { DSL._jugInput(JSON.parse(e.data)); } catch { /* skip a bad frame */ } };
  feedWS.onclose = () => { feedWS = null; setFeedStatus(); if (feedOn) setTimeout(feedConnect, 1000); };   // reconnect while enabled
  feedWS.onerror = () => { try { feedWS.close(); } catch {} };
}
function feedReset() { if (feedWS) { try { feedWS.close(); } catch {} feedWS = null; } feedConnect(); }

// config card (toggled by #feedbtn): connect · host · selfie flip · camera overlay + opacity
const fp = { btn: $('#feedbtn'), pane: $('#side .tabpane[data-pane="feed"]'), on: $('#feedon'), host: $('#feedhostin'),
  flip: $('#feedflip'), video: $('#feedvideo'), op: $('#feedop'), dot: $('#feeddot'), stat: $('#feedstat'), balls: $('#feedballs') };
function syncFeedUI() {
  if (!fp.on) return;
  fp.on.checked = feedOn; fp.host.value = feedHost; fp.flip.checked = !!DSL._jug.flipX;
  fp.video.checked = feedVideo; fp.op.value = feedOpacity; setFeedStatus();
}
if (fp.btn && feedShow) fp.btn.hidden = false;   // surface the toolbar button only when the feed's in use
if (fp.btn) fp.btn.addEventListener('click', () => setSide(!onTab('feed'), 'feed'));   // antenna = the feed pane's tab
if (fp.on) fp.on.addEventListener('change', () => { feedOn = fp.on.checked; localStorage.setItem(FEED_ON_KEY, feedOn ? '1' : '0'); if (feedOn) feedConnect(); else if (feedWS) { try { feedWS.close(); } catch {} } setFeedStatus(); });
if (fp.host) fp.host.addEventListener('change', () => { feedHost = fp.host.value.trim() || 'localhost:8080'; fp.host.value = feedHost; localStorage.setItem(FEED_HOST_KEY, feedHost); applyVideo(); if (feedOn) feedReset(); });
if (fp.flip) fp.flip.addEventListener('change', () => { DSL._jug.flipX = fp.flip.checked; localStorage.setItem(FEED_FLIP_KEY, fp.flip.checked ? '1' : '0'); applyVideo(); });
if (fp.video) fp.video.addEventListener('change', () => { feedVideo = fp.video.checked; localStorage.setItem(FEED_VID_KEY, feedVideo ? '1' : '0'); applyVideo(); });
if (fp.op) fp.op.addEventListener('input', () => { feedOpacity = parseFloat(fp.op.value); localStorage.setItem(FEED_OP_KEY, String(feedOpacity)); applyVideo(); });
// live per-ball debug while the feed pane is open: position, spin, and a flash on each event —
// so you can confirm the data is actually arriving (and which id maps to which ball).
setInterval(() => {
  if (!fp.pane || fp.pane.hidden || !fp.balls) return;
  const b = DSL._jug.balls, ids = Object.keys(b).sort();
  if (!ids.length) { fp.balls.textContent = 'no balls — waiting for the feed'; return; }
  fp.balls.textContent = ids.map((k) => {
    const o = b[k], id = k.replace('ball_', '');
    const ev = [o.seen && o.still ? 'still' : '', o.thr > 0.1 ? 'throw' : '', o.cat > 0.1 ? 'catch' : '', o.tap > 0.1 ? 'tap' : ''].filter(Boolean).join('+');
    const pos = (o.seen ? `${o.x.toFixed(2)} ${o.y.toFixed(2)}` : 'off').padEnd(9);   // fixed width → columns line up
    return `${id}  x/y ${pos}  spin ${o.spin.toFixed(2)}${ev ? '  ‹' + ev + '›' : ''}`;
  }).join('\n');
}, 120);

applyVideo();
feedConnect();

resize();
setCps(cps);
setDecay(decayScale);
rebuildPresetList();
initRunTip();
showTab(localStorage.getItem('loom.sidetab') || 'presets');
setSide(localStorage.getItem('loom.side') !== '0');
// boot source priority: ?c=<custom> → ?p=<built-in> → last-worked-on → threads
const _params = new URLSearchParams(location.search);
const _urlC = _params.get('c'), _urlP = _params.get('p');
let _booted = false;
if (_urlC) { try { editor.setCode(b64d(_urlC)); _booted = true; } catch { /* malformed link */ } }
else if (_urlP && PRESETS[_urlP]) { editor.setCode(PRESETS[_urlP]); setActive('b:' + _urlP); _booted = true; }
if (!_booted) {
  const saved = localStorage.getItem('loom.code');   // restore last-worked-on patch; threads if none
  editor.setCode(saved || PRESETS.threads);
  if (!saved) setActive('b:threads');
}
// hold the engine behind the photosensitivity warning; startEngine() runs on ack
if (needsWarning) warn.hidden = false;
else startEngine();
