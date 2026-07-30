#!/usr/bin/env node
/**
 * Game-mode verifier.
 *
 * Runs every multiplayer mode headlessly, start to finish, with bots — and a
 * mode that cannot finish is reported as a failure, not a warning. For each one
 * it prints the final score, the wall/sim duration, the round-by-round
 * breakdown and the reason the match ended.
 *
 * The rig stands in for the two systems the game layer deliberately does not
 * own: an actor backend (bodies that move, shoot and die) and an AI brain. The
 * brain here is deliberately dumb — it reads `mode.orders()`, walks to the
 * point it is given and shoots whatever is nearest — which is the point: if a
 * mode only finishes with a clever bot, the mode is wrong.
 *
 *   node tools/session-modes.mjs                 # every mode
 *   node tools/session-modes.mjs --mode snd      # one mode
 *   node tools/session-modes.mjs --seed 99       # different seeded run
 *   node tools/session-modes.mjs --determinism   # also prove seed → same hash
 */

import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ONLY = arg('--mode', null);
const SEED = Number(arg('--seed', '20260730'));
const CHECK_DETERMINISM = argv.includes('--determinism');

const DT = 1 / 30;
const MAX_TICKS = 200000;          // ~110 minutes of sim; every mode is far under

/* ------------------------------------------------------------------ sim -- */

const BOT_HEALTH = 120;
const FIRE_INTERVAL = 0.75;
const ENGAGE_RANGE = 42;
const HIT_CHANCE = 0.34;
const HIT_DAMAGE = 42;
const MOVE_SPEED = 6.2;
const PLAYER_SPEED = 6.6;

/**
 * The actor backend. Owns bodies; the match layer never sees this class, only
 * the `ActorAPI` shape it satisfies.
 */
function makeRig(THREE, mods, seed) {
  const { EventBus } = mods.bus;
  const { Rand } = mods.rand;
  const { headlessServices } = mods.services;
  const { MatchRunner } = mods.match;

  const bus = new EventBus();
  const rng = new Rand(seed);
  const simRng = new Rand(seed ^ 0x5f3759df);
  const services = headlessServices(rng, (k, p) => bus.emit(k, p));

  /* --- player --- */
  const player = {
    position: new THREE.Vector3(0, 0, 0),
    health: 100,
    maxHealth: 100,
    alive: true,
    entityId: 1,
    spawnAt(p) { this.position.copy(p); this.health = this.maxHealth; this.alive = true; },
    revive() { this.alive = true; this.health = this.maxHealth; },
    heal(a) { this.health = Math.min(this.maxHealth, this.health + a); },
    applyDamage(amount, _dir, lethal) {
      if (!this.alive) return;
      this.health -= amount;
      if (this.health <= 0 || lethal) {
        this.health = 0;
        this.alive = false;
        bus.emit('entity:death', {
          id: this.entityId, byPlayer: false, headshot: false,
          name: 'player', point: this.position.clone(),
        });
      }
    },
  };

  /* --- bodies --- */
  const bots = new Map();
  let nextId = 5000;
  let combatEnabled = true;

  const actors = {
    spawnCombatant(req) {
      const id = nextId++;
      bots.set(id, {
        id, team: req.team, health: BOT_HEALTH * (req.health ?? 1),
        position: req.position.clone(), archetype: req.archetype,
        fireTimer: simRng.range(0, FIRE_INTERVAL),
      });
      return id;
    },
    despawnCombatant(id) { bots.delete(id); },
    isCombatantAlive(id) { return bots.has(id); },
    combatantPosition(id, out) {
      const b = bots.get(id);
      if (!b) return false;
      out.copy(b.position);
      return true;
    },
    damageCombatant(id, amount, opts) {
      const b = bots.get(id);
      if (!b) return false;
      b.health -= amount;
      if (b.health > 0) return false;
      bots.delete(id);
      bus.emit('entity:death', {
        id, byPlayer: opts?.fromPlayer !== false, headshot: !!opts?.headshot,
        name: b.archetype, point: b.position.clone(),
      });
      return true;
    },
    setCombatEnabled(on) { combatEnabled = on; },
    setAccuracyScale() { },
    listCombatants(out) { out.length = 0; for (const id of bots.keys()) out.push(id); return out.length; },
  };

  /* --- world --- */
  const spawns = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const r = 26 + (i % 4) * 6;
    spawns.push({
      position: new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
      yaw: a, team: i % 3 === 0 ? 'player' : 'enemy',
    });
  }
  services.player = player;
  services.actors = actors;
  services.world = {
    spawns,
    bounds: new THREE.Box3(new THREE.Vector3(-70, -2, -70), new THREE.Vector3(70, 30, 70)),
  };

  const match = new MatchRunner(services, false);
  match.attachBus((key, fn) => bus.on(key, fn));
  match.progression.setStorage?.(null);

  const transitions = [];
  bus.on('match:state', (e) => transitions.push(e.phase));
  const banners = [];
  bus.on('hud:banner', (b) => banners.push(b.title));

  return { bus, rng, simRng, services, player, actors, bots, match, transitions, banners, isCombatEnabled: () => combatEnabled };
}

