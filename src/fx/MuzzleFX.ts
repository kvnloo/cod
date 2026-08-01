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
import { hasWeapon, weaponDef } from '../weapons/Catalog';

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
  scale: 1.0, lightIntensity: 26, lightRadius: 9, starChance: 0.6,
  coneLength: 0.55, smoke: 1, gasSpeed: 13, color: 0xffb464,
  casing: 'rifle', ejectSpeed: 2.7, tracerEvery: 4, tracerColor: 0xffd070,
  tracerSpeed: 340, heatPerShot: 0.055, shake: 0.008,
};

const PROFILES: Record<string, MuzzleProfile> = {
  ar: AR,
  smg: { ...AR, scale: 0.78, lightIntensity: 18, coneLength: 0.4, tracerEvery: 5, heatPerShot: 0.05, casing: 'pistol', shake: 0.006 },
  lmg: { ...AR, scale: 1.22, lightIntensity: 34, lightRadius: 11, coneLength: 0.7, tracerEvery: 3, casing: 'lmg', heatPerShot: 0.07, shake: 0.011 },
  sniper: { ...AR, scale: 1.55, lightIntensity: 46, lightRadius: 14, starChance: 0.75, coneLength: 1.05, smoke: 1.6, gasSpeed: 20, tracerEvery: 1, tracerColor: 0xffdc90, heatPerShot: 0.09, shake: 0.026 },
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
   *  weapon's own frame (right, up, forward).
   *
   *  Zero by default: `weapon:fire.origin` is already `viewModel.muzzleWorld()`,
   *  so a non-zero offset floated the flash and brass off the barrel. Callers
   *  that only have a camera origin can still set these. */
  muzzleOffset = new THREE.Vector3(0, 0, 0);
  ejectOffset = new THREE.Vector3(0, 0, 0);

  /** Last resolved muzzle / eject-port world positions (probe + debug). */
  readonly lastMuzzle = new THREE.Vector3();
  readonly lastPort = new THREE.Vector3();
  /** Metres between muzzle crown and eject port on the last shot. */
  lastBrassSeparation = 0;

  private heat = new Map<string, BarrelHeat>();
  private hazeTimer = 0;
  private readonly _ejectScratch = new THREE.Vector3();

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
    // Derive eject-port offset from the authored model points whenever the
    // caller left ejectOffset at zero (the historical default). weapon:fire
    // origin is the muzzle crown, so a zero port offset spawned brass at the
    // tip — the classic "casings flying out the muzzle" failure.
    const savedEject = this._ejectScratch.copy(this.ejectOffset);
    if (this.ejectOffset.lengthSq() < 1e-10) {
      this.applyCatalogEject(weaponId);
    }
    this.frame(origin, direction);
    this.ejectOffset.copy(savedEject);

    this.lastMuzzle.copy(muzzle);
    this.lastPort.copy(port);
    this.lastBrassSeparation = port.distanceTo(muzzle);

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

    // First-person kick is owned by CameraRig.addShake in Weapons.shoot — a
    // second Renderer.addCameraShake here stacked two independent envelopes
    // and fought aim recovery. Third-person / near AI shots still shake.
    if (!firstPerson) {
      const near = clamp(1 - w.distanceToCamera(muzzle.x, muzzle.y, muzzle.z) / 2.5, 0, 1);
      if (near > 0.01) w.shake(prof.shake * near * (suppressed ? 0.5 : 1), 34, 0.12);
    }
  }

  /**
   * Port − muzzle in weapon frame (right, up, forward). Model space is
   * −Z down the bore, so the forward component is `muzzle.z − eject.z`.
   */
  private applyCatalogEject(weaponId: string): void {
    if (!hasWeapon(weaponId)) {
      // Sensible rifle default: ~2.5 cm right, slightly up, half-metre back.
      this.ejectOffset.set(0.026, 0.01, -0.45);
      return;
    }
    const m = weaponDef(weaponId).model;
    const mz = m.muzzle;
    const ej = m.ejectPort;
    this.ejectOffset.set(
      ej[0] - mz[0],
      ej[1] - mz[1],
      mz[2] - ej[2],
    );
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
      fadeIn: 0.15, fadeOut: 0.28, soft: 0, intensity: 8.5 * vary, rot: roll,
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
        life: 0.045 + rand.next() * 0.02, cell: CELL.MUZZLE_STAR, frames: 1,
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

      // Unburnt powder: spawn slightly *ahead* of the crown so ADD+HOT streaks
      // do not stretch across the near field from the muzzle pixel (that path
      // washed ~7% of burst frames red/white). Cap speed and drop STRETCH.
      g.begin({
        cell: CELL.SPARK_DOT, frames: 1, model: MODEL.HOT,
        flags: FLAG.ADD | FLAG.HOTRAMP | FLAG.FLICKER | FLAG.NOSOFT,
        r: 1.0, g: 0.80, b: 0.42, opacity: 1, emissive: 1.2,
        drag: 2.4, gravity: 0.9,
      });
      g.pushMany(9 * prof.scale, (d) => {
        tmp.copy(fwd).multiplyScalar(0.75 + rand.next() * 0.5)
          .addScaledVector(right, rand.signed() * 0.5)
          .addScaledVector(up, rand.signed() * 0.5).normalize();
        // 6–14 cm past the crown along bore + a little scatter.
        const along = 0.06 + rand.next() * 0.08;
        d.px = muzzle.x + fwd.x * along + tmp.x * 0.02;
        d.py = muzzle.y + fwd.y * along + tmp.y * 0.02;
        d.pz = muzzle.z + fwd.z * along + tmp.z * 0.02;
        const s = Math.min(speed, 8) * (0.35 + rand.next() * 0.55);
        d.vx = tmp.x * s; d.vy = tmp.y * s; d.vz = tmp.z * s;
        d.sizeBegin = 0.012; d.sizeEnd = 0.004;
        d.lifetime = 0.12 + rand.next() * 0.14;
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
    // Slightly under the catalogue muzzle velocity so a burst staged for a
    // still has several rounds still in frame ~0.4 s after the first shot.
    // Full 340 m/s emptied the sightline before the harness shutter opened.
    const speed = prof.tracerSpeed * (0.72 + rand.next() * 0.10);
    // Length is ~1.5 frames of travel — long enough to read as motion, short
    // enough that the rod does not look like a laser.
    const len = clamp(speed * 0.028, 3.2, 14);
    const life = 0.85;

    q.begin({
      px: muzzle.x, py: muzzle.y, pz: muzzle.z,
      vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
      ax: direction.x * len, ay: direction.y * len, az: direction.z * len,
      // Readable at 1080p mid-range without reading as a beam weapon.
      w0: 0.34, h0: 1, w1: 0.22, h1: 1,
      r: colour.r, g: colour.g, b: colour.b, alpha: 1.0,
      life, cell: CELL.RAIN, frames: 1,
      mode: QUAD_MODE.BEAM, blend: QUAD_BLEND.ADD,
      // Daylight stills need super-white cores or the rod vanishes into sky.
      fadeIn: 0.01, fadeOut: 0.35, soft: 0.35, intensity: 8.5,
    });
    q.push();

    // Soft glow riding the head — larger and hotter so origin + direction read
    // even when the beam is foreshortened.
    q.begin({
      px: muzzle.x + direction.x * len, py: muzzle.y + direction.y * len, pz: muzzle.z + direction.z * len,
      vx: direction.x * speed, vy: direction.y * speed, vz: direction.z * speed,
      w0: 0.48, h0: 0.48, w1: 0.32, h1: 0.32,
      r: colour.r, g: colour.g * 0.95, b: colour.b * 0.7, alpha: 1.0,
      life, cell: CELL.GLOW_SOFT, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.01, fadeOut: 0.4, soft: 0.25, intensity: 6.0,
    });
    q.push();

    // Dim trail glow at the tail so the full path stays lit for stills.
    q.begin({
      px: muzzle.x, py: muzzle.y, pz: muzzle.z,
      vx: direction.x * speed * 0.96, vy: direction.y * speed * 0.96, vz: direction.z * speed * 0.96,
      ax: direction.x * len * 0.85, ay: direction.y * len * 0.85, az: direction.z * len * 0.85,
      w0: 0.55, h0: 1, w1: 0.18, h1: 1,
      r: colour.r, g: colour.g * 0.7, b: colour.b * 0.35, alpha: 0.55,
      life: life * 0.9, cell: CELL.RAIN, frames: 1,
      mode: QUAD_MODE.BEAM, blend: QUAD_BLEND.ADD,
      fadeIn: 0.0, fadeOut: 0.5, soft: 0.5, intensity: 2.4,
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
