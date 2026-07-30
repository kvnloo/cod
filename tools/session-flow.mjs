#!/usr/bin/env node
/**
 * Session flow verifier.
 *
 * Drives the entire player journey — boot → main menu → lobby → matchmaking →
 * map load → pre-match → live → post-match → after-action → back to the lobby —
 * head­lessly in node, then does it again while injecting a failure at every
 * stage. Also proves that the illegal transitions really are illegal (at
 * runtime *and* at compile time) and that the existing single-player match
 * layer still passes its own self-test.
 *
 * TypeScript is loaded through vite's SSR pipeline, so this exercises the real
 * `src/session/*.ts` sources with no build step and no browser.
 *
 *   node tools/session-flow.mjs            # everything
 *   node tools/session-flow.mjs --quick    # skip the tsc negative test
 */
import { createServer } from 'vite';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');

const checks = [];
const ok = (name, detail = '') => checks.push({ name, ok: true, detail });
const bad = (name, detail = '') => checks.push({ name, ok: false, detail });
const expect = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail));
/**
 * A check against a module this agent does not own. It is reported and it
 * matters, but it does not gate this tool's exit code — otherwise another
 * agent's mid-edit tree would mask every session result.
 */
const probe = (name, cond, detail, owner) =>
  checks.push({ name, ok: !!cond, detail, owner });

const DT = 1 / 30;

/* ----------------------------------------------------------------- fakes -- */

/** Stands in for `GameDirector`. Counts starts so a double-start is visible. */
class FakeMatch {
  constructor() { this.phase = 'idle'; this.mode = 'operation'; this.starts = 0; this.seeds = []; }
  startMatch(mode, seed) { this.starts++; this.mode = mode; this.seeds.push(seed); this.phase = 'live'; }
  endMatch(_win) { this.phase = 'ended'; }
}

class ThrowingMatch extends FakeMatch {
  startMatch() { this.starts++; throw new Error('level stream aborted'); }
}

class FakeNet {
  constructor(role = 'host') {
    this.role = role;
    this.connection = role === 'offline' ? 'offline' : 'live';
    this.localId = 'p0';
    this.requested = [];
    this.published = [];
  }
  requestFlow(event, reason) { this.requested.push({ event, reason }); }
  publishFlow(state, seq) { this.published.push({ state, seq }); }
}

/** A matchmaker that never finds anything — drives the search-timeout path. */
class StuckMatchmaking {
  constructor() { this.t = 0; this.on = false; }
  search() { this.on = true; this.t = 0; }
  cancel() { this.on = false; }
  status() {
    return {
      state: this.on ? 'searching' : 'idle', elapsed: this.t,
      players: 1, target: 6, region: 'eu-west', error: null,
    };
  }
  result() { return null; }
  tick(dt) { if (this.on) this.t += dt; }
}

/** A loader that reports a hard error, or one that simply never finishes. */
class BrokenMapLoad {
  constructor(mode) { this.mode = mode; this.t = 0; this.on = false; }
  begin() { this.on = true; this.t = 0; }
  cancel() { this.on = false; }
  status() {
    if (!this.on) return { progress: 0, done: false, error: null };
    if (this.mode === 'error') return { progress: 0.4, done: false, error: 'geometry stream corrupt' };
    return { progress: 0.4, done: false, error: null };  // hangs forever
  }
  tick(dt) { if (this.on) this.t += dt; }
}

const SUMMARY = {
  mode: 'operation', modeName: 'Operation', win: true, durationSec: 214, score: 3150,
  kills: 27, deaths: 6, headshots: 8, assists: 4, bestStreak: 9, wavesCleared: 5,
  objectivesComplete: 3, accuracy: 0.36, xpEarned: 4820, rankBefore: 4, rankAfter: 6,
  rankName: 'Corporal', xpIntoRank: 260, xpForNext: 1180, unlocked: [], rows: [],
  seed: 20260730, replayHash: 'a1b2c3d4',
};

