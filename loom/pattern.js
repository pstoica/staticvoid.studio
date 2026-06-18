// pattern.js, a tiny TidalCycles/Strudel-style pattern engine, retargeted at
// *drawing* instead of sound. A Pattern is a pure function from a stretch of
// cyclic time to a list of events (haps). Combinators transform that function;
// the renderer (main.js) queries the result each frame and turns every event
// onset into a glyph on the canvas.
//
// This is deliberately float-based (Strudel uses exact fractions). For a visual
// prototype the occasional sub-pixel boundary error is invisible, and the code
// stays readable.

const EPS = 1e-9;

// ── time spans ───────────────────────────────────────────────────────────────
const span = (begin, end) => ({ begin, end });
const mapSpan = (s, f) => span(f(s.begin), f(s.end));
const sect = (a, b) => span(Math.max(a.begin, b.begin), Math.min(a.end, b.end));

// Split a query span at integer cycle boundaries so each per-cycle generator
// only ever sees time within a single cycle. Zero-width spans (used to *sample*
// continuous signals at an instant) pass through untouched.
function spanCycles(s) {
  if (s.begin >= s.end) return s.begin === s.end ? [s] : [];
  const out = [];
  let b = s.begin;
  while (b < s.end - EPS) {
    const next = Math.min(Math.floor(b) + 1, s.end);
    out.push(span(b, next));
    b = next;
  }
  return out;
}

const hap = (whole, part, value) => ({ whole, part, value });
const hasOnset = (h) => h.whole && Math.abs(h.whole.begin - h.part.begin) < EPS;

// ── the Pattern type ──────────────────────────────────────────────────────────
class Pattern {
  constructor(query) { this.query = query; } // query: span -> hap[]

  fmap(f) {
    return new Pattern((s) => this.query(s).map((h) => hap(h.whole, h.part, f(h.value))));
  }
  filterValues(f) {
    return new Pattern((s) => this.query(s).filter((h) => f(h.value)));
  }
  withTime(fq, fr) {
    return new Pattern((s) =>
      this.query(mapSpan(s, fq)).map((h) =>
        hap(h.whole && mapSpan(h.whole, fr), mapSpan(h.part, fr), h.value)));
  }

  // ── speed / direction ──
  _fast(n) { return n === 0 ? silence : this.withTime((t) => t * n, (t) => t / n); }
  fast(n)  { return reify(n).fmap((x) => this._fast(x)).innerJoin(); }
  slow(n)  { return reify(n).fmap((x) => this._fast(1 / x)).innerJoin(); }
  _late(t) { return this.withTime((x) => x - t, (x) => x + t); }
  _early(t){ return this.withTime((x) => x + t, (x) => x - t); }
  late(t)  { return reify(t).fmap((x) => this._late(x)).innerJoin(); }
  early(t) { return reify(t).fmap((x) => this._early(x)).innerJoin(); }

  rev() {
    return new Pattern((s) => spanCycles(s).flatMap((sp) => {
      const cyc = Math.floor(sp.begin), next = cyc + 1;
      const reflect = (t) => cyc + (next - t);
      const rspan = (x) => span(reflect(x.end), reflect(x.begin));
      return this.query(rspan(sp)).map((h) =>
        hap(h.whole && rspan(h.whole), rspan(h.part), h.value));
    }));
  }

  // ── per-cycle structural transforms ──
  // bind/innerJoin let a pattern of patterns flatten, this is how `fast("2 4")`
  // (a *pattern* of speeds) works.
  innerJoin() {
    return new Pattern((s) =>
      this.query(s).flatMap((outer) =>
        outer.value.query(outer.part).map((inner) => {
          const part = sect(outer.part, inner.part);
          if (part.begin > part.end + EPS) return null;
          return hap(inner.whole, part, inner.value);
        }).filter(Boolean)));
  }

  every(n, f) {
    return new Pattern((s) => spanCycles(s).flatMap((sp) => {
      const cyc = Math.floor(sp.begin);
      return (((cyc % n) + n) % n === 0 ? f(this) : this).query(sp);
    }));
  }
  iter(n) { return slowcat(...Array.from({ length: n }, (_, i) => this._early(i / n))); }
  palindrome() { return slowcat(this, this.rev()); }

