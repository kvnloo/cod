/**
 * Kinematic capsule character controller.
 *
 * This is the single most gameplay-critical piece of the physics module, so it
 * is a hand-written collide-and-slide solver on top of Rapier's shape casts
 * rather than Rapier's built-in controller — we need exact control over step-up,
 * ground snapping and slope behaviour to get shooter-grade feel.
 *
 * Per `move()`:
 *
 *   0. carry by any moving platform we were standing on
 *   1. depenetrate (iterative, so a spawn inside geometry recovers)
 *   2. probe the ground so step-up/snap decisions know the starting state
 *   3. sweep the upward component (ceiling detection)
 *   4. horizontal collide-and-slide, Quake3 `PM_SlideMove` plane clipping with a
 *      step-up attempt whenever a wall-ish plane blocks us
 *   5. sweep the downward component (landing, steep-slope sliding)
 *   6. ground snap so descending stairs does not become a series of hops
 *   7. final depenetration pass
 *
 * Everything runs against a shared scratch pool: `move()` allocates nothing of
 * our own (Rapier's compat layer allocates its own result objects, which we
 * cannot avoid and keep bounded by capping the iteration counts).
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { SurfaceType } from '../core/Surfaces';
import type { CharacterController, CharacterHitboxDesc, CharacterMoveResult, HitZone } from './types';
import { LAYER } from './types';
import { queryGroups, groups, defaultMask } from './Layers';
import type { ColliderRegistry } from './Registry';

/** Gap kept between the capsule and geometry; larger than Rapier's own margins. */
const SKIN = 0.012;
/** Iterations of the collide-and-slide loop. */
const MAX_BUMPS = 5;
/** Planes remembered while clipping, matching Quake's solver. */
const MAX_PLANES = 5;
/** Depenetration passes per move. */
const DEPEN_ITERS = 4;
/** Prediction distance for the depenetration contact query. */
const DEPEN_PREDICTION = 0.06;
/** Downward probe length used to classify "standing on something". */
const GROUND_PROBE = 0.14;
/** A hit closer than this counts as ground contact. */
const GROUND_EPS = SKIN + 0.035;
/** Assumed character mass when shoving dynamic props out of the way. */
const CHARACTER_MASS = 82;
/**
 * Minimum height a step-up onto a genuine obstacle must gain. Below this there
 * is nothing to step onto, and hopping the capsule in place costs a visible
 * hitch for no traversal.
 */
const STEP_MIN_GAIN = 0.02;
/**
 * A blocking plane whose normal is this close to the normal of the surface we
 * are already standing on is that same surface, seen through the edge cone of a
 * grazing shape cast — not an obstacle.
 *
 * The separation is wide and was measured, not guessed: over a full lab run the
 * phantom contacts on a 30°/40° ramp dot at 0.88, while every genuine blocker in
 * the same run dots at 0.40 or below (a kerb face against flat ground dots at
 * 0.00). 0.80 sits in the gap — 37° of daylight — and no real obstacle worth
 * stepping onto is within 37° of the floor it stands on.
 */
const SAME_SURFACE_DOT = 0.80;

/**
 * Additive fields the solver fills in when the caller supplies them.
 *
 * `CharacterMoveResult` (src/physics/types.ts) is a shared contract this module
 * does not own, so the two extra facts the Apex movement model needs are passed
 * as *optional* fields: a caller that allocates them gets them, a caller that
 * does not is unaffected. Both are strictly outputs.
 *
 * They exist because `blocked` alone is ambiguous. It is true both when a wall
 * genuinely stopped you and when a 150 mm kerb was resolved by a step-up, and a
 * caller that cannot tell the two apart has no choice but to guess — which is
 * precisely the bug that launched the player off kerbs (Movement.ts:332 in the
 * audited build: it rebuilt velocity from the *applied displacement*, whose y
 * component is the step-up rise).
 */
export interface CharacterMoveResultEx extends CharacterMoveResult {
  /**
   * Unit normal of the wall that actually stopped horizontal motion, zeroed
   * when nothing did. Never the normal of a plane a step-up climbed over.
   */
  wallNormal?: THREE.Vector3;
  /** True when the slide phase resolved by stepping up onto something. */
  stepped?: boolean;
  /** Height gained by that step-up, metres. */
  stepRise?: number;
}

export interface ControllerHost {
  readonly world: RAPIER.World;
  readonly registry: ColliderRegistry;
  /**
   * World-space displacement a point attached to `colliderHandle` underwent in
   * the last simulation step, plus the platform's yaw delta (radians).
   * Returns 0 and leaves `out` zeroed when the collider is not moving.
   */
  platformDelta(colliderHandle: number, point: THREE.Vector3, out: THREE.Vector3): number;
}

/* ------------------------------------------------------------------ scratch */

const rp = { x: 0, y: 0, z: 0 };
const rv = { x: 0, y: 0, z: 0 };
const rq = { x: 0, y: 0, z: 0, w: 1 };
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

