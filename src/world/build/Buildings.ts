/**
 * The twelve buildings of Blackout.
 *
 * Each is authored for a gameplay job first and a silhouette second:
 *
 *  - **Town hall** (north): the hero building and skyline anchor. Arcade,
 *    clock tower, raised terrace that gives the north end of the square its
 *    elevated cover.
 *  - **West terrace** (three party-wall blocks): the rooftop route. Enter at the
 *    south end via the fire escape, run north above lane A, drop through the
 *    blown roof into the top floor, out through the north stairwell.
 *  - **Shops rows** flanking the square: shopfronts and balconies overlooking
 *    the centre lane, with rear doors on to lane A and lane C — the two short
 *    flanks.
 *  - **Warehouse** (east): the interior lane. Roller door, mezzanine, clerestory,
 *    roof access.
 *  - **South apartments**: an arched passage through the ground floor, the only
 *    covered crossing between the square and the southern street.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { Chunk, ChunkSet } from '../geom/Chunk';
import { FOOTPRINTS, SQUARE } from '../Layout';
import {
  archOpening, cable, column, doorUnit, fireEscape, parapet, railing, roofFlat,
  slab, stairs, wall, windowUnit, rectWalls, cornice, chimney, downpipe,
  WallFrame, type Opening,
} from '../geom/Kit';
import { buildBlock, ladder, plankBridge, type BlockResult, type BlockSpec } from './Block';
import { registerWorldArtVantages } from './Dressing';
import type { MatKey } from '../MatCatalog';
import { V3 } from '../geom/Mesher';

export interface BuiltWorld {
  blocks: Record<string, BlockResult>;
  /** Points the nav build should treat as interesting patrol anchors. */
  interiors: { x: number; z: number; y: number; radius: number; name: string }[];
}

export function buildAllBuildings(set: ChunkSet): BuiltWorld {
  const blocks: Record<string, BlockResult> = {};
  const interiors: BuiltWorld['interiors'] = [];
  registerWorldArtVantages();

  blocks.townHall = townHall(set.get('townHall'));
  blocks.clinic = clinic(set.get('clinic'));
  const terrace = westTerrace(set);
  Object.assign(blocks, terrace);
  blocks.cafe = cafe(set.get('cafe'));
  blocks.apartmentSW = apartmentSW(set.get('apartmentSW'));
  ruinSW(set.get('ruinSW'));
  blocks.shopsW = shopRow(set.get('shopsW'), 'shopsW', FOOTPRINTS.shopsW, 'e', 3101, 'plasterRose');
  blocks.shopsW2 = shopRow(set.get('shopsW2'), 'shopsW2', FOOTPRINTS.shopsW2, 'e', 3121, 'plasterCream');
  blocks.shopsE = shopRow(set.get('shopsE'), 'shopsE', FOOTPRINTS.shopsE, 'w', 3141, 'plasterOchre');
  blocks.shopsE2 = shopRow(set.get('shopsE2'), 'shopsE2', FOOTPRINTS.shopsE2, 'w', 3161, 'plasterSage', {
    // gap in the roof parapet where the plank bridge lands
    parapetGaps: [{ x0: 24, z0: 17.5, x1: 26, z1: 20.5 }],
  });
  blocks.warehouse = warehouse(set.get('warehouse'));
  blocks.offices = offices(set.get('offices'));
  garage(set.get('garage'));
  blocks.apartmentS = apartmentS(set.get('apartmentS'));

  // Roof crossing from the east shops on to the office block's second-floor
  // balcony — the plank that turns the east flank into a loop.
  plankBridge(set.get('bridges'), V3(24.6, 7.24, 19.4), V3(30.4, 6.86, 19.4), 1.2, 91);

  interiors.push(
    { x: 0, z: -47, y: 0, radius: 12, name: 'townHall' },
    { x: -43, z: -30, y: 0, radius: 8, name: 'terrace' },
    { x: 38, z: -20, y: 0, radius: 11, name: 'warehouse' },
    { x: -1, z: 45, y: 0, radius: 9, name: 'apartmentS' },
    { x: 40, z: 16, y: 0, radius: 9, name: 'offices' },
    { x: -20, z: -22, y: 0, radius: 5, name: 'shopsW' },
    { x: 20, z: -22, y: 0, radius: 5, name: 'shopsE' },
  );

  return { blocks, interiors };
}

/* ============================================================ town hall == */

