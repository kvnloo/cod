#!/usr/bin/env node
/**
 * net-bandwidth — what this netcode actually costs on a wire.
 *
 * Everything printed here is MEASURED, not modelled. One authoritative match is
 * simulated (real `PeerHost`, real `AuthorityCore`, real combat, real
 * `LoopbackNetwork`) and the identical world is fed to BOTH snapshot encoders
 * that exist in this tree:
 *
 *   PATH A — the shipping host path: `DeltaSnapshotWriter` -> `JsonCodec` ->
 *            `Transport.send`. This is what a player runs today. Bytes are
 *            counted at the transport, i.e. after encoding, and attributed by
 *            message kind and by entity kind inside a snapshot.
 *
 *   PATH B — the bit-packed replication path: `Replicator` + `InterestManager`
 *            + `BandwidthBudget` + `SnapshotBuilder`, fed the same
 *            authoritative entities on the same ticks and decoded by the real
 *            `SnapshotApplier`, so a byte count that cannot be decoded is never
 *            reported as a success.
 *
 * Sections:
 *   1  scaling sweep 8/16/32/64, interest ON and OFF, both paths
 *   2  budget + degradation behaviour
 *   3  ack-latency sensitivity (delta baselines under real RTT)
 *   4  interest levers: cull radius and entity cap
 *   5  quantisation variants, re-encoded end to end
 *   6  structural overhead: id chain and field mask
 *   7  verdict against the docs/NETCODE.md budget
 *
 * Usage: node tools/net-bandwidth.mjs [--seconds 16] [--seed N] [--quick] [--verbose]
 */

import './net-ts-loader.mjs';

const { Rand } = await import('../src/core/Rand.ts');
const { PeerHost } = await import('../src/net/host/PeerHost.ts');
const { ArenaSim } = await import('../src/net/host/DefaultSim.ts');
const { LoopbackNetwork, PERFECT_LINK } =
  await import('../src/net/host/testing/LoopbackTransport.ts');
const { BTN, ENT, ENTITY_FLAG, PROTOCOL_VERSION } = await import('../src/net/host/types.ts');
const { SnapshotReader } = await import('../src/net/host/SnapshotWriter.ts');
const { DATAGRAM_OVERHEAD_BYTES } = await import('../src/net/Protocol.ts');

const { createDefaultRegistry, CLASS, NetFlag, SchemaRegistry } =
  await import('../src/net/replication/Schema.ts');
const { Replicator } = await import('../src/net/replication/Replicator.ts');
const { InterestManager, DEFAULT_INTEREST } = await import('../src/net/replication/Interest.ts');
const { BandwidthBudget, DEFAULT_BUDGET } = await import('../src/net/replication/Budget.ts');
const { SnapshotBuilder, SnapshotApplier, varUintBits } =
  await import('../src/net/replication/SnapshotBuilder.ts');

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const num = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d;
};
const QUICK = flag('quick');
const SECONDS = num('seconds', QUICK ? 6 : 16);
const SEED = num('seed', 20260730);
const VERBOSE = flag('verbose');

/* --------------------------------------------------------------- helpers */

const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '-');
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);
const kbit = (bps) => (bps * 8) / 1000;
const mbit = (bps) => (bps * 8) / 1e6;
const jsonBytes = (v) => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v), 'utf8'));

let passes = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passes++; if (VERBOSE) console.log(`      ok   ${label} ${detail}`); }
  else { failures.push(`${label} ${detail}`); console.log(`      FAIL ${label} ${detail}`); }
}

/** ~1 player per 1250 m^2, which is roughly a 6v6 CoD map scaled up. */
const halfExtentFor = (players) => Math.round(Math.sqrt((players * 1250) / 4));

/** Snapshot Hz from the contract's SNAPSHOT_HZ_BY_PLAYER_COUNT (64 extends 32). */
const snapshotHzFor = (players) => (players <= 8 ? 30 : players <= 16 ? 20 : 15);

/* ------------------------------------------------------------------------ */
/*  Match sim: ArenaSim players + real grenades                              */
/* ------------------------------------------------------------------------ */

const GRENADE_FUSE_SEC = 2.2;

class MatchSim {
  constructor(tickRate, halfExtent) {
    this.arena = new ArenaSim(tickRate, { halfExtent, maxRange: halfExtent * 2.5 });
    this.name = 'match';
    this.dt = this.arena.dt;
    this.tickRate = tickRate;
  }

  spawnPlayer(state, ent, rand) { this.arena.spawnPlayer(state, ent, rand); }

  step(state, commands, rand, ops) {
    this.arena.step(state, commands, rand, ops);
    const dt = this.dt;
    const h = this.arena.cfg.halfExtent;

    for (const [clientId, cmd] of commands) {
      if ((cmd.buttons & BTN.USE) === 0) continue;
      const slot = state.players.get(clientId);
      if (!slot) continue;
      const owner = state.entities.get(slot.entityId);
      if (!owner || (owner.flags & ENTITY_FLAG.DEAD) !== 0) continue;
      if (owner.nextFireTick > ops.tick) continue;
      const p = ops.spawn(ENT.PROJECTILE, clientId);
      const cp = Math.cos(owner.pitch + 0.35);
      p.px = owner.px; p.py = owner.py + 1.5; p.pz = owner.pz;
      p.vx = -Math.sin(owner.yaw) * cp * 18;
      p.vy = Math.sin(owner.pitch + 0.35) * 18 + 3;
      p.vz = -Math.cos(owner.yaw) * cp * 18;
      p.team = owner.team;
      p.weapon = 1;
      p.respawnTick = ops.tick + Math.round(GRENADE_FUSE_SEC * this.tickRate);
      owner.nextFireTick = ops.tick + 20;
      ops.emit('grenade', owner.id, p.id, p.px, p.py, p.pz, 0);
    }

    const ids = [...state.entities.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const p = state.entities.get(id);
      if (!p || p.kind !== ENT.PROJECTILE) continue;
      p.vy += this.arena.cfg.gravity * dt;
      p.px += p.vx * dt; p.py += p.vy * dt; p.pz += p.vz * dt;
      if (p.py < 0) { p.py = 0; p.vy = -p.vy * 0.25; p.vx *= 0.6; p.vz *= 0.6; }
      if (p.px < -h || p.px > h) { p.px = Math.max(-h, Math.min(h, p.px)); p.vx = -p.vx * 0.5; }
      if (p.pz < -h || p.pz > h) { p.pz = Math.max(-h, Math.min(h, p.pz)); p.vz = -p.vz * 0.5; }
      if (ops.tick >= p.respawnTick) {
        ops.emit('explode', p.id, p.owner, p.px, p.py, p.pz, 90);
        for (const tid of ids) {
          const t = state.entities.get(tid);
          if (!t || t.kind !== ENT.PLAYER) continue;
          const dx = t.px - p.px, dy = t.py - p.py, dz = t.pz - p.pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 6) ops.damage(t.id, 90 * (1 - d / 6), p.id, false);
        }
        ops.despawn(p.id);
      }
    }
  }
}

/* ------------------------------------------------------------------------ */
/*  Bots                                                                     */
/* ------------------------------------------------------------------------ */

function wrapAngle(a) {
  const two = Math.PI * 2;
  let v = a % two;
  if (v > Math.PI) v -= two;
  if (v < -Math.PI) v += two;
  return v;
}

class Bot {
  constructor(seed, tickRate) {
    this.rand = new Rand(seed);
    this.tickRate = tickRate;
    this.yaw = this.rand.range(-Math.PI, Math.PI);
    this.pitch = 0;
    this.targetYaw = this.yaw;
    this.moveX = 0; this.moveZ = 1;
    this.seq = 0; this.until = 0; this.burst = 0;
  }

