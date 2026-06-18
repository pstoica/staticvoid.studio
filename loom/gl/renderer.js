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
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ── imported 3D meshes (real geometry, instanced + depth-tested; flat-shaded to
// match the SDF 3D shapes). name → file url, resolved via Vite asset handling. ──
const MESH_URLS = { bong: new URL('../models/BONG.fbx', import.meta.url).href };
const MESH_ID = { bong: 15 };          // shape ids for imported meshes (>= 15)
const MAX_MESH = 1024;

// flat instanced-mesh shaders: orthographic pixel→NDC projection (matching the
// glyph billboard), per-instance tint (rgb + alpha), premultiplied output.
const MESH_VERT = `
precision highp float;
uniform vec2 uResolution;
uniform mat4 uModel;       // per-instance model matrix (rendered one instance at a time)
uniform vec4 uTint;        // rgb + alpha
uniform float uShade;      // 0 = flat/unlit, 1 = faceted lighting
in vec3 position;
in vec3 normal;
out vec4 vTint;
out float vShade;
out vec3 vN;               // world-space (flat) normal for shading
void main() {
  vShade = uShade;
  vec4 wp = uModel * vec4(position, 1.0);
  vN = mat3(uModel) * normal;            // uniform model scale → normalize in the fragment
  // depth is only used to resolve THIS instance's own front/back faces (one pass per
  // instance, depth cleared between them) so a single mesh shows one surface; instances
  // composite in paint order like 2D glyphs instead of occluding each other.
  float scale = max(length(uModel[0].xyz), 1.0);
  float zl = clamp(wp.z / scale, -1.0, 1.0);          // +1 front .. -1 back, within the mesh
  gl_Position = vec4(2.0 * wp.x / uResolution.x - 1.0,
                     1.0 - 2.0 * wp.y / uResolution.y,
                     -zl * 0.5, 1.0);                 // front nearer; LessEqual picks it
  vTint = uTint;
}`;
const MESH_FRAG = `
precision highp float;
in vec4 vTint;
in float vShade;
in vec3 vN;
out vec4 fragColor;
void main() {
  // flat (per-face) normal from the geometry — robust to overlapping instances. (A
  // screen-space derivative normal corrupts where the depth pre-pass lets a 2x2 quad
  // survive from different faces, which turned stacked meshes near-black.)
  // y is screen-down here, so light from "above" is -y; matte, no specular.
  float shade = 1.0;
  if (vShade > 0.001) {
    vec3 N = normalize(vN);
    if (N.z < 0.0) N = -N;                                // face the camera (DoubleSide)
    float diff = 0.5 + 0.5 * max(dot(N, normalize(vec3(0.25, -0.35, 0.9))), 0.0);
    shade = mix(1.0, diff, clamp(vShade, 0.0, 1.0));      // 0 = flat/unlit
  }
  float a = clamp(vTint.a, 0.0, 1.0);
  fragColor = vec4(clamp(vTint.rgb * shade, 0.0, 1.0) * a, a);   // premultiplied
}`;
// instanced variant of MESH_VERT for the OPAQUE batch: many solid meshes in one draw.
// Opaque objects can share a depth buffer (hard occlusion is the correct result), so we
// skip the per-instance compositing and just order coincident instances by a per-id
// depth band (higher gl_InstanceID = newer = nearer). Shares MESH_FRAG.
const MESH_VERT_INST = `
precision highp float;
uniform vec2 uResolution;
in vec3 position;
in vec3 normal;
in mat4 instanceMatrix;
in vec4 aTint;             // rgb + alpha
in float aShade;          // 0 = flat/unlit, 1 = faceted lighting
out vec4 vTint;
out float vShade;
out vec3 vN;
void main() {
  vShade = aShade;
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vN = mat3(instanceMatrix) * normal;
  float scale = max(length(instanceMatrix[0].xyz), 1.0);
  float zl = clamp(wp.z / scale, -1.0, 1.0);          // +1 front .. -1 back, within the mesh
  float inv = 1.0 / 2048.0;                           // band per instance (≈1000 before saturation)
  float z = -float(gl_InstanceID) * 2.0 * inv - zl * inv;
  gl_Position = vec4(2.0 * wp.x / uResolution.x - 1.0,
                     1.0 - 2.0 * wp.y / uResolution.y,
                     clamp(z, -0.999, 0.999), 1.0);
  vTint = aTint;
}`;

// shape name → SDF id (kept in sync with the switch in the fragment shader and
// with SHAPE_ID in main.js).  0 circle/dot · 1 ring · 2 arc · 3 square/box ·
// 4 tri · 5 pent · 6 hex · 7 star · 8 plus · 9 line · 10 cross
const QUAD_POS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);

