/**
 * Headless matchmaking simulation.
 *
 * Drives the *real* `MatchmakingService` — same queue, same widening curve,
 * same bot fill, same backfill manager — against a synthetic population, on a
 * virtual clock. Nothing here is a model of the matchmaker; it is a model of
 * the *players*, which is the only honest way to measure a queue.
 *
 * Outcomes are resolved from each synthetic player's latent skill, which the
 * rating system never sees. That makes the correlation between final rating and
 * latent skill a real measurement rather than a tautology.
 *
 * Everything is seeded from `src/core/Rand.ts`; two runs with the same seed
 * produce byte-identical statistics, which `tools/session-mm.mjs` asserts.
 */

import { Rand, hashString } from '../../core/Rand';
import type { EventKey, GameEvents } from '../../core/EventBus';
import { canBackfill, DEFAULT_BACKFILL } from './Backfill';
import { botsOn, humansOn } from './BotFill';
import { playlist as playlistDef } from './Playlists';
import { generatePopulation, skillPercentiles, type SyntheticPlayer } from './Population';
import { MatchmakingService, type MmEmitter, type PartyMemberInput } from './Service';
import { RatingStore } from './Store';
import { DEFAULT_WIDENING, describeCurve } from './Widening';
import type {
  BackfillRefusal, HumanSlot, LiveMatchView, MatchId, MatchRoster, PlayerId, PlaylistId,
  WideningParams,
} from './types';

/* ----------------------------------------------------------------- config -- */

export interface SimConfig {
  seed: number;
  population: number;
  /** Tickets to push through the queue before draining. */
  attempts: number;
  playlist: PlaylistId;
  /** Poisson arrival rate of *tickets* (parties), per second. */
  arrivalsPerSecond: number;
  matchDuration: number;
  scoreLimit: number;
  /** Virtual clock step. 0.5 s matches a real front end's matchmaking tick. */
  step: number;
  /** Safety valve on the virtual clock. */
  maxSeconds: number;
  /** Live-ops widening override — the axis `tools/session-mm-sweep.mjs` walks. */
  widening?: Partial<WideningParams>;
  /** Matches each synthetic player wants, as a multiple of an evening's play. */
  appetiteScale?: number;
  /**
   * Seconds a fresh ticket searches for a *new* lobby before it also becomes
   * eligible to be dropped into a live one. Low values give individuals fast
   * games; they also drain the pool that new lobbies are built from, so this
   * trades one player's queue time against everybody's bot count.
   */
  joinInProgressAfter: number;
}

export const DEFAULT_SIM: SimConfig = {
  seed: 20260729,
  population: 500,
  attempts: 1000,
  playlist: 'core-tdm-6v6',
  arrivalsPerSecond: 1.6,
  matchDuration: 420,
  scoreLimit: 75,
  step: 0.5,
  maxSeconds: 4000,
  joinInProgressAfter: 10,
};

/* ------------------------------------------------------------------ stats -- */

export interface Dist {
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface SimStats {
  config: SimConfig;
  seconds: number;
  players: number;
  skillPercentiles: Record<string, number>;
  ticketsAdmitted: number;
  ticketsMatched: number;
  ticketsStranded: number;
  playersMatched: number;
  matches: number;
  queueSeconds: Dist;
  skillSpread: Dist;
  teamDelta: Dist;
  hostPing: Dist;
  /** Fraction of match slots filled by a bot *at the instant of formation*. */
  botFillRate: number;
  /**
   * Fraction of slot-seconds across every live match spent occupied by a bot —
   * what a player actually experiences.
   *
   * This is the number to judge the system on, and it is markedly lower than
   * `botFillRate`, because a slot bot-filled at formation is handed to the
   * first human the queue can route in and stays human afterwards. Formation
   * is a snapshot of the worst instant in a match's life; occupancy integrates
   * over the whole thing.
   */
  botOccupancy: number;
  botSlots: number;
  totalSlots: number;
  matchesWithBots: number;
  matchesFullyHuman: number;
  backfillPlacements: number;
  botTopUps: number;
  botYields: number;
  leavers: number;
  refusals: Record<string, number>;
  /** Pearson correlation of final rating vs latent skill (>= 3 matches). */
  ratingCorrelation: number;
  /** The same correlation sliced by games played — the convergence curve. */
  ratingCorrelationByExperience: Array<{ minMatches: number; r: number; n: number }>;
  /** Mean games played by the rated cohort. */
  meanMatchesPlayed: number;
  ratedPlayers: number;
  meanRd: number;
  events: Record<string, number>;
  hash: string;
}

/* -------------------------------------------------------------- internals -- */

interface LiveMatch {
  roster: MatchRoster;
  view: LiveMatchView;
  /** Score accrual per second per team. */
  rate: number[];
  scores: number[];
  done: boolean;
}

function dist(values: number[]): Dist {
  if (values.length === 0) return { mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: s[s.length - 1],
  };
}

function poisson(lambda: number, rng: Rand): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng.next(); } while (p > L && k < 64);
  return k - 1;
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let mx = 0; let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/* -------------------------------------------------------------------- run -- */

