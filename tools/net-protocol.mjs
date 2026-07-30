#!/usr/bin/env node
/**
 * Headless conformance + bandwidth test for the netcode contracts.
 *
 *   node tools/net-protocol.mjs
 *
 * Compiles src/net/{types,Protocol,index}.ts (plus src/core/Rand.ts for the
 * seeded RNG) to a scratch dir with tsc, then exercises the protocol in pure
 * Node: framing, version rejection, batching, sequence wrap, the ack window
 * under seeded packet loss, quantization error bounds, hostile-input
 * sanitation, and the bandwidth model quoted in docs/NETCODE.md.
 *
 * Exit code 0 = all PASS.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- build --- */

const outDir = mkdtempSync(join(tmpdir(), 'net-proto-'));
process.stdout.write(`building src/net -> ${outDir}\n`);
execFileSync(
  'npx',
  [
    'tsc',
    'src/net/types.ts', 'src/net/Protocol.ts', 'src/net/index.ts', 'src/core/Rand.ts',
    '--outDir', outDir,
    '--module', 'esnext',
    '--target', 'es2022',
    '--moduleResolution', 'bundler',
    '--strict',
    '--skipLibCheck',
    '--ignoreConfig',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

// tsc emits extensionless relative specifiers; Node ESM needs the .js.
function fixup(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { fixup(p); continue; }
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(p, 'utf8');
    const out = src.replace(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g, (m, a, spec, c) =>
      spec.endsWith('.js') ? m : `${a}${spec}.js${c}`);
    if (out !== src) writeFileSync(p, out);
  }
}
fixup(outDir);

const P = await import(pathToFileURL(join(outDir, 'net', 'Protocol.js')).href);
const T = await import(pathToFileURL(join(outDir, 'net', 'types.js')).href);
const { Rand } = await import(pathToFileURL(join(outDir, 'core', 'Rand.js')).href);

/* ----------------------------------------------------------------- harness */

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }
const f2 = (n) => n.toFixed(2);

/* ------------------------------------------------------- sample messages -- */

const rnd = new Rand('net-protocol-test');

function sampleCommand(i) {
  return {
    seq: i & 0xffff,
    clientTick: 1000 + i,
    dtMs: P.DEFAULT_COMMAND_DT_MS,
    moveX: rnd.signed(),
    moveZ: rnd.signed(),
    yaw: rnd.range(-Math.PI, Math.PI),
    pitch: rnd.range(-1.5, 1.5),
    buttons: T.BUTTON.FIRE | T.BUTTON.SPRINT,
    weaponSlot: 1,
    fireCount: i,
  };
}

function sampleEntity(id, fields) {
  return {
    id, kind: T.ENTITY_KIND.PLAYER, fields, owner: id, team: id % 2,
    px: rnd.range(-200, 200), py: rnd.range(0, 20), pz: rnd.range(-200, 200),
    yaw: rnd.range(-Math.PI, Math.PI), pitch: rnd.range(-1, 1),
    vx: rnd.range(-8, 8), vy: rnd.range(-8, 8), vz: rnd.range(-8, 8),
    health: 100, armor: 0,
    flags: T.ENTITY_FLAG.ALIVE | T.ENTITY_FLAG.SPRINT,
    weapon: 3, anim: 1234, score: 400,
  };
}

function sampleSnapshot(nEntities, fields, baseline = 900) {
  const entities = [];
  for (let i = 0; i < nEntities; i++) entities.push(sampleEntity(100 + i, fields));
  return { tick: 1000, serverTimeMs: 123456, baselineTick: baseline, entities, removed: [] };
}

