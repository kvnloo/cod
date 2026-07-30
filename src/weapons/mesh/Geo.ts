/**
 * Procedural geometry kit for weapon models.
 *
 * Everything a gun is made of, expressed as `BufferGeometry` factories in the
 * weapon-local frame (−Z down the bore, +Y up, +X to the shooter's right).
 *
 * Two decisions here do most of the work for the final look:
 *
 *  - **Chamfers, not sharp boxes.** Real machined parts have a 0.3–1 mm break
 *    on every edge, and that break is what catches the key light and reads as
 *    metal. `chamferBox` is the workhorse for that reason; nothing in a weapon
 *    model should be a raw `BoxGeometry`.
 *  - **Per-triangle triplanar UVs, generated after merging.** No part needs
 *    authored UVs, and texel density is identical everywhere on the weapon
 *    regardless of how big the part is, which is what stops procedural
 *    surfaces looking like stickers.
 */

import * as THREE from 'three';

export type Pt2 = [number, number];
/** Profile point for a lathe: `[z, radius]`. */
export type ProfilePt = [number, number];

/* ------------------------------------------------------------------ merge */

/**
 * Concatenates geometries into one non-indexed position+normal buffer.
 * Non-indexed is deliberate: it lets UVs be assigned per triangle, and weapon
 * meshes are small enough that the vertex duplication is irrelevant.
 */
