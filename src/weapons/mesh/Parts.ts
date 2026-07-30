/**
 * Shared weapon components.
 *
 * Every function here writes into the current `RigBuilder` part, in
 * weapon-local space. Assemblies in `Models.ts` compose them; nothing in this
 * file knows which weapon it is building beyond the `ModelProfile` it is
 * handed, which is what keeps eight weapons from becoming eight piles of
 * bespoke geometry.
 *
 * Conventions:
 *   −Z is down the bore, +Y is up, +X is the ejection-port side.
 *   The bore axis is y = 0; the receiver's rear face is z = 0.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { AttachmentDef, AttachmentSlot, MaterialKey, ModelProfile, WeaponDef } from '../types';
import type { RigBuilder } from './Builder';
import {
  ball, chamferBox, crossPin, cylZ, disc, hexHead, lathe, loft, mlokTube,
  panelLines, picatinny, pipeZ, prismX, rod, screwHead, slingSocket, torusZ,
  ventRing, xf, type LoftRing, type Pt2, type ProfilePt,
} from './Geo';
import { makeReticle, type ReticleKind, type ReticleMode } from './Reticle';

export interface BuildCtx {
  b: RigBuilder;
  def: WeaponDef;
  m: ModelProfile;
  body: MaterialKey;
  furn: MaterialKey;
  slot: Map<AttachmentSlot, AttachmentDef>;
  rand: Rand;
  /** Optical axis of whichever sight the gun ends up wearing. */
  sight: THREE.Vector3;
  /** Y of the top rail surface — where optics bolt on. */
  railY: number;
  /** Z of the receiver's front face (negative). */
  front: number;
  /** Longest point reached by the muzzle stack, updated as devices are added. */
  muzzleZ: number;
  /* --- derived receiver geometry, so assemblies never re-derive it --- */
  /** Top of the receiver. */
  topY: number;
  /** Y at which the upper and lower receivers meet. */
  lowerTop: number;
  /** Centre-line Y of the upper receiver body. */
  upperMidY: number;
  /** Optical axis height of the fitted sight, or 0 when there is no optic. */
  opticAxisY: number;
}

export function makeCtx(b: RigBuilder, def: WeaponDef, attachments: readonly AttachmentDef[]): BuildCtx {
  const slot = new Map<AttachmentSlot, AttachmentDef>();
  for (const a of attachments) slot.set(a.slot, a);
  const m = def.model;
  // The rail surface is the datum: everything above the bore keys off it, so a
  // taller receiver grows downwards rather than lifting the sights.
  const topY = m.railHeight;
  const upperH = m.receiver[1] * 0.52;
  return {
    b, def, m,
    body: m.bodyMaterial,
    furn: m.furnitureMaterial,
    slot,
    rand: new Rand(`weapon:${def.id}`),
    sight: new THREE.Vector3(0, m.sightHeight, -0.08),
    railY: topY,
    front: -m.receiver[2],
    muzzleZ: m.muzzle[2],
    topY,
    lowerTop: topY - upperH,
    upperMidY: topY - upperH * 0.5,
    opticAxisY: 0,
  };
}

/* ------------------------------------------------------------------ misc */

/** Scatters fasteners along a line on a flat face. */
function fasteners(
  ctx: BuildCtx, count: number, from: readonly [number, number, number],
  to: readonly [number, number, number], rot: [number, number, number], hex = false,
): void {
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const p: [number, number, number] = [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ];
    const g = hex ? hexHead(0.0026, 0.0018) : screwHead(0.0024, 0.0008);
    ctx.b.add(xf(g, { pos: p, rot }), ctx.body);
  }
}

/** Both sides of a symmetric detail. */
function mirrored(ctx: BuildCtx, make: (side: 1 | -1) => THREE.BufferGeometry, mat: MaterialKey): void {
  ctx.b.add(make(1), mat);
  ctx.b.add(make(-1), mat);
}

/* -------------------------------------------------------------- receiver */

/**
 * Upper receiver: the part the eye reads first, so it gets the ejection port,
 * the brass deflector, the forward assist, a serial plate and panel lines.
 */
export function upperReceiver(ctx: BuildCtx): void {
  const { b, m } = ctx;
  const w = m.receiver[0], h = m.receiver[1], len = m.receiver[2];
  const z0 = -0.002, z1 = -len;
  const topY = ctx.topY;
  const upperH = h * 0.52;
  const midY = ctx.upperMidY;

  b.part('receiver');

  // Main body — a slightly tapered squared tube with a rounded top.
  b.add(loft([
    { at: [0, midY, z0 + 0.004], w: w * 0.5, h: upperH * 0.5, sq: 5.0 },
    { at: [0, midY, z0 - len * 0.22], w: w * 0.5, h: upperH * 0.5, sq: 5.4 },
    { at: [0, midY, z0 - len * 0.72], w: w * 0.49, h: upperH * 0.48, sq: 5.4 },
    { at: [0, midY, z1 - 0.004], w: w * 0.45, h: upperH * 0.44, sq: 5.0 },
  ], 18), ctx.body);

  // Rear plate with the charging-handle slot.
  b.add(xf(chamferBox(w * 0.98, upperH * 0.96, 0.008, 0.0012), { pos: [0, midY, z0 + 0.004] }), ctx.body);

  // Ejection port: a recessed rectangular well on the right side.
  const portZ = m.ejectPort[2];
  const portY = m.ejectPort[1];
  b.add(xf(chamferBox(0.006, 0.026, 0.062, 0.0012), { pos: [w * 0.5 - 0.001, portY, portZ] }), ctx.body);
  // Deflector wedge just behind the port.
  b.add(xf(loft([
    { at: [w * 0.46, portY + 0.004, portZ + 0.036], w: 0.0035, h: 0.010, sq: 4 },
    { at: [w * 0.56, portY + 0.006, portZ + 0.048], w: 0.0055, h: 0.013, sq: 4 },
    { at: [w * 0.50, portY + 0.004, portZ + 0.060], w: 0.0022, h: 0.009, sq: 4 },
  ], 10), {}), ctx.body);

  // Dust cover — hinged, animated open on the first shot.
  b.part('dustCover', [w * 0.5 - 0.002, portY - 0.014, portZ]);
  b.add(xf(chamferBox(0.0035, 0.024, 0.058, 0.0009), { pos: [w * 0.5 + 0.0015, portY, portZ] }), ctx.body);
  b.add(xf(rod(0.0016, 0.058, 8), { pos: [w * 0.5 - 0.001, portY - 0.013, portZ] }), ctx.body);

  b.use('receiver');

  // Forward assist boss.
  b.add(xf(lathe([[0, 0.0060], [0.010, 0.0060], [0.012, 0.0048], [0.020, 0.0044]], 12),
    { pos: [w * 0.44, portY + 0.008, portZ + 0.052], rot: [0, Math.PI / 2, 0] }), ctx.body);
  b.add(xf(disc(0.0044, 0, 1, 12), { pos: [w * 0.44 + 0.020, portY + 0.008, portZ + 0.052], rot: [0, Math.PI / 2, 0] }), ctx.body);

  // Serial plate + panel lines on the left flank.
  b.add(xf(chamferBox(0.0016, 0.010, 0.034, 0.0004), { pos: [-w * 0.5, portY - 0.004, portZ + 0.010] }), ctx.body);
  b.add(xf(panelLines(3, 0.009, len * 0.55, 0.0010, 0.0007),
    { pos: [-w * 0.5 + 0.0004, midY - 0.002, z0 - len * 0.45], rot: [0, 0, Math.PI / 2] }), ctx.body);

  // Barrel nut / receiver ring at the front.
  b.add(xf(lathe([
    [-0.004, m.handguardRadius * 0.82], [0.006, m.handguardRadius * 0.88],
    [0.014, m.handguardRadius * 0.84], [0.016, m.barrelRadius * 1.7],
  ], 20), { pos: [0, 0, z1 - 0.010] }), ctx.body);

  fasteners(ctx, 2, [-w * 0.5 + 0.0004, topY - 0.006, z0 - 0.020], [-w * 0.5 + 0.0004, topY - 0.006, z1 + 0.030], [0, 0, Math.PI / 2]);
}

/**
 * Lower receiver: magwell, trigger group housing, grip tang, controls and the
 * takedown pins that tie it to the upper.
 */
