/**
 * Bot fill.
 *
 * The feature that decides whether this game is demoable. Four friends want a
 * 6v6: the queue hands back a twelve-slot roster where eight slots are bots of
 * the right difficulty, the match starts in seconds, and every bot gives its
 * slot back the moment a human wants it.
 *
 * This module does **not** implement a bot. `src/ai/` already owns perception,
 * cover, squads and combat behaviour, and `src/game/BotFallback.ts` owns the
 * self-contained stand-in used when the AI system is absent. All this does is
 * *staff* a roster and describe each bot well enough for either of those to
 * spawn it:
 *
 *   - `toAgentOptions(slot)` → `AgentSpawnOptions` for `AISystem.spawn()`
 *   - `toSpawnParams(slot)`  → the non-positional half of `SpawnRequest`
 *     for `ActorAPI.spawnCombatant()` (i.e. `BotFallback`)
 *
 * The caller supplies position and yaw, because only the world/spawn system
 * knows where a body may legally appear — see `src/game/Spawns.ts`.
 *
 * ## Difficulty
 *
 * A bot's notional rating is drawn around the human mean of the lobby, then
 * mapped onto the AI module's four difficulty tiers. `src/ai/types.ts` scales
 * *reaction time and aim error* rather than health, which is the right call, so
 * a "1700-rated" bot dies to the same two bullets as a 1200-rated one — it just
 * finds you faster. The `accuracyScale` / `aggressionScale` fields are the
 * fine-grained trim inside a tier, and map straight onto the multipliers
 * `SpawnRequest` already carries.
 */

import type { Rand } from '../../core/Rand';
import type { Difficulty } from '../../ai/types';
import type { Archetype } from '../../game/types';
import type { BotId, BotSlot, HumanSlot, MatchRoster, MatchSlot, PlaylistDef } from './types';

/* ----------------------------------------------------------------- names -- */

const CALLSIGNS: readonly string[] = [
  'Hawke', 'Vega', 'Rook', 'Sable', 'Cobalt', 'Ridge', 'Talon', 'Marrow',
  'Fenn', 'Kestrel', 'Brisk', 'Nomad', 'Ash', 'Quill', 'Drover', 'Pike',
  'Sorrel', 'Vandal', 'Coyle', 'Halden', 'Priest', 'Rasp', 'Tundra', 'Wren',
  'Slate', 'Barrow', 'Crane', 'Dax', 'Ember', 'Flint', 'Gault', 'Hollow',
];

/* ------------------------------------------------------------ difficulty -- */

interface Tier { id: Difficulty; lo: number; hi: number; }

/**
 * Rating bands. The bottom band is wide because everything under ~1250 plays
 * the same from the receiving end, and the top band is open-ended because
 * `veteran` is already at the edge of fair.
 */
const TIERS: readonly Tier[] = [
  { id: 'recruit', lo: 0, hi: 1250 },
  { id: 'regular', lo: 1250, hi: 1550 },
  { id: 'hardened', lo: 1550, hi: 1850 },
  { id: 'veteran', lo: 1850, hi: 2400 },
];

export function difficultyForRating(rating: number): Difficulty {
  for (const t of TIERS) if (rating < t.hi) return t.id;
  return 'veteran';
}

/** Where inside its tier a rating sits, 0..1. Drives the trim multipliers. */
function tierFraction(rating: number): number {
  for (const t of TIERS) {
    if (rating < t.hi) return clamp((rating - t.lo) / (t.hi - t.lo), 0, 1);
  }
  return 1;
}

/* ------------------------------------------------------------ archetypes -- */

/**
 * Loadout mix for a filled team. Weighted so a bot team reads like a squad:
 * mostly riflemen and assaulters, one marksman holding a lane, an occasional
 * gunner. No juggernauts — that archetype is a boss, not a teammate.
 */
const FILL_WEIGHTS: ReadonlyArray<[Archetype, number]> = [
  ['rifleman', 0.42],
  ['smg', 0.26],
  ['shotgun', 0.12],
  ['sniper', 0.11],
  ['lmg', 0.09],
];

/** Per-team concurrency caps, so a filled team is not five snipers. */
const FILL_CAPS: Partial<Record<Archetype, number>> = { sniper: 1, lmg: 1, shotgun: 2 };

function pickArchetype(taken: Map<Archetype, number>, rng: Rand): Archetype {
  let total = 0;
  const weights: number[] = [];
  for (const [id, w] of FILL_WEIGHTS) {
    const cap = FILL_CAPS[id];
    const used = taken.get(id) ?? 0;
    const eff = cap !== undefined && used >= cap ? 0 : w;
    weights.push(eff);
    total += eff;
  }
  if (total <= 0) return 'rifleman';
  let r = rng.next() * total;
  for (let i = 0; i < FILL_WEIGHTS.length; i++) {
    r -= weights[i];
    if (r <= 0) return FILL_WEIGHTS[i][0];
  }
  return 'rifleman';
}

