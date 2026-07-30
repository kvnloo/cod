/**
 * Character module test-bed entry point.
 *
 * `main.ts` does not know about this module yet (registering it there is an
 * integration step the orchestrator owns), so this file boots a minimal engine
 * — renderer, material library, characters — arms the same capture API the
 * harness drives, and runs the `characters` debug scene. Dev-only: `vite build`
 * never sees it, because only the root `index.html` is an entry point.
 *
 *   npx vite --port 4213
 *   → http://127.0.0.1:4213/src/characters/dev/index.html?debug=characters
 */

import { Engine } from '../../core/Engine';
import { settings, autoDetectPreset } from '../../core/Settings';
import { bus } from '../../core/EventBus';
import { CAPTURE_MODE, CaptureController } from '../../core/Capture';
import { DEBUG_SCENE, allShots, getDebugScene } from '../../core/Shots';
import { RenderSystem } from '../../render/Renderer';
import { MaterialSystem } from '../../material/MaterialLibrary';
import { CharacterSystem } from '../CharacterSystem';

function fatal(err: unknown): void {
  console.error(err);
  const box = document.getElementById('fatal');
  const txt = document.getElementById('fatal-text');
  if (box && txt) {
    txt.textContent = String((err as Error)?.stack ?? err);
    box.classList.add('show');
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);

  const forced = params.get('quality');
  if (forced) settings.setPreset(forced as never, false);

  const engine = new Engine(canvas);
  engine.add(new RenderSystem());
  engine.add(new MaterialSystem());
  engine.add(new CharacterSystem());
  await engine.init();

  if (!forced) {
    const render = engine.get<RenderSystem>('render');
    const gl = render.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    settings.setPreset(autoDetectPreset(name, window.innerWidth * window.innerHeight));
    engine.resize();
  }

  const scene = DEBUG_SCENE ?? 'characters';
  const build = getDebugScene(scene);
  if (build) {
    await build({ engine, scene: engine.scene, camera: engine.camera, time: engine.time });
  } else {
    console.warn(`[chardev] unknown debug scene "${scene}"`);
  }

  const render = engine.get<RenderSystem>('render');
  await render.renderer.compileAsync(engine.scene, engine.camera);

  const capture = new CaptureController(engine);
  capture.registerShots(allShots());
  capture.install(CAPTURE_MODE);
  window.addEventListener('resize', () => engine.resize());
  if (!CAPTURE_MODE) engine.start();

  capture.markReady();
  bus.emit('game:ready', undefined);
  (window as unknown as { engine: Engine }).engine = engine;
}

boot().catch(fatal);