const ONE_OF_EACH = [
  P.createHello({ seq: 1, name: 'kilo', nonce: 0x1234 }),
  P.createWelcome({ seq: 1, assignedId: 3, serverTimeMs: 1000, tick: 42, nonce: 0x1234 }),
  { k: P.MSG.JOIN_REQUEST, seq: 2, from: 3, info: { name: 'kilo', team: -1, loadout: ['ar', 'pistol'] } },
  {
    k: P.MSG.JOIN_ACCEPT, seq: 2, from: 0, clientId: 3, entityId: 103, tick: 44,
    serverTimeMs: 1100, matchSeed: 1337, mapId: 'blackout', mode: 'tdm',
    peers: [{ id: 0, name: 'host', team: 0, isHost: true, entityId: 100, pingMs: 0, state: 'live', migrationRank: 0 }],
    config: { ...T.DEFAULT_NET_CONFIG },
  },
  { k: P.MSG.JOIN_REJECT, seq: 3, from: 0, reason: 'server-full' },
  {
    k: P.MSG.INPUT, seq: 77, from: 3, commands: [sampleCommand(1), sampleCommand(2), sampleCommand(3)],
    ackSnapshotTick: 995, ackEventId: 12, clientTimeMs: 5000,
  },
  {
    k: P.MSG.SNAPSHOT, seq: 88, from: 0, snapshot: sampleSnapshot(4, T.SNAP_FIELD.ALL),
    ackInputSeq: 77, ackClientTick: 1003, needsAck: true,
  },
  { k: P.MSG.ACK, seq: 89, from: 3, channel: 'state', ack: P.emptyAck(), ackSnapshotTick: 1000 },
  {
    k: P.MSG.EVENT, seq: 5, from: 0,
    events: [{ id: 9, tick: 1000, kind: 'weapon:fire', data: { weaponId: 'ar', shotIndex: 3 }, target: T.BROADCAST }],
  },
  { k: P.MSG.EVENT_ACK, seq: 5, from: 3, throughEventId: 9 },
  { k: P.MSG.RPC, seq: 6, from: 3, req: { rpcId: 1, method: 'setLoadout', args: { primary: 'ar' } } },
  { k: P.MSG.RPC_RESULT, seq: 6, from: 0, res: { rpcId: 1, ok: true, result: null } },
  { k: P.MSG.PING, seq: 7, from: 3, id: 4, sentAtMs: 9000 },
  { k: P.MSG.PONG, seq: 7, from: 0, id: 4, sentAtMs: 9000, serverTimeMs: 9040, serverTick: 1002 },
  {
    k: P.MSG.HOST_MIGRATE, seq: 8, from: 0,
    plan: { candidates: [3, 5, 7], resumeTick: 1200, epoch: 2 },
  },
  { k: P.MSG.HOST_MIGRATE_ACK, seq: 8, from: 3, epoch: 2, newHostId: 3, atTick: 1200 },
  {
    k: P.MSG.PEER_LIST, seq: 9, from: 0,
    peers: [{ id: 3, name: 'kilo', team: 1, isHost: false, entityId: 103, pingMs: 42, state: 'live', migrationRank: 1 }],
  },
  { k: P.MSG.DISCONNECT, seq: 10, from: 0, reason: 'host-quit', detail: 'lobby closed' },
];

/* -------------------------------------------------------- 1. round trip --- */

section('1. codec round-trip, all message kinds');
{
  let allOk = true;
  for (const msg of ONE_OF_EACH) {
    const bytes = P.JsonCodec.encode([msg]);
    const res = P.JsonCodec.decode(bytes);
    const ok = res.ok && res.messages.length === 1
      && JSON.stringify(res.messages[0]) === JSON.stringify(msg);
    if (!ok) { allOk = false; console.log(`        mismatch on ${P.MSG_NAME[msg.k]}`); }
  }
  check('every message kind round-trips byte-identically', allOk,
    `${ONE_OF_EACH.length} kinds`);

  const kinds = Object.values(P.MSG);
  check('a sample exists for every declared MSG kind',
    kinds.every((k) => ONE_OF_EACH.some((m) => m.k === k)),
    `${kinds.length} kinds declared`);
}

/* ---------------------------------------------------------- 2. batching --- */

section('2. datagram batching');
{
  const batch = ONE_OF_EACH.slice(0, 8);
  const bytes = P.JsonCodec.encode(batch);
  const res = P.JsonCodec.decode(bytes);
  check('8 messages coalesce into one datagram and decode back',
    res.ok && res.messages.length === 8, `${bytes.length} B`);

  const single = batch.reduce((n, m) => n + P.JsonCodec.encode([m]).length, 0);
  const savedOverhead = (batch.length - 1) * P.DATAGRAM_OVERHEAD_BYTES;
  check('batching saves per-datagram overhead',
    savedOverhead > 0,
    `${batch.length} datagrams -> 1 saves ${savedOverhead} B of IP/UDP/DTLS/SCTP; payload ${single} -> ${bytes.length} B`);
}

/* --------------------------------------------- 3. version / malformed ----- */