function townHall(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.townHall;
  // Arcade geometry: six piers, five bays, symmetric about the centre line.
  const bays = 5;
  const pierW = 1.8;
  const width = f.x1 - f.x0;
  const span = (width - pierW * (bays + 1)) / bays;
  // The hall's floor is level with the raised terrace in front of it, so the
  // arcade is walkable straight off the square's steps.
  const baseY = SQUARE.terraceY;
  /**
   * Arcade section. Every number below is derived from one another so the
   * opening the wall cuts and the ring that dresses it can never disagree —
   * which is exactly how the old arcade ended up as five sawtooth holes with
   * detached voussoirs hanging over the void.
   *
   *   springY   impost / springing line
   *   bayR      intrados radius = half the clear span (a true semicircle)
   *   crownY    intrados apex
   *   ringD     archivolt depth, so the extrados is bayR + ringD
   *   cutTop    what `wall()` actually removes: one rectangle, span wide,
   *             reaching just past the extrados apex.
   *
   * Everything between the extrados and that rectangle is filled here as real
   * ashlar coursing, and everything between the intrados and the extrados is
   * filled by the voussoirs. The two overlap by construction, so no course
   * step is ever exposed and no voussoir is ever unsupported.
   */
  const bayR = span * 0.5;
  const springY = baseY + 2.05;
  const ringD = 0.30;
  const crownY = springY + bayR;
  const cutTop = crownY + ringD + 0.06;
  const bayCentreU: number[] = [];
  for (let i = 0; i < bays; i++) bayCentreU.push(pierW * (i + 1) + span * (i + 0.5));

  const spec: BlockSpec = {
    name: 'townHall',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 2,
    base: baseY,
    groundHeight: 5.0,
    storeyHeight: 4.4,
    wallKey: 'plasterOchre',
    groundKey: 'stone',
    innerKey: 'plasterIntWarm',
    trimKey: 'stoneTrim',
    plinthKey: 'stone',
    roofKind: 'pitched',
    roofKey: 'roofTile',
    ridgeAxis: 'x',
    ridgeRise: 3.0,
    thickness: 0.55,
    windowSpacing: 3.6,
    windowWidth: 1.35,
    windowHeight: 2.4,
    sill: 1.05,
    glazingDamage: 0.45,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    openSides: ['n', 'w', 's', 'e'],
    entrances: [{ side: 'n', at: 0, width: 1.5, missing: true }],
    interior: 'full',
    interiorFloorKey: 'stone',
    ceilingKey: 'plasterIntWarm',
    stairwell: { x: -12.5, z: -50.5, dir: '+z', width: 1.5 },
    holes: [{ side: 'e', at: -47, width: 2.6, level: 1, height: 2.6 }],
    // The arcade bays are cut out of the south wall; the arch rings are added
    // afterwards so the opening and the masonry agree.
    extraOpenings: bayCentreU.map((u) => ({
      side: 's' as const, at: f.x0 + u, width: span, y: baseY, height: cutTop - baseY, kind: 'arch' as const,
    })),
    downpipes: [{ x: f.x0 - 0.2, z: f.z1 + 0.2 }, { x: f.x1 + 0.2, z: f.z1 + 0.2 }],
    chimneys: [{ x: -9, z: -52, height: 1.9 }, { x: 9, z: -52, height: 1.9 }],
    seed: 2201,
  };
  const res = buildBlock(chunk, spec);

  /* --- south arcade: five arch rings on to the square, the hall's signature.
   *
   * `wall()` removes one rectangle per bay. `arcadeBay()` then puts the arch
   * back into that rectangle: ashlar spandrel coursing stepping down on to the
   * extrados, and a voussoir ring filling the annulus between extrados and
   * intrados. Because the courses stop on the extrados and the ring covers the
   * extrados outwards, every course step is behind masonry and every voussoir
   * has wall on both of its radial faces. That is the difference between an
   * arch and the crown-shaped hole with floating blocks this used to be.
   *
   * The bays are structurally identical — they have to be — so the variation
   * is in the ring: each has its own voussoir count and its own war damage. */
  const wallHalf = 0.55 * 0.5;
  const zFaceOut = f.z1 + wallHalf;
  const bayState: BayState[] = ['shelled', 'clean', 'noKey', 'blocked', 'shelledR'];
  const bayVoussoirs = [9, 13, 11, 9, 11];
  for (let i = 0; i < bayCentreU.length; i++) {
    arcadeBay(chunk, {
      cx: f.x0 + bayCentreU[i], zFace: zFaceOut, thickness: 0.55,
      baseY, springY, radius: bayR, ringDepth: ringD, cutTop,
      voussoirs: bayVoussoirs[i], state: bayState[i], seed: 2277 + i * 37,
    });
  }

  // The terrace runs through the arcade so the hall floor and the terrace are
  // one continuous surface.
  chunk.m('stone').boxMinMax(f.x0 + 0.2, -0.4, f.z1 - 1.2, f.x1 - 0.2, baseY, f.z1 + 0.2, 1.1);

  // --- arcade piers.
  //
  // The piers were bare 1.8 m boxes of wall: in the arcade shot the nearest one
  // is nearly half the frame as a single flat plane with a razor 90° corner and
  // nothing on it. Every real arcade pier has a plinth, an impost band at
  // springing and a chamfer or an angle shaft on its arris — three horizontals
  // and two highlights that turn a plane into architecture.
  const pierU: number[] = [];
  for (let i = 0; i <= bays; i++) pierU.push(pierW * (i + 0.5) + span * i);
  const pierT = chunk.m('stoneTrim');
  /**
   * The exterior face of a `wall()` run is at `z1 + thickness/2`, not `z1` —
   * the frame is centred on the footprint edge. Every moulding below used to be
   * authored against `f.z1` and was therefore 15 cm *inside* the masonry: the
   * plinth, the impost, the angle shafts, the lamp brackets and the whole inner
   * face treatment existed in the buffer and were invisible in every frame.
   */
  const zFace = f.z1 + wallHalf;
  for (let i = 0; i < pierU.length; i++) {
    const cx = f.x0 + pierU[i];
    const hwP = pierW * 0.5;
    // Plinth and its weathered cap.
    pierT.boxMinMax(cx - hwP - 0.09, baseY, zFace - 0.62, cx + hwP + 0.09, baseY + 0.62, zFace + 0.09, 1.0);
    pierT.boxMinMax(cx - hwP - 0.12, baseY + 0.62, zFace - 0.64, cx + hwP + 0.12, baseY + 0.74, zFace + 0.12, 1.0);
    // Impost band, its top course level with the springing line so the ring
    // visibly lands on it.
    pierT.boxMinMax(cx - hwP - 0.10, springY - 0.30, zFace - 0.64, cx + hwP + 0.10, springY + 0.02, zFace + 0.10, 1.0);
    // Angle shafts on both arrises: the chamfer the corner never had.
    for (const sx of [-1, 1]) {
      pierT.pushTRS(cx + sx * hwP, baseY + 0.74, zFace + 0.02, Math.PI * 0.25);
      pierT.cylinder(0.10, 0.09, springY - 1.06 - baseY, 6, false, false, 0.5);
      pierT.pop();
    }
    // Iron lamp bracket on alternate piers.
    if (i % 2 === 1) {
      const br = chunk.m('rust');
      br.boxMinMax(cx - 0.03, springY + 0.1, zFace - 0.02, cx + 0.03, springY + 0.16, zFace + 0.52, 0.4);
      br.box(cx, springY - 0.02, zFace + 0.48, 0.11, 0.13, 0.11, 0.3);
    } else {
      // Cast-iron rainwater pipe with its hopper and two ears, hard against
      // the arris — the vertical the pier face never had.
      const dp = chunk.m('pipe');
      dp.pushTRS(cx - hwP + 0.11, baseY + 0.74, zFace + 0.11);
      dp.cylinder(0.055, 0.055, springY - 0.9 - baseY, 8, false, false, 0.4);
      dp.pop();
      dp.box(cx - hwP + 0.11, springY - 0.14, zFace + 0.11, 0.09, 0.14, 0.09, 0.3);
      for (const hy of [baseY + 1.1, baseY + 2.0]) {
        dp.box(cx - hwP + 0.11, hy, zFace + 0.06, 0.075, 0.03, 0.06, 0.2);
      }
    }
    // Painted notice board or a stone dedication plaque, alternating: the pier
    // face is 1.8 m wide and 3.5 m tall and needs *something* on it.
    if (i === 1 || i === 4) {
      const bd = chunk.m('plywood');
      bd.box(cx + 0.06, baseY + 1.62, zFace + 0.055, 0.42, 0.56, 0.03, { unit: true });
      const fr = chunk.m('wood');
      for (const sy of [-1, 1]) bd.box(cx + 0.06, baseY + 1.62 + sy * 0.58, zFace + 0.05, 0.45, 0.025, 0.035, 0.2);
      void fr;
    } else if (i === 2 || i === 5) {
      const pl = chunk.m('stoneTrim');
      pl.box(cx, baseY + 1.9, zFace + 0.05, 0.34, 0.24, 0.035, 0.5);
      pl.box(cx, baseY + 1.9, zFace + 0.06, 0.30, 0.20, 0.02, 0.4);
    }
    // Corbel under the soffit springing, breaking the top of the plane.
    pierT.pushTRS(cx, springY + 0.02, zFace + 0.02);
    pierT.box(0, 0.10, 0.09, hwP * 0.42, 0.10, 0.11, 0.4);
    pierT.box(0, 0.24, 0.13, hwP * 0.52, 0.055, 0.16, 0.4);
    pierT.pop();

    // --- inner face -----------------------------------------------------
    // The arcade vantage looks *out* from under the vault, so what fills that
    // frame is the north face of the pier, not the south one. It gets the same
    // treatment: a hand rail, a notice, conduit, and a bench where the arcade
    // was used as a shelter.
    const zIn = zFace - 0.55;
    if (i % 2 === 0) {
      // Mobilisation notices: a small framed board with two bills pasted on.
      const bd = chunk.m('canvasCream');
      bd.box(cx - 0.28, baseY + 1.78, zIn - 0.045, 0.21, 0.29, 0.02, { unit: true });
      bd.box(cx + 0.16, baseY + 1.62, zIn - 0.045, 0.16, 0.22, 0.02, { unit: true });
      const fr = chunk.m('wood');
      for (const sy of [-1, 1]) fr.box(cx - 0.06, baseY + 1.74 + sy * 0.42, zIn - 0.038, 0.44, 0.026, 0.032, 0.2);
      for (const sx of [-1, 1]) fr.box(cx - 0.06 + sx * 0.44, baseY + 1.74, zIn - 0.038, 0.026, 0.42, 0.032, 0.2);
    } else {
      const pl = chunk.m('stoneTrim');
      pl.box(cx, baseY + 2.05, zIn - 0.04, 0.38, 0.28, 0.04, 0.5);
      pl.box(cx, baseY + 2.05, zIn - 0.06, 0.33, 0.23, 0.02, 0.4);
    }
    // Conduit drop with two saddles and a switch box, hard against one arris.
    const cd = chunk.m('pipe');
    cd.pushTRS(cx + hwP - 0.13, baseY + 0.78, zIn - 0.06);
    cd.cylinder(0.026, 0.026, springY - 1.1 - baseY, 6, false, false, 0.3);
    cd.pop();
    cd.box(cx + hwP - 0.13, baseY + 1.25, zIn - 0.075, 0.075, 0.11, 0.045, 0.2);
    // Hand rail bolted across the pier at 0.95 m, the way a shelter gets used.
    const rl = chunk.m('rust');
    rl.pushTRS(cx, baseY + 0.98, zIn - 0.12, 0, 0, Math.PI / 2);
    rl.cylinder(0.024, 0.024, pierW + 0.24, 7, false, false, 0.3);
    rl.pop();
    for (const sx of [-1, 1]) {
      rl.box(cx + sx * (hwP - 0.05), baseY + 0.98, zIn - 0.06, 0.03, 0.03, 0.07, 0.2);
    }
    // Plinth return so the base wraps on to the inner face as well.
    pierT.boxMinMax(cx - hwP - 0.09, baseY, zIn - 0.10, cx + hwP + 0.09, baseY + 0.5, zIn + 0.02, 1.0);
  }

  // --- raised terrace in front, with balustrade and two flights of steps.
  const t = chunk.m('stone');
  // 1.1 m per texture repeat, not 2.4: at 2.4 the terrace slabs were 2 m across
  // and the whole deck read as one featureless plane in the north-street shot.
  t.boxMinMax(f.x0 - 1.5, -0.4, SQUARE.terraceZ0, f.x1 + 1.5, SQUARE.terraceY, SQUARE.terraceZ1, 1.1);
  const bal = chunk.m('stoneTrim');
  // Balustrade along the square edge, with gaps for the steps and one bay
  // blown out — a continuous run of identical turned balusters was a repeat in
  // its own right, and the gap gives the terrace a story.
  const gaps = [[-9.5, -5.5], [5.5, 9.5], [-16.4, -13.1]];
  const seg = 0.55;
  const balRand = new Rand(2299);
  for (let x = f.x0 - 1.5; x < f.x1 + 1.5; x += seg) {
    if (gaps.some((g) => x > g[0] - 0.3 && x < g[1] + 0.3)) continue;
    const lean = balRand.bool(0.12) ? balRand.range(-0.2, 0.2) : 0;
    bal.pushTRS(x + seg * 0.5, SQUARE.terraceY + 0.42, SQUARE.terraceZ1 - 0.22, 0, 0, lean);
    bal.cylinder(0.09, 0.075, 0.72, 8, false, false, 0.4);
    bal.pop();
  }
  for (const [gx0, gx1] of [[f.x0 - 1.5, -16.4], [-13.1, -9.5], [-5.5, 5.5], [9.5, f.x1 + 1.5]]) {
    bal.boxMinMax(gx0, SQUARE.terraceY + 0.78, SQUARE.terraceZ1 - 0.36, gx1, SQUARE.terraceY + 0.92, SQUARE.terraceZ1 - 0.06, 1.2);
    bal.boxMinMax(gx0, SQUARE.terraceY, SQUARE.terraceZ1 - 0.36, gx1, SQUARE.terraceY + 0.12, SQUARE.terraceZ1 - 0.06, 1.2);
  }
  // The blown-out bay: coping fallen on to the terrace deck, a bent rail stub.
  const fall = chunk.m('stoneTrim');
  for (let i = 0; i < 5; i++) {
    const px = -15.9 + i * 0.62 + balRand.range(-0.2, 0.2);
    const pz = SQUARE.terraceZ1 - balRand.range(0.5, 1.5);
    fall.pushTRS(px, SQUARE.terraceY + 0.08, pz,
      balRand.range(0, 6.28), balRand.range(-0.35, 0.35), balRand.range(-0.4, 0.4));
    fall.box(0, 0, 0, balRand.range(0.16, 0.4), 0.07, balRand.range(0.1, 0.18), 0.6);
    fall.pop();
  }
  for (const cx of [-7.5, 7.5]) {
    stairs(chunk, {
      key: 'stone', dir: '-z', x: cx, z: SQUARE.terraceZ1 + 0.02,
      yBottom: 0, yTop: SQUARE.terraceY, width: 3.6, riser: 0.156, going: 0.34,
    });
  }

  // --- clock tower: the map's tallest landmark, visible from every lane.
  const tx = 0, tz = f.z0 + 3.2;
  const towerTop = 21.5;
  const towerStone = chunk.m('stoneTrim');
  const hw = 2.6;
  for (const [ax, az, bx, bz] of [
    [tx + hw, tz - hw, tx - hw, tz - hw],
    [tx - hw, tz - hw, tx - hw, tz + hw],
    [tx - hw, tz + hw, tx + hw, tz + hw],
    [tx + hw, tz + hw, tx + hw, tz - hw],
  ]) {
    const frame = new WallFrame(ax, az, bx, bz);
    const openings: Opening[] = [
      { u: hw, width: 1.1, sill: 15.6, height: 2.3, kind: 'window', broken: 0.6 },
      { u: hw, width: 1.6, sill: 18.6, height: 1.6, kind: 'hole', noTrim: true },
    ];
    wall(chunk, frame, {
      key: 'plasterOchre', y0: 8.0, y1: towerTop, thickness: 0.5,
      openings, trimKey: 'stoneTrim', innerKey: 'plasterIntWarm',
    });
    windowUnit(chunk, frame, openings[0], { wallThickness: 0.5, broken: 0.6, cols: 2, rows: 3, seed: 771 });
    // clock face
    const clock = chunk.m('stoneTrim');
    clock.push(frame.matrix);
    clock.pushTRS(hw, 17.4, 0.28);
    clock.cylinder(0.95, 0.95, 0.12, 16, true, false, 0.6);
    clock.pop();
    clock.pop();
  }
  towerStone.boxMinMax(tx - hw - 0.3, towerTop, tz - hw - 0.3, tx + hw + 0.3, towerTop + 0.32, tz + hw + 0.3, 1.4);
  // spire
  const spire = chunk.m('sheet');
  spire.pushTRS(tx, towerTop + 2.4, tz);
  spire.cylinder(hw + 0.2, 0.06, 4.6, 4, false, true, 1.6);
  spire.pop();
  spire.pushTRS(tx, towerTop + 5.2, tz);
  spire.cylinder(0.05, 0.05, 1.2, 4, false, false, 0.4);
  spire.pop();

  // --- interior: first-floor gallery railing around the stairwell void.
  railing(chunk, 'rust', [
    V3(-14.6, 5.0, -49.0), V3(-10.4, 5.0, -49.0), V3(-10.4, 5.0, -52.2),
  ], 1.0, 'ornate');

  return res;
}

