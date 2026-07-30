/**
 * Reference `SimStepper`: deterministic movement + hitscan combat in an open arena.
 *
 * This is *not* meant to be the shipping gameplay. It exists so the authority has
 * something real to be authoritative about — a host loop you cannot run and
 * measure is a diagram, not netcode — and so the `SimStepper` contract has a
 * worked example for whoever ports the real movement state machine and ballistics
 * behind it.
 *
 * Deterministic by construction: fixed step, no wall-clock, all randomness drawn
 * from the tick-derived stream.
 */

import type { RandomStream, SimOps, SimStepper } from './ports';
import {
  BTN, ENT, ENTITY_FLAG, type ClientId, type EntityState, type InputCommand,
  type WorldState,
} from './types';

export interface ArenaConfig {
  halfExtent: number;
  gravity: number;
  runSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  jumpSpeed: number;
  groundAccel: number;
  airAccel: number;
  /** Ticks between shots. */
  fireInterval: number;
  reloadTicks: number;
  magSize: number;
  baseDamage: number;
  headMultiplier: number;
  maxRange: number;
  spreadRad: number;
  eyeHeight: number;
}

export const DEFAULT_ARENA: ArenaConfig = {
  halfExtent: 60,
  gravity: -22,
  runSpeed: 5.6,
  sprintSpeed: 8.2,
  crouchSpeed: 2.8,
  jumpSpeed: 7.2,
  groundAccel: 14,
  airAccel: 3,
  fireInterval: 3,
  reloadTicks: 60,
  magSize: 30,
  baseDamage: 34,
  headMultiplier: 2.1,
  maxRange: 200,
  spreadRad: 0.012,
  eyeHeight: 1.62,
};

export class ArenaSim implements SimStepper {
  readonly name = 'arena';
  readonly dt: number;
  readonly cfg: ArenaConfig;

  constructor(tickRate = 30, cfg: Partial<ArenaConfig> = {}) {
    this.dt = 1 / tickRate;
    this.cfg = { ...DEFAULT_ARENA, ...cfg };
  }

  spawnPlayer(state: WorldState, ent: EntityState, rand: RandomStream): void {
    // Deterministic ring spawn — every host computes the same point for the same
    // (seed, tick, entity), which is what keeps migration seamless.
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(this.cfg.halfExtent * 0.35, this.cfg.halfExtent * 0.8);
    ent.px = Math.cos(a) * r;
    ent.py = 0;
    ent.pz = Math.sin(a) * r;
    ent.vx = ent.vy = ent.vz = 0;
    ent.yaw = Math.atan2(-ent.px, -ent.pz);
    ent.pitch = 0;
    ent.health = 100;
    ent.armor = 0;
    ent.ammo = this.cfg.magSize;
    ent.flags = 0;
    ent.respawnTick = 0;
    ent.nextFireTick = 0;
  }

