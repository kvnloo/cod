#!/usr/bin/env node
/**
 * Sustained performance profile of ACTUAL PLAY, per quality preset.
 *
 * `tools/perf.mjs` already measures frame time — but it measures a parked
 * camera on a fixed shot, with no enemies, no combat and no movement. That
 * profile can look fine while the game is unplayable, which is exactly what
 * happened: the user reported "fps was really bad (maybe it was an ultra mode
 * test)" against builds whose perf gate was green.
 *
 * This tool answers that question definitively. For every preset it runs the
 * same scripted firefight — sprinting, sliding, shooting, taking hits — on the
 * real GPU with vsync off, and reports:
 *
 *   • wall-clock frame time p50 / p95 / p99 / p99.9 and the count of frames
 *     over 16.7 ms, 33 ms and 50 ms
 *   • the worst 1% of frames with what was on screen when they happened, plus
 *     a screenshot reconstructed from the worst frame's camera transform
 *   • GPU vs CPU bound classification, from the frame-body time and the
 *     EXT_disjoint_timer_query GPU time side by side
 *   • draw calls and triangles, mean and peak
 *
 * Usage
 *   node tools/perf-session.mjs
 *   node tools/perf-session.mjs --presets high,ultra --ms 12000
 *   node tools/perf-session.mjs --no-build --no-shots
 *
 * Exits non-zero when any preset misses its budget, so it drops into CI.
 * See docs/PLAYTEST.md.
 */

import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
// Single source of truth for the in-page probe: `session.exec` ships a function
// as source text, so these are forwarded by value, not imported into the page.
import { runLive, ensureScratchTmp, INSTALL_PROBE, INSTALL_INPUT_BRIDGE } from './playtest.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();

/* ------------------------------------------------------------------- args -- */

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

/**
 * Per-preset p99 budgets, in milliseconds.
 *
 * The brief fixes one of these: p99 <= 16.7 ms at 1080p/high, i.e. 60 fps.
 * The others follow from what each preset is *for*, measured on the reference
 * machine (RTX 3080 Ti):
 *
 *   low     6.94 ms (144 fps) — low exists so a competitive player can run the
 *                               game at a high refresh rate; ARCHITECTURE.md
 *                               additionally requires it to survive integrated
 *                               graphics, which needs ~5x headroom here.
 *   medium  8.33 ms (120 fps) — the console-parity preset. CoD ships 120 Hz
 *                               modes on Series X / PS5, so a 3080 Ti must
 *                               clear it comfortably.
 *   high   16.70 ms (60 fps)  — the brief's gate.
 *   ultra  16.70 ms (60 fps)  — ultra may cost more than high, but a preset
 *                               that cannot hold 60 fps on a 3080 Ti at 1080p
 *                               is not a preset, it is a screenshot mode.
 *
 * Override with --budgets low=8,high=20,...
 */
const DEFAULT_BUDGETS = { low: 6.94, medium: 8.33, high: 16.7, ultra: 16.7, cinematic: 33.3 };

const CFG = {
  port: Number(flag('port', 9901)),
  dist: String(flag('dist', 'dist-gp-h')),
  presets: String(flag('presets', 'low,medium,high,ultra')).split(',').map((s) => s.trim()),
  width: Number(flag('w', 1920)),
  height: Number(flag('h', 1080)),
  seed: Number(flag('seed', 1337)),
  mode: String(flag('mode', 'operation')),
  ms: Number(flag('ms', 12000)),
  warmupMs: Number(flag('warmup-ms', 2500)),
  outDir: String(flag('out', path.join('shots', 'perf-session'))),
  build: !has('no-build'),
  shots: !has('no-shots'),
};

const budgets = { ...DEFAULT_BUDGETS };
if (typeof flag('budgets') === 'string') {
  for (const pair of String(flag('budgets')).split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) budgets[k.trim()] = Number(v);
  }
}

/* --------------------------------------------------------------- timeline -- */

