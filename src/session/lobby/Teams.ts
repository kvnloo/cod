/**
 * Team assignment and balancing.
 *
 * The rule that matters: **a party plays together**. The balancer treats each
 * party as one indivisible unit and only splits it when it physically cannot
 * fit, and when it does split it says so, so the UI can warn the squad instead
 * of silently putting two friends on opposite sides.
 *
 * Everything else is a greedy bin-pack: units sorted big-first, each dropped
 * into whichever team has fewer players, ties broken on lower total skill and
 * then on a stable hash. No RNG, so two hosts balancing the same roster get the
 * same teams — which is exactly what host migration needs.
 */

import { hashString } from '../../core/Rand';
import type { ModeDef, PartyId, PlayerId, SessionTeam, TeamSummary } from '../types';

export interface BalanceMember {
  id: PlayerId;
  skill: number;
  partyId: PartyId | null;
  team: SessionTeam;
  /** The player picked this team by hand; auto-balance leaves them alone. */
  teamLocked: boolean;
  bot: boolean;
}

export interface BalanceOptions {
  teamCount: 1 | 2;
  maxPlayers: number;
  keepPartiesTogether: boolean;
  /** Stable tie-break salt. Use the lobby id. */
  salt: string;
}

export interface TeamAssignment {
  playerId: PlayerId;
  team: SessionTeam;
  /** True when this player was pulled off their party's team to make it fit. */
  splitFromParty: boolean;
}

export interface BalanceResult {
  assignments: TeamAssignment[];
  /** Parties the balancer had to break apart. */
  splitParties: PartyId[];
  alpha: number;
  bravo: number;
  /** |alpha skill − bravo skill|, lower is better. */
  skillGap: number;
}

interface Unit {
  key: string;
  partyId: PartyId | null;
  members: PlayerId[];
  skill: number;
}

/** Slots available per team. Odd caps give alpha the extra seat. */
export function teamCapacity(maxPlayers: number, teamCount: 1 | 2): number {
  return teamCount === 1 ? maxPlayers : Math.ceil(maxPlayers / 2);
}

export function assignTeams(members: readonly BalanceMember[], opts: BalanceOptions): BalanceResult {
  const assignments: TeamAssignment[] = [];
  const splitParties: PartyId[] = [];

  if (opts.teamCount === 1) {
    for (const m of members) assignments.push({ playerId: m.id, team: 'alpha', splitFromParty: false });
    return { assignments, splitParties, alpha: members.length, bravo: 0, skillGap: 0 };
  }

  const cap = teamCapacity(opts.maxPlayers, opts.teamCount);
  const count: Record<'alpha' | 'bravo', number> = { alpha: 0, bravo: 0 };
  const skill: Record<'alpha' | 'bravo', number> = { alpha: 0, bravo: 0 };
  const placed = new Set<PlayerId>();

  const place = (m: BalanceMember, team: 'alpha' | 'bravo', split: boolean): void => {
    assignments.push({ playerId: m.id, team, splitFromParty: split });
    placed.add(m.id);
    count[team]++;
    skill[team] += m.skill;
  };

  const byId = new Map<PlayerId, BalanceMember>();
  for (const m of members) byId.set(m.id, m);

  // 1. Honour manual team picks first — they consume capacity before anything
  //    automatic gets a say.
  for (const m of members) {
    if (!m.teamLocked || m.team === 'none') continue;
    const t = m.team === 'bravo' ? 'bravo' : 'alpha';
    if (count[t] < cap) place(m, t, false);
  }

  // 2. Build the units the balancer actually packs.
  const units: Unit[] = [];
  const partyUnits = new Map<PartyId, Unit>();
  for (const m of members) {
    if (placed.has(m.id)) continue;
    if (opts.keepPartiesTogether && m.partyId) {
      let u = partyUnits.get(m.partyId);
      if (!u) {
        u = { key: `p:${m.partyId}`, partyId: m.partyId, members: [], skill: 0 };
        partyUnits.set(m.partyId, u);
        units.push(u);
      }
      u.members.push(m.id);
      u.skill += m.skill;
    } else {
      units.push({ key: `s:${m.id}`, partyId: null, members: [m.id], skill: m.skill });
    }
  }

  units.sort((a, b) => {
    if (a.members.length !== b.members.length) return b.members.length - a.members.length;
    if (a.skill !== b.skill) return b.skill - a.skill;
    return hashString(`${opts.salt}|${a.key}`) - hashString(`${opts.salt}|${b.key}`);
  });

  const roomFor = (t: 'alpha' | 'bravo'): number => cap - count[t];
  const preferred = (): 'alpha' | 'bravo' => {
    if (count.alpha !== count.bravo) return count.alpha < count.bravo ? 'alpha' : 'bravo';
    if (skill.alpha !== skill.bravo) return skill.alpha < skill.bravo ? 'alpha' : 'bravo';
    return 'alpha';
  };

  for (const unit of units) {
    const first = preferred();
    const other: 'alpha' | 'bravo' = first === 'alpha' ? 'bravo' : 'alpha';

    if (roomFor(first) >= unit.members.length) {
      for (const id of unit.members) place(byId.get(id)!, first, false);
      continue;
    }
    if (roomFor(other) >= unit.members.length) {
      for (const id of unit.members) place(byId.get(id)!, other, false);
      continue;
    }
    // Does not fit whole anywhere: split, biggest slice on the emptier side.
    const big = roomFor(first) >= roomFor(other) ? first : other;
    const small: 'alpha' | 'bravo' = big === 'alpha' ? 'bravo' : 'alpha';
    const split = unit.partyId !== null && unit.members.length > 1;
    if (split) splitParties.push(unit.partyId!);
    let i = 0;
    for (; i < unit.members.length && roomFor(big) > 0; i++) {
      place(byId.get(unit.members[i])!, big, split && i > 0);
    }
    for (; i < unit.members.length && roomFor(small) > 0; i++) {
      place(byId.get(unit.members[i])!, small, split);
    }
    // Anything still unplaced has no seat at all; it stays team 'none'.
    for (; i < unit.members.length; i++) {
      assignments.push({ playerId: unit.members[i], team: 'none', splitFromParty: split });
    }
  }

  return {
    assignments,
    splitParties,
    alpha: count.alpha,
    bravo: count.bravo,
    skillGap: Math.abs(skill.alpha - skill.bravo),
  };
}

