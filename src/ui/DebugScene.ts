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

export function registerUiDebugScene(hud: HUDSystem, ctx: EngineContext): void {
  // Seeded with the live engine context so the shot timelines below work in the
  // *real* level as well as in the `?debug=ui` lane. Without this, `step()` was
  // a no-op outside the debug scene and every animated beat — killfeed slides,
  // popup flights, hit-marker punches — collapsed into a single frame.
  let ctxRef: EngineContext | null = ctx;

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
    // Shot setups run against the *real* level as well as the `?debug=ui` lane,
    // and there the weapon and player systems are live — they would overwrite
    // the posed magazine and health a frame later. The HUD owns its own state
    // for the duration of a capture.
    hud.model.syncMirrors = false;
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
    // would flood the frame we are trying to photograph. Keep strength modest
    // so the rim indicators read without a full red wash.
    hud.damageFrom(Math.atan2(-0.82, 0.57), 0.38);
    step(4);

    hud.scorePopup(50, 'ASSIST');
    step(8); // 4.78 s

    hud.flourish('ENEMY DOWN');
    hud.prompt({ id: 'plant', label: 'Plant Charge', key: 'F', hold: 2.2, detail: 'C4 ×1' });
    hud.promptProgress(0.62);
    hud.subtitle({ speaker: 'OVERLORD', text: 'Uplink secured. Hold that position.' });

    // Beats that must land inside the harness's 0.4 s settle window.
    // Hitmarker + killfeed fire early so they are mid-punch (~70–150 ms old)
    // when the shutter opens — not scheduled so late they barely appear.
    hud.schedule(0.04, () => {
      hud.killfeed({
        killer: 'HAVOC', victim: 'GHOST-ACTUAL', weapon: 'lmg', headshot: false,
        killerIsPlayer: false, victimIsPlayer: true,
      });
      bus.emit('damage:dealt', {
        targetId: 42, amount: 43, headshot: true, killed: false,
        point: ahead(11, 1.6, 0.4), fromPlayer: true,
      });
      bus.emit('hud:hitmarker', { headshot: true, killed: false, armor: false });
    });
    hud.schedule(0.10, () => hud.scorePopup(25, 'HIT'));
    hud.schedule(0.14, () => hud.damageFrom(Math.atan2(0.55, -0.83), 0.28));
    // Second marker keeps the sandwich alive if the first fades before settle ends.
    hud.schedule(0.22, () => bus.emit('hud:hitmarker', { headshot: false, killed: true, armor: false }));
    hud.promptProgress(0.62);

    // Wall-clock pause so DOM transitions (subtitles) finish. It does not
    // advance the simulation, so the posed canvas state is untouched.
    await sleep(280);
  };

  /* ------------------------------------------------------------ shots -- */

  registerShots([
    {
      name: 'ui-combat',
      description: 'Combat HUD mid-firefight in the centre of the square at golden hour — '
        + 'the brightest, busiest background on the map. 62% health, 9 rounds left, live '
        + 'killfeed, two directional damage indicators, XP popups in flight, a headshot hit '
        + 'marker mid-punch, objective banner and a hold prompt at 62%',
      position: [1.5, 1.72, 14], yaw: 1.5, pitch: -1.5, fov: 80,
      setup: async () => {
        await combatTimeline();
      },
    },
    {
      name: 'ui-combat-ads',
      description: 'Aiming down sights: reticle collapsed to nothing, minimap / compass / '
        + 'killfeed dimmed back so the sight picture is clear, kill confirmed',
      position: [4.5, 1.72, -12.0], yaw: -25.6, pitch: -0.8, fov: 56,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(84);
        setAmmo(21, 124);
        hud.model.weapon.ads = true;
        // Announced as well as set, so a live weapons system poses the view
        // model down its sight instead of leaving the gun at the hip in a shot
        // whose whole point is the aimed sight picture.
        bus.emit('weapon:ads', { active: true });
        step(90);
        hud.killfeed({
          killer: 'GHOST-ACTUAL', victim: 'REAPER', weapon: 'ar', headshot: true,
          killerIsPlayer: true, victimIsPlayer: false, friendlyKiller: true,
        });
        hud.scorePopup(150, 'HEADSHOT');
        step(24);
        hud.flourish('HEADSHOT', 'CRITICAL HIT');
        hud.schedule(0.06, () => bus.emit('damage:dealt', {
          targetId: 51, amount: 112, headshot: true, killed: true,
          point: ahead(16, -0.8, 0.2), fromPlayer: true,
        }));
        hud.schedule(0.10, () => bus.emit('hud:hitmarker', { headshot: false, killed: true, armor: false }));
      },
    },
    {
      name: 'ui-spread',
      description: 'Reticle bloom: sprinting-speed movement plus four rounds of recoil has '
        + 'the crosshair wide open — the same frame as ui-combat-ads, which shows it shut',
      // Starts 4.4 m south of the ui-combat mark and walks on to it, so the two
      // shots frame the same view and differ only in the reticle.
      position: [1.5, 1.72, 18.4], yaw: 1.5, pitch: -1.5, fov: 80,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(74);
        setAmmo(14, 90);
        // The movement term is derived from real camera displacement, so the
        // spread spring only opens if the camera actually travels between steps.
        const cam = ctxRef?.camera;
        if (cam) {
          for (let i = 0; i < 40; i++) {
            cam.position.z -= 0.11;   // ≈6.6 m/s — sprint speed
            step(1);
          }
        }
        // Recoil on top of the movement bloom. Set directly rather than through
        // `weapon:fire`, which would also drive muzzle FX and audio into a frame
        // that is meant to isolate the reticle.
        hud.model.recoil = 0.85;
        // Four rounds fired inside the last 80 ms, so the magazine count is
        // caught mid-tick: the digits are still counting 14 → 10 and the block
        // is part-way through its punch when the shutter opens.
        for (let i = 0; i < 4; i++) {
          hud.model.weapon.ammo -= 1;
          hud.model.ammoTicker.set(hud.model.weapon.ammo);
          step(1);
        }
      },
    },
    {
      name: 'ui-dark',
      description: 'HUD legibility inside the warehouse — deep interior shade with a blown-out '
        + 'roller door behind it, the opposite exposure problem to ui-combat',
      position: [44.0, 5.9, -25.0], yaw: 102.3, pitch: -14.7, fov: 78,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(48);
        setAmmo(6, 30);
        step(40);
        hud.killfeed({
          killer: 'GHOST-ACTUAL', victim: 'VULTURE', weapon: 'smg', headshot: false,
          killerIsPlayer: true, victimIsPlayer: false, friendlyKiller: true,
        });
        hud.scorePopup(100, 'ELIMINATION');
        step(30);
        hud.prompt({ id: 'ammo', label: 'Resupply', key: 'F', hold: 1.4, detail: '5.56 × 90' });
        hud.promptProgress(0.34);
        step(6);
      },
    },
    {
      name: 'ui-critical',
      description: 'Critically wounded: desaturated frame, pulsing red vignette, '
        + 'three converging damage indicators, empty magazine and the reload prompt',
      position: [-30.0, 1.72, 20.0], yaw: 0.5, pitch: -1.5, fov: 80,
      setup: async () => {
        resetHud();
        objectives();
        streaks();
        setHealth(17);
        setAmmo(0, 31);
        hud.model.match.timeLeft = 38;
        step(60);
        hud.damageFrom(-2.1, 0.55);
        step(18);
        hud.damageFrom(1.35, 0.45);
        step(10);
        hud.subtitle({ speaker: 'OVERLORD', text: 'You are hit — find cover and regroup.' });
        await sleep(280);
        hud.schedule(0.12, () => hud.damageFrom(Math.atan2(0.1, -0.99), 0.5));
      },
    },
    {
      name: 'ui-feedback',
      description: 'Reward layer: killstreak banner, elimination flourish, stacked XP '
        + 'popups flying to the tally, world-space damage numbers and a kill marker',
      position: [7.5, 1.72, 5.0], yaw: 37.7, pitch: -1.3, fov: 76,
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
        hud.schedule(0.04, () => bus.emit('damage:dealt', {
          targetId: 61, amount: 96, headshot: false, killed: true,
          point: ahead(9, -1.2, 0.6), fromPlayer: true,
        }));
        hud.schedule(0.08, () => bus.emit('damage:dealt', {
          targetId: 62, amount: 38, headshot: true, killed: false,
          point: ahead(14, 2.4, 1.1), fromPlayer: true,
        }));
        hud.schedule(0.10, () => bus.emit('hud:hitmarker', { headshot: false, killed: true, armor: false }));
        hud.schedule(0.18, () => bus.emit('hud:hitmarker', { headshot: false, killed: false, armor: true }));
      },
    },
    {
      name: 'ui-scoreboard',
      description: 'Scoreboard held open over the combat HUD',
      position: [1.5, 1.72, 14], yaw: 1.5, pitch: -1.5, fov: 80,
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
      position: [6.0, 1.9, -14.5], yaw: 40.2, pitch: -3.0, fov: 58, viewModel: false,
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
      position: [6.0, 1.9, -14.5], yaw: 40.2, pitch: -3.0, fov: 58, viewModel: false,
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
      position: [6.0, 1.9, -14.5], yaw: 40.2, pitch: -3.0, fov: 58, viewModel: false,
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
      position: [6.0, 1.9, -14.5], yaw: 40.2, pitch: -3.0, fov: 58, viewModel: false,
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
      position: [1.5, 1.72, 14], yaw: 1.5, pitch: -1.5, fov: 80,
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
