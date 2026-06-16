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
  iPos: 2, iRadius: 1, iRot: 1, iRotX: 1, iRotY: 1, iColor: 3, iAlpha: 1,
  iWeight: 1, iOpen: 1, iShape: 1, iFill: 1, iStroke: 1, iVertex: 1, iCap: 1,
};
const TRACE_CAP = 8192;         // max points in the trace polyline

const VERT = `
precision highp float;
uniform vec2 uResolution;       // viewport in CSS px (W, H); pixel→NDC mapping
attribute vec3 position;        // quad corner in -1..1
attribute vec2 iPos;            // glyph centre, pixel space
attribute float iRadius;        // glyph radius, px
attribute float iRot;           // z rotation / spin, radians
attribute float iRotX;          // 3D tilt around horizontal axis, radians
attribute float iRotY;          // 3D tilt around vertical axis, radians
attribute vec3 iColor;          // rgb 0..1 (sRGB)
attribute float iAlpha;         // 0..1, envelope already folded in
attribute float iWeight;        // stroke width (full), px
attribute float iOpen;          // arc/line gap 0..1
attribute float iShape;         // shape id
attribute float iFill;          // 0/1
attribute float iStroke;        // 0/1
attribute float iVertex;        // 0/1 — dot at each vertex
attribute float iCap;           // line/cross caps: 0 round, 1 butt, 2 square
varying vec2 vLocal;            // shape-space coordinate, px (un-rotated)
varying float vR, vWeight, vOpen, vShape, vFill, vStroke, vVertex, vCap, vAlpha;
varying vec3 vColor;
void main() {
  float pad = iWeight * 0.5 + 2.0;          // stroke half-width + AA margin
  // a line's length scales with open ((1-open)*r), and open can exceed 1 (e.g.
  // .open(5) draws a streak 4x the radius) — size the quad to contain it.
  float reach = (int(iShape + 0.5) == 9) ? abs(1.0 - iOpen) * iRadius : iRadius;
  float ext = reach + pad;                   // quad half-extent, px
  vec2 local = position.xy * ext;            // shape-space position, px (flat, z=0)
  vLocal = local;

  // Per-glyph pinhole, matching the Canvas2D drawShape3D: tilt the flat quad in
  // 3D (X then Y), then project; the Z spin happens in screen space afterward.
  // Emitting the perspective divide through gl_Position.w (rather than dividing
  // here) makes the rasteriser interpolate vLocal perspective-correctly, so the
  // SDF rides the tilted plane exactly. With rotX=rotY=0 this is the flat ortho.
  float cx = cos(iRotX), sx = sin(iRotX), cy = cos(iRotY), sy = sin(iRotY);
  float x = local.x;
  float y = local.y * cx;
  float z = local.y * sx;
  float x2 = x * cy + z * sy; z = -x * sy + z * cy; x = x2;
  float d = 2.6 * max(1.0, iRadius);         // camera distance, px
  float w = max((d - z) / d, 0.01);          // homogeneous depth (1 when flat)
  float cz = cos(iRot), sz = sin(iRot);      // Z spin, screen space
  vec2 N = vec2(x * cz - y * sz, x * sz + y * cz);
  vec2 P = N + iPos * w;                      // offset is perspective, centre is affine (×w)
  gl_Position = vec4(
    2.0 * P.x / uResolution.x - w,            // ÷w later → 2·world.x/W − 1
    w - 2.0 * P.y / uResolution.y,            // ÷w later → 1 − 2·world.y/H (y down)
    0.0,
    w
  );
  vR = iRadius; vWeight = iWeight; vOpen = iOpen; vShape = iShape;
  vFill = iFill; vStroke = iStroke; vVertex = iVertex; vCap = iCap; vAlpha = iAlpha; vColor = iColor;
}`;

