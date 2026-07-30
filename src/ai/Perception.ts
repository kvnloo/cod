/**
 * Perception: sight, hearing, and memory.
 *
 * The design goal is *readability* — the player must be able to tell what the
 * enemy knows. That means:
 *
 *  - awareness is a meter, never a boolean. Walking into a guard's peripheral
 *    vision at 40 m gives you a second and a half before he is sure, and he
 *    telegraphs it (idle → suspicious → searching → combat, each with a callout
 *    and an `ai:alert` event).
 *  - visibility is a *fraction*, sampled at several points on the target's body,
 *    so leaning out from behind a crate only exposes part of you and only fills
 *    the meter partially.
 *  - darkness matters. Light level at the target modulates the fill rate, so
 *    shadow is a real tactic and a muzzle flash is a real mistake.
 *  - the enemy remembers. Losing sight leaves a last-known position that decays
 *    in confidence and is extrapolated along your last velocity, which is what
 *    makes "he pushed where I was going, not where I was" possible.
 */

import * as THREE from 'three';
import type { PhysicsAPI, RayHit } from '../physics/types';
import { MASK_SIGHT } from '../physics/types';
import { makeHit, clamp01, falloff, smoothstep } from './Util';
import type { AlertState, DifficultyProfile, SoundStimulus, TargetLike } from './types';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _hit: RayHit = makeHit();

/* --------------------------------------------------------------- light probe */

interface DirLightSample { dir: THREE.Vector3; intensity: number }
interface PointLightSample { pos: THREE.Vector3; intensity: number; range: number }

/**
 * Cheap scene light sampler.
 *
 * Rather than reading the shadow map (which lives in the render module and is
 * not exposed), this walks the scene graph for lights once every couple of
 * seconds and answers "how lit is this point" with one shadow ray per
 * directional light. That is enough for stealth to read correctly and costs
 * nothing per agent per frame.
 */
export class LightProbe {
  private dirs: DirLightSample[] = [];
  private points: PointLightSample[] = [];
  ambient = 0.25;
  /** Illumination that maps to "fully lit". */
  reference = 3.2;
  private lastScan = -1e9;

  scan(scene: THREE.Object3D, now: number, force = false): void {
    if (!force && now - this.lastScan < 2.0) return;
    this.lastScan = now;
    this.dirs.length = 0;
    this.points.length = 0;
    this.ambient = 0.06;

    scene.traverse((o) => {
      const l = o as THREE.Light;
      if (!l.isLight || l.visible === false) return;
      const intensity = l.intensity;
      if (intensity <= 0) return;
      const type = l.type;
      if (type === 'DirectionalLight') {
        const dl = l as THREE.DirectionalLight;
        dl.getWorldPosition(_v0);
        dl.target.getWorldPosition(_v1);
        const dir = new THREE.Vector3().subVectors(_v0, _v1);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        dir.normalize();
        this.dirs.push({ dir, intensity });
      } else if (type === 'HemisphereLight') {
        this.ambient += intensity * 0.55;
      } else if (type === 'AmbientLight') {
        this.ambient += intensity;
      } else if (type === 'PointLight' || type === 'SpotLight') {
        const pl = l as THREE.PointLight;
        const pos = new THREE.Vector3();
        pl.getWorldPosition(pos);
        const range = pl.distance > 0 ? pl.distance : 14;
        this.points.push({ pos, intensity, range });
        if (this.points.length > 24) this.points.shift();
      }
    });
    if (this.dirs.length === 0 && this.points.length === 0 && this.ambient < 0.1) {
      // Nothing found (renderer owns the lights, or a debug scene stripped them).
      // Assume normal daylight rather than blinding every agent.
      this.ambient = 1.4;
    }
  }

