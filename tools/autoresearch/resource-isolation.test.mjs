import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  enterResourceIsolation,
  parseProcStat,
  quietSampleAccepted,
  selectPauseCgroups,
  selectPauseTargets,
  selectSignalPauseTargets,
} from './resource-isolation.mjs';
import { parsePmon } from './resource-watchdog.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('selects configured process trees while preserving the benchmark ancestry', () => {
  const processes = [
    { pid: 10, ppid: 1, uid: 1000, comm: 'hermes' },
    { pid: 11, ppid: 10, uid: 1000, comm: 'node' },
    { pid: 20, ppid: 1, uid: 1000, comm: 'claude' },
    { pid: 21, ppid: 20, uid: 1000, comm: 'node' },
    { pid: 30, ppid: 1, uid: 0, comm: 'claude' },
  ];
  const selected = selectPauseTargets(processes, {
    uid: 1000,
    pauseCommands: ['hermes', 'claude'],
    protectedPids: new Set([10]),
  });
  assert.deepEqual(selected.map((process) => process.pid), [20, 21]);
});

test('deduplicates target cgroups and never freezes the active ancestry cgroup', () => {
  const targets = [
    { pid: 20, comm: 'claude', cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/agent.scope' },
    { pid: 21, comm: 'node', cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/agent.scope' },
    { pid: 30, comm: 'hermes', cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/current.scope' },
  ];
  const groups = selectPauseCgroups(targets, [targets[2]], 1000);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].pids, [20, 21]);
  assert.deepEqual(groups[0].commands, ['claude', 'node']);
});

test('signal fallback selects only non-TTY workloads outside writable user cgroups', () => {
  const targets = [
    { pid: 1, startTime: '1', comm: 'python3', ttyNr: 0, cgroup: '/system.slice/cronie.service' },
    { pid: 2, startTime: '2', comm: 'python3', ttyNr: 34816, cgroup: '/system.slice/interactive.service' },
    { pid: 3, startTime: '3', comm: 'node', ttyNr: 0, cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/node.scope' },
  ];
  assert.deepEqual(selectSignalPauseTargets(targets), [
    { pid: 1, startTime: '1', command: 'python3' },
  ]);
});

test('quiet samples fail closed when either CPU or GPU exceeds policy', () => {
  const policy = { maxCpuUtilization: 20, maxGpuUtilization: 20 };
  assert.equal(quietSampleAccepted({ cpu: 10, gpu: 5 }, policy), true);
  assert.equal(quietSampleAccepted({ cpu: 21, gpu: 5 }, policy), false);
  assert.equal(quietSampleAccepted({ cpu: 10, gpu: 21 }, policy), false);
  assert.equal(quietSampleAccepted({ cpu: 10, gpu: null }, policy), false);
});

test('parses NVIDIA per-process activity for continuous contamination checks', () => {
  const rows = parsePmon([
    '#Date Time gpu pid type sm mem enc dec command',
    '20260730 00:00:00 0 4847 G 38 26 - - Hyprland',
    '20260730 00:00:00 0 13616 C+G - - - - sunshine',
  ].join('\n'));
  assert.deepEqual(rows, [{ pid: 4847, sm: 38 }]);
});

test('recovers a stale paused process before entering a new isolation window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoresearch-isolation-'));
  const statePath = path.join(root, 'state.json');
  const auditPath = path.join(root, 'audit.json');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await sleep(30);
    const stat = parseProcStat(await readFile(`/proc/${child.pid}/stat`, 'utf8'));
    process.kill(child.pid, 'SIGSTOP');
    await writeFile(statePath, JSON.stringify({ paused: [{ ...stat, uid: process.getuid() }] }));
    const release = await enterResourceIsolation({
      pauseCommands: ['definitely-not-a-process'],
      maxCpuUtilization: 100,
      maxGpuUtilization: 100,
      quietSamples: 1,
      sampleIntervalMs: 20,
      maxWaitSeconds: 2,
    }, { statePath, auditPath, logger: () => {} });
    const recovered = parseProcStat(await readFile(`/proc/${child.pid}/stat`, 'utf8'));
    assert.notEqual(recovered.state, 'T');
    await release();
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(audit.status, 'completed');
    assert.equal(audit.samples.length, 1);
  } finally {
    try { process.kill(child.pid, 'SIGCONT'); } catch {}
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a concurrent isolation owner without touching its journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoresearch-isolation-lock-'));
  const statePath = path.join(root, 'state.json');
  try {
    const self = parseProcStat(await readFile(`/proc/${process.pid}/stat`, 'utf8'));
    const journal = { owner: { pid: self.pid, startTime: self.startTime }, frozen: [] };
    await writeFile(statePath, JSON.stringify(journal));
    await assert.rejects(() => enterResourceIsolation({
      pauseCommands: ['definitely-not-a-process'],
      maxCpuUtilization: 100,
      maxGpuUtilization: 100,
      quietSamples: 1,
      sampleIntervalMs: 20,
      maxWaitSeconds: 2,
      monitor: false,
    }, { statePath, logger: () => {} }), /already active/);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), journal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});