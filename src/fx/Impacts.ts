/**
 * Bullet impact effects.
 *
 * Every hit is dispatched through the shared surface table, so the *same*
 * `bullet:impact` event produces a puff of pale concrete dust and a scatter of
 * chips on a wall, a shower of cooling sparks and a ricochet whine off a girder,
 * splinters and pale sapwood out of a crate, a fountain of wet clods out of
 * dirt, a crown splash and an expanding ring on water, and a fine red mist with
 * droplets that leave their own decals where they land.
 *
 * The goal is that a player can identify what they just shot from the effect
 * alone, at a glance, at 20 metres — which is exactly the bar a shipped shooter
 * meets and hobby work does not.
 */

import * as THREE from 'three';
import { surface as surfaceProps, type SurfaceType } from '../core/Surfaces';
import { CELL } from './SpriteAtlas';
import { FLAG, MODEL } from './GpuParticles';
import { QUAD_BLEND, QUAD_MODE } from './Quads';
import { FAMILY_TINT, basisFromNormal, clamp, surfaceFamily } from './Common';
import type { FxWorld } from './Context';

const nrm = new THREE.Vector3();
const tan = new THREE.Vector3();
const bit = new THREE.Vector3();
const dir = new THREE.Vector3();
const ref = new THREE.Vector3();
const tmp = new THREE.Vector3();

interface Droplet {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  floorY: number;
  age: number;
  size: number;
}

export class Impacts {
  private droplets: Droplet[] = [];
  /** Rolling count of hits near the player — drives suppression dust. */
  suppression = 0;

  init(budget = 64): void {
    for (let i = 0; i < budget; i++) {
      this.droplets.push({
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        floorY: 0, age: 0, size: 0.2,
      });
    }
  }

  clear(): void {
    for (const d of this.droplets) d.active = false;
    this.suppression = 0;
  }

  /* --------------------------------------------------------------- dispatch */

  spawn(
    w: FxWorld,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    surfaceName: string,
    energy: number,
    incoming: THREE.Vector3 | null,
    penetrated: boolean,
  ): void {
    const props = surfaceProps(surfaceName as SurfaceType);
    const family = surfaceFamily(surfaceName);
    const rand = w.rand;

    nrm.copy(normal);
    if (nrm.lengthSq() < 1e-6) nrm.set(0, 1, 0);
    nrm.normalize();
    basisFromNormal(nrm, tan, bit);

    if (incoming && incoming.lengthSq() > 1e-6) {
      dir.copy(incoming).normalize();
    } else {
      dir.copy(nrm).multiplyScalar(-1);
    }
    // Mirror the incoming ray about the surface: the direction a ricochet or a
    // spray of debris actually leaves in.
    ref.copy(dir).addScaledVector(nrm, -2 * dir.dot(nrm)).normalize();

    // Energy of a full-power rifle round is ~1800 J; scale everything off that
    // so a pistol hit is visibly weaker than a .50 and a fragment is weaker still.
    const power = clamp(energy > 0 ? energy / 1500 : 0.9, 0.22, 2.2);
    const floorY = w.floorUnder(point.x, point.y, point.z);
    const dist = w.distanceToCamera(point.x, point.y, point.z);
    // Distant impacts do not need their fine detail; near ones get more.
    const near = clamp(1.6 - dist / 26, 0.35, 1.6);
    const detail = near * power;

    switch (family) {
      case 'metal': this.metal(w, point, props.sparks, power, detail, floorY); break;
      case 'wood': this.wood(w, point, power, detail, floorY); break;
      case 'soil': this.soil(w, point, props.dust, power, detail, floorY); break;
      case 'snow': this.snow(w, point, power, detail, floorY); break;
      case 'glass': this.glass(w, point, power, detail, floorY); break;
      case 'water': this.water(w, point, power, detail); break;
      case 'flesh': this.flesh(w, point, power, detail, floorY); break;
      case 'foliage': this.foliage(w, point, detail); break;
      case 'soft': this.soft(w, point, power, detail, floorY); break;
      default: this.masonry(w, point, props.dust, props.debris, power, detail, floorY); break;
    }

    /* --- decal ------------------------------------------------------------ */
    if (props.decal !== 'none' && !penetrated) {
      w.decal({
        x: point.x + nrm.x * 0.004, y: point.y + nrm.y * 0.004, z: point.z + nrm.z * 0.004,
        nx: nrm.x, ny: nrm.y, nz: nrm.z,
        size: clamp(0.16 + power * 0.14, 0.12, 0.46) * (family === 'flesh' ? 1.8 : 1),
        group: props.decal,
        rotation: rand.range(0, Math.PI * 2),
        lifetime: family === 'flesh' ? 40 : Infinity,
        emissive: props.sparks > 0.5 ? 0.35 : 0,
      });
    }

    /* --- suppression: hits close to the player throw dust into the air and
     *     leave a lingering haze so incoming fire reads even when it misses. */
    if (dist < 5.0) {
      this.suppression = Math.min(6, this.suppression + 1);
      this.nearMiss(w, point, dist, floorY);
    }
  }

