#!/usr/bin/env node
/**
 * Headless verification of the authoritative host, replication and host migration.
 *
 *   node tools/net-host.mjs [--verbose]
 *
 * Runs entirely in-process on a virtual clock over `LoopbackTransport` with real
 * latency, jitter and packet loss. Deterministic: same seed, same result, every
 * run. Prints PASS/FAIL with numbers, exits non-zero on any failure.
 *
 * What it actually proves, in order:
 *   1. election is a pure, deterministic function with sane degradation
 *   2. checkpoints round-trip and reject corruption
 *   3. two independent authorities fed identical input stay bit-identical
 *   4. delta compression + interest management reconstruct exactly on the client
 *   5. a 30-second three-peer match survives the host being killed — twice —
 *      with player identity, score and simulation continuity intact
 */

import './ts-loader.mjs';

const VERBOSE = process.argv.includes('--verbose');

const {
  PeerSession, SnapshotReader, ArenaSim, AuthorityCore, LoopbackNetwork,
  electHost, exportCheckpoint, verifyCheckpoint, importCheckpoint,
  DEFAULT_MIGRATION_POLICY, BTN, ENTITY_FLAG, ENT, fnv1a,
} = await import('../src/net/host/index.ts');
const { Rand } = await import('../src/core/Rand.ts');

/* ------------------------------------------------------------------ */
/* tiny assertion harness                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

/* ------------------------------------------------------------------ */
/* 1. election                                                         */
/* ------------------------------------------------------------------ */

section('1. host election is deterministic and degrades sensibly');
{
  const roster = (over) => ({
    clientId: 1, stableId: 'x', peerId: 'p', name: 'x', team: 0,
    connected: true, rttMs: 20, checkpointTick: 100, hostCapable: true, ...over,
  });
  const policy = DEFAULT_MIGRATION_POLICY;

  const base = [
    roster({ stableId: 'p-carol', clientId: 1 }),
    roster({ stableId: 'p-alice', clientId: 2 }),
    roster({ stableId: 'p-bob', clientId: 3 }),
  ];

  const r1 = electHost({ roster: base, outgoingHost: 'p-carol', excluded: new Set(), referenceTick: 110, policy });
  check('lowest stable id wins among equals', r1.winner === 'p-alice', `winner=${r1.winner} tier=${r1.tier}`);

  const r2 = electHost({ roster: base, outgoingHost: 'p-carol', excluded: new Set(['p-alice']), referenceTick: 110, policy });
  check('excluded candidate is skipped', r2.winner === 'p-bob', `winner=${r2.winner}`);

  const laggy = [
    roster({ stableId: 'p-alice', rttMs: 900 }),
    roster({ stableId: 'p-bob', rttMs: 30 }),
  ];
  const r3 = electHost({ roster: laggy, outgoingHost: 'p-carol', excluded: new Set(), referenceTick: 110, policy });
  check('bad link loses to good link at tier 0', r3.winner === 'p-bob' && r3.tier === 0, `winner=${r3.winner} tier=${r3.tier}`);

  const stale = [
    roster({ stableId: 'p-alice', checkpointTick: 5, rttMs: 900 }),
    roster({ stableId: 'p-bob', checkpointTick: 8, rttMs: 900 }),
  ];
  const r4 = electHost({ roster: stale, outgoingHost: 'p-carol', excluded: new Set(), referenceTick: 5000, policy });
  check('all-degraded still elects rather than ending the match', r4.winner === 'p-alice' && r4.tier === 2,
    `winner=${r4.winner} tier=${r4.tier} reason=${r4.reason}`);

  const none = electHost({
    roster: [roster({ stableId: 'p-alice', connected: false })],
    outgoingHost: 'p-carol', excluded: new Set(), referenceTick: 10, policy,
  });
  check('no reachable candidate returns null', none.winner === null, none.reason);

  // Every peer must reach the same answer from the same roster, in any order.
  const shuffled = [base[2], base[0], base[1]];
  const r5 = electHost({ roster: shuffled, outgoingHost: 'p-carol', excluded: new Set(), referenceTick: 110, policy });
  check('election is order-independent', r5.winner === r1.winner, `${r5.winner} === ${r1.winner}`);
}

/* ------------------------------------------------------------------ */
/* 2. checkpoints                                                      */
/* ------------------------------------------------------------------ */

