/**
 * One enemy.
 *
 * An agent owns: a physics capsule it drives with the shared character
 * controller, a perception model, a fire-control model, a path and the local
 * steering that follows it, a cover slot, and a `Character` for presentation.
 * Everything above it (which behaviour, which cover, who moves next) is decided
 * by the utility system and the squad blackboard.
 *
 * Ordering inside `fixedUpdate` matters and is deliberate:
 *   perceive → share with the squad → choose a behaviour → run it →
 *   steer and move → shoot → bookkeeping
 * Choosing before moving means the behaviour always acts on this tick's world
 * state; shooting after moving means the muzzle position used for the trace is
 * the one the player will see on screen.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type {
  CharacterController, CharacterMoveResult, HitZone, PhysicsAPI, RayHit,
} from '../physics/types';
import { LAYER, MASK_MOVE, MASK_SIGHT } from '../physics/types';
import type { Character, CharacterLoadout } from '../characters/types';
import { Perception, type LightProbe } from './Perception';
import { CombatController, makeShotResult, type ShotResult } from './Combat';
import { CoverSystem, PEEK_OFFSET, type CoverPoint } from './Cover';
import { NavService } from './Nav';
import type { Squad } from './Squad';
import { ACTIONS, selectAction, type Action } from './Behaviour';
import {
  AI_WEAPONS, ALERT_LEVEL, DIFFICULTY, VO,
  type AIWeaponSpec, type AgentSpawnOptions, type Difficulty, type DifficultyProfile,
  type SquadRole, type Stance, type TargetLike, type VoiceLine,
} from './types';
import { angleDelta, clamp01, damp, makeHit, rotateY, turnToward } from './Util';
import type { GrenadeSystem } from './Grenades';
import { livingHitboxLayout } from '../characters/Hitboxes';

/* ------------------------------------------------------------------ tuning */

export const AGENT = {
  radius: 0.36,
  standHeight: 1.80,
  crouchHeight: 1.28,
  eyeDrop: 0.16,
  /** Metres per second by movement mode. */
  speedWalk: 2.05,
  speedCombat: 3.55,
  speedSprint: 5.35,
  speedCrouch: 1.45,
  accel: 16,
  decel: 22,
  /** Radians per second the body may turn. */
  turnRate: 7.5,
  turnRateSprint: 4.2,
  gravity: -22,
  /** Distance at which a waypoint counts as reached. */
  waypointRadius: 0.72,
  /** Seconds a path is trusted before a refresh. */
  pathLifetime: 1.4,
  /** Neighbour radius for avoidance. */
  avoidRadius: 3.4,
  health: 100,
} as const;

/**
 * How long a man will keep his head up when he is the squad's only gun. Long
 * enough that the player never gets a free lull, short enough that holding the
 * angle stays a decision with a cost.
 */
const MAX_SOLO_EXPOSURE = 4.0;

/** Anti-repeat: never play the same death clip on two consecutive AI kills. */
let lastDeathClip: 'deathFront' | 'deathBack' | 'deathHead' | null = null;

/**
 * Directional death clip from shot direction relative to body yaw, with
 * headshots forced to deathHead and consecutive repeats broken.
 * Ported from `BotFallback.pickDeathClip` so shipping AI matches the fallback.
 */
function pickDeathClip(
  yaw: number,
  direction: THREE.Vector3 | undefined,
  headshot: boolean,
): 'deathFront' | 'deathBack' | 'deathHead' {
  let pick: 'deathFront' | 'deathBack' | 'deathHead';
  if (headshot) {
    pick = 'deathHead';
  } else if (direction && direction.lengthSq() > 1e-8) {
    // Bullet direction aligned with facing → struck from behind.
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const dx = direction.x;
    const dz = direction.z;
    const len = Math.hypot(dx, dz) || 1;
    pick = (dx / len) * fx + (dz / len) * fz > 0.15 ? 'deathBack' : 'deathFront';
  } else {
    pick = 'deathFront';
  }
  if (pick === lastDeathClip) {
    if (pick === 'deathHead') pick = 'deathFront';
    else if (pick === 'deathFront') pick = 'deathBack';
    else pick = 'deathFront';
  }
  lastDeathClip = pick;
  return pick;
}


export type MoveMode = 'walk' | 'combat' | 'sprint' | 'crouch';
export type FireMode = 'hold' | 'aimed' | 'suppress';

/* ------------------------------------------------------------------ scratch */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _hit: RayHit = makeHit();
const _shot: ShotResult = makeShotResult();
/** Reused neighbour list for the avoidance sampler; never escapes `avoid`. */
const _neighbours: Agent[] = [];

/** What the agent needs from the owning system. */
export interface AgentHost {
  readonly physics: PhysicsAPI | null;
  readonly nav: NavService;
  readonly cover: CoverSystem;
  readonly grenades: GrenadeSystem;
  readonly lightProbe: LightProbe | null;
  readonly agents: Agent[];
  readonly now: number;
  target: TargetLike | null;
  difficulty: Difficulty;
  /** Returns true when this agent may run an A* this tick. */
  takePathBudget(): boolean;
  /** Visibility sample count for the current quality preset. */
  readonly sightSamples: number;
  readonly debugGizmos: boolean;
  /**
   * Whether this module is the authority that publishes `entity:death` for its
   * own agents. Turn it off if ballistics ends up owning that event instead;
   * double-firing it would double-count kills in the HUD and the score.
   */
  readonly emitDeath: boolean;
}

export class Agent {
  readonly id: number;
  readonly entityId: number;
  readonly rand: Rand;
  readonly host: AgentHost;

  name: string;
  faction: 'militia' | 'pmc' | 'spetsnaz';
  loadout: CharacterLoadout;
  difficulty: Difficulty;
  profile: DifficultyProfile;
  weapon: AIWeaponSpec;

  readonly perception = new Perception();
  readonly combat: CombatController;
  squad: Squad | null = null;
  role: SquadRole = 'support';
  flankSide = 1;

  character: Character | null = null;

  /* --------------------------------------------------------------- state -- */
  alive = true;
  health: number = AGENT.health;
  maxHealth: number = AGENT.health;
  /**
   * Weapons-free. The match layer holds this low through warmup, intermission
   * and the post-match beat, exactly like `ActorAPI.setCombatEnabled` promises.
   * Everything else — perception, movement, callouts — keeps running, so the
   * level does not look like a freeze-frame.
   */
  combatEnabled = true;
  /** Staging helper: holds the agent exactly where it was placed. */
  frozen = false;
  /**
   * Clip-then-ragdoll handoff. Real Characters finish via Animator.onDeathComplete
   * → CharacterSystem.onDeath; Proxy / missed handoffs fall through this timer
   * so a corpse still becomes a ragdoll without snapping on the kill frame.
   */
  private deathRagdollPending = false;
  private deathRagdollTimer = 0;
  private readonly deathImpulse = new THREE.Vector3();
  private deathZone: HitZone = 'chest';
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly eye = new THREE.Vector3();
  readonly muzzle = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  bodyYaw = 0;
  spawnYaw = 0;
  height: number = AGENT.standHeight;
  stance: Stance = 'stand';
  grounded = true;
  private verticalVelocity = 0;

  /* -------------------------------------------------------------- aiming -- */
  readonly aimPoint = new THREE.Vector3();
  private readonly aimSmoothed = new THREE.Vector3();
  aimYaw = 0;
  aimPitch = 0;
  fireMode: FireMode = 'hold';

  /* --------------------------------------------------------- path/steer --- */
  readonly path: THREE.Vector3[] = [];
  pathCount = 0;
  pathIndex = 0;
  private readonly pathGoal = new THREE.Vector3();
  private pathAge = 1e9;
  private pathPending = false;
  pathFailed = false;
  private moveMode: MoveMode = 'walk';
  private wantsMove = false;
  private readonly steerTarget = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly steerVelocity = new THREE.Vector3();
  private controller: CharacterController | null = null;
  private moveResult: CharacterMoveResult | null = null;
  private blockedTime = 0;
  private stuckTimer = 0;
  private stuckRetries = 0;
  private lastGoalDist = Infinity;
  private whiskerTimer = 0;
  private whiskerLeft = 0;
  private whiskerRight = 0;

