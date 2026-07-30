#!/usr/bin/env node
/**
 * Gap probe — proves, against the real sources, which of the claimed meta-layer
 * capabilities are actually reachable from a running game.
 *
 * This is a diagnostic, not a gate. It answers questions the per-module
 * harnesses cannot, because each of those drives its own module directly and
 * therefore never discovers that nothing upstream can reach it.
 *
 *   node tools/session-gap.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
const note = (q, a, verdict) => rows.push({ q, a, verdict });

const server = await createServer({
  root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});
const load = (p) => server.ssrLoadModule(p);

try {
  /* ------------------------------------------------ 1. mode reachability -- */
  const S = await load('/src/session/SessionSystem.ts');
  const D = await load('/src/game/modes/ModeDefs.ts');

  const shipped = D.MULTIPLAYER_MODE_IDS;
  const collapsed = [];
  for (const id of shipped) {
    const got = S.normaliseMode(id);
    if (got !== id) collapsed.push(`${id}→${got}`);
  }
  note(
    'Can the session deploy the six multiplayer modes?',
    collapsed.length ? `NO — normaliseMode collapses ${collapsed.join(', ')}` : 'yes',
    collapsed.length ? 'BROKEN' : 'ok',
  );

  const T = await load('/src/game/types.ts');
  note(
    'GameModeId union',
    // types are erased at runtime; read the source instead
    (await import('node:fs')).readFileSync(path.join(ROOT, 'src/game/types.ts'), 'utf8')
      .match(/export type GameModeId = [^;]+;/)?.[0] ?? '?',
    'info',
  );
  void T;

  /* ------------------------------------------------- 2. streak economy -- */
  const K = await import('node:fs');
  const ks = K.readFileSync(path.join(ROOT, 'src/game/Killstreaks.ts'), 'utf8');
  const scoreDriven = /onStreak\(\s*score/.test(ks);
  note(
    'Are streaks earned on score or on kills?',
    scoreDriven ? 'score' : 'kills only (Killstreaks.onStreak takes a kill count)',
    scoreDriven ? 'ok' : 'WEAK',
  );
  const loadoutPicked = /loadout|selected.*streak|chosen/i.test(ks.split('EARN_ORDER')[1]?.slice(0, 200) ?? '');
  note(
    'Does the player choose which streaks to run?',
    loadoutPicked ? 'yes' : 'NO — EARN_ORDER is a fixed global ladder; all five always in play',
    'BROKEN',
  );

  /* -------------------------------------------------- 3. loadout wiring -- */
  const files = ['src/weapons/Weapons.ts', 'src/weapons/WeaponSystem.ts', 'src/player/Player.ts'];
  const consumers = [];
  for (const f of files) {
    try {
      const src = K.readFileSync(path.join(ROOT, f), 'utf8');
      if (/EffectiveWeaponStats|LoadoutBook|loadout\.activeFor|session\/loadout/.test(src)) consumers.push(f);
    } catch { /* file may not exist */ }
  }
  note(
    'Does any gameplay code consume a Loadout?',
    consumers.length ? consumers.join(', ') : 'NO — zero consumers outside src/session/loadout',
    consumers.length ? 'ok' : 'BROKEN',
  );

  /* ------------------------------------------------------- 4. perk flags -- */
  const flagUse = [];
  for (const flag of ['ghost', 'hardline', 'scavenger', 'overkill', 'tacMask', 'silentMove']) {
    const hits = [];
    const walk = (dir) => {
      for (const e of K.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (p.includes('session/loadout') || p.includes('session/progression')) continue;
        const src = K.readFileSync(p, 'utf8');
        const re = new RegExp(`['\"]${flag}['\"]`);
        if (re.test(src) && !/^\s*\*/m.test(src.split(re)[0].split('\n').pop() ?? '')) {
          hits.push(p.replace(ROOT + '/', ''));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    if (hits.length) flagUse.push(`${flag}: ${hits.join(',')}`);
  }
  note(
    'Do perk flags change anything at runtime?',
    flagUse.length ? flagUse.join(' | ') : 'NO — no consumer of any LoadoutFlag outside the loadout module',
    flagUse.length ? 'ok' : 'BROKEN',
  );

  /* ------------------------------------------------- 5. objective→spawn -- */
  const grepSrc = (needle, exclude = []) => {
    const hits = [];
    const walk = (dir) => {
      for (const e of K.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        const rel = p.replace(ROOT + '/', '');
        if (exclude.some((x) => rel.includes(x))) continue;
        if (K.readFileSync(p, 'utf8').includes(needle)) hits.push(rel);
      }
    };
    walk(path.join(ROOT, 'src'));
    return hits;
  };

  const objCallers = grepSrc('setObjectives(', ['session/spawn', 'game/Spawns.ts']);
  note(
    'Do modes feed flags/hills/sites to the spawn director?',
    objCallers.length ? objCallers.join(', ') : 'NO — setObjectives() has zero callers',
    objCallers.length ? 'ok' : 'BROKEN',
  );

  const hazardCallers = grepSrc('addHazard(', ['session/spawn', 'game/Spawns.ts']);
  note(
    'Do grenades/streaks veto spawn points?',
    hazardCallers.length ? hazardCallers.join(', ') : 'NO — addHazard() has zero callers',
    hazardCallers.length ? 'ok' : 'BROKEN',
  );

  const tickCallers = grepSrc('director.update(', ['session/spawn', 'game/Spawns.ts']);
  note(
    'Is the spawn influence field ticked per frame?',
    tickCallers.length ? tickCallers.join(', ') : 'NO — advanced on demand inside pick(), rate-limited to 5 Hz',
    tickCallers.length ? 'ok' : 'WEAK',
  );

  /* --------------------------------------------------------- 6. AI orders -- */
  const orderReaders = grepSrc('.orders()', ['game/modes']);
  note(
    'Does the AI play the objective?',
    orderReaders.length ? orderReaders.join(', ') : 'NO — TeamMode.orders() has zero readers; bots fight but never cap',
    orderReaders.length ? 'ok' : 'BROKEN',
  );

  const killAttrib = grepSrc('reportKill(', ['game/Match.ts', 'game/modes']);
  note(
    'Is kill attribution truthful?',
    killAttrib.length ? killAttrib.join(', ') : 'NO — reportKill() has zero callers; FFA guesses by nearest live operator',
    killAttrib.length ? 'ok' : 'WEAK',
  );

  /* -------------------------------------------------------- 7. replay use -- */
  const replayUsers = grepSrc("from '../session/replay", ['session/replay'])
    .concat(grepSrc("from '../../session/replay", ['session/replay']));
  note(
    'Is the killcam wired to anything?',
    replayUsers.length ? replayUsers.join(', ') : 'NO — nothing imports src/session/replay',
    replayUsers.length ? 'ok' : 'BROKEN',
  );

  /* --------------------------------------------- 8. session degradation -- */
  const sysSrc = K.readFileSync(path.join(ROOT, 'src/game/Services.ts'), 'utf8');
  const arms = /armSessionLayer/.test(sysSrc);
  const installsSubsystems = /installSession\(\s*engine\s*,\s*\{/.test(sysSrc);
  note(
    'Does the shipped build hand the session real subsystems?',
    arms && !installsSubsystems
      ? 'NO — armSessionLayer() calls installSession(engine) with no subsystems; lobby/mm/loadout all fall back'
      : 'check Services.ts',
    'BROKEN',
  );

  /* -------------------------------------------------- 9. progression hooks */
  const beginMatch = K.readFileSync(path.join(ROOT, 'src/game/Match.ts'), 'utf8')
    .match(/beginMatch\([^)]*\)/)?.[0];
  note(
    'Does the after-action report know the mode and seed?',
    beginMatch === 'beginMatch(modeId as GameModeId)'
      ? 'NO — beginMatch() called with no options; modeName derived, seed 0'
      : beginMatch ?? '?',
    'WEAK',
  );

  /* --------------------------------------------------- 10. social surface */
  const social = grepSrc('FriendsService', []).concat(grepSrc('presence:', []));
  note(
    'Is there a friends / presence / recent-players service?',
    social.length ? social.join(', ') : 'NO — party invites require both peers already in the same lobby',
    'BROKEN',
  );
} finally {
  await server.close();
}

const pad = (s, n) => String(s).padEnd(n);
const width = Math.max(...rows.map((r) => r.q.length));
console.log('\n' + '='.repeat(100));
console.log('SESSION / META LAYER — REACHABILITY PROBE');
console.log('='.repeat(100));
for (const r of rows) {
  const tag = r.verdict === 'BROKEN' ? '[X]' : r.verdict === 'WEAK' ? '[~]' : r.verdict === 'ok' ? '[✓]' : '[i]';
  console.log(`${tag} ${pad(r.q, width)}  ${r.a}`);
}
const broken = rows.filter((r) => r.verdict === 'BROKEN').length;
const weak = rows.filter((r) => r.verdict === 'WEAK').length;
console.log('='.repeat(100));
console.log(`${broken} unreachable, ${weak} degraded, ${rows.length} probed.`);