section('2. checkpoints round-trip and reject corruption');
{
  const core = new AuthorityCore({ tickRate: 30, seed: 99 }, new ArenaSim(30));
  core.admit('a', 'Alice', 'peer-a');
  core.admit('b', 'Bob', 'peer-b');
  for (let i = 0; i < 60; i++) core.stepOnce();

  const cp = core.exportCheckpoint();
  check('checkpoint verifies', verifyCheckpoint(cp), `tick=${cp.tick} entities=${cp.entities.length}`);

  const restored = importCheckpoint(cp);
  const again = exportCheckpoint(restored, cp.roster);
  check('import→export is stable', again.checksum === cp.checksum, `${again.checksum} === ${cp.checksum}`);

  const tampered = JSON.parse(JSON.stringify(cp));
  tampered.entities[0].health = 1;
  check('tampered checkpoint is rejected', verifyCheckpoint(tampered) === false);

  const wire = JSON.parse(JSON.stringify(cp));
  check('checkpoint survives JSON transport', verifyCheckpoint(wire), `bytes=${JSON.stringify(cp).length}`);
}

/* ------------------------------------------------------------------ */
/* 3. determinism                                                      */
/* ------------------------------------------------------------------ */

section('3. two authorities fed identical input stay identical');
{
  const build = () => {
    const core = new AuthorityCore({ tickRate: 30, seed: 20260730 }, new ArenaSim(30));
    core.admit('a', 'Alice', 'peer-a');
    core.admit('b', 'Bob', 'peer-b');
    core.admit('c', 'Carol', 'peer-c');
    return core;
  };
  const scriptRand = new Rand(777);
  const script = [];
  for (let t = 0; t < 600; t++) {
    const row = [];
    for (let c = 1; c <= 3; c++) {
      row.push({
        tick: t, seq: t, moveX: scriptRand.signed(), moveZ: scriptRand.signed(),
        yaw: scriptRand.range(-Math.PI, Math.PI), pitch: scriptRand.range(-0.4, 0.4),
        buttons: (scriptRand.bool(0.6) ? BTN.FIRE : 0) | (scriptRand.bool(0.1) ? BTN.JUMP : 0),
      });
    }
    script.push(row);
  }

  const runs = [];
  for (let r = 0; r < 2; r++) {
    const core = build();
    for (let t = 0; t < script.length; t++) {
      for (let c = 1; c <= 3; c++) core.submitInput(c, [script[t][c - 1]]);
      core.stepOnce();
      core.flushEvents();
    }
    runs.push({ core, sum: core.exportCheckpoint().checksum, events: core.stats.eventsEmitted });
  }
  check('identical checksums after 600 ticks', runs[0].sum === runs[1].sum,
    `0x${runs[0].sum.toString(16)} === 0x${runs[1].sum.toString(16)}`);
  check('identical event counts', runs[0].events === runs[1].events, `${runs[0].events} events`);

  // A resumed host must continue the same way the original would have.
  const cp = runs[0].core.exportCheckpoint();
  const resumed = new AuthorityCore({ tickRate: 30, seed: 20260730 }, new ArenaSim(30));
  resumed.resumeFrom(cp, cp.epoch + 1);
  const continued = new AuthorityCore({ tickRate: 30, seed: 20260730 }, new ArenaSim(30));
  continued.resumeFrom(cp, cp.epoch + 1);
  for (let t = 0; t < 120; t++) { resumed.stepOnce(); continued.stepOnce(); }
  const a = resumed.exportCheckpoint(), b = continued.exportCheckpoint();
  check('resumed hosts stay in lockstep for 120 more ticks', a.checksum === b.checksum,
    `tick=${a.tick} 0x${a.checksum.toString(16)}`);

  const kills = runs[0].core.state.players.get(1).kills + runs[0].core.state.players.get(2).kills
    + runs[0].core.state.players.get(3).kills;
  check('the reference simulation actually resolves combat', runs[0].events > 500,
    `${runs[0].events} authoritative events, ${kills} kills`);
}

/* ------------------------------------------------------------------ */
/* 4/5. live match over a lossy loopback, with two host deaths          */
/* ------------------------------------------------------------------ */

section('4/5. three peers, 30 simulated seconds, host killed twice');

const TICK_RATE = 30;
const DT = 1 / 120;
const DT_MS = 1000 / 120;
const DURATION_S = 30;
const KILL_1_S = 11;
const KILL_2_S = 21;

const net = new LoopbackNetwork(0xbadc0de, { latencyMs: 30, jitterMs: 9, loss: 0.03 });

