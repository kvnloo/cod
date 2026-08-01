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

/**
 * Hard ceiling on the *transient* recoil offset, radians.
 *
 * The transient always decays to zero, so under any sane weapon it settles far
 * below this (a 720 rpm AR steady-states around 0.6°). The clamp exists so a
 * pathological rate-of-fire or a scripted burst can never walk the view off the
 * world before recovery catches up — an unbounded view offset is a bug you only
 * find in the hands, which is exactly what happened here.
 */
const MAX_TRANSIENT = 6 * (Math.PI / 180);

/**
 * Exponential rate at which the transient returns, 1/s. 9.5 puts 63% of a kick
 * back in 105 ms and 95% in 315 ms, which is the CoD "the gun settles between
 * bursts, not between shots" cadence.
 */
const RECOIL_RECOVERY_LAMBDA = 9.5;

/** Matches the look clamp — just under 89°, so the view never gimbals. */
const PITCH_LIMIT = 1.5533;

export class CameraRig {
  /** Look angles, driven by input. */
  yaw = 0;
  pitch = 0;

  /**
   * Recoil, split into the two halves that behave completely differently.
   *
   * `recoilPitch` / `recoilYaw` are the *transient*: the part of the kick that
   * comes back on its own. It decays to zero, so it is bounded by construction
   * and costs the player nothing.
   *
   * The rest — `1 - recoverFraction` of every impulse — is *permanent*, and is
   * folded straight into `yaw` / `pitch` the moment the shot goes off. That is
   * the whole point of a recoil pattern: your aim really moves, you really have
   * to pull down, and because the movement is authored and deterministic it is
   * learnable. Parking it in an offset that is never folded back (the old
   * behaviour) gives you the worst of both — the aim drifts, the player cannot
   * correct for it because the crosshair says otherwise, and it accumulates
   * without bound across a magazine.
   */
  private recoilPitch = 0;
  private recoilYaw = 0;
  /** Running total of the permanent part, for telemetry and tests. Degrees. */
  private foldedPitchDeg = 0;
  private foldedYawDeg = 0;
  /**
   * Seconds of recoil recovery the fixed step has applied *ahead* of the render
   * frame. A running ledger, not a per-frame flag: at 540 fps four frames out of
   * five run no fixed step at all, so a flag that resets every frame lets those
   * frames decay again on time the fixed step already paid for — measured at
   * 1.78× the correct recovery rate, which showed up as a 60-round spray peaking
   * 22% lower at 540 fps than at 120.
   */
  private recoilCredit = 0;

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

  /**
   * Smoothed prediction-error offset, written by the netcode's reconciler.
   *
   * When the server disagrees with a predicted position the *simulation* snaps
   * immediately — anything else and every later step is computed from a
   * position the server already rejected. The view must not snap with it, so
   * the reconciler parks the difference here and decays it to zero over ~100 ms.
   * Correct the error, not the player's eyes.
   */
  readonly predictionOffset = new THREE.Vector3();

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
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
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
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Weapon recoil. `recoverFraction` of the kick is transient and returns by
   * itself; the remainder is folded into the actual look angles immediately.
   *
   * Called from the weapon system's *fixed* step, so the impulse times are
   * frame-rate independent and reproducible for a seed.
   */
  addRecoil(pitch: number, yaw: number, recoverFraction = 0.72): void {
    const recover = THREE.MathUtils.clamp(recoverFraction, 0, 1);
    const keep = 1 - recover;

    // Permanent half → the player's real aim.
    if (keep > 0) {
      const dp = pitch * keep;
      const dy = yaw * keep;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dp, -PITCH_LIMIT, PITCH_LIMIT);
      this.yaw += dy;
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
      this.foldedPitchDeg += dp * (180 / Math.PI);
      this.foldedYawDeg += dy * (180 / Math.PI);
    }

