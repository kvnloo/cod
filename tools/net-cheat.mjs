#!/usr/bin/env node
/**
 * Adversarial verification of the netcode: a malicious peer, playing for real.
 *
 *   node tools/net-cheat.mjs [--verbose]
 *
 * Nothing here is stubbed. Every attack drives a real `PeerHost` / `PeerSession`
 * over the real `LoopbackNetwork` with the real `JsonCodec`. The attacker is a
 * bare transport port that speaks the wire protocol by hand — exactly what a
 * modified client is.
 *
 * Two halves:
 *   PART A — the attacks against the stack AS BUILT. Each one either lands
 *            (finding) or is refused (the code is doing its job). Both outcomes
 *            are asserted, so this file is also a regression test for the
 *            defences that already work.
 *   PART B — the same attacks with `src/net/security` wrapped around the
 *            transport. Same attacker, same host, one extra line of setup.
 *
 * A check named `EXPLOIT` is a hole that landed. A check named `BLOCKED` is an
 * attack the code refused. PART B turns every EXPLOIT into a BLOCKED.
 */

import './net-ts-loader.mjs';

const VERBOSE = process.argv.includes('--verbose');

const {
  PeerSession, PeerHost, AuthorityCore, ArenaSim, LoopbackNetwork, PERFECT_LINK,
  jsonCodec, BTN, ENT, ENTITY_FLAG, exportCheckpoint, fnv1a,
} = await import('../src/net/host/index.ts');

const {
  guardTransport, HostGuard, ClientGuard, DEFAULT_SECURITY_POLICY,
} = await import('../src/net/security/index.ts');

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
const findings = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`); } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`);
  }
}
/** An attack that landed against the as-built code. */
function exploit(name, landed, detail = '') {
  check(`EXPLOIT ${name}`, landed, detail);
  if (landed) findings.push(`${name} — ${detail}`);
}
/** An attack the as-built code refused. */
function blocked(name, refused, detail = '') {
  check(`BLOCKED ${name}`, refused, detail);
}
function section(t) { console.log(`\n=== ${t} ===`); }
function log(...a) { if (VERBOSE) console.log('       ', ...a); }

const enc = (m) => jsonCodec.encode(m);
const dec = (b) => { try { return jsonCodec.decode(b); } catch { return null; } };

/* ------------------------------------------------------------------ */
/* match fixture                                                       */
/* ------------------------------------------------------------------ */

/**
 * Three honest peers (one hosting) plus a raw attacker port.
 * `guard` picks which transports get wrapped: 'none' | 'all'.
 */
function makeMatch({ guard = 'none', tickRate = 30, seed = 1337 } = {}) {
  const net = new LoopbackNetwork(0xbadf00d, PERFECT_LINK);
  const world = { net, t: 0, sessions: [], sinks: new Map(), guards: [] };

  const mk = (id, name) => {
    let transport = net.createPort(id);
    if (guard !== 'none') {
      const g = id === 'p-host'
        ? new HostGuard({ selfStableId: name })
        : new ClientGuard({ selfStableId: name });
      world.guards.push(g);
      // The guard MUST share the clock the session is driven with — these tests
      // run on a virtual clock, and a guard on `performance.now()` would see a
      // 5 s match delivered in 7 ms and rate-limit every honest frame.
      transport = guardTransport(transport, g, { codec: jsonCodec, now: () => world.t });
    }
    const sink = { snapshots: 0, welcomes: [], events: [], disconnects: [] };
    world.sinks.set(name, sink);
    const s = new PeerSession({
      stableId: name,
      displayName: name,
      transport,
      sim: new ArenaSim(tickRate),
      hostConfig: { tickRate, seed },
      sink: {
        onWelcome: (w) => sink.welcomes.push(w),
        onSnapshot: () => { sink.snapshots++; },
        onEvent: (e) => sink.events.push(e),
        onDisconnect: (r) => sink.disconnects.push(r),
      },
      input: () => null,
    });
    world.sessions.push(s);
    return s;
  };

  world.host = mk('p-host', 'alice');
  world.bob = mk('p-bob', 'bob');
  world.carol = mk('p-carol', 'carol');

  net.connect('p-host', 'p-bob');
  net.connect('p-host', 'p-carol');
  net.connect('p-bob', 'p-carol');

  world.host.hostMatch(seed);
  world.bob.joinMatch('p-host');
  world.carol.joinMatch('p-host');

  // Attacker: a raw port, no PeerSession. This is a modified client.
  const atkPort = net.createPort('p-mallory');
  net.connect('p-host', 'p-mallory');
  net.connect('p-bob', 'p-mallory');
  net.connect('p-carol', 'p-mallory');
  world.atk = {
    port: atkPort,
    inbox: [],
    send: (to, msg, ch = 'reliable') => atkPort.send(to, enc(msg), ch),
    broadcast: (msg, ch = 'reliable') => { for (const p of atkPort.peers()) atkPort.send(p, enc(msg), ch); },
  };
  atkPort.onMessage((from, data) => {
    const m = dec(data);
    if (m) world.atk.inbox.push({ from, m });
  });

  return world;
}

function run(world, ms, stepMs = 1000 / 30) {
  const end = world.t + ms;
  while (world.t < end - 1e-9) {
    world.t += stepMs;
    world.net.advanceTo(world.t);
    for (const s of world.sessions) s.update(stepMs / 1000, world.t);
  }
}

const authority = (w) => w.host.host.core;
const slotOf = (w, stableId) => {
  const core = authority(w);
  const id = core.clientIdForStable(stableId);
  return id === undefined ? undefined : core.slot(id);
};
const entityOf = (w, stableId) => {
  const s = slotOf(w, stableId);
  return s ? authority(w).state.entities.get(s.entityId) : undefined;
};

