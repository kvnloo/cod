#!/usr/bin/env node
/**
 * Headless verification for src/net/interp.
 *
 * Netcode cannot be verified from a screenshot. This drives the real modules
 * against a synthetic but adversarial link — asymmetric latency, one-sided
 * jitter, packet loss, reordering, duplicates, a full 1.5 s stall, a 47 m
 * teleport and a host clock offset of half an hour — and asserts hard numeric
 * properties:
 *
 *   1. Clock offset error settles within a stated bound of truth.
 *   2. Render time never moves backwards.
 *   3. The interpolated path stays within a stated distance of the true path.
 *   4. A teleport snaps rather than gliding across the map.
 *   5. A stalled link freezes the entity inside the extrapolation cap and does
 *      NOT keep sliding.
 *   6. No NaN escapes and the ring stays bounded.
 *
 * Everything is seeded from src/core/Rand.ts — no Math.random anywhere, so any
 * failure reproduces exactly.
 *
 *   node tools/net-interp.mjs [--seed 1337]
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Node 22.6+ strips TypeScript types but does not rewrite import specifiers.
// The project uses bundler-style extensionless imports, so add the extension
// back on resolve. This is the whole "build step".
// ---------------------------------------------------------------------------
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) &&
        !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const base = context.parentURL
        ? path.dirname(fileURLToPath(context.parentURL))
        : process.cwd();
      const abs = path.resolve(base, specifier);
      for (const cand of [`${abs}.ts`, path.join(abs, 'index.ts')]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = pathToFileURL(path.join(ROOT, 'src')).href;

const { Rand } = await import(`${SRC}/core/Rand.ts`);
const { NetClock, ClockSyncDriver, LocalTimeSource } = await import(`${SRC}/net/interp/Clock.ts`);
const { Interpolator } = await import(`${SRC}/net/interp/Interpolator.ts`);
const { SnapshotBuffer } = await import(`${SRC}/net/interp/SnapshotBuffer.ts`);
const { extrapolate, DEFAULT_EXTRAPOLATION, makeExtrapolationResult, ErrorSmoother } =
  await import(`${SRC}/net/interp/Extrapolate.ts`);
const { slerpQuat, quatAngle, distance } = await import(`${SRC}/net/interp/math.ts`);

// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const SEED = Number(flag('seed', 1337));

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name}${detail ? `  ${detail}` : ''}`);
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

// ---------------------------------------------------------------------------
// Link model: asymmetric one-way delays, one-sided jitter, loss, duplication.
// ---------------------------------------------------------------------------
class Link {
  constructor(rand, { upMs, downMs, jitterMs, loss, dupChance = 0 }) {
    this.rand = rand;
    this.upMs = upMs; this.downMs = downMs;
    this.jitterMs = jitterMs; this.loss = loss; this.dupChance = dupChance;
    this.queue = [];
    this.sentDown = 0; this.lostDown = 0; this.dupDown = 0;
  }
  /** dir: 'down' = host->client, 'up' = client->host. */
  send(dir, atMs, payload, lossy = true) {
    if (dir === 'down') this.sentDown++;
    if (lossy && this.rand.next() < this.loss) { if (dir === 'down') this.lostDown++; return; }
    const base = dir === 'down' ? this.downMs : this.upMs;
    // Queueing delay is strictly additive and one-sided. That is precisely why
    // averaging clock samples is wrong and minimum-RTT filtering is right.
    const jitter = this.rand.next() ** 2 * this.jitterMs;
    this.queue.push({ at: atMs + base + jitter, payload, dir });
    if (dir === 'down' && this.rand.next() < this.dupChance) {
      this.dupDown++;
      this.queue.push({ at: atMs + base + jitter + 3, payload, dir });
    }
  }
  /** Everything due at or before nowMs, in ARRIVAL order (so reordering shows). */
  drain(nowMs) {
    const out = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].at <= nowMs) { out.push(this.queue[i]); this.queue.splice(i, 1); }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Ground truth: a player circle-strafing with varying speed, plus a teleport.
// Analytic and continuous, so "the true path" is exact at any query time.
// ---------------------------------------------------------------------------
const TELEPORT_AT_MS = 6000;
const TELEPORT_SHIFT = { x: 40, y: 0, z: -25 };

function truthAt(tMs) {
  const t = tMs * 0.001;
  const r = 4 + 1.5 * Math.sin(t * 0.37);
  const a = t * 0.8 + 0.3 * Math.sin(t * 0.9);
  const p = { x: r * Math.cos(a), y: 1.7 + 0.25 * Math.sin(t * 2.3), z: r * Math.sin(a) };
  const dr = 1.5 * 0.37 * Math.cos(t * 0.37);
  const da = 0.8 + 0.3 * 0.9 * Math.cos(t * 0.9);
  const v = {
    x: dr * Math.cos(a) - r * Math.sin(a) * da,
    y: 0.25 * 2.3 * Math.cos(t * 2.3),
    z: dr * Math.sin(a) + r * Math.cos(a) * da,
  };
  const gen = tMs >= TELEPORT_AT_MS ? 1 : 0;
  if (gen) { p.x += TELEPORT_SHIFT.x; p.y += TELEPORT_SHIFT.y; p.z += TELEPORT_SHIFT.z; }
  const yaw = Math.atan2(v.x, v.z);
  const rot = { x: 0, y: Math.sin(yaw * 0.5), z: 0, w: Math.cos(yaw * 0.5) };
  return { position: p, velocity: v, rotation: rot, teleport: gen };
}

