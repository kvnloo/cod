/**
 * Movement state machine and locomotion physics.
 *
 * Tuned to modern-military-shooter feel rather than a physics simulation: high
 * ground acceleration so direction changes are instant, a small amount of air
 * control, momentum-preserving slides, and automatic mantling. Every constant
 * here is a design value — they are collected at the top so the feel can be
 * tuned in one place.
 */

import * as THREE from 'three';
import { input } from '../core/Input';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { readSurface, type SurfaceType } from '../core/Surfaces';
import { MASK_MOVE, type CharacterController, type CharacterMoveResult, type PhysicsAPI, type RayHit } from '../physics/types';

export type MoveState =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'tacSprint'
  | 'crouchIdle' | 'crouchWalk' | 'prone' | 'proneCrawl'
  | 'slide' | 'air' | 'mantle';

export const TUNING: Record<string, number> & {
  standHeight: number; crouchHeight: number; proneHeight: number;
  standEye: number; crouchEye: number; proneEye: number;
} = {
  /** Ground speeds, metres/second. */
  walkSpeed: 2.6,
  runSpeed: 4.55,
  sprintSpeed: 6.4,
  tacSprintSpeed: 7.9,
  crouchSpeed: 2.05,
  proneSpeed: 0.95,
  /** Strafe and backpedal penalties. */
  strafeScale: 0.87,
  backScale: 0.78,

  groundAccel: 62,
  groundFriction: 14,
  airAccel: 11,
  airControl: 0.42,
  gravity: 20.5,
  jumpVelocity: 5.55,
  /** Grace window after leaving a ledge during which a jump still registers. */
  coyoteTime: 0.11,
  jumpBufferTime: 0.13,

  /** Slide. */
  slideEntrySpeed: 5.2,
  slideBoost: 2.1,
  slideFriction: 3.4,
  slideMinSpeed: 2.5,
  slideMaxTime: 1.15,
  slideSteer: 2.4,
  slideCooldown: 0.55,

  /** Stances — capsule heights and eye offsets. */
  standHeight: 1.80,
  crouchHeight: 1.18,
  proneHeight: 0.55,
  standEye: 1.62,
  crouchEye: 1.02,
  proneEye: 0.34,
  stanceBlendSpeed: 11,

  /** Mantle / vault. */
  mantleMaxHeight: 1.95,
  mantleMinHeight: 0.42,
  mantleReach: 0.95,
  mantleDurationLow: 0.36,
  mantleDurationHigh: 0.62,

  /** Lean. */
  leanAngle: 0.30,
  leanOffset: 0.42,
  leanSpeed: 9,

  /** Sprint entry/exit. */
  sprintRampTime: 0.22,
  tacSprintDelay: 0.9,
  sprintMinForward: 0.55,

  /** Footsteps. */
  stepDistanceWalk: 1.72,
  stepDistanceRun: 2.05,
  stepDistanceSprint: 2.35,
};

export interface MovementOutput {
  state: MoveState;
  /** Eye height above the capsule centre for the camera rig. */
  eyeOffset: number;
  /** Lean amount, -1..1. */
  lean: number;
  /** 0..1 normalised horizontal speed for animation/bob. */
  speed01: number;
  /** Continuous step phase in [0,1) driving footstep timing and bob. */
  stepPhase: number;
  grounded: boolean;
  groundSurface: SurfaceType;
  /** Speed at the moment of landing this frame, else 0. */
  landImpact: number;
  /** True on the frame a mantle starts. */
  mantleStarted: boolean;
}

function moveResult(): CharacterMoveResult {
  return {
    applied: new THREE.Vector3(), grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0), groundSurface: 'concrete',
    blocked: false, ceiling: false, impactSpeed: 0,
  };
}

function rayHit(): RayHit {
  return {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity, surface: 'concrete', object: null, entityId: -1,
    bodyHandle: -1, zone: 'none', backface: false,
  };
}

export class Movement {
  readonly position = new THREE.Vector3(0, TUNING.standHeight * 0.5, 0);
  readonly velocity = new THREE.Vector3();
  state: MoveState = 'idle';
  yaw = 0;

  private controller: CharacterController | null = null;
  private physics: PhysicsAPI | null = null;
  private result = moveResult();
  private hit = rayHit();
  private hit2 = rayHit();

  /* stance */
  private targetHeight = TUNING.standHeight;
  private currentHeight = TUNING.standHeight;
  private eye = TUNING.standEye;
  private crouchHeld = false;
  private proneHeld = false;