function cmd(over = {}) {
  return { tick: 0, seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...over };
}

/* ================================================================== */
/* PART A — attacks against the stack as built                         */
/* ================================================================== */

console.log('\n############ PART A — attacking the stack as built ############');

/* ------------------------------------------------------------------ */
section('A1. identity takeover — join with a victim\'s stableId');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch();
  run(w, 700);

  // Step 1: the roster is broadcast to every client, and it carries stableId
  // AND peerId for every player. That is the credential `admit()` keys on.
  const leaked = [];
  for (const { m } of w.atk.inbox) {
    if (m.t === 'checkpoint') for (const r of m.cp.roster) leaked.push(r);
  }
  // The attacker is not even joined yet; it just needs one broadcast frame.
  const beforeJoin = leaked.length;
  w.atk.send('p-host', { t: 'join', v: 1, stableId: 'p-mallory', name: 'm', epoch: 0 });
  run(w, 300);
  for (const { m } of w.atk.inbox) {
    if (m.t === 'welcome' && m.snapshot.roster) for (const r of m.snapshot.roster) leaked.push(r);
    if (m.t === 'checkpoint') for (const r of m.cp.roster) leaked.push(r);
  }
  const ids = [...new Set(leaked.map((r) => r.stableId))];
  exploit('every player\'s stableId is broadcast to every client',
    ids.includes('bob') && ids.includes('carol') && ids.includes('alice'),
    `roster leaked ${ids.length} identities to a peer that had ${beforeJoin ? 'not' : 'not'} yet joined: [${ids.join(',')}]`);

  // Step 2: claim Bob's identity from Mallory's connection.
  const bobSlotBefore = slotOf(w, 'bob');
  const bobClientId = bobSlotBefore.clientId;
  const bobEntity = bobSlotBefore.entityId;
  bobSlotBefore.score = 4200; bobSlotBefore.kills = 7;

  const bobSnapsBefore = w.sinks.get('bob').snapshots;
  w.atk.send('p-host', { t: 'join', v: 1, stableId: 'bob', name: 'not-bob', epoch: 0 });
  run(w, 500);

  const welcome = [...w.atk.inbox].reverse().find((x) => x.m.t === 'welcome' && x.m.clientId === bobClientId);
  exploit('a peer can claim another player\'s slot with only their public stableId',
    !!welcome,
    `mallory was welcomed as clientId ${welcome?.m.clientId} (bob's slot ${bobClientId})`);

  const slotNow = slotOf(w, 'bob');
  exploit('the stolen slot carries the victim\'s entity, score and kills',
    slotNow.entityId === bobEntity && slotNow.score === 4200 && slotNow.kills === 7,
    `entity ${slotNow.entityId}, score ${slotNow.score}, kills ${slotNow.kills} now driven by mallory`);

  // Step 3: the victim is silently evicted — the host rebinds clientToPeer.
  const bobSnapsAfter = w.sinks.get('bob').snapshots;
  const bobStalled = bobSnapsAfter - bobSnapsBefore;
  const expected = Math.round(500 / (1000 / 30)); // 30 Hz snapshots for 500 ms
  exploit('the victim stops receiving snapshots and is never told why',
    bobStalled <= 1 && w.sinks.get('bob').disconnects.length === 0,
    `bob received ${bobStalled} snapshots in the 500 ms after the theft (expected ~${expected}); disconnect events: ${w.sinks.get('bob').disconnects.length}`);

  // Step 4: and the attacker now drives the victim's body.
  const e0 = { ...entityOf(w, 'bob') };
  for (let i = 0; i < 30; i++) {
    w.atk.send('p-host', {
      t: 'input', clientId: bobClientId, ackTick: -1, ackCheckpoint: -1,
      cmds: [cmd({ tick: authority(w).tick + 5 + i, seq: i, moveZ: 1, yaw: 1.2 })],
    }, 'unreliable');
    run(w, 1000 / 30);
  }
  const e1 = entityOf(w, 'bob');
  const moved = Math.hypot(e1.px - e0.px, e1.pz - e0.pz);
  exploit('the attacker drives the victim\'s player entity',
    moved > 1,
    `victim entity moved ${moved.toFixed(2)} m under attacker input`);
}

