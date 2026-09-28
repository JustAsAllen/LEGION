/**
 * LEGION FACE MODEL
 * =================
 * A signed-distance-field head, defined entirely in code. No scan, no image,
 * no asset. The field is an analytic function of (x, y, z) that returns both a
 * distance and the id of the feature that produced it, so the particle
 * sampler can label every point with a facial region for free.
 *
 * Frame:  +X right, +Y up, +Z toward the viewer.  Units are centimetres.
 * Layout: eye line y=+1.95, nose base y=-2.55, mouth y=-4.7, chin y=-9.9.
 *
 * Proportions are deliberately adult and masculine: heavy brow ridge, square
 * jaw, pronounced cheekbones, narrow straight nose, deep-set eyes.
 */

export const REGION = {
  FACE: 0,
  BROW: 1,
  SOCKET: 2,
  NOSE: 3,
  MOUTH: 4,
  CHEEK: 5,
  JAW: 6,
  EAR: 7,
  HAIR: 8,
  NECK: 9,
  SHOULDER: 10,
  CRANIUM: 11,
  LIP_UPPER: 12,
  LIP_LOWER: 13
};

export const REGION_NAMES = Object.keys(REGION);

export const EYE = { x: 2.72, y: 1.95, z: 3.95, r: 1.06 };

/* ---------------------------------------------------------------- */
/* Distance primitives                                               */
/* ---------------------------------------------------------------- */

export function sdSphere(px, py, pz, r) {
  return Math.hypot(px, py, pz) - r;
}

export function sdEllipsoid(px, py, pz, rx, ry, rz) {
  const ax = px / rx, ay = py / ry, az = pz / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  if (k0 < 1e-6) return -Math.min(rx, ry, rz);
  const bx = px / (rx * rx), by = py / (ry * ry), bz = pz / (rz * rz);
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return (k0 * (k0 - 1.0)) / k1;
}

export function sdRoundBox(px, py, pz, bx, by, bz, r) {
  const qx = Math.abs(px) - bx;
  const qy = Math.abs(py) - by;
  const qz = Math.abs(pz) - bz;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  const outside = Math.sqrt(mx * mx + my * my + mz * mz);
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside - r;
}

export function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const bb = bax * bax + bay * bay + baz * baz;
  let h = 0;
  if (bb > 1e-9) h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / bb));
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