  /* timers */
  private groundedTime = 0;
  private airTime = 0;
  private jumpBuffer = 0;
  private slideTime = 0;
  private slideCooldown = 0;
  private sprintTime = 0;
  private lean = 0;
  private stepAccum = 0;
  private stepPhase = 0;

  /* mantle */
  private mantleT = 0;
  private mantleDuration = 0;
  private readonly mantleStart = new THREE.Vector3();
  private readonly mantleEnd = new THREE.Vector3();
  private readonly mantleMid = new THREE.Vector3();

  /* scratch — never allocate in fixedUpdate */
  private readonly _forward = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _wish = new THREE.Vector3();
  private readonly _motion = new THREE.Vector3();
  private readonly _tmp = new THREE.Vector3();
  private readonly _origin = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();

  readonly out: MovementOutput = {
    state: 'idle', eyeOffset: TUNING.standEye - TUNING.standHeight * 0.5, lean: 0,
    speed01: 0, stepPhase: 0, grounded: true, groundSurface: 'concrete',
    landImpact: 0, mantleStarted: false,
  };

  attach(physics: PhysicsAPI): void {
    this.physics = physics;
    this.controller = physics.createCharacter(0.34, TUNING.standHeight);
  }

  teleport(p: THREE.Vector3, yaw: number): void {
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.state = 'idle';
    this.mantleT = 0;
  }

  get height(): number { return this.currentHeight; }
  get grounded(): boolean { return this.out.grounded; }

  step(dt: number, yaw: number): MovementOutput {
    this.yaw = yaw;
    this.out.landImpact = 0;
    this.out.mantleStarted = false;

    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (input.pressed('jump')) this.jumpBuffer = TUNING.jumpBufferTime;

    if (this.state === 'mantle') { this.stepMantle(dt); return this.out; }

    this.updateStance(dt);
    this.updateLean(dt);

    const wasGrounded = this.out.grounded;
    const grounded = this.out.grounded;

    // ---- desired direction in world space -------------------------------
    const s = input.state;
    this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this._wish.set(0, 0, 0)
      .addScaledVector(this._forward, s.moveY)
      .addScaledVector(this._right, s.moveX);
    const wishLen = this._wish.length();
    if (wishLen > 1) this._wish.multiplyScalar(1 / wishLen);
    const wishing = wishLen > 0.06;

    // ---- stance / sprint / slide decisions ------------------------------
    const forwardIntent = s.moveY;
    const wantsSprint = (input.held('sprint') || settings.game.autoSprint)
      && forwardIntent > TUNING.sprintMinForward && grounded && !this.proneHeld;

    if (wantsSprint) this.sprintTime += dt; else this.sprintTime = 0;

    if (this.state === 'slide') {
      this.stepSlide(dt);
    } else if (
      this.crouchHeld && grounded && this.slideCooldown <= 0
      && this.horizontalSpeed() >= TUNING.slideEntrySpeed
      && (this.sprintTime > 0 || this.state === 'sprint' || this.state === 'tacSprint')
    ) {
      this.enterSlide();
    }

    // ---- acceleration ----------------------------------------------------
    const maxSpeed = this.targetSpeed(s, wantsSprint);
    if (this.state !== 'slide') {
      if (grounded) this.accelerateGround(this._wish, maxSpeed, dt, wishing);
      else this.accelerateAir(this._wish, maxSpeed, dt);
    }

    // ---- jump ------------------------------------------------------------
    const canJump = (grounded || this.groundedTime < TUNING.coyoteTime)
      && this.state !== 'prone' && this.jumpBuffer > 0 && this.canStand();
    if (canJump) {
      if (this.state === 'slide') this.exitSlide();
      this.velocity.y = TUNING.jumpVelocity;
      this.jumpBuffer = 0;
      this.groundedTime = 999;
      this.out.grounded = false;
    }

    this.velocity.y -= TUNING.gravity * dt;
    if (this.velocity.y < -55) this.velocity.y = -55;

    // ---- mantle detection -------------------------------------------------
    if (!grounded || this.velocity.y > 0.5) {
      if (wishing && this.tryMantle()) return this.out;
    }

    // ---- integrate --------------------------------------------------------
    this._motion.copy(this.velocity).multiplyScalar(dt);
    if (this.controller) {
      const next = this.controller.move(this.position, this._motion, dt, this.result);
      this.position.copy(next);
      this.out.grounded = this.result.grounded;
      this.out.groundSurface = this.result.groundSurface;
      if (this.result.grounded && this.velocity.y < 0) {
        if (!wasGrounded) this.out.landImpact = -this.velocity.y;
        this.velocity.y = 0;
      }
      if (this.result.ceiling && this.velocity.y > 0) this.velocity.y = 0;
      if (this.result.blocked) {
        // Kill the component of velocity into the wall so we do not build up
        // pressure and pop out when the wall ends.
        const applied = this.result.applied;
        if (applied.lengthSq() > 1e-8) {
          this._tmp.copy(applied).normalize();
          const along = this.velocity.dot(this._tmp);
          this.velocity.copy(this._tmp).multiplyScalar(Math.max(0, along));
        }
      }
    } else {
      this.position.add(this._motion);
      this.out.grounded = this.position.y <= this.currentHeight * 0.5;
      if (this.out.grounded) {
        this.position.y = this.currentHeight * 0.5;
        if (!wasGrounded) this.out.landImpact = -this.velocity.y;
        this.velocity.y = 0;
      }
    }

    if (this.out.grounded) { this.groundedTime = 0; this.airTime = 0; }
    else { this.groundedTime += dt; this.airTime += dt; }

    // ---- footsteps --------------------------------------------------------
    this.updateFootsteps(dt);

    // ---- resolve the reported state --------------------------------------
    const hs = this.horizontalSpeed();
    if (this.state !== 'slide') {
      if (!this.out.grounded) this.state = 'air';
      else if (this.proneHeld) this.state = hs > 0.15 ? 'proneCrawl' : 'prone';
      else if (this.crouchHeld) this.state = hs > 0.15 ? 'crouchWalk' : 'crouchIdle';
      else if (hs < 0.15) this.state = 'idle';
      else if (wantsSprint && hs > TUNING.runSpeed * 0.92) {
        this.state = this.sprintTime > TUNING.tacSprintDelay ? 'tacSprint' : 'sprint';
      } else if (hs > TUNING.walkSpeed * 1.15) this.state = 'run';
      else this.state = 'walk';
    }

    this.out.state = this.state;
    this.out.speed01 = Math.min(1, hs / TUNING.tacSprintSpeed);
    this.out.stepPhase = this.stepPhase;
    this.out.eyeOffset = this.eye - this.currentHeight * 0.5;
    this.out.lean = this.lean;
    return this.out;
  }

