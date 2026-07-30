/**
 * The attachment table — data, not code.
 *
 * Every entry is a list of typed modifiers plus the rank it unlocks at, the
 * weapon classes it fits, and the id of the weapon-module part that represents
 * it on the mesh. There is no attachment-specific logic anywhere in the module:
 * adding one is adding an object to this file.
 *
 * ## The rule every entry obeys
 *
 * **Nothing is free.** Each non-baseline entry must have at least one modifier
 * that moves a stat the wrong way, or a `con` flag. `auditAttachments()` proves
 * it, and `tools/session-loadout.mjs` fails the build if it stops being true.
 *
 * A long barrel buys range and velocity with ADS speed, weight and sway. A
 * skeleton stock buys mobility with recoil. A drum magazine buys uptime with
 * everything. That tension is the entire design.
 *
 * ## Mesh coverage
 *
 * `mesh` names an `AttachmentDef` id in `src/weapons/Attachments.ts`. Barrels
 * carry `mesh: null` because the weapon mesh builder has no barrel part yet —
 * their numbers resolve, they simply do not change the silhouette. When the
 * weapons module grows a `barrel` slot and `AttachmentBuild.kind`, filling in
 * these four ids is the whole integration.
 */

import type { WeaponClass } from '../../../weapons/types';
import type { AttachmentEntry, LoadoutSlot, Modifier, StatKey } from '../types';
import type { TuningPatch } from './balance';

/* ------------------------------------------------------------- shorthands */

/** `m('adsTime', 1.08)` — a multiplicative modifier. */
function m(stat: StatKey, value: number): Modifier {
  return { stat, mode: 'mul', value };
}
/** A flat delta applied after scaling. */
function add(stat: StatKey, value: number): Modifier {
  return { stat, mode: 'add', value };
}
/** A "largest wins" modifier — optic magnification only. */
function max(stat: StatKey, value: number): Modifier {
  return { stat, mode: 'max', value };
}

const ALL: 'all' = 'all';
const LONG_GUNS: readonly WeaponClass[] = ['assault', 'smg', 'lmg', 'marksman', 'sniper', 'shotgun'];

/* ==================================================================== optics */

const OPTICS: AttachmentEntry[] = [
  {
    id: 'optic_irons', name: 'Iron Sights', slot: 'optic', classes: ALL, minRank: 0,
    baseline: true, mesh: 'optic_irons', mods: [], pros: ['Nothing to snag'], cons: [],
    description: 'Factory irons. The baseline every optic is measured against.',
  },
  {
    id: 'optic_reddot', name: 'RD-2 Reflex', slot: 'optic', classes: ALL, minRank: 3,
    mesh: 'optic_reddot',
    mods: [m('adsTime', 1.03), m('adsSpread', 0.92), max('magnification', 1)],
    pros: ['Clean sight picture'], cons: ['Marginally slower ADS'],
    description: 'Compact enclosed red dot. Fast, unobtrusive, no magnification.',
  },
  {
    id: 'optic_holo', name: 'HS-1 Holographic', slot: 'optic', classes: ALL, minRank: 12,
    mesh: 'optic_holo',
    mods: [m('adsTime', 1.05), m('adsSpread', 0.90), m('hipSpread', 0.97), max('magnification', 1)],
    pros: ['Widest window', 'Tightens hipfire'], cons: ['Slower ADS'],
    description: 'Wide-window holographic sight. Best peripheral view of any optic.',
  },
  {
    id: 'optic_acog', name: 'TA-4 Combat Scope', slot: 'optic', classes: ['assault', 'marksman', 'lmg', 'sniper'], minRank: 18,
    mesh: 'optic_acog',
    mods: [
      m('adsTime', 1.16), m('adsSpread', 0.72), m('falloffRange', 1.10),
      m('moveScale', 0.98), m('sway', 1.12), m('flinch', 1.05), max('magnification', 4),
    ],
    pros: ['4× magnification', 'Extends effective range'],
    cons: ['Much slower ADS', 'More sway', 'Heavier'],
    description: '4× prism scope with an illuminated chevron. Trades handling for reach.',
  },
  {
    id: 'optic_sniper', name: 'LR-9 Variable Scope', slot: 'optic', classes: ['sniper', 'marksman'], minRank: 22,
    mesh: 'optic_sniper',
    mods: [
      m('adsTime', 1.30), m('adsSpread', 0.50), m('falloffRange', 1.20),
      m('moveScale', 0.96), m('sway', 1.28), m('flinch', 1.10), max('magnification', 9),
    ],
    pros: ['9× magnification', 'Best static accuracy'],
    cons: ['Glacial ADS', 'Heavy sway', 'Punishing flinch'],
    description: '9× variable scope. Enormous reach, glacial target acquisition.',
  },
];

