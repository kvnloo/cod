/**
 * Engine: system registry + frame loop.
 *
 * Ordering per frame:
 *   input.beginFrame
 *   → N × fixedUpdate (physics, movement, AI, ballistics)
 *   → update          (view model, camera, VFX, HUD — variable dt, interpolated)
 *   → lateUpdate      (camera-attached effects, culling, LOD)
 *   → render
 *   → input.endFrame
 *
 * Systems declare an `order`; lower runs first. This is the only global schedule
 * in the codebase, which keeps parallel subsystem work from fighting over the
 * update order.
 */

import * as THREE from 'three';
import { Time } from './Time';
import { bus } from './EventBus';
import { input } from './Input';
import { settings } from './Settings';
import { rng } from './Rand';

export interface EngineContext {
  engine: Engine;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  time: Time;
}

/** Canonical execution slots. Systems pick a constant near their concern. */
export const ORDER = {
  INPUT: 0,
  PHYSICS: 100,
  PLAYER: 200,
  WEAPONS: 300,
  BALLISTICS: 350,
  AI: 400,
  GAMEPLAY: 500,
  WORLD: 600,
  FX: 700,
  AUDIO: 800,
  CAMERA: 900,
  UI: 950,
  RENDER: 1000,
} as const;

export interface System {
  readonly name: string;
  readonly order: number;
  enabled?: boolean;
  init?(ctx: EngineContext): Promise<void> | void;
  /** Fixed timestep — all gameplay simulation belongs here. */
  fixedUpdate?(dt: number, ctx: EngineContext): void;
  /** Variable timestep — presentation, interpolation, effects. */
  update?(dt: number, ctx: EngineContext): void;
  /** After all updates; camera-dependent work. */
  lateUpdate?(dt: number, ctx: EngineContext): void;
  render?(ctx: EngineContext): void;
  resize?(width: number, height: number, pixelRatio: number): void;
  dispose?(): void;
}

export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly time = new Time();
  readonly canvas: HTMLCanvasElement;

  systems: System[] = [];
  private byName = new Map<string, System>();
  private ctx: EngineContext;
  private running = false;
  private rafId = 0;
  private initialised = false;

  /** Rolling frame-time ring buffer for the perf HUD and the capture harness. */
  readonly frameTimes = new Float32Array(240);
  private frameCursor = 0;
  profiling = false;
  profileSamples: number[] = [];
  profileStart = 0;

  /**
   * True while the capture harness owns the camera for a fixed shot. Systems
   * that normally drive the camera (the player rig) must not write to it — but
   * scripted *gameplay* capture clears this so the rig takes over again.
   */
  cameraLockedByCapture = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new THREE.PerspectiveCamera(
      settings.game.fov,
      canvas.clientWidth / Math.max(1, canvas.clientHeight),
      0.02,
      settings.gfx.drawDistance,
    );
    this.camera.rotation.order = 'YXZ';
    this.scene.matrixWorldAutoUpdate = true;
    this.ctx = { engine: this, scene: this.scene, camera: this.camera, time: this.time };
  }

  add<T extends System>(system: T): T {
    if (this.byName.has(system.name)) {
      throw new Error(`[Engine] duplicate system "${system.name}"`);
    }
    this.byName.set(system.name, system);
    this.systems.push(system);
    this.systems.sort((a, b) => a.order - b.order);
    return system;
  }

  get<T extends System>(name: string): T {
    const s = this.byName.get(name);
    if (!s) throw new Error(`[Engine] missing system "${name}"`);
    return s as T;
  }

  tryGet<T extends System>(name: string): T | undefined {
    return this.byName.get(name) as T | undefined;
  }

  async init(): Promise<void> {
    if (this.initialised) return;
    for (const s of this.systems) {
      const t0 = performance.now();
      await s.init?.(this.ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[Engine] ${s.name} init ${ms.toFixed(0)}ms`);
    }
    this.initialised = true;
    this.resize();
    bus.emit('game:ready', undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.time.reset(performance.now() / 1000);
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** One full frame using wall-clock time. */
  frame(): void {
    const t0 = performance.now();
    const steps = this.time.tick(t0 / 1000);
    this.runFrame(steps);
    const dt = performance.now() - t0;
    this.frameTimes[this.frameCursor] = dt;
    this.frameCursor = (this.frameCursor + 1) % this.frameTimes.length;
    if (this.profiling) this.profileSamples.push(dt);
  }

  /** One frame with an explicit delta — used by the deterministic capture path. */
  stepFrame(dt: number): void {
    const steps = this.time.tick(performance.now() / 1000, dt);
    this.runFrame(steps);
  }

  private runFrame(steps: number): void {
    const { ctx, time } = this;
    input.beginFrame();

    // fixedDelta is constant; scale only changes *how many* steps run via
    // Time.tick's scaled accumulator. Multiplying here would sim at scale².
    const fdt = time.fixedDelta;
    for (let i = 0; i < steps; i++) {
      for (const s of this.systems) {
        if (s.enabled === false || !s.fixedUpdate) continue;
        s.fixedUpdate(fdt, ctx);
      }
    }

    const dt = time.delta;
    for (const s of this.systems) {
      if (s.enabled === false || !s.update) continue;
      s.update(dt, ctx);
    }
    for (const s of this.systems) {
      if (s.enabled === false || !s.lateUpdate) continue;
      s.lateUpdate(dt, ctx);
    }
    for (const s of this.systems) {
      if (s.enabled === false || !s.render) continue;
      s.render(ctx);
    }

    // Latch discrete edges across 0-step frames (display > sim rate) so
    // reload/melee/inspect/switch pressed between fixed steps are not dropped.
    input.endFrame(steps > 0);
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, parent?.clientWidth ?? window.innerWidth);
    const h = Math.max(1, parent?.clientHeight ?? window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, settings.gfx.maxPixelRatio);
    this.camera.aspect = w / h;
    this.camera.far = settings.gfx.drawDistance;
    this.camera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(w, h, pr);
  }

  /** Mean FPS over the ring buffer. */
  get fps(): number {
    let sum = 0, n = 0;
    for (let i = 0; i < this.frameTimes.length; i++) {
      const v = this.frameTimes[i];
      if (v > 0) { sum += v; n++; }
    }
    return n ? 1000 / (sum / n) : 0;
  }

  get frameMs(): number {
    let sum = 0, n = 0;
    for (let i = 0; i < this.frameTimes.length; i++) {
      const v = this.frameTimes[i];
      if (v > 0) { sum += v; n++; }
    }
    return n ? sum / n : 0;
  }

  dispose(): void {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.byName.clear();
  }
}

export { bus, input, settings, rng };
