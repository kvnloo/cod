#!/usr/bin/env node
/**
 * Scripted play SESSION — the gate that a still screenshot can never be.
 *
 * Eight iteration waves verified this game with static frames. A static frame
 * cannot show that the framerate is bad, that an enemy needs a minute to kill
 * you, that no enemy spawned at all, or that a kerb launches the player into
 * the air. A human found every one of those in thirty seconds of play. This
 * file plays the game instead of photographing it, and turns what it feels
 * into numbers.
 *
 * Two clocks are used deliberately and never mixed:
 *
 *   • SIM time  — `engine.stepFrame(1/120)` in a tight loop. Every gameplay
 *     number (time-to-kill, time-to-die, damage cadence, movement continuity)
 *     is measured here, because it is exactly reproducible for a given seed and
 *     independent of how fast the host machine happens to be.
 *   • WALL time — the real `requestAnimationFrame` loop, free-running with
 *     vsync disabled. Every frame-time number is measured here, because that is
 *     the only clock a player actually feels.
 *
 * Usage
 *   node tools/playtest.mjs                       # full session, all gates
 *   node tools/playtest.mjs --no-build            # reuse dist-gp-h
 *   node tools/playtest.mjs --quality ultra       # answer "was it ultra mode?"
 *   node tools/playtest.mjs --json out/report.json
 *
 * Exits non-zero when any HARD gate fails, so it drops straight into CI.
 * See docs/PLAYTEST.md for what each gate means.
 */

import { openSession, ensureServer, stopServer, ROOT, sleep, percentile } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';

/**
 * Chromium writes its whole throwaway profile into TMPDIR, and on this box /tmp
 * is a 7.8 GB tmpfs shared with every other agent. A full /tmp makes the browser
 * die with `FATAL … No space left on device` *after* the game has already
 * booted, which reads as a mysterious 180 s readiness timeout. Park the profile
 * somewhere with room instead, so a full /tmp cannot silently invalidate a run.
 */
export function ensureScratchTmp() {
  const free = (p) => {
    try { const s = statfsSync(p); return s.bavail * s.bsize; } catch { return 0; }
  };
  if (free(process.env.TMPDIR || '/tmp') > 2 * 1024 ** 3) return process.env.TMPDIR || '/tmp';
  for (const base of ['/dev/shm', path.join(ROOT, '.playtest-tmp')]) {
    try {
      const dir = path.join(base, 'blackout-playtest');
      mkdirSync(dir, { recursive: true });
      if (free(dir) > 2 * 1024 ** 3) { process.env.TMPDIR = dir; return dir; }
    } catch { /* try the next candidate */ }
  }
  console.warn('[playtest] WARNING: no scratch filesystem with 2 GB free; Chromium may abort mid-run');
  return process.env.TMPDIR || '/tmp';
}
ensureScratchTmp();

/* ------------------------------------------------------------------- args -- */

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const CFG = {
  port: Number(flag('port', 9901)),
  dist: String(flag('dist', 'dist-gp-h')),
  quality: String(flag('quality', 'high')),
  width: Number(flag('w', 1920)),
  height: Number(flag('h', 1080)),
  seed: Number(flag('seed', 1337)),
  mode: String(flag('mode', 'operation')),
  liveMs: Number(flag('live-ms', 14000)),
  warmupMs: Number(flag('warmup-ms', 2000)),
  ttdEnemies: Number(flag('ttd-enemies', 3)),
  ttdRange: Number(flag('ttd-range', 12)),
  ttdCapS: Number(flag('ttd-cap', 60)),
  ttdTrials: Number(flag('ttd-trials', 3)),
  ttdAccuracy: Number(flag('ttd-accuracy', 0)),   // 0 = leave the director's own scalar alone
  p99Budget: Number(flag('p99', 16.7)),
  ranges: String(flag('ranges', '10,25,50')).split(',').map(Number),
  weapons: String(flag('weapons', 'ar_vkr7,smg_hornet,lmg_vulcan,pi_sidewinder')).split(','),
  json: String(flag('json', path.join('shots', 'playtest', 'report.json'))),
  build: !has('no-build'),
  quiet: has('quiet'),
};

/* --------------------------------------------------------------- gate spec -- */

/**
 * Every gate carries the number it checks, where the number came from, and
 * whether a violation should fail the process. `hard: false` gates are reported
 * but never fail CI — they are the ones whose "correct" value this wave is
 * still actively choosing, so failing on them would be noise, not signal.
 */
const GATES = [
  {
    id: 'enemies-spawned', hard: true,
    what: 'combatants actually spawned into the shipping game',
    target: '> 0',
    read: (r) => r.enemies.spawned,
    ok: (v) => v > 0,
    why: 'src/game/GameDirector.ts:63 — asActorAPI() returns null, so the whole '
      + 'src/ai/ stack is bypassed and BotFallback is installed instead. If even '
      + 'the fallback stops spawning there is literally no game to play.',
  },
  {
    id: 'time-to-die', hard: true,
    what: `time to actually DIE standing still in front of ${CFG.ttdEnemies} engaging enemies (ms)`,
    target: '<= 8000',
    read: (r) => r.combat.ttd.toDeathMs,
    ok: (v) => Number.isFinite(v) && v <= 8000,
    why: 'The reported bug, verbatim: "after getting downed i would just get shot '
      + 'at for 60s without dying." A player who can stand in the open in front of '
      + 'three rifles has no reason to respect the enemy, and the game stops being one.',
  },
  {
    id: 'down-loop', hard: true,
    what: 'last-stand cycles entered before the player finally died',
    target: '<= 1',
    read: (r) => r.combat.ttd.downCycles,
    ok: (v) => v <= 1,
    why: 'src/game/Lifecycle.ts:201 self-revives after reviveAfter=7 s without damage '
      + 'while bleedout only ever counts down. Sparse incoming fire therefore loops '
      + 'down → revive → down indefinitely. This is the mechanism behind the 60 seconds.',
  },
  {
    id: 'frame-p99', hard: true,
    what: `p99 wall-clock frame time at ${CFG.width}x${CFG.height}/${CFG.quality} (ms)`,
    target: `<= ${CFG.p99Budget}`,
    read: (r) => r.frame.p99,
    ok: (v) => Number.isFinite(v) && v <= CFG.p99Budget,
    why: '16.7 ms is the 60 fps budget. p99 rather than mean, because the framerate '
      + 'a player complains about is the bad frames, not the average.',
  },
  {
    id: 'frame-spikes', hard: true,
    what: 'frames over 50 ms after warm-up',
    target: '== 0',
    read: (r) => r.frame.over50,
    ok: (v) => v === 0,
    why: 'A 50 ms frame is a visible hitch. After warm-up there is no excuse for one.',
  },
  {
    id: 'ttk-lethal', hard: true,
    what: 'weapon/range pairs that never killed a stationary enemy',
    target: '== 0',
    read: (r) => r.combat.ttkFailures,
    ok: (v) => v === 0,
    why: 'A weapon that cannot kill a stationary target with perfect tracking inside '
      + 'twelve seconds is broken, not balanced.',
  },
  {
    id: 'damage-model', hard: true,
    what: 'distinct per-hit damage values observed across every weapon and range',
    target: '>= 3',
    read: (r) => r.combat.distinctHitDamage,
    ok: (v) => v >= 3,
    why: 'src/game/BotFallback.ts:571 resolves EVERY player round as a flat 42 body / '
      + '145 head, ignoring the weapon and the range entirely. The whole src/weapons/ '
      + 'damage-falloff model is dead code in the shipping game: an LMG at 50 m hits '
      + 'exactly as hard as a pistol at 10 m, which is why gunfights do not read as CoD.',
  },
  {
    id: 'hitbox-zones', hard: true,
    what: 'distinct hit zones a bullet ray gets back from a LIVING enemy',
    target: '>= 3 (head + torso + a limb)',
    read: (r) => r.combat.zones.livingEnemyDistinct,
    ok: (v) => v >= 3,
    why: 'src/physics/CharacterController.ts:166 — a living enemy owns exactly one '
      + "collider, registered as zone 'chest'. Headshots and limb damage do not exist "
      + 'at the collider level. This gate scans a live combatant band by band rather '
      + 'than counting a histogram, because a histogram happily counts corpse ragdolls '
      + "and the player's own capsule and looks healthy while living enemies have none.",
  },
  {
    id: 'death-anim', hard: true,
    what: 'fraction of enemy deaths whose skeleton actually moved',
    target: '>= 0.90',
    read: (r) => r.deaths.animatedFraction,
    ok: (v) => Number.isFinite(v) && v >= 0.9,
    why: 'src/characters/anim/clips.ts:420 writes `root` in only ONE key of each death '
      + 'clip, so deaths compile to a single key and the body snaps to a pose instead '
      + 'of falling. src/characters/anim/Clip.ts:92 does the same to every one-shot '
      + 'performance that opens or closes on an empty pose.',
  },
  {
    id: 'motion-continuity', hard: true,
    what: 'fixed steps where the player position jumped further than its velocity allows',
    target: '== 0',
    read: (r) => r.movement.teleports,
    ok: (v) => v === 0,
    why: 'A discontinuous player is a physics bug or a desync. Neither is visible in '
      + 'a screenshot and both are instantly obvious in the hands.',
  },
  {
    id: 'no-free-launch', hard: true,
    what: 'grounded steps that gained upward speed without a jump input',
    target: '== 0',
    read: (r) => r.movement.unexplainedLaunches,
    ok: (v) => v === 0,
    why: 'src/player/Movement.ts:332 — every successful step-up converts horizontal '
      + 'speed into VERTICAL speed, so kerbs and stairs fling the player skyward.',
  },
  {
    id: 'recoil-bounded', hard: true,
    what: 'residual camera recoil 2 s after emptying a magazine (degrees)',
    target: '<= 0.50',
    read: (r) => r.recoil.residualDeg,
    ok: (v) => Number.isFinite(v) && v <= 0.5,
    why: 'src/player/CameraRig.ts:154 — addRecoil parks the impulse in recoilPitch / '
      + 'recoilYaw, only recoverFraction ever returns, and the remainder accumulates '
      + 'without bound and is never folded back into the look angles.',
  },
  {
    id: 'no-console-errors', hard: true,
    what: 'console errors / page errors during the session',
    target: '== 0',
    read: (r) => r.meta.errors.length,
    ok: (v) => v === 0,
    why: 'An exception thrown mid-session invalidates every other number in this report.',
  },
  /* --- advisory: numbers this wave is still choosing ---------------------- */
  {
    id: 'ttk-band', hard: false,
    what: 'automatic-weapon TTK at 10 m with perfect tracking (ms)',
    target: '400..900',
    read: (r) => r.combat.autoTtk10m,
    ok: (v) => Number.isFinite(v) && v >= 400 && v <= 900,
    why: 'Reference points: CoD MW2019 AR core TTK is ~250-400 ms; Apex Legends '
      + 'R-301 on a 200 HP target is ~750-1000 ms. The brief asks for CoD gunplay '
      + 'with a raised TTK because movement now carries the skill expression, so '
      + 'the band sits between the two. Advisory — this is a design choice in flight.',
  },
  {
    id: 'sprint-to-fire', hard: false,
    what: 'delay between dropping sprint and the first round leaving the barrel (ms)',
    target: '80..200',
    read: (r) => r.combat.sprintToFireMs,
    ok: (v) => Number.isFinite(v) && v >= 80 && v <= 200,
    why: 'CoD MW2019 sprint-to-fire runs 80-250 ms by weapon class and is the single '
      + 'biggest reason its gunfights feel committed. src/weapons/Weapons.ts:516 gates '
      + 'firing on stanceSprinting, which drops on the same fixed step sprint ends, so '
      + 'the delay today is zero. Advisory until package tuning lands.',
  },
  {
    id: 'ai-agents', hard: false,
    what: 'agents alive in the real src/ai/ tactical stack',
    target: '> 0',
    read: (r) => r.enemies.aiAgents,
    ok: (v) => v > 0,
    why: 'Advisory until the ActorAPI package lands. Today src/ai/ builds its cover '
      + 'graph and nav grid on every level load for zero agents, and the enemy the '
      + 'player fights is BotFallback.',
  },
];

