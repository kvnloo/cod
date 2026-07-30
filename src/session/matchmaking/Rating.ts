/**
 * Skill rating — Glicko-2.
 *
 * ## Why Glicko-2 and not Elo
 *
 * Elo carries one number. Matchmaking needs two, because the question a queue
 * asks is not "how good is this player" but "how confident are we, and how
 * wide should the search be". Glicko-2 answers both:
 *
 *  - **RD (rating deviation)** *is* the initial search window. A brand new
 *    player has RD 350, so we happily match them against anyone while we work
 *    out where they belong; a 400-match veteran has RD ~50 and gets a tight
 *    lobby. With Elo you have to bolt a separate confidence heuristic on the
 *    side and it is always wrong for returning players.
 *  - **Volatility σ** absorbs the smurf/streamer case. A player whose results
 *    suddenly stop matching their rating gets a temporarily larger σ, which
 *    inflates RD, which makes the system move them fast instead of grinding
 *    them up 12 points a match.
 *  - **RD decay over idle time** re-widens a returning player automatically.
 *
 * The cost is that Glicko-2 is defined over *rating periods* rather than single
 * games. We treat one match as one rating period and feed every opponent in it
 * as a separate game, which is the standard adaptation and behaves well as long
 * as a period holds a handful of games — a 6v6 match gives six.
 *
 * Everything here is pure and deterministic. No RNG, no clock.
 */

import type { PlayerRecord, SkillRating } from './types';

/** Glicko-2 internal scale factor. */
const SCALE = 173.7178;
/** System constant τ — how much volatility is allowed to move per period.
 *  0.5 is the recommended value; lower makes the system placid, higher makes it
 *  jumpy. A shooter with high per-match variance wants the placid end. */
const TAU = 0.5;
const EPS = 1e-6;

export const RATING_DEFAULT = 1500;
export const RD_DEFAULT = 350;
export const RD_MIN = 45;
export const RD_MAX = 350;
export const VOL_DEFAULT = 0.06;

/** Seconds in a nominal rating period (one day) for idle RD inflation. */
const PERIOD_SECONDS = 86400;
/** c chosen so a fully-known player (RD 45) returns to RD_MAX after ~1 year idle. */
const C = Math.sqrt((RD_MAX * RD_MAX - RD_MIN * RD_MIN) / 365);

export function newRating(rating = RATING_DEFAULT, rd = RD_DEFAULT): SkillRating {
  return { rating, rd, vol: VOL_DEFAULT, matches: 0, lastPlayed: 0 };
}

/**
 * Seeds a rating from progression rank. Rank is weak evidence — it measures
 * time played far more than skill — so it moves the mean a little and leaves
 * RD almost untouched.
 */
export function ratingFromRank(rank: number): SkillRating {
  const r = clamp(RATING_DEFAULT + (rank - 8) * 7, 1380, 1760);
  return { rating: r, rd: 320, vol: VOL_DEFAULT, matches: 0, lastPlayed: 0 };
}

/* ------------------------------------------------------------- expectancy -- */

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Probability that `a` beats `b`, on the display scale. */
export function expectedScore(a: SkillRating, b: SkillRating): number {
  const mu = (a.rating - RATING_DEFAULT) / SCALE;
  const muj = (b.rating - RATING_DEFAULT) / SCALE;
  const phij = b.rd / SCALE;
  return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
}

/**
 * Conservative skill used for *bucketing*: rating minus one RD. Two players
 * with the same rating but different certainty should not be treated as
 * interchangeable, and pessimism is the right bias — it keeps unknown players
 * out of the top brackets until they prove they belong there.
 */
export function conservativeSkill(r: SkillRating): number {
  return r.rating - r.rd * 0.5;
}

/* ----------------------------------------------------------------- decay -- */

/** Inflates RD for time spent away. `now` and `lastPlayed` are seconds. */
export function decayed(r: SkillRating, now: number): SkillRating {
  if (r.matches === 0 || now <= r.lastPlayed) return r;
  const periods = (now - r.lastPlayed) / PERIOD_SECONDS;
  if (periods < 0.5) return r;
  const rd = Math.min(RD_MAX, Math.sqrt(r.rd * r.rd + C * C * periods));
  return { ...r, rd };
}

/* ---------------------------------------------------------------- update -- */

export interface RatedGame {
  /** Opponent's rating at the time of the match. */
  opponent: SkillRating;
  /** Outcome in [0,1]: 1 win, 0 loss, 0.5 draw, or a performance blend. */
  score: number;
}

/**
 * Runs one Glicko-2 rating period. `games` empty means "played nothing" and
 * only inflates RD, which is what the algorithm prescribes.
 */
export function updateRating(r: SkillRating, games: RatedGame[], now: number): SkillRating {
  const mu = (r.rating - RATING_DEFAULT) / SCALE;
  const phi = r.rd / SCALE;
  const sigma = r.vol;

  if (games.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { ...r, rd: clamp(phiStar * SCALE, RD_MIN, RD_MAX) };
  }

  let vInv = 0;
  let delSum = 0;
  for (const game of games) {
    const muj = (game.opponent.rating - RATING_DEFAULT) / SCALE;
    const phij = game.opponent.rd / SCALE;
    const gj = g(phij);
    const e = 1 / (1 + Math.exp(-gj * (mu - muj)));
    vInv += gj * gj * e * (1 - e);
    delSum += gj * (game.score - e);
  }
  if (vInv <= 0) return { ...r, matches: r.matches + 1, lastPlayed: now };

  const v = 1 / vInv;
  const delta = v * delSum;
  const sigmaPrime = solveVolatility(phi, v, delta, sigma);
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + vInv);
  const muPrime = mu + phiPrime * phiPrime * delSum;

  return {
    rating: muPrime * SCALE + RATING_DEFAULT,
    rd: clamp(phiPrime * SCALE, RD_MIN, RD_MAX),
    vol: sigmaPrime,
    matches: r.matches + 1,
    lastPlayed: now,
  };
}