const FRAG = `
precision highp float;
#define PI 3.14159265359
#define TAU 6.28318530718
varying vec2 vLocal;
varying float vR, vWeight, vOpen, vShape, vFill, vStroke, vVertex, vCap, vAlpha;
varying vec3 vColor;

vec2 rot2(vec2 p, float a){ float c=cos(a), s=sin(a); return vec2(p.x*c-p.y*s, p.x*s+p.y*c); }

// distance to the nearest of a shape's vertices (maths space, vertex-up), for the
// .vertex() draw mode — a filled dot at each vertex.
float vertDist(vec2 q, int id, float r, float open) {
  if (id == 3 || id == 10) { vec2 c = abs(q) - r; return length(c); }          // square / cross corners
  if (id == 4 || id == 5 || id == 7) {                                          // tri / pent / star (outer pts)
    float n = id == 4 ? 3.0 : 5.0;
    float seg = 6.28318530718 / n;
    float a = atan(q.x, q.y); a = mod(a + seg * 0.5, seg) - seg * 0.5;
    return length(vec2(sin(a), cos(a)) * length(q) - vec2(0.0, r));
  }
  if (id == 6) {                                                                // hex
    float seg = 6.28318530718 / 6.0;
    float a = atan(q.x, q.y); a = mod(a + seg * 0.5, seg) - seg * 0.5;
    return length(vec2(sin(a), cos(a)) * length(q) - vec2(0.0, r));
  }
  if (id == 8) { vec2 aq = abs(q); return min(length(aq - vec2(0.0, r)), length(aq - vec2(r, 0.0))); } // plus tips
  if (id == 9) { float h = (1.0 - open) * r; return min(length(q - vec2(h, 0.0)), length(q - vec2(-h, 0.0))); } // line ends
  return abs(length(q) - r);                                                    // circle/ring/arc → dotted ring
}

float sdSeg(vec2 p, vec2 a, vec2 b){
  vec2 pa = p-a, ba = b-a;
  float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
  return length(pa - ba*h);
}
// signed distance to a *stroked* segment with caps: 0 round, 1 butt (flat at the
// endpoint), 2 square (flat, extended by the half-width). Returns the thickened
// stroke SDF (<0 inside), so caps are real geometry rather than always round.
float sdSegCap(vec2 p, vec2 a, vec2 b, float hw, int cap){
  vec2 ba = b - a; float len = max(length(ba), 1e-5); vec2 dir = ba / len;
  vec2 pa = p - a;
  float t = dot(pa, dir);
  if (cap == 0) return length(pa - dir * clamp(t, 0.0, len)) - hw;   // round
  float ext = (cap == 2) ? hw : 0.0;                                  // square extends, butt doesn't
  float dx = max(-(t + ext), t - (len + ext));
  float dy = abs(dot(pa, vec2(-dir.y, dir.x))) - hw;
  return min(max(dx, dy), 0.0) + length(max(vec2(dx, dy), 0.0));
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
  bool capped = false;   // line/cross: d is already the thickened, capped stroke
  float hw = max(vWeight*0.5, 0.5);      // stroke half-width
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
  } else if (id == 9) {                  // line (open scales the length; capped)
    float h = (1.0 - vOpen) * vR;
    d = sdSegCap(q, vec2(h, 0.0), vec2(-h, 0.0), hw, int(vCap + 0.5)); capped = true;
  } else {                               // cross (X; capped)
    int cp = int(vCap + 0.5);
    d = min(sdSegCap(q, vec2(-vR,-vR), vec2(vR,vR), hw, cp), sdSegCap(q, vec2(vR,-vR), vec2(-vR,vR), hw, cp));
    capped = true;
  }

  float aa = 1.0;                        // AA half-width in px
  float cov;
  if (capped) {                          // line/cross: d is the thickened stroke → fill it
    cov = vStroke * (1.0 - smoothstep(-aa, aa, d));
  } else if (openCurve) {                // ring/arc outline: stroke band
    cov = vStroke * (1.0 - smoothstep(hw - aa, hw + aa, d));
  } else {
    float fillCov = vFill * (1.0 - smoothstep(-aa, aa, d));
    float strokeCov = vStroke * (1.0 - smoothstep(hw - aa, hw + aa, abs(d)));
    cov = max(fillCov, strokeCov);
  }
  if (vVertex > 0.5) {                    // dot at each vertex (filled)
    float vr = max(vWeight * 1.5, 2.0);
    float vd = vertDist(q, id, vR, vOpen);
    cov = max(cov, 1.0 - smoothstep(vr - aa, vr + aa, vd));
  }
  if (cov <= 0.0) discard;
  float a = clamp(vAlpha * cov, 0.0, 1.0);
  gl_FragColor = vec4(vColor * a, a);     // premultiplied — blends set the factors
}`;

