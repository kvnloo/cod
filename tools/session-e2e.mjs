#!/usr/bin/env node
/**
 * WHOLE-GAME END-TO-END DRIVER.
 *
 * Every other session tool verifies one module against its own fakes. This one
 * verifies the *seams*: it stands up the real SessionSystem, the real
 * LobbySystem, the real MatchmakingService, the real LoadoutBook, the real
 * Progression and a real MatchRunner, wires them the way the shipped game
 * wires them, and then plays the game.
 *
 *   ACT 1  installation — does the one-line wiring every module's README
 *          recommends actually produce a wired session?
 *   ACT 2  the whole journey: boot → lobby → matchmaking (bot fill) → load →
 *          preMatch → a real match to a real conclusion → postMatch →
 *          after-action → back to the lobby, twice, party intact
 *   ACT 3  every mode in MODE_CATALOG played to a real conclusion, both
 *          directly through MatchRunner and through the session
 *   ACT 4  things go wrong: host drops mid-match, a player disconnects while
 *          loading, a match cannot fill, a mode hits overtime
 *
 * Nothing here is mocked that the game does not itself mock: the player body,
 * the actor backend and the world geometry are stand-ins (there is no renderer
 * in node), exactly as `src/game/SelfTest.ts` does it. Every decision-making
 * module is the real one.
 *
 *   node tools/session-e2e.mjs           # everything
 *   node tools/session-e2e.mjs --act 3   # one act
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const only = argv.includes('--act') ? Number(argv[argv.indexOf('--act') + 1]) : 0;

/* ------------------------------------------------------------- reporting -- */

