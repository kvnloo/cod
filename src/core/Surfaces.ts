/**
 * Surface taxonomy — the shared vocabulary between world materials, ballistics,
 * VFX and audio.
 *
 * A single string tag drives: impact particle look, decal atlas slice, footstep
 * sample set, bullet-penetration behaviour and ricochet probability. Adding a
 * surface means adding one row here and one entry in each consumer's table.
 */

export type SurfaceType =
  | 'concrete' | 'brick' | 'stone' | 'plaster' | 'tile'
  | 'metal' | 'metalThin' | 'grate' | 'pipe'
  | 'wood' | 'woodThin' | 'plywood' | 'crate'
  | 'dirt' | 'sand' | 'gravel' | 'grass' | 'mud'
  | 'glass' | 'glassThick'
  | 'water' | 'puddle'
  | 'fabric' | 'sandbag' | 'carpet' | 'cardboard'
  | 'flesh' | 'armor' | 'helmet'
  | 'rubber' | 'plastic' | 'foliage' | 'snow' | 'ice'
  | 'asphalt';

export interface SurfaceProps {
  /** Bullet energy lost per metre of material, in joules/m. Drives penetration. */
  density: number;
  /** Max thickness in metres a full-power rifle round will defeat. */
  penetrationDepth: number;
  /** 0..1 chance a shallow-angle hit deflects instead of embedding. */
  ricochet: number;
  /** Impact spark brightness multiplier (metals spark, flesh does not). */
  sparks: number;
  /** Dust/smoke puff volume multiplier. */
  dust: number;
  /** Debris chunk count multiplier. */
  debris: number;
  /** Decal group used for bullet holes. */
  decal: 'hard' | 'soft' | 'metal' | 'glass' | 'wood' | 'blood' | 'none';
  /** Footstep sample bank. */
  footstep: string;
  /** Acoustic reflectivity 0..1 — feeds impulse selection and occlusion. */
  reflectivity: number;
  /** Physical restitution + friction used when spawning debris rigid bodies. */
  restitution: number;
  friction: number;
  /** Does shooting it break/shatter the mesh? */
  breakable?: boolean;
}

const S = (
  density: number, penetrationDepth: number, ricochet: number, sparks: number,
  dust: number, debris: number, decal: SurfaceProps['decal'], footstep: string,
  reflectivity: number, restitution: number, friction: number, breakable = false,
): SurfaceProps => ({
  density, penetrationDepth, ricochet, sparks, dust, debris, decal, footstep,
  reflectivity, restitution, friction, breakable,
});