/**
 * Can this player move to `target` by hand? Only while the teams are still
 * being formed, only into a team with a seat, and never if it would leave the
 * sides more than one player apart.
 */
export function canSwitchTeam(
  members: readonly BalanceMember[],
  playerId: PlayerId,
  target: SessionTeam,
  opts: { teamCount: 1 | 2; maxPlayers: number },
): { ok: boolean; reason: string } {
  if (opts.teamCount === 1) return { ok: false, reason: 'mode has one team' };
  if (target !== 'alpha' && target !== 'bravo') return { ok: false, reason: 'no such team' };
  const me = members.find((m) => m.id === playerId);
  if (!me) return { ok: false, reason: 'not in lobby' };
  if (me.team === target) return { ok: false, reason: 'already on that team' };

  const cap = teamCapacity(opts.maxPlayers, opts.teamCount);
  let alpha = 0; let bravo = 0;
  for (const m of members) { if (m.team === 'alpha') alpha++; else if (m.team === 'bravo') bravo++; }
  if (target === 'alpha') { alpha++; if (me.team === 'bravo') bravo--; }
  else { bravo++; if (me.team === 'alpha') alpha--; }

  if (target === 'alpha' && alpha > cap) return { ok: false, reason: 'team full' };
  if (target === 'bravo' && bravo > cap) return { ok: false, reason: 'team full' };
  if (Math.abs(alpha - bravo) > 1) return { ok: false, reason: 'would unbalance teams' };
  return { ok: true, reason: '' };
}

export function summariseTeams(
  members: readonly BalanceMember[],
  mode: ModeDef | null,
  opts: { teamCount: 1 | 2; maxPlayers: number },
): TeamSummary[] {
  const cap = teamCapacity(opts.maxPlayers, opts.teamCount);
  const names = mode?.teamNames ?? ['Task Force', 'Spectre'];
  const ids: SessionTeam[] = opts.teamCount === 1 ? ['alpha'] : ['alpha', 'bravo'];
  return ids.map((id, i) => {
    let size = 0; let skill = 0;
    for (const m of members) if (m.team === id) { size++; skill += m.skill; }
    const capacity = opts.teamCount === 1 ? opts.maxPlayers : cap;
    return {
      id,
      name: names[i] ?? (id === 'alpha' ? 'Alpha' : 'Bravo'),
      size,
      capacity,
      skill: Math.round(skill * 100) / 100,
      full: size >= capacity,
    };
  });
}