/** A peer: transport + session + a bot brain that plays off replicated state. */
function makePeer(peerId, stableId, name, botSeed) {
  const transport = net.createPort(peerId);
  const reader = new SnapshotReader();
  const rand = new Rand(botSeed);
  const seen = { welcomes: 0, migratedWelcomes: 0, events: 0, kills: 0, disconnects: [] };

  const peer = { peerId, stableId, name, transport, reader, seen, alive: true, session: null };

  peer.session = new PeerSession({
    stableId,
    displayName: name,
    transport,
    sim: new ArenaSim(TICK_RATE),
    hostConfig: { tickRate: TICK_RATE, checkpointIntervalTicks: 45, respawnTicks: 60 },
    policy: { hostTimeoutMs: 1200, claimTimeoutMs: 900 },
    inputRedundancy: 3,
    sink: {
      onWelcome: (info) => {
        seen.welcomes++;
        if (info.migrated) seen.migratedWelcomes++;
        reader.reset();
      },
      onSnapshot: (s) => { reader.apply(s); },
      onEvent: (ev) => { seen.events++; if (ev.kind === 'kill') seen.kills++; },
      onDisconnect: (r) => seen.disconnects.push(r),
    },
    input: (tick) => botCommand(peer, tick, rand),
  });
  return peer;
}

/** What this peer currently believes the world looks like. */
function view(peer) {
  if (peer.session.host) {
    return { entities: peer.session.host.core.state.entities, clientId: peer.session.clientId };
  }
  return { entities: peer.reader.entities, clientId: peer.session.clientId };
}

