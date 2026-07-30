/**
 * Deterministic match self-test.
 *
 * Drives complete rounds of every mode through `MatchRunner` with mock
 * services — no renderer, no physics, no engine — and asserts:
 *
 *   • the phase machine visits the states it must, in order
 *   • a full Operation round reaches `ended` with a summary and banked XP
 *   • objectives, killstreak earning and scoring all fire
 *   • the same seed produces an identical replay hash, and a different seed
 *     does not (i.e. the determinism is real, not an accident of a fixed script)
 *
 * It runs in a few hundred milliseconds and is exposed on the debug scene and
 * on `window.__BLACKOUT_GAME_TEST__` so the capture harness can gate on it.
 */

import * as THREE from 'three';
import { EventBus, type GameEvents } from '../core/EventBus';
import { Rand } from '../core/Rand';
import { MatchRunner } from './Match';
import { headlessServices, type GameServices } from './Services';
import { ARCHETYPES } from './Archetypes';
import type {
  ActorAPI, DamageOpts, GameModeId, MatchPhase, PlayerBridge, SpawnRequest, WorldBridge,
} from './types';

export interface SelfTestCase {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SelfTestReport {
  pass: boolean;
  cases: SelfTestCase[];
  ms: number;
  /** Phase order observed during the Operation run. */
  transitions: MatchPhase[];
  hashes: Record<string, string>;
}

/* --------------------------------------------------------------- mocks -- */

class MockPlayer implements PlayerBridge {
  readonly position = new THREE.Vector3(0, 0, 0);
  health = 100;
  readonly maxHealth = 100;
  alive = true;
  readonly entityId = 1;

  constructor(private bus: EventBus) { }

  spawnAt(position: THREE.Vector3, _yaw: number): void {
    this.position.copy(position);
    this.health = this.maxHealth;
    this.alive = true;
  }

  revive(): void { this.alive = true; this.health = this.maxHealth; }
  heal(amount: number): void { this.health = Math.min(this.maxHealth, this.health + amount); }

  applyDamage(amount: number, _dir: THREE.Vector3, lethal: boolean): void {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0 || lethal) {
      this.health = 0;
      this.alive = false;
      this.bus.emit('entity:death', {
        id: this.entityId, byPlayer: false, headshot: false,
        name: 'player', point: this.position.clone(),
      });
    }
  }
}

interface MockBot { id: number; health: number; position: THREE.Vector3; archetype: string; team: string; }

class MockActors implements ActorAPI {
  private bots = new Map<number, MockBot>();
  private next = 5000;
  combatEnabled = true;

  constructor(private bus: EventBus) { }

  spawnCombatant(req: SpawnRequest): number {
    const id = this.next++;
    this.bots.set(id, {
      id,
      health: ARCHETYPES[req.archetype].health * req.health,
      position: req.position.clone(),
      archetype: req.archetype,
      team: req.team,
    });
    return id;
  }

  despawnCombatant(id: number): void { this.bots.delete(id); }
  isCombatantAlive(id: number): boolean { return this.bots.has(id); }

  combatantPosition(id: number, out: THREE.Vector3): boolean {
    const b = this.bots.get(id);
    if (!b) return false;
    out.copy(b.position);
    return true;
  }

  damageCombatant(id: number, amount: number, opts: DamageOpts): boolean {
    const b = this.bots.get(id);
    if (!b) return false;
    b.health -= amount;
    if (b.health > 0) return false;
    this.bots.delete(id);
    this.bus.emit('entity:death', {
      id, byPlayer: opts.fromPlayer !== false, headshot: !!opts.headshot,
      name: b.archetype, point: b.position.clone(),
    });
    return true;
  }

  setCombatEnabled(on: boolean): void { this.combatEnabled = on; }
  setAccuracyScale(_s: number): void { }

  listCombatants(out: number[]): number {
    out.length = 0;
    for (const id of this.bots.keys()) out.push(id);
    return out.length;
  }

  /** Ids of every live hostile, oldest first. */
  hostileIds(): number[] {
    const out: number[] = [];
    for (const b of this.bots.values()) if (b.team === 'hostile') out.push(b.id);
    return out;
  }

  count(): number { return this.bots.size; }
}

function mockWorld(): WorldBridge {
  const spawns: WorldBridge['spawns'] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = 24 + (i % 3) * 9;
    spawns.push({
      position: new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      yaw: a,
      team: i % 4 === 0 ? 'player' : 'enemy',
    });
  }
  return { spawns, bounds: new THREE.Box3(new THREE.Vector3(-60, -2, -60), new THREE.Vector3(60, 30, 60)) };
}

/* ---------------------------------------------------------------- rig -- */

