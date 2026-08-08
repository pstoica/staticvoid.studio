// mic.js — the microphone as Loom signals, straight from the browser.
//
// This is the short path to audio-reactive visuals: no bridge, no Ableton, no local app.
// Creating any mic signal in a patch lazily asks for the microphone and wires an
// AnalyserNode; main.js samples it once per frame into plain numbers that the DSL reads.
// (The Link Audio feed is the other, richer path — per-TRACK stems from Live over a
// WebSocket. This one is just "what does the room sound like right now".)
//
// Everything degrades quietly: no mic, denied permission, or a tab that never asked →
// the signals sit at 0 and nothing breaks.

let ctx = null, analyser = null, freq = null, time = null, stream = null;
let loading = null, failed = false;
let state = 'off';                     // 'off' | 'starting' | 'live' | 'blocked'

export const micState = () => state;

export function ensureMic() {
  if (failed || analyser || loading) return loading;
  state = 'starting';
  loading = navigator.mediaDevices.getUserMedia({
    // raw-ish input: the browser's voice processing would pump/duck a musical signal
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  }).then((s) => {
    stream = s;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(s);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;              // 512 bins ≈ 43 Hz each at 44.1k
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);                // note: never connected to destination (no feedback howl)
    freq = new Uint8Array(analyser.frequencyBinCount);
    time = new Float32Array(analyser.fftSize);
    state = 'live';
  }).catch((e) => {
    failed = true; state = 'blocked';
    console.warn('Loom: microphone unavailable', e);
  });
  return loading;
}

// per-frame snapshot, read by the DSL signals. level is RMS (loudness), bands are the
// FFT split into thirds, and `hit` is a decaying pulse on a transient — the same shape as
// the juggling/Link-Audio pulses, so it drives the same kinds of patterns.
const S = { level: 0, low: 0, mid: 0, high: 0, hit: 0, bands: new Float32Array(24) };
export const micStateValues = () => S;

let prevLevel = 0;
export function micTick(dt) {
  S.hit *= Math.exp(-dt * 6);                 // decay the transient flash (~0.4 s)
  if (!analyser) return S;
  analyser.getFloatTimeDomainData(time);
  let sum = 0;
  for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
  // RMS → a perceptual-ish 0..1 (raw RMS sits very low for normal speech)
  const rms = Math.sqrt(sum / time.length);
  S.level = Math.max(0, Math.min(1, Math.pow(rms * 3.2, 0.62)));

  analyser.getByteFrequencyData(freq);
  const n = freq.length, per = Math.floor(n / S.bands.length);
  for (let b = 0; b < S.bands.length; b++) {
    let acc = 0;
    for (let i = b * per; i < (b + 1) * per; i++) acc += freq[i];
    S.bands[b] = acc / per / 255;
  }
  const third = Math.floor(n / 3);
  const avg = (a, z) => { let s = 0; for (let i = a; i < z; i++) s += freq[i]; return s / (z - a) / 255; };
  S.low = avg(0, third); S.mid = avg(third, third * 2); S.high = avg(third * 2, n);

  // transient: a fast rise over the recent level reads as an onset (a sung note, a clap)
  if (S.level - prevLevel > 0.09) S.hit = Math.min(1, S.hit + (S.level - prevLevel) * 4);
  prevLevel = prevLevel * 0.8 + S.level * 0.2;
  return S;
}
