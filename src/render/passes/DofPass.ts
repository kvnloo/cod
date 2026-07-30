/**
 * Depth of field — physical CoC, polygonal-aperture bokeh, separate near and far
 * fields, tile-based scatter-as-gather with foreground bleeding.
 *
 *   prepare (half-res colour + signed CoC)
 *     → tile min/max CoC → neighbour max
 *     → gather (MRT: far field, near field + coverage)
 *     → near-field coverage blur
 *     → full-resolution composite
 *
 * The circle of confusion is computed from a real lens model (focal length
 * derived from the vertical FOV and a 24mm sensor, aperture from an f-number) so
 * that changing FOV when aiming changes the defocus the way a real optic does.
 * The kernel is a regular n-gon, which is what gives shipped titles their
 * hexagonal highlights rather than perfect circles.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { Rand } from '../../core/Rand';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

const MAX_SAMPLES = 96;

const COC_GLSL = /* glsl */ `
/* Signed circle of confusion in full-resolution pixels.
   Negative = in front of the focal plane (near field). */
float computeCoc(float viewZ) {
  float f = uFocalLength;
  float s = max(uFocus, f + 1e-4);
  float a = f / max(uFStop, 0.5);
  float z = max(viewZ, f + 1e-4);
  float cocMetres = a * f * (z - s) / (z * (s - f));
  return clamp(cocMetres * uSensorToPixels * uScale, -uMaxCoc, uMaxCoc);
}
`;

const PREPARE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tDepth;
uniform vec2 uSourceTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocalLength;
uniform float uFocus;
uniform float uFStop;
uniform float uSensorToPixels;
uniform float uMaxCoc;
uniform float uScale;
layout(location = 0) out vec4 fragColor;

${COC_GLSL}

void main() {
  vec2 t = uSourceTexel;
  vec2 o[4];
  o[0] = vec2(-0.5, -0.5); o[1] = vec2(0.5, -0.5);
  o[2] = vec2(-0.5, 0.5);  o[3] = vec2(0.5, 0.5);

  vec3 colour = vec3(0.0);
  float cocMin = 1e9;
  float cocMax = -1e9;
  float cocSum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 uv = vUv + o[i] * t;
    colour += texture(tInput, uv).rgb;
    float d = texture(tDepth, uv).r;
    float z = d >= 1.0 ? uFar : linearizeDepth(d, uNear, uFar);
    float c = computeCoc(z);
    cocMin = min(cocMin, c);
    cocMax = max(cocMax, c);
    cocSum += c;
  }
  colour *= 0.25;
  // Keep the most extreme CoC of the quad so near-field edges stay wide.
  float coc = abs(cocMin) > abs(cocMax) ? cocMin : cocMax;
  coc = mix(cocSum * 0.25, coc, 0.65);
  fragColor = vec4(colour, coc * 0.5);   // half-resolution pixels
}
`;

const TILE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uSourceTexel;
uniform float uTile;
layout(location = 0) out vec4 fragColor;

void main() {
  float maxFar = 0.0;
  float maxNear = 0.0;
  for (int y = 0; y < DOF_TILE; y++) {
    for (int x = 0; x < DOF_TILE; x++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - uTile * 0.5 + 0.5) * uSourceTexel;
      float c = texture(tInput, uv).a;
      maxFar = max(maxFar, max(c, 0.0));
      maxNear = max(maxNear, max(-c, 0.0));
    }
  }
  fragColor = vec4(maxFar, maxNear, 0.0, 1.0);
}
`;