export function merge(geos: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  const flat: THREE.BufferGeometry[] = [];
  for (const g of geos) {
    const f = g.index ? g.toNonIndexed() : g;
    flat.push(f);
    total += f.getAttribute('position').count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let o = 0;
  for (const f of flat) {
    const p = f.getAttribute('position') as THREE.BufferAttribute;
    let n = f.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!n) { f.computeVertexNormals(); n = f.getAttribute('normal') as THREE.BufferAttribute; }
    position.set(p.array as Float32Array, o * 3);
    normal.set(n.array as Float32Array, o * 3);
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return out;
}

/**
 * Assigns triplanar UVs per triangle from the face normal, at `metresPerRepeat`
 * world scale. Called once on the final merged geometry.
 */
export function projectUV(geo: THREE.BufferGeometry, metresPerRepeat: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const s = 1 / Math.max(1e-5, metresPerRepeat);
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let t = 0; t < count; t += 3) {
    ax.fromBufferAttribute(pos, t);
    bx.fromBufferAttribute(pos, t + 1);
    cx.fromBufferAttribute(pos, t + 2);
    bx.sub(ax); cx.sub(ax);
    n.crossVectors(bx, cx);
    const nx = Math.abs(n.x), ny = Math.abs(n.y), nz = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      let u: number, v: number;
      if (nx >= ny && nx >= nz) { u = pz; v = py; }
      else if (ny >= nz) { u = px; v = pz; }
      else { u = px; v = py; }
      uv[i * 2] = u * s;
      uv[i * 2 + 1] = v * s;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* ------------------------------------------------------------------- wear */

/**
 * Bakes a per-vertex `aWear` attribute: `x` = convex edge exposure, `y` =
 * concave cavity occlusion.
 *
 * This is the single biggest difference between a procedural weapon and a
 * sculpted one. A tiling surface texture can only invent *statistical* wear —
 * scratches and blotches that land wherever the noise happens to put them. On
 * a real weapon the finish is rubbed through on the **chamfers, corners and
 * proud edges** of the actual model, and grime collects in the **inside
 * corners** of the actual model. Both are properties of the mesh, not of a
 * texture, so they have to be measured off the mesh.
 *
 * Method, in one pass over the triangle soup:
 *   1. Weld by quantised position so the (flat-shaded, duplicated) vertices of
 *      every face meeting at a corner are recognised as one point.
 *   2. At each welded point, the mean of the incident face normals gives the
 *      local surface direction, and the maximum angle away from that mean
 *      gives how *sharp* the point is — 0 on a flat face, high on an edge.
 *   3. The sign comes from comparing the point against the centroid of its
 *      graph neighbours: a point that sits on the outside of its neighbourhood
 *      is a convex edge, one that sits inside is a crevice.
 *
 * Cost is a few milliseconds for a whole armoury and it happens once, at build.
 */
export interface WearZone {
  /** Centre, in the same space as the geometry handed to `bakeWear`. */
  x: number; y: number; z: number;
  /** Radius of influence, metres. */
  r: number;
  /** Multiplier on the convex-edge mask inside the zone. */
  edge: number;
  /** Multiplier on the concave-cavity mask inside the zone. */
  cavity: number;
}

export interface WearTuning {
  /** Whole-part multipliers — a charging handle is handled, a stock is not. */
  edgeGain?: number;
  cavityGain?: number;
  /** Localised hot spots: the magwell lip, the ejection port, the hand rests. */
  zones?: readonly WearZone[];
  /**
   * How strongly upward-facing surfaces collect dust. Gravity is the single
   * biggest organising principle in how a real object gets dirty, and it is
   * free here: the face normal is already in hand.
   */
  gravity?: number;
}

export function bakeWear(geo: THREE.BufferGeometry, tune: WearTuning = {}): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const count = pos?.count ?? 0;
  const wear = new Float32Array(count * 2);
  if (!pos || !nrm || count === 0) {
    geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 2));
    return geo;
  }

  // 0.05 mm buckets: finer than any feature on a weapon, coarse enough that
  // two faces authored to meet actually land in the same bucket.
  const Q = 20000;
  const uid = new Int32Array(count);
  const keys = new Map<number, number>();
  let unique = 0;
  for (let i = 0; i < count; i++) {
    const kx = Math.round(pos.getX(i) * Q);
    const ky = Math.round(pos.getY(i) * Q);
    const kz = Math.round(pos.getZ(i) * Q);
    // Cantor-ish mix into a single number; collisions merely blur the result.
    const key = (kx * 73856093) ^ (ky * 19349663) ^ (kz * 83492791);
    let u = keys.get(key);
    if (u === undefined) { u = unique++; keys.set(key, u); }
    uid[i] = u;
  }

  const nAvg = new Float32Array(unique * 3);
  const pAvg = new Float32Array(unique * 3);
  const nbSum = new Float32Array(unique * 3);
  const nbCount = new Float32Array(unique);
  const hits = new Float32Array(unique);

  for (let i = 0; i < count; i++) {
    const u = uid[i];
    nAvg[u * 3] += nrm.getX(i);
    nAvg[u * 3 + 1] += nrm.getY(i);
    nAvg[u * 3 + 2] += nrm.getZ(i);
    pAvg[u * 3] = pos.getX(i);
    pAvg[u * 3 + 1] = pos.getY(i);
    pAvg[u * 3 + 2] = pos.getZ(i);
    hits[u] += 1;
  }
  for (let u = 0; u < unique; u++) {
    const x = nAvg[u * 3], y = nAvg[u * 3 + 1], z = nAvg[u * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    nAvg[u * 3] = x / l; nAvg[u * 3 + 1] = y / l; nAvg[u * 3 + 2] = z / l;
  }

  // Graph neighbours from the triangle soup.
  for (let t = 0; t + 2 < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const u = uid[t + k];
      for (let j = 1; j <= 2; j++) {
        const o = t + ((k + j) % 3);
        nbSum[u * 3] += pos.getX(o);
        nbSum[u * 3 + 1] += pos.getY(o);
        nbSum[u * 3 + 2] += pos.getZ(o);
        nbCount[u] += 1;
      }
    }
  }

  // Sharpness: how far the sharpest incident face turns away from the mean.
  const sharp = new Float32Array(unique);
  for (let i = 0; i < count; i++) {
    const u = uid[i];
    const d = nrm.getX(i) * nAvg[u * 3] + nrm.getY(i) * nAvg[u * 3 + 1] + nrm.getZ(i) * nAvg[u * 3 + 2];
    const s = 1 - d;
    if (s > sharp[u]) sharp[u] = s;
  }

  // Per welded point: how sharp, and which way it bends.
  const strength = new Float32Array(unique);
  const convex = new Uint8Array(unique);
  for (let u = 0; u < unique; u++) {
    if (hits[u] < 2 || nbCount[u] < 1) continue;
    const inv = 1 / nbCount[u];
    const dx = pAvg[u * 3] - nbSum[u * 3] * inv;
    const dy = pAvg[u * 3 + 1] - nbSum[u * 3 + 1] * inv;
    const dz = pAvg[u * 3 + 2] - nbSum[u * 3 + 2] * inv;
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-7) continue;
    const sign = (dx * nAvg[u * 3] + dy * nAvg[u * 3 + 1] + dz * nAvg[u * 3 + 2]) / dl;
    // 1 - cos(theta): a 90° corner reaches 1.0, a 22° chamfer break ~0.08.
    // Chamfers are the interesting case, so the ramp starts low.
    const s = Math.min(1, sharp[u] / 0.34);
    if (sign > 0.10) { strength[u] = s * Math.min(1, sign * 1.8); convex[u] = 1; }
    else if (sign < -0.10) { strength[u] = s * Math.min(1, -sign * 1.8); convex[u] = 0; }
  }

  // The per-*vertex* half. A welded corner is shared by the big faces and by
  // the chamfer strip between them; if both got the same value, all four
  // corners of a face would be lit and the whole face would interpolate to a
  // uniform wash — wear everywhere, which reads as no wear at all.
  //
  // The discriminator is alignment: a chamfer's own normal sits almost exactly
  // on the welded mean, while the flanking faces sit ~22° off it. Weighting by
  // that alignment puts the wear on the chamfer strip and leaves the flats
  // clean, which is precisely where a real finish rubs through.
  const edgeGain = tune.edgeGain ?? 1;
  const cavityGain = tune.cavityGain ?? 1;
  const zones = tune.zones ?? [];
  const gravity = tune.gravity ?? 0;

  for (let i = 0; i < count; i++) {
    const u = uid[i];
    const s = strength[u];
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);

    // Local multipliers: whole-part, plus any hot spot this vertex falls in.
    let eg = edgeGain;
    let cg = cavityGain;
    for (const z of zones) {
      const dx = px - z.x, dy = py - z.y, dz = pz - z.z;
      const q = 1 - Math.min(1, Math.hypot(dx, dy, dz) / Math.max(1e-4, z.r));
      if (q <= 0) continue;
      const k = q * q * (3 - 2 * q);
      eg += (z.edge - 1) * k;
      cg += (z.cavity - 1) * k;
    }

    // Gravity: dust and grit settle on whatever faces up. It is applied to the
    // cavity channel because that is the one wired to "darker and rougher",
    // which is exactly what a film of dust does.
    let grav = 0;
    if (gravity > 0) {
      const up = nrm.getY(i);
      grav = gravity * Math.max(0, up) ** 1.6;
    }

    if (s <= 0) {
      wear[i * 2] = 0;
      wear[i * 2 + 1] = Math.min(1, grav);
      continue;
    }
    const d = nrm.getX(i) * nAvg[u * 3] + nrm.getY(i) * nAvg[u * 3 + 1] + nrm.getZ(i) * nAvg[u * 3 + 2];
    const t = (d - 0.62) / 0.36;
    const align = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    const v = s * align;
    wear[i * 2] = convex[u] ? Math.min(1.4, v * eg) : 0;
    wear[i * 2 + 1] = Math.min(1.2, (convex[u] ? 0 : v * cg) + grav);
  }
  geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 2));
  return geo;
}