/* ------------------------------------------------- in-page instrumentation -- */

/**
 * Grabs the live `Input` singleton without importing it.
 *
 * `input` is a module-scoped singleton with no window handle. The only door to
 * it is `__BLACKOUT__.act()`, which calls `input.inject()`. `inject` funnels
 * every action through `Set.prototype.add` on exactly two sets — `downEdges`
 * then `state.actions` — so a one-shot patch on `Set.prototype.add` and a
 * zero-frame `act()` hands both back. `frames: 0` means no frame is stepped and
 * nothing about the game is perturbed.
 */
function INSTALL_INPUT_BRIDGE() {
  const api = globalThis.__BLACKOUT__;
  if (!api) throw new Error('__BLACKOUT__ missing — capture API not armed');
  const SENTINEL = '__pt_bridge__';
  const seen = [];
  const origAdd = Set.prototype.add;
  Set.prototype.add = function (v) {
    if (v === SENTINEL) seen.push(this);
    return origAdd.call(this, v);
  };
  try {
    api.act([{ press: [SENTINEL], hold: [], frames: 0 }]);
  } finally {
    Set.prototype.add = origAdd;
  }
  if (seen.length < 2) throw new Error(`input bridge failed (captured ${seen.length} sets)`);
  const downEdges = seen[0];
  const actions = seen[1];
  downEdges.delete(SENTINEL);
  actions.delete(SENTINEL);

  const MANAGED = ['forward', 'back', 'left', 'right', 'jump', 'crouch', 'prone',
    'sprint', 'fire', 'ads', 'reload', 'melee', 'use'];

  globalThis.__PT_IN__ = { actions, downEdges, MANAGED };
  /** Latches exactly the managed actions in `hold`, and edges those in `press`. */
  globalThis.__PT_HOLD__ = function (hold, press) {
    for (let i = 0; i < MANAGED.length; i++) actions.delete(MANAGED[i]);
    if (hold) for (let i = 0; i < hold.length; i++) actions.add(hold[i]);
    if (press) for (let i = 0; i < press.length; i++) { downEdges.add(press[i]); actions.add(press[i]); }
  };
  return { ok: true, captured: seen.length };
}

/**
 * Installed once as `window.__PT__`. Self-contained on purpose: Playwright
 * ships this as source text, so it may not close over anything in this module.
 *
 * Everything it hooks is a public field or a prototype method. The production
 * build does not mangle property names (verified against dist/assets/index-*.js),
 * so the hooks survive a real `vite build`, which is the only build worth
 * measuring.
 */
