#!/usr/bin/env node
/**
 * net-sim — does the netcode actually converge?
 *
 *   node tools/net-sim.mjs [--seconds 60] [--verbose] [--quick] [--only <n>]
 *
 * One host and three clients in a single node process, over the in-process
 * LoopbackTransport, on a virtual clock. Scripted input is a pure function of
 * (peer index, tick) — no RNG state and no dependence on what a peer received —
 * so every link condition attempts the *identical* command stream and any
 * difference in outcome belongs to the network, not to the bots.
 *
 * Every participant's simulation state is hashed every tick and compared against
 * the host's state for the same (epoch, tick). The comparison is exact, on the
 * quantised values the wire actually carries: every FIELD_SCALE is a power of
 * two, so dequantise∘quantise is lossless and "close enough" never enters it.
 *
 * SCOPE — read this before quoting the result. As shipped, a client runs no
 * simulation of its own: `NetSystem.predictor` is `null` and nothing assigns it,
 * and `PeerSession` has no predictor at all. So "do the clients converge on the
 * host" is, today, exactly the question "does the delta/ack/interest pipeline
 * reconstruct authoritative state exactly" — there is no second simulation that
 * could drift. Sections 1 and 3 attack the other half (is a host tick a pure
 * function of state+inputs+tick, which is what client prediction will need the
 * moment anyone wires MovementStepper in).
 *
 * Sections
 *   1  nondeterminism traps: Math.random / Date.now / performance.now, a static
 *      scan, and iteration-order probes over the entity and player maps
 *   2  the sweep: 4 one-way latencies x 3 loss rates, per-tick state hashing
 *   3  replay: is a live host tick a pure function of (state, inputs, tick)?
 *   4  input fidelity: how much of what the player pressed reaches the authority
 *   5  bandwidth, decomposed by message kind
 *   6  hostile input: NaN, Infinity, forged ticks
 *   7  interest management on: absent entities explained, present ones exact
 *   8  convergence across a host migration
 *
 * Exit code is non-zero on any failure. Every claim prints its number.
 */

import './net-ts-loader.mjs';

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const QUICK = argv.includes('--quick');
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const SECONDS = (() => {
  const i = argv.indexOf('--seconds');
  if (i >= 0) return Number(argv[i + 1]);
  return QUICK ? 12 : 60;
})();

/* ------------------------------------------------------------------ */
/* 0. nondeterminism traps, installed BEFORE the modules load          */
/* ------------------------------------------------------------------ */

const trap = { random: 0, dateNow: 0, perfNow: 0, armed: false };
{
  const realRandom = Math.random;
  Math.random = function trappedRandom() { if (trap.armed) trap.random++; return realRandom(); };
  const realDateNow = Date.now;
  Date.now = function trappedDateNow() { if (trap.armed) trap.dateNow++; return realDateNow(); };
  if (typeof performance === 'object' && performance && typeof performance.now === 'function') {
    const realPerfNow = performance.now.bind(performance);
    performance.now = function trappedPerfNow() { if (trap.armed) trap.perfNow++; return realPerfNow(); };
  }
}

const {
  PeerSession, SnapshotReader, DeltaSnapshotWriter, ArenaSim, AuthorityCore,
  LoopbackNetwork, exportCheckpoint, ENTITY_FLAG, ENTITY_FIELDS, FIELD_SCALE,
  fnv1a, BTN, jsonCodec,
} = await import('../src/net/host/index.ts');

/* ------------------------------------------------------------------ */
/* assertion harness                                                   */
/* ------------------------------------------------------------------ */

let passed = 0;
const broken = [];   // convergence invariants that did not hold
const defects = [];  // proven defects that are not desyncs
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`); }
  else { broken.push(`${name}  [${detail}]`); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}
/** A measured defect that does not break convergence. Still fails the run. */
function defect(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`); }
  else { defects.push(`${name}  [${detail}]`); console.log(`  DEFECT ${name}${detail ? `  [${detail}]` : ''}`); }
}
function info(msg) { console.log(`  info  ${msg}`); }
function section(t) { console.log(`\n=== ${t} ===`); }
function want(n) { return !ONLY || String(n) === ONLY; }

/* ------------------------------------------------------------------ */
/* state hashing                                                       */
/* ------------------------------------------------------------------ */

const SCALES = ENTITY_FIELDS.map((f) => FIELD_SCALE[f] ?? 1);

/** Quantise one entity exactly the way DeltaSnapshotWriter transmits it. */
function quantEntity(e) {
  const out = new Array(ENTITY_FIELDS.length);
  for (let i = 0; i < ENTITY_FIELDS.length; i++) {
    const s = SCALES[i];
    const raw = e[ENTITY_FIELDS[i]];
    out[i] = s === 1 ? Math.round(raw) : Math.round(raw * s);
  }
  return out;
}

function quantWorld(entities) {
  const m = new Map();
  for (const [id, e] of entities) m.set(id, quantEntity(e));
  return m;
}

/** Order-independent canonical hash of a quantised world. */
function hashWorld(q) {
  const ids = [...q.keys()].sort((a, b) => a - b);
  let s = '';
  for (const id of ids) s += `${id}:${q.get(id).join(',')};`;
  return fnv1a(s);
}

/* ------------------------------------------------------------------ */
/* scripted input — a pure function of (peer index, tick)              */
/* ------------------------------------------------------------------ */

/** Deterministic hash in [0,1). No RNG state, so call order cannot matter. */
function h01(a, b, c) {
  let x = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519)) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * A bot that reliably produces combat in the reference arena: orbits, sweeps its
 * aim through the ring the other bots occupy, holds fire in bursts, jumps,
 * crouches, sprints and reloads. Deliberately blind to replicated state.
 */
function scriptCommand(idx, tick) {
  const phase = idx * 1.5707963267948966;   // pi/2 — four peers, evenly spread
  const t = tick * 0.03;
  let buttons = 0;
  if (h01(idx, Math.floor(tick / 10), 5) < 0.55) buttons |= BTN.FIRE;
  if (h01(idx, tick, 11) < 0.012) buttons |= BTN.JUMP;
  if (h01(idx, Math.floor(tick / 37), 7) < 0.25) buttons |= BTN.SPRINT;
  if (h01(idx, Math.floor(tick / 53), 9) < 0.10) buttons |= BTN.CROUCH;
  if (h01(idx, Math.floor(tick / 91), 3) < 0.06) buttons |= BTN.RELOAD;
  return {
    tick, seq: 0,
    moveX: Math.sin(t * 0.61 + phase) * 0.9,
    moveZ: Math.cos(t * 0.23 + phase) * 0.9,
    yaw: Math.sin(t * 0.37 + phase) * Math.PI,
    pitch: Math.sin(t * 0.11 + phase) * 0.18,
    buttons,
  };
}