/* ------------------------------------------------------------- transforms */

export interface Xform {
  pos?: [number, number, number];
  /** Euler XYZ in radians. */
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
}

const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Applies a transform in place and returns the geometry. */
export function xf(geo: THREE.BufferGeometry, t: Xform): THREE.BufferGeometry {
  const p = t.pos ?? [0, 0, 0];
  const r = t.rot ?? [0, 0, 0];
  const sc = t.scale ?? 1;
  _v.set(p[0], p[1], p[2]);
  _e.set(r[0], r[1], r[2], 'XYZ');
  _q.setFromEuler(_e);
  if (typeof sc === 'number') _s.set(sc, sc, sc); else _s.set(sc[0], sc[1], sc[2]);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

/** Mirrors a geometry across X, fixing the winding so normals stay outward. */
export function mirrorX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const pa = p.array as Float32Array;
  const na = n.array as Float32Array;
  for (let i = 0; i < pa.length; i += 3) { pa[i] = -pa[i]; na[i] = -na[i]; }
  // Reverse winding per triangle.
  for (let t = 0; t < p.count; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = (t + 1) * 3 + c, b = (t + 2) * 3 + c;
      let tmp = pa[a]; pa[a] = pa[b]; pa[b] = tmp;
      tmp = na[a]; na[a] = na[b]; na[b] = tmp;
    }
  }
  p.needsUpdate = true; n.needsUpdate = true;
  return g;
}

/* --------------------------------------------------------- raw triangles */

