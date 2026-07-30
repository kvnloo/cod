#!/usr/bin/env node
/**
 * net-transport.mjs — headless proof that the transport layer does what it claims.
 *
 *   node tools/net-transport.mjs
 *
 * Netcode cannot be verified by looking at a screenshot, so everything here runs
 * in virtual time against `LoopbackLink`: no sockets, no timers, no wall clock.
 * Every impairment draw comes from the seeded RNG in src/core/Rand.ts, so a
 * failure prints a seed that reproduces it exactly.
 *
 * The headline case is the one in the brief: two transports, 80 ms RTT, 2% loss.
 * Reliable-ordered traffic must arrive complete and in order; unreliable traffic
 * must lose ~2% and never deliver a stale packet.
 */

// The loader hook must be evaluated before the TypeScript graph is resolved, so
// the game modules come in through a dynamic import rather than a static one.
import './net-ts-loader.mjs';

const { CH_CONTROL, CH_STATE, LoopbackHub, WebSocketTransport, createLoopbackPair } = await import(
  '../src/net/transport/index.ts'
);

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) passed++;
  else failures.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

const fmt = (n, d = 2) => Number(n).toFixed(d);

/* ------------------------------------------------------------------ payload */

function encode(index, sendMs) {
  const b = new Uint8Array(12);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, index, true);
  dv.setFloat64(4, sendMs, true);
  return b;
}

function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { index: dv.getUint32(0, true), sendMs: dv.getFloat64(4, true) };
}

/** Collects everything a receiving end saw, per channel. */
function collector(transport) {
  const state = {
    control: [],
    stateCh: [],
    controlOrdered: true,
    stateOrdered: true,
    latencies: { control: [], stateCh: [] },
  };
  transport.onMessage((msg) => {
    const { index, sendMs } = decode(msg.bytes);
    if (msg.channel === CH_CONTROL) {
      const prev = state.control.length ? state.control[state.control.length - 1] : -1;
      if (index !== prev + 1) state.controlOrdered = false;
      state.control.push(index);
      state.latencies.control.push(msg.recvMs - sendMs);
    } else if (msg.channel === CH_STATE) {
      const prev = state.stateCh.length ? state.stateCh[state.stateCh.length - 1] : -1;
      if (index <= prev) state.stateOrdered = false;
      state.stateCh.push(index);
      state.latencies.stateCh.push(msg.recvMs - sendMs);
    }
  });
  return state;
}

const maxOf = (a) => (a.length ? a.reduce((x, y) => (y > x ? y : x), -Infinity) : 0);
const minOf = (a) => (a.length ? a.reduce((x, y) => (y < x ? y : x), Infinity) : 0);
const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/* ============================================================================
 * 1. THE HEADLINE CASE — 80 ms RTT, 2% loss
 * ==========================================================================*/