  off(t, f) { return stack(this, f(this._late(t))); }

  // overlay a transformed copy in place, stack(this, f(this)). The plain sibling
  // of jux (superimpose + pan apart) and off (superimpose + delay).
  superimpose(f) { return stack(this, f(this)); }

  // visual `jux`: clone the pattern, transform one copy, pan the two apart.
  jux(f) { return stack(this.set('pan', 0), f(this).set('pan', 1)); }

  // ── randomness (deterministic, seeded by event time) ──
  degradeBy(p) {
    return new Pattern((s) => this.query(s).filter((h) =>
      timeRand((h.whole || h.part).begin) >= p));
  }
  unDegradeBy(p) {
    return new Pattern((s) => this.query(s).filter((h) =>
      timeRand((h.whole || h.part).begin) < p));
  }
  degrade() { return this.degradeBy(0.5); }
  sometimesBy(p, f) { return stack(this.degradeBy(p), f(this.unDegradeBy(p))); }
  sometimes(f) { return this.sometimesBy(0.5, f); }
  often(f) { return this.sometimesBy(0.75, f); }
  rarely(f) { return this.sometimesBy(0.25, f); }

  // ── continuous signal helpers ──
  // lo/hi may each be a number, a mini-notation string, or a pattern, sampled
  // (structure from the left) so the range itself can move: `sine.range(0, "1 2")`.
  range(lo, hi) {
    return appLeft(appLeft(this.fmap((v) => (l) => (h) => l + v * (h - l)), reify(lo)), reify(hi));
  }
  // arithmetic, the argument may be a number, a mini-notation string, or any
  // Pattern (e.g. a signal). Structure comes from the left, value from the
  // right, so `saw.add(sine.range(0, 0.1))` wobbles a ramp by a sampled sine.
  add(arg) { return appLeft(this.fmap((l) => (r) => l + r), reify(arg)); }
  sub(arg) { return appLeft(this.fmap((l) => (r) => l - r), reify(arg)); }
  mul(arg) { return appLeft(this.fmap((l) => (r) => l * r), reify(arg)); }
  div(arg) { return appLeft(this.fmap((l) => (r) => l / r), reify(arg)); }
  quantize(n) { return this.fmap((v) => Math.round(v * n) / n); } // snap to nearest 1/n

  // ── control setters (structure from the left, value sampled from the right) ──
  set(name, arg) {
    const numeric = NUMERIC.has(name);
    const right = reifyControl(arg, numeric);
    return appLeft(this.fmap((l) => (r) => Object.assign({}, l, { [name]: r })), right);
  }
  color(a) { return this.set('color', a); }
  size(a)  { return this.set('size', a); }
  x(a)     { return this.set('x', a); }
  y(a)     { return this.set('y', a); }
  radius(a){ return this.set('radius', a); }
  angle(a) { return this.set('angle', a); }  // orbital position on the ring (turns); default = onset phase
  grid(cols, rows) { return this.set('gridX', cols).set('gridY', rows == null ? cols : rows); } // lay events into a cols×rows grid by onset
  rotate(a){ return this.set('rotate', a); }
  spin(a)  { return this.set('spin', a); }
  blend(a) { return this.set('blend', a); }
  alpha(a)   { return this.set('alpha', a); }
  opacity(a) { return this.set('alpha', a); } // alias for alpha
  pan(a)     { return this.set('pan', a); }
  jitter(a){ return this.set('jitter', a); }
  // draw style, fill and stroke are independent, patternable booleans, so you
  // can `.fill(0)` to disable fill, or `.stroke("1 0")` to alternate.
  fill(v = 1)   { return this.set('fill', v); }
  stroke(v = 1) { return this.set('stroke', v); }
  vertex(v = 1) { return this.set('vertex', v); }  // draw a dot at each vertex
  weight(a)  { return this.set('weight', a); }   // stroke width, absolute (fraction of min(w,h))
  outline(a) { return this.set('outline', a); }  // stroke width relative to the shape's radius (scales with size)
  cap(a)    { return this.set('cap', a); }   // line ends: 'round' | 'butt' | 'square'
  join(a)   { return this.set('join', a); }  // corners:   'round' | 'miter' | 'bevel'
  rotateX(a){ return this.set('rotateX', a); }  // tilt around horizontal axis (turns)
  rotateY(a){ return this.set('rotateY', a); }  // tilt around vertical axis (turns)
  open(a)   { return this.set('open', a); }     // arc/ring gap, 0..1 (fraction left open)
  // envelope (seconds): attack = fade-in, decay = fade-out / lifetime
  attack(a) { return this.set('attack', a); }
  decay(a)  { return this.set('decay', a); }
  life(a)   { return this.set('decay', a); } // alias for decay
}

