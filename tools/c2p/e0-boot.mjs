/* E0 — environment capture + rig validation (BENCHMARKS §B0). */
import { serve, launch, refreshRate, chromeCmdline, hypr, sleep, OUT } from './lib.mjs';
import { writeFileSync } from 'node:fs';

const PORT = 9803;
const srv = await serve(PORT);
const { browser, page, errs } = await launch({ url: `http://127.0.0.1:${PORT}/` });

const info = await page.evaluate(() => window.__C2P__.info());
console.log('INFO', JSON.stringify(info, null, 1));

await page.evaluate(() => window.__C2P__.startRaf());
await sleep(300);
const rows = [];
for (const load of [0, 32, 128]) {
  await page.evaluate((n) => window.__C2P__.setLoad(n), load);
  await sleep(400);
  const rr = await refreshRate(page, 400);
  rows.push({ load, ...rr });
  console.log(`rAF load=${load}: n=${rr.n} p50=${rr.p50.toFixed(3)}ms p99=${rr.p99.toFixed(3)}ms achieved=${rr.hz.toFixed(2)}Hz`);
}
await page.evaluate((n) => window.__C2P__.setLoad(n), 0);

const clk = await page.evaluate(() => window.__C2P__.clockRes(400000));
console.log('performance.now() resolution (non-COI):', JSON.stringify(clk));

console.log('MONITORS:\n' + hypr(['monitors', '-j']).slice(0, 40) + '...');
const wins = hypr(['clients', '-j']);
const chromeWins = JSON.parse(wins).filter((w) => /chromium/i.test(w.class || ''));
console.log('CHROME WINDOWS:', JSON.stringify(chromeWins.map((w) => ({ at: w.at, size: w.size, monitor: w.monitor, fullscreen: w.fullscreen, focus: w.focusHistoryID })), null, 1));

const cmd = chromeCmdline();
console.log('CHROME CMDLINE (B0.5):', JSON.stringify(cmd, null, 1));
console.log('ERRORS:', errs);

writeFileSync(`${OUT}/e0-boot.json`, JSON.stringify({ info, raf: rows, clk, chromeWins, cmd, errs }, null, 2));
await browser.close(); srv.close();
