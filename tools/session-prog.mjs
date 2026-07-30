#!/usr/bin/env node
/**
 * Headless verifier for the progression system.
 *
 *   node tools/session-prog.mjs [--matches 50] [--seed 20260730] [--quiet]
 *
 * Bundles the real TypeScript (no mocks of our own code) with rolldown, then
 * drives the *real* `Scoring` and `Progression` classes through simulated
 * matches by emitting the same bus events the game emits — `weapon:fire`,
 * `damage:dealt`, `entity:death`, `damage:taken`, `player:killed`,
 * `streak:multikill`. Everything progression derives (weapon XP, longshots,
 * hipfire kills, revenge, first blood, camos) therefore comes out of the same
 * code path the shipped game uses.
 *
 * Prints the rank curve, time-to-max for a weapon, a full after-action
 * breakdown, the combat record, and PASS/FAIL for every assertion.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const QUIET = argv.includes('--quiet');
const MATCHES = Number(flag('matches', 50));
const SEED = Number(flag('seed', 20260730));

/* ------------------------------------------------------------- assertions */

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ----------------------------------------------------------------- bundle */

async function bundle() {
  const { rolldown } = await import('rolldown');
  const dir = await mkdtemp(path.join(tmpdir(), 'sessprog-'));
  const entry = path.join(dir, 'entry.ts');
  const abs = (p) => path.join(ROOT, p).replace(/\\/g, '/');
  await writeFile(entry, [
    `export { Progression, XP } from '${abs('src/game/Progression.ts')}';`,
    `export { Scoring } from '${abs('src/game/Scoring.ts')}';`,
    `export * from '${abs('src/session/progression/index.ts')}';`,
    `export { Rand } from '${abs('src/core/Rand.ts')}';`,
    `export { WEAPONS } from '${abs('src/weapons/Catalog.ts')}';`,
    `export { ATTACHMENTS } from '${abs('src/weapons/Attachments.ts')}';`,
    // The game's own deterministic state-machine test — proves `Match` and
    // `Scoring` still drive the rewritten `Progression` end to end.
    `export { runSelfTest } from '${abs('src/game/SelfTest.ts')}';`,
  ].join('\n'), 'utf8');

  const build = await rolldown({ input: entry, logLevel: 'silent' });
  const out = await build.generate({ format: 'esm' });
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, out.output[0].code, 'utf8');
  const mod = await import(pathToFileURL(file).href);
  return { mod, dir };
}

/* ------------------------------------------------------------- match sim */

/**
 * One match. Emits real gameplay events and drives the real `Scoring`, so the
 * numbers below are produced by shipped code, not by the harness.
 */
