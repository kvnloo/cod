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
 * Roll of the two half-cars, in radians, and their mean.
 *
 * Exported because the acceptance vantages in `build/Dressing.ts` are placed on
 * the normal of the square-facing flank: if this lean is ever re-tuned the
 * cameras that grade it follow, instead of quietly grading a different face.
 */
export const TRAM_LEAN = { lead: -0.2269, trail: -0.1745, mean: -0.2007 } as const;

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
  /**
   * Derailed and keeled over, **not** rolled on to its side.
   *
   * The previous −50° roll was the reason this object was unidentifiable. A
   * tram is read almost entirely from one cue — a long continuous horizontal
   * band of glass at head height with painted panel above and below it — and
   * rolling the shell 50° takes that band off the vertical entirely: the flank
   * facing the square becomes a 50° slope, so the glazing reads as a skylight,
   * the cream waist band rotates up next to the roof edge and reads as
   * tarpaulin, and the silhouette collapses to a wedge. Blind critics called it
   * a shed at 8 m, a skip at 10 m and a shipping container at 22 m.
   *
   * 10–13° is what a tram that has come off the rails and dropped a bogie
   * actually does, and it keeps every cue where the eye expects it: the flanks
   * stay within 13° of vertical, the glazing band lands 1.57–2.13 m above the
   * cobbles on both faces, the livery stays on the sides, the roof stays on
   * top with its resistor bank and pantograph against the sky, and the low side
   * digs its wheels into the setts while the high side lifts clear of them.
   *
   * `lift` is solved from the roll rather than authored, so the shell always
   * meets the ground the same way whatever the lean: the lowest corner of the
   * body sits 2 cm clear of the paving and the bogie on that side is buried.
   */
  const bodyLift = (roll: number): number => 0.02 - (W * Math.sin(roll) + 0.032 * Math.cos(roll));

  // Jackknifed, and the two half-cars are *not* copies.
  //
  // Built as one transform with a mirrored loop, this read as two identical
  // containers butted end to end with a seam down the middle — which is
  // exactly what it was. A derailed articulated tram folds at the joint, and
  // the leading car takes the damage: so each half now gets its own yaw and
  // roll about the articulation point, its own bay count, its own door
  // positions and its own state of repair.
  const rollLead = TRAM_LEAN.lead, rollTrail = TRAM_LEAN.trail;   // −13° and −10°
  const roll = TRAM_LEAN.mean;
  const segYaw = { '-1': yaw - 0.115, '1': yaw + 0.10 } as Record<string, number>;
  const segRoll = { '-1': rollLead, '1': rollTrail } as Record<string, number>;

  /* Band layout, authored against the upright shell (0 → 3.17 local) and then
   * checked against the post-roll world heights, which is the step the old
   * version skipped. */
  const bandY = H + 0.02, bandH = 0.38;               // glazing 1.24 – 2.00
  const railUp = H + 0.46, railDn = H - 0.43;         // waist rails
  const liveryY = H + 0.78, liveryH = 0.26;           // cream 2.12 – 2.64
  const skirtY = H - 0.64, skirtH = 0.09;             // lower stripe

  for (const seg of [-1, 1]) {
    const lead = seg === -1;                          // the car that ploughed
    body.pushTRS(x, y + bodyLift(segRoll[String(seg)]), z, segYaw[String(seg)], 0, segRoll[String(seg)]);
    glass.push(body.matrix);
    rustM.push(body.matrix);
    cream.push(body.matrix);
    /**
     * Saloon interior behind every pane.
     *
     * `glassDirty` is authored at opacity 0.26, so a pane laid straight on an
     * opaque flank composites 74% of the *body paint* and renders as a slightly
     * shiny panel the same value as the shell — which is why the window band
     * measured as decoration rather than as glazing. A near-black reveal one
     * centimetre behind each pane, sized slightly proud of it, gives the band
     * both the dark interior a real window has and a visible frame, and it is
     * the single strongest identification cue the shape has at 40 m.
     */
    const cabin = chunk.m('rubber');
    cabin.push(body.matrix);
    const cz = seg * (L * 0.52);
    body.chamferBox(0, H, cz, W, H * 0.98, L * 0.5, 0.05, 2.0);
    // Cream livery band along the waist — the single strongest read at
    // distance, and the reason the shell stops looking like a shipping
    // container.
    for (const sx of [-1, 1]) {
      cream.box(sx * (W + 0.006), liveryY, cz, 0.006, liveryH, L * 0.49, 1.6);
      cream.box(sx * (W + 0.006), skirtY, cz, 0.006, skirtH, L * 0.49, 1.6);
    }
    // Window band.
    //
    // The pillars used to sit at the *same* z as the glass and be both longer
    // and taller than it, so every pane was buried inside its own mullion and
    // the flank rendered as one unbroken sheet of paint. They belong on the
    // midpoints *between* the bays. This is the difference between the shell
    // reading as a tram and reading as a shipping container.
    const bays = lead ? 5 : 6;
    const step = (L * 0.84) / (bays - 1);
    for (let i = 0; i < bays; i++) {
      const wz = cz - L * 0.42 + i * step;
      // The leading car lost two panes; the reveal stays, so a blown-out window
      // reads as an empty frame rather than as a missing bay.
      const blown = lead && (i === 1 || i === 3);
      for (const sx of [-1, 1]) {
        cabin.box(sx * (W + 0.004), bandY, wz, 0.012, bandH + 0.02, step * 0.44, 1.0);
        if (!blown) glass.box(sx * (W + 0.024), bandY, wz, 0.006, bandH * 0.9, step * 0.38, { unit: true });
      }
    }
    for (let i = 0; i < bays - 1; i++) {
      const pz = cz - L * 0.42 + (i + 0.5) * step;
      for (const sx of [-1, 1]) {
        body.box(sx * (W + 0.012), bandY, pz, 0.018, bandH + 0.02, step * 0.12, 1.0);
      }
    }
    for (const sx of [-1, 1]) {
      rustM.box(sx * (W + 0.012), railUp, cz, 0.014, 0.045, L * 0.48, 1.2);
      rustM.box(sx * (W + 0.012), railDn, cz, 0.014, 0.045, L * 0.48, 1.2);
    }
    // Passenger doors: the leading car has a single wide door aft of centre,
    // the trailing car a pair either side of its bogie — different rhythms, so
    // the two flanks never line up.
    const doors = lead ? [-0.22] : [-0.30, 0.24];
    for (const dOff of doors) {
      const dz = cz - seg * L * dOff;
      for (const sx of [-1, 1]) {
        // Door leaf from the step to just above the window head, not the whole
        // flank: the break has to read against the glazing band, not swallow it.
        body.box(sx * (W - 0.035), H - 0.35, dz, 0.045, H * 0.72, lead ? 0.78 : 0.55, 1.2);
        rustM.box(sx * (W + 0.006), H - 0.35, dz, 0.01, H * 0.72, 0.02, 0.6);
        // Glazed upper half of the door, level with the saloon windows.
        cabin.box(sx * (W + 0.004), bandY, dz, 0.012, bandH * 0.9, (lead ? 0.74 : 0.52), 1.0);
        glass.box(sx * (W + 0.024), bandY, dz, 0.006, bandH * 0.8, (lead ? 0.68 : 0.46), { unit: true });
      }
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

    // End cap. Blank ends were what made this read as a crate: a tram has a
    // raked windscreen, a destination box, twin headlamps and a coupler, and
    // at 13 m the end is what half the map sees first.
    const ez = seg * (L * 1.02);
    body.box(0, H + 0.15, ez, W * 0.98, H * 0.72, 0.06, 1.4);
    if (!lead) {
      // Windscreen head aligned with the saloon band so the horizontal reads
      // right round the corner — that continuity is most of the "tram" cue.
      cabin.box(0, bandY + 0.08, ez + seg * 0.02, W * 0.86, bandH + 0.10, 0.012, 1.0);
      glass.box(0, bandY + 0.08, ez + seg * 0.045, W * 0.80, bandH + 0.06, 0.006, { unit: true });
    } else {
      // Windscreen gone, cab roof stove in on the impact corner.
      rustM.box(0, bandY + 0.16, ez + seg * 0.03, W * 0.82, 0.05, 0.03, 0.5);
      body.pushTRS(W * 0.45, H * 2 - 0.12, ez - seg * 0.35, 0, 0, -0.32);
      body.box(0, 0, 0, W * 0.5, 0.05, 0.55, 1.2);
      body.pop();
    }
    // destination box
    cream.box(0, H + 1.16, ez + seg * 0.03, W * 0.5, 0.13, 0.02, { unit: true });
    // headlamps and coupler
    for (const sx of [-1, 1]) {
      rustM.pushTRS(sx * W * 0.62, H - 0.42, ez + seg * 0.04, 0, 0, Math.PI / 2);
      rustM.cylinder(0.085, 0.085, 0.05, 8, true, false, 0.2);
      rustM.pop();
    }
    rustM.box(0, 0.28, ez + seg * 0.12, 0.09, 0.09, 0.22, 0.4);

    // Bogies and wheels for this half-car, now facing sideways.
    const wh = chunk.m('steel');
    wh.push(body.matrix);
    for (const bz of [seg * L * 0.15, seg * L * 0.78]) {
      wh.box(0, -0.05, bz, W * 0.7, 0.16, 0.4, 0.8);
      for (const sx of [-1, 1]) {
        wh.pushTRS(sx * W * 0.6, -0.05, bz, 0, 0, Math.PI / 2);
        wh.cylinder(0.34, 0.34, 0.09, 12, true, true, 0.4);
        wh.pop();
      }
    }
    wh.pop();

    if (!lead) {
      // Pantograph, sprung half-open and bent over. With the shell upright this
      // is the one part of the silhouette that is unambiguously electric
      // traction, so it reads against the sky rather than lying along the deck.
      const pan = chunk.m('rust');
      pan.push(body.matrix);
      pan.tube([V3(-0.5, H * 2 + 0.04, 0.5), V3(0.05, H * 2 + 1.05, 1.15), V3(-0.42, H * 2 + 1.72, 2.0)], 0.036, 5, false, 0.5);
      pan.tube([V3(0.5, H * 2 + 0.04, 0.5), V3(0.05, H * 2 + 1.05, 1.15)], 0.032, 5, false, 0.5);
      pan.tube([V3(-0.55, H * 2 + 1.66, 2.0), V3(0.55, H * 2 + 1.78, 2.0)], 0.028, 4, false, 0.4);
      // Pan base insulators.
      for (const sx of [-1, 1]) pan.box(sx * 0.5, H * 2 + 0.02, 0.5, 0.07, 0.06, 0.07, 0.3);
      pan.pop();
    }

    cabin.pop();
    glass.pop();
    rustM.pop();
    cream.pop();
    body.pop();
  }

  /* --- articulation ----------------------------------------------------
   * The joint is the thing that proves this is one vehicle and not two. It
   * gets a turntable ring, a concertina wide enough to bridge the fold, and
   * the torn skirt plates that pulled apart when the cars jackknifed. */
  const midLift = bodyLift(roll);
  const bel = chunk.m('rubber');
  bel.pushTRS(x, y + midLift, z, yaw - 0.01, 0, roll - 0.01);
  for (let i = 0; i < 7; i++) {
    const t = (i - 3) * 0.115;
    bel.box(0, H, t, W * 0.93 + (i % 2) * 0.055, H * 0.88, 0.055, 0.6);
  }
  bel.pop();
  const ring = chunk.m('steel');
  ring.pushTRS(x, y + midLift, z, yaw - 0.01, 0, roll - 0.01);
  ring.box(0, 0.1, 0, W * 0.92, 0.09, 0.5, 0.8);
  for (const sx of [-1, 1]) ring.box(sx * W * 0.96, H, 0, 0.04, H * 0.5, 0.42, 0.6);
  ring.pop();

  /* --- contact ---------------------------------------------------------
   * Nothing sells weight like the ground giving way under it. A berm of dirt
   * and ripped setts is banked along both flanks for the full length, heavier
   * on the low side where the bogie is buried.
   *
   * The two basis vectors below were swapped: `(cos yaw, sin yaw)` is the
   * *across* axis of a `pushTRS(_, _, _, yaw)` transform, not the along axis,
   * so the berm, the thrown debris and the derailment gouge all ran across the
   * car instead of down it — a 14 m ridge of dirt at right angles to the tram
   * and a scar that pointed at nothing. */
  const rand = new Rand(6601);
  const dirt = chunk.m('dirt');
  const ux = Math.sin(yaw), uz = Math.cos(yaw);      // along the car (local +Z)
  const nx = Math.cos(yaw), nz = -Math.sin(yaw);     // across it   (local +X)
  for (const sideSign of [1, -1]) {
    const heavy = sideSign > 0 ? 1.0 : 0.72;         // low flank gets the bank
    for (let i = 0; i <= 22; i++) {
      const t = (i / 22 - 0.5) * L * 2.05;
      const jitter = Math.sin(i * 2.7 + sideSign) * 0.16;
      const c = sideSign * (1.30 + jitter);
      const bx = x + ux * t + nx * c;
      const bz = z + uz * t + nz * c;
      const s = (0.42 + 0.24 * Math.abs(Math.sin(i * 1.7 + sideSign))) * heavy;
      dirt.pushTRS(bx, groundHeightAt(bx, bz) + 0.02, bz, yaw + rand.range(-0.3, 0.3));
      dirt.lump(s, 7, 4, (k) => 0.4 + 0.3 * frac(Math.sin((k + i * 5) * 12.9898) * 43758.5), 1.2);
      dirt.pop();
    }
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

  /* --- derailment scar --------------------------------------------------
   * Twenty-five tonnes of tram does not come to rest on undisturbed paving.
   * It left the rails somewhere up the alignment and ploughed across the
   * square: a gouge of torn setts and sub-base curving out of the trackbed,
   * ballast kicked out along it, and a bow wave of paving shoved up on the
   * outside of the turn where the flange dug in. */
  const scar = chunk.m('dirt');
  const torn = chunk.m('setts');
  const ballast = chunk.m('gravel');
  const start = { x: 0.9, z: -21.5 };                 // still on the alignment
  // The gouge ends under the *leading* car (local −Z), which is the end that
  // ploughed; it used to be computed off the trailing end and off the wrong
  // basis vector, so it pointed away from the vehicle entirely.
  const nose = { x: x - ux * L * 0.95, z: z - uz * L * 0.95 };
  const steps = 22;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Quadratic swing: straight out of the trackbed, then hard across.
    const cx = start.x + (nose.x - start.x) * t + Math.sin(t * Math.PI) * -1.9;
    const cz = start.z + (nose.z - start.z) * t;
    const width = 0.55 + t * 1.15;
    const gy = groundHeightAt(cx, cz);
    // The gouge floor itself.
    scar.pushTRS(cx, gy - 0.015, cz, Math.atan2(nose.x - start.x, nose.z - start.z));
    scar.box(0, 0, 0, width, 0.035, 0.95, 1.4);
    scar.pop();
    // Paving shoved aside, standing proud on both lips.
    for (const side of [-1, 1] as const) {
      if (!rand.bool(0.7)) continue;
      const px = cx + side * width * rand.range(0.95, 1.3);
      const pz = cz + rand.range(-0.4, 0.4);
      const w = rand.range(0.16, 0.34);
      torn.pushTRS(px, groundHeightAt(px, pz) - 0.02, pz,
        rand.range(0, 6.28), -rand.range(0.3, 0.95), rand.range(-0.3, 0.3));
      torn.box(0, w * 0.5, 0, w * 0.6, w * 0.5, rand.range(0.035, 0.06), 0.4);
      torn.pop();
    }
    // Ballast kicked clear of the bed.
    for (let k = 0; k < 2; k++) {
      const bx = cx + rand.range(-2.4, 2.4), bz = cz + rand.range(-1.6, 1.6);
      const s = rand.range(0.28, 0.6);
      ballast.pushTRS(bx, groundHeightAt(bx, bz) + 0.005, bz, rand.range(0, 6.28));
      ballast.lump(s, 6, 3, (kk) => 0.2 + 0.16 * frac(Math.sin((kk + i * 3 + k) * 12.9898) * 43758.5), 1.0);
      ballast.pop();
    }
  }
  // Settled dust: a pale skirt of pulverised sub-base thrown out downwind.
  //
  // Emphatically *not* a rectangular plate laid a few centimetres over the
  // cobbles — that reads as a sheet of concrete dropped on the road, straight
  // edges and all. Flattened lumps have an organic outline and die into the
  // paving at their rim.
  for (let i = 0; i < 26; i++) {
    const t = rand.next();
    const cx = start.x + (nose.x - start.x) * t + Math.sin(t * Math.PI) * -1.9 + rand.range(-3.4, 3.4);
    const cz = start.z + (nose.z - start.z) * t + rand.range(-2.6, 2.6);
    const s = rand.range(0.5, 1.35);
    scar.pushTRS(cx, groundHeightAt(cx, cz) + 0.012, cz, rand.range(0, 6.28), 0, 0, 1, 0.075, 1);
    scar.lump(s, 9, 4, (k) => 0.55 + 0.5 * frac(Math.sin((k + i * 17) * 12.9898) * 43758.5), 1.6);
    scar.pop();
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
