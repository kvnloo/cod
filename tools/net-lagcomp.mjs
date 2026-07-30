#!/usr/bin/env node
/**
 * Headless verification for src/net/lagcomp.
 *
 *   node tools/net-lagcomp.mjs
 *
 * Compiles the module with tsc into node_modules/.cache/lagcomp-build, then runs
 * it for real. Nothing here is mocked: the same HitboxHistory, RewindService and
 * ShotValidator the host will use are driven by a simulated 64 Hz server with a
 * moving target and a high-ping shooter.
 *
 * The headline assertion is the one that matters: a shot that a 150 ms client
 * genuinely lined up on its own screen must HIT with rewind enabled and MISS
 * with it disabled. Everything else exists so that result cannot be an accident.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

/* Re-exec with --expose-gc so the allocation check can produce a real number. */
if (typeof globalThis.gc !== 'function' && !process.env.LAGCOMP_CHILD) {
  const r = spawnSync(process.execPath, ['--expose-gc', SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, LAGCOMP_CHILD: '1' },
  });
  process.exit(r.status ?? 1);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

const OUT = path.join(ROOT, 'node_modules', '.cache', 'lagcomp-build');
mkdirSync(OUT, { recursive: true });

const tsc = spawnSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--target', 'ES2022',
  '--module', 'ESNext',
  '--moduleResolution', 'bundler',
  '--strict',
  '--skipLibCheck',
  '--ignoreConfig',
  '--outDir', OUT,
  '--rootDir', path.join(ROOT, 'src'),
  path.join(ROOT, 'src', 'net', 'lagcomp', 'index.ts'),
  path.join(ROOT, 'src', 'core', 'Rand.ts'),
], { cwd: ROOT, encoding: 'utf8' });

if (tsc.status !== 0) {
  console.error(tsc.stdout || '');
  console.error(tsc.stderr || '');
  console.error('FAIL  tsc could not build src/net/lagcomp');
  process.exit(1);
}

/* tsc emits bundler-style extensionless specifiers; Node ESM needs .js. */
function fixup(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { fixup(p); continue; }
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(p, 'utf8');
    const out = src.replace(/(from\s*['"])(\.\.?\/[^'"]+)(['"])/g,
      (m, a, spec, c) => (spec.endsWith('.js') ? m : a + spec + '.js' + c));
    if (out !== src) writeFileSync(p, out);
  }
}
fixup(OUT);

const lc = await import(pathToFileURL(path.join(OUT, 'net', 'lagcomp', 'index.js')).href);
const { Rand } = await import(pathToFileURL(path.join(OUT, 'core', 'Rand.js')).href);

const {
  HitboxHistory, RewindService, ShotValidator, RewindDebugRing, ShotResolution,
  HitPart, computeRewindTime, configureLagComp, resetLagCompConfig,
  lagcompConfig, describeRewind, obbCorners, OBB_EDGE_INDICES, FLOATS_PER_BOX,
} = lc;

