#!/usr/bin/env node
/**
 * Determinism + memory harness for the session replay layer (killcam,
 * spectating, theater).
 *
 * Records a scripted match with `ProbeSim`, then re-simulates it from every
 * keyframe and asserts the final state hash is *identical* to the live run —
 * not close, identical. Also round-trips the replay through JSON, plans a
 * killcam and a final killcam, exercises the spectator restrictions and scrubs
 * the theater timeline, then reports what the recording costs per minute.
 *
 *   node tools/session-replay.mjs
 *   node tools/session-replay.mjs --seconds 60 --actors 8 --seed 20260730
 *   node tools/session-replay.mjs --json           # machine-readable report
 *   node tools/session-replay.mjs --no-build       # reuse the last compile
 *
 * The TypeScript core is compiled to CommonJS in a scratch directory and
 * required here, so this runs with zero browser, GPU or bundler involvement.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Scratch build lives under this agent's reserved dist dir, which .gitignore
// already covers, so verifying never leaves an untracked directory behind.
const OUT = path.join(ROOT, 'dist-s7', 'replay-build');

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const seconds = Number(flag('seconds', 60));
const actors = Number(flag('actors', 8));
const seed = Number(flag('seed', 20260730));
const asJson = has('json');

/* ------------------------------------------------------------------ build -- */

const entry = path.join(OUT, 'js', 'replay-core.mjs');

/**
 * The core is plain TypeScript with no THREE / DOM / engine imports, so it
 * bundles to a single ESM file node can import directly. Vite is already a
 * dependency; adding a second toolchain to run one test would not be.
 */
function build() {
  mkdirSync(OUT, { recursive: true });
  const cfg = path.join(OUT, 'vite.verify.mjs');
  writeFileSync(cfg, `
import { defineConfig } from 'vite';
export default defineConfig({
  root: ${JSON.stringify(ROOT)},
  logLevel: 'warn',
  configFile: false,
  build: {
    outDir: ${JSON.stringify(path.join(OUT, 'js'))},
    emptyOutDir: true,
    minify: false,
    target: 'node20',
    sourcemap: false,
    lib: {
      entry: ${JSON.stringify(path.join(ROOT, 'src/session/replay/index.ts'))},
      formats: ['es'],
      fileName: () => 'replay-core.mjs',
    },
  },
});
`);
  const r = spawnSync('npx', ['vite', 'build', '--config', cfg], {
    cwd: ROOT, stdio: 'pipe', encoding: 'utf8',
  });
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error('replay core failed to compile');
  }
}

if (!has('no-build') || !existsSync(entry)) build();

const core = await import(pathToFileURL(entry).href);

/* -------------------------------------------------------------------- run -- */

/**
 * Drives `ReplayService` the way a game actually would — record a match through
 * the facade, die, watch the killcam, fall through to spectate, then open the
 * whole thing in theater and round-trip it through a file. This is the layer
 * a caller touches, so it gets exercised rather than merely compiled.
 */
