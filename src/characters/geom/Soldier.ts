/**
 * The soldier itself: every piece of body and kit, emitted into a
 * `SkinMeshBuilder` as layered geometry welded into one skin.
 *
 * The build order matters — body first, uniform over it, load-bearing kit over
 * that, hard armour last — because each layer reads the layer beneath through
 * `profileAt()`, the interpolated torso cross-section, and sits a few
 * millimetres proud of it. That is what makes a plate carrier look strapped on
 * rather than modelled in.
 *
 * Nothing here is random in the uncontrolled sense: every decision comes from
 * `Appearance`, which came from the character's seed.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { BoneName } from '../types';
import { BONE_INDEX, boneSegments, type RigInstance } from '../Rig';
import type { Appearance } from '../Appearance';
import { BIND, SLOT, SkinMeshBuilder, superPoint, type Ring } from './Builder';

/* ------------------------------------------------------------------- noise */

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(Math.round(x * 8192) ^ Math.imul(Math.round(y * 8192), 374761393), 668265263);
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(seed | 1, 1274126177), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, seed: number, oct = 3): number {
  let f = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    f += vnoise(x * freq, y * freq, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5; freq *= 2.07;
  }
  return f / norm;
}

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ---------------------------------------------------------------- profile */

interface Section { y: number; rx: number; rz: number; e: number; }

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------- art */

export interface SoldierGeometry {
  geometry: THREE.BufferGeometry;
  /** Material slot for each geometry group, in group order. */
  slots: number[];
  triangles: number;
}

class SoldierArt {
  private b: SkinMeshBuilder;
  private rand: Rand;
  private s: number;          // global height scale
  private bulk: number;
  private sections: Section[] = [];
  private hs: number;         // head scale

  /* cached joint positions */
  private hipY: number; private spineY: number; private chestY: number;
  private neckY: number; private headY: number; private shoulderY: number;

  constructor(
    private rig: RigInstance,
    private app: Appearance,
    builder: SkinMeshBuilder,
    private lod: number,
  ) {
    this.b = builder;
    this.rand = new Rand(app.seed ^ 0x5eed);
    this.s = app.proportions.height;
    this.bulk = app.bulk;
    this.hs = app.proportions.head * this.s;

    this.hipY = this.P('hips').y;
    this.spineY = this.P('spine').y;
    this.chestY = this.P('chest').y;
    this.neckY = this.P('neck').y;
    this.headY = this.P('head').y;
    this.shoulderY = this.P('upperArmL').y;

    this.buildSections();
  }

  private P(name: BoneName): THREE.Vector3 { return this.rig.bindPos[BONE_INDEX[name]]; }

  private get detail(): boolean { return this.lod === 0; }
  private get mid(): boolean { return this.lod <= 1; }

  /* ------------------------------------------------------- torso profile */

  private buildSections(): void {
    const s = this.s, k = this.bulk * this.s;
    const shoulderX = Math.abs(this.P('upperArmL').x);
    const cd = this.app.chestDepth;
    this.sections = [
      { y: this.hipY - 0.135 * s, rx: 0.140 * k, rz: 0.118 * k, e: 2.4 },
      { y: this.hipY - 0.050 * s, rx: 0.164 * k, rz: 0.130 * k, e: 2.6 },
      { y: this.hipY + 0.045 * s, rx: 0.150 * k, rz: 0.114 * k, e: 2.8 },
      { y: this.spineY + 0.020 * s, rx: 0.149 * k, rz: 0.114 * k * cd, e: 2.9 },
      { y: this.spineY + 0.105 * s, rx: 0.163 * k, rz: 0.123 * k * cd, e: 3.0 },
      { y: this.chestY, rx: 0.182 * k, rz: 0.133 * k * cd, e: 3.0 },
      { y: this.chestY + 0.080 * s, rx: 0.194 * k, rz: 0.130 * k * cd, e: 3.1 },
      // Deltoid shelf: the widest point of a man in kit is a little *below* the
      // shoulder joint, and the trapezius ramps in above it. Cutting straight
      // from the chest to a narrow neck is what gives procedural characters
      // that dropped-shoulder, coat-hanger look.
      { y: this.shoulderY - 0.012 * s, rx: shoulderX * 1.07, rz: 0.124 * k, e: 3.0 },
      { y: this.shoulderY + 0.036 * s, rx: shoulderX * 0.94, rz: 0.113 * k, e: 2.9 },
      { y: this.shoulderY + 0.074 * s, rx: 0.128 * k, rz: 0.099 * k, e: 2.7 },
      { y: this.neckY + 0.050 * s, rx: 0.086 * k, rz: 0.082 * k, e: 2.5 },
    ];
  }

