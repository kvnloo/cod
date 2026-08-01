/**
 * Hit registration: does a round aimed at a stationary body at a known range
 * actually arrive? Sweeps aim height band by band and reports, for each band,
 * what a MASK_BULLET ray from the camera hits and what fraction of real rounds
 * scored. Distinguishes occlusion from hitreg failure.
 */
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';
import { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, ensureScratchTmp } from './playtest.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

ensureScratchTmp();
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };

const base = await ensureServer({ port: +arg('port', 9951), outDir: arg('dist', 'dist-gpc-1') });
const url = `${base}/?capture=1&quality=high&mode=operation&seed=1337`;
const s = await openSession({ url, width: 1280, height: 720, quality: 'high', seed: 1337 });
await s.exec(INSTALL_INPUT_BRIDGE);
await s.exec(INSTALL_PROBE);

const out = await s.exec(() => {
  const P = globalThis.__PT__, a = P.api, e = globalThis.engine;
  const hold = globalThis.__PT_HOLD__;
  const physics = e.tryGet('physics');
  const weapons = e.get('weapons');
  a.setRender(false);
  for (let i = 0; i < 900; i++) e.stepFrame(1 / 120);
  a.markHome(true);

  const mkHit = () => ({
    hit: false, point: e.camera.position.clone(), normal: e.camera.position.clone(),
    distance: Infinity, surface: 'concrete', object: null,
    entityId: -1, bodyHandle: -1, zone: 'none', backface: false,
  });
  const hitA = mkHit();

  const rows = [];
  const WEAPONS = ['ar_vkr7', 'smg_hornet', 'lmg_vulcan', 'pi_sidewinder', 'dmr_kestrel'];
  const RANGES = [10, 25, 40, 50];
  const FRACS = [0.94, 0.72, 0.5, 0.22];

  for (const wid of WEAPONS) {
    for (const metres of RANGES) {
      a.setSpawnLock(true); a.clearActors();
      a.setCombat(false); a.setFrozen(true); a.resetLifecycle();
      a.goHome(); a.giveWeapon(wid); a.refill();
      const lane = a.sightLane(metres);
      const spawn = a.spawnTarget(lane.yaw, metres, { archetype: 'rifleman', health: 1, seed: 11 });
      if (spawn.id < 0) continue;
      // settle a few steps so the body is where physics thinks it is
      for (let i = 0; i < 24; i++) e.stepFrame(1 / 120);
      const bot = a.botState(spawn.id);
      if (!bot) continue;

      for (const frac of FRACS) {
        // live body position each time — the capsule may have settled
        const b = a.botState(spawn.id);
        if (!b || !b.alive) break;
        const tx = b.pos[0], ty = b.pos[1] + b.height * frac, tz = b.pos[2];
        // what does a bullet-mask ray from the eye actually hit?
        const from = e.camera.position;
        const dir = e.camera.position.clone().set(tx - from.x, ty - from.y, tz - from.z);
        const dist = dir.length();
        dir.multiplyScalar(1 / dist);
        const h = physics.raycast(from, dir, dist + 2, 1 | 2 | 4 | 8 | 16 | 128, hitA, 1);
        const rayInfo = h && h.hit
          ? { zone: h.zone, entityId: h.entityId, distance: +h.distance.toFixed(2), surface: h.surface, short: +(dist - h.distance).toFixed(2) }
          : { zone: 'nothing', entityId: -1, distance: -1, surface: null, short: -1 };

        // now fire real rounds
        const hpBefore = b.hp;
        a.refill();
        for (let i = 0; i < 60; i++) { a.aimAt(tx, ty, tz); hold(['ads'], []); e.stepFrame(1 / 120); }
        a.resetCounters();
        const semi = weapons.current.fireMode !== 'auto';
        let fired = 0, prevAmmo = weapons.current.ammo;
        for (let i = 0; i < 240; i++) {
          a.aimAt(tx, ty, tz);
          if (semi) {
            const ph = i % 6;
            if (ph === 0) hold(['ads', 'fire'], ['fire']);
            else if (ph === 1) hold(['ads', 'fire'], []);
            else hold(['ads'], []);
          } else hold(['ads', 'fire'], i === 0 ? ['fire'] : []);
          e.stepFrame(1 / 120);
          if (weapons.current.ammo < prevAmmo) fired += prevAmmo - weapons.current.ammo;
          prevAmmo = weapons.current.ammo;
          if (weapons.current.ammo === 0) { a.refill(); prevAmmo = weapons.current.ammo; }
          const st = a.botState(spawn.id);
          if (!st || !st.alive) break;
        }
        hold([], []);
        const hurts = P.hurts.slice();
        const st = a.botState(spawn.id);
        rows.push({
          weapon: wid, metres, frac,
          hitscanRange: weapons.current.def.ballistics.hitscanRange,
          laneOk: lane.ok,
          ray: rayInfo,
          fired, hits: hurts.length,
          hitRate: fired ? +(hurts.length / fired).toFixed(3) : 0,
          dmgPerHit: hurts.length ? +(hurts.reduce((x, y) => x + y.amount, 0) / hurts.length).toFixed(2) : 0,
          zones: [...new Set(hurts.map((x) => (x.headshot ? 'head' : 'body')))],
          hpBefore, hpAfter: st ? st.hp : 0, alive: st ? st.alive : false,
        });
        // heal the target so the next band starts clean
        if (st && st.alive) {
          const bots = globalThis.__BLACKOUT_GAME__.services.actors.bots || [];
          for (const bb of bots) if (bb.id === spawn.id) bb.health = bb.maxHealth;
        } else break;
      }
      a.setSpawnLock(false);
    }
  }
  a.setCombat(true); a.setFrozen(false);
  return { rows };
});

const bad = out.rows.filter((r) => r.hitRate < 0.5);
console.log('weapon         m  frac  hitscanR  fired hits  rate  ray→zone/ent/dist(short)   dmg');
for (const r of out.rows) {
  console.log(
    `${r.weapon.padEnd(14)} ${String(r.metres).padStart(2)}  ${r.frac.toFixed(2)}  ${String(r.hitscanRange).padStart(2)}      `
    + `${String(r.fired).padStart(4)} ${String(r.hits).padStart(4)}  ${r.hitRate.toFixed(2)}  `
    + `${r.ray.zone}/${r.ray.entityId}/${r.ray.distance}(${r.ray.short})`.padEnd(28)
    + ` ${r.dmgPerHit}`);
}
console.log(`\nrows with hit rate < 0.5: ${bad.length} of ${out.rows.length}`);
await mkdir(path.join(ROOT, 'shots/gpc-combat'), { recursive: true });
await writeFile(path.join(ROOT, 'shots/gpc-combat/hitreg.json'), JSON.stringify(out, null, 2));
await s.close();
await stopServer();
