/**
 * Death animations, the last-stand loop, healing under fire, and the stim
 * driven through the real input singleton. All sim-time, match live.
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const base = await ensureServer({ port: +arg('port', 9951), outDir: arg('dist', 'dist-gpc-1') });
const url = `${base}/?capture=1&quality=high&mode=operation&seed=1337`;
const s = await openSession({ url, width: 1280, height: 720, quality: 'high', seed: 1337 });
await s.exec(INSTALL_INPUT_BRIDGE);
await s.exec(INSTALL_PROBE);

const R = {};

/* --------------------------------------------------------- death anims -- */
R.deaths = await s.exec(() => {
  const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
  const hold = globalThis.__PT_HOLD__;
  a.setRender(false);
  for (let i = 0; i < 900; i++) e.stepFrame(1 / 120);
  a.markHome(true);
  a.setSpawnLock(true); a.clearActors(); a.setCombat(false); a.setFrozen(true);
  a.resetLifecycle(); a.giveWeapon('ar_vkr7'); a.refill();
  a.resetCounters();
  const lane = a.sightLane(12);
  let staged = 0;
  for (let k = 0; k < 8; k++) {
    a.goHome();
    const sp = a.spawnTarget(lane.yaw, 12, { seed: 620 + k, lateral: ((k % 3) - 1) * 1.6 });
    if (sp.id < 0) continue;
    for (let i = 0; i < 24; i++) e.stepFrame(1 / 120);
    const b = a.botState(sp.id);
    if (!b) continue;
    staged++;
    const aimY = sp.pos[1] + b.height * (k % 2 ? 0.92 : 0.6);
    for (let i = 0; i < 60; i++) { a.aimAt(sp.pos[0], aimY, sp.pos[2]); hold(['ads'], []); e.stepFrame(1 / 120); }
    for (let i = 0; i < 480; i++) {
      a.aimAt(sp.pos[0], aimY, sp.pos[2]);
      hold(['ads', 'fire'], i === 0 ? ['fire'] : []);
      e.stepFrame(1 / 120);
      a.refill();
      const st = a.botState(sp.id);
      if (!st || !st.alive) break;
    }
    hold([], []);
    for (let i = 0; i < 70; i++) e.stepFrame(1 / 120);
  }
  const d = a.dump(false);
  a.setSpawnLock(false); a.setCombat(true); a.setFrozen(false);
  return {
    staged,
    rows: d.deaths.map((x) => ({ hadChar: x.hadCharacter, ragdoll: x.ragdoll, delta: +x.delta.toFixed(4) })),
    total: d.deaths.length,
    moved: d.deaths.filter((x) => x.delta > 0.01).length,
    withRig: d.deaths.filter((x) => x.hadCharacter).length,
  };
});
console.log(`deaths staged ${R.deaths.staged}  recorded ${R.deaths.total}  moved ${R.deaths.moved}  rigged ${R.deaths.withRig}`);
console.log(`  pose deltas: ${R.deaths.rows.map((r) => r.delta).join(', ')}`);

