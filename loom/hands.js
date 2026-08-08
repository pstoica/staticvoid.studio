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
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let _mp = null, _mpLoading = null;          // the tasks-vision module + FilesetResolver result
let _video = null, _videoLoading = null;    // shared webcam element (one stream for both models)
let _hand = null, _handLoading = null;      // HandLandmarker
let _pose = null, _poseLoading = null;      // PoseLandmarker
let _seg = null, _segLoading = null;        // ImageSegmenter (person silhouette)
let _face = null, _faceLoading = null;      // FaceLandmarker (mouth / expression blendshapes)
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
  if (want.face && !_face && !_faceLoading) {
    _faceLoading = Promise.all([ensureVision(), ensureCamera()]).then(([v]) =>
      v.m.FaceLandmarker.createFromOptions(v.fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true,        // jawOpen / smile / brows come from these
      }).then((f) => (_face = f))
    ).catch((e) => _warn('face tracking unavailable (camera or model)', e));
  }
  if (want.seg && !_seg && !_segLoading) {
    _segLoading = Promise.all([ensureVision(), ensureCamera()]).then(([v]) =>
      v.m.ImageSegmenter.createFromOptions(v.fileset, {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      }).then((s) => (_seg = s))
    ).catch((e) => _warn('segmentation unavailable (camera or model)', e));
  }
}

export const trackingReady = () => !!(_video && (_hand || _pose || _seg || _face));
export const trackingVideo = () => _video;                 // for the GL camera overlay
export const trackingState = () => _state;                 // 'off' | 'starting' | 'live' | 'blocked'
export function setTrackingFlip(v) { _flipX = !!v; }
export function getTrackingFlip() { return _flipX; }

// ── landmark → state processing ─────────────────────────────────────────────────
// Fingertips 0..4 = thumb, index, middle, ring, pinky. Extension heuristic: a finger
// is "up" when its tip is further from the wrist than its PIP joint (rotation-proof);
// the thumb when its tip clears its IP joint moving away from the pinky's base.
// pinch = thumb↔index tip closeness normalised by hand size (1 = touching).
// Positions are remapped through the same CONTAIN fit the cam() backdrop's main image
// uses (sx/sy squeeze one axis about the centre), so a dot at fingerX/fingerY lands ON
// your fingertip in the unwarped image — with or without cam() visible, same coords.
const TIP = [4, 8, 12, 16, 20], PIP = [3, 6, 10, 14, 18];
function processHands(res, sx, sy) {
  const out = [];
  const lms = res.landmarks || [];
  const heds = res.handednesses || res.handedness || [];
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    // MediaPipe handedness labels assume a MIRRORED (selfie) image — correct as-is under
    // our default flip; swap when the mirror is off so "right" stays the user's right.
    let handed = ((heds[i] && heds[i][0] && heds[i][0].categoryName) || '').toLowerCase();
    if (!_flipX) handed = handed === 'left' ? 'right' : handed === 'right' ? 'left' : handed;
    const X = (p) => 0.5 + ((_flipX ? 1 - lm[p].x : lm[p].x) - 0.5) * sx;
    const Y = (p) => 0.5 + (lm[p].y - 0.5) * sy;
    const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    const ref = d(0, 9) || 1e-4;                           // wrist → middle MCP = hand size (raw frame units)
    out.push({
      handed,
      x: TIP.map((t) => X(t)),
      y: TIP.map((t) => Y(t)),
      z: TIP.map((t) => lm[t].z),                          // relative depth, wrist-origin; negative = toward camera
      up: TIP.map((t, f) => (f === 0 ? (d(4, 17) > d(3, 17) * 1.05 ? 1 : 0)
                                     : (d(t, 0) > d(PIP[f], 0) * 1.08 ? 1 : 0))),
      palm: [(X(0) + X(9)) / 2, (Y(0) + Y(9)) / 2],
      pinch: Math.max(0, Math.min(1, 1 - d(4, 8) / (1.5 * ref))),
      near: Math.max(0, Math.min(1, (ref - 0.1) / 0.35)),  // apparent hand size = distance proxy (1 = close)
    });
  }
  return { hands: out };
}
// Face: the blendshapes are the useful part — jawOpen is a clean 0..1 "mouth open",
// which is the signal for singing/talking-driven visuals. Positions come from the lip
// landmarks so particles can pour out of the actual mouth.
const BS = (res, name) => {
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  if (!cats) return 0;
  for (const c of cats) if (c.categoryName === name) return c.score;
  return 0;
};
function processFace(res, sx, sy) {
  const lm = (res.faceLandmarks && res.faceLandmarks[0]) || null;
  if (!lm) return { seen: 0, open: 0, smile: 0, mx: 0.5, my: 0.5, fx: 0.5, fy: 0.5, brow: 0 };
  const X = (p) => 0.5 + ((_flipX ? 1 - lm[p].x : lm[p].x) - 0.5) * sx;
  const Y = (p) => 0.5 + (lm[p].y - 0.5) * sy;
  // 13 = inner upper lip, 14 = inner lower lip, 1 = nose tip
  const open = BS(res, 'jawOpen');
  const smile = (BS(res, 'mouthSmileLeft') + BS(res, 'mouthSmileRight')) / 2;
  const brow = (BS(res, 'browInnerUp') + BS(res, 'browOuterUpLeft') + BS(res, 'browOuterUpRight')) / 3;
  return { seen: 1, open, smile, brow,
    mx: (X(13) + X(14)) / 2, my: (Y(13) + Y(14)) / 2, fx: X(1), fy: Y(1) };
}
function processPose(res, sx, sy) {
  const lm = (res.landmarks && res.landmarks[0]) || null;
  if (!lm) return { seen: 0, x: [], y: [] };
  return { seen: 1,
    x: lm.map((p) => 0.5 + ((_flipX ? 1 - p.x : p.x) - 0.5) * sx),
    y: lm.map((p) => 0.5 + (p.y - 0.5) * sy) };
}