/* ------------------------------------------------------------------ rig -- */

function makeRig(mods, { SessionSystem, EventBus }) {
  const bus = new EventBus();
  const match = mods.match ?? new FakeMatch();
  const net = mods.net ?? null;
  const states = [];
  const faults = [];
  const reports = [];
  const notices = [];
  bus.on('session:state', (e) => states.push(e.state));
  bus.on('session:fault', (f) => faults.push(f));
  bus.on('session:report', (r) => reports.push(r));
  bus.on('session:notice', (n) => notices.push(n));

  const session = new SessionSystem({
    bus,
    seed: 20260730,
    playerName: 'VIPER',
    ports: {
      match,
      net,
      matchmaking: mods.matchmaking ?? null,
      mapLoad: mods.mapLoad ?? null,
      lobby: mods.lobby ?? null,
      loadout: mods.loadout ?? null,
      progression: mods.progression ?? null,
    },
    config: {
      searchPatience: 0.4, searchTimeout: 2, loadTimeout: 2,
      preMatch: 0.4, postMatch: 0.4, afterAction: 0.6, migrate: 1,
      publishPeriod: 0.25, botFill: mods.botFill !== false,
      ...(mods.config ?? {}),
    },
  });
  session.boot();
  return { session, bus, match, net, states, faults, reports, notices };
}

