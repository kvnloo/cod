/**
 * End-to-end prediction: the REAL host, over the REAL loopback transport.
 *
 *   node tools/net-prediction-e2e.mjs
 *
 * `tools/net-prediction.mjs` proves the prediction machinery in isolation
 * against a stub authority. This proves the thing that actually ships: a
 * `PeerHost` running the real `Movement` state machine through `MovementStepper`,
 * a `PeerSession` client predicting with the same code, commands and snapshots
 * crossing a `LoopbackNetwork` with real latency, and delta-compressed entity
 * state coming back through `SnapshotReader`.
 *
 * That path crosses three different structs and three different button layouts.
 * A screenshot cannot tell you it works; these numbers can.
 */

import * as THREE from 'three';
import './net-ts-loader.mjs';
import { StubWorld } from './net-stub-world.mjs';

const {
  ClientPrediction, MovementStepper, TickSeqMap,
  toHostInput, fromHostInput, playerToHostButtons, hostToPlayerButtons,
  playerToNetButtons, netToPlayerButtons, toNetInput, fromNetInput,
  movementStateFromEntity, authoritativeUpdateFromEntity,
  createMoveCommand, copyMoveCommand, createMovementState,
  correctionsPerSecond, meanCorrectionMeters, meanAppliedCorrectionMeters,
  meanErrorMeters, meanReplayDepth, resetPredictionMetrics,
  TickEstimator, BTN,
} = await import('../src/net/prediction/index.ts');

const { BUTTON_ACTIONS, BUTTON_LAYOUT_PLAYER } = await import('../src/net/types.ts');
const { LoopbackNetwork } = await import('../src/net/host/testing/LoopbackTransport.ts');
const { PeerSession } = await import('../src/net/host/PeerSession.ts');
const { PeerHost } = await import('../src/net/host/PeerHost.ts');
const { jsonCodec } = await import('../src/net/host/Codec.ts');
const { SnapshotReader } = await import('../src/net/host/SnapshotWriter.ts');
const { ENT, PROTOCOL_VERSION, createWorldState, newEntity } = await import('../src/net/host/types.ts');
const { Movement } = await import('../src/player/Movement.ts');
const { movementStatesIdentical, firstDifferingField, positionError } =
  await import('../src/player/MovementState.ts');
const { Rand } = await import('../src/core/Rand.ts');
const { makeMovementScript, applyScriptedSample, clearScriptedInput } =
  await import('../src/net/prediction/testing/ScriptedInput.ts');

const HZ = 64;
const DT = 1 / HZ;
const TICK_MS = 1000 / HZ;
const SPAWN = new THREE.Vector3(0, 0.9, 8);
const SPAWN_YAW = Math.PI;

let failures = 0;
let checks = 0;

