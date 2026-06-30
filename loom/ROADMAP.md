# Loom — roadmap

Ordered by value × independence ÷ effort. Four themes: **motion primitives**,
**authoring**, **dynamics**, **performance/output**. (Renderer is now Three.js/WebGL;
language lives in `pattern.js`, untouched by any of this except where noted.)

## Tier 1 — now (small, high-value, independent)

1. **Easing as a primitive.** ✅ **Done.** `.ease("outExpo")` — a 0..1→0..1 Penner/anime.js
   remap on any signal / osc output (shapes the unit signal *before* `.range()`), plus
   easing-shaped envelopes (`.attack(s,"outBack")`, `.decay(s,"inOutSine")`). 24 curves +
   `linear`; curve name is patternable. Lives in `pattern.js` (`EASE`/`ease`, `Pattern.ease`,
   osc `ease` slot, `attack`/`decay` 2nd arg) + `main.js` (`evalOsc` pre-range slot, env calc).
   No renderer change. Preset: `easing`.
   - *Future fork:* the envelope currently drives alpha only, so overshoot curves clamp.
     Could route the overshoot into a per-glyph **size pop** for a true bounce-in (touches
     the renderer / per-glyph state — natural to fold in with the spring work, #3).

2. **Named layers / `$` syntax (Strudel `$:`-style).** ✅ **Done.** A `$(name?, pattern)`
   registry (`pattern.js`); `compile()` (`main.js`) collects every `$(...)` call and stacks
   them — expression-mode first (bare patches unchanged), statement-mode fallback for
   multi-line `$` patches. Names are first-class + unique (collisions `#2`-suffixed), exposed
   on `window.loom.layers`. Preset: `layers`.
   - **Live mute / solo** ✅ — haps tagged with `_layer` (like group `_gid`); the renderer
     skips muted / non-soloed layers at *draw* time, so toggling hides/shows on-screen glyphs
     instantly (no re-run). Clickable **layer chips** under the editor (name = mute, dot =
     solo) + `loom.mute/solo/muted`. This is half the **scene mixer** (#6) — what remains
     there is crossfade/blend between *patches*, on top of output buses (#5).

## Tier 2 — dynamics (kinematic → physical)

3. **Spring primitive.** ✅ **Done.** `osc(...).spring(stiffness, damping)` (+ free fn
   `spring(target, k, d)`) — per-glyph 1D state (velocity + value) integrated toward a live
   target each frame; semi-implicit Euler, substepped for stiff-spring stability. The
   **momentum / overshoot / settle** osc & easing can't do. `pattern.js`: `spring`/`isSpring`
   descriptor + osc method. `main.js`: per-glyph `springs`/`_spr` on the particle, integrated
   in `tick()`, read by `resolvePos` (position) + `glResolve`/`drawGlyph` (scalars). Drives
   x/y/radius/angle/pan + size/rotate/rotateX/rotateY/weight/outline/open/alpha/shade (not
   color). Proves the **per-glyph-state plumbing** for physics (#4). Preset: `spring`.

4. **Physics mode (Rapier 2D).** ✅ **First cut done.** `physics(pattern, { gravity, bounce,
   drag, vel, spin, windx })` group (parallel to `group()`): each onset spawns a **rapier2d
   rigid body** in a per-group world; bodies fall, bounce off the canvas edges, and **collide
   with each other**; transforms feed the instance buffer's x/y/rotation each frame. Loom owns
   spawn (when/where/size/colour) + lifetime; the sim owns position. **Opts patternable** via
   `evalGlobal` (gravity-as-osc, `windx`, etc.). `pattern.js`: `physics()`/`Physics` + registry.
   New `physics.js`: lazy `ensureRapier()` + `PhysWorld` (screen-space, scaled metric sim,
   edge walls). `main.js`: per-glyph `body` lifecycle tied to the envelope, sim block in
   `tick()`, `physRot` into both resolvers. **Rapier (WASM, ~1.7 MB) is a separate lazy chunk**
   — patches without `physics()` never load it (verified in the build). Preset: `gravity`.
   - **Force-fields** ✅ — pure-JS accelerations applied per body each frame (reusing the
     evalGlobal param plumbing): `attract`/`swirl` toward/around a (patternable) point `ax,ay`,
     and `turbulence` (a divergence-free curl-noise flow). Emergent swarming/orbiting/drift;
     all patternable. Preset: `swarm`. Tighter **convex-hull colliders** per shape ✅ too.
   - *Deferred:* mass/density controls, attractor *between* groups, 3D.
   - **Camera automation** (still TODO; lands with **3D depth**): the renderer is orthographic
     screen-space billboards with *faked* per-glyph perspective, so a real patternable camera
     (orbit/dolly/fov via `evalGlobal`) only becomes meaningful once there's a true 3D scene —
     a separate, larger renderer change, not part of this 2D-physics cut.

## Tier 3 — output buses & performance

5. **Named output buses + sourcing/masking** (Strudel `orbit` / Hydra `.out(o0)` + `src()`).
   Route layers to N named render buffers (`o0..oN`) instead of one screen; a buffer can be
   **referenced as a source** in another chain — feedback/compositing *between* buses — and a
   final `render()`/blend picks what's shown. The Hydra multi-output model. *Substrate for
   everything below;* builds directly on the existing per-group render targets.
   - **← THE NEXT THEME.** Tiers 1–2 are all shipped; this is the top of the stack now.
   - **Masking** (Patrick's near-term want) is the concrete first slice: use one source/bus's
     output as the **alpha/luma mask** of another. It needs the same "a bus is a sampleable
     texture" plumbing as sourcing — just consumed as a mask channel in the composite rather
     than a blend input — so build the bus-as-source primitive first and masking falls out of it.
     Smallest viable cut: `src(layer)` / `.mask(layer)` reading another `$`-layer's render target.
     **Design draft + resolved decisions in [`MASKING.md`](MASKING.md).**

6. **Scene mixer (VJ).** On top of buses: hold N patches as scenes (each → a bus) and
   **crossfade/blend** between them (A/B crossfader, or a 4-up grid), with per-layer mute/solo
   from `$`-layers. High value for live performance.

7. **Hardware / external out** (later, optional): second-window/projector, NDI/Syphon (into
   Resolume etc.), MIDI/OSC out, recording.

## Shipped outside the tiers

- **CodeMirror 6 editor + inline `slider()` widgets** ✅ Replaced the textarea/regex-overlay
  with CM6 (`editor.js`): faithful Loom highlighting (StreamLanguage → the same `--t-*`
  colours), ⌘↵ / Tab / undo, floating-over-canvas theme. Then `slider(value, min?, max?)` —
  a number that renders a draggable slider inline over the call; drag/scroll rewrites the
  source + re-runs live (re-found by ordinal so offsets never desync; fixed-width padded value
  so it doesn't jitter; styled track/thumb). Preset: `sliders`. Plus editor niceties: ⌘/
  comment toggle, undo/redo, highlight active line, chunky cursor, the per-line hugging code
  box; sliders are distinct rotating OKLCH colours + double-click-to-reset; a live readout
  badge after each `mouseX/mouseY/mouseDown` tinted dark→light by value. *Substrate for more
  inline widgets:* colour pickers, XY pads, a `select()`/toggle.
- **Interaction — live pointer signals** ✅ `mouseX` / `mouseY` / `mouseDown` (mouse + touch)
  as signals: frozen-at-onset on per-glyph controls (trail where things spawn), re-read each
  frame as FX/physics params (cursor-driven attractor). `.sample(n)` sample-and-holds a live
  signal n/cycle (stepped pointer; `segment` is a no-op on it, `quantize` snaps the value).
  `mouseDown` fires on a canvas press or ⌥/⌘-click (editor clicks just edit). Presets:
  `cursor`, `press`.
- **MIDI input** ✅ `cc/gate/vel/note/pc/bend(ch)` signals over Web MIDI (same frozen-at-onset
  vs live duality as the pointer); `onNote(ch, shape)` = one glyph per note-on (event source,
  not a sampled stream); `pc(ch)` = octave-folded pitch class for stable note→colour; osc
  `.range()` bounds may now be signals (frozen at spawn) so a hue can track a live note. The
  *musical* half of the juggling rig. *Deferred:* monophonic/voice mode (a persistent, re-
  targetable object — needs a design pass; Loom has no addressable-updatable-object concept yet).
- **Juggling WS feed** ✅ The *spatial* half — a separate local app (webcam + on-ball IMU,
  `~/Code/juggling-system`) broadcasts plain JSON over WebSocket; Loom signals `ballX/ballY/
  ballSeen/thrown/caught/tapped/flight/gyro(id)` + `moving(id)` (IMU-gated, drops static
  scenery). Off by default (`?feed`). **Camera overlay** = MJPEG drawn as a GL background quad
  (aspect-fit + cover-fill), pixel-aligned with ball coords. `.gate(cond)` keeps only events
  where a condition holds at onset.
- **Chrome/transport polish** ✅ Run/play/clear moved to the editor transport row; mode toggles
  + flat quiet sliders for speed/decay; demoted cycle readout; ⌘. hide-all-chrome with a toast;
  editor live value-badges for the pointer/MIDI/juggling signals (envelope-smoothed).

## Backlog / jot-down (not now)

- **Per-param envelopes — `env()`.** ✅ **Done.** `env(attack, decay, easeIn?, easeOut?)` — an
  attack/decay envelope as an *age-driven signal* (osc-family, so it animates over the glyph's
  life), routable into any param and composing with `.range()`/`.add()`/`.spring()`. Implemented
  as an `env` slot on the osc descriptor (`pattern.js`); `evalOsc` (`main.js`) reads the glyph's
  real-time age before the periodic-shape branch; `freezeOscParams` freezes signal-valued
  attack/decay at onset. Chosen over callbacks (which break the everything-is-a-signal model).
  For alpha, `.decay(s, curve)` is still the tool — alpha is also × the lifetime envelope.
- **Copying / clone.** A first-class way to fork a source through *parallel* FX. Possible today
  via `stack(group(src).fxA, group(src).fxB)` (each `group()` = its own FX bus); wants a tidier
  clone verb. Note: meshes are all at `z=0` (no DSL depth), so copies separate only in x/y.
- **Audio-reactivity** + **juggling polygon** (read N ball coords → one multi-vertex glyph) —
  both flagged feasible, not started.
- **Timeline choreography.** An anime.js-style global *score* animating Loom's knobs (cps,
  master decay, bg, fx params, preset crossfades) over wall-clock time — the one place
  anime.js's timeline model fits (Loom has no timeline; it's an event-spawner). Deferred per
  Patrick.
- **anime.js Three adapter** — *not* for glyphs (instanced buffer, no discrete Object3Ds to
  tween); only useful for post-FX uniforms or a camera. Skip unless a camera is added. The
  valuable part of anime.js is its easing functions (see Tier 1) and, eventually, its timeline
  (above).

## Dependencies
- 1 (easing), 2 (`$`-layers), 3 (spring) are each standalone.
- 4 (physics) is standalone-ish; benefits from 3 proving per-glyph dynamics; camera
  automation rides along with it.
- 5 (output buses) builds on the existing per-group render targets.
- 6 (scene mixer) sits on 5 (buses) + 2 (`$`-layers for mute/solo).
- 7 (hardware out) after 6.
