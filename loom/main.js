// main.js — the live-coding shell and the particle renderer.
//
// You type a pattern expression; we eval it (with the DSL in scope) into a
// Pattern. A clock advances cyclic time; each frame we query the pattern for the
// slice of time that just elapsed and spawn a glyph for every event onset. Glyphs
// bloom and fade as particles over a trailed canvas, so rhythm becomes geometry.

import { DSL } from './pattern.js';

const $ = (sel) => document.querySelector(sel);
const TAU = Math.PI * 2;
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const editor = $('#code');
const hl = $('#hl');
const errBar = $('#err');
const cpsLabel = $('#cpsval');

// ── syntax highlighting ────────────────────────────────────────────────────────────
// A transparent <textarea> sits over a <pre>; we re-render coloured HTML into the
// <pre> on every edit and keep their scroll positions synced.
const HL_FN = new Set(['shape','s','n','stack','cat','slowcat','fastcat','seq','sequence','timecat',
  'pure','silence','run','range','mini','euclid','fast','slow','rev','choose','irand']);
const HL_SIG = new Set(['sine','cosine','saw','isaw','tri','square','rand','perlin','fbm','brown','gauss','white']);
const HL_METHOD = new Set(['fast','slow','rev','every','iter','palindrome','jux','off','degrade','degradeBy',
  'unDegradeBy','sometimes','sometimesBy','often','rarely','early','late','range','add','sub','mul','div',
  'color','size','x','y','radius','rotate','rotateX','rotateY','spin','blend','alpha','pan','jitter','fill','stroke','weight',
  'cap','join','open','vertex','attack','decay','life','set']);
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
  return out + escHtml(code.slice(last)) + '\n'; // trailing newline keeps the last line aligned
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
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // paint an opaque base so the first trail-fade has something to eat
  ctx.fillStyle = '#06070a';
  ctx.fillRect(0, 0, W, H);
}
new ResizeObserver(resize).observe(canvas);

// ── the pattern + clock ──────────────────────────────────────────────────────────
let pattern = DSL.silence;
let cps = 0.6;          // cycles per second
let cycle = 0;          // current position in cycles (fractional)
let playing = true;
let decayScale = 1.5;   // master multiplier on a new glyph's decay (how long it lingers)
let showClock = localStorage.getItem('loom.clock') !== '0'; // playhead sweep on/off
let traceMode = localStorage.getItem('loom.trace') === '1'; // connect live points into a path
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
  if (!(result instanceof DSL.Pattern)) throw new Error('expression did not evaluate to a pattern');
  return result;
}

