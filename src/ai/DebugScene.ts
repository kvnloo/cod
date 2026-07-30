/**
 * `--debug ai` test bed.
 *
 * A small arena with real cover — low walls, crates, containers, pillars — a
 * static player stand-in on one side and a squad on the other. Everything the
 * module claims to do is exercised here and can be judged from a still frame:
 *
 *   • perception filling as the stand-in comes into view, drawn as a meter
 *   • paths, chosen cover, and the protection test for the current threat
 *   • the peek cycle: men behind cover leaning out, firing, dropping back
 *   • bounding advance: one man moving while the others shoot
 *   • grenade arc prediction
 *   • navigation grid coverage
 *
 * The simulation is stepped explicitly and deterministically inside each shot's
 * `setup()`, so every screenshot is reproducible frame for frame.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { registerDebugScene, registerShots } from '../core/Shots';
import { Rand } from '../core/Rand';
import { bus } from '../core/EventBus';
import { tagSurface } from '../core/Surfaces';
import type { PhysicsAPI } from '../physics/types';
import type { AISystem } from './AI';
import type { TargetLike } from './types';
import type { ShotDef } from '../core/CaptureAPI';

const SIM_DT = 1 / 120;

const _o = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * The physics module's system surface, as far as this test bed needs it. Typed
 * structurally so the scene keeps compiling if the backend is mid-rewrite.
 */
interface PhysicsDriver extends PhysicsAPI {
  fixedUpdate?(dt: number, ctx: EngineContext): void;
  update?(dt: number, ctx: EngineContext): void;
  rebuildStatic?(root?: THREE.Object3D | null): unknown;
}

/** A stationary player stand-in the squad can perceive, path to and shoot at. */
class Stand implements TargetLike {
  readonly entityId = 1;
  readonly isPlayer = false;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  alive = true;
  eyeOffset = 0.74;
  height = 1.8;
  radius = 0.4;
  crouch = 0;
  firedAt = -1e9;
  readonly facing = new THREE.Vector3(0, 0, -1);

  readonly mesh: THREE.Mesh;
  constructor(position: THREE.Vector3) {
    this.position.copy(position);
    this.position.y += this.height * 0.5;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2f7fd8, roughness: 0.42, metalness: 0.05,
      emissive: 0x123a63, emissiveIntensity: 0.5,
    });
    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(this.radius, this.height - this.radius * 2, 8, 18), mat,
    );
    this.mesh.position.copy(this.position);
    this.mesh.castShadow = true;
    this.mesh.userData.noCollide = true;
  }

  /** Reveal or hide the stand-in from behind its wall. */
  setHidden(hidden: boolean, cover: THREE.Vector3): void {
    if (hidden) this.position.set(cover.x, this.position.y, cover.z);
    this.mesh.position.copy(this.position);
  }
}

