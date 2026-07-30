/**
 * Unique set pieces: the burnt-out cars, the toppled tram, the wrecked truck
 * and the dry fountain.
 *
 * These are the objects that tell the player where they are. Each is built once
 * at a fixed transform rather than instanced, and each is placed to do a job in
 * the layout — the tram cuts the square's longest sightline in half, the
 * fountain anchors its centre, the truck plugs the north-east approach.
 */

import * as THREE from 'three';
import { Rand } from '../../core/Rand';
import type { Chunk } from '../geom/Chunk';
import { FACE, V3 } from '../geom/Mesher';
import { railing } from '../geom/Kit';
import { groundHeightAt } from './Terrain';

/* ------------------------------------------------------------------ car -- */

/**
 * A burnt-out saloon. Built as a chassis, a tapered greenhouse, four arches and
 * the wreck details (missing glass, sprung bonnet, melted tyres) so the
 * silhouette still reads as a car from 60 m.
 */
export function burntCar(chunk: Chunk, x: number, z: number, yaw: number, seed: number, burnt = true): void {
  const rand = new Rand(seed);
  const bodyKey = burnt ? 'ember' : 'steelPaint';
  const shellKey = burnt ? 'rust' : 'steelPaint';
  const y = groundHeightAt(x, z);
  const b = chunk.m(shellKey);
  b.pushTRS(x, y, z, yaw);

  const L = 2.05, W = 0.82;
  // sills and floor pan
  b.chamferBox(0, 0.42, 0, W, 0.22, L, 0.03, 1.4);
  // bonnet and boot decks
  b.chamferBox(0, 0.66, L * 0.62, W * 0.94, 0.05, L * 0.34, 0.025, 1.4);
  b.chamferBox(0, 0.68, -L * 0.68, W * 0.92, 0.05, L * 0.28, 0.025, 1.4);
  // greenhouse: tapered cabin with a windscreen rake
  const cab = chunk.m(bodyKey);
  cab.push(b.matrix);
  cab.pushTRS(0, 0.72, -0.08);
  cab.box(0, 0.22, 0, W * 0.86, 0.22, L * 0.42, 1.2, FACE.ALL & ~FACE.NY);
  cab.pop();
  // A-pillar rake
  cab.pushTRS(0, 0.86, L * 0.34, 0, -0.62, 0);
  cab.box(0, 0, 0, W * 0.84, 0.2, 0.05, 1.0);
  cab.pop();
  cab.pushTRS(0, 0.86, -L * 0.5, 0, 0.5, 0);
  cab.box(0, 0, 0, W * 0.84, 0.2, 0.05, 1.0);
  cab.pop();
  cab.pop();

  // wheel arches + burnt tyres
  const rub = chunk.m('rubber');
  const hub = chunk.m('steel');
  for (const sz of [1, -1]) {
    for (const sx of [-1, 1]) {
      const wx = sx * (W - 0.04), wz = sz * L * 0.58;
      if (rand.bool(0.2)) {
        // wheel gone: the car sits on its hub
        hub.push(b.matrix);
        hub.pushTRS(wx * 0.94, 0.2, wz, 0, 0, Math.PI / 2);
        hub.cylinder(0.16, 0.16, 0.06, 10, true, true, 0.3);
        hub.pop();
        hub.pop();
      } else {
        rub.push(b.matrix);
        rub.pushTRS(wx * 0.94, 0.32, wz, 0, 0, Math.PI / 2);
        rub.cylinder(0.32, 0.32, 0.2, 12, true, true, 0.5);
        rub.pop();
        rub.pop();
        hub.push(b.matrix);
        hub.pushTRS(wx * 1.02, 0.32, wz, 0, 0, Math.PI / 2);
        hub.cylinder(0.16, 0.16, 0.05, 10, true, false, 0.3);
        hub.pop();
        hub.pop();
      }
      // arch lip
      b.pushTRS(wx, 0.55, wz, 0, 0, Math.PI / 2);
      b.cylinder(0.42, 0.42, 0.06, 10, false, false, 0.4, Math.PI, 0);
      b.pop();
    }
  }

  // sprung bonnet
  b.pushTRS(0, 0.72, L * 0.9, 0, rand.range(0.25, 0.7), 0);
  b.box(0, 0, -0.35, W * 0.9, 0.03, 0.36, 1.2);
  b.pop();

  // bumpers and light housings
  const trim = chunk.m('alu');
  trim.push(b.matrix);
  for (const sz of [1, -1]) {
    trim.box(0, 0.5, sz * (L * 0.99), W * 0.95, 0.07, 0.06, 0.8);
    for (const sx of [-1, 1]) {
      trim.box(sx * W * 0.62, 0.63, sz * (L * 0.97), 0.17, 0.07, 0.04, { unit: true });
    }
  }
  trim.pop();

  if (!burnt) {
    const g = chunk.m('glassDirty');
    g.push(b.matrix);
    g.pushTRS(0, 0.9, L * 0.34, 0, -0.62, 0);
    g.box(0, 0, 0, W * 0.78, 0.19, 0.008, { unit: true });
    g.pop();
    g.pop();
  }
  b.pop();
}