function serviceCheck() {
  const secs = 20;
  const acts = 8;
  const sd = seed ^ 0x5f5f;
  const out = { ok: false, steps: [], reason: '' };
  const step = (name, pass) => { out.steps.push({ name, pass }); return pass; };

  const auth = core.offlineAuthority(0, 0);
  const svc = new core.ReplayService(auth, {
    ...core.theaterRecorderConfig(secs + 2, acts),
    keyframeSeconds: 5, maxActors: acts, eventCapacity: 8192,
  });
  const sim = new core.ProbeSim(sd, acts);
  const script = new core.ProbeScript(sim, sd);
  svc.begin(sd, 'probe', 1);

  const frames = [];
  const ticks = Math.round(secs * core.TICK_HZ);
  for (let t = 0; t < ticks; t++) {
    svc.beforeStep(sim);
    const n = script.frames(t, frames);
    for (let i = 0; i < n; i++) { core.quantizeInPlace(frames[i]); svc.recordInput(frames[i]); }
    sim.step(t, frames.slice(0, n));
    svc.afterStep(sim);
  }
  svc.stop();

  step('recorded through the facade', svc.state().bufferedSeconds > secs * 0.9);
  step('host wrote keyframes', svc.recorder.keyframes.length >= 2);

  // Find a death to show.
  const ev = core.replayEvent();
  let victim = -1;
  for (let k = svc.recorder.events.length - 1; k >= 0; k--) {
    if (svc.recorder.events.read(k, ev) && ev.kind === 'kill' && ev.a !== ev.b) { victim = ev.b; break; }
  }
  step('found a death to show', victim >= 0);

  const shown = victim >= 0 && svc.showKillcam(victim);
  step('killcam started', shown && svc.state().mode === 'killcam');

  // Play it out; it must end itself and hand over to spectate.
  let guard = 0;
  let maxStep = 0;
  let px = svc.pose.x, py = svc.pose.y, pz = svc.pose.z;
  while (svc.state().mode === 'killcam' && guard++ < 6000) {
    svc.update(1 / 60, null);
    // The handover to spectate is a deliberate cut, so stop measuring at it;
    // what is under test is continuity *within* the killcam.
    if (svc.state().mode !== 'killcam') break;
    const d = Math.hypot(svc.pose.x - px, svc.pose.y - py, svc.pose.z - pz);
    if (d > maxStep) maxStep = d;
    px = svc.pose.x; py = svc.pose.y; pz = svc.pose.z;
  }
  step('killcam camera stayed continuous', maxStep <= 0.6);
  step('killcam handed over to spectate', svc.state().mode === 'spectate');

  // Restrictions: free camera is a post-match privilege.
  step('free camera refused while live', svc.state().canFree === false);
  auth.endMatch();
  svc.spectate();
  step('free camera allowed after match', svc.state().canFree === true);

  step('final killcam planned', svc.showFinalKillcam());
  svc.skipKillcam();

  // Theater over the live recording, then over a saved file.
  const liveOk = svc.openTheaterLive();
  const tsLive = svc.state().theater;
  step('theater opened on the live recording', liveOk && !!tsLive && tsLive.duration > secs * 0.9);
  if (tsLive) {
    svc.theater.scrubFraction(0.5);
    svc.update(1 / 60, null);
    const mid = svc.theater.state().time;
    step('theater scrubbed to the middle', Math.abs(mid - tsLive.duration / 2) < 1);
  }
  svc.closeTheater();

  const file = svc.save('service');
  const decoded = core.decodeReplay(file);
  step('saved replay decodes', decoded.ok);
  const openOk = svc.openTheater(file);
  const ts = svc.state().theater;
  step('theater opened the saved file', openOk && !!ts && ts.bookmarkCount > 0);
  step('actors visible in theater', (() => {
    svc.theater.scrubFraction(0.5);
    const buf = [];
    return svc.actorsNow(buf) > 0;
  })());
  svc.closeTheater();
  step('returned to live', svc.state().mode === 'live');

  out.ok = out.steps.every((s) => s.pass);
  return out;
}

/**
 * A killcam ring is sized in *seconds*, not in match length. Run a match four
 * times longer than the ring and prove the resident cost is identical at the
 * end to what it was once the ring first filled — and that a killcam can still
 * be planned from the tail after the head has been overwritten many times.
 */
function boundedCheck() {
  const acts = 8;
  const ringSeconds = 30;
  const matchSeconds = 120;
  const sd = seed ^ 0x1234;

  const svc = new core.ReplayService(core.offlineAuthority(0, 0), {
    ...core.defaultRecorderConfig(),
    inputSeconds: ringSeconds, snapshotSeconds: ringSeconds,
    inputActors: acts, maxActors: acts,
  });
  const sim = new core.ProbeSim(sd, acts);
  const script = new core.ProbeScript(sim, sd);
  svc.begin(sd, 'probe', 1);

  const frames = [];
  const ticks = Math.round(matchSeconds * core.TICK_HZ);
  const atFill = Math.round(ringSeconds * core.TICK_HZ);
  let bytesAtFill = 0;
  for (let t = 0; t < ticks; t++) {
    svc.beforeStep(sim);
    const n = script.frames(t, frames);
    for (let i = 0; i < n; i++) { core.quantizeInPlace(frames[i]); svc.recordInput(frames[i]); }
    sim.step(t, frames.slice(0, n));
    svc.afterStep(sim);
    if (t === atFill) bytesAtFill = svc.recorder.stats().totalBytes;
  }
  const bytesAtEnd = svc.recorder.stats().totalBytes;
  const win = svc.recorder.window();

  // A killcam from the tail must still work after the head is long gone.
  const ev = core.replayEvent();
  let victim = -1;
  for (let k = svc.recorder.events.length - 1; k >= 0; k--) {
    if (svc.recorder.events.read(k, ev) && ev.kind === 'kill' && ev.a !== ev.b) { victim = ev.b; break; }
  }
  const killcamOk = victim >= 0 && svc.showKillcam(victim);

  return {
    ringSeconds, matchSeconds,
    bytesAtFill, bytesAtEnd,
    bounded: bytesAtFill > 0 && bytesAtFill === bytesAtEnd,
    heldSeconds: win.seconds,
    windowBounded: win.seconds <= ringSeconds + 1,
    wrapped: svc.recorder.inputs.wrapped,
    killcamOk,
  };
}