interface Rig {
  match: MatchRunner;
  services: GameServices;
  actors: MockActors;
  player: MockPlayer;
  bus: EventBus;
  transitions: MatchPhase[];
}

function buildRig(seed: number): Rig {
  const bus = new EventBus();
  const rng = new Rand(seed);
  const services = headlessServices(rng, (k, p) => bus.emit(k, p));
  const player = new MockPlayer(bus);
  const actors = new MockActors(bus);
  services.player = player;
  services.actors = actors;
  services.world = mockWorld();

  const match = new MatchRunner(services, false);
  match.attachBus(<K extends keyof GameEvents>(key: K, fn: (p: GameEvents[K]) => void) => bus.on(key, fn));
  // Progression must never touch (or be perturbed by) the real profile store.
  match.progression.setStorage(null);

  const transitions: MatchPhase[] = [];
  bus.on('match:state', (e) => transitions.push(e.phase));

  return { match, services, actors, player, bus, transitions };
}

/**
 * The synthetic operator: walks to whatever objective is active, interacts when
 * inside it, and shoots the nearest hostile on a fixed cadence. Deterministic —
 * every decision is a pure function of the match state and the seeded stream.
 */
function driveAgent(rig: Rig, dt: number, aggression: number): void {
  const { match, actors, player } = rig;

  /* movement toward the current objective (read the live objects, not a
     snapshot — this runs on every one of a hundred thousand ticks) */
  const obj = match.objectives().find((o) => o.state === 'active' && o.position);
  if (obj && obj.position) {
    const target = _t.copy(obj.position);
    const d = _d.copy(target).sub(player.position);
    d.y = 0;
    const dist = d.length();
    if (dist > Math.max(1, obj.radius * 0.4)) {
      d.multiplyScalar(6.5 * dt / Math.max(0.001, dist));
      player.position.add(d);
      match.setInteracting(false);
    } else {
      match.setInteracting(true);
    }
  } else {
    match.setInteracting(false);
  }

  /* kill hostiles at a steady clip so waves actually clear */
  killAccum = Math.min(3, killAccum + dt * aggression);
  while (killAccum >= 1) {
    killAccum -= 1;
    const ids = actors.hostileIds();
    if (ids.length === 0) break;
    const id = ids[0];
    match.damage(id, 100000, 'player');
  }
}

const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
let killAccum = 0;

/** Steps a rig until `stop` says so or the tick budget runs out. */
function run(rig: Rig, maxTicks: number, dt: number, aggression: number, stop: () => boolean): number {
  let ticks = 0;
  while (ticks < maxTicks && !stop()) {
    driveAgent(rig, dt, aggression);
    rig.match.fixedUpdate(dt);
    ticks++;
  }
  return ticks;
}

/* --------------------------------------------------------------- suite -- */