function INSTALL_PROBE() {
  const e = globalThis.engine;
  const g = globalThis.__BLACKOUT_GAME__;
  if (!e) throw new Error('window.engine missing — game did not boot');
  if (!g) throw new Error('window.__BLACKOUT_GAME__ missing — director did not install');

  const player = e.get('player');
  const weapons = e.get('weapons');
  const physics = e.tryGet('physics');
  const render = e.tryGet('render');
  const ai = e.tryGet('ai');
  const actors = g.services.actors;
  const actorProto = Object.getPrototypeOf(actors);

  /** RayHit scratch — `PhysicsAPI.raycast` writes into a caller-owned record. */
  const mkHit = () => ({
    hit: false, point: player.position.clone(), normal: player.position.clone(),
    distance: Infinity, surface: 'concrete', object: null,
    entityId: -1, bodyHandle: -1, zone: 'none', backface: false,
  });
  const hitA = mkHit();

  const P = {
    spawnLock: false,   // when set, only tag:'playtest' spawns get through
    spawned: 0, spawnedBlocked: 0, despawned: 0, peakAlive: 0,
    hurts: [], playerDamage: [],
    colliderZones: {}, resolvedZones: { head: 0, body: 0 },
    deaths: [],
    kin: {
      last: null, teleports: [], stepSnaps: [], launches: [], rampGains: 0,
      maxSpeed: 0, steps: 0, expectJump: false, mantles: 0,
    },
    teleportGrace: 4,
    live: null,
  };
  globalThis.__PT__ = P;
  const now = () => e.time.elapsed;

  /* ---------------------------------------------------------- spawn/kill -- */
  const origSpawn = actorProto.spawnCombatant;
  actorProto.spawnCombatant = function (req) {
    if (P.spawnLock && (!req || req.tag !== 'playtest')) { P.spawnedBlocked++; return -1; }
    const id = origSpawn.call(this, req);
    if (id >= 0) P.spawned++;
    return id;
  };
  const origDespawn = actorProto.despawnCombatant;
  actorProto.despawnCombatant = function (id) { P.despawned++; return origDespawn.call(this, id); };

  /* Every enemy health change funnels through `hurt`, whichever path made it. */
  const origHurt = actorProto.hurt;
  actorProto.hurt = function (b, amount, opts) {
    const before = b.health;
    const killed = origHurt.call(this, b, amount, opts);
    const fromPlayer = !opts || opts.fromPlayer !== false;
    if (P.hurts.length < 20000) {
      P.hurts.push({
        t: now(), id: b.id, amount, killed, fromPlayer,
        headshot: !!(opts && opts.headshot), hpBefore: before,
      });
    }
    if (fromPlayer) { if (opts && opts.headshot) P.resolvedZones.head++; else P.resolvedZones.body++; }
    if (killed) watchDeath(b);
    return killed;
  };

  /* Damage the player takes. */
  const origApply = player.applyDamage.bind(player);
  player.applyDamage = function (amount, dir, lethal) {
    const before = player.health;
    origApply(amount, dir, lethal);
    if (P.playerDamage.length < 20000) {
      P.playerDamage.push({ t: now(), amount, lethal: !!lethal, hpBefore: before, hpAfter: player.health });
    }
  };

  /* Teleports we asked for must not be counted as discontinuities. */
  const origTeleport = player.movement.teleport.bind(player.movement);
  player.movement.teleport = function (p, yaw) { P.teleportGrace = 4; return origTeleport(p, yaw); };
  const origSpawnAt = player.spawnAt.bind(player);
  player.spawnAt = function (p, yaw) { P.teleportGrace = 4; return origSpawnAt(p, yaw); };

  /* Hit zones straight off the collider layer. */
  if (physics && physics.raycast) {
    const origRay = physics.raycast.bind(physics);
    physics.raycast = function (o, d, maxD, mask, out, ignore) {
      const h = origRay(o, d, maxD, mask, out, ignore);
      if (h && h.hit && h.zone && h.zone !== 'none') {
        P.colliderZones[h.zone] = (P.colliderZones[h.zone] || 0) + 1;
      }
      return h;
    };
  }

  /* ------------------------------------------------------ death animation -- */
  /* A death "played" when the skeleton or the body actually moved in the 0.5 s
   * after it. A clip that compiled to a single key holds a pose that is
   * bit-identical every frame, which is precisely what this catches. */
  const BONES = ['hips', 'spine', 'chest', 'head', 'upperArmR', 'upperLegL'];
  const watching = [];
  function poseOf(char) {
    const v = [];
    const o = char.object;
    v.push(o.position.x, o.position.y, o.position.z,
      o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w);
    for (let i = 0; i < BONES.length; i++) {
      const b = char.bone ? char.bone(BONES[i]) : null;
      if (b) {
        v.push(b.position.x, b.position.y, b.position.z,
          b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      } else v.push(0, 0, 0, 0, 0, 0, 0);
    }
    return v;
  }
  function watchDeath(b) {
    const rec = {
      t: now(), id: b.id, archetype: b.archetype,
      hadCharacter: !!b.char, ragdoll: false, delta: 0, samples: 0,
    };
    P.deaths.push(rec);
    if (!b.char) return;
    try { watching.push({ rec, char: b.char, base: poseOf(b.char), until: now() + 0.5 }); }
    catch { /* character disposed on the same step */ }
  }
  function tickWatchers() {
    for (let i = watching.length - 1; i >= 0; i--) {
      const w = watching[i];
      try {
        const p = poseOf(w.char);
        let d = 0;
        for (let k = 0; k < p.length; k++) d += Math.abs(p[k] - w.base[k]);
        if (d > w.rec.delta) w.rec.delta = d;
        w.rec.ragdoll = !!w.char.isRagdoll;
      } catch { /* disposed mid-watch */ }
      w.rec.samples++;
      if (now() >= w.until) watching.splice(i, 1);
    }
  }

  /* ---------------------------------------------------- kinematics probe -- */
  e.add({
    name: 'playtest-probe',
    order: 999,
    fixedUpdate(dt) {
      const k = P.kin;
      const p = player.position, v = player.velocity;
      const grounded = player.grounded;
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > k.maxSpeed) k.maxSpeed = speed;
      const grace = P.teleportGrace > 0;
      if (grace) P.teleportGrace--;
      const normalY = player.movement.result ? player.movement.result.groundNormal.y : 1;
      if (player.movement.out.mantleStarted) k.mantles++;
      if (k.last && !grace) {
        const dy = p.y - k.last.py;
        const dp = Math.hypot(p.x - k.last.px, dy, p.z - k.last.pz);
        // How far could the player possibly have moved this step? The larger of
        // the two endpoint speeds times dt, with 3x slack for collide-and-slide
        // and a 25 cm floor for numeric noise.
        const budget = Math.max(0.25, Math.max(speed, k.last.speed) * dt * 3);
        if (dp > budget) {
          // A mostly-vertical hop no taller than the controller's own step
          // height is the stair-climb doing its job, not a desync. Record it,
          // but do not call it a teleport.
          const isStep = Math.abs(dy) >= dp * 0.7 && Math.abs(dy) <= 0.5;
          const rec = {
            t: +now().toFixed(3), dp: +dp.toFixed(4), dy: +dy.toFixed(4),
            budget: +budget.toFixed(4), state: player.state,
          };
          if (isStep) { if (k.stepSnaps.length < 200) k.stepSnaps.push(rec); }
          else if (k.teleports.length < 200) k.teleports.push(rec);
        }
        // A grounded body that gains upward speed with no jump input is a
        // step-up trading horizontal momentum for a launch. Walking onto a ramp
        // legitimately does the same thing, so only count it on FLAT ground
        // (normal within ~8° of vertical), where there is no other explanation.
        const dvy = v.y - k.last.vy;
        if (k.last.grounded && grounded && !k.expectJump && dvy > 0.5) {
          if (normalY > 0.99) {
            if (k.launches.length < 200) {
              k.launches.push({
                t: +now().toFixed(3), dvy: +dvy.toFixed(3), normalY: +normalY.toFixed(4),
                horizontal: +Math.hypot(v.x, v.z).toFixed(2), state: player.state,
              });
            }
          } else k.rampGains++;
        }
      }
      k.expectJump = false;
      k.steps++;
      k.last = { px: p.x, py: p.y, pz: p.z, vy: v.y, speed, grounded };
      tickWatchers();
      const live = actors.liveCount ? actors.liveCount() : 0;
      if (live > P.peakAlive) P.peakAlive = live;
    },
  });

  /* --------------------------------------------------------------- API --- */
  P.api = {
    snapshot() {
      const life = g.match && g.match.lifecycle ? g.match.lifecycle : null;
      return {
        simTime: e.time.elapsed,
        health: player.health, alive: player.alive,
        life: life ? life.state : null,
        downedRemaining: life ? life.downedRemaining : 0,
        live: actors.liveCount ? actors.liveCount() : 0,
        aiAgents: ai && ai.agents ? ai.agents.length : 0,
        aiCover: ai && ai.cover && ai.cover.points ? ai.cover.points.length : 0,
        phase: g.phase,
        pos: [player.position.x, player.position.y, player.position.z],
        state: player.state,
        weapon: weapons.current ? weapons.current.id : null,
        ammo: weapons.current ? weapons.current.ammo : 0,
      };
    },
    setRender(on) { if (render) render.enabled = on !== false; },
    setSpawnLock(on) { P.spawnLock = !!on; },
    markJump() { P.kin.expectJump = true; },
    resetLifecycle() {
      if (g.match && g.match.lifecycle) g.match.lifecycle.reset();
      if (player.revive) player.revive();
      P.teleportGrace = 4;
    },

    /** Finds the yaw with the most unobstructed space, so range tests are real. */
    clearLane(metres) {
      const from = e.camera.position.clone();
      const dir = player.position.clone();
      let best = { yaw: player.camera.yaw, dist: -1 };
      for (let i = 0; i < 48; i++) {
        const yaw = (i / 48) * Math.PI * 2 - Math.PI;
        dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        let dist = metres + 5;
        if (physics && physics.ready) {
          const h = physics.raycast(from, dir, metres + 5, 0xffff, hitA);
          if (h && h.hit) dist = h.distance;
        }
        if (dist > best.dist) best = { yaw, dist };
        if (best.dist > metres + 4.5) break;
      }
      return best;
    },
    /**
     * Points the *effective* view at a world point. The rig adds residual
     * recoil on top of the look angles without ever folding it back in
     * (CameraRig.ts:217), so a naive yaw/pitch assignment drifts off target
     * exactly as fast as the recoil accumulates. Subtracting the residual is
     * what a good player's hand does, and it is what makes a TTK number mean
     * "time to kill", not "time to fight the bug".
     */
    /**
     * Like `clearLane`, but answers the question a range test actually asks:
     * "is there a yaw where a body standing `metres` away is VISIBLE?" An
     * eye-height ray can run clear over a dip that hides a target's chest, which
     * is exactly how a 50 m TTK test silently turns into a terrain test.
     */
    sightLane(metres) {
      if (!physics || !physics.ready) return { yaw: player.camera.yaw, ok: false, groundY: null };
      const base = player.position;
      const probe = base.clone();
      const down = base.clone().set(0, -1, 0);
      let fallback = { yaw: player.camera.yaw, ok: false, groundY: null };
      for (let i = 0; i < 64; i++) {
        // Golden-angle sweep so the first few tries are spread out, not adjacent.
        const yaw = ((i * 0.618034) % 1) * Math.PI * 2 - Math.PI;
        const gx = base.x - Math.sin(yaw) * metres;
        const gz = base.z - Math.cos(yaw) * metres;
        probe.set(gx, base.y + 30, gz);
        const g = physics.raycast(probe, down, 80, 1 | 2, hitA);
        if (!g || !g.hit) continue;
        const groundY = g.point.y;
        probe.set(gx, groundY + 1.1, gz);
        if (physics.lineOfSight(e.camera.position, probe, 1 | 2 | 128)) return { yaw, ok: true, groundY };
        if (!fallback.ok) fallback = { yaw, ok: false, groundY };
      }
      return fallback;
    },
    aimAt(x, y, z, compensate) {
      const cam = e.camera.position;
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
      let yaw = Math.atan2(-dx, -dz);
      let pitch = Math.atan2(dy, Math.hypot(dx, dz));
      if (compensate !== false) {
        const r = player.camera.recoil;
        yaw -= r.yaw;
        pitch -= r.pitch;
      }
      player.camera.yaw = yaw;
      player.camera.pitch = pitch;
    },
    /** Drops a combatant on the ground `metres` down `yaw` from the player. */
    spawnTarget(yaw, metres, opts) {
      const o = opts || {};
      const base = player.position.clone();
      const q = base.clone();
      q.x += -Math.sin(yaw) * metres + (o.lateral || 0) * Math.cos(yaw);
      q.z += -Math.cos(yaw) * metres - (o.lateral || 0) * Math.sin(yaw);
      q.y = base.y - 0.9;
      let grounded = false;
      if (physics && physics.ready) {
        // Drop from well above: at 50 m the terrain can easily be more than a
        // couple of metres off the player's own height, and a target buried in
        // the ground silently absorbs every round.
        const from = q.clone(); from.y = base.y + 30;
        const down = base.clone().set(0, -1, 0);
        const h = physics.raycast(from, down, 80, 1 | 2, hitA);
        if (h && h.hit) { q.y = h.point.y; grounded = true; }
      }
      const id = actors.spawnCombatant({
        archetype: o.archetype || 'rifleman', faction: 'militia', team: 'hostile',
        position: q, yaw: yaw + Math.PI, seed: (o.seed || 1) | 0,
        health: o.health === undefined ? 1 : o.health,
        accuracy: o.accuracy === undefined ? 1 : o.accuracy,
        aggression: o.aggression === undefined ? 1 : o.aggression,
        tag: 'playtest',
      });
      return { id, pos: [q.x, q.y, q.z], grounded };
    },
    /**
     * Casts a bullet-mask ray at each anatomical band of a LIVING combatant and
     * reports the hit zone each one comes back with. This is the structural
     * question — "does a live enemy have head / chest / limb hitboxes at all?" —
     * rather than a histogram, which would happily count corpse ragdolls and the
     * player's own capsule and look healthy while living enemies have none.
     */
    zoneScan(id) {
      const b = this.botState(id);
      if (!b || !physics || !physics.ready) return null;
      const bands = [['head', 0.94], ['chest', 0.72], ['stomach', 0.52], ['arm', 0.68], ['leg', 0.22]];
      const from = e.camera.position;
      const target = player.position.clone();
      const dir = player.position.clone();
      const out = [];
      for (const [band, frac] of bands) {
        target.set(b.pos[0], b.pos[1] + b.height * frac, b.pos[2]);
        dir.copy(target).sub(from);
        const dist = dir.length();
        if (dist < 0.01) continue;
        dir.multiplyScalar(1 / dist);
        const h = physics.raycast(from, dir, dist + 1, 1 | 2 | 4 | 8 | 16 | 128, hitA, 1);
        out.push({
          band,
          zone: h && h.hit ? h.zone : 'nothing-hit',
          entityId: h && h.hit ? h.entityId : -1,
          onTarget: !!(h && h.hit && h.distance <= dist + 0.5),
        });
      }
      const zones = new Set(out.filter((x) => x.onTarget && x.zone !== 'none').map((x) => x.zone));
      return { bands: out, distinctZones: [...zones], distinct: zones.size };
    },
    /** MASK_SIGHT = STATIC | DYNAMIC | GLASS. True when the muzzle can see the point. */
    losTo(x, y, z) {
      if (!physics || !physics.ready || !physics.lineOfSight) return true;
      const to = player.position.clone().set(x, y, z);
      return physics.lineOfSight(e.camera.position, to, 1 | 2 | 128);
    },
    /**
     * Remembers, then restores, a known-open standing position. Idempotent on
     * purpose: every phase runs from the SAME spot, which is most of what keeps
     * a staged combat measurement reproducible between runs.
     */
    markHome(force) {
      if (P.home && !force) return P.home;
      P.home = { p: player.position.clone(), yaw: player.camera.yaw };
      return P.home;
    },
    goHome() {
      if (!P.home) return false;
      player.movement.teleport(P.home.p, P.home.yaw);
      player.camera.reset(P.home.yaw);
      return true;
    },
    clearActors() { if (actors.clear) actors.clear(); },
    setCombat(on) { if (actors.setCombatEnabled) actors.setCombatEnabled(!!on); },
    setFrozen(on) { if (actors.setFrozen) actors.setFrozen(!!on); },
    setAccuracy(k) { if (actors.setAccuracyScale) actors.setAccuracyScale(k); },
    /** Whatever difficulty scalar the director currently has the bots on. */
    accuracyScale() { return actors.accuracyScale === undefined ? 1 : actors.accuracyScale; },
    botState(id) {
      const list = actors.bots || [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.id === id) {
          return {
            alive: b.alive, hp: b.health, max: b.maxHealth, height: b.height,
            pos: [b.position.x, b.position.y, b.position.z],
          };
        }
      }
      return null;
    },
    giveWeapon(id) {
      weapons.give(id);
      const i = weapons.slots.findIndex((s) => s.runtime.id === id);
      if (i >= 0) { weapons.index = i; weapons.equip(i, true); }
      const w = weapons.current;
      return { id: w.id, mode: w.fireMode, ammo: w.ammo, rpm: w.def.rpm, mag: w.def.magSize };
    },
    weaponInfo(metres) {
      const w = weapons.current;
      return {
        id: w.id, mode: w.fireMode, ammo: w.ammo, reserve: w.reserve, reloading: w.reloading,
        rpm: w.def.rpm, mag: w.def.magSize,
        catalogDamage: weapons.damageAtRange ? weapons.damageAtRange(metres) : null,
      };
    },
    refill() {
      const w = weapons.current;
      w.ammo = w.def.magSize;
      w.reserve = w.def.magSize * 8;
      w.reloading = false;
    },
    recoilDeg() {
      const r = player.camera.recoil;
      return { pitch: r.pitch * 180 / Math.PI, yaw: r.yaw * 180 / Math.PI };
    },
    resetCounters() {
      P.hurts.length = 0; P.playerDamage.length = 0; P.deaths.length = 0;
      P.kin.teleports.length = 0; P.kin.stepSnaps.length = 0; P.kin.launches.length = 0;
      P.kin.rampGains = 0; P.kin.mantles = 0;
    },
    counts() {
      return {
        hurts: P.hurts.length, playerDamage: P.playerDamage.length, deaths: P.deaths.length,
      };
    },
    dump(withArrays) {
      return {
        spawned: P.spawned, spawnedBlocked: P.spawnedBlocked, despawned: P.despawned,
        peakAlive: P.peakAlive,
        hurts: withArrays === false ? [] : P.hurts,
        playerDamage: withArrays === false ? [] : P.playerDamage,
        playerDamageCount: P.playerDamage.length,
        hurtCount: P.hurts.length,
        colliderZones: P.colliderZones, colliderDistinct: Object.keys(P.colliderZones).length,
        resolvedZones: P.resolvedZones,
        deaths: P.deaths,
        kin: {
          steps: P.kin.steps, maxSpeed: P.kin.maxSpeed, mantles: P.kin.mantles,
          teleports: P.kin.teleports, stepSnaps: P.kin.stepSnaps,
          launches: P.kin.launches, rampGains: P.kin.rampGains,
        },
      };
    },
  };

  /* --------------------------------------------- wall-clock frame sampler -- */
  /* Wraps `Engine.frame` on the instance. `wall` is the interval between the
   * starts of consecutive frames — the number the player feels. `cpu` is the
   * time spent inside the frame body — the number that separates a CPU-bound
   * frame from a GPU-bound one. */
  P.beginLive = function (timeline) {
    const wall = [], cpu = [], ctx = [];
    const origFrame = e.frame.bind(e);
    let last = -1;
    let cursor = -1;
    const t0 = performance.now();
    P.live = { wall, cpu, ctx, origFrame, t0 };
    e.frame = function () {
      const a = performance.now();
      if (last >= 0) wall.push(a - last);
      last = a;
      if (timeline && timeline.length) {
        const t = (a - t0) / 1000;
        let idx = 0;
        for (let i = 0; i < timeline.length; i++) if (t >= timeline[i].t) idx = i;
        const beat = timeline[idx];
        globalThis.__PT_HOLD__(beat.hold || [], idx !== cursor ? (beat.press || []) : []);
        cursor = idx;
        // Mouse deltas cannot be injected without the Input singleton's own
        // accumulator, so drive the look angles the rig owns instead. Same
        // result at the camera, no synthetic pointer events required.
        if (beat.lookX) player.camera.yaw += beat.lookX * 0.0016;
        if (beat.lookY) player.camera.pitch += beat.lookY * 0.0016;
      }
      origFrame();
      cpu.push(performance.now() - a);
      const rs = render && render.stats ? render.stats() : null;
      ctx.push({
        t: +(a - t0).toFixed(2),
        dc: rs ? rs.drawCalls : 0,
        tri: rs ? rs.triangles : 0,
        gpu: rs ? +rs.gpuMs.toFixed(3) : 0,
        px: +player.position.x.toFixed(2),
        py: +player.position.y.toFixed(2),
        pz: +player.position.z.toFixed(2),
        yaw: +player.camera.yaw.toFixed(3),
        pitch: +player.camera.pitch.toFixed(3),
        st: player.state,
        live: actors.liveCount ? actors.liveCount() : 0,
        hp: Math.round(player.health),
      });
    };
    e.cameraLockedByCapture = false;
    e.start();
  };

  P.endLive = function () {
    const L = P.live;
    e.stop();
    e.frame = L.origFrame;
    P.live = null;
    globalThis.__PT_HOLD__([], []);
    return { wall: L.wall, cpu: L.cpu, ctx: L.ctx, durationMs: performance.now() - L.t0 };
  };

  return {
    ok: true,
    systems: e.systems.map((s) => s.name),
    aiAgents: ai && ai.agents ? ai.agents.length : 0,
    aiCover: ai && ai.cover && ai.cover.points ? ai.cover.points.length : 0,
    aiNavCells: ai && ai.nav && ai.nav.cells ? (ai.nav.cells.length || ai.nav.cells.size || 0) : 0,
    actorBackend: actorProto.constructor.name,
    weapons: weapons.slots.map((s) => s.runtime.id),
  };
}