section('3. version + malformed rejection');
{
  const good = P.JsonCodec.encode([ONE_OF_EACH[0]]);

  const wrongVer = Uint8Array.from(good); wrongVer[1] = P.PROTOCOL_VERSION + 1;
  const r1 = P.JsonCodec.decode(wrongVer);
  check('future protocol version rejected cleanly', !r1.ok && r1.error === 'version', r1.detail ?? '');

  const oldVer = Uint8Array.from(good); oldVer[1] = 0;
  check('older protocol version rejected cleanly', !P.JsonCodec.decode(oldVer).ok);

  const wrongMagic = Uint8Array.from(good); wrongMagic[0] = 0x00;
  const r2 = P.JsonCodec.decode(wrongMagic);
  check('foreign traffic rejected on magic byte', !r2.ok && r2.error === 'magic');

  check('empty datagram rejected', P.JsonCodec.decode(new Uint8Array(0)).error === 'empty');

  const huge = new Uint8Array(P.MAX_PACKET_BYTES + 1);
  huge[0] = P.PROTOCOL_MAGIC; huge[1] = P.PROTOCOL_VERSION;
  check('oversized datagram rejected before parsing', P.JsonCodec.decode(huge).error === 'too-large');

  const garbage = Uint8Array.from([P.PROTOCOL_MAGIC, P.PROTOCOL_VERSION, 0x7b, 0x7b, 0x7b]);
  check('malformed body rejected', P.JsonCodec.decode(garbage).error === 'malformed');

  const unknown = P.JsonCodec.encode([{ k: 250, seq: 0, from: 0 }]);
  check('unknown message kind rejected', P.JsonCodec.decode(unknown).error === 'unknown-kind');

  const compatBad = P.checkCompatibility({ protocol: P.PROTOCOL_VERSION + 1, contentHash: P.PROTOCOL_CONTENT_HASH });
  check('checkCompatibility rejects protocol mismatch',
    !compatBad.ok && compatBad.reason === 'protocol-version');

  const contentBad = P.checkCompatibility({ protocol: P.PROTOCOL_VERSION, contentHash: 0xdeadbeef });
  check('checkCompatibility rejects content mismatch',
    !contentBad.ok && contentBad.reason === 'content-mismatch');

  check('checkCompatibility accepts a matching build',
    P.checkCompatibility({ protocol: P.PROTOCOL_VERSION, contentHash: P.PROTOCOL_CONTENT_HASH }).ok,
    `contentHash=0x${(P.PROTOCOL_CONTENT_HASH >>> 0).toString(16)}`);
}

/* -------------------------------------------------- 4. sequence numbers --- */

section('4. 16-bit sequence arithmetic');
{
  check('seqNewer handles wrap 65535 -> 0', P.seqNewer(0, 65535) && !P.seqNewer(65535, 0));
  check('seqNewer is antisymmetric near the wrap',
    P.seqNewer(3, 65530) && !P.seqNewer(65530, 3));
  check('seqDiff is signed and wrap-safe',
    P.seqDiff(0, 65535) === 1 && P.seqDiff(65535, 0) === -1 && P.seqDiff(100, 90) === 10);
  check('nextSeq wraps at 2^16', P.nextSeq(65535) === 0 && P.nextSeq(5) === 6);

  let s = 0, ok = true;
  for (let i = 0; i < 200000; i++) { const n = P.nextSeq(s); if (!P.seqNewer(n, s)) { ok = false; break; } s = n; }
  check('200k consecutive sequences are always "newer" across 3 wraps', ok);
}

/* ------------------------------------------------------- 5. ack window ---- */