  /* ------------------------------------------------------------- internals */

  private horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  private targetSpeed(s: { moveX: number; moveY: number }, sprinting: boolean): number {
    let base: number;
    if (this.proneHeld) base = TUNING.proneSpeed;
    else if (this.crouchHeld) base = TUNING.crouchSpeed;
    else if (sprinting) {
      base = this.sprintTime > TUNING.tacSprintDelay ? TUNING.tacSprintSpeed : TUNING.sprintSpeed;
    } else if (input.held('ads')) base = TUNING.walkSpeed;
    else base = TUNING.runSpeed;

    // Directional penalties: you are slower sideways and slowest backwards.
    if (s.moveY < -0.1) base *= TUNING.backScale;
    else if (Math.abs(s.moveX) > Math.abs(s.moveY)) base *= TUNING.strafeScale;
    return base;
  }

  private accelerateGround(wish: THREE.Vector3, maxSpeed: number, dt: number, wishing: boolean): void {
    // Friction first, applied to the horizontal plane only.
    const speed = this.horizontalSpeed();
    if (speed > 0.0001) {
      const drop = Math.max(speed, 2.0) * TUNING.groundFriction * dt * (wishing ? 0.55 : 1);
      const scale = Math.max(0, speed - drop) / speed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }
    if (!wishing) return;

    // Quake-style projected acceleration: preserves speed when strafing, which is
    // what makes direction changes feel crisp rather than mushy.
    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = maxSpeed - current;
    if (add <= 0) return;
    const accel = Math.min(TUNING.groundAccel * maxSpeed * dt, add);
    this.velocity.x += wish.x * accel;
    this.velocity.z += wish.z * accel;
  }

  private accelerateAir(wish: THREE.Vector3, maxSpeed: number, dt: number): void {
    const target = maxSpeed * TUNING.airControl;
    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = target - current;
    if (add <= 0) return;
    const accel = Math.min(TUNING.airAccel * maxSpeed * dt, add);
    this.velocity.x += wish.x * accel;
    this.velocity.z += wish.z * accel;
  }