/** Accumulates flat-shaded triangles with automatic outward winding. */
export class TriBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  /** Point used to decide which way "outward" is. */
  centre = new THREE.Vector3();

  private static a = new THREE.Vector3();
  private static b = new THREE.Vector3();
  private static c = new THREE.Vector3();
  private static ab = new THREE.Vector3();
  private static ac = new THREE.Vector3();
  private static n = new THREE.Vector3();
  private static mid = new THREE.Vector3();

  tri(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ): void {
    const A = TriBuilder.a.set(a[0], a[1], a[2]);
    const B = TriBuilder.b.set(b[0], b[1], b[2]);
    const C = TriBuilder.c.set(c[0], c[1], c[2]);
    const n = TriBuilder.n
      .crossVectors(TriBuilder.ab.subVectors(B, A), TriBuilder.ac.subVectors(C, A));
    if (n.lengthSq() < 1e-16) return;
    n.normalize();
    TriBuilder.mid.copy(A).add(B).add(C).multiplyScalar(1 / 3).sub(this.centre);
    const flip = n.dot(TriBuilder.mid) < 0;
    if (flip) n.negate();
    const order = flip ? [a, c, b] : [a, b, c];
    for (const p of order) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n.x, n.y, n.z);
    }
  }

  quad(
    a: readonly [number, number, number], b: readonly [number, number, number],
    c: readonly [number, number, number], d: readonly [number, number, number],
  ): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    return g;
  }
}

/* ------------------------------------------------------------- primitives */

/**
 * A box with every edge broken by a 45° chamfer of size `c`. 44 triangles.
 * This is the fundamental building block of every receiver, rail and plate.
 */
export function chamferBox(w: number, h: number, d: number, c = 0.0018): THREE.BufferGeometry {
  const W = w / 2, H = h / 2, D = d / 2;
  const k = Math.max(1e-5, Math.min(c, W * 0.48, H * 0.48, D * 0.48));
  const tb = new TriBuilder();

  const A = (sx: number, sy: number, sz: number): [number, number, number] =>
    [sx * W, sy * (H - k), sz * (D - k)];
  const B = (sx: number, sy: number, sz: number): [number, number, number] =>
    [sx * (W - k), sy * H, sz * (D - k)];
  const C = (sx: number, sy: number, sz: number): [number, number, number] =>
    [sx * (W - k), sy * (H - k), sz * D];

  for (const s of [-1, 1]) {
    tb.quad(A(s, -1, -1), A(s, 1, -1), A(s, 1, 1), A(s, -1, 1));
    tb.quad(B(-1, s, -1), B(1, s, -1), B(1, s, 1), B(-1, s, 1));
    tb.quad(C(-1, -1, s), C(1, -1, s), C(1, 1, s), C(-1, 1, s));
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) tb.quad(A(sx, sy, -1), A(sx, sy, 1), B(sx, sy, 1), B(sx, sy, -1));
    for (const sz of [-1, 1]) tb.quad(C(sx, -1, sz), C(sx, 1, sz), A(sx, 1, sz), A(sx, -1, sz));
  }
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) tb.quad(B(-1, sy, sz), B(1, sy, sz), C(1, sy, sz), C(-1, sy, sz));
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) tb.tri(A(sx, sy, sz), B(sx, sy, sz), C(sx, sy, sz));
    }
  }
  return tb.build();
}

/** Cylinder along Z. `rNeg` is the radius at −len/2, `rPos` at +len/2. */
export function cylZ(rNeg: number, rPos: number, len: number, seg = 24, capped = true): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rPos, rNeg, len, seg, 1, !capped);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Simple round bar along Z, centred on the origin. */
export function rod(r: number, len: number, seg = 20, capped = true): THREE.BufferGeometry {
  return cylZ(r, r, len, seg, capped);
}

/**
 * Hollow tube along Z. Built as one closed revolved profile, so the outer wall
 * faces out, the bore faces in and both end faces are real annuli — a bore you
 * can look down without seeing through the barrel.
 */
export function pipeZ(rOuter: number, rInner: number, len: number, seg = 28): THREE.BufferGeometry {
  const h = len / 2;
  return lathe([
    [-h, rOuter], [h, rOuter], [h, rInner], [-h, rInner], [-h, rOuter],
  ], seg, 0.2);
}

/**
 * Revolves a `[z, radius]` profile around Z. Adjacent segments are smoothed
 * when the crease angle is below `smoothAngle`, so a barrel is smooth but the
 * step at a shoulder stays sharp.
 */
