// DOM control wiring: the HUD selects/sliders, voice steppers, legend, intro
// keyboard shortcuts, mouse drag of the regions, localStorage persistence, the
// mode switch, and the chord-name label. This module owns every HUD element.
import { canvas } from "./dom.js";
import { state, cfg, regions, CHORD, editState } from "./state.js";
import { clampi } from "./util.js";
import { NOTE_NAMES, SCALES, MAJOR, ROMAN, OMNI_ROOT_PC, OMNI_QUALITIES, isOmni, chordTag, curOct, curCols } from "./music.js";
import { noteColor } from "./render.js";
import { VOICES, setReverb, setDelayWet, setDelayTime, setDelayFb, setMasterValue, setMuteGain } from "./audio.js";
import { plate, regionAt, nearRect, EDGE } from "./regions.js";

// ---------- DOM ----------
const keySel  = document.getElementById("keySel");
const scaleSel= document.getElementById("scaleSel");
const scalePanel = document.getElementById("scalePanel");
const modeSel = document.getElementById("modeSel");
const chordNameEl = document.getElementById("chordName");
const modeEl  = document.getElementById("mode");
const legendEl= document.getElementById("legend");
const volEl   = document.getElementById("vol");
const orientSel = document.getElementById("orientSel");
const octSel  = document.getElementById("octSel");
const octVal  = document.getElementById("octVal");
const colSel  = document.getElementById("colSel");
const colVal  = document.getElementById("colVal");
const octAxis = document.getElementById("octAxis");
const colAxis = document.getElementById("colAxis");
const stackSel = document.getElementById("stackSel");
const stackVal = document.getElementById("stackVal");
const layoutSel = document.getElementById("layoutSel");
const baseSel = document.getElementById("baseSel");
const revSel = document.getElementById("revSel"), revVal = document.getElementById("revVal");
const dlySel = document.getElementById("dlySel"), dlyVal = document.getElementById("dlyVal");
const timeSel= document.getElementById("timeSel"),timeVal= document.getElementById("timeVal");
const fbSel  = document.getElementById("fbSel"),  fbVal  = document.getElementById("fbVal");
const volVal = document.getElementById("volVal");
const lockBtn = document.getElementById("lockBtn");
const editBtn = document.getElementById("editBtn");
const hudEl = document.getElementById("hud");
const opacitySel = document.getElementById("opacitySel");
const opacityVal = document.getElementById("opacityVal");
function applyHudOpacity(){
  hudEl.style.opacity = opacitySel.value;
  opacityVal.textContent = Math.round(parseFloat(opacitySel.value) * 100) + "%";
}
opacitySel.addEventListener("input", applyHudOpacity);

NOTE_NAMES.forEach((n,i)=>{ const o=document.createElement("option"); o.value=i; o.textContent=n; if(i===0)o.selected=true; keySel.appendChild(o); });
Object.keys(SCALES).forEach(s=>{ const o=document.createElement("option"); o.value=s; o.textContent=s; scaleSel.appendChild(o); });
[1,2,3,4].forEach(o=>{ const e=document.createElement("option"); e.value=o; e.textContent="C"+o; if(o===3)e.selected=true; baseSel.appendChild(e); });

const fmt2 = v => v.toFixed(2);
export const getVolume = () => parseFloat(volEl.value);

