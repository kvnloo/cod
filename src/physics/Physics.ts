/**
 * PhysicsSystem — Rapier3D backend for {@link PhysicsAPI}.
 *
 * Owns the one `RAPIER.World` in the process and everything hanging off it:
 * scene queries, the kinematic character controller, static collision baked out
 * of the Three.js scene graph, ragdolls, destruction and projectiles.
 *
 * Scheduling:
 *   fixedUpdate  → accumulate, step the solver at the preset's sim rate,
 *                  snapshot transforms, tick subsystems, drain contact events
 *   update       → write interpolated transforms onto scene objects
 *
 * The solver rate is settings-driven (120 Hz normally, 60 Hz on `low`) and the
 * step is decoupled from the engine's fixed tick by an accumulator, so lowering
 * quality genuinely halves the physics cost instead of just changing a number.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { SurfaceType } from '../core/Surfaces';
import type {
  BodyDesc, BodyHandle, CharacterController, CharacterMoveResult, DebrisOptions,
  GlassShatterOptions, HitZone, OverlapResult, PhysicsAPI, ProjectileOptions,
  RagdollHandle, RagdollOptions, RayHit, StaticBuildResult, TrajectoryResult,
} from './types';
import { LAYER, MASK_SIGHT } from './types';
import { queryGroups } from './Layers';
import { ColliderRegistry } from './Registry';
import { QueryEngine } from './Queries';
import { CapsuleCharacterController } from './CharacterController';
import { SceneColliderBuilder } from './SceneColliders';
import { RapierBody, applyColliderProps, bodyDescFor, colliderDescFor } from './Bodies';
import { RagdollManager } from './Ragdoll';
import { DestructionSystem } from './Destruction';
import { ProjectileSystem, type Projectile } from './Projectiles';
import './DebugScene';

export { makeRayHit } from './Queries';

/** Anything that can hand back the canonical rig bones by name. */
export interface BoneSource {
  object: THREE.Object3D;
  bone(name: string): THREE.Object3D | null;
}

const GRAVITY = -22.0;
/** Minimum impulse magnitude that publishes a `physics:impact` event. */
const IMPACT_THRESHOLD = 260;
/** Per-collider cooldown between impact events, seconds. */
const IMPACT_COOLDOWN = 0.12;

const vTmp = new THREE.Vector3();
const vTmp2 = new THREE.Vector3();
const rv = { x: 0, y: 0, z: 0 };

export class PhysicsSystem implements System, PhysicsAPI {
  readonly name = 'physics';
  readonly order = ORDER.PHYSICS;
  ready = false;

  /** The Rapier world. Only this module should touch it directly. */
  world!: RAPIER.World;
  readonly registry = new ColliderRegistry();
  queries!: QueryEngine;
  statics!: SceneColliderBuilder;
  ragdolls!: RagdollManager;
  destruction!: DestructionSystem;
  projectiles!: ProjectileSystem;

  /** Scene node debris and physics proxies are parented to. */
  readonly debrisRoot = new THREE.Group();

  /** Hard cap on live rigid bodies; debris is reclaimed to stay under it. */
  maxBodies = 900;

  private bodies = new Map<number, RapierBody>();
  private characters: CapsuleCharacterController[] = [];
  private nextBodyId = 1;
  private events!: RAPIER.EventQueue;
  private accumulator = 0;
  private simDt = 1 / 120;
  private stepMs = 0;
  private simTime = 0;
  private activeCount = 0;
  private contactCount = 0;
  private contactStamp = -1;
  private lastPreset = '';
  private staticDirty = true;
  private sceneRoot: THREE.Object3D | null = null;
  private impactCooldowns = new Map<number, number>();
  private overlapScratch: OverlapResult[] = [];
  private explosionBodies: RAPIER.RigidBody[] = [];

  /* -------------------------------------------------------------------- init */

  async init(ctx: EngineContext): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.lengthUnit = 1;
    this.events = new RAPIER.EventQueue(true);

    this.queries = new QueryEngine(this);
    this.statics = new SceneColliderBuilder(this);
    this.ragdolls = new RagdollManager(this);
    this.destruction = new DestructionSystem(this);
    this.projectiles = new ProjectileSystem(this);
    this.projectiles.onImpact = (p, point, speed) => {
      bus.emit('physics:impact', {
        point: point.clone(),
        impulse: speed * 12,
        material: this.registry.resolve(p.collider.handle).surface,
      });
    };

