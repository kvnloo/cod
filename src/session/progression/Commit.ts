/**
 * Commit — the one place a match turns into permanent progress.
 *
 * `commitMatch(profile, record)` is a pure-ish function: it mutates the profile
 * it is handed and returns the after-action report. That shape is what makes
 * the authority story simple:
 *
 *   • host / offline → commit against the real profile, broadcast the report
 *   • client         → `previewMatch` commits against a *clone* so the player
 *                      sees a bar move immediately, then the host's report
 *                      replaces it and the real commit happens once
 *
 * Both paths run identical code, so a client prediction and a host result can
 * only differ if the underlying match records differ — which is exactly the
 * thing the netcode layer wants to be able to detect.
 */

import { applyCamoGrants, challengeXp, evaluateChallenges, type CamoGrant, type ChallengeDelta } from './Challenges';
import { rankForXp, rankName, rankProgress, MAX_RANK } from './Curves';
import { buildCombatRecord } from './Record';
import { ensureWeapons, newWeaponProgress, MAX_HISTORY } from './Store';
import { unlocksForRank } from './Unlocks';
import { attachmentsBetween, weaponTrack } from './WeaponTracks';
import { weaponLevelForXp, weaponProgressAt } from './Curves';
import { CATEGORY_ORDER, xpSourceMeta } from './XpSources';
import type {
  AfterActionReport, CamoReportRow, ChallengeReportRow, MatchRecord, ProfileV3,
  WeaponReportRow, WeaponUnlockDef, XpCategory, XpLedgerRow,
} from './types';
import type { UnlockDef } from '../../game/types';

export interface CommitOptions {
  /** Multiplier on *match* XP. Challenge and camo XP are always paid at face. */
  multiplier?: number;
  now?: number;
  /** Set false to build the report without touching the profile's `history`. */
  recordHistory?: boolean;
}

export interface WeaponLevelUp {
  weapon: string;
  from: number;
  to: number;
  unlocked: WeaponUnlockDef[];
}