/* ------------------------------------------------------- arcade bay ----- */

type BayState = 'clean' | 'shelled' | 'shelledR' | 'noKey' | 'blocked';

interface BayOptions {
  /** World X of the bay's centre line. */
  cx: number;
  /** World Z of the wall's *exterior* face (footprint edge + thickness/2). */
  zFace: number;
  thickness: number;
  baseY: number;
  /** Impost / springing line. */
  springY: number;
  /** Intrados radius — half the clear span, so the head is a true semicircle. */
  radius: number;
  /** Radial depth of the archivolt. */
  ringDepth: number;
  /** Top of the rectangle `wall()` removed for this bay. */
  cutTop: number;
  /** Odd, so one block always lands on the crown and becomes the keystone. */
  voussoirs: number;
  state: BayState;
  seed: number;
}

/**
 * One arcade bay: spandrel, archivolt, keystone and war damage.
 *
 * The wall builder can only remove rectangles, so a bay arrives here as a
 * `span × (cutTop − baseY)` hole. This puts the arch back, and the two halves
 * are sized off each other so they cannot disagree:
 *
 *  - **Spandrel.** Horizontal ashlar courses from each jamb inwards. A course
 *    stops at the extrados height of *its own top edge*, so it always overlaps
 *    inwards into the ring's annulus and never into the opening. The deepest
 *    bite is `sqrt(rEx² − (yTop² − yBot²))`, which for an 11 cm course on a
 *    2.6 m extrados is 2.52 m — comfortably outside the 2.32 m intrados.
 *  - **Archivolt.** `voussoirs` radial blocks filling intrados→extrados over
 *    the full 180°, proud of the wall face, so every course step above them is
 *    behind masonry and every block has wall on both radial faces.
 *
 * That is the whole fix for the crown-shaped holes: previously the ring sat on
 * a circle while the wall was cut as a stepped polygon, so the blocks over the
 * void had nothing behind them and the steps showed as a sawtooth.
 */
