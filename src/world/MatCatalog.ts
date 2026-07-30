/**
 * The level's material palette.
 *
 * A level does not ask for "a material" — it asks for *a named surface in the
 * art direction*: `plasterOchre`, `brickSoot`, `roofTile`. Each key resolves to
 * one procedural archetype from the material library plus tint/scale/wear
 * overrides, and carries the gameplay `SurfaceType` used for ballistics, decals
 * and footsteps.
 *
 * Keeping the palette in one table is what stops a 12-building map turning into
 * a hundred one-off `MeshStandardMaterial`s: the whole level resolves to ~35
 * cached materials, and geometry is batched per key.
 *
 * The palette is deliberately warm-neutral with three accent renders (ochre,
 * rose, sage) — the Eastern-European civic palette — plus soot and water
 * staining, so no two facades read the same at distance.
 */

import * as THREE from 'three';
import type { SurfaceType } from '../core/Surfaces';
import type { MaterialSystem, MaterialOptions } from '../material/MaterialLibrary';

export type MatKey =
  /* masonry & render */
  | 'brick' | 'brickSoot' | 'brickPale'
  | 'plasterCream' | 'plasterOchre' | 'plasterSage' | 'plasterRose' | 'plasterBlue'
  | 'plasterGrey' | 'plasterInt' | 'plasterIntWarm'
  | 'concrete' | 'concreteDark' | 'concreteWet' | 'stone' | 'stoneTrim' | 'cobble'
  /* ground */
  | 'asphalt' | 'asphaltWorn' | 'pavement' | 'kerb' | 'dirt' | 'gravel' | 'grass' | 'puddle'
  | 'setts' | 'scorch'
  /* roofs */
  | 'roofTile' | 'roofFelt'
  /* timber */
  | 'wood' | 'woodPaint' | 'plank' | 'plywood' | 'crate'
  /* metals */
  | 'steel' | 'steelPaint' | 'rust' | 'sheet' | 'alu' | 'grate' | 'pipe' | 'copper'
  | 'paintRed' | 'paintYellow'
  /* soft & misc */
  | 'glass' | 'glassDirty' | 'canvasRed' | 'canvasGreen' | 'canvasCream'
  | 'sandbag' | 'rubber' | 'plastic' | 'hazard' | 'foliage' | 'foliageDry'
  /* emissive practicals */
  | 'lampSodium' | 'lampWarm' | 'fluoro' | 'beacon' | 'ember' | 'signGlow'
  /* backdrop */
  | 'backdropFar' | 'backdropMid' | 'ridgeNear' | 'ridgeMid' | 'ridge';

interface MatDef {
  archetype: string;
  surface: SurfaceType;
  opts?: MaterialOptions;
  /** Flat colour used when the material library is unavailable. */
  fallback: number;
  /** Backdrop-style materials skip the procedural stack entirely. */
  flat?: { roughness: number; metalness: number };
}

/**
 * Surfaces that carry a second, vertex-blended layer.
 *
 * This is the level's grounding system. A wall is not one material: render
 * blows off at the base and around shell damage to show the masonry behind it,
 * and dirt banks up wherever the ground meets something vertical. Both are
 * driven by a weight written into the geometry's colour attribute at build
 * time, so the transition is height-aware (the blend layer settles into mortar
 * lines rather than fading over them) and costs no extra draw calls.
 *
 * Anything listed here MUST be emitted with a blend weight — see
 * `Chunk.emit({ blend })` and `PropScatter`.
 */
const BLENDED: Partial<Record<MatKey, true>> = {
  plasterCream: true, plasterOchre: true, plasterSage: true, plasterRose: true,
  plasterBlue: true, plasterGrey: true, plasterInt: true, plasterIntWarm: true,
  brick: true, brickPale: true, brickSoot: true,
  stone: true, concrete: true, concreteDark: true,
  asphalt: true, asphaltWorn: true, pavement: true, cobble: true, setts: true,
  roofFelt: true,
};

