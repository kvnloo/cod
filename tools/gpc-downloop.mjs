/**
 * The user's exact scenario: "after getting downed i would just get shot at for
 * 60s without dying." That is the down → self-revive → down loop, and it needs
 * SPARSE fire to appear — the 3-rifles-at-20 m gate is far too lethal to reach
 * it. Sweeps enemy count / range / accuracy and reports whether the player ever
 * actually dies inside 90 s.
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
await s.exec(() => {
  const a = globalThis.__PT__.api;
  a.setRender(false);
  for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);
  a.markHome(true);
});

const CASES = [
  { n: 1, m: 35, acc: 0.25 },
  { n: 1, m: 45, acc: 0.15 },
  { n: 2, m: 40, acc: 0.2 },
  { n: 1, m: 25, acc: 0.35 },
];
const rows = [];
for (const c of CASES) {
  const row = await s.exec((cfg) => {
    const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
    const g = globalThis.__BLACKOUT_GAME__;
    const player = e.get('player');
    const hold = globalThis.__PT_HOLD__;
    a.setRender(false); a.setSpawnLock(true); a.clearActors();
    a.resetLifecycle(); a.goHome(); player.health = 100;
    a.setAccuracy(cfg.acc);
    const lane = a.sightLane(cfg.m);
    player.camera.yaw = lane.yaw; player.camera.pitch = 0;
    let spawned = 0;
    for (let i = 0; i < cfg.n; i++) {
      const r = a.spawnTarget(lane.yaw, cfg.m, { seed: 1500 + i, lateral: (i - 0.5) * 3, accuracy: cfg.acc });
      if (r.id >= 0) spawned++;
    }
    a.setCombat(true); a.setFrozen(false);
    a.resetCounters();
    const t0 = e.time.elapsed;
    const events = [];
    let last = null, downCycles = 0, revives = 0, died = -1;
    for (let i = 0; i < 120 * 90; i++) {
      hold([], []);
      e.stepFrame(1 / 120);
      const st = g.match && g.match.lifecycle ? g.match.lifecycle.state : null;
      if (st !== last) {
        const ms = +((e.time.elapsed - t0) * 1000).toFixed(0);
        events.push({ ms, to: st, hp: +player.health.toFixed(1) });
        if (st === 'downed') downCycles++;
        if (last === 'downed' && st === 'alive') revives++;
        if ((st === 'dead' || st === 'respawning') && died < 0) died = ms;
        last = st;
      }
      if (died > 0) break;
    }
    a.setAccuracy(1); a.setSpawnLock(false);
    return {
      ...cfg, spawned, laneOk: lane.ok,
      diedMs: died, downCycles, revivesFromDowned: revives,
      hits: P.playerDamage.length,
      events: events.slice(0, 24),
    };
  }, c);
  rows.push(row);
  console.log(`n=${row.n} range=${row.m}m acc=${row.acc} spawned=${row.spawned} → died ${row.diedMs < 0 ? 'NEVER in 90 s' : row.diedMs + ' ms'}  downCycles ${row.downCycles}  revives ${row.revivesFromDowned}  hits ${row.hits}`);
  console.log(`   ${row.events.map((x) => `${x.ms}:${x.to}(${x.hp})`).join(' → ')}`);
}
await mkdir(path.join(ROOT, 'shots/gpc-combat'), { recursive: true });
await writeFile(path.join(ROOT, 'shots/gpc-combat/downloop.json'), JSON.stringify(rows, null, 2));
console.log(`console errors: ${s.errors.length}`);
await s.close();
await stopServer();