const TILE_NEIGHBOUR_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 best = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      best = max(best, texture(tInput, vUv + vec2(float(x), float(y)) * uTexel).rg);
    }
  }
  fragColor = vec4(best, 0.0, 1.0);
}
`;

const GATHER_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tColor;      // half-res colour + coc in alpha
uniform sampler2D tTile;
uniform vec2 uTexel;
uniform vec2 uKernel[${MAX_SAMPLES}];
uniform float uBokehBoost;
layout(location = 0) out vec4 outFar;
layout(location = 1) out vec4 outNear;

void main() {
  vec4 centre = texture(tColor, vUv);
  vec2 tile = texture(tTile, vUv).rg;
  float radiusFar = tile.r;
  float radiusNear = tile.g;
  float radius = max(radiusFar, radiusNear);

  if (radius < 1.0) {
    outFar = vec4(centre.rgb, 1.0);
    outNear = vec4(centre.rgb, 0.0);
    return;
  }

  vec3 farSum = vec3(0.0);
  float farWeight = 0.0;
  vec3 nearSum = vec3(0.0);
  float nearWeight = 0.0;
  float nearCoverage = 0.0;

  float centreCoc = centre.a;

  // Tiles with no meaningful field skip that gather entirely — this is what
  // keeps the cost proportional to the blurred area rather than the frame.
  bool doFar = radiusFar >= 1.0;
  bool doNear = radiusNear >= 1.0;

  for (int i = 0; i < DOF_SAMPLES; i++) {
    vec2 offset = uKernel[i];
    float len = length(offset);

    /* --- far field: a sample scatters onto us if its own CoC reaches here --- */
    if (doFar) {
      vec2 uvFar = vUv + offset * radiusFar * uTexel;
      vec4 sf = texture(tColor, uvFar);
      float cocFar = max(sf.a, 0.0);
      float distFar = len * radiusFar;
      // Background samples only; a foreground sample must not smear backwards.
      float inRange = sat((cocFar - distFar) * 0.5 + 1.0);
      float notCloser = sat((sf.a - centreCoc) * 4.0 + 1.0);
      float w = inRange * notCloser / max(cocFar * cocFar, 1.0);
      vec3 cf = sf.rgb * (1.0 + luma(sf.rgb) * uBokehBoost);
      farSum += cf * w;
      farWeight += w;
    }

    /* --- near field: foreground bleeds outward over everything ------------- */
    if (doNear) {
      vec2 uvNear = vUv + offset * radiusNear * uTexel;
      vec4 sn = texture(tColor, uvNear);
      float cocNear = max(-sn.a, 0.0);
      float distNear = len * radiusNear;
      float wn = sat((cocNear - distNear) * 0.5 + 1.0) / max(cocNear * cocNear, 1.0);
      vec3 cn = sn.rgb * (1.0 + luma(sn.rgb) * uBokehBoost);
      nearSum += cn * wn;
      nearWeight += wn;
      nearCoverage += sat((cocNear - distNear) * 0.5 + 1.0);
    }
  }

  vec3 farColour = farWeight > 1e-4 ? farSum / farWeight : centre.rgb;
  farColour /= (1.0 + luma(farColour) * uBokehBoost);
  vec3 nearColour = nearWeight > 1e-4 ? nearSum / nearWeight : centre.rgb;
  nearColour /= (1.0 + luma(nearColour) * uBokehBoost);

  outFar = vec4(farColour, 1.0);
  outNear = vec4(nearColour, sat(nearCoverage / float(DOF_SAMPLES) * 2.0));
}
`;

const NEAR_BLUR_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tNear;
uniform vec2 uTexel;
layout(location = 0) out vec4 fragColor;
void main() {
  // Widen and soften the near-field coverage so the foreground edge does not
  // reveal the gather kernel.
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float w = exp(-float(x * x + y * y) * 0.28);
      sum += texture(tNear, vUv + vec2(float(x), float(y)) * uTexel) * w;
      wsum += w;
    }
  }
  fragColor = sum / wsum;
}
`;

const COMPOSITE_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform sampler2D tFar;
uniform sampler2D tNear;
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
uniform float uFocalLength;
uniform float uFocus;
uniform float uFStop;
uniform float uSensorToPixels;
uniform float uMaxCoc;
uniform float uScale;
layout(location = 0) out vec4 fragColor;

${COC_GLSL}

void main() {
  vec4 base = texture(tInput, vUv);
  float d = texture(tDepth, vUv).r;
  float z = d >= 1.0 ? uFar : linearizeDepth(d, uNear, uFar);
  float coc = computeCoc(z);

  float farBlend = smoothstep(0.6, 2.4, max(coc, 0.0));
  vec3 result = mix(base.rgb, texture(tFar, vUv).rgb, farBlend);

  vec4 near = texture(tNear, vUv);
  float nearBlend = sat(near.a * 1.15);
  result = mix(result, near.rgb, nearBlend);

  fragColor = vec4(result, base.a);
}
`;