function run() {
  try {
    pattern = compile(editor.value);
    errBar.textContent = '';
    errBar.classList.remove('show');
    localStorage.setItem('loom.code', editor.value);
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
  const cx = W / 2, cy = H / 2;

  // position: explicit x/y (0..1) win; otherwise lay the event out on a ring by
  // its onset phase within the cycle — rhythm → mandala.
  const phase = onset - Math.floor(onset);
  let px, py;
  if (v.x != null || v.y != null) {
    px = (v.x != null ? v.x : 0.5) * W;
    py = (v.y != null ? v.y : 0.5) * H;
  } else {
    const ang = phase * Math.PI * 2 - Math.PI / 2;
    const rad = (v.radius != null ? v.radius : 0.34) * minDim;
    px = cx + Math.cos(ang) * rad;
    py = cy + Math.sin(ang) * rad;
  }
  // pan (from jux) nudges horizontally so mirrored copies separate.
  if (v.pan != null) px += (v.pan - 0.5) * W * 0.42;

  if (v.jitter) {
    px += (Math.random() - 0.5) * v.jitter * minDim;
    py += (Math.random() - 0.5) * v.jitter * minDim;
  }

  const color = resolveColor(v.color, phase);
  particles.push({
    x: px, y: py,
    shape: v.shape || 'dot',
    color,
    size: (v.size != null ? v.size : 0.06) * minDim,
    rot: (v.rotate != null ? v.rotate : 0) * TAU,   // Z rotation, turns → radians
    rotX: (v.rotateX != null ? v.rotateX : 0) * TAU, // tilt around horizontal axis
    rotY: (v.rotateY != null ? v.rotateY : 0) * TAU, // tilt around vertical axis
    spin: (v.spin != null ? v.spin : 0) * TAU,      // turns per second (Z)
    fill: v.fill != null ? v.fill : 1,               // patternable; default on
    stroke: v.stroke != null ? v.stroke : 0,         // patternable; default off
    vertex: v.vertex != null ? v.vertex : 0,         // patternable; draw dots at vertices
    weight: v.weight != null ? v.weight : 0.006,     // stroke width, fraction of min dimension
    cap: v.cap || 'round',                           // line ends: round | butt | square
    join: v.join || 'round',                         // corners: round | miter | bevel
    open: v.open != null ? v.open : 0,               // arc gap 0..1 (fraction left open)
    alpha: v.alpha != null ? v.alpha : 1,
    blend: v.blend || 'source-over',   // normal compositing; opt into 'screen'/'lighter' explicitly
    age: 0,
    attack: v.attack != null ? v.attack : 0.06,      // fade-in seconds (captured now)
    // fade-out seconds; default ~1 cycle. The master slider is baked in HERE so
    // each glyph keeps the decay it was born with — moving the slider later only
    // affects future glyphs, never ones already on screen.
    decay: ((v.decay != null ? v.decay : 1.0) / cps) * decayScale,
  });
}

function resolveColor(c, phase) {
  if (typeof c === 'string') {
    if (c[0] === '#') return c;
    const named = { red:'#ff5d73', orange:'#ff9d5c', yellow:'#ffd166', green:'#6df0c2',
      cyan:'#56e0ff', blue:'#56b6ff', purple:'#b58cff', pink:'#ff8ad1', white:'#f4f6fb' };
    if (named[c]) return named[c];
    // a word like "a"/"b" → stable hue from the string
    let h = 0; for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) % 360;
    return `hsl(${h} 80% 64%)`;
  }
  if (typeof c === 'number') return `hsl(${(c * 360) % 360} 82% 64%)`;
  // default: hue follows position in the cycle → a rainbow ring
  return PALETTE[Math.floor(phase * PALETTE.length) % PALETTE.length];
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
// vertices in 3D (Z then X then Y) and project them through a pinhole camera —
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
  const project = (px, py) => {
    let x = px * cz - py * sz, y = px * sz + py * cz, z = 0; // Z rotation (incl. spin)
    let y2 = y * cx - z * sx; z = y * sx + z * cx; y = y2;   // X rotation
    let x2 = x * cy + z * sy; z = -x * sy + z * cy; x = x2;  // Y rotation
    const s = d / (d - z);                                  // perspective divide
    return [x * s, y * s];
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

// ── main loop ─────────────────────────────────────────────────────────────────────
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  tick(dt);
  requestAnimationFrame(frame);
}

function tick(dt) {
  // Clean redraw: wipe the buffer completely every frame, then repaint only the
  // live particles. Nothing is ever baked in, so there's no alpha residue/ghosting.
  // "Trails" come from particles fading out over their own lifetime, not from a veil.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#06070a';
  ctx.fillRect(0, 0, W, H);

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

  // playhead — a faint clock hand sweeping the cycle phase, drawn *behind* the
  // glyphs. Toggleable, and freezes when paused (it reads `cycle`).
  if (showClock) {
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
    p._a = Math.max(0, Math.min(1, p.alpha * env));
    particles[w++] = p;
    live.push(p);
  }
  particles.length = w;

  // trace mode: thread a line through the live points in spawn order, behind
  // the glyphs — rhythm becomes a connected path / constellation.
  if (traceMode && live.length > 1) {
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

  // draw glyphs (newest on top, since live is oldest→newest)
  for (const p of live) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalCompositeOperation = p.blend;
    ctx.globalAlpha = p._a;
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.color;
    const zRot = p.rot + p.spin * p.age;
    const lw = Math.max(0.75, p.weight * minDim);
    // outlines (ring/arc/line/cross) stroke by default; vertex mode suppresses
    // that auto-stroke unless stroke is explicitly on. closed shapes use fill.
    const outline = OUTLINE_SHAPES.has(p.shape);
    const stroke = outline ? (p.stroke || !p.vertex) : p.stroke;
    const fill = outline ? 0 : p.fill;
    const o = { fill, stroke, lw, cap: p.cap, join: p.join, open: p.open };
    if (p.rotX || p.rotY) {
      drawShape3D(ctx, p.shape, p.size, zRot, p.rotX, p.rotY, o, p.vertex);  // true perspective
    } else {
      ctx.rotate(zRot);
      if (fill || stroke) drawShape(ctx, p.shape, p.size, o);                 // fast crisp 2D
      if (p.vertex) drawVertices(ctx, shapeGeom(p.shape, p.size, p.open), Math.max(2, lw * 1.5));
    }
    ctx.restore();
  }

  $('#cycle').textContent = Math.floor(cycle).toString();
}

// debug stepper — lets tooling drive frames when the tab is backgrounded (the
// browser pauses requestAnimationFrame while hidden). Harmless in production.
window.loom = { tick, step: (n = 60, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); }, particles, setDecay: (v) => { decayScale = v; } };