  /** Interpolated torso cross-section at height `y`. Gear placement uses this. */
  private profileAt(y: number, out: Section): Section {
    const list = this.sections;
    if (y <= list[0].y) { Object.assign(out, list[0]); out.y = y; return out; }
    const last = list[list.length - 1];
    if (y >= last.y) { Object.assign(out, last); out.y = y; return out; }
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (y >= a.y && y <= b.y) {
        const t = smooth(a.y, b.y, y);
        out.y = y;
        out.rx = THREE.MathUtils.lerp(a.rx, b.rx, t);
        out.rz = THREE.MathUtils.lerp(a.rz, b.rz, t);
        out.e = THREE.MathUtils.lerp(a.e, b.e, t);
        return out;
      }
    }
    Object.assign(out, last);
    return out;
  }

  /** Point on the torso surface at height `y`, angle `phi` measured from +Z. */
  private torsoPoint(y: number, phi: number, outward: number, out: THREE.Vector3): THREE.Vector3 {
    const sec = this.profileAt(y, _sec);
    const theta = Math.PI / 2 - phi;   // superPoint: cos→x, sin→z
    superPoint(theta, sec.rx + outward, sec.rz + outward, sec.e, _p2);
    out.set(_p2.x, y, _p2.y);
    return out;
  }

  /* ------------------------------------------------------------- build */

  build(): void {
    this.legs();
    this.boots();
    this.torso();
    this.neck();
    this.arms();
    this.hands();
    this.head();
    this.headGear();
    this.eyeGear();
    this.comms();
    this.carrier();
    this.belt();
    this.backKit();
    if (this.mid) this.pads();
  }

  /* --------------------------------------------------------------- legs */

  private legs(): void {
    for (const side of [1, -1] as const) {
      this.leg(side);
    }
  }

  private leg(side: 1 | -1): void {
    const b = this.b;
    const L = side > 0;
    const hip = this.P(L ? 'upperLegL' : 'upperLegR');
    const knee = this.P(L ? 'lowerLegL' : 'lowerLegR');
    const ankle = this.P(L ? 'footL' : 'footR');
    const k = this.bulk * this.s;
    const s = this.s;

    const lerpXZ = (y: number, out: THREE.Vector2): THREE.Vector2 => {
      if (y >= knee.y) {
        const t = THREE.MathUtils.clamp((y - knee.y) / (hip.y - knee.y), 0, 1.6);
        out.set(THREE.MathUtils.lerp(knee.x, hip.x, t), THREE.MathUtils.lerp(knee.z, hip.z, t));
      } else {
        const t = THREE.MathUtils.clamp((y - ankle.y) / (knee.y - ankle.y), -0.6, 1);
        out.set(THREE.MathUtils.lerp(ankle.x, knee.x, t), THREE.MathUtils.lerp(ankle.z, knee.z, t));
      }
      return out;
    };

    const bootTop = ankle.y + 0.155 * s;
    const ctrl: [number, number][] = [
      [hip.y + 0.075 * s, 0.086],
      [hip.y - 0.010 * s, 0.101],
      [THREE.MathUtils.lerp(hip.y, knee.y, 0.35), 0.094],
      [THREE.MathUtils.lerp(hip.y, knee.y, 0.72), 0.082],
      [knee.y + 0.025 * s, 0.075],
      [knee.y - 0.035 * s, 0.073],
      [THREE.MathUtils.lerp(knee.y, ankle.y, 0.26), 0.079],
      [THREE.MathUtils.lerp(knee.y, ankle.y, 0.56), 0.064],
      [bootTop + 0.020 * s, 0.056],
      [bootTop - 0.010 * s, 0.052],
    ];

    const rings: Ring[] = [];
    const xz = new THREE.Vector2();
    for (const [y, r] of ctrl) {
      lerpXZ(y, xz);
      // Blousing: trousers gather and flare just above the boot cuff.
      const blouse = 1 + 0.26 * Math.exp(-(((y - (bootTop + 0.03 * s)) / (0.05 * s)) ** 2));
      const rr = r * k * blouse;
      rings.push({ y, x: xz.x, z: xz.y, rx: rr * 0.98, rz: rr * 1.06, e: 2.3 });
    }

    const seed = this.app.seed + (L ? 11 : 23);
    const warp = (p: THREE.Vector3, ring: number, _sideIdx: number, u: number): void => {
      const n = fbm(u * 6.2, p.y * 9, seed, 3) - 0.5;
      const fold = fbm(u * 2.4, p.y * 26, seed + 7, 2) - 0.5;
      const amt = (0.006 + 0.010 * smooth(0.2, 0.9, ring / rings.length)) * this.s;
      const push = n * amt + fold * 0.005 * this.s;
      const len = Math.hypot(p.x - (rings[ring].x ?? 0), p.z - (rings[ring].z ?? 0)) || 1;
      p.x += ((p.x - (rings[ring].x ?? 0)) / len) * push;
      p.z += ((p.z - (rings[ring].z ?? 0)) / len) * push;
    };

    b.slot(SLOT.CLOTH).color(this.app.uniformTint).bind(L ? BIND.legL : BIND.legR);
    b.tube(rings, this.lod === 0 ? 14 : this.lod === 1 ? 10 : 7, { capStart: false, capEnd: false, warp, v0: L ? 0.17 : 0.93 });

    // Knee pad.
    if (this.app.kneePads && this.app.kneePadSide !== -side && this.mid) {
      b.slot(SLOT.HARD).color(this.app.hardTint, 0.92).bind(L ? BIND.kneeL : BIND.kneeR);
      const cx = THREE.MathUtils.lerp(knee.x, ankle.x, -0.02);
      const top = knee.y + 0.085 * s, bot = knee.y - 0.095 * s;
      b.patchSize(0.26, 0.20);
      b.solidPatch(this.detail ? 8 : 5, this.detail ? 5 : 3, (u, v, out) => {
        const y = THREE.MathUtils.lerp(top, bot, v);
        const phi = THREE.MathUtils.lerp(-72 * DEG, 72 * DEG, u);
        const t = THREE.MathUtils.clamp((y - ankle.y) / (knee.y - ankle.y), 0, 1.4);
        const r = (0.082 + 0.012 * Math.sin(v * Math.PI)) * k;
        out.set(
          cx + Math.sin(phi) * r * 0.95,
          y,
          THREE.MathUtils.lerp(ankle.z, knee.z, t) + Math.cos(phi) * r * 1.02,
        );
      }, 0.016 * s);
    }

    // Thigh pouch / holster on the strong side.
    if (this.app.holster && side === -1 && this.mid) {
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.9).bind(L ? BIND.legL : BIND.legR);
      const y = THREE.MathUtils.lerp(hip.y, knee.y, 0.42);
      lerpXZ(y, xz);
      _v.set(xz.x - 0.085 * k, y, xz.y + 0.010);
      b.roundedBox(_v, _sz.set(0.070 * s, 0.180 * s, 0.115 * s), 0.020 * s, 2);
      b.slot(SLOT.HARD).color(this.app.hardTint, 0.85);
      _v.set(xz.x - 0.088 * k, y - 0.012 * s, xz.y + 0.010);
      b.roundedBox(_v, _sz.set(0.048 * s, 0.135 * s, 0.075 * s), 0.016 * s, 2);
      // Retention strap.
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.75);
      b.ribbon([
        new THREE.Vector3(xz.x - 0.062 * k, hip.y - 0.02 * s, xz.y),
        new THREE.Vector3(xz.x - 0.088 * k, y + 0.07 * s, xz.y),
      ], 0.030 * s, 0.007 * s, _wz);
    }
  }

  /* -------------------------------------------------------------- boots */

  private boots(): void {
    const b = this.b;
    const s = this.s, k = this.bulk * this.s;
    for (const side of [1, -1] as const) {
      const L = side > 0;
      const ankle = this.P(L ? 'footL' : 'footR');
      const toe = this.P(L ? 'toeL' : 'toeR');
      const bind = L ? BIND.footL : BIND.footR;

      // Boot shaft.
      b.slot(SLOT.HARD).color(this.app.bootTint).bind(L ? BIND.legL : BIND.legR);
      const shaft: Ring[] = [
        { y: ankle.y + 0.165 * s, x: ankle.x, z: ankle.z + 0.004, rx: 0.058 * k, rz: 0.060 * k, e: 2.3 },
        { y: ankle.y + 0.090 * s, x: ankle.x, z: ankle.z + 0.002, rx: 0.055 * k, rz: 0.062 * k, e: 2.3 },
        { y: ankle.y + 0.030 * s, x: ankle.x, z: ankle.z + 0.006, rx: 0.056 * k, rz: 0.068 * k, e: 2.2 },
      ];
      b.tube(shaft, this.lod === 0 ? 12 : 8, {});

      // Foot: upper, sole and heel.
      b.bind(bind);
      const footZ = ankle.z + 0.055 * s;
      _v.set(ankle.x, ankle.y - 0.006 * s, footZ);
      b.roundedBox(_v, _sz.set(0.106 * k, 0.092 * s, 0.268 * s), 0.030 * s, this.detail ? 3 : 2);

      b.color(this.app.bootTint, 0.62);
      _v.set(ankle.x, ankle.y - 0.052 * s, footZ - 0.004 * s);
      b.roundedBox(_v, _sz.set(0.114 * k, 0.034 * s, 0.286 * s), 0.014 * s, 2);

      if (this.detail) {
        // Toe cap and lace panel break the silhouette up close.
        b.color(this.app.bootTint, 0.8);
        _v.set(ankle.x, ankle.y - 0.020 * s, footZ + 0.098 * s);
        b.roundedBox(_v, _sz.set(0.098 * k, 0.062 * s, 0.070 * s), 0.024 * s, 2);
        b.slot(SLOT.GEAR).color(this.app.bootTint, 1.25).bind(bind);
        _v.set(ankle.x, ankle.y + 0.030 * s, footZ - 0.052 * s);
        b.roundedBox(_v, _sz.set(0.050 * k, 0.050 * s, 0.090 * s), 0.012 * s, 1);
      }
    }
  }

  /* -------------------------------------------------------------- torso */

  private torso(): void {
    const b = this.b;
    const sides = this.lod === 0 ? 24 : this.lod === 1 ? 14 : 8;
    const steps = this.lod === 0 ? 22 : this.lod === 1 ? 13 : 7;
    const y0 = this.sections[0].y;
    const y1 = this.sections[this.sections.length - 1].y;
    const rings: Ring[] = [];
    for (let i = 0; i <= steps; i++) {
      const y = THREE.MathUtils.lerp(y0, y1, i / steps);
      const sec = this.profileAt(y, _sec);
      rings.push({ y, rx: sec.rx, rz: sec.rz, e: sec.e, bulgeZ: 0 });
    }

    const seed = this.app.seed + 3;
    const warp = (p: THREE.Vector3, ring: number, _si: number, u: number): void => {
      const n = fbm(u * 5.0, p.y * 8, seed, 3) - 0.5;
      const crease = (fbm(u * 1.6, p.y * 30, seed + 5, 2) - 0.5);
      // Fabric gathers at the waist and under the arms, not over the chest.
      const gather = 0.55 + 0.45 * Math.sin(THREE.MathUtils.clamp((p.y - y0) / (y1 - y0), 0, 1) * Math.PI * 2);
      const push = (n * 0.009 + crease * 0.005) * gather * this.s;
      const len = Math.hypot(p.x, p.z) || 1;
      p.x += (p.x / len) * push;
      p.z += (p.z / len) * push;
      void ring;
    };

    b.slot(SLOT.CLOTH).color(this.app.uniformTint).bind(BIND.torso);
    b.tube(rings, sides, { capStart: true, capEnd: false, warp });

    // Stand-up collar. A combat shirt's collar is the only thing between the
    // shoulder line and the head, and without it the neck reads as a pipe
    // pushed into a bag.
    if (this.mid) {
      const nr = 0.052 * this.s * (0.94 + 0.14 * this.bulk);
      const y0 = this.neckY - 0.020 * this.s;
      b.slot(SLOT.CLOTH).color(this.app.uniformTint, 0.94).bind(BIND.neck);
      b.tube([
        { y: y0, rx: nr * 1.62, rz: nr * 1.58, e: 2.6 },
        { y: y0 + 0.030 * this.s, rx: nr * 1.30, rz: nr * 1.28, e: 2.5 },
        { y: y0 + 0.072 * this.s, rx: nr * 1.20, rz: nr * 1.20, e: 2.5 },
        { y: y0 + 0.086 * this.s, rx: nr * 1.24, rz: nr * 1.24, e: 2.5 },
      ], this.lod === 0 ? 14 : 9, {});
    }
  }

  private neck(): void {
    const b = this.b;
    const covered = this.app.faceGear === 'balaclava' || this.app.faceGear === 'shemagh';
    const r = 0.0455 * this.s * (0.92 + 0.16 * this.bulk);
    b.slot(covered ? SLOT.GEAR : SLOT.SKIN)
      .color(covered ? this.app.hardTint : this.app.skinTint, covered ? 1.45 : 0.94)
      .bind(BIND.neck);
    b.tube([
      { y: this.neckY - 0.055 * this.s, rx: r * 1.25, rz: r * 1.2, e: 2.6 },
      { y: this.neckY + 0.015 * this.s, rx: r * 1.02, rz: r, e: 2.4 },
      { y: this.headY + 0.010 * this.s, rx: r * 0.96, rz: r * 0.94, e: 2.4 },
      { y: this.headY + 0.050 * this.s, rx: r * 1.0, rz: r * 1.0, e: 2.4 },
    ], this.lod === 0 ? 12 : 8, {});
  }

  /* --------------------------------------------------------------- arms */

  private arms(): void {
    for (const side of [1, -1] as const) this.arm(side);
  }

  private arm(side: 1 | -1): void {
    const b = this.b;
    const L = side > 0;
    const sh = this.P(L ? 'upperArmL' : 'upperArmR');
    const el = this.P(L ? 'lowerArmL' : 'lowerArmR');
    const wr = this.P(L ? 'handL' : 'handR');
    const k = this.bulk * this.s;
    const s = this.s;
    const bind = L ? BIND.armL : BIND.armR;

    const at = (y: number, out: THREE.Vector2): THREE.Vector2 => {
      if (y >= el.y) {
        const t = THREE.MathUtils.clamp((y - el.y) / (sh.y - el.y), 0, 1.5);
        out.set(THREE.MathUtils.lerp(el.x, sh.x, t), THREE.MathUtils.lerp(el.z, sh.z, t));
      } else {
        const t = THREE.MathUtils.clamp((y - wr.y) / (el.y - wr.y), -0.5, 1);
        out.set(THREE.MathUtils.lerp(wr.x, el.x, t), THREE.MathUtils.lerp(wr.z, el.z, t));
      }
      return out;
    };

    // Deltoid mass at the top, a slight bicep swell, a narrow elbow, a forearm
    // that flares back out below it and a wrist that is genuinely thin.
    const ctrl: [number, number][] = [
      [sh.y + 0.066 * s, 0.052],
      [sh.y + 0.030 * s, 0.068],
      [sh.y - 0.014 * s, 0.072],
      [THREE.MathUtils.lerp(sh.y, el.y, 0.35), 0.061],
      [THREE.MathUtils.lerp(sh.y, el.y, 0.72), 0.052],
      [el.y + 0.010 * s, 0.049],
      [THREE.MathUtils.lerp(el.y, wr.y, 0.22), 0.053],
      [THREE.MathUtils.lerp(el.y, wr.y, 0.58), 0.043],
      [wr.y + 0.020 * s, 0.034],
      [wr.y - 0.006 * s, 0.032],
    ];

    const sleeveEnd = this.app.sleeves === 'long'
      ? wr.y + 0.012 * s
      : this.app.sleeves === 'rolled'
        ? el.y - 0.055 * s
        : THREE.MathUtils.lerp(sh.y, el.y, 0.45);

    const xz = new THREE.Vector2();
    const mkRing = (y: number, r: number, inflate: number): Ring => {
      at(y, xz);
      return { y, x: xz.x, z: xz.y, rx: r * k * inflate * 0.98, rz: r * k * inflate * 1.05, e: 2.2 };
    };

    // Sleeve.
    const seed = this.app.seed + (L ? 41 : 53);
    const cloth: Ring[] = [];
    for (const [y, r] of ctrl) {
      if (y < sleeveEnd - 0.001) continue;
      const cuff = 1 + 0.13 * Math.exp(-(((y - (sleeveEnd + 0.02 * s)) / (0.035 * s)) ** 2));
      cloth.push(mkRing(y, r, 1.11 * cuff));
    }
    cloth.push(mkRing(sleeveEnd, ctrlRadius(ctrl, sleeveEnd) * 1.0, 1.14));
    cloth.sort((a, c) => c.y - a.y);
    b.slot(SLOT.CLOTH).color(this.app.uniformTint, 1.02).bind(bind);
    b.tube(cloth, this.lod === 0 ? 12 : this.lod === 1 ? 9 : 6, {
      capStart: true,
      v0: L ? 0.62 : 1.31,
      warp: (p, _r, _si, u) => {
        const n = fbm(u * 5, p.y * 12, seed, 2) - 0.5;
        const len = Math.hypot(p.x - (cloth[_r].x ?? 0), p.z - (cloth[_r].z ?? 0)) || 1;
        p.x += ((p.x - (cloth[_r].x ?? 0)) / len) * n * 0.008 * s;
        p.z += ((p.z - (cloth[_r].z ?? 0)) / len) * n * 0.008 * s;
      },
    });

    // Bare forearm / under-sleeve.
    if (sleeveEnd > wr.y + 0.02 * s) {
      const skin: Ring[] = [mkRing(sleeveEnd + 0.01 * s, ctrlRadius(ctrl, sleeveEnd) * 0.99, 1)];
      for (const [y, r] of ctrl) if (y < sleeveEnd) skin.push(mkRing(y, r, 1));
      b.slot(SLOT.SKIN).color(this.app.skinTint).bind(bind);
      b.tube(skin, this.lod === 0 ? 10 : 7, {});
    }

    // Deltoid protection. Only heavy rigs and juggernauts wear a brassard; on a
    // normal plate carrier a full band around the arm reads as a pale cuff
    // clamped onto the shoulder, which was the single most artificial thing on
    // the model. Everyone else just gets the yoke strap lying on the trapezius.
    const heavyRig = this.app.carrier === 'heavy';
    if (this.mid && heavyRig) {
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.90).bind(L ? BIND.shoulderL : BIND.shoulderR);
      const padRings: Ring[] = [];
      const padYs = [sh.y + 0.058 * s, sh.y + 0.030 * s, sh.y - 0.060 * s, sh.y - 0.092 * s];
      for (let i = 0; i < padYs.length; i++) {
        const y = padYs[i];
        at(y, xz);
        const inflate = i === 0 || i === padYs.length - 1 ? 1.01 : 1.13;
        const r = ctrlRadius(ctrl, y) * k * inflate;
        padRings.push({ y, x: xz.x, z: xz.y, rx: r * 0.99, rz: r * 1.06, e: 2.2 });
      }
      b.tube(padRings, this.lod === 0 ? 12 : 8, {});
    }

    // Rank / unit patch.
    if (this.detail && this.app.patch && side === this.app.shoulderPatchSide) {
      b.slot(SLOT.GEAR).color(this.app.accentTint).bind(bind);
      const y = sh.y - 0.045 * s;
      at(y, xz);
      const r = ctrlRadius(ctrl, y) * k * 1.14;
      b.patchSize(0.07, 0.05);
      b.patch(3, 2, (u, v, out) => {
        const phi = THREE.MathUtils.lerp(-30 * DEG, 30 * DEG, u) + side * 78 * DEG;
        const yy = THREE.MathUtils.lerp(y + 0.030 * s, y - 0.030 * s, v);
        out.set(xz.x + Math.sin(phi) * r * 1.02, yy, xz.y + Math.cos(phi) * r * 1.02);
      }, side < 0);
    }
  }

  private hands(): void {
    const b = this.b;
    const s = this.s;
    for (const side of [1, -1] as const) {
      const L = side > 0;
      const wr = this.P(L ? 'handL' : 'handR');
      const el = this.P(L ? 'lowerArmL' : 'lowerArmR');
      const dir = _v.copy(wr).sub(el).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);

      b.slot(this.app.gloves ? SLOT.HARD : SLOT.SKIN)
        .color(this.app.gloves ? this.app.gloveTint : this.app.skinTint)
        .bind(L ? BIND.handL : BIND.handR);

      _v2.copy(wr).addScaledVector(dir, 0.058 * s);
      b.roundedBox(_v2, _sz.set(0.058 * s, 0.108 * s, 0.088 * s), 0.026 * s, this.detail ? 3 : 2, q);

      if (this.detail) {
        // Finger block: four fingers curled round the grip, split by two
        // grooves. Without it the hand is a rounded brick at every range.
        b.color(this.app.gloves ? this.app.gloveTint : this.app.skinTint, 0.94);
        for (let f = 0; f < 2; f++) {
          _v2.copy(wr).addScaledVector(dir, (0.036 + f * 0.046) * s);
          _v2.z += 0.036 * s;
          b.roundedBox(_v2, _sz.set(0.052 * s, 0.040 * s, 0.030 * s), 0.013 * s, 2, q);
        }
        b.color(this.app.gloves ? this.app.gloveTint : this.app.skinTint);
      }
      if (this.mid) {
        // Thumb, wrapped over the top of the fist.
        _v2.copy(wr).addScaledVector(dir, 0.045 * s);
        _v2.x += side * 0.018 * s;
        _v2.z += 0.030 * s;
        const t1 = _v2.clone();
        const t2 = _v2.clone().addScaledVector(dir, 0.052 * s);
        t2.z += 0.012 * s;
        b.cylinder(t1, t2, 0.019 * s, 0.016 * s, this.detail ? 8 : 6, true);
      }
      if (this.detail && this.app.gloves) {
        // Knuckle guard.
        b.color(this.app.gloveTint, 0.7);
        _v2.copy(wr).addScaledVector(dir, 0.086 * s);
        _v2.z += 0.030 * s;
        b.roundedBox(_v2, _sz.set(0.050 * s, 0.052 * s, 0.024 * s), 0.010 * s, 2, q);
      }
    }
  }

  /* --------------------------------------------------------------- head */

  private head(): void {
    const b = this.b;
    const hs = this.hs;
    const centre = new THREE.Vector3(0, this.headY + 0.080 * hs, 0.006 * hs);
    const radius = new THREE.Vector3(0.0885 * hs, 0.113 * hs, 0.108 * hs);
    const covered = this.app.faceGear === 'balaclava' || this.app.faceGear === 'respirator';
    const segU = this.lod === 0 ? 22 : this.lod === 1 ? 14 : 8;
    const segV = this.lod === 0 ? 18 : this.lod === 1 ? 11 : 6;

    // Skull shaping: brow, nose, cheek, jaw, chin, occiput.
    const shape = (dir: THREE.Vector3, _u: number, _v: number, out: THREE.Vector3): void => {
      const x = dir.x, y = dir.y, z = dir.z;
      // Narrow the jaw and the crown.
      const low = smooth(-0.10, -0.80, y);
      out.x *= 1 - low * 0.16;
      out.z *= 1 - low * 0.04;
      const top = smooth(0.45, 1.0, y);
      out.x *= 1 - top * 0.10;
      out.z *= 1 - top * 0.08;
      // Flatten the face plane, round the back of the skull.
      const front = smooth(0.2, 1.0, z);
      out.z -= front * 0.010 * hs;
      out.z -= smooth(-0.3, -1.0, z) * -0.008 * hs;
      // Brow ridge.
      const brow = smooth(0.55, 0.95, z) * Math.exp(-(((y - 0.30) / 0.16) ** 2)) * (1 - smooth(0.5, 0.85, Math.abs(x)));
      out.z += brow * 0.015 * hs;
      out.y += brow * 0.002 * hs;
      // Eye sockets.
      const socket = smooth(0.45, 0.9, z) * Math.exp(-(((y - 0.14) / 0.11) ** 2)) * Math.exp(-(((Math.abs(x) - 0.34) / 0.20) ** 2));
      out.z -= socket * 0.017 * hs;
      // Nose.
      const nose = Math.exp(-(((y - 0.02) / 0.19) ** 2)) * Math.exp(-((x / 0.16) ** 2)) * smooth(0.45, 0.95, z);
      out.z += nose * 0.050 * hs;
      out.y -= nose * 0.004 * hs;
      // Cheekbone.
      const cheek = Math.exp(-(((y + 0.06) / 0.18) ** 2)) * Math.exp(-(((Math.abs(x) - 0.62) / 0.24) ** 2)) * smooth(0.0, 0.7, z);
      out.x += Math.sign(x) * cheek * 0.008 * hs;
      out.z += cheek * 0.006 * hs;
      // Chin and jaw line.
      const chin = Math.exp(-(((y + 0.72) / 0.20) ** 2)) * Math.exp(-((x / 0.30) ** 2)) * smooth(0.1, 0.7, z);
      out.z += chin * 0.026 * hs;
      out.y -= chin * 0.012 * hs;
      const jaw = Math.exp(-(((y + 0.52) / 0.22) ** 2)) * smooth(-0.2, 0.6, z);
      out.x += Math.sign(x) * jaw * 0.014 * hs;
      // Occiput.
      out.z -= smooth(-0.55, -1.0, z) * 0.010 * hs;
    };

    // With a balaclava the shell is cloth with an eye port; the skin shows
    // through from a slightly smaller inner sphere.
    const eyePort = (u: number, v: number): boolean => {
      // u: 0 at +Z front going towards +X. v: 0 top → 1 bottom.
      const ang = (u - 0.0) * Math.PI * 2;
      const fz = Math.cos(ang);
      const fx = Math.sin(ang);
      const yy = Math.cos(v * Math.PI);
      if (fz < 0.35) return false;
      const inEye = Math.abs(fx) < 0.52 && yy > -0.02 && yy < 0.34;
      const inNose = Math.abs(fx) < 0.22 && yy > -0.26 && yy <= -0.02;
      return this.app.faceGear === 'respirator' ? false : (inEye || inNose);
    };

    if (covered) {
      // A balaclava is flat knit, so it uses the plain-weave gear material —
      // stamping camo on a head-sized patch just makes the face one blob of
      // whatever colour that blob happened to be.
      b.slot(SLOT.GEAR).color(this.app.hardTint, 1.45).bind(BIND.head);
      b.sphere(centre, radius, segU, segV, shape, this.app.faceGear === 'balaclava' ? eyePort : undefined);
      // Skin underneath, only where the port shows.
      b.slot(SLOT.SKIN).color(this.app.skinTint).bind(BIND.head);
      const inner = radius.clone().multiplyScalar(0.975);
      b.sphere(centre, inner, Math.max(8, segU >> 1), Math.max(6, segV >> 1), shape,
        (u, v) => !eyePortWide(u, v));
    } else {
      b.slot(SLOT.SKIN).color(this.app.skinTint).bind(BIND.head);
      b.sphere(centre, radius, segU, segV, shape);
      // Cropped hair.
      if (this.app.headGear === 'none' || this.app.headGear === 'cap') {
        b.color(this.app.skinTint, 0.26);
        const hair = radius.clone().multiplyScalar(1.022);
        b.sphere(centre, hair, Math.max(10, segU >> 1), Math.max(8, segV >> 1), shape,
          (u, v) => {
            const ang = u * Math.PI * 2;
            const fz = Math.cos(ang);
            const yy = Math.cos(v * Math.PI);
            return yy < -0.35 || (fz > 0.55 && yy > 0.25 && yy < 0.72);
          });
      }
    }

    if (this.mid) {
      // Ears.
      b.slot(SLOT.SKIN).color(this.app.skinTint, 0.96).bind(BIND.head);
      for (const side of [1, -1] as const) {
        _v.set(side * radius.x * 0.94, centre.y + 0.004 * hs, centre.z - 0.020 * hs);
        b.sphere(_v, _sz.set(0.012 * hs, 0.032 * hs, 0.021 * hs), 7, 5);
      }
    }

    if (this.detail && this.app.eyeGear !== 'visor') {
      // Eyes — dark, deep in the socket. They do more for "alive" than anything
      // else on the head at close range.
      // Sclera is one of the brightest things on a human — near 0.5 albedo.
      // Tinted at 0.30 it disappeared into the socket shadow, which is why the
      // faces read as empty holes.
      b.slot(SLOT.SKIN).colorRGB(0.94, 0.92, 0.88).bind(BIND.head);
      for (const side of [1, -1] as const) {
        _v.set(side * 0.030 * hs, centre.y + 0.014 * hs, centre.z + radius.z * 0.855);
        b.sphere(_v, _sz.set(0.0125 * hs, 0.0105 * hs, 0.009 * hs), 9, 7);
        // Iris/pupil: a small dark disc set into the eyeball.
        b.colorRGB(0.16, 0.14, 0.12);
        _v.z += 0.005 * hs;
        b.sphere(_v, _sz.set(0.0058 * hs, 0.0058 * hs, 0.004 * hs), 8, 6);
        b.colorRGB(0.94, 0.92, 0.88);
      }
      // Brows: a dark ridge that gives the eyes somewhere to sit.
      b.color(this.app.skinTint, 0.34);
      for (const side of [1, -1] as const) {
        _v.set(side * 0.034 * hs, centre.y + 0.036 * hs, centre.z + radius.z * 0.86);
        b.sphere(_v, _sz.set(0.024 * hs, 0.0055 * hs, 0.007 * hs), 8, 5);
      }
    }

    if (this.app.faceGear === 'halfMask' || this.app.faceGear === 'respirator') this.faceMask(centre, radius);
    if (this.app.faceGear === 'shemagh') this.shemagh(centre, radius);
  }

  private faceMask(centre: THREE.Vector3, radius: THREE.Vector3): void {
    const b = this.b;
    const hs = this.hs;
    const resp = this.app.faceGear === 'respirator';
    // A shemagh or half-mask that renders at 2 % reflectance is not "black
    // cloth", it is a hole in the head. Real black knit sits nearer 4–5 %.
    b.slot(resp ? SLOT.HARD : SLOT.GEAR)
      .color(this.app.hardTint, resp ? 1.2 : 1.35)
      .bind(BIND.head);
    b.patchSize(0.16, 0.12);
    b.solidPatch(this.detail ? 9 : 5, this.detail ? 6 : 3, (u, v, out) => {
      const ang = THREE.MathUtils.lerp(-95 * DEG, 95 * DEG, u);
      const yy = THREE.MathUtils.lerp(resp ? 0.16 : 0.02, -0.92, v);
      const sr = Math.sqrt(Math.max(0, 1 - yy * yy));
      const rr = 1.045 + (resp ? 0.05 * Math.exp(-((ang / 0.9) ** 2)) * Math.exp(-(((yy + 0.35) / 0.4) ** 2)) : 0.012);
      out.set(
        Math.sin(ang) * sr * radius.x * rr,
        centre.y + yy * radius.y * (1 - 0.20 * smooth(-0.1, -0.9, yy)),
        centre.z + Math.cos(ang) * sr * radius.z * rr,
      );
    }, 0.008 * hs);

    if (resp && this.mid) {
      b.slot(SLOT.METAL).color(this.app.metalTint, 1.4).bind(BIND.head);
      for (const side of [1, -1] as const) {
        _v.set(side * 0.055 * hs, centre.y - 0.055 * hs, centre.z + radius.z * 0.86);
        _v2.copy(_v).add(new THREE.Vector3(side * 0.020 * hs, -0.010 * hs, 0.038 * hs));
        b.cylinder(_v, _v2, 0.030 * hs, 0.028 * hs, 10, true);
      }
    }
  }

  private shemagh(centre: THREE.Vector3, radius: THREE.Vector3): void {
    const b = this.b;
    b.slot(SLOT.GEAR).color(this.app.accentTint, 1.15).bind(BIND.headSoft);
    b.patchSize(0.30, 0.22);
    b.solidPatch(this.detail ? 12 : 7, this.detail ? 6 : 4, (u, v, out) => {
      const ang = u * Math.PI * 2;
      const yy = THREE.MathUtils.lerp(-0.12, -1.35, v);
      const sr = Math.sqrt(Math.max(0.04, 1 - Math.min(1, yy * yy)));
      const flare = 1.06 + 0.20 * smooth(-0.6, -1.3, yy);
      out.set(
        Math.sin(ang) * sr * radius.x * flare,
        centre.y + yy * radius.y * 0.92,
        Math.cos(ang) * sr * radius.z * flare,
      );
    }, 0.006 * this.hs);
  }

  /* ----------------------------------------------------------- head gear */

  private headGear(): void {
    const g = this.app.headGear;
    if (g === 'none') return;
    if (g === 'helmet' || g === 'helmetCover') this.helmet(g === 'helmetCover');
    else if (g === 'cap') this.cap(false);
    else if (g === 'boonie') this.cap(true);
    else if (g === 'beanie') this.beanie();
  }

  private helmetCentre(): THREE.Vector3 {
    return new THREE.Vector3(0, this.headY + 0.094 * this.hs, -0.004 * this.hs);
  }

  private helmet(cover: boolean): void {
    const b = this.b;
    const hs = this.hs;
    const c = this.helmetCentre();
    const R = new THREE.Vector3(0.116 * hs, 0.116 * hs, 0.124 * hs);
    const nu = this.lod === 0 ? 26 : this.lod === 1 ? 16 : 10;
    const nv = this.lod === 0 ? 8 : this.lod === 1 ? 5 : 3;

    // Rim polar angle, measured from the crown: lower at the back, cut away
    // over the ears, a touch lower over the brow.
    const rimTheta = (phi: number): number =>
      (89.5 - 15 * Math.cos(phi) + 1.5 * Math.cos(2 * phi)) * DEG;

    b.slot(cover ? SLOT.CLOTH : SLOT.HARD)
      .color(cover ? this.app.uniformTint : this.app.hardTint, cover ? 0.95 : 1)
      .bind(BIND.head);
    b.patchSize(0.42, 0.20);
    b.solidPatch(nu, nv, (u, v, out) => {
      const phi = u * Math.PI * 2;
      const th = rimTheta(phi) * (1 - v) ** 0.88;
      const st = Math.sin(th), ct = Math.cos(th);
      // Slight forward brim over the eyes.
      const brim = Math.max(0, Math.cos(phi)) * smooth(0.35, 0.0, v) * 0.045;
      out.set(
        Math.sin(phi) * st * R.x * (1 + brim * 0.2),
        c.y + ct * R.y,
        c.z + Math.cos(phi) * st * R.z * (1 + brim),
      );
    }, 0.012 * hs, true);

    if (!this.mid) return;

    // Side accessory rails, lying along the shell. Sunk inside it they used to
    // surface as two black tabs poking out of the helmet.
    b.slot(SLOT.METAL).color(this.app.metalTint, 1.1).bind(BIND.head);
    for (const side of [1, -1] as const) {
      _v.set(side * R.x * 1.00, c.y + R.y * 0.30, c.z + R.z * 0.36);
      _v2.set(side * R.x * 0.97, c.y + R.y * 0.14, c.z - R.z * 0.50);
      b.cylinder(_v, _v2, 0.011 * hs, 0.010 * hs, 8, true);
    }

    // NVG shroud on the forehead.
    b.slot(SLOT.METAL).color(this.app.metalTint, 0.9).bind(BIND.head);
    _v.set(0, c.y + R.y * 0.42, c.z + R.z * 0.86);
    b.roundedBox(_v, _sz.set(0.056 * hs, 0.040 * hs, 0.034 * hs), 0.008 * hs, 1);

    if (this.app.nvg) this.nvg(c, R);

    // Chin strap.
    b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.8).bind(BIND.headSoft);
    for (const side of [1, -1] as const) {
      b.ribbon([
        new THREE.Vector3(side * R.x * 0.80, c.y - R.y * 0.10, c.z - R.z * 0.02),
        new THREE.Vector3(side * R.x * 0.66, c.y - R.y * 0.66, c.z + R.z * 0.10),
        new THREE.Vector3(side * R.x * 0.22, c.y - R.y * 0.92, c.z + R.z * 0.26),
      ], 0.015 * hs, 0.005 * hs, _wz);
    }

    if (this.detail) {
      // Bungee retention cords across the shell — a very recognisable read.
      b.slot(SLOT.GEAR).color(this.app.hardTint, 0.6).bind(BIND.head);
      for (let i = 0; i < 2; i++) {
        const off = (i === 0 ? 0.30 : -0.16);
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 5; k++) {
          const t = k / 5;
          const phi = THREE.MathUtils.lerp(-70 * DEG, 70 * DEG, t) + Math.PI * (i === 0 ? 0 : 1);
          const th = rimTheta(phi) * 0.52;
          pts.push(new THREE.Vector3(
            Math.sin(phi) * Math.sin(th) * R.x * 1.02,
            c.y + Math.cos(th) * R.y * 1.02 + off * 0.02 * hs,
            c.z + Math.cos(phi) * Math.sin(th) * R.z * 1.02,
          ));
        }
        b.ribbon(pts, 0.009 * hs, 0.006 * hs, _wy);
      }
      // Rear counterweight pouch.
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.9).bind(BIND.head);
      _v.set(0, c.y + R.y * 0.18, c.z - R.z * 0.94);
      b.roundedBox(_v, _sz.set(0.090 * hs, 0.075 * hs, 0.045 * hs), 0.016 * hs, 2);
    }
  }

  private nvg(c: THREE.Vector3, R: THREE.Vector3): void {
    const b = this.b;
    const hs = this.hs;
    const down = this.app.nvgDown;
    b.slot(SLOT.METAL).color(this.app.metalTint, 0.95).bind(BIND.head);

    // Arm from the shroud.
    const armA = new THREE.Vector3(0, c.y + R.y * 0.42, c.z + R.z * 0.90);
    const armB = down
      ? new THREE.Vector3(0, c.y - R.y * 0.30, c.z + R.z * 1.02)
      : new THREE.Vector3(0, c.y + R.y * 0.92, c.z + R.z * 0.62);
    b.cylinder(armA, armB, 0.011 * hs, 0.010 * hs, 8, true);

    // Twin tubes.
    const body = down
      ? new THREE.Vector3(0, c.y - R.y * 0.34, c.z + R.z * 1.10)
      : new THREE.Vector3(0, c.y + R.y * 1.02, c.z + R.z * 0.50);
    const fwd = down ? new THREE.Vector3(0, -0.10, 1) : new THREE.Vector3(0, 0.55, 0.84);
    fwd.normalize();
    for (const side of [1, -1] as const) {
      _v.copy(body); _v.x = side * 0.026 * hs;
      _v2.copy(_v).addScaledVector(fwd, 0.070 * hs);
      b.cylinder(_v, _v2, 0.019 * hs, 0.021 * hs, 10, true);
    }
    // Bridge.
    _v.set(-0.026 * hs, body.y, body.z);
    _v2.set(0.026 * hs, body.y, body.z);
    b.cylinder(_v, _v2, 0.013 * hs, 0.013 * hs, 8, true);
  }

  private cap(boonie: boolean): void {
    const b = this.b;
    const hs = this.hs;
    const c = new THREE.Vector3(0, this.headY + 0.082 * hs, 0.002 * hs);
    const R = new THREE.Vector3(0.102 * hs, 0.100 * hs, 0.112 * hs);
    b.slot(SLOT.CLOTH).color(this.app.uniformTint, 0.9).bind(BIND.head);
    b.patchSize(0.34, 0.16);
    b.solidPatch(this.lod === 0 ? 20 : 12, this.lod === 0 ? 6 : 4, (u, v, out) => {
      const phi = u * Math.PI * 2;
      const th = (boonie ? 96 : 88) * DEG * (1 - v) ** 0.9;
      out.set(
        Math.sin(phi) * Math.sin(th) * R.x,
        c.y + Math.cos(th) * R.y,
        c.z + Math.cos(phi) * Math.sin(th) * R.z,
      );
    }, 0.008 * hs, true);

    // Brim.
    b.patchSize(0.28, 0.14);
    if (boonie) {
      b.solidPatch(this.lod === 0 ? 22 : 12, 3, (u, v, out) => {
        const phi = u * Math.PI * 2;
        const rr = THREE.MathUtils.lerp(1.0, 1.62, v);
        out.set(
          Math.sin(phi) * R.x * rr,
          c.y - 0.006 * hs - v * v * 0.030 * hs,
          c.z + Math.cos(phi) * R.z * rr,
        );
      }, 0.006 * hs, true);
    } else {
      b.solidPatch(10, 3, (u, v, out) => {
        const phi = THREE.MathUtils.lerp(-72 * DEG, 72 * DEG, u);
        const rr = THREE.MathUtils.lerp(0.98, 1.62, v);
        out.set(
          Math.sin(phi) * R.x * rr * 0.92,
          c.y - 0.012 * hs - v * 0.022 * hs,
          c.z + Math.cos(phi) * R.z * rr,
        );
      }, 0.006 * hs, true);
    }
  }

  private beanie(): void {
    const b = this.b;
    const hs = this.hs;
    const c = new THREE.Vector3(0, this.headY + 0.084 * hs, 0.002 * hs);
    const R = new THREE.Vector3(0.101 * hs, 0.112 * hs, 0.111 * hs);
    b.slot(SLOT.CLOTH).color(this.app.uniformTint, 0.75).bind(BIND.head);
    b.patchSize(0.32, 0.20);
    b.solidPatch(this.lod === 0 ? 20 : 12, this.lod === 0 ? 8 : 5, (u, v, out) => {
      const phi = u * Math.PI * 2;
      const th = 108 * DEG * (1 - v) ** 0.86;
      // Rolled brim at the bottom.
      const roll = 1 + 0.055 * Math.exp(-(((v - 0.04) / 0.09) ** 2));
      out.set(
        Math.sin(phi) * Math.sin(th) * R.x * roll,
        c.y + Math.cos(th) * R.y,
        c.z + Math.cos(phi) * Math.sin(th) * R.z * roll,
      );
    }, 0.010 * hs, true);
  }

  /* ------------------------------------------------------------ eye gear */

  private eyeGear(): void {
    const g = this.app.eyeGear;
    if (g === 'none') return;
    const b = this.b;
    const hs = this.hs;
    const helmeted = this.app.headGear === 'helmet' || this.app.headGear === 'helmetCover';
    const c = new THREE.Vector3(0, this.headY + 0.080 * hs, 0.006 * hs);
    const R = new THREE.Vector3(0.0885 * hs, 0.113 * hs, 0.108 * hs);
    const eyeY = c.y + 0.018 * hs;

    if (g === 'glasses' || g === 'goggles') {
      const wide = g === 'goggles';
      // Frame + lens as one curved shell across the eyes. Smoke grey, not
      // black: a lens takes its value from what it reflects, and an ink-black
      // F0 reflects nothing at all and reads as a missing face.
      b.slot(SLOT.METAL).colorRGB(0.60, 0.63, 0.68).bind(BIND.head);
      b.patchSize(0.20, 0.06);
      // Heights are fractions of the *skull* radius, not of the global scale.
      // Read as multiples of `hs` these spanned 10 cm — a welding shield across
      // the whole face, which is exactly how it rendered.
      b.solidPatch(this.lod === 0 ? 14 : 8, 3, (u, v, out) => {
        const ang = THREE.MathUtils.lerp(-88 * DEG, 88 * DEG, u);
        const yy = THREE.MathUtils.lerp(wide ? 0.30 : 0.24, wide ? -0.18 : -0.06, v);
        out.set(
          Math.sin(ang) * R.x * 1.045,
          eyeY + yy * R.y + Math.abs(Math.sin(ang)) * 0.10 * R.y,
          c.z + Math.cos(ang) * R.z * 1.045,
        );
      }, 0.006 * hs);

      // Rim: a soft frame the lens sits in.
      b.slot(SLOT.GEAR).color(this.app.hardTint, 1.1).bind(BIND.head);
      {
        const rim: THREE.Vector3[] = [];
        for (let i = 0; i <= 10; i++) {
          const ang = THREE.MathUtils.lerp(-92 * DEG, 92 * DEG, i / 10);
          rim.push(new THREE.Vector3(
            Math.sin(ang) * R.x * 1.05,
            eyeY + (wide ? 0.34 : 0.27) * R.y + Math.abs(Math.sin(ang)) * 0.10 * R.y,
            c.z + Math.cos(ang) * R.z * 1.05,
          ));
        }
        b.ribbon(rim, 0.020 * hs, 0.008 * hs, _wy);
      }

      if (wide) {
        // Foam gasket + strap.
        b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.7).bind(BIND.head);
        const pts: THREE.Vector3[] = [];
        // Over the helmet shell when one is worn, otherwise around the skull.
        const hc = this.helmetCentre();
        const sx = helmeted ? 0.120 * hs : R.x * 1.05;
        const sz = helmeted ? 0.128 * hs : R.z * 1.05;
        const sy = helmeted ? hc.y - 0.030 * hs : eyeY + 0.012 * hs;
        for (let i = 0; i <= 12; i++) {
          const phi = THREE.MathUtils.lerp(72 * DEG, 288 * DEG, i / 12);
          pts.push(new THREE.Vector3(
            Math.sin(phi) * sx,
            sy + (helmeted ? Math.sin((i / 12) * Math.PI) * 0.012 * hs : 0),
            (helmeted ? hc.z : c.z) + Math.cos(phi) * sz,
          ));
        }
        b.ribbon(pts, 0.030 * hs, 0.008 * hs, _wy);
      }
    } else if (g === 'visor') {
      b.slot(SLOT.METAL).colorRGB(0.52, 0.56, 0.62).bind(BIND.head);
      b.patchSize(0.24, 0.14);
      // Full-face shield: brow to jaw, in skull-radius units.
      b.solidPatch(this.lod === 0 ? 16 : 9, 5, (u, v, out) => {
        const ang = THREE.MathUtils.lerp(-92 * DEG, 92 * DEG, u);
        const yy = THREE.MathUtils.lerp(0.46, -0.92, v);
        const sr = Math.sqrt(Math.max(0.24, 1 - yy * yy * 0.55));
        out.set(
          Math.sin(ang) * R.x * 1.07 * sr,
          c.y + yy * R.y,
          c.z + Math.cos(ang) * R.z * 1.07 * sr,
        );
      }, 0.008 * hs);
    }
  }

  private comms(): void {
    if (!this.app.headset || !this.mid) return;
    const b = this.b;
    const hs = this.hs;
    const c = new THREE.Vector3(0, this.headY + 0.080 * hs, 0.004 * hs);
    const R = new THREE.Vector3(0.094 * hs, 0.113 * hs, 0.106 * hs);

    b.slot(SLOT.HARD).color(this.app.hardTint, 0.8).bind(BIND.head);
    for (const side of [1, -1] as const) {
      _v.set(side * R.x * 1.12, c.y - 0.006 * hs, c.z - 0.026 * hs);
      b.roundedBox(_v, _sz.set(0.030 * hs, 0.072 * hs, 0.058 * hs), 0.020 * hs, 2);
    }
    // Headband behind the head.
    b.slot(SLOT.GEAR).color(this.app.hardTint, 1.1).bind(BIND.head);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const phi = THREE.MathUtils.lerp(96 * DEG, 264 * DEG, i / 6);
      pts.push(new THREE.Vector3(
        Math.sin(phi) * R.x * 1.10,
        c.y - 0.020 * hs + Math.sin((i / 6) * Math.PI) * 0.014 * hs,
        c.z + Math.cos(phi) * R.z * 1.10,
      ));
    }
    b.ribbon(pts, 0.022 * hs, 0.008 * hs, _wy);

    if (this.detail) {
      // Boom mic.
      b.slot(SLOT.METAL).color(this.app.metalTint, 1.2).bind(BIND.head);
      const a = new THREE.Vector3(-R.x * 1.08, c.y - 0.020 * hs, c.z + 0.010 * hs);
      const m = new THREE.Vector3(-R.x * 0.72, c.y - 0.060 * hs, c.z + R.z * 0.86);
      b.cylinder(a, m, 0.005 * hs, 0.004 * hs, 5, true);
      b.roundedBox(m, _sz.set(0.016 * hs, 0.014 * hs, 0.020 * hs), 0.006 * hs, 1);
    }
  }

  /* ------------------------------------------------------------ carrier */

  private carrier(): void {
    const c = this.app.carrier;
    if (c === 'none') return;
    const b = this.b;
    const s = this.s;
    const heavy = c === 'heavy';
    const plate = c === 'plate' || heavy;

    const yTop = this.chestY + (heavy ? 0.085 : 0.070) * s;
    const yBot = this.spineY - (heavy ? 0.045 : 0.010) * s;
    // Stand-off of the plate's *outer* face from the body. A carrier is not
    // painted on: a plate, its spacer mesh and a cummerbund put the front face
    // 25–35 mm proud of the chest, and that thickness is a large part of what
    // makes an armoured silhouette read as armoured.
    const gap = (heavy ? 0.036 : plate ? 0.027 : 0.017) * s;
    const phiMax = (heavy ? 66 : plate ? 58 : 52) * DEG;
    const nu = this.lod === 0 ? 14 : this.lod === 1 ? 8 : 4;
    const nv = this.lod === 0 ? 8 : this.lod === 1 ? 4 : 2;
    const thick = (heavy ? 0.032 : plate ? 0.024 : 0.016) * s;

    /**
     * A plate is a curved shield, not a slab: the outline narrows at top and
     * bottom, and the stand-off from the body rolls away to nothing at the
     * border so the edge tucks under rather than reading as a cut-out board.
     */
    const face = (front: boolean) => (u: number, v: number, out: THREE.Vector3): void => {
      const y = THREE.MathUtils.lerp(yTop, yBot, v);
      const shrink = 1 - 0.26 * smooth(0.70, 1.0, 1 - v) - 0.16 * smooth(0.78, 1.0, v);
      const phi = THREE.MathUtils.lerp(-phiMax, phiMax, u) * shrink + (front ? 0 : Math.PI);
      const edge = Math.min(
        smooth(0, 0.16, u) * smooth(1, 0.84, u),
        smooth(0, 0.13, v) * smooth(1, 0.87, v),
      );
      this.torsoPoint(y, phi, gap * (0.25 + 0.75 * edge ** 0.4), out);
    };

    b.slot(SLOT.GEAR).color(this.app.webbingTint).bind(BIND.torsoRigid);
    b.patchSize(0.36, 0.34);
    b.solidPatch(nu, nv, face(true), thick);
    b.patchSize(0.36, 0.34);
    b.solidPatch(nu, nv, face(false), thick);

    // Shoulder straps: broad and flat, lying on the trapezius. Narrow ones read
    // as fins from the side; real yoke straps are ~65 mm of padded webbing.
    b.color(this.app.webbingTint, 1.06).bind(BIND.torso);
    for (const side of [1, -1] as const) {
      const pts: THREE.Vector3[] = [];
      const frontTop = new THREE.Vector3();
      this.torsoPoint(yTop - 0.015 * s, side * 20 * DEG, gap * 0.8, frontTop);
      const overA = new THREE.Vector3();
      this.torsoPoint(this.shoulderY + 0.040 * s, side * 40 * DEG, gap + 0.006 * s, overA);
      const backTop = new THREE.Vector3();
      this.torsoPoint(yTop - 0.05 * s, Math.PI - side * 20 * DEG, gap * 0.8, backTop);
      const mid = (a: THREE.Vector3, c: THREE.Vector3, t: number, ty: number): THREE.Vector3 =>
        new THREE.Vector3(
          THREE.MathUtils.lerp(a.x, c.x, t),
          THREE.MathUtils.lerp(a.y, c.y, ty),
          THREE.MathUtils.lerp(a.z, c.z, t),
        );
      pts.push(
        frontTop,
        mid(frontTop, overA, 0.32, 0.60),
        mid(frontTop, overA, 0.68, 0.92),
        overA,
        mid(backTop, overA, 0.68, 0.92),
        mid(backTop, overA, 0.32, 0.60),
        backTop,
      );
      b.ribbon(pts, 0.066 * s, 0.013 * s, _wx);
    }

    // Cummerbund.
    if (plate) {
      const cy0 = yBot + 0.075 * s, cy1 = yBot - 0.010 * s;
      b.color(this.app.webbingTint, 0.92);
      this.band(cy0, cy1, gap * 0.85, this.lod === 0 ? 20 : 12);
    }

    // PALS webbing: horizontal rows stitched across the plate. This is the
    // single most recognisable thing on a modern carrier — it is what turns the
    // front from a slab into kit, and it still reads at fifty metres because it
    // is a row of hard shadow lines rather than a texture.
    if (this.mid) {
      const rows = this.lod === 0 ? 4 : 3;
      for (let r = 0; r < rows; r++) {
        const y = THREE.MathUtils.lerp(this.chestY + 0.030 * s, yBot + 0.060 * s, (r + 0.5) / rows);
        for (const front of [true, false] as const) {
          const pts: THREE.Vector3[] = [];
          const steps = this.lod === 0 ? 7 : 5;
          for (let i = 0; i <= steps; i++) {
            const phi = THREE.MathUtils.lerp(-phiMax * 0.86, phiMax * 0.86, i / steps)
              + (front ? 0 : Math.PI);
            const p = new THREE.Vector3();
            this.torsoPoint(y, phi, gap + 0.005 * s, p);
            pts.push(p);
          }
          b.color(this.app.webbingTint, r % 2 === 0 ? 0.86 : 0.94);
          b.ribbon(pts, 0.030 * s, 0.008 * s, _wy);
        }
      }
    }

    // Magazine pouches across the front, standing proud of the plate with a
    // closing flap and a pull tab.
    const n = Math.max(0, this.app.magPouches);
    const pouchD = 0.058 * s;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const phi = THREE.MathUtils.lerp(-32 * DEG, 32 * DEG, t);
      // Chest height, on the face of the plate. They used to sit at spine
      // height, which is exactly where the cummerbund wraps — so every carrier
      // rendered with an empty front and a suspiciously lumpy waist.
      const y = THREE.MathUtils.lerp(this.chestY - 0.030 * s, this.chestY - 0.070 * s, Math.abs(t - 0.5) * 2);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), phi);
      // Sit the *back face* on the plate surface, then let the body stand out.
      this.torsoPoint(y, phi, gap + 0.004 * s, _v);
      _v.x += Math.sin(phi) * (pouchD * 0.5 - 0.008 * s);
      _v.z += Math.cos(phi) * (pouchD * 0.5 - 0.008 * s);
      b.color(this.app.webbingTint, 0.90 + 0.14 * hash2(i, 3, this.app.seed));
      b.roundedBox(_v, _sz.set(0.072 * s, 0.140 * s, pouchD), 0.014 * s, this.detail ? 2 : 1, q);
      if (this.detail) {
        // Flap folded over the top, hanging a little down the front.
        b.color(this.app.webbingTint, 0.78);
        _v2.copy(_v);
        _v2.y += 0.058 * s;
        _v2.x += Math.sin(phi) * 0.005 * s;
        _v2.z += Math.cos(phi) * 0.005 * s;
        b.roundedBox(_v2, _sz.set(0.078 * s, 0.044 * s, pouchD + 0.012 * s), 0.008 * s, 1, q);
        // Pull tab.
        b.color(this.app.webbingTint, 0.66);
        _v2.y -= 0.030 * s;
        _v2.x += Math.sin(phi) * (pouchD * 0.5 + 0.004 * s);
        _v2.z += Math.cos(phi) * (pouchD * 0.5 + 0.004 * s);
        b.roundedBox(_v2, _sz.set(0.024 * s, 0.030 * s, 0.006 * s), 0.003 * s, 1, q);
      }
    }

    // Side utility pouches, wrapped onto the cummerbund.
    if (this.mid) {
      for (const side of [1, -1] as const) {
        const ang = side * 84 * DEG;
        const y = this.spineY + 0.045 * s;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
        this.torsoPoint(y, ang, gap * 0.85, _v);
        _v.x += Math.sin(ang) * 0.026 * s;
        _v.z += Math.cos(ang) * 0.026 * s;
        b.color(this.app.webbingTint, 0.94);
        b.roundedBox(_v, _sz.set(0.058 * s, 0.108 * s, 0.066 * s), 0.014 * s, 2, q);
      }
    }

    // Admin pouch with an antenna, and a frag on the opposite strap.
    if (this.detail) {
      const aPhi = -52 * DEG;
      const aq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), aPhi);
      this.torsoPoint(this.chestY + 0.050 * s, aPhi, gap + 0.004 * s, _v);
      _v.x += Math.sin(aPhi) * 0.019 * s;
      _v.z += Math.cos(aPhi) * 0.019 * s;
      b.color(this.app.webbingTint, 1.0);
      b.roundedBox(_v, _sz.set(0.066 * s, 0.094 * s, 0.052 * s), 0.012 * s, 2, aq);
      b.slot(SLOT.METAL).color(this.app.metalTint, 1.15).bind(BIND.torsoRigid);
      _v.y += 0.062 * s;
      b.cylinder(_v, _v.clone().add(new THREE.Vector3(0.006 * s, 0.115 * s, -0.008 * s)), 0.004 * s, 0.003 * s, 5, true);

      // Frag: a body with a lever and a ring, not a floating dark egg.
      const gPhi = 48 * DEG;
      this.torsoPoint(this.chestY + 0.040 * s, gPhi, gap + 0.004 * s, _v);
      _v.x += Math.sin(gPhi) * 0.024 * s;
      _v.z += Math.cos(gPhi) * 0.024 * s;
      b.slot(SLOT.HARD).color(this.app.hardTint, 0.92).bind(BIND.torsoRigid);
      b.sphere(_v, _sz.set(0.026 * s, 0.038 * s, 0.026 * s), 9, 7);
      b.slot(SLOT.METAL).color(this.app.metalTint, 1.25).bind(BIND.torsoRigid);
      _v2.copy(_v); _v2.y += 0.040 * s;
      b.cylinder(_v2, _v2.clone().add(new THREE.Vector3(0, 0.014 * s, 0)), 0.009 * s, 0.008 * s, 7, true);
      b.ribbon([
        _v.clone().add(new THREE.Vector3(Math.sin(gPhi) * 0.022 * s, 0.030 * s, Math.cos(gPhi) * 0.022 * s)),
        _v.clone().add(new THREE.Vector3(Math.sin(gPhi) * 0.024 * s, -0.026 * s, Math.cos(gPhi) * 0.024 * s)),
      ], 0.011 * s, 0.004 * s, _wx);
    }
  }

  /** A closed band wrapped around the torso between two heights. */
  private band(yTop: number, yBot: number, out: number, sides: number): void {
    const rings: Ring[] = [];
    const mk = (y: number, o: number): Ring => {
      const sec = this.profileAt(y, _sec);
      return { y, rx: sec.rx + o, rz: sec.rz + o, e: sec.e };
    };
    rings.push(mk(yTop, 0.001));
    rings.push(mk(yTop - 0.004 * this.s, out));
    rings.push(mk(yBot + 0.004 * this.s, out));
    rings.push(mk(yBot, 0.001));
    this.b.tube(rings, sides, {});
  }

  private belt(): void {
    const b = this.b;
    const s = this.s;
    const y = this.hipY + 0.055 * s;
    b.slot(SLOT.GEAR).color(this.app.webbingTint, 1.05).bind(BIND.hips);
    this.band(y + 0.028 * s, y - 0.028 * s, 0.012 * s, this.lod === 0 ? 20 : 12);

    if (!this.mid) return;
    // Belt buckle.
    b.slot(SLOT.METAL).color(this.app.metalTint, 1.5).bind(BIND.hips);
    this.torsoPoint(y, 0, 0.020 * s, _v);
    b.roundedBox(_v, _sz.set(0.058 * s, 0.044 * s, 0.020 * s), 0.008 * s, 1);

    // Utility pouches around the back of the belt.
    const n = this.app.beltPouches;
    for (let i = 0; i < n; i++) {
      const phi = (110 + i * 45 + hash2(i, 9, this.app.seed) * 20) * DEG * (i % 2 === 0 ? 1 : -1);
      // The belt band already stands 12 mm off the hip; the pouch hangs off
      // *that*, so its back face has to land on the band, not 20 mm outside it.
      this.torsoPoint(y - 0.014 * s, phi, 0.013 * s, _v);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), phi);
      const depth = 0.056 * s;
      _v.x += Math.sin(phi) * (depth * 0.5 - 0.010 * s);
      _v.z += Math.cos(phi) * (depth * 0.5 - 0.010 * s);
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.94).bind(BIND.hips);
      b.roundedBox(_v, _sz.set(0.074 * s, 0.096 * s, depth), 0.012 * s, 2, q);
    }
  }

  private backKit(): void {
    const b = this.b;
    const s = this.s;

    if (this.app.backpack) {
      const y = THREE.MathUtils.lerp(this.spineY, this.chestY, 0.55);
      this.torsoPoint(y, Math.PI, 0.02 * s, _v);
      _v.z -= 0.085 * s;
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.88).bind(BIND.torsoRigid);
      b.roundedBox(_v, _sz.set(0.270 * s, 0.360 * s, 0.170 * s), 0.045 * s, this.detail ? 3 : 2);
      if (this.detail) {
        // Compression straps across the back of the pack.
        const pz = _v.z - 0.088 * s;
        for (const dy of [0.10, -0.06]) {
          b.color(this.app.webbingTint, 0.72);
          b.ribbon([
            new THREE.Vector3(-0.12 * s, _v.y + dy * s, pz),
            new THREE.Vector3(0.12 * s, _v.y + dy * s, pz),
          ], 0.030 * s, 0.008 * s, _wy);
        }
      }
    } else if (this.app.antenna && this.mid) {
      // Radio in a back pouch with a whip antenna.
      const y = this.chestY - 0.02 * s;
      this.torsoPoint(y, Math.PI - 0.5, 0.03 * s, _v);
      _v.z -= 0.03 * s;
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.9).bind(BIND.torsoRigid);
      b.roundedBox(_v, _sz.set(0.090 * s, 0.150 * s, 0.055 * s), 0.014 * s, 2);
      b.slot(SLOT.METAL).color(this.app.metalTint, 1.1).bind(BIND.torsoRigid);
      const a = _v.clone(); a.y += 0.070 * s;
      const c2 = a.clone(); c2.y += 0.230 * s; c2.z -= 0.045 * s;
      b.cylinder(a, c2, 0.005 * s, 0.003 * s, 5, true);
    }

    // Two-point sling running over one shoulder and across the chest. It has to
    // *lie on* the kit — a strap standing 5 cm off the body reads as a floating
    // shard whenever it is seen edge-on.
    if (this.mid && this.app.carrier !== 'none') {
      b.slot(SLOT.GEAR).color(this.app.webbingTint, 0.72).bind(BIND.torso);
      const pt = (y: number, phi: number, out: number): THREE.Vector3 => {
        const p = new THREE.Vector3();
        this.torsoPoint(y, phi * DEG, out * s, p);
        return p;
      };
      b.ribbon([
        pt(this.shoulderY + 0.045 * s, -128, 0.012),
        pt(this.shoulderY + 0.030 * s, -74, 0.014),
        pt(this.chestY + 0.035 * s, -44, 0.032),
        pt(this.chestY - 0.045 * s, -14, 0.038),
        pt(this.spineY + 0.010 * s, 22, 0.034),
        pt(this.spineY - 0.045 * s, 48, 0.020),
      ], 0.042 * s, 0.006 * s, _wy);
    }
  }

  private pads(): void {
    // Elbow pads on the sleeves.
    if (!this.app.kneePads) return;
    const b = this.b;
    const s = this.s;
    for (const side of [1, -1] as const) {
      const L = side > 0;
      const el = this.P(L ? 'lowerArmL' : 'lowerArmR');
      b.slot(SLOT.HARD).color(this.app.hardTint, 0.9).bind(L ? BIND.armL : BIND.armR);
      const r0 = 0.052 * s * this.bulk;
      b.tube([
        { y: el.y + 0.068 * s, x: el.x, z: el.z, rx: r0 * 1.02, rz: r0 * 1.02, e: 2.2 },
        { y: el.y + 0.040 * s, x: el.x, z: el.z, rx: r0 * 1.16, rz: r0 * 1.18, e: 2.2 },
        { y: el.y - 0.040 * s, x: el.x, z: el.z, rx: r0 * 1.16, rz: r0 * 1.18, e: 2.2 },
        { y: el.y - 0.068 * s, x: el.x, z: el.z, rx: r0 * 1.02, rz: r0 * 1.02, e: 2.2 },
      ], this.lod === 0 ? 10 : 7, {});
    }
  }
}