const _a = { x: 0, z: 0 };

/** One tick of the stand-in AI: obey the order, shoot the nearest enemy. */
function stepSim(rig, THREE, dt) {
  const { bots, match, player, simRng } = rig;
  const mode = match.mode;
  const orders = typeof mode.orders === 'function' ? mode.orders() : [];
  const orderById = new Map();
  for (const o of orders) orderById.set(o.id, o);
  const combat = rig.isCombatEnabled();

  /* --- bots --- */
  for (const b of bots.values()) {
    const order = orderById.get(b.id);
    let tx = null, tz = null, stopAt = 1.5;
    if (order) { tx = order.x; tz = order.z; stopAt = Math.max(1.2, order.radius * 0.45); }

    // Nearest enemy body, for both movement fallback and shooting.
    let foe = null, foeD = Infinity;
    for (const o of bots.values()) {
      if (o === b) continue;
      if (mode.def?.teams?.teams !== 1 && o.team === b.team) continue;
      const d = (o.position.x - b.position.x) ** 2 + (o.position.z - b.position.z) ** 2;
      if (d < foeD) { foeD = d; foe = o; }
    }
    if (b.team === 'hostile' && player.alive) {
      const d = (player.position.x - b.position.x) ** 2 + (player.position.z - b.position.z) ** 2;
      if (d < foeD) { foeD = d; foe = player; }
    }
    if (tx === null && foe) { tx = foe.position.x; tz = foe.position.z; stopAt = 6; }

    if (tx !== null) {
      _a.x = tx - b.position.x;
      _a.z = tz - b.position.z;
      const dist = Math.hypot(_a.x, _a.z);
      if (dist > stopAt) {
        const s = (MOVE_SPEED * dt) / dist;
        b.position.x += _a.x * s;
        b.position.z += _a.z * s;
      }
    }

    if (!combat || !foe) continue;
    b.fireTimer -= dt;
    if (b.fireTimer > 0) continue;
    b.fireTimer = FIRE_INTERVAL;
    if (Math.sqrt(foeD) > ENGAGE_RANGE) continue;
    if (simRng.next() > HIT_CHANCE) continue;
    if (foe === player) {
      player.applyDamage(HIT_DAMAGE, new THREE.Vector3(0, 1, 0), false);
    } else {
      // A host knows the shooter before the damage lands — report, then apply.
      match.reportKill(b.id, foe.id);
      rig.actors.damageCombatant(foe.id, HIT_DAMAGE, { fromPlayer: false, source: 'bot' });
    }
  }

  /* --- the player --- */
  if (!player.alive) { match.setInteracting(false); return; }
  let px = null, pz = null, pStop = 2;
  const objs = match.objectives();
  for (const o of objs) {
    if (o.state !== 'active' || !o.position) continue;
    px = o.position.x; pz = o.position.z; pStop = Math.max(1.2, o.radius * 0.4);
    break;
  }
  let target = null, targetD = Infinity;
  for (const o of bots.values()) {
    if (o.team === 'friendly' && mode.def?.teams?.teams !== 1) continue;
    const d = (o.position.x - player.position.x) ** 2 + (o.position.z - player.position.z) ** 2;
    if (d < targetD) { targetD = d; target = o; }
  }
  if (px === null && target) { px = target.position.x; pz = target.position.z; pStop = 8; }
  if (px !== null) {
    _a.x = px - player.position.x;
    _a.z = pz - player.position.z;
    const dist = Math.hypot(_a.x, _a.z);
    if (dist > pStop) {
      const s = (PLAYER_SPEED * dt) / dist;
      player.position.x += _a.x * s;
      player.position.z += _a.z * s;
      match.setInteracting(false);
    } else {
      match.setInteracting(true);
    }
  }
  if (combat && target && Math.sqrt(targetD) < ENGAGE_RANGE) {
    rig.playerFire = (rig.playerFire ?? 0) - dt;
    if (rig.playerFire <= 0) {
      rig.playerFire = FIRE_INTERVAL * 0.8;
      if (simRng.next() < HIT_CHANCE + 0.1) match.damage(target.id, HIT_DAMAGE, 'player');
    }
  }
}

