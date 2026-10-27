/**
 * Transient screen effects: flashbang, directional damage, concussion and lens
 * spatter.
 *
 * State lives in `ScreenFxState` (see ./Shared), which listens to the event bus
 * so the effects work without any gameplay system knowing this pass exists, and
 * also accepts direct requests via `RenderAPI.screenEffect`.
 *
 * The spatter droplets are evaluated analytically from a cell hash — no texture,
 * and the droplet field animates (runs down the lens) without any CPU work.
 */

import * as THREE from 'three';
import { PASS_ORDER, type PassContext } from '../Pass';
import { BasePass } from './PassBase';
import type { PostResources } from './Shared';

const SCREENFX_FRAG = /* glsl */ `
in vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uAspect;
uniform float uTime;
uniform float uFrame;

uniform float uBlind;         // flashbang whiteout 0..1
uniform vec3 uFlash;          // additive flash colour
uniform float uDamage;        // directional damage 0..1
uniform vec2 uDamageDir;      // screen-space direction the hit came from
uniform float uConcussion;    // 0..1
uniform float uConcussionTime;
uniform float uBlood;
uniform float uWater;
uniform float uDirt;
layout(location = 0) out vec4 fragColor;

/* Analytic droplet field: coverage in .x, surface gradient in .yz.
   A uniform cell grid of equal circles reads instantly as procedural, so the
   droplets are clumped by a low-frequency mask, sized by a cubed random (a few
   large blobs, many specks) and squashed along a random axis. */
vec3 droplets(vec2 uv, float scale, float seed, float coverage, float drift) {
  vec2 p = vec2(uv.x * uAspect, uv.y + drift) * scale;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float best = 0.0;
  vec2 grad = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = cell + vec2(float(x), float(y));
      vec3 h = hash33(vec3(c, seed));
      vec3 h2 = hash33(vec3(c.y, c.x, seed + 17.31));
      // Clumping mask: whole regions of the lens are clean.
      float clump = valueNoise3(vec3(c * 0.31, seed * 0.7));
      clump = sat(clump * 1.9 - 0.35);
      if (h.z > coverage * clump) continue;
      vec2 centre = vec2(float(x), float(y)) + 0.08 + h.xy * 0.84;
      float r = 0.045 + 0.40 * h2.x * h2.x * h2.x;
      float ang = h2.z * BLK_TAU;
      float squash = 1.0 + h2.y * 1.1;
      vec2 d = f - centre;
      d = vec2(d.x * cos(ang) - d.y * sin(ang), d.x * sin(ang) + d.y * cos(ang));
      d /= vec2(squash, 1.0 / squash);
      float dist = length(d) / r;
      if (dist < 1.0) {
        float shape = sqrt(1.0 - dist * dist);
        if (shape > best) { best = shape; grad = normalize(d + vec2(1e-6)) * dist; }
      }
    }
  }
  return vec3(best, grad);
}

vec3 radialBlur(vec2 uv, float amount, float aberration) {
  vec2 centre = vec2(0.5);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    float t = float(i) / 7.0;
    float scale = 1.0 - amount * t;
    vec2 suv = centre + (uv - centre) * scale;
    float w = 1.0 - t * 0.6;
    vec2 dir = normalize(uv - centre + vec2(1e-6));
    vec3 c;
    c.r = texture(tInput, clamp(suv + dir * aberration, vec2(0.0), vec2(1.0))).r;
    c.g = texture(tInput, clamp(suv, vec2(0.0), vec2(1.0))).g;
    c.b = texture(tInput, clamp(suv - dir * aberration, vec2(0.0), vec2(1.0))).b;
    sum += c * w;
    wsum += w;
  }
  return sum / wsum;
}

void main() {
  vec2 uv = vUv;
  vec3 color;

  /* --- concussion: ringing wobble + radial blur + aberration ------------- */
  if (uConcussion > 0.001) {
    float decay = exp(-uConcussionTime * 2.2);
    float amp = uConcussion * decay;
    float wob = sin(uConcussionTime * 34.0 + uv.y * 18.0) * 0.006 * amp
              + sin(uConcussionTime * 21.0 + uv.x * 12.0) * 0.004 * amp;
    uv += vec2(wob, wob * 0.6);
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    color = radialBlur(uv, 0.055 * amp, 0.006 * amp);
  } else {
    color = texture(tInput, uv).rgb;
  }

  /* --- lens spatter ------------------------------------------------------- */
  float wet = max(uBlood, max(uWater, uDirt));
  if (wet > 0.004) {
    vec3 dropA = droplets(uv, 7.0, 3.1, uBlood * 0.8 + uWater * 0.9 + uDirt * 0.5, uTime * 0.012);
    vec3 dropB = droplets(uv, 23.0, 7.7, uBlood * 0.5 + uWater * 0.7 + uDirt * 0.45, uTime * 0.03);
    float cov = max(dropA.x, dropB.x * 0.8);
    vec2 grad = dropA.x > dropB.x ? dropA.yz : dropB.yz;
    if (cov > 0.001) {
      vec2 refr = clamp(uv - grad * cov * 0.045, vec2(0.0), vec2(1.0));
      // A droplet is a tiny lens: it refracts and slightly blurs.
      vec3 through = texture(tInput, refr).rgb * 0.55
                   + texture(tInput, clamp(refr + uTexel * 2.0, vec2(0.0), vec2(1.0))).rgb * 0.25
                   + texture(tInput, clamp(refr - uTexel * 2.0, vec2(0.0), vec2(1.0))).rgb * 0.20;
      vec3 tint = vec3(1.0);
      float strength = 0.3;
      if (uBlood > uWater && uBlood > uDirt) { tint = vec3(0.32, 0.035, 0.028); strength = 0.62; }
      else if (uDirt > uWater) { tint = vec3(0.18, 0.15, 0.11); strength = 0.45; }
      // Blood on glass is a dark translucent filter, not red paint: it tints
      // what comes through rather than replacing it.
      float opacity = sat(cov * cov * 1.3) * strength;
      vec3 filtered = through * mix(vec3(1.0), tint * 3.2, opacity);
      color = mix(color, filtered, sat(cov * 1.2));
    }
  }

  /* --- additive flash ----------------------------------------------------- */
  color += uFlash;

  /* --- directional damage vignette --------------------------------------- */
  if (uDamage > 0.002) {
    vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
    float r = length(d) * 1.35;
    vec2 nd = normalize(d + vec2(1e-6));
    float side = sat(dot(nd, uDamageDir) * 0.5 + 0.5);
    // Rim-only ring — centre FOV stays clear for aim (CoD gunfeel contract).
    // smoothstep starts further out so stacked hits cannot wash the reticle.
    float ring = smoothstep(0.58, 1.12, r);
    float w = ring * mix(0.18, 1.0, pow(side, 2.4)) * uDamage;
    vec3 blood = vec3(0.42, 0.015, 0.01);
    color = mix(color, blood, sat(w * 0.72));
    // Light edge desat only — never collapse mid-frame contrast.
    color = mix(color, vec3(luma(color)), sat(uDamage * ring * 0.22));
  }

  /* --- flashbang ---------------------------------------------------------- */
  if (uBlind > 0.002) {
    float b = uBlind;
    // Bleach first (saturation collapses), then wash to white.
    vec3 bleached = mix(color, vec3(luma(color)), sat(b * 0.85));
    bleached = mix(bleached, bleached * 0.35 + vec3(0.65), sat(b * b));
    // Retinal afterimage: a faint warm bloom that lingers after the white.
    vec3 after = vec3(1.0, 0.96, 0.9) * pow(b, 1.6);
    color = mix(color, bleached, sat(b * 1.2)) + after * 0.55;
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export class ScreenFxPass extends BasePass {
  readonly name = 'screenfx';
  readonly order = PASS_ORDER.SCREEN_FX;

  private fx!: THREE.ShaderMaterial;
  private lastUpdateFrame = -1;
  private readonly dirWorld = new THREE.Vector3();
  private readonly dirScreen = new THREE.Vector2(0, 1);

  constructor(res: PostResources) { super(res); }

  protected override onSetup(): void {
    this.fx = this.makeMaterial({
      name: 'screenfx/composite',
      fragment: SCREENFX_FRAG,
      uniforms: {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uAspect: { value: 16 / 9 },
        uTime: { value: 0 },
        uFrame: { value: 0 },
        uBlind: { value: 0 },
        uFlash: { value: new THREE.Vector3() },
        uDamage: { value: 0 },
        uDamageDir: { value: new THREE.Vector2(0, 1) },
        uConcussion: { value: 0 },
        uConcussionTime: { value: 0 },
        uBlood: { value: 0 },
        uWater: { value: 0 },
        uDirt: { value: 0 },
      },
    });
  }

  render(ctx: PassContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): boolean {
    const s = this.res.fx;
    // Decay runs here so the state advances exactly once per frame regardless of
    // whether any effect is currently visible.
    if (ctx.frame !== this.lastUpdateFrame) {
      this.lastUpdateFrame = ctx.frame;
      s.update(ctx.dt);
    }
    if (!this.enabled) return false;

    const active = s.blind > 0.002 || s.damage > 0.002 || s.concussion > 0.002
      || s.blood > 0.004 || s.water > 0.004 || s.dirt > 0.004
      || s.flash.lengthSq() > 1e-5;
    if (!active) return false;

    // Rotate the world-space damage direction into screen space.
    this.dirWorld.set(s.damageDir.x, 0, s.damageDir.y)
      .transformDirection(ctx.camera.matrixWorldInverse);
    const len = Math.hypot(this.dirWorld.x, this.dirWorld.y);
    if (len > 1e-4) this.dirScreen.set(this.dirWorld.x / len, this.dirWorld.y / len);
    else this.dirScreen.set(0, -1);
    // Sources behind the camera read as "below and behind" — push the indicator
    // to the bottom of the frame the way shipped titles do.
    if (this.dirWorld.z > 0) this.dirScreen.set(this.dirScreen.x * 0.4, -1);

    const u = this.fx.uniforms;
    u.tInput.value = input;
    (u.uTexel.value as THREE.Vector2).set(1 / ctx.width, 1 / ctx.height);
    u.uAspect.value = ctx.width / Math.max(1, ctx.height);
    u.uTime.value = ctx.time;
    u.uFrame.value = ctx.frame % 64;
    u.uBlind.value = s.blind;
    (u.uFlash.value as THREE.Vector3).copy(s.flash).multiplyScalar(0.35);
    u.uDamage.value = Math.min(1, s.damage);
    (u.uDamageDir.value as THREE.Vector2).copy(this.dirScreen);
    u.uConcussion.value = Math.min(1, s.concussion);
    u.uConcussionTime.value = s.concussionTime;
    u.uBlood.value = s.blood;
    u.uWater.value = s.water;
    u.uDirt.value = s.dirt;
    ctx.blit(this.fx, output);
    return true;
  }
}
