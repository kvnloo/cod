/**
 * Attachments — every one changes the mesh *and* the numbers.
 *
 * Stat deltas are deliberately two-sided: a suppressor costs muzzle velocity
 * and ADS time, a heavy stock costs mobility, an extended magazine costs
 * reload time. That is what makes a loadout a decision instead of a checklist.
 *
 * Mesh changes are declarative: `AttachmentDef.build` is a hint the model
 * builder reads, so a new attachment is one entry here plus one case in
 * `mesh/Parts.ts`.
 */

import type { AttachmentDef, AttachmentSlot, AttachmentStats, WeaponClass, WeaponDef } from './types';

/* --------------------------------------------------------------- optics -- */

const OPTICS: AttachmentDef[] = [
  {
    id: 'optic_reddot',
    name: 'RD-2 Reflex',
    slot: 'optic',
    classes: 'all',
    description: 'Compact enclosed red dot. Fast, unobtrusive, no magnification.',
    stats: { adsTimeScale: 1.03, adsSpreadScale: 0.92, magnification: 1.0 },
    build: { kind: 'reddot', length: 0.062, radius: 0.0175, sightHeight: 0.036, material: 'black' },
  },
  {
    id: 'optic_holo',
    name: 'HS-1 Holographic',
    slot: 'optic',
    classes: 'all',
    description: 'Wide-window holographic sight. Best peripheral view of any optic.',
    stats: { adsTimeScale: 1.05, adsSpreadScale: 0.90, hipSpreadScale: 0.97, magnification: 1.0 },
    build: { kind: 'holo', length: 0.086, radius: 0.023, sightHeight: 0.040, material: 'black' },
  },
  {
    id: 'optic_acog',
    name: 'TA-4 Combat Scope',
    slot: 'optic',
    classes: ['assault', 'marksman', 'lmg', 'sniper'],
    description: '4× prism scope with an illuminated chevron. Trades handling for reach.',
    stats: {
      adsTimeScale: 1.16, adsSpreadScale: 0.72, rangeScale: 1.10,
      moveScale: 0.98, magnification: 4.0,
    },
    build: { kind: 'acog', length: 0.135, radius: 0.024, sightHeight: 0.048, material: 'black' },
  },
  {
    id: 'optic_sniper',
    name: 'LR-9 Variable Scope',
    slot: 'optic',
    classes: ['sniper', 'marksman'],
    description: '9× variable scope. Enormous reach, glacial target acquisition.',
    stats: {
      adsTimeScale: 1.30, adsSpreadScale: 0.5, rangeScale: 1.2,
      moveScale: 0.96, magnification: 9.0,
    },
    build: { kind: 'sniperScope', length: 0.290, radius: 0.028, sightHeight: 0.056, material: 'black' },
  },
  {
    id: 'optic_irons',
    name: 'Iron Sights',
    slot: 'optic',
    classes: 'all',
    description: 'Factory irons. Nothing to snag, nothing to fail.',
    stats: { adsTimeScale: 0.96, magnification: 1.0 },
    build: { kind: 'ironsOnly' },
  },
];

/* ------------------------------------------------------- muzzle devices -- */

const MUZZLES: AttachmentDef[] = [
  {
    id: 'muzzle_suppressor',
    name: 'Suppressor',
    slot: 'muzzle',
    classes: 'all',
    description: 'Removes the flash and keeps you off the minimap. Costs velocity and handling.',
    stats: {
      suppressed: true, muzzleVelocityScale: 0.92, adsTimeScale: 1.08,
      recoilScale: 0.94, rangeScale: 0.90, sprintOutScale: 1.06,
    },
    build: { kind: 'suppressor', length: 0.175, radius: 0.0215, material: 'phosphate' },
  },
  {
    id: 'muzzle_comp',
    name: 'Compensator',
    slot: 'muzzle',
    classes: 'all',
    description: 'Ports gas upward. Kills muzzle climb, adds a very visible flash.',
    stats: { recoilScale: 0.82, recoilHorizontalScale: 1.06, adsTimeScale: 1.02 },
    build: { kind: 'compensator', length: 0.058, radius: 0.017, material: 'phosphate' },
  },
  {
    id: 'muzzle_brake',
    name: 'Muzzle Brake',
    slot: 'muzzle',
    classes: ['sniper', 'marksman', 'lmg', 'shotgun'],
    description: 'Redirects gas sideways. Tames heavy calibres at the cost of noise.',
    stats: { recoilScale: 0.74, recoilHorizontalScale: 0.86, adsTimeScale: 1.06, moveScale: 0.99 },
    build: { kind: 'brake', length: 0.072, radius: 0.019, material: 'phosphate' },
  },
  {
    id: 'muzzle_flash',
    name: 'Flash Hider',
    slot: 'muzzle',
    classes: 'all',
    description: 'Breaks up the flash signature without the weight of a can.',
    stats: { recoilScale: 0.96, adsTimeScale: 1.0 },
    build: { kind: 'flashHider', length: 0.052, radius: 0.0135, material: 'phosphate' },
  },
];

