/**
 * Mesher — an accumulating triangle builder.
 *
 * Every piece of level geometry in the game is authored through this: level kit
 * pieces and props push primitives into a Mesher under a transform stack, and
 * one `build()` produces a single indexed `BufferGeometry`. Batching at author
 * time is what keeps a 120 m map inside a ~200 draw-call budget — an entire
 * building's brickwork is one mesh, not two hundred boxes.
 *
 * Conventions:
 *  - Y is up, metres.
 *  - UVs are world-scaled by default (`uv = worldCoord / uvScale`) so a shared
 *    material tiles continuously across separately authored pieces. Pass
 *    `uvUnit` when a face must map exactly to [0,1] (labels, posters, glass).
 *  - Normals are transformed by the inverse-transpose of the current matrix, so
 *    non-uniform scaling in the transform stack is still correct.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _m = new THREE.Matrix4();

export interface BoxUv {
  /** Metres per texture repeat. Ignored when `unit` is true. */
  scale?: number;
  /** Map every face to [0,1] instead of world-scaling. */
  unit?: boolean;
  /** Extra UV offset applied after scaling. */
  offset?: [number, number];
}

/** Six-face inclusion mask for `box()`, so interior faces can be skipped. */
export const FACE = {
  PX: 1, NX: 2, PY: 4, NY: 8, PZ: 16, NZ: 32,
  ALL: 63,
  SIDES: 1 | 2 | 16 | 32,
  NO_BOTTOM: 63 & ~8,
} as const;

