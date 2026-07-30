/**
 * Skinned-mesh construction kit.
 *
 * Everything a soldier is made of is emitted through this builder: lofted tubes
 * for limbs and torso, deformed spheres for the skull, rounded boxes for
 * pouches and armour, ribbons for straps and slings.
 *
 * Three things make it produce game-quality meshes rather than primitives glued
 * together:
 *
 *  1. **Per-primitive normal accumulation.** Normals are averaged over the
 *     vertex range of one primitive only, so a lofted sleeve shades smoothly
 *     while a magazine pouch welded on top of it keeps hard edges — without any
 *     smoothing-group bookkeeping at the call site.
 *  2. **Automatic skin weighting from bind-pose bone segments.** Each primitive
 *     declares which bones may influence it; weights fall off with distance to
 *     those bones' bind-pose segments and are renormalised over the best four.
 *     Layered gear therefore deforms with the body it sits on instead of
 *     needing hand-painted weights.
 *  3. **Material slots as geometry groups.** One geometry, one skeleton, one
 *     draw call per material family.
 */

import * as THREE from 'three';
import type { BoneName } from '../types';
import { BONE_INDEX, type RigInstance } from '../Rig';

/**
 * How dark baked occlusion is allowed to go.
 *
 * Vertex colour multiplies the *direct* term as well as the ambient in a
 * standard material, so this is a contact-shadow budget, not a real AO term:
 * deep enough to seat a pouch on a plate, shallow enough that a sunlit chest
 * does not turn to mud. Anything below ~0.5 here and the carrier reads black.
 */
const AO_FLOOR = 0.55;

/* --------------------------------------------------------------- material slots */

export const SLOT = {
  SKIN: 0,
  CLOTH: 1,
  GEAR: 2,
  HARD: 3,
  METAL: 4,
} as const;
export type SlotId = (typeof SLOT)[keyof typeof SLOT];
export const SLOT_COUNT = 5;

/** Metres of surface covered by one texture repeat, per slot. */
export const SLOT_TILE: number[] = [0.36, 0.46, 0.30, 0.26, 0.18];

/* ------------------------------------------------------------------- binding */

export interface BindSpec {
  /** Candidate bones. Weights fall off with distance to their bind segments. */
  bones: BoneName[];
  /** Falloff exponent; 3 is soft, 8 is nearly rigid. */
  power?: number;
  /** Extra rigidity: blend the computed weights toward the single closest bone. */
  stiffness?: number;
}

interface ResolvedBind {
  idx: number[];
  power: number;
  stiffness: number;
}

const ARM_L: BoneName[] = ['chest', 'shoulderL', 'upperArmL', 'lowerArmL', 'handL'];
const ARM_R: BoneName[] = ['chest', 'shoulderR', 'upperArmR', 'lowerArmR', 'handR'];
const LEG_L: BoneName[] = ['hips', 'upperLegL', 'lowerLegL', 'footL', 'toeL'];
const LEG_R: BoneName[] = ['hips', 'upperLegR', 'lowerLegR', 'footR', 'toeR'];

/** Ready-made bind specs for the common body regions. */
export const BIND = {
  torso: { bones: ['hips', 'spine', 'chest', 'neck', 'shoulderL', 'shoulderR'], power: 4 } as BindSpec,
  torsoRigid: { bones: ['spine', 'chest'], power: 6, stiffness: 0.5 } as BindSpec,
  hips: { bones: ['hips', 'spine', 'upperLegL', 'upperLegR'], power: 5 } as BindSpec,
  chest: { bones: ['chest'], power: 8, stiffness: 1 } as BindSpec,
  spine: { bones: ['spine', 'chest'], power: 6, stiffness: 0.4 } as BindSpec,
  neck: { bones: ['chest', 'neck', 'head'], power: 5 } as BindSpec,
  head: { bones: ['head'], power: 8, stiffness: 1 } as BindSpec,
  headSoft: { bones: ['neck', 'head'], power: 6, stiffness: 0.4 } as BindSpec,
  armL: { bones: ARM_L, power: 4 } as BindSpec,
  armR: { bones: ARM_R, power: 4 } as BindSpec,
  handL: { bones: ['handL'], power: 8, stiffness: 1 } as BindSpec,
  handR: { bones: ['handR'], power: 8, stiffness: 1 } as BindSpec,
  legL: { bones: LEG_L, power: 4 } as BindSpec,
  legR: { bones: LEG_R, power: 4 } as BindSpec,
  footL: { bones: ['footL', 'toeL'], power: 6, stiffness: 0.5 } as BindSpec,
  footR: { bones: ['footR', 'toeR'], power: 6, stiffness: 0.5 } as BindSpec,
  kneeL: { bones: ['lowerLegL'], power: 8, stiffness: 1 } as BindSpec,
  kneeR: { bones: ['lowerLegR'], power: 8, stiffness: 1 } as BindSpec,
  shoulderL: { bones: ['chest', 'shoulderL', 'upperArmL'], power: 5 } as BindSpec,
  shoulderR: { bones: ['chest', 'shoulderR', 'upperArmR'], power: 5 } as BindSpec,
} as const;