/* ---------------------------------------------------------- underbarrel -- */

const UNDERBARREL: AttachmentDef[] = [
  {
    id: 'under_grip',
    name: 'Vertical Grip',
    slot: 'underbarrel',
    classes: 'all',
    description: 'Straight foregrip. Vertical recoil control, slightly slower ADS.',
    stats: { recoilScale: 0.86, adsTimeScale: 1.04, hipSpreadScale: 1.02 },
    build: { kind: 'foregrip', length: 0.088, radius: 0.0135, material: 'polymer' },
  },
  {
    id: 'under_angled',
    name: 'Angled Grip',
    slot: 'underbarrel',
    classes: 'all',
    description: 'Canted grip. Faster into the shoulder, better horizontal control.',
    stats: { recoilHorizontalScale: 0.80, adsTimeScale: 0.95, sprintOutScale: 0.94 },
    build: { kind: 'angledGrip', length: 0.078, radius: 0.014, material: 'polymer' },
  },
  {
    id: 'under_bipod',
    name: 'Folding Bipod',
    slot: 'underbarrel',
    classes: ['lmg', 'sniper', 'marksman'],
    description: 'Deployable legs. Enormous stability when static, dead weight when moving.',
    stats: { recoilScale: 0.90, moveScale: 0.97, adsTimeScale: 1.05 },
    build: { kind: 'bipod', length: 0.150, radius: 0.006, material: 'phosphate' },
  },
];

const LASERS: AttachmentDef[] = [
  {
    id: 'laser_visible',
    name: 'Tactical Laser',
    slot: 'laser',
    classes: 'all',
    description: 'Tightens hip fire dramatically. The beam gives your position away.',
    stats: { laser: true, hipSpreadScale: 0.62, sprintOutScale: 0.90 },
    build: { kind: 'laser', length: 0.048, radius: 0.010, material: 'alu', tint: 0xff2a1e },
  },
];

/* ------------------------------------------------------------ magazines -- */

const MAGAZINES: AttachmentDef[] = [
  {
    id: 'mag_extended',
    name: 'Extended Mag',
    slot: 'magazine',
    classes: 'all',
    description: '+50% capacity. Longer to reload, heavier to carry.',
    stats: { magSizeScale: 1.5, reloadScale: 1.12, adsTimeScale: 1.02, moveScale: 0.99 },
    build: { kind: 'extMag' },
  },
  {
    id: 'mag_quick',
    name: 'Quickdraw Mag',
    slot: 'magazine',
    classes: 'all',
    description: 'Tapered mag well and a grip tab. Much faster reloads.',
    stats: { reloadScale: 0.78, drawScale: 0.94 },
    build: { kind: 'quickMag' },
  },
  {
    id: 'mag_drum',
    name: 'Drum Mag',
    slot: 'magazine',
    classes: ['assault', 'smg', 'lmg'],
    description: 'Doubles capacity. Ruins mobility and reload speed.',
    stats: { magSizeScale: 2.0, reloadScale: 1.45, moveScale: 0.94, adsTimeScale: 1.10 },
    build: { kind: 'drum' },
  },
];

/* --------------------------------------------------------------- stocks -- */

const STOCKS: AttachmentDef[] = [
  {
    id: 'stock_light',
    name: 'Skeleton Stock',
    slot: 'stock',
    classes: 'all',
    description: 'Stripped stock. Faster everything, worse recoil.',
    stats: { adsTimeScale: 0.88, sprintOutScale: 0.86, moveScale: 1.04, recoilScale: 1.14 },
    build: { kind: 'lightStock' },
  },
  {
    id: 'stock_heavy',
    name: 'Precision Stock',
    slot: 'stock',
    classes: 'all',
    description: 'Weighted cheek riser and recoil pad. Rock steady, slow to swing.',
    stats: { recoilScale: 0.80, recoilHorizontalScale: 0.86, adsTimeScale: 1.10, moveScale: 0.97 },
    build: { kind: 'heavyStock' },
  },
  {
    id: 'stock_none',
    name: 'No Stock',
    slot: 'stock',
    classes: ['smg', 'assault', 'shotgun'],
    description: 'Removed entirely. Sprint-out and movement are best in class.',
    stats: {
      adsTimeScale: 0.80, sprintOutScale: 0.70, moveScale: 1.08,
      recoilScale: 1.35, hipSpreadScale: 0.90,
    },
    build: { kind: 'noStock' },
  },
];

