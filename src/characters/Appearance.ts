/**
 * Seed → soldier.
 *
 * Everything that makes one character look different from the next is decided
 * here, deterministically, from `CharacterOptions.seed`: body proportions and
 * bulk, which pieces of kit are worn, how the kit is coloured, and the small
 * asymmetries (a rolled sleeve, a strap hanging loose, a knee pad on one leg
 * only) that stop a squad reading as one mesh stamped eight times.
 *
 * Colour is expressed as a *tint* multiplied into a camo atlas by vertex
 * colour, not as a flat albedo, so two riflemen in the same faction still share
 * one material and one texture set.
 */

import * as THREE from 'three';
import { Rand } from '../core/Rand';
import type { CharacterFaction, CharacterLoadout, CharacterOptions } from './types';
import type { Proportions } from './Rig';

export type HeadGear = 'none' | 'cap' | 'boonie' | 'beanie' | 'helmet' | 'helmetCover';
export type FaceGear = 'none' | 'balaclava' | 'shemagh' | 'halfMask' | 'respirator';
export type EyeGear = 'none' | 'goggles' | 'glasses' | 'visor';
export type Carrier = 'none' | 'chestRig' | 'plate' | 'heavy';
export type Sleeves = 'long' | 'rolled' | 'short';

export interface FactionStyle {
  /** Base uniform tint (multiplies the camo atlas). */
  uniform: number[];
  /** Alternate uniform tints for variety within the faction. */
  uniformAlts: number[][];
  /** Webbing / carrier tint. */
  webbing: number[];
  /** Hard kit (helmet shell, pads, boots) tint. */
  hard: number[];
  /** Glove tint. */
  glove: number[];
  /** Probability weights for head gear. */
  head: [HeadGear, number][];
  face: [FaceGear, number][];
  eyes: [EyeGear, number][];
  carrier: [Carrier, number][];
  /** 0..1 chance of NVG mount, comms headset, backpack, knee pads. */
  pNvg: number;
  pHeadset: number;
  pBackpack: number;
  pKneePads: number;
  pGloves: number;
  pPatch: number;
  /** Skin tone spread: index range into SKIN_TONES. */
  skin: [number, number];
  /** Mean body mass multiplier. */
  bulk: number;
}

/** Linear-ish sRGB tints; the atlas supplies the pattern, these supply the hue. */
const SKIN_TONES: number[][] = [
  [0.82, 0.70, 0.62], [0.75, 0.62, 0.54], [0.66, 0.53, 0.45],
  [0.54, 0.43, 0.36], [0.42, 0.33, 0.28], [0.33, 0.26, 0.22],
  [0.86, 0.75, 0.68], [0.70, 0.58, 0.50],
];

export const FACTION_STYLES: Record<CharacterFaction, FactionStyle> = {
  militia: {
    uniform: [0.52, 0.50, 0.36],
    uniformAlts: [
      [0.42, 0.40, 0.30], [0.60, 0.52, 0.38], [0.34, 0.36, 0.32],
      [0.48, 0.42, 0.34], [0.30, 0.30, 0.29],
    ],
    webbing: [0.30, 0.29, 0.24],
    hard: [0.22, 0.22, 0.21],
    glove: [0.24, 0.20, 0.17],
    head: [['none', 0.20], ['cap', 0.22], ['beanie', 0.18], ['boonie', 0.14], ['helmet', 0.26]],
    face: [['none', 0.16], ['balaclava', 0.30], ['shemagh', 0.30], ['halfMask', 0.24]],
    eyes: [['none', 0.52], ['glasses', 0.20], ['goggles', 0.28]],
    carrier: [['none', 0.16], ['chestRig', 0.50], ['plate', 0.34]],
    pNvg: 0.05, pHeadset: 0.22, pBackpack: 0.30, pKneePads: 0.20, pGloves: 0.55, pPatch: 0.15,
    skin: [0, 8], bulk: 0.96,
  },
  pmc: {
    uniform: [0.74, 0.66, 0.50],
    uniformAlts: [
      [0.68, 0.60, 0.46], [0.80, 0.72, 0.56], [0.62, 0.58, 0.46], [0.72, 0.63, 0.47],
    ],
    webbing: [0.60, 0.53, 0.40],
    hard: [0.42, 0.38, 0.30],
    glove: [0.30, 0.26, 0.22],
    head: [['helmet', 0.60], ['helmetCover', 0.26], ['cap', 0.08], ['boonie', 0.06]],
    face: [['none', 0.18], ['balaclava', 0.28], ['halfMask', 0.40], ['shemagh', 0.14]],
    eyes: [['goggles', 0.44], ['glasses', 0.30], ['none', 0.16], ['visor', 0.10]],
    carrier: [['plate', 0.62], ['heavy', 0.24], ['chestRig', 0.14]],
    pNvg: 0.55, pHeadset: 0.85, pBackpack: 0.45, pKneePads: 0.70, pGloves: 0.92, pPatch: 0.75,
    skin: [0, 8], bulk: 1.04,
  },
  spetsnaz: {
    uniform: [0.36, 0.38, 0.33],
    uniformAlts: [
      [0.30, 0.32, 0.28], [0.42, 0.42, 0.36], [0.26, 0.28, 0.27], [0.34, 0.34, 0.31],
    ],
    webbing: [0.26, 0.27, 0.24],
    hard: [0.20, 0.21, 0.20],
    glove: [0.18, 0.18, 0.17],
    head: [['helmet', 0.54], ['helmetCover', 0.20], ['beanie', 0.12], ['cap', 0.14]],
    face: [['balaclava', 0.48], ['respirator', 0.14], ['halfMask', 0.22], ['none', 0.16]],
    eyes: [['goggles', 0.50], ['visor', 0.16], ['none', 0.20], ['glasses', 0.14]],
    carrier: [['plate', 0.54], ['heavy', 0.30], ['chestRig', 0.16]],
    pNvg: 0.40, pHeadset: 0.70, pBackpack: 0.35, pKneePads: 0.60, pGloves: 0.88, pPatch: 0.30,
    skin: [0, 4], bulk: 1.06,
  },
  player: {
    uniform: [0.30, 0.32, 0.31],
    uniformAlts: [[0.26, 0.28, 0.28], [0.34, 0.35, 0.33]],
    webbing: [0.24, 0.25, 0.24],
    hard: [0.18, 0.19, 0.19],
    glove: [0.16, 0.16, 0.16],
    head: [['helmet', 0.8], ['cap', 0.2]],
    face: [['balaclava', 0.6], ['halfMask', 0.4]],
    eyes: [['goggles', 0.6], ['none', 0.4]],
    carrier: [['plate', 1]],
    pNvg: 0.8, pHeadset: 1, pBackpack: 0.3, pKneePads: 0.9, pGloves: 1, pPatch: 0.6,
    skin: [0, 8], bulk: 1.02,
  },
};

