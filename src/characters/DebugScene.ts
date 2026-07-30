/**
 * `--debug characters` test bed.
 *
 * Six stations laid out along +Z, each answering one question about the module:
 *
 *   z ≈ 0    squad line-up — do eight seeds read as eight different people?
 *   z ≈ 16   close-up trio — does the kit survive being looked at from 0.7 m?
 *   z ≈ 32   animation states — idle, walk, run, sprint, crouch, prone, cover,
 *            hit reaction, death
 *   z ≈ 48   foot IK — a ramp and a staircase with soldiers standing on them
 *   z ≈ 62   LOD ladder — the same soldier at LOD 0/1/2 side by side
 *   z ≈ 74   hit volumes — the per-bone boxes drawn over a live character
 *
 * Everything is driven by a real `CharacterSystem`, so what the screenshots
 * show is what the game will show.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { registerDebugScene, registerShots, DEBUG_SCENE } from '../core/Shots';
import { settings } from '../core/Settings';
import { Rand } from '../core/Rand';
import type { CharacterFaction, CharacterLoadout } from './types';
import { CharacterSystem } from './CharacterSystem';
import type { Character } from './Character';
import { buildWeaponProp, type PropKind } from './Prop';
import { heightFieldProbe } from './anim/FootIK';
import type { Locomotion } from './anim/Animator';
import { hitboxDebug } from './Hitboxes';

const LINEUP_Z = 0;
const CLOSE_Z = 16;
const STATE_Z = 32;
const IK_Z = 56;
const LOD_Z = 70;
const BOX_Z = 82;

/* ------------------------------------------------------------------ terrain */

const RAMP_X0 = -2.4, RAMP_X1 = 2.6, RAMP_H = 1.15;
const STEP_X0 = 5.0, STEP_W = 0.34, STEP_H = 0.175, STEP_N = 6;

function terrainHeight(x: number, z: number): number {
  if (z < IK_Z - 6 || z > IK_Z + 6) return 0;
  if (x >= RAMP_X0 && x <= RAMP_X1) {
    return ((x - RAMP_X0) / (RAMP_X1 - RAMP_X0)) * RAMP_H;
  }
  if (x > RAMP_X1 && x < STEP_X0) return RAMP_H * Math.max(0, 1 - (x - RAMP_X1) / 0.5);
  if (x >= STEP_X0) {
    const step = Math.min(STEP_N, Math.floor((x - STEP_X0) / STEP_W) + 1);
    return step * STEP_H;
  }
  return 0;
}

/* --------------------------------------------------------------- the scene */

interface Actor {
  character: Character;
  state: Locomotion;
  speed: number;
  strafe: number;
  aimYaw: number;
  aimPitch: number;
  /** Seconds until the scripted action repeats. */
  loop?: () => void;
  loopEvery?: number;
  timer?: number;
}

