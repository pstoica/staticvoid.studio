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

// ── easing curves (Penner / anime.js set) ───────────────────────────────────────
// A 0..1 → 0..1 remap, used to *shape* a normalized signal before it's ranged: a
// linear ramp (saw) becomes an accelerating/decelerating/overshooting one. Pure
// curve maths, no runtime dep. Each family has in / out / inOut variants derived
// from the canonical "in" curve: out(t)=1−in(1−t), inOut splits the unit interval.
// back / elastic / bounce intentionally overshoot OUTPUT past [0,1] — that swing is
// the point — so we clamp the INPUT domain but never the output.
const PI = Math.PI;
const _easeIn = {
  quad:  (t) => t * t,
  cubic: (t) => t * t * t,
  quart: (t) => t * t * t * t,
  expo:  (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  sine:  (t) => 1 - Math.cos((t * PI) / 2),
  back:  (t) => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
  elastic: (t) => { if (t === 0 || t === 1) return t; const c4 = (2 * PI) / 3; return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4); },
};
function _bounceOut(t) {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}
const EASE = { linear: (t) => t };
for (const [fam, fn] of Object.entries(_easeIn)) {
  const C = fam[0].toUpperCase() + fam.slice(1);
  EASE['in' + C] = fn;
  EASE['out' + C] = (t) => 1 - fn(1 - t);
  EASE['inOut' + C] = (t) => (t < 0.5 ? fn(2 * t) / 2 : 1 - fn(2 - 2 * t) / 2);
}
EASE.outBounce = _bounceOut;
EASE.inBounce = (t) => 1 - _bounceOut(1 - t);
EASE.inOutBounce = (t) => (t < 0.5 ? (1 - _bounceOut(1 - 2 * t)) / 2 : (1 + _bounceOut(2 * t - 1)) / 2);