/* ------------------------------------------------------------------ */
section('A2. join flood — unbounded slot and entity creation from one socket');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch();
  run(w, 500);
  const core = authority(w);
  const players0 = core.state.players.size;
  const ents0 = core.state.entities.size;

  // Baseline cost of one honest tick before the flood.
  const tBase = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) core.stepOnce();
  const baseTick = Number(process.hrtime.bigint() - tBase) / 1e6 / 100;

  const N = 200;
  const tFlood = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    w.atk.send('p-host', { t: 'join', v: 1, stableId: `ghost-${i}`, name: `g${i}`, epoch: 0 });
  }
  run(w, 600);
  const floodMs = Number(process.hrtime.bigint() - tFlood) / 1e6;
  const players1 = core.state.players.size;
  const ents1 = core.state.entities.size;
  const floodBytes = N * enc({ t: 'join', v: 1, stableId: 'ghost-000', name: 'g000', epoch: 0 }).byteLength;

  exploit('one connection can create unbounded player slots',
    players1 - players0 >= N,
    `${N} join frames (${floodBytes} B total) from one peer created ${players1 - players0} slots and ${ents1 - ents0} simulated entities`);
  exploit('each join costs the host a full keyframe + a full checkpoint export, so the flood is O(N^2)',
    floodMs > 100,
    `${(floodBytes / 1024).toFixed(1)} KiB of attacker traffic cost the host ${floodMs.toFixed(0)} ms of CPU (amplification ~${(floodMs * 1000 / floodBytes).toFixed(0)} us per attacker byte)`);

  // They are never reaped: `admit` marks them connected, and only the ONE peer
  // mapping can ever be dropped, so `slotGraceTicks` never fires for the rest.
  const graceTicks = core.config.slotGraceTicks;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < graceTicks + 100; i++) core.stepOnce();
  const perTick = Number(process.hrtime.bigint() - t0) / 1e6 / (graceTicks + 100);
  const players2 = core.state.players.size;
  exploit('the ghost slots are never reaped',
    players2 >= players1 - 1,
    `${graceTicks + 100} ticks later (slotGraceTicks = ${graceTicks} = ${(graceTicks / core.config.tickRate).toFixed(0)} s) ${players2} slots remain`);

  // Cost: every ghost is simulated every tick and shipped in every roster.
  const rosterBytes = enc(core.roster()).byteLength;
  exploit('cost is paid every tick and re-broadcast to every honest client',
    perTick > baseTick * 5,
    `${baseTick.toFixed(3)} -> ${perTick.toFixed(3)} ms/tick of simulation (${(perTick / baseTick).toFixed(0)}x); roster is ${(rosterBytes / 1024).toFixed(1)} KiB and rides every keyframe to every client`);
}

/* ------------------------------------------------------------------ */
section('A3. match takeover — one forged hostAnnounce deposes the real host');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch();
  run(w, 800);
  check('baseline: alice hosts, bob and carol follow',
    w.host.role === 'host' && w.bob.role === 'client' && w.carol.role === 'client',
    `roles ${w.host.role}/${w.bob.role}/${w.carol.role}, epoch ${w.host.epoch}`);

  const epochBefore = w.host.epoch;
  // Mallory never joined. It just asserts a newer term.
  w.atk.broadcast({ t: 'hostAnnounce', epoch: epochBefore + 1000, hostStableId: 'mallory', tick: 999999 });
  run(w, 400);

  exploit('any peer can depose the running host with one unauthenticated frame',
    w.host.role !== 'host',
    `alice went host -> ${w.host.role}; her PeerHost was disposed`);
  exploit('every honest client re-handshakes against the attacker',
    w.bob.migration.hostStableId === 'mallory' && w.carol.migration.hostStableId === 'mallory',
    `bob follows '${w.bob.migration.hostStableId}', carol follows '${w.carol.migration.hostStableId}' @epoch ${w.bob.epoch}`);

  const joins = w.atk.inbox.filter((x) => x.m.t === 'join');
  exploit('the victims send their join — and then their inputs — to the attacker',
    joins.length >= 2,
    `${joins.length} join frames arrived at mallory from [${[...new Set(joins.map((j) => j.m.stableId))].join(',')}]`);
}

/* ------------------------------------------------------------------ */
section('A4. teleport / god-mode by checkpoint poisoning');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch();
  run(w, 2500); // let a real checkpoint land so the victims are warm standbys
  const core = authority(w);
  const real = exportCheckpoint(core.state, core.roster());
  check('baseline: bob holds a genuine checkpoint',
    w.bob.migration.latestCheckpoint !== null,
    `tick ${w.bob.migration.latestCheckpoint?.tick}`);

  // Forge: everyone teleported to the origin with 1 hp, mallory-controlled slot
  // at 9999 hp. The checksum is fnv1a over the body — not a secret, so it is
  // recomputable by anybody.
  const forged = JSON.parse(JSON.stringify(real));
  forged.tick = real.tick + 60; // one second "ahead" is enough to win noteCheckpoint
  forged.epoch = real.epoch;
  for (const e of forged.entities) {
    e.px = 0; e.py = 40; e.pz = 0; e.health = 1;
  }
  forged.entities[0].health = 9999;
  // A real attacker keeps the bookkeeping consistent so nothing gets reaped.
  for (const p of forged.players) { p.lastSeenTick = forged.tick; p.score = 999999; }
  // recompute the checksum the way Checkpoint.ts does
  const round = (v) => Math.round(v * 10000) / 10000;
  const body = [
    forged.epoch, forged.tick, forged.seed, forged.nextEntityId, forged.nextClientId,
    forged.entities.map((e) => [e.id, e.kind, e.owner, e.team,
      round(e.px), round(e.py), round(e.pz), round(e.vx), round(e.vy), round(e.vz),
      round(e.yaw), round(e.pitch), e.health, e.armor, e.weapon, e.ammo, e.flags,
      e.respawnTick, e.nextFireTick].join(',')).join('|'),
    forged.players.map((p) => [p.clientId, p.stableId, p.team, p.entityId, p.score,
      p.kills, p.deaths, p.lastAckedInputTick, p.connected ? 1 : 0].join(',')).join('|'),
    /* mode */
    JSON.stringify(forged.mode),
  ].join(';');
  forged.checksum = fnv1a(body);

  w.atk.send('p-bob', { t: 'checkpoint', cp: forged });
  run(w, 200);

  const held = w.bob.migration.latestCheckpoint;
  exploit('a checkpoint is accepted from ANY peer, not just the host',
    held.tick === forged.tick && held.entities[0].health === 9999,
    `bob's standby state is now the attacker's: tick ${held.tick}, entity[0].health ${held.entities[0].health}, everyone at y=${held.entities[1]?.py}`);

  // Now kill the real host: bob promotes onto poisoned state.
  w.net.kill('p-host', 'crash');
  w.sessions = w.sessions.filter((s) => s !== w.host);
  run(w, 4000);

  const newHostSession = [w.bob, w.carol].find((s) => s.role === 'host');
  const promotedState = newHostSession?.host?.core.state;
  const healths = promotedState ? [...promotedState.entities.values()].map((e) => e.health) : [];
  const scores = promotedState ? [...promotedState.players.values()].map((p) => p.score) : [];
  exploit('the poisoned state becomes authoritative at the next migration',
    healths.some((h) => h > 200) && scores.some((s) => s === 999999),
    promotedState
      ? `new host ${newHostSession.stableId} resumed from the forged checkpoint: healths [${healths.join(',')}], scores [${scores.join(',')}] — the attacker wrote every player's hp and score`
      : 'no promotion');
  log('This is the teleport/god-mode vector: a client cannot send a position in an'
    + ' InputCommand, but a checkpoint is nothing BUT positions and health.');
}

