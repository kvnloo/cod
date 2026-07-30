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
  | 'backdropFar' | 'backdropMid' | 'ridge';

interface MatDef {
  archetype: string;
  surface: SurfaceType;
  opts?: MaterialOptions;
  /** Flat colour used when the material library is unavailable. */
  fallback: number;
  /** Backdrop-style materials skip the procedural stack entirely. */
  flat?: { roughness: number; metalness: number };
}

const D: Record<MatKey, MatDef> = {
  /* ------------------------------------------------------------- masonry */
  brick: { archetype: 'brick', surface: 'brick', fallback: 0x8a4a38, opts: { scale: 1.9, wear: 0.35 } },
  brickSoot: { archetype: 'brick', surface: 'brick', fallback: 0x4a3128, opts: { scale: 1.9, tint: 0x6e5c52, saturation: 0.45, wear: 0.85 } },
  brickPale: { archetype: 'brick', surface: 'brick', fallback: 0xb09a72, opts: { scale: 2.1, tint: 0xd6c199, hue: 0.03, saturation: 0.62, wear: 0.45 } },

  plasterCream: { archetype: 'plaster', surface: 'plaster', fallback: 0xcfc0a2, opts: { scale: 2.4, tint: 0xd9c9a6, wear: 0.5 } },
  plasterOchre: { archetype: 'plaster', surface: 'plaster', fallback: 0xc09a52, opts: { scale: 2.4, tint: 0xcfa259, saturation: 1.15, wear: 0.6 } },
  plasterSage: { archetype: 'plaster', surface: 'plaster', fallback: 0x93a086, opts: { scale: 2.4, tint: 0x9dab8c, saturation: 0.85, wear: 0.55 } },
  plasterRose: { archetype: 'plaster', surface: 'plaster', fallback: 0xb98a7c, opts: { scale: 2.4, tint: 0xc59486, saturation: 0.9, wear: 0.6 } },
  plasterBlue: { archetype: 'plaster', surface: 'plaster', fallback: 0x8ba0ab, opts: { scale: 2.4, tint: 0x96a9b4, saturation: 0.8, wear: 0.55 } },
  plasterGrey: { archetype: 'plaster', surface: 'plaster', fallback: 0xa5a099, opts: { scale: 2.4, tint: 0xb0aaa0, saturation: 0.5, wear: 0.7 } },
  /* Interior renders are darker and cooler: an authored ambient volume, since a
   * single global sky probe would otherwise light inside exactly like outside. */
  plasterInt: { archetype: 'plaster', surface: 'plaster', fallback: 0x6d7076, opts: { scale: 2.2, tint: 0x76797f, saturation: 0.45, wear: 0.75 } },
  plasterIntWarm: { archetype: 'plaster', surface: 'plaster', fallback: 0x7d766a, opts: { scale: 2.2, tint: 0x877d6d, saturation: 0.6, wear: 0.8 } },

  concrete: { archetype: 'concrete', surface: 'concrete', fallback: 0x8e8b84, opts: { scale: 2.2, wear: 0.4 } },
  concreteDark: { archetype: 'concrete', surface: 'concrete', fallback: 0x5b5954, opts: { scale: 2.2, tint: 0x7d7a74, saturation: 0.6, wear: 0.8 } },
  concreteWet: { archetype: 'concrete', surface: 'concrete', fallback: 0x6a6862, opts: { scale: 2.2, tint: 0x8d8a84, roughness: 0.55, wear: 0.9 } },
  stone: { archetype: 'stone', surface: 'stone', fallback: 0x8a8880, opts: { scale: 2.4, wear: 0.5 } },
  stoneTrim: { archetype: 'stone', surface: 'stone', fallback: 0x9d9a90, opts: { scale: 1.4, tint: 0xb5b1a5, wear: 0.35 } },
  cobble: { archetype: 'stone', surface: 'stone', fallback: 0x6f6d66, opts: { scale: 0.55, tint: 0x55534e, saturation: 0.75, wear: 0.85, pom: false } },

  /* -------------------------------------------------------------- ground */
  asphalt: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x3b3c3e, opts: { scale: 3.0, wear: 0.6, tint: 0x4a4b4e, saturation: 0.7, pom: false } },
  asphaltWorn: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x4a4b4c, opts: { scale: 3.0, tint: 0x6a6862, saturation: 0.5, wear: 0.95, pom: false } },
  pavement: { archetype: 'concrete', surface: 'concrete', fallback: 0x8b8880, opts: { scale: 1.35, tint: 0x69665f, saturation: 0.8, wear: 0.75, pom: false } },
  kerb: { archetype: 'stone', surface: 'stone', fallback: 0x9b9890, opts: { scale: 1.1, tint: 0x716e68, wear: 0.6, pom: false } },
  dirt: { archetype: 'dirt', surface: 'dirt', fallback: 0x5f4f3a, opts: { scale: 2.6, tint: 0x7a6a56, pom: false } },
  gravel: { archetype: 'gravel', surface: 'gravel', fallback: 0x7a7770, opts: { scale: 1.6, tint: 0x77746d, pom: false } },
  grass: { archetype: 'grass', surface: 'grass', fallback: 0x60653a, opts: { scale: 2.0, saturation: 0.75, pom: false } },
  puddle: { archetype: 'puddle', surface: 'puddle', fallback: 0x232628, opts: { scale: 2.4 } },

  /* --------------------------------------------------------------- roofs */
  roofTile: { archetype: 'tile', surface: 'tile', fallback: 0x9a5236, opts: { scale: 0.9, tint: 0xa4593a, saturation: 1.1, wear: 0.7 } },
  roofFelt: { archetype: 'asphalt', surface: 'asphalt', fallback: 0x2e2f31, opts: { scale: 1.8, tint: 0x6a6a6c, saturation: 0.4, wear: 0.8 } },

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

  /* ----------------------------------------------------------- backdrop */
  backdropFar: { archetype: '', surface: 'concrete', fallback: 0x4c5464, flat: { roughness: 1.0, metalness: 0 } },
  backdropMid: { archetype: '', surface: 'concrete', fallback: 0x565b5e, flat: { roughness: 1.0, metalness: 0 } },
  ridge: { archetype: '', surface: 'stone', fallback: 0x3d4653, flat: { roughness: 1.0, metalness: 0 } },
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