export function lowerReceiver(ctx: BuildCtx, magWellZ: number, magWellDepth = 0.048): void {
  const { b, m } = ctx;
  const w = m.receiver[0], h = m.receiver[1], len = m.receiver[2];
  const lowerTop = ctx.lowerTop;
  const lowerH = h * 0.48;
  const lowerMid = lowerTop - lowerH * 0.5;

  b.part('receiver');

  b.add(loft([
    { at: [0, lowerMid, -0.004], w: w * 0.47, h: lowerH * 0.5, sq: 6 },
    { at: [0, lowerMid, -len * 0.35], w: w * 0.47, h: lowerH * 0.52, sq: 6 },
    { at: [0, lowerMid, -len * 0.80], w: w * 0.45, h: lowerH * 0.48, sq: 6 },
  ], 14), ctx.body);

  // Magazine well: a flared box hanging under the receiver. The top ring is
  // pushed up *inside* the receiver so its end cap is never seen — a cap left
  // level with the receiver's underside pokes its corners through the rounded
  // shell and reads as a sheet of metal welded across the gun.
  const mw = m.magStyle === 'drum' ? 0.030 : 0.0225;
  b.add(loft([
    { at: [0, lowerTop + 0.010, magWellZ], w: w * 0.30, h: 0.014, sq: 7 },
    { at: [0, lowerTop - 0.006, magWellZ], w: w * 0.42, h: 0.019, sq: 7 },
    { at: [0, lowerTop - magWellDepth * 0.6, magWellZ], w: mw * 0.62, h: 0.019, sq: 7 },
    { at: [0, lowerTop - magWellDepth, magWellZ], w: mw * 0.66, h: 0.021, sq: 7 },
  ], 14, true, false), ctx.body);
  // Flared lip so the well does not end in a raw edge. Open at both ends: the
  // magazine passes through it.
  b.add(loft([
    { at: [0, lowerTop - magWellDepth + 0.002, magWellZ], w: mw * 0.70, h: 0.023, sq: 7 },
    { at: [0, lowerTop - magWellDepth - 0.007, magWellZ], w: mw * 0.80, h: 0.026, sq: 7 },
  ], 14, false, false), ctx.body);

  // Trigger guard: a swept U from the front of the grip to the magwell.
  const guardFront = magWellZ - 0.014;
  const guardBack = magWellZ + 0.062;
  const guardY = lowerTop - 0.014;
  const gRings: LoftRing[] = [
    { at: [0, guardY, guardFront], w: 0.0055, h: 0.0035, sq: 5 },
    { at: [0, guardY - 0.018, guardFront + 0.002], w: 0.0050, h: 0.0032, sq: 5 },
    { at: [0, guardY - 0.026, guardFront + 0.014], w: 0.0048, h: 0.0030, sq: 5 },
    { at: [0, guardY - 0.028, guardBack - 0.020], w: 0.0048, h: 0.0030, sq: 5 },
    { at: [0, guardY - 0.020, guardBack - 0.004], w: 0.0050, h: 0.0032, sq: 5 },
    { at: [0, guardY - 0.004, guardBack], w: 0.0055, h: 0.0038, sq: 5 },
  ];
  b.add(loft(gRings, 10), ctx.body);

  // Controls.
  mirrored(ctx, (s) => xf(lathe([[0, 0.0050], [0.004, 0.0050], [0.005, 0.0040]], 12),
    { pos: [s * (w * 0.47), lowerTop - 0.010, magWellZ + 0.026], rot: [0, s * Math.PI / 2, 0] }), ctx.body);

  // Bolt catch paddle on the left.
  b.add(xf(chamferBox(0.0040, 0.0075, 0.026, 0.0009),
    { pos: [-w * 0.48, lowerTop - 0.007, magWellZ + 0.046] }), ctx.body);

  // Takedown pins.
  b.add(xf(crossPin(0.0032, w * 1.04), { pos: [0, lowerTop - 0.008, -0.016] }), ctx.body);
  b.add(xf(crossPin(0.0032, w * 1.04), { pos: [0, lowerTop - 0.008, -len + 0.020] }), ctx.body);

  // Selector switch — animated by the fire-mode toggle.
  b.part('selector', [-w * 0.47, lowerTop - 0.006, -0.030]);
  b.add(xf(lathe([[0, 0.0062], [0.0035, 0.0062], [0.0045, 0.0050]], 12),
    { pos: [-w * 0.47, lowerTop - 0.006, -0.030], rot: [0, -Math.PI / 2, 0] }), ctx.body);
  b.add(xf(chamferBox(0.0035, 0.0055, 0.019, 0.0007),
    { pos: [-w * 0.47 - 0.0035, lowerTop - 0.006, -0.038] }), ctx.body);

  // Trigger — animated on every shot.
  b.part('trigger', [0, guardY - 0.006, magWellZ + 0.038]);
  b.add(xf(prismX([
    [0.004, 0.000], [0.006, -0.006], [0.004, -0.017], [-0.002, -0.019], [-0.004, -0.010], [-0.003, 0.000],
  ] as Pt2[], 0.008), { pos: [0, guardY - 0.002, magWellZ + 0.038] }), 'blued');

  b.use('receiver');
}

/* ------------------------------------------------------------ pistol grip */

export interface GripOptions {
  /** Top of the grip where it meets the receiver. */
  top: [number, number, number];
  length: number;
  /** Rake in degrees from vertical; 0 is straight down. */
  rake: number;
  width: number;
  depth: number;
  material?: MaterialKey;
  beavertail?: boolean;
  checker?: boolean;
}

export function pistolGrip(ctx: BuildCtx, o: GripOptions): void {
  const { b } = ctx;
  const mat = o.material ?? ctx.furn;
  const rake = (o.rake * Math.PI) / 180;
  const dz = Math.sin(rake), dy = -Math.cos(rake);
  const at = (t: number): [number, number, number] => [
    o.top[0],
    o.top[1] + dy * o.length * t,
    o.top[2] + dz * o.length * t,
  ];

  // The loft starts *above* the joint so its end cap is buried inside the
  // lower receiver. A cap left in the open is a flat plate hanging in mid-air,
  // and it is the single most obvious tell of a procedurally lofted model.
  b.add(loft([
    { at: at(-0.16), w: o.width * 0.30, h: o.depth * 0.32, sq: 5 },
    { at: at(0.04), w: o.width * 0.47, h: o.depth * 0.50, sq: 5 },
    { at: at(0.30), w: o.width * 0.45, h: o.depth * 0.42, sq: 5 },
    { at: at(0.60), w: o.width * 0.44, h: o.depth * 0.39, sq: 5 },
    { at: at(0.86), w: o.width * 0.47, h: o.depth * 0.43, sq: 5 },
    { at: at(1.0), w: o.width * 0.50, h: o.depth * 0.47, sq: 5 },
  ], 16), mat);

  // Butt cap.
  b.add(loft([
    { at: at(0.97), w: o.width * 0.51, h: o.depth * 0.48, sq: 5 },
    { at: at(1.05), w: o.width * 0.47, h: o.depth * 0.44, sq: 5 },
  ], 14), 'rubber');

  if (o.beavertail) {
    // Tang: a web filling the corner between the grip and the receiver. It
    // starts inside the receiver and tapers to nothing, so neither end cap is
    // ever visible.
    b.add(loft([
      { at: [o.top[0], o.top[1] + 0.008, o.top[2] - 0.004], w: o.width * 0.30, h: 0.004, sq: 4 },
      { at: [o.top[0], o.top[1] + 0.004, o.top[2] + 0.008], w: o.width * 0.38, h: 0.007, sq: 4 },
      { at: [o.top[0], o.top[1] + 0.008, o.top[2] + 0.020], w: o.width * 0.30, h: 0.005, sq: 4 },
      { at: [o.top[0], o.top[1] + 0.011, o.top[2] + 0.030], w: o.width * 0.10, h: 0.002, sq: 4 },
    ], 12), mat);
  }

  if (o.checker !== false) {
    // Over-moulded rubber backstrap, hugging the rear of the grip rather than
    // standing off it as a flat plate.
    const back: [number, number, number] = [0, dz, -dy];
    const strapAt = (t: number, k: number): [number, number, number] => {
      const p = at(t);
      return [p[0] + back[0] * o.depth * k, p[1] + back[1] * o.depth * k, p[2] + back[2] * o.depth * k];
    };
    b.add(loft([
      { at: strapAt(0.06, 0.16), w: o.width * 0.30, h: o.depth * 0.08, sq: 4 },
      { at: strapAt(0.24, 0.26), w: o.width * 0.40, h: o.depth * 0.13, sq: 4 },
      { at: strapAt(0.56, 0.28), w: o.width * 0.42, h: o.depth * 0.14, sq: 4 },
      { at: strapAt(0.84, 0.27), w: o.width * 0.41, h: o.depth * 0.13, sq: 4 },
      { at: strapAt(0.98, 0.16), w: o.width * 0.30, h: o.depth * 0.08, sq: 4 },
    ], 12), 'rubber');

    // Front strap: a single swell with three shallow finger scallops, built as
    // a loft so it hugs the grip instead of standing off it.
    const front: LoftRing[] = [];
    for (let i = 0; i <= 11; i++) {
      const t = i / 11;
      const scallop = 0.5 + 0.5 * Math.cos(t * Math.PI * 6.0);
      // Taper to nothing at both ends so the caps vanish into the grip.
      const fade = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) ** 0.5;
      front.push({
        at: strapAt(0.06 + t * 0.88, -0.26),
        w: o.width * 0.30 * fade + 0.0008,
        h: o.depth * (0.055 + scallop * 0.030) * fade + 0.0006,
        sq: 4,
      });
    }
    b.add(loft(front, 12), 'rubber');
  }
}

