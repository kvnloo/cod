/**
 * Procedural weapon schematic for the loadout screen.
 *
 * There are no model files in this project, so the "weapon model" is drawn: a
 * side-profile technical illustration assembled from parameterised components —
 * receiver, handguard, barrel, muzzle device, stock, grip, magazine, optic —
 * whose proportions come from the weapon class.
 *
 * Treatment is dark gunmetal on a dark plate with a bright top edge, the way a
 * gunsmith screen lights a weapon: a light fill would read as a flat cartoon at
 * this scale. Panel lines, vent cuts and a slow inspection sweep sell the
 * material; leader lines mark the attachment hardpoints.
 */

import type { WeaponKind } from '../Model';

export interface SchematicSpec {
  kind: WeaponKind;
  /** Overall length as a fraction of the canvas width, 0..1. */
  length: number;
  barrel: number;
  stock: number;
  magazine: 'straight' | 'curved' | 'drum' | 'tube' | 'none';
  optic: 'none' | 'iron' | 'reflex' | 'scope';
  foregrip: boolean;
}

export const SPECS: Record<WeaponKind, SchematicSpec> = {
  ar: { kind: 'ar', length: 0.86, barrel: 0.20, stock: 0.21, magazine: 'curved', optic: 'reflex', foregrip: true },
  smg: { kind: 'smg', length: 0.70, barrel: 0.13, stock: 0.17, magazine: 'curved', optic: 'reflex', foregrip: false },
  lmg: { kind: 'lmg', length: 0.92, barrel: 0.24, stock: 0.19, magazine: 'drum', optic: 'iron', foregrip: true },
  sniper: { kind: 'sniper', length: 0.96, barrel: 0.32, stock: 0.23, magazine: 'straight', optic: 'scope', foregrip: false },
  shotgun: { kind: 'shotgun', length: 0.84, barrel: 0.30, stock: 0.21, magazine: 'tube', optic: 'iron', foregrip: false },
  pistol: { kind: 'pistol', length: 0.44, barrel: 0.10, stock: 0.00, magazine: 'straight', optic: 'iron', foregrip: false },
  launcher: { kind: 'launcher', length: 0.90, barrel: 0.34, stock: 0.15, magazine: 'none', optic: 'scope', foregrip: true },
  grenade: { kind: 'grenade', length: 0.30, barrel: 0.00, stock: 0.00, magazine: 'none', optic: 'none', foregrip: false },
  knife: { kind: 'knife', length: 0.5, barrel: 0.0, stock: 0.0, magazine: 'none', optic: 'none', foregrip: false },
  turret: { kind: 'turret', length: 0.7, barrel: 0.24, stock: 0.0, magazine: 'straight', optic: 'iron', foregrip: false },
  explosion: { kind: 'explosion', length: 0.4, barrel: 0, stock: 0, magazine: 'none', optic: 'none', foregrip: false },
};

export interface SchematicColors {
  ink: string;
  dim: string;
  faint: string;
  accent: string;
  hair: string;
}

/** Attachment hardpoints in gun-local coordinates, for the leader lines. */
export const HARDPOINTS: ReadonlyArray<{ slot: string; x: number; y: number }> = [
  { slot: 'MUZZLE', x: 0.982, y: -0.024 },
  { slot: 'BARREL', x: 0.845, y: 0.020 },
  { slot: 'OPTIC', x: 0.335, y: -0.098 },
  { slot: 'UNDERBARREL', x: 0.685, y: 0.070 },
  { slot: 'MAGAZINE', x: 0.455, y: 0.150 },
];

/**
 * Total vertical extent of the drawing in gun lengths, used to fit the
 * illustration inside the available height instead of overflowing it.
 */
const VERTICAL_EXTENT = 0.44;

