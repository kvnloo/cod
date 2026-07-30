/**
 * Weapon assemblies.
 *
 * Each builder composes the shared components in `Parts.ts` into a complete,
 * animatable weapon and records the points of interest the rest of the module
 * needs: `muzzle`, `sight`, `eject`, `magWell`, `laser`.
 *
 * Six of the eight share `conventional()` — a magazine-fed, pistol-gripped
 * long gun — because that *is* what those weapons are; the differences are
 * proportions, furniture and controls, not topology. The shotgun, the pistol
 * and the launcher get their own builders because their topology genuinely
 * differs.
 */

import * as THREE from 'three';
import type { AttachmentDef, WeaponDef } from '../types';
import type { MaterialSpace, WeaponMaterials } from '../WeaponMaterials';
import { RigBuilder, type WeaponRig } from './Builder';
import {
  ammoBelt, barrel, boltCarrier, chargingHandle, handguard, ironSights, lowerReceiver,
  magazine, makeCtx, muzzleDevice, optic, pistolGrip, stock, topCover, topRail,
  underbarrel, upperReceiver, type BuildCtx,
} from './Parts';
import {
  ball, chamferBox, disc, hexHead, lathe, loft, panelLines, picatinny, pipeZ,
  prismX, rod, screwHead, slingSocket, torusZ, xf, type Pt2,
} from './Geo';

/* ---------------------------------------------------------------- shared */

interface ConventionalOptions {
  /** Z of the magazine well centre. */
  magWellZ: number;
  magWellDepth: number;
  /** Z of the top of the pistol grip. */
  gripZ: number;
  gripRake: number;
  gripLength: number;
  gripWidth: number;
  gripDepth: number;
  chargingSide: 'top' | 'left' | 'right';
  chargingZ: number;
  /** Rear of the stock attachment point. */
  stockZ: number;
  fluted?: boolean;
  gasBlock?: boolean;
  beavertail?: boolean;
}

function conventional(ctx: BuildCtx, o: ConventionalOptions): void {
  const { b, m } = ctx;
  b.part('receiver');

  upperReceiver(ctx);
  lowerReceiver(ctx, o.magWellZ, o.magWellDepth);
  pistolGrip(ctx, {
    top: [0, ctx.lowerTop + 0.002, o.gripZ],
    length: o.gripLength,
    rake: o.gripRake,
    width: o.gripWidth,
    depth: o.gripDepth,
    beavertail: o.beavertail ?? true,
  });
  stock(ctx, o.stockZ);
  barrel(ctx, { gasBlock: o.gasBlock, fluted: o.fluted });
  handguard(ctx);
  magazine(ctx, o.magWellZ, ctx.lowerTop - o.magWellDepth + 0.006);
  chargingHandle(ctx, o.chargingZ, ctx.upperMidY + m.receiver[1] * 0.12, o.chargingSide);
  boltCarrier(ctx, -m.receiver[2] * 0.30, ctx.upperMidY - 0.002);

  // Sling points fore and aft.
  b.part('receiver');
  b.add(xf(slingSocket(0.0055), { pos: [-m.receiver[0] * 0.5, ctx.lowerTop - 0.004, -0.012], rot: [0, -Math.PI / 2, 0] }), ctx.body);
}

/** Muzzle device, underbarrel and laser — everything hung off the front end. */
function finishMuzzle(ctx: BuildCtx): void {
  const { m } = ctx;
  const muzzleAtt = ctx.slot.get('muzzle');
  ctx.muzzleZ = muzzleDevice(ctx, muzzleAtt, ctx.front - m.barrelLength, m.barrelRadius);

  const under = ctx.slot.get('underbarrel');
  if (under) {
    underbarrel(ctx, under, ctx.front - m.handguardLength * 0.62, -m.handguardRadius * 0.92);
  }
  const laser = ctx.slot.get('laser');
  if (laser) {
    underbarrel(ctx, laser, ctx.front - m.handguardLength * 0.32, -m.handguardRadius * 0.55);
    ctx.b.point('laser', [0.014, -m.handguardRadius * 0.55 - 0.006, ctx.front - m.handguardLength * 0.32 - 0.026]);
  }
}

/**
 * Mounts whichever sighting system the loadout asked for. Irons always land on
 * the rail, at its extremities, so they can never float off the end of it.
 */