/* ------------------------------------------------------------------ stock */

export function stock(ctx: BuildCtx, backZ: number, boreY = 0): void {
  const { b, m } = ctx;
  const style = m.stockStyle;
  if (style === 'none') return;

  const tubeR = 0.0155;
  const mat = ctx.furn;

  if (style === 'collapsible' || style === 'skeleton' || style === 'brace') {
    // Buffer tube.
    const tubeLen = style === 'brace' ? 0.10 : 0.185;
    b.add(xf(lathe([
      [0, tubeR * 1.15], [0.010, tubeR * 1.15], [0.012, tubeR],
      [tubeLen - 0.006, tubeR], [tubeLen - 0.004, tubeR * 1.12], [tubeLen, tubeR * 1.12],
    ], 20), { pos: [0, boreY + 0.004, backZ] }), ctx.body);
    b.add(xf(disc(tubeR * 1.12, 0, 1, 20), { pos: [0, boreY + 0.004, backZ + tubeLen] }), ctx.body);
    // Castle nut.
    b.add(xf(lathe([[0, tubeR * 1.3], [0.008, tubeR * 1.3]], 12),
      { pos: [0, boreY + 0.004, backZ + 0.002] }), ctx.body);

    b.part('stock', [0, boreY + 0.004, backZ + tubeLen * 0.55]);
    if (style === 'skeleton') {
      // Two thin rails and a butt plate.
      for (const s of [1, -1]) {
        b.add(xf(chamferBox(0.0055, 0.030, tubeLen * 0.86, 0.0010),
          { pos: [s * (tubeR + 0.006), boreY + 0.004, backZ + tubeLen * 0.55] }), mat);
      }
      b.add(xf(chamferBox(0.046, 0.062, 0.010, 0.0016),
        { pos: [0, boreY + 0.006, backZ + tubeLen * 0.97] }), mat);
      b.add(xf(chamferBox(0.044, 0.058, 0.007, 0.0018),
        { pos: [0, boreY + 0.006, backZ + tubeLen * 1.02] }), 'rubber');
      // Cheek rail.
      b.add(xf(chamferBox(0.014, 0.008, tubeLen * 0.7, 0.0010),
        { pos: [0, boreY + 0.024, backZ + tubeLen * 0.55] }), mat);
    } else {
      // Carbine stock: a slim collar on the tube, a cheek weld that rises to a
      // comb, and a butt with a real toe. The silhouette is the whole point.
      const z0 = backZ + tubeLen * 0.26;
      const l = style === 'brace' ? 0.080 : 0.138;
      b.add(loft([
        { at: [0, boreY + 0.004, z0 - 0.020], w: 0.0170, h: 0.0170, sq: 5 },
        { at: [0, boreY + 0.004, z0], w: 0.0215, h: 0.0205, sq: 5 },
        { at: [0, boreY + 0.005, z0 + l * 0.18], w: 0.0225, h: 0.0230, sq: 5 },
        { at: [0, boreY + 0.007, z0 + l * 0.46], w: 0.0235, h: 0.0270, sq: 5.2 },
        { at: [0, boreY + 0.008, z0 + l * 0.74], w: 0.0245, h: 0.0320, sq: 5.4 },
        { at: [0, boreY + 0.008, z0 + l * 0.96], w: 0.0250, h: 0.0355, sq: 5.6 },
        { at: [0, boreY + 0.008, z0 + l], w: 0.0245, h: 0.0348, sq: 5.6 },
      ], 16), mat);
      // Comb: the raised cheek rest along the top.
      b.add(loft([
        { at: [0, boreY + 0.016, z0 + l * 0.10], w: 0.0050, h: 0.0018, sq: 4 },
        { at: [0, boreY + 0.022, z0 + l * 0.34], w: 0.0115, h: 0.0048, sq: 4 },
        { at: [0, boreY + 0.026, z0 + l * 0.62], w: 0.0125, h: 0.0058, sq: 4 },
        { at: [0, boreY + 0.024, z0 + l * 0.92], w: 0.0100, h: 0.0042, sq: 4 },
      ], 12), mat);
      // Recoil pad.
      b.add(loft([
        { at: [0, boreY + 0.008, z0 + l], w: 0.0245, h: 0.0348, sq: 5.6 },
        { at: [0, boreY + 0.008, z0 + l + 0.006], w: 0.0250, h: 0.0356, sq: 5.6 },
        { at: [0, boreY + 0.008, z0 + l + 0.013], w: 0.0225, h: 0.0330, sq: 5.6 },
      ], 14), 'rubber');
      // Adjustment lever under the tube and a QD socket in the flank.
      b.add(xf(chamferBox(0.0105, 0.0135, 0.030, 0.0010),
        { pos: [0, boreY - 0.017, z0 + l * 0.30] }), mat);
      b.add(xf(chamferBox(0.014, 0.006, 0.010, 0.0008),
        { pos: [0, boreY - 0.024, z0 + l * 0.22] }), mat);
      for (const s of [1, -1]) {
        b.add(xf(slingSocket(0.0055),
          { pos: [s * 0.0230, boreY + 0.002, z0 + l * 0.20], rot: [0, (s * Math.PI) / 2, 0] }), ctx.body);
      }
    }
    b.use('receiver');
    return;
  }

  if (style === 'fixed' || style === 'thumbhole') {
    b.part('stock', [0, boreY, backZ]);
    const l = style === 'thumbhole' ? 0.245 : 0.215;
    const drop = style === 'thumbhole' ? 0.010 : 0.014;
    b.add(loft([
      { at: [0, boreY - 0.006, backZ - 0.026], w: 0.014, h: 0.020, sq: 6 },
      { at: [0, boreY - 0.010, backZ], w: 0.020, h: 0.030, sq: 6 },
      { at: [0, boreY - 0.012, backZ + l * 0.22], w: 0.022, h: 0.034, sq: 6 },
      { at: [0, boreY - drop, backZ + l * 0.62], w: 0.024, h: 0.036, sq: 5.5 },
      { at: [0, boreY - drop - 0.004, backZ + l * 0.95], w: 0.026, h: 0.042, sq: 5.5 },
      { at: [0, boreY - drop - 0.004, backZ + l], w: 0.025, h: 0.041, sq: 5.5 },
    ], 18), mat);
    // Comb / cheek riser.
    b.add(loft([
      { at: [0, boreY + 0.014, backZ + l * 0.16], w: 0.006, h: 0.003, sq: 5 },
      { at: [0, boreY + 0.021, backZ + l * 0.34], w: 0.014, h: 0.008, sq: 5 },
      { at: [0, boreY + 0.026, backZ + l * 0.60], w: 0.016, h: 0.010, sq: 5 },
      { at: [0, boreY + 0.024, backZ + l * 0.90], w: 0.012, h: 0.007, sq: 5 },
    ], 12), mat);
    // Recoil pad.
    b.add(xf(loft([
      { at: [0, boreY - drop - 0.004, backZ + l], w: 0.025, h: 0.041, sq: 5.5 },
      { at: [0, boreY - drop - 0.004, backZ + l + 0.013], w: 0.023, h: 0.039, sq: 5.5 },
    ], 14), {}), 'rubber');
    if (style === 'thumbhole') {
      // Thumb shelf: a raised web behind the grip.
      b.add(xf(chamferBox(0.017, 0.030, 0.045, 0.0035),
        { pos: [0, boreY - 0.030, backZ + 0.030] }), mat);
    }
    // Sling stud.
    b.add(xf(slingSocket(0.0055), { pos: [0, boreY - drop - 0.030, backZ + l * 0.55], rot: [Math.PI / 2, 0, 0] }), ctx.body);
    b.use('receiver');
  }
}

