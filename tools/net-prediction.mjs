/**
 * Headless verification of client prediction and server reconciliation.
 *
 *   node tools/net-prediction.mjs
 *
 * Drives the real `Movement`, the real `CommandBuilder`, the real wire codec and
 * the real reconciler against a simulated authority over a latency link, at
 * several round-trip times, and prints corrections/second and mean correction
 * magnitude for each. Netcode cannot be verified from a screenshot.
 */

import * as THREE from 'three';
import './net-ts-loader.mjs';
import { StubWorld } from './net-stub-world.mjs';

const {
  ClientPrediction, AuthoritativeMovement, InputBuffer,
  createMovementState, encodeCommandBatch, decodeCommandBatch,
  createMoveCommand, quantizeMoveCommand, commandBatchBytes,
  correctionsPerSecond, meanCorrectionMeters, meanAppliedCorrectionMeters,
  meanErrorMeters, meanReplayDepth, DEFAULT_RECONCILE_OPTIONS,
} = await import('../src/net/prediction/index.ts');
const { Movement } = await import('../src/player/Movement.ts');
const { CommandBuilder } = await import('../src/player/CommandBuilder.ts');
const { movementStatesIdentical, firstDifferingField } =
  await import('../src/player/MovementState.ts');
const { LatencyLink } = await import('../src/net/prediction/testing/LatencyLink.ts');
const { makeMovementScript, applyScriptedSample, clearScriptedInput } =
  await import('../src/net/prediction/testing/ScriptedInput.ts');

const HZ = 120;
const DT = 1 / HZ;
const SPAWN = new THREE.Vector3(0, 0.9, 8);
const SPAWN_YAW = Math.PI;

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  —  ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function makeMovement() {
  const mv = new Movement();
  mv.attach(new StubWorld());
  mv.emitEvents = false;
  mv.teleport(SPAWN, SPAWN_YAW);
  return mv;
}

/* ------------------------------------------------------- 1. input buffer -- */

function testInputBuffer() {
  section('InputBuffer');
  const buf = new InputBuffer(16);
  const cmd = createMoveCommand();

  for (let i = 0; i < 10; i++) { cmd.seq = i; cmd.moveX = i / 127; buf.push(cmd); }
  check(buf.length === 10, 'retains unacked commands', `length=${buf.length}`);
  check(buf.get(4) !== null && buf.get(4).seq === 4, 'random access by sequence');

  const acked = buf.ackThrough(3);
  check(acked === 4 && buf.length === 6, 'ackThrough retires the prefix', `acked=${acked} left=${buf.length}`);
  check(buf.get(3) === null, 'acked commands are released');

  const after = [];
  const n = buf.collectAfter(5, after);
  check(n === 4 && after[0].seq === 6 && after[3].seq === 9,
    'collectAfter yields the replay list in order', `n=${n}`);

  const tail = [];
  const tn = buf.tail(3, tail);
  check(tn === 3 && tail[0].seq === 7 && tail[2].seq === 9,
    'tail yields the newest N for redundant send', `n=${tn}`);

  const before = buf.overflows;
  for (let i = 10; i < 40; i++) { cmd.seq = i; buf.push(cmd); }
  check(buf.length === 16, 'ring stays bounded when the server stops acking', `length=${buf.length}`);
  check(buf.overflows > before, 'overflow is counted, never silent', `overflows=${buf.overflows}`);

  let threw = false;
  try { cmd.seq = 999; buf.push(cmd); } catch { threw = true; }
  check(threw, 'non-contiguous push is rejected (the wire format depends on it)');
}

/* -------------------------------------------------------- 2. wire codec --- */