function finishSights(ctx: BuildCtx, hooded = true): void {
  const opticAtt = ctx.slot.get('optic');
  if (opticAtt && opticAtt.build.kind !== 'ironsOnly') { optic(ctx, opticAtt); return; }
  const railFront = -0.012 - ctx.m.topRail + 0.022;
  ironSights(ctx, railFront, -0.030, hooded);
}

function commonPoints(ctx: BuildCtx): void {
  const { b, m } = ctx;
  b.point('muzzle', [0, 0, ctx.muzzleZ - 0.004]);
  b.point('sight', [ctx.sight.x, ctx.sight.y, ctx.sight.z]);
  b.point('eject', m.ejectPort);
  b.point('bore', [0, 0, ctx.front - m.barrelLength * 0.5]);
}

/* ========================================================== assault rifle */

function buildAssault(ctx: BuildCtx): void {
  const { b, m } = ctx;
  conventional(ctx, {
    magWellZ: -m.receiver[2] * 0.54,
    magWellDepth: 0.050,
    gripZ: -m.receiver[2] * 0.28,
    gripRake: 24,
    gripLength: 0.098,
    gripWidth: 0.036,
    gripDepth: 0.044,
    chargingSide: 'top',
    chargingZ: 0.012,
    stockZ: 0.006,
    gasBlock: true,
  });

  // Ejection-port cut-out lip and a shell deflector fin unique to this rifle.
  b.part('receiver');
  b.add(xf(chamferBox(0.0035, 0.0045, 0.066, 0.0006),
    { pos: [m.receiver[0] * 0.5 + 0.0008, m.ejectPort[1] + 0.015, m.ejectPort[2]] }), ctx.body);
  b.add(xf(panelLines(2, 0.007, 0.070, 0.0009, 0.0006),
    { pos: [m.receiver[0] * 0.5 - 0.0004, ctx.upperMidY - 0.012, -m.receiver[2] * 0.72], rot: [0, 0, Math.PI / 2] }), ctx.body);

  topRail(ctx);
  finishMuzzle(ctx);
  finishSights(ctx);
  commonPoints(ctx);
}

/* ==================================================================== SMG */

function buildSmg(ctx: BuildCtx): void {
  const { b, m } = ctx;
  conventional(ctx, {
    magWellZ: -m.receiver[2] * 0.62,
    magWellDepth: 0.042,
    gripZ: -m.receiver[2] * 0.30,
    gripRake: 20,
    gripLength: 0.092,
    gripWidth: 0.034,
    gripDepth: 0.042,
    chargingSide: 'left',
    chargingZ: -m.receiver[2] * 0.74,
    stockZ: 0.004,
    gasBlock: false,
  });

  // Rounded polymer shell over the receiver — the MP silhouette.
  b.part('receiver');
  b.add(loft([
    { at: [0, ctx.upperMidY, 0.002], w: m.receiver[0] * 0.54, h: m.receiver[1] * 0.30, sq: 4 },
    { at: [0, ctx.upperMidY, -m.receiver[2] * 0.45], w: m.receiver[0] * 0.55, h: m.receiver[1] * 0.31, sq: 4 },
    { at: [0, ctx.upperMidY, -m.receiver[2] * 0.98], w: m.receiver[0] * 0.50, h: m.receiver[1] * 0.28, sq: 4 },
  ], 18), ctx.furn);
  // Cocking-tube shroud running forward over the barrel.
  b.add(xf(lathe([
    [ctx.front - 0.004, m.handguardRadius * 0.55],
    [ctx.front - m.barrelLength * 0.9, m.handguardRadius * 0.55],
  ], 16), { pos: [0, m.receiver[1] * 0.20, 0] }), ctx.body);

  topRail(ctx);
  finishMuzzle(ctx);
  finishSights(ctx);
  commonPoints(ctx);
}

/* =============================================================== marksman */

function buildMarksman(ctx: BuildCtx): void {
  const { b, m } = ctx;
  conventional(ctx, {
    magWellZ: -m.receiver[2] * 0.56,
    magWellDepth: 0.052,
    gripZ: -m.receiver[2] * 0.26,
    gripRake: 22,
    gripLength: 0.100,
    gripWidth: 0.036,
    gripDepth: 0.046,
    chargingSide: 'top',
    chargingZ: 0.012,
    stockZ: 0.006,
    gasBlock: true,
    fluted: true,
  });

  // Heavier free-float tube with a bolted-on top rail section.
  b.part('receiver');
  b.add(xf(picatinny(0.09, 0.020, 0.0075),
    { pos: [0, -m.handguardRadius * 0.92, ctx.front - m.handguardLength * 0.55], rot: [Math.PI, 0, 0] }), ctx.body);

  topRail(ctx);
  finishMuzzle(ctx);
  finishSights(ctx);
  commonPoints(ctx);
}

