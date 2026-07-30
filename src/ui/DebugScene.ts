/**
 * `?debug=ui` — the HUD's own test bed.
 *
 * Builds a small urban lane for the HUD to sit over (so the overlay is judged
 * against a real rendered frame, not a grey void), disables the gameplay systems
 * that would fight the shot camera, then poses the HUD into specific mid-combat
 * states.
 *
 * Every shot is a *timeline*: events are published, the engine is stepped a
 * known number of fixed frames between them, and the last few beats are
 * scheduled so they land inside the capture harness's own settle window. That is
 * what makes it possible to photograph a hit marker 70 ms into its punch, a
 * killfeed row still sliding in and a score popup mid-flight, deterministically,
 * in the same frame.
 */

import * as THREE from 'three';
import type { EngineContext, System } from '../core/Engine';
import { bus } from '../core/EventBus';
import { Rand } from '../core/Rand';
import { registerDebugScene, registerShots } from '../core/Shots';
import { tagSurface, type SurfaceType } from '../core/Surfaces';
import type { MaterialSystem } from '../material/MaterialLibrary';
import type { RenderAPI } from '../render/types';
import type { HUDSystem } from './HUD';
import { demoSummary } from './menus/SummaryMenu';

const sleep = (ms: number): Promise<void> => new Promise((r) => { window.setTimeout(r, ms); });

