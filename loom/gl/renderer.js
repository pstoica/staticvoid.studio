// gl/renderer.js — WebGL renderer for Loom, built on Three.js.
//
// Replaces the Canvas2D draw layer in main.js. The language engine (pattern.js)
// and the spawn→render contract (clock, query, spawn, cull, envelope, osc
// resolution, layout) stay in main.js; this module consumes the per-frame list
// of live particles and paints them on the GPU.
//
// Phase 1: instanced glyph rendering. One draw call per blend mode, each
// covering all of that bucket's glyphs as instances of a single quad. An SDF
// fragment shader renders every shape (circle, ring, arc, polygons, star, plus,
// line, cross) with independent fill/stroke, weight, and `open` gap. Per-glyph
// live values (osc mods) are resolved on the CPU in main.js and packed into the
// instance attributes here. Perspective tilt, group render targets, and the FX
// chain arrive in later phases.

import * as THREE from 'three';

// shape name → SDF id (kept in sync with the switch in the fragment shader and
// with SHAPE_ID in main.js).  0 circle/dot · 1 ring · 2 arc · 3 square/box ·
// 4 tri · 5 pent · 6 hex · 7 star · 8 plus · 9 line · 10 cross
const QUAD_POS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);

// instance attributes: name → component count
const IATTRS = {
  iPos: 2, iRadius: 1, iRot: 1, iColor: 3, iAlpha: 1,
  iWeight: 1, iOpen: 1, iShape: 1, iFill: 1, iStroke: 1,
};

const VERT = `
precision highp float;
uniform mat4 projectionMatrix;  // supplied by three for the active camera
uniform mat4 modelViewMatrix;
attribute vec3 position;        // quad corner in -1..1
attribute vec2 iPos;            // glyph centre, pixel space
attribute float iRadius;        // glyph radius, px
attribute float iRot;           // z rotation, radians
attribute vec3 iColor;          // rgb 0..1 (sRGB)
attribute float iAlpha;         // 0..1, envelope already folded in
attribute float iWeight;        // stroke width (full), px
attribute float iOpen;          // arc/line gap 0..1
attribute float iShape;         // shape id
attribute float iFill;          // 0/1
attribute float iStroke;        // 0/1
varying vec2 vLocal;            // shape-space coordinate, px (pre-rotation)
varying float vR, vWeight, vOpen, vShape, vFill, vStroke, vAlpha;
varying vec3 vColor;
void main() {
  float pad = iWeight * 0.5 + 2.0;          // stroke half-width + AA margin
  float ext = iRadius + pad;                 // quad half-extent, px
  vec2 local = position.xy * ext;            // shape-space position, px
  vLocal = local;
  float c = cos(iRot), s = sin(iRot);
  vec2 world = iPos + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 0.0, 1.0);
  vR = iRadius; vWeight = iWeight; vOpen = iOpen; vShape = iShape;
  vFill = iFill; vStroke = iStroke; vAlpha = iAlpha; vColor = iColor;
}`;

