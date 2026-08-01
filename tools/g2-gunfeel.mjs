/**
 * G2 gunfeel probe — the clock, the trigger gate, the recoil split.
 *
 * Everything here is measured on the SIM clock (fixed steps), never on wall
 * time: the whole point of the package is that the gun behaves identically at
 * 30 and 540 fps, and a wall-clock measurement cannot tell the difference
 * between "the cadence is right" and "the host was fast".
 *
 *   node tools/g2-gunfeel.mjs [--no-build]
 *
 * Port 9912, dist-gp-g2, report in shots/gp-g2/gunfeel.json.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureServer, openSession, stopServer, ROOT } from './harness.mjs';

const PORT = 9912;
const OUT_DIR = 'dist-gp-g2';
const SHOTS = path.join(ROOT, 'shots', 'gp-g2');
const FPS_SET = [30, 60, 144, 540];
const NO_BUILD = process.argv.includes('--no-build');

/* ------------------------------------------------------------- page setup -- */

function INSTALL() {
  const api = globalThis.__BLACKOUT__;
  const e = globalThis.engine;
  if (!api || !e) throw new Error('capture API / engine missing');

  /* --- input bridge (same door the playtest harness uses) --------------- */
  const SENTINEL = '__g2_bridge__';
  const seen = [];
  const origAdd = Set.prototype.add;
  Set.prototype.add = function (v) { if (v === SENTINEL) seen.push(this); return origAdd.call(this, v); };
  try { api.act([{ press: [SENTINEL], hold: [], frames: 0 }]); } finally { Set.prototype.add = origAdd; }
  if (seen.length < 2) throw new Error(`input bridge failed (${seen.length})`);
  const downEdges = seen[0];
  const actions = seen[1];
  downEdges.delete(SENTINEL); actions.delete(SENTINEL);
  const MANAGED = ['forward', 'back', 'left', 'right', 'jump', 'crouch', 'prone', 'sprint',
    'fire', 'ads', 'reload', 'melee', 'use', 'switchWeapon', 'slot1', 'slot2'];
  globalThis.__G2_HOLD__ = function (hold, press) {
    for (let i = 0; i < MANAGED.length; i++) actions.delete(MANAGED[i]);
    if (hold) for (let i = 0; i < hold.length; i++) actions.add(hold[i]);
    if (press) for (let i = 0; i < press.length; i++) { downEdges.add(press[i]); actions.add(press[i]); }
  };

  const player = e.get('player');
  const weapons = e.get('weapons');
  const physics = e.tryGet('physics');
  const render = e.tryGet('render');
  const game = globalThis.__BLACKOUT_GAME__;
  const actors = game && game.services ? game.services.actors : null;

  /* --- shot + bullet recorders (prototype hooks, survive minification) -- */
  const wproto = Object.getPrototypeOf(weapons);
  const bproto = Object.getPrototypeOf(weapons.ballistics);
  const R = { shots: [], dirs: [], recording: false };
  const origShoot = wproto.shoot;
  wproto.shoot = function (...a) {
    const before = this.current.ammo;
    const r = origShoot.apply(this, a);
    if (R.recording && this.current.ammo < before) R.shots.push(this.fireClock().time);
    return r;
  };
  const origFire = bproto.fire;
  bproto.fire = function (p) {
    if (R.recording && p && p.direction) R.dirs.push([p.direction.x, p.direction.y, p.direction.z]);
    return origFire.call(this, p);
  };

  const hit = {
    hit: false, point: player.position.clone(), normal: player.position.clone(),
    distance: Infinity, surface: 'concrete', object: null,
    entityId: -1, bodyHandle: -1, zone: 'none', backface: false,
  };

  const G = {
    rec: R,
    quiet() {
      if (render) render.enabled = false;
      if (actors) {
        if (actors.clear) actors.clear();
        if (actors.setCombatEnabled) actors.setCombatEnabled(false);
        if (actors.setFrozen) actors.setFrozen(true);
      }
    },
    loud() {
      if (render) render.enabled = true;
      if (actors) {
        if (actors.setCombatEnabled) actors.setCombatEnabled(true);
        if (actors.setFrozen) actors.setFrozen(false);
      }
    },
    home: null,
    markHome() {
      if (!G.home) G.home = { p: player.position.clone(), yaw: player.camera.yaw };
      return G.home;
    },
    goHome() {
      if (!G.home) return;
      player.movement.teleport(G.home.p, G.home.yaw);
      player.camera.reset(G.home.yaw);
      player.health = player.maxHealth;
      player.alive = true;
    },
    /** Yaw with the most open floor in front, so a sprint test can sprint. */
    clearLane(metres) {
      const from = e.camera.position.clone();
      const dir = player.position.clone();
      let best = { yaw: player.camera.yaw, dist: -1 };
      for (let i = 0; i < 64; i++) {
        const yaw = (i / 64) * Math.PI * 2 - Math.PI;
        dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        let dist = metres + 5;
        if (physics && physics.ready) {
          const h = physics.raycast(from, dir, metres + 5, 0xffff, hit);
          if (h && h.hit) dist = h.distance;
        }
        if (dist > best.dist) best = { yaw, dist };
      }
      return best;
    },
    give(id) {
      weapons.give(id);
      const i = weapons.slots.findIndex((s) => s.runtime.id === id);
      if (i >= 0) { weapons.index = i; weapons.equip(i, true); }
      return weapons.current.def.rpm;
    },
    refill() {
      const w = weapons.current;
      w.ammo = w.magSize; w.reserve = w.def.magSize * 20; w.reloading = false;
    },
    /** Runs `frames` frames of `dt`, holding `h`, keeping the magazine topped up. */
    run(frames, dt, h, topUp) {
      for (let i = 0; i < frames; i++) {
        globalThis.__G2_HOLD__(h, []);
        if (topUp !== false) G.refill();
        e.stepFrame(dt);
      }
      globalThis.__G2_HOLD__([], []);
    },
    settle(frames) {
      for (let i = 0; i < (frames || 120); i++) { globalThis.__G2_HOLD__([], []); e.stepFrame(1 / 120); }
    },
    clock() { return weapons.fireClock(); },
    cam() {
      const r = player.camera.recoil;
      const f = player.camera.recoilFoldedDeg;
      return {
        yaw: player.camera.yaw, pitch: player.camera.pitch,
        rp: r.pitch * 180 / Math.PI, ry: r.yaw * 180 / Math.PI,
        fp: f.pitch, fy: f.yaw,
      };
    },
    juiceDump() {
      return typeof weapons.juiceDump === 'function' ? weapons.juiceDump() : [];
    },
    clearJuice() {
      if (typeof weapons.clearJuice === 'function') weapons.clearJuice();
    },
    brass() {
      const fx = e.tryGet('fx');
      const m = fx && fx.muzzle ? fx.muzzle : null;
      if (!m) return null;
      return {
        separation: m.lastBrassSeparation,
        muzzle: m.lastMuzzle ? [m.lastMuzzle.x, m.lastMuzzle.y, m.lastMuzzle.z] : null,
        port: m.lastPort ? [m.lastPort.x, m.lastPort.y, m.lastPort.z] : null,
      };
    },
    hitstop() {
      const g = globalThis.__BLACKOUT_GAME__;
      const life = g && g.match ? g.match.lifecycle : null;
      return {
        remain: life ? life.hitstopRemaining : (weapons.fireClock().hitstopRemain ?? 0),
        lastDuration: life ? life.lastHitstopDuration : 0,
        presentScale: life ? life.presentScale : 1,
        timeScale: e.time ? e.time.scale : 1,
      };
    },
    flashLocal() {
      const vm = weapons.viewModel;
      const flash = vm && vm.root ? vm.root.children.find((c) => c.name === 'vm-muzzle-flash') : null;
      const mz = vm && vm.rig ? vm.rig.point('muzzle') : null;
      if (!flash || !mz) return null;
      return {
        flash: [flash.position.x, flash.position.y, flash.position.z],
        muzzle: [mz.x, mz.y, mz.z],
        // Allow the small −Z crown bias; X/Y must match authored muzzle.
        xyMatch: Math.hypot(flash.position.x - mz.x, flash.position.y - mz.y) < 1e-4,
      };
    },
  };
  globalThis.__G2__ = G;
  return { ok: true };
}