function headline(seed = 'brief') {
  const MESSAGES = 3000;
  const SEND_EVERY_MS = 5; // 200 Hz, a busy host tick plus input echo
  const link = createLoopbackPair({
    seed,
    conditions: { latencyMs: 40, jitterMs: 0, loss: 0.02 },
    pingIntervalMs: 100,
  });
  link.connect();

  const rx = collector(link.b);
  const droppedIndices = [];
  let sent = 0;
  let nextSendAt = 0;
  const refused = { control: 0, stateCh: 0 };

  const totalMs = MESSAGES * SEND_EVERY_MS + 1500;
  for (let t = 1; t <= totalMs; t++) {
    if (sent < MESSAGES && t >= nextSendAt) {
      nextSendAt = t + SEND_EVERY_MS;
      const payload = encode(sent, t);
      if (!link.a.send(CH_CONTROL, payload)) refused.control++;
      if (!link.a.send(CH_STATE, payload)) refused.stateCh++;
      sent++;
    }
    link.poll(t);
  }

  const seenState = new Set(rx.stateCh);
  for (let i = 0; i < MESSAGES; i++) if (!seenState.has(i)) droppedIndices.push(i);

  const ctrlLink = link.channelCounters('aToB', CH_CONTROL);
  const stateLink = link.channelCounters('aToB', CH_STATE);
  const stats = link.a.stats;
  const bStats = link.b.stats;

  section(`headline: 80 ms RTT, 2% loss, ${MESSAGES} msgs/channel (seed "${seed}")`);

  check(
    'reliable-ordered: every message arrives',
    rx.control.length === MESSAGES,
    `${rx.control.length}/${MESSAGES} arrived, ${refused.control} refused at send`,
  );
  check(
    'reliable-ordered: strictly in order, no gaps',
    rx.controlOrdered && rx.control[0] === 0 && rx.control[MESSAGES - 1] === MESSAGES - 1,
    `first=${rx.control[0]} last=${rx.control[rx.control.length - 1]}`,
  );
  check(
    'reliable-ordered: link paid for loss in retransmits, not drops',
    ctrlLink.dropped === 0 && ctrlLink.retransmitted > 0,
    `${ctrlLink.retransmitted} retransmits, ${ctrlLink.dropped} drops of ${ctrlLink.sent} sent`,
  );

  const observedLoss = stateLink.dropped / stateLink.sent;
  check(
    'unreliable: drops land near the configured 2%',
    near(observedLoss, 0.02, 0.006),
    `${stateLink.dropped}/${stateLink.sent} = ${fmt(observedLoss * 100)}% dropped`,
  );
  check(
    'unreliable: what survived is exactly what the link delivered',
    rx.stateCh.length === stateLink.delivered && rx.stateCh.length === MESSAGES - stateLink.dropped,
    `app got ${rx.stateCh.length}, link delivered ${stateLink.delivered}, ${droppedIndices.length} missing`,
  );
  check(
    'unreliable: never delivers a stale packet',
    rx.stateOrdered,
    'receive sequence is strictly increasing',
  );

  check(
    'measured RTT matches the 80 ms link',
    near(stats.rttMs, 80, 6),
    `rtt=${fmt(stats.rttMs, 1)}ms min=${fmt(stats.rttMinMs, 1)}ms jitter=${fmt(stats.jitterMs, 2)}ms`,
  );
  check(
    'receiver measures inbound loss near 2%',
    near(bStats.lossIn, 0.02, 0.012),
    `lossIn=${fmt(bStats.lossIn * 100)}%`,
  );
  check(
    'sender learns its outbound loss from the peer',
    near(stats.lossOut, 0.02, 0.012),
    `lossOut=${fmt(stats.lossOut * 100)}% (peer-reported)`,
  );

  const oneWay = rx.latencies.stateCh;
  check(
    'unreliable one-way latency is the link latency, no queueing',
    near(minOf(oneWay), 40, 2) && near(maxOf(oneWay), 40, 3),
    `min=${fmt(minOf(oneWay), 1)} avg=${fmt(avgOf(oneWay), 1)} max=${fmt(maxOf(oneWay), 1)} ms`,
  );

  console.log(
    `      bandwidth: out ${fmt(stats.bytesOutPerSec / 1024, 1)} KiB/s ` +
      `(${fmt(stats.packetsOutPerSec, 0)} pkt/s), in ${fmt(bStats.bytesInPerSec / 1024, 1)} KiB/s`,
  );

  return { droppedIndices, link };
}

/* ============================================================================
 * 2. DETERMINISM
 * ==========================================================================*/

function determinism() {
  section('determinism: the same seed loses the same packets');
  const a = headlineQuiet('repro-seed');
  const b = headlineQuiet('repro-seed');
  const c = headlineQuiet('other-seed');

  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  const different = a.length !== c.length || a.some((v, i) => v !== c[i]);
  check(
    'identical seed reproduces the drop set exactly',
    same,
    `${a.length} drops, first five [${a.slice(0, 5).join(', ')}]`,
  );
  check(
    'a different seed produces a different drop set',
    different,
    `${c.length} drops, first five [${c.slice(0, 5).join(', ')}]`,
  );
}