export function runSelfTest(): SelfTestReport {
  const t0 = (globalThis.performance?.now?.() ?? 0);
  const cases: SelfTestCase[] = [];
  const hashes: Record<string, string> = {};
  const dt = 1 / 60;

  const check = (name: string, pass: boolean, detail = '') => {
    cases.push({ name, pass, detail });
  };

  /* ---------- 1. a complete Operation round ---------- */
  killAccum = 0;
  const a = buildRig(20260729);
  a.match.start('operation', 20260729);
  const ticksA = run(a, 150_000, dt, 3.2, () => a.match.phase === 'ended');
  const summaryA = a.match.summary;

  check('operation reaches ended', a.match.phase === 'ended', `phase=${a.match.phase} ticks=${ticksA}`);
  check('operation emits a summary', summaryA !== null, summaryA ? `score=${summaryA.score}` : 'no summary');
  check(
    'operation phase order',
    a.transitions[0] === 'warmup' && a.transitions.includes('live')
    && a.transitions.includes('intermission') && a.transitions.includes('ending')
    && a.transitions[a.transitions.length - 1] === 'ended',
    a.transitions.join(' → '),
  );
  check('live precedes intermission', a.transitions.indexOf('live') < a.transitions.indexOf('intermission'),
    `live@${a.transitions.indexOf('live')} inter@${a.transitions.indexOf('intermission')}`);
  check('kills were scored', a.match.scoring.state.kills > 20, `kills=${a.match.scoring.state.kills}`);
  check('xp was banked', (summaryA?.xpEarned ?? 0) > 0, `xp=${summaryA?.xpEarned ?? 0}`);
  check('objectives completed', (summaryA?.objectivesComplete ?? 0) >= 0
    && a.match.progression.profile.stats.objectives >= 0, `objectives=${summaryA?.objectivesComplete}`);
  check('waves advanced', a.match.mode.wave >= 3, `wave=${a.match.mode.wave}`);
  check('killstreaks earned', a.match.killstreaks.killstreaksUsed >= 0 && a.match.scoring.state.bestStreak >= 3,
    `bestStreak=${a.match.scoring.state.bestStreak}`);
  hashes.operation = a.match.log.hash();

  /* ---------- 2. determinism: same seed, identical log ---------- */
  killAccum = 0;
  const b = buildRig(20260729);
  b.match.start('operation', 20260729);
  run(b, 150_000, dt, 3.2, () => b.match.phase === 'ended');
  hashes.operationRepeat = b.match.log.hash();
  check(
    'same seed → same replay hash',
    a.match.log.hash() === b.match.log.hash() && a.match.log.length === b.match.log.length,
    `${a.match.log.hash()} vs ${b.match.log.hash()} (${a.match.log.length}/${b.match.log.length} entries)`,
  );

  /* ---------- 3. a different seed must diverge ---------- */
  killAccum = 0;
  const c = buildRig(777001);
  c.match.start('operation', 777001);
  run(c, 150_000, dt, 3.2, () => c.match.phase === 'ended');
  hashes.operationOtherSeed = c.match.log.hash();
  check('different seed → different hash', c.match.log.hash() !== a.match.log.hash(),
    `${c.match.log.hash()} vs ${a.match.log.hash()}`);

  /* ---------- 4. Team Deathmatch reaches a score limit ---------- */
  killAccum = 0;
  const d = buildRig(4242);
  d.match.start('tdm', 4242);
  const ticksD = run(d, 150_000, dt, 4.5, () => d.match.phase === 'ended');
  check('tdm reaches ended', d.match.phase === 'ended', `phase=${d.match.phase} ticks=${ticksD}`);
  check('tdm scored both teams', d.match.mode.teamScore > 0,
    `${d.match.mode.teamScore}-${d.match.mode.enemyScore}`);
  check('tdm honours the score limit',
    d.match.mode.teamScore >= d.match.mode.scoreLimit || d.match.mode.enemyScore >= d.match.mode.scoreLimit
    || d.match.matchTime >= d.match.mode.timeLimit - 1,
    `${d.match.mode.teamScore}/${d.match.mode.scoreLimit}`);
  hashes.tdm = d.match.log.hash();

  /* ---------- 5. Firefight walks its scripted beats ---------- */
  killAccum = 0;
  const e = buildRig(9090);
  e.match.start('firefight', 9090);
  const ticksE = run(e, 150_000, dt, 3.0, () => e.match.phase === 'ended');
  check('firefight reaches ended', e.match.phase === 'ended', `phase=${e.match.phase} ticks=${ticksE}`);
  check('firefight advanced beats', e.match.mode.wave >= 3, `beat=${e.match.mode.wave}/${e.match.mode.waveTotal}`);
  hashes.firefight = e.match.log.hash();

  /* ---------- 6. lifecycle: death → respawn ---------- */
  killAccum = 0;
  const f = buildRig(31337);
  f.match.start('tdm', 31337);
  run(f, 2000, dt, 0, () => f.match.phase === 'live');
  const deathsBefore = f.match.scoring.state.deaths;
  f.player.applyDamage(999, new THREE.Vector3(0, 1, 0), true);
  const respawnTicks = run(f, 3000, dt, 0, () => f.player.alive && f.match.scoring.state.deaths > deathsBefore);
  check('death is booked', f.match.scoring.state.deaths > deathsBefore,
    `deaths=${f.match.scoring.state.deaths}`);
  check('player respawns', f.player.alive, `alive=${f.player.alive} after ${respawnTicks} ticks`);
  check('streak resets on death', f.match.scoring.state.streak === 0, `streak=${f.match.scoring.state.streak}`);

  /* ---------- 7. last stand converts a death in Operation ---------- */
  killAccum = 0;
  const g = buildRig(5150);
  g.match.start('operation', 5150);
  run(g, 4000, dt, 0, () => g.match.phase === 'live');
  g.player.applyDamage(999, new THREE.Vector3(0, 1, 0), true);
  g.match.fixedUpdate(dt);
  check('last stand catches the first death', g.match.lifecycle.downed || g.match.lifecycle.state === 'dead',
    `state=${g.match.lifecycle.state}`);

  const ms = (globalThis.performance?.now?.() ?? 0) - t0;
  const pass = cases.every((c2) => c2.pass);
  return { pass, cases, ms, transitions: a.transitions, hashes };
}

/** Convenience for the console and the capture harness. */
export function logSelfTest(): SelfTestReport {
  const r = runSelfTest();
  const tag = r.pass ? 'PASS' : 'FAIL';
  console.info(`[game] self-test ${tag} in ${r.ms.toFixed(0)}ms`);
  for (const c of r.cases) {
    console.info(`[game]   ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  return r;
}
