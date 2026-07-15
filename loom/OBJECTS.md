# Loom — persistent objects / mono voice (design draft)

Status: **draft — Phase 0 implemented, Phases 1+ awaiting a yes/no.** The design pass
ROADMAP flagged under MIDI input (ROADMAP.md:104-106): *"monophonic/voice mode (a
persistent, re-targetable object — needs a design pass; Loom has no
addressable-updatable-object concept yet)."*

## The tension

Loom's spine is fire-and-forget: pattern → `query(span)` → one glyph per onset
(`main.js:920-926`) → age → envelope → cull (`main.js:954-975`). A glyph is never
addressable after birth — nothing can find it, update it, or keep it alive.

The concrete thing that's impossible today: **a mono synth voice.** Play a MIDI line and
you want ONE circle that *slides* to each new note's position and *stays lit while the key
is held*. The two MIDI tools bracket it without hitting it:

- `onNote(ch, shape)` is an **event source** — exactly one new glyph per note-on
  (`pattern.js:460, 470-474`). A legato line becomes a trail of overlapping births and
  deaths, not one moving thing.
- `gate(ch)` is a **sampled stream** — 1 while held (`pattern.js:455, 463`). Filtering
  with `.gate(gate(1))` gates *which onsets spawn*; every spawned glyph still decays on
  its own.

And even if a glyph could be re-targeted, it couldn't be *held*:

**Verified: the envelope has no sustain.** `_env` rises 0→1 over `attack`, and the moment
`age ≥ attack` it enters the decay branch (`main.js:967-975`); it equals 1.0 for exactly
one instant. `alpha` is multiplied by `_env` in both renderers (`main.js:610`, `main.js:835`),
and the glyph is culled at `age ≥ attack + decay` (`main.js:958`). Same for the `env()`
per-param envelope — attack/decay only (`pattern.js:675-677`, `main.js:459-464`). A held
note literally cannot hold a glyph at full presence. (Degenerate loophole: `.decay(Infinity)`
*is* immortal-at-full-brightness today — decay-t stays 0, the cull never fires — but it can
neither be released nor re-targeted. The missing pieces are **release** and **addressability**,
not immortality.)

## What already exists: three half-built flavors of persistence

Do not design a fourth. The job is the smallest concept that reconciles these.

**1. Springs — the retarget-interpolation primitive, already built.**
`spring(target, k, d)` (`pattern.js:688-691`) puts per-glyph state `{field, target, k, d, x, v}`
on the particle (`main.js:275-281`), integrated toward a live target every frame
(`main.js:980-992`), read back by `resolvePos` (`main.js:666-668`) and `glResolve`
(`main.js:592-603`) across 14 fields (`SPRING_FIELDS`, `main.js:430`). This is *exactly* the
"glide to the new note" mechanic a mono voice needs: keep `{x, v}`, swap the target, and you
get legato with momentum for free. Two gaps:
- **State dies with the glyph.** Springs are captured at spawn and culled with the envelope;
  there is no glyph that lives long enough to be re-targeted.
- **A spring can't chase a live signal.** `spring(note(1))` is expressible but broken:
  `numAt` only resolves numbers and oscs (`main.js:491`); a Pattern/signal target passes
  through unchanged, so `x0 = numAt(sd.target, …)` at spawn (`main.js:277`) and `tgt` in the
  integrator (`main.js:984`) become a Pattern object and the position NaNs (the guard at
  `main.js:989` re-assigns the Pattern, not a number). REFERENCE.md:573 documents targets as
  "an osc or number" — signals were never wired in. The mono voice needs precisely this.

**2. Physics bodies — genuinely persistent objects, still envelope-bound.**
A `physics()` glyph gets a rapier body created lazily in `tick` (`main.js:1032-1041`); the
sim *owns and mutates* its position each frame (`main.js:1058-1062`) — a real
externally-owned object living outside the frozen-at-spawn rule. But its **lifecycle** is
still spawn→decay: the body is freed when the envelope expires (`main.js:959`) or on
hard clear (`main.js:348-351`, with the orphaned-body hazard called out in the comment).
Lesson: Loom already knows how to let something else own a glyph's position; it does not
yet know how to let anything own its *lifetime*.

**3. `$`-layers + gids — addressing that already survives a live re-eval.**
`$(name, pat)` tags haps with `_layer` (`pattern.js:859-875`) → live mute/solo at draw time
(`main.js:144-150, 1068`). Group ids reset each compile and are stable *by creation order*
(`pattern.js:741-747`), which is what lets on-screen glyphs re-read their group's edited FX
after ⌘↵ (`main.js:1003`) without a wipe (soft re-run keeps particles, `main.js:186-193`).
Two lessons and one warning:
- Names/ids attached to *hap values* flow through every combinator untouched — that's why
  mute/solo composes with everything.