export function runSimulation(partial: Partial<SimConfig> = {}): SimStats {
  const cfg: SimConfig = { ...DEFAULT_SIM, ...partial };
  const rng = new Rand(cfg.seed);
  const pop = generatePopulation(cfg.population, rng, { appetiteScale: cfg.appetiteScale });
  const byId = new Map<PlayerId, SyntheticPlayer>(pop.map((p) => [p.id, p]));
  const events: Record<string, number> = {};
  const emit: MmEmitter = <K extends EventKey>(key: K, _payload: GameEvents[K]): void => {
    events[key] = (events[key] ?? 0) + 1;
  };

  const store = new RatingStore(null);
  const service = new MatchmakingService({
    seed: cfg.seed ^ 0x9e37,
    store,
    emit,
    joinInProgressAfter: cfg.joinInProgressAfter,
    queue: cfg.widening ? { widening: cfg.widening } : undefined,
  });

  const idle = new Set<PlayerId>(pop.map((p) => p.id));
  const queued = new Map<PlayerId, number>();      // playerId → joinedAt
  const inMatch = new Map<PlayerId, MatchId>();
  const remaining = new Map<PlayerId, number>(pop.map((p) => [p.id, p.appetite]));
  const live = new Map<MatchId, LiveMatch>();

  const queueTimes: number[] = [];
  const spreads: number[] = [];
  const deltas: number[] = [];
  const pings: number[] = [];
  let ticketsAdmitted = 0;
  let matches = 0;
  let botSlots = 0;
  let totalSlots = 0;
  let matchesWithBots = 0;
  let matchesFullyHuman = 0;
  let leavers = 0;
  let playersMatched = 0;
  let backfillPlacements = 0;
  // Slot-seconds, integrated every step over every live match.
  let botSlotSeconds = 0;
  let allSlotSeconds = 0;

  let t = 0;
  const seen = new Set<MatchId>();

  while (t < cfg.maxSeconds && (ticketsAdmitted < cfg.attempts || live.size > 0 || queued.size > 0)) {
    /* ---------------------------------------------------------- arrivals -- */
    if (ticketsAdmitted < cfg.attempts) {
      const n = poisson(cfg.arrivalsPerSecond * cfg.step, rng);
      for (let i = 0; i < n && ticketsAdmitted < cfg.attempts; i++) {
        const party = drawParty(pop, idle, remaining, rng);
        if (party.length === 0) break;
        const members: PartyMemberInput[] = party.map((p) => ({
          playerId: p.id, name: p.name, connection: p.connection, rank: 1,
        }));
        service.admit(members, cfg.playlist, t);
        ticketsAdmitted++;
        for (const p of party) { idle.delete(p.id); queued.set(p.id, t); }
      }
    }

    /* ------------------------------------------------------------- queue -- */
    const proposals = service.update(t);
    for (const p of proposals) {
      const strength = teamStrengths(p.roster, byId);
      const total = strength.reduce((a, b) => a + b, 0) / Math.max(1, strength.length);
      const rate = strength.map((s) => (cfg.scoreLimit / cfg.matchDuration) * (s / Math.max(1, total)));
      const view: LiveMatchView = {
        matchId: p.roster.matchId,
        phase: 'live',
        elapsed: 0,
        duration: cfg.matchDuration,
        scoreLimit: cfg.scoreLimit,
        teamScores: new Array(p.roster.teams).fill(0),
      };
      service.registerMatch(p.roster, view);
      live.set(p.roster.matchId, { roster: p.roster, view, rate, scores: new Array(p.roster.teams).fill(0), done: false });

      matches++;
      const bots = p.quality.bots;
      botSlots += bots;
      totalSlots += p.roster.slots.length;
      if (bots > 0) matchesWithBots++; else matchesFullyHuman++;
      spreads.push(p.quality.skillSpread);
      deltas.push(p.quality.teamDelta);
      if (p.quality.meanPing > 0) pings.push(p.quality.meanPing);
      seen.add(p.roster.matchId);
    }

    /* ------------------------- who just got into a match (incl. backfill) -- */
    for (const m of live.values()) {
      for (const s of m.roster.slots) {
        if (s.kind !== 'human') continue;
        const joined = queued.get(s.playerId);
        if (joined === undefined) continue;
        queued.delete(s.playerId);
        inMatch.set(s.playerId, m.roster.matchId);
        queueTimes.push(t - joined);
        playersMatched++;
        if (s.backfilled) backfillPlacements++;
      }
    }

    /* ------------------------------------------------------------ matches -- */
    for (const [id, m] of [...live]) {
      if (m.done) continue;
      // Integrate occupancy before anything mutates the roster this step.
      for (const s of m.roster.slots) {
        allSlotSeconds += cfg.step;
        if (s.kind === 'bot') botSlotSeconds += cfg.step;
      }
      m.view.elapsed += cfg.step;
      for (let team = 0; team < m.scores.length; team++) {
        m.scores[team] += m.rate[team] * cfg.step * rng.range(0.7, 1.3);
        m.view.teamScores[team] = Math.round(m.scores[team]);
      }
      service.updateMatch(m.view);

      // Leavers. Rate is per-player-per-match, spread across the match length.
      for (const s of [...m.roster.slots]) {
        if (s.kind !== 'human') continue;
        const p = byId.get(s.playerId);
        if (!p) continue;
        const per = p.quitChance * (cfg.step / cfg.matchDuration);
        if (!rng.bool(per)) continue;
        service.reportPlayerLeft(id, s.playerId, t);
        inMatch.delete(s.playerId);
        leavers++;
        requeueOrIdle(s.playerId, idle, remaining);
      }

      const over = m.view.elapsed >= cfg.matchDuration
        || Math.max(...m.view.teamScores) >= cfg.scoreLimit;
      if (!over) continue;

      finishMatch(service, m, byId, t, rng);
      for (const s of m.roster.slots) {
        if (s.kind !== 'human') continue;
        inMatch.delete(s.playerId);
        requeueOrIdle(s.playerId, idle, remaining);
      }
      service.endMatch(id);
      live.delete(id);
      m.done = true;
    }

    t += cfg.step;
  }

  /* ----------------------------------------------------------- reporting -- */

  const xs: number[] = [];
  const ys: number[] = [];
  let rdSum = 0;
  let rated = 0;
  let matchesPlayedSum = 0;
  for (const rec of store.all()) {
    const p = byId.get(rec.id);
    if (!p || rec.rating.matches < 3) continue;
    xs.push(rec.rating.rating);
    ys.push(p.latentSkill);
    rdSum += rec.rating.rd;
    matchesPlayedSum += rec.rating.matches;
    rated++;
  }

  /**
   * Correlation as a function of games played. A rating system is judged on
   * where this curve *goes*, not on one point of it: Glicko-2 starting every
   * player at 1500/RD 350 cannot know anything after three matches, so a low
   * number there is convergence speed, whereas a flat curve means the update is
   * actually broken.
   */
  const byExperience: Array<{ minMatches: number; r: number; n: number }> = [];
  for (const minMatches of [3, 5, 8, 12, 20]) {
    const bx: number[] = [];
    const by: number[] = [];
    for (const rec of store.all()) {
      const p = byId.get(rec.id);
      if (!p || rec.rating.matches < minMatches) continue;
      bx.push(rec.rating.rating);
      by.push(p.latentSkill);
    }
    byExperience.push({ minMatches, r: bx.length > 2 ? pearson(bx, by) : NaN, n: bx.length });
  }

  const refusals: Record<string, number> = {};
  for (const [k, v] of service.backfill.refusals) refusals[k] = v;

  const stats: SimStats = {
    config: cfg,
    seconds: Math.round(t),
    players: pop.length,
    skillPercentiles: skillPercentiles(pop),
    ticketsAdmitted,
    ticketsMatched: matches,
    ticketsStranded: service.queue.size,
    playersMatched,
    matches,
    queueSeconds: dist(queueTimes),
    skillSpread: dist(spreads),
    teamDelta: dist(deltas),
    hostPing: dist(pings),
    botFillRate: totalSlots > 0 ? botSlots / totalSlots : 0,
    botOccupancy: allSlotSeconds > 0 ? botSlotSeconds / allSlotSeconds : 0,
    botSlots,
    totalSlots,
    matchesWithBots,
    matchesFullyHuman,
    backfillPlacements,
    botTopUps: events['mm:botfill'] ?? 0,
    botYields: events['mm:bot:yield'] ?? 0,
    leavers,
    refusals,
    ratingCorrelation: pearson(xs, ys),
    ratingCorrelationByExperience: byExperience,
    meanMatchesPlayed: rated > 0 ? matchesPlayedSum / rated : 0,
    ratedPlayers: rated,
    meanRd: rated > 0 ? rdSum / rated : 0,
    events,
    hash: '',
  };
  stats.hash = fingerprint(stats);
  return stats;
}

