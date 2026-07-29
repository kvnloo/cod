#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const manifestPath = process.argv[2];
const rubricPath = process.argv[3];
if (!manifestPath || !rubricPath) throw new Error('usage: visual-score.mjs <capture-manifest> <rubric>');
const capture = JSON.parse(await readFile(manifestPath, 'utf8'));
const repoPath = path.resolve(process.env.AR_REPO_PATH || process.cwd());
const images = capture.shots.map((shot) => path.resolve(repoPath, shot.file));
const judgeCwd = path.join(repoPath, 'runs', 'autoresearch', 'visual-judge');
await mkdir(judgeCwd, { recursive: true });

const prompt = `Act as a strict read-only AAA game-scene visual evaluator. Inspect every image below using available image-analysis tools and read the rubric. Do not modify files. Score the complete shot pack from 0 to 100, penalizing any repeated hobby-project tells and temporal/capture errors. Return one JSON object on the final line exactly in this shape: {"score": 0, "reason": "specific evidence", "shotScores": {"shot-name": 0}}.\n\nRubric: ${path.resolve(rubricPath)}\nImages:\n${images.map((file) => `- ${file}`).join('\n')}`;

let command = ['hermes', 'chat', '-q'];
if (process.env.AR_VISUAL_JUDGE_COMMAND_JSON) {
  const parsed = JSON.parse(process.env.AR_VISUAL_JUDGE_COMMAND_JSON);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('AR_VISUAL_JUDGE_COMMAND_JSON must be a JSON argv array');
  command = parsed;
}
const judgeTimeoutMs = Number(process.env.AR_VISUAL_JUDGE_TIMEOUT_MS || 900000);
const result = spawnSync('timeout', [
  '--signal=TERM', '--kill-after=10s', `${Math.ceil(judgeTimeoutMs / 1000)}s`,
  command[0], ...command.slice(1), prompt,
], {
  // Keep the tool-capable judge outside the product tree. The evaluator also
  // fingerprints every non-ignored repository file before and after this call.
  cwd: judgeCwd,
  encoding: 'utf8',
  timeout: judgeTimeoutMs + 15000,
  maxBuffer: 10 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || 'visual judge failed');
  process.exit(1);
}

let parsed = null;
for (const line of result.stdout.split(/\r?\n/).reverse()) {
  try {
    const value = JSON.parse(line.trim());
    if (value && typeof value.score === 'number' && Number.isFinite(value.score)) { parsed = value; break; }
  } catch { /* keep scanning */ }
}
if (!parsed) {
  console.error('visual judge did not return a JSON score');
  process.exit(1);
}
console.log(JSON.stringify(parsed));
