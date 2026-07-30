/**
 * Client-side prediction.
 *
 * The client does not wait for the server. It applies its own command the
 * instant it is produced and records the resulting state against that command's
 * sequence number. If the server later agrees, the player never knew there was
 * a network. If it disagrees, `Reconciler` has the exact predicted state for the
 * exact sequence the server is talking about, which is the only way to tell an
 * error from a legitimate divergence.
 *
 * The history ring is sized in commands, not seconds: it must outlive a full
 * round trip. At 120 Hz, 256 entries covers a 2-second stall.
 */

import {
  copyMovementState, createMovementState, type MovementState,
} from '../../player/MovementState';
import { quantizeMoveCommand, type MoveCommand } from '../../player/MoveCommand';
import type { MovementOutput } from '../../player/Movement';
import { InputBuffer } from './InputBuffer';
import type { MovementSim } from './types';

export interface PredictorOptions {
  /** Power of two; must cover a round trip of commands. */
  historySize?: number;
  /**
   * Snap commands onto the wire grid before predicting. On by default and there
   * is essentially never a reason to turn it off: predicting from values the
   * host will never see guarantees a small permanent disagreement.
   */
  quantize?: boolean;
}

export class Predictor {
  readonly inputs: InputBuffer;
  readonly capacity: number;

  private readonly sim: MovementSim;
  private readonly states: MovementState[];
  private readonly stateSeq: Int32Array;
  private readonly quantize: boolean;
  private lastSeq = -1;

  constructor(sim: MovementSim, opts: PredictorOptions = {}) {
    const size = opts.historySize ?? 256;
    if (size < 8 || (size & (size - 1)) !== 0) {
      throw new Error('[Predictor] historySize must be a power of two >= 8');
    }
    this.sim = sim;
    this.capacity = size;
    this.inputs = new InputBuffer(size);
    this.states = new Array(size);
    for (let i = 0; i < size; i++) this.states[i] = createMovementState();
    this.stateSeq = new Int32Array(size).fill(-1);
    this.quantize = opts.quantize ?? true;
  }

  /** Sequence of the newest predicted command, or -1 before the first. */
  get newestSeq(): number { return this.lastSeq; }
  /** Commands predicted but not yet acknowledged. */
  get inFlight(): number { return this.inputs.length; }

  /**
   * Applies `cmd` immediately and records the state it produced. The command is
   * copied into the input buffer, so the caller may reuse its object.
   */
  predict(cmd: MoveCommand): MovementOutput {
    if (this.quantize) quantizeMoveCommand(cmd);
    this.inputs.push(cmd);
    const out = this.sim.stepCommand(cmd);
    const slot = cmd.seq & (this.capacity - 1);
    this.sim.capture(this.states[slot]);
    this.stateSeq[slot] = cmd.seq;
    this.lastSeq = cmd.seq;
    return out;
  }

  /**
   * Re-applies an already-buffered command during reconciliation and overwrites
   * its recorded state. Events stay muted by the caller so the player does not
   * hear the same footstep twice.
   */
  replay(cmd: MoveCommand): void {
    this.sim.stepCommand(cmd);
    const slot = cmd.seq & (this.capacity - 1);
    this.sim.capture(this.states[slot]);
    this.stateSeq[slot] = cmd.seq;
  }

  /** The state predicted immediately after executing `seq`, or null. */
  stateAt(seq: number): MovementState | null {
    if (seq < 0) return null;
    const slot = seq & (this.capacity - 1);
    return this.stateSeq[slot] === seq ? this.states[slot] : null;
  }

  /** Overwrites the recorded state for `seq` — used after adopting the server's. */
  recordState(seq: number, state: MovementState): void {
    if (seq < 0) return;
    const slot = seq & (this.capacity - 1);
    copyMovementState(this.states[slot], state);
    this.stateSeq[slot] = seq;
  }

  /** Drops history and inputs at or before `seq`. */
  ackThrough(seq: number): number {
    return this.inputs.ackThrough(seq);
  }

  /** Forgets everything. Use on respawn, map change or a fresh connection. */
  reset(nextSeq = 0): void {
    this.inputs.clear(nextSeq);
    this.stateSeq.fill(-1);
    this.lastSeq = nextSeq - 1;
  }
}