function arcadeBay(chunk: Chunk, o: BayOptions): void {
  const { cx, zFace, thickness, baseY, springY, radius: r, cutTop } = o;
  const zBack = zFace - thickness;
  const rEx = r + o.ringDepth;
  const rand = new Rand(o.seed);

  /* --- spandrel coursing ---------------------------------------------- */
  const ash = chunk.m('stone');
  const course = 0.11;
  const yFoot = springY + Math.sqrt(Math.max(0, rEx * rEx - r * r));
  for (let y = yFoot; y < cutTop - 1e-4; y += course) {
    const yb = Math.min(y + course, cutTop);
    const h = yb - springY;
    const g = h >= rEx ? 0 : Math.sqrt(Math.max(0, rEx * rEx - h * h));
    if (g >= r - 1e-3) continue;
    // 2 cm into the pier on each side so the jamb faces are never coplanar.
    ash.boxMinMax(cx - r - 0.02, y, zBack, cx - g, yb, zFace, 4.2);
    ash.boxMinMax(cx + g, y, zBack, cx + r + 0.02, yb, zFace, 4.2);
  }

  /* --- archivolt -------------------------------------------------------- */
  const ring = chunk.m('stoneTrim');
  const n = o.voussoirs;
  const dth = Math.PI / n;
  const rIn = r - 0.02;
  const keyIdx = (n - 1) >> 1;
  const gone = new Set<number>();
  if (o.state === 'noKey') gone.add(keyIdx);
  if (o.state === 'shelled') { gone.add(1); gone.add(2); }
  if (o.state === 'shelledR') { gone.add(n - 2); gone.add(n - 3); }

  for (let k = 0; k < n; k++) {
    const th = (k + 0.5) * dth;
    const isKey = k === keyIdx && o.state !== 'noKey';
    // Alternate blocks stand a couple of centimetres proud: at 25 m that is
    // the only thing that separates a ring of voussoirs from a smooth band.
    const alt = k % 2 === 0 ? 0 : 0.022;
    const missing = gone.has(k);
    const rOut = missing ? rEx : rEx + 0.02 + (isKey ? 0.15 : alt);
    const rc = (rIn + rOut) * 0.5;
    const halfR = (rOut - rIn) * 0.5;
    const hw = rc * Math.tan(dth * 0.5) * (isKey ? 1.24 : 1.05);
    // A blown-out voussoir leaves a sooted socket, not a hole through the wall.
    const front = missing ? zFace - 0.15 : zFace + 0.09 + (isKey ? 0.045 : alt);
    const m = missing ? chunk.m('brickSoot') : ring;
    m.pushTRS(cx + Math.cos(th) * rc, springY + Math.sin(th) * rc,
      (front + zBack) * 0.5, 0, 0, th);
    m.box(0, 0, 0, halfR, hw, (front - zBack) * 0.5, missing ? 0.9 : 1.2);
    m.pop();
  }

  /* Hood mould over the extrados. A ring of voussoirs in the same stone as the
   * spandrel is only 30 cm of value difference at 20 m; the label is what
   * actually draws the arch, because it throws a hard 13 cm shadow line on to
   * the wall behind it whatever the sun is doing. */
  const hoodSeg = 26;
  for (let k = 0; k < hoodSeg; k++) {
    const th = ((k + 0.5) / hoodSeg) * Math.PI;
    const rc = rEx + 0.055;
    const hw = rc * Math.tan((Math.PI / hoodSeg) * 0.5) * 1.06;
    ring.pushTRS(cx + Math.cos(th) * rc, springY + Math.sin(th) * rc, zFace + 0.055, 0, 0, th);
    ring.box(0, 0, 0, 0.055, hw, 0.075, 0.5);
    ring.pop();
  }
  // Label stops: a corbel where the hood dies into the pier on both sides.
  for (const sx of [-1, 1]) {
    ring.box(cx + sx * (rEx + 0.03), springY - 0.02, zFace + 0.05, 0.10, 0.13, 0.09, 0.4);
  }

  /* --- damage ----------------------------------------------------------- */
  if (o.state === 'shelled' || o.state === 'shelledR') {
    // The blocks that came out of the ring are lying on the terrace deck under
    // it, keyed against the pier — not hanging in mid-air over the void.
    const rub = chunk.m('stoneTrim');
    const side = o.state === 'shelled' ? 1 : -1;
    for (let i = 0; i < 4; i++) {
      const px = cx + side * (r - rand.range(0.15, 1.1));
      rub.pushTRS(px, baseY + 0.11, zFace + rand.range(0.35, 1.15),
        rand.range(0, Math.PI), rand.range(-0.12, 0.12), rand.range(-0.25, 0.25));
      rub.box(0, 0, 0, rand.range(0.19, 0.30), 0.10, rand.range(0.13, 0.20), 0.6);
      rub.pop();
    }
    // Crack running up out of the socket into the spandrel.
    const cr = chunk.m('brickSoot');
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      cr.boxMinMax(cx + side * (1.55 + t * 0.55) - 0.05, yFoot + t * 0.7 - 0.03, zFace - 0.03,
        cx + side * (1.55 + t * 0.55) + 0.05, yFoot + t * 0.7 + 0.03, zFace + 0.012, 0.5);
    }
  }
  if (o.state === 'noKey') {
    // Keystone gone: the two blocks either side are propped by a timber raker
    // off the terrace, which is what actually holds a de-keyed arch up.
    const tim = chunk.m('plank');
    for (const sx of [-1, 1]) {
      const ax = cx + sx * 0.55, ay = springY + rEx - 0.25;
      const bx = cx + sx * 2.0, by = baseY;
      const len = Math.hypot(ax - bx, ay - by);
      tim.pushTRS((ax + bx) * 0.5, (ay + by) * 0.5, zFace + 0.16,
        0, 0, Math.atan2(ay - by, ax - bx));
      tim.box(0, 0, 0, len * 0.5, 0.055, 0.055, 0.8);
      tim.pop();
    }
  }
  if (o.state === 'blocked') {
    /* Bricked up: a rectangle to the springing plus courses following the
     * intrados, all set 0.14 back so the reveal reads, with a firing slot cut
     * out of it at chest height. The head courses overlap outwards into the
     * annulus, where the ring hides them. */
    const b = chunk.m('brickPale');
    const zf = zFace - 0.14;
    const slotY0 = baseY + 1.05, slotY1 = baseY + 1.42;
    const slotHalf = 0.30;
    for (let y = baseY; y < springY - 1e-4; y += course) {
      const yb = Math.min(y + course, springY);
      if (yb > slotY0 && y < slotY1) {
        b.boxMinMax(cx - r + 0.03, y, zBack, cx - slotHalf, yb, zf, 1.0);
        b.boxMinMax(cx + slotHalf, y, zBack, cx + r - 0.03, yb, zf, 1.0);
      } else {
        b.boxMinMax(cx - r + 0.03, y, zBack, cx + r - 0.03, yb, zf, 1.0);
      }
    }
    for (let y = springY; y < springY + r - 1e-4; y += course) {
      const yb = Math.min(y + course, springY + r);
      const g = Math.sqrt(Math.max(0, r * r - (y - springY) * (y - springY)));
      b.boxMinMax(cx - g - 0.03, y, zBack, cx + g + 0.03, yb, zf, 1.0);
    }
    // Sandbag course along the foot of the blocking, on the terrace side.
    const sb = chunk.m('sandbag');
    for (let i = 0; i < 7; i++) {
      const px = cx - r + 0.45 + i * 0.62;
      sb.pushTRS(px, baseY + 0.16, zFace + 0.26, rand.range(-0.15, 0.15));
      sb.box(0, 0, 0, 0.33, 0.15, 0.20, 0.7);
      sb.pop();
    }
  }
}

/* =============================================================== clinic == */

function clinic(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.clinic;
  return buildBlock(chunk, {
    name: 'clinic',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 3,
    wallKey: 'plasterBlue',
    groundKey: 'concrete',
    innerKey: 'plasterInt',
    trimKey: 'concrete',
    plinthKey: 'concreteDark',
    roofKind: 'flat',
    roofKey: 'roofFelt',
    windowSpacing: 2.8,
    windowWidth: 1.3,
    glazingDamage: 0.55,
    boardedChance: 0.22,
    openSides: ['w', 's', 'e', 'n'],
    entrances: [{ side: 's', at: 34, width: 1.6, open: 1.9 }],
    interior: 'full',
    interiorFloorKey: 'concrete',
    ceilingKey: 'plasterInt',
    stairwell: { x: 27.5, z: -44.0, dir: '+x', width: 1.3 },
    partitions: [
      { x0: 34, z0: -55, x1: 34, z1: -40, level: 0, door: 6.5 },
      { x0: 40, z0: -55, x1: 40, z1: -40, level: 1, door: 8.5 },
    ],
    holes: [
      { side: 's', at: 42, width: 3.0, level: 2, height: 2.4 },
      { side: 'e', at: -46, width: 2.4, level: 1, height: 2.2 },
    ],
    raggedSides: ['e'],
    raggedAmount: 1.4,
    downpipes: [{ x: f.x0 - 0.2, z: f.z1 + 0.2 }, { x: f.x1 + 0.2, z: f.z0 - 0.2 }],
    seed: 2311,
  });
}

/* ======================================================== west terrace == */

