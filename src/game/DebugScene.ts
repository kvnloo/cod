/**
 * `--debug game` test bed.
 *
 * Everything this module claims to do is staged here so it can be judged from a
 * still frame and from a script:
 *
 *   • every mode's HUD state — wave, buy phase, TDM scoreboard, firefight beat
 *   • every objective shape with its world marker and progress arc
 *   • every killstreak as a physical thing in the world
 *   • the post-match summary with real banked XP
 *   • the deterministic match-state-machine self-test, rendered as a report
 *
 * Shots are registered from inside `build()` so they only appear in capture runs
 * that asked for this scene.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { registerDebugScene, registerShots } from '../core/Shots';
import { tagSurface, type SurfaceType } from '../core/Surfaces';
import type { MaterialSystem } from '../material/MaterialLibrary';
import type { OverlapResult, PhysicsAPI } from '../physics/types';
import { MASK_MOVE } from '../physics/types';
import { makeRayHit } from './Services';
import { DebugHud, type TelemetrySource } from './DebugHud';
import { HoldZoneObjective } from './Objectives';
import { logSelfTest, type SelfTestReport } from './SelfTest';
import type { GameDirector } from './GameDirector';
import type { MatchRunner } from './Match';
import type { Archetype, GameModeId } from './types';

/**
 * Camera anchor every shot is composed around.
 *
 * Resolved from the level at build time rather than hard-coded: the world
 * module owns the geometry and may rebuild it at any moment, so we borrow its
 * own eye-level capture shot (or its player spawn) and stage around that. This
 * is what keeps the game shots framed on open ground instead of inside a wall.
 */
const CAM = new THREE.Vector3(0, 1.78, 12);
let CAM_YAW = 180;
let CAM_PITCH = -4;

interface Stage {
  ctx: EngineContext;
  director: GameDirector;
  match: MatchRunner;
  hud: DebugHud;
  report: SelfTestReport | null;
}

let stage: Stage | null = null;
const _probe = new THREE.Vector3();

interface WorldShotSource {
  captureShots?: () => Array<{ name: string; position: [number, number, number]; yaw: number; pitch: number }>;
  spawns?: Array<{ position: THREE.Vector3; yaw: number; team: string }>;
}

/** Borrows the level's own eye-level view, falling back to its player spawn. */
function resolveStageCamera(ctx: EngineContext): void {
  const world = ctx.engine.tryGet<System & WorldShotSource>('world');
  const shots = (() => {
    try { return world?.captureShots?.() ?? []; } catch { return []; }
  })();
  const eye = shots.find((s) => /eye|street|lane|player|hero/i.test(s.name))
    ?? shots.find((s) => s.position[1] < 4 && s.pitch > -25);
  if (eye) {
    CAM.set(eye.position[0], Math.max(1.7, eye.position[1]), eye.position[2]);
    CAM_YAW = eye.yaw;
    CAM_PITCH = Math.max(-10, Math.min(2, eye.pitch));
    return;
  }
  const spawn = world?.spawns?.find((s) => s.team === 'player') ?? world?.spawns?.[0];
  if (spawn) {
    CAM.set(spawn.position.x, Math.max(1.7, spawn.position.y + 1.7), spawn.position.z);
    CAM_YAW = THREE.MathUtils.radToDeg(spawn.yaw);
    CAM_PITCH = -4;
  }
}

