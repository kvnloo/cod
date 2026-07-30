/**
 * Grenades and thrown projectiles, plus the analytic trajectory predictor the
 * HUD arc is drawn from.
 *
 * Two details make a grenade feel right rather than "physically plausible":
 *
 *  - **Rolling friction.** Rapier models Coulomb friction at contacts but not
 *    rolling resistance, so a sphere on a flat floor rolls forever. We apply a
 *    velocity-proportional angular brake plus a linear brake once the body is
 *    slow and in contact, which is what stops a frag from trickling across the
 *    map after it lands.
 *  - **Restitution that decays.** A grenade bounces hard off the first wall and
 *    dies quickly afterwards. We scale restitution down with each impact so the
 *    first bounce reads big and the object still settles inside a second.
 *
 * The predictor integrates the *same* constants with a fixed step and a sphere
 * cast per segment, so the drawn arc matches where the grenade actually lands,
 * bounces included.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { ProjectileOptions, RayHit, TrajectoryResult } from './types';
import { LAYER, MASK_MOVE } from './types';
import { groups, defaultMask } from './Layers';
import type { ColliderRegistry } from './Registry';
import type { QueryEngine } from './Queries';
import { makeRayHit } from './Queries';

export interface ProjectileHost {
  readonly world: RAPIER.World;
  readonly registry: ColliderRegistry;
  readonly queries: QueryEngine;
  gravity(): number;
}

export interface Projectile {
  readonly id: number;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  object: THREE.Object3D | null;
  /** Impacts so far — drives restitution decay and bounce audio. */
  bounces: number;
  age: number;
  alive: boolean;
  rollingFriction: number;
  restitution: number;
  radius: number;
  lastSpeed: number;
}

const rv = { x: 0, y: 0, z: 0 };
const vTmp = new THREE.Vector3();
const vVel = new THREE.Vector3();
const vPos = new THREE.Vector3();
const vNormal = new THREE.Vector3();
const scratchHit: RayHit = makeRayHit();

/** Below this speed a projectile in contact is considered at rest. */
const REST_SPEED = 0.35;

export class ProjectileSystem {
  private projectiles: Projectile[] = [];
  private nextId = 1;
  /** Callback fired on each impact — the physics system republishes it. */
  onImpact: ((p: Projectile, point: THREE.Vector3, speed: number) => void) | null = null;

  constructor(private host: ProjectileHost) { }

  get count(): number { return this.projectiles.length; }

  spawn(opts: ProjectileOptions): Projectile {
    const radius = opts.radius ?? 0.045;
    const mass = opts.mass ?? 0.4;
    const p = opts.position;

    const body = this.host.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setLinvel(opts.velocity.x, opts.velocity.y, opts.velocity.z)
        // CCD is essential: a thrown grenade covers ~20 cm per 120 Hz step and
        // must not pass through a 10 cm wall.
        .setCcdEnabled(true)
        .setSoftCcdPrediction(radius * 4)
        .setLinearDamping(0.02)
        .setAngularDamping(0.12)
        .setCanSleep(true),
    );

