/**
 * AISystem — perception, navigation, cover selection, squad tactics and combat
 * behaviour for every enemy in the game.
 *
 * Structure:
 *   AISystem      this file: lifetime, budgets, bus plumbing, target resolution
 *   Agent         one enemy: movement, steering, aiming, presentation
 *   Perception    sight/hearing/memory, per agent
 *   Behaviour     utility scoring across eleven behaviours
 *   Squad         blackboard, roles, bounding-advance arbitration, callouts
 *   Nav / Cover   navmesh adapter with a self-built fallback, cover evaluation
 *   Combat        fire control: reaction, convergent aim error, bursts
 *   Grenades      arc solving and detonation
 *
 * Everything this module needs from other modules is duck-typed at runtime —
 * the world's navmesh, the character factory, the player — so the AI builds and
 * runs while those modules are still being written.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus } from '../core/EventBus';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type { PhysicsAPI } from '../physics/types';
import type { Character, CharacterFactory, CharacterLoadout } from '../characters/types';
import { Agent, AGENT, type AgentHost } from './Agent';
import { Perception, LightProbe } from './Perception';
import { CoverSystem } from './Cover';
import { NavService } from './Nav';
import { GrenadeSystem, GRENADE } from './Grenades';
import { Squad, SquadManager } from './Squad';
import { Gizmos, GIZMO } from './Gizmos';
import { ProxySoldier } from './ProxyCharacter';
import { ACTIONS } from './Behaviour';
import {
  ALERT_LEVEL, VO,
  type AgentSpawnOptions, type Difficulty, type SoundStimulus, type TargetLike,
  type WorldCoverLike,
} from './types';
import './DebugScene';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Structural view of the player system. */
interface PlayerLike {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  alive: boolean;
  entityId: number;
  state?: string;
  health?: number;
}

/** A mutable target record filled from whatever we are fighting. */
class TargetRecord implements TargetLike {
  entityId = 1;
  isPlayer = true;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  alive = true;
  eyeOffset = 0.74;
  height = 1.8;
  radius = 0.4;
  crouch = 0;
  firedAt = -1e9;
  readonly facing = new THREE.Vector3(0, 0, 1);
}

export class AISystem implements System, AgentHost {
  readonly name = 'ai';
  readonly order = ORDER.AI;

  /** Every agent ever spawned this level, including the dead (for ragdolls). */
  readonly agents: Agent[] = [];
  readonly squads: SquadManager;
  readonly nav = new NavService();
  readonly cover = new CoverSystem();
  readonly grenades = new GrenadeSystem();
  readonly lightProbe: LightProbe | null = new LightProbe();
  readonly gizmos = new Gizmos();

  physics: PhysicsAPI | null = null;
  target: TargetLike | null = null;
  difficulty: Difficulty = 'regular';
  /** Draw paths, cover scores and awareness meters. */
  debugGizmos = false;
  /** Additionally draw the sampled navigation grid. Costly; debug only. */
  showNavGrid = false;
  /** AI publishes `entity:death` for its own agents. */
  emitDeath = true;

  private ctx: EngineContext | null = null;
  private readonly root = new THREE.Group();
  private readonly player = new TargetRecord();
  private playerSystem: PlayerLike | null = null;
  private rand = new Rand('ai-system');
  private simTime = 0;
  private nextAgentId = 1;
  private pathBudget = 0;
  private pathBudgetMax = 2;
  private navBuilt = false;
  private navRetry = 0;
  private unsubscribe: Array<() => void> = [];
  private customTarget: TargetLike | null = null;
  private lightTimer = 0;
  private aliveCache = new Set<number>();
  private lastImpactSound = -1e9;

  constructor() {
    this.squads = new SquadManager(0x51eed);
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    if (params.get('aidebug') === '1') this.debugGizmos = true;
    const diff = params.get('difficulty');
    if (diff && (diff in { recruit: 1, regular: 1, hardened: 1, veteran: 1 })) {
      this.difficulty = diff as Difficulty;
    }
  }

  /* ---------------------------------------------------------------- init -- */

