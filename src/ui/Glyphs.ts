/**
 * Vector glyph library.
 *
 * Every icon in the HUD — killfeed weapon silhouettes, equipment, killstreaks,
 * objective markers — is drawn from paths at whatever size the layout needs.
 * There are no image assets and nothing rasterises at a fixed resolution, so the
 * HUD is sharp from 720p to 4K.
 *
 * Glyphs are authored in a unit box: x ∈ [0,1] left→right, y ∈ [-0.5,0.5]
 * top→bottom, and are drawn centred on the supplied point at the supplied width.
 */

import type { WeaponKind } from './Model';

type Ctx = CanvasRenderingContext2D;

/** Draws a filled polygon from a flat unit-space coordinate list. */
function poly(c: Ctx, x: number, y: number, w: number, pts: readonly number[]): void {
  c.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const px = x + (pts[i] - 0.5) * w;
    const py = y + pts[i + 1] * w;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
}

/** Axis-aligned box in unit space. */
function box(c: Ctx, x: number, y: number, w: number, bx: number, by: number, bw: number, bh: number): void {
  c.fillRect(x + (bx - 0.5) * w, y + by * w, bw * w, bh * w);
}

function circle(c: Ctx, x: number, y: number, w: number, cx: number, cy: number, r: number): void {
  c.beginPath();
  c.arc(x + (cx - 0.5) * w, y + cy * w, r * w, 0, Math.PI * 2);
  c.fill();
}

/* ------------------------------------------------------- weapon glyphs ---- */

function assaultRifle(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.10, -0.055, 0.62, 0.105);          // receiver
  box(c, x, y, w, 0.70, -0.030, 0.26, 0.048);          // barrel
  box(c, x, y, w, 0.90, -0.090, 0.035, 0.062);         // front sight
  box(c, x, y, w, 0.34, -0.105, 0.16, 0.052);          // optic rail
  poly(c, x, y, w, [0.30, 0.05, 0.44, 0.05, 0.40, 0.20, 0.27, 0.20]);   // magazine
  poly(c, x, y, w, [0.10, -0.055, 0.10, 0.05, 0.02, 0.09, 0.00, 0.02]); // stock
  poly(c, x, y, w, [0.20, 0.05, 0.28, 0.05, 0.25, 0.16, 0.18, 0.16]);   // grip
}

function subMachineGun(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.16, -0.055, 0.50, 0.10);
  box(c, x, y, w, 0.64, -0.028, 0.20, 0.045);
  box(c, x, y, w, 0.36, -0.100, 0.14, 0.048);
  poly(c, x, y, w, [0.36, 0.045, 0.50, 0.045, 0.53, 0.24, 0.40, 0.24]); // curved mag
  poly(c, x, y, w, [0.16, -0.055, 0.16, 0.04, 0.05, 0.07, 0.04, 0.00]);
  poly(c, x, y, w, [0.24, 0.045, 0.32, 0.045, 0.30, 0.15, 0.22, 0.15]);
}

function lightMachineGun(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.08, -0.06, 0.58, 0.12);
  box(c, x, y, w, 0.66, -0.03, 0.30, 0.05);
  box(c, x, y, w, 0.30, 0.06, 0.24, 0.17);            // box magazine
  poly(c, x, y, w, [0.08, -0.06, 0.08, 0.06, 0.00, 0.09, 0.00, 0.00]);
  poly(c, x, y, w, [0.20, 0.06, 0.28, 0.06, 0.26, 0.16, 0.18, 0.16]);
  poly(c, x, y, w, [0.78, 0.02, 0.81, 0.02, 0.88, 0.20, 0.85, 0.20]);  // bipod
  poly(c, x, y, w, [0.78, 0.02, 0.81, 0.02, 0.74, 0.20, 0.71, 0.20]);
}

