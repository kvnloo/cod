/**
 * Utility-scored behaviour selection.
 *
 * A finite state machine encodes *transitions*, and every new behaviour you add
 * multiplies the transitions you have to hand-author until the thing is
 * unmaintainable and full of dead ends. A utility system encodes *desirability*:
 * each behaviour answers "how badly do I want to run right now" from the current
 * world state, the highest bidder wins, and adding a twelfth behaviour costs one
 * scoring function.
 *
 * The two things that stop a utility system from twitching are here as well:
 *
 *  - **Commitment.** The running action gets a bonus that decays with its
 *    minimum duration, so nothing flip-flops between two near-equal scores.
 *  - **Cooldowns.** Expensive or loud actions (grenades, flanks) cannot restart
 *    the moment they finish.
 */

import * as THREE from 'three';
import { clamp01, falloff, smoothstep } from './Util';
import { VO } from './types';
import type { Agent } from './Agent';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

export interface Action {
  readonly name: string;
  /** Desirability, roughly 0..10. Negative means "never". */
  score(a: Agent): number;
  enter?(a: Agent): void;
  tick(a: Agent, dt: number): void;
  exit?(a: Agent): void;
  /** Seconds the action is protected from being interrupted. */
  minTime: number;
  /** Seconds after which it stops bidding so something else gets a turn. */
  maxTime: number;
  /** Seconds before it may be selected again after finishing. */
  cooldown: number;
}

/* ------------------------------------------------------------------- idle -- */

const idle: Action = {
  name: 'idle',
  minTime: 0.5, maxTime: 999, cooldown: 0,
  score(a) {
    // A genuine floor: whatever else vetoes, there is always something to do.
    if (a.perception.state === 'combat') return 0.05;
    return a.patrol.length >= 2 ? 0.35 : 0.5;
  },
  enter(a) {
    a.setStance('stand');
    a.setFireMode('hold');
    a.scanTimer = 0;
  },
  tick(a, dt) {
    a.setFireMode('hold');
    if (a.patrol.length >= 2) {
      const wp = a.patrol[a.patrolIndex % a.patrol.length];
      a.moveTo(wp, 'walk');
      if (a.position.distanceTo(wp) < 1.6) {
        a.patrolIndex = (a.patrolIndex + 1) % a.patrol.length;
        a.patrolPause = 1.2 + a.rand.next() * 2.4;
      }
      if (a.patrolPause > 0) {
        a.patrolPause -= dt;
        a.stopMoving();
      }
    } else {
      a.stopMoving();
    }
    // Idle scanning: sweep the head across the approach.
    a.scanTimer += dt;
    const sweep = Math.sin(a.scanTimer * 0.55) * 0.9;
    _v0.copy(a.position);
    _v0.x += Math.sin(a.spawnYaw + sweep) * 8;
    _v0.z += Math.cos(a.spawnYaw + sweep) * 8;
    _v0.y += 0.4;
    a.aimAt(_v0);
  },
};

/* ------------------------------------------------------------ investigate -- */

const investigate: Action = {
  name: 'investigate',
  minTime: 1.5, maxTime: 26, cooldown: 1.5,
  score(a) {
    const p = a.perception;
    if (p.state === 'combat') return -1;
    if (p.state === 'idle' && !p.hasInterest) return -1;
    // Curiosity scales with the meter and with how recent the stimulus was.
    const recency = falloff(p.timeSinceStimulus, 2, 26);
    return 0.9 + p.awareness * 2.6 + recency * 0.9;
  },
  enter(a) {
    a.setStance('stand');
    a.setFireMode('hold');
    a.searchIndex = 0;
    a.pickSearchPoint();
    if (a.perception.awareness > 0.5) a.say(VO.searching, 12);
  },
  tick(a, dt) {
    a.setFireMode('hold');
    const p = a.perception;
    const goal = a.searchPoint;
    a.moveTo(goal, p.awareness > 0.55 ? 'combat' : 'walk');
    a.aimAt(_v0.copy(goal).setY(goal.y + 1.2));

    if (a.position.distanceTo(goal) < 1.5 || a.pathFailed) {
      a.searchDwell -= dt;
      a.stopMoving();
      // Look around before moving on — reads as searching, not pathing.
      a.scanTimer += dt;
      _v1.copy(a.position);
      const sweep = Math.sin(a.scanTimer * 1.1) * 1.3;
      _v1.x += Math.sin(a.bodyYaw + sweep) * 6;
      _v1.z += Math.cos(a.bodyYaw + sweep) * 6;
      _v1.y += 1.3;
      a.aimAt(_v1);
      if (a.searchDwell <= 0) a.pickSearchPoint();
    }
  },
  exit(a) { a.stopMoving(); },
};

