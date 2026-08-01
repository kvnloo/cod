/**
 * Simulation clock with a fixed-step accumulator and a deterministic mode used by
 * the capture harness.
 *
 * Gameplay (physics, AI, weapon state) runs on `fixedDelta`; rendering and
 * view-model animation run on the variable `delta` with an `alpha` interpolant so
 * motion stays smooth at any refresh rate.
 */

export class Time {
  /** Seconds since engine start (scaled). */
  elapsed = 0;
  /** Unscaled seconds since engine start. */
  elapsedReal = 0;
  /** Variable frame delta, seconds, clamped. */
  delta = 0;
  /** Unscaled frame delta. */
  deltaReal = 0;
  /** Fixed simulation step. */
  fixedDelta = 1 / 120;
  /** Interpolation factor between the last two fixed steps, [0..1). */
  alpha = 0;
  /** Global time scale — slow-mo on kills, 0 while paused. */
  scale = 1;
  /** Number of fixed steps executed in the current frame. */
  steps = 0;
  frame = 0;

  private accumulator = 0;
  private last = 0;
  private maxFrameTime = 0.25;
  /**
   * Hard ceiling on fixed steps per display frame.
   *
   * Two steps ≈ 16.7 ms of sim at 120 Hz — enough to drain hitch debt without
   * manufacturing a second >50 ms death-window frame. Residual debt carries.
   */
  private maxSteps = 2;
  /** Previous unscaled frame dt — used to shrink catch-up after a hitch. */
  private prevDt = 0;

  /** In deterministic mode delta comes from the caller, not the wall clock. */
  deterministic = false;

  reset(now = performance.now() / 1000): void {
    this.last = now;
    this.accumulator = 0;
    this.elapsed = 0;
    this.elapsedReal = 0;
    this.frame = 0;
    this.prevDt = 0;
  }

  /**
   * Advances the clock. Returns the number of fixed steps the caller should run.
   * In deterministic mode pass an explicit `forcedDelta`.
   */
  tick(now: number, forcedDelta?: number): number {
    let dt: number;
    if (forcedDelta !== undefined) {
      dt = forcedDelta;
      this.last = now;
    } else {
      dt = now - this.last;
      this.last = now;
    }
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > this.maxFrameTime) dt = this.maxFrameTime;

    this.deltaReal = dt;
    this.elapsedReal += dt;
    this.delta = dt * this.scale;
    this.elapsed += this.delta;
    this.frame++;

    // After a hitch frame, take a single sim step so catch-up itself cannot own
    // the next wall frame (death-window clusters were 50–60 ms of stacked
    // sim+render+ragdoll). Residual debt carries and is repaid on quiet frames.
    let stepCap = this.maxSteps;
    if (this.prevDt > 0.028 || dt > 0.028) stepCap = 1;
    this.prevDt = dt;

    this.accumulator += this.delta;
    let steps = 0;
    while (this.accumulator >= this.fixedDelta && steps < stepCap) {
      this.accumulator -= this.fixedDelta;
      steps++;
    }
    // Spiral-of-death guard: cap residual debt to one step instead of wiping the
    // accumulator. Zeroing used to drop the remainder of a hitch — and with it
    // any input edge that landed in the discarded window — so a single 50 ms
    // frame could swallow a jump/fire that the player still felt they pressed.
    if (steps >= stepCap) {
      this.accumulator = Math.min(this.accumulator, this.fixedDelta);
    }
    this.alpha = this.accumulator / this.fixedDelta;
    this.steps = steps;
    return steps;
  }
}

/** Frame-rate independent exponential smoothing factor. */
export function damp(lambda: number, dt: number): number {
  return 1 - Math.exp(-lambda * dt);
}

/** Exponentially approaches `target`; `lambda` is the rate in 1/seconds. */
export function dampf(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * damp(lambda, dt);
}

/** Critically-damped spring, the workhorse for weapon sway and camera follow. */
export class SpringScalar {
  value = 0;
  velocity = 0;
  constructor(public frequency = 12, public damping = 1) { }

  step(target: number, dt: number): number {
    // Semi-implicit, stable at large dt.
    const omega = 2 * Math.PI * this.frequency;
    const f = 1 + 2 * dt * this.damping * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    this.value = (f * this.value + dt * this.velocity + hhoo * target) * det;
    this.velocity = (this.velocity + hoo * (target - this.value)) * det;
    return this.value;
  }

  set(v: number): void { this.value = v; this.velocity = 0; }
}