const NUMERIC = new Set(['size','x','y','radius','angle','gridX','gridY','rotate','rotateX','rotateY','spin','alpha','pan','jitter','weight','attack','decay','fill','stroke','vertex','open']);

// ── primitives ────────────────────────────────────────────────────────────────
const silence = new Pattern(() => []);

function pure(value) {
  return new Pattern((s) => spanCycles(s).map((sp) => {
    const cyc = Math.floor(sp.begin);
    return hap(span(cyc, cyc + 1), sp, value);
  }));
}

function stack(...pats) {
  return new Pattern((s) => pats.flatMap((p) => p.query(s)));
}

// slowcat: one pattern per cycle, in turn.
function slowcat(...pats) {
  pats = pats.filter(Boolean);
  if (!pats.length) return silence;
  return new Pattern((s) => spanCycles(s).flatMap((sp) => {
    const cyc = Math.floor(sp.begin);
    const n = pats.length;
    const i = ((cyc % n) + n) % n;
    const off = cyc - Math.floor(cyc / n);
    return pats[i].withTime((t) => t - off, (t) => t + off).query(sp);
  }));
}
function fastcat(...pats) { return slowcat(...pats)._fast(pats.filter(Boolean).length || 1); }

// timecat: like fastcat but each pattern takes a weighted slice of the cycle.
function timecat(pairs) {
  pairs = pairs.filter(([, p]) => p);
  const total = pairs.reduce((a, [w]) => a + w, 0) || 1;
  let acc = 0;
  const parts = pairs.map(([w, p]) => {
    const b = acc / total, e = (acc + w) / total; acc += w;
    return compress(b, e, p);
  });
  return stack(...parts);
}

// fastGap squeezes a pattern into the first 1/n of each cycle, leaving a gap.
function fastGap(factor, pat) {
  if (factor <= 0) return silence;
  const munge = (s) => {
    const c = Math.floor(s.begin);
    return span(c + Math.min(1, (s.begin - c) * factor), c + Math.min(1, (s.end - c) * factor));
  };
  const unmunge = (s) => {
    const c = Math.floor(s.begin);
    return span(c + (s.begin - c) / factor, c + (s.end - c) / factor);
  };
  // Query one cycle at a time: a span that straddles a cycle boundary would
  // munge both ends against the same Math.floor reference and collapse to a
  // point. spanCycles keeps each sub-query inside a single cycle.
  return new Pattern((s) => spanCycles(s).flatMap((sp) => {
    const m = munge(sp);
    if (m.begin >= m.end - EPS && sp.begin < sp.end - EPS) return [];
    return pat.query(m).map((h) => hap(h.whole && unmunge(h.whole), unmunge(h.part), h.value))
      .filter((h) => h.part.begin < h.part.end + EPS);
  }));
}
function compress(b, e, pat) {
  if (b > e || b > 1 || e > 1 || b < 0 || e < 0 || b === e) return silence;
  return fastGap(1 / (e - b), pat)._late(b);
}

