/**
 * Thin engine adapter: drives an `Interpolator` from the frame loop and hands
 * the resulting transforms to whoever owns the visual representation.
 *
 * Deliberately tiny and deliberately dumb. It knows nothing about meshes,
 * characters, ragdolls or the scene graph — the module that owns a remote
 * entity's visual registers an `applyTransform` callback and copies whatever it
 * needs. That keeps this file free of any dependency on `src/characters`,
 * `src/fx` or `src/render`, all of which are owned by other people.
 *
 * It also imports NOTHING from `src/core` at runtime (`import type` only), so
 * the whole interpolation module remains testable in a bare Node process.
 *
 * Wiring, from the netcode transport:
 *
 *     const clock  = new NetClock();
 *     const interp = new Interpolator();
 *     interp.attachTimeSource(clock);
 *     engine.add(new InterpolationSystem(interp, clock));
 *     // on snapshot receive:  interp.push(snapshot, clock.serverNowMs())
 *     // on pong receive:      driver.accept(seq, t1, t2, performance.now())
 *     // every frame (transport): clock.update(performance.now())
 */

import type { EngineContext, System } from '../../core/Engine';
import type { InterpTransform, TimeSource } from './types';
import type { Interpolator } from './Interpolator';

/**
 * Runs after gameplay (ORDER.GAMEPLAY = 500) and before world/FX/audio/camera
 * (600/700/800/900) so every downstream presentation system sees this frame's
 * remote transforms. Not imported from `ORDER` on purpose: that would pull
 * `three` into the headless test process for one integer.
 */
export const INTERPOLATION_ORDER = 550;

export type TransformVisitor = (t: InterpTransform) => void;

export class InterpolationSystem implements System {
  readonly name = 'net.interp';
  readonly order: number;
  enabled = true;

  readonly interpolator: Interpolator;
  private readonly time: TimeSource;
  private readonly visitors = new Set<TransformVisitor>();

  constructor(
    interpolator: Interpolator,
    time: TimeSource,
    order: number = INTERPOLATION_ORDER,
  ) {
    this.interpolator = interpolator;
    this.time = time;
    this.order = order;
  }

  /**
   * Register a per-entity callback invoked once per frame for every visible
   * remote entity. Returns an unsubscribe function.
   */
  onTransform(fn: TransformVisitor): () => void {
    this.visitors.add(fn);
    return () => { this.visitors.delete(fn); };
  }

  /**
   * Presentation, not simulation — this belongs in `update`, never in
   * `fixedUpdate`. Interpolating on the fixed step would quantise remote motion
   * to the sim rate and throw away the whole point of a variable-rate playout
   * clock.
   */
  update(_dt: number, _ctx: EngineContext): void {
    this.interpolator.update(this.time.serverNowMs());
    if (this.visitors.size === 0) return;
    for (const t of this.interpolator.transforms.values()) {
      for (const fn of this.visitors) fn(t);
    }
  }

  dispose(): void {
    this.visitors.clear();
  }
}