/* --------------------------------------------------------------- phases --- */

/** Measured RPM per weapon per framerate, on the sim clock. */
function PHASE_RPM([fpsSet, weaponIds, rounds]) {
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const out = [];
  G.quiet();
  for (const id of weaponIds) {
    const rpm = G.give(id);
    G.settle(150);
    for (const fps of fpsSet) {
      G.goHome();
      G.give(id);
      G.settle(150);
      G.refill();
      G.rec.shots.length = 0; G.rec.dirs.length = 0; G.rec.recording = true;
      const seconds = (rounds + 4) * 60 / rpm;
      G.run(Math.ceil(seconds * fps), 1 / fps, ['fire'], true);
      G.rec.recording = false;
      const t = G.rec.shots.slice(0, rounds);
      const n = t.length;
      const span = n > 1 ? t[n - 1] - t[0] : 0;
      const gaps = [];
      for (let i = 1; i < n; i++) gaps.push(t[i] - t[i - 1]);
      gaps.sort((a, b) => a - b);
      out.push({
        weapon: id, fps, authoredRpm: rpm, rounds: n,
        measuredRpm: n > 1 ? +(60 * (n - 1) / span).toFixed(3) : null,
        meanGapMs: n > 1 ? +(span / (n - 1) * 1000).toFixed(4) : null,
        minGapMs: gaps.length ? +(gaps[0] * 1000).toFixed(4) : null,
        maxGapMs: gaps.length ? +(gaps[gaps.length - 1] * 1000).toFixed(4) : null,
        firstShotSimT: n ? +t[0].toFixed(6) : null,
      });
    }
  }
  G.loud();
  void e;
  return out;
}