// apply a named curve to t. Clamp the input to [0,1] (Penner curves are only defined
// there; expo/elastic explode outside it) but let the output overshoot. Unknown name
// → identity, so a typo degrades to "no easing" rather than NaN.
function ease(name, t) {
  const fn = EASE[name];
  if (!fn) return t;
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return fn(x);
}

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

  // ── value-driven branching ──
  // when(cond, f): apply f to the events where `cond` is truthy (>0.5) at their onset, and
  // leave the rest unchanged — a signal-driven cousin of `sometimes`. cond may be a number,
  // mini-notation, or a signal: `.when("<1 0>", p => p.fast(2))` every other cycle;
  // `.when(mouseDown, p => p.size(0.12))` makes glyphs spawned while pressed big.
  when(cond, f) {
    const c = reify(cond);
    // sample cond at the event's onset. A tiny forward window (not a zero-width instant), so a
    // discrete pattern like "1 0 1 0" returns the step covering the onset instead of collapsing.
    const at = (t) => { const hs = c.query(span(t, t + 1e-6)); for (const h of hs) if (h.value != null) return +h.value; return 0; };
    const split = (keep) => new Pattern((s) => this.query(s).filter((h) => (at((h.whole || h.part).begin) > 0.5) === keep));
    return stack(f(split(true)), split(false));
  }

  // gate(cond): keep only the events whose `cond` is truthy (>0.5) at their onset; drop the rest.
  // The general fix for a stale external input — gate by its "is it live?" signal so it stops
  // drawing when there's no fresh data: `.gate(ballSeen("a"))` (in frame), `.gate(mouseDown)`
  // (while pressed), `.gate(gate())` (a MIDI note held). cond may be a number, pattern, or signal.
  gate(cond) {
    const c = reify(cond);
    const at = (t) => { const hs = c.query(span(t, t + 1e-6)); for (const h of hs) if (h.value != null) return +h.value; return 0; };
    return new Pattern((s) => this.query(s).filter((h) => at((h.whole || h.part).begin) > 0.5));
  }

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
  // ease(name): shape this 0..1 signal through a Penner curve, BEFORE any .range().
  // The rule is "ease the unit signal, range maps it", so `saw.ease("outExpo").range(0,1)`
  // accelerates the ramp then maps it. The curve name is itself sampled from the right,
  // so it can be a mini-notation pattern: `.ease("<inOutSine outBack>")` alternates curves.
  ease(name) { return appLeft(this.fmap((v) => (nm) => ease(String(nm), v)), reify(name)); }
  // segment(n): sample this pattern n times per cycle on an EVEN time grid and hold
  // each value for its 1/n slice. Turns a continuous signal (sine/perlin/…) into n
  // rhythmic, time-quantized steps — Tidal's `segment`/`discretise`. (quantize() steps
  // the VALUE; segment() steps the TIME.) Sample is frozen at each slice's midpoint, so
  // it holds steady across the slice no matter when it's read.
  segment(n) {
    const src = this;
    const grid = pure(0)._fast(n);                  // n equal slices per cycle (timing only)
    return new Pattern((s) => grid.query(s).flatMap((h) => {
      if (!h.whole) return [];
      const w = h.whole, t = (w.begin + w.end) / 2; // slice + its midpoint (fixed per slice)
      // Sample over the WHOLE slice, not an instant: a signal returns its midpoint value,
      // and a discrete/ranged source keeps a finite (non-collapsing) part. Pick whatever
      // covers the midpoint so it's the same value no matter when the slice is read.
      const vs = src.query(span(w.begin, w.end));
      const pick = vs.find((x) => x.part.begin <= t + EPS && t < x.part.end + EPS) || vs[vs.length - 1];
      const v = pick ? pick.value : undefined;
      return v == null ? [] : [hap(w, h.part, v)];
    }));
  }
  seg(n) { return this.segment(n); }                // Strudel alias
  // sample(n): real-time sample-and-HOLD — capture this signal's value the first time each
  // 1/n-cycle slot is reached, then hold it until the next slot. Unlike segment (which reads
  // a fixed pattern-time midpoint), this snapshots whatever the source returns AT THAT MOMENT,
  // so it works on EXTERNAL live signals like `mouseX` — where segment is a no-op, since the
  // pointer ignores pattern-time. `mouseX.sample(8)` = the pointer stepped/held at 8/cycle.
  sample(n) {
    const src = this;
    const cache = new Map();                         // slot → captured value (held)
    return new Pattern((s) => {
      const t = (s.begin + s.end) / 2;
      const slot = Math.floor(t * n);
      if (!cache.has(slot)) {
        const vs = src.query(span(t, t));            // snapshot the source as of now
        cache.set(slot, vs.length ? vs[vs.length - 1].value : undefined);
        if (cache.size > 128) cache.delete(cache.keys().next().value);   // prune oldest
      }
      const v = cache.get(slot);
      return v == null ? [] : [hap(undefined, s, v)];
    });
  }

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
  shade(a)   { return this.set('shade', a); }     // 3D shapes: 0 flat/unlit (default), 1 faceted lighting
  cap(a)    { return this.set('cap', a); }   // line ends: 'round' | 'butt' | 'square'
  join(a)   { return this.set('join', a); }  // corners:   'round' | 'miter' | 'bevel'
  rotateX(a){ return this.set('rotateX', a); }  // tilt around horizontal axis (turns)
  rotateY(a){ return this.set('rotateY', a); }  // tilt around vertical axis (turns)
  open(a)   { return this.set('open', a); }     // arc/ring gap, 0..1 (fraction left open)
  // envelope (seconds): attack = fade-in, decay = fade-out / lifetime. An optional
  // second arg names a Penner curve to shape that segment instead of a straight line:
  // .attack(0.3, "outBack") eases the fade-in, .decay(2, "inOutSine") shapes the fade-out.
  attack(a, curve) { const p = this.set('attack', a); return curve != null ? p.set('attackEase', curve) : p; }
  decay(a, curve)  { const p = this.set('decay', a);  return curve != null ? p.set('decayEase', curve) : p; }
  life(a, curve)   { return this.decay(a, curve); } // alias for decay
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

