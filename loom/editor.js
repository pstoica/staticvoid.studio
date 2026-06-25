// editor.js — the Loom code editor on CodeMirror 6. Replaces the old <textarea> + <pre>
// regex-highlight overlay, keeping the same Loom-specific token colours (functions /
// signals / methods / controls), the floating-over-canvas look, ⌘↵ to run, tab-inserts-
// spaces, line wrapping, and undo/redo. main.js drives it through a small API
// (getCode / setCode / insert / focus / hasFocus) so the rest of the app is unchanged.
//
// Phase 2 (inline slider widgets) builds on this — it just adds decorations + a parser.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, Decoration, ViewPlugin, WidgetType, highlightActiveLine } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { Tag } from '@lezer/highlight';

// ── Loom vocabulary (highlight only — kept in sync with the DSL) ──
const FN = new Set(['shape', 's', 'n', 'stack', 'cat', 'slowcat', 'fastcat', 'seq', 'sequence', 'timecat',
  'pure', 'silence', 'run', 'range', 'mini', 'euclid', 'fast', 'slow', 'rev', 'choose', 'irand', 'osc',
  'palette', 'bg', 'group', 'echo', 'spring', 'physics', 'slider', '$']);
const SIG = new Set(['sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'rand', 'perlin', 'fbm', 'brown',
  'gauss', 'white', 'mouseX', 'mouseY', 'mouseDown']);
const METHOD = new Set(['fast', 'slow', 'rev', 'every', 'iter', 'palindrome', 'jux', 'superimpose', 'off',
  'degrade', 'degradeBy', 'unDegradeBy', 'sometimes', 'sometimesBy', 'often', 'rarely', 'early', 'late',
  'range', 'add', 'sub', 'mul', 'div', 'color', 'size', 'x', 'y', 'radius', 'angle', 'grid', 'rotate',
  'rotateX', 'rotateY', 'spin', 'blend', 'alpha', 'opacity', 'pan', 'jitter', 'fill', 'stroke', 'weight',
  'outline', 'shade', 'pixelate', 'blur', 'feedback', 'trails', 'hue', 'brightness', 'contrast', 'saturate',
  'negative', 'invert', 'displace', 'kaleido', 'mirror', 'cap', 'join', 'open', 'vertex', 'attack', 'decay',
  'life', 'set', 'spread', 'phase', 'rate', 'quantize', 'ease', 'segment', 'seg', 'spring']);

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
  '.cm-content': { padding: '4px 0', letterSpacing: '.01em', caretColor: 'transparent' },
  // per-line dark box that hugs the text (fit-content → ragged right), so the canvas stays
  // visible around the code instead of a full-panel wash. A faint shadow softens the edge.
  '.cm-line': {
    padding: '0 8px', margin: '0 8px', width: 'fit-content', maxWidth: 'calc(100% - 16px)', borderRadius: '3px',
    backgroundColor: 'rgba(7,8,11,.66)', textShadow: '0 1px 2px rgba(2,3,5,.6)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(36,40,52,.82)' },          // current line, a touch brighter
  // a chunky, bright block-style caret (drawSelection draws it as .cm-cursor)
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffd166', borderLeftWidth: '3px', marginLeft: '-1px' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#ffd166' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(120,150,255,.30)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,.10)' },
  // inline slider widget (after a slider(...) call) — detailed track/thumb styling in index.html
  '.cm-loom-slider': { display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', margin: '0 2px 0 5px' },
  // live-signal badge (after mouseX / mouseY / mouseDown)
  '.cm-loom-live': {
    display: 'inline-block', verticalAlign: 'middle', margin: '0 1px 0 4px', padding: '0 5px',
    font: '500 11px/1.5 var(--mono)', color: 'var(--t-sig)', background: 'rgba(181,140,255,.14)',
    border: '1px solid rgba(181,140,255,.3)', borderRadius: '999px', minWidth: '1.6em', textAlign: 'center',
  },
}, { dark: true });