/** Sprint-to-fire, measured from the last sprinting fixed step to the round. */
function PHASE_STF([fpsSet, weaponIds]) {
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const player = e.get('player');
  const out = [];
  G.quiet();
  for (const id of weaponIds) {
    for (const fps of fpsSet) {
      G.goHome();
      G.give(id);
      G.settle(200);
      const lane = G.clearLane(24);
      player.camera.yaw = lane.yaw; player.camera.pitch = 0;
      G.refill();
      /*
       * The trigger has to be pulled on a frame where the player is *still*
       * sprinting, otherwise the sprint-out timer expired during the run-up and
       * the measurement reports the run-up, not the gate. (This bit me twice:
       * a player who clips a kerb goes 'air' for a few steps a fifth of a second
       * before the lane ends, and the number silently becomes nonsense.)
       *
       * So the run-up is an attempt loop: home, pick a heading, sprint for a
       * fixed slice of SIM time, and accept it only if the final fixed step was
       * a sprinting one. A lane that does not work is retried on a different
       * heading rather than patched mid-run.
       */
      let sprintSteps = 0;
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        if (attempt > 0) {
          G.goHome();
          const l2 = G.clearLane(24);
          player.camera.yaw = l2.yaw + attempt * 1.3; player.camera.pitch = 0;
          G.settle(60);
        }
        sprintSteps = 0;
        const frames = Math.ceil(1.4 * fps);
        for (let i = 0; i < frames; i++) {
          globalThis.__G2_HOLD__(['forward', 'sprint'], []);
          e.stepFrame(1 / fps);
          const st = player.state;
          if (st === 'sprint' || st === 'tacSprint') sprintSteps++;
        }
        const c = G.clock();
        // Fresh sprint contact on the very last fixed step that ran.
        ok = sprintSteps > 20 && c.time - c.lastSprintAt < 1.2 / 120;
      }
      const c0 = G.clock();
      G.rec.shots.length = 0; G.rec.recording = true;
      // Trigger down on the same frame sprint input is released.
      for (let i = 0; i < Math.ceil(1.2 * fps) && !G.rec.shots.length; i++) {
        globalThis.__G2_HOLD__(['fire'], []);
        G.refill();
        e.stepFrame(1 / fps);
      }
      G.rec.recording = false;
      globalThis.__G2_HOLD__([], []);
      const c1 = G.clock();
      const shot = G.rec.shots.length ? G.rec.shots[0] : null;
      out.push({
        weapon: id, fps,
        authoredSprintOutMs: +(c1.sprintOut * 1000).toFixed(2),
        sprintSteps,
        // From the last fixed step the player was sprinting → the round leaving.
        delayMs: shot !== null ? +((shot - c1.lastSprintAt) * 1000).toFixed(3) : null,
        // From the frame boundary where sprint input was dropped.
        inputDelayMs: shot !== null ? +((shot - c0.time) * 1000).toFixed(3) : null,
        // How stale the sprint contact was when the trigger went down. Anything
        // above one fixed step means the measurement is about the lane, not the gate.
        sprintStaleMs: +((c0.time - c0.lastSprintAt) * 1000).toFixed(3),
        sprinted: c1.lastSprintAt > 0, runUpValid: ok,
      });
    }
  }
  G.loud();
  return out;
}

/** 60-round sustained spray: transient bound, folded aim, recovery. */
function PHASE_RECOIL([weaponId, rounds, ads, fps]) {
  const dt = 1 / (fps || 120);
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const player = e.get('player');
  G.quiet();
  G.goHome();
  G.give(weaponId);
  G.settle(200);
  G.refill();
  const lane = G.clearLane(24);
  player.camera.yaw = lane.yaw; player.camera.pitch = 0;
  if (ads) { for (let i = 0; i < Math.ceil(0.6 / dt); i++) { globalThis.__G2_HOLD__(['ads'], []); e.stepFrame(dt); } }
  player.camera.resetNoise('g2-recoil');
  player.camera.reset(lane.yaw, 0);
  /*
   * Seed the spray. Without this the four framerate runs draw their per-shot
   * jitter from four different positions in the same stream, and the ±0.15°
   * (1σ over 60 rounds of 0.09° jitter) reads as a framerate difference when it
   * is nothing of the sort. With it, the impulse sequence is fixed and anything
   * left over really is the clock.
   */
  e.get('weapons').resetSpray('g2-recoil');

  const start = G.cam();
  G.rec.shots.length = 0; G.rec.recording = true;
  let peak = 0, peakPitch = 0, peakYaw = 0;
  const trail = [];
  const hold = ads ? ['ads', 'fire'] : ['fire'];
  for (let i = 0; i < 6000 && G.rec.shots.length < rounds; i++) {
    globalThis.__G2_HOLD__(hold, []);
    G.refill();
    e.stepFrame(dt);
    const c = G.cam();
    const m = Math.hypot(c.rp, c.ry);
    if (m > peak) { peak = m; peakPitch = c.rp; peakYaw = c.ry; }
    if (G.rec.shots.length && trail.length < rounds) {
      trail.push({ n: G.rec.shots.length, rp: +c.rp.toFixed(4), fp: +c.fp.toFixed(4) });
    }
  }
  G.rec.recording = false;
  globalThis.__G2_HOLD__([], []);
  const atRelease = G.cam();
  const after = [];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < Math.ceil(1 / dt); i++) { globalThis.__G2_HOLD__([], []); e.stepFrame(dt); }
    const c = G.cam();
    after.push({ tS: s + 1, transientDeg: +Math.hypot(c.rp, c.ry).toFixed(4) });
  }
  const end = G.cam();
  G.loud();
  return {
    weapon: weaponId, ads: !!ads, fps: fps || 120, rounds: G.rec.shots.length,
    peakTransientDeg: +peak.toFixed(4), peakPitchDeg: +peakPitch.toFixed(4), peakYawDeg: +peakYaw.toFixed(4),
    atReleaseDeg: +Math.hypot(atRelease.rp, atRelease.ry).toFixed(4),
    residualAfter2sDeg: after[1].transientDeg,
    recovery: after,
    foldedPitchDeg: +end.fp.toFixed(3), foldedYawDeg: +end.fy.toFixed(3),
    lookPitchDeltaDeg: +((end.pitch - start.pitch) * 180 / Math.PI).toFixed(3),
    lookYawDeltaDeg: +((end.yaw - start.yaw) * 180 / Math.PI).toFixed(3),
    firstShots: trail.slice(0, 8),
  };
}