// ── live pointer input (mouse / touch), as signals ──────────────────────────────
// mouseX / mouseY are the pointer position (0..1 of the canvas); mouseDown is 1 while
// pressed. They're SIGNALS (like sine/saw), so they obey Loom's frozen/live rule for free:
//  • on a per-glyph control they're sampled at that glyph's ONSET and frozen — so a stream
//    of glyphs with `.x(mouseX).y(mouseY)` leaves a TRAIL where the pointer was as each
//    spawned ("where things spawn"),
//  • as an FX / physics param they're re-read every frame (evalGlobal re-queries), so
//    `{ attract: 1, ax: mouseX, ay: mouseY }` is a LIVE cursor-driven attractor.
// They compose like any signal: `.range()`, arithmetic, `.color(mouseX)`, etc. main.js
// feeds the position in through _setPointer (a sink, like _setBgSink for bg).
let _pointer = { x: 0.5, y: 0.5, down: 0 };
function _setPointer(x, y, down) { _pointer.x = x; _pointer.y = y; _pointer.down = down ? 1 : 0; }
const mouseX = signal(() => _pointer.x);
const mouseY = signal(() => _pointer.y);
const mouseDown = signal(() => _pointer.down);

// ── MIDI input (Web MIDI), as signals ────────────────────────────────────────────
// Like the pointer, MIDI is external state mirrored into SIGNALS. main.js requests Web MIDI
// access and pumps every message into _midiInput; the signals below read the latest state:
//   cc(num, ch)  control change (0..1)        gate(ch)  1 while a note is held, else 0
//   vel(ch)      last held note's velocity     note(ch)  last held note's pitch (0..1 = 0..127)
//   bend(ch)     pitch bend (-1..1)
// channel 0 = OMNI (any channel); 1..16 = a specific channel — so independent inputs (e.g.
// the juggling balls, each on its own channel with its own CCs) map cleanly to channels. Being
// signals, they obey the frozen/live rule: frozen at a glyph's onset (spawn a glyph per note),
// live as an FX/physics param.
const _midi = { cc: {}, notes: {}, bend: {}, pending: [], frame: [] };
function _midiInput(status, d1, d2) {
  const type = status & 0xf0, ch = (status & 0x0f) + 1;          // 1..16
  if (type === 0xB0) {                                            // control change → ch + omni
    (_midi.cc[ch] || (_midi.cc[ch] = {}))[d1] = d2;
    (_midi.cc[0] || (_midi.cc[0] = {}))[d1] = d2;
  } else if (type === 0x90 && d2 > 0) {                           // note on
    (_midi.notes[ch] || (_midi.notes[ch] = new Map())).set(d1, d2);
    _midi.pending.push({ ch, note: d1, vel: d2 });               // queue the note-on for onNote()
    if (_midi.pending.length > 256) _midi.pending.shift();       // cap (e.g. clock paused)
  } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {      // note off (or note-on vel 0)
    if (_midi.notes[ch]) _midi.notes[ch].delete(d1);
  } else if (type === 0xE0) {                                     // pitch bend (14-bit → -1..1)
    const v = (((d2 << 7) | d1) - 8192) / 8192;
    _midi.bend[ch] = v; _midi.bend[0] = v;
  }
}
// the Map of notes held on channel `ch` (or any channel for omni 0), or null if none held
const _held = (ch) => { if (ch) return (_midi.notes[ch] && _midi.notes[ch].size) ? _midi.notes[ch] : null; for (const c in _midi.notes) if (_midi.notes[c].size) return _midi.notes[c]; return null; };
const _lastHeld = (ch) => { const m = _held(ch); let e = null; if (m) for (const x of m) e = x; return e; };   // [note, vel] most-recent held
function cc(num, ch = 0) { return signal(() => ((_midi.cc[ch] && _midi.cc[ch][num]) || 0) / 127); }
function gate(ch = 0) { return signal(() => (_held(ch) ? 1 : 0)); }
function vel(ch = 0) { return signal(() => { const e = _lastHeld(ch); return e ? e[1] / 127 : 0; }); }
function note(ch = 0) { return signal(() => { const e = _lastHeld(ch); return e ? e[0] / 127 : 0; }); }
// pitch CLASS, 0..1 — the note within its octave (note % 12), so the same note name maps to the
// same value across octaves. Pair with palette().at(pc(ch)) for octave-independent colour.
function pc(ch = 0) { return signal(() => { const e = _lastHeld(ch); return e ? (e[0] % 12) / 12 : 0; }); }
function bend(ch = 0) { return signal(() => _midi.bend[ch] || 0); }
// onNote(ch, shape): an EVENT source — emits exactly ONE glyph per MIDI note-on (not a sampled
// stream like gate). The tick loop calls _midiFrame() once per frame to snapshot that frame's
// note-ons into _midi.frame, so the source is pure within the frame (re-queries / multiple layers
// see the same events). Each note's pitch/velocity is captured by chaining .y(note(ch)).size(vel(ch))
// — note(ch)/vel(ch) read the just-arrived note at the glyph's onset. ch 0 = any channel.
function _midiFrame() { _midi.frame = _midi.pending; _midi.pending = []; }
function onNote(ch = 0, shape = 'dot') {
  return new Pattern((s) => _midi.frame
    .filter((e) => !ch || e.ch === ch)
    .map(() => hap({ begin: s.begin, end: s.end }, s, { shape: String(shape) })));
}

