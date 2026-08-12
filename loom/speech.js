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

// On-device support is queried in the BACKGROUND, never awaited. An early version made
// startup depend on SpeechRecognition.available(), which can hang — and while it hung the
// state sat at 'starting', the frame pump (gated on 'live') never ran, and every run() piled
// on another pending recognizer. Four of them holding the mic is what makes the tab's
// recording dot flicker. Recognition now starts immediately with whatever we know.
function probeLocal() {
  if (!SR.available) { localAvail = 'unsupported'; return; }
  localAvail = 'pending';
  Promise.resolve()
    .then(() => SR.available({ langs: [lang], processLocally: true }))
    .then((a) => {
      localAvail = String(a);
      if (a === 'available') { local = true; return; }
      if (a !== 'unavailable') installLocal();      // downloadable/downloading → go get it
    })
    .catch((e) => { localAvail = 'probe failed: ' + ((e && e.name) || e); });
}

// Fetch the on-device model. This is the ONLY way out when the cloud path is unreachable —
// lastError 'network' means Chrome could not reach the speech service (a DNS filter, a
// blocker, a VPN, or simply offline), and no amount of retrying fixes that. Exposed as
// loom.speechInstall() so it can be kicked by hand; also fired automatically the first time
// a network error lands. Once the model is in, we tear down the doomed cloud session so the
// next one is local.
// install() can resolve late, never, or with nothing useful, so the honest progress report
// is Chrome's own availability answer, re-asked. `localAvail` is whatever IT last said —
// 'downloadable' / 'downloading' / 'available' / 'unavailable' — never a label we invented.
let pollT = null, waited = 0;
function goLocal() {
  local = true; dead = 0; lastError = ''; installing = false;
  if (want && rec) { const r = rec; rec = null; try { r.abort(); } catch {} ensureSpeech(); }
}
function pollAvailability() {
  clearTimeout(pollT);
  const tick = () => {
    if (!SR.available) return;
    Promise.resolve()
      .then(() => SR.available({ langs: [lang], processLocally: true }))
      .then((a) => {
        localAvail = String(a);
        if (a === 'available') { goLocal(); return; }
        if (waited >= 300) { installing = false; return; }   // 5 min: stop narrating
        waited += 5;
        pollT = setTimeout(tick, 5000);
      })
      .catch((e) => { localAvail = 'probe failed: ' + ((e && e.name) || e); installing = false; });
  };
  tick();
}

export function installLocal() {
  if (!SR || !SR.install) return Promise.resolve('unsupported');
  if (local || installing) return Promise.resolve(localAvail);
  installing = true; installTried = true;
  pollAvailability();          // report CHROME's answer, not our optimism
  return Promise.resolve()
    .then(() => SR.install({ langs: [lang], processLocally: true }))
    .then(() => (SR.available ? SR.available({ langs: [lang], processLocally: true }) : 'unknown'))
    .then((a) => {
      localAvail = String(a);
      if (a === 'available') goLocal(); else installing = false;
      return localAvail;
    })
    .catch((e) => { installing = false; localAvail = 'install failed: ' + ((e && e.name) || e); return localAvail; });
}

// Chrome ends a session on silence, on its own timeouts, and after errors, so restarting is
// mandatory — but restarting INSTANTLY on a session that produced nothing is how you get a
// mic that ticks on and off. Back off when nothing is being heard; snap back to responsive
// the moment a word actually lands.
const BACKOFF = [400, 800, 1500, 2500, 4000];
let dead = 0;                          // consecutive sessions that recognized nothing
let heard = 0, starts = 0, lastError = '';
let localAvail = 'unknown', installing = false, installTried = false;
// How long the trailing word must stop changing before we let it out. The recognizer keeps
// revising the word you are mid-way through saying, so the safe move is to hold it — but
// holding it until the NEXT word arrives means a lone word waits for the phrase to finalize,
// seconds later. Instead we watch it settle: once it has held still this long, ship it. If a
// later result revises a word we already emitted, we let it stand (a slightly wrong word beats
// a slow one here) — the count of emitted words only ever moves forward.
// 'phrase' (default) buffers a whole utterance and then REPLAYS it at the pace you spoke it;
// 'live' races each word out as it settles. Live sounds better than it is: a long word that
// pauses mid-articulation ("some… times") settles early and commits wrong, and the correction
// can never land because that slot has already gone. Phrase mode waits for the recognizer's
// final answer — accurate — and buys back the liveness by restoring your rhythm.
//
// The API exposes no word timings, so the pacing is DERIVED: every interim result reveals how
// many word slots exist so far, and the moment a new slot appears is (near enough) the moment
// you said it. Those onsets become the replay schedule.
let mode = 'phrase';
let lagMs = 140;                   // 'live' only: settle time before the trailing word ships
let pace = 1;                      // replay speed multiplier (2 = twice as fast)
const MAX_GAP = 900;               // clamp dead air between words so a pause is not a stall
let wordAt = [];                   // observed onset per word slot in the current utterance
let replay = [];                   // scheduled {w, at} awaiting their moment
let tailWord = '', tailIdx = -1, tailAt = 0;
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
export const setSpeechLag = (ms) => { lagMs = Math.max(0, +ms || 0); return lagMs; };
export const setSpeechPace = (x) => { pace = Math.max(0.05, +x || 1); return pace; };
export const setSpeechMode = (m) => { mode = m === 'live' ? 'live' : 'phrase'; return mode; };

