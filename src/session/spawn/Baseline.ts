/**
 * The *previous* spawn selector, preserved verbatim as a benchmark baseline.
 *
 * This is the scoring that shipped in `src/game/Spawns.ts` before the influence
 * map: a single-pass weighted sum over a fixed node list, with visibility
 * measured only from one viewpoint and no territory, no zones, no death memory
 * and no hard vetoes. It is kept — and only ever called by `Sim.ts` — so the
 * claim "the new system is better" is a measured number against the real thing
 * rather than against a straw man.
 *
 * Do not use it in the game. It exists to lose.
 */

import { distXZ, dist3 } from './Math';
import type { RandomSource, SpawnLos, SpawnPoint, Vec3 } from './types';

export interface BaselineQuery {
  viewOrigin: Vec3;
  viewDir: Vec3;
  /** cos(halfFov); values > 1 disable the cone entirely. */
  viewCos: number;
  idealDistance: number;
  minDistance: number;
  maxDistance: number;
  threats: readonly Vec3[];
  allies: readonly Vec3[];
  now: number;
  requireHidden: boolean;
  cooldown: number;
}

export function baselineQuery(): BaselineQuery {
  return {
    viewOrigin: { x: 0, y: 1.6, z: 0 },
    viewDir: { x: 0, y: 0, z: -1 },
    viewCos: 2,
    idealDistance: 34,
    minDistance: 16,
    maxDistance: 78,
    threats: [],
    allies: [],
    now: 0,
    requireHidden: false,
    cooldown: 9,
  };
}

function hasLos(los: SpawnLos | null, a: Vec3, b: Vec3): boolean {
  if (!los) return true;
  return los.lineOfSight(a.x, a.y, a.z, b.x, b.y, b.z);
}

function isVisible(p: Vec3, q: BaselineQuery, los: SpawnLos | null): boolean {
  const dx = p.x - q.viewOrigin.x, dy = p.y - q.viewOrigin.y, dz = p.z - q.viewOrigin.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) return true;
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  if (nx * q.viewDir.x + ny * q.viewDir.y + nz * q.viewDir.z < q.viewCos) return false;
  if (dist > 140) return false;
  return hasLos(los, q.viewOrigin, { x: p.x, y: p.y + 1.1, z: p.z });
}

/** The old selector. Returns the chosen point, or null when the set is empty. */
export function baselinePick(
  points: readonly SpawnPoint[], q: BaselineQuery, los: SpawnLos | null, rand: RandomSource,
): SpawnPoint | null {
  if (points.length === 0) return null;
  let best: SpawnPoint | null = null;
  let bestScore = -Infinity;
  let bestHidden: SpawnPoint | null = null;
  let bestHiddenScore = -Infinity;

  for (const n of points) {
    const d = dist3(n.position, q.viewOrigin);
    if (d > q.maxDistance * 1.6) continue;

    let score = 0;
    const band = Math.abs(d - q.idealDistance) / Math.max(1, q.idealDistance);
    score += 30 * Math.exp(-band * band * 2.2);
    if (d < q.minDistance) score -= 60 * (1 - d / Math.max(0.001, q.minDistance));
    if (d > q.maxDistance) score -= 24 * ((d - q.maxDistance) / Math.max(1, q.maxDistance));

    const visible = isVisible(n.position, q, los);
    if (visible) score -= 85;

    let nearestThreat = Infinity;
    let threatLos = false;
    for (const t of q.threats) {
      const td = dist3(n.position, t);
      if (td < nearestThreat) nearestThreat = td;
      if (!threatLos && td < 42 && hasLos(los, n.position, t)) threatLos = true;
    }
    if (nearestThreat < 24) score -= 55 * (1 - nearestThreat / 24);
    if (threatLos) score -= 45;

    let nearestAlly = Infinity;
    for (const a of q.allies) nearestAlly = Math.min(nearestAlly, dist3(n.position, a));
    if (nearestAlly < 30) score += 14 * (1 - nearestAlly / 30);

    const since = q.now - n.lastUsed;
    if (since < q.cooldown) score -= 40 * (1 - since / q.cooldown);

    score += n.openness * 4;
    score += rand.range(-3.5, 3.5);

    if (score > bestScore) { bestScore = score; best = n; }
    if (!visible && !threatLos && score > bestHiddenScore) { bestHiddenScore = score; bestHidden = n; }
  }

  if (q.requireHidden && bestHidden) return bestHidden;
  return best ?? bestHidden;
}

/** Distance to the nearest threat, for the benchmark's bookkeeping. */
export function nearestThreatDistance(p: Vec3, threats: readonly Vec3[]): number {
  let best = Infinity;
  for (const t of threats) {
    const d = distXZ(p, t);
    if (d < best) best = d;
  }
  return best;
}
