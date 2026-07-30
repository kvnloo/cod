#!/usr/bin/env node
/**
 * Headless verification of `src/net/NetSystem.ts` — the engine-facing glue.
 *
 *   node tools/net-system.mjs
 *
 * `tools/net-host.mjs` proves the authority, replication and migration are
 * correct. This proves the *System wrapper* around them is correct, which is a
 * different set of failure modes and the one that reaches the player:
 *
 *   1. offline is genuinely free — no bus traffic, no state, no work
 *   2. the default input mapping produces the right command without a DOM
 *   3. authoritative events reach the bus EXACTLY ONCE (the observer is bound
 *      once per host, not once per status report — that bug double-fires every
 *      hit and kill the HUD/FX layers see)
 *   4. a host killed mid-match promotes a survivor *through NetSystem*, the
 *      survivor keeps simulating, and relays stay exactly-once afterwards
 *   5. disconnect() returns the process to the offline fast path
 *
 * NetSystem imports `src/core/Engine.ts` for `ORDER` and its `System` types, and
 * Engine pulls in Three.js. Node's strip-only TypeScript mode cannot load the
 * core module graph (parameter properties in `src/core/Time.ts`), so `Engine` is
 * resolved to a tiny stub below. Nothing else is stubbed: the real NetSystem,
 * the real PeerSession, the real authority and the real EventBus all run.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAS_EXT = /\.[cm]?[jt]sx?$/;

// Must mirror ORDER in src/core/Engine.ts. Only INPUT is actually read.
const ENGINE_STUB = 'data:text/javascript,' + encodeURIComponent(
  'export const ORDER = { INPUT: 0, PHYSICS: 100, PLAYER: 200, WEAPONS: 300, '
  + 'BALLISTICS: 350, AI: 400, GAMEPLAY: 500, WORLD: 600, FX: 700, AUDIO: 800, '
  + 'CAMERA: 900, UI: 950, RENDER: 1000 };',
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !HAS_EXT.test(specifier)) {
      const parent = context.parentURL;
      if (parent && parent.startsWith('file:')) {
        const base = new URL(specifier, parent);
        if (base.pathname.endsWith('/src/core/Engine')) {
          return { url: ENGINE_STUB, format: 'module', shortCircuit: true };
        }
        for (const ext of ['.ts', '/index.ts']) {
          const candidate = new URL(base.href + ext);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

const { NetSystem } = await import('../src/net/NetSystem.ts');
const { PeerSession, ArenaSim, BTN, TYPICAL_LINK } = await import('../src/net/host/index.ts');
const { bus } = await import('../src/core/EventBus.ts');
const { input } = await import('../src/core/Input.ts');

/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  [${detail}]` : ''}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

const TICK_RATE = 30;
const FPS = 60;
const DT = 1 / FPS;
const DT_MS = 1000 / FPS;

/** Counts every net-facing bus key so "offline emits nothing" is checkable. */
const KEYS = ['net:status', 'net:quality', 'net:event', 'net:peer:join', 'net:peer:leave',
  'net:migration', 'notify'];
const counts = Object.fromEntries(KEYS.map((k) => [k, 0]));
const statuses = [];
const notices = [];
for (const k of KEYS) {
  bus.on(k, (p) => {
    counts[k]++;
    if (k === 'net:status') statuses.push(p);
    if (k === 'notify') notices.push(p.text);
  });
}
const total = () => KEYS.reduce((n, k) => n + counts[k], 0);

// A camera-shaped context. NetSystem only ever reads `ctx.camera.rotation`.
const ctx = { camera: { rotation: { x: -0.12, y: 1.4 } } };

/* ------------------------------------------------------------------ */

