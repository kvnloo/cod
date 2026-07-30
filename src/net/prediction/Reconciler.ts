/**
 * Server reconciliation.
 *
 * An authoritative state arrives stamped with the last command the host
 * consumed. Everything the client predicted after that command was computed
 * from a position the server may have rejected, so:
 *
 *   1. compare the server state against the prediction for the *same* sequence;
 *   2. inside tolerance — do nothing. This is the common case and touching the
 *      simulation here would inject jitter for no reason;
 *   3. outside tolerance — restore the server state and replay every unacked
 *      command from N+1 forward, in one frame. The simulation ends up where the
 *      server says it would have, with the player's last N ms of input still
 *      applied. Half-measures ("blend the position towards the server") are
 *      worse than useless: every later step is then computed from a position
 *      neither side believes in, and the error never converges.
 *
 * The correction is applied to the simulation immediately and to the *view*
 * gradually. `visualOffset` holds the difference the eye has not yet been shown
 * and decays with a fixed half-life. Correct the error, not the player's eyes.
 *
 * Nothing here knows about the transport, or whether the authority is a peer or
 * a dedicated server.
 */

import * as THREE from 'three';
import type { MoveCommand } from '../../player/MoveCommand';
import {
  copyMovementState, createMovementState, positionError, velocityError,
  type MovementState,
} from '../../player/MovementState';
import type { Predictor } from './Predictor';
import {
  DEFAULT_RECONCILE_OPTIONS, createPredictionMetrics,
  type AuthoritativeUpdate, type MovementSim, type PredictionMetrics,
  type ReconcileOptions, type ReconcileResult,
} from './types';

/** EMA window for the "recent corrections/second" readout, seconds. */
const RATE_WINDOW = 2.0;

export class Reconciler {
  readonly options: ReconcileOptions;
  readonly metrics: PredictionMetrics = createPredictionMetrics();
  /** World-space offset the renderer should add. Decays to zero. */
  readonly visualOffset = new THREE.Vector3();

  /** Sequence of the newest authoritative update applied. */
  lastAppliedSeq = -1;

  private readonly sim: MovementSim;
  private readonly predictor: Predictor;
  private readonly scratch: MovementState = createMovementState();
  private readonly beforePos = new THREE.Vector3();
  private readonly afterPos = new THREE.Vector3();
  private readonly replayList: MoveCommand[] = [];
  /** Corrections observed inside the current EMA bucket. */
  private rateAccum = 0;

  constructor(sim: MovementSim, predictor: Predictor, options: Partial<ReconcileOptions> = {}) {
    this.sim = sim;
    this.predictor = predictor;
    this.options = { ...DEFAULT_RECONCILE_OPTIONS, ...options };
  }

  /**
   * Consumes one authoritative update. Safe to call at any rate, including
   * several times per frame or not at all for many frames.
   */
  apply(update: AuthoritativeUpdate): ReconcileResult {
    const m = this.metrics;
    const o = this.options;

    if (update.seq <= this.lastAppliedSeq) {
      m.staleUpdates++;
      return { outcome: 'stale', positionError: 0, velocityError: 0, replayed: 0, snapped: false, acked: 0 };
    }
    this.lastAppliedSeq = update.seq;
    m.updatesApplied++;

    const predicted = this.predictor.stateAt(update.seq);

    // The rendered position right now — simulation plus whatever correction the
    // eye has not been shown yet. Continuity is measured against this, not
    // against the raw simulation position.
    this.beforePos.set(this.sim.position.x, this.sim.position.y, this.sim.position.z);
    this.beforePos.add(this.visualOffset);

    /* --- no prediction retained: adopt the server wholesale ---------------- */
    if (!predicted) {
      const acked = this.predictor.ackThrough(update.seq);
      this.sim.restore(update.state);
      this.predictor.recordState(update.seq, update.state);
      // Anything still buffered is newer than the server knows about; replay it
      // so recent input is not thrown away.
      const replayed = this.replayFrom(update.seq);
      this.absorbVisualError(true);
      m.resyncs++;
      m.replayedCommands += replayed;
      m.lastReplayDepth = replayed;
      return { outcome: 'resync', positionError: 0, velocityError: 0, replayed, snapped: true, acked };
    }

    const pErr = positionError(predicted, update.state);
    const vErr = velocityError(predicted, update.state);
    m.errorSum += pErr;
    m.lastError = pErr;
    if (pErr > m.errorMax) m.errorMax = pErr;

    const inFlight = this.predictor.inFlight;
    if (inFlight > m.maxInFlight) m.maxInFlight = inFlight;
    m.bufferOverflows = this.predictor.inputs.overflows;

    /* --- prediction was right --------------------------------------------- */
    if (pErr <= o.positionTolerance && vErr <= o.velocityTolerance) {
      // Deliberately does *not* adopt the server state: the prediction is
      // inside tolerance, and restoring would throw away a correct simulation
      // to replace it with an equally correct one at the cost of a replay.
      const acked = this.predictor.ackThrough(update.seq);
      m.lastReplayDepth = 0;
      return { outcome: 'agreed', positionError: pErr, velocityError: vErr, replayed: 0, snapped: false, acked };
    }

    /* --- prediction was wrong: snap and replay ----------------------------- */
    const acked = this.predictor.ackThrough(update.seq);
    this.sim.restore(update.state);
    this.predictor.recordState(update.seq, update.state);
    const replayed = this.replayFrom(update.seq);

    const snapped = pErr > o.hardSnapDistance;
    const applied = this.absorbVisualError(snapped);

    m.corrections++;
    m.correctionSum += pErr;
    if (pErr > m.correctionMax) m.correctionMax = pErr;
    m.appliedSum += applied;
    if (applied > m.appliedMax) m.appliedMax = applied;
    m.replayedCommands += replayed;
    m.lastReplayDepth = replayed;
    this.rateAccum += 1;

    return { outcome: 'corrected', positionError: pErr, velocityError: vErr, replayed, snapped, acked };
  }