const vPos = new THREE.Vector3();
const vMotion = new THREE.Vector3();
const vRemaining = new THREE.Vector3();
const vDir = new THREE.Vector3();
const vTmp = new THREE.Vector3();
const vTmp2 = new THREE.Vector3();
const vClip = new THREE.Vector3();
const vCrease = new THREE.Vector3();
const vStepStart = new THREE.Vector3();
const vStepPos = new THREE.Vector3();
const vPlatform = new THREE.Vector3();
const vStart = new THREE.Vector3();
const vImpulse = new THREE.Vector3();
const vPoint = new THREE.Vector3();
const planes: THREE.Vector3[] = [];
for (let i = 0; i < MAX_PLANES; i++) planes.push(new THREE.Vector3());

interface SweepHit {
  hit: boolean;
  toi: number;
  normal: THREE.Vector3;
  handle: number;
}

const sweepA: SweepHit = { hit: false, toi: 0, normal: new THREE.Vector3(), handle: -1 };
const sweepB: SweepHit = { hit: false, toi: 0, normal: new THREE.Vector3(), handle: -1 };
const sweepC: SweepHit = { hit: false, toi: 0, normal: new THREE.Vector3(), handle: -1 };
const groundHit: SweepHit = { hit: false, toi: 0, normal: new THREE.Vector3(), handle: -1 };

/* ------------------------------------------------------------- implementation */

export class CapsuleCharacterController implements CharacterController {
  radius: number;
  height: number;

  /** Maximum walkable slope in degrees. */
  slopeLimit = 47;
  /** Obstacles up to this tall are stepped over without losing speed. */
  stepHeight = 0.45;
  /** How far below the feet we look when snapping back to the ground. */
  snapDistance = 0.42;
  /** Impulse scale applied to dynamic props we walk into. */
  pushForce = 1.0;

  /** Collider of the physical proxy so other bodies collide with the character. */
  readonly proxyBody: RAPIER.RigidBody;
  private proxyCollider: RAPIER.Collider;

  private shape: RAPIER.Capsule;
  private mask: number;
  private layer: number;
  private disposed = false;
  /**
   * Written as a plain field rather than a constructor parameter property so the
   * file can be imported by node's type-stripping loader — that is what lets
   * `tools/g1-movelab.mjs` drive the real controller against a real Rapier world
   * headlessly, with no browser and no GPU.
   */
  private host: ControllerHost;

  /** Ground state carried between moves for snapping and platform riding. */
  private groundCollider = -1;
  private grounded = false;
  private pendingHeightShift = 0;
  /** Horizontal distance a step-up advanced beyond the frame's motion budget. */
  private stepDebt = 0;
  /** True when this move's slide phase resolved by stepping onto something. */
  private stepped = false;
  private stepNormal = new THREE.Vector3(0, 1, 0);
  private stepRise = 0;
  /** Normal of the wall that stopped horizontal motion, when one did. */
  private wallHit = false;
  private wallNormal = new THREE.Vector3();

  /** Owning gameplay entity; stamped onto every collider this controller owns. */
  private entityId = -1;
  private entityObject: THREE.Object3D | null = null;
  /** Movement-layer the controller was constructed with (PLAYER / ENEMY). */
  private hitLayer: number;
  /** Multi-zone living hit volumes parented to the kinematic proxy body. */
  private hitColliders: RAPIER.Collider[] = [];
  private hitboxDescs: CharacterHitboxDesc[] = [];
  /** Height the current hitbox offsets were authored against. */
  private hitboxRefHeight = 0;

  constructor(
    host: ControllerHost,
    radius: number,
    height: number,
    layer: number = LAYER.PLAYER,
  ) {
    this.host = host;
    this.radius = Math.max(0.05, radius);
    this.height = Math.max(this.radius * 2 + 0.02, height);
    this.layer = layer;
    this.hitLayer = layer;
    this.mask = LAYER.STATIC | LAYER.DYNAMIC | LAYER.CLIP | LAYER.GLASS
      | (layer === LAYER.PLAYER ? LAYER.ENEMY : LAYER.PLAYER | LAYER.ENEMY);
    this.shape = new RAPIER.Capsule(this.halfHeight, this.radius);

    // Parked far below the world until the first `move()` places it, so a
    // freshly created controller cannot shove props sitting at the origin.
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, -1000, 0)
      .setCcdEnabled(false)
      .setUserData({ character: true });
    this.proxyBody = host.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.capsule(this.halfHeight, this.radius)
      .setFriction(0.0)
      .setRestitution(0.0)
      .setCollisionGroups(groups(layer, defaultMask(layer)))
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    this.proxyCollider = host.world.createCollider(colDesc, this.proxyBody);