class AIDebugScene {
  readonly root = new THREE.Group();
  private ctx: EngineContext;
  private ai: AISystem;
  private physics: PhysicsDriver | null;
  private rand = new Rand('ai-debug');
  private stand!: Stand;
  private palette = new Map<string, THREE.MeshStandardMaterial>();
  private spawnPoint = new THREE.Vector3(0, 0, -15);
  private squadSize = 5;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
    this.ai = ctx.engine.get<AISystem>('ai');
    this.physics = (ctx.engine.tryGet('physics') as unknown as PhysicsDriver | undefined) ?? null;
  }

  /* ------------------------------------------------------------------ build */

  build(): void {
    const { scene } = this.ctx;

    // The debug scene owns the world: park the systems that would fight us for
    // the camera or spawn their own content.
    for (const name of ['player', 'weapons', 'director']) {
      const sys = this.ctx.engine.tryGet<System>(name);
      if (sys) sys.enabled = false;
    }

    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      if (c === this.ai.gizmos.root) continue;
      const light = c as THREE.Light;
      if (c.name === 'world' || c.name === 'level') scene.remove(c);
      else if (light.isLight && !c.name.startsWith('dyn')) scene.remove(c);
    }

    this.root.name = 'ai-debug';
    scene.add(this.root);

    this.buildEnvironment();
    this.buildGround();
    this.buildCoverField();

    this.physics?.rebuildStatic?.(scene);

    // Stand-in, then navigation (which samples the geometry we just made).
    this.stand = new Stand(new THREE.Vector3(0, 0, 15));
    this.root.add(this.stand.mesh);
    this.ai.setTarget(this.stand);
    this.ai.debugGizmos = true;

    // Force the sampled fallback grid: the world module's level (and any
    // navmesh it built for it) has just been removed from the scene.
    this.ai.buildNavigation(new THREE.Box3(
      new THREE.Vector3(-19, -1, -22),
      new THREE.Vector3(19, 8, 22),
    ), true);

    this.spawnSquad();
  }

  private material(key: string, color: number, roughness = 0.9, metalness = 0): THREE.MeshStandardMaterial {
    let m = this.palette.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
      this.palette.set(key, m);
    }
    return m;
  }

  private buildEnvironment(): void {
    // Key light from the camera side so lit faces and cast shadows both read.
    const sun = new THREE.DirectionalLight(0xffeacc, 3.6);
    sun.position.set(16, 26, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 110;
    const c = sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -30; c.right = 30; c.top = 30; c.bottom = -30;
    c.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.root.add(sun);
    this.root.add(sun.target);
    sun.target.position.set(0, 0.5, 0);

    this.root.add(new THREE.HemisphereLight(0xa8c8ea, 0x4a453d, 1.7));
    const rim = new THREE.DirectionalLight(0x86b6ff, 1.1);
    rim.position.set(-16, 11, -18);
    this.root.add(rim);
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 48),
      this.material('ground', 0x7b776e, 0.95),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    tagSurface(ground, 'concrete');
    this.root.add(ground);

    // Perimeter so agents cannot wander out of the arena.
    const wallMat = this.material('perimeter', 0x7c776e, 0.92);
    const spans: Array<[number, number, number, number]> = [
      [0, -22, 38, 0.8], [0, 22, 38, 0.8], [-18.5, 0, 0.8, 44], [18.5, 0, 0.8, 44],
    ];
    for (const [x, z, w, d] of spans) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 3.2, d), wallMat);
      wall.position.set(x, 1.6, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      tagSurface(wall, 'concrete');
      this.root.add(wall);
    }
  }

  /**
   * The cover field. Deliberately asymmetric: a couple of strong flanking lanes,
   * a central hard block that forces a choice, and low walls near the stand-in
   * so the approach has staged cover rather than one open run.
   */
  private buildCoverField(): void {
    const crate = this.material('crate', 0x9a7a48, 0.85);
    const concrete = this.material('block', 0x8e8a80, 0.93);
    const metal = this.material('metal', 0x55606a, 0.5, 0.35);
    const sandbag = this.material('sandbag', 0x7d7358, 0.98);

    const box = (
      x: number, y: number, z: number, w: number, h: number, d: number,
      mat: THREE.MeshStandardMaterial, surface: 'crate' | 'concrete' | 'metal' | 'sandbag',
      yaw = 0,
    ): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y + h * 0.5, z);
      m.rotation.y = yaw;
      m.castShadow = true;
      m.receiveShadow = true;
      tagSurface(m, surface);
      this.root.add(m);
    };

    // --- staged low walls across the middle -----------------------------
    box(-7.5, 0, 4.0, 6.4, 1.15, 0.6, concrete, 'concrete');
    box(6.0, 0, 4.0, 5.2, 1.15, 0.6, concrete, 'concrete', 0.08);
    box(-2.0, 0, 8.5, 4.6, 1.05, 0.55, sandbag, 'sandbag', -0.12);

    // --- central hard block ---------------------------------------------
    box(0.5, 0, 0.0, 4.0, 2.9, 3.2, concrete, 'concrete', 0.16);
    box(-4.6, 0, -1.2, 1.0, 2.6, 1.0, concrete, 'concrete');
    box(5.4, 0, -1.6, 1.0, 2.6, 1.0, concrete, 'concrete');

    // --- containers forming flank lanes ---------------------------------
    box(-12.5, 0, -3.0, 2.6, 2.6, 8.4, metal, 'metal', 0.05);
    box(12.0, 0, -2.0, 2.6, 2.6, 7.0, metal, 'metal', -0.07);
    box(-13.5, 0, 8.5, 2.6, 2.6, 5.0, metal, 'metal', 0.22);

    // --- crate clusters --------------------------------------------------
    const rand = this.rand;
    const clusters: Array<[number, number, number]> = [
      [-8.5, -7.5, 4], [7.5, -8.0, 4], [-3.0, -11.5, 3], [10.5, 6.5, 3], [-10.5, 11.0, 3],
    ];
    for (const [cx, cz, n] of clusters) {
      for (let i = 0; i < n; i++) {
        const s = 0.85 + rand.next() * 0.35;
        const x = cx + rand.signed() * 1.5;
        const z = cz + rand.signed() * 1.5;
        const stack = i === 0 && rand.bool(0.4) ? s : 0;
        box(x, 0, z, s, s, s, crate, 'crate', rand.signed() * 0.6);
        if (stack > 0) box(x, s, z, s * 0.9, s * 0.9, s * 0.9, crate, 'crate', rand.signed() * 0.6);
      }
    }

    // --- cover right by the stand-in, so it is a real position to attack --
    box(0.0, 0, 12.8, 5.0, 1.2, 0.6, sandbag, 'sandbag');
    box(-4.0, 0, 16.0, 0.9, 2.4, 0.9, concrete, 'concrete');
    box(4.2, 0, 16.4, 0.9, 2.4, 0.9, concrete, 'concrete');
  }

  /**
   * Five men spread across the width of the arena. Spread matters: the central
   * block casts a sight shadow, so some of the squad can see the target from the
   * start and some cannot — which is exactly the asymmetry the perception and
   * information-sharing code exists to handle.
   */
  private spawnSquad(): void {
    this.ai.clear();
    this.ai.difficulty = 'hardened';
    const line: Array<[number, number, 'rifleman' | 'smg' | 'lmg' | 'shotgun']> = [
      [-9.5, -15.5, 'rifleman'],
      [-4.5, -16.5, 'smg'],
      [0.0, -17.5, 'lmg'],
      [5.0, -16.5, 'rifleman'],
      [9.5, -15.5, 'shotgun'],
    ];
    let squadId: number | undefined;
    for (let i = 0; i < line.length; i++) {
      const [x, z, loadout] = line[i];
      const a = this.ai.spawn({
        position: new THREE.Vector3(x, 0, z),
        yaw: 0,
        loadout,
        faction: 'militia',
        difficulty: 'hardened',
        seed: 0xa17e + i * 977,
        squadId,
      });
      squadId = a.squad?.id;
      a.bodyYaw = 0;
      a.spawnYaw = 0;
    }
    this.fireClock = 0;
    this.shooterRand = new Rand('stand-shooter');
  }

  private fireClock = 0;
  private shooterRand = new Rand('stand-shooter');

  /* --------------------------------------------------------------- driving */

  /** Steps physics + AI deterministically. */
  simulate(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.physics?.fixedUpdate?.(SIM_DT, this.ctx);
      this.ai.fixedUpdate(SIM_DT, this.ctx);
    }
    this.present();
  }

  present(): void {
    this.physics?.update?.(SIM_DT, this.ctx);
    this.ai.update(SIM_DT, this.ctx);
  }

  /** Full reset: respawn the squad and put the stand-in back. */
  reset(): void {
    this.spawnSquad();
    this.stand.alive = true;
    this.stand.position.set(0, this.stand.height * 0.5, 15);
    this.stand.mesh.position.copy(this.stand.position);
    this.stand.mesh.visible = true;
    this.simulate(4);
  }

  /**
   * The stand-in shoots back.
   *
   * Without this the test bed is a squad walking at a mannequin; with it, it is
   * a firefight — the AI hears the shots, gets suppressed, takes casualties,
   * reorganises and ragdolls. It is also the only way to exercise the hearing
   * model, since a silent target only ever produces visual contacts.
   */
  standFires(): void {
    this.stand.firedAt = this.ai.now;
    _o.copy(this.stand.position);
    _o.y += 0.6;
    this.ai.emitSound({
      position: _o.clone(), loudness: 150, kind: 'gunfire', fromTarget: true, sourceId: 1,
    });

    // Pick the most exposed agent and put rounds on or near him.
    let best: ReturnType<AISystem['byId']> = null;
    let bestScore = -Infinity;
    for (const a of this.ai.agents) {
      if (!a.alive) continue;
      const visible = this.physics
        ? this.physics.lineOfSight(_o, _t.copy(a.position).setY(a.position.y + 0.2))
        : true;
      const score = (visible ? 10 : 0) - a.position.distanceTo(_o) * 0.05;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (!best) return;
    const visible = bestScore > 5;

    // Rounds land near him whether or not they connect: suppression is the
    // point, and a hit every few bursts keeps the squad losing men.
    _t.copy(best.position);
    _t.x += this.shooterRand.signed() * 1.1;
    _t.z += this.shooterRand.signed() * 1.1;
    _t.y = best.position.y - 0.8;
    bus.emit('bullet:impact', {
      point: _t.clone(), normal: new THREE.Vector3(0, 1, 0),
      surface: 'concrete', incoming: _t.clone().sub(_o).normalize(),
      energy: 400, penetrated: false,
    });
    if (visible && this.shooterRand.next() < 0.42) {
      _d.copy(_o).sub(best.position).normalize();
      best.applyDamage(26, _d, this.shooterRand.next() < 0.16 ? 'head' : 'chest', true, _t);
    }
  }

  /**
   * Steps the fight: the sim plus the stand-in firing on a human-ish cadence.
   * Every shot in this scene is produced by this one deterministic driver.
   */
  drive(ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      this.physics?.fixedUpdate?.(SIM_DT, this.ctx);
      this.ai.fixedUpdate(SIM_DT, this.ctx);
      this.fireClock -= SIM_DT;
      if (this.fireClock <= 0) {
        this.fireClock = 0.45 + this.shooterRand.next() * 1.1;
        this.standFires();
      }
    }
    this.present();
  }

  /**
   * Points the camera at whatever the squad is actually doing.
   *
   * Hand-placed cameras go stale the moment the behaviour changes — the fight
   * moves, and the shot ends up looking at an empty crate. Framing on the live
   * centroid keeps every screenshot pointed at the thing it is documenting.
   */
  frame(dirX: number, dirZ: number, distance: number, height: number, lookHeight = 1.2): void {
    _o.set(0, 0, 0);
    let n = 0;
    for (const a of this.ai.agents) {
      if (!a.alive) continue;
      _o.add(a.position);
      n++;
    }
    if (n === 0) return;
    _o.multiplyScalar(1 / n);
    const len = Math.hypot(dirX, dirZ) || 1;
    const cam = this.ctx.camera;
    cam.position.set(
      _o.x + (dirX / len) * distance,
      _o.y - 0.9 + height,
      _o.z + (dirZ / len) * distance,
    );
    _t.set(_o.x, _o.y - 0.9 + lookHeight, _o.z);
    const dx = _t.x - cam.position.x;
    const dy = _t.y - cam.position.y;
    const dz = _t.z - cam.position.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(Math.asin(dy / l), Math.atan2(-dx, -dz), 0);
    cam.updateMatrixWorld(true);
  }

  /** Straight down over the middle of the fight. */
  frameTop(height: number): void {
    this.frame(0.001, 0.02, 0.05, height, 0);
  }

  /**
   * Forces the man closest to the target to solve and throw, so the predicted
   * arc is guaranteed to be on camera. The solve is the real one — same solver,
   * same geometry, same verification — it just is not left to chance.
   */
  previewGrenade(): boolean {
    let best: ReturnType<AISystem['byId']> = null;
    let bestD = Infinity;
    for (const a of this.ai.agents) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(this.stand.position);
      if (d < bestD) { bestD = d; best = a; }
    }
    if (!best) return false;
    _o.copy(best.eye).addScaledVector(best.forward, 0.35);
    _t.copy(this.stand.position);
    _t.y = 0.35;
    const sol = this.ai.grenades.solve(_o, _t, true);
    if (!sol.ok) return false;
    this.ai.grenades.throwAt(best.id, best.squad?.id ?? -1, _o, sol.velocity, this.shooterRand);
    best.character?.play('throw');
    return true;
  }

  setGizmos(on: boolean, navGrid = false): void {
    this.ai.debugGizmos = on;
    this.ai.showNavGrid = navGrid;
    this.ai.gizmos.visible = on;
  }

  get target(): Stand { return this.stand; }
  get system(): AISystem { return this.ai; }
}