- Identity by creation order works **only for compile-time top-level calls**. A stateful
  wrapper inside a combinator callback is already broken today: `every(4, p => physics(p, …))`
  constructs a new `Physics` (and mints a fresh `_pid` into the registry, `pattern.js:842`)
  on *every query* — the compile-time snapshot (`main.js:210`) misses them, glyphs sit inert,
  and the registry grows every frame. Whatever names an object must not be minted inside
  `query()`.
- **Warning:** MASKING.md (Phase 0) is about to promote `$`-names to *render buses*
  (name → texture). Overloading the same namespace to also mean "voice object" would make
  `$("v1")` simultaneously a texture and a glyph. Keep the namespaces separate.

## Prior art

- **SuperCollider** — the canonical model and the closest to the ask. `Synth(…)` returns a
  server node with an ID; `node.set(\freq, 440)` re-targets it live. The mono idiom
  (`Pmono`) is: the *first* event allocates the node, every later event does `set` instead
  of a new synth, note-off releases the gate and the envelope's release segment runs.
  Pattern events become *setters on a persistent object*. This maps 1:1 onto "a hap that
  addresses an existing glyph re-captures its controls instead of spawning."
- **TidalCycles** — `cut "1"`: a new sample *chokes* whatever else is in cut group 1
  (kill + respawn, no interpolation, no update). `orbit` persists the *effect bus* (the
  reverb tail survives), never the voice. Tidal deliberately has no updatable object;
  `cut` is the cheapest approximation and is candidate A below.
- **Max/MSP `poly~`** — answers "*which* object does this note re-target" head-on: a
  `target n` message routes the next event to voice n; `target 0` auto-allocates the next
  free voice. I.e. voice selection is *data traveling with the event* — an argument for the
  key being a patternable control, not structure.
- **Hydra** — the instructive opposite: `o0–o3` buffers persist *by default*; nothing decays
  unless you blend it away. But a buffer is baked paint — you can't move or re-target what's
  already rendered. Persistence at the *render-target* level answers "trails/feedback"
  (Loom already has `feedback()`, and the MASKING.md bus work is exactly this layer); it
  cannot answer "move the thing." The ask needs a retained *object*, not a retained *image*.
- **Strudel** — inherits `cut`/`legato`/`clip` from Tidal; same shape, nothing new for us.

## Candidate designs

### A. Cut groups — choke + state handoff (the Tidal answer)

`.cut(n)`: each new onset tagged `cut: n` force-releases every live glyph with the same tag
(start their decay now), then spawns normally. Optionally seed the newborn's springs from
the dying glyph's `_spr` so position appears continuous ("pseudo-legato").

- **Enables:** mono-*style* visuals (one thing at a time), cheap — a tag plus ~15 lines in
  `spawn()`. No new lifecycle, no envelope change. Honest Tidal lineage.
- **Breaks / forecloses:** it is still kill-and-respawn. No sustain (the newborn decays like
  any glyph — the held note is still inexpressible). No update semantics: oscs/mods restart,
  the crossfade of old-decaying/new-attacking is visible. State handoff is a hack that only
  covers sprung fields. It answers "one at a time," not "instantiate and *update*."
- Verdict: **not the answer alone**, but worth shipping later as a side verb — once glyphs
  carry an id tag, choke is nearly free, and it's the right tool for *percussive* mono.

### B. Persistent buffers — layer-level persistence (the Hydra answer)

`$("v1", …).persist()`: the layer's render target stops clearing; glyphs bake in.

- **Enables:** infinite trails without `feedback(1)` tricks.
- **Breaks / forecloses:** everything. Baked pixels can't be moved, re-colored, released, or
  addressed — this answers a *different question* (and the bus/masking roadmap already owns
  that territory). It would also silently repeal Loom's decay-by-default identity for a whole
  layer. Rejected; recorded here because it clarifies *why* the object must be retained-mode
  (a particle), not immediate-mode (paint).

### C. Voice objects — identity as a control + a held envelope (the SC answer) ★

Two orthogonal primitives, both renderer-agnostic in `pattern.js` (param-stashing setters,
like the FX verbs), both implemented in the shared clock/particle half of `main.js`:

**1. `.id(key)` — identity travels on the hap.** A hap whose value carries `_objId` makes
`spawn()` an **upsert**: if a live particle is registered under that key, *re-capture its
controls in place* instead of pushing a new particle; otherwise spawn + register. The
registry is `Map key → particle`, unregistered at cull/clear.

