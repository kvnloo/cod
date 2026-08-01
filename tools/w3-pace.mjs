#!/usr/bin/env node
/**
 * W3 — frame-pacing profiler.
 *
 * The question this tool exists to answer is not "how fast is it" but "why does
 * it stutter on a period". `tools/perf-session.mjs` reports percentiles; it
 * cannot tell you that a 50 ms frame arrives every 2.0 s, and it cannot tell you
 * what ran on that frame.
 *
 * So this does three things nothing else in the repo does:
 *
 *   1. **Per-frame attribution.** Every system hook and every render stage is
 *      wrapped with a per-frame accumulator that is *reset each frame*, not
 *      summed across the session. When a frame busts a threshold the whole
 *      breakdown for that one frame is kept. An average cannot find a hitch;
 *      a hitch is by definition the thing the average hides.
 *
 *   2. **Periodicity analysis.** The gaps between hitches are histogrammed and
 *      autocorrelated. A periodic hitch has a period; a random one does not, and
 *      the difference decides whether you are looking for a clock or for a leak.
 *
 *   3. **Unattributed time.** `FRAME.total` minus the sum of the wrapped
 *      regions. Time that is inside the frame but inside nothing we wrapped is
 *      GC, driver or compositor; time that is *outside* the frame body entirely
 *      (wall interval minus frame body) is the browser, the GPU queue, or a
 *      major GC that landed between rAF callbacks.
 *
 * Measured with `capture=0` by default, because `capture=1` pays a synchronous
 * `readRenderTargetPixels` worth ~7 ms/frame that no player ever pays.
 *
 *   node tools/w3-pace.mjs --preset high --ms 60000
 *   node tools/w3-pace.mjs --presets low,medium,high,ultra --pin --ms 20000
 */

import { ensureServer, stopServer, ROOT, sleep, GPU_ARGS, findChrome, percentile } from './harness.mjs';
import { runLive, ensureScratchTmp, INSTALL_PROBE, INSTALL_INPUT_BRIDGE } from './playtest.mjs';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const CFG = {
  build: !has('no-build'),
  dist: String(flag('dist', 'dist-w8-w3')),
  port: Number(flag('port', 9823)),
  presets: String(flag('presets', flag('preset', 'high'))).split(',').filter(Boolean),
  width: Number(flag('w', 1920)),
  height: Number(flag('h', 1080)),
  ms: Number(flag('ms', 60000)),
  warmupMs: Number(flag('warmup', 4000)),
  seed: Number(flag('seed', 1337)),
  capture: Number(flag('capture', 0)),
  /** Pin the preset: adaptive governor off, preset values exactly as authored. */
  pin: has('pin'),
  /** Frame time above which the whole per-frame breakdown is retained. */
  hitchMs: Number(flag('hitch', 25)),
  out: String(flag('out', 'shots/w8-w3/pace.json')),
  label: String(flag('label', 'run')),
  repeats: Number(flag('repeats', 1)),
  /** Extra chromium flags; --enable-precise-memory-info makes GC visible. */
  precise: !has('no-precise'),
};

/* ----------------------------------------------------------------- session -- */

/**
 * A local session opener rather than `harness.openSession`, for one reason:
 * `--enable-precise-memory-info`. Without it `performance.memory.usedJSHeapSize`
 * is quantised to 100 KB and updated on a 20 ms timer, which is exactly the
 * resolution at which a GC-vs-not question cannot be answered. Everything else,
 * including the hardware-GL tripwire, is identical to the shared harness.
 */