class CharacterDebugScene {
  readonly root = new THREE.Group();
  readonly actors: Actor[] = [];
  private sys: CharacterSystem;
  private ctx: EngineContext;
  private rand = new Rand('characters-debug');
  private time = 0;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
    const existing = ctx.engine.tryGet<CharacterSystem>('characters');
    if (existing) {
      this.sys = existing;
    } else {
      this.sys = new CharacterSystem();
      ctx.engine.add(this.sys);
      this.sys.init(ctx);
    }
    this.sys.groundProbe = heightFieldProbe(terrainHeight);
    this.sys.autoLOD = false;
  }

  async build(): Promise<void> {
    const { scene, engine } = this.ctx;

    for (const name of ['player', 'weapons', 'ai', 'director', 'hud', 'fx']) {
      const s = engine.tryGet<System>(name);
      if (s) s.enabled = false;
    }
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      const l = c as THREE.Light;
      if (c.name === 'world' || c.name === 'level') scene.remove(c);
      else if (l.isLight && !c.name.startsWith('dyn')) scene.remove(c);
    }
    scene.fog = null;

    const render = engine.tryGet<System & {
      setTimeOfDay(h: number): void; setWeather(r: number, f: number, w: number): void;
    }>('render');
    render?.setTimeOfDay(10.0);
    render?.setWeather(0, 0, 0.2);
    settings.setGfx('motionBlur', false);
    settings.setGfx('dof', false);
    // Screen-space reflections of a *skinned* mesh are unresolvable here: the
    // renderer's velocity buffer treats skinned vertices as static, so TAA
    // cannot converge the ray-marched noise and it shows as colour speckle on
    // the ground. Nothing about character art is judged through SSR, so it is
    // off in this test bed.
    settings.setGfx('ssr', false);
    // Same reason as SSR: screen-space contact shadows are dithered and rely on
    // TAA to resolve, which cannot happen while the subject is skinned-animated.
    settings.setGfx('contactShadows', false);
    // Wide PCSS penumbrae are dithered and resolved by TAA. A skinned mesh
    // reports zero velocity in this renderer's G-buffer, so that history never
    // converges and the contact area fills with colour speckle. Hard PCF and no
    // SSAO keep the test bed honest about the character, not the shadow filter.
    settings.setGfx('pcssSoftness', 0);
    settings.setGfx('ssao', false);

    this.root.name = 'characters-debug';
    scene.add(this.root);

    await this.sys.warm(['pmc', 'militia', 'spetsnaz']);

    this.buildGround();
    this.buildLineup();
    this.buildCloseups();
    this.buildStates();
    this.buildFootIK();
    this.buildLods();
    this.buildHitboxes();

    // Settle: run enough frames for the smoothed IK and blends to reach rest.
    for (let i = 0; i < 40; i++) this.step(1 / 60);
  }

  /* -------------------------------------------------------------- ground */

  private groundMaterial(rough: number, colour: number, id = 'concrete'): THREE.MeshStandardMaterial {
    const mats = this.ctx.engine.tryGet<System & {
      material(id: string, opts: Record<string, unknown>): THREE.MeshStandardMaterial;
    }>('materials');
    if (mats) {
      try {
        return mats.material(id, { triplanar: true, scale: 3 });
      } catch { /* fall through to the flat stand-in */ }
    }
    return new THREE.MeshStandardMaterial({ color: colour, roughness: rough, metalness: 0 });
  }

  private buildGround(): void {
    const mat = this.groundMaterial(0.92, 0x4a4640, 'asphalt');
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = 36;
    ground.receiveShadow = true;
    this.root.add(ground);

    // Ramp.
    const rampLen = RAMP_X1 - RAMP_X0;
    const slope = Math.atan2(RAMP_H, rampLen);
    const ramp = new THREE.Mesh(
      new THREE.BoxGeometry(Math.hypot(rampLen, RAMP_H), 0.24, 11),
      this.groundMaterial(0.9, 0x5f5a55),
    );
    ramp.position.set((RAMP_X0 + RAMP_X1) / 2, RAMP_H / 2 - 0.11 * Math.cos(slope), IK_Z);
    ramp.rotation.z = slope;
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    this.root.add(ramp);

    const plateau = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, RAMP_H, 11),
      this.groundMaterial(0.9, 0x5f5a55),
    );
    plateau.position.set(RAMP_X1 + 0.25, RAMP_H / 2, IK_Z);
    plateau.castShadow = true; plateau.receiveShadow = true;
    this.root.add(plateau);

    // Stairs.
    for (let i = 1; i <= STEP_N; i++) {
      const h = i * STEP_H;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(STEP_W, h, 11),
        this.groundMaterial(0.88, 0x676259),
      );
      step.position.set(STEP_X0 + (i - 0.5) * STEP_W, h / 2, IK_Z);
      step.castShadow = true;
      step.receiveShadow = true;
      this.root.add(step);
    }
  }

  /* -------------------------------------------------------------- actors */

  private spawn(
    x: number, z: number, yaw: number,
    faction: CharacterFaction, loadout: CharacterLoadout, seed: number,
    weapon: PropKind | null = 'rifle', lod = 0,
  ): Actor {
    const c = this.sys.create({ faction, loadout, seed, lod });
    c.object.position.set(x, terrainHeight(x, z), z);
    c.object.rotation.y = yaw;
    this.root.add(c.object);
    if (weapon) {
      const prop = buildWeaponProp(c.rig, this.sys.materials, faction, weapon);
      c.weaponSocket.add(prop);
    } else {
      c.animator.hasWeapon = false;
    }
    const actor: Actor = { character: c, state: 'idle', speed: 0, strafe: 0, aimYaw: 0, aimPitch: 0 };
    this.actors.push(actor);
    return actor;
  }

  private buildLineup(): void {
    const kit: [CharacterFaction, CharacterLoadout, PropKind][] = [
      ['pmc', 'rifleman', 'rifle'],
      ['pmc', 'sniper', 'sniper'],
      ['militia', 'smg', 'smg'],
      ['militia', 'rifleman', 'rifle'],
      ['spetsnaz', 'rifleman', 'rifle'],
      ['spetsnaz', 'lmg', 'lmg'],
      ['pmc', 'shotgun', 'shotgun'],
      ['militia', 'juggernaut', 'lmg'],
    ];
    for (let i = 0; i < kit.length; i++) {
      const [f, l, w] = kit[i];
      const x = (i - (kit.length - 1) / 2) * 1.15;
      const a = this.spawn(x, LINEUP_Z, this.rand.range(-0.16, 0.16), f, l, 1000 + i * 977, w);
      a.aimYaw = this.rand.range(-0.18, 0.18);
      a.aimPitch = this.rand.range(-0.08, 0.05);
      a.character.setLocomotion('idle', 0, 0);
    }
  }

  private buildCloseups(): void {
    const set: [CharacterFaction, CharacterLoadout, number][] = [
      ['pmc', 'rifleman', 4210],
      ['spetsnaz', 'rifleman', 771],
      ['militia', 'smg', 3308],
    ];
    for (let i = 0; i < set.length; i++) {
      const [f, l, seed] = set[i];
      const a = this.spawn(i * 3.0, CLOSE_Z, i === 1 ? -0.42 : 0, f, l, seed, 'rifle');
      a.aimPitch = -0.05;
      a.character.setLocomotion('idle', 0, 0);
    }
  }

  private buildStates(): void {
    const defs: { state: Locomotion; speed: number; strafe: number; label: string }[] = [
      { state: 'idle', speed: 0, strafe: 0, label: 'idle' },
      { state: 'walk', speed: 1.4, strafe: 0, label: 'walk' },
      { state: 'run', speed: 3.4, strafe: 0, label: 'run' },
      { state: 'sprint', speed: 5.8, strafe: 0, label: 'sprint' },
      { state: 'walk', speed: 1.6, strafe: 1, label: 'strafe' },
      { state: 'crouch', speed: 0, strafe: 0, label: 'crouch' },
      { state: 'crouch', speed: 1.1, strafe: 0, label: 'crouch-walk' },
      { state: 'prone', speed: 0, strafe: 0, label: 'prone' },
    ];
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const x = (i - (defs.length - 1) / 2) * 1.9;
      const a = this.spawn(x, STATE_Z, Math.PI * 0.5, 'pmc', 'rifleman', 500 + i * 313, 'rifle');
      a.state = d.state; a.speed = d.speed; a.strafe = d.strafe;
      a.aimYaw = 0.0;
    }

    // A second row: cover, peek, hit reaction, throw, death.
    const acts: { name: string; run: (c: Character) => void; every: number }[] = [
      { name: 'coverHigh', run: (c) => c.play('coverHigh'), every: 0 },
      { name: 'coverLow', run: (c) => c.play('coverLow'), every: 0 },
      { name: 'peekL', run: (c) => { c.play('coverHigh'); c.play('coverPeekL'); }, every: 0 },
      { name: 'hit', run: (c) => c.react(_dirFront, 'chest', 1), every: 1.6 },
      { name: 'throw', run: (c) => c.play('throw'), every: 2.4 },
      { name: 'deathFront', run: (c) => c.play('deathFront'), every: 0 },
      { name: 'deathBack', run: (c) => c.play('deathBack'), every: 0 },
      { name: 'deathHead', run: (c) => c.play('deathHead'), every: 0 },
    ];
    for (let i = 0; i < acts.length; i++) {
      const x = (i - (acts.length - 1) / 2) * 1.9;
      const a = this.spawn(x, STATE_Z + 8, Math.PI * 0.5, 'militia', 'rifleman', 8000 + i * 641, 'rifle');
      a.character.setLocomotion('idle', 0, 0);
      acts[i].run(a.character);
      if (acts[i].every > 0) {
        a.loopEvery = acts[i].every;
        a.timer = acts[i].every;
        a.loop = () => acts[i].run(a.character);
      }
    }
  }

  private buildFootIK(): void {
    // On the ramp, on the stairs, and straddling the step edge.
    this.spawn(-0.6, IK_Z, Math.PI * 0.5, 'pmc', 'rifleman', 61, 'rifle');
    this.spawn(1.6, IK_Z, Math.PI * 0.5, 'pmc', 'rifleman', 62, 'rifle');
    this.spawn(STEP_X0 + STEP_W * 2.1, IK_Z, 0, 'spetsnaz', 'rifleman', 63, 'rifle');
    this.spawn(STEP_X0 + STEP_W * 4.6, IK_Z, 0, 'spetsnaz', 'rifleman', 64, 'rifle');
    for (const a of this.actors.slice(-4)) a.character.setLocomotion('idle', 0, 0);
  }

  private buildLods(): void {
    for (let lod = 0; lod < 3; lod++) {
      const a = this.spawn(lod * 1.5 - 1.5, LOD_Z, 0, 'pmc', 'rifleman', 2024, 'rifle', lod);
      a.character.setLOD(lod);
      a.character.setLocomotion('idle', 0, 0);
    }
  }

  private buildHitboxes(): void {
    const a = this.spawn(0, BOX_Z, 0, 'pmc', 'rifleman', 99, 'rifle');
    a.character.setLocomotion('idle', 0, 0);
    hitboxDebug(a.character.rig, a.character.hitboxes);
  }

  /* --------------------------------------------------------------- frame */

  step(dt: number): void {
    this.time += dt;
    for (const a of this.actors) {
      a.character.setLocomotion(a.state, a.speed, a.strafe);
      a.character.setAim(a.aimYaw, a.aimPitch);
      if (a.loop && a.loopEvery) {
        a.timer = (a.timer ?? 0) - dt;
        if (a.timer <= 0) { a.timer = a.loopEvery; a.loop(); }
      }
      a.character.update(dt);
    }
  }
}