  /** 0..1 light level at a world point. */
  sample(point: THREE.Vector3, physics: PhysicsAPI | null): number {
    let lum = this.ambient;
    for (const d of this.dirs) {
      if (physics && physics.ready) {
        _v0.copy(point).addScaledVector(d.dir, 0.12);
        _v1.copy(point).addScaledVector(d.dir, 60);
        if (!physics.lineOfSight(_v0, _v1, MASK_SIGHT)) continue;
      }
      lum += d.intensity;
    }
    for (const p of this.points) {
      const d = p.pos.distanceTo(point);
      if (d > p.range) continue;
      const f = 1 - d / p.range;
      lum += p.intensity * f * f * 0.35;
    }
    return clamp01(lum / this.reference) * 0.94 + 0.06;
  }
}

/* ------------------------------------------------------------------ hearing */

interface HeardSound {
  position: THREE.Vector3;
  strength: number;
  kind: SoundStimulus['kind'];
  time: number;
  fromTarget: boolean;
}

/* --------------------------------------------------------------- perception */

export interface PerceptionTuning {
  /** Full field of view, degrees. Human-ish, generous enough to feel fair. */
  fovDeg: number;
  /** Inner cone where attention is focused and awareness fills fastest. */
  focusFovDeg: number;
  /** Maximum sighting distance in good light. */
  sightRange: number;
  /** Distance at which the falloff starts. */
  clearRange: number;
  /** Inside this radius a target is noticed even outside the cone. */
  proximityRange: number;
  /** Base awareness gain per second under ideal conditions. */
  gain: number;
  /** Awareness lost per second with no contact, in combat. */
  combatDecay: number;
  /** Awareness lost per second with no contact, when merely suspicious. */
  idleDecay: number;
  /** Seconds of memory before a last-known position is worthless. */
  memory: number;
}

export const DEFAULT_PERCEPTION: PerceptionTuning = {
  fovDeg: 130,
  focusFovDeg: 46,
  sightRange: 95,
  clearRange: 28,
  proximityRange: 5.5,
  gain: 2.35,
  combatDecay: 0.085,
  idleDecay: 0.34,
  memory: 22,
};

export class Perception {
  tuning: PerceptionTuning = { ...DEFAULT_PERCEPTION };

  /** 0..1. Fills with contact, drains without. */
  awareness = 0;
  state: AlertState = 'idle';
  /** Fraction of body sample points with clear line of sight, 0..1. */
  visibility = 0;
  /** Smoothed visibility — what behaviour reads, so it does not chatter. */
  exposure = 0;
  hasLOS = false;
  distance = Infinity;
  /** Angle between facing and the target, radians. */
  bearing = Math.PI;
  lightLevel = 1;

  /** Seconds since the target was last actually seen. */
  timeSinceSeen = 1e9;
  /** Seconds since anything at all raised suspicion. */
  timeSinceStimulus = 1e9;
  readonly lastKnown = new THREE.Vector3();
  readonly lastKnownVelocity = new THREE.Vector3();
  /** 0..1 — how much the last-known position is worth acting on. */
  confidence = 0;
  hasContact = false;
  /** Set when the meter crosses a threshold this tick, for callouts. */
  justAlerted = false;
  justLost = false;

  /** Point the agent wants to look at when it has no visual. */
  readonly interest = new THREE.Vector3();
  hasInterest = false;

  private sounds: HeardSound[] = [];
  private soundCursor = 0;
  private lightTimer = 0;
  private sampleCursor = 0;
  private samplePoints: THREE.Vector3[] = [];
  private sampleVisible: Float32Array = new Float32Array(8);
  private seenAtLeastOnce = false;

  constructor() {
    for (let i = 0; i < 8; i++) this.samplePoints.push(new THREE.Vector3());
    for (let i = 0; i < 8; i++) this.sounds.push({
      position: new THREE.Vector3(), strength: 0, kind: 'impact', time: -1e9, fromTarget: false,
    });
  }