/** The same path forced onto one side of the teleport, for the "did it glide?" test. */
function truthBranch(tMs, gen) {
  const s = truthAt(tMs);
  const want = gen ? 1 : 0;
  if (s.teleport === want) return s.position;
  const sign = want ? 1 : -1;
  return {
    x: s.position.x + sign * TELEPORT_SHIFT.x,
    y: s.position.y + sign * TELEPORT_SHIFT.y,
    z: s.position.z + sign * TELEPORT_SHIFT.z,
  };
}

function peakTruthSpeed() {
  let m = 0;
  for (let t = 0; t < 12000; t += 2) {
    const v = truthAt(t).velocity;
    m = Math.max(m, Math.hypot(v.x, v.y, v.z));
  }
  return m;
}

// ---------------------------------------------------------------------------
// 1 — clock synchronisation on an ASYMMETRIC link
// ---------------------------------------------------------------------------
function testClockAsymmetric() {
  section('1. Clock sync, asymmetric link (min one-way-delay / Marzullo filter)');
  const rand = new Rand(SEED ^ 0x51c0);
  const TRUE_OFFSET = 1_834_562.5;      // host clock is ~30 min ahead
  // 40 ms up / 20 ms down: the symmetry assumption is violated by 20 ms, which
  // puts an irreducible 10 ms bias in any NTP-style estimate. Nothing can beat
  // that without a one-way-delay measurement, so 10 ms is the floor to beat.
  const link = new Link(rand, { upMs: 40, downMs: 20, jitterMs: 50, loss: 0.10 });
  const clock = new NetClock();
  const driver = new ClockSyncDriver(clock, 100, 250);

  let local = 0;
  const DT = 1000 / 144;
  let syncedAt = -1;
  const errs = [];
  let mono = true, lastSN = -Infinity;

  for (let step = 0; step < 144 * 30; step++) {
    local += DT;
    const ping = driver.poll(local);
    if (ping) link.send('up', local, { seq: ping.seq });
    for (const pkt of link.drain(local)) {
      if (pkt.dir === 'up') {
        const serverRecv = pkt.at + TRUE_OFFSET;
        // The host holds the reply until its next 60 Hz tick: t1 !== t2 on
        // purpose, which is exactly what the 4-timestamp form exists to remove.
        const serverSend = serverRecv + (16.67 - (serverRecv % 16.67));
        link.send('down', serverSend - TRUE_OFFSET,
          { seq: pkt.payload.seq, t1: serverRecv, t2: serverSend });
      } else {
        driver.accept(pkt.payload.seq, pkt.payload.t1, pkt.payload.t2, pkt.at);
      }
    }
    clock.update(local);
    const sn = clock.serverNowMs();
    if (sn < lastSN) mono = false;
    lastSN = sn;
    if (clock.synced && syncedAt < 0) syncedAt = local;
    if (clock.synced) errs.push(Math.abs(clock.offsetMs - TRUE_OFFSET));
  }

  const settled = errs.slice(Math.floor(errs.length * 0.5));
  const maxSettled = Math.max(...settled);
  const meanSettled = settled.reduce((a, b) => a + b, 0) / settled.length;

  check('locks within 1.0 s of the first ping', syncedAt >= 0 && syncedAt < 1000,
    `synced at ${syncedAt.toFixed(0)} ms`);
  // The estimator cannot beat asymmetry/2 = 10 ms. Anything under 11 ms means
  // the jitter has been filtered out entirely and only the bias remains.
  check('offset error converges to the asymmetry floor (10 ms), not above it',
    maxSettled <= 11,
    `max ${maxSettled.toFixed(2)} ms, mean ${meanSettled.toFixed(2)} ms ` +
    `(irreducible asymmetry bias = 10.00 ms)`);
  check('reported uncertainty bounds the true error', clock.uncertaintyMs >= maxSettled,
    `uncertainty ${clock.uncertaintyMs.toFixed(2)} ms >= error ${maxSettled.toFixed(2)} ms`);
  check('the interval half-width is a real bound, and tighter than rtt/2',
    clock.intervalHalfWidthMs >= maxSettled && clock.intervalHalfWidthMs <= clock.rttMs * 0.5 + 1e-9,
    `half-width ${clock.intervalHalfWidthMs.toFixed(2)} ms, rtt/2 ${(clock.rttMs / 2).toFixed(2)} ms`);
  check('minimum RTT recovered (~60 ms)', Math.abs(clock.rttMs - 60) < 8,
    `rttMin ${clock.rttMs.toFixed(2)} ms, smoothed ${clock.smoothedRttMs.toFixed(2)} ms`);
  check('serverNowMs() monotonic over 4320 frames', mono);
  check('no epoch change during normal sync', clock.epoch === 0, `epoch ${clock.epoch}`);
  check('samples were accepted and outliers gated', clock.acceptedCount > 10,
    `accepted ${clock.acceptedCount}, rejected ${clock.rejectedCount}`);
}

