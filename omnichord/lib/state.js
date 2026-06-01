// Shared mutable state. ES modules can't reassign an imported binding, so every
// scalar that gets reassigned lives as a field on `state`; the objects/arrays
// below are mutated in place and shared by reference.
export const state = {
  freeMode: false,
  omniMode: false,            // authentic Suzuki OM-108 chord palette (mutually exclusive with freeMode)
  keyRoot: 0,                 // 0..11
  scaleName: "Major Pentatonic",
  currentDegree: 1,
  currentExt: 0,              // 0=triad 1=+7th 2=+9th 3=+11th (picked on the chord palette)
  omniRootIdx: 5,             // index into OMNI_ROOT_PC — 5 = C (Omnichord layout)
  omniQual: 0,                // 0=major 1=minor 2=7th
  lockChord: false,           // freeze chord so the palette ignores pinches
  muted: false,               // M toggles master to silence without touching the volume slider
  cPinchOn: false,            // chord-hand hysteretic pinch
  singleSide: "right",        // which side a lone hand last committed to (hysteretic)
  editMode: false,            // E / "Move panels": pinch-drag panels instead of playing
  twoHandGrab: null,          // pane being resized with both hands
  editWasActive: false,       // a grab/resize was live last frame → save on release
  chordHover: null,           // chord-palette hover cell, per frame
  chordPick: null,            // pick cursor, per frame
  drag: null,                 // mouse drag of a region (move/resize)
  hoverTarget: null,
  hoverEdge: "",
  lastTs: -1,
  started: false,             // gate detection/playing until "Enable sound"
  camStarted: false,
};

export const cfg = { orientation:"horizontal", baseOctave:3, octavesChord:3, octavesFree:3, colsChord:1, colsFree:4, layoutChord:"oct", layoutFree:"4th", extRows:3,
              reverb:0.10, delayWet:0.14, delayTime:0.28, delayFb:0.22,
              voiceChord:"Keys", voiceFreeL:"Keys", voiceFreeR:"Pad" };   // voices are per-mode

// ---------- Regions (fraction of screen) — chord palette + strum plate ----------
export const regions = {
  chord:     { x0:0.05, x1:0.33, y0:0.16, y1:0.90 },  // left: pinch a chord (chord mode)
  strum:     { x0:0.55, x1:0.95, y0:0.16, y1:0.90 },  // right: pinch + sweep (chord mode)
  strumFree: { x0:0.13, x1:0.95, y0:0.16, y1:0.90 },  // right edge matches chord-mode strum so the switch only grows leftward
};
export const CHORD = regions.chord;                   // chord palette (mutated in place)

// independent per-hand strum state — slot 0 is the primary (right) hand,
// slot 1 is the second hand that also plays in free-scale mode
export const strumState = [
  { smx:null, smy:null, psmx:null, psmy:null, spd:0, pinchOn:false, lastIdx:-1, mono:null, monoVoice:null, monoMidi:null },
  { smx:null, smy:null, psmx:null, psmy:null, spd:0, pinchOn:false, lastIdx:-1, mono:null, monoVoice:null, monoMidi:null },
];
export const editState = [             // per-hand pinch + grab state for editing panels
  { pinchOn:false, prevOn:false, grab:null, lastmx:0, lastmy:0 },
  { pinchOn:false, prevOn:false, grab:null, lastmx:0, lastmy:0 },
];
export const flash = {};               // cell idx -> last trigger time (ms)