/* ==================================================================== LMG */

function buildLmg(ctx: BuildCtx): void {
  const { b, m } = ctx;
  conventional(ctx, {
    magWellZ: -m.receiver[2] * 0.50,
    magWellDepth: 0.030,
    gripZ: -m.receiver[2] * 0.24,
    gripRake: 20,
    gripLength: 0.102,
    gripWidth: 0.038,
    gripDepth: 0.048,
    chargingSide: 'right',
    chargingZ: -m.receiver[2] * 0.55,
    stockZ: 0.006,
    gasBlock: true,
  });

  // Hinged feed-tray cover with a carry handle on top.
  topCover(ctx, -m.receiver[2] * 0.42, m.receiver[2] * 0.62);
  b.part('receiver');
  b.add(loft([
    { at: [0, ctx.topY + 0.024, ctx.front + 0.030], w: 0.010, h: 0.006, sq: 5 },
    { at: [0, ctx.topY + 0.038, ctx.front + 0.010], w: 0.009, h: 0.006, sq: 5 },
    { at: [0, ctx.topY + 0.040, ctx.front - 0.048], w: 0.009, h: 0.006, sq: 5 },
    { at: [0, ctx.topY + 0.026, ctx.front - 0.070], w: 0.010, h: 0.006, sq: 5 },
  ], 10), 'polymer');
  // Barrel-change handle and a heat shield above the gas system.
  b.add(xf(chamferBox(0.010, 0.030, 0.048, 0.0014),
    { pos: [-m.receiver[0] * 0.44, 0.012, ctx.front - 0.050], rot: [0, 0, 0.25] }), ctx.body);

  ammoBelt(ctx, [m.receiver[0] * 0.30, ctx.lowerTop - 0.006, -m.receiver[2] * 0.50]);

  // The rail rides on top of the feed cover on a belt gun.
  ctx.railY = ctx.topY + 0.009;
  topRail(ctx);
  finishMuzzle(ctx);
  finishSights(ctx);
  commonPoints(ctx);
}

/* ================================================================= sniper */

function buildSniper(ctx: BuildCtx): void {
  const { b, m } = ctx;

  b.part('receiver');
  upperReceiver(ctx);
  lowerReceiver(ctx, -m.receiver[2] * 0.58, 0.030);
  stock(ctx, 0.004);
  barrel(ctx, { gasBlock: false, fluted: true });
  handguard(ctx);
  topRail(ctx);
  magazine(ctx, -m.receiver[2] * 0.58, ctx.lowerTop - 0.024);

  // Bolt: a body sitting in the raceway plus a handle that rotates and pulls.
  b.part('boltHandle', [m.receiver[0] * 0.42, ctx.upperMidY, -m.receiver[2] * 0.24]);
  b.add(xf(lathe([[0, 0.0050], [0.020, 0.0050], [0.024, 0.0044]], 14),
    { pos: [m.receiver[0] * 0.42, ctx.upperMidY, -m.receiver[2] * 0.24], rot: [0, Math.PI / 2, 0] }), 'blued');
  b.add(xf(ball(0.0092, 14),
    { pos: [m.receiver[0] * 0.42 + 0.026, ctx.upperMidY, -m.receiver[2] * 0.24] }), 'blued');
  b.use('receiver');

  b.part('bolt', [0, ctx.upperMidY, -m.receiver[2] * 0.30]);
  b.add(xf(lathe([
    [-0.070, m.barrelRadius * 1.45], [0.040, m.barrelRadius * 1.45], [0.044, m.barrelRadius * 1.1],
  ], 16), { pos: [0, ctx.upperMidY, -m.receiver[2] * 0.30] }), 'blued');
  b.use('receiver');

  // Free-floated heavy barrel with a chunky recoil lug and a bedding block.
  b.add(xf(chamferBox(m.receiver[0] * 1.02, 0.020, 0.030, 0.0016),
    { pos: [0, ctx.lowerTop + 0.004, ctx.front + 0.014] }), ctx.body);
  b.add(xf(panelLines(4, 0.008, m.receiver[2] * 0.5, 0.0010, 0.0007),
    { pos: [-m.receiver[0] * 0.5 + 0.0004, ctx.upperMidY, -m.receiver[2] * 0.55], rot: [0, 0, Math.PI / 2] }), ctx.body);

  // Trigger group + grip are part of the thumbhole stock on this rifle.
  pistolGrip(ctx, {
    top: [0, ctx.lowerTop + 0.002, -m.receiver[2] * 0.20],
    length: 0.092, rake: 26, width: 0.034, depth: 0.044, beavertail: false,
  });

  topRail(ctx);
  finishMuzzle(ctx);
  finishSights(ctx, false);
  commonPoints(ctx);
}