export function registerUiDebugScene(hud: HUDSystem): void {
  let ctxRef: EngineContext | null = null;

  const step = (frames: number): void => {
    const ctx = ctxRef;
    if (!ctx) return;
    for (let i = 0; i < frames; i++) ctx.engine.stepFrame(1 / 60);
  };

  /* ------------------------------------------------------------ scene -- */

  registerDebugScene('ui', (ctx: EngineContext) => {
    ctxRef = ctx;

    // The HUD owns the frame here: gameplay systems would drive the camera and
    // overwrite the posed state.
    for (const name of ['player', 'ai', 'director', 'weapons']) {
      const sys = ctx.engine.tryGet(name);
      if (sys) sys.enabled = false;
    }
    hud.model.syncMirrors = false;

    buildLane(ctx);
    hud.rebuildMinimap();

    const render = ctx.engine.tryGet<System & RenderAPI>('render');
    render?.setTimeOfDay(9.4);
    render?.setWeather(0, 0.05, 0.25);
  });

  /* -------------------------------------------------------- HUD state -- */

  const resetHud = (): void => {
    hud.closeMenus();
    hud.resetTransients();
    hud.clearObjective();
    hud.model.objectives.clear();
    hud.model.score = 0;
    hud.model.xp.set(0, true);
    hud.model.match.timeLeft = 247;
    hud.model.match.label = 'SECURE THE UPLINK';
    hud.model.match.running = true;
    hud.model.alive = true;
    hud.model.recoil = 0;
    hud.model.weapon.reloading = false;
    hud.model.weapon.ads = false;
    hud.model.ads = 0;
    setHealth(100);
    setAmmo(24, 96);
  };

  const setHealth = (v: number): void => {
    hud.model.health = v;
    hud.model.maxHealth = 100;
    hud.model.healthBar.set(v / 100);
    hud.model.healthGhost = v / 100;
    bus.emit('player:health', { health: v, max: 100, regen: false });
  };

  const setAmmo = (ammo: number, reserve: number): void => {
    const w = hud.model.weapon;
    w.ammo = ammo;
    w.reserve = reserve;
    hud.model.ammoTicker.set(ammo, true);
    hud.model.reserveTicker.set(reserve, true);
  };

  const objectives = (): void => {
    hud.setObjective({
      id: 'A', label: 'A', kind: 'primary',
      position: new THREE.Vector3(-12, 1, -18), progress: 0.62,
    });
    hud.setObjective({
      id: 'B', label: 'B', kind: 'hostile',
      position: new THREE.Vector3(16, 1, -4),
    });
    hud.setObjective({
      id: 'C', label: 'C', kind: 'friendly',
      position: new THREE.Vector3(2, 1, 30),
    });
  };

  const streaks = (): void => {
    bus.emit('ui:killstreak', { slot: 0, name: 'UAV', progress: 1, ready: true, charges: 1 });
    bus.emit('ui:killstreak', { slot: 1, name: 'COUNTER UAV', progress: 0.62, ready: false });
    bus.emit('ui:killstreak', { slot: 2, name: 'CLUSTER STRIKE', progress: 0.24, ready: false });
    bus.emit('ui:equipment', { lethal: 1, tactical: 2, field: 1, fieldName: 'TROPHY' });
  };

  /** Forward point `d` metres ahead of the posed camera, for world-space UI. */
  const ahead = (d: number, lateral = 0, up = 0): THREE.Vector3 => {
    const cam = ctxRef?.camera;
    const out = new THREE.Vector3();
    if (!cam) return out;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    out.copy(cam.position).addScaledVector(fwd, d).addScaledVector(right, lateral);
    out.y += up;
    return out;
  };

  const enemyFire = (x: number, z: number): void => {
    bus.emit('ai:fire', {
      id: 20 + ((x * 7 + z) | 0), origin: new THREE.Vector3(x, 1.6, z),
      direction: new THREE.Vector3(0, 0, 1),
    });
  };

  /* ------------------------------------------------------- timelines --- */

  /**
   * Mid-firefight: partial health, low magazine, a live killfeed, damage from two
   * bearings, XP in flight and a hit marker caught mid-punch.
   */
  const combatTimeline = async (): Promise<void> => {
    resetHud();
    objectives();
    streaks();
    setHealth(62);
    setAmmo(9, 62);
    hud.model.match.timeLeft = 247;

    // t = 0
    hud.killfeed({
      killer: 'VULTURE', victim: 'CINDER', weapon: 'smg', headshot: false,
      killerIsPlayer: false, victimIsPlayer: false, friendlyKiller: true,
    });
    enemyFire(-14, -16);
    step(108); // 1.80 s

    hud.killfeed({
      killer: 'GHOST-ACTUAL', victim: 'ONYX', weapon: 'ar', headshot: true,
      killerIsPlayer: true, victimIsPlayer: false, friendlyKiller: true,
    });
    hud.scorePopup(150, 'HEADSHOT');
    enemyFire(11, -9);
    step(90); // 3.30 s

    hud.killfeed({
      killer: 'BRIMSTONE', victim: 'KESTREL', weapon: 'sniper', headshot: true,
      killerIsPlayer: false, victimIsPlayer: false,
    });
    step(33); // 3.85 s

    hud.scorePopup(100, 'ELIMINATION');
    step(24); // 4.25 s

    hud.banner('OBJECTIVE A', 'CAPTURING · 62%', 'objective');
    step(20); // 4.58 s

    // Direct HUD call rather than `damage:taken`: the bus event also drives the
    // player system's health and the renderer's full-screen damage effect, which
    // would flood the frame we are trying to photograph.
    hud.damageFrom(Math.atan2(-0.82, 0.57), 0.62);
    step(4);

    hud.scorePopup(50, 'ASSIST');
    step(8); // 4.78 s

    hud.flourish('ENEMY DOWN');
    hud.prompt({ id: 'plant', label: 'Plant Charge', key: 'F', hold: 2.2, detail: 'C4 ×1' });
    hud.promptProgress(0.62);
    hud.subtitle({ speaker: 'OVERLORD', text: 'Uplink secured. Hold that position.' });

    // Beats that must land inside the harness's 0.4 s settle window.
    hud.schedule(0.10, () => {
      hud.killfeed({
        killer: 'HAVOC', victim: 'GHOST-ACTUAL', weapon: 'lmg', headshot: false,
        killerIsPlayer: false, victimIsPlayer: true,
      });
      bus.emit('damage:dealt', {
        targetId: 42, amount: 43, headshot: true, killed: false,
        point: ahead(11, 1.6, 0.4), fromPlayer: true,
      });
    });
    hud.schedule(0.20, () => hud.damageFrom(Math.atan2(0.55, -0.83), 0.42));
    hud.schedule(0.24, () => hud.scorePopup(25, 'HIT'));
    hud.schedule(0.31, () => bus.emit('hud:hitmarker', { headshot: true, killed: false, armor: false }));
    hud.promptProgress(0.62);

    // Wall-clock pause so DOM transitions (subtitles) finish. It does not
    // advance the simulation, so the posed canvas state is untouched.
    await sleep(320);
  };

  /* ------------------------------------------------------------ shots -- */

  registerShots([
    {
      name: 'ui-combat',
      description: 'Combat HUD mid-firefight: 62% health, 9 rounds left, live killfeed, '
        + 'two directional damage indicators, XP popups in flight, a headshot hit marker '
        + 'mid-punch, objective banner and a hold prompt at 62%',
      position: [3.4, 1.68, 23], yaw: -6, pitch: -2.5, fov: 80, hour: 9.4, viewModel: false,
      setup: async () => {
        await combatTimeline();
      },
    },
    {
      name: 'ui-combat-ads',
      description: 'Aiming down sights: reticle collapsed, HUD panels dimmed back, '
        + 'compass and minimap faded, kill confirmed',
      position: [3.4, 1.68, 23], yaw: -6, pitch: -2.5, fov: 62, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(84);
        setAmmo(21, 124);
        hud.model.weapon.ads = true;
        step(90);
        hud.killfeed({
          killer: 'GHOST-ACTUAL', victim: 'REAPER', weapon: 'ar', headshot: true,
          killerIsPlayer: true, victimIsPlayer: false, friendlyKiller: true,
        });
        hud.scorePopup(150, 'HEADSHOT');
        step(24);
        hud.flourish('HEADSHOT', 'CRITICAL HIT');
        hud.schedule(0.30, () => bus.emit('hud:hitmarker', { headshot: false, killed: true, armor: false }));
        hud.schedule(0.12, () => bus.emit('damage:dealt', {
          targetId: 51, amount: 112, headshot: true, killed: true,
          point: ahead(16, -0.8, 0.2), fromPlayer: true,
        }));
      },
    },
    {
      name: 'ui-critical',
      description: 'Critically wounded: desaturated frame, pulsing red vignette, '
        + 'three converging damage indicators, empty magazine and the reload prompt',
      position: [-6.5, 1.66, 12], yaw: 26, pitch: -1, fov: 80, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(17);
        setAmmo(0, 31);
        hud.model.match.timeLeft = 38;
        step(60);
        hud.damageFrom(-2.1, 0.9);
        step(18);
        hud.damageFrom(1.35, 0.7);
        step(10);
        hud.subtitle({ speaker: 'OVERLORD', text: 'You are hit — find cover and regroup.' });
        await sleep(320);
        hud.schedule(0.16, () => hud.damageFrom(Math.atan2(0.1, -0.99), 0.95));
      },
    },
    {
      name: 'ui-feedback',
      description: 'Reward layer: killstreak banner, elimination flourish, stacked XP '
        + 'popups flying to the tally, world-space damage numbers and a kill marker',
      position: [-3.2, 1.75, 18], yaw: 9, pitch: -2, fov: 76, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(91);
        setAmmo(17, 155);
        step(30);
        hud.scorePopup(100, 'ELIMINATION');
        step(30);
        hud.scorePopup(150, 'HEADSHOT');
        step(18);
        bus.emit('killstreak:earned', { name: 'CLUSTER STRIKE', count: 7 });
        step(26);
        hud.scorePopup(300, 'KILLSTREAK');
        hud.flourish('ENEMY DOWN');
        hud.schedule(0.06, () => bus.emit('damage:dealt', {
          targetId: 61, amount: 96, headshot: false, killed: true,
          point: ahead(9, -1.2, 0.6), fromPlayer: true,
        }));
        hud.schedule(0.12, () => bus.emit('damage:dealt', {
          targetId: 62, amount: 38, headshot: true, killed: false,
          point: ahead(14, 2.4, 1.1), fromPlayer: true,
        }));
        hud.schedule(0.28, () => bus.emit('hud:hitmarker', { headshot: false, killed: true, armor: false }));
        hud.schedule(0.34, () => bus.emit('hud:hitmarker', { headshot: false, killed: false, armor: true }));
      },
    },
    {
      name: 'ui-scoreboard',
      description: 'Scoreboard held open over the combat HUD',
      position: [3.4, 1.68, 23], yaw: -6, pitch: -2.5, fov: 80, hour: 9.4, viewModel: false,
      setup: async () => {
        await combatTimeline();
        step(24);
        hud.setScoreboard(true);
        step(12);
        await sleep(260);
      },
    },
    {
      name: 'ui-menu',
      description: 'Main menu over the live rendered scene: operator card, mission brief '
        + 'and activity feed',
      position: [3.4, 1.95, 23], yaw: -6, pitch: 0.5, fov: 58, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        hud.setScoreboard(false);
        hud.openScreen('main');
        step(30);
        await sleep(1100);
        step(6);
      },
    },
    {
      name: 'ui-loadout',
      description: 'Loadout screen: weapon list, procedural weapon schematic with '
        + 'attachment callouts, stat bars with attachment deltas',
      position: [3.4, 1.95, 23], yaw: -6, pitch: 0.5, fov: 58, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        hud.setScoreboard(false);
        hud.openScreen('loadout');
        hud.loadout.selectById('ar_vector');
        hud.loadout.setAttachment('MUZZLE', 1);
        hud.loadout.setAttachment('OPTIC', 2);
        hud.loadout.setAttachment('UNDERBARREL', 1);
        step(60);
        await sleep(1100);
        step(30);
      },
    },
    {
      name: 'ui-settings',
      description: 'Settings screen, graphics tab — every control writes straight '
        + 'through to src/core/Settings.ts',
      position: [3.4, 1.95, 23], yaw: -6, pitch: 0.5, fov: 58, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        hud.setScoreboard(false);
        hud.openScreen('settings');
        step(30);
        await sleep(1100);
        step(6);
      },
    },
    {
      name: 'ui-summary',
      description: 'Post-match summary: result lockup, counted-up score breakdown, '
        + 'medals, rank progress',
      position: [3.4, 1.95, 23], yaw: -6, pitch: 0.5, fov: 58, hour: 9.4, viewModel: false,
      setup: async () => {
        resetHud();
        hud.setScoreboard(false);
        hud.showSummary(demoSummary(true, 'ui-summary'));
        step(20);
        await sleep(1100);
        step(210);
      },
    },
    {
      name: 'ui-pause',
      description: 'Pause menu over the frozen frame with the objective recap',
      position: [3.4, 1.68, 23], yaw: -6, pitch: -2.5, fov: 80, hour: 9.4, viewModel: false,
      setup: async () => {
        await combatTimeline();
        step(30);
        hud.openScreen('pause');
        step(20);
        await sleep(1100);
        step(6);
      },
    },
  ]);
}

