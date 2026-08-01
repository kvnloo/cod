/* E1 — the input path, measured with REAL kernel input events (uinput).
 *
 *   D1  performance.now()@handler - event.timeStamp    (Chrome-internal: stamp -> JS)
 *   D2  event.timeStamp quantisation + monotonicity
 *   D3  full path: uinput write(2) -> JS handler       (1:1 matched under pointer lock)
 *   D3b uinput write(2) -> event.timeStamp             (OS + compositor half)
 *   D4  delivery/coalescing/prediction
 */
import { serve, launch, refreshRate, sleep, vmouse, readVmouse, stats, fmt, OUT, takeFocus, activeWindow } from './lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const COI = args.coi !== '0';
const PORT = COI ? 9843 : 9803;
const TAG = args.tag || (COI ? 'coi' : 'plain');
const SCRATCH = '/tmp/claude-1000/-workspace-zer0-products-cod/572583e0-c99f-4e97-a15b-009edac54737/scratchpad';

/* [name, rate, count, lock, load, mode, controlDelayUs] */
const CONFIGS = JSON.parse(args.configs || 'null') || [
  ['lock-1000hz-load0',   1000, 4000, true, 0,   'move', 0],
  ['lock-1000hz-load32',  1000, 4000, true, 32,  'move', 0],
  ['lock-1000hz-load128', 1000, 4000, true, 128, 'move', 0],
  ['lock-125hz-load0',     125,  700, true, 0,   'move', 0],
  ['lock-500hz-load0',     500, 2500, true, 0,   'move', 0],
  ['lock-2000hz-load0',   2000, 8000, true, 0,   'move', 0],
  ['lock-4000hz-load0',   4000,12000, true, 0,   'move', 0],
  ['lock-8000hz-load0',   8000,20000, true, 0,   'move', 0],
  ['CONTROL-lock-1000hz-delay2000us', 1000, 3000, true, 0, 'move', 2000],
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

/* ---- clock alignment: page (timeOrigin+now, CLOCK_REALTIME ms) vs node CLOCK_REALTIME */
let _rt = null;
function realNs() {
  if (!_rt) { const s = Date.now(); let d = s, m = 0n; while (d === s) { m = process.hrtime.bigint(); d = Date.now(); } _rt = { d, m }; }
  return BigInt(_rt.d) * 1000000n + (process.hrtime.bigint() - _rt.m);
}
async function alignBracket(n) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = Number(realNs());
    const p = await page.evaluate(() => performance.timeOrigin + performance.now());
    const t1 = Number(realNs());
    lo = Math.max(lo, p * 1e6 - t1); hi = Math.min(hi, p * 1e6 - t0);
  }
  return { lo, hi, mid: (lo + hi) / 2, widthMs: (hi - lo) / 1e6 };
}
const align = await alignBracket(250);
console.log(`[${TAG}] clock bracket: page-node offset in [${(align.lo / 1e6).toFixed(4)}, ${(align.hi / 1e6).toFixed(4)}] ms width=${align.widthMs.toFixed(4)} ms`);

function monoRealOffsetNs() {
  return Number(execFileSync('python3', ['-c', 'import time;a=time.clock_gettime_ns(time.CLOCK_MONOTONIC);b=time.clock_gettime_ns(time.CLOCK_REALTIME);print(b-a)'], { encoding: 'utf8' }).trim());
}