    const layer = LAYER.PROJECTILE;
    const mask = (opts.mask ?? defaultMask(layer)) | MASK_MOVE;
    const collider = this.host.world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setMass(mass)
        .setFriction(opts.friction ?? 0.55)
        .setRestitution(opts.restitution ?? 0.42)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setCollisionGroups(groups(layer, mask))
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL),
      body,
    );

    this.host.registry.add({
      handle: collider.handle,
      bodyId: -1,
      object: opts.object ?? null,
      surface: opts.surface ?? 'metal',
      entityId: opts.entityId ?? -1,
      zone: 'none',
      layer,
      ranges: null,
      ragdollId: -1,
      debris: false,
    });

    const proj: Projectile = {
      id: this.nextId++,
      body, collider,
      object: opts.object ?? null,
      bounces: 0,
      age: 0,
      alive: true,
      rollingFriction: opts.rollingFriction ?? 1.0,
      restitution: opts.restitution ?? 0.42,
      radius,
      lastSpeed: opts.velocity.length(),
    };
    this.projectiles.push(proj);
    return proj;
  }

  remove(p: Projectile): void {
    const i = this.projectiles.indexOf(p);
    if (i >= 0) this.projectiles.splice(i, 1);
    this.release(p);
  }

  private release(p: Projectile): void {
    if (!p.alive) return;
    p.alive = false;
    this.host.registry.remove(p.collider.handle);
    if (this.host.world.bodies.contains(p.body.handle)) {
      this.host.world.removeRigidBody(p.body);
    }
  }

  fixedUpdate(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      if (p.body.isSleeping()) { p.lastSpeed = 0; continue; }

      const v = p.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);

      // A sharp drop in speed means the solver just resolved an impact.
      if (p.lastSpeed - speed > 1.2) {
        p.bounces++;
        const t = p.body.translation();
        vPos.set(t.x, t.y, t.z);
        this.onImpact?.(p, vPos, p.lastSpeed - speed);
        // Decay restitution so the first bounce reads big and it settles fast.
        const next = Math.max(0.05, p.restitution * 0.55);
        p.restitution = next;
        p.collider.setRestitution(next);
      }
      p.lastSpeed = speed;

      // Rolling resistance. Only meaningful once the body is slow enough to be
      // rolling rather than flying.
      if (p.rollingFriction > 0 && speed < 6) {
        const w = p.body.angvel();
        const brake = Math.min(1, p.rollingFriction * dt * 4.5);
        rv.x = w.x * (1 - brake); rv.y = w.y * (1 - brake); rv.z = w.z * (1 - brake);
        p.body.setAngvel(rv, false);
        if (speed < 2.2) {
          const lin = Math.min(1, p.rollingFriction * dt * 2.2);
          rv.x = v.x * (1 - lin); rv.y = v.y; rv.z = v.z * (1 - lin);
          p.body.setLinvel(rv, false);
        }
        if (speed < REST_SPEED && Math.hypot(w.x, w.y, w.z) < 0.6) {
          p.body.sleep();
        }
      }
    }
  }

  /** Presentation sync for projectile meshes. */
  update(): void {
    for (const p of this.projectiles) {
      if (!p.object) continue;
      const t = p.body.translation();
      const r = p.body.rotation();
      p.object.position.set(t.x, t.y, t.z);
      p.object.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  clear(): void {
    for (const p of this.projectiles) this.release(p);
    this.projectiles.length = 0;
  }

  /* -------------------------------------------------------------- prediction */

  /**
   * Integrates a throw and writes world-space points into `out` as XYZ triples.
   *
   * Uses the same gravity and restitution model as the live body and a sphere
   * cast per step, so the arc lands where the grenade lands — including after a
   * wall bounce, which is the whole point of drawing it.
   */
  predictTrajectory(
    origin: THREE.Vector3, velocity: THREE.Vector3, out: Float32Array,
    opts: {
      radius?: number; restitution?: number; friction?: number; maxTime?: number;
      step?: number; maxBounces?: number; mask?: number; ignoreEntity?: number;
    } = {},
  ): TrajectoryResult {
    const radius = opts.radius ?? 0.045;
    let restitution = opts.restitution ?? 0.42;
    const friction = opts.friction ?? 0.55;
    const step = opts.step ?? 1 / 40;
    const maxTime = opts.maxTime ?? 4;
    const maxBounces = opts.maxBounces ?? 3;
    const mask = opts.mask ?? (MASK_MOVE | LAYER.GLASS);
    const gravity = this.host.gravity();
    const capacity = Math.floor(out.length / 3);

    vPos.copy(origin);
    vVel.copy(velocity);

    let count = 0;
    let bounces = 0;
    let firstBounce = -1;
    let time = 0;

    if (capacity > 0) {
      out[0] = vPos.x; out[1] = vPos.y; out[2] = vPos.z;
      count = 1;
    }

    while (count < capacity && time < maxTime) {
      vVel.y += gravity * step;
      vTmp.copy(vVel).multiplyScalar(step);
      let travel = vTmp.length();
      time += step;

      if (travel > 1e-6) {
        vTmp.multiplyScalar(1 / travel);
        const hit = this.host.queries.spherecast(
          vPos, vTmp, radius, travel, mask, scratchHit, opts.ignoreEntity ?? -1,
        );
        if (hit.hit) {
          const advance = Math.max(0, hit.distance - 1e-3);
          vPos.addScaledVector(vTmp, advance);
          travel -= advance;

          vNormal.copy(hit.normal);
          // Reflect, splitting into normal (restitution) and tangential
          // (friction) components — the same split the solver makes.
          const vn = vVel.dot(vNormal);
          vTmp.copy(vNormal).multiplyScalar(vn);
          vVel.sub(vTmp);                              // tangential
          vVel.multiplyScalar(Math.max(0, 1 - friction * 0.35));
          vVel.addScaledVector(vNormal, -vn * restitution);
          restitution = Math.max(0.05, restitution * 0.55);

          bounces++;
          if (firstBounce < 0) firstBounce = count;
          if (bounces > maxBounces) {
            out[count * 3] = vPos.x; out[count * 3 + 1] = vPos.y; out[count * 3 + 2] = vPos.z;
            count++;
            break;
          }
          // Nudge off the surface so the next cast does not start embedded.
          vPos.addScaledVector(vNormal, 1e-3);
        } else {
          vPos.addScaledVector(vTmp, travel);
        }
      }

      out[count * 3] = vPos.x;
      out[count * 3 + 1] = vPos.y;
      out[count * 3 + 2] = vPos.z;
      count++;

      if (vVel.lengthSq() < 0.02 && bounces > 0) break;
    }

    return { count, firstBounce, time };
  }
}