/**
 * The same firefight for every preset, so the numbers are comparable. It is
 * deliberately the busiest kind of play: sprinting through the level while
 * shooting, which is when particles, tracers, decals, dynamic lights and
 * character animation are all live at once.
 */
const COMBAT_TIMELINE = [
  { t: 0.0, hold: ['forward'] },
  { t: 0.8, hold: ['forward', 'sprint'], lookX: 1.5 },
  { t: 2.2, hold: ['forward', 'sprint', 'crouch'] },
  { t: 3.0, hold: ['forward', 'sprint', 'jump'] },
  { t: 3.8, hold: ['forward', 'fire'], lookX: -2 },
  { t: 5.0, hold: ['forward', 'ads', 'fire'], lookX: 1 },
  { t: 6.4, hold: ['left', 'fire'], lookX: 3 },
  { t: 7.6, hold: ['forward', 'sprint'], lookX: -3 },
  { t: 9.0, hold: ['forward', 'sprint', 'crouch'] },
  { t: 9.8, hold: ['forward', 'fire'], lookX: 2 },
  { t: 11.2, hold: ['back', 'ads', 'fire'], lookX: -1.5 },
  { t: 12.6, hold: ['forward', 'sprint'], lookX: 2 },
  { t: 14.0, hold: ['forward', 'fire'] },
];

/* ------------------------------------------------------------------- main -- */

const T0 = Date.now();
const stamp = () => `[${((Date.now() - T0) / 1000).toFixed(1)}s]`;
const pad = (s, n) => String(s).padStart(n);

