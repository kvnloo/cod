#!/usr/bin/env node
/**
 * Spawn-quality benchmark.
 *
 * Bundles `src/session/spawn` with rolldown, then plays thousands of simulated
 * respawns across three modes and three selectors on the same map with the same
 * seeds, and prints the number that decides whether the spawn system is any
 * good: **what fraction of spawns end in a death within three seconds.**
 *
 * Usage:
 *   node tools/session-spawn.mjs                    # full sweep
 *   node tools/session-spawn.mjs --quick            # one seed, short matches
 *   node tools/session-spawn.mjs --seeds 8 --duration 600
 *   node tools/session-spawn.mjs --mode tdm --field # ASCII influence dump
 */
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const quick = has('quick');
const SEEDS = Number(flag('seeds', quick ? 2 : 6));
const DURATION = Number(flag('duration', quick ? 180 : 420));
const MODES = flag('mode') ? [String(flag('mode'))] : ['tdm', 'domination', 'sd'];
const SELECTORS = ['influence', 'baseline', 'random'];
const SHOW_FIELD = has('field') || !quick;

const OUT_DIR = path.join(ROOT, 'dist-s6-sim');
const OUT_FILE = path.join(OUT_DIR, 'spawn.mjs');

/* ------------------------------------------------------------------ build -- */

async function bundle() {
  await mkdir(OUT_DIR, { recursive: true });
  const b = await rolldown({
    input: path.join(ROOT, 'src/session/spawn/index.ts'),
    logLevel: 'warn',
  });
  await b.write({ file: OUT_FILE, format: 'esm' });
  await b.close();
  return import(`file://${OUT_FILE}?t=${Date.now()}`);
}

const ADAPTER_FILE = path.join(OUT_DIR, 'game-spawns.mjs');
const ADAPTER_ENTRY = path.join(OUT_DIR, 'adapter-entry.ts');

/**
 * Bundles the *game-layer* adapter (`src/game/Spawns.ts`) through a generated
 * entry that also re-exports `Rand`, so the harness never has to rely on node
 * being able to import TypeScript directly.
 */
async function bundleAdapter() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(ADAPTER_ENTRY,
    "export * from '../src/game/Spawns';\nexport { Rand } from '../src/core/Rand';\n");
  const b = await rolldown({ input: ADAPTER_ENTRY, external: ['three'], logLevel: 'warn' });
  await b.write({ file: ADAPTER_FILE, format: 'esm' });
  await b.close();
  return import(`file://${ADAPTER_FILE}?t=${Date.now()}`);
}

/* ------------------------------------------------------- adapter test rig -- */

/** A handful of solid blocks, enough that line of sight means something. */
const BLOCKS = [];
for (let i = -2; i <= 2; i++) {
  for (let j = -2; j <= 2; j++) {
    if ((i + j) % 2 !== 0) continue;
    BLOCKS.push({ x: i * 22, z: j * 22, hx: 7, hz: 7, hy: 5 });
  }
}

function segmentBlocked(ax, ay, az, bx, by, bz) {
  for (const b of BLOCKS) {
    // Slab test against the box, in the segment's parameter space.
    let t0 = 0, t1 = 1;
    const lo = [b.x - b.hx, 0, b.z - b.hz];
    const hi = [b.x + b.hx, b.hy, b.z + b.hz];
    const o = [ax, ay, az];
    const d = [bx - ax, by - ay, bz - az];
    let out = false;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-9) {
        if (o[k] < lo[k] || o[k] > hi[k]) { out = true; break; }
        continue;
      }
      let n = (lo[k] - o[k]) / d[k];
      let f = (hi[k] - o[k]) / d[k];
      if (n > f) { const t = n; n = f; f = t; }
      if (n > t0) t0 = n;
      if (f < t1) t1 = f;
      if (t0 > t1) { out = true; break; }
    }
    if (!out) return true;
  }
  return false;
}

function insideBlock(x, z, margin = 0) {
  for (const b of BLOCKS) {
    if (Math.abs(x - b.x) < b.hx + margin && Math.abs(z - b.z) < b.hz + margin) return true;
  }
  return false;
}

