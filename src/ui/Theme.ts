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
  /**
   * The accent hue. **Objectives only** — the mission label, objective markers
   * on the map / compass / world, and the reward beat that pays one off.
   *
   * It is deliberately the rarest colour on screen. Score, damage, hit markers,
   * killstreak tiles and the health bar all used to share it, which left eleven
   * clusters of the same amber competing and nothing receding. Those now read by
   * *value* (near-white when they matter, grey when they do not) so the amber
   * always means the same thing: "this is the objective".
   */
  accent: RGB;
  /** Enemy, incoming damage, low health. */
  hostile: RGB;
  /** Friendly / squad / the player's own kills. */
  friendly: RGB;
  /** Positive confirmation — armour break, regen. */
  good: RGB;
  /** Warning — low ammo, critical. */
  warn: RGB;
  /**
   * Damage the player deals. A *warm* off-white against the cool grey-blue of
   * the rest of the interface: it separates from every other neutral at a
   * glance without spending a saturated hue on a number that is on screen for
   * under a second. Killing blows escalate to `hostile`.
   */
  damage: RGB;
  /** Panel fill. */
  panel: RGB;
  /** Hairline rules. */
  hair: RGB;
  /** Drop shadow / outline behind glyphs so the HUD reads on any background. */
  shade: RGB;
}

const BASE: Palette = {
  // Warm-neutral off-white. Pure #fff is banned; this sits ~86% luma so it
  // still reads as "white" next to the amber accent without clipping.
  ink: [0xe4, 0xe8, 0xed],
  inkDim: [0xa6, 0xaf, 0xba],
  inkFaint: [0x6d, 0x77, 0x84],
  accent: [0xff, 0xb4, 0x33],
  hostile: [0xff, 0x3d, 0x33],
  friendly: [0x4f, 0xc3, 0xff],
  good: [0x5c, 0xdd, 0x9e],
  warn: [0xff, 0x8a, 0x2b],
  damage: [0xff, 0xf0, 0xdb],
  panel: [0x08, 0x0c, 0x12],
  hair: [0xa8, 0xb8, 0xc8],
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
 * Barlow Condensed is requested by index.html from Google Fonts. That request
 * fails in an offline container (and on any machine behind a firewall), so the
 * fallback chain is the *real* type system, not a safety net: it is ordered so
 * the next face down is always another condensed grotesque with a full weight
 * range. `Liberation Sans` / `Arial` are deliberately last — landing on them is
 * exactly the "default browser look" the visual bar forbids.
 */
export const FONT_COND =
  "'Barlow Condensed','Oswald','Archivo Narrow','Saira Condensed',"
  + "'Fira Sans Condensed','Roboto Condensed','Open Sans Condensed',"
  + "'Noto Sans Display Condensed','DejaVu Sans Condensed','Arial Narrow',sans-serif";
/** Body copy — briefs, subtitles, help text. Never a Helvetica/Arial clone. */
export const FONT_SANS =
  "'Barlow','Inter','Fira Sans','Source Sans 3','Noto Sans','Adwaita Sans',"
  + "'DejaVu Sans',system-ui,sans-serif";
export const FONT_MONO =
  "'JetBrains Mono','Fira Code','DejaVu Sans Mono','Liberation Mono',ui-monospace,monospace";

/* ----------------------------------------------------------- hierarchy ---- */

/**
 * How far each tier of the interface steps back when the player aims.
 *
 * Aiming has to *simplify* the frame, and simplifying means promoting the two
 * numbers a player parses without looking — ammunition and health — while the
 * things they cannot act on while holding a sight picture get out of the way.
 * The previous pass had this exactly inverted: the ammo count was faded to 58%
 * while the minimap kept its whole corner at a ghostly 18%, which is the worst
 * of both — unreadable *and* still occupying the pixel.
 *
 * A tier is a multiplier on `ads` subtracted from 1, so `gone` (>1) reaches
 * zero before the aim blend finishes and the element is properly absent rather
 * than a smudge.
 */
export const ADS_FADE = {
  /** Ammunition, health: the peripheral reads. They never step back. */
  vital: 0,
  /** Reticle-adjacent feedback — damage numbers, hit markers. */
  feedback: 0.2,
  /** Killfeed, compass, running score. Legible but clearly secondary. */
  ambient: 0.66,
  /** Killstreaks, equipment: nothing you can act on mid-sight-picture. */
  idle: 0.9,
  /** Fully removed — the minimap. */
  gone: 1.25,
} as const;

/** `base` faded by `tier` for the current aim blend, clamped to 0. */
export function adsFade(base: number, ads: number, tier: number): number {
  const v = base * (1 - ads * tier);
  return v < 0 ? 0 : v > base ? base : v;
}

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
  minimapSize: 196,
  compassWidth: 700,
  compassHeight: 68,
  killfeedWidth: 400,
  ammoWidth: 260,
  vitalsWidth: 300,
} as const;