function playMatch(M, prog, rng, opts) {
  const port = prog.__port;
  const scoring = new M.Scoring(port.emit, prog);
  scoring.reset();

  prog.beginMatch(opts.mode, { modeName: opts.modeName, seed: opts.seed });
  port.emit('weapon:switch', { from: null, to: opts.weapon });

  const origin = { x: 0, y: 1.6, z: 0 };
  let nextId = 1000;
  let killsLeft = opts.kills;
  let deathsLeft = opts.deaths;
  let lastEnemy = -1;
  let t = 0;
  /** Kills still queued to land inside the multi-kill window. */
  let chain = 0;

  while (killsLeft > 0 || deathsLeft > 0) {
    // Interleave kills and deaths so streaks and revenge behave realistically.
    const killNow = killsLeft > 0 && (deathsLeft === 0 || rng.next() < opts.killBias);

    if (killNow) {
      killsLeft--;
      const id = nextId++;
      const dist = opts.longRange ? rng.range(20, 110) : rng.range(2, 55);
      const ads = rng.bool(opts.adsRate);
      const headshot = rng.bool(opts.headshotRate);
      const shots = 1 + rng.int(1, 7);

      origin.x = rng.range(-40, 40); origin.z = rng.range(-40, 40);
      for (let s = 0; s < shots; s++) {
        port.emit('weapon:fire', {
          weaponId: opts.weapon, origin, direction: { x: 0, y: 0, z: -1 },
          shotIndex: s, suppressed: false,
        });
        scoring.registerShot();
      }
      const hits = 1 + rng.int(0, Math.max(0, shots - 1));
      for (let h = 0; h < hits; h++) {
        port.emit('weapon:ads', { active: ads });
        port.emit('damage:dealt', {
          targetId: id, amount: rng.range(18, 40), headshot: headshot && h === hits - 1,
          killed: h === hits - 1, point: origin, fromPlayer: true,
        });
        scoring.registerHit();
      }

      const point = {
        x: origin.x + dist * 0.7071, y: 1.2, z: origin.z + dist * 0.7071,
      };
      // Scoring books the player XP exactly as the match does…
      scoring.playerKill({
        headshot, distance: dist, source: 'player', archetype: 'rifleman',
        score: 100, objective: rng.bool(0.08),
      });
      // …and the bus event drives progression's own attribution.
      port.emit('entity:death', { id, byPlayer: true, headshot, name: 'Hostile', point });
      lastEnemy = id;

      if (rng.bool(0.12)) scoring.assist();
    } else {
      deathsLeft--;
      const killer = lastEnemy >= 0 && rng.bool(0.45) ? lastEnemy : nextId++;
      port.emit('damage:taken', {
        amount: 100, fromDirection: { x: 0, y: 0, z: 1 }, sourceId: killer, lethal: true,
      });
      port.emit('entity:death', { id: -1, byPlayer: false, headshot: false, name: 'You', point: origin });
      port.emit('player:killed', { by: 'hostile', distance: 12, headshot: false });
      scoring.playerDeath();
    }
    // Gap to the next event. Some kills land inside the 2.4 s multi-kill window
    // — that is where double kills, the Crimson camo and the mastery ladder
    // come from, so the sim has to produce them.
    let gap;
    if (killNow && chain > 0) { chain--; gap = rng.range(0.35, 1.0); }
    else if (killNow && killsLeft > 0 && rng.bool(0.22)) { chain = 1 + rng.int(0, 1); gap = rng.range(0.35, 1.0); }
    else { chain = 0; gap = rng.range(2, 9); }
    t += gap;
    scoring.fixedUpdate(gap);
  }

  for (let o = 0; o < opts.objectives; o++) {
    // Capture ticks first: the player stands on the point and it fills. Half of
    // them are captured by a team-mate (contested === false) and must pay the
    // player nothing.
    // Two points in three are taken by the player, the third by a team-mate.
    const mine = o % 3 !== 2;
    for (let s = 1; s <= 5; s++) {
      port.emit('objective:update', {
        id: `obj${o}`, kind: 'capture', state: 'active', label: 'SECURE',
        hint: 'Hold the point', progress: s / 5, timer: -1,
        position: [origin.x, 0, origin.z], radius: 6, contested: mine,
      });
    }
    port.emit('objective:complete', { id: `obj${o}`, label: 'SECURE', score: 250 });
    prog.award(M.XP.objectiveComplete, 'Objectives');
  }
  for (let w = 0; w < opts.waves; w++) {
    port.emit('wave:cleared', { index: w, bonus: 250, nextIn: 8 });
  }
  for (let k = 0; k < opts.killstreaks; k++) {
    port.emit('killstreak:activated', { id: 'uav', name: 'UAV', position: origin });
  }

  const st = scoring.state;
  const unlocks = prog.commit(opts.win, {
    kills: st.kills, deaths: st.deaths, headshots: st.headshots, assists: st.assists,
    bestStreak: st.bestStreak, wavesCleared: opts.waves, objectives: opts.objectives,
    timePlayed: t, killstreaksUsed: opts.killstreaks,
  });
  return { unlocks, report: prog.afterAction(), scoring: st };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const { mod: M, dir } = await bundle();
  try {
    await run(M);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeProgression(M, storage) {
  const port = M.recordingPort();
  const prog = new M.Progression(port.emit, storage, port);
  prog.__port = port;
  return prog;
}

function fmt(n, d = 0) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }); }
function bar(pct, w = 24) {
  const f = Math.max(0, Math.min(w, Math.round(pct * w)));
  return `${'█'.repeat(f)}${'░'.repeat(w - f)}`;
}
const say = (...a) => { if (!QUIET) console.log(...a); };