function buildKernel(rings: number, blades: number, rotation: number): { data: Float32Array; count: number } {
  const pts: number[] = [0, 0];
  const rand = new Rand('blackout.dof.kernel');
  const half = Math.PI / blades;
  for (let r = 1; r <= rings; r++) {
    const count = r * 6;
    const rr = r / rings;
    // A per-ring rotational offset breaks the spokes a regular grid would show.
    const spin = rand.next() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + spin;
      // Map the unit circle onto a regular n-gon (the aperture blades).
      const t = ((a + rotation) % (2 * half) + 2 * half) % (2 * half) - half;
      const poly = Math.cos(half) / Math.cos(t);
      pts.push(Math.cos(a) * rr * poly, Math.sin(a) * rr * poly);
      if (pts.length / 2 >= MAX_SAMPLES) break;
    }
    if (pts.length / 2 >= MAX_SAMPLES) break;
  }
  const out = new Float32Array(MAX_SAMPLES * 2);
  const n = Math.min(pts.length, out.length);
  for (let i = 0; i < n; i++) out[i] = pts[i];
  return { data: out, count: Math.floor(n / 2) };
}

const TILE_SIZE = 8;

export class DofPass extends BasePass {
  readonly name = 'dof';
  readonly order = PASS_ORDER.DOF;

  private prepare!: THREE.ShaderMaterial;
  private tile!: THREE.ShaderMaterial;
  private tileNeighbour!: THREE.ShaderMaterial;
  private gather!: THREE.ShaderMaterial;
  private nearBlur!: THREE.ShaderMaterial;
  private composite!: THREE.ShaderMaterial;
  private kernelVectors: THREE.Vector2[] = [];
  private sampleCount = 61;
  private rings = -1;

  /** f-number. Lower = shallower depth of field. */
  fStop = 2.4;
  /** Aperture blade count — 6 gives the classic hexagonal highlight. */
  blades = 6;
  /** CoC multiplier at the hip; ADS ramps this to 1. */
  hipStrength = 0.2;
  /** Global multiplier so a level can dial the whole effect back. */
  strength = 1;

  constructor(res: PostResources) {
    super(res);
    for (let i = 0; i < MAX_SAMPLES; i++) this.kernelVectors.push(new THREE.Vector2());
  }

  private ensureKernel(rings: number): void {
    if (rings === this.rings) return;
    this.rings = rings;
    const k = buildKernel(rings, this.blades, 0.4);
    for (let i = 0; i < MAX_SAMPLES; i++) this.kernelVectors[i].set(k.data[i * 2], k.data[i * 2 + 1]);
    this.sampleCount = k.count;
    this.setDefine(this.gather, 'DOF_SAMPLES', k.count);
  }

