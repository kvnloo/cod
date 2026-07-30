/**
 * The seam between movement-space and authority-space.
 *
 * Prediction speaks `MoveCommand`/`MovementState` (src/player). The authority
 * speaks `InputCommand`/`EntityState` (src/net/host), and the wire speaks the
 * normative `InputCommand` of src/net/types. Those three describe the same
 * intent with different field names and — dangerously — three different button
 * bit layouts, every one of them a bare `number` that the compiler will happily
 * let cross a boundary unconverted. `src/net/types.ts` says this out loud:
 * prediction predicts with the PLAYER layout while the host simulates with the
 * HOST layout, and prediction's entire job is to run the movement the host runs.
 *
 * So every conversion between those worlds lives here, in one file, and goes
 * through `remapButtons`. Nothing else in the prediction module is allowed to
 * touch a foreign mask. If a bit assignment ever moves, `tools/net-protocol.mjs`
 * fails and `tools/net-prediction-e2e.mjs` fails, rather than the game quietly
 * making people jump when they meant to shoot.
 *
 * Nothing here knows about a transport. A peer host, a headless Node host and a
 * dedicated server all consume the identical structs.
 */

import { createMoveCommand, type MoveCommand } from '../../player/MoveCommand';
import { copyMovementState, createMovementState, type MovementState } from '../../player/MovementState';
import {
  BUTTON_LAYOUT_HOST, BUTTON_LAYOUT_NET, BUTTON_LAYOUT_PLAYER, remapButtons,
  type ButtonLayout,
} from '../types';
import type { InputCommand as NetInputCommand } from '../types';
import { ENTITY_FLAG, type EntityState, type InputCommand as HostInputCommand } from '../host/types';
import type { AuthoritativeUpdate } from './types';

/**
 * The host layout plus the movement-only actions it has no bit for.
 *
 * `BUTTON_LAYOUT_HOST` covers bits 0..7 and simply cannot express PRONE or
 * LEAN — and dropping those is not cosmetic: prone and lean change the capsule
 * height and the eye offset, so a host that never hears them mispredicts the
 * client on every single tick the client is prone. Rather than edit a file this
 * module does not own, the missing actions are carried in the free high bits of
 * the same `number`. A host that does not understand them ignores them (masks
 * are bitfields, unknown bits are inert); a host running `MovementStepper`
 * reads them and stays in lockstep with the client.
 */
export const BUTTON_LAYOUT_HOST_EXT: ButtonLayout = {
  ...BUTTON_LAYOUT_HOST,
  PRONE: 1 << 8,
  LEAN_LEFT: 1 << 9,
  LEAN_RIGHT: 1 << 10,
  GRENADE: 1 << 11,
  TACTICAL: 1 << 12,
  SWITCH: 1 << 13,
};

/** Every bit `BUTTON_LAYOUT_HOST_EXT` can produce. Anything else is noise. */
export const HOST_EXT_BUTTON_MASK = 0x3fff;

/* ------------------------------------------------------------ buttons ---- */

/** Player mask -> host mask (extended layout: nothing is lost). */
export function playerToHostButtons(mask: number): number {
  return remapButtons(mask, BUTTON_LAYOUT_PLAYER, BUTTON_LAYOUT_HOST_EXT);
}

/** Host mask -> player mask. Round-trips exactly through the extended layout. */
export function hostToPlayerButtons(mask: number): number {
  return remapButtons(mask, BUTTON_LAYOUT_HOST_EXT, BUTTON_LAYOUT_PLAYER);
}

/** Player mask -> normative wire mask. */
export function playerToNetButtons(mask: number): number {
  return remapButtons(mask, BUTTON_LAYOUT_PLAYER, BUTTON_LAYOUT_NET);
}

/** Normative wire mask -> player mask. */
export function netToPlayerButtons(mask: number): number {
  return remapButtons(mask, BUTTON_LAYOUT_NET, BUTTON_LAYOUT_PLAYER);
}

/* ----------------------------------------------------------- commands ---- */

/**
 * Prediction command -> authority command.
 *
 * `tick` is stamped by the caller because tick-space belongs to the host, not
 * to the predictor: the client picks which host tick its command is *for*
 * (usually a small lead over the newest tick it has seen). The command's own
 * `seq` rides along so the ack can be mapped back to a prediction sequence.
 *
 * Axis convention: `MoveCommand.moveY` and `InputCommand.moveZ` are both
 * "forward intent, +1 = towards the crosshair". Same sign, different letter.
 */