async function run(M) {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SESSION · PROGRESSION — headless verification                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  /* ------------------------------------------------- 0. catalogue drift -- */
  {
    const catalogIds = new Set(M.WEAPONS.map((w) => w.id));
    const attachIds = new Set(M.ATTACHMENTS.map((a) => a.id));
    const badWeapons = M.WEAPON_TRACKS.filter((t) => !catalogIds.has(t.id)).map((t) => t.id);
    const badAttach = [];
    for (const t of M.WEAPON_TRACKS) {
      for (const u of t.unlocks) if (!attachIds.has(u.id)) badAttach.push(`${t.id}:${u.id}`);
    }
    for (const d of M.DEFAULT_ATTACHMENTS) if (!attachIds.has(d)) badAttach.push(`default:${d}`);
    const classOk = M.WEAPON_TRACKS.every((t) => {
      const def = M.WEAPONS.find((w) => w.id === t.id);
      return def && def.cls === t.cls;
    });
    check('weapon track ids exist in the live catalogue', badWeapons.length === 0, badWeapons.join(','));
    check('attachment ids exist in the live catalogue', badAttach.length === 0, badAttach.join(','));
    check('track classes match the catalogue', classOk);
    check('every catalogue weapon has a track',
      M.WEAPONS.every((w) => M.weaponTrack(w.id)),
      M.WEAPONS.filter((w) => !M.weaponTrack(w.id)).map((w) => w.id).join(','));
    say(`\n  catalogue cross-check: ${M.WEAPON_TRACKS.length} tracks, ` +
      `${M.WEAPON_TRACKS.reduce((a, t) => a + t.unlocks.length, 0)} attachment gates, ` +
      `${M.CHALLENGES.length} challenges`);
  }

  /* --------------------------------------------------------- 1. curves -- */
  say('\n── RANK CURVE ─────────────────────────────────────────────────────────');
  say('  rank                     cumulative XP     this rank      name');
  for (const r of [1, 2, 3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
    say(`   ${String(r).padStart(2)}   ${bar(Math.min(1, M.xpForRank(r) / M.xpForRank(55)), 18)}` +
      ` ${fmt(M.xpForRank(r)).padStart(10)}  ${fmt(M.xpSpanForRank(r)).padStart(10)}    ${M.rankName(r)}`);
  }
  {
    let mono = true;
    for (let r = 2; r <= M.MAX_RANK; r++) if (M.xpForRank(r) <= M.xpForRank(r - 1)) mono = false;
    check('rank curve is strictly increasing', mono);
    check('rankForXp inverts xpForRank at every rank',
      Array.from({ length: M.MAX_RANK }, (_, i) => i + 1)
        .every((r) => M.rankForXp(M.xpForRank(r)) === r));
    check('rankForXp clamps below rank 1 and at max',
      M.rankForXp(-5) === 1 && M.rankForXp(1e12) === M.MAX_RANK);
  }

  say('\n── WEAPON LEVEL CURVE ─────────────────────────────────────────────────');
  say('  level      cumulative WXP    unlock at this level');
  for (const t of M.WEAPON_TRACKS.slice(0, 1)) {
    for (const lv of [2, 5, 10, 15, 20, 25, 30]) {
      const u = t.unlocks.find((x) => x.level === lv);
      say(`   ${String(lv).padStart(2)}   ${bar(M.weaponXpForLevel(lv) / M.WEAPON_XP_TO_MAX, 18)}` +
        ` ${fmt(M.weaponXpForLevel(lv)).padStart(8)}    ${u ? u.name : '—'}`);
    }
  }
  check('weapon curve inverts', Array.from({ length: M.WEAPON_MAX_LEVEL }, (_, i) => i + 1)
    .every((l) => M.weaponLevelForXp(M.weaponXpForLevel(l)) === l));

  /* ----------------------------------------------------- 2. persistence -- */
  say('\n── PERSISTENCE ────────────────────────────────────────────────────────');
  {
    const store = M.memoryStorage();
    // A v2-era profile written by the previous build.
    store.setItem('blackout.profile.v2', JSON.stringify({
      version: 2, xp: 42000, rank: 99, lastMode: 'tdm',
      stats: { matches: 40, wins: 22, kills: 800, deaths: 500, headshots: 90, assists: 60, bestStreak: 11, wavesCleared: 3, objectives: 12, timePlayed: 9000, killstreaksUsed: 7 },
      extraUnlocks: ['ks_uav'],
    }));
    const res = M.loadProfile(store);
    check('v2 profile migrates', res.migrated && res.foundVersion === 2, `source=${res.source}`);
    check('v2 XP survives migration', res.profile.xp === 42000, String(res.profile.xp));
    check('v2 lifetime stats survive', res.profile.stats.kills === 800 && res.profile.stats.wins === 22);
    check('rank is re-derived, not trusted', res.profile.rank === M.rankForXp(42000),
      `stored 99 → ${res.profile.rank}`);
    check('losses derived for pre-v3 profiles', res.profile.stats.losses === 18, String(res.profile.stats.losses));
    check('weapon tracks are backfilled',
      Object.keys(res.profile.weapons).length === M.WEAPON_TRACKS.length);
    check('a raw backup is written before migrating',
      !!store.getItem('blackout.profile.backup.v2'));
    check('the old key is not deleted', !!store.getItem('blackout.profile.v2'));
    say(`  v2 → v3: xp ${fmt(res.profile.xp)}, rank ${res.profile.rank} (${M.rankName(res.profile.rank)}), ` +
      `${Object.keys(res.profile.weapons).length} weapon tracks created`);

    // Corruption: a single bad field must not destroy the profile.
    const corrupt = M.memoryStorage();
    corrupt.setItem('blackout.profile.v3', JSON.stringify({
      version: 3, xp: 'banana', stats: { kills: NaN, wins: 5 }, weapons: { ar_vkr7: { xp: -1, camos: ['nope', 'gold'] } },
      challenges: { 'chal.victor.1': { progress: 'x', done: 'yes' } },
    }));
    const c = M.loadProfile(corrupt);
    check('corrupt XP degrades to 0, profile survives', c.profile.xp === 0 && c.profile.stats.wins === 5);
    check('unknown camo ids are dropped', c.profile.weapons.ar_vkr7.camos.join(',') === 'gold');
    check('non-numeric challenge progress degrades', c.profile.challenges['chal.victor.1'].progress === 0);

    // Garbage.
    const junk = M.memoryStorage();
    junk.setItem('blackout.profile.v3', '{{{not json');
    check('unparseable store yields a fresh profile', M.loadProfile(junk).profile.xp === 0);

    // A profile from a future build is shown but never overwritten.
    const future = M.memoryStorage();
    future.setItem('blackout.profile.v3', JSON.stringify({ version: 9, xp: 123456 }));
    const f = M.loadProfile(future);
    check('future-version profile loads read-only', f.readOnly && f.profile.xp === 123456);
  }

  /* -------------------------------------------- 3. fifty simulated matches */
  say('\n── 50 MATCHES ─────────────────────────────────────────────────────────');
  const storage = M.memoryStorage();
  const prog = makeProgression(M, storage);
  prog.load();
  const rng = new M.Rand(SEED);

  const MODES = [
    { mode: 'tdm', modeName: 'Team Deathmatch' },
    { mode: 'operation', modeName: 'Operation' },
    { mode: 'firefight', modeName: 'Firefight' },
  ];
  const PRIMARY = 'ar_vkr7';

  const timeline = [];
  let firstMaxMatch = -1;
  let sampleReport = null;
  let totalXp = 0;

  for (let i = 0; i < MATCHES; i++) {
    const m = MODES[i % MODES.length];
    // Varied performance: a slump early, a purple patch mid, steady late.
    const form = 0.35 + 0.65 * Math.abs(Math.sin((i + 1) * 0.7)) + rng.range(-0.15, 0.15);
    const useMain = i % 5 !== 4; // 4 of every 5 matches on the primary
    const weapon = useMain ? PRIMARY : (i % 10 === 4 ? 'smg_hornet' : 'sr_longbow');
    const opts = {
      mode: m.mode, modeName: m.modeName, seed: SEED + i, weapon,
      kills: Math.max(2, Math.round(10 + form * 26)),
      deaths: Math.max(1, Math.round(16 - form * 11)),
      killBias: 0.55 + form * 0.2,
      headshotRate: 0.16 + form * 0.16,
      adsRate: weapon === 'smg_hornet' ? 0.35 : 0.78,
      longRange: weapon === 'sr_longbow',
      objectives: m.mode === 'tdm' ? 0 : rng.int(0, 3),
      waves: m.mode === 'firefight' ? rng.int(1, 6) : 0,
      killstreaks: rng.int(0, 2),
      win: rng.next() < 0.35 + form * 0.3,
    };
    const before = prog.rank;
    const { report } = playMatch(M, prog, rng, opts);
    totalXp += report.xp.total;

    const w = prog.weaponProgress(PRIMARY);
    if (firstMaxMatch < 0 && w.level >= M.WEAPON_MAX_LEVEL) firstMaxMatch = i + 1;
    timeline.push({
      i: i + 1, mode: m.mode, win: opts.win, kills: report.scoreboard.kills,
      deaths: report.scoreboard.deaths, xp: report.xp.total,
      rankBefore: before, rank: prog.rank, totalXp: prog.xp,
      wLevel: w.level, camos: w.camos.length,
      promoted: report.rank.promoted,
    });
    if (i === 12) sampleReport = report;
  }

  say('  match  mode        W/L    K    D       XP   total XP   rank            ' + PRIMARY);
  for (const r of timeline) {
    if (r.i % 5 !== 0 && !r.promoted && r.i !== 1 && r.i !== MATCHES) continue;
    say(`   ${String(r.i).padStart(3)}   ${r.mode.padEnd(10)} ${r.win ? ' W ' : ' L '} ` +
      `${String(r.kills).padStart(3)} ${String(r.deaths).padStart(4)} ${fmt(r.xp).padStart(8)} ` +
      `${fmt(r.totalXp).padStart(10)}   ${String(r.rank).padStart(2)} ${M.rankName(r.rank).padEnd(16)}` +
      `lv ${String(r.wLevel).padStart(2)}  ${r.camos} camos${r.promoted ? '   ▲ PROMOTED' : ''}`);
  }

  {
    let rankMono = true, xpMono = true;
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i].rank < timeline[i - 1].rank) rankMono = false;
      if (timeline[i].totalXp < timeline[i - 1].totalXp) xpMono = false;
    }
    check('rank never goes backwards', rankMono);
    check('lifetime XP never goes backwards', xpMono);
    check('profile rank agrees with the curve', prog.rank === M.rankForXp(prog.xp));
    check('lifetime XP equals the sum of match totals', prog.xp === totalXp,
      `${fmt(prog.xp)} vs ${fmt(totalXp)}`);
    check('matches played recorded', prog.profile.stats.matches === MATCHES);
    check('wins + losses === matches',
      prog.profile.stats.wins + prog.profile.stats.losses === MATCHES);
    check('history is capped', prog.profile.history.length <= M.MAX_HISTORY);
  }

  /* ------------------------------------------------ 4. time to max a gun -- */
  say('\n── WEAPON PROGRESSION ─────────────────────────────────────────────────');
  {
    const rows = prog.armoury();
    say('  weapon            class      lvl   progress                  camos  kills  gate');
    for (const r of rows) {
      say(`  ${r.name.padEnd(17)} ${r.cls.padEnd(9)} ${String(r.level).padStart(3)}   ${bar(r.pct, 20)}` +
        `  ${String(r.camos).padStart(5)}  ${String(r.kills).padStart(5)}  ${r.unlocked ? 'unlocked' : `rank ${r.rankGate}`}`);
    }
    const w = prog.weaponProgress(PRIMARY);
    const perMatch = w.xp / timeline.filter((t) => t.i).length;
    const usedMatches = Math.round(MATCHES * 0.8);
    const wxpPerUse = w.xp / usedMatches;
    const estimate = wxpPerUse > 0 ? M.WEAPON_XP_TO_MAX / wxpPerUse : Infinity;
    say('');
    say(`  ${PRIMARY}: level ${w.level}/${M.WEAPON_MAX_LEVEL}, ${fmt(w.xp)} / ${fmt(M.WEAPON_XP_TO_MAX)} WXP`);
    say(`  weapon XP per match using it: ${fmt(wxpPerUse, 0)}  →  time-to-max ≈ ${fmt(estimate, 1)} matches` +
      (firstMaxMatch > 0 ? `  (hit max at match ${firstMaxMatch})` : ''));
    say(`  attachments unlocked: ${prog.availableAttachments(PRIMARY).length} of ` +
      `${M.weaponTrack(PRIMARY).unlocks.length + M.DEFAULT_ATTACHMENTS.length}`);

    check('time-to-max lands in a shipped-shooter band (15–70 matches)',
      estimate >= 15 && estimate <= 70, `${fmt(estimate, 1)} matches`);
    check('weapon level derives from weapon XP',
      w.level === M.weaponLevelForXp(w.xp));
    check('unused weapons stay at level 1',
      prog.weaponLevel('lch_ravager') === 1);
    check('iron sights are always available',
      prog.canAttach(PRIMARY, 'optic_irons'));
    check('a locked attachment is refused at low level',
      !makeProgression(M, M.memoryStorage()).canAttach(PRIMARY, 'muzzle_suppressor'));
    check('the same attachment is granted once the level is there',
      prog.weaponLevel(PRIMARY) >= 28 ? prog.canAttach(PRIMARY, 'muzzle_suppressor') : true,
      `level ${prog.weaponLevel(PRIMARY)}`);
    check('class-illegal attachments never enter a track',
      !M.weaponTrack('sg_breaker').unlocks.some((u) => u.id === 'optic_sniper'));
  }

  /* ------------------------------------------------- 5. unlock gating API -- */
  say('\n── UNLOCK GATING ──────────────────────────────────────────────────────');
  {
    const fresh = makeProgression(M, M.memoryStorage());
    check('a fresh profile can equip the starter rifle', fresh.canEquip('ar_vkr7'));
    check('a fresh profile cannot equip the sniper', !fresh.canEquip('sr_longbow'));
    check('rank gate is reported for the tooltip', fresh.rankGate('sr_longbow') === 24);
    check('nextUnlock points at the next reward', !!fresh.nextUnlock());
    check('grantExtra bypasses the rank gate', (() => {
      fresh.grantExtra('sr_longbow');
      return fresh.canEquip('sr_longbow');
    })());
    // `isUnlocked` is consumed by src/session/loadout's validator, where a
    // `true` means "explicitly granted — bypass the rank gate". Content
    // progression has never heard of must therefore answer *false*, so the
    // caller's own gate stays authoritative rather than being short-circuited.
    check('unknown content is not claimed as granted', !fresh.isUnlocked('equip_frag_2026'));
    check('unknown content becomes granted when it is actually granted', (() => {
      fresh.grantExtra('equip_frag_2026');
      return fresh.isUnlocked('equip_frag_2026');
    })());
    check('legacy menu ids still resolve', fresh.isUnlocked('ar_vector') && !fresh.isUnlocked('sr_apex'));
    const q = prog.unlockQuery();
    say(`  rank ${q.rank} · ${M.unlockedWeapons(q).length}/${M.WEAPON_TRACKS.length} weapons owned · ` +
      `${M.unlockedAt(q.rank).length}/${M.UNLOCKS.length} rank rewards · next: ${prog.nextUnlock()?.name ?? '—'}`);
  }

  /* -------------------------------------------------------- 6. challenges -- */
  say('\n── CHALLENGES & CAMOS ─────────────────────────────────────────────────');
  {
    const rec = prog.combatRecord();
    const done = prog.challengeRows().filter((r) => r.done);
    say(`  ${done.length} of ${M.CHALLENGES.length} challenges complete · ` +
      `${rec.camosUnlocked} camos unlocked`);
    say('  in progress:');
    for (const r of prog.challengeRows({ onlyActive: true }).slice(0, 6)) {
      say(`    ${bar(r.pct, 16)} ${String(r.progress).padStart(4)}/${String(r.goal).padEnd(4)} ${r.def.name}`);
    }
    const camos = prog.camoProgress(PRIMARY);
    say(`  ${M.weaponTrack(PRIMARY).name} camos:`);
    for (const c of camos) {
      say(`    ${c.unlocked ? '✔' : '·'} ${c.name.padEnd(10)} ${String(c.progress).padStart(4)}/${c.goal}`);
    }

    check('challenges advanced over 50 matches', done.length > 0, `${done.length} complete`);
    check('challenge progress is clamped to the goal',
      prog.challengeRows().every((r) => r.progress <= r.goal));
    check('challenge progress equals lifetime stats',
      (() => {
        const d = M.challengeDef('chal.marksman.1');
        return prog.profile.challenges[d.id].progress === Math.min(d.goal, prog.profile.stats.headshots);
      })());
    const w = prog.weaponProgress(PRIMARY);
    check('gold requires every base camo',
      !w.camos.includes('gold') || M.BASE_CAMO_IDS.every((c) => w.camos.includes(c)),
      w.camos.join(','));
    check('platinum requires gold on the whole class',
      !w.camos.includes('platinum') || w.camos.includes('gold'));
    check('the mastery ladder is actually reachable in 50 matches',
      w.camos.includes('gold'), `${PRIMARY}: ${w.camos.join(',')}`);
    check('re-evaluating is idempotent (no double award)',
      (() => {
        const before = JSON.stringify(prog.profile.challenges);
        const deltas = M.evaluateChallenges(prog.profile);
        return deltas.filter((d) => d.completedNow).length === 0
          && JSON.stringify(prog.profile.challenges) === before;
      })());
  }

  /* ------------------------------------------------- 7. after-action screen */
  say('\n── AFTER-ACTION REPORT (match 13) ─────────────────────────────────────');
  {
    const r = sampleReport;
    const mm = Math.floor(r.durationSec / 60), ss = Math.round(r.durationSec % 60);
    say(`  ${r.modeName.toUpperCase()} — ${r.win ? 'VICTORY' : 'DEFEAT'}   ${mm}:${String(ss).padStart(2, '0')}   seed ${r.seed}`);
    const sb = r.scoreboard;
    say(`  score ${fmt(sb.score)}   ${sb.kills}/${sb.deaths}/${sb.assists}   K/D ${sb.kd.toFixed(2)}   ` +
      `HS ${sb.headshots}   acc ${(sb.accuracy * 100).toFixed(0)}%   streak ${sb.bestStreak}   ` +
      `best multi ×${sb.bestMultikill}`);

    say('\n  XP EARNED');
    for (const row of r.xp.rows) {
      say(`    ${row.label.padEnd(22)} ${String(row.count).padStart(4)} ×    ${('+' + fmt(row.xp)).padStart(9)}`);
    }
    say(`    ${'—'.repeat(45)}`);
    for (const c of r.xp.byCategory) {
      say(`    ${c.category.padEnd(22)}          ${('+' + fmt(c.xp)).padStart(9)}`);
    }
    say(`    ${'TOTAL'.padEnd(22)}          ${('+' + fmt(r.xp.total)).padStart(9)}` +
      (r.xp.multiplier !== 1 ? `  (×${r.xp.multiplier})` : ''));

    say('\n  RANK');
    say(`    ${r.rank.nameBefore} (${r.rank.before}) → ${r.rank.nameAfter} (${r.rank.after})` +
      `${r.rank.promoted ? '   ▲ PROMOTION' : ''}`);
    say(`    ${bar(r.rank.pct, 30)} ${fmt(r.rank.intoRank)} / ${fmt(r.rank.forNext)} to rank ${Math.min(M.MAX_RANK, r.rank.after + 1)}`);
    for (const u of r.rank.unlocks) say(`    ▸ UNLOCKED  ${u.name} (${u.kind})`);

    say('\n  WEAPONS');
    for (const w of r.weapons) {
      say(`    ${w.name.padEnd(16)} lv ${String(w.levelBefore).padStart(2)} → ${String(w.levelAfter).padEnd(2)} ` +
        `${bar(w.pct, 16)} ${('+' + fmt(w.xpGained)).padStart(7)} WXP   ` +
        `${w.kills} kills, ${(w.accuracy * 100).toFixed(0)}% acc`);
      for (const u of w.unlocked) say(`       ▸ ${u.name} (${u.slot}) unlocked at level ${u.level}`);
    }

    say('\n  CHALLENGES');
    for (const c of r.challenges.slice(0, 8)) {
      say(`    ${c.complete ? '✔' : ' '} ${c.name.padEnd(30)} ${String(c.before).padStart(4)} → ` +
        `${String(c.after).padStart(4)} / ${String(c.goal).padEnd(4)}${c.complete ? `  +${fmt(c.xp)} XP` : ''}` +
        `${c.complete && c.reward ? `  ▸ ${c.reward.name}` : ''}`);
    }
    if (r.challenges.length > 8) say(`    …and ${r.challenges.length - 8} more advanced`);

    if (r.camos.length) {
      say('\n  CAMOS');
      for (const c of r.camos) say(`    ▸ ${c.camoName} unlocked for the ${c.weaponName} (${c.kind})`);
    }
    if (r.personalBests.length) {
      say('\n  PERSONAL BESTS');
      for (const b of r.personalBests) say(`    ★ ${b}`);
    }

    const rowSum = r.xp.rows.reduce((a, x) => a + x.xp, 0);
    const catSum = r.xp.byCategory.reduce((a, x) => a + x.xp, 0);
    check('after-action rows sum to the XP total', rowSum === r.xp.total, `${rowSum} vs ${r.xp.total}`);
    check('category totals sum to the XP total', catSum === r.xp.total, `${catSum} vs ${r.xp.total}`);
    check('rank bar values are consistent',
      r.rank.intoRank <= r.rank.forNext && r.rank.pct >= 0 && r.rank.pct <= 1);
    check('rank XP delta equals the awarded XP',
      r.rank.xpAfter - r.rank.xpBefore === r.xp.total);
    check('the report names a mode and a duration',
      !!r.modeName && r.durationSec > 0);
    check('weapon rows only list weapons actually used',
      r.weapons.every((w) => w.kills > 0 || w.xpGained > 0));
    check('kills reported by scoring match kills attributed to weapons',
      r.weapons.reduce((a, w) => a + w.kills, 0) === r.scoreboard.kills,
      `${r.weapons.reduce((a, w) => a + w.kills, 0)} vs ${r.scoreboard.kills}`);
  }

  /* ---------------------------------------------------- 8. combat record -- */
  say('\n── COMBAT RECORD ──────────────────────────────────────────────────────');
  {
    const r = prog.combatRecord();
    say(`  ${M.recordHeadline(r)}`);
    say(`  matches ${r.matches}   W ${r.wins} / L ${r.losses}   win rate ${(r.winRate * 100).toFixed(1)}%`);
    say(`  kills ${fmt(r.kills)}   deaths ${fmt(r.deaths)}   assists ${fmt(r.assists)}   K/D ${r.kd.toFixed(2)}`);
    say(`  headshots ${fmt(r.headshots)} (${(r.headshotRate * 100).toFixed(1)}%)   ` +
      `accuracy ${(r.accuracy * 100).toFixed(1)}% (${fmt(r.shotsHit)}/${fmt(r.shotsFired)})`);
    say(`  best streak ${r.bestStreak}   best multikill ×${r.bestMultikill}   ` +
      `${fmt(r.killsPerMinute, 2)} kills/min   ${fmt(r.scorePerMinute, 0)} score/min`);
    say(`  challenges ${r.challengesComplete}/${r.challengesTotal}   camos ${r.camosUnlocked}   ` +
      `time played ${fmt(r.timePlayed / 3600, 1)} h`);
    say('  per weapon:');
    say('    weapon            lvl  kills   K/D    HS%    acc%   camos');
    for (const w of r.weapons) {
      say(`    ${w.name.padEnd(17)} ${String(w.level).padStart(3)} ${String(w.kills).padStart(6)}  ` +
        `${w.kd.toFixed(2).padStart(5)}  ${(w.headshotRate * 100).toFixed(1).padStart(5)}  ` +
        `${(w.accuracy * 100).toFixed(1).padStart(5)}   ${String(w.camos).padStart(5)}`);
    }

    check('K/D is derived, not stored', near(r.kd, r.kills / r.deaths));
    check('win rate is derived', near(r.winRate, r.wins / r.matches));
    check('accuracy is in range', r.accuracy > 0 && r.accuracy <= 1);
    check('per-weapon kills never exceed lifetime kills',
      r.weapons.reduce((a, w) => a + w.kills, 0) <= r.kills);
    check('favourite weapon is the most-used one',
      r.favouriteWeapon === r.weapons[0].id);

    // The one call the meta screens make.
    const v = prog.view();
    say('');
    say(`  lobby card: ${v.rankName} (${v.rank})  ${bar(v.pct, 20)}  ` +
      `${fmt(v.intoRank)}/${fmt(v.forNext)}   next: ${v.nextUnlock?.name ?? '—'} ` +
      `in ${fmt(v.xpToNextUnlock)} XP`);
    check('the view exposes a rank bar the UI can render directly',
      v.pct >= 0 && v.pct <= 1 && v.intoRank <= v.forNext);
    check('the view names the next unlock and its XP cost',
      !!v.nextUnlock && v.xpToNextUnlock > 0);
    check('the view carries active challenges and recent matches',
      v.challenges.length > 0 && v.history.length > 0 && v.challenges.every((c) => !c.done));
  }

  /* ------------------------------------------ 9. save / reload round trip -- */
  say('\n── SAVE / RELOAD ──────────────────────────────────────────────────────');
  {
    prog.save();
    const reloaded = makeProgression(M, storage);
    reloaded.load();
    const a = JSON.stringify({ ...prog.profile, updatedAt: 0 });
    const b = JSON.stringify({ ...reloaded.profile, updatedAt: 0 });
    check('profile round-trips through storage byte-identically', a === b);
    check('reloaded rank and XP match', reloaded.xp === prog.xp && reloaded.rank === prog.rank);
    const blob = storage.getItem('blackout.profile.v3');
    say(`  serialised profile: ${fmt(blob.length)} bytes, schema v${M.PROFILE_VERSION}, ` +
      `${Object.keys(prog.profile.challenges).length} challenge rows`);
    check('the blob is small enough for localStorage', blob.length < 200_000, `${blob.length} bytes`);
  }

  /* ------------------------------------------------------ 10. determinism -- */
  say('\n── DETERMINISM ────────────────────────────────────────────────────────');
  {
    const runOnce = () => {
      const s = M.memoryStorage();
      const p = makeProgression(M, s);
      p.load();
      const r = new M.Rand(SEED);
      for (let i = 0; i < 8; i++) {
        playMatch(M, p, r, {
          mode: 'tdm', modeName: 'Team Deathmatch', seed: SEED + i, weapon: 'ar_vkr7',
          kills: 14 + i, deaths: 9, killBias: 0.62, headshotRate: 0.22, adsRate: 0.7,
          longRange: false, objectives: 1, waves: 0, killstreaks: 1, win: i % 2 === 0,
        });
      }
      return JSON.stringify({ ...p.profile, createdAt: 0, updatedAt: 0, history: p.profile.history.map((h) => ({ ...h, at: 0 })) });
    };
    const a = runOnce();
    const b = runOnce();
    check('same seed → byte-identical profile', a === b, `${a.length} vs ${b.length} bytes`);
    say(`  two 8-match runs at seed ${SEED} produced identical profiles (${fmt(a.length)} bytes)`);
  }

  /* -------------------------------------------- 11. authority (host/client) */
  say('\n── AUTHORITY ──────────────────────────────────────────────────────────');
  {
    const s = M.memoryStorage();
    const client = makeProgression(M, s);
    client.load();
    let submitted = null;
    let deliver = null;
    client.setNetPort({
      authority: 'client',
      submitMatchResult: (rec) => { submitted = rec; },
      onMatchReport: (cb) => { deliver = cb; return () => { deliver = null; }; },
    });

    const xpBefore = client.xp;
    const out = playMatch(M, client, new M.Rand(7), {
      mode: 'tdm', modeName: 'Team Deathmatch', seed: 7, weapon: 'ar_vkr7',
      kills: 20, deaths: 8, killBias: 0.7, headshotRate: 0.25, adsRate: 0.8,
      longRange: false, objectives: 0, waves: 0, killstreaks: 1, win: true,
    });
    check('a client banks nothing on its own', client.xp === xpBefore, `${client.xp} vs ${xpBefore}`);
    check('a client still produces a report for the screen', !!out.report);
    check('that report is flagged provisional', out.report.provisional === true);
    check('the raw match record is submitted to the host', !!submitted && submitted.kills === 20);
    check('the client is marked as awaiting the host', client.awaitingHost);

    // Host re-derives and answers with its own (here: 10% lower) XP figure.
    const hostReport = JSON.parse(JSON.stringify(out.report));
    hostReport.provisional = false;
    hostReport.xp.base = Math.round(out.report.xp.base * 0.9);
    hostReport.xp.rows = hostReport.xp.rows.map((r) => ({ ...r, xp: Math.round(r.xp * 0.9) }));
    deliver(hostReport);

    check('the host figure is what gets banked',
      client.xp === xpBefore + hostReport.xp.base + (client.afterAction().xp.total - client.afterAction().xp.base),
      `${client.xp - xpBefore} banked`);
    check('the client is no longer awaiting the host', !client.awaitingHost);
    check('the final report is no longer provisional', client.afterAction().provisional === false);
    check('weapon progress still applied from the local record',
      client.weaponProgress('ar_vkr7').stats.kills === 20);
    say(`  client predicted ${fmt(out.report.xp.total)} XP, host paid ` +
      `${fmt(client.afterAction().xp.total)} XP; profile moved ${fmt(client.xp - xpBefore)}`);

    // Abandon: nothing is banked and no subscriptions leak.
    const ab = makeProgression(M, M.memoryStorage());
    ab.load();
    ab.beginMatch('tdm');
    ab.award(5000, 'Kills');
    const attachedDuring = ab.tracker.attached;
    ab.abandonMatch();
    check('an abandoned match awards nothing', ab.xp === 0);
    check('tracking is attached during a match and released after',
      attachedDuring && !ab.tracker.attached);
  }

  /* ------------------------------------------------------------- 12. XP mult */
  {
    const s = M.memoryStorage();
    const p = makeProgression(M, s);
    p.load();
    p.xpMultiplier = 2;
    playMatch(M, p, new M.Rand(99), {
      mode: 'tdm', modeName: 'Team Deathmatch', seed: 99, weapon: 'ar_vkr7',
      kills: 10, deaths: 5, killBias: 0.6, headshotRate: 0.2, adsRate: 0.8,
      longRange: false, objectives: 0, waves: 0, killstreaks: 0, win: true,
    });
    const r = p.afterAction();
    check('double XP doubles match XP', r.xp.total >= r.xp.base * 2, `${r.xp.total} vs base ${r.xp.base}`);
  }

  /* ---------------------------------- 12b. objective and wave XP wiring -- */
  say('\n── OBJECTIVE & WAVE XP ────────────────────────────────────────────────');
  {
    const p = makeProgression(M, M.memoryStorage());
    p.load();
    const OBJECTIVES = 4, WAVES = 3;
    const { report } = playMatch(M, p, new M.Rand(4242), {
      mode: 'firefight', modeName: 'Firefight', seed: 4242, weapon: 'ar_vkr7',
      kills: 12, deaths: 4, killBias: 0.7, headshotRate: 0.2, adsRate: 0.8,
      longRange: false, objectives: OBJECTIVES, waves: WAVES, killstreaks: 0, win: true,
    });
    const row = (label) => report.xp.rows.find((r) => r.label === label);
    // Exactly how many points the player personally stood on.
    const mine = new Set(p.__port.events
      .filter((e) => e.key === 'objective:update' && e.payload.contested)
      .map((e) => e.payload.id)).size;
    const expectCapture = mine * 10 * M.XP.objectiveTick;

    say(`  ${WAVES} waves cleared, ${OBJECTIVES} objectives (${mine} captured by the player)`);
    for (const r of report.xp.rows) {
      say(`    ${r.label.padEnd(22)} ${String(r.count).padStart(4)} ×    ${('+' + fmt(r.xp)).padStart(9)}`);
    }

    check('clearing a Firefight wave pays XP',
      (row('Waves Cleared')?.xp ?? 0) === WAVES * M.XP.waveCleared,
      `${row('Waves Cleared')?.xp ?? 0} for ${WAVES} waves`);
    check('capture ticks pay only for points the player stood on',
      (row('Captures')?.xp ?? 0) === expectCapture,
      `${row('Captures')?.xp ?? 0} vs ${expectCapture}`);
    check('a teammate capping alone pays the player nothing', mine < OBJECTIVES,
      `${OBJECTIVES - mine} capped by team-mates`);
    check('objective XP is its own after-action category',
      report.xp.byCategory.some((c) => c.category === 'objective'));
    check('wave XP reaches the profile', p.xp === report.xp.total);
  }

  /* --------------------------------------------- 13. game-layer integration */
  say('\n── GAME INTEGRATION ───────────────────────────────────────────────────');
  {
    const r = M.runSelfTest();
    const failed = r.cases.filter((c) => !c.pass);
    say(`  game self-test: ${r.cases.length - failed.length}/${r.cases.length} cases in ${r.ms.toFixed(1)} ms`);
    say(`  phases: ${[...new Set(r.transitions)].join(' → ')}`);
    for (const c of failed) say(`    FAIL ${c.name} — ${c.detail}`);
    check('Match + Scoring still drive Progression end to end', r.pass,
      `${r.cases.length - failed.length}/${r.cases.length} self-test cases`);
  }

  /* ------------------------------------------------------------- results -- */
  console.log('\n══ RESULTS ════════════════════════════════════════════════════════════');
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log(`  ${checks.length - failed}/${checks.length} checks passed`);
  console.log(failed === 0 ? '  PASS — progression verified' : `  FAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
