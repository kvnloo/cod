/**
 * The complete mutable state of the movement simulation for one character.
 *
 * This is what makes prediction possible: `Movement.capture` writes every field
 * the state machine can carry across a step, and `Movement.restore` puts it
 * back exactly. Restore + replay must reproduce the same trajectory bit for bit,
 * so anything the step reads and writes has to be in here — a forgotten timer is
 * a slow desync that only shows up after a slide or a mantle.
 *
 * It is also the authoritative "predictable player state" the host sends back
 * for the owning client. It is deliberately flat and numeric so the snapshot
 * layer can delta-compress and quantise it without knowing what any field means.
 */

import type { SurfaceType } from '../core/Surfaces';
import { SURFACES } from '../core/Surfaces';
import type { MoveState } from './Movement';

/** Stable wire ordering for the movement state enum. Append only. */
export const MOVE_STATES: readonly MoveState[] = [
  'idle', 'walk', 'run', 'sprint', 'tacSprint',
  'crouchIdle', 'crouchWalk', 'prone', 'proneCrawl',
  'slide', 'air', 'mantle',
];

export function moveStateIndex(s: MoveState): number {
  const i = MOVE_STATES.indexOf(s);
  return i < 0 ? 0 : i;
}

export function moveStateFromIndex(i: number): MoveState {
  return MOVE_STATES[i] ?? 'idle';
}

/** Stable wire ordering for surfaces, derived from the shared surface table. */
export const SURFACE_ORDER: readonly SurfaceType[] = Object.keys(SURFACES) as SurfaceType[];

export function surfaceIndex(s: SurfaceType): number {
  const i = SURFACE_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

export function surfaceFromIndex(i: number): SurfaceType {
  return SURFACE_ORDER[i] ?? 'concrete';
}

export interface MovementState {
  /* transform */
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  state: MoveState;

  /* stance */
  targetHeight: number;
  currentHeight: number;
  eye: number;
  crouchHeld: boolean;
  proneHeld: boolean;

  /* timers */
  groundedTime: number;
  airTime: number;
  jumpBuffer: number;
  slideTime: number;
  slideCooldown: number;
  sprintTime: number;
  lean: number;
  stepAccum: number;
  stepPhase: number;

  /* mantle */
  mantleT: number;
  mantleDuration: number;
  msx: number; msy: number; msz: number;
  mmx: number; mmy: number; mmz: number;
  mex: number; mey: number; mez: number;

  /* carried step output */
  grounded: boolean;
  groundSurface: SurfaceType;

  /** Buttons from the previous command, so press edges survive a restore. */
  prevButtons: number;
}

export function createMovementState(): MovementState {
  return {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, state: 'idle',
    targetHeight: 1.8, currentHeight: 1.8, eye: 1.62,
    crouchHeld: false, proneHeld: false,
    groundedTime: 0, airTime: 0, jumpBuffer: 0,
    slideTime: 0, slideCooldown: 0, sprintTime: 0,
    lean: 0, stepAccum: 0, stepPhase: 0,
    mantleT: 0, mantleDuration: 0,
    msx: 0, msy: 0, msz: 0,
    mmx: 0, mmy: 0, mmz: 0,
    mex: 0, mey: 0, mez: 0,
    grounded: true, groundSurface: 'concrete',
    prevButtons: 0,
  };
}

export function copyMovementState(dst: MovementState, src: MovementState): MovementState {
  dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.yaw = src.yaw; dst.state = src.state;
  dst.targetHeight = src.targetHeight;
  dst.currentHeight = src.currentHeight;
  dst.eye = src.eye;
  dst.crouchHeld = src.crouchHeld;
  dst.proneHeld = src.proneHeld;
  dst.groundedTime = src.groundedTime;
  dst.airTime = src.airTime;
  dst.jumpBuffer = src.jumpBuffer;
  dst.slideTime = src.slideTime;
  dst.slideCooldown = src.slideCooldown;
  dst.sprintTime = src.sprintTime;
  dst.lean = src.lean;
  dst.stepAccum = src.stepAccum;
  dst.stepPhase = src.stepPhase;
  dst.mantleT = src.mantleT;
  dst.mantleDuration = src.mantleDuration;
  dst.msx = src.msx; dst.msy = src.msy; dst.msz = src.msz;
  dst.mmx = src.mmx; dst.mmy = src.mmy; dst.mmz = src.mmz;
  dst.mex = src.mex; dst.mey = src.mey; dst.mez = src.mez;
  dst.grounded = src.grounded;
  dst.groundSurface = src.groundSurface;
  dst.prevButtons = src.prevButtons;
  return dst;
}

/** Straight-line distance between two states' positions, metres. */
export function positionError(a: MovementState, b: MovementState): number {
  const dx = a.px - b.px, dy = a.py - b.py, dz = a.pz - b.pz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Difference in velocity, metres/second. */
export function velocityError(a: MovementState, b: MovementState): number {
  const dx = a.vx - b.vx, dy = a.vy - b.vy, dz = a.vz - b.vz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Exact equality across every field. Used by the replay-determinism test —
 * "close enough" would hide exactly the drift we are trying to catch.
 */
export function movementStatesIdentical(a: MovementState, b: MovementState): boolean {
  const keys = Object.keys(a) as Array<keyof MovementState>;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** First field that differs, for test output. Empty string when identical. */
export function firstDifferingField(a: MovementState, b: MovementState): string {
  const keys = Object.keys(a) as Array<keyof MovementState>;
  for (const k of keys) {
    if (a[k] !== b[k]) return `${String(k)}: ${String(a[k])} vs ${String(b[k])}`;
  }
  return '';
}
