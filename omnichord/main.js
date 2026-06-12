// Entry point: wires the modules together, owns the per-frame draw() orchestration
// and the requestAnimationFrame loop, and gates everything behind the intro's
// "Enable sound". All the heavy lifting lives in ./lib/*.
import { video, canvas, ctx, statusEl } from "./lib/dom.js";
import { state, cfg, strumState, CHORD } from "./lib/state.js";
import { MX, pinchDistOf, clampi } from "./lib/util.js";
import { isOmni, DEGREE_ORDER, rowsPerCol, curCols } from "./lib/music.js";
import { inRect } from "./lib/regions.js";
import { drawChordPanel, drawPlate, drawPick, drawHand } from "./lib/render.js";
import { strumWith, releaseMono, handleEdit, setup, detect } from "./lib/gesture.js";
import { setMode, updateChordLabel, getVolume } from "./lib/ui.js";
import { initAudio, audioReady, resumeAudio } from "./lib/audio.js";
import { initMidi } from "./lib/midi.js";

// ---------- Per-frame orchestration ----------
function draw(res){
  const W = canvas.width, H = canvas.height;
  // mirrored video
  ctx.save(); ctx.translate(W,0); ctx.scale(-1,1);
  ctx.drawImage(video,0,0,W,H); ctx.restore();
  ctx.fillStyle = "rgba(11,13,18,.32)"; ctx.fillRect(0,0,W,H);

  const hands = res.landmarks || [];
  // assign hands by screen position: left-of-frame = chord/Voice 1, right = strum/Voice 2.
  // A lone hand commits to a side only past a center dead-zone, so it can't flip-flop
  // frame to frame (which was making the voice "alternate" with one hand up).
  let chordHand=null, strumHand=null;
  if(hands.length>=2){
    const sorted = [...hands].sort((a,b)=> MX(a[0]) - MX(b[0]));
    chordHand = sorted[0]; strumHand = sorted[sorted.length-1];   // leftmost, rightmost
  } else if(hands.length===1){
    const x = MX(hands[0][0]);                                    // wrist screen-x
    if(x < 0.42) state.singleSide = "left"; else if(x > 0.58) state.singleSide = "right";
    if(state.singleSide==="left") chordHand = hands[0]; else strumHand = hands[0];
  }

  // ----- edit mode: pinch-drag panels instead of playing -----
  if(state.editMode){
    state.chordHover = null; state.chordPick = null;
    drawChordPanel(W, H);
    drawPlate(W, H, rowsPerCol(), curCols());
    handleEdit(chordHand, strumHand, W, H);
    updateChordLabel();
    return;
  }

  // ----- chord selection: pinch (thumb+index) a cell in the left palette -----
  // Position + the one reliable pinch — no fragile finger-count/curl classification.
  // Columns walk the circle of fifths; rows stack triad/+7/+9/+11. The pick latches,
  // so once chosen both hands are free to strum until the next palette pinch.
  state.chordHover = null; state.chordPick = null;
  let chordInPalette = false;       // left hand reaching the palette = picking a chord, not strumming
  if(chordHand && !state.freeMode){
    const cmx=(MX(chordHand[8])+MX(chordHand[4]))/2, cmy=(chordHand[8].y+chordHand[4].y)/2;
    if(!state.lockChord){
      const d = pinchDistOf(chordHand);
      state.cPinchOn = state.cPinchOn ? d < 0.088 : d < 0.062;
      if(inRect(CHORD,cmx,cmy)){
        chordInPalette = true;
        const fx=(cmx-CHORD.x0)/(CHORD.x1-CHORD.x0);
        if(isOmni()){
          const fyTop=(cmy-CHORD.y0)/(CHORD.y1-CHORD.y0);  // row 0 (Major) at the top, matching the OM-108
          const col = clampi(Math.floor(fx*12),0,11), row = clampi(Math.floor(fyTop*3),0,2);
          state.chordHover = { omniCol:col, omniRow:row };
          if(state.cPinchOn){ state.omniRootIdx = col; state.omniQual = row; }
        } else {
          const fyUp=(CHORD.y1-cmy)/(CHORD.y1-CHORD.y0);
          const hDeg = DEGREE_ORDER[clampi(Math.floor(fx*7),0,6)];
          const hExt = clampi(Math.floor(fyUp*cfg.extRows),0,cfg.extRows-1);
          state.chordHover = { deg:hDeg, ext:hExt };       // cell the hand is over (highlight even before pinching)
          if(state.cPinchOn){ state.currentDegree = hDeg; state.currentExt = hExt; }
        }
      }
    } else { state.cPinchOn = false; }
    state.chordPick = { x:cmx*W, y:cmy*H, on:state.cPinchOn };   // drawn on top of the palette below
  } else { state.cPinchOn = false; }

  const runLen = rowsPerCol(), cols = curCols();
  drawChordPanel(W, H);
  drawPlate(W, H, runLen, cols);

  // ----- strum: both hands play the plate; chord mode shares one voice, free mode is per-hand -----
  if(state.freeMode){
    strumWith(chordHand, strumState[0], W, H, runLen, cols, "#62e09a", cfg.voiceFreeL);  // left
    strumWith(strumHand, strumState[1], W, H, runLen, cols, "#56b6ff", cfg.voiceFreeR);  // right
  } else {
    strumWith(strumHand, strumState[1], W, H, runLen, cols, "#56b6ff", cfg.voiceChord); // right hand strums
    if(chordInPalette){                                     // left hand is selecting — show its palette pick, don't strum
      strumState[0].lastIdx = -1; releaseMono(strumState[0]);
      if(chordHand) drawHand(chordHand, "#62e09a");
      if(state.chordPick) drawPick(state.chordPick.x, state.chordPick.y, state.chordPick.on);
    } else {
      strumWith(chordHand, strumState[0], W, H, runLen, cols, "#62e09a", cfg.voiceChord); // left hand strums too
    }
  }

  // ----- labels -----
  updateChordLabel();
}

