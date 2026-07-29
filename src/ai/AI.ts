/**
 * AISystem — enemy perception, navigation, cover selection and squad behaviour.
 * STUB.
 */

import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';

export class AISystem implements System {
  readonly name = 'ai';
  readonly order = ORDER.AI;
  async init(_ctx: EngineContext): Promise<void> { }
  fixedUpdate(_dt: number, _ctx: EngineContext): void { }
}