function testCodec() {
  section('Command wire codec');
  const src = [];
  for (let i = 0; i < 12; i++) {
    const c = createMoveCommand();
    c.seq = 1000 + i;
    c.tick = 5000 + i;
    c.dt = DT;
    c.moveX = (i % 3) - 1;
    c.moveY = i % 2 === 0 ? 1 : -1;
    c.yaw = -Math.PI + (i / 12) * Math.PI * 2 * 0.97;
    c.pitch = (i / 12 - 0.5) * 2.6;
    c.buttons = (i * 37) & 0x3fff;
    quantizeMoveCommand(c);
    src.push(c);
  }

  const bytes = commandBatchBytes(src.length);
  const view = new DataView(new ArrayBuffer(bytes));
  const end = encodeCommandBatch(view, 0, src, src.length);
  check(end === bytes, 'encoded size matches commandBatchBytes', `${end} bytes / ${src.length} commands`);

  const out = [];
  const { count } = decodeCommandBatch(view, 0, out);
  check(count === src.length, 'decoded count', `${count}`);

  let worstAngle = 0, worstAxis = 0, worstDt = 0, seqOk = true, btnOk = true;
  for (let i = 0; i < count; i++) {
    const a = src[i], b = out[i];
    if (a.seq !== b.seq || a.tick !== b.tick) seqOk = false;
    if (a.buttons !== b.buttons) btnOk = false;
    worstAngle = Math.max(worstAngle, Math.abs(a.yaw - b.yaw), Math.abs(a.pitch - b.pitch));
    worstAxis = Math.max(worstAxis, Math.abs(a.moveX - b.moveX), Math.abs(a.moveY - b.moveY));
    worstDt = Math.max(worstDt, Math.abs(a.dt - b.dt));
  }
  check(seqOk, 'sequence and tick survive the round trip');
  check(btnOk, 'buttons survive the round trip');
  check(worstAngle < 1e-9, 'quantised angles round-trip exactly', `max delta ${worstAngle.toExponential(2)} rad`);
  check(worstAxis < 1e-9, 'quantised axes round-trip exactly', `max delta ${worstAxis.toExponential(2)}`);
  check(worstDt < 1e-9, 'quantised dt round-trips exactly', `max delta ${worstDt.toExponential(2)} s`);
  console.log(`  upstream cost: ${(commandBatchBytes(8) * HZ / 1024).toFixed(1)} KiB/s`
    + ` at ${HZ} packets/s with 8x redundancy (${commandBatchBytes(8)} B/packet)`);
}

/* --------------------------------------------- 3. one movement code path -- */

function runScript(mv, builder, from, to, script, stepFn) {
  for (let i = from; i < to; i++) {
    const s = script(i, HZ);
    applyScriptedSample(s);
    stepFn(mv, builder, s);
  }
}

function testOneCodePath() {
  section('One movement code path (predicted == replayed == host)');
  const script = makeMovementScript('determinism');
  const STEPS = 600;

  // A: the legacy local path, Movement.step() sampling the input singleton.
  clearScriptedInput();
  const mvA = makeMovement();
  const historyA = [];
  runScript(mvA, null, 0, STEPS, script, (mv, _b, s) => {
    mv.step(DT, s.yaw, s.pitch);
    historyA.push(mv.capture(createMovementState()));
  });
  const finalA = historyA[STEPS - 1];

  // B: the networked path, explicit commands through stepCommand().
  clearScriptedInput();
  const mvB = makeMovement();
  const builderB = new CommandBuilder();
  const commands = [];
  runScript(mvB, builderB, 0, STEPS, script, (mv, b, s) => {
    const cmd = b.build(DT, s.yaw, s.pitch);
    commands.push(Object.assign(createMoveCommand(), cmd));
    mv.stepCommand(cmd);
  });
  const finalB = mvB.capture(createMovementState());

  check(movementStatesIdentical(finalA, finalB),
    `step() and stepCommand() agree bit-for-bit over ${STEPS} steps`,
    firstDifferingField(finalA, finalB) || 'every field identical');

  // C: restore mid-run and replay the recorded commands — reconciliation.
  const mvC = makeMovement();
  mvC.restore(historyA[299]);
  for (let i = 300; i < STEPS; i++) mvC.stepCommand(commands[i]);
  const finalC = mvC.capture(createMovementState());
  check(movementStatesIdentical(finalA, finalC),
    `restore at step 300 + replay ${STEPS - 300} commands reproduces the trajectory`,
    firstDifferingField(finalA, finalC) || 'every field identical');

  // D: the host path — same commands through AuthoritativeMovement.
  const mvD = makeMovement();
  const host = new AuthoritativeMovement(mvD, { bufferTarget: 1, maxQueue: 1024, maxCatchUp: 1 });
  host.enqueue(commands, commands.length);
  while (host.queued > 0) host.tick(DT);
  const finalD = mvD.capture(createMovementState());
  check(movementStatesIdentical(finalA, finalD),
    'the host reaches the identical state from the same commands',
    firstDifferingField(finalA, finalD) || 'every field identical');
  check(host.executed === STEPS, 'the host executed every command once',
    `${host.executed}/${STEPS}, ${host.droppedDuplicates} duplicates rejected`);

  // E: the redundant tail must not double-apply anything.
  const mvE = makeMovement();
  const hostE = new AuthoritativeMovement(mvE, { bufferTarget: 1, maxQueue: 128 });
  for (let i = 0; i < STEPS; i++) {
    const from = Math.max(0, i - 7);
    hostE.enqueue(commands.slice(from, i + 1));
    hostE.tick(DT);
  }
  while (hostE.queued > 0) hostE.tick(DT);
  const finalE = mvE.capture(createMovementState());
  check(movementStatesIdentical(finalA, finalE),
    '8x redundant resend is idempotent on the host',
    firstDifferingField(finalA, finalE) || 'every field identical');

  clearScriptedInput();
  return commands;
}