  reset(): void {
    this.awareness = 0;
    this.state = 'idle';
    this.visibility = 0;
    this.exposure = 0;
    this.hasLOS = false;
    this.confidence = 0;
    this.hasContact = false;
    this.timeSinceSeen = 1e9;
    this.timeSinceStimulus = 1e9;
    this.hasInterest = false;
    this.seenAtLeastOnce = false;
    for (const s of this.sounds) s.time = -1e9;
  }

  /** Force full alert — used when the agent is shot or told by a squadmate. */
  forceAlert(position: THREE.Vector3, confidence = 0.8): void {
    this.awareness = Math.max(this.awareness, 0.999);
    if (this.state !== 'combat') this.justAlerted = true;
    this.state = 'combat';
    this.lastKnown.copy(position);
    this.confidence = Math.max(this.confidence, confidence);
    this.timeSinceStimulus = 0;
    this.interest.copy(position);
    this.hasInterest = true;
  }

  /** Squad-shared contact: believable but weaker than seeing it yourself. */
  share(position: THREE.Vector3, velocity: THREE.Vector3, confidence: number, now: number): void {
    void now;
    if (confidence <= this.confidence && this.timeSinceSeen < 0.6) return;
    this.lastKnown.copy(position);
    this.lastKnownVelocity.copy(velocity);
    this.confidence = Math.max(this.confidence, confidence * 0.85);
    this.awareness = Math.max(this.awareness, 0.62);
    this.timeSinceStimulus = 0;
    if (!this.hasLOS) { this.interest.copy(position); this.hasInterest = true; }
  }

  /** Queues a heard sound. Attenuation happens here; reaction happens in tick. */
  hear(s: SoundStimulus, ear: THREE.Vector3, physics: PhysicsAPI | null, now: number): number {
    const d = ear.distanceTo(s.position);
    if (d > s.loudness) return 0;
    // Inverse-ish falloff, then occlusion.
    let strength = 1 - d / s.loudness;
    strength *= strength * 0.6 + strength * 0.4;
    if (physics && physics.ready && d > 1.5) {
      _v0.copy(ear);
      _v1.copy(s.position);
      _v1.y += 0.4;
      if (!physics.lineOfSight(_v0, _v1, MASK_SIGHT)) strength *= 0.42;
    }
    if (strength < 0.035) return 0;

    const slot = this.sounds[this.soundCursor];
    this.soundCursor = (this.soundCursor + 1) % this.sounds.length;
    slot.position.copy(s.position);
    slot.strength = strength;
    slot.kind = s.kind;
    slot.time = now;
    slot.fromTarget = s.fromTarget;
    return strength;
  }