    // Default living surface is flesh (not armor plating). Once multi-zone
    // hitboxes are installed the solid capsule moves to CLIP (walk only) and
    // sensor volumes own MASK_BULLET; until then this chest proxy is hittable.
    host.registry.add({
      handle: this.proxyCollider.handle,
      bodyId: -1,
      object: null,
      surface: 'flesh',
      entityId: -1,
      zone: 'chest',
      layer,
      ranges: null,
      ragdollId: -1,
      debris: false,
    });
  }

  /** Tags every collider on this character so raycasts report the owning entity. */
  setEntity(entityId: number, object: THREE.Object3D | null = null): void {
    this.entityId = entityId;
    this.entityObject = object;
    const rec = this.host.registry.get(this.proxyCollider.handle);
    if (rec) {
      rec.entityId = entityId;
      rec.object = object;
    }
    for (const col of this.hitColliders) {
      const r = this.host.registry.get(col.handle);
      if (r) {
        r.entityId = entityId;
        r.object = object;
      }
    }
  }

  /**
   * Install multi-zone living hitboxes. Each volume is a sensor box on the
   * character's combat layer (PLAYER/ENEMY) so MASK_BULLET resolves zone +
   * surface correctly; the solid movement capsule is retargeted to CLIP so it
   * still blocks walking but never absorbs a round as a fake all-chest hit.
   */
  setHitboxes(boxes: readonly CharacterHitboxDesc[]): void {
    this.clearHitboxes();
    this.hitboxDescs = boxes.map((b) => ({
      zone: b.zone,
      half: [b.half[0], b.half[1], b.half[2]] as [number, number, number],
      offset: [b.offset[0], b.offset[1], b.offset[2]] as [number, number, number],
      surface: b.surface,
    }));
    this.hitboxRefHeight = this.height;

    // Movement capsule → CLIP: collides with walkers, invisible to bullets.
    this.proxyCollider.setCollisionGroups(groups(LAYER.CLIP, defaultMask(LAYER.CLIP)));
    const proxyRec = this.host.registry.get(this.proxyCollider.handle);
    if (proxyRec) {
      proxyRec.layer = LAYER.CLIP;
      proxyRec.surface = 'flesh';
      proxyRec.zone = 'none';
      proxyRec.entityId = this.entityId;
      proxyRec.object = this.entityObject;
    }

    const hitMask = defaultMask(this.hitLayer) | LAYER.PROJECTILE;
    for (const b of this.hitboxDescs) {
      const surface: SurfaceType = b.surface
        ?? (b.zone === 'head' ? 'helmet' : 'flesh');
      const desc = RAPIER.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
        .setTranslation(b.offset[0], b.offset[1], b.offset[2])
        .setSensor(true)
        .setFriction(0)
        .setRestitution(0)
        .setCollisionGroups(groups(this.hitLayer, hitMask))
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      const col = this.host.world.createCollider(desc, this.proxyBody);
      this.hitColliders.push(col);
      this.host.registry.add({
        handle: col.handle,
        bodyId: -1,
        object: this.entityObject,
        surface,
        entityId: this.entityId,
        zone: b.zone,
        layer: this.hitLayer,
        ranges: null,
        ragdollId: -1,
        debris: false,
      });
    }
    this.flushKinematicQueries();
  }

  private clearHitboxes(): void {
    for (const col of this.hitColliders) {
      this.host.registry.remove(col.handle);
      this.host.world.removeCollider(col, true);
    }
    this.hitColliders.length = 0;
    this.hitboxDescs.length = 0;
    this.hitboxRefHeight = 0;
  }

  /**
   * Publish freshly created kinematic colliders into the query broadphase.
   *
   * Rapier only inserts kinematicPositionBased colliders on `world.step()`.
   * Spawn-time zone probes run before the next fixed step, so without a flush
   * every living-enemy band reads as empty air. A near-zero dt step with a
   * throwaway EventQueue inserts the volumes without advancing gameplay time
   * or leaving the Physics system's event queue half-drained.
   */
  private flushKinematicQueries(): void {
    const w = this.host.world;
    const prev = w.timestep;
    // Tiny positive dt — pure 0 has left the solver in a state where AI→player
    // rays stopped dealing damage for the rest of the session.
    w.timestep = 1e-4;
    const eq = new RAPIER.EventQueue(true);
    try {
      w.step(eq);
      eq.drainCollisionEvents(() => {});
      eq.drainContactForceEvents(() => {});
    } finally {
      w.timestep = prev;
      eq.free();
    }
  }

  /**
   * Re-scale hitbox local transforms when the capsule crouches / stands.
   *
   * Both offsets *and* cuboid half-extents are scaled from the authored
   * standing descs. Leaving half-extents at stand size while compressing
   * offsets (the previous behaviour) left oversized head/chest boxes on a
   * crouched agent — crouch headshots and low shots mis-zoned.
   */
  private relayoutHitboxes(): void {
    if (this.hitColliders.length === 0 || this.hitboxRefHeight <= 1e-5) return;
    const scale = this.height / this.hitboxRefHeight;
    for (let i = 0; i < this.hitColliders.length; i++) {
      const b = this.hitboxDescs[i];
      const col = this.hitColliders[i];
      col.setTranslationWrtParent({
        x: b.offset[0] * scale,
        y: b.offset[1] * scale,
        z: b.offset[2] * scale,
      });
      col.setHalfExtents({
        x: b.half[0] * scale,
        y: b.half[1] * scale,
        z: b.half[2] * scale,
      });
    }
  }

  private get halfHeight(): number {
    return Math.max(0.01, this.height * 0.5 - this.radius);
  }

  /** Rapier collider handle of the character proxy (for hit registration). */
  get colliderHandle(): number { return this.proxyCollider.handle; }

  setHeight(h: number): void {
    const next = Math.max(this.radius * 2 + 0.02, h);
    if (Math.abs(next - this.height) < 1e-5) return;
    // Keep the feet planted when standing on the ground, the head when airborne.
    this.pendingHeightShift += this.grounded ? (next - this.height) * 0.5 : (this.height - next) * 0.5;
    this.height = next;
    this.rebuildShape();
    this.relayoutHitboxes();
  }

  /** True when the capsule at `h` metres tall would fit at `position`. */
  canSetHeight(h: number, position: THREE.Vector3): boolean {
    const next = Math.max(this.radius * 2 + 0.02, h);
    if (next <= this.height) return true;
    const half = Math.max(0.01, next * 0.5 - this.radius);
    const probe = new RAPIER.Capsule(half, this.radius * 0.98);
    rp.x = position.x;
    rp.y = position.y + (next - this.height) * (this.grounded ? 0.5 : -0.5);
    rp.z = position.z;
    const blocked = this.host.world.intersectionWithShape(
      rp, rq, probe, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, queryGroups(this.mask), this.proxyCollider,
    );
    return blocked === null;
  }

  private rebuildShape(): void {
    this.shape = new RAPIER.Capsule(this.halfHeight, this.radius);
    this.proxyCollider.setHalfHeight(this.halfHeight);
    this.proxyCollider.setRadius(this.radius);
  }

  /* ------------------------------------------------------------------ move -- */

  move(position: THREE.Vector3, motion: THREE.Vector3, dt: number, out: CharacterMoveResult): THREE.Vector3 {
    const world = this.host.world;
    if (this.disposed) { out.applied.set(0, 0, 0); return vPos.copy(position); }

    vStart.copy(position);
    vPos.copy(position);
    vMotion.copy(motion);

    this.stepped = false;
    this.stepRise = 0;
    this.wallHit = false;
    this.wallNormal.set(0, 0, 0);
    out.blocked = false;
    out.ceiling = false;
    out.grounded = false;
    out.groundNormal.set(0, 1, 0);
    out.groundSurface = 'concrete';
    out.impactSpeed = 0;
    out.platformYaw = 0;
    out.platformDelta?.set(0, 0, 0);

    // 0 — height change bookkeeping (crouch / stand keeps the feet or head fixed)
    if (this.pendingHeightShift !== 0) {
      vPos.y += this.pendingHeightShift;
      this.pendingHeightShift = 0;
    }

    // 0b — ride moving platforms.
    if (this.groundCollider >= 0) {
      vPoint.copy(vPos);
      vPoint.y -= this.height * 0.5;
      const yaw = this.host.platformDelta(this.groundCollider, vPoint, vPlatform);
      if (vPlatform.lengthSq() > 0 || yaw !== 0) {
        vPos.add(vPlatform);
        out.platformYaw = yaw;
        out.platformDelta?.copy(vPlatform);
      }
    }

    // 1 — recover from any interpenetration before we trust a sweep.
    this.depenetrate(vPos);

    // 2 — starting ground state.
    const wasGrounded = this.probeGround(vPos, groundHit);
    if (wasGrounded) {
      out.groundNormal.copy(groundHit.normal);
      out.groundSurface = this.surfaceOf(groundHit.handle);
    }

    // 3 — upward component.
    if (vMotion.y > 1e-6) {
      vDir.set(0, 1, 0);
      if (this.sweep(vPos, vDir, vMotion.y, sweepA)) {
        vPos.y += Math.max(0, sweepA.toi - SKIN);
        out.ceiling = true;
      } else {
        vPos.y += vMotion.y;
      }
    }

    // 4 — horizontal collide-and-slide. Repay any distance a previous step-up
    // borrowed, at most half a frame's worth at a time so it is never felt.
    vRemaining.set(vMotion.x, 0, vMotion.z);
    let horizontalLen = vRemaining.length();
    if (this.stepDebt > 0 && horizontalLen > 1e-5) {
      const pay = Math.min(this.stepDebt, horizontalLen * 0.5);
      this.stepDebt -= pay;
      horizontalLen -= pay;
      vRemaining.setLength(horizontalLen);
    }
    if (horizontalLen > 1e-7) {
      out.blocked = this.slideMove(vPos, vRemaining, wasGrounded, groundHit, dt);
    }

    // 5 — downward component.
    let landed = false;
    if (vMotion.y < -1e-6) {
      vDir.set(0, -1, 0);
      const want = -vMotion.y;
      if (this.sweep(vPos, vDir, want, sweepA)) {
        const travel = Math.max(0, sweepA.toi - SKIN);
        vPos.y -= travel;
        if (this.isWalkable(sweepA.normal)) {
          landed = true;
          this.grounded = true;
          this.groundCollider = sweepA.handle;
          out.grounded = true;
          out.groundNormal.copy(sweepA.normal);
          out.groundSurface = this.surfaceOf(sweepA.handle);
        } else {
          // Steep face: convert the leftover fall into a slide down the slope so
          // the player never balances on a 70° roof.
          const left = want - travel;
          if (left > 1e-5) {
            vTmp.set(0, -left, 0);
            clipVector(vTmp, sweepA.normal, vTmp);
            this.moveSwept(vPos, vTmp);
          }
        }
      } else {
        vPos.y -= want;
      }
    }

    // 5b — a step-up leaves the capsule resting on the new surface, but the
    // frame's residual gravity is far too small to close the skin gap, so the
    // sweep in phase 5 finds nothing. Take the step's own landing as ground
    // rather than reporting a phantom airborne frame once per stair tread.
    if (!landed && this.stepped) {
      landed = true;
      out.grounded = true;
      out.groundNormal.copy(this.stepNormal);
      out.groundSurface = this.surfaceOf(this.groundCollider);
    }

    // 6 — ground snap. Only when we were already grounded and are not jumping.
    if (!landed && wasGrounded && vMotion.y <= 1e-6) {
      vDir.set(0, -1, 0);
      const reach = this.snapDistance + SKIN;
      const swept = this.sweep(vPos, vDir, reach, sweepA) && this.isWalkable(sweepA.normal);
      // Same edge problem as the ground probe: fall back to a line trace so a
      // capsule hanging over a tread lip still snaps down onto it.
      if (swept || (this.rayGround(vPos, sweepA, this.snapDistance) && sweepA.toi <= this.snapDistance)) {
        vPos.y -= Math.max(0, sweepA.toi - (swept ? SKIN : 0));
        this.grounded = true;
        this.groundCollider = sweepA.handle;
        out.grounded = true;
        out.groundNormal.copy(sweepA.normal);
        out.groundSurface = this.surfaceOf(sweepA.handle);
      }
    }

    // 7 — final safety depenetration, then re-probe if we still do not know.
    // Skip the probe on a rising step: a jump must leave the ground on frame
    // one, not linger as "grounded" while the capsule is still inside the probe
    // window.
    this.depenetrate(vPos);
    if (!out.grounded && vMotion.y <= 1e-6) {
      if (this.probeGround(vPos, groundHit)) {
        out.grounded = true;
        out.groundNormal.copy(groundHit.normal);
        out.groundSurface = this.surfaceOf(groundHit.handle);
        this.groundCollider = groundHit.handle;
      } else {
        this.groundCollider = -1;
      }
    } else if (!out.grounded) {
      this.groundCollider = -1;
    }
    this.grounded = out.grounded;

    out.applied.copy(vPos).sub(vStart);
    // Speed the collision solver removed this step — landing/impact audio uses it.
    vTmp.copy(vMotion).sub(out.applied);
    if (out.platformDelta) vTmp.add(out.platformDelta);
    out.impactSpeed = dt > 0 ? vTmp.length() / dt : 0;

    // Optional extras — see `CharacterMoveResultEx`. Only written when the
    // caller allocated somewhere to put them.
    const ex = out as CharacterMoveResultEx;
    if (ex.wallNormal) {
      if (this.wallHit) ex.wallNormal.copy(this.wallNormal);
      else ex.wallNormal.set(0, 0, 0);
    }
    if (ex.stepped !== undefined) ex.stepped = this.stepped;
    if (ex.stepRise !== undefined) ex.stepRise = this.stepRise;

    // Keep the physical proxy in step so props and bullets see the character.
    rp.x = vPos.x; rp.y = vPos.y; rp.z = vPos.z;
    this.proxyBody.setNextKinematicTranslation(rp);
    void world;
    return vPos;
  }

  /* ----------------------------------------------------------- slide solver -- */

  /**
   * Quake-style multi-plane clipping with a step-up attempt. Returns true when a
   * wall actually stopped horizontal motion.
   */
  private slideMove(
    p: THREE.Vector3, remaining: THREE.Vector3, wasGrounded: boolean,
    ground: SweepHit, dt: number,
  ): boolean {
    let numPlanes = 0;
    let blocked = false;

    // Walking uphill/downhill: reproject the desired motion onto the ground so
    // speed on a ramp matches speed on the flat.
    const onGround = wasGrounded && ground.hit && this.isWalkable(ground.normal);
    if (onGround) {
      const speed = remaining.length();
      clipVector(remaining, ground.normal, remaining);
      if (remaining.lengthSq() > 1e-12) remaining.setLength(speed);
      planes[numPlanes++].copy(ground.normal);
    }

    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      const dist = remaining.length();
      if (dist < 1e-6) break;
      vDir.copy(remaining).multiplyScalar(1 / dist);

      if (!this.sweep(p, vDir, dist, sweepA)) {
        p.addScaledVector(vDir, dist);
        remaining.set(0, 0, 0);
        break;
      }

      const advance = Math.max(0, sweepA.toi - SKIN);
      if (advance > 0) {
        p.addScaledVector(vDir, advance);
        const frac = Math.min(1, advance / dist);
        remaining.multiplyScalar(1 - frac);
      }

      this.pushDynamic(sweepA, vDir, dist, dt);

      const wallish = !this.isWalkable(sweepA.normal);
      if (wallish) {
        blocked = true;
        // Step-up: only worth trying from the ground, and only against something
        // that is close to vertical (a 60° slope should slide, not teleport up).
        if ((wasGrounded || this.grounded) && Math.abs(sweepA.normal.y) < 0.6
          && this.tryStepUp(p, remaining, onGround ? ground.normal : null, sweepA.normal)) {
          continue;
        }
        // Only a plane the step-up could NOT climb is a wall. Recorded once —
        // the first blocker is the one whose normal describes the contact the
        // caller wants to react to (cancel motion into it, or bounce off it).
        if (!this.wallHit) {
          this.wallHit = true;
          this.wallNormal.copy(sweepA.normal);
        }
      }

      // On the ground, flatten wall normals into the horizontal plane. Without
      // this a slightly-tilted wall lets the slide creep upward, and the crease
      // between two walls resolves to a vertical direction that would launch
      // the character out of a corner. Flattened, the crease is exactly
      // vertical, the projection onto a horizontal `remaining` is zero, and the
      // character simply stops — which is what a corner should feel like.
      vClip.copy(sweepA.normal);
      if (onGround && !this.isWalkable(vClip)) {
        vClip.y = 0;
        if (vClip.lengthSq() < 1e-8) vClip.copy(sweepA.normal);
        else vClip.normalize();
      }

      // Register the plane, nudging duplicates so the solver cannot stall.
      let dup = false;
      for (let i = 0; i < numPlanes; i++) {
        if (planes[i].dot(vClip) > 0.99) {
          remaining.addScaledVector(vClip, 0.01);
          dup = true;
          break;
        }
      }
      if (dup) continue;
      if (numPlanes >= MAX_PLANES) { remaining.set(0, 0, 0); break; }
      planes[numPlanes++].copy(vClip);

      if (!clipAgainstPlanes(remaining, planes, numPlanes, vClip, vCrease, vTmp2)) {
        remaining.set(0, 0, 0);
        break;
      }

      // Keep grounded motion tangent to the floor, preserving horizontal speed.
      if (onGround) {
        const h = Math.hypot(remaining.x, remaining.z);
        clipVector(remaining, planes[0], remaining);
        const h2 = Math.hypot(remaining.x, remaining.z);
        if (h2 > 1e-6) remaining.multiplyScalar(h / h2);
        else remaining.set(0, 0, 0);
      }
    }
    return blocked;
  }

  /**
   * Lift → advance → drop. Accepted only when the landing is walkable and we
   * actually gained ground, which is what makes stairs feel free rather than
   * sticky.
   *
   * `groundNormal` is the surface we are currently standing on, when we are
   * standing on one. It is used to reject a step that gains no more height than
   * simply walking along that surface would have: on a ramp, a grazing shape
   * cast occasionally returns an edge-cone normal steep enough to look like a
   * wall, and the lift/advance/drop then "succeeds" by landing further up the
   * same ramp. The player is teleported 90 mm up the slope in one tick and the
   * borrowed distance is repaid over the next three at half speed — a visible
   * hitch, once every few seconds of running on a slope, from a step that was
   * never there.
   */
  private tryStepUp(
    p: THREE.Vector3, remaining: THREE.Vector3,
    groundNormal: THREE.Vector3 | null, hitNormal: THREE.Vector3,
  ): boolean {
    const dist = remaining.length();
    if (dist < 1e-5) return false;
    vStepStart.copy(p);
    vDir.copy(remaining).multiplyScalar(1 / dist);

    // Lift.
    vStepPos.copy(p);
    vTmp.set(0, 1, 0);
    const lift = this.sweep(vStepPos, vTmp, this.stepHeight + SKIN, sweepB)
      ? Math.max(0, sweepB.toi - SKIN)
      : this.stepHeight;
    if (lift < 0.02) return false;
    vStepPos.y += lift;

    // Advance far enough past the lip that the down-sweep lands on the tread
    // with a walkable normal. A capsule dropped less than
    // `radius · (1 − sin θmax)` past an edge contacts the *edge*, whose normal
    // is steeper than the slope limit, and the step-up is rejected — which is
    // why simply clamping this to the frame's motion makes stairs unclimbable.
    // The surplus is booked as debt and repaid over the following frames so the
    // average speed still matches what the caller asked for.
    //
    // The surplus is only warranted against a real convex edge. When the plane
    // that blocked us is the surface we are already standing on — see
    // `SAME_SURFACE_DOT` — there is no lip to clear, and reaching past it turns
    // a smooth ramp into a stutter: 111 mm of travel granted in one 8.3 ms tick
    // (a 15 m/s spike) and then three ticks at half speed paying it back, over
    // and over, all the way up the slope.
    const sameSurface = groundNormal !== null && hitNormal.dot(groundNormal) > SAME_SURFACE_DOT;
    const minReach = this.radius * (1 - Math.sin(THREE.MathUtils.degToRad(this.slopeLimit))) + 0.02;
    const probe = sameSurface ? dist : Math.max(dist, minReach);
    const forward = this.sweep(vStepPos, vDir, probe, sweepB)
      ? Math.min(probe, Math.max(0, sweepB.toi - SKIN))
      : probe;
    if (forward < 0.004) return false;
    vStepPos.addScaledVector(vDir, forward);

    // Drop back down onto the step.
    vTmp.set(0, -1, 0);
    if (!this.sweep(vStepPos, vTmp, lift + SKIN * 2, sweepC)) return false;
    if (!this.isWalkable(sweepC.normal)) return false;
    const drop = Math.max(0, sweepC.toi - SKIN);
    vStepPos.y -= drop;

    // Reject if we ended up lower than we started (that is a slide, not a step)
    // or if we barely moved forward.
    const rise = vStepPos.y - vStepStart.y;
    if (rise < -0.01 || rise > this.stepHeight + 0.02) return false;
    vTmp2.copy(vStepPos).sub(vStepStart);
    vTmp2.y = 0;
    const gained = vTmp2.length();
    if (gained < 0.004) return false;

    // A step-up that gains nothing vertical is not a step; let the plane clip
    // handle it so we slide along the wall instead of hopping in place.
    if (!sameSurface && rise <= STEP_MIN_GAIN) return false;

    p.copy(vStepPos);
    if (gained > dist) this.stepDebt = Math.min(0.6, this.stepDebt + (gained - dist));
    remaining.set(0, 0, 0);
    this.grounded = true;
    this.stepped = true;
    this.stepRise = Math.max(this.stepRise, rise);
    this.stepNormal.copy(sweepC.normal);
    this.groundCollider = sweepC.handle;
    return true;
  }

  /* ------------------------------------------------------------- primitives -- */

  /** Sweeps the capsule from `from` along a unit `dir` for `dist` metres. */
  private sweep(from: THREE.Vector3, dir: THREE.Vector3, dist: number, out: SweepHit): boolean {
    out.hit = false;
    out.toi = dist;
    out.handle = -1;
    if (dist <= 1e-7) return false;
    rp.x = from.x; rp.y = from.y; rp.z = from.z;
    rv.x = dir.x; rv.y = dir.y; rv.z = dir.z;
    const hit = this.host.world.castShape(
      rp, rq, rv, this.shape, 0, dist, false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, queryGroups(this.mask), this.proxyCollider,
    );
    if (!hit) return false;
    out.hit = true;
    out.toi = hit.time_of_impact;
    out.handle = hit.collider.handle;
    out.normal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
    const len = out.normal.length();
    if (len < 1e-6) out.normal.set(-dir.x, -dir.y, -dir.z);
    else {
      out.normal.multiplyScalar(1 / len);
      // Rapier's witness-normal convention flips with shape order; force the
      // normal to oppose the sweep so every consumer sees the same thing.
      if (out.normal.dot(dir) > 0) out.normal.negate();
    }
    return true;
  }

  /** Applies a swept translation, clipping against the first blocker. */
  private moveSwept(p: THREE.Vector3, delta: THREE.Vector3): void {
    const dist = delta.length();
    if (dist < 1e-7) return;
    vTmp2.copy(delta).multiplyScalar(1 / dist);
    if (this.sweep(p, vTmp2, dist, sweepB)) p.addScaledVector(vTmp2, Math.max(0, sweepB.toi - SKIN));
    else p.add(delta);
  }

  /** Pushes overlapping geometry away until the capsule is clear. */
  private depenetrate(p: THREE.Vector3): void {
    const world = this.host.world;
    for (let iter = 0; iter < DEPEN_ITERS; iter++) {
      rp.x = p.x; rp.y = p.y; rp.z = p.z;
      let moved = false;
      world.intersectionsWithShape(rp, rq, this.shape, (collider) => {
        if (collider.handle === this.proxyCollider.handle) return true;
        if (collider.isSensor()) return true;
        const contact = collider.contactShape(this.shape, rp, rq, DEPEN_PREDICTION);
        if (!contact || contact.distance >= 0) return true;
        const n = contact.normal1;
        const push = -contact.distance + SKIN * 0.5;
        vTmp.set(n.x, n.y, n.z);
        const l = vTmp.length();
        if (l < 1e-6) return true;
        vTmp.multiplyScalar(push / l);
        p.add(vTmp);
        rp.x = p.x; rp.y = p.y; rp.z = p.z;
        moved = true;
        return true;
      }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, queryGroups(this.mask), this.proxyCollider);
      if (!moved) break;
    }
  }

  /** Short downward cast used to classify the ground under the feet. */
  private probeGround(p: THREE.Vector3, out: SweepHit): boolean {
    vTmp.set(0, -1, 0);
    if (this.sweep(p, vTmp, GROUND_PROBE, out)
      && out.toi <= GROUND_EPS && this.isWalkable(out.normal)) {
      return true;
    }
    // The capsule's shoulder can catch the convex edge of a stair tread, whose
    // normal is far steeper than the slope limit even though the character is
    // standing on something perfectly flat. A centre line-trace ignores the
    // edge — without this, walking a staircase flickers "airborne" once per
    // tread and every consumer of `grounded` (footsteps, jump gating, camera
    // bob) stutters with it.
    return this.rayGround(p, out, GROUND_EPS);
  }

  /** Line trace straight down from the capsule centre; edge-immune. */
  private rayGround(p: THREE.Vector3, out: SweepHit, extra: number): boolean {
    ray.origin.x = p.x; ray.origin.y = p.y; ray.origin.z = p.z;
    ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const reach = this.height * 0.5 + extra;
    const hit = this.host.world.castRayAndGetNormal(
      ray, reach, false, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, queryGroups(this.mask), this.proxyCollider,
    );
    if (!hit) return false;
    vTmp2.set(hit.normal.x, hit.normal.y, hit.normal.z);
    const len = vTmp2.length();
    if (len < 1e-6) return false;
    vTmp2.multiplyScalar(1 / len);
    if (vTmp2.y < 0) vTmp2.negate();
    if (!this.isWalkable(vTmp2)) return false;
    out.hit = true;
    out.toi = Math.max(0, hit.timeOfImpact - this.height * 0.5);
    out.normal.copy(vTmp2);
    out.handle = hit.collider.handle;
    return true;
  }

  private isWalkable(n: THREE.Vector3): boolean {
    return n.y >= Math.cos(THREE.MathUtils.degToRad(this.slopeLimit));
  }

  private surfaceOf(handle: number): SurfaceType {
    if (handle < 0) return 'concrete';
    return this.host.registry.resolve(handle).surface;
  }

  /** Shoves dynamic props the character walks into, scaled by relative speed. */
  private pushDynamic(hit: SweepHit, dir: THREE.Vector3, dist: number, dt: number): void {
    if (this.pushForce <= 0 || hit.handle < 0 || dt <= 0) return;
    const collider = this.host.world.colliders.get(hit.handle);
    const body = collider?.parent();
    if (!body || !body.isDynamic()) return;
    const speed = dist / dt;
    const mass = Math.max(0.1, body.mass());
    const impulse = Math.min(CHARACTER_MASS, mass * 6) * speed * 0.06 * this.pushForce;
    vImpulse.copy(dir).multiplyScalar(impulse);
    vImpulse.y *= 0.25;
    rv.x = vImpulse.x; rv.y = vImpulse.y; rv.z = vImpulse.z;
    body.applyImpulse(rv, true);
  }

  /* ------------------------------------------------------------------ misc -- */

  /**
   * Representative hit zone for this character.
   *
   * When multi-zone volumes are installed the individual colliders carry their
   * own zone on every ray hit; this getter exposes a non-anonymous band from
   * the layout so callers that only know the controller can observe that
   * multi-zone is live (rather than always reading the legacy single-chest
   * capsule default).
   */
  get zone(): HitZone {
    if (this.hitboxDescs.length === 0) return 'chest';
    for (const b of this.hitboxDescs) {
      if (b.zone === 'head') return 'head';
    }
    for (const b of this.hitboxDescs) {
      if (b.zone !== 'none' && b.zone !== 'chest') return b.zone;
    }
    return this.hitboxDescs[0]?.zone ?? 'chest';
  }

  teleport(position: THREE.Vector3): void {
    rp.x = position.x; rp.y = position.y; rp.z = position.z;
    this.proxyBody.setTranslation(rp, true);
    this.proxyBody.setNextKinematicTranslation(rp);
    this.groundCollider = -1;
    this.grounded = false;
    this.stepDebt = 0;
    this.pendingHeightShift = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHitboxes();
    this.host.registry.remove(this.proxyCollider.handle);
    this.host.world.removeRigidBody(this.proxyBody);
  }
}

