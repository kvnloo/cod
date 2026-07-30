/**
 * Lighting design.
 *
 * The sky owns the key light, so this module owns everything else: the
 * practical lights that make interiors read as interiors, and the fires that
 * give the square its warm accents against a cool late-afternoon sky.
 *
 * ## Why a pool
 *
 * Three.js bakes the light count into every shader it compiles, so a level
 * cannot simply add forty point lights — that is forty per-fragment loops on
 * every surface in the game, and changing the count mid-fight recompiles the
 * world. Instead the level authors forty *practical light definitions* and a
 * small fixed pool of real point lights is re-pointed at the most relevant ones
 * each frame, cross-fading so nothing pops. This is exactly how shipped
 * engines handle light relevance, and it means the pool size can track the
 * quality preset without the level changing.
 */

import * as THREE from 'three';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';

export type PracticalKind = 'sodium' | 'bulb' | 'fire' | 'fluoro' | 'signage';

export interface Practical {
  x: number; y: number; z: number;
  color: number;
  /** Peak intensity in the renderer's point-light units. */
  intensity: number;
  radius: number;
  kind: PracticalKind;
  /** Only relevant when the camera is inside this radius of the volume. */
  interiorOf?: { x0: number; z0: number; x1: number; z1: number };
}

interface Slot {
  light: THREE.PointLight;
  current: Practical | null;
  target: Practical | null;
  fade: number;
  seed: number;
}

const FLICKER = new Float32Array(256);
{
  const r = new Rand(0xf1ce);
  for (let i = 0; i < FLICKER.length; i++) FLICKER[i] = r.next();
}

export class PracticalLights {
  readonly practicals: Practical[] = [];
  private slots: Slot[] = [];
  private scene: THREE.Scene | null = null;
  private budget = 0;
  private time = 0;
  private scored: { p: Practical; score: number }[] = [];
  private tmp = new THREE.Vector3();

  init(scene: THREE.Scene): void {
    this.scene = scene;
    this.setBudget(budgetForPreset());
  }

  add(p: Practical): void { this.practicals.push(p); }

  /** Changing the pool size recompiles shaders, so only do it on preset change. */
  setBudget(n: number): void {
    if (n === this.budget || !this.scene) return;
    this.budget = n;
    for (const s of this.slots) {
      s.light.removeFromParent();
      s.light.dispose();
    }
    this.slots.length = 0;
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.name = `practical:${i}`;
      light.castShadow = false;
      this.scene.add(light);
      this.slots.push({ light, current: null, target: null, fade: 0, seed: i * 37 + 11 });
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    const want = budgetForPreset();
    if (want !== this.budget) this.setBudget(want);
    if (!this.slots.length) return;
    this.time += dt;

    camera.getWorldPosition(this.tmp);
    const cam = this.tmp;

    /* --- score every practical by relevance --------------------------- */
    this.scored.length = 0;
    for (const p of this.practicals) {
      const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > (p.radius + 42) * (p.radius + 42)) continue;
      let score = (p.intensity * p.radius) / (d2 + 4);
      if (p.interiorOf) {
        const inside = cam.x > p.interiorOf.x0 - 3 && cam.x < p.interiorOf.x1 + 3
          && cam.z > p.interiorOf.z0 - 3 && cam.z < p.interiorOf.z1 + 3;
        score *= inside ? 3.0 : 0.35;
      }
      this.scored.push({ p, score });
    }
    this.scored.sort((a, b) => b.score - a.score);

    /* --- sticky assignment with a cross-fade --------------------------- */
    const wanted = new Set<Practical>();
    for (let i = 0; i < Math.min(this.slots.length, this.scored.length); i++) wanted.add(this.scored[i].p);

    const assigned = new Set<Practical>();
    for (const s of this.slots) if (s.target) assigned.add(s.target);

    for (const s of this.slots) {
      if (s.target && !wanted.has(s.target)) { s.target = null; }
    }
    for (const s of this.slots) {
      if (s.target) continue;
      if (s.fade > 0.02) continue;      // still fading the previous one out
      for (const p of wanted) {
        if (assigned.has(p)) continue;
        s.target = p;
        s.current = p;
        assigned.add(p);
        break;
      }
    }

    const k = 1 - Math.exp(-dt * 5.5);
    for (const s of this.slots) {
      const to = s.target ? 1 : 0;
      s.fade += (to - s.fade) * k;
      const p = s.current;
      if (!p || s.fade < 0.004) { s.light.intensity = 0; continue; }
      s.light.position.set(p.x, p.y, p.z);
      s.light.color.setHex(p.color);
      s.light.distance = p.radius;
      s.light.intensity = p.intensity * s.fade * modulation(p, this.time, s.seed);
    }
  }

  /** Live light count, for the perf overlay. */
  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.light.intensity > 0.001) n++;
    return n;
  }

  dispose(): void {
    for (const s of this.slots) { s.light.removeFromParent(); s.light.dispose(); }
    this.slots.length = 0;
    this.budget = 0;
  }
}

/** Deterministic, allocation-free flicker per light kind. */
function modulation(p: Practical, t: number, seed: number): number {
  switch (p.kind) {
    case 'fire': {
      const i = (seed + Math.floor(t * 21)) % FLICKER.length;
      const j = (i + 1) % FLICKER.length;
      const f = (t * 21) % 1;
      const n = FLICKER[i] * (1 - f) + FLICKER[j] * f;
      return 0.62 + 0.5 * n + 0.06 * Math.sin(t * 7.3 + seed);
    }
    case 'fluoro': {
      // 100 Hz ripple plus an occasional failing-ballast stutter.
      const ripple = 0.94 + 0.06 * Math.sin(t * 628);
      const stutter = Math.sin(t * 0.7 + seed) > 0.987 ? 0.25 : 1;
      return ripple * stutter;
    }
    case 'signage':
      return 0.85 + 0.15 * Math.sin(t * 3.1 + seed);
    case 'sodium':
      return 0.97 + 0.03 * Math.sin(t * 1.7 + seed);
    default:
      return 1;
  }
}

function budgetForPreset(): number {
  switch (settings.preset) {
    case 'low': return 2;
    case 'medium': return 4;
    case 'high': return 6;
    default: return 7;
  }
}
