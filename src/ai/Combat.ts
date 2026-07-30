/**
 * Fire control: when to shoot, where the rounds actually go, and how being shot
 * at changes both.
 *
 * The whole point of this file is to give the player *time and information*:
 *
 *  - **Reaction time.** Nobody fires the instant they see you. The delay is the
 *    single biggest difficulty knob, and it is the reason a firefight has a
 *    readable opening beat instead of an instant death.
 *  - **Aim error that converges.** The first burst goes wide by design and the
 *    grouping tightens over the following seconds, so standing in the open is
 *    survivable for a moment and *staying* there is not.
 *  - **Miss-first.** The opening shots of an engagement are aimed deliberately
 *    past you — close enough that the crack and the impact tell you exactly
 *    where the shooter is.
 *  - **Bursts.** Continuous fire is unreadable and unfair; bursts with gaps are
 *    what let you choose a moment to move.
 *  - **Suppression and flinch.** Shooting back has to *do* something even when
 *    you miss: rounds landing near an agent duck him and wreck his aim, and a
 *    hit staggers him off target entirely.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Rand } from '../core/Rand';
import type { PhysicsAPI, RayHit, HitZone } from '../physics/types';
import { MASK_SIGHT } from '../physics/types';
import { makeHit, clamp01, damp, raySegmentDistSq, rotateY } from './Util';
import type { AIWeaponSpec, DifficultyProfile, TargetLike } from './types';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _hit: RayHit = makeHit();
const _closest = { t: 0, s: 0 };

export interface ShotResult {
  fired: boolean;
  hitTarget: boolean;
  damage: number;
  zone: HitZone;
}

export class CombatController {
  ammo: number;
  reserve = 240;
  reloading = false;
  reloadTimer = 0;
  /** True while the muzzle is up and the agent intends to shoot. */
  firing = false;
  /** Rounds left in the current burst. */
  burstLeft = 0;
  /** Sim time the next round may leave the barrel. */
  nextShotAt = -1e9;
  /** Sim time the next burst may start. */
  nextBurstAt = -1e9;

  /** Counts down after acquiring a target; no shots until it hits zero. */
  reactionTimer = -1;
  /** True once the reaction has elapsed for the current engagement. */
  ready = false;
  /** Shots fired since this engagement started — drives miss-first. */
  engagementShots = 0;
  /** Sim time the current engagement began. */
  engagedAt = -1e9;

  /** Current angular aim error magnitude, radians. */
  aimError = 0.1;
  /** Random-walk direction of the error, so it does not just shrink smoothly. */
  private errorPhase = 0;
  private errorYaw = 0;
  private errorPitch = 0;

  /** 0..1 — how pinned down this agent is. */
  suppression = 0;
  /** 0..1 — decays fast; spikes when hit. */
  flinch = 0;
  /** Sim time of the last shot taken at us. */
  lastSuppressedAt = -1e9;

  /** Total rounds this agent has fired; for stats and gizmos. */
  shotsFired = 0;
  shotsHit = 0;

  constructor(
    readonly spec: AIWeaponSpec,
    private profile: DifficultyProfile,
    private rand: Rand,
  ) {
    this.ammo = spec.magSize;
    this.aimError = profile.aimErrorStart;
  }

  setProfile(p: DifficultyProfile): void { this.profile = p; }

  get needsReload(): boolean { return this.ammo <= 0; }
  get lowAmmo(): boolean { return this.ammo <= Math.max(2, this.spec.magSize * 0.25); }

  /** Called when the agent acquires (or re-acquires) a target. */
  beginEngagement(now: number, firstContact: boolean): void {
    if (this.engagedAt > 0 && now - this.engagedAt < 6 && !firstContact) return;
    this.engagedAt = now;
    this.engagementShots = 0;
    this.ready = false;
    this.reactionTimer = Math.max(
      0.05,
      this.profile.reactionTime + this.rand.signed() * this.profile.reactionJitter,
    );
    this.aimError = this.profile.aimErrorStart * (firstContact ? 1 : 0.65);
    this.burstLeft = 0;
    this.nextBurstAt = now;
  }

  endEngagement(): void {
    this.ready = false;
    this.reactionTimer = -1;
    this.burstLeft = 0;
    this.firing = false;
  }

  /** Starts a reload. Returns false when there is nothing to reload from. */
  startReload(now: number): boolean {
    if (this.reloading || this.ammo >= this.spec.magSize) return false;
    if (this.reserve <= 0) return false;
    this.reloading = true;
    this.reloadTimer = this.spec.reloadTime;
    this.burstLeft = 0;
    this.firing = false;
    void now;
    return true;
  }

  addSuppression(amount: number, now: number): void {
    const resist = 0.35 + this.profile.nerve * 0.65;
    this.suppression = clamp01(this.suppression + amount / resist);
    this.lastSuppressedAt = now;
  }

  addFlinch(amount: number): void {
    this.flinch = clamp01(this.flinch + amount);
    // Being hit throws the aim off; recovering costs real time.
    this.aimError = Math.min(0.24, this.aimError + amount * 0.09);
    this.burstLeft = 0;
  }

  /* ---------------------------------------------------------------- tick -- */

  update(dt: number, now: number, hasTarget: boolean): void {
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const need = this.spec.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloading = false;
      }
    }

    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      if (this.reactionTimer <= 0) { this.reactionTimer = -1; this.ready = true; }
    }

    // Aim error converges exponentially toward the floor while a target is held,
    // and relaxes back out when contact is lost.
    const p = this.profile;
    if (hasTarget && this.ready) {
      const k = 1 - Math.exp(-dt / Math.max(0.05, p.aimConverge));
      this.aimError += (p.aimErrorFloor - this.aimError) * k;
    } else {
      this.aimError = Math.min(p.aimErrorStart, this.aimError + dt * 0.05);
    }

    // Suppression and flinch decay; suppression lingers noticeably longer.
    this.suppression = Math.max(0, this.suppression - dt * (0.42 + p.nerve * 0.3));
    this.flinch = Math.max(0, this.flinch - dt * 3.2);

    this.errorPhase += dt * 2.7;
    void now;
  }

  /** True when the agent could pull the trigger right now. */
  canFire(now: number): boolean {
    return this.ready && !this.reloading && this.ammo > 0 && now >= this.nextShotAt;
  }

  /**
   * Attempts one trigger pull. Handles burst bookkeeping, resolves the shot
   * against the world and the target, and publishes the events FX/audio need.
   */
  tryFire(
    now: number, muzzle: THREE.Vector3, target: TargetLike, targetDistance: number,
    physics: PhysicsAPI | null, agentId: number, suppressiveOnly: boolean,
    aimAt: THREE.Vector3, out: ShotResult,
  ): ShotResult {
    out.fired = false; out.hitTarget = false; out.damage = 0; out.zone = 'none';
    if (!this.canFire(now)) { this.firing = false; return out; }

    if (this.burstLeft <= 0) {
      if (now < this.nextBurstAt) { this.firing = false; return out; }
      // Longer bursts up close and when suppressing, shorter at distance.
      const spec = this.spec;
      const range01 = clamp01(targetDistance / Math.max(6, spec.rangeIdeal));
      let len = Math.round(
        spec.burstMax - (spec.burstMax - spec.burstMin) * range01 * 0.85,
      );
      if (suppressiveOnly) len = Math.round(len * 1.5);
      if (this.suppression > 0.5) len = Math.max(spec.burstMin, Math.round(len * 0.6));
      this.burstLeft = Math.max(1, Math.min(this.ammo, len));
    }

    this.firing = true;
    this.ammo--;
    this.burstLeft--;
    this.engagementShots++;
    this.shotsFired++;
    this.nextShotAt = now + 60 / this.spec.rpm;
    if (this.burstLeft <= 0) {
      const spec = this.spec;
      const gap = this.rand.range(spec.burstGapMin, spec.burstGapMax)
        * this.profile.burstGapScale
        * (1 + this.suppression * 0.8);
      this.nextBurstAt = now + gap;
    }

    this.resolveShot(now, muzzle, target, targetDistance, physics, agentId, suppressiveOnly, aimAt, out);
    out.fired = true;
    return out;
  }

  /**
   * Traces the round. World geometry wins over the target, so a bullet that
   * clips the corner the agent is peeking around hits the corner — the AI does
   * not get free shots through cover it is hiding behind.
   */
  private resolveShot(
    now: number, muzzle: THREE.Vector3, target: TargetLike, distance: number,
    physics: PhysicsAPI | null, agentId: number, suppressiveOnly: boolean,
    aimAt: THREE.Vector3, out: ShotResult,
  ): void {
    const spec = this.spec;

    // --- where is he actually pointing? -----------------------------------
    _aim.copy(aimAt);

    // Deliberate opening misses: throw the round past, not into, the target.
    const missing = suppressiveOnly || this.engagementShots <= this.profile.missFirstShots;
    if (missing) {
      _v0.copy(_aim).sub(muzzle);
      _v0.y = 0;
      _v0.normalize();
      _v1.set(_v0.z, 0, -_v0.x);                       // right of the shot line
      const side = this.rand.bool() ? 1 : -1;
      const lateral = (0.55 + this.rand.next() * 0.9) * side * (suppressiveOnly ? 1.4 : 1);
      const vertical = 0.35 + this.rand.next() * 0.75;
      _aim.addScaledVector(_v1, lateral).y += vertical;
    }

    // Angular error: a converging cone plus mechanical spread, wobbled by a
    // slow random walk so successive rounds are correlated (a group, not noise).
    this.errorYaw = damp(this.errorYaw, Math.sin(this.errorPhase * 1.7) * 0.6 + this.rand.signed() * 0.4, 6, 1 / 60);
    this.errorPitch = damp(this.errorPitch, Math.cos(this.errorPhase * 1.3) * 0.5 + this.rand.signed() * 0.4, 6, 1 / 60);
    const spreadScale = 1
      + this.suppression * 1.9
      + this.flinch * 2.6
      + clamp01(target.velocity.length() / 6) * 0.55;
    const cone = (this.aimError * spreadScale) + spec.spread;

    _dir.copy(_aim).sub(muzzle);
    const shotDist = Math.max(0.5, _dir.length());
    _dir.multiplyScalar(1 / shotDist);
    rotateY(_dir, this.errorYaw * cone);
    _dir.y += this.errorPitch * cone;
    _dir.normalize();

    bus.emit('ai:fire', { id: agentId, origin: muzzle.clone(), direction: _dir.clone() });

    // --- trace ------------------------------------------------------------
    const maxRange = spec.rangeMax;
    let worldDist = maxRange;
    let worldHit = false;
    if (physics && physics.ready) {
      physics.raycast(muzzle, _dir, maxRange, MASK_SIGHT, _hit, -1);
      if (_hit.hit) { worldDist = _hit.distance; worldHit = true; }
    }

    // Target capsule: feet-to-head segment, shrunk while crouched.
    const h = target.height * (1 - target.crouch * 0.35);
    const r = target.radius;
    const base = target.position.y - target.height * 0.5;
    _capA.set(target.position.x, base + r, target.position.z);
    _capB.set(target.position.x, base + h - r, target.position.z);
    const d2 = raySegmentDistSq(muzzle, _dir, Math.min(worldDist, maxRange), _capA, _capB, _closest);

    if (target.alive && d2 <= r * r && _closest.t < worldDist) {
      // Which part of him did it catch?
      const y = muzzle.y + _dir.y * _closest.t;
      const frac = clamp01((y - base) / Math.max(0.4, h));
      let zone: HitZone = 'chest';
      let mult = 1;
      if (frac > 0.88) { zone = 'head'; mult = spec.headshotMult; }
      else if (frac > 0.72) { zone = 'neck'; mult = spec.headshotMult * 0.8; }
      else if (frac > 0.48) { zone = 'chest'; mult = 1; }
      else if (frac > 0.34) { zone = 'stomach'; mult = 0.9; }
      else { zone = 'leg'; mult = 0.7; }

      const falloffScale = distance <= spec.rangeIdeal
        ? 1
        : 1 - 0.6 * clamp01((distance - spec.rangeIdeal) / Math.max(1, spec.rangeMax - spec.rangeIdeal));
      const dmg = spec.damage * mult * falloffScale * this.profile.damageScale;

      out.hitTarget = true;
      out.damage = dmg;
      out.zone = zone;
      this.shotsHit++;

      _v2.copy(muzzle).addScaledVector(_dir, _closest.t);
      bus.emit('bullet:impact', {
        point: _v2.clone(),
        normal: _dir.clone().negate(),
        surface: zone === 'head' ? 'helmet' : 'flesh',
        incoming: _dir.clone(),
        energy: dmg * 22,
        penetrated: false,
      });
      if (target.isPlayer) {
        _v0.copy(muzzle).sub(target.position).normalize();
        bus.emit('damage:taken', {
          amount: dmg, fromDirection: _v0.clone(), sourceId: agentId, lethal: false,
        });
      } else {
        bus.emit('damage:dealt', {
          targetId: target.entityId, amount: dmg, headshot: zone === 'head',
          killed: false, point: _v2.clone(), fromPlayer: false,
        });
      }
    } else if (worldHit) {
      bus.emit('bullet:impact', {
        point: _hit.point.clone(),
        normal: _hit.normal.clone(),
        surface: _hit.surface,
        incoming: _dir.clone(),
        energy: spec.damage * 20,
        penetrated: false,
      });
    }
    void now;
  }

  /** Accuracy so far, for debug readouts. */
  get accuracy(): number {
    return this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0;
  }
}

export function makeShotResult(): ShotResult {
  return { fired: false, hitTarget: false, damage: 0, zone: 'none' };
}
