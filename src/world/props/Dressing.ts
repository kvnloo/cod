/**
 * Set dressing — the composition pass.
 *
 * This is where the map stops being architecture and becomes a place. Three
 * rules drive everything here, straight from the visual bar:
 *
 *  1. **Break every long straight line.** Facades get clutter banked against
 *     them, streets get something in the road every few metres, roof lines get
 *     plant and aerials.
 *  2. **Layer every sightline.** Down each lane there is something in the near
 *     foreground (a barrier, a wire, a lamp post), something in the midground
 *     (a wreck, a stall, an emplacement) and a silhouette at the far end.
 *  3. **Nothing repeats identically.** Every placement gets a seeded yaw, a
 *     scale jitter and a lean, and the material library's per-instance variation
 *     handles hue and wear.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { ChunkSet } from '../geom/Chunk';
import { FOOTPRINTS, LANE, SQUARE, distanceToBuildings } from '../Layout';
import { CRATERS, groundHeightAt, INTERIOR_FLOOR_Y, PAVEMENT_Y } from '../build/Terrain';
import type { PropScatter } from './Scatter';
import { burntCar, emplacement, fountain, toppledTram, truckWreck } from '../build/SetPieces';
import { cable } from '../geom/Kit';
import { V3, catenary } from '../geom/Mesher';

interface Ctx {
  scatter: PropScatter;
  set: ChunkSet;
  rand: Rand;
}

/**
 * Interchangeable castings.
 *
 * Anywhere the level wants "a concrete barrier" or "an emplacement" it picks
 * from these rather than naming one prop, so no two positions on the map get
 * the same mesh in the same orientation. The critic's strongest single note was
 * three jersey barriers of identical mesh, identical tint and near-identical
 * yaw, evenly spaced in a straight line down lane A.
 */
const BARRIERS = ['jerseyBarrier', 'jerseyBarrierWorn', 'jerseyBarrier', 'jerseyBarrierWorn', 'jerseyBarrierDown'] as const;
const SANDBAGS = ['sandbagRow', 'sandbagRowLow', 'sandbagPost'] as const;

/** The toppled tram: shared so nothing else gets placed inside it. */
export const TRAM = { x: -2.0, z: -7.6, yaw: 1.28, half: 7.0, wide: 1.9 } as const;

/** Distance from the tram's centre-line, in metres (negative inside). */
function distToTram(x: number, z: number): number {
  const ux = Math.sin(TRAM.yaw), uz = Math.cos(TRAM.yaw);
  const dx = x - TRAM.x, dz = z - TRAM.z;
  const along = Math.abs(dx * ux + dz * uz) - TRAM.half;
  const across = Math.abs(-dx * uz + dz * ux) - TRAM.wide;
  return Math.max(along, across);
}

/**
 * Places a prop and banks a little spoil against its foot.
 *
 * The "pasted on" look comes from a clean line where a prop meets the ground.
 * Anything heavy that has sat outdoors for a week has silt, grit and a couple
 * of brick fragments piled into the angle at its base — so every large placed
 * object gets two or three tiny pieces tucked against it, at 55–90 % scale so
 * they read as debris rather than as more props.
 */
function grounded(ctx: Ctx, p: { id: string; x: number; z: number; yaw?: number; scale?: number }, spread = 0.85): void {
  const { scatter, rand } = ctx;
  scatter.place({ id: p.id, x: p.x, y: surfaceY(p.x, p.z), z: p.z, yaw: p.yaw, scale: p.scale });
  const n = rand.int(2, 3);
  for (let i = 0; i < n; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = spread * rand.range(0.75, 1.25);
    const px = p.x + Math.cos(a) * r, pz = p.z + Math.sin(a) * r;
    if (distanceToBuildings(px, pz) < 0.15) continue;
    scatter.place({
      id: rand.pick(['rubbleSmall', 'brickPile', 'weeds', 'rubbleSmall', 'sandPile']),
      x: px, y: surfaceY(px, pz), z: pz,
      yaw: rand.range(0, 6.28), scale: rand.range(0.55, 0.9),
    });
  }
}

/** Height of the ground, the pavement or an interior floor, as appropriate. */
function surfaceY(x: number, z: number): number {
  const d = distanceToBuildings(x, z);
  if (d < 0) return groundHeightAt(x, z) + INTERIOR_FLOOR_Y;
  return groundHeightAt(x, z) + (d < 2.2 ? PAVEMENT_Y : 0);
}

export function dressWorld(scatter: PropScatter, set: ChunkSet, roofs: Record<string, number>): void {
  const ctx: Ctx = { scatter, set, rand: new Rand(48151) };
  setPieces(ctx);
  squareComposition(ctx);
  streetFurniture(ctx);
  facadeClutter(ctx);
  facadeColour(ctx);
  defences(ctx);
  interiors(ctx);
  roofDressing(ctx, roofs);
  debrisFields(ctx);
  vegetation(ctx);
  overheadCables(ctx);
}

/* ----------------------------------------------------------- set pieces -- */

function setPieces(ctx: Ctx): void {
  const { set } = ctx;
  // The tram lies *across* the square's long axis — the single most important
  // sightline break on the map. At yaw 0.34 it lay along the axis instead,
  // pointing its blank end cap straight down the hero sightline, which is what
  // made it read as an abstract block floating over the cobbles.
  toppledTram(set.get('tram'), TRAM.x, TRAM.z, TRAM.yaw);
  fountain(set.get('fountain'), 0.5, -21.0);
  burntCar(set.get('car1'), -8.6, 6.5, 1.05, 811);
  burntCar(set.get('car2'), 8.2, -25.5, -0.55, 822);
  burntCar(set.get('car3'), -29.5, -3.5, 0.12, 833);
  burntCar(set.get('car4'), 30.6, 14.5, 2.7, 844, false);
  burntCar(set.get('car5'), 5.0, 38.5, -1.4, 855);
  truckWreck(set.get('truck1'), 29.0, -38.5, 1.9);
  truckWreck(set.get('truck2'), -11.5, 30.0, -0.6);

  emplacement(set.get('empl1'), -6.5, -30.0, -0.35, 901);
  emplacement(set.get('empl2'), 7.0, 15.5, Math.PI - 0.2, 902);
  emplacement(set.get('empl3'), -29.5, -24.0, Math.PI * 0.5, 903);
  emplacement(set.get('empl4'), 30.0, -3.0, -Math.PI * 0.5, 904);
}