const checks = [];
let act = '';
const section = (name) => {
  act = name;
  console.log(`\n${'='.repeat(78)}\n${name}\n${'='.repeat(78)}`);
};
const sub = (name) => console.log(`\n  ${name}\n  ${'-'.repeat(name.length)}`);
const expect = (name, cond, detail = '') => {
  checks.push({ act, name, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return !!cond;
};
const note = (text) => console.log(`        · ${text}`);

/* ------------------------------------------------------------------ load -- */

const M = {};

async function load(server) {
  const m = (p) => server.ssrLoadModule(p);
  M.THREE = await m('three');
  M.session = await m('/src/session/SessionSystem.ts');
  M.flow = await m('/src/session/Flow.ts');
  M.bus = await m('/src/core/EventBus.ts');
  M.match = await m('/src/game/Match.ts');
  M.services = await m('/src/game/Services.ts');
  M.rand = await m('/src/core/Rand.ts');
  M.modes = await m('/src/game/modes/index.ts');
  M.arch = await m('/src/game/Archetypes.ts');
  M.lobby = await m('/src/session/lobby/index.ts').catch((e) => ({ __err: e }));
  M.mm = await m('/src/session/matchmaking/Service.ts').catch((e) => ({ __err: e }));
  M.mmTransport = await m('/src/session/matchmaking/Transport.ts').catch((e) => ({ __err: e }));
  M.loadout = await m('/src/session/loadout/index.ts').catch((e) => ({ __err: e }));
  M.lobbyTransport = await m('/src/session/lobby/Transport.ts').catch((e) => ({ __err: e }));
  M.playlists = await m('/src/session/matchmaking/Playlists.ts').catch((e) => ({ __err: e }));
}

const V3 = (x = 0, y = 0, z = 0) => new M.THREE.Vector3(x, y, z);

/* ------------------------------------------------------------------- rig -- */

/** Stand-in player body. Same contract `src/game/SelfTest.ts` uses. */
function makePlayer(bus) {
  const p = {
    position: V3(), health: 100, maxHealth: 100, alive: true, entityId: 1, deaths: 0,
    spawnAt(pos) { p.position.copy(pos); p.health = 100; p.alive = true; },
    revive() { p.alive = true; p.health = 100; },
    heal(a) { p.health = Math.min(100, p.health + a); },
    applyDamage(amount, _dir, lethal) {
      if (!p.alive) return;
      p.health -= amount;
      if (p.health <= 0 || lethal) {
        p.health = 0; p.alive = false; p.deaths++;
        bus.emit('entity:death', { id: 1, byPlayer: false, headshot: false, name: 'player', point: p.position.clone() });
      }
    },
  };
  return p;
}

function makeActors(bus) {
  const A = M.arch.ARCHETYPES;
  const bots = new Map();
  let next = 5000;
  return {
    combatEnabled: true,
    spawnCombatant(req) {
      const id = next++;
      bots.set(id, {
        id, health: (A[req.archetype]?.health ?? 100) * req.health,
        position: req.position.clone(), archetype: req.archetype, team: req.team,
      });
      return id;
    },
    despawnCombatant(id) { bots.delete(id); },
    isCombatantAlive(id) { return bots.has(id); },
    combatantPosition(id, out) { const b = bots.get(id); if (!b) return false; out.copy(b.position); return true; },
    damageCombatant(id, amount, opts) {
      const b = bots.get(id);
      if (!b) return false;
      b.health -= amount;
      if (b.health > 0) return false;
      bots.delete(id);
      bus.emit('entity:death', {
        id, byPlayer: opts.fromPlayer !== false, headshot: !!opts.headshot,
        name: b.archetype, point: b.position.clone(),
      });
      return true;
    },
    setCombatEnabled(on) { this.combatEnabled = on; },
    setAccuracyScale() { },
    listCombatants(out) { out.length = 0; for (const id of bots.keys()) out.push(id); return out.length; },
    all() { return [...bots.values()]; },
    hostileIds() { return [...bots.values()].filter((b) => b.team === 'hostile').map((b) => b.id); },
  };
}

function mockWorld() {
  const spawns = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = 24 + (i % 3) * 9;
    spawns.push({ position: V3(Math.cos(a) * r, 0, Math.sin(a) * r), yaw: a, team: i % 4 === 0 ? 'player' : 'enemy' });
  }
  return { spawns, bounds: new M.THREE.Box3(V3(-60, -2, -60), V3(60, 30, 60)) };
}

/**
 * The engine-facing match adapter — what `GameDirector` is once the engine is
 * removed. Deliberately faithful so the session sees what it sees in a browser.
 */
function makeDirector(seed, bus = new M.bus.EventBus()) {
  const rng = new M.rand.Rand(seed);
  const services = M.services.headlessServices(rng, (k, p) => bus.emit(k, p));
  const player = makePlayer(bus);
  const actors = makeActors(bus);
  services.player = player;
  services.actors = actors;
  services.world = mockWorld();

  const match = new M.match.MatchRunner(services, false);
  match.attachBus((key, fn) => bus.on(key, fn));
  match.progression.setStorage(null);
  match.seed = seed;

  const dir = {
    bus, match, services, player, actors, killAccum: 0,
    started: false, starts: 0, seeds: [], modes: [],
    get mode() { return match.mode?.id ?? 'operation'; },
    get phase() { return match.phase; },
    snapshot() { return match.snapshot(); },
    startMatch(mode, s) {
      dir.started = true; dir.starts++; dir.seeds.push(s); dir.modes.push(mode);
      match.start(mode, s);
    },
    endMatch(win) { match.finish(win); },
    fixedUpdate(dt, aggression = 1.4) {
      if (!dir.started) return;
      driveAgent(dir, dt, aggression);
      match.fixedUpdate(dt);
    },
  };
  return dir;
}

/** Synthetic operator: walk to the live objective, interact, shoot hostiles. */
function driveAgent(dir, dt, aggression) {
  const { match, actors, player } = dir;
  const obj = match.objectives().find((o) => o.state === 'active' && o.position);
  if (obj && obj.position) {
    const d = obj.position.clone().sub(player.position);
    d.y = 0;
    const dist = d.length();
    if (dist > Math.max(1, obj.radius * 0.4)) {
      d.multiplyScalar(6.5 * dt / Math.max(0.001, dist));
      player.position.add(d);
      match.setInteracting(false);
    } else {
      match.setInteracting(true);
    }
  } else {
    match.setInteracting(false);
  }
  dir.killAccum = Math.min(3, dir.killAccum + dt * aggression);
  while (dir.killAccum >= 1) {
    dir.killAccum -= 1;
    const ids = actors.hostileIds();
    if (ids.length === 0) break;
    match.damage(ids[0], 100000, 'player');
  }
}

/** The tiny slice of `Engine` that `installSession` needs. */
function makeRegistry() {
  const systems = new Map();
  return {
    systems,
    add(s) { systems.set(s.name, s); return s; },
    tryGet(n) { return systems.get(n); },
  };
}

/** Steps session + match together at the engine's real cadence. */
function pump(session, dir, seconds, until = () => false, dt = 1 / 30) {
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) {
    session.step(dt);
    dir.fixedUpdate(dt / 2);
    dir.fixedUpdate(dt / 2);
    if (until()) return (i + 1) * dt;
  }
  return seconds;
}