  async init(ctx: EngineContext): Promise<void> {
    this.ctx = ctx;
    this.root.name = 'ai';
    ctx.scene.add(this.root);
    this.gizmos.visible = this.debugGizmos;
    ctx.scene.add(this.gizmos.root);

    this.physics = (ctx.engine.tryGet('physics') as unknown as PhysicsAPI | undefined) ?? null;
    this.nav.attach(this.physics);
    this.cover.physics = this.physics;
    this.grenades.attach(this.physics, this.root);
    this.grenades.onResolved = (squadId) => this.squads.get(squadId)?.onGrenadeResolved();
    this.grenades.onExplode = (point, ownerId) => this.onGrenadeExploded(point, ownerId);

    this.playerSystem = (ctx.engine.tryGet('player') as unknown as PlayerLike | undefined) ?? null;
    this.lightProbe?.scan(ctx.scene, 0, true);

    this.installListeners();
  }

  private installListeners(): void {
    const off = this.unsubscribe;

    // The player's weapon is the loudest thing in the level.
    off.push(bus.on('weapon:fire', (e) => {
      this.player.firedAt = this.simTime;
      this.emitSound({
        position: e.origin, loudness: e.suppressed ? 34 : 145, kind: 'gunfire',
        fromTarget: true, sourceId: this.player.entityId,
      });
      // Rounds cracking past an agent suppress him even when they miss.
      this.suppressAlongRay(e.origin, e.direction, 90, 0.32);
    }));

    off.push(bus.on('player:footstep', (e) => {
      this.emitSound({
        position: e.point, loudness: e.sprinting ? 22 : 11, kind: 'footstep',
        fromTarget: true, sourceId: this.player.entityId,
      });
    }));

    off.push(bus.on('player:land', (e) => {
      this.emitSound({
        position: e.point, loudness: 10 + e.force, kind: 'footstep',
        fromTarget: true, sourceId: this.player.entityId,
      });
    }));

    off.push(bus.on('explosion', (e) => {
      this.emitSound({
        position: e.point, loudness: 220, kind: 'explosion',
        fromTarget: false, sourceId: -1,
      });
      this.applyBlast(e.point, e.radius, e.power);
    }));

    off.push(bus.on('bullet:impact', (e) => {
      // Impacts near an agent are the primary suppression signal.
      for (const a of this.agents) {
        if (!a.alive) continue;
        a.suppressFrom(e.point, 0.5);
      }
      // Hearing every single impact would cost an occlusion ray per agent per
      // round; a few a second carries the same information.
      if (this.simTime - this.lastImpactSound > 0.18) {
        this.lastImpactSound = this.simTime;
        this.emitSound({
          position: e.point, loudness: 26, kind: 'impact', fromTarget: false, sourceId: -1,
        });
      }
    }));

    off.push(bus.on('damage:dealt', (e) => {
      const agent = this.byEntity(e.targetId);
      if (!agent || !agent.alive) return;
      _v0.copy(e.point).sub(agent.position);
      if (_v0.lengthSq() < 1e-6) _v0.copy(agent.forward).negate();
      _v0.normalize();
      const zone = e.headshot ? 'head' : 'chest';
      const killed = agent.applyDamage(e.amount, _v0, zone, e.fromPlayer, e.point);
      if (killed && e.fromPlayer) {
        bus.emit('hud:hitmarker', { headshot: e.headshot, killed: true, armor: false });
      }
    }));

    // A grenade in the air is worth shouting about, whoever threw it.
    off.push(bus.on('grenade:thrown', () => {
      let best: Agent | null = null;
      for (const a of this.agents) {
        if (!a.alive) continue;
        if (!best || a.perception.awareness > best.perception.awareness) best = a;
      }
      if (best && best.perception.awareness > 0.3) best.say(VO.grenade, 5);
    }));

    off.push(bus.on('level:loaded', () => { this.navBuilt = false; }));
    off.push(bus.on('game:ready', () => { this.navBuilt = false; }));
    off.push(bus.on('quality:changed', () => { this.applyQuality(); }));
    this.applyQuality();
  }

  private applyQuality(): void {
    const preset = settings.preset;
    this.pathBudgetMax = preset === 'low' ? 1 : preset === 'medium' ? 2 : 3;
  }

  /** Visibility sample points per perception tick. */
  get sightSamples(): number {
    const p = settings.preset;
    return p === 'low' ? 2 : p === 'medium' ? 4 : 6;
  }

  get now(): number { return this.simTime; }

  takePathBudget(): boolean {
    if (this.pathBudget <= 0) return false;
    this.pathBudget--;
    return true;
  }

  /* ------------------------------------------------------------- spawning -- */

