/**
 * G1 in-game movement probe — drives the SHIPPING BUNDLE on the real level.
 *
 *   node tools/g1-ingame.mjs               # build + serve dist-gp-g1 + measure
 *   node tools/g1-ingame.mjs --no-build
 *
 * `tools/g1-movelab.mjs` is where the model is tuned, because a lab can build a
 * ledge of a known height and a ramp of a known angle. This is the other half of
 * the argument: the same code, minified, inside the real engine loop, against
 * the real level's collision, driven through `window.__BLACKOUT__` — proving the
 * mechanics are not an artefact of the lab's geometry or of running unbundled.
 *
 * Everything measured here is SIM time: the probe calls `engine.stepFrame(1/120)`
 * with rendering off, so a result is reproducible for a seed and independent of
 * how fast this box happens to be.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';

/**
 * Chromium writes its profile to TMPDIR. On this box /tmp is a tmpfs shared with
 * every other agent, and when it fills the browser dies *after* the game boots,
 * which presents as a mysterious readiness timeout. Copied deliberately rather
 * than imported: `tools/playtest.mjs` runs a full session on import.
 */
function ensureScratchTmp() {
  const free = (p) => {
    try { const s = statfsSync(p); return s.bavail * s.bsize; } catch { return 0; }
  };
  if (free(process.env.TMPDIR || '/tmp') > 2 * 1024 ** 3) return;
  for (const base of ['/dev/shm', path.join(ROOT, '.playtest-tmp')]) {
    try {
      const dir = path.join(base, 'blackout-g1');
      mkdirSync(dir, { recursive: true });
      if (free(dir) > 2 * 1024 ** 3) { process.env.TMPDIR = dir; return; }
    } catch { /* try the next candidate */ }
  }
}
ensureScratchTmp();

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PORT = Number(flag('port', 9911));
const OUT_DIR = flag('outDir', 'dist-gp-g1');
const SHOTS = path.join(ROOT, 'shots', 'gp-g1');