registerDebugScene('game', async (ctx: EngineContext) => {
  const director = ctx.engine.tryGet<GameDirector>('director');
  if (!director) { console.warn('[game] debug scene: no director system'); return; }

  resolveStageCamera(ctx);
  console.info(`[game] stage camera ${CAM.toArray().map((n) => n.toFixed(1)).join(',')} yaw ${CAM_YAW.toFixed(0)}`);

  // The player system owns the render camera every frame; in a staged capture
  // we want the shot camera to survive the settle frames, so it steps aside.
  const player = ctx.engine.tryGet<System>('player');
  if (player) player.enabled = false;

  // Mounted as a sibling of `#ui-root`, not inside it, so the shipping HUD can
  // be hidden independently for the two views only this overlay provides.
  const hud = new DebugHud(document.getElementById('app') ?? document.body);

  // Pump the HUD from a tiny system rather than the render loop so it stays in
  // step with the deterministic frame pump.
  ctx.engine.add({
    name: 'game-debug-hud',
    order: ORDER.UI + 1,
    update: (dt: number) => hud.update(dt),
  });

  buildProps(ctx);

  const report = logSelfTest();
  hud.setSelfTest(report);
  // `src/ui` owns the combat HUD. This overlay stays out of the way and only
  // draws the two views the shipping HUD has no reason to have: the pacing
  // telemetry card and the self-test report.
  hud.setMode('hidden');
  (globalThis as unknown as { __BLACKOUT_GAME_TEST__?: SelfTestReport }).__BLACKOUT_GAME_TEST__ = report;

  stage = { ctx, director, match: director.match, hud, report };
  hud.setTelemetrySource(telemetry());

  director.startMatch('operation', 20260729);
  step(ctx, 30);

  registerShots([
    shot('game-operation', 'Operation mode: live wave with the director pushing enemies through cover', 0, 0, () => stageWave(2)),
    shot('game-objective-hold', 'Hold-zone objective: ground ring, light column and progress arc, contested', -1.5, 3, () => stageObjective()),
    shot('game-buy', 'Between-wave buy phase with three purchasable offers and the wave countdown', 0, 0, () => stageBuy()),
    shot('game-uav', 'UAV killstreak up: orbiting drone and live radar contacts on the tacmap', 4, 16, () => stageUav()),
    shot('game-sentry', 'Sentry turret killstreak deployed, tracking and engaging hostiles', 6, -3, () => stageSentry()),
    shot('game-airstrike-mark', 'Precision airstrike target marking, ordnance called on the painted point', 0, 2, () => stageAirstrikeMark()),
    shot('game-airstrike-run', 'Airstrike run: the three-ship flight inbound over the street toward the painted mark', 0, 8, () => stageAirstrikeRun()),
    shot('game-carepackage', 'Care package on the deck with its claim beacon and strobe', -3, 0, () => stageCarePackage()),
    shot('game-tdm', 'Team Deathmatch: 6v6 bots, team scoreboard and anti-spawn-trap respawns', 0, 0, () => stageMode('tdm', 14)),
    shot('game-firefight', 'Firefight: scripted beat with its objective marker and hand-placed enemies', 0, 0, () => stageMode('firefight', 12)),
    shot('game-summary', 'Post-match summary: score breakdown, XP ledger, rank progress and replay hash', 0, 0, () => stageSummary()),
    shot('game-director', 'Pacing director telemetry: beat, intensity, pressure budget and replay hash', 0, 0, () => stageTelemetry()),
    shot('game-selftest', 'Deterministic match-state-machine self-test report', 0, 0, () => stageSelfTest()),
  ]);
});

/* ------------------------------------------------------------------ shots -- */

function shot(
  name: string, description: string, yawOffset: number, pitchOffset: number,
  setup: () => void | Promise<void>,
) {
  return {
    name,
    description,
    position: [CAM.x, CAM.y, CAM.z] as [number, number, number],
    yaw: CAM_YAW + yawOffset,
    pitch: CAM_PITCH + pitchOffset,
    fov: 78,
    viewModel: false,
    setup,
  };
}

/* ------------------------------------------------------------- staging -- */

function step(ctx: EngineContext, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) ctx.engine.stepFrame(dt);
}

/**
 * Coarse simulation step used to fast-forward a match into a staged state.
 * 1/16 s is the largest delta the fixed-step accumulator can absorb without
 * hitting its 8-step spiral guard, so no simulation time is lost — it just
 * costs a quarter of the rendered frames.
 */
const FF = 1 / 16;
function fastForward(ctx: EngineContext, seconds: number): void {
  step(ctx, Math.round(seconds * 16), FF);
}

/**
 * Freezes the fight and heals the operator before a frame is taken. Without
 * this the last second of incoming fire leaves blood and damage vignette all
 * over the shot, which hides the thing the shot is meant to show.
 */
