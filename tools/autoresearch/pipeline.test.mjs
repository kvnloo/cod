import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHarnessConfig,
  scoreCinematicEvaluation,
  scorePerformanceEvaluation,
  validatePipelineManifest,
} from './pipeline-lib.mjs';

const manifest = {
  version: 1,
  worktreeRoot: 'worktree/autoresearch',
  resourceIsolation: {
    mode: 'remote-safe',
    pauseCommands: ['claude', 'codex'],
    desktopPauseCommands: ['Hyprland', 'sunshine'],
    exclusiveSignalPauseCommands: ['python3'],
    maxCpuUtilization: 20,
    maxGpuUtilization: 20,
    quietSamples: 3,
    sampleIntervalMs: 1000,
    maxWaitSeconds: 60,
    monitor: true,
    monitorIntervalMs: 500,
    maxExternalCpuPercent: 20,
    maxExternalGpuPercent: 5,
  },
  loops: {
    performance: {
      branch: 'autoresearch/performance',
      preset: 'low',
      objective: 'Improve frame pacing.',
      allowlist: ['src', 'tools'],
      protectedPaths: ['src/core/Capture.ts'],
      expectedShots: ['overview', 'eye-level'],
      maxTrials: 8,
      minImprovement: 0.5,
      evaluator: {
        kind: 'performance',
        minFps: 90,
        maxP95Ms: 12,
        maxP99Ms: 16.7,
      },
    },
    cinematic: {
      branch: 'autoresearch/cinematic',
      preset: 'cinematic',
      objective: 'Improve cinematic quality.',
      allowlist: ['src', 'tools'],
      protectedPaths: ['src/core/Capture.ts'],
      expectedShots: ['overview', 'eye-level'],
      maxTrials: 6,
      minImprovement: 0.25,
      targetScore: 90,
      evaluator: {
        kind: 'cinematic',
        minFps: 55,
        maxP95Ms: 22,
        minVisualScore: 70,
      },
    },
  },
};

test('validates the required independent performance and cinematic loops', () => {
  assert.deepEqual(validatePipelineManifest(manifest).map((loop) => loop.id), [
    'performance',
    'cinematic',
  ]);

  const duplicate = structuredClone(manifest);
  duplicate.loops.cinematic.branch = duplicate.loops.performance.branch;
  assert.throws(() => validatePipelineManifest(duplicate), /unique branch/);

  const unsafeIsolation = structuredClone(manifest);
  unsafeIsolation.resourceIsolation.maxGpuUtilization = 101;
  assert.throws(() => validatePipelineManifest(unsafeIsolation), /within 0\.\.100/);
});

test('builds a harness config scoped to one clean experiment worktree', () => {
  const config = buildHarnessConfig(manifest, 'performance', '/tmp/cod-performance');

  assert.equal(config.repo_path, '/tmp/cod-performance');
  assert.deepEqual(config.proposal_command, [
    'node',
    'tools/autoresearch/propose.mjs',
    'performance',
  ]);
  assert.deepEqual(config.evaluator_command, [
    'node',
    'tools/autoresearch/evaluate.mjs',
    'performance',
  ]);
  assert.deepEqual(config.allowlist_relative_paths, ['src', 'tools']);
  assert.equal(config.max_trials, 8);
  assert.equal(config.min_improvement, 0.5);
  assert.match(config.jsonl_log_path, /performance/);
  assert.match(config.tsv_log_path, /performance/);

  const cinematic = buildHarnessConfig(manifest, 'cinematic', '/tmp/cod-cinematic');
  assert.equal(cinematic.target_score, 90);
});

test('performance score rewards fps and rejects frame-time gate regressions', () => {
  const result = scorePerformanceEvaluation(
    [
      { avgFps: 144, p95: 9, p99: 12, drawCalls: 80 },
      { avgFps: 120, p95: 10, p99: 14, drawCalls: 90 },
    ],
    manifest.loops.performance.evaluator,
  );

  assert.equal(result.accepted, true);
  assert.equal(result.metrics.worstAvgFps, 120);
  assert.equal(result.metrics.worstP95Ms, 10);
  assert.ok(result.score > 100);

  const regressed = scorePerformanceEvaluation(
    [{ avgFps: 200, p95: 18, p99: 25, drawCalls: 40 }],
    manifest.loops.performance.evaluator,
  );
  assert.equal(regressed.accepted, false);
  assert.match(regressed.reason, /p95|p99/);
});

test('cinematic score requires visual evidence and preserves its fps floor', () => {
  const good = scoreCinematicEvaluation(
    { visualScore: 86, avgFps: 60, p95: 18, shotCount: 5, errors: [] },
    manifest.loops.cinematic.evaluator,
  );
  assert.equal(good.accepted, true);
  assert.equal(good.score, 86);

  const noJudge = scoreCinematicEvaluation(
    { visualScore: null, avgFps: 80, p95: 12, shotCount: 5, errors: [] },
    manifest.loops.cinematic.evaluator,
  );
  assert.equal(noJudge.accepted, false);
  assert.match(noJudge.reason, /visual score/i);

  const slow = scoreCinematicEvaluation(
    { visualScore: 95, avgFps: 42, p95: 28, shotCount: 5, errors: [] },
    manifest.loops.cinematic.evaluator,
  );
  assert.equal(slow.accepted, false);
  assert.match(slow.reason, /fps|p95/);

  const invalidJudge = scoreCinematicEvaluation(
    { visualScore: 101, avgFps: 60, p95: 18, shotCount: 5, errors: [] },
    manifest.loops.cinematic.evaluator,
  );
  assert.equal(invalidJudge.accepted, false);
  assert.match(invalidJudge.reason, /0\.\.100/);
});