/**
 * Three party-wall blocks sharing one continuous roof — the rooftop route.
 * Party walls are owned by the block to the north so nothing z-fights, and the
 * parapets between them are gapped so the roof is genuinely walkable.
 */
function westTerrace(set: ChunkSet): Record<string, BlockResult> {
  const n = FOOTPRINTS.terraceN;
  const m = FOOTPRINTS.terraceM;
  const s = FOOTPRINTS.terraceS;
  const out: Record<string, BlockResult> = {};
  const chunkN = set.get('terraceN');
  const chunkM = set.get('terraceM');
  const chunkS = set.get('terraceS');

  const shared = {
    storeys: 3,
    groundHeight: 3.5,
    storeyHeight: 3.15,
    innerKey: 'plasterInt' as MatKey,
    trimKey: 'stoneTrim' as MatKey,
    plinthKey: 'stone' as MatKey,
    roofKind: 'flat' as const,
    roofKey: 'roofFelt' as MatKey,
    windowSpacing: 2.95,
    windowWidth: 1.2,
    interior: 'full' as const,
    interiorFloorKey: 'plank' as MatKey,
    ceilingKey: 'plasterInt' as MatKey,
    parapetHeight: 0.95,
  };

  out.terraceN = buildBlock(chunkN, {
    ...shared,
    name: 'terraceN',
    x0: n.x0, z0: n.z0, x1: n.x1, z1: n.z1,
    wallKey: 'plasterCream',
    groundKey: 'brickPale',
    omitSides: ['s'],
    blindSides: ['s'],
    glazingDamage: 0.35,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    entrances: [{ side: 'e', at: -47, width: 1.3, open: 1.5 }],
    balconies: [
      { side: 'e', at: -50, width: 2.4, level: 1 },
      { side: 'e', at: -43, width: 2.4, level: 2 },
    ],
    stairwell: { x: -48.6, z: -52.0, dir: '+z', width: 1.25 },
    partitions: [{ x0: -44, z0: -55, x1: -44, z1: -37, level: 1, door: 9 }],
    parapetGaps: [{ x0: n.x0 - 1, z0: n.z1 - 1, x1: n.x1 + 1, z1: n.z1 + 1 }],
    downpipes: [{ x: n.x1 + 0.2, z: n.z0 - 0.2 }],
    seed: 2401,
  });

  out.terraceM = buildBlock(chunkM, {
    ...shared,
    name: 'terraceM',
    x0: m.x0, z0: m.z0, x1: m.x1, z1: m.z1,
    wallKey: 'plasterRose',
    groundKey: 'brick',
    omitSides: ['n'],
    blindSides: ['n', 's'],
    glazingDamage: 0.6,
    boardedChance: 0.18,
    balconies: [{ side: 'e', at: -32, width: 2.6, level: 2 }],
    holes: [{ side: 'e', at: -27, width: 3.2, level: 2, height: 2.6 }],
    // The blown roof hole is the rooftop route's way back inside.
    roofHole: { x0: -46, z0: -32, x1: -42, z1: -28 },
    parapetGaps: [
      { x0: m.x0 - 1, z0: m.z0 - 1, x1: m.x1 + 1, z1: m.z0 + 1 },
      { x0: m.x0 - 1, z0: m.z1 - 1, x1: m.x1 + 1, z1: m.z1 + 1 },
    ],
    seed: 2411,
  });

  out.terraceS = buildBlock(chunkS, {
    ...shared,
    name: 'terraceS',
    x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1,
    wallKey: 'plasterCream',
    groundKey: 'brickPale',
    omitSides: ['n'],
    blindSides: ['n'],
    glazingDamage: 0.45,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    entrances: [{ side: 'e', at: -12, width: 1.3, open: 1.1 }],
    shopfronts: [{ side: 'e', at: -18, width: 4.2, broken: 0.55 }],
    balconies: [{ side: 'e', at: -9, width: 2.4, level: 2 }],
    stairwell: { x: -48.6, z: -12.0, dir: '-z', width: 1.25 },
    parapetGaps: [
      { x0: s.x0 - 1, z0: s.z0 - 1, x1: s.x1 + 1, z1: s.z0 + 1 },
      // gap where the fire escape lands on the roof
      { x0: s.x1 - 2.6, z0: s.z1 - 4.4, x1: s.x1 + 1, z1: s.z1 - 1.6 },
    ],
    chimneys: [{ x: -46, z: -8, height: 1.7 }],
    downpipes: [{ x: s.x1 + 0.2, z: s.z1 + 0.2 }],
    seed: 2421,
  });

  // Fire escape climbing the east face of the south block up to the roof.
  const eastFrame = rectWalls(s.x0, s.z0, s.x1, s.z1)[3];
  const eaveY = out.terraceS.eaveY;
  fireEscape(chunkS, eastFrame, 3.0, [3.5, 6.65, 9.8], 1.7, 1.4);
  ladder(chunkS, 'rust', s.x1 + 0.85, s.z1 - 3.0, 9.8, eaveY + 0.7, Math.PI / 2, 0.5);

  // Rooftop dressing that also blocks the long roof sightline.
  const rp = chunkM.m('brickSoot');
  rp.boxMinMax(-46.5, eaveY, -44.0, -44.5, eaveY + 1.5, -43.4, 1.6);
  rp.boxMinMax(-42.0, eaveY, -19.5, -40.4, eaveY + 1.35, -19.0, 1.6);

  return out;
}

/* ================================================================= café == */

function cafe(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.cafe;
  const res = buildBlock(chunk, {
    name: 'cafe',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 2,
    groundHeight: 3.7,
    storeyHeight: 3.1,
    wallKey: 'plasterSage',
    groundKey: 'plasterSage',
    innerKey: 'plasterIntWarm',
    trimKey: 'stoneTrim',
    plinthKey: 'stone',
    roofKind: 'pitched',
    roofKey: 'roofTile',
    ridgeAxis: 'z',
    ridgeRise: 2.2,
    windowSpacing: 2.7,
    glazingDamage: 0.3,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    openSides: ['n', 'w', 's', 'e'],
    shopfronts: [{ side: 'e', at: 3, width: 5.4, broken: 0.4, signKey: 'signGlow' }],
    entrances: [{ side: 'e', at: 9, width: 1.2, open: 1.4 }],
    interior: 'full',
    interiorFloorKey: 'plank',
    ceilingKey: 'plasterIntWarm',
    stairwell: { x: -48.4, z: 9.0, dir: '-z', width: 1.2 },
    chimneys: [{ x: -46, z: 10, height: 1.8 }],
    downpipes: [{ x: f.x1 + 0.2, z: f.z0 - 0.2 }],
    seed: 2501,
  });

  // Café terrace: a low wall and planter strip that breaks the long lane-A line.
  const lowWall = chunk.m('brickPale');
  lowWall.boxMinMax(-36.6, 0, -1.5, -36.0, 0.85, 11.5, 1.4);
  const cap = chunk.m('stoneTrim');
  cap.boxMinMax(-36.75, 0.85, -1.5, -35.85, 0.98, 11.5, 1.2);
  return res;
}

/* ======================================================== apartment SW == */

function apartmentSW(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.apartmentSW;
  return buildBlock(chunk, {
    name: 'apartmentSW',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 2,
    wallKey: 'brick',
    groundKey: 'brickSoot',
    innerKey: 'plasterInt',
    trimKey: 'stoneTrim',
    plinthKey: 'concreteDark',
    roofKind: 'flat',
    roofKey: 'roofFelt',
    windowSpacing: 3.0,
    glazingDamage: 0.85,
    boardedChance: 0.3,
    entrances: [{ side: 'n', at: -40, width: 1.3, missing: true }],
    interior: 'full',
    interiorFloorKey: 'plank',
    ceilingKey: 'plasterInt',
    stairwell: { x: -48.0, z: 20.5, dir: '+z', width: 1.2 },
    holes: [
      { side: 'n', at: -44, width: 3.4, level: 1, height: 2.6 },
      { side: 'e', at: 24, width: 2.6, level: 0, height: 2.4 },
    ],
    raggedSides: ['n', 'e'],
    raggedAmount: 1.6,
    cornerCollapse: { x: -34.5, z: 30.5, radius: 4.4 },
    parapetGaps: [{ x0: -38, z0: 27, x1: -33, z1: 31 }],
    seed: 2601,
  });
}

/* ============================================================== SW ruin == */