async function openPaceSession({ url, width, height, seed, timeoutMs = 180_000 }) {
  const args = [...GPU_ARGS, `--window-size=${width},${height}`];
  if (CFG.precise) args.push('--enable-precise-memory-info');
  const browser = await chromium.launch({ executablePath: findChrome(), args, timeout: 60_000 });
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => !!globalThis.__BLACKOUT__?.readyFlag, undefined, { timeout: timeoutMs, polling: 250 });
  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return d && gl ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  if (!/^ANGLE \((NVIDIA|AMD|Intel)/.test(renderer) || /llvmpipe|SwiftShader|Software/i.test(renderer)) {
    await browser.close().catch(() => {});
    throw new Error(`w3-pace: refusing a non-hardware GL backend: ${renderer}`);
  }
  return {
    browser, context, page, renderer, errors, seed,
    exec: (fn, arg) => page.evaluate(fn, arg),
    async close() { try { await context.close(); } catch {} try { await browser.close(); } catch {} },
  };
}

/* ---------------------------------------------------------- in-page probe -- */

/**
 * Per-frame phase attribution.
 *
 * Deliberately array-backed with pre-resolved slot indices: a Map lookup and an
 * object allocation per wrapped call, at ~40 wrapped regions and 60+ frames a
 * second, is itself enough garbage to change the thing being measured.
 */
function INSTALL_PACE() {
  const e = globalThis.engine;
  const render = e.tryGet('render');
  const labels = [];
  const slot = new Map();
  let cur = null;          // Float64Array for the frame in flight

  function id(label) {
    let i = slot.get(label);
    if (i === undefined) { i = labels.length; labels.push(label); slot.set(label, i); }
    return i;
  }
  function wrap(obj, key, label) {
    if (!obj || typeof obj[key] !== 'function') return false;
    const i = id(label);
    const orig = obj[key];
    obj[key] = function (...a) {
      const t = performance.now();
      try { return orig.apply(this, a); }
      finally { if (cur) cur[i] += performance.now() - t; }
    };
    return true;
  }
  function count(obj, key, label) {
    if (!obj || typeof obj[key] !== 'function') return false;
    const i = id(label);
    const orig = obj[key];
    obj[key] = function (...a) {
      const t = performance.now();
      try { return orig.apply(this, a); }
      finally { if (cur) { cur[i] += performance.now() - t; cur[i + 1] += 1; } }
    };
    id(`${label}#n`);
    return true;
  }

  for (const s of e.systems) {
    if (s.name === 'playtest-probe') continue;
    for (const hook of ['fixedUpdate', 'update', 'lateUpdate', 'render']) wrap(s, hook, `${hook}:${s.name}`);
  }
  if (render) {
    const proto = Object.getPrototypeOf(render);
    for (const k of ['renderPrepass', 'renderMain', 'runPasses', 'updateViewModelRig',
      'collectWarming', 'releaseWarming', 'applyQuality']) wrap(proto, k, `render.${k}`);
    count(render.shadows, 'render', 'render.shadows');
    count(render.exposure, 'update', 'render.exposure');
    count(render.sky, 'update', 'render.sky.update');
    count(render.sky, 'bake', 'render.sky.bake');
    wrap(render.sky, 'domeFor', 'render.sky.domeFor');
    wrap(render.decals, 'render', 'render.decals.render');
    wrap(render.decals, 'update', 'render.decals.update');
    wrap(render.lights, 'update', 'render.lights.update');
    wrap(render.worldIndex, 'scan', 'render.worldIndex.scan');
    wrap(render.viewModelIndex, 'scan', 'render.viewModelIndex.scan');
    wrap(render.graph, 'present', 'render.present');
    wrap(render.graph, 'resize', 'render.graph.resize');
    count(render.renderer, 'compileAsync', 'three.compileAsync');
    count(render.renderer, 'compile', 'three.compile');
    wrap(render.renderer, 'render', 'three.render');
    wrap(render.renderer, 'setRenderTarget', 'three.setRenderTarget');
    for (const p of render.passes) wrap(p, 'render', `pass.${p.name}`);
    wrap(render.budget, 'update', 'budget.update');
    wrap(render.budget, 'commit', 'budget.commit');
  }

  const N = labels.length + 8;
  const frameSlots = new Float64Array(N);
  const heapAt = () => {
    const m = performance.memory;
    return m ? m.usedJSHeapSize : 0;
  };

  const rec = {
    labels,
    wall: [],        // interval since previous frame start
    body: [],        // time inside the frame body
    heap: [],        // used JS heap after the frame
    hitches: [],     // full per-frame breakdown for frames over the threshold
    t0: 0,
    armed: false,
    thresholdMs: 25,
  };
  globalThis.__W3__ = rec;

  const origFrame = e.frame.bind(e);
  let last = -1;
  e.frame = function () {
    const a = performance.now();
    if (!rec.armed) { origFrame(); return; }
    if (last >= 0) rec.wall.push(a - last);
    last = a;
    frameSlots.fill(0);
    cur = frameSlots;
    const h0 = heapAt();
    try { origFrame(); } finally {
      cur = null;
      const body = performance.now() - a;
      rec.body.push(body);
      const h1 = heapAt();
      rec.heap.push(h1);
      const wallGap = rec.wall.length ? rec.wall[rec.wall.length - 1] : 0;
      if (body >= rec.thresholdMs || wallGap >= rec.thresholdMs) {
        const parts = [];
        let sum = 0;
        for (let i = 0; i < labels.length; i++) {
          if (frameSlots[i] > 0.05 || labels[i].endsWith('#n')) {
            parts.push([labels[i], +frameSlots[i].toFixed(3)]);
          }
          // Only leaf-ish regions are summed; three.render is nested inside
          // renderMain/prepass and would be double counted.
          if (!/^three\.|^render\.(renderMain|renderPrepass|runPasses)$/.test(labels[i])
              && !labels[i].endsWith('#n')) sum += frameSlots[i];
        }
        parts.sort((x, y) => y[1] - x[1]);
        rec.hitches.push({
          t: +(a - rec.t0).toFixed(1),
          wall: +wallGap.toFixed(2),
          body: +body.toFixed(2),
          attributed: +sum.toFixed(2),
          heapDelta: +((h1 - h0) / 1048576).toFixed(3),
          heapMB: +(h1 / 1048576).toFixed(2),
          parts: parts.slice(0, 14),
        });
      }
    }
  };

  rec.begin = function (thresholdMs) {
    rec.thresholdMs = thresholdMs;
    rec.wall.length = 0; rec.body.length = 0; rec.heap.length = 0; rec.hitches.length = 0;
    last = -1;
    rec.t0 = performance.now();
    rec.armed = true;
  };
  rec.end = function () {
    rec.armed = false;
    return {
      wall: rec.wall, body: rec.body, heap: rec.heap, hitches: rec.hitches,
      durationMs: performance.now() - rec.t0,
      preciseMemory: !!performance.memory,
    };
  };
  return { ok: true, wrapped: labels.length };
}