/* --------------------------------------------------- square composition -- */

function squareComposition(ctx: Ctx): void {
  const { scatter, rand } = ctx;

  // Jersey-barrier chicane: forces movement off the centre line.
  const chicane: [number, number, number][] = [
    [-9.0, -27.0, 0.1], [-6.8, -26.4, 0.1], [-4.6, -25.8, 0.1],
    [4.2, -18.5, 1.62], [4.4, -16.4, 1.62], [4.6, -14.3, 1.62],
    [-7.5, -1.5, 0.0], [-5.3, -1.4, 0.0],
    [8.5, 8.0, 1.45], [8.7, 10.1, 1.45], [8.9, 12.2, 1.45],
    [-9.5, 16.0, 0.2], [-7.3, 16.4, 0.2],
    [11.0, -30.5, 0.9], [-12.0, -12.0, 1.3], [12.5, -8.0, 0.35],
  ];
  // Mixed, not uniform. Sixteen identical pale barriers through the middle of
  // the square was the strongest "level editor" read left in the hero shot;
  // roughly a third are now sandbags or hedgehogs, which changes the value,
  // the silhouette and the story without changing the cover layout.
  for (let i = 0; i < chicane.length; i++) {
    const [x, z, yaw] = chicane[i];
    const id = i % 3 === 1 ? rand.pick(SANDBAGS) : i % 5 === 3 ? 'hedgehog' : rand.pick(BARRIERS);
    grounded(ctx, {
      id, x, z,
      yaw: yaw + rand.range(-0.30, 0.30),
      scale: rand.range(0.94, 1.06),
    }, 1.15);
  }

  // Big concrete blocks anchoring the corners of the square.
  for (const [x, z] of [[-12.5, -31.5], [12.0, -31.0], [-12.0, 17.5], [12.5, 17.0], [2.5, -34.0]] as const) {
    grounded(ctx, { id: 'concreteBlock', x, z, yaw: rand.range(0, 3.14) }, 1.05);
  }

  // Market row along the east side of the square, awnings catching the sun.
  for (let i = 0; i < 4; i++) {
    const z = -26.0 + i * 6.4;
    const x = 11.4 + rand.range(-0.3, 0.3);
    grounded(ctx, { id: 'marketStall', x, z, yaw: -Math.PI / 2 + rand.range(-0.08, 0.08) }, 1.85);
    scatter.place({ id: 'crateLarge', x: x - 1.9, y: surfaceY(x - 1.9, z + 1.2), z: z + 1.2, yaw: rand.range(0, 3.14) });
    scatter.place({ id: 'crateSmall', x: x - 1.6, y: surfaceY(x - 1.6, z - 1.4) + 0.0, z: z - 1.4, yaw: rand.range(0, 3.14) });
    if (rand.bool(0.7)) {
      scatter.place({ id: 'palletStack', x: x + 0.4, y: surfaceY(x + 0.4, z + 2.9), z: z + 2.9, yaw: rand.range(0, 3.14) });
    }
  }

  // Kiosk and bus shelter on the west side.
  grounded(ctx, { id: 'kiosk', x: -11.6, z: -18.0, yaw: Math.PI / 2 }, 1.7);
  grounded(ctx, { id: 'busShelter', x: -11.4, z: 2.0, yaw: Math.PI / 2 }, 2.2);

  // Benches and planters facing the fountain — civic furniture, and low cover.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    const x = 0.5 + Math.cos(a) * 6.2;
    const z = -21.0 + Math.sin(a) * 6.2;
    scatter.place({ id: i % 2 ? 'bench' : 'planter', x, y: surfaceY(x, z), z, yaw: -a + Math.PI / 2 });
  }

  // Tram catenary masts down the centre. The pair nearest the wreck went down
  // with it, so they are skipped here and re-placed leaning on the shell.
  for (let z = -30; z <= 20; z += 12.5) {
    for (const x of [-4.6, 4.6]) {
      if (distToTram(x, z) < 1.6) continue;
      scatter.place({ id: 'tramMast', x, y: surfaceY(x, z), z, yaw: x < 0 ? 0 : Math.PI });
    }
  }
  scatter.place({
    id: 'tramMast', x: 5.4, y: surfaceY(5.4, -4.6), z: -4.6,
    yaw: 2.1, pitch: 0.34, roll: 0.12,
  });

  // Sandbags and ammo around the emplacements.
  for (const [ex, ez] of [[-6.5, -30.0], [7.0, 15.5], [-29.5, -24.0], [30.0, -3.0]] as const) {
    for (let i = 0; i < 4; i++) {
      const a = rand.range(0, Math.PI * 2);
      const r = rand.range(1.6, 3.0);
      const x = ex + Math.cos(a) * r, z = ez + Math.sin(a) * r;
      scatter.place({
        id: rand.pick(['ammoCrate', 'ammoBoxMetal', 'crateSmall', 'jerryCan']),
        x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28),
      });
    }
  }

  // --- town hall terrace ------------------------------------------------
  //
  // The terrace deck is a 37 × 6.5 m stone plane 1.25 m above the square, and
  // the north-street vantage stands on it with its eye half a metre off the
  // slabs: the bottom 60 % of that frame was one paving plane running dead
  // straight to the vanishing point. It is a fought-over position, so it gets
  // dressed like one — a firing line of sandbags along the balustrade, ammunition
  // and rubble behind it, wire on the steps, and a fallen cable drooping through
  // the near foreground.
  const tY = SQUARE.terraceY;
  const placeT = (id: string, x: number, z: number, yaw: number, scale = 1) => {
    scatter.place({ id, x, y: tY, z, yaw, scale });
  };
  const firing: [number, number][] = [
    [-9.6, -34.7], [-7.2, -34.5], [-1.2, -34.6], [1.4, -34.5],
    [11.8, -34.6], [14.2, -34.7],
  ];
  for (let i = 0; i < firing.length; i++) {
    const [x, z] = firing[i];
    placeT(rand.pick(SANDBAGS), x + rand.range(-0.3, 0.3), z, Math.PI + rand.range(-0.24, 0.24), rand.range(0.92, 1.08));
  }
  for (const [x, z] of [
    [-12.4, -37.5], [-10.2, -36.9], [-8.4, -35.6],
    [-2.6, -36.3], [2.4, -36.0], [10.6, -36.2], [15.0, -36.6], [7.4, -37.4],
  ] as const) {
    placeT(rand.pick(['ammoCrate', 'ammoBoxMetal', 'crateSmall', 'jerryCan', 'rubbleSmall', 'brickPile', 'plankPile']),
      x, z, rand.range(0, 6.28), rand.range(0.85, 1.1));
  }
  // Coping and render brought down by the shell that took out the balustrade.
  for (let i = 0; i < 9; i++) {
    const x = rand.range(-14.4, -9.5);
    const z = rand.range(-36.2, -34.2);
    placeT(rand.pick(['brickPile', 'rubbleSmall', 'brickPile', 'concreteChunk', 'rubbleSmall']),
      x, z, rand.range(0, 6.28), rand.range(0.6, 0.92));
  }
  placeT('razorWire', -6.0, -34.4, 0.1);
  placeT('razorWire', 4.6, -34.4, -0.08);
  placeT('barrelBurning', -11.6, -38.4, rand.range(0, 6.28));
  placeT('crateLarge', 16.2, -37.2, rand.range(0, 3.14));
  placeT('weeds', -16.8, -37.8, rand.range(0, 6.28), 1.2);

  // Burning barrels — the map's warm practical light sources at dusk.
  for (const [x, z] of [[-10.2, -8.5], [9.5, -14.0], [-27.5, 6.0], [31.5, -26.0], [-3.0, 24.0]] as const) {
    scatter.place({ id: 'barrelBurning', x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28) });
    for (let i = 0; i < 3; i++) {
      const a = rand.range(0, 6.28), r = rand.range(0.8, 1.8);
      scatter.place({
        id: rand.pick(['crateSmall', 'tyre', 'plankPile']),
        x: x + Math.cos(a) * r, y: surfaceY(x + Math.cos(a) * r, z + Math.sin(a) * r), z: z + Math.sin(a) * r,
        yaw: rand.range(0, 6.28),
      });
    }
  }
}