/** A roofless shell: three ragged walls, a fallen slab and a lot of rubble. */
function ruinSW(chunk: Chunk): void {
  const f = FOOTPRINTS.ruinSW;
  const rand = new Rand(2701);
  const walls = rectWalls(f.x0, f.z0, f.x1, f.z1);
  const heights = [4.6, 6.2, 2.4, 5.4];
  for (let i = 0; i < 4; i++) {
    if (i === 2) continue; // south wall is gone entirely
    const openings: Opening[] = [];
    const len = walls[i].length;
    const count = Math.max(1, Math.floor(len / 4.2));
    for (let k = 0; k < count; k++) {
      const u = (len / count) * (k + 0.5);
      openings.push({
        u, width: rand.range(1.2, 2.4), sill: rand.range(0.9, 1.4),
        height: rand.range(1.6, 2.4), kind: 'hole', noTrim: true,
      });
    }
    wall(chunk, walls[i], {
      key: 'brickSoot', y0: -0.4, y1: heights[i], thickness: 0.42,
      openings, ragged: { amplitude: 1.8, seed: 2711 + i, rebar: true },
      innerKey: 'brickSoot',
    });
  }
  // fallen floor slab leaning into the shell
  const slabM = chunk.m('concreteDark');
  slabM.pushTRS(f.x0 + 6.5, 1.6, f.z0 + 7.0, 0.4, 0, 0.62);
  slabM.box(0, 0, 0, 4.2, 0.15, 3.0, 2.4);
  slabM.pop();
  // rubble heap
  for (let i = 0; i < 90; i++) {
    const x = rand.range(f.x0 + 0.5, f.x1 - 0.5);
    const z = rand.range(f.z0 + 0.5, f.z1 - 0.5);
    const s = rand.range(0.16, 0.55);
    const key = rand.bool(0.55) ? 'brickSoot' : 'concreteDark';
    const mm = chunk.m(key);
    mm.pushTRS(x, s * 0.5, z, rand.next() * Math.PI, rand.range(-0.4, 0.4), rand.range(-0.4, 0.4));
    mm.box(0, 0, 0, s, s * rand.range(0.4, 0.8), s * rand.range(0.6, 1.4), 1.0);
    mm.pop();
  }
}

/* =========================================================== shop rows == */

/**
 * A two-storey terrace of shop units. `front` is the side that faces the
 * square: it gets the shopfronts, the fascia and the balconies; the opposite
 * side gets service doors on to the flanking lane.
 */
function shopRow(
  chunk: Chunk, name: string, f: { x0: number; z0: number; x1: number; z1: number },
  front: 'e' | 'w', seed: number, wallKey: BlockSpec['wallKey'],
  overrides: Partial<BlockSpec> = {},
): BlockResult {
  const back = front === 'e' ? 'w' : 'e';
  const frontX = front === 'e' ? f.x1 : f.x0;
  const backX = front === 'e' ? f.x0 : f.x1;
  const rand = new Rand(seed);
  const depth = f.z1 - f.z0;
  const units = Math.max(2, Math.round(depth / 8));
  const shopfronts: NonNullable<BlockSpec['shopfronts']>[number][] = [];
  const entrances: NonNullable<BlockSpec['entrances']>[number][] = [];
  const balconies: NonNullable<BlockSpec['balconies']>[number][] = [];
  for (let i = 0; i < units; i++) {
    const z = f.z0 + (depth * (i + 0.5)) / units;
    shopfronts.push({ side: front, at: z, width: 4.0, broken: rand.range(0.25, 0.75) });
    entrances.push({ side: back, at: z + 2.2, width: 1.15, open: rand.range(0.4, 1.7), missing: rand.bool(0.25) });
    if (rand.bool(0.6)) balconies.push({ side: front, at: z, width: 2.4, level: 1, depth: 1.0 });
  }

  const res = buildBlock(chunk, {
    name,
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 2,
    groundHeight: 3.9,
    storeyHeight: 3.3,
    wallKey,
    groundKey: 'plasterGrey',
    innerKey: 'plasterInt',
    trimKey: 'stoneTrim',
    plinthKey: 'stone',
    roofKind: 'flat',
    roofKey: 'roofFelt',
    parapetHeight: 0.95,
    windowSpacing: 2.7,
    windowWidth: 1.15,
    glazingDamage: 0.5,
    boardedChance: 0.2,
    shopfronts,
    entrances,
    balconies,
    interior: 'full',
    interiorFloorKey: 'concrete',
    ceilingKey: 'plasterInt',
    stairwell: { x: backX + (front === 'e' ? 2.0 : -2.0), z: f.z0 + 2.4, dir: '+z', width: 1.2 },
    holes: rand.bool(0.6) ? [{ side: front, at: f.z0 + depth * 0.75, width: 2.8, level: 1, height: 2.4 }] : [],
    raggedSides: rand.bool(0.5) ? [front] : [],
    raggedAmount: 1.0,
    downpipes: [{ x: frontX + (front === 'e' ? 0.2 : -0.2), z: f.z0 - 0.2 }],
    seed,
    ...overrides,
  });

  // Roof access hatch housing so the roof reads as reachable.
  const hut = chunk.m('brickSoot');
  const hx = backX + (front === 'e' ? 2.0 : -2.0);
  hut.boxMinMax(hx - 1.1, res.eaveY, f.z0 + 1.2, hx + 1.1, res.eaveY + 2.1, f.z0 + 3.6, 1.6);
  ladder(chunk, 'rust', hx, f.z0 + 3.75, res.eaveY, res.eaveY + 2.3, 0, 0.5);

  return res;
}

/* ============================================================ warehouse == */

/**
 * One tall volume with a mezzanine — the east lane's interior fight. Roller
 * door on to lane C, clerestory band that throws late sun across the floor, an
 * external stair to the roof and a shot-out section of roof deck for light.
 */
function warehouse(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.warehouse;
  const eave = 9.2;
  const res = buildBlock(chunk, {
    name: 'warehouse',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 1,
    groundHeight: eave,
    wallKey: 'concrete',
    groundKey: 'concrete',
    innerKey: 'concreteDark',
    trimKey: 'concreteDark',
    plinthKey: 'concreteDark',
    roofKind: 'flat',
    roofKey: 'roofFelt',
    parapetHeight: 0.7,
    thickness: 0.42,
    windowSpacing: 4.6,
    windowWidth: 2.2,
    windowHeight: 1.5,
    sill: 6.4,
    glazingDamage: 0.7,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    openSides: ['n', 'w', 's', 'e'],
    entrances: [{ side: 'w', at: -12, width: 1.4, open: 1.8 }],
    extraOpenings: [
      { side: 'w', at: -22, width: 4.8, y: 0, height: 4.6 },   // roller door bay
      { side: 's', at: 40, width: 3.2, y: 0, height: 3.2 },    // blown-out south wall
      { side: 'e', at: -14, width: 2.4, y: 0, height: 2.6 },   // rear service door
    ],
    interior: 'ground',
    interiorFloorKey: 'concrete',
    ceilingKey: 'concreteDark',
    roofHole: { x0: 38, z0: -22, x1: 43, z1: -17 },
    seed: 2801,
  });

  // roller door: slats half-raised in the west bay
  const door = chunk.m('sheet');
  const west = rectWalls(f.x0, f.z0, f.x1, f.z1)[1];
  door.push(west.matrix);
  const doorU = -22 - f.z0;
  for (let i = 0; i < 9; i++) {
    door.box(doorU, 2.62 + i * 0.2, 0.19, 2.4, 0.092, 0.03, 1.2);
  }
  door.box(doorU, 4.48, 0.19, 2.5, 0.11, 0.055, 1.2);
  // runners
  for (const s2 of [-1, 1]) door.box(doorU + s2 * 2.5, 2.3, 0.19, 0.06, 2.3, 0.07, 0.6);
  door.pop();

  // mezzanine floor + stairs + railing
  const mezY = 4.3;
  slab(chunk, 'plank', f.x1 - 9.0, f.z0 + 0.5, f.x1 - 0.5, f.z0 + 11.5, mezY, 0.26, 'rust');
  const posts = chunk.m('rust');
  for (let i = 0; i < 3; i++) {
    const px = f.x1 - 9.0 + 0.4;
    const pz = f.z0 + 1.5 + i * 4.5;
    posts.pushTRS(px, mezY * 0.5, pz);
    posts.cylinder(0.09, 0.09, mezY, 8, false, false, 0.8);
    posts.pop();
  }
  stairs(chunk, {
    key: 'rust', dir: '-x', x: f.x1 - 9.2, z: f.z0 + 9.0,
    yBottom: 0.02, yTop: mezY, width: 1.2, railKey: 'rust', railSides: ['left', 'right'],
  });
  railing(chunk, 'rust', [
    V3(f.x1 - 9.0, mezY, f.z0 + 0.6), V3(f.x1 - 9.0, mezY, f.z0 + 7.6),
  ], 1.05, 'pipe');
  railing(chunk, 'rust', [
    V3(f.x1 - 9.0, mezY, f.z0 + 10.4), V3(f.x1 - 9.0, mezY, f.z0 + 11.4),
    V3(f.x1 - 0.6, mezY, f.z0 + 11.4),
  ], 1.05, 'pipe');

  // roof trusses spanning the hall, seen from inside and through the roof hole
  const truss = chunk.m('rust');
  for (let i = 0; i < 6; i++) {
    const z = f.z0 + 2.0 + i * 4.2;
    truss.boxMinMax(f.x0 + 0.4, eave - 0.75, z - 0.06, f.x1 - 0.4, eave - 0.62, z + 0.06, 2.0);
    truss.boxMinMax(f.x0 + 0.4, eave - 0.35, z - 0.05, f.x1 - 0.4, eave - 0.25, z + 0.05, 2.0);
    for (let k = 0; k < 8; k++) {
      const x = f.x0 + 1.2 + k * ((f.x1 - f.x0 - 2.4) / 7);
      truss.pushTRS(x, eave - 0.5, z, 0, 0, k % 2 ? 0.6 : -0.6);
      truss.box(0, 0, 0, 0.03, 0.36, 0.03, 0.5);
      truss.pop();
    }
  }

  // external stair up the north face to the roof
  stairs(chunk, {
    key: 'rust', dir: '+x', x: f.x0 + 1.0, z: f.z0 - 1.4,
    yBottom: 0.02, yTop: eave + 0.2, width: 1.15, railKey: 'rust', railSides: ['left'],
  });
  railing(chunk, 'rust', [
    V3(f.x0 + 1.0, eave + 0.2, f.z0 - 2.0), V3(f.x0 + 9.6, eave + 0.2, f.z0 - 2.0),
    V3(f.x0 + 9.6, eave + 0.2, f.z0 - 0.4),
  ], 1.05, 'pipe');

  return res;
}

