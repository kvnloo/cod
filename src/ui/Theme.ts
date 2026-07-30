/**
 * HUD design tokens.
 *
 * One accent colour, a near-white with a slight blue cast for body text, and a
 * small set of semantic roles (hostile / friendly / warn / good). Every colour is
 * stored as an RGB triple so alpha variants can be produced without string
 * parsing in the draw loop; the resulting CSS strings are memoised.
 *
 * Four palettes are provided: the default and three dichromat-safe variants.
 * The colourblind variants avoid red/green discrimination entirely and lean on
 * the blue↔orange axis, which survives protan/deutan simulation, plus a
 * red↔cyan axis for tritan.
 */

import { settings } from '../core/Settings';

export type RGB = readonly [number, number, number];

export type ColorBlindMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export interface Palette {
  /** Body text — near white, slight blue cast. Never pure #fff. */
  ink: RGB;
  /** Secondary text. */
  inkDim: RGB;
  /** Tertiary / disabled. */
  inkFaint: RGB;
  /** The single accent colour: objectives, streaks, emphasis, XP. */
  accent: RGB;
  /** Enemy, incoming damage, low health. */
  hostile: RGB;
  /** Friendly / squad. */
  friendly: RGB;
  /** Positive confirmation — armour break, regen. */
  good: RGB;
  /** Warning — low ammo, critical. */
  warn: RGB;
  /** Panel fill. */
  panel: RGB;
  /** Hairline rules. */
  hair: RGB;
  /** Drop shadow / outline behind glyphs so the HUD reads on any background. */
  shade: RGB;
}

const BASE: Palette = {
  ink: [0xdc, 0xe6, 0xf4],
  inkDim: [0x92, 0xa2, 0xb8],
  inkFaint: [0x5c, 0x6a, 0x7d],
  accent: [0xff, 0xc2, 0x4b],
  hostile: [0xff, 0x4a, 0x3a],
  friendly: [0x55, 0xc8, 0xff],
  good: [0x63, 0xe6, 0xa8],
  warn: [0xff, 0x8a, 0x2b],
  panel: [0x08, 0x0c, 0x12],
  hair: [0x9d, 0xb2, 0xcc],
  shade: [0x00, 0x02, 0x05],
};

export const PALETTES: Record<ColorBlindMode, Palette> = {
  off: BASE,
  protanopia: {
    ...BASE,
    accent: [0xf2, 0xd1, 0x4e],
    hostile: [0xff, 0x9c, 0x1f],
    friendly: [0x3f, 0xa9, 0xf5],
    good: [0x8f, 0xd8, 0xff],
    warn: [0xff, 0xd0, 0x54],
  },
  deuteranopia: {
    ...BASE,
    accent: [0xf5, 0xd2, 0x47],
    hostile: [0xff, 0x8a, 0x1f],
    friendly: [0x2e, 0x9b, 0xe6],
    good: [0x86, 0xd7, 0xff],
    warn: [0xff, 0xc9, 0x3d],
  },
  tritanopia: {
    ...BASE,
    accent: [0xff, 0x9b, 0xb0],
    hostile: [0xff, 0x40, 0x40],
    friendly: [0x00, 0xc4, 0xc4],
    good: [0x7d, 0xf2, 0xe6],
    warn: [0xff, 0x6f, 0x6f],
  },
};

/* ------------------------------------------------------------- colour ---- */

const cssCache = new Map<string, string>();

/** Memoised `rgba()` string for an RGB triple. Safe to call in a draw loop. */
export function rgba(c: RGB, a = 1): string {
  const ai = a >= 1 ? 1000 : a <= 0 ? 0 : (a * 1000) | 0;
  const key = `${c[0]},${c[1]},${c[2]},${ai}`;
  let s = cssCache.get(key);
  if (s === undefined) {
    s = ai >= 1000
      ? `rgb(${c[0]},${c[1]},${c[2]})`
      : `rgba(${c[0]},${c[1]},${c[2]},${(ai / 1000).toFixed(3)})`;
    cssCache.set(key, s);
  }
  return s;
}

/** Hex string for DOM/CSS use. */
export function hex(c: RGB): string {
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

/** Scales a colour toward white — used for the hot core of a glow. */
export function lift(c: RGB, t: number): RGB {
  return mixRGB(c, [255, 255, 255], t);
}

/* -------------------------------------------------------------- fonts ---- */

/**
 * Barlow Condensed is loaded by index.html. The fallbacks are ordered so a
 * headless/offline run still gets a condensed grotesque rather than a default
 * browser face.
 */
export const FONT_COND =
  "'Barlow Condensed','Fira Sans Condensed','Open Sans Condensed','DejaVu Sans Condensed','Roboto Condensed','Arial Narrow',sans-serif";
export const FONT_SANS =
  "'Barlow','Inter','Liberation Sans','DejaVu Sans',system-ui,sans-serif";
export const FONT_MONO =
  "'JetBrains Mono','DejaVu Sans Mono','Liberation Mono',ui-monospace,monospace";

/* ------------------------------------------------------------- metrics ---- */

/** Reference design height. Every size in the HUD is authored against this. */
export const REF_HEIGHT = 1080;

/**
 * Resolution-independent scale: linear in viewport height against the 1080p
 * reference, clamped so the HUD never becomes microscopic or cartoonish, then
 * multiplied by the player's `hudScale` preference.
 */
export function hudScale(viewportHeight: number): number {
  const raw = viewportHeight / REF_HEIGHT;
  const clamped = raw < 0.62 ? 0.62 : raw > 2.2 ? 2.2 : raw;
  return clamped * settings.game.hudScale;
}

/** Safe-area inset from the screen edge, in design pixels. */
export const MARGIN = 34;

export const LAYOUT = {
  minimapSize: 194,
  compassWidth: 620,
  compassHeight: 34,
  killfeedWidth: 400,
  ammoWidth: 260,
  vitalsWidth: 300,
} as const;
