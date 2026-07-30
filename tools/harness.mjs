/**
 * GPU render harness.
 *
 * Drives the game inside headless Chromium with *hardware* WebGL2 (ANGLE/EGL on the
 * host GPU), waits for the deterministic capture API to come up, and produces
 * screenshots + frame statistics.
 *
 * The game must expose `window.__BLACKOUT__` implementing the contract in
 * `src/core/CaptureAPI.ts`. Everything downstream (shot lists, critic loops,
 * perf gates) is built on top of this file.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Chromium flags that unlock hardware-accelerated WebGL2 in a headless container. */
export const GPU_ARGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-dev-shm-usage',
  '--ozone-platform=headless',
  '--use-gl=angle',
  '--use-angle=gl-egl',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--enable-zero-copy',
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--force-color-profile=srgb',
  '--disable-partial-raster',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--js-flags=--expose-gc',
];

const CHROME_CANDIDATES = [
  process.env.BLACKOUT_CHROME,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/workspace/cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
];

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (c && existsSync(c)) return c;
  return undefined; // fall back to playwright's bundled browser
}

/* ------------------------------------------------------------------ server -- */

let sharedServer = null;

/**
 * Starts (once) a static server for the production build, or reuses an already
 * running dev server. Returns the base URL.
 */
export async function ensureServer({ mode = 'preview', port = 4173, quiet = true, outDir = 'dist' } = {}) {
  if (process.env.BLACKOUT_URL) return process.env.BLACKOUT_URL.replace(/\/$/, '');
  if (sharedServer) return sharedServer.url;

  const url = `http://127.0.0.1:${port}`;
  if (await isUp(url)) {
    sharedServer = { url, proc: null };
    return url;
  }

  const args = mode === 'dev'
    ? ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1']
    : ['vite', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'];

  const proc = spawn('npx', args, {
    cwd: ROOT,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  proc.unref?.();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) {
      sharedServer = { url, proc };
      return url;
    }
    await sleep(300);
  }
  proc.kill('SIGKILL');
  throw new Error(`server did not come up on ${url}`);
}

export async function stopServer() {
  if (sharedServer?.proc) {
    try { process.kill(-sharedServer.proc.pid, 'SIGKILL'); } catch { }
    try { sharedServer.proc.kill('SIGKILL'); } catch { }
  }
  sharedServer = null;
}

async function isUp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok || r.status === 404;
  } catch { return false; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ session -- */

/**
 * Opens a browser session pointed at the game with the capture API armed.
 *
 * @returns {Promise<Session>}
 */
export async function openSession({
  url,
  width = 1920,
  height = 1080,
  dpr = 1,
  quality = 'ultra',
  timeoutMs = 180_000,
  onConsole,
  seed = 1337,
} = {}) {
  const base = url ?? (await ensureServer());
  const browser = await chromium.launch({
    executablePath: findChrome(),
    args: [...GPU_ARGS, `--window-size=${width},${height}`],
    timeout: 60_000,
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    permissions: [],
  });
  const page = await context.newPage();

  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const rec = { type: m.type(), text: m.text() };
    logs.push(rec);
    if (m.type() === 'error') errors.push(rec.text);
    onConsole?.(rec);
  });
  page.on('pageerror', (e) => {
    errors.push(String(e?.stack || e));
    onConsole?.({ type: 'pageerror', text: String(e?.message || e) });
  });
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || '';
    if (!/ERR_ABORTED/.test(f)) errors.push(`requestfailed ${r.url()} ${f}`);
  });

  const sep = base.includes('?') ? '&' : '/?';
  const target = `${base}${sep}capture=1&quality=${encodeURIComponent(quality)}&seed=${seed}`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait for the game to report readiness through the capture contract.
  await page.waitForFunction(
    () => !!(globalThis).__BLACKOUT__?.readyFlag,
    undefined,
    { timeout: timeoutMs, polling: 250 },
  );

  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return d && gl ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  return new Session(browser, context, page, { logs, errors, base, renderer, width, height });
}

export class Session {
  constructor(browser, context, page, meta) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.logs = meta.logs;
    this.errors = meta.errors;
    this.base = meta.base;
    this.renderer = meta.renderer;
    this.width = meta.width;
    this.height = meta.height;
  }

  /** Names of every registered camera shot. */
  shots() {
    return this.page.evaluate(() => (globalThis).__BLACKOUT__.listShots());
  }

  /** Full definition of a registered shot, with `setup` stringified if present. */
  shotInfo(name) {
    return this.page.evaluate((n) => {
      const info = (globalThis).__BLACKOUT__.shotInfo(n);
      if (!info) return null;
      return { ...info, setupSource: typeof info.setup === 'function' ? String(info.setup) : null };
    }, name);
  }

  /** Positions the world/camera for a named shot and settles temporal effects. */
  async setShot(name, opts = {}) {
    await this.page.evaluate(
      ([n, o]) => (globalThis).__BLACKOUT__.setShot(n, o),
      [name, opts],
    );
  }

  /** Advances the simulation deterministically by `frames` steps of `dt` seconds. */
  async step(frames = 1, dt = 1 / 60) {
    await this.page.evaluate(
      ([f, d]) => (globalThis).__BLACKOUT__.step(f, d),
      [frames, dt],
    );
  }

  /**
   * Runs a scripted input sequence so action moments (firing, aiming, sprinting)
   * can be captured deterministically.
   *   await session.act([{ hold: ['ads'], frames: 22 }, { hold: ['ads','fire'], frames: 4 }])
   */
  async act(steps) {
    await this.page.evaluate((s) => globalThis.__BLACKOUT__.act(s), steps);
  }

  async setHUD(on) {
    await this.page.evaluate((v) => (globalThis).__BLACKOUT__.setHUD(v), on);
  }

  async setQuality(preset) {
    await this.page.evaluate((v) => (globalThis).__BLACKOUT__.setQuality(v), preset);
  }

  async exec(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /** Renderer + frame statistics for the most recent frames. */
  stats() {
    return this.page.evaluate(() => (globalThis).__BLACKOUT__.stats());
  }

  /** Screenshot of the canvas only, written to `file`. */
  async shoot(file, { fullPage = false } = {}) {
    await mkdir(path.dirname(file), { recursive: true });
    const el = await this.page.$('canvas#viewport');
    const buf = el && !fullPage
      ? await el.screenshot({ type: 'png' })
      : await this.page.screenshot({ type: 'png' });
    await writeFile(file, buf);
    return file;
  }

  /** Runs the game free (real rAF) for `ms` and returns frame-time percentiles. */
  async measure(ms = 4000) {
    await this.page.evaluate(() => (globalThis).__BLACKOUT__.beginProfile());
    await sleep(ms);
    return this.page.evaluate(() => (globalThis).__BLACKOUT__.endProfile());
  }

  async close() {
    try { await this.context.close(); } catch { }
    try { await this.browser.close(); } catch { }
  }
}

/* -------------------------------------------------------------------- utils -- */

export async function cleanDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
