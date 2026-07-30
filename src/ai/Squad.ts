/**
 * Squads: the shared blackboard, role assignment, movement arbitration and
 * callouts.
 *
 * What makes a CoD firefight feel choreographed is not clever individual AI, it
 * is that only one man moves at a time and somebody is always shooting at you.
 * That is what this file enforces:
 *
 *  - **A move token.** An agent may not cross open ground unless the squad grants
 *    it the token, and the squad only grants it while somebody else can put
 *    rounds on the target. One mover, everyone else shooting: a bounding
 *    advance, which is exactly what a real fireteam does.
 *  - **Roles.** Anchor (holds the front and keeps the target's attention),
 *    suppressor (volume of fire, doesn't need to hit), flanker (goes wide).
 *    Reassigned periodically and on death, so a squad reorganises when you kill
 *    the man doing the shooting.
 *  - **One voice at a time.** Every line goes through a lock, so a six-man squad
 *    never shouts over itself.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { Rand } from '../core/Rand';
import type { Agent } from './Agent';
import type { SquadRole, VoiceLine } from './types';
import { VO } from './types';

/** Seconds a mover may hold the token before it is taken back. */
const TOKEN_MAX_HOLD = 5.0;
/** Minimum gap between any two squad lines, seconds. */
const SPEECH_GAP = 0.55;

export class Squad {
  readonly id: number;
  readonly members: Agent[] = [];
  readonly rand: Rand;

  /** Best shared estimate of where the enemy is. */
  readonly targetPosition = new THREE.Vector3();
  readonly targetVelocity = new THREE.Vector3();
  targetConfidence = 0;
  /** Sim time of the last update to the shared contact. */
  targetUpdated = -1e9;
  /** How many members currently have eyes on. */
  eyesOn = 0;
  /** Seconds since anybody in the squad last had eyes on the target. */
  timeSinceEyes = 0;
  /** How many members can currently shoot. */
  gunsOn = 0;
  engaged = false;
  /** Sim time combat began, for pacing pushes. */
  engagedAt = -1e9;

  /** Agent id currently allowed to move across open ground. */
  moveToken = -1;
  private tokenExpires = -1e9;
  private tokenPriority = 0;

  /** Anti-spam for grenades: one in the air per squad, with a cooldown. */
  grenadeReadyAt = -1e9;
  grenadesInFlight = 0;

  private speechFreeAt = -1e9;
  private lineCooldown = new Map<string, number>();
  private roleTimer = 0;
  private flankSide = 1;

  constructor(id: number, seed: number) {
    this.id = id;
    this.rand = new Rand(seed ^ (id * 0x9e3779b9));
    this.flankSide = this.rand.bool() ? 1 : -1;
  }

  get size(): number { return this.members.length; }
  get aliveCount(): number {
    let n = 0;
    for (const m of this.members) if (m.alive) n++;
    return n;
  }

  add(agent: Agent): void {
    if (this.members.indexOf(agent) < 0) this.members.push(agent);
    this.roleTimer = 0;
  }

  remove(agent: Agent): void {
    const i = this.members.indexOf(agent);
    if (i >= 0) this.members.splice(i, 1);
    if (this.moveToken === agent.id) this.releaseMove(agent);
    this.roleTimer = 0;
  }

  /* -------------------------------------------------------------- contact -- */

  /** An agent reports what it knows. Best information wins. */
  report(
    position: THREE.Vector3, velocity: THREE.Vector3, confidence: number, now: number,
  ): void {
    const age = now - this.targetUpdated;
    // Fresh, more confident information replaces stale, less confident.
    if (confidence >= this.targetConfidence - age * 0.25) {
      this.targetPosition.copy(position);
      this.targetVelocity.copy(velocity);
      this.targetConfidence = confidence;
      this.targetUpdated = now;
    }
    if (!this.engaged && confidence > 0.5) {
      this.engaged = true;
      this.engagedAt = now;
    }
  }