/** Per-loadout kit hints — a juggernaut is a different silhouette entirely. */
const LOADOUT_BULK: Record<CharacterLoadout, number> = {
  rifleman: 1.0, smg: 0.95, shotgun: 1.05, sniper: 0.94, lmg: 1.08, juggernaut: 1.35,
};

export interface Appearance {
  seed: number;
  faction: CharacterFaction;
  loadout: CharacterLoadout;
  proportions: Proportions;
  /** Girth multiplier applied to every limb and the torso. */
  bulk: number;
  /** Extra chest depth from armour/muscle. */
  chestDepth: number;

  headGear: HeadGear;
  faceGear: FaceGear;
  eyeGear: EyeGear;
  carrier: Carrier;
  sleeves: Sleeves;
  nvg: boolean;
  /** NVG tubes flipped down over the eyes rather than stowed up. */
  nvgDown: boolean;
  headset: boolean;
  backpack: boolean;
  kneePads: boolean;
  gloves: boolean;
  patch: boolean;
  holster: boolean;
  antenna: boolean;
  /** 0..3 extra utility pouches on the belt. */
  beltPouches: number;
  /** 2..5 magazine pouches across the carrier front. */
  magPouches: number;
  /** Small asymmetries: -1 left, +1 right, 0 none. */
  shoulderPatchSide: number;
  kneePadSide: number;

  /* colours — multiplied into the shared atlases by vertex colour */
  uniformTint: THREE.Color;
  webbingTint: THREE.Color;
  hardTint: THREE.Color;
  gloveTint: THREE.Color;
  bootTint: THREE.Color;
  skinTint: THREE.Color;
  accentTint: THREE.Color;
  /** Per-character brightness jitter applied on top of every tint. */
  wear: number;
}

function lumOf(c: number[]): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

function weighted<T extends string>(rand: Rand, table: [T, number][]): T {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rand.next() * total;
  for (const [v, w] of table) { r -= w; if (r <= 0) return v; }
  return table[table.length - 1][0];
}

/**
 * Turns a palette colour into a *modulation* tint.
 *
 * The camo atlas already carries the colour of the cloth; a tint whose average
 * is 0.4 would multiply that down to mud. So each palette entry is normalised
 * to unit luminance — it contributes hue and nothing else — and `level` sets how
 * light or dark the part should be relative to the texture as authored.
 */
function tint(base: number[], rand: Rand, spread: number, level = 1): THREE.Color {
  const lum = Math.max(1e-3, base[0] * 0.2126 + base[1] * 0.7152 + base[2] * 0.0722);
  const j = level * (1 + rand.signed() * spread);
  const h = rand.signed() * spread * 0.4;
  return new THREE.Color(
    Math.max(0.02, (base[0] / lum) * (j + h)),
    Math.max(0.02, (base[1] / lum) * j),
    Math.max(0.02, (base[2] / lum) * (j - h)),
  );
}