/* ------------------------------------------------------ 4. loopback runs -- */

function runLoopback(cfg) {
  const seconds = cfg.seconds ?? 12;
  const ticks = Math.round(seconds * HZ);
  const snapshotEvery = Math.round(HZ / (cfg.snapshotHz ?? 20));
  const tag = `${cfg.rttMs}-${cfg.jitterMs ?? 0}-${cfg.loss ?? 0}-${cfg.impulses ? 1 : 0}`;

  clearScriptedInput();
  const clientMv = makeMovement();
  const hostMv = makeMovement();

  const client = new ClientPrediction(clientMv, { historySize: 512, redundancy: 8 });
  const host = new AuthoritativeMovement(hostMv, { bufferTarget: 2, maxQueue: 128 });

  const up = new LatencyLink({
    rttMs: cfg.rttMs, jitterMs: cfg.jitterMs ?? 0, loss: cfg.loss ?? 0, seed: `up-${tag}`,
  });
  const down = new LatencyLink({
    rttMs: cfg.rttMs, jitterMs: cfg.jitterMs ?? 0, loss: 0, seed: `down-${tag}`,
  });

  let nowMs = 0;
  let upstreamBytes = 0;
  const scratchCmds = [];

  client.sendCommands = (cmds, n) => {
    // Encode exactly what a transport would put on the wire, so the byte count
    // is real rather than an estimate, and the codec is on the tested path.
    const buf = new ArrayBuffer(commandBatchBytes(n));
    encodeCommandBatch(new DataView(buf), 0, cmds, n);
    upstreamBytes += buf.byteLength;
    up.send(buf, nowMs);
  };

  const script = makeMovementScript('loopback');

  let correctedThisTick = false;
  const pumpDown = () => down.pump(nowMs, (u) => {
    const r = client.applyAuthoritative(u);
    if (r.outcome === 'corrected' || r.outcome === 'resync') correctedThisTick = true;
  });
  const pumpUp = () => up.pump(nowMs, (buf) => {
    const { count } = decodeCommandBatch(new DataView(buf), 0, scratchCmds);
    host.enqueue(scratchCmds, count);
  });
  const sendSnapshot = (tick) => {
    if (host.lastAckedSeq < 0) return;
    down.send({ seq: host.lastAckedSeq, tick, state: host.capture(createMovementState()) }, nowMs);
  };

  // Continuity instrumentation. `simStepQuiet` is how far the simulation moved
  // on frames with no correction — ordinary locomotion. `renderStep` is how far
  // the *eye* moved. Smoothing works iff renderStep never spikes to the size of
  // the correction.
  let simStepQuiet = 0, simStepMax = 0, renderStepMax = 0, visualOffsetMax = 0;
  const prevSim = new THREE.Vector3().copy(clientMv.position);
  const prevRender = new THREE.Vector3().copy(clientMv.position);
  const renderNow = new THREE.Vector3();

  for (let tick = 0; tick < ticks; tick++) {
    nowMs = (tick * 1000) / HZ;
    correctedThisTick = false;

    const s = script(tick, HZ);
    applyScriptedSample(s);
    client.fixedStep(DT, s.yaw, s.pitch);

    pumpUp();
    if (cfg.impulses && tick > 0 && tick % Math.round(HZ * 1.5) === 0) {
      // Knockback the client had no way of knowing about — a grenade landing
      // next to it. This is the correction path's real job.
      hostMv.velocity.x += 3.5;
      hostMv.velocity.y += 1.2;
    }
    host.tick(DT);
    if (tick % snapshotEvery === 0) sendSnapshot(tick);

    pumpDown();
    client.updateVisual(DT);

    const off = client.visualOffset;
    visualOffsetMax = Math.max(visualOffsetMax, Math.hypot(off.x, off.y, off.z));
    renderNow.set(clientMv.position.x + off.x, clientMv.position.y + off.y, clientMv.position.z + off.z);
    const simStep = prevSim.distanceTo(clientMv.position);
    simStepMax = Math.max(simStepMax, simStep);
    if (!correctedThisTick) simStepQuiet = Math.max(simStepQuiet, simStep);
    renderStepMax = Math.max(renderStepMax, prevRender.distanceTo(renderNow));
    prevSim.copy(clientMv.position);
    prevRender.copy(renderNow);
  }

  // Drain: stop producing input and let the host consume everything in flight,
  // so client and host are comparable at the same sequence.
  clearScriptedInput();
  let guard = 0;
  while ((up.inFlight > 0 || host.queued > 0) && guard++ < 100000) {
    nowMs += 1000 / HZ;
    pumpUp();
    if (host.queued > 0) host.tick(DT);
  }
  sendSnapshot(ticks);
  nowMs += cfg.rttMs + 1;
  pumpDown();

  const converged = clientMv.position.distanceTo(hostMv.position);
  const seqAligned = client.predictor.newestSeq === host.lastAckedSeq;

  return {
    cfg, seconds, converged, seqAligned,
    metrics: client.metrics,
    upstreamBytesPerSecond: upstreamBytes / seconds,
    simStepQuiet, simStepMax, renderStepMax, visualOffsetMax,
    hostExecuted: host.executed,
    hostStarved: host.starvedTicks,
    hostDupes: host.droppedDuplicates,
    upSent: up.sent, upDropped: up.dropped,
    clientCommands: client.metrics.commandsPredicted,
  };
}