// ── continuous signals ─────────────────────────────────────────────────────────
function signal(f) {
  return new Pattern((s) => [hap(undefined, s, f((s.begin + s.end) / 2))]);
}
const TAU = Math.PI * 2;
const sine   = signal((t) => (Math.sin(TAU * t) + 1) / 2);
const cosine = signal((t) => (Math.cos(TAU * t) + 1) / 2);
const saw    = signal((t) => t - Math.floor(t));
const isaw   = signal((t) => 1 - (t - Math.floor(t)));
const tri    = signal((t) => { const x = t - Math.floor(t); return x < 0.5 ? x * 2 : 2 - x * 2; });
const square = signal((t) => ((t - Math.floor(t)) < 0.5 ? 0 : 1));
function timeRand(x) {
  const s = Math.sin((x + 0.123) * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
// ── a small noise family, all in 0..1, sampled at each event's onset ──
const smoothstep = (t) => t * t * (3 - 2 * t);
// value noise: hash the integer lattice, smoothstep between neighbours.
function valueNoise(x) {
  const i = Math.floor(x), f = x - i, u = smoothstep(f);
  return timeRand(i) * (1 - u) + timeRand(i + 1) * u;
}
// fractal brownian motion: stack octaves of value noise.
function fbmAt(x, octaves, persist) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { sum += valueNoise(x * freq) * amp; norm += amp; freq *= 2; amp *= persist; }
  return sum / norm;
}

const rand   = signal((t) => timeRand(t));                 // white noise, uncorrelated, harsh
const perlin = signal((t) => valueNoise(t * 4));           // smooth value noise, gentle drift
const fbm    = signal((t) => fbmAt(t * 2, 5, 0.5));        // fractal noise, organic, cloudy
const brown  = signal((t) => fbmAt(t * 1.2, 6, 0.72));     // red/brownian, slow, wandering
const gauss  = signal((t) => {                              // bell curve around 0.5 (central-limit of 4 rands)
  let s = 0; for (let k = 1; k <= 4; k++) s += timeRand(t + k * 0.137);
  return s / 4;
});
const white = rand;

// random discrete choice, fresh per onset: choose("#fff", "#000") or choose(0, 3, 7)
function choose(...xs) { return signal((t) => xs[Math.min(xs.length - 1, Math.floor(timeRand(t) * xs.length))]); }
// random integer in 0..n-1
function irand(k) { return signal((t) => Math.floor(timeRand(t) * k)); }

// ── live oscillator (LFO) ──────────────────────────────────────────────────────
// Unlike a signal (which is sampled once at a glyph's onset and frozen) an osc
// keeps running over the glyph's whole lifetime, evaluated each frame against its
// age. osc(rate, shape).range(lo, hi). Shapes: sine saw tri square rand perlin fbm.
function osc(rate = 1, shape = 'sine') { return makeOsc({ shape, rate, lo: 0, hi: 1, phase: 0 }); }
function makeOsc(o) {
  return {
    __osc: o,
    range(lo, hi) { return makeOsc({ ...o, lo, hi }); },
    rate(r) { return makeOsc({ ...o, rate: r }); },
    phase(p) { return makeOsc({ ...o, phase: p }); },
    spread(n = 1) { return makeOsc({ ...o, spread: n }); }, // per-glyph phase offset = n × onset phase
    fast(n) { return makeOsc({ ...o, rate: o.rate * n }); },
    slow(n) { return makeOsc({ ...o, rate: o.rate / n }); },
    // arithmetic on the osc's output (x may be a number or another osc), applied
    // after range, evaluated live by the renderer.
    add(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['+', x]] }); },
    sub(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['-', x]] }); },
    mul(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['*', x]] }); },
    div(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['/', x]] }); },
    quantize(n) { return makeOsc({ ...o, ops: [...(o.ops || []), ['q', n]] }); }, // snap to nearest 1/n
  };
}
const isOsc = (a) => a != null && typeof a === 'object' && a.__osc !== undefined;

