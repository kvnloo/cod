/** Why did the fire cadence change between runs? Measure the clock directly. */
import { openSession, ensureServer, stopServer } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };

const base = await ensureServer({ port: +arg('port', 9951), outDir: arg('dist', 'dist-gpc-1') });
const url = `${base}/?capture=1&quality=high&mode=${arg('mode','operation')}&seed=1337`;
const s = await openSession({ url, width: 1280, height: 720, quality: 'high', seed: 1337 });
await s.exec(INSTALL_INPUT_BRIDGE);
await s.exec(INSTALL_PROBE);

const out = await s.exec(() => {
  const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
  const hold = globalThis.__PT_HOLD__;
  const weapons = e.get('weapons');
  const player = e.get('player');
  const g = globalThis.__BLACKOUT_GAME__;
  a.setRender(false);
  for (let i = 0; i < 900; i++) e.stepFrame(1 / 120);
  a.markHome();

  const runs = [];
  function measure(label, pre) {
    a.setSpawnLock(true); a.clearActors(); a.setCombat(false); a.setFrozen(true);
    a.goHome(); a.giveWeapon('ar_vkr7'); a.refill();
    if (pre) pre();
    const lane = a.sightLane(10);
    const spawn = a.spawnTarget(lane.yaw, 10, { archetype: 'rifleman', health: 1, seed: 11 });
    const bot = a.botState(spawn.id);
    const aimY = spawn.pos[1] + bot.height * 0.72;
    for (let i = 0; i < 90; i++) { a.aimAt(spawn.pos[0], aimY, spawn.pos[2]); hold(['ads'], []); e.stepFrame(1 / 120); }
    a.resetCounters();
    const t0 = e.time.elapsed;
    const stepsBefore = e.time.frame;
    let fixedSteps = 0;
    const shots = [];
    let prevAmmo = weapons.current.ammo;
    for (let i = 0; i < 120 * 3; i++) {
      a.aimAt(spawn.pos[0], aimY, spawn.pos[2]);
      hold(['ads', 'fire'], i === 0 ? ['fire'] : []);
      e.stepFrame(1 / 120);
      fixedSteps += e.time.steps;
      if (weapons.current.ammo < prevAmmo) shots.push(+((e.time.elapsed - t0) * 1000).toFixed(2));
      prevAmmo = weapons.current.ammo;
    }
    hold([], []);
    const gaps = [];
    for (let i = 1; i < shots.length; i++) gaps.push(+(shots[i] - shots[i - 1]).toFixed(2));
    const fc = weapons.current.fireClock ? weapons.current.fireClock() : null;
    runs.push({
      label,
      timeScale: e.time.scale,
      lifecycle: g.match && g.match.lifecycle ? g.match.lifecycle.state : null,
      playerHealth: +player.health.toFixed(1), playerAlive: player.alive, playerState: player.state,
      shotsIn3s: shots.length,
      impliedRpm: shots.length > 1 ? +(60000 / (gaps.reduce((x, y) => x + y, 0) / gaps.length)).toFixed(1) : 0,
      authoredRpm: weapons.current.def.rpm,
      gapsMs: gaps.slice(0, 10),
      simSecondsElapsed: +(e.time.elapsed - t0).toFixed(4),
      loopIterations: 360, fixedStepsRun: fixedSteps,
      fireClock: fc ? { interval: fc.interval, time: fc.time, nextShotAt: fc.nextShotAt } : null,
    });
  }

  measure('clean');
  // now take enemy fire the way the earlier probe did, then re-measure
  a.clearActors(); a.resetLifecycle(); player.health = 100;
  const lane = a.sightLane(14);
  player.camera.yaw = lane.yaw; player.camera.pitch = 0;
  a.setSpawnLock(true);
  for (let i = 0; i < 3; i++) a.spawnTarget(lane.yaw, 14, { seed: 900 + i, lateral: (i - 1) * 2.2 });
  a.setCombat(true); a.setFrozen(false);
  for (let i = 0; i < 120 * 6; i++) { hold([], []); e.stepFrame(1 / 120); if (player.health < 5) player.health = 100; }
  const afterFight = {
    timeScale: e.time.scale, health: player.health,
    lifecycle: g.match && g.match.lifecycle ? g.match.lifecycle.state : null,
  };
  measure('after taking fire');
  measure('after taking fire (2nd)');
  return { runs, afterFight };
});

console.log(JSON.stringify(out, null, 2));
await s.close();
await stopServer();
