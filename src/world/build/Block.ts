/**
 * Generic multi-storey block builder.
 *
 * Almost every building on Blackout is a rectangular masonry block with a
 * plinth, a ground floor that differs from the floors above (shopfronts,
 * entrances, arcades), a regular window rhythm, a string course, a cornice and
 * either a flat roof with a parapet or a tiled pitched roof. This builder
 * expresses that grammar; the individual buildings in `Buildings.ts` supply the
 * character — the arcade, the tower, the roller door, the collapsed corner.
 *
 * Interiors are authored here too: floor slabs with their own ceiling material,
 * partition walls, a real stairwell with a landing, and the darker/cooler
 * interior render that stands in for a per-room ambient volume.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { MatKey } from '../MatCatalog';
import type { Chunk } from '../geom/Chunk';
import { INTERIOR_FLOOR_Y } from './Terrain';
import {
  balcony, cornice, doorUnit, downpipe, gutter, parapet, roofFlat, roofPitched,
  shopfront, slab, slabWithHole, stairs, wall, windowUnit, rectWalls, chimney,
  WallFrame, type Opening,
} from '../geom/Kit';
import { V3 } from '../geom/Mesher';

export type Side = 'n' | 'w' | 's' | 'e';
const SIDE_INDEX: Record<Side, number> = { n: 0, w: 1, s: 2, e: 3 };

/** Shutter paints. Mostly tired timber, occasionally something that was loud. */
const SHUTTER_KEYS: readonly MatKey[] = [
  'woodPaint', 'woodPaint', 'wood', 'plank', 'steelPaint', 'paintRed',
];

export interface BlockSpec {
  name: string;
  x0: number; z0: number; x1: number; z1: number;
  storeys: number;
  /** Floor-to-floor height. Ground floor gets `groundHeight`. */
  storeyHeight?: number;
  groundHeight?: number;
  base?: number;

  wallKey: MatKey;
  groundKey?: MatKey;
  innerKey?: MatKey;
  trimKey?: MatKey;
  plinthKey?: MatKey;
  roofKind?: 'flat' | 'pitched' | 'none';
  roofKey?: MatKey;
  ridgeAxis?: 'x' | 'z';
  ridgeRise?: number;
  thickness?: number;

  /** Sides that face open space and therefore get windows and detailing. */
  openSides?: Side[];
  /** Sides that are butted against another building — no openings, no detail. */
  blindSides?: Side[];
  /** Party walls owned by the neighbouring block: skipped entirely. */
  omitSides?: Side[];

  windowSpacing?: number;
  windowWidth?: number;
  windowHeight?: number;
  sill?: number;
  /** 0 = every pane intact, 1 = every pane gone. */
  glazingDamage?: number;
  boardedChance?: number;

  entrances?: { side: Side; at: number; width?: number; open?: number; missing?: boolean }[];
  shopfronts?: { side: Side; at: number; width: number; broken?: number; signKey?: MatKey }[];
  balconies?: { side: Side; at: number; width: number; level: number; depth?: number }[];
  /** Blown-out holes: level index, side, world coordinate along the side. */
  holes?: { side: Side; at: number; width: number; level: number; height?: number }[];
  /**
   * Fully authored openings in absolute world Y — arcades, carriage arches,
   * roller-door bays. Assigned to whichever storey band contains their sill.
   */
  extraOpenings?: { side: Side; at: number; width: number; y: number; height: number; kind?: Opening['kind'] }[];

  interior?: 'none' | 'ground' | 'full';
  interiorFloorKey?: MatKey;
  ceilingKey?: MatKey;
  /** Stairwell footprint in world coordinates, and which corner it climbs from. */
  stairwell?: { x: number; z: number; dir: '+x' | '-x' | '+z' | '-z'; width?: number };
  /** Extra partitions, in world coordinates, per level. */
  partitions?: { x0: number; z0: number; x1: number; z1: number; level: number; door?: number }[];

  /** Ragged blown-open top on these sides. */
  raggedSides?: Side[];
  raggedAmount?: number;
  cornerCollapse?: { x: number; z: number; radius: number };

  parapetHeight?: number;
  parapetGaps?: { x0: number; z0: number; x1: number; z1: number }[];
  chimneys?: { x: number; z: number; height?: number }[];
  downpipes?: { x: number; z: number }[];
  /** Roof hole letting the rooftop route drop into the top floor. */
  roofHole?: { x0: number; z0: number; x1: number; z1: number };