// the note run (octaves) goes along the strum axis, lanes run perpendicular
function reflectAxes(){
  const h = cfg.orientation === "horizontal";
  octAxis.textContent = h ? "↔" : "↕";
  colAxis.textContent = h ? "↕" : "↔";
}
orientSel.addEventListener("change", ()=>{ cfg.orientation = orientSel.value; reflectAxes(); });
octSel.addEventListener("input", ()=>{ const v=parseInt(octSel.value); if(state.freeMode) cfg.octavesFree=v; else cfg.octavesChord=v; octVal.textContent = octSel.value; });
colSel.addEventListener("input", ()=>{ const v=parseInt(colSel.value); if(state.freeMode) cfg.colsFree=v; else cfg.colsChord=v; colVal.textContent = colSel.value; });
stackSel.addEventListener("input", ()=>{ cfg.extRows = parseInt(stackSel.value); stackVal.textContent = stackSel.value; state.currentExt = Math.min(state.currentExt, cfg.extRows-1); });
revSel.addEventListener("input", ()=>{ cfg.reverb = parseFloat(revSel.value); revVal.textContent = fmt2(cfg.reverb); setReverb(cfg.reverb); });
dlySel.addEventListener("input", ()=>{ cfg.delayWet = parseFloat(dlySel.value); dlyVal.textContent = fmt2(cfg.delayWet); setDelayWet(cfg.delayWet); });
timeSel.addEventListener("input",()=>{ cfg.delayTime = parseFloat(timeSel.value); timeVal.textContent = fmt2(cfg.delayTime); setDelayTime(cfg.delayTime); });
fbSel.addEventListener("input",  ()=>{ cfg.delayFb = parseFloat(fbSel.value); fbVal.textContent = fmt2(cfg.delayFb); setDelayFb(cfg.delayFb); });
layoutSel.addEventListener("change", ()=>{ if(state.freeMode) cfg.layoutFree = layoutSel.value; else cfg.layoutChord = layoutSel.value; });
baseSel.addEventListener("change", ()=> cfg.baseOctave = parseInt(baseSel.value));
volEl.addEventListener("input", ()=>{ volVal.textContent = fmt2(parseFloat(volEl.value)); if(!state.muted) setMasterValue(parseFloat(volEl.value)); });
keySel.addEventListener("change", ()=> state.keyRoot = parseInt(keySel.value));
scaleSel.addEventListener("change", ()=> state.scaleName = scaleSel.value);

// ---------- Legend ----------
legendEl.innerHTML = `
  <span id="legendClose" title="Hide (H)">×</span>
  <b class="c-chord">Pinch left</b> to pick a chord · <b class="c-note">pinch + sweep right</b> to strum<br>
  sweep faster = louder<br>
  drag panels to move, edges to resize<br>
  <span class="kbd"><b>L</b> lock chord</span> · <span class="kbd"><b>F</b> free scale</span> · <span class="kbd"><b>O</b> omnichord</span> · <span class="kbd"><b>M</b> mute</span> · <span class="kbd"><b>E</b> move panels</span> · <span class="kbd"><b>R</b> reset</span> · <span class="kbd"><b>H</b> hide</span>`;
const legendShowEl = document.getElementById("legendShow");
const setLegend = show => { document.body.classList.toggle("legend-hidden", !show); saveState(); };
document.getElementById("legendClose").addEventListener("click", ()=> setLegend(false));
legendShowEl.addEventListener("click", ()=> setLegend(true));

// ---------- Control sidebar: collapse + side ----------
const railToggleEl = document.getElementById("railToggle");
const sideToggleEl = document.getElementById("sideToggle");
const railIs = cls => document.body.classList.contains(cls);
function reflectRail(){
  const collapsed = railIs("rail-collapsed"), left = railIs("rail-left");
  // chevron points toward the rail's home edge when open, away when collapsed
  railToggleEl.textContent = (collapsed === left) ? "›" : "‹";
  railToggleEl.title = collapsed ? "Show controls" : "Hide controls";
}
const setRail = collapsed => { document.body.classList.toggle("rail-collapsed", collapsed); reflectRail(); saveState(); };
const setSide = left => { document.body.classList.toggle("rail-left", left); reflectRail(); saveState(); };
railToggleEl.addEventListener("click", ()=> setRail(!railIs("rail-collapsed")));
sideToggleEl.addEventListener("click", ()=> setSide(!railIs("rail-left")));

