#!/usr/bin/env node
/**
 * Character-module capture: boots the module's own dev entry through the shared
 * harness so screenshots can be taken before main.ts registers the system.
 */
import { openSession, ensureServer, stopServer, cleanDir, ROOT } from '/workspace/zer0/products/cod/tools/harness.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const label = String(flag('label', 'WORKING'));
const width = Number(flag('w', 1920));
const height = Number(flag('h', 1080));
const quality = String(flag('quality', 'ultra'));
const port = Number(flag('port', 4213));
const only = flag('shots') ? String(flag('shots')).split(',').map((s) => s.trim()) : null;
const outDir = path.join(ROOT, 'shots', label);

async function main() {
  const base = await ensureServer({ mode: 'dev', port });
  await cleanDir(outDir);
  const url = `${base}/src/characters/dev/index.html?debug=characters`;
  const session = await openSession({ url, width, height, quality });
  console.log(`[chars] GPU: ${session.renderer}`);

  const names = only ?? (await session.shots());
  const manifest = { label, width, height, quality, gpu: session.renderer, shots: [] };
  await session.setHUD(false);
  for (const name of names) {
    const info = await session.page.evaluate((n) => globalThis.__BLACKOUT__.shotInfo(n), name);
    await session.setShot(name, {});
    const file = path.join(outDir, `${name}.png`);
    await session.shoot(file);
    const stats = await session.stats();
    manifest.shots.push({ name, file: path.relative(ROOT, file), description: info?.description ?? '', stats });
    console.log(`[chars] ${name.padEnd(20)} ${stats.drawCalls} calls  ${(stats.triangles / 1000).toFixed(0)}k tris  ${stats.frameMs.toFixed(1)}ms`);
  }

  if (session.errors.length) {
    manifest.errors = session.errors.slice(0, 40);
    console.warn(`[chars] ${session.errors.length} console error(s):`);
    for (const e of session.errors.slice(0, 10)) console.warn('   ', String(e).slice(0, 400));
  }
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await session.close();
  await stopServer();
  console.log(`[chars] wrote ${manifest.shots.length} shots to ${outDir}`);
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
