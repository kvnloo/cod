/**
 * Determinism probe.
 *
 * This is **not** a second game. It is a fixture: the smallest simulation that
 * still has every property the replay layer depends on — fixed-step integration,
 * seeded randomness, hit resolution, deaths, respawns and a state blob — so
 * `tools/session-replay.mjs` can prove that recording inputs plus keyframes
 * reproduces a run exactly. The real match (`src/game/Match.ts` + its actor
 * backend) plugs into the same `ReplaySim` interface; this one exists so the
 * *machinery* can be tested without a GPU, a physics backend or a browser.
 *
 * Determinism rules it obeys, which the real sim must obey too:
 *   • all randomness is re-seeded from (seed, tick, actor, salt) — never from
 *     carried state, so a keyframe does not have to serialise an RNG,
 *   • state is a flat `Float64Array` that round-trips through capture/restore,
 *   • iteration order over actors is index order, never a Map or Set.
 */

import { Rand, hashString } from '../../core/Rand';
import { StateHash } from './Hash';
import {
  ACTOR, BTN, EVT, TICK_DT, type ActorSample, type InputFrame, type ReplayEvent,
  type ReplaySim, replayEvent,
} from './types';

/** Doubles per actor in the state blob. */
const STRIDE = 16;
const HEADER = 4;

const ARENA = 42;
const MOVE_SPEED = 5.4;
const FIRE_INTERVAL = 0.1;
const MAG = 30;
const RELOAD_TIME = 2.1;
const RESPAWN_TIME = 4;
const MAX_RANGE = 70;
const CONE_COS = Math.cos(0.085);

const WEAPONS = ['m4a1', 'ak74', 'mp5', 'sr25'];

export interface ProbeActor {
  id: number;
  team: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  health: number;
  alive: boolean;
  ammo: number;
  cooldown: number;
  reload: number;
  respawn: number;
  kills: number;
  deaths: number;
  firing: boolean;
  weapon: number;
}

export class ProbeSim implements ReplaySim {
  readonly actors: ProbeActor[] = [];
  tick = 0;
  seed: number;

  private blob: Float64Array;
  private queue: ReplayEvent[] = [];
  private rand = new Rand(1);
  private hasher = new StateHash();

  constructor(seed: number, actorCount = 8) {
    this.seed = seed >>> 0;
    for (let i = 0; i < actorCount; i++) {
      this.actors.push({
        id: i,
        team: i % 2,
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
        health: 100, alive: true, ammo: MAG,
        cooldown: 0, reload: 0, respawn: 0,
        kills: 0, deaths: 0, firing: false,
        weapon: i % WEAPONS.length,
      });
    }
    this.blob = new Float64Array(HEADER + actorCount * STRIDE);
    this.reset();
  }