/* ------------------------------------------------------------- statistics -- */

function stats(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  const n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  const count = (thr) => samples.reduce((a, v) => a + (v > thr ? 1 : 0), 0);
  return {
    frames: n,
    mean: n ? +(sum / n).toFixed(3) : 0,
    p50: +percentile(s, 50).toFixed(3),
    p95: +percentile(s, 95).toFixed(3),
    p99: +percentile(s, 99).toFixed(3),
    p999: +percentile(s, 99.9).toFixed(3),
    worst: n ? +s[n - 1].toFixed(3) : 0,
    over16_7: count(16.7),
    over33: count(33),
    over50: count(50),
    fps: n && sum ? +((n / sum) * 1000).toFixed(1) : 0,
  };
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * CPU vs GPU bound. If the frame body accounts for nearly all of the wall
 * interval the CPU is the wall; if the GL timer query says the GPU was busy for
 * nearly all of it, the GPU is. Anything else is a present / driver stall.
 */
function classify(wallP50, cpuP50, gpuMean) {
  if (!wallP50) return 'unknown';
  const c = cpuP50 / wallP50;
  const gg = gpuMean ? gpuMean / wallP50 : 0;
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  if (c >= 0.85) return `cpu-bound (frame body is ${pct(c)} of the frame)`;
  if (gg >= 0.85) return `gpu-bound (GL timer query is ${pct(gg)} of the frame)`;
  if (gg >= c) return `gpu-leaning (gpu ${pct(gg)}, cpu ${pct(c)})`;
  return `cpu-leaning (cpu ${pct(c)}, gpu ${pct(gg)})`;
}

/* ------------------------------------------------------------------ phases -- */

/** Traversal beats. Each is (hold, press, frames) at the 120 Hz fixed step. */
const MOVE_BEATS = [
  { label: 'idle', hold: [], frames: 60 },
  { label: 'walk', hold: ['forward'], frames: 180 },
  { label: 'sprint', hold: ['forward', 'sprint'], frames: 240 },
  { label: 'slide', hold: ['forward', 'sprint', 'crouch'], frames: 150 },
  { label: 'slide-jump', hold: ['forward', 'sprint', 'jump'], frames: 120, jump: true },
  { label: 'strafe-left', hold: ['forward', 'left'], frames: 120 },
  { label: 'strafe-right', hold: ['forward', 'right'], frames: 120 },
  { label: 'bhop-1', hold: ['forward', 'jump'], frames: 90, jump: true },
  { label: 'bhop-2', hold: ['forward', 'jump'], frames: 90, jump: true },
  { label: 'backpedal', hold: ['back'], frames: 120 },
  { label: 'crouch-walk', hold: ['forward', 'crouch'], frames: 120 },
  { label: 'settle', hold: [], frames: 60 },
];

async function runMovement(session) {
  return session.exec((beats) => {
    const P = globalThis.__PT__;
    const a = P.api;
    const e = globalThis.engine;
    const player = e.get('player');
    const hold = globalThis.__PT_HOLD__;
    a.setRender(false);
    a.setSpawnLock(true);
    a.resetCounters();

    a.markHome();
    const out = [];
    for (const beat of beats) {
      // Every beat starts from the same known-open spot facing the most open
      // direction. Otherwise a beat that inherits the previous one's corner
      // reports a bogus 0.01 m of travel and silently poisons the numbers.
      a.goHome();
      const lane = a.clearLane(28);
      player.camera.yaw = lane.yaw;
      player.camera.pitch = 0;
      const t0 = e.time.elapsed;
      const p0 = player.position.clone();
      let peak = 0, air = 0, maxY = p0.y, minY = p0.y;
      for (let i = 0; i < beat.frames; i++) {
        if (beat.jump) a.markJump();
        hold(beat.hold, []);
        e.stepFrame(1 / 120);
        const v = player.velocity;
        const hs = Math.hypot(v.x, v.z);
        if (hs > peak) peak = hs;
        if (!player.grounded) air++;
        if (player.position.y > maxY) maxY = player.position.y;
        if (player.position.y < minY) minY = player.position.y;
      }
      hold([], []);
      const p1 = player.position;
      const travel = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const seconds = e.time.elapsed - t0;
      out.push({
        label: beat.label,
        seconds: +seconds.toFixed(3),
        peakHorizontalMs: +peak.toFixed(3),
        meanHorizontalMs: +(travel / Math.max(0.001, seconds)).toFixed(3),
        travelM: +travel.toFixed(3),
        airFrames: air,
        riseM: +(maxY - minY).toFixed(3),
        endState: player.state,
        // A beat that goes nowhere ran into level geometry; its speed numbers
        // describe the wall, not the movement model.
        blockedByGeometry: beat.hold.length > 0 && travel < peak * seconds * 0.25,
      });
    }
    const d = a.dump(false);
    a.setSpawnLock(false);
    a.setRender(true);
    return {
      beats: out,
      maxSpeedMs: +d.kin.maxSpeed.toFixed(3),
      mantles: d.kin.mantles,
      teleports: d.kin.teleports.length,
      teleportSample: d.kin.teleports.slice(0, 8),
      stepSnaps: d.kin.stepSnaps.length,
      stepSnapSample: d.kin.stepSnaps.slice(0, 6),
      unexplainedLaunches: d.kin.launches.length,
      launchSample: d.kin.launches.slice(0, 8),
      rampGainsIgnored: d.kin.rampGains,
      steps: d.kin.steps,
    };
  }, MOVE_BEATS);
}

async function runTtk(session) {
  const rows = [];
  // One staging yaw per range: a 50 m test needs a 50 m sightline, and the yaw
  // that gives you one is not necessarily the yaw that works at 10 m.
  const lanes = {};
  for (const m of CFG.ranges) {
    lanes[m] = await session.exec((v) => globalThis.__PT__.api.sightLane(v), m);
  }
  for (const weapon of CFG.weapons) {
    for (const rangeM of CFG.ranges) {
      const row = await session.exec(([weaponId, metres, yaw, capS]) => {
        const P = globalThis.__PT__;
        const a = P.api;
        const e = globalThis.engine;
        const hold = globalThis.__PT_HOLD__;
        a.setRender(false);
        a.setSpawnLock(true);
        a.clearActors();
        a.setCombat(false);   // the target must not shoot back
        a.setFrozen(true);    // …and must not walk out of the lane
        const info = a.giveWeapon(weaponId);
        a.refill();
        const spawn = a.spawnTarget(yaw, metres, { archetype: 'rifleman', health: 1, seed: 7 });
        if (spawn.id < 0) {
          a.setCombat(true); a.setFrozen(false); a.setSpawnLock(false); a.setRender(true);
          return null;
        }
        const bot = a.botState(spawn.id);
        const aimY = spawn.pos[1] + bot.height * 0.62;   // centre mass
        // A target with no sightline measures the level, not the weapon. Say so
        // rather than reporting a bogus "never killed".
        const los = a.losTo(spawn.pos[0], aimY, spawn.pos[2]);

        // Settle into ADS first. Every published TTK figure is an aimed one,
        // and hip-fire bloom would otherwise be measuring the spread model.
        for (let i = 0; i < 90; i++) {
          a.aimAt(spawn.pos[0], aimY, spawn.pos[2]);
          hold(['ads'], []);
          e.stepFrame(1 / 120);
        }

        const hurts0 = P.hurts.length;
        const auto = info.mode === 'auto';
        let tFirstShot = -1, tKill = -1, shots = 0;
        let lastAmmo = e.get('weapons').current.ammo;
        const maxSteps = Math.ceil(capS * 120);
        for (let i = 0; i < maxSteps; i++) {
          a.aimAt(spawn.pos[0], aimY, spawn.pos[2]);   // perfect tracking + recoil control
          // auto: hold the trigger. semi/burst: pump it so the refire latch clears.
          hold(auto || (i & 1) === 0 ? ['ads', 'fire'] : ['ads'], []);
          e.stepFrame(1 / 120);
          const w = e.get('weapons').current;
          if (w.ammo < lastAmmo) {
            shots += lastAmmo - w.ammo;
            if (tFirstShot < 0) tFirstShot = e.time.elapsed;
          }
          lastAmmo = w.ammo;
          // Reloading is measured elsewhere; here it would only add noise.
          if (w.reloading || w.ammo === 0) { a.refill(); lastAmmo = w.def.magSize; }
          const b = a.botState(spawn.id);
          if (!b || !b.alive) { tKill = e.time.elapsed; break; }
        }
        hold([], []);
        const hurts = P.hurts.slice(hurts0).filter((h) => h.fromPlayer);
        const total = hurts.reduce((s, h) => s + h.amount, 0);
        const wi = a.weaponInfo(metres);
        a.setCombat(true); a.setFrozen(false); a.setSpawnLock(false); a.setRender(true);
        return {
          weapon: weaponId, rangeM: metres, fireMode: info.mode, rpm: info.rpm,
          ttkMs: tKill > 0 && tFirstShot > 0 ? (tKill - tFirstShot) * 1000 : null,
          shotsFired: shots, hits: hurts.length,
          headshots: hurts.filter((h) => h.headshot).length,
          damagePerHit: hurts.length ? +(total / hurts.length).toFixed(2) : null,
          totalDamage: +total.toFixed(1),
          catalogDamage: wi.catalogDamage === null ? null : +wi.catalogDamage.toFixed(2),
          accuracy: shots ? +(hurts.length / shots).toFixed(3) : 0,
          targetHp: bot.max,
          lineOfSight: los, targetGrounded: spawn.grounded,
        };
      }, [weapon, rangeM, lanes[rangeM].yaw, 12]);
      if (row) { row.stagedWithSightline = lanes[rangeM].ok; rows.push(row); }
    }
  }
  const dmgs = new Set(rows.filter((r) => r.damagePerHit !== null).map((r) => Math.round(r.damagePerHit * 10) / 10));
  const auto10 = rows.filter((r) => r.fireMode === 'auto' && r.rangeM === CFG.ranges[0] && r.ttkMs !== null);
  return {
    rows,
    // Only a target the muzzle could actually see counts against lethality.
    failures: rows.filter((r) => r.ttkMs === null && r.lineOfSight).length,
    skippedNoSightline: rows.filter((r) => !r.lineOfSight).length,
    distinctHitDamage: dmgs.size,
    distinctHitDamageValues: [...dmgs],
    autoTtk10m: auto10.length ? +(auto10.reduce((s, r) => s + r.ttkMs, 0) / auto10.length).toFixed(1) : NaN,
  };
}

/**
 * Kills a squad on purpose, so the death-animation and hit-zone gates have data
 * instead of a divide-by-zero. Half the shots are aimed at the head and half at
 * centre mass, which is also the cleanest probe for whether zone-specific
 * hitboxes exist at all.
 */
async function runKills(session, count = 6) {
  return session.exec((n) => {
    const P = globalThis.__PT__;
    const a = P.api;
    const e = globalThis.engine;
    const hold = globalThis.__PT_HOLD__;
    a.setRender(false);
    a.setSpawnLock(true);
    a.clearActors();
    a.setCombat(false);
    a.setFrozen(true);
    a.giveWeapon('ar_vkr7');
    a.refill();
    a.resetCounters();

    a.markHome();
    const killed = [];
    let scan = null;
    for (let k = 0; k < n; k++) {
      a.goHome();
      // Walk the target in until the muzzle can actually see its chest. A body
      // behind a crate is a level-geometry test, not a lethality test.
      let spawn = null, bot = null;
      for (const metres of [10, 8, 6, 4]) {
        const lane = a.sightLane(metres);
        const s = a.spawnTarget(lane.yaw, metres, { seed: 200 + k });
        if (s.id < 0) continue;
        const b = a.botState(s.id);
        if (a.losTo(s.pos[0], s.pos[1] + b.height * 0.6, s.pos[2])) { spawn = s; bot = b; break; }
        a.clearActors();
      }
      if (!spawn) { killed.push({ id: -1, aimedAt: 'n/a', died: false, reason: 'no line of sight' }); continue; }
      // Before killing it: what hitboxes does a LIVING enemy actually own?
      if (!scan) scan = a.zoneScan(spawn.id);
      // Alternate head / centre mass so both zones get exercised.
      const aimY = spawn.pos[1] + bot.height * (k % 2 === 0 ? 0.93 : 0.6);
      for (let i = 0; i < 90; i++) { a.aimAt(spawn.pos[0], aimY, spawn.pos[2]); hold(['ads'], []); e.stepFrame(1 / 120); }
      let died = false;
      for (let i = 0; i < 720; i++) {
        a.aimAt(spawn.pos[0], aimY, spawn.pos[2]);
        hold(['ads', 'fire'], []);
        e.stepFrame(1 / 120);
        const w = e.get('weapons').current;
        if (w.reloading || w.ammo === 0) a.refill();
        const b = a.botState(spawn.id);
        if (!b || !b.alive) { died = true; break; }
      }
      hold([], []);
      // Let the death performance run so the pose watcher has something to see.
      for (let i = 0; i < 90; i++) e.stepFrame(1 / 120);
      killed.push({ id: spawn.id, aimedAt: k % 2 === 0 ? 'head' : 'chest', died });
    }
    const d = a.dump(false);
    a.setCombat(true); a.setFrozen(false); a.setSpawnLock(false); a.setRender(true);
    return {
      attempted: n, killed: killed.filter((x) => x.died).length, detail: killed,
      livingEnemyZoneScan: scan,
      deathRecords: d.deaths,
      colliderZones: d.colliderZones,
      resolvedZones: d.resolvedZones,
      hits: d.hurtCount,
    };
  }, count);
}

async function runRecoil(session) {
  return session.exec(() => {
    const P = globalThis.__PT__;
    const a = P.api;
    const e = globalThis.engine;
    const hold = globalThis.__PT_HOLD__;
    a.setRender(false);
    a.setSpawnLock(true);
    a.clearActors();
    a.giveWeapon('ar_vkr7');
    a.refill();

    /* --- unbounded recoil: empty a magazine, then let it settle for 2 s --- */
    const before = a.recoilDeg();
    const mag = e.get('weapons').current.def.magSize;
    let peak = 0, fired = 0;
    let lastAmmo = e.get('weapons').current.ammo;
    for (let i = 0; i < 900; i++) {
      hold(['fire'], []);
      e.stepFrame(1 / 120);
      const w = e.get('weapons').current;
      if (w.ammo < lastAmmo) fired += lastAmmo - w.ammo;
      lastAmmo = w.ammo;
      const r = a.recoilDeg();
      const m = Math.hypot(r.pitch, r.yaw);
      if (m > peak) peak = m;
      if (w.ammo === 0 || w.reloading) break;
    }
    hold([], []);
    const atRelease = a.recoilDeg();
    for (let i = 0; i < 240; i++) e.stepFrame(1 / 120);   // 2 s of recovery
    const after = a.recoilDeg();

    /* --- sprint-to-fire: sprint, then pull the trigger the instant it drops -- */
    a.refill();
    for (let i = 0; i < 300; i++) { hold(['forward', 'sprint'], []); e.stepFrame(1 / 120); }
    const ammoBefore = e.get('weapons').current.ammo;
    const tRelease = e.time.elapsed;
    let tShot = -1;
    for (let i = 0; i < 240; i++) {
      hold(['fire'], []);        // sprint drops on the same step fire begins
      e.stepFrame(1 / 120);
      if (e.get('weapons').current.ammo < ammoBefore) { tShot = e.time.elapsed; break; }
    }
    hold([], []);
    a.setSpawnLock(false);
    a.setRender(true);
    return {
      recoil: {
        magazine: mag, roundsFired: fired,
        peakDeg: +peak.toFixed(3),
        atReleaseDeg: +Math.hypot(atRelease.pitch, atRelease.yaw).toFixed(3),
        residualDeg: +Math.hypot(after.pitch - before.pitch, after.yaw - before.yaw).toFixed(3),
        residualPitchDeg: +(after.pitch - before.pitch).toFixed(3),
        residualYawDeg: +(after.yaw - before.yaw).toFixed(3),
      },
      sprintToFireMs: tShot > 0 ? +((tShot - tRelease) * 1000).toFixed(2) : null,
    };
  });
}

async function runTtd(session) {
  // Three trials, gated on the median. A single trial swings by several seconds
  // run to run — the bots' fire timers and burst cadence come off a shared RNG
  // whose position depends on everything that happened before — and a hard gate
  // that flaps is worse than no gate.
  const trials = [];
  for (let t = 0; t < CFG.ttdTrials; t++) trials.push(await runTtdOnce(session, t));
  const sorted = trials.slice().sort((a, b) => a.toDeathMs - b.toDeathMs);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    ...median,
    trials: trials.length,
    toDeathMsAll: trials.map((x) => x.toDeathMs),
    toDeathMsMin: sorted[0].toDeathMs,
    toDeathMsMax: sorted[sorted.length - 1].toDeathMs,
    downCycles: Math.max(...trials.map((x) => x.downCycles)),
    trialDetail: trials.map((x) => ({
      trial: x.trial, firstDamageMs: x.firstDamageMs, toDownedMs: x.toDownedMs,
      toDeathMs: x.toDeathMs, downCycles: x.downCycles,
      damageEventsPerSec: x.damageEventsPerSec, enemiesAlive: x.enemiesAlive,
    })),
  };
}

