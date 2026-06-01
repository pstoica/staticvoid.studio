// Shared DOM elements used across modules. The HUD-specific elements (selects,
// sliders, legend, intro) are owned by ui.js; these three are the canvas/video
// surface plus the status line, which several modules touch.
export const video    = document.getElementById("cam");
export const canvas   = document.getElementById("overlay");
export const ctx      = canvas.getContext("2d");
export const statusEl = document.getElementById("status");