  /** Deterministic starting formation: two lines facing each other. */
  reset(): void {
    this.tick = 0;
    this.queue.length = 0;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      const rowIndex = i >> 1;
      const side = a.team === 0 ? -1 : 1;
      a.x = (rowIndex - (this.actors.length / 4 - 0.5)) * 6;
      a.y = 0;
      a.z = side * 22;
      a.yaw = a.team === 0 ? 0 : Math.PI;
      a.pitch = 0;
      a.health = 100;
      a.alive = true;
      a.ammo = MAG;
      a.cooldown = 0;
      a.reload = 0;
      a.respawn = 0;
      a.kills = 0;
      a.deaths = 0;
      a.firing = false;
    }
  }

  /** The string table indices the recorder should intern, in weapon order. */
  static weaponNames(): readonly string[] { return WEAPONS; }

  byId(id: number): ProbeActor | null {
    return this.actors[id] ?? null;
  }

  /* --------------------------------------------------------------- ReplaySim */

  capture(): Float64Array {
    const b = this.blob;
    b[0] = this.tick;
    b[1] = this.seed;
    b[2] = this.actors.length;
    b[3] = 0;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      const o = HEADER + i * STRIDE;
      b[o] = a.id; b[o + 1] = a.team;
      b[o + 2] = a.x; b[o + 3] = a.y; b[o + 4] = a.z;
      b[o + 5] = a.yaw; b[o + 6] = a.pitch;
      b[o + 7] = a.health; b[o + 8] = a.alive ? 1 : 0;
      b[o + 9] = a.ammo; b[o + 10] = a.cooldown; b[o + 11] = a.reload;
      b[o + 12] = a.respawn; b[o + 13] = a.kills; b[o + 14] = a.deaths;
      b[o + 15] = a.weapon;
    }
    return b;
  }

  restore(blob: Float64Array): void {
    this.tick = blob[0];
    this.seed = blob[1] >>> 0;
    const n = blob[2];
    for (let i = 0; i < n && i < this.actors.length; i++) {
      const a = this.actors[i];
      const o = HEADER + i * STRIDE;
      a.id = blob[o]; a.team = blob[o + 1];
      a.x = blob[o + 2]; a.y = blob[o + 3]; a.z = blob[o + 4];
      a.yaw = blob[o + 5]; a.pitch = blob[o + 6];
      a.health = blob[o + 7]; a.alive = blob[o + 8] > 0.5;
      a.ammo = blob[o + 9]; a.cooldown = blob[o + 10]; a.reload = blob[o + 11];
      a.respawn = blob[o + 12]; a.kills = blob[o + 13]; a.deaths = blob[o + 14];
      a.weapon = blob[o + 15];
      a.firing = false;
    }
    this.queue.length = 0;
  }

  step(tick: number, commands: readonly InputFrame[]): void {
    this.tick = tick;
    const dt = TICK_DT;

    for (let i = 0; i < this.actors.length; i++) this.actors[i].firing = false;

    // Apply intent in actor-index order, not command order, so a reordered
    // packet stream cannot change the outcome.
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      let cmd: InputFrame | null = null;
      for (let c = 0; c < commands.length; c++) {
        if (commands[c].actor === a.id) { cmd = commands[c]; break; }
      }

      if (!a.alive) {
        a.respawn -= dt;
        if (a.respawn <= 0) this.respawn(a, tick);
        continue;
      }

      if (cmd) {
        a.yaw = cmd.yaw;
        a.pitch = cmd.pitch;
        const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
        // Engine convention: forward is -Z at yaw 0, +yaw turns left.
        const fx = -sy, fz = -cy;
        const rx = cy, rz = -sy;
        const vx = (rx * cmd.moveX + fx * cmd.moveY) * MOVE_SPEED;
        const vz = (rz * cmd.moveX + fz * cmd.moveY) * MOVE_SPEED;
        a.x = clamp(a.x + vx * dt, -ARENA, ARENA);
        a.z = clamp(a.z + vz * dt, -ARENA, ARENA);
      }

      if (a.reload > 0) {
        a.reload -= dt;
        if (a.reload <= 0) { a.reload = 0; a.ammo = MAG; }
      }
      if (a.cooldown > 0) a.cooldown -= dt;

      if (!cmd) continue;
      if ((cmd.buttons & BTN.reload) && a.ammo < MAG && a.reload <= 0) a.reload = RELOAD_TIME;
      if ((cmd.buttons & BTN.fire) && a.cooldown <= 0 && a.reload <= 0) {
        if (a.ammo <= 0) { a.reload = RELOAD_TIME; continue; }
        a.ammo--;
        a.cooldown = FIRE_INTERVAL;
        a.firing = true;
        this.fire(a, tick);
      }
    }
  }

  private fire(shooter: ProbeActor, tick: number): void {
    this.emit('shot', shooter.id, -1, shooter.x, shooter.y + 1.6, shooter.z, 0, shooter.weapon, 0);

    const cp = Math.cos(shooter.pitch);
    const dx = -Math.sin(shooter.yaw) * cp;
    const dy = Math.sin(shooter.pitch);
    const dz = -Math.cos(shooter.yaw) * cp;

    let bestIdx = -1;
    let bestDist = MAX_RANGE;
    for (let i = 0; i < this.actors.length; i++) {
      const t = this.actors[i];
      if (!t.alive || t.team === shooter.team || t.id === shooter.id) continue;
      const ox = t.x - shooter.x;
      const oy = (t.y + 1.15) - (shooter.y + 1.6);
      const oz = t.z - shooter.z;
      const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (d < 0.001 || d > MAX_RANGE) continue;
      const cos = (ox * dx + oy * dy + oz * dz) / d;
      if (cos < CONE_COS) continue;
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx < 0) return;

    const target = this.actors[bestIdx];
    const r = this.draw(tick, shooter.id, 0x51);
    // Falloff: full damage inside 25 m, half at max range.
    const falloff = 1 - 0.5 * clamp((bestDist - 25) / (MAX_RANGE - 25), 0, 1);
    const head = this.draw(tick, shooter.id, 0x9c) < 0.16;
    const dmg = (20 + r * 9) * falloff * (head ? 2.3 : 1);
    target.health -= dmg;

    this.emit(
      'damage', shooter.id, target.id, target.x, target.y + 1.15, target.z,
      dmg, shooter.weapon, head ? EVT.headshot : 0,
    );

    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      target.deaths++;
      target.respawn = RESPAWN_TIME;
      shooter.kills++;
      this.emit(
        'kill', shooter.id, target.id, target.x, target.y + 1.15, target.z,
        bestDist, shooter.weapon, EVT.fatal | (head ? EVT.headshot : 0),
      );
    }
  }

  private respawn(a: ProbeActor, tick: number): void {
    const side = a.team === 0 ? -1 : 1;
    const r = this.draw(tick, a.id, 0x2b);
    a.x = clamp((r * 2 - 1) * 18, -ARENA, ARENA);
    a.z = side * (20 + this.draw(tick, a.id, 0x2c) * 6);
    a.y = 0;
    a.yaw = a.team === 0 ? 0 : Math.PI;
    a.pitch = 0;
    a.health = 100;
    a.alive = true;
    a.ammo = MAG;
    a.cooldown = 0;
    a.reload = 0;
    a.respawn = 0;
    this.emit('spawn', a.id, -1, a.x, a.y, a.z, 0, a.weapon, 0);
  }

  /**
   * Stateless seeded draw. Re-seeding per call is deliberate: it means the RNG
   * is a pure function of (seed, tick, actor, salt), so a keyframe never has to
   * carry RNG state and a resim from any keyframe lands on the same numbers.
   */
  private draw(tick: number, actor: number, salt: number): number {
    this.rand.seed(
      (Math.imul(this.seed ^ salt, 0x9e3779b1)
        ^ Math.imul(tick + 1, 0x85ebca6b)
        ^ Math.imul(actor + 1, 0xc2b2ae35)) >>> 0,
    );
    return this.rand.next();
  }

  private emit(
    kind: ReplayEvent['kind'], a: number, b: number,
    x: number, y: number, z: number, n: number, label: number, flags: number,
  ): void {
    const e = replayEvent();
    e.tick = this.tick;
    e.kind = kind; e.a = a; e.b = b;
    e.x = x; e.y = y; e.z = z; e.n = n;
    e.label = label + 1; // 0 is the empty string in the table
    e.flags = flags;
    this.queue.push(e);
  }

  hash(): number {
    const h = this.hasher.reset();
    h.u32(this.tick);
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      h.u32(a.id).u32(a.team)
        .f(a.x).f(a.y).f(a.z)
        .f(a.yaw, 100000).f(a.pitch, 100000)
        .f(a.health, 10000).u32(a.alive ? 1 : 0)
        .u32(a.ammo).f(a.cooldown, 100000).f(a.reload, 100000)
        .f(a.respawn, 100000).u32(a.kills).u32(a.deaths);
    }
    return h.value;
  }

  sample(out: ActorSample[]): number {
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      const s = out[i];
      if (!s) break;
      s.id = a.id;
      s.team = a.team;
      s.x = a.x; s.y = a.y; s.z = a.z;
      s.yaw = a.yaw; s.pitch = a.pitch;
      s.health = Math.round(clamp(a.health, 0, 100) * 2.55);
      s.flags = (a.alive ? ACTOR.alive : 0) | (a.firing ? ACTOR.firing : 0);
      s.weapon = a.weapon + 1;
    }
    return Math.min(out.length, this.actors.length);
  }

  drainEvents(out: ReplayEvent[]): number {
    const n = Math.min(this.queue.length, out.length);
    for (let i = 0; i < n; i++) {
      const src = this.queue[i];
      const dst = out[i];
      dst.tick = src.tick; dst.kind = src.kind;
      dst.a = src.a; dst.b = src.b;
      dst.x = src.x; dst.y = src.y; dst.z = src.z;
      dst.n = src.n; dst.label = src.label; dst.flags = src.flags;
    }
    this.queue.length = 0;
    return n;
  }
}

