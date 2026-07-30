/**
 * The in-match ledger.
 *
 * One instance lives for the duration of a match and is thrown away at commit.
 * It never touches the profile — that is the whole point: an abandoned match
 * costs nothing, and on a client the ledger is a *prediction* until the host
 * confirms it.
 */

import { longshotRange, WXP, weaponXpForKill } from './WeaponTracks';
import { classifyXpReason } from './XpSources';
import { emptyWeaponStats } from './Challenges';
import type {
  KillRecord, MatchRecord, WeaponMatchStats, XpLedgerRow, XpSourceId,
} from './types';

/** Metres inside which a kill counts as point blank, whatever the weapon. */
export const POINT_BLANK_RANGE = 5;

export interface KillClassification {
  longshot: boolean;
  pointblank: boolean;
  hipfire: boolean;
  weaponXp: number;
  /** False when the kill came from a killstreak and must not level a weapon. */
  attributed: boolean;
}

export interface MatchCounters {
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  longshots: number;
  bestStreak: number;
  bestMultikill: number;
  multikills: number;
  objectives: number;
  wavesCleared: number;
  killstreaksUsed: number;
  shotsFired: number;
  shotsHit: number;
  revengeKills: number;
  firstBloods: number;
}

function emptyCounters(): MatchCounters {
  return {
    score: 0, kills: 0, deaths: 0, assists: 0, headshots: 0, longshots: 0,
    bestStreak: 0, bestMultikill: 0, multikills: 0, objectives: 0, wavesCleared: 0,
    killstreaksUsed: 0, shotsFired: 0, shotsHit: 0, revengeKills: 0, firstBloods: 0,
  };
}

export class MatchSession {
  mode = 'operation';
  modeName = 'Operation';
  seed = 0;
  replayHash = '';
  durationSec = 0;

  readonly counters: MatchCounters = emptyCounters();
  /** Weapon the player is currently holding; kills are attributed to it. */
  activeWeapon = '';

  private rows = new Map<string, XpLedgerRow>();
  private weapons = new Map<string, WeaponMatchStats>();
  private total = 0;

  begin(mode: string, modeName: string, seed = 0): void {
    this.mode = mode;
    this.modeName = modeName;
    this.seed = seed;
    this.replayHash = '';
    this.durationSec = 0;
    this.rows.clear();
    this.weapons.clear();
    this.total = 0;
    Object.assign(this.counters, emptyCounters());
  }

  get xpTotal(): number { return this.total; }

  /* --------------------------------------------------------------- xp -- */

  /** Records XP against a label. Returns the classified source. */
  noteXp(amount: number, label: string, source?: XpSourceId): XpSourceId {
    const src = source ?? classifyXpReason(label);
    const key = `${src}|${label}`;
    let row = this.rows.get(key);
    if (!row) { row = { source: src, label, xp: 0, count: 0 }; this.rows.set(key, row); }
    row.xp += amount;
    row.count += 1;
    this.total += amount;
    return src;
  }

  /** Ledger rows, biggest first — the order the after-action screen reads them. */
  ledger(): XpLedgerRow[] {
    return [...this.rows.values()].sort((a, b) => b.xp - a.xp || a.label.localeCompare(b.label));
  }

  /* ----------------------------------------------------------- weapons -- */

  weapon(id: string): WeaponMatchStats {
    let w = this.weapons.get(id);
    if (!w) {
      w = { weapon: id, xp: 0, ...emptyWeaponStats() };
      this.weapons.set(id, w);
    }
    return w;
  }

  weaponRows(): WeaponMatchStats[] {
    return [...this.weapons.values()].sort((a, b) => b.xp - a.xp || b.kills - a.kills);
  }

  setActiveWeapon(id: string): void {
    if (!id) return;
    this.activeWeapon = id;
    this.weapon(id);
  }

  noteShot(weaponId: string, rounds = 1): void {
    this.counters.shotsFired += rounds;
    this.weapon(weaponId || this.activeWeapon || 'unknown').shotsFired += rounds;
  }

  noteHit(weaponId: string, damage: number, headshot: boolean): void {
    this.counters.shotsHit += 1;
    const w = this.weapon(weaponId || this.activeWeapon || 'unknown');
    w.shotsHit += 1;
    w.damage += Math.max(0, damage);
    if (headshot) { /* headshot kills are counted on the kill, not the hit */ }
  }

  noteTime(weaponId: string, seconds: number): void {
    if (seconds <= 0) return;
    this.weapon(weaponId || this.activeWeapon || 'unknown').timeUsed += seconds;
  }