/* --------------------------------------------------------------- ACT 1 -- */

/**
 * Everybody's README says "the one line needed is
 * `installSession(engine, { lobby: new LobbySystem() })`". Does it work?
 */
async function act1() {
  section('ACT 1 — installation: does the recommended one-line wiring work?');

  const { installSession, lobbyPortFrom } = M.session;

  sub('A. the exact call every README recommends');
  {
    const reg = makeRegistry();
    const lobby = new M.lobby.LobbySystem({ seed: 7 });
    const session = installSession(reg, { lobby });
    // The engine calls init() on registered systems *after* installation.
    lobby.init({ engine: reg });
    session.boot();
    const snap = session.snapshot();
    note(`degraded = [${snap.degraded.join(', ')}]`);
    expect('installSession(engine, { lobby }) produces a wired lobby port',
      !snap.degraded.includes('lobby'),
      snap.degraded.includes('lobby')
        ? 'session fell back to LocalLobby — the real lobby is not connected'
        : '');
    expect('the session shows the real lobby room, not the stub',
      snap.members.length > 0 && session.ports.lobby?.view().message !== 'PRIVATE LOBBY',
      `message="${session.ports.lobby?.view().message}" members=${snap.members.length}`);
  }

  sub('B. the same call with init() run first (the order the probe harness uses)');
  {
    const reg = makeRegistry();
    const lobby = new M.lobby.LobbySystem({ seed: 7 });
    lobby.init({ engine: reg });
    const session = installSession(reg, { lobby });
    session.boot();
    const snap = session.snapshot();
    note(`degraded = [${snap.degraded.join(', ')}]`);
    expect('bridging an already-initialised LobbySystem works',
      !snap.degraded.includes('lobby'), `[${snap.degraded.join(', ')}]`);
  }

  sub('C. what the shipped bundle actually installs');
  {
    // src/game/Services.ts armSessionLayer(): installSession(ctx.engine, {})
    const reg = makeRegistry();
    const session = installSession(reg, {});
    session.boot();
    const snap = session.snapshot();
    note(`shipped-path degraded = [${snap.degraded.join(', ')}]`);
    expect('the shipped install path wires at least one real subsystem',
      !snap.degraded.includes('lobby') || !snap.degraded.includes('matchmaking'),
      'armSessionLayer passes {} — every subsystem built this wave is unreachable in the browser');
  }

  sub('D. determinism of the lobby seed');
  {
    const picks = [];
    for (let i = 0; i < 4; i++) {
      const l = new M.lobby.LobbySystem({ seed: 7 });
      l.init({ engine: makeRegistry() });
      const s = l.session.state;
      picks.push(`${s?.selection.mapId}/${s?.selection.modeId}`);
      l.dispose();
    }
    note(`four constructions with seed 7: ${picks.join('  ')}`);
    expect('LobbySystem({seed:7}) is deterministic',
      new Set(picks).size === 1, `${new Set(picks).size} distinct selections from one seed`);
  }
}