export const ATTACHMENTS: AttachmentDef[] = [
  ...OPTICS, ...MUZZLES, ...UNDERBARREL, ...LASERS, ...MAGAZINES, ...STOCKS,
];

const BY_ID = new Map<string, AttachmentDef>(ATTACHMENTS.map((a) => [a.id, a]));

export function attachment(id: string): AttachmentDef | null {
  return BY_ID.get(id) ?? null;
}

export function attachmentsFor(cls: WeaponClass, slot?: AttachmentSlot): AttachmentDef[] {
  return ATTACHMENTS.filter((a) => {
    if (slot && a.slot !== slot) return false;
    return a.classes === 'all' || a.classes.includes(cls);
  });
}

export function fits(def: WeaponDef, a: AttachmentDef): boolean {
  if (!def.slots.includes(a.slot)) return false;
  return a.classes === 'all' || a.classes.includes(def.cls);
}

/** Resolves a list of attachment ids to defs, dropping anything that cannot fit. */
export function resolveLoadout(def: WeaponDef, ids: readonly string[]): AttachmentDef[] {
  const out: AttachmentDef[] = [];
  const used = new Set<AttachmentSlot>();
  for (const id of ids) {
    const a = BY_ID.get(id);
    if (!a || used.has(a.slot) || !fits(def, a)) continue;
    used.add(a.slot);
    out.push(a);
  }
  return out;
}

/* ------------------------------------------------------------ stat merge -- */

/** Fully-resolved multipliers for one loadout. */
export interface ResolvedStats {
  adsTime: number;
  sprintOut: number;
  drawTime: number;
  recoilScale: number;
  recoilHorizontalScale: number;
  hipSpreadScale: number;
  adsSpreadScale: number;
  bloomScale: number;
  moveScale: number;
  adsMoveScale: number;
  magSize: number;
  reloadScale: number;
  muzzleVelocity: number;
  penetration: number;
  rangeScale: number;
  suppressed: boolean;
  magnification: number;
  laser: boolean;
}

const MUL_KEYS = [
  'adsTimeScale', 'recoilScale', 'recoilHorizontalScale', 'hipSpreadScale',
  'adsSpreadScale', 'bloomScale', 'moveScale', 'adsMoveScale', 'magSizeScale',
  'reloadScale', 'muzzleVelocityScale', 'penetrationScale', 'rangeScale',
  'sprintOutScale', 'drawScale',
] as const;

type MulKey = typeof MUL_KEYS[number];

/** Folds every attachment's deltas into one set of concrete numbers. */
export function resolveStats(def: WeaponDef, list: readonly AttachmentDef[]): ResolvedStats {
  const mul: Record<MulKey, number> = {
    adsTimeScale: 1, recoilScale: 1, recoilHorizontalScale: 1, hipSpreadScale: 1,
    adsSpreadScale: 1, bloomScale: 1, moveScale: 1, adsMoveScale: 1, magSizeScale: 1,
    reloadScale: 1, muzzleVelocityScale: 1, penetrationScale: 1, rangeScale: 1,
    sprintOutScale: 1, drawScale: 1,
  };
  let magDelta = 0;
  let suppressed = false;
  let laser = false;
  let magnification = 1;

  for (const a of list) {
    const s: AttachmentStats = a.stats;
    for (const k of MUL_KEYS) {
      const v = s[k];
      if (typeof v === 'number') mul[k] *= v;
    }
    if (typeof s.magSizeDelta === 'number') magDelta += s.magSizeDelta;
    if (s.suppressed) suppressed = true;
    if (s.laser) laser = true;
    if (typeof s.magnification === 'number') magnification = Math.max(magnification, s.magnification);
  }

  return {
    adsTime: def.handling.adsTime * mul.adsTimeScale,
    sprintOut: def.handling.sprintOut * mul.sprintOutScale,
    drawTime: def.handling.drawTime * mul.drawScale,
    recoilScale: mul.recoilScale,
    recoilHorizontalScale: mul.recoilHorizontalScale * mul.recoilScale,
    hipSpreadScale: mul.hipSpreadScale,
    adsSpreadScale: mul.adsSpreadScale,
    bloomScale: mul.bloomScale,
    moveScale: def.handling.moveScale * mul.moveScale,
    adsMoveScale: def.handling.adsMoveScale * mul.adsMoveScale,
    magSize: Math.max(1, Math.round(def.magSize * mul.magSizeScale) + magDelta),
    reloadScale: mul.reloadScale,
    muzzleVelocity: def.ballistics.muzzleVelocity * mul.muzzleVelocityScale,
    penetration: def.ballistics.penetration * mul.penetrationScale,
    rangeScale: mul.rangeScale,
    suppressed,
    magnification,
    laser,
  };
}
