/* E3 — definitive input-path run.
 *
 * Fixes over E1:
 *  - clock alignment done in the CLOCK_MONOTONIC domain (node hrtime <-> page
 *    performance.now origin), bracketed immediately before AND after each burst.
 *    E1 used performance.timeOrigin (CLOCK_REALTIME) and therefore inherited NTP
 *    slew, which is why its absolute uinput->JS numbers wandered 0.05..0.90 ms.
 *  - delivery check + retry (some E1 runs got 0 events after a focus race).
 *  - TIMESTAMP FIDELITY: |(ts[i]-ts[0]) - (write[i]-write[0])| needs no alignment
 *    at all. This is the number that decides whether sub-tick input is possible.
 *  - pointermove OLDEST coalesced sample age = the real input age at sim time.
 */
import { serve, launch, refreshRate, sleep, vmouse, readVmouse, stats, fmt, OUT, takeFocus, activeWindow } from './lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const COI = args.coi !== '0';
const PORT = COI ? 9843 : 9803;
const TAG = args.tag || (COI ? 'coi' : 'plain');
const SCRATCH = '/tmp/claude-1000/-workspace-zer0-products-cod/572583e0-c99f-4e97-a15b-009edac54737/scratchpad';

/* [name, rate, count, load, ctlUs] — all under plain pointer lock */
const CONFIGS = JSON.parse(args.configs || 'null') || [
  ['1000hz-load0',    1000, 4000, 0,   0],
  ['1000hz-load0-r2', 1000, 4000, 0,   0],
  ['1000hz-load32',   1000, 4000, 32,  0],
  ['1000hz-load128',  1000, 4000, 128, 0],
  ['500hz-load0',      500, 2500, 0,   0],
  ['2000hz-load0',    2000, 8000, 0,   0],
  ['4000hz-load0',    4000,12000, 0,   0],
  ['8000hz-load0',    8000,20000, 0,   0],
  ['CONTROL-1000hz-delay2000us', 1000, 3000, 0, 2000],
];

const srv = await serve(PORT, { coi: COI });
const { browser, page, errs } = await launch({ url: `http://127.0.0.1:${PORT}/` });
const info = await page.evaluate(() => window.__C2P__.info());
console.log(`[${TAG}] origin=${info.origin} coi=${info.coi} sab=${info.sab}`);
console.log(`[${TAG}] renderer=${info.renderer}`);
const clk = await page.evaluate(() => window.__C2P__.clockRes(500000));
console.log(`[${TAG}] performance.now() min nonzero delta = ${clk.minDeltaMs} ms`);
await page.evaluate(() => window.__C2P__.startRaf());
await sleep(400);
const rr0 = await refreshRate(page, 400);
console.log(`[${TAG}] achieved rAF ${rr0.hz.toFixed(2)} Hz p50=${rr0.p50.toFixed(3)} p99=${rr0.p99.toFixed(3)} ms`);

/* --- CLOCK_MONOTONIC alignment: K such that node_mono_ns = page_now_ms*1e6 + K --- */
async function bracketK(n = 120) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = Number(process.hrtime.bigint());
    const p = await page.evaluate(() => performance.now());
    const t1 = Number(process.hrtime.bigint());
    lo = Math.max(lo, t0 - p * 1e6); hi = Math.min(hi, t1 - p * 1e6);
  }
  return { lo, hi, mid: (lo + hi) / 2, widthMs: (hi - lo) / 1e6 };
}
const k0 = await bracketK(200);
console.log(`[${TAG}] monotonic bracket width = ${k0.widthMs.toFixed(4)} ms (uncertainty on every absolute latency below)`);

