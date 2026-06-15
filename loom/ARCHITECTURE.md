# Loom — architecture & renderer-migration spec

Loom is a live-coding "pattern language for drawing": you type a Tidal/Strudel-style
expression, it's queried each frame over cyclic time, and every event onset spawns a
glyph. This doc was the handoff for **replacing the Canvas2D renderer with a WebGL one
that supports a patternable shader effects pipeline**. The language stays; only the
draw layer changes.

> **Status: implemented.** The WebGL renderer lives in `gl/renderer.js` (Three.js)
> and is the default; the Canvas2D path remains behind `?gl=0`. All six phases below
> landed — instanced SDF glyphs, real per-glyph perspective, per-group render
> targets, the post-process FX chain (`blur`, `feedback`, `pixelate`, hue/brightness/
> contrast/saturate, `displace`, `kaleido`, `mirror`), and patternable FX params via
> `evalGlobal`. `pattern.js` gained FX verb methods on `Group` (renderer-agnostic —
> they only stash params).

See `REFERENCE.md` for the full user-facing language. This doc is the internals.

## The two halves

- **`pattern.js` — the language. Renderer-agnostic. KEEP IT AS-IS.**
  A `Pattern` is a pure function `query(span) → hap[]`, where a hap is
  `{ whole, part, value }` and `value` is a **control object** like
  `{ shape:"circle", color:"#f00", size:0.06, radius:0.3, ... }`. It implements
  mini-notation, combinators, signals, `osc()`, `palette()`, `bg()`, `group()`,
  `quantize`, etc. It has **zero** knowledge of canvases/pixels. The renderer just
  consumes control objects.

- **`main.js` — the Canvas2D renderer. THIS is what we replace.**
  It runs the clock, queries the pattern, spawns particles, and draws them.

## The spawn → render contract (what the new renderer must implement)

### 1. Clock + query (keep this logic)
- `cps` = cycles/sec; `cycle` advances by `dt*cps` each frame.
- Each frame, `pattern.query(span(prevCycle, cycle))`; for every hap with an **onset**
  in that span (`DSL.hasOnset(h)`), call `spawn(h.value, h.whole.begin)`.
- `bg("…")` sets the clear color via a sink; reset to default each run.

### 2. Control values
A control value is one of: **number**, **string** (already parsed by mini-notation),
**Pattern**, or **osc descriptor** (`{__osc}`), or a **palette** (`{__pal, t}`).
Patterns/strings are sampled at the event's onset → **frozen per glyph**. Oscs stay
**live** (re-evaluated every frame). Full control list + ranges: `REFERENCE.md`.

Layout model: **position = centre + polar offset**.
- centre = `(x, y)` (0..1, default screen centre) — or a **grid** cell (`gridX/gridY`,
  cell index from onset phase).
- polar offset = `radius` (× min(w,h)) at `angle` turns (default angle = onset phase).
- they mix: x/y alone = cartesian; radius/angle alone = ring; both = orbit; grid = grid.
- `pan` (jux) shifts x; `jitter` adds a per-glyph random offset (captured at spawn).

### 3. Per-glyph state (a "particle"), captured at spawn
shape; color (resolved or live); size; rotTurns (Z); rotX/rotY (radians, 3D tilt);
spin (turns/sec, age-driven Z); fill/stroke/vertex (independent draw modes); weight
(stroke/line/vertex-dot size); cap/join; open (arc/line gap, 0..1); alpha; blend;
attack/decay (seconds; decay already folded the master `decay` slider + `/cps`);
`mods` (the subset of size/color/rotate/rotateX/rotateY/open/alpha/weight that are
oscs → re-evaluated live); `gid`/`fx` (group id + effect params); onset `phase`.

