/**
 * FACE SAMPLER (module worker)
 *
 * Walks the head field and produces a labelled point cloud. Runs off the main
 * thread so the interface never blocks while the face is generated.
 *
 * Output is transferred, not copied:
 *   positions  Float32Array  n*3
 *   normals    Float32Array  n*3
 *   regions    Uint8Array    n
 *   attributes Float32Array  n*4   seed, size, speed, brightness
 */

import { headField, headNormal, lastRegion, refineRegion, BOUNDS, EYE } from './face-model.js';

const EYE_L = 14, EYE_R = 15, IRIS = 16, PUPIL = 17;

const SPAN_X = BOUNDS.max[0] - BOUNDS.min[0];
const SPAN_Y = BOUNDS.max[1] - BOUNDS.min[1];
const SPAN_Z = BOUNDS.max[2] - BOUNDS.min[2];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Density weight: keep the visible face dense, the back of the skull cheap. */
function density(z) {
  const t = (z + 6) / 11;
  const s = t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
  return 0.22 + 0.78 * s;
}

function sampleHead(count, rng, report) {
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const reg = new Uint8Array(count);
  const att = new Float32Array(count * 4);

  const half = 0.15;
  const n = [0, 0, 0];
  let found = 0;
  let attempts = 0;
  const maxAttempts = count * 900;

  while (found < count && attempts < maxAttempts) {
    attempts++;
    const x = BOUNDS.min[0] + rng() * SPAN_X;
    const y = BOUNDS.min[1] + rng() * SPAN_Y;
    const z = BOUNDS.min[2] + rng() * SPAN_Z;

    const d = headField(x, y, z);
    if (d < -half || d > half) continue;
    if (rng() > density(z)) continue;

    // Capture the region label for THIS sample before the normal search runs:
    // headNormal evaluates the field at four neighbours and leaves the global
    // label pointing at the last of them, not at the centre.
    const here = lastRegion();
    headNormal(x, y, z, n);
    const i = found * 3;
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    nrm[i] = n[0]; nrm[i + 1] = n[1]; nrm[i + 2] = n[2];
    reg[found] = refineRegion(here, x, y, z);

    const j = found * 4;
    att[j] = rng();                 // seed
    att[j + 1] = 0.68 + rng() * 0.62; // size
    att[j + 2] = 0.55 + rng() * 0.9;  // drift speed
    att[j + 3] = 0.68 + rng() * 0.42; // brightness

    found++;
    if ((found & 1023) === 0) report(found / count * 0.85);
  }

  return { pos, nrm, reg, att, found, attempts };
}

self.onmessage = (ev) => {
  const { count, seed, quality } = ev.data || {};
  const total = Math.max(1200, Math.min(24000, count | 0));
  const rng = mulberry32((seed | 0) || 0x1E6107);

  const eyeCount = Math.round(total * 0.11);
  const headCount = total - eyeCount;

  const head = sampleHead(headCount, rng, (p) => self.postMessage({ type: 'progress', value: p * 0.9 }));

  /* ---- eyes: dense spherical caps with iris + pupil ---------- */
  const eyeN = Math.floor(eyeCount / 2);
  const total_n = head.found + eyeN * 2;

  const pos = new Float32Array(head.found * 3 + eyeN * 6);
  const nrm = new Float32Array(head.found * 3 + eyeN * 6);
  const reg = new Uint8Array(total_n);
  const att = new Float32Array(total_n * 4);

  pos.set(head.pos.subarray(0, head.found * 3));
  nrm.set(head.nrm.subarray(0, head.found * 3));
  reg.set(head.reg.subarray(0, head.found));
  att.set(head.att.subarray(0, head.found * 4));

  let w = head.found;
  const irisR = EYE.r * 0.44;
  const pupilR = EYE.r * 0.185;

  for (let side = 0; side < 2; side++) {
    const sx = side === 0 ? -1 : 1;
    let made = 0;
    let guard = 0;
    while (made < eyeN && guard < eyeN * 400) {
      guard++;
      // Uniform over a forward-facing cap.
      const u = rng(), v = rng();
      const theta = Math.acos(1 - u * 0.55);
      const phi = v * Math.PI * 2;
      const r = EYE.r * (0.995 + rng() * 0.02);
      const nx = Math.sin(theta) * Math.cos(phi);
      const ny = Math.sin(theta) * Math.sin(phi);
      const nz = Math.cos(theta);

      if (nz < 0.24) continue;                       // keep the eye facing the viewer

      // Carve the palpebral fissure: a tapered almond, not a disc. Without this
      // the eye reads as a glowing orb rather than an eye.
      const ax = nx / 0.97;
      const ay = (ny + Math.abs(nx) * 0.05) / 0.44;
      const ayTapered = ay * (1 + 0.34 * ax * ax);
      if (ax * ax + ayTapered * ayTapered > 1) continue;
      if (ny > 0.30) continue;                       // upper-lid shadow

      const x = sx * EYE.x + nx * r;
      const y = EYE.y + ny * r - sx * nx * 0.16;     // slight canthal tilt
      const z = EYE.z + nz * r;

      const i = w * 3;
      pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
      nrm[i] = nx; nrm[i + 1] = ny; nrm[i + 2] = nz;

      // Radial distance across the eyeball surface, in millimetres, so the
      // iris and pupil are concentric with the sphere rather than stretched
      // sideways. Math.abs(nx) alone would put the pupil off to one side.
      const radial = Math.hypot(nx, ny) * r;
      let rcode;
      if (radial < pupilR) rcode = PUPIL;
      else if (radial < irisR) rcode = IRIS;
      else rcode = side === 0 ? EYE_L : EYE_R;
      reg[w] = rcode;

      const j = w * 4;
      att[j] = rng();
      att[j + 1] = 0.5 + rng() * 0.3;                // eye elements stay small
      att[j + 2] = 0.35 + rng() * 0.5;
      att[j + 3] = rcode === IRIS ? 1.3 : (rcode === PUPIL ? 0.0 : 1.05);

      w++;
      made++;
    }
  }

  // Copy into exact-sized views so the transferred buffers match the reported
  // count. Transferring the oversized parents would also work, but then the
  // renderer receives arrays longer than `count` and has to slice again.
  const outCount = w;
  const positions = pos.slice(0, outCount * 3);
  const normals = nrm.slice(0, outCount * 3);
  const regions = reg.slice(0, outCount);
  const attributes = att.slice(0, outCount * 4);

  self.postMessage({
    type: 'done',
    count: outCount,
    quality,
    positions,
    normals,
    regions,
    attributes
  }, [positions.buffer, normals.buffer, regions.buffer, attributes.buffer]);
};
