/**
 * HUDSystem — combat HUD, menus, killfeed, scoreboard. DOM + canvas overlay
 * rendered into `#ui-root`. STUB.
 */

import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';

export class HUDSystem implements System {
  readonly name = 'hud';
  readonly order = ORDER.UI;
  root = document.getElementById('ui-root') as HTMLElement;
  async init(_ctx: EngineContext): Promise<void> { }
  update(_dt: number, _ctx: EngineContext): void { }
}
