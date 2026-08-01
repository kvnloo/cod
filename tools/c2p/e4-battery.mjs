/* E4 — control + click + reruns + worker + non-COI clamp.
 *
 * CONTROL (BENCHMARKS §1.5): vmouse records t0 (before an injected delay) and t1
 * (immediately after write(2)). Computing the same latency against t0 instead of
 * t1 must move the answer by exactly the injected delay. A harness that does not
 * move is not an instrument.
 */
import { serve, launch, refreshRate, sleep, vmouse, readVmouse, stats, fmt, OUT, takeFocus, activeWindow } from './lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const COI = args.coi !== '0';
const PORT = COI ? 9843 : 9803;
const TAG = args.tag || (COI ? 'coi' : 'plain');
const SCRATCH = '/tmp/claude-1000/-workspace-zer0-products-cod/572583e0-c99f-4e97-a15b-009edac54737/scratchpad';

/* [name, rate, count, load, ctlUs, mode] */
const CONFIGS = JSON.parse(args.configs || 'null') || [
  ['500hz-load0-rerun',   500, 2500, 0, 0, 'move'],
  ['2000hz-load0-rerun', 2000, 8000, 0, 0, 'move'],
  ['CONTROL-delay2000us', 400, 1600, 0, 2000, 'move'],
  ['CONTROL-delay0us',    400, 1600, 0, 0,    'move'],
  ['CLICK-20hz',           20,  200, 0, 0, 'click'],
  ['CLICK-20hz-load128',   20,  200, 128, 0, 'click'],
];

const srv = await serve(PORT, { coi: COI });
const { browser, page, errs } = await launch({ url: `http://127.0.0.1:${PORT}/` });
const info = await page.evaluate(() => window.__C2P__.info());
console.log(`[${TAG}] origin=${info.origin} coi=${info.coi} sab=${info.sab} hasHid=${info.hasHid}`);
const clk = await page.evaluate(() => window.__C2P__.clockRes(500000));
console.log(`[${TAG}] performance.now() min nonzero delta = ${clk.minDeltaMs} ms  <-- clock floor for EVERY number below`);
await page.evaluate(() => window.__C2P__.startRaf());
await sleep(400);
const rr0 = await refreshRate(page, 400);
console.log(`[${TAG}] achieved rAF ${rr0.hz.toFixed(2)} Hz p50=${rr0.p50.toFixed(3)} p99=${rr0.p99.toFixed(3)} ms`);

async function bracketK(n = 80) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = Number(process.hrtime.bigint());
    const p = await page.evaluate(() => performance.now());
    const t1 = Number(process.hrtime.bigint());
    lo = Math.max(lo, t0 - p * 1e6); hi = Math.min(hi, t1 - p * 1e6);
  }
  return { lo, hi, mid: (lo + hi) / 2, widthMs: (hi - lo) / 1e6 };
}

