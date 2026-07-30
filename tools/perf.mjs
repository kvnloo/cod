#!/usr/bin/env node
/**
 * Performance gate. Runs each shot free-wheeling for a few seconds and reports
 * frame-time percentiles per quality preset.
 *
 *   node tools/perf.mjs --presets ultra,high --ms 5000
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const presets = String(flag('presets', 'ultra')).split(',');
const ms = Number(flag('ms', 4000));
const width = Number(flag('w', 1920));
const height = Number(flag('h', 1080));
const port = Number(flag('port', 4174));
const distDir = String(flag('dist', 'dist'));
const only = flag('shots') ? String(flag('shots')).split(',').map((shot) => shot.trim()).filter(Boolean) : null;

async function main() {
  if (!has('no-build')) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', distDir], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('build failed'); }
  }
  const base = await ensureServer({ port, outDir: distDir });
  const results = [];

  for (const preset of presets) {
    const session = await openSession({ url: base, width, height, quality: preset });
    const available = await session.shots();
    const shots = only ?? available;
    const missing = shots.filter((shot) => !available.includes(shot));
    if (missing.length) throw new Error(`unknown performance shot(s): ${missing.join(', ')}`);
    for (const name of shots) {
      const shotDefinition = await session.shotInfo(name);
      await session.setShot(name, {});
      const prof = await session.measure(ms);
      results.push({ preset, shot: name, shotDefinition, ...prof });
      const flag99 = prof.p99 > 16.7 ? '  ⚠ p99 over 60fps budget' : '';
      console.log(
        `${preset.padEnd(10)} ${name.padEnd(22)} ` +
        `avg ${prof.avgFps.toFixed(0).padStart(4)}fps  ` +
        `p50 ${prof.p50.toFixed(2)}ms  p95 ${prof.p95.toFixed(2)}ms  p99 ${prof.p99.toFixed(2)}ms  ` +
        `${prof.drawCalls} calls${flag99}`,
      );
    }
    await session.close();
  }

  await mkdir(path.join(ROOT, 'shots'), { recursive: true });
  await writeFile(path.join(ROOT, 'shots', 'perf.json'), JSON.stringify(results, null, 2));
  await stopServer();
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
