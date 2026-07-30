/**
 * Muzzle flash, tracers and ejected brass.
 *
 * A muzzle flash is not a sprite — it is five things happening in 40
 * milliseconds: the white core at the crown, an anamorphic star on the shots
 * where the powder happens to bloom, a cone of burning gas down the bore axis,
 * a ring of smoke pushed out ahead of it, and a hard flash of light on every
 * surface within a few metres. Varying which of those appear, and by how much,
 * is what stops automatic fire looking like a looping GIF.
 *
 * Sustained fire heats the barrel; past a threshold a refractive shimmer sits
 * over it and the smoke lingers, exactly as it does on a real weapon.
 */

import * as THREE from 'three';
import { CELL } from './SpriteAtlas';
import { FLAG, MODEL } from './GpuParticles';
import { QUAD_BLEND, QUAD_MODE } from './Quads';
import { clamp } from './Common';
import type { CasingKind } from './Casings';
import type { FxWorld } from './Context';

export interface MuzzleProfile {
  scale: number;
  lightIntensity: number;
  lightRadius: number;
  starChance: number;
  coneLength: number;
  smoke: number;
  gasSpeed: number;
  color: number;
  casing: CasingKind;
  ejectSpeed: number;
  /** A tracer every Nth round; 0 disables. */
  tracerEvery: number;
  tracerColor: number;
  tracerSpeed: number;
  heatPerShot: number;
  shake: number;
}

const AR: MuzzleProfile = {
  scale: 1.0, lightIntensity: 26, lightRadius: 9, starChance: 0.42,
  coneLength: 0.55, smoke: 1, gasSpeed: 13, color: 0xffb464,
  casing: 'rifle', ejectSpeed: 2.7, tracerEvery: 4, tracerColor: 0xffd070,
  tracerSpeed: 340, heatPerShot: 0.055, shake: 0.008,
};

const PROFILES: Record<string, MuzzleProfile> = {
  ar: AR,
  smg: { ...AR, scale: 0.78, lightIntensity: 18, coneLength: 0.4, tracerEvery: 5, heatPerShot: 0.05, casing: 'pistol', shake: 0.006 },
  lmg: { ...AR, scale: 1.22, lightIntensity: 34, lightRadius: 11, coneLength: 0.7, tracerEvery: 3, casing: 'lmg', heatPerShot: 0.07, shake: 0.011 },
  sniper: { ...AR, scale: 1.55, lightIntensity: 46, lightRadius: 14, starChance: 0.75, coneLength: 1.05, smoke: 1.6, gasSpeed: 20, tracerEvery: 1, tracerColor: 0xfff0c0, heatPerShot: 0.09, shake: 0.026 },
  shotgun: { ...AR, scale: 1.5, lightIntensity: 40, lightRadius: 12, starChance: 0.85, coneLength: 0.95, smoke: 2.2, gasSpeed: 11, color: 0xffa050, casing: 'shotgun', ejectSpeed: 2.2, tracerEvery: 0, heatPerShot: 0.08, shake: 0.03 },
  pistol: { ...AR, scale: 0.72, lightIntensity: 15, lightRadius: 7, starChance: 0.35, coneLength: 0.34, smoke: 0.8, casing: 'pistol', tracerEvery: 0, heatPerShot: 0.05, shake: 0.006 },
  launcher: { ...AR, scale: 2.0, lightIntensity: 55, lightRadius: 16, starChance: 0.9, coneLength: 1.6, smoke: 3.5, gasSpeed: 9, casing: 'shotgun', tracerEvery: 0, heatPerShot: 0.2, shake: 0.05 },
};

function profileFor(weaponId: string): MuzzleProfile {
  const key = weaponId.split('_')[0]?.toLowerCase() ?? 'ar';
  return PROFILES[key] ?? AR;
}

const right = new THREE.Vector3();
const up = new THREE.Vector3();
const fwd = new THREE.Vector3();
const muzzle = new THREE.Vector3();
const port = new THREE.Vector3();
const tmp = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const colour = new THREE.Color();

interface BarrelHeat {
  heat: number;
  lastShot: number;
  /** Where the muzzle was on the last shot — the shimmer needs it later. */
  mx: number; my: number; mz: number;
  fx: number; fy: number; fz: number;
}

