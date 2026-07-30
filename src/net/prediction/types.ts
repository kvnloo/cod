/**
 * Contracts for client-side prediction and server reconciliation.
 *
 * Deliberately free of any transport type. Prediction does not care whether the
 * authority is a peer over a WebRTC DataChannel, a headless Node host or a
 * dedicated server — it only needs "here is the state you should have had at
 * sequence N". Whoever owns the wire calls `applyAuthoritative` and provides a
 * `CommandSink`; nothing here has to change when the host moves off a peer.
 */

import type { MoveCommand } from '../../player/MoveCommand';
import type { MovementState } from '../../player/MovementState';
import type { MovementOutput } from '../../player/Movement';

/**
 * The subset of `Movement` that prediction drives. Structural, so a test double
 * or a future non-player controller can stand in without inheriting.
 */
export interface MovementSim {
  /** Deterministic advance by exactly one command. */
  stepCommand(cmd: MoveCommand): MovementOutput;
  capture(out: MovementState): MovementState;
  restore(state: MovementState): void;
  /** Muted while replaying so already-heard footsteps do not fire twice. */
  emitEvents: boolean;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * What the authority reports back about the client's own player.
 *
 * `seq` is the last command the host consumed. The state is the result *after*
 * executing it — so the client compares against its own prediction for the same
 * sequence and replays everything after it.
 */
export interface AuthoritativeUpdate {
  seq: number;
  tick: number;
  state: MovementState;
  /** Optional: host clock in seconds, for RTT and clock-offset estimation. */
  hostTime?: number;
}

export interface ReconcileOptions {
  /** Below this, the prediction is treated as right and nothing is touched. */
  positionTolerance: number;
  /** Velocity disagreement that forces a correction even when position agrees. */
  velocityTolerance: number;
  /** Above this the error is a teleport/respawn: snap the view too. */
  hardSnapDistance: number;
  /** Largest visual offset the smoother will ever hold, metres. */
  maxSmoothOffset: number;
  /** Time for the visible correction to halve, seconds. */
  smoothHalfLife: number;
  /** Safety valve on replay depth; beyond it we accept the server blindly. */
  maxReplay: number;
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = {
  // ~1.5 cm. Below a pixel at typical FPS distances, and comfortably above the
  // last-bit noise from Math.exp/sin differing between JS engines.
  positionTolerance: 0.015,
  velocityTolerance: 0.12,
  hardSnapDistance: 2.0,
  maxSmoothOffset: 0.75,
  smoothHalfLife: 0.06,
  maxReplay: 256,
};

export type ReconcileOutcome =
  /** Prediction matched inside tolerance; nothing was replayed. */
  | 'agreed'
  /** Predicted state was wrong: restored and replayed unacked input. */
  | 'corrected'
  /** No prediction retained for that sequence: adopted the server state whole. */
  | 'resync'
  /** Update was older than one already applied. */
  | 'stale';

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  /** Distance between the predicted and authoritative position, metres. */
  positionError: number;
  velocityError: number;
  /** Commands re-simulated in this frame. */
  replayed: number;
  /** True when the error was big enough that the view snapped as well. */
  snapped: boolean;
  /** Commands the acknowledgement retired from the input buffer. */
  acked: number;
}

/**
 * Misprediction telemetry. Prediction quality is not a matter of opinion — if
 * corrections/second climbs, something diverged and this says so.
 */
export interface PredictionMetrics {
  /** Simulated seconds observed (fed by `updateVisual`). */
  elapsed: number;
  commandsPredicted: number;
  updatesApplied: number;
  corrections: number;
  resyncs: number;
  staleUpdates: number;
  replayedCommands: number;

  /** Sum/max of the error at every applied update, corrected or not. */
  errorSum: number;
  errorMax: number;
  /** Sum/max restricted to updates that actually forced a correction. */
  correctionSum: number;
  correctionMax: number;
  lastError: number;

  /**
   * How far the simulation actually moved when a correction was applied —
   * the snap *plus* the replay, which is what the player would have seen.
   *
   * This is usually much larger than `correctionSum`: a 3 cm disagreement in
   * velocity at the acked sequence becomes tens of centimetres once it is
   * replayed through a round trip of input. `correctionSum` says how wrong the
   * prediction was; this says how visible fixing it would have been without
   * smoothing.
   */
  appliedSum: number;
  appliedMax: number;

  /** Exponential moving average of corrections per second (~2 s window). */
  recentCorrectionsPerSecond: number;
  /** Unacked commands in flight at the last update — the replay depth. */
  lastReplayDepth: number;
  /** Highest number of unacked commands seen. */
  maxInFlight: number;
  /** Commands dropped because the input buffer wrapped before an ack. */
  bufferOverflows: number;
}

export function createPredictionMetrics(): PredictionMetrics {
  return {
    elapsed: 0,
    commandsPredicted: 0,
    updatesApplied: 0,
    corrections: 0,
    resyncs: 0,
    staleUpdates: 0,
    replayedCommands: 0,
    errorSum: 0,
    errorMax: 0,
    correctionSum: 0,
    correctionMax: 0,
    lastError: 0,
    appliedSum: 0,
    appliedMax: 0,
    recentCorrectionsPerSecond: 0,
    lastReplayDepth: 0,
    maxInFlight: 0,
    bufferOverflows: 0,
  };
}

export function resetPredictionMetrics(m: PredictionMetrics): void {
  const fresh = createPredictionMetrics();
  Object.assign(m, fresh);
}

/** Corrections per second over the whole observation window. */
export function correctionsPerSecond(m: PredictionMetrics): number {
  return m.elapsed > 0 ? m.corrections / m.elapsed : 0;
}

/** Mean magnitude of the corrections that were actually applied, metres. */
export function meanCorrectionMeters(m: PredictionMetrics): number {
  return m.corrections > 0 ? m.correctionSum / m.corrections : 0;
}

/** Mean prediction error across every authoritative update, metres. */
export function meanErrorMeters(m: PredictionMetrics): number {
  return m.updatesApplied > 0 ? m.errorSum / m.updatesApplied : 0;
}

/**
 * Mean distance the simulation actually jumped per correction, metres — snap
 * plus replay. This is the number that decides whether corrections are visible.
 */
export function meanAppliedCorrectionMeters(m: PredictionMetrics): number {
  return m.corrections > 0 ? m.appliedSum / m.corrections : 0;
}

/** Mean number of commands re-simulated per authoritative update. */
export function meanReplayDepth(m: PredictionMetrics): number {
  return m.updatesApplied > 0 ? m.replayedCommands / m.updatesApplied : 0;
}

/** One-line summary for a HUD or a test log. */
export function formatPredictionMetrics(m: PredictionMetrics): string {
  return [
    `corr/s ${correctionsPerSecond(m).toFixed(2)}`,
    `meanCorr ${(meanCorrectionMeters(m) * 100).toFixed(2)}cm`,
    `meanApplied ${(meanAppliedCorrectionMeters(m) * 100).toFixed(2)}cm`,
    `maxApplied ${(m.appliedMax * 100).toFixed(2)}cm`,
    `meanErr ${(meanErrorMeters(m) * 1000).toFixed(3)}mm`,
    `replay ${meanReplayDepth(m).toFixed(1)}`,
    `inflight ${m.maxInFlight}`,
  ].join('  ');
}

/**
 * Where finished command batches go. Supplied by the transport layer; the tail
 * of the buffer is resent every packet so a lost datagram costs nothing.
 */
export type CommandSink = (commands: readonly MoveCommand[], count: number) => void;
