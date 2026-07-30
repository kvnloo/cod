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
import { mkdir } from 'node:fs/promises';

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
    const better = nu.earlyRate < old.earlyRate;
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

  /* ------------------------------------------------------------ verdict -- */

  const agg = { early: 0, measured: 0, insideMin: 0, spawns: 0, losCount: 0, oldEarly: 0, oldMeasured: 0 };
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
    ['every mode improved on the baseline', allBetter, allBetter ? 'yes' : 'no'],
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