/* -------------------------------------------------------------- barrel -- */

export function barrel(ctx: BuildCtx, opts: { gasBlock?: boolean; fluted?: boolean } = {}): void {
  const { b, m } = ctx;
  const r = m.barrelRadius;
  const z0 = ctx.front;
  const z1 = z0 - m.barrelLength;

  b.part('receiver');

  // Stepped profile: chamber shoulder, gas journal, thin section, thread.
  const prof: ProfilePt[] = [
    [z0 + 0.010, r * 1.55], [z0 - 0.020, r * 1.55], [z0 - 0.026, r * 1.18],
    [z0 - m.barrelLength * 0.42, r * 1.10],
    [z0 - m.barrelLength * 0.46, r],
    [z1 + 0.016, r], [z1 + 0.014, r * 0.92], [z1, r * 0.92],
  ];
  b.add(xf(lathe(prof, 20), {}), 'blued');
  // Crown: a real bore you can look down.
  b.add(xf(pipeZ(r * 0.92, r * 0.42, 0.012, 20), { pos: [0, 0, z1 + 0.006] }), 'blued');

  if (opts.fluted) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const g = chamferBox(r * 0.5, r * 0.32, m.barrelLength * 0.45, 0.0005);
      xf(g, { pos: [0, r * 0.96, z0 - m.barrelLength * 0.62] });
      xf(g, { rot: [0, 0, a] });
      b.add(g, 'blued');
    }
  }

  if (opts.gasBlock !== false) {
    // Sit the block just forward of the handguard so it is actually visible
    // rather than buried inside a free-float tube.
    const hgEnd = m.handguardStyle === 'none' || m.handguardLength <= 0
      ? z0 - m.barrelLength * 0.5
      : z0 - 0.006 - m.handguardLength;
    const gz = Math.max(z1 + 0.045, hgEnd - 0.024);
    b.add(xf(chamferBox(r * 2.5, r * 2.7, 0.030, 0.0012), { pos: [0, r * 0.25, gz] }), ctx.body);
    // Gas tube running back over the barrel into the receiver.
    const tubeLen = Math.max(0.02, z0 - gz - 0.004);
    b.add(xf(rod(0.0022, tubeLen, 10), { pos: [0, r * 1.60, gz + tubeLen * 0.5] }), ctx.body);
    b.add(xf(hexHead(0.0026, 0.0018), { pos: [r * 1.1, r * 0.25, gz], rot: [0, 0, -Math.PI / 2] }), ctx.body);
  }
}

/* --------------------------------------------------------- handguards -- */

export function handguard(ctx: BuildCtx): void {
  const { b, m } = ctx;
  if (m.handguardStyle === 'none' || m.handguardLength <= 0) return;

  const z0 = ctx.front - 0.006;
  const len = m.handguardLength;
  const zc = z0 - len / 2;
  const R = m.handguardRadius;

  b.part('receiver');

  // A free-float tube is narrower than the receiver, so it needs a riser web
  // to carry the top rail forward at exactly the receiver's rail height. This
  // is the single detail that makes a modern rifle silhouette read correctly.
  const riser = (): void => {
    const gap = ctx.railY - R * 0.86;
    if (gap <= 0.0015) return;
    b.add(xf(chamferBox(0.0215, gap, len * 0.99, 0.0010),
      { pos: [0, R * 0.86 + gap * 0.5, zc] }), ctx.body);
    for (const s of [1, -1]) {
      b.add(xf(chamferBox(0.0032, gap * 0.9, len * 0.99, 0.0007),
        { pos: [s * 0.0122, R * 0.86 + gap * 0.5, zc] }), ctx.body);
    }
  };

  switch (m.handguardStyle) {
    case 'mlok': {
      b.add(xf(mlokTube(len, R, 8, 4), { pos: [0, 0, zc] }), ctx.body);
      riser();
      // Barrel-nut collar and muzzle-end collar.
      b.add(xf(lathe([[-0.008, R * 1.06], [0.006, R * 1.06], [0.008, R * 0.92]], 20), { pos: [0, 0, z0 - 0.002] }), ctx.body);
      b.add(xf(lathe([[-0.006, R * 0.94], [0.004, R * 1.02], [0.006, R * 1.02]], 20), { pos: [0, 0, z0 - len ] }), ctx.body);
      fasteners(ctx, 3, [0, R * 0.96, z0 - 0.020], [0, R * 0.96, z0 - len + 0.020], [0, 0, 0]);
      break;
    }
    case 'rail': {
      // Quad rail: a core tube with four picatinny sections.
      b.add(xf(lathe([[-len / 2, R * 0.80], [len / 2, R * 0.80]], 16), { pos: [0, 0, zc] }), ctx.body);
      // Only three sides: the top rail is carried at receiver height by the
      // riser + `topRail`, exactly as a real free-float quad rail does.
      for (let i = 1; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const g = picatinny(len * 0.94, R * 0.90, 0.0075);
        xf(g, { pos: [0, R * 0.82, zc] });
        xf(g, { rot: [0, 0, a] });
        b.add(g, ctx.body);
      }
      b.add(xf(lathe([[-0.008, R * 1.04], [0.006, R * 1.04], [0.008, R * 0.86]], 18), { pos: [0, 0, z0 - 0.002] }), ctx.body);
      riser();
      break;
    }
    case 'wood': {
      b.add(loft([
        { at: [0, 0, z0], w: R * 0.92, h: R * 0.92, sq: 4 },
        { at: [0, 0, z0 - len * 0.30], w: R, h: R, sq: 4 },
        { at: [0, 0, z0 - len * 0.72], w: R * 0.98, h: R * 0.98, sq: 4 },
        { at: [0, 0, z0 - len], w: R * 0.86, h: R * 0.86, sq: 4 },
      ], 18), 'wood');
      // Metal end bands.
      for (const z of [z0 - 0.004, z0 - len + 0.004]) {
        b.add(xf(lathe([[-0.005, R * 1.02], [0.005, R * 1.02]], 18), { pos: [0, 0, z] }), ctx.body);
      }
      break;
    }
    case 'shroud': {
      b.add(xf(pipeZ(R, R * 0.86, len, 22), { pos: [0, 0, zc] }), ctx.body);
      for (let i = 0; i < 5; i++) {
        b.add(xf(ventRing(R * 0.995, 0, 8, 0.0075, 0.0018, 0.026),
          { pos: [0, 0, z0 - 0.028 - i * (len - 0.05) / 4] }), ctx.body);
      }
      b.add(xf(lathe([[-0.008, R * 1.08], [0.008, R * 1.08]], 20), { pos: [0, 0, z0 - 0.004] }), ctx.body);
      b.add(xf(lathe([[-0.008, R * 1.06], [0.008, R * 1.06]], 20), { pos: [0, 0, z0 - len + 0.004] }), ctx.body);
      riser();
      break;
    }
    default:
      break;
  }

  // Handstop / sling socket underneath — always present so the hand has a home.
  b.add(xf(slingSocket(0.0055), { pos: [R * 0.72, -R * 0.62, z0 - len * 0.35], rot: [0, Math.PI / 2, 0] }), ctx.body);
}

/* ---------------------------------------------------------- top rail -- */

export function topRail(ctx: BuildCtx): void {
  const { b, m } = ctx;
  if (m.topRail <= 0) return;
  const y = ctx.railY;
  const zBack = -0.010;
  const g = picatinny(m.topRail, 0.0212, 0.0082);
  b.part('receiver');
  b.add(xf(g, { pos: [0, y + 0.0041, zBack - m.topRail / 2] }), ctx.body);
}