  /** Builds the fallback navigation grid and harvests cover from it. */
  buildNavigation(bounds?: THREE.Box3, forceFallback = false): void {
    const physics = this.physics;
    if (!physics || !physics.ready) return;

    // Prefer whatever the world module publishes …
    const world = forceFallback ? null : this.ctx?.engine.tryGet('world') as unknown;
    const external = !!world && this.nav.probeExternal(world);
    this.cover.clear();
    if (external && world) {
      this.cover.ingestNav(this.nav, _v0.set(0, 0, 0), 200);
      const worldCover = (world as { cover?: unknown }).cover;
      if (Array.isArray(worldCover)) this.cover.ingestWorld(worldCover as WorldCoverLike[]);
    }

    // … but always build the sampled grid anyway. It costs one pass of scene
    // queries at load and it is the only thing standing between a navmesh that
    // throws mid-level and a squad of statues.
    const box = bounds ?? this.worldBounds();
    const grid = this.nav.buildFallback(box, {
      agentRadius: AGENT.radius,
      agentHeight: AGENT.standHeight,
      stepHeight: 0.5,
    });
    if (!grid) {
      this.navBuilt = this.cover.points.length > 0;
      return;
    }

    if (!external) {
      const worldCover = (world as { cover?: unknown } | undefined)?.cover;
      if (Array.isArray(worldCover) && worldCover.length > 0) {
        this.cover.ingestWorld(worldCover as WorldCoverLike[]);
      }
    }
    if (this.cover.points.length < 12) this.cover.generateFromGrid(grid, physics);
    this.navBuilt = true;
    console.info(
      `[ai] nav ${external ? 'world navmesh + ' : ''}grid ${grid.nx}x${grid.nz} `
      + `@${grid.cell.toFixed(2)}m, ${grid.walkableCells} walkable, `
      + `${this.cover.points.length} cover points, ${grid.buildMs.toFixed(0)}ms`,
    );
  }

  private worldBounds(): THREE.Box3 {
    const world = this.ctx?.engine.tryGet('world') as unknown as { bounds?: THREE.Box3 } | undefined;
    if (world?.bounds && world.bounds.isBox3) {
      const b = world.bounds.clone();
      // Clamp to something we can afford to sample.
      const c = b.getCenter(_v0);
      const s = b.getSize(_v1);
      const half = Math.min(60, Math.max(s.x, s.z) * 0.5);
      b.min.set(c.x - half, b.min.y, c.z - half);
      b.max.set(c.x + half, b.max.y, c.z + half);
      return b;
    }
    return new THREE.Box3(
      new THREE.Vector3(-45, -3, -45),
      new THREE.Vector3(45, 12, 45),
    );
  }

  /** Spawns one agent. Creates a squad when none is given. */
  spawn(opts: AgentSpawnOptions): Agent {
    const id = this.nextAgentId++;
    const agent = new Agent(id, this, {
      ...opts,
      difficulty: opts.difficulty ?? this.difficulty,
      seed: opts.seed ?? this.rand.u32(),
    });
    if (this.physics && this.physics.ready) agent.attachPhysics(this.physics);
    agent.attachCharacter(this.makeCharacter(agent, opts));

    let squad: Squad | undefined = opts.squadId !== undefined
      ? this.squads.get(opts.squadId) : undefined;
    if (!squad) squad = this.squads.create();
    squad.add(agent);
    agent.squad = squad;

    this.agents.push(agent);
    this.aliveCache.add(id);
    return agent;
  }