const TICK_RATE = 30;
const SUB_HZ = 120;             // driving sub-step: 4 sub-steps per net tick
const DT = 1 / SUB_HZ;
const DT_MS = 1000 / SUB_HZ;

/* ================================================================== */
/* 1. nondeterminism traps                                             */
/* ================================================================== */

if (want(1)) {
  section('1. the simulation path contains no nondeterminism');

  /* 1a — runtime: a host tick may not touch a clock or Math.random */
  {
    const core = new AuthorityCore({ tickRate: TICK_RATE, seed: 20260730 }, new ArenaSim(TICK_RATE));
    core.admit('a', 'A', 'pa'); core.admit('b', 'B', 'pb'); core.admit('c', 'C', 'pc');
    trap.random = 0; trap.dateNow = 0; trap.perfNow = 0; trap.armed = true;
    for (let t = 0; t < 900; t++) {
      for (let c = 1; c <= 3; c++) core.submitInput(c, [scriptCommand(c - 1, t)]);
      core.stepOnce(); core.flushEvents();
    }
    trap.armed = false;
    check('no Math.random() in 900 authoritative ticks', trap.random === 0, `calls=${trap.random}`);
    check('no Date.now() in 900 authoritative ticks', trap.dateNow === 0, `calls=${trap.dateNow}`);
    check('no performance.now() in 900 authoritative ticks', trap.perfNow === 0, `calls=${trap.perfNow}`);
    info(`reference sim emitted ${core.stats.eventsEmitted} events over 900 ticks`);
  }

  /* 1b — static scan of the whole authority directory */
  {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const hits = [];
    let files = 0;
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        files++;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const s = line.trimStart();
          if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return;
          if (/Math\.random|Date\.now|performance\.now|new Date\(/.test(line)) hits.push(`${p}:${i + 1}`);
        });
      }
    };
    walk('src/net/host');
    check('src/net/host contains no wall clock and no unseeded RNG', hits.length === 0,
      hits.length ? hits.slice(0, 5).join(' ') : `clean across ${files} files`);
  }

  /* 1c — entity Map iteration order must not change the outcome */
  {
    const build = (reverse) => {
      const core = new AuthorityCore({ tickRate: TICK_RATE, seed: 4242 }, new ArenaSim(TICK_RATE));
      core.admit('a', 'A', 'pa'); core.admit('b', 'B', 'pb'); core.admit('c', 'C', 'pc');
      if (reverse) core.state.entities = new Map([...core.state.entities.entries()].reverse());
      return core;
    };
    const run = (core) => {
      for (let t = 0; t < 600; t++) {
        for (let c = 1; c <= 3; c++) core.submitInput(c, [scriptCommand(c - 1, t)]);
        core.stepOnce(); core.flushEvents();
      }
      return exportCheckpoint(core.state, []).checksum;
    };
    const a = run(build(false)), b = run(build(true));
    check('entity Map insertion order does not change the simulation', a === b,
      `0x${a.toString(16)} vs 0x${b.toString(16)}`);
  }

  /* 1d — player Map iteration order and the shared respawn RNG stream */
  {
    const mk = (reverse) => {
      const core = new AuthorityCore(
        { tickRate: TICK_RATE, seed: 909, respawnTicks: 2 }, new ArenaSim(TICK_RATE));
      core.admit('a', 'A', 'pa'); core.admit('b', 'B', 'pb');
      for (const s of core.state.players.values()) {
        const e = core.state.entities.get(s.entityId);
        e.flags |= ENTITY_FLAG.DEAD; e.health = 0; e.respawnTick = core.tick + 2;
      }
      if (reverse) core.state.players = new Map([...core.state.players.entries()].reverse());
      for (let t = 0; t < 6; t++) { core.stepOnce(); core.flushEvents(); }
      return [...core.state.entities.values()].sort((x, y) => x.id - y.id)
        .map((e) => `e${e.id}@${e.px.toFixed(3)},${e.pz.toFixed(3)}`).join(' ');
    };
    const fwd = mk(false), rev = mk(true);
    check('player Map iteration order does not change simultaneous respawns', fwd === rev,
      fwd === rev ? fwd : `forward=[${fwd}]  reversed=[${rev}]`);
  }

  /* 1e — two players admitted on the same tick must not share a spawn point */
  {
    const core = new AuthorityCore({ tickRate: TICK_RATE, seed: 31337 }, new ArenaSim(TICK_RATE));
    const ids = ['a', 'b', 'c'].map((s) => core.admit(s, s, `p-${s}`));
    const pts = ids.map((id) => {
      const e = core.state.entities.get(core.state.players.get(id).entityId);
      return `${e.px.toFixed(3)},${e.pz.toFixed(3)}`;
    });
    check('players admitted on the same tick get distinct spawn points',
      new Set(pts).size === pts.length, pts.join('  |  '));
  }
}

/* ================================================================== */
/* the four-peer match                                                 */
/* ================================================================== */

/** A codec that tallies encoded bytes per message kind. */
function tallyCodec(tally) {
  return {
    name: 'json-tally',
    encode(msg) {
      const b = jsonCodec.encode(msg);
      const k = msg && typeof msg === 'object' && msg.t ? msg.t : '?';
      tally.bytes[k] = (tally.bytes[k] ?? 0) + b.byteLength;
      tally.count[k] = (tally.count[k] ?? 0) + 1;
      return b;
    },
    decode(d) { return jsonCodec.decode(d); },
  };
}

/**
 * Run one host + three clients for `seconds` of simulated time and hash every
 * participant every tick.
 */
