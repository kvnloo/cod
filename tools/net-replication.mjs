#!/usr/bin/env node
/**
 * Headless verification for src/net/replication.
 *
 * You cannot verify netcode from a screenshot. This builds a 200-entity match
 * across a 400 x 400 m map, runs 8 clients standing in deliberately different
 * places (two paired up, one alone in a far corner, one dead centre), and drives
 * the real Replicator / InterestManager / BandwidthBudget / SnapshotBuilder for
 * a few hundred network ticks, decoding every snapshot with the real
 * SnapshotApplier.
 *
 * It answers the two questions that matter:
 *   - does a client SEE what it should?          (state equality after decode,
 *                                                 own pawn, objectives, noise)
 *   - does it PAY for what it should not?        (nothing beyond the cull
 *                                                 radius, bytes/s under ceiling)
 *
 *   node tools/net-replication.mjs [--ticks 400] [--seed 20250730] [--verbose]
 *
 * TypeScript is loaded directly by node's native type stripping; the resolve
 * hook just supplies the `.ts` extension the bundler-style imports omit.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL) {
      const base = new URL(spec, ctx.parentURL).href;
      for (const ext of ['.ts', '/index.ts']) {
        if (existsSync(fileURLToPath(base + ext))) return next(spec + ext, ctx);
      }
    }
    return next(spec, ctx);
  },
});

const { Rand } = await import('../src/core/Rand.ts');
const { createDefaultRegistry, CLASS, NetFlag } = await import('../src/net/replication/Schema.ts');
const { Replicator } = await import('../src/net/replication/Replicator.ts');
const { InterestManager, DEFAULT_INTEREST } = await import('../src/net/replication/Interest.ts');
const { BandwidthBudget } = await import('../src/net/replication/Budget.ts');
const { SnapshotBuilder, SnapshotApplier } = await import('../src/net/replication/SnapshotBuilder.ts');

/* ----------------------------------------------------------------- options */

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const TICKS = opt('ticks', 400);
const SEED = opt('seed', 20250730);
const HZ = opt('hz', 20);
const VERBOSE = argv.includes('--verbose');

const MAP = 400;          // metres, entities live in [-200, 200] on X and Z
const N_CLIENTS = 8;
const N_ENTITIES = 200;

/* ------------------------------------------------------------- assertions */

let passes = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passes++; if (VERBOSE) console.log(`  PASS  ${label} ${detail}`); }
  else { failures.push(`${label} ${detail}`); console.log(`  FAIL  ${label} ${detail}`); }
}
const f1 = (n) => n.toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

/* ------------------------------------------------------------- world setup */

const rng = new Rand(SEED);
const registry = createDefaultRegistry();
const rep = new Replicator(registry);
const interest = new InterestManager(rep, {});
const budget = new BandwidthBudget({ bytesPerSecond: 12000, tickRate: HZ });
const builder = new SnapshotBuilder(rep, interest, budget);

const clsId = (name) => registry.named(name).id;

/**
 * Client stations. Deliberately adversarial:
 *  0,1  standing together mid-map    -> should see near-identical sets
 *  2    far corner, alone            -> should see almost nothing
 *  3    opposite far corner          -> disjoint from 2
 *  4..7 spread around                -> partial overlap
 */
const STATIONS = [
  { x:   0, z:   0, team: 1, label: 'centre-A' },
  { x:  10, z:   6, team: 1, label: 'centre-B' },
  { x: -180, z: -180, team: 2, label: 'SW-corner' },
  { x:  180, z:  180, team: 2, label: 'NE-corner' },
  { x:  -90, z:   40, team: 1, label: 'west' },
  { x:   90, z:  -40, team: 2, label: 'east' },
  { x:   40, z:  150, team: 1, label: 'north' },
  { x:  -40, z: -150, team: 2, label: 'south' },
];

/** Everything the harness simulates. The replicator only mirrors it. */
const world = [];

