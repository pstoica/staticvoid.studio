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
`torus` `octa`. Drive `size` + the rotations, e.g.
`shape("cube").rotateX(saw.range(0,1).slow(8))`. **Matte-shaded by default** so they
read as 3D (like a p5 `sphere`); `.shade(0)` flattens to an unlit silhouette,
`.shade(1)` deepens the shading (no gloss). **`.fill(0).stroke().weight(w)`** draws
them as a wireframe — edges for `cube`/`octa`, the grazing silhouette for `sphere`/`torus`.

**Imported meshes** (real FBX geometry from `models/`, instanced + depth-tested):
`bong` · `knot` · `amongus` (alias `sus`) · `balloons` (alias `balloon`) · `chain`.
Same controls as the 3D shapes — `size`, the rotations, `color`, and `.shade()`
(matte by default, `.shade(0)` = flat/unlit). Flat-tinted by their `.color()` —
the models' own colours aren't used yet. Each is **lazy-loaded on first use**, so a
mesh appears a moment after the patch first references it.

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
| `.rgbshift(amount, angle)` `.rgb(…)` | uv offset, turns | prism split — keeps the shape's colour, adds pure red/blue edge ghosts |
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

**Editing FX is live.** Changing or dropping an effect line and re-running applies to
the glyphs already on screen — no wipe, no waiting for them to fade. (Glyph *content*
still cross-fades: old shapes finish their decay as the new ones take over.)