function runMatch(opts) {
  const {
    latencyMs, jitterMs, loss, seconds, seed = 20260730,
    interestRadius = 500, record = false, recordFromTick = 3 * TICK_RATE,
    killHostAt = null, tally = null,
  } = opts;

  const net = new LoopbackNetwork((seed ^ 0x5eed) >>> 0, { latencyMs, jitterMs, loss });

  /* --- the host's per-(epoch,tick) ledger --------------------------- */
  // A tick can legitimately be observed in more than one state: `admit()` mutates
  // the world between ticks, and the welcome keyframe it triggers is stamped with
  // a tick that has already been published. Keep every variant we observed and
  // let a client match any of them; the count of multi-variant ticks is a result
  // in its own right.
  const hostVariants = new Map();     // "epoch:tick" -> [{ q, hash }]
  const multiVariantAt = [];
  function recordHost(state) {
    if (!state) return;
    const key = `${state.epoch}:${state.tick}`;
    const q = quantWorld(state.entities);
    const h = hashWorld(q);
    let list = hostVariants.get(key);
    if (!list) { list = []; hostVariants.set(key, list); }
    if (list.some((v) => v.hash === h)) return;
    if (list.length > 0) multiVariantAt.push(key);
    list.push({ q, hash: h });
  }

  const consumed = [];        // { preTick, row: [[clientId, cmd], ...] }
  let startCheckpoint = null;

  /* --- peers -------------------------------------------------------- */
  const peers = [];
  function makePeer(idx, stableId) {
    const peerId = `peer-${stableId}`;
    const transport = net.createPort(peerId);
    const reader = new SnapshotReader();
    const p = {
      idx, stableId, peerId, transport, reader, alive: true, observedHost: false,
      welcomes: 0, events: 0, disconnects: [], lastEpoch: 0,
      compares: 0, matches: 0, mismatches: 0, unmatchedTick: 0,
      firstDiverge: null, maxPosErrM: 0, maxFieldErr: new Map(),
      missingEntity: 0, extraEntity: 0, culledOk: 0, culledBad: 0,
    };
    p.session = new PeerSession({
      stableId,
      displayName: stableId,
      transport,
      codec: tally ? tallyCodec(tally) : undefined,
      sim: new ArenaSim(TICK_RATE),
      writer: new DeltaSnapshotWriter({ interestRadius }),
      hostConfig: { tickRate: TICK_RATE, seed },
      // Generous timeouts so a 250 ms link never trips a spurious migration in
      // the sections that are not about migration.
      policy: { hostTimeoutMs: killHostAt === null ? 4000 : 1500, claimTimeoutMs: killHostAt === null ? 3000 : 1200 },
      inputRedundancy: 3,
      sink: {
        onWelcome: () => { p.welcomes++; reader.reset(); },
        onSnapshot: (s) => {
          p.lastEpoch = s.epoch;
          const before = reader.tick;
          reader.apply(s);
          if (reader.tick > before) compareClient(p);
        },
        onEvent: () => { p.events++; },
        onDisconnect: (r) => p.disconnects.push(r),
      },
      input: (tick) => scriptCommand(idx, tick),
    });
    peers.push(p);
    return p;
  }

  /**
   * Compare one client's reconstruction against the host ledger for its tick.
   *
   * The client is scored against every variant recorded for that (epoch, tick)
   * and judged on the best one: when `admit()` mutates the world between ticks,
   * two clients legitimately hold two different worlds under the same tick
   * label, and only one of them is the one this client was sent.
   */
  function compareClient(p) {
    const tick = p.reader.tick;
    const variants = hostVariants.get(`${p.lastEpoch}:${tick}`);
    if (!variants) { p.unmatchedTick++; return; }
    p.compares++;
    const cq = quantWorld(p.reader.entities);
    const ch = hashWorld(cq);
    if (variants.some((v) => v.hash === ch)) { p.matches++; return; }

    let selfId = -1;
    for (const [id, e] of p.reader.entities) if (e.owner === p.session.clientId) { selfId = id; break; }
    const selfQ = selfId >= 0 ? cq.get(selfId) : null;

    // Score against each variant; keep the least-bad explanation.
    let best = null;
    for (const v of variants) {
      const ref = v.q;
      const r = { fields: [], extra: 0, culledOk: 0, culledBad: 0, missing: 0 };
      for (const [id, cv] of cq) {
        const hv = ref.get(id);
        if (!hv) { r.extra++; continue; }
        for (let i = 0; i < ENTITY_FIELDS.length; i++) {
          if (cv[i] !== hv[i]) r.fields.push([id, i, cv[i], hv[i]]);
        }
      }
      for (const [id, hv] of ref) {
        if (cq.has(id)) continue;
        r.missing++;
        let culled = false;
        if (selfQ) {
          const dx = (hv[3] - selfQ[3]) / 1024, dy = (hv[4] - selfQ[4]) / 1024, dz = (hv[5] - selfQ[5]) / 1024;
          culled = Math.sqrt(dx * dx + dy * dy + dz * dz) > interestRadius;
        }
        if (culled) r.culledOk++; else { r.culledBad++; r.badId = id; }
      }
      r.score = r.fields.length * 1000 + r.extra * 1000 + r.culledBad;
      if (!best || r.score < best.score) best = r;
    }

    p.missingEntity += best.missing;
    p.culledOk += best.culledOk;
    p.culledBad += best.culledBad;
    p.extraEntity += best.extra;
    for (const [id, i, cvv, hvv] of best.fields) {
      const f = ENTITY_FIELDS[i];
      const err = Math.abs(cvv - hvv) / SCALES[i];
      p.maxFieldErr.set(f, Math.max(p.maxFieldErr.get(f) ?? 0, err));
      if (f === 'px' || f === 'py' || f === 'pz') p.maxPosErrM = Math.max(p.maxPosErrM, err);
      if (!p.firstDiverge) {
        p.firstDiverge = {
          tick, entity: id, field: f,
          client: cvv / SCALES[i], host: hvv / SCALES[i], variants: variants.length,
        };
      }
    }
    if (best.score > 0) {
      p.mismatches++;
      if (!p.firstDiverge) {
        p.firstDiverge = {
          tick, entity: best.badId ?? -1, field: '<entity absent from client, inside interest radius>',
          client: null, host: 'present', variants: variants.length,
        };
      }
    } else p.matches++;
  }

  const host = makePeer(0, 'p-host');
  const c1 = makePeer(1, 'p-cli1');
  const c2 = makePeer(2, 'p-cli2');
  const c3 = makePeer(3, 'p-cli3');
  const clientPeers = [c1, c2, c3];

  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) net.connect(peers[i].peerId, peers[j].peerId);
  }

  /** Attach the ledger observer to whichever peer currently holds authority. */
  function observeHost(p) {
    if (p.observedHost || !p.session.host) return;
    p.observedHost = true;
    const core = p.session.host.core;
    recordHost(core.state);
    p.session.host.observe({
      onTick: (_t, state) => {
        recordHost(state);
        if (record && startCheckpoint === null && state.tick === recordFromTick) {
          // onTick(T) fires with the state at the START of tick T, before any
          // respawn or step for T — exactly where a replay of T must begin.
          startCheckpoint = exportCheckpoint(state, []);
        }
      },
      // `admit` mutates the world between ticks and the welcome keyframe it
      // triggers is stamped with the already-published tick. Record that variant
      // so the keyframe has something honest to be compared against.
      onPlayerJoin: () => recordHost(core.state),
    });
    if (record) {
      const inner = core.sim;
      const wrapped = {
        name: inner.name, dt: inner.dt,
        spawnPlayer: (s, e, r) => inner.spawnPlayer(s, e, r),
        step: (state, commands, rand, ops) => {
          if (state.tick >= recordFromTick) {
            const row = [...commands.entries()].map(([cid, cmd]) => [cid, { ...cmd }]);
            row.sort((a, b) => a[0] - b[0]);
            consumed.push({ preTick: state.tick, row });
          }
          inner.step(state, commands, rand, ops);
        },
      };
      Object.defineProperty(core, 'sim', { value: wrapped, writable: false, configurable: true });
    }
  }

  host.session.hostMatch(seed);
  observeHost(host);
  for (const p of clientPeers) p.session.joinMatch(host.peerId);

  /* --- drive -------------------------------------------------------- */
  let nowMs = 0;
  let killedAtTick = null;
  const steps = Math.round(seconds * SUB_HZ);
  const drain = SUB_HZ * 2;
  for (let i = 0; i < steps + drain; i++) {
    net.advanceTo(nowMs);
    for (const p of peers) if (p.alive && p.session.host) recordHost(p.session.host.core.state);
    for (const p of peers) if (p.alive) p.session.update(DT, nowMs);
    for (const p of peers) if (p.alive) observeHost(p);
    if (killHostAt !== null && killedAtTick === null && nowMs / 1000 >= killHostAt) {
      const h = peers.find((p) => p.alive && p.session.host);
      if (h) {
        killedAtTick = h.session.host.core.tick;
        net.kill(h.peerId, 'host quit');
        h.alive = false;
      }
    }
    nowMs += DT_MS;
  }

  /* --- results ------------------------------------------------------ */
  const finalHost = peers.find((p) => p.alive && p.session.host);
  const core = finalHost ? finalHost.session.host.core : host.session.host.core;
  const clients = peers.filter((p) => p !== finalHost).map((p) => {
    const inp = core.inputHealth(p.session.clientId);
    return {
      stableId: p.stableId, clientId: p.session.clientId, alive: p.alive,
      compares: p.compares, matches: p.matches, mismatches: p.mismatches,
      unmatchedTick: p.unmatchedTick, firstDiverge: p.firstDiverge,
      maxPosErrM: p.maxPosErrM, maxFieldErr: p.maxFieldErr,
      missingEntity: p.missingEntity, extraEntity: p.extraEntity,
      culledOk: p.culledOk, culledBad: p.culledBad,
      applied: p.reader.applied, droppedNoBaseline: p.reader.droppedNoBaseline,
      droppedStale: p.reader.droppedStale, lastTick: p.reader.tick,
      behind: core.tick - p.reader.tick, welcomes: p.welcomes, events: p.events,
      disconnects: p.disconnects, bytesIn: p.transport.bytesReceived,
      snapshotsSeen: p.session.counters.snapshotsReceived,
      starved: inp.starved, inputsDropped: inp.dropped, inputsReceived: inp.received,
      queued: inp.queued,
    };
  });

  return {
    opts, net, core, host, finalHost, peers, clientPeers, clients, consumed, startCheckpoint,
    tickHashes: new Map([...hostVariants].map(([k, v]) => [k, v[v.length - 1].hash])),
    hostTick: core.tick, killedAtTick,
    entities: core.state.entities.size,
    players: core.state.players.size,
    kills: [...core.state.players.values()].reduce((n, s) => n + s.kills, 0),
    deaths: [...core.state.players.values()].reduce((n, s) => n + s.deaths, 0),
    multiVariantAt, hostTicksRecorded: hostVariants.size,
    seconds: nowMs / 1000,
    hostBytesOut: host.transport.bytesSent,
    linkDropped: net.totalDropped, linkSent: net.totalSent,
  };
}

