import { openSession, ensureServer, stopServer } from '../../../tools/harness.mjs';
const base = await ensureServer({ mode: 'dev', port: 4213 });
const s = await openSession({ url: `${base}/src/characters/dev/index.html?debug=characters`, width: 1920, height: 1080, quality: 'ultra' });
await s.setShot('char-states', {});
const r = await s.measure(5000);
console.log(JSON.stringify(r, null, 1));
console.log('stats', JSON.stringify(await s.stats()));
await s.close(); await stopServer();
process.exit(0);