**`echo(group(...), n)`** opts a group into *accumulating* edits instead: each re-run
forks a new frozen generation (keeping that edit's FX) while the previous generations
decay out, so alternating effects stack into a fading palimpsest. `n` caps how many
generations linger (oldest dropped instantly). `echo(group(...).dots(8), 3)` — flip
`dots`↔`pixelate`↔`scanlines` across re-runs and watch them layer.

> The shader FX run on the WebGL renderer (the default). The legacy Canvas2D
> renderer (append `?gl=0` to the URL) applies only `pixelate`.

## Physics (`physics`)

`physics(pattern, opts)` spawns each event onset as a **2D rigid body** in a shared
world (parallel to `group()`). Loom stays the **spawner/conductor** — *when* (onset),
*where* (the spawn point from `x/y/radius/angle`), *size*, *colour*, *lifetime* (`decay`),
and per-glyph oscs still drive colour/size — but the **sim owns position**: bodies fall
under gravity, **bounce off the canvas edges, and collide with each other** (the inter-body
dynamics `spring`/`osc` can't do). A body lives as long as its glyph, then it's removed.

```js
stack(
  bg("#06060f"),
  physics(
    shape("circle hex tri").fast(2)
      .x(rand.range(0.15, 0.85)).y(0.08)        // rain in from the top, random column
      .size(rand.range(0.03, 0.07)).color(palette("candy").at(rand)).decay(7),
    { gravity: 1, bounce: 0.66, drag: 0.03, vel: 0.12, spin: 0.4 }
  )
)
```

| opt | does |
| --- | --- |
| `gravity` | downward pull (`1` ≈ a brisk fall; `0` = float; negative = rise) |
| `windx` | sideways pull (a breeze); `+` right, `−` left |
| `bounce` | restitution `0..1` (wall + body bounciness) |
| `drag` | linear/angular damping (air resistance); higher = floatier |
| `vel` | initial speed of each body (random direction; `1` ≈ a full-screen/sec burst) |
| `spin` | initial random angular velocity (tumble) |

**Force-fields** push the bodies each frame (on top of gravity), for emergent / organic
motion the kinematic primitives can't do — set `gravity: 0` to let them take over:

| opt | does |
| --- | --- |
| `attract` | pull toward a point (`ax`, `ay`, default centre). `+` attracts, `−` repels |
| `swirl` | tangential force around that point → bodies orbit it (a vortex) |
| `ax` `ay` | the attract/swirl centre, `0..1` of width/height (patternable → a moving attractor) |
| `turbulence` | a curl-noise **flow field** — bodies drift along swirling streamlines |
| `turbScale` | turbulence spatial frequency (higher = tighter eddies) |

Every opt is **patternable** — a number, a mini-notation string, or an `osc`, resolved
against **global time** each frame like FX params — so the whole field can move:
`{ gravity: "<1 -1>" }` flips gravity each cycle, `{ windx: osc(0.1).range(-1, 1) }` sways,
`{ attract: 0.5, ax: osc(0.05).range(0.2, 0.8) }` makes the swarm chase a drifting point.

> The collider matches the drawn shape: a **tight convex polygon** for `tri` `pent` `hex`
> `star` `plus`, a box for `square`/`box`, a circle for round / outline / 3D shapes — so
> polygons wedge and pack flat-edge-to-edge instead of rolling like discs. The physics engine
> (`rapier2d`, WASM) is **lazy-loaded on first use**: patches without `physics()` never
> download it, so the base app stays light on phones. (Bodies appear a moment after a patch
> first uses `physics()`, while it loads.)
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
| `.attack(s, curve)` | shape the fade-**in** with an easing curve, e.g. `.attack(0.3, "outBack")` |
| `.decay(s, curve)` | shape the fade-**out**, e.g. `.decay(2, "inOutSine")` (curve names: see *Easing* above) |

The optional second arg shapes that envelope segment with an easing curve instead of a
straight line. The envelope drives per-glyph **alpha** (`0..1`), so overshooting curves
(`outBack`/`elastic`) clamp at full rather than blowing out — they change the *timing*
feel of the fade, not its brightness. *(A future option may route the overshoot into a
size pop for a true bounce-in.)*

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

### Branching (value-driven)

`<a b>`, `|`, `every`, and `sometimes` branch on **time / chance**. These branch on a
**value or signal** — handy with the live pointer:

| Helper | Effect |
| --- | --- |
| `pick(sel, [a, b, …])` | choose by a `0..1` selector (number / pattern / signal), index = `floor(sel·n)`. The chosen item is flattened in, so it works for patterns *or* values: `.size(pick(mouseX, [0.02, 0.06, 0.1]))` picks a size by the pointer; `pick("<0 1>", [shape("dot"), shape("ring")])` swaps per cycle |
| `iff(cond, then, else?)` | if `cond > 0.5` use `then`, else `else` (default `silence`): `iff(mouseDown, shape("star*5"), shape("dot*5"))` swaps the source while pressed |
| `.when(cond, f)` | apply `f` to the events where `cond` is truthy (`>0.5`) at their onset — a signal-driven `sometimes`: `.when("<1 0>", p => p.fast(2))`, `.when(mouseDown, p => p.size(0.12))` |
| `.gate(cond)` | keep only events where `cond` is truthy (`>0.5`) at onset; drop the rest — the fix for a **stale external input**: gate by its "is it live?" signal so it stops drawing when there's no fresh data. `.gate(ballSeen("a"))` (ball in frame), `.gate(mouseDown)` (while pressed), `.gate(gate())` (a MIDI note held) |

The selector / condition is **sampled at each event's onset** (frozen per glyph), like any
control. For a clean per-cycle swap use a discrete selector (`"<0 1>"`, `"1 0"`).

---

## Named layers (`$`)

Instead of cramming everything into one `stack(...)`, split a patch into **named,
separately-editable layers**. Each `$(name, pattern)` line is its own voice; they're
collected and stacked automatically (Strudel's `$:` idea):

```js
$("sky",    bg("#06060f"))
$("ring",   shape("ring*4").radius(0.32).color("#56b6ff").weight(0.006))
$("orbits", shape("dot*16").angle(saw.range(0,2)).radius(saw.range(0.06,0.46))
              .color(palette("neon").at(saw.range(0,1))).size(0.02).decay(2))
```

- The **name is optional** — `$(pattern)` is an anonymous layer (auto-named `$0`, `$1`…).
- Names are kept **unique** (a collision is suffixed `#2`), so each layer has a stable
  handle. A row of **layer chips** appears under the editor: **click a chip's name to
  mute** it, **click its dot to solo** (isolate). Both toggle *live* — glyphs already on
  screen hide/show instantly, no re-run — the basis for the scene mixer. (Also on the
  console: `loom.mute("name")`, `loom.solo("name")`, `loom.muted`.)
- A **bare-expression** patch (a single `stack(...)` or chain, no `$`) still works exactly
  as before — `$` is purely opt-in.
- `$` lines are **top-level layer declarations**; don't nest `$` inside another combinator.
  A lone `$(...)` does return its pattern, but if a patch uses `$` at all, the patch *is*
  the stack of its `$` layers.

Any layer can hold a `group(...)` with its own FX chain, so layers and shader FX compose.
The running patch's layer names are exposed on `window.loom.layers`.

## Sliders (`slider`)

`slider(value, min?, max?)` is just a **number** in the patch — but the editor renders a
**draggable slider inline** over the call, so you can retune it by feel. **Drag or scroll**
it (the value stays a fixed width so it doesn't jitter), or **double-click to reset** — to the
**4th arg** if given (`slider(0.5, 0, 1, 0.3)` → home is `0.3`), else mid-range. It rewrites the
number in the source and re-runs live, so the number you see *is* the control (and the 1st arg
is what's shared in the URL). Each slider gets a **distinct colour** to tell several apart.

```js
shape("circle*8")
  .radius(slider(0.3, 0, 0.45))     // drag the inline slider 0 → 0.45
  .size(slider(0.05, 0.01, 0.12))
  .spin(slider(0.1, -1, 1))
```

Use it anywhere a number works — controls, FX params (`.feedback(slider(0.9), slider(1.04))`),
physics opts (`{ gravity: slider(1, -2, 2) }`). Forms: `slider(v)` → range `0..1`,
`slider(v, max)` → `0..max`, `slider(v, min, max)` → `min..max`. Because the value lives in
the source, **the share URL captures wherever you dragged it**.

---

## Signals & maths

Continuous patterns in `0..1`, sampled at each event's onset. Use them anywhere
a control takes a value.

`sine` `cosine` `saw` `isaw` `tri` `square` `rand` `perlin`

### Pointer (`mouseX` / `mouseY` / `mouseDown`)

The live pointer (mouse **or touch**) as signals: `mouseX` / `mouseY` are its position
(`0..1` of the canvas), `mouseDown` is `1` while pressed. (The editor shows a small **live
readout badge** next to each — tinted **dark → light** with the value — so you can see it move.) Being signals, they follow Loom's
frozen-vs-live rule, which gives two behaviours from one name:

- On a **per-glyph control** they're sampled at each glyph's **onset and frozen**, so a
  stream of glyphs leaves a **trail where the pointer was** as each spawned:
  `shape("dot*8").x(mouseX).y(mouseY)` draws along the pointer's path. Use them for colour,
  size, anything: `.color(mouseX)`, `.size(mouseY.range(0.02, 0.1))`.
- As an **FX or physics param** they're **re-read every frame**, so they track the cursor
  live: `group(...).blur(mouseX.range(0, 14))`, or a cursor-driven attractor
  `physics(pat, { gravity: 0, attract: 1, ax: mouseX, ay: mouseY })` — the swarm follows
  your pointer. (Drag on a phone.)

`.sample(n)` gives a **stepped** pointer — sample-and-held `n` times per cycle (e.g.
`mouseX.sample(8)`) — for a quantized-in-time feel. (`segment` won't: it samples pattern-time,
which the pointer ignores; `.quantize(n)` snaps the *value* instead.)

`mouseDown` fires on any press, so `group(pat).feedback(mouseDown.range(0, 0.92)).kaleido(mouseDown.range(0, 8))`
switches the chain on while pressed (see the `press` preset). To trigger **without selecting
code**, flip on **Perform mode** (the *perform* button by the clock, or **⌘/Ctrl+Shift+E**): it
ghosts the code and makes the editor click-through, so the whole screen is a clean trigger
surface — but the **sliders stay live**, subdued until you reach for them (they brighten on
hover), so they're your hands-on controls. Escape or toggle again to edit. ⌘/Ctrl+. still fully
hides all chrome.

### MIDI (`cc` / `gate` / `vel` / `note` / `bend`)

Live MIDI input as signals (Web MIDI — Chrome/Edge; Loom hooks every input it sees, plug-and-play). Like the pointer, they're sampled-and-frozen on a per-glyph control and re-read live on an FX/physics param.

| signal | is | range |
| --- | --- | --- |
| `cc(num, ch?)` | control-change `num` | `0..1` (the `0..127` value ÷127) |
| `gate(ch?)` | `1` while any note is held, else `0` | `0` / `1` |
| `vel(ch?)` | velocity of the last note pressed | `0..1` |
| `note(ch?)` | pitch of the last note pressed | `0..1` (the note number ÷127) |
| `pc(ch?)` | **pitch class** — the note within its octave (`note % 12`) | `0..1`, same value per note-name across octaves |
| `bend(ch?)` | pitch-bend wheel | `-1..1` (centred at `0`) |

`pc` gives octave-independent colour: `palette("rainbow").at(pc(1))` paints every C the same hue, every G another. **Live colour from a note:** an `osc`'s `.range()` bounds may be signals, captured (frozen) at the glyph's onset while the waveform stays live — so `palette("rainbow").at(osc(0.5).range(pc(1), pc(1).add(0.08)))` shimmers live *around* the note's pitch hue. (Putting a signal *directly* in `.color()` freezes it; the osc is what keeps it moving.)

`ch` is the MIDI channel **1–16**; omit it (or pass `0`) for **omni** — any channel. So one
controller's knobs map straight onto a patch — `shape("dot*8").x(cc(16)).y(cc(17)).color(cc(18))` —
and a keyboard drives note-shaped visuals: `physics(shape("star*3").size(vel().range(0.02, 0.12)), { gravity: gate().range(0, 2) })`,
where holding a key lets the swarm fall.

> The **juggling-balls** plan: each ball is its **own channel** sending CCs for its x/y, so
> `cc(7, 1)` / `cc(7, 2)` / … read ball 1, 2, … independently.

`bend` is bipolar (`-1` ← centre `0` → `+1`), so it pairs with `.range(-w, w)` for a symmetric
push. Per-channel CC reads stay independent; an omni `cc(num)` mirrors whichever channel last
moved that controller.

**`onNote(ch, shape)`** is an **event source** — it emits exactly *one* glyph per MIDI note-on,
where `cc`/`gate`/`note`/`vel` are *signals* sampled at clock slots (a held note read through
`gate` spawns a whole stream, not one stamp). Style each stamp by chaining the signals, which are
captured at the glyph's onset (= the moment the note arrived): `onNote(1, "circle").y(note(1)
.range(0.9, 0.1)).size(vel(1).range(0.02, 0.12)).color(palette("rainbow").at(note(1)))`. `ch` is
1–16 (0 = any); a chord spawns one glyph per note. This is the accurate way to draw "one mark per
note" from a live sequence.

### Juggling feed (`ballX` / `ballY` / `thrown` / `caught` / `tapped` / …)

Live **ball-tracking** input as signals. A separate local app tracks juggling balls (webcam
position + on-ball IMU) and broadcasts plain JSON over a WebSocket; Loom consumes it read-only.
This is the **spatial** layer — *where the ball is* — distinct from the **musical** layer (mapped
notes/CC), which arrives over **MIDI** (above). Same signal rules as the pointer: frozen at a
glyph's onset (a trail), live as an FX/physics param.

| signal | is | range |
| --- | --- | --- |
| `ballX(id)` `ballY(id)` | a ball's position in the camera frame | `0..1` (origin top-left, like `mouseX`) |
| `ballSeen(id)` | `1` while the ball is detected this frame | `0` / `1` |
| `moving(id)` | `1` while the ball is detected **and** in motion (the host flags a settled ball as stationary) — gate static-feed noise: `.gate(moving("a"))` | `0` / `1` |
| `thrown(id)` `caught(id)` `tapped(id)` | a throw / catch / tap, as a **decaying pulse** (flashes to 1, falls to 0 over ~0.4 s) | `0..1` |
| `flight(id)` | last catch's airtime, **held** until the next catch | seconds |
| `gyro(id)` | on-ball spin (IMU), if streaming | `0..1` |

`id` is the ball — `"a"`, `"b"`, `"c"` (also `0` / `1` / `2`, or the full `"ball_a"`); it's the
**join key**, the same across position and events, so each ball is its own independent input.
`tapped` peaks with the **impact strength**; the others peak at `1`. A ball that leaves frame
holds its last position (`ballSeen` goes `0`).

```
// each ball trails its own colour; a catch flares it bright
stack(
  shape("dot*4").x(ballX("a")).y(ballY("a")).color("#ff5d73").size(caught("a").range(0.03, 0.22)),
  shape("dot*4").x(ballX("b")).y(ballY("b")).color("#5dd3ff").size(caught("b").range(0.03, 0.22)),
)
// throw → a burst of stars while airborne; spin drives the hue
physics(shape("star*5").color(gyro("a")), { gravity: thrown("a").range(0, 3) })
```

**Off by default** (Loom is also a public web app — it won't dial `ws://localhost` from every
visitor's browser). The **feed button** in the toolbar (antenna icon) opens a config card:
**connect** on/off + a live status dot, the **host** (`host:port`), **flip X** (selfie mirror),
**camera overlay** + opacity, and a live readout of which balls are in view. Everything persists.
You can also enable it without the UI: add **`?feed`** to the URL (default host `localhost:8080`),
or **`?feed=host:port`**, or `window.loom.feed.enabled = true`.

The **camera overlay** streams the host's MJPEG (`http://host:8080/camera.mjpg`) *behind* the
canvas — the visuals composite straight over the live camera, pixel-aligned with the ball coords
(so a dot at `ballX/ballY` lands on the real ball). `window.loom.jug(msg)` injects a feed message
for testing without the host.

| Method | Effect |
| --- | --- |
| `.range(lo, hi)` | remap a `0..1` signal into `[lo, hi]`; **`lo`/`hi` may each be a number, pattern, or osc** |
| `.add(x)` `.sub(x)` `.mul(x)` `.div(x)` | arithmetic; **`x` may be a number or a pattern** |
| `.quantize(n)` | snap the **value** to `n` steps (`Math.round(v*n)/n`). Discrete bands, but a continuous signal still crosses them on its own (uneven) timing |
| `.segment(n)` (alias `.seg`) | snap the **time**: resample `n` times per cycle on an even grid and hold each value — Tidal's `segment`/`discretise`. `quantize` steps the value, `segment` steps the time |
| `.sample(n)` | **sample-and-hold** a *live* signal `n` times per cycle: capture the value when each slot starts and hold it. Unlike `segment` (a fixed pattern-time), this snapshots the value at that moment, so it works on `mouseX`/`mouseY` — `mouseX.sample(8)` is the pointer stepped/held at 8/cycle (`segment` is a no-op there). |
| `.ease(name)` | reshape the **0..1 signal** through an easing curve **before** `.range()` maps it — turn a linear ramp into an accelerating / decelerating / overshooting one |

### Easing

`.ease("outExpo")` remaps a `0..1` signal through a **Penner / anime.js easing curve**, the
shaping vocabulary `quantize`/`range` lack. The rule is **ease the unit signal, then
`range` maps it** — easing always operates on the normalized `0..1`, so put it *before*
`.range()`:

```js
shape("dot*24").angle(saw.range(0,1))
  .radius(saw.ease("outExpo").range(0.04, 0.46))   // a bunched spiral (fast out, slow settle)
  .color(palette("aurora").at(saw.ease("inOutSine").range(0, 1)))
```

It works the same on a **live `osc`** (shapes the waveform before its range), so
`osc(0.5,"tri").ease("inOutCubic").range(0.02, 0.06)` breathes on a softened curve.

**Curves** (24 + `linear`): `in` / `out` / `inOut` × `Quad` `Cubic` `Quart` `Expo`
`Sine` `Back` `Elastic` `Bounce` — e.g. `inQuad` `outExpo` `inOutSine` `outBack`
`outElastic` `outBounce`. `back` / `elastic` / `bounce` deliberately **overshoot** past
`[0,1]` (that swing is the point). The curve name is itself sampled from the right, so it
can be a mini-notation pattern: `.ease("<inOutSine outBack>")` alternates curves per cycle.

### Spring

A signal/osc is a pure function of time — it replays a fixed curve. A **spring has state**
(velocity + current value) and *reacts*: each frame it's pulled toward a **target**, giving
the **momentum / overshoot / settle** easing can't. `osc(...).spring(stiffness, damping)`
chases that osc's output; the target is normally **stepped** (a `.quantize`d osc, or a
`rand`/`square` shape) so the value lurches to each new step and rings down:

```js
shape("dot*7")
  .x(osc(0.18,"saw").spread(1).quantize(8).spring(150, 11))   // settle between 8 columns
  .y(saw.range(0.16, 0.84))
shape("ring*5")
  .radius(osc(0.3,"rand").spread(1).range(0.12,0.44).spring(120, 9))   // chase random radii
```

- **stiffness** (default `120`) = pull toward the target — higher snaps faster.
- **damping** (default `14`) = how fast the wobble dies. **Under-damped** (`d < 2√k`)
  overshoots and rings; **over-damped** glides in with no overshoot.
- Free-function form: `spring(target, stiffness, damping)` (target = an osc or number).
- Works on **position** (`x` `y` `radius` `angle` `pan`) and the **scalar** controls
  (`size` `rotate` `rotateX` `rotateY` `weight` `outline` `open` `alpha` `shade`). Each
  glyph carries its own spring state from birth, so glyphs settle independently. *(Not
  `color` — it's not a scalar.)*

`quantize` snaps amplitude, not time, so `sine.quantize(4)` lingers at the peaks/troughs (where the sine is slow) and flickers through the middle. For even rhythmic steps use `.segment(n)` (or drive it with a time-linear ramp like `saw`/`tri`). They compose: `perlin.segment(8).quantize(4)` = organic walk, plucked on 8ths, into 4 colours. `palette("rainbow").at(perlin.range(0,1).segment(8))` plucks the background on a grid.

### Live oscillators

A signal is sampled **once at a glyph's onset and frozen**. An **`osc`** keeps
running over the glyph's whole lifetime, the renderer re-evaluates it every
frame against the glyph's age, like `spin` does for rotation. So a dot can keep
moving, its colour can cycle, its size can breathe, *after* it's drawn.

```js
osc(rate, "sine").range(lo, hi)   // rate = cycles per cycle (tempo-synced); range 0..1
```

**Tempo-synced by default**: `rate` is cycles-*per-cycle*, so an osc rides the clock —
change the tempo (`cps`) and the drawn structure stays the same, the whole animation
just speeds up or slows down with it. `.free()` switches an osc back to real-time (rate
in Hz, cycles-per-*second*) — useful when you want a wobble that ignores the tempo. (A
glyph's lifetime is a fixed number of cycles, so under `.free()` it sweeps a tempo-
dependent amount of its path and the structure shifts with tempo; synced, it doesn't.)

Shapes: `sine` `saw` `tri` `square` `rand` `perlin` `fbm` (perlin/fbm are the
smooth, organic, livelier ones). Chainable: `.range(lo, hi)` `.rate(r)`
`.phase(p)` `.spread(n)` `.drift(r)` `.fast(n)` `.slow(n)` `.free()`. The `lo`/`hi` of an osc's
`.range` may themselves be oscs, so the range can move: `osc(2).range(0, osc(0.1).range(0.4, 1))`.

**Phase offsets — `phase` / `spread` / `drift`.** An osc's phase is one sum of
four terms:

```
phase = age·rate  +  .phase(p)  +  .spread(n)·gp  +  .drift(r)·st
        └ running ┘  └ constant ┘  └ structural   ┘  └ temporal   ┘
```

`gp` = the glyph's **onset phase** (0..1 position *within* its cycle — which glyph
in the pattern; repeats every cycle). `st` = the glyph's **spawn time** in seconds
(absolute, grows forever). So the three offsets are independent axes, none
derivable from the others:

| Method | × | does |
| --- | --- | --- |
| `.phase(p)` | `1` | same offset for every glyph, always — a fixed rotation |
| `.spread(n)` | `gp` | offset ∝ position in the pattern → fans the wave *around* a ring/grid |
| `.drift(r)` | `st` | offset ∝ spawn time → the pattern keeps *evolving* instead of repeating |

`palette("rainbow").at(osc(0.08).spread(1).range(0,1))` = a colour wheel spread
around the ring; add `.drift(0.05)` and the wheel slowly winds over the whole run.
Two glyphs at the *same onset* but different spawn times share a `spread` offset
(locked) but differ in `drift` (separate) — that's the whole distinction.

`spread` is **not** `range` or `fast`/`slow`: those change the swing (amplitude)
and the frequency, same for every glyph. `spread` is the only one that adds a
*per-glyph phase*. You could hand-roll it as `.phase("0 0.125 … 0.875")` (a phase
per onset) — `spread(n)` is just sugar for `n × onset phase`.

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