/* ================================================================== */
/* 2. the sweep                                                        */
/* ================================================================== */

const sweepRows = [];

if (want(2)) {
  section(`2. one host + three clients, ${SECONDS}s per config, per-tick state hashing`);
  console.log('     latency is ONE-WAY (RTT is double); jitter is +/- uniform;');
  console.log('     loss applies to unreliable traffic, which is where snapshots and inputs ride.');
  console.log('     NOTE: clients run no local simulation (NetSystem.predictor is null and nothing');
  console.log('     assigns it), so this measures replication fidelity, not two sims agreeing.\n');

  const LATENCIES = QUICK ? [0, 120] : [0, 60, 120, 250];
  const LOSSES = QUICK ? [0, 0.10] : [0, 0.02, 0.10];

  const head = 'lat/RTT   jit  loss |  hostTick  compares  mismatch  maxErr(m)  noBase  stale  starv/s  behind  kbit/s';
  console.log(`  ${head}`);
  console.log(`  ${'-'.repeat(head.length)}`);

  for (const latencyMs of LATENCIES) {
    for (const loss of LOSSES) {
      const jitterMs = latencyMs === 0 ? 0 : Math.max(2, Math.round(latencyMs * 0.25));
      const r = runMatch({ latencyMs, jitterMs, loss, seconds: SECONDS });
      const mism = r.clients.reduce((n, c) => n + c.mismatches, 0);
      const cmp = r.clients.reduce((n, c) => n + c.compares, 0);
      const maxErr = Math.max(...r.clients.map((c) => c.maxPosErrM));
      const noBase = r.clients.reduce((n, c) => n + c.droppedNoBaseline, 0);
      const stale = r.clients.reduce((n, c) => n + c.droppedStale, 0);
      const starv = r.clients.reduce((n, c) => n + c.starved, 0) / 3 / r.seconds;
      const behind = Math.max(...r.clients.map((c) => c.behind));
      const kbps = (r.clients.reduce((n, c) => n + c.bytesIn, 0) / 3) * 8 / r.seconds / 1000;
      sweepRows.push({ latencyMs, jitterMs, loss, r, mism, cmp, maxErr, noBase, stale, starv, behind, kbps });
      console.log(`  ${String(latencyMs).padStart(3)}/${String(latencyMs * 2).padStart(3)}  `
        + `${String(jitterMs).padStart(4)}  ${(loss * 100).toFixed(0).padStart(3)}% | `
        + `${String(r.hostTick).padStart(9)}  ${String(cmp).padStart(8)}  ${String(mism).padStart(8)}  `
        + `${maxErr.toFixed(4).padStart(9)}  ${String(noBase).padStart(6)}  ${String(stale).padStart(5)}  `
        + `${starv.toFixed(2).padStart(7)}  ${String(behind).padStart(6)}  ${kbps.toFixed(1).padStart(6)}`);
      if (VERBOSE) {
        for (const c of r.clients) {
          console.log(`         ${c.stableId} id=${c.clientId}: cmp=${c.compares} match=${c.matches} `
            + `mism=${c.mismatches} unmatchedTick=${c.unmatchedTick} applied=${c.applied} `
            + `welcomes=${c.welcomes} missEnt=${c.missingEntity}(ok ${c.culledOk}/bad ${c.culledBad}) `
            + `extraEnt=${c.extraEntity} starved=${c.starved} inRecv=${c.inputsReceived} q=${c.queued}`);
          if (c.firstDiverge) {
            const d = c.firstDiverge;
            console.log(`           FIRST DIVERGENCE tick=${d.tick} entity=${d.entity} field=${d.field} `
              + `client=${d.client} host=${d.host} hostVariants=${d.variants}`);
          }
        }
        console.log(`         host: entities=${r.entities} players=${r.players} kills=${r.kills} `
          + `deaths=${r.deaths} multiVariantTicks=${r.multiVariantAt.length}/${r.hostTicksRecorded} `
          + `linkDropped=${r.linkDropped}/${r.linkSent}`);
      }
    }
  }
  console.log('');

  const totalMismatch = sweepRows.reduce((n, s) => n + s.mism, 0);
  const totalCompare = sweepRows.reduce((n, s) => n + s.cmp, 0);
  const worstErr = Math.max(...sweepRows.map((s) => s.maxErr));

  check('every client reconstruction is bit-exact with the host at its own tick',
    totalMismatch === 0 && totalCompare > 0,
    `${totalCompare - totalMismatch}/${totalCompare} tick-states exact across ${sweepRows.length} link configs`);
  check('maximum positional divergence is zero', worstErr === 0, `${worstErr.toFixed(6)} m`);

  const expectedPerConfig = SECONDS * TICK_RATE * 3;
  const thin = sweepRows.filter((s) => s.cmp < expectedPerConfig * 0.5);
  check('every client stayed synchronised for most of the match', thin.length === 0,
    thin.length
      ? thin.map((s) => `${s.latencyMs}ms/${(s.loss * 100).toFixed(0)}% -> ${s.cmp}/${expectedPerConfig}`).join('  ')
      : `${(totalCompare / sweepRows.length / expectedPerConfig * 100).toFixed(1)}% of host ticks verified, mean`);

  const worstBehind = Math.max(...sweepRows.map((s) => s.behind));
  check('clients stay within a bounded lag of the host', worstBehind <= 40,
    `worst = ${worstBehind} ticks (${(worstBehind / TICK_RATE * 1000).toFixed(0)} ms) behind`);

  const worstNoBase = Math.max(...sweepRows.map((s) => s.noBase));
  check('delta baselines resolve — no sustained undecodable-snapshot storm',
    worstNoBase <= SECONDS * 3,
    `worst config dropped ${worstNoBase} snapshots for a missing baseline in ${SECONDS}s`);

  // `admit()` spawns an entity *between* ticks, and the welcome keyframe it
  // triggers is stamped with a tick the host has already published. So during a
  // join the same (epoch, tick) label names more than one world, and which one a
  // client holds depends on when it joined.
  const mv = sweepRows.flatMap((s) => s.r.multiVariantAt);
  const mvTicks = mv.map((k) => Number(k.split(':')[1]));
  const mvLate = mvTicks.filter((t) => t > 3 * TICK_RATE);
  defect('one (epoch,tick) label always names exactly one world state',
    mv.length === 0,
    mv.length
      ? `${mv.length} labels named 2+ worlds across ${sweepRows.length} runs `
        + `(${mv.length / sweepRows.length} per run = one per join); all at ticks `
        + `${Math.min(...mvTicks)}..${Math.max(...mvTicks)}, ${mvLate.length} outside the join window. `
        + `Cause: AuthorityCore.admit() spawns an entity between ticks and PeerHost.onJoin `
        + `stamps the welcome keyframe with the already-published tick`
      : 'one state per tick label');
}

