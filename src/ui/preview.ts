/**
 * UI test-bed entry point — `vite dev` only, never bundled into the game.
 *
 * Boots the smallest engine that can produce a real lit frame (render +
 * materials + physics + world) plus the HUD, and arms the same capture contract
 * the main build uses. That lets the UI module be iterated on and screenshotted
 * on its own, independently of whichever gameplay system happens to be mid-edit
 * in the shared bundle.
 *
 * Open `/src/ui/preview.html?capture=1&debug=ui` and drive it through
 * `window.__BLACKOUT__` exactly as with the real game.
 */

import { Engine } from '../core/Engine';
import { input } from '../core/Input';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { CAPTURE_MODE, CaptureController } from '../core/Capture';
import { DEBUG_SCENE, allShots, getDebugScene } from '../core/Shots';

import { RenderSystem } from '../render/Renderer';
import { PhysicsSystem } from '../physics/Physics';
import { MaterialSystem } from '../material/MaterialLibrary';
import { WorldSystem } from '../world/World';
import { HUDSystem } from './HUD';

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);

  settings.load();
  const forced = params.get('quality');
  if (forced) settings.setPreset(forced as never, false);

  const engine = new Engine(canvas);
  engine.add(new RenderSystem());
  engine.add(new PhysicsSystem());
  engine.add(new MaterialSystem());
  engine.add(new WorldSystem());
  engine.add(new HUDSystem());

  await engine.init();

  const render = engine.get<RenderSystem>('render');
  await render.renderer.compileAsync(engine.scene, engine.camera);

  if (DEBUG_SCENE) {
    const build = getDebugScene(DEBUG_SCENE);
    if (build) await build({ engine, scene: engine.scene, camera: engine.camera, time: engine.time });
    else console.warn(`[preview] unknown debug scene "${DEBUG_SCENE}"`);
  }

  const capture = new CaptureController(engine);
  const world = engine.tryGet<WorldSystem>('world');
  capture.registerShots([...(world?.captureShots() ?? []), ...allShots()]);
  capture.install(CAPTURE_MODE);

  input.attach(canvas);
  window.addEventListener('resize', () => engine.resize());
  if (!CAPTURE_MODE) {
    canvas.addEventListener('click', () => input.requestLock());
    engine.start();
  }

  capture.markReady();
  bus.emit('game:ready', undefined);
  (window as unknown as { engine: Engine }).engine = engine;
}

boot().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;padding:40px;background:#07090d;color:#ff8f7a;'
    + 'font:12px/1.6 monospace;white-space:pre-wrap;overflow:auto;z-index:999';
  pre.textContent = String((err as Error)?.stack ?? err);
  document.body.appendChild(pre);
});