async function run([name, rate, count, lock, load, mode, ctlUs]) {
  await page.evaluate((n) => window.__C2P__.setLoad(n), load);
  await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
  await sleep(250); takeFocus(); await sleep(350);
  const aw = activeWindow();
  let lockRes = { locked: false, err: 'not requested' };
  if (lock) {
    await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.up();
    await sleep(150);
    lockRes = await page.evaluate(() => window.__C2P__.lock(false));
    await sleep(300);
  }
  const loadavg = readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ');
  let gpu = ''; try { gpu = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' }).trim(); } catch {}

  await page.evaluate(() => window.__C2P__.arm({ raw: true, move: true, coalesced: true, predicted: true, target: 'window' }));
  const f = `${SCRATCH}/vm-${TAG}-${name}.jsonl`;
  const off = monoRealOffsetNs();
  const vargs = ['--rate', String(rate), '--count', String(count), '--mode', mode, '--warmup-ms', '900'];
  if (ctlUs) vargs.push('--control-delay-us', String(ctlUs));
  await vmouse(vargs, f);
  await sleep(500);
  const h = await page.evaluate(() => window.__C2P__.harvest());
  return analyse({ name, rate, count, lock, load, mode, ctlUs, lockRes, loadavg, gpu, off, h, emitted: readVmouse(f), timeOrigin: info.timeOrigin, aw });
}

function analyse(r) {
  const { h, emitted, off } = r;
  const raw = h.ev.filter((e) => e.k === 'raw');
  const mov = h.ev.filter((e) => e.k === 'move');
  const d1raw = raw.map((e) => e.now - e.ts);
  const d1mov = mov.map((e) => e.now - e.ts);

  const qz = (list) => {
    let minD = Infinity, neg = 0; const hist = new Map();
    for (let i = 1; i < list.length; i++) {
      const d = +(list[i].ts - list[i - 1].ts).toFixed(3);
      if (d < 0) neg++; if (d > 0 && d < minD) minD = d;
      hist.set(d, (hist.get(d) || 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { minPosDeltaMs: minD === Infinity ? null : +minD.toFixed(6), decreases: neg, n: list.length, topDeltas: top };
  };

  /* flatten pointerrawupdate into raw *samples*: each coalesced sub-event is one
     hardware sample; the parent event's handler-entry time is when JS saw it. */
  const samples = [];
  for (const e of raw) {
    if (e.coal && e.coal.n > 0) for (let i = 0; i < e.coal.n; i++) samples.push({ ts: e.coal.ts[i], now: e.now, mx: e.coal.mx[i] });
    else samples.push({ ts: e.ts, now: e.now, mx: e.mx });
  }
  const em = emitted.ev;
  const oneToOne = samples.length === em.length;
  const dxMatch = oneToOne ? samples.filter((s, i) => s.mx === em[i].dx).length / samples.length : null;

  const timeOriginNs = r.timeOrigin * 1e6;
  const toReal = (ms) => timeOriginNs + ms * 1e6;
  const wReal = (t1) => t1 + off;
  let full = [], osHalf = [];
  const n = Math.min(samples.length, em.length);
  if (oneToOne || (dxMatch === null && samples.length > em.length * 0.9)) {
    for (let i = 0; i < n; i++) {
      full.push((toReal(samples[i].now) - wReal(em[i].t1)) / 1e6);
      osHalf.push((toReal(samples[i].ts) - wReal(em[i].t1)) / 1e6);
    }
  }

  const durS = (h.tEnd - h.t0) / 1000;
  const coalPerMove = mov.filter((e) => e.coal).map((e) => e.coal.n);
  const coalTotal = coalPerMove.reduce((a, b) => a + b, 0);
  const rawCoal = raw.filter((e) => e.coal).map((e) => e.coal.n);
  const pred = mov.filter((e) => e.pred != null).map((e) => e.pred);
  const evPerFrame = h.frames.map((f) => f.ev);
  const frameDt = []; for (let i = 1; i < h.frames.length; i++) frameDt.push(h.frames[i].t - h.frames[i - 1].t);

  let innerSpread = [], innerMin = Infinity, innerDup = 0, innerTot = 0, innerDelta = [];
  for (const e of mov) {
    if (!e.coal || e.coal.n < 2) continue;
    const ts = e.coal.ts; innerSpread.push(ts[ts.length - 1] - ts[0]);
    for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; innerTot++; innerDelta.push(d); if (d === 0) innerDup++; else if (d > 0 && d < innerMin) innerMin = d; }
  }

  return {
    cfg: { name: r.name, rate: r.rate, count: r.count, lock: r.lock, load: r.load, mode: r.mode, ctlUs: r.ctlUs },
    lockRes: r.lockRes, activeWindow: r.aw, loadavg: r.loadavg, gpu: r.gpu,
    emitted: em.length, durS: +durS.toFixed(3),
    delivered: { rawEvents: raw.length, rawSamples: samples.length, moveEvents: mov.length, moveCoalesced: coalTotal },
    deliveryFrac: +(samples.length / em.length).toFixed(4),
    oneToOne, dxMatchFrac: dxMatch,
    rateHz: { emitted: r.rate, rawSamples: +(samples.length / durS).toFixed(1), rawEvents: +(raw.length / durS).toFixed(1), moveEvents: +(mov.length / durS).toFixed(1) },
    D1_raw: stats(d1raw), D1_move: stats(d1mov),
    D2_raw: qz(raw), D2_move: qz(mov),
    D3_full: stats(full), D3b_osHalf: stats(osHalf),
    D4: {
      coalPerMove: stats(coalPerMove, 'ev'), coalPerRaw: stats(rawCoal, 'ev'), predictedPerMove: stats(pred, 'ev'),
      rawEvPerFrame: stats(evPerFrame, 'ev'), frameDt: stats(frameDt),
      innerDeltaMs: stats(innerDelta), innerSpreadMs: stats(innerSpread),
      innerMinDeltaMs: innerMin === Infinity ? null : +innerMin.toFixed(6), innerDupPairs: innerDup, innerPairs: innerTot,
    },
  };
}

const results = [];
for (const c of CONFIGS) {
  process.stdout.write(`\n=== [${TAG}] ${c[0]} ===\n`);
  try {
    const r = await run(c); results.push(r);
    console.log(` lock=${JSON.stringify(r.lockRes)} active=${r.activeWindow && r.activeWindow.title} loadavg=${r.loadavg} gpu=${r.gpu}`);
    console.log(` emitted=${r.emitted} rawSamples=${r.delivered.rawSamples} (${(r.deliveryFrac * 100).toFixed(1)}%) rawEvents=${r.delivered.rawEvents} moveEvents=${r.delivered.moveEvents} moveCoalesced=${r.delivered.moveCoalesced}`);
    console.log(` rates: emit=${r.rateHz.emitted}Hz rawSamples=${r.rateHz.rawSamples}Hz rawEvents=${r.rateHz.rawEvents}Hz move=${r.rateHz.moveEvents}Hz | 1:1=${r.oneToOne} dxMatch=${r.dxMatchFrac}`);
    console.log(' ' + fmt('D1 raw  stamp->JS ', r.D1_raw));
    console.log(' ' + fmt('D1 move stamp->JS ', r.D1_move));
    console.log(` D2 raw : minPosDelta=${r.D2_raw.minPosDeltaMs}ms decreases=${r.D2_raw.decreases} topDeltas=${JSON.stringify(r.D2_raw.topDeltas)}`);
    console.log(' ' + fmt('D3  uinput->JS    ', r.D3_full));
    console.log(' ' + fmt('D3b uinput->stamp ', r.D3b_osHalf));
    console.log(' ' + fmt('coalesced/move    ', r.D4.coalPerMove));
    console.log(' ' + fmt('coalesced/rawEvt  ', r.D4.coalPerRaw));
    console.log(' ' + fmt('predicted/move    ', r.D4.predictedPerMove));
    console.log(' ' + fmt('rawEvents/frame   ', r.D4.rawEvPerFrame));
    console.log(' ' + fmt('frame dt          ', r.D4.frameDt));
    console.log(' ' + fmt('coalesced innerDt ', r.D4.innerDeltaMs) + ` dupPairs=${r.D4.innerDupPairs}/${r.D4.innerPairs} minDelta=${r.D4.innerMinDeltaMs}`);
  } catch (e) { console.log(' FAILED: ' + e.message); results.push({ cfg: c, error: e.message }); }
}
writeFileSync(`${OUT}/e1-${TAG}.json`, JSON.stringify({ info, clk, rr0, align, results, errs }, null, 2));
console.log('\nERRORS:', errs.slice(0, 5));
await browser.close(); srv.close();
