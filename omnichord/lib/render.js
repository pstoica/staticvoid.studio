// All 2D-canvas drawing: the chord palette, the omni panel, the strum plate +
// flashes, hover handles, picks, and hand skeletons. Reads state + music, never
// writes state.
import { canvas, ctx } from "./dom.js";
import { MX } from "./util.js";
import { state, cfg, flash, CHORD } from "./state.js";
import { plate } from "./regions.js";
import { NOTE_NAMES, DEGREE_ORDER, degRoot, ROMAN, OMNI_ROOT_PC, isOmni, cellNote } from "./music.js";

const FONT = '"Helvetica Neue",Arial,sans-serif';     // concrete: avoids canvas serif fallback
export function noteColor(midi, light, sat, a){
  const pc = (((midi - state.keyRoot) % 12) + 12) % 12;       // pitch class relative to key
  return `hsla(${pc/12*360}, ${sat}%, ${light}%, ${a})`;
}

const handleFade = new Map();                        // region -> eased 0..1 hover alpha
// screen rect of one plate cell — shared by the grid render and the hover highlight
export function plateCellRect(P,line,r,W,H,cols,runLen,horiz){
  const x0=P.x0*W, x1=P.x1*W, y0=P.y0*H, y1=P.y1*H;
  if(horiz) return { sw:(x1-x0)/runLen, sh:(y1-y0)/cols, sx:x0+r*((x1-x0)/runLen), sy:y1-(line+1)*((y1-y0)/cols) };
  return { sw:(x1-x0)/cols, sh:(y1-y0)/runLen, sx:x0+line*((x1-x0)/cols), sy:y1-(r+1)*((y1-y0)/runLen) };
}
export function drawPlate(W,H,runLen,cols){
  const P=plate();
  const x0=P.x0*W, x1=P.x1*W, y0=P.y0*H, y1=P.y1*H;
  const horiz = cfg.orientation==="horizontal";
  const now = performance.now();
  ctx.textAlign="center"; ctx.textBaseline="middle";
  for(let line=0; line<cols; line++){
    for(let r=0; r<runLen; r++){
      const note = cellNote(line, r);
      const idx  = line*runLen + r;
      const tonic = (((note - state.keyRoot) % 12) + 12) % 12 === 0;
      const {sx,sy,sw,sh} = plateCellRect(P,line,r,W,H,cols,runLen,horiz);
      // continuous fade after a trigger: 1 at the hit, eased back to rest over ~650ms
      const lin = Math.max(0, 1 - (now - (flash[idx] || -1e9)) / 650);
      const g = lin*lin;
      // rests sit low and blend into the video; a hit blooms in opacity + saturation
      ctx.fillStyle = noteColor(note, 58 + g*24, 55 + g*38, (tonic?0.30:0.15) + g*0.62);
      ctx.fillRect(sx, sy, sw, sh);
      if(sw>24 && sh>13){
        ctx.font = (tonic?"600 ":"400 ")+"11px "+FONT;
        ctx.fillStyle = `rgba(255,255,255,${0.52 + g*0.45})`;
        ctx.fillText(NOTE_NAMES[note%12], sx+sw/2, sy+sh/2);
      }
    }
  }
  ctx.textAlign="left"; ctx.textBaseline="alphabetic";
  drawHandles(P, x0, y0, x1, y1);
}
// faint frame + corner handles, fading in/out as you hover/drag this region
function drawHandles(r, x0, y0, x1, y1){
  const target = (state.editMode || state.hoverTarget===r || state.drag?.target===r) ? 1 : 0;
  const a = (handleFade.get(r) ?? 0) + (target - (handleFade.get(r) ?? 0)) * 0.18;
  handleFade.set(r, a);
  if(a < 0.01) return;
  ctx.strokeStyle=`rgba(255,255,255,${0.4*a})`; ctx.lineWidth=1;
  ctx.strokeRect(x0,y0,x1-x0,y1-y0);
  ctx.fillStyle=`rgba(255,255,255,${0.9*a})`; const hs=7;
  for(const [cx,cy] of [[x0,y0],[x1,y0],[x0,y1],[x1,y1]])
    ctx.fillRect(cx-hs/2,cy-hs/2,hs,hs);
}
// ----- chord palette: 7 degree columns (circle of fifths) × 4 extension rows -----
export function drawChordPanel(W,H){
  if(state.freeMode) return;                       // palette is meaningless when soloing
  const x0=CHORD.x0*W, x1=CHORD.x1*W, y0=CHORD.y0*H, y1=CHORD.y1*H;
  if(isOmni()){ drawOmniPanel(x0,y0,x1,y1); drawHandles(CHORD, x0, y0, x1, y1); return; }
  const cw=(x1-x0)/7, ch=(y1-y0)/cfg.extRows;
  ctx.textAlign="center"; ctx.textBaseline="middle";
  for(let c=0;c<7;c++){
    const deg=DEGREE_ORDER[c], root=degRoot(deg);
    for(let ext=0;ext<cfg.extRows;ext++){
      const sx=x0+c*cw, sy=y1-(ext+1)*ch;          // ext0 (triad) at the bottom
      const sel = (deg===state.currentDegree && ext===state.currentExt && !state.freeMode);
      const hov = state.chordHover && state.chordHover.deg===deg && state.chordHover.ext===ext && !sel;
      ctx.fillStyle = noteColor((root+12*5), sel?66:54, sel?92:46, sel?0.92:0.16);
      ctx.fillRect(sx,sy,cw,ch);
      if(hov){ ctx.strokeStyle="rgba(255,255,255,.8)"; ctx.lineWidth=2; ctx.strokeRect(sx+1,sy+1,cw-2,ch-2); ctx.lineWidth=1; }
      if(cw>22 && ch>13){
        ctx.font=(sel?"600 ":"400 ")+"11px "+FONT;
        ctx.fillStyle=`rgba(255,255,255,${sel?0.98:0.5})`;
        ctx.fillText(ROMAN[deg]+["","7","9","11"][ext], sx+cw/2, sy+ch/2);
      }
    }
  }
  ctx.textAlign="left"; ctx.textBaseline="alphabetic";
  drawHandles(CHORD, x0, y0, x1, y1);
}
const OMNI_ROW_TAG = ["", "m", "7"];                 // row 0 Major, 1 Minor, 2 7th (top→bottom)
function drawOmniPanel(x0,y0,x1,y1){
  const cw=(x1-x0)/12, ch=(y1-y0)/3;
  ctx.textAlign="center"; ctx.textBaseline="middle";
  for(let c=0;c<12;c++){
    const rootPc = OMNI_ROOT_PC[c];
    for(let row=0;row<3;row++){
      const sx=x0+c*cw, sy=y0+row*ch;                // row 0 (Major) at top
      const sel = (c===state.omniRootIdx && row===state.omniQual);
      const hov = state.chordHover && state.chordHover.omniCol===c && state.chordHover.omniRow===row && !sel;
      ctx.fillStyle = noteColor((rootPc+12*5), sel?66:54, sel?92:46, sel?0.92:0.16);
      ctx.fillRect(sx,sy,cw,ch);
      if(hov){ ctx.strokeStyle="rgba(255,255,255,.8)"; ctx.lineWidth=2; ctx.strokeRect(sx+1,sy+1,cw-2,ch-2); ctx.lineWidth=1; }
      if(cw>16 && ch>13){
        ctx.font=(sel?"600 ":"400 ")+"10px "+FONT;
        ctx.fillStyle=`rgba(255,255,255,${sel?0.98:0.5})`;
        ctx.fillText(NOTE_NAMES[rootPc]+OMNI_ROW_TAG[row], sx+cw/2, sy+ch/2);
      }
    }
  }
  ctx.textAlign="left"; ctx.textBaseline="alphabetic";
}
export function drawPick(px,py,engaged){
  ctx.beginPath(); ctx.arc(px,py,engaged?13:8,0,Math.PI*2);
  ctx.fillStyle = engaged ? "rgba(255,255,255,.96)" : "rgba(255,255,255,.3)"; ctx.fill();
  ctx.beginPath(); ctx.arc(px,py,engaged?24:15,0,Math.PI*2);
  ctx.strokeStyle = engaged ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.16)";
  ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
}
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
export function drawHand(lm,color){
  const W=canvas.width,H=canvas.height;
  ctx.save();
  ctx.globalAlpha=0.4;                               // dim: skeleton is a hint, the pick is the focus
  ctx.strokeStyle=color; ctx.lineWidth=1.25;
  for(const [a,b] of BONES){
    ctx.beginPath(); ctx.moveTo(MX(lm[a])*W,lm[a].y*H);
    ctx.lineTo(MX(lm[b])*W,lm[b].y*H); ctx.stroke();
  }
  ctx.fillStyle=color;
  for(const p of lm){ ctx.beginPath(); ctx.arc(MX(p)*W,p.y*H,1.5,0,Math.PI*2); ctx.fill(); }
  ctx.restore();
}