/* ---------------------------------------------------- magazine bodies -- */

export function magazine(ctx: BuildCtx, wellZ: number, wellY: number): void {
  const { b, m } = ctx;
  if (m.magStyle === 'none' || m.magStyle === 'tube') return;

  const extended = ctx.slot.get('magazine');
  const kind = extended?.build.kind;
  const lenScale = kind === 'extMag' ? 1.35 : kind === 'drum' ? 1.0 : 1.0;
  const style = kind === 'drum' ? 'drum' : m.magStyle;
  const len = m.magLength * lenScale;

  b.part('magazine', [0, wellY, wellZ]);
  const mat = ctx.furn === 'wood' ? 'polymer' : ctx.furn;

  switch (style) {
    case 'stanag':
    case 'curved': {
      const curve = m.magCurve;
      const rings: LoftRing[] = [];
      const steps = 6;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const y = wellY - len * t;
        const z = wellZ + curve * len * t * t;
        rings.push({ at: [0, y, z], w: 0.0115, h: 0.0125 + t * 0.0008, sq: 6.5 });
      }
      b.add(loft(rings, 14), mat);
      // Floor plate.
      const fz = wellZ + curve * len;
      b.add(xf(loft([
        { at: [0, wellY - len - 0.001, fz], w: 0.0128, h: 0.0138, sq: 6.5 },
        { at: [0, wellY - len - 0.009, fz + 0.002], w: 0.0125, h: 0.0135, sq: 6.5 },
      ], 12), {}), mat);
      // Witness holes and ribs.
      for (let i = 1; i <= 4; i++) {
        const t = i / 5;
        b.add(xf(chamferBox(0.0022, 0.0035, 0.0035, 0.0004),
          { pos: [0.0116, wellY - len * t, wellZ + curve * len * t * t] }), mat);
      }
      // Grip tab for the quickdraw mag.
      if (kind === 'quickMag') {
        b.add(xf(chamferBox(0.0175, 0.020, 0.0055, 0.0012),
          { pos: [0, wellY - len - 0.006, fz + 0.014] }), 'rubber');
      }
      break;
    }
    case 'stick': {
      const rings: LoftRing[] = [
        { at: [0, wellY, wellZ], w: 0.0105, h: 0.0115, sq: 7 },
        { at: [0, wellY - len * 0.5, wellZ + 0.002], w: 0.0105, h: 0.0115, sq: 7 },
        { at: [0, wellY - len, wellZ + 0.004], w: 0.0105, h: 0.0115, sq: 7 },
      ];
      b.add(loft(rings, 12), mat);
      b.add(xf(chamferBox(0.024, 0.007, 0.026, 0.0010),
        { pos: [0, wellY - len - 0.004, wellZ + 0.004] }), mat);
      for (let i = 1; i <= 5; i++) {
        b.add(xf(chamferBox(0.0225, 0.0016, 0.0024, 0.0003),
          { pos: [0, wellY - (len * i) / 6, wellZ + 0.0125] }), mat);
      }
      break;
    }
    case 'box': {
      b.add(loft([
        { at: [0, wellY, wellZ], w: 0.0125, h: 0.017, sq: 7 },
        { at: [0, wellY - len, wellZ + 0.004], w: 0.0125, h: 0.017, sq: 7 },
      ], 12), mat);
      b.add(xf(chamferBox(0.028, 0.006, 0.040, 0.0012),
        { pos: [0, wellY - len - 0.003, wellZ + 0.004] }), ctx.body);
      break;
    }
    case 'pistol': {
      b.add(loft([
        { at: [0, wellY, wellZ], w: 0.0085, h: 0.0145, sq: 7 },
        { at: [0, wellY - len, wellZ + 0.010], w: 0.0085, h: 0.0145, sq: 7 },
      ], 12), 'blued');
      b.add(xf(chamferBox(0.020, 0.005, 0.032, 0.0010),
        { pos: [0, wellY - len - 0.002, wellZ + 0.010] }), mat);
      break;
    }
    case 'drum': {
      const R = 0.055;
      b.add(xf(lathe([
        [-0.019, R * 0.30], [-0.019, R * 0.94], [-0.014, R],
        [0.014, R], [0.019, R * 0.94], [0.019, R * 0.30],
      ], 28), { pos: [0, wellY - R - 0.010, wellZ + 0.010] }), mat);
      b.add(xf(disc(R * 0.30, -0.019, -1, 16), { pos: [0, wellY - R - 0.010, wellZ + 0.010] }), mat);
      b.add(xf(disc(R * 0.30, 0.019, 1, 16), { pos: [0, wellY - R - 0.010, wellZ + 0.010] }), mat);
      // Feed tower into the magwell.
      b.add(loft([
        { at: [0, wellY, wellZ], w: 0.0115, h: 0.0125, sq: 6.5 },
        { at: [0, wellY - 0.030, wellZ + 0.004], w: 0.0125, h: 0.0135, sq: 6.5 },
      ], 12), mat);
      // Winder knob and a rib pattern.
      b.add(xf(lathe([[0.019, 0.010], [0.026, 0.010], [0.028, 0.007]], 12),
        { pos: [0, wellY - R - 0.010, wellZ + 0.010] }), ctx.body);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const g = chamferBox(0.004, R * 0.62, 0.0025, 0.0005);
        xf(g, { pos: [0, R * 0.5, 0.020] });
        xf(g, { rot: [0, 0, a] });
        xf(g, { pos: [0, wellY - R - 0.010, wellZ + 0.010] });
        b.add(g, mat);
      }
      break;
    }
    default:
      break;
  }

  b.use('receiver');
}

/* ------------------------------------------------------- iron sights -- */

export function ironSights(ctx: BuildCtx, frontZ: number, rearZ: number, hooded = true, baseY?: number): void {
  const { b, m } = ctx;
  const y = baseY ?? ctx.railY + 0.0082;
  const h = m.sightHeight - y;

  b.part('frontSight', [0, y, frontZ]);
  // Base.
  b.add(xf(chamferBox(0.016, 0.006, 0.018, 0.0010), { pos: [0, y + 0.003, frontZ] }), ctx.body);
  // Post.
  b.add(xf(chamferBox(0.0022, Math.max(0.006, h), 0.0022, 0.0004),
    { pos: [0, y + 0.006 + Math.max(0.006, h) / 2, frontZ] }), ctx.body);
  if (hooded) {
    for (const s of [1, -1]) {
      b.add(xf(chamferBox(0.0022, Math.max(0.010, h + 0.004), 0.0035, 0.0005),
        { pos: [s * 0.0062, y + 0.006 + (h + 0.004) / 2, frontZ] }), ctx.body);
    }
    b.add(xf(chamferBox(0.015, 0.0022, 0.0035, 0.0005),
      { pos: [0, y + 0.008 + Math.max(0.010, h + 0.004), frontZ] }), ctx.body);
  }

  b.part('rearSight', [0, y, rearZ]);
  b.add(xf(chamferBox(0.018, 0.005, 0.016, 0.0010), { pos: [0, y + 0.0025, rearZ] }), ctx.body);
  // Aperture leaf: a ring with a hole you actually look through.
  const apY = y + 0.005 + Math.max(0.005, h * 0.9);
  b.add(xf(pipeZ(0.0058, 0.0026, 0.0035, 16), { pos: [0, apY, rearZ] }), ctx.body);
  b.add(xf(chamferBox(0.014, 0.0075, 0.0030, 0.0006), { pos: [0, apY - 0.006, rearZ] }), ctx.body);
  for (const s of [1, -1]) {
    b.add(xf(chamferBox(0.0026, 0.012, 0.0030, 0.0005), { pos: [s * 0.0075, apY - 0.001, rearZ] }), ctx.body);
  }
  // Windage drum.
  b.add(xf(lathe([[0, 0.0032], [0.004, 0.0032], [0.005, 0.0024]], 10),
    { pos: [0.0088, apY - 0.002, rearZ], rot: [0, Math.PI / 2, 0] }), ctx.body);

  ctx.sight.set(0, apY, rearZ);
  b.use('receiver');
}

/* ------------------------------------------------------------ optics -- */

