// MediaPipe hand tracking + the gesture interpretation that isn't pure drawing:
// per-hand pinch hysteresis, sweep-speed velocity, the legato mono engine
// trigger, and edit-mode pinch-drag/resize of panels.
import { HandLandmarker, FilesetResolver }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
import { MX, pinchDistOf, clampi } from "./util.js";
import { state, cfg, flash, editState } from "./state.js";
import { plate, inPlate, regionAt } from "./regions.js";
import { VOICES, playNote, buildMono, monoGlide, monoOn, monoOff, audioReady } from "./audio.js";
import { midiOn, midiOff, sendMidiNote } from "./midi.js";
import { midiToFreq, cellNote } from "./music.js";
import { drawPick, drawHand, plateCellRect } from "./render.js";
import { ctx, video, canvas, statusEl } from "./dom.js";
import { saveState } from "./ui.js";

// one hand strumming the plate (thumb+index pinch = pick, sweep speed = velocity).
// `st` holds that hand's own pinch/smoothing/retrigger state so two hands stay independent.
export function releaseMono(st){     // fade the held legato tone + end its MIDI note
  if(st.mono && st.mono.active) monoOff(st.mono);
  if(st.monoMidi != null){ midiOff(st.monoMidi); st.monoMidi = null; }
}
export function strumWith(hand, st, W, H, runLen, cols, color, voice){
  if(!hand){ st.pinchOn=false; st.smx=null; st.smy=null; st.lastIdx=-1; releaseMono(st); return; }
  const pinchDist = pinchDistOf(hand);
  st.pinchOn = st.pinchOn ? pinchDist < 0.088 : pinchDist < 0.062;
  const th = hand[4], tip = hand[8];
  let mx = (MX(tip)+MX(th))/2, my = (tip.y+th.y)/2;     // midpoint = pick tip
  if(st.smx===null || !st.pinchOn){ st.smx=mx; st.smy=my; st.psmx=mx; st.psmy=my; st.spd=0; }   // snap on (re)engage, glide while held
  else { st.smx += (mx-st.smx)*0.45; st.smy += (my-st.smy)*0.45; }
  mx=st.smx; my=st.smy;
  const sweep = Math.hypot(mx-st.psmx, my-st.psmy);          // how far the pick moved this frame
  st.spd += (sweep - st.spd)*0.5;                            // lightly smoothed sweep speed → strum velocity
  st.psmx=mx; st.psmy=my;
  const horiz = cfg.orientation==="horizontal";
  const inP = inPlate(mx,my);
  let line=-1, step=-1;
  if(inP){
    const P = plate();
    const fx = (mx - P.x0) / (P.x1 - P.x0);
    const fyUp = (P.y1 - my) / (P.y1 - P.y0);             // bottom=low, top=high
    if(horiz){
      line = clampi(Math.floor(fyUp*cols), 0, cols-1);   // lines stack vertically
      step = clampi(Math.floor(fx*runLen), 0, runLen-1);
    } else {
      line = clampi(Math.floor(fx*cols), 0, cols-1);     // columns spread across
      step = clampi(Math.floor(fyUp*runLen), 0, runLen-1);
    }
  }
  const V = VOICES[voice] || VOICES.Pluck;
  if(st.pinchOn && inP){
    const idx = line*runLen + step;
    const vel = clampi(0.35 + st.spd*9, 0.35, 0.95);                // faster sweep = louder
    const note = cellNote(line, step);
    if(V.mono){                                          // legato glide: one held voice, glissando between notes
      let fresh = st.lastIdx === -1;                     // (re)engaged → snap pitch + new note-on
      if(audioReady()){
        if(!st.mono || st.monoVoice!==voice){ if(st.mono) monoOff(st.mono); st.mono = buildMono(V); st.monoVoice = voice; fresh = true; }
        monoGlide(st.mono, midiToFreq(note), fresh);
        if(fresh) monoOn(st.mono, vel);
      }
      if(idx !== st.lastIdx){
        midiOn(note, vel);                               // mono MIDI: sound the new note, then release the old (legato)
        if(!fresh) midiOff(st.monoMidi);
        st.monoMidi = note;
        flash[idx] = performance.now();
        st.lastIdx = idx;
      }
    } else {
      if(st.mono && st.mono.active) releaseMono(st);      // switched off a mono voice → silence the held tone
      if(idx !== st.lastIdx){
        playNote(midiToFreq(note), vel, voice);
        sendMidiNote(note, vel);
        st.lastIdx = idx;
        flash[idx] = performance.now();
      }
    }
    drawPick(mx*W, my*H, true);
  } else {
    st.lastIdx = -1;                                     // released = muted, can jump
    releaseMono(st);
    if(inP){                                             // hover: outline the cell you'd hit so same-color cells are distinguishable
      const {sx,sy,sw,sh} = plateCellRect(plate(), line, step, W, H, cols, runLen, horiz);
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.fillRect(sx,sy,sw,sh);
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1; ctx.strokeRect(sx+0.5,sy+0.5,sw-1,sh-1);
      ctx.restore();
    }
    drawPick(mx*W, my*H, false);
  }
  drawHand(hand, color);
}

