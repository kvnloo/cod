import { chromium } from 'playwright';
import { GPU_ARGS, findChrome } from '/workspace/zer0/products/cod/tools/harness.mjs';

const browser = await chromium.launch({ executablePath: findChrome(), args: [...GPU_ARGS, '--window-size=1280,720'], timeout: 60000 });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 500)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e?.stack || e).slice(0, 1500)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
await page.goto('http://127.0.0.1:4213/src/characters/dev/index.html?debug=characters&capture=1&quality=ultra&seed=1337', { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => !!globalThis.__BLACKOUT__?.readyFlag, undefined, { timeout: 60000, polling: 250 });
  console.log('READY');
  console.log(await page.evaluate(() => globalThis.__BLACKOUT__.listShots()));
} catch (e) {
  console.log('NOT READY:', String(e).slice(0, 300));
  console.log(await page.evaluate(() => document.getElementById('fatal-text')?.textContent?.slice(0, 2000) ?? 'no fatal text'));
}
await browser.close();
process.exit(0);
