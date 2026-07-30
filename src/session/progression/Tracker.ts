/**
 * Match event tracker — the bridge between what happens in a match and what
 * progression records.
 *
 * It subscribes to events that already exist (`weapon:fire`, `damage:dealt`,
 * `entity:death`, `damage:taken`, `streak:multikill`, `objective:complete`, …)
 * rather than asking gameplay code to call into progression. Two consequences
 * matter:
 *
 *   • Nothing in `src/game`, `src/weapons` or `src/ai` needs editing for weapon
 *     XP, camos and challenges to work.
 *   • The tracker only ever *reads*. XP that other systems already award flows
 *     through `Progression.award`; the tracker adds only the sources nothing
 *     else owns today — first blood and revenge.
 *
 * Kill distance is taken from the last `weapon:fire` origin to the victim's
 * death point, which is the shooter-to-victim distance at the moment of the
 * killing shot. ADS state comes from `weapon:ads`. Both are exactly what a
 * longshot / hipfire challenge needs.
 */

import type { MatchSession } from './Session';
import type { EventPort, KillRecord } from './types';
import { weaponProgressAt } from './Curves';
import { attachmentsBetween, weaponTrack } from './WeaponTracks';

/** What the tracker needs in order to pay out the XP it discovers. */
export interface XpSink {
  award(amount: number, reason: string): void;
}

/**
 * XP for sources nothing else in the game awards yet.
 *
 * `Scoring` owns kills, headshots, longshots, multikills and killstreak
 * call-outs; `Match` owns objective completion and the match-result bonus.
 * Everything below was unpaid before this tracker existed — a Firefight wave and
 * a capture tick were worth literally nothing.
 */
export const TRACKER_XP = {
  firstBlood: 300,
  revenge: 100,
  pointblank: 25,
  /** Surviving and clearing a Firefight wave. */
  waveCleared: 400,
  /** Each 10% of an objective captured *while the player is in the volume*. */
  captureTick: 15,
} as const;

export class MatchEventTracker {
  /** Player killstreak, mirrored locally so kills can be graded. */
  streak = 0;
  /** Entity that last killed the player, for revenge detection. */
  lastKillerId = -1;
  /** Set once any combatant dies, so first blood can only happen once. */
  anyDeath = false;

  private offs: Array<() => void> = [];
  private origin = { x: 0, y: 0, z: 0, valid: false };
  private ads = false;
  /** Weapon XP accumulated per weapon, mirrored so events can report a total. */
  private mirror = new Map<string, number>();
  /** Objective id → highest capture progress already paid for. */
  private captured = new Map<string, number>();

  constructor(
    private readonly session: MatchSession,
    private readonly sink: XpSink,
    private readonly port: EventPort | null,
  ) { }

  /** True while subscribed. */
  get attached(): boolean { return this.offs.length > 0; }