// ── juggling feed (WebSocket ball tracking), as signals ───────────────────────────
// A separate local app tracks juggling balls — webcam position + on-ball IMU — and pushes plain
// JSON over a WebSocket (see REFERENCE.md). main.js owns the socket (read-only) and pumps every
// message into _jugInput; the signals below read the latest state. This is the SPATIAL layer
// ("where the ball is"); the musical layer ("what the music does") arrives separately over MIDI.
//   ballX/ballY(id)  position 0..1 of the camera frame (origin top-left, like mouseX/mouseY)
//   ballSeen(id)     1 while the ball is detected this frame, else 0
//   thrown/caught/tapped(id)   discrete throw/catch/tap as a decaying 0..1 pulse (a flash)
//   flight(id)       last catch's airtime (seconds, held)     gyro(id)  IMU spin 0..1 (optional)
// The ball id is the join key — "a"/"b"/"c" (or 0/1/2, or "ball_a") — the SAME across position
// and events, so each ball is its own independent input. Signals obey the frozen/live rule:
// frozen at a glyph's onset (.x(ballX("a")).y(ballY("a")) trails a ball), live as an FX/physics
// param. flipX mirrors x for a selfie view (set via window.loom.feed.flipX).
const _jug = { balls: {}, flipX: false };
const _ballId = (id) => {                                          // 0/1/2 · "a"/"A" · "ball_a" → "ball_a"
  if (id == null) return 'ball_a';
  if (typeof id === 'number') return 'ball_' + String.fromCharCode(97 + (id | 0));
  const s = String(id).toLowerCase();
  return s.startsWith('ball_') ? s : 'ball_' + s;
};
const _ball = (id) => _jug.balls[_ballId(id)];
// normalise the INCOMING id too (the feed sends "ball_A"/"ball_B"…) so it matches the lowercased
// key ballX("b") looks up — otherwise "ball_B" is stored but "ball_b" is read and never found.
const _mkBall = (id) => { const k = _ballId(id); return _jug.balls[k] || (_jug.balls[k] = { x: 0.5, y: 0.5, seen: 0, still: 0, thr: 0, cat: 0, tap: 0, flight: 0, mag: 0, spin: 0, tiltx: 0, tilty: 0 }); };
function _jugInput(m) {                                            // one feed message; switch on type, ignore unknown
  if (!m || typeof m !== 'object') return;
  if (m.type === 'balls' && m.coords) {
    for (const id in _jug.balls) _jug.balls[id].seen = 0;          // clear; only ids present this frame re-flag
    const st = m.stationary || {};
    for (const id in m.coords) { const c = m.coords[id], b = _mkBall(id); b.x = +c[0]; b.y = +c[1]; b.seen = 1; b.still = st[id] ? 1 : 0; }
  } else if (m.type === 'throw') { _mkBall(m.name).thr = 1; }
  else if (m.type === 'catch') { const b = _mkBall(m.name); b.cat = 1; b.flight = +m.flight || 0; }
  else if (m.type === 'tap')   { const b = _mkBall(m.name); b.mag = +m.magnitude || 0; b.tap = Math.min(1, b.mag / 30); }
  else if (m.type === 'imu')   { const b = _mkBall(m.name), g = m.gyro || [0, 0, 0], a = m.accel || [0, 0, 0];
    b.spin = Math.min(1, Math.hypot(g[0], g[1], g[2]) / 35); b.tiltx = (a[0] || 0) / 9.8; b.tilty = (a[1] || 0) / 9.8; }
  // status + unknown types: ignored (additive / forward-compatible)
}
// decay the throw/catch/tap pulses each frame (driven from the tick loop) — a flash to 1 that
// falls to ~0 over ~0.4s, so an event reads as a discrete trigger on controls and FX alike.
function _jugDecay(dt) { const k = Math.exp(-dt * 6); for (const id in _jug.balls) { const b = _jug.balls[id]; b.thr *= k; b.cat *= k; b.tap *= k; } }
const _jval = (id, f, def) => { const b = _ball(id); return b ? b[f] : def; };
function ballX(id)    { return signal(() => { const x = _jval(id, 'x', 0.5); return _jug.flipX ? 1 - x : x; }); }
function ballY(id)    { return signal(() => _jval(id, 'y', 0.5)); }
function ballSeen(id) { return signal(() => _jval(id, 'seen', 0)); }
// 1 while the ball is detected AND in motion (the host's vision flags a settled ball as stationary)
function moving(id)   { return signal(() => { const b = _ball(id); return b && b.seen && !b.still ? 1 : 0; }); }
function thrown(id)   { return signal(() => _jval(id, 'thr', 0)); }
function caught(id)   { return signal(() => _jval(id, 'cat', 0)); }
function tapped(id)   { return signal(() => _jval(id, 'tap', 0)); }
function flight(id)   { return signal(() => _jval(id, 'flight', 0)); }
function gyro(id)     { return signal(() => _jval(id, 'spin', 0)); }