export function optic(ctx: BuildCtx, att: AttachmentDef): void {
  const { b } = ctx;
  const kind = att.build.kind;
  const railTop = ctx.railY + 0.0082;
  const mat: MaterialKey = att.build.material ?? 'black';
  const mountZ = -0.055;

  b.part('optic', [0, railTop, mountZ]);

  /**
   * Declares the illuminated mark. `z` is the plane the dot is projected onto
   * — always the *front* element, because that is where a reflex sight's dot
   * actually lives and it is what makes the dot occlude correctly against the
   * hood when the eye moves off axis.
   */
  const mark = (
    r: ReticleKind, z: number, axisY: number, window: number, moa: number,
    color: number, intensity: number, mode: ReticleMode = 'emissive',
  ): void => {
    // 1 MOA = 1/60°. The quad's half-width is the design half-angle, so the
    // shader's unit circle is exactly the reticle envelope.
    b.reticle(makeReticle({ kind: r, color, intensity, mode }), {
      parent: 'optic', z, axisY, window, halfAngle: (moa / 60) * (Math.PI / 180),
    });
  };

  const mount = (w: number, len: number, h: number, z: number): void => {
    b.add(xf(chamferBox(w, h, len, 0.0012), { pos: [0, railTop + h / 2, z] }), 'alu');
    b.add(xf(chamferBox(w * 0.42, h * 0.9, 0.008, 0.0008), { pos: [w * 0.62, railTop + h * 0.45, z] }), 'alu');
    b.add(xf(hexHead(0.0028, 0.0020), { pos: [w * 0.62, railTop + h * 0.95, z], rot: [0, 0, 0] }), 'alu');
  };

  switch (kind) {
    case 'reddot': {
      const len = att.build.length ?? 0.062;
      const r = att.build.radius ?? 0.0175;
      const h = Math.max(0.005, (att.build.sightHeight ?? 0.036) - r);
      mount(0.026, len * 0.66, h, mountZ);
      const cy = railTop + h + r;
      // Enclosed reflex, built as one closed revolved profile: outer shell,
      // front rim, bore, rear rim. Because the profile closes on itself the
      // sight has a real wall thickness and a tube you can see through, which
      // is the entire difference between an optic and a black cylinder.
      const wall = r * 0.17;
      const f = mountZ - len * 0.5, k = mountZ + len * 0.5;
      b.add(xf(lathe([
        [f, r], [f + len * 0.16, r], [f + len * 0.30, r * 0.86],
        [k - len * 0.32, r * 0.84], [k - len * 0.18, r * 0.94], [k, r * 0.94],
        [k, r * 0.94 - wall], [k - len * 0.18, r * 0.94 - wall],
        [k - len * 0.32, r * 0.84 - wall], [f + len * 0.30, r * 0.86 - wall],
        [f + len * 0.16, r - wall], [f, r - wall], [f, r],
      ], 24, 0.5), { pos: [0, cy, 0] }), mat);
      // Glass, set inside each window so the rims shadow onto it.
      b.add(xf(disc(r - wall * 1.05, 0, -1, 22), { pos: [0, cy, f + 0.0022] }), 'lens');
      b.add(xf(disc(r * 0.94 - wall * 1.05, 0, 1, 22), { pos: [0, cy, k - 0.0022] }), 'lens');
      // Hood over the front window.
      b.add(xf(chamferBox(r * 1.9, 0.0032, len * 0.30, 0.0008),
        { pos: [0, cy + r * 1.00, mountZ - len * 0.32] }), mat);
      // Brightness dial, battery cap and a bridge back to the mount.
      b.add(xf(lathe([[0, 0.0064], [0.006, 0.0064], [0.007, 0.0052]], 12),
        { pos: [r * 0.84, cy, mountZ + len * 0.10], rot: [0, Math.PI / 2, 0] }), mat);
      b.add(xf(lathe([[0, 0.0074], [0.005, 0.0074], [0.006, 0.0060]], 12),
        { pos: [0, cy + r * 0.84, mountZ + len * 0.18], rot: [-Math.PI / 2, 0, 0] }), mat);
      b.add(xf(chamferBox(0.020, h + r * 0.7, len * 0.42, 0.0010),
        { pos: [0, railTop + (h + r * 0.7) * 0.5, mountZ + len * 0.02] }), 'alu');
      ctx.sight.set(0, cy, k - 0.004);
      mark('dot', f + 0.004, cy, (r - wall) * 0.86, 44.0, 0xff3a12, 6.5);
      ctx.opticAxisY = cy;
      break;
    }
    case 'holo': {
      const len = att.build.length ?? 0.086;
      const r = att.build.radius ?? 0.023;
      const h = (att.build.sightHeight ?? 0.040) - r * 0.55;
      const hb = Math.max(0.004, h);
      mount(0.030, len * 0.42, hb, mountZ + len * 0.30);
      const cy = railTop + hb + r * 0.55;
      // An open rectangular hood, four plates, with the electronics housing
      // slung *forward and low* — clear of the sight line. The previous build
      // put a solid block across the rear of the window, so aiming the
      // holographic sight meant staring at the back of a grey box.
      const hw = r * 0.86, hh = r * 0.62;
      const zF = mountZ - len * 0.40, zR = mountZ + len * 0.46;
      const hoodLen = zR - zF;
      const hoodZ = (zF + zR) * 0.5;
      for (const s of [1, -1]) {
        b.add(xf(chamferBox(0.0032, hh * 2.1, hoodLen, 0.0009),
          { pos: [s * hw, cy, hoodZ] }), mat);
      }
      b.add(xf(chamferBox(hw * 2.1, 0.0034, hoodLen, 0.0009), { pos: [0, cy + hh, hoodZ] }), mat);
      b.add(xf(chamferBox(hw * 2.1, 0.0034, hoodLen * 0.55, 0.0009),
        { pos: [0, cy - hh, hoodZ + hoodLen * 0.22] }), mat);
      // Housing: laser module and battery, under the optical path at the front.
      b.add(xf(chamferBox(hw * 2.0, r * 0.62, len * 0.40, 0.0014),
        { pos: [0, cy - hh - r * 0.30, mountZ - len * 0.26] }), mat);
      b.add(xf(chamferBox(hw * 1.5, r * 0.34, len * 0.16, 0.0010),
        { pos: [0, cy - hh - r * 0.62, mountZ - len * 0.30] }), 'alu');
      // Rear glass: what the hologram is projected onto.
      b.add(xf(chamferBox(hw * 1.9, hh * 1.85, 0.0022, 0.0005),
        { pos: [0, cy, mountZ + len * 0.28] }), 'lens');
      // Buttons on the left of the housing.
      for (const s of [0, 1]) {
        b.add(xf(chamferBox(0.0055, 0.0050, 0.0075, 0.0008),
          { pos: [-hw - 0.004, cy - hh - r * 0.30, mountZ - len * 0.16 + s * 0.010] }), mat);
      }
      ctx.sight.set(0, cy, mountZ + len * 0.46);
      mark('holoRing', mountZ + len * 0.26, cy, hh * 0.92, 38, 0xff2a10, 5.0);
      ctx.opticAxisY = cy;
      break;
    }
    case 'acog': {
      const len = att.build.length ?? 0.135;
      const r = att.build.radius ?? 0.024;
      const h = (att.build.sightHeight ?? 0.048) - r;
      mount(0.030, 0.038, Math.max(0.004, h), mountZ + 0.004);
      const cy = railTop + Math.max(0.004, h) + r;
      b.add(xf(lathe([
        [-len * 0.5, r * 1.10], [-len * 0.44, r * 1.10], [-len * 0.40, r * 0.86],
        [-len * 0.05, r * 0.80], [0.0, r * 0.92], [len * 0.22, r * 0.92],
        [len * 0.26, r * 0.70], [len * 0.44, r * 0.66], [len * 0.48, r * 0.86], [len * 0.5, r * 0.86],
      ], 22), { pos: [0, cy, mountZ] }), mat);
      // Ribbed body section for grip.
      for (let i = 0; i < 6; i++) {
        b.add(xf(lathe([[0, r * 0.84], [0.0022, r * 0.90], [0.0044, r * 0.84]], 18),
          { pos: [0, cy, mountZ - len * 0.30 + i * 0.006] }), mat);
      }
      // Objective and ocular glass, with a killflash honeycomb hint.
      b.add(xf(disc(r * 0.86, 0, -1, 22), { pos: [0, cy, mountZ - len * 0.49] }), 'lens');
      b.add(xf(disc(r * 0.62, 0, 1, 20), { pos: [0, cy, mountZ + len * 0.47] }), 'lens');
      // Elevation and windage turrets.
      b.add(xf(lathe([[0, 0.0075], [0.006, 0.0075], [0.007, 0.0062]], 12),
        { pos: [0, cy + r * 0.88, mountZ - len * 0.12], rot: [-Math.PI / 2, 0, 0] }), mat);
      b.add(xf(lathe([[0, 0.0075], [0.006, 0.0075], [0.007, 0.0062]], 12),
        { pos: [r * 0.88, cy, mountZ - len * 0.12], rot: [0, Math.PI / 2, 0] }), mat);
      // Fibre-optic light pipe along the top.
      b.add(xf(lathe([[-len * 0.16, 0.0016], [len * 0.10, 0.0016]], 8),
        { pos: [0, cy + r * 1.02, mountZ - len * 0.06] }), 'brass');
      ctx.sight.set(0, cy, mountZ + len * 0.47);
      // 4× magnification: the chevron subtends a quarter of the angle it would
      // at 1×, which is why a magnified reticle looks so much finer.
      mark('chevron', mountZ - len * 0.44, cy, r * 0.80, 96, 0xff3a14, 2.4, 'etched');
      ctx.opticAxisY = cy;
      break;
    }
    case 'sniperScope': {
      const len = att.build.length ?? 0.290;
      const r = att.build.radius ?? 0.028;
      const h = (att.build.sightHeight ?? 0.056) - r;
      // Two ring mounts.
      for (const z of [mountZ - len * 0.22, mountZ + len * 0.16]) {
        b.add(xf(chamferBox(0.024, Math.max(0.004, h), 0.020, 0.0012),
          { pos: [0, railTop + Math.max(0.004, h) / 2, z] }), 'alu');
        b.add(xf(torusZ(r * 0.72, 0.0042, 18, 8), { pos: [0, railTop + Math.max(0.004, h) + r * 0.72, z] }), 'alu');
        b.add(xf(hexHead(0.0026, 0.0018), { pos: [r * 0.55, railTop + Math.max(0.004, h) + r * 1.10, z], rot: [0, 0, 0.5] }), 'alu');
      }
      const cy = railTop + Math.max(0.004, h) + r * 0.72;
      b.add(xf(lathe([
        [-len * 0.50, r], [-len * 0.40, r], [-len * 0.36, r * 0.72],
        [len * 0.05, r * 0.68], [len * 0.10, r * 0.80], [len * 0.24, r * 0.80],
        [len * 0.28, r * 0.66], [len * 0.42, r * 0.64], [len * 0.46, r * 0.86], [len * 0.50, r * 0.86],
      ], 24), { pos: [0, cy, mountZ] }), mat);
      // Magnification ring.
      for (let i = 0; i < 8; i++) {
        b.add(xf(lathe([[0, r * 0.82], [0.0018, r * 0.88], [0.0036, r * 0.82]], 20),
          { pos: [0, cy, mountZ + len * 0.12 + i * 0.005] }), mat);
      }
      b.add(xf(disc(r * 0.94, 0, -1, 24), { pos: [0, cy, mountZ - len * 0.49] }), 'lens');
      b.add(xf(disc(r * 0.60, 0, 1, 20), { pos: [0, cy, mountZ + len * 0.485] }), 'lens');
      // Turrets with click marks.
      b.add(xf(lathe([[0, 0.0090], [0.010, 0.0090], [0.011, 0.0074]], 14),
        { pos: [0, cy + r * 0.70, mountZ - len * 0.02], rot: [-Math.PI / 2, 0, 0] }), mat);
      b.add(xf(lathe([[0, 0.0090], [0.010, 0.0090], [0.011, 0.0074]], 14),
        { pos: [r * 0.70, cy, mountZ - len * 0.02], rot: [0, Math.PI / 2, 0] }), mat);
      b.add(xf(lathe([[0, 0.0075], [0.008, 0.0075]], 12),
        { pos: [-r * 0.70, cy, mountZ - len * 0.02], rot: [0, -Math.PI / 2, 0] }), mat);
      ctx.sight.set(0, cy, mountZ + len * 0.485);
      // 9×: an etched duplex, black on the image the objective forms.
      mark('mildot', mountZ - len * 0.45, cy, r * 0.88, 170, 0x080604, 1.0, 'etched');
      ctx.opticAxisY = cy;
      break;
    }
    default:
      break;
  }

  b.use('receiver');
}

