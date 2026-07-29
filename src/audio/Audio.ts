/**
 * AudioSystem — procedurally synthesised 3D audio: weapons, impacts, footsteps,
 * reverb zones, occlusion, tinnitus. Driven by EventBus. STUB.
 */

import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';

export class AudioSystem implements System {
  readonly name = 'audio';
  readonly order = ORDER.AUDIO;
  async init(_ctx: EngineContext): Promise<void> { }
  update(_dt: number, _ctx: EngineContext): void { }
}
