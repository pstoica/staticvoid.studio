# Loom — custom visual modules (design draft)

Status: **draft / not started.** Patrick, 2026-10-23: open the architecture so a totally
custom visual — the wave-ripple sims on `patrickstoica.com` and this site's `index.html` —
can plug in and be driven by Loom's signals, MIDI especially. This doc plans that.

Masking (MASKING.md, shipped 2026-10-23) built the substrate this needs, so the expensive
half is already paid for.

## What a module actually is

Two different things get called "a module", and conflating them is the main design risk:

1. **A pass** — it takes the layer's pixels and returns pixels. `pixelate`, `glow`, `mask`.
   Loom already has a plugin point for this: `_fx.chain` is a list of `{type, ...params}`
   that `_applyChain` walks (`gl/renderer.js`). A new pass is a new `type` plus a verb.
   **No architecture needed.**
2. **A source** — it owns state and produces an image: the ripple sims, a feedback buffer,
   a particle system that isn't Loom's. It is not a function of the layer's pixels; it has
   its own simulation that advances in time.

Only (2) is hard, and (2) is what Patrick asked for. Everything below is about sources.

## Why the ripple sims are the right test case

Both are already shaped like what Loom needs — a `Float32Array` field, a fixed-rate `tick()`,
a separate `render()`, and exactly one input: `stamp(x, y, amp)`. They draw to canvas and to
SVG respectively, but that is incidental; the *visual* is the point, not the output format.
A module that can host those can host most things.

The important property: **one impulse input**. `micHit()`, `thrown("a")`, `onNote()` and
`tapped()` are all already decaying-pulse signals. A ripple per transient is a two-line patch
once the plumbing exists — and `ripples` (the preset) already fakes it with expanding rings,
which is the cheap approximation worth exhausting first.

## The seam: buses

Masking established the piece that was missing. `render()` now:

1. collects the layer names anything references,
2. renders those layers to their own render targets **first**,
3. publishes them as `this._buses` (name → texture) before anything composites,
4. composites in `$`-order, skipping `.hidden()` layers.

A module source is **a bus whose texture comes from somewhere other than Loom's glyph
renderer**. That is the whole idea. The registry, the ordering, the lazy-allocation and the
pruning already exist and are tested; a module slots in at step 2 as another way to fill a
texture.

## The interface

```js
loom.module("ripples", {
  init({ gl, width, height })   // once per size; allocate your field
  tick(dt, params)              // fixed-rate state advance; dt in seconds
  draw({ target, width, height })  // write RGBA into `target`; nothing else
  event(name, payload)          // discrete inputs: {x, y, amount}
  dispose()
})
```

In a patch:

```js
$("water", module("ripples", {
  damping: 0.96,
  stamp: micHit(),              // a signal: when it crosses, event("stamp", {x, y, amount})
})).hidden()

$("art", shape("dot*200").grid(14)).mask("water")   // ripples CUT the art
```

Three things fall out for free because the module is just a bus:

- `.mask("water")` — already works, masking shipped.
- `.hidden()` — already works.
- `src("water")` — when Phase 2 of MASKING.md lands, modules feed FX inputs too.

## Params and events: the real DSL question

A module's `params` are ordinary Loom values — numbers, patterns, oscs, signals — resolved
per frame with `evalGlobal`, exactly like FX params. Nothing new.

**Events are the new thing.** Loom has two existing idioms and the module system should reuse
one rather than inventing a third:

- the frame-snapshot source (`onNote`, `spoken()`), where an input queue is drained once per
  frame; and
- the decaying pulse (`micHit`, `thrown`), where a signal spikes to 1 and falls.

Proposal: a param whose value is a **pulse signal** becomes an event when it crosses a
threshold, with hysteresis — `.gt(trip, release)` already exists and already solves the
chatter. Position defaults to the glyph-less layer centre and is overridable with `x`/`y`
params. This keeps modules inside the everything-is-a-signal model instead of bolting a
callback API onto the side.

## Phases

**Phase 0 — one hardcoded module, no API.** Port the ripple sim into `gl/` as a bus that
renders to a target, wired to one signal. Prove the bus-as-non-glyph-source idea end to end
before designing anything. Throwaway on purpose.

**Phase 1 — the registry.** `loom.module(name, impl)` + the `module(name, params)` DSL source.
Params resolved per frame; events via threshold crossing. Still Loom-internal modules only.

**Phase 2 — third-party modules.** Loading someone else's code. See the risk below.

**Phase 3 — GPU modules.** A module that wants a shader rather than a canvas. Probably where
the ripple sim ends up for speed (the CPU `Float32Array` version is fine at the sims' current
grid sizes and is the right starting point).

## The risky part, named

**Letting a module own a GL context it did not create.** Loom's renderer owns the WebGL
state machine — bound framebuffer, blend mode, viewport, scissor, active program. Three.js
caches that state and will not notice a module changing it behind its back; the symptom is
not a crash but *another layer* rendering wrong, intermittently, in a way that looks like a
Loom bug. This has bitten this codebase before, in a smaller way: `setScissor` takes CSS
pixels and applies `pixelRatio` internally, and pre-multiplying by DPR produced a doubled
-opacity band that took a live session to track down.

Mitigation, in order of preference:

1. **Modules never touch GL.** They render to a 2D canvas Loom uploads as a texture. Simple,
   safe, and fast enough for a grid sim — the ripple sims already do exactly this. Start here.
2. Modules get a *scoped* GL helper that saves/restores state around their draw, never the
   raw context.
3. Raw context access: only if something genuinely needs it, and `renderer.resetState()`
   around every call.

The second risk is smaller but worth stating: **a module is arbitrary code in the render
loop.** One that blocks for 30ms drops the frame rate for everything, and Loom has no
watchdog. For Loom-internal modules that is fine. It is the main thing standing between
Phase 1 and Phase 2, along with the obvious question of where third-party module code would
even come from — if that turns out to mean "a text field you paste JS into", say so plainly
and treat it as a local-only developer feature, not a shareable artifact.

## Open questions

1. **Does a module need Loom's clock, or its own?** The sims run a fixed 60Hz accumulator
   internally. Loom's `tick(dt)` already is one. Proposal: Loom owns the clock, passes `dt`,
   and the module does not accumulate — that way `cps` changes and pausing work on modules
   for free. Needs checking against the sims' own accumulator.
2. **Resolution.** Buses are screen-sized. A grid sim wants a small grid (the sims use ~1 cell
   per 8-12 px) upscaled. Does the module declare its own resolution and Loom scale it, or
   does it render at bus size? Declaring is better and cheaper; confirm the upscale filter.
3. **Does `module()` return a Pattern or a Group?** It emits no glyphs, so it is closest to
   `cam()` — a declared source that sits in a `stack(...)` and returns silence. But it needs a
   layer name to be maskable, so it probably has to be used inside `$(...)`. Decide whether
   `module()` auto-names.
4. **State across re-runs.** ⌘↵ rebuilds the patch. Should a module's field survive, like
   `.id()` objects do, or reset? A ripple field resetting on every edit would make live
   coding feel broken; surviving means keying the instance by name and diffing params.
