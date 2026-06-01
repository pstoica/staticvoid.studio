// Web Audio: the FX chain (compressor + delay echo + convolver reverb), the
// oscillator-built synth voices, and the monophonic legato/glide engine.
// Node refs stay module-local; ui.js pokes live params via the setters below.
import { cfg } from "./state.js";

let actx, master, delay, delayFb, delayWet, revWet;

// generated impulse response: decaying stereo noise — a small, cheap room
function makeIR(ctx, seconds, decay){
  const rate = ctx.sampleRate, len = Math.floor(rate*seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for(let ch=0; ch<2; ch++){
    const d = buf.getChannelData(ch);
    for(let i=0;i<len;i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, decay);
  }
  return buf;
}
export function initAudio(initialGain){
  actx = new (window.AudioContext||window.webkitAudioContext)();
  master = actx.createGain(); master.gain.value = initialGain;
  // limiter so stacked plucks don't clip/distort
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 24; comp.ratio.value = 6;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  delay = actx.createDelay(1.0); delay.delayTime.value = cfg.delayTime;
  delayFb = actx.createGain(); delayFb.gain.value = cfg.delayFb;   // echo trails
  delayWet = actx.createGain(); delayWet.gain.value = cfg.delayWet;
  // light reverb: short generated room, fed off the delay so echoes smear into space
  const reverb = actx.createConvolver(); reverb.buffer = makeIR(actx, 1.8, 2.6);
  revWet = actx.createGain(); revWet.gain.value = cfg.reverb;      // ambience
  master.connect(comp);
  master.connect(delay); delay.connect(delayFb); delayFb.connect(delay); delay.connect(delayWet); delayWet.connect(comp);
  master.connect(reverb); delay.connect(reverb); reverb.connect(revWet); revWet.connect(comp);
  comp.connect(actx.destination);
}

// synth voices — all built from oscillators, no samples.
// osc: [waveform, freq multiple, detune cents]; g: per-osc level.
// atk/dec = env ramp times; lp0→lp1 over lpDec = a tone-darkening filter sweep.
export const VOICES = {
  Pluck: { osc:[["square",1,0],["sine",2,4]],                 g:[0.7,0.16],    atk:0.006, dec:1.3, lp0:4200, lp1:900,  lpDec:0.9, peak:0.9 },
  Keys:  { osc:[["sine",1,0],["sine",2,3],["triangle",3,0]],   g:[1,0.18,0.06], atk:0.004, dec:1.3, lp0:4200, lp1:900,  lpDec:1.1, peak:1.0 },
  Bell:  { osc:[["sine",1,0],["sine",2.76,0],["sine",5.4,0]],  g:[1,0.26,0.08], atk:0.002, dec:1.7, lp0:7000, lp1:2200, lpDec:1.5, peak:0.85 },
  Pad:   { osc:[["sawtooth",1,-7],["sawtooth",1,7],["sine",0.5,0]], g:[0.45,0.45,0.3], atk:0.35, dec:3.0, lp0:1500, lp1:1100, lpDec:2.6, peak:0.7 },
  Saw:   { osc:[["sawtooth",1,0],["sawtooth",1,-9],["sawtooth",2,6]], g:[0.5,0.5,0.16], atk:0.008, dec:1.5, lp0:5200, lp1:1500, lpDec:1.1, peak:0.82 },
  Theremin:{ osc:[["sine",1,0],["sine",2,0]], g:[1,0.06], atk:0.09, lp1:3400, peak:0.95, vib:{rate:5.5, depth:11}, mono:true, glide:0.06, rel:0.32 },
};
export function playNote(freq, vel=0.55, voiceName="Pluck"){
  if(!actx) return;
  const V = VOICES[voiceName] || VOICES.Pluck;
  const t = actx.currentTime, peak = Math.max(0.0001, vel*V.peak);
  const env = actx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + V.atk);
  env.gain.exponentialRampToValueAtTime(0.0001, t + V.dec);
  const lp = actx.createBiquadFilter(); lp.type="lowpass";
  lp.frequency.setValueAtTime(V.lp0, t);
  lp.frequency.exponentialRampToValueAtTime(V.lp1, t + V.lpDec);
  const stop = t + V.dec + 0.1;
  let vibGain = null;                                  // pitch LFO (theremin-style vibrato that swells in)
  if(V.vib){
    const lfo = actx.createOscillator(); lfo.type="sine"; lfo.frequency.value = V.vib.rate;
    vibGain = actx.createGain(); vibGain.gain.setValueAtTime(0, t);
    vibGain.gain.linearRampToValueAtTime(V.vib.depth, t + Math.min(V.atk + 0.3, V.dec));
    lfo.connect(vibGain); lfo.start(t); lfo.stop(stop);
  }
  V.osc.forEach(([type,mult,det],i)=>{
    const o = actx.createOscillator(); o.type=type; o.frequency.value=freq*mult; o.detune.value=det||0;
    if(vibGain) vibGain.connect(o.detune);
    const g = actx.createGain(); g.gain.value = V.g[i];
    o.connect(g); g.connect(env); o.start(t); o.stop(stop);
  });
  env.connect(lp); lp.connect(master);
}

