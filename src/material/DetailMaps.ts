/**
 * Shared high-frequency detail layers.
 *
 * One 512² texture per family, packed as
 *   r,g = tangent normal xy (0.5-centred)
 *   b   = albedo multiplier (0.5-centred)
 *   a   = roughness offset  (0.5-centred)
 *
 * These are tiled 10–40× per metre and cross-faded in inside a few metres, so
 * they are what actually stops a 1K base map going soft when the player walks
 * up to a wall. They cost one extra texture fetch and nothing else.
 */

import * as THREE from 'three';
import type { TextureForge } from './TextureForge';
import type { DetailKind } from './types';

const HEIGHT_FN: Record<Exclude<DetailKind, 'none'>, string> = {
  // Painted render / plaster at arm's length: the sand fraction of the float
  // coat, the orange peel of the paint over it, and the odd pinhole pore. The
  // high-frequency terms have to carry real amplitude — a smooth detail map is
  // exactly what makes a wall go plasticky when the player walks up to it.
  // Painted render at arm's length. Deliberately *directional*: the fine
  // structure of a floated wall is drag from the trowel, not a field of
  // isotropic domes. Domes here are what produce the gravel-rash speckle when
  // a low sun rakes across a wall, because every one of them catches the light
  // at the same angle at the same time.
  micro: /* glsl */ `
float obDetailH(vec2 uv) {
  // Two low-frequency octaves, ~7 and ~15 cells per repeat.
  //
  // Everything below this line is at 70-150 cells per repeat: at any sane
  // detail density that is 1-3 mm, so from a metre away it lands under a pixel,
  // mips toward its own mean and contributes *variance* without ever producing
  // a feature the eye can name. That is what made a 4x-stretched 1 m crop read
  // as blank even once the albedo gain was real. A float coat is not uniform —
  // it is laid in passes, sucks unevenly into the background and dries at
  // different rates — so the patchiness has to be authored at centimetre scale
  // and it has to carry most of the layer's amplitude.
  float coarse  = obValueP(uv * 7.0, vec2(7.0), 23.0);
  float coarse2 = obValueP(uv * 15.0, vec2(15.0), 37.0);
  float g1    = obValueP(uv * 70.0, vec2(70.0), 3.0);
  float g2    = obValueP(uv * 150.0, vec2(150.0), 9.0);
  float drag  = obValueP(vec2(uv.x * 30.0, uv.y * 110.0), vec2(30.0, 110.0), 5.0);
  float pore  = smoothstep(0.93, 0.999, obValueP(uv * 110.0, vec2(110.0), 11.0));
  // Hairline crazing. A render or plaster pier seen from a metre and a half is
  // never one value with three crack squiggles across it — it is a whole map of
  // fine map-cracking that only resolves close up, and the base tile cannot
  // carry it because it is stretched over four metres.
  float craze = obCracks(uv, vec2(1.0), 4.0, 0.020, 27.0);
  craze += obCracks(uv, vec2(1.0), 9.0, 0.012, 41.0) * 0.6;
  // Centred, so the layer is a modulation and not a net darkening: the whole
  // point is that it multiplies albedo by 1 ± something.
  return 0.5
       + (coarse  - 0.5) * 0.62
       + (coarse2 - 0.5) * 0.34
       + (g1   - 0.5) * 0.30
       + (g2   - 0.5) * 0.22
       + (drag - 0.5) * 0.22
       - pore * 0.12
       - min(craze, 1.0) * 0.30;
}`,
  grit: /* glsl */ `
float obDetailH(vec2 uv) {
  vec3 w = obWorleyP(uv * 34.0, vec2(34.0), 1.0, 3.0);
  float grain = smoothstep(0.58, 0.12, w.x) * mix(0.5, 1.0, w.z);
  vec3 w2 = obWorleyP(uv * 78.0, vec2(78.0), 1.0, 7.0);
  float fine = smoothstep(0.50, 0.12, w2.x) * 0.6;
  float base = obFbm(uv * 18.0, vec2(18.0), 3, 0.55, 11.0);
  // Same story as micro: aggregate patchiness at ~6 cells per repeat, which
  // is what a swept concrete flag or a worn tarmac patch actually shows at a
  // metre. The Worley grain alone is a uniform rash.
  float coarse = obFbm(uv * 6.0, vec2(6.0), 3, 0.5, 29.0);
  return 0.5
       + (coarse - 0.5) * 0.80
       + (base  - 0.5) * 0.40
       + (grain - 0.45) * 0.40
       + (fine  - 0.30) * 0.22;
}`,
  fibre: /* glsl */ `
float obDetailH(vec2 uv) {
  float along = obValueP(vec2(uv.x * 12.0, uv.y * 220.0), vec2(12.0, 220.0), 3.0);
  float along2 = obValueP(vec2(uv.x * 30.0, uv.y * 90.0), vec2(30.0, 90.0), 7.0);
  float knots = obWorleyFbm(uv * 50.0, vec2(50.0), 2, 1.0, 11.0);
  return along * 0.5 + along2 * 0.3 + (1.0 - knots) * 0.2;
}`,
  metal: /* glsl */ `
float obDetailH(vec2 uv) {
  float brush = obBrushed(uv, 12.0, 420.0, 3.0);
  float pit = obWorleyFbm(uv * 110.0, vec2(110.0), 2, 1.0, 13.0);
  float fine = obValueP(uv * 300.0, vec2(300.0), 17.0);
  return brush * 0.50 + pit * 0.30 + fine * 0.20;
}`,
  organic: /* glsl */ `
float obDetailH(vec2 uv) {
  vec3 v = obVoronoiEdgeP(uv * 34.0, vec2(34.0), 1.0, 3.0);
  float cell = smoothstep(0.0, 0.12, v.x);
  float bump = obFbm(uv * 40.0, vec2(40.0), 3, 0.55, 7.0);
  float speck = obValueP(uv * 200.0, vec2(200.0), 11.0);
  return cell * 0.45 + bump * 0.35 + speck * 0.20;
}`,
};