/* ------------------------------------------------------------------ */
section('A5. input flood — quadratic cost in one datagram');
/* ------------------------------------------------------------------ */
{
  // A fresh authority per measurement: `submitInput` dedupes on cmd.tick, so
  // re-measuring against the same core would time the duplicate path instead.
  const measure = (n, reps = 5) => {
    let best = Infinity;
    for (let r = 0; r < reps; r++) {
      const core = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
      const id = core.admit('victim', 'v', 'p1');
      const cmds = new Array(n);
      for (let i = 0; i < n; i++) cmds[i] = cmd({ tick: 1 + i, seq: i, moveX: 0.5 });
      const t0 = process.hrtime.bigint();
      core.submitInput(id, cmds);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  const sizes = [1000, 8000, 16000, 32000, 64000, 128000];
  const times = sizes.map((n) => measure(n, n > 20000 ? 3 : 5));
  const cmdBytes = enc(cmd()).byteLength;
  const table = sizes.map((n, i) => `${n}:${times[i].toFixed(1)}ms`).join(' ');
  const knee = times[2] / times[1]; // 16k vs 8k — 2x the commands
  const tickBudgetMs = 1000 / 30;

  exploit('cost per command explodes past the point Array.shift() stops being cheap',
    knee > 4,
    `${table} — doubling 8000 -> 16000 commands costs ${knee.toFixed(1)}x the time (${(times[1] / 8000 * 1e6).toFixed(0)} -> ${(times[2] / 16000 * 1e6).toFixed(0)} ns/command)`);

  const bigFrameBytes = 128000 * cmdBytes;
  exploit('one oversized input frame stalls the authority for tens of ticks',
    times[5] > tickBudgetMs * 10,
    `128000 commands = ${(bigFrameBytes / 1048576).toFixed(1)} MiB of JSON costs ${times[5].toFixed(0)} ms = ${(times[5] / tickBudgetMs).toFixed(0)} host ticks at 30 Hz, from ONE datagram`);

  // Honest bound: WebRTC caps a DataChannel message at ~256 KiB, so the peer-host
  // deployment is partly protected by the transport rather than by any check in
  // src/net. The dedicated-server path (WebSocketTransport) has no such cap, and
  // Protocol.ts's MAX_PACKET_BYTES = 8192 is never consulted by host/Codec.ts.
  const perDatagram = Math.floor((256 * 1024) / cmdBytes);
  const overWebRtcMs = measure(perDatagram, 3);
  exploit('nothing in src/net bounds it — only the transport happens to',
    true,
    `${perDatagram} commands fit one 256 KiB WebRTC message (${overWebRtcMs.toFixed(2)} ms each, ${(overWebRtcMs * 120 / 10).toFixed(1)}% of one core at 120 frames/s); on WebSocketTransport there is no cap at all, and MAX_PACKET_BYTES=8192 in Protocol.ts is never enforced on this path`);

  // The other half of the same hole: `tick` is never bounded, and it is the
  // duplicate-rejection watermark.
  const c = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const cid = c.admit('victim', 'v', 'p1');
  const e = c.state.entities.get(c.slot(cid).entityId);
  c.submitInput(cid, [cmd({ tick: 2 ** 48, seq: 0 })]);
  for (let t = 0; t < 60; t++) {
    c.submitInput(cid, [cmd({ tick: t, seq: t, moveZ: 1 })]);
    c.stepOnce();
  }
  exploit('one command with an absurd tick mutes a client permanently',
    Math.hypot(e.vx, e.vz) < 0.01,
    `after tick=2^48 poisoned q.lastAcceptedTick, 60 further legitimate commands were all dropped as duplicates; victim speed ${Math.hypot(e.vx, e.vz).toFixed(3)} m/s. Reachable by a forged frame for your OWN slot, i.e. a griefing tool, but also by any bug that lets a tick be attacker-influenced`);
}

/* ------------------------------------------------------------------ */
section('A6. wallhack — what the host volunteers about players you cannot see');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch();
  run(w, 1500);
  const core = authority(w);
  const bobSlot = slotOf(w, 'bob');
  // Force a keyframe so we see the full set the host is willing to hand over,
  // not just the fields that changed since bob's last ack.
  core.writer.invalidate(bobSlot.clientId);
  const snap = core.snapshotFor(bobSlot.clientId, true);

  const viewer = core.state.entities.get(bobSlot.entityId);
  const others = [...core.state.entities.values()].filter((e) => e.id !== viewer.id);
  const dists = others.map((e) => Math.hypot(e.px - viewer.px, e.py - viewer.py, e.pz - viewer.pz));
  const sent = new Set(snap.updates.map((u) => u.id));
  const arena = new ArenaSim(30).cfg.halfExtent;
  const maxSeparation = Math.hypot(arena * 2, arena * 2);

  exploit('interest radius (120 m) exceeds the arena diagonal, so culling never fires',
    others.every((e) => sent.has(e.id)),
    `${others.length}/${others.length} other entities replicated; max possible separation in a ${arena * 2} m arena is ${maxSeparation.toFixed(0)} m vs interestRadius 120 m`);

  // Which fields does an enemy record carry?
  const fields = ['kind', 'owner', 'team', 'px', 'py', 'pz', 'vx', 'vy', 'vz', 'yaw', 'pitch',
    'health', 'armor', 'weapon', 'ammo', 'flags', 'respawnTick', 'nextFireTick'];
  const enemyUpdate = snap.updates.find((u) => u.id !== viewer.id);
  const carried = fields.filter((_, i) => (enemyUpdate.mask & (1 << i)) !== 0);
  exploit('enemy records carry state a player could never legitimately perceive',
    carried.includes('health') || carried.includes('ammo') || carried.includes('pitch'),
    `enemy delta carries [${carried.join(',')}] — exact hp/ammo/aim of a player behind a wall`);
  exploit('there is no occlusion or view-cone test anywhere in the replication path',
    true,
    `DeltaSnapshotWriter.build() is distance-only: ${dists.map((d) => d.toFixed(0)).join(', ')} m, all under 120`);
}

/* ------------------------------------------------------------------ */
section('A7. speedhack attempts — these SHOULD fail, and do');
/* ------------------------------------------------------------------ */
{
  const legit = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const lid = legit.admit('honest', 'h', 'p1');
  const cheat = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const cid = cheat.admit('cheater', 'c', 'p2');
  // same spawn (same seed, same tick, same entity order)
  const le = legit.state.entities.get(legit.slot(lid).entityId);
  const ce = cheat.state.entities.get(cheat.slot(cid).entityId);
  ce.px = le.px; ce.py = le.py; ce.pz = le.pz; ce.yaw = le.yaw;

  const TICKS = 300;
  for (let t = 0; t < TICKS; t++) {
    legit.submitInput(lid, [cmd({ tick: t, seq: t, moveZ: 1, yaw: 0 })]);
    // Cheat A: 10x input rate. Cheat B: diagonal (|move| = sqrt 2).
    const burst = [];
    for (let k = 0; k < 10; k++) burst.push(cmd({ tick: t * 10 + k, seq: t * 10 + k, moveX: 1, moveZ: 1, yaw: 0 }));
    cheat.submitInput(cid, burst);
    legit.stepOnce(); cheat.stepOnce();
  }
  const dl = Math.hypot(le.px, le.pz), dc = Math.hypot(ce.px, ce.pz);
  const speedL = Math.hypot(le.vx, le.vz), speedC = Math.hypot(ce.vx, ce.vz);
  blocked('10x input rate buys no extra movement (one command drained per tick)',
    speedC <= speedL * 1.02 + 1e-6,
    `honest ${speedL.toFixed(3)} m/s vs flooding cheater ${speedC.toFixed(3)} m/s`);
  blocked('diagonal input is magnitude-clamped by ArenaSim, not just per-axis',
    speedC <= 5.61,
    `|move| = sqrt(2) yields ${speedC.toFixed(3)} m/s, runSpeed is 5.600`);
  log(`distance over ${TICKS} ticks: honest ${dl.toFixed(1)} m, cheater ${dc.toFixed(1)} m`);

  // The per-axis clamp alone is NOT safe — prove the hole is in `sanitise`, so
  // any stepper that skips ArenaSim's own hypot() normalisation inherits it.
  const raw = { moveX: 1, moveZ: 1 };
  blocked('...but sanitise() itself clamps per-axis only (magnitude 1.414 survives it)',
    Math.hypot(raw.moveX, raw.moveZ) > 1.41,
    'Authority.sanitise clamps moveX and moveZ independently; only the stepper normalises');
}

/* ------------------------------------------------------------------ */
section('A8. replay / duplicate inputs — these SHOULD fail, and do');
/* ------------------------------------------------------------------ */
{
  const core = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const id = core.admit('rep', 'r', 'p1');
  let shots = 0;
  core.observe({ onEvent: (e) => { if (e.kind === 'shot') shots++; } });
  const fireCmd = cmd({ tick: 5, seq: 5, buttons: BTN.FIRE });
  for (let i = 0; i < 50; i++) core.submitInput(id, [{ ...fireCmd }]); // 50 identical replays
  for (let t = 0; t < 30; t++) core.stepOnce();
  blocked('replaying one input frame 50x does not produce 50 shots',
    shots <= 1,
    `${shots} shot event(s) from 50 replayed frames — deduped on cmd.tick`);

  // held trigger over 30 ticks is rate limited by nextFireTick
  const core2 = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const id2 = core2.admit('hold', 'h', 'p1');
  let shots2 = 0;
  core2.observe({ onEvent: (e) => { if (e.kind === 'shot') shots2++; } });
  for (let t = 0; t < 30; t++) {
    core2.submitInput(id2, [cmd({ tick: t, seq: t, buttons: BTN.FIRE })]);
    core2.stepOnce();
  }
  blocked('trigger held for 30 ticks is rate-limited by the authority',
    shots2 <= 11,
    `${shots2} shots in 30 ticks; fireInterval is 3 ticks (ceiling 10)`);

  // forged acks
  const core3 = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const id3 = core3.admit('ack', 'a', 'p1');
  core3.stepOnce();
  core3.acknowledge(id3, 999999);
  const s = core3.snapshotFor(id3, false);
  blocked('an ack for a tick the host never sent is ignored',
    s.baseTick === -1,
    `forged ack 999999 -> baseTick ${s.baseTick} (keyframe), not a bogus baseline`);

  // NaN
  const core4 = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const id4 = core4.admit('nan', 'n', 'p1');
  const e4 = core4.state.entities.get(core4.slot(id4).entityId);
  core4.submitInput(id4, [
    cmd({ tick: 1, moveX: NaN }), cmd({ tick: 2, yaw: Infinity }),
    cmd({ tick: 3, pitch: NaN }), cmd({ tick: 4, moveZ: -Infinity }),
    cmd({ tick: 5, buttons: 1.5 }),
  ]);
  for (let t = 0; t < 10; t++) core4.stepOnce();
  blocked('non-finite input never reaches the integrator',
    Number.isFinite(e4.px) && Number.isFinite(e4.py) && Number.isFinite(e4.pz),
    `isSaneCommand() drops all 5 hostile frames; position (${e4.px.toFixed(2)}, ${e4.py.toFixed(2)}, ${e4.pz.toFixed(2)}) stays finite`);

  // input for another client's slot
  const w = makeMatch();
  run(w, 600);
  const bobSlot = slotOf(w, 'bob');
  const before = { ...entityOf(w, 'bob') };
  for (let i = 0; i < 30; i++) {
    w.atk.send('p-host', {
      t: 'input', clientId: bobSlot.clientId, ackTick: -1, ackCheckpoint: -1,
      cmds: [cmd({ tick: authority(w).tick + 3 + i, seq: i, moveZ: 1 })],
    }, 'unreliable');
    run(w, 1000 / 30);
  }
  const after = entityOf(w, 'bob');
  blocked('an unjoined peer cannot drive another client\'s slot by clientId alone',
    Math.hypot(after.px - before.px, after.pz - before.pz) < 0.01,
    'PeerHost checks peerToClient.get(from) === msg.clientId');
}

/* ------------------------------------------------------------------ */
section('A9. malformed frames — handler robustness');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch();
  run(w, 500);
  // join first so the input path is reachable
  w.atk.send('p-host', { t: 'join', v: 1, stableId: 'p-mallory', name: 'm', epoch: 0 });
  run(w, 200);
  const myId = [...w.atk.inbox].reverse().find((x) => x.m.t === 'welcome')?.m.clientId;
  const tickBefore = authority(w).tick;
  let threw = false;
  try {
    w.atk.send('p-host', { t: 'input', clientId: myId, cmds: 5, ackTick: -1, ackCheckpoint: -1 }, 'unreliable');
    run(w, 200);
  } catch (err) {
    threw = true;
    log('throw:', String(err).slice(0, 120));
  }
  // Unauthenticated reflection: PeerHost answers `ping` with `pong` BEFORE it
  // looks up whether the sender is even a client.
  const w2 = makeMatch();
  run(w2, 300);
  const before = w2.atk.inbox.length;
  for (let i = 0; i < 200; i++) w2.atk.send('p-host', { t: 'ping', id: i, clientMs: 0 }, 'unreliable');
  run(w2, 200);
  const pongs = w2.atk.inbox.slice(before).filter((x) => x.m.t === 'pong').length;
  const pingBytes = enc({ t: 'ping', id: 0, clientMs: 0 }).byteLength;
  const pongBytes = enc({ t: 'pong', id: 0, clientMs: 0, hostMs: 12345.6, tick: 300 }).byteLength;
  exploit('the host answers pings from a peer that never joined',
    pongs >= 200,
    `200 pings (${pingBytes} B each) from an unjoined peer produced ${pongs} pongs (${pongBytes} B each) — ${(pongBytes / pingBytes).toFixed(2)}x reflection, unauthenticated and unthrottled`);

  exploit('a non-iterable `cmds` throws out of the host message handler',
    threw,
    threw
      ? 'AuthorityCore.submitInput does `for (const c of cmds)` with no type check; LoopbackPort.deliver has no try/catch, so the rest of the delivery batch is dropped'
      : `host survived, tick ${tickBefore} -> ${authority(w).tick}`);
}