  /**
   * One perception update. Runs at a fixed low rate (staggered per agent), with
   * `dt` being the real elapsed time since this agent's previous update.
   */
  tick(
    dt: number, now: number, eye: THREE.Vector3, forward: THREE.Vector3,
    target: TargetLike | null, physics: PhysicsAPI | null, light: LightProbe | null,
    profile: DifficultyProfile, samples: number, selfEntity: number,
  ): void {
    this.justAlerted = false;
    this.justLost = false;
    this.timeSinceSeen += dt;
    this.timeSinceStimulus += dt;
    const t = this.tuning;

    /* ---------------------------------------------------------- sight ---- */
    let gain = 0;
    this.hasLOS = false;
    this.visibility = 0;

    if (target && target.alive) {
      _v0.copy(target.position).sub(eye);
      const dist = _v0.length();
      this.distance = dist;
      if (dist > 1e-4) _v0.multiplyScalar(1 / dist);
      this.bearing = Math.acos(THREE.MathUtils.clamp(_v0.dot(forward), -1, 1));

      const fovHalf = THREE.MathUtils.degToRad(t.fovDeg) * 0.5;
      const focusHalf = THREE.MathUtils.degToRad(t.focusFovDeg) * 0.5;
      const inCone = this.bearing <= fovHalf || dist < t.proximityRange;

      if (inCone && dist < t.sightRange) {
        this.lightTimer -= dt;
        if (this.lightTimer <= 0 && light) {
          this.lightTimer = 0.45;
          _v1.copy(target.position);
          _v1.y += target.height * 0.25;
          this.lightLevel = light.sample(_v1, physics);
        }

        this.visibility = this.traceBody(eye, target, physics, samples, selfEntity);
        this.hasLOS = this.visibility > 0;

        if (this.hasLOS) {
          // Angle: full rate in the focus cone, tapering to a third at the edge.
          const angleFactor = this.bearing <= focusHalf
            ? 1
            : 0.32 + 0.68 * (1 - smoothstep(focusHalf, fovHalf, this.bearing));
          const distFactor = 0.25 + 0.75 * falloff(dist, t.clearRange, t.sightRange);
          const lightFactor = 0.3 + 0.7 * this.lightLevel;

          // Movement and noise make you obvious; crouching and stillness do not.
          const speed = target.velocity.length();
          let motion = 0.55 + 0.45 * clamp01(speed / 4.5);
          motion *= 1 - 0.28 * target.crouch;
          if (now - target.firedAt < 0.35) motion += 1.6;

          gain = t.gain * this.visibility * angleFactor * distFactor
            * lightFactor * motion * profile.perceptionScale;

          // Point blank: you cannot sneak up on someone facing you at 3 m.
          if (dist < 3.2 && this.bearing < fovHalf) gain = Math.max(gain, 3.5);
        }
      } else {
        this.distance = dist;
      }
    }

    /* --------------------------------------------------------- hearing ---- */
    let heardStrength = 0;
    let heardFromTarget = false;
    for (const s of this.sounds) {
      const age = now - s.time;
      if (age < 0 || age > 0.5) continue;
      // Each queued sound contributes once, over the tick it arrived in.
      const w = s.kind === 'explosion' ? 1.5 : s.kind === 'gunfire' ? 1.15 : 0.7;
      const contribution = s.strength * w;
      if (contribution > heardStrength) {
        heardStrength = contribution;
        heardFromTarget = s.fromTarget;
        if (!this.hasLOS) {
          // Localisation error grows with distance and shrinks with loudness.
          const err = (1 - s.strength) * 4.5;
          this.interest.set(
            s.position.x + (s.position.x - eye.x) * 0.0 + err * (this.hash(now) - 0.5),
            s.position.y,
            s.position.z + err * (this.hash(now + 7.3) - 0.5),
          );
          this.hasInterest = true;
        }
      }
      s.time = -1e9;
    }
    if (heardStrength > 0) {
      // Hearing alone tops out below full certainty: you know *something* is
      // there, you do not know exactly what or where.
      const cap = heardFromTarget ? 0.92 : 0.7;
      const add = heardStrength * 2.4 * dt * profile.perceptionScale;
      this.awareness = Math.min(Math.max(this.awareness, 0), cap === 0 ? 1 : 1);
      if (this.awareness < cap) this.awareness = Math.min(cap, this.awareness + add);
      this.timeSinceStimulus = 0;
      if (heardFromTarget && heardStrength > 0.55) {
        this.confidence = Math.max(this.confidence, 0.55);
        this.lastKnown.copy(this.interest);
      }
    }

    /* ----------------------------------------------------- meter update --- */
    if (gain > 0) {
      this.awareness = Math.min(1, this.awareness + gain * dt);
      this.timeSinceStimulus = 0;
    } else if (heardStrength <= 0) {
      const decay = this.state === 'combat' ? t.combatDecay : t.idleDecay;
      this.awareness = Math.max(0, this.awareness - decay * dt);
    }

    /* -------------------------------------------------------- memory ------ */
    if (this.hasLOS && target) {
      this.timeSinceSeen = 0;
      this.lastKnown.copy(target.position);
      this.lastKnownVelocity.copy(target.velocity);
      this.confidence = Math.min(1, this.confidence + dt * 6);
      this.hasInterest = false;
      this.seenAtLeastOnce = true;
    } else if (this.confidence > 0) {
      // Confidence decays faster than awareness: he still knows you are around,
      // he just stops trusting where.
      this.confidence = Math.max(0, this.confidence - dt / Math.max(1, t.memory * 0.45));
      if (this.timeSinceSeen < 2.5) {
        // Dead-reckon for a couple of seconds after losing sight.
        this.lastKnown.addScaledVector(this.lastKnownVelocity, dt * 0.85);
      }
    }
    this.exposure += (this.visibility - this.exposure) * (1 - Math.exp(-7 * dt));

    /* ------------------------------------------------------- state -------- */
    const prev = this.state;
    switch (this.state) {
      case 'idle':
        if (this.awareness >= 0.999 && this.hasLOS) this.state = 'combat';
        else if (this.awareness > 0.26) this.state = 'suspicious';
        break;
      case 'suspicious':
        if (this.awareness >= 0.999) this.state = 'combat';
        else if (this.awareness > 0.62) this.state = 'searching';
        else if (this.awareness < 0.1) this.state = 'idle';
        break;
      case 'searching':
        if (this.awareness >= 0.999) this.state = 'combat';
        else if (this.awareness < 0.14 && this.timeSinceStimulus > 8) this.state = 'suspicious';
        break;
      case 'combat':
        if (this.awareness < 0.5 && this.timeSinceSeen > 4.5) this.state = 'searching';
        break;
    }
    if (prev !== this.state) {
      if (this.state === 'combat') this.justAlerted = true;
      if (prev === 'combat' && this.state !== 'combat') this.justLost = true;
    }
    this.hasContact = this.state === 'combat';
  }