// ---------- Main loop ----------
function loop(){
  if(video.readyState >= 2){
    if(state.started){
      const ts = performance.now();
      if(ts !== state.lastTs){
        state.lastTs = ts;
        const res = detect(ts);
        draw(res);
      }
    } else {
      const W=canvas.width, H=canvas.height;      // live preview only — skip MediaPipe + interaction
      ctx.save(); ctx.translate(W,0); ctx.scale(-1,1); ctx.drawImage(video,0,0,W,H); ctx.restore();
      ctx.fillStyle="rgba(11,13,18,.32)"; ctx.fillRect(0,0,W,H);
    }
  }
  requestAnimationFrame(loop);
}

// ---------- Start ----------
// the app loads up front: camera + tracking begin on page load and render behind the
// blurred intro. Audio needs a user gesture, so the button only unlocks sound + dismisses.
async function startCamera(){
  if(state.camStarted) return;
  state.camStarted = true;
  try{
    statusEl.textContent = "loading model…";
    await setup();
    requestAnimationFrame(loop);                  // start the render loop once the camera is live
  }catch(err){
    state.camStarted = false;
    statusEl.textContent = "Camera unavailable: " + err.message;
    console.error(err);
  }
}
if(matchMedia("(pointer:coarse)").matches || window.innerWidth < 760)
  document.body.classList.add("is-mobile");
startCamera();                                       // ui.js loadState() already restored the saved mode

const startEl = document.getElementById("start");
document.getElementById("startBtn").addEventListener("click", async ()=>{
  try{ if(!audioReady()) initAudio(getVolume()); await resumeAudio(); }
  catch(err){ console.error(err); }
  initMidi();                                      // ask for MIDI output (non-blocking; fine if denied)
  startCamera();                                   // retry if camera was blocked/slow at load
  state.started = true;                            // begin detection + playing now that the intro is dismissed
  startEl.classList.add("hide");
});
startEl.addEventListener("transitionend", ()=>{    // drop from layout once faded
  if(startEl.classList.contains("hide")) startEl.style.display="none";
});