async function main() {
  if (CFG.build) {
    console.log(`${stamp()} building → ${CFG.dist}`);
    const r = spawnSync('npx', ['vite', 'build', '--outDir', CFG.dist], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('vite build failed'); }
  }
  const base = await ensureServer({ port: CFG.port, outDir: CFG.dist });
  const outDir = path.isAbsolute(CFG.outDir) ? CFG.outDir : path.join(ROOT, CFG.outDir);
  await mkdir(outDir, { recursive: true });

  const results = [];
  let gpuName = 'unknown';

  for (const preset of CFG.presets) {
    console.log(`${stamp()} ── preset "${preset}" ${'─'.repeat(60)}`);
    const url = `${base}/?capture=1&quality=${preset}&mode=${CFG.mode}&seed=${CFG.seed}`;
    const session = await openSession({
      url, width: CFG.width, height: CFG.height, quality: preset, seed: CFG.seed,
    });
    gpuName = session.renderer;
    try {
      await session.exec(INSTALL_INPUT_BRIDGE);
      const boot = await session.exec(INSTALL_PROBE);
      if (!boot.ok) throw new Error('probe install failed');

      // Settle the match: past warm-up, first wave on the field, so every
      // preset profiles the same populated level rather than an empty one.
      await session.exec(() => {
        const a = globalThis.__PT__.api;
        a.setRender(false);
        for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);
        a.setRender(true);
      });
      const pre = await session.exec(() => globalThis.__PT__.api.snapshot());

      const live = await runLive(session, CFG.ms, CFG.warmupMs, COMBAT_TIMELINE);
      const f = live.frame;
      const budget = budgets[preset] ?? 16.7;
      const row = {
        preset, budgetMs: budget,
        width: CFG.width, height: CFG.height,
        frames: f.frames, durationMs: f.durationMs, warmupDiscardedFrames: f.warmupDiscardedFrames,
        meanMs: f.mean, p50: f.p50, p95: f.p95, p99: f.p99, p999: f.p999, worstMs: f.worst,
        meanFps: f.fps,
        over16_7: f.over16_7, over33: f.over33, over50: f.over50,
        cpuMs: f.cpuMs, gpuMs: f.gpuMs,
        drawCalls: f.drawCalls, triangles: f.triangles,
        bound: f.bound,
        worst1pctCount: f.worst1pctCount,
        worst1pctMeanMs: f.worst1pctMeanMs,
        worst1pct: f.worst1pct,
        enemiesAtStart: pre.live,
        pass: f.p99 <= budget && f.over50 === 0,
      };
      results.push(row);

      console.log(`${stamp()}   ${pad(f.frames, 5)} frames  (${f.warmupDiscardedFrames} warm-up discarded)  `
        + `over ${(f.durationMs / 1000).toFixed(1)} s`);
      console.log(`${stamp()}   p50 ${pad(f.p50, 8)}  p95 ${pad(f.p95, 8)}  p99 ${pad(f.p99, 8)}  `
        + `p99.9 ${pad(f.p999, 8)}  worst ${pad(f.worst, 8)}  → ${f.fps} fps mean`);
      console.log(`${stamp()}   frames >16.7 ms ${pad(f.over16_7, 5)}   >33 ms ${pad(f.over33, 5)}   `
        + `>50 ms ${pad(f.over50, 5)}`);
      console.log(`${stamp()}   cpu p50 ${pad(f.cpuMs.p50, 8)} ms   gpu mean `
        + `${pad(f.gpuMs ? f.gpuMs.mean : 'n/a', 8)} ms   → ${f.bound}`);
      console.log(`${stamp()}   draws ${pad(f.drawCalls.mean, 5)} mean / ${f.drawCalls.max} peak   `
        + `tris ${pad((f.triangles.mean / 1000).toFixed(0), 6)}k mean / ${(f.triangles.max / 1000).toFixed(0)}k peak`);
      console.log(`${stamp()}   worst 1% (${f.worst1pctCount} frames) mean ${f.worst1pctMeanMs} ms:`);
      for (const w of f.worst1pct.slice(0, 5)) {
        console.log(`${stamp()}     ${pad(w.ms, 8)} ms  t=${pad(w.t, 8)}ms  state=${String(w.st).padEnd(10)} `
          + `enemies=${pad(w.live, 2)}  hp=${pad(w.hp, 3)}  draws=${pad(w.dc, 5)}  tris=${pad(w.tri, 8)}  `
          + `gpu=${pad(w.gpu, 7)}ms  @ ${w.px},${w.py},${w.pz}`);
      }

      /* --- reconstruct the worst frame and photograph it ----------------- */
      if (CFG.shots && f.worst1pct.length) {
        const w = f.worst1pct[0];
        await session.exec((v) => {
          const e = globalThis.engine;
          const p = e.get('player');
          const to = p.position.clone().set(v.px, v.py, v.pz);
          p.movement.teleport(to, v.yaw);
          p.camera.reset(v.yaw, v.pitch);
          for (let i = 0; i < 12; i++) e.stepFrame(1 / 120);
        }, w);
        const file = path.join(outDir, `worst-${preset}.png`);
        await session.shoot(file);
        row.worstFrameShot = path.relative(ROOT, file);
        console.log(`${stamp()}   worst-frame view → ${row.worstFrameShot}`);
      }
      row.consoleErrors = session.errors.slice(0, 10);
    } finally {
      await session.close();
    }
  }

  /* ------------------------------------------------------------- summary -- */

  const report = {
    tool: 'perf-session', version: '1.0.0',
    meta: {
      gpu: gpuName, width: CFG.width, height: CFG.height, seed: CFG.seed, mode: CFG.mode,
      sessionMs: CFG.ms, warmupMs: CFG.warmupMs, dist: CFG.dist,
      startedAt: new Date().toISOString(), budgets,
    },
    presets: results,
  };
  const jsonPath = path.join(outDir, 'perf-session.json');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log('='.repeat(112));
  console.log(`PERF SESSION — ${CFG.width}x${CFG.height}, ${(CFG.ms / 1000).toFixed(0)} s of scripted combat per preset`);
  console.log(gpuName);
  console.log('='.repeat(112));
  console.log('preset    budget      p50      p95      p99    p99.9    worst   >16.7   >33   >50    fps   draws     tris  bound');
  console.log('-'.repeat(112));
  for (const r of results) {
    console.log(
      `${r.preset.padEnd(9)} ${pad(r.budgetMs.toFixed(2), 6)} ${pad(r.p50.toFixed(2), 8)} `
      + `${pad(r.p95.toFixed(2), 8)} ${pad(r.p99.toFixed(2), 8)} ${pad(r.p999.toFixed(2), 8)} `
      + `${pad(r.worstMs.toFixed(1), 8)} ${pad(r.over16_7, 7)} ${pad(r.over33, 5)} ${pad(r.over50, 5)} `
      + `${pad(r.meanFps.toFixed(0), 6)} ${pad(r.drawCalls.mean, 7)} ${pad((r.triangles.mean / 1000).toFixed(0) + 'k', 8)}  ${r.bound}`,
    );
  }
  console.log('-'.repeat(112));

  const fails = [];
  for (const r of results) {
    if (r.p99 > r.budgetMs) {
      fails.push(`${r.preset}: p99 ${r.p99.toFixed(2)} ms exceeds the ${r.budgetMs} ms budget `
        + `(${(r.budgetMs / r.p99 * 100).toFixed(0)}% of target — the game runs at ${r.meanFps.toFixed(0)} fps here)`);
    }
    if (r.over50 > 0) {
      fails.push(`${r.preset}: ${r.over50} frame(s) over 50 ms after warm-up (worst ${r.worstMs.toFixed(1)} ms)`);
    }
  }
  for (const f of fails) console.log(`FAIL  ${f}`);
  if (!fails.length) console.log('PASS  every preset held its budget.');

  // The question the user actually asked: was it an ultra-mode problem?
  const byPreset = Object.fromEntries(results.map((r) => [r.preset, r]));
  if (byPreset.low && byPreset.ultra) {
    const spread = byPreset.ultra.p50 / Math.max(0.001, byPreset.low.p50);
    console.log('');
    console.log(`VERDICT  "was it an ultra mode test?" — ultra costs ${spread.toFixed(2)}x low at p50 `
      + `(${byPreset.low.p50.toFixed(1)} ms → ${byPreset.ultra.p50.toFixed(1)} ms).`);
    const worstOk = results.filter((r) => r.p99 <= r.budgetMs).map((r) => r.preset);
    console.log(`         presets inside budget: ${worstOk.length ? worstOk.join(', ') : 'NONE'}.`);
    if (!worstOk.length) {
      console.log('         No preset holds its budget, so the framerate is not a quality-setting '
        + 'problem — it is a whole-build problem.');
    }
    const cpuBound = results.filter((r) => r.bound.startsWith('cpu')).map((r) => r.preset);
    if (cpuBound.length === results.length) {
      console.log('         Every preset is CPU-bound, which is why lowering quality barely helps: '
        + 'the cost is in the frame body, not in the rasteriser.');
    }
  }

  // A cheaper preset that measured slower than a dearer one is almost always
  // another process taking the GPU mid-run, not a real inversion. Say so rather
  // than letting someone read a conclusion out of contention noise.
  const inversions = [];
  const rank = ['low', 'medium', 'high', 'ultra', 'cinematic'];
  const ordered = results.slice().sort((a, b) => rank.indexOf(a.preset) - rank.indexOf(b.preset));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].p50 < ordered[i - 1].p50 * 0.97) {
      inversions.push(`${ordered[i].preset} (${ordered[i].p50.toFixed(1)} ms) measured cheaper than `
        + `${ordered[i - 1].preset} (${ordered[i - 1].p50.toFixed(1)} ms)`);
    }
  }
  if (inversions.length) {
    console.log('');
    console.log('NOTE     preset cost is not monotonic, which usually means the GPU was contended '
      + 'mid-run:');
    for (const s of inversions) console.log(`         • ${s}`);
    console.log('         Re-run with a longer --ms on an idle machine before drawing a conclusion '
      + 'about relative preset cost. The budget verdicts above are still valid — they are absolute.');
  }
  console.log(`report → ${jsonPath}`);

  await stopServer();
  if (fails.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  process.exit(1);
});