// ---------- Voice pickers — compact ‹ name › stepper ----------
// primary hand always, second hand appears in free-scale mode
const voiceBPanel = document.getElementById("voiceBPanel");
const voiceALabel = document.getElementById("voiceALabel");
const VOICE_NAMES = Object.keys(VOICES);
function makeStepper(el, get, set){     // returns a reflect() that repaints the shown name from cfg
  const prev=document.createElement("button"); prev.className="stepbtn"; prev.textContent="‹";
  const name=document.createElement("span"); name.className="stepname";
  const next=document.createElement("button"); next.className="stepbtn"; next.textContent="›";
  const reflect=()=>{ name.textContent=get(); };
  const step=d=>{ const i=VOICE_NAMES.indexOf(get()); set(VOICE_NAMES[(i+d+VOICE_NAMES.length)%VOICE_NAMES.length]); reflect(); };
  prev.addEventListener("click", ()=>step(-1)); next.addEventListener("click", ()=>step(1));
  el.append(prev, name, next);
  return reflect;
}
const reflectVoiceA = makeStepper(document.getElementById("voiceA"),
  ()=> state.freeMode ? cfg.voiceFreeL : cfg.voiceChord,
  v=>{ if(state.freeMode) cfg.voiceFreeL=v; else cfg.voiceChord=v; });
const reflectVoiceB = makeStepper(document.getElementById("voiceB"),
  ()=> cfg.voiceFreeR, v=>{ cfg.voiceFreeR=v; });

// ---------- Mode / lock / edit / mute ----------
export function setMode(mode){                              // "chord" | "omni" | "free"
  state.freeMode = mode === "free";
  state.omniMode = mode === "omni";
  modeSel.value = mode;
  scalePanel.style.display = state.freeMode ? "" : "none";
  voiceBPanel.style.display = state.freeMode ? "" : "none";   // second-hand voice only matters in free mode
  voiceALabel.textContent = state.freeMode ? "Left" : "Voice";
  reflectVoiceA(); reflectVoiceB();                 // voice is per-mode
  layoutSel.value = state.freeMode ? cfg.layoutFree : cfg.layoutChord;   // layout is per-mode
  octSel.value = curOct();  octVal.textContent = curOct();     // octaves + columns are per-mode
  colSel.value = curCols(); colVal.textContent = curCols();
  paintRanges();                                   // repaint slider fills for the per-mode values
}
function setLock(on){ state.lockChord = on; lockBtn.classList.toggle("active", on); lockBtn.setAttribute("aria-pressed", on); }
function setEdit(on){
  state.editMode = on;
  editBtn.classList.toggle("active", on); editBtn.setAttribute("aria-pressed", on);
  editBtn.querySelector(".ico").textContent = on ? "✓" : "✥";
  editBtn.querySelector(".lbl").textContent = on ? "done" : "move panels";
  if(!on){
    if(state.twoHandGrab || editState[0].grab || editState[1].grab) saveState();
    state.twoHandGrab = null; state.editWasActive = false;
    for(const st of editState){ st.pinchOn=false; st.prevOn=false; st.grab=null; }
  }
}
function setMute(on){
  state.muted = on;
  setMuteGain(on ? 0 : parseFloat(volEl.value));
}
modeSel.addEventListener("change", ()=> setMode(modeSel.value));
// lock chord is a checkbox row (whole row clicks); move panels is a top util button
lockBtn.closest(".ctrl").addEventListener("click", ()=> setLock(!state.lockChord));
editBtn.addEventListener("click", ()=> setEdit(!state.editMode));
window.addEventListener("keydown", e=>{
  if(e.key==="f"||e.key==="F") setMode(state.freeMode ? "chord" : "free");
  if(e.key==="o"||e.key==="O") setMode(state.omniMode ? "chord" : "omni");
  if(e.key==="l"||e.key==="L") setLock(!state.lockChord);
  if(e.key==="m"||e.key==="M") setMute(!state.muted);
  if(e.key==="e"||e.key==="E") setEdit(!state.editMode);
  if(e.key==="h"||e.key==="H") setLegend(document.body.classList.contains("legend-hidden"));
  if(e.key==="r"||e.key==="R"){ if(confirm("Reset all settings and panel layout to defaults?")){ localStorage.removeItem(LS_KEY); location.reload(); } }
});

