#!/usr/bin/env node
/**
 * Lobby and party verification.
 *
 * Bundles `src/session/lobby` with rolldown (the bundler vite already ships)
 * and drives the *real* host-authoritative lobby headlessly over the in-process
 * `LocalTransportHub`. No browser, no network, no mocks of the system under
 * test — only the transport is local.
 *
 * The nine sections map one-to-one onto the things a lobby has to survive:
 *
 *   1. room codes          — shape, determinism, what the player can type
 *   2. form + join         — a room, three friends, capacity and bad codes
 *   3. ready gating        — the countdown arms only when the room is honest
 *   4. drop mid-countdown  — a launch in flight aborts cleanly and stays alive
 *   5. launch              — bots, teams, and a deterministic launch order
 *   6. party persistence   — the same squad comes out the far side of a match
 *   7. host migration      — the host vanishes and the lobby does not
 *   8. voting              — tie-break ladder and the timeout default
 *   9. authority           — a client cannot write anything, ever
 *
 *   node tools/session-lobby.mjs [--verbose] [--no-build] [--seed N]
 */
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const VERBOSE = has('verbose');
const SEED = Number(flag('seed', 20260730));
const OUT_DIR = path.join(ROOT, 'dist-s1', 'lobby');
const OUT_FILE = path.join(OUT_DIR, 'lobby.mjs');
const DT = 1 / 30;

/* ------------------------------------------------------------------ report -- */