/* ------------------------------------------------------------------ fill -- */

export interface BotFillOptions {
  /** Rating the fill should aim at; defaults to the lobby's human mean. */
  targetRating?: number;
  /** Spread of the drawn bot ratings, in rating points. */
  spread?: number;
  /** Hard ceiling on bots per team, e.g. to respect a GPU budget. */
  maxPerTeam?: number;
}

export interface BotFillResult {
  added: BotSlot[];
  /** Slots still empty after the fill (bot cap or bots disallowed). */
  shortfall: number;
}

/** Humans currently on a team. */
export function humansOn(roster: MatchRoster, team: number): HumanSlot[] {
  return roster.slots.filter((s): s is HumanSlot => s.kind === 'human' && s.team === team);
}

export function botsOn(roster: MatchRoster, team: number): BotSlot[] {
  return roster.slots.filter((s): s is BotSlot => s.kind === 'bot' && s.team === team);
}

export function slotRating(s: MatchSlot): number {
  return s.kind === 'human' ? s.rating.rating : s.rating;
}

function teamStrength(roster: MatchRoster, team: number): number {
  const slots = roster.slots.filter((s) => s.team === team);
  if (slots.length === 0) return 0;
  return slots.reduce((a, s) => a + slotRating(s), 0) / slots.length;
}

/** Mean rating of every human in the roster, or 1500 when there are none. */
export function lobbyHumanMean(roster: MatchRoster): number {
  const humans = roster.slots.filter((s): s is HumanSlot => s.kind === 'human');
  if (humans.length === 0) return 1500;
  return humans.reduce((a, h) => a + h.rating.rating, 0) / humans.length;
}

let botSeq = 0;
/** Test hook — makes bot ids reproducible across simulation runs. */
export function resetBotIds(): void { botSeq = 0; }

/**
 * Fills every empty slot in `roster` with a bot. Bots are added to the weaker
 * team first and drawn slightly above/below the target so the two sides end up
 * within a few rating points of each other.
 */
export function fillRoster(
  roster: MatchRoster,
  def: PlaylistDef,
  rng: Rand,
  now: number,
  opts: BotFillOptions = {},
): BotFillResult {
  const added: BotSlot[] = [];
  if (!def.allowBots) {
    let missing = 0;
    for (let t = 0; t < def.teams; t++) missing += def.teamSize - roster.slots.filter((s) => s.team === t).length;
    return { added, shortfall: Math.max(0, missing) };
  }

  const target = opts.targetRating ?? lobbyHumanMean(roster);
  const spread = opts.spread ?? 110;
  const maxPerTeam = opts.maxPerTeam ?? def.teamSize;
  const takenByTeam = new Map<number, Map<Archetype, number>>();
  for (let t = 0; t < def.teams; t++) {
    const m = new Map<Archetype, number>();
    for (const b of botsOn(roster, t)) m.set(b.archetype, (m.get(b.archetype) ?? 0) + 1);
    takenByTeam.set(t, m);
  }

  let shortfall = 0;
  for (;;) {
    // Always staff the emptiest team first; break ties on the weaker team.
    let bestTeam = -1;
    let bestKey = Infinity;
    for (let t = 0; t < def.teams; t++) {
      const filled = roster.slots.filter((s) => s.team === t).length;
      if (filled >= def.teamSize) continue;
      if (botsOn(roster, t).length >= maxPerTeam) { shortfall += def.teamSize - filled; continue; }
      const key = filled * 10000 + teamStrength(roster, t) / 1000;
      if (key < bestKey) { bestKey = key; bestTeam = t; }
    }
    if (bestTeam < 0) break;

    // Aim the draw at whatever keeps the two teams level.
    const other = def.teams === 2 ? 1 - bestTeam : bestTeam;
    const mine = teamStrength(roster, bestTeam);
    const theirs = def.teams === 2 ? teamStrength(roster, other) : mine;
    const bias = def.teams === 2 && mine > 0 && theirs > 0 ? clamp(theirs - mine, -160, 160) * 0.5 : 0;
    const rating = clamp(target + bias + rng.normal() * spread, 900, 2300);

    const taken = takenByTeam.get(bestTeam)!;
    const archetype = pickArchetype(taken, rng);
    taken.set(archetype, (taken.get(archetype) ?? 0) + 1);

    const bot = makeBot(rating, archetype, bestTeam, now, rng);
    roster.slots.push(bot);
    added.push(bot);
  }

  return { added, shortfall };
}