// ---------- Persistence (localStorage) ----------
const LS_KEY = "omnichord.settings.v1";
export function saveState(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      cfg, keyRoot: state.keyRoot, scaleName: state.scaleName,
      vol: parseFloat(volEl.value),
      regions: { chord:{...CHORD}, strum:{...regions.strum}, strumFree:{...regions.strumFree} },
      legendHidden: document.body.classList.contains("legend-hidden"),
      railCollapsed: document.body.classList.contains("rail-collapsed"),
      railLeft: document.body.classList.contains("rail-left"),
      hudOpacity: parseFloat(opacitySel.value),
    }));
  }catch(e){ /* private mode / quota — settings just won't persist */ }
}
function syncControls(){     // reflect cfg + state into the HUD inputs
  keySel.value=state.keyRoot; scaleSel.value=state.scaleName;
  orientSel.value=cfg.orientation;
  octSel.value=curOct();   octVal.textContent=curOct();
  colSel.value=curCols();  colVal.textContent=curCols();
  stackSel.value=cfg.extRows; stackVal.textContent=cfg.extRows;
  layoutSel.value = state.freeMode ? cfg.layoutFree : cfg.layoutChord; baseSel.value=cfg.baseOctave;
  reflectVoiceA(); reflectVoiceB();
  revSel.value=cfg.reverb; revVal.textContent=fmt2(cfg.reverb);
  dlySel.value=cfg.delayWet; dlyVal.textContent=fmt2(cfg.delayWet);
  timeSel.value=cfg.delayTime; timeVal.textContent=fmt2(cfg.delayTime);
  fbSel.value=cfg.delayFb; fbVal.textContent=fmt2(cfg.delayFb);
  volVal.textContent=fmt2(parseFloat(volEl.value));
  paintRanges();
  reflectAxes();
  applyHudOpacity();
}
// webkit can't auto-fill a custom range track, so paint the left fill % ourselves
function paintRange(el){
  const min=+el.min||0, max=el.max?+el.max:100;
  el.style.setProperty("--fill", (el.value-min)/(max-min)*100 + "%");
}
function paintRanges(){ hudEl.querySelectorAll("input[type=range]").forEach(paintRange); }
hudEl.addEventListener("input", e=>{ if(e.target.type==="range") paintRange(e.target); });
function loadState(){
  let s; try{ s=JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){ s=null; }
  if(s){
    if(s.cfg) Object.assign(cfg, s.cfg);
    if(typeof s.keyRoot==="number") state.keyRoot=s.keyRoot;
    if(typeof s.scaleName==="string" && SCALES[s.scaleName]) state.scaleName=s.scaleName;
    if(typeof s.vol==="number") volEl.value=s.vol;
    if(typeof s.hudOpacity==="number") opacitySel.value=s.hudOpacity;
    if(s.regions?.chord) Object.assign(CHORD, s.regions.chord);
    if(s.regions?.strum) Object.assign(regions.strum, s.regions.strum);
    if(s.regions?.strumFree) Object.assign(regions.strumFree, s.regions.strumFree);
    if(s.legendHidden) document.body.classList.add("legend-hidden");
    if(s.railLeft) document.body.classList.add("rail-left");
    if(s.railCollapsed) document.body.classList.add("rail-collapsed");
  }
  reflectRail();
  state.currentExt=Math.min(state.currentExt, cfg.extRows-1);
  syncControls();                                    // always reflect cfg into the HUD, even with no saved state
}
hudEl.addEventListener("input", saveState);
hudEl.addEventListener("change", saveState);
loadState();

// ---- drag to move / edges to resize either region (mouse only; hands play) ----
function evToFrac(e){                                // client px -> frame-fraction (object-fit:contain aware)
  const rect = canvas.getBoundingClientRect();
  const W=canvas.width, H=canvas.height;
  const scale = Math.min(rect.width/W, rect.height/H);   // contain: fit the whole frame, letterboxed
  const sW=W*scale, sH=H*scale;
  const offX=(rect.width-sW)/2, offY=(rect.height-sH)/2;
  return { fx:(e.clientX-rect.left-offX)/sW, fy:(e.clientY-rect.top-offY)/sH };
}
function hitEdge(r,fx,fy){
  let e="";
  if(Math.abs(fy-r.y0)<EDGE) e+="n"; else if(Math.abs(fy-r.y1)<EDGE) e+="s";
  if(Math.abs(fx-r.x0)<EDGE) e+="w"; else if(Math.abs(fx-r.x1)<EDGE) e+="e";
  return e;                                          // "" = interior (move), else resize handle
}
const CURSORS = {n:"ns-resize",s:"ns-resize",e:"ew-resize",w:"ew-resize",
  ne:"nesw-resize",sw:"nesw-resize",nw:"nwse-resize",se:"nwse-resize"};