  command(tick) {
    const r = this.rand;
    if (tick >= this.until) {
      this.until = tick + Math.round(r.range(0.3, 1.4) * this.tickRate);
      this.targetYaw = this.yaw + r.range(-2.2, 2.2);
      this.moveX = r.bool(0.45) ? (r.bool(0.5) ? 1 : -1) : 0;
      this.moveZ = r.bool(0.8) ? 1 : (r.bool(0.5) ? -1 : 0);
      if (r.bool(0.18)) this.burst = Math.round(r.range(2, 9));
    }
    this.yaw += (this.targetYaw - this.yaw) * 0.18;
    this.pitch += (r.range(-0.35, 0.25) - this.pitch) * 0.06;
    let buttons = 0;
    if (this.burst > 0) { buttons |= BTN.FIRE; this.burst--; }
    else if (r.bool(0.35)) buttons |= BTN.SPRINT;
    if (r.bool(0.012)) buttons |= BTN.JUMP;
    if (r.bool(0.05)) buttons |= BTN.CROUCH;
    if (r.bool(0.004)) buttons |= BTN.USE;
    if (r.bool(0.006)) buttons |= BTN.RELOAD;
    return {
      tick, seq: this.seq++,
      moveX: this.moveX, moveZ: this.moveZ,
      yaw: wrapAngle(this.yaw), pitch: this.pitch, buttons,
    };
  }
}

/* ------------------------------------------------------------------------ */
/*  Registry cloning: group namespacing + quantisation variants              */
/* ------------------------------------------------------------------------ */

/**
 * Rebuilds the shipping registry from its COMPILED classes (never from a copy
 * of the source), renaming every field group to `<class>.<group>` so the meter
 * can answer "what do projectiles cost". `mutate` may edit or drop a field to
 * produce a quantisation variant. `assertRegistryClone` proves the unmutated
 * clone is bit-identical to the real schema before any number is believed.
 */
function cloneRegistry(src, mutate = null) {
  const out = new SchemaRegistry();
  for (let id = 0; ; id++) {
    const cls = src.tryGet(id);
    if (!cls) break;
    const posName = cls.positionWord >= 0
      ? cls.fields.find((f) => f.wordOffset === cls.positionWord && f.kind === 'qvec3').name
      : undefined;
    const fields = [];
    for (const f of cls.fields) {
      // Group is namespaced by CLASS and named by FIELD: the class prefix is what
      // the category table buckets on, the field name is what the "where did the
      // bytes go" table needs. The shipping schema's own coarse groups
      // ('transform' covers pos AND vel) cannot answer either question.
      const d = { name: f.name, kind: f.kind, maxLod: f.maxLod, group: `${cls.name}.${f.name}` };
      switch (f.kind) {
        case 'uint': case 'int': d.bits = f.words[0].bits; break;
        case 'qfloat': {
          const bits = f.words[0].bits;
          d.min = f.min; d.step = f.step;
          d.max = f.min + ((1 << bits) - 1) * f.step;
          break;
        }
        case 'qvec3': d.step = f.step; d.min = f.min; d.max = 2048; break;
        default: break;
      }
      const m = mutate ? mutate(cls.name, d) : d;
      if (m) fields.push(m);
    }
    out.define({
      name: cls.name, fields,
      basePriority: cls.basePriority,
      alwaysRelevant: cls.alwaysRelevant,
      positionField: posName,
    });
  }
  return out;
}

function assertRegistryClone(src, clone) {
  let ok = src.hash() === clone.hash() && src.count === clone.count;
  for (let id = 0; id < src.count && ok; id++) {
    const a = src.get(id), b = clone.get(id);
    if (a.wordCount !== b.wordCount || a.fields.length !== b.fields.length
      || a.positionWord !== b.positionWord) { ok = false; break; }
    for (let i = 0; i < a.fields.length; i++) {
      const x = a.fields[i], y = b.fields[i];
      if (x.name !== y.name || x.kind !== y.kind || x.maxLod !== y.maxLod
        || x.step !== y.step || x.min !== y.min || x.wordCount !== y.wordCount
        || x.maxBits !== y.maxBits) { ok = false; break; }
      for (let w = 0; w < x.words.length; w++) {
        if (x.words[w].bits !== y.words[w].bits || x.words[w].mode !== y.words[w].mode
          || x.words[w].bias !== y.words[w].bias) { ok = false; break; }
      }
    }
  }
  return ok;
}

const INTEREST_OFF = {
  cellSize: 4096, cullRadius: 20000,
  lodDistances: [1e7, 1e7, 1e7], lodIntervals: [1, 1, 1, 1],
  maxEntitiesPerTick: 1e6, forceResendTicks: 1e9,
};

const UNLIMITED_BUDGET = {
  bytesPerSecond: 1e9, burstTicks: 3,
  maxBytesPerSnapshot: 1e6, minBytesPerSnapshot: 64,
};

/* ------------------------------------------------------------------------ */
/*  A replication stack                                                      */
/* ------------------------------------------------------------------------ */

class RepStack {
  constructor(spec, hz, tickStride) {
    this.label = spec.label;
    /** Host ticks between snapshots — ack lag is expressed in SNAPSHOTS, not ticks. */
    this.tickStride = tickStride;
    this.buildMs = 0;
    this.builds = 0;
    this.registry = spec.registry;
    this.rep = new Replicator(spec.registry);
    this.interest = new InterestManager(this.rep,
      spec.interestOn === false ? INTEREST_OFF : (spec.interest ?? {}));
    this.budget = new BandwidthBudget(spec.budgeted
      ? { ...DEFAULT_BUDGET, tickRate: hz }
      : { ...DEFAULT_BUDGET, ...UNLIMITED_BUDGET, tickRate: hz });
    this.builder = new SnapshotBuilder(this.rep, this.interest, this.budget,
      spec.budgeted ? {} : { hardMaxBytes: 200000 });
    this.ackDelay = spec.ackDelay ?? 1;
    this.clients = new Map();
    this.ackQueue = [];
    this.mirrored = new Set();
    this.classBits = new Map();
    this.groupBits = new Map();
    this.lastMask = new Map();          // clientId -> Map<entityId, mask>
    this.maskRepeat = 0; this.maskTotal = 0; this.maskBitsTotal = 0;
    this.idBitsTotal = 0; this.idSmallDeltas = 0; this.idUpdates = 0;
    this.snapshots = 0; this.bytes = 0; this.dropped = 0; this.truncated = 0;
    this.consideredTotal = 0; this.updatesTotal = 0; this.spawnsTotal = 0;
    this.meterBits = 0;
    this.structuralCheck = { computed: 0, metered: 0 };
    this.degradeSum = 0; this.degradeSamples = 0; this.degradeMax = 0;
  }

  addClient(clientId) {
    this.rep.addClient(clientId);
    this.budget.add(clientId);
    this.clients.set(clientId, {
      applier: new SnapshotApplier(this.registry),
      bytes: 0, snaps: 0, empty: 0, rejected: 0, applied: 0, wireBytes: 0,
      rejectedBytes: 0,
    });
    this.lastMask.set(clientId, new Map());
  }

  bucket(cls) {
    let b = this.classBits.get(cls);
    if (!b) { b = { fields: 0, structural: 0, updates: 0 }; this.classBits.set(cls, b); }
    return b;
  }