section('1. offline is the default and offline is free');
{
  const ns = new NetSystem();
  ns.init(ctx);
  const before = total();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) { ns.fixedUpdate(DT, ctx); ns.update(DT, ctx); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  check('offline emits nothing on the bus', total() === before, `${total() - before} events over 20000 frames`);
  check('offline reports the offline role', ns.netStatus.role === 'offline' && !ns.online && !ns.authoritative,
    `role=${ns.netStatus.role} online=${ns.online} authoritative=${ns.authoritative}`);
  check('offline update is a first-line return', ms < 40, `${ms.toFixed(2)} ms for 40000 calls`);
  ns.dispose();
  check('disposing an offline system is silent', total() === before, `${total() - before} events`);
}

section('2. default input mapping works with no DOM');
{
  const ns = new NetSystem();
  ns.init(ctx);
  input.state.actions.clear();
  input.state.actions.add('forward');
  input.state.actions.add('right');
  input.state.actions.add('fire');
  input.state.actions.add('sprint');
  const cmd = ns.sampleInput(7);
  check('buttons map from held actions',
    (cmd.buttons & BTN.FIRE) !== 0 && (cmd.buttons & BTN.SPRINT) !== 0 && (cmd.buttons & BTN.JUMP) === 0,
    `buttons=0b${cmd.buttons.toString(2)}`);
  check('movement axes are clamped to the unit square',
    cmd.moveZ === 1 && cmd.moveX === 1 && cmd.tick === 7,
    `moveX=${cmd.moveX} moveZ=${cmd.moveZ}`);
  check('aim comes from the engine camera',
    cmd.yaw === ctx.camera.rotation.y && cmd.pitch === ctx.camera.rotation.x,
    `yaw=${cmd.yaw} pitch=${cmd.pitch}`);

  ns.inputSource = (tick) => ({ tick, seq: 0, moveX: 0, moveZ: 0, yaw: 0.5, pitch: 0, buttons: 0 });
  check('inputSource overrides the default mapping', ns.sampleInput(9).yaw === 0.5);
  input.state.actions.clear();
  ns.dispose();
}

/* ------------------------------------------------------------------ */

/** Deterministic bot input so the sim actually produces hits, kills and events. */
function botInput(seedPhase) {
  return (tick) => ({
    tick,
    seq: 0,
    moveX: Math.sin(tick * 0.05 + seedPhase) * 0.9,
    moveZ: Math.cos(tick * 0.017 + seedPhase) > -0.3 ? 1 : -0.5,
    yaw: Math.sin(tick * 0.013 + seedPhase) * Math.PI,
    pitch: 0,
    buttons: BTN.FIRE,
  });
}

section('3. authoritative events reach the bus exactly once');
{
  const net = NetSystem.loopback(0x5157e, TYPICAL_LINK);
  const hostPort = net.createPort('peer-h');
  const clientPort = net.createPort('peer-c');
  net.connect('peer-h', 'peer-c');

  const ns = new NetSystem();
  ns.init(ctx);
  ns.inputSource = botInput(0);
  ns.hostMatch({
    transport: hostPort, stableId: 'p-h', displayName: 'Host',
    sim: new ArenaSim(TICK_RATE), hostConfig: { tickRate: TICK_RATE },
  }, 20260730);

  // A plain PeerSession for the client so *only* the host relays onto the bus
  // and the comparison is unambiguous.
  const client = new PeerSession({
    stableId: 'p-c', displayName: 'Client', transport: clientPort,
    sim: new ArenaSim(TICK_RATE), hostConfig: { tickRate: TICK_RATE },
    input: botInput(2.1),
  });
  client.joinMatch('peer-h');

  const core = () => ns.session.host.core;
  let ms = 0;
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      net.advanceTo(ms);
      ns.fixedUpdate(DT, ctx);
      client.update(DT, ms);
      ns.update(DT, ctx);
      ms += DT_MS;
    }
  };

  step(FPS * 2); // settle: join, welcome, first snapshots
  const relays0 = counts['net:event'];
  const emitted0 = core().stats.eventsEmitted;

  step(FPS * 4);
  // Re-report status repeatedly: this is what host migration, roster churn and
  // every join/leave do. Binding the observer per report would multiply relays.
  for (let i = 0; i < 8; i++) ns.session.onStatus(ns.session.stats());
  step(FPS * 4);

  const relayDelta = counts['net:event'] - relays0;
  const emitDelta = core().stats.eventsEmitted - emitted0;

  check('the host actually simulated combat', emitDelta > 50, `${emitDelta} authoritative events`);
  check('every authoritative event is relayed exactly once',
    relayDelta === emitDelta, `relayed ${relayDelta} vs emitted ${emitDelta}`);
  check('peers announce themselves once each', counts['net:peer:join'] === core().state.players.size,
    `${counts['net:peer:join']} joins for ${core().state.players.size} players`);
  check('status is published, not spammed', counts['net:status'] > 0 && counts['net:status'] < 60,
    `${counts['net:status']} net:status over ${(ms / 1000).toFixed(1)}s`);
  check('quality telemetry is published at ~2 Hz',
    Math.abs(counts['net:quality'] - (ms / 1000) * 2) <= 3,
    `${counts['net:quality']} net:quality over ${(ms / 1000).toFixed(1)}s`);

  const before = total();
  ns.disconnect('test over');
  const after = ns.netStatus;
  step(FPS);
  check('disconnect returns to the offline fast path',
    !ns.online && after.role === 'offline' && total() === before + 2,
    `role=${after.role} online=${ns.online} extra bus events=${total() - before}`);
  client.dispose();
}