const FRAG = `
precision highp float;
#define PI 3.14159265359
#define TAU 6.28318530718
varying vec2 vLocal;
varying float vR, vWeight, vOpen, vShape, vFill, vStroke, vAlpha;
varying vec3 vColor;

vec2 rot2(vec2 p, float a){ float c=cos(a), s=sin(a); return vec2(p.x*c-p.y*s, p.x*s+p.y*c); }

float sdSeg(vec2 p, vec2 a, vec2 b){
  vec2 pa = p-a, ba = b-a;
  float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
  return length(pa - ba*h);
}
// regular convex polygon, flat-topped (an edge perpendicular to +y)
float sdNgonFlat(vec2 p, float r, float n){
  float ap = PI/n;
  float a = atan(p.x, p.y);
  a = mod(a + ap, 2.0*ap) - ap;
  float d = length(p);
  vec2 q = vec2(sin(a), cos(a)) * d;
  float apo = r*cos(ap);
  q.x = abs(q.x);
  vec2 e = vec2(q.x - clamp(q.x, 0.0, r*sin(ap)), q.y - apo);
  return length(e) * sign(q.y - apo);
}
// vertex-topped regular polygon (matches the 2D poly(): first vertex at top)
float sdNgon(vec2 p, float r, float n){ return sdNgonFlat(rot2(p, PI/n), r, n); }
// iq star: n points, m in [2,n] controls pointiness
float sdStar(vec2 p, float r, float n, float m){
  float an = PI/n;
  float en = PI/m;
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0*an) - an;
  p = length(p)*vec2(cos(bn), abs(sin(bn)));
  p -= r*acs;
  p += ecs*clamp(-dot(p, ecs), 0.0, r*acs.y/ecs.y);
  return length(p)*sign(p.x);
}
// plus / cross polygon: b = (arm length, arm half-thickness)
float sdPlus(vec2 p, vec2 b){
  p = abs(p);
  p = (p.y > p.x) ? p.yx : p.xy;
  vec2 q = p - b;
  float k = max(q.y, q.x);
  vec2 w = (k > 0.0) ? q : vec2(b.y - p.x, -k);
  return sign(k)*length(max(w, 0.0));
}

void main(){
  // work in maths space (y up) so polygon "up" matches the 2D vertex-up look
  vec2 q = vec2(vLocal.x, -vLocal.y);
  int id = int(vShape + 0.5);
  float d;               // signed distance: <0 inside (or unsigned for open curves)
  bool openCurve = false;
  if (id == 0) {                         // circle / dot
    d = length(q) - vR;
  } else if (id == 1) {                  // ring
    d = abs(length(q) - vR); openCurve = true;
  } else if (id == 2) {                  // arc (ring with a gap from the top)
    float a0 = PI*0.5;
    float span = (1.0 - vOpen) * TAU;
    float dphi = mod(a0 - atan(q.y, q.x), TAU);
    if (dphi <= span) { d = abs(length(q) - vR); }
    else {
      vec2 e0 = vR*vec2(cos(a0), sin(a0));
      vec2 e1 = vR*vec2(cos(a0-span), sin(a0-span));
      d = min(length(q-e0), length(q-e1));
    }
    openCurve = true;
  } else if (id == 3) {                  // square / box
    vec2 dd = abs(q) - vec2(vR);
    d = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
  } else if (id == 4) {                  // tri
    d = sdNgon(q, vR, 3.0);
  } else if (id == 5) {                  // pent
    d = sdNgon(q, vR, 5.0);
  } else if (id == 6) {                  // hex
    d = sdNgon(q, vR, 6.0);
  } else if (id == 7) {                  // star (10 verts, inner ratio ~0.45)
    d = sdStar(q, vR, 5.0, 2.6);
  } else if (id == 8) {                  // plus
    d = sdPlus(q, vec2(vR, vR*0.38));
  } else if (id == 9) {                  // line
    float h = (1.0 - vOpen) * vR;
    d = sdSeg(q, vec2(-h, 0.0), vec2(h, 0.0)); openCurve = true;
  } else {                               // cross (X)
    d = min(sdSeg(q, vec2(-vR,-vR), vec2(vR,vR)), sdSeg(q, vec2(vR,-vR), vec2(-vR,vR)));
    openCurve = true;
  }

  float aa = 1.0;                        // AA half-width in px
  float hw = max(vWeight*0.5, 0.5);      // stroke half-width
  float cov;
  if (openCurve) {                       // outline curves: stroke band only
    cov = vStroke * (1.0 - smoothstep(hw - aa, hw + aa, d));
  } else {
    float fillCov = vFill * (1.0 - smoothstep(-aa, aa, d));
    float strokeCov = vStroke * (1.0 - smoothstep(hw - aa, hw + aa, abs(d)));
    cov = max(fillCov, strokeCov);
  }
  if (cov <= 0.0) discard;
  float a = clamp(vAlpha * cov, 0.0, 1.0);
  gl_FragColor = vec4(vColor * a, a);     // premultiplied — blends set the factors
}`;