export function lathe(profile: readonly ProfilePt[], seg = 24, smoothAngle = 0.62): THREE.BufferGeometry {
  const n = profile.length;
  if (n < 2) return new THREE.BufferGeometry();

  // Per-segment normals in the (r, z) half plane.
  const segN: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) {
    const dz = profile[i + 1][0] - profile[i][0];
    const dr = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dz, dr) || 1;
    segN.push([dz / l, -dr / l]);      // (radial, axial)
  }

  // Per-point, per-side normals with automatic creasing.
  const nStart: Array<[number, number]> = [];
  const nEnd: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) {
    let a: [number, number] = segN[i];
    let b: [number, number] = segN[i];
    const prev = i > 0 ? segN[i - 1] : null;
    const next = i < n - 2 ? segN[i + 1] : null;
    if (prev && prev[0] * segN[i][0] + prev[1] * segN[i][1] > Math.cos(smoothAngle)) {
      const rx = prev[0] + segN[i][0], ry = prev[1] + segN[i][1];
      const l = Math.hypot(rx, ry) || 1;
      a = [rx / l, ry / l];
    }
    if (next && next[0] * segN[i][0] + next[1] * segN[i][1] > Math.cos(smoothAngle)) {
      const rx = next[0] + segN[i][0], ry = next[1] + segN[i][1];
      const l = Math.hypot(rx, ry) || 1;
      b = [rx / l, ry / l];
    }
    nStart.push(a);
    nEnd.push(b);
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  const push = (z: number, r: number, ang: number, nr: [number, number]): void => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    pos.push(r * ca, r * sa, z);
    nrm.push(nr[0] * ca, nr[0] * sa, nr[1]);
  };

  for (let i = 0; i < n - 1; i++) {
    const [z0, r0] = profile[i];
    const [z1, r1] = profile[i + 1];
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2;
      const a1 = ((s + 1) / seg) * Math.PI * 2;
      // Wound so the geometric normal agrees with the analytic one above; a
      // profile that runs backwards in z therefore produces inward-facing
      // walls, which is exactly how `pipeZ` closes a bore.
      push(z0, r0, a0, nStart[i]); push(z1, r1, a1, nEnd[i]); push(z1, r1, a0, nEnd[i]);
      push(z0, r0, a0, nStart[i]); push(z0, r0, a1, nStart[i]); push(z1, r1, a1, nEnd[i]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Flat disc facing ±Z, used to cap lathes and close bores. */
export function disc(r: number, z: number, facing: 1 | -1, seg = 24, rInner = 0): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(rInner, r, seg, 1);
  if (facing < 0) g.rotateY(Math.PI);
  g.translate(0, 0, z);
  return g;
}

/**
 * Extrudes a convex XY polygon along Z. Winding is normalised, so the polygon
 * may be given either way round.
 */
export function prismZ(points: readonly Pt2[], depth: number): THREE.BufferGeometry {
  const n = points.length;
  if (n < 3) return new THREE.BufferGeometry();
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const p = area < 0 ? [...points].reverse() : [...points];
  const hz = depth / 2;
  const tb = new TriBuilder();
  let cx = 0, cy = 0;
  for (const q of p) { cx += q[0]; cy += q[1]; }
  tb.centre.set(cx / n, cy / n, 0);

  for (let i = 1; i < n - 1; i++) {
    tb.tri([p[0][0], p[0][1], hz], [p[i][0], p[i][1], hz], [p[i + 1][0], p[i + 1][1], hz]);
    tb.tri([p[0][0], p[0][1], -hz], [p[i][0], p[i][1], -hz], [p[i + 1][0], p[i + 1][1], -hz]);
  }
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    tb.quad([a[0], a[1], -hz], [b[0], b[1], -hz], [b[0], b[1], hz], [a[0], a[1], hz]);
  }
  return tb.build();
}

/** Extrudes a convex polygon given in the (z, y) plane along X. */
export function prismX(pts: readonly Pt2[], width: number): THREE.BufferGeometry {
  const p: Pt2[] = pts.map(([z, y]) => [-z, y]);
  const g = prismZ(p, width);
  g.rotateY(Math.PI / 2);
  return g;
}

/* ------------------------------------------------------------------ lofts */

/**
 * One cross-section of a swept solid. The section is a superellipse — `sq = 2`
 * is an ellipse, `sq = 8` is a rounded rectangle, which between them describe
 * every grip, handguard, stock and magazine on a firearm.
 */
export interface LoftRing {
  /** Centre of the section in weapon-local space. */
  at: [number, number, number];
  /** Half-width across the frame's right axis. */
  w: number;
  /** Half-height across the frame's up axis. */
  h: number;
  /** Squareness 2..12. */
  sq?: number;
  /** Roll of the section about the sweep axis, radians. */
  roll?: number;
}

