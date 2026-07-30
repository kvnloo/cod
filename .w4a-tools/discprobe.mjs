import { openSession, ensureServer, stopServer } from '/workspace/zer0/products/cod/tools/harness.mjs';
import path from 'node:path';

const out = '/workspace/zer0/products/cod/shots/w4-sun-disc';
const base = await ensureServer({ port: 4501, outDir: 'dist-w4a' });
const session = await openSession({ url: base, width: 1920, height: 1080, quality: 'ultra' });
await session.setHUD(false);
for (const [shot, fov, hour] of [['render-sky', 75, 15.8], ['render-sky', 75, 15.0]]) {
  await session.setShot(shot, { fov, hour, viewModel: false, settle: 30 });
  await session.shoot(path.join(out, `${shot}-h${String(hour).replace('.','_')}.png`));
  console.log('shot', shot, fov, hour);
}
await session.close();
await stopServer();