/* ============================================================ muzzle devices */

const MUZZLES: AttachmentEntry[] = [
  {
    id: 'muzzle_none', name: 'No Muzzle Device', slot: 'muzzle', classes: ALL, minRank: 0,
    baseline: true, mesh: null, mods: [], pros: [], cons: [],
    description: 'Bare crown.',
  },
  {
    id: 'muzzle_suppressor', name: 'Suppressor', slot: 'muzzle', classes: ALL, minRank: 8,
    mesh: 'muzzle_suppressor',
    flags: ['suppressed', 'noFlash'],
    mods: [
      m('muzzleVelocity', 0.92), m('adsTime', 1.08), m('recoilVertical', 0.94),
      m('falloffRange', 0.90), m('sprintOut', 1.06),
    ],
    pros: ['Off the minimap', 'No muzzle flash', 'Slightly softer recoil'],
    cons: ['Loses range', 'Loses velocity', 'Slower ADS and sprint-out'],
    description: 'Removes the flash and keeps you off the minimap. Costs velocity and reach.',
  },
  {
    id: 'muzzle_comp', name: 'Compensator', slot: 'muzzle', classes: ALL, minRank: 26,
    mesh: 'muzzle_comp',
    flags: ['loud'],
    mods: [m('recoilVertical', 0.82), m('recoilHorizontal', 1.06), m('adsTime', 1.02)],
    pros: ['Kills muzzle climb'],
    cons: ['More horizontal wander', 'Very visible flash'],
    description: 'Ports gas upward. Flattens the climb, throws a wide flash.',
  },
  {
    id: 'muzzle_brake', name: 'Muzzle Brake', slot: 'muzzle', classes: ['sniper', 'marksman', 'lmg', 'shotgun'], minRank: 20,
    mesh: 'muzzle_brake',
    flags: ['loud'],
    mods: [m('recoilVertical', 0.74), m('recoilHorizontal', 0.86), m('adsTime', 1.06), m('moveScale', 0.99)],
    pros: ['Best raw recoil control'],
    cons: ['Slower ADS', 'Deafening', 'Adds weight'],
    description: 'Redirects gas sideways. Tames heavy calibres at the cost of noise.',
  },
  {
    id: 'muzzle_flash', name: 'Flash Hider', slot: 'muzzle', classes: ALL, minRank: 5,
    mesh: 'muzzle_flash',
    flags: ['noFlash'],
    mods: [m('recoilVertical', 0.96), m('sprintOut', 1.02)],
    pros: ['Hides your position when firing'],
    cons: ['Slightly slower sprint-out'],
    description: 'Breaks up the flash signature without the weight of a can.',
  },
];

/* =================================================================== barrels */