/* ----------------------------------------------------------------- tram -- */

/**
 * A toppled articulated tram lying on its side across the square. The single
 * most valuable piece of cover on the map: it turns one 55 m sightline into
 * two short ones and gives both approaches a vaulting point.
 */
export function toppledTram(chunk: Chunk, x: number, z: number, yaw: number): void {
  const body = chunk.m('steelPaint');
  const roof = chunk.m('sheet');
  const glass = chunk.m('glassDirty');
  const rustM = chunk.m('rust');
  const y = groundHeightAt(x, z);

  // Derailed and leaning, not flat on its side: at ~55° the window band and the
  // roof ribs both stay readable, which is what makes it legible as a tram from
  // the far end of the square.
  body.pushTRS(x, y + 0.55, z, yaw, 0, Math.PI * 0.31);
  roof.push(body.matrix);
  glass.push(body.matrix);
  rustM.push(body.matrix);

  const L = 6.6, H = 1.6, W = 1.25;
  for (const seg of [-1, 1]) {
    const cz = seg * (L * 0.52);
    body.chamferBox(0, H, cz, W, H * 0.98, L * 0.5, 0.05, 2.0);
    // window band
    for (let i = 0; i < 6; i++) {
      const wz = cz - L * 0.42 + (i * L * 0.84) / 5;
      for (const sx of [-1, 1]) {
        glass.box(sx * (W + 0.008), H + 0.35, wz, 0.006, 0.42, L * 0.06, { unit: true });
        body.box(sx * (W + 0.01), H + 0.35, wz, 0.02, 0.5, L * 0.075, 1.0, FACE.SIDES);
      }
    }
    // roof ribs and skirt
    roof.box(0, H * 2 - 0.02, cz, W * 0.99, 0.05, L * 0.49, 1.4);
    for (let i = 0; i < 5; i++) {
      roof.box(0, H * 2 + 0.03, cz - L * 0.4 + (i * L * 0.8) / 4, W * 0.9, 0.04, 0.06, 0.6);
    }
    rustM.box(0, 0.18, cz, W * 1.02, 0.18, L * 0.49, 1.4);
  }
  // articulation bellows
  const bel = chunk.m('rubber');
  bel.push(body.matrix);
  for (let i = 0; i < 5; i++) {
    bel.box(0, H, -0.24 + i * 0.12, W * 0.94 + (i % 2) * 0.05, H * 0.9, 0.05, 0.6);
  }
  bel.pop();

  // bogies and wheels, now facing sideways
  const wh = chunk.m('steel');
  wh.push(body.matrix);
  for (const cz of [-L * 0.75, -L * 0.15, L * 0.15, L * 0.75]) {
    wh.box(0, -0.05, cz, W * 0.7, 0.16, 0.4, 0.8);
    for (const sx of [-1, 1]) {
      wh.pushTRS(sx * W * 0.6, -0.05, cz, 0, 0, Math.PI / 2);
      wh.cylinder(0.34, 0.34, 0.09, 12, true, true, 0.4);
      wh.pop();
    }
  }
  wh.pop();

  // pantograph, folded and bent
  const pan = chunk.m('rust');
  pan.push(body.matrix);
  pan.tube([V3(0, H * 2, 0.6), V3(0.5, H * 2 + 0.6, 1.3), V3(-0.2, H * 2 + 0.75, 2.1)], 0.035, 5, false, 0.5);
  pan.tube([V3(0, H * 2, 0.6), V3(0.35, H * 2 + 0.75, 0.9)], 0.03, 5, false, 0.5);
  pan.pop();

  glass.pop();
  roof.pop();
  rustM.pop();
  body.pop();

  // Debris skirt where it hit the cobbles.
  const rand = new Rand(6601);
  const deb = chunk.m('concreteDark');
  const shard = chunk.m('glassDirty');
  for (let i = 0; i < 40; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(1.2, 5.5);
    const px = x + Math.cos(yaw) * rand.range(-6, 6) + Math.cos(a) * r * 0.4;
    const pz = z + Math.sin(yaw) * rand.range(-6, 6) + Math.sin(a) * r * 0.4;
    const s = rand.range(0.06, 0.2);
    const t = rand.bool(0.35) ? shard : deb;
    t.pushTRS(px, groundHeightAt(px, pz) + s * 0.4, pz, rand.next() * 3, rand.range(-0.3, 0.3), rand.range(-0.3, 0.3));
    t.box(0, 0, 0, s, s * 0.35, s * 1.3, 0.5);
    t.pop();
  }
}

