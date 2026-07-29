/**
 * Bootstrap. Builds the engine, registers every system in dependency order,
 * arms the capture API and starts the loop.
 */

import { Engine } from './core/Engine';
import { input } from './core/Input';
import { settings, autoDetectPreset } from './core/Settings';
import { bus } from './core/EventBus';
import { CAPTURE_MODE, CaptureController } from './core/Capture';

import { RenderSystem } from './render/Renderer';
import { PhysicsSystem } from './physics/Physics';
import { MaterialSystem } from './material/MaterialLibrary';
import { WorldSystem } from './world/World';
import { PlayerSystem } from './player/Player';
import { WeaponSystem } from './weapons/Weapons';
import { AISystem } from './ai/AI';
import { FXSystem } from './fx/FX';
import { AudioSystem } from './audio/Audio';
import { HUDSystem } from './ui/HUD';
import { GameDirector } from './game/GameDirector';

const bootEl = document.getElementById('boot')!;
const bootFill = document.getElementById('boot-fill') as HTMLElement;
const bootStatus = document.getElementById('boot-status') as HTMLElement;

function progress(pct: number, label: string): void {
  bootFill.style.width = `${Math.round(pct * 100)}%`;
  bootStatus.textContent = label;
}

function fatal(err: unknown): void {
  console.error(err);
  const box = document.getElementById('fatal')!;
  const txt = document.getElementById('fatal-text')!;
  txt.textContent = String((err as Error)?.stack ?? err);
  box.classList.add('show');
  bootEl.classList.add('done');
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const params = new URLSearchParams(location.search);

  settings.load();
  const forced = params.get('quality');
  if (forced) settings.setPreset(forced as never, false);

  progress(0.05, 'Creating context');
  const engine = new Engine(canvas);

  // Registration order does not matter — Engine sorts by `System.order` — but
  // grouping by concern keeps the dependency story readable.
  engine.add(new RenderSystem());
  engine.add(new PhysicsSystem());
  engine.add(new MaterialSystem());
  engine.add(new WorldSystem());
  engine.add(new PlayerSystem());
  engine.add(new WeaponSystem());
  engine.add(new AISystem());
  engine.add(new FXSystem());
  engine.add(new AudioSystem());
  engine.add(new HUDSystem());
  engine.add(new GameDirector());

  progress(0.2, 'Booting systems');
  await engine.init();

  // Auto quality once we know the GPU, unless the URL pinned a preset.
  if (!forced) {
    const render = engine.get<RenderSystem>('render');
    const gl = render.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const preset = autoDetectPreset(name, window.innerWidth * window.innerHeight);
    console.info(`[boot] GPU "${name}" → preset "${preset}"`);
    settings.setPreset(preset);
    engine.resize();
  }

  progress(0.75, 'Compiling shaders');
  const render = engine.get<RenderSystem>('render');
  await render.renderer.compileAsync(engine.scene, engine.camera);

  progress(0.9, 'Arming capture');
  const capture = new CaptureController(engine);
  const world = engine.get<WorldSystem>('world');
  capture.registerShots(world.captureShots());
  capture.install(CAPTURE_MODE);

  input.attach(canvas);
  window.addEventListener('resize', () => engine.resize());
  if (!CAPTURE_MODE) {
    canvas.addEventListener('click', () => input.requestLock());
    engine.start();
  }

  progress(1, 'Ready');
  if (CAPTURE_MODE) {
    // No transitions in capture mode — the overlay must not bleed into shots.
    bootEl.remove();
    capture.markReady();
    bus.emit('game:ready', undefined);
  } else {
    requestAnimationFrame(() => {
      bootEl.classList.add('done');
      setTimeout(() => bootEl.remove(), 900);
      capture.markReady();
      bus.emit('game:ready', undefined);
    });
  }

  // Expose for debugging from the console.
  (window as unknown as { engine: Engine }).engine = engine;
}

boot().catch(fatal);