canvas.addEventListener("pointermove", e=>{
  const {fx,fy}=evToFrac(e);
  const d = state.drag;
  if(d){
    const dx=fx-d.fx, dy=fy-d.fy, s=d.start;
    let {x0,x1,y0,y1}=s;
    if(d.mode===""){                                 // move, keeping size, clamped on-screen
      const w=x1-x0,h=y1-y0;
      x0=clampi(x0+dx,0,1-w); x1=x0+w; y0=clampi(y0+dy,0,1-h); y1=y0+h;
    } else {                                          // resize the grabbed edge(s)
      if(d.mode.includes("w")) x0=clampi(Math.min(s.x1-0.06, s.x0+dx),0,1);
      if(d.mode.includes("e")) x1=clampi(Math.max(s.x0+0.06, s.x1+dx),0,1);
      if(d.mode.includes("n")) y0=clampi(Math.min(s.y1-0.06, s.y0+dy),0,1);
      if(d.mode.includes("s")) y1=clampi(Math.max(s.y0+0.06, s.y1+dy),0,1);
    }
    Object.assign(d.target,{x0,x1,y0,y1}); return;
  }
  const r = regionAt(fx,fy);
  state.hoverTarget = r; state.hoverEdge = r ? hitEdge(r,fx,fy) : "";
  canvas.style.cursor = r ? (CURSORS[state.hoverEdge] || "move") : "";
});
canvas.addEventListener("pointerdown", e=>{
  const {fx,fy}=evToFrac(e);
  const r = regionAt(fx,fy);
  if(!r) return;
  state.drag = { target:r, mode:hitEdge(r,fx,fy), fx, fy, start:{...r} };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", ()=>{ if(state.drag) saveState(); state.drag=null; });

// ---------- Chord-name label ----------
export function updateChordLabel(){
  if(state.editMode){
    chordNameEl.firstChild.textContent = "Move panels";
    chordNameEl.style.color = "#ffd479";
    modeEl.textContent = "one hand moves · two hands resize · E to finish";
    return;
  }
  const lock = (state.muted ? " · muted" : "") + (state.lockChord ? " · locked" : "");
  if(state.freeMode){
    chordNameEl.firstChild.textContent = `${NOTE_NAMES[state.keyRoot]} ${state.scaleName}`;
    chordNameEl.style.color = noteColor(state.keyRoot, 72, 85, 1);   // tonic hue
    modeEl.textContent = `free scale${lock}`;
    return;
  }
  if(isOmni()){
    const rootPc = OMNI_ROOT_PC[state.omniRootIdx];
    chordNameEl.firstChild.textContent = `${NOTE_NAMES[rootPc]}${OMNI_QUALITIES[state.omniQual].tag}`;
    chordNameEl.style.color = noteColor(rootPc, 72, 85, 1);
    modeEl.textContent = `omnichord${lock}`;
    return;
  }
  const degOffset = MAJOR[(state.currentDegree-1)%7];
  const rootName = NOTE_NAMES[(state.keyRoot+degOffset)%12];
  chordNameEl.style.color = noteColor(state.keyRoot+degOffset, 72, 85, 1);  // root's scale-degree hue
  chordNameEl.firstChild.textContent = `${rootName}${chordTag(state.currentDegree, state.currentExt)}`;
  modeEl.textContent = `${ROMAN[state.currentDegree]}${["","7","9","11"][state.currentExt]} in ${NOTE_NAMES[state.keyRoot]} major${lock}`;
}