/** Two sprays, same seed: bullet directions and aim must match byte for byte. */
function PHASE_DETERMINISM([weaponId, rounds]) {
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const player = e.get('player');
  const weapons = e.get('weapons');
  G.quiet();
  const runs = [];
  for (let k = 0; k < 2; k++) {
    G.goHome();
    G.give(weaponId);
    G.settle(200);
    // A round is aimed from the *composed* camera, so a byte-identical spray
    // needs the camera's own noise stream back at its seed too — otherwise the
    // test measures shake, not the weapon.
    player.camera.resetNoise('g2-determinism');
    player.camera.reset(0, 0);
    weapons.resetSpray('g2-determinism');
    G.refill();
    G.rec.shots.length = 0; G.rec.dirs.length = 0; G.rec.recording = true;
    const aim = [];
    for (let i = 0; i < 2000 && G.rec.shots.length < rounds; i++) {
      globalThis.__G2_HOLD__(['ads', 'fire'], []);
      G.refill();
      e.stepFrame(1 / 120);
      if (G.rec.shots.length && aim.length < G.rec.shots.length) {
        const c = G.cam();
        aim.push([c.pitch, c.yaw, c.rp, c.ry]);
      }
    }
    G.rec.recording = false;
    globalThis.__G2_HOLD__([], []);
    runs.push({ dirs: G.rec.dirs.slice(0, rounds), aim: aim.slice(0, rounds) });
  }
  G.loud();
  const a = JSON.stringify(runs[0]);
  const b = JSON.stringify(runs[1]);
  let firstDiff = -1;
  for (let i = 0; i < runs[0].dirs.length; i++) {
    const x = runs[0].dirs[i], y = runs[1].dirs[i];
    if (!y || x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) { firstDiff = i; break; }
  }
  return {
    weapon: weaponId, rounds: runs[0].dirs.length,
    identical: a === b, bytesA: a.length, bytesB: b.length, firstDivergentShot: firstDiff,
    sampleDir: runs[0].dirs[0], sampleDir2: runs[1].dirs[0],
  };
}

/** ADS timing, first-shot accuracy, bloom growth and decay. */
function PHASE_ADS([weaponIds]) {
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const out = [];
  G.quiet();
  for (const id of weaponIds) {
    G.goHome();
    G.give(id);
    G.settle(200);
    G.refill();
    const stats = e.get('weapons').currentStats;
    const samples = [];
    for (let i = 0; i < 120; i++) {
      globalThis.__G2_HOLD__(['ads'], []);
      e.stepFrame(1 / 120);
      const c = G.clock();
      samples.push([(i + 1) / 120 * 1000, c.adsProgress, c.adsBlend, c.viewAdsBlend, c.coneDeg]);
    }
    const at = (idx, p) => {
      for (const s of samples) if (s[idx] >= p) return +s[0].toFixed(2);
      return null;
    };
    // ADS out.
    const outSamples = [];
    for (let i = 0; i < 120; i++) {
      globalThis.__G2_HOLD__([], []);
      e.stepFrame(1 / 120);
      const c = G.clock();
      outSamples.push([(i + 1) / 120 * 1000, c.adsBlend]);
    }
    let outMs = null;
    for (const s of outSamples) if (s[1] <= 0.001) { outMs = +s[0].toFixed(2); break; }

    // Settled-ADS first shot: cone must be exactly 0 for a firstShotAccurate gun.
    for (let i = 0; i < 90; i++) { globalThis.__G2_HOLD__(['ads'], []); e.stepFrame(1 / 120); }
    const settledCone = G.clock().coneDeg;
    // Bloom growth over a sustained aimed burst, then decay after release.
    G.refill();
    G.rec.shots.length = 0; G.rec.recording = true;
    const growth = [];
    for (let i = 0; i < 900 && G.rec.shots.length < 30; i++) {
      globalThis.__G2_HOLD__(['ads', 'fire'], []);
      G.refill();
      e.stepFrame(1 / 120);
      const c = G.clock();
      if (G.rec.shots.length && growth.length < G.rec.shots.length) {
        growth.push([G.rec.shots.length, +c.bloom.toFixed(4), +c.coneDeg.toFixed(4)]);
      }
    }
    G.rec.recording = false;
    const bloomPeak = G.clock().bloom;
    const decay = [];
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 12; i++) { globalThis.__G2_HOLD__(['ads'], []); e.stepFrame(1 / 120); }
      decay.push([+((s + 1) * 100).toFixed(0), +G.clock().bloom.toFixed(4)]);
    }
    globalThis.__G2_HOLD__([], []);
    // Hip cone for reference.
    G.settle(90);
    const hipCone = G.clock().coneDeg;
    out.push({
      weapon: id,
      authoredAdsTimeMs: +(stats.adsTime * 1000).toFixed(1),
      adsInMs: at(1, 1), ads92Ms: at(2, 0.92), ads50Ms: at(2, 0.5),
      viewModel99Ms: at(3, 0.99), viewModel100Ms: at(3, 1),
      adsOutMs: outMs,
      settledConeDeg: +settledCone.toFixed(5),
      hipConeDeg: +hipCone.toFixed(4),
      bloomFirst: growth[0], bloomAt10: growth[9], bloomAt30: growth[29],
      bloomPeakDeg: +bloomPeak.toFixed(4),
      bloomDecayMs: decay,
    });
  }
  G.loud();
  return out;
}