  protected override onSetup(): void {
    const lens = {
      uFocalLength: { value: 0.035 },
      uFocus: { value: 6 },
      uFStop: { value: 2.4 },
      uSensorToPixels: { value: 45000 },
      uMaxCoc: { value: 24 },
      uScale: { value: 1 },
    };

    this.prepare = this.makeMaterial({
      name: 'dof/prepare',
      fragment: PREPARE_FRAG,
      uniforms: {
        tInput: { value: null }, tDepth: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
        ...structuredCloneUniforms(lens),
      },
    });
    this.tile = this.makeMaterial({
      name: 'dof/tile',
      fragment: TILE_FRAG,
      defines: { DOF_TILE: TILE_SIZE },
      uniforms: {
        tInput: { value: null },
        uSourceTexel: { value: new THREE.Vector2() },
        uTile: { value: TILE_SIZE },
      },
    });
    this.tileNeighbour = this.makeMaterial({
      name: 'dof/tileneighbour',
      fragment: TILE_NEIGHBOUR_FRAG,
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
    this.gather = this.makeMaterial({
      name: 'dof/gather',
      fragment: GATHER_FRAG,
      defines: { DOF_SAMPLES: 61 },
      uniforms: {
        tColor: { value: null }, tTile: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKernel: { value: this.kernelVectors },
        uBokehBoost: { value: 0.6 },
      },
    });
    this.nearBlur = this.makeMaterial({
      name: 'dof/nearblur',
      fragment: NEAR_BLUR_FRAG,
      uniforms: { tNear: { value: null }, uTexel: { value: new THREE.Vector2() } },
    });
    this.composite = this.makeMaterial({
      name: 'dof/composite',
      fragment: COMPOSITE_FRAG,
      uniforms: {
        tInput: { value: null }, tFar: { value: null }, tNear: { value: null },
        tDepth: { value: null },
        uNear: { value: 0.1 }, uFar: { value: 1000 },
        ...structuredCloneUniforms(lens),
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const g = ctx.settings;
    if (!this.enabled || !g.dof) return false;

    const ads = this.res.fx.ads;
    const scale = this.strength * (this.hipStrength + (1 - this.hipStrength) * ads);
    if (scale <= 0.01) return false;

    const rings = g.dofQuality <= 0.75 ? 3 : (g.dofQuality >= 1.25 ? 5 : 4);
    this.ensureKernel(rings);

    const hw = Math.max(1, ctx.width >> 1);
    const hh = Math.max(1, ctx.height >> 1);
    const tw = Math.max(1, Math.ceil(hw / TILE_SIZE));
    const th = Math.max(1, Math.ceil(hh / TILE_SIZE));
    const pool = this.res.pool;
    const colSpec = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, filter: THREE.LinearFilter };
    const tileSpec = { type: THREE.HalfFloatType, format: THREE.RGFormat, filter: THREE.LinearFilter };

    // Lens model: focal length from the vertical FOV against a 24mm sensor.
    const sensorH = 0.024;
    const fovRad = THREE.MathUtils.degToRad(ctx.camera.fov);
    const focal = (sensorH * 0.5) / Math.tan(fovRad * 0.5);
    const sensorToPixels = ctx.height / sensorH;
    const focus = Math.max(0.15, ctx.focusDistance || 6);
    const maxCoc = Math.max(6, ctx.height * 0.022);

    const setLens = (m: THREE.ShaderMaterial) => {
      const u = m.uniforms;
      u.uFocalLength.value = focal;
      u.uFocus.value = focus;
      u.uFStop.value = this.fStop;
      u.uSensorToPixels.value = sensorToPixels;
      u.uMaxCoc.value = maxCoc;
      u.uScale.value = scale;
    };

    /* 1 — prepare -----------------------------------------------------------*/
    const prep = pool.get('dof.prep', hw, hh, colSpec);
    const pu = this.prepare.uniforms;
    pu.tInput.value = input;
    pu.tDepth.value = ctx.gbuffer.depth;
    (pu.uSourceTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    pu.uNear.value = ctx.cameraNear;
    pu.uFar.value = ctx.cameraFar;
    setLens(this.prepare);
    ctx.blit(this.prepare, prep);

    /* 2 — tiles -------------------------------------------------------------*/
    const tileRt = pool.get('dof.tile', tw, th, tileSpec);
    const tu = this.tile.uniforms;
    tu.tInput.value = prep.texture;
    (tu.uSourceTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    ctx.blit(this.tile, tileRt);

    const tileNb = pool.get('dof.tilenb', tw, th, tileSpec);
    const nu = this.tileNeighbour.uniforms;
    nu.tInput.value = tileRt.texture;
    (nu.uTexel.value as THREE.Vector2).set(1 / tw, 1 / th);
    ctx.blit(this.tileNeighbour, tileNb);

    /* 3 — gather (MRT: far, near) ------------------------------------------ */
    const fields = pool.get('dof.fields', hw, hh, { ...colSpec, count: 2 });
    const gu = this.gather.uniforms;
    gu.tColor.value = prep.texture;
    gu.tTile.value = tileNb.texture;
    (gu.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    gu.uBokehBoost.value = 0.7;
    ctx.blit(this.gather, fields);

    /* 4 — soften the near field --------------------------------------------*/
    const nearSoft = pool.get('dof.near', hw, hh, colSpec);
    const bu = this.nearBlur.uniforms;
    bu.tNear.value = fields.textures[1];
    (bu.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    ctx.blit(this.nearBlur, nearSoft);

    /* 5 — composite ---------------------------------------------------------*/
    const cu = this.composite.uniforms;
    cu.tInput.value = input;
    cu.tFar.value = fields.textures[0];
    cu.tNear.value = nearSoft.texture;
    cu.tDepth.value = ctx.gbuffer.depth;
    cu.uNear.value = ctx.cameraNear;
    cu.uFar.value = ctx.cameraFar;
    setLens(this.composite);
    ctx.blit(this.composite, output);
    return true;
  }
}

/** Shallow-copies a uniform template so two materials do not share objects. */
function structuredCloneUniforms(src: Record<string, { value: number }>): Record<string, { value: number }> {
  const out: Record<string, { value: number }> = {};
  for (const k of Object.keys(src)) out[k] = { value: src[k].value };
  return out;
}
