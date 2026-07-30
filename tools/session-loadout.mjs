#!/usr/bin/env node
/**
 * Headless verification for `src/session/loadout` (create-a-class).
 *
 * Bundles the module with vite (it is pure data + maths — no three.js, no DOM),
 * then exercises it for real:
 *
 *   1. data integrity  — no free-upgrade attachments, full unlock coverage,
 *                        killstreak costs in step with src/game/Killstreaks.ts
 *   2. stat tables     — base vs modified for every single attachment, and for
 *                        a set of complete builds
 *   3. combination     — every legal attachment combination on every weapon,
 *      sweep             asserted against an independent sane-bounds table
 *   4. determinism     — shuffled attachment order must resolve identically
 *   5. trust boundary  — hostile loadouts must be rejected with the right code
 *   6. authority       — request → grant → respawn semantics
 *
 * Usage:
 *   node tools/session-loadout.mjs
 *   node tools/session-loadout.mjs --seed 99 --no-build --weapon ar_vkr7
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const SEED = Number(flag('seed', 1337));
const BUNDLE_DIR = path.join(ROOT, '.loadout-bundle');

/* ------------------------------------------------------------- reporting */

let passCount = 0;
const failures = [];
const warnings = [];

function check(name, condition, detail = '') {
  if (condition) { passCount++; return true; }
  failures.push(detail ? `${name} — ${detail}` : name);
  return false;
}
function warn(text) { warnings.push(text); }

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const f = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const pct = (v, base) => {
  if (!Number.isFinite(v) || !Number.isFinite(base) || base === 0) return '   —  ';
  const p = (v / base - 1) * 100;
  const s = `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
  return padL(s, 7);
};
function rule(title) {
  console.log(`\n${'─'.repeat(96)}\n${title}\n${'─'.repeat(96)}`);
}

/* --------------------------------------------------------------- bundling */

async function loadModule() {
  const entry = path.join(BUNDLE_DIR, 'entry.mjs');
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const src = (p) => pathToFileURL(path.join(ROOT, p)).href;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(entry, [
    `export * from ${JSON.stringify(src('src/session/loadout/index.ts'))};`,
    `export { Rand } from ${JSON.stringify(src('src/core/Rand.ts'))};`,
    `export { WEAPONS, weaponDef, damageAt } from ${JSON.stringify(src('src/weapons/Catalog.ts'))};`,
    `export { ATTACHMENTS as WEAPON_ATTACHMENTS } from ${JSON.stringify(src('src/weapons/Attachments.ts'))};`,
  ].join('\n'));

  const { build } = await import('vite');
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    build: {
      outDir: BUNDLE_DIR,
      emptyOutDir: false,
      minify: false,
      target: 'esnext',
      lib: { entry, formats: ['es'], fileName: () => 'loadout.bundle.mjs' },
    },
  });
  const ns = await import(pathToFileURL(path.join(BUNDLE_DIR, 'loadout.bundle.mjs')).href);
  // A module namespace is frozen; the harness hangs a couple of derived
  // lookups off it, so hand back a mutable shallow copy.
  return { ...ns };
}

/* ------------------------------------------------------ 1. data integrity */

function dataIntegrity(L) {
  rule('1. DATA INTEGRITY');

  const issues = L.auditAttachments(
    (stat) => L.STAT_RULES[stat].better,
    (flag) => L.FLAG_SIDE[flag] ?? 'pro',
  );
  check('no-free-lunch: every attachment costs something', issues.length === 0,
    issues.map((i) => `${i.id}: ${i.problem}`).join('; '));
  console.log(`  attachments: ${L.ATTACHMENT_TABLE.length} entries, `
    + `${L.ATTACHMENT_TABLE.filter((a) => !a.baseline).length} with real modifiers, `
    + `${issues.length} audit issues`);

  const missingMeta = L.assertWeaponMetaCoverage();
  check('every catalogue weapon has an unlock rank', missingMeta.length === 0, missingMeta.join(', '));

  // Every stat key must have a rule, and every rule must be sane.
  let badRules = 0;
  for (const key of L.STAT_KEYS) {
    const r = L.STAT_RULES[key];
    if (!r || !(r.minMul > 0) || !(r.maxMul >= r.minMul) || !(r.soften > 0 && r.soften <= 1)) badRules++;
  }
  check('every stat has a coherent rule', badRules === 0, `${badRules} bad`);

  // Killstreak costs must match the game module, which owns them.
  const ksSrc = readFileSync(path.join(ROOT, 'src/game/Killstreaks.ts'), 'utf8');
  let ksMismatch = 0;
  for (const ks of L.KILLSTREAK_OPTIONS) {
    const re = new RegExp(`id: '${ks.id}'[^\\n]*cost: (\\d+)`);
    const m = ksSrc.match(re);
    if (!m) { warn(`killstreak "${ks.id}" not found in src/game/Killstreaks.ts`); continue; }
    if (Number(m[1]) !== ks.cost) {
      ksMismatch++;
      warn(`killstreak "${ks.id}" cost ${ks.cost} != game ${m[1]}`);
    }
  }
  check('killstreak costs match src/game/Killstreaks.ts', ksMismatch === 0, `${ksMismatch} mismatched`);

  // Mesh coverage: every non-barrel attachment should map to a real weapon part.
  const meshIds = new Set(L.__weaponAttachmentIds);
  const missingMesh = L.ATTACHMENT_TABLE
    .filter((a) => a.mesh !== null && !meshIds.has(a.mesh))
    .map((a) => `${a.id}→${a.mesh}`);
  check('every declared mesh id exists in src/weapons/Attachments.ts',
    missingMesh.length === 0, missingMesh.join(', '));
  const noMesh = L.ATTACHMENT_TABLE.filter((a) => !a.baseline && a.mesh === null);
  console.log(`  mesh coverage: ${L.ATTACHMENT_TABLE.filter((a) => a.mesh).length} mapped, `
    + `${noMesh.length} numbers-only (${noMesh.map((a) => a.id).join(', ')})`);

  // Perk rows and exclusivity groups.
  for (const row of [1, 2, 3]) {
    const n = L.PERK_TABLE.filter((p) => p.row === row).length;
    check(`perk row ${row} has options`, n >= 3, `${n} perks`);
  }
  const crossRowGroups = new Set();
  for (const p of L.PERK_TABLE) {
    if (!p.group) continue;
    const others = L.perkConflicts(p.id).map((id) => L.perkDef(id));
    if (others.some((o) => o && o.row !== p.row)) crossRowGroups.add(p.group);
  }
  check('anti-stacking groups span rows (otherwise they are inert)',
    crossRowGroups.size >= 2, `${crossRowGroups.size} cross-row groups`);
  console.log(`  perks: ${L.PERK_TABLE.length}, cross-row exclusivity groups: ${[...crossRowGroups].join(', ')}`);
}

/* ---------------------------------------------------- 2. per-attachment table */

function singleAttachmentTable(L, weaponId) {
  const def = L.weaponDef(weaponId);
  rule(`2. ATTACHMENT DELTAS — ${def.name} (${def.cls})`);
  const base = L.resolveWeapon(weaponId, []);
  const cols = [
    ['ADS s', (e) => f(e.adsTime, 3), (e) => e.adsTime],
    ['SprOut', (e) => f(e.sprintOut, 3), (e) => e.sprintOut],
    ['Rec↕', (e) => f(e.recoilVerticalScale, 3), (e) => e.recoilVerticalScale],
    ['Rec↔', (e) => f(e.recoilHorizontalScale, 3), (e) => e.recoilHorizontalScale],
    ['Sway', (e) => f(e.swayScale, 3), (e) => e.swayScale],
    ['Hip°', (e) => f(e.hipSpreadDeg, 3), (e) => e.hipSpreadDeg],
    ['ADS°', (e) => f(e.adsSpreadDeg, 3), (e) => e.adsSpreadDeg],
    ['Mag', (e) => String(e.magSize), (e) => e.magSize],
    ['m/s', (e) => f(e.muzzleVelocity, 0), (e) => e.muzzleVelocity],
    ['Rng×', (e) => f(e.falloffScale, 3), (e) => e.falloffScale],
    ['Move', (e) => f(e.moveScale, 3), (e) => e.moveScale],
  ];
  console.log(`  ${pad('attachment', 22)}${cols.map((c) => padL(c[0], 9)).join('')}`);
  console.log(`  ${pad('BASE', 22)}${cols.map((c) => padL(c[1](base), 9)).join('')}`);
  for (const a of L.ATTACHMENT_TABLE) {
    if (a.baseline) continue;
    if (!L.mountable(def, a)) continue;
    const eff = L.resolveWeapon(weaponId, [a.id]);
    const cells = cols.map((c) => {
      const v = c[2](eff);
      const b = c[2](base);
      const changed = Math.abs(v - b) > 1e-6;
      return padL(changed ? c[1](eff) : '·', 9);
    });
    console.log(`  ${pad(a.id, 22)}${cells.join('')}`);
  }
  console.log(`\n  (· = unchanged from base)`);
}

/* --------------------------------------------------------- 3. build table */

const BUILDS = [
  ['ar_vkr7', 'stock', []],
  ['ar_vkr7', 'run-and-gun', ['optic_reddot', 'barrel_short', 'laser_visible', 'mag_quick', 'stock_none']],
  ['ar_vkr7', 'recoil-stack', ['muzzle_comp', 'under_grip', 'stock_heavy', 'barrel_heavy', 'optic_acog']],
  // muzzle_brake is heavy-calibre only (sniper/marksman/lmg/shotgun), so the
  // long-range AR takes the flash hider — the muzzle an assault rifle can fit.
  ['ar_vkr7', 'long-range', ['optic_acog', 'barrel_long', 'muzzle_flash', 'under_grip', 'stock_heavy']],
  ['ar_vkr7', 'stealth', ['optic_holo', 'muzzle_suppressor', 'barrel_long', 'mag_extended', 'stock_heavy']],
  ['smg_hornet', 'stock', []],
  ['smg_hornet', 'max-mobility', ['optic_irons', 'barrel_short', 'laser_visible', 'stock_none', 'mag_quick']],
  ['smg_hornet', 'drum-suppressed', ['optic_holo', 'muzzle_suppressor', 'mag_drum', 'under_grip', 'stock_heavy']],
  ['sr_longbow', 'stock', []],
  ['sr_longbow', 'quickscope', ['optic_reddot', 'barrel_short', 'stock_light', 'mag_quick']],
  ['sr_longbow', 'anti-materiel', ['optic_sniper', 'barrel_long', 'muzzle_brake', 'under_bipod', 'mag_ap']],
  ['lmg_vulcan', 'stock', []],
  ['lmg_vulcan', 'bipod-nest', ['optic_acog', 'muzzle_brake', 'under_bipod', 'barrel_heavy', 'mag_drum']],
  ['pi_sidewinder', 'stock', []],
  ['pi_sidewinder', 'akimbo-ish', ['optic_reddot', 'laser_visible', 'mag_quick']],
];

function buildTable(L) {
  rule('3. COMPLETE BUILDS — base vs modified');
  const head = ['weapon', 'build', 'ADS', 'SprOut', 'Reload', 'Rec↕', 'Sway', 'Hip°', 'ADS°',
    'Mag', 'm/s', 'Rng×', 'Move', 'Zoom', 'STK@25m'];
  console.log('  ' + pad(head[0], 14) + pad(head[1], 17) + head.slice(2).map((h) => padL(h, 9)).join(''));
  for (const [weaponId, label, attachments] of BUILDS) {
    const base = L.resolveWeapon(weaponId, []);
    const eff = L.resolveWeapon(weaponId, attachments);
    check(`build "${label}" resolves every attachment it asked for`,
      eff.attachments.length === attachments.filter((a) => !L.isBaseline(L.attachmentEntry(a) ?? { baseline: true })).length,
      `asked ${attachments.length}, got ${eff.attachments.length}: ${eff.warnings.join('; ')}`);
    const row = [
      pad(eff.weaponName, 14),
      pad(label, 17),
      padL(f(eff.adsTime, 3), 9),
      padL(f(eff.sprintOut, 3), 9),
      padL(f(eff.reloadTactical, 2), 9),
      padL(f(eff.recoilVerticalScale, 3), 9),
      padL(f(eff.swayScale, 2), 9),
      padL(f(eff.hipSpreadDeg, 2), 9),
      padL(f(eff.adsSpreadDeg, 3), 9),
      padL(String(eff.magSize), 9),
      padL(f(eff.muzzleVelocity, 0), 9),
      padL(f(eff.falloffScale, 2), 9),
      padL(f(eff.moveScale, 3), 9),
      padL(f(eff.magnification, 1), 9),
      padL(String(L.effectiveShotsToKill(eff, 25)), 9),
    ];
    console.log('  ' + row.join(''));
    if (attachments.length) {
      const delta = [
        pad('', 14), pad('  Δ vs base', 17),
        padL(pct(eff.adsTime, base.adsTime), 9),
        padL(pct(eff.sprintOut, base.sprintOut), 9),
        padL(pct(eff.reloadTactical, base.reloadTactical), 9),
        padL(pct(eff.recoilVerticalScale, 1), 9),
        padL(pct(eff.swayScale, base.swayScale), 9),
        padL(pct(eff.hipSpreadDeg, base.hipSpreadDeg), 9),
        padL(pct(eff.adsSpreadDeg, base.adsSpreadDeg), 9),
        padL(pct(eff.magSize, base.magSize), 9),
        padL(pct(eff.muzzleVelocity, base.muzzleVelocity), 9),
        padL(pct(eff.falloffScale, 1), 9),
        padL(pct(eff.moveScale, base.moveScale), 9),
        padL('', 9),
        padL('', 9),
      ];
      console.log('  ' + delta.join(''));
      if (eff.capped.length) console.log(`  ${' '.repeat(31)}capped: ${eff.capped.join(', ')}`);
    }
  }
}

/* -------------------------------------------------- 4. diminishing returns */

function diminishingReturns(L) {
  rule('4. DIMINISHING RETURNS — stacking recoil control on the VKR-7');
  const stack = ['muzzle_comp', 'under_grip', 'stock_heavy', 'barrel_heavy'];
  let naive = 1;
  console.log(`  ${pad('fitted', 52)}${padL('recoil↕', 10)}${padL('naive∏', 10)}${padL('gap', 10)}`);
  for (let n = 0; n <= stack.length; n++) {
    const ids = stack.slice(0, n);
    const eff = L.resolveWeapon('ar_vkr7', ids);
    naive = 1;
    for (const id of ids) {
      const entry = L.attachmentEntry(id);
      for (const m of entry.mods) if (m.stat === 'recoilVertical' && m.mode === 'mul') naive *= m.value;
    }
    const gap = eff.recoilVerticalScale - naive;
    console.log(`  ${pad(ids.join(' + ') || '(none)', 52)}${padL(f(eff.recoilVerticalScale, 4), 10)}`
      + `${padL(f(naive, 4), 10)}${padL(`${gap >= 0 ? '+' : ''}${gap.toFixed(4)}`, 10)}`);
    if (n >= 2) {
      check(`stacking ${n} recoil parts is damped vs the naive product`,
        eff.recoilVerticalScale > naive + 1e-6,
        `got ${eff.recoilVerticalScale}, naive ${naive}`);
    }
  }
}

/* ------------------------------------------------------ 5. sweep + bounds */

/**
 * Independent sanity rails. These are *not* the clamp table the module uses —
 * they are what a designer would call absurd, written here so a mistake in the
 * clamp table cannot mark its own homework.
 */
const SANE_ABS = {
  adsTime: [0.10, 1.00],
  sprintOut: [0.04, 0.70],
  drawTime: [0.15, 1.60],
  moveScale: [0.70, 1.15],
  adsMoveScale: [0.15, 0.95],
  hipSpreadDeg: [0.30, 14.0],
  adsSpreadDeg: [0.005, 1.50],
  recoilVerticalScale: [0.40, 2.00],
  recoilHorizontalScale: [0.40, 2.00],
  swayScale: [0.30, 3.00],
  magSize: [1, 250],
  falloffScale: [0.70, 1.50],
  magnification: [1, 12],
  reloadTactical: [0.40, 6.00],
  reloadPerShell: [0.15, 1.20],
};
/**
 * A stat whose *base* is zero does not exist on that weapon — a shell-by-shell
 * shotgun has no tactical reload, a hitscan gun no travel time. Bounds are only
 * meaningful where the weapon has the stat at all.
 */
const absent = (base, key) => !(base[key] > 0);
/** Rails relative to the same weapon with nothing fitted. */
const SANE_REL = {
  adsTime: [0.55, 2.00],
  muzzleVelocity: [0.78, 1.40],
  magSize: [0.45, 2.60],
  hipSpreadDeg: [0.40, 2.00],
  reloadTactical: [0.55, 2.00],
};

function combos(slots, optionsBySlot, limit) {
  const out = [];
  const walk = (i, acc) => {
    if (i === slots.length) { out.push(acc.slice()); return; }
    const opts = optionsBySlot[slots[i]];
    for (const o of opts) {
      if (o === null) { walk(i + 1, acc); continue; }
      if (acc.length >= limit) continue;
      acc.push(o);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function sweep(L) {
  rule('5. COMBINATION SWEEP — every legal build on every weapon');
  const rand = new L.Rand(SEED);
  let total = 0;
  let cappedCombos = 0;
  const cappedByStat = new Map();
  const violations = [];
  let orderChecks = 0;
  let orderFails = 0;

  console.log(`  ${pad('weapon', 16)}${padL('combos', 9)}${padL('capped', 9)}`
    + `${padL('ADS min', 9)}${padL('ADS max', 9)}${padL('rec min', 9)}${padL('hip min', 9)}`
    + `${padL('mag max', 9)}${padL('move max', 9)}`);

  for (const def of L.WEAPONS) {
    const slots = L.slotsFor(def);
    const optionsBySlot = {};
    for (const slot of slots) {
      optionsBySlot[slot] = [null, ...L.attachmentsFor(def.cls, slot)
        .filter((a) => !a.baseline && L.mountable(def, a))
        .map((a) => a.id)];
    }
    const list = combos(slots, optionsBySlot, L.LIMITS.attachmentsPerWeapon);
    const base = L.resolveWeapon(def.id, []);
    const extremes = {
      adsMin: Infinity, adsMax: -Infinity, recMin: Infinity,
      hipMin: Infinity, magMax: -Infinity, moveMax: -Infinity,
    };

    for (const ids of list) {
      const eff = L.resolveWeapon(def.id, ids);
      total++;
      if (eff.warnings.length) violations.push(`${def.id} [${ids.join(',')}] warnings: ${eff.warnings.join('; ')}`);
      if (eff.capped.length) {
        cappedCombos++;
        for (const s of eff.capped) cappedByStat.set(s, (cappedByStat.get(s) ?? 0) + 1);
      }
      for (const [key, [lo, hi]] of Object.entries(SANE_ABS)) {
        if (absent(base, key)) continue;
        const v = eff[key];
        if (!(v >= lo && v <= hi)) {
          violations.push(`${def.id} [${ids.join(',')}] ${key}=${f(v, 4)} outside [${lo}, ${hi}]`);
        }
      }
      for (const [key, [lo, hi]] of Object.entries(SANE_REL)) {
        const b = base[key];
        const v = eff[key];
        if (!(b > 0)) continue;
        const r = v / b;
        if (!(r >= lo - 1e-9 && r <= hi + 1e-9)) {
          violations.push(`${def.id} [${ids.join(',')}] ${key} ratio ${f(r, 3)} outside [${lo}, ${hi}]`);
        }
      }
      extremes.adsMin = Math.min(extremes.adsMin, eff.adsTime);
      extremes.adsMax = Math.max(extremes.adsMax, eff.adsTime);
      extremes.recMin = Math.min(extremes.recMin, eff.recoilVerticalScale);
      extremes.hipMin = Math.min(extremes.hipMin, eff.hipSpreadDeg);
      extremes.magMax = Math.max(extremes.magMax, eff.magSize);
      extremes.moveMax = Math.max(extremes.moveMax, eff.moveScale);

      // Order independence, sampled — resolving a shuffle must be identical.
      if (ids.length > 1 && rand.next() < 0.04) {
        const shuffled = rand.shuffle(ids.slice());
        const a = JSON.stringify(eff);
        const b = JSON.stringify(L.resolveWeapon(def.id, shuffled));
        orderChecks++;
        if (a !== b) { orderFails++; violations.push(`${def.id} order-dependent: ${ids} vs ${shuffled}`); }
      }
    }

    console.log(`  ${pad(def.id, 16)}${padL(list.length, 9)}${padL('', 9)}`
      + `${padL(f(extremes.adsMin, 3), 9)}${padL(f(extremes.adsMax, 3), 9)}`
      + `${padL(f(extremes.recMin, 3), 9)}${padL(f(extremes.hipMin, 2), 9)}`
      + `${padL(extremes.magMax, 9)}${padL(f(extremes.moveMax, 3), 9)}`);
  }

  console.log(`\n  swept ${total} legal combinations`);
  console.log(`  combinations that hit a clamp: ${cappedCombos} (${((cappedCombos / total) * 100).toFixed(1)}%)`);
  const byStat = [...cappedByStat.entries()].sort((a, b) => b[1] - a[1]);
  if (byStat.length) {
    console.log(`  clamps by stat: ${byStat.map(([s, n]) => `${s}×${n}`).join(', ')}`);
  }
  console.log(`  order-independence samples: ${orderChecks}, mismatches: ${orderFails}`);

  check('no combination leaves the sane bounds', violations.length === 0,
    `${violations.length} violations, first: ${violations[0] ?? ''}`);
  check('resolution is order-independent', orderFails === 0, `${orderFails} of ${orderChecks}`);
  check('the clamp table is a safety net, not the balance',
    cappedCombos / total < 0.15, `${((cappedCombos / total) * 100).toFixed(1)}% of combos clamped`);
  // A weapon with nothing fitted must never touch a rail. If it does, a rule in
  // data/balance.ts collides with a catalogue base and the safety net is
  // silently rewriting the designer's numbers on every single build.
  const stockClamps = L.WEAPONS
    .map((d) => [d.id, L.resolveWeapon(d.id, []).capped])
    .filter(([, c]) => c.length);
  check('a stock weapon never hits a rail', stockClamps.length === 0,
    stockClamps.map(([id, c]) => `${id}: ${c.join('/')}`).join(', '));
  if (violations.length) for (const v of violations.slice(0, 12)) console.log(`    ! ${v}`);
  return total;
}

/* ------------------------------------------------------- 6. dominance ---- */

function dominance(L) {
  rule('6. DOMINANCE AUDIT — is any attachment strictly better than another?');
  const bySlot = new Map();
  for (const a of L.ATTACHMENT_TABLE) {
    if (a.baseline) continue;
    if (!bySlot.has(a.slot)) bySlot.set(a.slot, []);
    bySlot.get(a.slot).push(a);
  }
  const benefit = (entry) => {
    const map = new Map();
    for (const m of entry.mods) {
      if (m.mode !== 'mul') continue;
      const better = L.STAT_RULES[m.stat].better;
      const dev = better === 'higher' ? m.value - 1 : 1 - m.value;
      map.set(m.stat, (map.get(m.stat) ?? 0) + dev);
    }
    return map;
  };
  let dominated = 0;
  for (const [slot, list] of bySlot) {
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue;
        const ba = benefit(a);
        const bb = benefit(b);
        const stats = new Set([...ba.keys(), ...bb.keys()]);
        let strictly = false;
        let ok = true;
        for (const s of stats) {
          const va = ba.get(s) ?? 0;
          const vb = bb.get(s) ?? 0;
          if (va < vb - 1e-9) { ok = false; break; }
          if (va > vb + 1e-9) strictly = true;
        }
        const flagsA = new Set(a.flags ?? []);
        const flagsB = new Set(b.flags ?? []);
        const bHasUnique = [...flagsB].some((flag) => !flagsA.has(flag) && (L.FLAG_SIDE[flag] ?? 'pro') === 'pro');
        if (ok && strictly && !bHasUnique && a.minRank <= b.minRank) {
          dominated++;
          warn(`${b.id} is dominated by ${a.id} (same ${slot} slot, rank ${a.minRank} ≤ ${b.minRank})`);
        }
      }
    }
  }
  console.log(`  strictly dominated attachments: ${dominated}`);
  check('no attachment is a strict downgrade of a cheaper one', dominated === 0,
    `${dominated} dominated`);
}

/* -------------------------------------------------- 7. the trust boundary */

function trustBoundary(L) {
  rule('7. TRUST BOUNDARY — hostile loadouts');
  const legal = L.defaultLoadout();
  const ctxNoUnlocks = { enforceUnlocks: false };
  const ctxRank1 = { unlocks: { rank: 1 } };

  const cases = [
    ['a legal default class is accepted', legal, ctxNoUnlocks, []],
    ['null payload', null, ctxNoUnlocks, ['malformed']],
    ['a string payload', 'give me the good gun', ctxNoUnlocks, ['malformed']],
    ['an array payload', [1, 2, 3], ctxNoUnlocks, ['malformed']],
    ['unknown weapon id', { ...legal, primary: { weaponId: 'ar_railgun', attachments: [] } }, ctxNoUnlocks, ['unknown_weapon']],
    ['prototype pollution as a weapon id', { ...legal, primary: { weaponId: '__proto__', attachments: [] } }, ctxNoUnlocks, ['unknown_weapon']],
    ['a primary in the secondary slot without Overkill',
      { ...legal, secondary: { weaponId: 'lmg_vulcan', attachments: [] } }, ctxNoUnlocks, ['slot_mismatch']],
    ['seven attachments on one gun', {
      ...legal,
      primary: {
        weaponId: 'ar_vkr7',
        attachments: ['optic_acog', 'muzzle_comp', 'barrel_long', 'under_grip', 'mag_extended', 'stock_heavy', 'laser_visible'],
      },
    }, ctxNoUnlocks, ['attachment_limit']],
    ['two optics', { ...legal, primary: { weaponId: 'ar_vkr7', attachments: ['optic_acog', 'optic_holo'] } },
      ctxNoUnlocks, ['attachment_slot_conflict']],
    ['the same attachment twice', { ...legal, primary: { weaponId: 'ar_vkr7', attachments: ['optic_acog', 'optic_acog'] } },
      ctxNoUnlocks, ['attachment_duplicate']],
    ['a sniper scope on an SMG', { ...legal, primary: { weaponId: 'smg_hornet', attachments: ['optic_sniper'] } },
      ctxNoUnlocks, ['attachment_incompatible']],
    ['a row-2 perk in row 1', { ...legal, perks: ['perk_ghost', '', ''] }, ctxNoUnlocks, ['perk_row']],
    ['two perks from the same exclusivity group',
      { ...legal, perks: ['perk_double_time', '', 'perk_lightweight'] }, ctxNoUnlocks, ['perk_conflict']],
    ['two reload perks across rows',
      { ...legal, perks: ['', 'perk_sleight', 'perk_fasthands'] }, ctxNoUnlocks, ['perk_conflict']],
    ['unknown lethal', { ...legal, lethal: 'eq_tacticalnuke' }, ctxNoUnlocks, ['equipment_unknown']],
    ['a tactical id in the lethal slot', { ...legal, lethal: 'eq_flash' }, ctxNoUnlocks, ['equipment_unknown']],
    ['unknown field upgrade', { ...legal, fieldUpgrade: 'fu_godmode' }, ctxNoUnlocks, ['field_upgrade_unknown']],
    ['four killstreaks', { ...legal, killstreaks: ['uav', 'counteruav', 'carepackage', 'airstrike'] },
      ctxNoUnlocks, ['killstreak_limit']],
    ['duplicate killstreaks', { ...legal, killstreaks: ['uav', 'uav'] }, ctxNoUnlocks, ['killstreak_duplicate']],
    ['NaN where a weapon id belongs', { ...legal, primary: { weaponId: NaN, attachments: [] } }, ctxNoUnlocks, ['unknown_weapon']],
    ['attachments as an object', { ...legal, primary: { weaponId: 'ar_vkr7', attachments: { 0: 'optic_acog' } } },
      ctxNoUnlocks, ['malformed']],
    ['rank-1 player asking for rank-32 content',
      { ...legal, primary: { weaponId: 'ar_vkr7', attachments: ['stock_none'] } }, ctxRank1, ['locked']],
    ['rank-1 player asking for a rank-20 weapon',
      { ...legal, primary: { weaponId: 'sr_longbow', attachments: [] } }, ctxRank1, ['locked']],
    ['markup in the class name', { ...legal, name: '<script>alert(1)</script>' }, ctxNoUnlocks, []],
  ];

  for (const [label, payload, ctx, expected] of cases) {
    const res = L.validateLoadout(payload, ctx);
    const codes = res.errors.map((e) => e.code);
    const wanted = expected.length === 0 ? codes.length === 0 : expected.every((c) => codes.includes(c));
    check(`reject: ${label}`, wanted,
      `expected [${expected.join(', ')}], got [${[...new Set(codes)].join(', ')}]`);
    // Whatever happened, the returned loadout must itself be legal.
    const recheck = L.validateLoadout(res.loadout, ctx);
    check(`repair of "${label}" is itself legal`, recheck.ok,
      recheck.errors.map((e) => `${e.code}@${e.path}`).join(', '));
  }

  // Overkill genuinely changes what is legal.
  const overkill = {
    ...legal,
    perks: ['perk_overkill', '', ''],
    secondary: { weaponId: 'smg_hornet', attachments: [] },
  };
  const okRes = L.validateLoadout(overkill, ctxNoUnlocks);
  check('Overkill permits a primary in the secondary slot', okRes.ok,
    okRes.errors.map((e) => `${e.code}@${e.path}`).join(', '));

  // Name sanitising really strips markup.
  const named = L.validateLoadout({ ...legal, name: '<b>PWN</b>&' }, ctxNoUnlocks);
  check('class names are stripped of markup', !/[<>&]/.test(named.loadout.name), named.loadout.name);
  const longName = L.validateLoadout({ ...legal, name: 'x'.repeat(500) }, ctxNoUnlocks);
  check('class names are length-capped', longName.loadout.name.length <= L.LIMITS.nameMaxLength,
    `${longName.loadout.name.length} chars`);

  console.log(`  ${cases.length} hostile payloads exercised, every one produced a runnable loadout`);
}

/* -------------------------------------------------------- 8. the authority */

async function authority(L) {
  rule('8. AUTHORITY — request, grant, respawn');
  const service = new L.LoadoutService({ contextFor: () => ({ unlocks: { rank: 55 } }) });
  const book = new L.LoadoutBook({ storage: new L.MemoryStorage(), context: { unlocks: { rank: 55 } } });

  const grant = await service.request(7, book.current());
  check('the first request is granted', grant.accepted, grant.errors.map((e) => e.code).join(','));
  check('a granted class installs immediately before the first spawn',
    service.activeFor(7) !== null);

  const spawn = service.notifySpawn(7);
  check('spawn returns resolved weapons',
    spawn.primary.weaponId === book.current().primary.weaponId
    && spawn.primary.adsTime > 0);
  console.log(`  player 7 spawns with ${spawn.primary.weaponName} `
    + `(ADS ${f(spawn.primary.adsTime, 3)}s, mag ${spawn.primary.magSize}, `
    + `${spawn.primary.attachments.length} attachments), ${spawn.lethal.name} / ${spawn.tactical.name}, `
    + `field upgrade ${spawn.fieldUpgrade.name}`);

  // Change class mid-life: must queue, not swap the gun in your hands.
  const second = book.at(1) ?? book.current();
  const grant2 = await service.request(7, second);
  check('a mid-life class change is granted', grant2.accepted);
  check('a mid-life class change does NOT swap the live weapon',
    service.activeFor(7).primary.weaponId === spawn.primary.weaponId,
    `live weapon became ${service.activeFor(7).primary.weaponId}`);
  check('the change is queued', service.hasPending(7));
  const respawn = service.notifySpawn(7);
  check('the queued class applies on respawn', respawn.primary.weaponId === second.primary.weaponId,
    `${respawn.primary.weaponId} != ${second.primary.weaponId}`);

  // A hostile client cannot install anything the host did not approve.
  const cheat = {
    version: 1, id: 'cheat', name: 'CHEAT',
    primary: { weaponId: 'sr_longbow', attachments: ['stock_none', 'laser_visible', 'mag_drum', 'optic_sniper', 'barrel_short', 'muzzle_comp'] },
    secondary: { weaponId: 'lmg_vulcan', attachments: [] },
    lethal: 'eq_nuke', tactical: 'eq_flash',
    perks: ['perk_lightweight', 'perk_sleight', 'perk_fasthands'],
    fieldUpgrade: 'fu_invisible', killstreaks: ['sentry', 'sentry', 'sentry', 'airstrike'],
  };
  const cheatGrant = service.grant(9, cheat, { unlocks: { rank: 3 } });
  check('a cheating client is refused', !cheatGrant.accepted);
  check('...but still gets a runnable class', L.validateLoadout(cheatGrant.loadout, { unlocks: { rank: 3 } }).ok);
  const active = service.notifySpawn(9);
  check('...whose attachments are within the limit',
    active.primary.attachments.length <= L.LIMITS.attachmentsPerWeapon);
  check('...and contain nothing above their rank',
    active.primary.attachments.every((id) => L.attachmentEntry(id).minRank <= 3),
    active.primary.attachments.join(','));
  console.log(`  cheating client (rank 3) asked for ${cheat.primary.attachments.length} attachments `
    + `on a rank-20 sniper; host granted ${active.primary.weaponId} with `
    + `[${active.primary.attachments.join(', ') || 'none'}] and ${cheatGrant.errors.length} errors`);

  // Hardline actually reaches the killstreak costs.
  const hardline = L.validateLoadout({ ...L.defaultLoadout(), perks: ['', 'perk_hardline', ''] }, { enforceUnlocks: false });
  const withHardline = L.activate(3, hardline.loadout);
  const without = L.activate(3, L.defaultLoadout());
  check('Hardline lowers killstreak cost by one',
    withHardline.killstreaks[0].cost === without.killstreaks[0].cost - 1,
    `${withHardline.killstreaks[0].cost} vs ${without.killstreaks[0].cost}`);

  // Equipment with no projectile yet still resolves to something throwable.
  const semtex = L.validateLoadout({ ...L.defaultLoadout(), lethal: 'eq_semtex' }, { enforceUnlocks: false });
  const act = L.activate(4, semtex.loadout);
  check('unimplemented equipment falls back to a real grenade kind',
    ['frag', 'flash', 'smoke'].includes(act.lethalGrenade), act.lethalGrenade);

  service.dispose();
}

/* ------------------------------------------------------------- 9. the book */

function bookTests(L) {
  rule('9. SAVED CLASSES');
  const storage = new L.MemoryStorage();
  const ctx = { unlocks: { rank: 55 } };
  const book = new L.LoadoutBook({ storage, context: ctx });
  check('presets load', book.count === L.PRESET_CLASSES.length, `${book.count}`);

  let changes = 0;
  book.onChange(() => { changes++; });

  const res = book.setAttachment(0, 'primary', 'optic', 'optic_acog');
  check('fitting an optic swaps the one already there', res.ok
    && book.at(0).primary.attachments.filter((id) => L.attachmentEntry(id).slot === 'optic').length === 1,
    book.at(0).primary.attachments.join(','));

  const before = book.at(0).primary.attachments.length;
  book.setWeapon(0, 'primary', 'pi_sidewinder');
  check('swapping a weapon drops attachments it cannot mount',
    book.at(0).primary.attachments.every((id) => L.mountable(L.weaponDef('pi_sidewinder'), L.attachmentEntry(id))),
    book.at(0).primary.attachments.join(','));
  console.log(`  weapon swap kept ${book.at(0).primary.attachments.length} of ${before} attachments`);

  const conflict = book.setPerk(0, 3, 'perk_lightweight');
  book.setPerk(0, 1, 'perk_double_time');
  const clash = book.setPerk(0, 3, 'perk_lightweight');
  check('the book refuses a conflicting perk', !clash.ok || book.at(0).perks[2] !== 'perk_lightweight',
    book.at(0).perks.join(','));

  // Limit and persistence.
  let created = 0;
  while (book.create() >= 0) created++;
  check('the saved-class limit holds', book.count === L.LIMITS.savedClasses, `${book.count}`);
  book.save();
  const reloaded = new L.LoadoutBook({ storage, context: ctx });
  check('a saved book reloads', reloaded.load() && reloaded.count === book.count,
    `${reloaded.count} vs ${book.count}`);
  check('reloaded classes are identical',
    L.serialiseLoadout(reloaded.at(0)) === L.serialiseLoadout(book.at(0)));

  // A corrupt store must not throw.
  storage.setItem('blackout.loadouts.v1', '{"classes":[{"primary":42}],"selected":"x"}');
  const corrupt = new L.LoadoutBook({ storage, context: ctx });
  const loadedCorrupt = corrupt.load();
  check('a corrupt store yields legal classes, never a throw',
    corrupt.count > 0 && L.validateLoadout(corrupt.at(0), ctx).ok, `loaded=${loadedCorrupt}`);
  console.log(`  ${changes} change events emitted, ${created} classes created before the limit`);

  // Rank changes re-validate in place.
  const lowRank = new L.LoadoutBook({ storage: new L.MemoryStorage(), context: { unlocks: { rank: 1 } } });
  const illegal = lowRank.list().some((l) =>
    l.primary.attachments.some((id) => L.attachmentEntry(id).minRank > 1));
  check('presets are repaired down to a rank-1 player', !illegal,
    lowRank.at(0).primary.attachments.join(','));
  console.log(`  rank-1 RIFLEMAN: ${lowRank.at(0).primary.weaponId} `
    + `[${lowRank.at(0).primary.attachments.join(', ') || 'none'}] perks [${lowRank.at(0).perks.filter(Boolean).join(', ') || 'none'}]`);
}

/* ----------------------------------------------------------- 10. UI bars */

function bars(L) {
  rule('10. STAT BARS (what the create-a-class screen draws)');
  console.log(`  ${pad('weapon', 16)}${pad('build', 18)}`
    + ['damage', 'accuracy', 'range', 'fireRate', 'mobility', 'control'].map((h) => padL(h, 10)).join(''));
  for (const [weaponId, label, attachments] of BUILDS) {
    const b = L.statBars(L.resolveWeapon(weaponId, attachments));
    const vals = ['damage', 'accuracy', 'range', 'fireRate', 'mobility', 'control'].map((k) => padL(f(b[k], 2), 10));
    console.log(`  ${pad(weaponId, 16)}${pad(label, 18)}${vals.join('')}`);
    for (const k of Object.keys(b)) {
      check(`bar ${k} is normalised for ${weaponId}/${label}`, b[k] >= 0 && b[k] <= 1, `${k}=${b[k]}`);
    }
  }
}

/* -------------------------------------------------- 11. weapons-module bridge */

function bridge(L) {
  rule('11. WEAPONS-MODULE BRIDGE');
  const eff = L.resolveWeapon('ar_vkr7', ['optic_holo', 'muzzle_comp', 'mag_extended', 'stock_light']);
  const rs = L.toResolvedStats(eff);
  const keys = ['adsTime', 'sprintOut', 'drawTime', 'recoilScale', 'recoilHorizontalScale',
    'hipSpreadScale', 'adsSpreadScale', 'bloomScale', 'moveScale', 'adsMoveScale', 'magSize',
    'reloadScale', 'muzzleVelocity', 'penetration', 'rangeScale', 'suppressed', 'magnification', 'laser'];
  const missing = keys.filter((k) => rs[k] === undefined);
  check('toResolvedStats fills every field WeaponSystem reads', missing.length === 0, missing.join(','));
  const finite = keys.filter((k) => typeof rs[k] === 'number' && !Number.isFinite(rs[k]));
  check('every bridged number is finite', finite.length === 0, finite.join(','));
  check('the mesh list only contains parts the weapon module knows',
    eff.meshAttachments.every((id) => L.__weaponAttachmentIds.includes(id)),
    eff.meshAttachments.join(','));
  console.log(`  ResolvedStats: ${keys.map((k) => `${k}=${typeof rs[k] === 'number' ? f(rs[k], 3) : rs[k]}`).join(' ')}`);
  console.log(`  mesh parts passed through to the model builder: [${eff.meshAttachments.join(', ')}]`);
}

/* ------------------------------------------------------------ 12. tuning */

/* ------------------------------------------- 12. reloads, rails, rounding */

/**
 * Three things that were silently wrong and are easy to break again:
 *   - shell-by-shell weapons ignoring every reload modifier in the game,
 *   - reload scales producing durations nobody would sit through,
 *   - integer rounding being reported as the safety net engaging.
 */
function reloadsAndRounding(L) {
  rule('12. RELOADS, RAILS AND ROUNDING');

  const shotgun = L.resolveWeapon('sg_breaker', []);
  check('the shotgun is recognised as a shell-by-shell reloader',
    shotgun.shellReload === true && shotgun.reloadTactical === 0 && shotgun.reloadPerShell > 0,
    `shellReload=${shotgun.shellReload} tactical=${shotgun.reloadTactical} perShell=${shotgun.reloadPerShell}`);

  const fast = L.resolveWeapon('sg_breaker', [], { perks: ['perk_sleight'] });
  const gain = 1 - fast.reloadPerShell / shotgun.reloadPerShell;
  check('reload modifiers actually reach a shell reloader', gain > 0.15,
    `per-shell ${f(shotgun.reloadPerShell)}s → ${f(fast.reloadPerShell)}s (${(gain * 100).toFixed(1)}%)`);
  console.log(`  sg_breaker per-shell ${f(shotgun.reloadPerShell)}s → ${f(fast.reloadPerShell)}s with Sleight of Hand`
    + ` (scale ${f(fast.reloadScale)})`);

  const slow = L.resolveWeapon('lmg_vulcan', ['mag_drum']);
  check('reload duration is railed in seconds, not just in multiples',
    slow.reloadTactical <= L.RELOAD_RAILS.tactical.max + 1e-9,
    `${f(slow.reloadTactical)}s > ${L.RELOAD_RAILS.tactical.max}s`);
  check('hitting the reload rail is reported', slow.capped.includes('reloadTime'),
    slow.capped.join(', '));
  console.log(`  lmg_vulcan + drum reload ${f(slow.reloadTactical)}s`
    + ` (railed at ${L.RELOAD_RAILS.tactical.max}s), empty ${f(slow.reloadEmpty)}s`);

  // 5-round bolt gun × 1.5 = 7.5 rounds. Rounding to 8 is arithmetic, not a cap.
  const bolt = L.resolveWeapon('sr_longbow', ['mag_extended']);
  check('magazine rounding produces a whole number', Number.isInteger(bolt.magSize), String(bolt.magSize));
  check('rounding an integer stat is not reported as a clamp', !bolt.capped.includes('magSize'),
    `capped: ${bolt.capped.join(', ')}`);
  console.log(`  sr_longbow mag 5 → ${bolt.magSize} (×1.5 = 7.5, rounded)`
    + ` — capped: [${bolt.capped.join(', ') || 'none'}]`);

  // A genuine rail hit must still be reported.
  const railed = L.resolveWeapon('sr_longbow', [], {
    extra: [{ id: 'test_absurd_mag', mods: [{ stat: 'magSize', mode: 'mul', value: 40 }] }],
  });
  check('a genuine magazine rail hit is still reported', railed.capped.includes('magSize'),
    `magSize=${railed.magSize} capped=${railed.capped.join(', ')}`);
  console.log(`  sr_longbow with a ×40 magazine lands at ${railed.magSize}`
    + ` (rail ${f(L.railsFor('magSize', 5).hi, 0)}) and reports the cap`);
}

function tuning(L) {
  rule('13. LIVE TUNING');
  const before = L.resolveWeapon('ar_vkr7', ['muzzle_comp']).recoilVerticalScale;
  const notes = L.applyTuningPatch({
    attachments: { muzzle_comp: { recoilVertical: 0.5 } },
    stats: { recoilVertical: { minMul: 0.2 } },
    perks: { perk_sleight: { reloadTime: 0.5 } },
  });
  const after = L.resolveWeapon('ar_vkr7', ['muzzle_comp']).recoilVerticalScale;
  check('a tuning patch changes resolved numbers without a rebuild', after < before - 1e-6,
    `${before} → ${after}`);
  check('the patch reports what it changed', notes.length === 3, notes.join('; '));
  console.log(`  ${notes.join('\n  ')}`);
  // Put it back so nothing downstream sees the test values.
  L.applyTuningPatch({
    attachments: { muzzle_comp: { recoilVertical: 0.82 } },
    stats: { recoilVertical: { minMul: 0.45 } },
    perks: { perk_sleight: { reloadTime: 0.75 } },
  });
  check('tuning is reversible',
    Math.abs(L.resolveWeapon('ar_vkr7', ['muzzle_comp']).recoilVerticalScale - before) < 1e-9);
  const ignored = L.applyTuningPatch({ attachments: { not_a_real_id: { adsTime: 0.1 } }, stats: { nope: { minMul: 0 } } });
  check('a hostile tuning patch is ignored', ignored.length === 0, ignored.join('; '));
}

/* ------------------------------------------------------------------ main */

async function main() {
  const t0 = Date.now();
  const L = await loadModule();
  // Ids the weapon module actually has parts for — used by two checks.
  L.__weaponAttachmentIds = L.WEAPON_ATTACHMENTS.map((a) => a.id);

  console.log(`\nSESSION / LOADOUT — create-a-class verification (seed ${SEED})`);

  dataIntegrity(L);
  singleAttachmentTable(L, String(flag('weapon', 'ar_vkr7')));
  buildTable(L);
  diminishingReturns(L);
  const swept = sweep(L);
  dominance(L);
  trustBoundary(L);
  await authority(L);
  bookTests(L);
  bars(L);
  bridge(L);
  reloadsAndRounding(L);
  tuning(L);

  rule('RESULT');
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const fl of failures) console.log(`  FAIL  ${fl}`);
  const ms = Date.now() - t0;
  console.log(`\n  checks passed : ${passCount}`);
  console.log(`  checks failed : ${failures.length}`);
  console.log(`  warnings      : ${warnings.length}`);
  console.log(`  combinations  : ${swept}`);
  console.log(`  elapsed       : ${ms} ms`);
  console.log(`\n  ${failures.length === 0 ? 'PASS' : 'FAIL'}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.log('\n  FAIL (harness error)\n');
  process.exit(1);
});