export interface CommitResult {
  report: AfterActionReport;
  /** Ranks crossed, in order. Empty when the player did not promote. */
  rankUps: number[];
  unlocks: UnlockDef[];
  weaponLevelUps: WeaponLevelUp[];
  challengeDeltas: ChallengeDelta[];
  camoGrants: CamoGrant[];
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Deep clone of a profile — plain JSON, no prototypes involved. */
export function cloneProfile(p: ProfileV3): ProfileV3 {
  return JSON.parse(JSON.stringify(p)) as ProfileV3;
}

export function commitMatch(
  profile: ProfileV3,
  record: MatchRecord,
  opts: CommitOptions = {},
): CommitResult {
  const multiplier = opts.multiplier && opts.multiplier > 0 ? opts.multiplier : 1;
  const now = opts.now ?? Date.now();
  ensureWeapons(profile);

  /* ------------------------------------------------------- 1. snapshot -- */
  const xpBefore = profile.xp;
  const rankBefore = rankForXp(xpBefore);
  const weaponLevelBefore = new Map<string, number>();
  for (const w of record.weapons) {
    weaponLevelBefore.set(w.weapon, profile.weapons[w.weapon]?.level ?? 1);
  }

  /* ------------------------------------- 2. lifetime + per-weapon stats -- */
  const s = profile.stats;
  s.matches += 1;
  if (record.win) s.wins += 1; else s.losses += 1;
  s.kills += record.kills;
  s.deaths += record.deaths;
  s.assists += record.assists;
  s.headshots += record.headshots;
  s.longshots += record.longshots;
  s.objectives += record.objectives;
  s.wavesCleared += record.wavesCleared;
  s.killstreaksUsed += record.killstreaksUsed;
  s.timePlayed += record.durationSec;
  s.shotsFired += record.shotsFired;
  s.shotsHit += record.shotsHit;
  s.score += record.score;
  s.revengeKills += record.revengeKills;
  s.firstBloods += record.firstBloods;
  s.bestStreak = Math.max(s.bestStreak, record.bestStreak);
  s.bestMultikill = Math.max(s.bestMultikill, record.bestMultikill);

  const weaponLevelUps: WeaponLevelUp[] = [];
  for (const mw of record.weapons) {
    let w = profile.weapons[mw.weapon];
    if (!w) { w = newWeaponProgress(mw.weapon); profile.weapons[mw.weapon] = w; }
    const before = weaponLevelBefore.get(mw.weapon) ?? w.level;

    w.xp += Math.max(0, Math.round(mw.xp * multiplier));
    w.level = weaponLevelForXp(w.xp);

    const st = w.stats;
    st.kills += mw.kills;
    st.deaths += mw.deaths;
    st.headshots += mw.headshots;
    st.longshots += mw.longshots;
    st.pointblankKills += mw.pointblankKills;
    st.hipfireKills += mw.hipfireKills;
    st.adsKills += mw.adsKills;
    st.killstreakKills += mw.killstreakKills;
    st.revengeKills += mw.revengeKills;
    st.firstBloods += mw.firstBloods;
    st.multikills += mw.multikills;
    st.assists += mw.assists;
    st.shotsFired += mw.shotsFired;
    st.shotsHit += mw.shotsHit;
    st.damage += mw.damage;
    st.timeUsed += mw.timeUsed;

    s.multikills += mw.multikills;

    if (w.level > before) {
      weaponLevelUps.push({
        weapon: mw.weapon,
        from: before,
        to: w.level,
        unlocked: attachmentsBetween(mw.weapon, before, w.level),
      });
    }
  }

  /* ------------------------------------------- 3. challenges and camos -- */
  const challengeDeltas = evaluateChallenges(profile);
  const camoGrants = applyCamoGrants(profile, challengeDeltas);
  const bonusXp = challengeXp(challengeDeltas) + camoGrants.reduce((a, g) => a + g.xp, 0);

  for (const d of challengeDeltas) {
    if (!d.completedNow) continue;
    const r = d.def.reward;
    if (r && (r.kind === 'unlock' || r.kind === 'title') && !profile.extraUnlocks.includes(r.id)) {
      profile.extraUnlocks.push(r.id);
    }
  }

  /* --------------------------------------------------------- 4. bank XP -- */
  const baseXp = Math.max(0, Math.round(record.xpTotal));
  const matchXp = Math.round(baseXp * multiplier);
  const totalXp = matchXp + bonusXp;
  profile.xp = Math.max(0, profile.xp + totalXp);
  const rankAfter = rankForXp(profile.xp);
  profile.rank = rankAfter;

  const rankUps: number[] = [];
  const unlocks: UnlockDef[] = [];
  for (let r = rankBefore + 1; r <= rankAfter; r++) {
    rankUps.push(r);
    for (const u of unlocksForRank(r)) unlocks.push(u);
  }

  /* ---------------------------------------------------- 5. personal bests -- */
  const bests = profile.bests;
  const personalBests: string[] = [];
  const accuracy = record.shotsFired > 0 ? record.shotsHit / record.shotsFired : 0;
  const bump = (key: keyof typeof bests, value: number, text: string): void => {
    if (value > bests[key]) { bests[key] = value; personalBests.push(text); }
  };
  bump('kills', record.kills, `Most kills in a match: ${record.kills}`);
  bump('score', record.score, `Highest score: ${record.score}`);
  bump('streak', record.bestStreak, `New best killstreak: ${record.bestStreak}`);
  bump('multikill', record.bestMultikill, `Largest multikill: ${record.bestMultikill}`);
  bump('headshots', record.headshots, `Most headshots in a match: ${record.headshots}`);
  bump('xp', totalXp, `Most XP in a match: ${totalXp}`);
  if (record.shotsFired >= 40) {
    bump('accuracy', accuracy, `Best accuracy: ${(accuracy * 100).toFixed(0)}%`);
  }

  /* ------------------------------------------------------------ 6. history -- */
  if (opts.recordHistory !== false) {
    profile.history.unshift({
      mode: record.mode, win: record.win, kills: record.kills, deaths: record.deaths,
      score: record.score, xp: totalXp, durationSec: record.durationSec, at: now,
    });
    if (profile.history.length > MAX_HISTORY) profile.history.length = MAX_HISTORY;
  }
  profile.lastMode = record.mode;
  profile.updatedAt = now;

  /* -------------------------------------------------------- 7. the report -- */
  const rows: XpLedgerRow[] = record.ledger.map((r) => ({
    ...r, xp: Math.round(r.xp * multiplier),
  }));
  if (bonusXp > 0) {
    rows.push({ source: 'challenge', label: 'Challenges', xp: bonusXp, count: challengeDeltas.filter((d) => d.completedNow).length + camoGrants.length });
  }
  rows.sort((a, b) => b.xp - a.xp || a.label.localeCompare(b.label));

  const catTotals = new Map<XpCategory, number>();
  for (const r of rows) {
    const cat = xpSourceMeta(r.source).category;
    catTotals.set(cat, (catTotals.get(cat) ?? 0) + r.xp);
  }
  const byCategory = CATEGORY_ORDER
    .filter((c) => (catTotals.get(c) ?? 0) !== 0)
    .map((c) => ({ category: c, xp: catTotals.get(c) ?? 0 }));

  const rp = rankProgress(profile.xp);

  const weaponRows: WeaponReportRow[] = record.weapons
    .filter((w) => w.xp > 0 || w.kills > 0 || w.shotsFired > 0)
    .map((mw) => {
      const t = weaponTrack(mw.weapon);
      const w = profile.weapons[mw.weapon];
      const prog = weaponProgressAt(w ? w.xp : 0);
      const before = weaponLevelBefore.get(mw.weapon) ?? 1;
      return {
        id: mw.weapon,
        name: t?.name ?? mw.weapon,
        cls: t?.cls ?? 'assault',
        xpGained: Math.round(mw.xp * multiplier),
        levelBefore: before,
        levelAfter: prog.level,
        intoLevel: prog.into,
        forNext: prog.needed,
        pct: clamp01(prog.pct),
        maxed: prog.maxed,
        kills: mw.kills,
        headshots: mw.headshots,
        accuracy: mw.shotsFired > 0 ? mw.shotsHit / mw.shotsFired : 0,
        unlocked: attachmentsBetween(mw.weapon, before, prog.level),
      };
    })
    .sort((a, b) => b.xpGained - a.xpGained);

  const challengeRows: ChallengeReportRow[] = challengeDeltas
    .filter((d) => d.after > d.before || d.completedNow)
    .map((d) => ({
      id: d.def.id,
      name: d.def.name,
      description: d.def.description,
      before: d.before,
      after: d.after,
      goal: d.def.goal,
      complete: d.completedNow,
      xp: d.completedNow ? d.def.xp : 0,
      reward: d.def.reward,
      weapon: d.def.scope === 'weapon' ? d.def.target : undefined,
    }))
    .sort((a, b) => Number(b.complete) - Number(a.complete)
      || (b.after / b.goal) - (a.after / a.goal));

  const camoRows: CamoReportRow[] = camoGrants.map((g) => ({
    weapon: g.weapon,
    weaponName: weaponTrack(g.weapon)?.name ?? g.weapon,
    camo: g.camo,
    camoName: g.camo[0].toUpperCase() + g.camo.slice(1),
    kind: g.camo === 'gold' || g.camo === 'platinum' || g.camo === 'obsidian' ? 'mastery' : 'base',
  }));

  const report: AfterActionReport = {
    version: 1,
    provisional: false,
    mode: record.mode,
    modeName: record.modeName,
    win: record.win,
    durationSec: record.durationSec,
    seed: record.seed,
    replayHash: record.replayHash,
    scoreboard: {
      score: record.score,
      kills: record.kills,
      deaths: record.deaths,
      assists: record.assists,
      kd: record.deaths > 0 ? record.kills / record.deaths : record.kills,
      headshots: record.headshots,
      accuracy,
      bestStreak: record.bestStreak,
      bestMultikill: record.bestMultikill,
      objectives: record.objectives,
      wavesCleared: record.wavesCleared,
      killstreaksUsed: record.killstreaksUsed,
    },
    xp: { total: totalXp, base: baseXp, multiplier, rows, byCategory },
    rank: {
      before: rankBefore,
      after: rankAfter,
      nameBefore: rankName(rankBefore),
      nameAfter: rankName(rankAfter),
      xpBefore,
      xpAfter: profile.xp,
      intoRank: rp.into,
      forNext: rp.needed,
      pct: clamp01(rp.pct),
      promoted: rankAfter > rankBefore,
      maxed: rankAfter >= MAX_RANK,
      unlocks,
    },
    weapons: weaponRows,
    challenges: challengeRows,
    camos: camoRows,
    personalBests,
    record: buildCombatRecord(profile),
  };

  return { report, rankUps, unlocks, weaponLevelUps, challengeDeltas, camoGrants };
}

/**
 * Client-side prediction: identical maths against a throwaway copy of the
 * profile. The returned report is flagged `provisional` so the UI can render it
 * with the "pending" treatment until the host's version lands.
 */
export function previewMatch(
  profile: ProfileV3,
  record: MatchRecord,
  opts: CommitOptions = {},
): AfterActionReport {
  const clone = cloneProfile(profile);
  const { report } = commitMatch(clone, record, { ...opts, recordHistory: false });
  report.provisional = true;
  return report;
}