function fingerprint(s: SimStats): string {
  const key = [
    s.matches, s.playersMatched, round(s.queueSeconds.p50), round(s.queueSeconds.p95),
    round(s.skillSpread.mean), round(s.botFillRate, 4), s.botYields, s.leavers,
    round(s.ratingCorrelation, 4),
  ].join('|');
  return hashString(key).toString(16);
}

function round(v: number, dp = 2): number {
  const m = Math.pow(10, dp);
  return Math.round(v * m) / m;
}

function drawParty(
  pop: SyntheticPlayer[], idle: Set<PlayerId>, remaining: Map<PlayerId, number>, rng: Rand,
): SyntheticPlayer[] {
  const available = pop.filter((p) => idle.has(p.id) && (remaining.get(p.id) ?? 0) > 0);
  if (available.length === 0) return [];
  const leader = available[rng.int(0, available.length - 1)];
  const party = [leader];
  if (leader.partySize > 1) {
    const friends = available.filter((p) => p.id !== leader.id && p.region === leader.region);
    for (let i = 0; i < leader.partySize - 1 && friends.length > 0; i++) {
      const j = rng.int(0, friends.length - 1);
      party.push(friends[j]);
      friends.splice(j, 1);
    }
  }
  for (const p of party) remaining.set(p.id, (remaining.get(p.id) ?? 1) - 1);
  return party;
}