// ── inline slider widgets ───────────────────────────────────────────────────────────
// A `slider(value, min?, max?)` call in the source renders an inline draggable slider after
// it; dragging rewrites `value` in the source and re-runs (the Strudel idea). We re-find the
// slider by its ordinal each drag so edits never desync from shifting offsets.
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
    for (let k = 0; k < 2; k++) {                          // up to two more numeric args (min/max)
      const c = /^\s*,\s*(-?\d*\.?\d+)/.exec(text.slice(j));
      if (!c) break; nums.push(parseFloat(c[1])); j += c[0].length;
    }
    const close = text.indexOf(')', j);
    if (close < 0) continue;
    // 1 arg → 0..1 · 2 args → 0..max · 3 args → min..max
    const min = nums.length >= 2 ? nums[0] : 0;
    const max = nums.length >= 2 ? nums[1] : nums.length === 1 ? nums[0] : 1;
    out.push({ argFrom, argTo, val: parseFloat(a[1]), min, max, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}
const niceStep = (min, max) => { const r = Math.abs(max - min) || 1; return r <= 2 ? 0.01 : r <= 20 ? 0.1 : r <= 200 ? 1 : 10; };
const stepDecimals = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
// format to the step's decimal count, KEEPING trailing zeros — a fixed-width number so the
// inline slider doesn't jitter/reflow as you drag (0.30 → 0.45, not 0.3 → 0.45).
const fmtNum = (v, step) => v.toFixed(stepDecimals(step));

class SliderWidget extends WidgetType {
  constructor(idx, val, min, max) { super(); this.idx = idx; this.val = val; this.min = min; this.max = max; }
  eq(o) { return o.idx === this.idx && o.val === this.val && o.min === this.min && o.max === this.max; }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-loom-slider';
    const input = document.createElement('input');
    const step = niceStep(this.min, this.max);
    input.type = 'range';
    input.min = this.min; input.max = this.max; input.step = step; input.value = this.val;
    input.title = `slider ${this.min}…${this.max} — drag or scroll`;
    const idx = this.idx;
    const commit = (v) => {
      // re-find THIS slider by ordinal (offsets shift as the value text grows/shrinks)
      const s = scanSliders(view.state.doc.toString())[idx];
      if (!s) return;
      const cl = Math.max(this.min, Math.min(this.max, v));
      input.value = cl;
      view.dispatch({ changes: { from: s.argFrom, to: s.argTo, insert: fmtNum(cl, step) } });
      if (view.loomRerun) view.loomRerun();
    };
    input.addEventListener('input', () => commit(+input.value));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());  // don't start a CM selection
    input.addEventListener('wheel', (e) => { e.preventDefault(); commit(+input.value + (e.deltaY < 0 ? step : -step)); }, { passive: false });
    wrap.appendChild(input);
    return wrap;
  }
  // update in place so the dragged <input> isn't recreated mid-drag (keeps it smooth)
  updateDOM(dom) {
    const input = dom.querySelector('input'); if (!input) return false;
    input.min = this.min; input.max = this.max; input.step = niceStep(this.min, this.max);
    if (+input.value !== this.val) input.value = this.val;
    return true;
  }
  ignoreEvent() { return true; }
}

function buildSliderDecos(view) {
  const sliders = scanSliders(view.state.doc.toString());
  const ranges = sliders.map((s, idx) => Decoration.widget({ widget: new SliderWidget(idx, s.val, s.min, s.max), side: 1 }).range(s.end));
  return Decoration.set(ranges, true);
}
const sliderPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildSliderDecos(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildSliderDecos(u.view); }
}, { decorations: (v) => v.decorations });

// ── live-signal badges (mouseX / mouseY / mouseDown) ──────────────────────────────────
// A tiny readout after each pointer-signal token, so it reads as a LIVE value at a glance
// (handy for debugging / awareness). One shared rAF updates them from window.loom.pointer.
const liveBadges = new Set();
let liveRAF = 0;
function ensureLiveLoop() {
  if (liveRAF) return;
  const tick = () => {
    const p = (typeof window !== 'undefined' && window.loom && window.loom.pointer) || { x: 0.5, y: 0.5, down: 0 };
    for (const el of liveBadges) {
      if (!el.isConnected) { liveBadges.delete(el); continue; }
      const s = el.dataset.sig;
      el.textContent = s === 'mouseDown' ? (p.down ? '●' : '○') : (s === 'mouseX' ? p.x : p.y).toFixed(2);
    }
    liveRAF = liveBadges.size ? requestAnimationFrame(tick) : 0;
  };
  liveRAF = requestAnimationFrame(tick);
}
class LiveSigWidget extends WidgetType {
  constructor(name) { super(); this.name = name; }
  eq(o) { return o.name === this.name; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-loom-live'; el.dataset.sig = this.name; el.textContent = '·';
    el.title = `${this.name} — live`;
    liveBadges.add(el); ensureLiveLoop();
    return el;
  }
  destroy(dom) { liveBadges.delete(dom); }
  ignoreEvent() { return true; }
}
function buildLiveDecos(view) {
  const re = /\b(mouseX|mouseY|mouseDown)\b/g; const text = view.state.doc.toString(); const ranges = []; let m;
  while ((m = re.exec(text))) ranges.push(Decoration.widget({ widget: new LiveSigWidget(m[1]), side: 1 }).range(m.index + m[0].length));
  return Decoration.set(ranges, true);
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
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      indentUnit.of('  '),                               // Tab inserts 2 spaces (matches the old editor)
      loomLang,
      syntaxHighlighting(loomHighlight),
      loomTheme,
      sliderPlugin,
      liveSigPlugin,
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