const _prevR = new THREE.Vector3();

const _t = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Sweeps a superelliptical section along a polyline.
 *
 * Frames are built from the local tangent with a fixed world up, which is
 * stable for the shapes a weapon needs (nothing loops or twists past vertical)
 * and avoids the cost and complexity of a parallel-transport frame.
 */
export function loft(
  rings: readonly LoftRing[], sides = 16, capStart = true, capEnd = true,
  upHint?: readonly [number, number, number],
): THREE.BufferGeometry {
  const n = rings.length;
  if (n < 2) return new THREE.BufferGeometry();

  // The reference up is chosen **once** for the whole sweep, from the overall
  // path direction. Choosing it per ring — the obvious implementation — makes
  // the frame snap through 90° the moment a path crosses vertical, which turns
  // a trigger guard or a grip strap into a fan of stray triangles.
  const dx = rings[n - 1].at[0] - rings[0].at[0];
  const dy = rings[n - 1].at[1] - rings[0].at[1];
  const dz = rings[n - 1].at[2] - rings[0].at[2];
  if (upHint) _up.set(upHint[0], upHint[1], upHint[2]);
  else if (Math.abs(dy) > Math.max(Math.abs(dx), Math.abs(dz)) * 1.2) _up.set(0, 0, -1);
  else _up.set(0, 1, 0);
  _prevR.set(1, 0, 0);

  const pts: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const a = rings[Math.max(0, i - 1)].at;
    const b = rings[Math.min(n - 1, i + 1)].at;
    _t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (_t.lengthSq() < 1e-12) _t.set(0, 0, -1);
    _t.normalize();
    _r.crossVectors(_up, _t);
    // Near-degenerate frame: carry the previous one rather than snapping.
    if (_r.lengthSq() < 0.02) {
      // Re-orthogonalise the carried frame against the new tangent.
      _r.copy(_prevR).addScaledVector(_t, -_prevR.dot(_t));
      if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0);
    }
    _r.normalize();
    _prevR.copy(_r);
    _u.crossVectors(_t, _r).normalize();

    const ring = rings[i];
    const sq = ring.sq ?? 6;
    const roll = ring.roll ?? 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const e = 2 / sq;
    const list: THREE.Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a2 = (s / sides) * Math.PI * 2;
      const c = Math.cos(a2), si = Math.sin(a2);
      const sx = ring.w * Math.sign(c) * Math.pow(Math.abs(c), e);
      const sy = ring.h * Math.sign(si) * Math.pow(Math.abs(si), e);
      const rx = sx * cr - sy * sr;
      const ry = sx * sr + sy * cr;
      _p.set(ring.at[0], ring.at[1], ring.at[2])
        .addScaledVector(_r, rx)
        .addScaledVector(_u, ry);
      list.push(_p.clone());
    }
    pts.push(list);
  }

  // Skin: indexed so `computeVertexNormals` smooths along and around the sweep.
  const pos: number[] = [];
  const idx: number[] = [];
  for (const ring of pts) for (const p of ring) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = i * sides + s, b = i * sides + s2;
      const c = (i + 1) * sides + s2, d = (i + 1) * sides + s;
      idx.push(a, c, b, a, d, c);
    }
  }
  const skin = new THREE.BufferGeometry();
  skin.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  skin.setIndex(idx);
  skin.computeVertexNormals();

  const parts: THREE.BufferGeometry[] = [skin];
  const cap = (ring: THREE.Vector3[], from: [number, number, number], to: [number, number, number]): THREE.BufferGeometry => {
    const tb = new TriBuilder();
    // "Outward" for an end cap is away from the neighbouring ring; pushing the
    // reference point a metre back along that axis makes the winding test in
    // TriBuilder unambiguous regardless of section size.
    const ox = from[0] - to[0], oy = from[1] - to[1], oz = from[2] - to[2];
    const l = Math.hypot(ox, oy, oz) || 1;
    tb.centre.set(from[0] - (ox / l), from[1] - (oy / l), from[2] - (oz / l));
    for (let s = 1; s < sides - 1; s++) {
      tb.tri(
        [ring[0].x, ring[0].y, ring[0].z],
        [ring[s].x, ring[s].y, ring[s].z],
        [ring[s + 1].x, ring[s + 1].y, ring[s + 1].z],
      );
    }
    return tb.build();
  };
  if (capStart) parts.push(cap(pts[0], rings[0].at, rings[1].at));
  if (capEnd) parts.push(cap(pts[n - 1], rings[n - 1].at, rings[n - 2].at));
  return merge(parts);
}