export class MuzzleFX {
  /** Offset from the reported fire origin to the physical muzzle, in the
   *  weapon's own frame (right, up, forward). Weapons can override it. */
  muzzleOffset = new THREE.Vector3(0.13, -0.11, 0.58);
  ejectOffset = new THREE.Vector3(0.09, -0.06, 0.20);

  private heat = new Map<string, BarrelHeat>();
  private hazeTimer = 0;

  clear(): void {
    this.heat.clear();
    this.hazeTimer = 0;
  }

  /** Resolves the muzzle for a shot and stores the weapon frame in the scratch. */
  private frame(origin: THREE.Vector3, direction: THREE.Vector3): void {
    fwd.copy(direction).normalize();
    right.crossVectors(fwd, WORLD_UP);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(right, fwd).normalize();

    muzzle.copy(origin)
      .addScaledVector(right, this.muzzleOffset.x)
      .addScaledVector(up, this.muzzleOffset.y)
      .addScaledVector(fwd, this.muzzleOffset.z);
    port.copy(origin)
      .addScaledVector(right, this.ejectOffset.x)
      .addScaledVector(up, this.ejectOffset.y)
      .addScaledVector(fwd, this.ejectOffset.z);
  }

  fire(
    w: FxWorld,
    weaponId: string,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    shotIndex: number,
    suppressed: boolean,
    firstPerson: boolean,
  ): void {
    const prof = profileFor(weaponId);
    this.frame(origin, direction);

    const heat = this.heat.get(weaponId)
      ?? { heat: 0, lastShot: 0, mx: 0, my: 0, mz: 0, fx: 0, fy: 0, fz: -1 };
    heat.heat = Math.min(1.6, heat.heat + prof.heatPerShot);
    heat.lastShot = w.clock;
    heat.mx = muzzle.x; heat.my = muzzle.y; heat.mz = muzzle.z;
    heat.fx = fwd.x; heat.fy = fwd.y; heat.fz = fwd.z;
    this.heat.set(weaponId, heat);

    if (suppressed) this.suppressedFlash(w, prof);
    else this.openFlash(w, prof, shotIndex, firstPerson);

    this.gas(w, prof, suppressed);
    this.smoke(w, prof, suppressed, heat.heat);

    if (prof.tracerEvery > 0 && !suppressed && shotIndex % prof.tracerEvery === 0) {
      this.tracer(w, prof, direction);
    }

    // Brass. Ejection is to the right and slightly up for a right-handed
    // weapon; the port sits behind the muzzle.
    w.casings.eject(
      port, right, up, fwd, prof.casing,
      w.floorUnder(port.x, port.y, port.z), prof.ejectSpeed,
    );

    if (firstPerson) {
      w.shake(prof.shake * (suppressed ? 0.5 : 1), 34, 0.12);
    }
  }

  /* ---------------------------------------------------------------- layers */