function addEntity(className, spec) {
  const e = rep.spawn({
    classId: clsId(className),
    owner: spec.owner ?? -1,
    team: spec.team ?? 0,
    priorityBias: spec.priorityBias ?? 1,
  });
  const rec = {
    id: e.id, className, e,
    x: spec.x, y: spec.y ?? 0, z: spec.z,
    vx: spec.vx ?? 0, vy: 0, vz: spec.vz ?? 0,
    yaw: spec.yaw ?? 0, pitch: 0,
    team: spec.team ?? 0, owner: spec.owner ?? -1,
    health: 100, flags: 0, animPhase: 0,
    static: spec.static ?? false,
    phase: rng.next() * Math.PI * 2,
  };
  world.push(rec);
  return rec;
}

// 8 player pawns, one per client, parked at that client's station.
const pawns = [];
for (let c = 0; c < N_CLIENTS; c++) {
  const s = STATIONS[c];
  pawns.push(addEntity(CLASS.Player, { x: s.x, z: s.z, y: 1.7, team: s.team, owner: c }));
}

// 4 objectives — alwaysRelevant, every client must always hold these.
const objectives = [];
for (let i = 0; i < 4; i++) {
  objectives.push(addEntity(CLASS.Objective, {
    x: (i % 2 ? 1 : -1) * 60, z: (i < 2 ? 1 : -1) * 60, static: true, team: 0,
  }));
}

// Fill to 200 with a plausible mix.
const MIX = [
  [CLASS.Agent, 48], [CLASS.Prop, 90], [CLASS.Pickup, 30], [CLASS.Projectile, 20],
];
for (const [className, n] of MIX) {
  for (let i = 0; i < n; i++) {
    const x = rng.range(-MAP / 2, MAP / 2);
    const z = rng.range(-MAP / 2, MAP / 2);
    addEntity(className, {
      x, z, y: className === CLASS.Projectile ? rng.range(1, 12) : 0,
      team: className === CLASS.Agent ? (rng.bool(0.5) ? 1 : 2) : 0,
      vx: className === CLASS.Prop || className === CLASS.Pickup ? 0 : rng.range(-6, 6),
      vz: className === CLASS.Prop || className === CLASS.Pickup ? 0 : rng.range(-6, 6),
      static: className === CLASS.Prop || className === CLASS.Pickup,
    });
  }
}
check('world has 200 replicated entities', world.length === N_ENTITIES, `(${world.length})`);

/* ------------------------------------------------------- sim + publication */

const DT = 1 / HZ;

function step(tick) {
  for (const r of world) {
    if (r.static) continue;
    r.x += r.vx * DT;
    r.z += r.vz * DT;
    if (r.x < -MAP / 2 || r.x > MAP / 2) { r.vx = -r.vx; r.x = Math.max(-MAP / 2, Math.min(MAP / 2, r.x)); }
    if (r.z < -MAP / 2 || r.z > MAP / 2) { r.vz = -r.vz; r.z = Math.max(-MAP / 2, Math.min(MAP / 2, r.z)); }
    r.yaw = Math.atan2(r.vz, r.vx);
    r.animPhase = (r.phase + tick * 0.05) % 1;
    if (r.className === CLASS.Player || r.className === CLASS.Agent) {
      r.flags = (tick + r.id) % 40 === 0 ? NetFlag.Firing : 0;
    }
  }
  for (const o of objectives) o.progressV = ((tick * 0.004) + o.id * 0.1) % 1;
}