function settle(frames = 12): void {
  const s = stage;
  if (!s) return;
  const actors = s.match.services.actors as (typeof s.match.services.actors & {
    setFrozen?(on: boolean): void;
  }) | null;
  actors?.setCombatEnabled?.(false);
  actors?.setFrozen?.(true);
  // Put the operator back on their feet: a staged frame should show the system
  // under test, not the death screen from the last second of incoming fire.
  const p = s.match.services.player;
  if (p && !p.alive) p.revive?.();
  if (p?.heal) p.heal(p.maxHealth);
  s.match.lifecycle.reset();
  step(s.ctx, frames);
}

/** Shows/hides the shipping HUD; the two debug-only cards want a clean frame. */
function setShippingHud(on: boolean): void {
  const el = document.getElementById('ui-root');
  if (el) el.style.display = on ? '' : 'none';
}

/** Places the logical player under the shot camera so spawn logic stays sane. */
function anchorPlayer(): void {
  const s = stage;
  if (!s) return;
  const p = s.match.services.player;
  if (!p) return;
  const yaw = THREE.MathUtils.degToRad(CAM_YAW);
  p.spawnAt(new THREE.Vector3(CAM.x, CAM.y - 1.65, CAM.z), yaw);
}

/** Forward/right offsets from the camera anchor, on the ground. */
function place(forward: number, right: number): THREE.Vector3 {
  const yaw = THREE.MathUtils.degToRad(CAM_YAW);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return new THREE.Vector3(
    CAM.x + fx * forward + rx * right,
    0,
    CAM.z + fz * forward + rz * right,
  );
}

interface Placement { a: Archetype; f: number; r: number; }

/**
 * A staged world point. The raw forward/right offset is snapped to the nearest
 * level spawn node when one is close by — the level owns where a soldier can
 * legally stand, and hard-coded offsets end up on rooftops the moment the world
 * module rebuilds the map.
 */
function stagePoint(forward: number, right: number, used?: Set<number>): THREE.Vector3 {
  const s = stage;
  const raw = place(forward, right);
  if (!s) return raw;
  const nodes = s.match.director.graph.nodes;
  let best: THREE.Vector3 | null = null;
  let bestId = -1;
  let bestD = 6 * 6;
  const groundY = CAM.y - 1.7;
  for (const n of nodes) {
    if (used?.has(n.id)) continue;
    // Never snap onto a rooftop or a basement: staged shots are street level.
    if (Math.abs(n.position.y - groundY) > 2.5) continue;
    const d = n.position.distanceToSquared(raw);
    if (d < bestD) { bestD = d; best = n.position; bestId = n.id; }
  }
  if (best) {
    used?.add(bestId);
    raw.copy(best);
  }
  raw.y = s.match.groundAt(raw.x, raw.z, CAM.y - 1.7);
  return raw;
}

function spawnSet(list: Placement[]): number[] {
  const s = stage;
  if (!s) return [];
  const ids: number[] = [];
  const used = new Set<number>();
  for (const p of list) {
    const pos = stagePoint(p.f, p.r, used);
    const yaw = Math.atan2(CAM.x - pos.x, CAM.z - pos.z);
    const id = s.match.director.spawnScripted(p.a, pos, yaw, 'hostile', 'debug');
    if (id >= 0) ids.push(id);
  }
  return ids;
}

const SQUAD_SET: Placement[] = [
  { a: 'shotgun', f: -7, r: -1.9 },
  { a: 'smg', f: -9.5, r: 2.4 },
  { a: 'rifleman', f: -13, r: -3.1 },
  { a: 'rifleman', f: -16, r: 1.2 },
  { a: 'lmg', f: -20, r: -2.6 },
  { a: 'sniper', f: -26, r: 3.2 },
];

function restart(mode: GameModeId, seed = 20260729): void {
  const s = stage;
  if (!s) return;
  s.hud.setMode('hidden');
  setShippingHud(true);
  const actors = s.match.services.actors as (typeof s.match.services.actors & {
    setFrozen?(on: boolean): void;
  }) | null;
  actors?.setFrozen?.(false);
  s.director.startMatch(mode, seed);
  anchorPlayer();
  step(s.ctx, 6);
}