  reset() {
    this.snapshots = 0; this.bytes = 0; this.dropped = 0; this.truncated = 0;
    this.consideredTotal = 0; this.updatesTotal = 0; this.spawnsTotal = 0;
    this.meterBits = 0;
    this.classBits.clear(); this.groupBits.clear();
    this.maskRepeat = 0; this.maskTotal = 0; this.maskBitsTotal = 0;
    this.idBitsTotal = 0; this.idSmallDeltas = 0; this.idUpdates = 0;
    this.structuralCheck = { computed: 0, metered: 0 };
    this.degradeSum = 0; this.degradeSamples = 0; this.degradeMax = 0;
    this.buildMs = 0; this.builds = 0;
    for (const c of this.clients.values()) {
      c.bytes = 0; c.snaps = 0; c.empty = 0; c.rejected = 0; c.applied = 0;
      c.wireBytes = 0; c.rejectedBytes = 0;
    }
    for (const id of this.clients.keys()) this.budget.client(id).reset();
  }

  /** Aggregate over clients that actually received something. */
  summary(seconds) {
    const cl = [...this.clients.values()].filter((c) => c.snaps > 0);
    const bytes = cl.reduce((a, c) => a + c.bytes, 0);
    const wire = cl.reduce((a, c) => a + c.wireBytes, 0);
    const rejected = cl.reduce((a, c) => a + c.rejected, 0);
    const rejBytes = cl.reduce((a, c) => a + c.rejectedBytes, 0);
    const snaps = cl.reduce((a, c) => a + c.snaps, 0);
    const empty = cl.reduce((a, c) => a + c.empty, 0);
    const n = Math.max(1, cl.length);
    return {
      clients: cl.length, bytes, wire, rejected, rejBytes, snaps, empty,
      perClient: bytes / n / seconds,
      perClientWire: wire / n / seconds,
      uplinkMbit: mbit(wire / seconds),
      bytesPerSnap: bytes / Math.max(1, snaps - empty),
      entsPerSnap: this.updatesTotal / Math.max(1, snaps - empty),
      candPerSnap: this.consideredTotal / Math.max(1, snaps),
      degradeMean: this.degradeSamples ? this.degradeSum / this.degradeSamples : 0,
      degradeMax: this.degradeMax,
      usPerBuild: this.builds ? (this.buildMs * 1000) / this.builds : 0,
      buildMs: this.buildMs,
    };
  }
}

/* ------------------------------------------------------------------------ */
/*  Mirror the authority's world into a Replicator                           */
/* ------------------------------------------------------------------------ */

const KIND_TO_CLASS = {
  [ENT.PLAYER]: CLASS.Player,
  [ENT.PROJECTILE]: CLASS.Projectile,
  [ENT.PICKUP]: CLASS.Pickup,
  [ENT.OBJECTIVE]: CLASS.Objective,
};

function hostFlagsToNet(f) {
  let out = 0;
  if (f & ENTITY_FLAG.FIRING) out |= NetFlag.Firing;
  if (f & ENTITY_FLAG.SPRINT) out |= NetFlag.Sprinting;
  if (f & ENTITY_FLAG.CROUCH) out |= NetFlag.Crouched;
  if (f & ENTITY_FLAG.DEAD) out |= NetFlag.Dead;
  if (f & ENTITY_FLAG.AIRBORNE) out |= NetFlag.Airborne;
  return out;
}

function has(cls, name) { return cls.fieldIndex.has(name); }

function mirrorWorld(stack, state, tick) {
  const rep = stack.rep;
  rep.beginTick(tick);
  for (const e of state.entities.values()) {
    const clsName = KIND_TO_CLASS[e.kind];
    if (!clsName) continue;
    if (!stack.mirrored.has(e.id)) {
      rep.spawn({
        id: e.id, classId: stack.registry.named(clsName).id,
        owner: e.owner ?? -1, team: e.team ?? 0,
      });
      stack.mirrored.add(e.id);
    }
    const w = rep.write(e.id);
    const cls = stack.registry.named(clsName);
    switch (e.kind) {
      case ENT.PLAYER: {
        w.vec3(w.f('pos'), e.px, e.py, e.pz);
        if (has(cls, 'vel')) w.vec3(w.f('vel'), e.vx, e.vy, e.vz);
        w.qfloat(w.f('yaw'), e.yaw);
        w.qfloat(w.f('pitch'), e.pitch);
        w.uint(w.f('flags'), hostFlagsToNet(e.flags));
        if (has(cls, 'moveState')) {
          w.uint(w.f('moveState'), (e.flags & ENTITY_FLAG.CROUCH) ? 2 : (e.flags & ENTITY_FLAG.SPRINT) ? 1 : 0);
        }
        w.uint(w.f('weapon'), e.weapon);
        w.uint(w.f('health'), e.health);
        if (has(cls, 'armor')) w.uint(w.f('armor'), e.armor);
        w.uint(w.f('team'), e.team);
        const sp = Math.hypot(e.vx, e.vz);
        if (has(cls, 'animPhase')) w.qfloat(w.f('animPhase'), ((tick * sp * 0.03) % 1 + 1) % 1);
        if (has(cls, 'lean')) w.qfloat(w.f('lean'), 0);
        break;
      }
      case ENT.PROJECTILE:
        w.vec3(w.f('pos'), e.px, e.py, e.pz);
        if (has(cls, 'vel')) w.vec3(w.f('vel'), e.vx, e.vy, e.vz);
        w.uint(w.f('kind'), e.weapon);
        w.uint(w.f('owner'), e.owner);
        if (has(cls, 'fuse')) w.qfloat(w.f('fuse'), Math.max(0, (e.respawnTick - tick) / 30));
        break;
      case ENT.PICKUP:
        w.vec3(w.f('pos'), e.px, e.py, e.pz);
        w.uint(w.f('kind'), e.weapon);
        w.uint(w.f('state'), e.health > 0 ? 1 : 0);
        if (has(cls, 'respawnIn')) w.qfloat(w.f('respawnIn'), 0);
        break;
      case ENT.OBJECTIVE:
        w.vec3(w.f('pos'), e.px, e.py, e.pz);
        w.qfloat(w.f('progress'), (tick % 400) / 400);
        w.uint(w.f('owningTeam'), e.team);
        w.bool(w.f('contested'), (tick % 200) < 100);
        w.uint(w.f('state'), 1);
        break;
      default: break;
    }
  }
  for (const id of [...stack.mirrored]) {
    if (!state.entities.has(id)) { rep.despawn(id); stack.mirrored.delete(id); }
  }
  rep.capture(tick);
}

/* ------------------------------------------------------------------------ */
/*  Stack stepping + instrumentation                                         */
/* ------------------------------------------------------------------------ */

function snapshotGroups(meter) {
  const m = new Map();
  for (const g of meter.groups()) m.set(g.name, g.bits);
  return m;
}

function accumulateGroups(st, meter, before) {
  for (const g of meter.groups()) {
    const delta = g.bits - (before.get(g.name) ?? 0);
    if (delta <= 0) continue;
    st.groupBits.set(g.name, (st.groupBits.get(g.name) ?? 0) + delta);
    const dot = g.name.indexOf('.');
    if (dot > 0) st.bucket(g.name.slice(0, dot)).fields += delta;
    else if (g.name === 'ids' || g.name === 'mask' || g.name === 'spawn') {
      st.structuralCheck.metered += delta;
    }
  }
}

