#!/usr/bin/env node
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const loopId = process.argv[2];
const repoPath = path.resolve(process.env.AR_REPO_PATH || ROOT);
const manifest = JSON.parse(await readFile(path.join(repoPath, 'autoresearch.pipeline.json'), 'utf8'));
const loop = manifest.loops?.[loopId];
if (!loop) throw new Error(`unknown autoresearch loop: ${loopId}`);

function gitAt(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout.trim();
}

function git(...args) {
  return gitAt(repoPath, ...args);
}

async function hashFile(file) {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  catch { return 'missing'; }
}

function changedPaths(cwd) {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not inspect proposal changes: ${result.stderr?.trim() || 'git status failed'}`);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const raw = line.slice(3).trim();
      return raw.includes(' -> ') ? raw.split(' -> ') : [raw];
    });
}

function isAllowed(relative) {
  return loop.allowlist.some((allowed) => (
    allowed === '.' || relative === allowed || relative.startsWith(`${allowed}/`)
  ));
}

function isProtected(relative) {
  return (loop.protectedPaths || []).some((protectedPath) => (
    relative === protectedPath || relative.startsWith(`${protectedPath}/`)
  ));
}

async function collectFiles(root, relative, output = new Map()) {
  const absolute = path.join(root, relative);
  let stat;
  try { stat = await lstat(absolute); } catch { return output; }
  if (stat.isSymbolicLink()) throw new Error(`symlinks are forbidden in proposal paths: ${relative}`);
  if (stat.isDirectory()) {
    for (const entry of await readdir(absolute)) await collectFiles(root, path.join(relative, entry), output);
    return output;
  }
  if (!stat.isFile()) throw new Error(`unsupported proposal file type: ${relative}`);
  output.set(relative, {
    hash: createHash('sha256').update(await readFile(absolute)).digest('hex'),
    // Git preserves only the executable bit, not host umask-specific 0600/0644.
    mode: stat.mode & 0o111 ? 0o755 : 0o644,
  });
  return output;
}

async function applySandboxChanges(sandbox) {
  const visibleChanges = changedPaths(sandbox);
  const disallowed = visibleChanges.filter((relative) => !isAllowed(relative));
  if (disallowed.length) throw new Error(`proposal changed disallowed paths: ${disallowed.join(', ')}`);

  const realFiles = new Map();
  const sandboxFiles = new Map();
  for (const allowed of loop.allowlist) {
    await collectFiles(repoPath, allowed, realFiles);
    await collectFiles(sandbox, allowed, sandboxFiles);
  }
  const changed = [...new Set([...realFiles.keys(), ...sandboxFiles.keys()])].filter((relative) => {
    const before = realFiles.get(relative);
    const after = sandboxFiles.get(relative);
    return !before || !after || before.hash !== after.hash || before.mode !== after.mode;
  });
  const policyFiles = changed.filter((relative) => ['.gitignore', '.gitattributes', '.gitmodules'].includes(path.basename(relative)));
  if (policyFiles.length) throw new Error(`repository policy files are forbidden in proposal paths: ${policyFiles.join(', ')}`);
  // Evaluate newly-created paths against the real repository's immutable ignore
  // policy, not mutable policy in the disposable clone.
  const ignoredChanges = changed.filter((relative) => !realFiles.has(relative) && sandboxFiles.has(relative) && spawnSync(
    'git', ['check-ignore', '--quiet', '--no-index', '--', relative], { cwd: repoPath },
  ).status === 0);
  if (ignoredChanges.length) throw new Error(`ignored proposal files are forbidden: ${ignoredChanges.join(', ')}`);
  const protectedChanges = changed.filter(isProtected);
  if (protectedChanges.length) throw new Error(`protected paths changed: ${protectedChanges.join(', ')}`);

  const diff = spawnSync('git', ['diff', '--unified=0', 'HEAD', '--', ...loop.allowlist], {
    cwd: sandbox,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error('could not inspect proposal diff for benchmark-only behavior');
  const added = diff.stdout.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  const newFileText = changed.filter((relative) => !realFiles.has(relative) && sandboxFiles.has(relative))
    .map((relative) => readFile(path.join(sandbox, relative), 'utf8').catch(() => ''));
  const candidateText = `${added}\n${(await Promise.all(newFileText)).join('\n')}`;
  const compactCandidateText = candidateText.replace(/[^a-z0-9_]/gi, '');
  const environmentObservation = /location|URLSearchParams|__BLACKOUT__|import\.meta\.env|document|window|globalThis|navigator|screen|innerWidth|innerHeight|outerWidth|outerHeight|devicePixelRatio|userAgent|webdriver|headless|playwright|domElement|getDrawingBufferSize|getPixelRatio/i;
  const conditionalUse = /\bif\s*\(|\bswitch\s*\(|\?|&&|\|\||={2,3}|!={1,2}|[<>]=?|\.has\s*\(|\.includes\s*\(/;
  const conditionedEnvironment = candidateText.split(/\r?\n/).some((line) => environmentObservation.test(line) && conditionalUse.test(line));
  if (conditionedEnvironment
      || /fromCharCode|\beval\b|\bFunction\b/i.test(candidateText)
      || /capture|debug|headless|playwright|webdriver/.test(compactCandidateText.toLowerCase())) {
    throw new Error('proposal introduced benchmark-, debug-, URL-, or environment-conditioned behavior');
  }

  for (const relative of changed) {
    const source = path.join(sandbox, relative);
    const destination = path.join(repoPath, relative);
    if (!sandboxFiles.has(relative)) {
      await rm(destination, { force: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, sandboxFiles.get(relative).mode);
  }
}

const identity = {
  head: git('rev-parse', 'HEAD'),
  branch: git('branch', '--show-current'),
  common: git('rev-parse', '--path-format=absolute', '--git-common-dir'),
  root: git('rev-parse', '--show-toplevel'),
  index: git('write-tree'),
};
if (identity.branch !== loop.branch || path.resolve(identity.root) !== repoPath) {
  throw new Error(`proposal started in unexpected worktree identity: ${identity.branch} at ${identity.root}`);
}
const baselinePath = path.join(identity.common, 'autoresearch-state', loop.branch, loopId, 'baseline.json');
const baselineHash = await hashFile(baselinePath);
if (baselineHash === 'missing') throw new Error(`missing immutable baseline state: ${baselinePath}`);

const sandbox = await mkdtemp(path.join(os.tmpdir(), `autoresearch-${loopId}-`));
await rm(sandbox, { recursive: true, force: true });
const cloned = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', '--branch', identity.branch, repoPath, sandbox], {
  cwd: repoPath,
  encoding: 'utf8',
});
if (cloned.status !== 0) throw new Error(`could not create proposal sandbox: ${cloned.stderr?.trim() || cloned.error?.message}`);

const contract = await readFile(path.join(repoPath, 'tools/autoresearch/trial-contract.md'), 'utf8');
const prompt = `${contract}\n\n## Current trial\n- Loop: ${loopId}\n- Trial: ${process.env.AR_TRIAL || '?'}\n- Repository: ${repoPath}\n- Target preset: ${loop.preset}\n- Guard preset: ${loop.guardPreset}\n- Previous best score: ${process.env.AR_PREVIOUS_SCORE || 'baseline only'}\n- Allowed paths: ${loop.allowlist.join(', ')}\n- Protected paths: ${(loop.protectedPaths || []).join(', ')}\n\n## Objective\n${loop.objective}\n\nInspect the repository and current diff, choose one hypothesis, implement it, verify it, and then exit without committing, staging, changing branches, or altering Git history.`;

let command = ['hermes', 'chat', '-q'];
if (process.env.AR_AGENT_COMMAND_JSON) {
  const parsed = JSON.parse(process.env.AR_AGENT_COMMAND_JSON);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('AR_AGENT_COMMAND_JSON must be a non-empty JSON string array');
  }
  command = parsed;
}