// ── palettes ───────────────────────────────────────────────────────────────────
// Built-in colour ramps, usable by name: palette("sunset"). Interpolated in
// OKLCH by the renderer.
const PALETTES = {
  sunset:  ['#ffd166', '#ff7d5c', '#ff5d8f', '#b5179e', '#3a0ca3'],
  ember:   ['#03071e', '#6a040f', '#dc2f02', '#f48c06', '#ffd166'],
  ice:     ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8'],
  neon:    ['#ff006e', '#fb5607', '#ffbe0b', '#8338ec', '#3a86ff'],
  forest:  ['#081c15', '#1b4332', '#2d6a4f', '#52b788', '#b7e4c7'],
  candy:   ['#ffadad', '#ffd6a5', '#caffbf', '#9bf6ff', '#bdb2ff', '#ffc6ff'],
  mono:    ['#0a0a0a', '#5a5a5a', '#b0b0b0', '#f4f4f4'],
  rainbow: ['#ff5d5d', '#ff9f1c', '#ffe066', '#5dd39e', '#56b6ff', '#8a5cff', '#ff7de0'],
  aurora:  ['#0b3d91', '#1ec8c8', '#7fffd4', '#b58cff'],
};

// palette("#a", "#b", …) or palette("sunset").at(x) maps a 0..1 position x (a
// number, pattern, or osc) to an interpolated colour, for use in .color(). We
// just package the stops + position here; the renderer does the interpolation.
function palette(...colors) {
  let stops = colors.flat();
  if (stops.length === 1 && PALETTES[stops[0]]) stops = PALETTES[stops[0]]; // named ramp
  return {
    __pal: stops,
    at(x) {
      if (isOsc(x)) return makeOsc({ ...x.__osc, pal: stops });                       // live
      if (x instanceof Pattern || typeof x === 'string') return reify(x).fmap((v) => ({ __pal: stops, t: +v }));
      return pure({ __pal: stops, t: +x });                                           // fixed
    },
  };
}

// ── background colour ───────────────────────────────────────────────────────────
// bg("#101820") sets the canvas background for this patch. Returns silence so it
// can sit inside a stack(...). The renderer reads it through a registered sink.
let _bgSink = null;
function _setBgSink(fn) { _bgSink = fn; }
// the arg is resolved per-frame by the renderer, so bg() is patternable: a string
// is mini-notation (bg("<#001 #103>")), and oscs / patterns / palettes also work.
function bg(color) { if (_bgSink) _bgSink(typeof color === 'string' ? mini(color) : color); return silence; }

