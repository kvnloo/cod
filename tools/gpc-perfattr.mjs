/**
 * Where the frame time goes, and what the adaptive governor is doing to the
 * picture to buy it. capture=1 vs capture=0 at the same preset, with the
 * governor's own telemetry sampled through the whole run, plus a screenshot of
 * each so the framerate win can be checked against the image.
 */
import { openSession, ensureServer, stopServer, ROOT, sleep } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const PRESET = arg('preset', 'high');
const MS = +arg('ms', 18000);
const base = await ensureServer({ port: +arg('port', 9951), outDir: arg('dist', 'dist-gpc-1') });

const TIMELINE = [
  { t: 0.0, hold: ['forward'] },
  { t: 1.0, hold: ['forward', 'sprint'] },
  { t: 2.5, hold: ['forward', 'sprint', 'crouch'] },
  { t: 3.2, hold: ['forward', 'sprint', 'jump'] },
  { t: 4.0, hold: ['forward', 'left'] },
  { t: 5.0, hold: ['forward', 'fire'] },
  { t: 6.0, hold: ['forward', 'ads', 'fire'] },
  { t: 7.5, hold: ['back', 'right'] },
  { t: 8.5, hold: ['forward', 'sprint'] },
  { t: 10.0, hold: ['forward', 'sprint', 'crouch'] },
  { t: 10.8, hold: ['forward', 'jump'] },
  { t: 11.5, hold: ['forward', 'fire'] },
  { t: 13.0, hold: ['forward', 'ads', 'fire'] },
];

const out = [];
await mkdir(path.join(ROOT, 'shots/gpc-combat'), { recursive: true });

for (const cap of ['1', '0']) {
  for (const adaptive of cap === '0' ? ['on', 'off'] : ['n/a']) {
    const url = `${base}/?capture=${cap}&quality=${PRESET}&mode=operation&seed=1337`;
    const s = await openSession({ url, width: 1920, height: 1080, quality: PRESET, seed: 1337 });
    await s.exec(INSTALL_INPUT_BRIDGE);
    await s.exec(INSTALL_PROBE);
    await s.exec((a) => {
      const R = globalThis.__RENDER__;
      if (a === 'off' && R) R.setAdaptive(false);
      const api = globalThis.__PT__.api;
      api.setRender(false);
      for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);
      api.setRender(true);
      api.setCombat(true); api.setFrozen(false); api.setSpawnLock(false); api.resetLifecycle(); api.refill();
    }, adaptive);

    const res = await s.page.evaluate(async ([tl, ms]) => {
      const e = globalThis.engine;
      const render = e.get('render');
      const player = e.get('player');
      const hold = globalThis.__PT_HOLD__;
      const wall = [], samples = [];
      const orig = e.frame.bind(e);
      let last = -1, cursor = -1;
      const t0 = performance.now();
      let nextSample = 0;
      e.frame = function () {
        const a = performance.now();
        if (last >= 0) wall.push(a - last);
        last = a;
        const t = (a - t0) / 1000;
        let idx = 0;
        for (let i = 0; i < tl.length; i++) if (t >= tl[i].t) idx = i;
        hold(tl[idx].hold || [], idx !== cursor ? (tl[idx].press || []) : []);
        cursor = idx;
        orig();
        if (t >= nextSample) {
          nextSample = t + 0.5;
          const st = render.stats();
          samples.push({
            t: +t.toFixed(2), dc: st.drawCalls, tri: st.triangles,
            gpuMs: +st.gpuMs.toFixed(3), shadowMs: st.shadowMs, exposureMs: st.exposureMs,
            captureSync: st.captureSync,
            dial: st.budget ? st.budget.dial : -1,
            rung: st.budget ? st.budget.rung : null,
            budgetEnabled: st.budget ? st.budget.enabled : null,
            p90: st.budget ? +(st.budget.p90Ms || 0).toFixed(2) : -1,
            target: st.budget ? st.budget.targetMs : -1,
            renderScale: globalThis.__RENDER__ ? globalThis.__RENDER__.gfx.renderScale : null,
            shadowHz: globalThis.__RENDER__ ? globalThis.__RENDER__.gfx.shadowUpdateHz : null,
            cascades: globalThis.__RENDER__ ? globalThis.__RENDER__.gfx.shadowCascades : null,
            ssao: globalThis.__RENDER__ ? globalThis.__RENDER__.gfx.ssao : null,
            ssr: globalThis.__RENDER__ ? globalThis.__RENDER__.gfx.ssr : null,
            volumetrics: globalThis.__RENDER__ ? globalThis.__RENDER__.gfx.volumetrics : null,
            px: +player.position.x.toFixed(1), pz: +player.position.z.toFixed(1),
          });
        }
      };
      e.cameraLockedByCapture = false;
      e.start();
      await new Promise((r) => setTimeout(r, ms));
      e.stop();
      e.frame = orig;
      hold([], []);
      // drop the first 3 s
      const keep = [];
      let acc = 0;
      for (const v of wall) { acc += v; if (acc >= 3000) keep.push(v); }
      keep.sort((a, b) => a - b);
      const p = (q) => keep[Math.min(keep.length - 1, Math.round((q / 100) * (keep.length - 1)))];
      return {
        frames: keep.length,
        p50: +p(50).toFixed(3), p90: +p(90).toFixed(3), p95: +p(95).toFixed(3),
        p99: +p(99).toFixed(3), worst: +keep[keep.length - 1].toFixed(3),
        over16: keep.filter((v) => v > 16.7).length,
        over50: keep.filter((v) => v > 50).length,
        fps: +(1000 / (keep.reduce((a, b) => a + b, 0) / keep.length)).toFixed(1),
        samples,
      };
    }, [TIMELINE, MS]);

    const label = `${PRESET}-cap${cap}-adaptive-${adaptive}`;
    const last = res.samples[res.samples.length - 1] || {};
    console.log(
      `${label.padEnd(28)} p50 ${String(res.p50).padStart(7)}  p90 ${String(res.p90).padStart(7)}  p99 ${String(res.p99).padStart(7)}  `
      + `fps ${String(res.fps).padStart(6)}  >50 ${res.over50}  |  dial ${last.dial} rung ${last.rung} dc ${last.dc} `
      + `scale ${last.renderScale} shadowHz ${last.shadowHz} casc ${last.cascades} ssao ${last.ssao} ssr ${last.ssr} vol ${last.volumetrics} captureSync ${last.captureSync}`);
    console.log(`    dial over time: ${res.samples.filter((_, i) => i % 4 === 0).map((s) => `${s.t}s:${s.dial}`).join(' ')}`);
    await s.shoot(path.join(ROOT, `shots/gpc-combat/${label}.png`));
    out.push({ label, capture: cap, adaptive, ...res });
    await s.close();
  }
}

await writeFile(path.join(ROOT, 'shots/gpc-combat/perfattr.json'), JSON.stringify(out, null, 2));
await stopServer();