/* ------------------------------------------------------------------ script -- */

/**
 * A deterministic bot script that produces the input stream.
 *
 * This runs only during the *live* pass. The replay never calls it — it reads
 * the recorded stream instead, which is precisely what is being tested: if the
 * script leaked into playback the test would prove nothing.
 */
export class ProbeScript {
  private rand = new Rand(1);

  constructor(private sim: ProbeSim, private seed: number) { }

  /** Fills `out` with one frame per living actor for `tick`. */
  frames(tick: number, out: InputFrame[]): number {
    let n = 0;
    for (let i = 0; i < this.sim.actors.length; i++) {
      const a = this.sim.actors[i];
      while (out.length <= n) {
        out.push({ tick: 0, actor: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0 });
      }
      const f = out[n++];
      f.tick = tick;
      f.actor = a.id;
      f.moveX = 0; f.moveY = 0; f.buttons = 0;
      f.yaw = a.yaw; f.pitch = a.pitch;
      if (!a.alive) continue;

      // Nearest living enemy, index order for determinism.
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < this.sim.actors.length; j++) {
        const t = this.sim.actors[j];
        if (!t.alive || t.team === a.team) continue;
        const dx = t.x - a.x, dz = t.z - a.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = j; }
      }

      const jitter = this.noise(tick, a.id, 0x11) * 2 - 1;
      if (best < 0) {
        f.moveY = 0.4;
        f.yaw = a.yaw + jitter * 0.02;
        continue;
      }
      const t = this.sim.actors[best];
      const dx = t.x - a.x, dz = t.z - a.z;
      const dist = Math.sqrt(bestD);
      const wantYaw = Math.atan2(-dx, -dz);
      // Aim converges over ~0.4 s with a little tremor, so hits are earned.
      f.yaw = shortestLerp(a.yaw, wantYaw, 0.16) + jitter * 0.012;
      f.pitch = clamp(Math.atan2(1.15 - 1.6, Math.max(0.5, dist)) + jitter * 0.006, -0.6, 0.6);

      // Close to a comfortable engagement range, strafe, and fire when lined up.
      const ideal = 14 + (a.id % 3) * 5;
      f.moveY = clamp((dist - ideal) / 8, -1, 1);
      f.moveX = Math.sin((tick / 90) + a.id * 1.7) * 0.75;

      const aimErr = Math.abs(angleDelta(f.yaw, wantYaw));
      if (dist < 55 && aimErr < 0.05 && a.reload <= 0) f.buttons |= BTN.fire;
      if (a.ammo <= 0) f.buttons |= BTN.reload;
    }
    return n;
  }

  private noise(tick: number, actor: number, salt: number): number {
    this.rand.seed(
      (Math.imul(this.seed ^ salt, 0x27d4eb2f)
        ^ Math.imul(tick + 1, 0x165667b1)
        ^ Math.imul(actor + 1, hashString('probe'))) >>> 0,
    );
    return this.rand.next();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleDelta(a: number, b: number): number {
  let d = a - b;
  const twoPi = Math.PI * 2;
  d -= twoPi * Math.floor((d + Math.PI) / twoPi);
  return d;
}

function shortestLerp(a: number, b: number, t: number): number {
  return a - angleDelta(a, b) * t;
}
