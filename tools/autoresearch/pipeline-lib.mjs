import path from 'node:path';

const REQUIRED_LOOPS = ['performance', 'cinematic'];

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

export function validatePipelineManifest(manifest) {
  assertRecord(manifest, 'manifest');
  assertRecord(manifest.loops, 'manifest.loops');
  assertRecord(manifest.resourceIsolation, 'manifest.resourceIsolation');
  const isolation = manifest.resourceIsolation;
  if (isolation.mode !== 'remote-safe') throw new Error('resource isolation mode must be remote-safe');
  if (!Array.isArray(isolation.pauseCommands) || isolation.pauseCommands.length === 0
      || isolation.pauseCommands.some((command) => typeof command !== 'string' || !command)) {
    throw new Error('resource isolation requires non-empty pauseCommands');
  }
  if (!Array.isArray(isolation.desktopPauseCommands)
      || isolation.desktopPauseCommands.some((command) => typeof command !== 'string' || !command)) {
    throw new Error('resource isolation requires a desktopPauseCommands array');
  }
  if (!Array.isArray(isolation.exclusiveSignalPauseCommands)
      || isolation.exclusiveSignalPauseCommands.some((command) => typeof command !== 'string' || !command)) {
    throw new Error('resource isolation requires an exclusiveSignalPauseCommands array');
  }
  for (const field of ['maxCpuUtilization', 'maxGpuUtilization']) {
    const value = finiteNumber(isolation[field], `resourceIsolation.${field}`);
    if (value < 0 || value > 100) throw new Error(`resourceIsolation.${field} must be within 0..100`);
  }
  for (const field of ['quietSamples', 'sampleIntervalMs', 'maxWaitSeconds']) {
    const value = finiteNumber(isolation[field], `resourceIsolation.${field}`);
    if (!Number.isInteger(value) || value < 1) throw new Error(`resourceIsolation.${field} must be a positive integer`);
  }
  if (isolation.monitor !== true) throw new Error('resource isolation activity monitor must be enabled');
  for (const field of ['monitorIntervalMs', 'maxExternalCpuPercent', 'maxExternalGpuPercent']) {
    const value = finiteNumber(isolation[field], `resourceIsolation.${field}`);
    if (value <= 0) throw new Error(`resourceIsolation.${field} must be positive`);
  }

  for (const id of REQUIRED_LOOPS) {
    if (!manifest.loops[id]) throw new Error(`manifest requires a ${id} loop`);
  }

  const branches = new Set();
  const loops = [];
  for (const [id, loop] of Object.entries(manifest.loops)) {
    assertRecord(loop, `loop ${id}`);
    if (!loop.branch || typeof loop.branch !== 'string') throw new Error(`loop ${id} requires a branch`);
    if (branches.has(loop.branch)) throw new Error('every loop must use a unique branch');
    branches.add(loop.branch);
    if (!loop.preset || typeof loop.preset !== 'string') throw new Error(`loop ${id} requires a preset`);
    if (!loop.objective || typeof loop.objective !== 'string') throw new Error(`loop ${id} requires an objective`);
    if (!Array.isArray(loop.allowlist) || loop.allowlist.length === 0) {
      throw new Error(`loop ${id} requires a non-empty allowlist`);
    }
    if (!Array.isArray(loop.protectedPaths) || loop.protectedPaths.length === 0) {
      throw new Error(`loop ${id} requires protected benchmark paths`);
    }
    if (!Array.isArray(loop.expectedShots) || loop.expectedShots.length === 0) {
      throw new Error(`loop ${id} requires a frozen expected shot set`);
    }
    assertRecord(loop.evaluator, `loop ${id}.evaluator`);
    loops.push({ id, ...loop });
  }

  return REQUIRED_LOOPS.map((id) => loops.find((loop) => loop.id === id));
}

export function resolveWorktreePath(repoRoot, manifest, loopId) {
  const loop = validatePipelineManifest(manifest).find((candidate) => candidate.id === loopId);
  if (!loop) throw new Error(`unknown loop: ${loopId}`);
  const configuredRoot = manifest.worktreeRoot || 'worktree/autoresearch';
  const absoluteRoot = path.resolve(repoRoot, configuredRoot);
  const worktreePath = path.resolve(absoluteRoot, loopId);
  if (path.dirname(worktreePath) !== absoluteRoot) throw new Error(`unsafe loop id: ${loopId}`);
  return worktreePath;
}