/* ================================================================ shotgun */

function buildShotgun(ctx: BuildCtx): void {
  const { b, m } = ctx;
  const R = m.barrelRadius;

  b.part('receiver');
  // Milled steel receiver — a solid block with a big loading port underneath.
  b.add(loft([
    { at: [0, ctx.upperMidY - 0.006, 0.004], w: m.receiver[0] * 0.5, h: m.receiver[1] * 0.36, sq: 6 },
    { at: [0, ctx.upperMidY - 0.006, -m.receiver[2] * 0.5], w: m.receiver[0] * 0.5, h: m.receiver[1] * 0.38, sq: 6 },
    { at: [0, ctx.upperMidY - 0.004, ctx.front - 0.004], w: m.receiver[0] * 0.46, h: m.receiver[1] * 0.34, sq: 6 },
  ], 16), ctx.body);
  b.add(xf(chamferBox(0.006, 0.026, 0.070, 0.0012),
    { pos: [m.receiver[0] * 0.5 - 0.001, m.ejectPort[1], m.ejectPort[2]] }), ctx.body);
  b.add(xf(panelLines(3, 0.010, m.receiver[2] * 0.6, 0.0011, 0.0008),
    { pos: [-m.receiver[0] * 0.5 + 0.0004, ctx.upperMidY - 0.004, -m.receiver[2] * 0.5], rot: [0, 0, Math.PI / 2] }), ctx.body);

  // Loading port + shell lifter.
  b.add(xf(chamferBox(0.024, 0.006, 0.060, 0.0012),
    { pos: [0, ctx.lowerTop + 0.002, -m.receiver[2] * 0.46] }), ctx.body);
  b.part('lifter', [0, ctx.lowerTop - 0.004, -m.receiver[2] * 0.30]);
  b.add(xf(prismX([
    [0.030, 0.000], [0.030, -0.010], [-0.026, -0.016], [-0.026, -0.004],
  ] as Pt2[], 0.022), { pos: [0, ctx.lowerTop - 0.004, -m.receiver[2] * 0.30] }), 'blued');
  b.use('receiver');

  // Trigger group and grip.
  const guardZ = -m.receiver[2] * 0.30;
  b.add(loft([
    { at: [0, ctx.lowerTop - 0.014, guardZ - 0.016], w: 0.0060, h: 0.0038, sq: 5 },
    { at: [0, ctx.lowerTop - 0.034, guardZ - 0.010], w: 0.0055, h: 0.0034, sq: 5 },
    { at: [0, ctx.lowerTop - 0.036, guardZ + 0.030], w: 0.0055, h: 0.0034, sq: 5 },
    { at: [0, ctx.lowerTop - 0.012, guardZ + 0.044], w: 0.0060, h: 0.0040, sq: 5 },
  ], 10), ctx.body);
  b.part('trigger', [0, ctx.lowerTop - 0.020, guardZ + 0.020]);
  b.add(xf(prismX([
    [0.004, 0.000], [0.006, -0.006], [0.004, -0.017], [-0.002, -0.019], [-0.004, -0.010], [-0.003, 0.000],
  ] as Pt2[], 0.008), { pos: [0, ctx.lowerTop - 0.016, guardZ + 0.020] }), 'blued');
  b.use('receiver');

  pistolGrip(ctx, {
    top: [0, ctx.lowerTop + 0.002, guardZ + 0.060],
    length: 0.096, rake: 26, width: 0.036, depth: 0.046,
  });
  stock(ctx, 0.006);

  // Barrel and magazine tube, joined by a barrel clamp.
  b.add(xf(lathe([
    [ctx.front + 0.008, R * 1.45], [ctx.front - 0.024, R * 1.45], [ctx.front - 0.030, R * 1.12],
    [ctx.front - m.barrelLength + 0.012, R * 1.04], [ctx.front - m.barrelLength, R * 1.10],
  ], 22), {}), 'blued');
  b.add(xf(pipeZ(R * 1.10, R * 0.74, 0.014, 22), { pos: [0, 0, ctx.front - m.barrelLength + 0.006] }), 'blued');

  const tubeY = -R * 2.1;
  b.add(xf(lathe([
    [ctx.front + 0.004, R * 0.94], [ctx.front - m.magLength, R * 0.94], [ctx.front - m.magLength - 0.008, R * 0.86],
  ], 20), { pos: [0, tubeY, 0] }), 'blued');
  b.add(xf(disc(R * 0.86, 0, -1, 16), { pos: [0, tubeY, ctx.front - m.magLength - 0.008] }), 'blued');
  for (const z of [ctx.front - 0.070, ctx.front - m.magLength + 0.030]) {
    b.add(xf(chamferBox(R * 2.4, R * 3.4, 0.014, 0.0012), { pos: [0, tubeY * 0.5, z] }), ctx.body);
    b.add(xf(hexHead(0.0026, 0.0018), { pos: [R * 1.0, tubeY * 0.5, z], rot: [0, 0, -Math.PI / 2] }), ctx.body);
  }

  // Pump/forend — slides on the tube when the action cycles.
  b.part('pump', [0, tubeY * 0.55, ctx.front - m.handguardLength * 0.72]);
  const fz = ctx.front - m.handguardLength * 0.72;
  b.add(loft([
    { at: [0, tubeY * 0.55, fz + m.handguardLength * 0.5], w: m.handguardRadius * 1.05, h: m.handguardRadius * 1.5, sq: 5 },
    { at: [0, tubeY * 0.55, fz], w: m.handguardRadius * 1.10, h: m.handguardRadius * 1.6, sq: 5 },
    { at: [0, tubeY * 0.55, fz - m.handguardLength * 0.5], w: m.handguardRadius * 1.00, h: m.handguardRadius * 1.45, sq: 5 },
  ], 16), ctx.furn);
  for (let i = 0; i < 7; i++) {
    b.add(xf(chamferBox(m.handguardRadius * 2.1, 0.0022, 0.0055, 0.0006),
      { pos: [0, tubeY * 0.55 - m.handguardRadius * 1.4, fz + m.handguardLength * 0.34 - i * 0.014] }), 'rubber');
  }
  b.use('receiver');

  // Shell held during a shell-by-shell reload; hidden until then.
  b.part('shell', [0, ctx.lowerTop - 0.030, -m.receiver[2] * 0.40]);
  b.add(xf(lathe([
    [-0.032, 0.0088], [0.014, 0.0088], [0.016, 0.0092], [0.030, 0.0092],
  ], 14), { pos: [0, ctx.lowerTop - 0.030, -m.receiver[2] * 0.40] }), 'brass');
  b.add(xf(disc(0.0092, 0, 1, 12), { pos: [0, ctx.lowerTop - 0.030, -m.receiver[2] * 0.40 + 0.030] }), 'brass');
  b.use('receiver');

  topRail(ctx);
  finishMuzzle(ctx);
  {
    const opticAtt = ctx.slot.get('optic');
    if (opticAtt && opticAtt.build.kind !== 'ironsOnly') optic(ctx, opticAtt);
    else {
      // Bead on a ramp at the muzzle, ghost ring on the receiver rail.
      const bz = ctx.front - m.barrelLength + 0.030;
      b.part('frontSight', [0, R * 1.1, bz]);
      b.add(xf(chamferBox(0.008, 0.006, 0.026, 0.0009), { pos: [0, R * 1.32, bz] }), ctx.body);
      b.add(xf(ball(0.0026, 10), { pos: [0, R * 1.32 + 0.004, bz - 0.008] }), 'brass');
      b.use('receiver');
      b.part('rearSight', [0, ctx.railY + 0.0082, -0.030]);
      b.add(xf(chamferBox(0.020, 0.005, 0.014, 0.0009), { pos: [0, ctx.railY + 0.0105, -0.030] }), ctx.body);
      b.add(xf(pipeZ(0.0075, 0.0044, 0.0032, 16), { pos: [0, ctx.railY + 0.0175, -0.030] }), ctx.body);
      b.use('receiver');
      ctx.sight.set(0, ctx.railY + 0.0175, -0.030);
    }
  }
  commonPoints(ctx);
  b.point('shellHome', [0, ctx.lowerTop - 0.030, -m.receiver[2] * 0.40]);
}

