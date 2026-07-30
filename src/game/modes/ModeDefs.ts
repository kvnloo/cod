/**
 * Mode definitions — the data half of a game mode.
 *
 * A mode in this codebase is a `ModeDef` (this file: pure data, no behaviour)
 * plus a small rules object (`TeamMode` and its five subclasses) that reads it.
 * Everything a designer normally wants to tune — win condition, score limit,
 * time limit, respawn behaviour, team counts, round structure, objective
 * geometry, spawn policy and the score table — lives here, so adding a playlist
 * variant ("Hardpoint 150", "Hardcore S&D") is a literal object spread rather
 * than a new class.
 *
 * `ModeId` deliberately widens `GameModeId` from `src/game/types.ts` instead of
 * editing it: that union is consumed by exhaustive `Record<GameModeId, …>`
 * tables in `src/session/**`, which this agent does not own. Once the session
 * layer is ready, `GameModeId` should absorb these ids and `ModeId` can become
 * an alias.
 */

import type { GameModeId, Team } from '../types';

export type ModeId =
  | GameModeId
  | 'dom'
  | 'snd'
  | 'hardpoint'
  | 'kc'
  | 'ffa';

/** New mode ids this module adds on top of the legacy three. */
export const MULTIPLAYER_MODE_IDS: readonly ModeId[] = ['tdm', 'dom', 'snd', 'hardpoint', 'kc', 'ffa'];
export const ALL_MODE_IDS: readonly ModeId[] =
  ['operation', 'tdm', 'firefight', 'dom', 'snd', 'hardpoint', 'kc', 'ffa'];

/**
 * How the match is decided.
 *  - `score`       first team to `scoreLimit`, or ahead when the clock expires
 *  - `rounds`      first team to `rounds.roundsToWin` round wins
 *  - `elimination` a single round, last team standing (unused by the shipping
 *                  set but the rules object honours it)
 */
export type WinCondition = 'score' | 'rounds' | 'elimination';

export type ObjectiveLayout = 'none' | 'zones' | 'bomb' | 'hardpoint' | 'tags';

export interface TeamRules {
  /** 2 for team modes, 1 for free-for-all (everyone is their own team). */
  teams: number;
  /** Bodies per team, player included. */
  teamSize: number;
  friendlyFire: boolean;
  /** Sides swap at halftime — meaningful for `bomb` layouts. */
  swapSidesAtHalf: boolean;
}

export interface RespawnRules {
  enabled: boolean;
  /** Player respawn delay in seconds. */
  delay: number;
  /** Bot respawn delay in seconds. */
  botDelay: number;
  /**
   * When > 0 the dead respawn together on a repeating wave of this period
   * instead of individually — Domination's answer to spawn trickling.
   */
  wave: number;
  /** Health regen delay / rate handed to `Lifecycle`. */
  regenDelay: number;
  regenRate: number;
}

export interface RoundRules {
  enabled: boolean;
  /** Round wins needed to take the match. */
  roundsToWin: number;
  /** Hard cap before overtime rules apply. */
  maxRounds: number;
  /** Seconds per round. */
  roundTime: number;
  /** Swap attack/defence after this many completed rounds; 0 disables. */
  halftimeAfter: number;
  /** Extra rounds granted when the tally is level at `maxRounds`. */
  overtimeRounds: number;
  /** Dead time between rounds. */
  intermission: number;
  /** Frozen "get ready" beat at the head of each round. */
  freezeTime: number;
}

export interface OvertimeRules {
  enabled: boolean;
  /** Sudden-death seconds for score modes; first score wins. */
  seconds: number;
}

export interface ObjectiveRules {
  layout: ObjectiveLayout;
  /** Flags / sites / hills to place. */
  count: number;
  radius: number;
  /** Domination: seconds for one operator to flip a flag. */
  captureTime: number;
  /** Hardpoint: seconds before the hill moves. */
  rotateEvery: number;
  /** S&D. */
  plantTime: number;
  fuse: number;
  defuseTime: number;
  /** Kill Confirmed. */
  tagLifetime: number;
  tagRadius: number;
  /** Metres between placed sites — keeps flags from stacking. */
  siteSpread: number;
}

/**
 * How respawns are chosen. `kind` picks the policy; the distances tune it.
 *  - `contested`  away from live enemies, near allies (TDM / KC)
 *  - `home`       biased to the team's half, used before objectives exist
 *  - `objective`  biased toward flags/hills the team already owns (DOM / HP)
 *  - `fixed`      the team's start pad, no reselection (S&D)
 *  - `scatter`    maximum separation from everyone (FFA)
 */
export interface SpawnRules {
  kind: 'contested' | 'home' | 'objective' | 'fixed' | 'scatter';
  idealDistance: number;
  minDistance: number;
  maxDistance: number;
  /** Seconds a spawn node is off-limits after use. */
  cooldown: number;
  /** Refuse nodes visible to a threat. */
  requireHidden: boolean;
  /** Metres of clearance demanded around a live objective. */
  objectiveClearance: number;
}