/* ------------------------------------------------------------------ */

section('4. host killed mid-match: NetSystem promotes a survivor and keeps going');
{
  for (const k of KEYS) counts[k] = 0;
  statuses.length = 0;
  notices.length = 0;

  const net = NetSystem.loopback(0x319a7e, TYPICAL_LINK);
  const peers = [
    { peerId: 'peer-alice', stableId: 'p-alice', name: 'Alice', phase: 0.0 },
    { peerId: 'peer-bob', stableId: 'p-bob', name: 'Bob', phase: 1.7 },
    { peerId: 'peer-carol', stableId: 'p-carol', name: 'Carol', phase: 3.3 },
  ].map((p) => {
    const ns = new NetSystem();
    ns.init(ctx);
    ns.inputSource = botInput(p.phase);
    let received = 0;
    ns.snapshotSink = { onEvent: () => { received++; } };
    return { ...p, ns, transport: net.createPort(p.peerId), alive: true, get received() { return received; } };
  });

  // Full mesh — a successor that cannot reach the survivors cannot host them.
  net.connect('peer-alice', 'peer-bob');
  net.connect('peer-alice', 'peer-carol');
  net.connect('peer-bob', 'peer-carol');

  const attach = (p) => ({
    transport: p.transport, stableId: p.stableId, displayName: p.name,
    sim: new ArenaSim(TICK_RATE), hostConfig: { tickRate: TICK_RATE },
  });

  // Carol hosts first on purpose: highest stable id, so election must pick Alice.
  const carol = peers[2], alice = peers[0], bob = peers[1];
  carol.ns.hostMatch(attach(carol), 20260730);
  alice.ns.joinMatch(attach(alice), 'peer-carol');
  bob.ns.joinMatch(attach(bob), 'peer-carol');

  const DURATION_S = 30;
  const KILL_S = 10;
  const WINDOW_FROM_S = 16;
  const WINDOW_TO_S = 28;

  let ms = 0;
  let killed = false;
  let preKillTick = 0;
  let window0 = null;
  let window1 = null;

  const ledger = () => {
    let hostEmitted = 0, clientReceived = 0;
    for (const p of peers) {
      hostEmitted += p.ns.session?.host?.core.stats.eventsEmitted ?? 0;
      clientReceived += p.received;
    }
    return { relays: counts['net:event'], hostEmitted, clientReceived };
  };

  for (let step = 0; step * DT < DURATION_S; step++) {
    const t = step * DT;
    net.advanceTo(ms);
    for (const p of peers) if (p.alive) { p.ns.fixedUpdate(DT, ctx); p.ns.update(DT, ctx); }

    if (!killed && t >= KILL_S) {
      const h = peers.find((p) => p.alive && p.ns.authoritative);
      preKillTick = h.ns.session.host.core.tick;
      net.kill(h.peerId, 'host quit');
      h.alive = false;
      killed = true;
      console.log(`  info  killed host ${h.stableId} at t=${t.toFixed(1)}s tick=${preKillTick}`);
    }
    if (window0 === null && t >= WINDOW_FROM_S) window0 = ledger();
    if (window1 === null && t >= WINDOW_TO_S) window1 = ledger();
    ms += DT_MS;
  }

  const survivors = peers.filter((p) => p.alive);
  const newHost = survivors.find((p) => p.ns.authoritative);

  check('the host was killed', killed && !carol.alive, `victim=${carol.stableId}`);
  check('a survivor holds authority', !!newHost, newHost ? `host=${newHost.stableId}` : 'nobody hosts');
  check('the lowest stable id was elected', newHost?.stableId === 'p-alice',
    `elected=${newHost?.stableId}`);
  check('the survivors are all still online', survivors.every((p) => p.ns.online),
    survivors.map((p) => `${p.stableId}=${p.ns.netStatus.role}`).join(' '));
  check('the new host kept simulating past the kill',
    newHost && newHost.ns.session.host.core.tick > preKillTick + TICK_RATE * 15,
    `tick ${preKillTick} → ${newHost?.ns.session.host.core.tick} (expected ≈ ${preKillTick + TICK_RATE * 20})`);
  check('both survivors are in the new host match',
    newHost?.ns.netStatus.players === 2, `players=${newHost?.ns.netStatus.players}`);
  check('the epoch advanced exactly once', newHost?.ns.netStatus.epoch === 2,
    `epoch=${newHost?.ns.netStatus.epoch}`);
  check('joining is one handshake, migrating is one more',
    survivors.every((p) => p.ns.session.counters.welcomes <= 2),
    survivors.map((p) => `${p.stableId}=${p.ns.session.counters.welcomes}`).join(' '));
  check('nobody is told the host migrated on a plain join',
    notices.filter((n) => n.startsWith('Host migrated')).length === survivors.length,
    `${notices.filter((n) => n.startsWith('Host migrated')).length} migration notices `
    + `for ${survivors.length} survivors`);
  check('the UI was told about the migration',
    notices.some((n) => n.startsWith('Host migrated')) && counts['net:migration'] > 0,
    `migration events=${counts['net:migration']} notices=${notices.filter((n) => n.startsWith('Host migrated')).length}`);
  check('no survivor was told the connection was lost',
    notices.filter((n) => n.startsWith('Connection lost')).length === 0,
    `notices=${JSON.stringify(notices.slice(0, 4))}`);

  const relayDelta = window1.relays - window0.relays;
  const expected = (window1.hostEmitted - window0.hostEmitted)
    + (window1.clientReceived - window0.clientReceived);
  check('post-migration relays are still exactly-once',
    relayDelta > 0 && relayDelta === expected,
    `relayed ${relayDelta} vs host-emitted+client-received ${expected} over ${WINDOW_TO_S - WINDOW_FROM_S}s`);

  const bytes = survivors.reduce((n, p) => n + p.transport.bytesReceived, 0);
  console.log(`  info  ${(bytes / 1024).toFixed(1)} KiB received by survivors over ${DURATION_S}s, `
    + `${net.totalDropped} packets dropped by the link`);

  for (const p of peers) p.ns.dispose();
}

/* ------------------------------------------------------------------ */

section('summary');
console.log(`  ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`   - ${f}`);
console.log(failures.length ? '\nFAIL' : '\nPASS');
process.exit(failures.length ? 1 : 0);
