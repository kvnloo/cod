/**
 * Reads the baked vertex tints out of a live character debug scene.
 *
 * Character albedo is `texture × vertexTint`, and the tint already carries
 * baked occlusion, so tuning it from screenshots alone is guesswork. This
 * prints the mean and minimum tint of every material group for the first eight
 * soldiers in the line-up.
 *
 *   node src/characters/dev/tints.mjs --port 4405 --dist dist-c3
 */
import { openSession, ensureServer, stopServer } from '../../../tools/harness.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const port = Number(flag('port', 4405));
const dist = String(flag('dist', 'dist-c3'));
const SLOT = ['skin', 'cloth', 'gear', 'hard', 'metal'];

const base = await ensureServer({ port, outDir: dist });
const session = await openSession({ url: `${base}/?debug=characters`, width: 640, height: 360, quality: 'ultra' });
const kit = await session.page.evaluate(() => globalThis.__CHARDBG__?.kit?.() ?? null);
if (kit) for (const k of kit.filter((x) => x.z === 16)) console.log('CLOSEUP', JSON.stringify(k));
const stats = await session.page.evaluate(() => globalThis.__CHARDBG__?.stats?.() ?? null);
if (!stats) {
  console.log('no __CHARDBG__ on the page');
} else {
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    const parts = s.groups.map((g) => {
      const lum = 0.2126 * g.mean[0] + 0.7152 * g.mean[1] + 0.0722 * g.mean[2];
      return `${(SLOT[g.slot] ?? g.slot).padEnd(5)} mean=${lum.toFixed(4)} min=${g.min.toFixed(4)}`;
    });
    console.log(`#${i} ${s.faction}`);
    for (const p of parts) console.log('   ', p);
  }
}
await session.close();
await stopServer();
process.exit(0);
