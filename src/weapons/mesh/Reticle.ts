/**
 * Illuminated optic reticles.
 *
 * A reticle is the one thing on a weapon that must be *pixel* crisp: it is a
 * few arc-minutes wide, it sits dead centre of the frame, and any softness or
 * stair-stepping on it is the first thing a player notices. So it is not a
 * texture — there is no resolution at which a 512² dot sprite is crisp at 4K
 * and not a blurry smear at 1080p. Every reticle here is drawn analytically in
 * the fragment shader with `fwidth`-scaled anti-aliasing, which means one
 * pixel of softness at *any* resolution, on *any* magnification.
 *
 * The other half of a believable optic is collimation. A reflex sight projects
 * its dot at infinity: move your eye and the dot slides across the glass so
 * that it stays pointing at the same place in the world. `ViewModel` drives
 * that (it is a two-line consequence of the eye's position in optic space);
 * this file just draws the mark and fades it as it approaches the edge of the
 * window.
 */

import * as THREE from 'three';

export type ReticleKind = 'dot' | 'holoRing' | 'chevron' | 'mildot';

const VERT = /* glsl */ `
varying vec2 vR;
void main() {
  vR = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * `uShape` selects the mark; every branch is compile-time constant per
 * material, so the driver folds it away.
 *
 * Units: `vR` spans −1..1 over the quad, and the quad is scaled by the view
 * model so that 1.0 equals the reticle's design half-angle. Feature sizes are
 * therefore in *angular* units and stay honest whatever the magnification.
 */
const FRAG = /* glsl */ `
varying vec2 vR;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFade;
uniform float uSeed;

/** Anti-aliased "inside" test for a signed distance in reticle units. */
float aa(float d) {
  float w = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(-w, w, d);
}
float ring(float r, float radius, float thick) {
  return aa(abs(r - radius) - thick);
}

