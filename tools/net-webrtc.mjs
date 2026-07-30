#!/usr/bin/env node
/**
 * net-webrtc.mjs — headless proof that the peer-to-peer path actually negotiates.
 *
 *   node tools/net-webrtc.mjs
 *
 * tools/net-transport.mjs covers everything above the wire, because LoopbackLink
 * and WebSocketTransport share BaseTransport with WebRtcTransport. What it cannot
 * cover is the part that is unique to WebRTC and is exactly the part that breaks
 * in the field: offer/answer sequencing, trickle-ICE candidates that arrive
 * before the remote description exists, negotiated channel ids agreeing on both
 * sides without a handshake, ICE restart, and teardown.
 *
 * So this file supplies a mock RTCPeerConnection — about 200 lines — and runs the
 * REAL WebRtcTransport, WebRtcHost and joinAsGuest against it. Nothing in src/ is
 * stubbed; only the browser API underneath it is. The last group then stands up
 * the real tools/signal.mjs over a real TCP socket and negotiates a real session
 * through it, which is the one thing a mock cannot prove: that the hand-rolled
 * RFC 6455 server and the TypeScript signalling client actually interoperate.
 *
 * Every impairment draw comes from the seeded RNG in src/core/Rand.ts.
 */

import './net-ts-loader.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  CH_CONTROL,
  CH_STATE,
  MemorySignalingHub,
  WebRtcHost,
  WebRtcTransport,
  WebSocketSignaling,
  joinAsGuest,
} = await import('../src/net/transport/index.ts');
const { Rand } = await import('../src/core/Rand.ts');

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? `   ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `   ${detail}` : ''}`);
  }
}

