/**
 * World-anchored damage numbers.
 *
 * Each number is pinned to the world point where the round landed and projected
 * every frame, so it stays glued to the target while the camera moves — then it
 * releases, drifting up in screen space as it fades. Repeat hits on the same
 * spot within a short window accumulate into the existing number and re-punch
 * instead of stacking, which keeps automatic fire legible.
 */

import * as THREE from 'three';
import { bus } from '../../core/EventBus';
import { settings } from '../../core/Settings';
import { clamp01, Ease, motion, Spring, SPRING } from '../Anim';
import { text } from '../Draw';
import type { DrawCtx } from '../Draw';
import type { HudModel } from '../Model';
import { lift, rgba, type Palette, type RGB } from '../Theme';
import { ui } from '../UiSettings';
import type { Widget } from './Widget';

interface Num {
  active: boolean;
  world: THREE.Vector3;
  amount: number;
  headshot: boolean;
  killed: boolean;
  age: number;
  life: number;
  punch: Spring;
  jitterX: number;
}

const CAPACITY = 16;
const MERGE_DISTANCE = 0.85;
const MERGE_WINDOW = 0.35;

export class FloatingNumbers implements Widget {
  readonly name = 'damage-numbers';

  private readonly pool: Num[] = [];
  private cursor = 0;
  private readonly off: Array<() => void> = [];
  private readonly proj = new THREE.Vector3();
  private jitterSeed = 0;

  constructor(private pal: () => Palette) {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        active: false, world: new THREE.Vector3(), amount: 0, headshot: false,
        killed: false, age: 0, life: 1.0, punch: new Spring(0, SPRING.pop), jitterX: 0,
      });
    }
    this.off.push(bus.on('damage:dealt', (e) => {
      if (!e.fromPlayer) return;
      this.add(e.point, e.amount, e.headshot, e.killed);
    }));
  }

  add(point: THREE.Vector3, amount: number, headshot: boolean, killed: boolean): void {
    for (let i = 0; i < CAPACITY; i++) {
      const n = this.pool[i];
      if (n.active && n.age < MERGE_WINDOW && n.world.distanceTo(point) < MERGE_DISTANCE) {
        n.amount += amount;
        n.headshot = n.headshot || headshot;
        n.killed = n.killed || killed;
        n.age = 0;
        n.punch.kick(16);
        return;
      }
    }
    const n = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % CAPACITY;
    n.active = true;
    n.world.copy(point);
    n.amount = amount;
    n.headshot = headshot;
    n.killed = killed;
    n.age = 0;
    n.life = killed ? 1.35 : 0.95;
    n.punch.set(0);
    n.punch.kick(22);
    // Deterministic lateral offset so overlapping numbers separate.
    this.jitterSeed = (this.jitterSeed * 1664525 + 1013904223) >>> 0;
    n.jitterX = ((this.jitterSeed >>> 8) / 0xffffff - 0.5) * 22;
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) this.pool[i].active = false;
  }

  update(dt: number, _m: HudModel): void {
    for (let i = 0; i < CAPACITY; i++) {
      const n = this.pool[i];
      if (!n.active) continue;
      n.age += dt;
      n.punch.to(0);
      n.punch.step(dt);
      if (n.age >= n.life) n.active = false;
    }
  }

  draw(d: DrawCtx, m: HudModel): void {
    if (!ui.prefs.damageNumbers || !settings.game.showDamageNumbers) return;
    const cam = m.camera;
    if (!cam) return;
    const p = this.pal();
    const c = d.c;
    const s = d.s;

    for (let i = 0; i < CAPACITY; i++) {
      const n = this.pool[i];
      if (!n.active) continue;
      const t = clamp01(n.age / n.life);

      this.proj.copy(n.world).project(cam);
      if (this.proj.z > 1 || this.proj.z < -1) continue;
      const x = (this.proj.x * 0.5 + 0.5) * d.w + n.jitterX * s;
      const y = (1 - (this.proj.y * 0.5 + 0.5)) * d.h - Ease.outQuart(t) * 34 * s * motion();

      const alpha = (1 - Ease.inQuad(clamp01((t - 0.45) / 0.55))) * d.alpha;
      if (alpha <= 0.01) continue;

      const tint: RGB = n.killed ? p.hostile : n.headshot ? p.accent : p.ink;
      const size = (n.killed ? 24 : n.headshot ? 21 : 17) * s * (1 + n.punch.value * 0.004);

      c.save();
      c.globalAlpha = alpha;
      text(c, String(Math.round(n.amount)), x, y, {
        size, weight: 700, family: 'cond', tracking: 0.6 * s, align: 'center',
        color: rgba(lift(tint, 0.2), 1), shadow: Math.max(1, 1.5 * s),
        glow: n.headshot || n.killed ? 10 * s : 0, glowColor: rgba(tint, 0.5),
      });
      c.restore();
    }
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