const BARRELS: AttachmentEntry[] = [
  {
    id: 'barrel_stock', name: 'Standard Barrel', slot: 'barrel', classes: ALL, minRank: 0,
    baseline: true, mesh: null, mods: [], pros: [], cons: [],
    description: 'The barrel the weapon shipped with.',
  },
  {
    id: 'barrel_long', name: 'Extended Barrel', slot: 'barrel', classes: LONG_GUNS, minRank: 16,
    mesh: null,
    mods: [
      m('falloffRange', 1.18), m('muzzleVelocity', 1.12), m('penetration', 1.08),
      m('adsTime', 1.10), m('moveScale', 0.97), m('sway', 1.15), m('sprintOut', 1.05),
    ],
    pros: ['Big range gain', 'Faster bullets', 'Better wall pierce'],
    cons: ['Slower ADS', 'Slower movement', 'More sway'],
    description: 'A longer tube buys reach and velocity. You feel every centimetre of it.',
  },
  {
    id: 'barrel_short', name: 'Short Barrel', slot: 'barrel', classes: LONG_GUNS, minRank: 11,
    mesh: null,
    mods: [
      m('adsTime', 0.90), m('moveScale', 1.03), m('sprintOut', 0.92), m('hipSpread', 0.95),
      m('falloffRange', 0.86), m('muzzleVelocity', 0.93), m('recoilVertical', 1.08),
    ],
    pros: ['Fastest handling barrel', 'Tighter hipfire'],
    cons: ['Range falls off early', 'Slower bullets', 'More climb'],
    description: 'Chopped and crowned. Everything close-range gets better, everything past 25 m gets worse.',
  },
  {
    id: 'barrel_heavy', name: 'Heavy Barrel', slot: 'barrel', classes: LONG_GUNS, minRank: 30,
    mesh: null,
    mods: [
      m('recoilVertical', 0.88), m('recoilHorizontal', 0.90), m('sway', 0.88), m('adsSpread', 0.92),
      m('adsTime', 1.09), m('moveScale', 0.96), m('sprintOut', 1.06),
    ],
    pros: ['Steady in the shoulder', 'Tighter aimed cone'],
    cons: ['Heavy', 'Slower ADS and sprint-out'],
    description: 'Thick profile that soaks up harmonics. Rock steady, and you carry the weight.',
  },
  {
    id: 'barrel_ported', name: 'Ported Barrel', slot: 'barrel', classes: ['assault', 'smg', 'lmg'], minRank: 36,
    mesh: null,
    flags: ['loud'],
    mods: [
      m('recoilVertical', 0.86), m('bloomPerShot', 0.88),
      m('muzzleVelocity', 0.95), m('falloffRange', 0.94), m('adsTime', 1.03),
    ],
    pros: ['Flattens sustained fire', 'Less bloom'],
    cons: ['Bleeds velocity and range', 'Loud'],
    description: 'Gas ports cut into the top of the barrel. Sprays flatten out; the round pays for it.',
  },
];

/* =============================================================== underbarrel */

const UNDERBARREL: AttachmentEntry[] = [
  {
    id: 'under_none', name: 'No Underbarrel', slot: 'underbarrel', classes: ALL, minRank: 0,
    baseline: true, mesh: null, mods: [], pros: [], cons: [],
    description: 'Bare handguard.',
  },
  {
    id: 'under_grip', name: 'Vertical Grip', slot: 'underbarrel', classes: ALL, minRank: 6,
    mesh: 'under_grip',
    mods: [m('recoilVertical', 0.86), m('adsTime', 1.04), m('hipSpread', 1.02)],
    pros: ['Straightforward vertical control'],
    cons: ['Slower ADS', 'Slightly wider hipfire'],
    description: 'Straight foregrip. Vertical recoil control, slightly slower into the shoulder.',
  },
  {
    id: 'under_angled', name: 'Angled Grip', slot: 'underbarrel', classes: ALL, minRank: 14,
    mesh: 'under_angled',
    mods: [m('recoilHorizontal', 0.80), m('adsTime', 0.95), m('sprintOut', 0.94), m('recoilVertical', 1.05)],
    pros: ['Faster into the shoulder', 'Kills horizontal wander'],
    cons: ['Slightly more climb'],
    description: 'Canted grip. Speed and lateral control, at the price of vertical.',
  },
  {
    id: 'under_bipod', name: 'Folding Bipod', slot: 'underbarrel', classes: ['lmg', 'sniper', 'marksman'], minRank: 24,
    mesh: 'under_bipod',
    flags: ['bipod'],
    mods: [m('recoilVertical', 0.90), m('recoilHorizontal', 0.92), m('moveScale', 0.97), m('adsTime', 1.05)],
    pros: ['Huge stability when deployed'],
    cons: ['Dead weight when moving'],
    description: 'Deployable legs. Enormous stability when static, dead weight when not.',
  },
];

/* ==================================================================== lasers */