function group(title) {
  const bar = '─'.repeat(Math.max(4, 70 - title.length));
  console.log(`\n── ${title} ${bar}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spin the event loop and the transports until `fn()` is true or we give up. */
async function until(fn, transports, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const t of transports) t?.poll?.(performance.now());
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(2);
  }
}

/* ------------------------------------------------- a mock WebRTC implementation */

/**
 * Faithful enough for the state machine under test: offer/answer with a real
 * signalingState, trickle candidates delivered through the application's own
 * signalling path, negotiated channels matched by id, and per-channel delivery
 * that honours maxRetransmits: 0 by actually dropping packets.
 */
class MockWorld {
  constructor({ seed = 'webrtc', latencyMs = 20, loss = 0 } = {}) {
    this.rand = new Rand(seed);
    this.latencyMs = latencyMs;
    this.loss = loss;
    this.pcs = new Map();
    this.nextToken = 1;
    this.candidatesEmitted = 0;
    this.candidatesAdded = 0;
    this.candidatesRejected = 0;
    this.sent = 0;
    this.dropped = 0;
    this.timers = new Set();
    this.factory = (cfg) => new MockPeerConnection(this, cfg);
  }

  later(ms, fn) {
    const h = setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
  }

  /** Drop every pending delivery — otherwise node keeps the process alive. */
  cleanup() {
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
  }
}

class MockIceCandidate {
  constructor(candidate, gen) {
    this.candidate = candidate;
    this.sdpMid = '0';
    this.sdpMLineIndex = 0;
    this.usernameFragment = `ufrag${gen}`;
  }
  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

class MockDataChannel {
  constructor(pc, label, init) {
    this.pc = pc;
    this.label = label;
    this.id = init.id;
    this.negotiated = init.negotiated === true;
    this.ordered = init.ordered !== false;
    this.maxRetransmits = init.maxRetransmits;
    this.readyState = 'connecting';
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
  }

  get unreliable() {
    return this.maxRetransmits === 0;
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('datachannel is not open');
    const world = this.pc.world;
    const peerPc = this.pc.peer();
    if (!peerPc) return;
    const peerCh = peerPc.channels.get(this.id);
    if (!peerCh) return;
    world.sent++;
    // Copy: the caller owns its buffer and may reuse it the next frame.
    const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice();
    if (this.unreliable && world.loss > 0 && world.rand.next() < world.loss) {
      world.dropped++;
      return;
    }
    world.later(world.latencyMs, () => {
      if (peerCh.readyState !== 'open') return;
      peerCh.onmessage?.({ data: copy.buffer });
    });
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class MockPeerConnection {
  constructor(world, cfg) {
    this.world = world;
    this.cfg = cfg;
    this.token = `t${world.nextToken++}`;
    world.pcs.set(this.token, this);

    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.peerToken = null;
    this.iceGen = 0;
    this.remoteCandidates = 0;
    this.channels = new Map();
    this.offersCreated = 0;
    this.closed = false;

    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onnegotiationneeded = null;
    this.ondatachannel = null;
  }

  peer() {
    return this.peerToken ? this.world.pcs.get(this.peerToken) ?? null : null;
  }

  createDataChannel(label, init = {}) {
    if (this.closed) throw new Error('peer connection is closed');
    if (init.id === undefined) throw new Error('test only supports negotiated channels');
    if (this.channels.has(init.id)) throw new Error(`duplicate datachannel id ${init.id}`);
    const ch = new MockDataChannel(this, label, init);
    this.channels.set(init.id, ch);
    // A real browser fires negotiationneeded when a channel is added. The
    // transport must survive that firing on top of its own explicit offer.
    this.world.later(0, () => {
      if (!this.closed) this.onnegotiationneeded?.();
    });
    return ch;
  }

  async createOffer(options) {
    if (this.closed) throw new Error('peer connection is closed');
    this.offersCreated++;
    if (options?.iceRestart) this.iceGen++;
    return { type: 'offer', sdp: this._sdp('offer') };
  }

  async createAnswer() {
    if (this.closed) throw new Error('peer connection is closed');
    return { type: 'answer', sdp: this._sdp('answer') };
  }

  _sdp(kind) {
    return `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\na=mock-kind:${kind}\r\na=mock-token:${this.token}\r\na=ice-ufrag:ufrag${this.iceGen}\r\n`;
  }

  async setLocalDescription(desc) {
    if (this.closed) throw new Error('peer connection is closed');
    if (desc.type === 'offer') {
      if (this.signalingState !== 'stable') {
        throw new Error(`cannot set local offer in ${this.signalingState}`);
      }
      this.signalingState = 'have-local-offer';
    } else {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(`cannot set local answer in ${this.signalingState}`);
      }
      this.signalingState = 'stable';
    }
    this.localDescription = { type: desc.type, sdp: desc.sdp };
    this._gatherIce();
    this._tryConnect();
  }

  async setRemoteDescription(desc) {
    if (this.closed) throw new Error('peer connection is closed');
    if (desc.type === 'offer') {
      // Re-offers (ICE restart) arrive in 'stable'; first offers do too.
      if (this.signalingState !== 'stable') {
        throw new Error(`cannot set remote offer in ${this.signalingState}`);
      }
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') {
        throw new Error(`cannot set remote answer in ${this.signalingState}`);
      }
      this.signalingState = 'stable';
    }
    this.remoteDescription = { type: desc.type, sdp: desc.sdp };
    const m = /a=mock-token:(\w+)/.exec(desc.sdp);
    if (!m) throw new Error('offer/answer carried no peer token — SDP was mangled in transit');
    this.peerToken = m[1];
    this._tryConnect();
    // Readiness is symmetric, so the peer may have been waiting on us.
    this.peer()?._tryConnect();
  }

  _gatherIce() {
    const gen = this.iceGen;
    for (let i = 0; i < 2; i++) {
      this.world.later(1 + i, () => {
        if (this.closed) return;
        this.world.candidatesEmitted++;
        this.onicecandidate?.({
          candidate: new MockIceCandidate(`candidate:${gen}-${i} 1 udp 2130706431 10.0.0.1 500${i} typ host`, gen),
        });
      });
    }
    this.world.later(3, () => {
      if (!this.closed) this.onicecandidate?.({ candidate: null });
    });
  }

  async addIceCandidate(c) {
    if (this.closed) throw new Error('peer connection is closed');
    if (!this.remoteDescription) {
      // This is the trickle race the transport is supposed to prevent by
      // queueing. If it ever reaches us the candidate is lost for good.
      this.world.candidatesRejected++;
      throw new Error('cannot add ICE candidate before the remote description');
    }
    this.world.candidatesAdded++;
    this.remoteCandidates++;
    this._tryConnect();
    this.peer()?._tryConnect();
  }

  describe() {
    return `${this.token}: sig=${this.signalingState} conn=${this.connectionState} local=${this.localDescription?.type ?? '-'} remote=${this.remoteDescription?.type ?? '-'} cands=${this.remoteCandidates} peer=${this.peerToken ?? '-'} chans=${this.channels.size}`;
  }

  _ready() {
    return (
      !this.closed &&
      this.localDescription !== null &&
      this.remoteDescription !== null &&
      this.signalingState === 'stable' &&
      this.remoteCandidates > 0
    );
  }

  _tryConnect() {
    const peer = this.peer();
    if (!peer || !this._ready() || !peer._ready()) return;
    this._establish();
    peer._establish();
    // Open channels only once both ends are up, and only where ids agree —
    // which is what `negotiated: true` with a shared id is buying us.
    for (const [id, ch] of this.channels) {
      const other = peer.channels.get(id);
      if (!other) continue;
      for (const c of [ch, other]) {
        if (c.readyState !== 'connecting') continue;
        c.readyState = 'open';
        this.world.later(0, () => c.onopen?.());
      }
    }
  }

  _establish() {
    if (this.connectionState === 'connected' || this.closed) return;
    this.iceConnectionState = 'connected';
    this.oniceconnectionstatechange?.();
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }

  /** Force an ICE failure, the way a NAT rebinding or a dead path would. */
  failIce() {
    this.iceConnectionState = 'failed';
    this.oniceconnectionstatechange?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.signalingState = 'closed';
    this.connectionState = 'closed';
    for (const ch of this.channels.values()) ch.readyState = 'closed';
    this.world.pcs.delete(this.token);
  }
}

/* ------------------------------------------------ 1. negotiation over memory */

group('negotiation: a host and a guest complete offer/answer');

const world1 = new MockWorld({ seed: 'negotiate', latencyMs: 10 });
const hub1 = new MemorySignalingHub();

const host1 = new WebRtcHost({
  signaling: hub1.create('host', 'ROOM01', 'the-host'),
  peerConnectionFactory: world1.factory,
  pingIntervalMs: 40,
});
let hostSide = null;
host1.onConnection((t) => {
  hostSide = t;
});
await host1.start();

let guest1;
try {
  guest1 = await joinAsGuest({
    signaling: hub1.create('guest', 'ROOM01', 'the-guest'),
    peerConnectionFactory: world1.factory,
    pingIntervalMs: 40,
    joinTimeoutMs: 4000,
  });
} catch (err) {
  console.log(`\nJOIN FAILED: ${err?.message ?? err}`);
  for (const pc of world1.pcs.values()) console.log(`  ${pc.describe()}`);
  console.log(`  candidates emitted=${world1.candidatesEmitted} added=${world1.candidatesAdded} rejected=${world1.candidatesRejected}`);
  process.exit(1);
}

await until(() => hostSide !== null && guest1.state === 'connected', [host1, guest1]);

check('the guest reaches connected', guest1.state === 'connected', `state=${guest1.state}`);
check('the host is handed a transport for that guest', hostSide !== null);
check(
  'both ends agree who they are talking to',
  hostSide !== null && hostSide.remoteId === guest1.localId && guest1.remoteId === hostSide.localId,
  `host ${hostSide?.localId}→${hostSide?.remoteId}, guest ${guest1.localId}→${guest1.remoteId}`,
);
check('the host counts exactly one connection', host1.connections.length === 1);
check(
  'no ICE candidate was dropped by the trickle race',
  world1.candidatesRejected === 0 && world1.candidatesAdded > 0,
  `${world1.candidatesAdded} added, ${world1.candidatesRejected} rejected`,
);

// The brief's literal wire requirement.
const guestPc = [...world1.pcs.values()].find((pc) => pc.channels.size > 0);
const chans = guestPc ? [...guestPc.channels.values()] : [];
const control = chans.find((c) => c.label === CH_CONTROL);
const state = chans.find((c) => c.label === CH_STATE);
check(
  'the control channel is reliable-ordered',
  !!control && control.ordered === true && control.maxRetransmits === undefined,
  control ? `ordered=${control.ordered} maxRetransmits=${control.maxRetransmits}` : 'missing',
);
check(
  'the state channel is unreliable with maxRetransmits: 0',
  !!state && state.ordered === false && state.maxRetransmits === 0,
  state ? `ordered=${state.ordered} maxRetransmits=${state.maxRetransmits}` : 'missing',
);
check(
  'every channel is negotiated with an explicit id',
  chans.length > 0 && chans.every((c) => c.negotiated === true && Number.isInteger(c.id)),
  `ids ${chans.map((c) => `${c.label}=${c.id}`).join(' ')}`,
);
{
  const pcs = [...world1.pcs.values()].filter((pc) => pc.channels.size > 0);
  const idSets = pcs.map((pc) => [...pc.channels.keys()].sort((a, b) => a - b).join(','));
  check(
    'both peers picked the same ids with no ondatachannel handshake',
    idSets.length === 2 && idSets[0] === idSets[1],
    idSets.join(' | '),
  );
}
check(
  'the redundant negotiationneeded did not produce a second offer',
  [...world1.pcs.values()].every((pc) => pc.offersCreated <= 1),
  `offers created ${[...world1.pcs.values()].map((pc) => pc.offersCreated).join(',')}`,
);

/* ------------------------------------------------------------ 2. data flows */

group('data: both channels carry traffic once the session is up');

const enc = new TextEncoder();
const dec = new TextDecoder();
const gotOnHost = [];
const gotOnGuest = [];
hostSide.onMessage((m) => gotOnHost.push([m.channel, dec.decode(m.bytes)]));
guest1.onMessage((m) => gotOnGuest.push([m.channel, dec.decode(m.bytes)]));

for (let i = 0; i < 50; i++) {
  guest1.send(CH_CONTROL, enc.encode(`g-control-${i}`));
  guest1.send(CH_STATE, enc.encode(`g-state-${i}`));
  hostSide.send(CH_CONTROL, enc.encode(`h-control-${i}`));
}
await until(
  () => gotOnHost.filter((m) => m[0] === CH_CONTROL).length >= 50 && gotOnGuest.length >= 50,
  [host1, guest1],
);

const hostControl = gotOnHost.filter((m) => m[0] === CH_CONTROL).map((m) => m[1]);
const hostState = gotOnHost.filter((m) => m[0] === CH_STATE).map((m) => m[1]);
check(
  'guest → host reliable-ordered arrives complete and in order',
  hostControl.length === 50 && hostControl.every((v, i) => v === `g-control-${i}`),
  `${hostControl.length}/50`,
);
check(
  'guest → host unreliable arrives on a clean link',
  hostState.length === 50 && hostState.every((v, i) => v === `g-state-${i}`),
  `${hostState.length}/50`,
);
check(
  'host → guest reliable-ordered arrives complete and in order',
  gotOnGuest.length === 50 && gotOnGuest.every((m, i) => m[1] === `h-control-${i}`),
  `${gotOnGuest.length}/50`,
);
check(
  'traffic went over the mock wire, not a shortcut',
  world1.sent >= 150,
  `${world1.sent} datachannel sends`,
);

await until(() => guest1.stats.rttMs > 0 && hostSide.stats.rttMs > 0, [host1, guest1], 2000);
check(
  'RTT is measured across the DataChannel keepalive',
  guest1.stats.rttMs > 0 && guest1.stats.rttMs < 200,
  `guest rtt=${guest1.stats.rttMs.toFixed(1)}ms host rtt=${hostSide.stats.rttMs.toFixed(1)}ms`,
);
check(
  'byte counters moved in both directions',
  guest1.stats.bytesOut > 0 && guest1.stats.bytesIn > 0,
  `out=${guest1.stats.bytesOut}B in=${guest1.stats.bytesIn}B`,
);

/* ------------------------------------------- 3. unreliable really is unreliable */

group('unreliable: maxRetransmits 0 loses packets, reliable does not');

const world3 = new MockWorld({ seed: 'lossy', latencyMs: 5, loss: 0.15 });
const hub3 = new MemorySignalingHub();
const host3 = new WebRtcHost({
  signaling: hub3.create('host', 'ROOM03'),
  peerConnectionFactory: world3.factory,
  pingIntervalMs: 1000,
});
let hostSide3 = null;
host3.onConnection((t) => {
  hostSide3 = t;
});
await host3.start();
const guest3 = await joinAsGuest({
  signaling: hub3.create('guest', 'ROOM03'),
  peerConnectionFactory: world3.factory,
  pingIntervalMs: 1000,
  joinTimeoutMs: 4000,
});
await until(() => hostSide3 !== null && guest3.state === 'connected', [host3, guest3]);

const relIn = [];
const unrelIn = [];
hostSide3.onMessage((m) => (m.channel === CH_CONTROL ? relIn : unrelIn).push(dec.decode(m.bytes)));
const N = 400;
for (let i = 0; i < N; i++) {
  guest3.send(CH_CONTROL, enc.encode(`r${i}`));
  guest3.send(CH_STATE, enc.encode(`u${i}`));
}
await until(() => relIn.length >= N, [host3, guest3]);
await sleep(60);
host3.poll(performance.now());

check(
  'reliable-ordered lost nothing at 15% link loss',
  relIn.length === N && relIn.every((v, i) => v === `r${i}`),
  `${relIn.length}/${N} in order`,
);
const lostFrac = (N - unrelIn.length) / N;
check(
  'unreliable lost roughly the configured 15%',
  lostFrac > 0.08 && lostFrac < 0.24,
  `${N - unrelIn.length}/${N} = ${(lostFrac * 100).toFixed(1)}% lost`,
);
check(
  'what survived on the unreliable channel is still strictly increasing',
  unrelIn.every((v, i) => (i === 0 ? true : Number(v.slice(1)) > Number(unrelIn[i - 1].slice(1)))),
  `${unrelIn.length} delivered, no reordering leaked to the app`,
);

/* --------------------------------------------------------- 4. ICE restart */

group('ICE: the offerer retries once, then gives up');

const world4 = new MockWorld({ seed: 'ice', latencyMs: 5 });
const hub4 = new MemorySignalingHub();
const host4 = new WebRtcHost({
  signaling: hub4.create('host', 'ROOM04'),
  peerConnectionFactory: world4.factory,
  pingIntervalMs: 1000,
});
let hostSide4 = null;
const hostGone = [];
host4.onConnection((t) => {
  hostSide4 = t;
});
host4.onDisconnection((t, reason) => hostGone.push(reason));
await host4.start();
const guest4 = await joinAsGuest({
  signaling: hub4.create('guest', 'ROOM04'),
  peerConnectionFactory: world4.factory,
  pingIntervalMs: 1000,
  joinTimeoutMs: 4000,
});
await until(() => hostSide4 !== null && guest4.state === 'connected', [host4, guest4]);

const hostPc = [...world4.pcs.values()].find((pc) => pc.localDescription?.type === 'offer');
const offersBefore = hostPc.offersCreated;
hostPc.failIce();
await until(() => hostPc.offersCreated > offersBefore, [host4, guest4], 1000);
check(
  'an ICE failure on the offerer triggers exactly one restart offer',
  hostPc.offersCreated === offersBefore + 1,
  `offers ${offersBefore} → ${hostPc.offersCreated}`,
);
check('the restart bumped the ICE generation', hostPc.iceGen >= 1, `iceGen=${hostPc.iceGen}`);

hostPc.failIce();
await until(() => hostSide4.state === 'failed', [host4, guest4], 1000);
check(
  'a second ICE failure fails the transport instead of looping',
  hostSide4.state === 'failed',
  `state=${hostSide4.state}`,
);
check(
  'the host is told the player dropped',
  hostGone.length === 1 && /ICE/i.test(hostGone[0]),
  hostGone.join(','),
);
check('a failed transport is off the roster', host4.connections.length === 0);

/* ---------------------------------------------------------- 5. disconnect */

group('disconnect: a quit reaches the other side with its reason');

const world5 = new MockWorld({ seed: 'bye', latencyMs: 5 });
const hub5 = new MemorySignalingHub();
const host5 = new WebRtcHost({
  signaling: hub5.create('host', 'ROOM05'),
  peerConnectionFactory: world5.factory,
  pingIntervalMs: 1000,
});
let hostSide5 = null;
const gone5 = [];
host5.onConnection((t) => {
  hostSide5 = t;
});
host5.onDisconnection((t, reason) => gone5.push(reason));
await host5.start();
const guest5 = await joinAsGuest({
  signaling: hub5.create('guest', 'ROOM05'),
  peerConnectionFactory: world5.factory,
  pingIntervalMs: 1000,
  joinTimeoutMs: 4000,
});
await until(() => hostSide5 !== null && guest5.state === 'connected', [host5, guest5]);

guest5.close('player quit');
await until(() => hostSide5.state !== 'connected', [host5, guest5], 2000);
check(
  'the host sees the guest leave, with the reason',
  gone5.length === 1 && /player quit/.test(gone5[0]),
  gone5.join(','),
);
check('the guest transport is closed', guest5.state === 'closed', `state=${guest5.state}`);
check('sending after close is refused, not thrown', guest5.send(CH_CONTROL, enc.encode('x')) === false);
check('the roster is empty again', host5.connections.length === 0);
check(
  'closing tore down the underlying peer connections',
  [...world5.pcs.values()].length === 0,
  `${world5.pcs.size} peer connections left open`,
);

/* -------------------------------------- 6. guest arrives before the host */

group('join order: a guest that arrives first still learns the host id');

const world6 = new MockWorld({ seed: 'early', latencyMs: 5 });
const hub6 = new MemorySignalingHub();

// Guest first: the roster it is handed is empty, so there is no host peer id yet.
const guest6Promise = joinAsGuest({
  signaling: hub6.create('guest', 'ROOM06'),
  peerConnectionFactory: world6.factory,
  pingIntervalMs: 1000,
  joinTimeoutMs: 4000,
});
await sleep(20);
const host6 = new WebRtcHost({
  signaling: hub6.create('host', 'ROOM06'),
  peerConnectionFactory: world6.factory,
  pingIntervalMs: 1000,
});
let hostSide6 = null;
host6.onConnection((t) => {
  hostSide6 = t;
});
await host6.start();

let guest6 = null;
const settled = guest6Promise.then((t) => (guest6 = t)).catch(() => null);
await until(() => guest6 !== null && hostSide6 !== null, [host6], 4000);
await settled;
await until(() => guest6 !== null && guest6.state === 'connected', [host6, guest6], 2000);

check('the late host still gets a connection', hostSide6 !== null);
check('the early guest still connects', guest6 !== null && guest6.state === 'connected',
  `state=${guest6?.state}`);
check(
  'the guest adopted the real host peer id instead of the "host" placeholder',
  guest6 !== null && guest6.remoteId === hostSide6?.localId && guest6.remoteId !== 'host',
  `remoteId=${guest6?.remoteId} hostId=${hostSide6?.localId}`,
);

host1.stop('done');
host3.stop('done');
host4.stop('done');
host5.stop('done');
host6.stop('done');
for (const w of [world1, world3, world4, world5, world6]) w.cleanup();

/* ------------------------------- 7. through the real signalling server */

group('end to end: negotiate through the real tools/signal.mjs over TCP');

const PORT = 8791 + (process.pid % 200);
const server = spawn(process.execPath, [join(HERE, 'signal.mjs'), '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (b) => (serverLog += b.toString()));
server.stderr.on('data', (b) => (serverLog += b.toString()));

const up = await (async () => {
  for (let i = 0; i < 100; i++) {
    if (/listening|8[0-9]{3}/i.test(serverLog)) return true;
    await sleep(50);
  }
  return false;
})();
check('the signalling server came up', up, serverLog.trim().split('\n')[0] ?? '(no output)');

const world7 = new MockWorld({ seed: 'e2e', latencyMs: 5 });
const url = `ws://127.0.0.1:${PORT}`;
const wsFactory = (u) => new globalThis.WebSocket(u);

let e2eOk = false;
let roomCode = '';
let host7 = null;
let guest7 = null;
try {
  const hostSignal = new WebSocketSignaling({ url, role: 'host', name: 'e2e-host', webSocketFactory: wsFactory });
  host7 = new WebRtcHost({
    signaling: hostSignal,
    peerConnectionFactory: world7.factory,
    pingIntervalMs: 200,
  });
  let hostSide7 = null;
  host7.onConnection((t) => {
    hostSide7 = t;
  });
  await host7.start();
  roomCode = host7.room;
  check(
    'the host was handed a short, speakable room code',
    /^[23456789BCDFGHJKLMNPQRSTVWXYZ]{4,8}$/.test(roomCode),
    roomCode,
  );

  const guestSignal = new WebSocketSignaling({
    url,
    room: roomCode,
    role: 'guest',
    name: 'e2e-guest',
    webSocketFactory: wsFactory,
  });
  guest7 = await joinAsGuest({
    signaling: guestSignal,
    peerConnectionFactory: world7.factory,
    pingIntervalMs: 200,
    joinTimeoutMs: 8000,
  });
  await until(() => hostSide7 !== null && guest7.state === 'connected', [host7, guest7], 8000);

  check(
    'SDP survived the hand-rolled RFC 6455 framing intact',
    guest7.state === 'connected' && hostSide7 !== null,
    `guest=${guest7.state} host connections=${host7.connections.length}`,
  );

  const e2eGot = [];
  hostSide7?.onMessage((m) => e2eGot.push(dec.decode(m.bytes)));
  // A payload big enough to cross the 126-byte framing boundary in signal.mjs
  // was already exercised by the SDP; this proves game traffic then bypasses it.
  for (let i = 0; i < 20; i++) guest7.send(CH_CONTROL, enc.encode(`e2e-${i}`));
  await until(() => e2eGot.length >= 20, [host7, guest7], 3000);
  check(
    'game traffic then flows peer-to-peer, not through the server',
    e2eGot.length === 20 && e2eGot.every((v, i) => v === `e2e-${i}`),
    `${e2eGot.length}/20`,
  );
  e2eOk = true;
} catch (err) {
  check('end-to-end session over the real server', false, String(err?.message ?? err));
} finally {
  try {
    guest7?.close('done');
  } catch {}
  try {
    host7?.stop('done');
  } catch {}
  world7.cleanup();
  await sleep(80);
  server.kill('SIGTERM');
}

/* ------------------------------------------------------------------ report */

console.log('');
if (failures.length === 0) {
  console.log(`ALL PASS  ${passed}/${passed} checks`);
} else {
  console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks`);
  for (const f of failures) console.log(`  - ${f}`);
}
await sleep(20);
process.exit(failures.length === 0 ? 0 : 1);
