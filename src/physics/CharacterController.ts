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
import type { CharacterController, CharacterMoveResult, HitZone } from './types';
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

  /** Ground state carried between moves for snapping and platform riding. */
  private groundCollider = -1;
  private grounded = false;
  private pendingHeightShift = 0;
  /** Horizontal distance a step-up advanced beyond the frame's motion budget. */
  private stepDebt = 0;
  /** True when this move's slide phase resolved by stepping onto something. */
  private stepped = false;
  private stepNormal = new THREE.Vector3(0, 1, 0);

  constructor(
    private host: ControllerHost,
    radius: number,
    height: number,
    layer: number = LAYER.PLAYER,
  ) {
    this.radius = Math.max(0.05, radius);
    this.height = Math.max(this.radius * 2 + 0.02, height);
    this.layer = layer;
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

    // Register the proxy so bullets fired at the character resolve properly.
    host.registry.add({
      handle: this.proxyCollider.handle,
      bodyId: -1,
      object: null,
      surface: 'armor',
      entityId: -1,
      zone: 'chest',
      layer,
      ranges: null,
      ragdollId: -1,
      debris: false,
    });
  }

  /** Tags the character proxy so raycasts report the owning entity. */
  setEntity(entityId: number, object: THREE.Object3D | null = null): void {
    const rec = this.host.registry.get(this.proxyCollider.handle);
    if (!rec) return;
    rec.entityId = entityId;
    rec.object = object;
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
      rp, rq, probe, undefined, queryGroups(this.mask), this.proxyCollider,
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
          && this.tryStepUp(p, remaining)) {
          continue;
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
   */
  private tryStepUp(p: THREE.Vector3, remaining: THREE.Vector3): boolean {
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
    const minReach = this.radius * (1 - Math.sin(THREE.MathUtils.degToRad(this.slopeLimit))) + 0.02;
    const probe = Math.max(dist, minReach);
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

    p.copy(vStepPos);
    if (gained > dist) this.stepDebt = Math.min(0.6, this.stepDebt + (gained - dist));
    remaining.set(0, 0, 0);
    this.grounded = true;
    this.stepped = true;
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
      undefined, queryGroups(this.mask), this.proxyCollider,
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
      }, undefined, queryGroups(this.mask), this.proxyCollider);
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
      ray, reach, false, undefined, queryGroups(this.mask), this.proxyCollider,
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

  /** Hit zone reported when this character's proxy is shot. Always torso. */
  get zone(): HitZone { return 'chest'; }

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
