# Loom — roadmap

Ordered by value × independence ÷ effort. Four themes: **motion primitives**,
**authoring**, **dynamics**, **performance/output**. (Renderer is now Three.js/WebGL;
language lives in `pattern.js`, untouched by any of this except where noted.)

## Tier 1 — now (small, high-value, independent)

1. **Easing as a primitive.** `.ease("outExpo")` etc. — a 0..1→0..1 remap usable on any
   signal / osc / pattern output, plus easing-shaped envelopes (`.attack(s,"outBack")`,
   `.decay(s,"inOutSine")`). Borrow the Penner/anime.js curve set (no runtime dep needed —
   just the functions). *Why first:* it's the missing shaping vocabulary; tiny lift; pairs
   with everything (osc, quantize, spring).

2. **Named layers / `$` syntax (Strudel `$:`-style).** A `$(name?, pattern)` registry so a
   patch is several **named, separately-editable layers** instead of one giant
   `stack(...)`. `compile()` collects all `$(...)` calls and stacks them; bare-expression
   patches still work. *Why early:* directly fixes the "cram everything into one stack/group"
   pain felt now, AND it's the substrate for per-layer **mute/solo/FX** and the scene mixer
   later. Renderer-independent.

## Tier 2 — dynamics (kinematic → physical)

3. **Spring primitive.** `.spring(stiffness, damping)` value modifier — per-glyph 1D state
   integrated toward a target each frame. The **momentum / overshoot / settle** that osc and
   easing fundamentally can't do (they're pure functions of time; a spring has state and
   *reacts* to a changing target). Gorgeous with `quantize` (settling between grid steps) and
   onset-jumping targets. *Why here:* it's the bridge from stateless shaping to real dynamics —
   closer to easing than to Rapier, useful on its own, and proves the per-glyph-state plumbing.

4. **Physics mode (Rapier + Three).** A `physics(pattern, { gravity, drag, bounce, … })`
   group (parallel to `group()` for FX): events spawn **rigid bodies** into a shared world;
   each frame the bodies' transforms feed the existing instance buffer. Loom stays the
   *spawner/conductor* (when/where/initial-velocity/mass/shape/appearance + lifetime); the
   sim owns position. **Patterns/oscs drive forces & gravity-as-params** — the elegant bit:
   physics knobs become patternable exactly like FX params (`evalGlobal`). Optional hybrid:
   an osc/pattern force-field (turbulence/attractors) the bodies integrate → emergent motion
   with real dynamics. *Biggest new capability; largest lift.* Engine: **Rapier** (WASM, 2D
   or 3D, thousands of bodies). Per-glyph osc still modulates color/size.
   - **Camera automation** (lands with physics / 3D depth): a **patternable camera** —
     position / target / fov / rotation driven by patterns/oscs (orbit, dolly, shake, follow).
     Same `evalGlobal` mechanism; pairs naturally with physics and the existing perspective.

## Tier 3 — output buses & performance

5. **Named output buses** (Strudel `orbit` / Hydra `.out(o0)`). Route layers to N named render
   buffers (`o0..oN`) instead of one screen; a buffer can be **referenced as a source** in
   another chain — feedback/compositing *between* buses — and a final `render()`/blend picks
   what's shown. The Hydra multi-output model. *Substrate for everything below;* builds directly
   on the existing per-group render targets.

6. **Scene mixer (VJ).** On top of buses: hold N patches as scenes (each → a bus) and
   **crossfade/blend** between them (A/B crossfader, or a 4-up grid), with per-layer mute/solo
   from `$`-layers. High value for live performance.

7. **Hardware / external out** (later, optional): second-window/projector, NDI/Syphon (into
   Resolume etc.), MIDI/OSC out, recording.

## Backlog / jot-down (not now)

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
