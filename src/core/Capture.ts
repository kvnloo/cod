/**
 * Installs the deterministic capture API on `window.__BLACKOUT__`.
 *
 * In capture mode the engine's rAF loop is suspended and frames are pumped
 * explicitly, so a screenshot is a pure function of (shot, seed, frame count).
 */

import * as THREE from 'three';
import type { Engine } from './Engine';
import { input, type Action } from './Input';
import { settings, type QualityPreset } from './Settings';
import { rng } from './Rand';
import type { BlackoutCaptureAPI, FrameStats, ProfileResult, ShotDef, ShotOptions } from './CaptureAPI';
import type { RenderSystem } from '../render/Renderer';

const VERSION = '1.0.0';

export interface CaptureHooks {
  /** Called before a shot's frames are rendered — lets the level pose actors. */
  onShot?(shot: ShotDef, opts: ShotOptions): void | Promise<void>;
  /** Arbitrary probes exposed to automation. */
  probes?: Record<string, (arg?: unknown) => unknown>;
}

export class CaptureController {
  private shots = new Map<string, ShotDef>();
  private hooks: CaptureHooks = {};
  private profileSamples: number[] = [];
  private profileT0 = 0;
  private profiling = false;

  constructor(private engine: Engine) { }

  registerShots(defs: ShotDef[]): void {
    for (const d of defs) this.shots.set(d.name, d);
  }

  setHooks(h: CaptureHooks): void { this.hooks = { ...this.hooks, ...h }; }

  install(active: boolean): void {
    const engine = this.engine;
    const api: BlackoutCaptureAPI = {
      readyFlag: false,
      version: VERSION,
      listShots: () => [...this.shots.keys()],
      shotInfo: (n) => this.shots.get(n) ?? null,
      setShot: async (name, opts = {}) => {
        const shot = this.shots.get(name);
        if (!shot) throw new Error(`unknown shot "${name}"`);
        // A fixed shot owns the camera; the player rig must not fight it.
        engine.cameraLockedByCapture = true;
        rng.seed(name); // per-shot determinism for particles and scatter

        const cam = engine.camera;
        cam.position.set(...shot.position);
        cam.rotation.set(
          THREE.MathUtils.degToRad(opts.fov !== undefined ? shot.pitch : shot.pitch),
          THREE.MathUtils.degToRad(shot.yaw),
          0,
          'YXZ',
        );
        cam.fov = opts.fov ?? shot.fov ?? settings.game.fov;
        cam.updateProjectionMatrix();

        const render = engine.tryGet<RenderSystem>('render');
        const hour = opts.hour ?? shot.hour;
        if (hour !== undefined) render?.setTimeOfDay(hour);
        if (opts.weather !== undefined) render?.setWeather(opts.weather, opts.weather, 0.4);

        const vm = opts.viewModel ?? shot.viewModel ?? true;
        render && (render.viewModelScene.visible = vm);

        await shot.setup?.();
        await this.hooks.onShot?.(shot, opts);

        // Settle temporal effects (TAA history, volumetrics, light adaptation).
        const settle = opts.settle ?? 24;
        for (let i = 0; i < settle; i++) engine.stepFrame(1 / 60);
      },
      step: async (frames, dt) => {
        for (let i = 0; i < frames; i++) engine.stepFrame(dt);
      },
      setHUD: (on) => {
        const root = document.getElementById('ui-root');
        if (root) root.style.display = on ? '' : 'none';
      },
      setQuality: (preset) => {
        settings.setPreset(preset as QualityPreset);
        engine.resize();
      },
      stats: (): FrameStats => {
        const render = engine.tryGet<RenderSystem>('render');
        const rs = render?.stats() ?? {
          drawCalls: 0, triangles: 0, programs: 0, textures: 0, geometries: 0, gpuMs: 0,
        };
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return {
          fps: engine.fps,
          frameMs: engine.frameMs,
          cpuMs: engine.frameMs,
          gpuMs: rs.gpuMs,
          drawCalls: rs.drawCalls,
          triangles: rs.triangles,
          programs: rs.programs,
          textures: rs.textures,
          geometries: rs.geometries,
          jsHeapMb: mem ? mem.usedJSHeapSize / 1048576 : 0,
        };
      },
      beginProfile: () => {
        this.profileSamples = [];
        this.profiling = true;
        this.profileT0 = performance.now();
        engine.profiling = true;
        engine.profileSamples = [];
        engine.start(); // free-run for real timings
      },
      endProfile: (): ProfileResult => {
        this.profiling = false;
        engine.profiling = false;
        const samples = engine.profileSamples.slice().sort((a, b) => a - b);
        const dur = performance.now() - this.profileT0;
        const at = (p: number) => samples.length
          ? samples[Math.min(samples.length - 1, Math.round((p / 100) * (samples.length - 1)))]
          : 0;
        const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
        const render = engine.tryGet<RenderSystem>('render');
        const rs = render?.stats();
        if (active) engine.stop();
        return {
          frames: samples.length,
          durationMs: dur,
          avgFps: samples.length ? (samples.length / dur) * 1000 : 0,
          meanMs: mean,
          p50: at(50), p95: at(95), p99: at(99),
          worstMs: samples.length ? samples[samples.length - 1] : 0,
          gpuMeanMs: rs?.gpuMs ?? 0,
          drawCalls: rs?.drawCalls ?? 0,
          triangles: rs?.triangles ?? 0,
        };
      },
      probe: (key, arg) => this.hooks.probes?.[key]?.(arg) ?? null,
      act: async (steps) => {
        // Scripted gameplay hands the camera back to the player rig.
        engine.cameraLockedByCapture = false;
        for (const s of steps) {
          const frames = s.frames ?? 1;
          const dt = s.dt ?? 1 / 60;
          if (s.press?.length) input.inject({ press: s.press as Action[] });
          for (let i = 0; i < frames; i++) {
            input.inject({
              hold: (s.hold ?? []) as Action[],
              mouseDX: s.lookX ?? 0,
              mouseDY: s.lookY ?? 0,
              moveX: s.moveX ?? 0,
              moveY: s.moveY ?? 0,
            });
            engine.stepFrame(dt);
          }
          input.inject({ release: (s.hold ?? []) as Action[] });
        }
      },
    };

    globalThis.__BLACKOUT__ = api;

    if (active) {
      input.scripted = true;
      // Render a handful of frames so the first screenshot is fully shaded.
      for (let i = 0; i < 8; i++) engine.stepFrame(1 / 60);
    }
  }

  markReady(): void {
    const api = globalThis.__BLACKOUT__;
    if (api) api.readyFlag = true;
  }
}

export const CAPTURE_MODE = new URLSearchParams(globalThis.location?.search ?? '').get('capture') === '1';