// Turn the finished utterance into a timed schedule. Words we never saw appear in an interim
// result (fast speech can finalize slots we never observed) get evenly spaced after the last
// one we did time, so a sentence never collapses into a single instant.
function scheduleReplay(words) {
  if (!words.length) return;
  const t0 = wordAt[0] != null ? wordAt[0] : nowMs();
  const start = nowMs();
  let prev = 0;
  for (let i = 0; i < words.length; i++) {
    let off = wordAt[i] != null ? wordAt[i] - t0 : prev + 180;
    if (off < prev) off = prev;                       // onsets must not go backwards
    if (off - prev > MAX_GAP) off = prev + MAX_GAP;   // a long pause replays as a short one
    prev = off;
    replay.push({ w: words[i], at: start + off / pace });
  }
}

function build() {
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.lang = lang;
  // only claim on-device when the probe confirmed it AND it has not already failed us
  if (local) { try { r.processLocally = true; } catch {} }

  let got = false;                     // did THIS session produce anything?

  r.onstart = () => { state = 'live'; starts++; };
  r.onsoundstart = () => { voicing = 1; };
  r.onsoundend = () => { voicing = 0; };

  r.onresult = (ev) => {
    got = true; dead = 0; heard++;     // it works — go back to snappy restarts
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const text = res[0] ? res[0].transcript : '';
      const words = text.match(WORD) || [];
      if (!res.isFinal) {
        interim = text;
        // record when each word SLOT first showed up — this is the pacing, and it is the only
        // timing information the API gives away
        for (let k = 0; k < words.length; k++) if (wordAt[k] == null) wordAt[k] = nowMs();
        if (mode === 'live') {
          for (let k = emitted; k < words.length - 1; k++) push(words[k]);
          emitted = Math.max(emitted, words.length - 1);
          const last = words[words.length - 1] || '';
          if (last !== tailWord || words.length - 1 !== tailIdx) {
            tailWord = last; tailIdx = words.length - 1; tailAt = nowMs();
          }
        }
        continue;
      }
      // final: the recognizer's settled answer, spellings and all
      if (mode === 'live') for (let k = emitted; k < words.length; k++) push(words[k]);
      else scheduleReplay(words);
      emitted = 0; interim = ''; tailWord = ''; tailIdx = -1; wordAt = [];
    }
  };

  r.onerror = (e) => {
    lastError = e.error || 'error';
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
      state = 'blocked'; failed = true; want = false;   // no mic, or the user said no
      return;
    }
    // A session that claimed on-device and then failed is the classic "model said available
    // but is not usable" case: drop the claim for good and let the next restart use the
    // cloud path, rather than failing identically forever.
    if (local && !got) { local = false; lastError += ' (dropped on-device)'; }
    // 'network' = the cloud service is unreachable. Retrying it on a 4s loop just cycles the
    // microphone for nothing, so back right off and try to pull the on-device model instead.
    if (e.error === 'network' && !local && !installTried) installLocal();
  };

  r.onend = () => {
    emitted = 0; interim = ''; voicing = 0;
    if (rec !== r) return;             // superseded by a newer recognizer: let it own restarts
    if (!want || failed) { if (!failed) state = 'off'; return; }
    if (!got) dead++;
    const offline = !local && lastError.startsWith('network');
    state = offline ? 'offline' : 'idle';
    clearTimeout(restartT);
    restartT = setTimeout(() => {
      if (!want || failed || rec !== r) return;
      try { r.start(); } catch { /* already running: the next onend will retry */ }
    }, offline ? 15000 : BACKOFF[Math.min(dead, BACKOFF.length - 1)]);
  };

  return r;
}

export function ensureSpeech(l) {
  if (l && l !== lang) { lang = l; stopSpeech(); failed = false; }
  if (!SR) { state = 'unsupported'; return null; }
  if (failed || rec) return rec;       // rec is assigned SYNCHRONOUSLY now — a real guard
  want = true;
  state = 'starting';
  probeLocal();                        // background; applies from the next session on
  rec = build();
  try { rec.start(); } catch (e) { lastError = String(e && e.name || e); state = 'blocked'; failed = true; }
  return rec;
}

export function stopSpeech() {
  if (!rec && !want) return;
  want = false;
  clearTimeout(restartT);
  replay = []; wordAt = []; tailWord = ''; tailIdx = -1;
  const r = rec;
  rec = null;                          // clear FIRST so the pending onend bails out
  if (r) { try { r.abort(); } catch {} }
  if (!failed) state = 'off';
}

// what the tooling sees: loom.speech()
export const speechDebug = () => ({ state, local, localAvail, installing, mode, pace, lagMs, queued: replay.length, waitedSec: waited, starts, heard, dead, lastError, want, has: !!rec });

// once per frame: hand over this frame's words and the current state
export function speechTick() {
  const t = nowMs();
  // phrase mode: let scheduled words out at the moment they were spoken
  while (replay.length && replay[0].at <= t) push(replay.shift().w);
  // live mode: release the trailing word once it has stopped changing (see lagMs)
  if (mode === 'live' && tailWord && tailIdx >= emitted && nowMs() - tailAt >= lagMs) {
    push(tailWord);
    emitted = tailIdx + 1;
    tailWord = ''; tailIdx = -1;
  }
  const words = queue;
  queue = [];
  return { words, interim, last, voicing, state };
}