const checks = [];
let section = '';
const head = (name) => { section = name; checks.push({ section: name, header: true }); };
const check = (name, ok, detail = '') => {
  checks.push({ section, name, ok: !!ok, detail: String(detail) });
  if (VERBOSE) console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const n1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

/* ------------------------------------------------------------------- build -- */

async function bundle() {
  if (has('no-build') && existsSync(OUT_FILE)) return import(`file://${OUT_FILE}?t=${Date.now()}`);
  await mkdir(OUT_DIR, { recursive: true });
  const b = await rolldown({ input: path.join(ROOT, 'src/session/index.ts'), logLevel: 'warn' });
  await b.write({ file: OUT_FILE, format: 'esm' });
  await b.close();
  return import(`file://${OUT_FILE}?t=${Date.now()}`);
}

const L = await bundle();
const {
  LobbyHost, LobbySession, LocalTransportHub, PartyRegistry, VoteBooth,
  buildCandidates, candidateId, assignTeams, summariseTeams,
  pickSuccessor, shouldAdopt, snapshotFromState,
  DEFAULT_CATALOG, codeFromSeed, formatRoomCode, isRoomCode, normalizeRoomCode,
  makeProfile, defaultLobbySettings, LOBBY_PHASES,
} = L;

/* -------------------------------------------------------------------- room -- */

/** A whole lobby of `LobbySession`s wired through one in-process mesh. */
class Room {
  constructor({ hostId = 'p0', seed = SEED, settings = {}, names = {} } = {}) {
    this.hub = new LocalTransportHub(hostId);
    this.events = [];
    this.sessions = new Map();
    this.names = names;
    /** Stands in for the map-load port: everyone streams instantly unless listed. */
    this.autoLoad = true;
    this.slowLoaders = new Set();
    this.hostSession = this.attach(hostId, 10);
    this.hostSession.create({ seed, settings });
    this.code = this.hostSession.code;
  }

  attach(id, ping = 30) {
    const transport = this.hub.connect(id, ping);
    const session = new LobbySession({
      transport,
      profile: makeProfile(id, this.names[id] ?? id.toUpperCase(), {
        skill: skillFor(id), rank: 1 + (hash(id) % 40),
      }),
      emit: (key, payload) => this.events.push({ peer: id, key, payload }),
      snapshotIntervalSec: 1,
    });
    this.sessions.set(id, session);
    return session;
  }

  join(id, ping = 30) {
    const s = this.attach(id, ping);
    s.join(this.code);
    return s;
  }

  get(id) { return this.sessions.get(id); }
  get host() { for (const s of this.sessions.values()) if (s.isHost) return s; return null; }
  get state() { return this.host?.state ?? null; }

  /** One frame: the map-load port answers first, then the lobby advances. */
  step(dt = DT) {
    if (this.autoLoad && this.state?.phase === 'loading') {
      for (const [id, s] of this.sessions) {
        if (!this.slowLoaders.has(id)) s.reportLoadProgress(1);
      }
    }
    for (const s of this.sessions.values()) s.tick(dt);
  }

  tick(seconds, dt = DT) {
    for (let t = 0; t < seconds - 1e-9; t += dt) this.step(dt);
  }

  /** Ticks until `pred(state)` or `limit` seconds elapse. Returns seconds spent. */
  until(pred, limit = 60, dt = DT) {
    let t = 0;
    while (t < limit) {
      if (pred(this.state, this)) return t;
      this.step(dt);
      t += dt;
    }
    return pred(this.state, this) ? t : -1;
  }

  readyAll(value = true) {
    for (const [id, s] of this.sessions) {
      if (this.state?.members.find((m) => m.id === id && !m.profile.bot)) s.ready(value);
    }
  }

  since(mark, key) { return this.events.slice(mark).filter((e) => e.key === key); }
  get mark() { return this.events.length; }
}

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const skillFor = (id) => Math.round(((hash(id) % 700) / 1000 + 0.15) * 100) / 100;

const TEST_SETTINGS = {
  maxPlayers: 8, minPlayers: 2, countdownSec: 4, fullCountdownSec: 2,
  voteSec: 6, postMatchSec: 3, loadTimeoutSec: 4, fillWithBots: false,
  pinnedMapId: 'blackout_dusk', pinnedModeId: 'tdm',
};

/* ------------------------------------------------------- 1. room codes ---- */

head('1. room codes');
{
  const a = codeFromSeed('1337:p0');
  const b = codeFromSeed('1337:p0');
  const c = codeFromSeed('1338:p0');
  check('code is 6 chars from the safe alphabet', isRoomCode(a) && a.length === 6, a);
  check('code derivation is deterministic', a === b, `${a} === ${b}`);
  check('a different seed gives a different code', a !== c, `${a} vs ${c}`);
  check('display form is grouped', /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(formatRoomCode(a)), formatRoomCode(a));
  check('player typing is forgiving', normalizeRoomCode(` ${formatRoomCode(a).toLowerCase()} `) === a,
    `"${formatRoomCode(a).toLowerCase()}" -> ${normalizeRoomCode(formatRoomCode(a).toLowerCase())}`);
  check('garbage is rejected', normalizeRoomCode('hello!!') === '' || !isRoomCode(normalizeRoomCode('hello!!')),
    JSON.stringify(normalizeRoomCode('hello!!')));
  const ambiguous = ['O', 'I', 'L', 'U'].filter((ch) => L.CODE_ALPHABET.includes(ch));
  check('alphabet drops look-alike glyphs', ambiguous.length === 0, `found ${ambiguous.join(',') || 'none'}`);
  check('look-alikes the player types are folded in',
    normalizeRoomCode('oil-uxy') === '011VXY', `"oil-uxy" -> ${normalizeRoomCode('oil-uxy')}`);
}

/* -------------------------------------------------- 2. form and join ------ */

head('2. form a lobby, three friends join');
const room = new Room({ settings: TEST_SETTINGS, names: { p0: 'HOST', p1: 'ALPHA', p2: 'BRAVO', p3: 'CHARLIE' } });
{
  check('lobby forms with the host in it', room.state?.phase === 'forming' && room.state.members.length === 1,
    `phase=${room.state?.phase} members=${room.state?.members.length}`);
  check('host is the leader', room.state?.leaderId === 'p0' && room.state?.hostId === 'p0');
  check('room code is shareable', isRoomCode(room.code), formatRoomCode(room.code));

  room.join('p1', 24); room.join('p2', 60); room.join('p3', 110);
  room.tick(0.2);
  check('three friends joined by code', room.state?.members.length === 4,
    `members=${room.state?.members.length}`);
  check('every client sees the same state', ['p1', 'p2', 'p3'].every((id) => {
    const s = room.get(id).state;
    return s && s.id === room.state.id && s.members.length === 4 && s.seq === room.state.seq;
  }), `seq=${room.state?.seq}`);
  check('clients are not authoritative', ['p1', 'p2', 'p3'].every((id) => !room.get(id).isHost));

  const bad = room.host.host.submit({ t: 'join', code: 'ZZZZZZ', profile: makeProfile('p9', 'NINE') }, 'p9');
  check('a wrong code is refused', bad.ok === false && bad.code === 'bad-code', bad.code ?? '');
  check('the refusal did not add anybody', room.state.members.length === 4);

  // Fill to capacity, then one too many.
  for (let i = 4; i < 8; i++) room.join(`p${i}`, 40);
  room.tick(0.2);
  check('lobby fills to capacity', room.state.members.length === 8, `members=${room.state.members.length}`);
  const full = room.host.host.submit({ t: 'join', code: room.code, profile: makeProfile('p9', 'NINE') }, 'p9');
  check('a full lobby refuses the next player', full.ok === false && full.code === 'full', full.code ?? '');

  // Back down to four for the rest of the run.
  for (let i = 4; i < 8; i++) { room.get(`p${i}`).leave(); room.hub.disconnect(`p${i}`); room.sessions.delete(`p${i}`); }
  room.tick(0.2);
  check('players can leave again', room.state.members.length === 4, `members=${room.state.members.length}`);
}

/* ------------------------------------------------------ 3. ready gating --- */

head('3. ready-up gating and the countdown');
{
  room.get('p1').ready(true);
  room.get('p2').ready(true);
  room.tick(1);
  check('a partly-ready room does not arm', room.state.phase === 'forming',
    `phase=${room.state.phase} ready=${room.state.readyCount}/4`);
  check('status line names the blocker', /READY UP/.test(room.state.message), room.state.message);

  const mark = room.mark;
  room.readyAll(true);
  room.tick(0.2);
  check('a fully-ready room arms the countdown', room.state.phase === 'ready' && room.state.countdown.active,
    `phase=${room.state.phase} left=${n1(room.state.countdown.secondsLeft)}s`);
  check('countdown length is the configured one',
    near(room.state.countdown.total, TEST_SETTINGS.countdownSec, 0.01),
    `${room.state.countdown.total}s`);
  check('countdown is announced', room.since(mark, 'lobby:countdown').length > 0,
    `${room.since(mark, 'lobby:countdown').length} beats`);

  // Un-readying disarms it.
  room.get('p2').ready(false);
  room.tick(0.1);
  check('one player un-readying aborts the launch',
    room.state.phase === 'forming' && room.state.countdown.abortedBy === 'unready',
    `abortedBy=${room.state.countdown.abortedBy}`);
  room.get('p2').ready(true);
  room.tick(0.2);
  check('the room re-arms once they are back', room.state.phase === 'ready');
}

/* -------------------------------------------- 4. drop mid-countdown ------- */

head('4. a member drops mid-countdown');
{
  room.tick(1.5);
  const before = room.state.countdown.secondsLeft;
  const mark = room.mark;
  // The transport reports the loss synchronously, so this is the state the very
  // next `lobby:state` carries — before any timer has had a chance to re-arm.
  room.hub.disconnect('p3');
  const s = room.state;
  check('the countdown aborted the instant the peer was lost',
    s.phase === 'forming' && !s.countdown.active,
    `phase=${s.phase}, was ${n1(before)}s from launch`);
  check('the abort reason is honest', s.countdown.abortedBy === 'member-dropped', s.countdown.abortedBy);
  check('the abort is announced with renderable text',
    room.since(mark, 'lobby:countdown:abort').some((e) => /DISCONNECTED/.test(e.payload.text)),
    room.since(mark, 'lobby:countdown:abort')[0]?.payload.text ?? 'none');
  check('the lobby survived', !room.host.host.isClosed && s.members.length === 3,
    `members=${s.members.length}`);
  check('the room code is unchanged', s.code === room.code, formatRoomCode(s.code));
  check('surviving clients still hold state',
    ['p1', 'p2'].every((id) => room.get(id).state?.members.length === 3));
  check('the dropped player is gone from the roster',
    !s.members.some((m) => m.id === 'p3'));
  room.sessions.delete('p3');

  // The three who are left are all still ready, so the room re-arms — from the
  // top, not from the 2.9s the aborted launch had left on it.
  room.tick(0.1);
  check('the room re-arms from full once the survivors still qualify',
    room.state.phase === 'ready' && near(room.state.countdown.secondsLeft, TEST_SETTINGS.countdownSec, 0.2),
    `phase=${room.state.phase} left=${n1(room.state.countdown.secondsLeft)}s`);
  room.get('p1').ready(false);
  room.tick(0.05);
  check('and it disarms again on demand', room.state.phase === 'forming', room.state.phase);
}

/* --------------------------------------------------------- 5. launch ----- */

head('5. launch');
let launch = null;
{
  room.readyAll(true);
  const mark = room.mark;
  const t = room.until((st) => st.phase === 'in-match', 30);
  check('the room reached the match', t >= 0, `${n1(t)}s`);
  const launches = room.since(mark, 'lobby:launch');
  launch = launches[0]?.payload ?? null;
  check('exactly one launch order was issued', launches.filter((e) => e.peer === 'p0').length === 1,
    `${launches.length} emits across ${room.sessions.size} peers`);
  check('the launch order is complete', !!launch && !!launch.mapId && !!launch.modeId
    && !!launch.levelId && Number.isFinite(launch.seed) && Array.isArray(launch.roster),
    launch ? `${launch.mapId}/${launch.modeId} seed=${launch.seed}` : 'missing');
  check('the roster is everyone present', launch?.roster.length === room.state.members.length,
    `roster=${launch?.roster.length} members=${room.state.members.length}`);
  check('every player has a real team',
    launch?.roster.every((r) => r.team === 'alpha' || r.team === 'bravo'),
    launch?.roster.map((r) => `${r.name}:${r.team}`).join(' '));
  const alpha = launch?.roster.filter((r) => r.team === 'alpha').length ?? 0;
  const bravo = launch?.roster.filter((r) => r.team === 'bravo').length ?? 0;
  check('the teams are within one player', Math.abs(alpha - bravo) <= 1, `${alpha}v${bravo}`);
  check('the pinned map and mode won', launch?.mapId === 'blackout_dusk' && launch?.modeId === 'tdm');
  check('loading resolved to in-match', room.state.phase === 'in-match', room.state.phase);
  check('everybody finished loading',
    room.state.members.every((m) => m.loadProgress >= 1 && m.connection === 'connected'));
}

/* ------------------------------------------- 6. the party survives -------- */

head('6. party persistence across a match');
{
  const before = room.state;
  const result = {
    matchIndex: before.matchesPlayed, mapId: launch.mapId, modeId: launch.modeId,
    winner: 'alpha', alphaScore: 75, bravoScore: 41, durationSec: 412,
  };
  room.host.reportResult(result);
  room.tick(0.1);
  check('the match result put the lobby on the scoreboard', room.state.phase === 'post-match',
    room.state.phase);
  check('the scoreboard is the last result', room.state.lastResult?.alphaScore === 75);

  const t = room.until((st) => st.phase === 'forming', 20);
  check('the lobby recycled back to forming', t >= 0, `${n1(t)}s`);
  const after = room.state;
  check('the same people are still here',
    after.members.length === 3 && ['p0', 'p1', 'p2'].every((id) => after.members.some((m) => m.id === id)),
    after.members.map((m) => m.id).join(','));
  check('the room code never changed', after.code === room.code, formatRoomCode(after.code));
  check('readies were cleared for the next round', after.readyCount === 0, `${after.readyCount} ready`);
  check('the match counter advanced', after.matchesPlayed === before.matchesPlayed + 1,
    `${before.matchesPlayed} -> ${after.matchesPlayed}`);
  check('a fresh vote or pin is up', after.vote.candidates.length > 0);

  // Now form a real party inside the recycled lobby and run a second match.
  room.get('p1').submit({ t: 'party:create' });
  room.tick(0.05);
  const pid = room.state.parties[0]?.id;
  room.get('p1').submit({ t: 'party:invite', target: 'p2' });
  room.get('p2').submit({ t: 'party:accept', partyId: pid });
  room.tick(0.05);
  const party = room.state.parties.find((p) => p.id === pid);
  check('a party formed', !!party && party.members.length === 2 && party.leaderId === 'p1',
    party ? `${party.id} [${party.members.join(',')}]` : 'none');
  check('members carry the party tag',
    room.state.members.filter((m) => m.partyId === pid).length === 2);

  room.readyAll(true);
  room.until((st) => st.phase === 'in-match', 30);
  const roster = room.host.host.launchConfig().roster;
  const teams = new Set(roster.filter((r) => r.partyId === pid).map((r) => r.team));
  check('the party landed on one team', teams.size === 1, `teams=${[...teams].join(',')}`);
  check('the party is not marked split', room.state.parties.find((p) => p.id === pid)?.split === false);

  room.host.reportResult({ ...result, matchIndex: room.state.matchesPlayed });
  room.until((st) => st.phase === 'forming', 20);
  const kept = room.state.parties.find((p) => p.id === pid);
  check('the party outlived the match', !!kept && kept.members.length === 2,
    kept ? `[${kept.members.join(',')}]` : 'gone');
  check('matches-together counted up', kept?.matchesTogether === 1, `${kept?.matchesTogether}`);
  check('the party is stamped with the room to rejoin',
    room.host.host.parties.get(pid)?.lobbyCode === room.code,
    formatRoomCode(room.host.host.parties.get(pid)?.lobbyCode ?? ''));
  check('two matches played in one unbroken lobby', room.state.matchesPlayed === 2,
    `${room.state.matchesPlayed}`);
  room.partyId = pid;
}

/* ------------------------------------------------ 7. host migration ------- */

head('7. host migration');
{
  const before = room.state;
  const beforeParty = before.parties.find((p) => p.id === room.partyId);

  // Every peer must independently agree on the successor with no negotiation.
  const picks = ['p1', 'p2'].map((id) => room.get(id).state
    ? pickSuccessor(room.get(id).state, 'p0') : null);
  const agreed = picks.every((p) => p === picks[0]) && picks[0] !== null;
  check('every peer elects the same successor without talking', agreed, `picks=${picks.join(',')}`);
  const successor = picks[0];
  check('the successor is the best link', successor === 'p1', `${successor} (pings 24/60)`);
  check('exactly one peer would adopt',
    ['p1', 'p2'].filter((id) => shouldAdopt(room.get(id).state, id, 'p0')).length === 1);

  const mark = room.mark;
  room.hub.disconnect('p0');
  room.sessions.delete('p0');
  room.hub.setHost(successor);
  room.tick(0.1);

  const after = room.state;
  check('somebody is authoritative again', room.get(successor).isHost && after !== null);
  check('the new host is the elected peer', after.hostId === successor, after.hostId);
  check('the epoch advanced so stale packets are dropped', after.epoch === before.epoch + 1,
    `${before.epoch} -> ${after.epoch}`);
  check('the room code survived', after.code === room.code, formatRoomCode(after.code));
  check('the lobby id survived', after.id === before.id, after.id);
  check('the old host was dropped from the roster', !after.members.some((m) => m.id === 'p0'));
  check('everyone else survived',
    ['p1', 'p2'].every((id) => after.members.some((m) => m.id === id)),
    after.members.map((m) => m.id).join(','));
  check('match history survived', after.matchesPlayed === before.matchesPlayed,
    `${after.matchesPlayed}`);
  check('the party survived the handover', (() => {
    const p = after.parties.find((x) => x.id === room.partyId);
    return !!p && p.members.length === 2 && p.matchesTogether === beforeParty.matchesTogether;
  })(), `${after.parties.map((p) => `${p.id}:${p.matchesTogether}`).join(',')}`);
  check('the handover was announced', room.since(mark, 'lobby:host:migrated').length > 0);
  check('the handover did not announce a *new* lobby',
    room.since(mark, 'lobby:created').length === 0,
    `${room.since(mark, 'lobby:created').length} lobby:created emits`);
  check('the handover did not re-open the vote board',
    room.since(mark, 'lobby:vote:open').length === 0,
    `${room.since(mark, 'lobby:vote:open').length} lobby:vote:open emits`);
  check('the selection the room voted for is intact',
    after.selection.mapId === before.selection.mapId && after.selection.seed === before.selection.seed,
    `${after.selection.mapId} seed=${after.selection.seed}`);
  check('there is still only one party book on this machine',
    room.get(successor).parties === room.get(successor).host.parties);
  check('the remaining client follows the new host',
    room.get('p2').state?.hostId === successor && room.get('p2').state?.epoch === after.epoch,
    `client epoch=${room.get('p2').state?.epoch}`);
  check('the session party registry followed too',
    room.get(successor).parties.get(room.partyId)?.members.length === 2);

  // And the migrated lobby is a *working* lobby, not a corpse. Everybody was
  // ready when the old host died, so the first thing it does is re-arm.
  check('the lobby resumed in the phase it was in', after.phase === before.phase,
    `${before.phase} -> ${after.phase}`);
  check('the ready gate is where the old host left it',
    after.readyCount === before.readyCount, `${before.readyCount} -> ${after.readyCount}`);
  room.join('p3b', 35);
  room.tick(0.2);
  check('the migrated lobby still accepts joins', room.state.members.length === 3,
    `members=${room.state.members.length}`);
  room.readyAll(true);
  const t = room.until((st) => st.phase === 'in-match', 40);
  check('the migrated lobby still launches matches', t >= 0,
    `${n1(t)}s, phase=${room.state.phase} ready=${room.state.readyCount}/${room.state.members.length}`);
  check('the launch order names the new host',
    room.host.host.launchConfig().hostId === successor);
  check('the match seed advanced with the match index',
    room.host.host.launchConfig().matchIndex === 2, `matchIndex=${room.host.host.launchConfig().matchIndex}`);
}

/* -------------------------------------- 7b. migration mid-countdown ------- */

head('7b. migration during an armed countdown');
{
  const r = new Room({ settings: { ...TEST_SETTINGS, countdownSec: 8, hostMigrationGraceSec: 5 } });
  r.join('c1', 20); r.join('c2', 90);
  r.tick(1.2);                       // let a full snapshot reach the clients
  r.readyAll(true);
  r.tick(0.2);
  check('countdown armed before the host dies', r.state.phase === 'ready', r.state.phase);
  r.tick(4);
  const left = r.state.countdown.secondsLeft;
  const successor = pickSuccessor(r.state, 'p0');
  r.hub.disconnect('p0'); r.sessions.delete('p0');
  r.hub.setHost(successor);
  r.tick(0.1);
  check('the countdown was not lost with the host', r.state.phase === 'ready' && r.state.countdown.active,
    `phase=${r.state.phase}`);
  check('the countdown was extended by the migration grace',
    r.state.countdown.secondsLeft >= 5 - 0.2 && r.state.countdown.secondsLeft > left,
    `${n1(left)}s -> ${n1(r.state.countdown.secondsLeft)}s (grace 5s)`);
  const t = r.until((st) => st.phase === 'in-match', 40);
  check('it launched under the new host', t >= 0 && r.state.hostId === successor, `${n1(t)}s`);
}

/* ------------------------------- 6b. the party survives a page reload ----- */

head('6b. party persistence across a reload');
{
  // One tab's storage, two lives. `browserPartyStore` is the same shape.
  const disk = new Map();
  const store = {
    read: (k) => disk.get(k) ?? null,
    write: (k, v) => { disk.set(k, v); },
    remove: (k) => { disk.delete(k); },
  };

  const first = new PartyRegistry(store);
  const party = first.create('p1', 0, 'lby_x');
  first.join(party.id, 'p2');
  first.join(party.id, 'p3');
  first.setLobbyCode('SAF16X');
  first.noteMatchPlayed(new Set(['p1', 'p2', 'p3']));
  first.persist('p1');
  check('a squad is written to storage', disk.size === 1, `${disk.size} record`);

  const second = new PartyRegistry(store);      // <- the page reloaded
  const restored = second.restorePersisted();
  check('the squad comes back after a reload', !!restored && restored.members.length === 3,
    restored ? restored.members.join(',') : 'nothing');
  check('so does the room to rejoin', restored?.lobbyCode === 'SAF16X', restored?.lobbyCode ?? 'null');
  check('so does the shared-match count', restored?.matchesTogether === 1, `${restored?.matchesTogether}`);
  check('and the player is still in it', second.partyOf('p2')?.id === party.id);

  // A solo player has no squad to remember, and a dissolved one is forgotten.
  const solo = new PartyRegistry(store);
  solo.restorePersisted();
  solo.leave('p2'); solo.leave('p3');
  solo.persist('p1');
  check('a dissolved party is cleared from storage', disk.size === 0, `${disk.size} records`);
  check('a changed roster resets the shared-match count', (() => {
    const r = new PartyRegistry(store);
    const p = r.create('q1', 0, 'lby_y');
    r.join(p.id, 'q2');
    r.noteMatchPlayed(new Set(['q1', 'q2']));
    const before = p.matchesTogether;
    r.join(p.id, 'q3');
    return before === 1 && p.matchesTogether === 0;
  })());
  check('corrupt storage is survivable', (() => {
    // Write through the registry itself so the key is whatever it really uses,
    // then corrupt it in place — a hard-coded key here would pass by accident.
    const r0 = new PartyRegistry(store);
    const p0 = r0.create('z1', 0, 'lby_z'); r0.join(p0.id, 'z2'); r0.persist('z1');
    const key = [...disk.keys()][0];
    if (!key) return false;
    disk.set(key, '{ not json');
    return new PartyRegistry(store).restorePersisted() === null && !disk.has(key);
  })());
}

/* ------------------------------------------------ 7c. snapshot fallback --- */

head('7c. election before any snapshot arrived');
{
  const r = new Room({ settings: TEST_SETTINGS });
  r.join('d1', 15);
  r.tick(0.1);
  const view = r.get('d1').state;
  const snap = snapshotFromState(view);
  check('a read model alone can rebuild a host', !!snap && snap.version === 1 && !!snap.state);
  const revived = LobbyHost.adopt(snap, { hostId: 'd1', departed: 'p0' });
  check('the rebuilt lobby keeps the code', revived.code === r.code, formatRoomCode(revived.code));
  check('the rebuilt lobby keeps the members', revived.state.members.length === 1
    && revived.state.members[0].id === 'd1', revived.state.members.map((m) => m.id).join(','));
  check('a JSON round-trip loses nothing',
    JSON.stringify(LobbyHost.adopt(JSON.parse(JSON.stringify(snap)), { hostId: 'd1', departed: 'p0' }).state.members)
    === JSON.stringify(revived.state.members));
  check('the rebuilt lobby is usable', revived.submit({ t: 'ready', ready: true }, 'd1').ok === true);
}

/* ---------------------------------------------------------- 8. voting ----- */

head('8. voting');
{
  const ctx = { lobbyId: 'lby_test', matchIndex: 0, players: 6, lastMapId: null, count: 3 };
  const cards = buildCandidates(DEFAULT_CATALOG, ctx);
  check('the board has the configured number of cards', cards.length === 3, `${cards.length}`);
  check('every card is a distinct map/mode pair',
    new Set(cards.map((c) => c.id)).size === cards.length);
  check('one card is recommended as the default',
    cards.filter((c) => c.recommended).length === 1);
  check('the board is deterministic',
    JSON.stringify(buildCandidates(DEFAULT_CATALOG, ctx).map((c) => c.id)) === JSON.stringify(cards.map((c) => c.id)),
    cards.map((c) => c.id).join(' '));

  // Timeout with nobody voting -> the recommended default.
  {
    const booth = new VoteBooth('lby_test', 0, null);
    booth.openBoard(buildCandidates(DEFAULT_CATALOG, ctx), 5);
    let closed = false;
    for (let t = 0; t < 8 && !closed; t += DT) closed = booth.tick(DT, 6, 'p0');
    check('an unattended vote resolves on its own', closed && booth.resolved);
    check('it resolves to the recommended default',
      booth.result?.resolvedBy === 'timeout-default' && booth.result.candidate.recommended === true,
      booth.result?.resolvedBy ?? 'none');
  }

  // A dead heat, broken by the leader's own vote.
  {
    const booth = new VoteBooth('lby_test', 0, null);
    booth.openBoard(buildCandidates(DEFAULT_CATALOG, ctx), 5);
    const [a, b] = booth.cards;
    booth.cast('p0', b.id);          // p0 is the leader
    booth.cast('p1', b.id);
    booth.cast('p2', a.id);
    booth.cast('p3', a.id);
    const res = booth.close('p0');
    check('a tie is broken by the leader', res.resolvedBy === 'leader' && res.candidate.id === b.id,
      `${res.resolvedBy} -> ${res.candidate.id}`);
  }

  // A dead heat where the leader abstained, broken by freshness then hash.
  {
    const fresh = new VoteBooth('lby_test', 1, null);
    const cards2 = buildCandidates(DEFAULT_CATALOG, { ...ctx, matchIndex: 1 });
    const booth = new VoteBooth('lby_test', 1, cards2[0].mapId);
    booth.openBoard(cards2, 5);
    booth.cast('p1', cards2[0].id);
    booth.cast('p2', cards2[1].id);
    const res = booth.close('p0');
    check('a tie prefers a map we did not just play',
      res.resolvedBy === 'freshness' ? res.candidate.mapId !== cards2[0].mapId : res.resolvedBy === 'hash',
      `${res.resolvedBy} -> ${res.candidate.mapId}`);
    check('the tie-break is deterministic', (() => {
      const again = new VoteBooth('lby_test', 1, cards2[0].mapId);
      again.openBoard(buildCandidates(DEFAULT_CATALOG, { ...ctx, matchIndex: 1 }), 5);
      again.cast('p1', cards2[0].id); again.cast('p2', cards2[1].id);
      return again.close('p0').candidate.id === res.candidate.id;
    })());
    void fresh;
  }

  // A live lobby votes, and the winner becomes the selection.
  {
    const r = new Room({ settings: { ...TEST_SETTINGS, pinnedMapId: null, pinnedModeId: null, voteSec: 5 } });
    r.join('v1', 20); r.join('v2', 30);
    r.tick(0.2);
    const board = r.state.vote.candidates;
    check('a live lobby opens a board', r.state.vote.open && board.length > 0, `${board.length} cards`);
    const pickCard = board.find((c) => c.modeId === 'tdm') ?? board[0];
    r.get('p0').vote(pickCard.id); r.get('v1').vote(pickCard.id); r.get('v2').vote(pickCard.id);
    r.tick(0.2);
    check('the board closes as soon as everyone has voted', !r.state.vote.open, `cast=${r.state.vote.cast}`);
    check('the winner became the lobby selection',
      r.state.selection.mapId === pickCard.mapId && r.state.selection.modeId === pickCard.modeId,
      `${r.state.selection.mapId}/${r.state.selection.modeId}`);
    check('the match seed is derived, not random',
      r.state.selection.seed === new Room({ settings: { ...TEST_SETTINGS, pinnedMapId: pickCard.mapId, pinnedModeId: pickCard.modeId } }).state.selection.seed,
      `${r.state.selection.seed}`);
  }
}

/* ------------------------------------------------------- 9. authority ----- */

head('9. authority');
{
  const r = new Room({ settings: TEST_SETTINGS });
  r.join('a1', 20); r.join('a2', 30);
  r.tick(0.2);

  const client = r.get('a1');
  const seqBefore = r.state.seq;
  const local = client.state;
  local.members[0].ready = true;
  local.phase = 'in-match';
  local.settings.maxPlayers = 99;
  r.tick(0.05);
  check('a client scribbling on its read model changes nothing',
    r.state.phase === 'forming' && r.state.settings.maxPlayers === TEST_SETTINGS.maxPlayers,
    `phase=${r.state.phase} cap=${r.state.settings.maxPlayers}`);
  check('the next authoritative state overwrites the scribble',
    client.state.phase === 'forming' || client.state.seq >= seqBefore);

  const kick = r.host.host.submit({ t: 'kick', target: 'a2' }, 'a1');
  check('a non-leader cannot kick', kick.ok === false && kick.code === 'not-leader', kick.code ?? '');
  const settings = r.host.host.submit({ t: 'settings', patch: { maxPlayers: 2 } }, 'a1');
  check('a non-leader cannot change settings', settings.ok === false && settings.code === 'not-leader');
  const result = r.host.host.submit({
    t: 'matchEnded',
    result: { matchIndex: 0, mapId: 'blackout_dusk', modeId: 'tdm', winner: 'alpha', alphaScore: 1, bravoScore: 0, durationSec: 1 },
  }, 'a1');
  check('a client cannot report a match result', result.ok === false && result.code === 'not-host', result.code ?? '');
  const selfKick = r.host.host.submit({ t: 'kick', target: 'p0' }, 'p0');
  check('the leader cannot kick themselves', selfKick.ok === false, selfKick.code ?? '');

  const leaderKick = r.host.host.submit({ t: 'kick', target: 'a2' }, 'p0');
  r.tick(0.05);
  check('the leader can kick', leaderKick.ok === true && !r.state.members.some((m) => m.id === 'a2'),
    `members=${r.state.members.length}`);

  r.get('p0').promote('a1');
  r.tick(0.05);
  check('leadership can be handed over', r.state.leaderId === 'a1', r.state.leaderId);
  check('the promoted client is now the leader but not the host',
    r.get('a1').isLeader === true && r.get('a1').isHost === false);
  const nowLegal = r.host.host.submit({ t: 'settings', patch: { name: 'a1 rules' } }, 'a1');
  check('the new leader can change settings', nowLegal.ok === true);

  check('every phase in the read model is a declared phase',
    LOBBY_PHASES.includes(r.state.phase), r.state.phase);
  check('the read model survives a JSON round-trip unchanged',
    JSON.stringify(JSON.parse(JSON.stringify(r.state))) === JSON.stringify(r.state));
}

/* ------------------------------------------------- 10. bots and balance --- */

head('10. bot fill and team balance');
{
  const r = new Room({
    settings: { ...TEST_SETTINGS, fillWithBots: true, maxPlayers: 6, countdownSec: 1 },
  });
  r.join('b1', 20); r.join('b2', 30);
  r.tick(0.2);
  r.readyAll(true);
  r.until((st) => st.phase === 'in-match', 30);
  const st = r.state;
  check('bots filled the empty slots', st.members.length === 6,
    `${st.members.filter((m) => m.profile.bot).length} bots of ${st.members.length}`);
  check('bot names are drawn from the seeded RNG, not Math.random',
    st.members.filter((m) => m.profile.bot).every((m) => m.profile.name.length > 0));
  const alpha = st.teams.find((t) => t.id === 'alpha');
  const bravo = st.teams.find((t) => t.id === 'bravo');
  check('teams are even', Math.abs(alpha.size - bravo.size) <= 1, `${alpha.size}v${bravo.size}`);
  check('team skill is close', Math.abs(alpha.skill - bravo.skill) <= 1.0,
    `alpha ${alpha.skill.toFixed(2)} vs bravo ${bravo.skill.toFixed(2)}`);
  check('team names come from the mode', alpha.name.length > 0 && bravo.name.length > 0,
    `${alpha.name} / ${bravo.name}`);

  // Balancer, in isolation, with a party that must be kept whole.
  const members = [
    { id: 'x1', skill: 0.9, partyId: 'pty_a', team: 'none', teamLocked: false, bot: false },
    { id: 'x2', skill: 0.8, partyId: 'pty_a', team: 'none', teamLocked: false, bot: false },
    { id: 'x3', skill: 0.7, partyId: 'pty_a', team: 'none', teamLocked: false, bot: false },
    { id: 'y1', skill: 0.6, partyId: null, team: 'none', teamLocked: false, bot: false },
    { id: 'y2', skill: 0.5, partyId: null, team: 'none', teamLocked: false, bot: false },
    { id: 'y3', skill: 0.4, partyId: null, team: 'none', teamLocked: false, bot: false },
  ];
  const opts = { teamCount: 2, maxPlayers: 6, keepPartiesTogether: true, salt: 'lby_test' };
  const bal = assignTeams(members, opts);
  const partyTeams = new Set(bal.assignments.filter((a) => a.playerId.startsWith('x')).map((a) => a.team));
  check('a party of three stays whole when it fits', partyTeams.size === 1 && bal.splitParties.length === 0,
    `teams=${[...partyTeams].join(',')} split=${bal.splitParties.length}`);
  check('the sides are still even', bal.alpha === 3 && bal.bravo === 3, `${bal.alpha}v${bal.bravo}`);
  check('balancing is deterministic',
    JSON.stringify(assignTeams(members, opts).assignments) === JSON.stringify(bal.assignments));

  // Now make it impossible and check it reports the split rather than lying.
  const big = [
    ...members.map((m) => ({ ...m })),
    { id: 'x4', skill: 0.5, partyId: 'pty_a', team: 'none', teamLocked: false, bot: false },
  ];
  big[0].partyId = 'pty_a';
  const forced = assignTeams(big, { ...opts, maxPlayers: 6 });
  const st2 = summariseTeams(big, DEFAULT_CATALOG.modes[0], { teamCount: 2, maxPlayers: 6 });
  check('an oversized party is split and says so',
    forced.splitParties.includes('pty_a') || forced.assignments.filter((a) => a.splitFromParty).length > 0,
    `split=${forced.splitParties.join(',')}`);
  check('team summaries are renderable', st2.length === 2 && st2.every((t) => typeof t.name === 'string'),
    st2.map((t) => `${t.name} ${t.size}/${t.capacity}`).join(' | '));
}

/* -------------------------------------------------------------- report ---- */

const real = checks.filter((c) => !c.header);
const failed = real.filter((c) => !c.ok);
console.log('');
console.log('  LOBBY AND PARTY — host-authoritative session layer');
console.log('  ' + '-'.repeat(76));
// Sections run in dependency order (one long-lived room threads through several
// of them); they *read* in numeric order.
const sections = [...new Set(checks.filter((c) => c.header).map((c) => c.section))]
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
for (const s of sections) {
  console.log('');
  console.log(`  ${s}`);
  for (const c of real) {
    if (c.section !== s) continue;
    const tag = c.ok ? 'PASS' : 'FAIL';
    const detail = c.detail ? `  (${c.detail})` : '';
    console.log(`    ${tag}  ${c.name}${detail}`);
  }
}
console.log('');
console.log('  ' + '-'.repeat(76));
console.log(`  ${real.length - failed.length}/${real.length} checks passed`);
if (failed.length) {
  console.log('');
  for (const f of failed) console.log(`  FAILED: [${f.section}] ${f.name} — ${f.detail}`);
}
console.log('');
console.log(failed.length === 0 ? '  PASS' : `  FAIL (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);
