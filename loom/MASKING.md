# Loom — masking & sourcing (design draft)

Status: **draft / not started.** Resolves the first concrete slice of ROADMAP Tier 3 #5
(named output buses + sourcing). Masking is the smallest consumer; sourcing follows on the
same substrate.

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

## Follow-up questions (still open)

1. **Exact `luma` formula + alpha interaction.** Proposal: `lum = dot(rgb, vec3(.2126,.7152,.0722))`
   (Rec.709), and `maskValue = (mode==alpha ? srcA : lum) * srcA`. I.e. multiply by source alpha
   in *both* modes so transparent regions never leak. Confirm the luma weights + whether luma
   should also be ×srcA (proposed yes) or raw luma (premultiplied source makes raw luma already
   alpha-aware — decide once the RT's premultiply state is pinned down).
2. **`invert`** — `maskValue = 1 - maskValue` (so a bright/opaque source becomes a hole). Just a flag; confirm wanted in v1.
3. **Source must be a named `$`-layer.** Masking a bare `group()` (no name) isn't addressable —
   require `$("name", …)`. OK as a constraint?
4. **Soft edges** come free with `luma` (gradient → gradient alpha). Anti-aliasing of an `alpha`
   shape mask depends on the source RT's own AA — likely fine, verify on a hard-edged stencil.
5. **Resolution** — all RTs are full-screen, same size → 1:1 UV sampling, no rescale needed. Holds
   as long as buses share the screen RT size (they do today).