/* ============================================================== offices == */

function offices(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.offices;
  const res = buildBlock(chunk, {
    name: 'offices',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 3,
    groundHeight: 3.6,
    storeyHeight: 3.2,
    wallKey: 'concrete',
    groundKey: 'stone',
    innerKey: 'plasterInt',
    trimKey: 'concreteDark',
    plinthKey: 'stone',
    roofKind: 'flat',
    roofKey: 'roofFelt',
    windowSpacing: 2.5,
    windowWidth: 1.6,
    windowHeight: 1.85,
    sill: 0.85,
    glazingDamage: 0.4,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    openSides: ['n', 'w', 's', 'e'],
    entrances: [{ side: 'w', at: 12, width: 1.7, open: 1.6 }],
    interior: 'full',
    interiorFloorKey: 'concrete',
    ceilingKey: 'plasterInt',
    stairwell: { x: 32.4, z: 25.0, dir: '-z', width: 1.3 },
    partitions: [
      { x0: 40, z0: 4.4, x1: 40, z1: 27.6, level: 1, door: 12 },
      { x0: 40, z0: 4.4, x1: 40, z1: 27.6, level: 2, door: 18 },
    ],
    balconies: [{ side: 'w', at: 20, width: 5.0, level: 2, depth: 1.4 }],
    holes: [{ side: 'w', at: 8, width: 3.2, level: 2, height: 2.6 }],
    parapetGaps: [{ x0: f.x0 - 1, z0: 7.0, x1: f.x0 + 1, z1: 9.0 }],
    downpipes: [{ x: f.x0 - 0.2, z: f.z1 + 0.2 }],
    seed: 2901,
  });
  void res;
  return res;
}

/* =============================================================== garage == */

function garage(chunk: Chunk): void {
  const f = FOOTPRINTS.garage;
  buildBlock(chunk, {
    name: 'garage',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 1,
    groundHeight: 4.4,
    wallKey: 'brickSoot',
    groundKey: 'brickSoot',
    innerKey: 'concreteDark',
    trimKey: 'concreteDark',
    plinthKey: 'concreteDark',
    roofKind: 'flat',
    roofKey: 'sheet',
    parapetHeight: 0.4,
    windowSpacing: 3.4,
    windowWidth: 1.5,
    windowHeight: 1.1,
    sill: 2.6,
    glazingDamage: 0.9,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    holes: [
      { side: 'w', at: 44, width: 4.4, level: 0, height: 3.4 },
      { side: 'n', at: 34, width: 3.2, level: 0, height: 3.2 },
    ],
    interior: 'ground',
    interiorFloorKey: 'concreteWet',
    ceilingKey: 'concreteDark',
    raggedSides: ['s', 'e'],
    raggedAmount: 1.5,
    cornerCollapse: { x: f.x1 - 1.5, z: f.z1 - 1.5, radius: 4.0 },
    seed: 3001,
  });
}

/* ======================================================== apartment S ==== */