/* ------------------------------------------------------------------ */
/* Test plumbing                                                       */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  PASS  ' + name + (detail ? '  ' + detail : '')); }
  else { failed++; failures.push(name); console.log('  FAIL  ' + name + (detail ? '  ' + detail : '')); }
}
function near(name, got, want, tol, unit = '') {
  const d = Math.abs(got - want);
  check(name, d <= tol,
    'got=' + got.toFixed(4) + unit + ' want=' + want.toFixed(4) + unit + ' delta=' + d.toFixed(5));
}
function section(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

/* ------------------------------------------------------------------ */
/* Simulated world                                                     */
/* ------------------------------------------------------------------ */

const TICK_HZ = 64;
const DT = 1 / TICK_HZ;
const rand = new Rand('lagcomp-verify');

/** Ground-truth target motion: a sprint across the shooter's view plus strafe. */
function targetState(t) {
  return {
    x: -4 + 5.5 * t + 0.35 * Math.sin(7 * t),
    y: 0,
    z: 20 + 0.4 * Math.sin(2.1 * t),
    yaw: 0.3 * Math.sin(1.7 * t),
  };
}

/** A 13-box humanoid: [partId, offX, offY, offZ, halfX, halfY, halfZ]. */
const RIG = [
  [HitPart.Head, 0, 1.70, 0, 0.10, 0.12, 0.10],
  [HitPart.Neck, 0, 1.55, 0, 0.06, 0.05, 0.06],
  [HitPart.Chest, 0, 1.30, 0, 0.22, 0.20, 0.14],
  [HitPart.Stomach, 0, 1.05, 0, 0.18, 0.12, 0.12],
  [HitPart.Pelvis, 0, 0.90, 0, 0.18, 0.10, 0.13],
  [HitPart.UpperArmL, -0.30, 1.30, 0, 0.07, 0.18, 0.07],
  [HitPart.UpperArmR, 0.30, 1.30, 0, 0.07, 0.18, 0.07],
  [HitPart.ForearmL, -0.32, 0.98, 0, 0.06, 0.16, 0.06],
  [HitPart.ForearmR, 0.32, 0.98, 0, 0.06, 0.16, 0.06],
  [HitPart.ThighL, -0.11, 0.62, 0, 0.09, 0.22, 0.10],
  [HitPart.ThighR, 0.11, 0.62, 0, 0.09, 0.22, 0.10],
  [HitPart.ShinL, -0.11, 0.22, 0, 0.07, 0.20, 0.08],
  [HitPart.ShinR, 0.11, 0.22, 0, 0.07, 0.20, 0.08],
];
const CHEST_INDEX = 2;
const CHEST_Y = 1.30;

/* Flattened rig, so the timed loops in section 9 measure the library and not
 * this file's own array destructuring. */
const RIG_PART = new Uint8Array(RIG.length);
const RIG_OFF = new Float64Array(RIG.length * 3);
const RIG_HALF = new Float64Array(RIG.length * 3);
for (let i = 0; i < RIG.length; i++) {
  const r = RIG[i];
  RIG_PART[i] = r[0];
  RIG_OFF[i * 3] = r[1]; RIG_OFF[i * 3 + 1] = r[2]; RIG_OFF[i * 3 + 2] = r[3];
  RIG_HALF[i * 3] = r[4]; RIG_HALF[i * 3 + 1] = r[5]; RIG_HALF[i * 3 + 2] = r[6];
}

function writeRigFast(history, slot, x, y, z, yaw) {
  const qy = Math.sin(yaw * 0.5), qw = Math.cos(yaw * 0.5);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  for (let i = 0; i < RIG_PART.length; i++) {
    const o = i * 3;
    const ox = RIG_OFF[o], oy = RIG_OFF[o + 1], oz = RIG_OFF[o + 2];
    // rotate the local offset by yaw around +Y
    const rx = ox * c + oz * sn;
    const rz = -ox * sn + oz * c;
    history.writeBox(slot, i, RIG_PART[i],
      x + rx, y + oy, z + rz,
      RIG_HALF[o], RIG_HALF[o + 1], RIG_HALF[o + 2],
      0, qy, 0, qw);
  }
  history.commitPlayer(slot, RIG_PART.length, true);
}

function writeRig(history, slot, s) {
  writeRigFast(history, slot, s.x, s.y, s.z, s.yaw);
}

/** Where the shooter's client draws the target's chest at `renderTime`. */
function seenChest(t) {
  const s = targetState(t);
  return { x: s.x, y: CHEST_Y, z: s.z };
}

const MUZZLE = { x: 0, y: 1.55, z: 0 };

function aimAt(p) {
  const dx = p.x - MUZZLE.x, dy = p.y - MUZZLE.y, dz = p.z - MUZZLE.z;
  const l = Math.hypot(dx, dy, dz);
  return { x: dx / l, y: dy / l, z: dz / l };
}

const SHOOTER_ID = 7;
const TARGET_ID = 11;

/** Build a history filled with `seconds` of simulation, with jittered tick times. */
function buildWorld(seconds, opts = {}) {
  const history = new HitboxHistory({
    maxPlayers: opts.maxPlayers ?? 8,
    maxBoxes: 18,
    tickRateHz: TICK_HZ,
    historySeconds: opts.historySeconds ?? 1.0,
  });
  const shooterSlot = history.acquireSlot(SHOOTER_ID);
  const targetSlot = history.acquireSlot(TARGET_ID);
  const ticks = Math.round(seconds / DT);
  let time = 0;
  for (let tick = 0; tick <= ticks; tick++) {
    // Real hosts do not tick on perfectly even boundaries; jitter proves the
    // sampler works off recorded timestamps rather than assuming a grid.
    time = tick * DT + rand.range(0, 0.0009);
    history.beginTick(tick, time);
    writeRig(history, shooterSlot, { x: 0, y: 0, z: 0, yaw: 0 });
    writeRig(history, targetSlot, targetState(time));
  }
  return { history, shooterSlot, targetSlot, lastTime: time, lastTick: ticks };
}

/* ================================================================== */
console.log('lag compensation verification');
console.log('server tick ' + TICK_HZ + ' Hz, target sprinting at ~5.5 m/s across the shooter at ~20 m');

/* ------------------------------------------------------------------ */
section('1. the rewind formula');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
{
  // With a client command stamp only the downstream leg is unaccounted for.
  const p = computeRewindTime(
    { serverTimeSec: 10.05, commandServerTimeSec: 10.0, rttMs: 120, interpDelayMs: 100 },
    lagcompConfig,
  );
  near('stamped: renderTime = C - rtt/2 - interp', p.renderTimeSec, 10.0 - 0.060 - 0.100, 1e-9, 's');
  near('stamped: rtt term is half of rtt', p.rttTermMs, 60, 1e-9, 'ms');
  check('stamped: usedCommandStamp', p.usedCommandStamp === true);
  near('stamped: age vs server now', p.ageMs, 210, 1e-6, 'ms');

  // Without a stamp both legs must come off.
  const q = computeRewindTime(
    { serverTimeSec: 10.0, rttMs: 120, interpDelayMs: 100 },
    lagcompConfig,
  );
  near('unstamped: renderTime = S - rtt - interp', q.renderTimeSec, 10.0 - 0.120 - 0.100, 1e-9, 's');
  near('unstamped: rtt term is the whole rtt', q.rttTermMs, 120, 1e-9, 'ms');

  // Hostile inputs get clamped, not believed.
  const r = computeRewindTime(
    { serverTimeSec: 10.0, commandServerTimeSec: 10.0, rttMs: 9000, interpDelayMs: 5000 },
    lagcompConfig,
  );
  near('clamped: rtt term capped by maxRttMs*fraction', r.rttTermMs, 200, 1e-9, 'ms');
  near('clamped: interp capped by maxInterpDelayMs', r.interpTermMs, 200, 1e-9, 'ms');
  near('clamped: age capped at maxRewindMs', r.ageMs, 250, 1e-6, 'ms');
  check('clamped: reason is stale', r.reason === 'stale', 'reason=' + r.reason);

  // A command stamped in the future is refused, not honoured.
  const f = computeRewindTime(
    { serverTimeSec: 10.0, commandServerTimeSec: 10.5, rttMs: 0, interpDelayMs: 0 },
    lagcompConfig,
  );
  check('future stamp flagged', f.reason === 'future', 'reason=' + f.reason);

  // Disabled ⇒ present time, no rewind at all.
  configureLagComp({ enabled: false });
  const d = computeRewindTime(
    { serverTimeSec: 10.0, commandServerTimeSec: 10.0, rttMs: 200, interpDelayMs: 100 },
    lagcompConfig,
  );
  check('disabled: resolves at present time', d.renderTimeSec === 10.0 && d.compensated === false);
  resetLagCompConfig();
}

/* ------------------------------------------------------------------ */
section('2. history ring: bounds, interpolation, slot reuse');
/* ------------------------------------------------------------------ */
{
  const h = new HitboxHistory({ maxPlayers: 24, maxBoxes: 18, tickRateHz: 64, historySeconds: 1.0 });
  console.log('  ring: ' + h.capacity + ' ticks x ' + h.maxPlayers + ' players x '
    + h.maxBoxes + ' boxes = ' + (h.bytes / 1048576).toFixed(2) + ' MB, window '
    + h.windowSeconds.toFixed(3) + ' s');
  check('memory is bounded under 2 MB at 24 players', h.bytes < 2 * 1048576,
    (h.bytes / 1048576).toFixed(2) + ' MB');

  const slot = h.acquireSlot(1);
  const bytesBefore = h.bytes;
  // Ten seconds into a one-second ring.
  for (let tick = 0; tick <= 640; tick++) {
    h.beginTick(tick, tick * DT);
    writeRig(h, slot, targetState(tick * DT));
  }
  check('memory constant after 10x the window', h.bytes === bytesBefore, h.bytes + ' bytes');
  check('oldest tick evicted correctly',
    h.oldestValidTick === 640 - h.capacity + 1,
    'oldest=' + h.oldestValidTick + ' newest=' + h.newestTick);

  const buf = new Float32Array(18 * FLOATS_PER_BOX);
  check('sampling 2 s in the past finds nothing usable at that time',
    h.sampleInto(slot, 640 * DT - 2.0, buf, null, 0, 0, true) > 0 && h.lastSampleClamped === true,
    'clamped to the oldest tick rather than fabricating a pose');

  // Interpolation accuracy against ground truth, mid-tick.
  let maxErrInterp = 0, maxErrSnap = 0;
  for (let i = 0; i < 400; i++) {
    const t = (600 + rand.next() * 30) * DT;
    const truth = targetState(t);
    h.sampleInto(slot, t, buf, null, 0, 0, true);
    maxErrInterp = Math.max(maxErrInterp, Math.hypot(buf[0] - truth.x, buf[2] - truth.z));
    h.sampleInto(slot, t, buf, null, 0, 0, false);
    maxErrSnap = Math.max(maxErrSnap, Math.hypot(buf[0] - truth.x, buf[2] - truth.z));
  }
  console.log('  reconstruction error vs ground truth: interpolated '
    + (maxErrInterp * 1000).toFixed(1) + ' mm, snapped ' + (maxErrSnap * 1000).toFixed(1) + ' mm');
  check('interpolation beats snapping to the nearest tick', maxErrInterp < maxErrSnap * 0.5);
  check('interpolated reconstruction is sub-centimetre', maxErrInterp < 0.01,
    (maxErrInterp * 1000).toFixed(2) + ' mm');

  // Slot reuse must not leak the previous occupant's past.
  h.releaseSlot(1);
  const reused = h.acquireSlot(99);
  check('reused slot is the same index', reused === slot);
  check('reused slot has no inherited history',
    h.sampleInto(reused, 630 * DT, buf, null, 0, 0, true) === -1);
}

/* ------------------------------------------------------------------ */
section('3. THE HEADLINE: high-ping client shoots a sprinting target');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
configureLagComp({ debug: true });
let headlineRewindM = 0;
{
  const dbg = new RewindDebugRing({ capacity: 8, maxTargets: 4, maxBoxes: 18 });
  const { history } = buildWorld(1.6);
  const svc = new RewindService(history, { debug: dbg });

  const S = 1.30;              // server time the fire command is processed at
  const RTT = 150;             // ms, host-measured
  const INTERP = 100;          // ms, the client's snapshot interpolation delay
  const C = S - RTT / 2000;    // client stamped the command half an RTT ago

  const renderTime = C - RTT / 2000 - INTERP / 1000;
  const seen = seenChest(renderTime);
  const now = seenChest(S);
  const dir = aimAt(seen);

  console.log('  shooter rtt=' + RTT + 'ms interp=' + INTERP + 'ms'
    + '  ->  rewind ' + ((S - renderTime) * 1000).toFixed(1) + ' ms');
  console.log('  target chest as the client saw it: x=' + seen.x.toFixed(3) + ' z=' + seen.z.toFixed(3));
  console.log('  target chest right now:            x=' + now.x.toFixed(3) + ' z=' + now.z.toFixed(3));
  console.log('  separation: ' + Math.hypot(now.x - seen.x, now.z - seen.z).toFixed(3) + ' m');

  const req = {
    shooterId: SHOOTER_ID, weaponSlot: 0, fireIntervalSec: 0.086, sequence: 1,
    serverTimeSec: S, commandServerTimeSec: C, rttMs: RTT, interpDelayMs: INTERP,
    origin: MUZZLE, direction: dir, maxDistanceM: 200,
    serverOrigin: MUZZLE, serverAim: dir,
  };

  const hit = new ShotResolution();
  svc.resolveShot(req, hit);
  headlineRewindM = hit.rewindDistanceM;
  console.log('  ' + describeRewind(dbg.latest()));
  check('rewind ON: the shot registers', hit.valid && hit.hit,
    'valid=' + hit.valid + ' hit=' + hit.hit + ' reason=' + hit.reason);
  check('rewind ON: it hits the player the client aimed at', hit.playerId === TARGET_ID,
    'playerId=' + hit.playerId + ' part=' + hit.partName);
  console.log('  >>> REWIND DISTANCE: ' + hit.rewindDistanceM.toFixed(3)
    + ' m  (the hitbox had moved that far by the time the shot arrived)');
  check('rewind distance is a real displacement, not noise', hit.rewindDistanceM > 0.5,
    hit.rewindDistanceM.toFixed(3) + ' m');
  // Total unlag from server-now = upstream (S - C) + downstream (rtt/2) + interp.
  near('rewind age matches the formula', hit.rewindMs, RTT + INTERP, 1e-6, 'ms');

  // Same shot, feature off.
  configureLagComp({ enabled: false });
  const svc2 = new RewindService(history, { validator: new ShotValidator(history.maxPlayers) });
  const miss = new ShotResolution();
  svc2.resolveShot({ ...req, sequence: 2 }, miss);
  check('rewind OFF: the identical shot misses', miss.valid && !miss.hit,
    'valid=' + miss.valid + ' hit=' + miss.hit + ' reason=' + miss.reason);
  configureLagComp({ enabled: true });

  // Static geometry still wins: a wall at 10 m must eat the bullet.
  const blocked = new ShotResolution();
  svc.resolveShot({ ...req, sequence: 3, worldOcclusionDistanceM: 10 }, blocked);
  check('a wall in front of the target blocks the rewound hit',
    blocked.valid && !blocked.hit && blocked.blockedByWorld,
    'valid=' + blocked.valid + ' hit=' + blocked.hit + ' blockedByWorld=' + blocked.blockedByWorld);
}

/* ------------------------------------------------------------------ */
section('4. ping sweep: hit/miss with and without compensation');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
{
  const { history } = buildWorld(1.6);
  const svcOn = new RewindService(history, { validator: new ShotValidator(history.maxPlayers) });
  const S = 1.30;
  const INTERP = 100;
  console.log('   rtt   rewind    separation   comp ON   comp OFF   part');
  let seq = 100;
  let onHits = 0, offHits = 0, staleRejects = 0;
  const resOn = new ShotResolution();
  const resOff = new ShotResolution();
  for (const RTT of [0, 40, 80, 120, 160, 180, 280, 400]) {
    const C = S - RTT / 2000;
    const renderTime = C - RTT / 2000 - INTERP / 1000;
    const seen = seenChest(renderTime);
    const now = seenChest(S);
    const sep = Math.hypot(now.x - seen.x, now.z - seen.z);
    const dir = aimAt(seen);
    const base = {
      shooterId: SHOOTER_ID, weaponSlot: 0, fireIntervalSec: 0, sequence: seq++,
      serverTimeSec: S, commandServerTimeSec: C, rttMs: RTT, interpDelayMs: INTERP,
      origin: MUZZLE, direction: dir, maxDistanceM: 200,
      serverOrigin: MUZZLE, serverAim: dir,
    };

    configureLagComp({ enabled: true });
    svcOn.resolveShot(base, resOn);
    configureLagComp({ enabled: false });
    svcOn.resolveShot({ ...base, sequence: seq++ }, resOff);
    configureLagComp({ enabled: true });

    if (resOn.hit) onHits++;
    if (resOff.hit) offHits++;
    if (resOn.reason === 'stale') staleRejects++;

    console.log('  ' + String(RTT).padStart(4) + 'ms'
      + String((RTT + INTERP).toFixed(0)).padStart(8) + 'ms'
      + sep.toFixed(3).padStart(12) + 'm'
      + (resOn.hit ? '       HIT' : (resOn.valid ? '      miss' : '  ' + resOn.reason.padStart(8)))
      + (resOff.hit ? '       HIT' : '       miss')
      + '   ' + (resOn.hit ? resOn.partName : '-'));
  }
  check('compensation lands every shot inside the legal rewind window', onHits === 6,
    onHits + '/6 in-window shots landed');
  check('without compensation only the zero-latency graze lands', offHits === 1,
    offHits + '/8');
  check('shots asking to rewind past the cap are rejected, not silently accepted',
    staleRejects === 2, staleRejects + ' of 2 out-of-window shots refused');
}

/* ------------------------------------------------------------------ */
section('5. validation: a client is not trusted');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
{
  const { history } = buildWorld(1.6);
  const svc = new RewindService(history, { validator: new ShotValidator(history.maxPlayers) });
  const S = 1.30;
  const seen = seenChest(S - 0.175);
  const dir = aimAt(seen);
  const ok = {
    shooterId: SHOOTER_ID, weaponSlot: 0, fireIntervalSec: 0, sequence: 1,
    serverTimeSec: S, commandServerTimeSec: S - 0.075, rttMs: 150, interpDelayMs: 100,
    origin: MUZZLE, direction: dir, maxDistanceM: 200,
    serverOrigin: MUZZLE, serverAim: dir,
  };
  check('control: the honest shot is accepted', svc.resolveShot(ok).valid);

  // Aim divergence: claim a ray 45 degrees off the replicated aim.
  const c = Math.cos(0.785), s = Math.sin(0.785);
  const bent = { x: dir.x * c - dir.z * s, y: dir.y, z: dir.x * s + dir.z * c };
  const r1 = svc.resolveShot({ ...ok, sequence: 2, direction: bent });
  check('aim wildly off the replicated aim is refused', r1.reason === 'aim-divergence', 'reason=' + r1.reason);

  // Origin divergence: claim a muzzle 6 m from where the server says you are.
  const r2 = svc.resolveShot({ ...ok, sequence: 3, origin: { x: 6, y: 1.55, z: 0 } });
  check('muzzle teleport is refused', r2.reason === 'origin-divergence', 'reason=' + r2.reason);

  // Stale: 900 ms of claimed latency.
  const r3 = svc.resolveShot({ ...ok, sequence: 4, rttMs: 900, interpDelayMs: 200 });
  check('rewind beyond maxRewindMs is refused', r3.reason === 'stale', 'reason=' + r3.reason);

  // Future: command stamped ahead of the server clock.
  const r4 = svc.resolveShot({ ...ok, sequence: 5, commandServerTimeSec: S + 0.4 });
  check('command stamped in the future is refused', r4.reason === 'future', 'reason=' + r4.reason);

  // Replay: sequence 1 was accepted and committed by the control shot above.
  const r5 = svc.resolveShot({ ...ok, sequence: 1 });
  check('replayed sequence number is refused', r5.reason === 'duplicate', 'reason=' + r5.reason);

  // Absurd range.
  const r6 = svc.resolveShot({ ...ok, sequence: 7, maxDistanceM: 9000 });
  check('absurd claimed range is refused', r6.reason === 'range', 'reason=' + r6.reason);

  // Garbage.
  const r7 = svc.resolveShot({ ...ok, sequence: 8, direction: { x: 0, y: 0, z: 0 } });
  check('zero-length aim is refused', r7.reason === 'bad-input', 'reason=' + r7.reason);

  const shooterSlot = history.slotOf(SHOOTER_ID);
  console.log('  rejection counters for the shooter: '
    + ['aim-divergence', 'origin-divergence', 'stale', 'future', 'duplicate', 'range', 'bad-input']
      .map((k) => k + '=' + svc.validator.rejections(shooterSlot, k)).join(' '));
  check('every rejection was counted against the player',
    svc.validator.totalRejections('aim-divergence') === 1
    && svc.validator.totalRejections('duplicate') === 1
    && svc.validator.totalRejections('stale') === 1);
}

/* ------------------------------------------------------------------ */
section('6. fire-rate limiting');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
{
  const { history } = buildWorld(1.6);
  const svc = new RewindService(history, { validator: new ShotValidator(history.maxPlayers) });
  const dir = aimAt(seenChest(1.2));
  const FIRE_INTERVAL = 0.086;   // ~700 RPM

  // Honest: one shot per fire interval for a second.
  let accepted = 0, rejected = 0, seq = 1;
  for (let i = 0; i < 12; i++) {
    const t = 1.30 + i * FIRE_INTERVAL;
    const r = svc.resolveShot({
      shooterId: SHOOTER_ID, weaponSlot: 0, fireIntervalSec: FIRE_INTERVAL, sequence: seq++,
      serverTimeSec: t, commandServerTimeSec: t, rttMs: 60, interpDelayMs: 100,
      origin: MUZZLE, direction: dir, maxDistanceM: 200, serverOrigin: MUZZLE, serverAim: dir,
    });
    if (r.valid) accepted++; else rejected++;
  }
  check('an honest full-rate shooter is never rate-limited', accepted === 12 && rejected === 0,
    accepted + ' accepted, ' + rejected + ' rejected');

  // Cheating: 60 shots in the same instant.
  const v2 = new ShotValidator(history.maxPlayers);
  const svc2 = new RewindService(history, { validator: v2 });
  let a2 = 0, r2 = 0;
  for (let i = 0; i < 60; i++) {
    const r = svc2.resolveShot({
      shooterId: SHOOTER_ID, weaponSlot: 0, fireIntervalSec: FIRE_INTERVAL, sequence: 1000 + i,
      serverTimeSec: 1.30, commandServerTimeSec: 1.30, rttMs: 60, interpDelayMs: 100,
      origin: MUZZLE, direction: dir, maxDistanceM: 200, serverOrigin: MUZZLE, serverAim: dir,
    });
    if (r.valid) a2++; else r2++;
  }
  check('a macro dumping 60 shots at once is cut to the burst allowance',
    a2 === lagcompConfig.rateLimitBurst && r2 === 60 - lagcompConfig.rateLimitBurst,
    a2 + ' accepted (burst=' + lagcompConfig.rateLimitBurst + '), ' + r2 + ' rejected');
}

/* ------------------------------------------------------------------ */
section('7. auditing a semi-trusted peer host');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
{
  const { history } = buildWorld(1.6);
  const validator = new ShotValidator(history.maxPlayers);
  const S = 1.30, renderTime = S - 0.175;
  const truth = seenChest(renderTime);

  const good = validator.auditHostClaim({
    victimId: TARGET_ID,
    point: { x: truth.x + 0.05, y: truth.y, z: truth.z - 0.12 },
    claimedRenderTimeSec: renderTime, serverTimeSec: S,
  }, history);
  check('a plausible host claim is accepted', good.ok,
    'overshoot=' + good.overshootM.toFixed(3) + 'm age=' + good.ageMs.toFixed(0) + 'ms');

  const bad = validator.auditHostClaim({
    victimId: TARGET_ID,
    point: { x: truth.x + 4.0, y: 1.30, z: truth.z },
    claimedRenderTimeSec: renderTime, serverTimeSec: S,
  }, history);
  check('a host claiming a hit 4 m off the victim is caught', !bad.ok,
    'reason=' + bad.reason + ' overshoot=' + bad.overshootM.toFixed(3) + 'm');

  const old = validator.auditHostClaim({
    victimId: TARGET_ID, point: { x: truth.x, y: truth.y, z: truth.z },
    claimedRenderTimeSec: S - 0.9, serverTimeSec: S,
  }, history);
  check('a host rewinding further than the rules allow is caught', !old.ok && old.reason === 'stale',
    'reason=' + old.reason);
}

/* ------------------------------------------------------------------ */
section('8. debug capture for the future debug scene');
/* ------------------------------------------------------------------ */
resetLagCompConfig();
configureLagComp({ debug: true });
{
  const dbg = new RewindDebugRing({ capacity: 4, maxTargets: 4, maxBoxes: 18 });
  const { history } = buildWorld(1.6);
  const svc = new RewindService(history, { debug: dbg, validator: new ShotValidator(history.maxPlayers) });
  const S = 1.30, C = S - 0.075;
  const seen = seenChest(C - 0.075 - 0.1);
  const dir = aimAt(seen);
  for (let i = 0; i < 6; i++) {
    svc.resolveShot({
      shooterId: SHOOTER_ID, weaponSlot: 0, fireIntervalSec: 0, sequence: i + 1,
      serverTimeSec: S, commandServerTimeSec: C, rttMs: 150, interpDelayMs: 100,
      origin: MUZZLE, direction: dir, maxDistanceM: 200, serverOrigin: MUZZLE, serverAim: dir,
    });
  }
  check('debug ring stays bounded', dbg.size === 4, 'size=' + dbg.size + ' capacity=' + dbg.capacity);
  const rec = dbg.latest();
  check('the record carries both poses for every candidate', rec.targetCount >= 1
    && rec.targets[0].boxCount === RIG.length,
    'candidates=' + rec.targetCount + ' boxes=' + rec.targets[0].boxCount);

  const t0 = rec.targets.find((t) => t.playerId === TARGET_ID);
  const dxr = t0.rewound[CHEST_INDEX * FLOATS_PER_BOX] - t0.present[CHEST_INDEX * FLOATS_PER_BOX];
  check('rewound and present poses genuinely differ', Math.abs(dxr) > 0.5,
    'chest moved ' + Math.abs(dxr).toFixed(3) + ' m in x');

  const corners = new Float32Array(24);
  obbCorners(t0.rewound, CHEST_INDEX * FLOATS_PER_BOX, corners, 0);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 8; i++) { minX = Math.min(minX, corners[i * 3]); maxX = Math.max(maxX, corners[i * 3]); }
  check('obbCorners produces a drawable box', (maxX - minX) > 0.3 && OBB_EDGE_INDICES.length === 24,
    'width=' + (maxX - minX).toFixed(3) + 'm edges=' + (OBB_EDGE_INDICES.length / 2));
  console.log('  ' + describeRewind(rec));
}
resetLagCompConfig();