/**
 * Fast-forwards Operation to a given wave, *live*, by zeroing the reinforcement
 * budget and clearing the field each round so the mode's own state machine walks
 * itself through wave → cleared → intermission → wave without a scripted skip.
 */
function stageWave(wave: number): void {
  const s = stage;
  if (!s) return;
  restart('operation');
  const mode = s.match.mode;
  let guard = 0;
  while (guard++ < 700) {
    const atWave = mode.wave >= wave && s.match.phase === 'live';
    if (atWave) break;
    if (s.match.phase === 'live' && mode.wave < wave) {
      s.match.director.budget = 0;
      s.match.director.clear();
      for (const o of s.match.objectives()) {
        if (o.state === 'active') o.progress = 1;
      }
    }
    step(s.ctx, 8, FF);
  }
  s.match.director.clear();
  spawnSet(SQUAD_SET);
  s.match.scoring.addScore(1450, 'Kill');
  step(s.ctx, 14);
  settle();
}

function stageObjective(): void {
  const s = stage;
  if (!s) return;
  stageWave(1);
  const centre = stagePoint(-13, 0);
  const obj = new HoldZoneObjective(centre, 7.5, 30, 'SECURE THE UPLINK');
  s.match.addObjective(obj);
  obj.progress = 0.62;
  s.match.director.clear();
  spawnSet([
    { a: 'rifleman', f: -14, r: -3.4 },
    { a: 'smg', f: -11, r: 2.6 },
    { a: 'shotgun', f: -9, r: -1.2 },
    { a: 'lmg', f: -17, r: 5 },
  ]);
  step(s.ctx, 20);
  settle();
}

function stageBuy(): void {
  const s = stage;
  if (!s) return;
  restart('operation');
  fastForward(s.ctx, 9);
  s.match.director.budget = 0;
  s.match.director.clear();
  s.match.addCash(2400, 'debug');
  fastForward(s.ctx, 5);
  settle(40);
  // The shipping HUD has no buy-phase panel yet, so this is the one combat
  // state the director has to draw itself in order to be verifiable.
  setShippingHud(false);
  s.hud.setMode('full');
  step(s.ctx, 6);
}

function stageUav(): void {
  const s = stage;
  if (!s) return;
  stageWave(2);
  s.match.killstreaks.forceReady('uav');
  s.match.command('activateKillstreak');
  step(s.ctx, 60 * 3);
  settle();
}

function stageSentry(): void {
  const s = stage;
  if (!s) return;
  stageWave(2);
  s.match.director.clear();
  spawnSet([
    { a: 'rifleman', f: -15, r: -3 },
    { a: 'smg', f: -12, r: 4 },
    { a: 'rifleman', f: -19, r: 7 },
  ]);
  // Only the turret shoots for this beat — the point of the shot is the turret.
  s.match.services.actors?.setCombatEnabled?.(false);
  s.match.killstreaks.forceReady('sentry');
  // Deployed a few metres downrange rather than at the camera's feet.
  const pad = place(-5.5, 1.9);
  pad.y = s.match.groundAt(pad.x, pad.z, CAM.y - 1.7);
  s.match.killstreaks.activate(pad, THREE.MathUtils.degToRad(CAM_YAW) + Math.PI);
  step(s.ctx, 90);
  settle(40);
}

function stageAirstrikeMark(): void {
  const s = stage;
  if (!s) return;
  stageWave(2);
  s.match.killstreaks.forceReady('airstrike');
  s.match.command('activateKillstreak');
  s.match.update(1 / 60);
  step(s.ctx, 8);
}

function stageAirstrikeRun(): void {
  const s = stage;
  if (!s) return;
  stageAirstrikeMark();
  // Mark well downrange so the flight is framed against the street rather than
  // straight overhead, and so the blast is not danger-close to the camera.
  const target = place(-125, 4);
  target.y = s.match.groundAt(target.x, target.z, CAM.y - 1.7);
  s.match.killstreaks.markPoint.copy(target);
  s.match.killstreaks.markValid = true;
  s.match.killstreaks.confirmMark();
  // t ≈ 3.30 s: the flight has passed over the player and is between them and
  // the mark, ordnance not yet released — the aircraft are the subject here,
  // the fireball belongs to `src/fx`.
  step(s.ctx, Math.round(60 * 3.30));
}