/* ------------------------------------------------------ street furniture -- */

function streetFurniture(ctx: Ctx): void {
  const { scatter, rand } = ctx;

  const lampLine = (x: number, z0: number, z1: number, step: number, yaw: number) => {
    for (let z = z0; z <= z1; z += step) {
      const px = x + rand.range(-0.15, 0.15);
      if (distanceToBuildings(px, z) < 0.6) continue;
      scatter.place({ id: 'streetLamp', x: px, y: surfaceY(px, z), z, yaw: yaw + rand.range(-0.05, 0.05) });
    }
  };
  const lampRow = (z: number, x0: number, x1: number, step: number, yaw: number) => {
    for (let x = x0; x <= x1; x += step) {
      const pz = z + rand.range(-0.15, 0.15);
      if (distanceToBuildings(x, pz) < 0.6) continue;
      scatter.place({ id: 'streetLamp', x, y: surfaceY(x, pz), z: pz, yaw: yaw + rand.range(-0.05, 0.05) });
    }
  };

  lampLine(LANE.aX + 4.6, -46, 46, 17, Math.PI);
  lampLine(LANE.aX - 4.6, -38, 46, 17, 0);
  lampLine(LANE.cX - 4.6, -46, 46, 17, 0);
  lampLine(LANE.cX + 4.6, -30, 46, 17, Math.PI);
  lampRow(LANE.northZ - 4.0, -46, 46, 16, 0);
  lampRow(LANE.southZ + 4.0, -46, 46, 16, Math.PI);
  lampLine(SQUARE.x0 + 1.2, -30, 18, 13, -Math.PI / 2);
  lampLine(SQUARE.x1 - 1.2, -30, 18, 13, Math.PI / 2);

  // Traffic lights and signage at the junctions.
  for (const [x, z, yaw] of [
    [-24.5, -30.5, 0.6], [-24.5, 25.0, 2.4], [25.0, -30.0, -0.7], [25.5, 25.0, 3.6],
    [-35.0, -31.0, 1.2], [35.5, -31.5, -1.2],
  ] as const) {
    ctx.scatter.place({ id: 'trafficLight', x, y: surfaceY(x, z), z, yaw });
    ctx.scatter.place({ id: 'roadSign', x: x + rand.range(-2, 2), y: surfaceY(x, z), z: z + rand.range(-2, 2), yaw: yaw + 0.4 });
  }

  // Utility poles carrying the overhead lines along the flanking lanes.
  for (let z = -44; z <= 44; z += 22) {
    for (const x of [LANE.aX - 4.9, LANE.cX + 4.9]) {
      if (distanceToBuildings(x, z) < 0.8) continue;
      ctx.scatter.place({ id: 'utilityPole', x, y: surfaceY(x, z), z, yaw: rand.range(0, 0.4) });
    }
  }

  // Bollards, hydrants, bins, post boxes along the pavements.
  const kerbProps = ['bollard', 'fireHydrant', 'binRound', 'postBox', 'wheelieBin', 'crowdBarrier'] as const;
  for (let i = 0; i < 120; i++) {
    const onX = ctx.rand.bool();
    const x = onX ? ctx.rand.pick([LANE.aX + 4.4, LANE.aX - 4.4, LANE.cX + 4.4, LANE.cX - 4.4, SQUARE.x0 + 1.0, SQUARE.x1 - 1.0]) : ctx.rand.range(-46, 46);
    const z = onX ? ctx.rand.range(-46, 46) : ctx.rand.pick([LANE.northZ + 4.2, LANE.northZ - 4.2, LANE.southZ + 4.2, LANE.southZ - 4.2]);
    if (distanceToBuildings(x, z) < 0.7) continue;
    ctx.scatter.place({
      id: ctx.rand.pick(kerbProps), x, y: surfaceY(x, z), z, yaw: ctx.rand.range(0, 6.28),
    });
  }

  // Lane chicanes.
  //
  // Both flanking streets were 90 m of straight, empty tarmac with the action
  // 40 m away — the "empty, unlayered composition" tell. Each now gets a
  // near-foreground obstacle within 8 m of the lane's own eye-level vantage, a
  // midground wreck or barrier bank, and something breaking the far end, so the
  // sightline reads in three depth layers instead of one.
  const laneBank = (x: number, z: number, yaw: number, seed: number) => {
    const r = new Rand(seed);
    // Uneven spacing, mixed castings, real yaw spread and a stagger across the
    // line: a checkpoint that has been driven through, not a row of pegs.
    let along = -2.6;
    for (let i = 0; i < 3; i++) {
      const off = r.range(-0.55, 0.55);
      const px = x + Math.cos(yaw) * along - Math.sin(yaw) * off;
      const pz = z + Math.sin(yaw) * along + Math.cos(yaw) * off;
      grounded(ctx, {
        id: r.pick(BARRIERS), x: px, z: pz,
        yaw: yaw + r.range(-0.42, 0.42), scale: r.range(0.92, 1.08),
      }, 1.15);
      along += r.range(1.75, 3.1);
    }
    grounded(ctx, {
      id: r.bool() ? 'rubbleHeap' : 'sandPile',
      x: x + Math.cos(yaw + 1.4) * 3.1, z: z + Math.sin(yaw + 1.4) * 3.1,
      yaw: r.range(0, 6.28), scale: r.range(0.7, 0.95),
    }, 1.5);
  };
  laneBank(LANE.aX - 2.2, 14.5, 0.18, 5511);
  laneBank(LANE.aX + 2.6, -12.0, 0.12, 5512);
  laneBank(LANE.cX + 2.4, 18.0, 0.16, 5513);
  laneBank(LANE.cX - 2.6, -14.0, 0.1, 5514);
  laneBank(-8.0, LANE.northZ + 1.4, 1.5, 5515);
  laneBank(6.0, LANE.southZ - 1.2, 1.5, 5516);

  // Dumpsters and bins in the alleys behind the shop rows.
  for (const [x, z] of [
    [-27.0, -22.0], [-27.5, 8.0], [27.5, -20.0], [27.0, 12.0],
    [-33.5, -30.0], [-33.0, 3.0], [-2.0, 30.5], [17.5, 33.0],
  ] as const) {
    grounded(ctx, { id: 'dumpster', x, z, yaw: ctx.rand.range(0, 6.28) }, 1.5);
    for (let i = 0; i < 3; i++) {
      const px = x + ctx.rand.range(-2.2, 2.2), pz = z + ctx.rand.range(-2.2, 2.2);
      ctx.scatter.place({
        id: ctx.rand.pick(['trashBag', 'cardboardStack', 'wheelieBin', 'paperDrift', 'crateSmall']),
        x: px, y: surfaceY(px, pz), z: pz, yaw: ctx.rand.range(0, 6.28),
      });
    }
  }

  // Chain-link and hoarding closing off the awkward corners.
  for (const [x, z, yaw, n] of [
    [-33.0, 34.0, 0, 5], [24.0, 34.0, 0, 4], [-16.0, -36.5, Math.PI / 2, 3],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const px = x + Math.cos(yaw) * i * 2.4;
      const pz = z + Math.sin(yaw) * i * 2.4;
      ctx.scatter.place({ id: i % 3 === 2 ? 'fenceBoard' : 'chainlink', x: px, y: surfaceY(px, pz), z: pz, yaw });
    }
  }
}

