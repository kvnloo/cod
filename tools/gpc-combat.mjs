/**
 * GPC-1 combat critic probe. READ-ONLY on src/. Drives the shipping bundle.
 *
 *   node tools/gpc-combat.mjs --no-build --dist dist-gpc-1 --port 9951
 */
import { openSession, ensureServer, stopServer, ROOT, sleep } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const CFG = {
  port: +arg('port', 9951),
  dist: arg('dist', 'dist-gpc-1'),
  quality: arg('quality', 'high'),
  seed: +arg('seed', 1337),
  mode: arg('mode', 'operation'),
  out: arg('out', 'shots/gpc-combat/combat.json'),
};

const log = (...a) => console.log(...a);
const R = {};

async function main() {
  const base = await ensureServer({ port: CFG.port, outDir: CFG.dist });
  const url = `${base}/?capture=1&quality=${CFG.quality}&mode=${CFG.mode}&seed=${CFG.seed}`;
  const session = await openSession({
    url, width: 1280, height: 720, quality: CFG.quality, seed: CFG.seed,
  });
  await session.exec(INSTALL_INPUT_BRIDGE);
  const boot = await session.exec(INSTALL_PROBE);
  log(`probe: backend=${boot.actorBackend} aiAgents=${boot.aiAgents} cover=${boot.aiCover} nav=${boot.aiNavCells}`);
  R.boot = boot;

  /* ---- warm-up so the match is live -------------------------------------- */
  await session.exec(() => {
    const P = globalThis.__PT__; P.api.setRender(false);
    for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);
  });

  /* ======================================================== 1. AI CENSUS == */
  R.aiCensus = await session.exec(() => {
    const e = globalThis.engine, g = globalThis.__BLACKOUT_GAME__;
    const ai = e.tryGet('ai');
    const actors = g.services.actors;
    const samples = [];
    for (let k = 0; k < 40; k++) {
      for (let i = 0; i < 120; i++) e.stepFrame(1 / 120);   // 1 s
      samples.push({
        t: +e.time.elapsed.toFixed(2),
        agents: ai && ai.agents ? ai.agents.length : -1,
        agentsAlive: ai && ai.agents ? ai.agents.filter((a) => a.alive !== false && (a.health === undefined || a.health > 0)).length : -1,
        squads: ai && ai.squads ? (ai.squads.length || ai.squads.size || 0) : -1,
        bots: actors.bots ? actors.bots.length : -1,
        live: actors.liveCount ? actors.liveCount() : -1,
        phase: g.phase,
      });
    }
    let snap = null;
    try { snap = actors.snapshot ? actors.snapshot() : null; } catch { snap = 'threw'; }
    return {
      backend: Object.getPrototypeOf(actors).constructor.name,
      backendKeys: Object.keys(actors).slice(0, 40),
      backendSnapshot: snap,
      hasSpawnCombatant: typeof actors.spawnCombatant === 'function',
      aiSystemPresent: !!ai,
      aiKeys: ai ? Object.keys(ai).slice(0, 30) : null,
      cover: ai && ai.cover && ai.cover.points ? ai.cover.points.length : -1,
      nav: ai && ai.nav && ai.nav.cells ? (ai.nav.cells.length || ai.nav.cells.size || 0) : -1,
      peakAgents: Math.max(...samples.map((s) => s.agents)),
      peakLive: Math.max(...samples.map((s) => s.live)),
      samples,
    };
  });
  log(`AI: backend=${R.aiCensus.backend} peakAgents=${R.aiCensus.peakAgents} peakLive=${R.aiCensus.peakLive} cover=${R.aiCensus.cover} nav=${R.aiCensus.nav}`);

  /* ======================================================== 2. TTD SWEEP == */
  R.ttd = {};
  for (const metres of [12, 20]) {
    const trials = [];
    for (let t = 0; t < 5; t++) {
      const row = await session.exec(([m, trial]) => {
        const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
        const g = globalThis.__BLACKOUT_GAME__;
        const player = e.get('player');
        const hold = globalThis.__PT_HOLD__;
        a.setRender(false);
        a.setSpawnLock(true);
        a.clearActors();
        a.goHome ? a.goHome() : null;
        a.markHome();
        a.resetLifecycle();
        player.health = 100;
        a.resetCounters();
        const lane = a.sightLane(m);
        player.camera.yaw = lane.yaw; player.camera.pitch = 0;
        const ids = [];
        for (let i = 0; i < 3; i++) {
          const r = a.spawnTarget(lane.yaw, m, { seed: 300 + trial * 10 + i, lateral: (i - 1) * 2.4 });
          if (r.id >= 0) ids.push(r.id);
        }
        a.setCombat(true); a.setFrozen(false);
        const t0 = e.time.elapsed;
        let tFirst = -1, tZero = -1, tDown = -1, tDead = -1, cycles = 0;
        let lastState = null;
        const hpTrace = [];
        for (let i = 0; i < 120 * 60; i++) {
          hold([], []);            // stand still, do not fight back
          e.stepFrame(1 / 120);
          const ms = (e.time.elapsed - t0) * 1000;
          if ((i % 12) === 0) hpTrace.push([+ms.toFixed(0), +player.health.toFixed(1)]);
          if (tFirst < 0 && P.playerDamage.length) tFirst = (P.playerDamage[0].t - t0) * 1000;
          if (tZero < 0 && player.health <= 0) tZero = ms;
          const life = g.match && g.match.lifecycle ? g.match.lifecycle.state : null;
          if (life !== lastState) {
            if (life === 'downed') { cycles++; if (tDown < 0) tDown = ms; }
            lastState = life;
          }
          if (life === 'dead' || life === 'respawning') { tDead = ms; break; }
        }
        const dmg = P.playerDamage.slice();
        const total = dmg.reduce((s, d) => s + d.amount, 0);
        const distinct = [...new Set(dmg.map((d) => +d.amount.toFixed(3)))];
        a.setSpawnLock(false);
        return {
          metres: m, trial, enemies: ids.length, lineOfSight: lane.ok,
          firstDamageMs: +tFirst.toFixed(0), healthZeroMs: +tZero.toFixed(0),
          downedMs: +tDown.toFixed(0), deadMs: +tDead.toFixed(0),
          lastStandCycles: cycles, hits: dmg.length, totalDamage: +total.toFixed(1),
          timeScaleAtEnd: +e.time.scale.toFixed(3), phase: g.phase,
          hitsPerSec: tDead > 0 ? +(dmg.length / (tDead / 1000)).toFixed(2) : 0,
          dps: tDead > 0 ? +(total / (tDead / 1000)).toFixed(1) : 0,
          distinctDamageValues: distinct.length,
          damageValues: distinct.slice(0, 12),
          hpTrace: hpTrace.slice(0, 90),
        };
      }, [metres, t]);
      trials.push(row);
      log(`  TTD ${metres}m trial ${t}: first ${row.firstDamageMs}ms  dead ${row.deadMs}ms  hits ${row.hits}  dps ${row.dps}  distinctDmg ${row.distinctDamageValues}  cycles ${row.lastStandCycles}`);
    }
    const deads = trials.map((r) => (r.deadMs > 0 ? r.deadMs : 60000)).sort((a, b) => a - b);
    R.ttd[metres] = { trials, all: deads, median: deads[Math.floor(deads.length / 2)] };
    log(`TTD @${metres}m median ${R.ttd[metres].median} ms  (${deads.join(' / ')})`);
  }

  /* ============================================= 3. ENEMY FIRE IS REAL ==== */
  /* Cover test: stand in the open and take fire, then teleport behind full
   * cover with the same enemies and confirm the damage stops. A coin flip
   * gated only on a sight test would behave differently from a real bullet
   * that has to survive raycastAll through MASK_BULLET. Also count how many
   * enemy traces were stopped by geometry. */
  R.enemyFire = await session.exec(() => {
    const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
    const player = e.get('player');
    const physics = e.tryGet('physics');
    const hold = globalThis.__PT_HOLD__;
    a.setRender(false); a.setSpawnLock(true); a.clearActors(); a.resetLifecycle();
    player.health = 100;

    // instrument every raycast issued while enemies are shooting
    const trace = { total: 0, hitPlayer: 0, hitWorld: 0, miss: 0, masks: {}, zones: {} };
    const orig = physics.raycast.bind(physics);
    physics.raycast = function (o, d, maxD, mask, out, ignore) {
      const h = orig(o, d, maxD, mask, out, ignore);
      if (trace.on) {
        trace.total++;
        trace.masks[mask] = (trace.masks[mask] || 0) + 1;
        if (h && h.hit) {
          if (h.entityId === 0 || h.entityId === player.entityId) trace.hitPlayer++;
          else trace.hitWorld++;
          if (h.zone && h.zone !== 'none') trace.zones[h.zone] = (trace.zones[h.zone] || 0) + 1;
        } else trace.miss++;
      }
      return h;
    };

    a.markHome();
    const lane = a.sightLane(14);
    player.camera.yaw = lane.yaw; player.camera.pitch = 0;
    for (let i = 0; i < 3; i++) a.spawnTarget(lane.yaw, 14, { seed: 900 + i, lateral: (i - 1) * 2.2 });
    a.setCombat(true); a.setFrozen(false);

    // OPEN: 6 s of standing in the lane
    a.resetCounters(); trace.on = true;
    const openStart = player.health;
    for (let i = 0; i < 120 * 6; i++) { hold([], []); e.stepFrame(1 / 120); if (player.health < 5) player.health = 100; }
    const openHits = P.playerDamage.length;
    const openDamageValues = [...new Set(P.playerDamage.map((d) => +d.amount.toFixed(3)))].slice(0, 12);
    const openTraces = { ...trace, masks: { ...trace.masks }, zones: { ...trace.zones } };

    // COVER: find a spot within 30 m of the same enemies from which the player
    // has NO line of sight, then take the same 6 s. Real ballistics cannot reach
    // through geometry; a probability roll gated on anything looser can.
    const before = player.position.clone();
    const enemy = a.botState((globalThis.__BLACKOUT_GAME__.services.actors.bots || [])[0]?.id);
    let coverPos = null;
    if (enemy) {
      const eye = enemy.pos;
      for (let r = 6; r <= 30 && !coverPos; r += 2) {
        for (let k = 0; k < 32 && !coverPos; k++) {
          const th = (k / 32) * Math.PI * 2;
          const q = before.clone();
          q.x = eye[0] + Math.cos(th) * r;
          q.z = eye[2] + Math.sin(th) * r;
          // ground it
          const from = q.clone(); from.y = before.y + 25;
          const down = q.clone().set(0, -1, 0);
          const h = physics.raycast(from, down, 70, 1 | 2, {
            hit: false, point: q.clone(), normal: q.clone(), distance: Infinity,
            surface: 'concrete', object: null, entityId: -1, bodyHandle: -1, zone: 'none', backface: false,
          });
          if (!h || !h.hit) continue;
          q.y = h.point.y + 0.95;
          const tgt = q.clone().set(eye[0], eye[1] + 1.2, eye[2]);
          const canSee = physics.lineOfSight(q, tgt, 1 | 2 | 128);
          if (!canSee) coverPos = { p: q, r };
        }
      }
    }
    let coverHits = -1, coverRange = -1;
    a.resetCounters();
    player.health = 100;
    if (coverPos) {
      coverRange = coverPos.r;
      player.movement.teleport(coverPos.p, lane.yaw);
      for (let i = 0; i < 120 * 6; i++) { hold([], []); e.stepFrame(1 / 120); }
      coverHits = P.playerDamage.length;
    }

    player.movement.teleport(before, lane.yaw);
    trace.on = false;
    physics.raycast = orig;
    a.setSpawnLock(false); a.setFrozen(false);
    return {
      openHits, openStart, coverHits, coverRange, openDamageValues,
      traceTotal: openTraces.total, traceHitPlayer: openTraces.hitPlayer,
      traceHitWorld: openTraces.hitWorld, traceMiss: openTraces.miss,
      traceMasks: openTraces.masks, traceZones: openTraces.zones,
    };
  });
  log(`enemy fire: open hits ${R.enemyFire.openHits}  out-of-range hits ${R.enemyFire.coverHits}  traces ${R.enemyFire.traceTotal} (player ${R.enemyFire.traceHitPlayer} / world ${R.enemyFire.traceHitWorld} / miss ${R.enemyFire.traceMiss})`);

  /* ================================================ 4. ZONE TTK (head/leg) */
  R.zoneTtk = [];
  for (const weaponId of ['ar_vkr7', 'smg_hornet', 'lmg_vulcan', 'dmr_kestrel', 'pi_sidewinder', 'sr_longbow']) {
    for (const band of ['head', 'leg', 'chest']) {
      const row = await session.exec(([wid, bandName]) => {
        const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
        const hold = globalThis.__PT_HOLD__;
        const FRAC = { head: 0.94, chest: 0.72, leg: 0.22 };
        a.setRender(false); a.setSpawnLock(true); a.clearActors();
        a.setCombat(false); a.setFrozen(true);
        a.resetLifecycle();          // also restores Time.scale to 1
        a.goHome();
        a.giveWeapon(wid); a.refill();
        const lane = a.sightLane(10);
        const spawn = a.spawnTarget(lane.yaw, 10, { archetype: 'rifleman', health: 1, seed: 11 });
        if (spawn.id < 0) { a.setCombat(true); a.setFrozen(false); a.setSpawnLock(false); return null; }
        const bot = a.botState(spawn.id);
        const aimY = spawn.pos[1] + bot.height * FRAC[bandName];
        const info = a.weaponInfo(10);
        // Semi-auto needs a fresh down-edge per round; holding `fire` gives one shot.
        const semi = info.mode !== 'auto';
        for (let i = 0; i < 90; i++) { a.aimAt(spawn.pos[0], aimY, spawn.pos[2]); hold(['ads'], []); e.stepFrame(1 / 120); }
        a.resetCounters();
        const t0 = e.time.elapsed;
        let dead = -1, triggerPulls = 0;
        const before = a.botState(spawn.id).hp;
        const ammo0 = a.weaponInfo(10).ammo;
        let fired = 0, lastAmmo = ammo0;
        for (let i = 0; i < 120 * 8; i++) {
          a.aimAt(spawn.pos[0], aimY, spawn.pos[2]);
          if (semi) {
            // 6-step cycle: press, hold 1, release 4 — ~20 pulls/s ceiling, above
            // every semi-auto's own rpm cap, so the weapon's cadence is the limit.
            const ph = i % 6;
            if (ph === 0) { hold(['ads', 'fire'], ['fire']); triggerPulls++; }
            else if (ph === 1) hold(['ads', 'fire'], []);
            else hold(['ads'], []);
          } else {
            hold(['ads', 'fire'], i === 0 ? ['fire'] : []);
          }
          e.stepFrame(1 / 120);
          const am = a.weaponInfo(10).ammo;
          if (am < lastAmmo) fired += lastAmmo - am;
          if (am === 0) a.refill();
          lastAmmo = a.weaponInfo(10).ammo;
          const b = a.botState(spawn.id);
          if (!b || !b.alive) { dead = (e.time.elapsed - t0) * 1000; break; }
        }
        hold([], []);
        const hurts = globalThis.__PT__.hurts.slice();
        const amounts = hurts.map((h) => +h.amount.toFixed(2));
        const heads = hurts.filter((h) => h.headshot).length;
        // Multiple damage events sharing one sim timestamp = one round scoring
        // more than once on the same body.
        const byT = {};
        for (const h of hurts) { const k = h.t.toFixed(4); byT[k] = (byT[k] || 0) + 1; }
        const multi = Object.values(byT).filter((n) => n > 1).length;
        a.setCombat(true); a.setFrozen(false); a.setSpawnLock(false);
        return {
          weapon: wid, band: bandName, mode: info.mode, ttkMs: dead > 0 ? +dead.toFixed(0) : -1,
          timeScale: +e.time.scale.toFixed(3),
          shotsFired: fired, hitFraction: fired ? +(hurts.length / fired).toFixed(3) : 0,
          hits: hurts.length, headshotFlagged: heads, multiHitEvents: multi,
          maxHp: before,
          dmgPerHit: amounts.length ? +(amounts.reduce((s, x) => s + x, 0) / amounts.length).toFixed(2) : 0,
          distinct: [...new Set(amounts)].slice(0, 8),
        };
      }, [weaponId, band]);
      if (row) { R.zoneTtk.push(row); log(`  ${row.weapon.padEnd(14)} ${row.band.padEnd(6)} ${String(row.mode).padEnd(5)} ttk ${String(row.ttkMs).padStart(5)} ms  shots ${String(row.shotsFired).padStart(3)}  hits ${String(row.hits).padStart(3)}  acc ${row.hitFraction}  dmg/hit ${row.dmgPerHit}  hsFlag ${row.headshotFlagged}  multi ${row.multiHitEvents}  hp ${row.maxHp}`); }
    }
  }

  /* ============================================== 5. REGEN + STIM ========= */
  R.vitals = await session.exec(() => {
    const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
    const player = e.get('player');
    const C = globalThis.__BLACKOUT_COMBAT__;
    a.setRender(false); a.setSpawnLock(true); a.clearActors(); a.resetLifecycle();
    if (!C) return { error: '__BLACKOUT_COMBAT__ missing' };
    const timeScale = e.time.scale;

    // ---- passive regen from 100 -> 40 -> full
    player.health = 100;
    for (let i = 0; i < 120; i++) e.stepFrame(1 / 120);
    const dir = player.position.clone().set(0, 0, 1);
    player.applyDamage(60, dir, false);
    const hp0 = player.health;
    const t0 = e.time.elapsed;
    let regenStart = -1, full = -1;
    const trace = [];
    let prev = hp0;
    for (let i = 0; i < 120 * 15; i++) {
      e.stepFrame(1 / 120);
      const ms = (e.time.elapsed - t0) * 1000;
      if (regenStart < 0 && player.health > prev + 0.05) regenStart = ms;
      if (full < 0 && player.health >= 99.5) { full = ms; }
      if ((i % 24) === 0) trace.push([+ms.toFixed(0), +player.health.toFixed(1)]);
      prev = player.health;
      if (full > 0) break;
    }
    const rate = full > regenStart && regenStart > 0
      ? (100 - hp0) / ((full - regenStart) / 1000) : 0;

    // ---- stim, mid-fight, while taking incoming rounds
    const v0 = C.vitals();
    player.health = 30;
    const s0 = player.health;
    const used1 = C.useStim();
    let delivered = 0, tStim = -1;
    const st0 = e.time.elapsed;
    for (let i = 0; i < 120 * 3; i++) {
      e.stepFrame(1 / 120);
      if (tStim < 0 && player.health >= s0 + 64) tStim = (e.time.elapsed - st0) * 1000;
    }
    delivered = player.health - s0;
    const v1 = C.vitals();
    const used2 = C.useStim();
    for (let i = 0; i < 120 * 3; i++) e.stepFrame(1 / 120);
    const v2 = C.vitals();
    const used3 = C.useStim();
    const v3 = C.vitals();
    a.setSpawnLock(false);
    return {
      spec: C.vitalsSpec, timeScale,
      regenFromHp: +hp0.toFixed(1),
      regenDelayMs: +regenStart.toFixed(0),
      fullAtMs: +full.toFixed(0),
      regenRateHpPerSec: +rate.toFixed(2),
      trace,
      stimUsed1: used1, stimUsed2: used2, stimUsed3: used3,
      stimDeliveredHp: +delivered.toFixed(1), stimFullAtMs: +tStim.toFixed(0),
      chargesBefore: v0.stimCharges, chargesAfter1: v1.stimCharges,
      chargesAfter2: v2.stimCharges, chargesAfter3: v3.stimCharges,
      rechargeInAfter3: +v3.stimRechargeIn.toFixed(2),
    };
  });
  log(`vitals: regen delay ${R.vitals.regenDelayMs} ms  rate ${R.vitals.regenRateHpPerSec} hp/s  stim ${R.vitals.stimDeliveredHp} hp in ${R.vitals.stimFullAtMs} ms  charges ${R.vitals.chargesBefore}->${R.vitals.chargesAfter1}->${R.vitals.chargesAfter2} 3rd=${R.vitals.stimUsed3}`);

  /* ============================== 6. STIM VIA REAL INPUT WHILE FIGHTING === */
  R.stimInGame = await session.exec(() => {
    const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
    const player = e.get('player');
    const C = globalThis.__BLACKOUT_COMBAT__;
    const hold = globalThis.__PT_HOLD__;
    const IN = globalThis.__PT_IN__;
    a.setRender(false); a.setSpawnLock(true); a.clearActors(); a.resetLifecycle();
    player.health = 100;
    const lane = a.sightLane(14);
    player.camera.yaw = lane.yaw; player.camera.pitch = 0;
    for (let i = 0; i < 3; i++) a.spawnTarget(lane.yaw, 14, { seed: 700 + i, lateral: (i - 1) * 2.2 });
    a.setCombat(true); a.setFrozen(true);
    // take fire until below 50
    let took = 0;
    for (let i = 0; i < 120 * 20 && player.health > 50; i++) { hold([], []); e.stepFrame(1 / 120); took++; }
    const hpBefore = player.health;
    const before = C.vitals().stimCharges;
    // press 'tactical' through the real input singleton for 3 fixed steps
    IN.actions.add('tactical'); IN.downEdges.add('tactical');
    for (let i = 0; i < 6; i++) { e.stepFrame(1 / 120); }
    IN.actions.delete('tactical');
    let peak = player.health;
    for (let i = 0; i < 120 * 2; i++) { hold([], []); e.stepFrame(1 / 120); if (player.health > peak) peak = player.health; }
    const after = C.vitals().stimCharges;
    a.setCombat(false); a.setSpawnLock(false); a.clearActors();
    return {
      stepsToDropBelow50: took, hpBefore: +hpBefore.toFixed(1),
      peakAfter: +peak.toFixed(1), gained: +(peak - hpBefore).toFixed(1),
      chargesBefore: before, chargesAfter: after,
      usedViaInput: after < before,
    };
  });
  log(`stim via real input: hp ${R.stimInGame.hpBefore} -> ${R.stimInGame.peakAfter} (+${R.stimInGame.gained}) charges ${R.stimInGame.chargesBefore}->${R.stimInGame.chargesAfter}`);

  /* ============================== 7. DEATH ANIMATION, INDEPENDENT ========= */
  R.deaths = await session.exec(() => {
    const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
    const hold = globalThis.__PT_HOLD__;
    a.setRender(false); a.setSpawnLock(true); a.clearActors();
    a.setCombat(false); a.setFrozen(true); a.resetLifecycle();
    a.goHome(); a.giveWeapon('ar_vkr7'); a.refill();
    a.resetCounters();
    const lane = a.sightLane(12);
    const rows = [];
    for (let k = 0; k < 8; k++) {
      const s = a.spawnTarget(lane.yaw, 12, { seed: 500 + k, lateral: ((k % 3) - 1) * 1.8, health: 1 });
      if (s.id < 0) continue;
      const b = a.botState(s.id);
      const aimY = s.pos[1] + b.height * 0.6;
      for (let i = 0; i < 60; i++) { a.aimAt(s.pos[0], aimY, s.pos[2]); hold(['ads'], []); e.stepFrame(1 / 120); }
      for (let i = 0; i < 120 * 4; i++) {
        a.aimAt(s.pos[0], aimY, s.pos[2]);
        hold(['ads', 'fire'], i === 0 ? ['fire'] : []);
        e.stepFrame(1 / 120);
        const st = a.botState(s.id);
        if (!st || !st.alive) break;
      }
      hold([], []);
      for (let i = 0; i < 70; i++) e.stepFrame(1 / 120);   // let the 0.5 s watcher run
      rows.push(k);
    }
    const d = a.dump(false);
    a.setCombat(true); a.setFrozen(false); a.setSpawnLock(false);
    return {
      deaths: d.deaths.map((x) => ({
        id: x.id, hadCharacter: x.hadCharacter, ragdoll: x.ragdoll,
        delta: +x.delta.toFixed(4), samples: x.samples,
      })),
      animated: d.deaths.filter((x) => x.delta > 0.01).length,
      total: d.deaths.length,
    };
  });
  log(`deaths: ${R.deaths.animated}/${R.deaths.total} moved; deltas ${R.deaths.deaths.map((d) => d.delta).join(', ')}`);

  R.consoleErrors = session.errors.slice(0, 20);
  await mkdir(path.dirname(path.join(ROOT, CFG.out)), { recursive: true });
  await writeFile(path.join(ROOT, CFG.out), JSON.stringify(R, null, 2));
  log(`\nreport → ${path.join(ROOT, CFG.out)}`);
  log(`console errors: ${session.errors.length}`);
  await session.close();
  await stopServer();
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