function stageCarePackage(): void {
  const s = stage;
  if (!s) return;
  stageWave(2);
  s.match.director.clear();
  s.match.killstreaks.forceReady('carepackage');
  s.match.command('activateKillstreak');
  settle(4);
  // 3.4 s run-in plus ~7.5 s of canopy descent: catch it just after touchdown.
  step(s.ctx, Math.round(60 * 12.4));
}

function stageMode(mode: GameModeId, seconds: number): void {
  const s = stage;
  if (!s) return;
  restart(mode);
  fastForward(s.ctx, seconds);
  s.match.director.clear();
  spawnSet(SQUAD_SET);
  step(s.ctx, 14);
  settle();
}

function stageSummary(): void {
  const s = stage;
  if (!s) return;
  restart('operation');
  setShippingHud(false);
  s.hud.setMode('summary');
  fastForward(s.ctx, 9);
  // Bank a believable round before ending it.
  for (let i = 0; i < 34; i++) {
    s.match.scoring.playerKill({
      headshot: i % 4 === 0, distance: 18 + (i % 7) * 6, source: 'player',
      archetype: 'rifleman', score: 100,
    });
  }
  s.match.scoring.assist();
  s.match.director.clear();
  s.match.finish(true);
  settle(24);
}

function stageSelfTest(): void {
  const s = stage;
  if (!s) return;
  s.hud.setSelfTest(s.report);
  setShippingHud(false);
  s.hud.setMode('selftest');
  step(s.ctx, 4);
}

/** Live director numbers for the telemetry card. */
function telemetry(): TelemetrySource {
  const src: TelemetrySource = {
    beat: 'lull', intensity: 0, target: 0, pressure: 0, pressureTarget: 0,
    budget: 0, alive: 0, spawned: 0, threat: 0, nodes: 0, lifecycle: 'alive',
    seed: 0, replayHash: '', logEntries: 0,
  };
  return new Proxy(src, {
    get(_t, key: string) {
      const s = stage;
      if (!s) return src[key as keyof TelemetrySource];
      const d = s.match.director;
      const cfg = d.config;
      switch (key) {
        case 'beat': return d.beat;
        case 'intensity': return d.intensity;
        case 'target': return d.targetIntensity;
        case 'pressure': return d.pressure;
        case 'pressureTarget': return cfg.minPressure + (cfg.maxPressure - cfg.minPressure) * d.intensity;
        case 'budget': return d.remaining;
        case 'alive': return d.aliveCount;
        case 'spawned': return d.spawned;
        case 'threat': return d.threat;
        case 'nodes': return d.graph.nodes.length;
        case 'lifecycle': return s.match.lifecycle.state;
        case 'seed': return s.match.seed;
        case 'replayHash': return s.match.log.hash();
        case 'logEntries': return s.match.log.length;
        default: return src[key as keyof TelemetrySource];
      }
    },
  });
}

function stageTelemetry(): void {
  const s = stage;
  if (!s) return;
  stageWave(3);
  setShippingHud(false);
  s.hud.setMode('telemetry');
  step(s.ctx, 4);
}

/* --------------------------------------------------------------- props -- */

/**
 * A small forward position around the camera anchor: sandbag revetments, crates
 * and a barrier line. Purely so the staged shots have foreground, midground and
 * background layers instead of a bare plane.
 */