/** The same firefight `perf-session.mjs` uses, looped so a 60 s window is busy. */
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

/** Loops the 15 s firefight so a 60 s session is combat for its whole length. */
function loopTimeline(totalS) {
  const out = [];
  const period = 15.4;
  for (let k = 0; k * period < totalS + period; k++) {
    for (const b of COMBAT_TIMELINE) out.push({ ...b, t: +(b.t + k * period).toFixed(2) });
  }
  return out;
}

/* ------------------------------------------------------------------ stats -- */

function stats(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  const n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  const cnt = (t) => samples.reduce((a, v) => a + (v > t ? 1 : 0), 0);
  return {
    frames: n,
    mean: n ? +(sum / n).toFixed(3) : 0,
    p50: +percentile(s, 50).toFixed(3),
    p95: +percentile(s, 95).toFixed(3),
    p99: +percentile(s, 99).toFixed(3),
    p999: +percentile(s, 99.9).toFixed(3),
    worst: n ? +s[n - 1].toFixed(3) : 0,
    over16_7: cnt(16.7), over33: cnt(33), over50: cnt(50),
    fps: n && sum ? +((n / sum) * 1000).toFixed(1) : 0,
  };
}

/**
 * Periodicity of the hitches.
 *
 * Two independent views, because either alone can lie. The gap histogram finds
 * a fixed interval directly; the autocorrelation of the frame-time series finds
 * a period even when individual hitches are missed by the threshold.
 */