// ----- monophonic legato voice (theremin): one persistent oscillator per strum slot that glides between notes -----
export function buildMono(V){
  const env = actx.createGain(); env.gain.value = 0.0001;
  const lp = actx.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value = V.lp1 || 4000;
  let vibGain = null;
  if(V.vib){
    const lfo = actx.createOscillator(); lfo.type="sine"; lfo.frequency.value = V.vib.rate;
    vibGain = actx.createGain(); vibGain.gain.value = 0; lfo.connect(vibGain); lfo.start();
  }
  const oscs = V.osc.map(([type,mult,det],i)=>{
    const o = actx.createOscillator(); o.type=type; o.detune.value = det||0;
    const g = actx.createGain(); g.gain.value = V.g[i] ?? 1;
    if(vibGain) vibGain.connect(o.detune);
    o.connect(g); g.connect(env); o.start();
    return { o, mult };
  });
  env.connect(lp); lp.connect(master);
  return { V, oscs, env, vibGain, active:false, midiNote:null };
}
export function monoGlide(m, freq, snap){       // snap on (re)engage, portamento while sweeping
  const t = actx.currentTime;
  for(const {o,mult} of m.oscs){
    if(snap) o.frequency.setValueAtTime(freq*mult, t);
    else     o.frequency.setTargetAtTime(freq*mult, t, m.V.glide || 0.08);
  }
}
export function monoOn(m, vel){
  const t = actx.currentTime, peak = Math.max(0.0001, vel*m.V.peak);
  m.env.gain.cancelScheduledValues(t); m.env.gain.setValueAtTime(Math.max(0.0001, m.env.gain.value), t);
  m.env.gain.exponentialRampToValueAtTime(peak, t + m.V.atk);
  if(m.vibGain){ m.vibGain.gain.cancelScheduledValues(t); m.vibGain.gain.setValueAtTime(m.vibGain.gain.value, t);
    m.vibGain.gain.linearRampToValueAtTime(m.V.vib.depth, t + 0.3); }
  m.active = true;
}
export function monoOff(m){
  const t = actx.currentTime;
  m.env.gain.cancelScheduledValues(t); m.env.gain.setValueAtTime(Math.max(0.0001, m.env.gain.value), t);
  m.env.gain.exponentialRampToValueAtTime(0.0001, t + (m.V.rel || 0.25));
  if(m.vibGain){ m.vibGain.gain.cancelScheduledValues(t); m.vibGain.gain.setValueAtTime(m.vibGain.gain.value, t);
    m.vibGain.gain.linearRampToValueAtTime(0, t + 0.2); }
  m.active = false;
}

// ----- live-graph pokes for the HUD (each guards on the node existing pre-init) -----
export const audioReady = () => !!actx;
export function resumeAudio(){ return actx.resume(); }
export function setMasterValue(v){ if(master) master.gain.value = v; }
export function setMuteGain(target){ if(master) master.gain.setTargetAtTime(target, actx.currentTime, 0.02); }
export function setReverb(v){ if(revWet) revWet.gain.setTargetAtTime(v, actx.currentTime, 0.1); }
export function setDelayWet(v){ if(delayWet) delayWet.gain.setTargetAtTime(v, actx.currentTime, 0.1); }
export function setDelayTime(v){ if(delay) delay.delayTime.setTargetAtTime(v, actx.currentTime, 0.05); }
export function setDelayFb(v){ if(delayFb) delayFb.gain.setTargetAtTime(v, actx.currentTime, 0.1); }
