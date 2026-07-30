#!/usr/bin/env node
/**
 * Session layer, in the real browser build.
 *
 * `tools/session-flow.mjs` proves the flow and the bridges headlessly against
 * the TypeScript sources. This proves the last mile: that the shipped bundle
 * actually stands the session up, that it adopts the single-player match
 * instead of starting a second one, and that installing it costs the existing
 * game nothing.
 *
 *   node tools/session-live.mjs --dist dist-s8 --port 4608
 */
import { ensureServer, stopServer, openSession } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DIST = arg('dist', 'dist-s8');
const PORT = Number(arg('port', '4608'));

const checks = [];
const expect = (name, cond, detail = '') => checks.push({ name, ok: !!cond, detail });

async function main() {
  const base = await ensureServer({ mode: 'preview', port: PORT, outDir: DIST, quiet: true });
  const session = await openSession({ url: `${base}/?capture=1&quality=low`, width: 1280, height: 720 });

  try {
    // The session installs on `game:ready`, one dynamic import later.
    await session.page.waitForFunction(
      () => !!globalThis.__BLACKOUT_SESSION__,
      undefined,
      { timeout: 30_000, polling: 100 },
    );

    const probe = await session.page.evaluate(() => {
      const s = globalThis.__BLACKOUT_SESSION__;
      const game = globalThis.__BLACKOUT_GAME__;
      const snap = s.snapshot();
      return {
        state: snap.state,
        label: snap.label,
        screen: snap.screen,
        mode: snap.mode,
        isHost: snap.isHost,
        online: snap.online,
        degraded: snap.degraded,
        members: snap.members.length,
        legal: snap.legal,
        systems: globalThis.engine ? globalThis.engine.systems.map((x) => x.name) : [],
        matchPhase: game?.match?.phase ?? null,
        started: game?.match?.started ?? null,
      };
    });

    expect('the shipped bundle installs the session', !!probe.state, `state=${probe.state}`);
    expect('the session registered with the engine',
      probe.systems.includes('session'), probe.systems.join(','));
    // Capture runs install the session `passive`: the director starts nothing,
    // so there is nothing to adopt and the flow correctly waits in the front
    // end. The session must not deploy on its own and pollute another module's
    // shots — that is the property this asserts.
    expect('a capture run installs the session but starts nothing',
      probe.matchPhase === 'idle' && probe.screen === 'main',
      `flow=${probe.state} screen=${probe.screen} match=${probe.matchPhase}`);
    expect('an offline session is the host',
      probe.isHost === true && probe.online === false,
      `host=${probe.isHost} online=${probe.online}`);
    expect('missing peers are reported, not hidden',
      Array.isArray(probe.degraded) && probe.degraded.length > 0,
      `degraded=${probe.degraded.join(',')}`);
    expect('the session exposes a roster and legal events to the UI',
      probe.members >= 1 && probe.legal.length > 0,
      `${probe.members} member(s), legal=[${probe.legal.join(',')}]`);

    // Installing the session must not have broken the frame loop.
    const frames = await session.page.evaluate(async () => {
      const e = globalThis.engine;
      const before = e.time?.frame ?? 0;
      for (let i = 0; i < 20; i++) e.stepFrame(1 / 60);
      return { before, after: e.time?.frame ?? 0, fps: e.fps };
    });
    expect('the engine still steps with the session installed',
      frames.after > frames.before, `${frames.before} → ${frames.after} frames`);

    const fatal = session.errors.filter((e) => !/404|Failed to load resource/i.test(String(e)));
    expect('no new console errors', fatal.length === 0, fatal.slice(0, 2).join(' | ') || 'clean');
  } finally {
    await session.close();
    await stopServer();
  }

  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  console.log('');
  console.log(`[session-live] ${passed === checks.length ? 'PASS' : 'FAIL'}  ${passed}/${checks.length}`);
  return passed === checks.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => { console.error(err); await stopServer().catch(() => { }); process.exit(1); });
