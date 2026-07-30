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
import type { HitZone } from '../physics/types';
import type { AnimName, CharacterFaction, CharacterLoadout } from './types';
import { CharacterSystem } from './CharacterSystem';
import type { Character } from './Character';
import { buildWeaponProp, type PropKind } from './Prop';
import { heightFieldProbe } from './anim/FootIK';
import type { Locomotion } from './anim/Animator';
import { hitboxDebug } from './Hitboxes';
import { makeAppearance, type Appearance } from './Appearance';

const LINEUP_Z = 0;
const CLOSE_Z = 16;
const STATE_Z = 32;
const IK_Z = 56;
const LOD_Z = 70;
const BOX_Z = 82;
/** Skinning check: one man, several poses, held still. */
const POSE_Z = 94;
/** Impact check: hit reactions and deaths frozen mid-motion. */
const IMPACT_Z = 106;

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
  /**
   * Held still after the scene settles. A hit reaction that has finished
   * playing tells you nothing about whether it looks like an impact; the frames
   * that matter are 100–350 ms in, so those actors are advanced to a chosen
   * phase during `build()` and then frozen there.
   */
  frozen?: boolean;
}

interface FrozenScript {
  actor: Actor;
  /** Kicks the action off. */
  fire: () => void;
  /** Seconds of animation to run before the actor is held. */
  hold: number;
  /** Runs once the hold has elapsed — the ragdoll handoff uses this. */
  after?: () => void;
}

class CharacterDebugScene {
  readonly root = new THREE.Group();
  readonly actors: Actor[] = [];
  private frozen: FrozenScript[] = [];
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
    // A narrow PCSS kernel is worth the residual dither: with hard PCF, every
    // shadow the kit casts on the body is a stair-stepped edge, which is the
    // opposite of the thing these shots exist to judge. SSAO stays on so the
    // test bed matches what the game actually renders.
    settings.setGfx('pcssSoftness', 0.35);
    settings.setGfx('ssao', true);

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
    this.buildPoseSheet();
    this.buildImpacts();

    // Settle: run enough frames for the smoothed IK and blends to reach rest.
    for (let i = 0; i < 40; i++) this.step(1 / 60);

    // Then drive the frozen actors to the phase each was asked for and stop.
    this.runFrozen();
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
    // A bright sand plane filling two thirds of every frame drags auto-exposure
    // down by two stops and leaves the subject in mud. The test bed uses dark
    // asphalt so the character is what the image is exposed for.
    const mat = this.groundMaterial(0.92, 0x4a4640, 'asphalt');
    mat.color.setRGB(0.26, 0.255, 0.245);
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

  /** First seed in `[from, from + 4000)` whose appearance satisfies `want`. */
  private findSeed(
    faction: CharacterFaction, loadout: CharacterLoadout,
    want: (a: Appearance) => boolean, from: number,
  ): number {
    for (let s = from; s < from + 4000; s++) {
      if (want(makeAppearance({ faction, loadout, seed: s }))) return s;
    }
    return from;
  }