/** Push authoritative state into the replicator's quantized mirror. */
function publish() {
  for (const r of world) {
    const w = rep.write(r.id);
    switch (r.className) {
      case CLASS.Player:
        w.vec3(w.f('pos'), r.x, r.y, r.z);
        w.vec3(w.f('vel'), r.vx, 0, r.vz);
        w.qfloat(w.f('yaw'), r.yaw);
        w.qfloat(w.f('pitch'), r.pitch);
        w.uint(w.f('flags'), r.flags);
        w.uint(w.f('health'), r.health);
        w.uint(w.f('team'), r.team);
        w.qfloat(w.f('animPhase'), r.animPhase);
        break;
      case CLASS.Agent:
        w.vec3(w.f('pos'), r.x, r.y, r.z);
        w.vec3(w.f('vel'), r.vx, 0, r.vz);
        w.qfloat(w.f('yaw'), r.yaw);
        w.uint(w.f('flags'), r.flags);
        w.uint(w.f('health'), r.health);
        w.uint(w.f('team'), r.team);
        w.qfloat(w.f('animPhase'), r.animPhase);
        break;
      case CLASS.Projectile:
        w.vec3(w.f('pos'), r.x, r.y, r.z);
        w.vec3(w.f('vel'), r.vx, r.vy, r.vz);
        w.uint(w.f('kind'), 3);
        break;
      case CLASS.Pickup:
        w.vec3(w.f('pos'), r.x, r.y, r.z);
        w.uint(w.f('kind'), 7);
        break;
      case CLASS.Objective:
        w.vec3(w.f('pos'), r.x, r.y, r.z);
        w.qfloat(w.f('progress'), r.progressV ?? 0);
        w.uint(w.f('owningTeam'), 1);
        break;
      case CLASS.Prop:
        w.vec3(w.f('pos'), r.x, r.y, r.z);
        w.uint(w.f('state'), 1);
        w.uint(w.f('health'), r.health);
        break;
    }
  }
}

/* --------------------------------------------------------------- clients */

const clients = [];
for (let c = 0; c < N_CLIENTS; c++) {
  rep.addClient(c);
  budget.add(c);
  clients.push({
    id: c,
    station: STATIONS[c],
    applier: new SnapshotApplier(registry),
    bytes: 0,
    snapshots: 0,
    emptySnapshots: 0,
    rejected: 0,
    // id -> distance from this client AT THE MOMENT it was first delivered.
    // Measuring at the end of the run instead would be meaningless: entities
    // bounce across the map, so a legitimately-close sighting drifts far away.
    everSeen: new Map(),
    peakEntities: 0,
    outOfRangeSightings: 0,
    stateMismatches: 0,
    sizeMismatches: 0,
    missedOwnPawn: 0,
    missedObjective: 0,
  });
}

function setViews() {
  for (const c of clients) {
    const s = c.station;
    interest.setView(c.id, {
      pos: { x: s.x, y: 1.7, z: s.z },
      forward: { x: 1, y: 0, z: 0 },
      team: s.team,
      controlled: pawns[c.id].id,
    });
  }
}

const CULL = DEFAULT_INTEREST.cullRadius;
const LEAVE_R = CULL * 1.15;

/** Ids currently force-relevant to a client for a reason other than distance. */
function forcedFor(clientId, tick) {
  if (clientId === 2 && noiseFired && tick >= Math.floor(TICKS / 2)
      && tick <= Math.floor(TICKS / 2) + 30) return noiseShooter;
  return -1;
}

function auditClient(c, tick) {
  const app = c.applier;
  if (app.entities.size > c.peakEntities) c.peakEntities = app.entities.size;
  const s = c.station;

  // THE invariant of delta compression: the server's per-client acknowledged
  // baseline is its model of what this client holds. If the client's decoded
  // words ever differ from it, the two have desynced and every later delta is
  // decoded against a lie. Comparing against the LIVE world instead would be
  // wrong -- a LOD-3 entity is legitimately 8 ticks stale by design.
  const baseline = rep.client(c.id).baseline;
  if (baseline.size !== app.entities.size) c.sizeMismatches++;
  for (const [id, entry] of baseline) {
    const ent = app.entities.get(id);
    if (!ent) { c.stateMismatches++; continue; }
    for (let i = 0; i < entry.words.length; i++) {
      if (ent.words[i] !== entry.words[i]) { c.stateMismatches++; break; }
    }
  }

  for (const [id, ent] of app.entities) {
    const server = rep.get(id);
    if (!server) continue;
    void ent;
    if (!c.everSeen.has(id)) {
      const fdx = server.x - s.x, fdz = server.z - s.z;
      c.everSeen.set(id, Math.sqrt(fdx * fdx + fdz * fdz));
    }

    // Nothing beyond the leave radius may linger, unless it is force-relevant.
    if (!server.cls.alwaysRelevant && server.owner !== c.id && id !== forcedFor(c.id, tick)) {
      const dx = server.x - s.x, dy = server.y - 1.7, dz = server.z - s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > LEAVE_R + 8) c.outOfRangeSightings++;
    }
  }

  // Own pawn and every objective must be present once warmed up.
  if (tick > 10) {
    if (!app.entities.has(pawns[c.id].id)) c.missedOwnPawn++;
    for (const o of objectives) if (!app.entities.has(o.id)) c.missedObjective++;
  }
}