  /** Everything the squad knows is stale — go back to searching. */
  standDown(now: number): void {
    this.engaged = false;
    this.targetConfidence = 0;
    this.moveToken = -1;
    this.tokenExpires = now;
    for (const m of this.members) {
      if (m.alive) m.perception.awareness = Math.min(m.perception.awareness, 0.55);
    }
  }

  /* ---------------------------------------------------------------- tick -- */

  update(dt: number, now: number): void {
    this.eyesOn = 0;
    this.gunsOn = 0;
    for (const m of this.members) {
      if (!m.alive) continue;
      if (m.perception.hasLOS) this.eyesOn++;
      if (m.canEngage) this.gunsOn++;
    }

    if (this.eyesOn > 0) this.timeSinceEyes = 0;
    else this.timeSinceEyes += dt;

    // Shared knowledge goes stale. Without this a squad that has lost the target
    // keeps hosing rounds at a wall forever instead of getting up and looking.
    if (this.eyesOn === 0 && this.engaged) {
      this.targetConfidence = Math.max(0, this.targetConfidence - dt * 0.055);
      if (this.targetConfidence < 0.08 && this.timeSinceEyes > 14) this.standDown(now);
    }

    if (this.moveToken >= 0 && now > this.tokenExpires) this.moveToken = -1;
    if (this.grenadesInFlight < 0) this.grenadesInFlight = 0;

    this.roleTimer -= dt;
    if (this.roleTimer <= 0) {
      this.roleTimer = 2.2;
      this.assignRoles(now);
    }
  }

  /* --------------------------------------------------------------- roles -- */

  /**
   * Sorts the squad by distance to the enemy and hands out jobs. The nearest
   * healthy man anchors, the best-equipped man suppresses, the furthest men go
   * wide. Everyone else supports.
   */
  assignRoles(now: number): void {
    const live = this.members.filter((m) => m.alive);
    if (live.length === 0) return;
    const t = this.targetPosition;
    live.sort((a, b) => a.position.distanceToSquared(t) - b.position.distanceToSquared(t));

    const wantFlankers = live.length >= 4 ? 2 : live.length >= 2 ? 1 : 0;
    const wantSuppressor = live.length >= 3 ? 1 : 0;

    // Suppressor: prefer sustained-fire weapons, then whoever has the most ammo
    // and a firing position.
    let suppressor: Agent | null = null;
    if (wantSuppressor > 0) {
      let best = -Infinity;
      for (const m of live) {
        let s = m.weapon.magSize / 30 + m.combat.ammo / Math.max(1, m.weapon.magSize);
        if (m.perception.hasLOS) s += 0.8;
        if (m.inCover) s += 0.5;
        s -= m.position.distanceTo(t) * 0.01;
        if (s > best) { best = s; suppressor = m; }
      }
    }

    const flankers: Agent[] = [];
    for (let i = live.length - 1; i >= 0 && flankers.length < wantFlankers; i--) {
      const m = live[i];
      if (m === suppressor) continue;
      if (m.health < m.maxHealth * 0.35) continue;      // wounded men do not go wide
      flankers.push(m);
    }

    for (const m of live) {
      let role: SquadRole = 'support';
      if (m === suppressor) role = 'suppressor';
      else if (flankers.indexOf(m) >= 0) role = 'flanker';
      else if (m === live[0]) role = 'anchor';
      m.setRole(role, now);
    }

    // Flankers alternate sides so a squad brackets rather than stacking.
    let side = this.flankSide;
    for (const f of flankers) {
      f.flankSide = side;
      side = -side;
    }
  }

  /* ------------------------------------------------------- move arbitration */