    // Transient half → decays back to zero in `stepRecoil`.
    this.recoilPitch = THREE.MathUtils.clamp(
      this.recoilPitch + pitch * recover, -MAX_TRANSIENT, MAX_TRANSIENT,
    );
    this.recoilYaw = THREE.MathUtils.clamp(
      this.recoilYaw + yaw * recover, -MAX_TRANSIENT, MAX_TRANSIENT,
    );
  }

  /**
   * Advances recoil recovery by `dt`.
   *
   * Driven from the weapon system's fixed step so recovery is identical at 30
   * and 540 fps; `update` only tops up whatever time the fixed step did not
   * already cover, so the two can never double-count.
   */
  stepRecoil(dt: number): void {
    // 0.25 s ceiling: the ledger can only ever run a frame or two ahead, and a
    // clamp means a pathological caller cannot bank credit that suppresses
    // recovery later.
    this.recoilCredit = Math.min(0.25, this.recoilCredit + dt);
    this.decayRecoil(dt);
  }

  private decayRecoil(dt: number): void {
    if (dt <= 0) return;
    const k = Math.exp(-RECOIL_RECOVERY_LAMBDA * dt);
    this.recoilPitch *= k;
    this.recoilYaw *= k;
    if (Math.abs(this.recoilPitch) < 1e-7) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-7) this.recoilYaw = 0;
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
    // The fixed step normally owns this (see `stepRecoil`) and banks credit for
    // the time it covered; the frame spends that credit first and only decays
    // the shortfall. At 30 fps four fixed steps pay for the whole frame; at
    // 540 fps one step's credit pays for the next four-and-a-half frames. Either
    // way the total decay time equals elapsed time exactly once, which is what
    // makes recovery frame-rate independent.
    const rest = dt - this.recoilCredit;
    if (rest > 0) { this.recoilCredit = 0; this.decayRecoil(rest); }
    else this.recoilCredit = -rest;

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
    camera.position.add(this.predictionOffset);

    if (Math.abs(camera.fov - this.fovCurrent) > 0.001) {
      camera.fov = this.fovCurrent;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * The *transient* recoil offset — what the view is carrying right now on top
   * of the look angles, and what an aim-assist or a test rig should subtract to
   * find the true aim point. Always decays to zero.
   */
  get recoil(): { pitch: number; yaw: number } {
    return { pitch: this.recoilPitch, yaw: this.recoilYaw };
  }

  /**
   * Degrees of recoil permanently folded into the look angles since the last
   * `reset` / `clearRecoilTelemetry`. This is the half the player has to fight,
   * and separating it from `recoil` is what makes "recovered vs folded"
   * measurable instead of a matter of opinion.
   */
  get recoilFoldedDeg(): { pitch: number; yaw: number } {
    return { pitch: this.foldedPitchDeg, yaw: this.foldedYawDeg };
  }

  clearRecoilTelemetry(): void { this.foldedPitchDeg = 0; this.foldedYawDeg = 0; }

  /**
   * Re-seeds the shared camera-noise stream.
   *
   * Shake and breathing sway ride on a module-level `Rand`, so two otherwise
   * identical sprays taken in one session compose slightly different camera
   * orientations — and since a round is aimed from the composed camera, the
   * bullets differ too. That is correct at runtime (the stream is seeded and a
   * fresh capture reproduces exactly) but it makes "fire the same spray twice"
   * impossible to check inside one session. This is the door for that test.
   */
  resetNoise(seed: number | string = 'camera-noise'): void { noiseRand.seed(seed); }

  reset(yaw: number, pitch = 0): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilCredit = 0;
    this.foldedPitchDeg = this.foldedYawDeg = 0;
    this.shakes.length = 0;
    this.bobPos.set(0, 0, 0);
    // Everything that composes the final orientation goes back to a known state,
    // not just the obvious layers: a reset that leaves the breathing phase or a
    // half-decayed bob behind is a reset that cannot be verified.
    this.bobRot.set(0, 0, 0);
    this.breathT = 0;
    this.swayYaw = this.swayPitch = 0;
    this.leanAmount = this.rollAmount = 0;
    this.shakeOffset.set(0, 0, 0);
    this.shakeRot.set(0, 0, 0);
    this.landDip.set(0);
    this.externalOffset.set(0, 0, 0);
    this.predictionOffset.set(0, 0, 0);
  }
}