export function toHostInput(cmd: MoveCommand, tick: number, out?: HostInputCommand): HostInputCommand {
  const dst: HostInputCommand = out ?? {
    tick: 0, seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0,
  };
  dst.tick = tick;
  dst.seq = cmd.seq;
  dst.moveX = cmd.moveX;
  dst.moveZ = cmd.moveY;
  dst.yaw = cmd.yaw;
  dst.pitch = cmd.pitch;
  dst.buttons = playerToHostButtons(cmd.buttons);
  return dst;
}

/**
 * Authority command -> movement command, for the host (and for replay of a
 * recorded match). `dt` comes from the host tick rate: the authority decides
 * how long a tick is, never the client.
 */
export function fromHostInput(input: HostInputCommand, dt: number, out?: MoveCommand): MoveCommand {
  const dst = out ?? createMoveCommand();
  dst.seq = input.seq;
  dst.tick = input.tick;
  dst.dt = dt;
  dst.moveX = input.moveX;
  dst.moveY = input.moveZ;
  dst.yaw = input.yaw;
  dst.pitch = input.pitch;
  dst.buttons = hostToPlayerButtons(input.buttons);
  return dst;
}

/** Prediction command -> normative wire command. */
export function toNetInput(
  cmd: MoveCommand,
  clientTick: number,
  weaponSlot = 0,
  fireCount = 0,
  out?: NetInputCommand,
): NetInputCommand {
  const dst: NetInputCommand = out ?? {
    seq: 0, clientTick: 0, dtMs: 0, moveX: 0, moveZ: 0,
    yaw: 0, pitch: 0, buttons: 0, weaponSlot: 0, fireCount: 0,
  };
  dst.seq = cmd.seq;
  dst.clientTick = clientTick;
  dst.dtMs = cmd.dt * 1000;
  dst.moveX = cmd.moveX;
  dst.moveZ = cmd.moveY;
  dst.yaw = cmd.yaw;
  dst.pitch = cmd.pitch;
  dst.buttons = playerToNetButtons(cmd.buttons);
  dst.weaponSlot = weaponSlot;
  dst.fireCount = fireCount;
  return dst;
}

/** Normative wire command -> movement command. */
export function fromNetInput(input: NetInputCommand, out?: MoveCommand): MoveCommand {
  const dst = out ?? createMoveCommand();
  dst.seq = input.seq;
  dst.tick = input.clientTick;
  dst.dt = input.dtMs / 1000;
  dst.moveX = input.moveX;
  dst.moveY = input.moveZ;
  dst.yaw = input.yaw;
  dst.pitch = input.pitch;
  dst.buttons = netToPlayerButtons(input.buttons);
  return dst;
}

/* ------------------------------------------------------------- entity ---- */

/** Stance/airborne bits the entity table carries for other clients to see. */
export function movementFlags(s: MovementState, previous = 0): number {
  let flags = previous & ~(ENTITY_FLAG.CROUCH | ENTITY_FLAG.SPRINT | ENTITY_FLAG.AIRBORNE);
  const st = s.state;
  if (st === 'crouchIdle' || st === 'crouchWalk' || st === 'slide'
    || st === 'prone' || st === 'proneCrawl') flags |= ENTITY_FLAG.CROUCH;
  if (st === 'sprint' || st === 'tacSprint') flags |= ENTITY_FLAG.SPRINT;
  if (!s.grounded) flags |= ENTITY_FLAG.AIRBORNE;
  return flags;
}

/**
 * Publish a movement result into the authoritative entity table.
 *
 * Only the replicated subset crosses: position, velocity, angles and stance
 * bits. The rest of `MovementState` (timers, buffers, mantle spline) is derived
 * deterministically from the same commands on every machine, so shipping it
 * would be pure bandwidth.
 */
export function writeEntityFromMovement(ent: EntityState, s: MovementState, pitch: number): void {
  ent.px = s.px; ent.py = s.py; ent.pz = s.pz;
  ent.vx = s.vx; ent.vy = s.vy; ent.vz = s.vz;
  ent.yaw = s.yaw;
  ent.pitch = pitch;
  ent.flags = movementFlags(s, ent.flags);
}