// instance attributes: name → component count
const IATTRS = {
  iPos: 2, iRadius: 1, iRot: 1, iRotX: 1, iRotY: 1, iColor: 4, iAlpha: 1,   // iColor.a = 3D shade (packed; we're at the 16-attribute limit)
  iWeight: 1, iOpen: 1, iShape: 1, iFill: 1, iStroke: 1, iVertex: 1, iCap: 1, iJoin: 1,
};
const TRACE_CAP = 8192;         // max points in the trace polyline

const VERT = `
precision highp float;
uniform vec2 uResolution;       // viewport in CSS px (W, H); pixel→NDC mapping
in vec3 position;        // quad corner in -1..1
in vec2 iPos;            // glyph centre, pixel space
in float iRadius;        // glyph radius, px
in float iRot;           // z rotation / spin, radians
in float iRotX;          // 3D tilt around horizontal axis, radians
in float iRotY;          // 3D tilt around vertical axis, radians
in vec4 iColor;          // rgb 0..1 (sRGB); .a carries the 3D shade amount
in float iAlpha;         // 0..1, envelope already folded in
in float iWeight;        // stroke width (full), px
in float iOpen;          // arc/line gap 0..1
in float iShape;         // shape id
in float iFill;          // 0/1
in float iStroke;        // 0/1
in float iVertex;        // 0/1 — dot at each vertex
in float iCap;           // line/cross caps: 0 round, 1 butt, 2 square
in float iJoin;          // polygon corners: 0 miter, 1 round, 2 bevel
out vec2 vLocal;            // shape-space coordinate, px (un-rotated)
out float vR, vWeight, vOpen, vShape, vFill, vStroke, vVertex, vCap, vJoin, vAlpha;
out float vRot, vRotX, vRotY, vShade;   // angles + 3D shade forwarded to the fragment
out vec3 vColor;
void main() {
  vR = iRadius; vWeight = iWeight; vOpen = iOpen; vShape = iShape;
  vFill = iFill; vStroke = iStroke; vVertex = iVertex; vCap = iCap; vJoin = iJoin; vAlpha = iAlpha; vColor = iColor.rgb;
  vRot = iRot; vRotX = iRotX; vRotY = iRotY; vShade = iColor.a;
  // 3D raymarched shapes (id >= 11): a screen-aligned billboard sized to the
  // bounding sphere; the tumble happens inside the fragment raymarch.
  if (int(iShape + 0.5) >= 11) {
    vec2 local3 = position.xy * (iRadius * 1.15 + 2.0);
    vLocal = local3;
    vec2 P3 = local3 + iPos;
    gl_Position = vec4(2.0 * P3.x / uResolution.x - 1.0, 1.0 - 2.0 * P3.y / uResolution.y, 0.0, 1.0);
    return;
  }
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
}`;