// ── fullscreen post-process passes (per-group FX chain) ──────────────────────────
// A single big triangle covering the screen; `vUv` is 0..1. Each FX is a fragment
// shader sampling the previous pass's texture (tMap). Passes ping-pong between two
// render targets per group, then a final composite blits the result to the screen.
const FS_VERT = `
precision highp float;
attribute vec3 position;        // clip-space corner (z unused; 3-comp avoids NaN bounds)
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COPY_FRAG = `
precision highp float;
uniform sampler2D tMap;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tMap, vUv); }`;

// pixelate: snap to block centre and sample the mip level whose texel ≈ the block
// size, i.e. a true hardware area-average per block — isotropic (no bias toward
// block centres) and temporally stable (no shimmer from sparse manual taps).
// GLSL3 for textureLod; trilinear keeps it smooth as the block size oscillates.
const FS_VERT3 = `
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const PIXELATE_FRAG3 = `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uTexel;       // 1 / target size, device px
uniform float uBlock;      // block size, device px
uniform float uLod;        // log2(uBlock) — mip level to average over
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 px = vUv / uTexel;
  vec2 center = (floor(px / uBlock) + 0.5) * uBlock * uTexel;
  fragColor = textureLod(tMap, center, uLod);
}`;

// separable gaussian blur (9 taps); run once horizontal, once vertical
const BLUR_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uTexel;
uniform vec2 uDir;         // (1,0) horizontal | (0,1) vertical
uniform float uRadius;     // spread, device px
varying vec2 vUv;
void main() {
  vec4 sum = vec4(0.0); float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 8.0);
    vec2 off = uDir * uTexel * fi * (uRadius * 0.25);
    sum += texture2D(tMap, vUv + off) * w; wsum += w;
  }
  gl_FragColor = sum / wsum;
}`;

// feedback / trails: composite the current layer over a transformed copy of the
// previous accumulated frame (zoom + rotate about centre, faded). Premultiplied.
const FEEDBACK_FRAG = `
precision highp float;
uniform sampler2D tMap;    // current layer
uniform sampler2D tHist;   // previous accumulation
uniform float uFade, uZoom, uRot;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float c = cos(uRot), s = sin(uRot);
  vec2 pr = vec2(c * p.x - s * p.y, s * p.x + c * p.y) / max(uZoom, 0.001);
  vec4 hist = texture2D(tHist, pr + 0.5);
  vec4 cur = texture2D(tMap, vUv);
  // current OVER faded history (premultiplied): trails decay instead of blowing
  // out to white, while zoom/rot still build the tunnel.
  gl_FragColor = clamp(cur + hist * uFade * (1.0 - cur.a), 0.0, 1.0);
}`;

// colour grade: hue (turns), saturate (0..), contrast (1=id), brightness (1=id).
// input/output premultiplied, so unpremultiply → grade → repremultiply.
const GRADE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uHue, uBright, uContrast, uSat;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(tMap, vUv);
  float a = t.a;
  vec3 col = a > 0.0 ? t.rgb / a : t.rgb;
  float ang = uHue * 6.28318530718;                 // hue rotate in YIQ
  float Y = dot(col, vec3(0.299, 0.587, 0.114));
  float I = dot(col, vec3(0.595716, -0.274453, -0.321263));
  float Q = dot(col, vec3(0.211456, -0.522591, 0.311135));
  float c = cos(ang), s = sin(ang);
  float I2 = I * c - Q * s, Q2 = I * s + Q * c;
  col = vec3(Y + 0.9563 * I2 + 0.6210 * Q2, Y - 0.2721 * I2 - 0.6474 * Q2, Y - 1.1070 * I2 + 1.7046 * Q2);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSat);                     // saturate
  col = (col - 0.5) * uContrast + 0.5;               // contrast
  col *= uBright;                                     // brightness
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

// displacement: warp the sample coordinate with a moving sinusoid field
const DISPLACE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uAmount, uScale, uTime;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  float fx = sin((uv.y * uScale + uTime) * 6.28318530718);
  float fy = cos((uv.x * uScale + uTime) * 6.28318530718);
  gl_FragColor = texture2D(tMap, uv + vec2(fx, fy) * uAmount);
}`;

