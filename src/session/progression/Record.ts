/**
 * The combat record — lifetime stats, derived on demand.
 *
 * Nothing here is stored: every ratio is computed from the counters in the
 * profile so a schema change can never leave a stale, wrong K/D on screen.
 */

import { CHALLENGES } from './Challenges';
import { rankName, rankProgress } from './Curves';
import { WEAPON_TRACKS, weaponTrack } from './WeaponTracks';
import type { CombatRecord, CombatRecordWeaponRow, ProfileV3 } from './types';

function ratio(a: number, b: number): number {
  return b > 0 ? a / b : a;
}

export function buildCombatRecord(profile: ProfileV3): CombatRecord {
  const s = profile.stats;
  const rp = rankProgress(profile.xp);

  const weapons: CombatRecordWeaponRow[] = [];
  let camosUnlocked = 0;
  for (const t of WEAPON_TRACKS) {
    const w = profile.weapons[t.id];
    if (!w) continue;
    camosUnlocked += w.camos.length;
    weapons.push({
      id: t.id,
      name: t.name,
      cls: t.cls,
      level: w.level,
      xp: w.xp,
      kills: w.stats.kills,
      deaths: w.stats.deaths,
      kd: ratio(w.stats.kills, w.stats.deaths),
      headshots: w.stats.headshots,
      headshotRate: ratio(w.stats.headshots, w.stats.kills),
      accuracy: w.stats.shotsFired > 0 ? w.stats.shotsHit / w.stats.shotsFired : 0,
      shotsFired: w.stats.shotsFired,
      camos: w.camos.length,
    });
  }
  weapons.sort((a, b) => b.kills - a.kills || b.xp - a.xp);

  let challengesComplete = 0;
  for (const c of CHALLENGES) if (profile.challenges[c.id]?.done) challengesComplete++;

  const minutes = s.timePlayed / 60;
  const fav = weapons.find((w) => w.kills > 0) ?? null;

  return {
    rank: rp.rank,
    rankName: rankName(rp.rank),
    xp: profile.xp,
    xpIntoRank: rp.into,
    xpForNext: rp.needed,
    matches: s.matches,
    wins: s.wins,
    losses: Math.max(s.losses, Math.max(0, s.matches - s.wins)),
    winRate: ratio(s.wins, s.matches),
    kills: s.kills,
    deaths: s.deaths,
    assists: s.assists,
    kd: ratio(s.kills, s.deaths),
    headshots: s.headshots,
    headshotRate: ratio(s.headshots, s.kills),
    shotsFired: s.shotsFired,
    shotsHit: s.shotsHit,
    accuracy: s.shotsFired > 0 ? s.shotsHit / s.shotsFired : 0,
    bestStreak: s.bestStreak,
    bestMultikill: s.bestMultikill,
    objectives: s.objectives,
    timePlayed: s.timePlayed,
    killsPerMinute: minutes > 0 ? s.kills / minutes : 0,
    scorePerMinute: minutes > 0 ? s.score / minutes : 0,
    challengesComplete,
    challengesTotal: CHALLENGES.length,
    camosUnlocked,
    bests: { ...profile.bests },
    weapons,
    favouriteWeapon: fav ? fav.id : null,
  };
}

/** Compact per-class rollup for the "weapons" tab of the combat record. */
export function classRollup(profile: ProfileV3): Array<{
  cls: string; kills: number; level: number; maxLevel: number; camos: number;
}> {
  const map = new Map<string, { cls: string; kills: number; level: number; maxLevel: number; camos: number }>();
  for (const t of WEAPON_TRACKS) {
    const w = profile.weapons[t.id];
    const row = map.get(t.cls) ?? { cls: t.cls, kills: 0, level: 0, maxLevel: 0, camos: 0 };
    row.kills += w?.stats.kills ?? 0;
    row.level += w?.level ?? 1;
    row.maxLevel += t.maxLevel;
    row.camos += w?.camos.length ?? 0;
    map.set(t.cls, row);
  }
  return [...map.values()].sort((a, b) => b.kills - a.kills);
}

/** Human summary line, useful for a profile card. */
export function recordHeadline(r: CombatRecord): string {
  const t = weaponTrack(r.favouriteWeapon ?? '');
  const fav = t ? ` · ${t.name}` : '';
  return `${r.rankName} · ${r.kd.toFixed(2)} K/D · ${(r.winRate * 100).toFixed(0)}% WR${fav}`;
}