const FRAG = `
precision highp float;
#define PI 3.14159265359
#define TAU 6.28318530718
in vec2 vLocal;
in float vR, vWeight, vOpen, vShape, vFill, vStroke, vVertex, vCap, vJoin, vAlpha;
in float vRot, vRotX, vRotY, vShade;
in vec3 vColor;
out vec4 fragColor;

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
// signed perpendicular distance to the nearest EDGE LINE of a vertex-up n-gon.
// the edge lines extend past the vertices, so a stroke band around this gives
// sharp mitered corners instead of the Euclidean SDF's rounded ones.
float ngonEdge(vec2 p, float r, float n){
  p = rot2(p, PI/n);
  float ap = PI/n;
  float a = atan(p.x, p.y);
  a = mod(a + ap, 2.0*ap) - ap;
  return length(p)*cos(a) - r*cos(ap);
}
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

// ── 3D shapes: raymarched SDFs, tumbled by rotateX/rotateY/spin, normal-shaded ──
mat3 rotX3(float a){ float c=cos(a), s=sin(a); return mat3(1.0,0.0,0.0, 0.0,c,s, 0.0,-s,c); }
mat3 rotY3(float a){ float c=cos(a), s=sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
mat3 rotZ3(float a){ float c=cos(a), s=sin(a); return mat3(c,s,0.0, -s,c,0.0, 0.0,0.0,1.0); }
float map3(int id, vec3 p, float r){
  if (id == 12) return length(p) - r*0.9;                                       // sphere
  if (id == 13) { vec2 t = vec2(length(p.xz) - r*0.6, p.y); return length(t) - r*0.28; } // torus
  if (id == 14) { p = abs(p); return (p.x+p.y+p.z - r*1.1) * 0.5773; }          // octahedron
  vec3 b = abs(p) - vec3(r*0.58);                                               // cube (id 11)
  return length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0);
}

void main(){
  // work in maths space (y up) so polygon "up" matches the 2D vertex-up look
  vec2 q = vec2(vLocal.x, -vLocal.y);
  int id = int(vShape + 0.5);

  // 3D shapes (id >= 11): orthographic raymarch in the glyph's tumbled object space
  if (id >= 11) {
    mat3 R = rotZ3(vRot) * rotY3(vRotY) * rotX3(vRotX);   // object → world
    mat3 Ri = transpose(R);                               // world → object (orthonormal)
    vec3 ro = Ri * vec3(q, vR * 2.2);
    vec3 rd = Ri * vec3(0.0, 0.0, -1.0);
    float t = 0.0; bool hit = false;
    for (int i = 0; i < 44; i++) {
      float dd = map3(id, ro + rd * t, vR);
      if (dd < 0.0015 * vR) { hit = true; break; }
      t += dd;
      if (t > vR * 5.0) break;
    }
    if (!hit) discard;
    vec3 pp = ro + rd * t;
    float e = max(vR * 0.012, 0.3);
    vec3 n = normalize(vec3(
      map3(id, pp + vec3(e,0.0,0.0), vR) - map3(id, pp - vec3(e,0.0,0.0), vR),
      map3(id, pp + vec3(0.0,e,0.0), vR) - map3(id, pp - vec3(0.0,e,0.0), vR),
      map3(id, pp + vec3(0.0,0.0,e), vR) - map3(id, pp - vec3(0.0,0.0,e), vR)));
    vec3 nw = R * n;                                      // object normal → world
    // flat by default (shade 0 = solid colour). shade > 0 mixes in a faceted
    // diffuse term (no rim/specular), so it's matte/poster, never glossy. lit from
    // the front so the camera-facing surface stays ~full brightness (only edges
    // dim) — keeps it from looking globally darker than a flat shape when faded.
    float shade = mix(1.0, 0.5 + 0.5 * max(dot(nw, normalize(vec3(0.25, 0.35, 0.9))), 0.0), clamp(vShade, 0.0, 1.0));
    // fill(0).stroke(1) → wireframe: edges for the polyhedra (cube/octa), the
    // grazing silhouette for the smooth ones (sphere/torus). visible (front) faces.
    float cov = 1.0;
    if (vFill < 0.5 && vStroke > 0.5) {
      float lw = max(vWeight, 1.0);
      vec3 ap = abs(pp);
      if (id == 11) {                                    // cube: near a face-pair seam
        float m1 = max(ap.x, max(ap.y, ap.z)), m3 = min(ap.x, min(ap.y, ap.z));
        cov = 1.0 - smoothstep(lw - 1.0, lw + 1.0, vR * 0.58 - (ap.x + ap.y + ap.z - m1 - m3));
      } else if (id == 14) {                             // octahedron: edge where a coord → 0
        cov = 1.0 - smoothstep(lw - 1.0, lw + 1.0, min(ap.x, min(ap.y, ap.z)));
      } else {                                           // sphere/torus: silhouette rim
        cov = 1.0 - smoothstep(0.0, 0.42, abs(nw.z));
      }
      if (cov <= 0.002) discard;
    }
    float a = clamp(vAlpha * cov, 0.0, 1.0);
    fragColor = vec4(clamp(vColor * shade, 0.0, 1.0) * a, a);
    return;
  }

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

  // AA half-width from the SDF's screen-space gradient: ~1px when flat, but grows
  // when the glyph is tilted near edge-on so grazing sides soften instead of
  // breaking into a dashed/chopped stair-step.
  float aa = clamp(fwidth(d), 0.5, 16.0);
  float cov;
  if (capped) {                          // line/cross: d is the thickened stroke → fill it
    cov = vStroke * (1.0 - smoothstep(-aa, aa, d));
  } else if (openCurve) {                // ring/arc outline: stroke band
    cov = vStroke * (1.0 - smoothstep(hw - aa, hw + aa, d));
  } else {
    // stroke band distance. for the convex polygons, miter/bevel the corners
    // (the Euclidean SDF rounds them); join 0 miter, 1 round, 2 bevel.
    float dStroke = abs(d);
    if (id == 3 || id == 4 || id == 5 || id == 6) {
      float dEdge = (id == 3) ? max(abs(q.x), abs(q.y)) - vR
                              : ngonEdge(q, vR, (id == 4) ? 3.0 : (id == 5) ? 5.0 : 6.0);
      if (vJoin < 0.5)       dStroke = abs(dEdge);                    // miter (sharp)
      else if (vJoin > 1.5)  dStroke = max(abs(dEdge), abs(d) - hw * 0.6);  // bevel (chamfer)
    }
    float fillCov = vFill * (1.0 - smoothstep(-aa, aa, d));
    float strokeCov = vStroke * (1.0 - smoothstep(hw - aa, hw + aa, dStroke));
    cov = max(fillCov, strokeCov);
  }
  if (vVertex > 0.5) {                    // dot at each vertex (filled)
    float vr = max(vWeight * 1.5, 2.0);
    float vd = vertDist(q, id, vR, vOpen);
    cov = max(cov, 1.0 - smoothstep(vr - aa, vr + aa, vd));
  }
  // .shade(n) on a 2D shape → glossy "plastic toy" puff: fake a domed normal from
  // the SDF (screen-space derivatives) and add diffuse + a tight specular.
  vec3 outColor = vColor;
  if (vShade > 0.001 && !capped) {
    vec3 N;
    if (openCurve) {                         // ring / arc → a torus-like tube
      float sc = length(q) - vR;             // signed across the tube
      float zz = sqrt(max(1.0 - sc * sc / (hw * hw), 0.0));
      vec2 rad = length(q) > 1e-4 ? normalize(q) : vec2(0.0);
      N = normalize(vec3(rad * (sc / hw), zz + 1e-3));
    } else {                                 // filled shape → a domed pillow
      float depth = -d;                      // depth inside the fill
      float br = max(vShade * vR, 1.0);      // dome radius (shade 1 = full puff)
      float tt = clamp(depth / br, 0.0, 1.0);
      float zz = sqrt(max(1.0 - (1.0 - tt) * (1.0 - tt), 0.0));
      vec2 g = vec2(dFdx(d), -dFdy(d));      // ∇d, outward (flip y → maths up)
      float gl = length(g); vec2 dir = gl > 1e-5 ? g / gl : vec2(0.0);
      N = normalize(vec3(dir * (1.0 - zz), zz + 1e-3));
    }
    vec3 L = normalize(vec3(-0.3, 0.5, 0.8));
    float diff = max(dot(N, L), 0.0);
    float spec = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);
    outColor = clamp(vColor * (0.45 + 0.6 * diff) + vec3(spec) * 0.75, 0.0, 1.0);
  }
  if (cov <= 0.0) discard;
  float a = clamp(vAlpha * cov, 0.0, 1.0);
  fragColor = vec4(outColor * a, a);      // premultiplied — blends set the factors
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

// negative: invert the colour (mix lets it fade in / be patterned 0..1)
const NEGATIVE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uAmount;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(tMap, vUv);
  float a = t.a;
  vec3 col = a > 0.0 ? t.rgb / a : t.rgb;     // unpremultiply
  col = mix(col, 1.0 - col, clamp(uAmount, 0.0, 1.0));
  gl_FragColor = vec4(col * a, a);            // repremultiply
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

// tile: repeat the layer in an nx × ny grid (fract wraps each cell's uv)
const TILE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uRepeat;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tMap, fract(vUv * uRepeat));
}`;