// ---------------------------------------------------------------------------
// 2 — accuracy floor on a symmetric link
// ---------------------------------------------------------------------------
function testClockSymmetric() {
  section('2. Clock sync, symmetric link (accuracy floor)');
  const rand = new Rand(SEED ^ 0xbeef);
  const TRUE_OFFSET = -98_765.25;
  const link = new Link(rand, { upMs: 30, downMs: 30, jitterMs: 60, loss: 0.10 });
  const clock = new NetClock();
  const driver = new ClockSyncDriver(clock, 100, 250);
  let local = 0;
  const DT = 1000 / 144;
  const errs = [];
  for (let step = 0; step < 144 * 30; step++) {
    local += DT;
    const ping = driver.poll(local);
    if (ping) link.send('up', local, { seq: ping.seq });
    for (const pkt of link.drain(local)) {
      if (pkt.dir === 'up') {
        const sr = pkt.at + TRUE_OFFSET;
        link.send('down', pkt.at, { seq: pkt.payload.seq, t1: sr, t2: sr });
      } else {
        driver.accept(pkt.payload.seq, pkt.payload.t1, pkt.payload.t2, pkt.at);
      }
    }
    clock.update(local);
    if (clock.synced) errs.push(Math.abs(clock.offsetMs - TRUE_OFFSET));
  }
  const settled = errs.slice(Math.floor(errs.length * 0.5));
  const maxSettled = Math.max(...settled);
  // Symmetric link => no irreducible bias, so the only error left is how close
  // the per-leg minima got to the true one-way delay. Sub-millisecond.
  check('symmetric-link offset error <= 1 ms', maxSettled <= 1,
    `max ${maxSettled.toFixed(3)} ms over ${settled.length} frames`);
  check('symmetric-link uncertainty is honest (>= error, <= rtt/2)',
    clock.uncertaintyMs >= maxSettled && clock.intervalHalfWidthMs <= clock.rttMs * 0.5 + 1e-9,
    `uncertainty ${clock.uncertaintyMs.toFixed(2)} ms, half-width ` +
    `${clock.intervalHalfWidthMs.toFixed(2)} ms, rtt/2 ${(clock.rttMs / 2).toFixed(2)} ms`);

  // Host-side identity clock.
  let t = 0;
  const host = new LocalTimeSource(() => t);
  t = 100; const a = host.serverNowMs();
  t = 50;  const b = host.serverNowMs();
  check('LocalTimeSource (host) is identity and monotonic', a === 100 && b === 100);
}

// ---------------------------------------------------------------------------
// 3 — interpolation fidelity against the true path
// ---------------------------------------------------------------------------
function runInterpolation(cfg) {
  const {
    tickHz, loss, jitterMs, upMs, downMs, dupChance = 0,
    stallFromMs, stallToMs, durationMs, snapshotVelocity, useTeleportCounter,
  } = cfg;
  const rand = new Rand(SEED ^ 0x9a71);
  const link = new Link(rand, { upMs, downMs, jitterMs, loss, dupChance });
  const TRUE_OFFSET = 987_654.5;

  const clock = new NetClock();
  const driver = new ClockSyncDriver(clock, 80, 500);
  const interp = new Interpolator();
  interp.attachTimeSource(clock);

  const tickMs = 1000 / tickHz;
  const frameRand = new Rand(SEED ^ 0x4a4a);
  let local = 0;

  // --- warm the clock up on a clean channel so the fidelity measurement is
  //     isolated from clock error (see note below on why it cancels anyway).
  for (let i = 0; i < 80; i++) {
    local += 1000 / 144;
    const ping = driver.poll(local);
    if (ping) link.send('up', local, { seq: ping.seq }, false);
    for (const pkt of link.drain(local)) {
      if (pkt.dir === 'up') {
        const sr = pkt.at + TRUE_OFFSET;
        link.send('down', pkt.at, { seq: pkt.payload.seq, t1: sr, t2: sr }, false);
      } else if (pkt.payload.t1 !== undefined) {
        driver.accept(pkt.payload.seq, pkt.payload.t1, pkt.payload.t2, pkt.at);
      }
    }
    clock.update(local);
  }
  const EPOCH_LOCAL = local;
  const toServer = (simMs) => EPOCH_LOCAL + simMs + TRUE_OFFSET;
  const toSim = (serverMs) => serverMs - TRUE_OFFSET - EPOCH_LOCAL;

  let nextTickAt = 0;
  let tick = 0;

  let lastRenderTime = -Infinity;
  let renderBackwards = 0, maxRenderStepBack = 0;
  let renderStalledFrames = 0;
  let samples = 0;
  const errsInterp = [];
  let maxErrInterp = 0, maxErrAll = 0, maxRotErrDeg = 0;
  let snapFrames = 0, nanSeen = false;
  let lastKnownPos = null, maxStallDrift = 0, framesDuringStall = 0;
  let teleportSnapAtSimMs = -1;
  let maxGlideDuringTeleport = 0;
  let sawEntity = false, dropoutFrames = 0;

  while (local - EPOCH_LOCAL < durationMs) {
    local += 1000 / (90 + frameRand.next() * 90);   // 90-180 Hz, variable
    const simMs = local - EPOCH_LOCAL;

    // ---- host: emit a snapshot every tick -------------------------------
    while (simMs >= nextTickAt) {
      const stalled = stallFromMs !== undefined &&
        nextTickAt >= stallFromMs && nextTickAt < stallToMs;
      if (!stalled) {
        const s = truthAt(nextTickAt);
        const ent = { id: 7, position: { ...s.position }, rotation: { ...s.rotation } };
        if (snapshotVelocity) ent.velocity = { ...s.velocity };
        if (useTeleportCounter) ent.teleport = s.teleport;
        link.send('down', local, {
          snapshot: { tick, serverTimeMs: toServer(nextTickAt), entities: [ent] },
        });
      }
      tick++;
      nextTickAt += tickMs;
    }

    const ping = driver.poll(local);
    if (ping) link.send('up', local, { seq: ping.seq }, false);

    for (const pkt of link.drain(local)) {
      if (pkt.dir === 'up') {
        const sr = pkt.at + TRUE_OFFSET;
        link.send('down', pkt.at, { seq: pkt.payload.seq, t1: sr, t2: sr }, false);
      } else if (pkt.payload.snapshot) {
        // Stamp arrival on the same clock the interpolator renders with.
        interp.push(pkt.payload.snapshot, clock.toServerMs(pkt.at));
      } else {
        driver.accept(pkt.payload.seq, pkt.payload.t1, pkt.payload.t2, pkt.at);
      }
    }

    clock.update(local);
    interp.update(clock.serverNowMs());

    // ---- measure ---------------------------------------------------------
    const rt = interp.renderTimeMs;
    if (rt < lastRenderTime) {
      renderBackwards++;
      maxRenderStepBack = Math.max(maxRenderStepBack, lastRenderTime - rt);
    } else if (rt === lastRenderTime) {
      renderStalledFrames++;
    }
    lastRenderTime = rt;

    const t = interp.get(7);
    if (!t) { if (sawEntity) dropoutFrames++; continue; }
    sawEntity = true;
    if (!Number.isFinite(t.position.x + t.position.y + t.position.z +
                         t.rotation.x + t.rotation.w + t.velocity.x)) nanSeen = true;

    // The interpolator renders server time `rt`; truth is queried at exactly
    // the same instant, so any residual clock error cancels out of this
    // measurement and what is left is purely interpolation quality.
    const truthMs = toSim(rt);
    if (t.snapped) {
      snapFrames++;
      if (truthMs > TELEPORT_AT_MS - 500 && teleportSnapAtSimMs < 0) teleportSnapAtSimMs = truthMs;
    }
    if (truthMs < 0) continue;
    const truth = truthAt(truthMs);
    const err = distance(t.position, truth.position);
    samples++;
    maxErrAll = Math.max(maxErrAll, err);

    // A nearest-neighbour hold across a teleport is *correct*, so in the window
    // where truth itself is discontinuous the requirement is different: the
    // rendered position must sit on ONE of the two branches, never somewhere in
    // the 47 m between them.
    const nearTeleport = Math.abs(truthMs - TELEPORT_AT_MS) < 4 * tickMs;
    if (nearTeleport) {
      maxGlideDuringTeleport = Math.max(maxGlideDuringTeleport, Math.min(
        distance(t.position, truthBranch(truthMs, 0)),
        distance(t.position, truthBranch(truthMs, 1)),
      ));
    } else if (t.extrapolatedMs === 0) {
      errsInterp.push(err);
      maxErrInterp = Math.max(maxErrInterp, err);
      maxRotErrDeg = Math.max(maxRotErrDeg, quatAngle(t.rotation, truth.rotation) * 180 / Math.PI);
    }

    // stall behaviour
    if (stallFromMs !== undefined) {
      if (simMs < stallFromMs) lastKnownPos = { ...t.position };
      else if (simMs < stallToMs && lastKnownPos) {
        framesDuringStall++;
        maxStallDrift = Math.max(maxStallDrift, distance(t.position, lastKnownPos));
      }
    }
  }

  const mean = errsInterp.reduce((a, b) => a + b, 0) / Math.max(1, errsInterp.length);
  const sorted = [...errsInterp].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;

  return {
    label: cfg.label, samples, maxErrInterp, maxErrAll, mean, p99, maxRotErrDeg,
    renderBackwards, maxRenderStepBack, renderStalledFrames, snapFrames, nanSeen,
    stats: interp.stats, buffer: interp.buffer, delayMs: interp.delayMs,
    jitterPeakMs: interp.buffer.jitterMs, intervalMs: interp.buffer.intervalMs,
    link, maxStallDrift, framesDuringStall, epoch: interp.epoch,
    teleportSnapAtSimMs, maxGlideDuringTeleport,
  };
}

