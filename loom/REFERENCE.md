# Loom: language reference

Loom is a Tidal/Strudel-style pattern language for drawing. You write an
expression that evaluates to a **pattern**; the renderer queries it each frame
and turns every event onset into a glyph on the canvas. The engine lives in
[`pattern.js`](pattern.js); the renderer + presets in [`main.js`](main.js).

A *pattern* is a pure function from a stretch of cyclic time to a list of
events. Time is measured in **cycles** (the `cps` slider sets cycles/second).
Everything composes: combinators take patterns and return patterns.

In-app: hit **?** in the top-left for a condensed version of this, **⌘/Ctrl+Enter**
to run.

---

## Mini-notation (inside `"…"` strings)

| Syntax | Meaning |
| --- | --- |
| `"a b c d"` | sequence, splits the cycle into equal steps |
| `"a [b c]"` | subdivide a single step |
| `"<a b c>"` | one item per cycle (alternation) |
| `"a*3"` | play a step 3× faster (3 times in its slot) |
| `"a/2"` | play a step over 2 cycles |
| `"a!3"` | replicate a into 3 steps |
| `"a@3 b"` | weighted steps, `a` takes ¾ of the cycle, `b` ¼ |
| `"a(3,8)"` | euclidean: 3 pulses spread over 8 steps |
| `"a(3,8,2)"` | …rotated by 2 steps |
| `"a , b"` | stack in parallel (both at once) |
| `"~"` | rest (silence) |

Tokens are strings unless they parse as numbers. Numeric controls coerce them
(`.size("0.1 0.2")` → numbers); `color`/`shape`/`blend` keep them as strings.

---

## Sources

Sources turn tokens into glyph events. They are the start of every chain.

| Function | Result |
| --- | --- |
| `shape("circle*8")` | a glyph per token; the token is the shape name. Alias: `s(...)` |
| `n("0 1 2 3")` | numbered dots (sets `n`, shape `dot`) |
| `run(8)` | numeric pattern `0 1 2 … 7` in one cycle |
| `pure(x)` | one event per cycle holding `x` |
| `silence` | nothing |

**Shape names:** `dot` `circle` `ring` `square` `box` `tri` `pent` `hex`
`star` `plus` `line` `cross`. (`ring`/`line`/`cross` are always stroked.)

**3D shapes** (raymarched, tumbled by `rotateX`/`rotateY`/`spin`): `cube` `sphere`
`torus` `octa`. Solid only — `fill`/`stroke`/`weight` don't apply; drive `size` +
the rotations, e.g. `shape("cube").rotateX(saw.range(0,1).slow(8))`. **Flat/unlit
by default**; `.shade(n)` (`0..1`) mixes in matte faceted lighting (no gloss).

**Imported meshes** (real FBX geometry from `models/`, instanced + depth-tested,
flat-shaded): `bong`. Same controls as the 3D shapes (`size`, the rotations,
`color`) — loads async, so it appears a moment after first run.

---

## Controls

Chain these onto a source to set per-glyph attributes. Structure comes from the
left, the value is sampled from the right, so the argument can be a number, a
mini-notation string, **or a pattern/signal**:

```js
shape("dot*8").size("0.04 0.08").color(sine.range(0, 1))
```

### Visual

| Control | Range / units | Notes |
| --- | --- | --- |
| `.color(c)` | `"#rrggbb"`, name (`red` `blue` …), `0..1` hue, or a `palette` | default: rainbow by cycle phase |
| `.size(n)` | `0..1` (fraction of `min(w,h)`) | glyph radius. default `0.06` |
| `.x(n)` `.y(n)` | `0..1` of width / height | the **centre point** (default = screen centre) |
| `.radius(n)` | `0..0.5` typical | **polar offset** from the centre. Defaults to the mandala ring (0.34) only when no x/y/radius is set, else 0 |
| `.angle(t)` | turns (`1` = full circle) | orbital position; default = onset phase. `.angle(saw.range(0,5))` winds a 5-turn spiral; `radius = sine(phase·k)` makes rose petals |