void main() {
  float r = length(vR);
  float m = 0.0;
  float glow = 0.0;

#if OB_SHAPE == 0            /* 2 MOA dot */
  // Hard edge plus a *tight* halo. A wide halo is what turns a collimated dot
  // into an LED bulb sitting in the tube: the eye reads the glow envelope as
  // the object, not the core.
  m = aa(r - 0.26);
  glow = exp(-r * 9.0) * 0.16;
#elif OB_SHAPE == 1          /* 65 MOA ring + 1 MOA centre dot */
  m = ring(r, 0.86, 0.055) + aa(r - 0.115);
  // Four break marks at the cardinal points, as on a real holographic sight.
  vec2 a = abs(vR);
  float cross = max(aa(a.x - 0.028) * step(0.55, a.y) * step(a.y, 0.98),
                    aa(a.y - 0.028) * step(0.55, a.x) * step(a.x, 0.98));
  m = max(m, cross * 0.7);
  glow = exp(-r * 5.5) * 0.12;
#elif OB_SHAPE == 2          /* ACOG chevron */
  // The *tip* of the chevron is the aim point, so it sits at the origin and
  // the legs fall away below it, widening as they go.
  vec2 p = vec2(abs(vR.x), vR.y);
  float leg = abs(p.y + p.x * 1.35) - (0.050 + p.x * 0.085);
  m = aa(leg) * step(p.x, 0.62) * step(p.y, 0.03);
  // Ranging post hanging below the chevron.
  float post = aa(max(abs(vR.x) - 0.032, abs(vR.y + 0.66) - 0.34));
  m = max(m, post);
  glow = exp(-r * 5.0) * 0.16;
#else                        /* mil-dot cross */
  vec2 a = abs(vR);
  float horiz = aa(a.y - 0.014) * step(a.x, 0.95);
  float vert = aa(a.x - 0.014) * step(a.y, 0.95);
  // Thicker outer posts, as on a duplex reticle.
  horiz = max(horiz, aa(a.y - 0.040) * step(0.62, a.x) * step(a.x, 0.98));
  vert = max(vert, aa(a.x - 0.040) * step(0.62, a.y) * step(a.y, 0.98));
  float dots = 0.0;
  for (int i = 1; i < 4; i++) {
    float d = float(i) * 0.21;
    dots = max(dots, aa(length(vR - vec2(d, 0.0)) - 0.030));
    dots = max(dots, aa(length(vR + vec2(d, 0.0)) - 0.030));
    dots = max(dots, aa(length(vR - vec2(0.0, d)) - 0.030));
    dots = max(dots, aa(length(vR + vec2(0.0, d)) - 0.030));
  }
  m = max(max(horiz, vert), dots);
  m = max(m, aa(r - 0.022));
  glow = 0.0;
#endif

#ifdef OB_ETCHED
  // An etched glass reticle is *opaque black* laid over the image the
  // objective forms — there is nothing emissive about it, and drawing it
  // additively (as a red glow) is the classic tell of a fake scope.
  float k = clamp(m, 0.0, 1.0) * uFade;
  if (k < 0.004) discard;
  gl_FragColor = vec4(uColor * uIntensity, k * 0.94);
#else
  float k = clamp(m + glow, 0.0, 1.4) * uFade;
  if (k < 0.002) discard;
  // Emitters bloom into their own colour and clip toward white at the core;
  // that hot white centre is what makes a dot read as *illuminated* rather
  // than painted on.
  // A little white in the very core reads as "illuminated"; too much and the
  // dot desaturates to salmon and stops reading as red at all.
  vec3 c = uColor * uIntensity;
  c += vec3(1.0) * pow(clamp(m, 0.0, 1.0), 4.0) * uIntensity * 0.10;
  gl_FragColor = vec4(c, k);
#endif
}`;

const SHAPE: Record<ReticleKind, number> = { dot: 0, holoRing: 1, chevron: 2, mildot: 3 };

/**
 * `emissive` — a projected dot: additive, blooms, survives a bright sky.
 * `etched`   — glass etching on a magnified optic: dark, normal-blended.
 */
export type ReticleMode = 'emissive' | 'etched';

export interface ReticleOptions {
  kind: ReticleKind;
  /** Emitter colour; nearly every combat optic is red or amber. */
  color?: number;
  /** Radiance multiplier before tonemapping. */
  intensity?: number;
  mode?: ReticleMode;
}

/**
 * Builds the reticle quad. It is a unit square: `ViewModel` scales it to the
 * design half-angle every frame so the mark keeps a constant angular size
 * whatever the eye relief works out to.
 */
export function makeReticle(opts: ReticleOptions): THREE.Mesh {
  const etched = opts.mode === 'etched';
  const defines: Record<string, number | string> = { OB_SHAPE: SHAPE[opts.kind] };
  if (etched) defines.OB_ETCHED = '';
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    uniforms: {
      uColor: { value: new THREE.Color(opts.color ?? 0xff2a10) },
      uIntensity: { value: opts.intensity ?? 5.0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
    },
    transparent: true,
    blending: etched ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  // Deliberately *not* flagged `boSkipMRT`. The frame graph binds four draw
  // buffers; a shader that declares only colour leaves the other three
  // undeclared, and the whole draw is then dropped. Letting the renderer's
  // patcher append its neutral G-buffer write is both correct and the only
  // thing that puts the reticle on screen at all.
  mat.userData.boMatId = 1.0;

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.name = 'reticle';
  mesh.frustumCulled = false;
  // Drawn after the optic's own glass so the dot always sits on top of it.
  mesh.renderOrder = 40;
  return mesh;
}

/** Sets the emitter brightness — used to dim the dot out of ADS. */
export function setReticleFade(mesh: THREE.Mesh, fade: number): void {
  const m = mesh.material as THREE.ShaderMaterial;
  const u = m.uniforms?.uFade;
  if (u) u.value = fade;
  mesh.visible = fade > 0.004;
}
