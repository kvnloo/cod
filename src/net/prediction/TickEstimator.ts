/**
 * The client's copy of the host tick clock.
 *
 * A predicting client must stamp each command with the host tick it expects the
 * host to be simulating when the command lands: too early and the command waits
 * in the host's buffer (added input lag); too late and the host has already
 * simulated that tick, drops the command, and runs *something else* in its
 * place — which the client, by definition, did not predict.
 *
 * The tempting shortcut is to stamp `lastSnapshotTick + k`. It works on a clean
 * link and falls apart on a real one: the newest received snapshot tick is a
 * step function sampled through jitter and loss, so the estimate stalls and then
 * jumps. A stalled estimate stamps two commands onto one tick (the host executes
 * the first and drops the second, but the client predicted both), and a jump
 * leaves ticks with no command at all (the host repeats or extrapolates, which
 * the client also did not predict). Every one of those is a misprediction the
 * player pays for, and none of them is a physics disagreement — the measured
 * effect in `tools/net-prediction-e2e.mjs` was corrections climbing from 0/s to
 * ~19/s the moment jitter was switched on, with the movement code identical on
 * both sides.
 *
 * So: run a local tick clock at the host's rate, advance it by real time, and
 * *slew* it — never jump it — toward the observed target. The client then
 * produces exactly one command per tick, consecutively, forever, and only the
 * rate of that stream varies, by a few percent, invisibly.
 *
 *   const clock = new TickEstimator({ tickRate: 64 });
 *   clock.observe(snapshot.tick, rttSeconds);      // whenever a snapshot lands
 *   for (let i = clock.step(dt); i > 0; i--) {
 *     const tick = clock.next();
 *     predictor.predict(buildCommand());
 *     send(toHostInput(cmd, tick));
 *   }
 */

export interface TickEstimatorOptions {
  /** Host ticks per second. Must match the authority. */
  tickRate: number;
  /**
   * Safety margin in ticks on top of the one-way trip, absorbing jitter. Two to
   * three ticks is the usual trade: each one is ~15 ms of extra input lag at
   * 64 Hz, and buys protection against one more late packet.
   */
  leadTicks?: number;
  /** Largest rate deviation while catching up, as a fraction. 0.15 = +/-15%. */
  maxSlew?: number;
  /** How hard drift pulls the rate. Ticks of drift -> fraction of rate. */
  slewGain?: number;
  /** Drift beyond which slewing is hopeless and the clock is re-seeded. */
  resyncTicks?: number;
  /** Most ticks emitted from a single `step()` — a frame hitch must not flood. */
  maxTicksPerStep?: number;
}

export class TickEstimator {
  readonly tickRate: number;
  readonly dt: number;
  readonly leadTicks: number;
  readonly maxSlew: number;
  readonly slewGain: number;
  readonly resyncTicks: number;
  readonly maxTicksPerStep: number;

  /** Last tick stamped. -1 until the first observation seeds the clock. */
  tick = -1;
  /** Where the clock wants to be, in ticks, fractional. */
  target = 0;
  /** Times the drift was too large to slew away and the clock jumped. */
  resyncs = 0;
  /** Ticks emitted since construction. */
  emitted = 0;

  private accum = 0;
  private seeded = false;
  private lastRate = 1;

  constructor(opts: TickEstimatorOptions) {
    this.tickRate = opts.tickRate;
    this.dt = 1 / opts.tickRate;
    this.leadTicks = opts.leadTicks ?? 2;
    this.maxSlew = opts.maxSlew ?? 0.15;
    this.slewGain = opts.slewGain ?? 0.08;
    this.resyncTicks = opts.resyncTicks ?? 20;
    this.maxTicksPerStep = opts.maxTicksPerStep ?? 4;
  }

  /**
   * Fold in a host tick observation — the tick of a snapshot that just arrived,
   * with the round trip time it took to get here.
   *
   * The host was at `hostTick` one half-trip ago, so it is at roughly
   * `hostTick + rtt/2` now, and a command sent now lands another half-trip
   * later. Hence a full RTT of lead, plus the jitter margin.
   */
  observe(hostTick: number, rttSeconds: number): void {
    const tripTicks = Math.max(0, rttSeconds) / this.dt;
    this.target = hostTick + tripTicks + this.leadTicks;
    if (!this.seeded) {
      this.tick = Math.max(0, Math.round(this.target)) - 1;
      this.accum = 0;
      this.seeded = true;
      return;
    }
    if (Math.abs(this.target - this.tick) > this.resyncTicks) {
      // A stall, a host migration or a tab that was backgrounded. Slewing out a
      // second of drift would take a minute; jump, and let the reconciler eat
      // the one correction that costs.
      this.tick = Math.max(this.tick, Math.round(this.target) - 1);
      this.accum = 0;
      this.resyncs++;
    }
  }

  /**
   * Advance real time. Returns how many ticks to simulate and send now — 1 in
   * the steady state, 0 or 2 while correcting drift or on an irregular frame.
   */
  step(dtSeconds: number): number {
    if (!this.seeded) return 0;
    const drift = this.target - (this.tick + 1);
    const rate = clamp(1 + drift * this.slewGain, 1 - this.maxSlew, 1 + this.maxSlew);
    this.lastRate = rate;
    this.accum += dtSeconds * rate;
    let n = 0;
    while (this.accum >= this.dt && n < this.maxTicksPerStep) {
      this.accum -= this.dt;
      n++;
    }
    if (n >= this.maxTicksPerStep) this.accum = 0; // Drop the backlog, do not spiral.
    return n;
  }

  /** The next tick to stamp. Strictly consecutive: never repeats, never skips. */
  next(): number {
    this.tick++;
    this.emitted++;
    return this.tick;
  }

  /** Ticks the clock currently sits ahead of the observed host tick. */
  get lead(): number {
    return this.tick - (this.target - this.leadTicks);
  }

  /** Current rate multiplier, for diagnostics. 1.0 means "not correcting". */
  get rate(): number {
    return this.lastRate;
  }

  reset(): void {
    this.tick = -1;
    this.target = 0;
    this.accum = 0;
    this.seeded = false;
    this.emitted = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