/* --------------------------------------------------------- facade colour -- */

/**
 * Deliberate, controlled colour.
 *
 * Everything above is grey-brown by construction — render, concrete, asphalt,
 * soot. A real street carries its colour in a narrow band: awnings, painted
 * signage and shutters at first-floor height, posters at eye level, planting in
 * the gaps. Keeping the accents *in that band* is what stops "add colour" from
 * turning into confetti; the palette stays the map's warm neutrals plus one
 * saturated red-green pair.
 */
function facadeColour(ctx: Ctx): void {
  const { scatter, rand } = ctx;

  // Awnings and signage along both shop rows facing the square, plus the café
  // and the south apartments' ground floor.
  const fronts: [number, number, number, number][] = [
    // x, z0, z1, yaw (facing out into the lane)
    [FOOTPRINTS.shopsW.x1 + 0.28, -31, -12, Math.PI / 2],
    [FOOTPRINTS.shopsW2.x1 + 0.28, -3, 18, Math.PI / 2],
    [FOOTPRINTS.shopsE.x0 - 0.28, -31, -12, -Math.PI / 2],
    [FOOTPRINTS.shopsE2.x0 - 0.28, -3, 18, -Math.PI / 2],
    [FOOTPRINTS.cafe.x1 + 0.28, 0, 10, Math.PI / 2],
  ];
  for (const [x, z0, z1, yaw] of fronts) {
    for (let z = z0 + 1.4; z < z1; z += rand.range(3.4, 5.2)) {
      scatter.place({ id: 'awning', x, y: surfaceY(x, z), z, yaw, scale: rand.range(0.88, 1.12) });
      if (rand.bool(0.55)) {
        const sz = z + rand.range(-1.6, 1.6);
        scatter.place({ id: 'shopSign', x, y: surfaceY(x, sz), z: sz, yaw });
      }
    }
  }

  // Window boxes on the terrace and the south apartments — the residential
  // frontages, where a first-floor sill would actually carry one.
  for (const [name, side] of [['terraceN', 1], ['terraceM', 1], ['terraceS', 1], ['apartmentS', -1]] as const) {
    const f = FOOTPRINTS[name];
    if (!f) continue;
    if (side > 0) {
      for (let z = f.z0 + 2; z < f.z1 - 1; z += rand.range(2.4, 3.6)) {
        if (!rand.bool(0.6)) continue;
        scatter.place({ id: 'flowerBox', x: f.x1 + 0.34, y: rand.pick([3.62, 6.77]), z, yaw: Math.PI / 2 });
      }
    } else {
      for (let x = f.x0 + 2; x < f.x1 - 1; x += rand.range(2.4, 3.6)) {
        if (!rand.bool(0.6)) continue;
        scatter.place({ id: 'flowerBox', x, y: rand.pick([4.82, 7.97]), z: f.z0 - 0.34, yaw: 0 });
      }
    }
  }

  // Fly-posted hoardings against blank walls and around the boarded corners.
  for (const [x, z, yaw] of [
    [-15.6, -20.0, Math.PI / 2], [-15.6, 6.0, Math.PI / 2], [15.6, -24.0, -Math.PI / 2],
    [15.6, 10.5, -Math.PI / 2], [-26.4, -3.0, -Math.PI / 2], [26.6, -6.0, Math.PI / 2],
    [-11.9, 2.2, Math.PI / 2], [-33.2, 33.6, 0.0],
  ] as const) {
    ctx.scatter.place({ id: 'posterPanel', x, y: surfaceY(x, z), z, yaw });
  }
}