/** Seed a `MovementState` from an entity record (spawn, join, host migration). */
export function movementStateFromEntity(ent: EntityState, out?: MovementState): MovementState {
  const dst = out ?? createMovementState();
  dst.px = ent.px; dst.py = ent.py; dst.pz = ent.pz;
  dst.vx = ent.vx; dst.vy = ent.vy; dst.vz = ent.vz;
  dst.yaw = ent.yaw;
  dst.grounded = (ent.flags & ENTITY_FLAG.AIRBORNE) === 0;
  return dst;
}

/**
 * Build the update the reconciler compares against, from what actually came
 * down the wire.
 *
 * The entity table replicates position, velocity and yaw — not the whole
 * movement state machine. So the authoritative state for sequence N is "my own
 * prediction for N, with the authoritative fields overwritten". Anything the
 * host disagreed about downstream of those fields is regenerated by the replay
 * that follows, from the same commands the host ran. That is the whole trick:
 * correct the few fields that are truth, re-derive the rest.
 */
export function authoritativeUpdateFromEntity(
  predicted: MovementState,
  ent: EntityState,
  seq: number,
  tick: number,
  out?: AuthoritativeUpdate,
): AuthoritativeUpdate {
  const dst: AuthoritativeUpdate = out ?? { seq: 0, tick: 0, state: createMovementState() };
  copyMovementState(dst.state, predicted);
  dst.state.px = ent.px; dst.state.py = ent.py; dst.state.pz = ent.pz;
  dst.state.vx = ent.vx; dst.state.vy = ent.vy; dst.state.vz = ent.vz;
  dst.state.yaw = ent.yaw;
  dst.state.grounded = (ent.flags & ENTITY_FLAG.AIRBORNE) === 0;
  dst.seq = seq;
  dst.tick = tick;
  return dst;
}

/* ------------------------------------------------------- tick <-> seq ---- */

/**
 * Maps a host tick back to the prediction sequence that was stamped onto it.
 *
 * Snapshots ack in tick-space (`Snapshot.ackInputTick`) because that is what the
 * authority counts in; prediction reconciles in sequence-space because that is
 * what survives a variable client frame rate. Something has to remember which
 * was which, and it has to be bounded — this is a ring, so a client that stops
 * receiving acks for a minute costs the same as one that never does.
 */
export class TickSeqMap {
  readonly capacity: number;
  private readonly ticks: Int32Array;
  private readonly seqs: Int32Array;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.ticks = new Int32Array(capacity).fill(-1);
    this.seqs = new Int32Array(capacity).fill(-1);
  }

  /**
   * Remember that command `seq` was sent for host tick `tick`.
   *
   * First writer wins, because that is the authority's own rule: a command is
   * idempotent w.r.t. its tick and re-sends for a tick already simulated are
   * dropped. If a client stamps two different commands onto one tick (its tick
   * estimate stalled, then jumped), the host executes the first and discards the
   * second — so the ack for that tick means the first. Letting the later command
   * overwrite here makes every such tick look like a misprediction: the client
   * compares the host's result for command A against its own prediction for
   * command B, "corrects" a difference that was never an error, and the
   * correction rate climbs with jitter for no physical reason.
   */
  record(tick: number, seq: number): void {
    if (tick < 0) return;
    const i = ((tick % this.capacity) + this.capacity) % this.capacity;
    if (this.ticks[i] === tick) return;
    this.ticks[i] = tick;
    this.seqs[i] = seq;
  }

  /** Sequence stamped onto exactly this tick, or -1. No "at or before" search. */
  exact(tick: number): number {
    if (tick < 0) return -1;
    const i = ((tick % this.capacity) + this.capacity) % this.capacity;
    return this.ticks[i] === tick ? this.seqs[i]! : -1;
  }

  /**
   * Newest sequence stamped at or before `tick`, or -1 if the window has rolled
   * past it. Acks can name a tick this client never sent a command for (input
   * starvation on the host), hence "at or before" rather than an exact hit.
   */
  seqForTick(tick: number): number {
    if (tick < 0) return -1;
    const i = ((tick % this.capacity) + this.capacity) % this.capacity;
    if (this.ticks[i] === tick) return this.seqs[i]!;
    let bestTick = -1;
    let bestSeq = -1;
    for (let k = 0; k < this.capacity; k++) {
      const t = this.ticks[k]!;
      if (t >= 0 && t <= tick && t > bestTick) { bestTick = t; bestSeq = this.seqs[k]!; }
    }
    return bestSeq;
  }

  clear(): void {
    this.ticks.fill(-1);
    this.seqs.fill(-1);
  }
}