Position is **centre (x/y) + polar offset (radius/angle)**, so they mix freely:
`x/y` alone → cartesian; `radius/angle` alone → ring; **both → orbit around (x,y)**.

`.grid(cols, rows)` is a third layout, it places events into a `cols×rows` grid
by onset (the centre point), and `radius/angle` still offset from each cell.

## Groups & effects (shader FX)

`group(pattern)` renders a layer to its own buffer (a GPU render target) so a
chain of post-process **effects** can be applied to the whole layer before it
composites back. It behaves like a pattern, so it stacks:

```js
stack(
  shape("ring*4").radius(0.3),                 // crisp, on the main canvas
  group(shape("dot*64").angle(saw.range(0,4))  // a layer…
    .radius(saw.range(0.04,0.45)))
    .pixelate(14)                              // …rendered chunky
)
```

Effects **chain in call order**, each is a shader pass over the layer's texture:

| Effect | Params | Does |
| --- | --- | --- |
| `.pixelate(block)` | block size (px) | mosaic / blocky downscale |
| `.blur(radius)` | radius (px) | gaussian blur → soft glow |
| `.feedback(fade, zoom, rot)` | fade `0..1`, zoom `~1`, rot turns | trails / tunnel, composites over a warped copy of the previous frame |
| `.trails(fade)` | fade `0..1` | feedback with no zoom / rotation |
| `.hue(t)` | turns | rotate hue |
| `.brightness(b)` `.contrast(c)` `.saturate(s)` | `1` = identity (`saturate(0)` = grey) | colour grade |
| `.negative(amount)` `.invert(amount)` | `0..1` (`0` = off) | invert colours |
| `.displace(amount, scale)` | amount (uv), scale (freq) | warp / melt the layer |
| `.kaleido(slices)` | n | fold into `n` mirrored wedges |
| `.mirror()` | (none) | left/right symmetry |
| `.tile(x, y)` | repeats (`y` defaults to `x`) | repeat the layer in an `x × y` grid |
| `.dots(cell)` `.halftone(cell)` | cell size (px) | halftone screen: dots grow with brightness |
| `.rgbshift(amount, angle)` `.rgb(…)` | uv offset, turns | split the R / B channels (chromatic aberration) |
| `.posterize(levels)` | n (≥2) | quantize colours to `n` levels |
| `.dither(levels)` | n (≥2) | ordered (Bayer) dither + quantize — low-bit look |
| `.scanlines(amount, period)` | `0..1`, px | periodic horizontal darkening (CRT) |
| `.slice(count, amount, "h"\|"v"\|"grid")` | bands, uv offset, mode | cut into bands and offset each (pattern `amount` to judder) |
| `.lens(amount)` | + barrel / − pincushion | radial lens distortion about the centre |
| `.opacity(alpha)` `.alpha(a)` | `0..1` (`1` = off) | fade the whole group as a unit (modulate to pulse) |
| `.scale(s)` | zoom factor (`1` = off) | scale the layer about centre (`s<1` shrinks, bg shows around) |
| `.move(x, y)` | uv offset | translate the whole layer |
| `.turn(t)` | turns | rotate the whole layer about centre |
| `.aspect(ratio)` | `w/h` or `"16:9"` | crop to a centred aspect ratio (letterbox; bg shows in the bars) |

```js
group(shape("tri*6").radius(0.24).rotate(saw.range(0,1))
  .color(palette("candy").at(saw.range(0,1))))
  .kaleido(8).feedback(0.86, 1.0, 0.04)        // chained: kaleidoscope, then trails
```

