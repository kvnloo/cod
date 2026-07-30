/**
 * Spawn zones and the flip mechanic.
 *
 * Candidates are bucketed into a handful of spatial zones. A zone is the unit
 * the spawn system reasons about at match scale: it has an owner, a live enemy
 * count, and — crucially — a *trap score*, the decayed record of how often
 * spawning there got somebody killed in the first three seconds.
 *
 * The flip is the anti-spawn-trap mechanic. Three things move a zone:
 *
 *  1. **Territory.** The influence field says whose ground the zone sits on.
 *     Crossing ±`enterThreshold` for `dwell` seconds flips the owner; falling
 *     back inside ±`leaveThreshold` returns it to neutral. Hysteresis + dwell
 *     means a zone cannot oscillate on one player walking through it.
 *  2. **Occupation.** Enemies physically standing in a zone suppress it
 *     immediately, without waiting for the territory filter.
 *  3. **Trap memory.** A zone that keeps producing three-second deaths is
 *     suppressed for `trapCooldown` seconds even if the map says it is safe.
 *     This is what breaks a spawn trap that the geometry alone cannot see.
 *
 * A suppressed zone is not deleted — the selector still falls back to it when
 * every other zone is worse. Deleting spawn space is how you get "no valid
 * spawn found" and a player dropped at the origin.
 */

import { clamp, distXZ } from './Math';
import type { InfluenceField } from './InfluenceField';
import type { SpawnPoint, SpawnTeam, SpawnWorldState } from './types';

export interface ZoneConfig {
  /** Target zone size, metres. Points are bucketed on this grid. */
  size: number;
  /** |net| needed to claim a zone. */
  enterThreshold: number;
  /** |net| below which a zone reverts to neutral. */
  leaveThreshold: number;
  /** Seconds a threshold must hold before the owner changes. */
  dwell: number;
  /** Radius, in metres, that counts as "an enemy is standing in this zone". */
  occupyRadius: number;
  /** Seconds of suppression after a zone earns its trap score. */
  trapCooldown: number;
  /** Trap score at which a zone is considered trapped. */
  trapThreshold: number;
  /** Trap score half-life, seconds. */
  trapHalfLife: number;
}

export function defaultZoneConfig(): ZoneConfig {
  return {
    size: 26,
    enterThreshold: 0.20,
    leaveThreshold: 0.08,
    dwell: 2.0,
    occupyRadius: 18,
    trapCooldown: 14,
    trapThreshold: 2.0,
    trapHalfLife: 20,
  };
}

export interface SpawnZone {
  id: number;
  /** Centroid of the member points. */
  x: number;
  z: number;
  y: number;
  /** Distance from the centroid to the furthest member. */
  radius: number;
  points: number[];
  /** Static ownership from the map data (S&D honours this). */
  homeOwner: SpawnTeam;
  /** Live ownership from the influence field. */
  owner: SpawnTeam;
  /** Smoothed net influence at the centroid. */
  influence: number;
  /** Live enemies (relative to `friendly`) standing inside. */
  hostileOccupants: number;
  friendlyOccupants: number;
  /** Decayed count of spawns here that died within the early window. */
  trapScore: number;
  /** Match time this zone stops being suppressed. */
  suppressedUntil: number;
  /** Total grants and early deaths, for the metrics report. */
  grants: number;
  earlyDeaths: number;
  /** Internal: pending owner + how long it has been pending. */
  pendingOwner: SpawnTeam;
  pendingFor: number;
}

export class SpawnZones {
  config: ZoneConfig = defaultZoneConfig();
  readonly zones: SpawnZone[] = [];
  /** When true (S&D) ownership is frozen at `homeOwner`. */
  frozen = false;

  private lastDecay = 0;

  /** Buckets points onto a grid and derives one zone per non-empty bucket. */
  build(points: readonly SpawnPoint[]): void {
    this.zones.length = 0;
    if (points.length === 0) return;
    const size = Math.max(6, this.config.size);
    const map = new Map<number, SpawnZone>();

    for (const p of points) {
      const gx = Math.floor(p.position.x / size);
      const gz = Math.floor(p.position.z / size);
      const key = (gx + 4096) * 8192 + (gz + 4096);
      let z = map.get(key);
      if (!z) {
        z = {
          id: 0, x: 0, z: 0, y: 0, radius: 0, points: [],
          homeOwner: 'neutral', owner: 'neutral', influence: 0,
          hostileOccupants: 0, friendlyOccupants: 0,
          trapScore: 0, suppressedUntil: -1e9, grants: 0, earlyDeaths: 0,
          pendingOwner: 'neutral', pendingFor: 0,
        };
        map.set(key, z);
      }
      z.points.push(p.id);
    }

    const byId = new Map<number, SpawnPoint>();
    for (const p of points) byId.set(p.id, p);

    let id = 0;
    // Deterministic ordering: sort buckets by (x, z) of their first member.
    const list = [...map.values()].sort((a, b) => {
      const pa = byId.get(a.points[0])!, pb = byId.get(b.points[0])!;
      return pa.position.x - pb.position.x || pa.position.z - pb.position.z;
    });
    for (const z of list) {
      z.id = id++;
      let sx = 0, sy = 0, sz = 0;
      let friendly = 0, hostile = 0;
      for (const pid of z.points) {
        const p = byId.get(pid)!;
        sx += p.position.x; sy += p.position.y; sz += p.position.z;
        if (p.owner === 'friendly') friendly++;
        else if (p.owner === 'hostile') hostile++;
        p.zone = z.id;
      }
      const n = z.points.length;
      z.x = sx / n; z.y = sy / n; z.z = sz / n;
      let r = 0;
      for (const pid of z.points) {
        const p = byId.get(pid)!;
        r = Math.max(r, distXZ({ x: z.x, y: z.y, z: z.z }, p.position));
      }
      z.radius = Math.max(4, r);
      z.homeOwner = friendly > hostile * 2 ? 'friendly' : hostile > friendly * 2 ? 'hostile' : 'neutral';
      z.owner = z.homeOwner;
      z.pendingOwner = z.owner;
      this.zones.push(z);
    }
  }