/* Close-range interest must not come from *normals*: a detail normal map strong
 * enough to see as geometry at 1 m turns into a boiling cottage-cheese rash
 * under a low sun. It was previously loaded almost entirely onto roughness, and
 * roughness alone does nothing on a 0.9-rough dielectric under sky-dominated
 * light — 0.08 gain against a 0.20 shader strength is +/-1.6% albedo, 0.03 of a
 * stop, below 8-bit quantisation. Albedo now carries the layer (a real render
 * varies 10-15% over a few centimetres) and roughness backs it up. */
const ALBEDO_GAIN: Record<Exclude<DetailKind, 'none'>, number> = {
  micro: 0.25, grit: 0.25, fibre: 0.22, metal: 0.16, organic: 0.20,
};
const ROUGH_GAIN: Record<Exclude<DetailKind, 'none'>, number> = {
  micro: 0.28, grit: 0.30, fibre: 0.20, metal: 0.24, organic: 0.16,
};
const SLOPE: Record<Exclude<DetailKind, 'none'>, number> = {
  micro: 1.0, grit: 1.5, fibre: 1.6, metal: 1.2, organic: 2.0,
};

export class DetailMaps {
  private cache = new Map<string, THREE.Texture>();

  constructor(private forge: TextureForge) { }

  get(kind: DetailKind): THREE.Texture | null {
    if (kind === 'none') return null;
    const cached = this.cache.get(kind);
    if (cached) return cached;

    const fragment = /* glsl */ `
${HEIGHT_FN[kind]}
void main() {
  float e = 1.0 / uSize;
  float h  = obDetailH(vUv);
  float hx = obDetailH(vUv + vec2(e, 0.0));
  float hy = obDetailH(vUv + vec2(0.0, e));
  vec2 g = vec2(hx - h, hy - h) * uSize * ${SLOPE[kind].toFixed(3)} / 512.0;
  vec3 n = normalize(vec3(-g, 1.0));
  float alb = 0.5 + (h - 0.5) * ${ALBEDO_GAIN[kind].toFixed(3)} * 2.0;
  float rgh = 0.5 + (0.5 - h) * ${ROUGH_GAIN[kind].toFixed(3)} * 2.0;
  oCol = vec4(n.xy * 0.5 + 0.5, clamp(alb, 0.0, 1.0), clamp(rgh, 0.0, 1.0));
}`;

    const tex = this.forge.generateSingle({
      id: `detail:${kind}`,
      size: 512,
      fragment,
      srgb: false,
      mips: true,
    });
    this.cache.set(kind, tex);
    return tex;
  }

  dispose(): void {
    this.cache.clear();
  }
}