  seed: number;
}

export interface BlockResult {
  /** Y of each finished floor level, index 0 = ground. */
  levels: number[];
  roofY: number;
  eaveY: number;
  spec: BlockSpec;
}

/** Converts a world coordinate to the wall-local `u` of one side. */
export function uOn(spec: BlockSpec, side: Side, world: number): number {
  switch (side) {
    case 'n': return spec.x1 - world;
    case 's': return world - spec.x0;
    case 'w': return world - spec.z0;
    case 'e': return spec.z1 - world;
  }
}

export function sideFrames(spec: BlockSpec): Record<Side, WallFrame> {
  const w = rectWalls(spec.x0, spec.z0, spec.x1, spec.z1);
  return { n: w[0], w: w[1], s: w[2], e: w[3] };
}

export function buildBlock(chunk: Chunk, spec: BlockSpec): BlockResult {
  const rand = new Rand(spec.seed);
  const sh = spec.storeyHeight ?? 3.05;
  const gh = spec.groundHeight ?? 3.4;
  const base = spec.base ?? 0;
  const t = spec.thickness ?? 0.36;
  const frames = sideFrames(spec);
  const openSides = spec.openSides ?? (['n', 'w', 's', 'e'] as Side[]);
  const blind = new Set(spec.blindSides ?? []);

  const levels: number[] = [];
  for (let i = 0; i < spec.storeys; i++) levels.push(base + (i === 0 ? 0 : gh + (i - 1) * sh));
  const eaveY = base + gh + (spec.storeys - 1) * sh;

  const plinthH = 0.55;
  const winW = spec.windowWidth ?? 1.15;
  const winH = spec.windowHeight ?? 1.65;
  const sill = spec.sill ?? 0.95;
  const spacing = spec.windowSpacing ?? 3.1;
  const damage = spec.glazingDamage ?? 0.3;

  /* ------------------------------------------------------------- plinth -- */
  if (spec.plinthKey) {
    const p = chunk.m(spec.plinthKey);
    p.boxMinMax(
      spec.x0 - 0.06, base - 0.4, spec.z0 - 0.06,
      spec.x1 + 0.06, base + plinthH, spec.z1 + 0.06, 1.6,
    );
  }

  /* -------------------------------------------------------------- walls -- */
  const omit = new Set(spec.omitSides ?? []);
  for (const side of ['n', 'w', 's', 'e'] as Side[]) {
    if (omit.has(side)) continue;
    const frame = frames[side];
    const isOpen = openSides.includes(side) && !blind.has(side);
    const len = frame.length;

    for (let lvl = 0; lvl < spec.storeys; lvl++) {
      const y0 = levels[lvl];
      const y1 = lvl + 1 < spec.storeys ? levels[lvl + 1] : eaveY;
      const openings: Opening[] = [];

      if (isOpen) {
        if (lvl === 0) {
          for (const e of spec.entrances ?? []) {
            if (e.side !== side) continue;
            openings.push({ u: uOn(spec, side, e.at), width: e.width ?? 1.25, sill: y0, height: 2.15, kind: 'door' });
          }
          for (const s of spec.shopfronts ?? []) {
            if (s.side !== side) continue;
            openings.push({ u: uOn(spec, side, s.at), width: s.width, sill: y0 + 0.5, height: 2.4, kind: 'shopfront', noTrim: true });
          }
        }
        for (const h of spec.holes ?? []) {
          if (h.side !== side || h.level !== lvl) continue;
          openings.push({ u: uOn(spec, side, h.at), width: h.width, sill: y0 + 0.9, height: h.height ?? 2.0, kind: 'hole', noTrim: true });
        }
        for (const e of spec.extraOpenings ?? []) {
          if (e.side !== side) continue;
          if (e.y < y0 - 0.01 || e.y >= y1 - 0.01) continue;
          openings.push({
            u: uOn(spec, side, e.at), width: e.width, sill: e.y,
            height: e.height, kind: e.kind ?? 'hole', noTrim: true,
          });
        }

        // Regular window rhythm, skipping anything already occupied.
        const count = Math.max(1, Math.floor((len - 1.6) / spacing));
        const pitch = (len - 1.6) / count;
        for (let i = 0; i <= count; i++) {
          const u = 0.8 + i * pitch;
          if (u < winW * 0.6 || u > len - winW * 0.6) continue;
          let clash = false;
          for (const o of openings) {
            if (Math.abs(o.u - u) < (o.width + winW) * 0.5 + 0.35) { clash = true; break; }
          }
          if (clash) continue;
          const broken = Math.min(1, damage * rand.range(0.3, 2.0));
          openings.push({
            u, width: winW, sill: y0 + sill, height: winH, kind: 'window',
            broken, boarded: rand.next() < (spec.boardedChance ?? 0),
          });
        }
      }

      const raggedTopHere = lvl === spec.storeys - 1 && (spec.raggedSides ?? []).includes(side);
      wall(chunk, frame, {
        key: lvl === 0 ? (spec.groundKey ?? spec.wallKey) : spec.wallKey,
        y0: lvl === 0 ? base - 0.5 : y0,
        y1,
        thickness: t,
        openings,
        innerKey: spec.interior !== 'none' ? spec.innerKey : undefined,
        trimKey: spec.trimKey,
        ragged: raggedTopHere
          ? { amplitude: spec.raggedAmount ?? 1.1, seed: spec.seed + SIDE_INDEX[side] * 71 + lvl, rebar: true }
          : undefined,
      });

      // Fit out the openings.
      for (const o of openings) {
        if (o.kind === 'window') {
          // Per-opening dressing. The structural rhythm stays exact — real
          // windows are on a grid — so every bit of the variation goes into
          // what is hung in the reveal: shutters open, half-shut, closed or
          // absent, in four different paints.
          const wr = new Rand(spec.seed * 7 + Math.round(o.u * 53 + y0 * 17) + SIDE_INDEX[side] * 401);
          const roll = wr.next();
          const shutters = roll < 0.17 ? 'closed'
            : roll < 0.32 ? 'half'
              : roll < 0.66 ? 'open' : 'none';
          windowUnit(chunk, frame, o, {
            wallThickness: t,
            broken: o.broken,
            boarded: o.boarded,
            cols: winW > 1.4 ? 3 : 2,
            rows: 2,
            seed: spec.seed + Math.round(o.u * 31 + y0 * 7),
            curtainKey: lvl > 0 ? 'canvasCream' : undefined,
            frameKey: 'woodPaint',
            shutters: o.boarded ? 'none' : shutters,
            shutterKey: wr.pick(SHUTTER_KEYS),
          });
        } else if (o.kind === 'door') {
          const e = (spec.entrances ?? []).find((x) => x.side === side && Math.abs(uOn(spec, side, x.at) - o.u) < 0.01);
          doorUnit(chunk, frame, o, {
            wallThickness: t, open: e?.open ?? 1.35, missing: e?.missing,
            hingeRight: rand.bool(),
          });
        }
      }
    }

    // Detailing only on visible sides.
    if (isOpen) {
      const cs = chunk.m(spec.trimKey ?? 'stoneTrim');
      for (let lvl = 1; lvl < spec.storeys; lvl++) {
        cs.push(frame.matrix);
        cs.box(len * 0.5, levels[lvl] - 0.18, t * 0.5 + 0.03, len * 0.5, 0.09, 0.06, 1.4);
        cs.pop();
      }
    }
  }

  /* -------------------------------------------------- blown-open holes -- */
  /**
   * Every shell hole gets its spoil.
   *
   * Cut on its own, a hole is a hard-edged black rectangle in a sunlit wall —
   * one of the most obvious unfinished reads on the map, because a real breach
   * always has half its masonry still hanging in it and the other half on the
   * pavement below. Each one now gets a ragged lintel of loose brick, rebar
   * bent out of the reveal, a spill of rubble across the sill and a strip of
   * torn curtain, which breaks the silhouette and stops the interior from
   * reading as a void.
   */
  for (const h of spec.holes ?? []) {
    const frame = frames[h.side];
    if (!frame) continue;
    const y0 = levels[Math.min(h.level, levels.length - 1)] + 0.9;
    const u = uOn(spec, h.side, h.at);
    const hh = h.height ?? 2.0;
    const rand = new Rand(spec.seed + Math.round(h.at * 29) + h.level * 13);
    const half = t * 0.5;

    const rub = chunk.m('brickSoot');
    rub.push(frame.matrix);
    // Loose masonry still clinging to the top edge of the breach.
    for (let i = 0; i < 7; i++) {
      const du = (i / 6 - 0.5) * h.width * 0.95;
      const drop = rand.range(0.05, 0.34);
      rub.pushTRS(u + du, y0 + hh - drop * 0.5, half - 0.06, 0, 0, rand.range(-0.35, 0.35));
      rub.box(0, 0, 0, rand.range(0.08, 0.2), drop * 0.5, half * 0.7, 0.5);
      rub.pop();
    }
    // Spoil heaped on the sill and tipping out over the edge.
    for (let i = 0; i < 9; i++) {
      const du = rand.range(-h.width * 0.5, h.width * 0.5);
      const s = rand.range(0.05, 0.14);
      rub.pushTRS(u + du, y0 + s * 0.6, rand.range(-half * 0.4, half + 0.16),
        rand.range(-0.5, 0.5), rand.range(-0.3, 0.3), rand.range(-0.4, 0.4));
      rub.box(0, 0, 0, s, s * 0.6, s * rand.range(0.9, 1.6), 0.5);
      rub.pop();
    }
    rub.pop();

    const bar = chunk.m('rust');
    bar.push(frame.matrix);
    for (let i = 0; i < 3; i++) {
      const du = (i / 2 - 0.5) * h.width * 0.7;
      bar.tube([
        V3(u + du, y0 + hh - 0.05, half - 0.1),
        V3(u + du + rand.range(-0.1, 0.1), y0 + hh - 0.4, half + 0.16),
        V3(u + du + rand.range(-0.2, 0.2), y0 + hh - 0.85, half + 0.1),
      ], 0.011, 4, false, 0.3);
    }
    bar.pop();

    // A curtain still on its rail, hanging out of the opening.
    const cloth = chunk.m(rand.bool() ? 'canvasCream' : 'canvasRed');
    cloth.push(frame.matrix);
    const cu = u + rand.range(-h.width * 0.28, h.width * 0.28);
    const cw = rand.range(0.3, 0.55);
    cloth.pushTRS(cu, y0 + hh - 0.06, half - 0.05, 0, 0, rand.range(-0.18, 0.18));
    cloth.box(0, -rand.range(0.5, 1.1) * 0.5, 0.06, cw * 0.5, rand.range(0.5, 1.1) * 0.5, 0.008, { unit: true });
    cloth.pop();
    cloth.pop();
  }

  /* ---------------------------------------------------------- shopfronts */
  for (const s of spec.shopfronts ?? []) {
    shopfront(chunk, frames[s.side], {
      u: uOn(spec, s.side, s.at), width: s.width, wallThickness: t,
      stallRiser: 0.5, height: 2.4, broken: s.broken ?? 0.35,
      seed: spec.seed + Math.round(s.at * 13), signKey: s.signKey,
      fasciaKey: 'woodPaint',
    });
  }

  /* ----------------------------------------------------------- balconies */
  for (const b of spec.balconies ?? []) {
    balcony(chunk, frames[b.side], {
      slabKey: 'concrete', railKey: 'rust',
      u: uOn(spec, b.side, b.at), width: b.width,
      y: levels[Math.min(b.level, levels.length - 1)],
      depth: b.depth ?? 1.15, wallThickness: t, bracketKey: 'rust', style: 'ornate',
    });
  }

  /* ------------------------------------------------------------ cornice -- */
  if (spec.roofKind !== 'none') {
    let mask = 0b1111;
    if (omit.has('n')) mask &= ~1;
    if (omit.has('w')) mask &= ~2;
    if (omit.has('s')) mask &= ~4;
    if (omit.has('e')) mask &= ~8;
    cornice(chunk, spec.trimKey ?? 'stoneTrim', spec.x0, spec.z0, spec.x1, spec.z1, eaveY - 0.3, 0.19, 0.3, mask);
  }

  /* ----------------------------------------------------------- interior -- */
  const floorKey = spec.interiorFloorKey ?? 'concrete';
  const ceilKey = spec.ceilingKey ?? 'plasterInt';
  if (spec.interior && spec.interior !== 'none') {
    const top = spec.interior === 'ground' ? 1 : spec.storeys;
    // Ground slab sits at pavement height so it clears the street surface
    // running underneath the building rather than z-fighting with it.
    slab(chunk, floorKey, spec.x0 + t, spec.z0 + t, spec.x1 - t, spec.z1 - t, base + INTERIOR_FLOOR_Y, 0.42);
    for (let lvl = 1; lvl < top; lvl++) {
      const y = levels[lvl];
      const sw = spec.stairwell;
      if (sw) {
        const w = sw.width ?? 1.25;
        const flight = 3.0;
        const hx0 = sw.dir === '+x' || sw.dir === '-x' ? sw.x - flight : sw.x - w * 0.8;
        const hx1 = sw.dir === '+x' || sw.dir === '-x' ? sw.x + flight : sw.x + w * 0.8;
        const hz0 = sw.dir === '+z' || sw.dir === '-z' ? sw.z - flight : sw.z - w * 0.8;
        const hz1 = sw.dir === '+z' || sw.dir === '-z' ? sw.z + flight : sw.z + w * 0.8;
        slabWithHole(chunk, floorKey, spec.x0 + t, spec.z0 + t, spec.x1 - t, spec.z1 - t, hx0, hz0, hx1, hz1, y, 0.3, ceilKey);
      } else {
        slab(chunk, floorKey, spec.x0 + t, spec.z0 + t, spec.x1 - t, spec.z1 - t, y, 0.3, ceilKey);
      }
    }

    // Partitions.
    for (const p of spec.partitions ?? []) {
      if (p.level >= top) continue;
      const y0 = levels[p.level];
      const y1 = p.level + 1 < spec.storeys ? levels[p.level + 1] - 0.3 : eaveY - 0.3;
      const frame = new WallFrame(p.x0, p.z0, p.x1, p.z1);
      const openings: Opening[] = p.door !== undefined
        ? [{ u: p.door, width: 1.0, sill: y0, height: 2.1, kind: 'door', noTrim: true }]
        : [];
      wall(chunk, frame, {
        key: spec.innerKey ?? 'plasterInt', y0, y1, thickness: 0.14, openings,
        uvScale: 2.0,
      });
    }

    // Stairwell.
    const sw = spec.stairwell;
    if (sw && top > 1) {
      for (let lvl = 0; lvl < top - 1; lvl++) {
        const y0 = levels[lvl] + (lvl === 0 ? INTERIOR_FLOOR_Y : 0);
        const y1 = levels[lvl + 1];
        stairs(chunk, {
          key: 'concrete', dir: sw.dir, x: sw.x, z: sw.z,
          yBottom: y0, yTop: y1, width: sw.width ?? 1.25,
          railKey: 'rust', railSides: ['right'],
        });
      }
    }
  }

  /* --------------------------------------------------------------- roof -- */
  let roofY = eaveY;
  if (spec.roofKind === 'pitched') {
    const rise = spec.ridgeRise ?? Math.min(3.2, (spec.ridgeAxis === 'z' ? spec.x1 - spec.x0 : spec.z1 - spec.z0) * 0.28);
    roofPitched(
      chunk, spec.roofKey ?? 'roofTile',
      spec.x0, spec.z0, spec.x1, spec.z1,
      eaveY, rise, 0.42, spec.ridgeAxis ?? 'x', spec.wallKey, 'stoneTrim',
    );
    roofY = eaveY + rise;
    gutter(chunk, 'rust', spec.x0 - 0.42, spec.z0 - 0.42, spec.x1 + 0.42, eaveY - 0.12, 'x');
    gutter(chunk, 'rust', spec.x0 - 0.42, spec.z1 + 0.42, spec.x1 + 0.42, eaveY - 0.12, 'x');
  } else if (spec.roofKind !== 'none') {
    if (spec.roofHole) {
      slabWithHole(
        chunk, spec.roofKey ?? 'roofFelt',
        spec.x0, spec.z0, spec.x1, spec.z1,
        spec.roofHole.x0, spec.roofHole.z0, spec.roofHole.x1, spec.roofHole.z1,
        eaveY, 0.34, ceilKey,
      );
    } else {
      roofFlat(chunk, spec.roofKey ?? 'roofFelt', spec.x0, spec.z0, spec.x1, spec.z1, eaveY, 0.34, ceilKey);
    }
    parapet(
      chunk, spec.wallKey, spec.x0, spec.z0, spec.x1, spec.z1, eaveY,
      spec.parapetHeight ?? 0.9, 0.28, spec.trimKey ?? 'stoneTrim', spec.parapetGaps ?? [],
    );
    roofY = eaveY;
  }

  for (const c of spec.chimneys ?? []) {
    chimney(chunk, spec.wallKey === 'concrete' ? 'brickSoot' : 'brickSoot', c.x, c.z, roofY - 0.4, c.height ?? 1.6, 0.7, 0.7, 'rust');
  }
  for (const d of spec.downpipes ?? []) {
    downpipe(chunk, 'rust', d.x, d.z, base, eaveY - 0.35);
  }

  /* --------------------------------------------------- collapsed corner -- */
  if (spec.cornerCollapse) {
    collapseCorner(chunk, spec, spec.cornerCollapse, rand);
  }

  return { levels, roofY, eaveY, spec };
}