/* ================================================================== */
/* 3. replay determinism                                               */
/* ================================================================== */

if (want(3)) {
  section('3. a live host tick replays exactly from its own recorded input stream');

  const r = runMatch({
    latencyMs: 120, jitterMs: 30, loss: 0.10,
    seconds: QUICK ? 12 : 30, record: true,
  });

  check('recorded a real input stream from the live match',
    r.consumed.length > 100 && !!r.startCheckpoint,
    `${r.consumed.length} ticks of applied commands, checkpoint at tick ${r.startCheckpoint?.tick}`);

  if (r.startCheckpoint && r.consumed.length > 100) {
    // Rebuild an authority from the live host's own state at the first recorded
    // tick and feed it the exact command map the live host applied. If a tick is
    // a pure function of (state, inputs, tick), the two agree for ever.
    // slotGraceTicks is raised because this replay bypasses the input queues, so
    // `lastSeenTick` never advances and the reaper would otherwise fire.
    const refSim = new ArenaSim(TICK_RATE);
    let replayRow = null;
    const shim = {
      name: 'replay', dt: 1 / TICK_RATE,
      spawnPlayer: (s, e, rand) => refSim.spawnPlayer(s, e, rand),
      step: (state, _commands, rand, ops) => refSim.step(state, new Map(replayRow ?? []), rand, ops),
    };
    const replay = new AuthorityCore(
      { tickRate: TICK_RATE, seed: 20260730, slotGraceTicks: 1e9 }, shim);
    replay.resumeFrom(r.startCheckpoint, r.startCheckpoint.epoch);

    let compared = 0, firstBad = null, detail = '';
    for (const rec of r.consumed) {
      if (replay.state.tick !== rec.preTick) { firstBad = `tick misalignment ${replay.state.tick} != ${rec.preTick}`; break; }
      replayRow = rec.row;
      const beforeQ = quantWorld(replay.state.entities);
      replay.stepOnce(); replay.flushEvents();
      compared++;
      const expect = r.tickHashes.get(`${replay.state.epoch}:${replay.state.tick}`);
      if (expect === undefined) continue;
      const got = hashWorld(quantWorld(replay.state.entities));
      if (expect !== got) {
        firstBad = `tick ${replay.state.tick}`;
        detail = `(replay hash 0x${got.toString(16)} != live 0x${expect.toString(16)}; `
          + `${beforeQ.size} entities in flight)`;
        break;
      }
    }
    check('replaying the recorded inputs reproduces the host tick for tick',
      firstBad === null,
      firstBad === null ? `${compared} consecutive ticks bit-identical` : `diverged at ${firstBad} ${detail}`);
  }

  info(`under 120 ms / 30 ms jitter / 10 % loss the host applied ${r.consumed.length} ticks, `
    + `${r.kills} kills, ${r.deaths} deaths`);
}

