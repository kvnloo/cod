/* E2 — pointer lock: does it work at all, and does unadjustedMovement exist on this platform? */
import { serve, launch, sleep, takeFocus, activeWindow, OUT } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const srv = await serve(9843, { coi: true });
const { browser, page, errs } = await launch({ url: 'http://127.0.0.1:9843/' });
await page.evaluate(() => window.__C2P__.startRaf());
takeFocus(); await sleep(600);
console.log('active:', JSON.stringify(activeWindow()));

const out = [];
for (const variant of ['none', 'false', 'true']) {
  await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
  await sleep(300);
  takeFocus(); await sleep(300);
  await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.up();
  await sleep(150);
  const r = await page.evaluate(async (v) => {
    const cv = document.getElementById('gl');
    const opt = v === 'none' ? undefined : { unadjustedMovement: v === 'true' };
    let ret = { variant: v, returnsPromise: false, locked: false, err: null };
    try {
      const p = opt === undefined ? cv.requestPointerLock() : cv.requestPointerLock(opt);
      ret.returnsPromise = !!(p && typeof p.then === 'function');
      if (ret.returnsPromise) await p;
      else await new Promise((res, rej) => {
        const ok = () => { cl(); res(); }, bad = () => { cl(); rej(new Error('pointerlockerror event')); };
        const cl = () => { document.removeEventListener('pointerlockchange', ok); document.removeEventListener('pointerlockerror', bad); };
        document.addEventListener('pointerlockchange', ok); document.addEventListener('pointerlockerror', bad);
        setTimeout(() => { cl(); rej(new Error('timeout')); }, 2500);
      });
    } catch (e) { ret.err = String(e && e.message || e); }
    ret.locked = document.pointerLockElement === cv;
    return ret;
  }, variant);
  console.log(JSON.stringify(r));
  out.push(r);
  await sleep(200);
}

// Does the *accelerated* lock produce 1:1 deltas? (i.e. is acceleration even applied here)
await page.evaluate(() => { try { document.exitPointerLock(); } catch {} });
await sleep(300); takeFocus(); await sleep(300);
await page.mouse.move(900, 500); await page.mouse.down(); await page.mouse.up(); await sleep(150);
const lockOk = await page.evaluate(async () => {
  const cv = document.getElementById('gl');
  try { const p = cv.requestPointerLock(); if (p && p.then) await p; else await new Promise(r => setTimeout(r, 400)); } catch (e) { return { err: String(e.message) }; }
  return { locked: document.pointerLockElement === cv };
});
console.log('plain lock for delta test:', JSON.stringify(lockOk));
writeFileSync(`${OUT}/e2-lock.json`, JSON.stringify({ out, lockOk, errs }, null, 2));
console.log('errs', errs.slice(0, 5));
await browser.close(); srv.close();
