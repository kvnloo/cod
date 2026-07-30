/**
 * Team assignment.
 *
 * Constraints, in priority order:
 *  1. A party is never split. Four friends who queued together play together —
 *     violating this is the fastest way to make a lobby quit.
 *  2. Team sizes stay within one of each other.
 *  3. Subject to those, minimise the difference in mean rating.
 *
 * Greedy largest-party-first placement gets close; a bounded pass of pairwise
 * swaps between same-size parties closes the rest. Both steps are deterministic
 * — no RNG — so the same tickets always produce the same lobby, which replay
 * and the netcode layer both depend on.
 */

import type { PlaylistDef, QueueTicket, TicketId } from './types';

export interface BalanceResult {
  /** Team index per ticket. */
  assignment: Map<TicketId, number>;
  /** Mean rating per team. */
  means: number[];
  /** |mean0 - mean1|, or 0 for co-op. */
  delta: number;
  /** Tickets that did not fit and must go back in the queue. */
  rejected: QueueTicket[];
}

interface Bucket { team: number; count: number; sum: number; }

export function balanceTeams(tickets: QueueTicket[], def: PlaylistDef): BalanceResult {
  const assignment = new Map<TicketId, number>();
  const rejected: QueueTicket[] = [];
  const buckets: Bucket[] = [];
  for (let t = 0; t < def.teams; t++) buckets.push({ team: t, count: 0, sum: 0 });

  // Biggest parties first — they are the hardest to place, and placing them
  // last is what produces the "party of four had to be split" failure.
  const order = [...tickets].sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    if (b.skill !== a.skill) return b.skill - a.skill;
    return a.id < b.id ? -1 : 1;
  });

  for (const ticket of order) {
    const size = ticket.members.length;
    let best: Bucket | null = null;
    for (const bucket of buckets) {
      if (bucket.count + size > def.teamSize) continue;
      if (!best) { best = bucket; continue; }
      // Prefer the emptier team; on a tie, the weaker one.
      if (bucket.count < best.count) best = bucket;
      else if (bucket.count === best.count && bucket.sum < best.sum) best = bucket;
    }
    if (!best) { rejected.push(ticket); continue; }
    assignment.set(ticket.id, best.team);
    best.count += size;
    best.sum += ticket.skill * size;
  }

  if (def.teams === 2) improve(order, assignment, buckets);

  const means = buckets.map((b) => (b.count > 0 ? b.sum / b.count : 0));
  const delta = def.teams === 2 ? Math.abs(means[0] - means[1]) : 0;
  return { assignment, means, delta, rejected };
}

/**
 * Hill-climbing swaps between same-size parties. Capped at 64 passes: this is
 * a 12-slot problem, it converges in two or three, and an unbounded loop in
 * matchmaking is a hitch nobody will ever find.
 */
function improve(order: QueueTicket[], assignment: Map<TicketId, number>, buckets: Bucket[]): void {
  const meanDelta = (): number => {
    const a = buckets[0].count > 0 ? buckets[0].sum / buckets[0].count : 0;
    const b = buckets[1].count > 0 ? buckets[1].sum / buckets[1].count : 0;
    return Math.abs(a - b);
  };

  for (let pass = 0; pass < 64; pass++) {
    let improved = false;
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      const ta = assignment.get(a.id);
      if (ta === undefined) continue;
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        const tb = assignment.get(b.id);
        if (tb === undefined || tb === ta) continue;
        if (a.members.length !== b.members.length) continue; // keeps team sizes fixed

        const before = meanDelta();
        const size = a.members.length;
        buckets[ta].sum += (b.skill - a.skill) * size;
        buckets[tb].sum += (a.skill - b.skill) * size;
        const after = meanDelta();
        if (after < before - 1e-6) {
          assignment.set(a.id, tb);
          assignment.set(b.id, ta);
          improved = true;
          break;
        }
        // Revert.
        buckets[ta].sum -= (b.skill - a.skill) * size;
        buckets[tb].sum -= (a.skill - b.skill) * size;
      }
      if (improved) break;
    }
    if (!improved) return;
  }
}

/** Party skill: mean rating, pulled toward the best member. */
export function partySkill(ratings: number[]): number {
  if (ratings.length === 0) return 1500;
  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const best = Math.max(...ratings);
  // A stack is stronger than the average of its parts — comms and coordination
  // are worth something — so weight the best member in. 0.25 is the standard
  // "party bonus" magnitude in shooters that publish one.
  return mean * 0.75 + best * 0.25;
}
