/**
 * Global capture-shot and debug-scene registries.
 *
 * Any module can publish camera shots and standalone debug scenes without
 * touching `main.ts`, which is what lets independently developed subsystems each
 * own their visual verification.
 *
 *   registerShots([{ name: 'weapon-hero', description: '...', position: [...], yaw: 0, pitch: 0 }]);
 *   registerDebugScene('materials', async (ctx) => { ... build a swatch grid ... });
 *
 * Then:  node tools/capture.mjs --debug materials --shots weapon-hero
 */

import type { ShotDef } from './CaptureAPI';
import type { EngineContext } from './Engine';

const shots: ShotDef[] = [];
const debugScenes = new Map<string, (ctx: EngineContext) => void | Promise<void>>();

export function registerShots(defs: ShotDef[]): void {
  for (const d of defs) {
    const i = shots.findIndex((s) => s.name === d.name);
    if (i >= 0) shots[i] = d; else shots.push(d);
  }
}

export function allShots(): ShotDef[] { return shots; }

/**
 * A debug scene owns the whole world for a capture run: it may clear the scene
 * and build whatever it needs (texture swatch grids, weapon turntables, particle
 * test beds). It runs after all systems have initialised.
 */
export function registerDebugScene(
  name: string,
  build: (ctx: EngineContext) => void | Promise<void>,
): void {
  debugScenes.set(name, build);
}

export function getDebugScene(name: string) { return debugScenes.get(name); }
export function debugSceneNames(): string[] { return [...debugScenes.keys()]; }

const params = new URLSearchParams(globalThis.location?.search ?? '');
export const DEBUG_SCENE = params.get('debug');
