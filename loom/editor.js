// editor.js — the Loom code editor on CodeMirror 6. Replaces the old <textarea> + <pre>
// regex-highlight overlay, keeping the same Loom-specific token colours (functions /
// signals / methods / controls), the floating-over-canvas look, ⌘↵ to run, tab-inserts-
// spaces, line wrapping, and undo/redo. main.js drives it through a small API
// (getCode / setCode / insert / focus / hasFocus) so the rest of the app is unchanged.
//
// Phase 2 (inline slider widgets) builds on this — it just adds decorations + a parser.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, Decoration, ViewPlugin, WidgetType, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { Tag } from '@lezer/highlight';
import { autocompletion } from '@codemirror/autocomplete';

// ── Loom vocabulary (highlight only — kept in sync with the DSL) ──
const FN = new Set(['shape', 's', 'n', 'polygon', 'polyline', 'stack', 'cat', 'slowcat', 'fastcat', 'seq', 'sequence', 'timecat',
  'pure', 'silence', 'run', 'range', 'mini', 'euclid', 'fast', 'slow', 'rev', 'choose', 'irand', 'pick', 'iff', 'osc', 'env',
  'stripes', 'checker',
  'palette', 'bg', 'persp', 'cam', 'group', 'echo', 'spring', 'physics', 'slider', 'cc', 'gate', 'vel', 'note', 'pc', 'bend', 'onNote', 'dev',
  'ballX', 'ballY', 'ballSeen', 'moving', 'thrown', 'caught', 'tapped', 'held', 'shaken', 'flight', 'gyro',
  'fingerX', 'fingerY', 'fingerZ', 'fingerUp', 'fingersUp', 'pinch', 'palmX', 'palmY', 'handSeen', 'handNear', 'poseX', 'poseY', 'poseSeen',
  'mouthOpen', 'smile', 'browRaise', 'mouthX', 'mouthY', 'faceX', 'faceY', 'faceSeen',
  'mic', 'micLow', 'micMid', 'micHigh', 'micBand', 'micHit',
  'text', 'spoken', 'said', 'spoke', 'saying', 'heard',
  'level', 'band', 'low', 'mid', 'high', 'hit', '$']);
const SIG = new Set(['sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'rand', 'perlin', 'fbm', 'brown',
  'gauss', 'white', 'mouseX', 'mouseY', 'mouseDown']);
const METHOD = new Set(['fast', 'slow', 'rev', 'every', 'iter', 'palindrome', 'jux', 'superimpose', 'off',
  'degrade', 'degradeBy', 'unDegradeBy', 'sometimes', 'sometimesBy', 'often', 'rarely', 'when', 'gate', 'early', 'late', 'burst',
  'range', 'add', 'sub', 'mul', 'div', 'color', 'size', 'x', 'y', 'radius', 'angle', 'grid', 'rotate',
  'rotateX', 'rotateY', 'spin', 'blend', 'alpha', 'opacity', 'pan', 'jitter', 'fill', 'stroke', 'weight',
  'outline', 'shade', 'pixelate', 'blur', 'glow', 'meshfill', 'radiance', 'feedback', 'trails', 'silhouette', 'hue', 'brightness', 'contrast', 'saturate',
  'negative', 'invert', 'displace', 'kaleido', 'mirror', 'cap', 'join', 'open', 'vertex', 'attack', 'decay',
  'life', 'hold', 'id', 'n', 'stencil', 'set', 'spread', 'phase', 'rate', 'quantize', 'ease', 'segment', 'seg', 'sample', 'spring']);