function stepStack(st, host, tick, clients, measuring) {
  const state = host.core.state;
  mirrorWorld(st, state, tick);

  for (const c of clients) {
    if (c.clientId && !st.clients.has(c.clientId)) st.addClient(c.clientId);
  }
  while (st.ackQueue.length && st.ackQueue[0].at <= tick) {
    const a = st.ackQueue.shift();
    if (st.clients.has(a.client)) st.rep.ack(a.client, a.tick);
  }
  for (const c of clients) {
    if (!c.clientId) continue;
    const slot = state.players.get(c.clientId);
    const own = slot ? state.entities.get(slot.entityId) : null;
    if (!own) continue;
    st.interest.setView(c.clientId, {
      pos: { x: own.px, y: own.py + 1.6, z: own.pz },
      forward: { x: -Math.sin(own.yaw), y: 0, z: -Math.cos(own.yaw) },
      team: own.team, controlled: own.id,
    });
  }

  for (const c of clients) {
    if (!c.clientId) continue;
    const cs = st.rep.client(c.clientId);
    const had = new Set(cs.baseline.keys());
    const cb = st.budget.client(c.clientId);
    const beforeMeter = cb.meter.totalBits;
    const beforeGroups = snapshotGroups(cb.meter);

    const bt0 = performance.now();
    const res = st.builder.build(c.clientId, tick);
    const bt1 = performance.now();
    const rec = st.clients.get(c.clientId);
    if (measuring) { st.buildMs += bt1 - bt0; st.builds++; }

    if (measuring) {
      rec.snaps++;
      st.snapshots++;
      st.consideredTotal += res.considered;
      st.dropped += res.dropped;
      if (res.truncated) st.truncated++;
      st.degradeSum += res.degradeLevel;
      st.degradeSamples++;
      if (res.degradeLevel > st.degradeMax) st.degradeMax = res.degradeLevel;
    }

    if (res.byteLength === 0) { if (measuring) rec.empty++; continue; }

    if (measuring) {
      rec.bytes += res.byteLength;
      rec.wireBytes += res.byteLength + DATAGRAM_OVERHEAD_BYTES;
      st.bytes += res.byteLength;
      st.updatesTotal += res.updates;
      st.spawnsTotal += res.spawns;
      st.meterBits += cb.meter.totalBits - beforeMeter;
      accumulateGroups(st, cb.meter, beforeGroups);

      // Exact per-class structural cost, mirroring SnapshotBuilder's writer.
      const pending = cs.pending.get(tick);
      const masks = st.lastMask.get(c.clientId);
      if (pending) {
        let prevId = 0;
        for (const u of pending.updates) {
          const cls = st.registry.get(u.classId);
          const spawn = !had.has(u.id);
          const idDelta = u.id - prevId;
          const idBits = varUintBits(idDelta);
          let bits = idBits + 1 + cls.fields.length;
          if (spawn) bits += varUintBits(u.classId);
          prevId = u.id;
          const b = st.bucket(cls.name);
          b.structural += bits;
          b.updates++;
          st.structuralCheck.computed += bits;
          st.idBitsTotal += idBits;
          st.idUpdates++;
          if (idDelta >= 1 && idDelta <= 15) st.idSmallDeltas++;
          st.maskBitsTotal += cls.fields.length;
          st.maskTotal++;
          if (!spawn && masks.get(u.id) === u.mask) st.maskRepeat++;
          masks.set(u.id, u.mask);
        }
      }
    }

    const ar = rec.applier.apply(res.bytes);
    if (ar.ok) {
      if (measuring) rec.applied++;
      st.ackQueue.push({ at: tick + st.ackDelay * st.tickStride, client: c.clientId, tick: ar.tick });
    } else if (measuring) {
      rec.rejected++;
      rec.rejectedBytes += res.byteLength;
      if (VERBOSE) console.log(`      [${st.label}] c${c.clientId} t${tick}: ${ar.reason}`);
    }
  }
}

/* ------------------------------------------------------------------------ */
/*  One scenario                                                             */
/* ------------------------------------------------------------------------ */