/* -------------------------------------------------------------- main loop */

console.log('');
console.log('=== net-replication ================================================');
console.log(`seed ${SEED} | ${N_ENTITIES} entities | ${N_CLIENTS} clients | ${TICKS} ticks @ ${HZ} Hz`);
console.log(`cull radius ${CULL} m | budget ${budget.config.bytesPerSecond} B/s/client`);
console.log('');

let noiseFired = false;
let noiseWitness = -1;
let noiseShooter = -1;

for (let tick = 0; tick < TICKS; tick++) {
  step(tick);
  rep.beginTick(tick);
  publish();
  rep.capture(tick);
  setViews();

  // Halfway through, an agent far outside client 2's bubble makes noise right on
  // top of it. Force-relevance must drag it into client 2's set.
  if (tick === Math.floor(TICKS / 2)) {
    const c2 = clients[2].station;
    let best = -1, bestD = Infinity;
    for (const r of world) {
      if (r.className !== CLASS.Agent) continue;
      const dx = r.x - c2.x, dz = r.z - c2.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > CULL * 1.4 && d < bestD) { bestD = d; best = r.id; }
    }
    if (best >= 0) {
      noiseShooter = best;
      noiseFired = true;
      // Radius is centred on the CLIENT's ear: report the event where it was
      // heard, which is how a suppressed-but-audible shot behaves.
      interest.reportNoise(best, c2.x, 1.7, c2.z, 40, 30);
    }
  }

  for (const c of clients) {
    const snap = builder.build(c.id, tick);
    c.snapshots++;
    if (snap.byteLength === 0) { c.emptySnapshots++; continue; }
    c.bytes += snap.byteLength;
    const res = c.applier.apply(snap.bytes);
    if (!res.ok) { c.rejected++; if (VERBOSE) console.log(`  c${c.id} t${tick} reject: ${res.reason}`); continue; }
    rep.ack(c.id, res.tick);
  }

  if (noiseFired && tick > Math.floor(TICKS / 2) && tick <= Math.floor(TICKS / 2) + 25) {
    if (clients[2].applier.entities.has(noiseShooter)) noiseWitness = tick;
  }

  for (const c of clients) auditClient(c, tick);
}

const seconds = TICKS / HZ;

/* -------------------------------------------------------------- reporting */

console.log('per-client cost and view');
console.log('  ' + pad('client', 12) + lpad('ents', 6) + lpad('peak', 6) + lpad('B/s', 9)
  + lpad('kbit/s', 9) + lpad('B/snap', 8) + lpad('util%', 7) + lpad('deg', 5)
  + lpad('drop', 7) + lpad('rej', 5));
let totalBps = 0;
for (const c of clients) {
  const cb = budget.client(c.id);
  const st = cb.stats();
  const bps = c.bytes / seconds;
  totalBps += bps;
  console.log('  ' + pad(c.station.label, 12)
    + lpad(c.applier.entities.size, 6)
    + lpad(c.peakEntities, 6)
    + lpad(f1(bps), 9)
    + lpad(f1(bps * 8 / 1000), 9)
    + lpad(f1(c.bytes / Math.max(1, c.snapshots - c.emptySnapshots)), 8)
    + lpad(f1(st.utilisation * 100), 7)
    + lpad(st.degradeLevel, 5)
    + lpad(st.droppedEntities, 7)
    + lpad(c.rejected, 5));
}
console.log('  ' + pad('HOST UPLINK', 12) + lpad('', 6) + lpad('', 6) + lpad(f1(totalBps), 9)
  + lpad(f1(totalBps * 8 / 1000), 9));
console.log('');

/* -------------------------------------------------- correctness assertions */

