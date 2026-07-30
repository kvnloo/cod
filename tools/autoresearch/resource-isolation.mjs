import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseProcStat(text) {
  const end = text.lastIndexOf(')');
  if (end < 0) throw new Error('malformed /proc stat');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const comm = text.slice(text.indexOf('(') + 1, end);
  const fields = text.slice(end + 2).trim().split(/\s+/);
  return {
    pid,
    comm,
    state: fields[0],
    ppid: Number(fields[1]),
    ttyNr: Number(fields[4]),
    cpuTicks: Number(fields[11]) + Number(fields[12]),
    startTime: fields[19],
  };
}

async function readProcess(pid) {
  try {
    const [statText, status, cgroupText] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/cgroup`, 'utf8'),
    ]);
    const stat = parseProcStat(statText);
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    const cgroup = cgroupText.match(/^0::(.+)$/m)?.[1] || null;
    return { ...stat, uid, cgroup };
  } catch {
    return null;
  }
}

export async function listProcesses() {
  const entries = await readdir('/proc');
  return (await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(readProcess))).filter(Boolean);
}

export function selectPauseTargets(processes, { uid, pauseCommands, protectedPids }) {
  const protectedSet = new Set(protectedPids);
  const commandSet = new Set(pauseCommands);
  const children = new Map();
  for (const process of processes) {
    const siblings = children.get(process.ppid) || [];
    siblings.push(process.pid);
    children.set(process.ppid, siblings);
  }
  const selected = new Set();
  const visit = (pid) => {
    if (protectedSet.has(pid) || selected.has(pid)) return;
    selected.add(pid);
    for (const child of children.get(pid) || []) visit(child);
  };
  for (const process of processes) {
    if (process.uid === uid && commandSet.has(process.comm) && !protectedSet.has(process.pid)) visit(process.pid);
  }
  return processes.filter((process) => selected.has(process.pid));
}

function ancestorPids(processes, startPid = process.pid) {
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const ancestors = new Set([startPid]);
  let current = byPid.get(startPid);
  while (current && current.ppid > 1 && !ancestors.has(current.ppid)) {
    ancestors.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return ancestors;
}

function sameProcess(record) {
  try {
    return parseProcStat(readFileSync(`/proc/${record.pid}/stat`, 'utf8')).startTime === record.startTime;
  } catch {
    return false;
  }
}

function processState(record) {
  try {
    const parsed = parseProcStat(readFileSync(`/proc/${record.pid}/stat`, 'utf8'));
    return parsed.startTime === record.startTime ? parsed.state : null;
  } catch {
    return null;
  }
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// SIGSTOP is reserved for explicitly armed desktop-exclusive mode and only for
// same-user, non-TTY workloads outside writable user cgroups.
export function pauseRecords(records) {
  const paused = [];
  for (const record of [...records].sort((a, b) => b.pid - a.pid)) {
    if (!sameProcess(record)) continue;
    try {
      process.kill(record.pid, 'SIGSTOP');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const state = processState(record);
        if (state == null) break;
        if (state === 'T' || state === 't') {
          paused.push(record);
          break;
        }
        waitSync(20);
      }
    } catch { /* process exited */ }
  }
  if (paused.length !== records.filter(sameProcess).length) {
    throw new Error(`could not verify all signal-paused workloads (${paused.length}/${records.length})`);
  }
  return paused;
}

export function resumeRecords(records) {
  const failures = [];
  for (const record of records) {
    if (!sameProcess(record)) continue;
    try {
      process.kill(record.pid, 'SIGCONT');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const state = processState(record);
        if (state == null || (state !== 'T' && state !== 't')) break;
        waitSync(20);
      }
      const state = processState(record);
      if (state === 'T' || state === 't') failures.push(record.pid);
    } catch {
      if (sameProcess(record)) failures.push(record.pid);
    }
  }
  return failures;
}

function safeCgroupPath(relative, uid = process.getuid()) {
  if (typeof relative !== 'string' || !relative.startsWith('/')) return null;
  const root = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
  const resolved = path.resolve('/sys/fs/cgroup', `.${relative}`);
  return resolved === root || resolved.startsWith(`${root}/`) ? resolved : null;
}

function relatedCgroup(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function selectPauseCgroups(targets, protectedProcesses, uid = process.getuid()) {
  const protectedGroups = [...new Set(protectedProcesses.map((item) => item.cgroup).filter(Boolean))];
  const groups = new Map();
  for (const target of targets) {
    if (!target.cgroup || protectedGroups.some((group) => target.cgroup === group
      || target.cgroup.startsWith(`${group}/`) || group.startsWith(`${target.cgroup}/`))) continue;
    const absolute = safeCgroupPath(target.cgroup, uid);
    if (!absolute) continue;
    const record = groups.get(target.cgroup) || { cgroup: target.cgroup, absolute, pids: [], commands: [] };
    record.pids.push(target.pid);
    if (!record.commands.includes(target.comm)) record.commands.push(target.comm);
    groups.set(target.cgroup, record);
  }
  return [...groups.values()];
}

export function selectSignalPauseTargets(targets, protectedProcesses = []) {
  const protectedGroups = new Set(protectedProcesses.map((item) => item.cgroup).filter(Boolean));
  return targets.filter((item) => {
    if (item.ttyNr !== 0 || item.state === 'T' || item.state === 't' || safeCgroupPath(item.cgroup)) return false;
    return ![...protectedGroups].some((group) => relatedCgroup(group, item.cgroup));
  }).map(({ pid, startTime, comm: command }) => ({ pid, startTime, command }));
}

function cgroupFreezeState(record) {
  const absolute = safeCgroupPath(record.cgroup);
  if (!absolute || absolute !== record.absolute) return null;
  try {
    return readFileSync(path.join(absolute, 'cgroup.freeze'), 'utf8').trim() === '1';
  } catch {
    return null;
  }
}

export function freezeCgroups(records) {
  const frozen = [];
  for (const record of records) {
    const wasFrozen = typeof record.wasFrozen === 'boolean' ? record.wasFrozen : cgroupFreezeState(record);
    if (wasFrozen == null) continue;
    try {
      if (!wasFrozen) writeFileSync(path.join(record.absolute, 'cgroup.freeze'), '1');
      frozen.push({ ...record, wasFrozen });
    } catch { /* cgroup disappeared */ }
  }
  return frozen;
}

export function thawCgroups(records) {
  const failures = [];
  for (const record of records) {
    if (record.wasFrozen || cgroupFreezeState(record) == null) continue;
    try {
      writeFileSync(path.join(record.absolute, 'cgroup.freeze'), '0');
      if (cgroupFreezeState(record) !== false) failures.push(record.cgroup);
    } catch {
      failures.push(record.cgroup);
    }
  }
  return failures;
}

async function recoverStaleState(statePath, logger) {
  try {
    const stale = JSON.parse(await readFile(statePath, 'utf8'));
    if (stale.owner && sameProcess(stale.owner)) {
      throw new Error(`resource isolation is already active in PID ${stale.owner.pid}`);
    }
    if (Array.isArray(stale.frozen)) {
      const failures = thawCgroups(stale.frozen);
      if (failures.length) throw new Error(`could not recover frozen cgroups: ${failures.join(', ')}`);
      logger(`[isolation] recovered ${stale.frozen.length} cgroup(s) from stale freeze state`);
    }
    if (Array.isArray(stale.paused)) {
      const failures = resumeRecords(stale.paused);
      if (failures.length) throw new Error(`could not recover stopped PIDs: ${failures.join(', ')}`);
      logger(`[isolation] recovered ${stale.paused.length} process(es) from legacy pause state`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rm(statePath, { force: true });
}

async function claimIsolationState(statePath, logger) {
  const self = await readProcess(process.pid);
  if (!self) throw new Error('could not identify resource-isolation owner process');
  const owner = { pid: self.pid, startTime: self.startTime };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(statePath, `${JSON.stringify({ owner, createdAt: new Date().toISOString(), frozen: [] }, null, 2)}\n`, { flag: 'wx' });
      return owner;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await recoverStaleState(statePath, logger);
    }
  }
  throw new Error('could not acquire resource-isolation lock');
}

function cpuCounters(text) {
  const values = text.split(/\r?\n/)[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] || 0) + (values[4] || 0);
  return { idle, total: values.reduce((sum, value) => sum + value, 0) };
}

async function cpuUtilization(intervalMs) {
  const before = cpuCounters(await readFile('/proc/stat', 'utf8'));
  await sleep(intervalMs);
  const after = cpuCounters(await readFile('/proc/stat', 'utf8'));
  const total = after.total - before.total;
  return total > 0 ? 100 * (1 - (after.idle - before.idle) / total) : 0;
}

function gpuUtilization() {
  const result = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const values = result.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

export function quietSampleAccepted(sample, config) {
  return Number.isFinite(sample.cpu)
    && Number.isFinite(sample.gpu)
    && sample.cpu <= config.maxCpuUtilization
    && sample.gpu <= config.maxGpuUtilization;
}

async function waitForQuiet(config, logger) {
  const deadline = Date.now() + config.maxWaitSeconds * 1000;
  let consecutive = 0;
  let latest = null;
  const samples = [];
  while (Date.now() < deadline) {
    const cpu = await cpuUtilization(config.sampleIntervalMs);
    const gpu = gpuUtilization();
    latest = { cpu: Number(cpu.toFixed(1)), gpu };
    samples.push({ at: new Date().toISOString(), ...latest });
    consecutive = quietSampleAccepted(latest, config) ? consecutive + 1 : 0;
    logger(`[isolation] quiet sample ${consecutive}/${config.quietSamples}: CPU ${latest.cpu}% GPU ${gpu == null ? 'n/a' : `${gpu}%`}`);
    if (consecutive >= config.quietSamples) return samples;
  }
  const error = new Error(`machine did not become quiet within ${config.maxWaitSeconds}s (last CPU ${latest?.cpu ?? '?'}%, GPU ${latest?.gpu ?? 'n/a'}%)`);
  error.samples = samples;
  throw error;
}

async function startWatchdog(config, frozen, auditPath) {
  if (!config.monitor) return null;
  const processes = await listProcesses();
  const active = processes.find((item) => item.pid === process.pid);
  if (!active?.cgroup) throw new Error('could not determine evaluator cgroup for activity monitoring');
  const configPath = `${auditPath}.watchdog-config.json`;
  const evidencePath = `${auditPath}.watchdog.json`;
  await writeFile(configPath, `${JSON.stringify({
    parentPid: process.pid,
    activeCgroup: active.cgroup,
    frozenCgroups: frozen.map((item) => item.cgroup),
    intervalMs: config.monitorIntervalMs,
    maxExternalCpuPercent: config.maxExternalCpuPercent,
    maxExternalGpuPercent: config.maxExternalGpuPercent,
  }, null, 2)}\n`);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resource-watchdog.mjs');
  const child = spawn(process.execPath, [script, configPath, evidencePath], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode != null) throw new Error(`resource activity watchdog exited early with ${child.exitCode}`);
    try {
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      if (evidence.status === 'running') return { child, configPath, evidencePath };
    } catch { /* watchdog is starting */ }
    await sleep(20);
  }
  child.kill('SIGKILL');
  throw new Error('resource activity watchdog did not become ready');
}

async function stopWatchdog(watchdog) {
  if (!watchdog) return { status: 'disabled', violations: [] };
  watchdog.child.kill('SIGTERM');
  for (let attempt = 0; attempt < 300 && watchdog.child.exitCode == null; attempt += 1) await sleep(20);
  if (watchdog.child.exitCode == null) watchdog.child.kill('SIGKILL');
  let evidence;
  try { evidence = JSON.parse(await readFile(watchdog.evidencePath, 'utf8')); } catch {
    evidence = { status: 'error', reason: 'resource activity watchdog produced no evidence', violations: [] };
  }
  await rm(watchdog.configPath, { force: true });
  return evidence;
}

export async function enterResourceIsolation(rawConfig, { statePath, auditPath, logger = console.log } = {}) {
  const config = {
    mode: rawConfig?.mode || 'remote-safe',
    pauseCommands: rawConfig?.pauseCommands || [],
    maxCpuUtilization: Number(rawConfig?.maxCpuUtilization ?? 20),
    maxGpuUtilization: Number(rawConfig?.maxGpuUtilization ?? 20),
    quietSamples: Number(rawConfig?.quietSamples ?? 3),
    sampleIntervalMs: Number(rawConfig?.sampleIntervalMs ?? 1000),
    maxWaitSeconds: Number(rawConfig?.maxWaitSeconds ?? 60),
    monitor: rawConfig?.monitor === true,
    monitorIntervalMs: Number(rawConfig?.monitorIntervalMs ?? 500),
    maxExternalCpuPercent: Number(rawConfig?.maxExternalCpuPercent ?? 20),
    maxExternalGpuPercent: Number(rawConfig?.maxExternalGpuPercent ?? 5),
    signalPauseOutsideUserCgroups: rawConfig?.signalPauseOutsideUserCgroups === true,
  };
  if (!statePath) throw new Error('resource isolation requires a private state path');
  if (config.monitor && !auditPath) throw new Error('resource activity monitoring requires an audit path');
  await mkdir(path.dirname(statePath), { recursive: true });
  if (auditPath) await mkdir(path.dirname(auditPath), { recursive: true });
  const safeLog = (message) => { try { logger(message); } catch { /* diagnostics cannot strand resources */ } };
  const owner = await claimIsolationState(statePath, safeLog);
  let frozen = [];
  let paused = [];
  let watchdog = null;
  let released = false;
  const audit = {
    version: 1,
    mode: config.mode,
    startedAt: new Date().toISOString(),
    status: 'waiting',
    thresholds: {
      maxCpuUtilization: config.maxCpuUtilization,
      maxGpuUtilization: config.maxGpuUtilization,
      quietSamples: config.quietSamples,
      sampleIntervalMs: config.sampleIntervalMs,
      maxWaitSeconds: config.maxWaitSeconds,
      monitorIntervalMs: config.monitorIntervalMs,
      maxExternalCpuPercent: config.maxExternalCpuPercent,
      maxExternalGpuPercent: config.maxExternalGpuPercent,
    },
    frozen: [],
    samples: [],
  };
  const releaseSync = () => {
    if (released) return [];
    released = true;
    if (watchdog && watchdog.child.exitCode == null) watchdog.child.kill('SIGTERM');
    const failures = thawCgroups(frozen).map((group) => `cgroup ${group}`);
    failures.push(...resumeRecords(paused).map((pid) => `PID ${pid}`));
    if (!failures.length) {
      try { rmSync(statePath, { force: true }); } catch { failures.push('isolation journal'); }
    }
    return failures;
  };
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      releaseSync();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };

  try {
    const processes = await listProcesses();
    const protectedPids = ancestorPids(processes);
    const protectedProcesses = processes.filter((item) => protectedPids.has(item.pid));
    const targets = selectPauseTargets(processes, {
      uid: process.getuid(),
      pauseCommands: config.pauseCommands,
      protectedPids,
    });
    const groups = selectPauseCgroups(targets, protectedProcesses);
    const plannedPaused = config.signalPauseOutsideUserCgroups
      ? selectSignalPauseTargets(targets, protectedProcesses)
      : [];
    const planned = groups.map((record) => ({ ...record, wasFrozen: cgroupFreezeState(record) }));
    if (planned.some((record) => record.wasFrozen == null)) throw new Error('could not inspect all competing process cgroups');
    await writeFile(statePath, `${JSON.stringify({ owner, createdAt: audit.startedAt, frozen: planned, paused: plannedPaused }, null, 2)}\n`);
    frozen = freezeCgroups(planned);
    if (frozen.length !== groups.length) throw new Error(`could not freeze all competing process cgroups (${frozen.length}/${groups.length})`);
    paused = plannedPaused;
    pauseRecords(plannedPaused);
    audit.frozen = frozen.map(({ cgroup, pids, commands }) => ({ cgroup, pids, commands }));
    audit.paused = paused;
    if (auditPath) await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
    safeLog(`[isolation] froze ${frozen.length} competing cgroup(s): ${[...new Set(frozen.flatMap((item) => item.commands))].join(', ') || 'none'}`);
    audit.samples = await waitForQuiet(config, safeLog);
    audit.status = 'active';
    audit.quietAt = new Date().toISOString();
    if (auditPath) await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
    watchdog = await startWatchdog(config, frozen, auditPath);
  } catch (error) {
    const thawFailures = releaseSync();
    removeSignalHandlers();
    audit.samples = Array.isArray(error.samples) ? error.samples : audit.samples;
    audit.status = 'rejected';
    audit.finishedAt = new Date().toISOString();
    audit.reason = error.message;
    if (auditPath) {
      try { await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`); } catch { /* cleanup already ran */ }
    }
    if (thawFailures.length) throw new AggregateError([error], `resource isolation failed and cleanup could not thaw: ${thawFailures.join(', ')}`);
    throw error;
  }

  return async () => {
    let activity;
    try { activity = await stopWatchdog(watchdog); } catch (error) {
      activity = { status: 'error', reason: error.message, violations: [] };
    }
    const thawFailures = releaseSync();
    removeSignalHandlers();
    audit.activity = activity;
    audit.status = activity.status === 'clean' || activity.status === 'disabled' ? 'completed' : 'contaminated';
    audit.finishedAt = new Date().toISOString();
    if (auditPath) await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
    safeLog(`[isolation] thawed ${frozen.length} competing cgroup(s)`);
    if (thawFailures.length) throw new Error(`could not thaw benchmark cgroups: ${thawFailures.join(', ')}`);
    if (audit.status === 'contaminated') {
      throw new Error(`benchmark resource activity was contaminated: ${activity.reason || `${activity.violations?.length || 0} external violation(s)`}`);
    }
  };
}