function runScenario(opts) {
  const {
    players, tickRate, snapshotIntervalTicks, seconds, link = PERFECT_LINK, seed,
    halfExtent = halfExtentFor(players), stackSpecs = [], pathA = true,
    hostConfig = {}, thriftyClient = false, decodePathA = false,
  } = opts;

  const snapshotHz = tickRate / snapshotIntervalTicks;
  const net = new LoopbackNetwork(seed, link);
  const hostPort = net.createPort('host');

  const A = {
    perClient: new Map(), datagrams: 0, upstreamBytes: 0, upstreamDatagrams: 0,
  };
  const acc = (peer) => {
    let a = A.perClient.get(peer);
    if (!a) {
      a = {
        total: 0, datagrams: 0, snapCount: 0,
        kind: { snapshot: 0, checkpoint: 0, heartbeat: 0, pong: 0, welcome: 0, other: 0 },
        snap: { player: 0, projectile: 0, other: 0, events: 0, removed: 0, roster: 0, framing: 0 },
        snapMax: 0, snapOverMtu: 0, estSum: 0, estSamples: 0,
      };
      A.perClient.set(peer, a);
    }
    return a;
  };

  const dec = new TextDecoder();
  const peerToClientId = new Map();
  const rawSend = hostPort.send.bind(hostPort);
  let hostRef = null;
  hostPort.send = (to, data, channel) => {
    if (pathA) {
      const a = acc(to);
      a.total += data.byteLength;
      a.datagrams++;
      A.datagrams++;
      let msg = null;
      try { msg = JSON.parse(dec.decode(data)); } catch { /* ignore */ }
      if (msg && msg.t) {
        const k = a.kind[msg.t] !== undefined ? msg.t : 'other';
        a.kind[k] += data.byteLength;
        if (msg.t === 'snapshot' && hostRef) {
          a.snapCount++;
          if (data.byteLength > a.snapMax) a.snapMax = data.byteLength;
          if (data.byteLength > 1200) a.snapOverMtu++;
          const cid = peerToClientId.get(to);
          if (cid) { a.estSum += hostRef.core.writer.bytesFor(cid); a.estSamples++; }
          const s = msg.s;
          const ents = hostRef.core.state.entities;
          let player = 0, projectile = 0, other = 0;
          for (const u of s.updates) {
            const b = jsonBytes(u) + 1;
            const e = ents.get(u.id);
            const kind = e ? e.kind : -1;
            if (kind === ENT.PLAYER) player += b;
            else if (kind === ENT.PROJECTILE) projectile += b;
            else other += b;
          }
          const events = s.events && s.events.length ? jsonBytes(s.events) : 0;
          const removed = s.removed && s.removed.length ? jsonBytes(s.removed) : 0;
          const roster = s.roster ? jsonBytes(s.roster) : 0;
          a.snap.player += player; a.snap.projectile += projectile; a.snap.other += other;
          a.snap.events += events; a.snap.removed += removed; a.snap.roster += roster;
          a.snap.framing += Math.max(0, data.byteLength - player - projectile - other - events - removed - roster);
        }
      }
    }
    rawSend(to, data, channel);
  };

  const sim = new MatchSim(tickRate, halfExtent);
  const host = new PeerHost({
    stableId: 'host', displayName: 'HOST', transport: hostPort,
    sim, config: { tickRate, seed, ...hostConfig }, snapshotIntervalTicks,
  });
  hostRef = host;
  host.start();

  for (let i = 0; i < 4; i++) {
    const o = host.core.spawn(ENT.OBJECTIVE, 0);
    o.px = (i % 2 ? 1 : -1) * halfExtent * 0.5;
    o.pz = (i < 2 ? 1 : -1) * halfExtent * 0.5;
  }
  for (let i = 0; i < 12; i++) {
    const p = host.core.spawn(ENT.PICKUP, 0);
    const a2 = (i / 12) * Math.PI * 2;
    p.px = Math.cos(a2) * halfExtent * 0.7;
    p.pz = Math.sin(a2) * halfExtent * 0.7;
    p.weapon = i % 5;
  }

  const REDUNDANCY = 3;
  const clients = [];
  for (let i = 1; i < players; i++) {
    const peer = `c${i}`;
    const port = net.createPort(peer);
    net.connect('host', peer, link);
    const c = {
      peer, port, clientId: 0, bot: new Bot(seed + i * 977, tickRate),
      ackTick: -1, ackCheckpoint: -1, sentAckCheckpoint: null, history: [], recvBytes: 0,
      sentBytes: 0, sentPackets: 0,
      reader: decodePathA ? new SnapshotReader() : null, snapsIn: 0,
    };
    port.onMessage((from, data) => {
      c.recvBytes += data.byteLength;
      let m = null;
      try { m = JSON.parse(dec.decode(data)); } catch { return; }
      if (m.t === 'welcome') {
        c.clientId = m.clientId;
        peerToClientId.set(peer, m.clientId);
        if (c.reader) { c.reader.reset(); c.reader.apply(m.snapshot); c.ackTick = c.reader.tick; }
        else c.ackTick = m.snapshot.tick;
      }
      else if (m.t === 'snapshot') {
        c.snapsIn++;
        if (c.reader) { c.reader.apply(m.s); c.ackTick = c.reader.tick; }
        else c.ackTick = Math.max(c.ackTick, m.s.tick);
      }
      else if (m.t === 'checkpoint') { c.ackCheckpoint = m.cp.tick; }
    });
    c.send = (msg, ch) => {
      const bytes = Buffer.from(JSON.stringify(msg), 'utf8');
      c.sentBytes += bytes.byteLength;
      c.sentPackets++;
      A.upstreamBytes += bytes.byteLength;
      A.upstreamDatagrams++;
      port.send('host', new Uint8Array(bytes), ch);
    };
    c.send({ t: 'join', v: PROTOCOL_VERSION, stableId: `p${i}`, name: `Bot${i}`, epoch: 0 }, 'reliable');
    clients.push(c);
  }

  const hostBot = new Bot(seed + 13, tickRate);
  const stacks = stackSpecs.map((s) => new RepStack(s, snapshotHz, snapshotIntervalTicks));

  const dt = 1 / tickRate;
  const totalTicks = Math.round(seconds * tickRate);
  const warmupTicks = Math.round(Math.min(3, seconds * 0.2) * tickRate);
  let ms = 0;
  let warmSnapshot = null;
  let upWarm = 0, upDgWarm = 0;

  for (let t = 0; t < totalTicks; t++) {
    ms += dt * 1000;
    net.advanceTo(ms);
    for (const c of clients) {
      if (!c.clientId) continue;
      const cmd = c.bot.command(host.core.tick + 2);
      c.history.push(cmd);
      if (c.history.length > REDUNDANCY) c.history.shift();
      // `thriftyClient` sends ackCheckpoint ONLY when it changes. PeerHost sets
      // rosterDirty on every input packet that carries the field, and a dirty
      // roster is attached to every client's next snapshot — so this one line on
      // the client side is what decides whether the roster ships 20x/second.
      const inMsg = {
        t: 'input', clientId: c.clientId, cmds: c.history.slice(), ackTick: c.ackTick,
      };
      if (!thriftyClient || c.ackCheckpoint !== c.sentAckCheckpoint) {
        inMsg.ackCheckpoint = c.ackCheckpoint;
        c.sentAckCheckpoint = c.ackCheckpoint;
      }
      c.send(inMsg, 'unreliable');
    }
    host.submitLocalInput(hostBot.command(host.core.tick + 1));
    host.advance(dt);

    if (t === warmupTicks) {
      warmSnapshot = snapshotA(A);
      upWarm = A.upstreamBytes; upDgWarm = A.upstreamDatagrams;
      for (const st of stacks) st.reset();
    }
    if (host.core.tick % snapshotIntervalTicks === 0) {
      for (const st of stacks) stepStack(st, host, host.core.tick, clients, t >= warmupTicks);
    }
  }
  net.advanceTo(ms + 500);

  const measuredSeconds = (totalTicks - warmupTicks) / tickRate;
  return {
    players, tickRate, snapshotHz, halfExtent, seconds: measuredSeconds,
    A: diffA(A, warmSnapshot, upWarm, upDgWarm),
    stacks, host, clients, entityCount: host.core.state.entities.size,
    remoteClients: clients.filter((c) => c.clientId).length,
  };
}

function snapshotA(A) {
  const per = new Map();
  for (const [k, v] of A.perClient) per.set(k, JSON.parse(JSON.stringify(v)));
  return per;
}

function diffA(A, base, upWarm, upDgWarm) {
  const out = {
    perClient: new Map(),
    upstreamBytes: A.upstreamBytes - upWarm,
    upstreamDatagrams: A.upstreamDatagrams - upDgWarm,
  };
  for (const [k, v] of A.perClient) {
    const b = base ? base.get(k) : null;
    const d = {
      total: v.total - (b ? b.total : 0),
      datagrams: v.datagrams - (b ? b.datagrams : 0),
      snapCount: v.snapCount - (b ? b.snapCount : 0),
      snapMax: v.snapMax,
      snapOverMtu: v.snapOverMtu - (b ? b.snapOverMtu : 0),
      estSum: v.estSum - (b ? b.estSum : 0),
      estSamples: v.estSamples - (b ? b.estSamples : 0),
      kind: {}, snap: {},
    };
    for (const key of Object.keys(v.kind)) d.kind[key] = v.kind[key] - (b ? b.kind[key] : 0);
    for (const key of Object.keys(v.snap)) d.snap[key] = v.snap[key] - (b ? b.snap[key] : 0);
    out.perClient.set(k, d);
  }
  return out;
}

function aggregateA(r) {
  const n = Math.max(1, r.remoteClients);
  let total = 0, wire = 0, dg = 0, snapMax = 0, overMtu = 0, snapN = 0, estSum = 0, estN = 0;
  const cat = { player: 0, projectile: 0, other: 0, events: 0, removed: 0, roster: 0, framing: 0 };
  const kind = { snapshot: 0, checkpoint: 0, heartbeat: 0, pong: 0, welcome: 0, other: 0 };
  for (const [, v] of r.A.perClient) {
    total += v.total;
    dg += v.datagrams;
    if (v.snapMax > snapMax) snapMax = v.snapMax;
    overMtu += v.snapOverMtu; snapN += v.snapCount;
    estSum += v.estSum; estN += v.estSamples;
    wire += v.total + v.datagrams * DATAGRAM_OVERHEAD_BYTES;
    for (const k of Object.keys(cat)) cat[k] += v.snap[k];
    for (const k of Object.keys(kind)) kind[k] += v.kind[k];
  }
  return {
    total, wire, dg, cat, kind, clients: n,
    snapMax, overMtuPct: snapN ? (overMtu / snapN) * 100 : 0,
    writerEstimate: estN ? estSum / estN : 0,
    perClient: total / n / r.seconds,
    perClientWire: wire / n / r.seconds,
    uplinkMbit: mbit(wire / r.seconds),
    upPerClient: r.A.upstreamBytes / n / r.seconds,
    upPerClientWire: (r.A.upstreamBytes + r.A.upstreamDatagrams * DATAGRAM_OVERHEAD_BYTES) / n / r.seconds,
    upBytesPerPacket: r.A.upstreamDatagrams ? r.A.upstreamBytes / r.A.upstreamDatagrams : 0,
    downBytesPerSnapshot: (() => {
      let sb = 0, sc = 0;
      for (const [, v] of r.A.perClient) { sb += v.kind.snapshot; sc += v.snapCount; }
      return sc ? sb / sc : 0;
    })(),
  };
}