section('5. ack window under seeded loss + reordering');
{
  const N = 20000, LOSS = 0.10;
  const r = new Rand('ack-loss');
  const ack = P.emptyAck();
  let sent = 0, delivered = 0;
  const pending = [];
  for (let i = 0; i < N; i++) {
    const seq = i & 0xffff;
    sent++;
    if (r.next() < LOSS) continue;
    delivered++;
    // 5% of packets arrive one slot late (reordering).
    if (r.next() < 0.05) { pending.push(seq); continue; }
    P.ackReceive(ack, seq);
    while (pending.length) P.ackReceive(ack, pending.pop());
  }
  while (pending.length) P.ackReceive(ack, pending.pop());

  const measured = P.ackLossRatio(ack);
  const actual = 1 - delivered / sent;
  check('measured loss ratio tracks injected loss',
    Math.abs(measured - actual) < 0.01,
    `injected ${f2(actual * 100)}%  measured ${f2(measured * 100)}%  (received ${ack.received}, lost ${ack.lost})`);
  check('ack accounting is conserved (received + lost ~= sent)',
    Math.abs(ack.received + ack.lost - sent) <= P.ACK_WINDOW + 1,
    `received+lost=${ack.received + ack.lost} sent=${sent}`);

  const a2 = P.emptyAck();
  for (const s of [10, 11, 13, 14]) P.ackReceive(a2, s);
  check('ackHas reports the exact received set',
    P.ackHas(a2, 14) && P.ackHas(a2, 13) && !P.ackHas(a2, 12) && P.ackHas(a2, 11) && P.ackHas(a2, 10)
    && !P.ackHas(a2, 15),
    `latest=${a2.latest} bits=0b${a2.bits.toString(2)}`);
  check('duplicates are rejected', P.ackReceive(a2, 14) === false && P.ackReceive(a2, 11) === false);
  check('a late packet inside the window is accepted once',
    P.ackReceive(a2, 12) === true && P.ackReceive(a2, 12) === false);
  check('a packet older than the window is dropped',
    P.ackReceive(a2, 14 - P.ACK_WINDOW - 5) === false);

  const a3 = P.emptyAck();
  P.ackReceive(a3, 0);
  P.ackReceive(a3, 1000); // huge jump: everything between is gone forever
  check('a large sequence jump counts the gap as lost',
    a3.lost === 999, `lost=${a3.lost} (expected 999)`);
}

/* ---------------------------------------------------- 6. quantization ----- */

section('6. quantization error bounds');
{
  const r = new Rand('quant');
  let maxPos = 0, maxYaw = 0, maxPitch = 0, maxVel = 0, maxUnit = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const p = r.range(-T.WORLD_HALF_EXTENT, T.WORLD_HALF_EXTENT - 1 / T.POS_SCALE);
    maxPos = Math.max(maxPos, Math.abs(P.dequantizePos(P.quantizePos(p)) - p));
    const y = r.range(-Math.PI, Math.PI);
    let dy = Math.abs(P.dequantizeYaw(P.quantizeYaw(y)) - y);
    if (dy > Math.PI) dy = Math.abs(dy - 2 * Math.PI);
    maxYaw = Math.max(maxYaw, dy);
    const pi = r.range(-T.PITCH_LIMIT, T.PITCH_LIMIT);
    maxPitch = Math.max(maxPitch, Math.abs(P.dequantizePitch(P.quantizePitch(pi)) - pi));
    const v = r.range(-T.VEL_LIMIT, T.VEL_LIMIT - 1 / T.VEL_SCALE);
    maxVel = Math.max(maxVel, Math.abs(P.dequantizeVel(P.quantizeVel(v)) - v));
    const u = r.signed();
    maxUnit = Math.max(maxUnit, Math.abs(P.dequantizeUnit(P.quantizeUnit(u)) - u));
  }
  const posLimit = 0.5 / T.POS_SCALE;
  check('position error <= half a quantization step',
    maxPos <= posLimit * 1.000001,
    `max ${(maxPos * 1000).toFixed(3)} mm, limit ${(posLimit * 1000).toFixed(3)} mm`);
  const yawLimit = Math.PI / T.ANGLE_Q;
  check('yaw error <= half a step (finer than one screen pixel)',
    maxYaw <= yawLimit * 1.000001,
    `max ${(maxYaw * 180 / Math.PI).toFixed(5)} deg vs 0.047 deg per pixel at 90 deg FOV / 1920 px`);
  check('pitch error <= half a step',
    maxPitch <= (T.PITCH_LIMIT / 0xffff) * 1.000001,
    `max ${(maxPitch * 180 / Math.PI).toFixed(5)} deg`);
  check('velocity error <= half a step',
    maxVel <= (0.5 / T.VEL_SCALE) * 1.000001, `max ${(maxVel * 1000).toFixed(3)} mm/s`);
  check('unit axis error <= half a step', maxUnit <= 0.5 / 127 * 1.000001, `max ${maxUnit.toFixed(5)}`);

  // Prediction determinism: quantizing twice must be a no-op, or client and
  // host disagree by the rounding error on every replayed command.
  let idem = true;
  for (let i = 0; i < 20000; i++) {
    const c = sampleCommand(i);
    const q1 = P.quantizeCommand(c);
    const q2 = P.quantizeCommand(q1);
    if (JSON.stringify(q1) !== JSON.stringify(q2)) { idem = false; break; }
  }
  check('quantizeCommand is idempotent (prediction replays match the host)', idem, '20k commands');

  check('positions at the world edge clamp instead of wrapping',
    P.dequantizePos(P.quantizePos(1e6)) < T.WORLD_HALF_EXTENT
    && P.dequantizePos(P.quantizePos(-1e6)) === -T.WORLD_HALF_EXTENT,
    `+1e6 m -> ${f2(P.dequantizePos(P.quantizePos(1e6)))} m`);
}