// slider(value, min?, max?, default?): just returns `value` — it's a plain number in the patch.
// The editor renders an inline draggable slider over the call (see editor.js); dragging rewrites
// `value` in the source and re-runs, so the number you see IS the control. min/max (default
// 0..1; 2-arg form is (0, max)) only bound the widget; `default` (4th) is the double-click reset
// target (a stable home that survives dragging; else mid-range). All extra args are widget
// metadata, ignored here. Use anywhere a number works: `.size(slider(0.05, 0, 0.2))`,
// `.feedback(slider(0.9), slider(1.04))`, `{ gravity: slider(1, 0, 2, 1) }` (resets to 1).
function slider(value = 0, min, max, def) { return value; }

// ── value-driven branching (free functions) ──────────────────────────────────────
// pick(sel, list): choose one of `list` by a 0..1 selector (number, mini-notation, signal),
// index = floor(sel·len). The selector gives structure; the chosen item is flattened in, so
// it works for patterns OR plain values: `pick(saw, [shape("dot"), shape("ring")])` swaps as
// saw sweeps; `.size(pick(mouseX, [0.02, 0.06, 0.1]))` picks a size by the pointer (the
// selector is sampled at each onset). For a clean per-cycle swap use a discrete sel like "<0 1>".
function pick(sel, list) {
  const pats = (list || []).map(reify);
  if (!pats.length) return silence;
  return reify(sel).fmap((v) => pats[Math.max(0, Math.min(pats.length - 1, Math.floor((+v) * pats.length)))]).innerJoin();
}
// iff(cond, then, otherwise): if `cond` is truthy (>0.5) use `then`, else `otherwise` (default
// silence). `iff(mouseDown, shape("star*5"), shape("dot*5"))` swaps the source while pressed.
function iff(cond, then_, otherwise = silence) {
  return reify(cond).fmap((v) => (+v > 0.5 ? reify(then_) : reify(otherwise))).innerJoin();
}