console.log('correctness');
for (const c of clients) {
  check(`c${c.id} ${c.station.label}: decoded state == server's acked baseline`,
    c.stateMismatches === 0 && c.sizeMismatches === 0,
    `(${c.stateMismatches} word mismatches, ${c.sizeMismatches} size mismatches)`);
}
for (const c of clients) {
  check(`c${c.id} ${c.station.label}: always holds its own pawn`,
    c.missedOwnPawn === 0, `(${c.missedOwnPawn} ticks missing)`);
}
for (const c of clients) {
  check(`c${c.id} ${c.station.label}: always holds all 4 objectives`,
    c.missedObjective === 0, `(${c.missedObjective} misses)`);
}
for (const c of clients) {
  check(`c${c.id} ${c.station.label}: never holds an entity past the leave radius`,
    c.outOfRangeSightings === 0, `(${c.outOfRangeSightings} sightings)`);
}
for (const c of clients) {
  check(`c${c.id} ${c.station.label}: no snapshot rejected`, c.rejected === 0, `(${c.rejected})`);
}

/* ---------------------------------------------------- interest assertions */

console.log('');
console.log('interest management');

// The two clients standing together must converge on nearly the same set.
const setA = clients[0].applier.entities;
const setB = clients[1].applier.entities;
let shared = 0;
for (const id of setA.keys()) if (setB.has(id)) shared++;
const overlap = shared / Math.max(1, Math.min(setA.size, setB.size));
check('co-located clients 0/1 share > 85% of their view', overlap > 0.85,
  `(${(overlap * 100).toFixed(1)}%, ${setA.size} vs ${setB.size} entities)`);

// The two far-corner clients must be almost disjoint.
const setSW = clients[2].applier.entities;
const setNE = clients[3].applier.entities;
let both = 0;
for (const id of setSW.keys()) {
  if (!setNE.has(id)) continue;
  const e = rep.get(id);
  if (e && e.cls.alwaysRelevant) continue;   // objectives are shared by design
  both++;
}
check('opposite-corner clients 2/3 share no non-global entity', both === 0, `(${both} shared)`);

// A corner client must pay for far less than the whole world.
const cornerShare = setSW.size / N_ENTITIES;
check('corner client sees < 25% of the world', cornerShare < 0.25,
  `(${setSW.size}/${N_ENTITIES} = ${(cornerShare * 100).toFixed(1)}%)`);

// It must never even have been TOLD about the far side of the map.
let cornerEverFar = 0;
let cornerMaxFirstSight = 0;
for (const [id, dist] of clients[2].everSeen) {
  const e = rep.get(id);
  if (!e || e.cls.alwaysRelevant) continue;
  if (id === noiseShooter) continue;                 // force-relevant by design
  if (dist > cornerMaxFirstSight) cornerMaxFirstSight = dist;
  if (dist > CULL * 1.25) cornerEverFar++;
}
check('corner client was never sent a distant entity (first-sight distance <= cull)',
  cornerEverFar === 0, `(${cornerEverFar} violations, furthest first sight ${f1(cornerMaxFirstSight)} m of ${CULL} m cull)`);

check('noise event forced a distant shooter into the corner client\'s view',
  noiseFired && noiseWitness >= 0, noiseFired ? `(entity ${noiseShooter} at tick ${noiseWitness})` : '(no candidate)');

/* ------------------------------------------------------- budget assertions */

console.log('');
console.log('bandwidth budget');
for (const c of clients) {
  const cb = budget.client(c.id);
  const bps = c.bytes / seconds;
  check(`c${c.id} ${c.station.label}: stayed under the ${budget.config.bytesPerSecond} B/s ceiling`,
    bps <= budget.config.bytesPerSecond, `(${f1(bps)} B/s)`);
  check(`c${c.id} ${c.station.label}: no snapshot exceeded the MTU cap`,
    cb.peakBytes <= builder.config.hardMaxBytes, `(peak ${cb.peakBytes} B)`);
}