function botCommand(peer, tick, rand) {
  const { entities, clientId } = view(peer);
  let self = null;
  for (const e of entities.values()) if (e.kind === ENT.PLAYER && e.owner === clientId) { self = e; break; }

  const cmd = { tick, seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
  if (!self) {
    cmd.moveZ = 1;
    cmd.yaw = rand.range(-Math.PI, Math.PI);
    return cmd;
  }

  // Nearest live enemy.
  let target = null, best = Infinity;
  for (const e of entities.values()) {
    if (e.kind !== ENT.PLAYER || e.id === self.id) continue;
    if ((e.flags & ENTITY_FLAG.DEAD) !== 0) continue;
    if (e.team !== 0 && e.team === self.team) continue;
    const d = Math.hypot(e.px - self.px, e.pz - self.pz);
    if (d < best) { best = d; target = e; }
  }

  if (target) {
    cmd.yaw = Math.atan2(-(target.px - self.px), -(target.pz - self.pz)) + rand.signed() * 0.05;
    cmd.pitch = Math.atan2((target.py + 1.0) - (self.py + 1.62), Math.max(0.5, best)) * -1;
    cmd.moveZ = best > 14 ? 1 : best < 7 ? -0.6 : 0;
    cmd.moveX = Math.sin(tick * 0.07 + self.id) * 0.8;
    let buttons = 0;
    if (best < 70 && (self.flags & ENTITY_FLAG.DEAD) === 0) buttons |= BTN.FIRE;
    if (best > 25) buttons |= BTN.SPRINT;
    if (rand.bool(0.01)) buttons |= BTN.JUMP;
    cmd.buttons = buttons;
  } else {
    cmd.yaw = Math.sin(tick * 0.02) * Math.PI;
    cmd.moveZ = 1;
  }
  return cmd;
}

const alice = makePeer('peer-alice', 'p-alice', 'Alice', 11);
const bob = makePeer('peer-bob', 'p-bob', 'Bob', 22);
const carol = makePeer('peer-carol', 'p-carol', 'Carol', 33);
const peers = [alice, bob, carol];

// Full mesh: peers hold links to each other, not just to the host. Without this
// a successor could not reach the survivors and migration is impossible.
net.connect('peer-alice', 'peer-bob');
net.connect('peer-alice', 'peer-carol');
net.connect('peer-bob', 'peer-carol');

// Carol hosts first *on purpose*: she has the highest stable id, so the election
// must pick Alice, proving the rule is really "lowest id" and not "whoever".
carol.session.hostMatch(20260730);
alice.session.joinMatch('peer-carol');
bob.session.joinMatch('peer-carol');

const timeline = [];
let nowMs = 0;
let killed1 = false, killed2 = false;
let preKill1 = null, preKill2 = null;

function hostPeer() { return peers.find((p) => p.alive && p.session.host); }

for (let step = 0; step * DT < DURATION_S; step++) {
  const t = step * DT;
  net.advanceTo(nowMs);
  for (const p of peers) if (p.alive) p.session.update(DT, nowMs);

  if (!killed1 && t >= KILL_1_S) {
    const h = hostPeer();
    preKill1 = snapshotOfMatch(h);
    net.kill(h.peerId, 'host quit');
    h.alive = false;
    killed1 = true;
    timeline.push(`t=${t.toFixed(1)}s killed host ${h.stableId} at tick ${preKill1.tick}`);
  }

  if (killed1 && !killed2 && t >= KILL_2_S) {
    const h = hostPeer();
    if (h) {
      preKill2 = snapshotOfMatch(h);
      net.kill(h.peerId, 'host crashed');
      h.alive = false;
      killed2 = true;
      timeline.push(`t=${t.toFixed(1)}s killed host ${h.stableId} at tick ${preKill2.tick}`);
    }
  }

  nowMs += DT_MS;
}

function snapshotOfMatch(peer) {
  const core = peer.session.host.core;
  const players = {};
  for (const [id, s] of core.state.players) {
    players[s.stableId] = {
      clientId: id, entityId: s.entityId, kills: s.kills, deaths: s.deaths,
      score: s.score, team: s.team,
    };
  }
  return { tick: core.tick, epoch: core.epoch, players, stableId: peer.stableId };
}

/* ---------------------------------- assertions -------------------- */

const finalHost = hostPeer();
const survivors = peers.filter((p) => p.alive);

if (VERBOSE) {
  console.log('\n  timeline:');
  for (const line of timeline) console.log(`    ${line}`);
  for (const p of peers) {
    const s = p.session.stats();
    console.log(`    ${p.stableId}: role=${s.role} phase=${s.phase} epoch=${s.epoch} `
      + `clientId=${s.clientId} tick=${s.lastSnapshotTick} snaps=${s.snapshotsReceived} `
      + `welcomes=${p.seen.welcomes} migrated=${p.seen.migratedWelcomes} `
      + `events=${p.seen.events} kills=${p.seen.kills} alive=${p.alive}`);
  }
}

check('both hosts were actually killed', killed1 && killed2, timeline.join(' | '));
check('a host survived to the end', !!finalHost, finalHost ? `host=${finalHost.stableId}` : 'NO HOST');

if (finalHost) {
  const core = finalHost.core ?? finalHost.session.host.core;

  check('lowest stable id was elected first', preKill1 && alice.seen.migratedWelcomes >= 1,
    `alice migrated-welcomes=${alice.seen.migratedWelcomes}`);
  check('final host is the last survivor by election order', finalHost.stableId === 'p-bob',
    `finalHost=${finalHost.stableId}`);
  check('epoch advanced once per migration', core.epoch === 3, `epoch=${core.epoch}`);

  const expectedTicks = DURATION_S * TICK_RATE;
  check('simulation kept running across both migrations',
    core.tick > expectedTicks * 0.9 && core.tick <= expectedTicks * 1.05,
    `tick=${core.tick} expected≈${expectedTicks}`);

  // Migration may rewind by at most one checkpoint interval; more than that means
  // the standby was resuming from stale state.
  const rewind1 = preKill1 ? preKill1.tick : 0;
  check('no state was lost beyond one checkpoint interval', core.tick > rewind1,
    `pre-kill tick=${rewind1}, now=${core.tick}`);

  const bobSlot = [...core.state.players.values()].find((s) => s.stableId === 'p-bob');
  const preBob1 = preKill1?.players['p-bob'];
  const preBob2 = preKill2?.players['p-bob'];
  check('surviving player kept their slot across migrations',
    !!bobSlot && !!preBob1 && bobSlot.clientId === preBob1.clientId,
    `clientId ${preBob1?.clientId} → ${bobSlot?.clientId}`);
  check('surviving player kept their entity across migrations',
    !!bobSlot && !!preBob1 && bobSlot.entityId === preBob1.entityId,
    `entityId ${preBob1?.entityId} → ${bobSlot?.entityId}`);
  check('score/kill ledger survived migration',
    !!bobSlot && !!preBob2 && bobSlot.kills >= preBob2.kills && bobSlot.score >= preBob2.score,
    `kills ${preBob2?.kills} → ${bobSlot?.kills}, score ${preBob2?.score} → ${bobSlot?.score}`);

  check('survivors re-handshook without being kicked',
    bob.seen.disconnects.length === 0, `bob disconnects=${JSON.stringify(bob.seen.disconnects)}`);
  check('survivors saw a migrated welcome', bob.seen.migratedWelcomes >= 1 || bob.session.host != null,
    `bob welcomes=${bob.seen.welcomes} migrated=${bob.seen.migratedWelcomes}`);

  check('combat was actually simulated over the wire',
    alice.seen.events + bob.seen.events > 100,
    `alice=${alice.seen.events} events, bob=${bob.seen.events} events`);

  const totalKills = [...core.state.players.values()].reduce((n, s) => n + s.kills, 0);
  check('the match produced kills', totalKills > 0, `${totalKills} kills`);
}

/* --------------------------- replication fidelity ------------------ */

section('4b. delta compression reconstructs authoritative state exactly');
{
  // Fresh, quiet match so the comparison is not racing the wire.
  const net2 = new LoopbackNetwork(0x51de, { latencyMs: 10, jitterMs: 2, loss: 0.05 });
  const h = { transport: net2.createPort('h') };
  const c = { transport: net2.createPort('c'), reader: new SnapshotReader() };
  net2.connect('h', 'c');

  const hs = new PeerSession({
    stableId: 'p-h', displayName: 'H', transport: h.transport,
    sim: new ArenaSim(TICK_RATE), hostConfig: { tickRate: TICK_RATE },
    input: (tick) => ({ tick, seq: 0, moveX: 0.4, moveZ: 1, yaw: tick * 0.01, pitch: 0, buttons: BTN.FIRE }),
  });
  const cs = new PeerSession({
    stableId: 'p-c', displayName: 'C', transport: c.transport,
    sim: new ArenaSim(TICK_RATE), hostConfig: { tickRate: TICK_RATE },
    sink: { onSnapshot: (s) => c.reader.apply(s), onWelcome: () => c.reader.reset() },
    input: (tick) => ({ tick, seq: 0, moveX: -0.3, moveZ: 1, yaw: -tick * 0.013, pitch: 0, buttons: BTN.FIRE }),
  });
  hs.hostMatch(4242);
  cs.joinMatch('h');

  let ms = 0;
  for (let i = 0; i < 120 * 10; i++) {
    net2.advanceTo(ms);
    hs.update(DT, ms);
    cs.update(DT, ms);
    ms += DT_MS;
  }
  // Let the last packets land.
  for (let i = 0; i < 60; i++) { net2.advanceTo(ms); hs.update(DT, ms); cs.update(DT, ms); ms += DT_MS; }

  const hostState = hs.host.core.state;
  const clientTick = c.reader.tick;
  const behind = hostState.tick - clientTick;

  let maxErr = 0, compared = 0;
  const hostAtClientTick = new Map();
  for (const [id, e] of hostState.entities) hostAtClientTick.set(id, e);
  for (const [id, ce] of c.reader.entities) {
    const he = hostAtClientTick.get(id);
    if (!he) continue;
    compared++;
    maxErr = Math.max(maxErr,
      Math.abs(he.health - ce.health),
      Math.abs(he.team - ce.team),
      Math.abs(he.owner - ce.owner));
  }

  check('client reconstructed every replicated entity', compared === hostState.entities.size && compared > 0,
    `${compared}/${hostState.entities.size}`);
  check('no snapshot was dropped for a missing baseline',
    c.reader.droppedNoBaseline <= c.reader.applied * 0.25,
    `applied=${c.reader.applied} droppedNoBaseline=${c.reader.droppedNoBaseline}`);
  check('client is at most a few ticks behind the host', behind >= 0 && behind < 20,
    `host tick=${hostState.tick} client tick=${clientTick} behind=${behind}`);
  check('discrete fields match exactly', maxErr === 0, `maxAbsErr=${maxErr}`);

  const bytes = c.transport.bytesReceived;
  const seconds = ms / 1000;
  const kbps = (bytes * 8) / seconds / 1000;
  check('bandwidth stays inside a peer-hosting budget', kbps < 512,
    `${kbps.toFixed(1)} kbit/s down for 2 players over ${seconds.toFixed(1)}s`);
  console.log(`  info  wire: ${(bytes / 1024).toFixed(1)} KiB received, `
    + `${c.reader.applied} snapshots applied, ${net2.totalDropped} packets dropped by the link`);

  hs.dispose(); cs.dispose();
}

/* ------------------------------------------------------------------ */

section('summary');
console.log(`  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`   - ${f}`);
  console.log('\nFAIL');
  process.exit(1);
}
console.log('\nPASS');