  /**
   * Re-runs every retained command after `seq`. Gameplay events are muted: the
   * player already heard those footsteps the first time round.
   */
  private replayFrom(seq: number): number {
    const n = this.predictor.inputs.collectAfter(seq, this.replayList);
    if (n === 0) return 0;
    const limit = Math.min(n, this.options.maxReplay);
    const wasEmitting = this.sim.emitEvents;
    this.sim.emitEvents = false;
    try {
      for (let i = 0; i < limit; i++) this.predictor.replay(this.replayList[i]);
    } finally {
      this.sim.emitEvents = wasEmitting;
    }
    return limit;
  }

  /**
   * Parks the difference between where the view was and where the simulation
   * now is, so the camera keeps moving from where it already was. Returns that
   * distance — the size of the jump the player would have seen unsmoothed.
   */
  private absorbVisualError(snap: boolean): number {
    this.afterPos.set(this.sim.position.x, this.sim.position.y, this.sim.position.z);
    const applied = this.beforePos.distanceTo(this.afterPos);
    if (snap) { this.visualOffset.set(0, 0, 0); return applied; }
    this.visualOffset.copy(this.beforePos).sub(this.afterPos);
    const len = this.visualOffset.length();
    const max = this.options.maxSmoothOffset;
    if (len > max) this.visualOffset.multiplyScalar(max / len);
    else if (len < 1e-6) this.visualOffset.set(0, 0, 0);
    return applied;
  }

  /**
   * Decays the visible correction. Call once per rendered frame with the frame
   * delta — this is presentation, not simulation, so it must run at display
   * rate rather than at the fixed step.
   */
  updateVisual(dt: number): void {
    if (dt > 0) {
      this.metrics.elapsed += dt;
      // EMA of corrections/second over RATE_WINDOW.
      const k = 1 - Math.exp(-dt / RATE_WINDOW);
      const instantaneous = this.rateAccum / dt;
      this.metrics.recentCorrectionsPerSecond
        += (instantaneous - this.metrics.recentCorrectionsPerSecond) * k;
      this.rateAccum = 0;
    }
    if (this.visualOffset.lengthSq() === 0) return;
    // Half-life decay: frame-rate independent, and unlike a spring it can never
    // overshoot and push the view past the corrected position.
    const decay = Math.pow(0.5, dt / this.options.smoothHalfLife);
    this.visualOffset.multiplyScalar(decay);
    if (this.visualOffset.lengthSq() < 1e-10) this.visualOffset.set(0, 0, 0);
  }

  /** Adopts a state as truth with no comparison — spawn, respawn, teleport. */
  hardReset(state: MovementState, seq: number): void {
    copyMovementState(this.scratch, state);
    this.sim.restore(this.scratch);
    this.predictor.reset(seq + 1);
    this.predictor.recordState(seq, this.scratch);
    this.lastAppliedSeq = seq;
    this.visualOffset.set(0, 0, 0);
  }

  reset(): void {
    this.lastAppliedSeq = -1;
    this.visualOffset.set(0, 0, 0);
    this.rateAccum = 0;
  }
}