/* --------------------------------------------- last-stand loop + heals -- */
R.downLoop = await s.exec(() => {
  const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
  const g = globalThis.__BLACKOUT_GAME__;
  const player = e.get('player');
  const C = globalThis.__BLACKOUT_COMBAT__;
  const hold = globalThis.__PT_HOLD__;
  const IN = globalThis.__PT_IN__;
  a.setRender(false); a.setSpawnLock(true); a.clearActors(); a.resetLifecycle();
  a.goHome(); player.health = 100;
  const lane = a.sightLane(16);
  player.camera.yaw = lane.yaw; player.camera.pitch = 0;
  for (let i = 0; i < 3; i++) a.spawnTarget(lane.yaw, 16, { seed: 810 + i, lateral: (i - 1) * 2.2 });
  a.setCombat(true); a.setFrozen(false);

  const t0 = e.time.elapsed;
  const events = [];
  let last = null, downCycles = 0, deaths = 0, revives = 0;
  let hpMin = 100;
  let stimTried = false, stimHpBefore = -1, stimHpPeak = -1, chargesBefore = -1, chargesAfter = -1;
  for (let i = 0; i < 120 * 45; i++) {
    hold([], []);
    // stim the moment we drop under 55 while still alive — a real mid-fight use
    if (!stimTried && player.alive && player.health < 55 && player.health > 0) {
      stimTried = true;
      chargesBefore = C.vitals().stimCharges;
      stimHpBefore = player.health;
      IN.actions.add('tactical'); IN.downEdges.add('tactical');
    } else if (stimTried && IN.actions.has('tactical')) {
      IN.actions.delete('tactical');
    }
    e.stepFrame(1 / 120);
    if (stimTried && player.alive && player.health > stimHpPeak) stimHpPeak = player.health;
    if (stimTried && chargesAfter < 0 && C.vitals().stimCharges < chargesBefore) chargesAfter = C.vitals().stimCharges;
    if (player.alive && player.health < hpMin) hpMin = player.health;
    const st = g.match && g.match.lifecycle ? g.match.lifecycle.state : null;
    if (st !== last) {
      events.push({ ms: +((e.time.elapsed - t0) * 1000).toFixed(0), from: last, to: st, hp: +player.health.toFixed(1) });
      if (st === 'downed') downCycles++;
      if (st === 'dead') deaths++;
      if (last === 'downed' && st === 'alive') revives++;
      last = st;
    }
    if (deaths >= 2) break;
  }
  const downedFor = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i - 1].to === 'downed') downedFor.push(events[i].ms - events[i - 1].ms);
  }
  a.setSpawnLock(false);
  return {
    events, downCycles, deaths, revivesFromDowned: revives,
    downedDurationsMs: downedFor,
    stim: {
      tried: stimTried, hpBefore: +stimHpBefore.toFixed(1), hpPeak: +stimHpPeak.toFixed(1),
      gained: +(stimHpPeak - stimHpBefore).toFixed(1),
      chargesBefore, chargesAfter, spent: chargesAfter >= 0 && chargesAfter < chargesBefore,
    },
  };
});
console.log(`down-loop: cycles ${R.downLoop.downCycles} deaths ${R.downLoop.deaths} revives-from-downed ${R.downLoop.revivesFromDowned} downed-for ${JSON.stringify(R.downLoop.downedDurationsMs)} ms`);
console.log(`  states: ${R.downLoop.events.map((e) => `${e.ms}:${e.to}(${e.hp})`).join(' → ')}`);
console.log(`  stim mid-fight: hp ${R.downLoop.stim.hpBefore} → ${R.downLoop.stim.hpPeak} (+${R.downLoop.stim.gained})  charges ${R.downLoop.stim.chargesBefore}→${R.downLoop.stim.chargesAfter} spent=${R.downLoop.stim.spent}`);

/* ------------------------------------------------------- regen profile -- */
R.regen = await s.exec(() => {
  const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
  const player = e.get('player');
  const C = globalThis.__BLACKOUT_COMBAT__;
  a.setRender(false); a.setSpawnLock(true); a.clearActors(); a.resetLifecycle();
  player.health = 100;
  for (let i = 0; i < 120; i++) e.stepFrame(1 / 120);
  const dir = player.position.clone().set(0, 0, 1);
  player.applyDamage(65, dir, false);
  const hp0 = player.health, t0 = e.time.elapsed;
  let start = -1, full = -1, prev = hp0;
  const trace = [];
  for (let i = 0; i < 120 * 20; i++) {
    e.stepFrame(1 / 120);
    const ms = (e.time.elapsed - t0) * 1000;
    if (start < 0 && player.health > prev + 0.02) start = ms;
    if (full < 0 && player.health >= 99.5) { full = ms; break; }
    if ((i % 30) === 0) trace.push([+ms.toFixed(0), +player.health.toFixed(1)]);
    prev = player.health;
  }
  a.setSpawnLock(false);
  return {
    spec: C ? C.vitalsSpec : null,
    fromHp: +hp0.toFixed(1), regenStartMs: +start.toFixed(0), fullMs: +full.toFixed(0),
    healSeconds: +((full - start) / 1000).toFixed(3),
    rateHpPerSec: full > start ? +((100 - hp0) / ((full - start) / 1000)).toFixed(2) : 0,
    trace,
  };
});
console.log(`regen: delay ${R.regen.regenStartMs} ms, full at ${R.regen.fullMs} ms, heal took ${R.regen.healSeconds} s, ${R.regen.rateHpPerSec} hp/s`);

R.errors = s.errors.slice(0, 10);
await mkdir(path.join(ROOT, 'shots/gpc-combat'), { recursive: true });
await writeFile(path.join(ROOT, 'shots/gpc-combat/feel.json'), JSON.stringify(R, null, 2));
console.log(`console errors: ${s.errors.length}`);
await s.close();
await stopServer();