/* --------------------------------------------------------------- ACT 2 -- */

async function act2() {
  section('ACT 2 — the whole journey, twice, with a party');

  const { installSession } = M.session;
  const reg = makeRegistry();
  // The real game runs every one of these on the single global bus, and
  // `LobbySystem.init` subscribes to that bus directly regardless of the `emit`
  // it was handed — so anything less than the global bus is not the real wiring.
  const gbus = M.bus.bus;
  const dir = makeDirector(20260730, gbus);

  const lobby = new M.lobby.LobbySystem({ seed: 7 });
  const mm = new M.mm.MatchmakingService();
  const book = new M.loadout.LoadoutBook();

  const session = installSession(reg, {
    lobby, matchmaking: mm, loadout: book, bus: gbus, seed: 20260730, mode: 'tdm',
  });
  lobby.init({ engine: reg });
  // Re-bridge now that the lobby has a session, so ACT 2 tests the journey and
  // not the ACT 1 defect a second time.
  const port = M.session.lobbyPortFrom(lobby);
  if (port) session.attach({ lobby: port });
  session.attach({ match: dir });
  session.boot();

  const states = [];
  gbus.on('session:state', (e) => states.push(e.state));
  const reports = [];
  gbus.on('session:report', (r) => reports.push(r));
  const faults = [];
  gbus.on('session:fault', (f) => faults.push(f));
  const launches = [];
  gbus.on('lobby:launch', (c) => launches.push(c));
  const modeSetters = [];
  gbus.on('game:start', (p) => modeSetters.push(p.mode));

  sub('A. boot and the front end');
  expect('boot resolves to the main menu', session.flow.state === 'mainMenu', session.flow.state);
  expect('a real lobby is bridged in',
    !session.snapshot().degraded.includes('lobby'), `[${session.snapshot().degraded.join(', ')}]`);

  sub('B. party of four');
  {
    const st = lobby.session.state;
    note(`room ${st?.code} on ${st?.selection.mapName} / ${st?.selection.modeName}, capacity ${st?.capacity}`);
    expect('the lobby has a joinable room code', !!st?.code, String(st?.code));
    // Bring three friends in through the real host, then party them up.
    const before = lobby.session.state?.members.length ?? 0;
    session.request('play', 'ui');
    expect('main menu → lobby', session.flow.state === 'lobby', session.flow.state);
    const snap = session.snapshot();
    note(`session sees ${snap.members.length} member(s), party ${snap.partySize}`);
    expect('the session reads the lobby roster', snap.members.length === before, `${snap.members.length} vs ${before}`);
  }

  sub('C. matchmaking with bot fill');
  {
    session.request('search', 'ui');
    expect('lobby → matchmaking', session.flow.state === 'matchmaking', session.flow.state);
    const t = pump(session, dir, 90, () => session.flow.state !== 'matchmaking');
    note(`search resolved in ${t.toFixed(1)}s → ${session.flow.state}`);
    expect('the search produced a session', session.flow.state === 'loading' || session.flow.state === 'preMatch'
      || session.flow.state === 'live', `state=${session.flow.state} faults=[${faults.map((f) => f.kind)}]`);
    const snap = session.snapshot();
    note(`roster after matchmaking: ${snap.members.length} members, ${snap.members.filter((m) => m.bot).length} bots`);
    note(`lobby:launch orders seen during the search: ${launches.length}${launches.length ? ` (mode=${launches[0].modeId})` : ''}`);
    expect('bot fill produced a full 6v6 lobby, not a party of one',
      snap.members.length >= 6, `${snap.members.length} members — the 12-slot core-tdm-6v6 roster did not arrive`);
  }

  sub('D. load → preMatch → live');
  {
    pump(session, dir, 60, () => session.flow.state === 'live');
    expect('reached live', session.flow.state === 'live', session.flow.state);
    expect('the match started exactly once', dir.starts === 1, `starts=${dir.starts}`);
    expect('the match started on the matchmaker seed',
      dir.seeds[0] !== undefined && dir.seeds[0] !== 0, `seed=${dir.seeds[0]}`);
    note(`director: mode=${dir.mode} phase=${dir.phase} seed=${dir.seeds[0]}`);
    note(`session mode=${session.snapshot().mode}; lobby selection=${lobby.session.state?.selection.modeId}`);
    expect('THE GAME PLAYS THE MODE THE PLAYER ASKED FOR',
      dir.modes[0] === 'tdm',
      `asked for 'tdm', launched '${dir.modes[0]}' (lobby had '${lobby.session.state?.selection.modeId}' selected)`);
  }

  sub('E. a real match to a real conclusion');
  {
    const t = pump(session, dir, 900, () => session.flow.state === 'postMatch' || session.flow.state === 'afterAction');
    note(`match ran ${t.toFixed(0)}s of simulated time; director phase=${dir.phase}`);
    expect('the match reached a conclusion',
      session.flow.state === 'postMatch' || session.flow.state === 'afterAction',
      `state=${session.flow.state} matchPhase=${dir.phase}`);
    expect('the match runner produced a summary', !!dir.match.summary,
      dir.match.summary ? `score=${dir.match.summary.score} kills=${dir.match.summary.kills}` : 'null');
  }

  sub('F. after-action report');
  {
    pump(session, dir, 40, () => session.flow.state === 'afterAction');
    expect('reached the after-action report', session.flow.state === 'afterAction', session.flow.state);
    expect('exactly one report was published', reports.length === 1, `${reports.length}`);
    const r = reports[0];
    if (r) {
      note(`report: win=${r.win} xp=${r.xpEarned} rank ${r.rankBefore}→${r.rankAfter} (${r.rankName}) seed=${r.seed}`);
      expect('the report awards XP for a completed match', r.xpEarned > 0, `xpEarned=${r.xpEarned}`);
      expect('the report carries the mode that was played', r.mode === 'tdm' || r.mode === dir.mode,
        `report.mode=${r.mode} played=${dir.mode}`);
      expect('the report carries a replay handle', !!r.replayHash, `hash="${r.replayHash}"`);
      expect('rank did not go backwards', r.rankAfter >= r.rankBefore, `${r.rankBefore}→${r.rankAfter}`);
    }
  }

  sub('G. back to the lobby with the party intact');
  {
    const membersBefore = session.snapshot().members.filter((m) => !m.bot).map((m) => m.id).sort();
    pump(session, dir, 40, () => session.flow.state === 'lobby');
    expect('after-action returns to the lobby', session.flow.state === 'lobby', session.flow.state);
    const after = session.snapshot().members.filter((m) => !m.bot).map((m) => m.id).sort();
    expect('the human party survived the round trip',
      after.length > 0 && after.join(',') === membersBefore.join(','),
      `before=[${membersBefore}] after=[${after}]`);
    note(`lobby phase now ${lobby.session.state?.phase}, matches played ${lobby.session.state?.matchesPlayed}`);
    expect('the real lobby left in-match when the match ended',
      lobby.session.state?.phase !== 'in-match',
      `LobbyState.phase is still '${lobby.session.state?.phase}' — the lobby screen would read IN MATCH forever`);
    expect('the real lobby counted the match it just ran',
      (lobby.session.state?.matchesPlayed ?? 0) >= 1,
      `matchesPlayed=${lobby.session.state?.matchesPlayed}`);
  }

  sub('H. second lap through the same lobby');
  {
    const startsBefore = dir.starts;
    session.request('search', 'ui');
    const t = pump(session, dir, 900, () => session.flow.state === 'afterAction');
    note(`second lap took ${t.toFixed(0)}s → ${session.flow.state}`);
    expect('a second match runs through the same lobby',
      session.flow.state === 'afterAction', `state=${session.flow.state}`);
    expect('the second match actually started', dir.starts === startsBefore + 1,
      `starts=${dir.starts}`);
    expect('two distinct reports were produced', reports.length === 2, `${reports.length}`);
    if (reports.length === 2) {
      expect('the two matches used different seeds', reports[0].seed !== reports[1].seed,
        `${reports[0].seed} vs ${reports[1].seed}`);
    }
    pump(session, dir, 40, () => session.flow.state === 'lobby');
    expect('and returns to the lobby again', session.flow.state === 'lobby', session.flow.state);
  }

  return { session, dir, lobby, mm, reports, faults, states };
}