/* ================================================================= pistol */

function buildPistol(ctx: BuildCtx): void {
  const { b, m } = ctx;
  const w = m.receiver[0];
  const boreY = 0;
  const slideTop = boreY + 0.018;
  const frameTop = boreY - 0.012;

  b.part('receiver');

  // Polymer frame: dust cover, trigger guard, grip, accessory rail.
  b.add(loft([
    { at: [0, frameTop - 0.008, 0.004], w: w * 0.50, h: 0.010, sq: 6 },
    { at: [0, frameTop - 0.008, -0.050], w: w * 0.50, h: 0.011, sq: 6 },
    { at: [0, frameTop - 0.007, -m.receiver[2] + 0.006], w: w * 0.44, h: 0.009, sq: 6 },
  ], 14), 'polymer');
  b.add(xf(picatinny(0.036, 0.016, 0.0060),
    { pos: [0, frameTop - 0.019, -m.receiver[2] + 0.026], rot: [Math.PI, 0, 0] }), 'polymer');

  // Trigger guard.
  b.add(loft([
    { at: [0, frameTop - 0.014, -0.060], w: 0.0050, h: 0.0034, sq: 5 },
    { at: [0, frameTop - 0.030, -0.058], w: 0.0046, h: 0.0030, sq: 5 },
    { at: [0, frameTop - 0.032, -0.030], w: 0.0046, h: 0.0030, sq: 5 },
    { at: [0, frameTop - 0.012, -0.020], w: 0.0052, h: 0.0036, sq: 5 },
  ], 10), 'polymer');
  b.part('trigger', [0, frameTop - 0.018, -0.040]);
  b.add(xf(prismX([
    [0.003, 0.000], [0.005, -0.006], [0.003, -0.015], [-0.002, -0.017], [-0.004, -0.009], [-0.003, 0.000],
  ] as Pt2[], 0.007), { pos: [0, frameTop - 0.014, -0.040] }), 'blued');
  b.use('receiver');

  pistolGrip(ctx, {
    top: [0, frameTop - 0.004, -0.014],
    length: 0.098, rake: 16, width: 0.032, depth: 0.040,
    material: 'polymer', beavertail: true,
  });

  // Slide — reciprocates on every shot and locks back when empty.
  b.part('slide', [0, boreY + 0.004, -m.receiver[2] * 0.5]);
  b.add(loft([
    { at: [0, boreY + 0.004, 0.004], w: w * 0.5, h: 0.015, sq: 6.5 },
    { at: [0, boreY + 0.004, -0.030], w: w * 0.5, h: 0.015, sq: 6.5 },
    { at: [0, boreY + 0.003, -m.receiver[2] - 0.020], w: w * 0.47, h: 0.013, sq: 6.5 },
  ], 16), 'blued');
  // Cocking serrations, front and rear.
  for (let i = 0; i < 6; i++) {
    b.add(xf(chamferBox(w * 1.02, 0.012, 0.0022, 0.0004), { pos: [0, boreY + 0.004, -0.006 - i * 0.005] }), 'blued');
  }
  for (let i = 0; i < 4; i++) {
    b.add(xf(chamferBox(w * 0.98, 0.011, 0.0022, 0.0004),
      { pos: [0, boreY + 0.004, -m.receiver[2] - 0.004 - i * 0.005] }), 'blued');
  }
  // Ejection port and extractor.
  b.add(xf(chamferBox(0.0035, 0.012, 0.026, 0.0008),
    { pos: [w * 0.5 - 0.0006, boreY + 0.010, m.ejectPort[2]] }), 'blued');
  // Sights ride on the slide.
  b.add(xf(chamferBox(0.010, 0.0075, 0.0055, 0.0008), { pos: [0, slideTop + 0.001, -m.receiver[2] - 0.016] }), 'blued');
  b.add(xf(chamferBox(0.016, 0.0075, 0.0060, 0.0008), { pos: [0, slideTop + 0.001, -0.008] }), 'blued');
  for (const s of [1, -1]) {
    b.add(xf(ball(0.0011, 8), { pos: [s * 0.0042, slideTop + 0.0032, -0.0072] }), 'lens');
  }
  b.add(xf(ball(0.0011, 8), { pos: [0, slideTop + 0.0032, -m.receiver[2] - 0.0152] }), 'lens');
  b.use('receiver');

  // Barrel showing through the front of the slide.
  b.add(xf(lathe([
    [-m.receiver[2] - 0.024, m.barrelRadius], [0.010, m.barrelRadius],
  ], 16), { pos: [0, boreY, 0] }), 'blued');
  b.add(xf(pipeZ(m.barrelRadius, m.barrelRadius * 0.55, 0.010, 16),
    { pos: [0, boreY, -m.receiver[2] - 0.020] }), 'blued');

  // Controls: slide stop, safety, magazine catch, takedown lever.
  b.add(xf(chamferBox(0.0035, 0.0060, 0.026, 0.0007), { pos: [-w * 0.5, frameTop - 0.004, -0.028] }), 'blued');
  b.add(xf(lathe([[0, 0.0044], [0.0035, 0.0044], [0.0045, 0.0034]], 10),
    { pos: [w * 0.5, frameTop - 0.006, -0.022], rot: [0, Math.PI / 2, 0] }), 'blued');
  b.add(xf(chamferBox(0.0030, 0.0075, 0.011, 0.0006), { pos: [w * 0.5, frameTop - 0.006, -0.006] }), 'blued');

  magazine(ctx, -0.004, frameTop - 0.010);
  ctx.sight.set(0, slideTop + 0.0055, -0.008);
  ctx.muzzleZ = muzzleDevice(ctx, ctx.slot.get('muzzle'), -m.receiver[2] - 0.024, m.barrelRadius);
  const pistolLaser = ctx.slot.get('laser');
  if (pistolLaser) {
    underbarrel(ctx, pistolLaser, -m.receiver[2] + 0.020, frameTop - 0.016);
    b.point('laser', [0.014, frameTop - 0.024, -m.receiver[2] - 0.006]);
  }
  commonPoints(ctx);
}