/** Certified budgets that must not move: swap-to-fire and reload durations. */
function PHASE_BUDGETS([weaponIds]) {
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const weapons = e.get('weapons');
  const out = [];
  G.quiet();
  for (const id of weaponIds) {
    G.goHome();
    // Two weapons in the loadout so a switch has somewhere to go.
    G.give('pi_sidewinder');
    G.settle(200);
    G.give(id);
    G.settle(240);
    G.refill();

    // Swap-to-fire: hold the trigger through a weapon switch.
    const t0 = G.clock().time;
    G.rec.shots.length = 0; G.rec.recording = true;
    globalThis.__G2_HOLD__([], ['switchWeapon']);
    e.stepFrame(1 / 120);
    for (let i = 0; i < 400 && !G.rec.shots.length; i++) {
      globalThis.__G2_HOLD__(['fire'], []);
      G.refill();
      e.stepFrame(1 / 120);
    }
    G.rec.recording = false;
    globalThis.__G2_HOLD__([], []);
    const swapMs = G.rec.shots.length ? (G.rec.shots[0] - t0) * 1000 : null;
    const swappedTo = weapons.current.id;

    // Reload: tactical (partial magazine) from a settled idle.
    G.goHome();
    G.give(id);
    G.settle(240);
    G.refill();
    const w = weapons.current;
    w.ammo = Math.max(1, Math.floor(w.magSize * 0.4));
    const r0 = G.clock().time;
    globalThis.__G2_HOLD__([], ['reload']);
    e.stepFrame(1 / 120);
    let ammoAtMs = null, doneMs = null;
    for (let i = 0; i < 900; i++) {
      globalThis.__G2_HOLD__([], []);
      e.stepFrame(1 / 120);
      const cur = weapons.current;
      if (ammoAtMs === null && cur.ammo >= cur.magSize) ammoAtMs = (G.clock().time - r0) * 1000;
      if (!cur.reloading && ammoAtMs !== null) { doneMs = (G.clock().time - r0) * 1000; break; }
    }
    out.push({
      weapon: id,
      swapToFireMs: swapMs === null ? null : +swapMs.toFixed(1),
      swappedTo,
      reloadAmmoAtMs: ammoAtMs === null ? null : +ammoAtMs.toFixed(1),
      reloadTotalMs: doneMs === null ? null : +doneMs.toFixed(1),
      authoredTacticalMs: +(weapons.current.def.reload.tactical * 1000).toFixed(0),
    });
  }
  G.loud();
  return out;
}