// ── groups ──────────────────────────────────────────────────────────────────────
// group(pattern) is a layer rendered to its own buffer, so an effect can be
// applied to the whole layer before it's composited. group(...).pixelate(n) is the
// first supported fx. It quacks like a Pattern (has .query) so it stacks normally.
let _gid = 0;
class Group {
  constructor(pat) { this._pat = reify(pat); this._gid = ++_gid; this._fx = { chain: [] }; }
  // Each effect appends to an ordered chain; the renderer runs them in call order
  // as post-process passes on the group's render target. Every param may be a
  // number, an osc, or a pattern, resolved against *global* time each frame
  // (FX run per-layer-per-frame, not per-glyph). pixelate also keeps a flat
  // `_fx.pixelate` so the legacy Canvas2D renderer still applies it.
  // string params are mini-notation, like any control arg → reify to a pattern
  // (sampled at the current cycle by the renderer). Numbers/oscs/patterns pass through.
  _push(fx) {
    for (const k in fx) if (k !== 'type' && typeof fx[k] === 'string') fx[k] = mini(fx[k]);
    this._fx.chain.push(fx); return this;
  }
  pixelate(n) { this._fx.pixelate = n; return this._push({ type: 'pixelate', block: n }); }      // block size, px
  blur(n = 4) { return this._push({ type: 'blur', radius: n }); }                                  // gaussian radius, px
  feedback(fade = 0.92, zoom = 1.0, rot = 0) { return this._push({ type: 'feedback', fade, zoom, rot }); } // trails/tunnel
  trails(fade = 0.92) { return this._push({ type: 'feedback', fade, zoom: 1.0, rot: 0 }); }        // feedback, no warp
  hue(t = 0) { return this._push({ type: 'grade', hue: t }); }                                     // hue shift, turns
  brightness(b = 1) { return this._push({ type: 'grade', brightness: b }); }                       // 1 = identity
  contrast(c = 1) { return this._push({ type: 'grade', contrast: c }); }                           // 1 = identity
  saturate(s = 1) { return this._push({ type: 'grade', saturate: s }); }                           // 0 = grayscale
  negative(amount = 1) { return this._push({ type: 'negative', amount }); }                         // colour invert (0 = off)
  invert(amount = 1) { return this._push({ type: 'negative', amount }); }                           // alias for negative
  displace(amount = 0.02, scale = 3) { return this._push({ type: 'displace', amount, scale }); }   // uv warp
  kaleido(n = 6) { return this._push({ type: 'kaleido', slices: n }); }                            // radial mirror (<2 = off)
  mirror(on = 1) { return this._push({ type: 'mirror', on }); }                                     // left/right symmetry (0 = off)
  tile(x = 2, y = x) { return this._push({ type: 'tile', x, y }); }                                 // repeat in an x×y grid (1×1 = off)
  dots(n = 8) { return this._push({ type: 'dots', cell: n }); }                                     // halftone: cell px, dots grow with brightness (<2 = off)
  halftone(n = 8) { return this._push({ type: 'dots', cell: n }); }                                 // alias for dots
  rgbshift(amount = 0.005, angle = 0) { return this._push({ type: 'rgbshift', amount, angle }); }   // chromatic aberration (0 = off)
  rgb(amount = 0.005, angle = 0) { return this._push({ type: 'rgbshift', amount, angle }); }        // alias for rgbshift
  posterize(levels = 4) { return this._push({ type: 'posterize', levels }); }                       // quantize colours (<2 = off)
  dither(levels = 4) { return this._push({ type: 'dither', levels }); }                             // ordered Bayer dither (<2 = off)
  scanlines(amount = 0.5, period = 3) { return this._push({ type: 'scanlines', amount, period }); } // CRT lines (0 = off)
  // slice into bands and offset each; mode "h" | "v" | "grid" (amount = off at 0).
  // pattern/osc the amount to make the slices judder.
  slice(count = 8, amount = 0.1, mode = 'h') {
    const m = mode === 'v' ? 1 : (mode === 'grid' || mode === 'both') ? 2 : 0;
    return this._push({ type: 'slice', count, amount, mode: m });
  }
  lens(amount = 0.4) { return this._push({ type: 'lens', amount }); }                                // barrel (+) / pincushion (-) (0 = off)
  opacity(alpha = 1) { return this._push({ type: 'opacity', alpha }); }                              // fade the whole group (1 = off)
  alpha(a = 1) { return this._push({ type: 'opacity', alpha: a }); }                                 // alias for opacity
  // ── layer composition: scale / translate / rotate the whole group, crop to a ratio ──
  scale(s = 1) { return this._push({ type: 'transform', scale: s, angle: 0, x: 0, y: 0 }); }         // zoom about centre (s<1 shrinks, bg shows; 1 = off)
  move(x = 0, y = 0) { return this._push({ type: 'transform', scale: 1, angle: 0, x, y }); }         // translate the layer (uv; 0,0 = off)
  turn(t = 0) { return this._push({ type: 'transform', scale: 1, angle: t, x: 0, y: 0 }); }          // rotate the whole layer, turns (0 = off)
  aspect(ratio = 1) {                                                                                 // crop to a centred w/h ratio (letterbox); ≤0 = off
    let r = ratio;
    if (typeof ratio === 'string' && ratio.includes(':')) { const [w, h] = ratio.split(':'); r = parseFloat(w) / parseFloat(h); }
    return this._push({ type: 'aspect', ratio: r });
  }
  query(s) {
    const gid = this._gid, fx = this._fx;
    return this._pat.query(s).map((h) => hap(h.whole, h.part, Object.assign({}, h.value, { _gid: gid, _fx: fx })));
  }
}
function group(pat) { return new Group(pat); }