  /* --------------------------------------------------------------- vault -- */
  private vaulting = false;
  private vaultT = 0;
  private vaultDuration = 0.55;
  private readonly vaultFrom = new THREE.Vector3();
  private readonly vaultTo = new THREE.Vector3();

  /* --------------------------------------------------------------- cover -- */
  currentCover: CoverPoint | null = null;
  coverSearchTimer = 0;
  private peekSide: -1 | 0 | 1 = 0;
  private peekBlend = 0;
  private peekTarget = 0;
  private peekPhase: 'hidden' | 'out' = 'hidden';
  private peekTimer = 0;
  /** Seconds this agent has been leaning out of cover on the current peek. */
  private exposureTimer = 0;
  private coverEvalTimer = 0;
  coverCompromised = false;
  exposedToTarget = false;
  private readonly lastSpot = new THREE.Vector3();
  timeInSameSpot = 0;

  /* ------------------------------------------------------------ behaviour -- */
  action: Action | null = null;
  timeInAction = 0;
  actionVetoed = false;
  private cooldowns = new Float32Array(ACTIONS.length);
  readonly debugScores = new Float32Array(ACTIONS.length);
  private thinkTimer = 0;
  private perceptionTimer = 0;
  private perceptionAccum = 0;

  /* ------------------------------------------------------ behaviour state -- */
  patrol: THREE.Vector3[] = [];
  patrolIndex = 0;
  patrolPause = 0;
  scanTimer = 0;
  readonly searchPoint = new THREE.Vector3();
  searchIndex = 0;
  searchDwell = 0;
  readonly flankGoal = new THREE.Vector3();
  grenadeTimer = 0;
  grenadeReleased = false;
  private grenadeReadyAt = 0;
  private grenadeSolveAt = -1e9;
  private grenadeSolutionOk = false;
  private readonly grenadeVelocity = new THREE.Vector3();
  private readonly grenadeOrigin = new THREE.Vector3();
  meleeTimer = 0;
  meleeSwung = false;
  private timeCombatStarted = -1e9;
  private suppressSweep = 0;

  constructor(id: number, host: AgentHost, opts: AgentSpawnOptions) {
    this.id = id;
    this.entityId = 1000 + id;
    this.host = host;
    this.rand = new Rand((opts.seed ?? 0x51ed) ^ (id * 0x9e3779b9));
    this.name = opts.name ?? `enemy_${id}`;
    this.faction = opts.faction ?? 'militia';
    this.loadout = opts.loadout ?? 'rifleman';
    this.difficulty = opts.difficulty ?? host.difficulty;
    this.profile = DIFFICULTY[this.difficulty];
    this.weapon = AI_WEAPONS[this.loadout];
    this.combat = new CombatController(this.weapon, this.profile, this.rand);
    this.maxHealth = opts.health ?? AGENT.health;
    this.health = this.maxHealth;

    this.position.copy(opts.position);
    this.position.y += AGENT.standHeight * 0.5;
    this.lastSpot.copy(this.position);
    this.bodyYaw = opts.yaw ?? 0;
    this.spawnYaw = this.bodyYaw;
    this.aimYaw = this.bodyYaw;
    this.updateBasis();
    this.aimPoint.copy(this.eye).addScaledVector(this.forward, 8);
    this.aimSmoothed.copy(this.aimPoint);

    if (opts.patrol) this.patrol = opts.patrol.map((p) => p.clone());
    if (opts.role) this.role = opts.role;
    if (opts.alerted) this.perception.awareness = 1;

    // Sniper and LMG carriers hold more reserve; SMG less.
    this.combat.reserve = this.weapon.magSize * (this.loadout === 'lmg' ? 3 : 6);

    for (let i = 0; i < 24; i++) this.path.push(new THREE.Vector3());
    this.searchPoint.copy(this.position);
    // No grenades in the opening seconds, and never all at once.
    this.grenadeReadyAt = 5 + this.rand.next() * 7;
  }

  /* --------------------------------------------------------------- setup -- */

  attachPhysics(physics: PhysicsAPI): void {
    this.controller = physics.createCharacter(AGENT.radius, AGENT.standHeight, LAYER.ENEMY);
    this.moveResult = makeMoveResultLocal();
    const c = this.controller;
    c.teleport?.(this.position);
    // Tag + multi-zone hitboxes so player bullets resolve entity/zone/surface.
    c.setEntity?.(this.entityId, this.character?.object ?? null);
    c.setHitboxes?.(livingHitboxLayout(this.height, AGENT.radius));
  }

  attachCharacter(character: Character): void {
    this.character = character;
    const c = this.controller;
    c?.setEntity?.(this.entityId, character.object);
    // Combat hitboxes must stay on the capsule-local living layout (same as
    // attachPhysics). Bone-local character.hitboxes are rest-pose volumes; at
    // attach time matrixWorld is not yet combat-posed, so projecting them into
    // the proxy swallowed bullets (playtest damage-model/hitbox-zones → 0).
    // When the character authors a hitbox set we still re-install the living
    // layout sized to this agent — never leave the prior entity's volumes.
    if (c?.setHitboxes && character.hitboxes && character.hitboxes.length >= 3) {
      c.setHitboxes(livingHitboxLayout(this.height, AGENT.radius));
    } else if (c?.setHitboxes) {
      c.setHitboxes(livingHitboxLayout(this.height, AGENT.radius));
    }
    this.ensureWeaponProp(character);
    this.syncPresentation(0);
  }