### 4. Per-frame loop
1. Clear to `bgColor` (full wipe — **no trails/ghosting**; persistence is per-glyph decay, not a feedback veil).
2. Spawn onsets (above).
3. Optional playhead (cycle indicator).
4. **Cull + envelope**: `age += dt`; drop if `age ≥ attack + decay`; envelope = rise
   over attack then fall over decay → `_env`. If position inputs are live (`posLive`),
   recompute x/y this frame.
5. Optional **trace** mode: polyline through live glyph centres.
6. **Draw**, oldest→newest (newest on top). For each glyph: resolve live `mods` (oscs)
   to effective values; `alpha *= _env`; rotate by `rotTurns*TAU + spin*age`; if
   `rotX||rotY` use **real perspective** (currently faked via vertex projection in 2D —
   in GPU this is a normal MVP matrix), else flat. Draw modes: fill and/or stroke and/or
   vertex-dots. Shapes: dot circle ring arc square box tri pent hex star plus line cross.

### 5. Oscillators (`osc`) — the live signal system
`evalOsc(descriptor, age, onsetPhase)`:
`t = age*rate + phase + spread*onsetPhase`; pick waveform (sine/saw/tri/square/rand/
perlin/fbm) of `t`; map to `[lo,hi]`; apply `ops` (`add/sub/mul/div/quantize`).
**Every parameter** (rate, phase, spread, lo, hi, op operands) may itself be an osc →
cross-modulation (FM/PM/AM). `spread` = per-glyph phase offset = `n × onsetPhase` (so a
ring shows the wave spread around it). `numAt(x, age, gp)` resolves number-or-osc.

### 6. Groups & effects (the part we're rebuilding)
`group(pattern)` tags its events with a group id + an `fx` object. In Canvas2D today:
each group renders to its own offscreen canvas, one effect (`pixelate`) is applied, then
composited. **This is the FX-pipeline seed.**

## Target: WebGL renderer + patternable FX pipeline

Replace the Canvas2D draw layer with:

- **Instanced glyph rendering.** One draw call per shape (or an SDF shader covering all
  shapes); per-instance attributes: position, size, z-rotation, rotX/rotY (or a per-
  instance model matrix), color (rgba), draw-mode flags, weight, open. Target thousands
  of glyphs at 60fps. Perspective (rotateX/Y) becomes a real projection matrix — free.
- **Per-group render targets (FBOs).** Each `group()` renders its glyphs to its own
  texture.
- **Chained post-process passes** on each group's texture, in call order:
  `blur`, `feedback(fade, zoom, rot)` (ping-pong FBO — the trails/tunnel; controllable
  bloom), `pixelate`, `hue/brightness/contrast/saturate`, `displace`, `mirror/kaleido`.
  Then composite groups onto the screen (blend/opacity).
- **Patternable FX params.** FX run per-layer-per-frame (not per-glyph), so their params
  evaluate against **global time**, not glyph age: patterns sampled at the current
  `cycle`, oscs at elapsed seconds. Add `evalGlobal(param, cycle, elapsed)` beside the
  per-glyph `numAt`. Then `group(pat).pixelate(osc(0.2).range(4,24))` pulses, etc.

### Library
- **PixiJS** — best fit for 2D-glyphs + post-FX: sprite/mesh batching, a Filter system
  that *is* a shader-pass pipeline, RenderTexture for feedback/ping-pong.
- **Thin WebGL (regl / twgl)** — leanest, full control of instancing + FBO passes.
- **Three.js** — choose only if 3D depth becomes central (InstancedMesh + EffectComposer).
  More friction for a 2D glyph tool, bigger bundle.

### Hard constraints
- `pattern.js` is imported untouched (`import { DSL }`). All presets in `main.js` and the
  whole `REFERENCE.md` language must keep working.
- The control→instance mapping, per-glyph envelope, live-osc resolution (with onset-phase
  spread + cross-mod), and the centre+polar+grid layout must port exactly.
- It's a static Vite multi-page site (Cloudflare builds `dist/`); keep it dependency-light
  and runs-everywhere (the app is used on phones too).
