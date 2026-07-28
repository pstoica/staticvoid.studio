// hands.js — lazy MediaPipe hand + pose tracking for Loom (webcam → signals).
//
// Loom's fourth native input: the camera. Same shape as every other external feed —
// hands.js owns the device + models and pushes compact per-frame STATE into pattern.js
// signals (fingerX/fingerUp/pinch/poseX/…), which obey the frozen/live rule like
// mouseX or ballX. Everything here is DYNAMICALLY imported on first use (like rapier):
// a patch that never mentions a hand signal never loads the WASM, never fetches a
// model, and never prompts for the camera. The wasm runtime comes from jsdelivr pinned
// to the installed @mediapipe/tasks-vision version; the models from Google's bucket —
// both are network fetches either way, so nothing is vendored into the repo.
//
// Graceful degrade is the contract: no camera / permission denied / load failure →
// the signals just hold their defaults, a single console.warn, no errors.

const MP_VERSION = '1.0.0';   // keep in lockstep with package.json @mediapipe/tasks-vision
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let _mp = null, _mpLoading = null;          // the tasks-vision module + FilesetResolver result
let _video = null, _videoLoading = null;    // shared webcam element (one stream for both models)
let _hand = null, _handLoading = null;      // HandLandmarker
let _pose = null, _poseLoading = null;      // PoseLandmarker
let _failed = false;                        // any hard failure → stay silent forever after
let _lastTs = -1;                           // detectForVideo timestamps must strictly increase
let _flipX = true;                          // selfie mirror (default on: move right → drawing moves right)
let _state = 'off';                         // 'off' | 'starting' | 'live' | 'blocked' — surfaced in the UI

const _warn = (what, e) => { if (!_failed) console.warn('Loom tracking: ' + what, e || ''); _failed = true; _state = 'blocked'; };

async function ensureVision() {
  if (_mp) return _mp;
  if (!_mpLoading) _mpLoading = import('@mediapipe/tasks-vision').then(async (m) => {
    const fileset = await m.FilesetResolver.forVisionTasks(WASM_BASE);
    return (_mp = { m, fileset });
  });
  return _mpLoading;
}

async function ensureCamera() {
  if (_video) return _video;
  if (!_videoLoading) _videoLoading = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false });
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    v.width = v.videoWidth; v.height = v.videoHeight;   // belt-and-braces: consumers that read .width see real dims
    _video = v;
    if (_state !== 'blocked') _state = 'live';   // frames are flowing (models may still be fetching)
    return v;
  })();
  return _videoLoading;
}

// Kick (or join) the lazy loads for whichever trackers the patch wants. Idempotent and
// additive — a re-run that adds pose signals only loads the pose model. Never throws.
export function ensureTracking(want) {
  if (_failed || !want) return;
  if (_state === 'off' && (want.cam || want.hands || want.pose)) _state = 'starting';
  // cam() backdrop alone: just the webcam, no models, no wasm — the cheapest path.
  if (want.cam && !_video && !_videoLoading) ensureCamera().catch((e) => _warn('camera unavailable', e));
  if (want.hands && !_hand && !_handLoading) {
    _handLoading = Promise.all([ensureVision(), ensureCamera()]).then(([v]) =>
      v.m.HandLandmarker.createFromOptions(v.fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
      }).then((h) => (_hand = h))
    ).catch((e) => _warn('hands unavailable (camera or model)', e));
  }
  if (want.pose && !_pose && !_poseLoading) {
    _poseLoading = Promise.all([ensureVision(), ensureCamera()]).then(([v]) =>
      v.m.PoseLandmarker.createFromOptions(v.fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numPoses: 1,
      }).then((p) => (_pose = p))
    ).catch((e) => _warn('pose unavailable (camera or model)', e));
  }
}

export const trackingReady = () => !!(_video && (_hand || _pose));
export const trackingVideo = () => _video;                 // for the GL camera overlay
export const trackingState = () => _state;                 // 'off' | 'starting' | 'live' | 'blocked'
export function setTrackingFlip(v) { _flipX = !!v; }
export function getTrackingFlip() { return _flipX; }

// ── landmark → state processing ─────────────────────────────────────────────────
// Fingertips 0..4 = thumb, index, middle, ring, pinky. Extension heuristic: a finger
// is "up" when its tip is further from the wrist than its PIP joint (rotation-proof);
// the thumb when its tip clears its IP joint moving away from the pinky's base.
// pinch = thumb↔index tip closeness normalised by hand size (1 = touching).
const TIP = [4, 8, 12, 16, 20], PIP = [3, 6, 10, 14, 18];
function processHands(res) {
  const out = [];
  const lms = res.landmarks || [];
  const heds = res.handednesses || res.handedness || [];
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    // MediaPipe handedness labels assume a MIRRORED (selfie) image — correct as-is under
    // our default flip; swap when the mirror is off so "right" stays the user's right.
    let handed = ((heds[i] && heds[i][0] && heds[i][0].categoryName) || '').toLowerCase();
    if (!_flipX) handed = handed === 'left' ? 'right' : handed === 'right' ? 'left' : handed;
    const X = (p) => (_flipX ? 1 - lm[p].x : lm[p].x);
    const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    const ref = d(0, 9) || 1e-4;                           // wrist → middle MCP = hand size
    out.push({
      handed,
      x: TIP.map((t) => X(t)),
      y: TIP.map((t) => lm[t].y),
      z: TIP.map((t) => lm[t].z),                          // relative depth, wrist-origin; negative = toward camera
      up: TIP.map((t, f) => (f === 0 ? (d(4, 17) > d(3, 17) * 1.05 ? 1 : 0)
                                     : (d(t, 0) > d(PIP[f], 0) * 1.08 ? 1 : 0))),
      palm: [(X(0) + X(9)) / 2, (lm[0].y + lm[9].y) / 2],
      pinch: Math.max(0, Math.min(1, 1 - d(4, 8) / (1.5 * ref))),
      near: Math.max(0, Math.min(1, (ref - 0.1) / 0.35)),  // apparent hand size = distance proxy (1 = close)
    });
  }
  return { hands: out };
}
function processPose(res) {
  const lm = (res.landmarks && res.landmarks[0]) || null;
  if (!lm) return { seen: 0, x: [], y: [] };
  return { seen: 1, x: lm.map((p) => (_flipX ? 1 - p.x : p.x)), y: lm.map((p) => p.y) };
}

// One detection pass, called from Loom's tick. Returns { hands?, pose? } states to push
// into the DSL, or null when there's nothing new (not loaded / no fresh video frame).
export function trackTick(nowMs) {
  if (_failed || !_video || _video.readyState < 2) return null;
  const ts = Math.round(nowMs);
  if (ts <= _lastTs) return null;                          // timestamps must increase (loom.step bursts)
  _lastTs = ts;
  const out = {};
  try {
    if (_hand) out.hands = processHands(_hand.detectForVideo(_video, ts));
    if (_pose) out.pose = processPose(_pose.detectForVideo(_video, ts));
  } catch (e) { _warn('detection failed', e); return null; }
  return (out.hands || out.pose) ? out : null;
}