/* -------------------------------------------------------------- takeCover -- */

const takeCover: Action = {
  name: 'takeCover',
  minTime: 0.7, maxTime: 14, cooldown: 0.4,
  score(a) {
    if (!a.hasContact) return -1;
    let s = 1.4;
    // Standing in the open while someone shoots at you is the worst thing you
    // can do, and the score says so.
    if (!a.inCover) s += 3.2;
    if (a.exposedToTarget) s += 1.6;
    s += a.combat.suppression * 2.4;
    s += (1 - a.healthFraction) * 1.8;
    if (a.combat.needsReload) s += 1.4;
    if (a.currentCover && !a.coverCompromised) s -= 3.6;   // already sorted
    s -= a.profile.aggression * 0.9;
    return s;
  },
  enter(a) {
    a.chooseCover(0, 0);
    a.say(VO.contact, 9);
  },
  tick(a, dt) {
    const c = a.currentCover;
    if (!c) {
      // Nothing to hide behind: back off from the threat rather than stand.
      a.retreatStep();
      a.setFireMode('aimed');
      a.aimAtTarget();
      if (a.coverSearchTimer <= 0) { a.chooseCover(0, 0); a.coverSearchTimer = 1.1; }
      a.coverSearchTimer -= dt;
      return;
    }
    a.moveTo(c.position, 'combat');
    a.aimAtTarget();
    const arrived = a.position.distanceTo(c.position) < 0.7;
    if (arrived) {
      a.stopMoving();
      a.setStance(c.height === 'low' ? 'crouch' : 'stand');
      a.runCoverCombat(dt);
    } else {
      // Moving to cover: fire only if we are already exposed anyway.
      a.setFireMode(a.exposedToTarget && a.canEngage ? 'aimed' : 'hold');
    }
  },
};

/* -------------------------------------------------------------- holdCover -- */

/**
 * Fight from the cover we already hold: peek, fire a burst, drop back.
 *
 * This is the default combat behaviour and the one the player spends most of
 * the fight looking at. It exists as its own action so that `takeCover` can mean
 * strictly "get to cover" and score itself out of the running once we are there.
 */
const holdCover: Action = {
  name: 'holdCover',
  minTime: 1.0, maxTime: 999, cooldown: 0,
  score(a) {
    if (!a.hasContact) return -1;
    if (!a.currentCover) return -1;
    if (a.coverCompromised) return -1;
    let s = 1.5;
    if (a.inCover) s += 0.7;
    if (a.perception.hasLOS) s += 0.5;
    s -= a.combat.suppression * 0.5;
    return s;
  },
  enter(a) {
    a.setStance(a.currentCover?.height === 'low' ? 'crouch' : 'stand');
  },
  tick(a, dt) {
    const c = a.currentCover;
    if (!c) { a.finishAction(); return; }
    a.moveTo(c.position, 'combat');
    if (a.position.distanceTo(c.position) < 0.75) {
      a.stopMoving();
      a.runCoverCombat(dt);
    } else {
      a.aimAtTarget();
      a.setFireMode(a.exposedToTarget && a.canEngage ? 'aimed' : 'hold');
    }
  },
};

/* ---------------------------------------------------------------- advance -- */