function headlineQuiet(seed) {
  const MESSAGES = 800;
  const link = createLoopbackPair({ seed, conditions: { latencyMs: 40, loss: 0.05 } });
  link.connect();
  const seen = new Set();
  link.b.onMessage((m) => seen.add(decode(m.bytes).index));
  let sent = 0;
  for (let t = 1; t <= MESSAGES * 2 + 500; t++) {
    if (sent < MESSAGES && t % 2 === 0) {
      link.a.send(CH_STATE, encode(sent, t));
      sent++;
    }
    link.poll(t);
  }
  const missing = [];
  for (let i = 0; i < MESSAGES; i++) if (!seen.has(i)) missing.push(i);
  return missing;
}

/* ============================================================================
 * 3. REORDERING AND THE SEQUENCE FILTER
 * ==========================================================================*/

function reordering() {
  section('jitter: reordered unreliable packets are discarded, not replayed');
  const link = createLoopbackPair({
    seed: 'jitter',
    conditions: { latencyMs: 40, jitterMs: 25, loss: 0, reorder: true },
  });
  link.connect();
  const rx = collector(link.b);
  const N = 1500;
  let sent = 0;
  for (let t = 1; t <= N * 3 + 600; t++) {
    if (sent < N && t % 3 === 0) {
      const p = encode(sent, t);
      link.a.send(CH_STATE, p);
      link.a.send(CH_CONTROL, p);
      sent++;
    }
    link.poll(t);
  }
  const stale = link.b.stats.dropsStale;
  const stateLink = link.channelCounters('aToB', CH_STATE);
  check(
    'jitter actually reordered packets',
    stale > 0,
    `${stale} of ${N} arrived out of order and were discarded as stale`,
  );
  check(
    'unreliable delivery stays strictly increasing despite reordering',
    rx.stateOrdered,
    `${rx.stateCh.length} delivered in order`,
  );
  check(
    'stale discards fully account for the difference',
    rx.stateCh.length === stateLink.delivered - stale,
    `${stateLink.delivered} delivered by link − ${stale} stale = ${rx.stateCh.length} to the app`,
  );
  check(
    'reliable-ordered is unaffected by reordering',
    rx.control.length === N && rx.controlOrdered,
    `${rx.control.length}/${N} in order`,
  );
  const jitterMs = link.a.stats.jitterMs;
  check(
    'jitter shows up in the stats',
    jitterMs > 1,
    `measured jitter (rttvar) ${fmt(jitterMs, 1)}ms on a ±25ms link`,
  );
}

/* ============================================================================
 * 4. HEAD-OF-LINE BLOCKING — the reason state does not go on a reliable channel
 * ==========================================================================*/

function headOfLine() {
  section('head-of-line: reliable pays in latency, unreliable pays in packets');
  const link = createLoopbackPair({
    seed: 'hol',
    conditions: { latencyMs: 50, jitterMs: 0, loss: 0.3 },
  });
  link.connect();
  const rx = collector(link.b);
  const N = 400;
  let sent = 0;
  for (let t = 1; t <= N * 5 + 2000; t++) {
    if (sent < N && t % 5 === 0) {
      const p = encode(sent, t);
      link.a.send(CH_CONTROL, p);
      link.a.send(CH_STATE, p);
      sent++;
    }
    link.poll(t);
  }
  const ctrl = rx.latencies.control;
  const st = rx.latencies.stateCh;
  check(
    'reliable loses nothing at 30% loss',
    rx.control.length === N && rx.controlOrdered,
    `${rx.control.length}/${N}`,
  );
  check(
    'reliable latency spikes far past the 50 ms floor',
    maxOf(ctrl) > 120,
    `control latency min=${fmt(minOf(ctrl), 0)} avg=${fmt(avgOf(ctrl), 1)} max=${fmt(maxOf(ctrl), 0)} ms`,
  );
  check(
    'unreliable latency never leaves the floor',
    maxOf(st) <= 51,
    `state latency min=${fmt(minOf(st), 0)} avg=${fmt(avgOf(st), 1)} max=${fmt(maxOf(st), 0)} ms`,
  );
  check(
    'unreliable instead loses about 30%',
    near(1 - rx.stateCh.length / N, 0.3, 0.05),
    `${N - rx.stateCh.length}/${N} = ${fmt((1 - rx.stateCh.length / N) * 100, 1)}% lost`,
  );
}