/** Illinois-variant regula falsi from the Glicko-2 paper. Converges in <15 steps. */
function solveVolatility(phi: number, v: number, delta: number, sigma: number): number {
  const a = Math.log(sigma * sigma);
  const d2 = delta * delta;
  const phi2 = phi * phi;
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const denom = phi2 + v + ex;
    return (ex * (d2 - phi2 - v - ex)) / (2 * denom * denom) - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0 && k < 100) k++;
    B = a - k * TAU;
  }

  let fa = f(A);
  let fb = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPS && guard++ < 200) {
    const C0 = A + ((A - B) * fa) / (fb - fa);
    const fc = f(C0);
    if (fc * fb <= 0) { A = B; fa = fb; } else { fa /= 2; }
    B = C0;
    fb = fc;
  }
  const out = Math.exp(A / 2);
  return Number.isFinite(out) ? clamp(out, 0.01, 0.35) : sigma;
}

/* ----------------------------------------------------------- performance -- */

export interface MatchPerformance {
  won: boolean;
  drawn?: boolean;
  /** Combat score earned (kills, objectives, assists) — mode-agnostic. */
  combatScore: number;
  /** Mean combat score across everyone in the lobby. */
  lobbyMeanScore: number;
  /** Match length in seconds, used to normalise short games. */
  durationSec: number;
  /**
   * Fraction of the player's own team that was human, in [0,1]. Defaults to 1.
   *
   * The win/loss half of the signal is only worth what it says about *you*, and
   * on a team that is five-sixths bots it says almost nothing — it reports how
   * well the bot director was tuned. This scales the team component down as the
   * team fills with bots, which matters enormously in a game that bot-fills by
   * design: without it, rating in the population sim never correlated with true
   * skill above r = 0.44 no matter how many matches a player logged.
   */
  teamHumanFraction?: number;
}

/**
 * Blends the team result with individual contribution into a Glicko score.
 *
 * Pure win/loss is far too noisy to rate an individual in a 12-player lobby:
 * you are one sixth of your team, and matchmaking is actively trying to make
 * the other five cancel out the enemy's five, so the outcome converges on a
 * coin flip *by design*. The more successful the matchmaker, the less a win
 * tells you about the winner. Most of the signal therefore has to come from how
 * far above or below the lobby mean the player scored.
 *
 * Two things scale that split:
 *
 *  - **Match length.** A quit-out or a stomp carries less individual signal, so
 *    short matches lean back on the result.
 *  - **How human the player's team was.** A win beside five bots is a fact
 *    about the bots. `teamHumanFraction` pushes weight onto individual
 *    performance as the team fills with them — worth r = 0.44 → 0.79 against
 *    ground-truth skill in the population sim.
 *
 * The logistic keeps a 3× score from being worth 3× the credit; a carry gets
 * ~0.9 on a win and ~0.5 even on a loss, which is exactly the behaviour players
 * expect from "you played well, you lost".
 */
export function performanceScore(p: MatchPerformance): number {
  const team = p.drawn ? 0.5 : p.won ? 1 : 0;
  const mean = Math.max(1, p.lobbyMeanScore);
  // 0.35 rather than 0.65: one standard deviation of lobby score should move
  // the individual term to roughly 0.7/0.3, not 0.61/0.39. The wider divisor
  // kept every player bunched around 0.5 and threw away most of the signal.
  const rel = (p.combatScore - mean) / (mean * 0.35);
  const perf = 1 / (1 + Math.exp(-rel));
  const w = p.durationSec > 0 ? clamp(p.durationSec / 240, 0.35, 1) : 1;
  const humanShare = clamp(p.teamHumanFraction ?? 1, 0, 1);
  const perfWeight = clamp(w * (0.55 + 0.30 * (1 - humanShare)), 0, 0.95);
  return clamp(team * (1 - perfWeight) + perf * perfWeight, 0.02, 0.98);
}

/* ---------------------------------------------------------------- helper -- */

/**
 * Applies one match to a player record. `opponents` are the enemy team's
 * ratings; in co-op playlists pass the bot team's notional ratings so the
 * result still moves — slowly, because bot ratings carry RD 200.
 */
export function applyMatch(
  rec: PlayerRecord,
  opponents: SkillRating[],
  perf: MatchPerformance,
  now: number,
): { before: number; after: number; delta: number } {
  const before = rec.rating.rating;
  const score = performanceScore(perf);
  const decayedRating = decayed(rec.rating, now);
  const games: RatedGame[] = opponents.map((o) => ({ opponent: o, score }));
  rec.rating = updateRating(decayedRating, games, now);
  if (perf.won) rec.wins++; else if (!perf.drawn) rec.losses++;
  const spm = perf.durationSec > 0 ? (perf.combatScore / perf.durationSec) * 60 : perf.combatScore;
  rec.avgScorePerMin = rec.avgScorePerMin === 0 ? spm : rec.avgScorePerMin * 0.8 + spm * 0.2;
  return { before, after: rec.rating.rating, delta: rec.rating.rating - before };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