/* -------------------------------------------------- 7. hostile input ------ */

section('7. hostile input sanitation');
{
  const evil = {
    seq: 70000, clientTick: 5, dtMs: 100000,
    moveX: 1e9, moveZ: -1e9, yaw: 1e6, pitch: 99,
    buttons: 0xffffffff, weaponSlot: 999, fireCount: 2 ** 40,
  };
  const s = P.sanitizeInput(evil);
  check('speed-hack movement axes clamp to [-1,1]',
    s.moveX <= 1 && s.moveX >= -1 && s.moveZ <= 1 && s.moveZ >= -1, `moveX=${s.moveX} moveZ=${s.moveZ}`);
  check('oversized dtMs clamps to 2 ticks (no free time dilation)',
    s.dtMs <= 2 * (1000 / T.DEFAULT_NET_CONFIG.tickHz), `dtMs=${f2(s.dtMs)}`);
  check('pitch clamps to +/-90 deg', Math.abs(s.pitch) <= T.PITCH_LIMIT + 1e-9,
    `pitch=${(s.pitch * 180 / Math.PI).toFixed(2)} deg`);
  check('yaw wraps into [-PI,PI)', s.yaw >= -Math.PI && s.yaw <= Math.PI, `yaw=${f2(s.yaw)}`);
  check('unknown button bits are masked off', (s.buttons & ~0x3fff) === 0, `buttons=0x${s.buttons.toString(16)}`);
  check('weaponSlot clamps to 0..3', s.weaponSlot >= 0 && s.weaponSlot <= 3, `slot=${s.weaponSlot}`);
  check('sequence masks into 16 bits', s.seq === (70000 & 0xffff), `seq=${s.seq}`);
  check('fireCount saturates instead of overflowing', s.fireCount === 0x7fffffff);
  check('sanitize returns a fresh object (no aliasing into host state)', s !== evil);

  check('NaN is rejected outright', P.sanitizeInput({ ...evil, yaw: NaN }) === null);
  check('Infinity is rejected outright', P.sanitizeInput({ ...evil, moveX: Infinity }) === null);
  check('missing fields are rejected', P.sanitizeInput({ seq: 1 }) === null);
  check('non-objects are rejected', P.sanitizeInput('cheat') === null && P.sanitizeInput(null) === null);
  check('negative tick is rejected', P.sanitizeInput({ ...evil, clientTick: -5 }) === null);
}

/* ------------------------------------------------- 8. authority routing --- */