function buildProps(ctx: EngineContext): void {
  const mats = ctx.engine.tryGet<MaterialSystem>('materials');
  const group = new THREE.Group();
  group.name = 'game-debug-props';
  ctx.scene.add(group);

  const mat = (surface: SurfaceType, fallback: number): THREE.Material => {
    try {
      const m = mats?.get(surface);
      if (m) return m;
    } catch { /* material system not ready — grey-box it */ }
    return new THREE.MeshStandardMaterial({ color: fallback, roughness: 0.85, metalness: 0.05 });
  };

  const sandbag = mat('sandbag', 0x8a7d5f);
  const crate = mat('crate', 0x7a5a34);
  const concrete = mat('concrete', 0x9a9a95);
  const metal = mat('metal', 0x5a5f63);

  const physics = ctx.engine.tryGet<System & Partial<PhysicsAPI>>('physics');
  const overlaps: OverlapResult[] = [];
  const hit = makeRayHit();
  const down = new THREE.Vector3(0, -1, 0);
  /** Ground height under a prop so nothing floats or sinks on sloped levels. */
  const ground = (p: THREE.Vector3): number => {
    if (!physics?.raycast || physics.ready !== true) return 0;
    _probe.set(p.x, CAM.y + 1.4, p.z);
    const h = physics.raycast(_probe, down, 9, MASK_MOVE, hit);
    return h.hit ? h.point.y : CAM.y - 1.7;
  };
  /** True when the level already occupies this spot — never build inside it. */
  const blocked = (p: THREE.Vector3, r: number): boolean => {
    if (!physics?.overlapSphere || physics.ready !== true) return false;
    _probe.set(p.x, p.y + r * 0.5 + 0.1, p.z);
    return physics.overlapSphere(_probe, r, MASK_MOVE, overlaps, 4) > 0;
  };

  const add = (
    geo: THREE.BufferGeometry, material: THREE.Material,
    pos: THREE.Vector3, ry: number, surface: SurfaceType,
  ) => {
    pos.y += ground(pos);
    if (blocked(pos, 0.55)) return;
    const m = new THREE.Mesh(geo, material);
    m.position.copy(pos);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    tagSurface(m, surface);
    group.add(m);
  };

  /* sandbag revetment: three staggered courses per segment */
  const bagGeo = new THREE.BoxGeometry(0.62, 0.26, 0.36);
  for (const [f, r, rot] of [[-7, -4.2, 0.5], [-9.5, 3.6, -0.35], [-16, -6.5, 1.2]] as Array<[number, number, number]>) {
    const base = place(f, r);
    for (let course = 0; course < 3; course++) {
      const n = 6 - course;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 0.66 + (course % 2 ? 0.16 : 0);
        const p = new THREE.Vector3(
          base.x + Math.cos(rot) * off, 0.13 + course * 0.25, base.z - Math.sin(rot) * off,
        );
        add(bagGeo, sandbag, p, rot + (i * 0.13), 'sandbag');
      }
    }
  }

  /* crates */
  const crateGeo = new THREE.BoxGeometry(0.95, 0.95, 0.95);
  for (const [f, r, y, rot] of [
    [-5.5, 5.2, 0.475, 0.4], [-6.2, 5.9, 1.42, 0.9], [-12, -2.4, 0.475, -0.6],
    [-19, 4.8, 0.475, 1.4], [-13.5, 8.5, 0.475, 0.2],
  ] as Array<[number, number, number, number]>) {
    const p = place(f, r);
    p.y = y;
    add(crateGeo, crate, p, rot, 'crate');
  }

  /* jersey barriers — the classic silhouette breaker */
  const barrier = buildBarrier();
  for (const [f, r, rot] of [[-11, -8.5, 0.9], [-15, 2.2, -0.2], [-24, -3.5, 0.6]] as Array<[number, number, number]>) {
    const p = place(f, r);
    add(barrier, concrete, p, rot, 'concrete');
  }

  /* a couple of oil drums for vertical interest */
  const drum = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 14);
  for (const [f, r] of [[-8.2, 1.2], [-8.9, 1.9], [-17.5, -1.2]] as Array<[number, number]>) {
    const p = place(f, r);
    p.y = 0.44;
    add(drum, metal, p, 0, 'metal');
  }
}

/** Jersey barrier profile, extruded by hand. */
function buildBarrier(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.34, 0);
  shape.lineTo(0.34, 0);
  shape.lineTo(0.20, 0.28);
  shape.lineTo(0.11, 0.9);
  shape.lineTo(-0.11, 0.9);
  shape.lineTo(-0.20, 0.28);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: false, curveSegments: 1 });
  geo.rotateY(Math.PI / 2);
  geo.translate(0, 0, -1.2);
  geo.computeVertexNormals();
  return geo;
}