  private openFlash(w: FxWorld, prof: MuzzleProfile, shotIndex: number, firstPerson: boolean): void {
    const rand = w.rand;
    const q = w.quads;
    const s = prof.scale;
    colour.set(prof.color);

    // Per-shot variance: no two flashes the same size, roll or brightness.
    const vary = 0.72 + rand.next() * 0.62;
    const roll = rand.range(0, Math.PI * 2);

    // 1. core bloom
    q.begin({
      px: muzzle.x, py: muzzle.y, pz: muzzle.z,
      w0: 0.11 * s * vary, h0: 0.11 * s * vary,
      w1: 0.30 * s * vary, h1: 0.30 * s * vary,
      r: colour.r, g: colour.g, b: colour.b, alpha: 1,
      life: 0.042 + rand.next() * 0.018, cell: CELL.MUZZLE_CORE, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.15, fadeOut: 0.28, soft: 0, intensity: 6.5 * vary, rot: roll,
    });
    q.push();

    // 2. anamorphic star — only on some shots, which is what makes automatic
    //    fire read as a sequence of distinct events rather than a loop.
    if (rand.bool(prof.starChance)) {
      q.begin({
        px: muzzle.x, py: muzzle.y, pz: muzzle.z,
        w0: 0.30 * s * vary, h0: 0.30 * s * vary,
        w1: 0.62 * s * vary, h1: 0.62 * s * vary,
        r: colour.r, g: colour.g * 0.98, b: colour.b * 0.92, alpha: 1,
        life: 0.05, cell: CELL.MUZZLE_STAR, frames: 1,
        mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
        fadeIn: 0.1, fadeOut: 0.2, soft: 0, intensity: 4.0,
        rot: roll + rand.range(-0.4, 0.4),
      });
      q.push();
    }

    // 3. cone of burning gas along the bore
    const coneLen = prof.coneLength * vary;
    q.begin({
      px: muzzle.x + fwd.x * coneLen * 0.5,
      py: muzzle.y + fwd.y * coneLen * 0.5,
      pz: muzzle.z + fwd.z * coneLen * 0.5,
      ax: fwd.x, ay: fwd.y, az: fwd.z,
      w0: coneLen * 0.55, h0: coneLen, w1: coneLen * 0.72, h1: coneLen * 1.15,
      r: colour.r, g: colour.g, b: colour.b, alpha: 0.95,
      life: 0.05, cell: CELL.MUZZLE_CONE, frames: 1,
      mode: QUAD_MODE.AXIAL, blend: QUAD_BLEND.ADD,
      fadeIn: 0.12, fadeOut: 0.25, soft: 0, intensity: 4.5,
    });
    q.push();

    // 4. petals of unburnt powder
    if (rand.bool(0.65)) {
      q.begin({
        px: muzzle.x + fwd.x * 0.04, py: muzzle.y + fwd.y * 0.04, pz: muzzle.z + fwd.z * 0.04,
        w0: 0.16 * s, h0: 0.16 * s, w1: 0.42 * s * vary, h1: 0.42 * s * vary,
        r: colour.r, g: colour.g * 0.85, b: colour.b * 0.65, alpha: 0.9,
        life: 0.055, cell: CELL.MUZZLE_PETAL, frames: 1,
        mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
        fadeIn: 0.1, fadeOut: 0.2, soft: 0, intensity: 4.5,
        rot: rand.range(0, 6.28),
      });
      q.push();
    }

    // 5. expanding smoke ring pushed out ahead of the gas
    q.begin({
      px: muzzle.x + fwd.x * 0.05, py: muzzle.y + fwd.y * 0.05, pz: muzzle.z + fwd.z * 0.05,
      vx: fwd.x * 2.4, vy: fwd.y * 2.4 + 0.3, vz: fwd.z * 2.4,
      ax: fwd.x, ay: fwd.y, az: fwd.z,
      w0: 0.10 * s, h0: 0.10 * s, w1: 0.85 * s * prof.smoke, h1: 0.85 * s * prof.smoke,
      r: 0.55, g: 0.53, b: 0.50, alpha: 0.30 * prof.smoke,
      life: 0.42, cell: CELL.SMOKE_RING, frames: 1,
      mode: QUAD_MODE.ORIENTED, blend: QUAD_BLEND.ALPHA, lit: true,
      fadeIn: 0.08, fadeOut: 0.25, soft: 0.3, drag: 3.2,
      rot: rand.range(0, 6.28),
    });
    q.push();

    // 6. the light. This is what makes the weapon, the wall and the player's
    //    hands all agree that a flash happened.
    w.light({
      x: muzzle.x, y: muzzle.y, z: muzzle.z,
      color: prof.color,
      intensity: prof.lightIntensity * vary,
      radius: prof.lightRadius,
      lifetime: 0.075,
      decay: 'flash',
    });
    void shotIndex;
    void firstPerson;
  }

  private suppressedFlash(w: FxWorld, prof: MuzzleProfile): void {
    const rand = w.rand;
    const q = w.quads;
    const s = prof.scale * 0.42;
    q.begin({
      px: muzzle.x, py: muzzle.y, pz: muzzle.z,
      w0: 0.05 * s, h0: 0.05 * s, w1: 0.14 * s, h1: 0.14 * s,
      r: 1.0, g: 0.62, b: 0.30, alpha: 0.85,
      life: 0.035, cell: CELL.MUZZLE_CORE, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.2, fadeOut: 0.3, soft: 0, intensity: 2.2,
      rot: rand.range(0, 6.28),
    });
    q.push();
    w.light({
      x: muzzle.x, y: muzzle.y, z: muzzle.z,
      color: 0xff9a50, intensity: prof.lightIntensity * 0.14,
      radius: prof.lightRadius * 0.45, lifetime: 0.05, decay: 'flash',
    });
  }