function reportRun(label, r) {
  const m = r.metrics;
  console.log(
    `  ${label.padEnd(22)}`
    + ` corr/s ${correctionsPerSecond(m).toFixed(2).padStart(6)}`
    + ` | meanCorr ${(meanCorrectionMeters(m) * 100).toFixed(2).padStart(7)} cm`
    + ` | maxCorr ${(m.correctionMax * 100).toFixed(1).padStart(6)} cm`
    + ` | meanErr ${(meanErrorMeters(m) * 1000).toFixed(3).padStart(8)} mm`
    + ` | replay ${meanReplayDepth(m).toFixed(1).padStart(5)}`
    + ` | inflight ${String(m.maxInFlight).padStart(3)}`,
  );
  console.log(
    `  ${''.padEnd(22)}`
    + ` up ${(r.upstreamBytesPerSecond / 1024).toFixed(1)} KiB/s`
    + ` | pkts ${r.upSent} (-${r.upDropped})`
    + ` | hostExec ${r.hostExecuted}/${r.clientCommands}`
    + ` | starved ${r.hostStarved}`
    + ` | dupes ${r.hostDupes}`
    + ` | visOffset<=${(r.visualOffsetMax * 100).toFixed(2)} cm`
    + ` | simStep ${(r.simStepMax * 1000).toFixed(1)} mm`
    + ` | renderStep ${(r.renderStepMax * 1000).toFixed(1)} mm`
    + ` | converged ${(r.converged * 1000).toFixed(5)} mm`,
  );
}

const RTTS = [60, 120, 200];

function testCleanLink() {
  section('Loopback A — perfect link (0 jitter, 0 loss): proves host and client run the same code');
  const inflight = [];
  for (const rttMs of RTTS) {
    const r = runLoopback({ rttMs, jitterMs: 0, loss: 0, impulses: false });
    reportRun(`RTT ${rttMs}ms`, r);
    inflight.push(r.metrics.maxInFlight);
    check(r.metrics.corrections === 0, `RTT ${rttMs}ms: zero mispredictions`,
      `${r.metrics.corrections} corrections over ${r.metrics.updatesApplied} snapshots`);
    check(r.metrics.errorMax < 1e-9, `RTT ${rttMs}ms: prediction error is float noise`,
      `max ${(r.metrics.errorMax * 1000).toExponential(2)} mm`);
    check(r.converged < 1e-9, `RTT ${rttMs}ms: client converges to host exactly`,
      `${(r.converged * 1000).toExponential(2)} mm`);
    check(r.seqAligned, `RTT ${rttMs}ms: host consumed every command`,
      `hostExec ${r.hostExecuted}/${r.clientCommands}`);
  }
  check(inflight[0] < inflight[1] && inflight[1] < inflight[2],
    'the in-flight input window grows with latency', `${inflight.join(' < ')} commands`);
}