const t0 = process.hrtime.bigint();
const report = core.runVerification({ seed, actors, seconds, keyframes: [] });
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

let service = { ok: false, steps: [], reason: '' };
try { service = serviceCheck(); } catch (e) { service.reason = String(e && e.stack || e); }
if (!service.ok) {
  report.pass = false;
  report.failures.push(`ReplayService: ${service.reason
    || service.steps.filter((s) => !s.pass).map((s) => s.name).join(', ')}`);
}
report.service = service;

let bounded = { bounded: false, reason: '' };
try { bounded = boundedCheck(); } catch (e) { bounded.reason = String(e && e.stack || e); }
if (!bounded.bounded || !bounded.windowBounded || !bounded.wrapped || !bounded.killcamOk) {
  report.pass = false;
  report.failures.push(`memory bound: ${bounded.reason || 'ring did not stay fixed'}`);
}
report.bounded = bounded;

if (asJson) {
  process.stdout.write(JSON.stringify({ ...report, wallMs }, null, 2) + '\n');
  process.exit(report.pass ? 0 : 1);
}

/* ----------------------------------------------------------------- report -- */

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;
const ok = (b) => (b ? 'PASS' : 'FAIL');
const pad = (s, n) => String(s).padEnd(n);

console.log('');
console.log('  session replay — determinism + killcam + theater');
console.log('  ' + '='.repeat(74));
console.log(`  match        ${report.seconds}s of ${report.actors} actors @ ${core.TICK_HZ} Hz  `
  + `(${report.ticks} ticks, seed ${report.seed})`);
console.log(`  live run     ${report.liveMs.toFixed(0)} ms  →  state hash ${report.liveHash}`);
console.log(`  events       ${report.kills} kills, ${report.shots} shots, ${report.keyframes} keyframes`);
console.log('');

/* --- determinism ------------------------------------------------------- */
console.log('  RE-SIMULATION FROM KEYFRAMES');
console.log(`  ${pad('kf', 4)}${pad('from tick', 11)}${pad('from t', 9)}`
  + `${pad('ticks', 8)}${pad('hash', 11)}${pad('ms', 8)}result`);
for (const r of report.resims) {
  console.log(
    `  ${pad(r.index, 4)}${pad(r.fromTick, 11)}${pad(r.fromTime.toFixed(1) + 's', 9)}`
    + `${pad(r.ticks, 8)}${pad(r.hash, 11)}${pad(r.ms.toFixed(0), 8)}`
    + `${ok(r.ok)}${r.ok ? '' : '  ' + r.reason}`,
  );
}
const allSame = report.resims.every((r) => r.hash === report.liveHash);
console.log(`  → ${report.resims.length} replays, `
  + `${report.resims.filter((r) => r.ok).length} exact matches of ${report.liveHash}  `
  + `[${ok(allSame && report.resims.length > 0)}]`);
console.log('');

/* --- file -------------------------------------------------------------- */
console.log('  REPLAY FILE');
console.log(`  json size            ${kb(report.file.bytes)}  `
  + `(${report.file.kbPerMinute.toFixed(0)} KB per minute of match)`);
console.log(`  round trip           ${ok(report.file.roundTrip)}`
  + (report.file.reason ? `  ${report.file.reason}` : ''));
if (report.file.resimAfterRoundTrip) {
  const r = report.file.resimAfterRoundTrip;
  console.log(`  resim after decode   ${ok(r.ok)}  hash ${r.hash} from tick ${r.fromTick}`);
}
console.log('');

/* --- memory ------------------------------------------------------------ */
const m = report.memory;
console.log('  MEMORY (resident ring buffers, fixed at construction)');
console.log(`  input      ${pad(kb(m.inputBytes), 12)} ${m.inputFrames} frames`);
console.log(`  snapshots  ${pad(kb(m.snapshotBytes), 12)} ${m.snapshotFrames} frames`);
console.log(`  keyframes  ${pad(kb(m.keyframeBytes), 12)} ${m.keyframes} states`);
console.log(`  events     ${pad(kb(m.eventBytes), 12)} ${m.events} entries`);
console.log(`  strings    ${pad(kb(m.stringBytes), 12)}`);
console.log(`  total      ${pad(mb(m.totalBytes), 12)} for a ${report.seconds}s theater recording`);
console.log(`  ---> cost  ${(report.bytesPerMinute / 1048576).toFixed(2)} MB per minute `
  + `at ${report.actors} actors (${(report.bytesPerMinute / 1024 / report.actors).toFixed(0)} KB/min/actor)`);