const advance: Action = {
  name: 'advance',
  minTime: 1.6, maxTime: 9, cooldown: 3.2,
  score(a) {
    if (!a.hasContact) return -1;
    if (a.healthFraction < 0.45) return -1;
    if (a.combat.needsReload) return -1;
    const d = a.distanceToTarget;
    // Assault range, not effective range: infantry close to somewhere they can
    // actually finish the fight. Sitting at the edge of the weapon's envelope
    // trading rounds is what makes AI feel passive.
    const assault = Math.min(a.weapon.rangeIdeal * 0.55, 16);
    const wantCloser = smoothstep(assault * 0.7, assault * 2.4, d);
    let s = 0.6 + wantCloser * 2.8 + a.profile.aggression * 1.7;
    s *= 0.4 + a.healthFraction * 0.6;
    s -= a.combat.suppression * 2.8;
    if (a.role === 'anchor') s += 0.5;
    if (a.role === 'suppressor') s -= 1.4;
    if (a.squad && a.squad.gunsOn < 1) s -= 1.1;          // nobody covering us
    if (a.timeSinceCombatStart < 2.5) s -= 1.5;           // let the opening beat land
    // Stalemate breaker: if nobody in the squad can see him, somebody has to go
    // and find out where he is.
    if (a.squad) s += smoothstep(3, 9, a.squad.timeSinceEyes) * 2.6;
    return s;
  },
  enter(a) {
    if (!a.requestMove(1)) { a.actionVetoed = true; return; }
    a.chooseCover(1, 0);
    a.say(VO.pushing, 11);
  },
  tick(a, dt) {
    void dt;
    const c = a.currentCover;
    const goal = c ? c.position : a.perception.lastKnown;
    a.moveTo(goal, a.distanceToTarget > 22 ? 'sprint' : 'combat');
    a.aimAtTarget();
    a.setStance('stand');
    // Advancing fire: shoot on the move, badly, which is realistic and readable.
    a.setFireMode(a.canEngage ? 'aimed' : 'hold');
    if (c && a.position.distanceTo(c.position) < 0.8) a.finishAction();
  },
  exit(a) { a.releaseMove(); },
};

/* ------------------------------------------------------------------ flank -- */

const flank: Action = {
  name: 'flank',
  minTime: 2.5, maxTime: 16, cooldown: 9,
  score(a) {
    if (!a.hasContact) return -1;
    if (a.role !== 'flanker') return -1;
    if (a.healthFraction < 0.5) return -1;
    if (!a.squad || a.squad.aliveCount < 2) return -1;
    let s = 1.2 + a.profile.aggression * 1.6;
    // Flank when the frontal approach is a wall of fire, i.e. the target is
    // holding an angle on us.
    if (a.exposedToTarget) s += 0.8;
    if (a.timeSinceCombatStart > 4) s += 1.0;
    s -= a.combat.suppression * 2.0;
    if (a.squad) s += smoothstep(2, 7, a.squad.timeSinceEyes) * 2.2;
    return s;
  },
  enter(a) {
    if (!a.requestMove(2)) { a.actionVetoed = true; return; }
    a.buildFlankRoute();
    a.say(a.flankSide > 0 ? VO.flankRight : VO.flankLeft, 12);
  },
  tick(a, dt) {
    void dt;
    a.setStance('stand');
    const goal = a.flankGoal;
    a.moveTo(goal, 'sprint');
    // Look where we are going, not at the target — that is what selling a flank
    // looks like, and it gives the player a chance to notice the movement.
    if (a.canEngage && a.distanceToTarget < a.weapon.rangeIdeal * 0.8) {
      a.aimAtTarget();
      a.setFireMode('aimed');
    } else {
      a.aimAlongVelocity();
      a.setFireMode('hold');
    }
    if (a.position.distanceTo(goal) < 1.6 || a.pathFailed) {
      a.chooseCover(1, 1);
      a.finishAction();
    }
  },
  exit(a) { a.releaseMove(); },
};

/* --------------------------------------------------------------- suppress -- */

const suppress: Action = {
  name: 'suppress',
  minTime: 1.4, maxTime: 7, cooldown: 1.2,
  score(a) {
    if (!a.squad || !a.squad.engaged) return -1;
    if (a.combat.ammo <= 2) return -1;
    if (a.perception.confidence < 0.25) return -1;
    let s = 0.8;
    if (a.role === 'suppressor') s += 2.2;
    // Suppressing is what you do when you cannot see him but know where he is.
    if (!a.perception.hasLOS && a.perception.timeSinceSeen < 6) s += 1.5;
    if (a.squad.moveToken >= 0 && a.squad.moveToken !== a.id) s += 2.0;
    // Volume of fire is only worth it from behind something. Standing in the
    // open hosing rounds is the single worst thing an AI can do on camera.
    if (a.inCover) s += 0.6; else s -= 1.9;
    if (a.combat.ammo < a.weapon.magSize * 0.3) s -= 1.5;
    // Suppressing a position nobody has seen for ten seconds is just noise.
    s -= smoothstep(4, 11, a.squad.timeSinceEyes) * 3.0;
    return s;
  },
  enter(a) {
    a.say(VO.suppressing, 8);
    a.setStance(a.currentCover?.height === 'low' ? 'crouch' : 'stand');
  },
  tick(a, dt) {
    void dt;
    a.setFireMode('suppress');
    // Walk the fire onto the last known position, not onto the man.
    a.aimAtSuppressionPoint();
    if (a.currentCover) {
      a.moveTo(a.currentCover.position, 'combat');
      if (a.position.distanceTo(a.currentCover.position) < 0.7) {
        a.stopMoving();
        a.setStance(a.currentCover.height === 'low' ? 'crouch' : 'stand');
      }
    } else {
      // Caught in the open: keep the rounds going out but find somewhere to be.
      a.stopMoving();
      a.setStance('crouch');
      if (a.coverSearchTimer <= 0) { a.chooseCover(0, 0); a.coverSearchTimer = 1.4; }
    }
  },
};