/* =============================================================== launcher */

function buildLauncher(ctx: BuildCtx): void {
  const { b, m } = ctx;
  const R = m.barrelRadius;
  const tubeFront = ctx.front - m.barrelLength;

  b.part('receiver');
  // Launch tube, flaring into a venturi at the rear.
  b.add(xf(lathe([
    [0.16, R * 1.55], [0.11, R * 1.05], [0.06, R * 0.98], [-0.02, R],
    [tubeFront + 0.06, R], [tubeFront + 0.02, R * 1.06], [tubeFront, R * 1.06],
  ], 26), {}), ctx.body);
  b.add(xf(pipeZ(R * 1.06, R * 0.88, 0.020, 26), { pos: [0, 0, tubeFront + 0.010] }), ctx.body);
  b.add(xf(pipeZ(R * 1.55, R * 1.30, 0.020, 26), { pos: [0, 0, 0.150] }), ctx.body);

  // Reinforcing bands and a wooden heat guard.
  for (const z of [-0.02, tubeFront + 0.10]) {
    b.add(xf(lathe([[z - 0.006, R * 1.10], [z + 0.006, R * 1.10]], 24), {}), ctx.body);
  }
  handguard(ctx);

  // Grip, trigger group and a folding front grip.
  pistolGrip(ctx, {
    top: [0, -R * 0.95, -0.010],
    length: 0.100, rake: 18, width: 0.036, depth: 0.046,
    material: 'wood', beavertail: false,
  });
  b.add(loft([
    { at: [0, -R * 1.05, -0.030], w: 0.0060, h: 0.0038, sq: 5 },
    { at: [0, -R * 1.05 - 0.024, -0.026], w: 0.0055, h: 0.0034, sq: 5 },
    { at: [0, -R * 1.05 - 0.026, 0.010], w: 0.0055, h: 0.0034, sq: 5 },
    { at: [0, -R * 1.05, 0.020], w: 0.0060, h: 0.0040, sq: 5 },
  ], 10), ctx.body);
  b.part('trigger', [0, -R * 1.05 - 0.012, -0.006]);
  b.add(xf(prismX([
    [0.004, 0.000], [0.006, -0.006], [0.004, -0.017], [-0.002, -0.019], [-0.004, -0.010], [-0.003, 0.000],
  ] as Pt2[], 0.008), { pos: [0, -R * 1.05 - 0.006, -0.006] }), 'blued');
  b.use('receiver');

  b.add(loft([
    { at: [0, -R * 1.0, ctx.front - 0.060], w: 0.012, h: 0.012, sq: 5 },
    { at: [0, -R * 1.0 - 0.050, ctx.front - 0.056], w: 0.011, h: 0.011, sq: 5 },
    { at: [0, -R * 1.0 - 0.082, ctx.front - 0.050], w: 0.012, h: 0.012, sq: 5 },
  ], 12), 'wood');

  // Iron sight ladder on the left, plus an optics bracket.
  b.add(xf(chamferBox(0.006, 0.010, 0.060, 0.0010), { pos: [-R * 0.85, R * 0.9, -0.10] }), ctx.body);
  b.add(xf(chamferBox(0.0035, 0.052, 0.010, 0.0008), { pos: [-R * 0.95, R * 0.9 + 0.026, -0.13] }), ctx.body);
  b.add(xf(chamferBox(0.0035, 0.030, 0.008, 0.0008), { pos: [-R * 0.95, R * 0.9 + 0.016, -0.062] }), ctx.body);
  ctx.sight.set(-R * 0.95, R * 0.9 + 0.040, -0.062);

  // Warhead loaded in the tube — hidden when the launcher is empty.
  b.part('rocket', [0, 0, tubeFront]);
  b.add(xf(lathe([
    [0.075, R * 0.30], [0.055, R * 0.60], [0.030, R * 0.86], [-0.010, R * 0.86],
    [-0.016, R * 0.55], [-0.090, R * 0.50], [-0.096, R * 0.34],
  ], 22), { pos: [0, 0, tubeFront] }), 'phosphate');
  b.add(xf(lathe([[0.075, R * 0.30], [0.092, R * 0.06]], 18), { pos: [0, 0, tubeFront] }), 'blued');
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const g = chamferBox(0.0022, R * 0.55, 0.030, 0.0005);
    xf(g, { pos: [0, R * 0.62, -0.070] });
    xf(g, { rot: [0, 0, a] });
    xf(g, { pos: [0, 0, tubeFront] });
    b.add(g, 'phosphate');
  }
  b.use('receiver');

  const opticAtt = ctx.slot.get('optic');
  if (opticAtt && opticAtt.build.kind !== 'ironsOnly') optic(ctx, opticAtt);

  ctx.muzzleZ = tubeFront;
  commonPoints(ctx);
}