/* --------------------------------------------------------------- ACT 3 -- */

/** Plays one mode to termination straight through MatchRunner. */
function playMode(id, seed = 4242, budgetSec = 1800) {
  const dir = makeDirector(seed);
  const banners = [];
  dir.bus.on('hud:banner', (b) => banners.push(b));
  dir.startMatch(id, seed);
  const dt = 1 / 60;
  const maxTicks = Math.ceil(budgetSec / dt);
  let ticks = 0;
  while (ticks < maxTicks && dir.match.phase !== 'ended') {
    dir.fixedUpdate(dt, 2.0);
    ticks++;
  }
  return {
    dir, banners, ticks, seconds: ticks * dt,
    phase: dir.match.phase,
    summary: dir.match.summary,
    ended: dir.match.phase === 'ended',
  };
}

async function act3() {
  section('ACT 3 — every mode played to a real conclusion');

  const catalog = M.modes.MODE_CATALOG;
  note(`catalog: ${catalog.map((c) => c.id).join(', ')}`);

  sub('A. straight through MatchRunner (does the mode terminate at all?)');
  const results = {};
  for (const entry of catalog) {
    let r;
    try {
      r = playMode(entry.id, 4242);
    } catch (err) {
      expect(`${entry.id} plays to a conclusion`, false, `threw: ${String(err?.message ?? err)}`);
      continue;
    }
    results[entry.id] = r;
    const s = r.summary;
    expect(`${entry.id} reaches 'ended'`, r.ended,
      `phase=${r.phase} after ${r.seconds.toFixed(0)}s of match time`);
    if (s) {
      note(`${entry.id}: ${r.seconds.toFixed(0)}s  score=${s.score} kills=${s.kills} deaths=${s.deaths} xp=${s.xpEarned} win=${s.win}`);
    } else {
      note(`${entry.id}: no summary`);
    }
    expect(`${entry.id} produces a match summary`, !!s, s ? '' : 'summary is null');
    if (s) {
      expect(`${entry.id} summary reports the mode it played`, s.mode === entry.id,
        `summary.mode='${s.mode}' expected '${entry.id}'`);
      expect(`${entry.id} awards XP`, s.xpEarned > 0, `xpEarned=${s.xpEarned}`);
    }
  }

  sub('B. can the session reach each mode at all?');
  {
    const { normaliseMode } = M.session;
    const unreachable = [];
    for (const entry of catalog) {
      const got = normaliseMode(entry.id);
      if (got !== entry.id) unreachable.push(`${entry.id}→${got}`);
    }
    note(`normaliseMode rewrites: ${unreachable.join('  ') || 'none'}`);
    expect('the session can name every mode in the catalog',
      unreachable.length === 0,
      unreachable.length ? `${unreachable.length}/${catalog.length} modes are rewritten to something else` : '');
  }

  sub('C. can matchmaking form a session for each mode?');
  {
    const playlists = M.playlists.PLAYLISTS;
    const missing = [];
    for (const entry of catalog) {
      const has = Object.values(playlists).some((p) => p.mode === entry.id);
      if (!has) missing.push(entry.id);
    }
    note(`playlists cover: ${[...new Set(Object.values(playlists).map((p) => p.mode))].join(', ')}`);
    expect('every catalog mode has a matchmaking playlist',
      missing.length === 0, missing.length ? `no playlist for: ${missing.join(', ')}` : '');
  }

  sub('D. end-to-end through the session, per mode');
  {
    for (const entry of catalog) {
      const reg = makeRegistry();
      const dir = makeDirector(999);
      const session = M.session.installSession(reg, { bus: dir.bus, seed: 999, mode: entry.id });
      session.attach({ match: dir });
      session.boot();
      session.deploy(entry.id, 'test');
      pump(session, dir, 600, () => session.flow.state === 'afterAction' || session.flow.state === 'fault');
      const played = dir.modes[0];
      expect(`session deploy('${entry.id}') actually launches ${entry.id}`,
        played === entry.id, `launched '${played}' instead`);
    }
  }

  return results;
}