  attach(): void {
    if (!this.port || this.offs.length) return;
    const p = this.port;
    const push = (off: () => void): void => { this.offs.push(off); };

    push(p.on('weapon:switch', (e) => { this.session.setActiveWeapon(e.to); }));

    push(p.on('weapon:fire', (e) => {
      this.session.setActiveWeapon(e.weaponId);
      this.session.noteShot(e.weaponId);
      this.origin.x = e.origin.x; this.origin.y = e.origin.y; this.origin.z = e.origin.z;
      this.origin.valid = true;
    }));

    push(p.on('weapon:ads', (e) => { this.ads = e.active; }));

    push(p.on('damage:dealt', (e) => {
      if (!e.fromPlayer) return;
      this.session.noteHit(this.session.activeWeapon, e.amount, e.headshot);
    }));

    push(p.on('damage:taken', (e) => {
      if (e.lethal) this.lastKillerId = e.sourceId;
    }));

    push(p.on('entity:death', (e) => {
      const firstBlood = !this.anyDeath;
      this.anyDeath = true;
      if (!e.byPlayer) return;
      this.streak += 1;
      const revenge = this.lastKillerId >= 0 && e.id === this.lastKillerId;
      if (revenge) this.lastKillerId = -1;
      this.registerKill({
        weapon: this.session.activeWeapon,
        headshot: e.headshot,
        distance: this.distanceTo(e.point),
        ads: this.ads,
        source: 'player',
        victimId: e.id,
        streak: this.streak,
        revenge,
        firstBlood,
      });
    }));

    push(p.on('player:killed', () => {
      this.streak = 0;
      this.session.noteDeath();
    }));

    push(p.on('streak:multikill', (e) => { this.session.noteMultikill(e.count); }));
    push(p.on('killstreak:activated', () => { this.session.noteKillstreakUsed(); }));
    push(p.on('objective:complete', (e) => {
      this.session.noteObjective();
      this.captured.delete(e.id);
    }));

    // Capture ticks. `contested` is true only while the local player is inside
    // the objective volume, so this pays for work the player actually did and
    // never for a teammate capping alone. Progress is ratcheted, so an
    // objective that decays and is re-taken is not paid for twice.
    push(p.on('objective:update', (e) => {
      const last = this.captured.get(e.id) ?? 0;
      const now = Math.max(0, Math.min(1, e.progress));
      if (now <= last) return;
      if (e.contested) {
        const bands = Math.floor(now * 10) - Math.floor(last * 10);
        if (bands > 0) this.sink.award(TRACKER_XP.captureTick * bands, 'Captures');
      }
      this.captured.set(e.id, now);
    }));

    push(p.on('wave:cleared', (e) => {
      this.session.noteWave(e.index + 1);
      this.sink.award(TRACKER_XP.waveCleared, 'Waves Cleared');
    }));
    push(p.on('hud:score', (e) => { this.session.noteScore(e.total); }));
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  reset(): void {
    this.streak = 0;
    this.lastKillerId = -1;
    this.anyDeath = false;
    this.origin.valid = false;
    this.ads = false;
    this.mirror.clear();
    this.captured.clear();
  }

  /**
   * Books a kill against the session and pays the XP nothing else pays.
   * Public so a host that reconstructs kills from the network (rather than from
   * local events) can drive the exact same path.
   */
  registerKill(k: KillRecord): void {
    const c = this.session.noteKill(k);
    this.session.noteStreak(k.streak);

    if (k.firstBlood) this.sink.award(TRACKER_XP.firstBlood, 'First Blood');
    if (k.revenge) this.sink.award(TRACKER_XP.revenge, 'Revenge');
    if (c.pointblank) this.sink.award(TRACKER_XP.pointblank, 'Point Blank');

    if (!c.attributed || c.weaponXp <= 0) return;

    const id = k.weapon || this.session.activeWeapon;
    const before = this.mirror.get(id) ?? 0;
    const after = before + c.weaponXp;
    this.mirror.set(id, after);

    if (!this.port) return;
    const track = weaponTrack(id);
    // Level shown here is *within this match* — the true level is profile XP
    // plus this, and is recomputed at commit. The HUD only needs the delta.
    const prog = weaponProgressAt(after);
    this.port.emit('progression:weapon:xp', {
      weapon: id, amount: c.weaponXp, total: after, level: prog.level, pct: prog.pct,
    });
    const prevLevel = weaponProgressAt(before).level;
    if (prog.level > prevLevel) {
      this.port.emit('progression:weapon:levelup', {
        weapon: id,
        name: track?.name ?? id,
        level: prog.level,
        unlocked: attachmentsBetween(id, prevLevel, prog.level),
      });
    }
  }

  private distanceTo(point: { x: number; y: number; z: number }): number {
    if (!this.origin.valid) return 0;
    const dx = point.x - this.origin.x;
    const dy = point.y - this.origin.y;
    const dz = point.z - this.origin.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
