/**
 * Challenges — the second progression currency.
 *
 * Every challenge is `(scope, stat, goal)` evaluated against the *lifetime*
 * counters in the profile, never against a per-match delta. That makes them
 * idempotent: replaying a commit, or reconciling a host report over a
 * client-predicted one, can never double-award, and a corrupted challenge map
 * self-heals on the next match because progress is recomputed from stats.
 *
 * Camo challenges are generated per weapon from `Camos.ts` templates so adding
 * a weapon to `WEAPON_TRACKS` adds its whole camo page for free.
 */

import { BASE_CAMOS, MASTERY_XP } from './Camos';
import { WEAPON_TRACKS, weaponTrack } from './WeaponTracks';
import type {
  ChallengeDef, ChallengeState, ChallengeStat, LifetimeStatsV3,
  ProfileV3, WeaponProgress, WeaponStats,
} from './types';

/* ------------------------------------------------------ player ladders -- */

interface ChainSeed {
  chain: string;
  name: string;
  stat: ChallengeStat;
  /** One entry per tier. */
  tiers: ReadonlyArray<{ goal: number; xp: number; title?: string }>;
  describe: (goal: number) => string;
}

const PLAYER_CHAINS: readonly ChainSeed[] = [
  {
    chain: 'marksman', name: 'Marksman', stat: 'headshots',
    tiers: [{ goal: 25, xp: 1000 }, { goal: 100, xp: 2500 }, { goal: 250, xp: 6000, title: 'Headhunter' }],
    describe: (g) => `Get ${g} headshot kills.`,
  },
  {
    chain: 'sharpshooter', name: 'Sharpshooter', stat: 'longshots',
    tiers: [{ goal: 10, xp: 800 }, { goal: 50, xp: 2200 }, { goal: 150, xp: 5000, title: 'Reach Out' }],
    describe: (g) => `Get ${g} longshot kills.`,
  },
  {
    chain: 'relentless', name: 'Relentless', stat: 'bestStreak',
    tiers: [{ goal: 5, xp: 600 }, { goal: 10, xp: 1800 }, { goal: 20, xp: 5000, title: 'Untouchable' }],
    describe: (g) => `Reach a ${g} killstreak without dying.`,
  },
  {
    chain: 'payback', name: 'Payback', stat: 'revengeKills',
    tiers: [{ goal: 5, xp: 600 }, { goal: 25, xp: 2000 }, { goal: 75, xp: 4500, title: 'Vendetta' }],
    describe: (g) => `Get ${g} revenge kills.`,
  },
  {
    chain: 'firststrike', name: 'First Strike', stat: 'firstBloods',
    tiers: [{ goal: 3, xp: 700 }, { goal: 15, xp: 2400 }, { goal: 40, xp: 5500, title: 'Opening Act' }],
    describe: (g) => `Draw first blood ${g} times.`,
  },
  {
    chain: 'operator', name: 'Operator', stat: 'objectives',
    tiers: [{ goal: 10, xp: 900 }, { goal: 50, xp: 2600 }, { goal: 150, xp: 6000, title: 'Tip of the Spear' }],
    describe: (g) => `Complete ${g} objectives.`,
  },
  {
    chain: 'victor', name: 'Victor', stat: 'wins',
    tiers: [{ goal: 5, xp: 800 }, { goal: 25, xp: 2400 }, { goal: 75, xp: 7000, title: 'Decorated' }],
    describe: (g) => `Win ${g} matches.`,
  },
  {
    chain: 'veteran', name: 'Veteran', stat: 'matches',
    tiers: [{ goal: 10, xp: 500 }, { goal: 50, xp: 1800 }, { goal: 150, xp: 5000, title: 'Lifer' }],
    describe: (g) => `Play ${g} matches.`,
  },
  {
    chain: 'closequarters', name: 'Close Quarters', stat: 'pointblankKills',
    tiers: [{ goal: 15, xp: 700 }, { goal: 60, xp: 2100 }, { goal: 180, xp: 4800, title: 'In Your Face' }],
    describe: (g) => `Get ${g} point-blank kills.`,
  },
  {
    chain: 'support', name: 'Support', stat: 'assists',
    tiers: [{ goal: 20, xp: 600 }, { goal: 100, xp: 2000 }, { goal: 300, xp: 4500, title: 'Team Player' }],
    describe: (g) => `Get ${g} assists.`,
  },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

function buildPlayerChallenges(): ChallengeDef[] {
  const out: ChallengeDef[] = [];
  for (const c of PLAYER_CHAINS) {
    let prev: string | undefined;
    c.tiers.forEach((t, i) => {
      const id = `chal.${c.chain}.${i + 1}`;
      out.push({
        id,
        name: `${c.name} ${ROMAN[i + 1]}`.trim(),
        description: c.describe(t.goal),
        scope: 'player',
        stat: c.stat,
        goal: t.goal,
        xp: t.xp,
        chain: c.chain,
        tier: i + 1,
        requires: prev,
        reward: t.title ? { kind: 'title', id: `title.${c.chain}`, name: t.title } : undefined,
      });
      prev = id;
    });
  }
  return out;
}

/* ------------------------------------------------------ camo challenges -- */

function buildCamoChallenges(): ChallengeDef[] {
  const out: ChallengeDef[] = [];
  for (const w of WEAPON_TRACKS) {
    for (const camo of BASE_CAMOS) {
      out.push({
        id: `camo.${w.id}.${camo.id}`,
        name: `${w.name} — ${camo.name}`,
        description: camo.description.replace('{goal}', String(camo.goal)),
        scope: 'weapon',
        target: w.id,
        stat: camo.stat,
        goal: camo.goal,
        xp: camo.xp,
        reward: { kind: 'camo', id: camo.id, name: camo.name },
      });
    }
  }
  return out;
}

/* --------------------------------------------------- weapon mastery set -- */

function buildWeaponMasteryChallenges(): ChallengeDef[] {
  const out: ChallengeDef[] = [];
  for (const w of WEAPON_TRACKS) {
    out.push({
      id: `mast.${w.id}.maxlevel`,
      name: `${w.name} — Max Level`,
      description: `Reach weapon level ${w.maxLevel} with the ${w.name}.`,
      scope: 'weapon',
      target: w.id,
      stat: 'level',
      goal: w.maxLevel,
      xp: 4000,
      reward: { kind: 'unlock', id: `mastery.${w.id}`, name: `${w.name} Mastery` },
    });
  }
  return out;
}

export const CHALLENGES: readonly ChallengeDef[] = [
  ...buildPlayerChallenges(),
  ...buildWeaponMasteryChallenges(),
  ...buildCamoChallenges(),
];

const BY_ID = new Map<string, ChallengeDef>(CHALLENGES.map((c) => [c.id, c]));

export function challengeDef(id: string): ChallengeDef | null { return BY_ID.get(id) ?? null; }

export function challengesForWeapon(weaponId: string): ChallengeDef[] {
  return CHALLENGES.filter((c) => c.scope === 'weapon' && c.target === weaponId);
}

export function playerChallenges(): ChallengeDef[] {
  return CHALLENGES.filter((c) => c.scope === 'player');
}

/* ------------------------------------------------------------ evaluation -- */

const LIFETIME_KEYS: ReadonlySet<string> = new Set<keyof LifetimeStatsV3>([
  'matches', 'wins', 'losses', 'kills', 'deaths', 'headshots', 'assists',
  'bestStreak', 'wavesCleared', 'objectives', 'timePlayed', 'killstreaksUsed',
  'shotsFired', 'shotsHit', 'score', 'longshots', 'revengeKills', 'firstBloods',
  'bestMultikill', 'multikills',
]);

export function weaponStatValue(w: WeaponProgress | undefined, stat: ChallengeStat): number {
  if (!w) return 0;
  if (stat === 'level') return w.level;
  const v = (w.stats as unknown as Record<string, number>)[stat];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Player-scope stat: lifetime counter when one exists, otherwise the sum of the
 * per-weapon counter. That is what lets "180 point-blank kills" work without
 * duplicating every weapon counter at the profile level.
 */
export function playerStatValue(profile: ProfileV3, stat: ChallengeStat): number {
  if (stat === 'level') return profile.rank;
  if (LIFETIME_KEYS.has(stat)) {
    const v = (profile.stats as unknown as Record<string, number>)[stat];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  let sum = 0;
  for (const id of Object.keys(profile.weapons)) {
    sum += weaponStatValue(profile.weapons[id], stat);
  }
  return sum;
}

function classStatValue(profile: ProfileV3, cls: string, stat: ChallengeStat): number {
  let sum = 0;
  for (const t of WEAPON_TRACKS) {
    if (t.cls !== cls) continue;
    sum += weaponStatValue(profile.weapons[t.id], stat);
  }
  return sum;
}

/** Current raw value of the stat a challenge measures. */
export function challengeValue(profile: ProfileV3, def: ChallengeDef): number {
  if (def.scope === 'weapon') return weaponStatValue(profile.weapons[def.target ?? ''], def.stat);
  if (def.scope === 'class') return classStatValue(profile, def.target ?? '', def.stat);
  return playerStatValue(profile, def.stat);
}

export interface ChallengeDelta {
  def: ChallengeDef;
  before: number;
  after: number;
  completedNow: boolean;
}

export function emptyChallengeState(): ChallengeState {
  return { progress: 0, done: false, doneAt: 0 };
}

/**
 * Recomputes every challenge from lifetime stats and returns the ones that
 * moved. `profile.challenges` is updated in place. Pure apart from that.
 */
export function evaluateChallenges(profile: ProfileV3): ChallengeDelta[] {
  const out: ChallengeDelta[] = [];
  for (const def of CHALLENGES) {
    const prev = profile.challenges[def.id] ?? emptyChallengeState();
    const value = Math.min(def.goal, challengeValue(profile, def));
    if (value === prev.progress && (prev.done || value < def.goal)) {
      if (!profile.challenges[def.id]) profile.challenges[def.id] = prev;
      continue;
    }
    const completedNow = !prev.done && value >= def.goal;
    const next: ChallengeState = {
      progress: value,
      done: prev.done || value >= def.goal,
      doneAt: prev.done ? prev.doneAt : (completedNow ? profile.stats.matches : 0),
    };
    profile.challenges[def.id] = next;
    if (value !== prev.progress || completedNow) {
      out.push({ def, before: prev.progress, after: value, completedNow });
    }
  }
  return out;
}

/** Total XP owed for the challenges that completed in this evaluation pass. */
export function challengeXp(deltas: readonly ChallengeDelta[]): number {
  let xp = 0;
  for (const d of deltas) if (d.completedNow) xp += d.def.xp;
  return xp;
}

/* ------------------------------------------------------ mastery / camos -- */

export interface CamoGrant {
  weapon: string;
  camo: string;
  xp: number;
}

/**
 * Applies camo rewards from completed challenges, then walks the mastery rules
 * (Gold → Platinum → Obsidian). Returns everything newly granted.
 */
export function applyCamoGrants(profile: ProfileV3, deltas: readonly ChallengeDelta[]): CamoGrant[] {
  const grants: CamoGrant[] = [];

  for (const d of deltas) {
    if (!d.completedNow) continue;
    const r = d.def.reward;
    if (!r || r.kind !== 'camo' || d.def.scope !== 'weapon' || !d.def.target) continue;
    const w = profile.weapons[d.def.target];
    if (!w || w.camos.includes(r.id)) continue;
    w.camos.push(r.id);
    grants.push({ weapon: d.def.target, camo: r.id, xp: 0 });
  }

  const baseIds = BASE_CAMOS.map((c) => c.id);

  /* Gold: every base camo on that weapon. */
  for (const t of WEAPON_TRACKS) {
    const w = profile.weapons[t.id];
    if (!w || w.camos.includes('gold')) continue;
    if (baseIds.every((id) => w.camos.includes(id))) {
      w.camos.push('gold');
      grants.push({ weapon: t.id, camo: 'gold', xp: MASTERY_XP.gold });
    }
  }

  /* Platinum: Gold on every weapon of the class. */
  const classes = [...new Set(WEAPON_TRACKS.map((t) => t.cls))];
  for (const cls of classes) {
    const members = WEAPON_TRACKS.filter((t) => t.cls === cls);
    const allGold = members.every((t) => profile.weapons[t.id]?.camos.includes('gold'));
    if (!allGold) continue;
    for (const t of members) {
      const w = profile.weapons[t.id];
      if (!w || w.camos.includes('platinum')) continue;
      w.camos.push('platinum');
      grants.push({ weapon: t.id, camo: 'platinum', xp: MASTERY_XP.platinum });
    }
  }

  /* Obsidian: Platinum everywhere. */
  const allPlat = WEAPON_TRACKS.every((t) => profile.weapons[t.id]?.camos.includes('platinum'));
  if (allPlat) {
    for (const t of WEAPON_TRACKS) {
      const w = profile.weapons[t.id];
      if (!w || w.camos.includes('obsidian')) continue;
      w.camos.push('obsidian');
      grants.push({ weapon: t.id, camo: 'obsidian', xp: MASTERY_XP.obsidian });
    }
  }

  return grants;
}

/** Read model for an armoury camo page. */
export function camoProgressFor(profile: ProfileV3, weaponId: string): Array<{
  camo: string; name: string; unlocked: boolean; progress: number; goal: number; description: string;
}> {
  const track = weaponTrack(weaponId);
  const w = profile.weapons[weaponId];
  const rows = BASE_CAMOS.map((c) => ({
    camo: c.id,
    name: c.name,
    unlocked: !!w?.camos.includes(c.id),
    progress: Math.min(c.goal, weaponStatValue(w, c.stat)),
    goal: c.goal,
    description: c.description.replace('{goal}', String(c.goal)),
  }));
  if (!track) return rows;
  for (const m of ['gold', 'platinum', 'obsidian'] as const) {
    rows.push({
      camo: m,
      name: m[0].toUpperCase() + m.slice(1),
      unlocked: !!w?.camos.includes(m),
      progress: w?.camos.includes(m) ? 1 : 0,
      goal: 1,
      description: m === 'gold'
        ? 'Unlock every base camo for this weapon.'
        : m === 'platinum'
          ? 'Unlock Gold on every weapon in this class.'
          : 'Unlock Platinum on every weapon class.',
    });
  }
  return rows;
}

/** Weapon stat totals, used by the combat record and the class summary. */
export function emptyWeaponStats(): WeaponStats {
  return {
    kills: 0, deaths: 0, headshots: 0, longshots: 0, pointblankKills: 0,
    hipfireKills: 0, adsKills: 0, killstreakKills: 0, revengeKills: 0,
    firstBloods: 0, multikills: 0, assists: 0, shotsFired: 0, shotsHit: 0,
    damage: 0, timeUsed: 0,
  };
}
