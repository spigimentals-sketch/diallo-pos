// liveness.js — lightweight client-side liveness check for the clock-in
// camera. Confirms a real face is in frame and that a blink happened during
// the session, using face-api.js (runs fully in-browser; no per-check cost,
// no data leaves the device until the cashier actually captures a photo).
//
// This is NOT the same guarantee a paid liveness vendor (AWS Rekognition
// Face Liveness, FaceTec, etc.) gives — those use depth/motion models
// trained specifically to catch spoofing. This stops the laziest spoof
// (holding up a printed photo, which never blinks) but a video replay of a
// blinking person on another screen would still pass. Right-sized for a
// free, no-infrastructure deterrent, not a hard security guarantee.
//
// Model weights aren't bundled in the face-api.js package (by design —
// nobody ships ~10MB of weights in an npm package) and are loaded here from
// jsdelivr's GitHub mirror of the project's own weights, the standard
// source for this library.
import * as faceapi from 'face-api.js';

const MODEL_BASE = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';

let modelsPromise = null;
export function loadFaceModels() {
  if (!modelsPromise) {
    modelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_BASE),
    ]);
  }
  return modelsPromise;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Standard 6-point eye-aspect-ratio (Soukupová & Čech, 2016). Each eye is
// [corner, top1, top2, corner, bottom1, bottom2] in that order, which is
// exactly what face-api.js's getLeftEye()/getRightEye() return — open eyes
// land around 0.25-0.35, closed eyes drop towards 0.1-0.2.
export function eyeAspectRatio(eye) {
  const [p1, p2, p3, p4, p5, p6] = eye;
  return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4));
}

export const EAR_CLOSED = 0.22;
export const EAR_OPEN = 0.27;

// One detection pass over the current video frame. Returns null if no face
// was found, otherwise the averaged eye-aspect-ratio for that frame.
export async function detectFaceEAR(video) {
  const result = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
    .withFaceLandmarks();
  if (!result) return null;
  const left = eyeAspectRatio(result.landmarks.getLeftEye());
  const right = eyeAspectRatio(result.landmarks.getRightEye());
  return (left + right) / 2;
}