/* ------------------------------------------------------------------------ */
/*  MAIN                                                                     */
/* ------------------------------------------------------------------------ */

const shipping = createDefaultRegistry();
const REG = cloneRegistry(shipping);
console.log('');
console.log('=== net-bandwidth =================================================');
console.log(`seed ${SEED} | ${SECONDS}s measured per scenario | perfect link (bandwidth, not loss)`);
check('group-namespaced registry is bit-identical to the shipping schema',
  assertRegistryClone(shipping, REG), `(hash ${shipping.hash()})`);
console.log('');

const t0 = Date.now();

/* ------------------------------------------- 1. scaling sweep, both paths */

console.log('--- 1. SCALING SWEEP (density-constant maps, contract snapshot rates) ---');
console.log('');
const sweep = [];
for (const players of [8, 16, 32, 64]) {
  const hz = snapshotHzFor(players);
  const tickRate = 60;
  const interval = Math.round(tickRate / hz);
  const r = runScenario({
    players, tickRate, snapshotIntervalTicks: interval, seconds: SECONDS, seed: SEED,
    stackSpecs: [
      { label: 'interest ON  budgeted', registry: REG, interestOn: true, budgeted: true },
      { label: 'interest ON  unlimited', registry: REG, interestOn: true, budgeted: false },
      { label: 'interest OFF unlimited', registry: REG, interestOn: false, budgeted: false },
    ],
  });
  sweep.push(r);
}

console.log('  PATH A — shipping host: DeltaSnapshotWriter + JsonCodec, measured at Transport.send');
console.log('  ' + pad('players', 8) + rp('snapHz', 7) + rp('ents', 6) + rp('down B/s', 11)
  + rp('kbit/s', 9) + rp('uplink Mb', 11) + rp('up B/s', 9) + '  composition');
for (const r of sweep) {
  const a = aggregateA(r);
  const kt = Object.values(a.kind).reduce((x, y) => x + y, 0) || 1;
  const comp = Object.entries(a.kind).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k} ${f1((v / kt) * 100)}%`).join(' ');
  console.log('  ' + pad(r.players, 8) + rp(r.snapshotHz, 7) + rp(r.entityCount, 6)
    + rp(f1(a.perClientWire), 11) + rp(f1(kbit(a.perClientWire)), 9)
    + rp(f2(a.uplinkMbit), 11) + rp(f1(a.upPerClientWire), 9) + '  ' + comp);
}
console.log('');
console.log('  PATH A — inside the snapshot payload only');
console.log('  ' + pad('players', 8) + rp('player', 9) + rp('proj', 8) + rp('events', 9)
  + rp('roster', 9) + rp('framing', 9) + rp('other', 8));
for (const r of sweep) {
  const a = aggregateA(r);
  const tot = Object.values(a.cat).reduce((x, y) => x + y, 0) || 1;
  const p = (v) => `${f1((v / tot) * 100)}%`;
  console.log('  ' + pad(r.players, 8) + rp(p(a.cat.player), 9) + rp(p(a.cat.projectile), 8)
    + rp(p(a.cat.events), 9) + rp(p(a.cat.roster), 9) + rp(p(a.cat.framing), 9)
    + rp(p(a.cat.other + a.cat.removed), 8));
}
console.log('');

console.log('  PATH B — bit-packed replication (SnapshotBuilder), same world, same ticks');
console.log('  ' + pad('players', 8) + pad('configuration', 24) + rp('down B/s', 10)
  + rp('kbit/s', 9) + rp('uplink Mb', 11) + rp('B/snap', 9) + rp('ents', 7)
  + rp('deg', 5) + rp('drop', 8) + rp('rej', 6));
for (const r of sweep) {
  for (const st of r.stacks) {
    const s = st.summary(r.seconds);
    console.log('  ' + pad(r.players, 8) + pad(st.label, 24) + rp(f1(s.perClientWire), 10)
      + rp(f1(kbit(s.perClientWire)), 9) + rp(f2(s.uplinkMbit), 11)
      + rp(f1(s.bytesPerSnap), 9) + rp(f1(s.entsPerSnap), 7)
      + rp(f1(s.degradeMean), 5) + rp(st.dropped, 8) + rp(s.rejected, 6));
  }
}
console.log('');
console.log('  PATH B — host CPU cost of SnapshotBuilder.build (this machine, 3 stacks in one process)');
console.log('  ' + pad('players', 8) + rp('us/build', 10) + rp('builds/s', 10) + rp('host core %', 13));
for (const r of sweep) {
  const st = r.stacks.find((x) => x.label.startsWith('interest ON  unlimited'));
  const s = st.summary(r.seconds);
  const buildsPerSec = (r.remoteClients * r.snapshotHz);
  console.log('  ' + pad(r.players, 8) + rp(f1(s.usPerBuild), 10) + rp(buildsPerSec, 10)
    + rp(f1((s.usPerBuild * buildsPerSec) / 10000), 13));
}
console.log('');

console.log('  PATH B — category breakdown (interest ON, unlimited: the design\'s intended cost)');
console.log('  ' + pad('players', 8) + rp('player', 9) + rp('proj', 8) + rp('objective', 11)
  + rp('ids+mask', 10) + rp('header', 9) + '  heaviest field groups');
for (const r of sweep) {
  const st = r.stacks.find((s) => s.label.startsWith('interest ON  unlimited'));
  const total = [...st.groupBits.values()].reduce((a, b) => a + b, 0) || 1;
  const cls = (n) => {
    const b = st.classBits.get(n);
    return b ? `${f1(((b.fields + b.structural) / total) * 100)}%` : '0%';
  };
  const structural = [...st.classBits.values()].reduce((a, v) => a + v.structural, 0);
  const header = (st.groupBits.get('header') ?? 0) + (st.groupBits.get('leaves') ?? 0);
  const groups = [...st.groupBits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `${k} ${f1((v / total) * 100)}%`).join(' ');
  console.log('  ' + pad(r.players, 8) + rp(cls('player'), 9) + rp(cls('projectile'), 8)
    + rp(cls('objective'), 11) + rp(`${f1((structural / total) * 100)}%`, 10)
    + rp(`${f1((header / total) * 100)}%`, 9) + '  ' + groups);
  check(`[${r.players}p] structural cost model matches the encoder's own meter`,
    Math.abs(st.structuralCheck.computed - st.structuralCheck.metered) <= st.snapshots * 2,
    `(${st.structuralCheck.computed} vs ${st.structuralCheck.metered} bits)`);
  check(`[${r.players}p] metered bits reconcile with encoded bytes`,
    Math.abs(st.meterBits - st.bytes * 8) <= st.snapshots * 8,
    `(${st.meterBits} vs ${st.bytes * 8})`);
  check(`[${r.players}p] every measured snapshot decoded`,
    st.summary(r.seconds).rejected === 0, `(${st.summary(r.seconds).rejected} rejected)`);
}
console.log('');

/* --------------------------------- 1b. where PATH A's bytes actually go */