async function runOnce([name, rate, count, load, ctlUs, mode]) {
  await page.evaluate((n) => window.__C2P__.setLoad(n), load);
  await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
  await sleep(250); takeFocus(); await sleep(400);
  await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.up();
  await sleep(180);
  const lockRes = await page.evaluate(() => window.__C2P__.lock(false));
  await sleep(350);
  const loadavg = readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ');
  let gpu = ''; try { gpu = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' }).trim(); } catch {}
  const kA = await bracketK(60);
  await page.evaluate((clickMode) => window.__C2P__.arm({ raw: true, move: true, click: true, coalesced: true, predicted: true, target: 'window' }), mode === 'click');
  const f = `${SCRATCH}/vm4-${TAG}-${name}.jsonl`;
  const vargs = ['--rate', String(rate), '--count', String(count), '--mode', mode, '--warmup-ms', '1200'];
  if (ctlUs) vargs.push('--control-delay-us', String(ctlUs));
  await vmouse(vargs, f);
  await sleep(500);
  const h = await page.evaluate(() => window.__C2P__.harvest());
  const kB = await bracketK(60);
  return { name, rate, count, load, ctlUs, mode, lockRes, loadavg, gpu, h, emitted: readVmouse(f), kA, kB };
}

function analyse(r) {
  const { h, emitted } = r;
  const em = emitted.ev;
  const K = (r.kA.mid + r.kB.mid) / 2;
  const unc = (r.kA.widthMs + r.kB.widthMs) / 4 + Math.abs(r.kA.mid - r.kB.mid) / 2e6;

  if (r.mode === 'click') {
    const down = h.ev.filter((e) => e.k === 'down');
    const up = h.ev.filter((e) => e.k === 'up');
    const btn = [...down, ...up].sort((a, b) => a.ts - b.ts);
    // emitted alternates press(i even)/release(i odd); match in order
    const n = Math.min(btn.length, em.length);
    const full = [], full0 = [], osHalf = [], d1 = [];
    for (let i = 0; i < n; i++) {
      full.push((btn[i].now * 1e6 + K - em[i].t1) / 1e6);
      full0.push((btn[i].now * 1e6 + K - em[i].t0) / 1e6);
      osHalf.push((btn[i].ts * 1e6 + K - em[i].t1) / 1e6);
      d1.push(btn[i].now - btn[i].ts);
    }
    return { cfg: r, kind: 'click', emitted: em.length, delivered: btn.length, downs: down.length, ups: up.length,
      D1: stats(d1), D3_full: stats(full), D3_fromT0: stats(full0), D3b: stats(osHalf), uncMs: +unc.toFixed(4), loadavg: r.loadavg, gpu: r.gpu };
  }

  const raw = h.ev.filter((e) => e.k === 'raw');
  const mov = h.ev.filter((e) => e.k === 'move');
  const samples = [];
  for (const e of raw) {
    if (e.coal && e.coal.n > 0) for (let i = 0; i < e.coal.n; i++) samples.push({ ts: e.coal.ts[i], now: e.now, mx: e.coal.mx[i] });
    else samples.push({ ts: e.ts, now: e.now, mx: e.mx });
  }
  const oneToOne = samples.length === em.length;
  const dx = oneToOne ? samples.filter((s, i) => s.mx === em[i].dx).length / samples.length : null;
  let full = [], full0 = [], osHalf = [], tsGap = [], tsCum = [];
  if (oneToOne && dx > 0.99) {
    const t0s = samples[0].ts, t0e = em[0].t1 / 1e6;
    for (let i = 0; i < samples.length; i++) {
      full.push((samples[i].now * 1e6 + K - em[i].t1) / 1e6);
      full0.push((samples[i].now * 1e6 + K - em[i].t0) / 1e6);
      osHalf.push((samples[i].ts * 1e6 + K - em[i].t1) / 1e6);
      if (i) { tsGap.push(Math.abs((samples[i].ts - samples[i - 1].ts) - (em[i].t1 - em[i - 1].t1) / 1e6));
               tsCum.push(Math.abs((samples[i].ts - t0s) - (em[i].t1 / 1e6 - t0e))); }
    }
  }
  const span = samples.length > 1 ? (samples[samples.length - 1].now - samples[0].now) / 1000 : 0;
  const coalPerMove = mov.filter((e) => e.coal).map((e) => e.coal.n);
  const moveOldest = mov.filter((e) => e.coal && e.coal.n).map((e) => e.now - e.coal.ts[0]);
  return { cfg: r, kind: 'move', emitted: em.length, delivered: samples.length, deliveryFrac: +(samples.length / em.length).toFixed(4),
    oneToOne, dxMatch: dx, rateHz: span ? +(samples.length / span).toFixed(1) : 0,
    D1_raw: stats(raw.map((e) => e.now - e.ts)), D1_move: stats(mov.map((e) => e.now - e.ts)), D1_moveOldest: stats(moveOldest),
    TSERR_gap: stats(tsGap), TSERR_cum: stats(tsCum),
    D3_full: stats(full), D3_fromT0: stats(full0), D3b: stats(osHalf),
    coalPerMove: stats(coalPerMove, 'ev'), uncMs: +unc.toFixed(4), loadavg: r.loadavg, gpu: r.gpu };
}

const results = [];
for (const c of CONFIGS) {
  process.stdout.write(`\n=== [${TAG}] ${c[0]} ===\n`);
  try {
    let r = await runOnce(c);
    let a = analyse(r);
    if ((a.delivered || 0) < c[2] * 0.4) { console.log(`  (retry: delivered ${a.delivered}/${c[2]})`); r = await runOnce(c); a = analyse(r); }
    results.push(a);
    console.log(` loadavg=${a.loadavg} gpu=${a.gpu} alignUnc=±${a.uncMs}ms  emitted=${a.emitted} delivered=${a.delivered}` + (a.kind === 'move' ? ` (${(a.deliveryFrac * 100).toFixed(1)}%) 1:1=${a.oneToOne} dx=${a.dxMatch} rate=${a.rateHz}Hz` : ` downs=${a.downs} ups=${a.ups}`));
    if (a.kind === 'click') {
      console.log(' ' + fmt('D1  stamp->JS       ', a.D1));
      console.log(' ' + fmt('D3  uinput->JS      ', a.D3_full));
      console.log(' ' + fmt('D3b uinput->stamp   ', a.D3b));
    } else {
      console.log(' ' + fmt('D1  raw  stamp->JS  ', a.D1_raw));
      console.log(' ' + fmt('D1  move stamp->JS  ', a.D1_move));
      console.log(' ' + fmt('D1  move OLDEST age ', a.D1_moveOldest));
      console.log(' ' + fmt('TSERR gap           ', a.TSERR_gap));
      console.log(' ' + fmt('TSERR cumulative    ', a.TSERR_cum));
      console.log(' ' + fmt('D3  uinput->JS      ', a.D3_full));
      console.log(' ' + fmt('D3b uinput->stamp   ', a.D3b));
      console.log(' ' + fmt('coalesced/move      ', a.coalPerMove));
    }
    console.log(' ' + fmt('CONTROL: same, ref=t0 (t0 precedes an injected ' + (c[4] || 0) + 'us delay)', a.D3_fromT0));
    if (a.D3_full && a.D3_full.n) console.log(`  -> shift p50 = ${(a.D3_fromT0.p50 - a.D3_full.p50).toFixed(4)} ms (expected ${((c[4] || 0) / 1000).toFixed(3)} ms)`);
  } catch (e) { console.log(' FAILED: ' + e.message); }
}

/* ------------------------------------------------------- worker relay cost */
const relay = await page.evaluate(() => window.__C2P__.workerRelay(4000));
const relayMs = relay.map((x) => x[1] - x[0]);
console.log('\n' + fmt('main-thread -> Worker postMessage relay', stats(relayMs)));

writeFileSync(`${OUT}/e4-${TAG}.json`, JSON.stringify({ info, clk, rr0, results, relay: stats(relayMs), errs }, null, 2));
console.log('ERRORS:', errs.slice(0, 5));
await browser.close(); srv.close();