/* ============================================================================
 * 5. BUDGETS AND SIZE LIMITS
 * ==========================================================================*/

function budgets() {
  section('bandwidth budget and message size limits');
  const link = createLoopbackPair({
    seed: 'budget',
    conditions: { latencyMs: 5 },
    channels: [
      { name: CH_CONTROL, reliability: 'reliable-ordered', maxMessageBytes: 65535 },
      {
        name: CH_STATE,
        reliability: 'unreliable-sequenced',
        maxMessageBytes: 1180,
        budgetBytesPerSec: 2000,
        burstSeconds: 0.5,
      },
      { name: 'sys', reliability: 'unreliable', maxMessageBytes: 64 },
    ],
  });
  link.connect();
  link.poll(1);

  const body = new Uint8Array(100);
  let accepted = 0;
  for (let i = 0; i < 100; i++) if (link.a.send(CH_STATE, body)) accepted++;
  const burst = accepted;
  check(
    'a burst is capped at the token bucket, not the queue',
    burst >= 4 && burst <= 9 && link.a.stats.dropsBudget === 100 - burst,
    `${burst} of 100 accepted (1000B bucket / 150B wire), ${link.a.stats.dropsBudget} refused`,
  );

  for (let t = 2; t <= 1002; t++) link.poll(t);
  accepted = 0;
  for (let i = 0; i < 100; i++) if (link.a.send(CH_STATE, body)) accepted++;
  check(
    'the bucket refills at the configured rate',
    accepted >= 4 && accepted <= 9,
    `${accepted} accepted after 1 s of refill at 2000 B/s`,
  );

  const before = link.a.stats.dropsOversize;
  const tooBig = link.a.send(CH_STATE, new Uint8Array(2000));
  check(
    'an oversized unreliable message is refused, not fragmented',
    tooBig === false && link.a.stats.dropsOversize === before + 1,
    `2000 B on a ${link.a.maxMessageBytes(CH_STATE)} B channel`,
  );
  check(
    'the same payload is fine on the reliable channel',
    link.a.send(CH_CONTROL, new Uint8Array(2000)) === true,
    `limit ${link.a.maxMessageBytes(CH_CONTROL)} B`,
  );

  let threw = false;
  try {
    link.a.send('sys', new Uint8Array(4));
  } catch {
    threw = true;
  }
  check('the reserved sys channel rejects application traffic', threw);
}

/* ============================================================================
 * 6. DISCONNECT
 * ==========================================================================*/

function disconnect() {
  section('disconnect');
  const link = createLoopbackPair({ seed: 'bye', conditions: { latencyMs: 20 } });
  link.connect();
  link.poll(1);
  const states = [];
  link.b.onStateChange((s, r) => states.push(`${s}:${r}`));
  link.a.close('player quit');
  for (let t = 2; t <= 200; t++) link.poll(t);
  check(
    'a graceful close reaches the peer with its reason',
    link.b.state === 'closed' && states.some((s) => s.includes('player quit')),
    `peer saw [${states.join(', ')}]`,
  );
  check('sending on a closed transport is refused, not thrown', link.a.send(CH_STATE, new Uint8Array(4)) === false);

  const link2 = createLoopbackPair({
    seed: 'timeout',
    conditions: { latencyMs: 20 },
    timeoutMs: 1000,
  });
  link2.connect();
  link2.poll(1);
  link2.setConditions({ loss: 1 }); // total blackout in both directions
  let failedReason = '';
  link2.b.onStateChange((s, r) => {
    if (s === 'failed') failedReason = r;
  });
  for (let t = 2; t <= 4000; t++) link2.poll(t);
  check(
    'a silent link times out and fails',
    link2.b.state === 'failed' && /timeout/.test(failedReason),
    failedReason,
  );
}