**2. `.hold(cond)` — sustain as a live-sampled condition.** `cond` is any signal/pattern/
number (`gate(1)`, `mouseDown`, `ballSeen("a")`, `"<1 0>"`). The envelope gets its own clock:
`p.envAge` advances like `age` but **clamps at `attack` while `cond` is truthy** — attack,
hold-at-1, then the existing decay runs from release. Sampled per-frame per-held-glyph the
same way FX params already are (`evalGlobal`, `main.js:630-641`). `_env` stays the single
output both renderers read, so the change is contained in `tick()`.

**Update semantics come free — they're whatever the control already is.** This is the payoff
of reusing springs instead of inventing an interpolator:

| control is a… | on re-target |
|---|---|
| plain number / string / sampled signal | **snap** (re-frozen at the new onset, as at spawn) |
| `spring(...)` | **glide**: keep `{x, v}`, swap in the new target — momentum, overshoot, settle |
| `osc(...)` | stays **live** (re-frozen params at the new onset; `age` is kept, so the waveform doesn't skip) |

Per-field mixing (snap the size, glide the position) falls out of per-field controls. Nothing
new to design — this is the "reuse springs" answer, and the one missing piece is the
spring-target-signal fix from flavor 1 above (chase `note(1)`).

The mono voice, in full:

```js
$("lead", onNote(1, "circle")
  .id("v1")                            // ONE addressable glyph; each note-on re-targets it
  .x(spring(note(1), 90, 12))          // glide to the new pitch's column, with momentum
  .size(vel(1).range(0.05, 0.18))      // snap: re-frozen per note
  .color(palette("neon").at(pc(1)))
  .hold(gate(1))                       // sustain while any key is down
  .attack(0.05).decay(1.2))            // release = the decay you already know, from note-off
```

And it isn't MIDI-specific — any pattern can drive an object:

```js
shape("dot").fast(8).id("w")
  .x(spring(mouseX, 80, 10)).y(spring(mouseY, 80, 10))   // ONE dot chasing the pointer,
  .hold(1)                                               // not a trail of them
```

**Why identity-as-a-control (not structure, not `$`-names):**
- It survives every combinator for the same reason `_layer`/`_gid` do — it's data on the
  hap value. No per-query minting problem (the `every(4, p => physics(p))` trap above).
- Keys are **user strings, not creation order**, so objects survive a live ⌘↵ *better* than
  gids do: reorder your patch freely, `"v1"` still means the same glyph.
- It's patternable via the normal `.set` path, which buys the poly extension for free:
  `.id("a b c")` round-robins onsets across three voices (poly~'s `target`, expressed as
  mini-notation); `.id(note(1))` keys voices by pitch. Not v1 scope — but the design opens
  it rather than foreclosing it.
- Separate namespace from `$`-layers (which MASKING.md is promoting to texture buses). An
  object still *belongs to* whatever layer/group its latest hap carries — `_layer`, `_gid`,
  `fx` update on re-target like every other field, so mute/solo and group FX just work.

**What C breaks or leaves sharp (the honest list):**
- **`jux` / `superimpose` degenerate on a shared key.** Both copies carry `id("v1")`, both
  upsert the same object each onset; last-in-query-order wins, so `jux` collapses to its
  transformed copy. Rule: same key + same frame = last writer wins (deterministic — stack
  order), and *forking a voice means forking the key*: `jux(p => p.id("v1R"))`. No
  auto-suffixing — silently cloning keys would break the one thing keys are for
  (addressing the same object from two places, e.g. `off(0.125, …)` on a shared id is a
  deliberately *delayed re-target*, which is useful).
- **An id'd glyph can escape the everything-decays invariant.** `.hold(1)` (or a hold
  condition that never releases) lives until the clear button (`main.js:1645-1646`) /
  preset switch (`main.js:1564-1565`). Same escape hatch `.decay(Infinity)` already opens,
  but now it's easy to reach. Mitigation: clear stays the hard reset; consider an editor
  badge for live object count.
- **Soft re-run keeps orphans.** Delete the `id("v1")` line and re-eval: the object stops
  receiving updates but keeps sampling its hold condition (the particle survives ⌘↵ by
  design, `main.js:186-193`). It dies when its hold releases — for `hold(gate(1))` that's
  when you lift the key, which is arguably correct. Patterned keys make compile-time
  orphan detection impossible in general, so don't pretend to it.
- **`physics()` × `.id()` is deferred.** Ownership collision: the sim owns position
  (`main.js:1058-1062`); a re-target would have to teleport or impulse the body. v1:
  `id` inside `physics()` updates non-position controls only, position re-targets are
  ignored (documented). A "kinematic attractor" retarget is a good later cut.
- **`every` / `degrade` / `when` / `gate`: no surprises** — they only decide *which haps
  arrive*, and each arriving hap is one upsert. `every(4, f)` wrapping an id'd pattern is
  **one object** whose params differ on f-cycles — there was never a second object to
  worry about, because identity rides the value, not the combinator tree.
