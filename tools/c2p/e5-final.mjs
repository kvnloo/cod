/* E5 — final input-path battery. Persistent uinput device, DP-1 pinned,
 * per-run refresh-rate verification, working control. */
import { serve, launch, refreshRate, sleep, VMouseDaemon, readVmouse, stats, fmt, OUT, takeFocus, activeWindow } from './lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const COI = args.coi !== '0';
const PORT = COI ? 9843 : 9803;
const TAG = args.tag || (COI ? 'coi' : 'plain');
const S = '/tmp/claude-1000/-workspace-zer0-products-cod/572583e0-c99f-4e97-a15b-009edac54737/scratchpad';

/* [name, rate, count, load, ctlUs, mode] */
const CONFIGS = JSON.parse(args.configs || 'null') || [
  ['1000hz-load0',       1000, 4000, 0,   0, 'move'],
  ['1000hz-load0-rerun', 1000, 4000, 0,   0, 'move'],
  ['500hz-load0',         500, 2500, 0,   0, 'move'],
  ['2000hz-load0',       2000, 8000, 0,   0, 'move'],
  ['4000hz-load0',       4000,12000, 0,   0, 'move'],
  ['8000hz-load0',       8000,20000, 0,   0, 'move'],
  ['1000hz-load32',      1000, 4000, 32,  0, 'move'],
  ['1000hz-load128',     1000, 4000, 128, 0, 'move'],
  ['CONTROL-delay0us',    400, 1600, 0,   0, 'move'],
  ['CONTROL-delay2000us', 400, 1600, 0, 2000, 'move'],
  ['CLICK-25hz-load0',     25,  240, 0,   0, 'click'],
  ['CLICK-25hz-load128',   25,  240, 128, 0, 'click'],
];

const srv = await serve(PORT, { coi: COI });
const { browser, page, errs } = await launch({ url: `http://127.0.0.1:${PORT}/` });
const info = await page.evaluate(() => window.__C2P__.info());
const clk = await page.evaluate(() => window.__C2P__.clockRes(500000));
console.log(`[${TAG}] origin=${info.origin} coi=${info.coi} sab=${info.sab} clockFloor=${clk.minDeltaMs}ms`);
console.log(`[${TAG}] renderer=${info.renderer}`);
console.log(`[${TAG}] hasRaw=${info.hasRaw} hasCoalesced=${info.hasCoalesced} hasPredicted=${info.hasPredicted} hasHID=${info.hasHid}`);
await page.evaluate(() => window.__C2P__.startRaf());
await sleep(500);
const rr0 = await refreshRate(page, 400);
console.log(`[${TAG}] B0.4 achieved rAF ${rr0.hz.toFixed(2)} Hz p50=${rr0.p50.toFixed(3)} p99=${rr0.p99.toFixed(3)} ms  active=${JSON.stringify(activeWindow())}`);
if (rr0.hz < 500) console.log(`[${TAG}] *** WARNING: not on the 540 Hz panel ***`);

const vm = new VMouseDaemon(); await vm.start();
console.log(`[${TAG}] uinput device up (persistent)`);

async function bracketK(n = 60) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < n; i++) {
    const a = Number(process.hrtime.bigint());
    const p = await page.evaluate(() => performance.now());
    const b = Number(process.hrtime.bigint());
    lo = Math.max(lo, a - p * 1e6); hi = Math.min(hi, b - p * 1e6);
  }
  return { lo, hi, mid: (lo + hi) / 2, widthMs: (hi - lo) / 1e6 };
}