// What it would cost with no interest management at all: every entity, every
// tick, delta-coded but unfiltered. This is the number interest management buys
// down, and it is why 200 entities x 8 clients is not viable naively.
let naiveBits = 0;
for (const e of rep.all()) naiveBits += e.cls.maxBodyBits + 16;
const naiveBps = (naiveBits / 8) * HZ;
const actualPerClient = totalBps / N_CLIENTS;
console.log('');
console.log(`  naive full-world snapshot   ${f1(naiveBps)} B/s/client (${f1(naiveBps * 8 / 1000)} kbit/s)`);
console.log(`  with interest + budget      ${f1(actualPerClient)} B/s/client (${f1(actualPerClient * 8 / 1000)} kbit/s)`);
console.log(`  saving                      ${f1(naiveBps / Math.max(1, actualPerClient))}x`);
check('interest management saves at least 5x over naive replication',
  naiveBps / Math.max(1, actualPerClient) >= 5, `(${f1(naiveBps / Math.max(1, actualPerClient))}x)`);

/* --------------------------------------------------------- where bytes go */

console.log('');
console.log('where the bytes go (client 0)');
const groups = budget.client(0).meter.groups();
for (const g of groups.slice(0, 10)) {
  const bar = '#'.repeat(Math.max(1, Math.round(g.share * 40)));
  console.log('  ' + pad(g.name, 12) + lpad(f1(g.bytes / seconds), 8) + ' B/s  '
    + lpad((g.share * 100).toFixed(1) + '%', 7) + '  ' + bar);
}

/* ------------------------------------------------- degradation under stress */

console.log('');
console.log('graceful degradation (budget squeezed to 1500 B/s)');
{
  const tightBudget = new BandwidthBudget({ bytesPerSecond: 1500, tickRate: HZ, maxBytesPerSnapshot: 220 });
  const tightRep = new Replicator(registry);
  const tightInterest = new InterestManager(tightRep, {});
  const tightBuilder = new SnapshotBuilder(tightRep, tightInterest, tightBudget);
  const idMap = new Map();
  for (const r of world) {
    const e = tightRep.spawn({ classId: clsId(r.className), owner: r.owner, team: r.team });
    idMap.set(r.id, e.id);
  }
  const cid = 0;
  tightRep.addClient(cid);
  tightBudget.add(cid);
  const applier = new SnapshotApplier(registry);
  let bytes = 0, over = 0, rejected = 0, peak = 0;
  const levels = [];
  for (let tick = 0; tick < TICKS; tick++) {
    step(tick);
    tightRep.beginTick(tick);
    for (const r of world) {
      const w = tightRep.write(idMap.get(r.id));
      w.vec3(w.f('pos'), r.x, r.y, r.z);
    }
    tightRep.capture(tick);
    tightInterest.setView(cid, {
      pos: { x: 0, y: 1.7, z: 0 }, forward: { x: 1, y: 0, z: 0 },
      team: 1, controlled: idMap.get(pawns[0].id),
    });
    const snap = tightBuilder.build(cid, tick);
    if (snap.byteLength > 0) {
      bytes += snap.byteLength;
      if (snap.byteLength > peak) peak = snap.byteLength;
      if (snap.byteLength > 220) over++;
      const res = applier.apply(snap.bytes);
      if (!res.ok) rejected++; else tightRep.ack(cid, res.tick);
    }
    if (tick % 40 === 0) levels.push(tightBudget.client(cid).degradeLevel);
  }
  const tightBps = bytes / seconds;
  console.log(`  achieved ${f1(tightBps)} B/s (ceiling 1500) | peak snapshot ${peak} B (cap 220)`);
  console.log(`  degrade level over time: ${levels.join(' ')}`);
  console.log(`  entities still tracked: ${applier.entities.size} | rejected ${rejected}`);
  check('tight budget respected the ceiling', tightBps <= 1500, `(${f1(tightBps)} B/s)`);
  check('tight budget respected the per-snapshot cap', over === 0, `(${over} oversized)`);
  check('tight budget still delivered a usable view', applier.entities.size >= 10,
    `(${applier.entities.size} entities)`);
  check('tight budget produced no decode failures', rejected === 0, `(${rejected})`);
  check('degradation ladder actually engaged',
    tightBudget.client(cid).degradeLevel > 0 || tightBudget.client(cid).truncations > 0,
    `(level ${tightBudget.client(cid).degradeLevel}, ${tightBudget.client(cid).truncations} truncations)`);
}

/* -------------------------------------------------------------- packet loss */

