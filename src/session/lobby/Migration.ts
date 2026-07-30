/**
 * Host migration.
 *
 * When the authoritative peer vanishes, every remaining peer independently runs
 * `pickSuccessor` over the last state it received. Because the ranking is a
 * total order over data everyone already has, they all reach the same answer
 * without a single round of negotiation — the elected peer calls
 * `LobbyHost.adopt`, everyone else keeps sending commands to the new address.
 *
 * Ranking, in order:
 *   1. connection quality, bucketed to 50 ms so jitter cannot flip the vote
 *   2. the current lobby leader, if they are otherwise equal
 *   3. seniority (earliest `joinedAt`)
 *   4. a stable hash of lobby id + player id
 *
 * Bots and dropped members are never eligible.
 */

import { hashString } from '../../core/Rand';
import type { LobbySnapshot, LobbyState, MemberState, PlayerId } from '../types';

/** Unknown ping (-1) sits mid-table: worse than a good link, better than a bad one. */
export function pingBucket(ping: number): number {
  if (ping < 0) return 3;
  return Math.min(6, Math.floor(ping / 50));
}

export function eligibleSuccessors(state: LobbyState, departed: PlayerId | null): MemberState[] {
  return state.members.filter((m) =>
    m.id !== departed && m.connection !== 'dropped' && !m.profile.bot);
}

/** The peer that should take over, or null when nobody can. */
export function pickSuccessor(state: LobbyState, departed: PlayerId | null): PlayerId | null {
  const pool = eligibleSuccessors(state, departed);
  if (!pool.length) return null;
  const ranked = [...pool].sort((a, b) => {
    const ab = pingBucket(a.ping); const bb = pingBucket(b.ping);
    if (ab !== bb) return ab - bb;
    if (a.leader !== b.leader) return a.leader ? -1 : 1;
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    return hashString(`${state.id}|${a.id}`) - hashString(`${state.id}|${b.id}`);
  });
  return ranked[0].id;
}

/** True when `localId` is the peer that must stand up a host. */
export function shouldAdopt(state: LobbyState, localId: PlayerId, departed: PlayerId | null): boolean {
  return pickSuccessor(state, departed) === localId;
}

/**
 * Last-resort snapshot built from a read model alone.
 *
 * The host broadcasts a real `LobbySnapshot` every couple of seconds, so this
 * only runs when a client is elected before it ever received one. It loses the
 * private bookkeeping — the lobby seed and the raw ballot — and rebuilds what
 * it can from the public state, which is enough to keep the room alive.
 */
export function snapshotFromState(state: LobbyState): LobbySnapshot {
  const ballot: Array<[PlayerId, string]> = [];
  for (const m of state.members) if (m.vote) ballot.push([m.id, m.vote]);
  return {
    version: 1,
    state: JSON.parse(JSON.stringify(state)) as LobbyState,
    seed: hashString(state.id),
    matchIndex: state.matchesPlayed,
    lastMapId: state.lastResult?.mapId ?? null,
    parties: state.parties.map((p) => ({
      id: p.id,
      leaderId: p.leaderId,
      members: [...p.members],
      createdAt: 0,
      matchesTogether: p.matchesTogether,
      colour: p.colour,
      lobbyCode: state.code,
    })),
    phaseTimer: state.countdown.active ? state.countdown.secondsLeft : 0,
    ballot,
    forcedStart: state.countdown.label === 'STARTING',
  };
}