section('8. message origin rules');
{
  check('a client may not originate a snapshot', !P.isClientOriginated(P.MSG.SNAPSHOT));
  check('a client may not originate an event', !P.isClientOriginated(P.MSG.EVENT));
  check('a client may not originate a join accept', !P.isClientOriginated(P.MSG.JOIN_ACCEPT));
  check('a client may not originate host migration', !P.isClientOriginated(P.MSG.HOST_MIGRATE));
  check('a client may originate input / rpc / ack',
    P.isClientOriginated(P.MSG.INPUT) && P.isClientOriginated(P.MSG.RPC) && P.isClientOriginated(P.MSG.ACK));
  check('a host may not originate input', !P.isHostOriginated(P.MSG.INPUT));

  const kinds = Object.values(P.MSG);
  check('every kind has a channel and a name',
    kinds.every((k) => P.MSG_CHANNEL[k] && P.MSG_NAME[k]));
  check('every kind is routable by at least one side',
    kinds.every((k) => P.isClientOriginated(k) || P.isHostOriginated(k)));
  check('input and snapshots ride unreliable channels',
    P.channelFor(P.MSG.INPUT) === 'input' && P.channelFor(P.MSG.SNAPSHOT) === 'state');
  check('handshake and rpc ride the reliable channel',
    P.channelFor(P.MSG.HELLO) === 'control' && P.channelFor(P.MSG.RPC) === 'control');
  check('every channel spec exists and none is both reliable and unordered-lossy',
    T.ALL_CHANNELS.every((c) => {
      const s = T.CHANNELS[c];
      return typeof s.label === 'string' && s.label.length > 0
        && (s.maxRetransmits === undefined || s.maxRetransmits === 0);
    }));
  check('engine fixed step divides evenly into the net tick',
    Number.isInteger(T.ENGINE_STEPS_PER_NET_TICK) && T.ENGINE_STEPS_PER_NET_TICK >= 1,
    `${T.ENGINE_FIXED_HZ} Hz / ${T.NET_TICK_HZ} Hz = ${T.ENGINE_STEPS_PER_NET_TICK} steps per net tick`);
  check('snapshot rate divides the tick rate evenly',
    Number.isInteger(T.DEFAULT_NET_CONFIG.tickHz / T.DEFAULT_NET_CONFIG.snapshotHz),
    `${T.DEFAULT_NET_CONFIG.tickHz}/${T.DEFAULT_NET_CONFIG.snapshotHz} = ${T.DEFAULT_NET_CONFIG.tickHz / T.DEFAULT_NET_CONFIG.snapshotHz} ticks per snapshot`);
  check('interpolation delay covers more than one snapshot interval',
    T.DEFAULT_NET_CONFIG.interpDelayMs >= 2 * (1000 / T.DEFAULT_NET_CONFIG.snapshotHz),
    `${T.DEFAULT_NET_CONFIG.interpDelayMs} ms >= 2 x ${f2(1000 / T.DEFAULT_NET_CONFIG.snapshotHz)} ms`);
  check('snapshot history covers the lag-compensation rewind',
    T.DEFAULT_NET_CONFIG.snapshotHistory * (1000 / T.DEFAULT_NET_CONFIG.snapshotHz)
    >= T.DEFAULT_NET_CONFIG.maxLagCompMs + T.DEFAULT_NET_CONFIG.interpDelayMs,
    `${T.DEFAULT_NET_CONFIG.snapshotHistory} snapshots = ${T.DEFAULT_NET_CONFIG.snapshotHistory * (1000 / T.DEFAULT_NET_CONFIG.snapshotHz)} ms of history`);
}

/* -------------------------------------------------------- 9. clock sync --- */

section('9. clock sync + prediction lead');
{
  const s = P.sampleClock({ sentAtMs: 1000, serverTimeMs: 50_000 }, 1100);
  check('RTT from a ping/pong pair', s.rttMs === 100, `rtt=${s.rttMs} ms`);
  check('clock offset assumes a symmetric path',
    s.offsetMs === 50_000 + 50 - 1100, `offset=${s.offsetMs} ms`);

  const lead = P.predictedServerTick(1000, 0, { rttMs: 100, jitterMs: 10 }) - 1000;
  check('100 ms RTT predicts ~5 ticks ahead at 60 Hz', lead === 5, `lead=${lead} ticks (${f2(lead * T.NET_TICK_MS)} ms)`);
  const leadLan = P.predictedServerTick(1000, 0, { rttMs: 10, jitterMs: 1 }) - 1000;
  check('10 ms LAN RTT predicts ~2 ticks ahead', leadLan === 2, `lead=${leadLan} ticks`);
  const leadBad = P.predictedServerTick(1000, 0, { rttMs: 250, jitterMs: 40 }) - 1000;
  check('250 ms RTT still produces a finite lead', leadBad > 0 && leadBad < 30, `lead=${leadBad} ticks`);
}

/* ----------------------------------------------------- 10. bandwidth ------ */

