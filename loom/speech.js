// speech.js — dictation as Loom events, straight from the browser.
//
// The Web Speech API turns talking into words; Loom turns each word into a glyph
// textured with the word itself (the sprite path already rasterizes any string —
// emoji were just its first customer). Same lazy shape as mic.js / hands.js:
// creating any speech signal in a patch flags it, main.js starts recognition on the
// next run, and everything degrades quietly to nothing if it's unavailable or denied.
//
// Two details make this feel live rather than transcript-y:
//
//   INTERIM WORDS. Waiting for isFinal means a whole phrase lands at once, seconds
//   late. So we emit from interim results as they stream, holding back only the word
//   currently being spoken (the one the recognizer is still revising). You get a glyph
//   per word, roughly as you say it.
//
//   AUTO-RESTART. Recognition stops itself on silence, on its own timeouts, and after
//   errors. A performance can't have speech quietly die three minutes in, so onend
//   restarts as long as the patch still wants it.
//
// Chrome 138+ exposes processLocally + SpeechRecognition.available()/install(): real
// on-device recognition, no audio leaving the machine and no network mid-set. We ask
// for it, fall back to the cloud path when it isn't installed, and kick off the model
// download in the background so the NEXT session is local.

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

let rec = null, want = false, failed = false, restartT = null;
let state = 'off';                 // 'off' | 'starting' | 'live' | 'blocked' | 'unsupported'
let local = false;                 // running on-device?
let lang = 'en-US';

let queue = [];                    // words recognized since the last frame drain
let emitted = 0;                   // words already emitted from the CURRENT utterance
let interim = '';                  // the phrase in progress
let last = '';                     // most recent word
let voicing = 0;                   // 1 between soundstart and soundend

export const speechState = () => state;
export const speechLocal = () => local;

const WORD = /[^\s]+/g;
const clean = (w) => w.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, '');

function push(w) {
  const t = clean(w);
  if (!t) return;
  queue.push(t);
  last = t;
  if (queue.length > 64) queue.shift();      // a stuck consumer must not grow forever
}

// Ask for on-device first. 'downloadable' means it CAN be local but isn't yet — start the
// download for next time and run through the cloud today rather than blocking on it.
async function preferLocal() {
  if (!SR.available) return false;
  try {
    const a = await SR.available({ langs: [lang], processLocally: true });
    if (a === 'available') return true;
    if (a !== 'unavailable' && SR.install) SR.install({ langs: [lang], processLocally: true }).catch(() => {});
  } catch { /* older shape, or the query itself is unsupported */ }
  return false;
}

function build() {
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.lang = lang;
  if (local) { try { r.processLocally = true; } catch {} }

  r.onstart = () => { state = 'live'; };
  r.onsoundstart = () => { voicing = 1; };
  r.onsoundend = () => { voicing = 0; };

  r.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const text = res[0] ? res[0].transcript : '';
      const words = text.match(WORD) || [];
      if (res.isFinal) {
        for (let k = emitted; k < words.length; k++) push(words[k]);
        emitted = 0;                          // next result index starts a new utterance
        interim = '';
      } else {
        interim = text;
        // hold back the last word: it's still being revised as it's spoken
        for (let k = emitted; k < words.length - 1; k++) push(words[k]);
        emitted = Math.max(emitted, words.length - 1);
      }
    }
  };

  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      state = 'blocked'; failed = true; want = false;
    }
    // 'no-speech' / 'aborted' / 'network' are routine — onend restarts
  };

  r.onend = () => {
    emitted = 0; interim = ''; voicing = 0;
    if (!want || failed) { state = failed ? state : 'off'; return; }
    clearTimeout(restartT);
    restartT = setTimeout(() => { try { rec.start(); } catch {} }, 250);
  };

  return r;
}

export function ensureSpeech(l) {
  if (l && l !== lang) { lang = l; if (rec) { try { rec.abort(); } catch {} rec = null; } }
  if (!SR) { state = 'unsupported'; return null; }
  if (failed || rec) return rec;
  want = true;
  state = 'starting';
  return preferLocal().then((ok) => {
    local = ok;
    rec = build();
    try { rec.start(); } catch { state = 'blocked'; failed = true; }
    return rec;
  });
}

export function stopSpeech() {
  want = false;
  clearTimeout(restartT);
  if (rec) { try { rec.abort(); } catch {} }
  rec = null;
  state = failed ? state : 'off';
}

// once per frame: hand over this frame's words and the current state
export function speechTick() {
  const words = queue;
  queue = [];
  return { words, interim, last, voicing, state };
}
