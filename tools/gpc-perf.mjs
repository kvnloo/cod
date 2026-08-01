/**
 * Frame time as a PLAYER experiences it.
 *
 * The repo's own perf tools all drive the game with `?capture=1`. Package G6
 * claims that mode costs ~7 ms/frame that no player pays. This runs the SAME
 * scripted firefight at each preset in BOTH modes, plus a noise floor for the
 * box, so the claim is measured rather than believed.
 */
import { openSession, ensureServer, stopServer, ROOT, sleep, percentile } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, runLive, ensureScratchTmp } from './playtest.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const CFG = {
  port: +arg('port', 9951),
  dist: arg('dist', 'dist-gpc-1'),
  presets: String(arg('presets', 'low,medium,high,ultra')).split(','),
  captures: String(arg('captures', '1,0')).split(','),
  ms: +arg('ms', 16000),
  warmup: +arg('warmup', 3000),
  w: +arg('w', 1920), h: +arg('h', 1080),
  reps: +arg('reps', 1),
};

const base = await ensureServer({ port: CFG.port, outDir: CFG.dist });
const results = [];

/* --------------------------------------------------------- noise floor -- */
{
  const s = await openSession({ url: base, width: CFG.w, height: CFG.h, quality: 'low', seed: 1337 });
  const floor = await s.page.evaluate(async () => {
    // Same browser, same page, nothing but rAF. Anything here is the box.
    const engine = globalThis.engine;
    engine.stop();
    const t = [];
    let last = -1;
    await new Promise((res) => {
      const t0 = performance.now();
      const loop = () => {
        const a = performance.now();
        if (last >= 0) t.push(a - last);
        last = a;
        if (a - t0 > 5000) return res();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    t.sort((x, y) => x - y);
    const p = (q) => t[Math.min(t.length - 1, Math.round((q / 100) * (t.length - 1)))];
    return { frames: t.length, p50: +p(50).toFixed(3), p99: +p(99).toFixed(3), worst: +t[t.length - 1].toFixed(3), over16: t.filter((v) => v > 16.7).length };
  });
  console.log(`noise floor (idle rAF, engine stopped): p50 ${floor.p50} p99 ${floor.p99} worst ${floor.worst} ms, ${floor.over16} frames >16.7 of ${floor.frames}`);
  results.push({ kind: 'noise-floor', ...floor });
  await s.close();
}

/* ----------------------------------------------------- preset × capture -- */
for (const preset of CFG.presets) {
  for (const cap of CFG.captures) {
    for (let rep = 0; rep < CFG.reps; rep++) {
      const url = `${base}/?capture=${cap}&quality=${preset}&mode=operation&seed=1337`;
      const s = await openSession({ url, width: CFG.w, height: CFG.h, quality: preset, seed: 1337 });
      await s.exec(INSTALL_INPUT_BRIDGE);
      await s.exec(INSTALL_PROBE);
      // make sure the requested preset really took, and the match is running
      const env = await s.exec((p) => {
        const e = globalThis.engine;
        const g = globalThis.__BLACKOUT_GAME__;
        try { globalThis.__BLACKOUT__.setQuality(p); } catch { /* live path may refuse */ }
        const st = e.get('render').stats ? e.get('render').stats() : {};
        return {
          preset: (globalThis.settings || {}).gfx ? null : null,
          phase: g.phase,
          captureMode: !!(globalThis.__BLACKOUT__ && globalThis.__BLACKOUT__.readyFlag),
          pixelRatio: window.devicePixelRatio,
          drawCalls: st.drawCalls ?? null,
        };
      }, preset);
      // 7.5 s of sim so the match is live and the first wave is out
      await s.exec(() => {
        const a = globalThis.__PT__.api;
        a.setRender(false);
        for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);
        a.setRender(true);
      });
      const live = await runLive(s, CFG.ms, CFG.warmup);
      const f = live.frame;
      const row = {
        kind: 'preset', preset, capture: cap, rep, phase: env.phase,
        frames: f.frames, p50: f.p50, p95: f.p95, p99: f.p99, worst: f.worst,
        over16: f.over16_7, over33: f.over33, over50: f.over50, fps: f.fps,
        cpuP50: f.cpuMs.p50, gpuMean: f.gpuMs ? f.gpuMs.mean : null,
        drawCalls: f.drawCalls.mean, tris: f.triangles.mean, bound: f.bound,
        worst1pctMean: f.worst1pctMeanMs,
        worstContext: f.worst1pct.slice(0, 4),
        errors: s.errors.length,
      };
      results.push(row);
      console.log(
        `${preset.padEnd(7)} capture=${cap} rep${rep}  p50 ${String(row.p50).padStart(7)}  p95 ${String(row.p95).padStart(7)}  `
        + `p99 ${String(row.p99).padStart(7)}  worst ${String(row.worst).padStart(7)}  fps ${String(row.fps).padStart(6)}  `
        + `>16.7 ${String(row.over16).padStart(4)}/${row.frames}  >50 ${row.over50}  dc ${row.drawCalls}  ${row.bound}`);
      await s.close();
    }
  }
}

await mkdir(path.join(ROOT, 'shots/gpc-combat'), { recursive: true });
await writeFile(path.join(ROOT, 'shots/gpc-combat/perf.json'), JSON.stringify({ cfg: CFG, results }, null, 2));
console.log(`\nreport → shots/gpc-combat/perf.json`);
await stopServer();