// random discrete choice, fresh per onset: choose("#fff", "#000") or choose(0, 3, 7)
function choose(...xs) { return signal((t) => xs[Math.min(xs.length - 1, Math.floor(timeRand(t) * xs.length))]); }
// random integer in 0..n-1
function irand(k) { return signal((t) => Math.floor(timeRand(t) * k)); }

// ── live oscillator (LFO) ──────────────────────────────────────────────────────
// Unlike a signal (which is sampled once at a glyph's onset and frozen) an osc
// keeps running over the glyph's whole lifetime, evaluated each frame against its
// age. osc(rate, shape).range(lo, hi). Shapes: sine saw tri square rand perlin fbm.
// Tempo-synced by default: rate is cycles-per-cycle, so it rides the clock and the
// drawn structure is the same at any tempo. Use .free() for real-time (rate in Hz).
function osc(rate = 1, shape = 'sine') { return makeOsc({ shape, rate, lo: 0, hi: 1, phase: 0 }); }
function makeOsc(o) {
  return {
    __osc: o,
    range(lo, hi) { return makeOsc({ ...o, lo, hi }); },
    rate(r) { return makeOsc({ ...o, rate: r }); },
    phase(p) { return makeOsc({ ...o, phase: p }); },
    spread(n = 1) { return makeOsc({ ...o, spread: n }); }, // per-glyph phase offset = n × onset phase
    drift(r = 0.1) { return makeOsc({ ...o, drift: r }); }, // starting phase advances over global time = r × spawn seconds
    fast(n) { return makeOsc({ ...o, rate: o.rate * n }); },
    slow(n) { return makeOsc({ ...o, rate: o.rate / n }); },
    // tempo: synced by default (rate is cycles-per-cycle, so structure holds across
    // tempo changes). .free() makes it real-time again (rate in Hz, cycles-per-second).
    free(v = true) { return makeOsc({ ...o, free: v }); },
    sync(v = true) { return makeOsc({ ...o, free: !v }); },
    // arithmetic on the osc's output (x may be a number or another osc), applied
    // after range, evaluated live by the renderer.
    add(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['+', x]] }); },
    sub(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['-', x]] }); },
    mul(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['*', x]] }); },
    div(x) { return makeOsc({ ...o, ops: [...(o.ops || []), ['/', x]] }); },
    quantize(n) { return makeOsc({ ...o, ops: [...(o.ops || []), ['q', n]] }); }, // snap to nearest 1/n
    // ease(name): shape the osc's 0..1 waveform through a Penner curve, BEFORE range —
    // same rule as Pattern.ease, so `osc(0.2).ease("inOutSine").range(0,0.4)` matches the
    // signal form. (A dedicated pre-range slot, not an op, which run post-range.)
    ease(name) { return makeOsc({ ...o, ease: name }); },
    // spring(stiffness, damping): chase THIS osc's output with a damped spring (this osc
    // is the target). See spring() below — the per-glyph momentum/overshoot/settle that
    // ease & osc can't do. Great after .quantize (settle between steps).
    spring(stiffness, damping) { return spring(makeOsc(o), stiffness, damping); },
  };
}
const isOsc = (a) => a != null && typeof a === 'object' && a.__osc !== undefined;

