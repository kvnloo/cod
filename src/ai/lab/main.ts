/**
 * Standalone AI lab.
 *
 * Boots the engine with only the systems this module actually depends on —
 * physics and the AI itself — plus a bare `WebGLRenderer`, and runs the `ai`
 * debug scene. That keeps AI verification working while the render, material,
 * weapon and world modules are being rewritten around it: a screenshot of enemy
 * behaviour should not be blocked on somebody else's shader.
 *
 *   npx vite build src/ai/lab --outDir ../../../dist-ai-lab
 *   node <script> → drives `window.__AILAB__`
 */

import * as THREE from 'three';
import { Engine, ORDER, type EngineContext, type System } from '../../core/Engine';
import { getDebugScene, allShots } from '../../core/Shots';
import { settings } from '../../core/Settings';
import { PhysicsSystem } from '../../physics/Physics';
import { AISystem } from '../AI';
import type { ShotDef } from '../../core/CaptureAPI';

interface LabAPI {
  ready: boolean;
  shots(): string[];
  shotInfo(name: string): ShotDef | null;
  setShot(name: string): void;
  step(frames: number, dt: number): void;
  snapshot(): unknown;
  gizmos(on: boolean): void;
}

class LabRenderSystem implements System {
  readonly name = 'render';
  readonly order = ORDER.RENDER;
  readonly renderer: THREE.WebGLRenderer;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  render(ctx: EngineContext): void {
    this.renderer.render(ctx.scene, ctx.camera);
  }
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  settings.setPreset('ultra', false);

  const engine = new Engine(canvas);
  engine.add(new LabRenderSystem(canvas));
  engine.add(new PhysicsSystem());
  engine.add(new AISystem());
  await engine.init();

  const scene = engine.scene;
  scene.background = new THREE.Color(0x8aa7c4);
  scene.fog = new THREE.FogExp2(0x93b4d6, 0.006);

  const ctx: EngineContext = {
    engine, scene, camera: engine.camera, time: engine.time,
  };
  const build = getDebugScene('ai');
  if (build) await build(ctx);

  const applyShot = (shot: ShotDef): void => {
    engine.camera.position.set(shot.position[0], shot.position[1], shot.position[2]);
    engine.camera.rotation.order = 'YXZ';
    engine.camera.rotation.y = THREE.MathUtils.degToRad(shot.yaw);
    engine.camera.rotation.x = THREE.MathUtils.degToRad(shot.pitch);
    engine.camera.rotation.z = 0;
    engine.camera.fov = shot.fov ?? 60;
    engine.camera.updateProjectionMatrix();
  };

  const api: LabAPI = {
    ready: false,
    shots: () => allShots().map((s) => s.name),
    shotInfo: (name) => allShots().find((s) => s.name === name) ?? null,
    setShot: (name) => {
      const shot = allShots().find((s) => s.name === name);
      if (!shot) throw new Error(`unknown shot ${name}`);
      // Same order as the real capture controller: place the camera, then let
      // the shot's setup run (which may re-aim the camera at the action).
      applyShot(shot);
      void shot.setup?.();
      // Present once so the frame reflects the setup.
      for (const s of engine.systems) s.update?.(1 / 60, ctx);
      for (const s of engine.systems) s.lateUpdate?.(1 / 60, ctx);
      for (const s of engine.systems) s.render?.(ctx);
    },
    step: (frames, dt) => {
      for (let i = 0; i < frames; i++) engine.stepFrame(dt);
    },
    snapshot: () => engine.get<AISystem>('ai').snapshot(),
    gizmos: (on) => {
      const ai = engine.get<AISystem>('ai');
      ai.debugGizmos = on;
      ai.gizmos.visible = on;
    },
  };

  engine.resize();
  window.addEventListener('resize', () => engine.resize());
  (window as unknown as { __AILAB__: LabAPI }).__AILAB__ = api;
  api.ready = true;
}

boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;color:#f66;background:#111;padding:20px;font:12px monospace;z-index:9';
  el.textContent = String((err as Error)?.stack ?? err);
  document.body.appendChild(el);
});