/* ------------------------------------------------------------- helpers -- */

/**
 * Rubble slope replacing a blown-off corner: the wall is already built, so this
 * buries the corner in graded debris and adds a few slab fragments leaning out
 * of it. Reads as a shell hit rather than a missing box.
 */
function collapseCorner(
  chunk: Chunk, spec: BlockSpec, c: { x: number; z: number; radius: number }, rand: Rand,
): void {
  const m = chunk.m('concreteDark');
  const b = chunk.m('brickSoot');
  const count = Math.round(c.radius * 9);
  for (let i = 0; i < count; i++) {
    const a = rand.next() * Math.PI * 2;
    const r = c.radius * Math.sqrt(rand.next());
    const x = c.x + Math.cos(a) * r;
    const z = c.z + Math.sin(a) * r;
    const h = Math.max(0.12, (1 - r / c.radius) * c.radius * 0.85 * rand.range(0.5, 1.2));
    const s = rand.range(0.22, 0.6);
    const target = rand.bool(0.6) ? b : m;
    target.pushTRS(x, h * 0.5, z, rand.next() * Math.PI, rand.range(-0.25, 0.25), rand.range(-0.25, 0.25));
    target.box(0, 0, 0, s, h * 0.5, s * rand.range(0.6, 1.3), 1.0);
    target.pop();
  }
  // A couple of big leaning slabs give the pile a readable silhouette.
  for (let i = 0; i < 3; i++) {
    const a = rand.next() * Math.PI * 2;
    const x = c.x + Math.cos(a) * c.radius * 0.55;
    const z = c.z + Math.sin(a) * c.radius * 0.55;
    m.pushTRS(x, c.radius * 0.4, z, rand.next() * Math.PI, rand.range(0.5, 1.1), rand.range(-0.4, 0.4));
    m.box(0, 0, 0, rand.range(0.9, 1.7), 0.11, rand.range(0.7, 1.2), 2.0);
    m.pop();
  }
  void spec;
}

