/**
 * Connection quality model and host selection.
 *
 * Matchmaking that only buckets by skill produces fair matches nobody enjoys,
 * because in a host-authoritative game the person with the worst path to the
 * host loses every trade they should have won. So the queue treats latency as
 * a first-class constraint alongside skill, and both widen over time.
 *
 * The model is deliberately coarse and analytic rather than measured:
 *
 *     rtt(a,b) = backbone(regionA, regionB) + lastMile(a) + lastMile(b)
 *
 * Backbone RTT comes from the table below (real-world-ish figures between
 * datacentre regions). Last mile is the player's access network — fibre 6 ms,
 * cable 18 ms, DSL 35 ms, cellular 70 ms — and it is charged at *both* ends,
 * which is exactly why two cellular players never feel good together even in
 * the same city.
 *
 * When the netcode layer starts publishing real probe results, replace
 * `estimateRtt` with a lookup and nothing else in this module changes.
 */

import type { ConnectionInfo, NatType, PlayerId, RegionId } from './types';
import { REGIONS } from './types';

/** Backbone RTT in ms. Symmetric; the diagonal is intra-region. */
const RTT_TABLE: Record<RegionId, Record<RegionId, number>> = build({
  'na-east': { 'na-east': 16, 'na-west': 62, 'eu-west': 78, 'eu-east': 112, apac: 190, oce: 205, sa: 118 },
  'na-west': { 'na-west': 16, 'eu-west': 142, 'eu-east': 168, apac: 118, oce: 150, sa: 176 },
  'eu-west': { 'eu-west': 14, 'eu-east': 36, apac: 198, oce: 268, sa: 182 },
  'eu-east': { 'eu-east': 18, apac: 188, oce: 288, sa: 214 },
  apac: { apac: 20, oce: 108, sa: 302 },
  oce: { oce: 18, sa: 318 },
  sa: { sa: 22 },
});

function build(partial: Partial<Record<RegionId, Partial<Record<RegionId, number>>>>): Record<RegionId, Record<RegionId, number>> {
  const out = {} as Record<RegionId, Record<RegionId, number>>;
  for (const a of REGIONS) out[a] = {} as Record<RegionId, number>;
  for (const a of REGIONS) {
    for (const b of REGIONS) {
      const v = partial[a]?.[b] ?? partial[b]?.[a] ?? 250;
      out[a][b] = v;
      out[b][a] = v;
    }
  }
  return out;
}

export function backboneRtt(a: RegionId, b: RegionId): number {
  return RTT_TABLE[a]?.[b] ?? 250;
}

/** Round-trip estimate between two players, in ms. */
export function estimateRtt(a: ConnectionInfo, b: ConnectionInfo): number {
  return backboneRtt(a.region, b.region) + a.lastMileMs + b.lastMileMs;
}

/**
 * What the ping *feels* like. Jitter is charged at 2× because a variable 40 ms
 * is worse to play against than a steady 60 ms, and loss is charged brutally
 * because every dropped packet is a rewound kill.
 */
export function effectiveRtt(a: ConnectionInfo, b: ConnectionInfo): number {
  return estimateRtt(a, b) + (a.jitterMs + b.jitterMs) * 2 + (a.lossPct + b.lossPct) * 22;
}

const NAT_PENALTY: Record<NatType, number> = { open: 0, moderate: 26, strict: 120 };

/** Upstream a host needs per connected client, in kbit/s, at 20 Hz snapshot rate. */
const UPSTREAM_PER_CLIENT = 190;

/** 0..1 quality score for one connection, used for coarse bucketing. */
export function connectionQuality(c: ConnectionInfo): number {
  const jitter = 1 - clamp01(c.jitterMs / 40);
  const loss = 1 - clamp01(c.lossPct / 3);
  const lastMile = 1 - clamp01((c.lastMileMs - 5) / 75);
  const nat = c.nat === 'open' ? 1 : c.nat === 'moderate' ? 0.8 : 0.5;
  return clamp01(jitter * 0.28 + loss * 0.3 + lastMile * 0.27 + nat * 0.15);
}

export interface HostCandidateInfo {
  playerId: PlayerId;
  connection: ConnectionInfo;
}

export interface HostChoice {
  hostId: PlayerId | null;
  /** Worst member→host RTT. */
  worstPing: number;
  meanPing: number;
  /** Cost of the winning candidate; lower is better. */
  cost: number;
}

/**
 * Picks the authority. Cost is dominated by the *worst* member ping rather
 * than the mean — a host is only as good as the unhappiest player behind it —
 * with penalties for NAT, jitter and insufficient upstream.
 */
export function selectHost(members: HostCandidateInfo[], clients: number): HostChoice {
  let best: HostChoice = { hostId: null, worstPing: Infinity, meanPing: Infinity, cost: Infinity };
  for (const cand of members) {
    if (!cand.connection.hostCapable) continue;
    let worst = 0;
    let sum = 0;
    let n = 0;
    for (const m of members) {
      if (m.playerId === cand.playerId) continue;
      const rtt = effectiveRtt(m.connection, cand.connection);
      worst = Math.max(worst, rtt);
      sum += rtt;
      n++;
    }
    const mean = n > 0 ? sum / n : 0;
    const needed = UPSTREAM_PER_CLIENT * Math.max(1, clients);
    const upstreamShort = Math.max(0, needed - cand.connection.upstreamKbps) / needed;
    const cost = worst
      + mean * 0.35
      + NAT_PENALTY[cand.connection.nat]
      + cand.connection.jitterMs * 3
      + upstreamShort * 260;
    if (cost < best.cost) best = { hostId: cand.playerId, worstPing: worst, meanPing: mean, cost };
  }
  if (best.hostId === null && members.length > 0) {
    // Nobody is host-capable — fall back to the least-bad connection rather
    // than refusing to form a match. A dedicated server, when netcode provides
    // one, simply never reaches this branch.
    let fallback = members[0];
    for (const m of members) if (connectionQuality(m.connection) > connectionQuality(fallback.connection)) fallback = m;
    const pings = members.filter((m) => m.playerId !== fallback.playerId)
      .map((m) => effectiveRtt(m.connection, fallback.connection));
    best = {
      hostId: fallback.playerId,
      worstPing: pings.length ? Math.max(...pings) : 0,
      meanPing: pings.length ? pings.reduce((a, b) => a + b, 0) / pings.length : 0,
      cost: Infinity,
    };
  }
  if (best.worstPing === Infinity) best = { ...best, worstPing: 0, meanPing: 0 };
  return best;
}

/** Ping of every member to a chosen host. */
export function pingsToHost(members: HostCandidateInfo[], hostId: PlayerId | null): number[] {
  if (!hostId) return [];
  const host = members.find((m) => m.playerId === hostId);
  if (!host) return [];
  return members
    .filter((m) => m.playerId !== hostId)
    .map((m) => effectiveRtt(m.connection, host.connection));
}

export function defaultConnection(region: RegionId = 'na-east'): ConnectionInfo {
  return {
    region, lastMileMs: 18, jitterMs: 4, lossPct: 0.1,
    nat: 'open', upstreamKbps: 4000, hostCapable: true,
  };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