// ── combine two patterns: structure from the left, value sampled from right ────
function appLeft(pf, pv) {
  return new Pattern((s) => {
    const out = [];
    for (const hf of pf.query(s)) {
      for (const hv of pv.query(hf.part)) {
        const part = sect(hf.part, hv.part);
        if (part.begin > part.end + EPS) continue;
        if (part.begin === part.end && hf.part.begin !== hf.part.end) continue;
        out.push(hap(hf.whole, part, hf.value(hv.value)));
      }
    }
    return out;
  });
}

// ── euclidean rhythms (Bjorklund) ──────────────────────────────────────────────
function bjorklund(k, n) {
  if (n <= 0 || k <= 0) return new Array(Math.max(0, n)).fill(false);
  k = Math.min(k, n);
  let a = Array.from({ length: k }, () => [true]);
  let b = Array.from({ length: n - k }, () => [false]);
  while (b.length > 1) {
    const m = Math.min(a.length, b.length);
    const na = [], nb = [];
    for (let i = 0; i < m; i++) na.push(a[i].concat(b[i]));
    if (a.length > m) for (let i = m; i < a.length; i++) nb.push(a[i]);
    else for (let i = m; i < b.length; i++) nb.push(b[i]);
    a = na; b = nb;
  }
  return a.concat(b).flat();
}
function euclid(k, n, pat, rot = 0) {
  let bits = bjorklund(k, n);
  if (rot) { rot = ((rot % n) + n) % n; bits = bits.slice(rot).concat(bits.slice(0, rot)); }
  return fastcat(...bits.map((on) => (on ? pat : silence)));
}

// random choice, one alternative per cycle: "a | b | c"
function randcat(...pats) {
  pats = pats.filter(Boolean);
  if (!pats.length) return silence;
  return new Pattern((s) => spanCycles(s).flatMap((sp) => {
    const cyc = Math.floor(sp.begin);
    const i = Math.floor(timeRand(cyc + 0.5) * pats.length) % pats.length;
    return pats[i].query(sp);
  }));
}

// polymeter: play `steps` items per cycle from a list, wrapping across cycles.
// "{a b c}%4" → a b c a | b c a b | …  (4 steps/cycle from a 3-item list)
function polymeter(items, steps) {
  const k = items.length;
  if (!k) return silence;
  steps = steps || k;
  return new Pattern((s) => spanCycles(s).flatMap((sp) => {
    const cyc = Math.floor(sp.begin);
    const seqPats = [];
    for (let j = 0; j < steps; j++) seqPats.push(items[(((cyc * steps + j) % k) + k) % k]);
    return fastcat(...seqPats).query(sp);
  }));
}

// ── mini-notation parser ───────────────────────────────────────────────────────
// Supports: sequences "a b c", grouping [a b], alternation <a b>, parallel
// [a , b], fast a*2, slow a/2, replicate a!3, weight a@3, rests ~, and
// euclid a(3,8) / a(3,8,1).
function mini(str) { return parseMiniClean(String(str)); }