  private buildCloseups(): void {
    // This is the station where faces are judged, so one of the three has to
    // *have* one. Leaving it to the dice gave three balaclavas and a review
    // that said "the faces are black holes" — which they were, because there
    // were no faces. Seeds are searched for the combination each slot needs.
    const want: {
      faction: CharacterFaction; loadout: CharacterLoadout; from: number;
      pick: (a: Appearance) => boolean;
    }[] = [
      {
        faction: 'pmc', loadout: 'rifleman', from: 4000,
        pick: (a) => a.faceGear === 'none' && a.headGear === 'helmet'
          && a.eyeGear === 'goggles' && a.carrier === 'plate',
      },
      {
        faction: 'spetsnaz', loadout: 'rifleman', from: 700,
        pick: (a) => a.faceGear === 'balaclava' && a.headGear === 'helmet' && a.nvg,
      },
      {
        faction: 'militia', loadout: 'smg', from: 3000,
        pick: (a) => a.faceGear === 'shemagh' && a.headGear !== 'none',
      },
    ];
    for (let i = 0; i < want.length; i++) {
      const w = want[i];
      const seed = this.findSeed(w.faction, w.loadout, w.pick, w.from);
      // Turned into the key. A portrait lit from dead front by a 55° sun puts
      // the entire face inside the helmet brim's shadow; a three-quarter key
      // is what every character render in the reference actually uses.
      const a = this.spawn(i * 3.0, CLOSE_Z, -1.10 + i * 0.12, w.faction, w.loadout, seed, 'rifle');
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

  /* ---------------------------------------------------------- pose sheet */

  /**
   * The same soldier in the poses that break naive skinning: full waist twist,
   * arm across the body, arm overhead, a deep crouch and prone. Anything that
   * collapses a shoulder or candy-wraps a wrist shows here and nowhere else.
   */
  private buildPoseSheet(): void {
    const poses: {
      label: string; state: Locomotion; speed: number; strafe: number;
      yaw: number; pitch: number; act?: AnimName; hold?: number;
    }[] = [
      { label: 'twist-left', state: 'idle', speed: 0, strafe: 0, yaw: 0.95, pitch: 0.10 },
      { label: 'twist-right', state: 'idle', speed: 0, strafe: 0, yaw: -0.95, pitch: -0.10 },
      { label: 'aim-up', state: 'idle', speed: 0, strafe: 0, yaw: 0, pitch: 0.62 },
      { label: 'aim-down', state: 'idle', speed: 0, strafe: 0, yaw: 0, pitch: -0.70 },
      { label: 'throw', state: 'idle', speed: 0, strafe: 0, yaw: 0.1, pitch: 0.2, act: 'throw', hold: 0.42 },
      { label: 'sprint', state: 'sprint', speed: 5.8, strafe: 0, yaw: 0, pitch: 0 },
      { label: 'crouch', state: 'crouch', speed: 0, strafe: 0, yaw: -0.4, pitch: -0.2 },
      { label: 'prone', state: 'prone', speed: 0, strafe: 0, yaw: 0, pitch: 0 },
    ];
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      const x = (i - (poses.length - 1) / 2) * 1.55;
      const a = this.spawn(x, POSE_Z, 0, 'pmc', 'rifleman', 3141, 'rifle');
      a.state = p.state; a.speed = p.speed; a.strafe = p.strafe;
      a.aimYaw = p.yaw; a.aimPitch = p.pitch;
      if (p.act) {
        a.frozen = true;
        this.frozen.push({ actor: a, fire: () => a.character.play(p.act as AnimName), hold: p.hold ?? 0.4 });
      } else if (p.state === 'sprint') {
        // A stride is only readable at a chosen phase; freeze at full extension.
        a.frozen = true;
        this.frozen.push({ actor: a, fire: () => { /* locomotion only */ }, hold: 0.33 });
      }
    }
  }

  /* ------------------------------------------------------------- impacts */

  /**
   * Hit reactions and deaths, each held at the frame that decides whether they
   * read as an impact or as a clip playing: the flinch at 90–200 ms, the
   * collapse at 250–600 ms, and one man handed off to the ragdoll.
   */
  private buildImpacts(): void {
    const shots: { dir: THREE.Vector3; zone: HitZone; power: number; hold: number }[] = [
      { dir: new THREE.Vector3(0, 0, -1), zone: 'chest', power: 1.0, hold: 0.09 },
      { dir: new THREE.Vector3(0, 0, -1), zone: 'stomach', power: 1.0, hold: 0.20 },
      { dir: new THREE.Vector3(-1, 0, -0.3), zone: 'arm', power: 0.9, hold: 0.13 },
      { dir: new THREE.Vector3(1, 0, 0.4), zone: 'head', power: 1.0, hold: 0.11 },
    ];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const x = (i - 3.5) * 1.7;
      const a = this.spawn(x, IMPACT_Z, 0, 'spetsnaz', 'rifleman', 4400 + i * 97, 'rifle');
      a.character.setLocomotion('idle', 0, 0);
      a.frozen = true;
      const dir = s.dir.clone().normalize();
      this.frozen.push({
        actor: a, hold: s.hold,
        fire: () => a.character.react(dir, s.zone, s.power),
      });
    }

    const deaths: { anim: AnimName; hold: number; ragdoll: boolean }[] = [
      { anim: 'deathFront', hold: 0.22, ragdoll: false },
      { anim: 'deathBack', hold: 0.40, ragdoll: false },
      { anim: 'deathHead', hold: 0.14, ragdoll: false },
      { anim: 'deathBack', hold: 0.30, ragdoll: true },
    ];
    for (let i = 0; i < deaths.length; i++) {
      const d = deaths[i];
      const x = (i + 0.5) * 1.7;
      const a = this.spawn(x, IMPACT_Z, 0, 'militia', 'rifleman', 7700 + i * 131, 'rifle');
      a.character.setLocomotion('idle', 0, 0);
      a.frozen = true;
      this.frozen.push({
        actor: a, hold: d.hold,
        fire: () => a.character.play(d.anim),
        after: d.ragdoll
          ? () => a.character.ragdoll(new THREE.Vector3(0, 1.5, 6.5), 'chest')
          : undefined,
      });
    }
  }

  /** Fires each frozen script and advances only that actor to its hold time. */
  private runFrozen(): void {
    const dt = 1 / 120;
    for (const f of this.frozen) {
      f.fire();
      const steps = Math.max(1, Math.round(f.hold / dt));
      for (let i = 0; i < steps; i++) {
        f.actor.character.setLocomotion(f.actor.state, f.actor.speed, f.actor.strafe);
        f.actor.character.setAim(f.actor.aimYaw, f.actor.aimPitch);
        f.actor.character.update(dt);
      }
      f.after?.();
      // The character system updates every character it owns each frame, so
      // "stop calling update" is not enough to hold a pose — the graph itself
      // has to be pinned.
      f.actor.character.animator.paused = true;
    }
  }

  /* --------------------------------------------------------------- frame */

