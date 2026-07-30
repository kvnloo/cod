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
  const body = chunk.m('paintRed');
  const glass = chunk.m('glassDirty');
  const rustM = chunk.m('rust');
  const cream = chunk.m('canvasCream');
  const y = groundHeightAt(x, z);

  const L = 6.6, H = 1.6, W = 1.25;
  // Rolled −50°, and the sign matters.
  //
  // Flat on its side a tram shows the player either its roof or its underframe,
  // and both read as an anonymous corrugated wall. Standing on one corner — the
  // original +56° — it read as an abstract monolith floating over the cobbles,
  // because the face aimed down the hero sightline was the blank end cap and
  // the contact edge was hidden behind its own overhang.
  //
  // Half-toppled and rolled *toward* the southern approach, the flank the
  // player sees is the one carrying the window band, the door recesses and the
  // livery, with the bogies and the buckled underframe exposed along the bottom
  // edge. It reads as a tram from 40 m.
  //
  // The pivot is the underside of the floor pan, so the roll is paid back in
  // height: +0.85 buries the leading edge 9 cm in the cobbles — no gap to see
  // under — and puts the top of the shell at 3.8 m, which is what makes it the
  // sightline break the square is built around.
  const roll = -Math.PI * 0.28;
  body.pushTRS(x, y + 0.85, z, yaw, 0, roll);
  glass.push(body.matrix);
  rustM.push(body.matrix);
  cream.push(body.matrix);

  for (const seg of [-1, 1]) {
    const cz = seg * (L * 0.52);
    body.chamferBox(0, H, cz, W, H * 0.98, L * 0.5, 0.05, 2.0);
    // Cream livery band along the waist — the single strongest read at
    // distance, and the reason the shell stops looking like a shipping
    // container.
    for (const sx of [-1, 1]) {
      cream.box(sx * (W + 0.006), H + 0.86, cz, 0.006, 0.26, L * 0.49, 1.6);
      cream.box(sx * (W + 0.006), H - 0.62, cz, 0.006, 0.09, L * 0.49, 1.6);
    }
    // Window band.
    //
    // The pillars used to sit at the *same* z as the glass and be both longer
    // and taller than it, so every pane was buried inside its own mullion and
    // the flank rendered as one unbroken sheet of paint. They belong on the
    // midpoints *between* the bays. This is the difference between the shell
    // reading as a tram and reading as a shipping container.
    const bays = 6;
    const step = (L * 0.84) / (bays - 1);
    for (let i = 0; i < bays; i++) {
      const wz = cz - L * 0.42 + i * step;
      for (const sx of [-1, 1]) {
        glass.box(sx * (W + 0.006), H + 0.35, wz, 0.008, 0.4, step * 0.4, { unit: true });
      }
    }
    for (let i = 0; i < bays - 1; i++) {
      const pz = cz - L * 0.42 + (i + 0.5) * step;
      for (const sx of [-1, 1]) {
        body.box(sx * (W + 0.012), H + 0.35, pz, 0.018, 0.42, step * 0.12, 1.0);
      }
    }
    for (const sx of [-1, 1]) {
      rustM.box(sx * (W + 0.012), H + 0.79, cz, 0.014, 0.045, L * 0.48, 1.2);
      rustM.box(sx * (W + 0.012), H - 0.08, cz, 0.014, 0.045, L * 0.48, 1.2);
    }
    // Passenger doors: a recessed leaf pair per segment, with the rubbing strip.
    for (const sx of [-1, 1]) {
      const dz = cz - seg * L * 0.22;
      body.box(sx * (W - 0.035), H - 0.05, dz, 0.045, H * 0.86, 0.62, 1.2);
      rustM.box(sx * (W + 0.006), H - 0.05, dz, 0.01, H * 0.86, 0.02, 0.6);
    }
    // Roof: a dark, sooted deck carrying real equipment, not a clean corrugated
    // sheet. From the north half of the square this is the face the player sees
    // most of, and a bright evenly-ribbed plate read as a farm building.
    const deck = chunk.m('steelPaint');
    deck.push(body.matrix);
    deck.box(0, H * 2 - 0.02, cz, W * 0.99, 0.05, L * 0.49, 1.4);
    // Cant rail along both eaves so the roof edge catches a highlight.
    for (const sx of [-1, 1]) deck.box(sx * W * 0.97, H * 2 + 0.03, cz, 0.05, 0.05, L * 0.49, 0.8);
    deck.pop();
    // Ribs in the same dark paint as the deck. In bare sheet metal they caught
    // the key as ten evenly-spaced bright panels and the roof read as the
    // glazing of a greenhouse from the north half of the square.
    for (let i = 0; i < 5; i++) {
      const rz = cz - L * 0.4 + (i * L * 0.8) / 4;
      rustM.box(0, H * 2 + 0.02, rz, W * 0.88, 0.03, 0.05, 0.6);
    }
    // Resistor bank and a vent hood — the silhouette that says "traction".
    const kit = chunk.m('steel');
    kit.push(body.matrix);
    kit.box(seg * L * 0.16, H * 2 + 0.1, cz + seg * 0.5, W * 0.38, 0.08, 0.6, 0.5);
    kit.pop();
    rustM.box(seg * L * 0.3, H * 2 + 0.13, cz - seg * 1.5, 0.26, 0.11, 0.26, 0.4);
    rustM.box(0, 0.18, cz, W * 1.02, 0.18, L * 0.49, 1.4);
  }

  // End caps. Blank ends were what made this read as a crate: a tram has a
  // raked windscreen, a destination box, twin headlamps and a coupler, and at
  // 13 m the end is what half the map sees first.
  for (const seg of [-1, 1]) {
    const ez = seg * (L * 1.02);
    body.box(0, H + 0.15, ez, W * 0.98, H * 0.72, 0.06, 1.4);
    glass.box(0, H + 0.62, ez + seg * 0.035, W * 0.82, 0.44, 0.008, { unit: true });
    // destination box
    cream.box(0, H + 1.16, ez + seg * 0.03, W * 0.5, 0.13, 0.02, { unit: true });
    // headlamps and coupler
    for (const sx of [-1, 1]) {
      rustM.pushTRS(sx * W * 0.62, H - 0.42, ez + seg * 0.04, 0, 0, Math.PI / 2);
      rustM.cylinder(0.085, 0.085, 0.05, 8, true, false, 0.2);
      rustM.pop();
    }
    rustM.box(0, 0.28, ez + seg * 0.12, 0.09, 0.09, 0.22, 0.4);
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
  rustM.pop();
  cream.pop();
  body.pop();

  /* --- contact ---------------------------------------------------------
   * Nothing sells weight like the ground giving way under it. A berm of dirt
   * and ripped setts is banked along the underside for the full length, so
   * there is no gap to see under and no clean line where shell meets paving. */
  const rand = new Rand(6601);
  const dirt = chunk.m('dirt');
  const ux = Math.cos(yaw), uz = Math.sin(yaw);      // along the car
  const nx = -uz, nz = ux;                            // across it
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24 - 0.5) * L * 2.15;
    const side = Math.sin(i * 2.7) * 0.35;
    const bx = x + ux * t + nx * (0.35 + side);
    const bz = z + uz * t + nz * (0.35 + side);
    const s = 0.5 + 0.28 * Math.abs(Math.sin(i * 1.7));
    dirt.pushTRS(bx, groundHeightAt(bx, bz) + 0.02, bz, yaw + rand.range(-0.3, 0.3));
    dirt.lump(s, 7, 4, (k) => 0.4 + 0.3 * frac(Math.sin((k + i * 5) * 12.9898) * 43758.5), 1.2);
    dirt.pop();
  }

  // Debris and glass thrown out from the impact.
  const deb = chunk.m('concreteDark');
  const shard = chunk.m('glassDirty');
  for (let i = 0; i < 44; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(1.2, 5.5);
    const px = x + ux * rand.range(-7, 7) + Math.cos(a) * r * 0.55;
    const pz = z + uz * rand.range(-7, 7) + Math.sin(a) * r * 0.55;
    const s = rand.range(0.06, 0.2);
    const t = rand.bool(0.42) ? shard : deb;
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

/**
 * Dry municipal fountain: octagonal basin, shattered centre column.
 *
 * Rebuilt low and wide. The first version stood 0.72 m tall with a 0.4 m thick
 * parapet and a stack of drums in the middle, which from eye level read as
 * eight disconnected pale walls around a chimney rather than as a fountain. A
 * real civic basin is knee height with a moulded rim you can sit on, so the eye
 * reads *over* it to the pedestal — and the pedestal has to be a shape, not a
 * cylinder stack: plinth, moulded base, fluted shaft, a bowl, and a clean
 * shear where the shell took the top off.
 */
export function fountain(chunk: Chunk, x: number, z: number): void {
  const y = groundHeightAt(x, z);
  const m = chunk.m('stone');
  const trim = chunk.m('stoneTrim');
  const rand = new Rand(7701);
  const sides = 8;
  const outer = 3.4, inner = 3.06;
  const rimY = 0.46;

  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const mid = (a0 + a1) * 0.5;
    const len = 2 * outer * Math.tan(Math.PI / sides) * 0.5;
    const cx = x + Math.cos(mid) * (outer + inner) * 0.5;
    const cz = z + Math.sin(mid) * (outer + inner) * 0.5;
    // One panel is broken out and lying in the basin — the reason the water
    // stopped, and the way in for anything using it as cover.
    // Tangential, not radial.
    //
    // `Ry(-mid)` sends local +X *outward* along the radius, so every panel was
    // built pointing away from the centre: eight 2.9 m walls arranged like the
    // spokes of a wheel, which is exactly what the square's centre looked like.
    // A quarter turn puts the long axis on the chord, where it belongs, and the
    // basin closes into an octagon.
    const face = Math.PI / 2 - mid;
    const smashed = i === 5;
    if (!smashed) {
      m.pushTRS(cx, y + rimY * 0.5, cz, face);
      m.box(0, 0, 0, len + 0.06, rimY * 0.5, (outer - inner) * 0.5 + 0.04, 1.6);
      m.pop();
      // Moulded coping, wider than the panel so it throws a shadow line.
      trim.pushTRS(cx, y + rimY + 0.045, cz, face);
      trim.chamferBox(0, 0, 0, len + 0.14, 0.045, (outer - inner) * 0.5 + 0.13, 0.02, 1.0);
      trim.pop();
    } else {
      m.pushTRS(cx, y + 0.1, cz, face);
      m.box(0, 0, 0, len + 0.06, 0.1, (outer - inner) * 0.5 + 0.04, 1.6);
      m.pop();
      trim.pushTRS(cx - 0.5, y + 0.12, cz - 0.4, face + 0.6, 0, 0.22);
      trim.box(0, 0, 0, len * 0.7, 0.07, 0.16, 1.0);
      trim.pop();
    }
  }

  // Silted basin floor: dry, cracked, colonised.
  const floor = chunk.m('dirt');
  floor.pushTRS(x, y + 0.08, z);
  floor.cylinder(inner, inner, 0.14, 16, true, false, 1.4);
  floor.pop();
  const weed = chunk.m('foliageDry');
  for (let i = 0; i < 12; i++) {
    const a = rand.next() * Math.PI * 2, r = rand.range(0.9, 2.7);
    weed.pushTRS(x + Math.cos(a) * r, y + 0.14, z + Math.sin(a) * r, rand.next() * 3.1);
    weed.card(rand.range(0.3, 0.6), rand.range(0.25, 0.5), 0, false);
    weed.pop();
  }

  // Pedestal: plinth, torus base, fluted shaft, bowl, sheared stump.
  const col = chunk.m('stoneTrim');
  col.pushTRS(x, y + 0.22, z);
  col.cylinder(0.66, 0.6, 0.44, 12, true, false, 1.0);
  col.pop();
  col.pushTRS(x, y + 0.47, z, 0, Math.PI / 2, 0);
  col.torus(0.5, 0.08, 12, 6, 0.4);
  col.pop();
  col.pushTRS(x, y + 0.95, z);
  col.cylinder(0.28, 0.24, 0.92, 12, false, false, 0.8);
  col.pop();
  // Flutes: eight shallow ribs so the shaft is not a smooth tube.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    col.pushTRS(x + Math.cos(a) * 0.265, y + 0.95, z + Math.sin(a) * 0.265, -a);
    col.box(0, 0, 0, 0.028, 0.44, 0.028, 0.4);
    col.pop();
  }
  // Basin bowl, cracked through and tipped.
  col.pushTRS(x + 0.06, y + 1.46, z - 0.04, 0, 0, 0.09);
  col.cylinder(0.34, 0.62, 0.2, 14, true, false, 0.8);
  col.pop();
  col.pushTRS(x, y + 1.62, z, 0, 0.5, 0.4);
  col.cylinder(0.2, 0.15, 0.42, 10, true, false, 0.8);
  col.pop();

  // The sheared-off upper section, lying where it fell.
  col.pushTRS(x + 1.9, y + 0.32, z - 1.25, 0.9, Math.PI / 2 - 0.2, 0);
  col.cylinder(0.22, 0.17, 1.35, 10, true, true, 0.8);
  col.pop();
  col.pushTRS(x + 2.6, y + 0.25, z - 1.9, 1.4, Math.PI / 2 + 0.4, 0);
  col.cylinder(0.5, 0.34, 0.18, 12, true, true, 0.8);
  col.pop();

  for (let i = 0; i < 20; i++) {
    const a = rand.next() * Math.PI * 2;
    const r = rand.range(0.7, 3.4);
    const s = rand.range(0.07, 0.22);
    col.pushTRS(x + Math.cos(a) * r, y + 0.12 + s * 0.4, z + Math.sin(a) * r,
      rand.next() * 3, rand.range(-0.3, 0.3), rand.range(-0.3, 0.3));
    col.box(0, 0, 0, s, s * 0.55, s * 1.2, 0.8);
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
