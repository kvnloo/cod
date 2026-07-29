/**
 * GameDirector — modes, objectives, wave pacing, scoring, killstreaks. STUB.
 */

import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';

export class GameDirector implements System {
  readonly name = 'director';
  readonly order = ORDER.GAMEPLAY;
  async init(_ctx: EngineContext): Promise<void> { }
  fixedUpdate(_dt: number, _ctx: EngineContext): void { }
}