export function smax(a, b, k) {
  if (k <= 0) return Math.max(a, b);
  const h = Math.max(0, Math.min(1, 0.5 - (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h + k * h * (1 - h);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* ---------------------------------------------------------------- */
/* The head field                                                    */
/* ---------------------------------------------------------------- */

let D = 1e9;
let R = REGION.FACE;

export function lastDistance() { return D; }
export function lastRegion() { return R; }

/** Union a feature into the field, tracking which feature won. */
function put(d, region) {
  if (d < D) { D = d; R = region; }
}

/** Smooth union that keeps the dominant feature's region id. */
function fuse(d, region, k) {
  const before = D;
  const winner = d < D ? region : R;
  D = smin(D, d, k);
  R = winner;
  void before;
}

/** Smooth subtraction: carves a feature out and tags the resulting cavity. */
function carve(d, region, k) {
  const winner = D < d ? R : region;
  D = smax(D, -d, k);
  R = winner;
}

/**
 * Evaluate the head field. Sets D and R as a side effect to avoid allocating
 * on the hot sampling path.
 */
export function headField(x, y, z) {
  D = 1e9; R = REGION.FACE;
  const ax = Math.abs(x);

  /* ---- cranium ------------------------------------------------ */
  fuse(sdEllipsoid(x, y - 3.4, z + 0.5, 7.35, 6.75, 7.55), REGION.CRANIUM, 0.0);

  /* ---- midface mass ------------------------------------------- */
  fuse(sdEllipsoid(x, y + 1.1, z - 1.5, 6.55, 6.05, 6.45), REGION.FACE, 1.2);

  /* ---- jaw: rounded box gives the square, adult male jawline --- */
  fuse(sdRoundBox(x, y + 5.5, z - 0.2, 4.35, 3.05, 4.3, 1.75), REGION.JAW, 0.9);
  fuse(sdEllipsoid(x, y + 8.15, z - 2.15, 2.55, 1.9, 2.35), REGION.JAW, 0.55);   // chin

  /* ---- neck + shoulders: a bust, not a floating head ---------- */
  fuse(sdCapsule(x, y, z, 0, -17.0, -1.6, 0, -9.2, -1.1, 3.55), REGION.NECK, 1.1);
  fuse(sdEllipsoid(x, y + 16.9, z + 1.4, 11.6, 3.3, 5.1), REGION.SHOULDER, 1.4);

  /* ---- cheekbones --------------------------------------------- */
  fuse(sdEllipsoid(ax - 4.45, y - 0.05, z - 2.35, 2.35, 1.5, 2.15), REGION.CHEEK, 0.75);

  /* ---- brow ridge: the strongest masculine cue ----------------- */
  fuse(sdEllipsoid(x, y - 2.8, z - 4.95, 5.15, 0.98, 1.5), REGION.BROW, 0.4);
  fuse(sdEllipsoid(x, y - 2.3, z - 5.05, 1.15, 1.35, 0.95), REGION.BROW, 0.3);     // glabella
  fuse(sdEllipsoid(ax - 2.7, y - 2.62, z - 4.75, 1.95, 0.78, 1.05), REGION.BROW, 0.3);

  /* ---- eye sockets: carve, then rebuild the lids -------------- */
  carve(sdEllipsoid(ax - EYE.x, y - EYE.y, z - 5.05, 2.3, 1.52, 1.8), REGION.SOCKET, 0.34);
  fuse(sdEllipsoid(ax - EYE.x, y - 2.78, z - 4.6, 2.4, 0.7, 1.5), REGION.SOCKET, 0.22);   // upper lid
  fuse(sdEllipsoid(ax - EYE.x, y - 1.02, z - 4.55, 2.3, 0.56, 1.42), REGION.SOCKET, 0.2);  // lower lid
  carve(sdEllipsoid(ax - EYE.x, y - 1.95, z - 5.9, 2.1, 1.15, 1.4), REGION.SOCKET, 0.5);  // lid crease

  /* ---- nose: narrow, straight, strongly defined --------------- */
  fuse(sdCapsule(x, y, z, 0, 2.95, 4.7, 0, -0.7, 5.45, 0.6), REGION.NOSE, 0.34);
  fuse(sdEllipsoid(x, y - 2.5, z - 4.9, 1.5, 0.66, 1.3), REGION.NOSE, 0.3);      // subnasale
  fuse(sdSphere(x, y + 1.72, z - 5.78, 0.8), REGION.NOSE, 0.26);                   // tip
  fuse(sdSphere(ax - 1.02, y + 2.05, z - 5.02, 0.72), REGION.NOSE, 0.24);          // wings
  carve(sdSphere(ax - 1.05, y + 2.35, z - 5.55, 0.3), REGION.NOSE, 0.14);          // nostrils
  carve(sdCapsule(x, y, z, 0, -2.85, 5.62, 0, -3.75, 5.5, 0.19), REGION.NOSE, 0.1); // philtrum

  /* ---- mouth: full, defined lips ------------------------------ */
  fuse(sdEllipsoid(x, y + 4.12, z - 4.98, 1.92, 0.5, 0.98), REGION.LIP_UPPER, 0.3);
  fuse(sdEllipsoid(x, y + 5.28, z - 4.86, 1.72, 0.62, 0.96), REGION.LIP_LOWER, 0.3);
  carve(sdCapsule(x, y, z, -2.0, -4.72, 4.35, 2.0, -4.72, 4.35, 0.15), REGION.MOUTH, 0.07);
  carve(sdSphere(ax - 2.05, y + 4.72, z - 4.05, 0.44), REGION.MOUTH, 0.2);          // corners
  carve(sdEllipsoid(x, y + 4.72, z - 4.9, 2.5, 0.5, 0.9), REGION.MOUTH, 0.24);     // mentolabial crease

  /* ---- ears --------------------------------------------------- */
  fuse(sdEllipsoid(ax - 7.0, y + 0.45, z + 0.75, 0.98, 2.5, 1.9), REGION.EAR, 0.5);
  carve(sdEllipsoid(ax - 7.55, y + 0.45, z + 0.9, 0.7, 1.35, 0.95), REGION.EAR, 0.22);

  /* ---- hair: an irregular shell over the cranium -------------- */
  const hairline = 2.5 + 4.35 * smoothstep(-7.0, 1.4, z)
    + 0.34 * Math.sin(x * 2.05) + 0.22 * Math.sin(z * 3.1 + x * 1.7);
  const shell = Math.abs(sdEllipsoid(x, y - 3.4, z + 0.5, 7.92, 7.3, 8.12)) - 0.92;
  const hair = smax(shell, y - hairline, 0.35);
  if (hair < D) { D = hair; R = REGION.HAIR; }

  return D;
}

/** Central-difference surface normal. */
export function headNormal(x, y, z, out) {
  const h = 0.035;
  const dx = headField(x + h, y, z) - headField(x - h, y, z);
  const dy = headField(x, y + h, z) - headField(x, y - h, z);
  const dz = headField(x, y, z + h) - headField(x, y, z - h);
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  out[0] = dx / len; out[1] = dy / len; out[2] = dz / len;
  return out;
}

/**
 * Secondary labels that depend on position rather than on the field, applied
 * after sampling. Kept separate so the field stays cheap.
 */
export function refineRegion(region, x, y, z) {
  if (region === REGION.FACE) {
    if (y < -3.3 && z > 0.9) return REGION.JAW;                 // beard / lower face
    if (y > 0.4 && y < 3.4 && z > 2.6) return REGION.FACE;      // keep
  }
  if (region === REGION.SOCKET) {
    if (y > 2.5) return REGION.BROW;
    if (y < 0.9) return REGION.FACE;
  }
  if (region === REGION.MOUTH) {
    if (y > -4.5 && y < -3.9) return REGION.LIP_UPPER;
    if (y < -5.0 && y > -5.6) return REGION.LIP_LOWER;
  }
  return region;
}

export const BOUNDS = { min: [-9.2, -18.5, -9.0], max: [9.2, 12.0, 9.6] };