/* --------------------------------------------------------------- runner -- */

function runMode(THREE, mods, id, seed) {
  const rig = makeRig(THREE, mods, seed);
  const started = Date.now();
  rig.match.start(id, seed);

  let ticks = 0;
  while (ticks < MAX_TICKS && rig.match.phase !== 'ended') {
    stepSim(rig, THREE, DT);
    rig.match.fixedUpdate(DT);
    ticks++;
  }

  const mode = rig.match.mode;
  const summary = rig.match.summary;
  const roundList = typeof mode.rounds === 'function' ? mode.rounds() : [];
  return {
    id,
    name: mode.name,
    finished: rig.match.phase === 'ended',
    ticks,
    simSeconds: ticks * DT,
    wallMs: Date.now() - started,
    matchSeconds: rig.match.matchTime,
    teamScore: mode.teamScore,
    enemyScore: mode.enemyScore,
    scoreLimit: mode.scoreLimit,
    win: summary?.win ?? null,
    kills: summary?.kills ?? 0,
    deaths: summary?.deaths ?? 0,
    reason: mode.endReason || '(none reported)',
    rounds: roundList.map((r) => ({ ...r })),
    phases: rig.rigTransitions ?? rig.transitions.slice(),
    hash: rig.match.log.hash(),
    logLength: rig.match.log.length,
    bodies: rig.bots.size,
    state: typeof mode.state === 'function' ? { ...mode.state() } : null,
    extra: modeExtras(mode),
    checks: modeChecks(mods, id, mode, rig),
  };
}

/**
 * Per-mode assertions. "It reached the end state" is necessary but nowhere near
 * sufficient — a Domination match that never captured a flag also ends.
 */