function ctrlRadius(ctrl: [number, number][], y: number): number {
  for (let i = 0; i < ctrl.length - 1; i++) {
    const a = ctrl[i], c = ctrl[i + 1];
    if (y <= a[0] && y >= c[0]) {
      const t = (a[0] - y) / (a[0] - c[0] || 1e-6);
      return THREE.MathUtils.lerp(a[1], c[1], t);
    }
  }
  return y > ctrl[0][0] ? ctrl[0][1] : ctrl[ctrl.length - 1][1];
}

/** Wider than the cloth eye port so the skin sphere fills it with margin. */
function eyePortWide(u: number, v: number): boolean {
  const ang = u * Math.PI * 2;
  const fz = Math.cos(ang);
  const fx = Math.sin(ang);
  const yy = Math.cos(v * Math.PI);
  return fz > 0.20 && Math.abs(fx) < 0.72 && yy > -0.42 && yy < 0.50;
}

/* scratch */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _sz = new THREE.Vector3();
const _p2 = new THREE.Vector2();
const _sec: Section = { y: 0, rx: 0.15, rz: 0.12, e: 2.6 };
const _wx = new THREE.Vector3(1, 0, 0);
const _wy = new THREE.Vector3(0, 1, 0);
const _wz = new THREE.Vector3(0, 0, 1);

/** Builds the complete soldier mesh for one appearance at one LOD. */
export function buildSoldier(rig: RigInstance, app: Appearance, lod = 0): SoldierGeometry {
  const b = new SkinMeshBuilder(rig, boneSegments(rig));
  new SoldierArt(rig, app, b, lod).build();
  const tris = b.triangleCount;
  // Baked occlusion is what makes the kit look strapped on rather than decalled;
  // it is worth the build cost at the two LODs where anyone can see it.
  const { geometry, slots } = b.build(lod === 0 ? 'full' : lod === 1 ? 'cheap' : 'none');
  return { geometry, slots, triangles: tris };
}