/* ------------------------------------------------------------------ */
section('9. steady-state cost');
/* ------------------------------------------------------------------ */
{
  const PLAYERS = 16;
  const history = new HitboxHistory({ maxPlayers: PLAYERS, maxBoxes: 18, tickRateHz: TICK_HZ, historySeconds: 1.0 });
  const slots = new Int32Array(PLAYERS);
  for (let i = 0; i < PLAYERS; i++) slots[i] = history.acquireSlot(100 + i);

  // Precompute every pose so the timed loops measure the library, not this file.
  const REC_TICKS = 6400;
  const POSE = new Float64Array(REC_TICKS * PLAYERS * 4);
  for (let tick = 0; tick < REC_TICKS; tick++) {
    const t = tick * DT;
    for (let i = 0; i < PLAYERS; i++) {
      const s = targetState(t + i * 0.13);
      const o = (tick * PLAYERS + i) * 4;
      POSE[o] = s.x + i * 0.7 - 5; POSE[o + 1] = 0; POSE[o + 2] = s.z; POSE[o + 3] = s.yaw;
    }
  }
  const recordTick = (tick) => {
    history.beginTick(tick, tick * DT);
    for (let i = 0; i < PLAYERS; i++) {
      const o = (tick * PLAYERS + i) * 4;
      writeRigFast(history, slots[i], POSE[o], POSE[o + 1], POSE[o + 2], POSE[o + 3]);
    }
  };
  for (let tick = 0; tick <= 200; tick++) recordTick(tick);
  const svc = new RewindService(history, { validator: new ShotValidator(history.maxPlayers) });
  const dir = { x: 0, y: 0, z: 1 };
  const req = {
    shooterId: 100, weaponSlot: 0, fireIntervalSec: 0,
    serverTimeSec: 200 * DT, commandServerTimeSec: 200 * DT - 0.05,
    rttMs: 100, interpDelayMs: 100,
    origin: MUZZLE, direction: dir, maxDistanceM: 200, serverOrigin: MUZZLE, serverAim: dir,
  };

  const res = new ShotResolution();
  const N = 50000;
  for (let i = 0; i < N; i++) svc.resolveShot(req, res);   // warm up + JIT
  const settle = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };

  const before = settle();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) svc.resolveShot(req, res);
  const t1 = process.hrtime.bigint();
  const after = process.memoryUsage().heapUsed;
  const perShotUs = Number(t1 - t0) / 1000 / N;
  const bytesPerShot = (after - before) / N;
  console.log('  ' + N + ' rewound shots vs ' + PLAYERS + ' players x ' + RIG.length + ' hitboxes: '
    + perShotUs.toFixed(2) + ' us/shot, ' + bytesPerShot.toFixed(3) + ' bytes/shot heap growth');
  check('resolveShot is allocation-free in the steady state', Math.abs(bytesPerShot) < 1,
    bytesPerShot.toFixed(3) + ' bytes/shot');
  check('resolveShot is fast enough to run per bullet on a host tick', perShotUs < 60,
    perShotUs.toFixed(2) + ' us');

  // Recording cost.
  const RECORD_N = REC_TICKS - 201;
  const rb = settle();
  const r0 = process.hrtime.bigint();
  for (let tick = 201; tick < REC_TICKS; tick++) recordTick(tick);
  const r1 = process.hrtime.bigint();
  const ra = process.memoryUsage().heapUsed;
  const perTickUs = Number(r1 - r0) / 1000 / RECORD_N;
  const bytesPerTick = (ra - rb) / RECORD_N;
  console.log('  recording ' + RECORD_N + ' ticks x ' + PLAYERS + ' players: ' + perTickUs.toFixed(2)
    + ' us/tick, ' + bytesPerTick.toFixed(3) + ' bytes/tick heap growth, ring still '
    + (history.bytes / 1048576).toFixed(2) + ' MB');
  check('recording is allocation-free in the steady state', Math.abs(bytesPerTick) < 1,
    bytesPerTick.toFixed(3) + ' bytes/tick');
  check('recording fits comfortably inside a 64 Hz tick budget', perTickUs < 200,
    perTickUs.toFixed(2) + ' us of 15625 us');
  check('no writes were dropped', history.droppedWrites === 0, 'dropped=' + history.droppedWrites);
}

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(64));
console.log('rewind distance on the headline shot: ' + headlineRewindM.toFixed(3) + ' m');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