/* --------------------------------------------------------------- ACT 4 -- */

async function act4() {
  section('ACT 4 — things go wrong');

  const { installSession } = M.session;

  const fresh = (opts = {}) => {
    const reg = makeRegistry();
    const dir = makeDirector(opts.seed ?? 555);
    const session = installSession(reg, { bus: dir.bus, seed: opts.seed ?? 555, mode: opts.mode ?? 'tdm', ...opts.session });
    session.attach({ match: dir, ...opts.ports });
    session.boot();
    const faults = [];
    dir.bus.on('session:fault', (f) => faults.push(f));
    const reports = [];
    dir.bus.on('session:report', (r) => reports.push(r));
    return { reg, dir, session, faults, reports };
  };

  sub('A. host drops mid-match');
  {
    const { session, dir, reports } = fresh();
    session.deploy('tdm', 'test');
    pump(session, dir, 120, () => session.flow.state === 'live');
    expect('we are live before the host dies', session.flow.state === 'live', session.flow.state);
    session.notifyHostLost('host process exited');
    expect('host loss moves the session to migrating', session.flow.state === 'migrating', session.flow.state);
    session.notifyMigrated();
    expect('a successful migration resumes the live match',
      session.flow.state === 'live', session.flow.state);
    expect('the match was not restarted by the migration', dir.starts === 1, `starts=${dir.starts}`);
    const t = pump(session, dir, 900, () => session.flow.state === 'afterAction');
    expect('the match still finishes after migrating',
      session.flow.state === 'afterAction', `state=${session.flow.state} after ${t.toFixed(0)}s`);
    expect('the post-migration match still reports', reports.length === 1, `${reports.length}`);
  }

  sub('B. migration that never completes');
  {
    const { session, dir } = fresh({ seed: 556 });
    session.deploy('tdm', 'test');
    pump(session, dir, 120, () => session.flow.state === 'live');
    session.notifyHostLost();
    const t = pump(session, dir, 60, () => session.flow.state !== 'migrating');
    expect('a migration that never completes times out to the lobby',
      session.flow.state === 'lobby', `state=${session.flow.state} after ${t.toFixed(1)}s`);
  }

  sub('C. a player disconnects during loading');
  {
    const { session, dir, reports } = fresh({ seed: 557 });
    session.deploy('tdm', 'test');
    pump(session, dir, 60, () => session.flow.state === 'loading');
    expect('we are loading', session.flow.state === 'loading', session.flow.state);
    session.notifyDropped('socket closed while streaming the map');
    expect('a drop during loading lands somewhere legal and non-terminal',
      session.flow.state === 'lobby', session.flow.state);
    expect('a drop during loading does not fabricate an after-action report',
      reports.length === 0, `${reports.length} report(s)`);
    expect('no match was started for the aborted load', dir.starts === 0, `starts=${dir.starts}`);
    const t = pump(session, dir, 400, () => session.flow.state === 'live');
    expect('the session can deploy again after the drop',
      session.flow.state === 'live', `state=${session.flow.state} after ${t.toFixed(0)}s`);
  }

  sub('D. we drop mid-match');
  {
    const { session, dir, reports } = fresh({ seed: 558 });
    session.deploy('tdm', 'test');
    pump(session, dir, 120, () => session.flow.state === 'live');
    session.notifyDropped('connection lost');
    expect('dropping while live goes to the after-action report',
      session.flow.state === 'afterAction', session.flow.state);
    const r = reports[0];
    expect('an abandoned match is marked abandoned', r?.abandoned === true, `abandoned=${r?.abandoned}`);
    expect('an abandoned match awards no XP', r?.xpEarned === 0, `xp=${r?.xpEarned}`);
    expect('the match runner was told to stop',
      dir.phase === 'ended' || dir.phase === 'ending' || dir.phase === 'idle',
      `match phase is still '${dir.phase}' — the sim is running under the after-action screen`);
  }

  sub('E. a match that cannot fill');
  {
    const reg = makeRegistry();
    const dir = makeDirector(559);
    const session = installSession(reg, {
      bus: dir.bus, seed: 559, mode: 'tdm', config: { botFill: false, searchPatience: 3 },
    });
    session.attach({ match: dir });
    session.boot();
    const faults = [];
    dir.bus.on('session:fault', (f) => faults.push(f));
    session.deploy('tdm', 'test');
    const t = pump(session, dir, 200, () => session.flow.state === 'lobby' && faults.length > 0);
    expect('an unfillable search fails back to the lobby',
      session.flow.state === 'lobby', `state=${session.flow.state} after ${t.toFixed(0)}s`);
    expect('and says why', faults.some((f) => f.kind === 'unfillable' || f.kind === 'search-timeout'),
      faults.map((f) => f.kind).join(',') || 'no fault raised');
    expect('no match was started for a search that never filled', dir.starts === 0, `starts=${dir.starts}`);
  }

  sub('F. overtime');
  {
    // Drive a round-based and a score-based mode into overtime through the real
    // rules, then confirm they still terminate.
    for (const id of ['snd', 'tdm', 'dom', 'kc']) {
      const r = playMode(id, 8181, 2400);
      const ot = r.banners.some((b) => /OVERTIME|SUDDEN DEATH/i.test(`${b.title} ${b.subtitle}`));
      note(`${id}: ${r.seconds.toFixed(0)}s, overtime banner=${ot}, ended=${r.ended}`);
      expect(`${id} terminates even when it goes long`, r.ended, `phase=${r.phase}`);
    }
  }

  sub('G. the loop does not stall anywhere');
  {
    const { session, dir } = fresh({ seed: 560 });
    let stuck = null;
    let last = session.flow.state;
    let sameFor = 0;
    session.deploy('tdm', 'test');
    const dt = 1 / 30;
    for (let i = 0; i < 30 * 1200 && !stuck; i++) {
      session.step(dt);
      dir.fixedUpdate(dt / 2);
      dir.fixedUpdate(dt / 2);
      if (session.flow.state === last) {
        sameFor += dt;
        // 'live' is allowed to be long; every other state has a timer on it.
        const cap = session.flow.state === 'live' ? 1200 : 90;
        if (sameFor > cap) stuck = `${session.flow.state} for ${sameFor.toFixed(0)}s`;
      } else { last = session.flow.state; sameFor = 0; }
      if (session.flow.state === 'lobby' && dir.starts >= 1 && sameFor > 30) break;
    }
    expect('no state holds the player hostage', !stuck, stuck ?? '');
  }
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const server = await createServer({
    root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom',
  });
  try {
    await load(server);
    if (!only || only === 1) await act1();
    if (!only || only === 2) await act2();
    if (!only || only === 3) await act3();
    if (!only || only === 4) await act4();
  } finally {
    await server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
  }
  console.log(failed.length ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
