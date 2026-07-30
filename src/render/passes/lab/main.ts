/**
 * Standalone entry for the post-processing lab.
 *
 * Dev-server only (`/src/render/passes/lab/index.html`) — it is never part of the
 * production bundle. It exists so this module can be rendered and screenshotted
 * on a real GPU independently of `RenderSystem`'s own frame graph, which is
 * owned by another module and may be mid-rewrite.
 *
 * Exposes `window.__POSTLAB__` with the same shape the capture harness expects.
 */

import * as THREE from 'three';
import { settings, type QualityPreset } from '../../../core/Settings';
import { allShots } from '../../../core/Shots';
import type { ShotDef } from '../../../core/CaptureAPI';
import { rng } from '../../../core/Rand';
import { LabFrameGraph, PostLab } from '../PostLab';
import { getPass } from '../index';
import type { DofPass } from '../DofPass';

interface LabApi {
  ready: boolean;
  shots(): string[];
  shotInfo(name: string): ShotDef | null;
  setShot(name: string, settle?: number): Promise<void>;
  step(frames: number, dt: number): void;
  setQuality(preset: string): void;
  setPass(name: string, enabled: boolean): void;
  stats(): { drawCalls: number; triangles: number; programs: number; frameMs: number };
}

declare global {
  // eslint-disable-next-line no-var
  var __POSTLAB__: LabApi | undefined;
}

const params = new URLSearchParams(location.search);
const quality = params.get('quality');
if (quality) settings.setPreset(quality as QualityPreset, false);

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
renderer.setPixelRatio(1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 900);
camera.rotation.order = 'YXZ';

const lab = new PostLab();
lab.build(scene);
const graph = new LabFrameGraph(renderer);

function resize(): void {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener('resize', resize);

let lastFrameMs = 0;

function step(dt: number): void {
  const t0 = performance.now();
  renderer.info.reset();
  graph.render(scene, camera, lab, dt);
  lastFrameMs = performance.now() - t0;
}

const api: LabApi = {
  ready: false,
  shots: () => allShots().map((s) => s.name),
  shotInfo: (n) => allShots().find((s) => s.name === n) ?? null,
  setShot: async (name, settle = 32) => {
    const shot = allShots().find((s) => s.name === name);
    if (!shot) throw new Error(`unknown shot "${name}"`);
    rng.seed(name);
    camera.position.set(...shot.position);
    camera.rotation.set(
      THREE.MathUtils.degToRad(shot.pitch),
      THREE.MathUtils.degToRad(shot.yaw),
      0,
      'YXZ',
    );
    camera.fov = shot.fov ?? 75;
    camera.updateProjectionMatrix();
    await shot.setup?.();
    for (let i = 0; i < settle; i++) step(1 / 60);
  },
  step: (frames, dt) => { for (let i = 0; i < frames; i++) step(dt); },
  setQuality: (preset) => { settings.setPreset(preset as QualityPreset); },
  setPass: (name, enabled) => {
    const p = graph.passList.find((x) => x.name === name);
    if (p) p.enabled = enabled;
  },
  stats: () => ({
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? 0,
    frameMs: lastFrameMs,
  }),
};

// The lab's shots drive focus through the debug-scene system, which is not in
// play here; wire the DoF focus directly instead.
const dof = getPass<DofPass>('dof');
if (dof) dof.hipStrength = 0.35;

globalThis.__POSTLAB__ = api;

// Warm up: compile shaders and settle every temporal history.
for (let i = 0; i < 16; i++) step(1 / 60);
api.ready = true;

if (params.get('capture') !== '1') {
  let last = performance.now();
  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
  };
  requestAnimationFrame(loop);
}