/* --------------------------------------------------------------- registration */

let active: AIDebugScene | null = null;

registerDebugScene('ai', (ctx: EngineContext) => {
  const scene = new AIDebugScene(ctx);
  active = scene;
  scene.build();

  // A tiny presentation system keeps the rigs and gizmos in step with the
  // harness's settle frames.
  ctx.engine.add({
    name: 'ai-debug-sync',
    order: 660,
    update: () => { /* AISystem.update already runs; nothing extra needed */ },
  });

  (globalThis as unknown as { __AI_DEBUG__?: unknown }).__AI_DEBUG__ = {
    snapshot: () => scene.system.snapshot(),
    step: (n: number) => scene.simulate(n),
    reset: () => scene.reset(),
  };

  registerShots([
    view(
      'ai-overview',
      'Wide view of the AI test bed: a five-man squad fighting its way toward a stationary target through staged cover. Cyan bead trails are the paths they chose, green/red markers are cover scored against the current threat direction, and the bars over each man are his awareness and suppression meters',
      [23, 15, -22], [-0.5, 1, -1], 56,
      () => { scene.reset(); scene.setGizmos(true); scene.drive(900); },
    ),
    view(
      'ai-perception',
      'Perception, six tenths of a second after the first shot: the men with a clear line past the central block have nearly filled their awareness meters (red), the ones in its sight shadow are only part-filled (amber) from hearing the round go off',
      [-16.0, 6.0, -21.0], [0.5, 1.4, -15.5], 52,
      () => { scene.reset(); scene.setGizmos(true); scene.drive(72); scene.frame(-0.5, -0.9, 13.5, 5.2); },
    ),
    view(
      'ai-cover',
      'Cover usage: agents settled behind low walls and crates, leaning out of cover to fire and dropping back. Green markers are cover that currently blocks the threat, red are exposed to it, amber are claimed by a squadmate',
      [-14.5, 5.2, -5.0], [-1, 1.1, 1.5], 52,
      () => { scene.reset(); scene.setGizmos(true); scene.drive(1000); scene.frame(-0.85, -0.3, 11.5, 4.4); },
    ),
    view(
      'ai-squad',
      'Bounding advance: one man holds the squad move token and crosses open ground while the rest put fire on the target from cover',
      [15.5, 7.5, -12], [-1, 1.2, 1], 56,
      () => { scene.reset(); scene.setGizmos(true); scene.drive(1800); scene.frame(0.8, -0.5, 13, 5.6); },
    ),
    view(
      'ai-paths',
      'Navigation from above: smoothed A* paths (cyan) routed around the central block and the container lanes, goal rings where each man is headed, and the whole harvested cover-point field',
      [0, 32, -2], [0, 0, -1.2], 68,
      () => { scene.reset(); scene.setGizmos(true, true); scene.drive(500); scene.frameTop(27); },
    ),
    view(
      'ai-firefight',
      'Late firefight with the gizmos off — the presentation the player actually sees: soldiers crouched behind cover with weapons up, one man moving, casualties ragdolled where they fell',
      [7.5, 3.4, 9.5], [-2, 1.3, 0.0], 54,
      () => { scene.reset(); scene.setGizmos(false); scene.drive(2400); scene.frame(0.3, 0.92, 9.5, 2.8, 1.4); },
    ),
    view(
      'ai-grenade',
      'Grenade arc prediction: the yellow bead trail is the trajectory the thrower solved and verified against real geometry before committing to the throw',
      [15.0, 6.5, 3.0], [-1, 2.0, 6.0], 56,
      () => {
        scene.reset();
        scene.setGizmos(true);
        scene.drive(2400);
        scene.previewGrenade();
        scene.drive(55);
        scene.frame(0.85, 0.4, 15, 6.5, 2.6);
      },
    ),
  ]);
});

/**
 * Builds a shot from a camera position and a look-at point. Hand-authoring
 * yaw/pitch degrees is how you end up with a screenshot of the sky.
 */
function view(
  name: string, description: string,
  position: [number, number, number], lookAt: [number, number, number],
  fov: number, setup: () => void,
): ShotDef {
  const dx = lookAt[0] - position[0];
  const dy = lookAt[1] - position[1];
  const dz = lookAt[2] - position[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  return {
    name, description, position,
    yaw: THREE.MathUtils.radToDeg(Math.atan2(-dx, -dz)),
    pitch: THREE.MathUtils.radToDeg(Math.asin(dy / len)),
    fov, hour: 11, viewModel: false, setup,
  };
}

/** Exposed for scripted verification from the capture harness. */
export function aiDebugScene(): unknown { return active; }