/** Steps until `stop()` or the budget runs out. Returns seconds simulated. */
function run(rig, seconds, stop = () => false) {
  let t = 0;
  while (t < seconds && !stop()) { rig.session.step(DT); t += DT; }
  return t;
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const server = await createServer({
    configFile: false, root: ROOT, logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
  });

  let flowMod, sessionMod, busMod, selfTestMod;
  try {
    flowMod = await server.ssrLoadModule('/src/session/Flow.ts');
    sessionMod = await server.ssrLoadModule('/src/session/SessionSystem.ts');
    busMod = await server.ssrLoadModule('/src/core/EventBus.ts');
    selfTestMod = await server.ssrLoadModule('/src/game/SelfTest.ts').catch((e) => ({ error: e }));
  } catch (err) {
    console.error(err);
    bad('modules load', String(err?.message ?? err));
    await server.close();
    return report();
  }

  const { Flow, FLOW, FLOW_STATES, validateFlow, route } = flowMod;
  const { SessionSystem, normaliseMode } = sessionMod;
  const { EventBus } = busMod;
  const mk = (mods = {}) => makeRig(mods, { SessionSystem, EventBus });

  /* ================================================ 1. the table itself == */

  const v = validateFlow();
  expect('flow table is structurally sound', v.ok, v.problems.join('; ') || `${FLOW_STATES.length} states`);

  const journey = route('boot', 'live');
  expect('boot reaches live', Array.isArray(journey) && journey.length > 0,
    journey ? journey.join(' → ') : 'unreachable');
  expect('after-action returns to the lobby', route('afterAction', 'lobby')?.length === 1,
    String(route('afterAction', 'lobby')));

  const f = new Flow('boot');
  expect('illegal transition is rejected', f.send('finished') === null, 'boot --finished--> ✗');
  expect('legal transition is taken', f.send('ready')?.to === 'mainMenu', `now ${f.state}`);
  expect('typed handle is null off-state', f.at('live') === null, `state=${f.state}`);
  expect('typed handle works on-state', f.at('mainMenu')?.target('play') === 'lobby');
  let threw = false;
  try { f.must('finished'); } catch { threw = true; }
  expect('must() throws on an illegal event', threw);

  const seqBefore = f.seq;
  f.adopt('live', 999, 'host');
  expect('authority snap reaches a non-adjacent state', f.state === 'live', `seq ${seqBefore}→${f.seq}`);
  expect('stale authority update is ignored', f.adopt('lobby', 5) === null, `seq=${f.seq}`);

  expect('unknown mode ids are normalised', normaliseMode('domination') === 'tdm'
    && normaliseMode('tdm') === 'tdm' && normaliseMode(undefined) === 'operation',
    `domination→${normaliseMode('domination')}`);

  /* ============================================ 2. the happy path journey == */

  {
    const rig = mk();
    expect('boot lands in the main menu', rig.session.flow.state === 'mainMenu',
      rig.states.join(' → '));
    expect('offline session is host', rig.session.isHost && !rig.session.online);
    expect('degrades without services',
      rig.session.lastSnapshot.degraded.includes('lobby')
      && rig.session.lastSnapshot.degraded.includes('matchmaking')
      && rig.session.lastSnapshot.degraded.includes('net'),
      rig.session.lastSnapshot.degraded.join(','));

    const partyBefore = rig.session.lastSnapshot.members.map((m) => m.id).join(',');

    rig.session.deploy(undefined, 'test');
    expect('deploy routes menu → lobby → search', rig.session.flow.state === 'matchmaking',
      rig.states.join(' → '));

    const tLive = run(rig, 10, () => rig.session.flow.state === 'live');
    expect('reaches live', rig.session.flow.state === 'live', `${tLive.toFixed(2)}s`);
    expect('the match was started exactly once', rig.match.starts === 1, `starts=${rig.match.starts}`);
    expect('the match got the session seed', rig.match.seeds[0] > 0, `seed=${rig.match.seeds[0]}`);
    expect('walked every stage in order',
      ['matchmaking', 'loading', 'preMatch', 'live'].every((s) => rig.states.includes(s)),
      rig.states.join(' → '));

    rig.bus.emit('match:summary', SUMMARY);
    rig.bus.emit('game:over', { win: true, score: SUMMARY.score });
    expect('match end moves to post-match', rig.session.flow.state === 'postMatch');

    const tBack = run(rig, 10, () => rig.session.flow.state === 'lobby');
    expect('returns to the lobby', rig.session.flow.state === 'lobby', `${tBack.toFixed(2)}s`);
    expect('after-action report was published', rig.reports.length === 1,
      `reports=${rig.reports.length}`);
    const rep = rig.reports[0];
    expect('report banks the match XP', rep && rep.xpEarned === SUMMARY.xpEarned && !rep.abandoned,
      rep ? `xp=${rep.xpEarned} abandoned=${rep.abandoned}` : 'no report');
    expect('report carries the replay handle', rep && rep.replayHash === SUMMARY.replayHash,
      rep?.replayHash);

    const partyAfter = rig.session.lastSnapshot.members.map((m) => m.id).join(',');
    expect('the party survives the round trip', partyBefore === partyAfter,
      `${partyBefore} → ${partyAfter}`);

    // Second lap: the lobby must be reusable.
    rig.session.request('search', 'test');   // legal directly from the lobby
    run(rig, 10, () => rig.session.flow.state === 'live');
    expect('a second match can be started', rig.session.flow.state === 'live' && rig.match.starts === 2,
      `starts=${rig.match.starts}`);
  }

  /* ============================ 3. single-player adoption (no regression) == */

  {
    const running = new FakeMatch();
    running.phase = 'live';           // GameDirector already booted a match
    running.mode = 'operation';
    const rig = mk({ match: running });
    expect('an already-running match is adopted', rig.session.flow.state === 'live',
      rig.states.join(' → '));
    expect('adoption never restarts the match', running.starts === 0, `starts=${running.starts}`);
    run(rig, 1);
    expect('adoption stays live', rig.session.flow.state === 'live' && running.starts === 0);

    running.phase = 'ended';
    run(rig, 5, () => rig.session.flow.state === 'lobby');
    expect('an adopted match still produces a report', rig.reports.length === 1,
      `reports=${rig.reports.length} state=${rig.session.flow.state}`);
  }

  {
    // Capture mode: the session must be inert so it cannot pollute shots.
    const bus2 = new EventBus();
    const m = new FakeMatch();
    const s = new SessionSystem({
      bus: bus2, passive: true, ports: { match: m },
      config: { searchPatience: 0.4, preMatch: 0.4, postMatch: 0.4, afterAction: 0.6 },
    });
    s.boot();
    s.deploy();
    for (let i = 0; i < 300; i++) s.step(DT);
    expect('passive (capture) mode never starts a match', m.starts === 0 && s.flow.state === 'live',
      `starts=${m.starts} state=${s.flow.state}`);
  }

  /* ================================================ 4. failure injection == */

  const fails = [];

  // 4a. matchmaking cannot fill and bot-fill is disabled.
  {
    const rig = mk({ botFill: false });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'lobby');
    fails.push(['match cannot fill → lobby',
      rig.session.flow.state === 'lobby' && rig.faults.some((x) => x.kind === 'unfillable'),
      `state=${rig.session.flow.state} faults=${rig.faults.map((x) => x.kind).join(',')}`]);
  }

  // 4b. matchmaking hangs past the timeout.
  {
    const rig = mk({ matchmaking: new StuckMatchmaking() });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'lobby');
    fails.push(['search times out → lobby',
      rig.session.flow.state === 'lobby' && rig.faults.some((x) => x.kind === 'search-timeout'),
      `state=${rig.session.flow.state} faults=${rig.faults.map((x) => x.kind).join(',')}`]);
  }

  // 4c. the map fails to load.
  {
    const rig = mk({ mapLoad: new BrokenMapLoad('error') });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'lobby' && rig.faults.length > 0);
    fails.push(['load fails → lobby',
      rig.session.flow.state === 'lobby' && rig.faults.some((x) => x.kind === 'load-failed'),
      `state=${rig.session.flow.state} faults=${rig.faults.map((x) => x.kind).join(',')}`]);
    fails.push(['a failed load never starts a match', rig.match.starts === 0, `starts=${rig.match.starts}`]);
  }

  // 4d. the map load hangs.
  {
    const rig = mk({ mapLoad: new BrokenMapLoad('hang') });
    rig.session.deploy(undefined, 'test');
    run(rig, 8, () => rig.session.flow.state === 'lobby' && rig.faults.length > 0);
    fails.push(['load times out → lobby',
      rig.session.flow.state === 'lobby' && rig.faults.some((x) => x.kind === 'load-timeout'),
      `state=${rig.session.flow.state} faults=${rig.faults.map((x) => x.kind).join(',')}`]);
  }

  // 4e. starting the match throws.
  {
    const rig = mk({ match: new ThrowingMatch() });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'lobby' && rig.faults.length > 0);
    fails.push(['a throwing director is contained',
      rig.faults.some((x) => x.kind === 'match-failed') && rig.session.flow.state !== 'live',
      `state=${rig.session.flow.state} faults=${rig.faults.map((x) => x.kind).join(',')}`]);
  }

  // 4f. the host drops mid-match and migration succeeds.
  {
    const rig = mk({ net: new FakeNet('host') });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'live');
    const startsBefore = rig.match.starts;
    rig.session.notifyHostLost('peer 3 timed out');
    fails.push(['host loss suspends the session', rig.session.flow.state === 'migrating',
      `state=${rig.session.flow.state}`]);
    rig.session.notifyMigrated();
    fails.push(['migration resumes the live match',
      rig.session.flow.state === 'live' && rig.match.starts === startsBefore,
      `state=${rig.session.flow.state} starts=${rig.match.starts}`]);
  }

  // 4g. migration never completes.
  {
    const rig = mk({ net: new FakeNet('host') });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'live');
    rig.session.notifyHostLost();
    run(rig, 4, () => rig.session.flow.state === 'lobby');
    fails.push(['failed migration falls back to the lobby', rig.session.flow.state === 'lobby',
      `state=${rig.session.flow.state}`]);
  }

  // 4h. the local player is disconnected mid-match.
  {
    const rig = mk({ net: new FakeNet('host') });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'live');
    rig.session.notifyDropped('socket closed');
    fails.push(['a disconnect still shows the after-action report',
      rig.session.flow.state === 'afterAction', `state=${rig.session.flow.state}`]);
    const rep = rig.reports[0];
    fails.push(['an abandoned match banks nothing',
      !!rep && rep.abandoned === true && rep.xpEarned === 0,
      rep ? `abandoned=${rep.abandoned} xp=${rep.xpEarned}` : 'no report']);
    run(rig, 4, () => rig.session.flow.state === 'lobby');
    fails.push(['a dropped player lands back in the lobby', rig.session.flow.state === 'lobby',
      `state=${rig.session.flow.state}`]);
  }

  // 4i. a fatal fault, and recovery from it.
  {
    const rig = mk();
    rig.session.request('fail', 'test');
    fails.push(['a fatal fault reaches the error state', rig.session.flow.state === 'fault',
      `state=${rig.session.flow.state}`]);
    rig.session.request('recover', 'test');
    fails.push(['recovery returns to the main menu', rig.session.flow.state === 'mainMenu',
      `state=${rig.session.flow.state}`]);
  }

  // 4j. client authority: a client cannot move itself.
  {
    const net = new FakeNet('client');
    const rig = mk({ net });
    fails.push(['a client does not self-advance past the menu',
      rig.session.flow.state === 'mainMenu', `state=${rig.session.flow.state}`]);
    rig.session.request('search', 'ui');
    fails.push(['a client forwards intent instead of applying it',
      rig.session.flow.state === 'mainMenu' && net.requested.some((r) => r.event === 'search'),
      `state=${rig.session.flow.state} sent=${net.requested.map((r) => r.event).join(',')}`]);
    rig.session.adopt('lobby', 50, 'host');
    fails.push(['a client follows the host', rig.session.flow.state === 'lobby',
      `state=${rig.session.flow.state}`]);
  }

  // 4k. the host publishes every transition it takes.
  {
    const net = new FakeNet('host');
    const rig = mk({ net });
    rig.session.deploy(undefined, 'test');
    run(rig, 6, () => rig.session.flow.state === 'live');
    const seqs = net.published.map((p) => p.seq);
    const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
    fails.push(['the host publishes an ordered flow stream',
      net.published.length >= 4 && monotonic,
      `${net.published.length} updates, seq ${seqs[0]}..${seqs[seqs.length - 1]}`]);
  }

  // 4l. the UI's existing Deploy button drives the session.
  {
    const rig = mk();
    rig.bus.emit('game:start', { mode: 'domination' });
    fails.push(['ui game:start deploys (and normalises the mode)',
      rig.session.flow.state === 'matchmaking' && rig.session.lastSnapshot.mode === 'tdm',
      `state=${rig.session.flow.state} mode=${rig.session.lastSnapshot.mode}`]);
    run(rig, 6, () => rig.session.flow.state === 'live');
    fails.push(['the match layer echoing game:start does not re-deploy',
      rig.match.starts === 1, `starts=${rig.match.starts}`]);
  }

  // 4m. the lobby module's launch order is honoured when it lands.
  {
    const rig = mk();
    rig.bus.emit('lobby:launch', {
      lobbyId: 'lby_1', modeId: 'tdm', mapId: 'harbour', levelId: 'harbour', seed: 4242,
      matchIndex: 0, roster: [], teamCount: 2,
    });
    run(rig, 6, () => rig.session.flow.state === 'live');
    fails.push(['lobby:launch drives the flow to live',
      rig.session.flow.state === 'live' && rig.match.mode === 'tdm' && rig.match.seeds[0] === 4242,
      `state=${rig.session.flow.state} mode=${rig.match.mode} seed=${rig.match.seeds[0]}`]);
    rig.bus.emit('lobby:launch', { garbage: true });
    fails.push(['a malformed launch order is ignored', rig.match.starts === 1,
      `starts=${rig.match.starts}`]);
  }

  for (const [name, cond, detail] of fails) expect(name, cond, detail);

  /* ======================================== 5. single-player non-regression == */

  if (selfTestMod && !selfTestMod.error && typeof selfTestMod.runSelfTest === 'function') {
    try {
      const r = selfTestMod.runSelfTest();
      const failed = r.cases.filter((c) => !c.pass).map((c) => c.name);
      probe('game-layer self-test still passes', r.pass,
        r.pass ? `${r.cases.length} cases in ${r.ms.toFixed(0)}ms` : `failing: ${failed.join(', ')}`,
        'src/game');
    } catch (err) {
      probe('game-layer self-test still passes', false,
        `threw: ${String(err?.message ?? err).slice(0, 160)}`, 'src/game');
    }
  } else {
    probe('game-layer self-test still passes', false,
      `could not load src/game/SelfTest.ts: ${String(selfTestMod?.error?.message ?? 'unknown')}`,
      'src/game');
  }

  await server.close();

  /* =========================== 6. illegal transitions do not type-check == */

  if (!QUICK) await negativeTypeTest();

  return report();
}