// ── env: a per-glyph attack/decay ENVELOPE, as an osc-family signal ───────────────
// env(attack, decay, easeIn?, easeOut?) ramps 0→1 over `attack` seconds, then 1→0 over
// `decay` seconds (REAL time, like a free osc), each segment optionally shaped by a Penner
// curve. Because it's osc-family it ANIMATES over the glyph's life (a plain signal would
// freeze at onset) and routes into ANY param + composes with .range()/.add()/.spring()/etc.
//   .size(env(0.2, 1, "outBack").range(0.05, 0.25))   // size pops in (overshoot) then settles
//   .weight(env(0.3, 0.8).range(0.002, 0.02))         // a line that swells then thins
// For OPACITY prefer `.decay(t, curve)` — that shapes the lifetime fade directly; alpha is
// additionally multiplied by the lifetime envelope, so `.alpha(env(...))` compounds the two.
function env(attack = 0.1, decay = 1, easeIn, easeOut) {
  return makeOsc({ env: { a: attack, d: decay, ei: easeIn, eo: easeOut }, lo: 0, hi: 1 });
}

// ── spring: a STATEFUL value modifier ────────────────────────────────────────────
// Unlike a signal/osc (pure functions of time, frozen or live) a spring has state —
// velocity + current value — that the renderer integrates toward a TARGET every frame,
// per glyph. That's momentum, overshoot and settle: it *reacts* to a changing target
// instead of replaying a fixed curve. The target is normally an osc (often `.quantize`d
// or a stepped `rand`/`square` shape) so the value lurches to each new step and rings
// down. stiffness = pull toward the target, damping = how fast the wobble dies
// (under-damped → overshoot; over-damped → glide). The renderer owns the integration;
// here we just package the target + constants. Use on x/y/radius/angle/size/rotate/etc.
function spring(target, stiffness = 120, damping = 14) {
  return { __spring: { target, k: stiffness, d: damping } };
}
const isSpring = (a) => a != null && typeof a === 'object' && a.__spring !== undefined;

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
// gids are assigned by creation order and RESET each compile (see _resetGroups), so the
// Nth group() in a patch keeps the same id across edits — that's what lets the renderer
// recognise "the same group" and apply edited FX to glyphs already on screen. _groupFx is
// the live id→fx registry for the current compile.
let _gid = 0;
let _echoGen = 0;               // monotonic generation id for echo() layers (NOT reset)
const _groupFx = new Map();
const _echoGroups = [];         // {fam, cap} for echo() groups in the current compile
function _resetGroups() { _gid = 0; _groupFx.clear(); _echoGroups.length = 0; }
class Group {
  constructor(pat) { this._pat = reify(pat); this._gid = ++_gid; this._fx = { chain: [] }; _groupFx.set(this._gid, this._fx); }
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
    // normal groups render under their stable gid (live-FX diffing). echo() groups render
    // each compile's glyphs under a unique frozen generation id, so editing forks a new
    // layer that keeps the old fx and decays out — `_echoFam`/`_echoCap` let main.js cap
    // how many generations linger per group.
    const fx = this._fx;
    const extra = this._echo
      ? { _gid: this._gen, _fx: fx, _echoFam: this._gid, _echoCap: this._echo }
      : { _gid: this._gid, _fx: fx };
    return this._pat.query(s).map((h) => hap(h.whole, h.part, Object.assign({}, h.value, extra)));
  }
}
// variadic like stack(), so group(bg(...), shape(...)) works as expected (not just
// group(stack(...))). one arg passes through unchanged.
function group(...pats) { return new Group(pats.length > 1 ? stack(...pats) : (pats[0] || silence)); }

// echo(group(...), n): accumulate-on-edit. Each re-run forks the group into a new frozen
// generation (its own gid + captured fx) while the previous generations decay out, so
// alternating effects stack into a fading palimpsest. `n` caps how many generations stay
// alive (oldest dropped instantly, see main.js). Without echo, a group updates in place.
function echo(g, n = 4) {
  const grp = (g instanceof Group) ? g : new Group(g);
  grp._echo = Math.max(1, n | 0);
  grp._gen = ++_echoGen;                       // unique this compile (echo() runs once)
  _echoGroups.push({ fam: grp._gid, cap: grp._echo });
  return grp;
}