/* ---------------------------------------------------- muzzle devices -- */

export function muzzleDevice(ctx: BuildCtx, att: AttachmentDef | undefined, muzzleZ: number, barrelR: number): number {
  const { b } = ctx;
  b.part('receiver');
  const mat: MaterialKey = att?.build.material ?? 'phosphate';

  if (!att) {
    // A plain thread protector so the barrel never ends in a bare tube.
    const len = 0.020;
    b.add(xf(lathe([
      [0, barrelR * 1.20], [len * 0.8, barrelR * 1.20], [len, barrelR * 1.05],
    ], 18), { pos: [0, 0, muzzleZ - len] }), 'phosphate');
    b.add(xf(pipeZ(barrelR * 1.05, barrelR * 0.55, 0.006, 18), { pos: [0, 0, muzzleZ - len + 0.002] }), 'phosphate');
    return muzzleZ - len;
  }

  const len = att.build.length ?? 0.05;
  const r = att.build.radius ?? barrelR * 1.6;

  switch (att.build.kind) {
    case 'suppressor': {
      b.add(xf(lathe([
        [0, barrelR * 1.35], [-0.010, barrelR * 1.35], [-0.012, r],
        [-len + 0.012, r], [-len + 0.008, r * 0.90], [-len, r * 0.90],
      ], 24), { pos: [0, 0, muzzleZ] }), mat);
      // Machined grip flats near the rear.
      for (let i = 0; i < 5; i++) {
        b.add(xf(lathe([[0, r * 0.99], [0.0028, r * 1.02], [0.0056, r * 0.99]], 22),
          { pos: [0, 0, muzzleZ - 0.020 - i * 0.008] }), mat);
      }
      b.add(xf(pipeZ(r * 0.90, r * 0.34, 0.010, 22), { pos: [0, 0, muzzleZ - len + 0.004] }), mat);
      return muzzleZ - len;
    }
    case 'compensator': {
      b.add(xf(lathe([
        [0, barrelR * 1.25], [-0.008, barrelR * 1.25], [-0.010, r],
        [-len + 0.006, r], [-len, r * 0.92],
      ], 20), { pos: [0, 0, muzzleZ] }), mat);
      // Top ports.
      for (let i = 0; i < 3; i++) {
        b.add(xf(chamferBox(0.008, 0.004, 0.0055, 0.0006),
          { pos: [0, r * 0.86, muzzleZ - 0.016 - i * 0.011] }), mat);
      }
      b.add(xf(pipeZ(r * 0.92, r * 0.42, 0.008, 20), { pos: [0, 0, muzzleZ - len + 0.003] }), mat);
      return muzzleZ - len;
    }
    case 'brake': {
      b.add(xf(lathe([
        [0, barrelR * 1.3], [-0.008, barrelR * 1.3], [-0.010, r * 0.8],
        [-len * 0.35, r * 0.8], [-len * 0.4, r], [-len + 0.004, r], [-len, r * 0.9],
      ], 20), { pos: [0, 0, muzzleZ] }), mat);
      for (const s of [1, -1]) {
        for (let i = 0; i < 2; i++) {
          b.add(xf(chamferBox(0.0055, 0.010, 0.009, 0.0008),
            { pos: [s * r * 0.82, 0, muzzleZ - len * 0.5 - i * 0.014] }), mat);
        }
      }
      b.add(xf(pipeZ(r * 0.9, r * 0.44, 0.008, 20), { pos: [0, 0, muzzleZ - len + 0.003] }), mat);
      return muzzleZ - len;
    }
    case 'flashHider':
    default: {
      b.add(xf(lathe([
        [0, barrelR * 1.25], [-0.008, barrelR * 1.25], [-0.010, r * 0.78],
        [-len * 0.45, r * 0.78], [-len * 0.5, r], [-len + 0.003, r], [-len, r * 0.86],
      ], 20), { pos: [0, 0, muzzleZ] }), mat);
      // Prong slots.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const g = chamferBox(0.0028, r * 0.55, len * 0.42, 0.0004);
        xf(g, { pos: [0, r * 0.75, 0] });
        xf(g, { rot: [0, 0, a] });
        xf(g, { pos: [0, 0, muzzleZ - len * 0.72] });
        b.add(g, mat);
      }
      b.add(xf(pipeZ(r * 0.86, r * 0.46, 0.008, 20), { pos: [0, 0, muzzleZ - len + 0.003] }), mat);
      return muzzleZ - len;
    }
  }
}

