#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { listProcesses } from './resource-isolation.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cgroupAllowed(cgroup, allowed) {
  return allowed.some((group) => cgroup === group || cgroup?.startsWith(`${group}/`));
}

function descendantPids(processes, rootPid) {
  const allowed = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (!allowed.has(item.pid) && allowed.has(item.ppid)) {
        allowed.add(item.pid);
        changed = true;
      }
    }
  }
  return allowed;
}

export function parsePmon(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const fields = line.trim().split(/\s+/);
    const hasDate = /^\d{8}$/.test(fields[0]);
    const offset = hasDate ? 2 : 0;
    const pid = Number(fields[offset + 1]);
    const sm = Number(fields[offset + 3]);
    if (Number.isInteger(pid) && pid > 0 && Number.isFinite(sm)) rows.push({ pid, sm });
  }
  return rows;
}

function gpuProcesses() {
  const result = spawnSync('nvidia-smi', ['pmon', '-c', '1', '-s', 'u', '-o', 'DT'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) throw new Error('nvidia-smi pmon failed');
  return parsePmon(result.stdout);
}

async function pressureAverage(kind) {
  const text = await readFile(`/proc/pressure/${kind}`, 'utf8');
  const match = text.match(/^some\s+.*?avg10=([\d.]+)/m);
  if (!match) throw new Error(`missing ${kind} PSI telemetry`);
  return Number(match[1]);
}

async function writeEvidence(path, evidence) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
  await rename(temporary, path);
}

async function main() {
  const configPath = process.argv[2];
  const evidencePath = process.argv[3];
  if (!configPath || !evidencePath) throw new Error('usage: resource-watchdog.mjs CONFIG EVIDENCE');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const clock = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) || 100;
  const allowed = (config.frozenCgroups || []).filter(Boolean);
  const evidence = {
    version: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    samples: 0,
    violations: [],
  };
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { stopping = true; });
  let previous = new Map();
  let previousAt = Date.now();

  while (!stopping) {
    try { process.kill(config.parentPid, 0); } catch { break; }
    const started = Date.now();
    const processes = await listProcesses();
    const byPid = new Map(processes.map((item) => [item.pid, item]));
    const allowedPids = descendantPids(processes, config.parentPid);
    const elapsed = Math.max(0.001, (started - previousAt) / 1000);
    if (previous.size) {
      const memoryPressure = await pressureAverage('memory');
      const ioPressure = await pressureAverage('io');
      if (memoryPressure > config.maxMemoryPressure) {
        evidence.violations.push({ at: new Date().toISOString(), resource: 'memory-pressure', percent: memoryPressure });
      }
      if (ioPressure > config.maxIoPressure) {
        evidence.violations.push({ at: new Date().toISOString(), resource: 'io-pressure', percent: ioPressure });
      }
      for (const item of processes) {
        if (allowedPids.has(item.pid) || cgroupAllowed(item.cgroup, allowed)) continue;
        if (item.cgroup === '/' && !item.cmdline) continue;
        const before = previous.get(item.pid);
        if (!before || before.startTime !== item.startTime) continue;
        const cpu = 100 * (item.cpuTicks - before.cpuTicks) / clock / elapsed;
        if (cpu > config.maxExternalCpuPercent) {
          evidence.violations.push({
            at: new Date().toISOString(), resource: 'cpu', pid: item.pid,
            command: item.comm, cgroup: item.cgroup, percent: Number(cpu.toFixed(1)),
          });
        }
      }
      for (const gpu of gpuProcesses()) {
        const item = byPid.get(gpu.pid);
        if (item && !allowedPids.has(item.pid) && !cgroupAllowed(item.cgroup, allowed) && gpu.sm > config.maxExternalGpuPercent) {
          evidence.violations.push({
            at: new Date().toISOString(), resource: 'gpu', pid: item.pid,
            command: item.comm, cgroup: item.cgroup, percent: gpu.sm,
          });
        }
      }
    }
    previous = new Map(processes.map((item) => [item.pid, item]));
    previousAt = started;
    evidence.samples += 1;
    await writeEvidence(evidencePath, evidence);
    await sleep(config.intervalMs);
  }
  evidence.status = evidence.violations.length ? 'contaminated' : 'clean';
  evidence.finishedAt = new Date().toISOString();
  await writeEvidence(evidencePath, evidence);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(async (error) => {
    const evidencePath = process.argv[3];
    if (evidencePath) {
      try { await writeEvidence(evidencePath, { version: 1, status: 'error', reason: error.message, violations: [] }); } catch {}
    }
    process.exit(1);
  });
}