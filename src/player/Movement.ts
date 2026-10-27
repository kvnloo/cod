/**
 * Movement state machine and locomotion physics — **Apex Legends model**.
 *
 * The design target for this file, and only this file, is Apex Legends
 * traversal. Everything else in the game stays Call of Duty: the weapon
 * handling budgets, the ADS timings, the recoil patterns and the health model
 * are deliberately *not* Apex. What Apex contributes is the part a player feels
 * with their hands between fights — momentum.
 *
 * The five mechanics that make Apex movement Apex, and where each lives:
 *
 *   1. **Momentum-preserving slide** (`stepSlide`). Gravity accelerates you
 *      downhill; friction only really bites on the flat; the slide timer barely
 *      advances while you are gaining speed, so a hill is a ride and not a
 *      1.15-second animation.
 *   2. **Slide-jump chaining** (`slideJump`). Jumping out of a slide keeps every
 *      metre per second you had and adds a little, with a falloff that makes the
 *      chain converge instead of exploding.
 *   3. **Air-strafe** (`accelerateAir`). The classic Quake/Source projected
 *      acceleration with the wish speed clamped per tick. This single clamp is
 *      what separates a player who moves their mouse in time with their strafe
 *      key from one who holds W.
 *   4. **Tap-strafe** (`airControl`). Quake3/CPMA-style air control — a *pure
 *      rotation* of the velocity vector, so it redirects without ever creating
 *      speed — normally weak and forward-only, briefly and dramatically stronger
 *      on a re-press of the forward key. That re-press is exactly the input Apex
 *      players bind to the scroll wheel.
 *   5. **Mantle / climb** (`tryMantle`). Any ledge up to 2.5 × character height,
 *      as a timed climb the player commits to, with the kind and the height
 *      published so the animation layer can pick a clip.
 *
 * Plus the two smaller ones that make the above chain: **bunny-hop retention**
 * (friction is skipped on a landing step that already has a jump buffered) and
 * the **wall-bounce** (a shallow-angle wall contact reflects instead of
 * absorbing).
 *
 * ### Sourced constants
 *
 * Where a number has a real-world reference it is cited at the constant. The
 * important one is `airWishCap`: Source's `AIR_MAX_WISHSPEED` is 30 units/s and
 * Valve's scale is 1 unit = 1 inch, so 30 × 0.0254 = 0.762 m/s. Titanfall and
 * Apex are Source derivatives and inherit the model. Everything downstream of
 * that clamp — how fast strafing accelerates you, why holding W in the air does
 * nothing — falls out of it rather than being hand-tuned.
 *
 * ### One step function, three drivers
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
import { MASK_MOVE, type CharacterController, type PhysicsAPI, type RayHit } from '../physics/types';
import { livingHitboxLayout } from '../characters/Hitboxes';
import type { CharacterMoveResultEx } from '../physics/CharacterController';
import { BTN, type MoveCommand } from './MoveCommand';
import { copyMovementState, createMovementState, type MovementState } from './MovementState';
import { CommandBuilder } from './CommandBuilder';

export type MoveState =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'tacSprint'
  | 'crouchIdle' | 'crouchWalk' | 'prone' | 'proneCrawl'
  | 'slide' | 'air' | 'mantle';

/** What the animation layer should play for the traversal in progress. */
export type MantleKind = 'none' | 'vault' | 'mantle' | 'climb';

/** Wire ordering for `MantleKind`, so a snapshot can carry it as an index. */
export const MANTLE_KINDS: readonly MantleKind[] = ['none', 'vault', 'mantle', 'climb'];