export class Mesher {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];

  private mat = new THREE.Matrix4();
  private nmat = new THREE.Matrix3();
  private stack: THREE.Matrix4[] = [];

  /* ------------------------------------------------------------ transform */

  /** Multiplies `m` into the current transform and pushes the previous one. */
  push(m: THREE.Matrix4): this {
    this.stack.push(this.mat.clone());
    this.mat.multiply(m);
    this.nmat.setFromMatrix4(this.mat).invert().transpose();
    return this;
  }

  /** Pushes a translation/rotation(YXZ)/scale transform. */
  pushTRS(
    px: number, py: number, pz: number,
    ry = 0, rx = 0, rz = 0,
    sx = 1, sy = 1, sz = 1,
  ): this {
    _m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
    _m.scale(_v.set(sx, sy, sz));
    _m.setPosition(px, py, pz);
    return this.push(_m);
  }

  pop(): this {
    const m = this.stack.pop();
    if (m) {
      this.mat.copy(m);
      this.nmat.setFromMatrix4(this.mat).invert().transpose();
    }
    return this;
  }

  /** Current transform, for callers that need to place something externally. */
  get matrix(): THREE.Matrix4 { return this.mat; }

  get triangleCount(): number { return this.idx.length / 3; }
  get vertexCount(): number { return this.pos.length / 3; }
  get empty(): boolean { return this.idx.length === 0; }

  /* --------------------------------------------------------------- verts */

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    _v.set(x, y, z).applyMatrix4(this.mat);
    _n.set(nx, ny, nz).applyMatrix3(this.nmat);
    const len = Math.hypot(_n.x, _n.y, _n.z) || 1;
    this.pos.push(_v.x, _v.y, _v.z);
    this.nor.push(_n.x / len, _n.y / len, _n.z / len);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quadIdx(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /* ---------------------------------------------------------- primitives */

  /**
   * Axis-aligned box in local space. `faces` is a `FACE` mask — omitting hidden
   * faces (a wall panel's back, a slab's underside) is the cheapest tri saving
   * there is on architecture built from hundreds of boxes.
   */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    uv: BoxUv | number = 1, faces: number = FACE.ALL,
  ): void {
    const o = typeof uv === 'number' ? { scale: uv } : uv;
    const s = o.unit ? 1 : 1 / Math.max(o.scale ?? 1, 1e-4);
    const ou = o.offset ? o.offset[0] : 0;
    const ov = o.offset ? o.offset[1] : 0;
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;

    // Per-face UV basis: world-scaled unless `unit`, in which case the face is
    // normalised to its own extent.
    const uS = (a: number, extent: number) => (o.unit ? (a + extent) / (2 * extent || 1) : a * s + ou);
    const vS = (a: number, extent: number) => (o.unit ? (a + extent) / (2 * extent || 1) : a * s + ov);

    if (faces & FACE.PX) {
      const a = this.vertex(x1, y0, z1, 1, 0, 0, uS(z1 - cz, hz), vS(y0 - cy, hy));
      const b = this.vertex(x1, y0, z0, 1, 0, 0, uS(z0 - cz, hz), vS(y0 - cy, hy));
      const c = this.vertex(x1, y1, z0, 1, 0, 0, uS(z0 - cz, hz), vS(y1 - cy, hy));
      const d = this.vertex(x1, y1, z1, 1, 0, 0, uS(z1 - cz, hz), vS(y1 - cy, hy));
      this.quadIdx(a, b, c, d);
    }
    if (faces & FACE.NX) {
      const a = this.vertex(x0, y0, z0, -1, 0, 0, uS(z0 - cz, hz), vS(y0 - cy, hy));
      const b = this.vertex(x0, y0, z1, -1, 0, 0, uS(z1 - cz, hz), vS(y0 - cy, hy));
      const c = this.vertex(x0, y1, z1, -1, 0, 0, uS(z1 - cz, hz), vS(y1 - cy, hy));
      const d = this.vertex(x0, y1, z0, -1, 0, 0, uS(z0 - cz, hz), vS(y1 - cy, hy));
      this.quadIdx(a, b, c, d);
    }
    if (faces & FACE.PY) {
      const a = this.vertex(x0, y1, z1, 0, 1, 0, uS(x0 - cx, hx), vS(z1 - cz, hz));
      const b = this.vertex(x1, y1, z1, 0, 1, 0, uS(x1 - cx, hx), vS(z1 - cz, hz));
      const c = this.vertex(x1, y1, z0, 0, 1, 0, uS(x1 - cx, hx), vS(z0 - cz, hz));
      const d = this.vertex(x0, y1, z0, 0, 1, 0, uS(x0 - cx, hx), vS(z0 - cz, hz));
      this.quadIdx(a, b, c, d);
    }
    if (faces & FACE.NY) {
      const a = this.vertex(x0, y0, z0, 0, -1, 0, uS(x0 - cx, hx), vS(z0 - cz, hz));
      const b = this.vertex(x1, y0, z0, 0, -1, 0, uS(x1 - cx, hx), vS(z0 - cz, hz));
      const c = this.vertex(x1, y0, z1, 0, -1, 0, uS(x1 - cx, hx), vS(z1 - cz, hz));
      const d = this.vertex(x0, y0, z1, 0, -1, 0, uS(x0 - cx, hx), vS(z1 - cz, hz));
      this.quadIdx(a, b, c, d);
    }
    if (faces & FACE.PZ) {
      const a = this.vertex(x0, y0, z1, 0, 0, 1, uS(x0 - cx, hx), vS(y0 - cy, hy));
      const b = this.vertex(x1, y0, z1, 0, 0, 1, uS(x1 - cx, hx), vS(y0 - cy, hy));
      const c = this.vertex(x1, y1, z1, 0, 0, 1, uS(x1 - cx, hx), vS(y1 - cy, hy));
      const d = this.vertex(x0, y1, z1, 0, 0, 1, uS(x0 - cx, hx), vS(y1 - cy, hy));
      this.quadIdx(a, b, c, d);
    }
    if (faces & FACE.NZ) {
      const a = this.vertex(x1, y0, z0, 0, 0, -1, uS(x1 - cx, hx), vS(y0 - cy, hy));
      const b = this.vertex(x0, y0, z0, 0, 0, -1, uS(x0 - cx, hx), vS(y0 - cy, hy));
      const c = this.vertex(x0, y1, z0, 0, 0, -1, uS(x0 - cx, hx), vS(y1 - cy, hy));
      const d = this.vertex(x1, y1, z0, 0, 0, -1, uS(x1 - cx, hx), vS(y1 - cy, hy));
      this.quadIdx(a, b, c, d);
    }
  }

  /** Convenience: a box from two opposite corners. */
  boxMinMax(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    uv: BoxUv | number = 1, faces: number = FACE.ALL,
  ): void {
    this.box(
      (x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5,
      Math.abs(x1 - x0) * 0.5, Math.abs(y1 - y0) * 0.5, Math.abs(z1 - z0) * 0.5,
      uv, faces,
    );
  }

  /**
   * Box with chamfered edges. Real edges catch a highlight; a 1–2 cm chamfer on
   * hero props is the single cheapest way to stop geometry reading as untextured
   * CG boxes. 44 triangles versus 12, so use it on props, never on walls.
   */
  chamferBox(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    bevel = 0.02, uvScale = 1,
  ): void {
    const b = Math.min(bevel, hx * 0.49, hy * 0.49, hz * 0.49);
    const s = 1 / Math.max(uvScale, 1e-4);
    const ix = hx - b, iy = hy - b, iz = hz - b;

    // 8 corner positions expanded into 3 vertices each (one per adjacent face
    // direction), i.e. the classic bevelled-cube vertex ring.
    const P: number[][] = [];
    const N: number[][] = [];
    const sx = [-1, 1], sy = [-1, 1], sz = [-1, 1];
    const idxOf = (i: number, j: number, k: number, axis: number) => ((i * 2 + j) * 2 + k) * 3 + axis;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          const X = sx[i], Y = sy[j], Z = sz[k];
          // axis 0: pushed out along X; axis 1: along Y; axis 2: along Z
          P[idxOf(i, j, k, 0)] = [cx + X * hx, cy + Y * iy, cz + Z * iz];
          P[idxOf(i, j, k, 1)] = [cx + X * ix, cy + Y * hy, cz + Z * iz];
          P[idxOf(i, j, k, 2)] = [cx + X * ix, cy + Y * iy, cz + Z * hz];
          N[idxOf(i, j, k, 0)] = [X, 0, 0];
          N[idxOf(i, j, k, 1)] = [0, Y, 0];
          N[idxOf(i, j, k, 2)] = [0, 0, Z];
        }
      }
    }

    const emit = (list: number[]) => {
      const ids: number[] = [];
      for (const id of list) {
        const p = P[id], n = N[id];
        // Planar UV on the dominant axis of the vertex normal.
        let u: number, v: number;
        if (Math.abs(n[0]) > 0.5) { u = p[2] * s; v = p[1] * s; }
        else if (Math.abs(n[1]) > 0.5) { u = p[0] * s; v = p[2] * s; }
        else { u = p[0] * s; v = p[1] * s; }
        ids.push(this.vertex(p[0], p[1], p[2], n[0], n[1], n[2], u, v));
      }
      return ids;
    };

    // 6 inset faces
    const face = (a: number, b2: number, c: number, d: number) => {
      const ids = emit([a, b2, c, d]);
      this.quadIdx(ids[0], ids[1], ids[2], ids[3]);
    };
    face(idxOf(1, 0, 1, 0), idxOf(1, 0, 0, 0), idxOf(1, 1, 0, 0), idxOf(1, 1, 1, 0)); // +X
    face(idxOf(0, 0, 0, 0), idxOf(0, 0, 1, 0), idxOf(0, 1, 1, 0), idxOf(0, 1, 0, 0)); // -X
    face(idxOf(0, 1, 1, 1), idxOf(1, 1, 1, 1), idxOf(1, 1, 0, 1), idxOf(0, 1, 0, 1)); // +Y
    face(idxOf(0, 0, 0, 1), idxOf(1, 0, 0, 1), idxOf(1, 0, 1, 1), idxOf(0, 0, 1, 1)); // -Y
    face(idxOf(0, 0, 1, 2), idxOf(1, 0, 1, 2), idxOf(1, 1, 1, 2), idxOf(0, 1, 1, 2)); // +Z
    face(idxOf(1, 0, 0, 2), idxOf(0, 0, 0, 2), idxOf(0, 1, 0, 2), idxOf(1, 1, 0, 2)); // -Z

    // 12 edge strips, each joining two of the pushed-out vertex variants.
    const strip = (a: number, b2: number, c: number, d: number) => {
      const ids = emit([a, b2, c, d]);
      this.quadIdx(ids[0], ids[1], ids[2], ids[3]);
    };
    // edges along Z (vary k): between X-face and Y-face
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const flip = (sx[i] * sy[j]) > 0;
        const a = idxOf(i, j, 0, 0), b2 = idxOf(i, j, 1, 0);
        const c = idxOf(i, j, 1, 1), d = idxOf(i, j, 0, 1);
        if (flip) strip(a, b2, c, d); else strip(d, c, b2, a);
      }
    }
    // edges along Y (vary j): between X-face and Z-face
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 2; k++) {
        const flip = (sx[i] * sz[k]) < 0;
        const a = idxOf(i, 0, k, 0), b2 = idxOf(i, 1, k, 0);
        const c = idxOf(i, 1, k, 2), d = idxOf(i, 0, k, 2);
        if (flip) strip(a, b2, c, d); else strip(d, c, b2, a);
      }
    }
    // edges along X (vary i): between Y-face and Z-face
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 2; k++) {
        const flip = (sy[j] * sz[k]) > 0;
        const a = idxOf(0, j, k, 1), b2 = idxOf(1, j, k, 1);
        const c = idxOf(1, j, k, 2), d = idxOf(0, j, k, 2);
        if (flip) strip(a, b2, c, d); else strip(d, c, b2, a);
      }
    }

    // 8 corner triangles.
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          const ids = emit([idxOf(i, j, k, 0), idxOf(i, j, k, 1), idxOf(i, j, k, 2)]);
          const flip = (sx[i] * sy[j] * sz[k]) > 0;
          if (flip) this.tri(ids[0], ids[1], ids[2]);
          else this.tri(ids[2], ids[1], ids[0]);
        }
      }
    }
  }

  /** Free quad from four corners (counter-clockwise seen from the front). */
  quad(
    p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
    uvScale = 1, doubleSided = false,
  ): void {
    _e1.subVectors(p1, p0);
    _e2.subVectors(p3, p0);
    _n.crossVectors(_e1, _e2).normalize();
    const s = 1 / Math.max(uvScale, 1e-4);
    const w = _e1.length() * s;
    const h = _e2.length() * s;
    const a = this.vertex(p0.x, p0.y, p0.z, _n.x, _n.y, _n.z, 0, 0);
    const b = this.vertex(p1.x, p1.y, p1.z, _n.x, _n.y, _n.z, w, 0);
    const c = this.vertex(p2.x, p2.y, p2.z, _n.x, _n.y, _n.z, w, h);
    const d = this.vertex(p3.x, p3.y, p3.z, _n.x, _n.y, _n.z, 0, h);
    this.quadIdx(a, b, c, d);
    if (doubleSided) {
      const a2 = this.vertex(p0.x, p0.y, p0.z, -_n.x, -_n.y, -_n.z, 0, 0);
      const b2 = this.vertex(p1.x, p1.y, p1.z, -_n.x, -_n.y, -_n.z, w, 0);
      const c2 = this.vertex(p2.x, p2.y, p2.z, -_n.x, -_n.y, -_n.z, w, h);
      const d2 = this.vertex(p3.x, p3.y, p3.z, -_n.x, -_n.y, -_n.z, 0, h);
      this.quadIdx(d2, c2, b2, a2);
    }
  }

  /** Upright card in the XY plane, centred on X, sitting on y=0. Used for foliage. */
  card(width: number, height: number, uvScale = 0, doubleSided = true): void {
    const hw = width * 0.5;
    const s = uvScale > 0 ? 1 / uvScale : 0;
    const u1 = s > 0 ? width * s : 1;
    const v1 = s > 0 ? height * s : 1;
    const a = this.vertex(-hw, 0, 0, 0, 0, 1, 0, 0);
    const b = this.vertex(hw, 0, 0, 0, 0, 1, u1, 0);
    const c = this.vertex(hw, height, 0, 0, 0, 1, u1, v1);
    const d = this.vertex(-hw, height, 0, 0, 0, 1, 0, v1);
    this.quadIdx(a, b, c, d);
    if (doubleSided) {
      const a2 = this.vertex(-hw, 0, 0, 0, 0, -1, 0, 0);
      const b2 = this.vertex(hw, 0, 0, 0, 0, -1, u1, 0);
      const c2 = this.vertex(hw, height, 0, 0, 0, -1, u1, v1);
      const d2 = this.vertex(-hw, height, 0, 0, 0, -1, 0, v1);
      this.quadIdx(d2, c2, b2, a2);
    }
  }

  /**
   * Cylinder along +Y, centred on the origin. `radiusTop < radiusBottom` gives a
   * cone/taper. Optional `arc` (radians) makes a partial shell.
   */
  cylinder(
    radiusBottom: number, radiusTop: number, height: number, segments = 12,
    capTop = true, capBottom = true, uvScale = 1, arc = Math.PI * 2, arcStart = 0,
  ): void {
    const hh = height * 0.5;
    const s = 1 / Math.max(uvScale, 1e-4);
    const closed = Math.abs(arc - Math.PI * 2) < 1e-4;
    const count = closed ? segments : segments + 1;
    const slope = (radiusBottom - radiusTop) / Math.max(height, 1e-5);

    const ring0: number[] = [];
    const ring1: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = arcStart + (i / segments) * arc;
      const cos = Math.cos(t), sin = Math.sin(t);
      const nx = cos, nz = sin;
      const ny = slope;
      const u = (t * (radiusBottom + radiusTop) * 0.5) * s;
      ring0.push(this.vertex(cos * radiusBottom, -hh, sin * radiusBottom, nx, ny, nz, u, -hh * s));
      ring1.push(this.vertex(cos * radiusTop, hh, sin * radiusTop, nx, ny, nz, u, hh * s));
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % count;
      if (!closed && i + 1 >= count) break;
      this.quadIdx(ring0[i], ring0[j], ring1[j], ring1[i]);
    }

    if (capTop && radiusTop > 1e-5) {
      const centre = this.vertex(0, hh, 0, 0, 1, 0, 0, 0);
      const ring: number[] = [];
      for (let i = 0; i < count; i++) {
        const t = arcStart + (i / segments) * arc;
        const cos = Math.cos(t), sin = Math.sin(t);
        ring.push(this.vertex(cos * radiusTop, hh, sin * radiusTop, 0, 1, 0, cos * radiusTop * s, sin * radiusTop * s));
      }
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % count;
        if (!closed && i + 1 >= count) break;
        this.tri(centre, ring[i], ring[j]);
      }
    }
    if (capBottom && radiusBottom > 1e-5) {
      const centre = this.vertex(0, -hh, 0, 0, -1, 0, 0, 0);
      const ring: number[] = [];
      for (let i = 0; i < count; i++) {
        const t = arcStart + (i / segments) * arc;
        const cos = Math.cos(t), sin = Math.sin(t);
        ring.push(this.vertex(cos * radiusBottom, -hh, sin * radiusBottom, 0, -1, 0, cos * radiusBottom * s, sin * radiusBottom * s));
      }
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % count;
        if (!closed && i + 1 >= count) break;
        this.tri(centre, ring[j], ring[i]);
      }
    }
  }

  /** UV sphere centred on the origin. */
  sphere(radius: number, wSeg = 12, hSeg = 8, uvScale = 1): void {
    const s = 1 / Math.max(uvScale, 1e-4);
    const grid: number[][] = [];
    for (let y = 0; y <= hSeg; y++) {
      const row: number[] = [];
      const phi = (y / hSeg) * Math.PI;
      for (let x = 0; x <= wSeg; x++) {
        const theta = (x / wSeg) * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(theta);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(theta);
        row.push(this.vertex(
          nx * radius, ny * radius, nz * radius, nx, ny, nz,
          (x / wSeg) * radius * 6 * s, (y / hSeg) * radius * 3 * s,
        ));
      }
      grid.push(row);
    }
    for (let y = 0; y < hSeg; y++) {
      for (let x = 0; x < wSeg; x++) {
        const a = grid[y][x], b = grid[y][x + 1], c = grid[y + 1][x + 1], d = grid[y + 1][x];
        if (y !== 0) this.tri(a, b, d);
        if (y !== hSeg - 1) this.tri(b, c, d);
      }
    }
  }

  /**
   * Irregular convex-ish lump — the workhorse for rubble, bricks and debris.
   * Deterministic: `jitter(i)` must be a pure function of the vertex index.
   */
  lump(radius: number, wSeg: number, hSeg: number, jitter: (i: number) => number, uvScale = 1): void {
    const s = 1 / Math.max(uvScale, 1e-4);
    const grid: number[][] = [];
    for (let y = 0; y <= hSeg; y++) {
      const row: number[] = [];
      const phi = (y / hSeg) * Math.PI;
      for (let x = 0; x <= wSeg; x++) {
        const theta = (x / wSeg) * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(theta);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(theta);
        // Wrap the seam so the last column reuses the first column's radius.
        const r = radius * jitter(y * wSeg + (x % wSeg));
        row.push(this.vertex(nx * r, ny * r, nz * r, nx, ny, nz, theta * radius * s, phi * radius * s));
      }
      grid.push(row);
    }
    for (let y = 0; y < hSeg; y++) {
      for (let x = 0; x < wSeg; x++) {
        const a = grid[y][x], b = grid[y][x + 1], c = grid[y + 1][x + 1], d = grid[y + 1][x];
        if (y !== 0) this.tri(a, b, d);
        if (y !== hSeg - 1) this.tri(b, c, d);
      }
    }
  }

  /** Torus around the Y axis. */
  torus(radius: number, tube: number, radialSeg = 12, tubularSeg = 8, uvScale = 1, arc = Math.PI * 2): void {
    const s = 1 / Math.max(uvScale, 1e-4);
    const grid: number[][] = [];
    for (let j = 0; j <= radialSeg; j++) {
      const row: number[] = [];
      const u = (j / radialSeg) * arc;
      for (let i = 0; i <= tubularSeg; i++) {
        const v = (i / tubularSeg) * Math.PI * 2;
        const cx = Math.cos(u) * radius;
        const cz = Math.sin(u) * radius;
        const nx = Math.cos(u) * Math.cos(v);
        const ny = Math.sin(v);
        const nz = Math.sin(u) * Math.cos(v);
        row.push(this.vertex(cx + nx * tube, ny * tube, cz + nz * tube, nx, ny, nz, u * radius * s, v * tube * s));
      }
      grid.push(row);
    }
    for (let j = 0; j < radialSeg; j++) {
      for (let i = 0; i < tubularSeg; i++) {
        this.quadIdx(grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]);
      }
    }
  }

  /**
   * Swept tube along a polyline — cables, pipes, railings, razor wire. Uses a
   * stable parallel-transport frame so the tube does not spin at bends.
   */
  tube(points: THREE.Vector3[], radius: number, segments = 6, capped = false, uvScale = 1): void {
    if (points.length < 2) return;
    const s = 1 / Math.max(uvScale, 1e-4);
    const tangent = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const binormal = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const rings: number[][] = [];
    const ringPts: THREE.Vector3[][] = [];
    let travelled = 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) tangent.subVectors(points[1], points[0]);
      else if (i === points.length - 1) tangent.subVectors(points[i], points[i - 1]);
      else tangent.subVectors(points[i + 1], points[i - 1]);
      if (tangent.lengthSq() < 1e-12) tangent.set(0, 0, 1);
      tangent.normalize();

      if (i === 0) {
        normal.copy(Math.abs(tangent.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up)
          .cross(tangent).normalize();
        if (normal.lengthSq() < 1e-8) normal.set(1, 0, 0);
      } else {
        // Parallel transport: project the previous normal onto the new plane.
        normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
        travelled += p.distanceTo(points[i - 1]);
      }
      binormal.crossVectors(tangent, normal).normalize();

      const ring: number[] = [];
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        const cos = Math.cos(a), sin = Math.sin(a);
        const nx = normal.x * cos + binormal.x * sin;
        const ny = normal.y * cos + binormal.y * sin;
        const nz = normal.z * cos + binormal.z * sin;
        pts.push(new THREE.Vector3(p.x + nx * radius, p.y + ny * radius, p.z + nz * radius));
        ring.push(this.vertex(
          p.x + nx * radius, p.y + ny * radius, p.z + nz * radius,
          nx, ny, nz, travelled * s, (k / segments) * radius * 6 * s,
        ));
      }
      rings.push(ring);
      ringPts.push(pts);
    }

    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < segments; k++) {
        const k2 = (k + 1) % segments;
        this.quadIdx(rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]);
      }
    }

    if (capped) {
      const last = rings.length - 1;
      const capEnd = (ringIndex: number, dir: THREE.Vector3, forward: boolean) => {
        const p = points[ringIndex];
        const centre = this.vertex(p.x, p.y, p.z, dir.x, dir.y, dir.z, 0, 0);
        const ring: number[] = [];
        for (let k = 0; k < segments; k++) {
          const q = ringPts[ringIndex][k];
          ring.push(this.vertex(q.x, q.y, q.z, dir.x, dir.y, dir.z, 0, 0));
        }
        for (let k = 0; k < segments; k++) {
          const k2 = (k + 1) % segments;
          if (forward) this.tri(centre, ring[k], ring[k2]);
          else this.tri(centre, ring[k2], ring[k]);
        }
      };
      const dStart = new THREE.Vector3().subVectors(points[0], points[1]).normalize();
      const dEnd = new THREE.Vector3().subVectors(points[last], points[last - 1]).normalize();
      capEnd(0, dStart, false);
      capEnd(last, dEnd, true);
    }
  }

  /**
   * Extrudes a closed 2D polygon (XZ plane, counter-clockwise) between two
   * heights. Used for building footprints, kerbs, planters and pavements.
   */
  extrude(points: THREE.Vector2[], y0: number, y1: number, uvScale = 1, capTop = true, capBottom = false, sides = true): void {
    if (points.length < 3) return;
    const s = 1 / Math.max(uvScale, 1e-4);

    if (sides) {
      let travelled = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const dx = b.x - a.x, dz = b.y - a.y;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const nx = dz / len, nz = -dx / len;
        const u0 = travelled * s, u1 = (travelled + len) * s;
        travelled += len;
        const v0 = this.vertex(a.x, y0, a.y, nx, 0, nz, u0, y0 * s);
        const v1 = this.vertex(b.x, y0, b.y, nx, 0, nz, u1, y0 * s);
        const v2 = this.vertex(b.x, y1, b.y, nx, 0, nz, u1, y1 * s);
        const v3 = this.vertex(a.x, y1, a.y, nx, 0, nz, u0, y1 * s);
        this.quadIdx(v0, v1, v2, v3);
      }
    }

    if (capTop || capBottom) {
      const faces = THREE.ShapeUtils.triangulateShape(points, []);
      if (capTop) {
        const ids = points.map((p) => this.vertex(p.x, y1, p.y, 0, 1, 0, p.x * s, p.y * s));
        for (const f of faces) this.tri(ids[f[0]], ids[f[1]], ids[f[2]]);
      }
      if (capBottom) {
        const ids = points.map((p) => this.vertex(p.x, y0, p.y, 0, -1, 0, p.x * s, p.y * s));
        for (const f of faces) this.tri(ids[f[2]], ids[f[1]], ids[f[0]]);
      }
    }
  }

  /**
   * Subdivided horizontal grid with a height function. Ground, craters, road
   * camber and rubble slopes all come from here.
   */
  grid(
    x0: number, z0: number, x1: number, z1: number, nx: number, nz: number,
    height: (x: number, z: number) => number, uvScale = 1,
  ): void {
    const s = 1 / Math.max(uvScale, 1e-4);
    const rows: number[][] = [];
    const dx = (x1 - x0) / nx;
    const dz = (z1 - z0) / nz;
    const eps = Math.min(dx, dz) * 0.5;
    for (let j = 0; j <= nz; j++) {
      const row: number[] = [];
      const z = z0 + dz * j;
      for (let i = 0; i <= nx; i++) {
        const x = x0 + dx * i;
        const y = height(x, z);
        // Central differences give a smooth normal without a second pass.
        const hL = height(x - eps, z), hR = height(x + eps, z);
        const hD = height(x, z - eps), hU = height(x, z + eps);
        _n.set(hL - hR, 2 * eps, hD - hU).normalize();
        row.push(this.vertex(x, y, z, _n.x, _n.y, _n.z, x * s, z * s));
      }
      rows.push(row);
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        this.quadIdx(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]);
      }
    }
  }

  /* ---------------------------------------------------------------- build */

  /** Appends another mesher's contents (already-transformed) into this one. */
  append(other: Mesher): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < other.pos.length; i++) this.pos.push(other.pos[i]);
    for (let i = 0; i < other.nor.length; i++) this.nor.push(other.nor[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const count = this.pos.length / 3;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    const index = count > 65535
      ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(this.idx), 1);
    geo.setIndex(index);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  clear(): void {
    this.pos.length = 0;
    this.nor.length = 0;
    this.uv.length = 0;
    this.idx.length = 0;
    this.stack.length = 0;
    this.mat.identity();
    this.nmat.identity();
  }
}

/* --------------------------------------------------------------- helpers -- */

export const V2 = (x: number, y: number): THREE.Vector2 => new THREE.Vector2(x, y);
export const V3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Rectangle footprint as a counter-clockwise XZ polygon. */
export function rectPoly(x0: number, z0: number, x1: number, z1: number): THREE.Vector2[] {
  return [V2(x0, z0), V2(x1, z0), V2(x1, z1), V2(x0, z1)];
}

/** Catenary sag between two points — cables, laundry lines, fallen wires. */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, segments = 10): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= sag * Math.sin(Math.PI * t) * (1 - 0.25 * Math.cos(Math.PI * t));
    out.push(p);
  }
  return out;
}
