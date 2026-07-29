/**
 * FXSystem — GPU particles, impacts, tracers, muzzle flashes, explosions, decals.
 * Driven entirely by EventBus messages so it stays decoupled from gameplay.
 * STUB.
 */

import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';

export class FXSystem implements System {
  readonly name = 'fx';
  readonly order = ORDER.FX;
  async init(_ctx: EngineContext): Promise<void> { }
  update(_dt: number, _ctx: EngineContext): void { }
}
