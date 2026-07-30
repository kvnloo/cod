/**
 * The client half of the netcode's movement path, assembled.
 *
 * Wires `CommandBuilder → Predictor → InputBuffer → transport` on the way out
 * and `authoritative state → Reconciler → replay` on the way back, and exposes
 * the whole thing as a `PlayerNetDriver` so `PlayerSystem` can hand over its
 * movement step without importing anything from `src/net`.
 *
 * Usage:
 *
 *   const client = new ClientPrediction(player.movement);
 *   client.sendCommands = (cmds, n) => transport.sendUnreliable(packCommands(cmds, n));
 *   player.netDriver = client;
 *   // when a snapshot for the local player arrives:
 *   client.applyAuthoritative({ seq, tick, state });
 *
 * The transport is a callback, not an interface this module owns, so moving the
 * host from a peer to a dedicated server changes nothing on this side.
 */

import type { MovementOutput } from '../../player/Movement';
import { CommandBuilder } from '../../player/CommandBuilder';
import { commandBatchBytes, type MoveCommand } from '../../player/MoveCommand';
import type { MovementState } from '../../player/MovementState';
import type { PlayerNetDriver, Vec3Like } from '../../player/NetDriver';
import { Predictor } from './Predictor';
import { Reconciler } from './Reconciler';
import {
  type AuthoritativeUpdate, type CommandSink, type MovementSim,
  type PredictionMetrics, type ReconcileOptions, type ReconcileResult,
} from './types';

export interface ClientPredictionOptions extends Partial<ReconcileOptions> {
  /** Power-of-two command history. Must exceed one RTT of commands. */
  historySize?: number;
  /**
   * How many recent commands ride along in every outgoing packet. Input is sent
   * unreliably; repeating the tail is far cheaper than a retransmit, which would
   * arrive a round trip after the moment it mattered.
   */
  redundancy?: number;
  /** Send every Nth fixed step. 1 = one packet per simulation step. */
  sendEveryNSteps?: number;
}

export class ClientPrediction implements PlayerNetDriver {
  readonly predictor: Predictor;
  readonly reconciler: Reconciler;
  readonly commands = new CommandBuilder();
  readonly metrics: PredictionMetrics;

  /** Installed by the transport layer. Null means "predict only". */
  sendCommands: CommandSink | null = null;

  redundancy: number;
  sendEveryNSteps: number;

  /** Bytes the command stream would occupy on the wire so far. */
  bytesSent = 0;
  packetsSent = 0;

  private readonly sim: MovementSim;
  private readonly outgoing: MoveCommand[] = [];
  private stepsSinceSend = 0;

  constructor(sim: MovementSim, options: ClientPredictionOptions = {}) {
    this.sim = sim;
    this.predictor = new Predictor(sim, { historySize: options.historySize ?? 256 });
    this.reconciler = new Reconciler(sim, this.predictor, options);
    this.metrics = this.reconciler.metrics;
    this.redundancy = options.redundancy ?? 8;
    this.sendEveryNSteps = options.sendEveryNSteps ?? 1;
  }

  /** Sequence the next command will carry. */
  get nextSeq(): number { return this.commands.seq; }
  /** Commands predicted but not yet acknowledged by the host. */
  get inFlight(): number { return this.predictor.inFlight; }
  get visualOffset(): Vec3Like { return this.reconciler.visualOffset; }

  /**
   * One fixed simulation step: sample input, quantise, apply locally, queue for
   * the host. The player sees the result of their input this frame regardless of
   * latency — that is the entire point.
   */
  fixedStep(dt: number, yaw: number, pitch: number): MovementOutput {
    const cmd = this.commands.build(dt, yaw, pitch);
    const out = this.predictor.predict(cmd);
    this.metrics.commandsPredicted++;
    if (++this.stepsSinceSend >= this.sendEveryNSteps) {
      this.stepsSinceSend = 0;
      this.flush();
    }
    return out;
  }

  /** Sends the redundant tail of the input buffer. Called for you by `fixedStep`. */
  flush(): void {
    if (!this.sendCommands) return;
    const n = this.predictor.inputs.tail(this.redundancy, this.outgoing);
    if (n === 0) return;
    this.bytesSent += commandBatchBytes(n);
    this.packetsSent++;
    this.sendCommands(this.outgoing, n);
  }

  /** Feeds one authoritative state for the local player to the reconciler. */
  applyAuthoritative(update: AuthoritativeUpdate): ReconcileResult {
    return this.reconciler.apply(update);
  }

  /** Presentation-rate: decays the visible correction and the metric windows. */
  updateVisual(dt: number): void {
    this.reconciler.updateVisual(dt);
  }

  /**
   * Adopts a state as truth with no comparison and restarts the sequence.
   * Use on spawn, respawn and map change — a correction is not the right tool
   * for a teleport, and treating one as the other produces a huge bogus
   * "misprediction" in the metrics.
   */
  resetTo(state: MovementState, seq = -1): void {
    this.reconciler.hardReset(state, seq);
    this.commands.seq = seq + 1;
    this.commands.reset();
    this.stepsSinceSend = 0;
  }

  /** Upstream command bandwidth in bytes/second over the observed window. */
  get upstreamBytesPerSecond(): number {
    return this.metrics.elapsed > 0 ? this.bytesSent / this.metrics.elapsed : 0;
  }

  /** The simulation being predicted. */
  get movement(): MovementSim { return this.sim; }
}
