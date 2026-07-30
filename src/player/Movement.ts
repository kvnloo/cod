/**
 * Movement state machine and locomotion physics.
 *
 * Tuned to modern-military-shooter feel rather than a physics simulation: high
 * ground acceleration so direction changes are instant, a small amount of air
 * control, momentum-preserving slides, and automatic mantling. Every constant
 * here is a design value — they are collected at the top so the feel can be
 * tuned in one place.
 *
 * ## One step function, three drivers
 *
 * `stepCommand(cmd)` is the *only* place movement is integrated. It is driven by
 *   1. the local client, predicting its own freshly-sampled input;
 *   2. the local client again, replaying unacked input after a correction;
 *   3. the host, executing the commands a client sent it.
 *
 * There is deliberately no second copy of this logic for the server. Two copies
 * drift, and drift is desync. Everything the step reads is either a `TUNING`
 * constant, a field of the command, or a field of `MovementState` — never the
 * global input singleton and never a user setting, both of which differ between
 * the machine that predicted a step and the machine that authorises it.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { readSurface, type SurfaceType } from '../core/Surfaces';
import { MASK_MOVE, type CharacterController, type CharacterMoveResult, type PhysicsAPI, type RayHit } from '../physics/types';
import { BTN, type MoveCommand } from './MoveCommand';
import { copyMovementState, createMovementState, type MovementState } from './MovementState';
import { CommandBuilder } from './CommandBuilder';

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

  /**
   * Gameplay events (footsteps, slide, mantle) are muted while a reconciliation
   * replay is re-running already-heard steps, and on host-side simulations of
   * remote players whose sounds are the host's to broadcast, not to play.
   */
  emitEvents = true;

  private controller: CharacterController | null = null;
  private physics: PhysicsAPI | null = null;
  private result = moveResult();
  private hit = rayHit();
  private hit2 = rayHit();
  /** Buttons of the previous command — press edges are derived, not sent. */
  private prevButtons = 0;
  private legacyCommands: CommandBuilder | null = null;

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
    this.prevButtons = 0;
    this.jumpBuffer = 0;
    this.slideTime = 0;
    this.slideCooldown = 0;
    this.sprintTime = 0;
    this.controller?.teleport?.(p);
  }

  get height(): number { return this.currentHeight; }
  get grounded(): boolean { return this.out.grounded; }

  /**
   * Single-player / legacy entry point: samples the global input singleton into
   * a command and runs the one and only step. Kept so callers that do not care
   * about networking never have to build a command themselves — it is a thin
   * wrapper, not a second implementation.
   */
  step(dt: number, yaw: number, pitch = 0): MovementOutput {
    this.legacyCommands ??= new CommandBuilder();
    return this.stepCommand(this.legacyCommands.build(dt, yaw, pitch));
  }

  /**
   * Advances the simulation by exactly one command. Deterministic given the
   * command, this object's state and the collision world.
   */
  stepCommand(cmd: MoveCommand): MovementOutput {
    const dt = cmd.dt;
    const yaw = cmd.yaw;
    const buttons = cmd.buttons;
    const prev = this.prevButtons;
    this.prevButtons = buttons;

    this.yaw = yaw;
    this.out.landImpact = 0;
    this.out.mantleStarted = false;

    const jumpPressed = (buttons & BTN.JUMP) !== 0 && (prev & BTN.JUMP) === 0;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (jumpPressed) this.jumpBuffer = TUNING.jumpBufferTime;

    if (this.state === 'mantle') { this.stepMantle(dt); return this.out; }

    const wantCrouch = (buttons & BTN.CROUCH) !== 0;
    const wantProne = (buttons & BTN.PRONE) !== 0;
    const adsHeld = (buttons & BTN.ADS) !== 0;
    const leanIntent = ((buttons & BTN.LEAN_R) !== 0 ? 1 : 0) - ((buttons & BTN.LEAN_L) !== 0 ? 1 : 0);

    this.updateStance(dt, wantCrouch, wantProne);
    this.updateLean(dt, leanIntent);

    const wasGrounded = this.out.grounded;
    const grounded = this.out.grounded;

    // ---- desired direction in world space -------------------------------
    const moveX = cmd.moveX;
    const moveY = cmd.moveY;
    this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this._wish.set(0, 0, 0)
      .addScaledVector(this._forward, moveY)
      .addScaledVector(this._right, moveX);
    const wishLen = this._wish.length();
    if (wishLen > 1) this._wish.multiplyScalar(1 / wishLen);
    const wishing = wishLen > 0.06;

    // ---- stance / sprint / slide decisions ------------------------------
    const forwardIntent = moveY;
    const wantsSprint = (buttons & BTN.SPRINT) !== 0
      && forwardIntent > TUNING.sprintMinForward && grounded && !this.proneHeld;

    if (wantsSprint) this.sprintTime += dt; else this.sprintTime = 0;

    if (this.state === 'slide') {
      this.stepSlide(dt, moveX);
    } else if (
      this.crouchHeld && grounded && this.slideCooldown <= 0
      && this.horizontalSpeed() >= TUNING.slideEntrySpeed
      && (this.sprintTime > 0 || this.state === 'sprint' || this.state === 'tacSprint')
    ) {
      this.enterSlide();
    }

    // ---- acceleration ----------------------------------------------------
    const maxSpeed = this.targetSpeed(moveX, moveY, wantsSprint, adsHeld);
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
    // Math.sqrt rather than Math.hypot: hypot is not specified to a fixed
    // result across engines and this value feeds every speed threshold.
    const x = this.velocity.x, z = this.velocity.z;
    return Math.sqrt(x * x + z * z);
  }

  private targetSpeed(moveX: number, moveY: number, sprinting: boolean, ads: boolean): number {
    let base: number;
    if (this.proneHeld) base = TUNING.proneSpeed;
    else if (this.crouchHeld) base = TUNING.crouchSpeed;
    else if (sprinting) {
      base = this.sprintTime > TUNING.tacSprintDelay ? TUNING.tacSprintSpeed : TUNING.sprintSpeed;
    } else if (ads) base = TUNING.walkSpeed;
    else base = TUNING.runSpeed;

    // Directional penalties: you are slower sideways and slowest backwards.
    if (moveY < -0.1) base *= TUNING.backScale;
    else if (Math.abs(moveX) > Math.abs(moveY)) base *= TUNING.strafeScale;
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

  private updateStance(dt: number, wantCrouch: boolean, wantProne: boolean): void {
    // Toggle-vs-hold was already resolved on the client (CommandBuilder); the
    // simulation only ever sees the resolved stance intent.
    this.crouchHeld = wantCrouch;
    this.proneHeld = wantProne;
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

  private updateLean(dt: number, want: number): void {
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
    if (this.emitEvents) bus.emit('player:slide', { start: true });
  }

  private exitSlide(): void {
    this.state = this.crouchHeld ? 'crouchIdle' : 'idle';
    this.slideCooldown = TUNING.slideCooldown;
    if (this.emitEvents) bus.emit('player:slide', { start: false });
  }

  private stepSlide(dt: number, moveX: number): void {
    this.slideTime += dt;
    const speed = this.horizontalSpeed();

    // Steering: rotate the velocity toward the look direction rather than
    // accelerating, so the slide keeps its momentum.
    if (Math.abs(moveX) > 0.05 && speed > 0.1) {
      const angle = -moveX * TUNING.slideSteer * dt;
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
    if (this.emitEvents) bus.emit('player:mantle', undefined);
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
    if (crossed && this.emitEvents) {
      bus.emit('player:footstep', {
        point: this.position.clone(),
        surface: this.out.groundSurface,
        sprinting: this.state === 'sprint' || this.state === 'tacSprint',
      });
    }
  }

  /* ------------------------------------------------- prediction / replay */

  /**
   * Writes every field a step can carry forward. Anything the simulation reads
   * *and* writes must appear here, or restore+replay will not reproduce the
   * original trajectory.
   */
  capture(out: MovementState = createMovementState()): MovementState {
    out.px = this.position.x; out.py = this.position.y; out.pz = this.position.z;
    out.vx = this.velocity.x; out.vy = this.velocity.y; out.vz = this.velocity.z;
    out.yaw = this.yaw;
    out.state = this.state;
    out.targetHeight = this.targetHeight;
    out.currentHeight = this.currentHeight;
    out.eye = this.eye;
    out.crouchHeld = this.crouchHeld;
    out.proneHeld = this.proneHeld;
    out.groundedTime = this.groundedTime;
    out.airTime = this.airTime;
    out.jumpBuffer = this.jumpBuffer;
    out.slideTime = this.slideTime;
    out.slideCooldown = this.slideCooldown;
    out.sprintTime = this.sprintTime;
    out.lean = this.lean;
    out.stepAccum = this.stepAccum;
    out.stepPhase = this.stepPhase;
    out.mantleT = this.mantleT;
    out.mantleDuration = this.mantleDuration;
    out.msx = this.mantleStart.x; out.msy = this.mantleStart.y; out.msz = this.mantleStart.z;
    out.mmx = this.mantleMid.x; out.mmy = this.mantleMid.y; out.mmz = this.mantleMid.z;
    out.mex = this.mantleEnd.x; out.mey = this.mantleEnd.y; out.mez = this.mantleEnd.z;
    out.grounded = this.out.grounded;
    out.groundSurface = this.out.groundSurface;
    out.prevButtons = this.prevButtons;
    return out;
  }

  /** Inverse of `capture`. Leaves the object ready to step the next command. */
  restore(s: MovementState): void {
    this.position.set(s.px, s.py, s.pz);
    this.velocity.set(s.vx, s.vy, s.vz);
    this.yaw = s.yaw;
    this.state = s.state;
    this.targetHeight = s.targetHeight;
    this.currentHeight = s.currentHeight;
    this.eye = s.eye;
    this.crouchHeld = s.crouchHeld;
    this.proneHeld = s.proneHeld;
    this.groundedTime = s.groundedTime;
    this.airTime = s.airTime;
    this.jumpBuffer = s.jumpBuffer;
    this.slideTime = s.slideTime;
    this.slideCooldown = s.slideCooldown;
    this.sprintTime = s.sprintTime;
    this.lean = s.lean;
    this.stepAccum = s.stepAccum;
    this.stepPhase = s.stepPhase;
    this.mantleT = s.mantleT;
    this.mantleDuration = s.mantleDuration;
    this.mantleStart.set(s.msx, s.msy, s.msz);
    this.mantleMid.set(s.mmx, s.mmy, s.mmz);
    this.mantleEnd.set(s.mex, s.mey, s.mez);
    this.prevButtons = s.prevButtons;

    // Derived outputs, so a caller that reads `out` before the next step sees
    // something coherent rather than the state we just threw away.
    this.out.grounded = s.grounded;
    this.out.groundSurface = s.groundSurface;
    this.out.state = s.state;
    this.out.lean = s.lean;
    this.out.stepPhase = s.stepPhase;
    this.out.eyeOffset = s.eye - s.currentHeight * 0.5;
    this.out.speed01 = Math.min(1, Math.sqrt(s.vx * s.vx + s.vz * s.vz) / TUNING.tacSprintSpeed);
    this.out.landImpact = 0;
    this.out.mantleStarted = false;

    // The controller keeps internal state we do not snapshot (ground collider,
    // step debt, queued height shift). Teleporting first puts it in a known
    // state, then the height is re-applied — otherwise the next
    // collide-and-slide resolves against the wrong capsule.
    this.controller?.teleport?.(this.position);
    this.controller?.setHeight(this.currentHeight);
  }

  /** Convenience for callers that want a fresh state object of the right shape. */
  static createState(): MovementState { return createMovementState(); }

  /** Copies a state without touching the simulation. */
  static copyState(dst: MovementState, src: MovementState): MovementState {
    return copyMovementState(dst, src);
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