// ---------------------------------------------------------------------------
// 4 — extrapolation caps in isolation
// ---------------------------------------------------------------------------
function testExtrapolationCaps() {
  section('4. Extrapolation caps (dead reckoning cannot run away)');
  const out = makeExtrapolationResult();
  const state = { id: 1, position: { x: 0, y: 0, z: 0 }, velocity: { x: 10, y: 0, z: 0 } };

  let worst = 0;
  for (let ahead = 0; ahead <= 10_000; ahead += 5) {
    extrapolate(state, ahead, DEFAULT_EXTRAPOLATION, out);
    worst = Math.max(worst, Math.hypot(out.position.x, out.position.y, out.position.z));
  }
  check('displacement never exceeds maxDistanceM, ever',
    worst <= DEFAULT_EXTRAPOLATION.maxDistanceM + 1e-9,
    `worst ${worst.toFixed(3)} m over a 10 s stall, cap ${DEFAULT_EXTRAPOLATION.maxDistanceM} m`);

  extrapolate(state, 10_000, DEFAULT_EXTRAPOLATION, out);
  check('freezes rather than sliding once past the time cap',
    out.stalled === true && Math.hypot(out.velocity.x, out.velocity.y, out.velocity.z) === 0,
    `appliedMs ${out.appliedMs.toFixed(0)} (cap ${DEFAULT_EXTRAPOLATION.maxAheadMs})`);

  const insane = { id: 1, position: { x: 0, y: 0, z: 0 }, velocity: { x: 5000, y: 0, z: 0 } };
  extrapolate(insane, 250, DEFAULT_EXTRAPOLATION, out);
  const d2 = Math.hypot(out.position.x, out.position.y, out.position.z);
  check('a corrupt velocity is speed-clamped before integration',
    d2 <= DEFAULT_EXTRAPOLATION.maxDistanceM + 1e-9,
    `moved ${d2.toFixed(3)} m given a 5000 m/s velocity`);

  let prev = -1, mono = true, jumpMax = 0, last = 0;
  for (let ahead = 0; ahead <= 400; ahead += 1) {
    extrapolate(state, ahead, DEFAULT_EXTRAPOLATION, out);
    const d = out.position.x;
    if (d < prev - 1e-9) mono = false;
    if (ahead > 0) jumpMax = Math.max(jumpMax, Math.abs(d - last));
    last = d; prev = d;
  }
  check('displacement is monotonic and continuous in time', mono && jumpMax < 0.02,
    `max step per ms ${jumpMax.toFixed(5)} m`);

  extrapolate({ id: 1, position: { x: 3, y: 2, z: 1 } }, 200, DEFAULT_EXTRAPOLATION, out);
  check('no velocity replicated => hold position, do not guess',
    out.position.x === 3 && out.position.y === 2 && out.position.z === 1);

  const sm = new ErrorSmoother();
  const okSmall = sm.capture({ x: 0.4, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  const mag0 = sm.magnitudeM;
  const o = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 100; i++) sm.apply({ x: 0, y: 0, z: 0 }, 10, o);
  check('ErrorSmoother bleeds a 0.40 m error to zero within 1 s',
    okSmall && mag0 > 0.39 && sm.magnitudeM === 0 && Math.hypot(o.x, o.y, o.z) < 1e-6,
    `start ${mag0.toFixed(3)} m -> ${sm.magnitudeM.toFixed(4)} m`);
  check('ErrorSmoother refuses to hide a 9 m error and reports a snap',
    sm.capture({ x: 9, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }) === false);
}

// ---------------------------------------------------------------------------
// 5 — snapshot buffer bookkeeping and delay policy
// ---------------------------------------------------------------------------
function testBuffer() {
  section('5. SnapshotBuffer (ordering, dedup, delay policy)');
  const mk = (tick, tMs) => ({ tick, serverTimeMs: tMs, entities: [] });

  {
    const b = new SnapshotBuffer();
    b.push(mk(0, 0), 0);
    const second = b.push(mk(0, 0), 5);
    check('rejects duplicates', second === false && b.size === 1);
  }
  {
    const b = new SnapshotBuffer();
    b.push(mk(0, 0), 0); b.push(mk(2, 100), 110); b.push(mk(1, 50), 120);
    check('accepts and re-orders a late arrival',
      b.size === 3 && b.stats.reordered === 1 &&
      b.oldest.snapshot.tick === 0 && b.newest.snapshot.tick === 2);
  }
  {
    const b = new SnapshotBuffer();
    b.push(mk(0, 0), 0); b.push(mk(3, 150), 150);
    check('counts real loss from server tick gaps', b.stats.missing === 2,
      `missing ${b.stats.missing}`);
  }
  {
    const b = new SnapshotBuffer();
    b.push(mk(0, 0), 0); b.push(mk(1, 50), 50); b.push(mk(2, 100), 100);
    const s = b.sample(75);
    check('straddling pair and alpha are exact',
      s.kind === 'interpolate' && s.from.snapshot.tick === 1 &&
      s.to.snapshot.tick === 2 && Math.abs(s.alpha - 0.5) < 1e-9);
    check('past the newest snapshot returns extrapolate',
      b.sample(140).kind === 'extrapolate' && b.sample(140).aheadMs === 40);
    check('before the oldest snapshot returns behind', b.sample(-10).kind === 'behind');
    check('empty buffer returns empty', new SnapshotBuffer().sample(0).kind === 'empty');
  }
  {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 40; i++) b.push(mk(i, i * 50), i * 50);
    check('clean 20 Hz link => delay converges to 2 intervals = 100 ms',
      Math.abs(b.intervalMs - 50) < 1 && Math.abs(b.targetDelayMs - 100) < 2,
      `interval ${b.intervalMs.toFixed(1)} ms, delay ${b.targetDelayMs.toFixed(1)} ms`);
  }
  {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 40; i++) b.push(mk(i, i * 33.333), i * 33.333);
    check('clean 30 Hz link => delay converges to ~67 ms',
      Math.abs(b.targetDelayMs - 66.7) < 2, `delay ${b.targetDelayMs.toFixed(1)} ms`);
  }
  {
    const b = new SnapshotBuffer();
    const r = new Rand(4242);
    for (let i = 0; i < 200; i++) b.push(mk(i, i * 50), i * 50 + r.next() * 120);
    check('jitter deepens the buffer, clamped to <= 300 ms',
      b.targetDelayMs > 100 && b.targetDelayMs <= 300,
      `jitterPeak ${b.jitterMs.toFixed(1)} ms -> delay ${b.targetDelayMs.toFixed(1)} ms`);
  }
  {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 60; i++) { if (i % 3 === 1) continue; b.push(mk(i, i * 50), i * 50); }
    check('33% loss does not inflate the interval estimate',
      Math.abs(b.intervalMs - 50) < 3, `interval ${b.intervalMs.toFixed(1)} ms`);
  }
  {
    const b = new SnapshotBuffer({ capacity: 8 });
    for (let i = 0; i < 500; i++) b.push(mk(i, i * 50), i * 50);
    check('ring stays bounded under 500 pushes', b.size === 8, `size ${b.size}`);
  }
}