/* ------------------------------------------------------- underbarrel -- */

export function underbarrel(ctx: BuildCtx, att: AttachmentDef, z: number, y: number): void {
  const { b } = ctx;
  const mat: MaterialKey = att.build.material ?? 'polymer';
  b.part('receiver');

  switch (att.build.kind) {
    case 'foregrip': {
      const len = att.build.length ?? 0.088;
      const r = att.build.radius ?? 0.0135;
      b.add(xf(chamferBox(0.020, 0.008, 0.026, 0.0012), { pos: [0, y - 0.004, z] }), mat);
      b.add(loft([
        { at: [0, y - 0.008, z], w: r, h: r, sq: 5 },
        { at: [0, y - 0.008 - len * 0.55, z - 0.002], w: r * 0.92, h: r * 0.92, sq: 5 },
        { at: [0, y - 0.008 - len, z - 0.004], w: r * 1.05, h: r * 1.05, sq: 5 },
      ], 14), mat);
      for (let i = 0; i < 5; i++) {
        b.add(xf(torusZ(r * 0.95, 0.0013, 14, 6),
          { pos: [0, y - 0.020 - i * 0.012, z - 0.002], rot: [Math.PI / 2, 0, 0] }), 'rubber');
      }
      break;
    }
    case 'angledGrip': {
      const len = att.build.length ?? 0.078;
      const r = att.build.radius ?? 0.014;
      b.add(xf(chamferBox(0.020, 0.008, 0.030, 0.0012), { pos: [0, y - 0.004, z] }), mat);
      b.add(loft([
        { at: [0, y - 0.008, z + 0.004], w: r * 1.05, h: r * 0.8, sq: 5 },
        { at: [0, y - 0.008 - len * 0.55, z - len * 0.42], w: r * 0.95, h: r * 0.72, sq: 5 },
        { at: [0, y - 0.008 - len * 0.9, z - len * 0.75], w: r * 1.0, h: r * 0.76, sq: 5 },
      ], 14), mat);
      break;
    }
    case 'bipod': {
      const len = att.build.length ?? 0.150;
      b.add(xf(chamferBox(0.026, 0.014, 0.034, 0.0014), { pos: [0, y - 0.008, z] }), ctx.body);
      b.part('bipod', [0, y - 0.012, z]);
      for (const s of [1, -1]) {
        b.add(xf(lathe([[0, 0.0042], [len, 0.0034]], 10),
          { pos: [s * 0.010, y - 0.012, z], rot: [-0.28, 0, -s * 0.18] }), ctx.body);
        b.add(xf(ball(0.0055, 10), {
          pos: [
            s * (0.010 + Math.sin(0.18) * len),
            y - 0.012 - Math.cos(0.28) * len * 0.98,
            z + Math.sin(0.28) * len,
          ],
        }), 'rubber');
      }
      b.use('receiver');
      break;
    }
    case 'laser': {
      const len = att.build.length ?? 0.048;
      const r = att.build.radius ?? 0.010;
      b.add(xf(chamferBox(0.018, 0.010, len, 0.0012), { pos: [0, y - 0.006, z] }), 'alu');
      b.add(xf(lathe([[-len * 0.4, r], [len * 0.42, r], [len * 0.5, r * 0.8]], 14),
        { pos: [0.014, y - 0.006, z] }), 'alu');
      b.add(xf(disc(r * 0.7, 0, -1, 12), { pos: [0.014, y - 0.006, z - len * 0.5] }), 'glass');
      b.add(xf(chamferBox(0.006, 0.005, 0.007, 0.0008), { pos: [0, y - 0.012, z + len * 0.3] }), 'rubber');
      break;
    }
    default:
      break;
  }
  b.use('receiver');
}

/* ------------------------------------------- reciprocating components -- */

/** Charging handle at the rear of the upper — cycles on every shot. */
export function chargingHandle(ctx: BuildCtx, z: number, y: number, side: 'top' | 'left' | 'right' = 'top'): void {
  const { b, m } = ctx;
  b.part('charging', [0, y, z]);
  if (side === 'top') {
    b.add(xf(chamferBox(0.030, 0.0075, 0.030, 0.0010), { pos: [0, y, z] }), ctx.body);
    b.add(xf(chamferBox(0.0075, 0.010, 0.026, 0.0010), { pos: [-0.019, y, z - 0.002] }), ctx.body);
    b.add(xf(chamferBox(0.014, 0.0060, 0.010, 0.0009), { pos: [-0.026, y, z - 0.006] }), ctx.body);
  } else {
    const s = side === 'right' ? 1 : -1;
    b.add(xf(lathe([[0, 0.0060], [0.014, 0.0060], [0.018, 0.0090], [0.021, 0.0090]], 14),
      { pos: [s * m.receiver[0] * 0.45, y, z], rot: [0, (s * Math.PI) / 2, 0] }), ctx.body);
    b.add(xf(disc(0.0090, 0, 1, 14),
      { pos: [s * (m.receiver[0] * 0.45 + 0.021), y, z], rot: [0, (s * Math.PI) / 2, 0] }), ctx.body);
  }
  b.use('receiver');
}

/** Bolt carrier visible through the ejection port, plus a rear buffer face. */
export function boltCarrier(ctx: BuildCtx, z: number, y: number): void {
  const { b, m } = ctx;
  b.part('bolt', [0, y, z]);
  b.add(xf(lathe([
    [-0.050, m.barrelRadius * 1.5], [0.032, m.barrelRadius * 1.5],
    [0.034, m.barrelRadius * 1.2], [0.048, m.barrelRadius * 1.2],
  ], 16), { pos: [0, y, z] }), 'blued');
  b.add(xf(chamferBox(0.0055, 0.010, 0.024, 0.0008), { pos: [m.receiver[0] * 0.36, y, z + 0.010] }), 'blued');
  b.use('receiver');
}

/** Shotgun / pump slide, or an LMG feed-tray cover. */
export function topCover(ctx: BuildCtx, z: number, len: number): void {
  const { b, m } = ctx;
  const y = ctx.topY - 0.004;
  b.part('cover', [0, y, z + len * 0.5]);
  b.add(loft([
    { at: [0, y, z + len * 0.5], w: m.receiver[0] * 0.48, h: 0.010, sq: 5 },
    { at: [0, y + 0.002, z], w: m.receiver[0] * 0.47, h: 0.011, sq: 5 },
    { at: [0, y, z - len * 0.5], w: m.receiver[0] * 0.44, h: 0.009, sq: 5 },
  ], 12), ctx.body);
  b.add(xf(chamferBox(0.012, 0.006, 0.020, 0.0009), { pos: [0, y + 0.008, z - len * 0.34] }), ctx.body);
  b.use('receiver');
}

/** Belt of linked ammunition hanging from an LMG feed tray. */
export function ammoBelt(ctx: BuildCtx, from: readonly [number, number, number], links = 9): void {
  const { b } = ctx;
  b.part('belt', [from[0], from[1], from[2]]);
  for (let i = 0; i < links; i++) {
    const t = i / (links - 1);
    const sag = Math.sin(t * Math.PI) * 0.010;
    const p: [number, number, number] = [
      from[0] - 0.004 - t * 0.010,
      from[1] - t * 0.052 - sag,
      from[2] + t * 0.026,
    ];
    b.add(xf(lathe([[-0.0115, 0.0038], [0.004, 0.0042], [0.008, 0.0030], [0.0115, 0.0022]], 10),
      { pos: p, rot: [0.15 + t * 0.25, Math.PI / 2, 0] }), 'brass');
    b.add(xf(chamferBox(0.0075, 0.0055, 0.0035, 0.0005), { pos: [p[0], p[1], p[2] - 0.0035] }), 'phosphate');
  }
  b.use('receiver');
}