async function runTtdOnce(session, trial) {
  const staged = await session.exec(([n, metres, forceAccuracy]) => {
    const a = globalThis.__PT__.api;
    a.setRender(false);
    a.setSpawnLock(true);
    a.clearActors();
    a.setCombat(true);
    a.setFrozen(false);
    a.markHome();
    a.goHome();
    // Do NOT normalise difficulty. The number this phase exists to produce is
    // how long the player survives in the game as shipped, and the director's
    // own accuracy scalar is part of that.
    if (forceAccuracy > 0) a.setAccuracy(forceAccuracy);
    a.resetLifecycle();
    const lane = a.sightLane(metres);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const r = a.spawnTarget(lane.yaw, metres, { seed: 40 + i, lateral: (i - (n - 1) / 2) * 2.4 });
      if (r.id >= 0) ids.push(r.id);
    }
    a.resetCounters();
    const s = a.snapshot();
    return {
      ids, yaw: lane.yaw, sightline: lane.ok, accuracyScale: a.accuracyScale(),
      health: s.health, life: s.life, live: s.live,
    };
  }, [CFG.ttdEnemies, CFG.ttdRange, CFG.ttdAccuracy]);

  const run = await session.exec(([capS, yaw]) => {
    const P = globalThis.__PT__;
    const a = P.api;
    const e = globalThis.engine;
    const g = globalThis.__BLACKOUT_GAME__;
    const player = e.get('player');
    const life = g.match && g.match.lifecycle ? g.match.lifecycle : null;
    const hold = globalThis.__PT_HOLD__;

    const t0 = e.time.elapsed;
    const hp0 = player.health;
    let tFirst = -1, tZero = -1, tDowned = -1, tDead = -1;
    let downCycles = 0, wasDowned = false;
    const trace = [];
    const steps = Math.ceil(capS * 120);
    for (let i = 0; i < steps; i++) {
      hold([], []);                // stand perfectly still, do not fight back
      player.camera.yaw = yaw;     // …but face them, so this is not a stealth test
      player.camera.pitch = 0;
      e.stepFrame(1 / 120);
      const t = e.time.elapsed - t0;
      if (tFirst < 0 && player.health < hp0 - 0.01) tFirst = t;
      if (tZero < 0 && player.health <= 0.01) tZero = t;
      const st = life ? life.state : (player.alive ? 'alive' : 'dead');
      if (st === 'downed') { if (!wasDowned) { downCycles++; if (tDowned < 0) tDowned = t; } wasDowned = true; }
      else wasDowned = false;
      if (st === 'dead' || st === 'respawning') { tDead = t; break; }
      if (i % 120 === 0) {
        trace.push({ t: +t.toFixed(2), hp: +player.health.toFixed(1), st, live: a.snapshot().live });
      }
    }
    hold([], []);
    const d = a.dump();
    const dmg = d.playerDamage;
    const span = tDead > 0 ? tDead : capS;
    a.setSpawnLock(false);
    a.setRender(true);
    return {
      enemiesAlive: a.snapshot().live,
      firstDamageMs: tFirst > 0 ? +(tFirst * 1000).toFixed(1) : null,
      toZeroHealthMs: tZero > 0 ? +(tZero * 1000).toFixed(1) : null,
      toDownedMs: tDowned > 0 ? +(tDowned * 1000).toFixed(1) : null,
      toDeathMs: tDead > 0 ? +(tDead * 1000).toFixed(1) : Infinity,
      capMs: capS * 1000,
      downCycles,
      damageEvents: dmg.length,
      damageEventsPerSec: +(span > 0 ? dmg.length / span : 0).toFixed(3),
      totalDamageTaken: +dmg.reduce((s, x) => s + x.amount, 0).toFixed(1),
      meanDamagePerHit: dmg.length ? +(dmg.reduce((s, x) => s + x.amount, 0) / dmg.length).toFixed(2) : 0,
      healthTrace: trace,
    };
  }, [CFG.ttdCapS, staged.yaw]);
  run.trial = trial;
  run.spawnedForTest = staged.ids.length;
  run.stagedWithSightline = staged.sightline;
  run.accuracyScale = staged.accuracyScale;
  run.rangeM = CFG.ttdRange;
  return run;
}

