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
import { MASK_BULLET } from '../physics/types';
import { makeHit, clamp01, damp, raySegmentDistSq, rotateY } from './Util';
import type { AIWeaponSpec, DifficultyProfile, TargetLike } from './types';
import { priceAiHit } from '../game/Combat';
import type { WeaponClass } from '../weapons/types';
import type { SurfaceType } from '../core/Surfaces';

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
  /** True when the round was stopped by geometry or a body that is not the target. */
  blocked: boolean;
}

/**
 * Fire-control tuning that sits *on top of* the authored difficulty table.
 *
 * `src/ai/types.ts` owns the difficulty curves and is shared; these are the
 * knobs the match layer turns at runtime, so they live with the controller that
 * reads them.
 */
export const FIRE_CONTROL = {
  /**
   * Reaction floor. Nothing — no difficulty, no skill throttle — is allowed to
   * shoot faster than this after acquiring a target. 220 ms is roughly a human
   * simple-visual reaction (~200 ms) plus the time to get the muzzle moving; it
   * is what stops a spawned enemy from deleting you before the callout lands.
   */
  reactionFloorSec: 0.22,
  /** Hard ceiling so a heavily throttled agent still eventually shoots. */
  reactionCeilSec: 1.60,
  /**
   * How far the director's accuracy scalar is allowed to move the aim cone.
   * `skill` 0.72..1.22 is the range `difficultyScalars()` produces.
   */
  skillMin: 0.35,
  skillMax: 1.6,
} as const;

