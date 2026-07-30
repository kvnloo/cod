#!/usr/bin/env node
/**
 * Matchmaking verification.
 *
 * Bundles src/session/matchmaking with rolldown (the bundler vite already ships)
 * and runs the real queue headlessly:
 *
 *   1. widening curve table
 *   2. backfill admission truth table
 *   3. bot-fill scenario — four friends want a 6v6
 *   4. bot yield — a human backfills, a bot gives up its slot
 *   5. authority — a client cannot mutate the host's queue
 *   6. population simulation — 500 players, 1000 matchmaking attempts
 *   7. determinism — same seed, same numbers
 *
 *   node tools/session-mm.mjs [--seed N] [--population N] [--attempts N] [--no-build]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const SEED = Number(flag('seed', 20260729));
const POPULATION = Number(flag('population', 500));
const ATTEMPTS = Number(flag('attempts', 1000));
const OUT = path.join(ROOT, 'dist-s2', 'mm');

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };
const n2 = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) : 'n/a');
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function build() {
  mkdirSync(OUT, { recursive: true });
  const entry = path.join(ROOT, 'src', 'session', 'matchmaking', 'index.ts');
  const r = spawnSync(
    'npx',
    ['rolldown', entry, '--format', 'esm', '-d', OUT, '--platform', 'node'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    throw new Error('rolldown bundle failed');
  }
  return path.join(OUT, 'index.js');
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

async function main() {
  const bundle = has('no-build') ? path.join(OUT, 'index.js') : build();
  const mm = await import(pathToFileURL(bundle).href);

  /* ------------------------------------------------------ 1. widening -- */
  console.log('\n=== SEARCH-WIDENING CURVE (core playlist) ===');
  const curve = mm.curveTable();
  table(curve, [
    { label: 'wait(s)', get: (r) => r.t },
    { label: 'skill window (±SR)', get: (r) => r.skill },
    { label: 'ping window (ms)', get: (r) => r.ping },
    { label: 'cross-region', get: (r) => (r.crossRegion ? 'yes' : 'no') },
    { label: 'bot fill', get: (r) => (r.botFill ? 'armed' : '-') },
  ]);
  const monotonic = curve.every((r, i) => i === 0 || (r.skill >= curve[i - 1].skill && r.ping >= curve[i - 1].ping));
  check('widening curve is monotonic and capped', monotonic && curve[curve.length - 1].skill <= 900,
    `max skill ${curve[curve.length - 1].skill}, max ping ${curve[curve.length - 1].ping}`);

  /* ------------------------------------------------------ 2. backfill -- */
  console.log('\n=== BACKFILL ADMISSION RULES ===');
  const probe = mm.runBackfillPolicyProbe();
  table(probe, [
    { label: 'situation', get: (r) => r.label },
    { label: 'elapsed', get: (r) => pct(r.elapsedFraction) },
    { label: 'score gap', get: (r) => pct(r.scoreGapFraction) },
    { label: 'verdict', get: (r) => (r.verdict === 'ok' ? 'JOIN' : `REFUSE (${r.verdict})`) },
  ]);
  const byLabel = Object.fromEntries(probe.map((r) => [r.label, r.verdict]));
  check('fresh match accepts backfill', byLabel['fresh match'] === 'ok', byLabel['fresh match']);
  check('late match refuses backfill', byLabel['late match'] === 'too-late', byLabel['late match']);
  check('final 90 s refuses backfill', byLabel['final 90 s'] === 'too-late', byLabel['final 90 s']);
  check('blowout refuses backfill', byLabel['mid match, one-sided'] === 'blowout', byLabel['mid match, one-sided']);

  /* ------------------------------------------------------ 3. bot fill -- */
  console.log('\n=== BOT FILL: FOUR FRIENDS WANT A 6v6 ===');
  for (const playlist of ['private-6v6', 'core-tdm-6v6']) {
    const r = mm.runFriendGroupScenario(SEED, playlist, 4);
    console.log(`\n  playlist: ${playlist}`);
    console.log(`  launched after ${n2(r.secondsToLaunch)} s with ${r.humans} humans + ${r.bots} bots = ${r.slots} slots`);
    console.log(`  bot difficulty mix: ${JSON.stringify(r.difficulties)}`);
    table(r.teams, [
      { label: 'team', get: (x) => x.team },
      { label: 'humans', get: (x) => x.humans },
      { label: 'bots', get: (x) => x.bots },
      { label: 'mean rating', get: (x) => x.meanRating },
    ]);
    console.log(`  team rating delta: ${r.teamDelta}`);
    const y = r.afterYield;
    console.log(`  after a human backfills: ${y.humans} humans + ${y.bots} bots = ${y.slots} slots (${y.yielded} bot yielded)`);

    check(`${playlist}: 4 humans + 8 bots fill a 12-slot match`,
      r.humans === 4 && r.bots === 8 && r.slots === 12, `${r.humans}h/${r.bots}b`);
    check(`${playlist}: launches promptly`,
      r.secondsToLaunch >= 0 && r.secondsToLaunch <= (playlist === 'private-6v6' ? 7 : 26),
      `${n2(r.secondsToLaunch)} s`);
    check(`${playlist}: a bot yields its slot to the human`,
      y.yielded === 1 && y.humans === 5 && y.bots === 7 && y.slots === 12,
      `${y.humans}h/${y.bots}b/${y.slots} slots`);
    check(`${playlist}: teams balanced within 150 SR`, r.teamDelta <= 150, `${r.teamDelta} SR`);
  }

  /* ----------------------------------------------------- 4. authority -- */
  console.log('\n=== AUTHORITY: CLIENT REQUESTS, HOST DECIDES ===');
  const hub = new mm.TransportHub('host');
  const host = new mm.MatchmakingService({ transport: hub.transportFor('host'), store: new mm.RatingStore(null), seed: SEED });
  const client = new mm.MatchmakingService({ transport: hub.transportFor('c1'), store: new mm.RatingStore(null), seed: SEED });
  const ticketId = client.requestJoin('core-tdm-6v6');
  console.log(`  client.requestJoin() returned ${ticketId} (null = deferred to host)`);
  console.log(`  client queue size ${client.queue.size}, host queue size ${host.queue.size}`);
  console.log(`  wire traffic: ${hub.traffic.map((m) => m.msg.t).join(', ')}`);
  check('client never mutates its own queue', client.queue.size === 0, `${client.queue.size}`);
  check('host admitted the client request', host.queue.size === 1, `${host.queue.size}`);
  check('client snapshot is flagged as a mirror', client.snapshot().mirrored === true, '');

  /* ---------------------------------------------------- 5. population -- */
  console.log(`\n=== POPULATION SIMULATION (${POPULATION} players, ${ATTEMPTS} attempts) ===`);
  const t0 = Date.now();
  const s = mm.runSimulation({ seed: SEED, population: POPULATION, attempts: ATTEMPTS });
  const ms = Date.now() - t0;

  console.log(`  simulated ${s.seconds} s of wall clock in ${ms} ms`);
  console.log(`  latent skill percentiles: ${JSON.stringify(s.skillPercentiles)}`);
  console.log(`  tickets admitted ${s.ticketsAdmitted}, matches formed ${s.matches}, players placed ${s.playersMatched}, stranded ${s.ticketsStranded}`);
  console.log('\n  queue time (s)');
  table([s.queueSeconds], [
    { label: 'mean', get: (d) => n2(d.mean) },
    { label: 'median', get: (d) => n2(d.p50) },
    { label: 'p90', get: (d) => n2(d.p90) },
    { label: 'p95', get: (d) => n2(d.p95) },
    { label: 'p99', get: (d) => n2(d.p99) },
    { label: 'max', get: (d) => n2(d.max) },
  ]);
  console.log('\n  match quality');
  table(
    [
      { k: 'skill spread within match (SR)', d: s.skillSpread },
      { k: 'team rating delta (SR)', d: s.teamDelta },
      { k: 'member ping to host (ms)', d: s.hostPing },
    ],
    [
      { label: 'metric', get: (r) => r.k },
      { label: 'mean', get: (r) => n2(r.d.mean) },
      { label: 'p50', get: (r) => n2(r.d.p50) },
      { label: 'p95', get: (r) => n2(r.d.p95) },
      { label: 'max', get: (r) => n2(r.d.max) },
    ],
  );
  console.log(`\n  bot fill rate: ${pct(s.botFillRate)}  (${s.botSlots} bot slots of ${s.totalSlots})`);
  console.log(`  matches with any bots: ${s.matchesWithBots} / ${s.matches}; fully human: ${s.matchesFullyHuman}`);
  console.log(`  leavers ${s.leavers}, backfill placements ${s.backfillPlacements}, bot top-ups ${s.botTopUps}, bot yields ${s.botYields}`);
  console.log(`  backfill refusals: ${JSON.stringify(s.refusals)}`);
  console.log(`  rating vs latent skill correlation: ${n2(s.ratingCorrelation, 3)} over ${s.ratedPlayers} rated players (mean RD ${n2(s.meanRd)})`);
  console.log(`  events emitted: ${JSON.stringify(s.events)}`);

  check('median queue time under 30 s', s.queueSeconds.p50 < 30, `${n2(s.queueSeconds.p50)} s`);
  check('p95 queue time under 60 s', s.queueSeconds.p95 < 60, `${n2(s.queueSeconds.p95)} s`);
  check('no ticket waits past the 120 s hard timeout + a tick', s.queueSeconds.max <= 121, `${n2(s.queueSeconds.max)} s`);
  check('mean skill spread within a match under 400 SR', s.skillSpread.mean < 400, `${n2(s.skillSpread.mean)} SR`);
  check('mean team delta under 120 SR', s.teamDelta.mean < 120, `${n2(s.teamDelta.mean)} SR`);
  check('mean ping to host under 90 ms', s.hostPing.mean < 90, `${n2(s.hostPing.mean)} ms`);
  check('bot fill rate under 30% in a healthy population', s.botFillRate < 0.3, pct(s.botFillRate));
  check('every admitted ticket was placed', s.ticketsStranded === 0, `${s.ticketsStranded} stranded`);
  check('backfill actually ran', s.backfillPlacements > 0, `${s.backfillPlacements} placements`);
  check('rating tracks latent skill (r > 0.7)', s.ratingCorrelation > 0.7, n2(s.ratingCorrelation, 3));

  /* -------------------------------------------------- 6. determinism -- */
  const s2 = mm.runSimulation({ seed: SEED, population: POPULATION, attempts: ATTEMPTS });
  check('simulation is deterministic for a seed', s.hash === s2.hash, `${s.hash} vs ${s2.hash}`);

  /* -------------------------------------------------------- results -- */
  console.log('\n=== RESULTS ===');
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
  }
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed}/${checks.length} checks`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