export interface ScoreRules {
  perKill: number;
  /** Domination: points per owned flag per `tickPeriod`. */
  perObjectiveTick: number;
  tickPeriod: number;
  perCapture: number;
  perConfirm: number;
  perDeny: number;
  perPlant: number;
  perDefuse: number;
  perRoundWin: number;
  /** Player-facing score (not team score) for objective play. */
  playerObjectiveScore: number;
}

export interface ModeDef {
  id: ModeId;
  name: string;
  /** Three-letter HUD tag. */
  short: string;
  blurb: string;
  win: WinCondition;
  /** 0 when the mode is not score-limited. */
  scoreLimit: number;
  /** Seconds, or -1 for untimed. */
  timeLimit: number;
  warmup: number;
  teams: TeamRules;
  respawn: RespawnRules;
  rounds: RoundRules;
  overtime: OvertimeRules;
  objective: ObjectiveRules;
  spawn: SpawnRules;
  score: ScoreRules;
  /** Director pressure envelope — bot bodies are the mode's, not the director's. */
  eliteBias: number;
}

/* ------------------------------------------------------------- defaults -- */

function teams(over: Partial<TeamRules> = {}): TeamRules {
  return { teams: 2, teamSize: 6, friendlyFire: false, swapSidesAtHalf: false, ...over };
}

function respawn(over: Partial<RespawnRules> = {}): RespawnRules {
  return { enabled: true, delay: 5, botDelay: 5.5, wave: 0, regenDelay: 4, regenRate: 36, ...over };
}

function rounds(over: Partial<RoundRules> = {}): RoundRules {
  return {
    enabled: false, roundsToWin: 1, maxRounds: 1, roundTime: 120,
    halftimeAfter: 0, overtimeRounds: 0, intermission: 6, freezeTime: 4, ...over,
  };
}

function objective(over: Partial<ObjectiveRules> = {}): ObjectiveRules {
  return {
    layout: 'none', count: 0, radius: 7.5, captureTime: 8, rotateEvery: 60,
    plantTime: 5, fuse: 45, defuseTime: 7.5, tagLifetime: 30, tagRadius: 2.6,
    siteSpread: 34, ...over,
  };
}

function spawn(over: Partial<SpawnRules> = {}): SpawnRules {
  return {
    kind: 'contested', idealDistance: 34, minDistance: 18, maxDistance: 105,
    cooldown: 11, requireHidden: true, objectiveClearance: 0, ...over,
  };
}

function score(over: Partial<ScoreRules> = {}): ScoreRules {
  return {
    perKill: 1, perObjectiveTick: 1, tickPeriod: 5, perCapture: 0, perConfirm: 1,
    perDeny: 0, perPlant: 0, perDefuse: 0, perRoundWin: 1, playerObjectiveScore: 250, ...over,
  };
}

/* ------------------------------------------------------------ the canon -- */

