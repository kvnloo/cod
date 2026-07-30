#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHarnessConfig, validatePipelineManifest } from './pipeline-lib.mjs';
import { enterResourceIsolation } from './resource-isolation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const manifest = JSON.parse(await readFile(path.join(ROOT, 'autoresearch.pipeline.json'), 'utf8'));
const loops = validatePipelineManifest(manifest);
const command = process.argv[2] || 'status';
const requested = process.argv[3] || 'all';

function run(commandName, args, options = {}) {
  const timeoutMs = options.timeout ?? 3600000;
  const result = spawnSync('timeout', [
    '--signal=TERM', '--kill-after=10s', `${Math.ceil(timeoutMs / 1000)}s`, commandName, ...args,
  ], {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    timeout: timeoutMs + 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${commandName} ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result;
}

function git(...args) {
  return run('git', args).stdout.trim();
}

function commonGitDir() {
  return git('rev-parse', '--path-format=absolute', '--git-common-dir');
}

function commonRoot() {
  return path.dirname(commonGitDir());
}

function selectedLoops() {
  if (requested === 'all') return loops;
  const loop = loops.find((candidate) => candidate.id === requested);
  if (!loop) throw new Error(`unknown loop '${requested}'; choose ${loops.map((item) => item.id).join(', ')}, or all`);
  return [loop];
}

function worktreePath(loop) {
  return path.resolve(commonRoot(), manifest.worktreeRoot, loop.id);
}

function baselinePath(loop) {
  return path.join(commonGitDir(), 'autoresearch-state', loop.branch, loop.id, 'baseline.json');
}

function isolationStatePath() {
  return path.join(commonGitDir(), 'autoresearch-state', 'resource-isolation.json');
}

function isolationAuditPath(loop) {
  return path.join(commonGitDir(), 'autoresearch-state', 'resource-evidence', `${Date.now()}-${loop.id}.json`);
}

async function withResourceIsolation(loop, action) {
  const isolation = structuredClone(manifest.resourceIsolation);
  if (process.env.AR_BENCHMARK_EXCLUSIVE === '1') {
    isolation.mode = 'desktop-exclusive';
    isolation.pauseCommands = [...new Set([
      ...isolation.pauseCommands,
      ...(isolation.desktopPauseCommands || []),
      ...(isolation.exclusiveSignalPauseCommands || []),
    ])];
    isolation.signalPauseOutsideUserCgroups = true;
  }
  const release = await enterResourceIsolation(isolation, {
    statePath: isolationStatePath(),
    auditPath: isolationAuditPath(loop),
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

function requireClean() {
  const status = git('status', '--porcelain');
  if (status) throw new Error('current worktree must be clean and committed before creating loop worktrees');
}

function requireWorktreeClean(target) {
  const status = run('git', ['-C', target, 'status', '--porcelain']).stdout.trim();
  if (status) throw new Error(`loop worktree is dirty: ${target}`);
}

function verifyWorktree(loop, target) {
  const top = run('git', ['-C', target, 'rev-parse', '--show-toplevel']).stdout.trim();
  const common = run('git', ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  const branch = run('git', ['-C', target, 'branch', '--show-current']).stdout.trim();
  if (path.resolve(top) !== path.resolve(target)) throw new Error(`unexpected worktree root at ${target}: ${top}`);
  if (path.resolve(common) !== path.resolve(commonGitDir())) throw new Error(`worktree at ${target} belongs to another repository`);
  if (branch !== loop.branch) throw new Error(`worktree at ${target} is on ${branch || 'detached HEAD'}, expected ${loop.branch}`);
}

async function ensureDependencies(target) {
  if (await exists(path.join(target, 'node_modules', '.bin', 'vite'))) return;
  console.log(`[setup] installing locked npm dependencies in ${target}`);
  run('npm', ['ci'], { cwd: target, inherit: true });
}

async function setup(loop) {
  const target = worktreePath(loop);
  if (await exists(path.join(target, '.git'))) {
    verifyWorktree(loop, target);
    console.log(`[setup] ${loop.id}: ${target} already exists`);
    await ensureDependencies(target);
    return target;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const branchExists = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${loop.branch}`], { allowFailure: true }).status === 0;
  const args = branchExists
    ? ['worktree', 'add', target, loop.branch]
    : ['worktree', 'add', '-b', loop.branch, target, 'HEAD'];
  run('git', args, { inherit: true });
  verifyWorktree(loop, target);
  await ensureDependencies(target);
  console.log(`[setup] ${loop.id}: ${loop.branch} -> ${target}`);
  return target;
}

async function bootstrap() {
  // Keep the shared runtime in Git's private metadata so bootstrapping from a
  // feature worktree never dirties the primary checkout.
  const venv = path.join(commonGitDir(), 'autoresearch-venv');
  const python = path.join(venv, 'bin', 'python');
  if (!(await exists(python))) run('python3', ['-m', 'venv', venv], { inherit: true });
  run(python, ['-m', 'pip', 'install', '-r', path.join(ROOT, 'requirements-autoresearch.txt')], { inherit: true });
  run(python, ['-c', 'import hermes_autoresearch'], { inherit: true });
  console.log(`[bootstrap] harness ready: ${python}`);
}

async function baseline(loop) {
  const target = await setup(loop);
  requireWorktreeClean(target);
  const evaluator = path.join(target, 'tools/autoresearch/evaluate.mjs');
  if (!(await exists(evaluator))) throw new Error(`${loop.branch} does not contain the pipeline; commit it before setup`);
  run('node', [evaluator, loop.id], {
    cwd: target,
    env: { AR_REPO_PATH: target, AR_BASELINE: '1' },
    inherit: true,
  });
}

async function runLoop(loop) {
  const target = await setup(loop);
  requireWorktreeClean(target);
  // Re-measure the accepted HEAD before every invocation. The upstream harness
  // resets its in-memory best score on restart; this keeps restart trial 1 from
  // accepting a regression that merely beats an older baseline.
  await baseline(loop);
  const config = buildHarnessConfig(manifest, loop.id, target);
  const configPath = path.join(target, 'runs', 'autoresearch', loop.id, 'harness.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const python = process.env.AUTORESEARCH_PYTHON || path.join(commonGitDir(), 'autoresearch-venv', 'bin', 'python');
  if (!(await exists(python))) throw new Error('autoresearch harness is not installed; run npm run autoresearch -- bootstrap');
  const runTimeoutMs = ((loop.maxSeconds || 28800) + 2 * (loop.commandTimeoutSeconds || 1800) + 300) * 1000;
  run(python, ['-m', 'hermes_autoresearch.cli', '--config', configPath], {
    cwd: target,
    inherit: true,
    timeout: runTimeoutMs,
    env: {
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      // The harness creates accepted-trial commits while global Git config is
      // intentionally disabled. Give those commits a deterministic local bot
      // identity without mutating the repository or the user's configuration.
      GIT_AUTHOR_NAME: process.env.AR_GIT_NAME || 'Hermes Autoresearch',
      GIT_AUTHOR_EMAIL: process.env.AR_GIT_EMAIL || 'autoresearch@local',
      GIT_COMMITTER_NAME: process.env.AR_GIT_NAME || 'Hermes Autoresearch',
      GIT_COMMITTER_EMAIL: process.env.AR_GIT_EMAIL || 'autoresearch@local',
    },
  });
}

async function status() {
  console.log(`orchestrator: ${ROOT}`);
  console.log(`branch:       ${git('branch', '--show-current')}`);
  for (const loop of loops) {
    const target = worktreePath(loop);
    const present = await exists(path.join(target, '.git'));
    const baseline = present && await exists(baselinePath(loop));
    console.log(`${loop.id.padEnd(12)} branch=${loop.branch.padEnd(28)} worktree=${present ? target : 'not created'} baseline=${baseline ? 'ready' : 'missing'}`);
  }
}

async function main() {
  if (command === 'status') return status();
  if (command === 'bootstrap') return bootstrap();
  if (command === 'setup') {
    requireClean();
    for (const loop of selectedLoops()) await setup(loop);
    return;
  }
  if (command === 'isolation-check') {
    for (const loop of selectedLoops()) {
      await withResourceIsolation(loop, async () => console.log(`[isolation] ${loop.id}: machine is ready`));
    }
    return;
  }
  if (command === 'baseline') {
    requireClean();
    for (const loop of selectedLoops()) await baseline(loop);
    return;
  }
  if (command === 'run') {
    requireClean();
    for (const loop of selectedLoops()) await runLoop(loop);
    return;
  }
  throw new Error(`unknown command '${command}'; use status, bootstrap, setup, isolation-check, baseline, or run`);
}

main().catch((error) => {
  console.error(`[autoresearch] ${error.message}`);
  process.exit(1);
});