  /** Hot gas and unburnt powder leaving the crown. */
  private gas(w: FxWorld, prof: MuzzleProfile, suppressed: boolean): void {
    const { particles: g, rand } = w;
    const speed = prof.gasSpeed * (suppressed ? 0.35 : 1);

    if (!suppressed) {
      g.begin({
        cell: CELL.FLAME, frames: CELL.FLAME_FRAMES, model: MODEL.HOT,
        flags: FLAG.ADD | FLAG.ANIM | FLAG.NOSOFT,
        r: 1.0, g: 0.66, b: 0.30, opacity: 0.85, emissive: 1.0,
        drag: 9.0, gravity: -0.15,
      });
      g.pushMany(5 * prof.scale, (d) => {
        tmp.copy(fwd).multiplyScalar(0.8 + rand.next() * 0.5)
          .addScaledVector(right, rand.signed() * 0.30)
          .addScaledVector(up, rand.signed() * 0.30).normalize();
        d.px = muzzle.x + tmp.x * 0.04;
        d.py = muzzle.y + tmp.y * 0.04;
        d.pz = muzzle.z + tmp.z * 0.04;
        const s = speed * (0.5 + rand.next() * 0.8);
        d.vx = tmp.x * s; d.vy = tmp.y * s; d.vz = tmp.z * s;
        d.sizeBegin = 0.06 * prof.scale;
        d.sizeEnd = 0.26 * prof.scale;
        d.lifetime = 0.07 + rand.next() * 0.05;
        d.rot = rand.range(0, 6.28);
        d.spin = rand.signed() * 5;
      });

      // Unburnt powder: bright specks thrown forward that die almost at once.
      g.begin({
        cell: CELL.SPARK_DOT, frames: 1, model: MODEL.HOT,
        flags: FLAG.ADD | FLAG.STRETCH | FLAG.HOTRAMP | FLAG.FLICKER | FLAG.NOSOFT,
        r: 1.0, g: 0.80, b: 0.42, opacity: 1, emissive: 1.2,
        drag: 2.4, gravity: 0.9,
      });
      g.pushMany(9 * prof.scale, (d) => {
        tmp.copy(fwd).multiplyScalar(0.75 + rand.next() * 0.5)
          .addScaledVector(right, rand.signed() * 0.5)
          .addScaledVector(up, rand.signed() * 0.5).normalize();
        d.px = muzzle.x; d.py = muzzle.y; d.pz = muzzle.z;
        const s = speed * (0.6 + rand.next() * 1.1);
        d.vx = tmp.x * s; d.vy = tmp.y * s; d.vz = tmp.z * s;
        d.sizeBegin = 0.012; d.sizeEnd = 0.004;
        d.lifetime = 0.16 + rand.next() * 0.22;
      });
    } else {
      // A suppressor turns the flash into a soft, gassy exhale.
      g.begin({
        cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
        flags: FLAG.ADD | FLAG.ANIM | FLAG.FADEIN,
        r: 0.35, g: 0.33, b: 0.31, opacity: 0.28,
        drag: 4.5, gravity: -0.18, turbulence: 0.6,
      });
      g.pushMany(7, (d) => {
        tmp.copy(fwd).multiplyScalar(0.8 + rand.next() * 0.5)
          .addScaledVector(right, rand.signed() * 0.4)
          .addScaledVector(up, rand.signed() * 0.4).normalize();
        d.px = muzzle.x; d.py = muzzle.y; d.pz = muzzle.z;
        const s = speed * (0.6 + rand.next());
        d.vx = tmp.x * s; d.vy = tmp.y * s; d.vz = tmp.z * s;
        d.sizeBegin = 0.03; d.sizeEnd = 0.24 + rand.next() * 0.2;
        d.lifetime = 0.35 + rand.next() * 0.4;
        d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 2;
      });
    }
  }

