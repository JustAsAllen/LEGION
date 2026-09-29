/**
 * MARK SAMPLER (module worker)
 *
 * Produces a labelled point cloud for the logo. Runs off the main thread so the
 * interface never blocks while the mark is generated.
 *
 * Unlike the head this replaces, the mark is sampled in polar coordinates
 * rather than by rejection over a bounding box. The shape is an annulus with
 * three angular windows removed, so a point can be drawn directly inside a
 * surviving arc: no sample can ever land in a gap, and there is no search for
 * it. The head sampler threw away 97% of its draws before finding the surface;
 * this one keeps about 98% of them.
 *
 * Output is transferred, not copied:
 *   positions  Float32Array  n*3
 *   normals    Float32Array  n*3
 *   regions    Uint8Array    n
 *   attributes Float32Array  n*4   seed, size, speed, brightness
 */

import {
  logoNormal, markLabel, bandSdf, clockAngle,
  ARC_HALF, ARC_HOURS, LOGO, REGION
} from './logo-model.js';

const ARC_CENTRES = ARC_HOURS.map(clockAngle);
const ARCS = ARC_CENTRES.length;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleMark(count, rng, report) {
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const reg = new Uint8Array(count);
  const att = new Float32Array(count * 4);

  const n = [0, 0, 0];
  const rLo = LOGO.innerR - LOGO.rim;
  const rHi = LOGO.outerR + LOGO.rim;
  const zHi = LOGO.halfDepth + LOGO.rim;

  let found = 0;
  let attempts = 0;
  // Only the rounded corners of the cross-section are rejected, so this is a
  // backstop against a pathological draw count rather than a real search.
  const maxAttempts = count * 20;

  while (found < count && attempts < maxAttempts) {
    attempts++;

    // Round-robin over the three arcs, so the counts are equal to within one
    // and, more usefully, so *any* prefix of the cloud is already a fair
    // random subset of the whole mark. The field relies on that when a quality
    // tier draws fewer instances than were generated, and cycling the arc index
    // gets it for free where a shuffle would have been needed.
    const centre = ARC_CENTRES[found % ARCS];

    // Uniform along the surviving arc. Drawn inside the cut, so the shape is
    // exact by construction rather than by rejection.
    const ang = centre + (rng() * 2 - 1) * ARC_HALF;

    // Uniform in the band's cross-section, in polar terms that is uniform in
    // radius and depth. The rounded corners come out slightly under-filled by
    // the rejection, which reads as a softer edge.
    const r = rLo + rng() * (rHi - rLo);
    const z = (rng() * 2 - 1) * zHi;
    if (bandSdf(r, z) > 0) continue;

    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;

    const i = found * 3;
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;

    // The label is a pure function of radius and angle, so it is read before
    // the normal search and cannot be disturbed by it.
    const region = markLabel(r, ang);
    reg[found] = region;
    logoNormal(x, y, z, n);
    nrm[i] = n[0]; nrm[i + 1] = n[1]; nrm[i + 2] = n[2];

    const j = found * 4;
    att[j] = rng();                          // seed
    att[j + 1] = 0.62 + rng() * 0.55;        // size
    att[j + 2] = 0.55 + rng() * 0.9;         // drift speed
    // The cut ends carry the accent colour, so they are given the extra
    // brightness to make the accent read as light rather than as paint.
    att[j + 3] = region === REGION.CAP
      ? 1.02 + rng() * 0.30
      : 0.62 + rng() * 0.40;

    found++;
    if ((found & 1023) === 0) report(found / count);
  }

  return { pos, nrm, reg, att, found, attempts, arcs: ARCS };
}

self.onmessage = (ev) => {
  const { count, seed, quality } = ev.data || {};
  const total = Math.max(1200, Math.min(24000, count | 0));
  const rng = mulberry32((seed | 0) || 0x1E6107);

  const cloud = sampleMark(total, rng, (p) => self.postMessage({ type: 'progress', value: p }));

  if (cloud.found < 1200) {
    self.postMessage({ type: 'error', message: 'mark sampler produced too few points: ' + cloud.found });
    return;
  }

  // Copy into exact-sized views so the transferred buffers match the reported
  // count. Transferring the oversized parents would also work, but then the
  // renderer receives arrays longer than `count` and has to slice again.
  const outCount = cloud.found;
  const positions = cloud.pos.slice(0, outCount * 3);
  const normals = cloud.nrm.slice(0, outCount * 3);
  const regions = cloud.reg.slice(0, outCount);
  const attributes = cloud.att.slice(0, outCount * 4);

  self.postMessage({
    type: 'done',
    count: outCount,
    quality,
    arcs: cloud.arcs,
    positions,
    normals,
    regions,
    attributes
  }, [positions.buffer, normals.buffer, regions.buffer, attributes.buffer]);
};