export function makeAppearance(opts: CharacterOptions): Appearance {
  const rand = new Rand(opts.seed);
  const style = FACTION_STYLES[opts.faction] ?? FACTION_STYLES.militia;
  const loadoutBulk = LOADOUT_BULK[opts.loadout] ?? 1;
  const jug = opts.loadout === 'juggernaut';

  // Height: a real squad spans roughly 1.68–1.92 m.
  const height = THREE.MathUtils.clamp(1 + rand.normal() * 0.032, 0.935, 1.07);
  const proportions: Proportions = {
    height,
    legs: 1 + rand.signed() * 0.035,
    torso: 1 + rand.signed() * 0.030,
    arms: 1 + rand.signed() * 0.035,
    shoulders: 1 + rand.signed() * 0.055 + (jug ? 0.10 : 0),
    hips: 1 + rand.signed() * 0.04,
    head: 1 + rand.signed() * 0.035,
    neck: 1 + rand.signed() * 0.05,
  };

  const bulk = THREE.MathUtils.clamp(
    style.bulk * loadoutBulk * (1 + rand.normal() * 0.055), 0.84, 1.55,
  );

  const carrier = jug ? 'heavy' : weighted(rand, style.carrier);
  const headGear = jug ? 'helmet' : weighted(rand, style.head);
  const helmeted = headGear === 'helmet' || headGear === 'helmetCover';

  const uniformBase = rand.bool(0.45)
    ? style.uniform
    : style.uniformAlts[rand.int(0, style.uniformAlts.length - 1)];

  const skinIdx = rand.int(style.skin[0], Math.min(style.skin[1], SKIN_TONES.length - 1));
  const wear = rand.range(0.1, 0.75);

  const app: Appearance = {
    seed: opts.seed,
    faction: opts.faction,
    loadout: opts.loadout,
    proportions,
    bulk,
    chestDepth: 1 + (carrier === 'heavy' ? 0.22 : carrier === 'plate' ? 0.12 : 0.03) + rand.signed() * 0.04,

    headGear,
    faceGear: weighted(rand, style.face),
    eyeGear: weighted(rand, style.eyes),
    carrier,
    sleeves: rand.bool(0.12) ? 'rolled' : 'long',
    nvg: helmeted && rand.bool(style.pNvg),
    nvgDown: rand.bool(0.18),
    headset: rand.bool(style.pHeadset),
    backpack: rand.bool(style.pBackpack),
    kneePads: rand.bool(style.pKneePads),
    gloves: rand.bool(style.pGloves),
    patch: rand.bool(style.pPatch),
    holster: rand.bool(0.45),
    antenna: rand.bool(0.30),
    beltPouches: rand.int(1, 3),
    magPouches: carrier === 'none' ? 0 : (carrier === 'heavy' ? rand.int(4, 5) : rand.int(3, 4)),
    shoulderPatchSide: rand.bool(0.5) ? 1 : -1,
    kneePadSide: rand.bool(0.75) ? 0 : (rand.bool(0.5) ? 1 : -1),

    uniformTint: tint(uniformBase, rand, 0.10, 1.02),
    webbingTint: tint(style.webbing, rand, 0.09, 0.88),
    hardTint: tint(style.hard, rand, 0.08, 0.62),
    gloveTint: tint(style.glove, rand, 0.08, 0.50),
    bootTint: tint([0.19, 0.16, 0.14], rand, 0.12, 0.46),
    // The skin recipe is authored at a light-mid tone; the tint carries the
    // character's own tone as a ratio against it, so the spread survives
    // normalisation.
    skinTint: tint(SKIN_TONES[skinIdx], rand, 0.035, (lumOf(SKIN_TONES[skinIdx]) / 0.709) * 0.80),
    accentTint: tint([0.45, 0.32, 0.16], rand, 0.18, 0.85),
    wear,
  };

  // Juggernauts get the full heavy silhouette regardless of the dice.
  if (jug) {
    app.faceGear = 'respirator';
    app.eyeGear = 'visor';
    app.kneePads = true;
    app.gloves = true;
    app.backpack = false;
    app.sleeves = 'long';
  }
  // A rolled sleeve with gloves and no shirt underneath looks wrong; force skin.
  if (app.sleeves !== 'long' && app.faction === 'spetsnaz') app.sleeves = 'long';

  return app;
}

/** Rough kilo mass used for ragdoll spawning. */
export function appearanceMass(a: Appearance): number {
  const base = 76 * a.proportions.height ** 2.2 * a.bulk;
  const kit = a.carrier === 'heavy' ? 18 : a.carrier === 'plate' ? 12 : a.carrier === 'chestRig' ? 6 : 2;
  return base + kit + (a.backpack ? 8 : 0);
}