const hermesHome = path.join(os.homedir(), '.hermes');
const hermesState = await realpath(hermesHome);
const bwrapArgs = [
  '--die-with-parent', '--new-session',
  '--unshare-pid',
  '--ro-bind', '/', '/',
  '--dev-bind', '/dev', '/dev',
  '--proc', '/proc',
  '--tmpfs', '/tmp',
  '--bind', hermesState, hermesState,
  '--bind', sandbox, repoPath,
  '--chdir', repoPath,
  '--', command[0], ...command.slice(1), prompt,
];
const child = spawn('bwrap', bwrapArgs, {
  cwd: repoPath,
  env: { ...process.env, AR_REPO_PATH: repoPath },
  stdio: 'inherit',
  detached: true,
});
const timeoutMs = Math.max(1000, (Number(loop.commandTimeoutSeconds || 1800) - 30) * 1000);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`[autoresearch:${loopId}] proposal agent timed out`);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 10000).unref();
}, timeoutMs);
const outcome = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);

try {
  if (timedOut || outcome.signal || outcome.code !== 0) {
    throw new Error(`proposal agent failed${outcome.signal ? ` with ${outcome.signal}` : ` with exit ${outcome.code}`}`);
  }

  // Kill any descendant that outlived the direct proposal command before
  // inspecting output. Bubblewrap kept the real repository read-only to it.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group is already gone */ }

  if (gitAt(sandbox, 'rev-parse', 'HEAD') !== identity.head
      || gitAt(sandbox, 'branch', '--show-current') !== identity.branch
      || gitAt(sandbox, 'write-tree') !== identity.index) {
    throw new Error('proposal attempted to mutate Git history, branch, or index');
  }
  await applySandboxChanges(sandbox);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

const violations = [];
if (git('rev-parse', 'HEAD') !== identity.head) violations.push('HEAD changed');
if (git('branch', '--show-current') !== identity.branch) violations.push('branch changed');
if (git('rev-parse', '--path-format=absolute', '--git-common-dir') !== identity.common) violations.push('repository changed');
if (git('write-tree') !== identity.index) violations.push('index/staging changed');
if (await hashFile(baselinePath) !== baselineHash) violations.push('baseline state changed');
const realChanges = changedPaths(repoPath);
const disallowed = realChanges.filter((relative) => !isAllowed(relative));
if (disallowed.length) violations.push(`disallowed paths changed: ${disallowed.join(', ')}`);
const protectedChanges = realChanges.filter(isProtected);
if (protectedChanges.length) violations.push(`protected paths changed: ${protectedChanges.join(', ')}`);
if (violations.length) throw new Error(`proposal rejected: ${violations.join('; ')}`);