  /**
   * Bounding advance gate. `priority` breaks ties: retreating and flanking
   * outrank a routine reposition.
   */
  requestMove(agent: Agent, now: number, priority: number): boolean {
    if (!this.engaged) return true;                       // nobody is shooting yet
    if (this.moveToken === agent.id) {
      this.tokenExpires = now + TOKEN_MAX_HOLD;
      return true;
    }
    if (this.aliveCount <= 1) return true;
    if (this.moveToken >= 0) {
      if (priority <= this.tokenPriority + 0.5) return false;
      // Higher priority pre-empts (a retreat beats someone else's flank).
      const holder = this.byId(this.moveToken);
      holder?.onMoveTokenLost();
    }
    // Somebody has to be able to shoot while we run.
    const covering = this.gunsOn - (agent.canEngage ? 1 : 0);
    if (covering < 1 && this.aliveCount > 1 && now - this.targetUpdated < 4) return false;

    this.moveToken = agent.id;
    this.tokenExpires = now + TOKEN_MAX_HOLD;
    this.tokenPriority = priority;
    return true;
  }

  releaseMove(agent: Agent): void {
    if (this.moveToken === agent.id) {
      this.moveToken = -1;
      this.tokenPriority = 0;
    }
  }

  holdsToken(agent: Agent): boolean { return this.moveToken === agent.id; }

  byId(id: number): Agent | null {
    for (const m of this.members) if (m.id === id) return m;
    return null;
  }

  /* ------------------------------------------------------------ grenades -- */

  requestGrenade(now: number): boolean {
    if (now < this.grenadeReadyAt) return false;
    if (this.grenadesInFlight > 0) return false;
    return true;
  }

  onGrenadeThrown(now: number): void {
    this.grenadesInFlight++;
    this.grenadeReadyAt = now + 11 + this.rand.range(0, 6);
  }

  onGrenadeResolved(): void {
    this.grenadesInFlight = Math.max(0, this.grenadesInFlight - 1);
  }

  /* -------------------------------------------------------------- speech -- */

  /**
   * Squad-arbitrated voice line. Returns true when it was actually spoken, so
   * the caller can gate an animation on it.
   */
  say(agent: Agent, line: VoiceLine, now: number, cooldown = 6, priority = 0): boolean {
    if (now < this.speechFreeAt && priority < 2) return false;
    const last = this.lineCooldown.get(line) ?? -1e9;
    if (now - last < cooldown) return false;
    this.lineCooldown.set(line, now);
    this.speechFreeAt = now + SPEECH_GAP + line.length * 0.022;
    bus.emit('ai:voice', { id: agent.id, line });
    return true;
  }

  /** Squad-wide warning that does not respect the normal gap. */
  shout(agent: Agent, line: VoiceLine, now: number, cooldown = 3): boolean {
    return this.say(agent, line, now, cooldown, 2);
  }

  /** Called when a member dies: everyone else gets a hint and a callout. */
  onMemberDown(agent: Agent, now: number): void {
    for (const m of this.members) {
      if (!m.alive || m === agent) continue;
      if (this.targetConfidence > 0.3) {
        m.perception.share(this.targetPosition, this.targetVelocity, 0.55, now);
      } else {
        m.perception.awareness = Math.max(m.perception.awareness, 0.55);
      }
    }
    const witness = this.members.find((m) => m.alive);
    if (witness) this.shout(witness, VO.manDown, now, 8);
    this.remove(agent);
    this.assignRoles(now);
  }
}

/** Owns squad lifetimes and gives out ids. */
export class SquadManager {
  private squads = new Map<number, Squad>();
  private nextId = 1;
  constructor(private seed: number) { }

  create(): Squad {
    const s = new Squad(this.nextId++, this.seed);
    this.squads.set(s.id, s);
    return s;
  }

  get(id: number): Squad | undefined { return this.squads.get(id); }
  all(): IterableIterator<Squad> { return this.squads.values(); }

  update(dt: number, now: number): void {
    for (const s of this.squads.values()) s.update(dt, now);
  }

  clear(): void { this.squads.clear(); this.nextId = 1; }
}