// ── autocomplete ────────────────────────────────────────────────────────────────
// The API is wide enough that remembering it is the main friction, so completion
// doubles as inline docs: each entry carries a one-line description. Three contexts —
// a bare word (sources / signals / free functions), after a dot (controls + FX), and
// INSIDE a string where the argument set is known (shape names, palettes, curves…).
const C_FN = [
  ['shape', 'a glyph per token — shape("circle*8")'], ['s', 'alias for shape'],
  ['n', 'numbered dots'], ['stack', 'layer patterns in parallel'],
  ['cat', 'one pattern per cycle'], ['seq', 'squeeze patterns into one cycle'],
  ['run', 'numeric pattern 0..k-1'], ['pure', 'one event per cycle'], ['silence', 'nothing'],
  ['euclid', 'euclidean rhythm: euclid(3, 8, pat)'], ['polygon', 'one glyph through N points'],
  ['polyline', 'open polygon'], ['choose', 'random pick per onset'], ['irand', 'random int 0..k-1'],
  ['pick', 'index a list by a 0..1 signal'], ['iff', 'branch on a condition'],
  ['osc', 'live oscillator over a glyph\'s life — osc(rate, shape)'],
  ['env', 'attack/decay envelope as a signal'], ['spring', 'stateful chase toward a target'],
  ['palette', 'colour ramp — palette("neon").at(saw)'], ['bg', 'background colour (patternable)'],
  ['persp', '3D-tilt camera; persp(0) = orthographic'], ['cam', 'webcam behind the glyphs'],
  ['group', 'render a layer to its own buffer for FX'], ['echo', 'accumulate layers on re-run'],
  ['physics', 'rapier2d bodies — physics(pat, opts)'], ['slider', 'inline draggable number'],
  ['stripes', '0/1 bands n times per cycle'], ['checker', 'chessboard over .grid() cells'],
  ['text', 'draw WORDS — text("hold my beer") is three glyphs'],
  ['$', 'named layer — $("name", pattern)'],
];
const C_SIG = [
  ['sine', '0..1 sine'], ['cosine', '0..1 cosine'], ['saw', '0..1 ramp'], ['isaw', 'reverse ramp'],
  ['tri', 'triangle'], ['square', 'hard 0/1'], ['rand', 'white noise'], ['perlin', 'smooth noise'],
  ['fbm', 'fractal noise'], ['brown', 'slow wander'], ['gauss', 'bell around 0.5'],
  ['mouseX', 'pointer x'], ['mouseY', 'pointer y'], ['mouseDown', '1 while pressed'],
  ['cc', 'MIDI CC — cc(num, ch)'], ['gate', '1 while a note is held'], ['vel', 'note velocity'],
  ['note', 'note pitch 0..1'], ['pc', 'pitch class (octave-independent)'], ['bend', 'pitch bend'],
  ['onNote', 'one glyph per note-on — onNote(ch, shape)'], ['dev', 'scope MIDI to one device'],
  ['mic', 'microphone loudness'], ['micLow', 'mic bass'], ['micMid', 'mic body'], ['micHigh', 'mic air'],
  ['micBand', 'one of 24 FFT bands'], ['micHit', 'mic transient pulse'],
  ['spoken', 'a glyph per SPOKEN WORD, drawn as that word'], ['said', 'pulse when you say that word'],
  ['spoke', 'pulse on any spoken word'], ['saying', '1 while you are making sound'],
  ['heard', 'how many words so far this run'],
  ['mouthOpen', 'jaw open 0..1 (singing)'], ['smile', 'grin 0..1'], ['browRaise', 'eyebrows 0..1'],
  ['mouthX', 'mouth x'], ['mouthY', 'mouth y'], ['faceX', 'nose x'], ['faceY', 'nose y'], ['faceSeen', 'face tracked'],
  ['fingerX', 'fingertip x — fingerX(0..4)'], ['fingerY', 'fingertip y'], ['fingerZ', 'fingertip depth'],
  ['fingerUp', '1 while that finger is extended'], ['fingersUp', 'how many fingers are out'],
  ['pinch', 'thumb↔index closeness'], ['palmX', 'palm x'], ['palmY', 'palm y'],
  ['handSeen', 'hand tracked'], ['handNear', 'hand distance proxy'],
  ['poseX', 'body joint x — poseX("nose")'], ['poseY', 'body joint y'], ['poseSeen', 'person tracked'],
  ['ballX', 'juggling ball x'], ['ballY', 'juggling ball y'], ['ballSeen', 'ball detected'],
  ['moving', 'ball seen and moving'], ['thrown', 'throw pulse'], ['caught', 'catch pulse'],
  ['tapped', 'tap pulse'], ['held', 'ball held still'], ['shaken', 'shake pulse'],
  ['flight', 'last airtime'], ['gyro', 'ball spin'],
  ['level', 'Link Audio track level'], ['band', 'Link Audio FFT band'], ['low', 'track bass'],
  ['mid', 'track body'], ['high', 'track air'], ['hit', 'track transient'],
];
const C_METHOD = [
  ['color', 'colour: hex, name, 0..1 hue, or palette'], ['size', 'radius 0..1'],
  ['x', 'centre x 0..1'], ['y', 'centre y 0..1'], ['radius', 'polar offset from centre'],
  ['angle', 'orbital position (turns)'], ['grid', 'lay events into cols×rows'],
  ['rotate', 'z rotation (turns)'], ['rotateX', '3D tilt'], ['rotateY', '3D tilt'],
  ['spin', 'continuous rotation (turns/sec)'], ['alpha', 'opacity'], ['opacity', 'alias for alpha'],
  ['blend', '"lighter" | "screen" | "multiply"'], ['jitter', 'random scatter'], ['pan', 'x shift'],
  ['fill', 'filled 0/1'], ['stroke', 'outlined 0/1'], ['weight', 'stroke width'],
  ['outline', 'stroke as a fraction of radius'], ['shade', '3D shading amount'],
  ['open', 'arc/line gap'], ['vertex', 'dot at each vertex'], ['cap', 'line ends'], ['join', 'corners'],
  ['attack', 'fade-in seconds'], ['decay', 'fade-out / lifetime'], ['life', 'alias for decay'],
  ['hold', 'SUSTAIN while a condition is true — .hold(gate(1))'],
  ['id', 'ONE addressable object; later onsets re-target it'],
  ['n', 'pick a drawn pack frame (patternable)'], ['stencil', '1 = recolour by luminance'],
  ['burst', 'n simultaneous copies, phases fanned'],
  ['fast', 'speed up'], ['slow', 'slow down'], ['rev', 'reverse each cycle'],
  ['every', 'apply f every n-th cycle'], ['iter', 'rotate by 1/n each cycle'],
  ['palindrome', 'alternate forward/reversed'], ['jux', 'copy panned apart'],
  ['superimpose', 'overlay a transformed copy'], ['off', 'overlay a delayed copy'],
  ['degrade', 'drop ~half the events'], ['degradeBy', 'drop a fraction'],
  ['sometimes', 'apply f to a random share'], ['often', '75% of events'], ['rarely', '25%'],
  ['when', 'apply f where a condition holds'], ['gate', 'keep events where a condition holds'],
  ['early', 'shift earlier'], ['late', 'shift later'], ['range', 'remap a 0..1 signal'],
  ['add', 'arithmetic'], ['sub', 'arithmetic'], ['mul', 'arithmetic'], ['div', 'arithmetic'],
  ['quantize', 'snap the VALUE to n steps'], ['segment', 'snap the TIME to n steps'],
  ['sample', 'sample-and-hold a live signal'], ['ease', 'shape a 0..1 signal through a curve'],
  ['spread', 'per-glyph osc phase offset'], ['phase', 'osc phase'], ['rate', 'osc rate'],
  ['drift', 'osc phase drift over time'], ['free', 'osc in real seconds, not cycles'],
  ['spring', 'chase this value with a damped spring'],
  // group FX
  ['pixelate', 'FX: mosaic'], ['blur', 'FX: gaussian blur'], ['glow', 'FX: light bleeds from content'],
  ['meshfill', 'FX: mesh gradient from the glyphs'], ['radiance', 'FX: 2D GI with shadows'],
  ['feedback', 'FX: trails/tunnel (4th arg = effects INSIDE the loop)'],
  ['trails', 'FX: feedback, no warp'], ['silhouette', 'FX: mask by the person in the webcam'],
  ['hue', 'FX: rotate hue'], ['brightness', 'FX'], ['contrast', 'FX'], ['saturate', 'FX'],
  ['negative', 'FX: invert'], ['invert', 'FX: invert'], ['displace', 'FX: warp'],
  ['kaleido', 'FX: mirrored wedges'], ['mirror', 'FX: left/right symmetry'], ['tile', 'FX: repeat'],
  ['dots', 'FX: halftone'], ['halftone', 'FX: halftone'], ['rgbshift', 'FX: prism split'],
  ['posterize', 'FX: quantize colours'], ['dither', 'FX: ordered dither'],
  ['scanlines', 'FX: CRT lines'], ['slice', 'FX: offset bands'], ['lens', 'FX: barrel distortion'],
  ['scale', 'FX: zoom the layer'], ['move', 'FX: translate the layer'], ['turn', 'FX: rotate the layer'],
  ['aspect', 'FX: crop to a ratio'], ['hidden', 'render to a buffer but do not composite'],
];
const SHAPE_NAMES = ['dot', 'circle', 'ring', 'arc', 'square', 'box', 'tri', 'pent', 'hex', 'star',
  'plus', 'line', 'cross', 'cube', 'sphere', 'torus', 'hoop', 'octa',
  'bong', 'knot', 'amongus', 'balloons', 'chain'];