export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  concrete: S(2400, 0.14, 0.22, 0.25, 1.4, 1.0, 'hard', 'concrete', 0.85, 0.2, 0.9),
  asphalt: S(2200, 0.12, 0.18, 0.15, 1.2, 0.8, 'hard', 'concrete', 0.7, 0.15, 0.95),
  brick: S(1900, 0.18, 0.16, 0.2, 1.6, 1.4, 'hard', 'concrete', 0.8, 0.2, 0.95),
  stone: S(2600, 0.12, 0.3, 0.35, 1.3, 1.0, 'hard', 'concrete', 0.9, 0.25, 0.85),
  plaster: S(900, 0.3, 0.05, 0.0, 1.8, 1.2, 'hard', 'wood', 0.5, 0.1, 0.8),
  tile: S(2100, 0.1, 0.2, 0.15, 0.9, 1.6, 'hard', 'tile', 0.95, 0.3, 0.7, true),
  metal: S(7800, 0.05, 0.55, 1.0, 0.15, 0.3, 'metal', 'metal', 0.95, 0.35, 0.5),
  metalThin: S(7800, 0.22, 0.35, 0.9, 0.1, 0.2, 'metal', 'metal', 0.9, 0.3, 0.5),
  grate: S(7800, 0.4, 0.25, 0.8, 0.05, 0.1, 'metal', 'metal', 0.85, 0.3, 0.6),
  pipe: S(7800, 0.08, 0.6, 1.1, 0.1, 0.2, 'metal', 'metal', 0.95, 0.4, 0.4),
  wood: S(700, 0.35, 0.06, 0.0, 0.5, 1.6, 'wood', 'wood', 0.55, 0.2, 0.85),
  woodThin: S(600, 0.6, 0.03, 0.0, 0.4, 1.4, 'wood', 'wood', 0.45, 0.2, 0.85),
  plywood: S(550, 0.7, 0.02, 0.0, 0.6, 1.2, 'wood', 'wood', 0.4, 0.15, 0.85),
  crate: S(650, 0.5, 0.04, 0.0, 0.5, 2.0, 'wood', 'wood', 0.5, 0.25, 0.8, true),
  dirt: S(1500, 0.45, 0.02, 0.0, 2.2, 0.6, 'soft', 'dirt', 0.2, 0.05, 1.0),
  sand: S(1600, 0.5, 0.01, 0.0, 2.8, 0.4, 'soft', 'sand', 0.1, 0.02, 1.05),
  gravel: S(1700, 0.4, 0.08, 0.05, 2.0, 1.4, 'soft', 'gravel', 0.3, 0.15, 1.0),
  grass: S(1200, 0.5, 0.01, 0.0, 1.4, 0.6, 'soft', 'grass', 0.15, 0.05, 1.0),
  mud: S(1400, 0.55, 0.0, 0.0, 1.0, 0.3, 'soft', 'mud', 0.1, 0.02, 1.1),
  snow: S(400, 0.9, 0.0, 0.0, 2.6, 0.2, 'soft', 'snow', 0.08, 0.02, 0.7),
  ice: S(920, 0.25, 0.35, 0.1, 0.6, 1.2, 'glass', 'ice', 0.9, 0.3, 0.12),
  glass: S(2500, 0.9, 0.02, 0.1, 0.2, 2.6, 'glass', 'tile', 1.0, 0.25, 0.4, true),
  glassThick: S(2500, 0.35, 0.06, 0.15, 0.3, 2.2, 'glass', 'tile', 1.0, 0.25, 0.4, true),
  water: S(1000, 1.2, 0.4, 0.0, 0.0, 0.0, 'none', 'water', 0.2, 0.0, 0.6),
  puddle: S(1000, 1.5, 0.3, 0.0, 0.0, 0.0, 'none', 'water', 0.4, 0.0, 0.7),
  fabric: S(300, 1.1, 0.0, 0.0, 0.5, 0.2, 'soft', 'fabric', 0.05, 0.05, 0.9),
  sandbag: S(1650, 0.28, 0.0, 0.0, 2.4, 0.8, 'soft', 'sand', 0.08, 0.03, 1.05),
  carpet: S(350, 1.0, 0.0, 0.0, 0.4, 0.2, 'soft', 'carpet', 0.06, 0.05, 0.95),
  cardboard: S(200, 1.4, 0.0, 0.0, 0.3, 0.6, 'soft', 'fabric', 0.1, 0.1, 0.8),
  flesh: S(1050, 0.9, 0.0, 0.0, 0.0, 0.0, 'blood', 'flesh', 0.05, 0.05, 0.9),
  armor: S(3200, 0.09, 0.3, 0.5, 0.1, 0.2, 'metal', 'fabric', 0.6, 0.2, 0.7),
  helmet: S(2800, 0.07, 0.45, 0.6, 0.1, 0.2, 'metal', 'fabric', 0.7, 0.3, 0.6),
  rubber: S(1100, 0.5, 0.0, 0.0, 0.2, 0.4, 'soft', 'rubber', 0.15, 0.55, 1.1),
  plastic: S(1200, 0.4, 0.1, 0.05, 0.3, 1.2, 'hard', 'plastic', 0.5, 0.35, 0.7, true),
  foliage: S(200, 2.0, 0.0, 0.0, 0.1, 0.0, 'none', 'grass', 0.02, 0.1, 1.0),
};

export function surface(t: SurfaceType | undefined): SurfaceProps {
  return SURFACES[t ?? 'concrete'] ?? SURFACES.concrete;
}

/**
 * Stashes a surface tag on a mesh so ballistics can recover it from a raycast
 * hit without a side table.
 */
export function tagSurface(obj: { userData: Record<string, unknown> }, t: SurfaceType): void {
  obj.userData.surface = t;
}

export function readSurface(obj: { userData?: Record<string, unknown> } | null | undefined): SurfaceType {
  return (obj?.userData?.surface as SurfaceType | undefined) ?? 'concrete';
}
