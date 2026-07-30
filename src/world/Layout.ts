/**
 * Blackout — the level's layout constants.
 *
 * A war-torn Eastern-European town square, 120 m × 120 m, built on the classic
 * three-lane read:
 *
 *                        N  (−Z)
 *   ┌──────── town hall ─────────┬─── clinic ────┐
 *   │  ▓ apartment terrace ▓     │               │
 *   │  ▓ (rooftop route)   ▓  ██ SQUARE ██  ▓ warehouse ▓
 *   │  lane A          shops ▓  ██ (lane B) ██  ▓ shops   lane C
 *   │  ▓ café ▓              ▓  ██        ██  ▓ offices  │
 *   └──── ruin ────┬─ south apartments (arch) ──┴── garage ┘
 *                        S  (+Z)
 *
 *  - **Lane A** (west, x ≈ −30): a tight street with a café, a fire escape and
 *    the terrace rooftop route above it.
 *  - **Lane B** (centre): the destroyed square itself — long sightlines broken
 *    by a toppled tram, craters, barriers and market stalls.
 *  - **Lane C** (east, x ≈ +30): warehouse forecourt and office frontage.
 *
 *  Flanking cross-routes run at z ≈ −36 (north street), z ≈ −8 (shop passages)
 *  and z ≈ +32 (south street), plus the interior route through the warehouse
 *  and the arch passage under the south apartments.
 */

export const MAP = {
  /** Playable half-extent; the clip ring sits here. */
  half: 56,
  /** Full bounds including backdrop dressing. */
  outer: 74,
  groundY: 0,
} as const;

export const LANE = {
  /** West street centre-line and half-width. */
  aX: -30, aHalf: 5.5,
  /** East street centre-line and half-width. */
  cX: 30, cHalf: 5.5,
  /** North cross street. */
  northZ: -36, northHalf: 4.75,
  /** South cross street. */
  southZ: 32, southHalf: 4.75,
} as const;

/** The open square: the centre lane and the map's visual anchor. */
export const SQUARE = {
  x0: -14, x1: 14,
  z0: -33, z1: 20,
  /** Raised terrace in front of the town hall. */
  terraceZ0: -40, terraceZ1: -33.5, terraceY: 1.25,
} as const;

export interface Footprint { x0: number; z0: number; x1: number; z1: number; }

/** Every building footprint, used by terrain, scatter and the pavement ring. */
export const FOOTPRINTS: Record<string, Footprint> = {
  townHall: { x0: -17, z0: -55, x1: 17, z1: -40 },
  clinic: { x0: 24, z0: -55, x1: 47, z1: -40 },
  terraceN: { x0: -50, z0: -55, x1: -37, z1: -37 },
  terraceM: { x0: -50, z0: -37, x1: -37, z1: -22 },
  terraceS: { x0: -50, z0: -22, x1: -37, z1: -6 },
  cafe: { x0: -50, z0: -2, x1: -37, z1: 12 },
  apartmentSW: { x0: -50, z0: 17, x1: -34, z1: 30 },
  ruinSW: { x0: -52, z0: 38, x1: -34, z1: 53 },
  shopsW: { x0: -25, z0: -33, x1: -16, z1: -10 },
  shopsW2: { x0: -25, z0: -5, x1: -16, z1: 20 },
  shopsE: { x0: 16, z0: -33, x1: 25, z1: -10 },
  shopsE2: { x0: 16, z0: -5, x1: 25, z1: 20 },
  warehouse: { x0: 27, z0: -33, x1: 50, z1: -8 },
  offices: { x0: 30, z0: 4, x1: 50, z1: 28 },
  garage: { x0: 28, z0: 36, x1: 46, z1: 52 },
  apartmentS: { x0: -14, z0: 36, x1: 12, z1: 53 },
};

/** Player and AI spawn anchors, kept away from the crossfire lanes. */
export const SPAWN_POINTS = [
  { x: 0, z: 14, yaw: 180, team: 'player' as const },
  { x: -30, z: 22, yaw: 175, team: 'player' as const },
  { x: 30, z: 22, yaw: 190, team: 'player' as const },
  { x: 0, z: -30, yaw: 0, team: 'enemy' as const },
  { x: -30, z: -30, yaw: 20, team: 'enemy' as const },
  { x: 30, z: -28, yaw: -20, team: 'enemy' as const },
  { x: -40, z: 4, yaw: 90, team: 'neutral' as const },
  { x: 38, z: -18, yaw: -90, team: 'neutral' as const },
];

/** True when (x,z) is inside any building footprint, with an optional margin. */
export function insideBuilding(x: number, z: number, margin = 0): boolean {
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    if (x > f.x0 - margin && x < f.x1 + margin && z > f.z0 - margin && z < f.z1 + margin) return true;
  }
  return false;
}

/** Distance to the nearest building facade (negative when inside). */
export function distanceToBuildings(x: number, z: number): number {
  let best = Infinity;
  for (const k in FOOTPRINTS) {
    const f = FOOTPRINTS[k];
    const dx = Math.max(f.x0 - x, 0, x - f.x1);
    const dz = Math.max(f.z0 - z, 0, z - f.z1);
    const d = Math.hypot(dx, dz);
    if (dx === 0 && dz === 0) {
      const inner = -Math.min(x - f.x0, f.x1 - x, z - f.z0, f.z1 - z);
      if (inner < best) best = inner;
    } else if (d < best) best = d;
  }
  return best;
}
