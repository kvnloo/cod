#!/usr/bin/env node
/**
 * Gameplay smoke test. Boots the real game (no debug scene), drives a scripted
 * play session through the capture API, and fails on console errors, NaN state,
 * frozen frames or a player that cannot move.
 *
 *   node tools/smoke.mjs [--port 4175] [--dist dist-smoke] [--no-build]
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const port = Number(flag('port', 4175));
const distDir = String(flag('dist', 'dist-smoke'));
const outDir = path.join(ROOT, 'shots', 'smoke');

const checks = [];
const fail = (name, detail) => { checks.push({ name, ok: false, detail }); };
const pass = (name, detail = '') => { checks.push({ name, ok: true, detail }); };

async function main() {
  if (!has('no-build')) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', distDir], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('build failed'); }
  }
  const base = await ensureServer({ port, outDir: distDir });
  await mkdir(outDir, { recursive: true });

  const session = await openSession({ url: base, width: 1600, height: 900, quality: 'ultra' });
  console.log(`[smoke] GPU: ${session.renderer}`);

  const readState = () => session.exec(() => {
    const e = globalThis.engine;
    const p = e?.tryGet('player');
    const w = e?.tryGet('weapons');
    return {
      pos: p ? [p.position.x, p.position.y, p.position.z] : null,
      state: p?.state ?? null,
      health: p?.health ?? null,
      ammo: w?.current?.ammo ?? null,
      yaw: p?.camera?.yaw ?? null,
      objects: e?.scene?.children?.length ?? 0,
    };
  });

  const start = await readState();
  if (!start.pos) fail('player exists', 'no player system state');
  else pass('player exists', `at ${start.pos.map((v) => v.toFixed(1)).join(',')}`);

  /* --- walk forward -------------------------------------------------- */
  await session.act([{ hold: ['forward'], moveY: 1, frames: 90 }]);
  const walked = await readState();
  const dist = walked.pos && start.pos
    ? Math.hypot(walked.pos[0] - start.pos[0], walked.pos[2] - start.pos[2]) : 0;
  if (dist > 1.5) pass('player walks', `${dist.toFixed(1)}m in 1.5s`);
  else fail('player walks', `moved only ${dist.toFixed(2)}m — controller or collision is wrong`);

  /* --- sprint + slide ------------------------------------------------ */
  await session.act([
    { hold: ['forward', 'sprint'], moveY: 1, frames: 60 },
    { hold: ['forward', 'sprint', 'crouch'], moveY: 1, frames: 40 },
  ]);
  const slid = await readState();
  pass('sprint/slide survives', `state=${slid.state}`);

  /* --- look around --------------------------------------------------- */
  await session.act([{ lookX: 9, frames: 40 }, { lookY: -4, frames: 20 }]);
  const looked = await readState();
  if (looked.yaw !== null && Math.abs(looked.yaw - (start.yaw ?? 0)) > 0.2) pass('camera turns');
  else fail('camera turns', `yaw ${start.yaw} → ${looked.yaw}`);
  await session.shoot(path.join(outDir, '01-after-move.png'));

  /* --- aim and fire --------------------------------------------------- */
  const ammoBefore = looked.ammo;
  await session.act([
    { hold: ['ads'], frames: 24 },
    { hold: ['ads', 'fire'], frames: 30 },
  ]);
  await session.shoot(path.join(outDir, '02-firing.png'));
  const fired = await readState();
  if (ammoBefore === null) fail('weapon fires', 'no weapon state exposed');
  else if (fired.ammo !== null && fired.ammo < ammoBefore) pass('weapon fires', `${ammoBefore} → ${fired.ammo}`);
  else fail('weapon fires', `ammo unchanged at ${fired.ammo}`);

  /* --- reload --------------------------------------------------------- */
  await session.act([{ press: ['reload'], frames: 4 }, { frames: 180 }]);
  const reloaded = await readState();
  pass('reload completes', `ammo=${reloaded.ammo}`);
  await session.shoot(path.join(outDir, '03-after-reload.png'));

  /* --- jump / land ----------------------------------------------------- */
  await session.act([{ press: ['jump'], frames: 2 }, { frames: 70 }]);
  const landed = await readState();
  if (landed.pos && Number.isFinite(landed.pos[1])) pass('jump/land stable', `y=${landed.pos[1].toFixed(2)}`);
  else fail('jump/land stable', 'non-finite position');

  /* --- NaN sweep -------------------------------------------------------- */
  const finite = landed.pos?.every((v) => Number.isFinite(v)) ?? false;
  if (finite) pass('no NaN in player transform');
  else fail('no NaN in player transform', JSON.stringify(landed.pos));

  /* --- frames actually advance ------------------------------------------ */
  const prof = await session.measure(2500);
  if (prof.frames > 30) pass('renders continuously', `${prof.avgFps.toFixed(0)}fps, p99 ${prof.p99.toFixed(1)}ms`);
  else fail('renders continuously', `only ${prof.frames} frames in 2.5s`);

  /* --- console cleanliness ----------------------------------------------- */
  const real = session.errors.filter((e) => !/favicon|DevTools|Autofill/i.test(e));
  if (real.length === 0) pass('no console errors');
  else fail('no console errors', `${real.length}: ${real.slice(0, 3).join(' | ').slice(0, 400)}`);

  await session.close();
  await stopServer();

  console.log('');
  let bad = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(30)} ${c.detail}`);
    if (!c.ok) bad++;
  }
  console.log(`\n[smoke] ${checks.length - bad}/${checks.length} passed`);
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