/** Three storeys over an arched carriage passage — the only covered crossing. */
function apartmentS(chunk: Chunk): BlockResult {
  const f = FOOTPRINTS.apartmentS;
  const res = buildBlock(chunk, {
    name: 'apartmentS',
    x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1,
    storeys: 3,
    groundHeight: 4.7,
    storeyHeight: 3.15,
    wallKey: 'plasterOchre',
    groundKey: 'stone',
    innerKey: 'plasterIntWarm',
    trimKey: 'stoneTrim',
    plinthKey: 'stone',
    roofKind: 'pitched',
    roofKey: 'roofTile',
    ridgeAxis: 'x',
    ridgeRise: 2.9,
    windowSpacing: 3.0,
    windowWidth: 1.2,
    glazingDamage: 0.45,
    // A run of seven identical panes at exact even spacing was the facade's
    // loudest repeat. The rhythm is right — real windows are regular — so the
    // variation goes into their state: roughly one in six is boarded over.
    boardedChance: 0.17,
    openSides: ['n', 'w', 's', 'e'],
    entrances: [{ side: 'n', at: -9, width: 1.35, open: 1.2 }],
    balconies: [
      { side: 'n', at: -6, width: 2.6, level: 1 },
      { side: 'n', at: 6, width: 2.6, level: 1 },
      { side: 'n', at: 0, width: 3.4, level: 2, depth: 1.3 },
    ],
    holes: [{ side: 'n', at: 9, width: 2.8, level: 2, height: 2.4 }],
    // Carriage arch straight through the ground floor.
    extraOpenings: [
      { side: 'n', at: -1.0, width: 4.0, y: 0, height: 4.45, kind: 'arch' },
      { side: 's', at: -1.0, width: 4.0, y: 0, height: 4.45, kind: 'arch' },
    ],
    interior: 'full',
    interiorFloorKey: 'plank',
    ceilingKey: 'plasterIntWarm',
    stairwell: { x: -11.0, z: 39.0, dir: '+z', width: 1.3 },
    partitions: [
      { x0: -14, z0: 45, x1: 12, z1: 45, level: 1, door: 5 },
      { x0: -14, z0: 45, x1: 12, z1: 45, level: 2, door: 19 },
    ],
    chimneys: [{ x: -8, z: 44.5, height: 1.8 }, { x: 6, z: 44.5, height: 1.8 }],
    downpipes: [{ x: f.x0 - 0.2, z: f.z0 - 0.2 }, { x: f.x1 + 0.2, z: f.z0 - 0.2 }],
    seed: 3101,
  });

  // The passage: a 4 m arch through the north and south walls with a barrel
  // vault between them.
  const north = rectWalls(f.x0, f.z0, f.x1, f.z1)[0];
  const south = rectWalls(f.x0, f.z0, f.x1, f.z1)[2];
  const passX = -1.0;
  archOpening(chunk, north, 'stone', f.x1 - passX, 4.0, 2.4, 4.45, 0.5, 9, 'stoneTrim');
  archOpening(chunk, south, 'stone', passX - f.x0, 4.0, 2.4, 4.45, 0.5, 9, 'stoneTrim');

  const vault = chunk.m('stoneTrim');
  // Fourteen ring courses rather than nine: at nine the soffit read as a row
  // of joists, which is what put the passage's scale out as much as the block
  // size did. Fourteen narrow voussoirs read as a turned barrel vault.
  const seg = 14;
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI * (i / seg);
    const a1 = Math.PI * ((i + 1) / seg);
    const am = (a0 + a1) * 0.5;
    const r = 2.0;
    const cx = passX - Math.cos(am) * (r + 0.14);
    const cy = 2.4 + Math.sin(am) * (r + 0.14);
    const w = (Math.PI * r) / seg * 0.62;
    vault.pushTRS(cx, cy, (f.z0 + f.z1) * 0.5, 0, 0, am - Math.PI / 2);
    vault.box(0, 0, 0, w, 0.14, (f.z1 - f.z0) * 0.5 - 0.4, 0.45);
    vault.pop();
  }
  // Passage side walls.
  //
  // The masonry module.
  //
  // Every wall material in the catalogue is *triplanar*, so the per-mesh UV
  // scale passed to the mesher is ignored and the block size comes entirely
  // from the archetype's tile. `stone` lays 4 blocks × 7 courses over a 3.2 m
  // tile — 80 × 46 cm units, so a 4 m passage read as five blocks across and
  // was the clearest scale error on the map. `stoneTrim` is the same cut-stone
  // archetype on a 1.4 m tile: 35 × 20 cm dressed ashlar, which is what a
  // carriage arch is actually built from and gives the eye a dozen units
  // across the opening to measure the passage against.
  const ashlar = chunk.m('stoneTrim');
  for (const s of [-1, 1]) {
    ashlar.boxMinMax(
      passX + s * 2.0 - (s > 0 ? 0 : 0.35), -0.4, f.z0 + 0.35,
      passX + s * 2.0 + (s > 0 ? 0.35 : 0), 2.6, f.z1 - 0.35, 0.4,
    );
    // String course at springing level and a chamfered wheel guard at the foot:
    // two more horizontals to read the passage's height against.
    const trim = chunk.m('stoneTrim');
    trim.boxMinMax(
      passX + s * 2.0 - (s > 0 ? 0.06 : 0.4), 2.52, f.z0 + 0.3,
      passX + s * 2.0 + (s > 0 ? 0.4 : 0.06), 2.68, f.z1 - 0.3, 0.36,
    );
    trim.boxMinMax(
      passX + s * 2.0 - (s > 0 ? 0.02 : 0.44), 0.0, f.z0 + 0.3,
      passX + s * 2.0 + (s > 0 ? 0.44 : 0.02), 0.34, f.z1 - 0.3, 0.8,
    );
    // Corner guard stones at both mouths, canted the way a cart would hit them.
    for (const ez of [f.z0 + 0.42, f.z1 - 0.42]) {
      trim.pushTRS(passX + s * 1.86, 0.0, ez, 0, 0, s * 0.10);
      trim.box(0, 0.42, 0, 0.16, 0.42, 0.16, 0.5);
      trim.pop();
    }
    // Conduit and a junction box along one wall, at a believable 1.9 m.
    if (s > 0) {
      const pipe = chunk.m('pipe');
      pipe.boxMinMax(passX + 1.94, 1.88, f.z0 + 0.5, passX + 2.0, 1.96, f.z1 - 0.5, 0.6);
      for (const ez of [f.z0 + 3.2, f.z0 + 9.4, f.z1 - 3.6]) {
        pipe.box(passX + 1.9, 1.92, ez, 0.09, 0.13, 0.1, 0.3);
      }
    }
  }
  slab(chunk, 'cobble', passX - 2.0, f.z0, passX + 2.0, f.z1, 0.02, 0.3);

  return res;
}

/* ====================================================== boundary ruins ==== */

/**
 * The map edge. Ruined facades and rubble berms so the play space is walled by
 * something that reads as a bombed street rather than an invisible box, plus
 * the (invisible) clip volumes that actually contain the player.
 */
export function buildBoundary(set: ChunkSet, clipParent: THREE.Object3D): void {
  const rand = new Rand(3301);
  const R = 56;

  const ruinRun = (name: string, ax: number, az: number, bx: number, bz: number, seed: number) => {
    const chunk = set.get(name);
    const frame = new WallFrame(ax, az, bx, bz);
    const len = frame.length;
    const units = Math.max(1, Math.round(len / 9));
    const local = new Rand(seed);
    for (let i = 0; i < units; i++) {
      const u0 = (len * i) / units;
      const u1 = (len * (i + 1)) / units;
      const h = local.range(4.5, 9.5);
      const sub = new WallFrame(
        ax + (bx - ax) * (u0 / len), az + (bz - az) * (u0 / len),
        ax + (bx - ax) * (u1 / len), az + (bz - az) * (u1 / len),
      );
      const openings: Opening[] = [];
      const winCount = Math.max(1, Math.floor((u1 - u0) / 3.2));
      for (let k = 0; k < winCount; k++) {
        openings.push({
          u: ((u1 - u0) / winCount) * (k + 0.5), width: 1.3,
          sill: 1.0, height: 1.8, kind: 'hole', noTrim: true,
        });
        if (h > 6.5) {
          openings.push({
            u: ((u1 - u0) / winCount) * (k + 0.5), width: 1.3,
            sill: 4.2, height: 1.8, kind: 'hole', noTrim: true,
          });
        }
      }
      wall(chunk, sub, {
        key: local.bool(0.5) ? 'brickSoot' : 'plasterGrey',
        y0: -0.5, y1: h, thickness: 0.5, openings,
        ragged: { amplitude: 1.9, seed: seed + i * 13, rebar: true },
        innerKey: 'brickSoot',
      });
    }
  };

  ruinRun('edgeN', R, -R, -R, -R, 3311);
  ruinRun('edgeW', -R, -R, -R, R, 3321);
  ruinRun('edgeS', -R, R, R, R, 3331);
  ruinRun('edgeE', R, R, R, -R, 3341);

  // Rubble berm banked against the inside of the ruins.
  const berm = set.get('edgeBerm');
  const heap = berm.m('concreteDark');
  const brickHeap = berm.m('brickSoot');
  for (let i = 0; i < 900; i++) {
    const edge = i % 4;
    const t = rand.next();
    let x = 0, z = 0;
    const inset = rand.range(0.4, 4.2);
    if (edge === 0) { x = -R + t * 2 * R; z = -R + inset; }
    else if (edge === 1) { x = R - inset; z = -R + t * 2 * R; }
    else if (edge === 2) { x = -R + t * 2 * R; z = R - inset; }
    else { x = -R + inset; z = -R + t * 2 * R; }
    const s = rand.range(0.18, 0.75) * (1 - inset / 5);
    if (s < 0.06) continue;
    const m = rand.bool(0.5) ? heap : brickHeap;
    m.pushTRS(x, s * 0.55, z, rand.next() * Math.PI, rand.range(-0.5, 0.5), rand.range(-0.5, 0.5));
    m.box(0, 0, 0, s, s * rand.range(0.4, 0.9), s * rand.range(0.6, 1.4), 1.0);
    m.pop();
  }

  // Invisible clip ring: guarantees containment regardless of rubble geometry.
  const clipGeo = new THREE.BoxGeometry(1, 1, 1);
  const clipMat = new THREE.MeshBasicMaterial({ visible: false });
  const bounds = R - 0.6;
  const spans: [number, number, number, number][] = [
    [0, -bounds, 2 * bounds + 4, 1],
    [0, bounds, 2 * bounds + 4, 1],
    [-bounds, 0, 1, 2 * bounds + 4],
    [bounds, 0, 1, 2 * bounds + 4],
  ];
  for (const [cx, cz, sx, sz] of spans) {
    const m = new THREE.Mesh(clipGeo, clipMat);
    m.position.set(cx, 9, cz);
    m.scale.set(sx, 26, sz);
    m.visible = false;
    m.userData.collideWhenHidden = true;
    m.userData.physicsShape = 'box';
    m.userData.navIgnore = false;
    m.name = 'clip';
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    clipParent.add(m);
  }
}

/* -------------------------------------------------------------- exports -- */

export { column, cable, doorUnit, parapet, roofFlat, cornice, chimney, downpipe };