- **Forecloses:** automatic per-branch voice allocation ("each `jux` copy gets its own
  voice implicitly") — that needs structural identity, which this design deliberately
  rejects. If poly-by-structure is ever wanted, it becomes key *templating*, a new pass.

## Recommendation

**C — `.id(key)` upsert + `.hold(cond)`, with springs as the glide mechanic.** It is the
smallest concept because every hard sub-problem maps onto something already built and
verified above: interpolation = springs (swap target, keep state), addressing = hap-borne
tags (the `_layer`/`_gid` mechanism), external ownership precedent = physics bodies,
per-frame condition sampling = `evalGlobal`. The genuinely new things are exactly two:
a key→particle registry with an upsert path in `spawn()`, and a held envelope clock in
`tick()`. A (cut groups) is a good later side-verb, not the answer; B answers a different
question the bus roadmap already owns.

## Phased plan

**Phase 0 — sustain + signal-chasing springs (the real lift, and independently useful).**
✅ **Shipped 2026-07-14.**
1. **`.hold(cond)`** — setter in `pattern.js` (carried raw on the value via `fmap`, NOT
   sampled at onset — freezing a hold would defeat it); in `tick()`, the envelope got its
   own clock: `p.envAge` tracks `age` exactly for ordinary glyphs but parks at `attack`
   while `cond` samples truthy (`evalGlobal`, per frame); `_env` and the cull now read
   `envAge`. `age` keeps advancing (oscs, springs, spin stay continuous). Re-hold
   mid-decay snaps back to full (open question 1 stands). Verified: a `.hold(gate())`
   glyph held 3s past its lifetime at `_env == 1` with `envAge` parked at exactly
   `attack`, released to a clean linear decay, then culled; the default patch and the
   `spring` preset cull identically to before (envAge ≡ age when `hold` is null).
2. **Springs chase signals** — `springTarget()` beside `numAt` samples Pattern targets at
   the current cycle (spawn seed + integrator); `spring()` also reifies mini-notation
   strings (`spring("<0.2 0.8>")`). Verified: `.x(spring(note(), 120, 14))` with
   `.hold(gate())` spawns pinned at 36/127 = 0.2835, glides through 0.547 with live
   velocity on a legato re-target, settles at exactly 96/127 = 0.7559 — the mono glide.

**Phase 1 — identity.**
3. **`.id(key)`** setter (`.set('id', …)` — patternable for free) + `Map key → particle` +
   the upsert branch in `spawn()`. **The risky part, named:** the re-capture merge. `spawn()`
   is the most load-bearing function in `main.js` (`main.js:257-344`); the upsert must
   re-run its capture against the existing particle, preserving `{spring x,v}`, `body`,
   `age`, replacing `pin`/mods (re-frozen at the new onset)/static fields/`gid`/`layer`/
   envelope params, seeding a *newly-sprung* field from its current static value (glide
   from where it was), and recomputing `posLive`. Factor the capture so spawn and upsert
   share it, or they will drift. Registry cleanup at cull + `clearParticles()` — the same
   discipline as physics bodies, same orphan hazard if missed.
4. Default re-target does **not** retrigger the envelope (pure legato — the motion is the
   articulation). `.retrig(1)` opt-in: reset `envAge` to re-run attack *from the current
   env value* (no flash to zero).

**Phase 2 — the verbs that fall out.**
5. `.cut(n)` choke (candidate A, now ~free: force-release by tag in the upsert path).
6. Patterned keys blessed + documented: `.id("a b c")` round-robin poly, `.id(note(1))`
   pitch-keyed voices.
7. REFERENCE.md section + a `voice` preset (the mono lead above); editor live-badge for
   object count if orphans prove confusing in practice.

**Deferred:** physics re-target (kinematic attractor), structural/per-branch voice
allocation, release-shape verbs (`.release(t, curve)` distinct from decay — today decay
*is* the release, which is probably right).

## Open questions

1. **Re-arm shape** (Phase 0): snap `envAge` back to attack on re-hold, or a short re-attack
   ramp? Proposal: snap for v1, listen for complaints.
2. **`hold` + no `id`:** allowed (any glyph can sustain)? Proposal: yes — it's independently
   useful (`shape("ring").hold(mouseDown)`) and costs nothing extra.
3. **Collision rule confirmation:** same key written from two stacked layers = last writer
   wins, whole-hap (no per-field merge). OK as a documented constraint?
4. **Does `.id()` imply `.hold`?** No in this proposal — an un-held object re-targets while
   it decays, and dies if notes stop coming (which is a nice "voice steals fade" behavior).
   Confirm that separation feels right.