  private updateStance(dt: number): void {
    const g = settings.game;
    if (g.toggleCrouch) {
      if (input.pressed('crouch')) this.crouchHeld = !this.crouchHeld;
    } else {
      this.crouchHeld = input.held('crouch');
    }
    if (input.pressed('prone')) this.proneHeld = !this.proneHeld;
    if (this.proneHeld) this.crouchHeld = false;

    let want = TUNING.standHeight;
    let wantEye = TUNING.standEye;
    if (this.state === 'slide') { want = TUNING.crouchHeight; wantEye = TUNING.crouchEye - 0.08; }
    else if (this.proneHeld) { want = TUNING.proneHeight; wantEye = TUNING.proneEye; }
    else if (this.crouchHeld) { want = TUNING.crouchHeight; wantEye = TUNING.crouchEye; }

    // Refuse to stand up under a low ceiling.
    if (want > this.currentHeight && !this.canStand(want)) {
      want = this.currentHeight;
      wantEye = this.eye;
    }

    this.targetHeight = want;
    const k = 1 - Math.exp(-TUNING.stanceBlendSpeed * dt);
    const prevHeight = this.currentHeight;
    this.currentHeight += (want - this.currentHeight) * k;
    this.eye += (wantEye - this.eye) * k;
    // Keep the feet planted while the capsule shrinks/grows.
    this.position.y += (this.currentHeight - prevHeight) * 0.5;
    this.controller?.setHeight(this.currentHeight);
  }

  private canStand(target = TUNING.standHeight): boolean {
    if (!this.physics) return true;
    const need = target - this.currentHeight;
    if (need <= 0) return true;
    this._origin.copy(this.position);
    this._dir.set(0, 1, 0);
    this.physics.raycast(this._origin, this._dir, this.currentHeight * 0.5 + need + 0.06, MASK_MOVE, this.hit);
    return !this.hit.hit;
  }

  private updateLean(dt: number): void {
    const want = (input.held('leanRight') ? 1 : 0) - (input.held('leanLeft') ? 1 : 0);
    const k = 1 - Math.exp(-TUNING.leanSpeed * dt);
    this.lean += (want - this.lean) * k;
    if (Math.abs(this.lean) < 0.001) this.lean = 0;
  }

  private enterSlide(): void {
    this.state = 'slide';
    this.slideTime = 0;
    const speed = this.horizontalSpeed();
    if (speed > 0.001) {
      const boost = (speed + TUNING.slideBoost) / speed;
      this.velocity.x *= boost;
      this.velocity.z *= boost;
    }
    bus.emit('player:slide', { start: true });
  }

  private exitSlide(): void {
    this.state = this.crouchHeld ? 'crouchIdle' : 'idle';
    this.slideCooldown = TUNING.slideCooldown;
    bus.emit('player:slide', { start: false });
  }

  private stepSlide(dt: number): void {
    this.slideTime += dt;
    const speed = this.horizontalSpeed();

    // Steering: rotate the velocity toward the look direction rather than
    // accelerating, so the slide keeps its momentum.
    const s = input.state;
    if (Math.abs(s.moveX) > 0.05 && speed > 0.1) {
      const angle = -s.moveX * TUNING.slideSteer * dt;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const vx = this.velocity.x, vz = this.velocity.z;
      this.velocity.x = vx * cos - vz * sin;
      this.velocity.z = vx * sin + vz * cos;
    }

    const drop = TUNING.slideFriction * dt * Math.max(1, speed * 0.35);
    const scale = speed > 0 ? Math.max(0, speed - drop) / speed : 0;
    this.velocity.x *= scale;
    this.velocity.z *= scale;

    if (this.slideTime > TUNING.slideMaxTime
      || this.horizontalSpeed() < TUNING.slideMinSpeed
      || !this.out.grounded
      || (!this.crouchHeld && this.canStand())) {
      this.exitSlide();
    }
  }