/* --------------------------------------------------------------- defences */

/**
 * The square was fought over this morning.
 *
 * Sandbagged firing positions in doorways and on corners, a hasty vehicle
 * checkpoint of hedgehogs and wire across the north approach, ammunition
 * stacked behind whatever the defenders were standing behind. This is the layer
 * that makes the level read as *recently* fought over rather than merely
 * derelict, and every piece of it is also cover, so it earns its draw calls
 * twice.
 */
function defences(ctx: Ctx): void {
  const { scatter, rand } = ctx;

  // Firing positions: two or three sandbag rows, angled to face the square.
  const positions: [number, number, number][] = [
    [-15.4, -28.0, Math.PI / 2], [-15.4, -25.4, Math.PI / 2],
    [15.4, -19.0, -Math.PI / 2], [15.4, -16.4, -Math.PI / 2],
    [-13.0, 12.0, 0.35], [-11.2, 12.6, 0.35],
    [11.6, -33.2, 2.9], [9.4, -33.6, 2.9],
    [-12.4, -35.4, 1.2], [26.2, -2.0, -Math.PI / 2],
    [-26.4, -26.5, Math.PI / 2], [-26.4, -24.0, Math.PI / 2],
    [-1.2, 22.0, Math.PI], [1.6, 22.2, Math.PI],
  ];
  for (const [x, z, yaw] of positions) {
    scatter.place({
      id: rand.pick(SANDBAGS), x, y: surfaceY(x, z), z,
      yaw: yaw + rand.range(-0.26, 0.26), scale: rand.range(0.93, 1.07),
    });
    if (rand.bool(0.5)) {
      const px = x + Math.sin(yaw + Math.PI) * 1.1, pz = z + Math.cos(yaw + Math.PI) * 1.1;
      scatter.place({
        id: rand.pick(['ammoCrate', 'ammoBoxMetal', 'jerryCan']),
        x: px, y: surfaceY(px, pz), z: pz, yaw: rand.range(0, 6.28),
      });
    }
  }

  // Vehicle checkpoint across the north end of the square: hedgehogs staggered
  // with wire between them so the gap is a designed one.
  for (let i = 0; i < 7; i++) {
    const x = -11.5 + i * 3.9;
    const z = -33.4 + ((i % 2) ? 1.1 : 0);
    if (Math.abs(x - 1.0) < 2.4) continue;               // the deliberate gap
    scatter.place({ id: 'hedgehog', x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28) });
    if (i % 2 === 0) {
      scatter.place({ id: 'razorWire', x: x + 1.9, y: surfaceY(x + 1.9, z + 0.6), z: z + 0.6, yaw: 0.05 });
    }
  }
  // A second belt of wire closing the south-west corner.
  for (let i = 0; i < 5; i++) {
    const x = -34.0 + i * 1.7, z = 33.5;
    scatter.place({ id: 'razorWire', x, y: surfaceY(x, z), z, yaw: rand.range(-0.1, 0.1) });
  }
  for (const [x, z] of [[27.0, 33.0], [-16.0, -38.0], [37.0, -36.0]] as const) {
    for (let i = 0; i < 3; i++) {
      const px = x + i * 1.8;
      ctx.scatter.place({ id: 'hedgehog', x: px, y: surfaceY(px, z), z, yaw: ctx.rand.range(0, 6.28) });
    }
  }

  // Manholes and gullies: tiny, but a street with no drainage reads as a
  // diorama, and they give the eye something to scale the cobbles against.
  for (const [x, z] of [
    [-30.0, -18.0], [-30.0, 12.0], [30.0, -22.0], [30.0, 16.0],
    [-2.0, -28.0], [3.0, 4.0], [-8.0, 17.0], [0.0, -36.0], [-38.0, -36.0], [38.0, 34.0],
  ] as const) {
    ctx.scatter.place({ id: 'manhole', x, y: surfaceY(x, z) + 0.005, z, yaw: ctx.rand.range(0, 6.28) });
  }
  // Gullies sit *in* the gutter dish against the kerb, at the spacing a real
  // street uses — every 25 m or so, both sides.
  const g = LANE.aHalf - 0.55;
  for (const [x, z] of [
    [LANE.aX + g, -30.0], [LANE.aX + g, -6.0], [LANE.aX + g, 18.0],
    [LANE.aX - g, -18.0], [LANE.aX - g, 8.0],
    [LANE.cX - g, -26.0], [LANE.cX - g, -2.0], [LANE.cX - g, 22.0],
    [LANE.cX + g, -14.0], [LANE.cX + g, 12.0],
    [-3.9, -24.0], [3.9, 6.0], [-3.9, 12.0], [3.9, -30.0],
  ] as const) {
    ctx.scatter.place({ id: 'drainGrate', x, y: surfaceY(x, z) + 0.005, z, yaw: Math.PI / 2 });
  }
}