/* ---------------------------------------------------------------- truck -- */

/** A flatbed lorry, nose into a rubble bank, canvas tilt shredded. */
export function truckWreck(chunk: Chunk, x: number, z: number, yaw: number): void {
  const y = groundHeightAt(x, z);
  const cabKey = 'steelPaint';
  const cab = chunk.m(cabKey);
  cab.pushTRS(x, y, z, yaw, -0.09, 0.05);

  // chassis rails
  const ch = chunk.m('rust');
  ch.push(cab.matrix);
  for (const sx of [-1, 1]) ch.box(sx * 0.62, 0.62, 0, 0.08, 0.12, 3.4, 1.6);
  ch.pop();

  // cab
  cab.chamferBox(0, 1.35, 2.05, 1.0, 0.62, 0.95, 0.04, 1.6);
  cab.chamferBox(0, 0.86, 2.05, 1.02, 0.16, 1.0, 0.03, 1.6);
  const g = chunk.m('glassDirty');
  g.push(cab.matrix);
  g.box(0, 1.5, 3.01, 0.86, 0.36, 0.01, { unit: true });
  for (const sx of [-1, 1]) g.box(sx * 1.01, 1.45, 2.05, 0.01, 0.3, 0.4, { unit: true });
  g.pop();

  // flatbed and tilt hoops with torn canvas
  const bed = chunk.m('plank');
  bed.push(cab.matrix);
  bed.box(0, 0.78, -0.8, 1.05, 0.06, 2.0, 1.2);
  for (const sx of [-1, 1]) bed.box(sx * 1.05, 0.98, -0.8, 0.05, 0.2, 2.0, 1.0);
  bed.pop();
  const hoop = chunk.m('pipe');
  hoop.push(cab.matrix);
  for (let i = 0; i < 4; i++) {
    const hz = -2.5 + i * 1.1;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const a = Math.PI * (k / 8);
      pts.push(V3(-Math.cos(a) * 1.02, 0.84 + Math.sin(a) * 0.95, hz));
    }
    hoop.tube(pts, 0.025, 5, false, 0.5);
  }
  hoop.pop();
  const canvas = chunk.m('canvasGreen');
  canvas.push(cab.matrix);
  for (let i = 0; i < 3; i++) {
    const hz0 = -2.5 + i * 1.1, hz1 = hz0 + 1.1;
    if (i === 1) continue; // torn away in the middle
    for (let k = 0; k < 8; k++) {
      const a0 = Math.PI * (k / 8), a1 = Math.PI * ((k + 1) / 8);
      canvas.quad(
        V3(-Math.cos(a0) * 1.03, 0.84 + Math.sin(a0) * 0.96, hz0),
        V3(-Math.cos(a1) * 1.03, 0.84 + Math.sin(a1) * 0.96, hz0),
        V3(-Math.cos(a1) * 1.03, 0.84 + Math.sin(a1) * 0.96, hz1),
        V3(-Math.cos(a0) * 1.03, 0.84 + Math.sin(a0) * 0.96, hz1),
        1.0, true,
      );
    }
  }
  canvas.pop();

  // wheels
  const rub = chunk.m('rubber');
  rub.push(cab.matrix);
  for (const [wz, dual] of [[2.15, false], [-1.1, true], [-1.95, true]] as const) {
    for (const sx of [-1, 1]) {
      const n = dual ? 2 : 1;
      for (let d = 0; d < n; d++) {
        rub.pushTRS(sx * (0.78 + d * 0.24), 0.52, wz, 0, 0, Math.PI / 2);
        rub.cylinder(0.52, 0.52, 0.22, 12, true, true, 0.6);
        rub.pop();
      }
    }
  }
  rub.pop();
  cab.pop();
}

/* -------------------------------------------------------------- fountain -- */