function sniperRifle(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.10, -0.04, 0.46, 0.085);
  box(c, x, y, w, 0.55, -0.022, 0.42, 0.038);          // long barrel
  box(c, x, y, w, 0.30, -0.115, 0.28, 0.062);          // scope
  box(c, x, y, w, 0.34, -0.135, 0.04, 0.025);
  box(c, x, y, w, 0.50, -0.135, 0.04, 0.025);
  poly(c, x, y, w, [0.10, -0.04, 0.10, 0.045, 0.00, 0.10, 0.00, -0.01]);
  poly(c, x, y, w, [0.24, 0.045, 0.32, 0.045, 0.30, 0.16, 0.22, 0.16]);
  box(c, x, y, w, 0.36, 0.045, 0.10, 0.10);
}

function shotgun(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.12, -0.05, 0.42, 0.10);
  box(c, x, y, w, 0.52, -0.045, 0.44, 0.05);           // barrel
  box(c, x, y, w, 0.52, 0.020, 0.40, 0.038);           // tube
  box(c, x, y, w, 0.60, 0.045, 0.16, 0.055);           // pump
  poly(c, x, y, w, [0.12, -0.05, 0.12, 0.05, 0.00, 0.10, 0.00, 0.00]);
  poly(c, x, y, w, [0.22, 0.05, 0.30, 0.05, 0.28, 0.16, 0.20, 0.16]);
}

function pistol(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.22, -0.09, 0.56, 0.09);            // slide
  box(c, x, y, w, 0.30, 0.00, 0.30, 0.05);             // frame
  poly(c, x, y, w, [0.30, 0.00, 0.46, 0.00, 0.40, 0.24, 0.24, 0.24]);   // grip
  box(c, x, y, w, 0.72, -0.13, 0.04, 0.045);
}

function launcher(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.14, -0.075, 0.66, 0.15);
  poly(c, x, y, w, [0.80, -0.075, 0.98, -0.135, 0.98, 0.135, 0.80, 0.075]);
  poly(c, x, y, w, [0.14, -0.075, 0.14, 0.075, 0.02, 0.12, 0.02, -0.12]);
  poly(c, x, y, w, [0.30, 0.075, 0.40, 0.075, 0.38, 0.20, 0.28, 0.20]);
  box(c, x, y, w, 0.44, -0.16, 0.18, 0.055);           // optic
}

function grenade(c: Ctx, x: number, y: number, w: number): void {
  circle(c, x, y, w, 0.46, 0.03, 0.22);
  box(c, x, y, w, 0.38, -0.24, 0.16, 0.07);            // fuse
  poly(c, x, y, w, [0.54, -0.22, 0.70, -0.20, 0.70, 0.02, 0.62, 0.02, 0.62, -0.14, 0.54, -0.15]); // spoon
}

function knife(c: Ctx, x: number, y: number, w: number): void {
  poly(c, x, y, w, [0.30, -0.02, 0.92, -0.14, 0.98, -0.06, 0.34, 0.06]);  // blade
  box(c, x, y, w, 0.24, -0.05, 0.06, 0.13);                                // guard
  poly(c, x, y, w, [0.04, -0.03, 0.24, -0.035, 0.24, 0.075, 0.04, 0.07]);  // handle
}

function turret(c: Ctx, x: number, y: number, w: number): void {
  box(c, x, y, w, 0.18, -0.10, 0.34, 0.20);
  box(c, x, y, w, 0.52, -0.045, 0.44, 0.05);
  poly(c, x, y, w, [0.24, 0.10, 0.46, 0.10, 0.56, 0.26, 0.14, 0.26]);
  box(c, x, y, w, 0.26, -0.17, 0.10, 0.07);
}

function explosion(c: Ctx, x: number, y: number, w: number): void {
  c.beginPath();
  const cx = x;
  const cy = y;
  const spikes = 10;
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = (i % 2 === 0 ? 0.30 : 0.15) * w;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
}