  get(id: number): SpawnZone | null {
    return id >= 0 && id < this.zones.length ? this.zones[id] : null;
  }

  reset(now: number): void {
    for (const z of this.zones) {
      z.owner = z.homeOwner;
      z.pendingOwner = z.homeOwner;
      z.pendingFor = 0;
      z.influence = 0;
      z.trapScore = 0;
      z.suppressedUntil = -1e9;
      z.hostileOccupants = 0;
      z.friendlyOccupants = 0;
      z.grants = 0;
      z.earlyDeaths = 0;
    }
    this.lastDecay = now;
  }

  /** Advances ownership, occupancy and trap decay. */
  update(field: InfluenceField, state: SpawnWorldState, dt: number): void {
    const cfg = this.config;
    const decay = Math.pow(0.5, Math.max(0, state.now - this.lastDecay) / cfg.trapHalfLife);
    this.lastDecay = state.now;

    for (const z of this.zones) {
      z.trapScore *= decay;

      /* --- who is standing here right now --- */
      let hostile = 0, friendly = 0;
      const r = Math.max(cfg.occupyRadius, z.radius);
      for (const a of state.actors) {
        if (!a.alive || a.team === 'neutral') continue;
        const dx = a.position.x - z.x, dz = a.position.z - z.z;
        if (dx * dx + dz * dz > r * r) continue;
        if (a.team === 'hostile') hostile++; else friendly++;
      }
      z.hostileOccupants = hostile;
      z.friendlyOccupants = friendly;

      /* --- territory --- */
      z.influence = field.ready ? field.sample(z.x, z.z) : 0;
      if (this.frozen) { z.owner = z.homeOwner; continue; }

      let want: SpawnTeam;
      if (z.influence >= cfg.enterThreshold) want = 'friendly';
      else if (z.influence <= -cfg.enterThreshold) want = 'hostile';
      else if (Math.abs(z.influence) <= cfg.leaveThreshold) want = 'neutral';
      else want = z.owner; // inside the hysteresis band: hold

      if (want === z.pendingOwner) z.pendingFor += dt;
      else { z.pendingOwner = want; z.pendingFor = 0; }
      if (z.pendingFor >= cfg.dwell && z.owner !== want) {
        z.owner = want;
        z.pendingFor = 0;
      }
    }
  }

  /**
   * How usable a zone is for `team` right now, 0..1. This is the number the
   * scorer folds into every candidate in the zone, so a whole area falls out of
   * favour together — which is what makes spawns *migrate* rather than
   * scatter.
   */
  suitability(zone: SpawnZone, team: SpawnTeam, now: number): number {
    let s = 0.5;
    if (this.frozen) {
      // S&D: your half of the map or nothing.
      return zone.homeOwner === team ? 1 : zone.homeOwner === 'neutral' ? 0.25 : 0;
    }
    const own = team === 'friendly' ? 1 : -1;
    s += clamp(zone.influence * own, -1, 1) * 0.4;
    const enemiesHere = team === 'friendly' ? zone.hostileOccupants : zone.friendlyOccupants;
    const alliesHere = team === 'friendly' ? zone.friendlyOccupants : zone.hostileOccupants;
    s -= clamp(enemiesHere * 0.28, 0, 0.7);
    s += clamp(alliesHere * 0.06, 0, 0.18);
    if (now < zone.suppressedUntil) s -= 0.55;
    s -= clamp(zone.trapScore / Math.max(0.5, this.config.trapThreshold), 0, 1) * 0.3;
    return clamp(s, 0, 1);
  }

  /** Records a grant so the zone's trap statistics have a denominator. */
  noteGrant(zoneId: number): void {
    const z = this.get(zoneId);
    if (z) z.grants++;
  }

  /**
   * Records that a spawn from this zone died inside the early window. Enough of
   * these and the zone suppresses itself — the flip that ends a spawn trap.
   */
  noteEarlyDeath(zoneId: number, now: number): void {
    const z = this.get(zoneId);
    if (!z) return;
    z.earlyDeaths++;
    z.trapScore += 1;
    if (z.trapScore >= this.config.trapThreshold) {
      z.suppressedUntil = now + this.config.trapCooldown;
    }
  }

  /** Zones ordered best-first for a team. Used by S&D/Domination group spawns. */
  ranked(team: SpawnTeam, now: number, out: SpawnZone[]): SpawnZone[] {
    out.length = 0;
    for (const z of this.zones) out.push(z);
    out.sort((a, b) => this.suitability(b, team, now) - this.suitability(a, team, now) || a.id - b.id);
    return out;
  }
}