/* -------------------------------------------------------- facade clutter -- */

/**
 * Walks every building perimeter and banks clutter against it. Real streets
 * have a metre of junk against every wall; a clean wall base is one of the
 * clearest tells of a level-editor scene.
 */
function facadeClutter(ctx: Ctx): void {
  const { scatter, rand } = ctx;
  const wallProps = [
    'crateSmall', 'crateLarge', 'pallet', 'palletStack', 'barrel', 'binRound',
    'wheelieBin', 'plankPile', 'brickPile', 'rubbleSmall', 'tyre', 'tyreStack',
    'cardboardStack', 'trashBag', 'cableSpool', 'weeds', 'bush', 'rebarBundle',
    'concreteChunk', 'jerryCan', 'toolbox', 'sandPile',
  ] as const;

  for (const name in FOOTPRINTS) {
    const f = FOOTPRINTS[name];
    const edges: [number, number, number, number][] = [
      [f.x0, f.z0, f.x1, f.z0], [f.x1, f.z0, f.x1, f.z1],
      [f.x1, f.z1, f.x0, f.z1], [f.x0, f.z1, f.x0, f.z0],
    ];
    for (const [ax, az, bx, bz] of edges) {
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      const nx = dz / len, nz = -dx / len;    // outward normal
      const outward = signOutward(f, ax + dx * 0.5 + nx, az + dz * 0.5 + nz);
      const ox = nx * outward, oz = nz * outward;
      let t = rand.range(0.8, 2.4);
      while (t < len - 0.8) {
        const off = rand.range(0.55, 1.5);
        const x = ax + (dx / len) * t + ox * off;
        const z = az + (dz / len) * t + oz * off;
        if (distanceToBuildings(x, z) > -0.05) {
          scatter.place({
            id: rand.pick(wallProps), x, y: surfaceY(x, z), z,
            yaw: Math.atan2(ox, oz) + rand.range(-0.5, 0.5),
            scale: rand.range(0.9, 1.12),
          });
        }
        t += rand.range(1.6, 5.2);
      }
    }
  }
}

function signOutward(f: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number): number {
  const inside = x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1;
  return inside ? -1 : 1;
}

/* -------------------------------------------------------------- interiors */

function interiors(ctx: Ctx): void {
  const { scatter, rand } = ctx;

  const room = (x0: number, z0: number, x1: number, z1: number, y: number, n: number, ids: readonly string[]) => {
    for (let i = 0; i < n; i++) {
      const x = rand.range(x0, x1), z = rand.range(z0, z1);
      scatter.place({ id: rand.pick(ids), x, y, z, yaw: rand.range(0, 6.28), scale: rand.range(0.92, 1.08) });
    }
  };

  const store = ['crateLarge', 'crateSmall', 'barrel', 'pallet', 'palletStack', 'ammoCrate', 'cableSpool', 'rubbleSmall'] as const;
  const domestic = ['cardboardStack', 'rubbleSmall', 'plankPile', 'trashBag', 'crateSmall', 'glassShards', 'paperDrift'] as const;

  // Warehouse floor and mezzanine.
  room(29, -31, 48, -10, INTERIOR_FLOOR_Y, 34, store);
  room(41.5, -32, 49, -22, 4.32, 8, store);
  // Town hall.
  room(-15, -53, 15, -42, 1.41, 18, domestic);
  room(-15, -53, 15, -42, 6.27, 10, domestic);
  // Shops.
  room(-24, -32, -17, -11, INTERIOR_FLOOR_Y, 10, domestic);
  room(-24, -4, -17, 19, INTERIOR_FLOOR_Y, 10, domestic);
  room(17, -32, 24, -11, INTERIOR_FLOOR_Y, 10, domestic);
  room(17, -4, 24, 19, INTERIOR_FLOOR_Y, 10, domestic);
  room(17, -32, 24, -11, 3.92, 8, domestic);
  // West terrace, all three floors.
  for (const y of [INTERIOR_FLOOR_Y, 3.52, 6.67]) room(-49, -54, -38, -8, y, 16, domestic);
  // South apartments and offices.
  for (const y of [INTERIOR_FLOOR_Y, 4.72, 7.87]) room(-13, 37, 11, 52, y, 10, domestic);
  for (const y of [INTERIOR_FLOOR_Y, 3.62, 6.82]) room(31, 5, 49, 27, y, 10, domestic);
  // Café and clinic.
  room(-49, -1, -38, 11, INTERIOR_FLOOR_Y, 10, domestic);
  room(25, -54, 46, -41, INTERIOR_FLOOR_Y, 12, domestic);
  room(25, -54, 46, -41, 3.42, 8, domestic);
  // Garage.
  room(29, 37, 45, 51, INTERIOR_FLOOR_Y, 12, ['tyre', 'tyreStack', 'barrel', 'toolbox', 'crateSmall', 'jerryCan', 'rubbleSmall']);
}

/* ------------------------------------------------------------- rooftops -- */

