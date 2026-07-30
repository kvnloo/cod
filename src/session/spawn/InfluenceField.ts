/**
 * Team influence map.
 *
 * A coarse XZ grid holding, per cell, how much of each team's presence bleeds
 * into it. The *net* channel — `(friendly - hostile) / (friendly + hostile)` —
 * is the map's answer to "whose ground is this?", in [-1, +1].
 *
 * Two properties matter more than accuracy:
 *
 *  • **It is smoothed in time.** Territory is a low-frequency signal. If it
 *    tracked positions instantly, one player sprinting through a corridor would
 *    flip a zone and the spawns behind him would collapse. The net channel
 *    relaxes toward its instantaneous target with a ~2.5 s time constant.
 *  • **It is contested-aware.** A cell with both teams in it reads ~0 rather
 *    than "friendly with a hostile nearby", so the scorer treats a firefight as
 *    no-man's-land instead of as owned ground.
 *
 * Cost is bounded by stamping: each actor writes into the cells inside its
 * radius only, so a refresh is O(actors × cellsInRadius), not O(actors × grid).
 */

import { clamp } from './Math';
import type { SpawnBounds, SpawnWorldState } from './types';

export interface InfluenceConfig {
  /** Metres per cell. 4 m is one stride; finer than that is noise. */
  cell: number;
  /** Radius of an actor's presence, metres. */
  actorRadius: number;
  /** Radius multiplier applied to an objective's own radius. */
  objectiveRadius: number;
  /** Weight of a held objective relative to one actor. */
  objectiveWeight: number;
  /** Seconds for the net channel to cover ~63% of a change. */
  tau: number;
}

export function defaultInfluenceConfig(): InfluenceConfig {
  return { cell: 4, actorRadius: 22, objectiveRadius: 2.0, objectiveWeight: 2.5, tau: 2.5 };
}

export class InfluenceField {
  config: InfluenceConfig = defaultInfluenceConfig();

  nx = 1;
  nz = 1;
  originX = 0;
  originZ = 0;

  /** Instantaneous per-team presence. */
  friendly: Float32Array = new Float32Array(1);
  hostile: Float32Array = new Float32Array(1);
  /** Temporally smoothed net ownership, -1 (hostile) .. +1 (friendly). */
  net: Float32Array = new Float32Array(1);

  /** Fraction of the grid each team owns above the hysteresis threshold. */
  friendlyShare = 0;
  hostileShare = 0;
  /** Mean |net| — low means the map is one big contested blob. */
  polarisation = 0;

  private built = false;

  resize(bounds: SpawnBounds, config?: Partial<InfluenceConfig>): void {
    if (config) Object.assign(this.config, config);
    const cell = Math.max(1, this.config.cell);
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;
    this.nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
    this.nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
    const n = this.nx * this.nz;
    this.friendly = new Float32Array(n);
    this.hostile = new Float32Array(n);
    this.net = new Float32Array(n);
    this.built = true;
  }

  get ready(): boolean { return this.built; }

  indexAt(x: number, z: number): number {
    const cell = this.config.cell;
    const ix = clamp(Math.floor((x - this.originX) / cell), 0, this.nx - 1);
    const iz = clamp(Math.floor((z - this.originZ) / cell), 0, this.nz - 1);
    return iz * this.nx + ix;
  }

  cellCentre(index: number, out: { x: number; z: number }): void {
    const cell = this.config.cell;
    const ix = index % this.nx;
    const iz = (index - ix) / this.nx;
    out.x = this.originX + (ix + 0.5) * cell;
    out.z = this.originZ + (iz + 0.5) * cell;
  }

  /** Smoothed net ownership at a world position, +1 friendly .. -1 hostile. */
  sample(x: number, z: number): number {
    if (!this.built) return 0;
    return this.net[this.indexAt(x, z)];
  }

  /** Instantaneous enemy presence at a position, 0..~n. */
  samplePresence(x: number, z: number, team: 'friendly' | 'hostile'): number {
    if (!this.built) return 0;
    const i = this.indexAt(x, z);
    return team === 'friendly' ? this.friendly[i] : this.hostile[i];
  }

  /** Recomputes presence and relaxes the net channel toward it. */
  refresh(state: SpawnWorldState, dt: number): void {
    if (!this.built) return;
    this.friendly.fill(0);
    this.hostile.fill(0);

    const r = this.config.actorRadius;
    for (const a of state.actors) {
      if (!a.alive || a.team === 'neutral') continue;
      // A sprinting flanker projects further than a camper.
      const radius = r * (1 + clamp((a.speed ?? 0) / 12, 0, 0.6));
      this.stamp(a.position.x, a.position.z, radius, 1, a.team === 'friendly');
    }
    for (const o of state.objectives) {
      if (o.owner === 'neutral') continue;
      const radius = Math.max(8, o.radius * this.config.objectiveRadius + 10);
      const w = this.config.objectiveWeight * (o.weight ?? 1) * (o.contested ? 0.4 : 1);
      this.stamp(o.position.x, o.position.z, radius, w, o.owner === 'friendly');
    }

    const k = dt > 0 ? 1 - Math.exp(-dt / Math.max(0.05, this.config.tau)) : 1;
    let fShare = 0, hShare = 0, pol = 0;
    const n = this.net.length;
    for (let i = 0; i < n; i++) {
      const f = this.friendly[i], h = this.hostile[i];
      const total = f + h;
      const target = total > 1e-4 ? (f - h) / total * Math.min(1, total * 1.6) : 0;
      const v = this.net[i] + (target - this.net[i]) * k;
      this.net[i] = v;
      if (v > 0.18) fShare++;
      else if (v < -0.18) hShare++;
      pol += v < 0 ? -v : v;
    }
    this.friendlyShare = fShare / n;
    this.hostileShare = hShare / n;
    this.polarisation = pol / n;
  }

  /** Clears all memory — call between rounds so territory does not leak. */
  reset(): void {
    this.friendly.fill(0);
    this.hostile.fill(0);
    this.net.fill(0);
    this.friendlyShare = 0;
    this.hostileShare = 0;
    this.polarisation = 0;
  }

  /** Adds a falloff kernel into one team's channel. */
  private stamp(x: number, z: number, radius: number, weight: number, isFriendly: boolean): void {
    const cell = this.config.cell;
    const arr = isFriendly ? this.friendly : this.hostile;
    const cx = (x - this.originX) / cell;
    const cz = (z - this.originZ) / cell;
    const rc = radius / cell;
    const x0 = Math.max(0, Math.floor(cx - rc));
    const x1 = Math.min(this.nx - 1, Math.ceil(cx + rc));
    const z0 = Math.max(0, Math.floor(cz - rc));
    const z1 = Math.min(this.nz - 1, Math.ceil(cz + rc));
    const inv = 1 / (rc * rc || 1);
    for (let iz = z0; iz <= z1; iz++) {
      const dz = iz + 0.5 - cz;
      const row = iz * this.nx;
      for (let ix = x0; ix <= x1; ix++) {
        const dx = ix + 0.5 - cx;
        const d2 = (dx * dx + dz * dz) * inv;
        if (d2 >= 1) continue;
        const t = 1 - d2;
        arr[row + ix] += weight * t * t;
      }
    }
  }
}