function requeueOrIdle(id: PlayerId, idle: Set<PlayerId>, remaining: Map<PlayerId, number>): void {
  if ((remaining.get(id) ?? 0) > 0) idle.add(id);
}

function teamStrengths(roster: MatchRoster, byId: Map<PlayerId, SyntheticPlayer>): number[] {
  const out: number[] = [];
  for (let team = 0; team < roster.teams; team++) {
    const slots = roster.slots.filter((s) => s.team === team);
    if (slots.length === 0) { out.push(1500); continue; }
    let sum = 0;
    for (const s of slots) {
      sum += s.kind === 'human' ? (byId.get(s.playerId)?.latentSkill ?? 1500) : s.rating;
    }
    out.push(sum / slots.length);
  }
  return out;
}

function finishMatch(
  service: MatchmakingService, m: LiveMatch, byId: Map<PlayerId, SyntheticPlayer>,
  t: number, rng: Rand,
): void {
  let winning = 0;
  for (let team = 1; team < m.view.teamScores.length; team++) {
    if (m.view.teamScores[team] > m.view.teamScores[winning]) winning = team;
  }
  const scores = m.roster.slots
    .filter((s): s is HumanSlot => s.kind === 'human')
    .map((s) => {
      const latent = byId.get(s.playerId)?.latentSkill ?? 1500;
      const base = (latent / 1500) * 90 * (m.view.elapsed / 60);
      return { playerId: s.playerId, combatScore: Math.max(0, base * rng.range(0.6, 1.45)) };
    });
  service.submitResult({
    matchId: m.roster.matchId,
    winningTeam: winning,
    durationSec: m.view.elapsed,
    scores,
  }, t);
}

/* --------------------------------------------------- scenario: bot fill -- */

export interface FriendGroupResult {
  humans: number;
  bots: number;
  slots: number;
  secondsToLaunch: number;
  teams: Array<{ team: number; humans: number; bots: number; meanRating: number }>;
  difficulties: Record<string, number>;
  teamDelta: number;
  /** After a human backfills in. */
  afterYield: { humans: number; bots: number; slots: number; yielded: number } | null;
}

/**
 * The demo case: four friends want a 6v6. Eight slots must fill with bots, the
 * match must start in single-digit seconds, and when a fifth human turns up a
 * bot must give up its slot rather than the roster growing to thirteen.
 */