/* ------------------------------------------------------------ reposition -- */

const reposition: Action = {
  name: 'reposition',
  minTime: 1.2, maxTime: 8, cooldown: 4.5,
  score(a) {
    if (!a.hasContact) return -1;
    let s = -0.5;
    // The core anti-camping rule: staying in one place is a decaying asset.
    if (a.coverCompromised) s += 3.0;
    if (a.combat.suppression > 0.55) s += 2.4;
    s += smoothstep(6, 16, a.timeInSameSpot) * 2.0;
    if (a.combat.needsReload) s -= 1.0;
    if (a.squad && a.squad.moveToken >= 0 && a.squad.moveToken !== a.id) s -= 1.4;
    return s;
  },
  enter(a) {
    if (!a.requestMove(1.2)) { a.actionVetoed = true; return; }
    a.chooseCover(a.profile.aggression > 0.6 ? 0.5 : -0.3, 0.5);
    a.say(VO.moving, 7);
  },
  tick(a, dt) {
    void dt;
    const c = a.currentCover;
    if (!c) { a.finishAction(); return; }
    a.moveTo(c.position, 'combat');
    a.setStance('stand');
    a.setFireMode('hold');
    a.aimAlongVelocity();
    if (a.position.distanceTo(c.position) < 0.7) {
      a.stopMoving();
      a.finishAction();
    }
  },
  exit(a) { a.releaseMove(); },
};

/* --------------------------------------------------------- reloadInCover -- */

const reloadInCover: Action = {
  name: 'reloadInCover',
  minTime: 0.6, maxTime: 6, cooldown: 0.5,
  score(a) {
    if (a.combat.reloading) return 6.5;                   // finish what we started
    if (!a.combat.lowAmmo) return -1;
    if (a.combat.reserve <= 0) return -1;
    let s = a.combat.needsReload ? 4.5 : 1.2;
    if (a.inCover && !a.exposedToTarget) s += 1.8;
    if (!a.hasContact) s += 1.0;
    return s;
  },
  enter(a) {
    if (a.combat.startReload(a.now)) {
      a.say(VO.reloading, 5);
      a.character?.play('reload');
    }
  },
  tick(a, dt) {
    void dt;
    a.setFireMode('hold');
    a.setPeek(0);
    const c = a.currentCover;
    if (c) {
      a.moveTo(c.position, 'combat');
      if (a.position.distanceTo(c.position) < 0.7) {
        a.stopMoving();
        a.setStance(c.height === 'low' ? 'crouch' : 'stand');
      }
    } else {
      a.stopMoving();
      a.setStance('crouch');
    }
    a.aimAtTarget();
    if (!a.combat.reloading) a.finishAction();
  },
  exit(a) { a.setStance('stand'); },
};

/* -------------------------------------------------------------- grenade  -- */

const grenade: Action = {
  name: 'grenade',
  minTime: 1.0, maxTime: 3.0, cooldown: 16,
  score(a) {
    if (!a.hasContact) return -1;
    if (!a.canThrowGrenade()) return -1;
    const d = a.distanceToTarget;
    if (d < 8 || d > 30) return -1;
    // Grenades are for a player who has stopped moving behind something.
    const stationary = 1 - clamp01(a.perception.lastKnownVelocity.length() / 3.5);
    const hidden = a.perception.hasLOS ? 0.25 : 1.0;
    let s = 1.0 + stationary * 1.6 + hidden * 1.4 + a.profile.grenadeChance * 2.2;
    if (a.perception.timeSinceSeen > 7) s -= 2.0;
    return s;
  },
  enter(a) {
    a.grenadeTimer = 0;
    a.say(VO.fragOut, 14);
    a.character?.play('throw');
  },
  tick(a, dt) {
    a.grenadeTimer += dt;
    a.stopMoving();
    a.setFireMode('hold');
    a.aimAtGrenadeArc();
    if (!a.grenadeReleased && a.grenadeTimer > 0.55) {
      a.releaseGrenade();
    }
    if (a.grenadeTimer > 1.1) a.finishAction();
  },
  exit(a) { a.grenadeReleased = false; },
};