/* --------------------------------------------------------------- plane maths */

/** v -= n * dot(v, n) — removes the component pushing into the plane. */
function clipVector(v: THREE.Vector3, n: THREE.Vector3, out: THREE.Vector3): void {
  const d = v.dot(n);
  out.set(v.x - n.x * d, v.y - n.y * d, v.z - n.z * d);
}

/**
 * Clips `remaining` so it satisfies every registered plane. Handles the
 * two-plane crease case by sliding along the intersection line, and gives up
 * (returns false) when three planes box the motion in — the classic
 * "wedged in a corner" resolution that avoids both sticking and tunnelling.
 */
function clipAgainstPlanes(
  remaining: THREE.Vector3, planeList: THREE.Vector3[], count: number,
  clipped: THREE.Vector3, crease: THREE.Vector3, tmp: THREE.Vector3,
): boolean {
  for (let i = 0; i < count; i++) {
    if (remaining.dot(planeList[i]) >= -1e-6) continue;
    clipVector(remaining, planeList[i], clipped);

    let ok = true;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      if (clipped.dot(planeList[j]) >= -1e-6) continue;
      // Two planes: travel along their crease.
      crease.copy(planeList[i]).cross(planeList[j]);
      const l = crease.length();
      if (l < 1e-6) { ok = false; break; }
      crease.multiplyScalar(1 / l);
      crease.multiplyScalar(crease.dot(remaining));
      clipped.copy(crease);

      for (let k = 0; k < count; k++) {
        if (k === i || k === j) continue;
        if (clipped.dot(planeList[k]) < -1e-6) { ok = false; break; }
      }
      break;
    }
    if (!ok) return false;
    tmp.copy(clipped);
    remaining.copy(tmp);
    return true;
  }
  return true;
}
