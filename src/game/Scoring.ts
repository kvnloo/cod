/**
 * Scoring, multi-kill detection, kill streaks and the announcer.
 *
 * Two different things are called a "streak" in this genre and both live here:
 *   • *multi-kill* — kills inside a rolling 2.4 s window (Double Kill → …)
 *   • *killstreak* — kills without dying, which is what earns abilities
 *
 * Announcements are rate-limited by priority so a Triple Kill never gets
 * stepped on by a low-priority "enemy down" line.
 */

import type { Emitter } from './Services';
import { Progression, XP } from './Progression';
import type { KillstreakId } from './types';

/** Rolling window for multi-kill detection, seconds. */
const MULTIKILL_WINDOW = 2.4;

const MULTIKILL_NAMES: readonly string[] = [
  '', '', 'DOUBLE KILL', 'TRIPLE KILL', 'FOUR KILL', 'FIVE KILL',
  'SIX KILL', 'SEVEN KILL', 'FRENZY', 'RAMPAGE',
];

/** Killstreak call-outs that are pure announcements (not abilities). */
const STREAK_CALLOUTS: ReadonlyArray<{ at: number; text: string }> = [
  { at: 3, text: 'KILLSTREAK ×3' },
  { at: 5, text: 'ON A ROLL' },
  { at: 7, text: 'DOMINATING' },
  { at: 10, text: 'UNSTOPPABLE' },
  { at: 15, text: 'GODLIKE' },
  { at: 20, text: 'LEGENDARY' },
  { at: 30, text: 'UNTOUCHABLE' },
];

export interface KillContext {
  headshot: boolean;
  /** Metres between the player and the victim. */
  distance: number;
  /** 'player' | 'sentry' | 'airstrike' | 'explosion' | ... */
  source: string;
  archetype: string;
  score: number;
  /** Set when the kill also counts toward an objective. */
  objective?: boolean;
}

export interface ScoreState {
  score: number;
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  /** Kills since the last death. */
  streak: number;
  bestStreak: number;
  /** Longest multi-kill achieved. */
  bestMultikill: number;
  shotsFired: number;
  shotsHit: number;
}

export class Scoring {
  readonly state: ScoreState = {
    score: 0, kills: 0, deaths: 0, headshots: 0, assists: 0,
    streak: 0, bestStreak: 0, bestMultikill: 0, shotsFired: 0, shotsHit: 0,
  };

  /** Kills counted toward the *killstreak reward* pool (resets on death). */
  streakPool = 0;

  private multikillCount = 0;
  private multikillTimer = 0;
  private announceCooldown = 0;
  private announcePriority = 0;
  private calloutsFired = new Set<number>();

  constructor(private emit: Emitter, private progression: Progression) { }

  reset(): void {
    const s = this.state;
    s.score = 0; s.kills = 0; s.deaths = 0; s.headshots = 0; s.assists = 0;
    s.streak = 0; s.bestStreak = 0; s.bestMultikill = 0; s.shotsFired = 0; s.shotsHit = 0;
    this.streakPool = 0;
    this.multikillCount = 0;
    this.multikillTimer = 0;
    this.announceCooldown = 0;
    this.announcePriority = 0;
    this.calloutsFired.clear();
  }

  fixedUpdate(dt: number): void {
    if (this.multikillTimer > 0) {
      this.multikillTimer -= dt;
      if (this.multikillTimer <= 0) this.multikillCount = 0;
    }
    if (this.announceCooldown > 0) {
      this.announceCooldown -= dt;
      if (this.announceCooldown <= 0) this.announcePriority = 0;
    }
  }

  /** Raw score with no kill bookkeeping — objectives, captures, assists. */
  addScore(amount: number, reason: string): void {
    if (amount === 0) return;
    this.state.score += amount;
    this.emit('score:add', { amount, reason });
    this.emit('hud:score', { amount, reason, total: this.state.score });
  }

  registerShot(hit: boolean): void {
    this.state.shotsFired++;
    if (hit) this.state.shotsHit++;
  }

  assist(): void {
    this.state.assists++;
    this.addScore(50, 'Assist');
    this.progression.award(XP.assist, 'Assists');
  }

  /**
   * Books a player kill. Returns the multi-kill count this kill produced so the
   * caller can drive FX (1 = single kill).
   */
  playerKill(ctx: KillContext): number {
    const s = this.state;
    s.kills++;
    s.streak++;
    this.streakPool++;
    if (ctx.headshot) s.headshots++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);

    let score = ctx.score;
    let xp = XP.kill;
    let label = 'Kill';

    if (ctx.headshot) { score += 30; xp += XP.headshotBonus; label = 'Headshot'; }
    if (ctx.distance > 55) { xp += XP.longshotBonus; label = 'Longshot'; }
    if (ctx.source !== 'player') { xp = Math.round(xp * 0.6) + XP.killstreakKill; label = `${titleCase(ctx.source)} Kill`; }
    if (ctx.objective) { score += 50; label = 'Objective Kill'; }

    this.addScore(score, label);
    this.progression.award(xp, pluralLabel(label));

    /* --- multi-kill window --- */
    this.multikillCount = this.multikillTimer > 0 ? this.multikillCount + 1 : 1;
    this.multikillTimer = MULTIKILL_WINDOW;
    if (this.multikillCount >= 2) {
      const n = Math.min(this.multikillCount, MULTIKILL_NAMES.length - 1);
      const name = MULTIKILL_NAMES[n];
      s.bestMultikill = Math.max(s.bestMultikill, this.multikillCount);
      const bonusXp = [0, 0, XP.multikill2, XP.multikill3, XP.multikill4, XP.multikill5][Math.min(n, 5)];
      this.addScore(25 * (this.multikillCount - 1), name);
      this.progression.award(bonusXp, 'Multikills');
      this.emit('streak:multikill', { count: this.multikillCount, name, window: MULTIKILL_WINDOW });
      this.announce(`mk${this.multikillCount}`, name, 3 + this.multikillCount);
    }

    /* --- killstreak call-outs --- */
    for (const c of STREAK_CALLOUTS) {
      if (s.streak === c.at && !this.calloutsFired.has(c.at)) {
        this.calloutsFired.add(c.at);
        this.progression.award(XP.streakStep * (c.at / 3), 'Killstreaks');
        this.announce(`streak${c.at}`, c.text, 2 + c.at / 5);
      }
    }

    return this.multikillCount;
  }

  /** Books the player's death: streak and multi-kill state collapse. */
  playerDeath(): void {
    this.state.deaths++;
    this.state.streak = 0;
    this.streakPool = 0;
    this.multikillCount = 0;
    this.multikillTimer = 0;
    this.calloutsFired.clear();
  }

  /** Announcer with priority arbitration. */
  announce(key: string, text: string, priority: number): void {
    if (this.announceCooldown > 0 && priority <= this.announcePriority) return;
    this.announceCooldown = 1.35;
    this.announcePriority = priority;
    this.emit('hud:announce', { key, text, priority });
  }

  /** Reports progress toward the next killstreak reward. */
  publishStreakProgress(next: KillstreakId | null, needed: number): void {
    this.emit('streak:progress', { kills: this.streakPool, next, needed });
  }

  get accuracy(): number {
    return this.state.shotsFired > 0 ? this.state.shotsHit / this.state.shotsFired : 0;
  }
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Headshot" → "Headshots"; used to group ledger rows on the summary screen. */
function pluralLabel(s: string): string {
  return s.endsWith('s') ? s : `${s}s`;
}