// ── presets ───────────────────────────────────────────────────────────────────────
const PRESETS = {
  // gestural line field with breathing weight + perspective tumble
  'threads': `shape("line")
  .fast("256 128 256 128")
  .radius(
    sine.range(0.15, 0.2).slow(7)
      .add(sine.range(-0.5, 0.3).fast(5))
  )
  .open(sine.range(0, 0.6).slow(8))
  .color(saw.range(0, 4))
  .size(sine.range(0.01, 0.1).fast(2))
  .slow(4)
  .attack(sine.range(0, 0.1))
  .decay(sine.range(0.01, 4).slow(7))
  .rotate(saw.range(-1, 9).slow(4))
  .rotateX(saw.range(-1, 1).slow(9))
  .rotateY(saw.range(-1, 1).slow(2))
  .weight(sine.range(0.001, 0.01).slow(8))
  .cap("square")`,

  // five arcs orbiting, gaps breathing, slowly tipping in 3D
  'orbit': `shape("arc*5")
  .radius(sine.range(0.12, 0.4).slow(3))
  .open(sine.range(0.15, 0.9).slow(5))
  .color("<#ff5d73 #ffd166 #6df0c2 #56b6ff #b58cff>")
  .size(0.13).weight(0.012)
  .rotateY(saw.range(0, 1).slow(6))
  .spin(0.04)
  .decay(2.5).fast(1.5)`,

  // polymeter polygons drifting across the field, tumbling in perspective
  'lattice': `shape("{square tri hex pent}%7")
  .x(saw.range(0.12, 0.88))
  .y(perlin.range(0.15, 0.85).fast(2))
  .rotateX(saw.range(0, 1).slow(4))
  .rotateY(saw.range(0, 1).slow(3))
  .color(perlin.range(0, 1))
  .size(sine.range(0.04, 0.09).slow(2))
  .fill(0).stroke().weight(0.008)
  .decay(1.6).fast(2)`,

  // random-pipe rhythm scattering dots through perlin space
  'swarm': `shape("dot | [dot dot] | dot ~ dot")
  .x(perlin.range(0.05, 0.95).fast(2))
  .y(perlin.range(0.05, 0.95).fast(3))
  .color(saw.range(0, 2).add(perlin.range(0, 0.3)))
  .size(sine.range(0.008, 0.05).fast(4))
  .fast(8)
  .decay(sine.range(0.4, 2.5).slow(5))`,

  // euclidean stars, outline-only, opening and closing like flowers
  'bloom': `shape("star(5,8)")
  .radius(sine.range(0.14, 0.4).slow(5))
  .rotate(saw.range(0, 2).slow(3))
  .rotateX(sine.range(-0.25, 0.25).slow(7))
  .color("<#ff5d73 #b58cff #56b6ff #6df0c2>")
  .size(sine.range(0.05, 0.13).slow(2))
  .fill(0).stroke().weight("0.004 0.012")
  .decay(2).fast(2)`,

  // a spiral of lines unspooling, each clipped + tilted differently
  'ribbon': `shape("line*24")
  .radius(saw.range(0, 0.45))
  .rotate(saw.range(0, 1))
  .open(sine.range(0, 0.7).slow(3))
  .color(saw.range(0, 1).add(sine.range(0, 0.3).slow(4)))
  .size(sine.range(0.05, 0.12).slow(5))
  .weight(sine.range(0.003, 0.012).fast(2))
  .rotateY(sine.range(-0.35, 0.35).slow(5))
  .decay(2.2).fast(1.5)`,
};