/** Category B: juice latencies, brass origin, hitstop, FP flash seat. */
function PHASE_JUICE() {
  const G = globalThis.__G2__;
  const e = globalThis.engine;
  const player = e.get('player');
  const weapons = e.get('weapons');
  const g = globalThis.__BLACKOUT_GAME__;
  G.quiet();
  G.goHome();
  G.give('ar_vkr7');
  G.settle(180);
  G.refill();
  G.clearJuice();

  const emit = g && g.services ? g.services.emit : null;

  /* --- brass + flash seat (one shot, no target) ----------------------- */
  G.rec.shots.length = 0; G.rec.recording = true;
  globalThis.__G2_HOLD__(['fire'], []);
  e.stepFrame(1 / 120);
  globalThis.__G2_HOLD__([], []);
  G.rec.recording = false;
  const brass = G.brass();
  const flash = G.flashLocal();

  /* --- input → present / fire wall-clock (Category A edge of B) ------- */
  G.clearJuice();
  G.refill();
  G.settle(60);
  const inputSamples = [];
  for (let n = 0; n < 12; n++) {
    G.refill();
    G.clearJuice();
    // Press on a fresh frame boundary and measure wall ms to present/fire stamp.
    const t0 = performance.now();
    globalThis.__G2_HOLD__([], ['fire']);
    e.stepFrame(1 / 60);
    globalThis.__G2_HOLD__(['fire'], []);
    e.stepFrame(1 / 60);
    globalThis.__G2_HOLD__([], []);
    const log = G.juiceDump();
    const present = log.find((x) => x.kind === 'present' || x.kind === 'fire');
    inputSamples.push({
      wallMs: present ? +(present.wallMs - t0).toFixed(3) : null,
      kind: present ? present.kind : null,
    });
    for (let i = 0; i < 8; i++) e.stepFrame(1 / 120);
  }

  /* --- hitstop pulse does not scale authoritative Time.scale ---------- */
  const life = g && g.match ? g.match.lifecycle : null;
  let hitstop = { pulsed: false, durationMs: null, timeScaleDuring: null, presentScale: null };
  if (life && typeof life.pulseHitstop === 'function') {
    const scale0 = e.time.scale;
    life.pulseHitstop('kill');
    hitstop = {
      pulsed: true,
      durationMs: +(life.lastHitstopDuration * 1000).toFixed(2),
      timeScaleDuring: e.time.scale,
      presentScale: life.presentScale,
      scaleUnchanged: e.time.scale === scale0,
    };
    // Advance lifecycle clocks so hitstop clears without leaving sticky state.
    for (let i = 0; i < 30; i++) {
      if (g.match && g.match.lifecycle) g.match.lifecycle.fixedUpdate(1 / 120);
    }
  }

  /* --- damage-taken → damageTaken stamp (indicator path) -------------- */
  G.clearJuice();
  const tDmg = performance.now();
  const dir = player.position.clone().set(1, 0, 0);
  if (emit) {
    emit('damage:taken', {
      amount: 12, fromDirection: dir, sourceId: 7, lethal: false,
    });
  } else {
    player.applyDamage(12, dir, false);
  }
  let dmgMs = null;
  const afterDmg = G.juiceDump().filter((x) => x.kind === 'damageTaken');
  if (afterDmg.length) dmgMs = +(afterDmg[0].wallMs - tDmg).toFixed(3);

  /* --- staged hitmarker / kill sandwich on sim clock ------------------ */
  G.clearJuice();
  // Synthesise the feedback chain the way combat does: damage → hitmarker → death → score.
  const tChain = performance.now();
  const tSim0 = G.clock().time;
  // Emit through the same bus the game uses by reusing weapons' juice listeners
  // — they sit on bus. Reach bus via a throwaway emit if services is present.
  if (emit) {
    const pt = player.position.clone();
    emit('damage:dealt', {
      targetId: 99, amount: 100, headshot: true, killed: true, point: pt, fromPlayer: true,
    });
    emit('hud:hitmarker', { headshot: true, killed: true, armor: false });
    emit('entity:death', {
      id: 99, byPlayer: true, headshot: true, name: 'hostile', point: pt,
    });
    emit('score:add', { amount: 100, reason: 'Kill' });
  }
  const chain = G.juiceDump();
  const wallOf = (k) => {
    const row = chain.find((x) => x.kind === k);
    return row ? row.wallMs : null;
  };
  const dmgW = wallOf('damage');
  const hmW = wallOf('hitmarker');
  const deathW = wallOf('death');
  const scoreW = wallOf('score');
  const hitmarkerAfterImpactMs = (dmgW != null && hmW != null) ? +(hmW - dmgW).toFixed(3) : null;
  const killConfirmMs = (dmgW != null && scoreW != null) ? +(scoreW - dmgW).toFixed(3)
    : (hmW != null && scoreW != null) ? +(scoreW - hmW).toFixed(3) : null;

  G.loud();
  void weapons; void tSim0; void tChain; void deathW;
  return {
    brassSeparationM: brass ? +brass.separation.toFixed(4) : null,
    brass: brass,
    flashLocal: flash,
    flashAtMuzzleXY: !!(flash && flash.xyMatch),
    inputToPresentMs: inputSamples,
    inputToPresentP99Ms: (function () {
      const arr = inputSamples.map((s) => s.wallMs).filter((v) => v != null).sort((a, b) => a - b);
      if (!arr.length) return null;
      return +arr[Math.min(arr.length - 1, Math.ceil(0.99 * arr.length) - 1)].toFixed(3);
    })(),
    inputToPresentMaxMs: (function () {
      const arr = inputSamples.map((s) => s.wallMs).filter((v) => v != null);
      return arr.length ? Math.max(...arr) : null;
    })(),
    hitstop,
    damageIndicatorMs: dmgMs,
    hitmarkerAfterImpactMs,
    killConfirmMs,
    chainKinds: chain.map((c) => c.kind),
  };
}
/* ----------------------------------------------------------------- driver -- */

const pct = (a, b) => (b === 0 ? 0 : Math.abs(a - b) / b * 100);

