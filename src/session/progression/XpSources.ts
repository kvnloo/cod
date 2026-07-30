/**
 * XP source taxonomy.
 *
 * `Scoring` and `Match` already award XP with human labels ("Headshots",
 * "Multikills", "Match Win"). Rather than replace that vocabulary with a
 * parallel one, this maps it onto stable ids so the after-action screen can
 * group and order rows, and so the netcode layer can validate an XP claim
 * source by source.
 */

import type { XpCategory, XpSourceId, XpSourceMeta } from './types';

export const XP_SOURCES: readonly XpSourceMeta[] = [
  { id: 'kill', label: 'Kills', category: 'combat', order: 0 },
  { id: 'headshot', label: 'Headshots', category: 'combat', order: 1 },
  { id: 'longshot', label: 'Longshots', category: 'combat', order: 2 },
  { id: 'pointblank', label: 'Point Blank', category: 'combat', order: 3 },
  { id: 'objectiveKill', label: 'Objective Kills', category: 'combat', order: 4 },
  { id: 'assist', label: 'Assists', category: 'combat', order: 5 },
  { id: 'execution', label: 'Executions', category: 'combat', order: 6 },
  { id: 'killstreakKill', label: 'Killstreak Kills', category: 'combat', order: 7 },

  { id: 'objective', label: 'Objectives', category: 'objective', order: 0 },
  { id: 'capture', label: 'Captures', category: 'objective', order: 1 },
  { id: 'wave', label: 'Waves Cleared', category: 'objective', order: 2 },
  { id: 'revive', label: 'Revives', category: 'objective', order: 3 },

  { id: 'multikill', label: 'Multikills', category: 'bonus', order: 0 },
  { id: 'streak', label: 'Killstreaks', category: 'bonus', order: 1 },
  { id: 'revenge', label: 'Revenge', category: 'bonus', order: 2 },
  { id: 'firstblood', label: 'First Blood', category: 'bonus', order: 3 },

  { id: 'challenge', label: 'Challenges', category: 'challenge', order: 0 },
  { id: 'matchResult', label: 'Match Bonus', category: 'match', order: 0 },
  { id: 'other', label: 'Other', category: 'match', order: 9 },
];

const META = new Map<XpSourceId, XpSourceMeta>(XP_SOURCES.map((s) => [s.id, s]));

export function xpSourceMeta(id: XpSourceId): XpSourceMeta {
  return META.get(id) ?? META.get('other')!;
}

export const CATEGORY_ORDER: readonly XpCategory[] = ['combat', 'objective', 'bonus', 'challenge', 'match'];

/** Exact label → source. Covers every string the existing systems emit today. */
const EXACT: Readonly<Record<string, XpSourceId>> = {
  'Kills': 'kill',
  'Kill': 'kill',
  'Headshots': 'headshot',
  'Headshot': 'headshot',
  'Longshots': 'longshot',
  'Longshot': 'longshot',
  'Point Blank': 'pointblank',
  'Point Blanks': 'pointblank',
  'Objective Kills': 'objectiveKill',
  'Assists': 'assist',
  'Assist': 'assist',
  'Executions': 'execution',
  'Multikills': 'multikill',
  'Killstreaks': 'streak',
  'Objectives': 'objective',
  'Captures': 'capture',
  'Capture': 'capture',
  'Waves Cleared': 'wave',
  'Wave Cleared': 'wave',
  'Survived Wave': 'wave',
  'Revives': 'revive',
  'Revenge': 'revenge',
  'Revenge Kills': 'revenge',
  'First Blood': 'firstblood',
  'Challenges': 'challenge',
  'Match Win': 'matchResult',
  'Match Complete': 'matchResult',
  'Match Loss': 'matchResult',
};

/**
 * Maps a ledger label onto a source id. Unknown "<something> Kills" labels —
 * `Scoring` builds those from the damage source, so `Sentry Kills`,
 * `Airstrike Kills`, … — land on `killstreakKill` rather than `other`.
 */
export function classifyXpReason(reason: string): XpSourceId {
  const hit = EXACT[reason];
  if (hit) return hit;
  const lower = reason.toLowerCase();
  if (lower.endsWith('kills') || lower.endsWith('kill')) return 'killstreakKill';
  if (lower.includes('objective')) return 'objective';
  if (lower.includes('wave')) return 'wave';
  if (lower.includes('match')) return 'matchResult';
  if (lower.includes('challenge')) return 'challenge';
  return 'other';
}

/** Canonical display label for a source, used when a row has no natural label. */
export function xpSourceLabel(id: XpSourceId): string { return xpSourceMeta(id).label; }