  /** Predicted target position `ahead` seconds from the last sighting. */
  predict(ahead: number, out: THREE.Vector3): THREE.Vector3 {
    const t = Math.min(this.timeSinceSeen + ahead, 2.5);
    return out.copy(this.lastKnown).addScaledVector(this.lastKnownVelocity, t * 0.6);
  }

  get everSeen(): boolean { return this.seenAtLeastOnce; }

  /**
   * Traces several points on the target's body. Returns the visible fraction.
   * A single centre-mass ray is what makes AI feel psychic or blind depending on
   * which side of a crate you happen to stand.
   */
  private traceBody(
    eye: THREE.Vector3, target: TargetLike, physics: PhysicsAPI | null,
    samples: number, selfEntity: number,
  ): number {
    const n = this.buildSamples(eye, target, samples);
    if (!physics || !physics.ready) return 1;
    let visible = 0;
    for (let i = 0; i < n; i++) {
      const ok = physics.lineOfSight(eye, this.samplePoints[i], MASK_SIGHT, selfEntity);
      this.sampleVisible[i] = ok ? 1 : 0;
      if (ok) visible++;
    }
    return visible / n;
  }

  private buildSamples(eye: THREE.Vector3, target: TargetLike, samples: number): number {
    const h = target.height * (1 - target.crouch * 0.4);
    const base = target.position.y - target.height * 0.5;
    _v2.copy(target.position).sub(eye);
    _v2.y = 0;
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0, 1);
    _v2.normalize();
    _right.set(_v2.z, 0, -_v2.x);
    const r = target.radius * 0.72;

    const p = this.samplePoints;
    let n = 0;
    p[n++].set(target.position.x, base + h * 0.92, target.position.z);            // head
    p[n++].set(target.position.x, base + h * 0.62, target.position.z);            // chest
    if (samples > 2) {
      p[n++].copy(target.position).addScaledVector(_right, r).setY(base + h * 0.70);
      p[n++].copy(target.position).addScaledVector(_right, -r).setY(base + h * 0.70);
    }
    if (samples > 4) {
      p[n++].set(target.position.x, base + h * 0.30, target.position.z);          // knees
      p[n++].copy(target.position).addScaledVector(_v2, -r * 0.8).setY(base + h * 0.80);
    }
    return n;
  }

  /** Deterministic hash used for sound localisation jitter. */
  private hash(x: number): number {
    const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
}
