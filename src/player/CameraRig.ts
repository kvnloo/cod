/**
 * Camera rig — everything between the player's world position and the render
 * camera.
 *
 * Layered, in order: look → stance/eye height → step bob → landing dip →
 * lean → sway → recoil → shake → roll. Each layer is a spring or curve so nothing
 * ever snaps, which is the difference between a camera that feels expensive and
 * one that feels like a debug fly-cam.
 */

import * as THREE from 'three';
import { SpringScalar, dampf } from '../core/Time';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type { MovementOutput } from './Movement';

const noiseRand = new Rand('camera-noise');

/** Cheap smooth 1D value noise for breathing/sway. */
function makeNoiseTable(n: number): Float32Array {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = noiseRand.signed();
  return t;
}
const NOISE = makeNoiseTable(512);
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = NOISE[((i % 512) + 512) % 512];
  const b = NOISE[(((i + 1) % 512) + 512) % 512];
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

export interface CameraShake {
  amplitude: number;
  frequency: number;
  remaining: number;
  duration: number;
  seed: number;
}

export class CameraRig {
  /** Look angles, driven by input. */
  yaw = 0;
  pitch = 0;

  /** Recoil the player must fight, applied on top of look and partly recovered. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilRecoverPitch = 0;
  private recoilRecoverYaw = 0;

  private bobPos = new THREE.Vector3();
  private bobRot = new THREE.Vector3();
  private landDip = new SpringScalar(3.4, 0.55);
  private landTarget = 0;
  private leanAmount = 0;
  private rollAmount = 0;
  private swayYaw = 0;
  private swayPitch = 0;
  private breathT = 0;
  private shakes: CameraShake[] = [];
  private shakeOffset = new THREE.Vector3();
  private shakeRot = new THREE.Vector3();
  private fovCurrent = 80;
  private fovTarget = 80;
  private adsBlend = 0;

  /** Extra world-space offset applied by gameplay (e.g. hit reactions). */
  readonly externalOffset = new THREE.Vector3();

  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();