// halftone / dots: snap to a cell grid, area-average the cell (mipped, like
// pixelate), then mask it into a dot whose area grows with the cell's coverage ×
// brightness. Premultiplied; gaps between dots fall to transparent.
const HALFTONE_FRAG3 = `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uTexel;       // 1 / target size, device px
uniform float uCell;       // cell size, device px
uniform float uLod;        // log2(uCell) — mip level = the cell's area average
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 px = vUv / uTexel;
  vec2 center = (floor(px / uCell) + 0.5) * uCell;
  vec4 c = textureLod(tMap, center * uTexel, uLod);
  float a = c.a;
  vec3 col = a > 0.0 ? c.rgb / a : c.rgb;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float amt = clamp(a * mix(0.25, 1.0, lum), 0.0, 1.0);
  float radius = sqrt(amt) * 0.5 * uCell;          // dot area ∝ coverage
  float d = length(px - center);
  float dot = 1.0 - smoothstep(radius - 1.0, radius + 1.0, d);
  fragColor = vec4(col * a, a) * dot;
}`;

// rgb shift / chromatic aberration: sample R and B at opposite offsets (unpremult,
// recombine), leaving G centred — the classic split-channel fringe.
const RGBSHIFT_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uOffset;       // channel separation, uv
varying vec2 vUv;
void main() {
  vec4 cr = texture2D(tMap, vUv + uOffset);
  vec4 cg = texture2D(tMap, vUv);
  vec4 cb = texture2D(tMap, vUv - uOffset);
  float ar = cr.a, ag = cg.a, ab = cb.a;
  vec3 col = vec3(ar > 0.0 ? cr.r / ar : 0.0, ag > 0.0 ? cg.g / ag : 0.0, ab > 0.0 ? cb.b / ab : 0.0);
  float a = max(ar, max(ag, ab));
  gl_FragColor = vec4(col * a, a);
}`;

// posterize: quantize each channel to N levels
const POSTERIZE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uLevels;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(tMap, vUv);
  float a = t.a;
  vec3 col = a > 0.0 ? t.rgb / a : t.rgb;
  col = clamp(floor(col * uLevels) / max(uLevels - 1.0, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;

// scanlines: periodic horizontal darkening. premultiplied scale, so the dark gaps
// drop coverage and the background shows through (CRT-ish, not just a grey wash).
const SCANLINE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uAmount;      // 0..1 darkening
uniform float uPeriod;      // line spacing, device px
varying vec2 vUv;
void main() {
  vec4 t = texture2D(tMap, vUv);
  float l = 0.5 + 0.5 * cos(6.28318530718 * gl_FragCoord.y / max(uPeriod, 2.0));
  gl_FragColor = t * (1.0 - uAmount * l);
}`;