/* ================================================================== */
/* 4. input fidelity                                                   */
/* ================================================================== */

if (want(4) && sweepRows.length) {
  section('4. how much of what the player pressed actually reaches the authority');
  console.log('     starvation = a host tick with no command from that client, so the host');
  console.log('     repeats the previous look/move and strips the edge-triggered buttons.\n');
  const head = ' lat/RTT  loss |  ticks  cmds accepted  starved  starved %  cause';
  console.log(`  ${head}`);
  console.log(`  ${'-'.repeat(head.length)}`);
  for (const s of sweepRows) {
    const recv = s.r.clients.reduce((n, c) => n + c.inputsReceived, 0) / 3;
    const starv = s.r.clients.reduce((n, c) => n + c.starved, 0) / 3;
    const ticks = s.r.hostTick;
    const pct = (starv / ticks) * 100;
    const cause = s.loss > 0 && s.jitterMs > 0 ? 'loss + jitter' : s.loss > 0 ? 'snapshot loss' : s.jitterMs > 0 ? 'snapshot jitter' : '—';
    console.log(`  ${String(s.latencyMs).padStart(3)}/${String(s.latencyMs * 2).padStart(3)}  `
      + `${(s.loss * 100).toFixed(0).padStart(3)}% | ${String(ticks).padStart(6)}  `
      + `${recv.toFixed(0).padStart(13)}  ${starv.toFixed(0).padStart(7)}  ${pct.toFixed(1).padStart(8)}%  ${cause}`);
  }
  console.log('');
  const clean = sweepRows.find((s) => s.latencyMs === 0 && s.loss === 0);
  const worst = sweepRows.reduce((a, b) => (b.starv > a.starv ? b : a));
  check('on a perfect link the authority receives essentially every command',
    clean && clean.starv < 0.2, clean ? `${clean.starv.toFixed(2)} starved ticks/s/client at 0 ms / 0 %` : 'n/a');
  defect('the authority receives most commands on a realistic link',
    worst.starv / TICK_RATE < 0.05,
    `worst = ${(worst.starv / TICK_RATE * 100).toFixed(1)} % of ticks starved `
    + `at ${worst.latencyMs} ms / ${(worst.loss * 100).toFixed(0)} % `
    + `(${worst.starv.toFixed(2)} ticks/s/client) — PeerSession stamps commands `
    + `lastSnapshotTick+lead, so every lost or jittered snapshot costs one command`);
}

/* ================================================================== */
/* 5. bandwidth, decomposed                                            */
/* ================================================================== */

if (want(5)) {
  section('5. bandwidth on the shipped default codec, decomposed by message kind');
  const tally = { bytes: {}, count: {} };
  const r = runMatch({
    latencyMs: 60, jitterMs: 15, loss: 0.02,
    seconds: QUICK ? 12 : 30, tally,
  });
  const total = Object.values(tally.bytes).reduce((a, b) => a + b, 0);
  const rows = Object.keys(tally.bytes).sort((a, b) => tally.bytes[b] - tally.bytes[a]);
  console.log('     kind          bytes      msgs   mean B   share');
  for (const k of rows) {
    const b = tally.bytes[k], n = tally.count[k];
    console.log(`     ${k.padEnd(12)} ${String(b).padStart(9)} ${String(n).padStart(9)} `
      + `${(b / n).toFixed(0).padStart(8)} ${((b / total) * 100).toFixed(1).padStart(6)}%`);
  }
  const perClientKbps = (r.clients.reduce((n, c) => n + c.bytesIn, 0) / 3) * 8 / r.seconds / 1000;
  const hostUpKbps = r.hostBytesOut * 8 / r.seconds / 1000;
  info(`4 players, ${TICK_RATE} Hz snapshots: ${perClientKbps.toFixed(1)} kbit/s down per client, `
    + `${hostUpKbps.toFixed(1)} kbit/s up at the host`);
  info(`docs/NETCODE.md §4 budgets 68 kbit/s per client and 1.02 Mbit/s host uplink `
    + `for SIXTEEN players on the binary codec`);
  defect('per-client downstream fits the peer-host budget in docs/NETCODE.md §4',
    perClientKbps < 68 * 2,
    `${perClientKbps.toFixed(1)} kbit/s per client for FOUR players — `
    + `${(perClientKbps / 68).toFixed(1)}x the 16-player budget. `
    + `PeerHost defaults to jsonCodec and src/net/wire is not wired in.`);
  const evShare = (tally.bytes.snapshot ?? 0) / total;
  info(`snapshot traffic is ${(evShare * 100).toFixed(1)} % of all encoded bytes; `
    + `checkpoints are ${(((tally.bytes.checkpoint ?? 0) / total) * 100).toFixed(1)} %`);
}

/* ================================================================== */
/* 6. hostile input                                                    */
/* ================================================================== */

