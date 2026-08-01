/* E6 — load-insensitive probes:
 *  (a) non-COI clock clamp: is the prior "0.1 ms p50" a measurement or a quantum?
 *  (b) unadjustedMovement under Ozone/X11 as well as Wayland
 *  (c) what input APIs exist inside a DedicatedWorker at all
 */
import { serve, launch, sleep, takeFocus, OUT, FLAGS } from './lib.mjs';
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const out = {};

/* ---- (a) clock resolution + timestamp granularity, COI vs non-COI ---------- */
for (const [tag, port, coi] of [['non-COI', 9803, false], ['COI', 9843, true]]) {
  const srv = await serve(port, { coi });
  const { browser, page } = await launch({ url: `http://127.0.0.1:${port}/` });
  const info = await page.evaluate(() => window.__C2P__.info());
  const clk = await page.evaluate(() => window.__C2P__.clockRes(600000));
  // granularity of Event.timeStamp itself: dispatch a synthetic burst and look at distinct values
  const ts = await page.evaluate(async () => {
    const got = [];
    const h = (e) => got.push([e.timeStamp, performance.now()]);
    window.addEventListener('pointerrawupdate', h, { passive: true });
    window.addEventListener('pointermove', h, { passive: true });
    await new Promise((r) => setTimeout(r, 50));
    return got.length;
  });
  out[tag] = { coi: info.coi, sab: info.sab, clockMinDeltaMs: clk.minDeltaMs, changes: clk.changes, iter: clk.iter, origin: info.origin };
  console.log(`[${tag}] crossOriginIsolated=${info.coi} SharedArrayBuffer=${info.sab} performance.now() min nonzero delta = ${clk.minDeltaMs} ms`);
  await browser.close(); srv.close();
}
const ratio = out['non-COI'].clockMinDeltaMs / out['COI'].clockMinDeltaMs;
console.log(`  -> non-COI clock quantum is ${ratio.toFixed(1)}x coarser. Any latency p50 reported at ~0.1 ms on a non-COI origin is AT THE FLOOR.`);

/* ---- (b) unadjustedMovement: Wayland vs X11 ------------------------------- */
async function lockProbe(platform) {
  const srv = await serve(9853, { coi: true });
  const args = FLAGS.filter((f) => !f.startsWith('--ozone-platform')).concat([`--ozone-platform=${platform}`, '--window-size=1400,900']);
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false, args, timeout: 60_000 });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:9853/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__C2P_READY__ === true, undefined, { timeout: 20000 });
  await sleep(800); takeFocus(); await sleep(600);
  const res = {};
  for (const v of ['none', 'false', 'true']) {
    await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
    await sleep(250); takeFocus(); await sleep(250);
    await page.mouse.move(600, 400); await page.mouse.down(); await page.mouse.up(); await sleep(150);
    res[v] = await page.evaluate(async (vv) => {
      const cv = document.getElementById('gl');
      try {
        const p = vv === 'none' ? cv.requestPointerLock() : cv.requestPointerLock({ unadjustedMovement: vv === 'true' });
        if (p && p.then) await p; else await new Promise((r) => setTimeout(r, 500));
        return { locked: document.pointerLockElement === cv, err: null };
      } catch (e) { return { locked: document.pointerLockElement === cv, err: String(e.name + ': ' + e.message) }; }
    }, v);
    await sleep(150);
  }
  const ua = await page.evaluate(() => navigator.userAgent);
  await browser.close(); srv.close();
  return { platform, ua, res };
}
for (const p of ['wayland', 'x11']) {
  try { const r = await lockProbe(p); out['lock_' + p] = r; console.log(`[pointerlock ${p}] ${JSON.stringify(r.res)}`); }
  catch (e) { out['lock_' + p] = { error: e.message }; console.log(`[pointerlock ${p}] FAILED ${e.message}`); }
}

/* ---- (c) what input APIs exist in a DedicatedWorker ----------------------- */
{
  const srv = await serve(9843, { coi: true });
  const { browser, page } = await launch({ url: 'http://127.0.0.1:9843/' });
  const w = await page.evaluate(async () => {
    const src = `self.onmessage=()=>{self.postMessage({
      PointerEvent: typeof PointerEvent,
      MouseEvent: typeof MouseEvent,
      hasAddEventListener: typeof self.addEventListener,
      onpointerrawupdate_in_self: ('onpointerrawupdate' in self),
      onpointermove_in_self: ('onpointermove' in self),
      document: typeof self.document,
      navigatorHid: typeof (self.navigator && self.navigator.hid),
      getGamepads: typeof (self.navigator && self.navigator.getGamepads),
      requestAnimationFrame: typeof self.requestAnimationFrame,
      SharedArrayBuffer: typeof SharedArrayBuffer,
      AtomicsWait: (()=>{ try { const sab=new SharedArrayBuffer(8); const ia=new Int32Array(sab); Atomics.wait(ia,0,1,0); return 'ok'; } catch(e){ return String(e.name); } })(),
    });};`;
    const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const p = new Promise((r) => { wk.onmessage = (e) => r(e.data); });
    wk.postMessage(1);
    return p;
  });
  // and on the main thread, for contrast
  const m = await page.evaluate(() => {
    let aw = 'n/a';
    try { const sab = new SharedArrayBuffer(8); Atomics.wait(new Int32Array(sab), 0, 1, 0); aw = 'ok'; } catch (e) { aw = String(e.name + ': ' + e.message); }
    return { onpointerrawupdate_in_window: ('onpointerrawupdate' in window), AtomicsWait: aw };
  });
  out.worker = w; out.main = m;
  console.log('[worker scope]', JSON.stringify(w, null, 1));
  console.log('[main thread ]', JSON.stringify(m));
  await browser.close(); srv.close();
}

writeFileSync(`${OUT}/e6-probes.json`, JSON.stringify(out, null, 2));