// One detection pass, called from Loom's tick. cw/ch = the canvas size, so positions can
// be remapped through the contain fit (see above). Returns { hands?, pose? } states to
// push into the DSL, or null when there's nothing new (not loaded / no fresh frame).
export function trackTick(nowMs, cw, ch) {
  if (_failed || !_video || _video.readyState < 2) return null;
  const ts = Math.round(nowMs);
  if (ts <= _lastTs) return null;                          // timestamps must increase (loom.step bursts)
  _lastTs = ts;
  // contain-fit squeeze factors: video aspect vs canvas aspect (identity if either unknown)
  let sx = 1, sy = 1;
  const tw = _video.videoWidth, th = _video.videoHeight;
  if (tw && th && cw && ch) {
    const At = tw / th, Av = cw / ch;
    if (At < Av) sx = At / Av; else sy = Av / At;
  }
  const out = {};
  try {
    if (_hand) out.hands = processHands(_hand.detectForVideo(_video, ts), sx, sy);
    if (_pose) out.pose = processPose(_pose.detectForVideo(_video, ts), sx, sy);
    if (_face) out.face = processFace(_face.detectForVideo(_video, ts), sx, sy);
    if (_seg) {
      // callback form: the MPMask is only valid inside — getAsFloat32Array copies it out.
      // Selfie segmenter emits person confidence; some builds emit [background, person].
      _seg.segmentForVideo(_video, ts, (res) => {
        const cms = res.confidenceMasks;
        const mk = cms && (cms.length > 1 ? cms[1] : cms[0]);
        if (mk) out.mask = { data: mk.getAsFloat32Array(), w: mk.width, h: mk.height,
                             vw: _video.videoWidth, vh: _video.videoHeight };
      });
    }
  } catch (e) { _warn('detection failed', e); return null; }
  return (out.hands || out.pose || out.mask || out.face) ? out : null;
}