async function main() {
  if (!NO_BUILD) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', OUT_DIR], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  const url = await ensureServer({ mode: 'preview', port: PORT, outDir: OUT_DIR });
  const session = await openSession({ url, width: 1280, height: 720, quality: 'low', seed: 1337 });
  const report = { renderer: session.renderer, when: new Date().toISOString() };
  try {
    await session.exec(INSTALL);
    await session.exec(() => { globalThis.__G2__.quiet(); globalThis.__G2__.markHome(); });

    console.log('phase 1/7 — fire-rate clock');
    report.rpm = await session.exec(PHASE_RPM, [FPS_SET, ['ar_vkr7', 'smg_hornet', 'lmg_vulcan'], 60]);
    for (const r of report.rpm) {
      console.log(`  ${r.weapon.padEnd(12)} ${String(r.fps).padStart(3)}fps  authored ${r.authoredRpm}  `
        + `measured ${r.measuredRpm}  (${pct(r.measuredRpm, r.authoredRpm).toFixed(3)}%)  `
        + `gap ${r.meanGapMs}ms [${r.minGapMs}..${r.maxGapMs}]  n=${r.rounds}`);
    }

    console.log('phase 2/7 — sprint-to-fire');
    report.stf = await session.exec(PHASE_STF, [FPS_SET, ['ar_vkr7', 'smg_hornet', 'lmg_vulcan']]);
    for (const r of report.stf) {
      console.log(`  ${r.weapon.padEnd(12)} ${String(r.fps).padStart(3)}fps  authored ${r.authoredSprintOutMs}ms  `
        + `measured ${r.delayMs}ms  (input-relative ${r.inputDelayMs}ms, stale ${r.sprintStaleMs}ms, `
        + `runUp ${r.runUpValid ? 'ok' : 'INVALID'}, sprintFrames ${r.sprintSteps})`);
    }

    console.log('phase 3/7 — recoil bound + fold split');
    report.recoilAds = await session.exec(PHASE_RECOIL, ['ar_vkr7', 60, true, 120]);
    report.recoilHip = await session.exec(PHASE_RECOIL, ['ar_vkr7', 60, false, 120]);
    report.recoilByFps = [];
    for (const fps of FPS_SET) report.recoilByFps.push(await session.exec(PHASE_RECOIL, ['ar_vkr7', 60, true, fps]));
    for (const r of [report.recoilAds, report.recoilHip, ...report.recoilByFps]) {
      console.log(`  ${r.weapon} ${r.ads ? 'ADS' : 'hip'} @${String(r.fps).padStart(3)}fps  ${r.rounds} rounds  `
        + `peak ${r.peakTransientDeg}°  release ${r.atReleaseDeg}°  +2s ${r.residualAfter2sDeg}°  `
        + `folded ${r.foldedPitchDeg}°/${r.foldedYawDeg}°  look Δ ${r.lookPitchDeltaDeg}°/${r.lookYawDeltaDeg}°`);
    }

    console.log('phase 4/7 — determinism');
    report.determinism = await session.exec(PHASE_DETERMINISM, ['ar_vkr7', 30]);
    console.log(`  identical=${report.determinism.identical} rounds=${report.determinism.rounds} `
      + `bytes=${report.determinism.bytesA}/${report.determinism.bytesB} `
      + `firstDivergent=${report.determinism.firstDivergentShot}`);

    console.log('phase 5/7 — ADS + spread');
    report.ads = await session.exec(PHASE_ADS, [['ar_vkr7', 'smg_hornet', 'sr_longbow']]);
    for (const r of report.ads) {
      console.log(`  ${r.weapon.padEnd(12)} authored ${r.authoredAdsTimeMs}ms  full ${r.adsInMs}ms  `
        + `92% ${r.ads92Ms}ms  vm100 ${r.viewModel100Ms}ms  out ${r.adsOutMs}ms  `
        + `settledCone ${r.settledConeDeg}°  hip ${r.hipConeDeg}°  bloomPeak ${r.bloomPeakDeg}°`);
    }

    console.log('phase 6/7 — handling budgets (regression)');
    report.budgets = await session.exec(PHASE_BUDGETS, [['ar_vkr7', 'smg_hornet', 'lmg_vulcan', 'pi_sidewinder']]);
    for (const r of report.budgets) {
      console.log(`  ${r.weapon.padEnd(12)} swap-to-fire ${r.swapToFireMs}ms  reload ${r.reloadTotalMs}ms `
        + `(authored ${r.authoredTacticalMs}ms, ammo at ${r.reloadAmmoAtMs}ms)`);
    }

    console.log('phase 7/7 — Category B juice (latencies / brass / hitstop)');
    report.juice = await session.exec(PHASE_JUICE);
    {
      const j = report.juice;
      console.log(`  brass separation ${j.brassSeparationM} m  flashXY ${j.flashAtMuzzleXY}`);
      console.log(`  input→present p99 ${j.inputToPresentP99Ms} ms  max ${j.inputToPresentMaxMs} ms`);
      console.log(`  hitmarker after impact ${j.hitmarkerAfterImpactMs} ms  kill-confirm ${j.killConfirmMs} ms`);
      console.log(`  damage-indicator ${j.damageIndicatorMs} ms  hitstop ${JSON.stringify(j.hitstop)}`);
      console.log(`  chain ${JSON.stringify(j.chainKinds)}`);
    }

    // Font CDN blips (ERR_NETWORK_CHANGED on gstatic) are environment noise,
    // not gameplay regressions — strip them so the console gate stays honest.
    const realErrors = session.errors.filter((e) => {
      const s = String(e);
      return !/fonts\.gstatic|ERR_NETWORK|Failed to load resource: net::ERR_/i.test(s);
    });
    report.errors = realErrors.slice(0, 20);
    report.errorsRaw = session.errors.length;
    console.log(`console errors: ${realErrors.length} (raw ${session.errors.length})`);
  } finally {
    await mkdir(SHOTS, { recursive: true });
    await writeFile(path.join(SHOTS, 'gunfeel.json'), JSON.stringify(report, null, 2));
    await session.close();
    await stopServer();
  }

  /* --- gates ----------------------------------------------------------- */
  const gates = [];
  const worstRpm = Math.max(...report.rpm.map((r) => pct(r.measuredRpm, r.authoredRpm)));
  gates.push(['rpm within 0.5% of authored (all weapons, all fps)', `${worstRpm.toFixed(3)}%`, worstRpm <= 0.5]);
  const byWeapon = {};
  for (const r of report.rpm) (byWeapon[r.weapon] ||= []).push(r.measuredRpm);
  const spread = Math.max(...Object.values(byWeapon).map((v) => Math.max(...v) - Math.min(...v)));
  gates.push(['rpm identical across 30/60/144/540 fps', `max spread ${spread.toFixed(4)} rpm`, spread < 0.5]);
  // Rows whose run-up never reached a clean sprint measure the level, not the
  // gate; they are reported and excluded rather than allowed to fail a gate.
  const stfValid = report.stf.filter((r) => r.runUpValid && r.delayMs !== null);
  const stfErr = Math.max(...stfValid.map((r) => Math.abs(r.delayMs - r.authoredSprintOutMs)));
  gates.push([`sprint-to-fire within 10 ms of authored at every fps (${stfValid.length}/${report.stf.length} valid run-ups)`,
    `worst ${stfErr.toFixed(2)} ms`, stfErr <= 10 && stfValid.length >= report.stf.length - 2]);
  gates.push(['recoil residual 2 s after 60 rounds <= 0.50°',
    `${report.recoilAds.residualAfter2sDeg}° ADS / ${report.recoilHip.residualAfter2sDeg}° hip`,
    report.recoilAds.residualAfter2sDeg <= 0.5 && report.recoilHip.residualAfter2sDeg <= 0.5]);
  gates.push(['transient recoil bounded under a 60-round spray',
    `peak ${report.recoilAds.peakTransientDeg}° ADS / ${report.recoilHip.peakTransientDeg}° hip`,
    report.recoilAds.peakTransientDeg <= 6 && report.recoilHip.peakTransientDeg <= 6]);
  gates.push(['folded recoil shows up in the look angles',
    `folded ${report.recoilAds.foldedPitchDeg}° vs look Δ ${report.recoilAds.lookPitchDeltaDeg}°`,
    Math.abs(report.recoilAds.foldedPitchDeg - report.recoilAds.lookPitchDeltaDeg) < 0.02
    && report.recoilAds.foldedPitchDeg > 0.5]);
  const foldSpread = Math.max(...report.recoilByFps.map((r) => r.foldedPitchDeg))
    - Math.min(...report.recoilByFps.map((r) => r.foldedPitchDeg));
  const peakSpread = Math.max(...report.recoilByFps.map((r) => r.peakTransientDeg))
    - Math.min(...report.recoilByFps.map((r) => r.peakTransientDeg));
  gates.push(['recoil identical across 30/60/144/540 fps',
    `folded spread ${foldSpread.toFixed(4)}°, peak spread ${peakSpread.toFixed(4)}°`,
    foldSpread < 0.01 && peakSpread < 0.02]);
  gates.push(['two sprays, same seed, byte-identical', String(report.determinism.identical), report.determinism.identical]);
  const adsAr = report.ads.find((r) => r.weapon === 'ar_vkr7');
  gates.push(['ADS reaches fully sighted at the authored time (±10 ms)',
    `${adsAr.adsInMs}ms vs ${adsAr.authoredAdsTimeMs}ms`,
    Math.abs(adsAr.adsInMs - adsAr.authoredAdsTimeMs) <= 10]);
  gates.push(['first-shot accuracy: settled ADS cone is exactly 0',
    `${adsAr.settledConeDeg}°`, adsAr.settledConeDeg === 0]);
  gates.push(['bloom grows under sustained fire',
    `${adsAr.bloomFirst?.[1]}° → ${adsAr.bloomAt30?.[1]}°`, (adsAr.bloomAt30?.[1] ?? 0) > (adsAr.bloomFirst?.[1] ?? 0)]);
  gates.push(['bloom decays after release',
    `${adsAr.bloomPeakDeg}° → ${adsAr.bloomDecayMs[adsAr.bloomDecayMs.length - 1][1]}°`,
    adsAr.bloomDecayMs[adsAr.bloomDecayMs.length - 1][1] < adsAr.bloomPeakDeg]);
  gates.push(['no console errors', String(report.errors.length), report.errors.length === 0]);

  // Category B — instrumented juice. Fail closed on structural defects; latency
  // budgets gate when the chain produced measurable stamps.
  const j = report.juice;
  gates.push(['brass ejects at port (separation > 5 cm from muzzle)',
    `${j.brassSeparationM} m`, j.brassSeparationM != null && j.brassSeparationM > 0.05]);
  gates.push(['view-model flash sits on authored muzzle X/Y',
    String(j.flashAtMuzzleXY), !!j.flashAtMuzzleXY]);
  gates.push(['presentation hitstop does not scale Time.scale',
    `scaleDuring=${j.hitstop?.timeScaleDuring} present=${j.hitstop?.presentScale}`,
    !j.hitstop?.pulsed || (j.hitstop.scaleUnchanged && j.hitstop.presentScale < 1)]);
  if (j.hitmarkerAfterImpactMs != null) {
    gates.push(['hitmarker appear ≤ 60 ms after impact (wall)',
      `${j.hitmarkerAfterImpactMs} ms`, j.hitmarkerAfterImpactMs <= 60]);
  }
  if (j.killConfirmMs != null) {
    gates.push(['kill confirm (score) ≤ 150 ms after killing blow (wall)',
      `${j.killConfirmMs} ms`, j.killConfirmMs <= 150]);
  }
  if (j.inputToPresentP99Ms != null) {
    gates.push(['input→first present ≤ 50 ms p99 (wall, stepped harness)',
      `p99 ${j.inputToPresentP99Ms} ms / max ${j.inputToPresentMaxMs} ms`,
      j.inputToPresentP99Ms <= 50]);
  }
  if (j.damageIndicatorMs != null) {
    gates.push(['damage-taken stamp ≤ 100 ms (indicator path)',
      `${j.damageIndicatorMs} ms`, j.damageIndicatorMs <= 100]);
  }

  console.log('\n--- gates ---');
  let bad = 0;
  for (const [name, measured, ok] of gates) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${measured}`);
  }
  await writeFile(path.join(SHOTS, 'gates.json'), JSON.stringify(gates, null, 2));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