// ordered (Bayer 4×4) dither + quantize — the low-bit / newsprint look. GLSL3 for
// the integer matrix lookup.
const DITHER_FRAG3 = `
precision highp float;
uniform sampler2D tMap;
uniform float uLevels;
in vec2 vUv;
out vec4 fragColor;
const int M[16] = int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
void main() {
  vec4 t = texture(tMap, vUv);
  float a = t.a;
  vec3 col = a > 0.0 ? t.rgb / a : t.rgb;
  ivec2 p = ivec2(gl_FragCoord.xy);
  float th = (float(M[(p.x & 3) + (p.y & 3) * 4]) + 0.5) / 16.0 - 0.5;
  float n = max(uLevels - 1.0, 1.0);
  col = clamp(floor(col * n + 0.5 + th) / n, 0.0, 1.0);
  fragColor = vec4(col * a, a);
}`;

// slice: cut into bands and offset each by a per-band hash × amount. mode 0 =
// horizontal bands shifted in x, 1 = vertical bands shifted in y, 2 = both (grid).
// pattern the amount to make the slices judder with the music.
const SLICE_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uCount, uAmount, uMode;
varying vec2 vUv;
float h11(float n) { return fract(sin(n * 12.9898) * 43758.5453) * 2.0 - 1.0; }
void main() {
  vec2 uv = vUv;
  if (uMode < 0.5 || uMode > 1.5) uv.x += h11(floor(uv.y * uCount)) * uAmount;
  if (uMode > 0.5)                uv.y += h11(floor(uv.x * uCount) + 17.0) * uAmount;
  gl_FragColor = texture2D(tMap, fract(uv));
}`;

// lens: radial barrel (amount > 0, bulge) / pincushion (amount < 0) distortion
// about the centre. samples clamp at the edges.
const LENS_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uAmount;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  vec2 uv = p * (1.0 + uAmount * dot(p, p) * 4.0) + 0.5;
  gl_FragColor = texture2D(tMap, clamp(uv, 0.0, 1.0));
}`;

// opacity: scale the whole layer's alpha (premultiplied → scale rgb and a together).
// patternable, so you can fade or pulse a group as a unit.
const OPACITY_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uAlpha;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tMap, vUv) * clamp(uAlpha, 0.0, 1.0); }`;

// transform: scale (zoom about centre), rotate, translate the whole layer — the
// composition controls. samples outside the frame read transparent, so a shrunk
// or moved layer reveals the background around it.
const XFORM_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uScale, uAngle;
uniform vec2 uOffset;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5 - uOffset) / max(uScale, 0.0001);
  float c = cos(uAngle), s = sin(uAngle);
  vec2 uv = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(tMap, uv);
}`;