async function once([name, rate, count, load, ctlUs, mode]) {
  await page.evaluate((n) => window.__C2P__.setLoad(n), load);
  await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
  await sleep(200); takeFocus(); await sleep(350);
  await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.up();
  await sleep(150);
  const lockRes = await page.evaluate(() => window.__C2P__.lock(false));
  await sleep(300);
  const rr = await refreshRate(page, 250);
  const loadavg = readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(' ');
  let gpu = ''; try { gpu = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' }).trim(); } catch {}
  const kA = await bracketK();
  await page.evaluate(() => window.__C2P__.arm({ raw: true, move: true, click: true, coalesced: true, predicted: true, target: 'window' }));
  const f = `${S}/vm5-${TAG}-${name}.jsonl`;
  await vm.burst(rate, count, mode, ctlUs, f);
  await sleep(450);
  const h = await page.evaluate(() => window.__C2P__.harvest());
  const kB = await bracketK();
  return { name, rate, count, load, ctlUs, mode, lockRes, loadavg, gpu, rr, h, emitted: readVmouse(f), kA, kB };
}

function analyse(r) {
  const { h, emitted } = r;
  const em = emitted.ev;
  const K = (r.kA.mid + r.kB.mid) / 2;
  const unc = (r.kA.widthMs + r.kB.widthMs) / 4 + Math.abs(r.kA.mid - r.kB.mid) / 2e6;
  const base = { name: r.name, cfg: { rate: r.rate, count: r.count, load: r.load, ctlUs: r.ctlUs, mode: r.mode },
    locked: r.lockRes.locked, loadavg: r.loadavg, gpu: r.gpu, achievedHz: +r.rr.hz.toFixed(2), rafP50: +r.rr.p50.toFixed(3),
    uncMs: +unc.toFixed(4), emitted: em.length };

  if (r.mode === 'click') {
    const btn = h.ev.filter((e) => e.k === 'down' || e.k === 'up').sort((a, b) => a.ts - b.ts);
    const n = Math.min(btn.length, em.length);
    const d1 = [], full = [], full0 = [], os = [];
    for (let i = 0; i < n; i++) {
      d1.push(btn[i].now - btn[i].ts);
      full.push((btn[i].now * 1e6 + K - em[i].t1) / 1e6);
      full0.push((btn[i].now * 1e6 + K - em[i].t0) / 1e6);
      os.push((btn[i].ts * 1e6 + K - em[i].t1) / 1e6);
    }
    return { ...base, kind: 'click', delivered: btn.length, D1: stats(d1), D3: stats(full), D3_t0: stats(full0), D3b: stats(os) };
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
  let full = [], full0 = [], os = [], gap = [], cum = [];
  if (oneToOne && dx > 0.99) {
    const s0 = samples[0].ts, e0 = em[0].t1 / 1e6;
    for (let i = 0; i < samples.length; i++) {
      full.push((samples[i].now * 1e6 + K - em[i].t1) / 1e6);
      full0.push((samples[i].now * 1e6 + K - em[i].t0) / 1e6);
      os.push((samples[i].ts * 1e6 + K - em[i].t1) / 1e6);
      if (i) { gap.push(Math.abs((samples[i].ts - samples[i - 1].ts) - (em[i].t1 - em[i - 1].t1) / 1e6));
               cum.push(Math.abs((samples[i].ts - s0) - (em[i].t1 / 1e6 - e0))); }
    }
  }
  const span = samples.length > 1 ? (samples[samples.length - 1].now - samples[0].now) / 1000 : 0;
  let dec = 0; for (let i = 1; i < samples.length; i++) if (samples[i].ts < samples[i - 1].ts) dec++;
  const frameDt = []; for (let i = 1; i < h.frames.length; i++) frameDt.push(h.frames[i].t - h.frames[i - 1].t);
  return { ...base, kind: 'move',
    delivered: samples.length, deliveryFrac: +(samples.length / em.length).toFixed(4), rawEvents: raw.length, moveEvents: mov.length,
    oneToOne, dxMatch: dx, sampleRateHz: span ? +(samples.length / span).toFixed(1) : 0,
    tsDecreases: dec,
    D1_raw: stats(raw.map((e) => e.now - e.ts)), D1_move: stats(mov.map((e) => e.now - e.ts)),
    D1_moveOldest: stats(mov.filter((e) => e.coal && e.coal.n).map((e) => e.now - e.coal.ts[0])),
    TSERR_gap: stats(gap), TSERR_cum: stats(cum),
    D3: stats(full), D3_t0: stats(full0), D3b: stats(os),
    coalPerMove: stats(mov.filter((e) => e.coal).map((e) => e.coal.n), 'ev'),
    coalPerRaw: stats(raw.filter((e) => e.coal).map((e) => e.coal.n), 'ev'),
    predPerMove: stats(mov.filter((e) => e.pred != null).map((e) => e.pred), 'ev'),
    frameDt: stats(frameDt) };
}

const results = [];
for (const c of CONFIGS) {
  process.stdout.write(`\n=== [${TAG}] ${c[0]} ===\n`);
  try {
    let a = analyse(await once(c));
    if (a.delivered < c[2] * 0.5) { console.log(`  (retry: delivered ${a.delivered}/${c[2]})`); a = analyse(await once(c)); }
    results.push(a);
    console.log(` locked=${a.locked} achieved=${a.achievedHz}Hz(rAF p50 ${a.rafP50}ms) loadavg=${a.loadavg} gpu=${a.gpu} alignUnc=±${a.uncMs}ms`);
    if (a.kind === 'click') {
      console.log(` emitted=${a.emitted} delivered=${a.delivered}`);
      console.log(' ' + fmt('D1  stamp->JS     ', a.D1));
      console.log(' ' + fmt('D3  uinput->JS    ', a.D3));
      console.log(' ' + fmt('D3b uinput->stamp ', a.D3b));
    } else {
      console.log(` emitted=${a.emitted} samples=${a.delivered} (${(a.deliveryFrac * 100).toFixed(1)}%) rawEvents=${a.rawEvents} moveEvents=${a.moveEvents} 1:1=${a.oneToOne} dx=${a.dxMatch} rate=${a.sampleRateHz}Hz tsDecreases=${a.tsDecreases}`);
      console.log(' ' + fmt('D1  raw  stamp->JS', a.D1_raw));
      console.log(' ' + fmt('D1  move stamp->JS', a.D1_move));
      console.log(' ' + fmt('D1  move OLDESTage', a.D1_moveOldest));
      console.log(' ' + fmt('TSERR gap         ', a.TSERR_gap));
      console.log(' ' + fmt('TSERR cumulative  ', a.TSERR_cum));
      console.log(' ' + fmt('D3  uinput->JS    ', a.D3));
      console.log(' ' + fmt('D3b uinput->stamp ', a.D3b));
      console.log(' ' + fmt('coalesced/move    ', a.coalPerMove));
      console.log(' ' + fmt('coalesced/rawEvent', a.coalPerRaw));
      console.log(' ' + fmt('predicted/move    ', a.predPerMove));
      console.log(' ' + fmt('frame dt          ', a.frameDt));
    }
    if (a.D3 && a.D3.n) console.log(`  CONTROL shift (ref t0 vs t1) p50 = ${(a.D3_t0.p50 - a.D3.p50).toFixed(4)} ms | expected ${(c[4] / 1000).toFixed(3)} ms`);
  } catch (e) { console.log(' FAILED: ' + e.message); }
}

const wr = await page.evaluate(() => window.__C2P__.workerRelay(4000));
console.log('\n' + fmt('main->Worker postMessage one-way (origin-corrected)', stats(wr.oneWay)));
console.log(fmt('main->Worker->main round trip                     ', stats(wr.rt)));
writeFileSync(`${OUT}/e5-${TAG}.json`, JSON.stringify({ info, clk, rr0, results, worker: { oneWay: stats(wr.oneWay), rt: stats(wr.rt) }, errs }, null, 2));
console.log('ERRORS:', errs.slice(0, 5));
vm.stop(); await browser.close(); srv.close();
