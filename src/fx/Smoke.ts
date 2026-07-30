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
    // Real smoke is a dark grey aerosol that only *looks* white because it is
    // brightly lit. Authored at 0.75 it clips the tonemapper everywhere at once,
    // which is why the screen used to have no bright side, no dark side and no
    // apparent thickness — every pixel of it was already past white.
    tint: [number, number, number] = [0.46, 0.465, 0.48],
  ): void {
    let slot = this.screens.find((s) => !s.active);
    if (!slot) slot = this.screens.reduce((a, b) => (a.age > b.age ? a : b));
    slot.active = true;
    slot.x = point.x; slot.y = point.y; slot.z = point.z;
    slot.radius = radius;
    slot.age = 0;
    slot.duration = duration;
    slot.emitAcc = 0;
    slot.rate = 50;
    slot.tint = tint;
    slot.floorY = w.floorUnder(point.x, point.y, point.z);

    // The initial pop: a hard burst of pressurised smoke before the canister
    // settles into a steady burn.
    const g = w.particles;
    const rand = w.rand;
    g.begin({
      cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
      flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
      r: tint[0], g: tint[1], b: tint[2], opacity: 0.62,
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
    const prox = clamp(1 - dist / 15, 0, 1);
    // Blinding falls off with the inverse square of the distance to the charge,
    // not linearly: inside about seven metres it is a total white-out, at twenty
    // it is a hard bleach you can still read the frame through. A flat 1.0 for
    // any flashbang anywhere on the level turns the shot into a blank rectangle.
    const blindAmount = clamp(2.6 / (1 + (dist * dist) / 26), 0, 1);

    // World-space bloom — visible to anyone who is not the one blinded.
    q.begin({
      px: point.x, py: point.y, pz: point.z,
      w0: 0.5, h0: 0.5, w1: 9, h1: 9,
      r: 1, g: 0.99, b: 0.96, alpha: 1,
      life: 0.20, cell: CELL.FLASH_DISC, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.02, fadeOut: 0.06, soft: 0, intensity: 6,
      rot: rand.range(0, 6.28),
    });
    q.push();
    q.begin({
      px: point.x, py: point.y, pz: point.z,
      w0: 1.0, h0: 1.0, w1: 16, h1: 16,
      r: 1, g: 0.98, b: 0.92, alpha: 1,
      life: 0.16, cell: CELL.MUZZLE_STAR, frames: 1,
      mode: QUAD_MODE.BILLBOARD, blend: QUAD_BLEND.ADD,
      fadeIn: 0.02, fadeOut: 0.05, soft: 0, intensity: 3.2,
      rot: rand.range(0, 6.28),
    });
    q.push();

    w.light({
      x: point.x, y: point.y, z: point.z,
      color: 0xffffff, intensity: 55, radius: 26, lifetime: 0.22, decay: 'flash',
    });

    // The player's half of the event.
    // Bright enough to blind, short enough to read the frame again quickly.
    // A full-frame white-out that lasts a third of a second is not a
    // flashbang, it is a missing image.
    w.flash(1.15 * prox, 0xffffff, 3.0);
    w.concussion(1.8 * prox, 3.5);
    w.shake(0.10 * prox, 26, 0.5);
    w.blind(blindAmount);

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

      // Buoyancy has to beat drag or the screen never leaves the ground: at
      // -0.035 g against 1.6 drag the terminal rise is 0.2 m/s, so five seconds
      // of burn produced a knee-high smudge instead of a wall you cannot see
      // through. A canister screen stands 4–6 m by the time it is established.
      // Buoyancy has to beat drag or the screen never leaves the ground, but only
      // just: a canister screen is a *bank*, not a column. At -0.055 g against
      // 1.3 drag the terminal rise is 0.4 m/s, so the top of the bank is 4–5 m up
      // once it is established and the base stays packed.
      g.begin({
        cell: CELL.SMOKE, frames: CELL.SMOKE_FRAMES, model: MODEL.MEDIA,
        flags: FLAG.ANIM | FLAG.FADEIN | FLAG.SHADOW,
        r: s.tint[0], g: s.tint[1], b: s.tint[2], opacity: 0.78,
        drag: 1.3, gravity: -0.055, turbulence: 0.9,
      });
      for (let i = 0; i < n; i++) {
        const d = g.desc;
        const a = rand.range(0, Math.PI * 2);
        const rr = rand.next() * s.radius * 0.45;
        d.px = s.x + Math.cos(a) * rr;
        d.py = s.y + rand.range(-0.2, 1.5);
        d.pz = s.z + Math.sin(a) * rr;
        const sp = 0.7 + rand.next() * 1.8;
        d.vx = Math.cos(a) * sp;
        d.vy = 0.5 + rand.next() * 1.2;
        d.vz = Math.sin(a) * sp;
        d.sizeBegin = s.radius * 0.18;
        d.sizeEnd = s.radius * (0.48 + rand.next() * 0.55);
        d.lifetime = 7 + rand.next() * 6;
        d.rot = rand.range(0, 6.28);
        d.spin = rand.signed() * 0.22;
        d.floorY = s.floorY;
        g.push();
      }
    }
  }
}
