/**
 * LEGION MARK MODEL
 * =================
 * The signed-distance field behind LEGION's logo: one thick circular ring,
 * sliced into three equal arcs. Analytic, like the head field it replaces --
 * no asset, no scan, no image.
 *
 * Frame:  +X right, +Y up, +Z toward the viewer.  Units are centimetres.
 *
 * THE CUTS
 * The three gaps sit at 2, 6 and 10 o'clock. Measured counter-clockwise from
 * +X, an o'clock position is `hour * 30deg`, so the gaps are centred on 30,
 * 150 and 270 degrees, and what survives is centred on 90, 210 and 330 --
 * 12, 4 and 8 o'clock. Because the three centres are exactly 120 degrees
 * apart, the arcs are equal by construction rather than by eyeballing three
 * separate cut planes, and a single 120-degree fold in the angular coordinate
 * is enough to reason about all of them at once.
 *
 * Each gap is 30 degrees wide, so each arc spans 90 degrees: three quarters of
 * a turn of material, three slices through it.
 */

export const DEG = Math.PI / 180;

/**
 * Angle of a clock position, in radians, measured counter-clockwise from +X.
 *
 * An hour hand moves clockwise while the angle grows counter-clockwise, so
 * 12 o'clock is +Y at 90 degrees and every hour after it subtracts 30. The
 * naive `hour * 30` puts 12 o'clock at 3 o'clock, which is the error that would
 * have put the cuts in the wrong three places.
 */
export const clockAngle = (hour) => {
  const deg = (15 - hour) * 30;
  // Normalise, so 12 o'clock reads 90 degrees and not 450, then convert.
  return ((((deg + 180) % 360) + 360) % 360 - 180) * DEG;
};

/** Gap centres: 2, 6 and 10 o'clock. */
export const GAP_HOURS = [2, 6, 10];
/** Arc centres: 12, 4 and 8 o'clock. */
export const ARC_HOURS = [12, 4, 8];

export const LOGO = {
  outerR: 11.4,      // outside of the ring
  innerR: 6.7,       // the hole. 4.7cm of band: a thick ring, not a hairline
  halfDepth: 1.5,    // half the extrusion in Z, so the mark has real depth
  rim: 0.55,         // corner rounding of the (radius, depth) cross-section
  gapHalf: 15 * DEG, // each gap is 30 degrees wide, so each arc spans 90
  cutSoft: 0.16,     // slight rounding where a cut meets the band
  capDepth: 0.75,    // how far back from a cut the bright end-cap runs
  rimWidth: 0.85     // width of the labelled outer and inner edges
};

export const REGION = {
  BAND: 0,      // the body of the ring
  CAP: 1,       // the six cut ends. Lit in the theme accent, so a theme change
                // is visible on the mark and not only in the chrome
  RIM_OUTER: 2, // outer edge
  RIM_INNER: 3  // inner edge
};

export const REGION_NAMES = Object.keys(REGION);

/** Region name for a region id, for logging and for the sampler's tally. */
export const regionName = (id) => REGION_NAMES[id];

/** One 120-degree cell of the ring. */
export const SEG_SPAN = (2 * Math.PI) / 3;
const SEG_CENTRE_0 = clockAngle(ARC_HOURS[0]);
/** Half of a surviving arc: 60 degrees of cell, less 15 of gap on each side. */
export const ARC_HALF = SEG_SPAN / 2 - LOGO.gapHalf;

const BAND_MID = (LOGO.outerR + LOGO.innerR) / 2;
const BAND_HALF = (LOGO.outerR - LOGO.innerR) / 2;

/* ---------------------------------------------------------------- */
/* Polar helpers                                                      */
/* ---------------------------------------------------------------- */

/**
 * Fold an angle into the 120-degree cell whose arc is nearest to it.
 *
 * The returned `rel` is measured from that arc's own centre and always lands
 * in [-60, +60] degrees, so the cut plane is the single test `|rel| > 45` no
 * matter which arc the point is on.
 *
 * @returns {{cell:number, rel:number, centre:number}}
 */