  step(
    state: WorldState,
    commands: ReadonlyMap<ClientId, InputCommand>,
    rand: RandomStream,
    ops: SimOps,
  ): void {
    const { cfg, dt } = this;

    // Iterate in a stable order. Map insertion order is stable in JS, but after a
    // checkpoint import the order comes from a sorted array, so sort explicitly:
    // two hosts must resolve simultaneous hits in the same sequence.
    const ids = [...state.entities.keys()].sort((a, b) => a - b);

    for (const id of ids) {
      const e = state.entities.get(id);
      if (!e || e.kind !== ENT.PLAYER) continue;
      const cmd = commands.get(e.owner);
      const dead = (e.flags & ENTITY_FLAG.DEAD) !== 0;

      if (dead) { e.vx = e.vy = e.vz = 0; continue; }

      if (cmd) { e.yaw = cmd.yaw; e.pitch = clamp(cmd.pitch, -1.5, 1.5); }

      const mx = cmd ? clamp(cmd.moveX, -1, 1) : 0;
      const mz = cmd ? clamp(cmd.moveZ, -1, 1) : 0;
      const btn = cmd ? cmd.buttons : 0;
      const crouch = (btn & BTN.CROUCH) !== 0;
      const sprint = (btn & BTN.SPRINT) !== 0 && mz > 0.5 && !crouch;

      const sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
      let wx = mx * cos - mz * sin;
      let wz = -mx * sin - mz * cos;
      const wl = Math.hypot(wx, wz);
      if (wl > 1e-5) { wx /= wl; wz /= wl; }

      const speed = crouch ? cfg.crouchSpeed : sprint ? cfg.sprintSpeed : cfg.runSpeed;
      const grounded = e.py <= 1e-4 && e.vy <= 0;
      const accel = grounded ? cfg.groundAccel : cfg.airAccel;
      const targetX = wx * speed * Math.min(1, wl);
      const targetZ = wz * speed * Math.min(1, wl);
      const k = 1 - Math.exp(-accel * dt);
      e.vx += (targetX - e.vx) * k;
      e.vz += (targetZ - e.vz) * k;

      if (grounded) {
        e.py = 0; e.vy = 0;
        if ((btn & BTN.JUMP) !== 0) { e.vy = cfg.jumpSpeed; }
      } else {
        e.vy += cfg.gravity * dt;
      }

      e.px += e.vx * dt;
      e.py += e.vy * dt;
      e.pz += e.vz * dt;

      if (e.py < 0) { e.py = 0; e.vy = 0; }
      const h = cfg.halfExtent;
      if (e.px < -h) { e.px = -h; e.vx = 0; }
      if (e.px > h) { e.px = h; e.vx = 0; }
      if (e.pz < -h) { e.pz = -h; e.vz = 0; }
      if (e.pz > h) { e.pz = h; e.vz = 0; }

      let flags = e.flags & ~(ENTITY_FLAG.CROUCH | ENTITY_FLAG.SPRINT | ENTITY_FLAG.AIRBORNE | ENTITY_FLAG.FIRING);
      if (crouch) flags |= ENTITY_FLAG.CROUCH;
      if (sprint) flags |= ENTITY_FLAG.SPRINT;
      if (e.py > 1e-4) flags |= ENTITY_FLAG.AIRBORNE;

      // ---- weapon ----------------------------------------------------
      if ((btn & BTN.RELOAD) !== 0 && e.ammo < cfg.magSize && ops.tick >= e.nextFireTick) {
        e.nextFireTick = ops.tick + cfg.reloadTicks;
        e.ammo = cfg.magSize;
        ops.emit('reload', e.id, 0, e.px, e.py, e.pz, 0);
      } else if ((btn & BTN.FIRE) !== 0 && ops.tick >= e.nextFireTick && !sprint) {
        if (e.ammo <= 0) {
          e.nextFireTick = ops.tick + cfg.reloadTicks;
          e.ammo = cfg.magSize;
          ops.emit('reload', e.id, 0, e.px, e.py, e.pz, 0);
        } else {
          e.ammo--;
          e.nextFireTick = ops.tick + cfg.fireInterval;
          flags |= ENTITY_FLAG.FIRING;
          this.fire(state, e, rand, ops);
        }
      }
      e.flags = flags;
    }
  }

  /** Hitscan against every other live player. Damage itself is the authority's call. */
  private fire(state: WorldState, shooter: EntityState, rand: RandomStream, ops: SimOps): void {
    const { cfg } = this;
    const ox = shooter.px, oy = shooter.py + cfg.eyeHeight, oz = shooter.pz;
    const spreadA = rand.range(0, Math.PI * 2);
    const spreadR = Math.sqrt(rand.next()) * cfg.spreadRad;
    const yaw = shooter.yaw + Math.cos(spreadA) * spreadR;
    const pitch = clamp(shooter.pitch + Math.sin(spreadA) * spreadR, -1.5, 1.5);
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * cp;

    ops.emit('shot', shooter.id, shooter.weapon, ox, oy, oz, yaw, undefined);

    let bestT = cfg.maxRange;
    let bestId = 0;
    let bestHead = false;
    const ids = [...state.entities.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const t = state.entities.get(id);
      if (!t || t.id === shooter.id || t.kind !== ENT.PLAYER) continue;
      if ((t.flags & ENTITY_FLAG.DEAD) !== 0) continue;
      if (t.team !== 0 && t.team === shooter.team) continue;

      const head = raySphere(ox, oy, oz, dx, dy, dz, t.px, t.py + 1.62, t.pz, 0.22);
      const body = raySphere(ox, oy, oz, dx, dy, dz, t.px, t.py + 0.95, t.pz, 0.55);
      const hit = head >= 0 && (body < 0 || head < body) ? head : body;
      if (hit >= 0 && hit < bestT) {
        bestT = hit; bestId = t.id;
        bestHead = head >= 0 && (body < 0 || head <= body);
      }
    }

    if (bestId) {
      const falloff = 1 - 0.55 * Math.min(1, bestT / cfg.maxRange);
      const dmg = cfg.baseDamage * falloff * (bestHead ? cfg.headMultiplier : 1);
      ops.damage(bestId, dmg, shooter.id, bestHead);
    } else {
      ops.emit('miss', shooter.id, 0, ox + dx * bestT, oy + dy * bestT, oz + dz * bestT, 0);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Nearest positive ray/sphere intersection distance, or -1. */
function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number,
): number {
  const ex = ox - cx, ey = oy - cy, ez = oz - cz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}