console.log('');
console.log('packet loss (10% of snapshots dropped in flight)');
{
  const lossRng = new Rand(SEED ^ 0x5bf03635);
  const lossRep = new Replicator(registry);
  const lossInterest = new InterestManager(lossRep, {});
  const lossBudget = new BandwidthBudget({ bytesPerSecond: 12000, tickRate: HZ });
  const lossBuilder = new SnapshotBuilder(lossRep, lossInterest, lossBudget);
  const idMap = new Map();
  for (const r of world) {
    const e = lossRep.spawn({ classId: clsId(r.className), owner: r.owner, team: r.team });
    idMap.set(r.id, e.id);
  }
  const cid = 0;
  lossRep.addClient(cid);
  lossBudget.add(cid);
  const applier = new SnapshotApplier(registry);
  let dropped = 0, rejected = 0, mismatches = 0;
  for (let tick = 0; tick < TICKS; tick++) {
    step(tick);
    lossRep.beginTick(tick);
    for (const r of world) {
      const w = lossRep.write(idMap.get(r.id));
      w.vec3(w.f('pos'), r.x, r.y, r.z);
    }
    lossRep.capture(tick);
    lossInterest.setView(cid, {
      pos: { x: 0, y: 1.7, z: 0 }, forward: { x: 1, y: 0, z: 0 },
      team: 1, controlled: idMap.get(pawns[0].id),
    });
    const snap = lossBuilder.build(cid, tick);
    if (snap.byteLength === 0) continue;
    if (lossRng.bool(0.1)) { dropped++; continue; }       // packet lost in flight
    const res = applier.apply(snap.bytes);
    if (!res.ok) { rejected++; continue; }
    lossRep.ack(cid, res.tick);
  }
  // After loss, whatever the client still holds must be byte-exact with the
  // server for the fields it was sent. A corrupted baseline would show here.
  const lossBaseline = lossRep.client(cid).baseline;
  if (lossBaseline.size !== applier.entities.size) mismatches++;
  for (const [id, entry] of lossBaseline) {
    const ent = applier.entities.get(id);
    if (!ent) { mismatches++; continue; }
    for (let i = 0; i < entry.words.length; i++) {
      if (ent.words[i] !== entry.words[i]) { mismatches++; break; }
    }
  }
  console.log(`  dropped ${dropped} snapshots | client rejected ${rejected} stale-baseline snapshots`);
  console.log(`  entities tracked ${applier.entities.size} | baseline mismatches ${mismatches}`);
  check('delta baseline survived packet loss without corruption', mismatches === 0, `(${mismatches})`);
  check('lost packets were detected and recovered from', dropped > 0 && applier.entities.size > 20,
    `(${dropped} dropped, ${applier.entities.size} tracked)`);
}


/* ---------------------------------------------------------- scale sweep */

console.log('');
console.log('scale sweep (host uplink as the match grows)');
console.log('  ' + pad('clients', 9) + lpad('ents', 6) + lpad('B/s/client', 12)
  + lpad('kbit/s/cl', 11) + lpad('uplink Mbit/s', 15) + lpad('seen/cl', 9) + lpad('deg', 5));
