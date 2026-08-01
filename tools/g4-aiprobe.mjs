#!/usr/bin/env node
/**
 * G4 — AI wiring probe.
 *
 * Drives the shipping bundle on the real GPU and answers, with numbers, the six
 * acceptance questions for "wire the real AI; delete the coin flip":
 *
 *   1. how many agents does `ai.agents` hold after the sim runs
 *   2. is the actor backend `AIActorBridge` (not `BotFallback`)
 *   3. do enemy rounds resolve through a raycast, not a probability
 *   4. does a stationary player die to 3 engaging enemies at 20 m inside 8 s
 *   5. what is the distribution of reaction times before an enemy's first shot
 *   6. do the player's rounds still kill, with real per-zone / per-range damage
 *
 * Gameplay is measured in SIM time (`engine.stepFrame(1/120)` with the renderer
 * left running but no rAF), so a result is reproducible for a seed and does not
 * depend on how busy this box is.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openSession, ensureServer, stopServer, ROOT } from './harness.mjs';

const PORT = 9914;
const DIST = 'dist-gp-g4';
const OUT = path.join(ROOT, 'shots', 'gp-g4');
const SEED = 1337;

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);
/**
 * `--backend fallback` boots with `?actors=fallback`, which makes the director
 * build `BotFallback` even though the AI module is present. That is how the
 * stand-in sim — no longer the shipping path — still gets driven and gated.
 */
const BACKEND = String(flag('backend', 'ai'));

const log = (...a) => console.log(...a);
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;

/* Chromium writes its profile into TMPDIR; /tmp here is a small shared tmpfs. */
function ensureScratchTmp() {
  const cur = process.env.TMPDIR || '/tmp';
  try {
    const st = fs.statfsSync(cur);
    if (st.bavail * st.bsize > 2e9) return;
  } catch { /* fall through */ }
  for (const c of ['/dev/shm', path.join(ROOT, '.tmp')]) {
    try {
      fs.mkdirSync(c, { recursive: true });
      const st = fs.statfsSync(c);
      if (st.bavail * st.bsize > 2e9) { process.env.TMPDIR = c; return; }
    } catch { /* next */ }
  }
}

/* ------------------------------------------------------------------ probe -- */

/**
 * Installed inside the page. Everything it reaches for is a public field or a
 * prototype method, so it measures the built bundle rather than a debug build.
 */
