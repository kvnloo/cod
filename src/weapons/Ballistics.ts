/**
 * Ballistics — what happens after the trigger.
 *
 * Two solvers, chosen per round rather than per weapon:
 *
 *  - **Hitscan** for pistol-calibre rounds inside their `hitscanRange`. At 400
 *    m/s and 30 m the flight time is 75 ms; simulating it would cost the player
 *    hits they earned and gain nothing.
 *  - **Simulated projectiles** for everything rifle-calibre and for anything
 *    beyond that range. Gravity and quadratic drag are integrated at the fixed
 *    step, and each step is swept with a ray so nothing tunnels.
 *
 * Both funnel into the same impact resolver, so penetration, ricochet, damage
 * and events behave identically however the round got there.
 *
 * ## Penetration
 *
 * Each round carries a `power` budget in "reference metres". A surface costs
 * `thickness / SurfaceProps.penetrationDepth` of it. Exit points come from
 * `raycastAll`, which returns back-face hits — the round leaves the wall where
 * the geometry says it does, not at a guessed offset. Damage past a wall is
 * scaled by the weapon's `penetrationDamage`, and the budget is spent, so the
 * third wall stops even a .338.
 *
 * ## Ricochet
 *
 * Shallow hits on hard surfaces deflect. The chance comes from the surface
 * table and the incidence angle; the deflected round keeps travelling with a
 * scattered direction and heavily reduced damage, which is what makes a
 * concrete corridor feel dangerous.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { Rand } from '../core/Rand';
import { surface as surfaceProps } from '../core/Surfaces';
import type { HitZone, PhysicsAPI, RayHit } from '../physics/types';
import { MASK_BULLET } from '../physics/types';
import type { RenderAPI } from '../render/types';
import { damageAt } from './Catalog';
import type { WeaponDef } from './types';
import type { TracerPool } from './Tracers';

/** Result the host game can plug in to own health and kill attribution. */
export interface DamageResult {
  killed: boolean;
  /** Damage actually applied after armour. */
  applied: number;
  armor?: boolean;
}

export type DamageResolver = (
  entityId: number, amount: number, headshot: boolean, point: THREE.Vector3,
  direction: THREE.Vector3, fromPlayer: boolean,
  /** Physics-resolved hit zone when the ray hit a multi-zone collider. */
  zone?: HitZone,
) => DamageResult;

export interface ShotSpec {
  def: WeaponDef;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  /** Penetration budget after attachments. */
  penetration: number;
  muzzleVelocity: number;
  rangeScale: number;
  ownerEntity: number;
  fromPlayer: boolean;
  tracer: boolean;
  shotIndex: number;
  /** Distance already travelled, for pellets spawned at the muzzle. */
  startDistance?: number;
}

interface Bullet {
  active: boolean;
  def: WeaponDef;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  travelled: number;
  life: number;
  power: number;
  damageScale: number;
  ownerEntity: number;
  fromPlayer: boolean;
  tracer: boolean;
  tracerId: number;
}

const MAX_BULLETS = 192;
const MAX_SEGMENTS = 5;
const MAX_RANGE = 900;

export class Ballistics {
  physics: PhysicsAPI | null = null;
  render: RenderAPI | null = null;
  tracers: TracerPool | null = null;
  damageResolver: DamageResolver | null = null;
  /** Gravity in m/s²; overwritten from the physics backend when available. */
  gravity = -9.81;

  private rand = new Rand('ballistics');
  private bullets: Bullet[] = [];
  private freeList: number[] = [];
  private hits: RayHit[] = [];
  private scratchHit: RayHit = makeHit();

  /* --- scratch --- */
  private readonly _dir = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _p2 = new THREE.Vector3();
  private readonly _step = new THREE.Vector3();
  private readonly _n = new THREE.Vector3();
  private readonly _incoming = new THREE.Vector3();
  private readonly _exit = new THREE.Vector3();

  /** Live projectile count, for the debug HUD. */
  get activeCount(): number {
    let n = 0;
    for (const b of this.bullets) if (b.active) n++;
    return n;
  }