  step(dt: number): void {
    this.time += dt;
    for (const a of this.actors) {
      if (a.frozen) continue;
      a.character.setLocomotion(a.state, a.speed, a.strafe);
      a.character.setAim(a.aimYaw, a.aimPitch);
      if (a.loop && a.loopEvery) {
        a.timer = (a.timer ?? 0) - dt;
        if (a.timer <= 0) { a.timer = a.loopEvery; a.loop(); }
      }
      // `CharacterSystem.update` advances every character it owns; stepping
      // them again here would run the whole test bed at double speed.
    }
  }
}

let active: CharacterDebugScene | null = null;
const _dirFront = new THREE.Vector3(0, 0, -1);

registerDebugScene('characters', async (ctx: EngineContext) => {
  const scene = new CharacterDebugScene(ctx);
  active = scene;
  await scene.build();

  // A handle for the art-tuning probe in `dev/`: it reads the baked vertex
  // tints straight off the geometry so albedo work can be checked numerically
  // instead of guessed at from a screenshot.
  (globalThis as unknown as { __CHARDBG__: unknown }).__CHARDBG__ = {
    actors: scene.actors,
    stats: () => scene.actors.slice(0, 8).map((a) => a.character.tintStats()),
    kit: () => scene.actors.map((a) => {
      const p = a.character.appearance;
      return {
        seed: p.seed, faction: p.faction, head: p.headGear, face: p.faceGear,
        eyes: p.eyeGear, carrier: p.carrier, sleeves: p.sleeves, nvg: p.nvg,
        z: Math.round(a.character.object.position.z),
      };
    }),
  };

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
      position: [0, 1.62, 7.6], yaw: 0, pitch: -2, fov: 48, viewModel: false, hour: 13.5,
    },
    {
      name: 'char-lineup-close',
      description: 'Left half of the squad at 3.5 m — kit silhouette, plate carriers, helmets',
      position: [-2.3, 1.45, 3.6], yaw: 0, pitch: -1, fov: 46, viewModel: false, hour: 13.5,
    },
    {
      name: 'char-hero',
      description: 'Hero three-quarter shot of one soldier, late afternoon key light',
      position: [-3.0, 1.50, 1.9], yaw: 28, pitch: -2, fov: 40, viewModel: false, hour: 8.5,
    },
    {
      name: 'char-head',
      description: 'Head close-up: helmet, NVG mount, goggles, balaclava, comms headset',
      position: [-0.486, 1.633, 16.876], yaw: -29, pitch: 0, fov: 24, viewModel: false, hour: 15,
    },
    {
      name: 'char-head-3q',
      description: 'Three-quarter head close-up of a second soldier — face shaping and kit fit',
      position: [1.963, 1.612, 15.836], yaw: -99, pitch: 0, fov: 26, viewModel: false, hour: 15,
    },
    {
      name: 'char-torso',
      description: 'Torso close-up: plate carrier, magazine pouches, webbing, sling, cloth folds',
      position: [-0.938, 1.30, 16.97], yaw: -44, pitch: 0, fov: 36, viewModel: false, hour: 15,
    },
    {
      name: 'char-legs',
      description: 'Lower body close-up: trousers, blousing, knee pads, boots',
      position: [-1.53, 0.92, 17.58], yaw: -44, pitch: -9, fov: 40, viewModel: false, hour: 15,
    },
    {
      name: 'char-states',
      description: 'Locomotion states: idle, walk, run, sprint, strafe, crouch, crouch-walk, prone',
      position: [-3.2, 1.55, STATE_Z - 7.4], yaw: 172, pitch: -2, fov: 38, viewModel: false, hour: 9,
    },
    {
      name: 'char-actions',
      description: 'Cover poses, peek, hit reaction, grenade throw and three directional deaths',
      position: [-3.0, 1.55, STATE_Z + 8 + 7.6], yaw: 8, pitch: -2, fov: 38, viewModel: false, hour: 11,
    },
    {
      name: 'char-poses',
      description: 'Skinning sheet: waist twist both ways, aim up/down, throw, sprint, crouch, prone',
      position: [0, 1.62, POSE_Z + 9.2], yaw: 0, pitch: -2, fov: 46, viewModel: false, hour: 13.5,
    },
    {
      name: 'char-poses-close',
      description: 'Shoulder, elbow and wrist deformation under full waist twist at 2.4 m',
      position: [-5.30, 1.44, POSE_Z + 2.7], yaw: -4, pitch: 0, fov: 30, viewModel: false, hour: 13.5,
    },
    {
      name: 'char-impacts',
      description: 'Hit reactions frozen 90–200 ms after the round lands, plus limb and head hits',
      position: [-3.4, 1.52, IMPACT_Z + 7.0], yaw: 0, pitch: -3, fov: 44, viewModel: false, hour: 13,
    },
    {
      name: 'char-deaths',
      description: 'Three directional deaths mid-collapse and one handed off to the ragdoll',
      position: [3.4, 1.66, IMPACT_Z + 7.0], yaw: 0, pitch: -8, fov: 44, viewModel: false, hour: 13,
    },
    {
      name: 'char-silhouette',
      description: 'The squad at 50 m — does the kit still read as eight soldiers?',
      position: [40, 1.74, 30], yaw: 53, pitch: -0.6, fov: 13, viewModel: false, hour: 13.0,
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
