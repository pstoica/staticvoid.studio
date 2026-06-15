// gl/renderer.js — WebGL renderer for Loom, built on Three.js.
//
// This replaces the Canvas2D draw layer in main.js. The language engine
// (pattern.js) and the spawn→render contract (clock, query, spawn, cull,
// envelope, osc resolution, layout) stay in main.js; this module only consumes
// the per-frame list of live particles and paints them.
//
// Phase 0: scaffold — initialize Three, stay DPR-aware, clear to the background
// colour each frame. Instanced glyphs, real perspective, per-group render
// targets, and the patternable FX chain arrive in later phases.

import * as THREE from 'three';

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      premultipliedAlpha: false,
    });
    this.renderer.autoClear = false;          // we manage clears per pass ourselves
    this.bg = new THREE.Color('#06070a');

    // A flat scene viewed through an orthographic camera in *pixel* space:
    // (0,0) top-left, (W,H) bottom-right — matching Canvas2D's coordinate frame
    // so the existing layout maths (resolvePos, in CSS pixels) ports unchanged.
    // A later phase swaps in a PerspectiveCamera for per-glyph 3D tilt.
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    this.W = 1; this.H = 1; this.DPR = 1;
  }

  resize(W, H, DPR) {
    this.W = W; this.H = H; this.DPR = DPR;
    this.renderer.setPixelRatio(DPR);
    this.renderer.setSize(W, H, false);       // false: don't touch CSS — canvas is sized by layout
    const cam = this.camera;                   // y grows downward, like Canvas2D
    cam.left = 0; cam.right = W; cam.top = 0; cam.bottom = H;
    cam.updateProjectionMatrix();
  }

  setBackground(css) {
    try { this.bg.set(css); } catch { /* keep previous colour if unparseable */ }
  }

  // `state` carries the per-frame data from main.js (live particles, geometry,
  // cycle, toggles). P0 only needs the background; later phases consume the rest.
  render(/* state */) {
    const r = this.renderer;
    r.setClearColor(this.bg, 1);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);        // empty scene in P0
  }

  dispose() { this.renderer.dispose(); }
}