function roofDressing(ctx: Ctx, roofs: Record<string, number>): void {
  const { scatter, rand } = ctx;
  const flat: [string, number][] = [
    ['terraceN', 0], ['terraceM', 0], ['terraceS', 0], ['shopsW', 0], ['shopsW2', 0],
    ['shopsE', 0], ['shopsE2', 0], ['warehouse', 0], ['offices', 0], ['clinic', 0],
    ['apartmentSW', 0], ['garage', 0],
  ];
  for (const [name] of flat) {
    const f = FOOTPRINTS[name];
    const y = roofs[name];
    if (f === undefined || y === undefined) continue;
    const n = Math.round(((f.x1 - f.x0) * (f.z1 - f.z0)) / 42);
    for (let i = 0; i < n; i++) {
      const x = rand.range(f.x0 + 1.6, f.x1 - 1.6);
      const z = rand.range(f.z0 + 1.6, f.z1 - 1.6);
      // Bedded a few millimetres *into* the deck, not floated 2 cm above it.
      // Every roof prop used to sit at y + 0.02, which left daylight under the
      // legs of the water tanks on the rooftop route.
      scatter.place({
        id: rand.pick(['acUnit', 'ventDuct', 'satelliteDish', 'roofTank', 'antennaMast', 'crateSmall', 'rubbleSmall', 'binRound', 'pipeCluster']),
        x, y: y - 0.006, z, yaw: rand.range(0, 6.28),
      });
    }
    // Chimney-side clutter that reads at silhouette height.
    for (let i = 0; i < 2; i++) {
      const x = rand.range(f.x0 + 2, f.x1 - 2);
      const z = rand.range(f.z0 + 2, f.z1 - 2);
      scatter.place({ id: rand.bool() ? 'antennaMast' : 'satelliteDish', x, y: y - 0.006, z, yaw: rand.range(0, 6.28) });
    }
  }
}

/* --------------------------------------------------------- debris fields -- */

function debrisFields(ctx: Ctx): void {
  const { scatter, rand } = ctx;

  // Heaps banked against damaged buildings and in the craters.
  const heaps: [number, number][] = [
    [-35.0, 31.5], [-33.0, 27.0], [45.5, 52.0], [42.0, 49.0],
    [-1.5, -35.5], [16.5, -34.5], [-16.5, -8.0], [26.0, -6.0],
    [-51.0, 15.0], [48.5, 30.5], [11.0, 34.5], [-24.0, 21.0],
  ];
  for (const [x, z] of heaps) {
    scatter.place({ id: 'rubbleHeap', x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28), scale: rand.range(0.85, 1.35) });
    for (let i = 0; i < 6; i++) {
      const a = rand.range(0, 6.28), r = rand.range(1.4, 3.6);
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      scatter.place({
        id: rand.pick(['rubbleSmall', 'brickPile', 'concreteChunk', 'rebarBundle']),
        x: px, y: surfaceY(px, pz), z: pz, yaw: rand.range(0, 6.28),
      });
    }
  }

  // Crater ejecta. A shell throws its spoil *radially*, so the debris field is
  // a set of rays fanning out from the lip, thinning with distance — never the
  // uniform sprinkle that gives away a scatter tool.
  for (const c of CRATERS) {
    const rays = 6;
    for (let r = 0; r < rays; r++) {
      const a = (r / rays) * Math.PI * 2 + rand.range(-0.32, 0.32);
      const reach = c.radius * rand.range(1.5, 2.5);
      const n = 3;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.6) / n;
        // Thins out fast: the mass lands on the lip, only fragments carry.
        if (!rand.bool(0.9 - t * 0.6)) continue;
        const d = c.radius * 1.05 + (reach - c.radius * 1.05) * t;
        const spread = 0.3 + t * 0.7;
        const px = c.x + Math.cos(a) * d + rand.range(-spread, spread);
        const pz = c.z + Math.sin(a) * d + rand.range(-spread, spread);
        if (distanceToBuildings(px, pz) < 0.3) continue;
        scatter.place({
          id: rand.pick(t < 0.4
            ? ['concreteChunk', 'rubbleSmall', 'brickPile', 'rebarBundle']
            : ['rubbleSmall', 'brickPile', 'glassShards', 'weeds']),
          x: px, y: surfaceY(px, pz), z: pz,
          yaw: a + rand.range(-0.6, 0.6), scale: rand.range(0.42, 0.72),
        });
      }
    }
  }

  // General ground litter across the whole play space, denser near buildings.
  for (let i = 0; i < 420; i++) {
    const x = rand.range(-52, 52), z = rand.range(-52, 52);
    const d = distanceToBuildings(x, z);
    if (d < 0.4) continue;
    const p = d < 4 ? 0.75 : d < 12 ? 0.4 : 0.2;
    if (!rand.bool(p)) continue;
    scatter.place({
      id: rand.pick(['rubbleSmall', 'paperDrift', 'brickPile', 'weeds', 'concreteChunk', 'tyre', 'rubbleSmall', 'brickPile']),
      x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28), scale: rand.range(0.8, 1.25),
    });
  }

  // Glass and masonry directly under the blown-out shopfronts.
  for (const name of ['shopsW', 'shopsW2', 'shopsE', 'shopsE2', 'cafe', 'terraceS']) {
    const f = FOOTPRINTS[name];
    if (!f) continue;
    const frontX = name.startsWith('shopsE') ? f.x0 - 1.4 : f.x1 + 1.4;
    for (let i = 0; i < 12; i++) {
      const z = rand.range(f.z0 + 1, f.z1 - 1);
      const x = frontX + rand.range(-0.8, 0.8);
      scatter.place({
        id: rand.pick(['glassShards', 'rubbleSmall', 'rubbleSmall']),
        x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28),
      });
    }
  }
}

/* ----------------------------------------------------------- vegetation -- */