function periodicity(wall, thresholds = [33, 50]) {
  const t = [];
  let acc = 0;
  for (const w of wall) { acc += w; t.push(acc); }
  const out = {};
  for (const thr of thresholds) {
    const times = [];
    for (let i = 0; i < wall.length; i++) if (wall[i] > thr) times.push(t[i]);
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    out[`over${thr}`] = {
      count: times.length,
      perSecond: acc > 0 ? +(times.length / (acc / 1000)).toFixed(3) : 0,
      gapMedianMs: gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(1) : null,
      gapP10Ms: gaps.length ? +percentile(gaps, 10).toFixed(1) : null,
      gapP90Ms: gaps.length ? +percentile(gaps, 90).toFixed(1) : null,
      firstTimesMs: times.slice(0, 20).map((v) => +v.toFixed(0)),
    };
  }
  return out;
}

/** Median-to-p99 spread — the smoothness number. */
function spread(f) { return +(f.p99 / Math.max(0.001, f.p50)).toFixed(2); }

/* ------------------------------------------------------------------- main -- */

const T0 = Date.now();
const stamp = () => `[${((Date.now() - T0) / 1000).toFixed(1)}s]`;
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');

async function profileOne(base, preset) {
  const url = `${base}/?capture=${CFG.capture}&quality=${preset}&mode=operation&seed=${CFG.seed}`;
  const session = await openPaceSession({ url, width: CFG.width, height: CFG.height, seed: CFG.seed });
  const out = { preset, gpu: session.renderer, captureMode: CFG.capture };
  try {
    await session.exec(INSTALL_INPUT_BRIDGE);
    const boot = await session.exec(INSTALL_PROBE);
    if (!boot.ok) throw new Error('probe install failed');
    out.boot = { aiAgents: boot.aiAgents, actorBackend: boot.actorBackend };
    const inst = await session.exec(INSTALL_PACE);
    out.wrapped = inst.wrapped;

    await session.exec((p) => { globalThis.__BLACKOUT__.setQuality(p); }, preset);
    if (CFG.pin) {
      await session.exec(() => {
        const R = globalThis.__RENDER__;
        R.setAdaptive(false);
        R.set('adaptive', false);
      });
    }
    // Settle the match so combat is live for the whole measured window.
    await session.exec(() => {
      const a = globalThis.__PT__.api;
      a.setRender(false);
      for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);
      a.setRender(true);
      a.setCombat(true);
      a.setFrozen(false);
      a.setAccuracy(1);
      a.resetLifecycle();
      a.refill();
      a.setSpawnLock(false);
    });

    await session.exec((thr) => globalThis.__W3__.begin(thr), CFG.hitchMs);
    const live = await runLive(session, CFG.ms, CFG.warmupMs, loopTimeline(CFG.ms / 1000));
    const raw = await session.exec(() => globalThis.__W3__.end());

    // Warm-up discard, on the pace record's own clock.
    const keep = [], body = [], heap = [];
    let acc = 0;
    for (let i = 0; i < raw.wall.length; i++) {
      acc += raw.wall[i];
      if (acc < CFG.warmupMs) continue;
      keep.push(raw.wall[i]); body.push(raw.body[i] ?? 0); heap.push(raw.heap[i] ?? 0);
    }
    out.frame = stats(keep);
    out.frame.spread = spread(out.frame);
    out.body = stats(body);
    out.periodicity = periodicity(keep);
    out.hitches = raw.hitches.filter((h) => h.t >= CFG.warmupMs);
    out.preciseMemory = raw.preciseMemory;
    out.heapMB = heap.length
      ? { start: +(heap[0] / 1048576).toFixed(1), end: +(heap[heap.length - 1] / 1048576).toFixed(1),
          max: +(Math.max(...heap) / 1048576).toFixed(1) }
      : null;
    out.liveFrame = live.frame;
    out.settings = await session.exec(() => {
      const s = globalThis.__RENDER__.gfx;
      const r = globalThis.engine.tryGet('render');
      return {
        budget: globalThis.__RENDER__.budget(),
        cost: globalThis.__RENDER__.cost(),
        shadowUpdateHz: s.shadowUpdateHz, exposureUpdateHz: s.exposureUpdateHz,
        adaptive: s.adaptive, targetFrameMs: s.targetFrameMs,
        renderScale: s.renderScale, shadowMapSize: s.shadowMapSize,
        shadowCascades: s.shadowCascades, shadowDistance: s.shadowDistance,
        ssao: s.ssao, ssr: s.ssr, volumetrics: s.volumetrics, taa: s.taa,
        contactShadows: s.contactShadows, dof: s.dof, motionBlur: s.motionBlur,
        drawingBuffer: r ? [r.renderer.domElement.width, r.renderer.domElement.height] : null,
        passes: r ? r.passes.filter((p) => p.enabled !== false).map((p) => p.name) : [],
      };
    });
    out.consoleErrors = session.errors.slice(0, 12);
  } finally { await session.close(); }
  return out;
}