console.log('--- 1b. PATH A DECOMPOSED at 16 players (each change measured, not modelled) ---');
{
  const common = { players: 16, tickRate: 60, snapshotIntervalTicks: 3, seconds: SECONDS, seed: SEED, stackSpecs: [] };
  const rows = [
    ['as shipped (checkpoint every 60 ticks, roster every snapshot)', {}],
    ['+ client sends ackCheckpoint only when it changes (roster idle)', { thriftyClient: true }],
    ['+ checkpoint every 30 s instead of every 1 s', { thriftyClient: true, hostConfig: { checkpointIntervalTicks: 1800 } }],
  ];
  console.log('  ' + pad('configuration', 62) + rp('down B/s', 10) + rp('uplink Mb', 11)
    + rp('B/snap', 9) + rp('vs shipped', 12));
  let first = null;
  for (const [label, extra] of rows) {
    const r = runScenario({ ...common, ...extra });
    const a = aggregateA(r);
    if (first === null) first = a.perClientWire;
    console.log('  ' + pad(label, 62) + rp(f1(a.perClientWire), 10) + rp(f2(a.uplinkMbit), 11)
      + rp(f1(a.downBytesPerSnapshot), 9)
      + rp(a.perClientWire === first ? '-' : `${f1(((a.perClientWire - first) / first) * 100)}%`, 12));
  }
  const rBase = runScenario({ ...common });
  const aBase = aggregateA(rBase);
  console.log(`  MTU: mean snapshot ${f1(aBase.downBytesPerSnapshot)} B, largest ${aBase.snapMax} B, ` +
    `${f1(aBase.overMtuPct)}% exceed the 1200 B MTU`);
  console.log(`  DeltaSnapshotWriter.bytesFor() believes it sent ${f1(aBase.writerEstimate)} B ` +
    `(${f1(aBase.downBytesPerSnapshot / Math.max(1, aBase.writerEstimate))}x under the truth) — ` +
    `its maxBytesPerSnapshot guard is measured in a currency the codec does not use`);
  console.log(`  upstream: ${f1(aBase.upBytesPerPacket)} B of JSON per input packet at 60 Hz with 3x redundancy`);
  console.log(`            = ${f1(aBase.upPerClientWire)} B/s per client on the wire; the contract models 52 B payload / 7200 B/s`);
}
console.log('');

/* ------------------------------------------------- 2. budget + degrade */

console.log('--- 2. BUDGET AND DEGRADATION (interest ON, DEFAULT_BUDGET 12000 B/s) ---');
console.log('  ' + pad('players', 8) + rp('B/s sent', 10) + rp('util%', 8) + rp('deg mean', 10)
  + rp('deg max', 9) + rp('trunc%', 9) + rp('dropped ents', 14) + rp('demand B/s', 12));
for (const r of sweep) {
  const b = r.stacks.find((s) => s.label.startsWith('interest ON  budgeted'));
  const u = r.stacks.find((s) => s.label.startsWith('interest ON  unlimited'));
  const sb = b.summary(r.seconds), su = u.summary(r.seconds);
  console.log('  ' + pad(r.players, 8) + rp(f1(sb.perClient), 10)
    + rp(f1((sb.perClient / DEFAULT_BUDGET.bytesPerSecond) * 100), 8)
    + rp(f1(sb.degradeMean), 10) + rp(sb.degradeMax, 9)
    + rp(f1((b.truncated / Math.max(1, sb.snaps)) * 100), 9)
    + rp(b.dropped, 14) + rp(f1(su.perClient), 12));
}
console.log('');

/* ------------------------------------------ 3. ack latency sensitivity */

console.log('--- 3. ACK LATENCY (delta baselines vs real RTT) ---');
console.log('  A delta is coded against the newest tick the HOST has an ack for; the client');
console.log('  rejects any delta whose baseline is not the last tick IT applied. At 20 Hz one');
console.log('  snapshot interval is 50 ms, so any RTT at or above that lands in the second row.');
console.log('  ' + pad('ack lag', 10) + rp('rtt band', 10) + rp('applied', 9) + rp('rejected', 10)
  + rp('reject%', 9) + rp('wasted B/s', 12) + rp('goodput B/s', 13));
for (const lag of [1, 2, 3]) {
  const r = runScenario({
    players: 16, tickRate: 60, snapshotIntervalTicks: 3, seconds: SECONDS,
    seed: SEED, pathA: false,
    stackSpecs: [{ label: `ack+${lag}`, registry: REG, interestOn: true, budgeted: false, ackDelay: lag }],
  });
  const st = r.stacks[0];
  const s = st.summary(r.seconds);
  const applied = [...st.clients.values()].reduce((a, c) => a + c.applied, 0);
  const n = Math.max(1, s.clients);
  console.log('  ' + pad(`${lag} snapshot${lag > 1 ? 's' : ''}`, 10)
    + rp(`${(lag - 1) * (1000 / r.snapshotHz)}-${lag * (1000 / r.snapshotHz)}ms`, 10)
    + rp(applied, 9) + rp(s.rejected, 10)
    + rp(f1((s.rejected / Math.max(1, s.snaps)) * 100), 9)
    + rp(f1(s.rejBytes / n / r.seconds), 12)
    + rp(f1((s.bytes - s.rejBytes) / n / r.seconds), 13));
}

// The shipping host's own client-side reader keeps per-tick baselines, so it is
// the control group: same RTT, different decoder design.
{
  const r = runScenario({
    players: 16, tickRate: 60, snapshotIntervalTicks: 3, seconds: SECONDS,
    seed: SEED, decodePathA: true, link: { latencyMs: 30, jitterMs: 0, loss: 0 },
    stackSpecs: [],
  });
  let applied = 0, noBase = 0, seen = 0;
  for (const c of r.clients) {
    if (!c.reader) continue;
    applied += c.reader.applied;
    noBase += c.reader.droppedNoBaseline;
    seen += c.snapsIn;
  }
  console.log('  ' + pad('PATH A ctl', 10) + rp('60ms', 10) + rp(applied, 9) + rp(noBase, 10)
    + rp(f1((noBase / Math.max(1, seen)) * 100), 9) + rp('-', 12) + rp('-', 13)
    + '   (host SnapshotReader keeps per-tick baselines)');
}
console.log('');

/* ------------------------------------------------- 4. interest levers */

console.log('--- 4. INTEREST LEVERS at 64 players (what distance rate-limiting is worth) ---');
console.log('  ' + pad('config', 34) + rp('down B/s', 10) + rp('uplink Mb', 11)
  + rp('B/snap', 9) + rp('ents/snap', 11) + rp('rej', 6));
{
  const specs = [
    { label: 'OFF (replicate everyone)', interestOn: false },
    { label: 'cull 160 m (DEFAULT_INTEREST)', interest: {} },
    { label: 'cull 120 m', interest: { cullRadius: 120 } },
    { label: 'cull 80 m', interest: { cullRadius: 80 } },
    { label: 'cull 160 m + lodIntervals 1/3/6/12', interest: { lodIntervals: [1, 3, 6, 12] } },
    { label: 'cull 80 m + lodIntervals 1/3/6/12', interest: { cullRadius: 80, lodIntervals: [1, 3, 6, 12] } },
    { label: 'cull 80 m + maxEntities 24', interest: { cullRadius: 80, maxEntitiesPerTick: 24 } },
  ].map((s) => ({ ...s, registry: REG, budgeted: false }));
  const r = runScenario({
    players: 64, tickRate: 60, snapshotIntervalTicks: 4, seconds: SECONDS, seed: SEED,
    pathA: false, stackSpecs: specs,
  });
  for (const st of r.stacks) {
    const s = st.summary(r.seconds);
    console.log('  ' + pad(st.label, 34) + rp(f1(s.perClient), 10) + rp(f2(s.uplinkMbit), 11)
      + rp(f1(s.bytesPerSnap), 9) + rp(f1(s.entsPerSnap), 11) + rp(s.rejected, 6));
  }
  console.log('');
  console.log('  Same, on a 600 m Ground-War-scale map (64 players, density 1/5600 m^2):');
  const r2 = runScenario({
    players: 64, tickRate: 60, snapshotIntervalTicks: 4, seconds: SECONDS, seed: SEED,
    halfExtent: 300, pathA: false,
    stackSpecs: [
      { label: 'OFF (replicate everyone)', registry: REG, interestOn: false, budgeted: false },
      { label: 'cull 160 m (DEFAULT_INTEREST)', registry: REG, interest: {}, budgeted: false },
      { label: 'cull 160 m, budgeted', registry: REG, interest: {}, budgeted: true },
    ],
  });
  for (const st of r2.stacks) {
    const s = st.summary(r2.seconds);
    console.log('  ' + pad(st.label, 34) + rp(f1(s.perClient), 10) + rp(f2(s.uplinkMbit), 11)
      + rp(f1(s.bytesPerSnap), 9) + rp(f1(s.entsPerSnap), 11) + rp(s.rejected, 6));
  }
}
console.log('');