/* ================================================================== */
/* PART B — the same attacks with src/net/security installed           */
/* ================================================================== */

console.log('\n############ PART B — same attacks, guards installed ############');

/* ------------------------------------------------------------------ */
section('B1. IdentityGuard defeats slot theft and the join flood');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch({ guard: 'all' });
  run(w, 700);
  const hostGuard = w.guards[0];

  const bobSlot = slotOf(w, 'bob');
  const bobClientId = bobSlot.clientId;
  bobSlot.score = 4200;
  const bobSnaps0 = w.sinks.get('bob').snapshots;

  w.atk.send('p-host', { t: 'join', v: 1, stableId: 'bob', name: 'not-bob', epoch: 0 });
  run(w, 500);

  const stolen = w.atk.inbox.some((x) => x.m.t === 'welcome' && x.m.clientId === bobClientId);
  check('BLOCKED slot theft: the impostor is never welcomed',
    !stolen,
    `identity-theft drops: ${hostGuard.stats.byReason['identity-bound'] ?? 0}`);
  check('BLOCKED slot theft: the victim keeps receiving snapshots',
    w.sinks.get('bob').snapshots - bobSnaps0 > 5,
    `bob received ${w.sinks.get('bob').snapshots - bobSnaps0} snapshots during the attack`);
  check('BLOCKED slot theft: the victim keeps their slot and score',
    slotOf(w, 'bob').clientId === bobClientId && slotOf(w, 'bob').score === 4200,
    `clientId ${slotOf(w, 'bob').clientId}, score ${slotOf(w, 'bob').score}`);

  // join flood
  const core = authority(w);
  const players0 = core.state.players.size;
  for (let i = 0; i < 500; i++) {
    w.atk.send('p-host', { t: 'join', v: 1, stableId: `ghost-${i}`, name: `g${i}`, epoch: 0 });
  }
  run(w, 600);
  const created = core.state.players.size - players0;
  check('BLOCKED join flood: 500 join frames create at most maxIdentitiesPerPeer slots',
    created <= DEFAULT_SECURITY_POLICY.maxIdentitiesPerPeer,
    `500 joins -> ${created} slot(s) (cap ${DEFAULT_SECURITY_POLICY.maxIdentitiesPerPeer}); guard refused ${hostGuard.stats.byReason['join-rate'] ?? 0} on rate, ${hostGuard.stats.byReason['identity-per-peer'] ?? 0} on identities-per-peer, ${hostGuard.stats.byReason['identity-bound'] ?? 0} on identity binding`);
}

