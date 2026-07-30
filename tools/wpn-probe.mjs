#!/usr/bin/env node
/**
 * Weapon-module diagnostics.
 *
 * Reports, for a list of first-person shots, where the sight and the reticle
 * actually land in normalised device coordinates. "The sight looks centred" is
 * not a measurement; this is.
 *
 *   node tools/wpn-probe.mjs --port 4404 --dist dist-wp3 [--no-build]
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
import { spawnSync } from 'node:child_process';

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
const shots = String(flag('shots', [
  'wpn-fp-ads', 'wpn-fp-ads-reddot', 'wpn-fp-ads-holo', 'wpn-fp-ads-acog',
  'wpn-fp-ads-irons', 'wpn-fp-ads-offaxis', 'wpn-fp-sniper-ads', 'wpn-fp-pistol-ads',
  'wpn-fp-hip',
].join(','))).split(',');

async function main() {
  if (!has('no-build')) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', distDir], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
    });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('build failed'); }
  }
  const base = await ensureServer({ port, outDir: distDir });
  const session = await openSession({ url: `${base}/?debug=weapons`, width: 1920, height: 1080 });
  for (const name of shots) {
    try {
      await session.setShot(name, {});
    } catch (e) {
      console.log(`${name.padEnd(22)} MISSING`);
      continue;
    }
    const p = await session.page.evaluate(() => globalThis.__wpnProbe?.() ?? null);
    console.log(`${name.padEnd(22)} ${JSON.stringify(p)}`);
  }
  for (const e of session.errors.slice(0, 10)) console.warn('  err:', String(e).slice(0, 200));
  await session.close();
  await stopServer();
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
