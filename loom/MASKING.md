# Loom — masking & sourcing (design draft)

Status: **Phase 0 + Phase 1 SHIPPED 2026-10-23.** `.mask(name, opts)` and `.hidden()` work on
both `group()`s and `$`-layers. Phase 2 (`src(name)` sourcing) is still open — it reuses the
same bus registry, so it is now a small addition rather than an architectural one.

## Why it's not trivial

Today only `group()`s get their own render target (`groupRTs`, keyed by numeric `gid` —
`gl/renderer.js`). Ungrouped glyphs and `$`-layers draw straight to screen (layers are only
*tagged* `_layer` for mute/solo, skipped at draw time — no FBO). The render loop also
**interleaves draw + composite per group** (`renderer.js` ~L1048). So a mask source has
neither (a) its own sampleable texture nor (b) a stable name to reference it by. Building
those two is the real work; the mask shader itself is one fullscreen pass.

## Phase 0 — substrate (the actual lift)

1. **Name → texture registry.** Promote `$`-layers to **buses**: a *referenced* layer renders
   to its own RT instead of straight to screen, registered as `name → post-FX texture`.
2. **Decouple draw from composite.** Split the per-group loop into two passes — (1) render every
   bus to its RT + run its FX chain, populating the registry; (2) composite buses to screen in
   order. Once separated, any bus's current-frame texture is available to any other (enables
   masking now, sourcing/feedback later, including mutual references).

## Phase 1 — the mask (small, once Phase 0 lands)

3. **DSL verb:** `.mask(name, { mode, invert })` on a group/bus → stores a mask descriptor.
4. **Renderer:** one fullscreen material `MASK_FRAG(tMap, tMask, mode, invert)` →
   `outColor = color * maskValue`, inserted as the **last step of the masked bus's chain**
   (after its own FX, before composite), `tMask` resolved from the registry.

```js
$("hole", shape("circle").size(osc(0.3).range(0.2, 0.5)).x(mouseX)).hidden()
$("art",  shape("bong*40").color(palette("rainbow").at(saw))).mask("hole")
// the bong field shows only through the circle; drag to move the window
```

## Phase 2 — sourcing (rest of #5, later)

`src(name)` to feed a bus's texture into FX *inputs* (blend / displace between buses — the
fuller Hydra model). Same registry; masking is just the first consumer.

## Resolved decisions (Patrick, 2026-06-30)

- **Stencil visibility → explicit `.hidden()`.** A mask source you don't want drawn is marked
  `.hidden()`: it still renders to its RT (so it's sampleable) but is **not composited** to
  screen. Preferred over auto-hiding *"if only ever referenced."* Revisit only if/when we
  introduce real **sinks/destinations** (an output-bus `.out(o0)` model) — then visibility
  becomes "what's routed to the screen sink" and `.hidden()` may fall away.
- **Mask modes → support BOTH `luma` and `alpha`, and respect alpha either way.** `luma` is the
  multiply-ish one (source brightness drives how much shows); `alpha` uses the source's coverage.
  In both modes the source's own alpha must factor in (a transparent source masks to nothing).
- **Phase 0 scope → lazy per-reference RTs.** A `$`-layer only gets an FBO if something
  references it as a mask/source (or it already has group FX). Keeps the common case cheap (no
  VRAM regression for ordinary patches).

## Follow-up questions — answered while building

1. **Exact `luma` formula + alpha interaction. → RESOLVED: raw luma, no extra ×srcA.** The group
   RTs are **premultiplied** — the composite operator is `One / OneMinusSrcAlpha`
   (`_composite`, `gl/renderer.js`), so `s.rgb` is already × alpha and a transparent region is
   already black. Multiplying by `s.a` again would square the alpha and eat soft edges. Weights
   are Rec.709 `dot(rgb, vec3(.2126,.7152,.0722))`.
   Measured: a `#101010` circle masks to `litPct 0` in `luma` (correctly almost nothing passes)
   but `litPct 5` in `alpha` (correctly full coverage — it is opaque, just dark). The two modes
   are doing genuinely different things.
2. **`invert`** — shipped as a flag. Measured flipped: centre `[54,61,83]` / outside `[255,0,0]`.
3. **Source must be a named `$`-layer.** Kept as the constraint; the registry is keyed by layer
   name. Masking an anonymous `group()` is still not addressable.
4. **Soft edges** come free with `luma` as predicted (the source's own gradient is the mask).
5. **Resolution** — holds: every RT is screen-sized, so mask sampling is 1:1 UV with no rescale.

## What shipped

- **Bus pass.** `render()` collects every layer name referenced by a `mask` step, renders those
  layers to textures *first*, and publishes them as `this._buses` (name → texture) before
  anything is composited. So a mask works regardless of stacking order — the source may be
  written after its target.
- **Lazy, as decided.** A layer nobody references keeps the old straight-to-screen path and
  allocates no FBO. Verified: two ordinary `$`-layers allocate `[]`; the masking pair allocates
  exactly `['$hole', '$art']` (the source *and* the target, since the target needs a buffer to
  run its chain in), and both are pruned the moment the patch stops using them.
- **Draw/composite split.** Only partially needed in the end: `layer(gid)` already returned a
  texture rather than drawing to screen, so groups were half-decoupled already. The new work was
  giving *bare* layers the same treatment and ordering the two passes.
- **Cycles** (two layers masking each other) resolve one frame late rather than deadlocking.