// kaleidoscope: fold the plane into N mirrored wedges about the centre
const KALEIDO_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uSlices;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p);
  float a = atan(p.y, p.x);
  float seg = 6.28318530718 / max(uSlices, 1.0);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  gl_FragColor = texture2D(tMap, vec2(cos(a), sin(a)) * r + 0.5);
}`;

// mirror: left/right symmetry about the vertical centre
const MIRROR_FRAG = `
precision highp float;
uniform sampler2D tMap;
varying vec2 vUv;
void main() {
  vec2 uv = vUv; uv.x = max(uv.x, 1.0 - uv.x);
  gl_FragColor = texture2D(tMap, uv);
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
    this.uniforms = { uResolution: { value: new THREE.Vector2(1, 1) } };
    // DoubleSide: the pixel-space projection flips Y, which inverts triangle
    // winding — without this, front-face culling drops every quad.
    const base = { uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide };
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

    // overlay scene (playhead + trace), drawn behind the glyphs with the ortho
    // camera (which maps pixel-space world coords → NDC). Both are thin lines.
    this.overlay = new THREE.Scene();
    const playGeom = new THREE.BufferGeometry();
    playGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.playhead = new THREE.Line(playGeom, new THREE.LineBasicMaterial({ color: 0x9db4ff, transparent: true, opacity: 0.18, depthTest: false, depthWrite: false }));
    this.playhead.frustumCulled = false; this.playhead.visible = false;
    this.overlay.add(this.playhead);

    const traceGeom = new THREE.BufferGeometry();
    traceGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACE_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    traceGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRACE_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    traceGeom.setDrawRange(0, 0);
    this.trace = new THREE.Line(traceGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false }));
    this.trace.frustumCulled = false; this.trace.visible = false;
    this.overlay.add(this.trace);

    // fullscreen-pass scene (post-process FX). One big triangle; `position` is the
    // clip-space coord, so no camera transform is needed.
    this.fsScene = new THREE.Scene();
    const fsGeom = new THREE.BufferGeometry();
    fsGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const fsMat = (frag, uniforms) => new THREE.RawShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    const V2 = () => new THREE.Vector2();
    this.fx = {
      copy: fsMat(COPY_FRAG, { tMap: { value: null } }),
      pixelate: new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT3, fragmentShader: PIXELATE_FRAG3, uniforms: { tMap: { value: null }, uTexel: { value: V2() }, uBlock: { value: 1 }, uLod: { value: 0 } }, depthTest: false, depthWrite: false }),
      blur: fsMat(BLUR_FRAG, { tMap: { value: null }, uTexel: { value: V2() }, uDir: { value: V2() }, uRadius: { value: 4 } }),
      feedback: fsMat(FEEDBACK_FRAG, { tMap: { value: null }, tHist: { value: null }, uFade: { value: 0.92 }, uZoom: { value: 1 }, uRot: { value: 0 } }),
      grade: fsMat(GRADE_FRAG, { tMap: { value: null }, uHue: { value: 0 }, uBright: { value: 1 }, uContrast: { value: 1 }, uSat: { value: 1 } }),
      displace: fsMat(DISPLACE_FRAG, { tMap: { value: null }, uAmount: { value: 0.02 }, uScale: { value: 3 }, uTime: { value: 0 } }),
      kaleido: fsMat(KALEIDO_FRAG, { tMap: { value: null }, uSlices: { value: 6 } }),
      mirror: fsMat(MIRROR_FRAG, { tMap: { value: null } }),
    };
    this.fsMesh = new THREE.Mesh(fsGeom, this.fx.copy);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    this.groupRTs = new Map();   // gid → { a, b, w, h } ping-pong targets

    this._scratch = { x: 0, y: 0, r: 0, rot: 0, rotX: 0, rotY: 0, rgb: [1, 1, 1], alpha: 1, weight: 1, open: 0, shape: 0, fill: 1, stroke: 0, blend: 'source-over' };
  }

  _getGroupRT(gid) {
    const dw = Math.max(1, Math.round(this.W * this.DPR)), dh = Math.max(1, Math.round(this.H * this.DPR));
    let rt = this.groupRTs.get(gid);
    if (!rt || rt.w !== dw || rt.h !== dh) {
      if (rt) { rt.a.dispose(); rt.b.dispose(); if (rt.hist) { rt.hist[0].dispose(); rt.hist[1].dispose(); } if (rt.mip) rt.mip.dispose(); }
      const opt = { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      rt = { a: new THREE.WebGLRenderTarget(dw, dh, opt), b: new THREE.WebGLRenderTarget(dw, dh, opt), w: dw, h: dh };
      this.groupRTs.set(gid, rt);
    }
    return rt;
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
    this.uniforms.uResolution.value.set(W, H);
    const cam = this.camera;            // y grows downward, like Canvas2D (used for the line overlays)
    cam.left = 0; cam.right = W; cam.top = 0; cam.bottom = H;
    cam.updateProjectionMatrix();
  }

  setBackground(css) { try { this.bg.set(css); } catch { /* keep previous */ } }

  // state: { live, minDim, resolve, ... }  — resolve(p, minDim, out) fills `out`
  // with the glyph's effective draw values (live oscillators already applied).
  // Ungrouped glyphs composite straight to the screen; each group() renders to its
  // own target, runs its FX chain, then composites on top.
  render(state) {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setClearColor(this.bg, 1);
    r.clear(true, true, true);
    const live = (state && state.live) || [];
    this._minDim = state ? state.minDim : Math.min(this.W, this.H);
    this._resolve = state && state.resolve;
    this._eg = (state && state.evalGlobal) || ((v) => (typeof v === 'number' ? v : 0));
    this._cycle = state ? state.cycle || 0 : 0;
    this._elapsed = state ? state.elapsed || 0 : 0;

    // overlays first (behind the glyphs): playhead sweep + trace polyline
    this._updateOverlays(state, live);
    if (this.playhead.visible || this.trace.visible) r.render(this.overlay, this.camera);
    if (!live.length) { this._pruneGroups(null); return; }

    const ungrouped = [];
    const groups = new Map();   // gid → { parts, fx }, in first-seen (age) order
    for (const p of live) {
      if (p.gid) { let g = groups.get(p.gid); if (!g) groups.set(p.gid, g = { parts: [], fx: p.fx }); g.parts.push(p); }
      else ungrouped.push(p);
    }

    if (ungrouped.length) this._drawGlyphs(ungrouped, null);

    for (const [gid, g] of groups) {
      const rt = this._getGroupRT(gid);
      this._drawGlyphs(g.parts, rt.a);
      const tex = this._applyChain(rt, g.fx);
      this._composite(tex, g.fx);
    }
    this._pruneGroups(groups);
  }

  // draw a glyph list (blend-bucketed, age order preserved) into `target`
  // (a render target, or null for the screen). Targets are cleared transparent
  // first; the screen is not (it already holds the bg + overlays + earlier layers).
  _drawGlyphs(parts, target) {
    const r = this.renderer, out = this._scratch, minDim = this._minDim, resolve = this._resolve;
    this._ensureCapacity(parts.length);
    r.setRenderTarget(target);
    if (target) { r.setClearColor(0x000000, 0); r.clear(true, false, false); }
    for (const key of BLEND_ORDER) {
      let count = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (blendKey(p.blend) !== key) continue;
        resolve(p, minDim, out);
        const a = this.arrays;
        a.iPos[count * 2] = out.x; a.iPos[count * 2 + 1] = out.y;
        a.iRadius[count] = out.r;
        a.iRot[count] = out.rot;
        a.iRotX[count] = out.rotX; a.iRotY[count] = out.rotY;
        a.iColor[count * 3] = out.rgb[0]; a.iColor[count * 3 + 1] = out.rgb[1]; a.iColor[count * 3 + 2] = out.rgb[2];
        a.iAlpha[count] = out.alpha;
        a.iWeight[count] = out.weight;
        a.iOpen[count] = out.open;
        a.iShape[count] = out.shape;
        a.iFill[count] = out.fill;
        a.iStroke[count] = out.stroke;
        a.iVertex[count] = out.vertex;
        a.iCap[count] = out.cap;
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
    r.setRenderTarget(null);
  }

  // resolve an FX param against global time (number / osc / pattern) via main.js
  _num(v, def) { return v == null ? def : this._eg(v, this._cycle, this._elapsed); }

  // run the group's FX chain in call order, ping-ponging between rt.a/rt.b; return
  // the final texture. feedback uses a separate persistent history pair (rt.h).
  _applyChain(rt, fx) {
    if (!fx || !fx.chain || !fx.chain.length) return rt.a.texture;
    let read = rt.a, write = rt.b;
    const swap = () => { const t = read; read = write; write = t; };
    const texel = (m) => m.uniforms.uTexel.value.set(1 / rt.w, 1 / rt.h);
    // Every effect has an "off" value for its main param so it can be patterned
    // on/off (e.g. .kaleido("<6 0>") or .blur("8 0")); when off, the pass is
    // skipped (pure passthrough) rather than run as identity.
    for (const e of fx.chain) {
      const t = e.type;
      if (t === 'pixelate') {
        const block = Math.max(1, this._num(e.block, 8) * this.DPR);
        if (block <= 1.0) continue;                    // off: 1px blocks = no pixelation
        // copy into a mipmapped scratch (Three regenerates its mips on unbind),
        // then sample the mip level whose texel ≈ the block size = area average.
        this._ensureMip(rt);
        this._blit(this.fx.copy, read.texture, rt.mip);
        const m = this.fx.pixelate; texel(m);
        m.uniforms.uBlock.value = block; m.uniforms.uLod.value = Math.log2(block);
        this._blit(m, rt.mip.texture, write); swap();
      } else if (t === 'blur') {
        const radius = this._num(e.radius, 4) * this.DPR;
        if (radius <= 0.0) continue;                   // off
        const m = this.fx.blur; texel(m); m.uniforms.uRadius.value = radius;
        m.uniforms.uDir.value.set(1, 0); this._blit(m, read.texture, write); swap();
        m.uniforms.uDir.value.set(0, 1); this._blit(m, read.texture, write); swap();
      } else if (t === 'grade') {
        const hue = this._num(e.hue, 0), bri = this._num(e.brightness, 1), con = this._num(e.contrast, 1), sat = this._num(e.saturate, 1);
        if (hue === 0 && bri === 1 && con === 1 && sat === 1) continue;   // identity → skip
        const m = this.fx.grade;
        m.uniforms.uHue.value = hue; m.uniforms.uBright.value = bri; m.uniforms.uContrast.value = con; m.uniforms.uSat.value = sat;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'displace') {
        const amount = this._num(e.amount, 0.02);
        if (amount <= 0.0) continue;                   // off
        const m = this.fx.displace; m.uniforms.uAmount.value = amount; m.uniforms.uScale.value = this._num(e.scale, 3); m.uniforms.uTime.value = this._elapsed * 0.2;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'kaleido') {
        const slices = this._num(e.slices, 6);
        if (slices < 2.0) continue;                    // off: <2 slices = passthrough
        const m = this.fx.kaleido; m.uniforms.uSlices.value = slices;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'mirror') {
        if (this._num(e.on, 1) < 0.5) continue;        // off: mirror(0)
        this._blit(this.fx.mirror, read.texture, write); swap();
      } else if (t === 'feedback') {
        this._ensureHistory(rt);
        const next = rt.hist[1 - rt.histCur];
        const m = this.fx.feedback;
        m.uniforms.tHist.value = rt.hist[rt.histCur].texture;
        m.uniforms.uFade.value = this._num(e.fade, 0.92);
        m.uniforms.uZoom.value = this._num(e.zoom, 1.0);
        m.uniforms.uRot.value = this._num(e.rot, 0);
        this._blit(m, read.texture, next);            // result → next history at full (half-float) precision
        rt.histCur = 1 - rt.histCur;
        this._blit(this.fx.copy, next.texture, write); swap();   // bring it into a working buffer for the rest of the chain
      }
    }
    return read.texture;
  }
  // lazily allocate the feedback history pair (persistent across frames, unlike
  // a/b). Half-float so the geometric decay (hist*fade each frame) isn't quantized
  // to 8-bit — otherwise dim trails floor at a few /255 and never clear (a
  // permanent ghost), worse the higher the fade.
  _ensureHistory(rt) {
    if (rt.hist && rt.histW === rt.w && rt.histH === rt.h) return;
    if (rt.hist) { rt.hist[0].dispose(); rt.hist[1].dispose(); }
    const opt = { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType };
    rt.hist = [new THREE.WebGLRenderTarget(rt.w, rt.h, opt), new THREE.WebGLRenderTarget(rt.w, rt.h, opt)];
    rt.histW = rt.w; rt.histH = rt.h; rt.histCur = 0;
  }
  // lazily allocate the mipmapped scratch the pixelate pass averages over
  _ensureMip(rt) {
    if (rt.mip && rt.mipW === rt.w && rt.mipH === rt.h) return;
    if (rt.mip) rt.mip.dispose();
    rt.mip = new THREE.WebGLRenderTarget(rt.w, rt.h, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    rt.mipW = rt.w; rt.mipH = rt.h;
  }
  // offscreen pass: replace the target's contents with the shaded result
  _blit(mat, inputTex, target) {
    mat.uniforms.tMap.value = inputTex;
    mat.blending = THREE.NoBlending; mat.transparent = false;
    this.fsMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.camera);
    this.renderer.setRenderTarget(null);
  }
  // composite a (premultiplied) group texture onto the screen, premultiplied-over
  _composite(tex /*, fx */) {
    const mat = this.fx.copy;
    mat.uniforms.tMap.value = tex;
    mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    mat.transparent = true;
    this.fsMesh.material = mat;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.fsScene, this.camera);
  }
  _pruneGroups(activeGroups) {
    for (const gid of [...this.groupRTs.keys()]) {
      if (!activeGroups || !activeGroups.has(gid)) {
        const rt = this.groupRTs.get(gid);
        rt.a.dispose(); rt.b.dispose(); if (rt.hist) { rt.hist[0].dispose(); rt.hist[1].dispose(); } if (rt.mip) rt.mip.dispose();
        this.groupRTs.delete(gid);
      }
    }
  }

  // playhead = a faint clock hand at the cycle phase; trace = a polyline through
  // the live glyph centres in spawn order. Both match the Canvas2D overlays.
  _updateOverlays(state, live) {
    const showClock = !!(state && state.showClock);
    const traceMode = !!(state && state.traceMode);
    const W = this.W, H = this.H, minDim = state ? state.minDim : Math.min(W, H);

    this.playhead.visible = showClock;
    if (showClock) {
      const phase = state.cycle - Math.floor(state.cycle);
      const ang = phase * Math.PI * 2 - Math.PI / 2;
      const pos = this.playhead.geometry.getAttribute('position');
      pos.array[0] = W / 2; pos.array[1] = H / 2; pos.array[2] = 0;
      pos.array[3] = W / 2 + Math.cos(ang) * minDim * 0.4;
      pos.array[4] = H / 2 + Math.sin(ang) * minDim * 0.4;
      pos.array[5] = 0;
      pos.needsUpdate = true;
    }

    this.trace.visible = traceMode && live.length > 1;
    if (this.trace.visible) {
      const n = Math.min(live.length, TRACE_CAP);
      const pos = this.trace.geometry.getAttribute('position');
      const col = this.trace.geometry.getAttribute('color');
      for (let i = 0; i < n; i++) {
        const p = live[i];
        pos.array[i * 3] = p.x; pos.array[i * 3 + 1] = p.y; pos.array[i * 3 + 2] = 0;
        // bake the per-glyph alpha proxy into the colour (premultiplied-ish) so
        // faint glyphs give faint trace segments, à la the 2D min(a._a,b._a) fade
        const a = Math.max(0, Math.min(1, p._a != null ? p._a : 1));
        const rgb = p._rgb || [0.62, 0.71, 1];
        pos.needsUpdate = true;
        col.array[i * 3] = rgb[0] * a; col.array[i * 3 + 1] = rgb[1] * a; col.array[i * 3 + 2] = rgb[2] * a;
      }
      col.needsUpdate = true;
      this.trace.geometry.setDrawRange(0, n);
    }
  }

  dispose() {
    this.geom.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    for (const m of Object.values(this.fx)) m.dispose();
    this.fsMesh.geometry.dispose();
    this._pruneGroups(null);
    this.playhead.geometry.dispose(); this.playhead.material.dispose();
    this.trace.geometry.dispose(); this.trace.material.dispose();
    this.renderer.dispose();
  }
}
