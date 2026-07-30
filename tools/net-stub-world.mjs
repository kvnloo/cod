/**
 * A tiny deterministic collision world for headless netcode tests.
 *
 * Implements just enough of `PhysicsAPI` and `CharacterController` for the
 * movement state machine to exercise its interesting branches — walls that
 * block, ledges that can be mantled, ground that can be slid along — without
 * booting Rapier and WASM in a test process. It is intentionally *not* a
 * physics engine: it only has to be identical on the host and the client, which
 * is exactly the property the real static level has too.
 *
 * Axis-aligned boxes and a ground plane at y = 0.
 */

import * as THREE from 'three';

/** @typedef {{min: THREE.Vector3, max: THREE.Vector3}} Box */

/** The shared test level: a couple of mantle-able crates and two long walls. */
export function defaultBoxes() {
  const mk = (cx, cy, cz, hx, hy, hz) => ({
    min: new THREE.Vector3(cx - hx, cy - hy, cz - hz),
    max: new THREE.Vector3(cx + hx, cy + hy, cz + hz),
  });
  return [
    mk(0, 0.45, -6, 1.4, 0.45, 1.4),   // low crate — mantle-able
    mk(5, 0.35, 2, 2.0, 0.35, 1.0),    // ledge — mantle-able
    mk(-6, 1.6, 0, 0.4, 1.6, 6.0),     // long wall — blocks
    mk(0, 1.6, -14, 10.0, 1.6, 0.4),   // long wall — blocks
    mk(12, 1.6, 0, 0.4, 1.6, 10.0),    // long wall — blocks
  ];
}

function rayBox(ox, oy, oz, dx, dy, dz, box, maxDist) {
  let tmin = 0, tmax = maxDist;
  let nx = 0, ny = 0, nz = 0;
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  let axis = -1, sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    const inv = 1 / d[i];
    let t1 = (lo[i] - o[i]) * inv;
    let t2 = (hi[i] - o[i]) * inv;
    let s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null;
  nx = axis === 0 ? sign : 0;
  ny = axis === 1 ? sign : 0;
  nz = axis === 2 ? sign : 0;
  return { t: tmin, nx, ny, nz };
}

export class StubWorld {
  constructor(boxes = defaultBoxes()) {
    this.boxes = boxes;
    this.ready = true;
  }

  raycast(origin, dir, maxDist, _mask, out) {
    let best = maxDist;
    let bn = null;
    for (const b of this.boxes) {
      const h = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b, maxDist);
      if (h && h.t < best && h.t >= 0) { best = h.t; bn = h; }
    }
    // Ground plane.
    if (dir.y < -1e-9) {
      const t = -origin.y / dir.y;
      if (t >= 0 && t < best) { best = t; bn = { t, nx: 0, ny: 1, nz: 0 }; }
    }
    if (!bn) {
      out.hit = false;
      out.distance = Infinity;
      return out;
    }
    out.hit = true;
    out.distance = best;
    out.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
    out.normal.set(bn.nx, bn.ny, bn.nz);
    out.surface = 'concrete';
    out.object = null;
    out.entityId = -1;
    out.bodyHandle = -1;
    out.zone = 'none';
    out.backface = false;
    return out;
  }

  raycastAll() { return 0; }
  spherecast(o, d, _r, maxDist, mask, out) { return this.raycast(o, d, maxDist, mask, out); }
  overlapSphere() { return 0; }
  lineOfSight() { return true; }
  addBody() { throw new Error('not supported'); }
  removeBody() { }
  applyExplosion() { }
  stats() { return { bodies: this.boxes.length, active: 0, contacts: 0, stepMs: 0 }; }

  createCharacter(radius, height) { return new StubCharacter(this, radius, height); }
}

class StubCharacter {
  constructor(world, radius, height) {
    this.world = world;
    this.radius = radius;
    this.height = height;
    this.stepHeight = 0.42;
    this.slopeLimit = 46;
    this._p = new THREE.Vector3();
  }

  setHeight(h) { this.height = h; }
  teleport(p) { this._p.copy(p); }
  dispose() { }

  canSetHeight(h, position) {
    const hh = h * 0.5;
    return !this.overlaps(position.x, position.y + (h - this.height) * 0.5, position.z, hh);
  }

  /** AABB approximation of the capsule at a candidate centre. */
  overlaps(x, y, z, halfHeight = this.height * 0.5) {
    const r = this.radius;
    for (const b of this.world.boxes) {
      if (x + r > b.min.x && x - r < b.max.x
        && y + halfHeight > b.min.y && y - halfHeight < b.max.y
        && z + r > b.min.z && z - r < b.max.z) return true;
    }
    return false;
  }

  move(position, motion, _dt, out) {
    const half = this.height * 0.5;
    let x = position.x, y = position.y, z = position.z;
    const sx = x, sy = y, sz = z;
    let blocked = false;
    let ceiling = false;

    // --- horizontal, axis by axis, with a step-up retry ---------------------
    const tryAxis = (nx, nz) => {
      if (!this.overlaps(nx, y, nz, half)) { x = nx; z = nz; return; }
      // Step up over a low obstacle without leaving the ground.
      const up = y + this.stepHeight;
      if (!this.overlaps(nx, up, nz, half) && !this.overlaps(nx, up, nz, half)) {
        // Only step up when the ground under the raised position is close.
        x = nx; z = nz; y = up;
        return;
      }
      blocked = true;
    };
    tryAxis(x + motion.x, z);
    tryAxis(x, z + motion.z);

    // --- vertical ------------------------------------------------------------
    let grounded = false;
    let ny = y + motion.y;
    if (motion.y <= 0) {
      // Land on the tallest box top we would pass through, else the ground.
      let landY = half; // ground plane
      for (const b of this.world.boxes) {
        if (x + this.radius > b.min.x && x - this.radius < b.max.x
          && z + this.radius > b.min.z && z - this.radius < b.max.z) {
          const top = b.max.y + half;
          if (top <= y + 1e-6 && top > landY) landY = top;
        }
      }
      if (ny <= landY) { ny = landY; grounded = true; }
    } else if (this.overlaps(x, ny, z, half)) {
      ny = y;
      ceiling = true;
    }
    y = ny;

    out.applied.set(x - sx, y - sy, z - sz);
    out.grounded = grounded;
    out.groundNormal.set(0, 1, 0);
    out.groundSurface = 'concrete';
    out.blocked = blocked;
    out.ceiling = ceiling;
    out.impactSpeed = 0;
    this._p.set(x, y, z);
    return this._p;
  }
}