    this.debrisRoot.name = 'physics-debris';
    this.debrisRoot.matrixAutoUpdate = false;
    ctx.scene.add(this.debrisRoot);
    this.sceneRoot = ctx.scene;

    this.applyQuality();
    bus.on('quality:changed', () => this.applyQuality());
    bus.on('level:loaded', () => { this.staticDirty = true; });
    bus.on('game:ready', () => { this.staticDirty = true; });

    this.ready = true;
  }

  private applyQuality(): void {
    const preset = settings.preset;
    this.lastPreset = preset;
    const cheap = preset === 'low';
    // `low` must be genuinely cheap: half the sim rate, half the solver work.
    this.simDt = cheap ? 1 / 60 : 1 / 120;
    this.world.numSolverIterations = cheap ? 2 : preset === 'medium' ? 3 : 4;
    this.world.numInternalPgsIterations = cheap ? 1 : 1;
    this.world.maxCcdSubsteps = cheap ? 1 : 2;
    this.destruction.budget = THREE.MathUtils.clamp(
      Math.round(settings.gfx.maxParticles / 140), 48, 320,
    );
    this.ragdolls.budget = cheap ? 4 : preset === 'medium' ? 6 : 8;
    this.maxBodies = cheap ? 420 : 900;
  }

  /* ------------------------------------------------------------------ update */

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (!this.ready) return;
    if (settings.preset !== this.lastPreset) this.applyQuality();

    if (this.staticDirty) {
      this.staticDirty = false;
      this.rebuildStatic(ctx.scene);
    }

    this.accumulator += dt;
    // Cap the catch-up so a hitch cannot spiral into a multi-second solve.
    const maxSteps = 3;
    let steps = 0;
    while (this.accumulator >= this.simDt - 1e-9 && steps < maxSteps) {
      this.accumulator -= this.simDt;
      steps++;
      this.stepOnce(this.simDt);
    }
    if (steps >= maxSteps) this.accumulator = 0;
  }

  private stepOnce(dt: number): void {
    const t0 = performance.now();
    this.world.timestep = dt;
    this.world.step(this.events);
    const ms = performance.now() - t0;
    // Honest, lightly smoothed so the HUD is readable rather than flattering.
    this.stepMs = this.stepMs * 0.85 + ms * 0.15;
    this.simTime += dt;

    for (const b of this.bodies.values()) b.captureTransform();

    this.destruction.fixedUpdate(dt);
    this.projectiles.fixedUpdate(dt);
    this.ragdolls.fixedUpdate(dt);
    this.reapBodies(dt);
    this.drainEvents();
  }

  update(dt: number, ctx: EngineContext): void {
    if (!this.ready) return;
    void dt;
    const alpha = THREE.MathUtils.clamp(this.accumulator / this.simDt, 0, 1);
    for (const b of this.bodies.values()) b.syncObject(alpha);
    this.destruction.update();
    this.projectiles.update();
    this.ragdolls.update();
    void ctx;
  }

  private reapBodies(dt: number): void {
    if (this.bodies.size === 0) return;
    for (const b of this.bodies.values()) {
      b.age += dt;
      if (b.lifetime !== Infinity && b.age > b.lifetime) b.remove();
    }
  }

  private drainEvents(): void {
    this.events.drainContactForceEvents((e) => {
      const force = e.totalForceMagnitude();
      if (force < IMPACT_THRESHOLD) return;
      const h1 = e.collider1();
      const last = this.impactCooldowns.get(h1) ?? -1;
      if (last >= 0 && this.simTime - last < IMPACT_COOLDOWN) return;
      this.impactCooldowns.set(h1, this.simTime);

      const collider = this.world.colliders.get(h1);
      if (!collider) return;
      const t = collider.translation();
      const other = this.registry.resolve(e.collider2()).surface;
      bus.emit('physics:impact', {
        point: new THREE.Vector3(t.x, t.y, t.z),
        impulse: force,
        material: other,
      });
    });
    if (this.impactCooldowns.size > 256) {
      for (const [k, t] of this.impactCooldowns) {
        if (this.simTime - t > 2) this.impactCooldowns.delete(k);
      }
    }
  }

  /* ----------------------------------------------------------------- queries */

  raycast(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number,
    out: RayHit, ignoreEntity = -1,
  ): RayHit {
    if (!this.ready) { out.hit = false; return out; }
    return this.queries.raycast(origin, dir, maxDist, mask, out, ignoreEntity);
  }

  raycastAll(
    origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask: number,
    out: RayHit[], max = 8, ignoreEntity = -1,
  ): number {
    if (!this.ready) return 0;
    return this.queries.raycastAll(origin, dir, maxDist, mask, out, max, ignoreEntity);
  }

  spherecast(
    origin: THREE.Vector3, dir: THREE.Vector3, radius: number, maxDist: number,
    mask: number, out: RayHit,
  ): RayHit {
    if (!this.ready) { out.hit = false; return out; }
    return this.queries.spherecast(origin, dir, radius, maxDist, mask, out);
  }

  overlapSphere(
    center: THREE.Vector3, radius: number, mask: number, out: OverlapResult[], max = 32,
  ): number {
    if (!this.ready) return 0;
    return this.queries.overlapSphere(center, radius, mask, out, max);
  }

  lineOfSight(
    from: THREE.Vector3, to: THREE.Vector3, mask = MASK_SIGHT, ignoreEntity = -1,
  ): boolean {
    if (!this.ready) return true;
    return this.queries.lineOfSight(from, to, mask, ignoreEntity);
  }

  /* ------------------------------------------------------------------ bodies */

  addBody(desc: BodyDesc): BodyHandle {
    if (!this.ready) throw new Error('[physics] addBody before init');
    if (this.bodies.size >= this.maxBodies) this.destruction.clear();

    const id = this.nextBodyId++;
    const body = this.world.createRigidBody(bodyDescFor(desc));

    const cd = applyColliderProps(colliderDescFor(desc.shape), desc);
    if (desc.mass !== undefined && desc.mass > 0) cd.setMass(desc.mass);
    if (desc.kind === 'dynamic') {
      cd.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      cd.setContactForceEventThreshold(IMPACT_THRESHOLD);
    }
    const collider = this.world.createCollider(cd, body);
    if (desc.ccd) body.enableCcd(true);

    const layer = desc.layer ?? (desc.kind === 'static' ? LAYER.STATIC : LAYER.DYNAMIC);
    this.registry.add({
      handle: collider.handle,
      bodyId: id,
      object: desc.object ?? null,
      surface: desc.surface ?? 'concrete',
      entityId: desc.entityId ?? -1,
      zone: desc.zone ?? 'none',
      layer,
      ranges: null,
      ragdollId: -1,
      debris: false,
    });

    const handle = new RapierBody(id, desc, body, (b) => this.destroyBody(b, collider));
    this.bodies.set(id, handle);
    return handle;
  }

  removeBody(handle: BodyHandle): void {
    handle.remove();
  }

  private destroyBody(b: RapierBody, collider: RAPIER.Collider): void {
    this.bodies.delete(b.id);
    this.registry.remove(collider.handle);
    if (this.world.bodies.contains(b.body.handle)) this.world.removeRigidBody(b.body);
  }

  /** Body by id, for systems that stored only the numeric handle. */
  bodyById(id: number): RapierBody | undefined { return this.bodies.get(id); }

  /* -------------------------------------------------------------- characters */

  createCharacter(radius: number, height: number, layer = LAYER.PLAYER): CharacterController {
    const c = new CapsuleCharacterController(this, radius, height, layer);
    this.characters.push(c);
    const dispose = c.dispose.bind(c);
    c.dispose = () => {
      const i = this.characters.indexOf(c);
      if (i >= 0) this.characters.splice(i, 1);
      dispose();
    };
    return c;
  }

  /**
   * Displacement a point riding `colliderHandle` underwent last step, plus the
   * platform's yaw delta. Zero for anything that is not a moving body.
   */
  platformDelta(colliderHandle: number, point: THREE.Vector3, out: THREE.Vector3): number {
    out.set(0, 0, 0);
    if (colliderHandle < 0) return 0;
    const rec = this.registry.get(colliderHandle);
    if (!rec || rec.bodyId < 0) return 0;
    const body = this.bodies.get(rec.bodyId);
    if (!body || body.desc.kind === 'static') return 0;
    return body.pointDelta(point, out);
  }

  /* ------------------------------------------------------------- static bake */

  /** Rebuilds every static collider from the scene graph. */
  rebuildStatic(root?: THREE.Object3D | null): StaticBuildResult {
    const target = root ?? this.sceneRoot;
    if (!target || !this.ready) return { colliders: 0, triangles: 0, merged: 0, ms: 0 };
    this.staticDirty = false;
    this.statics.clear();
    const res = this.statics.build(target);
    console.info(
      `[physics] static bake: ${res.colliders} colliders `
      + `(${res.merged} merged, ${res.triangles} tris) in ${res.ms.toFixed(1)}ms`,
    );
    return res;
  }

  /** Adds colliders for newly streamed geometry without dropping existing ones. */
  addStatic(root: THREE.Object3D): StaticBuildResult {
    if (!this.ready) return { colliders: 0, triangles: 0, merged: 0, ms: 0 };
    return this.statics.build(root);
  }

  /** Drops all static colliders — used when a debug scene takes over the world. */
  clearStatic(): void { this.statics.clear(); }

  /** Full teardown of dynamic state; static geometry is rebuilt on demand. */
  reset(): void {
    this.destruction.clear();
    this.projectiles.clear();
    this.ragdolls.clear();
    for (const b of [...this.bodies.values()]) b.remove();
    this.bodies.clear();
    this.statics.clear();
    this.impactCooldowns.clear();
    this.accumulator = 0;
  }

  /* --------------------------------------------------------------- explosion */

  applyExplosion(center: THREE.Vector3, radius: number, power: number): void {
    if (!this.ready || radius <= 0) return;
    const mask = LAYER.DYNAMIC | LAYER.RAGDOLL | LAYER.PROJECTILE | LAYER.GLASS;
    const seen = this.explosionBodies;
    seen.length = 0;

    rv.x = center.x; rv.y = center.y; rv.z = center.z;
    this.world.intersectionsWithShape(
      rv, IDENTITY_ROT, this.explosionBall(radius),
      (collider) => {
        const body = collider.parent();
        if (!body || !body.isDynamic()) return true;
        for (const b of seen) if (b.handle === body.handle) return true;
        seen.push(body);
        return seen.length < 192;
      },
      undefined, queryGroups(mask),
    );

    for (const body of seen) {
      const t = body.translation();
      vTmp.set(t.x - center.x, t.y - center.y, t.z - center.z);
      const d = vTmp.length();
      if (d > radius) continue;
      const falloff = 1 - d / radius;

      if (d < 1e-4) vTmp.set(0, 1, 0);
      else vTmp.multiplyScalar(1 / d);

      // Cover halves the blast: standing behind a wall should matter.
      vTmp2.set(t.x, t.y, t.z);
      const exposed = this.queries.lineOfSight(center, vTmp2, MASK_SIGHT) ? 1 : 0.45;

      // Impulse targets a velocity change so light debris and heavy crates end
      // up moving at comparable speeds — the reading a player expects.
      vTmp.y += 0.45;
      vTmp.normalize();
      const dv = power * falloff * falloff * 0.35 * exposed;
      const mass = THREE.MathUtils.clamp(body.mass(), 0.05, 400);
      vTmp.multiplyScalar(dv * mass);
      rv.x = vTmp.x; rv.y = vTmp.y; rv.z = vTmp.z;
      body.applyImpulse(rv, true);

      rv.x = (vTmp.z - vTmp.y) * 0.02 * mass;
      rv.y = (vTmp.x - vTmp.z) * 0.02 * mass;
      rv.z = (vTmp.y - vTmp.x) * 0.02 * mass;
      body.applyTorqueImpulse(rv, true);
    }
  }

  private explosionBallCache = new Map<number, RAPIER.Ball>();
  private explosionBall(radius: number): RAPIER.Ball {
    const key = Math.round(radius * 20) / 20;
    let b = this.explosionBallCache.get(key);
    if (!b) { b = new RAPIER.Ball(key); this.explosionBallCache.set(key, b); }
    return b;
  }

  /* ------------------------------------------------------- destruction / fx  */

  spawnDebris(
    point: THREE.Vector3, normal: THREE.Vector3, source: THREE.Object3D | null,
    opts?: DebrisOptions,
  ): number {
    if (!this.ready) return 0;
    return this.destruction.spawnDebris(point, normal, source, opts);
  }

  shatterGlass(pane: THREE.Mesh, opts: GlassShatterOptions): number {
    if (!this.ready) return 0;
    const n = this.destruction.shatterGlass(pane, opts);
    if (n > 0) this.staticDirty = true; // the pane's collider must go away
    return n;
  }

  /* ---------------------------------------------------------------- ragdolls */

  spawnRagdoll(opts: RagdollOptions): RagdollHandle {
    return this.ragdolls.spawn(opts);
  }

  /**
   * Convenience wrapper for the character module: builds a ragdoll from a live
   * rig and kicks it at the hit zone. Structurally typed so physics never has to
   * import the character implementation.
   */
  ragdollFromCharacter(
    character: BoneSource, impulse: THREE.Vector3, zone: HitZone,
    opts: Partial<RagdollOptions> = {},
  ): RagdollHandle {
    const bones: Record<string, THREE.Object3D | null> = {};
    for (const name of BONE_NAMES) bones[name] = character.bone(name);
    const rag = this.ragdolls.spawn({ ...opts, root: character.object, bones });
    rag.applyImpulse(zone, impulse);
    return rag;
  }

  removeRagdoll(r: RagdollHandle): void { this.ragdolls.remove(r); }

  /* ------------------------------------------------------------- projectiles */

  spawnProjectile(opts: ProjectileOptions): Projectile {
    return this.projectiles.spawn(opts);
  }

  removeProjectile(p: Projectile): void { this.projectiles.remove(p); }

  predictTrajectory(
    origin: THREE.Vector3, velocity: THREE.Vector3, out: Float32Array,
    opts?: Parameters<ProjectileSystem['predictTrajectory']>[3],
  ): TrajectoryResult {
    if (!this.ready) return { count: 0, firstBounce: -1, time: 0 };
    return this.projectiles.predictTrajectory(origin, velocity, out, opts);
  }

  gravity(): number { return GRAVITY; }

  /* -------------------------------------------------------------------- misc */

  stats(): { bodies: number; active: number; contacts: number; stepMs: number } {
    if (!this.ready) return { bodies: 0, active: 0, contacts: 0, stepMs: 0 };
    let active = 0;
    this.world.islands.forEachActiveRigidBodyHandle(() => { active++; });
    this.activeCount = active;

    // Contact pairs are expensive to count; refresh a few times a second.
    if (this.contactStamp < 0 || this.simTime - this.contactStamp > 0.25) {
      this.contactStamp = this.simTime;
      let pairs = 0;
      this.world.colliders.forEach((c) => {
        this.world.narrowPhase.contactPairsWith(c.handle, () => { pairs++; });
      });
      this.contactCount = pairs >> 1;
    }

    return {
      bodies: this.world.bodies.len(),
      active: this.activeCount,
      contacts: this.contactCount,
      stepMs: this.stepMs,
    };
  }

  /** Extra diagnostics for the debug HUD and scripted verification. */
  debugStats(): {
    bodies: number; active: number; contacts: number; stepMs: number;
    colliders: number; debris: number; ragdolls: number; projectiles: number;
    characters: number; simHz: number;
  } {
    const s = this.stats();
    return {
      ...s,
      colliders: this.ready ? this.world.colliders.len() : 0,
      debris: this.destruction?.count ?? 0,
      ragdolls: this.ragdolls?.count ?? 0,
      projectiles: this.projectiles?.count ?? 0,
      characters: this.characters.length,
      simHz: Math.round(1 / this.simDt),
    };
  }

  dispose(): void {
    if (!this.ready) return;
    this.reset();
    this.destruction.dispose();
    this.events.free();
    this.world.free();
    this.ready = false;
  }
}

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };

/** Canonical bone names, duplicated here so physics never imports the rig. */
const BONE_NAMES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'lowerArmL', 'handL',
  'shoulderR', 'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL', 'toeL',
  'upperLegR', 'lowerLegR', 'footR', 'toeR',
];

/** Fresh, zeroed move result. Callers keep one per controller. */
export function makeMoveResult(): CharacterMoveResult {
  return {
    applied: new THREE.Vector3(), grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0), groundSurface: 'concrete' as SurfaceType,
    blocked: false, ceiling: false, impactSpeed: 0,
    platformDelta: new THREE.Vector3(), platformYaw: 0,
  };
}
