// Key/scale tables, diatonic chord logic, and the Omnichord OM-108 grid.
// All note math is indexed in scale degrees so transposition stays in key.
import { state, cfg } from "./state.js";

// ---------- Music theory ----------
export const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
export const MAJOR = [0,2,4,5,7,9,11];                  // major scale steps
// diatonic triad intervals per scale degree (1..7) in a major key
export const TRIAD = {
  1:[0,4,7],  2:[0,3,7],  3:[0,3,7],  4:[0,4,7],
  5:[0,4,7],  6:[0,3,7],  7:[0,3,6]
};
export const SEVENTH = { 1:11, 2:10, 3:10, 4:11, 5:10, 6:10, 7:10 };
export const ROMAN = {1:"I",2:"ii",3:"iii",4:"IV",5:"V",6:"vi",7:"vii°"};

// Chord-palette columns, left→right, walking the diatonic circle of fifths
// (each step up a perfect fifth): IV I V ii vi iii vii°. Puts the primary triads
// IV-I-V together and makes ii–V–I / vi–ii–V–I turnarounds adjacent left-sweeps.
export const DEGREE_ORDER = [4, 1, 5, 2, 6, 3, 7];
export const degRoot = deg => (state.keyRoot + MAJOR[(deg-1)%7]) % 12;   // pitch class of a degree's root

// ---------- Authentic Suzuki OM-108 chord layout ----------
// 12 absolute roots across the circle of fifths (matches the real faceplate, left→right),
// crossed with three chord-quality rows (Major / Minor / 7th). Unlike the diatonic palette,
// these are fixed chords independent of the chosen key.
export const OMNI_ROOT_PC = [1,8,3,10,5,0,7,2,9,4,11,6];          // Db Ab Eb Bb F C G D A E B F#
export const OMNI_QUALITIES = [
  { tag:"",  tones:[0,4,7] },                              // major
  { tag:"m", tones:[0,3,7] },                              // minor
  { tag:"7", tones:[0,4,7,10] },                           // dominant 7th
];
export const isOmni = () => state.omniMode;
export function omniTones(){ return OMNI_QUALITIES[state.omniQual].tones; }
export function omniCellNote(r){                                  // chord tones stacked across octaves
  const tones = omniTones(), n = tones.length, rootPc = OMNI_ROOT_PC[state.omniRootIdx];
  return (cfg.baseOctave+1)*12 + rootPc + tones[((r%n)+n)%n] + 12*Math.floor(r/n);
}

export const SCALES = {
  "Major":[0,2,4,5,7,9,11],
  "Minor (natural)":[0,2,3,5,7,8,10],
  "Major Pentatonic":[0,2,4,7,9],
  "Minor Pentatonic":[0,3,5,7,10],
  "Blues":[0,3,5,6,7,10],
  "Dorian":[0,2,3,5,7,9,10],
};

export const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

// ---------- Scale-locked note model ----------
// Everything is indexed in *scale degrees*, so all transposition stays in key.
export function activeSteps(){ return state.freeMode ? SCALES[state.scaleName] : MAJOR; }
export const curOct  = () => state.freeMode ? cfg.octavesFree : cfg.octavesChord;   // octaves + columns are per-mode
export const curCols = () => state.freeMode ? cfg.colsFree    : cfg.colsChord;
export function scaleLen(){ return activeSteps().length; }
export function tonicMidi(){ return (cfg.baseOctave+1)*12 + state.keyRoot; }
export function scaleNote(step){                                // step = scale degrees above tonic
  const s = activeSteps(), n = s.length;
  const oct = Math.floor(step / n), i = ((step % n) + n) % n;
  return tonicMidi() + s[i] + 12*oct;
}
// chord tones as scale-thirds: triad 1-3-5, then 7/9/11
export function chordToneSteps(){
  const t = [0,2,4];
  if(state.currentExt>=1) t.push(6);
  if(state.currentExt>=2) t.push(8);
  if(state.currentExt>=3) t.push(10);
  return t;
}
// column offset in scale degrees -> 4th=3, 5th=4 are diatonic (stay in key)
export function colSteps(){
  switch(state.freeMode ? cfg.layoutFree : cfg.layoutChord){
    case "4th": return 3;
    case "5th": return 4;
    case "oct": return scaleLen();
    case "cont": return scaleLen()*curOct();
    default: return 3;
  }
}
export function rowsPerCol(){
  if(isOmni()) return curOct()*omniTones().length + 1;
  return state.freeMode ? curOct()*scaleLen() + 1
                  : curOct()*chordToneSteps().length + 1;
}
export function cellNote(line, r){
  if(state.freeMode) return scaleNote(r + colSteps()*line);
  if(isOmni()) return omniCellNote(r);
  const tones = chordToneSteps(), n = tones.length;
  const rootDeg = state.currentDegree - 1;               // 0-based scale degree of chord root
  const step = rootDeg + tones[((r%n)+n)%n] + scaleLen()*Math.floor(r/n) + colSteps()*line;
  return scaleNote(step);
}

// compact chord suffix matching the palette cell labels (m / ° + 7·9·11)
export function chordTag(deg, ext){
  const minor = TRIAD[deg][1]===3, dim = deg===7;
  return (dim ? "°" : (minor ? "m" : "")) + ["","7","9","11"][ext];
}