function modeChecks(mods, id, mode, rig) {
  const def = mods.modes.MODE_DEFS[id];
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const st = typeof mode.state === 'function' ? mode.state() : null;

  add('reached the end state', rig.match.phase === 'ended', rig.match.phase);
  add('phase order was legal',
    rig.transitions[0] === 'warmup' && rig.transitions.includes('live')
    && rig.transitions.at(-1) === 'ended',
    rig.transitions.join('→'));
  add('a side actually scored', mode.teamScore > 0 || mode.enemyScore > 0,
    `${mode.teamScore}-${mode.enemyScore}`);
  add('the match reported why it ended', !!mode.endReason, mode.endReason);

  if (def.rounds.enabled) {
    const rounds = mode.rounds();
    add('played more than one round', rounds.length > 1, `${rounds.length} rounds`);
    add('every round named a winner', rounds.every((r) => r.winner && r.reason),
      rounds.map((r) => r.winner).join(','));
    add('a side reached the round target or the cap',
      Math.max(st.roundsFriendly, st.roundsHostile) >= def.rounds.roundsToWin
      || st.roundsFriendly + st.roundsHostile >= def.rounds.maxRounds,
      `${st.roundsFriendly}-${st.roundsHostile}`);
  }
  if (def.teams.swapSidesAtHalf) {
    add('sides swapped at halftime', st.sidesSwapped === true, String(st.sidesSwapped));
  }
  if (def.objective.layout === 'zones') {
    const held = mode.flagStates().filter((f) => f.owner !== 'neutral').length;
    add('flags changed hands', held > 0, mode.flagStates().map((f) => `${f.letter}:${f.owner}`).join(' '));
  }
  if (def.objective.layout === 'hardpoint') {
    add('the hill rotated', mode.rotations > 0, `${mode.rotations} rotations`);
  }
  if (def.objective.layout === 'bomb') {
    add('charges were planted', mode.plants > 0, `${mode.plants} plants`);
    add('a charge was defused at least once', mode.defuses > 0, `${mode.defuses} defuses`);
    add('a charge detonated at least once', mode.detonations > 0, `${mode.detonations} detonations`);
  }
  if (def.objective.layout === 'tags') {
    const s = mode.stats();
    add('tags were confirmed', s.confirmed.friendly + s.confirmed.hostile > 0,
      `${s.confirmed.friendly}/${s.confirmed.hostile}`);
    add('tags were denied', s.denied.friendly + s.denied.hostile > 0,
      `${s.denied.friendly}/${s.denied.hostile}`);
    add('no tag leaked past the match', s.live >= 0, `${s.live} live`);
  }
  if (def.teams.teams === 1) {
    const rows = mode.standings();
    add('the scoreboard is fully populated', rows.length === def.teams.teamSize, `${rows.length} operators`);
    add('bots scored too', rows.some((r) => !r.isPlayer && r.score > 0),
      rows.slice(0, 3).map((r) => `${r.name}:${r.score}`).join(' '));
  }
  return out;
}

function modeExtras(mode) {
  const out = {};
  if (typeof mode.flagStates === 'function') {
    out.flags = mode.flagStates().map((f) => `${f.letter}:${f.owner}`).join(' ');
  }
  if (typeof mode.hillState === 'function') {
    const h = mode.hillState();
    out.hill = `${h.index + 1}/${h.total} owner=${h.owner}`;
    out.rotations = mode.rotations;
  }
  if (typeof mode.bombState === 'function') {
    out.plants = mode.plants;
    out.defuses = mode.defuses;
    out.detonations = mode.detonations;
  }
  if (typeof mode.stats === 'function') {
    const s = mode.stats();
    out.confirmed = `${s.confirmed.friendly}/${s.confirmed.hostile}`;
    out.denied = `${s.denied.friendly}/${s.denied.hostile}`;
  }
  if (mode.state) {
    const st = mode.state();
    out.swapped = String(st.sidesSwapped);
    out.overtime = String(st.overtime);
  }
  if (typeof mode.standings === 'function') {
    out.placement = `${mode.placement()} of ${mode.standings().length}`;
    out.top = mode.standings().slice(0, 3).map((r) => `${r.name}:${r.score}`).join(' ');
  }
  return out;
}

/* ------------------------------------------------------------------ main -- */

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const server = await createServer({
  root: ROOT, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom',
});

let mods;
let THREE;
try {
  THREE = await server.ssrLoadModule('three');
  mods = {
    bus: await server.ssrLoadModule('/src/core/EventBus.ts'),
    rand: await server.ssrLoadModule('/src/core/Rand.ts'),
    services: await server.ssrLoadModule('/src/game/Services.ts'),
    match: await server.ssrLoadModule('/src/game/Match.ts'),
    modes: await server.ssrLoadModule('/src/game/modes/index.ts'),
  };
} catch (e) {
  console.error('FAIL  could not load sources:', e?.message ?? e);
  await server.close();
  process.exit(1);
}

const ids = ONLY ? [ONLY] : mods.modes.MULTIPLAYER_MODE_IDS.slice();
const results = [];