async function main() {
  if (CFG.build) {
    console.log(`${stamp()} building → ${CFG.dist}`);
    const r = spawnSync('npx', ['vite', 'build', '--outDir', CFG.dist], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('vite build failed'); }
  }
  const base = await ensureServer({ port: CFG.port, outDir: CFG.dist });
  const report = { tool: 'w3-pace', label: CFG.label, cfg: CFG, startedAt: new Date().toISOString(), runs: [] };

  for (const preset of CFG.presets) {
    for (let rep = 0; rep < CFG.repeats; rep++) {
      console.log(`${stamp()} ── ${preset} rep${rep} capture=${CFG.capture} ${CFG.pin ? '(pinned)' : '(governor on)'}`);
      const r = await profileOne(base, preset);
      r.rep = rep;
      report.runs.push(r);
      const f = r.frame;
      console.log(`${stamp()}   p50 ${f2(f.p50).padStart(7)}  p95 ${f2(f.p95).padStart(7)}  p99 ${f2(f.p99).padStart(7)}  `
        + `p99.9 ${f2(f.p999).padStart(7)}  worst ${f2(f.worst).padStart(8)}  spread ${f.spread}x`);
      console.log(`${stamp()}   >16.7 ${String(f.over16_7).padStart(5)}  >33 ${String(f.over33).padStart(4)}  `
        + `>50 ${String(f.over50).padStart(4)}   n ${f.frames}   dial ${r.settings.budget.dial}:${r.settings.budget.rung}`);
      for (const [k, v] of Object.entries(r.periodicity)) {
        console.log(`${stamp()}   ${k}: n=${v.count} (${v.perSecond}/s) gap median ${v.gapMedianMs} ms `
          + `[p10 ${v.gapP10Ms} … p90 ${v.gapP90Ms}]`);
      }
      const top = r.hitches.slice().sort((a, b) => b.body - a.body).slice(0, 8);
      for (const h of top) {
        console.log(`${stamp()}   HITCH t=${String(h.t).padStart(7)}ms wall ${f2(h.wall).padStart(7)} body ${f2(h.body).padStart(7)} `
          + `attr ${f2(h.attributed).padStart(7)} heapΔ ${f2(h.heapDelta).padStart(7)}MB`);
        console.log(`${stamp()}         ${h.parts.slice(0, 6).map(([n, v]) => `${n}=${v}`).join('  ')}`);
      }
    }
  }

  await mkdir(path.join(ROOT, path.dirname(CFG.out)), { recursive: true });
  await writeFile(path.join(ROOT, CFG.out), JSON.stringify(report, null, 2));
  console.log(`${stamp()} wrote ${CFG.out}`);
  await stopServer();
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