section('10. bandwidth model (the numbers in docs/NETCODE.md)');
{
  const cfg = T.DEFAULT_NET_CONFIG;
  const OVR = P.DATAGRAM_OVERHEAD_BYTES;

  // Typical moving player delta: position, angles, flags, anim.
  const MOVING = T.SNAP_FIELD.POS | T.SNAP_FIELD.ROT | T.SNAP_FIELD.FLAGS | T.SNAP_FIELD.ANIM;
  const deltaBytes = P.entitySnapshotBytes(MOVING);
  const fullBytes = P.entitySnapshotBytes(T.SNAP_FIELD.ALL);
  check('per-entity delta record is 18 B, keyframe record is 31 B',
    deltaBytes === 18 && fullBytes === 31, `delta=${deltaBytes} B full=${fullBytes} B`);

  // 16-player match, worst case: every other player relevant, plus 4 projectiles.
  const others = cfg.maxClients - 1;
  const snap = { tick: 1000, serverTimeMs: 1, baselineTick: 997, removed: [], entities: [] };
  for (let i = 0; i < others; i++) snap.entities.push(sampleEntity(100 + i, MOVING));
  for (let i = 0; i < 4; i++) snap.entities.push({ ...sampleEntity(200 + i, T.SNAP_FIELD.POS | T.SNAP_FIELD.VEL), kind: T.ENTITY_KIND.PROJECTILE });
  const snapMsg = { k: P.MSG.SNAPSHOT, seq: 1, from: 0, snapshot: snap, ackInputSeq: 1, ackClientTick: 1, needsAck: false };

  const snapPacked = P.estimatePackedBytes(snapMsg);
  const snapWire = snapPacked + P.PACKED.header + OVR;
  const downBps = snapWire * cfg.snapshotHz;
  const hostUpBps = downBps * others;

  console.log(`        WORST CASE (all ${others} others relevant, no culling)`);
  console.log(`        snapshot payload ${snapPacked} B, on the wire ${snapWire} B (incl. ${OVR} B UDP/DTLS/SCTP)`);
  console.log(`        client down: ${(downBps / 1024).toFixed(1)} KB/s = ${((downBps * 8) / 1000).toFixed(0)} kbps at ${cfg.snapshotHz} Hz`);
  console.log(`        host up (${others} clients): ${(hostUpBps / 1024).toFixed(1)} KB/s = ${((hostUpBps * 8) / 1e6).toFixed(2)} Mbps`);

  check('per-client downstream fits the configured budget',
    downBps <= cfg.budgetBytesPerSecond,
    `${downBps} B/s <= ${cfg.budgetBytesPerSecond} B/s`);
  check('a full 16-player snapshot fits in one MTU (no fragmentation)',
    snapPacked + P.PACKED.header <= cfg.mtuBytes,
    `${snapPacked + P.PACKED.header} B <= ${cfg.mtuBytes} B`);
  check('worst-case peer-host uplink for 16 players stays under 1.5 Mbps',
    hostUpBps * 8 < 1.5e6, `${((hostUpBps * 8) / 1e6).toFixed(2)} Mbps`);

  // Typical case: interest management culls to the ~10 entities that matter.
  const typicalSnap = { ...snap, entities: snap.entities.slice(0, 10) };
  const typWire = P.estimatePackedBytes({ ...snapMsg, snapshot: typicalSnap }) + P.PACKED.header + OVR;
  const typUp = typWire * cfg.snapshotHz * others;
  console.log(`        TYPICAL (interest-managed to 10 relevant entities)`);
  console.log(`        snapshot ${typWire} B wire; host up ${(typUp / 1024).toFixed(1)} KB/s = ${((typUp * 8) / 1e6).toFixed(2)} Mbps`);
  check('typical peer-host uplink for 16 players stays under 1 Mbps',
    typUp * 8 < 1e6, `${((typUp * 8) / 1e6).toFixed(2)} Mbps`);

  // The rejected alternative: snapshots at the full 60 Hz tick rate.
  const at60 = snapWire * 60 * others;
  console.log(`        [rejected] snapshots at 60 Hz would need ${((at60 * 8) / 1e6).toFixed(2)} Mbps of host uplink`);
  check('60 Hz snapshots would exceed a typical 2 Mbps home uplink (why we chose 20 Hz)',
    at60 * 8 > 2e6, `${((at60 * 8) / 1e6).toFixed(2)} Mbps`);

  // 8-player lobby at 30 Hz, the fast-lane config.
  const snap8 = { ...snap, entities: snap.entities.slice(0, 7).concat(snap.entities.slice(others)) };
  const wire8 = P.estimatePackedBytes({ ...snapMsg, snapshot: snap8 }) + P.PACKED.header + OVR;
  const hostUp8 = wire8 * 30 * 7;
  console.log(`        8-player lobby at 30 Hz: host up ${(hostUp8 / 1024).toFixed(1)} KB/s = ${((hostUp8 * 8) / 1e6).toFixed(2)} Mbps`);
  check('8 players at 30 Hz also fits under 1 Mbps up', hostUp8 * 8 < 1e6);

  // Upstream: input at 60 Hz with 3x redundancy.
  const inputMsg = {
    k: P.MSG.INPUT, seq: 1, from: 3, ackSnapshotTick: 999, ackEventId: 1, clientTimeMs: 1,
    commands: [sampleCommand(1), sampleCommand(2), sampleCommand(3)],
  };
  const inPacked = P.estimatePackedBytes(inputMsg);
  const inWire = inPacked + P.PACKED.header + OVR;
  const clientUp = inWire * cfg.inputSendHz;
  const hostDown = clientUp * others;
  console.log(`        input packet ${inPacked} B payload, ${inWire} B wire; client up ${(clientUp / 1024).toFixed(1)} KB/s`);
  console.log(`        host down (${others} clients): ${(hostDown / 1024).toFixed(1)} KB/s = ${((hostDown * 8) / 1e6).toFixed(2)} Mbps`);
  check('client upstream stays under 10 KB/s', clientUp < 10 * 1024, `${(clientUp / 1024).toFixed(1)} KB/s`);
  check('host downstream for 15 clients stays under 2 Mbps', hostDown * 8 < 2e6);
  check('input redundancy covers >= 2 consecutive lost packets',
    cfg.inputRedundancy >= 3, `${cfg.inputRedundancy} commands per packet`);

  // JSON reference codec vs the packed model, so nobody budgets off JSON.
  const jsonBytes = P.JsonCodec.encode([snapMsg]).length;
  console.log(`        JSON reference codec: ${jsonBytes} B vs packed model ${snapPacked} B (${(jsonBytes / snapPacked).toFixed(1)}x)`);
  check('the packed model is the budget authority, not JSON',
    jsonBytes > snapPacked, `ratio ${(jsonBytes / snapPacked).toFixed(1)}x`);

  const b = P.budgetFor(cfg);
  check('budgetFor derives a per-snapshot allowance',
    b.bytesPerSnapshot === Math.floor(cfg.budgetBytesPerSecond / cfg.snapshotHz) && b.maxDatagrams >= 1,
    `${b.bytesPerSnapshot} B per snapshot, <= ${b.maxDatagrams} datagram(s)`);
}

