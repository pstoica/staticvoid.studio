// Web MIDI output on channel 1. Owns its own <select id="midiSel"> wiring;
// plucky notes auto-release, mono voices stay on until midiOff.
import { clampi } from "./util.js";

let midiAccess = null, midiOut = null;
const midiSel = document.getElementById("midiSel");
const midiActive = new Map();      // note number -> pending noteoff timeout id
function refreshMidiOutputs(){
  if(!midiAccess) return;
  const prev = midiSel.value;
  midiSel.innerHTML = '<option value="">Off</option>';
  for(const out of midiAccess.outputs.values()){
    const o = document.createElement("option"); o.value = out.id; o.textContent = out.name; midiSel.appendChild(o);
  }
  midiSel.value = [...midiSel.options].some(o=>o.value===prev) ? prev : "";
  midiOut = midiAccess.outputs.get(midiSel.value) || null;
}
midiSel.addEventListener("change", ()=>{ midiOut = midiAccess ? midiAccess.outputs.get(midiSel.value) : null; });
export async function initMidi(){
  if(midiAccess || !navigator.requestMIDIAccess) return;
  try{
    midiAccess = await navigator.requestMIDIAccess();
    midiAccess.onstatechange = refreshMidiOutputs;
    refreshMidiOutputs();
  }catch(e){ /* denied or unsupported — stay silent, audio still works */ }
}
export function sendMidiNote(note, vel){       // note on now, auto note-off shortly after (plucky)
  if(!midiOut) return;
  note = Math.round(note);
  if(note < 0 || note > 127) return;
  const v = clampi(Math.round(vel*127), 1, 127);
  const pending = midiActive.get(note);
  if(pending){ clearTimeout(pending); midiOut.send([0x80, note, 0]); }   // retrigger: end the old one first
  midiOut.send([0x90, note, v]);
  midiActive.set(note, setTimeout(()=>{ if(midiOut) midiOut.send([0x80, note, 0]); midiActive.delete(note); }, 350));
}
export function midiOn(note, vel){              // sustained note-on for legato/mono voices (no auto-off)
  if(!midiOut) return; note = Math.round(note); if(note < 0 || note > 127) return;
  midiOut.send([0x90, note, clampi(Math.round(vel*127), 1, 127)]);
}
export function midiOff(note){
  if(!midiOut || note == null) return; note = Math.round(note); if(note < 0 || note > 127) return;
  midiOut.send([0x80, note, 0]);
}