const LASERS: AttachmentEntry[] = [
  {
    id: 'laser_none', name: 'No Laser', slot: 'laser', classes: ALL, minRank: 0,
    baseline: true, mesh: null, mods: [], pros: [], cons: [],
    description: 'Nothing on the side rail.',
  },
  {
    id: 'laser_visible', name: 'Tactical Laser', slot: 'laser', classes: ALL, minRank: 34,
    mesh: 'laser_visible',
    flags: ['laser', 'laserVisible'],
    mods: [m('hipSpread', 0.62), m('sprintOut', 0.90), m('bloomPerShot', 0.94)],
    pros: ['Transforms hipfire', 'Faster sprint-out'],
    cons: ['The beam shows enemies exactly where you are'],
    description: 'Tightens hip fire dramatically. The beam gives your position away.',
  },
];

/* ================================================================ magazines */

const MAGAZINES: AttachmentEntry[] = [
  {
    id: 'mag_standard', name: 'Standard Mag', slot: 'magazine', classes: ALL, minRank: 0,
    baseline: true, mesh: null, mods: [], pros: [], cons: [],
    description: 'Issue magazine.',
  },
  {
    id: 'mag_extended', name: 'Extended Mag', slot: 'magazine', classes: ALL, minRank: 15,
    mesh: 'mag_extended',
    mods: [m('magSize', 1.5), m('reloadTime', 1.12), m('adsTime', 1.02), m('moveScale', 0.99)],
    pros: ['+50% capacity'],
    cons: ['Slower reload', 'Slightly slower handling'],
    description: 'Fifty percent more rounds, and you feel the weight on every reload.',
  },
  {
    id: 'mag_quick', name: 'Quickdraw Mag', slot: 'magazine', classes: ALL, minRank: 9,
    mesh: 'mag_quick',
    mods: [m('reloadTime', 0.78), m('drawTime', 0.94), m('magSize', 0.90)],
    pros: ['Far faster reloads', 'Faster draw'],
    cons: ['Holds fewer rounds'],
    description: 'Tapered well and a grip tab. You get the gun back much faster with a little less in it.',
  },
  {
    id: 'mag_drum', name: 'Drum Mag', slot: 'magazine', classes: ['assault', 'smg', 'lmg'], minRank: 28,
    mesh: 'mag_drum',
    mods: [m('magSize', 2.0), m('reloadTime', 1.45), m('moveScale', 0.94), m('adsTime', 1.10), m('sway', 1.20)],
    pros: ['Double capacity', 'Never stop firing'],
    cons: ['Ruins mobility', 'Very slow reload', 'Swings badly'],
    description: 'Doubles capacity. Ruins mobility and reload speed.',
  },
  {
    id: 'mag_ap', name: 'AP Rounds', slot: 'magazine', classes: ALL, minRank: 40,
    mesh: null,
    mods: [m('penetration', 1.45), m('muzzleVelocity', 1.06), m('damage', 0.96), m('falloffRange', 0.95)],
    pros: ['Shoots through cover', 'Faster bullets'],
    cons: ['Slightly less damage on flesh', 'Marginally shorter range'],
    description: 'Hardened core. Defeats walls that stop everything else, at a small cost on soft targets.',
  },
];

/* =================================================================== stocks */

const STOCKS: AttachmentEntry[] = [
  {
    id: 'stock_standard', name: 'Standard Stock', slot: 'stock', classes: ALL, minRank: 0,
    baseline: true, mesh: null, mods: [], pros: [], cons: [],
    description: 'Issue stock.',
  },
  {
    id: 'stock_light', name: 'Skeleton Stock', slot: 'stock', classes: ALL, minRank: 7,
    mesh: 'stock_light',
    mods: [
      m('adsTime', 0.88), m('sprintOut', 0.86), m('moveScale', 1.04),
      m('recoilVertical', 1.14), m('sway', 1.10),
    ],
    pros: ['Faster everything'],
    cons: ['Noticeably more climb', 'More sway'],
    description: 'Stripped stock. Faster everything, worse recoil.',
  },
  {
    id: 'stock_heavy', name: 'Precision Stock', slot: 'stock', classes: ALL, minRank: 21,
    mesh: 'stock_heavy',
    mods: [
      m('recoilVertical', 0.80), m('recoilHorizontal', 0.86), m('sway', 0.85), m('recoilRecovery', 1.10),
      m('adsTime', 1.10), m('moveScale', 0.97), m('sprintOut', 1.06),
    ],
    pros: ['Best recoil control in the slot', 'Steady hold'],
    cons: ['Slow to swing', 'Slower ADS'],
    description: 'Weighted cheek riser and recoil pad. Rock steady, slow to swing.',
  },
  {
    id: 'stock_none', name: 'No Stock', slot: 'stock', classes: ['smg', 'assault', 'shotgun'], minRank: 32,
    mesh: 'stock_none',
    mods: [
      m('adsTime', 0.80), m('sprintOut', 0.70), m('moveScale', 1.08), m('hipSpread', 0.90),
      m('recoilVertical', 1.35), m('recoilHorizontal', 1.20), m('sway', 1.30), m('adsSpread', 1.10),
    ],
    pros: ['Best mobility in the game', 'Tighter hipfire'],
    cons: ['Recoil becomes a real problem', 'Aimed cone opens up'],
    description: 'Removed entirely. Sprint-out and movement are best in class; hold the trigger at your peril.',
  },
];