export function foldAngle(ang) {
  const cell = Math.round((ang - SEG_CENTRE_0) / SEG_SPAN);
  const centre = SEG_CENTRE_0 + cell * SEG_SPAN;
  return { cell, centre, rel: ang - centre };
}

/**
 * Distance past the nearest cut plane, in centimetres. Negative inside an arc.
 *
 * Each cut face is a radial plane, so `r * sin(delta)` is the true distance to
 * it rather than the arc length, which matters because these are exactly the
 * faces the mark is read by.
 */
export function cutDistance(radius, ang) {
  const { rel } = foldAngle(ang);
  return Math.max(radius, 1e-6) * Math.sin(Math.abs(rel) - ARC_HALF);
}

/* ---------------------------------------------------------------- */
/* Distance primitives                                                */
/* ---------------------------------------------------------------- */

/**
 * The band's cross-section as a rounded rectangle in the (radius, depth)
 * plane. Exported so the sampler can reject points outside the rounded
 * corners without duplicating the geometry.
 *
 * The rounding is subtracted from the half-extents before it is added back as
 * the corner radius, because the rounded-box form treats `r` as growing
 * outward from `b`. Passing the full half-extent alongside the radius would
 * silently widen the ring by 2 * rim on both the inner and the outer edge.
 */
export function bandSdf(radius, z) {
  const qx = Math.abs(radius - BAND_MID) - (BAND_HALF - LOGO.rim);
  const qz = Math.abs(z) - (LOGO.halfDepth - LOGO.rim);
  const mx = qx > 0 ? qx : 0;
  const mz = qz > 0 ? qz : 0;
  return Math.sqrt(mx * mx + mz * mz) + Math.min(Math.max(qx, qz), 0) - LOGO.rim;
}

function smax(a, b, k) {
  if (k <= 0) return Math.max(a, b);
  const h = Math.max(0, Math.min(1, 0.5 - (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h + k * h * (1 - h);
}

/**
 * Evaluate the mark field. The solid is the band intersected with the part of
 * the circle that is not in a gap, and the distance to an intersection is the
 * larger of the two, so the answer is a max, not a min as it would be for a
 * union of features.
 */
export function logoField(x, y, z) {
  const r = Math.hypot(x, y);
  return smax(bandSdf(r, z), cutDistance(r, Math.atan2(y, x)), LOGO.cutSoft);
}

/** Central-difference surface normal. */
export function logoNormal(x, y, z, out) {
  const h = 0.03;
  const dx = logoField(x + h, y, z) - logoField(x - h, y, z);
  const dy = logoField(x, y + h, z) - logoField(x, y - h, z);
  const dz = logoField(x, y, z + h) - logoField(x, y, z - h);
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  out[0] = dx / len; out[1] = dy / len; out[2] = dz / len;
  return out;
}

/**
 * Label a point from its polar position alone.
 *
 * The head model needed a second `refineRegion` pass because the field's
 * region global is clobbered by the four neighbour evaluations the normal
 * search performs. Nothing here depends on evaluation order: the mark's labels
 * are a pure function of radius and angle, so they can be read before the
 * normal is taken and there is nothing to repair afterwards.
 */
export function markLabel(radius, ang) {
  // Inside an arc the cut distance is negative and grows away from the cut, so
  // the end-cap is the band of points within capDepth *of the plane*, which is
  // a distance greater than -capDepth. Testing `distance < capDepth` instead
  // would match the whole of every arc and label the entire mark as an end.
  if (cutDistance(radius, ang) > -LOGO.capDepth) return REGION.CAP;
  if (radius > LOGO.outerR - LOGO.rimWidth) return REGION.RIM_OUTER;
  if (radius < LOGO.innerR + LOGO.rimWidth) return REGION.RIM_INNER;
  return REGION.BAND;
}

export const BOUNDS = { min: [-12.2, -12.2, -2.2], max: [12.2, 12.2, 2.2] };