  /* ---------------------------------------------------------------- masonry */

  private masonry(
    w: FxWorld, p: THREE.Vector3, dustMul: number, debrisMul: number,
    power: number, detail: number, floorY: number,
  ): void {
    const { particles: g, rand } = w;
    const tint = FAMILY_TINT.masonry;

    // --- dense puff right at the hole: short lived, bright, reads as the "pop"
    g.begin({
      cell: CELL.DUST, frames: CELL.DUST_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0] * 1.25, g: tint[1] * 1.22, b: tint[2] * 1.18,
      drag: 3.4, gravity: -0.03, turbulence: 0.5,
    });
    g.pushMany(9 + Math.round(6 * detail), (d, i) => {
      const s = 0.35 + rand.next() * 0.75;
      tmp.copy(nrm).multiplyScalar(1.1 + rand.next() * 1.6)
        .addScaledVector(tan, rand.signed() * 1.5)
        .addScaledVector(bit, rand.signed() * 1.5);
      d.px = p.x + nrm.x * 0.12 + tmp.x * 0.05;
      d.py = p.y + nrm.y * 0.12 + tmp.y * 0.05;
      d.pz = p.z + nrm.z * 0.12 + tmp.z * 0.05;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.25; d.vz = tmp.z * s;
      d.sizeBegin = (0.07 + rand.next() * 0.05) * dustMul;
      d.sizeEnd = (0.30 + rand.next() * 0.34) * dustMul * (0.7 + power * 0.5);
      d.lifetime = 0.7 + rand.next() * 0.8;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 1.2;
      d.opacity = 0.34 + rand.next() * 0.24;
      void i;
    });

