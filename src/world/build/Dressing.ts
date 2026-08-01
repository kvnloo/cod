/**
 * World-art acceptance vantages.
 *
 * The three hero-art contracts in this folder — the town-hall arcade
 * (`Buildings.ts`), the derailed tram (`SetPieces.ts`) and the receding city
 * (`Backdrop.ts`) — are each judged at a *specific* distance:
 *
 *  - every arcade bay legible from two independent vantages,
 *  - the tram identifiable as a tram at 8 m, 22 m and 40 m,
 *  - each backdrop band measurably below the sky it is cut out against.
 *
 * The shipping shot list has nothing at 8 m or 40 m from the tram, so those
 * verdicts were previously argued from whichever registered camera happened to
 * be closest. These cameras are placed off the geometry they are grading — the
 * tram set is built on the post-roll normal of the square-facing flank, so it
 * follows the object if the lean is ever re-tuned — and they are registered
 * only under `?debug=worldart`, so a normal `capture.mjs` run and the contact
 * sheet it feeds are byte-for-byte unaffected.
 *
 *   node tools/capture.mjs --debug worldart --shots wa-tram-08,wa-tram-22,wa-tram-40
 */

import { DEBUG_SCENE, registerDebugScene, registerShots } from '../../core/Shots';
import type { ShotDef } from '../../core/CaptureAPI';
import { TRAM_LEAN } from './SetPieces';
import { TRAM } from '../props/Dressing';
import { FOOTPRINTS } from '../Layout';

/** Cameras placed on the normal of the tram's square-facing flank. */
function tramVantages(): ShotDef[] {
  const { x, z, yaw } = TRAM;
  const roll = TRAM_LEAN.mean;
  // Outward horizontal normal of the −X flank: local (−1,0,0) rolled about the
  // car's long axis, then yawed into world. The Y component only tilts the
  // face; the ground track is what places the camera.
  const c = Math.cos(roll);
  const nx = -c * Math.cos(yaw);
  const nz = c * Math.sin(yaw);
  const len = Math.hypot(nx, nz) || 1;
  const ux = nx / len, uz = nz / len;
  // Long axis of the car, used to slide the far vantage clear of the fuel-drum
  // cluster that sits on the exact normal at 40 m.
  const ax = Math.sin(yaw), az = Math.cos(yaw);
  // Camera stands at +d along the normal, offset along the car, and aims at the
  // tram centre. A `ShotDef` yaw θ gives forward (−sin θ, 0, −cos θ).
  return ([[8, 0, 1.72], [22, 1.5, 1.72], [40, 4.5, 2.15]] as const).map(([d, lat, eye]) => {
    const px = x + ux * d + ax * lat;
    const pz = z + uz * d + az * lat;
    const fx = x - px, fz = z - pz;
    const shotYaw = (Math.atan2(-fx, -fz) * 180) / Math.PI;
    return {
      name: `wa-tram-${String(d).padStart(2, '0')}`,
      description:
        `Tram identification test at ${d} m: broadside on the square-facing flank, `
        + 'glazing band, livery and bogies all in frame',
      position: [px, eye, pz] as [number, number, number],
      yaw: shotYaw,
      pitch: d <= 10 ? 1.5 : -1.0,
      fov: d <= 10 ? 78 : 55,
      viewModel: false,
    };
  });
}

/** Two independent looks at all five arcade bays. */
function arcadeVantages(): ShotDef[] {
  const f = FOOTPRINTS.townHall;
  const cx = (f.x0 + f.x1) * 0.5;
  return [
    {
      name: 'wa-arcade-all',
      description: 'All five town-hall arcade bays square on from the plaza at 20 m',
      position: [cx, 1.95, f.z1 + 20], yaw: 0, pitch: 5.5, fov: 74, viewModel: false,
    },
    {
      name: 'wa-arcade-raking',
      description: 'The same five bays raking from the south-west above the barrier line, so every arch head is read in perspective',
      position: [f.x0 + 5.0, 3.6, f.z1 + 13], yaw: -22, pitch: 3.0, fov: 74, viewModel: false,
    },
  ];
}

/** Backdrop value ladder: the same frame as `overview` but without the weapon. */
function backdropVantages(): ShotDef[] {
  return [
    {
      name: 'wa-backdrop',
      description: 'Backdrop value ladder: near sheds, three city bands and the mountain ranges against the horizon sky',
      position: [0, 22, 30], yaw: 0, pitch: -2.0, fov: 62, viewModel: false,
    },
    {
      /**
       * Aerial-perspective ladder. Lane A is the only 80 m sightline on the
       * map, and at the shipping 80° fov an 8 m facade and an 80 m facade land
       * 25 px apart at the vanishing point, so no honest same-area contrast
       * comparison is possible from the registered `lane-a` camera. A 34° lens
       * from the south end of the lane separates them: the same 3.0 × 1.4 m of
       * east-facing (therefore uniformly shaded) render measures 595 px wide at
       * 8.9 m, 97 px at 54 m and 67 px at 79 m.
       */
      name: 'wa-lane-ladder',
      description: 'Long lens down lane A: the same facade plane at 9 m, 54 m and 79 m for an aerial-perspective contrast ladder',
      position: [-30, 2.6, 34], yaw: 0, pitch: -1.0, fov: 34, viewModel: false,
    },
  ];
}

export function registerWorldArtVantages(): void {
  if (DEBUG_SCENE !== 'worldart') return;
  registerShots([...arcadeVantages(), ...tramVantages(), ...backdropVantages()]);
  // The level itself is the subject; nothing to build, but registering the
  // scene keeps `?debug=worldart` from logging an unknown-scene warning.
  registerDebugScene('worldart', () => { /* the shipped level is the test bed */ });
}
