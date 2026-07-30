/**
 * Grenade smoke and flashbangs.
 *
 * A smoke screen is a continuous emitter rather than a burst: it takes a couple
 * of seconds to bloom, keeps producing for its burn time, and only then starts
 * to thin. Density is deliberately high enough that the screen genuinely blocks
 * line of sight — overlapping lit media with real self-shadowing, so the volume
 * has a bright side and a dark side instead of reading as fog-coloured haze.
 *
 * The flashbang is coordinated with the render module's screen effects: the
 * world-space bloom and the full-screen white-out are two halves of one event,
 * and they have to peak on the same frame.
 */

import * as THREE from 'three';
import { CELL } from './SpriteAtlas';
import { FLAG, MODEL } from './GpuParticles';
import { QUAD_BLEND, QUAD_MODE } from './Quads';
import { clamp } from './Common';
import type { FxWorld } from './Context';

interface Screen {
  active: boolean;
  x: number; y: number; z: number;
  radius: number;
  age: number;
  duration: number;
  emitAcc: number;
  rate: number;
  tint: [number, number, number];
  floorY: number;
}

export class SmokeFX {
  private screens: Screen[] = [];

  init(budget = 6): void {
    for (let i = 0; i < budget; i++) {
      this.screens.push({
        active: false, x: 0, y: 0, z: 0, radius: 5, age: 0, duration: 12,
        emitAcc: 0, rate: 34, tint: [0.72, 0.73, 0.75], floorY: 0,
      });
    }
  }

  clear(): void { for (const s of this.screens) s.active = false; }

  /** Starts a growing smoke volume at `point`. */
  screen(
    w: FxWorld, point: THREE.Vector3, radius = 5, duration = 14,
    tint: [number, number, number] = [0.74, 0.75, 0.77],
  ): void {
    let slot = this.screens.find((s) => !s.active);
    if (!slot) slot = this.screens.reduce((a, b) => (a.age > b.age ? a : b));
    slot.active = true;
    slot.x = point.x; slot.y = point.y; slot.z = point.z;
    slot.radius = radius;
    slot.age = 0;
    slot.duration = duration;
    slot.emitAcc = 0;
    slot.rate = 30;
    slot.tint = tint;
    slot.floorY = w.floorUnder(point.x, point.y, point.z);

    // The initial pop: a hard burst of pressurised smoke before the canister
    // settles into a steady burn.
    const g = w.particles;
    const rand = w.rand;
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0], g: tint[1], b: tint[2], opacity: 0.5,
      drag: 1.1, gravity: -0.05, turbulence: 1.3,
    });
    g.pushMany(26, (d) => {
      const a = rand.range(0, Math.PI * 2);
      const z = rand.signed();
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const sp = 2.2 + rand.next() * 3.4;
      d.px = point.x; d.py = point.y; d.pz = point.z;
      d.vx = Math.cos(a) * s * sp;
      d.vy = z * sp * 0.6 + 1.4;
      d.vz = Math.sin(a) * s * sp;
      d.sizeBegin = 0.4;
      d.sizeEnd = radius * (0.5 + rand.next() * 0.5);
      d.lifetime = 3.5 + rand.next() * 3;
      d.rot = rand.range(0, 6.28);
      d.spin = rand.signed() * 0.3;
    });
  }

  /** Flashbang: world bloom + coordinated screen white-out and ringing. */
  flashbang(w: FxWorld, point: THREE.Vector3): void {
    const rand = w.rand;
    const q = w.quads;
    const dist = w.distanceToCamera(point.x, point.y, point.z);
    const prox = clamp(1 - dist / 22, 0, 1);

    // World-space bloom — visible to anyone who is not the one blinded.
    q.begin({
      px: point.x, py: point.y, pz: point.z,
      w0: 0.5, h0: 0.5, w1: 9, h1: 9,
      r: 1, g: 0.99, b: 0.96, alpha: 1,
      life: 0.30, cell: CELL.FLASH_DISC, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.02, fadeOut: 0.10, soft: 0, intensity: 13,
      rot: rand.range(0, 6.28),
    });
    q.push();
    q.begin({
      px: point.x, py: point.y, pz: point.z,
      w0: 1.0, h0: 1.0, w1: 16, h1: 16,
      r: 1, g: 0.98, b: 0.92, alpha: 1,
      life: 0.22, cell: CELL.MUZZLE_STAR, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.02, fadeOut: 0.08, soft: 0, intensity: 7,
      rot: rand.range(0, 6.28),
    });
    q.push();

    w.light({
      x: point.x, y: point.y, z: point.z,
      color: 0xffffff, intensity: 190, radius: 30, lifetime: 0.35, decay: 'flash',
    });

    // The player's half of the event.
    w.flash(4.2 * prox, 0xffffff, 0.85);
    w.concussion(1.8 * prox, 3.5);
    w.shake(0.10 * prox, 26, 0.5);

    // A puff of white smoke where the charge burned.
    const g = w.particles;
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: 0.92, g: 0.92, b: 0.93, opacity: 0.4,
      drag: 2.0, gravity: -0.12, turbulence: 1.6,
    });
    g.pushMany(18, (d) => {
      const a = rand.range(0, Math.PI * 2);
      const z = rand.signed();
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const sp = 2 + rand.next() * 4;
      d.px = point.x; d.py = point.y; d.pz = point.z;
      d.vx = Math.cos(a) * s * sp; d.vy = z * sp * 0.7 + 1.2; d.vz = Math.sin(a) * s * sp;
      d.sizeBegin = 0.2; d.sizeEnd = 1.4 + rand.next() * 1.2;
      d.lifetime = 1.6 + rand.next() * 1.6;
      d.rot = rand.range(0, 6.28); d.spin = rand.signed() * 0.6;
    });
  }

  update(dt: number, w: FxWorld): void {
    const g = w.particles;
    const rand = w.rand;
    for (const s of this.screens) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age > s.duration + 8) { s.active = false; continue; }
      if (s.age > s.duration) continue;

      // Output ramps up over the first second and tails off at the end.
      const ramp = Math.min(1, s.age / 0.9) * (1 - clamp((s.age - s.duration * 0.7) / (s.duration * 0.3), 0, 1));
      s.emitAcc += dt * s.rate * ramp * w.density;
      const n = Math.floor(s.emitAcc);
      if (n <= 0) continue;
      s.emitAcc -= n;

      g.begin({
        cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
        flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
        r: s.tint[0], g: s.tint[1], b: s.tint[2], opacity: 0.34,
        drag: 1.6, gravity: -0.035, turbulence: 0.9,
      });
      for (let i = 0; i < n; i++) {
        const d = g.desc;
        const a = rand.range(0, Math.PI * 2);
        const rr = rand.next() * s.radius * 0.35;
        d.px = s.x + Math.cos(a) * rr;
        d.py = s.y + rand.range(-0.2, 0.5);
        d.pz = s.z + Math.sin(a) * rr;
        const sp = 0.6 + rand.next() * 1.5;
        d.vx = Math.cos(a) * sp;
        d.vy = 0.5 + rand.next() * 1.1;
        d.vz = Math.sin(a) * sp;
        d.sizeBegin = s.radius * 0.16;
        d.sizeEnd = s.radius * (0.55 + rand.next() * 0.5);
        d.lifetime = 5 + rand.next() * 5;
        d.rot = rand.range(0, 6.28);
        d.spin = rand.signed() * 0.22;
        d.floorY = s.floorY;
        g.push();
      }
    }
  }
}