function parseMiniClean(str) {
  let i = 0;
  const ws = () => { while (i < str.length && /\s/.test(str[i])) i++; };

  function seq(close) {
    const groups = [[]];
    let sawPipe = false;
    ws();
    while (i < str.length && str[i] !== close) {
      if (str[i] === ',') { i++; groups.push([]); ws(); continue; }       // parallel
      if (str[i] === '|') { i++; groups.push([]); sawPipe = true; ws(); continue; } // random
      const before = i;
      const t = term(); if (t) groups[groups.length - 1].push(t); ws();
      if (i === before) i++;   // unparseable char (e.g. a stray '(') → skip, never loop forever
    }
    const layers = groups.map((g) => (g.length ? timecat(g) : silence));
    if (layers.length <= 1) return layers[0] || silence;
    return sawPipe ? randcat(...layers) : stack(...layers);
  }
  // polymeter {a b c}%n : layers split by comma, each plays `base` steps/cycle.
  function polyAtom() {
    const layers = [[]];
    ws();
    while (i < str.length && str[i] !== '}') {
      if (str[i] === ',') { i++; layers.push([]); ws(); continue; }
      const before = i;
      const t = term(); if (t) layers[layers.length - 1].push(t[1]); ws();
      if (i === before) i++;
    }
    if (str[i] === '}') i++;
    let steps = 0;
    if (str[i] === '%') { i++; steps = num(); }
    const base = steps || (layers[0] ? layers[0].length : 1);
    const pats = layers.map((items) => polymeter(items, base));
    return pats.length > 1 ? stack(...pats) : (pats[0] || silence);
  }
  function altSeq() { // collect top-level items for <...>
    const items = [];
    ws();
    while (i < str.length && str[i] !== '>') {
      const before = i;
      const t = term(); if (t) items.push(t[1]); ws();
      if (i === before) i++;
    }
    return slowcat(...items);
  }
  function term() {
    let pat = atom(); if (!pat) return null;
    let weight = 1;
    for (;;) {
      const c = str[i];
      if (c === '*') { i++; pat = pat._fast(num()); }
      else if (c === '/') { i++; pat = pat._fast(1 / num()); }
      else if (c === '@') { i++; weight = num(); }
      else if (c === '!') { i++; const n = num(); pat = fastcat(...Array(n).fill(pat)); weight = n; }
      else if (c === '(') { i++; const k = num(); comma(); const n = num(); let r = 0; if (str[i] === ',') { comma(); r = num(); } ws(); if (str[i] === ')') i++; pat = euclid(k, n, pat, r); }
      else break;
    }
    return [weight, pat];
  }
  function atom() {
    ws();
    const c = str[i];
    if (c === '[') { i++; const p = seq(']'); ws(); if (str[i] === ']') i++; return p; }
    if (c === '<') { i++; const p = altSeq(); ws(); if (str[i] === '>') i++; return p; }
    if (c === '{') { i++; return polyAtom(); }
    if (c === '~') { i++; return silence; }
    return token();
  }
  function token() {
    const s = i;
    while (i < str.length && !/[\s\[\]<>(){}|,*/!@%]/.test(str[i])) i++;
    const t = str.slice(s, i);
    if (t === '') return null;
    const n = Number(t);
    return pure(Number.isNaN(n) ? t : n);
  }
  function num() { ws(); const s = i; while (i < str.length && /[-0-9.]/.test(str[i])) i++; return Number(str.slice(s, i)); }
  function comma() { ws(); if (str[i] === ',') i++; ws(); }

  return seq(undefined);
}

// ── reification: turn a user arg into a Pattern ─────────────────────────────────
function reify(arg) {
  if (arg instanceof Pattern) return arg;
  if (typeof arg === 'string') return mini(arg);
  return pure(arg);
}
function reifyControl(arg, numeric) {
  if (arg instanceof Pattern) return arg;
  if (typeof arg === 'number') return pure(arg);
  if (typeof arg === 'string') {
    const p = mini(arg);
    return numeric ? p.fmap((v) => Number(v)) : p;
  }
  return pure(arg);
}

// ── DSL entry points (these produce control-bearing patterns) ──────────────────
function shape(arg) { return reify(arg).fmap((v) => ({ shape: String(v) })); }
const s = shape;
function n(arg) { return reify(arg).fmap((v) => ({ shape: 'dot', n: Number(v) })); }
function run(k) { return fastcat(...Array.from({ length: k }, (_, i) => pure(i))); }
function range(pat, lo, hi) { return reify(pat).range(lo, hi); }

// free-function forms used in scripts
const cat = slowcat;
const seq = fastcat;
const sequence = fastcat;
function fast(n, p) { return reify(p)._fast(n); }
function slow(n, p) { return reify(p)._fast(1 / n); }
function rev(p) { return reify(p).rev(); }

export const DSL = {
  Pattern, pure, silence, stack, slowcat, fastcat, cat, seq, sequence, timecat,
  fast, slow, rev, run, range, mini, euclid,
  shape, s, n, choose, irand, osc, palette, bg, group, _setBgSink,
  sine, cosine, saw, isaw, tri, square, rand, perlin, fbm, brown, gauss, white,
  hasOnset, span, isOsc,
};
