// physics.js — lazy 2D rigid-body physics for Loom, on rapier2d (compat/WASM build).
//
// Loom stays the spawner/conductor: event onsets create bodies (when / where / size /
// initial velocity / lifetime), and per-glyph oscs still drive colour/size. The SIM owns
// position — each frame the body transforms feed the glyph's x/y/rotation. Rapier is
// DYNAMICALLY imported on first use, so patches without physics() never load the WASM
// (Vite code-splits the import into its own chunk).
//
// We simulate in a scaled metric space (SCALE px per "metre") so Rapier's solver stays in
// its stable range, converting at the pixel boundary.

let RAPIER = null, _loading = null;
// Kick (or join) the one-time async load + WASM init. Resolves to the Rapier namespace.
export function ensureRapier() {
  if (RAPIER) return Promise.resolve(RAPIER);
  if (!_loading) _loading = import('@dimforge/rapier2d-compat').then((m) => {
    const R = m && m.World ? m : m.default;        // named exports or default namespace
    return R.init().then(() => (RAPIER = R));
  });
  return _loading;
}
export const rapierReady = () => RAPIER;            // null until loaded; the namespace after

const SCALE = 100;          // pixels per simulated metre

export class PhysWorld {
  constructor(R) {
    this.R = R;
    this.world = new R.World({ x: 0, y: 0 });
    this.walls = [];        // fixed wall bodies
    this.wallCols = [];     // their colliders (so we can retune restitution live)
    this.W = 0; this.H = 0;
    this.bounce = 0.6;
  }
  setGravity(gxPx, gyPx) { this.world.gravity = { x: gxPx / SCALE, y: gyPx / SCALE }; }   // y+ = down screen
  setBounce(b) { this.bounce = b; for (const c of this.wallCols) c.setRestitution(b); }
  // A box of static colliders at the screen edges, so bodies bounce inside the canvas.
  setBounds(W, H) {
    if (W === this.W && H === this.H && this.wallCols.length) return;
    this.W = W; this.H = H;
    for (const b of this.walls) this.world.removeRigidBody(b);
    this.walls = []; this.wallCols = [];
    const R = this.R, t = 1;                        // wall half-thickness, metres
    const w = W / SCALE, h = H / SCALE;
    const mk = (x, y, hx, hy) => {
      const b = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y));
      const cd = R.ColliderDesc.cuboid(hx, hy); cd.setRestitution(this.bounce); cd.setFriction(0.3);
      this.wallCols.push(this.world.createCollider(cd, b));
      this.walls.push(b);
    };
    mk(w / 2, -t, w / 2 + t, t);                    // top
    mk(w / 2, h + t, w / 2 + t, t);                 // bottom
    mk(-t, h / 2, t, h / 2 + t);                    // left
    mk(w + t, h / 2, t, h / 2 + t);                 // right
  }
  // px/py = spawn point (px), vx/vy = initial velocity (px/s), av = initial angular
  // velocity (rad/s), drag = damping. col = collider descriptor in PIXELS:
  //   { kind:'ball', r } | { kind:'cuboid', hx, hy } | { kind:'hull', pts:Float32Array, r }
  // hull → a tight convex polygon (tri/pent/hex/…); falls back to a ball if degenerate.
  addBody(px, py, vx, vy, av, drag, col) {
    const R = this.R, S = SCALE;
    const bd = R.RigidBodyDesc.dynamic()
      .setTranslation(px / S, py / S)
      .setLinvel(vx / S, vy / S)
      .setAngvel(av)
      .setLinearDamping(drag).setAngularDamping(drag);
    const body = this.world.createRigidBody(bd);
    let cd = null;
    if (col.kind === 'cuboid') cd = R.ColliderDesc.cuboid(Math.max(0.03, col.hx / S), Math.max(0.03, col.hy / S));
    else if (col.kind === 'hull') {
      const sp = new Float32Array(col.pts.length);
      for (let i = 0; i < col.pts.length; i++) sp[i] = col.pts[i] / S;
      cd = R.ColliderDesc.convexHull(sp);        // null if the points are degenerate
    }
    if (!cd) cd = R.ColliderDesc.ball(Math.max(0.03, (col.r || 10) / S));
    cd.setRestitution(this.bounce); cd.setFriction(0.4); cd.setDensity(1);
    this.world.createCollider(cd, body);
    return body;
  }
  // Apply an acceleration (px/s²) to a body this frame, MASS-INDEPENDENT like gravity:
  // impulse = mass · Δv, with Δv = accel · dt (converted to metres). Used by the force-fields.
  applyAccel(body, axPx, ayPx, dt) {
    const m = body.mass() || 1;
    body.applyImpulse({ x: (axPx / SCALE) * m * dt, y: (ayPx / SCALE) * m * dt }, true);
  }
  remove(body) { try { this.world.removeRigidBody(body); } catch (e) { /* already gone */ } }
  step(dt) { this.world.timestep = Math.min(1 / 30, Math.max(1 / 240, dt)); this.world.step(); }
  read(body) {
    const t = body.translation(), r = body.rotation();
    return { x: t.x * SCALE, y: t.y * SCALE, rot: typeof r === 'number' ? r : (r && r.angle) || 0 };
  }
  dispose() { try { this.world.free(); } catch (e) { /* noop */ } }
}