if (!has('no-build')) {
  const r = spawnSync('npx', ['vite', 'build', '--outDir', OUT_DIR], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const url = await ensureServer({ mode: 'preview', port: PORT, outDir: OUT_DIR });
const session = await openSession({ url, quality: 'high', seed: 1337 });
const page = session.page;

/**
 * Installs the probe. Everything it touches is a public field of a registered
 * system, so it survives minification: `engine.get('player').movement`, the
 * `TUNING` values already baked into the module, and `engine.stepFrame`.
 */
await page.evaluate(() => {
  const w = globalThis;
  const engine = w.engine;
  const player = engine.get('player');
  const mv = player.movement;
  mv.emitEvents = false;

  // Rendering off: this probe measures the simulation, and a render pass per
  // step would make a 20 000-step session take ten minutes for no information.
  const render = engine.tryGet ? engine.tryGet('render') : null;
  const setRender = (on) => { if (render) render.enabled = on; };

  const V = (v) => ({ x: v.x, y: v.y, z: v.z });
  const hs = () => Math.hypot(mv.velocity.x, mv.velocity.z);

  const BTN = {
    JUMP: 1 << 0, CROUCH: 1 << 1, PRONE: 1 << 2, SPRINT: 1 << 3, ADS: 1 << 4,
  };

  let seq = 0;
  const cmd = (o) => ({
    seq: seq++, tick: seq, dt: 1 / 120,
    moveX: o.moveX ?? 0, moveY: o.moveY ?? 0,
    yaw: o.yaw ?? 0, pitch: 0, buttons: o.buttons ?? 0,
  });

  /** One fixed step of movement only — no engine systems, no render. */
  const step = (o) => mv.stepCommand(cmd(o));

  w.__G1__ = {
    setRender,
    info: () => ({
      position: V(mv.position), velocity: V(mv.velocity),
      state: mv.out.state, grounded: mv.out.grounded, speed: hs(),
      height: mv.height,
      counters: {
        wallBounce: mv.wallBounceCount, tapStrafe: mv.tapStrafeCount,
        mantle: mv.mantleCount, slideJump: mv.slideJumpCount,
      },
      out: {
        mantleKind: mv.out.mantleKind, mantleHeight: mv.out.mantleHeight,
        mantleDuration: mv.out.mantleDuration, mantleProgress: mv.out.mantleProgress,
        wallBounce: mv.out.wallBounce, tapStrafe: mv.out.tapStrafe,
        slideJump: mv.out.slideJump, speed: mv.out.speed,
        verticalSpeed: mv.out.verticalSpeed, airTime: mv.out.airTime,
      },
    }),

    teleport: (x, y, z, yaw) => {
      mv.teleport(new (w.THREE ? w.THREE.Vector3 : Object)(x, y, z) instanceof Object
        ? Object.assign(Object.create(Object.getPrototypeOf(mv.position)), { x, y, z })
        : { x, y, z }, yaw);
      return V(mv.position);
    },

    /** Runs a script of beats, sampling every fixed step. */
    run: (beats) => {
      const samples = [];
      for (const b of beats) {
        const n = b.frames ?? 1;
        for (let i = 0; i < n; i++) {
          const before = { x: mv.position.x, y: mv.position.y, z: mv.position.z };
          const o = step(b);
          samples.push({
            p: V(mv.position),
            d: Math.hypot(mv.position.x - before.x, mv.position.y - before.y, mv.position.z - before.z),
            v: hs(), vy: mv.velocity.y, g: o.grounded, s: o.state,
            mk: o.mantleKind, wb: o.wallBounce, ts: o.tapStrafe, sj: o.slideJump,
          });
        }
      }
      return samples;
    },
  };
});

/** Places the player using the movement system's own teleport. */
async function place(x, y, z, yaw) {
  return page.evaluate(([px, py, pz, pyaw]) => {
    const mv = globalThis.engine.get('player').movement;
    mv.position.set(px, py, pz);
    mv.teleport(mv.position, pyaw);
    return { x: mv.position.x, y: mv.position.y, z: mv.position.z };
  }, [x, y, z, yaw]);
}

const run = (beats) => page.evaluate((b) => globalThis.__G1__.run(b), beats);
const info = () => page.evaluate(() => globalThis.__G1__.info());
await page.evaluate(() => globalThis.__G1__.setRender(false));

const BTN = { JUMP: 1, CROUCH: 2, PRONE: 4, SPRINT: 8, ADS: 16 };
const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => Math.round(v * 10) / 10;

/* --------------------------------------------------------------------------
 * Find a runway.
 *
 * The spawn is inside a level, not on a test plane — the traversal sweep below
 * finds 43 climbable things within 34 m of it. Measuring a slide or an air-strafe
 * chain along an arbitrary heading measures the nearest wall. So: sprint 2.5 s
 * down 24 candidate headings and keep the one that covered the most ground.
 * Everything momentum-related then runs down that lane.
 * -------------------------------------------------------------------------- */
const spawn = await info();
const report = { renderer: session.renderer, spawn: spawn.position, phases: {} };

const lane = await page.evaluate(([hx, hy, hz]) => {
  const engine = globalThis.engine;
  const mv = engine.get('player').movement;
  const physics = engine.get('physics');
  const V = mv.position.constructor;
  const origin = new V(0, 0, 0);
  const down = new V(0, -1, 0);
  const hit = {
    hit: false, point: new V(0, 0, 0), normal: new V(0, 1, 0), distance: Infinity,
    surface: 'concrete', object: null, entityId: -1, bodyHandle: -1,
    zone: 'none', backface: false,
  };

  // Candidate origins: the spawn plus a golden-angle scatter around it, each
  // dropped onto whatever ground is under it.
  const origins = [{ x: hx, y: hy, z: hz }];
  for (let i = 0; i < 14; i++) {
    const ang = i * 2.399963;
    const rad = 12 + (i % 5) * 9;
    const x = hx + Math.cos(ang) * rad, z = hz + Math.sin(ang) * rad;
    origin.set(x, hy + 30, z);
    physics.raycast(origin, down, 80, 0x203, hit);
    if (hit.hit) origins.push({ x, y: hit.point.y + mv.height * 0.5 + 0.05, z });
  }

  let best = { yaw: 0, dist: -1, origin: origins[0] };
  for (const o of origins) {
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      mv.position.set(o.x, o.y, o.z);
      mv.teleport(mv.position, yaw);
      // 6 s of sprinting: long enough to contain a wind-up plus a full slide or
      // a five-hop strafe chain, which is what the phases below actually need.
      for (let k = 0; k < 720; k++) {
        mv.stepCommand({ seq: 0, tick: 0, dt: 1 / 120, moveX: 0, moveY: 1, yaw, pitch: 0, buttons: 8 });
      }
      const d = Math.hypot(mv.position.x - o.x, mv.position.z - o.z);
      if (d > best.dist) best = { yaw, dist: d, origin: o };
    }
  }
  mv.position.set(best.origin.x, best.origin.y, best.origin.z);
  mv.teleport(mv.position, best.yaw);
  return best;
}, [spawn.position.x, spawn.position.y, spawn.position.z]);
const HOME = lane.origin;
report.lane = { yawDeg: r1(lane.yaw * 180 / Math.PI), clearRunM: r3(lane.dist), origin: HOME };
const YAW = lane.yaw;

/* --- 1. sprint plateau + landing continuity on the real level ------------- */
{
  await place(HOME.x, HOME.y, HOME.z, YAW);
  const s = await run([{ moveY: 1, buttons: BTN.SPRINT, yaw: YAW, frames: 300 }]);
  const settled = s.slice(180);
  const airborne = settled.filter((x) => !x.g).length;
  const launches = settled.filter((x, i) => i > 0 && settled[i - 1].g && x.vy > 0.5).length;
  const steps = settled.map((x) => x.d).sort((a, b) => a - b);
  report.phases.sprint = {
    plateauSpeed: r3(settled[settled.length - 1].v),
    peakSpeed: r3(Math.max(...settled.map((x) => x.v))),
    airborneTicks: airborne, groundLaunches: launches,
    medianStepSpeed: r3((steps[Math.floor(steps.length / 2)] ?? 0) * 120),
    worstStepSpeed: r3((steps[steps.length - 1] ?? 0) * 120),
  };
}

/* --- 2. jump apex / air time, in the real engine --------------------------- */
{
  await place(HOME.x, HOME.y, HOME.z, YAW);
  await run([{ frames: 60, yaw: YAW }]);
  const before = await info();
  const s = await run([
    { buttons: BTN.JUMP, yaw: YAW, frames: 2 },
    { yaw: YAW, frames: 200 },
  ]);
  let apex = 0, air = 0;
  for (const x of s) { if (!x.g) { air++; apex = Math.max(apex, x.p.y - before.position.y); } }
  report.phases.jump = { apexM: r3(apex), airTimeS: r3(air / 120), airTicks: air };
}

/* --- 3. slide from sprint -------------------------------------------------- */
{
  await place(HOME.x, HOME.y, HOME.z, YAW);
  const wind = await run([{ moveY: 1, buttons: BTN.SPRINT, yaw: YAW, frames: 180 }]);
  const entry = wind[wind.length - 1].v;
  const s = await run([{ moveY: 1, buttons: BTN.SPRINT | BTN.CROUCH, yaw: YAW, frames: 320 }]);
  const first = s.findIndex((x) => x.s === 'slide');
  let last = first;
  while (last + 1 < s.length && s[last + 1].s === 'slide') last++;
  const slide = first < 0 ? [] : s.slice(first, last + 1);
  report.phases.slide = {
    entrySpeed: r3(entry),
    peakSpeed: slide.length ? r3(Math.max(...slide.map((x) => x.v))) : 0,
    durationS: r3(slide.length / 120),
    distanceM: r3(slide.reduce((a, x) => a + x.d, 0)),
    exitSpeed: slide.length ? r3(s[last + 1]?.v ?? slide[slide.length - 1].v) : 0,
  };
}

/* --- 4. slide-jump chain --------------------------------------------------- */
{
  await place(HOME.x, HOME.y, HOME.z, YAW);
  const chain = await page.evaluate(([yaw]) => {
    const mv = globalThis.engine.get('player').movement;
    const hs = () => Math.hypot(mv.velocity.x, mv.velocity.z);
    const st = (moveX, moveY, buttons, y) => mv.stepCommand({
      seq: 0, tick: 0, dt: 1 / 120, moveX, moveY, yaw: y, pitch: 0, buttons,
    });
    for (let i = 0; i < 200; i++) st(0, 1, 8, yaw);
    const start = hs();
    const before = mv.slideJumpCount;
    const per = [];
    for (let hop = 0; hop < 3; hop++) {
      for (let k = 0; k < 36; k++) st(0, 1, 8 | 2, yaw);
      st(0, 1, 8 | 2 | 1, yaw);
      let air = 0;
      while (!mv.out.grounded && air++ < 120) st(0, 1, 8, yaw);
      per.push(hs());
    }
    return { start, per, events: mv.slideJumpCount - before };
  }, [YAW]);
  report.phases.slideJump = {
    startSpeed: r3(chain.start), perHop: chain.per.map(r3),
    retentionPct: r1(100 * chain.per[chain.per.length - 1] / chain.start),
    slideJumpEvents: chain.events,
  };
}

/* --- 5. air-strafe: naive vs optimal, on the real level -------------------- */
{
  const strafe = (mode) => page.evaluate(([yaw0, m]) => {
    const mv = globalThis.engine.get('player').movement;
    const CAP = 0.762, KDT = 45 / 120;         // TUNING.airWishCap, airAccel·dt
    const hs = () => Math.hypot(mv.velocity.x, mv.velocity.z);
    const st = (moveX, moveY, buttons, y) => mv.stepCommand({
      seq: 0, tick: 0, dt: 1 / 120, moveX, moveY, yaw: y, pitch: 0, buttons,
    });
    for (let i = 0; i < 320; i++) st(0, 1, 8, yaw0);
    const base = hs();
    let peak = base, yaw = yaw0, dir = 1, hops = 0;
    for (let hop = 0; hop < 5; hop++) {
      st(0, 1, 8 | 1, yaw);
      let air = 0;
      while (!mv.out.grounded && air++ < 200) {
        if (m === 'naive') { st(0, 1, 8, yaw); } else {
          const sp = hs();
          const target = Math.acos(Math.max(-1, Math.min(1, (CAP - KDT) / Math.max(sp, 1e-4))));
          const vAng = Math.atan2(mv.velocity.x, -mv.velocity.z);
          let rel = vAng - yaw0;
          while (rel > Math.PI) rel -= Math.PI * 2;
          while (rel < -Math.PI) rel += Math.PI * 2;
          if (rel * dir > 22 * Math.PI / 180) dir = -dir;
          const wishAng = vAng + target * dir;
          const wx = Math.sin(wishAng), wz = -Math.cos(wishAng);
          const want = dir > 0 ? Math.atan2(-wz, wx) : Math.atan2(wz, -wx);
          let d = want - yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const lim = 400 * Math.PI / 180 / 120;   // a turn rate a human can hold
          yaw += Math.max(-lim, Math.min(lim, d));
          st(dir, 0, 8, yaw);
        }
        peak = Math.max(peak, hs());
      }
      if (air > 2) hops++;
    }
    return { base, peak, hops };
  }, [YAW, mode]);

  await place(HOME.x, HOME.y, HOME.z, YAW);
  const naive = await strafe('naive');
  await place(HOME.x, HOME.y, HOME.z, YAW);
  const opt = await strafe('strafe');
  report.phases.airStrafe = {
    groundPlateau: r3(naive.base),
    naivePeak: r3(naive.peak), naiveRatio: r3(naive.peak / naive.base),
    optimalPeak: r3(opt.peak), optimalRatio: r3(opt.peak / opt.base),
    naiveHops: naive.hops, optimalHops: opt.hops,
  };
}

/* --- 6. traversal sweep: how much of the REAL level is now climbable ------- */
{
  const sweep = await page.evaluate(() => {
    const w = globalThis;
    const engine = w.engine;
    const mv = engine.get('player').movement;
    const physics = engine.get('physics');
    const THREE = mv.position.constructor;
    const origin = new THREE(0, 0, 0);
    const down = new THREE(0, -1, 0);
    const hit = {
      hit: false, point: new THREE(0, 0, 0), normal: new THREE(0, 1, 0),
      distance: Infinity, surface: 'concrete', object: null, entityId: -1,
      bodyHandle: -1, zone: 'none', backface: false,
    };

    const home = { x: mv.position.x, y: mv.position.y, z: mv.position.z };
    let attempts = 0, mantles = 0, climbs = 0, vaults = 0, mids = 0;
    const heights = [];
    const before = mv.mantleCount;

    // Golden-angle ring walk around the spawn: at each sample, drop to the
    // ground, face outward, sprint and jump into whatever is there.
    for (let i = 0; i < 96; i++) {
      const ang = i * 2.399963;
      const rad = 6 + (i % 8) * 4;
      const x = home.x + Math.cos(ang) * rad;
      const z = home.z + Math.sin(ang) * rad;
      origin.set(x, home.y + 30, z);
      physics.raycast(origin, down, 80, 0x203, hit);
      if (!hit.hit) continue;
      mv.position.set(x, hit.point.y + mv.height * 0.5 + 0.05, z);
      const yaw = Math.atan2(-(x - home.x), -(z - home.z)) + Math.PI;
      mv.teleport(mv.position, yaw);
      attempts++;
      const start = mv.mantleCount;
      let kind = '', h = 0;
      for (let k = 0; k < 220; k++) {
        const o = mv.stepCommand({
          seq: 0, tick: 0, dt: 1 / 120, moveX: 0, moveY: 1, yaw, pitch: 0,
          buttons: 8 | (k > 10 && k % 24 < 4 ? 1 : 0),
        });
        if (o.mantleStarted) { kind = o.mantleKind; h = o.mantleHeight; }
      }
      if (mv.mantleCount > start) {
        mantles++;
        heights.push(Math.round(h * 100) / 100);
        if (kind === 'climb') climbs++;
        else if (kind === 'mantle') mids++;
        else vaults++;
      }
    }
    mv.position.set(home.x, home.y, home.z);
    mv.teleport(mv.position, Math.PI);
    return {
      attempts, mantles, vaults, mids, climbs, heights,
      totalMantleEvents: mv.mantleCount - before,
    };
  });
  report.phases.traversal = {
    ...sweep,
    maxHeightM: sweep.heights.length ? Math.max(...sweep.heights) : 0,
    tallerThanCharacter: sweep.heights.filter((h) => h > 1.8).length,
  };
}

/* --- 7. wall interaction on real geometry: no launches, no lost momentum --- */
{
  await place(spawn.position.x, spawn.position.y, spawn.position.z, Math.PI);
  const s = await run([
    { moveY: 1, buttons: BTN.SPRINT, yaw: Math.PI, frames: 200 },
    { moveY: 1, moveX: 0.6, buttons: BTN.SPRINT, yaw: Math.PI * 0.6, frames: 200 },
    { moveY: 1, moveX: -0.6, buttons: BTN.SPRINT, yaw: -Math.PI * 0.3, frames: 200 },
    { moveY: 1, buttons: BTN.SPRINT, yaw: 0, frames: 200 },
  ]);
  const grounded = s.filter((x) => x.g);
  let launches = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1].g && s[i].vy > 0.5 && s[i].s !== 'mantle') launches++;
  }
  const steps = grounded.map((x) => x.d).sort((a, b) => a - b);
  report.phases.wander = {
    ticks: s.length, groundedTicks: grounded.length, groundLaunches: launches,
    medianStepM: r3(steps[Math.floor(steps.length / 2)] ?? 0),
    p999StepM: r3(steps[Math.floor(steps.length * 0.999)] ?? 0),
    worstStepM: r3(steps[steps.length - 1] ?? 0),
    counters: (await info()).counters,
  };
}

report.consoleErrors = session.errors.slice(0, 10);
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(SHOTS, 'ingame.json'), JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));

await session.close?.();
await stopServer();