export function runFriendGroupScenario(
  seed = 4242, playlistId: PlaylistId = 'core-tdm-6v6', friends = 4,
): FriendGroupResult {
  const rng = new Rand(seed);
  const pop = generatePopulation(friends + 1, rng, {});
  const service = new MatchmakingService({ seed, store: new RatingStore(null) });

  const party: PartyMemberInput[] = pop.slice(0, friends).map((p) => ({
    playerId: p.id, name: p.name, connection: p.connection, rank: 12,
  }));
  service.admit(party, playlistId, 0);

  let t = 0;
  let roster: MatchRoster | null = null;
  while (t < 120 && !roster) {
    const proposals = service.update(t);
    if (proposals.length > 0) roster = proposals[0].roster;
    t += 0.5;
  }
  if (!roster) {
    return {
      humans: friends, bots: 0, slots: 0, secondsToLaunch: -1,
      teams: [], difficulties: {}, teamDelta: 0, afterYield: null,
    };
  }

  const difficulties: Record<string, number> = {};
  for (const s of roster.slots) {
    if (s.kind !== 'bot') continue;
    difficulties[s.difficulty] = (difficulties[s.difficulty] ?? 0) + 1;
  }
  const teams = [];
  for (let team = 0; team < roster.teams; team++) {
    const slots = roster.slots.filter((s) => s.team === team);
    const mean = slots.length
      ? slots.reduce((a, s) => a + (s.kind === 'human' ? s.rating.rating : s.rating), 0) / slots.length
      : 0;
    teams.push({
      team,
      humans: humansOn(roster, team).length,
      bots: botsOn(roster, team).length,
      meanRating: Math.round(mean),
    });
  }

  /* --- a fifth human arrives; a bot must yield --- */
  const view: LiveMatchView = {
    matchId: roster.matchId, phase: 'live', elapsed: 30,
    duration: 420, scoreLimit: 75, teamScores: [4, 3],
  };
  service.registerMatch(roster, view);
  const botsBefore = roster.slots.filter((s) => s.kind === 'bot').length;
  const slotsBefore = roster.slots.length;
  const newcomer = pop[friends];
  service.admit(
    [{ playerId: newcomer.id, name: newcomer.name, connection: newcomer.connection }],
    playlistId, t, 'backfill',
  );
  service.update(t + 1);

  const after = service.backfill.rosterOf(roster.matchId) ?? roster;
  const botsAfter = after.slots.filter((s) => s.kind === 'bot').length;

  return {
    humans: friends,
    bots: slotsBefore - friends,
    slots: slotsBefore,
    secondsToLaunch: t - 0.5,
    teams,
    difficulties,
    teamDelta: Math.abs((teams[0]?.meanRating ?? 0) - (teams[1]?.meanRating ?? 0)),
    afterYield: {
      humans: after.slots.filter((s) => s.kind === 'human').length,
      bots: botsAfter,
      slots: after.slots.length,
      yielded: botsBefore - botsAfter,
    },
  };
}

/* -------------------------------------------- scenario: backfill policy -- */

export interface PolicyProbeRow {
  label: string;
  elapsedFraction: number;
  scoreGapFraction: number;
  verdict: BackfillRefusal;
}

/** Truth table for the "is it too late to join" rules. */
export function runBackfillPolicyProbe(playlistId: PlaylistId = 'core-tdm-6v6'): PolicyProbeRow[] {
  const def = playlistDef(playlistId);
  const rows: Array<[string, number, number]> = [
    ['fresh match', 0.05, 0],
    ['mid match, even', 0.4, 0.1],
    ['mid match, one-sided', 0.4, 0.6],
    ['late match', 0.7, 0.1],
    ['final 90 s', 0.9, 0.1],
    ['near score limit', 0.5, 0.2],
  ];
  const duration = 420;
  const limit = 75;
  return rows.map(([label, ef, gap]) => {
    // Build the scores *up* from the trailing team so the requested gap is
    // actually representable. Anchoring the leader at 40% of the limit and
    // subtracting silently clamped every gap wider than 0.4 to zero, so the
    // blowout row was quietly probing an even match.
    const lead = label === 'near score limit'
      ? limit * 0.85
      : limit * 0.1 + limit * gap;
    const view: LiveMatchView = {
      matchId: 'probe', phase: 'live',
      elapsed: duration * ef, duration, scoreLimit: limit,
      teamScores: [lead, Math.max(0, lead - limit * gap)],
    };
    return {
      label, elapsedFraction: ef, scoreGapFraction: gap,
      verdict: canBackfill(view, def, DEFAULT_BACKFILL),
    };
  });
}

/** The widening curve, sampled — printed by the tool so it is documented. */
export function curveTable(): ReturnType<typeof describeCurve> {
  return describeCurve(DEFAULT_WIDENING);
}
