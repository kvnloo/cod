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
const OUT = path.join(ROOT, '.replay-build');

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
      entry: ${JSON.stringify(path.join(ROOT, 'src/session/replay/core.ts'))},
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

const t0 = process.hrtime.bigint();
const report = core.runVerification({ seed, actors, seconds, keyframes: [] });
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

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
