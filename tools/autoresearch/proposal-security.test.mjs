import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROPOSER = path.join(HERE, 'propose.mjs');
const MANIFEST = {
  loops: {
    performance: {
      branch: 'autoresearch/performance',
      preset: 'low',
      guardPreset: 'cinematic',
      objective: 'security fixture',
      allowlist: ['src'],
      protectedPaths: ['src/core/Capture.ts'],
      expectedShots: ['overview'],
      commandTimeoutSeconds: 60,
    },
  },
};

function run(cwd, command, timeout = 20_000) {
  return spawnSync(process.execPath, [PROPOSER, 'performance'], {
    cwd,
    env: { ...process.env, AR_REPO_PATH: cwd, AR_AGENT_COMMAND_JSON: JSON.stringify(command) },
    encoding: 'utf8',
    timeout,
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoresearch-security-test-'));
  await mkdir(path.join(root, 'src/core'), { recursive: true });
  await mkdir(path.join(root, 'tools/autoresearch'), { recursive: true });
  await writeFile(path.join(root, 'autoresearch.pipeline.json'), JSON.stringify(MANIFEST));
  await writeFile(path.join(root, 'tools/autoresearch/trial-contract.md'), 'test contract\n');
  await writeFile(path.join(root, '.gitignore'), '*.log\n');
  await writeFile(path.join(root, 'src/core/Capture.ts'), 'protected\n');
  await writeFile(path.join(root, 'src/allowed.ts'), 'base\n');
  const init = spawnSync('git', ['init', '-b', 'autoresearch/performance'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0);
  const commit = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  const baseline = path.join(root, '.git/autoresearch-state/autoresearch/performance/performance/baseline.json');
  await mkdir(path.dirname(baseline), { recursive: true });
  await writeFile(baseline, 'baseline\n');
  return { root, baseline };
}

test('proposal sandbox imports a benign allowlisted source edit', async () => {
  const { root, baseline } = await fixture();
  const result = run(root, ['node', '-e', "require('fs').appendFileSync('src/allowed.ts','ok\\n')"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(root, 'src/allowed.ts'), 'utf8'), 'base\nok\n');
  assert.equal(await readFile(baseline, 'utf8'), 'baseline\n');
});

test('proposal sandbox rejects protected edits and Git commits', async () => {
  const protectedFixture = await fixture();
  const protectedResult = run(protectedFixture.root, ['node', '-e', "require('fs').appendFileSync('src/core/Capture.ts','evil\\n')"]);
  assert.notEqual(protectedResult.status, 0);
  assert.equal(await readFile(path.join(protectedFixture.root, 'src/core/Capture.ts'), 'utf8'), 'protected\n');

  const commitFixture = await fixture();
  const commitResult = run(commitFixture.root, ['bash', '-lc', "echo evil > src/evil.ts && git add src/evil.ts && git -c user.name=test -c user.email=test@example.com commit -m evil"]);
  assert.notEqual(commitResult.status, 0);
  await assert.rejects(readFile(path.join(commitFixture.root, 'src/evil.ts')));
});

test('real ignore policy defeats skip-worktree ignored-source injection', async () => {
  const { root } = await fixture();
  const attack = "git update-index --skip-worktree .gitignore; printf '' > .gitignore; printf evil > src/payload.log; printf '\\nimport \\\"./payload.log\\\";' >> src/allowed.ts";
  const result = run(root, ['bash', '-lc', attack]);
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(path.join(root, 'src/payload.log')));
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), '*.log\n');
});

test('PID namespace kills detached descendants before validated copy-back', async () => {
  const { root } = await fixture();
  const child = "setTimeout(()=>require('fs').appendFileSync('src/allowed.ts','late\\n'),1500)";
  const attack = `const{spawn}=require('child_process'),fs=require('fs');fs.appendFileSync('src/allowed.ts','ok\\n');spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref()`;
  const result = run(root, ['node', '-e', attack]);
  assert.equal(result.status, 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(await readFile(path.join(root, 'src/allowed.ts'), 'utf8'), 'base\nok\n');
});

test('proposal importer rejects obfuscated capture and viewport conditions', async () => {
  const { root } = await fixture();
  const attack = "require('fs').appendFileSync('src/allowed.ts',\"if(new URL(document.documentURI).searchParams.has('cap'+'ture')||innerWidth===1920){}\\n\")";
  const result = run(root, ['node', '-e', attack]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(root, 'src/allowed.ts'), 'utf8'), 'base\n');
});

test('proposal importer permits ordinary unconditioned runtime APIs', async () => {
  const { root } = await fixture();
  const proposal = "require('fs').appendFileSync('src/allowed.ts',\"export const startedAt = performance.now();\\n\")";
  const result = run(root, ['node', '-e', proposal]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(root, 'src/allowed.ts'), 'utf8'), 'base\nexport const startedAt = performance.now();\n');
});