  constructor() {
    for (let i = 0; i < MAX_BULLETS; i++) {
      this.bullets.push({
        active: false, def: null as unknown as WeaponDef,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        travelled: 0, life: 0, power: 0, damageScale: 1,
        ownerEntity: -1, fromPlayer: false, tracer: false, tracerId: -1,
      });
      this.freeList.push(i);
    }
  }

  seed(s: number | string): void { this.rand.seed(s); }

  /* --------------------------------------------------------------- firing */

  /** Fires one round. Pellet weapons should call this once per pellet. */
  fire(spec: ShotSpec): void {
    const b = spec.def.ballistics;
    const hitscanRange = b.hitscanRange * spec.rangeScale;
    if (hitscanRange > 0) {
      // Hitscan resolves the near segment; anything still flying past that
      // distance is handed to the projectile solver (gravity + drag).
      const stopped = this.fireHitscan(spec, hitscanRange);
      if (!stopped) {
        const dir = this._dir.copy(spec.direction).normalize();
        this._p.copy(spec.origin).addScaledVector(dir, hitscanRange);
        this.fireProjectile({
          ...spec,
          origin: this._p.clone(),
          direction: dir.clone(),
          startDistance: (spec.startDistance ?? 0) + hitscanRange,
          // Tracer already drawn for the hitscan segment when it missed clean.
          tracer: false,
        });
      }
    } else {
      this.fireProjectile(spec);
    }
  }

  /**
   * Resolve the first `range` metres as an instant ray. Returns true when the
   * round stopped inside that window (impact, or fully spent), false when it is
   * still in flight and the projectile solver should take over beyond.
   */
  private fireHitscan(spec: ShotSpec, range: number): boolean {
    const from = this._p.copy(spec.origin);
    const dir = this._dir.copy(spec.direction).normalize();
    let power = spec.penetration;
    let damageScale = 1;
    let travelled = spec.startDistance ?? 0;
    let remaining = range;
    let tracerStart: THREE.Vector3 | null = spec.tracer ? from.clone() : null;
    let hitAnything = false;

    for (let seg = 0; seg < MAX_SEGMENTS && remaining > 0.01; seg++) {
      const phys = this.physics;
      if (!phys) break;
      const n = phys.raycastAll(from, dir, remaining, MASK_BULLET, this.hits, 8, spec.ownerEntity);
      if (n === 0) break;
      const hit = this.hits[0];
      hitAnything = true;
      travelled += hit.distance;
      remaining -= hit.distance;

      const outcome = this.resolveImpact(spec, hit, dir, travelled, damageScale, power, n);
      if (spec.tracer && tracerStart && this.tracers) {
        this.tracers.streak(tracerStart, hit.point, spec.def.cls === 'lmg' ? 1.25 : 1);
        tracerStart = null;
      }
      if (outcome.stop) return true;

      power = outcome.power;
      damageScale = outcome.damageScale;
      from.copy(outcome.continueFrom);
      dir.copy(outcome.continueDir);
      remaining -= outcome.consumed;
    }

    if (spec.tracer && tracerStart && this.tracers) {
      // Draw the near-range streak; the projectile carries the rest of the path.
      this._p2.copy(from).addScaledVector(dir, Math.min(range, 120));
      this.tracers.streak(tracerStart, this._p2, 1);
    }
    // Empty air (or only soft penetrations that left the budget intact) → still flying.
    void hitAnything;
    return false;
  }

  private fireProjectile(spec: ShotSpec): void {
    const idx = this.freeList.pop();
    if (idx === undefined) return;
    const b = this.bullets[idx];
    b.active = true;
    b.def = spec.def;
    b.pos.copy(spec.origin);
    b.vel.copy(spec.direction).normalize().multiplyScalar(spec.muzzleVelocity);
    b.travelled = spec.startDistance ?? 0;
    b.life = 0;
    b.power = spec.penetration;
    b.damageScale = 1;
    b.ownerEntity = spec.ownerEntity;
    b.fromPlayer = spec.fromPlayer;
    b.tracer = spec.tracer;
    b.tracerId = spec.tracer && this.tracers ? this.tracers.spawn(b.pos, b.vel) : -1;
  }

  /* --------------------------------------------------------------- update */