/* ==================================================================== table */

export const ATTACHMENT_TABLE: readonly AttachmentEntry[] = [
  ...OPTICS, ...MUZZLES, ...BARRELS, ...UNDERBARREL, ...LASERS, ...MAGAZINES, ...STOCKS,
];

const BY_ID = new Map<string, AttachmentEntry>(ATTACHMENT_TABLE.map((a) => [a.id, a]));

export function attachmentEntry(id: string): AttachmentEntry | null {
  return BY_ID.get(id) ?? null;
}

/** Every attachment a weapon class may mount, optionally filtered to one slot. */
export function attachmentsFor(cls: WeaponClass, slot?: LoadoutSlot): AttachmentEntry[] {
  return ATTACHMENT_TABLE.filter((a) => {
    if (slot && a.slot !== slot) return false;
    return a.classes === 'all' || a.classes.includes(cls);
  });
}

/** True when the entry does not count against the attachment limit. */
export function isBaseline(a: AttachmentEntry): boolean {
  return a.baseline === true;
}

/* ------------------------------------------------------------- the audit -- */

export interface AuditIssue {
  id: string;
  problem: string;
}

/**
 * Proves the "nothing is free" rule over the whole table: every non-baseline
 * attachment must pay for its upside with a stat that moves the wrong way or a
 * drawback flag. Returns the offenders — empty means the table is honest.
 */
export function auditAttachments(
  side: (stat: StatKey) => 'lower' | 'higher',
  flagSide: (flag: string) => 'pro' | 'con',
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  for (const a of ATTACHMENT_TABLE) {
    if (a.baseline) continue;
    let pros = 0;
    let cons = 0;
    for (const mod of a.mods) {
      if (mod.mode !== 'mul') continue;
      const better = side(mod.stat);
      const good = better === 'lower' ? mod.value < 1 : mod.value > 1;
      const bad = better === 'lower' ? mod.value > 1 : mod.value < 1;
      if (good) pros++;
      if (bad) cons++;
    }
    for (const f of a.flags ?? []) {
      if (flagSide(f) === 'pro') pros++; else cons++;
    }
    if (pros === 0) issues.push({ id: a.id, problem: 'no upside at all' });
    if (cons === 0) issues.push({ id: a.id, problem: 'no drawback — free upgrade' });
    if (a.pros.length === 0 && pros > 0) issues.push({ id: a.id, problem: 'undocumented upside' });
    if (a.cons.length === 0 && cons > 0) issues.push({ id: a.id, problem: 'undocumented drawback' });
  }
  return issues;
}

/* ------------------------------------------------------------ live tuning */

/** Applies the `attachments` half of a tuning patch in place. */
export function applyAttachmentTuning(patch: TuningPatch): string[] {
  const notes: string[] = [];
  if (!patch.attachments) return notes;
  for (const id of Object.keys(patch.attachments)) {
    const entry = BY_ID.get(id);
    const over = patch.attachments[id];
    if (!entry || !over) continue;
    const mods = entry.mods as Modifier[];
    for (const stat of Object.keys(over) as StatKey[]) {
      const value = over[stat];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const existing = mods.find((x) => x.stat === stat && x.mode === 'mul');
      if (existing) existing.value = value;
      else mods.push(m(stat, value));
      notes.push(`attachment ${id}.${stat} = ${value}`);
    }
  }
  return notes;
}

export { add as flatModifier, m as mulModifier, max as maxModifier };