/**
 * Proves the "illegal transitions are impossible to express" claim: a file that
 * asks for a live-only event from the lobby must fail `tsc`, and the same file
 * with a legal event must pass.
 */
async function negativeTypeTest() {
  const dir = path.join(ROOT, '.session-typetest');
  await mkdir(dir, { recursive: true });
  const flags = ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--ignoreConfig'];

  const write = (file, body) => writeFile(path.join(dir, file), body, 'utf8');
  await write('legal.ts', [
    "import { Flow } from '../src/session/Flow';",
    'const f = new Flow();',
    "f.at('lobby')?.send('search');",
    "f.at('live')?.send('finished');",
    '',
  ].join('\n'));
  await write('illegal.ts', [
    "import { Flow } from '../src/session/Flow';",
    'const f = new Flow();',
    "f.at('lobby')?.send('finished');",
    '',
  ].join('\n'));

  const runTsc = (file) => spawnSync('npx', ['tsc', ...flags, path.join(dir, file)],
    { cwd: ROOT, encoding: 'utf8' });

  const legal = runTsc('legal.ts');
  const illegal = runTsc('illegal.ts');
  const legalOut = `${legal.stdout ?? ''}${legal.stderr ?? ''}`.trim();
  const illegalOut = `${illegal.stdout ?? ''}${illegal.stderr ?? ''}`.trim();
  expect('legal transitions type-check', legal.status === 0 && legalOut === '',
    legal.status === 0 ? 'tsc clean' : legalOut.split('\n')[0].slice(0, 140));
  // Must fail for the *right* reason: the event argument, not a config error.
  const rejectedTheEvent = /error TS2345/.test(illegalOut) && /finished/.test(illegalOut);
  expect('illegal transitions do NOT type-check', illegal.status !== 0 && rejectedTheEvent,
    rejectedTheEvent
      ? illegalOut.split('\n')[0].replace(/^.*error /, 'error ').slice(0, 120)
      : `tsc did not reject lobby --finished-->: ${illegalOut.split('\n')[0].slice(0, 100)}`);

  await rm(dir, { recursive: true, force: true });
}

function report() {
  const owned = checks.filter((c) => !c.owner);
  const foreign = checks.filter((c) => c.owner);
  console.log('');
  for (const c of owned) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  if (foreign.length) {
    console.log('');
    console.log('  upstream probes (not owned by this module):');
    for (const c of foreign) {
      console.log(`  ${c.ok ? 'PASS' : 'WARN'}  [${c.owner}] ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
    }
  }
  const passed = owned.filter((c) => c.ok).length;
  const allOk = passed === owned.length;
  const warns = foreign.filter((c) => !c.ok).length;
  console.log('');
  console.log(`[session-flow] ${allOk ? 'PASS' : 'FAIL'}  ${passed}/${owned.length} session checks`
    + (foreign.length ? `, ${foreign.length - warns}/${foreign.length} upstream probes` : ''));
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error(err); process.exit(1); });