/* ============================================================================
 * 7. ONE HOST, MANY CLIENTS, DIFFERENT CONNECTIONS
 * ==========================================================================*/

function hub() {
  section('LoopbackHub: one host, four clients, four different connections');
  const h = new LoopbackHub({ seed: 'hub', pingIntervalMs: 100 });
  const accepted = [];
  h.onConnection((t) => accepted.push(t.remoteId));

  const profiles = [
    ['alice', { latencyMs: 10, loss: 0 }],
    ['bob', { latencyMs: 45, loss: 0.01 }],
    ['carol', { latencyMs: 90, loss: 0.05 }],
    ['dave', { latencyMs: 150, jitterMs: 40, loss: 0.1 }],
  ];
  const clients = profiles.map(([id, cond]) => ({ id, ...h.addClient(id, cond) }));

  const inbox = new Map();
  for (const c of clients) {
    inbox.set(c.id, []);
    c.client.onMessage((m) => inbox.get(c.id).push(decode(m.bytes).index));
  }

  for (let t = 1; t <= 8000; t++) {
    // Snapshots at 100 Hz plus occasional control traffic — the shape of a real
    // host loop, and enough sequenced packets for the loss window to mean something.
    if (t % 10 === 0) {
      for (let i = 0; i < clients.length; i++) {
        // Each client gets its own payload — this is the interest-management shape.
        clients[i].host.send(CH_STATE, encode(i * 100000 + t, t));
        if (t % 100 === 0) clients[i].host.send(CH_CONTROL, encode(i * 100000 + t, t));
      }
    }
    h.poll(t);
  }

  check(
    'every client was accepted as its own transport',
    accepted.length === 4 && h.connections.length === 4,
    `accepted [${accepted.join(', ')}]`,
  );
  check(
    'per-client routing: nobody sees another client traffic',
    clients.every((c, i) => inbox.get(c.id).every((v) => Math.floor(v / 100000) === i)),
  );
  const rtts = clients.map((c) => c.client.stats.rttMs);
  check(
    'each client measures its own RTT',
    near(rtts[0], 20, 6) && near(rtts[1], 90, 8) && near(rtts[2], 180, 12) && near(rtts[3], 300, 40),
    rtts.map((r, i) => `${profiles[i][0]}=${fmt(r, 0)}ms`).join(' '),
  );
  const losses = clients.map((c) => c.client.stats.lossIn);
  check(
    'each client measures its own loss',
    near(losses[0], 0, 0.005) &&
      near(losses[1], 0.01, 0.012) &&
      near(losses[2], 0.05, 0.02) &&
      near(losses[3], 0.1, 0.03),
    losses.map((l, i) => `${profiles[i][0]}=${fmt(l * 100, 1)}% (want ${profiles[i][1].loss * 100}%)`).join(' '),
  );

  const before = h.connections.length;
  clients[1].client.close('rage quit');
  h.poll(8100);
  h.poll(8200);
  check(
    'a client leaving is removed from the host roster',
    h.connections.length === before - 1,
    `${before} → ${h.connections.length}`,
  );
  h.stop();
}