**Patternable FX params.** Effects run **per-layer-per-frame**, not per glyph, so
their params evaluate against **global time** (not a glyph's age): a number is
constant, a **pattern** is sampled at the current cycle, and an **`osc`** runs at
elapsed seconds. So the effect itself can move:

```js
group(shape("dot*64").angle(saw.range(0,3)).radius(saw.range(0.04,0.44))
  .color(palette("neon").at(saw.range(0,1))))
  .pixelate(osc(0.2).range(3, 26))             // the block size breathes
```

Every effect has an **off value** for its main param, so you can pattern it on
and off (the pass is skipped, not run as identity): `pixelate(≤1)`, `blur(0)`,
`displace(0)`, `kaleido(<2)`, `mirror(0)`, `tile(1)`, `dots(≤2)`, `rgbshift(0)`,
`posterize(<2)`, `dither(<2)`, `scanlines(0)`, `slice(amount 0)`, `lens(0)`, `opacity(1)`,
`scale(1)`, `move(0,0)`, `turn(0)`, `aspect(≤0)`, `feedback` with fade `0`, and `grade`
at its identity (`hue 0`, the rest `1`). So `kaleido("<6 0>")` folds every other
cycle, `mirror("1 0")` flips on and off, `blur(saw.range(0, 12))` swells in.

> Note: FX live on the group, evaluated per-frame, so per-event combinators like
> `.sometimes` don't apply to them, pattern the FX param instead (as above).

> The shader FX run on the WebGL renderer (the default). The legacy Canvas2D
> renderer (append `?gl=0` to the URL) applies only `pixelate`.
| `.rotate(t)` | turns (`1` = 360°) | static Z rotation |
| `.rotateX(t)` `.rotateY(t)` | turns | 3D tilt (foreshortening) around the horizontal / vertical axis |
| `.spin(t)` | turns/second | continuous Z rotation |
| `.pan(n)` | `0..1` (0=left · .5=centre · 1=right) | horizontal x-shift of the centre (the stereo-pan analog), mostly a `jux` primitive, not very useful alone |
| `.jitter(n)` | `0..0.1` typical | random positional scatter |
| `.alpha(n)` / `.opacity(n)` | `0..1` | peak opacity (per glyph) |

### Style

`fill` and `stroke` are **independent, patternable** booleans, a glyph can be
filled, outlined, or both. All four are patterns, so `.fill("1 0")`,
`.weight(sine.range(.002,.02))`, `.cap("<round butt>")` all work.

| Control | Notes |
| --- | --- |
| `.fill(on)` | fill on/off (default on). `.fill(0)` disables fill |
| `.stroke(on)` | outline on/off (default off). `.stroke()` = on |
| `.vertex(on)` | draw a dot at each of the shape's vertices |
| `.weight(w)` | stroke / line / vertex-dot size, absolute (`0..0.1` of `min(w,h)`) |
| `.outline(f)` | stroke size relative to the shape's radius (scales with `size`); overrides `weight` |
| `.shade(n)` | `0..1` — 3D-ify: 2D shapes puff into glossy plastic toys (`ring` → tube); 3D shapes get matte faceted lighting |
| `.cap(s)` | line ends: `"round"` (default) `"butt"` `"square"` |
| `.join(s)` | corners: `"miter"` (default, sharp) `"round"` `"bevel"` |

> Three independent draw modes: fill, stroke, vertex. Outline-only: `.fill(0).stroke()`.
> Vertices only: `.fill(0).vertex()`. They compose, `.stroke().vertex()` outlines *and* dots.
> `ring` / `arc` / `line` / `cross` are outlines (no fill); they stroke by default.

### Envelope (per glyph, in seconds)

| Control | Notes |
| --- | --- |
| `.attack(s)` | fade-in time. default `0.06` |
| `.decay(s)` | fade-out time / lifetime. default ≈ one cycle. alias: `.life(s)` |

The **decay** slider in the transport is a master multiplier baked into each
glyph *at spawn*, moving it only affects glyphs drawn afterward, never ones
already on screen. The **clock** button toggles the sweeping cycle playhead, and
**trace** threads a line through the live glyph points (in spawn order) so the
rhythm reads as a connected path / constellation.

Glyphs are drawn oldest-first, so the most recently spawned always sits on top.

### Compositing

| Control | Notes |
| --- | --- |
| `.blend(mode)` | `"source-over"` (default), `"screen"`, `"lighter"`, `"multiply"`, … |

---

## Transforms

Combinators that reshape a pattern. All return a pattern, so they chain.

| Transform | Effect |
| --- | --- |
| `.fast(n)` `.slow(n)` | compress / stretch in time (`n` may be a pattern) |
| `.rev()` | reverse each cycle |
| `.every(n, p => …)` | apply a function every `n`th cycle |
| `.iter(n)` | rotate the pattern by `1/n` each cycle |
| `.palindrome()` | alternate forward / reversed cycles |
| `.superimpose(p => …)` | overlay a transformed copy in place (parallel voices) |
| `.jux(p => …)` | superimpose, but pan the two copies apart (left / right) |
| `.off(t, p => …)` | superimpose, but shift the copy later by `t` cycles (a modifiable echo) |
| `.degrade()` | drop ~50% of events (seeded by time) |
| `.degradeBy(p)` | drop a fraction `p` of events |
| `.sometimes(f)` `.often(f)` `.rarely(f)` | apply `f` to a random share of events |
| `.early(t)` `.late(t)` | shift earlier / later by `t` cycles |

### Combining patterns (free functions)

| Function | Effect |
| --- | --- |
| `stack(a, b, …)` | layer patterns simultaneously |
| `cat(a, b, …)` | one pattern per cycle (slow concatenation) |
| `seq(a, b, …)` / `fastcat(a, b, …)` | pack patterns into one cycle |
| `fast(n, p)` `slow(n, p)` `rev(p)` | function forms of the methods |

---

## Signals & maths

Continuous patterns in `0..1`, sampled at each event's onset. Use them anywhere
a control takes a value.

`sine` `cosine` `saw` `isaw` `tri` `square` `rand` `perlin`

| Method | Effect |
| --- | --- |
| `.range(lo, hi)` | remap a `0..1` signal into `[lo, hi]`; **`lo`/`hi` may each be a number, pattern, or osc** |
| `.add(x)` `.sub(x)` `.mul(x)` `.div(x)` | arithmetic; **`x` may be a number or a pattern** |

### Live oscillators

A signal is sampled **once at a glyph's onset and frozen**. An **`osc`** keeps
running over the glyph's whole lifetime, the renderer re-evaluates it every
frame against the glyph's age, like `spin` does for rotation. So a dot can keep
moving, its colour can cycle, its size can breathe, *after* it's drawn.

```js
osc(rate, "sine").range(lo, hi)   // rate in cycles/sec; default range 0..1
```

Shapes: `sine` `saw` `tri` `square` `rand` `perlin` `fbm` (perlin/fbm are the
smooth, organic, livelier ones). Chainable: `.range(lo, hi)` `.rate(r)`
`.phase(p)` `.spread(n)` `.fast(n)` `.slow(n)`. The `lo`/`hi` of an osc's `.range`
may themselves be oscs, so the range can move: `osc(2).range(0, osc(0.1).range(0.4, 1))`.

By default glyphs only differ by **age** (birth time), so simultaneous onsets move
in lockstep. **`.spread(n)`** adds a per-glyph phase offset of `n × the glyph's
onset phase`, so the wave spreads *around* a ring/grid (a gradient) and still
animates: `palette("rainbow").at(osc(0.08).spread(1).range(0,1))` = a rotating
colour wheel around the ring.

**Cross-modulation:** every osc parameter (`rate`, `phase`, `spread`, and the
`lo`/`hi` of `range`) may itself be an osc, so you get LFOs modulating LFOs:
`osc(2).rate(osc(0.1).range(1,4))` (FM, warps the tempo), `.phase(osc(...))` (PM,
smooth wobble), `.range(osc, osc)` (AM, the band breathes). Oscs also take
arithmetic, `.add/.sub/.mul/.div(x)`, where `x` is a number or another osc:
`osc(1).range(0,1).mul(osc(0.2).range(0.5,1))` rings one osc's output with another.

Works on any continuous control: `x` `y` `radius` `pan` `size` `weight` `open`
`alpha` `rotate` `rotateX` `rotateY` `color`. Each glyph runs the osc from its
own birth, so glyphs born at different times stay out of phase.

```js
shape("circle*8")
  .x(osc(0.15, "perlin").range(0.15, 0.85))   // wander horizontally
  .y(osc(0.19, "perlin").range(0.15, 0.85))   // …and vertically
  .color(osc(0.25).range(0, 1))               // cycle the hue
  .size(osc(0.6, "tri").range(0.015, 0.06))   // breathe
  .decay(5)
```

Because arithmetic accepts patterns, you can modulate one signal with another:

```js
shape("dot*16")
  .x( saw.add(sine.range(0, 0.1)) )   // a ramp wobbled by a sine
  .color(rand)
```

> Arithmetic operates on **numeric** patterns (signals, `n(...)`, mini numbers).
> Compose them *before* handing them to a control, as above, not after, where
> the values are control objects.

---

## Palettes & background

Define a colour ramp and interpolate through it:

```js
palette("#0b3d91", "#1ec8c8", "#7fffd4", "#b58cff").at(x)
```

`.at(x)` maps a `0..1` position `x` to an interpolated colour, where `x` may be:

- a **number**, a fixed colour at that position,
- a **pattern/signal** (`saw`, `"0 .5 1"`), sampled at each glyph's onset (frozen),
- an **`osc`**, the colour keeps interpolating over the glyph's lifetime (live).

`x` wraps, so a `saw` sweeps the ramp and repeats. Stops may be hex, names, or
hue numbers. Interpolation is in **OKLCH** (perceptually uniform, clean, vivid
transitions, no muddy grey midpoints). Used in `.color(…)`.

Built-in ramps (use by name, `palette("sunset")`): `sunset` `ember` `ice`
`neon` `forest` `candy` `mono` `rainbow` `aurora`.

**Background:** `bg("#101820")` sets the canvas background for the patch. It
returns `silence`, so stack it in: `stack(bg("#101820"), shape("dot*8")…)`.
Remove it and the background reverts to the default on the next run.

`bg` is **patternable**, its argument is resolved every frame, so it can move:
a mini-notation string alternates (`bg("<#001018 #100818>")`), an `osc` drifts
live (`bg(osc(0.05).range(0, 1))`), and a palette interpolates
(`bg(palette("ice").at(osc(0.03).range(0,1)))`).

## Layout model

- An event's **onset phase** within the cycle places it on a ring around centre
  (angle = phase, starting at top). So `"a b c d"` lands at 12/3/6/9 o'clock,
  rhythm becomes geometry.
- `.radius(n)` moves it in/out along that ring; `.x()/.y()` switch to absolute
  cartesian placement and ignore the ring.
- Glyphs are redrawn fresh every frame and fade via their envelope, nothing is
  baked into the canvas, so there is no smear/ghosting.

---

## Examples

```js
// euclidean stars + a pulsing stroked ring
stack(
  shape("star(3,8)").color("#ffd166").size(0.08).stroke(0.006),
  shape("ring(5,8)").color("#56b6ff").radius(sine.range(0.18, 0.42))
).fast(2)

// long-lived spiral, ramp wobbled by a sine
shape("dot*16")
  .radius(saw.range(0.05, 0.45).add(sine.range(0, 0.06)))
  .color(saw.range(0, 1))
  .size(0.04)
  .attack(0.02).decay(2)

// mirrored, alternating polygons
shape("tri square hex <plus star>")
  .size(0.07)
  .jux(p => p.rev())
  .color("<#ff5d73 #6df0c2>")
```

---

## Testing the engine directly

`pattern.js` exports `DSL`. You can query patterns without the renderer:

```js
import { DSL } from './pattern.js';
const { shape, sine, span, hasOnset } = DSL;

// list the onsets in cycle 0
shape("dot(3,8)").query(span(0, 1)).filter(hasOnset)
  .map(h => [h.whole.begin, h.value]);
```

`hasOnset(hap)` is true when the event starts within the queried span (i.e. it's
a fresh trigger, not a continuation). `span(begin, end)` builds a time window.

In the running app, `window.loom` exposes `{ tick(dt), step(n, dt), particles,
setDecay(v) }` for poking at the renderer from the console while you test.