function check(ok, label, detail = '') {
  checks++;
  if (!ok) failures++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? `  —  ${detail}` : ''}`);
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

/* ------------------------------------------------- 1. button layouts ------ */

function testButtonBridge() {
  section('Button layouts — the mask that crosses the wire');

  let lost = [];
  for (const action of BUTTON_ACTIONS) {
    const bit = BUTTON_LAYOUT_PLAYER[action];
    if (bit === undefined) continue;
    if (hostToPlayerButtons(playerToHostButtons(bit)) !== bit) lost.push(action);
  }
  check(lost.length === 0,
    'every player action survives the round trip through host space',
    lost.length ? `lost: ${lost.join(',')}` : `${BUTTON_ACTIONS.length} actions`);

  // PRONE and LEAN are the ones that matter: they change the capsule height, so
  // a host that never hears them mispredicts every tick the client is prone.
  const stance = BTN.PRONE | BTN.LEAN_L | BTN.LEAN_R | BTN.CROUCH;
  check(hostToPlayerButtons(playerToHostButtons(stance)) === stance,
    'stance bits (prone/lean/crouch) reach the host', `mask 0x${stance.toString(16)}`);

  lost = [];
  for (const action of BUTTON_ACTIONS) {
    const bit = BUTTON_LAYOUT_PLAYER[action];
    if (bit === undefined) continue;
    if (netToPlayerButtons(playerToNetButtons(bit)) !== bit) lost.push(action);
  }
  check(lost.length === 0, 'every player action survives the normative wire layout',
    lost.length ? `lost: ${lost.join(',')}` : `${BUTTON_ACTIONS.length} actions`);

  // A raw mask crossing unconverted is the bug this bridge exists to stop.
  check(playerToHostButtons(BTN.FIRE) !== BTN.FIRE,
    'the layouts really do differ (a raw mask would be wrong)',
    `player FIRE=0x${BTN.FIRE.toString(16)} host=0x${playerToHostButtons(BTN.FIRE).toString(16)}`);

  const cmd = createMoveCommand();
  cmd.seq = 42; cmd.tick = 7; cmd.dt = DT;
  cmd.moveX = -0.75; cmd.moveY = 1; cmd.yaw = 1.25; cmd.pitch = -0.4;
  cmd.buttons = BTN.SPRINT | BTN.JUMP | BTN.PRONE | BTN.FIRE;

  const back = fromHostInput(toHostInput(cmd, 99), DT);
  check(back.moveX === cmd.moveX && back.moveY === cmd.moveY
    && back.yaw === cmd.yaw && back.pitch === cmd.pitch && back.buttons === cmd.buttons,
    'MoveCommand -> host InputCommand -> MoveCommand is lossless',
    `buttons 0x${back.buttons.toString(16)}`);

  const netBack = fromNetInput(toNetInput(cmd, 99));
  check(Math.abs(netBack.dt - cmd.dt) < 1e-12 && netBack.moveY === cmd.moveY
    && netBack.buttons === cmd.buttons,
    'MoveCommand -> normative InputCommand -> MoveCommand is lossless');
}

/* --------------------------------------- 2. host/client movement parity --- */

function makeWorldWithPlayer(clientId, entityId) {
  const world = createWorldState(1234);
  const ent = newEntity(entityId, ENT.PLAYER, clientId);
  ent.px = SPAWN.x; ent.py = SPAWN.y; ent.pz = SPAWN.z; ent.yaw = SPAWN_YAW;
  world.entities.set(entityId, ent);
  world.players.set(clientId, {
    clientId, stableId: 'p', name: 'p', team: 0, entityId,
    score: 0, kills: 0, deaths: 0, lastAckedInputTick: -1,
    connected: true, lastSeenTick: 0,
  });
  return { world, ent };
}

function testStepperParity() {
  section('Host and client run the SAME movement');

  const stepper = new MovementStepper({ tickRate: HZ, createMovement: () => makeMovement() });
  const { world, ent } = makeWorldWithPlayer(1, 1);
  const rand = new Rand('parity');
  const ops = {
    tick: 0, emit() {}, damage() { return false; },
    spawn() { return ent; }, despawn() {},
  };

  // The client's copy, seeded from the same entity record the host seeds from.
  const client = makeMovement();
  client.restore(movementStateFromEntity(ent));

  const script = makeMovementScript('parity');
  const hostState = createMovementState();
  const clientState = createMovementState();
  const cmds = new Map();
  let firstDivergence = -1;
  let worstPos = 0;
  const TICKS = HZ * 20;

  for (let t = 0; t < TICKS; t++) {
    const s = script(t, HZ);
    applyScriptedSample(s);
    // Build the command the way a client does, then send it the way the wire does.
    const cmd = createMoveCommand();
    cmd.seq = t; cmd.tick = t; cmd.dt = DT;
    cmd.moveX = s.moveX; cmd.moveY = s.moveY; cmd.yaw = s.yaw; cmd.pitch = s.pitch;
    cmd.buttons = (s.actions.includes('sprint') ? BTN.SPRINT : 0)
      | (s.actions.includes('jump') ? BTN.JUMP : 0)
      | (s.actions.includes('crouch') ? BTN.CROUCH : 0)
      | (s.actions.includes('ads') ? BTN.ADS : 0)
      | (s.actions.includes('leanRight') ? BTN.LEAN_R : 0);

    const hostInput = toHostInput(cmd, t);
    cmds.clear();
    cmds.set(1, hostInput);
    world.tick = t;
    ops.tick = t;
    stepper.step(world, cmds, rand, ops);

    // The client predicts the same command, decoded from the same wire struct.
    client.stepCommand(fromHostInput(hostInput, DT));

    stepper.capture(1, hostState);
    client.capture(clientState);
    const err = positionError(hostState, clientState);
    if (err > worstPos) worstPos = err;
    if (firstDivergence < 0 && !movementStatesIdentical(hostState, clientState)) {
      firstDivergence = t;
      console.log(`        first divergence at tick ${t}: ${firstDifferingField(hostState, clientState)}`);
    }
  }
  clearScriptedInput();

  check(firstDivergence < 0,
    'identical commands produce bit-identical state on host and client',
    `${TICKS} ticks, worst position delta ${(worstPos * 1000).toFixed(6)} mm`);
  check(stepper.stats.commandsExecuted === TICKS,
    'the host executed every command', `${stepper.stats.commandsExecuted}/${TICKS}`);
  check(stepper.stats.starvedTicks === 0, 'no input starvation when every tick has a command');

  // Entity writeback is what other clients see.
  check(Math.abs(ent.px - hostState.px) < 1e-9 && Math.abs(ent.py - hostState.py) < 1e-9,
    'movement result is published into the entity table',
    `ent=(${ent.px.toFixed(3)}, ${ent.py.toFixed(3)}, ${ent.pz.toFixed(3)})`);

  stepper.dispose();
}

/* --------------------------------------------- 3. full loopback session --- */

function runSession(rttMs, jitterMs, loss, label) {
  const half = rttMs / 2;
  const net = new LoopbackNetwork(`e2e-${rttMs}`);
  const hostPort = net.createPort('host');
  const clientPort = net.createPort('c1');
  net.connect('host', 'c1', { latencyMs: half, jitterMs, loss });

  const stepper = new MovementStepper({
    tickRate: HZ,
    createMovement: () => makeMovement(),
    placeSpawn: (_state, ent) => {
      ent.px = SPAWN.x; ent.py = SPAWN.y; ent.pz = SPAWN.z;
      ent.vx = 0; ent.vy = 0; ent.vz = 0;
      ent.yaw = SPAWN_YAW; ent.pitch = 0;
    },
  });

  const hostSession = new PeerSession({
    stableId: 'HOST', displayName: 'host', transport: hostPort,
    sim: stepper, hostConfig: { tickRate: HZ, seed: 99 },
  });
  hostSession.hostMatch(99);

  const clientMovement = makeMovement();
  const client = new ClientPrediction(clientMovement, { sendEveryNSteps: 1, redundancy: 1 });

  const lastCmd = createMoveCommand();
  let haveCmd = false;
  client.sendCommands = (cmds, n) => {
    if (n > 0) { copyMoveCommand(lastCmd, cmds[n - 1]); haveCmd = true; }
  };

  const tickSeq = new TickSeqMap(512);
  const reader = new SnapshotReader();
  const script = makeMovementScript(`e2e-${rttMs}`);

  let myClientId = 0;
  let spawned = false;
  let frame = 0;
  let settling = false;
  let updatesApplied = 0;
  let noPredictedState = 0;
  let reordered = 0;
  let lastStampedTick = -1;
  let snapshots = 0;
  const scratchUpdate = { seq: 0, tick: 0, state: createMovementState() };

  const ownEntity = () => {
    for (const ent of reader.entities.values()) {
      if (ent.kind === ENT.PLAYER && ent.owner === myClientId) return ent;
    }
    return null;
  };

  const clientSession = new PeerSession({
    stableId: 'CLI', displayName: 'client', transport: clientPort,
    hostConfig: { tickRate: HZ },
    // Commands must be stamped far enough ahead that they land before the host
    // simulates that tick. Half the RTT plus a jitter margin — this is the knob
    // that trades input lag for starvation, and it is measured below.
    inputLeadTicks: Math.ceil(half / TICK_MS) + 3,
    inputRedundancy: 3,
    sink: {
      onWelcome: (info) => { myClientId = info.clientId; },
      onSnapshot: (s) => {
        snapshots++;
        // A reordered snapshot is buffered as a baseline but does NOT move the
        // reconstructed entities — `SnapshotReader` keeps the newest state it
        // has. Reconciling on it would pair the newest positions with an older
        // `ackInputTick`, which reads as a misprediction that never happened.
        // Only an ack that actually advanced the world is worth correcting to.
        const before = reader.tick;
        if (!reader.apply(s)) return;
        if (reader.tick <= before) { reordered++; return; }
        const ent = ownEntity();
        if (!ent) return;
        if (!spawned) {
          client.resetTo(movementStateFromEntity(ent));
          resetPredictionMetrics(client.metrics);
          spawned = true;
          return;
        }
        const seq = tickSeq.seqForTick(s.ackInputTick);
        if (seq < 0) return;
        const predicted = client.predictor.stateAt(seq);
        if (!predicted) { noPredictedState++; return; }
        authoritativeUpdateFromEntity(predicted, ent, seq, s.tick, scratchUpdate);
        client.applyAuthoritative(scratchUpdate);
        updatesApplied++;
      },
    },
    input: (tick) => {
      if (!spawned) return null;
      // The session's tick estimate is derived from the newest snapshot it has
      // seen, so under jitter it can stall and ask twice for the same tick. The
      // host executes one command per tick and drops the duplicate, so we must
      // not predict a second step for it either — resend the command we already
      // stamped. Predicting a step the host will never run is a desync.
      if (tick <= lastStampedTick) {
        return haveCmd ? toHostInput(lastCmd, tick) : null;
      }
      lastStampedTick = tick;
      // One prediction step per command sent: the client simulates exactly what
      // it transmits, which is the only way the sequence numbers mean anything.
      const s = settling
        ? { moveX: 0, moveY: 0, yaw: SPAWN_YAW, pitch: 0, actions: [] }
        : script(frame, HZ);
      frame++;
      applyScriptedSample(s);
      client.fixedStep(DT, s.yaw, s.pitch);
      if (!haveCmd) return null;
      tickSeq.record(tick, lastCmd.seq);
      return toHostInput(lastCmd, tick);
    },
  });

  clientSession.joinMatch('host');

  let nowMs = 0;
  const RUN_TICKS = HZ * 20;
  const SETTLE_TICKS = HZ * 3;
  for (let i = 0; i < RUN_TICKS + SETTLE_TICKS; i++) {
    if (i === RUN_TICKS) settling = true;
    nowMs += TICK_MS;
    net.advanceTo(nowMs);
    hostSession.update(DT, nowMs);
    clientSession.update(DT, nowMs);
    client.updateVisual(DT);
  }
  clearScriptedInput();

  const hostState = stepper.capture(myClientId);
  const clientState = clientMovement.capture(createMovementState());
  const converged = hostState ? positionError(hostState, clientState) : Infinity;

  const m = client.metrics;
  const stats = clientSession.stats();
  const result = {
    label,
    rttMs,
    corrPerSec: correctionsPerSecond(m),
    meanCorr: meanCorrectionMeters(m),
    maxCorr: m.correctionMax,
    meanApplied: meanAppliedCorrectionMeters(m),
    meanErr: meanErrorMeters(m),
    replay: meanReplayDepth(m),
    corrections: m.corrections,
    updates: updatesApplied,
    predicted: m.commandsPredicted,
    snapshots,
    noPredictedState,
    reordered,
    inFlight: m.maxInFlight,
    converged,
    starved: stepper.starvedTicks(myClientId),
    hostTicks: stepper.stats.ticksStepped,
    executed: stepper.stats.commandsExecuted,
    bytesSent: stats.bytesSent,
    bytesReceived: stats.bytesReceived,
    seconds: (RUN_TICKS + SETTLE_TICKS) / HZ,
    droppedNoBaseline: reader.droppedNoBaseline,
  };

  clientSession.dispose();
  hostSession.dispose();
  stepper.dispose();
  return result;
}

function report(r) {
  const upKiB = r.bytesSent / 1024 / r.seconds;
  const downKiB = r.bytesReceived / 1024 / r.seconds;
  console.log(
    `  RTT ${String(r.rttMs) + 'ms'.padEnd(3)}`.padEnd(24)
    + `corr/s ${r.corrPerSec.toFixed(2).padStart(6)}`
    + ` | meanCorr ${(r.meanCorr * 100).toFixed(2).padStart(7)} cm`
    + ` | maxCorr ${(r.maxCorr * 100).toFixed(1).padStart(6)} cm`
    + ` | meanErr ${(r.meanErr * 1000).toFixed(3).padStart(7)} mm`
    + ` | replay ${r.replay.toFixed(1).padStart(5)}`,
  );
  console.log(
    ''.padEnd(24)
    + `updates ${r.updates}/${r.snapshots} snapshots`
    + ` | predicted ${r.predicted}`
    + ` | hostExec ${r.executed}/${r.hostTicks}`
    + ` | starved ${r.starved} | reordered ${r.reordered}`
    + ` | up ${upKiB.toFixed(1)} KiB/s down ${downKiB.toFixed(1)} KiB/s`
    + ` | converged ${(r.converged * 1000).toFixed(3)} mm`,
  );
}

function testLoopback() {
  section('Loopback — real PeerHost, real transport, scripted input');
  const perfect = [];
  for (const rtt of [60, 120, 200]) {
    const r = runSession(rtt, 0, 0, `perfect ${rtt}`);
    perfect.push(r);
    report(r);
    check(r.updates > 100,
      `RTT ${rtt}ms: authoritative updates actually reconciled`, `${r.updates} updates`);
    check(r.predicted > 1000,
      `RTT ${rtt}ms: the client predicted its own input`, `${r.predicted} commands`);
    check(r.executed >= r.hostTicks * 0.9,
      `RTT ${rtt}ms: the host consumed the command stream`,
      `${r.executed} commands over ${r.hostTicks} ticks`);
    check(r.converged < 0.05,
      `RTT ${rtt}ms: client converges to host state`,
      `${(r.converged * 1000).toFixed(3)} mm < 50 mm`);
    check(r.meanCorr < 0.35,
      `RTT ${rtt}ms: corrections stay small`,
      `mean ${(r.meanCorr * 100).toFixed(2)} cm over ${r.corrections} corrections`);
  }

  check(perfect[2].inFlight >= perfect[0].inFlight,
    'the in-flight input window grows with latency',
    `${perfect[0].inFlight} -> ${perfect[1].inFlight} -> ${perfect[2].inFlight} commands`);

  section('Loopback — jitter and packet loss');
  for (const rtt of [60, 120, 200]) {
    const r = runSession(rtt, 8, 0.05, `lossy ${rtt}`);
    report(r);
    check(r.converged < 0.10,
      `RTT ${rtt}ms +/-8ms jitter 5% loss: client still converges`,
      `${(r.converged * 1000).toFixed(3)} mm < 100 mm`);
    check(r.updates > 50,
      `RTT ${rtt}ms lossy: reconciliation kept running through the loss`,
      `${r.updates} updates, ${r.noPredictedState} acks older than history`);
  }
}

/* ------------------------------- 4. tick clock vs snapshot-derived tick --- */

/**
 * The same host, the same movement, the same link — but the client stamps its
 * commands from a slewed local tick clock (`TickEstimator`) instead of from the
 * newest snapshot tick, and speaks the host protocol directly rather than
 * through `PeerSession`. Everything else is held constant, so the difference in
 * corrections/second is attributable to the clock and nothing else.
 */
function runDirect(rttMs, jitterMs, loss) {
  const half = rttMs / 2;
  const netLink = new LoopbackNetwork(`direct-${rttMs}`);
  const hostPort = netLink.createPort('host');
  const clientPort = netLink.createPort('c1');
  netLink.connect('host', 'c1', { latencyMs: half, jitterMs, loss });

  const stepper = new MovementStepper({
    tickRate: HZ,
    createMovement: () => makeMovement(),
    placeSpawn: (_state, ent) => {
      ent.px = SPAWN.x; ent.py = SPAWN.y; ent.pz = SPAWN.z;
      ent.vx = 0; ent.vy = 0; ent.vz = 0;
      ent.yaw = SPAWN_YAW; ent.pitch = 0;
    },
  });
  const host = new PeerHost({
    stableId: 'HOST', displayName: 'host', transport: hostPort,
    sim: stepper, config: { tickRate: HZ, seed: 99 },
  });
  host.start();

  const clientMovement = makeMovement();
  const client = new ClientPrediction(clientMovement, { sendEveryNSteps: 1, redundancy: 1 });
  const lastCmd = createMoveCommand();
  let haveCmd = false;
  client.sendCommands = (cmds, n) => {
    if (n > 0) { copyMoveCommand(lastCmd, cmds[n - 1]); haveCmd = true; }
  };

  const clock = new TickEstimator({ tickRate: HZ, leadTicks: 3 });
  const reader = new SnapshotReader();
  const tickSeq = new TickSeqMap(512);
  const sentTick = new Int32Array(512).fill(-1);
  const sentAt = new Float64Array(512);
  const script = makeMovementScript(`direct-${rttMs}`);
  const scratchUpdate = { seq: 0, tick: 0, state: createMovementState() };

  let myClientId = 0;
  let spawned = false;
  let frame = 0;
  let settling = false;
  let nowMs = 0;
  let updates = 0;
  let snapshots = 0;
  let rttSeconds = rttMs / 1000;
  let rttSamples = 0;
  const pings = new Map();

  const ownEntity = () => {
    for (const ent of reader.entities.values()) {
      if (ent.kind === ENT.PLAYER && ent.owner === myClientId) return ent;
    }
    return null;
  };

  const onSnapshot = (s) => {
    snapshots++;
    const before = reader.tick;
    if (!reader.apply(s)) return;
    if (reader.tick <= before) return;

    const ent = ownEntity();
    if (!ent) return;
    if (!spawned) {
      client.resetTo(movementStateFromEntity(ent));
      resetPredictionMetrics(client.metrics);
      spawned = true;
      return;
    }
    const seq = tickSeq.exact(s.ackInputTick);
    if (seq < 0) return;
    const predicted = client.predictor.stateAt(seq);
    if (!predicted) return;
    authoritativeUpdateFromEntity(predicted, ent, seq, s.tick, scratchUpdate);
    client.applyAuthoritative(scratchUpdate);
    updates++;
  };

  clientPort.onMessage((_from, data) => {
    const msg = jsonCodec.decode(data);
    if (msg.t === 'welcome') {
      myClientId = msg.clientId;
      // Seed the clock off the welcome before any pong has come back.
      clock.observe(msg.tick, rttSeconds);
      onSnapshot(msg.snapshot);
    } else if (msg.t === 'snapshot') {
      onSnapshot(msg.s);
    } else if (msg.t === 'pong') {
      // The host also emits UNSOLICITED pongs (keepalive) with clientMs = 0.
      // Treating one of those as a round trip measures the age of the universe,
      // so only pongs we can match to a ping we actually sent are trusted.
      const sentMs = pings.get(msg.id);
      if (sentMs === undefined || msg.clientMs <= 0) return;
      pings.delete(msg.id);
      // The only honest RTT measurement available: a round trip with no
      // simulation in the middle. Timing an input ack instead measures
      // RTT *plus* the lead we deliberately added, which feeds the lead back
      // into itself and inflates input lag until it stops converging.
      const sample = (nowMs - sentMs) / 1000;
      rttSeconds = rttSamples === 0 ? sample : rttSeconds * 0.85 + sample * 0.15;
      rttSamples++;
      clock.observe(msg.tick, rttSeconds);
    }
  });

  clientPort.send('host', jsonCodec.encode({
    t: 'join', v: PROTOCOL_VERSION, stableId: 'CLI', name: 'cli', epoch: 0,
  }), 'reliable');

  const outgoing = [];
  const RUN_TICKS = HZ * 20;
  const SETTLE_TICKS = HZ * 3;
  for (let i = 0; i < RUN_TICKS + SETTLE_TICKS; i++) {
    if (i === RUN_TICKS) settling = true;
    nowMs += TICK_MS;
    netLink.advanceTo(nowMs);
    host.advance(DT);

    const steps = clock.step(DT);
    for (let k = 0; k < steps; k++) {
      const tick = clock.next();
      const s = settling
        ? { moveX: 0, moveY: 0, yaw: SPAWN_YAW, pitch: 0, actions: [] }
        : script(frame, HZ);
      frame++;
      applyScriptedSample(s);
      client.fixedStep(DT, s.yaw, s.pitch);
      if (!haveCmd) continue;
      tickSeq.record(tick, lastCmd.seq);
      const slot = ((tick % 512) + 512) % 512;
      sentTick[slot] = tick;
      sentAt[slot] = nowMs;
      outgoing.push(toHostInput(lastCmd, tick));
      while (outgoing.length > 3) outgoing.shift();
    }
    if (i % 8 === 0) {
      pings.set(i, nowMs);
      if (pings.size > 32) pings.delete(pings.keys().next().value);
      clientPort.send('host', jsonCodec.encode({
        t: 'ping', id: i, clientMs: nowMs,
      }), 'unreliable');
    }
    if (spawned && outgoing.length > 0) {
      clientPort.send('host', jsonCodec.encode({
        t: 'input', clientId: myClientId, cmds: outgoing.map((c) => ({ ...c })),
        ackTick: reader.tick, ackCheckpoint: -1,
      }), 'unreliable');
    }
    client.updateVisual(DT);
  }
  clearScriptedInput();

  const hostState = stepper.capture(myClientId);
  const clientState = clientMovement.capture(createMovementState());
  const converged = hostState ? positionError(hostState, clientState) : Infinity;
  const m = client.metrics;

  const result = {
    rttMs,
    corrPerSec: correctionsPerSecond(m),
    meanCorr: meanCorrectionMeters(m),
    maxCorr: m.correctionMax,
    meanApplied: meanAppliedCorrectionMeters(m),
    meanErr: meanErrorMeters(m),
    replay: meanReplayDepth(m),
    corrections: m.corrections,
    updates,
    snapshots,
    predicted: m.commandsPredicted,
    emitted: clock.emitted,
    resyncs: clock.resyncs,
    rttMeasured: rttSeconds * 1000,
    starved: stepper.starvedTicks(myClientId),
    hostTicks: stepper.stats.ticksStepped,
    converged,
    seconds: (RUN_TICKS + SETTLE_TICKS) / HZ,
  };
  host.dispose();
  stepper.dispose();
  return result;
}

function testTickClock() {
  section('Slewed tick clock — direct protocol client, real PeerHost');
  for (const [rtt, jitter, loss] of [[60, 8, 0.05], [120, 8, 0.05], [200, 8, 0.05]]) {
    const r = runDirect(rtt, jitter, loss);
    console.log(
      `  RTT ${String(rtt) + 'ms'}`.padEnd(24)
      + `corr/s ${r.corrPerSec.toFixed(2).padStart(6)}`
      + ` | meanCorr ${(r.meanCorr * 100).toFixed(2).padStart(7)} cm`
      + ` | maxCorr ${(r.maxCorr * 100).toFixed(1).padStart(6)} cm`
      + ` | meanErr ${(r.meanErr * 1000).toFixed(3).padStart(7)} mm`
      + ` | replay ${r.replay.toFixed(1).padStart(5)}`,
    );
    console.log(
      ''.padEnd(24)
      + `ticks ${r.emitted} emitted / ${r.hostTicks} host`
      + ` | predicted ${r.predicted} | updates ${r.updates}/${r.snapshots}`
      + ` | starved ${r.starved} | resyncs ${r.resyncs}`
      + ` | rtt measured ${r.rttMeasured.toFixed(1)} ms`
      + ` | converged ${(r.converged * 1000).toFixed(3)} mm`,
    );
    check(r.emitted >= r.hostTicks * 0.95 && r.emitted <= r.hostTicks * 1.05,
      `RTT ${rtt}ms: the tick clock tracks the host rate`,
      `${r.emitted} client ticks vs ${r.hostTicks} host ticks`);
    check(r.starved <= r.hostTicks * 0.02,
      `RTT ${rtt}ms: the host is never starved of input`,
      `${r.starved} starved ticks of ${r.hostTicks}`);
    check(r.corrPerSec < 2,
      `RTT ${rtt}ms: corrections/second stays near zero through jitter and loss`,
      `${r.corrPerSec.toFixed(2)}/s, mean ${(r.meanCorr * 100).toFixed(2)} cm`);
    check(r.converged < 0.05,
      `RTT ${rtt}ms: client converges to host state`,
      `${(r.converged * 1000).toFixed(3)} mm < 50 mm`);
    check(Math.abs(r.rttMeasured - rtt) < Math.max(20, rtt * 0.25),
      `RTT ${rtt}ms: the client measures the round trip correctly`,
      `${r.rttMeasured.toFixed(1)} ms measured vs ${rtt} ms configured`);
  }
}

/* ----------------------------------------------------------------- run ---- */

testButtonBridge();
testStepperParity();
testLoopback();
testTickClock();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