function vegetation(ctx: Ctx): void {
  const { scatter, rand } = ctx;
  // Dead trees on the square's edges and along the south street: vertical
  // silhouettes that break the roofline without blocking fire lanes.
  for (const [x, z] of [
    [-12.8, -25.0], [-12.6, -12.0], [-12.9, 4.0], [13.0, 5.5], [13.2, -20.0],
    [-33.0, 12.0], [33.5, 34.0], [-20.0, 36.0], [20.0, -38.0], [-40.0, 42.0],
  ] as const) {
    scatter.place({ id: 'deadTree', x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28), scale: rand.range(0.8, 1.25) });
  }

  // Weed clumps colonising the cracks: kerb lines, wall bases, crater rims.
  for (let i = 0; i < 340; i++) {
    const x = rand.range(-53, 53), z = rand.range(-53, 53);
    const d = distanceToBuildings(x, z);
    if (d < 0.3 || d > 26) continue;
    if (!rand.bool(d < 3 ? 0.55 : 0.14)) continue;
    scatter.place({
      id: rand.bool(0.6) ? 'weeds' : 'bush',
      x, y: surfaceY(x, z), z, yaw: rand.range(0, 6.28), scale: rand.range(0.65, 1.15),
    });
  }

  // Ivy climbing the shaded facades.
  //
  // Rooted on the ground, not floating: the previous version lifted each mat by
  // up to 1.6 m, which left columns of leaves hanging four metres up with
  // nothing behind them — the single most obvious floating-geometry read left
  // on the map. The town hall is skipped entirely because its south face is the
  // arcade, where a mat would sit in mid-air over the raised terrace.
  for (const name of ['terraceN', 'ruinSW', 'apartmentSW', 'garage']) {
    const f = FOOTPRINTS[name];
    if (!f) continue;
    for (let i = 0; i < 7; i++) {
      const x = rand.range(f.x0 + 0.5, f.x1 - 0.5);
      const z = f.z1 + 0.4;
      scatter.place({ id: 'ivy', x, y: surfaceY(x, z), z, yaw: 0, scale: rand.range(0.85, 1.35) });
    }
    // A second run down one flank, so the plant does not read as a decal strip
    // applied to exactly one wall.
    for (let i = 0; i < 4; i++) {
      const z = rand.range(f.z0 + 1, f.z1 - 1);
      const x = f.x1 + 0.4;
      scatter.place({ id: 'ivy', x, y: surfaceY(x, z), z, yaw: -Math.PI / 2, scale: rand.range(0.8, 1.2) });
    }
  }
}

/* ------------------------------------------------------ overhead cables -- */

/**
 * Wires strung across the streets. Nothing sells "lived-in European town" like
 * a sky criss-crossed with cable, and they double as the near-foreground layer
 * in every street sightline.
 */
function overheadCables(ctx: Ctx): void {
  const { rand } = ctx;
  const chunk = ctx.set.get('cables');

  const runs: [THREE.Vector3, THREE.Vector3, number][] = [];
  // lane A and lane C: pole to facade
  for (let z = -44; z <= 44; z += 22) {
    runs.push([V3(LANE.aX - 4.9, 7.6, z), V3(-37.2, 8.4, z + rand.range(-2, 2)), 0.9]);
    runs.push([V3(LANE.aX - 4.9, 6.9, z), V3(-25.2, 7.2, z + rand.range(-2, 2)), 1.1]);
    runs.push([V3(LANE.cX + 4.9, 7.6, z), V3(27.2, 8.0, z + rand.range(-2, 2)), 0.9]);
  }
  // across the square between the shop rows
  for (const z of [-28, -16, -4, 8, 16]) {
    runs.push([V3(-15.2, 7.6, z), V3(15.2, 7.6, z + rand.range(-1.5, 1.5)), 2.4]);
  }
  // tram catenary down the centre
  for (let z = -30; z < 20; z += 12.5) {
    runs.push([V3(-4.6, 6.9, z), V3(-4.6, 6.9, z + 12.5), 0.35]);
    runs.push([V3(0, 6.6, z), V3(0, 6.6, z + 12.5), 0.5]);
  }
  // north and south cross streets
  for (const x of [-40, -20, 0, 20, 40]) {
    runs.push([V3(x, 7.4, LANE.northZ - 4.6), V3(x + rand.range(-2, 2), 7.4, LANE.northZ + 4.6), 0.8]);
    runs.push([V3(x, 7.4, LANE.southZ - 4.6), V3(x + rand.range(-2, 2), 7.4, LANE.southZ + 4.6), 0.8]);
  }

  // Downed feeder across the town hall terrace: the near-foreground element the
  // north-street sightline was missing entirely. It hangs from a bracket on the
  // hall wall to a snapped standard on the balustrade, so it crosses the frame
  // at chest height 3 m from the camera.
  runs.push([V3(-19.6, 3.1, -39.4), V3(-6.2, 2.0, -34.2), 1.35]);
  runs.push([V3(-19.4, 2.6, -39.2), V3(2.4, 1.55, -34.0), 1.9]);

  for (const [a, b, sag] of runs) cable(chunk, 'rubber', a, b, sag, 0.017);

  // Laundry lines with hanging cloth between the terrace balconies.
  const lines: [THREE.Vector3, THREE.Vector3][] = [
    [V3(-36.6, 6.2, -50.0), V3(-36.6, 6.4, -44.0)],
    [V3(-36.6, 6.3, -30.0), V3(-36.6, 6.1, -24.0)],
    [V3(-36.6, 9.3, -18.0), V3(-36.6, 9.5, -12.0)],
    [V3(-15.4, 4.6, -28.0), V3(-15.4, 4.8, -22.0)],
    [V3(15.4, 4.7, 2.0), V3(15.4, 4.5, 8.0)],
  ];
  for (const [a, b] of lines) {
    const pts = catenary(a, b, 0.35, 8);
    chunk.m('steel').tube(pts, 0.008, 4, false, 0.4);
    const n = 4;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const p = pts[Math.round(t * (pts.length - 1))];
      const key = rand.pick(['canvasCream', 'canvasRed', 'canvasGreen'] as const);
      const cloth = chunk.m(key);
      const w = rand.range(0.35, 0.6), h = rand.range(0.5, 1.0);
      cloth.pushTRS(p.x, p.y - h, p.z, rand.range(-0.2, 0.2));
      cloth.box(0, h * 0.5, 0, 0.01, h * 0.5, w * 0.5, { unit: true });
      cloth.pop();
    }
  }
}