export function buildHarnessConfig(manifest, loopId, repoPath) {
  const loop = validatePipelineManifest(manifest).find((candidate) => candidate.id === loopId);
  if (!loop) throw new Error(`unknown loop: ${loopId}`);
  const logRoot = `runs/autoresearch/${loopId}`;

  return {
    repo_path: path.resolve(repoPath),
    proposal_command: ['node', 'tools/autoresearch/propose.mjs', loopId],
    evaluator_command: ['node', 'tools/autoresearch/evaluate.mjs', loopId],
    max_trials: finiteNumber(loop.maxTrials ?? 10, `${loopId}.maxTrials`),
    max_seconds: loop.maxSeconds ?? null,
    stop_after_no_improve: finiteNumber(loop.stopAfterNoImprove ?? 3, `${loopId}.stopAfterNoImprove`),
    min_improvement: finiteNumber(loop.minImprovement ?? 0, `${loopId}.minImprovement`),
    target_score: loop.targetScore == null ? null : finiteNumber(loop.targetScore, `${loopId}.targetScore`),
    keep_on_improve: true,
    revert_on_no_improve: true,
    revert_on_failure: true,
    allowlist_relative_paths: [...loop.allowlist],
    tsv_log_path: `${logRoot}/experiments.tsv`,
    jsonl_log_path: `${logRoot}/experiments.jsonl`,
    command_timeout_seconds: finiteNumber(loop.commandTimeoutSeconds ?? 1800, `${loopId}.commandTimeoutSeconds`),
    log_command_output: true,
  };
}

function maxMetric(rows, key) {
  return Math.max(...rows.map((row) => finiteNumber(row[key], key)));
}

function minMetric(rows, key) {
  return Math.min(...rows.map((row) => finiteNumber(row[key], key)));
}

export function scorePerformanceEvaluation(rows, gates) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { score: 0, accepted: false, reason: 'performance evaluator produced no shot measurements', metrics: {} };
  }

  const metrics = {
    shotCount: rows.length,
    worstAvgFps: minMetric(rows, 'avgFps'),
    worstP95Ms: maxMetric(rows, 'p95'),
    worstP99Ms: maxMetric(rows, 'p99'),
    maxDrawCalls: maxMetric(rows, 'drawCalls'),
  };
  const failures = [];
  if (metrics.worstAvgFps < gates.minFps) failures.push(`fps ${metrics.worstAvgFps.toFixed(1)} < ${gates.minFps}`);
  if (metrics.worstP95Ms > gates.maxP95Ms) failures.push(`p95 ${metrics.worstP95Ms.toFixed(2)}ms > ${gates.maxP95Ms}ms`);
  if (metrics.worstP99Ms > gates.maxP99Ms) failures.push(`p99 ${metrics.worstP99Ms.toFixed(2)}ms > ${gates.maxP99Ms}ms`);

  const score = metrics.worstAvgFps - metrics.maxDrawCalls * 0.02 - metrics.worstP95Ms * 0.1;
  return {
    score: Number(score.toFixed(4)),
    accepted: failures.length === 0,
    reason: failures.length ? failures.join('; ') : 'performance gates passed',
    metrics,
  };
}

export function scoreCinematicEvaluation(evidence, gates) {
  const errors = Array.isArray(evidence.errors) ? evidence.errors : [];
  const failures = [];
  if (!Number.isFinite(evidence.visualScore)) failures.push('visual score is required');
  if (Number.isFinite(evidence.visualScore) && (evidence.visualScore < 0 || evidence.visualScore > 100)) {
    failures.push(`visual score ${evidence.visualScore} is outside 0..100`);
  }
  if (Number.isFinite(evidence.visualScore) && evidence.visualScore < gates.minVisualScore) {
    failures.push(`visual score ${evidence.visualScore} < ${gates.minVisualScore}`);
  }
  if (finiteNumber(evidence.avgFps, 'avgFps') < gates.minFps) failures.push(`fps ${evidence.avgFps} < ${gates.minFps}`);
  if (finiteNumber(evidence.p95, 'p95') > gates.maxP95Ms) failures.push(`p95 ${evidence.p95}ms > ${gates.maxP95Ms}ms`);
  if (finiteNumber(evidence.shotCount, 'shotCount') < 1) failures.push('no cinematic shots captured');
  if (errors.length) failures.push(`${errors.length} capture error(s)`);

  return {
    score: Number.isFinite(evidence.visualScore) ? Number(evidence.visualScore) : 0,
    accepted: failures.length === 0,
    reason: failures.length ? failures.join('; ') : 'cinematic quality and performance gates passed',
    metrics: {
      visualScore: evidence.visualScore,
      avgFps: evidence.avgFps,
      p95: evidence.p95,
      shotCount: evidence.shotCount,
      errors,
    },
  };
}