const D: Record<MatKey, MatDef> = {
  /* ------------------------------------------------------------- masonry */
  /* Fired clay, not terracotta plastic: the raw archetype reads far too light
   * and pink at close range, so it is knocked down and slightly desaturated. */
  brick: { archetype: 'brick', surface: 'brick', fallback: 0x8a4a38, opts: { scale: 3.2, tint: 0x8f6151, saturation: 0.9, wear: 0.55, blendWith: 'dirt', blendScale: 1.3 } },
  brickSoot: { archetype: 'brick', surface: 'brick', fallback: 0x4a3128, opts: { scale: 3.2, tint: 0x6e5c52, saturation: 0.45, wear: 0.85, blendWith: 'dirt', blendScale: 1.3 } },
  brickPale: { archetype: 'brick', surface: 'brick', fallback: 0xb09a72, opts: { scale: 3.4, tint: 0xd6c199, hue: 0.03, saturation: 0.62, wear: 0.5, blendWith: 'dirt', blendScale: 1.3 } },

  /* Facade renders. The blend layer is the masonry behind them: patches of
   * blown render at the base and around damage, which is what stops a plaster
   * wall reading as one flat tiled noise field. Warm renders expose brick, cool
   * renders expose the grey block substrate. */
  plasterCream: { archetype: 'plaster', surface: 'plaster', fallback: 0xcfc0a2, opts: { scale: 4.2, tint: 0xd6c8a8, wear: 0.5, blendWith: 'brick', blendScale: 0.55 } },
  plasterOchre: { archetype: 'plaster', surface: 'plaster', fallback: 0xc09a52, opts: { scale: 4.2, tint: 0xcda45e, saturation: 1.12, wear: 0.6, blendWith: 'brick', blendScale: 0.55 } },
  plasterSage: { archetype: 'plaster', surface: 'plaster', fallback: 0x93a086, opts: { scale: 4.2, tint: 0x9aab8a, saturation: 0.9, wear: 0.55, blendWith: 'concrete', blendScale: 0.7 } },
  plasterRose: { archetype: 'plaster', surface: 'plaster', fallback: 0xb98a7c, opts: { scale: 4.2, tint: 0xc59486, saturation: 0.95, wear: 0.6, blendWith: 'brick', blendScale: 0.55 } },
  plasterBlue: { archetype: 'plaster', surface: 'plaster', fallback: 0x8ba0ab, opts: { scale: 4.2, tint: 0x93a7b4, saturation: 0.82, wear: 0.55, blendWith: 'concrete', blendScale: 0.7 } },
  plasterGrey: { archetype: 'plaster', surface: 'plaster', fallback: 0xa5a099, opts: { scale: 4.2, tint: 0xaea89e, saturation: 0.55, wear: 0.7, blendWith: 'concrete', blendScale: 0.7 } },
  /* Interior renders are darker and cooler: an authored ambient volume, since a
   * single global sky probe would otherwise light inside exactly like outside. */
  plasterInt: { archetype: 'plaster', surface: 'plaster', fallback: 0x6d7076, opts: { scale: 3.6, tint: 0x686b72, saturation: 0.4, wear: 0.8, blendWith: 'concrete', blendScale: 0.7 } },
  plasterIntWarm: { archetype: 'plaster', surface: 'plaster', fallback: 0x7d766a, opts: { scale: 3.6, tint: 0x7a7264, saturation: 0.55, wear: 0.85, blendWith: 'brick', blendScale: 0.6 } },

  concrete: { archetype: 'concrete', surface: 'concrete', fallback: 0x8e8b84, opts: { scale: 2.6, tint: 0x8d8a82, saturation: 0.85, wear: 0.6, blendWith: 'dirt', blendScale: 1.1 } },
  concreteDark: { archetype: 'concrete', surface: 'concrete', fallback: 0x5b5954, opts: { scale: 2.6, tint: 0x7d7a74, saturation: 0.6, wear: 0.85, blendWith: 'dirt', blendScale: 1.1 } },
  concreteWet: { archetype: 'concrete', surface: 'concrete', fallback: 0x6a6862, opts: { scale: 2.2, tint: 0x8d8a84, roughness: 0.55, wear: 0.9 } },
  stone: { archetype: 'stone', surface: 'stone', fallback: 0x8a8880, opts: { scale: 3.2, tint: 0x8b8779, saturation: 0.9, wear: 0.6, blendWith: 'dirt', blendScale: 1.2 } },
  stoneTrim: { archetype: 'stone', surface: 'stone', fallback: 0x9d9a90, opts: { scale: 1.4, tint: 0xa39e8f, wear: 0.45 } },
  cobble: { archetype: 'stone', surface: 'stone', fallback: 0x6f6d66, opts: { scale: 0.55, tint: 0x47443f, saturation: 0.7, wear: 0.95, pom: false, blendWith: 'dirt', blendScale: 3.2 } },
  /* Dark granite setts: the tram trackbed, laid flush into the square. */
  setts: { archetype: 'stone', surface: 'stone', fallback: 0x4b4a47, opts: { scale: 0.5, tint: 0x565350, saturation: 0.55, wear: 0.9, pom: false, blendWith: 'dirt', blendScale: 3.0 } },

  /* -------------------------------------------------------------- ground */
  asphalt: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x3b3c3e, opts: { scale: 3.0, wear: 0.6, tint: 0x4a4b4e, saturation: 0.7, pom: false, blendWith: 'dirt', blendScale: 0.9 } },
  asphaltWorn: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x4a4b4c, opts: { scale: 3.0, tint: 0x6a6862, saturation: 0.5, wear: 0.95, pom: false, blendWith: 'dirt', blendScale: 0.9 } },
  /* Pavement slabs read as *paper* at golden hour if their albedo is anywhere
   * near neutral concrete: a horizontal plane still takes ~45 % of normal
   * incidence from a 26° sun, and the exposure is anchored on the facades.
   * City paving is a dark grey anyway once it has been walked on. */
  pavement: { archetype: 'concrete', surface: 'concrete', fallback: 0x8b8880, opts: { scale: 1.35, tint: 0x4e4b46, saturation: 0.75, wear: 0.9, pom: false, blendWith: 'dirt', blendScale: 1.6 } },
  kerb: { archetype: 'stone', surface: 'stone', fallback: 0x9b9890, opts: { scale: 1.1, tint: 0x67645e, wear: 0.65, pom: false } },
  /* The blend layer under every ground surface. Kept a shade darker and less
   * yellow than it wants to be: silt in a European town square is grey-brown,
   * and at golden hour a warm mid-tone flares out to pale sand. */
  dirt: { archetype: 'dirt', surface: 'dirt', fallback: 0x5f4f3a, opts: { scale: 2.6, tint: 0x635546, saturation: 0.85, wear: 0.5, pom: false } },
  /* Blast scorch: burnt tarmac, near-black and matte, radiating from craters. */
  scorch: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x201d1b, opts: { scale: 3.4, tint: 0x2a2624, saturation: 0.35, wear: 1.0, roughness: 1.0, pom: false } },
  gravel: { archetype: 'gravel', surface: 'gravel', fallback: 0x7a7770, opts: { scale: 1.6, tint: 0x77746d, pom: false } },
  grass: { archetype: 'grass', surface: 'grass', fallback: 0x60653a, opts: { scale: 2.0, saturation: 0.75, pom: false } },
  puddle: { archetype: 'puddle', surface: 'puddle', fallback: 0x232628, opts: { scale: 2.4 } },

  /* --------------------------------------------------------------- roofs */
  roofTile: { archetype: 'tile', surface: 'tile', fallback: 0x9a5236, opts: { scale: 0.9, tint: 0xa4593a, saturation: 1.1, wear: 0.7 } },
  /* Built-up felt roofing is never one surface: it is laid in overlapping bays,
   * ballasted with grit where the wind lifts it and ponded where it has sagged.
   * The blend layer carries the ballast. */
  roofFelt: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x2e2f31, opts: { scale: 1.8, tint: 0x5c5c5e, saturation: 0.4, wear: 0.9, blendWith: 'gravel', blendScale: 1.0 } },

  /* -------------------------------------------------------------- timber */
  wood: { archetype: 'wood', surface: 'wood', fallback: 0x9c968a, opts: { scale: 1.4, wear: 0.5 } },
  woodPaint: { archetype: 'wood', surface: 'wood', fallback: 0x5d6b62, opts: { scale: 1.4, tint: 0x76867a, saturation: 0.7, wear: 0.85 } },
  plank: { archetype: 'woodThin', surface: 'woodThin', fallback: 0x8a7a63, opts: { scale: 1.1, wear: 0.6 } },
  plywood: { archetype: 'plywood', surface: 'plywood', fallback: 0xb2905f, opts: { scale: 1.6, wear: 0.5 } },
  crate: { archetype: 'crate', surface: 'crate', fallback: 0x9c7a4e, opts: { scale: 1.0, instanced: true, wear: 0.4 } },

  /* -------------------------------------------------------------- metals */
  steel: { archetype: 'metal', surface: 'metal', fallback: 0x6c7a72, opts: { scale: 1.6, wear: 0.5 } },
  steelPaint: { archetype: 'metal', surface: 'metal', fallback: 0x3f5b5e, opts: { scale: 1.6, tint: 0x53757a, saturation: 0.9, wear: 0.7 } },
  rust: { archetype: 'metal', surface: 'metal', fallback: 0x7a4526, opts: { scale: 1.4, tint: 0x9c6438, saturation: 1.25, roughness: 1.0, wear: 1.0 } },
  sheet: { archetype: 'metalThin', surface: 'metalThin', fallback: 0x9aa0a4, opts: { scale: 1.6, wear: 0.6 } },
  alu: { archetype: 'aluminium', surface: 'metalThin', fallback: 0xb6b9bc, opts: { scale: 1.2, wear: 0.4 } },
  grate: { archetype: 'grate', surface: 'grate', fallback: 0x53565a, opts: { scale: 0.8 } },
  pipe: { archetype: 'pipe', surface: 'pipe', fallback: 0x8a7e46, opts: { scale: 1.2, wear: 0.6 } },
  copper: { archetype: 'pipe', surface: 'pipe', fallback: 0x6c8a6a, opts: { scale: 1.2, tint: 0x8fae94, saturation: 0.9, wear: 0.9 } },
  paintRed: { archetype: 'metal', surface: 'metal', fallback: 0x8c2a20, opts: { scale: 1.4, tint: 0xa8382a, saturation: 1.2, wear: 0.8 } },
  paintYellow: { archetype: 'metal', surface: 'metal', fallback: 0xb08a1c, opts: { scale: 1.4, tint: 0xcaa334, saturation: 1.2, wear: 0.85 } },

  /* ---------------------------------------------------------- soft/misc */
  glass: { archetype: 'glass', surface: 'glass', fallback: 0xb6c8c8, opts: { scale: 1.6 } },
  glassDirty: { archetype: 'glass', surface: 'glass', fallback: 0x8d9a96, opts: { scale: 1.6, tint: 0x9fb0a8, saturation: 0.6 } },
  canvasRed: { archetype: 'fabric', surface: 'fabric', fallback: 0x8c3a30, opts: { scale: 1.0, tint: 0x9c4638, saturation: 1.2, doubleSided: true } },
  canvasGreen: { archetype: 'fabric', surface: 'fabric', fallback: 0x3f5836, opts: { scale: 1.0, tint: 0x516b42, saturation: 1.0, doubleSided: true } },
  canvasCream: { archetype: 'fabric', surface: 'fabric', fallback: 0xa89c7e, opts: { scale: 1.0, tint: 0xc2b694, saturation: 0.7, doubleSided: true } },
  sandbag: { archetype: 'sandbag', surface: 'sandbag', fallback: 0x9a8158, opts: { scale: 1.1 } },
  rubber: { archetype: 'rubber', surface: 'rubber', fallback: 0x2c2c2e, opts: { scale: 1.0 } },
  plastic: { archetype: 'plastic', surface: 'plastic', fallback: 0x3c3e42, opts: { scale: 1.0 } },
  hazard: { archetype: 'plastic', surface: 'plastic', fallback: 0xc07a1c, opts: { scale: 1.0, tint: 0xe09a2c, saturation: 1.4 } },
  foliage: { archetype: 'foliage', surface: 'foliage', fallback: 0x465c2c, opts: { scale: 0.7, doubleSided: true, instanced: true } },
  foliageDry: { archetype: 'foliage', surface: 'foliage', fallback: 0x6a6232, opts: { scale: 0.7, tint: 0xa89a58, saturation: 0.7, doubleSided: true, instanced: true } },

  /* --------------------------------------------------------- practicals */
  lampSodium: { archetype: 'plastic', surface: 'plastic', fallback: 0xffbb62, opts: { scale: 0.5, tint: 0xffcf95, emissive: 0xffb257, emissiveIntensity: 2.4 } },
  lampWarm: { archetype: 'plastic', surface: 'plastic', fallback: 0xffe0b0, opts: { scale: 0.5, tint: 0xfff0d8, emissive: 0xffd9a0, emissiveIntensity: 1.8 } },
  fluoro: { archetype: 'fluorescent', surface: 'plastic', fallback: 0xe2e8dc, opts: { emissiveIntensity: 1.9 } },
  beacon: { archetype: 'plastic', surface: 'plastic', fallback: 0xff5a1c, opts: { scale: 0.4, tint: 0xff7a3a, emissive: 0xff4a10, emissiveIntensity: 2.6 } },
  ember: { archetype: 'metal', surface: 'metal', fallback: 0x903018, opts: { scale: 1.0, tint: 0x6a3020, emissive: 0xff5a18, emissiveIntensity: 1.5 } },
  signGlow: { archetype: 'plastic', surface: 'plastic', fallback: 0xd8ecff, opts: { scale: 0.5, tint: 0xcfe4ff, emissive: 0x63c4ff, emissiveIntensity: 1.4 } },

  /* ----------------------------------------------------------- backdrop
   * Three ridge bands, each a step further into the haze. Aerial perspective is
   * a *value and saturation* ramp before it is a fog density: the near ridge
   * still has some of its own local colour, the far one is almost pure sky. */
  backdropFar: { archetype: '', surface: 'concrete', fallback: 0x4c5464, flat: { roughness: 1.0, metalness: 0 } },
  backdropMid: { archetype: '', surface: 'concrete', fallback: 0x565b5e, flat: { roughness: 1.0, metalness: 0 } },
  ridgeNear: { archetype: '', surface: 'stone', fallback: 0x232a33, flat: { roughness: 1.0, metalness: 0 } },
  ridgeMid: { archetype: '', surface: 'stone', fallback: 0x36404e, flat: { roughness: 1.0, metalness: 0 } },
  ridge: { archetype: '', surface: 'stone', fallback: 0x4b5769, flat: { roughness: 1.0, metalness: 0 } },
};