/** Plank bridge between two roofs — the rooftop route's crossing points. */
export function plankBridge(
  chunk: Chunk, a: THREE.Vector3, b: THREE.Vector3, width = 1.1, seed = 3,
): void {
  const rand = new Rand(seed);
  const m = chunk.m('plank');
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const yaw = Math.atan2(dir.x, dir.z);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const planks = Math.max(2, Math.round(width / 0.26));
  m.pushTRS(mid.x, mid.y, mid.z, yaw - Math.PI / 2);
  for (let i = 0; i < planks; i++) {
    const off = (i / (planks - 1) - 0.5) * width;
    m.box(0, rand.range(-0.01, 0.01), off, len * 0.5, 0.028, width / planks * 0.44, 1.2);
  }
  m.pop();
  const s = chunk.m('rust');
  s.pushTRS(mid.x, mid.y - 0.09, mid.z, yaw - Math.PI / 2);
  for (const side of [-1, 1]) s.box(0, 0, side * width * 0.4, len * 0.5, 0.05, 0.035, 0.6);
  s.pop();
}

/** Simple ladder against a wall; the cheapest legible vertical connector. */
export function ladder(
  chunk: Chunk, key: MatKey, x: number, z: number, y0: number, y1: number,
  yaw = 0, width = 0.46,
): void {
  const m = chunk.m(key);
  m.pushTRS(x, (y0 + y1) * 0.5, z, yaw);
  const h = (y1 - y0) * 0.5;
  for (const s of [-1, 1]) m.box(s * width * 0.5, 0, 0, 0.022, h, 0.022, 0.4);
  const rungs = Math.max(2, Math.round((y1 - y0) / 0.3));
  for (let i = 0; i <= rungs; i++) {
    m.box(0, -h + (i / rungs) * (y1 - y0), 0, width * 0.5, 0.014, 0.014, 0.3);
  }
  m.pop();
}