if (want(6)) {
  section('6. hostile and malformed input cannot poison the authority');

  const core = new AuthorityCore({ tickRate: TICK_RATE, seed: 5150 }, new ArenaSim(TICK_RATE));
  const id = core.admit('victim', 'V', 'pv');
  core.admit('other', 'O', 'po');
  for (let t = 0; t < 30; t++) { core.submitInput(id, [scriptCommand(0, t)]); core.stepOnce(); core.flushEvents(); }

  const ent = () => core.state.entities.get(core.state.players.get(id).entityId);
  const before = { ...ent() };

  core.submitInput(id, [
    { tick: 100, seq: 1, moveX: NaN, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 },
    { tick: 101, seq: 2, moveX: 0, moveZ: Infinity, yaw: 0, pitch: 0, buttons: 0 },
    { tick: 102, seq: 3, moveX: 0, moveZ: 0, yaw: NaN, pitch: 0, buttons: 0 },
    { tick: 103, seq: 4, moveX: 0, moveZ: 0, yaw: 0, pitch: -Infinity, buttons: 0 },
    { tick: NaN, seq: 5, moveX: 1, moveZ: 1, yaw: 1, pitch: 1, buttons: 0 },
    { tick: 104, seq: 6, moveX: 1e300, moveZ: -1e300, yaw: 1e9, pitch: 1e9, buttons: 0 },
    { tick: 105, seq: 7, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 1.5 },
    { tick: 106, seq: 8, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: -1 },
  ]);
  for (let t = 0; t < 60; t++) { core.stepOnce(); core.flushEvents(); }
  const after = ent();
  const finite = ENTITY_FIELDS.every((f) => Number.isFinite(after[f]));
  check('NaN / Infinity in a command never reaches the integrator', finite,
    finite ? `all 18 fields finite (px=${after.px.toFixed(3)} py=${after.py.toFixed(3)} pz=${after.pz.toFixed(3)}, `
      + `was ${before.px.toFixed(3)},${before.pz.toFixed(3)})`
      : ENTITY_FIELDS.filter((f) => !Number.isFinite(after[f])).join(','));
  check('a 1e300 movement axis cannot teleport a player out of the arena',
    Math.abs(after.px) <= 60.0001 && Math.abs(after.pz) <= 60.0001,
    `px=${after.px.toFixed(3)} pz=${after.pz.toFixed(3)} (halfExtent 60)`);

  // A forged far-future tick latches the client's own queue for ever, because
  // submitInput drops anything with `tick <= lastAcceptedTick` and never bounds
  // how far ahead of the host a tick may be.
  {
    const c2 = new AuthorityCore({ tickRate: TICK_RATE, seed: 7 }, new ArenaSim(TICK_RATE));
    const v = c2.admit('v', 'V', 'pv');
    c2.submitInput(v, [{ tick: 2 ** 40, seq: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }]);
    for (let t = 0; t < 20; t++) { c2.submitInput(v, [scriptCommand(0, t)]); c2.stepOnce(); c2.flushEvents(); }
    const h = c2.inputHealth(v);
    defect('a forged far-future input tick is bounded rather than latching the queue',
      h.received > 2,
      `one command stamped tick 2^40 then 20 legitimate ones: host accepted ${h.received}, `
      + `starved ${h.starved} of 20 ticks. AuthorityCore.submitInput never bounds cmd.tick `
      + `against state.tick, so the client is muted permanently (self-inflicted only)`);
  }
}

/* ================================================================== */
/* 7. interest management                                              */
/* ================================================================== */

if (want(7)) {
  section('7. with interest management on, absent entities are explained and present ones exact');
  const r = runMatch({
    latencyMs: 60, jitterMs: 15, loss: 0.02,
    seconds: QUICK ? 12 : 30, interestRadius: 18,
  });
  const bad = r.clients.reduce((n, c) => n + c.culledBad, 0);
  const ok = r.clients.reduce((n, c) => n + c.culledOk, 0);
  const mism = r.clients.reduce((n, c) => n + c.mismatches, 0);
  const cmp = r.clients.reduce((n, c) => n + c.compares, 0);
  check('interest culling actually engaged at an 18 m radius', ok > 0,
    `${ok} entity-ticks legitimately withheld out of ${cmp} compared tick-states`);
  check('no entity was withheld from a client that was inside the interest radius',
    bad === 0, `${bad} unexplained absences`);
  check('every entity a client did hold matched the host exactly', mism === 0,
    `${cmp - mism}/${cmp} tick-states exact with culling on`);
  const kbps = (r.clients.reduce((n, c) => n + c.bytesIn, 0) / 3) * 8 / r.seconds / 1000;
  info(`culling at 18 m costs ${kbps.toFixed(1)} kbit/s per client`);
}

/* ================================================================== */
/* 8. convergence across a host migration                              */
/* ================================================================== */

if (want(8)) {
  section('8. the survivors re-converge after the host disappears');
  const r = runMatch({
    latencyMs: 60, jitterMs: 15, loss: 0.02,
    seconds: QUICK ? 16 : 30, killHostAt: QUICK ? 6 : 12,
  });
  const survivors = r.clients.filter((c) => c.alive);
  const mism = survivors.reduce((n, c) => n + c.mismatches, 0);
  const cmp = survivors.reduce((n, c) => n + c.compares, 0);
  check('the host was actually killed and a survivor promoted',
    r.killedAtTick !== null && !!r.finalHost && r.finalHost.stableId !== 'p-host',
    `killed at tick ${r.killedAtTick}, new host ${r.finalHost?.stableId}, epoch ${r.core.epoch}`);
  check('the match kept simulating past the migration', r.hostTick > (r.killedAtTick ?? 0),
    `tick ${r.killedAtTick} -> ${r.hostTick}`);
  check('every surviving client re-converges bit-exactly on the new authority',
    mism === 0 && cmp > 0, `${cmp - mism}/${cmp} tick-states exact for ${survivors.length} survivors`);
  const dis = survivors.flatMap((c) => c.disconnects);
  check('no survivor was disconnected by the migration', dis.length === 0, dis.join(',') || 'none');
  if (VERBOSE) {
    for (const c of r.clients) {
      console.log(`         ${c.stableId}: alive=${c.alive} cmp=${c.compares} mism=${c.mismatches} `
        + `unmatchedTick=${c.unmatchedTick} welcomes=${c.welcomes} noBase=${c.droppedNoBaseline}`);
      if (c.firstDiverge) console.log(`           FIRST DIVERGENCE ${JSON.stringify(c.firstDiverge)}`);
    }
  }
}

