/**
 * Deterministic randomness for the authoritative tick.
 *
 * The whole basis of prediction, replay and host migration is that a tick is a
 * pure function of (state, inputs, tick). A long-lived RNG whose internal state
 * drifts would break that the moment a new host resumed from a checkpoint — the
 * checkpoint would have to carry the RNG's 128-bit state and every desync would
 * be silent.
 *
 * So instead the stream is *derived*: `seed` + `tick` + a salt naming the caller.
 * Two hosts that agree on (seed, tick) draw identical numbers, and a checkpoint
 * only has to carry two integers.
 */

import { Rand, hashString } from '../../core/Rand';
import type { RandomStream } from './ports';

/** Salts keep independent concerns from consuming each other's draws. */
export const RNG_SALT = {
  SIM: 'sim',
  SPAWN: 'spawn',
  DAMAGE: 'damage',
  MODE: 'mode',
} as const;

/**
 * Reusable per-tick stream. Re-seeded rather than re-allocated so the host loop
 * does not churn garbage at 30 Hz × N salts.
 */
export class TickRand implements RandomStream {
  private r = new Rand(1);

  constructor(private seed: number) { }

  setSeed(seed: number): void { this.seed = seed; }

  /** Point the stream at (seed, tick, salt). Must be called before any draw. */
  at(tick: number, salt: string): this {
    // Mix tick into the seed with a 32-bit avalanche so adjacent ticks are not
    // correlated (a plain `seed + tick` gives visibly similar first draws).
    let z = (this.seed ^ Math.imul(tick + 1, 0x9e3779b1)) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    this.r.seed((z ^ hashString(salt)) >>> 0);
    return this;
  }

  next(): number { return this.r.next(); }
  range(min: number, max: number): number { return this.r.range(min, max); }
  int(min: number, max: number): number { return this.r.int(min, max); }
  signed(): number { return this.r.signed(); }
  bool(p = 0.5): boolean { return this.r.bool(p); }
}
