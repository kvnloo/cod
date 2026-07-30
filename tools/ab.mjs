#!/usr/bin/env node
/**
 * A/B shot runner for the render module.
 *
 * Captures the same camera shot several times with one render feature changed
 * per variant, so a difference in the image can only be caused by that feature.
 *
 *   node tools/ab.mjs --port 4403 --dist dist-r3 --label ab1 \
 *     --shots square-north,market \
 *     --variants "base:|noao:pass gtao 0|nograin:set filmGrain 0"
 *
 * Variant syntax: `name:cmd; cmd; ...` where cmd is
 *   `pass <name> <0|1>`  enable/disable a post pass
 *   `set <key> <value>`  poke settings.gfx
 */
import { openSession, ensureServer, stopServer, cleanDir, ROOT } from './harness.mjs';
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

const label = String(flag('label', 'ab'));
const port = Number(flag('port', 4403));
const distDir = String(flag('dist', 'dist'));
const width = Number(flag('w', 1920));
const height = Number(flag('h', 1080));
const quality = String(flag('quality', 'ultra'));
const shots = String(flag('shots', 'square-north')).split(',').map((s) => s.trim());
const variants = String(flag('variants', 'base:')).split('|').map((v) => {
  const i = v.indexOf(':');
  return { name: v.slice(0, i), cmds: v.slice(i + 1).split(';').map((c) => c.trim()).filter(Boolean) };
});
// Optional time-of-day sweep: each shot is captured once per hour listed.
const hours = flag('hours') ? String(flag('hours')).split(',').map(Number) : [null];
const outDir = path.join(ROOT, 'shots', label);

function apply(cmds) {
  return (list) => {
    const dbg = globalThis.__RENDER__;
    if (!dbg) throw new Error('__RENDER__ missing');
    for (const c of list) {
      const t = c.split(/\s+/);
      if (t[0] === 'pass') dbg.setPass(t[1], t[2] !== '0');
      else if (t[0] === 'set') dbg.set(t[1], t[2] === 'true' ? true : t[2] === 'false' ? false : Number(t[2]));
    }
    return null;
  };
}

async function main() {
  if (!has('no-build')) {
    const r = spawnSync('npx', ['vite', 'build', '--outDir', distDir], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
    });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('build failed'); }
  }
  const base = await ensureServer({ port, outDir: distDir });
  await cleanDir(outDir);
  const session = await openSession({ url: base, width, height, quality });
  console.log(`[ab] GPU: ${session.renderer}`);
  console.log('[ab] sun:', JSON.stringify(await session.exec(() => globalThis.__RENDER__.sun())));
  console.log('[ab] passes:', JSON.stringify(await session.exec(() => globalThis.__RENDER__.passes())));
  await session.setHUD(false);

  for (const v of variants) {
    await session.exec(apply(v.cmds), v.cmds);
    for (const s of shots) {
      for (const h of hours) {
        await session.setShot(s, h === null ? {} : { hour: h, settle: 40 });
        const tag = h === null ? '' : `__h${String(h).replace('.', '_')}`;
        await session.shoot(path.join(outDir, `${s}__${v.name}${tag}.png`));
      }
    }
    console.log(`[ab] ${v.name.padEnd(14)} ${v.cmds.join('; ')}`);
  }

  if (session.errors.length) {
    console.warn(`[ab] ${session.errors.length} console error(s):`);
    for (const e of session.errors.slice(0, 6)) console.warn('   ', e.slice(0, 300));
  }
  await session.close();
  await stopServer();
  console.log(`[ab] wrote → ${path.relative(ROOT, outDir)}`);
}

main().catch(async (e) => { console.error(e); await stopServer(); process.exit(1); });