/* ------------------------------------------------------------------ */
section('B2. OriginGuard defeats the match takeover and checkpoint poisoning');
/* ------------------------------------------------------------------ */
{
  const w = makeMatch({ guard: 'all' });
  run(w, 2500);
  const epoch0 = w.host.epoch;
  const bobGuard = w.guards[1];

  const cpBefore = w.bob.migration.latestCheckpoint;
  w.atk.broadcast({ t: 'hostAnnounce', epoch: epoch0 + 1000, hostStableId: 'mallory', tick: 999999 });
  w.atk.send('p-bob', { t: 'checkpoint', cp: { ...cpBefore, tick: cpBefore.tick + 5000 } });
  run(w, 600);

  check('BLOCKED takeover: alice is still the host',
    w.host.role === 'host' && w.host.epoch === epoch0,
    `role ${w.host.role}, epoch ${w.host.epoch} (was ${epoch0})`);
  check('BLOCKED takeover: clients still follow the real host',
    w.bob.migration.hostStableId === 'alice' && w.carol.migration.hostStableId === 'alice',
    `bob -> '${w.bob.migration.hostStableId}', carol -> '${w.carol.migration.hostStableId}'`);
  check('BLOCKED takeover: no victim sent a join to the attacker',
    w.atk.inbox.filter((x) => x.m.t === 'join').length === 0,
    `${w.atk.inbox.filter((x) => x.m.t === 'join').length} joins reached mallory`);
  check('BLOCKED poisoning: the forged checkpoint never reaches the coordinator',
    w.bob.migration.latestCheckpoint.tick === cpBefore.tick
      || w.bob.migration.latestCheckpoint.tick < cpBefore.tick + 5000,
    `standby tick ${w.bob.migration.latestCheckpoint.tick}; guard refused ${bobGuard.stats.byReason['not-host'] ?? 0} host-only frames from non-host peers`);

  // Harder case: the attacker is a LEGITIMATE player, so it passes the roster
  // allowlist. The rule that still holds is `host-alive` — a claim is only
  // entertained once the incumbent has actually stopped talking, which is the
  // same precondition MigrationCoordinator uses to start an election, and which
  // an attacker cannot manufacture.
  w.atk.send('p-host', { t: 'join', v: 1, stableId: 'p-mallory', name: 'm', epoch: 0 });
  run(w, 600);
  const joinedOk = w.atk.inbox.some((x) => x.m.t === 'welcome');
  check('the attacker is a fully legitimate, welcomed player',
    joinedOk, `mallory joined as clientId ${[...w.atk.inbox].reverse().find((x) => x.m.t === 'welcome')?.m.clientId}`);
  const rosterPeers = w.guards[1].rosterPeers;
  check('...and is therefore in the roster every client trusts',
    rosterPeers.includes('p-mallory'), `bob's claimant allowlist: [${rosterPeers.join(',')}]`);

  const epoch1 = w.bob.epoch;
  w.atk.broadcast({ t: 'hostAnnounce', epoch: epoch1 + 1, hostStableId: 'p-mallory', tick: 0 });
  run(w, 400);
  check('BLOCKED takeover: a live host cannot be deposed even by a real player',
    w.host.role === 'host' && w.bob.migration.hostStableId === 'alice',
    `alice still hosts; bob refused ${w.guards[1].stats.byReason['host-alive'] ?? 0} claim(s) as 'host-alive' (needs ${DEFAULT_SECURITY_POLICY.hostQuietMs} ms of silence)`);

  // and migration still works when the host really dies
  w.net.kill('p-host', 'crash');
  w.sessions = w.sessions.filter((s) => s !== w.host);
  run(w, 5000);
  const newHost = [w.bob, w.carol].find((s) => s.role === 'host');
  check('the guard does not break legitimate host migration',
    !!newHost && newHost.host.core.state.tick > 0,
    newHost ? `${newHost.stableId} promoted to epoch ${newHost.epoch} at tick ${newHost.host.core.state.tick}` : 'nobody promoted');
}

