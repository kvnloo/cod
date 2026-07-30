/**
 * Playlist table.
 *
 * A playlist is the unit the queue buckets on: mode, team size, whether bots
 * are allowed, whether a live match accepts backfill, and the widening
 * overrides that express the playlist's stance on speed versus fairness.
 */

import { PRIVATE_WIDENING, RANKED_WIDENING } from './Widening';
import type { PlaylistDef, PlaylistId } from './types';

export const PLAYLISTS: Record<PlaylistId, PlaylistDef> = {
  'core-tdm-6v6': {
    id: 'core-tdm-6v6', name: 'Team Deathmatch', mode: 'tdm',
    teamSize: 6, teams: 2, minHumansToStart: 1,
    allowBots: true, allowBackfill: true, ranked: false,
  },
  'core-tdm-4v4': {
    id: 'core-tdm-4v4', name: 'Team Deathmatch (Small)', mode: 'tdm',
    teamSize: 4, teams: 2, minHumansToStart: 1,
    allowBots: true, allowBackfill: true, ranked: false,
  },
  'ranked-tdm-4v4': {
    id: 'ranked-tdm-4v4', name: 'Ranked Play', mode: 'tdm',
    teamSize: 4, teams: 2, minHumansToStart: 8,
    allowBots: false, allowBackfill: false, ranked: true,
    widening: RANKED_WIDENING,
  },
  'private-6v6': {
    id: 'private-6v6', name: 'Private Match', mode: 'tdm',
    teamSize: 6, teams: 2, minHumansToStart: 1,
    allowBots: true, allowBackfill: true, ranked: false,
    widening: PRIVATE_WIDENING,
  },
  'operation-coop-4': {
    id: 'operation-coop-4', name: 'Operation', mode: 'operation',
    teamSize: 4, teams: 1, minHumansToStart: 1,
    allowBots: true, allowBackfill: true, ranked: false,
  },
  'firefight-coop-4': {
    id: 'firefight-coop-4', name: 'Firefight', mode: 'firefight',
    teamSize: 4, teams: 1, minHumansToStart: 1,
    allowBots: true, allowBackfill: true, ranked: false,
  },
};

export const PLAYLIST_IDS = Object.keys(PLAYLISTS) as PlaylistId[];

export function playlist(id: PlaylistId): PlaylistDef {
  return PLAYLISTS[id] ?? PLAYLISTS['core-tdm-6v6'];
}

/** Total player slots in a match of this playlist (both teams). */
export function slotCount(def: PlaylistDef): number {
  return def.teamSize * def.teams;
}