let active: CharacterDebugScene | null = null;
const _dirFront = new THREE.Vector3(0, 0, -1);

registerDebugScene('characters', async (ctx: EngineContext) => {
  const scene = new CharacterDebugScene(ctx);
  active = scene;
  await scene.build();

  // The characters system is registered as an engine system, so the harness's
  // settle frames animate it; this hook only exists for scenes where the
  // system was pre-registered elsewhere and disabled.
  ctx.engine.add({
    name: 'characters-debug-driver',
    order: 470,
    update: (dt: number) => { active?.step(dt); },
  });

  console.info(`[characters] debug scene ready — ${scene.actors.length} soldiers`);
});

/* ------------------------------------------------------------------ shots */

if (DEBUG_SCENE === 'characters') {
  registerShots([
    {
      name: 'char-lineup',
      description: 'Squad line-up: eight procedurally varied soldiers, full body, front lit',
      position: [0, 1.62, 7.6], yaw: 0, pitch: -2, fov: 48, viewModel: false, hour: 10,
    },
    {
      name: 'char-lineup-close',
      description: 'Left half of the squad at 3.5 m — kit silhouette, plate carriers, helmets',
      position: [-2.3, 1.45, 3.6], yaw: 0, pitch: -1, fov: 46, viewModel: false, hour: 10,
    },
    {
      name: 'char-hero',
      description: 'Hero three-quarter shot of one soldier, late afternoon key light',
      position: [-3.0, 1.50, 1.9], yaw: 28, pitch: -2, fov: 40, viewModel: false, hour: 16,
    },
    {
      name: 'char-head',
      description: 'Head close-up: helmet, NVG mount, goggles, balaclava, comms headset',
      position: [0.0, 1.625, 16.88], yaw: 0, pitch: 0, fov: 25, viewModel: false, hour: 10,
    },
    {
      name: 'char-head-3q',
      description: 'Three-quarter head close-up of a second soldier — face shaping and kit fit',
      position: [3.86, 1.605, 16.76], yaw: 48, pitch: 0, fov: 28, viewModel: false, hour: 15,
    },
    {
      name: 'char-torso',
      description: 'Torso close-up: plate carrier, magazine pouches, webbing, sling, cloth folds',
      position: [0.0, 1.24, 17.05], yaw: 0, pitch: 2, fov: 36, viewModel: false, hour: 10,
    },
    {
      name: 'char-legs',
      description: 'Lower body close-up: trousers, blousing, knee pads, boots',
      position: [0.0, 0.60, 17.1], yaw: 0, pitch: 4, fov: 42, viewModel: false, hour: 10,
    },
    {
      name: 'char-states',
      description: 'Locomotion states: idle, walk, run, sprint, strafe, crouch, crouch-walk, prone',
      position: [0, 1.9, STATE_Z - 9.0], yaw: 180, pitch: -3, fov: 52, viewModel: false, hour: 11,
    },
    {
      name: 'char-actions',
      description: 'Cover poses, peek, hit reaction, grenade throw and three directional deaths',
      position: [0, 1.9, STATE_Z + 8 + 9.5], yaw: 0, pitch: -3, fov: 52, viewModel: false, hour: 11,
    },
    {
      name: 'char-footik',
      description: 'Foot IK: soldiers standing on a ramp and a staircase, feet planted on the surface',
      position: [3.0, 1.85, IK_Z + 6.2], yaw: 2, pitch: -8, fov: 54, viewModel: false, hour: 9,
    },
    {
      name: 'char-footik-close',
      description: 'Close view of boots on stair treads — ankle roll and hip adjustment',
      position: [6.1, 1.15, IK_Z + 2.6], yaw: 0, pitch: -16, fov: 40, viewModel: false, hour: 9,
    },
    {
      name: 'char-lod',
      description: 'LOD ladder: the same soldier at LOD 0, 1 and 2',
      position: [0, 1.55, LOD_Z + 5.0], yaw: 0, pitch: -2, fov: 44, viewModel: false, hour: 12,
    },
    {
      name: 'char-hitboxes',
      description: 'Per-bone hit volumes drawn over a live character',
      position: [0, 1.30, BOX_Z + 3.6], yaw: 0, pitch: -3, fov: 44, viewModel: false, hour: 12,
    },
  ]);
}