// ── physics: rigid-body mode (parallel to group) ────────────────────────────────
// physics(pattern, opts) tags its events so the renderer spawns each onset as a rapier2d
// rigid BODY: the sim owns position, while Loom still owns when / where (spawn point) /
// size / colour / lifetime, and per-glyph oscs still drive colour/size. opts —
// { gravity, bounce, drag, vel, spin, windx } — are patternable (string → mini-notation),
// resolved against GLOBAL time each frame like FX params, so gravity can move. pids are
// stable by creation order + reset each compile, so editing opts updates the live world.
// Rapier (rapier2d-compat, WASM) is lazy-loaded by main.js on first use; patches without
// physics() never load it.
let _pid = 0;
const _physReg = new Map();
function _resetPhysics() { _pid = 0; _physReg.clear(); }
class Physics {
  constructor(pat, opts) {
    opts = opts || {};
    for (const k in opts) if (typeof opts[k] === 'string') opts[k] = mini(opts[k]);   // patternable params
    this._pat = reify(pat); this._pid = ++_pid; this._opts = opts; _physReg.set(this._pid, opts);
  }
  query(s) {
    const pid = this._pid;
    return this._pat.query(s).map((h) => hap(h.whole, h.part,
      (h.value && typeof h.value === 'object') ? Object.assign({}, h.value, { _pid: pid }) : h.value));
  }
}
function physics(pat, opts) { return new Physics(pat, opts); }

// ── named layers ($) ──────────────────────────────────────────────────────────
// A patch can be several named, separately-editable layers instead of one giant
// stack(...). Each `$(name?, pattern)` call registers a layer; compile() in main.js
// collects every call in the patch and stacks them (so a bare-expression patch still
// works, and a lone `$(...)` returns its pattern). Names are first-class — labels for
// the future mute/solo + scene mixer — kept unique (collisions auto-suffixed). The
// registry is reset each compile, like _resetGroups.
let _layers = [];
function _resetLayers() { _layers = []; }
function _getLayers() { return _layers; }
function layer(name, pat) {
  if (pat === undefined) { pat = name; name = null; }      // $(pattern) — anonymous
  const p = reify(pat);
  let nm = name != null ? String(name) : `$${_layers.length}`;
  if (_layers.some((l) => l.name === nm)) {                // keep names unique for the mixer
    let k = 2; while (_layers.some((l) => l.name === `${nm}#${k}`)) k++; nm = `${nm}#${k}`;
  }
  // tag every hap with its layer name (like group's _gid) so spawned glyphs know which
  // layer they belong to — that's what lets the renderer mute/solo a layer live.
  const tagged = new Pattern((s) => p.query(s).map((h) =>
    hap(h.whole, h.part, (h.value && typeof h.value === 'object') ? Object.assign({}, h.value, { _layer: nm }) : h.value)));
  _layers.push({ name: nm, pat: tagged });
  return tagged;                                           // a lone $(...) still evaluates to the (tagged) pattern
}

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
  shape, s, n, choose, irand, pick, iff, osc, env, palette, bg, group, echo, spring, physics, slider, _setBgSink,
  $: layer, _resetLayers, _getLayers, _resetPhysics, _physReg,
  sine, cosine, saw, isaw, tri, square, rand, perlin, fbm, brown, gauss, white,
  mouseX, mouseY, mouseDown, _setPointer,
  cc, gate, vel, note, pc, bend, onNote, _midiInput, _midiFrame,
  ballX, ballY, ballSeen, moving, thrown, caught, tapped, flight, gyro, _jug, _jugInput, _jugDecay,
  hasOnset, span, isOsc, isSpring, ease, EASE,
  _groupFx, _resetGroups, _echoGroups, PALETTES,
};