// ---------------------------------------------------------------------------
// 6 — slerp
// ---------------------------------------------------------------------------
function testSlerp() {
  section('6. Quaternion slerp');
  const axisY = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
  const out = { x: 0, y: 0, z: 0, w: 1 };
  slerpQuat(out, axisY(0), axisY(Math.PI / 2), 0.5);
  check('halfway between 0 and 90 deg is 45 deg',
    quatAngle(out, axisY(Math.PI / 4)) < 1e-6,
    `err ${(quatAngle(out, axisY(Math.PI / 4)) * 180 / Math.PI).toExponential(2)} deg`);

  const a = axisY(0), b = axisY(Math.PI * 0.5);
  const bNeg = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  const o1 = { x: 0, y: 0, z: 0, w: 1 }, o2 = { x: 0, y: 0, z: 0, w: 1 };
  slerpQuat(o1, a, b, 0.5);
  slerpQuat(o2, a, bNeg, 0.5);
  check('shortest arc chosen across the quaternion double cover',
    quatAngle(o1, o2) < 1e-6,
    `divergence ${(quatAngle(o1, o2) * 180 / Math.PI).toExponential(2)} deg`);

  let maxStep = 0, prev = null;
  for (let t = 0; t <= 1.0001; t += 0.001) {
    slerpQuat(out, a, bNeg, Math.min(1, t));
    if (prev) maxStep = Math.max(maxStep, quatAngle(out, prev));
    prev = { ...out };
  }
  check('slerp path is continuous', maxStep * 180 / Math.PI < 0.5,
    `max step ${(maxStep * 180 / Math.PI).toFixed(4)} deg`);

  slerpQuat(out, a, a, 0.5);
  check('identical inputs do not produce NaN',
    Number.isFinite(out.x + out.y + out.z + out.w));
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
console.log(`\x1b[1m[net-interp] seed ${SEED}  node ${process.version}\x1b[0m`);
console.log(`  test path peak speed ${peakTruthSpeed().toFixed(2)} m/s, ` +
  `teleport of ${Math.hypot(TELEPORT_SHIFT.x, TELEPORT_SHIFT.y, TELEPORT_SHIFT.z).toFixed(1)} m at t=6.0 s`);

testClockAsymmetric();
testClockSymmetric();

section('3. Interpolation fidelity vs the true path');
const runs = [
  { label: 'clean LAN 30 Hz', tickHz: 30, loss: 0, jitterMs: 2, upMs: 5, downMs: 5,
    durationMs: 10_000, snapshotVelocity: true, useTeleportCounter: true, bound: 0.05 },
  { label: 'internet 20 Hz / 5% loss / 30 ms jitter', tickHz: 20, loss: 0.05, jitterMs: 30,
    upMs: 35, downMs: 30, dupChance: 0.02, durationMs: 10_000,
    snapshotVelocity: true, useTeleportCounter: true, bound: 0.25 },
  { label: 'bad wifi 20 Hz / 15% loss / 90 ms jitter', tickHz: 20, loss: 0.15, jitterMs: 90,
    upMs: 45, downMs: 45, dupChance: 0.05, durationMs: 10_000,
    snapshotVelocity: true, useTeleportCounter: true, bound: 0.60 },
  { label: 'no replicated velocity (lerp fallback)', tickHz: 20, loss: 0.05, jitterMs: 30,
    upMs: 35, downMs: 30, durationMs: 10_000,
    snapshotVelocity: false, useTeleportCounter: true, bound: 0.35 },
  { label: 'no teleport counter (distance heuristic)', tickHz: 20, loss: 0.05, jitterMs: 30,
    upMs: 35, downMs: 30, durationMs: 10_000,
    snapshotVelocity: true, useTeleportCounter: false, bound: 0.25 },
];

for (const cfg of runs) {
  const r = runInterpolation(cfg);
  const s = r.stats;
  console.log(`\n  \x1b[36m${r.label}\x1b[0m`);
  console.log(`    frames ${s.frames}  interp ${s.interpolated}  extrap ${s.extrapolated}` +
    `  cold ${s.cold}  starved ${s.starved}  behind ${s.behind}  snaps ${s.snaps}` +
    `  rebaselines ${s.rebaselines}`);
  console.log(`    link  sent ${r.link.sentDown}  lost ${r.link.lostDown}  dup ${r.link.dupDown}` +
    `  reordered ${r.buffer.stats.reordered}  tickGaps ${r.buffer.stats.missing}` +
    `  dupRejected ${r.buffer.stats.rejected}`);
  console.log(`    playout  interval ${r.intervalMs.toFixed(1)} ms  jitterPeak ` +
    `${r.jitterPeakMs.toFixed(1)} ms  delay ${r.delayMs.toFixed(1)} ms`);
  console.log(`    error vs truth  mean ${r.mean.toFixed(4)} m  p99 ${r.p99.toFixed(4)} m` +
    `  max ${r.maxErrInterp.toFixed(4)} m   rot max ${r.maxRotErrDeg.toFixed(3)} deg`);

  check(`[${r.label}] path within ${cfg.bound} m of truth`,
    r.maxErrInterp <= cfg.bound, `max ${r.maxErrInterp.toFixed(4)} m over ${r.samples} samples`);
  check(`[${r.label}] render time never moves backwards`,
    r.renderBackwards === 0,
    `${r.renderBackwards} reversals (worst ${r.maxRenderStepBack.toFixed(3)} ms)`);
  check(`[${r.label}] no NaN escaped`, !r.nanSeen);
  check(`[${r.label}] no clock rebaseline needed`,
    r.stats.rebaselines === 0 && r.epoch === 0);
  check(`[${r.label}] mostly interpolating, not guessing`,
    s.extrapolated / Math.max(1, s.frames) < 0.10,
    `${(100 * s.extrapolated / Math.max(1, s.frames)).toFixed(2)}% of frames extrapolated`);
  check(`[${r.label}] teleport snapped, never glided`,
    r.maxGlideDuringTeleport < 0.6 && r.teleportSnapAtSimMs > 0,
    `worst distance from either endpoint ${r.maxGlideDuringTeleport.toFixed(3)} m, ` +
    `snap at t=${(r.teleportSnapAtSimMs / 1000).toFixed(3)} s`);
  check(`[${r.label}] exactly one spawn snap + one teleport snap`,
    r.snapFrames === 2, `${r.snapFrames} snap frames`);
}

section('3b. Hard stall: host stops sending for 1.5 s');
const stall = runInterpolation({
  label: 'stall', tickHz: 20, loss: 0.02, jitterMs: 20, upMs: 30, downMs: 30,
  durationMs: 9_000, snapshotVelocity: true, useTeleportCounter: true,
  stallFromMs: 3_000, stallToMs: 4_500,
});
console.log(`    frames ${stall.stats.frames}  extrap ${stall.stats.extrapolated}` +
  `  cappedFrames ${stall.stats.stalledFrames}  snaps ${stall.stats.snaps}`);
console.log(`    max drift from last known position during the stall ` +
  `${stall.maxStallDrift.toFixed(3)} m over ${stall.framesDuringStall} frames`);
check('stalled entity stays inside the 2 m extrapolation cap',
  stall.maxStallDrift <= DEFAULT_EXTRAPOLATION.maxDistanceM + 0.01,
  `${stall.maxStallDrift.toFixed(3)} m <= ${DEFAULT_EXTRAPOLATION.maxDistanceM} m`);
check('render time never moves backwards through a 1.5 s stall',
  stall.renderBackwards === 0, `${stall.renderBackwards} reversals`);
check('the extrapolation cap actually engaged',
  stall.stats.stalledFrames > 0, `${stall.stats.stalledFrames} capped frames`);
check('recovery leaves no NaN', !stall.nanSeen);
check('no starvation: the buffer still had snapshots to show',
  stall.stats.starved === 0,
  `${stall.stats.starved} starved frames (${stall.stats.cold} cold frames before ` +
  `the first snapshot, which are not starvation)`);
check('cold frames are bounded by the first snapshot arriving',
  stall.stats.cold > 0 && stall.stats.cold < 60,
  `${stall.stats.cold} frames rendered nothing at connect`);

testExtrapolationCaps();
testBuffer();
testSlerp();

// ---------------------------------------------------------------------------
// 7 — entity lifecycle, clock discontinuity, determinism
//
// These drive the Interpolator directly on a clean, exactly-known link so the
// assertions are about the interpolator's own bookkeeping rather than about
// link statistics. Everything here was previously untested: spawn/despawn is
// what interest management does at every PVS boundary, and the rebaseline path
// is what runs after a host migration or a laptop lid closing.
// ---------------------------------------------------------------------------

/** A scripted 20 Hz host with three entities appearing and disappearing. */
function lifecycleScenario(clockJumpMs = 0, jumpAtMs = -1) {
  const interp = new Interpolator();
  const TICK = 50;
  const OWD = 30;              // one-way delay, host -> client
  const DUR = 4_000;
  const posOf = (id, tMs) => ({
    x: id * 10 + Math.sin(tMs * 0.001 + id) * 2,
    y: 1 + id,
    z: id * -3 + tMs * 0.001,
  });

  // id 1 lives the whole time; id 2 despawns at 2000 ms; id 3 spawns at 1000 ms.
  const alive = (id, tMs) =>
    id === 1 ? true : id === 2 ? tMs < 2_000 : tMs >= 1_000;

  let serverNow = 100_000;     // arbitrary server epoch
  let nextTick = 0, tick = 0, applied = 0;
  const pending = [];
  const trace = [];
  const seen = new Map();      // id -> { firstVisibleMs, lastVisibleMs, snaps, maxStep }
  const last = new Map();
  let maxVisible = 0, nan = false, backwards = 0, prevRt = -Infinity;
  let epochBumps = 0, prevEpoch = interp.epoch;

  for (let simMs = 0; simMs < DUR; simMs += 1000 / 144) {
    if (clockJumpMs !== 0 && applied === 0 && simMs >= jumpAtMs && jumpAtMs >= 0) {
      serverNow += clockJumpMs;
      applied = 1;
    }
    serverNow += 1000 / 144;

    while (simMs >= nextTick) {
      const entities = [];
      for (const id of [1, 2, 3]) {
        if (!alive(id, nextTick)) continue;
        entities.push({
          id,
          position: posOf(id, nextTick),
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          teleport: 0,
        });
      }
      // serverTimeMs is the tick's own time on the (unjumped) server timeline.
      pending.push({
        arriveAt: simMs + OWD,
        snap: { tick, serverTimeMs: 100_000 + nextTick, entities },
      });
      tick++;
      nextTick += TICK;
    }
    while (pending.length && pending[0].arriveAt <= simMs) {
      const p = pending.shift();
      interp.push(p.snap, serverNow);
    }

    interp.update(serverNow);
    if (interp.epoch !== prevEpoch) { epochBumps++; prevEpoch = interp.epoch; }
    const rt = interp.renderTimeMs;
    if (rt < prevRt && epochBumps === 0) backwards++;
    prevRt = rt;

    maxVisible = Math.max(maxVisible, interp.transforms.size);
    for (const id of [1, 2, 3]) {
      const t = interp.get(id);
      if (!t) continue;
      if (!Number.isFinite(t.position.x + t.position.y + t.position.z)) nan = true;
      let rec = seen.get(id);
      if (!rec) { rec = { first: simMs, last: simMs, snaps: 0, maxStep: 0, firstPos: null }; seen.set(id, rec); }
      if (rec.firstPos === null) rec.firstPos = { ...t.position };
      rec.last = simMs;
      if (t.snapped) rec.snaps++;
      const l = last.get(id);
      if (l) rec.maxStep = Math.max(rec.maxStep, distance(l, t.position));
      last.set(id, { ...t.position });
      trace.push(id, Math.round(t.position.x * 1e6), Math.round(t.position.y * 1e6),
        Math.round(t.position.z * 1e6));
    }
  }
  return { interp, seen, maxVisible, nan, backwards, epochBumps, trace, posOf, DUR };
}

section('7. Entity lifecycle (spawn / despawn / interest churn)');
{
  const r = lifecycleScenario();
  const e1 = r.seen.get(1), e2 = r.seen.get(2), e3 = r.seen.get(3);
  check('all three entities were rendered at some point',
    !!e1 && !!e2 && !!e3, `visible ids ${[...r.seen.keys()].join(',')}`);
  check('never renders more entities than the host sent', r.maxVisible === 3,
    `peak ${r.maxVisible}`);
  check('a persistent entity snaps exactly once, at first sight',
    e1.snaps === 1, `${e1.snaps} snapped frames for id 1`);
  check('a late spawn appears at its true position, it does not glide in',
    distance(e3.firstPos, r.posOf(3, 1_000)) < 0.35,
    `${distance(e3.firstPos, r.posOf(3, 1_000)).toFixed(3)} m from the spawn point`);
  check('a late spawn snaps exactly once', e3.snaps === 1, `${e3.snaps} snapped frames for id 3`);
  // Host stops sending id 2 at t=2000; the client is rendering ~playout delay
  // in the past, so it should vanish shortly after 2000 + delay, not linger.
  const vanishMs = e2.last;
  check('a despawned entity is retired, and within one playout delay',
    vanishMs > 2_000 && vanishMs < 2_000 + 400,
    `id 2 last rendered at ${vanishMs.toFixed(0)} ms (host stopped at 2000 ms)`);
  check('id 2 never reappears after retirement', !r.interp.get(2));
  check('no entity teleports frame-to-frame during steady interpolation',
    e1.maxStep < 0.2 && e3.maxStep < 0.2,
    `worst per-frame step ${Math.max(e1.maxStep, e3.maxStep).toFixed(4)} m`);
  check('lifecycle churn leaves no NaN', !r.nan);
  check('render time monotonic across spawn and despawn', r.backwards === 0);
  check('no spurious rebaseline on a clean link',
    r.interp.stats.rebaselines === 0 && r.epochBumps === 0,
    `rebaselines ${r.interp.stats.rebaselines}, epoch bumps ${r.epochBumps}`);
}

section('7b. Clock discontinuity (host migration / tab wake)');
{
  // Server clock jumps 3 s FORWARD mid-match while snapshots keep flowing.
  // Render time would race past the newest snapshot forever, so the
  // interpolator must deepen the delay and declare an epoch change.
  const fwd = lifecycleScenario(3_000, 1_500);
  check('a 3 s forward clock jump is detected and rebaselined',
    fwd.interp.stats.rebaselines >= 1, `${fwd.interp.stats.rebaselines} rebaselines`);
  check('the forward jump raises epoch so consumers can hard-reset',
    fwd.epochBumps >= 1, `${fwd.epochBumps} epoch bumps`);
  check('after rebaselining it is interpolating again, not extrapolating forever',
    fwd.interp.stats.interpolated > fwd.interp.stats.frames * 0.8,
    `${fwd.interp.stats.interpolated}/${fwd.interp.stats.frames} frames interpolated`);
  check('forward clock jump leaves no NaN', !fwd.nan);
  check('render time monotonic before the epoch change', fwd.backwards === 0);

  // ...and 3 s BACKWARD. Jumping render time forward again is monotonic-safe,
  // so this must recover WITHOUT an epoch change.
  const back = lifecycleScenario(-3_000, 1_500);
  check('a 3 s backward clock jump is detected and rebaselined',
    back.interp.stats.rebaselines >= 1, `${back.interp.stats.rebaselines} rebaselines`);
  check('backward jump recovers to interpolating',
    back.interp.stats.interpolated > back.interp.stats.frames * 0.8,
    `${back.interp.stats.interpolated}/${back.interp.stats.frames} frames interpolated`);
  check('backward clock jump leaves no NaN', !back.nan);
  check('the entity is still being rendered after both jumps',
    !!fwd.interp.get(1) && !!back.interp.get(1));
}

section('7c. Determinism');
{
  const a = lifecycleScenario();
  const b = lifecycleScenario();
  let diff = -1;
  if (a.trace.length !== b.trace.length) diff = -2;
  else for (let i = 0; i < a.trace.length; i++) if (a.trace[i] !== b.trace[i]) { diff = i; break; }
  check('two identical runs produce bit-identical output',
    diff === -1, `${a.trace.length} sampled values compared, first difference ${diff}`);

  // The whole prediction/replay story rests on there being no hidden entropy.
  const src = await import('node:fs')
    .then((fs) => ['Clock', 'Extrapolate', 'Interpolator', 'SnapshotBuffer', 'math',
      'InterpolationSystem', 'types', 'index']
      .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'net', 'interp', `${f}.ts`), 'utf8'))
      .join('\n'));
  check('no Math.random anywhere in src/net/interp', !/Math\s*\.\s*random/.test(src));
  check('no Date.now in the simulation path (time comes from TimeSource)',
    !/Date\s*\.\s*now/.test(src));
}

section('Summary');
const passed = results.filter((r) => r.ok).length;
console.log(`  ${passed}/${results.length} checks passed`);
if (failures) {
  console.log(`\n\x1b[31m${failures} FAILURE(S)\x1b[0m`);
  for (const r of results) if (!r.ok) console.log(`   - ${r.name}  ${r.detail ?? ''}`);
  process.exit(1);
}
console.log('\n\x1b[32mALL PASS\x1b[0m');