/* ================================================================== */
/* 9. protocol amplification                                           */
/* ================================================================== */

if (want(9)) {
  section('9. does the protocol send what the tick rate says it should?');

  // 9a — input packet rate must follow the TICK rate, not the caller's frame rate.
  const rateAt = (subHz) => {
    const tally = { bytes: {}, count: {} };
    const net = new LoopbackNetwork(0x9a9a, { latencyMs: 20, jitterMs: 0, loss: 0 });
    const mk = (id) => ({ id, transport: net.createPort(id) });
    const h = mk('h'), c = mk('c');
    net.connect('h', 'c');
    const common = (peer, idx) => ({
      stableId: peer.id, displayName: peer.id, transport: peer.transport,
      codec: tallyCodec(tally), sim: new ArenaSim(TICK_RATE),
      hostConfig: { tickRate: TICK_RATE }, inputRedundancy: 3,
      input: (tick) => scriptCommand(idx, tick),
    });
    const hs = new PeerSession(common(h, 0));
    const cs = new PeerSession(common(c, 1));
    hs.hostMatch(1234);
    cs.joinMatch('h');
    const dt = 1 / subHz, dtMs = 1000 / subHz;
    let ms = 0;
    for (let i = 0; i < subHz * 6; i++) {
      net.advanceTo(ms); hs.update(dt, ms); cs.update(dt, ms); ms += dtMs;
    }
    const ticks = hs.host.core.tick;
    hs.dispose(); cs.dispose();
    return { tally, seconds: ms / 1000, ticks };
  };

  const at60 = rateAt(60);
  const at120 = rateAt(120);
  const at240 = rateAt(240);
  const ips = (r) => (r.tally.count.input ?? 0) / r.seconds;
  console.log('     caller frame rate ->  input packets/s   input kbit/s up   (tick rate is 30 Hz)');
  for (const [hz, r] of [[60, at60], [120, at120], [240, at240]]) {
    console.log(`       ${String(hz).padStart(3)} Hz            ${ips(r).toFixed(1).padStart(10)}   `
      + `${((r.tally.bytes.input ?? 0) * 8 / r.seconds / 1000).toFixed(1).padStart(12)}`);
  }
  const frameCoupled = Math.abs(ips(at240) - ips(at60)) >= 5;
  defect('a client sends one input packet per simulation tick, not one per frame',
    !frameCoupled,
    `${ips(at60).toFixed(0)} / ${ips(at120).toFixed(0)} / ${ips(at240).toFixed(0)} packets per second at `
    + `60 / 120 / 240 Hz caller rate, for a 30 Hz tick rate`
    + (frameCoupled
      ? `. PeerSession.update() calls flushInput() once per call instead of once per queued command, `
        + `so upstream bandwidth is proportional to frame rate `
        + `(${((at240.tally.bytes.input ?? 0) * 8 / at240.seconds / 1000).toFixed(0)} kbit/s up at 240 Hz `
        + `vs a 59 kbit/s budget in docs/NETCODE.md §4)`
      : `; upstream is ${((at240.tally.bytes.input ?? 0) * 8 / at240.seconds / 1000).toFixed(0)} kbit/s `
        + `(3x redundancy, JSON codec) and independent of frame rate`));

  // 9b — the ping/pong keepalive must terminate.
  const pingProfile = (loss) => {
    const perSecond = [];
    const tally = { bytes: {}, count: {} };
    const net = new LoopbackNetwork(0xb00b, { latencyMs: 30, jitterMs: 0, loss });
    const h = { id: 'h', transport: net.createPort('h') };
    const c = { id: 'c', transport: net.createPort('c') };
    net.connect('h', 'c');
    const mkOpts = (peer, idx) => ({
      stableId: peer.id, displayName: peer.id, transport: peer.transport,
      codec: tallyCodec(tally), sim: new ArenaSim(TICK_RATE),
      hostConfig: { tickRate: TICK_RATE }, input: (tick) => scriptCommand(idx, tick),
    });
    const hs = new PeerSession(mkOpts(h, 0));
    const cs = new PeerSession(mkOpts(c, 1));
    hs.hostMatch(99);
    cs.joinMatch('h');
    let ms = 0, lastCount = 0;
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < SUB_HZ; i++) {
        net.advanceTo(ms); hs.update(DT, ms); cs.update(DT, ms); ms += DT_MS;
      }
      const n = (tally.count.ping ?? 0) + (tally.count.pong ?? 0);
      perSecond.push(n - lastCount);
      lastCount = n;
    }
    hs.dispose(); cs.dispose();
    return perSecond;
  };

  {
    const clean = pingProfile(0);
    const lossy = pingProfile(0.10);
    console.log('     ping+pong messages in each of 10 successive seconds, ONE client, 60 ms RTT:');
    console.log(`       clean link : ${clean.join('  ')}`);
    console.log(`       10 % loss   : ${lossy.join('  ')}`);
    const first = clean[1], last = clean[9];
    const echoing = last > first + 2;
    defect('the ping/pong keepalive terminates instead of echoing for ever',
      !echoing,
      `one client, clean link: second 2 carried ${first} ping/pong messages, second 10 carried ${last}`
      + (echoing
        ? ` — +${((last - first) / 8).toFixed(0)} msgs/s for every extra second of match, unbounded. `
          + `PeerHost.maybePing() opens a new echo chain every second (an unsolicited 'pong'), `
          + `PeerSession answers every 'pong' with a 'ping' and PeerHost answers every 'ping' with a `
          + `'pong', so no chain ever terminates. Only packet loss breaks a chain: at 10 % loss the `
          + `same run settles at ${lossy[9]} msgs/s`
        : ` — flat: one probe per second and one bounce, ${lossy[9]} msgs/s at 10 % loss`));
  }
}

/* ================================================================== */

section('summary');
console.log(`  ${passed} passed, ${broken.length} convergence invariants broken, ${defects.length} defects proven`);
if (broken.length) { console.log('\n  BROKEN INVARIANTS'); for (const f of broken) console.log(`   - ${f}`); }
if (defects.length) { console.log('\n  PROVEN DEFECTS (not desyncs)'); for (const f of defects) console.log(`   - ${f}`); }
if (broken.length || defects.length) { console.log('\nFAIL'); process.exit(1); }
console.log('\nPASS');
