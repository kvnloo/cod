/**
 * Debug data for the influence field — the numeric half, with no renderer
 * dependency, so the benchmark and a headless host can dump the same picture
 * the debug scene draws.
 *
 * `SpawnDebugView` (three.js) consumes exactly these structures, so what you
 * see on screen and what the harness prints cannot drift apart.
 */

import { clamp } from './Math';
import type { InfluenceField } from './InfluenceField';
import type { SpawnZone, SpawnZones } from './SpawnZones';
import type { SpawnPoint, SpawnTeam } from './types';

export interface InfluenceSnapshot {
  nx: number;
  nz: number;
  cell: number;
  originX: number;
  originZ: number;
  /** Net ownership per cell, -1 hostile .. +1 friendly, row-major (z-major). */
  net: Float32Array;
  friendlyShare: number;
  hostileShare: number;
  polarisation: number;
}

export function influenceSnapshot(field: InfluenceField): InfluenceSnapshot {
  return {
    nx: field.nx,
    nz: field.nz,
    cell: field.config.cell,
    originX: field.originX,
    originZ: field.originZ,
    net: field.net.slice(),
    friendlyShare: field.friendlyShare,
    hostileShare: field.hostileShare,
    polarisation: field.polarisation,
  };
}

export interface PointDebug {
  id: number;
  x: number;
  y: number;
  z: number;
  zone: number;
  owner: SpawnTeam;
  /** Time-decayed death heat. */
  deaths: number;
  /** Seconds since the last grant, clamped to 999. */
  age: number;
  /** Zone suitability for the team this dump was taken for, 0..1. */
  suitability: number;
}

export function pointDebug(
  points: readonly SpawnPoint[], zones: SpawnZones, team: SpawnTeam, now: number,
): PointDebug[] {
  const out: PointDebug[] = [];
  for (const p of points) {
    const z = zones.get(p.zone);
    out.push({
      id: p.id,
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      zone: p.zone,
      owner: p.owner,
      deaths: p.deaths,
      age: Math.min(999, now - p.lastUsed),
      suitability: z ? zones.suitability(z, team, now) : 0.5,
    });
  }
  return out;
}

export interface ZoneDebug {
  id: number;
  x: number;
  z: number;
  radius: number;
  owner: SpawnTeam;
  homeOwner: SpawnTeam;
  influence: number;
  hostileOccupants: number;
  friendlyOccupants: number;
  trapScore: number;
  suppressed: boolean;
  grants: number;
  earlyDeaths: number;
}

export function zoneDebug(zones: SpawnZones, now: number): ZoneDebug[] {
  return zones.zones.map((z: SpawnZone) => ({
    id: z.id,
    x: z.x,
    z: z.z,
    radius: z.radius,
    owner: z.owner,
    homeOwner: z.homeOwner,
    influence: z.influence,
    hostileOccupants: z.hostileOccupants,
    friendlyOccupants: z.friendlyOccupants,
    trapScore: z.trapScore,
    suppressed: now < z.suppressedUntil,
    grants: z.grants,
    earlyDeaths: z.earlyDeaths,
  }));
}

/** Colour ramp shared by the ASCII dump and the three.js view. */
export function influenceColor(net: number, out: { r: number; g: number; b: number }): void {
  const t = clamp(net, -1, 1);
  if (t >= 0) {
    // neutral grey → friendly blue
    out.r = 0.22 * (1 - t) + 0.15 * t;
    out.g = 0.24 * (1 - t) + 0.55 * t;
    out.b = 0.26 * (1 - t) + 1.00 * t;
  } else {
    const s = -t;
    out.r = 0.22 * (1 - s) + 1.00 * s;
    out.g = 0.24 * (1 - s) + 0.28 * s;
    out.b = 0.26 * (1 - s) + 0.20 * s;
  }
}

const RAMP = '#@%*+=~-:. .:-~=+*%@#';

/**
 * Renders the field as text. Hostile ground is `#`/`@`, friendly ground is the
 * mirrored end of the ramp, no-man's-land is `.` — one glance tells you where
 * the front line is and whether the map has polarised at all.
 */
export function asciiInfluence(snap: InfluenceSnapshot, maxWidth = 64): string {
  const stepX = Math.max(1, Math.ceil(snap.nx / maxWidth));
  const stepZ = stepX * 2; // characters are about twice as tall as they are wide
  const lines: string[] = [];
  for (let iz = snap.nz - 1; iz >= 0; iz -= stepZ) {
    let line = '';
    for (let ix = 0; ix < snap.nx; ix += stepX) {
      let sum = 0, n = 0;
      for (let dz = 0; dz < stepZ && iz - dz >= 0; dz++) {
        for (let dx = 0; dx < stepX && ix + dx < snap.nx; dx++) {
          sum += snap.net[(iz - dz) * snap.nx + (ix + dx)];
          n++;
        }
      }
      const v = n > 0 ? sum / n : 0;
      const idx = Math.round((clamp(v, -1, 1) + 1) * 0.5 * (RAMP.length - 1));
      line += RAMP[idx];
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Renders a spawn/death heat map as text, using the same cell grid. */
export function asciiHeat(
  snap: InfluenceSnapshot, samples: ReadonlyArray<{ x: number; z: number }>, maxWidth = 64,
): string {
  const counts = new Float32Array(snap.nx * snap.nz);
  for (const s of samples) {
    const ix = clamp(Math.floor((s.x - snap.originX) / snap.cell), 0, snap.nx - 1);
    const iz = clamp(Math.floor((s.z - snap.originZ) / snap.cell), 0, snap.nz - 1);
    counts[iz * snap.nx + ix]++;
  }
  let peak = 0;
  for (let i = 0; i < counts.length; i++) peak = Math.max(peak, counts[i]);
  const ramp = ' .:-=+*#%@';
  const stepX = Math.max(1, Math.ceil(snap.nx / maxWidth));
  const stepZ = stepX * 2;
  const lines: string[] = [];
  for (let iz = snap.nz - 1; iz >= 0; iz -= stepZ) {
    let line = '';
    for (let ix = 0; ix < snap.nx; ix += stepX) {
      let sum = 0;
      for (let dz = 0; dz < stepZ && iz - dz >= 0; dz++) {
        for (let dx = 0; dx < stepX && ix + dx < snap.nx; dx++) {
          sum += counts[(iz - dz) * snap.nx + (ix + dx)];
        }
      }
      const t = peak > 0 ? clamp(sum / peak, 0, 1) : 0;
      line += ramp[Math.round(t * (ramp.length - 1))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}