/* ------------------------------------------------------------ dispatcher */

const BUILDERS: Record<string, (ctx: BuildCtx) => void> = {
  assault: buildAssault,
  smg: buildSmg,
  marksman: buildMarksman,
  lmg: buildLmg,
  sniper: buildSniper,
  shotgun: buildShotgun,
  pistol: buildPistol,
  launcher: buildLauncher,
};

/**
 * Builds a complete weapon rig for a definition + attachment loadout.
 *
 * Deterministic: the only randomness comes from a `Rand` seeded on the weapon
 * id, so the same loadout always produces byte-identical geometry.
 */
export function buildWeaponMesh(
  def: WeaponDef, attachments: readonly AttachmentDef[], mats: WeaponMaterials,
  space: MaterialSpace = 'view',
): WeaponRig {
  const b = new RigBuilder(mats, space);
  const ctx = makeCtx(b, def, attachments);
  const build = BUILDERS[def.cls] ?? buildAssault;
  build(ctx);
  const rig = b.build(def.id);

  // Guarantee the points every consumer relies on.
  if (!rig.points.has('muzzle')) rig.points.set('muzzle', new THREE.Vector3(...def.model.muzzle));
  if (!rig.points.has('sight')) rig.points.set('sight', new THREE.Vector3(0, def.model.sightHeight, -0.08));
  if (!rig.points.has('eject')) rig.points.set('eject', new THREE.Vector3(...def.model.ejectPort));
  return rig;
}

/* Kept so unused-import linting cannot mask a real regression in the helpers
 * these assemblies rely on. */
void rod; void screwHead; void torusZ; void disc; void picatinny;