  fixedUpdate(dt: number): void {
    const phys = this.physics;
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (!b.active) continue;
      b.life += dt;
      if (b.life > 6 || b.travelled > MAX_RANGE) { this.retire(i); continue; }

      const bal = b.def.ballistics;
      // Quadratic drag: dv/dt = −k·v². Integrated as a per-step speed scale,
      // which is stable at any dt and matches the closed-form solution closely
      // over the 8 ms steps this runs at.
      const speed = b.vel.length();
      const decel = 1 - Math.min(0.5, bal.drag * speed * dt);
      b.vel.multiplyScalar(decel);
      b.vel.y += this.gravity * bal.gravityScale * dt;

      this._step.copy(b.vel).multiplyScalar(dt);
      const travel = this._step.length();
      if (travel < 1e-6) continue;
      this._dir.copy(this._step).multiplyScalar(1 / travel);

      let consumed = 0;
      let stopped = false;
      let deflected = false;
      if (phys) {
        for (let seg = 0; seg < MAX_SEGMENTS && consumed < travel; seg++) {
          this._p.copy(b.pos).addScaledVector(this._dir, consumed);
          const n = phys.raycastAll(this._p, this._dir, travel - consumed, MASK_BULLET, this.hits, 8, b.ownerEntity);
          if (n === 0) break;
          const hit = this.hits[0];
          const spec: ShotSpec = {
            def: b.def, origin: this._p, direction: this._dir,
            penetration: b.power, muzzleVelocity: speed, rangeScale: 1,
            ownerEntity: b.ownerEntity, fromPlayer: b.fromPlayer,
            tracer: b.tracer, shotIndex: 0,
          };
          const outcome = this.resolveImpact(spec, hit, this._dir, b.travelled + consumed + hit.distance,
            b.damageScale, b.power, n, speed);
          if (outcome.stop) { stopped = true; break; }
          b.power = outcome.power;
          b.damageScale = outcome.damageScale;
          consumed += hit.distance + outcome.consumed;
          // A ricochet redirects the rest of the step; a penetration does not.
          if (outcome.continueDir.dot(this._dir) < 0.9999) {
            b.pos.copy(outcome.continueFrom);
            b.vel.copy(outcome.continueDir).multiplyScalar(speed * 0.55);
            b.travelled += consumed;
            deflected = true;
            break;
          }
        }
      }
      if (stopped) { this.retire(i); continue; }
      if (deflected) {
        if (b.tracerId >= 0 && this.tracers) this.tracers.update(b.tracerId, b.pos, b.vel);
        continue;
      }

      b.pos.addScaledVector(this._dir, travel);
      b.travelled += travel;
      if (b.tracerId >= 0 && this.tracers) this.tracers.update(b.tracerId, b.pos, b.vel);
    }
  }

  private retire(i: number): void {
    const b = this.bullets[i];
    if (!b.active) return;
    b.active = false;
    if (b.tracerId >= 0 && this.tracers) this.tracers.kill(b.tracerId);
    b.tracerId = -1;
    this.freeList.push(i);
  }

  clear(): void {
    for (let i = 0; i < this.bullets.length; i++) if (this.bullets[i].active) this.retire(i);
  }

  /* ------------------------------------------------------- impact resolve */

  private outcome = {
    stop: false,
    power: 0,
    damageScale: 1,
    consumed: 0,
    continueFrom: new THREE.Vector3(),
    continueDir: new THREE.Vector3(),
  };

  private resolveImpact(
    spec: ShotSpec, hit: RayHit, dir: THREE.Vector3, travelled: number,
    damageScale: number, power: number, hitCount: number, speed?: number,
  ): typeof this.outcome {
    const o = this.outcome;
    o.stop = true;
    o.power = power;
    o.damageScale = damageScale;
    o.consumed = 0;
    o.continueFrom.copy(hit.point);
    o.continueDir.copy(dir);

    const def = spec.def;
    const bal = def.ballistics;
    const props = surfaceProps(hit.surface);
    const v = speed ?? spec.muzzleVelocity;
    const energy = Math.max(0, damageAt(def, travelled) * damageScale)
      * Math.min(1, (v / Math.max(1, bal.muzzleVelocity)) ** 2 + 0.15);

    this._incoming.copy(dir);
    this._n.copy(hit.normal);

    /* --- explosive payloads end the story immediately ------------------- */
    if (bal.explosive) {
      this.detonate(hit.point, bal.explosive, spec);
      bus.emit('bullet:impact', {
        point: hit.point.clone(), normal: this._n.clone(), surface: hit.surface,
        incoming: this._incoming.clone(), energy: bal.explosive.damage, penetrated: false,
      });
      return o;
    }

    /* --- characters ------------------------------------------------------ */
    if (hit.entityId >= 0 && hit.entityId !== spec.ownerEntity) {
      const zone = hit.zone;
      const headshot = zone === 'head' || zone === 'neck';
      const zKey = zone in def.zones ? zone : 'chest';
      const raw = damageAt(def, travelled) * def.zones[zKey] * damageScale;
      // Pass the collider zone through so pricing / flinch / hitmarker can use
      // arm/leg/stomach rather than collapsing everything to headshot|chest.
      const res = this.damageResolver?.(
        hit.entityId, raw, headshot, hit.point, dir, spec.fromPlayer, zone,
      ) ?? { killed: false, applied: raw };

      bus.emit('damage:dealt', {
        targetId: hit.entityId, amount: res.applied, headshot,
        killed: res.killed, point: hit.point.clone(), fromPlayer: spec.fromPlayer,
      });
      bus.emit('bullet:impact', {
        point: hit.point.clone(), normal: this._n.clone(), surface: hit.surface,
        incoming: this._incoming.clone(), energy, penetrated: false,
      });
      if (spec.fromPlayer) {
        bus.emit('hud:hitmarker', { headshot, killed: res.killed, armor: !!res.armor });
      }

      // High-power rounds keep going through soft targets.
      const cost = props.penetrationDepth > 0 ? 0.35 / props.penetrationDepth : 99;
      if (power > cost && bal.penetration >= 1.5) {
        o.stop = false;
        o.power = power - cost;
        o.damageScale = damageScale * bal.penetrationDamage;
        o.continueFrom.copy(hit.point).addScaledVector(dir, 0.35);
        o.consumed = 0.35;
      }
      return o;
    }

    /* --- ricochet -------------------------------------------------------- */
    const cosIncidence = Math.min(1, Math.max(0, -dir.dot(this._n)));
    const shallow = 1 - Math.min(1, cosIncidence / 0.42);
    const ricochetChance = props.ricochet * bal.ricochet * shallow * shallow;
    if (ricochetChance > 0.02 && this.rand.next() < ricochetChance) {
      bus.emit('bullet:impact', {
        point: hit.point.clone(), normal: this._n.clone(), surface: hit.surface,
        incoming: this._incoming.clone(), energy: energy * 0.6, penetrated: false,
      });
      this.decal(hit, props, 0.055);
      // Reflect and scatter: a deflected round is not a mirror.
      o.continueDir.copy(dir).reflect(this._n);
      o.continueDir.x += this.rand.signed() * 0.10;
      o.continueDir.y += this.rand.signed() * 0.10;
      o.continueDir.z += this.rand.signed() * 0.10;
      o.continueDir.normalize();
      o.continueFrom.copy(hit.point).addScaledVector(o.continueDir, 0.01);
      o.damageScale = damageScale * 0.45;
      o.power = power * 0.5;
      o.consumed = 0.01;
      o.stop = false;
      return o;
    }

    /* --- penetration ----------------------------------------------------- */
    const thickness = this.exitThickness(hit, hitCount, dir);
    const cost = thickness / Math.max(0.005, props.penetrationDepth);
    const canPass = power >= cost && thickness > 0;

    bus.emit('bullet:impact', {
      point: hit.point.clone(), normal: this._n.clone(), surface: hit.surface,
      incoming: this._incoming.clone(), energy, penetrated: canPass,
    });
    this.decal(hit, props, canPass ? 0.05 : 0.062);

    if (!canPass) return o;

    this._exit.copy(hit.point).addScaledVector(dir, thickness + 0.004);
    bus.emit('bullet:impact', {
      point: this._exit.clone(), normal: this._n.clone().negate(), surface: hit.surface,
      incoming: this._incoming.clone(), energy: energy * bal.penetrationDamage, penetrated: true,
    });

    o.stop = false;
    o.power = power - cost;
    o.damageScale = damageScale * bal.penetrationDamage;
    o.continueFrom.copy(this._exit);
    o.consumed = thickness + 0.004;
    return o;
  }

  /**
   * Distance from the entry point to where the round leaves the material.
   *
   * The first back-face hit after the entry is the true exit; when the collider
   * is an open surface (a plane, a trimesh sheet) there is no back face, so we
   * fall back to a thin-sheet assumption rather than declaring the wall
   * infinitely thick.
   */
  private exitThickness(entry: RayHit, hitCount: number, dir: THREE.Vector3): number {
    void dir;
    for (let i = 1; i < hitCount; i++) {
      const h = this.hits[i];
      if (h.distance <= entry.distance + 1e-4) continue;
      if (h.backface || h.object === entry.object) {
        return Math.min(2.0, h.distance - entry.distance);
      }
    }
    return 0.02;
  }

  private decal(hit: RayHit, props: ReturnType<typeof surfaceProps>, size: number): void {
    if (!this.render || props.decal === 'none') return;
    this.render.addDecal({
      position: hit.point.clone(),
      normal: hit.normal.clone(),
      size: size * (0.8 + this.rand.next() * 0.5),
      group: props.decal,
      rotation: this.rand.next() * Math.PI * 2,
      lifetime: props.decal === 'blood' ? 22 : 60,
      parent: null,
    });
  }

  /* ------------------------------------------------------------ explosions */

  detonate(
    point: THREE.Vector3,
    payload: { radius: number; damage: number; power: number; kind: string },
    spec: { ownerEntity: number; fromPlayer: boolean },
  ): void {
    bus.emit('explosion', {
      point: point.clone(), radius: payload.radius, power: payload.power, kind: payload.kind,
    });
    const phys = this.physics;
    if (!phys) return;
    phys.applyExplosion(point, payload.radius, payload.power);

    const overlaps: Array<{ entityId: number; bodyHandle: number; object: THREE.Object3D | null; distance: number }> = [];
    const n = phys.overlapSphere(point, payload.radius, MASK_BULLET, overlaps, 32);
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const o = overlaps[i];
      if (o.entityId < 0 || seen.has(o.entityId)) continue;
      seen.add(o.entityId);
      // Inverse-square-ish falloff with a flat lethal core.
      const t = Math.min(1, o.distance / payload.radius);
      const falloff = Math.pow(1 - t, 1.7);
      const amount = payload.damage * falloff;
      if (amount < 1) continue;
      this._p.copy(point);
      this._dir.set(0, 1, 0);
      const res = this.damageResolver?.(o.entityId, amount, false, this._p, this._dir, spec.fromPlayer)
        ?? { killed: false, applied: amount };
      bus.emit('damage:dealt', {
        targetId: o.entityId, amount: res.applied, headshot: false,
        killed: res.killed, point: point.clone(), fromPlayer: spec.fromPlayer,
      });
      if (spec.fromPlayer) bus.emit('hud:hitmarker', { headshot: false, killed: res.killed, armor: false });
    }
  }

  /**
   * Where a round fired now would be after `t` seconds — used by the AI lead
   * solver and by the debug scene's trajectory ribbons.
   */
  predict(def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, muzzleVelocity: number,
    t: number, out: THREE.Vector3): THREE.Vector3 {
    const bal = def.ballistics;
    const step = 1 / 60;
    out.copy(origin);
    this._p2.copy(dir).normalize().multiplyScalar(muzzleVelocity);
    let elapsed = 0;
    while (elapsed < t) {
      const dt = Math.min(step, t - elapsed);
      const speed = this._p2.length();
      this._p2.multiplyScalar(1 - Math.min(0.5, bal.drag * speed * dt));
      this._p2.y += this.gravity * bal.gravityScale * dt;
      out.addScaledVector(this._p2, dt);
      elapsed += dt;
    }
    return out;
  }
}

function makeHit(): RayHit {
  return {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity, surface: 'concrete', object: null, entityId: -1,
    bodyHandle: -1, zone: 'none', backface: false,
  };
}