function loadPreset(name) {
  editor.value = PRESETS[name];
  refreshHL();
  run();
}

// ── wiring ──────────────────────────────────────────────────────────────────────────
function setCps(v) { cps = v; cpsLabel.textContent = v.toFixed(2); }

editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); flash(); }
  // tab inserts two spaces instead of leaving the field
  if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText('  ', s, editor.selectionEnd, 'end'); refreshHL(); }
});
editor.addEventListener('input', refreshHL);
editor.addEventListener('scroll', () => { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; });

let flashT = 0;
function flash() {
  const el = $('#runbtn'); el.classList.add('lit'); clearTimeout(flashT);
  flashT = setTimeout(() => el.classList.remove('lit'), 220);
}

$('#runbtn').addEventListener('click', () => { run(); flash(); });
$('#playbtn').addEventListener('click', (e) => {
  playing = !playing; e.target.textContent = playing ? '❚❚ pause' : '▶ play';
});
$('#clearbtn').addEventListener('click', () => {
  particles.length = 0; ctx.fillStyle = '#06070a'; ctx.fillRect(0, 0, W, H);
});
$('#cps').addEventListener('input', (e) => setCps(Number(e.target.value)));
$('#persist').addEventListener('input', (e) => { decayScale = Number(e.target.value); });

const clockBtn = $('#clockbtn');
function renderClock() { clockBtn.classList.toggle('on', showClock); clockBtn.classList.toggle('off', !showClock); }
clockBtn.addEventListener('click', () => {
  showClock = !showClock;
  localStorage.setItem('loom.clock', showClock ? '1' : '0');
  renderClock();
});
renderClock();

const traceBtn = $('#tracebtn');
function renderTrace() { traceBtn.classList.toggle('on', traceMode); traceBtn.classList.toggle('off', !traceMode); }
traceBtn.addEventListener('click', () => {
  traceMode = !traceMode;
  localStorage.setItem('loom.trace', traceMode ? '1' : '0');
  renderTrace();
});
renderTrace();
document.querySelectorAll('[data-preset]').forEach((b) =>
  b.addEventListener('click', () => loadPreset(b.dataset.preset)));

const help = $('#help');
const toggleHelp = (show) => { help.hidden = show != null ? !show : !help.hidden; };
$('#helpbtn').addEventListener('click', () => toggleHelp());
$('#helpclose').addEventListener('click', () => toggleHelp(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleHelp(false); });

// ── fade the control overlay when idle, so the drawing has the screen ──
const rail = $('#rail');
const hintEl = $('#hint');
let idleTimer;
function setIdle(on) { rail.classList.toggle('idle', on); hintEl.classList.toggle('idle', on); }
function activity() {
  setIdle(false);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (document.activeElement !== editor) setIdle(true); }, 2600);
}
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, activity, { passive: true }));
editor.addEventListener('focus', activity);
editor.addEventListener('blur', activity);
// mouse leaving the window → fade right away (unless we're mid-edit)
document.addEventListener('mouseleave', () => { if (document.activeElement !== editor) setIdle(true); });

// ── boot ────────────────────────────────────────────────────────────────────────────
resize();
setCps(cps);
$('#persist').value = decayScale;
const saved = localStorage.getItem('loom.code');
editor.value = saved || PRESETS.threads;
refreshHL();
run();
activity();   // start the idle countdown
requestAnimationFrame((t) => { lastT = t; frame(t); });
