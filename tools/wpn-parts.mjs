#!/usr/bin/env node
/**
 * Part-splitting diagnostic.
 *
 * Renders the VKR-7 hero rig with one flat hue per submitted geometry and dumps
 * the hue table, so a stray polygon in a screenshot can be traced back to the
 * exact `add()` that emitted it.
 *
 *   node tools/wpn-parts.mjs --port 4404 --dist dist-wp3 --no-build
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
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

const port = Number(flag('port', 4404));
const distDir = String(flag('dist', 'dist-wp3'));
const outDir = path.join(ROOT, 'shots', String(flag('label', 'wpn-parts')));

async function main() {
  if (!has('no-build')) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', distDir], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
    });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('build failed'); }
  }
  const base = await ensureServer({ port, outDir: distDir });
  const lines = [];
  const session = await openSession({
    url: `${base}/?debug=weapons&probe=1`, width: 1920, height: 1080,
    onConsole: (m) => { if (m.text.startsWith('[part]')) lines.push(m.text); },
  });
  await session.setHUD(false);
  for (const name of ['wpn-detail-assault', 'wpn-hero-assault']) {
    await session.setShot(name, {});
    await session.shoot(path.join(outDir, `${name}.png`));
  }
  for (const l of lines) console.log(l);
  await session.close();
  await stopServer();
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