/* ------------------------------------------------------------------ profiles */

/**
 * Superellipse cross-section. `e` = 2 is an ellipse; 2.6–3.4 gives the flat
 * front/back and rounded sides a human torso actually has.
 */
export function superPoint(theta: number, rx: number, rz: number, e: number, out: THREE.Vector2): THREE.Vector2 {
  const c = Math.cos(theta), s = Math.sin(theta);
  const p = 2 / e;
  out.x = rx * Math.sign(c) * Math.abs(c) ** p;
  out.y = rz * Math.sign(s) * Math.abs(s) ** p;
  return out;
}

export interface Ring {
  /** Centre of the cross-section in character space. */
  y: number;
  x?: number;
  z?: number;
  /** Half-width (X) and half-depth (Z). */
  rx: number;
  rz: number;
  /** Superellipse exponent. */
  e?: number;
  /** Extra forward push of the front half only — chest, belly, seat. */
  bulgeZ?: number;
  /** Rotation of the section about Y, radians. */
  twist?: number;
  /** Per-ring vertical scale of the section (for tapered caps). */
  scale?: number;
}

/* ------------------------------------------------------------------- builder */

interface Group { start: number; count: number; slot: number; }

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p2 = new THREE.Vector2();

export class SkinMeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private bindId: number[] = [];
  private index: number[] = [];
  /** Index buffers per slot, concatenated at build time into groups. */
  private slotIndex: number[][] = [];

  private binds: ResolvedBind[] = [];
  private bindKey = new Map<string, number>();
  private curBind = 0;
  private curSlot = 0;
  private curColor = new THREE.Color(1, 1, 1);
  private primStart = 0;
  private uvScale = 1;
  /** Metric size of the next `patch()`, used to give it sane UVs. */
  private patchU = 0.3;
  private patchV = 0.3;

  /** Bind-pose bone segments used for automatic weighting. */
  private segA: THREE.Vector3[];
  private segB: THREE.Vector3[];

  constructor(rig: RigInstance, segments: { a: THREE.Vector3; b: THREE.Vector3 }[]) {
    this.segA = segments.map((s) => s.a);
    this.segB = segments.map((s) => s.b);
    for (let i = 0; i < SLOT_COUNT; i++) this.slotIndex.push([]);
    void rig;
  }

  get vertexCount(): number { return this.pos.length / 3; }
  get triangleCount(): number {
    let n = 0;
    for (const s of this.slotIndex) n += s.length;
    return n / 3;
  }

  /* --------------------------------------------------------------- state */

  slot(s: SlotId | number): this {
    this.curSlot = s;
    this.uvScale = 1 / SLOT_TILE[s];
    return this;
  }

  /**
   * Sets the vertex tint from a **linear** modulation colour.
   *
   * `Appearance` hands out tints already calibrated in linear space against the
   * mean albedo of the slot's texture (see `MEAN_ALBEDO` there), so what arrives
   * here is a straight multiplier on an already-linear albedo — exactly what
   * three does with `vColor`. Converting again is what used to crush every dark
   * piece of kit to black: a 0.62 "level" became 0.34 in linear and then met a
   * 0.2-linear texture.
   *
   * `mul` is a relative shade for one part of a kit family (a flap 0.8× the
   * pouch it sits on) and is applied in linear too.
   */
  color(c: THREE.Color, mul = 1): this {
    this.curColor.setRGB(
      THREE.MathUtils.clamp(c.r * mul, 0.0015, 1),
      THREE.MathUtils.clamp(c.g * mul, 0.0015, 1),
      THREE.MathUtils.clamp(c.b * mul, 0.0015, 1),
    );
    return this;
  }

  /** Sets the vertex tint from an sRGB triple (authoring convenience). */
  colorRGB(r: number, g: number, b: number): this {
    this.curColor.setRGB(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
    return this;
  }

  /** Approximate metric extent of the next patch, so its UVs keep texel density. */
  patchSize(u: number, v: number): this {
    this.patchU = u; this.patchV = v;
    return this;
  }

  bind(spec: BindSpec): this {
    const key = `${spec.bones.join(',')}|${spec.power ?? 4}|${spec.stiffness ?? 0}`;
    let id = this.bindKey.get(key);
    if (id === undefined) {
      id = this.binds.length;
      this.binds.push({
        idx: spec.bones.map((b) => BONE_INDEX[b]),
        power: spec.power ?? 4,
        stiffness: spec.stiffness ?? 0,
      });
      this.bindKey.set(key, id);
    }
    this.curBind = id;
    return this;
  }

  /* ---------------------------------------------------------- primitives */

  /** Marks the start of a primitive; normals are averaged inside this range. */
  begin(): void { this.primStart = this.vertexCount; }

  /**
   * Averages face normals over the primitive's vertex range, then welds the
   * result across coincident vertices. The weld is what kills the shading seam
   * every lofted tube would otherwise show along its UV split.
   */
  end(): void {
    const from = this.primStart;
    const to = this.vertexCount;
    if (to <= from) return;
    for (let i = from * 3; i < to * 3; i++) this.nrm[i] = 0;

    const list = this.slotIndex[this.curSlot];
    for (let i = 0; i < list.length; i += 3) {
      const a = list[i], b = list[i + 1], c = list[i + 2];
      if (a < from || a >= to) continue;
      _v0.fromArray(this.pos, a * 3);
      _v1.fromArray(this.pos, b * 3);
      _v2.fromArray(this.pos, c * 3);
      _ab.subVectors(_v1, _v0);
      _ac.subVectors(_v2, _v0);
      _n.crossVectors(_ab, _ac);
      this.nrm[a * 3] += _n.x; this.nrm[a * 3 + 1] += _n.y; this.nrm[a * 3 + 2] += _n.z;
      this.nrm[b * 3] += _n.x; this.nrm[b * 3 + 1] += _n.y; this.nrm[b * 3 + 2] += _n.z;
      this.nrm[c * 3] += _n.x; this.nrm[c * 3 + 1] += _n.y; this.nrm[c * 3 + 2] += _n.z;
    }

    // Weld coincident vertices (UV seams, wrapped patch columns).
    const weld = new Map<string, number[]>();
    for (let i = from; i < to; i++) {
      const key = `${Math.round(this.pos[i * 3] * 8192)},${Math.round(this.pos[i * 3 + 1] * 8192)},${Math.round(this.pos[i * 3 + 2] * 8192)}`;
      const bucket = weld.get(key);
      if (bucket) bucket.push(i); else weld.set(key, [i]);
    }
    for (const bucket of weld.values()) {
      if (bucket.length < 2) continue;
      let x = 0, y = 0, z = 0;
      for (const i of bucket) { x += this.nrm[i * 3]; y += this.nrm[i * 3 + 1]; z += this.nrm[i * 3 + 2]; }
      for (const i of bucket) { this.nrm[i * 3] = x; this.nrm[i * 3 + 1] = y; this.nrm[i * 3 + 2] = z; }
    }

    for (let i = from; i < to; i++) {
      const x = this.nrm[i * 3], y = this.nrm[i * 3 + 1], z = this.nrm[i * 3 + 2];
      const len = Math.hypot(x, y, z) || 1;
      this.nrm[i * 3] = x / len; this.nrm[i * 3 + 1] = y / len; this.nrm[i * 3 + 2] = z / len;
    }
  }

  vertex(x: number, y: number, z: number, u: number, v: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(0, 1, 0);
    this.uv.push(u * this.uvScale, v * this.uvScale);
    this.col.push(this.curColor.r, this.curColor.g, this.curColor.b);
    this.bindId.push(this.curBind);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.slotIndex[this.curSlot].push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    const list = this.slotIndex[this.curSlot];
    list.push(a, b, c, a, c, d);
  }

  /**
   * Lofts a closed tube through a list of cross-sections. Returns the vertex
   * index of the first and last ring so callers can cap or stitch them.
   */
  tube(rings: Ring[], sides: number, opts: {
    capStart?: boolean; capEnd?: boolean;
    /** Per-vertex displacement, e.g. cloth folds. */
    warp?: (p: THREE.Vector3, ring: number, side: number, u: number) => void;
    /** V coordinate offset so successive pieces keep texture continuity. */
    v0?: number;
  } = {}): { first: number; last: number; ringVerts: number } {
    this.begin();
    const ringVerts = sides + 1; // duplicated seam vertex for clean UVs
    const first = this.vertexCount;
    let vAcc = opts.v0 ?? 0;
    let prevY = rings[0].y;
    let prevX = rings[0].x ?? 0;
    let prevZ = rings[0].z ?? 0;

    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const cx = ring.x ?? 0, cz = ring.z ?? 0;
      vAcc += Math.hypot(cx - prevX, ring.y - prevY, cz - prevZ);
      prevX = cx; prevY = ring.y; prevZ = cz;
      const e = ring.e ?? 2.4;
      const twist = ring.twist ?? 0;
      const sc = ring.scale ?? 1;

      // Arc-length parameterisation around the section so texture density is
      // uniform regardless of how elliptical the cross-section is.
      let arc = 0;
      let px = 0, pz = 0;
      for (let s = 0; s <= sides; s++) {
        const t = (s / sides) * Math.PI * 2;
        superPoint(t, ring.rx * sc, ring.rz * sc, e, _p2);
        let x = _p2.x, z = _p2.y;
        if (ring.bulgeZ && z > 0) z += ring.bulgeZ * (z / (ring.rz * sc || 1));
        if (twist) {
          const c = Math.cos(twist), si = Math.sin(twist);
          const nx = x * c - z * si; z = x * si + z * c; x = nx;
        }
        if (s > 0) arc += Math.hypot(x - px, z - pz);
        px = x; pz = z;

        _v0.set(cx + x, ring.y, cz + z);
        opts.warp?.(_v0, r, s, s / sides);
        this.vertex(_v0.x, _v0.y, _v0.z, arc, vAcc);
      }
    }

    for (let r = 0; r < rings.length - 1; r++) {
      const a = first + r * ringVerts;
      const b = first + (r + 1) * ringVerts;
      for (let s = 0; s < sides; s++) {
        this.quad(a + s, a + s + 1, b + s + 1, b + s);
      }
    }

    if (opts.capStart) this.capRing(first, sides, rings[0], true);
    if (opts.capEnd) this.capRing(first + (rings.length - 1) * ringVerts, sides, rings[rings.length - 1], false);

    const last = first + (rings.length - 1) * ringVerts;
    this.end();
    return { first, last, ringVerts };
  }

  private capRing(base: number, sides: number, ring: Ring, flip: boolean): void {
    const cx = ring.x ?? 0, cz = ring.z ?? 0;
    const centre = this.vertex(cx, ring.y, cz, 0, 0);
    for (let s = 0; s < sides; s++) {
      if (flip) this.tri(centre, base + s + 1, base + s);
      else this.tri(centre, base + s, base + s + 1);
    }
  }

  /**
   * A rounded box built by projecting a subdivided cube onto a box with
   * spherical corners. Smooth-shaded; used for pouches, pads and armour blocks.
   */
  roundedBox(
    centre: THREE.Vector3, size: THREE.Vector3, radius: number, seg = 3,
    orient?: THREE.Quaternion,
  ): void {
    this.begin();
    const hx = Math.max(size.x * 0.5 - radius, 1e-4);
    const hy = Math.max(size.y * 0.5 - radius, 1e-4);
    const hz = Math.max(size.z * 0.5 - radius, 1e-4);
    const n = seg + 1;
    const first = this.vertexCount;
    const grid: number[] = [];

    // Six faces of a subdivided cube, each vertex pushed out to the rounded box.
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
      [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)],
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
    ];

    for (const [nrm, tan, bit] of faces) {
      const base = this.vertexCount;
      grid.length = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = (i / seg) * 2 - 1;
          const b = (j / seg) * 2 - 1;
          _v0.copy(nrm).multiply(new THREE.Vector3(hx + radius, hy + radius, hz + radius));
          _v1.copy(tan).multiplyScalar(a).multiply(new THREE.Vector3(hx, hy, hz));
          _v2.copy(bit).multiplyScalar(b).multiply(new THREE.Vector3(hx, hy, hz));
          _n.copy(_v0).add(_v1).add(_v2);
          // Clamp to the inner box and push out by the corner radius.
          const cxp = THREE.MathUtils.clamp(_n.x, -hx, hx);
          const cyp = THREE.MathUtils.clamp(_n.y, -hy, hy);
          const czp = THREE.MathUtils.clamp(_n.z, -hz, hz);
          _v0.set(_n.x - cxp, _n.y - cyp, _n.z - czp);
          if (_v0.lengthSq() > 1e-9) _v0.normalize().multiplyScalar(radius);
          _v1.set(cxp + _v0.x, cyp + _v0.y, czp + _v0.z);
          if (orient) _v1.applyQuaternion(orient);
          _v1.add(centre);
          // Box-projected UVs in metres.
          const u = Math.abs(nrm.x) > 0.5 ? _v1.z : _v1.x;
          const vv = Math.abs(nrm.y) > 0.5 ? _v1.z : _v1.y;
          grid.push(this.vertex(_v1.x, _v1.y, _v1.z, u, vv));
        }
      }
      for (let j = 0; j < seg; j++) {
        for (let i = 0; i < seg; i++) {
          const a = base + j * n + i;
          this.quad(a, a + 1, a + n + 1, a + n);
        }
      }
    }
    void first;
    this.end();
  }

  /** A sphere whose radius is modulated by a callback — skulls, shoulders. */
  sphere(
    centre: THREE.Vector3, radius: THREE.Vector3, segU: number, segV: number,
    displace?: (dir: THREE.Vector3, u: number, v: number, out: THREE.Vector3) => void,
    skip?: (u: number, v: number) => boolean,
  ): void {
    this.begin();
    const first = this.vertexCount;
    const rowVerts = segU + 1;
    for (let j = 0; j <= segV; j++) {
      const v = j / segV;
      const phi = v * Math.PI;
      const sy = Math.cos(phi);
      const sr = Math.sin(phi);
      for (let i = 0; i <= segU; i++) {
        const u = i / segU;
        const th = u * Math.PI * 2;
        _n.set(Math.sin(th) * sr, sy, Math.cos(th) * sr);
        _v0.set(_n.x * radius.x, _n.y * radius.y, _n.z * radius.z);
        if (displace) displace(_n, u, v, _v0);
        _v0.add(centre);
        this.vertex(_v0.x, _v0.y, _v0.z, u * Math.PI * 2 * radius.x, v * Math.PI * radius.y);
      }
    }
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        if (skip && skip((i + 0.5) / segU, (j + 0.5) / segV)) continue;
        const a = first + j * rowVerts + i;
        const b = a + rowVerts;
        if (j !== 0) this.tri(a, a + 1, b);
        if (j !== segV - 1) this.tri(a + 1, b + 1, b);
      }
    }
    this.end();
  }

  /**
   * A ribbon swept along a path — slings, straps, belts.
   *
   * `widthHint` is the direction the strap's *width* should run in: (1,0,0) for
   * something crossing the body left-to-right, (0,1,0) for a band wrapping
   * horizontally around the head. It is projected onto the plane perpendicular
   * to the path, so it stays sensible as the path curves. Getting this wrong is
   * what turns a shoulder strap into a fin, so it is worth being explicit.
   */
  ribbon(
    path: THREE.Vector3[], width: number, thickness: number,
    widthHint: THREE.Vector3 = new THREE.Vector3(1, 0, 0),
  ): void {
    this.begin();
    const first = this.vertexCount;
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();
    const nor = new THREE.Vector3();
    let vAcc = 0;
    const ringVerts = 4;

    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (i === 0) tan.subVectors(path[1], path[0]);
      else if (i === path.length - 1) tan.subVectors(path[i], path[i - 1]);
      else tan.subVectors(path[i + 1], path[i - 1]);
      if (i > 0) vAcc += p.distanceTo(path[i - 1]);
      tan.normalize();
      side.copy(widthHint).addScaledVector(tan, -widthHint.dot(tan));
      if (side.lengthSq() < 1e-8) {
        side.set(0, 1, 0).addScaledVector(tan, -tan.y);
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      }
      side.normalize();
      nor.crossVectors(side, tan).normalize();

      const hw = width * 0.5, ht = thickness * 0.5;
      const corners: [number, number][] = [[-hw, ht], [hw, ht], [hw, -ht], [-hw, -ht]];
      for (const [a, b] of corners) {
        _v0.copy(p).addScaledVector(side, a).addScaledVector(nor, b);
        this.vertex(_v0.x, _v0.y, _v0.z, a + hw, vAcc);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      const a = first + i * ringVerts;
      const b = a + ringVerts;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        this.quad(a + k, a + k2, b + k2, b + k);
      }
    }
    this.end();
  }

  /** Straight cylinder between two points; used for tubes, antennae, rails. */
  cylinder(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, sides = 10, caps = true): void {
    this.begin();
    const first = this.vertexCount;
    const dir = _v0.subVectors(b, a).clone();
    const len = dir.length() || 1e-4;
    dir.multiplyScalar(1 / len);
    const ref = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const sx = new THREE.Vector3().crossVectors(ref, dir).normalize();
    const sz = new THREE.Vector3().crossVectors(dir, sx).normalize();
    const ringVerts = sides + 1;

    for (let e = 0; e < 2; e++) {
      const p = e === 0 ? a : b;
      const r = e === 0 ? r0 : r1;
      for (let s = 0; s <= sides; s++) {
        const t = (s / sides) * Math.PI * 2;
        _v1.copy(p).addScaledVector(sx, Math.cos(t) * r).addScaledVector(sz, Math.sin(t) * r);
        this.vertex(_v1.x, _v1.y, _v1.z, (s / sides) * Math.PI * 2 * r, e * len);
      }
    }
    for (let s = 0; s < sides; s++) {
      this.quad(first + s, first + s + 1, first + ringVerts + s + 1, first + ringVerts + s);
    }
    if (caps) {
      const c0 = this.vertex(a.x, a.y, a.z, 0, 0);
      const c1 = this.vertex(b.x, b.y, b.z, 0, len);
      for (let s = 0; s < sides; s++) {
        this.tri(c0, first + s + 1, first + s);
        this.tri(c1, first + ringVerts + s, first + ringVerts + s + 1);
      }
    }
    this.end();
  }

  /**
   * A curved quad patch — armour plates, helmet covers, chest rig faces.
   * `at(u, v)` returns the surface point; the patch is one primitive so it
   * shades smoothly and welds to nothing.
   */
  patch(
    nu: number, nv: number,
    at: (u: number, v: number, out: THREE.Vector3) => void,
    flip = false,
  ): void {
    this.begin();
    const first = this.vertexCount;
    const rowVerts = nu + 1;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv;
        at(u, v, _v0);
        this.vertex(_v0.x, _v0.y, _v0.z, u * this.patchU, v * this.patchV);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = first + j * rowVerts + i;
        if (flip) this.quad(a, a + rowVerts, a + rowVerts + 1, a + 1);
        else this.quad(a, a + 1, a + rowVerts + 1, a + rowVerts);
      }
    }
    this.end();
  }

  /**
   * A closed shell with thickness: outer surface, inner surface and a rim
   * joining them. This is what armour plates, helmet shells, knee pads and
   * pouch flaps are made of — real kit is a curved slab, not a box, and the rim
   * is what reads as "3 cm of ballistic plate" in a silhouette.
   */
  solidPatch(
    nu: number, nv: number,
    at: (u: number, v: number, out: THREE.Vector3) => void,
    thickness: number,
    flip = false,
  ): void {
    this.begin();
    const cols = nu + 1, rows = nv + 1;
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = new THREE.Vector3();
        at(i / nu, j / nv, p);
        pts.push(p);
      }
    }
    // Outward normal. The default assumes the common authoring convention here:
    // `u` sweeps around the body and `v` runs downward, for which cross(du, dv)
    // points *into* the body — so it is negated unless `flip` says otherwise.
    // Getting this wrong renders the shell's inner sheet, which reads as a dark
    // slab floating where the plate should be.
    const nrms: THREE.Vector3[] = [];
    const du = new THREE.Vector3(), dv = new THREE.Vector3();
    const sign = flip ? 1 : -1;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(cols - 1, i + 1);
        const j0 = Math.max(0, j - 1), j1 = Math.min(rows - 1, j + 1);
        du.subVectors(pts[j * cols + i1], pts[j * cols + i0]);
        dv.subVectors(pts[j1 * cols + i], pts[j0 * cols + i]);
        const n = new THREE.Vector3().crossVectors(du, dv);
        if (n.lengthSq() < 1e-12) n.set(0, 0, 1); else n.normalize();
        n.multiplyScalar(sign);
        nrms.push(n);
      }
    }

    const first = this.vertexCount;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = pts[j * cols + i];
        this.vertex(p.x, p.y, p.z, (i / nu) * this.patchU, (j / nv) * this.patchV);
      }
    }
    const innerBase = this.vertexCount;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = pts[j * cols + i], n = nrms[j * cols + i];
        this.vertex(
          p.x - n.x * thickness, p.y - n.y * thickness, p.z - n.z * thickness,
          (i / nu) * this.patchU, (j / nv) * this.patchV,
        );
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = first + j * cols + i;
        const b = innerBase + j * cols + i;
        if (flip) {
          this.quad(a, a + 1, a + cols + 1, a + cols);
          this.quad(b, b + cols, b + cols + 1, b + 1);
        } else {
          this.quad(a, a + cols, a + cols + 1, a + 1);
          this.quad(b, b + 1, b + cols + 1, b + cols);
        }
      }
    }
    // Rim: four borders stitched between the two sheets.
    const rim = (p0: number, p1: number, q1: number, q0: number): void => {
      if (flip) this.quad(p0, p1, q1, q0); else this.quad(q0, q1, p1, p0);
    };
    for (let i = 0; i < nu; i++) {
      rim(first + i, innerBase + i, innerBase + i + 1, first + i + 1);
      const o = (rows - 1) * cols;
      rim(first + o + i + 1, innerBase + o + i + 1, innerBase + o + i, first + o + i);
    }
    for (let j = 0; j < nv; j++) {
      rim(first + (j + 1) * cols, innerBase + (j + 1) * cols, innerBase + j * cols, first + j * cols);
      const r = cols - 1;
      rim(first + j * cols + r, innerBase + j * cols + r, innerBase + (j + 1) * cols + r, first + (j + 1) * cols + r);
    }
    this.end();
  }

  /* ------------------------------------------------------------------- ao */

  /**
   * Bakes ambient occlusion into the vertex tints.
   *
   * This is the single thing that stops layered kit looking like decals: a
   * plate carrier standing 16 mm off the chest, a pouch strapped to that
   * carrier, a helmet rim over a brow and a sleeve cuff over a wrist all have to
   * darken what they sit on, and no screen-space AO at a soldier's scale is
   * going to find a 16 mm gap.
   *
   * Method: every triangle in the mesh is collapsed into an area-weighted disc
   * in a voxel grid, then each vertex integrates the form factor of the discs in
   * its hemisphere. Two radii run — a tight one for contact darkening under
   * gear, a wide one for the broad shading of armpits, the crotch, under the
   * chin and inside the shoulder line.
   *
   * Cost is ~15 ms for an LOD-0 soldier, paid once when the geometry is built.
   */
  private bakeAO(passes: { radius: number; voxel: number; strength: number }[]): Float32Array {
    const count = this.vertexCount;
    const ao = new Float32Array(count).fill(1);
    if (count === 0) return ao;

    for (const pass of passes) {
      const { radius, voxel, strength } = pass;
      const r2 = radius * radius;
      const inv = 1 / voxel;

      /* 1. area-weighted occluder discs, one per occupied voxel */
      const bucket = new Map<number, number>();
      let n = 0;
      // One voxel per triangle is the worst case, so this never has to grow.
      const cap = Math.max(1, this.triangleCount);
      const px = new Float64Array(cap), py = new Float64Array(cap), pz = new Float64Array(cap);
      const qx = new Float64Array(cap), qy = new Float64Array(cap), qz = new Float64Array(cap);
      const area = new Float64Array(cap);

      for (let s = 0; s < SLOT_COUNT; s++) {
        const list = this.slotIndex[s];
        for (let i = 0; i < list.length; i += 3) {
          const a = list[i] * 3, b = list[i + 1] * 3, c = list[i + 2] * 3;
          const ax = this.pos[a], ay = this.pos[a + 1], az = this.pos[a + 2];
          const e1x = this.pos[b] - ax, e1y = this.pos[b + 1] - ay, e1z = this.pos[b + 2] - az;
          const e2x = this.pos[c] - ax, e2y = this.pos[c + 1] - ay, e2z = this.pos[c + 2] - az;
          const cx = e1y * e2z - e1z * e2y;
          const cy = e1z * e2x - e1x * e2z;
          const cz = e1x * e2y - e1y * e2x;
          const len = Math.hypot(cx, cy, cz);
          if (len < 1e-12) continue;
          const ar = len * 0.5;
          const gx = ax + (e1x + e2x) / 3, gy = ay + (e1y + e2y) / 3, gz = az + (e1z + e2z) / 3;
          const key = (Math.round(gx * inv) + 512)
            + (Math.round(gy * inv) + 512) * 1024
            + (Math.round(gz * inv) + 512) * 1048576;
          let idx = bucket.get(key) ?? -1;
          if (idx < 0) {
            idx = n++;
            bucket.set(key, idx);
          }
          px[idx] += gx * ar; py[idx] += gy * ar; pz[idx] += gz * ar;
          qx[idx] += (cx / len) * ar; qy[idx] += (cy / len) * ar; qz[idx] += (cz / len) * ar;
          area[idx] += ar;
        }
      }
      if (n === 0) continue;
      for (let i = 0; i < n; i++) {
        const w = area[i] || 1;
        px[i] /= w; py[i] /= w; pz[i] /= w;
        const l = Math.hypot(qx[i], qy[i], qz[i]) || 1;
        qx[i] /= l; qy[i] /= l; qz[i] /= l;
      }

      /* 2. lookup grid at the search radius */
      const ginv = 1 / radius;
      const cells = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const key = (Math.round(px[i] * ginv) + 512)
          + (Math.round(py[i] * ginv) + 512) * 1024
          + (Math.round(pz[i] * ginv) + 512) * 1048576;
        const c = cells.get(key);
        if (c) c.push(i); else cells.set(key, [i]);
      }

      /* 3. hemisphere gather */
      for (let v = 0; v < count; v++) {
        const vx = this.pos[v * 3], vy = this.pos[v * 3 + 1], vz = this.pos[v * 3 + 2];
        const vnx = this.nrm[v * 3], vny = this.nrm[v * 3 + 1], vnz = this.nrm[v * 3 + 2];
        const bx = Math.round(vx * ginv), by = Math.round(vy * ginv), bz = Math.round(vz * ginv);
        let occ = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const c = cells.get((bx + dx + 512) + (by + dy + 512) * 1024 + (bz + dz + 512) * 1048576);
              if (!c) continue;
              for (let k = 0; k < c.length; k++) {
                const j = c[k];
                const ex = px[j] - vx, ey = py[j] - vy, ez = pz[j] - vz;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 > r2 || d2 < 1e-9) continue;
                const d = Math.sqrt(d2);
                const cosI = (ex * vnx + ey * vny + ez * vnz) / d;
                if (cosI <= 0.03) continue;
                const cosJ = -(ex * qx[j] + ey * qy[j] + ez * qz[j]) / d;
                if (cosJ <= 0.0) continue;
                // Form factor of a small disc, with a smooth cut at the radius
                // so occluders do not pop as the search sphere sweeps them.
                const fade = 1 - d2 / r2;
                occ += (area[j] * cosI * cosJ * fade * fade) / (Math.PI * d2 + area[j]);
              }
            }
          }
        }
        // A saturating response, not an exponential one. Vertex AO multiplies
        // the *direct* term as well as the ambient in a standard material, so a
        // sunlit chest plate that happens to sit between four pouches must not
        // go to mud — the darkening has to read as contact, not as paint.
        ao[v] *= 1 / (1 + strength * occ);
      }
    }

    for (let i = 0; i < count; i++) ao[i] = AO_FLOOR + (1 - AO_FLOOR) * ao[i];
    return ao;
  }

  /* --------------------------------------------------------------- output */

  /**
   * Computes skin weights and packs everything into a `BufferGeometry` with one
   * group per non-empty material slot.
   *
   * `ao` selects the baked-occlusion budget: `full` for hero LODs, `cheap` for
   * mid, `none` for the distant level where nothing would be visible anyway.
   */
  build(ao: 'full' | 'cheap' | 'none' = 'full'): { geometry: THREE.BufferGeometry; slots: number[] } {
    const count = this.vertexCount;

    if (ao !== 'none') {
      const occl = this.bakeAO(ao === 'full'
        ? [
          { radius: 0.050, voxel: 0.012, strength: 0.90 },
          { radius: 0.200, voxel: 0.045, strength: 0.30 },
        ]
        : [{ radius: 0.090, voxel: 0.026, strength: 0.70 }]);
      for (let i = 0; i < count; i++) {
        const a = occl[i];
        this.col[i * 3] *= a; this.col[i * 3 + 1] *= a; this.col[i * 3 + 2] *= a;
      }
    }
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const p = new THREE.Vector3();

    const cand: { i: number; w: number }[] = [];
    for (let i = 0; i < count; i++) {
      p.fromArray(this.pos, i * 3);
      const bind = this.binds[this.bindId[i]];
      cand.length = 0;
      let best = -1, bestD = Infinity;
      for (const bi of bind.idx) {
        const d = distanceToSegment(p, this.segA[bi], this.segB[bi]);
        if (d < bestD) { bestD = d; best = bi; }
        const w = 1 / (d ** bind.power + 1e-7);
        cand.push({ i: bi, w });
      }
      cand.sort((a, b) => b.w - a.w);
      let sum = 0;
      const n = Math.min(4, cand.length);
      for (let k = 0; k < n; k++) sum += cand[k].w;
      for (let k = 0; k < 4; k++) {
        if (k < n) {
          skinIndex[i * 4 + k] = cand[k].i;
          skinWeight[i * 4 + k] = cand[k].w / sum;
        } else {
          skinIndex[i * 4 + k] = 0;
          skinWeight[i * 4 + k] = 0;
        }
      }
      if (bind.stiffness > 0 && best >= 0) {
        // Blend toward a rigid binding on the nearest bone.
        for (let k = 0; k < 4; k++) {
          const rigid = skinIndex[i * 4 + k] === best ? 1 : 0;
          skinWeight[i * 4 + k] = THREE.MathUtils.lerp(skinWeight[i * 4 + k], rigid, bind.stiffness);
        }
      }
    }

    const groups: Group[] = [];
    const slots: number[] = [];
    this.index.length = 0;
    for (let s = 0; s < SLOT_COUNT; s++) {
      const list = this.slotIndex[s];
      if (list.length === 0) continue;
      groups.push({ start: this.index.length, count: list.length, slot: s });
      for (let i = 0; i < list.length; i++) this.index.push(list[i]);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));

    for (let i = 0; i < groups.length; i++) {
      g.addGroup(groups[i].start, groups[i].count, i);
      slots.push(groups[i].slot);
    }

    g.computeBoundingBox();
    g.computeBoundingSphere();
    // Animation takes vertices well outside the bind pose; pad the sphere so a
    // sprinting or prone character never pops out of the frustum.
    if (g.boundingSphere) g.boundingSphere.radius *= 1.6;
    return { geometry: g, slots };
  }
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : ((c + 0.055) / 1.055) ** 2.4;
}

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 1e-9 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
}