/** Torus in the XY plane (axis along Z). */
export function torusZ(rMajor: number, rMinor: number, segT = 24, segR = 10, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(rMajor, rMinor, segR, segT, arc);
}

export function ball(r: number, seg = 16): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));
}

/* ------------------------------------------------------- weapon fittings */

/**
 * MIL-STD-1913 rail along Z: a base with a 45° top bevel, cross slots every
 * 10 mm and a recoil lug at the rear.
 */
export function picatinny(len: number, width = 0.0212, height = 0.0085): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const slotPitch = 0.0100;
  const slotWidth = 0.0053;
  const count = Math.max(1, Math.floor(len / slotPitch));
  const ribLen = slotPitch - slotWidth;
  const base = chamferBox(width * 0.72, height * 0.45, len, 0.0006);
  parts.push(xf(base, { pos: [0, -height * 0.28, 0] }));
  for (let i = 0; i < count; i++) {
    const z = -len / 2 + slotPitch * (i + 0.5);
    const rib = chamferBox(width, height * 0.62, ribLen, 0.0011);
    parts.push(xf(rib, { pos: [0, height * 0.16, z] }));
  }
  return merge(parts);
}

/**
 * M-LOK style slotted handguard: a faceted shell with real openings.
 *
 * The slots are genuine gaps in the panels, backed by an inner liner tube, so
 * you see *through* the shell into shadow. Fake slots — a recessed decal or a
 * pair of raised lips — read as a printed pattern the moment there is a strong
 * key light, which on a first-person weapon is always.
 */
export function mlokTube(len: number, radius: number, sides = 8, slotRows = 3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wall = radius * 0.20;
  const inner = radius - wall;

  // Liner: what you see through the slots.
  parts.push(pipeZ(inner * 0.96, inner * 0.74, len * 0.98, sides * 3));

  const pitch = 0.0468;
  const slotLen = 0.0300;
  const nSlots = Math.max(1, Math.floor((len - 0.030) / pitch));
  const first = -len / 2 + (len - (nSlots - 1) * pitch) / 2;
  // Slot rows at 3, 6 and 9 o'clock; the top face carries the rail riser.
  const rowSet = new Set<number>();
  for (let r = 0; r < slotRows; r++) {
    rowSet.add(Math.round((sides * (r + 1)) / (slotRows + 1)));
  }

  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
    const faceW = 2 * radius * Math.tan(Math.PI / sides) * 0.99;
    const place = (g: THREE.BufferGeometry): void => {
      xf(g, { pos: [0, radius - wall * 0.5, 0] });
      xf(g, { rot: [0, 0, a] });
      parts.push(g);
    };

    if (!rowSet.has(i)) {
      place(chamferBox(faceW, wall, len, 0.0010));
      continue;
    }
    // Split the panel around each slot: |--solid--[gap]--solid--[gap]--|
    let z = -len / 2;
    for (let s = 0; s < nSlots; s++) {
      const slotStart = first + s * pitch - slotLen / 2;
      const solid = slotStart - z;
      if (solid > 0.0015) {
        const g = chamferBox(faceW, wall, solid, 0.0010);
        xf(g, { pos: [0, 0, z + solid / 2] });
        place(g);
      }
      // Side rails flanking the slot, so the opening has a machined edge.
      for (const sx of [-1, 1]) {
        const rail = chamferBox((faceW - 0.0090) / 2, wall, slotLen, 0.0008);
        xf(rail, { pos: [sx * (faceW / 2 - (faceW - 0.0090) / 4), 0, slotStart + slotLen / 2] });
        place(rail);
      }
      z = slotStart + slotLen;
    }
    const tail = len / 2 - z;
    if (tail > 0.0015) {
      const g = chamferBox(faceW, wall, tail, 0.0010);
      xf(g, { pos: [0, 0, z + tail / 2] });
      place(g);
    }
  }
  return merge(parts);
}

/** Ring of cooling vents cut into a shroud, drawn as raised bosses. */
export function ventRing(radius: number, z: number, count = 6, w = 0.006, h = 0.0022, len = 0.030): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const g = chamferBox(w, h, len, 0.0005);
    xf(g, { pos: [0, radius, z] });
    xf(g, { rot: [0, 0, a] });
    parts.push(g);
  }
  return merge(parts);
}