export function drawWeaponSchematic(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: SchematicSpec,
  col: SchematicColors,
  time: number,
): void {
  c.clearRect(0, 0, w, h);

  // Fit by width *and* height: a tall panel must not let the gun grow until the
  // magazine hangs off the bottom.
  const u = Math.min(w * spec.length, (h * 0.74) / VERTICAL_EXTENT);
  const ox = (w - u) / 2;
  const oy = h * 0.46;

  const X = (x: number): number => ox + x * u;
  const Y = (y: number): number => oy + y * u;

  /* ------------------------------------------------------- backdrop --- */
  const plate = c.createLinearGradient(0, 0, 0, h);
  plate.addColorStop(0, 'rgba(150,175,205,0.05)');
  plate.addColorStop(1, 'rgba(150,175,205,0)');
  c.fillStyle = plate;
  c.fillRect(0, 0, w, h);

  c.strokeStyle = col.hair;
  c.lineWidth = 1;
  const step = Math.max(26, Math.round(w / 20));
  c.globalAlpha = 0.4;
  for (let x = (w % step) / 2; x < w; x += step) {
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
  }
  for (let y = (h % step) / 2; y < h; y += step) {
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  }
  c.globalAlpha = 1;

  c.strokeStyle = 'rgba(157,178,204,0.14)';
  c.setLineDash([7, 8]);
  c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(w, Y(0)); c.stroke();
  c.setLineDash([]);

  /* ------------------------------------------------------ materials -- */
  const body = c.createLinearGradient(0, Y(-0.13), 0, Y(0.22));
  body.addColorStop(0, 'rgba(96,110,130,0.98)');
  body.addColorStop(0.30, 'rgba(58,68,84,0.98)');
  body.addColorStop(0.75, 'rgba(32,39,50,0.98)');
  body.addColorStop(1, 'rgba(22,27,36,0.98)');

  const dark = 'rgba(16,21,29,0.98)';
  const edge = 'rgba(196,216,242,0.5)';
  const lineW = Math.max(1, u * 0.0016);

  const fillPath = (pts: number[], style: string | CanvasGradient, stroke = edge): void => {
    c.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) c.moveTo(X(pts[i]), Y(pts[i + 1]));
      else c.lineTo(X(pts[i]), Y(pts[i + 1]));
    }
    c.closePath();
    c.fillStyle = style;
    c.fill();
    c.strokeStyle = stroke;
    c.lineWidth = lineW;
    c.stroke();
  };

  const rect = (x0: number, y0: number, x1: number, y1: number, style: string | CanvasGradient): void => {
    fillPath([x0, y0, x1, y0, x1, y1, x0, y1], style);
  };

  /** A 1px bright line along a top surface — the rim light that sells metal. */
  const topLight = (x0: number, x1: number, y: number, alpha = 0.75): void => {
    c.strokeStyle = `rgba(214,232,255,${alpha})`;
    c.lineWidth = Math.max(1, u * 0.0022);
    c.beginPath();
    c.moveTo(X(x0), Y(y));
    c.lineTo(X(x1), Y(y));
    c.stroke();
  };

  const stockEnd = spec.stock;
  const receiverStart = Math.max(0.015, stockEnd - 0.015);
  const receiverEnd = 0.545;
  const handguardEnd = 1 - spec.barrel;
  const muzzleStart = 0.94;

  /* --- stock -------------------------------------------------------- */
  if (spec.stock > 0.02) {
    // Buffer tube, then the butt: leaving the gap makes the silhouette read.
    rect(0.055, -0.030, stockEnd, 0.020, body);
    fillPath([
      0.0, -0.048, 0.030, -0.055, 0.062, -0.040,
      0.062, 0.030, 0.030, 0.052, 0.0, 0.046,
    ], body);
    rect(0.0, -0.048, 0.014, 0.046, dark);
    topLight(0.03, stockEnd, -0.030, 0.55);
    c.strokeStyle = 'rgba(196,216,242,0.16)';
    c.lineWidth = lineW;
    for (let i = 1; i <= 3; i++) {
      const x = 0.075 + i * 0.026;
      c.beginPath(); c.moveTo(X(x), Y(-0.026)); c.lineTo(X(x), Y(0.016)); c.stroke();
    }
  }

  /* --- receiver ------------------------------------------------------ */
  rect(receiverStart, -0.050, receiverEnd, 0.042, body);
  topLight(receiverStart, receiverEnd, -0.050);

  // Picatinny rail with individual slots.
  rect(receiverStart + 0.015, -0.066, receiverEnd - 0.03, -0.048, dark);
  c.strokeStyle = 'rgba(196,216,242,0.22)';
  c.lineWidth = lineW;
  for (let x = receiverStart + 0.03; x < receiverEnd - 0.04; x += 0.016) {
    c.beginPath(); c.moveTo(X(x), Y(-0.064)); c.lineTo(X(x), Y(-0.050)); c.stroke();
  }

  // Ejection port, charging handle, selector.
  rect(receiverStart + 0.105, -0.036, receiverStart + 0.170, -0.008, dark);
  rect(receiverStart + 0.020, -0.044, receiverStart + 0.062, -0.030, 'rgba(74,86,104,0.98)');
  c.fillStyle = 'rgba(196,216,242,0.42)';
  c.beginPath(); c.arc(X(receiverStart + 0.052), Y(0.016), u * 0.0085, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc(X(receiverStart + 0.215), Y(0.014), u * 0.007, 0, Math.PI * 2); c.fill();

  /* --- grip + trigger ------------------------------------------------ */
  {
    const gx = receiverStart + 0.055;
    fillPath([gx, 0.038, gx + 0.058, 0.038, gx + 0.040, 0.168, gx - 0.006, 0.160], body);
    c.strokeStyle = 'rgba(196,216,242,0.45)';
    c.lineWidth = Math.max(1.2, u * 0.006);
    c.beginPath();
    c.moveTo(X(gx + 0.058), Y(0.040));
    c.quadraticCurveTo(X(gx + 0.115), Y(0.108), X(gx + 0.128), Y(0.040));
    c.stroke();
    c.strokeStyle = 'rgba(224,238,255,0.7)';
    c.lineWidth = Math.max(1, u * 0.005);
    c.beginPath();
    c.moveTo(X(gx + 0.086), Y(0.044));
    c.quadraticCurveTo(X(gx + 0.098), Y(0.082), X(gx + 0.080), Y(0.088));
    c.stroke();
  }

  /* --- magazine ------------------------------------------------------ */
  if (spec.magazine !== 'none' && spec.magazine !== 'tube') {
    const mx = receiverStart + 0.190;
    c.beginPath();
    if (spec.magazine === 'curved') {
      c.moveTo(X(mx), Y(0.040));
      c.lineTo(X(mx + 0.066), Y(0.040));
      c.quadraticCurveTo(X(mx + 0.092), Y(0.120), X(mx + 0.080), Y(0.196));
      c.lineTo(X(mx + 0.020), Y(0.196));
      c.quadraticCurveTo(X(mx + 0.010), Y(0.118), X(mx), Y(0.040));
    } else if (spec.magazine === 'drum') {
      c.arc(X(mx + 0.040), Y(0.132), u * 0.086, 0, Math.PI * 2);
    } else {
      c.rect(X(mx), Y(0.040), u * 0.058, u * 0.112);
    }
    c.closePath();
    c.fillStyle = body;
    c.fill();
    c.strokeStyle = edge;
    c.lineWidth = lineW;
    c.stroke();
    if (spec.magazine === 'drum') {
      c.strokeStyle = 'rgba(196,216,242,0.26)';
      c.beginPath(); c.arc(X(mx + 0.040), Y(0.132), u * 0.048, 0, Math.PI * 2); c.stroke();
    }
  }

  /* --- handguard ----------------------------------------------------- */
  rect(receiverEnd - 0.004, -0.042, handguardEnd, 0.038, body);
  topLight(receiverEnd, handguardEnd, -0.042);
  rect(receiverEnd, -0.058, handguardEnd - 0.015, -0.040, dark);
  // M-LOK style slots: small, evenly spaced, not big black holes.
  c.fillStyle = 'rgba(12,16,23,0.9)';
  {
    const span = handguardEnd - receiverEnd - 0.055;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const x = receiverEnd + 0.028 + (span * i) / n;
      c.fillRect(X(x), Y(-0.016), u * (span / n) * 0.42, u * 0.030);
    }
  }

  /* --- foregrip ------------------------------------------------------ */
  if (spec.foregrip) {
    const fx = receiverEnd + 0.115;
    fillPath([fx, 0.036, fx + 0.040, 0.036, fx + 0.033, 0.126, fx + 0.006, 0.126], body);
  }

  /* --- barrel, gas block, muzzle -------------------------------------- */
  rect(handguardEnd - 0.008, -0.013, muzzleStart, 0.013, body);
  rect(handguardEnd, -0.038, handguardEnd + 0.026, -0.010, 'rgba(74,86,104,0.98)');
  fillPath([
    handguardEnd + 0.005, -0.038, handguardEnd + 0.021, -0.038,
    handguardEnd + 0.016, -0.082, handguardEnd + 0.010, -0.082,
  ], body);
  rect(muzzleStart, -0.026, 1.0, 0.026, body);
  topLight(muzzleStart, 1.0, -0.026, 0.6);
  c.fillStyle = 'rgba(10,14,20,0.95)';
  for (let i = 0; i < 3; i++) {
    c.fillRect(X(muzzleStart + 0.010 + i * 0.016), Y(-0.026), u * 0.007, u * 0.022);
  }
  c.beginPath();
  c.ellipse(X(1.0), Y(0), u * 0.006, u * 0.024, 0, 0, Math.PI * 2);
  c.fillStyle = 'rgba(6,9,14,0.98)';
  c.fill();

  /* --- optic ---------------------------------------------------------- */
  if (spec.optic !== 'none') {
    const cx = receiverStart + 0.125;
    if (spec.optic === 'scope') {
      rect(cx - 0.050, -0.126, cx + 0.180, -0.072, body);
      topLight(cx - 0.050, cx + 0.180, -0.126);
      rect(cx - 0.072, -0.136, cx - 0.046, -0.062, body);
      rect(cx + 0.172, -0.132, cx + 0.202, -0.066, body);
      rect(cx - 0.014, -0.074, cx + 0.010, -0.050, dark);
      rect(cx + 0.108, -0.074, cx + 0.132, -0.050, dark);
      c.beginPath();
      c.ellipse(X(cx + 0.200), Y(-0.099), u * 0.006, u * 0.031, 0, 0, Math.PI * 2);
      c.fillStyle = 'rgba(118,186,232,0.5)';
      c.fill();
    } else if (spec.optic === 'reflex') {
      rect(cx + 0.018, -0.118, cx + 0.086, -0.070, body);
      topLight(cx + 0.018, cx + 0.086, -0.118);
      rect(cx + 0.026, -0.074, cx + 0.078, -0.050, dark);
      c.fillStyle = 'rgba(120,200,240,0.3)';
      c.fillRect(X(cx + 0.024), Y(-0.114), u * 0.009, u * 0.042);
      c.fillStyle = 'rgba(255,96,72,0.95)';
      c.beginPath();
      c.arc(X(cx + 0.052), Y(-0.092), u * 0.0048, 0, Math.PI * 2);
      c.fill();
    } else {
      fillPath([cx + 0.026, -0.066, cx + 0.046, -0.066, cx + 0.040, -0.104, cx + 0.032, -0.104], body);
    }
  }

  /* --------------------------------------------------- inspection sweep */
  const sweepX = ((time * 0.15) % 1.7) - 0.35;
  const sweep = c.createLinearGradient(X(sweepX - 0.13), 0, X(sweepX + 0.13), 0);
  sweep.addColorStop(0, 'rgba(190,222,255,0)');
  sweep.addColorStop(0.5, 'rgba(190,222,255,0.07)');
  sweep.addColorStop(1, 'rgba(190,222,255,0)');
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.fillStyle = sweep;
  c.fillRect(X(sweepX - 0.13), Y(-0.16), u * 0.26, u * 0.40);
  c.restore();

  /* ----------------------------------------------------- leader lines - */
  c.lineWidth = 1;
  for (const hp of HARDPOINTS) {
    const px = X(hp.x);
    const py = Y(hp.y);
    const up = hp.y <= 0;
    const ly = up ? h * 0.13 : h * 0.87;
    c.globalAlpha = 0.45;
    c.strokeStyle = col.accent;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px, ly + (up ? 8 : -8));
    c.stroke();
    c.globalAlpha = 0.95;
    c.fillStyle = col.accent;
    c.beginPath();
    c.arc(px, py, Math.max(2, u * 0.0026), 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;

  /* ------------------------------------------------------- dimensions - */
  c.strokeStyle = 'rgba(157,178,204,0.28)';
  c.lineWidth = 1;
  const dimY = h * 0.965;
  c.beginPath();
  c.moveTo(X(0), dimY - 5); c.lineTo(X(0), dimY + 5);
  c.moveTo(X(1), dimY - 5); c.lineTo(X(1), dimY + 5);
  c.moveTo(X(0), dimY); c.lineTo(X(1), dimY);
  c.stroke();
}