  private smoke(w: FxWorld, prof: MuzzleProfile, suppressed: boolean, heat: number): void {
    const { particles: g, rand } = w;
    const amount = prof.smoke * (suppressed ? 1.4 : 1) * (0.6 + heat * 0.9);
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.42, g: 0.41, b: 0.40, opacity: 0.10 + heat * 0.10,
      drag: 2.2, gravity: -0.12, turbulence: 1.1,
    });
    g.pushMany(2 * amount, (d) => {
      tmp.copy(fwd).multiplyScalar(0.5 + rand.next() * 0.6)
        .addScaledVector(right, rand.signed() * 0.5)
        .addScaledVector(up, rand.next() * 0.6);
      d.px = muzzle.x + tmp.x * 0.06;
      d.py = muzzle.y + tmp.y * 0.06;
      d.pz = muzzle.z + tmp.z * 0.06;
      d.vx = tmp.x * 1.4; d.vy = tmp.y * 1.4 + 0.35; d.vz = tmp.z * 1.4;
      d.sizeBegin = 0.05; d.sizeEnd = 0.42 + rand.next() * 0.35;
      d.lifetime = 0.9 + rand.next() * 1.2;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.8;
    });
  }

  private tracer(w: FxWorld, prof: MuzzleProfile, direction: THREE.Vector3): void {
    const q = w.quads;
    const rand = w.rand;
    colour.set(prof.tracerColor);
    const speed = prof.tracerSpeed * (0.94 + rand.next() * 0.12);
    // Length follows the distance covered in a frame, which is what makes a
    // tracer look like a moving object rather than a fixed dash.
    const len = clamp(speed * 0.022, 2.5, 12);
    const life = 0.42;

    q.begin({
      px: muzzle.x, py: muzzle.y, pz: muzzle.z,
      vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
      ax: direction.x * len, ay: direction.y * len, az: direction.z * len,
      w0: 0.42, h0: 1, w1: 0.30, h1: 1,
      r: colour.r, g: colour.g, b: colour.b, alpha: 0.95,
      life, cell: CELL.RAIN, frames: 1,
      mode: QUAD_MODE.BEAM, blend: QUAD_BLEND.ADD,
      fadeIn: 0.02, fadeOut: 0.55, soft: 0.4, intensity: 4.2,
    });
    q.push();

    // A soft glow riding the head sells the round as genuinely incandescent.
    q.begin({
      px: muzzle.x + direction.x * len, py: muzzle.y + direction.y * len, pz: muzzle.z + direction.z * len,
      vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
      w0: 0.30, h0: 0.30, w1: 0.22, h1: 0.22,
      r: colour.r, g: colour.g, b: colour.b, alpha: 0.8,
      life, cell: CELL.GLOW_SOFT, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.02, fadeOut: 0.5, soft: 0.3, intensity: 2.4,
    });
    q.push();
  }

  /* ------------------------------------------------------------------ heat */

  update(dt: number, w: FxWorld): void {
    this.hazeTimer -= dt;
    for (const [id, h] of this.heat) {
      h.heat = Math.max(0, h.heat - dt * 0.22);
      if (h.heat <= 0.001) { this.heat.delete(id); continue; }
      // Above the threshold the barrel shimmers. It is refractive when the
      // renderer can give us a scene copy, and a soft additive haze otherwise.
      if (h.heat > 0.5 && this.hazeTimer <= 0 && w.clock - h.lastShot < 6) {
        this.hazeTimer = 0.07;
        this.shimmer(w, h);
      }
    }
  }

  private shimmer(w: FxWorld, h: BarrelHeat): void {
    const q = w.quads;
    const rand = w.rand;
    const refract = q.refractionReady;
    const heat = h.heat;
    q.begin({
      px: h.mx - h.fx * 0.18 + rand.signed() * 0.02,
      py: h.my - h.fy * 0.18 + 0.03,
      pz: h.mz - h.fz * 0.18 + rand.signed() * 0.02,
      vy: 0.55 + rand.next() * 0.3,
      w0: 0.10, h0: 0.10, w1: 0.30, h1: 0.36,
      r: 1, g: 0.92, b: 0.85, alpha: refract ? 0.9 : 0.06 * heat,
      life: 0.55, cell: rand.bool() ? CELL.HAZE_A : CELL.HAZE_B, frames: 1,
      mode: QUAD_MODE.BILLBOARD,
      blend: refract ? QUAD_BLEND.REFRACT : QUAD_BLEND.ADD,
      fadeIn: 0.3, fadeOut: 0.4, soft: 0.4, intensity: heat,
      rot: rand.range(0, 6.28), spin: rand.signed() * 0.6,
    });
    q.push();
  }
}