/** Slotted screw head sitting proud of a surface, facing +Y by default. */
export function screwHead(r = 0.0026, proud = 0.0009): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    lathe([[-proud, r], [proud * 0.4, r], [proud, r * 0.86]], 12),
    disc(r * 0.86, proud, 1, 12),
    xf(chamferBox(r * 1.7, r * 0.34, proud * 0.5, 0.0002), { pos: [0, 0, proud * 0.86] }),
  ];
  const g = merge(parts);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Hex bolt head, facing +Y. */
export function hexHead(r = 0.0030, h = 0.0022): THREE.BufferGeometry {
  const pts: Pt2[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const g = prismZ(pts, h);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A QD sling socket: a shallow cup with a rim. */
export function slingSocket(r = 0.0052): THREE.BufferGeometry {
  return lathe([
    [-0.0015, r * 0.55], [-0.0015, r], [0.0012, r], [0.0018, r * 0.86], [0.0018, r * 0.5],
  ], 14);
}

/** Cross pin with a chamfered head, along X. */
export function crossPin(r = 0.0028, len = 0.014): THREE.BufferGeometry {
  const g = lathe([
    [-len / 2, r * 0.9], [-len / 2 + 0.0008, r], [len / 2 - 0.0008, r], [len / 2, r * 0.9],
  ], 14);
  const caps = merge([disc(r * 0.9, -len / 2, -1, 14), disc(r * 0.9, len / 2, 1, 14)]);
  const m = merge([g, caps]);
  m.rotateY(Math.PI / 2);
  return m;
}

/**
 * A run of panel-line grooves along Z on a flat face — the cheap detail that
 * makes a large flat receiver side read as manufactured rather than extruded.
 */
export function panelLines(
  count: number, spacing: number, len: number, w = 0.0011, depth = 0.0008,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const y = (i - (count - 1) / 2) * spacing;
    parts.push(xf(chamferBox(w, depth, len, 0.0003), { pos: [0, y, 0] }));
  }
  return merge(parts);
}

/** Grip / handguard checkering: a lattice of tiny raised pyramids. */
export function checkering(
  w: number, h: number, cols: number, rows: number, height = 0.0009,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cw = w / cols, ch = h / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -w / 2 + cw * (i + 0.5);
      const y = -h / 2 + ch * (j + 0.5);
      const g = lathe([[0, cw * 0.44], [height, 0.0001]], 4);
      g.rotateZ(Math.PI / 4);
      g.rotateX(-Math.PI / 2);
      parts.push(xf(g, { pos: [x, 0, y] }));
    }
  }
  return merge(parts);
}

/** Curved magazine body: a lofted box swept along an arc in the YZ plane. */
export function curvedMag(
  width: number, depth: number, length: number, curve: number, steps = 8, taper = 0.94,
): THREE.BufferGeometry {
  const rings: Array<Array<[number, number, number]>> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = -length * t;
    const z = curve * length * (t * t);
    const k = 1 - (1 - taper) * t;
    const w = (width * k) / 2;
    const d = (depth * k) / 2;
    const ang = Math.atan2(2 * curve * t, 1);
    const cz = Math.cos(ang), sz = Math.sin(ang);
    const ring: Array<[number, number, number]> = [];
    const corners: Pt2[] = [[-w, -d], [w, -d], [w, d], [-w, d]];
    for (const [cx, cy] of corners) {
      // Rotate the cross-section into the sweep frame (about X).
      ring.push([cx, y + cy * -sz, z + cy * cz]);
    }
    rings.push(ring);
  }
  const tb = new TriBuilder();
  tb.centre.set(0, -length / 2, curve * length * 0.35);
  for (let i = 0; i < steps; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      tb.quad(a[k], a[k2], b[k2], b[k]);
    }
  }
  const top = rings[0], bot = rings[steps];
  tb.quad(top[0], top[1], top[2], top[3]);
  tb.quad(bot[0], bot[1], bot[2], bot[3]);
  return tb.build();
}

/** Bounding box of a geometry, for auto-fitting attachments. */
export function boundsOf(geo: THREE.BufferGeometry): THREE.Box3 {
  geo.computeBoundingBox();
  return geo.boundingBox ?? new THREE.Box3();
}

export function triangleCount(geo: THREE.BufferGeometry): number {
  const p = geo.getAttribute('position');
  return p ? p.count / 3 : 0;
}