/* --------------------------------------------- 5. quantisation variants */

console.log('--- 5. QUANTISATION VARIANTS at 16 players (re-encoded end to end, not modelled) ---');
{
  const mk = (fn) => cloneRegistry(shipping, fn);
  const variants = [
    ['baseline (shipping schema)', null],
    ['aim 10-bit (0.35 deg) instead of 13/12-bit', (c, d) => {
      if (c !== 'player') return d;
      if (d.name === 'yaw') { d.step = (2 * Math.PI) / 1024; d.max = d.min + 1023 * d.step; }
      if (d.name === 'pitch') { d.step = 3.2 / 1024; d.max = d.min + 1023 * d.step; }
      return d;
    }],
    ['position 2 cm instead of 1 cm', (c, d) => {
      if (c === 'player' && d.name === 'pos') d.step = 0.02;
      return d;
    }],
    ['drop velocity (client derives it)', (c, d) =>
      (c === 'player' || c === 'projectile') && d.name === 'vel' ? null : d],
    ['velocity at LOD 0 only', (c, d) => {
      if ((c === 'player' || c === 'projectile') && d.name === 'vel') d.maxLod = 0;
      return d;
    }],
    ['drop cosmetic (animPhase, lean)', (c, d) =>
      c === 'player' && (d.name === 'animPhase' || d.name === 'lean') ? null : d],
    ['all four combined', (c, d) => {
      if (c === 'player' && d.name === 'yaw') { d.step = (2 * Math.PI) / 1024; d.max = d.min + 1023 * d.step; }
      if (c === 'player' && d.name === 'pitch') { d.step = 3.2 / 1024; d.max = d.min + 1023 * d.step; }
      if (c === 'player' && d.name === 'pos') d.step = 0.02;
      if ((c === 'player' || c === 'projectile') && d.name === 'vel') d.maxLod = 0;
      if (c === 'player' && (d.name === 'animPhase' || d.name === 'lean')) return null;
      return d;
    }],
  ];
  const specs = variants.map(([label, fn]) => ({
    label, registry: fn ? mk(fn) : REG, interestOn: true, budgeted: false,
  }));
  const r = runScenario({
    players: 16, tickRate: 60, snapshotIntervalTicks: 3, seconds: SECONDS, seed: SEED,
    pathA: false, stackSpecs: specs,
  });
  const base = r.stacks[0].summary(r.seconds);
  console.log('  ' + pad('variant', 44) + rp('down B/s', 10) + rp('B/snap', 9)
    + rp('delta', 9) + rp('rej', 6));
  for (const st of r.stacks) {
    const s = st.summary(r.seconds);
    const d = ((s.perClient - base.perClient) / base.perClient) * 100;
    console.log('  ' + pad(st.label, 44) + rp(f1(s.perClient), 10) + rp(f1(s.bytesPerSnap), 9)
      + rp(st === r.stacks[0] ? '-' : `${d > 0 ? '+' : ''}${f1(d)}%`, 9) + rp(s.rejected, 6));
  }
}
console.log('');

/* ------------------------------------------------ 6. structural overhead */

console.log('--- 6. STRUCTURAL OVERHEAD (entity id chain + field mask) ---');
console.log('  ' + pad('players', 9) + rp('ids bits', 10) + rp('mask bits', 11)
  + rp('id<=15', 9) + rp('mask==prev', 12) + rp('recoverable', 13) + rp('of total', 10));
for (const r of sweep) {
  const st = r.stacks.find((s) => s.label.startsWith('interest ON  unlimited'));
  const total = [...st.groupBits.values()].reduce((a, b) => a + b, 0) || 1;
  // 4-bit small-id escape: 1 flag bit + 4 payload bits replaces an 8-bit varuint.
  const idSaving = st.idSmallDeltas * (8 - 5) - (st.idUpdates - st.idSmallDeltas) * 1;
  // mask-repeat flag: 1 bit replaces the whole mask when it equals last time.
  const maskSaving = st.maskRepeat * (st.maskBitsTotal / Math.max(1, st.maskTotal) - 1)
    - (st.maskTotal - st.maskRepeat) * 1;
  const rec = idSaving + maskSaving;
  console.log('  ' + pad(r.players, 9) + rp(f1((st.idBitsTotal / total) * 100) + '%', 10)
    + rp(f1((st.maskBitsTotal / total) * 100) + '%', 11)
    + rp(f1((st.idSmallDeltas / Math.max(1, st.idUpdates)) * 100) + '%', 9)
    + rp(f1((st.maskRepeat / Math.max(1, st.maskTotal)) * 100) + '%', 12)
    + rp(f1(rec / 8 / Math.max(1, st.clients.size) / r.seconds) + ' B/s', 13)
    + rp(f1((rec / total) * 100) + '%', 10));
}
console.log('');

/* ------------------------------------------------------------- verdict */

console.log('--- 7. AGAINST THE docs/NETCODE.md BUDGET ---');
const DOC = {
  8: { perClient: 8300, uplink: 0.48 },
  16: { perClient: 8300, uplink: 1.02 },
  32: { perClient: 8300, uplink: 1.15 },
  64: { perClient: 8300, uplink: 2.34 },
};
console.log('  ' + pad('players', 8) + rp('doc B/s', 9) + rp('doc Mb', 8)
  + rp('A B/s', 10) + rp('A Mb', 9) + rp('A x doc', 9)
  + rp('B B/s', 9) + rp('B Mb', 8) + rp('B x doc', 9));
for (const r of sweep) {
  const a = aggregateA(r);
  const st = r.stacks.find((s) => s.label.startsWith('interest ON  unlimited'));
  const s = st.summary(r.seconds);
  const d = DOC[r.players];
  console.log('  ' + pad(r.players, 8) + rp(d.perClient, 9) + rp(f2(d.uplink), 8)
    + rp(f1(a.perClientWire), 10) + rp(f2(a.uplinkMbit), 9)
    + rp(f1(a.perClientWire / d.perClient) + 'x', 9)
    + rp(f1(s.perClientWire), 9) + rp(f2(s.uplinkMbit), 8)
    + rp(f1(s.perClientWire / d.perClient) + 'x', 9));
  check(`[${r.players}p] PATH B (bit-packed, interest on) is inside the doc's per-client budget`,
    s.perClientWire <= d.perClient * 1.05, `(${f1(s.perClientWire)} vs ${d.perClient} B/s)`);
  check(`[${r.players}p] PATH A (shipping) is inside the doc's per-client budget`,
    a.perClientWire <= d.perClient * 1.05, `(${f1(a.perClientWire)} vs ${d.perClient} B/s)`);
}

console.log('');
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s | checks: ${passes} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