export class MatCatalog {
  private cache = new Map<MatKey, THREE.Material>();
  private disposables: THREE.Material[] = [];

  constructor(private mats: MaterialSystem | null) { }

  /** Archetype ids this palette will actually pull from the forge. */
  archetypeIds(): string[] {
    const set = new Set<string>();
    for (const k of Object.keys(D) as MatKey[]) {
      const d = D[k];
      if (d.archetype) set.add(d.archetype);
    }
    return [...set];
  }

  get(key: MatKey): THREE.Material {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const def = D[key];
    let mat: THREE.Material;
    if (!def.archetype || !this.mats) {
      const flat = new THREE.MeshStandardMaterial({
        color: def.fallback,
        roughness: def.flat?.roughness ?? 0.9,
        metalness: def.flat?.metalness ?? 0,
      });
      flat.name = `world:${key}`;
      flat.userData.surface = def.surface;
      this.disposables.push(flat);
      mat = flat;
    } else {
      mat = this.mats.material(def.archetype, def.opts ?? {}, def.surface);
    }
    this.cache.set(key, mat);
    return mat;
  }

  surface(key: MatKey): SurfaceType { return D[key].surface; }

  /**
   * True when this key carries a vertex-blended second layer. Callers that emit
   * geometry with such a key *must* write a colour attribute, otherwise the
   * blend mask reads as undefined.
   */
  blends(key: MatKey): boolean { return BLENDED[key] === true; }

  isTransparent(key: MatKey): boolean {
    return key === 'glass' || key === 'glassDirty';
  }

  /** Alpha-tested cards must not be treated as solid shadow casters at range. */
  isAlphaCard(key: MatKey): boolean {
    return key === 'foliage' || key === 'foliageDry' || key === 'grate';
  }

  dispose(): void {
    for (const m of this.disposables) m.dispose();
    this.disposables.length = 0;
    this.cache.clear();
  }
}

export const ALL_MAT_KEYS = Object.keys(D) as MatKey[];