// aspect: keep a centred rectangle of the target ratio (w/h) and clear the rest —
// letterbox / pillarbox the layer into a fixed aspect.
const ASPECT_FRAG = `
precision highp float;
uniform sampler2D tMap;
uniform float uAspect;     // target w/h
uniform float uCanvas;     // canvas w/h
varying vec2 vUv;
void main() {
  vec2 keep = uAspect < uCanvas ? vec2(uAspect / uCanvas, 1.0) : vec2(1.0, uCanvas / uAspect);
  if (abs(vUv.x - 0.5) > keep.x * 0.5 || abs(vUv.y - 0.5) > keep.y * 0.5) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = texture2D(tMap, vUv);
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
    const base = { glslVersion: THREE.GLSL3, uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide };
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

    // imported-mesh path (one draw per instance, depth-tested). meshes load async;
    // until a model arrives its glyphs simply don't draw.
    this.meshScene = new THREE.Scene();
    this.meshObjs = {};          // id → THREE.Mesh
    this._m4 = new THREE.Matrix4();
    this._euler = new THREE.Euler();
    this._v3 = new THREE.Vector3();
    this._loadMeshes();

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
      negative: fsMat(NEGATIVE_FRAG, { tMap: { value: null }, uAmount: { value: 1 } }),
      displace: fsMat(DISPLACE_FRAG, { tMap: { value: null }, uAmount: { value: 0.02 }, uScale: { value: 3 }, uTime: { value: 0 } }),
      kaleido: fsMat(KALEIDO_FRAG, { tMap: { value: null }, uSlices: { value: 6 } }),
      mirror: fsMat(MIRROR_FRAG, { tMap: { value: null } }),
      tile: fsMat(TILE_FRAG, { tMap: { value: null }, uRepeat: { value: V2() } }),
      dots: new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT3, fragmentShader: HALFTONE_FRAG3, uniforms: { tMap: { value: null }, uTexel: { value: V2() }, uCell: { value: 8 }, uLod: { value: 0 } }, depthTest: false, depthWrite: false }),
      rgbshift: fsMat(RGBSHIFT_FRAG, { tMap: { value: null }, uOffset: { value: V2() } }),
      posterize: fsMat(POSTERIZE_FRAG, { tMap: { value: null }, uLevels: { value: 4 } }),
      scanlines: fsMat(SCANLINE_FRAG, { tMap: { value: null }, uAmount: { value: 0.5 }, uPeriod: { value: 3 } }),
      dither: new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT3, fragmentShader: DITHER_FRAG3, uniforms: { tMap: { value: null }, uLevels: { value: 4 } }, depthTest: false, depthWrite: false }),
      slice: fsMat(SLICE_FRAG, { tMap: { value: null }, uCount: { value: 8 }, uAmount: { value: 0 }, uMode: { value: 0 } }),
      lens: fsMat(LENS_FRAG, { tMap: { value: null }, uAmount: { value: 0 } }),
      opacity: fsMat(OPACITY_FRAG, { tMap: { value: null }, uAlpha: { value: 1 } }),
      transform: fsMat(XFORM_FRAG, { tMap: { value: null }, uScale: { value: 1 }, uAngle: { value: 0 }, uOffset: { value: V2() } }),
      aspect: fsMat(ASPECT_FRAG, { tMap: { value: null }, uAspect: { value: 0 }, uCanvas: { value: 1 } }),
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
      // `a` also holds glyphs + imported meshes, so it needs a depth buffer for mesh
      // self-occlusion; `b` is only an FX ping-pong, no depth.
      rt = { a: new THREE.WebGLRenderTarget(dw, dh, { ...opt, depthBuffer: true }), b: new THREE.WebGLRenderTarget(dw, dh, opt), w: dw, h: dh };
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
        if (out.shape >= 15) continue;          // imported meshes draw in _drawMeshes
        const a = this.arrays;
        a.iPos[count * 2] = out.x; a.iPos[count * 2 + 1] = out.y;
        a.iRadius[count] = out.r;
        a.iRot[count] = out.rot;
        a.iRotX[count] = out.rotX; a.iRotY[count] = out.rotY;
        a.iColor[count * 4] = out.rgb[0]; a.iColor[count * 4 + 1] = out.rgb[1]; a.iColor[count * 4 + 2] = out.rgb[2]; a.iColor[count * 4 + 3] = out.shade;
        a.iAlpha[count] = out.alpha;
        a.iWeight[count] = out.weight;
        a.iOpen[count] = out.open;
        a.iShape[count] = out.shape;
        a.iFill[count] = out.fill;
        a.iStroke[count] = out.stroke;
        a.iVertex[count] = out.vertex;
        a.iCap[count] = out.cap;
        a.iJoin[count] = out.join;
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
    this._drawMeshes(parts, target);
    r.setRenderTarget(null);
  }

  // load imported FBX meshes → position-only, centred, normalized to unit radius. Two
  // draw paths share one geometry: an instanced `batch` for opaque instances (one cheap
  // draw, hard occlusion is correct for solids) and a `solo` Mesh for translucent ones
  // (rendered one at a time in _drawMeshes so they composite like 2D glyphs).
  _loadMeshes() {
    const loader = new FBXLoader();
    const blend = {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    };
    for (const [name, url] of Object.entries(MESH_URLS)) {
      loader.load(url, (root) => {
        const geos = [];
        root.updateMatrixWorld(true);
        root.traverse((c) => {
          if (!c.isMesh || !c.geometry) return;
          const src = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', src.getAttribute('position').clone());
          g.applyMatrix4(c.matrixWorld);
          geos.push(g);
        });
        if (!geos.length) return;
        const geo = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
        geo.computeBoundingSphere();
        const c = geo.boundingSphere.center, rad = geo.boundingSphere.radius || 1;
        geo.translate(-c.x, -c.y, -c.z);
        geo.scale(1 / rad, 1 / rad, 1 / rad);
        geo.deleteAttribute('normal');         // drop any imported normals…
        geo.computeVertexNormals();            // …rebuild per-face (non-indexed → flat)
        geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(MAX_MESH * 4), 4));
        geo.setAttribute('aShade', new THREE.InstancedBufferAttribute(new Float32Array(MAX_MESH), 1));

        const soloMat = new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          uniforms: {
            uResolution: this.uniforms.uResolution,   // shared, kept in sync on resize
            uModel: { value: new THREE.Matrix4() },
            uTint: { value: new THREE.Vector4(1, 1, 1, 1) },
            uShade: { value: 0 },
          },
          vertexShader: MESH_VERT, fragmentShader: MESH_FRAG,
          transparent: true, depthTest: true, depthWrite: true, side: THREE.DoubleSide, ...blend,
        });
        const solo = new THREE.Mesh(geo, soloMat);
        solo.frustumCulled = false; solo.visible = false;

        const batchMat = new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3, uniforms: { uResolution: this.uniforms.uResolution },
          vertexShader: MESH_VERT_INST, fragmentShader: MESH_FRAG,
          transparent: true, depthTest: true, depthWrite: true, side: THREE.DoubleSide, ...blend,
        });
        const batch = new THREE.InstancedMesh(geo, batchMat, MAX_MESH);
        batch.frustumCulled = false; batch.count = 0; batch.visible = false;

        this.meshScene.add(batch); this.meshScene.add(solo);
        this.meshObjs[MESH_ID[name]] = { solo, batch };
      }, undefined, (err) => console.warn('Loom: failed to load mesh', name, err));
    }
  }

  // draw all imported-mesh glyphs in `parts` into the current target. Two phases:
  //   A) opaque instances (authored alpha ≈ 1) → one instanced batch per mesh, hard
  //      occlusion via depth bands (correct for solids) — cheap, scales to many.
  //   B) translucent instances → rendered one at a time (depth cleared between) so each
  //      resolves to a single surface yet composites like a 2D glyph, blending through.
  // A is drawn first, so in a mixed scene opaque sits behind translucent.
  _drawMeshes(parts, target) {
    if (!parts.length) return;
    if (!Object.keys(this.meshObjs).length) return;
    const r = this.renderer, out = this._scratch, minDim = this._minDim, resolve = this._resolve;
    for (const k in this.meshObjs) { const e = this.meshObjs[k]; e.batch.count = 0; e.batch.visible = false; e.solo.visible = false; }
    const solos = (this._soloList || (this._soloList = []));
    solos.length = 0;
    let drew = 0;

    for (let i = 0; i < parts.length && drew < MAX_MESH; i++) {
      resolve(parts[i], minDim, out);
      const entry = this.meshObjs[out.shape];
      if (!entry) continue;
      this._euler.set(out.rotX, out.rotY, out.rot, 'XYZ');
      this._m4.makeRotationFromEuler(this._euler);
      this._m4.scale(this._v3.set(out.r, out.r, out.r));
      this._m4.setPosition(out.x, out.y, 0);
      if (out.baseAlpha >= 0.999) {            // opaque → instanced batch
        const b = entry.batch, n = b.count;
        if (n >= MAX_MESH) continue;
        b.setMatrixAt(n, this._m4);
        const t = b.geometry.getAttribute('aTint').array;
        t[n * 4] = out.rgb[0]; t[n * 4 + 1] = out.rgb[1]; t[n * 4 + 2] = out.rgb[2]; t[n * 4 + 3] = out.alpha;
        b.geometry.getAttribute('aShade').array[n] = out.shade;
        b.count = n + 1;
      } else {                                 // translucent → per-instance, in paint order
        solos.push({ solo: entry.solo, m: this._m4.clone(), rgb: out.rgb.slice(0, 3), a: out.alpha, shade: out.shade });
      }
      drew++;
    }

    r.setRenderTarget(target);

    // ── phase A: opaque batch (two-pass so envelope fades still show one face/pixel) ──
    const batches = [];
    for (const k in this.meshObjs) { const b = this.meshObjs[k].batch; if (b.count > 0) { b.visible = true; b.instanceMatrix.needsUpdate = true; b.geometry.getAttribute('aTint').needsUpdate = true; b.geometry.getAttribute('aShade').needsUpdate = true; batches.push(b); } }
    if (batches.length) {
      r.clear(false, true, false);
      for (const b of batches) { const m = b.material; m.colorWrite = false; m.depthWrite = true; m.depthFunc = THREE.LessEqualDepth; }
      r.render(this.meshScene, this.camera);
      for (const b of batches) { const m = b.material; m.colorWrite = true; m.depthWrite = false; m.depthFunc = THREE.EqualDepth; }
      r.render(this.meshScene, this.camera);
      for (const b of batches) b.visible = false;
    }

    // ── phase B: translucent, one instance per pass, composited in spawn order ──
    for (const s of solos) {
      const u = s.solo.material.uniforms;
      u.uModel.value.copy(s.m);
      u.uTint.value.set(s.rgb[0], s.rgb[1], s.rgb[2], s.a);
      u.uShade.value = s.shade;
      s.solo.visible = true;
      r.clear(false, true, false);
      const m = s.solo.material;
      m.colorWrite = false; m.depthWrite = true; m.depthFunc = THREE.LessEqualDepth;
      r.render(this.meshScene, this.camera);
      m.colorWrite = true; m.depthWrite = false; m.depthFunc = THREE.EqualDepth;
      r.render(this.meshScene, this.camera);
      s.solo.visible = false;
    }
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
      } else if (t === 'negative') {
        const amount = this._num(e.amount, 1);
        if (amount <= 0.0) continue;                   // off
        const m = this.fx.negative; m.uniforms.uAmount.value = amount;
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
      } else if (t === 'tile') {
        const nx = Math.max(1, Math.round(this._num(e.x, 2)));
        const ny = Math.max(1, Math.round(this._num(e.y, nx)));
        if (nx <= 1 && ny <= 1) continue;              // off: 1×1 = passthrough
        const m = this.fx.tile; m.uniforms.uRepeat.value.set(nx, ny);
        this._blit(m, read.texture, write); swap();
      } else if (t === 'dots') {
        const cell = Math.max(2, this._num(e.cell, 8) * this.DPR);
        if (cell <= 2.0) continue;                     // off: tiny cells = no halftone
        this._ensureMip(rt);
        this._blit(this.fx.copy, read.texture, rt.mip);
        const m = this.fx.dots; texel(m);
        m.uniforms.uCell.value = cell; m.uniforms.uLod.value = Math.log2(cell);
        this._blit(m, rt.mip.texture, write); swap();
      } else if (t === 'rgbshift') {
        const amt = this._num(e.amount, 0.005);
        if (amt <= 0.0) continue;                      // off
        const ang = this._num(e.angle, 0) * 6.28318530718;
        const m = this.fx.rgbshift; m.uniforms.uOffset.value.set(Math.cos(ang) * amt, Math.sin(ang) * amt);
        this._blit(m, read.texture, write); swap();
      } else if (t === 'posterize') {
        const lv = this._num(e.levels, 4);
        if (lv < 2.0) continue;                        // off
        const m = this.fx.posterize; m.uniforms.uLevels.value = lv;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'scanlines') {
        const amt = this._num(e.amount, 0.5);
        if (amt <= 0.0) continue;                      // off
        const m = this.fx.scanlines; m.uniforms.uAmount.value = amt;
        m.uniforms.uPeriod.value = Math.max(2, this._num(e.period, 3)) * this.DPR;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'dither') {
        const lv = this._num(e.levels, 4);
        if (lv < 2.0) continue;                        // off
        const m = this.fx.dither; m.uniforms.uLevels.value = lv;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'slice') {
        const amt = this._num(e.amount, 0.1);
        if (amt <= 0.0) continue;                      // off
        const m = this.fx.slice; m.uniforms.uCount.value = Math.max(1, this._num(e.count, 8));
        m.uniforms.uAmount.value = amt; m.uniforms.uMode.value = this._num(e.mode, 0);
        this._blit(m, read.texture, write); swap();
      } else if (t === 'lens') {
        const amt = this._num(e.amount, 0.4);
        if (amt === 0) continue;                       // off: no distortion
        const m = this.fx.lens; m.uniforms.uAmount.value = amt;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'opacity') {
        const a = this._num(e.alpha, 1);
        if (a >= 0.999) continue;                      // off: full opacity = identity
        const m = this.fx.opacity; m.uniforms.uAlpha.value = a;
        this._blit(m, read.texture, write); swap();
      } else if (t === 'transform') {
        const sc = this._num(e.scale, 1), ang = this._num(e.angle, 0) * 6.28318530718;
        const ox = this._num(e.x, 0), oy = this._num(e.y, 0);
        if (sc === 1 && ang === 0 && ox === 0 && oy === 0) continue;   // identity
        const m = this.fx.transform;
        m.uniforms.uScale.value = sc; m.uniforms.uAngle.value = ang; m.uniforms.uOffset.value.set(ox, oy);
        this._blit(m, read.texture, write); swap();
      } else if (t === 'aspect') {
        const ar = this._num(e.ratio, 0);
        if (ar <= 0.0) continue;                       // off
        const m = this.fx.aspect; m.uniforms.uAspect.value = ar; m.uniforms.uCanvas.value = rt.w / rt.h;
        this._blit(m, read.texture, write); swap();
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