function testJitterAndLoss() {
  section('Loopback B — realistic link (+/-6 ms jitter, 0% loss)');
  for (const rttMs of RTTS) {
    const r = runLoopback({ rttMs, jitterMs: 6, loss: 0, impulses: false });
    reportRun(`RTT ${rttMs}ms`, r);
    check(r.converged < 0.015, `RTT ${rttMs}ms jitter: client converges to host`,
      `${(r.converged * 1000).toFixed(4)} mm < 15 mm`);
  }

  section('Loopback C — lossy link (+/-6 ms jitter, 5% upstream loss)');
  for (const rttMs of RTTS) {
    const r = runLoopback({ rttMs, jitterMs: 6, loss: 0.05, impulses: false });
    reportRun(`RTT ${rttMs}ms`, r);
    check(r.upDropped > 0, `RTT ${rttMs}ms lossy: packets really were dropped`,
      `${r.upDropped}/${r.upSent}`);
    check(r.hostExecuted === r.clientCommands,
      `RTT ${rttMs}ms lossy: the redundant tail recovered every lost command`,
      `${r.hostExecuted}/${r.clientCommands}`);
    check(r.converged < 0.015, `RTT ${rttMs}ms lossy: client converges to host`,
      `${(r.converged * 1000).toFixed(4)} mm < 15 mm`);
  }
}

function testImpulses() {
  section('Loopback D — unpredictable host impulses (knockback every 1.5 s)');
  for (const rttMs of RTTS) {
    const r = runLoopback({ rttMs, jitterMs: 6, loss: 0, impulses: true });
    reportRun(`RTT ${rttMs}ms`, r);
    const m = r.metrics;
    check(m.corrections > 0, `RTT ${rttMs}ms impulses: mispredictions are detected`,
      `${m.corrections} corrections, ${correctionsPerSecond(m).toFixed(2)}/s,`
      + ` mean ${(meanCorrectionMeters(m) * 100).toFixed(2)} cm`);
    check(m.replayedCommands > 0, `RTT ${rttMs}ms impulses: unacked input is replayed`,
      `${m.replayedCommands} commands replayed, ${meanReplayDepth(m).toFixed(1)} per update`);
    check(r.visualOffsetMax <= 0.75 + 1e-9, `RTT ${rttMs}ms impulses: visual offset respects the cap`,
      `${(r.visualOffsetMax * 100).toFixed(2)} cm <= 75 cm`);

    // The simulation snapped by up to maxCorr in a single step. The eye must
    // not: per frame it may only move ordinary locomotion distance plus one
    // half-life step of the parked offset.
    const decayPerFrame = 1 - Math.pow(0.5, DT / 0.06);
    const bound = r.simStepQuiet + decayPerFrame * r.visualOffsetMax + 1e-9;
    check(r.renderStepMax <= bound,
      `RTT ${rttMs}ms impulses: the view is smoothed, not snapped`,
      `renderStep ${(r.renderStepMax * 1000).toFixed(2)} mm <= ${(bound * 1000).toFixed(2)} mm`
      + ` while the sim snapped ${(m.correctionMax * 100).toFixed(1)} cm`);
    check(r.converged < 0.015, `RTT ${rttMs}ms impulses: client converges to host`,
      `${(r.converged * 1000).toFixed(4)} mm < 15 mm`);
  }
}

/* -------------------------------------------------------------------- main */

console.log('client prediction / server reconciliation — headless verification');
console.log(`simulation ${HZ} Hz, fixed dt ${DT.toFixed(6)} s, snapshots 20 Hz`);

testInputBuffer();
testCodec();
testOneCodePath();
testCleanLink();
testJitterAndLoss();
testImpulses();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