/* --------------------------------------------------------------- retreat -- */

const retreat: Action = {
  name: 'retreat',
  minTime: 1.5, maxTime: 10, cooldown: 8,
  score(a) {
    if (!a.hasContact) return -1;
    let s = -1;
    if (a.healthFraction < 0.34) s += 3.4 * (1 - a.healthFraction / 0.34);
    if (a.squad && a.squad.aliveCount === 1 && a.squad.size > 2) s += 1.2;
    if (a.distanceToTarget < 6 && a.combat.needsReload) s += 1.6;
    s *= 1.35 - a.profile.nerve;
    return s;
  },
  enter(a) {
    a.requestMove(3);
    a.chooseCover(-1, 0);
    a.say(VO.fallingBack, 10);
  },
  tick(a, dt) {
    void dt;
    const c = a.currentCover;
    a.setStance('stand');
    a.setFireMode('hold');
    if (c) {
      a.moveTo(c.position, 'sprint');
      if (a.position.distanceTo(c.position) < 0.8) {
        a.stopMoving();
        a.setStance('crouch');
        a.finishAction();
      }
    } else {
      a.retreatStep();
    }
    a.aimAlongVelocity();
  },
  exit(a) { a.releaseMove(); },
};

/* ----------------------------------------------------------------- melee -- */

const melee: Action = {
  name: 'melee',
  minTime: 0.4, maxTime: 2.4, cooldown: 3,
  score(a) {
    if (!a.hasContact || !a.perception.hasLOS) return -1;
    const d = a.distanceToTarget;
    if (d > 3.0) return -1;
    // Close enough that shooting is silly, or the magazine is empty.
    let s = 2.0 + (3.0 - d) * 1.4;
    if (a.combat.needsReload) s += 2.0;
    s += a.profile.aggression;
    return s;
  },
  enter(a) {
    a.meleeTimer = 0;
    a.character?.play('fire', { speed: 1.4 });
  },
  tick(a, dt) {
    a.meleeTimer += dt;
    a.setFireMode('hold');
    a.aimAtTarget();
    a.moveTo(a.perception.lastKnown, 'sprint');
    if (a.meleeTimer > 0.35 && !a.meleeSwung) {
      a.meleeSwung = true;
      a.doMelee();
    }
    if (a.meleeTimer > 0.9) a.finishAction();
  },
  exit(a) { a.meleeSwung = false; },
};

/* ------------------------------------------------------------- selection -- */

export const ACTIONS: readonly Action[] = [
  idle, investigate, takeCover, holdCover, advance, flank, suppress,
  reposition, reloadInCover, grenade, retreat, melee,
];

export const ACTION_INDEX = new Map<string, number>(ACTIONS.map((a, i) => [a.name, i]));

/**
 * Picks the highest-scoring action, respecting commitment and cooldowns.
 * Returns the same action the agent is already running when nothing beats it.
 */
/** Scores at or below this are hard vetoes: not even commitment overrides them. */
export const VETO = -0.25;

export function selectAction(
  a: Agent, current: Action | null, timeInAction: number, cooldowns: Float32Array, now: number,
  scoresOut?: Float32Array,
): Action {
  let best: Action = idle;
  let bestScore = -Infinity;

  for (let i = 0; i < ACTIONS.length; i++) {
    const action = ACTIONS[i];
    let s = action.score(a);
    // A veto is absolute. Without this the commitment bonus keeps an agent
    // running a behaviour whose own preconditions have gone false — retreating
    // at full health, investigating something he is currently shooting at.
    if (s <= VETO) {
      if (scoresOut) scoresOut[i] = -99;
      continue;
    }
    if (action !== current && cooldowns[i] > now) s = -Infinity;
    if (action === current) {
      // Commitment bonus: full inside the minimum time, fading after.
      if (timeInAction < action.minTime) s += 6;
      else if (timeInAction < action.maxTime) s += 0.85;
      else s -= 1.5;
    }
    if (scoresOut) scoresOut[i] = s === -Infinity ? -99 : s;
    if (s > bestScore) { bestScore = s; best = action; }
  }
  return best;
}