function makeBot(rating: number, archetype: Archetype, team: number, now: number, rng: Rand): BotSlot {
  const difficulty = difficultyForRating(rating);
  const f = tierFraction(rating);
  const id: BotId = `bot:${++botSeq}`;
  return {
    kind: 'bot',
    botId: id,
    name: `${rng.pick(CALLSIGNS)}-${(botSeq % 90) + 10}`,
    team,
    rating,
    difficulty,
    archetype,
    // Trim inside the tier: ±15% accuracy, ±20% aggression.
    accuracyScale: 0.85 + f * 0.3,
    aggressionScale: 0.8 + f * 0.4,
    seed: rng.u32(),
    joinedAt: now,
    yieldPriority: botSeq,
  };
}

/* ----------------------------------------------------------------- yield -- */

/**
 * Chooses which bot gives up its slot for an incoming human.
 *
 * Two rules, in order:
 *  1. Prefer the bot whose removal leaves the two teams closest in strength
 *     after the human is added — replacing a 1900 bot with a 1200 human on the
 *     strong team is how a backfill turns into a stomp.
 *  2. Break ties toward the newest bot (highest `yieldPriority`), so bots that
 *     have been fighting for a while — and that the players have been
 *     reacting to — are the last to blink out.
 */
export function chooseBotToYield(
  roster: MatchRoster,
  team: number,
  incomingRating: number,
): BotSlot | null {
  const candidates = botsOn(roster, team);
  if (candidates.length === 0) return null;
  const teams = new Set(roster.slots.map((s) => s.team));
  const otherTeam = [...teams].find((t) => t !== team);
  const otherStrength = otherTeam === undefined ? null : teamStrength(roster, otherTeam);

  let best: BotSlot | null = null;
  let bestCost = Infinity;
  for (const bot of candidates) {
    let cost: number;
    if (otherStrength === null) {
      cost = Math.abs(bot.rating - incomingRating);
    } else {
      const mine = roster.slots.filter((s) => s.team === team);
      const sum = mine.reduce((a, s) => a + slotRating(s), 0) - bot.rating + incomingRating;
      cost = Math.abs(sum / Math.max(1, mine.length) - otherStrength);
    }
    // Tie-break: newest first. 1e-3 keeps it strictly below any real difference.
    const key = cost - bot.yieldPriority * 1e-3;
    if (key < bestCost) { bestCost = key; best = bot; }
  }
  return best;
}

/** Removes a bot from the roster. Returns false when it was already gone. */
export function removeBot(roster: MatchRoster, botId: BotId): boolean {
  const i = roster.slots.findIndex((s) => s.kind === 'bot' && s.botId === botId);
  if (i < 0) return false;
  roster.slots.splice(i, 1);
  return true;
}

/** Which team a new human should join: the emptiest, then the weakest. */
export function teamForIncoming(roster: MatchRoster, def: PlaylistDef): number {
  let best = 0;
  let bestKey = Infinity;
  for (let t = 0; t < def.teams; t++) {
    const humans = humansOn(roster, t).length;
    const key = humans * 10000 + teamStrength(roster, t) / 1000;
    if (key < bestKey) { bestKey = key; best = t; }
  }
  return best;
}

/* --------------------------------------------------------------- adapters -- */

/** Fields `AISystem.spawn()` wants. Position/yaw stay with the caller. */
export interface AgentOptionsLike {
  loadout: Archetype;
  difficulty: Difficulty;
  seed: number;
  name: string;
  faction: 'militia' | 'pmc' | 'spetsnaz';
}

export function toAgentOptions(
  slot: BotSlot,
  faction: 'militia' | 'pmc' | 'spetsnaz' = 'pmc',
): AgentOptionsLike {
  return {
    loadout: slot.archetype,
    difficulty: slot.difficulty,
    seed: slot.seed,
    name: slot.name,
    faction,
  };
}

/** The non-positional half of `SpawnRequest` for `ActorAPI.spawnCombatant()`. */
export interface SpawnParamsLike {
  archetype: Archetype;
  faction: 'militia' | 'pmc' | 'spetsnaz';
  team: 'friendly' | 'hostile';
  seed: number;
  health: number;
  accuracy: number;
  aggression: number;
  tag: string;
}

/**
 * `localTeam` is the team index the local player is on, so bots on it become
 * `friendly` and everything else becomes `hostile` — the only two teams the
 * game layer models today.
 */
export function toSpawnParams(
  slot: BotSlot,
  localTeam: number,
  faction: 'militia' | 'pmc' | 'spetsnaz' = 'pmc',
): SpawnParamsLike {
  return {
    archetype: slot.archetype,
    faction,
    team: slot.team === localTeam ? 'friendly' : 'hostile',
    seed: slot.seed,
    // Bot fill never scales health — difficulty is reaction time and aim.
    health: 1,
    accuracy: slot.accuracyScale,
    aggression: slot.aggressionScale,
    tag: `mmbot:${slot.botId}`,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