/* ============================================================================
 * 8. TRANSPORT-AGNOSTICISM — identical test body over two different wires
 * ==========================================================================*/

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.peer = null;
    this.pending = [];
  }
  addEventListener(type, fn) {
    const a = this.listeners.get(type) ?? [];
    a.push(fn);
    this.listeners.set(type, a);
  }
  removeEventListener(type, fn) {
    const a = this.listeners.get(type);
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  emit(type, ev) {
    for (const fn of (this.listeners.get(type) ?? []).slice()) fn(ev);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('closed');
    const copy =
      data instanceof ArrayBuffer
        ? data.slice(0)
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.peer.pending.push(copy);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { reason: 'closed' });
  }
  flush() {
    const q = this.pending;
    this.pending = [];
    for (const d of q) this.emit('message', { data: d });
  }
}

function socketPair() {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** One body, two wires. If this only passes on loopback the interface is a lie. */
function exercise(label, a, b, pump) {
  const N = 300;
  const rxB = collector(b);
  const rxA = collector(a);
  for (let t = 1; t <= N * 4 + 800; t++) {
    if (t % 4 === 0 && t / 4 <= N) {
      const i = t / 4 - 1;
      a.send(CH_CONTROL, encode(i, t));
      a.send(CH_STATE, encode(i, t));
      b.send(CH_CONTROL, encode(i, t));
    }
    pump(t);
  }
  check(
    `${label}: reliable-ordered arrives complete and in order (both directions)`,
    rxB.control.length === N && rxB.controlOrdered && rxA.control.length === N && rxA.controlOrdered,
    `a→b ${rxB.control.length}/${N}, b→a ${rxA.control.length}/${N}`,
  );
  check(
    `${label}: unreliable-sequenced arrives in order on a clean link`,
    rxB.stateCh.length === N && rxB.stateOrdered,
    `${rxB.stateCh.length}/${N}`,
  );
  check(
    `${label}: stats are populated`,
    a.stats.bytesOut > 0 && b.stats.bytesIn > 0 && a.stats.rttMs > 0,
    `rtt=${fmt(a.stats.rttMs, 1)}ms out=${a.stats.bytesOut}B in=${b.stats.bytesIn}B`,
  );
  return { rxA, rxB };
}

async function agnostic() {
  section('transport-agnosticism: the same test body over loopback and WebSocket');

  const link = createLoopbackPair({ seed: 'agnostic', conditions: { latencyMs: 15 } });
  await link.connect();
  exercise('loopback', link.a, link.b, (t) => link.poll(t));

  const [sa, sb] = socketPair();
  let now = 0;
  const clock = () => now;
  const wa = new WebSocketTransport({ socket: sa, clock, localId: 'wa', remoteId: 'wb', pingIntervalMs: 100 });
  const wb = new WebSocketTransport({ socket: sb, clock, localId: 'wb', remoteId: 'wa', pingIntervalMs: 100 });
  await Promise.all([wa.connect(), wb.connect()]);
  exercise('websocket', wa, wb, (t) => {
    now = t;
    sa.flush();
    sb.flush();
    wa.poll(t);
    wb.poll(t);
  });
  check(
    'websocket multiplexes every channel over one socket',
    wa.channels.length === 2 && wa.channels.map((c) => c.name).sort().join(',') === 'control,state',
    `channel ids ${wa.channels.map((c) => `${c.name}=${c.id}`).join(' ')}`,
  );
  wa.close('done');
  wb.close('done');
}

/* --------------------------------------------------------------------- main */

async function main() {
  const t0 = process.hrtime.bigint();
  headline('brief');
  determinism();
  reordering();
  headOfLine();
  budgets();
  disconnect();
  hub();
  await agnostic();

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const total = passed + failures.length;
  console.log(
    `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED`}  ` +
      `${passed}/${total} checks in ${fmt(ms, 0)}ms of wall time ` +
      `(minutes of simulated network time)`,
  );
  if (failures.length) {
    console.log(`failing: ${failures.join('\n         ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FAIL  harness threw:', err);
  process.exit(1);
});
