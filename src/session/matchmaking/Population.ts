/**
 * Synthetic population.
 *
 * A matchmaker cannot be tuned against four people in a room. This generates N
 * plausible players — latent skill, region, access network, party habits,
 * patience — so the queue can be measured before anyone real ever touches it.
 *
 * ## Distributions, and why
 *
 * **Skill** is a normal centred on 1500 with σ = 260, plus a 7% "second mode"
 * at +430 for the smurf/streamer tail. A pure normal underestimates how bad
 * matchmaking feels in practice, because the pain is concentrated in that tail
 * — those players are the reason a widening curve needs an RD term.
 *
 * **Latent skill is not rating.** Everyone starts unrated at 1500/RD 350 and
 * the simulation drives outcomes from latent skill, so the correlation between
 * final rating and latent skill is a direct measure of whether the rating
 * system works. `tools/session-mm.mjs` prints it.
 *
 * **Access network** is charged at both ends of every path (see
 * `Connection.ts`), so the mix matters: 30% fibre, 40% cable, 18% DSL, 12%
 * cellular. Cellular players are never host-capable, which is what makes host
 * selection non-trivial in a thin population.
 *
 * **Parties**: 62% solo, 20% duo, 9% trio, 9% four-stack — roughly the public
 * split reported for console shooters. Parties are drawn from the same region,
 * because friends are usually neighbours.
 */

import type { Rand } from '../../core/Rand';
import { defaultConnection } from './Connection';
import type { ConnectionInfo, NatType, PlayerId, RegionId } from './types';

export interface SyntheticPlayer {
  id: PlayerId;
  name: string;
  region: RegionId;
  connection: ConnectionInfo;
  /** Ground-truth skill the simulation resolves matches from. */
  latentSkill: number;
  /** Chance per match of rage-quitting early — drives backfill load. */
  quitChance: number;
  /** How many matches they want this session. */
  appetite: number;
  /** Preferred party size when they queue. */
  partySize: number;
}

const REGION_WEIGHTS: ReadonlyArray<[RegionId, number]> = [
  ['na-east', 0.27],
  ['na-west', 0.17],
  ['eu-west', 0.24],
  ['eu-east', 0.09],
  ['apac', 0.13],
  ['oce', 0.05],
  ['sa', 0.05],
];

interface AccessClass {
  name: string;
  weight: number;
  lastMile: [number, number];
  jitter: [number, number];
  loss: [number, number];
  upstream: [number, number];
  hostCapable: boolean;
  natStrictChance: number;
}

const ACCESS: readonly AccessClass[] = [
  { name: 'fibre', weight: 0.30, lastMile: [4, 9], jitter: [1, 3], loss: [0, 0.05], upstream: [8000, 40000], hostCapable: true, natStrictChance: 0.05 },
  { name: 'cable', weight: 0.40, lastMile: [12, 26], jitter: [2, 7], loss: [0.02, 0.2], upstream: [1500, 6000], hostCapable: true, natStrictChance: 0.12 },
  { name: 'dsl', weight: 0.18, lastMile: [28, 48], jitter: [5, 14], loss: [0.1, 0.6], upstream: [500, 1200], hostCapable: true, natStrictChance: 0.22 },
  { name: 'cellular', weight: 0.12, lastMile: [55, 95], jitter: [14, 34], loss: [0.4, 1.8], upstream: [400, 2500], hostCapable: false, natStrictChance: 0.55 },
];

const FIRST = ['Reaper', 'Sable', 'Mako', 'Onyx', 'Havoc', 'Jinx', 'Zero', 'Rift', 'Cinder', 'Vulture', 'Torch', 'Static', 'Grim', 'Halo', 'Lynx', 'Nova'];
const LAST = ['77', 'X', 'HD', 'ttv', '_pro', '99', 'GG', 'zz', '_04', 'v2', 'OG', 'kz'];

function pickWeighted<T>(items: ReadonlyArray<[T, number]>, rng: Rand): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let r = rng.next() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r <= 0) return v;
  }
  return items[items.length - 1][0];
}

function pickAccess(rng: Rand): AccessClass {
  return pickWeighted(ACCESS.map((a) => [a, a.weight] as [AccessClass, number]), rng);
}

export interface PopulationOptions {
  /** Mean of the primary skill mode. */
  skillMean?: number;
  skillSigma?: number;
  /** Fraction of the population in the high tail. */
  eliteFraction?: number;
  eliteOffset?: number;
}

export function generatePopulation(
  n: number, rng: Rand, opts: PopulationOptions = {},
): SyntheticPlayer[] {
  const mean = opts.skillMean ?? 1500;
  const sigma = opts.skillSigma ?? 260;
  const eliteFraction = opts.eliteFraction ?? 0.07;
  const eliteOffset = opts.eliteOffset ?? 430;

  const out: SyntheticPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const region = pickWeighted(REGION_WEIGHTS, rng);
    const access = pickAccess(rng);
    const conn: ConnectionInfo = {
      ...defaultConnection(region),
      lastMileMs: rng.range(access.lastMile[0], access.lastMile[1]),
      jitterMs: rng.range(access.jitter[0], access.jitter[1]),
      lossPct: rng.range(access.loss[0], access.loss[1]),
      upstreamKbps: rng.range(access.upstream[0], access.upstream[1]),
      hostCapable: access.hostCapable,
      nat: pickNat(rng, access.natStrictChance),
    };
    const elite = rng.bool(eliteFraction);
    const latent = clamp(mean + rng.normal() * sigma + (elite ? eliteOffset : 0), 820, 2500);
    const size = pickWeighted<number>([[1, 0.62], [2, 0.20], [3, 0.09], [4, 0.09]], rng);

    out.push({
      id: `p${i.toString(36)}`,
      name: `${rng.pick(FIRST)}${rng.pick(LAST)}${rng.int(1, 99)}`,
      region,
      connection: conn,
      latentSkill: latent,
      quitChance: clamp(rng.range(0.01, 0.09) + (elite ? 0.02 : 0), 0, 0.2),
      appetite: rng.int(1, 12),
      partySize: size,
    });
  }
  return out;
}

function pickNat(rng: Rand, strictChance: number): NatType {
  const r = rng.next();
  if (r < strictChance) return 'strict';
  if (r < strictChance + 0.25) return 'moderate';
  return 'open';
}

/** Population skill percentiles, printed by the tool as a sanity check. */
export function skillPercentiles(pop: SyntheticPlayer[]): Record<string, number> {
  const s = pop.map((p) => p.latentSkill).sort((a, b) => a - b);
  const at = (q: number): number => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
  return { p05: at(0.05), p25: at(0.25), p50: at(0.5), p75: at(0.75), p95: at(0.95), p99: at(0.99) };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
