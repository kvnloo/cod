/**
 * Common widget contract.
 *
 * A widget owns its own bus subscriptions and its own animation state. The HUD
 * system only ticks and draws it; nothing is passed between widgets except the
 * shared read-only `HudModel`.
 */

import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';

export interface Widget {
  readonly name: string;
  /** Simulation of the widget's animation state. Runs every frame. */
  update(dt: number, m: HudModel): void;
  /** Presentation. Must not mutate model state. */
  draw(d: DrawCtx, m: HudModel): void;
  /** Called when the overlay is resized; optional. */
  resize?(w: number, h: number, dpr: number): void;
  dispose?(): void;
}