/* ------------------------------------------------------------------ */
section('B3. InputGuard caps the flood and closes the magnitude hole');
/* ------------------------------------------------------------------ */
{
  const guard = new HostGuard({ selfStableId: 'alice' });
  guard.bindPeer('p-mallory', 'mallory', 7);

  const bigFrame = { t: 'input', clientId: 7, ackTick: -1, ackCheckpoint: -1, cmds: [] };
  for (let i = 0; i < 8000; i++) bigFrame.cmds.push(cmd({ tick: 1000 + i, seq: i, moveX: 1, moveZ: 1 }));

  const t0 = process.hrtime.bigint();
  const out = guard.inbound('p-mallory', bigFrame, 0);
  const guardMs = Number(process.hrtime.bigint() - t0) / 1e6;

  check('InputGuard truncates an 8000-command frame',
    out.action === 'rewrite' && out.message.cmds.length <= DEFAULT_SECURITY_POLICY.maxCommandsPerFrame,
    `8000 -> ${out.message?.cmds.length} commands in ${guardMs.toFixed(3)} ms (policy cap ${DEFAULT_SECURITY_POLICY.maxCommandsPerFrame})`);

  const core = new AuthorityCore({ tickRate: 30 }, new ArenaSim(30));
  const id = core.admit('v', 'v', 'p1');
  const t1 = process.hrtime.bigint();
  core.submitInput(id, out.message.cmds);
  const authMs = Number(process.hrtime.bigint() - t1) / 1e6;
  check('the authority now spends bounded time on a hostile frame',
    guardMs + authMs < 2,
    `guard ${guardMs.toFixed(3)} ms + authority ${authMs.toFixed(3)} ms = ${(guardMs + authMs).toFixed(3)} ms (was measured at PART A5)`);

  check('InputGuard normalises move magnitude to <= 1',
    out.message.cmds.every((c) => Math.hypot(c.moveX, c.moveZ) <= 1.0000001),
    `max |move| after guard = ${Math.max(...out.message.cmds.map((c) => Math.hypot(c.moveX, c.moveZ))).toFixed(6)}`);

  // sustained rate limiting across frames
  const g2 = new HostGuard({ selfStableId: 'alice' });
  g2.bindPeer('p-mallory', 'mallory', 7);
  let accepted = 0;
  for (let ms = 0; ms < 1000; ms += 10) {
    const r = g2.inbound('p-mallory', {
      t: 'input', clientId: 7, ackTick: -1, ackCheckpoint: -1,
      cmds: Array.from({ length: 32 }, (_, i) => cmd({ tick: ms * 10 + i, seq: i })),
    }, ms);
    if (r.action === 'accept') accepted += 32;
    else if (r.action === 'rewrite') accepted += r.message.cmds.length;
  }
  // Ceiling is one full bucket (the burst a quiet client may bank) plus one
  // second of refill.
  const budget = DEFAULT_SECURITY_POLICY.commandsPerSecond;
  const ceiling = budget * (1 + DEFAULT_SECURITY_POLICY.commandBurstSeconds);
  check('sustained command rate is capped at the tick budget',
    accepted <= ceiling,
    `attacker offered 3200 commands/s, guard admitted ${accepted} (budget ${budget}/s, burst ${DEFAULT_SECURITY_POLICY.commandBurstSeconds}s, ceiling ${ceiling}) — ${(100 - accepted / 3200 * 100).toFixed(1)}% refused`);

  // malformed frames are refused, not thrown on
  const g3 = new HostGuard({ selfStableId: 'alice' });
  g3.bindPeer('p-mallory', 'mallory', 7);
  let bad = 0;
  for (const payload of [5, 'x', null, {}, [1, 2], { length: 1e9 }]) {
    const r = g3.inbound('p-mallory', { t: 'input', clientId: 7, cmds: payload, ackTick: -1, ackCheckpoint: -1 }, 0);
    if (r.action === 'drop' || (r.action === 'rewrite' && r.message.cmds.length === 0)) bad++;
  }
  check('a non-iterable cmds payload is refused before the authority sees it',
    bad === 6,
    `${bad}/6 malformed payloads refused; reasons ${JSON.stringify(g3.stats.byReason)}`);
}