async function install(page) {
  return page.evaluate(() => {
    const g = globalThis.__BLACKOUT_GAME__;
    const e = globalThis.engine ?? g?.match?.services?.engine;
    if (!g) return { ok: false, why: 'no __BLACKOUT_GAME__' };
    const eng = globalThis.engine;
    if (!eng) return { ok: false, why: 'no window.engine' };

    const player = eng.tryGet('player');
    const weapons = eng.tryGet('weapons');
    const physics = eng.tryGet('physics');
    const ai = eng.tryGet('ai');
    const actors = g.services.actors;
    const proto = Object.getPrototypeOf(actors);

    const P = {
      shots: [],          // every AI round: {t, id, hit, zone, dmg, blocked}
      reactions: [],      // {t, id, sec} at the moment an engagement began
      playerHits: [],     // {t, amount, hpBefore, hpAfter}
      hurts: [],          // enemy health changes
      deaths: [],
      spawned: 0,
    };
    globalThis.__G4__ = P;
    const now = () => eng.time.elapsed;

    /* --- enemy shots: hook the fire-control resolver, not a sampler ------- */
    const combatProto = ai && ai.agents ? null : null;
    // `CombatController` is not exported to the page, so reach it through a
    // spawned agent's prototype the first time one exists.
    P.hookCombat = () => {
      if (P.combatHooked || !ai || !ai.agents.length) return;
      const c = ai.agents[0].combat;
      const cp = Object.getPrototypeOf(c);
      if (!cp || typeof cp.tryFire !== 'function') return;
      P.combatHooked = true;
      const origTry = cp.tryFire;
      cp.tryFire = function (t, muzzle, target, dist, phys, id, supp, aim, out, owner) {
        const r = origTry.call(this, t, muzzle, target, dist, phys, id, supp, aim, out, owner);
        if (r.fired && P.shots.length < 40000) {
          P.shots.push({
            t: now(), id, hit: r.hitTarget, zone: r.zone,
            dmg: +r.damage.toFixed(3), blocked: r.blocked, dist: +dist.toFixed(2),
            supp: !!supp, shotN: this.engagementShots,
          });
        }
        return r;
      };
      const origBegin = cp.beginEngagement;
      cp.beginEngagement = function (t, first) {
        const before = this.engagedAt;
        origBegin.call(this, t, first);
        if (this.engagedAt !== before && P.reactions.length < 20000) {
          P.reactions.push({ t: now(), sec: this.reactionTimer, first: !!first });
        }
      };
    };

    /* --- enemy health, through the bridge's single funnel ---------------- */
    if (typeof proto.hurt === 'function') {
      const origHurt = proto.hurt;
      proto.hurt = function (v, amount, opts) {
        const before = v.health;
        const killed = origHurt.call(this, v, amount, opts);
        if (P.hurts.length < 20000) {
          P.hurts.push({
            t: now(), id: v.id, amount: +amount.toFixed(3), killed,
            headshot: !!(opts && opts.headshot), zone: (opts && opts.zone) || null,
            fromPlayer: !opts || opts.fromPlayer !== false, hpBefore: before,
          });
        }
        return killed;
      };
    }
    const origSpawn = proto.spawnCombatant;
    proto.spawnCombatant = function (req) {
      const id = origSpawn.call(this, req);
      if (id >= 0) P.spawned++;
      return id;
    };

    /* --- damage the player takes ----------------------------------------- */
    const origApply = player.applyDamage.bind(player);
    player.applyDamage = function (amount, dir, lethal) {
      const before = player.health;
      origApply(amount, dir, lethal);
      if (P.playerHits.length < 20000) {
        P.playerHits.push({
          t: now(), amount: +amount.toFixed(3), hpBefore: before, hpAfter: player.health,
        });
      }
    };

    P.api = {
      snap() {
        const bridge = g.aiBridge;
        return {
          simTime: eng.time.elapsed,
          backend: g.actorBackend,
          bridgeClass: proto.constructor.name,
          actorsNonNull: !!actors,
          aiAgents: ai ? ai.agents.length : -1,
          aiAlive: ai ? ai.aliveAgents : -1,
          coverPoints: ai && ai.cover ? ai.cover.points.length : -1,
          navCells: ai && ai.nav && ai.nav.grid ? ai.nav.grid.walkableCells : -1,
          live: actors.liveCount ? actors.liveCount() : -1,
          squads: ai && ai.squads ? [...ai.squads.all()].length : -1,
          phase: g.phase,
          health: player.health, alive: player.alive,
          pos: [player.position.x, player.position.y, player.position.z],
          bridge: bridge ? bridge.snapshot() : null,
        };
      },
      /**
       * Steps the fixed simulation. The renderer is parked while this runs —
       * gameplay is what is being measured, and a 25 ms rasteriser frame would
       * turn 40 s of sim time into 20 minutes of wall clock.
       */
      step(n) { for (let i = 0; i < n; i++) eng.stepFrame(1 / 120); P.hookCombat(); },
      setRender(on) {
        const r = eng.tryGet('render');
        if (r) r.enabled = !!on;
        return !!(r && r.enabled);
      },
      home() {
        if (!P.home) P.home = { p: player.position.clone(), yaw: player.camera.yaw };
        return [P.home.p.x, P.home.p.y, P.home.p.z];
      },
      /**
       * Back to the marked spot, alive and whole. `spawnAt` rather than a
       * teleport + health poke: the player can genuinely be dead by now (the
       * match AI is live during the census phase) and only the spawn path
       * clears `alive`, the last-stand timer and the damage clock.
       */
      goHome() {
        if (!P.home) return false;
        player.spawnAt(P.home.p, P.home.yaw);
        player.camera.reset(P.home.yaw);
        const life = g.match && g.match.lifecycle ? g.match.lifecycle : null;
        if (life && typeof life.forceRespawn === 'function') life.forceRespawn();
        return true;
      },
      /** Drops an enemy `metres` away down `yaw`, snapped to the ground. */
      spawnAt(yaw, metres, opts) {
        const o = opts || {};
        const base = player.position.clone();
        const q = base.clone();
        q.x += -Math.sin(yaw) * metres + (o.lateral || 0) * Math.cos(yaw);
        q.z += -Math.cos(yaw) * metres - (o.lateral || 0) * Math.sin(yaw);
        q.y = base.y - 0.9;
        let grounded = false;
        if (physics && physics.ready) {
          const from = q.clone(); from.y = base.y + 30;
          const down = new (q.constructor)(0, -1, 0);
          const hit = {
            hit: false, point: q.clone(), normal: q.clone(), distance: Infinity,
            surface: 'concrete', object: null, entityId: -1, bodyHandle: -1,
            zone: 'none', backface: false,
          };
          const h = physics.raycast(from, down, 80, 1 | 2, hit);
          if (h && h.hit) { q.y = h.point.y; grounded = true; }
        }
        const id = actors.spawnCombatant({
          archetype: o.archetype || 'rifleman', faction: 'militia', team: 'hostile',
          position: q, yaw, seed: (o.seed || 1) | 0,
          health: o.health === undefined ? 1 : o.health,
          accuracy: o.accuracy === undefined ? 1 : o.accuracy,
          aggression: o.aggression === undefined ? 1 : o.aggression,
          tag: o.tag || 'g4',
        });
        return { id, pos: [q.x, q.y, q.z], grounded };
      },
      /** Line of sight from the player's eye to a world point. */
      los(x, y, z) {
        if (!physics || !physics.ready) return true;
        const to = player.position.clone(); to.set(x, y, z);
        return physics.lineOfSight(eng.camera.position, to, 1 | 2 | 128);
      },
      look(x, y, z) {
        const cam = eng.camera.position;
        const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
        let yaw = Math.atan2(-dx, -dz);
        let pitch = Math.atan2(dy, Math.hypot(dx, dz));
        const r = player.camera.recoil;
        player.camera.yaw = yaw - r.yaw;
        player.camera.pitch = pitch - r.pitch;
      },
      clearActors() { if (actors.clear) actors.clear(); },
      setFrozen(on) { if (actors.setFrozen) actors.setFrozen(!!on); },
      /**
       * Stops the pacing director spawning reinforcements. Every staged
       * measurement below wants exactly the enemies it placed and no others.
       */
      setDirector(on) {
        const d = g.match && g.match.director;
        if (d) d.enabled = !!on;
        return !!(d && d.enabled);
      },
      setCombat(on) { if (actors.setCombatEnabled) actors.setCombatEnabled(!!on); },
      setAccuracy(k) { if (actors.setAccuracyScale) actors.setAccuracyScale(k); },
      accuracyScale() { return actors.accuracyScale === undefined ? 1 : actors.accuracyScale; },
      bot(id) {
        const list = actors.bots || [];
        for (const b of list) {
          if (b.id === id) {
            return {
              alive: b.alive, hp: b.health, max: b.maxHealth, height: b.height,
              pos: [b.position.x, b.position.y, b.position.z],
              archetype: b.archetype,
              state: b.agent ? b.agent.perception.state : null,
              awareness: b.agent ? +b.agent.perception.awareness.toFixed(3) : null,
              hasLOS: b.agent ? b.agent.perception.hasLOS : null,
              action: b.agent ? b.agent.actionName : null,
              squad: b.agent && b.agent.squad ? b.agent.squad.id : -1,
              shots: b.agent ? b.agent.combat.shotsFired : 0,
              hits: b.agent ? b.agent.combat.shotsHit : 0,
              blocked: b.agent ? b.agent.combat.shotsBlocked : 0,
              reactionMs: b.agent ? Math.round(b.agent.combat.lastReaction * 1000) : 0,
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
        return { id: w.id, rpm: w.def.rpm, mag: w.def.magSize };
      },
      refill() {
        const w = weapons.current;
        w.ammo = w.def.magSize; w.reserve = w.def.magSize * 8; w.reloading = false;
      },
      reset() {
        P.shots.length = 0; P.reactions.length = 0;
        P.playerHits.length = 0; P.hurts.length = 0; P.deaths.length = 0;
      },
      dump() {
        return {
          shots: P.shots, reactions: P.reactions, playerHits: P.playerHits,
          hurts: P.hurts, spawned: P.spawned,
        };
      },
      counts() {
        return {
          shots: P.shots.length, reactions: P.reactions.length,
          playerHits: P.playerHits.length, hurts: P.hurts.length,
        };
      },
    };
    return {
      ok: true,
      backend: g.actorBackend,
      bridgeClass: proto.constructor.name,
      systems: eng.systems.map((s) => s.name),
    };
  });
}

const call = (page, fn, arg) =>
  page.evaluate(([f, a]) => globalThis.__G4__.api[f](...(a || [])), [fn, arg]);

/* ----------------------------------------------------------------- stats -- */

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function dist(values) {
  if (!values.length) return { n: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: +s[0].toFixed(1), p25: +pct(s, 25).toFixed(1), p50: +pct(s, 50).toFixed(1),
    p75: +pct(s, 75).toFixed(1), p95: +pct(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1),
    mean: +(sum / s.length).toFixed(1),
  };
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  ensureScratchTmp();
  fs.mkdirSync(OUT, { recursive: true });

  if (!has('no-build')) {
    log(`${stamp()} building ${DIST} …`);
    const { execFileSync } = await import('node:child_process');
    execFileSync('npx', ['vite', 'build', '--outDir', DIST], { cwd: ROOT, stdio: 'inherit' });
  }

  const base = await ensureServer({ mode: 'preview', port: PORT, outDir: DIST, quiet: true });
  const url = `${base}/?capture=1&quality=high&mode=firefight&seed=${SEED}`
    + (BACKEND === 'fallback' ? '&actors=fallback' : '');
  const errors = [];
  const session = await openSession({
    url, width: 1280, height: 720, quality: 'high', seed: SEED,
    onConsole: (m) => { if (m.type === 'error' || m.type === 'pageerror') errors.push(m.text); },
  });
  const { page } = session;
  log(`${stamp()} GPU ${session.renderer}`);

  const report = {
    tool: 'g4-aiprobe',
    meta: { gpu: session.renderer, seed: SEED, mode: 'firefight', dist: DIST, port: PORT,
      backend: BACKEND },
    gates: [], phases: {}, errors: [],
  };
  const gate = (name, measured, pass, note) => {
    report.gates.push({ gate: name, measured: String(measured), pass: !!pass, note });
    log(`${stamp()}   ${pass ? 'PASS' : 'FAIL'}  ${name} — ${measured}${note ? `  (${note})` : ''}`);
  };

  const boot = await install(page);
  if (!boot.ok) throw new Error(`probe install failed: ${boot.why}`);
  log(`${stamp()} probe installed — backend "${boot.backend}" (${boot.bridgeClass})`);
  /*
   * Mark the home spot NOW, while the player is alive and standing on the
   * level's own spawn. Marking it later reads back wherever the corpse ended
   * up — which silently poisons every staged measurement, because the
   * sightline probe then searches for a 20 m lane from inside the geometry the
   * body fell into.
   */
  await call(page, 'home');

  /* ---------------------------------------------- phase 1: backend + agents */
  log(`${stamp()} phase 1/5 — backend identity and agent census`);
  await call(page, 'setRender', [false]);
  // Let the match spawn its opening wave: 45 s of match time.
  for (let i = 0; i < 18; i++) await call(page, 'step', [300]);
  const s1 = await call(page, 'snap');
  report.phases.census = s1;
  log(`${stamp()}   t=${s1.simTime.toFixed(1)}s  agents=${s1.aiAgents} alive=${s1.aiAlive} `
    + `live=${s1.live} squads=${s1.squads} cover=${s1.coverPoints} nav=${s1.navCells}`);

  if (BACKEND !== 'fallback') {
    gate('ai.agents.length > 0', s1.aiAgents, s1.aiAgents > 0,
      `${s1.aiAlive} alive, ${s1.squads} squads`);
  }
  /*
   * Identity by field, not by class name: `vite build` mangles class names
   * (`AIActorBridge` is `jE` in the bundle) but never property names, so the
   * check has to be something that survives minification.
   */
  const ident = await page.evaluate(() => {
    const g = globalThis.__BLACKOUT_GAME__;
    const a = g.services.actors;
    return {
      backend: g.actorBackend,
      hasBridge: !!g.aiBridge,
      bridgeIsActors: g.aiBridge === a,
      snapshotBackend: a.snapshot ? a.snapshot().backend : null,
      hasFallback: !!g.fallback,
      hasBridgeFlag: !!g.aiBridge,
      aiIsWired: !!(g.aiBridge && g.aiBridge.ai && Array.isArray(g.aiBridge.ai.agents)),
    };
  });
  report.phases.identity = ident;
  if (BACKEND === 'fallback') {
    gate('forced fallback backend is BotFallback',
      `actorBackend="${ident.backend}", BotFallback constructed ${ident.hasFallback}`,
      s1.actorsNonNull && ident.backend === 'fallback' && ident.hasFallback && !ident.hasBridge);
  } else {
    gate('asActorAPI() non-null and backend is the real AI, not BotFallback',
      `actorBackend="${ident.backend}", snapshot.backend="${ident.snapshotBackend}", `
      + `bridge===services.actors ${ident.bridgeIsActors}, BotFallback constructed ${ident.hasFallback}`,
      s1.actorsNonNull && ident.backend === 'ai' && ident.bridgeIsActors
      && ident.snapshotBackend === 'ai' && ident.aiIsWired && !ident.hasFallback);
  }

  /* --------------------------------------------------- phase 2: no coin flip */
  log(`${stamp()} phase 2/5 — enemy shots resolve through a trace`);
  const srcCombat = fs.readFileSync(path.join(ROOT, 'src/ai/Combat.ts'), 'utf8');
  const srcFallback = fs.readFileSync(path.join(ROOT, 'src/game/BotFallback.ts'), 'utf8');
  // Strip comments first: both files now carry a gravestone paragraph that
  // *names* the thing being removed, and a naive grep matches its own epitaph.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const bodyFallback = strip(srcFallback);
  const bodyCombat = strip(srcCombat);
  const coinFlip = /(rng|rand)\.bool\([^)]*(chance|accuracy|hitProb)/.test(bodyFallback)
    || /(rng|rand)\.bool\([^)]*(chance|accuracy|hitProb)/.test(bodyCombat)
    || /const\s+hit\s*=\s*this\.(rng|rand)\.bool/.test(bodyFallback + bodyCombat);
  const tracesBullet = srcCombat.includes('MASK_BULLET') && srcFallback.includes('MASK_BULLET');
  gate('no hit-probability coin flip in either backend',
    coinFlip ? 'rng.bool(chance) still present' : 'none', !coinFlip);
  gate('both backends trace with MASK_BULLET', tracesBullet ? 'yes' : 'no', tracesBullet);

  /* -------------------------------------- phase 3: TTD — 3 enemies at 20 m */
  log(`${stamp()} phase 3/5 — time-to-die, stationary, 3 enemies at 20 m`);
  await call(page, 'setDirector', [false]);
  const ttdTrials = [];
  const TTD_TRIALS = 5;
  for (let trial = 0; trial < TTD_TRIALS; trial++) {
    await call(page, 'clearActors');
    await call(page, 'goHome');
    await call(page, 'reset');
    await call(page, 'step', [60]);
    const pre = await call(page, 'snap');
    if (!pre.alive) log(`${stamp()}   ! player did not respawn (hp ${pre.health})`);

    // Find a yaw with a clear sightline at 20 m, then put three riflemen on it.
    let placed = null;
    for (let k = 0; k < 48 && !placed; k++) {
      const yaw = k * 2.399963;
      const probe = await call(page, 'spawnAt', [yaw, 20, { seed: 1000 + k, tag: 'g4-ttd' }]);
      if (probe.id < 0) continue;
      const b = await call(page, 'bot', [probe.id]);
      const ok = b && probe.grounded
        && await call(page, 'los', [b.pos[0], b.pos[1] + 1.2, b.pos[2]]);
      if (ok) {
        // Give him a second to actually see the player. A lane the player can
        // see down is not proof the enemy at the far end has acquired.
        await call(page, 'step', [150]);
        const after = await call(page, 'bot', [probe.id]);
        if (after && after.state !== 'idle') { placed = { yaw, ids: [probe.id] }; break; }
      }
      await page.evaluate((id) => globalThis.__BLACKOUT_GAME__.services.actors.despawnCombatant(id), probe.id);
    }
    if (!placed) {
      log(`${stamp()}   trial ${trial + 1}: NO SIGHTLINE at 20 m from home — trial skipped`);
      ttdTrials.push({ ms: Infinity, why: 'no sightline' });
      continue;
    }
    for (const lat of [-2.5, 2.5]) {
      const r = await call(page, 'spawnAt',
        [placed.yaw, 20, { lateral: lat, seed: 2000 + trial * 10 + lat, tag: 'g4-ttd' }]);
      if (r.id >= 0) placed.ids.push(r.id);
    }
    await call(page, 'setCombat', [true]);
    await call(page, 'reset');

    const t0sim = (await call(page, 'snap')).simTime;
    let died = Infinity;
    let firstDamage = Infinity;
    for (let i = 0; i < 200 && died === Infinity; i++) {
      await call(page, 'step', [12]);   // 0.1 s of sim
      const s = await call(page, 'snap');
      const c = await call(page, 'counts');
      if (firstDamage === Infinity && c.playerHits > 0) firstDamage = (s.simTime - t0sim) * 1000;
      if (!s.alive || s.health <= 0) died = (s.simTime - t0sim) * 1000;
      if (s.simTime - t0sim > 20) break;
    }
    const d = await call(page, 'dump');
    const damage = d.playerHits.reduce((a, h) => a + h.amount, 0);
    const bots = [];
    for (const id of placed.ids) bots.push(await call(page, 'bot', [id]));
    ttdTrials.push({
      ms: died, firstDamageMs: firstDamage,
      hits: d.playerHits.length, damage: +damage.toFixed(1),
      aiShots: d.shots.length, aiHits: d.shots.filter((x) => x.hit).length,
      aiBlocked: d.shots.filter((x) => x.blocked).length,
      bots: bots.filter(Boolean).map((b) => ({
        state: b.state, action: b.action, shots: b.shots, hits: b.hits,
        blocked: b.blocked, squad: b.squad, reactionMs: b.reactionMs,
      })),
    });
    log(`${stamp()}   trial ${trial + 1}: died ${died === Infinity ? 'NEVER' : `${Math.round(died)} ms`}`
      + `  first damage ${firstDamage === Infinity ? '—' : `${Math.round(firstDamage)} ms`}`
      + `  ${d.playerHits.length} hits / ${damage.toFixed(0)} dmg`
      + `  ai ${d.shots.filter((x) => x.hit).length}/${d.shots.length} on target`);
  }
  report.phases.ttd = { trials: ttdTrials };
  const ttdMs = ttdTrials.map((t) => t.ms).sort((a, b) => a - b);
  const ttdMedian = ttdMs[Math.floor(ttdMs.length / 2)];
  report.phases.ttd.medianMs = ttdMedian;
  gate(`time-to-die <= 8000 ms (median of ${TTD_TRIALS}, 3 enemies at 20 m)`,
    ttdMedian === Infinity ? 'NEVER' : `${Math.round(ttdMedian)} ms`, ttdMedian <= 8000,
    `all: ${ttdMs.map((m) => (m === Infinity ? 'never' : Math.round(m))).join(' / ')}`);

  /* ------------------------------------------- phase 4: reaction + ballistics */
  log(`${stamp()} phase 4/5 — reaction distribution and shot resolution`);
  await call(page, 'clearActors');
  await call(page, 'goHome');
  await call(page, 'reset');
  await call(page, 'step', [60]);
  const wave = [];
  for (let k = 0; k < 40 && wave.length < 6; k++) {
    const yaw = k * 2.399963;
    for (const lat of [0, 3]) {
      const r = await call(page, 'spawnAt', [yaw, 22, { lateral: lat, seed: 500 + k * 3 + lat, tag: 'g4-react' }]);
      if (r.id < 0) continue;
      const b = await call(page, 'bot', [r.id]);
      let keep = !!(b && r.grounded && await call(page, 'los', [b.pos[0], b.pos[1] + 1.2, b.pos[2]]));
      if (keep) {
        await call(page, 'step', [150]);
        const after = await call(page, 'bot', [r.id]);
        keep = !!(after && after.state !== 'idle');
      }
      if (keep) wave.push(r.id);
      else await page.evaluate((id) => globalThis.__BLACKOUT_GAME__.services.actors.despawnCombatant(id), r.id);
    }
  }
  await call(page, 'setCombat', [true]);
  // Player is invulnerable-ish for this phase: heal every 0.2 s so the sample
  // is about the AI, not about how fast the player dies.
  for (let i = 0; i < 100; i++) {
    await call(page, 'step', [24]);
    await page.evaluate(() => {
      const p = globalThis.engine.tryGet('player');
      if (p.health < p.maxHealth) p.health = p.maxHealth;
    });
  }
  const d4 = await call(page, 'dump');
  const reactionsMs = d4.reactions.map((r) => r.sec * 1000);
  const shots = d4.shots;
  const onTarget = shots.filter((s) => s.hit);
  const blocked = shots.filter((s) => s.blocked);
  const zones = {};
  for (const s of onTarget) zones[s.zone] = (zones[s.zone] || 0) + 1;
  const damages = [...new Set(onTarget.map((s) => s.dmg))];
  report.phases.combat = {
    enemies: wave.length,
    reactionMs: dist(reactionsMs),
    shots: shots.length, onTarget: onTarget.length, blocked: blocked.length,
    hitRate: shots.length ? +(onTarget.length / shots.length).toFixed(3) : 0,
    zones, distinctDamageValues: damages.length,
    damageRange: damages.length ? [Math.min(...damages), Math.max(...damages)] : [],
    playerHits: d4.playerHits.length,
  };
  log(`${stamp()}   ${wave.length} enemies  ${shots.length} rounds  `
    + `${onTarget.length} on target (${((onTarget.length / Math.max(1, shots.length)) * 100).toFixed(0)}%)  `
    + `${blocked.length} stopped by geometry`);
  log(`${stamp()}   zones ${JSON.stringify(zones)}  distinct damage values ${damages.length}`);
  log(`${stamp()}   reaction ms ${JSON.stringify(dist(reactionsMs))}`);

  const r = report.phases.combat.reactionMs;
  if (BACKEND === 'fallback') {
    log(`${stamp()}   (fallback backend: reaction is internal to BotFallback, `
      + `sampled indirectly through first-damage timing above)`);
  }
  if (BACKEND !== 'fallback') gate('reaction before first shot inside 220-1200 ms',
    r.n ? `p50 ${r.p50} ms, p05..p95 ${r.min}..${r.p95}, n=${r.n}` : 'no samples',
    r.n > 0 && r.min >= 220 && r.p95 <= 1200);
  if (BACKEND !== 'fallback') {
    gate('enemy rounds are stopped by geometry (proves a real trace)',
      `${blocked.length} of ${shots.length}`, blocked.length > 0);
    gate('enemy hits resolve to more than one zone',
      Object.keys(zones).join(',') || 'none', Object.keys(zones).length >= 2);
  }

  /* ---------------------------------------------- phase 5: player still kills */
  log(`${stamp()} phase 5/5 — the player's rounds still kill, with real damage`);
  await call(page, 'clearActors');
  await call(page, 'goHome');
  await call(page, 'setCombat', [false]);
  await call(page, 'reset');
  await call(page, 'step', [60]);
  await call(page, 'giveWeapon', ['ar_vkr7']);
  const ttks = [];
  for (const metres of [10, 25, 50]) {
    let spawn = null;
    for (let k = 0; k < 48 && !spawn; k++) {
      const yaw = k * 2.399963;
      const cand = await call(page, 'spawnAt', [yaw, metres, { seed: 77 + k, tag: 'g4-ttk' }]);
      if (cand.id < 0) continue;
      const b = await call(page, 'bot', [cand.id]);
      if (b && cand.grounded && await call(page, 'los', [b.pos[0], b.pos[1] + 1.1, b.pos[2]])) {
        spawn = { ...cand, bot: b };
      } else {
        await page.evaluate((id) => globalThis.__BLACKOUT_GAME__.services.actors.despawnCombatant(id), cand.id);
      }
    }
    if (!spawn) { ttks.push({ metres, skipped: 'no sightline' }); continue; }
    await call(page, 'refill');
    await call(page, 'reset');
    await call(page, 'look', [spawn.bot.pos[0], spawn.bot.pos[1] + spawn.bot.height * 0.62, spawn.bot.pos[2]]);
    await call(page, 'step', [90]);   // settle the ADS

    // Freeze the dummy: this measures the *weapon*, and an enemy that sprints
    // for cover the moment it is shot measures the enemy instead.
    await call(page, 'setFrozen', [true]);
    const start = (await call(page, 'snap')).simTime;
    let killMs = Infinity;
    for (let i = 0; i < 200; i++) {
      // Re-aim every beat, at the body's *live* position, and compensate for
      // residual recoil — the rig parks it on top of the look angles without
      // folding it back in, so an uncompensated burst would measure the recoil
      // bug rather than the TTK.
      const live = await call(page, 'bot', [spawn.id]);
      if (!live || !live.alive) { killMs = ((await call(page, 'snap')).simTime - start) * 1000; break; }
      await call(page, 'look', [live.pos[0], live.pos[1] + live.height * 0.62, live.pos[2]]);
      await page.evaluate(() => globalThis.__BLACKOUT__.act(
        [{ hold: ['ads', 'fire'], frames: 3, dt: 1 / 120 }],
      ));
    }
    await call(page, 'setFrozen', [false]);
    const dd = await call(page, 'dump');
    const mine = dd.hurts.filter((h) => h.fromPlayer);
    ttks.push({
      metres, ttkMs: killMs === Infinity ? null : Math.round(killMs),
      hits: mine.length,
      damagePerHit: [...new Set(mine.map((h) => h.amount))],
    });
    log(`${stamp()}   ${metres} m: ${killMs === Infinity ? 'NEVER killed' : `${Math.round(killMs)} ms`}`
      + `  ${mine.length} hits  damage ${[...new Set(mine.map((h) => h.amount))].slice(0, 6).join('/')}`);
    await call(page, 'clearActors');
    await call(page, 'goHome');
  }
  report.phases.ttk = ttks;
  const lethal = ttks.filter((t) => !t.skipped);
  const allKilled = lethal.length > 0 && lethal.every((t) => t.ttkMs !== null);
  const allDamage = new Set();
  for (const t of lethal) for (const v of t.damagePerHit || []) allDamage.add(v);
  gate('player still kills at every measured range',
    `${lethal.filter((t) => t.ttkMs !== null).length}/${lethal.length}`, allKilled,
    lethal.map((t) => `${t.metres}m ${t.ttkMs ?? 'never'}ms`).join(', '));
  gate('enemy damage model has >= 3 distinct per-hit values',
    allDamage.size, allDamage.size >= 3, [...allDamage].slice(0, 8).join('/'));

  /* ----------------------------------------- phase 6: what the AI costs -- */
  /*
   * Turning a tactical stack on is not free, and the build was already
   * CPU-bound before it had a single agent. Measure the delta rather than
   * assert it is small: same camera, same scene, real rAF frames, once with a
   * live squad and once with the level empty.
   */
  log(`${stamp()} phase 6/6 — frame-time cost of a live squad`);
  await call(page, 'setRender', [true]);
  const profile = async (label) => {
    await page.evaluate(() => globalThis.__BLACKOUT__.beginProfile());
    await page.waitForTimeout(6000);
    const r = await page.evaluate(() => globalThis.__BLACKOUT__.endProfile());
    log(`${stamp()}   ${label}: p50 ${r.p50.toFixed(2)} ms  p99 ${r.p99.toFixed(2)} ms  `
      + `mean ${r.meanMs.toFixed(2)} ms  ${r.avgFps.toFixed(1)} fps  (${r.frames} frames)`);
    return { label, p50: +r.p50.toFixed(2), p99: +r.p99.toFixed(2), mean: +r.meanMs.toFixed(2), fps: +r.avgFps.toFixed(1) };
  };
  await call(page, 'clearActors');
  await call(page, 'goHome');
  await call(page, 'step', [30]);
  const empty = await profile('0 agents');

  await call(page, 'setCombat', [true]);
  let liveN = 0;
  for (let k = 0; k < 30 && liveN < 8; k++) {
    const r = await call(page, 'spawnAt',
      [k * 2.399963, 18 + (k % 3) * 6, { lateral: (k % 5) - 2, seed: 900 + k, tag: 'g4-perf' }]);
    if (r.id >= 0) liveN++;
  }
  await call(page, 'step', [120]);
  const loaded = await profile(`${liveN} agents`);
  report.phases.perf = { empty, loaded, agents: liveN,
    deltaP50: +(loaded.p50 - empty.p50).toFixed(2), deltaP99: +(loaded.p99 - empty.p99).toFixed(2) };
  log(`${stamp()}   delta p50 ${report.phases.perf.deltaP50} ms, p99 ${report.phases.perf.deltaP99} ms`);

  /* ------------------------------------------------------------------ done */
  report.errors = errors.slice(0, 20);
  gate('no console/page errors', errors.length, errors.length === 0, errors[0] || '');

  const name = BACKEND === 'fallback' ? 'report-fallback.json' : 'report.json';
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(report, null, 2));
  const failed = report.gates.filter((x) => !x.pass);
  log('');
  log(`${stamp()} ${report.gates.length - failed.length}/${report.gates.length} gates pass`);
  for (const f of failed) log(`${stamp()}   FAIL ${f.gate} — ${f.measured}`);
  log(`${stamp()} report → ${path.join(OUT, name)}`);

  await session.close();
  await stopServer();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await stopServer(); } catch { /* ignore */ }
  process.exit(2);
});
