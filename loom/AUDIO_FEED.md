# Loom — Link Audio feed (per-track DSP → signals)

Status: **Loom side built** (signals + injector); **native bridge = TODO** (separate app).

Loom reacts to Ableton's **Link Audio** multitrack streams (Live 12.4+) the same way it reacts to
the juggling rig: a **separate local bridge** does the heavy lifting and pushes plain JSON over a
**WebSocket**; Loom just consumes it as signals. Two halves:

- **Bridge (native, not built here):** receives the Link Audio streams, runs cheap per-track DSP
  (RMS level + FFT bands + transient/onset), emits the JSON below. See "Bridge" at the bottom.
- **Loom (built):** `pattern.js` `_audio` state + `_audioInput(msg)` + `_audioDecay(dt)`; the
  signals `level / band / low / mid / high / hit`. `window.loom.audio(msg)` injects for testing.

This is the **third native channel**: WS = *what each track sounds like*, next to MIDI (*what the
music does*) and the juggling WS (*where the ball is*). Off by default; local-only.

## WebSocket contract

Read-only from Loom's side. The bridge serves a WS (suggested `ws://localhost:8090/audio`) and
sends newline-free JSON frames. Two message types; unknown types are ignored (forward-compatible).

**Per-frame level + bands** (send ~30–60 Hz, one message covering all tracks):
```json
{ "type": "tracks",
  "tracks": {
    "0":    { "level": 0.42, "bands": [0.8, 0.5, 0.3, 0.1] },
    "bass": { "level": 0.71, "bands": [0.9, 0.2, 0.05, 0.0] }
  } }
```
- `id` (the key) = the join key: a **track index** (`"0"`, `"1"`, …) or a **name** (`"bass"`) if
  the bridge knows it from Link Audio metadata. Loom lowercases it.
- `level` = RMS loudness, **0..1** (bridge normalises; e.g. map −60..0 dBFS → 0..1).
- `bands` = FFT magnitudes, **0..1 each**, low→high. Any length N (Loom clamps `band(id,n)`); the
  `low/mid/high` helpers average the lower/middle/upper thirds, so N≥3 is nice. 8 is a good default.

**Transient / onset** (send per detected hit; Loom flashes it to 1 and decays ~0.4 s):
```json
{ "type": "hit", "track": "0", "strength": 0.9 }
```
`strength` 0..1 (default 1). `"type":"onset"` is accepted as an alias.

## Loom signals (in patches)

| signal | is | range |
| --- | --- | --- |
| `level(id)` | track loudness (RMS) | `0..1` |
| `band(id, n)` | the n-th FFT band (0 = lowest), clamped to what the bridge sends | `0..1` |
| `low(id)` / `mid(id)` / `high(id)` | coarse thirds of the bands — bass / body / air | `0..1` |
| `hit(id)` | a transient as a decaying pulse (a flash on each beat) | `0..1` |

`id` = the track index/name from the feed. Frozen at a glyph's onset (spawn on the beat) or read
live as an FX/physics param — same rule as the pointer/MIDI/juggling signals. Examples:
```js
shape("dot*16").size(level("bass").range(0.02, 0.2))        // bass drives size, live
physics(shape("star*4"), { gravity: low(0).range(-1, 2) }) // kick pumps gravity
shape("ring").size(hit("drums").range(0.05, 0.3)).decay(0.4) // ring flashes on each drum hit
.color(palette("neon").at(high(0)))                         // hi-hats/air pick the hue
```

## Bridge — scaffolded at `~/Code/link-audio-bridge`

A headless **openFrameworks** bridge scaffold now exists (separate repo, like `juggling-system`):
subscribes to N named Link Audio channels (`ofxAbletonLinkAudio`), per-track RMS + FFT + onset,
broadcasts this exact JSON over `ws://localhost:8090`. **Not yet compiled/tested** — needs the oF
toolchain + Void addon + Live 12.4; risk spots (esp. the per-stream `setInput` for multitrack) are
in its README. Verified there's **no Node/Python binding** for Link Audio, so oF is the cleanest
cli-forward host. Background below.

Link Audio has **no browser/Web Audio implementation** — it needs a native host. The open-source
**VoidLinkAudio** brings Link Audio to **Max/MSP, Pd, VCV Rack, TouchDesigner, openFrameworks, and
plug-ins**. Pick one as the bridge host:
- **Max/MSP** (likely fastest): VoidLinkAudio external → `[fft~]`/`[sigmund~]`/`[peakamp~]` per
  track → format the JSON → a WS/OSC send out. Least code.
- **openFrameworks / a small native app**: VoidLinkAudio + a FFT (ofxFft/kissfft) + a WS server
  (e.g. µWebSockets). Most control; matches how `~/Code/juggling-system` is structured.

The bridge owns: receiving streams, RMS + FFT + onset detection, normalisation to 0..1, and the WS
server. Keep it a **separate repo** (like the juggling system) so Loom stays a pure consumer.
Licensing note: Ableton Link core is GPLv2+/proprietary; a standalone bridge forwarding data over
WS keeps Loom independent of it.

## Wiring the live socket into Loom (small, when the bridge exists)

Mirror the juggling feed's `feedConnect()` in `main.js`: an opt-in WS client (off by default,
enabled via `?audio` / `window.loom.audioFeed.enabled`) that pipes `onmessage → DSL._audioInput`.
Until then, everything above is testable with `window.loom.audio({...})`.
