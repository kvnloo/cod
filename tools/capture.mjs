#!/usr/bin/env node
/**
 * Shot runner: builds (unless --no-build), boots the game in headless Chromium
 * with hardware WebGL, walks every registered camera shot and writes PNGs plus a
 * manifest to `shots/<label>/`.
 *
 * Usage:
 *   node tools/capture.mjs                       # all shots, 1920x1080, ultra
 *   node tools/capture.mjs --shots a,b --w 2560 --h 1440 --label pass3
 *   node tools/capture.mjs --hud --quality cinematic
 */
import { openSession, ensureServer, stopServer, cleanDir, ROOT } from './harness.mjs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const label = String(flag('label', 'latest'));
const width = Number(flag('w', 1920));
const height = Number(flag('h', 1080));
const quality = String(flag('quality', 'ultra'));
const only = flag('shots') ? String(flag('shots')).split(',').map((s) => s.trim()) : null;
const showHud = has('hud');
const outDir = path.join(ROOT, 'shots', label);
// Distinct port + build dir let several agents capture concurrently.
const port = Number(flag('port', 4173));
const distDir = String(flag('dist', 'dist'));

async function main() {
  if (!has('no-build')) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', distDir], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
    });
    if (r.status !== 0) {
      console.error(r.stdout + r.stderr);
      throw new Error('build failed');
    }
  }
  const base = await ensureServer({ port, outDir: distDir });
  await cleanDir(outDir);

  const debug = flag('debug');
  const session = await openSession({
    url: debug ? `${base}/?debug=${encodeURIComponent(String(debug))}` : base,
    width, height, quality,
  });
  console.log(`[capture] GPU: ${session.renderer}`);

  const names = only ?? (await session.shots());
  const manifest = { label, width, height, quality, gpu: session.renderer, shots: [] };

  await session.setHUD(showHud);
  for (const name of names) {
    const info = await session.page.evaluate((n) => globalThis.__BLACKOUT__.shotInfo(n), name);
    await session.setShot(name, {});
    const file = path.join(outDir, `${name}.png`);
    await session.shoot(file);
    const stats = await session.stats();
    manifest.shots.push({ name, file: path.relative(ROOT, file), description: info?.description ?? '', stats });
    console.log(
      `[capture] ${name.padEnd(22)} ${stats.drawCalls} calls  ` +
      `${(stats.triangles / 1000).toFixed(0)}k tris  ${stats.frameMs.toFixed(1)}ms`,
    );
  }

  if (session.errors.length) {
    manifest.errors = session.errors.slice(0, 40);
    console.warn(`[capture] ${session.errors.length} console error(s):`);
    for (const e of session.errors.slice(0, 8)) console.warn('   ', e.slice(0, 240));
  }

  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await session.close();
  await stopServer();
  console.log(`[capture] wrote ${manifest.shots.length} shots → ${path.relative(ROOT, outDir)}`);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  process.exit(1);
});