export const MODE_DEFS: Record<ModeId, ModeDef> = {
  /* ---- legacy single-player shapes, described so tooling can enumerate them */
  operation: {
    id: 'operation', name: 'Operation', short: 'OPS',
    blurb: 'Scripted co-op operation with a buy phase.',
    win: 'elimination', scoreLimit: 0, timeLimit: -1, warmup: 0,
    teams: teams({ teamSize: 4 }), respawn: respawn({ enabled: false }),
    rounds: rounds(), overtime: { enabled: false, seconds: 0 },
    objective: objective(), spawn: spawn(), score: score(), eliteBias: 1,
  },
  firefight: {
    id: 'firefight', name: 'Firefight', short: 'FFT',
    blurb: 'Endless wave survival.',
    win: 'elimination', scoreLimit: 0, timeLimit: -1, warmup: 0,
    teams: teams({ teamSize: 1 }), respawn: respawn({ enabled: false }),
    rounds: rounds(), overtime: { enabled: false, seconds: 0 },
    objective: objective(), spawn: spawn(), score: score(), eliteBias: 1,
  },

  /* ---------------------------------------------------- team deathmatch -- */
  tdm: {
    id: 'tdm', name: 'Team Deathmatch', short: 'TDM',
    blurb: 'First team to 75 kills.',
    win: 'score', scoreLimit: 75, timeLimit: 600, warmup: 6,
    teams: teams(),
    respawn: respawn({ delay: 5, botDelay: 5.5 }),
    rounds: rounds(),
    overtime: { enabled: true, seconds: 60 },
    objective: objective(),
    spawn: spawn({ kind: 'contested', idealDistance: 34, minDistance: 20 }),
    score: score({ perKill: 1 }),
    eliteBias: 0.45,
  },

  /* --------------------------------------------------------- domination -- */
  dom: {
    id: 'dom', name: 'Domination', short: 'DOM',
    blurb: 'Capture and hold three flags. First to 200.',
    win: 'score', scoreLimit: 200, timeLimit: 600, warmup: 6,
    // Sides swap once a team banks half the score limit — COD's Domination
    // halftime, expressed on the score clock rather than a round tally.
    teams: teams({ swapSidesAtHalf: true }),
    // Wave respawns: the classic answer to a three-flag spawn cascade.
    respawn: respawn({ delay: 5, botDelay: 6, wave: 7.5 }),
    rounds: rounds(),
    overtime: { enabled: true, seconds: 90 },
    objective: objective({ layout: 'zones', count: 3, radius: 8, captureTime: 8, siteSpread: 30 }),
    spawn: spawn({ kind: 'objective', idealDistance: 30, minDistance: 16, objectiveClearance: 12 }),
    score: score({ perKill: 0, perObjectiveTick: 1, tickPeriod: 5, perCapture: 0, playerObjectiveScore: 200 }),
    eliteBias: 0.4,
  },

  /* ------------------------------------------------- search and destroy -- */
  snd: {
    id: 'snd', name: 'Search and Destroy', short: 'SND',
    blurb: 'One life. Plant or defuse. First to five rounds.',
    win: 'rounds', scoreLimit: 0, timeLimit: -1, warmup: 5,
    teams: teams({ swapSidesAtHalf: true }),
    respawn: respawn({ enabled: false, delay: 0, botDelay: 0, regenDelay: 6, regenRate: 0 }),
    rounds: rounds({
      enabled: true, roundsToWin: 5, maxRounds: 9, roundTime: 120,
      halftimeAfter: 4, overtimeRounds: 2, intermission: 6, freezeTime: 4,
    }),
    overtime: { enabled: true, seconds: 0 },
    objective: objective({ layout: 'bomb', count: 2, radius: 6, plantTime: 5, fuse: 45, defuseTime: 7.5, siteSpread: 46 }),
    spawn: spawn({ kind: 'fixed', idealDistance: 60, minDistance: 45, maxDistance: 140, cooldown: 0, objectiveClearance: 18 }),
    score: score({ perKill: 0, perRoundWin: 1, perPlant: 0, perDefuse: 0, playerObjectiveScore: 500 }),
    eliteBias: 0.55,
  },

  /* ---------------------------------------------------------- hardpoint -- */
  hardpoint: {
    id: 'hardpoint', name: 'Hardpoint', short: 'HP',
    blurb: 'Hold the rotating zone. First to 250.',
    win: 'score', scoreLimit: 250, timeLimit: 600, warmup: 6,
    teams: teams(),
    respawn: respawn({ delay: 4, botDelay: 4.5 }),
    rounds: rounds(),
    overtime: { enabled: true, seconds: 90 },
    objective: objective({ layout: 'hardpoint', count: 5, radius: 8.5, rotateEvery: 60, siteSpread: 26 }),
    spawn: spawn({ kind: 'objective', idealDistance: 40, minDistance: 22, objectiveClearance: 16 }),
    score: score({ perKill: 0, perObjectiveTick: 1, tickPeriod: 1, playerObjectiveScore: 150 }),
    eliteBias: 0.4,
  },

  /* ----------------------------------------------------- kill confirmed -- */
  kc: {
    id: 'kc', name: 'Kill Confirmed', short: 'KC',
    blurb: 'Kills are worthless until the tag is collected. First to 65.',
    win: 'score', scoreLimit: 65, timeLimit: 600, warmup: 6,
    teams: teams(),
    respawn: respawn({ delay: 5, botDelay: 5 }),
    rounds: rounds(),
    overtime: { enabled: true, seconds: 60 },
    objective: objective({ layout: 'tags', tagLifetime: 30, tagRadius: 3 }),
    spawn: spawn({ kind: 'contested', idealDistance: 32, minDistance: 18 }),
    score: score({ perKill: 0, perConfirm: 1, perDeny: 0, playerObjectiveScore: 150 }),
    eliteBias: 0.45,
  },

  /* ------------------------------------------------------ free-for-all -- */
  ffa: {
    id: 'ffa', name: 'Free-for-All', short: 'FFA',
    blurb: 'Eight operators, no friends. First to 30.',
    win: 'score', scoreLimit: 30, timeLimit: 600, warmup: 6,
    teams: teams({ teams: 1, teamSize: 8, friendlyFire: true }),
    respawn: respawn({ delay: 4, botDelay: 4.5 }),
    rounds: rounds(),
    overtime: { enabled: true, seconds: 60 },
    objective: objective(),
    spawn: spawn({ kind: 'scatter', idealDistance: 40, minDistance: 26, maxDistance: 140, cooldown: 14 }),
    score: score({ perKill: 1 }),
    eliteBias: 0.5,
  },
};

export function modeDef(id: ModeId): ModeDef {
  return MODE_DEFS[id] ?? MODE_DEFS.tdm;
}

export function isMultiplayerMode(id: ModeId): boolean {
  return MULTIPLAYER_MODE_IDS.includes(id);
}

/** Deterministic index used by the replay log so a mode change shows up in the hash. */
export function modeIndexOf(id: ModeId): number {
  const i = ALL_MODE_IDS.indexOf(id);
  return i < 0 ? 0 : i;
}

/** The other side. FFA has no "other side", so it answers `hostile`. */
export function otherTeam(t: Team): Team {
  return t === 'friendly' ? 'hostile' : 'friendly';
}