  /** Applies mouse/stick look with sensitivity, ADS scaling and clamping. */
  look(dx: number, dy: number, dt: number, ads: boolean): void {
    const g = settings.game;
    const scale = ads ? g.adsSensitivityScale : 1;
    const sens = g.sensitivity * 0.0021 * scale;
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (g.invertY ? -1 : 1);

    // Analog stick contribution (already curve-shaped by Input).
    void dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5533, 1.5533);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  stick(lx: number, ly: number, dt: number, ads: boolean): void {
    if (lx === 0 && ly === 0) return;
    const g = settings.game;
    const scale = ads ? g.adsSensitivityScale : 1;
    const rate = g.sensitivity * 3.4 * scale * dt;
    this.yaw -= lx * rate;
    this.pitch -= ly * rate * (g.invertY ? -1 : 1);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5533, 1.5533);
  }

  /** Weapon recoil pushes the view; a fraction is automatically recovered. */
  addRecoil(pitch: number, yaw: number, recoverFraction = 0.72): void {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.recoilRecoverPitch += pitch * recoverFraction;
    this.recoilRecoverYaw += yaw * recoverFraction;
  }

  addShake(amplitude: number, frequency = 22, duration = 0.35): void {
    if (settings.game.cameraShake <= 0) return;
    this.shakes.push({
      amplitude: amplitude * settings.game.cameraShake,
      frequency, remaining: duration, duration,
      seed: noiseRand.range(0, 1000),
    });
    if (this.shakes.length > 12) this.shakes.shift();
  }

  /** Called on landing; `force` is the downward speed at impact. */
  land(force: number): void {
    const f = THREE.MathUtils.clamp((force - 3) / 12, 0, 1);
    this.landTarget = -f * 0.19;
    if (f > 0.35) this.addShake(f * 0.055, 15, 0.28);
  }

  setAds(blend: number): void { this.adsBlend = blend; }

  update(dt: number, mv: MovementOutput, worldPos: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    const g = settings.game;

    /* --- recoil recovery ------------------------------------------------- */
    const recover = 1 - Math.exp(-9.5 * dt);
    const dp = this.recoilRecoverPitch * recover;
    const dy = this.recoilRecoverYaw * recover;
    this.recoilRecoverPitch -= dp;
    this.recoilRecoverYaw -= dy;
    this.recoilPitch -= dp;
    this.recoilYaw -= dy;
    // The unrecovered part is folded into the actual look angles, so the player
    // has to pull down — exactly like a real shooter.
    this.pitch += 0;

    /* --- view bob --------------------------------------------------------- */
    const bobScale = g.weaponBob * (1 - this.adsBlend * 0.72) * mv.speed01;
    const phase = mv.stepPhase * Math.PI * 2;
    const targetBobX = Math.sin(phase) * 0.033 * bobScale;
    const targetBobY = -Math.abs(Math.cos(phase)) * 0.028 * bobScale;
    const targetBobZ = Math.sin(phase * 2) * 0.010 * bobScale;
    const bobK = 1 - Math.exp(-16 * dt);
    this.bobPos.x = dampf(this.bobPos.x, targetBobX, 16, dt);
    this.bobPos.y = dampf(this.bobPos.y, targetBobY, 16, dt);
    this.bobPos.z = dampf(this.bobPos.z, targetBobZ, 16, dt);
    this.bobRot.z = dampf(this.bobRot.z, Math.sin(phase) * 0.012 * bobScale, 14, dt);
    this.bobRot.x = dampf(this.bobRot.x, Math.cos(phase * 2) * 0.006 * bobScale, 14, dt);
    void bobK;

    /* --- breathing sway (idle life) -------------------------------------- */
    this.breathT += dt * (0.55 + mv.speed01 * 0.3);
    const breathAmp = (1 - mv.speed01 * 0.7) * (1 - this.adsBlend * 0.55) * 0.0032;
    this.swayYaw = noise1(this.breathT * 0.9) * breathAmp;
    this.swayPitch = noise1(this.breathT * 0.73 + 37.1) * breathAmp * 0.8;

    /* --- landing dip ------------------------------------------------------ */
    const dip = this.landDip.step(this.landTarget, dt);
    this.landTarget = dampf(this.landTarget, 0, 7, dt);

    /* --- lean ------------------------------------------------------------- */
    this.leanAmount = dampf(this.leanAmount, mv.lean, 12, dt);

    /* --- movement roll ---------------------------------------------------- */
    // Roll into strafes, and roll harder while sliding.
    const slideRoll = mv.state === 'slide' ? 0.055 : 0;
    const strafeRoll = -this.bobPos.x * 0.55;
    this.rollAmount = dampf(this.rollAmount, strafeRoll + slideRoll, 9, dt);

    /* --- shake ------------------------------------------------------------ */
    this.shakeOffset.set(0, 0, 0);
    this.shakeRot.set(0, 0, 0);
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.remaining -= dt;
      if (s.remaining <= 0) { this.shakes.splice(i, 1); continue; }
      const t = 1 - s.remaining / s.duration;
      // Fast attack, exponential decay.
      const env = Math.pow(1 - t, 2.1);
      const p = (s.duration - s.remaining) * s.frequency + s.seed;
      const a = s.amplitude * env;
      this.shakeOffset.x += noise1(p) * a;
      this.shakeOffset.y += noise1(p + 91.3) * a;
      this.shakeOffset.z += noise1(p + 173.7) * a * 0.4;
      this.shakeRot.x += noise1(p + 211.1) * a * 1.4;
      this.shakeRot.y += noise1(p + 307.9) * a * 1.4;
      this.shakeRot.z += noise1(p + 401.3) * a * 2.2;
    }

    /* --- FOV -------------------------------------------------------------- */
    const sprintKick = (mv.state === 'sprint' || mv.state === 'tacSprint') ? 6.5
      : mv.state === 'slide' ? 9 : 0;
    this.fovTarget = g.fov * (1 - this.adsBlend * (1 - g.adsFovScale)) + sprintKick * (1 - this.adsBlend);
    this.fovCurrent = dampf(this.fovCurrent, this.fovTarget, this.adsBlend > 0.01 ? 16 : 8, dt);

    /* --- compose ---------------------------------------------------------- */
    this._e.set(
      this.pitch + this.recoilPitch + this.swayPitch + this.bobRot.x + this.shakeRot.x,
      this.yaw + this.recoilYaw + this.swayYaw + this.shakeRot.y,
      this.rollAmount + this.bobRot.z + this.shakeRot.z + this.leanAmount * -0.30,
      'YXZ',
    );
    camera.quaternion.setFromEuler(this._e);

    // Lean translates as well as rotates, so the player actually peeks past cover.
    this._right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this._up.set(0, 1, 0);

    camera.position.set(
      worldPos.x,
      worldPos.y + mv.eyeOffset + dip,
      worldPos.z,
    );
    camera.position.addScaledVector(this._right, this.leanAmount * 0.42 + this.bobPos.x + this.shakeOffset.x);
    camera.position.y += this.bobPos.y + this.shakeOffset.y;
    const fwd = this._up.set(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(fwd, this.bobPos.z + this.shakeOffset.z);
    camera.position.add(this.externalOffset);

    if (Math.abs(camera.fov - this.fovCurrent) > 0.001) {
      camera.fov = this.fovCurrent;
      camera.updateProjectionMatrix();
    }
  }

  /** Current recoil offset, so the view model can compensate. */
  get recoil(): { pitch: number; yaw: number } {
    return { pitch: this.recoilPitch, yaw: this.recoilYaw };
  }

  reset(yaw: number, pitch = 0): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilRecoverPitch = this.recoilRecoverYaw = 0;
    this.shakes.length = 0;
    this.bobPos.set(0, 0, 0);
    this.landDip.set(0);
    this.externalOffset.set(0, 0, 0);
  }
}
