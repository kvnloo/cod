/* Shared rig for the input-path measurements. */
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = '/workspace/zer0/products/cod/shots/c2p-input-path';
mkdirSync(OUT, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ server */
export function serve(port, { coi = false } = {}) {
  const html = readFileSync(path.join(HERE, 'page.html'));
  const srv = http.createServer((req, res) => {
    const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (coi) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; h['cross-origin-resource-policy'] = 'same-origin'; }
    res.writeHead(200, h); res.end(html);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

/* ------------------------------------------------------------------ chrome */
// Deliberately minimal + explicit. NO --disable-gpu-vsync, NO --disable-frame-rate-limit
// (BENCHMARKS.md §0 #2: those produced the meaningless "2355 Hz rAF" result).
export const FLAGS = [
  '--ozone-platform=wayland',
  '--enable-features=UseOzonePlatform',
  '--use-angle=vulkan',
  '--use-gl=angle',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-first-run',
  '--no-default-browser-check',
];

export async function launch({ url, width = 1900, height = 1000 }) {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: false,
    args: [...FLAGS, `--window-size=${width},${height}`],
    timeout: 60_000,
  });
  const ctx = await browser.newContext({ viewport: null, permissions: [] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.__C2P_READY__ === true, undefined, { timeout: 30_000 });
  await sleep(900);
  const addr = takeFocus();
  await sleep(600);
  return { browser, ctx, page, errs, addr };
}

/** Find *our* window by title, raise it fullscreen on DP-1 and park the cursor in it.
 *  Another agent keeps a fullscreen Chromium on the same workspace; without this the
 *  window never gets pointer focus and zero input is delivered. */
export function takeFocus() {
  let addr = null;
  try {
    const cl = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }));
    const mine = cl.find((w) => /c2p input path/.test(w.title || ''));
    if (!mine) return null;
    addr = mine.address;
    execFileSync('hyprctl', ['dispatch', 'focuswindow', `address:${addr}`]);
    // Pin to DP-1. BENCHMARKS §0 #1: a run that silently lands on the 240 Hz
    // output is exactly how the previous budget table got built on 240 Hz maths.
    if (mine.monitor !== 0) {
      execFileSync('hyprctl', ['dispatch', 'movewindow', 'mon:DP-1']);
      execFileSync('hyprctl', ['dispatch', 'focuswindow', `address:${addr}`]);
    }
    execFileSync('hyprctl', ['dispatch', 'fullscreen', '0']);
    const mons = JSON.parse(execFileSync('hyprctl', ['monitors', '-j'], { encoding: 'utf8' }));
    const dp1 = mons.find((m) => m.name === 'DP-1');
    if (dp1) execFileSync('hyprctl', ['dispatch', 'movecursor', String(dp1.x + Math.round(dp1.width / 2)), String(dp1.y + Math.round(dp1.height / 2))]);
  } catch {}
  return addr;
}

export function activeWindow() {
  try { const w = JSON.parse(execFileSync('hyprctl', ['activewindow', '-j'], { encoding: 'utf8' })); return { cls: w.class, title: w.title, monitor: w.monitor, fs: w.fullscreen }; } catch { return null; }
}

export function hypr(args) { try { return execFileSync('hyprctl', args, { encoding: 'utf8' }); } catch (e) { return 'ERR ' + e.message; } }

export function chromeCmdline() {
  try {
    const pids = execFileSync('pgrep', ['-f', 'ozone-platform=wayland'], { encoding: 'utf8' }).trim().split('\n');
    for (const p of pids) {
      const c = readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (c[0] && c[0].includes('chromium') && !c.some((x) => x.startsWith('--type='))) return c;
    }
  } catch {}
  return null;
}

/* ------------------------------------------------------------------ vmouse */
/** Persistent uinput device. Creating a fresh device per burst raced with
 *  libinput/compositor enumeration and silently produced 0-delivery runs. */
export class VMouseDaemon {
  constructor() { this.p = null; this.q = []; }
  async start() {
    this.p = spawn(path.join(HERE, 'vmouse'), ['--mode', 'daemon', '--warmup-ms', '1500'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        const r = this.q.shift(); if (r) r(line);
      }
    });
    await new Promise((r) => this.q.push(r)); // 'ready'
  }
  burst(rate, count, mode, delayUs, outFile) {
    return new Promise((res) => { this.q.push(res); this.p.stdin.write(`${rate} ${count} ${mode} ${delayUs} ${outFile}\n`); });
  }
  stop() { try { this.p.stdin.end(); this.p.kill('SIGTERM'); } catch {} }
}

export function vmouse(args, outFile) {
  return new Promise((res, rej) => {
    const p = spawn(path.join(HERE, 'vmouse'), [...args, '--out', outFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('vmouse exit ' + c + ' ' + err))));
  });
}

export function readVmouse(file) {
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const anchor = JSON.parse(lines[0]);
  const ev = lines.slice(1).map((l) => JSON.parse(l));
  return { anchor, ev };
}

/* ------------------------------------------------------------------ stats */
export function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
export function stats(arr, unit = 'ms') {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length, unit,
    min: +s[0].toFixed(4), p50: +pct(s, 50).toFixed(4), p90: +pct(s, 90).toFixed(4),
    p99: +pct(s, 99).toFixed(4), p999: +pct(s, 99.9).toFixed(4), max: +s[s.length - 1].toFixed(4),
    mean: +(sum / s.length).toFixed(4),
  };
}
export function fmt(name, st) {
  if (!st || !st.n) return `${name}: NO DATA`;
  return `${name}: n=${st.n} p50=${st.p50} p90=${st.p90} p99=${st.p99} p99.9=${st.p999} max=${st.max} min=${st.min} mean=${st.mean} ${st.unit}`;
}

/* Measure achieved rAF rate in the page (B0.4). */
export async function refreshRate(page, n = 400) {
  return page.evaluate(async (N) => {
    const t = [];
    await new Promise((res) => {
      let i = 0;
      const f = (ts) => { t.push(ts); if (++i < N + 60) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f);
    });
    const d = []; for (let i = 61; i < t.length; i++) d.push(t[i] - t[i - 1]);
    d.sort((a, b) => a - b);
    const p = (q) => d[Math.min(d.length - 1, Math.round((q / 100) * (d.length - 1)))];
    return { n: d.length, p50: p(50), p99: p(99), hz: 1000 / (d.reduce((a, b) => a + b, 0) / d.length) };
  }, n);
}