  /**
   * Live agents used to leave `weaponSocket` empty — hands gripped air. The
   * debug scene already parents a prop there; the match path must do the same.
   */
  private ensureWeaponProp(character: Character): void {
    // Character contract is the interface; the concrete class exposes the socket.
    const sock = (character as Character & { weaponSocket?: THREE.Object3D }).weaponSocket;
    if (!sock || sock.children.length > 0) return;
    // Lightweight grip-space prop (+Z bore) so hands are not empty mid-match.
    // Matches Animator carry frame without pulling CharacterMaterials into AI.
    const g = new THREE.Group();
    g.name = `ai-weapon:${this.loadout}`;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.08, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.55, metalness: 0.45 }),
    );
    body.position.set(0, 0.02, 0.12);
    const stock = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.07, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.7, metalness: 0.2 }),
    );
    stock.position.set(0, 0.0, -0.12);
    g.add(body, stock);
    sock.add(g);
  }

  setRole(role: SquadRole, now: number): void {
    if (this.role === role) return;
    this.role = role;
    void now;
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty = d;
    this.profile = DIFFICULTY[d];
    this.combat.setProfile(this.profile);
  }

  /**
   * The director's per-spawn aggression scalar.
   *
   * `DIFFICULTY[...]` hands out a *shared* object; writing to it would retune
   * every agent in the level, so the first override forks a private copy.
   */
  setAggression(aggression: number): void {
    if (!Number.isFinite(aggression)) return;
    if (this.profile === DIFFICULTY[this.difficulty]) this.profile = { ...this.profile };
    this.profile.aggression = clamp01(aggression);
    this.combat.setProfile(this.profile);
  }

  /* ------------------------------------------------------------ accessors -- */

  get now(): number { return this.host.now; }
  get target(): TargetLike | null { return this.host.target; }
  get healthFraction(): number { return clamp01(this.health / this.maxHealth); }
  get hasContact(): boolean { return this.perception.state === 'combat'; }
  get inCover(): boolean {
    return this.currentCover !== null
      && this.position.distanceToSquared(this.currentCover.position) < 1.4;
  }
  get canEngage(): boolean {
    return this.alive && this.perception.hasLOS && this.combat.ready
      && !this.combat.reloading && this.combat.ammo > 0;
  }
  get distanceToTarget(): number {
    const t = this.target;
    return t ? this.position.distanceTo(t.position) : Infinity;
  }
  get timeSinceCombatStart(): number { return this.now - this.timeCombatStarted; }
  get actionName(): string { return this.action?.name ?? 'none'; }

  /* ---------------------------------------------------------------- tick -- */

  fixedUpdate(dt: number): void {
    if (!this.alive) return;
    if (this.frozen) { this.updateBasis(); return; }
    const now = this.now;

    this.updateBasis();
    this.timeInAction += dt;
    this.coverEvalTimer -= dt;
    this.coverSearchTimer -= dt;
    this.pathAge += dt;

    /* --- perceive (staggered; cpuLod drops Hz under budget pressure) --- */
    this.perceptionTimer -= dt;
    this.perceptionAccum += dt;
    if (this.perceptionTimer <= 0) {
      // 15 → 10 → 7 → 5 Hz as free ladder raises cpuLod (wave-2 CPU body).
      const lod = settings.gfx.cpuLod | 0;
      const percHz = lod >= 3 ? 5 : lod >= 2 ? 7 : lod >= 1 ? 10 : 15;
      this.perceptionTimer = 1 / percHz;
      const wasCombat = this.perception.state === 'combat';
      this.perception.tick(
        this.perceptionAccum, now, this.eye, this.forward, this.target,
        this.host.physics, this.host.lightProbe ?? null, this.profile,
        this.host.sightSamples, this.entityId,
      );
      this.perceptionAccum = 0;
      this.onPerception(wasCombat, now);
    }

    /* --- decide (staggered; cpuLod coarsens think rate) ----------------- */
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0 || this.action === null) {
      const lod = settings.gfx.cpuLod | 0;
      const thinkHz = lod >= 3 ? 3 : lod >= 2 ? 4 : lod >= 1 ? 5 : 6;
      this.thinkTimer = 1 / thinkHz;
      this.think(now);
    }

    /* --- act ------------------------------------------------------------ */
    // Movement is opt-in every tick: an action that stops asking to move stops
    // moving, which removes a whole class of "why is he still walking" bugs.
    this.wantsMove = false;
    this.action?.tick(this, dt);
    if (this.actionVetoed) {
      // The squad refused this move; drop back to something safe immediately.
      this.actionVetoed = false;
      this.cooldowns[ACTIONS.indexOf(this.action!)] = now + 1.2;
      this.think(now, true);
    }

    /* --- move ----------------------------------------------------------- */
    this.updateCoverState(dt);
    this.steer(dt);

    /* --- shoot ---------------------------------------------------------- */
    this.updateAim(dt);
    this.combat.update(dt, now, this.perception.hasLOS);
    this.updateFiring(dt);

    /* --- bookkeeping ---------------------------------------------------- */
    if (this.position.distanceToSquared(this.lastSpot) > 4) {
      this.lastSpot.copy(this.position);
      this.timeInSameSpot = 0;
    } else {
      this.timeInSameSpot += dt;
    }
  }

  /** Presentation-rate update: drives the character rig. */
  update(dt: number): void {
    if (this.deathRagdollPending) {
      this.deathRagdollTimer -= dt;
      if (this.deathRagdollTimer <= 0) {
        this.deathRagdollPending = false;
        const ch = this.character;
        if (ch && !ch.isRagdoll) {
          try { ch.ragdoll(this.deathImpulse, this.deathZone); }
          catch { /* no physics ragdoll available — hold death pose */ }
        }
      }
    }
    this.syncPresentation(dt);
    this.character?.update(dt);
  }

  /* ---------------------------------------------------------- perception -- */

  private onPerception(wasCombat: boolean, now: number): void {
    const p = this.perception;
    if (p.justAlerted) {
      this.timeCombatStarted = now;
      this.combat.beginEngagement(now, !wasCombat);
      this.say(VO.contact, 7);
      bus.emit('ai:alert', { id: this.id, level: ALERT_LEVEL.combat });
    } else if (p.justLost) {
      this.combat.endEngagement();
      this.say(VO.lostHim, 9);
      bus.emit('ai:alert', { id: this.id, level: ALERT_LEVEL.searching });
    }
    if (p.hasLOS && this.squad) {
      this.squad.report(p.lastKnown, p.lastKnownVelocity, p.confidence, now);
    } else if (this.squad && this.squad.targetConfidence > p.confidence + 0.15
      && now - this.squad.targetUpdated < 5) {
      // Take the squad's word for it — this is what makes a squad converge.
      // A confident squadmate escalates us all the way to weapons-hot; a vague
      // one only makes us suspicious.
      const escalate = this.squad.targetConfidence > 0.7 && this.squad.engaged
        && now - this.squad.engagedAt > 0.8;
      p.share(this.squad.targetPosition, this.squad.targetVelocity,
        this.squad.targetConfidence, now, escalate);
      if (escalate && !wasCombat && p.state === 'combat') {
        this.timeCombatStarted = now;
        // Reacting to a callout is slower than reacting to what you can see.
        this.combat.beginEngagement(now, true);
        this.combat.reactionTimer *= 1.35;
        bus.emit('ai:alert', { id: this.id, level: ALERT_LEVEL.combat });
      }
    }
  }

  /**
   * A soft prior: "there is a fight, roughly over there."
   *
   * A reinforcement walking into a firefight is not a sleeping guard, and the
   * failure this fixes is ugly: an agent dropped in facing away from the player
   * sits permanently outside his own 130° vision cone, never fills the
   * awareness meter, and stands in a corner while you shoot his squad. That is
   * a large part of what "the enemies don't engage" feels like.
   *
   * Deliberately *not* `alertTo`: awareness goes to merely suspicious, not
   * weapons-hot. He still has to see you with his own eyes to enter combat, and
   * he still pays the full reaction time, so the opening beat stays readable.
   *
   * The authored facing is respected when it already points within 90° of the
   * threat — a designer who aimed a guard at a doorway keeps his guard.
   */
  noticeThreat(position: THREE.Vector3, awareness = 0.30): void {
    const p = this.perception;
    p.interest.copy(position);
    p.hasInterest = true;
    p.awareness = Math.max(p.awareness, clamp01(awareness));
    p.timeSinceStimulus = 0;

    _v0.copy(position).sub(this.position);
    _v0.y = 0;
    if (_v0.lengthSq() < 1e-4) return;
    const want = Math.atan2(_v0.x, _v0.z);
    if (Math.abs(angleDelta(this.bodyYaw, want)) < Math.PI * 0.5) return;
    this.bodyYaw = want;
    this.spawnYaw = want;
    this.updateBasis();
    this.aimPoint.copy(this.eye).addScaledVector(this.forward, 8);
    this.aimSmoothed.copy(this.aimPoint);
  }

  /** External alert (damage, squadmate call, scripted trigger). */
  alertTo(position: THREE.Vector3, confidence = 0.85): void {
    const wasCombat = this.perception.state === 'combat';
    this.perception.forceAlert(position, confidence);
    if (!wasCombat) {
      this.timeCombatStarted = this.now;
      this.combat.beginEngagement(this.now, true);
      bus.emit('ai:alert', { id: this.id, level: ALERT_LEVEL.combat });
    }
  }

  /* ----------------------------------------------------------- behaviour -- */

  private think(now: number, force = false): void {
    const previous = this.action;
    const next = selectAction(
      this, force ? null : previous, this.timeInAction, this.cooldowns, now, this.debugScores,
    );
    if (next === previous) return;
    if (previous) {
      previous.exit?.(this);
      this.cooldowns[ACTIONS.indexOf(previous)] = now + previous.cooldown;
    }
    this.action = next;
    this.timeInAction = 0;
    next.enter?.(this);
  }

  /** Called by an action that has completed its job. */
  finishAction(): void {
    if (!this.action) return;
    this.timeInAction = this.action.maxTime + 1;
    this.thinkTimer = 0;
  }

  /* ------------------------------------------------------------ movement -- */

  moveTo(goal: THREE.Vector3, mode: MoveMode): void {
    this.wantsMove = true;
    this.moveMode = mode;
    const changed = this.pathGoal.distanceToSquared(goal) > 1.0;
    if (changed || this.pathCount === 0 || this.pathAge > AGENT.pathLifetime) {
      this.pathGoal.copy(goal);
      this.pathPending = true;
      if (changed) {
        this.lastGoalDist = Infinity;
        this.stuckTimer = 0;
        this.stuckRetries = 0;
        this.pathFailed = false;
      }
    }
    if (this.pathPending && this.host.takePathBudget()) this.repath();
    if (this.pathCount === 0) this.steerTarget.copy(goal);
  }

  stopMoving(): void {
    this.wantsMove = false;
  }

  private repath(): void {
    this.pathPending = false;
    this.pathAge = 0;
    const n = this.host.nav.findPath(this.position, this.pathGoal, this.path);
    this.pathCount = Math.min(n, this.path.length);
    this.pathIndex = 0;
    this.pathFailed = n === 0;
    // Skip a first waypoint we are already standing on.
    if (this.pathCount > 1 && this.position.distanceTo(this.path[0]) < AGENT.waypointRadius) {
      this.pathIndex = 1;
    }
  }

  /** Local steering: path following + agent avoidance + obstacle whiskers. */
  private steer(dt: number): void {
    if (this.vaulting) { this.stepVault(dt); return; }

    const speed = this.speedFor(this.moveMode);
    this.desiredVelocity.set(0, 0, 0);

    if (this.wantsMove) {
      this.followPath();
      _v0.copy(this.steerTarget).sub(this.position);
      _v0.y = 0;
      const dist = _v0.length();
      if (dist > 0.06) {
        _v0.multiplyScalar(1 / dist);
        // Ease off over the last metre so agents settle into cover instead of
        // oscillating around it.
        const arrive = Math.min(1, dist / 1.1);
        this.desiredVelocity.copy(_v0).multiplyScalar(speed * arrive);
      }
    }

    // Cover peek offset: a real lateral step, so line of sight actually changes.
    if (this.peekBlend > 0.01 && this.currentCover) {
      _v1.copy(this.currentCover.normal);
      _right.set(_v1.z, 0, -_v1.x).normalize();
      _v2.copy(this.currentCover.position).addScaledVector(_right, this.peekSide * PEEK_OFFSET * this.peekBlend);
      _v0.copy(_v2).sub(this.position);
      _v0.y = 0;
      const d = _v0.length();
      if (d > 0.05) this.desiredVelocity.addScaledVector(_v0.multiplyScalar(1 / d), Math.min(1.6, d * 4));
    }

    this.avoid(dt);
    this.whiskers(dt);

    // Accelerate toward the desired velocity.
    const rate = this.desiredVelocity.lengthSq() > 0.01 ? AGENT.accel : AGENT.decel;
    this.steerVelocity.x = damp(this.steerVelocity.x, this.desiredVelocity.x, rate, dt);
    this.steerVelocity.z = damp(this.steerVelocity.z, this.desiredVelocity.z, rate, dt);
    if (this.steerVelocity.lengthSq() < 1e-4) this.steerVelocity.set(0, 0, 0);

    // Gravity + move.
    this.verticalVelocity += AGENT.gravity * dt;
    const controller = this.controller;
    if (controller && this.moveResult) {
      _v0.set(
        this.steerVelocity.x * dt,
        this.verticalVelocity * dt,
        this.steerVelocity.z * dt,
      );
      const before = _v3.copy(this.position);
      this.position.copy(controller.move(this.position, _v0, dt, this.moveResult));
      this.grounded = this.moveResult.grounded;
      if (this.grounded && this.verticalVelocity < 0) this.verticalVelocity = 0;
      if (this.moveResult.ceiling && this.verticalVelocity > 0) this.verticalVelocity = 0;
      this.velocity.copy(this.position).sub(before).multiplyScalar(1 / Math.max(1e-5, dt));

      // Blocked long enough to try a vault?
      if (this.moveResult.blocked && this.wantsMove && this.steerVelocity.lengthSq() > 1) {
        this.blockedTime += dt;
        if (this.blockedTime > 0.28) this.tryVault();
      } else {
        this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
      }
    } else {
      this.position.addScaledVector(this.steerVelocity, dt);
      this.velocity.copy(this.steerVelocity);
    }

    this.updateStuck(dt);
    this.updateBodyYaw(dt);
    this.updateStanceHeight(dt);
  }

  /**
   * Progress watchdog. Local steering can wedge an agent against geometry the
   * path did not know about; rather than let him grind into a wall forever, we
   * re-path a couple of times and then declare the goal unreachable so the
   * behaviour layer picks something else.
   */
  private updateStuck(dt: number): void {
    if (!this.wantsMove) {
      this.stuckTimer = 0;
      this.stuckRetries = 0;
      this.lastGoalDist = Infinity;
      return;
    }
    const d = this.position.distanceTo(this.pathGoal);
    if (d < this.lastGoalDist - 0.3) {
      this.lastGoalDist = d;
      this.stuckTimer = 0;
      return;
    }
    this.stuckTimer += dt;
    if (this.stuckTimer > 1.5) {
      this.stuckTimer = 0;
      this.stuckRetries++;
      this.lastGoalDist = d;
      if (this.stuckRetries >= 3) {
        this.pathFailed = true;
        this.thinkTimer = 0;
      } else {
        this.pathPending = true;
        this.pathAge = AGENT.pathLifetime + 1;
      }
    }
  }

  private speedFor(mode: MoveMode): number {
    let s: number = mode === 'sprint' ? AGENT.speedSprint
      : mode === 'combat' ? AGENT.speedCombat
        : mode === 'crouch' ? AGENT.speedCrouch : AGENT.speedWalk;
    if (this.stance === 'crouch') s = Math.min(s, AGENT.speedCrouch * 1.25);
    // Suppressed men move like it.
    s *= 1 - this.combat.suppression * 0.35;
    if (this.health < this.maxHealth * 0.35) s *= 0.88;
    return s;
  }

  private followPath(): void {
    if (this.pathCount === 0) return;
    let guard = 4;
    while (this.pathIndex < this.pathCount && guard-- > 0) {
      const wp = this.path[this.pathIndex];
      _v0.copy(wp).sub(this.position);
      _v0.y = 0;
      if (_v0.lengthSq() > AGENT.waypointRadius * AGENT.waypointRadius) break;
      this.pathIndex++;
    }
    if (this.pathIndex >= this.pathCount) {
      this.steerTarget.copy(this.path[this.pathCount - 1]);
      return;
    }
    this.steerTarget.copy(this.path[this.pathIndex]);

    // Look ahead: if the next-but-one waypoint is directly reachable, cut to it.
    if (this.pathIndex + 1 < this.pathCount) {
      const ahead = this.path[this.pathIndex + 1];
      if (this.host.nav.canWalk(this.position, ahead)) {
        this.steerTarget.copy(ahead);
        this.pathIndex++;
      }
    }
  }

  /**
   * RVO-lite: sample a fan of candidate velocities and keep the one with the
   * best trade-off between "where I wanted to go" and "when do I hit someone".
   * Cheaper and far more robust than solving ORCA half-planes, and at these
   * agent counts the difference is invisible.
   */
  private avoid(dt: number): void {
    void dt;
    const agents = this.host.agents;
    if (agents.length < 2 && !this.target) return;
    const desired = this.desiredVelocity;
    if (desired.lengthSq() < 0.04) return;

    const r = AGENT.radius;
    let bestScore = -Infinity;
    _v3.copy(desired);

    /*
     * Gather the neighbours once instead of re-filtering the whole roster
     * inside every candidate. The old loop was O(candidates × agents) per fixed
     * step — 12 × N × 120 Hz — even though in practice nobody is inside
     * `avoidRadius`. Same agents, same order, so the score sum is unchanged.
     */
    const near = _neighbours;
    near.length = 0;
    const rad2 = AGENT.avoidRadius * AGENT.avoidRadius;
    for (const other of agents) {
      if (other === this || !other.alive) continue;
      _v1.copy(other.position).sub(this.position);
      _v1.y = 0;
      if (_v1.lengthSq() > rad2) continue;
      near.push(other);
    }

    for (let c = 0; c < CANDIDATES.length; c++) {
      const [angle, scale] = CANDIDATES[c];
      _v0.copy(desired).multiplyScalar(scale);
      rotateY(_v0, angle);

      // Penalty for deviating from what we wanted.
      let score = -Math.abs(angle) * 0.55 - (1 - scale) * 0.9;

      for (const other of near) {
        _v1.copy(other.position).sub(this.position);
        _v1.y = 0;
        _v2.copy(_v0).sub(other.velocity);
        _v2.y = 0;
        const tc = timeToCollision(_v1, _v2, r * 2 + 0.1);
        if (tc < 0) continue;
        // Anything inside two seconds hurts, and hurts more the sooner it is.
        score -= 3.2 / Math.max(0.25, tc);
      }
      // The target counts as an obstacle too, so agents do not walk into you.
      const t = this.target;
      if (t) {
        _v1.copy(t.position).sub(this.position);
        _v1.y = 0;
        if (_v1.lengthSq() < 9) {
          _v2.copy(_v0).sub(t.velocity);
          _v2.y = 0;
          const tc = timeToCollision(_v1, _v2, r + t.radius + 0.15);
          if (tc >= 0) score -= 2.0 / Math.max(0.25, tc);
        }
      }
      if (score > bestScore) { bestScore = score; _v3.copy(_v0); }
    }
    desired.copy(_v3);
  }

  /** Forward-left/forward-right probes so agents round corners cleanly. */
  private whiskers(dt: number): void {
    const phys = this.host.physics;
    if (!phys || !phys.ready) return;
    this.whiskerTimer -= dt;
    if (this.whiskerTimer <= 0) {
      this.whiskerTimer = 1 / 12;
      _v0.copy(this.desiredVelocity);
      _v0.y = 0;
      if (_v0.lengthSq() < 0.05) { this.whiskerLeft = this.whiskerRight = 0; return; }
      _v0.normalize();
      _v1.copy(this.position);
      _v1.y = this.position.y - this.height * 0.5 + 0.95;
      const reach = 1.5;
      _v2.copy(_v0);
      rotateY(_v2, 0.5);
      phys.raycast(_v1, _v2, reach, MASK_MOVE, _hit);
      this.whiskerLeft = _hit.hit ? 1 - _hit.distance / reach : 0;
      _v2.copy(_v0);
      rotateY(_v2, -0.5);
      phys.raycast(_v1, _v2, reach, MASK_MOVE, _hit);
      this.whiskerRight = _hit.hit ? 1 - _hit.distance / reach : 0;
    }
    const bias = this.whiskerRight - this.whiskerLeft;
    if (Math.abs(bias) > 0.05) {
      rotateY(this.desiredVelocity, bias * 0.75);
    }
  }

  /* --------------------------------------------------------------- vault -- */

  /** Low obstacle in front, clear above it, floor beyond: vault it. */
  private tryVault(): void {
    const phys = this.host.physics;
    if (!phys || !phys.ready || this.vaulting) return;
    _fwd.copy(this.steerVelocity);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.5) return;
    _fwd.normalize();

    const feet = this.position.y - this.height * 0.5;
    _v0.set(this.position.x, feet + 0.35, this.position.z);
    phys.raycast(_v0, _fwd, 1.0, MASK_MOVE, _hit);
    if (!_hit.hit) return;
    const obstacleDist = _hit.distance;

    _v0.set(this.position.x, feet + 1.25, this.position.z);
    phys.raycast(_v0, _fwd, obstacleDist + 0.6, MASK_MOVE, _hit);
    if (_hit.hit) return;                       // too tall to vault

    // Is there floor on the other side?
    _v0.copy(this.position).addScaledVector(_fwd, obstacleDist + 1.15);
    _v0.y = feet + 1.6;
    _v1.set(0, -1, 0);
    phys.raycast(_v0, _v1, 3.0, MASK_MOVE, _hit);
    if (!_hit.hit) return;
    const landing = _hit.point.y;
    if (landing > feet + 1.05) return;

    this.vaulting = true;
    this.vaultT = 0;
    this.vaultDuration = 0.52;
    this.vaultFrom.copy(this.position);
    this.vaultTo.copy(_v0);
    this.vaultTo.y = landing + this.height * 0.5;
    this.blockedTime = 0;
    this.character?.play('vaultLow');
  }

  private stepVault(dt: number): void {
    this.vaultT += dt / this.vaultDuration;
    const t = clamp01(this.vaultT);
    this.position.lerpVectors(this.vaultFrom, this.vaultTo, t);
    // Parabolic lift over the obstacle.
    this.position.y += Math.sin(t * Math.PI) * 0.55;
    this.velocity.copy(this.vaultTo).sub(this.vaultFrom).multiplyScalar(1 / this.vaultDuration);
    const c = this.controller as (CharacterController & { teleport?(p: THREE.Vector3): void }) | null;
    c?.teleport?.(this.position);
    if (t >= 1) {
      this.vaulting = false;
      this.verticalVelocity = 0;
      this.pathPending = true;
    }
    this.updateBodyYaw(dt);
  }

  /* --------------------------------------------------------------- stance -- */

  setStance(s: Stance): void { this.stance = s; }

  private updateStanceHeight(dt: number): void {
    const want = this.stance === 'stand' ? AGENT.standHeight : AGENT.crouchHeight;
    if (Math.abs(want - this.height) < 0.005) return;
    const next = damp(this.height, want, 9, dt);
    const c = this.controller as (CharacterController & {
      canSetHeight?(h: number, p: THREE.Vector3): boolean;
    }) | null;
    if (c) {
      if (next > this.height && c.canSetHeight && !c.canSetHeight(next, this.position)) return;
      c.setHeight(next);
    }
    this.height = next;
  }

  private updateBodyYaw(dt: number): void {
    // Face where we are shooting; face where we are running when sprinting.
    const sprinting = this.moveMode === 'sprint' && this.wantsMove;
    let wantYaw = this.bodyYaw;
    if (sprinting && this.velocity.lengthSq() > 1) {
      wantYaw = Math.atan2(this.velocity.x, this.velocity.z);
    } else {
      _v0.copy(this.aimSmoothed).sub(this.position);
      _v0.y = 0;
      if (_v0.lengthSq() > 1e-4) wantYaw = Math.atan2(_v0.x, _v0.z);
    }
    const rate = (sprinting ? AGENT.turnRateSprint : AGENT.turnRate) * dt;
    this.bodyYaw = turnToward(this.bodyYaw, wantYaw, rate);
    this.updateBasis();
  }

  private updateBasis(): void {
    this.forward.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
    this.eye.copy(this.position);
    this.eye.y = this.position.y + this.height * 0.5 - AGENT.eyeDrop;
    // Muzzle: from the rig when we have one, otherwise a plausible offset.
    // The rig is posed in `update()`, so it can be a frame stale or — on the
    // very first tick — not placed at all; reject anything implausible.
    const proxy = this.character as unknown as {
      muzzleWorld?(out: THREE.Vector3): boolean;
    } | null;
    if (proxy && typeof proxy.muzzleWorld === 'function' && proxy.muzzleWorld(this.muzzle)
      && this.muzzle.distanceToSquared(this.eye) < 1.6) return;
    _right.set(this.forward.z, 0, -this.forward.x);
    this.muzzle.copy(this.eye)
      .addScaledVector(this.forward, 0.34)
      .addScaledVector(_right, -0.14);
    this.muzzle.y -= 0.12;
  }

  /* ---------------------------------------------------------------- aim --- */

  aimAt(point: THREE.Vector3): void { this.aimPoint.copy(point); }

  aimAtTarget(): void {
    const t = this.target;
    const p = this.perception;
    if (t && p.hasLOS) {
      // Aim at the visible mass, and lead a moving target slightly.
      const lead = Math.min(0.28, this.distanceToTarget / 320);
      this.aimPoint.copy(t.position)
        .addScaledVector(t.velocity, lead);
      this.aimPoint.y = t.position.y + t.height * 0.12;
    } else if (p.confidence > 0.05) {
      p.predict(0.3, this.aimPoint);
      this.aimPoint.y += 0.9;
    } else {
      this.aimPoint.copy(this.eye).addScaledVector(this.forward, 10);
    }
  }

  aimAlongVelocity(): void {
    if (this.velocity.lengthSq() < 0.4) { this.aimAtTarget(); return; }
    this.aimPoint.copy(this.position).addScaledVector(this.velocity, 2.2);
    this.aimPoint.y = this.eye.y;
  }

  aimAtSuppressionPoint(): void {
    const p = this.perception;
    p.predict(0.15, this.aimPoint);
    this.aimPoint.y += 0.85;
    // Walk the burst side to side across the cover the target is behind.
    this.suppressSweep += 0.02;
    _v0.copy(this.aimPoint).sub(this.eye);
    _v0.y = 0;
    _v0.normalize();
    _right.set(_v0.z, 0, -_v0.x);
    this.aimPoint.addScaledVector(_right, Math.sin(this.suppressSweep) * 0.85);
  }

  aimAtGrenadeArc(): void {
    if (this.grenadeSolutionOk) {
      this.aimPoint.copy(this.eye).addScaledVector(this.grenadeVelocity, 0.6);
    } else {
      this.aimAtTarget();
    }
  }

  private updateAim(dt: number): void {
    // Aim tracking is a physical thing: the muzzle takes time to swing across.
    const track = this.perception.hasLOS ? 13 : 6;
    this.aimSmoothed.x = damp(this.aimSmoothed.x, this.aimPoint.x, track, dt);
    this.aimSmoothed.y = damp(this.aimSmoothed.y, this.aimPoint.y, track, dt);
    this.aimSmoothed.z = damp(this.aimSmoothed.z, this.aimPoint.z, track, dt);

    _v0.copy(this.aimSmoothed).sub(this.eye);
    const horiz = Math.hypot(_v0.x, _v0.z);
    this.aimYaw = Math.atan2(_v0.x, _v0.z);
    this.aimPitch = Math.atan2(_v0.y, Math.max(0.001, horiz));
  }

  setFireMode(m: FireMode): void { this.fireMode = m; }

  private updateFiring(dt: number): void {
    void dt;
    const t = this.target;
    if (!t || this.fireMode === 'hold' || !this.alive || !this.combatEnabled) {
      this.combat.firing = false;
      return;
    }
    if (this.combat.reloading || this.combat.ammo <= 0) return;

    // Do not shoot until the muzzle has actually caught up with the aim point.
    const swing = Math.abs(angleDelta(this.aimYaw, Math.atan2(
      this.aimPoint.x - this.eye.x, this.aimPoint.z - this.eye.z,
    )));
    if (swing > 0.22) return;

    if (this.fireMode === 'aimed' && !this.perception.hasLOS) return;
    if (this.fireMode === 'suppress' && this.perception.confidence < 0.12) return;

    // Never shoot a squadmate in the back.
    if (this.friendlyInLine()) return;

    const suppressive = this.fireMode === 'suppress';
    this.combat.tryFire(
      this.now, this.muzzle, t, this.distanceToTarget, this.host.physics,
      this.id, suppressive, this.aimSmoothed, _shot, this.entityId,
    );
    if (_shot.fired) {
      this.character?.play('fire');
      this.character?.addRecoil(0.22);
    }
  }

  /** True when a squadmate is close to the line of fire. */
  private friendlyInLine(): boolean {
    _v0.copy(this.aimSmoothed).sub(this.muzzle);
    const len = _v0.length();
    if (len < 0.5) return false;
    _v0.multiplyScalar(1 / len);
    for (const other of this.host.agents) {
      if (other === this || !other.alive) continue;
      _v1.copy(other.position).sub(this.muzzle);
      const along = _v1.dot(_v0);
      if (along <= 0.4 || along >= len) continue;
      _v2.copy(_v0).multiplyScalar(along).sub(_v1);
      if (_v2.lengthSq() < 0.42 * 0.42) return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- cover --- */

  /**
   * Picks a cover point. `advanceBias` > 0 moves toward the enemy, < 0 away;
   * `flankBias` rewards points off the enemy's current facing.
   */
  chooseCover(advanceBias: number, flankBias: number): CoverPoint | null {
    const threat = this.threatPosition(_v0);
    const cover = this.host.cover;
    cover.physics = this.host.physics;
    const q = {
      agentId: this.id,
      from: this.position,
      threat,
      idealRange: this.weapon.rangeIdeal * (advanceBias >= 0 ? 0.6 : 1.4),
      maxTravel: advanceBias > 0 ? 16 : advanceBias < 0 ? 22 : 11,
      advanceBias,
      flankBias: flankBias * this.flankSide,
      peekWeight: 1.1,
      now: this.now,
    };
    let res = cover.query(q);
    if (!res.point) {
      // Nothing static nearby: probe the geometry around us.
      cover.probeAround(this.position, threat, this.host.nav);
      res = cover.query(q, true);
    }
    if (!res.point) return null;
    this.releaseCover();
    if (!cover.reserve(res.point, this.id, this.now)) return null;
    this.currentCover = res.point;
    this.peekSide = res.canPeekRight ? 1 : res.canPeekLeft ? -1 : 0;
    this.coverCompromised = false;
    this.coverEvalTimer = 0.6;
    return res.point;
  }

  releaseCover(): void {
    if (!this.currentCover) return;
    this.host.cover.release(this.currentCover, this.id, this.now);
    this.currentCover = null;
    this.peekSide = 0;
    this.peekTarget = 0;
  }

  private threatPosition(out: THREE.Vector3): THREE.Vector3 {
    const p = this.perception;
    if (p.confidence > 0.05 || p.everSeen) return out.copy(p.lastKnown);
    if (this.squad && this.squad.targetConfidence > 0) return out.copy(this.squad.targetPosition);
    const t = this.target;
    return t ? out.copy(t.position) : out.copy(this.position).addScaledVector(this.forward, 10);
  }

  private updateCoverState(dt: number): void {
    void dt;
    const phys = this.host.physics;
    const t = this.target;
    this.exposedToTarget = false;
    if (t && phys && phys.ready && this.perception.hasLOS) {
      this.exposedToTarget = this.perception.visibility > 0.34;
    }

    if (this.coverEvalTimer > 0) return;
    this.coverEvalTimer = 0.5;
    const c = this.currentCover;
    if (!c) { this.coverCompromised = false; return; }
    if (!t) return;
    const threat = this.threatPosition(_v0);
    _v1.copy(c.position);
    _v1.y += c.height === 'low' ? 1.02 : 1.5;
    _v2.copy(threat);
    _v2.y += 1.5;
    const seen = phys && phys.ready ? phys.lineOfSight(_v1, _v2, MASK_SIGHT) : false;
    // Compromised when the spot no longer blocks, or we have been leaned on.
    this.coverCompromised = seen
      || (this.combat.suppression > 0.72 && this.now - this.combat.lastSuppressedAt < 1.5);
  }

  /**
   * The peek cycle: hide, pop out, fire a burst, drop back. This is what stops
   * an agent trading shots in the open, and it is the single most important
   * behaviour for making a firefight readable.
   */
  runCoverCombat(dt: number): void {
    const c = this.currentCover;
    if (!c) { this.setFireMode(this.canEngage ? 'aimed' : 'hold'); return; }
    this.peekTimer -= dt;
    this.exposureTimer = this.peekPhase === 'out' ? this.exposureTimer + dt : 0;

    const wantHide = this.combat.reloading
      || this.combat.suppression > 0.62
      || this.combat.needsReload
      || !this.combat.ready;

    /*
     * Base of fire.
     *
     * A squad whose peek cycles happen to line up all duck at the same moment,
     * and the player gets long stretches with nothing coming at him — which is
     * how a cover-based AI ends up reading as passive even though every
     * individual is behaving correctly. Somebody keeps a gun up: if nobody else
     * in the squad can currently shoot, this man does not drop back on the
     * timer, only when he genuinely has to (reloading, suppressed, not ready).
     *
     * `MAX_SOLO_EXPOSURE` stops that turning into a statue standing in the
     * open — he is still a man you can push and kill.
     */
    const others = this.squad ? this.squad.gunsOn - (this.canEngage ? 1 : 0) : 0;
    const soleGun = others < 1;

    if (this.peekPhase === 'hidden') {
      this.setFireMode('hold');
      this.setStance(c.height === 'low' ? 'crouch' : 'stand');
      this.peekTarget = 0;
      // Nobody covering: skip the dwell and get rounds going out now.
      if (soleGun && this.peekTimer > 0) this.peekTimer = 0;
      if (!wantHide && this.peekTimer <= 0 && this.perception.confidence > 0.2) {
        this.peekPhase = 'out';
        this.exposureTimer = 0;
        this.peekTimer = 0.9 + this.rand.next() * 1.3;
        // Alternate sides sometimes so the player cannot pre-aim one corner.
        if (this.rand.next() < 0.3 && this.peekSide !== 0) this.peekSide = (-this.peekSide) as -1 | 1;
        this.character?.play(this.peekSide < 0 ? 'coverPeekL' : 'coverPeekR');
      }
    } else {
      this.setStance('stand');
      this.peekTarget = 1;
      this.setFireMode(this.perception.hasLOS ? 'aimed' : 'suppress');
      this.aimAtTarget();
      const burstDone = this.combat.burstLeft <= 0 && this.now < this.combat.nextBurstAt;
      const timeUp = this.peekTimer <= 0 || burstDone;
      const overstayed = this.exposureTimer > MAX_SOLO_EXPOSURE;
      if (wantHide || overstayed || (timeUp && !soleGun)) {
        this.peekPhase = 'hidden';
        this.exposureTimer = 0;
        this.peekTimer = 0.35 + this.rand.next() * 0.75;
        this.character?.play(c.height === 'low' ? 'coverLow' : 'coverHigh');
      }
    }
    this.peekBlend = damp(this.peekBlend, this.peekTarget, 7, dt);
  }

  setPeek(side: -1 | 0 | 1): void {
    this.peekSide = side;
    this.peekTarget = side === 0 ? 0 : 1;
  }

  /** Backs away from the threat when there is nothing to hide behind. */
  retreatStep(): void {
    const threat = this.threatPosition(_v0);
    _v1.copy(this.position).sub(threat);
    _v1.y = 0;
    if (_v1.lengthSq() < 0.01) _v1.copy(this.forward).negate();
    _v1.normalize();
    _v2.copy(this.position).addScaledVector(_v1, 6);
    this.host.nav.snap(_v2, _v3);
    this.moveTo(_v3, 'combat');
  }

  /** A wide arc around the target, on this agent's assigned side. */
  buildFlankRoute(): void {
    const threat = this.threatPosition(_v0);
    _v1.copy(this.position).sub(threat);
    _v1.y = 0;
    const dist = Math.max(6, _v1.length());
    _v1.normalize();
    // Swing 70–100° around the target, at a similar radius.
    const angle = (1.2 + this.rand.next() * 0.55) * this.flankSide;
    rotateY(_v1, angle);
    _v2.copy(threat).addScaledVector(_v1, dist * 0.92);
    this.host.nav.snap(_v2, this.flankGoal);
  }

  /* ------------------------------------------------------------- search --- */

  pickSearchPoint(): void {
    const p = this.perception;
    const nav = this.host.nav;
    this.searchDwell = 1.4 + this.rand.next() * 1.6;
    this.searchIndex++;
    if (this.searchIndex === 1 && p.hasInterest) {
      nav.snap(p.interest, this.searchPoint);
      return;
    }
    if (this.searchIndex <= 2 && p.confidence > 0.1) {
      p.predict(1.2, _v0);
      nav.snap(_v0, this.searchPoint);
      return;
    }
    // Then spiral outward from the last known position.
    const base = p.confidence > 0.02 ? p.lastKnown : this.position;
    const r = 3 + this.searchIndex * 2.2;
    nav.wander(base, r * 0.5, r, () => this.rand.next(), this.searchPoint);
  }

  /* ------------------------------------------------------------ grenades -- */

  canThrowGrenade(): boolean {
    const now = this.now;
    if (now < this.grenadeReadyAt) return false;
    if (this.squad && !this.squad.requestGrenade(now)) return false;
    if (now - this.grenadeSolveAt > 1.8) {
      this.grenadeSolveAt = now;
      // One roll per attempt window, not per frame.
      if (this.rand.next() > this.profile.grenadeChance) {
        this.grenadeReadyAt = now + 3.5;
        this.grenadeSolutionOk = false;
        return false;
      }
      this.grenadeOrigin.copy(this.eye).addScaledVector(this.forward, 0.35);
      this.perception.predict(1.4, _v0);
      _v0.y = this.host.nav.groundY(_v0) + 0.35;
      const sol = this.host.grenades.solve(this.grenadeOrigin, _v0, this.host.debugGizmos);
      this.grenadeSolutionOk = sol.ok;
      if (sol.ok) this.grenadeVelocity.copy(sol.velocity);
    }
    return this.grenadeSolutionOk;
  }

  releaseGrenade(): void {
    if (this.grenadeReleased || !this.grenadeSolutionOk) return;
    this.grenadeReleased = true;
    this.grenadeOrigin.copy(this.eye).addScaledVector(this.forward, 0.35);
    this.host.grenades.throwAt(
      this.id, this.squad?.id ?? -1, this.grenadeOrigin, this.grenadeVelocity, this.rand,
    );
    this.squad?.onGrenadeThrown(this.now);
    this.grenadeReadyAt = this.now + 22;
    this.grenadeSolutionOk = false;
  }

  /* --------------------------------------------------------------- melee -- */

  doMelee(): void {
    const t = this.target;
    if (!t) return;
    if (this.position.distanceTo(t.position) > 2.6) return;
    if (!this.perception.hasLOS) return;
    _v0.copy(t.position).sub(this.position).normalize();
    if (t.isPlayer) {
      bus.emit('damage:taken', {
        amount: 55 * this.profile.damageScale,
        fromDirection: _v0.clone().negate(),
        sourceId: this.id,
        lethal: false,
      });
    }
    bus.emit('physics:impact', {
      point: t.position.clone(), impulse: 420, material: 'armor',
    });
  }

  /* -------------------------------------------------------------- damage -- */

  /**
   * One-shot receipt for a hit that has *already* been applied by whoever owns
   * damage arbitration (the game layer's actor bridge, driven by the weapon
   * system's `DamageResolver`).
   *
   * `Ballistics.resolveImpact` calls the resolver and then publishes
   * `damage:dealt` on the same synchronous call stack; `AISystem` listens to
   * that event and would apply the identical hit a second time. Arming the
   * claim immediately after applying means the echo lands on a token that
   * matches, is swallowed, and the token is gone before anything else can use
   * it. Nothing about the ordinary bus path changes when no resolver is
   * installed — the token is simply never armed.
   */
  private claimAmount = 0;
  private claimArmed = false;
  private claimKilled = false;

  claimBusEcho(amount: number, killed: boolean): void {
    this.claimAmount = amount;
    this.claimKilled = killed;
    this.claimArmed = true;
  }

  private consumeBusEcho(amount: number): boolean {
    if (!this.claimArmed) return false;
    // Float-exact would be fine (it is the same number round-tripped through a
    // struct) but a relative epsilon costs nothing and survives a future
    // rounding step in the event payload.
    if (Math.abs(amount - this.claimAmount) > Math.max(1e-6, this.claimAmount * 1e-6)) return false;
    this.claimArmed = false;
    return true;
  }

  /** Applies damage from the outside world. Returns true when it killed. */
  applyDamage(
    amount: number, fromDirection: THREE.Vector3, zone: HitZone, byPlayer: boolean,
    point?: THREE.Vector3,
  ): boolean {
    if (this.consumeBusEcho(amount)) return this.claimKilled;
    if (!this.alive) return false;
    this.health -= amount;

    this.combat.addFlinch(clamp01(amount / 45));
    this.combat.addSuppression(clamp01(amount / 30) * 0.55, this.now);
    this.character?.react(fromDirection, zone, clamp01(amount / 40));

    // Being shot from nowhere is the strongest alerting stimulus there is.
    if (this.perception.state !== 'combat') {
      _v0.copy(this.position).addScaledVector(fromDirection, -14);
      const t = this.target;
      this.alertTo(t ? t.position : _v0, 0.75);
      this.say(VO.hit, 6);
    }
    this.squad?.report(
      this.target ? this.target.position : this.perception.lastKnown,
      this.perception.lastKnownVelocity, 0.6, this.now,
    );

    if (this.health <= 0) {
      this.die(fromDirection, zone, byPlayer, amount, point);
      return true;
    }
    return false;
  }

  die(
    fromDirection: THREE.Vector3, zone: HitZone, byPlayer: boolean, power: number,
    point?: THREE.Vector3,
  ): void {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.combat.endEngagement();
    this.releaseCover();
    this.action?.exit?.(this);
    this.action = null;

    // Clip-then-ragdoll (ported from BotFallback): play a directional death,
    // stash the impulse for CharacterSystem.onDeath / our safety timer. Instant
    // ragdoll on the kill frame was the structural death hitch — 15 capsules +
    // joints built synchronously while the sim was already catching up.
    const proxy = this.character as unknown as { velocity?: THREE.Vector3 } | null;
    if (proxy && proxy.velocity) proxy.velocity.copy(this.velocity);
    _v0.copy(fromDirection).normalize().multiplyScalar(Math.min(48, 8 + power * 0.55));
    _v0.y += 1.5;
    this.deathImpulse.copy(_v0);
    this.deathZone = (zone === 'head' || zone === 'neck') ? 'head' : zone;
    const headshot = zone === 'head' || zone === 'neck';
    const clip = pickDeathClip(this.bodyYaw, fromDirection, headshot);

    if (this.character) {
      const ud = this.character.object.userData as {
        pendingDeathImpulse?: THREE.Vector3;
        pendingDeathZone?: HitZone;
      };
      ud.pendingDeathImpulse = this.deathImpulse.clone();
      ud.pendingDeathZone = this.deathZone;
      try {
        this.character.play(clip, { fade: 0.05 });
        // Safety handoff: Proxy has no onDeathComplete; real Characters finish
        // earlier via Animator → CharacterSystem.onDeath (isRagdoll guards double).
        this.deathRagdollPending = true;
        // Stagger handoff so multi-kills do not share one construct frame.
        this.deathRagdollTimer = (headshot ? 0.2 : 0.32) + this.rand.next() * 0.18;
      } catch {
        try { this.character.ragdoll(this.deathImpulse, this.deathZone); }
        catch { /* no presentation path available */ }
        this.deathRagdollPending = false;
      }
    }

    if (this.host.emitDeath) {
      bus.emit('entity:death', {
        id: this.entityId,
        byPlayer,
        headshot,
        name: this.name,
        point: (point ?? this.position).clone(),
      });
    }
    this.squad?.onMemberDown(this, this.now);
    this.controller?.dispose();
    this.controller = null;
  }

  /* ------------------------------------------------------------- helpers -- */

  say(line: VoiceLine, cooldown = 6): boolean {
    if (this.squad) return this.squad.say(this, line, this.now, cooldown);
    bus.emit('ai:voice', { id: this.id, line });
    return true;
  }

  requestMove(priority: number): boolean {
    if (!this.squad) return true;
    return this.squad.requestMove(this, this.now, priority);
  }

  releaseMove(): void { this.squad?.releaseMove(this); }

  onMoveTokenLost(): void {
    // Somebody more urgent needs to move; get back into cover.
    this.thinkTimer = 0;
  }

  /** Suppression from rounds landing nearby. */
  suppressFrom(point: THREE.Vector3, power: number): void {
    const d = this.position.distanceTo(point);
    if (d > 4.5) return;
    const amount = power * (1 - d / 4.5) * 0.55;
    this.combat.addSuppression(amount, this.now);
    if (this.perception.state === 'idle' && amount > 0.2) {
      this.perception.awareness = Math.max(this.perception.awareness, 0.45);
    }
  }

  /* -------------------------------------------------------- presentation -- */

  private syncPresentation(dt: number): void {
    const ch = this.character;
    if (!ch) return;
    if (ch.isRagdoll) return;

    ch.object.position.set(
      this.position.x,
      this.position.y - this.height * 0.5,
      this.position.z,
    );
    ch.object.rotation.y = this.bodyYaw;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const state = !this.alive ? 'idle'
      : this.stance === 'crouch' ? 'crouch'
        : speed > 4.4 ? 'sprint'
          : speed > 2.3 ? 'run'
            : speed > 0.25 ? 'walk' : 'idle';
    // Strafe factor: how sideways the movement is relative to the body.
    let strafe = 0;
    if (speed > 0.2) {
      _right.set(this.forward.z, 0, -this.forward.x);
      strafe = clamp01(Math.abs(this.velocity.dot(_right)) / Math.max(0.5, speed))
        * Math.sign(this.velocity.dot(_right));
    }
    ch.setLocomotion(state, speed, strafe);
    ch.setAim(angleDelta(this.bodyYaw, this.aimYaw), this.aimPitch);
    void dt;
  }

  dispose(): void {
    this.releaseCover();
    this.controller?.dispose();
    this.controller = null;
    this.character?.dispose();
    this.character = null;
  }
}

/* ------------------------------------------------------------------ helpers */

/** Candidate (rotation, scale) pairs for the avoidance sampler. */
const CANDIDATES: Array<[number, number]> = [
  [0, 1], [0, 0.55],
  [0.26, 1], [-0.26, 1],
  [0.52, 1], [-0.52, 1],
  [0.52, 0.7], [-0.52, 0.7],
  [0.95, 0.85], [-0.95, 0.85],
  [1.45, 0.7], [-1.45, 0.7],
];

/**
 * Time until two discs collide, or -1 when they never do.
 * `rel` is the relative position, `vel` the relative velocity.
 */
function timeToCollision(rel: THREE.Vector3, vel: THREE.Vector3, radius: number): number {
  const c = rel.x * rel.x + rel.z * rel.z - radius * radius;
  if (c < 0) return 0;                                  // already overlapping
  const a = vel.x * vel.x + vel.z * vel.z;
  if (a < 1e-6) return -1;
  const b = rel.x * vel.x + rel.z * vel.z;
  if (b <= 0) return -1;                                // moving apart
  const disc = b * b - a * c;
  if (disc <= 0) return -1;
  const t = (b - Math.sqrt(disc)) / a;
  return t < 0 ? -1 : t;
}

function makeMoveResultLocal(): CharacterMoveResult {
  return {
    applied: new THREE.Vector3(),
    grounded: false,
    groundNormal: new THREE.Vector3(0, 1, 0),
    groundSurface: 'concrete',
    blocked: false,
    ceiling: false,
    impactSpeed: 0,
    platformDelta: new THREE.Vector3(),
    platformYaw: 0,
  };
}
