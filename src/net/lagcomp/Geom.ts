/**
 * Lag compensation — geometry primitives.
 *
 * Scalar-argument, Float32Array-output maths so the hot path allocates nothing.
 * Single-threaded, non-reentrant use only (the module-level scratch below is
 * shared); every caller in this module finishes with a scratch buffer before the
 * next call begins.
 *
 * A word on why hit resolution happens *here* rather than by teleporting Rapier
 * colliders back in time: rewinding a physics world means mutating shared state
 * on the server, restoring it exactly, and hoping nothing observed the world in
 * between. It is the classic source of "the hitboxes never came back" bugs, it
 * costs a broadphase rebuild per shot, and it cannot run in a headless process
 * that does not want a physics backend for player-vs-player at all. Ray-testing
 * stored transforms directly is allocation-free, exactly reversible (nothing was
 * ever changed) and deterministic. Static world occlusion is handled separately
 * by the caller, because static geometry does not move and therefore does not
 * need rewinding.
 */

const EPS = 1e-8;

/** Rotate (vx,vy,vz) by unit quaternion q, writing 3 floats at out[o..o+2]. */
export function rotateVec(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
  out: Float32Array, o = 0,
): void {
  // t = 2 * (q.xyz × v);  v' = v + q.w*t + q.xyz × t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[o] = vx + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** Rotate by the conjugate of q (i.e. world → box local for a unit q). */
export function rotateVecInv(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
  out: Float32Array, o = 0,
): void {
  rotateVec(-qx, -qy, -qz, qw, vx, vy, vz, out, o);
}

/**
 * Does the segment [origin, origin + dir*maxDist] touch the sphere?
 * `dir` must be normalised. Returns true when the origin is inside as well.
 */
export function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, radius: number,
  maxDist: number,
): boolean {
  const mx = cx - ox, my = cy - oy, mz = cz - oz;
  const r2 = radius * radius;
  const d2 = mx * mx + my * my + mz * mz;
  if (d2 <= r2) return true;                    // origin inside
  const t = mx * dx + my * dy + mz * dz;         // projection onto the ray
  if (t < 0) return false;                       // sphere is behind
  if (t - radius > maxDist) return false;        // beyond the segment
  const perp2 = d2 - t * t;
  return perp2 <= r2;
}

const _lo = new Float32Array(3);
const _ld = new Float32Array(3);
const _ln = new Float32Array(3);

/**
 * Ray vs oriented bounding box.
 *
 * `dir` must be normalised. Returns the distance along the ray to the entry
 * point, or -1 for a miss. When the origin is already inside the box the result
 * is 0 and the normal is -dir. On a hit, `outNormal` receives the world-space
 * outward surface normal (3 floats at `no`).
 */
export function rayObb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  px: number, py: number, pz: number,
  hx: number, hy: number, hz: number,
  qx: number, qy: number, qz: number, qw: number,
  maxDist: number,
  outNormal: Float32Array, no = 0,
): number {
  rotateVecInv(qx, qy, qz, qw, ox - px, oy - py, oz - pz, _lo, 0);
  rotateVecInv(qx, qy, qz, qw, dx, dy, dz, _ld, 0);

  let tmin = 0;
  let tmax = maxDist;
  let axis = -1;
  let sign = 1;

  for (let i = 0; i < 3; i++) {
    const h = i === 0 ? hx : i === 1 ? hy : hz;
    const o = _lo[i];
    const d = _ld[i];
    if (d > -EPS && d < EPS) {
      if (o < -h || o > h) return -1;            // parallel and outside the slab
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    let s = -1;                                   // normal points -axis on entry
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (axis < 0) {
    // Origin started inside the box: degenerate but legitimate (point blank).
    outNormal[no] = -dx; outNormal[no + 1] = -dy; outNormal[no + 2] = -dz;
    return 0;
  }

  _ln[0] = 0; _ln[1] = 0; _ln[2] = 0;
  _ln[axis] = sign;
  rotateVec(qx, qy, qz, qw, _ln[0], _ln[1], _ln[2], outNormal, no);
  return tmin;
}

/**
 * Distance from a world-space point to an oriented box, 0 when inside.
 * Used by the client-side audit of a semi-trusted host's damage claim.
 */
export function pointObbDistance(
  wx: number, wy: number, wz: number,
  px: number, py: number, pz: number,
  hx: number, hy: number, hz: number,
  qx: number, qy: number, qz: number, qw: number,
): number {
  rotateVecInv(qx, qy, qz, qw, wx - px, wy - py, wz - pz, _lo, 0);
  const ex = Math.abs(_lo[0]) - hx;
  const ey = Math.abs(_lo[1]) - hy;
  const ez = Math.abs(_lo[2]) - hz;
  const ox = ex > 0 ? ex : 0;
  const oy = ey > 0 ? ey : 0;
  const oz = ez > 0 ? ez : 0;
  return Math.sqrt(ox * ox + oy * oy + oz * oz);
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Normalised lerp between two quaternions, shortest arc, written as 4 floats at
 * out[o..o+3]. nlerp rather than slerp on purpose: between adjacent simulation
 * ticks the angle is a couple of degrees at most, where the two are numerically
 * indistinguishable, and nlerp has no trig and no near-antipodal branch.
 */
export function nlerpQuat(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  t: number,
  out: Float32Array, o = 0,
): void {
  const d = ax * bx + ay * by + az * bz + aw * bw;
  const s = d < 0 ? -1 : 1;
  let x = ax + t * (s * bx - ax);
  let y = ay + t * (s * by - ay);
  let z = az + t * (s * bz - az);
  let w = aw + t * (s * bw - aw);
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len < EPS) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1; return; }
  const inv = 1 / len;
  out[o] = x * inv; out[o + 1] = y * inv; out[o + 2] = z * inv; out[o + 3] = w * inv;
}

/** Angle in radians between two direction vectors. Zero-length ⇒ PI. */
export function angleBetween(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const la = Math.sqrt(ax * ax + ay * ay + az * az);
  const lb = Math.sqrt(bx * bx + by * by + bz * bz);
  if (la < EPS || lb < EPS) return Math.PI;
  let d = (ax * bx + ay * by + az * bz) / (la * lb);
  if (d > 1) d = 1; else if (d < -1) d = -1;
  return Math.acos(d);
}

export function dist3(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** True when all three components are finite. */
export function finite3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}
