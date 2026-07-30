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
  micro: /* glsl */ `
float obDetailH(vec2 uv) {
  float a = obFbm(uv * 24.0, vec2(24.0), 4, 0.55, 3.0);
  float b = obWorleyFbm(uv * 60.0, vec2(60.0), 2, 1.0, 7.0);
  float c = obValueP(uv * 180.0, vec2(180.0), 11.0);
  return a * 0.45 + (1.0 - b) * 0.35 + c * 0.20;
}`,
  grit: /* glsl */ `
float obDetailH(vec2 uv) {
  vec3 w = obWorleyP(uv * 40.0, vec2(40.0), 1.0, 3.0);
  float grain = smoothstep(0.44, 0.05, w.x) * mix(0.5, 1.0, w.z);
  vec3 w2 = obWorleyP(uv * 96.0, vec2(96.0), 1.0, 7.0);
  float fine = smoothstep(0.36, 0.04, w2.x) * 0.6;
  float base = obFbm(uv * 18.0, vec2(18.0), 3, 0.55, 11.0);
  return base * 0.35 + grain * 0.45 + fine * 0.25;
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

const ALBEDO_GAIN: Record<Exclude<DetailKind, 'none'>, number> = {
  micro: 0.10, grit: 0.22, fibre: 0.18, metal: 0.10, organic: 0.20,
};
const ROUGH_GAIN: Record<Exclude<DetailKind, 'none'>, number> = {
  micro: 0.10, grit: 0.18, fibre: 0.16, metal: 0.22, organic: 0.14,
};
const SLOPE: Record<Exclude<DetailKind, 'none'>, number> = {
  micro: 2.2, grit: 3.4, fibre: 2.6, metal: 1.6, organic: 3.0,
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