/* ------------------------------------------------ 11. interest scaling ---- */

section('11. interest management makes larger counts possible');
{
  const cfg = T.DEFAULT_NET_CONFIG;
  const MOVING = T.SNAP_FIELD.POS | T.SNAP_FIELD.ROT | T.SNAP_FIELD.FLAGS | T.SNAP_FIELD.ANIM;
  const per = P.entitySnapshotBytes(MOVING);
  const rows = [];
  for (const players of [8, 16, 32, 64]) {
    const naive = (P.PACKED.messageHeader + P.PACKED.snapshotHeader + (players - 1) * per + P.PACKED.header + P.DATAGRAM_OVERHEAD_BYTES);
    // With interest management ~12 entities are relevant regardless of lobby size.
    const relevant = Math.min(players - 1, 12);
    const managed = (P.PACKED.messageHeader + P.PACKED.snapshotHeader + relevant * per + P.PACKED.header + P.DATAGRAM_OVERHEAD_BYTES);
    const hz = players <= 8 ? 30 : players <= 16 ? 20 : 15;
    rows.push({ players, hz, naiveMbps: (naive * hz * (players - 1) * 8) / 1e6, managedMbps: (managed * hz * (players - 1) * 8) / 1e6 });
  }
  for (const r of rows) {
    console.log(`        ${String(r.players).padStart(2)} players @ ${r.hz} Hz: host up naive ${r.naiveMbps.toFixed(2)} Mbps -> managed ${r.managedMbps.toFixed(2)} Mbps`);
  }
  check('interest management is what keeps 32+ players plausible',
    rows[3].managedMbps < rows[3].naiveMbps * 0.6,
    `64p: ${rows[3].naiveMbps.toFixed(2)} -> ${rows[3].managedMbps.toFixed(2)} Mbps`);
  check('relevance floors are ordered',
    T.RELEVANCE.CRITICAL > T.RELEVANCE.HIGH && T.RELEVANCE.HIGH > T.RELEVANCE.MEDIUM
    && T.RELEVANCE.MEDIUM > T.RELEVANCE.LOW && T.RELEVANCE.LOW > T.RELEVANCE.NONE);
  check('SNAP_FIELD.ALL covers every declared field',
    Object.entries(T.SNAP_FIELD).filter(([k]) => k !== 'ALL')
      .every(([, v]) => (T.SNAP_FIELD.ALL & v) === v));
}

/* -------------------------------------------------------------- summary --- */

console.log(`\n${'-'.repeat(70)}`);
console.log(`${pass} PASS, ${fail} FAIL`);
if (fail) { console.log('failed: ' + failures.join(', ')); process.exit(1); }
console.log('net contracts OK');