// blend mode → bucket key. Buckets draw in BLEND_ORDER (additive/screen last so
// glows sit on top); within a bucket, age order (newest last) is preserved.
const BLEND_ORDER = ['normal', 'multiply', 'screen', 'additive'];
function blendKey(b) {
  if (b === 'lighter') return 'additive';
  if (b === 'screen') return 'screen';
  if (b === 'multiply') return 'multiply';
  return 'normal';
}

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer: keeps the last frame readable for screenshots/saving
    // (and for tooling that drives frames manually while rAF is paused).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    this.renderer.autoClear = false;
    this.bg = new THREE.Color('#06070a');

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    this.W = 1; this.H = 1; this.DPR = 1;

    // one geometry, refilled per blend bucket each frame
    this.geom = new THREE.InstancedBufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(QUAD_POS, 3));
    this.geom.setIndex(new THREE.BufferAttribute(QUAD_IDX, 1));
    this.geom.instanceCount = 0;
    this.cap = 0;
    this.arrays = {};         // name → Float32Array
    this._ensureCapacity(4096);

    // a material per blend mode (premultiplied output → custom blend factors)
    // DoubleSide: the pixel-space ortho camera flips Y (top<bottom), which
    // inverts triangle winding — without this, front-face culling drops every quad.
    const base = { vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide };
    const F = THREE;
    const mk = (src, dst, srcA, dstA) => {
      const m = new THREE.RawShaderMaterial(base);
      m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
      m.blendSrc = src; m.blendDst = dst;
      m.blendSrcAlpha = srcA != null ? srcA : src; m.blendDstAlpha = dstA != null ? dstA : dst;
      return m;
    };
    this.materials = {
      normal:   mk(F.OneFactor, F.OneMinusSrcAlphaFactor),
      additive: mk(F.OneFactor, F.OneFactor),
      screen:   mk(F.OneFactor, F.OneMinusSrcColorFactor, F.OneFactor, F.OneMinusSrcAlphaFactor),
      multiply: mk(F.DstColorFactor, F.OneMinusSrcAlphaFactor),
    };

    this.mesh = new THREE.Mesh(this.geom, this.materials.normal);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this._scratch = { x: 0, y: 0, r: 0, rot: 0, rgb: [1, 1, 1], alpha: 1, weight: 1, open: 0, shape: 0, fill: 1, stroke: 0, blend: 'source-over' };
  }

  _ensureCapacity(n) {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2, 4096);
    for (const [name, size] of Object.entries(IATTRS)) {
      const arr = new Float32Array(cap * size);
      this.arrays[name] = arr;
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.geom.setAttribute(name, attr);
    }
    this.cap = cap;
  }

  resize(W, H, DPR) {
    this.W = W; this.H = H; this.DPR = DPR;
    this.renderer.setPixelRatio(DPR);
    this.renderer.setSize(W, H, false);
    const cam = this.camera;            // y grows downward, like Canvas2D
    cam.left = 0; cam.right = W; cam.top = 0; cam.bottom = H;
    cam.updateProjectionMatrix();
  }

  setBackground(css) { try { this.bg.set(css); } catch { /* keep previous */ } }

  // state: { live, minDim, resolve }  — resolve(p, minDim, out) fills `out` with
  // the glyph's effective draw values (live oscillators already applied).
  render(state) {
    const r = this.renderer;
    r.setClearColor(this.bg, 1);
    r.clear(true, true, true);
    const live = state && state.live;
    if (!live || !live.length) return;

    this._ensureCapacity(live.length);
    const out = this._scratch;
    const { minDim, resolve } = state;

    for (const key of BLEND_ORDER) {
      let count = 0;
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        if (blendKey(p.blend) !== key) continue;
        resolve(p, minDim, out);
        const a = this.arrays;
        a.iPos[count * 2] = out.x; a.iPos[count * 2 + 1] = out.y;
        a.iRadius[count] = out.r;
        a.iRot[count] = out.rot;
        a.iColor[count * 3] = out.rgb[0]; a.iColor[count * 3 + 1] = out.rgb[1]; a.iColor[count * 3 + 2] = out.rgb[2];
        a.iAlpha[count] = out.alpha;
        a.iWeight[count] = out.weight;
        a.iOpen[count] = out.open;
        a.iShape[count] = out.shape;
        a.iFill[count] = out.fill;
        a.iStroke[count] = out.stroke;
        count++;
      }
      if (!count) continue;
      for (const name of Object.keys(IATTRS)) {
        const attr = this.geom.getAttribute(name);
        attr.needsUpdate = true;
        attr.addUpdateRange ? (attr.clearUpdateRanges?.(), attr.addUpdateRange(0, count * IATTRS[name])) : (attr.updateRange = { offset: 0, count: count * IATTRS[name] });
      }
      this.geom.instanceCount = count;
      this.mesh.material = this.materials[key];
      r.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.geom.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    this.renderer.dispose();
  }
}