const PALETTE_NAMES = ['sunset', 'ember', 'ice', 'neon', 'forest', 'candy', 'mono', 'rainbow', 'aurora'];
const EASE_NAMES = ['linear', 'inSine', 'outSine', 'inOutSine', 'inQuad', 'outQuad', 'inOutQuad',
  'inCubic', 'outCubic', 'inOutCubic', 'inQuart', 'outQuart', 'inOutQuart', 'inExpo', 'outExpo',
  'inOutExpo', 'inBack', 'outBack', 'inOutBack', 'inElastic', 'outElastic', 'inOutElastic',
  'inBounce', 'outBounce', 'inOutBounce'];
const opt = (list, type) => list.map(([label, detail]) => ({ label, type, detail }));
const words = (list, type, detail) => list.map((label) => ({ label, type, detail }));

// argument sets that only make sense inside a particular call's string
const STRING_ARGS = [
  [/\b(?:shape|s)\s*\(\s*"[^"]*$/, words(SHAPE_NAMES, 'constant', 'shape')],
  [/\bpalette\s*\(\s*"[^"]*$/, words(PALETTE_NAMES, 'constant', 'palette')],
  [/\.ease\s*\(\s*"[^"]*$/, words(EASE_NAMES, 'constant', 'curve')],
  [/\.blend\s*\(\s*"[^"]*$/, words(['source-over', 'lighter', 'screen', 'multiply'], 'constant', 'blend')],
  [/\.cap\s*\(\s*"[^"]*$/, words(['round', 'butt', 'square'], 'constant', 'cap')],
  [/\.join\s*\(\s*"[^"]*$/, words(['round', 'miter', 'bevel'], 'constant', 'join')],
  [/\bposeX?Y?\s*\(\s*"[^"]*$/, words(['nose', 'lshoulder', 'rshoulder', 'lelbow', 'relbow',
    'lwrist', 'rwrist', 'lhip', 'rhip', 'lknee', 'rknee', 'lankle', 'rankle'], 'constant', 'joint')],
];