/** Dry municipal fountain: octagonal basin, shattered centre column. */
export function fountain(chunk: Chunk, x: number, z: number): void {
  const y = groundHeightAt(x, z);
  const m = chunk.m('stone');
  const trim = chunk.m('stoneTrim');
  const sides = 8;
  const outer = 3.3, inner = 2.95;

  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const mid = (a0 + a1) * 0.5;
    const len = 2 * outer * Math.tan(Math.PI / sides) * 0.5;
    m.pushTRS(x + Math.cos(mid) * (outer + inner) * 0.5, y + 0.34, z + Math.sin(mid) * (outer + inner) * 0.5, -mid);
    m.box(0, 0, 0, len + 0.06, 0.34, (outer - inner) * 0.5 + 0.05, 1.4);
    m.pop();
    trim.pushTRS(x + Math.cos(mid) * (outer + inner) * 0.5, y + 0.72, z + Math.sin(mid) * (outer + inner) * 0.5, -mid);
    trim.box(0, 0, 0, len + 0.12, 0.05, (outer - inner) * 0.5 + 0.11, 1.0);
    trim.pop();
  }
  // basin floor, silted
  const floor = chunk.m('dirt');
  floor.pushTRS(x, y + 0.06, z);
  floor.cylinder(inner, inner, 0.1, 16, true, false, 1.4);
  floor.pop();

  // broken central column
  const col = chunk.m('stoneTrim');
  col.pushTRS(x, y + 0.45, z);
  col.cylinder(0.62, 0.5, 0.8, 10, true, false, 1.0);
  col.pop();
  col.pushTRS(x, y + 1.25, z);
  col.cylinder(0.3, 0.26, 0.9, 10, false, false, 0.8);
  col.pop();
  const rand = new Rand(7701);
  col.pushTRS(x, y + 1.85, z, 0, 0.5, 0.35);
  col.cylinder(0.26, 0.22, 0.55, 10, true, false, 0.8);
  col.pop();
  // fallen upper section
  col.pushTRS(x + 1.6, y + 0.28, z - 1.1, 0.9, Math.PI / 2 - 0.2, 0);
  col.cylinder(0.24, 0.2, 1.3, 10, true, true, 0.8);
  col.pop();
  for (let i = 0; i < 16; i++) {
    const a = rand.next() * Math.PI * 2;
    const r = rand.range(0.6, 2.6);
    const s = rand.range(0.08, 0.24);
    col.pushTRS(x + Math.cos(a) * r, y + 0.14 + s * 0.4, z + Math.sin(a) * r,
      rand.next() * 3, rand.range(-0.3, 0.3), rand.range(-0.3, 0.3));
    col.box(0, 0, 0, s, s * 0.6, s * 1.2, 0.8);
    col.pop();
  }
}

/* ------------------------------------------------------- gun emplacement -- */

/** Sandbag emplacement with a firing step — a designed cover island. */
export function emplacement(chunk: Chunk, x: number, z: number, yaw: number, seed: number): void {
  const rand = new Rand(seed);
  const y = groundHeightAt(x, z);
  const bag = chunk.m('sandbag');
  bag.pushTRS(x, y, z, yaw);
  // U-shaped wall, three courses, open to the rear
  const path: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const a = Math.PI * (0.15 + t * 0.7);
    path.push([Math.cos(a) * 2.1, Math.sin(a) * 1.6 - 0.4]);
  }
  for (let row = 0; row < 3; row++) {
    const yy = 0.16 + row * 0.28;
    for (let i = 0; i < path.length; i++) {
      if (row === 2 && i % 3 === 1) continue; // firing notches
      const [px, pz] = path[i];
      const dir = i < path.length - 1
        ? Math.atan2(path[i + 1][1] - pz, path[i + 1][0] - px)
        : 0;
      bag.pushTRS(px, yy, pz, -dir + (row % 2) * 0.1, rand.range(-0.1, 0.1));
      bag.lump(0.26, 8, 5, (k) => 0.66 + 0.5 * frac(Math.sin((k + row * 5 + i * 11) * 12.9898) * 43758.5), 0.5);
      bag.pop();
    }
  }
  bag.pop();

  const plank = chunk.m('plank');
  plank.pushTRS(x, y + 0.16, z, yaw);
  plank.box(0, 0, 0.55, 1.2, 0.05, 0.3, 1.0);
  plank.pop();
}

function frac(v: number): number { return v - Math.floor(v); }

/* ---------------------------------------------------------- roof helpers -- */

/** Guard rail around a roof-access void; keeps the rooftop route legible. */
export function roofGuard(chunk: Chunk, points: THREE.Vector3[]): void {
  railing(chunk, 'rust', points, 1.05, 'pipe');
}
