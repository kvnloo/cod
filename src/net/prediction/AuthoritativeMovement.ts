/**
 * The authority side of prediction: one player's movement, advanced by the
 * commands that player sent.
 *
 * This runs `Movement.stepCommand` — the identical function the client predicts
 * with. There is no server copy of the movement rules to keep in sync, which is
 * the only reason prediction can be accurate at all.
 *
 * Nothing in here is peer-specific. It has no transport, no DOM and no Three.js
 * scene dependency beyond the vector maths, so the same object runs inside the
 * host peer's browser today and inside a headless Node process later without
 * modification.
 *
 * ## Jitter buffer
 *
 * Commands arrive in bursts and gaps. Executing them the moment they land makes
 * the player's speed track the network instead of their input. Instead a small
 * queue is held (default 2 commands ≈ 17 ms at 120 Hz) and drained one per tick,
 * with a bounded catch-up of two when the client is running ahead. When the
 * queue runs dry the last command is repeated with its movement intent cleared,
 * which keeps gravity and friction running without inventing input the player
 * never gave — and `starvedTicks` says how often that happened so the client can
 * be told to send earlier.
 */

import {
  BTN, copyMoveCommand, createMoveCommand,
  MAX_COMMAND_DT, MIN_COMMAND_DT, type MoveCommand,
} from '../../player/MoveCommand';
import { createMovementState, type MovementState } from '../../player/MovementState';
import type { MovementSim } from './types';

export interface AuthoritativeMovementOptions {
  /** Commands to hold before draining starts, absorbing jitter. */
  bufferTarget?: number;
  /** Hard cap on queued commands; beyond this the oldest are dropped. */
  maxQueue?: number;
  /** Commands executed in a single tick while catching up a backlog. */
  maxCatchUp?: number;
  /** Longest step a single command may claim, seconds. Anti-speedhack. */
  maxDt?: number;
  /** Shortest step a command may claim, seconds. */
  minDt?: number;
}

export interface TickReport {
  /** Commands executed this tick. */
  executed: number;
  /** Newest sequence executed, or the previous one when nothing ran. */
  ackSeq: number;
  /** True when the queue was empty and a synthetic step was substituted. */
  starved: boolean;
  /** Commands still queued after the tick. */
  queued: number;
}

export class AuthoritativeMovement {
  readonly sim: MovementSim;
  readonly options: Required<AuthoritativeMovementOptions>;

  /** Last sequence actually executed. -1 before the first command. */
  lastAckedSeq = -1;
  /** Ticks in which the queue was empty. A rising count means send earlier. */
  starvedTicks = 0;
  /** Commands rejected as duplicates or already-executed. */
  droppedDuplicates = 0;
  /** Commands dropped because the queue was full — the client is flooding. */
  droppedOverflow = 0;
  /** Commands whose claimed dt was clamped. */
  clampedDt = 0;
  /** Total commands executed. */
  executed = 0;

  private queue: MoveCommand[] = [];
  private pool: MoveCommand[] = [];
  private readonly repeat: MoveCommand = createMoveCommand();
  private hasRepeat = false;

  constructor(sim: MovementSim, options: AuthoritativeMovementOptions = {}) {
    this.sim = sim;
    this.options = {
      bufferTarget: options.bufferTarget ?? 2,
      maxQueue: options.maxQueue ?? 64,
      maxCatchUp: options.maxCatchUp ?? 2,
      maxDt: options.maxDt ?? MAX_COMMAND_DT,
      minDt: options.minDt ?? MIN_COMMAND_DT,
    };
  }

  /** Queued commands waiting to execute. */
  get queued(): number { return this.queue.length; }

  /**
   * Accepts commands from a client. Duplicates from the redundant tail and
   * anything already executed are discarded — that redundancy is exactly why
   * input survives packet loss, and the cost of it is this filter.
   * Returns the number accepted.
   */
  enqueue(commands: readonly MoveCommand[], count = commands.length): number {
    const o = this.options;
    let accepted = 0;
    for (let i = 0; i < count; i++) {
      const c = commands[i];
      if (c.seq <= this.lastAckedSeq) { this.droppedDuplicates++; continue; }
      if (this.findQueued(c.seq) >= 0) { this.droppedDuplicates++; continue; }
      if (this.queue.length >= o.maxQueue) {
        // Drop the oldest rather than the newest: fresher input is worth more
        // than input the player has already moved past.
        const old = this.queue.shift();
        if (old) this.pool.push(old);
        this.droppedOverflow++;
      }
      const slot = this.pool.pop() ?? createMoveCommand();
      copyMoveCommand(slot, c);
      if (slot.dt > o.maxDt || slot.dt < o.minDt) {
        slot.dt = slot.dt > o.maxDt ? o.maxDt : o.minDt;
        this.clampedDt++;
      }
      this.insertOrdered(slot);
      accepted++;
    }
    return accepted;
  }

  /**
   * Advances this player by one server tick. `fallbackDt` is the server's own
   * fixed step, used only when the client has starved us of input.
   */
  tick(fallbackDt: number): TickReport {
    const o = this.options;
    let executed = 0;
    let starved = false;

    // Only start draining once the jitter buffer has filled, otherwise the
    // very first command executes with zero cushion and every later gap stalls.
    const ready = this.queue.length > 0
      && (this.lastAckedSeq >= 0 || this.queue.length >= o.bufferTarget);

    if (ready) {
      const budget = this.queue.length > o.bufferTarget * 2 ? o.maxCatchUp : 1;
      for (let i = 0; i < budget && this.queue.length > 0; i++) {
        const c = this.queue.shift() as MoveCommand;
        this.sim.stepCommand(c);
        this.lastAckedSeq = c.seq;
        copyMoveCommand(this.repeat, c);
        this.hasRepeat = true;
        this.pool.push(c);
        executed++;
        this.executed++;
      }
    } else if (this.hasRepeat) {
      // Starved. Keep the world running with the player's last view direction
      // but no movement or jump intent — never fabricate input.
      starved = true;
      this.starvedTicks++;
      const r = this.repeat;
      r.dt = Math.min(Math.max(fallbackDt, o.minDt), o.maxDt);
      r.moveX = 0;
      r.moveY = 0;
      r.buttons &= (BTN.CROUCH | BTN.PRONE | BTN.ADS | BTN.LEAN_L | BTN.LEAN_R);
      this.sim.stepCommand(r);
    } else if (this.queue.length === 0) {
      starved = true;
      this.starvedTicks++;
    }

    return { executed, ackSeq: this.lastAckedSeq, starved, queued: this.queue.length };
  }

  /** Snapshot of the authoritative state, to send back to the owning client. */
  capture(out: MovementState = createMovementState()): MovementState {
    return this.sim.capture(out);
  }

  reset(): void {
    for (const c of this.queue) this.pool.push(c);
    this.queue.length = 0;
    this.lastAckedSeq = -1;
    this.hasRepeat = false;
    this.starvedTicks = 0;
    this.droppedDuplicates = 0;
    this.droppedOverflow = 0;
    this.clampedDt = 0;
    this.executed = 0;
  }

  private findQueued(seq: number): number {
    for (let i = 0; i < this.queue.length; i++) if (this.queue[i].seq === seq) return i;
    return -1;
  }

  /** Keeps the queue ordered by sequence; datagrams can arrive out of order. */
  private insertOrdered(cmd: MoveCommand): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].seq > cmd.seq) i--;
    if (i === this.queue.length) this.queue.push(cmd);
    else this.queue.splice(i, 0, cmd);
  }
}