console.log(`\n=== GAME MODES — headless bot playthrough (seed ${SEED}, dt ${DT.toFixed(4)}) ===\n`);

for (const id of ids) {
  let r;
  try {
    r = runMode(THREE, mods, id, SEED);
  } catch (e) {
    r = { id, name: id, finished: false, error: e?.stack ?? String(e) };
  }
  results.push(r);

  const def = mods.modes.MODE_DEFS[id];
  const tag = r.finished && (r.checks ?? []).every((c) => c.ok) ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${(def?.name ?? id).toUpperCase()}  (${id})`);
  if (r.error) { console.log(`       error: ${r.error.split('\n').slice(0, 4).join('\n       ')}\n`); continue; }
  console.log(`       final score      ${r.teamScore} — ${r.enemyScore}` +
    (r.scoreLimit ? ` (limit ${r.scoreLimit})` : ' (round based)') +
    `   result ${r.win ? 'WIN' : 'LOSS'}`);
  console.log(`       duration         ${clock(r.matchSeconds)} match  /  ${clock(r.simSeconds)} sim  /  ${r.ticks} ticks  /  ${r.wallMs}ms wall`);
  console.log(`       player           ${r.kills} kills, ${r.deaths} deaths`);
  console.log(`       ended because    ${r.reason}`);
  if (r.rounds.length) {
    console.log(`       rounds           ${r.rounds.length} played`);
    for (const rd of r.rounds) {
      console.log(`         R${String(rd.index).padStart(2)}  ${String(rd.winner).padEnd(8)}` +
        ` ${String(rd.friendlyRounds)}-${rd.hostileRounds}  ${clock(rd.seconds).padStart(5)}  ${rd.reason}`);
    }
  }
  const extras = Object.entries(r.extra ?? {});
  if (extras.length) {
    console.log(`       mode state       ${extras.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  console.log(`       replay           ${r.logLength} entries, hash ${r.hash}`);
  for (const c of r.checks ?? []) {
    console.log(`         ${c.ok ? '✓' : '✗'} ${c.name.padEnd(42)} ${c.detail ?? ''}`);
  }
  console.log('');
}

/* --- edge cases bots rarely reach, plus the replication contract --- */

const edge = [];
const edgeCheck = (name, ok, detail) => {
  edge.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(52)} ${detail ?? ''}`);
};

console.log('--- overtime, authority and replication ---');
{
  /* Sudden death: force a level scoreline onto a dead clock. Bots almost never
     tie, so this path needs driving by hand. */
  const rig = makeRig(THREE, mods, SEED);
  rig.match.start('tdm', SEED);
  for (let i = 0; i < 400; i++) { stepSim(rig, THREE, DT); rig.match.fixedUpdate(DT); }
  const m = rig.match.mode;
  m.teamScore = 12; m.enemyScore = 12; m.clock = 0.001;
  // Hold the scoreline level tick by tick, or sudden death resolves it before
  // we can look at it — the observation, not the rule, is what is delicate.
  let ot = null;
  for (let i = 0; i < 120 && !ot; i++) {
    m.teamScore = 12; m.enemyScore = 12;
    rig.match.fixedUpdate(DT);
    if (m.state().overtime) ot = m.state();
  }
  edgeCheck('a level clock enters overtime instead of ending',
    !!ot && ot.overtime === true && rig.match.phase === 'live' && ot.clock > 0,
    ot ? `overtime=${ot.overtime} phase=${rig.match.phase} clock=${ot.clock.toFixed(1)}s` : 'never entered overtime');

  m.teamScore = 13;
  for (let i = 0; i < 400 && rig.match.phase !== 'ended'; i++) { stepSim(rig, THREE, DT); rig.match.fixedUpdate(DT); }
  edgeCheck('the next score ends overtime',
    rig.match.phase === 'ended' && rig.match.summary?.win === true,
    `${m.endReason}`);
}
{
  /* Overtime that stays level must still terminate rather than loop. */
  const rig = makeRig(THREE, mods, SEED + 1);
  rig.match.start('tdm', SEED + 1);
  for (let i = 0; i < 400; i++) { stepSim(rig, THREE, DT); rig.match.fixedUpdate(DT); }
  const m = rig.match.mode;
  m.teamScore = 9; m.enemyScore = 9; m.clock = 0.001;
  let guard = 0;
  while (rig.match.phase !== 'ended' && guard < 40000) {
    m.teamScore = 9; m.enemyScore = 9;             // hold it level all the way
    stepSim(rig, THREE, DT); rig.match.fixedUpdate(DT); guard++;
  }
  edgeCheck('a level overtime still terminates',
    rig.match.phase === 'ended', `${guard} ticks, ${m.endReason}`);
}
{
  /* A client constructs the same mode with authority off: it must not advance
     the state machine on its own, only accept what the host sends. */
  const rig = makeRig(THREE, mods, SEED);
  const client = new mods.modes.DominationMode();
  client.authority = false;
  rig.match.mode = client;
  rig.match.start('dom', SEED);
  rig.match.mode = client;
  client.authority = false;
  const before = { ...client.state() };
  for (let i = 0; i < 600; i++) rig.match.fixedUpdate(DT);
  const after = client.state();
  edgeCheck('a non-authoritative mode does not advance its own state',
    after.round === before.round && after.scoreFriendly === before.scoreFriendly
    && after.stage === before.stage,
    `stage ${before.stage}→${after.stage} round ${before.round}→${after.round}`);

  client.applyState({ ...after, round: 4, scoreFriendly: 88, scoreHostile: 41, overtime: true, sidesSwapped: true });
  const applied = client.state();
  edgeCheck('a client takes host state through applyState',
    applied.round === 4 && applied.scoreFriendly === 88 && applied.sidesSwapped === true,
    `${applied.scoreFriendly}-${applied.scoreHostile} round ${applied.round}`);
}
{
  /* Every replicable entity must survive a replicate → applyReplicated hop. */
  const O = await server.ssrLoadModule('/src/game/Objectives.ts');
  const v = (x, y, z) => new THREE.Vector3(x, y, z);

  const zoneA = new O.CaptureZoneObjective(0, v(4, 0, 4), 8, 8);
  zoneA.owner = 'hostile'; zoneA.capture = 0.437; zoneA.capturingTeam = 'friendly';
  const zoneB = new O.CaptureZoneObjective(0, v(4, 0, 4), 8, 8);
  zoneB.applyReplicated(zoneA.replicate());
  edgeCheck('capture zone survives a replication hop',
    zoneB.owner === 'hostile' && Math.abs(zoneB.capture - 0.437) < 1e-3 && zoneB.capturingTeam === 'friendly',
    `${zoneB.owner} ${zoneB.capture.toFixed(3)} by ${zoneB.capturingTeam}`);

  const hpA = new O.HardpointObjective([v(0, 0, 0), v(20, 0, 0), v(0, 0, 20)], 8, 60);
  hpA.hill = 2; hpA.owner = 'friendly'; hpA.nextIn = 17.25; hpA.locked = true;
  const hpB = new O.HardpointObjective([v(0, 0, 0), v(20, 0, 0), v(0, 0, 20)], 8, 60);
  hpB.applyReplicated(hpA.replicate());
  edgeCheck('hardpoint survives a replication hop',
    hpB.hill === 2 && hpB.owner === 'friendly' && Math.abs(hpB.nextIn - 17.25) < 1e-2 && hpB.locked === true
    && hpB.position.distanceTo(v(0, 0, 20)) < 1e-6,
    `hill ${hpB.hill} owner ${hpB.owner} nextIn ${hpB.nextIn.toFixed(2)} moved=${hpB.position.z === 20}`);

  const bombA = new O.BombSiteObjective(1, v(9, 0, 9), 6, 5, 45, 7.5);
  bombA.arm('hostile'); bombA.phase = 'defusing'; bombA.bar = 0.61; bombA.fuseLeft = 22.75;
  const bombB = new O.BombSiteObjective(1, v(9, 0, 9), 6, 5, 45, 7.5);
  bombB.applyReplicated(bombA.replicate());
  edgeCheck('bomb site survives a replication hop',
    bombB.phase === 'defusing' && Math.abs(bombB.bar - 0.61) < 1e-3
    && Math.abs(bombB.fuseLeft - 22.75) < 1e-2 && bombB.attackers === 'hostile' && bombB.kind === 'defuse',
    `${bombB.phase} bar ${bombB.bar.toFixed(2)} fuse ${bombB.fuseLeft.toFixed(2)} kind ${bombB.kind}`);

  const tagsA = new O.DogTagField(3, 30);
  tagsA.drop('friendly', 1.5, 0.2, -4.25);
  tagsA.drop('hostile', -12.75, 0, 8.5);
  const tagsB = new O.DogTagField(3, 30);
  tagsB.applyReplicated(tagsA.replicate());
  edgeCheck('the tag field survives a replication hop',
    tagsB.tags.length === 2 && tagsB.tags[1].owner === 'hostile'
    && Math.abs(tagsB.tags[0].z + 4.25) < 0.1 && tagsB.tags[0].netId === tagsA.tags[0].netId,
    `${tagsB.tags.length} tags, ids ${tagsB.tags.map((t) => t.netId).join(',')}`);

  const dead = new O.CaptureZoneObjective(0, v(0, 0, 0), 8, 8);
  dead.authority = false;
  dead.state = 'active';
  const w = {
    emit: () => { }, playerPosition: v(0, 0, 0), playerAlive: true, playerInteracting: false,
    hostilesWithin: () => 0, addMarker: () => { }, now: 0,
    presence: (_c, _r, out) => { out.friendly = 3; out.hostile = 0; },
  };
  for (let i = 0; i < 600; i++) dead.step(DT, w);
  edgeCheck('a non-authoritative zone never captures locally',
    dead.owner === 'neutral' && dead.capture === 0, `owner ${dead.owner} capture ${dead.capture}`);
}
console.log('');

/* --- determinism --- */
let determinismOk = true;
if (CHECK_DETERMINISM) {
  console.log('--- determinism: same seed must produce the same replay hash ---');
  for (const id of ids) {
    const a = runMode(THREE, mods, id, SEED);
    const b = runMode(THREE, mods, id, SEED);
    const same = a.hash === b.hash && a.ticks === b.ticks;
    determinismOk &&= same;
    console.log(`  [${same ? 'PASS' : 'FAIL'}] ${id}  ${a.hash} vs ${b.hash}  (${a.ticks}/${b.ticks} ticks)`);
  }
  console.log('');
}

/* --- report --- */
const failed = results.filter((r) => !r.finished || !(r.checks ?? []).every((c) => c.ok));
const edgeFailed = edge.filter((e) => !e.ok);
const passed = results.length - failed.length;
console.log('='.repeat(72));
console.log(`${passed}/${results.length} modes played to completion with bots.`);
for (const f of failed) {
  const bad = (f.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
  console.log(`  FAIL ${f.id}: ${f.error ? 'threw' : bad.length ? bad.join('; ') : 'did not reach the end state'}`);
}
const totalChecks = results.reduce((n, r) => n + (r.checks?.length ?? 0), 0);
const okChecks = results.reduce((n, r) => n + (r.checks?.filter((c) => c.ok).length ?? 0), 0);
console.log(`${okChecks}/${totalChecks} per-mode assertions held.`);
console.log(`${edge.length - edgeFailed.length}/${edge.length} edge-case and replication assertions held.`);
for (const e of edgeFailed) console.log(`  FAIL ${e.name}: ${e.detail}`);
if (CHECK_DETERMINISM) console.log(`determinism: ${determinismOk ? 'PASS' : 'FAIL'}`);
const allOk = failed.length === 0 && determinismOk && edgeFailed.length === 0;
console.log(allOk ? 'RESULT: PASS' : 'RESULT: FAIL');

await server.close();
process.exit(allOk ? 0 : 1);