function loomComplete(ctx) {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 160), ctx.pos);
  for (const [re, options] of STRING_ARGS) {                 // inside a known string arg
    if (re.test(before)) {
      const w = ctx.matchBefore(/[\w-]*/);
      return { from: w ? w.from : ctx.pos, options, validFor: /^[\w-]*$/ };
    }
  }
  const dot = ctx.matchBefore(/\.\w*/);                      // .method / .control / FX
  if (dot) return { from: dot.from + 1, options: opt(C_METHOD, 'method'), validFor: /^\w*$/ };
  const word = ctx.matchBefore(/\w+/);                       // a bare identifier
  if (!word && !ctx.explicit) return null;
  return { from: word ? word.from : ctx.pos,
    options: [...opt(C_FN, 'function'), ...opt(C_SIG, 'variable')], validFor: /^\w*$/ };
}

// one custom highlight tag per Loom token class
const T = {
  fn: Tag.define(), sig: Tag.define(), method: Tag.define(), ctrl: Tag.define(),
  str: Tag.define(), num: Tag.define(), com: Tag.define(), punct: Tag.define(),
};

// a stream tokenizer mirroring the old regex classOf(): comments, strings, numbers,
// .method vs .control, signal / function identifiers, punctuation.
const loomLang = StreamLanguage.define({
  startState() { return { block: false }; },
  token(stream, state) {
    if (state.block) {                                   // inside /* … */
      if (stream.match(/^.*?\*\//)) state.block = false; else stream.skipToEnd();
      return 'com';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'com'; }
    if (stream.match('/*')) { if (!stream.match(/^.*?\*\//)) { state.block = true; stream.skipToEnd(); } return 'com'; }
    const ch = stream.peek();
    if (ch === '"' || ch === "'" || ch === '`') {        // string (with escapes)
      stream.next();
      let esc = false;
      while (!stream.eol()) { const c = stream.next(); if (esc) { esc = false; continue; } if (c === '\\') esc = true; else if (c === ch) break; }
      return 'str';
    }
    if (/\d/.test(ch)) { stream.match(/^\d+(?:\.\d+)?/); return 'num'; }
    if (ch === '.') {                                    // .method / .control / plain dot
      stream.next();
      const m = stream.match(/^[A-Za-z_$][\w$]*/);
      if (m) return METHOD.has(m[0]) ? 'ctrl' : 'method';
      return 'punct';
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const w = stream.match(/^[A-Za-z_$][\w$]*/)[0];
      return SIG.has(w) ? 'sig' : FN.has(w) ? 'fn' : null;
    }
    if ('(){}[],'.includes(ch)) { stream.next(); return 'punct'; }
    stream.next();
    return null;
  },
  tokenTable: { fn: T.fn, sig: T.sig, method: T.method, ctrl: T.ctrl, str: T.str, num: T.num, com: T.com, punct: T.punct },
  languageData: { commentTokens: { line: '//' } },        // ⌘/ toggles line comments
});

// map the tags → the same CSS-variable colours the old highlighter used
const loomHighlight = HighlightStyle.define([
  { tag: T.fn, color: 'var(--t-fn)' },
  { tag: T.sig, color: 'var(--t-sig)' },
  { tag: T.method, color: 'var(--t-method)' },
  { tag: T.ctrl, color: 'var(--t-ctrl)' },
  { tag: T.str, color: 'var(--t-str)' },
  { tag: T.num, color: 'var(--t-num)' },
  { tag: T.com, color: 'var(--t-com)', fontStyle: 'italic' },
  { tag: T.punct, color: 'var(--t-punct)' },
]);

// the floating-over-canvas theme: transparent background, the mono font + metrics from the
// old #code rule, a dark text-shadow halo for legibility over busy art (the CM analog of the
// old per-line hugging box, which doesn't map to CM's block lines while wrapping).
const loomTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '15px', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '0', letterSpacing: '.01em', caretColor: '#ffd166', caretWidth: '2px' },
  // per-line dark box that hugs the text (fit-content → ragged right), so the canvas stays
  // visible around the code instead of a full-panel wash. Square corners (no radius) — the
  // rounded ones scalloped the aligned left edge and clashed with the app's sharp chrome.
  '.cm-line': {
    // no LEFT margin: the box's left edge lands on the rail's 22px content column (brand /
    // transport / footer all sit there) instead of 8px inside it. right margin stays for breathing.
    padding: '0 8px', margin: '0 8px 0 0', width: 'fit-content', maxWidth: 'calc(100% - 8px)',
    backgroundColor: 'rgba(7,8,11,.42)',   // the per-line box carries legibility; no text-shadow (it muddied the glyphs)
  },
  '.cm-activeLine': { backgroundColor: 'rgba(14,17,26,.72)' },          // current line: a DARK backing so its text reads even over a white bg() patch (was a washed-out translucent blue)
  // Selection is the NATIVE browser selection (no drawSelection layer) — it highlights the text
  // glyphs inline, so the text stays visible and it layers correctly over the per-line box
  // (a drawSelection layer either hid behind the box = "opaque", or above the text = hid it).
  // Styled in index.html via ::selection. Caret is the native bright caret (caretColor above).
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,.10)' },
  // inline slider widget (after a slider(...) call) — detailed track/thumb styling in index.html
  '.cm-loom-slider': { display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', margin: '0 2px 0 5px' },
  // live-signal badge (after mouseX / mouseY / mouseDown)
  '.cm-loom-live': {
    display: 'inline-block', verticalAlign: 'middle', margin: '0 1px 0 4px', padding: '0 5px',
    font: '500 11px/1.5 var(--mono)', color: 'var(--t-sig)', background: 'rgba(181,140,255,.14)',
    border: '1px solid rgba(181,140,255,.3)', borderRadius: '999px', minWidth: '1.6em', textAlign: 'center',
    textShadow: 'none',                                  // the badge has its own bg — the line's shadow just muddies it
    userSelect: 'none', WebkitUserSelect: 'none',        // the live value is a readout, not text you should select/copy
  },
  '.cm-loom-live-t': { transition: 'color .18s ease' },  // fade the contrast flip, like the smoothed bg
  '.cm-loom-live-bool': { position: 'relative', top: '-1px', display: 'inline-block' },  // ●/○ ink sits ~1px low
}, { dark: true });

// ── inline slider widgets ───────────────────────────────────────────────────────────
// A `slider(value, min?, max?, default?)` call in the source renders an inline draggable
// slider after it; dragging rewrites `value` in the source and re-runs (the Strudel idea). At
// commit time we re-find THIS slider by the widget's current DOM position (not a captured
// ordinal), so it never links to a sibling when the doc shifts. `default` (4th arg) is the
// double-click reset target — a stable home value that survives dragging (which clobbers
// `value`); without it, double-click resets to the mid-range.
const NUM = /^\s*(-?\d*\.?\d+)/;
function scanSliders(text) {
  const out = [];
  const re = /\bslider\s*\(/g; let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    const a = NUM.exec(text.slice(i));
    if (!a) continue;
    const argFrom = i + (a[0].length - a[1].length), argTo = i + a[0].length;
    let j = argTo, nums = [];
    for (let k = 0; k < 3; k++) {                          // up to three more numeric args (min, max, default)
      const c = /^\s*,\s*(-?\d*\.?\d+)/.exec(text.slice(j));
      if (!c) break; nums.push(parseFloat(c[1])); j += c[0].length;
    }
    const close = text.indexOf(')', j);
    if (close < 0) continue;
    // 1 arg → 0..1 · 2 args → 0..max · 3+ args → min..max · 4th arg → reset default
    const min = nums.length >= 2 ? nums[0] : 0;
    const max = nums.length >= 2 ? nums[1] : nums.length === 1 ? nums[0] : 1;
    const def = nums.length >= 3 ? nums[2] : (min + max) / 2;
    out.push({ argFrom, argTo, val: parseFloat(a[1]), min, max, def, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}
const niceStep = (min, max) => { const r = Math.abs(max - min) || 1; return r <= 2 ? 0.01 : r <= 20 ? 0.1 : r <= 200 ? 1 : 10; };
const stepDecimals = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
// format to the step's decimal count, KEEPING trailing zeros — a fixed-width number so the
// inline slider doesn't jitter/reflow as you drag (0.30 → 0.45, not 0.3 → 0.45).
const fmtNum = (v, step) => v.toFixed(stepDecimals(step));
// each slider gets a DISTINCT solid colour (rotating hues) so you can tell several apart at a
// glance. OKLCH keeps every hue at the same perceived lightness/chroma (unlike HSL).
const SLIDER_HUES = [265, 200, 150, 95, 45, 330, 25, 175];
const sliderColor = (i) => `oklch(0.74 0.15 ${SLIDER_HUES[((i % SLIDER_HUES.length) + SLIDER_HUES.length) % SLIDER_HUES.length]})`;

class SliderWidget extends WidgetType {
  constructor(val, min, max, def, idx) { super(); this.val = val; this.min = min; this.max = max; this.def = def; this.idx = idx; }
  eq(o) { return o.val === this.val && o.min === this.min && o.max === this.max && o.def === this.def && o.idx === this.idx; }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-loom-slider';
    const input = document.createElement('input');
    const step = niceStep(this.min, this.max);
    input.type = 'range';
    input.min = this.min; input.max = this.max; input.step = step; input.value = this.val;
    input.style.accentColor = sliderColor(this.idx);     // distinct per slider, not value-based
    input.title = `slider ${this.min}…${this.max} — drag / scroll · double-click → ${this.def}`;
    const commit = (v) => {
      // re-find THIS slider by the widget's CURRENT doc position — robust to sibling edits
      const pos = view.posAtDOM(wrap);
      const list = scanSliders(view.state.doc.toString());
      let s = null, best = Infinity;
      for (const c of list) { const d = Math.abs(c.end - pos); if (d < best) { best = d; s = c; } }
      if (!s) return;
      const cl = Math.max(this.min, Math.min(this.max, v));
      input.value = cl;
      view.dispatch({ changes: { from: s.argFrom, to: s.argTo, insert: fmtNum(cl, step) } });
      if (view.loomRerun) view.loomRerun();
    };
    input.addEventListener('input', () => commit(+input.value));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());  // don't start a CM selection
    input.addEventListener('wheel', (e) => { e.preventDefault(); commit(+input.value + (e.deltaY < 0 ? step : -step)); }, { passive: false });
    input.addEventListener('dblclick', (e) => { e.preventDefault(); commit(this.def); });   // reset to the default (4th arg, or mid-range)
    wrap.appendChild(input);
    return wrap;
  }
  // update in place so the dragged <input> isn't recreated mid-drag (keeps it smooth)
  updateDOM(dom) {
    const input = dom.querySelector('input'); if (!input) return false;
    input.min = this.min; input.max = this.max; input.step = niceStep(this.min, this.max);
    if (+input.value !== this.val) input.value = this.val;
    input.style.accentColor = sliderColor(this.idx);
    return true;
  }
  ignoreEvent() { return true; }
}

function buildSliderDecos(view) {
  const ranges = scanSliders(view.state.doc.toString())
    .map((s, i) => Decoration.widget({ widget: new SliderWidget(s.val, s.min, s.max, s.def, i), side: 1 }).range(s.end));
  return Decoration.set(ranges, true);
}
const sliderPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildSliderDecos(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildSliderDecos(u.view); }
}, { decorations: (v) => v.decorations });

// ── live-signal badges ────────────────────────────────────────────────────────────────
// A tiny readout after each live-input token (pointer, MIDI, juggling), so its value reads at a
// glance while patching. One shared rAF updates them: pointer signals from window.loom.pointer,
// the call-style ones (cc(7,1), vel(1), ballX("a")…) via window.loom.sig(name, …args).
const liveBadges = new Set();
let liveRAF = 0;
const BOOL_SIGS = new Set(['mouseDown', 'gate', 'ballSeen', 'moving', 'fingerUp', 'handSeen', 'poseSeen']);   // shown as ●/○, not a number
function badgeValue(el) {
  const name = el.dataset.sig;
  const L = typeof window !== 'undefined' && window.loom;
  if (name === 'mouseX' || name === 'mouseY' || name === 'mouseDown') {
    const p = (L && window.loom.pointer) || { x: 0.5, y: 0.5, down: 0 };
    return name === 'mouseDown' ? p.down : name === 'mouseX' ? p.x : p.y;
  }
  const v = L && window.loom.sig ? window.loom.sig(name, ...(el._args || [])) : 0;
  return v == null ? 0 : v;
}
function ensureLiveLoop() {
  if (liveRAF) return;
  const tick = () => {
    for (const el of liveBadges) {
      if (!el.isConnected) { liveBadges.delete(el); continue; }
      const v = badgeValue(el);
      // envelope-follow: jump up to peaks instantly, ease down slowly — so a run of notes keeps
      // the badge lit instead of strobing value→0→value at every note-off (vel/note drop to 0).
      el._sv = (el._sv == null || v >= el._sv) ? v : el._sv + (v - el._sv) * 0.08;
      const sv = el._sv;
      el._t.textContent = BOOL_SIGS.has(el.dataset.sig) ? (sv > 0.5 ? '●' : '○') : (+sv).toFixed(2);
      // tint dark → light by magnitude (OKLCH) so it reads at a glance; abs() so bend (−1..1)
      // still lights up. The contrast text colour is on the inner span, which CSS-transitions so
      // it fades across the threshold to match the smoothed background instead of snapping.
      const t = Math.max(0, Math.min(1, Math.abs(sv)));
      const lum = 0.26 + t * 0.62;
      el.style.background = `oklch(${lum.toFixed(3)} 0.07 290)`;
      el.style.borderColor = `oklch(${Math.min(0.96, lum + 0.12).toFixed(3)} 0.09 290)`;
      el._t.style.color = lum > 0.6 ? '#0a0a12' : '#e9e9ea';
    }
    liveRAF = liveBadges.size ? requestAnimationFrame(tick) : 0;
  };
  liveRAF = requestAnimationFrame(tick);
}
class LiveSigWidget extends WidgetType {
  constructor(name, args) { super(); this.name = name; this.args = args || null; this.key = name + (args ? '(' + args.join(',') + ')' : ''); }
  eq(o) { return o.key === this.key; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-loom-live'; el.dataset.sig = this.name; el._args = this.args;
    const t = document.createElement('span');                 // text on its own span: nudgeable + colour transitions
    t.className = 'cm-loom-live-t' + (BOOL_SIGS.has(this.name) ? ' cm-loom-live-bool' : '');
    t.textContent = '·'; el.appendChild(t); el._t = t;
    el.title = `${this.key} — live`;
    liveBadges.add(el); ensureLiveLoop();
    return el;
  }
  destroy(dom) { liveBadges.delete(dom); }
  ignoreEvent() { return true; }
}
// call-style live signals (one arg list, no nested parens — so .gate(ballSeen("a")) won't match)
const CALL_SIGS = 'cc|gate|vel|note|pc|bend|ballX|ballY|ballSeen|moving|thrown|caught|tapped|held|shaken|flight|gyro'
  + '|fingerX|fingerY|fingerZ|fingerUp|fingersUp|pinch|palmX|palmY|handSeen|handNear|poseX|poseY|poseSeen'
  + '|mouthOpen|smile|browRaise|mouthX|mouthY|faceX|faceY|faceSeen|mic|micLow|micMid|micHigh|micBand|micHit';
const callRe = new RegExp('\\b(' + CALL_SIGS + ')\\(([^()]*)\\)', 'g');
const parseArgs = (s) => s.split(',').map((a) => a.trim()).filter(Boolean)
  .map((a) => (/^-?[\d.]+$/.test(a) ? +a : a.replace(/^["']|["']$/g, '')));
function buildLiveDecos(view) {
  const text = view.state.doc.toString(); const ranges = []; let m;
  const ptrRe = /\b(mouseX|mouseY|mouseDown)\b/g;
  while ((m = ptrRe.exec(text))) ranges.push(Decoration.widget({ widget: new LiveSigWidget(m[1]), side: 1 }).range(m.index + m[0].length));
  while ((m = callRe.exec(text))) ranges.push(Decoration.widget({ widget: new LiveSigWidget(m[1], parseArgs(m[2])), side: 1 }).range(m.index + m[0].length));
  return Decoration.set(ranges, true);   // 2nd arg sorts the ranges
}
const liveSigPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildLiveDecos(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildLiveDecos(u.view); }
}, { decorations: (v) => v.decorations });

// Create the editor into `parent`. opts: { doc, onRun, onChange, onFocus, rerun }.
// Returns { view, getCode, setCode, insert, focus, hasFocus }.
export function createEditor(parent, opts = {}) {
  const runKeys = keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => { opts.onRun && opts.onRun(); return true; } },
  ]);
  const listeners = EditorView.updateListener.of((u) => {
    if (u.docChanged && opts.onChange) opts.onChange();
    if (u.focusChanged && opts.onFocus) opts.onFocus(u.view.hasFocus);
  });
  const state = EditorState.create({
    doc: opts.doc || '',
    extensions: [
      history(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      indentUnit.of('  '),                               // Tab inserts 2 spaces (matches the old editor)
      loomLang,
      syntaxHighlighting(loomHighlight),
      loomTheme,
      sliderPlugin,
      liveSigPlugin,
      autocompletion({ override: [loomComplete], activateOnTyping: true, maxRenderedOptions: 30 }),
      runKeys,
      keymap.of([
        indentWithTab,
        { key: 'Mod-/', run: toggleComment },             // ⌘/ toggle line comment
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      listeners,
    ],
  });
  const view = new EditorView({ state, parent });
  view.loomRerun = opts.rerun;   // the inline sliders call this to re-run on drag (no flash)

  const getCode = () => view.state.doc.toString();
  const setCode = (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  const insert = (text) => {
    const sel = view.state.selection.main;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } });
    view.focus();
  };
  return { view, getCode, setCode, insert, focus: () => view.focus(), hasFocus: () => view.hasFocus };
}