    // --- slow plume that hangs in the air and catches the light
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0] * 1.1, g: tint[1] * 1.08, b: tint[2] * 1.05,
      drag: 1.5, gravity: -0.05, turbulence: 0.9,
    });
    g.pushMany(4 + Math.round(4 * detail), (d) => {
      tmp.copy(nrm).multiplyScalar(0.4 + rand.next() * 0.8)
        .addScaledVector(tan, rand.signed() * 0.9)
        .addScaledVector(bit, rand.signed() * 0.9);
      d.px = p.x + nrm.x * 0.22 + tmp.x * 0.10;
      d.py = p.y + nrm.y * 0.22 + tmp.y * 0.10;
      d.pz = p.z + nrm.z * 0.22 + tmp.z * 0.10;
      d.vx = tmp.x * 0.5; d.vy = tmp.y * 0.5 + 0.35; d.vz = tmp.z * 0.5;
      d.sizeBegin = 0.12 * dustMul;
      d.sizeEnd = (0.70 + rand.next() * 0.62) * dustMul;
      d.lifetime = 1.6 + rand.next() * 1.6;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 0.4;
      d.opacity = 0.13 + rand.next() * 0.11;
    });

    // --- chips: the debris that says "masonry" rather than "smoke machine"
    g.begin({
      cell: CELL.CHIP_A, frames: CELL.CHIP_FRAMES, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: tint[0] * 0.85, g: tint[1] * 0.83, b: tint[2] * 0.8,
      drag: 0.28, gravity: 1, bounce: 0.22, floorY, opacity: 1,
    });
    g.pushMany((7 + Math.round(9 * detail)) * debrisMul, () => {
      const d = w.particles.desc;
      const s = 2.2 + rand.next() * 5.5 * power;
      tmp.copy(nrm).multiplyScalar(0.7 + rand.next() * 0.8)
        .addScaledVector(tan, rand.signed() * 1.1)
        .addScaledVector(bit, rand.signed() * 1.1)
        .addScaledVector(ref, rand.next() * 0.6);
      tmp.normalize();
      d.px = p.x + nrm.x * 0.02; d.py = p.y + nrm.y * 0.02; d.pz = p.z + nrm.z * 0.02;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 1.0; d.vz = tmp.z * s;
      const sz = 0.028 + rand.next() * 0.055 * power;
      d.sizeBegin = sz; d.sizeEnd = sz;
      d.lifetime = 1.1 + rand.next() * 1.4;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 16;
    });

    this.impactFlash(w, p, 0.07 * power, 0xffd9a0, 0.30);
  }

  /* ------------------------------------------------------------------ metal */

  private metal(
    w: FxWorld, p: THREE.Vector3, sparkMul: number,
    power: number, detail: number, floorY: number,
  ): void {
    const { particles: g, rand } = w;

    // --- shower of cooling sparks
    g.begin({
      cell: CELL.SPARK_DOT, frames: 1, model: MODEL.HOT,
      flags: FLAG.ADD | FLAG.STRETCH | FLAG.COLLIDE | FLAG.HOTRAMP | FLAG.FLICKER | FLAG.NOSOFT,
      r: 1.0, g: 0.74, b: 0.38, opacity: 1,
      drag: 0.72, gravity: 1.05, bounce: 0.45, floorY, emissive: 0.75,
    });
    g.pushMany((30 + Math.round(30 * detail)) * sparkMul, () => {
      const d = g.desc;
      const s = 2.2 + rand.next() * 12 * power;
      // A wide fan, not a beam: real spatter leaves the steel across most of
      // the hemisphere, biased toward the reflected path.
      tmp.copy(ref).multiplyScalar(0.18 + rand.next() * 0.5)
        .addScaledVector(nrm, 0.25 + rand.next() * 0.7)
        .addScaledVector(tan, rand.signed() * 2.6)
        .addScaledVector(bit, rand.signed() * 2.6)
        .normalize();
      d.px = p.x + nrm.x * 0.015; d.py = p.y + nrm.y * 0.015; d.pz = p.z + nrm.z * 0.015;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.6; d.vz = tmp.z * s;
      d.sizeBegin = 0.019 + rand.next() * 0.021;
      d.sizeEnd = 0.005;
      // Long enough to arc, hit the deck and skip once before they go out.
      d.lifetime = 0.45 + rand.next() * 1.15;
    });

    // --- the brightest few get a real swept ribbon
    const trails = Math.round(clamp(5 * detail, 2, 9));
    for (let i = 0; i < trails; i++) {
      const s = 6 + rand.next() * 10 * power;
      tmp.copy(ref).multiplyScalar(0.8 + rand.next() * 0.6)
        .addScaledVector(tan, rand.signed() * 0.55)
        .addScaledVector(bit, rand.signed() * 0.55)
        .normalize();
      w.ribbons.begin({
        px: p.x + nrm.x * 0.02, py: p.y + nrm.y * 0.02, pz: p.z + nrm.z * 0.02,
        vx: tmp.x * s, vy: tmp.y * s + 1.2, vz: tmp.z * s,
        life: 0.45 + rand.next() * 0.45,
        width: 0.018 + rand.next() * 0.014,
        r: 1.0, g: 0.55, b: 0.18, intensity: 4.2,
        drag: 0.55, gravity: 1.0, floorY, bounce: 0.45,
        sampleInterval: 1 / 90,
      });
      w.ribbons.push();
    }

    // --- ricochet: one long, slow, arcing spark leaving the surface
    if (rand.bool(0.45)) {
      const s = 12 + rand.next() * 10;
      tmp.copy(ref).addScaledVector(nrm, 0.25).normalize();
      g.begin({
        cell: CELL.SPARK_DOT, frames: 1, model: MODEL.HOT,
        flags: FLAG.ADD | FLAG.STRETCH | FLAG.COLLIDE | FLAG.HOTRAMP | FLAG.NOSOFT,
        r: 1.0, g: 0.82, b: 0.5, opacity: 1, emissive: 0.45,
        drag: 0.35, gravity: 0.9, bounce: 0.45, floorY,
        px: p.x, py: p.y, pz: p.z,
        vx: tmp.x * s, vy: tmp.y * s + 1.5, vz: tmp.z * s,
        sizeBegin: 0.03, sizeEnd: 0.008, lifetime: 0.9 + rand.next() * 0.5,
      });
      g.push();
      w.ribbons.begin({
        px: p.x, py: p.y, pz: p.z,
        vx: tmp.x * s, vy: tmp.y * s + 1.5, vz: tmp.z * s,
        life: 1.05, width: 0.022, r: 1.0, g: 0.60, b: 0.22, intensity: 4.6,
        drag: 0.35, gravity: 0.9, floorY, bounce: 0.45, sampleInterval: 1 / 80,
      });
      w.ribbons.push();
    }

    // --- a wisp of hot grey smoke where the jacket vaporised
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.34, g: 0.335, b: 0.33, opacity: 0.3,
      drag: 2.0, gravity: -0.09, turbulence: 0.8,
    });
    g.pushMany(2 + Math.round(2 * detail), () => {
      const d = g.desc;
      tmp.copy(nrm).multiplyScalar(0.5 + rand.next() * 0.7)
        .addScaledVector(tan, rand.signed() * 0.4)
        .addScaledVector(bit, rand.signed() * 0.4);
      d.px = p.x + tmp.x * 0.04; d.py = p.y + tmp.y * 0.04; d.pz = p.z + tmp.z * 0.04;
      d.vx = tmp.x * 0.6; d.vy = tmp.y * 0.6 + 0.4; d.vz = tmp.z * 0.6;
      d.sizeBegin = 0.05; d.sizeEnd = 0.30 + rand.next() * 0.25;
      d.lifetime = 0.9 + rand.next() * 0.7;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.9;
    });

    this.impactFlash(w, p, 0.12 * power, 0xffc474, 0.9);
    w.light({
      x: p.x + nrm.x * 0.1, y: p.y + nrm.y * 0.1, z: p.z + nrm.z * 0.1,
      color: 0xffb060, intensity: 2.4 * power, radius: 3.0, lifetime: 0.1, decay: 'flash',
    });
  }

  /* ------------------------------------------------------------------- wood */

  private wood(w: FxWorld, p: THREE.Vector3, power: number, detail: number, floorY: number): void {
    const { particles: g, rand } = w;
    const tint = FAMILY_TINT.wood;

    g.begin({
      cell: CELL.SPLINTER_A, frames: CELL.SPLINTER_FRAMES, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: tint[0] * 1.55, g: tint[1] * 1.65, b: tint[2] * 1.8, opacity: 1,
      drag: 0.75, gravity: 1, bounce: 0.12, floorY,
    });
    g.pushMany(8 + Math.round(9 * detail), () => {
      const d = g.desc;
      const s = 2.0 + rand.next() * 5.0 * power;
      tmp.copy(nrm).multiplyScalar(0.8 + rand.next() * 0.7)
        .addScaledVector(tan, rand.signed() * 1.0)
        .addScaledVector(bit, rand.signed() * 1.0)
        .normalize();
      d.px = p.x + nrm.x * 0.02; d.py = p.y + nrm.y * 0.02; d.pz = p.z + nrm.z * 0.02;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.8; d.vz = tmp.z * s;
      d.sizeBegin = 0.035 + rand.next() * 0.070 * power;
      d.sizeEnd = d.sizeBegin;
      d.lifetime = 1.2 + rand.next() * 1.5;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 22;
    });

    g.begin({
      cell: CELL.DUST, frames: CELL.DUST_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0] * 1.7, g: tint[1] * 1.75, b: tint[2] * 1.9, opacity: 0.34,
      drag: 3.0, gravity: 0.05, turbulence: 0.5,
    });
    g.pushMany(4 + Math.round(4 * detail), () => {
      const d = g.desc;
      tmp.copy(nrm).multiplyScalar(0.8 + rand.next() * 1.0)
        .addScaledVector(tan, rand.signed() * 0.9)
        .addScaledVector(bit, rand.signed() * 0.9);
      d.px = p.x + nrm.x * 0.12 + tmp.x * 0.05;
      d.py = p.y + nrm.y * 0.12 + tmp.y * 0.05;
      d.pz = p.z + nrm.z * 0.12 + tmp.z * 0.05;
      d.vx = tmp.x * 0.9; d.vy = tmp.y * 0.9 + 0.2; d.vz = tmp.z * 0.9;
      d.sizeBegin = 0.09; d.sizeEnd = 0.45 + rand.next() * 0.4;
      d.lifetime = 0.8 + rand.next() * 0.7;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 1.4;
    });
  }

  /* ------------------------------------------------------------------- soil */

  private soil(
    w: FxWorld, p: THREE.Vector3, dustMul: number,
    power: number, detail: number, floorY: number,
  ): void {
    const { particles: g, rand } = w;
    const tint = FAMILY_TINT.soil;

    // Dirt throws a real column, not a puff — the mass of it is the read.
    g.begin({
      cell: CELL.DUST, frames: CELL.DUST_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0] * 1.35, g: tint[1] * 1.32, b: tint[2] * 1.28, opacity: 0.5,
      drag: 1.9, gravity: 0.10, turbulence: 0.7,
    });
    g.pushMany(9 + Math.round(9 * detail), () => {
      const d = g.desc;
      const s = 1.4 + rand.next() * 3.4 * power;
      tmp.copy(nrm).multiplyScalar(1.2 + rand.next() * 1.1)
        .addScaledVector(tan, rand.signed() * 0.9)
        .addScaledVector(bit, rand.signed() * 0.9)
        .normalize();
      d.px = p.x + nrm.x * 0.14 + tmp.x * 0.08;
      d.py = p.y + nrm.y * 0.14 + tmp.y * 0.08;
      d.pz = p.z + nrm.z * 0.14 + tmp.z * 0.08;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.6; d.vz = tmp.z * s;
      d.sizeBegin = 0.14 * dustMul * 0.5;
      d.sizeEnd = (0.85 + rand.next() * 0.9) * dustMul * 0.55 * (0.8 + power * 0.4);
      d.lifetime = 1.1 + rand.next() * 1.5;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.8;
      d.opacity = 0.35 + rand.next() * 0.28;
    });

    g.begin({
      cell: CELL.CHIP_A, frames: CELL.CHIP_FRAMES, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: tint[0] * 0.9, g: tint[1] * 0.88, b: tint[2] * 0.86, opacity: 1,
      drag: 0.5, gravity: 1, bounce: 0.10, floorY,
    });
    g.pushMany(8 + Math.round(8 * detail), () => {
      const d = g.desc;
      const s = 2.0 + rand.next() * 5.0 * power;
      tmp.copy(nrm).multiplyScalar(0.9 + rand.next() * 0.9)
        .addScaledVector(tan, rand.signed() * 0.8)
        .addScaledVector(bit, rand.signed() * 0.8)
        .normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 1.4; d.vz = tmp.z * s;
      const sz = 0.030 + rand.next() * 0.060 * power;
      d.sizeBegin = sz; d.sizeEnd = sz * 0.9;
      d.lifetime = 1.0 + rand.next() * 1.2;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 12;
    });
  }

  private snow(w: FxWorld, p: THREE.Vector3, power: number, detail: number, floorY: number): void {
    const { particles: g, rand } = w;
    const tint = FAMILY_TINT.snow;
    g.begin({
      cell: CELL.DUST, frames: CELL.DUST_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0], g: tint[1], b: tint[2], opacity: 0.55,
      drag: 2.6, gravity: 0.05, turbulence: 0.9,
    });
    g.pushMany(10 + Math.round(10 * detail), () => {
      const d = g.desc;
      const s = 1.2 + rand.next() * 3.0 * power;
      tmp.copy(nrm).multiplyScalar(1.3 + rand.next() * 1.0)
        .addScaledVector(tan, rand.signed() * 1.0)
        .addScaledVector(bit, rand.signed() * 1.0).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.8; d.vz = tmp.z * s;
      d.sizeBegin = 0.05; d.sizeEnd = 0.42 + rand.next() * 0.5;
      d.lifetime = 1.3 + rand.next() * 1.4;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.7;
    });
    g.begin({
      cell: CELL.SNOW, frames: 1, model: MODEL.THIN,
      flags: FLAG.COLLIDE, r: 1, g: 1, b: 1, opacity: 0.9,
      drag: 1.4, gravity: 0.7, bounce: 0.05, floorY,
    });
    g.pushMany(8 * detail, () => {
      const d = g.desc;
      const s = 1.5 + rand.next() * 3;
      tmp.copy(nrm).addScaledVector(tan, rand.signed()).addScaledVector(bit, rand.signed()).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 1.2; d.vz = tmp.z * s;
      d.sizeBegin = 0.02; d.sizeEnd = 0.02;
      d.lifetime = 1.4; d.spin = rand.signed() * 6;
    });
  }

  /* ------------------------------------------------------------------ glass */

  private glass(w: FxWorld, p: THREE.Vector3, power: number, detail: number, floorY: number): void {
    const { particles: g, rand } = w;

    // Shards fly with the round; fragments fall straight out of the pane.
    g.begin({
      cell: CELL.SHARD_A, frames: CELL.SHARD_FRAMES, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: 0.82, g: 0.90, b: 0.97, opacity: 0.95,
      drag: 0.25, gravity: 1, bounce: 0.30, floorY, emissive: 0.15,
    });
    g.pushMany(11 + Math.round(12 * detail), () => {
      const d = g.desc;
      const s = 3.0 + rand.next() * 8.0 * power;
      tmp.copy(dir).multiplyScalar(0.7 + rand.next() * 0.6)
        .addScaledVector(tan, rand.signed() * 0.9)
        .addScaledVector(bit, rand.signed() * 0.9).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.8; d.vz = tmp.z * s;
      const sz = 0.022 + rand.next() * 0.060 * power;
      d.sizeBegin = sz; d.sizeEnd = sz;
      d.lifetime = 1.6 + rand.next() * 1.4;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 20;
    });

    // Falling fragments: the pane letting go around the hole a beat later.
    g.begin({
      cell: CELL.SHARD_A, frames: CELL.SHARD_FRAMES, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: 0.80, g: 0.88, b: 0.96, opacity: 0.9,
      drag: 0.2, gravity: 1, bounce: 0.2, floorY,
    });
    g.pushMany(6 * detail, () => {
      const d = g.desc;
      d.px = p.x + (rand.signed()) * 0.22 * tan.x + (rand.signed()) * 0.22 * bit.x;
      d.py = p.y + (rand.signed()) * 0.22 * tan.y + (rand.signed()) * 0.22 * bit.y + 0.1;
      d.pz = p.z + (rand.signed()) * 0.22 * tan.z + (rand.signed()) * 0.22 * bit.z;
      d.vx = rand.signed() * 0.4; d.vy = -0.3 - rand.next() * 0.5; d.vz = rand.signed() * 0.4;
      const sz = 0.035 + rand.next() * 0.075;
      d.sizeBegin = sz; d.sizeEnd = sz;
      d.lifetime = 2.0 + rand.next() * 1.0;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 9;
    });

    // Pulverised glass dust glitters in the sun.
    g.begin({
      cell: CELL.SPARK_DOT, frames: 1, model: MODEL.HOT,
      flags: FLAG.ADD | FLAG.FLICKER | FLAG.NOSOFT,
      r: 0.85, g: 0.95, b: 1.0, opacity: 0.85, emissive: 0.6,
      drag: 1.2, gravity: 0.8,
    });
    g.pushMany(10 * detail, () => {
      const d = g.desc;
      const s = 1.5 + rand.next() * 4;
      tmp.copy(dir).addScaledVector(tan, rand.signed()).addScaledVector(bit, rand.signed()).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.5; d.vz = tmp.z * s;
      d.sizeBegin = 0.008; d.sizeEnd = 0.003;
      d.lifetime = 0.5 + rand.next() * 0.6;
    });

    this.impactFlash(w, p, 0.09, 0xdff0ff, 0.5);
  }

  /* ------------------------------------------------------------------ water */

  private water(w: FxWorld, p: THREE.Vector3, power: number, detail: number): void {
    const { particles: g, quads: q, rand } = w;

    // --- crown of droplets, thrown up and outward
    g.begin({
      cell: CELL.WATER_DROP, frames: 1, model: MODEL.THIN,
      flags: FLAG.STRETCH | FLAG.FADEIN,
      r: 0.72, g: 0.82, b: 0.90, opacity: 0.85,
      drag: 0.35, gravity: 1,
    });
    g.pushMany(24 + Math.round(20 * detail), () => {
      const d = g.desc;
      const a = rand.range(0, Math.PI * 2);
      const spread = 0.30 + rand.next() * 0.95;
      const s = 2.4 + rand.next() * 5.0 * power;
      tmp.copy(nrm)
        .addScaledVector(tan, Math.cos(a) * spread)
        .addScaledVector(bit, Math.sin(a) * spread)
        .normalize();
      d.px = p.x; d.py = p.y + 0.01; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 2.2; d.vz = tmp.z * s;
      d.sizeBegin = 0.022 + rand.next() * 0.036;
      d.sizeEnd = 0.012;
      d.lifetime = 0.55 + rand.next() * 0.7;
    });

    // The column: water thrown straight back up out of the entry hole. This is
    // the part that reads as "a bullet went into water" rather than "sparkles".
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.THIN,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.82, g: 0.88, b: 0.94, opacity: 0.55,
      drag: 1.9, gravity: 0.55, turbulence: 0.4,
    });
    g.pushMany(7 * detail, (d, i) => {
      d.px = p.x + rand.signed() * 0.04;
      d.py = p.y + 0.05 + i * 0.10;
      d.pz = p.z + rand.signed() * 0.04;
      d.vx = rand.signed() * 0.5;
      d.vy = 3.4 + rand.next() * 2.4 * power - i * 0.25;
      d.vz = rand.signed() * 0.5;
      d.sizeBegin = 0.10 + i * 0.02;
      d.sizeEnd = 0.34 + rand.next() * 0.22;
      d.lifetime = 0.42 + rand.next() * 0.32;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 1.4;
    });

    // --- a fine mist above the entry
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.THIN,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.78, g: 0.86, b: 0.92, opacity: 0.30,
      drag: 3.0, gravity: 0.25, turbulence: 0.5,
    });
    g.pushMany(5 * detail, () => {
      const d = g.desc;
      d.px = p.x + rand.signed() * 0.06; d.py = p.y + 0.05; d.pz = p.z + rand.signed() * 0.06;
      d.vx = rand.signed() * 0.5; d.vy = 1.1 + rand.next() * 0.9; d.vz = rand.signed() * 0.5;
      d.sizeBegin = 0.06; d.sizeEnd = 0.34 + rand.next() * 0.2;
      d.lifetime = 0.6 + rand.next() * 0.5;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed();
    });

    // --- expanding ring lying on the surface
    q.begin({
      px: p.x, py: p.y + 0.03, pz: p.z,
      ax: nrm.x, ay: nrm.y, az: nrm.z,
      w0: 0.14, h0: 0.14, w1: 2.6 * (0.7 + power * 0.5), h1: 2.6 * (0.7 + power * 0.5),
      r: 0.80, g: 0.90, b: 0.98, alpha: 0.5,
      life: 0.85, cell: CELL.SPLASH_RING, frames: 1,
      mode: QUAD_MODE.ORIENTED, blend: QUAD_BLEND.ALPHA, lit: true,
      fadeIn: 0.06, fadeOut: 0.25, soft: 0.25, rot: rand.range(0, 6.28),
    });
    q.push();

    // A second, faster ring reads as the initial displacement.
    q.begin({
      px: p.x, py: p.y + 0.045, pz: p.z,
      ax: nrm.x, ay: nrm.y, az: nrm.z,
      w0: 0.05, h0: 0.05, w1: 1.25, h1: 1.25,
      r: 1.0, g: 1.0, b: 1.0, alpha: 0.42,
      life: 0.35, cell: CELL.SPLASH_RING, frames: 1,
      mode: QUAD_MODE.ORIENTED, blend: QUAD_BLEND.ALPHA, lit: true,
      fadeIn: 0.04, fadeOut: 0.2, soft: 0.2, rot: rand.range(0, 6.28),
    });
    q.push();
  }

  /* ------------------------------------------------------------------ flesh */

  private flesh(w: FxWorld, p: THREE.Vector3, power: number, detail: number, floorY: number): void {
    if (!w.blood) {
      this.impactFlash(w, p, 0.05, 0x886655, 0.3);
      return;
    }
    const { particles: g, rand } = w;

    // --- mist: a puff of atomised blood that hangs for a fraction of a second
    g.begin({
      cell: CELL.BLOOD_MIST, frames: 1, model: MODEL.THIN,
      flags: FLAG.FADEIN | FLAG.SHADOW,
      r: 0.36, g: 0.030, b: 0.024, opacity: 0.62,
      drag: 2.6, gravity: 0.35, turbulence: 0.3,
    });
    g.pushMany(7 + Math.round(7 * detail), () => {
      const d = g.desc;
      const s = 1.2 + rand.next() * 3.2 * power;
      tmp.copy(ref).multiplyScalar(0.8 + rand.next() * 0.7)
        .addScaledVector(tan, rand.signed() * 0.8)
        .addScaledVector(bit, rand.signed() * 0.8).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.3; d.vz = tmp.z * s;
      d.sizeBegin = 0.07; d.sizeEnd = 0.42 + rand.next() * 0.42;
      d.lifetime = 0.4 + rand.next() * 0.45;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 1.6;
    });

    // --- droplets thrown along the exit direction
    g.begin({
      cell: CELL.BLOOD_DROP, frames: 1, model: MODEL.THIN,
      flags: FLAG.STRETCH | FLAG.COLLIDE,
      r: 0.28, g: 0.018, b: 0.014, opacity: 1,
      drag: 0.3, gravity: 1, bounce: 0, floorY,
    });
    g.pushMany(9 + Math.round(9 * detail), () => {
      const d = g.desc;
      const s = 2.5 + rand.next() * 6 * power;
      tmp.copy(ref).multiplyScalar(0.9 + rand.next() * 0.6)
        .addScaledVector(tan, rand.signed() * 0.6)
        .addScaledVector(bit, rand.signed() * 0.6).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.9; d.vz = tmp.z * s;
      d.sizeBegin = 0.020 + rand.next() * 0.026;
      d.sizeEnd = 0.016;
      d.lifetime = 0.8 + rand.next() * 0.5;
    });

    // --- a handful of tracked droplets that leave decals where they land
    const n = Math.round(clamp(3 * detail, 1, 6));
    for (let i = 0; i < n; i++) {
      const drop = this.droplets.find((d) => !d.active);
      if (!drop) break;
      const s = 2.5 + rand.next() * 5 * power;
      tmp.copy(ref).multiplyScalar(0.9)
        .addScaledVector(tan, rand.signed() * 0.7)
        .addScaledVector(bit, rand.signed() * 0.7).normalize();
      drop.active = true;
      drop.x = p.x; drop.y = p.y; drop.z = p.z;
      drop.vx = tmp.x * s; drop.vy = tmp.y * s + 1.2; drop.vz = tmp.z * s;
      drop.floorY = floorY;
      drop.age = 0;
      drop.size = 0.16 + rand.next() * 0.4;
    }
  }

  /* --------------------------------------------------------- soft / foliage */

  private soft(w: FxWorld, p: THREE.Vector3, power: number, detail: number, floorY: number): void {
    const { particles: g, rand } = w;
    const tint = FAMILY_TINT.soft;
    g.begin({
      cell: CELL.DUST, frames: CELL.DUST_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0] * 1.2, g: tint[1] * 1.2, b: tint[2] * 1.2, opacity: 0.32,
      drag: 3.2, gravity: 0.02, turbulence: 0.6,
    });
    g.pushMany(4 + Math.round(4 * detail), () => {
      const d = g.desc;
      tmp.copy(nrm).multiplyScalar(0.8 + rand.next())
        .addScaledVector(tan, rand.signed() * 0.8)
        .addScaledVector(bit, rand.signed() * 0.8);
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x; d.vy = tmp.y + 0.2; d.vz = tmp.z;
      d.sizeBegin = 0.05; d.sizeEnd = 0.24 + rand.next() * 0.22;
      d.lifetime = 0.7 + rand.next() * 0.6;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed();
    });
    g.begin({
      cell: CELL.PAPER, frames: 1, model: MODEL.SOLID,
      flags: FLAG.COLLIDE | FLAG.SHADOW,
      r: tint[0], g: tint[1], b: tint[2], opacity: 1,
      drag: 1.6, gravity: 0.5, bounce: 0.05, floorY,
    });
    g.pushMany(4 * detail, () => {
      const d = g.desc;
      const s = 1.2 + rand.next() * 2.5 * power;
      tmp.copy(nrm).addScaledVector(tan, rand.signed()).addScaledVector(bit, rand.signed()).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.8; d.vz = tmp.z * s;
      d.sizeBegin = 0.015 + rand.next() * 0.02; d.sizeEnd = d.sizeBegin;
      d.lifetime = 1.6; d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 14;
    });
  }

  private foliage(w: FxWorld, p: THREE.Vector3, detail: number): void {
    const { particles: g, rand } = w;
    const tint = FAMILY_TINT.foliage;
    g.begin({
      cell: CELL.LEAF, frames: 1, model: MODEL.SOLID,
      flags: FLAG.SHADOW,
      r: tint[0] * 1.6, g: tint[1] * 1.6, b: tint[2] * 1.6, opacity: 1,
      drag: 2.2, gravity: 0.35, turbulence: 1.4,
    });
    g.pushMany(6 + Math.round(6 * detail), () => {
      const d = g.desc;
      const s = 1.0 + rand.next() * 2.2;
      tmp.copy(dir).addScaledVector(tan, rand.signed()).addScaledVector(bit, rand.signed()).normalize();
      d.px = p.x; d.py = p.y; d.pz = p.z;
      d.vx = tmp.x * s; d.vy = tmp.y * s + 0.4; d.vz = tmp.z * s;
      d.sizeBegin = 0.03 + rand.next() * 0.04; d.sizeEnd = d.sizeBegin;
      d.lifetime = 2.4 + rand.next() * 1.6;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 7;
    });
  }

  /* ---------------------------------------------------------------- helpers */

  /** The sub-frame flash of the round's own energy dumping into the surface. */
  private impactFlash(w: FxWorld, p: THREE.Vector3, size: number, color: number, gain: number): void {
    const c = new THREE.Color(color);
    w.quads.begin({
      px: p.x + nrm.x * 0.02, py: p.y + nrm.y * 0.02, pz: p.z + nrm.z * 0.02,
      w0: size * 0.5, h0: size * 0.5, w1: size * 2.4, h1: size * 2.4,
      r: c.r * gain, g: c.g * gain, b: c.b * gain, alpha: 1,
      life: 0.075, cell: CELL.GLOW_TIGHT, frames: 1,
      mode: 0, blend: QUAD_BLEND.ADD, lit: false,
      fadeIn: 0.12, fadeOut: 0.2, soft: 0, intensity: 2.4,
      rot: w.rand.range(0, 6.28),
    });
    w.quads.push();
  }

  /** Dust kicked toward the player by a round that just missed them. */
  private nearMiss(w: FxWorld, p: THREE.Vector3, dist: number, floorY: number): void {
    const { particles: g, rand } = w;
    const boost = clamp(1.5 - dist / 5.0, 0.2, 1.5);
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.66, g: 0.64, b: 0.60, opacity: 0.16 * boost,
      drag: 1.2, gravity: -0.04, turbulence: 1.2, floorY,
    });
    g.pushMany(3 * boost, () => {
      const d = g.desc;
      tmp.copy(nrm).multiplyScalar(0.6 + rand.next())
        .addScaledVector(tan, rand.signed() * 1.2)
        .addScaledVector(bit, rand.signed() * 1.2);
      d.px = p.x + tmp.x * 0.15; d.py = p.y + tmp.y * 0.15; d.pz = p.z + tmp.z * 0.15;
      d.vx = tmp.x * 0.9; d.vy = tmp.y * 0.9 + 0.5; d.vz = tmp.z * 0.9;
      d.sizeBegin = 0.15; d.sizeEnd = 1.1 + rand.next() * 0.9;
      d.lifetime = 2.2 + rand.next() * 2.0;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.3;
    });
  }

  /* ------------------------------------------------------------ simulation  */

  fixedUpdate(dt: number, w: FxWorld): void {
    if (this.suppression > 0) this.suppression = Math.max(0, this.suppression - dt * 0.8);

    for (const d of this.droplets) {
      if (!d.active) continue;
      d.age += dt;
      d.vy -= 9.81 * dt;
      const k = Math.exp(-0.25 * dt);
      d.vx *= k; d.vy *= k; d.vz *= k;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      if (d.y <= d.floorY || d.age > 3) {
        d.active = false;
        if (d.y <= d.floorY && w.blood) {
          w.decal({
            x: d.x, y: d.floorY + 0.002, z: d.z,
            nx: 0, ny: 1, nz: 0,
            size: d.size,
            group: 'blood',
            rotation: w.rand.range(0, Math.PI * 2),
            lifetime: 60,
          });
        }
      }
    }
  }
}