/** Minimal `PhysicsAPI` — only the three calls `SpawnGraph` actually makes. */
const stubPhysics = {
  ready: true,
  raycast(origin, dir, maxDist, _mask, out) {
    if (dir.y < -0.5) {                      // ground probe
      out.hit = !insideBlock(origin.x, origin.z, 0.5);
      out.distance = origin.y;
      out.point.set(origin.x, 0, origin.z);
      out.normal.set(0, 1, 0);
      return out;
    }
    const bx = origin.x + dir.x * maxDist;
    const bz = origin.z + dir.z * maxDist;
    out.hit = segmentBlocked(origin.x, origin.y, origin.z, bx, origin.y, bz);
    out.distance = out.hit ? maxDist * 0.5 : maxDist;
    out.point.set(bx, origin.y, bz);
    out.normal.set(0, 1, 0);
    return out;
  },
  lineOfSight(a, b) {
    return !segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z);
  },
};

/**
 * Drives `SpawnGraph` — the surface `src/game/Director.ts` actually calls —
 * through a few hundred respawns and enemy insertions, and checks the two
 * promises that matter at the game layer: a friendly respawn is never handed a
 * pad in a live hostile's lap, and an enemy never materialises inside the
 * player's view.
 */
function runAdapter(mod, THREE, Rand, requests = 400) {
  const graph = new mod.SpawnGraph();
  const rng = new Rand('adapter');
  const world = {
    bounds: new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 12, 60)),
    spawns: [],
  };
  for (let x = -50; x <= 50; x += 10) {
    for (let z = -50; z <= 50; z += 10) {
      if (insideBlock(x, z, 1.5)) continue;
      world.spawns.push({
        position: new THREE.Vector3(x, 0, z),
        yaw: Math.atan2(-x, -z),
        team: x < -16 ? 'player' : x > 16 ? 'enemy' : 'neutral',
      });
    }
  }
  graph.build(world, stubPhysics, rng, 32);
  graph.setMode('tdm');

  const q = mod.defaultQuery();
  const eye = new THREE.Vector3(0, 1.6, 30);
  const threats = [];
  for (let i = 0; i < 5; i++) threats.push(new THREE.Vector3(0, 0, 0));
  const allies = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)];

  let friendlyPicks = 0, friendlyTooClose = 0, friendlyNull = 0, minFriendly = Infinity;
  let enemyPicks = 0, enemyVisible = 0, enemyNull = 0, outOfBand = 0;
  let t0 = 0;
  const now0 = performance.now();

  for (let i = 0; i < requests; i++) {
    const now = i * 0.7;
    // Hostiles wander; the camera looks at the middle of the map.
    for (let k = 0; k < threats.length; k++) {
      const a = rng.range(-Math.PI, Math.PI);
      const r = rng.range(6, 46);
      threats[k].set(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
    for (const a of allies) a.set(rng.range(-50, -20), 0, rng.range(-50, 50));
    eye.set(threats[0].x, 1.6, threats[0].z);

    q.now = now;
    q.threats = threats;
    q.allies = allies;
    q.viewOrigin = eye;
    q.viewDir.set(-eye.x, 0, -eye.z).normalize();

    /* --- friendly respawn --- */
    q.team = 'any';
    q.requireHidden = false;
    q.minDistance = 16;
    q.maxDistance = 78;
    const t = performance.now();
    const f = graph.pick(q, stubPhysics, rng);
    t0 += performance.now() - t;
    if (!f) friendlyNull++;
    else {
      friendlyPicks++;
      let d = Infinity;
      for (const th of threats) d = Math.min(d, f.position.distanceTo(th));
      minFriendly = Math.min(minFriendly, d);
      if (d < 16) friendlyTooClose++;
      graph.markUsed(f, now);
    }

    /* --- enemy insertion, must not appear on camera --- */
    q.team = 'enemy';
    q.requireHidden = true;
    q.idealDistance = 34;
    q.minDistance = 18;
    const e = graph.pick(q, stubPhysics, rng);
    if (!e) enemyNull++;
    else {
      enemyPicks++;
      if (graph.isVisible(e.position, q, stubPhysics)) enemyVisible++;
      const d = e.position.distanceTo(eye);
      if (d < q.minDistance || d > q.maxDistance) outOfBand++;
      graph.markUsed(e, now);
    }

    if (i % 9 === 0) graph.noteDeath(threats[0], now);
    if (i % 17 === 0) graph.addHazard(threats[1], 8, now + 3, 'frag');
  }

  return {
    nodes: graph.nodes.length,
    friendlyPicks, friendlyTooClose, friendlyNull, minFriendly,
    enemyPicks, enemyVisible, enemyNull, outOfBand,
    usPerPick: (t0 / Math.max(1, requests)) * 1000,
    wallMs: performance.now() - now0,
    quality: graph.quality(requests * 0.7),
  };
}

/* ------------------------------------------------------------------- run -- */

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function aggregate(results) {
  const a = {
    runs: results.length,
    spawns: 0, measured: 0, earlyDeaths: 0, instantDeaths: 0, deaths: 0,
    distSum: 0, distCount: 0, minDist: Infinity, losCount: 0,
    survivalSum: 0, survivalCount: 0,
    insideMin: 0, withLos: 0, kills: 0,
    p05: [], selectMs: 0, selectCount: 0,
    outcomes: {}, vetoes: {}, worst: [],
  };
  for (const r of results) {
    const rep = r.report;
    a.spawns += rep.spawns;
    a.measured += rep.measured;
    a.earlyDeaths += rep.earlyDeaths;
    a.instantDeaths += Math.round(rep.instantDeathRate * rep.measured);
    a.deaths += rep.deaths;
    a.distSum += rep.meanEnemyDistance * rep.spawns;
    a.distCount += rep.spawns;
    a.minDist = Math.min(a.minDist, rep.minEnemyDistance);
    a.losCount += Math.round(rep.losRate * rep.spawns);
    a.survivalSum += rep.meanSurvival * rep.deaths;
    a.survivalCount += rep.deaths;
    a.insideMin += r.spawnsInsideMinDistance;
    a.withLos += r.spawnsWithEnemyLos;
    a.kills += r.kills;
    a.p05.push(r.p05EnemyDistance);
    a.selectMs += r.selectMs;
    a.selectCount += rep.spawns;
    for (const [k, v] of Object.entries(r.outcomes)) a.outcomes[k] = (a.outcomes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(rep.vetoes)) a.vetoes[k] = (a.vetoes[k] ?? 0) + v;
    for (const w of rep.worst) a.worst.push(w);
  }
  a.earlyRate = a.measured > 0 ? a.earlyDeaths / a.measured : 0;
  a.instantRate = a.measured > 0 ? a.instantDeaths / a.measured : 0;
  a.meanDist = a.distCount > 0 ? a.distSum / a.distCount : 0;
  a.losRate = a.spawns > 0 ? a.losCount / a.spawns : 0;
  a.meanSurvival = a.survivalCount > 0 ? a.survivalSum / a.survivalCount : 0;
  a.meanP05 = a.p05.length > 0 ? a.p05.reduce((s, v) => s + v, 0) / a.p05.length : 0;
  a.meanSelectMs = a.selectCount > 0 ? a.selectMs / a.selectCount : 0;
  a.worst.sort((x, y) => x.survived - y.survived);
  a.worst = a.worst.slice(0, 5);
  return a;
}

async function main() {
  const t0 = Date.now();
  process.stdout.write('[spawn] bundling src/session/spawn ... ');
  const mod = await bundle();
  console.log(`ok (${Date.now() - t0} ms)`);

  const { runSpawnSim, asciiInfluence, asciiHeat } = mod;

  // Warm the JIT before anything is timed. Without this the us/pick column is
  // mostly a measurement of how long V8 took to tier up the scorer, and short
  // runs read 2x slower than long ones for no reason anybody can act on.
  for (const mode of ['tdm', 'domination', 'sd']) {
    runSpawnSim({ seed: 1, mode, selector: 'influence', duration: 60, teamSize: 6, dt: 0.1 });
  }

  const table = new Map();          // `${mode}/${selector}` -> aggregate
  let fieldDump = null;
  let heatDump = null;
  let totalSpawns = 0;

  for (const mode of MODES) {
    for (const selector of SELECTORS) {
      const runs = [];
      for (let s = 0; s < SEEDS; s++) {
        const seed = 20260730 + s * 7919;
        const collectHeat = selector === 'influence' && s === 0 && mode === MODES[0];
        const r = runSpawnSim({
          seed, mode, selector, duration: DURATION, teamSize: 6, dt: 0.1,
          respawnDelay: 5, collectHeat,
        });
        runs.push(r);
        totalSpawns += r.report.spawns;
        if (collectHeat && r.influence) {
          fieldDump = { snap: r.influence, mode };
          heatDump = { snap: r.influence, spawns: r.spawnPositions, deaths: r.deathPositions };
        }
      }
      table.set(`${mode}/${selector}`, aggregate(runs));
    }
  }

  /* ------------------------------------------------------------- report -- */

  console.log('');
  console.log(`SPAWN QUALITY — ${SEEDS} seeds x ${DURATION}s per cell, 6v6, ${totalSpawns} spawn requests total`);
  console.log('');
  console.log(
    `${pad('mode/selector', 22)}${padL('spawns', 8)}${padL('death<3s', 10)}${padL('death<1.5s', 12)}`
    + `${padL('meanDist', 10)}${padL('p05Dist', 9)}${padL('minDist', 9)}${padL('enemyLoS', 10)}`
    + `${padL('survival', 10)}${padL('us/pick', 9)}`,
  );
  console.log('-'.repeat(109));
  for (const mode of MODES) {
    for (const selector of SELECTORS) {
      const a = table.get(`${mode}/${selector}`);
      console.log(
        `${pad(`${mode}/${selector}`, 22)}${padL(a.spawns, 8)}${padL(pct(a.earlyRate), 10)}`
        + `${padL(pct(a.instantRate), 12)}${padL(`${num(a.meanDist)}m`, 10)}`
        + `${padL(`${num(a.meanP05)}m`, 9)}${padL(`${num(a.minDist)}m`, 9)}`
        + `${padL(pct(a.losRate), 10)}${padL(`${num(a.meanSurvival, 2)}s`, 10)}`
        + `${padL(num(a.meanSelectMs * 1000, 0), 9)}`,
      );
    }
    console.log('-'.repeat(109));
  }

  /* --- improvement --- */
  console.log('');
  console.log('IMPROVEMENT vs previous implementation (src/session/spawn/Baseline.ts, verbatim)');
  console.log('');
  let allBetter = true;
  let worstRatio = 0;
  for (const mode of MODES) {
    const nu = table.get(`${mode}/influence`);
    const old = table.get(`${mode}/baseline`);
    const rnd = table.get(`${mode}/random`);
    const ratio = old.earlyRate > 0 ? nu.earlyRate / old.earlyRate : 0;
    worstRatio = Math.max(worstRatio, ratio);
    // A mode where neither selector ever lost a spawn is a tie, not a regression.
    const better = nu.earlyRate < old.earlyRate || (nu.earlyRate === 0 && old.earlyRate === 0);
    allBetter = allBetter && better;
    console.log(
      `  ${pad(mode, 12)} spawn-death rate ${padL(pct(nu.earlyRate), 8)} vs ${padL(pct(old.earlyRate), 8)} baseline`
      + ` (${padL(pct(rnd.earlyRate), 8)} random)  ->  `
      + `${old.earlyRate > 0 ? `${((1 - ratio) * 100).toFixed(1)}% fewer spawn deaths` : 'n/a'}`,
    );
    console.log(
      `  ${pad('', 12)} mean enemy distance ${num(nu.meanDist)}m vs ${num(old.meanDist)}m`
      + `   |  spawns inside 18 m: ${nu.insideMin} vs ${old.insideMin}`
      + `   |  spawned in enemy sight: ${pct(nu.withLos / Math.max(1, nu.spawns))} vs ${pct(old.withLos / Math.max(1, old.spawns))}`,
    );
  }

  /* --- detail on the new system --- */
  const tdm = table.get(`${MODES[0]}/influence`);
  console.log('');
  console.log(`SELECTOR DETAIL (${MODES[0]}/influence)`);
  console.log(`  outcome mix       : ${Object.entries(tdm.outcomes).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const vetoes = Object.entries(tdm.vetoes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  console.log(`  candidates vetoed : ${vetoes.map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
  console.log(`  worst outcomes    :`);
  for (const w of tdm.worst) {
    console.log(
      `      actor ${padL(w.actorId, 4)} died ${num(w.survived, 2)}s after spawning at `
      + `(${num(w.x, 0)}, ${num(w.z, 0)}) — nearest enemy ${num(w.enemyDistance)}m, `
      + `enemy LoS ${w.enemyLos ? 'yes' : 'no'}, outcome ${w.outcome}`,
    );
  }

  if (SHOW_FIELD && fieldDump) {
    console.log('');
    console.log(`INFLUENCE FIELD at match end (${fieldDump.mode}) — '#'/'@' hostile ground, mirrored ramp friendly, '.' contested`);
    console.log(asciiInfluence(fieldDump.snap, 60));
    console.log(`  friendly share ${pct(fieldDump.snap.friendlyShare)}  hostile share ${pct(fieldDump.snap.hostileShare)}  polarisation ${num(fieldDump.snap.polarisation, 3)}`);
  }
  if (SHOW_FIELD && heatDump && heatDump.spawns.length > 0) {
    console.log('');
    console.log('SPAWN HEAT (where the selector put people)');
    console.log(asciiHeat(heatDump.snap, heatDump.spawns, 60));
    console.log('');
    console.log('DEATH HEAT (where they died)');
    console.log(asciiHeat(heatDump.snap, heatDump.deaths, 60));
  }

  /* ------------------------------------------- game-layer adapter check -- */

  let adapter = null;
  let adapterError = null;
  try {
    const [gm, three] = await Promise.all([bundleAdapter(), import('three')]);
    adapter = runAdapter(gm, three, gm.Rand, 400);
  } catch (err) {
    adapterError = err;
  }

  console.log('');
  console.log('GAME ADAPTER (src/game/Spawns.ts — the surface src/game/Director.ts calls)');
  if (adapter) {
    console.log(`  nodes ${adapter.nodes}   ${adapter.friendlyPicks} friendly respawns, ${adapter.enemyPicks} enemy insertions in ${num(adapter.wallMs, 0)} ms`);
    console.log(`  friendly respawn inside 16 m of a hostile : ${adapter.friendlyTooClose}   (closest ${num(adapter.minFriendly)}m)`);
    console.log(`  enemy inserted inside the player's view   : ${adapter.enemyVisible}`);
    console.log(`  enemy outside the requested distance band : ${adapter.outOfBand}`);
    console.log(`  requests that returned nothing            : ${adapter.friendlyNull + adapter.enemyNull}`);
    console.log(`  ${num(adapter.usPerPick, 0)} us per respawn`);
  } else {
    console.log(`  SKIPPED — ${adapterError?.message ?? 'unavailable'}`);
  }

  /* ------------------------------------------------------------ verdict -- */

  const agg ={ early: 0, measured: 0, insideMin: 0, spawns: 0, losCount: 0, oldEarly: 0, oldMeasured: 0 };
  for (const mode of MODES) {
    const nu = table.get(`${mode}/influence`);
    const old = table.get(`${mode}/baseline`);
    agg.early += nu.earlyDeaths; agg.measured += nu.measured;
    agg.insideMin += nu.insideMin; agg.spawns += nu.spawns; agg.losCount += nu.withLos;
    agg.oldEarly += old.earlyDeaths; agg.oldMeasured += old.measured;
  }
  const newRate = agg.measured > 0 ? agg.early / agg.measured : 1;
  const oldRate = agg.oldMeasured > 0 ? agg.oldEarly / agg.oldMeasured : 1;

  const checks = [
    ['spawn-death rate below 8%', newRate < 0.08, `${pct(newRate)}`],
    ['at least 35% better than the previous implementation', newRate < oldRate * 0.65, `${pct(newRate)} vs ${pct(oldRate)}`],
    ['no spawn inside the 18 m hard minimum', agg.insideMin === 0, `${agg.insideMin} violations in ${agg.spawns} spawns`],
    ['fewer than 12% of spawns visible to an enemy', agg.losCount / Math.max(1, agg.spawns) < 0.12, pct(agg.losCount / Math.max(1, agg.spawns))],
    ['selection under 250 us per request', tdm.meanSelectMs < 0.25, `${num(tdm.meanSelectMs * 1000, 0)} us`],
    ['no mode regressed against the baseline', allBetter, allBetter ? 'yes' : 'no'],
    ['game adapter never spawns an enemy on camera',
      !!adapter && adapter.enemyVisible === 0,
      adapter ? `${adapter.enemyVisible} of ${adapter.enemyPicks}` : 'adapter did not run'],
    ['game adapter always returns a spawn',
      !!adapter && adapter.friendlyNull + adapter.enemyNull === 0,
      adapter ? `${adapter.friendlyNull + adapter.enemyNull} empty` : 'adapter did not run'],
  ];

  console.log('');
  console.log('CHECKS');
  let pass = true;
  for (const [name, ok, detail] of checks) {
    if (!ok) pass = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pad(name, 52)} ${detail}`);
  }
  console.log('');
  console.log(`${pass ? 'PASS' : 'FAIL'} — spawn-death rate ${pct(newRate)} (previous implementation ${pct(oldRate)}), `
    + `${agg.spawns} spawns over ${MODES.length * SELECTORS.length * SEEDS} simulated matches, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