/* ------------------------------------------------------------- geometry -- */

/**
 * A short urban lane: two facing terraces, a background skyline and enough
 * mid-ground clutter to break up the silhouette. Built from BufferGeometry with
 * procedural PBR materials — no assets.
 */
function buildLane(ctx: EngineContext): void {
  const mats = ctx.engine.tryGet<MaterialSystem>('materials');
  const rand = new Rand('ui-debug-lane');
  const root = new THREE.Group();
  root.name = 'ui-debug-lane';
  ctx.scene.add(root);

  const mat = (surface: SurfaceType, scale = 3, tint?: number): THREE.Material =>
    mats?.get(surface, { scale, tint, wear: 0.6 })
    ?? new THREE.MeshStandardMaterial({ color: tint ?? 0x8a8a8a, roughness: 0.9 });

  const box = (
    w: number, h: number, d: number, x: number, y: number, z: number,
    surface: SurfaceType, ry = 0, scale = 3, tint?: number,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(surface, scale, tint));
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    tagSurface(m, surface);
    root.add(m);
    return m;
  };

  /* --- terraces ---------------------------------------------------- */
  const surfaces: SurfaceType[] = ['brick', 'concrete', 'plaster', 'brick', 'concrete'];
  let z = 14;
  let i = 0;
  while (z > -46) {
    const depth = rand.range(7, 12);
    const hL = rand.range(6.5, 13);
    const hR = rand.range(6, 12);
    box(9, hL, depth, -12.5 - rand.range(0, 1.2), hL / 2, z - depth / 2,
      surfaces[i % surfaces.length], 0, 4);
    box(9, hR, depth, 12.5 + rand.range(0, 1.2), hR / 2, z - depth / 2,
      surfaces[(i + 2) % surfaces.length], 0, 4);
    // Parapet caps so the rooflines are not flat rectangles.
    box(9.6, 0.5, depth + 0.4, -12.5, hL + 0.25, z - depth / 2, 'concrete', 0, 2);
    box(9.6, 0.5, depth + 0.4, 12.5, hR + 0.25, z - depth / 2, 'concrete', 0, 2);
    z -= depth + rand.range(1.2, 3.4);
    i++;
  }

  /* --- skyline ------------------------------------------------------ */
  for (let k = 0; k < 7; k++) {
    const w = rand.range(9, 18);
    const h = rand.range(16, 34);
    box(w, h, rand.range(9, 16), rand.range(-42, 42), h / 2, -58 - rand.range(0, 26),
      'concrete', rand.range(-0.3, 0.3), 6);
  }

  /* --- mid-ground clutter ------------------------------------------- */
  for (let k = 0; k < 16; k++) {
    const s = rand.range(0.7, 1.5);
    box(s, s * rand.range(0.7, 1.2), s, rand.range(-9, 9), s * 0.5, rand.range(-34, 12),
      'crate', rand.range(0, Math.PI), 1.4);
  }
  for (let k = 0; k < 9; k++) {
    box(2.6, 1.05, 0.7, rand.range(-8.5, 8.5), 0.52, rand.range(-30, 10),
      'concrete', rand.range(-0.5, 0.5), 1.6);
  }
  for (let k = 0; k < 7; k++) {
    box(2.2, 0.62, 1.0, rand.range(-9, 9), 0.31, rand.range(-26, 8),
      'sandbag', rand.range(0, Math.PI), 1.2);
  }
  // Lamp posts add vertical rhythm and a strong silhouette against the sky.
  for (let k = 0; k < 8; k++) {
    const zz = 8 - k * 6.5;
    const side = k % 2 === 0 ? -1 : 1;
    box(0.22, 6.4, 0.22, side * 10.6, 3.2, zz, 'metal', 0, 1.2);
    box(1.5, 0.18, 0.2, side * 10.0, 6.3, zz, 'metal', 0, 1.2);
  }
}