console.log(`       a 30 s killcam ring for 12 players costs `
  + `${((30 * core.TICK_HZ * 12 * 14) / 1048576).toFixed(2)} MB of input `
  + `+ ${((30 * 20 * 24 * 20) / 1048576).toFixed(2)} MB of snapshots`);
console.log('');

/* --- killcam ----------------------------------------------------------- */
const k = report.killcam;
console.log('  KILLCAM');
console.log(`  planned              ${ok(k.planned)}${k.reason ? '  ' + k.reason : ''}`);
console.log(`  killer → victim      actor ${k.killer} → actor ${k.victim}`
  + `  ${k.weapon}${k.headshot ? ' (headshot)' : ''} at ${k.distanceM.toFixed(1)} m`);
console.log(`  pre-roll             ${k.preRollSec.toFixed(2)} s`);
console.log(`  camera               ${k.frames} frames, ${k.cameraTravelM.toFixed(1)} m travelled, `
  + `largest single-frame step ${(k.maxStepM * 100).toFixed(1)} cm`);
console.log(`  final aim error      ${k.finalAimErrorDeg.toFixed(1)}°  `
  + `[${ok(k.finalAimErrorDeg <= 35)}]  (camera ends up looking at the body)`);
console.log(`  final killcam        ${ok(report.finalKillcam.planned)}  `
  + `${report.finalKillcam.durationSec.toFixed(1)} s${report.finalKillcam.reason ? '  ' + report.finalKillcam.reason : ''}`);
console.log('');

/* --- spectator --------------------------------------------------------- */
const s = report.spectator;
console.log('  SPECTATOR RESTRICTIONS');
console.log(`  enemy refused while live       ${ok(s.enemyRefusedWhileLive)}`);
console.log(`  free camera refused while live ${ok(s.freeRefusedWhileLive)}`);
console.log(`  killcam lock survives a cycle  ${ok(s.killcamLockHeld)}`);
console.log(`  free camera after match ends   ${ok(s.freeAllowedAfterMatch)}`);
console.log(`  teammates cycled               ${s.cycledTargets}`);
console.log('');

/* --- theater ----------------------------------------------------------- */
const th = report.theater;
console.log('  THEATER');
console.log(`  loaded               ${ok(th.loaded)}  ${th.durationSec.toFixed(1)} s timeline`);
console.log(`  bookmarks            ${th.bookmarks} (auto-generated from the event track)`);
console.log(`  scrub                ${th.scrubSamples} positions sampled  [${ok(th.scrubActorsOk)}]`);
console.log(`  reverse playback     ${ok(th.reverseOk)}`);
console.log('');

/* --- service ----------------------------------------------------------- */
console.log('  REPLAY SERVICE (the facade a game drives)');
for (const s of service.steps) console.log(`  ${pad(s.name, 38)}${ok(s.pass)}`);
if (service.reason) console.log(`  threw: ${service.reason.split('\n')[0]}`);
console.log('');

/* --- bounded ----------------------------------------------------------- */
const bd = report.bounded;
console.log('  MEMORY IS BOUNDED, NOT LOGGED');
console.log(`  ${bd.matchSeconds}s match through a ${bd.ringSeconds}s ring`);
console.log(`  resident once full   ${kb(bd.bytesAtFill)}`);
console.log(`  resident at the end  ${kb(bd.bytesAtEnd)}   [${ok(bd.bounded)}] `
  + `${bd.bounded ? 'identical — the ring overwrote, it did not grow' : 'GREW'}`);
console.log(`  history held         ${bd.heldSeconds.toFixed(1)}s  [${ok(bd.windowBounded)}]  `
  + `input ring wrapped: ${bd.wrapped}`);
console.log(`  killcam from tail    ${ok(bd.killcamOk)}  (head overwritten many times over)`);
console.log('');

console.log('  ' + '='.repeat(74));
if (report.pass) {
  console.log(`  PASS — every replay reproduced ${report.liveHash} exactly `
    + `(${wallMs.toFixed(0)} ms total)`);
} else {
  console.log(`  FAIL — ${report.failures.length} problem(s):`);
  for (const f of report.failures) console.log(`    • ${f}`);
}
console.log('');

process.exit(report.pass ? 0 : 1);
