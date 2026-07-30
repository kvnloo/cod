/**
 * What a lobby is allowed to vote for.
 *
 * Modes mirror `GameModeId` exactly so a launch order feeds straight into
 * `DirectorAPI.startMatch(modeId, seed)` with no translation table.
 *
 * Maps are *rotation entries*, not separate levels: the world module ships one
 * level (`blackout`), and each entry re-lights it through the render API's
 * `setTimeOfDay` / `setWeather` hooks. That is an honest description of what
 * exists today — `MapDef.levelId` is the hook a second level drops into, and
 * nothing in the lobby assumes one level per map.
 */

import type { GameModeId, MapDef, ModeDef } from '../types';

export const MAPS: readonly MapDef[] = [
  {
    id: 'blackout_dusk',
    name: 'Blackout — Dusk',
    levelId: 'blackout',
    hour: 18.0, rain: 0, fog: 0.035, wind: 0.3,
    minPlayers: 2, maxPlayers: 12,
    tagline: 'Long shadows across the square.',
  },
  {
    id: 'blackout_firstlight',
    name: 'Blackout — First Light',
    levelId: 'blackout',
    hour: 6.2, rain: 0, fog: 0.055, wind: 0.2,
    minPlayers: 2, maxPlayers: 12,
    tagline: 'Cold haze, low sun down the main lane.',
  },
  {
    id: 'blackout_overcast',
    name: 'Blackout — Overcast',
    levelId: 'blackout',
    hour: 13.5, rain: 0.1, fog: 0.05, wind: 0.5,
    minPlayers: 2, maxPlayers: 12,
    tagline: 'Flat light, no cover from the sun.',
  },
  {
    id: 'blackout_storm',
    name: 'Blackout — Storm',
    levelId: 'blackout',
    hour: 15.0, rain: 0.8, fog: 0.09, wind: 0.9,
    minPlayers: 2, maxPlayers: 10,
    tagline: 'Rain kills your sightlines. Push close.',
  },
  {
    id: 'blackout_night',
    name: 'Blackout — Night',
    levelId: 'blackout',
    hour: 23.0, rain: 0.2, fog: 0.06, wind: 0.35,
    minPlayers: 2, maxPlayers: 12,
    tagline: 'Streetlights and muzzle flash.',
  },
];

export const MODES: readonly ModeDef[] = [
  {
    id: 'tdm',
    name: 'Team Deathmatch',
    short: 'TDM',
    teamCount: 2,
    minPlayers: 2, maxPlayers: 12,
    teamNames: ['Task Force', 'Spectre'],
    tagline: 'First to the score limit.',
  },
  {
    id: 'operation',
    name: 'Operation',
    short: 'OPS',
    teamCount: 1,
    minPlayers: 1, maxPlayers: 4,
    teamNames: ['Task Force', 'Hostiles'],
    tagline: 'Objective chain, buy between phases.',
  },
  {
    id: 'firefight',
    name: 'Firefight',
    short: 'FFT',
    teamCount: 1,
    minPlayers: 1, maxPlayers: 4,
    teamNames: ['Task Force', 'Hostiles'],
    tagline: 'Survive the waves.',
  },
];

export interface LobbyCatalog {
  maps: readonly MapDef[];
  modes: readonly ModeDef[];
}

export const DEFAULT_CATALOG: LobbyCatalog = { maps: MAPS, modes: MODES };

export function findMap(catalog: LobbyCatalog, id: string | null): MapDef | null {
  if (!id) return null;
  for (const m of catalog.maps) if (m.id === id) return m;
  return null;
}

export function findMode(catalog: LobbyCatalog, id: GameModeId | null): ModeDef | null {
  if (!id) return null;
  for (const m of catalog.modes) if (m.id === id) return m;
  return null;
}

/** First map/mode pair that is legal for `players`; never returns null. */
export function fallbackPair(catalog: LobbyCatalog, players: number): { map: MapDef; mode: ModeDef } {
  const mode = catalog.modes.find((m) => players >= m.minPlayers && players <= m.maxPlayers)
    ?? catalog.modes[0];
  const map = catalog.maps.find((m) => players >= m.minPlayers && players <= m.maxPlayers)
    ?? catalog.maps[0];
  return { map, mode };
}

/** True when a mode can be played at this head count. */
export function modeFits(mode: ModeDef, players: number): boolean {
  return players >= mode.minPlayers && players <= mode.maxPlayers;
}
