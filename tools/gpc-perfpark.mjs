/**
 * Same scene, same camera, both capture modes, every preset.
 *
 * The scripted-walk profile is not comparable between a 30 fps run and a
 * 180 fps run: the fixed-step accumulator saturates on slow frames, so the slow
 * arm covers less ground and ends up looking at different geometry (measured:
 * 1527 draw calls vs 130). Parking the player at the spawn viewpoint holds the
 * scene constant so the only variable left is the renderer.
 *
 * Enemies are live and the player is firing, so particles, tracers, decals,
 * dynamic lights and character animation are all running.
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const PRESETS = String(arg('presets', 'low,medium,high,ultra')).split(',');
const CAPS = String(arg('captures', '1,0')).split(',');
const ADAPT = String(arg('adaptive', 'on')).split(',');
const REPS = +arg('reps', 1);
const MS = +arg('ms', 15000);
const base = await ensureServer({ port: +arg('port', 9951), outDir: arg('dist', 'dist-gpc-1') });
const out = [];
await mkdir(path.join(ROOT, 'shots/gpc-combat'), { recursive: true });

for (const preset of PRESETS) {
  for (const cap of CAPS) {
   for (const adaptive of ADAPT) {
    for (let rep = 0; rep < REPS; rep++) {
    const url = `${base}/?capture=${cap}&quality=${preset}&mode=operation&seed=1337`;
    const s = await openSession({ url, width: 1920, height: 1080, quality: preset, seed: 1337 });
    await s.exec(INSTALL_INPUT_BRIDGE);
    await s.exec(INSTALL_PROBE);
    const setup = await s.exec((ad) => {
      const R = globalThis.__RENDER__;
      if (ad === 'off' && R) R.setAdaptive(false);
      const a = globalThis.__PT__.api, e = globalThis.engine;
      const player = e.get('player');
      a.setRender(false);
      for (let i = 0; i < 900; i++) e.stepFrame(1 / 120);
      a.setRender(true);
      a.markHome(true);
      a.setCombat(true); a.setFrozen(false); a.setSpawnLock(true); a.resetLifecycle(); a.refill();
      a.clearActors();
      // three live enemies in front, so the frame carries characters + fire
      const lane = a.sightLane(18);
      player.camera.yaw = lane.yaw; player.camera.pitch = 0;
      for (let i = 0; i < 3; i++) a.spawnTarget(lane.yaw, 18, { seed: 1200 + i, lateral: (i - 1) * 2.5 });
      for (let i = 0; i < 120; i++) e.stepFrame(1 / 120);
      return { yaw: player.camera.yaw, pos: [player.position.x, player.position.z] };
    }, adaptive);

    const res = await s.page.evaluate(async (ms) => {
      const e = globalThis.engine;
      const render = e.get('render');
      const player = e.get('player');
      const a = globalThis.__PT__.api;
      const hold = globalThis.__PT_HOLD__;
      const home = { p: player.position.clone(), yaw: player.camera.yaw };
      const wall = [], samples = [];
      const orig = e.frame.bind(e);
      let last = -1, next = 0;
      const t0 = performance.now();
      e.frame = function () {
        const t = performance.now();
        if (last >= 0) wall.push(t - last);
        last = t;
        // hold position and aim: the scene must not drift between arms
        player.movement.teleport(home.p, home.yaw);
        player.camera.yaw = home.yaw; player.camera.pitch = 0;
        hold(['ads', 'fire'], []);
        a.refill();
        // hold the scene: nobody dies, so every arm renders the same firefight
        player.health = player.maxHealth;
        const bots = globalThis.__BLACKOUT_GAME__.services.actors.bots || [];
        for (const b of bots) if (b.alive) b.health = b.maxHealth;
        orig();
        const el = (t - t0) / 1000;
        if (el >= next) {
          next = el + 1;
          const st = render.stats();
          samples.push({
            t: +el.toFixed(2), dc: st.drawCalls, tri: st.triangles,
            gpuMs: +st.gpuMs.toFixed(3), shadowMs: st.shadowMs, exposureMs: st.exposureMs,
            captureSync: st.captureSync, dial: st.budget ? st.budget.dial : -1,
            rung: st.budget ? st.budget.rung : null,
            live: globalThis.__BLACKOUT_GAME__.services.actors.liveCount(),
          });
        }
      };
      e.cameraLockedByCapture = false;
      e.start();
      await new Promise((r) => setTimeout(r, ms));
      e.stop();
      e.frame = orig;
      hold([], []);
      const keep = [];
      let acc = 0;
      for (const v of wall) { acc += v; if (acc >= 3000) keep.push(v); }
      const sorted = keep.slice().sort((x, y) => x - y);
      const p = (q) => sorted[Math.min(sorted.length - 1, Math.round((q / 100) * (sorted.length - 1)))];
      const mean = (arr) => arr.reduce((x, y) => x + y, 0) / Math.max(1, arr.length);
      return {
        frames: keep.length,
        p50: +p(50).toFixed(3), p90: +p(90).toFixed(3), p95: +p(95).toFixed(3),
        p99: +p(99).toFixed(3), worst: +sorted[sorted.length - 1].toFixed(3),
        over16: keep.filter((v) => v > 16.7).length,
        over33: keep.filter((v) => v > 33).length,
        over50: keep.filter((v) => v > 50).length,
        fps: +(1000 / mean(keep)).toFixed(1),
        meanDc: Math.round(mean(samples.map((x) => x.dc))),
        meanTri: Math.round(mean(samples.map((x) => x.tri))),
        meanGpu: +mean(samples.map((x) => x.gpuMs)).toFixed(3),
        meanShadow: +mean(samples.map((x) => x.shadowMs)).toFixed(3),
        meanExposure: +mean(samples.map((x) => x.exposureMs)).toFixed(3),
        captureSync: samples[0] ? samples[0].captureSync : null,
        dialEnd: samples.length ? samples[samples.length - 1].dial : -1,
        rungEnd: samples.length ? samples[samples.length - 1].rung : null,
        liveEnemies: samples.length ? samples[samples.length - 1].live : -1,
        samples,
      };
    }, MS);

    const label = `${preset}-cap${cap}-ad${adaptive}-r${rep}`;
    console.log(
      `${label.padEnd(12)} p50 ${String(res.p50).padStart(7)}  p90 ${String(res.p90).padStart(7)}  p99 ${String(res.p99).padStart(7)}  `
      + `worst ${String(res.worst).padStart(7)}  fps ${String(res.fps).padStart(6)}  >16.7 ${String(res.over16).padStart(4)}/${res.frames}  >50 ${res.over50}  `
      + `| dc ${res.meanDc} tri ${(res.meanTri / 1000).toFixed(0)}k gpu ${res.meanGpu} shadow ${res.meanShadow} expo ${res.meanExposure} sync ${res.captureSync} dial ${res.dialEnd}(${res.rungEnd})`);
    await s.shoot(path.join(ROOT, `shots/gpc-combat/park-${label}.png`));
    out.push({ label, preset, capture: cap, adaptive, rep, setup, ...res });
    await s.close();
    }
   }
  }
}
await writeFile(path.join(ROOT, 'shots/gpc-combat/perfpark.json'), JSON.stringify(out, null, 2));
await stopServer();