  /** Looks for a ledge in front at a mantle-able height and starts the climb. */
  private tryMantle(): boolean {
    if (!this.physics) return false;
    const feet = this.position.y - this.currentHeight * 0.5;

    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // 1. Is there a wall in front at chest height?
    this._origin.set(this.position.x, feet + 0.9, this.position.z);
    this.physics.raycast(this._origin, this._forward, TUNING.mantleReach, MASK_MOVE, this.hit);
    if (!this.hit.hit) return false;
    // Only mantle roughly-vertical faces.
    if (Math.abs(this.hit.normal.y) > 0.45) return false;

    // 2. Probe downward just past the wall to find the ledge top.
    this._tmp.copy(this.hit.point).addScaledVector(this._forward, 0.42);
    this._tmp.y = feet + TUNING.mantleMaxHeight + 0.3;
    this._dir.set(0, -1, 0);
    this.physics.raycast(this._tmp, this._dir, TUNING.mantleMaxHeight + 0.5, MASK_MOVE, this.hit2);
    if (!this.hit2.hit) return false;

    const ledgeHeight = this.hit2.point.y - feet;
    if (ledgeHeight < TUNING.mantleMinHeight || ledgeHeight > TUNING.mantleMaxHeight) return false;
    if (this.hit2.normal.y < 0.6) return false; // not a walkable top

    // 3. Headroom check above the landing spot.
    this._origin.copy(this.hit2.point).addScaledVector(this._forward, 0.05);
    this._origin.y += 0.08;
    this._dir.set(0, 1, 0);
    this.physics.raycast(this._origin, this._dir, TUNING.standHeight * 0.9, MASK_MOVE, this.hit);
    if (this.hit.hit) return false;

    const high = ledgeHeight > 1.0;
    this.mantleStart.copy(this.position);
    this.mantleEnd.copy(this.hit2.point).addScaledVector(this._forward, 0.34);
    this.mantleEnd.y += this.currentHeight * 0.5 + 0.02;
    // Arc through a point above the ledge lip so the body clears the edge.
    this.mantleMid.copy(this.mantleStart);
    this.mantleMid.y = this.mantleEnd.y + (high ? 0.18 : 0.06);

    this.mantleT = 0;
    this.mantleDuration = high ? TUNING.mantleDurationHigh : TUNING.mantleDurationLow;
    this.state = 'mantle';
    this.velocity.set(0, 0, 0);
    this.out.mantleStarted = true;
    bus.emit('player:mantle', undefined);
    return true;
  }

  private stepMantle(dt: number): void {
    this.mantleT += dt / this.mantleDuration;
    const t = Math.min(1, this.mantleT);
    // Quadratic Bezier: up first, then forward — reads as a pull-up, not a float.
    const it = 1 - t;
    this.position.set(
      it * it * this.mantleStart.x + 2 * it * t * this.mantleMid.x + t * t * this.mantleEnd.x,
      it * it * this.mantleStart.y + 2 * it * t * this.mantleMid.y + t * t * this.mantleEnd.y,
      it * it * this.mantleStart.z + 2 * it * t * this.mantleMid.z + t * t * this.mantleEnd.z,
    );
    this.out.grounded = false;
    this.out.state = this.state = 'mantle';
    this.out.speed01 = 0.4;
    this.out.eyeOffset = this.eye - this.currentHeight * 0.5;

    if (t >= 1) {
      this.state = 'idle';
      this.out.grounded = true;
      // Carry a little forward momentum out of the mantle.
      this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).multiplyScalar(1.6);
      this.velocity.set(this._forward.x, 0, this._forward.z);
    }
  }

  private updateFootsteps(dt: number): void {
    const hs = this.horizontalSpeed();
    if (!this.out.grounded || hs < 0.4 || this.state === 'slide') {
      // Drift the phase back to the neutral pose so the bob settles.
      this.stepPhase += dt * 0.4;
      if (this.stepPhase >= 1) this.stepPhase -= 1;
      return;
    }
    const stride = this.state === 'sprint' || this.state === 'tacSprint'
      ? TUNING.stepDistanceSprint
      : hs > TUNING.walkSpeed * 1.2 ? TUNING.stepDistanceRun : TUNING.stepDistanceWalk;

    const prev = this.stepPhase;
    this.stepPhase += (hs * dt) / stride;
    this.stepAccum += hs * dt;
    // Two footfalls per stride, at phase 0 and 0.5.
    const crossed = Math.floor(this.stepPhase * 2) !== Math.floor(prev * 2);
    if (this.stepPhase >= 1) this.stepPhase -= 1;
    if (crossed) {
      bus.emit('player:footstep', {
        point: this.position.clone(),
        surface: this.out.groundSurface,
        sprinting: this.state === 'sprint' || this.state === 'tacSprint',
      });
    }
  }

  /** Reads the surface under the feet for footstep audio when the controller
   *  does not report one. */
  probeGroundSurface(): SurfaceType {
    if (!this.physics) return 'concrete';
    this._origin.copy(this.position);
    this._dir.set(0, -1, 0);
    this.physics.raycast(this._origin, this._dir, this.currentHeight * 0.5 + 0.35, MASK_MOVE, this.hit);
    return this.hit.hit ? (readSurface(this.hit.object) ?? this.hit.surface) : 'concrete';
  }

  dispose(): void { this.controller?.dispose(); }
}
