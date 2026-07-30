#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreCinematicEvaluation, scorePerformanceEvaluation } from './pipeline-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.AR_REPO_PATH || path.resolve(HERE, '../..'));
const loopId = process.argv[2];
const manifest = JSON.parse(await readFile(path.join(ROOT, 'autoresearch.pipeline.json'), 'utf8'));
const loop = manifest.loops?.[loopId];
if (!loop) throw new Error(`unknown autoresearch loop: ${loopId}`);

const runRoot = path.join(ROOT, 'runs', 'autoresearch', loopId);
function gitValue(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
const gitCommonDir = gitValue('rev-parse', '--path-format=absolute', '--git-common-dir');
const expectedBranch = gitValue('branch', '--show-current');
const expectedHead = gitValue('rev-parse', 'HEAD');
const baselinePath = path.join(gitCommonDir, 'autoresearch-state', loop.branch, loopId, 'baseline.json');
const trial = Number(process.env.AR_TRIAL || 0);
const dist = `dist-autoresearch-${loopId}`;
const basePort = loopId === 'performance' ? 4310 : 4320;

function run(command, args, options = {}) {
  const timeoutMs = options.timeout ?? loop.commandTimeoutSeconds * 1000;
  const result = spawnSync('timeout', [
    '--signal=TERM', '--kill-after=10s', `${Math.ceil(timeoutMs / 1000)}s`, command, ...args,
  ], {
    cwd: ROOT,
    env: { ...process.env, BLACKOUT_URL: '' },
    encoding: 'utf8',
    timeout: timeoutMs + 15000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  return result.stdout.trim();
}

async function repositoryFingerprint() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error('could not fingerprint repository before visual judging');
  const hash = createHash('sha256');
  for (const relative of listed.stdout.toString('utf8').split('\0').filter(Boolean).sort()) {
    hash.update(relative);
    hash.update('\0');
    hash.update(await readFile(path.join(ROOT, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function assertChangedPathsAllowed() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (status.status !== 0) throw new Error('could not inspect repository changes');
  const changed = status.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const raw = line.slice(3).trim();
    return raw.includes(' -> ') ? raw.split(' -> ') : [raw];
  });
  const disallowed = changed.filter((relative) => !loop.allowlist.some((allowed) => (
    allowed === '.' || relative === allowed || relative.startsWith(`${allowed}/`)
  )));
  if (disallowed.length) throw new Error(`evaluator found disallowed changed paths: ${disallowed.join(', ')}`);
  const protectedChanges = changed.filter((relative) => (loop.protectedPaths || []).some((protectedPath) => (
    relative === protectedPath || relative.startsWith(`${protectedPath}/`)
  )));
  if (protectedChanges.length) throw new Error(`evaluator found protected benchmark changes: ${protectedChanges.join(', ')}`);
}

function assertExpectedShots(rows, source) {
  const actual = [...new Set(rows.map((row) => row.shot ?? row.name))].sort();
  const expected = [...(loop.expectedShots || [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${source} shot set changed: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
  }
}

function shotIntegrity(rows) {
  const entries = rows.map((row) => [row.shot ?? row.name, row.shotDefinition ?? row.definition]);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function performanceRows() {
  run('node', [
    'tools/perf.mjs',
    '--presets', `${loop.preset},${loop.guardPreset}`,
    '--ms', String(loop.evaluator.measureMs),
    '--w', String(loop.evaluator.width),
    '--h', String(loop.evaluator.height),
    '--shots', loop.expectedShots.join(','),
    '--port', String(basePort + trial),
    '--dist', dist,
    '--no-build',
  ]);
  return readFile(path.join(ROOT, 'shots', 'perf.json'), 'utf8').then(JSON.parse);
}

function relaxedPerformanceScore(rows) {
  return scorePerformanceEvaluation(rows, { minFps: 0, maxP95Ms: Number.POSITIVE_INFINITY, maxP99Ms: Number.POSITIVE_INFINITY });
}

function guardRegression(current, baseline, maxPercent) {
  const floor = baseline * (1 - maxPercent / 100);
  return current + Number.EPSILON < floor
    ? `guard preset score ${current.toFixed(3)} regressed more than ${maxPercent}% from ${baseline.toFixed(3)}`
    : null;
}

async function evaluatePerformance() {
  const rows = await performanceRows();
  assertExpectedShots(rows, 'performance');
  const targetRows = rows.filter((row) => row.preset === loop.preset);
  const guardRows = rows.filter((row) => row.preset === loop.guardPreset);
  const target = scorePerformanceEvaluation(targetRows, loop.evaluator);
  const guard = relaxedPerformanceScore(guardRows);
  return { target, guard, integrity: { shots: shotIntegrity(rows) }, artifacts: { perf: 'shots/perf.json' } };
}

async function evaluateCinematic() {
  const label = `autoresearch-${loopId}`;
  run('node', [
    'tools/capture.mjs', '--quality', loop.preset,
    '--w', String(loop.evaluator.width), '--h', String(loop.evaluator.height),
    '--shots', loop.expectedShots.join(','),
    '--label', label, '--port', String(basePort + 100 + trial), '--dist', dist, '--no-build',
  ]);
  const capturePath = path.join(ROOT, 'shots', label, 'manifest.json');
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  assertExpectedShots(capture.shots || [], 'capture');
  const beforeJudge = await repositoryFingerprint();
  const visualRaw = run('node', ['tools/autoresearch/visual-score.mjs', capturePath, path.join(ROOT, 'docs/VISUAL-BAR.md')]);
  const afterJudge = await repositoryFingerprint();
  if (afterJudge !== beforeJudge) throw new Error('visual judge modified the repository; refusing evaluation');
  const visual = JSON.parse(visualRaw.split(/\r?\n/).filter(Boolean).at(-1));

  const rows = await performanceRows();
  assertExpectedShots(rows, 'performance');
  if (JSON.stringify(shotIntegrity(rows)) !== JSON.stringify(shotIntegrity(capture.shots || []))) {
    throw new Error('capture and performance shot definitions disagree');
  }
  const targetRows = rows.filter((row) => row.preset === loop.preset);
  const guardRows = rows.filter((row) => row.preset === loop.guardPreset);
  const targetPerf = relaxedPerformanceScore(targetRows);
  const guard = relaxedPerformanceScore(guardRows);
  const target = scoreCinematicEvaluation({
    visualScore: visual.score,
    avgFps: targetPerf.metrics.worstAvgFps,
    p95: targetPerf.metrics.worstP95Ms,
    shotCount: capture.shots.length,
    // Chromium emits a generic 404 console line for its implicit favicon request.
    // Page errors and non-benign request failures remain hard capture failures.
    errors: (capture.errors || []).filter((error) => !/^Failed to load resource:.*404 \(Not Found\)$/i.test(error)),
  }, loop.evaluator);
  target.metrics.shotScores = visual.shotScores || {};
  target.metrics.visualReason = visual.reason || '';
  return {
    target,
    guard,
    integrity: { shots: shotIntegrity(rows) },
    artifacts: { capture: path.relative(ROOT, capturePath), perf: 'shots/perf.json' },
  };
}

async function main() {
  if (expectedBranch !== loop.branch) throw new Error(`evaluator is on ${expectedBranch}, expected ${loop.branch}`);
  if (gitValue('rev-parse', 'HEAD') !== expectedHead) throw new Error('HEAD changed before evaluation');
  assertChangedPathsAllowed();
  const proposedTree = await repositoryFingerprint();
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'build', '--', '--outDir', dist]);
  const evaluation = loop.evaluator.kind === 'cinematic'
    ? await evaluateCinematic()
    : await evaluatePerformance();
  // The upstream harness checks its allowlist before evaluation and later uses
  // git add -A. Re-check here so evaluator/judge side effects cannot bypass it.
  assertChangedPathsAllowed();
  if (await repositoryFingerprint() !== proposedTree) {
    throw new Error('repository changed during evaluation; refusing to commit mixed provenance');
  }
  if (gitValue('rev-parse', 'HEAD') !== expectedHead || gitValue('branch', '--show-current') !== expectedBranch) {
    throw new Error('Git HEAD or branch changed during evaluation');
  }

  await mkdir(runRoot, { recursive: true });
  if (process.env.AR_BASELINE === '1') {
    const accepted = evaluation.target.accepted && evaluation.guard.accepted;
    if (!accepted) {
      console.log(JSON.stringify({
        score: evaluation.target.score,
        accepted: false,
        reason: `invalid baseline: ${evaluation.target.reason}; guard: ${evaluation.guard.reason}`,
        metrics: { ...evaluation.target.metrics, guardScore: evaluation.guard.score },
      }));
      process.exitCode = 1;
      return;
    }
    const baseline = {
      loop: loopId,
      branch: expectedBranch,
      head: expectedHead,
      gitCommonDir,
      measuredAt: new Date().toISOString(),
      ...evaluation,
    };
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(JSON.stringify({
      score: evaluation.target.score,
      accepted: true,
      reason: `baseline: ${evaluation.target.reason}`,
      metrics: { ...evaluation.target.metrics, guardScore: evaluation.guard.score },
    }));
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch {
    throw new Error(`missing baseline for ${loopId}; run npm run autoresearch -- baseline ${loopId}`);
  }
  const baselineIsAncestor = spawnSync('git', ['merge-base', '--is-ancestor', baseline.head || '', expectedHead], { cwd: ROOT }).status === 0;
  if (baseline.loop !== loopId || baseline.branch !== expectedBranch || !baselineIsAncestor || baseline.gitCommonDir !== gitCommonDir) {
    throw new Error('baseline identity does not match the current loop HEAD and worktree');
  }

  const failures = [];
  if (JSON.stringify(evaluation.integrity) !== JSON.stringify(baseline.integrity)) {
    failures.push('frozen shot definitions changed');
  }
  if (!evaluation.target.accepted) failures.push(evaluation.target.reason);
  if (!evaluation.guard.accepted) failures.push(`guard preset invalid: ${evaluation.guard.reason}`);
  const regression = guardRegression(
    evaluation.guard.score,
    baseline.guard.score,
    loop.evaluator.maxGuardRegressionPercent,
  );
  if (regression) failures.push(regression);
  if (evaluation.target.score < baseline.target.score + loop.minImprovement) {
    failures.push(`target score ${evaluation.target.score} did not beat baseline ${baseline.target.score} by ${loop.minImprovement}`);
  }

  console.log(JSON.stringify({
    score: evaluation.target.score,
    accepted: failures.length === 0,
    reason: failures.length ? failures.join('; ') : `${loopId} target improved with guard preset preserved`,
    metrics: {
      ...evaluation.target.metrics,
      guardScore: evaluation.guard.score,
      baselineScore: baseline.target.score,
      baselineGuardScore: baseline.guard.score,
      artifacts: evaluation.artifacts,
    },
  }));
}

main().catch((error) => {
  console.error(`[autoresearch:${loopId}] ${error.stack || error.message}`);
  process.exit(1);
});