async function runOnce([name, rate, count, load, ctlUs], attempt) {
  await page.evaluate((n) => window.__C2P__.setLoad(n), load);
  await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
  await sleep(250); takeFocus(); await sleep(400);
  const aw = activeWindow();
  await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.up();
  await sleep(180);
  const lockRes = await page.evaluate(() => window.__C2P__.lock(false));
  await sleep(350);

  const loadavg = readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ');
  let gpu = ''; try { gpu = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' }).trim(); } catch {}

  const kA = await bracketK(60);
  await page.evaluate(() => window.__C2P__.arm({ raw: true, move: true, coalesced: true, predicted: true, target: 'window' }));
  const f = `${SCRATCH}/vm3-${TAG}-${name}.jsonl`;
  const vargs = ['--rate', String(rate), '--count', String(count), '--mode', 'move', '--warmup-ms', '1200'];
  if (ctlUs) vargs.push('--control-delay-us', String(ctlUs));
  await vmouse(vargs, f);
  await sleep(450);
  const h = await page.evaluate(() => window.__C2P__.harvest());
  const kB = await bracketK(60);
  return { name, rate, count, load, ctlUs, lockRes, aw, loadavg, gpu, h, emitted: readVmouse(f), kA, kB, attempt };
}

async function run(cfg) {
  let r = await runOnce(cfg, 1);
  const frac = r.h.ev.filter((e) => e.k === 'raw').length / cfg[2];
  if (frac < 0.4) { console.log(`  (retry: delivery ${(frac * 100).toFixed(1)}%)`); r = await runOnce(cfg, 2); }
  return analyse(r);
}

function analyse(r) {
  const { h, emitted } = r;
  const raw = h.ev.filter((e) => e.k === 'raw');
  const mov = h.ev.filter((e) => e.k === 'move');
  const em = emitted.ev;

  const d1raw = raw.map((e) => e.now - e.ts);
  const d1mov = mov.map((e) => e.now - e.ts);
  // real input age at pointermove dispatch = age of the OLDEST coalesced sample
  const moveOldest = mov.filter((e) => e.coal && e.coal.n).map((e) => e.now - e.coal.ts[0]);

  /* flatten raw into hardware samples */
  const samples = [];
  for (const e of raw) {
    if (e.coal && e.coal.n > 0) for (let i = 0; i < e.coal.n; i++) samples.push({ ts: e.coal.ts[i], now: e.now, mx: e.coal.mx[i] });
    else samples.push({ ts: e.ts, now: e.now, mx: e.mx });
  }
  const oneToOne = samples.length === em.length;
  const dxMatch = oneToOne ? samples.filter((s, i) => s.mx === em[i].dx).length / samples.length : null;

  /* ---- TIMESTAMP FIDELITY (needs no clock alignment) ---------------------- */
  let tsErr = [], gapErr = [];
  if (oneToOne && dxMatch > 0.99) {
    const t0e = em[0].t1 / 1e6, t0s = samples[0].ts;
    for (let i = 1; i < samples.length; i++) {
      tsErr.push(Math.abs((samples[i].ts - t0s) - (em[i].t1 / 1e6 - t0e)));
      gapErr.push(Math.abs((samples[i].ts - samples[i - 1].ts) - (em[i].t1 - em[i - 1].t1) / 1e6));
    }
  }

  /* ---- absolute latency, monotonic domain, bracketed ---------------------- */
  const K = (r.kA.mid + r.kB.mid) / 2;
  const kDriftMs = Math.abs(r.kA.mid - r.kB.mid) / 1e6;
  const uncMs = (r.kA.widthMs + r.kB.widthMs) / 2 / 2 + kDriftMs / 2;
  let full = [], osHalf = [];
  if (oneToOne && dxMatch > 0.99) {
    for (let i = 0; i < samples.length; i++) {
      full.push((samples[i].now * 1e6 + K - em[i].t1) / 1e6);
      osHalf.push((samples[i].ts * 1e6 + K - em[i].t1) / 1e6);
    }
  }

  /* ---- rates measured from the event stream itself ------------------------ */
  const span = samples.length > 1 ? (samples[samples.length - 1].now - samples[0].now) / 1000 : 0;
  const coalPerMove = mov.filter((e) => e.coal).map((e) => e.coal.n);
  const coalTotal = coalPerMove.reduce((a, b) => a + b, 0);
  const coalPerRaw = raw.filter((e) => e.coal).map((e) => e.coal.n);
  const pred = mov.filter((e) => e.pred != null).map((e) => e.pred);
  const frameDt = []; for (let i = 1; i < h.frames.length; i++) frameDt.push(h.frames[i].t - h.frames[i - 1].t);
  let decreases = 0; for (let i = 1; i < samples.length; i++) if (samples[i].ts < samples[i - 1].ts) decreases++;

  return {
    cfg: { name: r.name, rate: r.rate, count: r.count, load: r.load, ctlUs: r.ctlUs }, attempt: r.attempt,
    lockRes: r.lockRes, activeWindow: r.aw && r.aw.title, loadavg: r.loadavg, gpu: r.gpu,
    emitted: em.length,
    delivered: { rawEvents: raw.length, rawSamples: samples.length, moveEvents: mov.length, moveCoalesced: coalTotal },
    deliveryFrac: +(samples.length / em.length).toFixed(4), oneToOne, dxMatchFrac: dxMatch,
    spanS: +span.toFixed(3),
    rateHz: { emitted: r.rate, rawSamples: span ? +(samples.length / span).toFixed(1) : 0, rawEvents: span ? +(raw.length / span).toFixed(1) : 0, moveEvents: span ? +(mov.length / span).toFixed(1) : 0 },
    D1_raw: stats(d1raw), D1_move: stats(d1mov), D1_moveOldest: stats(moveOldest),
    TSERR_cumulative: stats(tsErr), TSERR_gap: stats(gapErr), tsDecreases: decreases,
    D3_full: stats(full), D3b_osHalf: stats(osHalf),
    alignUncertaintyMs: +uncMs.toFixed(4), kDriftMs: +kDriftMs.toFixed(4),
    D4: { coalPerMove: stats(coalPerMove, 'ev'), coalPerRaw: stats(coalPerRaw, 'ev'), predictedPerMove: stats(pred, 'ev'), frameDt: stats(frameDt) },
  };
}

const results = [];
for (const c of CONFIGS) {
  process.stdout.write(`\n=== [${TAG}] ${c[0]} ===\n`);
  try {
    const r = await run(c); results.push(r);
    console.log(` lock=${r.lockRes.locked} attempt=${r.attempt} loadavg=${r.loadavg} gpu=${r.gpu} alignUnc=±${r.alignUncertaintyMs}ms (drift ${r.kDriftMs}ms)`);
    console.log(` emitted=${r.emitted} rawSamples=${r.delivered.rawSamples} (${(r.deliveryFrac * 100).toFixed(1)}%) rawEvents=${r.delivered.rawEvents} move=${r.delivered.moveEvents} moveCoal=${r.delivered.moveCoalesced} 1:1=${r.oneToOne} dx=${r.dxMatchFrac}`);
    console.log(` measured rates over ${r.spanS}s: rawSamples=${r.rateHz.rawSamples}Hz rawEvents=${r.rateHz.rawEvents}Hz move=${r.rateHz.moveEvents}Hz`);
    console.log(' ' + fmt('D1  raw   stamp->JS  ', r.D1_raw));
    console.log(' ' + fmt('D1  move  stamp->JS  ', r.D1_move));
    console.log(' ' + fmt('D1  move  OLDEST age ', r.D1_moveOldest));
    console.log(' ' + fmt('TSERR gap (adjacent) ', r.TSERR_gap));
    console.log(' ' + fmt('TSERR cumulative     ', r.TSERR_cumulative) + ` decreases=${r.tsDecreases}`);
    console.log(' ' + fmt('D3  uinput->JS       ', r.D3_full));
    console.log(' ' + fmt('D3b uinput->stamp    ', r.D3b_osHalf));
    console.log(' ' + fmt('coalesced/move       ', r.D4.coalPerMove));
    console.log(' ' + fmt('coalesced/rawEvent   ', r.D4.coalPerRaw));
    console.log(' ' + fmt('predicted/move       ', r.D4.predictedPerMove));
    console.log(' ' + fmt('frame dt             ', r.D4.frameDt));
  } catch (e) { console.log(' FAILED: ' + e.message); results.push({ cfg: c, error: e.message }); }
}
writeFileSync(`${OUT}/e3-${TAG}.json`, JSON.stringify({ info, clk, rr0, k0, results, errs }, null, 2));
console.log('\nERRORS:', errs.slice(0, 5));
await browser.close(); srv.close();