const WEAPON_GLYPHS: Record<WeaponKind, (c: Ctx, x: number, y: number, w: number) => void> = {
  ar: assaultRifle,
  smg: subMachineGun,
  lmg: lightMachineGun,
  sniper: sniperRifle,
  shotgun,
  pistol,
  launcher,
  grenade,
  knife,
  turret,
  explosion,
};

/**
 * Draws a weapon silhouette centred at (x,y) with the given width.
 * Height works out to roughly 0.42 × width.
 */
export function weaponGlyph(
  c: Ctx, kind: WeaponKind, x: number, y: number, width: number, color: string,
): void {
  c.save();
  c.fillStyle = color;
  WEAPON_GLYPHS[kind](c, x, y, width);
  c.restore();
}

/** Approximate drawn height of a weapon glyph at a given width. */
export function weaponGlyphHeight(width: number): number {
  return width * 0.44;
}

/* ------------------------------------------------------ headshot / kill --- */

/** Small skull-ish "headshot" mark used in the killfeed. */
export function headshotGlyph(c: Ctx, x: number, y: number, r: number, color: string): void {
  c.save();
  c.fillStyle = color;
  c.beginPath();
  c.arc(x, y - r * 0.15, r * 0.72, Math.PI, 0);
  c.lineTo(x + r * 0.72, y + r * 0.28);
  c.lineTo(x + r * 0.34, y + r * 0.28);
  c.lineTo(x + r * 0.34, y + r * 0.62);
  c.lineTo(x - r * 0.34, y + r * 0.62);
  c.lineTo(x - r * 0.34, y + r * 0.28);
  c.lineTo(x - r * 0.72, y + r * 0.28);
  c.closePath();
  c.fill();
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  c.arc(x - r * 0.32, y - r * 0.14, r * 0.2, 0, Math.PI * 2);
  c.arc(x + r * 0.32, y - r * 0.14, r * 0.2, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/* --------------------------------------------------------- equipment ------ */

export type EquipmentGlyph = 'frag' | 'flash' | 'smoke' | 'stun' | 'trophy' | 'claymore' | 'ammo';

export function equipmentGlyph(
  c: Ctx, kind: EquipmentGlyph, x: number, y: number, w: number, color: string,
): void {
  c.save();
  c.fillStyle = color;
  c.strokeStyle = color;
  switch (kind) {
    case 'frag':
      grenade(c, x, y, w);
      break;
    case 'flash':
    case 'stun':
      box(c, x, y, w, 0.34, -0.24, 0.32, 0.44);
      poly(c, x, y, w, [0.34, 0.20, 0.66, 0.20, 0.58, 0.30, 0.42, 0.30]);
      box(c, x, y, w, 0.42, -0.32, 0.16, 0.08);
      c.lineWidth = w * 0.05;
      c.beginPath();
      c.moveTo(x - w * 0.42, y - w * 0.30); c.lineTo(x - w * 0.26, y - w * 0.18);
      c.moveTo(x + w * 0.42, y - w * 0.30); c.lineTo(x + w * 0.26, y - w * 0.18);
      c.stroke();
      break;
    case 'smoke':
      box(c, x, y, w, 0.36, -0.20, 0.28, 0.42);
      circle(c, x, y, w, 0.34, -0.30, 0.10);
      circle(c, x, y, w, 0.56, -0.34, 0.13);
      circle(c, x, y, w, 0.72, -0.22, 0.09);
      break;
    case 'trophy':
      poly(c, x, y, w, [0.16, 0.26, 0.84, 0.26, 0.74, 0.06, 0.26, 0.06]);
      box(c, x, y, w, 0.44, -0.28, 0.12, 0.34);
      circle(c, x, y, w, 0.50, -0.30, 0.11);
      break;
    case 'claymore':
      poly(c, x, y, w, [0.18, -0.16, 0.82, -0.16, 0.74, 0.12, 0.26, 0.12]);
      box(c, x, y, w, 0.26, 0.12, 0.06, 0.16);
      box(c, x, y, w, 0.68, 0.12, 0.06, 0.16);
      break;
    case 'ammo':
      box(c, x, y, w, 0.20, -0.22, 0.60, 0.44);
      c.globalCompositeOperation = 'destination-out';
      box(c, x, y, w, 0.30, -0.10, 0.40, 0.06);
      box(c, x, y, w, 0.30, 0.02, 0.40, 0.06);
      break;
  }
  c.restore();
}

/* -------------------------------------------------------- killstreaks ----- */

export type StreakGlyph = 'uav' | 'cuav' | 'cluster' | 'chopper' | 'airstrike' | 'sentry';

export function streakGlyph(
  c: Ctx, kind: StreakGlyph, x: number, y: number, w: number, color: string,
): void {
  c.save();
  c.fillStyle = color;
  c.strokeStyle = color;
  c.lineWidth = w * 0.055;
  switch (kind) {
    case 'uav':
    case 'cuav':
      poly(c, x, y, w, [0.50, -0.34, 0.58, 0.02, 0.96, 0.14, 0.96, 0.22, 0.56, 0.16,
        0.54, 0.30, 0.66, 0.38, 0.66, 0.44, 0.34, 0.44, 0.34, 0.38, 0.46, 0.30,
        0.44, 0.16, 0.04, 0.22, 0.04, 0.14, 0.42, 0.02]);
      if (kind === 'cuav') {
        c.lineWidth = w * 0.08;
        c.beginPath();
        c.moveTo(x - w * 0.44, y - w * 0.40);
        c.lineTo(x + w * 0.44, y + w * 0.44);
        c.stroke();
      }
      break;
    case 'cluster':
      poly(c, x, y, w, [0.50, -0.42, 0.62, -0.10, 0.62, 0.16, 0.38, 0.16, 0.38, -0.10]);
      circle(c, x, y, w, 0.28, 0.32, 0.09);
      circle(c, x, y, w, 0.50, 0.38, 0.09);
      circle(c, x, y, w, 0.72, 0.32, 0.09);
      break;
    case 'airstrike':
      poly(c, x, y, w, [0.10, -0.10, 0.90, -0.10, 0.74, 0.10, 0.26, 0.10]);
      poly(c, x, y, w, [0.44, 0.10, 0.56, 0.10, 0.52, 0.44, 0.48, 0.44]);
      break;
    case 'chopper':
      c.beginPath();
      c.ellipse(x, y + w * 0.06, w * 0.26, w * 0.16, 0, 0, Math.PI * 2);
      c.fill();
      box(c, x, y, w, 0.60, 0.02, 0.36, 0.05);
      box(c, x, y, w, 0.06, -0.24, 0.88, 0.05);
      box(c, x, y, w, 0.30, 0.20, 0.40, 0.05);
      break;
    case 'sentry':
      turret(c, x, y, w);
      break;
  }
  c.restore();
}

/* ------------------------------------------------------------ markers ----- */

/** Objective diamond with an optional capture ring and centre letter. */
export function objectiveMarker(
  c: Ctx, x: number, y: number, r: number, color: string, label: string,
  progress: number, filled: boolean, font: string,
): void {
  c.save();
  c.lineWidth = Math.max(1, r * 0.16);
  c.beginPath();
  c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y);
  c.closePath();
  if (filled) { c.fillStyle = color; c.fill(); }
  c.strokeStyle = color;
  c.stroke();

  if (progress > 0 && progress < 1) {
    c.beginPath();
    c.lineWidth = Math.max(1.4, r * 0.22);
    c.strokeStyle = color;
    c.arc(x, y, r * 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    c.stroke();
  }

  if (label) {
    c.font = font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = filled ? '#05070b' : color;
    c.fillText(label, x, y + r * 0.06);
  }
  c.restore();
}