  /* ------------------------------------------------------------- kills -- */

  /** Books a kill and returns how it classified, so callers can award bonuses. */
  noteKill(k: KillRecord): KillClassification {
    const c = this.counters;
    c.kills += 1;
    if (k.headshot) c.headshots += 1;
    c.bestStreak = Math.max(c.bestStreak, k.streak);
    if (k.revenge) c.revengeKills += 1;
    if (k.firstBlood) c.firstBloods += 1;

    const byKillstreak = k.source !== 'player';
    const longshot = !byKillstreak && k.distance >= longshotRange(k.weapon);
    const pointblank = !byKillstreak && k.distance > 0 && k.distance <= POINT_BLANK_RANGE;
    const hipfire = !byKillstreak && !k.ads;
    if (longshot) c.longshots += 1;

    if (byKillstreak) {
      return { longshot: false, pointblank: false, hipfire: false, weaponXp: 0, attributed: false };
    }

    const weaponXp = weaponXpForKill({
      headshot: k.headshot, longshot, pointblank, hipfire,
      byKillstreak: false, streak: k.streak,
    });

    const w = this.weapon(k.weapon || this.activeWeapon || 'unknown');
    w.kills += 1;
    w.xp += weaponXp;
    if (k.headshot) w.headshots += 1;
    if (longshot) w.longshots += 1;
    if (pointblank) w.pointblankKills += 1;
    if (hipfire) w.hipfireKills += 1; else w.adsKills += 1;
    if (k.streak >= 3) w.killstreakKills += 1;
    if (k.revenge) w.revengeKills += 1;
    if (k.firstBlood) w.firstBloods += 1;

    return { longshot, pointblank, hipfire, weaponXp, attributed: true };
  }

  noteDeath(weaponId = this.activeWeapon): void {
    this.counters.deaths += 1;
    if (weaponId) this.weapon(weaponId).deaths += 1;
  }

  noteAssist(weaponId = this.activeWeapon): void {
    this.counters.assists += 1;
    const w = this.weapon(weaponId || 'unknown');
    w.assists += 1;
    w.xp += WXP.assist;
  }

  /** `count` is the size of the multi-kill (2 = double kill). */
  noteMultikill(count: number, weaponId = this.activeWeapon): void {
    if (count < 2) return;
    const c = this.counters;
    c.multikills += 1;
    c.bestMultikill = Math.max(c.bestMultikill, count);
    const w = this.weapon(weaponId || 'unknown');
    w.multikills += 1;
    w.xp += WXP.multikillStep * (count - 1);
  }

  noteObjective(n = 1): void { this.counters.objectives += n; }
  noteWave(n = 1): void { this.counters.wavesCleared = Math.max(this.counters.wavesCleared, n); }
  noteKillstreakUsed(): void { this.counters.killstreaksUsed += 1; }
  noteScore(total: number): void { this.counters.score = total; }
  noteStreak(streak: number): void {
    this.counters.bestStreak = Math.max(this.counters.bestStreak, streak);
  }

  /* ------------------------------------------------------------ record -- */

  /**
   * Freezes the session into the authority-checkable record. `win` and the
   * end-of-match weapon bonus are applied here so the record is complete.
   */
  toRecord(win: boolean, durationSec: number, replayHash = ''): MatchRecord {
    this.durationSec = durationSec;
    this.replayHash = replayHash;

    // End-of-match weapon bonus: only weapons actually used earn it.
    for (const w of this.weapons.values()) {
      if (w.kills === 0 && w.shotsFired === 0 && w.assists === 0) continue;
      w.xp += WXP.matchComplete + (win ? WXP.matchWinBonus : 0);
      w.xp += Math.round(w.damage * WXP.damage);
    }

    const c = this.counters;
    return {
      mode: this.mode,
      modeName: this.modeName,
      win,
      durationSec,
      seed: this.seed,
      replayHash,
      score: c.score,
      kills: c.kills,
      deaths: c.deaths,
      assists: c.assists,
      headshots: c.headshots,
      longshots: c.longshots,
      bestStreak: c.bestStreak,
      bestMultikill: c.bestMultikill,
      objectives: c.objectives,
      wavesCleared: c.wavesCleared,
      killstreaksUsed: c.killstreaksUsed,
      shotsFired: c.shotsFired,
      shotsHit: Math.min(c.shotsHit, c.shotsFired || c.shotsHit),
      revengeKills: c.revengeKills,
      firstBloods: c.firstBloods,
      weapons: this.weaponRows(),
      ledger: this.ledger(),
      xpTotal: this.total,
    };
  }
}