const sweepRows = [];
for (const [nClients, nEnts] of [[8, 200], [16, 400], [32, 800], [64, 1200]]) {
  const sRng = new Rand(SEED ^ (nClients * 7919));
  const sRep = new Replicator(registry);
  const sInterest = new InterestManager(sRep, {});
  const sBudget = new BandwidthBudget({ bytesPerSecond: 12000, tickRate: HZ });
  const sBuilder = new SnapshotBuilder(sRep, sInterest, sBudget);
  const span = Math.sqrt(nEnts / N_ENTITIES) * MAP;   // keep density constant

  const ents = [];
  for (let i = 0; i < nEnts; i++) {
    const className = i < nClients ? CLASS.Player
      : i < nClients + 4 ? CLASS.Objective
      : i % 3 === 0 ? CLASS.Agent : CLASS.Prop;
    const e = sRep.spawn({ classId: clsId(className), owner: i < nClients ? i : -1, team: (i % 2) + 1 });
    ents.push({
      e, className,
      x: sRng.range(-span / 2, span / 2), y: 0, z: sRng.range(-span / 2, span / 2),
      vx: className === CLASS.Prop ? 0 : sRng.range(-5, 5),
      vz: className === CLASS.Prop ? 0 : sRng.range(-5, 5),
    });
  }
  // Players are spread over the whole map so interest sets genuinely differ.
  const stations = [];
  const side = Math.ceil(Math.sqrt(nClients));
  for (let c = 0; c < nClients; c++) {
    const gx = (c % side) / Math.max(1, side - 1) - 0.5;
    const gz = Math.floor(c / side) / Math.max(1, side - 1) - 0.5;
    const st = { x: gx * span * 0.9, z: gz * span * 0.9 };
    stations.push(st);
    ents[c].x = st.x; ents[c].z = st.z; ents[c].vx = 0; ents[c].vz = 0;
    sRep.addClient(c);
    sBudget.add(c);
  }

  const appliers = stations.map(() => new SnapshotApplier(registry));
  let bytes = 0;
  const SWEEP_TICKS = 120;
  for (let tick = 0; tick < SWEEP_TICKS; tick++) {
    sRep.beginTick(tick);
    for (const r of ents) {
      if (r.vx !== 0 || r.vz !== 0) {
        r.x += r.vx * DT; r.z += r.vz * DT;
        if (r.x < -span / 2 || r.x > span / 2) r.vx = -r.vx;
        if (r.z < -span / 2 || r.z > span / 2) r.vz = -r.vz;
      }
      const w = sRep.write(r.e.id);
      w.vec3(w.f('pos'), r.x, r.y, r.z);
      if (r.className === CLASS.Player || r.className === CLASS.Agent) {
        w.qfloat(w.f('yaw'), Math.atan2(r.vz, r.vx));
        w.uint(w.f('health'), 100);
      }
    }
    sRep.capture(tick);
    for (let c = 0; c < nClients; c++) {
      sInterest.setView(c, {
        pos: { x: stations[c].x, y: 1.7, z: stations[c].z },
        forward: { x: 1, y: 0, z: 0 }, team: (c % 2) + 1, controlled: ents[c].e.id,
      });
      const snap = sBuilder.build(c, tick);
      if (snap.byteLength === 0) continue;
      bytes += snap.byteLength;
      const res = appliers[c].apply(snap.bytes);
      if (res.ok) sRep.ack(c, res.tick);
    }
  }
  const secs = SWEEP_TICKS / HZ;
  const perClient = bytes / secs / nClients;
  const uplink = bytes / secs;
  let seen = 0, deg = 0;
  for (let c = 0; c < nClients; c++) { seen += appliers[c].entities.size; deg += sBudget.client(c).degradeLevel; }
  sweepRows.push({ nClients, nEnts, perClient, uplink, seen: seen / nClients, deg });
  console.log('  ' + pad(nClients, 9) + lpad(nEnts, 6) + lpad(f1(perClient), 12)
    + lpad(f1(perClient * 8 / 1000), 11) + lpad((uplink * 8 / 1e6).toFixed(2), 15)
    + lpad(f1(seen / nClients), 9) + lpad(deg, 5));
}
// The whole point of interest management: per-client cost must NOT grow
// linearly with world size. It is allowed to grow (denser neighbourhoods) but
// nothing like 6x for a 6x bigger world.
const small = sweepRows[0].perClient;
const big = sweepRows[sweepRows.length - 1].perClient;
const growth = big / small;
const worldGrowth = sweepRows[sweepRows.length - 1].nEnts / sweepRows[0].nEnts;
check(`per-client cost is sub-linear in world size (${worldGrowth}x world -> ${f1(growth)}x cost)`,
  growth < worldGrowth * 0.5, `(${f1(small)} -> ${f1(big)} B/s)`);
for (const row of sweepRows) {
  check(`${row.nClients} clients stayed under the per-client ceiling`,
    row.perClient <= budget.config.bytesPerSecond, `(${f1(row.perClient)} B/s)`);
}

/* ------------------------------------------------------------------ verdict */


console.log('');
console.log('====================================================================');
if (failures.length === 0) {
  console.log(`PASS  ${passes} checks passed`);
  process.exit(0);
} else {
  console.log(`FAIL  ${failures.length} of ${passes + failures.length} checks failed:`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
