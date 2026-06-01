// Region geometry: which screen-fraction rectangle is the active strum plate,
// hit-testing, and the mouse-drag edge band. Shared by gesture, render, and ui.
import { state, regions, CHORD } from "./state.js";

export const EDGE = 0.018;                            // edge grab band, in screen-fraction
export const plate = () => state.freeMode ? regions.strumFree : regions.strum;   // active strum plate per mode
export const inRect = (r,mx,my)=> mx>=r.x0 && mx<=r.x1 && my>=r.y0 && my<=r.y1;
export function inPlate(mx,my){ return inRect(plate(),mx,my); }
export const nearRect = (r,fx,fy)=> fx>=r.x0-EDGE&&fx<=r.x1+EDGE&&fy>=r.y0-EDGE&&fy<=r.y1+EDGE;
export const regionAt = (fx,fy)=> nearRect(plate(),fx,fy) ? plate()
  : (!state.freeMode && nearRect(CHORD,fx,fy) ? CHORD : null);   // palette only draggable in chord mode