  /** Spawns a coordinated squad around a position. */
  spawnSquad(
    centre: THREE.Vector3, count: number,
    opts: Partial<AgentSpawnOptions> = {},
  ): Agent[] {
    const squad = this.squads.create();
    const made: Agent[] = [];
    const n = THREE.MathUtils.clamp(count, 1, 6);
    const loadouts: CharacterLoadout[] = ['rifleman', 'rifleman', 'smg', 'rifleman', 'lmg', 'shotgun'];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      _v0.set(centre.x + Math.cos(a) * (1.6 + i * 0.35), centre.y, centre.z + Math.sin(a) * (1.6 + i * 0.35));
      this.nav.snap(_v0, _v1);
      made.push(this.spawn({
        ...opts,
        position: _v1.clone(),
        yaw: opts.yaw ?? 0,
        loadout: opts.loadout ?? loadouts[i % loadouts.length],
        squadId: squad.id,
      }));
    }
    return made;
  }

  private makeCharacter(agent: Agent, opts: AgentSpawnOptions): Character {
    const seed = (opts.seed ?? 0) ^ (agent.id * 7919);
    const factory = this.characterFactory();
    if (factory) {
      try {
        const c = factory.create({
          faction: opts.faction ?? 'militia',
          loadout: opts.loadout ?? 'rifleman',
          seed,
        });
        this.root.add(c.object);
        return c;
      } catch (err) {
        console.warn('[ai] character factory failed, using proxy rig', err);
      }
    }
    const proxy = new ProxySoldier({
      faction: opts.faction ?? 'militia',
      loadout: opts.loadout ?? 'rifleman',
      seed,
    });
    proxy.entityId = agent.entityId;
    const phys = this.physics as unknown as ProxySoldier['physics'];
    if (phys && typeof (phys as { spawnRagdoll?: unknown }).spawnRagdoll === 'function') {
      proxy.physics = phys;
    }
    this.root.add(proxy.object);
    return proxy;
  }

  /** Duck-types a character factory from the engine or a global hook. */
  private characterFactory(): CharacterFactory | null {
    const sys = this.ctx?.engine.tryGet('characters') as unknown as
      { factory?: CharacterFactory; create?: CharacterFactory['create'] } | undefined;
    if (sys) {
      if (sys.factory && typeof sys.factory.create === 'function') return sys.factory;
      if (typeof sys.create === 'function') return sys as unknown as CharacterFactory;
    }
    const g = (globalThis as unknown as { __CHARACTERS__?: CharacterFactory }).__CHARACTERS__;
    if (g && typeof g.create === 'function') return g;
    return null;
  }

  /** Removes every agent and squad. */
  clear(): void {
    for (const a of this.agents) a.dispose();
    this.agents.length = 0;
    this.squads.clear();
    this.aliveCache.clear();
    this.grenades.clear();
    this.nextAgentId = 1;
  }

  byEntity(entityId: number): Agent | null {
    for (const a of this.agents) if (a.entityId === entityId) return a;
    return null;
  }

  byId(id: number): Agent | null {
    for (const a of this.agents) if (a.id === id) return a;
    return null;
  }

  get aliveAgents(): number {
    let n = 0;
    for (const a of this.agents) if (a.alive) n++;
    return n;
  }

  /* ---------------------------------------------------------------- tick -- */

  fixedUpdate(dt: number, ctx: EngineContext): void {
    this.simTime += dt;
    this.pathBudget = this.pathBudgetMax;

    if (!this.navBuilt) {
      this.navRetry -= dt;
      if (this.navRetry <= 0) {
        this.navRetry = 1.0;
        if (this.physics && this.physics.ready) this.buildNavigation();
      }
    }

    this.resolveTarget(ctx);

    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 2.5;
      this.lightProbe?.scan(ctx.scene, this.simTime);
    }

    this.squads.update(dt, this.simTime);
    this.cover.tick(this.simTime, (id) => this.aliveCache.has(id));

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) { this.aliveCache.delete(a.id); continue; }
      a.fixedUpdate(dt);
    }

    this.grenades.fixedUpdate(dt);
  }

  update(dt: number, ctx: EngineContext): void {
    for (const a of this.agents) a.update(dt);
    if (this.debugGizmos) this.drawGizmos(ctx);
    else if (this.gizmos.visible) this.gizmos.visible = false;
  }

  /* -------------------------------------------------------------- target -- */

  /** Points the AI at a specific target — used by the test bed. */
  setTarget(t: TargetLike | null): void { this.customTarget = t; }

  private resolveTarget(ctx: EngineContext): void {
    if (this.customTarget) { this.target = this.customTarget; return; }
    const p = this.playerSystem
      ?? (ctx.engine.tryGet('player') as unknown as PlayerLike | undefined) ?? null;
    if (!p) { this.target = null; return; }
    this.playerSystem = p;

    const rec = this.player;
    rec.position.copy(p.position);
    rec.velocity.copy(p.velocity);
    rec.alive = p.alive !== false;
    rec.entityId = p.entityId ?? 1;
    rec.isPlayer = true;
    const state = p.state ?? '';
    rec.crouch = state === 'crouch' || state === 'slide' ? 0.85 : state === 'prone' ? 1 : 0;
    rec.height = 1.8;
    rec.radius = 0.4;
    rec.eyeOffset = 0.74;
    rec.facing.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    this.target = rec;
  }

  /* --------------------------------------------------------------- audio -- */

  /** Distributes a sound stimulus to every agent that could hear it. */
  emitSound(s: SoundStimulus): void {
    for (const a of this.agents) {
      if (!a.alive) continue;
      a.perception.hear(s, a.eye, this.physics, this.simTime);
    }
  }

  /** Suppression for agents close to a bullet's flight path. */
  private suppressAlongRay(
    origin: THREE.Vector3, direction: THREE.Vector3, maxDist: number, power: number,
  ): void {
    _v0.copy(direction).normalize();
    for (const a of this.agents) {
      if (!a.alive) continue;
      _v1.copy(a.position).sub(origin);
      const along = _v1.dot(_v0);
      if (along < 0 || along > maxDist) continue;
      _v2.copy(_v0).multiplyScalar(along).sub(_v1);
      const miss = _v2.length();
      if (miss > 2.2) continue;
      a.combat.addSuppression(power * (1 - miss / 2.2), this.simTime);
      if (a.perception.state === 'idle') {
        a.perception.awareness = Math.max(a.perception.awareness, 0.5);
      }
    }
  }

  /* ----------------------------------------------------------- explosions -- */

  private applyBlast(point: THREE.Vector3, radius: number, power: number): void {
    for (const a of this.agents) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(point);
      if (d > radius) continue;
      let f = 1 - d / radius;
      f *= f;
      const exposed = this.physics && this.physics.ready
        ? (this.physics.lineOfSight(point, _v0.copy(a.position).setY(a.position.y + 0.2)) ? 1 : 0.35)
        : 1;
      a.combat.addSuppression(f * 1.4, this.simTime);
      const dmg = power * 3.4 * f * exposed;
      if (dmg > 1) {
        _v1.copy(a.position).sub(point).normalize().negate();
        a.applyDamage(dmg, _v1, 'chest', false, point);
      }
    }
  }

  /** Our own grenade went off: damage whatever we were aiming at. */
  private onGrenadeExploded(point: THREE.Vector3, ownerId: number): void {
    const t = this.target;
    if (!t || !t.alive) return;
    const dmg = this.grenades.blastDamage(point, t.position);
    if (dmg <= 0) return;
    if (t.isPlayer) {
      _v0.copy(t.position).sub(point).normalize();
      bus.emit('damage:taken', {
        amount: dmg, fromDirection: _v0.clone().negate(), sourceId: ownerId, lethal: false,
      });
    }
  }

  /* -------------------------------------------------------------- gizmos -- */

  private drawGizmos(ctx: EngineContext): void {
    void ctx;
    const g = this.gizmos;
    g.visible = true;
    g.begin();

    // Sampled navigation grid, thinned so it reads as a field rather than fog.
    if (this.showNavGrid && this.nav.grid) {
      const grid = this.nav.grid;
      const stride = Math.max(1, Math.round(1.4 / grid.cell));
      for (let iz = 0; iz < grid.nz; iz += stride) {
        for (let ix = 0; ix < grid.nx; ix += stride) {
          const i = iz * grid.nx + ix;
          if (grid.flags[i] !== 1) continue;
          _v0.set(
            grid.min.x + (ix + 0.5) * grid.cell,
            grid.floor[i] + 0.03,
            grid.min.z + (iz + 0.5) * grid.cell,
          );
          g.point(_v0, grid.clearance[i] <= 1 ? 0x1d5f7a : GIZMO.navCell, 0.035);
        }
      }
    }

    // Cover points, coloured by whether they currently protect from the threat.
    const threat = this.target ? this.target.position : null;
    let drawn = 0;
    for (const c of this.cover.points) {
      if (drawn > 220) break;
      if (threat && c.position.distanceToSquared(threat) > 3600) continue;
      drawn++;
      const colour = c.occupant >= 0
        ? GIZMO.coverClaimed
        : c.debugProtected ? GIZMO.coverGood : GIZMO.coverBad;
      g.point(_v0.copy(c.position).setY(c.position.y + 0.09), colour, 0.095);
      g.line(
        _v0,
        _v1.copy(c.position).addScaledVector(c.normal, 0.5).setY(c.position.y + 0.08),
        colour, 0.028, 0.16,
      );
    }

    for (const a of this.agents) {
      if (!a.alive) {
        g.point(_v0.copy(a.position).setY(a.position.y + 0.1), 0x552222, 0.1);
        continue;
      }
      // Path.
      for (let i = a.pathIndex; i < a.pathCount - 1; i++) {
        g.line(a.path[i], a.path[i + 1], GIZMO.path, 0.062, 0.3);
      }
      if (a.pathCount > 0) {
        g.ring(a.path[a.pathCount - 1], 0.42, GIZMO.pathGoal, 0.055);
      }

      // Where he is standing and which way the cover he claimed faces.
      if (a.currentCover) {
        g.line(
          _v0.copy(a.position).setY(a.position.y - a.height * 0.5 + 0.05),
          _v1.copy(a.currentCover.position).setY(a.currentCover.position.y + 0.05),
          GIZMO.coverClaimed, 0.03, 0.4,
        );
      }

      // Awareness meter above the head.
      const state = a.perception.state;
      const colour = state === 'combat' ? GIZMO.awareCombat
        : state === 'searching' ? GIZMO.awareSearch
          : state === 'suspicious' ? GIZMO.awareSuspicious : GIZMO.awareIdle;
      _v0.copy(a.position);
      _v0.y += a.height * 0.5 + 0.12;
      g.bar(_v0, a.perception.awareness, colour, 0.55, 0.055);

      // Suppression meter, offset to the side.
      if (a.combat.suppression > 0.02) {
        _v1.copy(_v0);
        _v1.x += 0.16;
        g.bar(_v1, a.combat.suppression, 0xffa000, 0.4, 0.04);
      }

      // Sight line.
      if (this.target) {
        const clear = a.perception.hasLOS;
        _v1.copy(this.target.position);
        _v1.y += 0.3;
        if (clear || a.perception.confidence > 0.2) {
          g.line(a.eye, _v1, clear ? GIZMO.losClear : GIZMO.losBlocked, 0.03, 0.7);
        }
      }

      // Last known position.
      if (a.perception.confidence > 0.05) {
        g.ring(a.perception.lastKnown, 0.5, GIZMO.lastKnown, 0.04, 12);
      }

      // Label: action, role, awareness.
      _v0.copy(a.position);
      _v0.y += a.height * 0.5 + 0.95;
      g.label(_v0, `${a.actionName}·${a.role.slice(0, 4)}`, labelColour(state));
    }

    // Grenade arc.
    if (this.grenades.debugArcCount > 0) {
      const arc = this.grenades.debugArc;
      for (let i = 0; i < this.grenades.debugArcCount; i++) {
        _v0.set(arc[i * 3], arc[i * 3 + 1], arc[i * 3 + 2]);
        g.point(_v0, GIZMO.grenade, 0.045);
      }
    }

    g.end();
  }

  /* ------------------------------------------------------------ debug api -- */

  /** JSON-serialisable snapshot for scripted verification. */
  snapshot(): unknown {
    return {
      time: this.simTime,
      navExternal: this.nav.usingExternal,
      navCells: this.nav.grid ? this.nav.grid.walkableCells : 0,
      coverPoints: this.cover.points.length,
      agents: this.agents.map((a) => ({
        id: a.id,
        alive: a.alive,
        health: Math.round(a.health),
        action: a.actionName,
        role: a.role,
        state: a.perception.state,
        awareness: +a.perception.awareness.toFixed(3),
        visibility: +a.perception.visibility.toFixed(2),
        suppression: +a.combat.suppression.toFixed(2),
        ammo: a.combat.ammo,
        shots: a.combat.shotsFired,
        hits: a.combat.shotsHit,
        inCover: a.inCover,
        coverId: a.currentCover ? a.currentCover.id : -1,
        protectedNow: a.currentCover ? a.currentCover.debugProtected : false,
        pos: [+a.position.x.toFixed(2), +a.position.y.toFixed(2), +a.position.z.toFixed(2)],
        pathLen: a.pathCount,
        distance: +a.distanceToTarget.toFixed(2),
        scores: Array.from(a.debugScores).map((s, i) => `${ACTIONS[i].name}:${s.toFixed(2)}`),
      })),
      squads: [...this.squads.all()].map((s) => ({
        id: s.id, alive: s.aliveCount, engaged: s.engaged,
        moveToken: s.moveToken, eyesOn: s.eyesOn, gunsOn: s.gunsOn,
        confidence: +s.targetConfidence.toFixed(2),
      })),
    };
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clear();
    this.grenades.dispose();
    this.gizmos.dispose();
    this.root.removeFromParent();
  }
}

function labelColour(state: string): string {
  return state === 'combat' ? '#ff6b6b'
    : state === 'searching' ? '#ffb154'
      : state === 'suspicious' ? '#ffe08a' : '#c7d3e0';
}

export { Agent, Perception, CoverSystem, NavService, GrenadeSystem, GRENADE, ALERT_LEVEL };
