#!/usr/bin/env node
/**
 * Matchmaking speed-versus-fairness frontier.
 *
 * The widening curve has one job: decide how much queue time a player pays for
 * a better lobby. That trade cannot be argued about usefully in prose, so this
 * walks the two knobs that actually move it and prints the frontier.
 *
 *   botFillFloor       fraction of the lobby that must be human when bots arm
 *   joinInProgressAfter  seconds before a searching ticket may be diverted into
 *                        a live match instead of helping build a new one
 *
 *   node tools/session-mm-sweep.mjs [--seed N] [--population N] [--attempts N]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.mmout');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SEED = Number(flag('seed', 20260729));
const POPULATION = Number(flag('population', 500));
const ATTEMPTS = Number(flag('attempts', 1000));

function build() {
  mkdirSync(OUT, { recursive: true });
  const entry = path.join(ROOT, 'src', 'session', 'matchmaking', 'index.ts');
  const r = spawnSync('npx', ['rolldown', entry, '--format', 'esm', '-d', OUT, '--platform', 'node'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('rolldown bundle failed'); }
  return path.join(OUT, 'index.js');
}

const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

function table(rows, cols) {
  const head = cols.map((c) => c.label);
  const body = rows.map((r) => cols.map((c) => String(c.get(r))));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => '  ' + cells.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(line(w.map((n) => '-'.repeat(n))));
  for (const b of body) console.log(line(b));
}

async function main() {
  const mm = await import(pathToFileURL(argv.includes('--no-build') ? path.join(OUT, 'index.js') : build()).href);

  const base = { seed: SEED, population: POPULATION, attempts: ATTEMPTS };
  const rows = [];

  console.log(`\n=== FRONTIER: botFillFloor (joinInProgressAfter = 25 s) ===`);
  console.log(`    population ${POPULATION}, ${ATTEMPTS} attempts, core-tdm-6v6 (12 slots)\n`);
  for (const floor of [0, 0.25, 0.4, 0.5, 0.6, 0.7, 0.75, 0.85, 1.0]) {
    const s = mm.runSimulation({ ...base, joinInProgressAfter: 25, widening: { botFillFloor: floor } });
    rows.push({ knob: 'floor', v: floor, s });
  }
  table(rows, [
    { label: 'botFillFloor', get: (r) => r.v.toFixed(2) },
    { label: 'q50 (s)', get: (r) => n1(r.s.queueSeconds.p50) },
    { label: 'q95 (s)', get: (r) => n1(r.s.queueSeconds.p95) },
    { label: 'bots@form %', get: (r) => (r.s.botFillRate * 100).toFixed(1) },
    { label: 'bot occ %', get: (r) => (r.s.botOccupancy * 100).toFixed(1) },
    { label: 'spread', get: (r) => n1(r.s.skillSpread.mean) },
    { label: 'ping', get: (r) => n1(r.s.hostPing.mean) },
    { label: 'matches', get: (r) => r.s.matches },
    { label: 'r(rating)', get: (r) => r.s.ratingCorrelation.toFixed(3) },
  ]);

  const rows2 = [];
  console.log(`\n=== FRONTIER: joinInProgressAfter (botFillFloor = 0.6) ===\n`);
  for (const jip of [5, 10, 20, 30, 45, 60, 90]) {
    const s = mm.runSimulation({ ...base, joinInProgressAfter: jip, widening: { botFillFloor: 0.6 } });
    rows2.push({ v: jip, s });
  }
  table(rows2, [
    { label: 'joinInProgress (s)', get: (r) => String(r.v) },
    { label: 'q50 (s)', get: (r) => n1(r.s.queueSeconds.p50) },
    { label: 'q95 (s)', get: (r) => n1(r.s.queueSeconds.p95) },
    { label: 'bots@form %', get: (r) => (r.s.botFillRate * 100).toFixed(1) },
    { label: 'bot occ %', get: (r) => (r.s.botOccupancy * 100).toFixed(1) },
    { label: 'ping', get: (r) => n1(r.s.hostPing.mean) },
    { label: 'matches', get: (r) => r.s.matches },
    { label: 'r(rating)', get: (r) => r.s.ratingCorrelation.toFixed(3) },
  ]);

  const rows3 = [];
  console.log(`\n=== POPULATION SENSITIVITY (botFillFloor 0.6, joinInProgressAfter 25) ===\n`);
  for (const pop of [40, 100, 250, 500, 1200]) {
    const s = mm.runSimulation({
      seed: SEED, population: pop, attempts: Math.min(ATTEMPTS, pop * 2),
      joinInProgressAfter: 25, widening: { botFillFloor: 0.6 },
    });
    rows3.push({ v: pop, s });
  }
  table(rows3, [
    { label: 'population', get: (r) => String(r.v) },
    { label: 'q50 (s)', get: (r) => n1(r.s.queueSeconds.p50) },
    { label: 'q95 (s)', get: (r) => n1(r.s.queueSeconds.p95) },
    { label: 'bots@form %', get: (r) => (r.s.botFillRate * 100).toFixed(1) },
    { label: 'bot occ %', get: (r) => (r.s.botOccupancy * 100).toFixed(1) },
    { label: 'ping', get: (r) => n1(r.s.hostPing.mean) },
    { label: 'matches', get: (r) => r.s.matches },
  ]);
  console.log('\nThe bot-fill rate is a *population* readout, not a tuning failure:');
  console.log('a thin playlist cannot produce human lobbies that do not exist.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