/** A minute of the play the user actually described: run, sprint, slide, shoot. */
const LIVE_TIMELINE = [
  { t: 0.0, hold: ['forward'] },
  { t: 1.0, hold: ['forward', 'sprint'] },
  { t: 2.5, hold: ['forward', 'sprint', 'crouch'] },
  { t: 3.2, hold: ['forward', 'sprint', 'jump'] },
  { t: 4.0, hold: ['forward', 'left'] },
  { t: 5.0, hold: ['forward', 'fire'] },
  { t: 6.0, hold: ['forward', 'ads', 'fire'] },
  { t: 7.5, hold: ['back', 'right'] },
  { t: 8.5, hold: ['forward', 'sprint'] },
  { t: 10.0, hold: ['forward', 'sprint', 'crouch'] },
  { t: 10.8, hold: ['forward', 'jump'] },
  { t: 11.5, hold: ['forward', 'fire'] },
  { t: 13.0, hold: ['forward', 'ads', 'fire'] },
];

async function runLive(session, ms, warmupMs, timeline = LIVE_TIMELINE) {
  await session.exec(() => {
    const a = globalThis.__PT__.api;
    a.setSpawnLock(false);
    a.setRender(true);
    a.setCombat(true);
    a.setFrozen(false);
    a.setAccuracy(1);
    a.resetLifecycle();
    a.refill();
  });
  await session.exec((tl) => globalThis.__PT__.beginLive(tl), timeline);
  await sleep(ms);
  const raw = await session.exec(() => globalThis.__PT__.endLive());

  // Discard the warm-up window. Pipeline and shader compilation on the first
  // frames is a real cost, but it is not what "the framerate is bad" means.
  const keep = [], ctx = [], cpu = [];
  let acc = 0;
  for (let i = 0; i < raw.wall.length; i++) {
    acc += raw.wall[i];
    if (acc < warmupMs) continue;
    keep.push(raw.wall[i]);
    cpu.push(raw.cpu[i + 1] ?? raw.cpu[i]);
    ctx.push(raw.ctx[i + 1] ?? raw.ctx[i]);
  }
  const frame = stats(keep);
  frame.warmupDiscardedFrames = raw.wall.length - keep.length;
  frame.cpuMs = stats(cpu);
  frame.durationMs = +raw.durationMs.toFixed(1);

  // The worst 1% of frames, with the state of the game while they happened.
  const order = keep.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const worstN = Math.max(1, Math.round(keep.length * 0.01));
  frame.worst1pctCount = worstN;
  frame.worst1pctMeanMs = +avg(order.slice(0, worstN).map(([v]) => v)).toFixed(3);
  frame.worst1pct = order.slice(0, Math.min(worstN, 12)).map(([v, i]) => ({ ms: +v.toFixed(2), ...(ctx[i] || {}) }));

  const dcs = ctx.map((c) => (c && c.dc) || 0).filter(Boolean);
  const tris = ctx.map((c) => (c && c.tri) || 0).filter(Boolean);
  const gpu = ctx.map((c) => (c && c.gpu) || 0).filter((v) => v > 0);
  frame.drawCalls = { mean: Math.round(avg(dcs)), max: dcs.length ? Math.max(...dcs) : 0 };
  frame.triangles = { mean: Math.round(avg(tris)), max: tris.length ? Math.max(...tris) : 0 };
  frame.gpuMs = gpu.length ? { mean: +avg(gpu).toFixed(3), max: +Math.max(...gpu).toFixed(3) } : null;
  frame.bound = classify(frame.p50, frame.cpuMs.p50, frame.gpuMs ? frame.gpuMs.mean : 0);
  return { frame, ctx };
}