export const TUNING: Record<string, number> & {
  standHeight: number; crouchHeight: number; proneHeight: number;
  standEye: number; crouchEye: number; proneEye: number;
} = {
  /** Ground speeds, metres/second. Unchanged — the audit certified these. */
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
  /**
   * Friction above `tacSprintSpeed`. Apex does not confiscate momentum the
   * instant you touch the ground — it bleeds it. Low enough that a landing costs
   * a few percent, high enough that standing still on the flat is not a
   * hoverboard.
   */
  groundFrictionFast: 0.85,

  /* ---- air model (Quake/Source projected acceleration) ------------------- */
  /**
   * Source `AIR_MAX_WISHSPEED` = 30 units/s at Valve's 1 unit = 1 inch, i.e.
   * 30 × 0.0254 = 0.762 m/s. The per-tick ceiling on how much of the wish
   * direction you are allowed to already be moving in. Everything interesting
   * about strafe-jumping is a consequence of this one number.
   */
  airWishCap: 0.85,
  /**
   * Below this speed the cap is relaxed so a standing jump still has usable air
   * control; it falls back to `airWishCap` by ~2.5 m/s, well under any speed a
   * player could exploit. Apex is more forgiving than CS here and so are we.
   */
  airCapBaseSpeed: 3.2,
  airCapFalloff: 1.0,
  /** Acceleration coefficient, m/s². Near the theoretical optimum for a 120 Hz
   *  tick with the cap above: gain per tick peaks at k·(cap − k·dt)/v. */
  airAccel: 52,
  /** CPMA-style air control, rad/s of *velocity rotation*. Never adds speed. */
  airControlTurn: 2.6,
  /** Air control is forward-only, as in Quake3 — strafe input disables it,
   *  which is what stops it from cancelling out a strafe-jump. */
  airControlMaxStrafe: 0.30,

  /* ---- tap-strafe --------------------------------------------------------- */
  /** Seconds of amplified air control opened by a forward re-press. */
  tapStrafeTime: 0.22,
  /** Amplified rotation rate, rad/s (≈ 630 °/s at full weight). */
  tapStrafeTurn: 12.0,
  /** Forward axis must fall below this, then rise above `tapStrafeOn`. */
  tapStrafeOff: 0.25,
  tapStrafeOn: 0.55,
  /** Redirect is allowed until the wish direction is this far behind velocity
   *  (cos φ). −0.45 ≈ 117°, so two taps comfortably turn you around. */
  tapStrafeDotFloor: -0.45,
  tapStrafeMinSpeed: 2.5,

  /* ---- slide -------------------------------------------------------------- */
  slideEntrySpeed: 4.6,
  slideBoost: 2.60,
  /** Entry boost fades linearly to zero at this speed, so chaining converges. */
  slideBoostFalloff: 20.0,
  slideFriction: 0.48,
  /**
   * Quadratic drag above `slideDragSpeed`, 1/m. Gives a long descent a real
   * terminal speed (~19-20 m/s on a 30-40° ramp) instead of running into
   * `speedHardCap` — a safety clamp is not a design. It is deliberately zero at
   * the speeds a flat slide reaches, so it cannot quietly tax the slide-jump
   * chain, which is measured in single percent.
   */
  slideDrag: 0.10,
  slideDragSpeed: 10.0,
  slideMinSpeed: 3.0,
  slideMaxTime: 1.6,
  slideSteer: 2.6,
  slideCooldown: 0.18,
  /**
   * Cooldown used when a slide ends only because airtime exceeded the grace
   * window (kerb / micro-drop). Full `slideCooldown` is for intentional exits;
   * a geometry nick must not erase a chain the player is still executing.
   */
  slideAirExitCooldown: 0.05,
  /** Fraction of gravity along the slope that accelerates a downhill slide. */
  slideSlopeGain: 1.25,
  /** Downhill relief applied to slide friction and to the slide timer. */
  slideSlopeRelief: 3.0,
  slideTimerRelief: 1.6,
  /** A slide survives this much airtime — small drops do not break the chain.
   *  ~0.4 s covers a kerb / stair lip without eating a full slide-jump window. */
  slideAirGrace: 0.48,
  /** Horizontal mult on a slide-jump. Chains must clear ~1.25× tacSprint mean. */
  slideJumpBoost: 1.22,
  /** Above this the slide-jump boost is not applied; the chain plateaus. */
  slideJumpCap: 16.0,

  /* ---- wall-bounce -------------------------------------------------------- */
  wallBounceMinSpeed: 5.0,
  /** Max |v̂·n| for a contact to count as shallow. 0.72 ≈ 46° off the wall. */
  wallBounceMaxInto: 0.72,
  wallBounceRetain: 1.0,
  wallBounceLift: 1.35,
  wallBounceCooldown: 0.30,
  /**
   * Air control is muted for this long after a bounce. Without it the same
   * forward key that carried you into the wall immediately rotates the velocity
   * back toward the view and cancels the redirect the wall just gave you — the
   * bounce fires, and the player cannot see that it did.
   */
  wallBounceLock: 0.16,

  /** Safety clamp only — 3.3 × sprint. Exists so nothing tunnels; it is not a
   *  design cap and no legitimate chain reaches it. */
  speedHardCap: 26,

  gravity: 18.5,
  jumpVelocity: 5.70,
  /** Grace window after leaving a ledge during which a jump still registers. */
  coyoteTime: 0.11,
  jumpBufferTime: 0.13,

  /** Stances — capsule heights and eye offsets. */
  standHeight: 1.80,
  crouchHeight: 1.18,
  proneHeight: 0.55,
  standEye: 1.62,
  crouchEye: 1.02,
  proneEye: 0.34,
  stanceBlendSpeed: 11,

  /* ---- mantle / climb ------------------------------------------------------ */
  /** 2.5 × `standHeight`. Apex's defining traversal affordance. */
  mantleMaxHeight: 4.50,
  mantleMinHeight: 0.42,
  mantleReach: 1.05,
  /** Below this it is a vault (fast, no commit); above it is a wall climb. */
  mantleVaultHeight: 1.05,
  mantleClimbHeight: 2.20,
  mantleDurationLow: 0.30,
  mantleDurationHigh: 1.15,
  mantleCooldown: 0.25,
  /**
   * Floor on forward speed carried out of a climb. Raised to `slideEntrySpeed`
   * so a vault/mantle never drops the player below re-entry — entry speed is
   * preserved above this floor (see `mantleExitRetain`).
   */
  mantleExitSpeed: 4.6,
  /** Fraction of pre-mantle horizontal speed restored on exit. */
  mantleExitRetain: 0.92,

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

  /* --- traversal, published for the animation layer ------------------------ */
  /** Which climb is running, so a clip can be chosen by kind rather than height. */
  mantleKind: MantleKind;
  /** Height of the ledge being climbed, metres. Valid while `mantleKind` ≠ none. */
  mantleHeight: number;
  /** Total duration of the climb, seconds — drives clip playback rate. */
  mantleDuration: number;
  /** Climb progress in [0,1]. */
  mantleProgress: number;
  /** True on the step a wall-bounce fired. */
  wallBounce: boolean;
  /** True on the step a tap-strafe redirect window opened. */
  tapStrafe: boolean;
  /** True on the step a slide-jump fired. */
  slideJump: boolean;
  /** Horizontal speed in m/s — animation wants the real number, not 0..1. */
  speed: number;
  /** Vertical velocity, m/s. */
  verticalSpeed: number;
  /** Seconds since leaving the ground; 0 while grounded. */
  airTime: number;
}