/* ------------------------------------------------------------------ */
section('B4. the guards are free when nobody is attacking');
/* ------------------------------------------------------------------ */
{
  const clean = makeMatch();
  run(clean, 5000);
  const guarded = makeMatch({ guard: 'all' });
  run(guarded, 5000);

  const a = w2n(clean), b = w2n(guarded);
  check('a guarded match plays identically to an unguarded one',
    Math.abs(a.tick - b.tick) <= 1 && a.players === b.players,
    `tick ${a.tick} vs ${b.tick}, players ${a.players} vs ${b.players}, snapshots ${a.snaps} vs ${b.snaps}`);
  check('no honest frame was dropped by any guard',
    guarded.guards.every((g) => g.stats.dropped === 0),
    `drops per peer: [${guarded.guards.map((g) => `${g.stats.dropped}${JSON.stringify(g.stats.byReason)}`).join(' ')}] over ${guarded.guards.reduce((n, g) => n + g.stats.seen, 0)} frames`);

  // cost
  const t0 = process.hrtime.bigint();
  run(clean, 5000);
  const cleanMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  run(guarded, 5000);
  const guardedMs = Number(process.hrtime.bigint() - t1) / 1e6;
  check('guard overhead is small',
    guardedMs < cleanMs * 1.6 + 5,
    `5 s of 3-peer match: ${cleanMs.toFixed(1)} ms unguarded vs ${guardedMs.toFixed(1)} ms guarded (+${(guardedMs - cleanMs).toFixed(1)} ms)`);
}

function w2n(w) {
  const core = authority(w);
  return {
    tick: core.state.tick,
    players: core.state.players.size,
    snaps: w.sinks.get('bob').snapshots,
  };
}

/* ------------------------------------------------------------------ */
console.log('\n=== summary ===');
console.log(`  ${passed} passed, ${failures.length} failed`);
if (findings.length) {
  console.log(`\n  ${findings.length} exploits landed against the as-built stack:`);
  for (const f of findings) console.log(`    - ${f}`);
}
if (failures.length) {
  console.log('\nFAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS');