/* ------------------------------------------------------------------- main -- */

const log = (...a) => { if (!CFG.quiet) console.log(...a); };
const T0 = Date.now();
const stamp = () => `[${((Date.now() - T0) / 1000).toFixed(1)}s]`;
const fmtMs = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '  never' : `${Math.round(v)} ms`);
const fmtVal = (v) => {
  if (v === null || v === undefined) return 'n/a';
  if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : 'n/a';
  return String(v);
};

async function main() {
  if (CFG.build) {
    log(`${stamp()} building → ${CFG.dist}`);
    const r = spawnSync('npx', ['vite', 'build', '--outDir', CFG.dist], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout + r.stderr); throw new Error('vite build failed'); }
  }
  const base = await ensureServer({ port: CFG.port, outDir: CFG.dist });
  const url = `${base}/?capture=1&quality=${CFG.quality}&mode=${CFG.mode}&seed=${CFG.seed}`;
  const session = await openSession({ url, width: CFG.width, height: CFG.height, quality: CFG.quality, seed: CFG.seed });
  log(`${stamp()} GPU ${session.renderer}`);

  const report = {
    tool: 'playtest', version: '1.0.0',
    meta: {
      gpu: session.renderer, quality: CFG.quality, width: CFG.width, height: CFG.height,
      seed: CFG.seed, mode: CFG.mode, dist: CFG.dist, port: CFG.port,
      startedAt: new Date().toISOString(), errors: [],
    },
    frame: {}, enemies: {}, combat: {}, deaths: {}, movement: {}, recoil: {},
  };

  try {
    await session.exec(INSTALL_INPUT_BRIDGE);
    const boot = await session.exec(INSTALL_PROBE);
    log(`${stamp()} probe installed — actors=${boot.actorBackend} `
      + `ai.agents=${boot.aiAgents} ai.cover=${boot.aiCover} weapons=[${boot.weapons.join(',')}]`);
    Object.assign(report.enemies, {
      actorBackend: boot.actorBackend, aiAgents: boot.aiAgents, aiCover: boot.aiCover,
    });

    /* ------------------------------------------------ phase 1: baseline -- */
    log(`${stamp()} phase 1/7 — warm-up, match start`);
    await session.exec(() => {
      const a = globalThis.__PT__.api;
      a.setRender(false);
      for (let i = 0; i < 900; i++) globalThis.engine.stepFrame(1 / 120);  // 7.5 s sim
      a.setRender(true);
      a.markHome(true);   // every staged phase runs from this exact spot
    });
    const snap = await session.exec(() => globalThis.__PT__.api.snapshot());
    log(`${stamp()}   phase=${snap.phase} live=${snap.live} hp=${snap.health.toFixed(0)} sim=${snap.simTime.toFixed(1)}s`);

    /* ------------------------------------------------ phase 2: movement -- */
    log(`${stamp()} phase 2/7 — movement traversal (${MOVE_BEATS.length} beats, fixed step)`);
    report.movement = await runMovement(session);
    for (const b of report.movement.beats) {
      log(`${stamp()}   ${b.label.padEnd(12)} peak ${b.peakHorizontalMs.toFixed(2)} m/s  `
        + `mean ${b.meanHorizontalMs.toFixed(2)} m/s  travel ${b.travelM.toFixed(2)} m  `
        + `air ${String(b.airFrames).padStart(3)} steps  rise ${b.riseM.toFixed(2)} m  → ${b.endState}`
        + `${b.blockedByGeometry ? '   [blocked by geometry]' : ''}`);
    }
    log(`${stamp()}   maxSpeed ${report.movement.maxSpeedMs.toFixed(2)} m/s  mantles ${report.movement.mantles}  `
      + `teleports ${report.movement.teleports}  step-snaps ${report.movement.stepSnaps}  `
      + `flat-ground launches ${report.movement.unexplainedLaunches} `
      + `(${report.movement.rampGainsIgnored} slope gains ignored)`);

    /* ----------------------------------------------------- phase 3: TTK -- */
    log(`${stamp()} phase 3/7 — time-to-kill sweep (${CFG.weapons.length} weapons × ${CFG.ranges.length} ranges)`);
    const ttk = await runTtk(session);
    Object.assign(report.combat, {
      ttk: ttk.rows, ttkFailures: ttk.failures, ttkSkippedNoSightline: ttk.skippedNoSightline,
      distinctHitDamage: ttk.distinctHitDamage,
      distinctHitDamageValues: ttk.distinctHitDamageValues,
      autoTtk10m: ttk.autoTtk10m,
    });
    for (const r of ttk.rows) {
      log(`${stamp()}   ${r.weapon.padEnd(13)} ${String(r.rangeM).padStart(3)} m  `
        + `ttk ${r.ttkMs === null ? ' NEVER' : String(Math.round(r.ttkMs)).padStart(5)} ms  `
        + `shots ${String(r.shotsFired).padStart(3)}  hits ${String(r.hits).padStart(3)}  `
        + `dmg/hit ${r.damagePerHit === null ? '   —' : r.damagePerHit.toFixed(1).padStart(6)}  `
        + `catalog says ${r.catalogDamage === null ? '—' : r.catalogDamage.toFixed(1)}`);
    }

    /* --------------------------------------------------- phase 4: kills -- */
    log(`${stamp()} phase 4/7 — execute a squad (death animation + hit zones)`);
    const kills = await runKills(session, 6);
    report.combat.executions = {
      attempted: kills.attempted, killed: kills.killed, hits: kills.hits, detail: kills.detail,
    };
    log(`${stamp()}   killed ${kills.killed}/${kills.attempted}  hits ${kills.hits}  `
      + `fallback-resolved zones ${JSON.stringify(kills.resolvedZones)}`);
    if (kills.livingEnemyZoneScan) {
      log(`${stamp()}   living-enemy hitbox scan: `
        + kills.livingEnemyZoneScan.bands.map((b) => `${b.band}→${b.onTarget ? b.zone : 'MISS'}`).join('  '));
    } else {
      log(`${stamp()}   living-enemy hitbox scan: no target could be staged`);
    }

    /* -------------------------------------------------- phase 5: recoil -- */
    log(`${stamp()} phase 5/7 — recoil bound + sprint-to-fire`);
    const rec = await runRecoil(session);
    report.recoil = rec.recoil;
    report.combat.sprintToFireMs = rec.sprintToFireMs;
    log(`${stamp()}   ${rec.recoil.roundsFired} rounds — peak ${rec.recoil.peakDeg.toFixed(2)}°  `
      + `at release ${rec.recoil.atReleaseDeg.toFixed(2)}°  residual after 2 s ${rec.recoil.residualDeg.toFixed(2)}° `
      + `(pitch ${rec.recoil.residualPitchDeg.toFixed(2)}°, yaw ${rec.recoil.residualYawDeg.toFixed(2)}°)`);
    log(`${stamp()}   sprint-to-fire ${rec.sprintToFireMs === null ? 'never fired' : rec.sprintToFireMs.toFixed(1) + ' ms'}`);

    /* ----------------------------------------------------- phase 6: TTD -- */
    log(`${stamp()} phase 6/7 — time-to-DIE standing in front of ${CFG.ttdEnemies} enemies at ${CFG.ttdRange} m`);
    const ttd = await runTtd(session);
    report.combat.ttd = ttd;
    log(`${stamp()}   median of ${ttd.trials} trials — first damage ${fmtMs(ttd.firstDamageMs)}   `
      + `health hits 0 ${fmtMs(ttd.toZeroHealthMs)}   downed ${fmtMs(ttd.toDownedMs)}   DEAD ${fmtMs(ttd.toDeathMs)}`);
    log(`${stamp()}   all trials: ${ttd.toDeathMsAll.map(fmtMs).join('  ')}   `
      + `(min ${fmtMs(ttd.toDeathMsMin)}, max ${fmtMs(ttd.toDeathMsMax)})`);
    log(`${stamp()}   last-stand cycles ${ttd.downCycles}   ${ttd.damageEventsPerSec.toFixed(2)} hits/s   `
      + `${ttd.totalDamageTaken} total damage over ${(ttd.toDeathMs === Infinity ? ttd.capMs : ttd.toDeathMs) / 1000}s   `
      + `(director accuracy scale ${ttd.accuracyScale}, sightline ${ttd.stagedWithSightline ? 'clear' : 'BLOCKED'})`);

    /* ---------------------------------------------------- phase 7: live -- */
    log(`${stamp()} phase 7/7 — live free-running play for ${CFG.liveMs} ms (real rAF, vsync off)`);
    const live = await runLive(session, CFG.liveMs, CFG.warmupMs);
    report.frame = live.frame;
    log(`${stamp()}   ${live.frame.frames} frames after warm-up (${live.frame.warmupDiscardedFrames} discarded)`);
    log(`${stamp()}   wall p50 ${live.frame.p50} ms  p95 ${live.frame.p95} ms  p99 ${live.frame.p99} ms  `
      + `p99.9 ${live.frame.p999} ms  worst ${live.frame.worst} ms  → ${live.frame.fps} fps mean`);
    log(`${stamp()}   >16.7 ms ${live.frame.over16_7}   >33 ms ${live.frame.over33}   >50 ms ${live.frame.over50}`);
    log(`${stamp()}   cpu p50 ${live.frame.cpuMs.p50} ms  gpu mean ${live.frame.gpuMs ? live.frame.gpuMs.mean : 'n/a'} ms  `
      + `${live.frame.drawCalls.mean} draws  ${(live.frame.triangles.mean / 1000).toFixed(0)}k tris  → ${live.frame.bound}`);
    for (const w of live.frame.worst1pct.slice(0, 5)) {
      log(`${stamp()}     worst ${String(w.ms).padStart(8)} ms @ t=${w.t}ms  state=${w.st}  `
        + `enemies=${w.live}  draws=${w.dc}  tris=${w.tri}`);
    }

    /* --------------------------------------------------------- collect --- */
    const dump = await session.exec(() => globalThis.__PT__.api.dump(false));
    const finalSnap = await session.exec(() => globalThis.__PT__.api.snapshot());

    Object.assign(report.enemies, {
      spawned: dump.spawned,
      spawnBlockedDuringControlledTests: dump.spawnedBlocked,
      peakAlive: dump.peakAlive,
      aliveAtEnd: finalSnap.live,
      aiAgents: finalSnap.aiAgents,
    });
    report.combat.zones = {
      // Structural answer: what a bullet ray gets back from a live enemy.
      livingEnemyScan: kills.livingEnemyZoneScan,
      livingEnemyDistinct: kills.livingEnemyZoneScan ? kills.livingEnemyZoneScan.distinct : 0,
      // Context only: this histogram includes the player's own capsule and the
      // ragdolls of the already-dead, so it is not evidence about live enemies.
      allRaycastZoneHistogram: dump.colliderZones,
      allRaycastDistinct: Object.keys(dump.colliderZones).length,
      resolvedByFallback: dump.resolvedZones,
      duringExecutions: kills.colliderZones,
    };
    report.combat.damageEventsOnPlayerTotal = dump.playerDamageCount;

    // Deaths are graded on the execution phase, where kills are guaranteed and
    // every body is watched for the full 0.5 s after it drops. Deaths from the
    // rest of the session are folded in when they exist.
    const deaths = kills.deathRecords.concat(dump.deaths);
    const animated = deaths.filter((d) => d.delta > 0.02);
    report.deaths = {
      total: deaths.length,
      withCharacterRig: deaths.filter((d) => d.hadCharacter).length,
      animated: animated.length,
      snapped: deaths.length - animated.length,
      animatedFraction: deaths.length ? +(animated.length / deaths.length).toFixed(3) : NaN,
      ragdolled: deaths.filter((d) => d.ragdoll).length,
      sample: deaths.slice(0, 12).map((d) => ({
        id: d.id, archetype: d.archetype, hadCharacter: d.hadCharacter,
        poseDelta: +d.delta.toFixed(4), ragdoll: d.ragdoll, samples: d.samples,
      })),
    };
    log(`${stamp()} deaths ${report.deaths.total} — animated ${report.deaths.animated}, snapped ${report.deaths.snapped}, `
      + `with a character rig ${report.deaths.withCharacterRig}, ragdolled ${report.deaths.ragdolled}`);
    log(`${stamp()} raycast zone histogram (includes the player capsule and corpse ragdolls): `
      + `${JSON.stringify(dump.colliderZones)}`);

    report.meta.errors = session.errors.slice(0, 20);
  } finally {
    await session.close();
  }

  /* --------------------------------------------------------------- gates -- */
  const results = GATES.map((g) => {
    let measured;
    try { measured = g.read(report); } catch { measured = undefined; }
    let pass = false;
    try { pass = !!g.ok(measured); } catch { pass = false; }
    return { id: g.id, hard: g.hard, what: g.what, target: g.target, measured, pass, why: g.why };
  });
  report.gates = results;
  const hardFails = results.filter((r) => r.hard && !r.pass);
  const softFails = results.filter((r) => !r.hard && !r.pass);
  report.pass = hardFails.length === 0;

  const out = path.isAbsolute(CFG.json) ? CFG.json : path.join(ROOT, CFG.json);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));

  console.log('');
  console.log('='.repeat(100));
  console.log(`PLAYTEST GATES — ${CFG.width}x${CFG.height} / ${CFG.quality} / seed ${CFG.seed} / mode ${CFG.mode}`);
  console.log('='.repeat(100));
  for (const r of results) {
    const mark = r.pass ? 'PASS' : (r.hard ? 'FAIL' : 'WARN');
    console.log(`${mark}  ${r.id.padEnd(20)} measured ${fmtVal(r.measured).padStart(11)}   target ${r.target}`);
    console.log(`        ${r.what}`);
    if (!r.pass) {
      for (const line of wrap(r.why.replace(/\s+/g, ' '), 90)) console.log(`        ↳ ${line}`);
    }
  }
  console.log('='.repeat(100));
  console.log(`${hardFails.length} hard gate(s) FAILED, ${softFails.length} advisory warning(s).`);
  console.log(`report → ${out}`);

  await stopServer();
  if (hardFails.length) process.exit(1);
}

function wrap(s, n) {
  const words = s.split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > n) { out.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

export { INSTALL_PROBE, INSTALL_INPUT_BRIDGE, runLive, stats, classify, avg, GATES };

if (process.argv[1] && process.argv[1].endsWith('playtest.mjs')) {
  main().catch(async (e) => {
    console.error(e);
    await stopServer();
    process.exit(1);
  });
}