function moveResult(): CharacterMoveResultEx {
  return {
    applied: new THREE.Vector3(), grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0), groundSurface: 'concrete',
    blocked: false, ceiling: false, impactSpeed: 0,
    // Allocated so `CapsuleCharacterController` fills them in — see
    // `CharacterMoveResultEx`.
    wallNormal: new THREE.Vector3(), stepped: false, stepRise: 0,
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
  /**
   * Live tuning table. Probes (`g1-ingame`, labs) read this so their air-strafe
   * optimum cannot hardcode a stale `airAccel` and drift from production.
   */
  static readonly TUNING = TUNING;

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

  /** Diagnostic counters — read by the movement lab, never by the simulation. */
  wallBounceCount = 0;
  tapStrafeCount = 0;
  mantleCount = 0;
  slideJumpCount = 0;

  private controller: CharacterController | null = null;
  private physics: PhysicsAPI | null = null;
  /** Owning entity id — stamped on the capsule and used as raycast ignore. */
  private entityId = 1;
  private result = moveResult();
  private hit = rayHit();
  private hit2 = rayHit();
  /** Buttons of the previous command — press edges are derived, not sent. */
  private prevButtons = 0;
  /** Forward axis of the previous command — the tap-strafe edge comes off this. */
  private prevMoveY = 0;
  /** |Δyaw|/dt of the previous step — ground turn tax. */
  private yawRate = 0;
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
  /** Seconds of amplified air control remaining. */
  private tapWindow = 0;
  private wallCooldown = 0;
  private mantleCooldown = 0;
  /**
   * Post-jump mantle intent window. A jump *commit* (press edge) opens this so
   * a player can grab a ledge after releasing space mid-flight; plain hold-W
   * never opens it.
   */
  private mantleJumpGrace = 0;
  /** Seconds a slide has been airborne; a slide survives `slideAirGrace`. */
  private slideAirTime = 0;
  /** Foot height of the last ground contact — the datum a climb is measured from. */
  private lastGroundY = 0;

  /* mantle */
  private mantleT = 0;
  private mantleDuration = 0;
  private mantleHeight = 0;
  private mantleKind: MantleKind = 'none';
  /** Horizontal speed at the moment the mantle began — exit restores this. */
  private mantleEntrySpeed = 0;
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
  private readonly _slope = new THREE.Vector3();

  readonly out: MovementOutput = {
    state: 'idle', eyeOffset: TUNING.standEye - TUNING.standHeight * 0.5, lean: 0,
    speed01: 0, stepPhase: 0, grounded: true, groundSurface: 'concrete',
    landImpact: 0, mantleStarted: false,
    mantleKind: 'none', mantleHeight: 0, mantleDuration: 0, mantleProgress: 0,
    wallBounce: false, tapStrafe: false, slideJump: false,
    speed: 0, verticalSpeed: 0, airTime: 0,
  };

  attach(physics: PhysicsAPI, entityId = 1): void {
    this.physics = physics;
    this.controller = physics.createCharacter(0.34, TUNING.standHeight);
    this.entityId = entityId;
    // Player.entityId is 1. Without this the registry keeps entityId=-1 zone=chest
    // and ignoreEntity/ownerEntity=1 cannot filter the capsule — camera-origin
    // rays (zoneScan, early ballistics) report anonymous chest on the local body.
    // Multi-zone *sensor* hitboxes (MASK_BULLET) so AI rounds resolve head/chest/
    // limb the same way player rounds do. The solid capsule moves to CLIP and
    // no longer absorbs bullets as a fake all-chest hit.
    this.controller.setEntity?.(entityId);
    this.controller.setHitboxes?.(livingHitboxLayout(TUNING.standHeight, 0.34));
  }

  teleport(p: THREE.Vector3, yaw: number): void {
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.state = 'idle';
    this.mantleT = 0;
    this.mantleKind = 'none';
    this.mantleEntrySpeed = 0;
    this.prevButtons = 0;
    this.prevMoveY = 0;
    this.yawRate = 0;
    this.jumpBuffer = 0;
    this.slideTime = 0;
    this.slideCooldown = 0;
    this.slideAirTime = 0;
    this.sprintTime = 0;
    this.tapWindow = 0;
    this.wallCooldown = 0;
    this.mantleCooldown = 0;
    this.mantleJumpGrace = 0;
    // Reset contact timers so goHome/respawn never inherits coyote air or a
    // stale grounded flag from the pre-teleport pose.
    this.groundedTime = 0;
    this.airTime = 0;
    this.out.grounded = true;
    this.out.groundSurface = 'concrete';
    this.out.state = 'idle';
    this.out.airTime = 0;
    this.lastGroundY = p.y - this.currentHeight * 0.5;
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
    const prevMoveY = this.prevMoveY;
    this.prevButtons = buttons;
    this.prevMoveY = cmd.moveY;

    {
      let dy = yaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yawRate = dt > 1e-8 ? Math.abs(dy) / dt : 0;
    }
    this.yaw = yaw;
    this.out.landImpact = 0;
    this.out.mantleStarted = false;
    this.out.wallBounce = false;
    this.out.tapStrafe = false;
    this.out.slideJump = false;

    const jumpPressed = (buttons & BTN.JUMP) !== 0 && (prev & BTN.JUMP) === 0;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.tapWindow = Math.max(0, this.tapWindow - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    this.mantleCooldown = Math.max(0, this.mantleCooldown - dt);
    this.mantleJumpGrace = Math.max(0, this.mantleJumpGrace - dt);
    if (jumpPressed) {
      this.jumpBuffer = TUNING.jumpBufferTime;
      // Long enough to reach a 1.2 m crate from a short hop approach.
      this.mantleJumpGrace = 0.55;
    }

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

    // ---- tap-strafe edge --------------------------------------------------
    // Apex players bind forward to the scroll wheel: every notch is a release
    // and a re-press. We look for exactly that shape on the analog forward axis,
    // which means a keyboard tap and a scroll notch produce the same mechanic
    // and neither is special-cased.
    if (!grounded
      && moveY >= TUNING.tapStrafeOn && prevMoveY < TUNING.tapStrafeOff
      && this.horizontalSpeed() > TUNING.tapStrafeMinSpeed) {
      this.tapWindow = TUNING.tapStrafeTime;
      this.out.tapStrafe = true;
      this.tapStrafeCount++;
    }

    // ---- stance / sprint / slide decisions ------------------------------
    const forwardIntent = moveY;
    // Sprint button alone is enough to *retain* tac-sprint progress through a
    // short hop / slide-jump. Requiring grounded+forward for the clock itself
    // demoted every aerial chain back to a 0.9 s re-earn — hold-W on the floor
    // beat skilled movement by construction.
    // Fire cancels sprint same-step (CoD cancel table) so weapons can arm the
    // sprint-out gate from the last sprinting frame instead of waiting on Shift.
    const fireHeld = (buttons & BTN.FIRE) !== 0;
    const sprintHeld = (buttons & BTN.SPRINT) !== 0 && !this.proneHeld && !fireHeld;
    const wantsSprint = sprintHeld
      && forwardIntent > TUNING.sprintMinForward && grounded;

    if (wantsSprint) {
      this.sprintTime += dt;
    } else if (!sprintHeld) {
      this.sprintTime = 0;
    } else if (
      grounded
      && forwardIntent <= TUNING.sprintMinForward
      // Optimal air-strafe lands on A/D with moveY≈0. Wiping the meter on that
      // land made re-slide require hs≥sprintSpeed and dropped the 5.2–6.4 band
      // into the crouchSpeed trap. Keep the meter whenever sprint is held and
      // the body still carries chain-class speed (or a meaningful strafe input).
      && this.horizontalSpeed() < TUNING.slideEntrySpeed
      && Math.abs(moveX) < 0.35
    ) {
      this.sprintTime = 0;
    }

    // Slide: on the ground, full slide step. Airborne (kerb / lip within
    // slideAirGrace) must NOT pay slideFriction and must still air-strafe —
    // otherwise micro-geometry taxes skilled chains while hold-W on flat never
    // hits this path.
    if (this.state === 'slide') {
      if (grounded) {
        this.slideAirTime = 0;
        this.stepSlide(dt, moveX);
      } else {
        this.slideAirTime += dt;
        const airExpired = this.slideAirTime > TUNING.slideAirGrace;
        if (
          airExpired
          || this.horizontalSpeed() < TUNING.slideMinSpeed
          || (!this.crouchHeld && this.canStand())
        ) {
          this.exitSlide(airExpired ? TUNING.slideAirExitCooldown : TUNING.slideCooldown);
        }
      }
    } else if (
      this.crouchHeld && grounded && this.slideCooldown <= 0
      && this.horizontalSpeed() >= TUNING.slideEntrySpeed
    ) {
      // Crouch at speed is a slide — no extra sprint-meter / state gate. The
      // old hs≥sprintSpeed OR meter gate blocked the slideEntrySpeed..sprintSpeed
      // recovery band after an air-strafe land.
      this.enterSlide();
    }

    // ---- jump decision, taken before the acceleration ---------------------
    // Resolved here rather than after, because ground friction needs the answer:
    // a landing step that is already going to jump must keep its speed. That is
    // the whole of bunny-hop retention — without it a single 8.3 ms tick of
    // friction costs ~12% per hop and the chain dies in three bounces. Taking
    // the decision once also means one `canStand` raycast instead of two, and
    // the friction skip can never disagree with the jump it was skipped for.
    const canJump = (grounded || this.groundedTime < TUNING.coyoteTime)
      && this.state !== 'prone' && this.jumpBuffer > 0 && this.canStand();

    // ---- acceleration ----------------------------------------------------
    const maxSpeed = this.targetSpeed(moveX, moveY, wantsSprint, adsHeld);
    const sliding = this.state === 'slide';
    const slideAirborne = sliding && !grounded;
    if (!sliding || slideAirborne) {
      if (grounded && !sliding) this.accelerateGround(this._wish, maxSpeed, dt, wishing, canJump);
      else this.accelerateAir(this._wish, maxSpeed, dt, moveX, moveY);
    }

    if (canJump) {
      if (this.state === 'slide') this.slideJump();
      this.velocity.y = TUNING.jumpVelocity;
      this.jumpBuffer = 0;
      this.groundedTime = 999;
      this.out.grounded = false;
    }

    this.velocity.y -= TUNING.gravity * dt;
    if (this.velocity.y < -55) this.velocity.y = -55;

    // ---- mantle detection -------------------------------------------------
    // Climb is a deliberate commit. Free hold-W near a ledge used to auto-mantle
    // and freeze velocity 0.3–1.15 s, which punished W+air-strafe corridor chains
    // while floor hold-W never paid the tax. Require a jump commit (held, buffer,
    // or post-jump grace). Pure A/D is still exempt via strafeOnly.
    if (this.mantleCooldown <= 0 && (!grounded || this.velocity.y > 0.5)) {
      const jumpHeld = (buttons & BTN.JUMP) !== 0;
      const strafeOnly = Math.abs(moveX) > 0.4 && moveY < TUNING.sprintMinForward;
      const jumpIntent = jumpHeld || this.jumpBuffer > 0 || this.mantleJumpGrace > 0;
      const climbIntent = !strafeOnly && jumpIntent;
      if (climbIntent && this.tryMantle()) return this.out;
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
      this.resolveWall(wasGrounded);
    } else {
      this.position.add(this._motion);
      this.out.grounded = this.position.y <= this.currentHeight * 0.5;
      if (this.out.grounded) {
        this.position.y = this.currentHeight * 0.5;
        if (!wasGrounded) this.out.landImpact = -this.velocity.y;
        this.velocity.y = 0;
      }
    }

    // Safety clamp only — see `speedHardCap`.
    const hs0 = this.horizontalSpeed();
    if (hs0 > TUNING.speedHardCap) {
      const k = TUNING.speedHardCap / hs0;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }

    if (this.out.grounded) {
      this.groundedTime = 0;
      this.airTime = 0;
      this.lastGroundY = this.position.y - this.currentHeight * 0.5;
    } else { this.groundedTime += dt; this.airTime += dt; }

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
    this.out.speed = hs;
    this.out.verticalSpeed = this.velocity.y;
    this.out.airTime = this.airTime;
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
    else if (this.crouchHeld) {
      // Crouch is a stance, not a handbrake. From rest you crawl at crouchSpeed;
      // with chain-class horizontal speed the accel target stays at run so
      // landing a hop while holding crouch can re-enter slide instead of
      // braking the whole chain to 2.05 m/s over a handful of fixed ticks.
      const hs = this.horizontalSpeed();
      base = hs >= TUNING.slideEntrySpeed ? TUNING.runSpeed : TUNING.crouchSpeed;
    } else if (sprinting) {
      base = this.sprintTime > TUNING.tacSprintDelay ? TUNING.tacSprintSpeed : TUNING.sprintSpeed;
    } else if (ads) base = TUNING.walkSpeed;
    else base = TUNING.runSpeed;

    // Directional penalties: you are slower sideways and slowest backwards.
    if (moveY < -0.1) base *= TUNING.backScale;
    else if (Math.abs(moveX) > Math.abs(moveY)) base *= TUNING.strafeScale;
    return base;
  }

  private accelerateGround(
    wish: THREE.Vector3, maxSpeed: number, dt: number, wishing: boolean, hopping: boolean,
  ): void {
    // Friction first, applied to the horizontal plane only. A step that is about
    // to jump skips it entirely — see `hopping` at the call site.
    const speed = this.horizontalSpeed();
    if (speed > 0.0001 && !hopping) {
      // Overspeed from a slide-jump chain: chained landings skip this block
      // entirely (`hopping`). Plain hold-W pays a real excess pull so a gift
      // cannot coast a corridor (Category F). Was groundFrictionFast*dt*0.35
      // (~0.30/s) which left naive near-full speed after any gift.
      if (speed > maxSpeed * 1.02) {
        const excess = speed - maxSpeed;
        const drop = speed * TUNING.groundFrictionFast * dt
          + excess * 2.5 * dt;
        const scale = Math.max(0, speed - drop) / speed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      } else {
        const rate = TUNING.groundFriction;
        const drop = Math.max(speed, 2.0) * rate * dt * (wishing ? 0.55 : 1);
        const scale = Math.max(0, speed - drop) / speed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }
    if (!wishing) return;

    // Quake-style projected acceleration: preserves speed when strafing, which is
    // what makes direction changes feel crisp rather than mushy. Note it can only
    // ever *add* — a player already faster than `maxSpeed` is never braked here,
    // which is what lets momentum survive a touch of ground.
    //
    // `sprintRampTime` authors the commitment gradient: from rest, horizontal
    // speed reaches ~90% of `maxSpeed` in that many seconds (exponential rate
    // −ln(0.1)/T). Without it, groundAccel·maxSpeed·dt filled the bar in two
    // fixed ticks and hold-W equalled any ground technique immediately.
    //
    // Quake-style projected acceleration continues below. Yaw-rate softens the
    // accel *target* so hold-W mouse-steering cannot keep full tacSprint through
    // a sharp corner; slides never enter this function.
    const prevHs = this.horizontalSpeed();
    const yr = this.yawRate;
    const turnScale = yr <= 1.0 ? 1 : Math.max(0.55, 1 - (yr - 1.0) * 0.10);
    const target = maxSpeed * turnScale;
    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = target - current;
    if (add > 0) {
      const ramp = Math.max(1e-3, TUNING.sprintRampTime);
      const gainPerSec = target * 2.302585 / ramp; // ln(10) → 90% in ramp seconds
      const accel = Math.min(gainPerSec * dt, add);
      this.velocity.x += wish.x * accel;
      this.velocity.z += wish.z * accel;
    }

    // Cap growth against |v_h|, not v·wish. Projected accel alone settles a
    // wall-hug at maxSpeed/cos(θ) — measured +32% over run at 45° with no
    // sprint key. Never strip overspeed carried in from a slide-jump; only
    // refuse to *grow* past max(maxSpeed, speed-before-accel).
    const hs = this.horizontalSpeed();
    const cap = Math.max(maxSpeed, prevHs);
    if (hs > cap + 1e-6) {
      const k = cap / hs;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    }

  /**
   * Air movement, in two parts that must not be confused with each other.
   *
   * **Acceleration** is the classic Quake/Source projection with the wish speed
   * clamped to `airWishCap`. Because the clamp is on *how much of the wish
   * direction you may already be moving in*, holding the stick toward your own
   * velocity gains nothing at all, while holding it perpendicular gains
   * `cap − v·ŵ` every tick. Turning the view so the wish direction tracks just
   * outside your velocity is what accelerates you, and doing it well is the
   * skill.
   *
   * **Air control** is a rotation, not an acceleration: it re-points the
   * velocity vector without changing its length. It is gated to forward-only
   * input exactly as in Quake3, which is what keeps it from quietly undoing a
   * strafe, and it is what a tap-strafe amplifies.
   */
  private accelerateAir(
    wish: THREE.Vector3, maxSpeed: number, dt: number, moveX: number, moveY: number,
  ): void {
    const speed = this.horizontalSpeed();

    // --- 1. projected acceleration with a capped wish speed ------------------
    // Above the slide-jump plateau, fade air-accel so the chain asymptotes
    // instead of ratcheting forever on pure air-strafe.
    const plateau = TUNING.slideJumpCap;
    const airFade = speed <= plateau ? 1
      : Math.max(0, 1 - (speed - plateau) / Math.max(1e-3, plateau * 0.35));
    const cap = Math.min(
      TUNING.airCapBaseSpeed,
      Math.max(TUNING.airWishCap, TUNING.airCapBaseSpeed - speed * TUNING.airCapFalloff),
    );
    const capped = Math.min(maxSpeed, cap);
    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = capped - current;
    if (add > 0 && airFade > 0) {
      const accel = Math.min(TUNING.airAccel * airFade * dt, add);
      this.velocity.x += wish.x * accel;
      this.velocity.z += wish.z * accel;
    }

    // --- 2. air control / tap-strafe ----------------------------------------
    this.airControl(wish, dt, moveX, moveY);
  }

  /**
   * Quake3/CPMA air control: rotate the horizontal velocity toward the wish
   * direction, preserving its magnitude exactly. Forward-only, and weighted by
   * `dot²` so it falls away as the redirect gets wider — except during a
   * tap-strafe window, which both amplifies the rate and widens the angle it
   * will work across.
   */
  private airControl(wish: THREE.Vector3, dt: number, moveX: number, moveY: number): void {
    const tapping = this.tapWindow > 0;
    if (moveY <= 0.1) return;
    // A wall-bounce commits: see `wallBounceLock`.
    if (this.wallCooldown > TUNING.wallBounceCooldown - TUNING.wallBounceLock) return;
    if (!tapping && Math.abs(moveX) > TUNING.airControlMaxStrafe) return;

    const speed = this.horizontalSpeed();
    if (speed < 0.05) return;

    const vx = this.velocity.x / speed, vz = this.velocity.z / speed;
    const dot = vx * wish.x + vz * wish.z;
    const floor = tapping ? TUNING.tapStrafeDotFloor : 0;
    if (dot <= floor) return;

    // Angle we may sweep this step.
    const weight = tapping ? 1 : dot * dot;
    const rate = tapping ? TUNING.tapStrafeTurn : TUNING.airControlTurn;
    const maxTurn = rate * weight * dt;

    const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    if (angle < 1e-4) return;
    const turn = Math.min(angle, maxTurn);

    // Rotate (vx, vz) toward (wish.x, wish.z) by `turn`, in the plane's own
    // handedness. Cross product's y component gives the sign.
    const cross = vx * wish.z - vz * wish.x;
    const s = cross >= 0 ? 1 : -1;
    const c = Math.cos(turn * s), sn = Math.sin(turn * s);
    const nx = vx * c - vz * sn;
    const nz = vx * sn + vz * c;
    this.velocity.x = nx * speed;
    this.velocity.z = nz * speed;
  }

  /**
   * Reacts to whatever the collide-and-slide solver ran into.
   *
   * This is the fix for the audited blocker. The previous implementation rebuilt
   * the velocity from the *applied displacement*, so a successful step-up — whose
   * displacement necessarily has an upward component — rewrote horizontal speed
   * as vertical speed and launched the player off every kerb. Nothing here writes
   * `velocity.y` except a deliberate wall-bounce.
   */
  private resolveWall(wasGrounded: boolean): void {
    const r = this.result;
    // A step-up is not a collision as far as momentum is concerned: the whole
    // point of a step is that you keep walking. Leave the velocity alone.
    if (r.stepped) return;
    if (!r.blocked) return;

    const n = r.wallNormal;
    if (!n || n.lengthSq() < 1e-8) return;

    // Work in the horizontal plane: a wall's tilt must never become lift.
    this._tmp.set(n.x, 0, n.z);
    const len = this._tmp.length();
    if (len < 1e-6) return;
    this._tmp.multiplyScalar(1 / len);

    const speed = this.horizontalSpeed();
    const into = -(this.velocity.x * this._tmp.x + this.velocity.z * this._tmp.z);
    if (into <= 0) return;                    // already moving away
    if (!this.wallConfirmed(this._tmp)) return;

    // --- wall-bounce: a shallow airborne contact reflects instead of stopping.
    const shallow = speed > 1e-4 && into / speed < TUNING.wallBounceMaxInto;
    if (!wasGrounded && !this.out.grounded && shallow
      && speed >= TUNING.wallBounceMinSpeed && this.wallCooldown <= 0) {
      // Keep the tangential component, mirror the normal component.
      this.velocity.x += this._tmp.x * into * 2;
      this.velocity.z += this._tmp.z * into * 2;
      const after = this.horizontalSpeed();
      if (after > 1e-4) {
        const k = (speed * TUNING.wallBounceRetain) / after;
        this.velocity.x *= k;
        this.velocity.z *= k;
      }
      if (this.velocity.y < TUNING.wallBounceLift) this.velocity.y = TUNING.wallBounceLift;
      this.wallCooldown = TUNING.wallBounceCooldown;
      this.out.wallBounce = true;
      this.wallBounceCount++;
      return;
    }

    // --- otherwise remove the into-wall component. Airborne high-speed contacts
    // only cancel half — full cancel turned corridor air-strafe into a
    // handbrake that dropped landings below slideEntrySpeed and killed the chain.
    const cancel = (!wasGrounded && !this.out.grounded && speed >= TUNING.slideEntrySpeed)
      ? into * 0.15
      : into;
    this.velocity.x += this._tmp.x * cancel;
    this.velocity.z += this._tmp.z * cancel;
  }

  /**
   * Second opinion on a reported wall, from two short rays.
   *
   * A swept capsule resting on the floor grazes it, and the solver's contact
   * normal on a grazing hit comes off the edge cone of the face rather than the
   * face itself — so once in a few hundred steps a run across dead-flat ground
   * reports `blocked` with a normal pointing straight back at the player. It is
   * one tick, but cancelling velocity against it stops a sprint dead, and a
   * sprint that stops dead once every few seconds is exactly the "not smooth"
   * the playtest complained about.
   *
   * Two rays — one just above the step height, one at the capsule centre —
   * settle it. A real wall is in front of at least one of them; a phantom floor
   * contact is in front of neither. This runs only on steps that actually
   * reported a blocker, which on open ground is almost never.
   */
  private wallConfirmed(n: THREE.Vector3): boolean {
    if (!this.physics) return true;
    this._dir.set(-n.x, 0, -n.z);
    const l = this._dir.length();
    if (l < 1e-6) return false;
    this._dir.multiplyScalar(1 / l);
    const reach = 0.34 + 0.12;                 // capsule radius + margin
    const feet = this.position.y - this.currentHeight * 0.5;
    const skin = 0.34 + 0.02;

    this._origin.set(
      this.position.x + this._dir.x * skin,
      feet + 0.52,
      this.position.z + this._dir.z * skin,
    );
    this.physics.raycast(this._origin, this._dir, reach, MASK_MOVE, this.hit, this.entityId);
    if (this.hit.hit) return true;

    this._origin.set(
      this.position.x + this._dir.x * skin,
      this.position.y,
      this.position.z + this._dir.z * skin,
    );
    this.physics.raycast(this._origin, this._dir, reach, MASK_MOVE, this.hit, this.entityId);
    return this.hit.hit;
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
    // Keeping the feet planted while the capsule shrinks is the *controller's*
    // job (`setHeight` queues exactly this shift, and every other character in
    // the game relies on it). Doing it here as well applied the correction
    // twice and the depenetration pass had to claw half of it back, which is
    // what put ~19 mm of vertical wobble into a crouch that measures 0 without
    // it. The no-controller fallback path still needs it.
    if (this.controller) this.controller.setHeight(this.currentHeight);
    else this.position.y += (this.currentHeight - prevHeight) * 0.5;
  }

  private canStand(target = TUNING.standHeight): boolean {
    if (!this.physics) return true;
    const need = target - this.currentHeight;
    if (need <= 0) return true;
    // Start above the current capsule top. A centre-origin ray begins inside our
    // own CLIP proxy (after setHitboxes); solid lab raycasts return toi=0 and
    // permanently deny slide-jumps. ignoreEntity covers the shipping world.
    this._origin.set(
      this.position.x,
      this.position.y + this.currentHeight * 0.5 + 0.02,
      this.position.z,
    );
    this._dir.set(0, 1, 0);
    this.physics.raycast(
      this._origin, this._dir, need + 0.06, MASK_MOVE, this.hit, this.entityId,
    );
    return !this.hit.hit;
  }

  private updateLean(dt: number, want: number): void {
    const k = 1 - Math.exp(-TUNING.leanSpeed * dt);
    this.lean += (want - this.lean) * k;
    if (Math.abs(this.lean) < 0.001) this.lean = 0;
  }

  /* ------------------------------------------------------------------ slide */

  private enterSlide(): void {
    this.state = 'slide';
    this.slideTime = 0;
    this.slideAirTime = 0;
    const speed = this.horizontalSpeed();
    if (speed > 0.001) {
      // The boost fades to nothing by `slideBoostFalloff`, so slide → jump →
      // slide converges on a plateau instead of compounding without bound. This
      // is the difference between a chainable mechanic and an exploit.
      const gain = TUNING.slideBoost * Math.max(0, 1 - speed / TUNING.slideBoostFalloff);
      const k = (speed + gain) / speed;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    if (this.emitEvents) bus.emit('player:slide', { start: true });
  }

  private exitSlide(cooldown = TUNING.slideCooldown): void {
    this.state = this.crouchHeld ? 'crouchIdle' : 'idle';
    this.slideCooldown = cooldown;
    this.slideAirTime = 0;
    if (this.emitEvents) bus.emit('player:slide', { start: false });
  }

  /**
   * Jumping out of a slide. Apex's signature chain: the horizontal velocity is
   * kept in full and nudged, and no slide cooldown is imposed, so the player can
   * be sliding again the tick they land.
   */
  private slideJump(): void {
    const speed = this.horizontalSpeed();
    if (speed > 0.001 && speed < TUNING.slideJumpCap) {
      const k = TUNING.slideJumpBoost;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    this.exitSlide(0);
    this.out.slideJump = true;
    this.slideJumpCount++;
  }

  private stepSlide(dt: number, moveX: number): void {
    const speed = this.horizontalSpeed();

    // --- slope: gravity along the surface. A slide is a ride downhill.
    let downhill = 0;
    const n = this.result.groundNormal;
    const nh = Math.sqrt(n.x * n.x + n.z * n.z);
    if (this.out.grounded && nh > 1e-4 && speed > 1e-4) {
      // The horizontal part of a surface normal points straight downhill.
      this._slope.set(n.x / nh, 0, n.z / nh);
      const sinTheta = Math.min(1, nh);
      const accel = TUNING.gravity * sinTheta * TUNING.slideSlopeGain;
      this.velocity.x += this._slope.x * accel * dt;
      this.velocity.z += this._slope.z * accel * dt;
      // How much of our travel is downhill, 0..1 — drives friction relief.
      const along = (this.velocity.x * this._slope.x + this.velocity.z * this._slope.z)
        / Math.max(1e-4, this.horizontalSpeed());
      downhill = Math.max(0, along) * sinTheta;
    }

    // The clock only really runs on the flat: a slide that is still gaining
    // speed should not be cut off by a timer.
    this.slideTime += dt * Math.max(0, 1 - TUNING.slideTimerRelief * downhill);

    // --- steering: rotate the velocity toward the input rather than
    // accelerating, so the slide keeps its momentum.
    const s2 = this.horizontalSpeed();
    if (Math.abs(moveX) > 0.05 && s2 > 0.1) {
      const angle = -moveX * TUNING.slideSteer * dt;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const vx = this.velocity.x, vz = this.velocity.z;
      this.velocity.x = vx * cos - vz * sin;
      this.velocity.z = vx * sin + vz * cos;
    }

    // --- friction, relieved by how much of the motion is downhill, plus a
    // quadratic drag that sets the terminal speed of a long descent.
    const relief = Math.max(0.15, 1 - TUNING.slideSlopeRelief * downhill);
    const over = Math.max(0, s2 - TUNING.slideDragSpeed);
    const drop = TUNING.slideFriction * relief * dt * Math.max(1, s2 * 0.35)
      + TUNING.slideDrag * over * over * dt;
    const scale = s2 > 0 ? Math.max(0, s2 - drop) / s2 : 0;
    this.velocity.x *= scale;
    this.velocity.z *= scale;

    // Airborne grace is handled in `stepCommand` (air-strafe, no friction tax).
    // This path only runs while grounded.
    if (this.slideTime > TUNING.slideMaxTime
      || this.horizontalSpeed() < TUNING.slideMinSpeed
      || (!this.crouchHeld && this.canStand())) {
      this.exitSlide(TUNING.slideCooldown);
    }
  }

  /* ----------------------------------------------------------------- mantle */

  /**
   * Looks for a ledge in front and starts the climb.
   *
   * Reach goes to `mantleMaxHeight` = 2.5 × character height, which is the Apex
   * affordance: almost any roofline in the level is traversable, and the whole
   * layout of a map reads differently because of it. The climb is a committed,
   * timed traversal — input is ignored until it finishes — and its kind, height
   * and duration are published on `out` so the animation layer can pick a clip
   * and play it at the right rate.
   */
  private tryMantle(): boolean {
    if (!this.physics) return false;
    const feet = this.position.y - this.currentHeight * 0.5;

    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // 1. Is there a wall in front at chest height?
    // Origin sits just outside the capsule so solid self-hits never qualify.
    const skin = 0.34 + 0.02;
    this._origin.set(
      this.position.x + this._forward.x * skin,
      feet + 0.9,
      this.position.z + this._forward.z * skin,
    );
    this.physics.raycast(
      this._origin, this._forward, TUNING.mantleReach, MASK_MOVE, this.hit, this.entityId,
    );
    if (!this.hit.hit) {
      // Low obstacles have nothing at chest height — look at shin height too, so
      // a 0.5 m crate is a vault rather than a wall you bump into.
      this._origin.set(
        this.position.x + this._forward.x * skin,
        feet + 0.35,
        this.position.z + this._forward.z * skin,
      );
      this.physics.raycast(
        this._origin, this._forward, TUNING.mantleReach, MASK_MOVE, this.hit, this.entityId,
      );
      if (!this.hit.hit) return false;
    }
    // Only mantle roughly-vertical faces.
    if (Math.abs(this.hit.normal.y) > 0.45) return false;
    // Must be closing on the wall, not skating past it on an air-strafe.
    // 2.0 m/s into-wall rejects glancing S-curve scrapes that used to free-climb
    // corridor wall-tops mid hop and freeze the chain.
    const intoWall = -(this.velocity.x * this.hit.normal.x + this.velocity.z * this.hit.normal.z);
    if (intoWall < 2.0) return false;

    // 2. Probe downward just past the wall to find the ledge top.
    this._tmp.copy(this.hit.point).addScaledVector(this._forward, 0.42);
    this._tmp.y = feet + TUNING.mantleMaxHeight + 0.3;
    this._dir.set(0, -1, 0);
    this.physics.raycast(
      this._tmp, this._dir, TUNING.mantleMaxHeight + 0.5, MASK_MOVE, this.hit2, this.entityId,
    );
    if (!this.hit2.hit) return false;

    const ledgeHeight = this.hit2.point.y - feet;
    if (ledgeHeight < TUNING.mantleMinHeight || ledgeHeight > TUNING.mantleMaxHeight) return false;
    // Measured from the ground the player launched from, not from wherever the
    // jump has carried them to — otherwise the jump silently adds its own apex
    // to the reach and "2.5 × character height" becomes 2.9 ×. The limit has to
    // mean something a level designer can build against.
    if (this.hit2.point.y - this.lastGroundY > TUNING.mantleMaxHeight) return false;
    if (this.hit2.normal.y < 0.6) return false; // not a walkable top

    // 3. Headroom check above the landing spot.
    this._origin.copy(this.hit2.point).addScaledVector(this._forward, 0.05);
    this._origin.y += 0.08;
    this._dir.set(0, 1, 0);
    this.physics.raycast(
      this._origin, this._dir, TUNING.standHeight * 0.9, MASK_MOVE, this.hit, this.entityId,
    );
    if (this.hit.hit) return false;

    const kind: MantleKind = ledgeHeight <= TUNING.mantleVaultHeight ? 'vault'
      : ledgeHeight <= TUNING.mantleClimbHeight ? 'mantle' : 'climb';

    this.mantleStart.copy(this.position);
    this.mantleEnd.copy(this.hit2.point).addScaledVector(this._forward, 0.34);
    this.mantleEnd.y += this.currentHeight * 0.5 + 0.02;
    // Arc through a point above the ledge lip so the body clears the edge. For a
    // tall climb the control point sits directly above the start, which is what
    // makes it read as hauling yourself up a wall rather than floating over it.
    this.mantleMid.copy(this.mantleStart);
    this.mantleMid.y = this.mantleEnd.y + (kind === 'vault' ? 0.06 : 0.18);

    // Duration scales with the climb: a knee-high vault is over before you
    // notice, a two-storey climb is a real commitment.
    const t = THREE.MathUtils.clamp(
      (ledgeHeight - TUNING.mantleMinHeight) / (TUNING.mantleMaxHeight - TUNING.mantleMinHeight),
      0, 1,
    );
    this.mantleDuration = TUNING.mantleDurationLow
      + (TUNING.mantleDurationHigh - TUNING.mantleDurationLow) * t;
    this.mantleT = 0;
    this.mantleHeight = ledgeHeight;
    this.mantleKind = kind;
    this.mantleEntrySpeed = this.horizontalSpeed();
    this.state = 'mantle';
    // Integration is a Bezier teleport for the climb; velocity is restored on
    // exit from `mantleEntrySpeed` so the chain is not deleted mid-route.
    this.velocity.set(0, 0, 0);

    this.out.mantleStarted = true;
    this.out.mantleKind = kind;
    this.out.mantleHeight = ledgeHeight;
    this.out.mantleDuration = this.mantleDuration;
    this.out.mantleProgress = 0;
    this.out.state = this.state;
    this.mantleCount++;
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
    this.controller?.teleport?.(this.position);
    this.out.grounded = false;
    this.out.state = this.state = 'mantle';
    this.out.speed01 = 0.4;
    this.out.speed = 0;
    this.out.verticalSpeed = 0;
    this.out.mantleKind = this.mantleKind;
    this.out.mantleHeight = this.mantleHeight;
    this.out.mantleDuration = this.mantleDuration;
    this.out.mantleProgress = t;
    this.out.eyeOffset = this.eye - this.currentHeight * 0.5;

    if (t >= 1) {
      this.state = 'idle';
      this.out.grounded = true;
      this.out.mantleKind = this.mantleKind = 'none';
      this.out.mantleProgress = 1;
      this.mantleCooldown = TUNING.mantleCooldown;
      // Preserve usable chain speed: at least the authored floor (slide-entry
      // class), and most of whatever horizontal speed entered the mantle.
      const exitSpeed = Math.max(
        TUNING.mantleExitSpeed,
        this.mantleEntrySpeed * TUNING.mantleExitRetain,
      );
      this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
        .multiplyScalar(exitSpeed);
      this.velocity.set(this._forward.x, 0, this._forward.z);
      this.out.speed = exitSpeed;
      this.out.speed01 = Math.min(1, exitSpeed / TUNING.tacSprintSpeed);
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

    // Apex skill timers — first-class MovementState fields so copyMovementState
    // (HostBridge / Predictor / Reconciler) preserves them across corrections.
    out.axPrevMoveY = this.prevMoveY;
    out.axTapWindow = this.tapWindow;
    out.axWallCooldown = this.wallCooldown;
    out.axMantleCooldown = this.mantleCooldown;
    out.axMantleHeight = this.mantleHeight;
    out.axMantleKind = MANTLE_KINDS.indexOf(this.mantleKind);
    out.axGroundY = this.lastGroundY;
    out.axSlideAirTime = this.slideAirTime;
    out.axMantleEntrySpeed = this.mantleEntrySpeed;
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

    this.prevMoveY = s.axPrevMoveY ?? 0;
    this.tapWindow = s.axTapWindow ?? 0;
    this.wallCooldown = s.axWallCooldown ?? 0;
    this.mantleCooldown = s.axMantleCooldown ?? 0;
    this.mantleHeight = s.axMantleHeight ?? 0;
    this.mantleKind = MANTLE_KINDS[s.axMantleKind ?? 0] ?? 'none';
    this.lastGroundY = s.axGroundY ?? (s.py - s.currentHeight * 0.5);
    this.slideAirTime = s.axSlideAirTime ?? 0;
    this.mantleEntrySpeed = s.axMantleEntrySpeed ?? 0;

    // Derived outputs, so a caller that reads `out` before the next step sees
    // something coherent rather than the state we just threw away.
    this.out.grounded = s.grounded;
    this.out.groundSurface = s.groundSurface;
    this.out.state = s.state;
    this.out.lean = s.lean;
    this.out.stepPhase = s.stepPhase;
    this.out.eyeOffset = s.eye - s.currentHeight * 0.5;
    this.out.speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
    this.out.speed01 = Math.min(1, this.out.speed / TUNING.tacSprintSpeed);
    this.out.verticalSpeed = s.vy;
    this.out.airTime = s.airTime;
    this.out.landImpact = 0;
    this.out.mantleStarted = false;
    this.out.wallBounce = false;
    this.out.tapStrafe = false;
    this.out.slideJump = false;
    this.out.mantleKind = this.mantleKind;
    this.out.mantleHeight = this.mantleHeight;
    this.out.mantleDuration = this.mantleDuration;
    this.out.mantleProgress = this.mantleDuration > 0 ? Math.min(1, this.mantleT) : 0;

    // The controller keeps internal state we do not snapshot (ground collider,
    // step debt, queued height shift). Teleporting first puts it in a known
    // state, then the height is re-applied — otherwise the next
    // collide-and-slide resolves against the wrong capsule.
    this.controller?.teleport?.(this.position);
    this.controller?.setHeight(this.currentHeight);
  }

  /** Convenience for callers that want a fresh state object of the right shape. */
  static createState(): MovementState { return createMovementState(); }

  /**
   * Copies a state without touching the simulation.
   * `ax*` skill timers are first-class `MovementState` fields, so a plain
   * `copyMovementState` is sufficient; this wrapper remains for call sites.
   */
  static copyState(dst: MovementState, src: MovementState): MovementState {
    return copyMovementState(dst, src);
  }

  /** Reads the surface under the feet for footstep audio when the controller
   *  does not report one. */
  probeGroundSurface(): SurfaceType {
    if (!this.physics) return 'concrete';
    this._origin.copy(this.position);
    this._dir.set(0, -1, 0);
    this.physics.raycast(
      this._origin, this._dir, this.currentHeight * 0.5 + 0.35, MASK_MOVE, this.hit, this.entityId,
    );
    return this.hit.hit ? (readSurface(this.hit.object) ?? this.hit.surface) : 'concrete';
  }

  dispose(): void { this.controller?.dispose(); }
}
