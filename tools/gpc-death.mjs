/**
 * Honest death path: let the player be killed by real enemies, then keep
 * simulating and watch Time.scale, the lifecycle and the match phase.
 * Nothing is forced — no health writes, no lifecycle resets.
 */
import { openSession, ensureServer, stopServer } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };

const base = await ensureServer({ port: +arg('port', 9951), outDir: arg('dist', 'dist-gpc-1') });
const url = `${base}/?capture=1&quality=high&mode=${arg('mode','operation')}&seed=1337`;
const s = await openSession({ url, width: 1280, height: 720, quality: 'high', seed: 1337 });
await s.exec(INSTALL_INPUT_BRIDGE);
await s.exec(INSTALL_PROBE);

const out = await s.exec((mode) => {
  const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
  const g = globalThis.__BLACKOUT_GAME__;
  const player = e.get('player');
  const weapons = e.get('weapons');
  const hold = globalThis.__PT_HOLD__;
  a.setRender(false);
  for (let i = 0; i < 900; i++) e.stepFrame(1 / 120);
  a.markHome();

  const snap = () => ({
    scale: +e.time.scale.toFixed(4),
    life: g.match && g.match.lifecycle ? g.match.lifecycle.state : null,
    slowMoTimer: g.match && g.match.lifecycle ? +(g.match.lifecycle.slowMoTimer ?? -1).toFixed(3) : -1,
    respawnIn: g.match && g.match.lifecycle ? +(g.match.lifecycle.respawnRemaining ?? -1).toFixed(2) : -1,
    downedIn: g.match && g.match.lifecycle ? +(g.match.lifecycle.downedRemaining ?? -1).toFixed(2) : -1,
    phase: g.phase,
    paused: g.match ? !!g.match.paused : null,
    hp: +player.health.toFixed(1),
    alive: player.alive,
    fireRpm: null,
  });

  // three real enemies at 12 m, player does not fight back
  a.setSpawnLock(true);
  const lane = a.sightLane(12);
  player.camera.yaw = lane.yaw; player.camera.pitch = 0;
  for (let i = 0; i < 3; i++) a.spawnTarget(lane.yaw, 12, { seed: 1000 + i, lateral: (i - 1) * 2.4 });
  a.setCombat(true); a.setFrozen(false);

  const timeline = [];
  const t0 = e.time.elapsed;
  let realSeconds = 0;
  let died = -1;
  // 90 seconds of WALL-equivalent stepping: 1/120 per call, 120*90 calls.
  for (let i = 0; i < 120 * 90; i++) {
    hold([], []);
    e.stepFrame(1 / 120);
    realSeconds = i / 120;
    if ((i % 60) === 0) {
      const sn = snap();
      sn.tReal = +realSeconds.toFixed(2);
      sn.tSim = +(e.time.elapsed - t0).toFixed(2);
      timeline.push(sn);
    }
    if (died < 0 && !player.alive) died = realSeconds;
  }

  // now try to play: sprint forward and fire, see what the sim does
  const probe = [];
  let prevAmmo = weapons.current ? weapons.current.ammo : 0;
  const shotTimes = [];
  const pStart = e.time.elapsed;
  let fixedSteps = 0;
  for (let i = 0; i < 120 * 4; i++) {
    hold(['forward', 'sprint', 'fire'], i === 0 ? ['fire'] : []);
    e.stepFrame(1 / 120);
    fixedSteps += e.time.steps;
    const am = weapons.current ? weapons.current.ammo : 0;
    if (am < prevAmmo) shotTimes.push(+((e.time.elapsed - pStart) * 1000).toFixed(2));
    prevAmmo = am;
  }
  hold([], []);
  const gaps = [];
  for (let i = 1; i < shotTimes.length; i++) gaps.push(+(shotTimes[i] - shotTimes[i - 1]).toFixed(2));

  return {
    mode,
    diedAtRealSeconds: died,
    timelineEvery0_5s: timeline,
    final: snap(),
    afterDeathPlayTest: {
      wallSecondsDriven: 4,
      simSecondsAdvanced: +(e.time.elapsed - pStart).toFixed(3),
      fixedStepsRun: fixedSteps,
      fixedStepsExpected: 480,
      shots: shotTimes.length,
      meanGapMs: gaps.length ? +(gaps.reduce((x, y) => x + y, 0) / gaps.length).toFixed(2) : 0,
      authoredRpm: weapons.current ? weapons.current.def.rpm : 0,
      impliedRpm: gaps.length ? +(60000 / (gaps.reduce((x, y) => x + y, 0) / gaps.length)).toFixed(1) : 0,
    },
  };
}, 'operation');

console.log(JSON.stringify(out, null, 2));
await s.close();
await stopServer();
