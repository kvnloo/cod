/**
 * Fixed-size dynamic light pool.
 *
 * Muzzle flashes, explosions, flares and burning debris all draw from the same
 * fixed budget of point lights that are created once and never added to or
 * removed from the scene — the light *count* must stay constant or three
 * recompiles every shader in the game mid-firefight.
 *
 * Each light is mirrored into the view-model scene (in view space) so the
 * weapon is lit by its own muzzle flash.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import type { DynamicLightRequest } from './types';

export type DecayCurve = NonNullable<DynamicLightRequest['decay']>;

interface Slot {
  world: THREE.PointLight;
  view: THREE.PointLight;
  active: boolean;
  age: number;
  lifetime: number;
  peak: number;
  radius: number;
  curve: DecayCurve;
  seed: number;
  position: THREE.Vector3;
}

const NOISE_SIZE = 512;

export class LightPool {
  private slots: Slot[] = [];
  private scene: THREE.Scene | null = null;
  private viewScene: THREE.Scene | null = null;
  private noise: Float32Array;
  private cursor = 0;
  private tmp = new THREE.Vector3();

  /** Live light count — surfaced for the perf HUD. */
  activeCount = 0;

  constructor(seed = 0x5eed) {
    const rand = new Rand(seed);
    this.noise = new Float32Array(NOISE_SIZE);
    for (let i = 0; i < NOISE_SIZE; i++) this.noise[i] = rand.next();
  }

  init(scene: THREE.Scene, viewScene: THREE.Scene, budget: number): void {
    this.scene = scene;
    this.viewScene = viewScene;
    this.setBudget(budget);
  }

  /** Changing the budget recompiles shaders once — only do it on preset changes. */
  setBudget(budget: number): void {
    const n = THREE.MathUtils.clamp(Math.round(budget), 0, 12);
    if (n === this.slots.length) return;

    for (const s of this.slots) {
      s.world.removeFromParent();
      s.view.removeFromParent();
      s.world.dispose();
      s.view.dispose();
    }
    this.slots.length = 0;

    for (let i = 0; i < n; i++) {
      const world = new THREE.PointLight(0xffffff, 0, 8, 2);
      world.castShadow = false;
      world.name = `dyn:${i}`;
      const view = new THREE.PointLight(0xffffff, 0, 8, 2);
      view.castShadow = false;
      view.name = `dynvm:${i}`;
      this.scene?.add(world);
      this.viewScene?.add(view);
      this.slots.push({
        world, view, active: false, age: 0, lifetime: 1, peak: 0,
        radius: 8, curve: 'exp', seed: i * 37, position: new THREE.Vector3(),
      });
    }
  }

  add(req: DynamicLightRequest): void {
    if (this.slots.length === 0) return;

    // Prefer a free slot; otherwise steal the one contributing least.
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.cursor + i) % this.slots.length;
      const s = this.slots[idx];
      if (!s.active) { best = idx; break; }
      const score = s.world.intensity;
      if (score < bestScore) { bestScore = score; best = idx; }
    }
    if (best < 0) return;
    this.cursor = (best + 1) % this.slots.length;

    const s = this.slots[best];
    s.active = true;
    s.age = 0;
    s.lifetime = Math.max(req.lifetime, 1e-3);
    s.peak = Math.max(req.intensity, 0);
    s.radius = Math.max(req.radius, 0.05);
    s.curve = req.decay ?? 'exp';
    s.seed = (s.seed + 101) % NOISE_SIZE;
    s.position.copy(req.position);
    s.world.color.set(req.color);
    s.view.color.copy(s.world.color);
    s.world.distance = s.radius;
    s.view.distance = s.radius;
    s.world.position.copy(s.position);
  }

  private curveValue(s: Slot): number {
    const t = THREE.MathUtils.clamp(s.age / s.lifetime, 0, 1);
    switch (s.curve) {
      case 'linear':
        return 1 - t;
      case 'flash': {
        // Sharp rise, long-ish cubic tail — reads as a photographic pop.
        if (t < 0.08) return t / 0.08;
        const u = (t - 0.08) / 0.92;
        return (1 - u) * (1 - u) * (1 - u);
      }
      case 'flicker': {
        const base = 1 - t;
        const i = (s.seed + Math.floor(s.age * 46)) % NOISE_SIZE;
        const j = (i + 1) % NOISE_SIZE;
        const f = (s.age * 46) % 1;
        const n = this.noise[i] * (1 - f) + this.noise[j] * f;
        return base * (0.52 + 0.62 * n);
      }
      case 'exp':
      default:
        return Math.exp(-t * 4.6);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    let live = 0;
    const view = camera.matrixWorldInverse;
    for (const s of this.slots) {
      if (!s.active) {
        s.world.intensity = 0;
        s.view.intensity = 0;
        continue;
      }
      s.age += dt;
      if (s.age >= s.lifetime) {
        s.active = false;
        s.world.intensity = 0;
        s.view.intensity = 0;
        continue;
      }
      live++;
      const k = Math.max(this.curveValue(s), 0);
      s.world.intensity = s.peak * k;
      s.world.position.copy(s.position);
      // Mirror into view space for the first-person weapon rig.
      this.tmp.copy(s.position).applyMatrix4(view);
      s.view.position.copy(this.tmp);
      s.view.intensity = s.peak * k * 0.85;
      s.view.distance = s.radius;
    }
    this.activeCount = live;
  }

  clear(): void {
    for (const s of this.slots) {
      s.active = false;
      s.world.intensity = 0;
      s.view.intensity = 0;
    }
    this.activeCount = 0;
  }

  dispose(): void {
    this.setBudget(0);
  }
}