/** Map an AI weapon id onto the shared zone-multiplier weapon class. */
function aiWeaponClass(spec: AIWeaponSpec): WeaponClass {
  const id = spec.id;
  if (id.includes('smg')) return 'smg';
  if (id.includes('shotgun')) return 'shotgun';
  if (id.includes('dmr') || id.includes('sniper')) return 'marksman';
  if (id.includes('lmg') || id.includes('jug')) return 'lmg';
  return 'assault';
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
  /** Rounds this agent put into world geometry or a body that was not the target. */
  shotsBlocked = 0;

  /**
   * Director difficulty throttle, 1 = as authored. Below 1 widens the cone and
   * lengthens the reaction; above 1 tightens both. Never touches health or
   * damage — see the note at the top of `src/ai/types.ts`.
   */
  skill = 1;
  /**
   * The reaction actually rolled for the current engagement, in seconds.
   * Telemetry only — the harness reads this to report the distribution.
   */
  lastReaction = 0;
  /** Sim time the current reaction started, so "did he telegraph" is measurable. */
  reactionStartedAt = -1e9;

  constructor(
    readonly spec: AIWeaponSpec,
    private profile: DifficultyProfile,
    private rand: Rand,
  ) {
    this.ammo = spec.magSize;
    this.aimError = profile.aimErrorStart;
  }

  setProfile(p: DifficultyProfile): void { this.profile = p; }

  /** Director accuracy scalar → skill, clamped to something survivable. */
  setSkill(scale: number): void {
    this.skill = THREE.MathUtils.clamp(
      Number.isFinite(scale) ? scale : 1, FIRE_CONTROL.skillMin, FIRE_CONTROL.skillMax,
    );
  }

  get needsReload(): boolean { return this.ammo <= 0; }
  get lowAmmo(): boolean { return this.ammo <= Math.max(2, this.spec.magSize * 0.25); }

  /** Called when the agent acquires (or re-acquires) a target. */
  beginEngagement(now: number, firstContact: boolean): void {
    if (this.engagedAt > 0 && now - this.engagedAt < 6 && !firstContact) return;
    this.engagedAt = now;
    this.engagementShots = 0;
    this.ready = false;
    /*
     * Reaction is the single most important number in this file: it is the gap
     * between the "Contact!" callout the player hears and the first round, and
     * it is what makes an opening beat readable instead of a coin flip. A low
     * skill scalar lengthens it, but the floor is absolute.
     */
    const jitter = this.rand.signed() * this.profile.reactionJitter;
    const slow = 1 + (1 - this.skill) * 0.55;
    this.reactionTimer = THREE.MathUtils.clamp(
      (this.profile.reactionTime + jitter) * slow,
      FIRE_CONTROL.reactionFloorSec, FIRE_CONTROL.reactionCeilSec,
    );
    this.lastReaction = this.reactionTimer;
    this.reactionStartedAt = now;
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
      this.aimError += (p.aimErrorFloor / this.skill - this.aimError) * k;
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
    aimAt: THREE.Vector3, out: ShotResult, ownerEntity = -1,
  ): ShotResult {
    out.fired = false; out.hitTarget = false; out.damage = 0; out.zone = 'none';
    out.blocked = false;
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

    this.resolveShot(
      now, muzzle, target, targetDistance, physics, agentId, suppressiveOnly, aimAt, out,
      ownerEntity,
    );
    out.fired = true;
    return out;
  }

  /**
   * Traces the round.
   *
   * The trace uses `MASK_BULLET` — the *same* collider set the player's own
   * rounds resolve against — rather than the sight mask, so an AI round is
   * stopped by exactly what stops a player round: world geometry, glass, a
   * squadmate's capsule, a ragdoll. There is no probability anywhere in this
   * function; whether you are hit is decided by where the barrel was pointing.
   *
   * The analytic capsule solve remains for headless tests and unzoned proxies.
   * Living multi-zone colliders (CharacterController.setHitboxes) win whenever
   * MASK_BULLET resolves them — see `zoneFor`.
   */
  private resolveShot(
    now: number, muzzle: THREE.Vector3, target: TargetLike, distance: number,
    physics: PhysicsAPI | null, agentId: number, suppressiveOnly: boolean,
    aimAt: THREE.Vector3, out: ShotResult, ownerEntity: number,
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

    const maxRange = spec.rangeMax;

    // --- analytic capsule: feet-to-head segment, shrunk while crouched -----
    const h = target.height * (1 - target.crouch * 0.35);
    const r = target.radius;
    const base = target.position.y - target.height * 0.5;
    _capA.set(target.position.x, base + r, target.position.z);
    _capB.set(target.position.x, base + h - r, target.position.z);
    const d2 = raySegmentDistSq(muzzle, _dir, maxRange, _capA, _capB, _closest);
    const capsuleHit = target.alive && d2 <= r * r;
    const capsuleT = capsuleHit ? _closest.t : Infinity;

    // --- physics trace against real colliders -----------------------------
    let worldDist = maxRange;
    let worldHit = false;
    let colliderIsTarget = false;
    let colliderZone: HitZone = 'none';
    if (physics && physics.ready) {
      physics.raycast(muzzle, _dir, maxRange, MASK_BULLET, _hit, ownerEntity);
      if (_hit.hit) {
        worldHit = true;
        worldDist = _hit.distance;
        colliderZone = _hit.zone;
        /*
         * Was the first solid thing the target? Two ways to know: the collider
         * carries the target's entity id (agents tag their capsules), or it is
         * an untagged *character* proxy — zone is only ever non-'none' on a
         * body — sitting where the capsule solve says the target is. The
         * player's own controller does not tag itself, which is why the second
         * test exists.
         */
        colliderIsTarget = (_hit.entityId >= 0 && _hit.entityId === target.entityId)
          || (_hit.entityId < 0 && _hit.zone !== 'none'
            && capsuleHit && Math.abs(_hit.distance - capsuleT) <= 0.9);
      }
    }

    // Prefer the MASK_BULLET hit when it is the target. Analytic capsule is
    // only a fallback for unzoned bodies / missing physics — not a second
    // damage path that overrides a real multi-zone collider.
    const hitTarget = colliderIsTarget
      || (!worldHit && capsuleHit)
      || (capsuleHit && !colliderIsTarget && capsuleT + 0.05 < worldDist
        && !(worldHit && _hit.entityId >= 0 && _hit.entityId !== target.entityId));

    if (hitTarget) {
      const t = colliderIsTarget ? _hit.distance : capsuleT;
      const zone = this.zoneFor(muzzle, _dir, t, base, h, colliderIsTarget ? colliderZone : 'none');
      // Shared zone table + falloff shape with the player ballistics path.
      // Base damage stays on the AI weapon spec (authored lethality / dps).
      const priced = priceAiHit(
        aiWeaponClass(spec),
        spec.damage,
        distance,
        zone,
        spec.rangeIdeal,
        spec.rangeMax,
        this.profile.damageScale,
        null,
      );
      // AIWeaponSpec.headshotMult was a dead field — apply it on pure head hits
      // by replacing the shared table multi with the weapon-authored multi.
      let dmg = priced.damage;
      if (zone === 'head' && Number.isFinite(spec.headshotMult) && spec.headshotMult > 0) {
        const tableHead = Math.max(1e-6, priced.zoneMultiplier);
        dmg *= spec.headshotMult / tableHead;
      }

      out.hitTarget = true;
      out.damage = dmg;
      out.zone = priced.zone;
      this.shotsHit++;

      // Prefer the collider surface (flesh / armor / helmet) when MASK_BULLET
      // resolved a living volume; otherwise flesh (never invent a helmet).
      const impactSurface: SurfaceType = colliderIsTarget && _hit.surface
        ? _hit.surface
        : 'flesh';

      _v2.copy(muzzle).addScaledVector(_dir, t);
      bus.emit('bullet:impact', {
        point: _v2.clone(),
        normal: _dir.clone().negate(),
        surface: impactSurface,
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
          targetId: target.entityId, amount: dmg, headshot: priced.headshot,
          killed: false, point: _v2.clone(), fromPlayer: false,
        });
      }
    } else if (worldHit) {
      out.blocked = true;
      this.shotsBlocked++;
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

  /**
   * Which part of the body the round caught.
   *
   * A collider zone more specific than the torso proxy is believed outright —
   * that is a real hitbox and it knows better than any band table. Otherwise
   * the vertical band of the capsule decides, which is the only way head shots
   * exist at all while a live character owns one `chest` capsule.
   */
  private zoneFor(
    muzzle: THREE.Vector3, dir: THREE.Vector3, t: number,
    base: number, height: number, colliderZone: HitZone,
  ): HitZone {
    // Multi-zone living colliders own the answer — including an honest chest.
    // Only fall back to vertical capsule bands when physics reported no zone
    // (single proxy / headless / player capsule without setHitboxes).
    if (colliderZone !== 'none') return colliderZone;
    const y = muzzle.y + dir.y * t;
    const frac = clamp01((y - base) / Math.max(0.4, height));
    if (frac > 0.88) return 'head';
    if (frac > 0.72) return 'neck';
    if (frac > 0.48) return 'chest';
    if (frac > 0.34) return 'stomach';
    return 'leg';
  }

  /** Accuracy so far, for debug readouts. */
  get accuracy(): number {
    return this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0;
  }
}

export function makeShotResult(): ShotResult {
  return { fired: false, hitTarget: false, damage: 0, zone: 'none', blocked: false };
}