// ----- edit mode gestures: one hand moves a panel, two hands resize it -----
// hysteretic thumb+index pinch → midpoint; `just` flags the frame it engaged.
function editPinch(hand, st){
  if(!hand){ st.prevOn=st.pinchOn; st.pinchOn=false; return null; }
  const mx=(MX(hand[8])+MX(hand[4]))/2, my=(hand[8].y+hand[4].y)/2;
  const d=pinchDistOf(hand);
  st.prevOn=st.pinchOn;
  st.pinchOn = st.pinchOn ? d<0.088 : d<0.062;
  return { on:st.pinchOn, just:st.pinchOn && !st.prevOn, mx, my };
}
// single hand: grab the panel under the pinch and translate it, keeping size.
function editMove(p, st, grabbed){
  if(!p || !p.on){ st.grab=null; return; }
  if(p.just){ const r=regionAt(p.mx,p.my); st.grab=(r && !grabbed.has(r))?r:null; st.lastmx=p.mx; st.lastmy=p.my; }
  if(st.grab){
    grabbed.add(st.grab);
    const r=st.grab, w=r.x1-r.x0, h=r.y1-r.y0;
    const nx0=clampi(r.x0+(p.mx-st.lastmx),0,1-w), ny0=clampi(r.y0+(p.my-st.lastmy),0,1-h);
    r.x0=nx0; r.x1=nx0+w; r.y0=ny0; r.y1=ny0+h;
    st.lastmx=p.mx; st.lastmy=p.my;
  }
}
export function handleEdit(h1, h2, W, H){
  const a = editPinch(h1, editState[0]);
  const b = editPinch(h2, editState[1]);
  if(a && b && a.on && b.on){                             // two hands → resize: pane spans the two pinches
    if(!state.twoHandGrab) state.twoHandGrab = regionAt((a.mx+b.mx)/2,(a.my+b.my)/2);
    if(state.twoHandGrab){
      const r=state.twoHandGrab, MIN=0.08;
      let x0=Math.min(a.mx,b.mx), x1=Math.max(a.mx,b.mx), y0=Math.min(a.my,b.my), y1=Math.max(a.my,b.my);
      if(x1-x0<MIN){ const c=(x0+x1)/2; x0=c-MIN/2; x1=c+MIN/2; }
      if(y1-y0<MIN){ const c=(y0+y1)/2; y0=c-MIN/2; y1=c+MIN/2; }
      r.x0=clampi(x0,0,1); r.x1=clampi(x1,0,1); r.y0=clampi(y0,0,1); r.y1=clampi(y1,0,1);
    }
    editState[0].grab=null; editState[1].grab=null;       // suspend single-hand move while resizing
  } else {
    state.twoHandGrab = null;
    const grabbed=new Set();
    editMove(a, editState[0], grabbed);
    editMove(b, editState[1], grabbed);
  }
  const active = !!(state.twoHandGrab || editState[0].grab || editState[1].grab);
  if(state.editWasActive && !active) saveState();         // persist on release
  state.editWasActive = active;
  for(const [p,hand] of [[a,h1],[b,h2]]){ if(p){ drawPick(p.mx*W,p.my*H,p.on); drawHand(hand,"#ffd479"); } }
}

// ---------- MediaPipe ----------
let landmarker;
export async function setup(){
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions:{
      modelAssetPath:"https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate:"GPU"
    },
    runningMode:"VIDEO", numHands:2,
    minHandDetectionConfidence:0.6, minHandPresenceConfidence:0.6, minTrackingConfidence:0.6
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video:{ width:1280, height:720 } });
  video.srcObject = stream;
  await video.play();
  resize();
  statusEl.textContent = "tracking — hold a hand up";
}
function resize(){
  canvas.width = video.videoWidth || window.innerWidth;
  canvas.height = video.videoHeight || window.innerHeight;
}
window.addEventListener("resize", resize);
export const detect = ts => landmarker.detectForVideo(video, ts);
