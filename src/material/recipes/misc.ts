/**
 * Remaining archetypes: window glass, armoured glass, standing water, foliage
 * cards, flesh — plus the emissive family (fluorescent tube diffuser, hazard
 * strobe lens, CRT monitor, hot metal, emergency lamp).
 *
 * The emissive recipes deliberately author their *screen content* into the
 * albedo, because `MaterialSystem` then wires that same texture in as the
 * emissive map and animates it in the shader — one texture, two jobs.
 */

import type { MaterialArchetype } from '../types';

/* ----------------------------------------------------------------- glass -- */

const glass: MaterialArchetype = {
  id: 'glass',
  label: 'Cracked window glass',
  surface: 'glass',
  detail: 'micro',
  transparent: true,
  opacity: 1,
  doubleSided: true,
  shader: { triplanar: false, pom: false, alphaFromMap: true, detailScale: 40 },
  recipe: {
    id: 'glass',
    seed: 401,
    size: 1024,
    geometry: { tile: 1.6, depth: 0.002 },
    normalGain: 2.0,
    normalWide: 0.25,
    aoRadius: 0.012,
    aoStrength: 0.4,
    aoAlbedo: 0.1,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.72 + (obFbm(uv * 6.0, vec2(6.0), 3, 0.5, uSeed) - 0.5) * 0.05;

  // impact point with radial + concentric fracture
  vec2 c = vec2(0.38, 0.56);
  vec2 rv = uv - c;
  float r = length(rv);
  float a = atan(rv.y, rv.x) / OB_TAU + 0.5;
  float radial = abs(fract(a * 14.0 + obValueP(vec2(a * 14.0, 0.0), vec2(14.0, 1.0), uSeed + 3.0) * 0.4) - 0.5) * 2.0;
  float radialLine = smoothstep(0.86, 0.98, radial) * smoothstep(0.62, 0.03, r);
  float ring = abs(fract(r * 9.0 + obFbm(uv * 8.0, vec2(8.0), 3, 0.5, uSeed + 5.0) * 0.9) - 0.5) * 2.0;
  float ringLine = smoothstep(0.90, 1.0, ring) * smoothstep(0.55, 0.05, r);
  float shatter = obSat(radialLine + ringLine);

  // general spider cracking across the pane
  float web = obCracks(uv, vec2(1.0), 4.0, 0.016, uSeed + 7.0);

  float crack = obSat(shatter + web * 0.8);
  h -= crack * 0.5;

  // the punched-out hole at the centre
  float hole = smoothstep(0.055, 0.02, r);
  h -= hole * 0.7;

  h0 = vec4(clamp(h, 0.0, 1.0), crack, hole, r);
  h1 = vec4(shatter, web, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float crack = h0.y, hole = h0.z;

  vec3 tintCol = obRGB(196, 214, 216);
  vec3 col = tintCol;

  // grime film, heavier at the edges and in the corners
  float film = obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 61.0);
  float edge = 1.0 - smoothstep(0.0, 0.18, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  float dirt = obSat(film * 0.7 + edge * 0.8);
  col = mix(col, obRGB(150, 148, 138), dirt * 0.5);

  float streak = obStreaks(uv, 26.0, 0.7, uSeed + 71.0);
  col = mix(col, obRGB(178, 176, 168), streak * 0.4);

  // fracture surfaces scatter light — they go bright white
  col = mix(col, vec3(0.92), crack * 0.9);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.04 + dirt * 0.30 + crack * 0.45, 0.03, 0.9);
  // opaque where fractured or dirty, near-invisible where clean
  o.alpha = obSat(0.10 + dirt * 0.35 + crack * 0.85) * (1.0 - hole);
}`,
  },
};

const glassThick: MaterialArchetype = {
  ...glass,
  id: 'glassThick',
  label: 'Armoured glass',
  surface: 'glassThick',
  recipe: {
    ...glass.recipe,
    id: 'glassThick',
    seed: 409,
    geometry: { tile: 1.2, depth: 0.004 },
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float crack = h0.y, hole = h0.z;
  vec3 col = obRGB(178, 198, 190);
  float film = obFbm(uv * 4.0, vec2(4.0), 4, 0.5, uSeed + 61.0);
  float edge = 1.0 - smoothstep(0.0, 0.14, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  float dirt = obSat(film * 0.6 + edge * 0.7);
  col = mix(col, obRGB(140, 150, 142), dirt * 0.5);
  // laminated glass goes milky white rather than shattering out
  col = mix(col, vec3(0.94), crack * 0.95);
  float milk = smoothstep(0.25, 0.7, crack + obFbm(uv * 12.0, vec2(12.0), 4, 0.5, uSeed + 77.0) * 0.4 * crack);
  col = mix(col, vec3(0.97), milk * 0.7);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.05 + dirt * 0.25 + crack * 0.5, 0.03, 0.9);
  o.alpha = obSat(0.14 + dirt * 0.35 + crack * 0.9) * (1.0 - hole * 0.6);
}`,
  },
};

/* ----------------------------------------------------------------- water -- */

const puddle: MaterialArchetype = {
  id: 'puddle',
  label: 'Standing water',
  surface: 'puddle',
  detail: 'none',
  shader: { pom: false, triplanar: true },
  recipe: {
    id: 'puddle',
    seed: 419,
    size: 512,
    geometry: { tile: 3.0, depth: 0.002 },
    normalGain: 1.2,
    normalWide: 0.5,
    aoRadius: 0.02,
    aoStrength: 0.3,
    aoAlbedo: 0.1,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // capillary ripples layered over a slow swell
  float a = obFbm(uv * 12.0, vec2(12.0), 4, 0.5, uSeed);
  float b = obFbm(uv * 40.0, vec2(40.0), 3, 0.5, uSeed + 3.0);
  float h = 0.5 + (a - 0.5) * 0.5 + (b - 0.5) * 0.3;
  // rain rings
  vec3 w = obWorleyP(uv * 9.0, vec2(9.0), 1.0, uSeed + 5.0);
  float ring = abs(fract(w.x * 6.0) - 0.5) * 2.0;
  h += smoothstep(0.85, 1.0, ring) * smoothstep(0.5, 0.05, w.x) * 0.25;
  h0 = vec4(clamp(h, 0.0, 1.0), a, b, w.z);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  vec3 col = obRGB(28, 32, 34);
  float silt = obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 61.0);
  col = mix(col, obRGB(56, 52, 44), silt * 0.5);
  // oil film iridescence
  float film = obFbm(uv * 3.0, vec2(3.0), 4, 0.5, uSeed + 71.0);
  vec3 sheen = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + film * 20.0);
  col = mix(col, sheen * 0.35, smoothstep(0.55, 0.8, film) * 0.5);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.03 + silt * 0.10, 0.02, 0.4);
}`,
  },
};

/* --------------------------------------------------------------- foliage -- */

const foliage: MaterialArchetype = {
  id: 'foliage',
  label: 'Foliage card',
  surface: 'foliage',
  detail: 'organic',
  doubleSided: true,
  shader: { triplanar: false, pom: false, alphaFromMap: true, detailScale: 12 },
  recipe: {
    id: 'foliage',
    seed: 421,
    size: 1024,
    geometry: { tile: 0.7, depth: 0.004 },
    normalGain: 1.3,
    aoRadius: 0.03,
    aoAlbedo: 0.4,
    height: /* glsl */ `
float obLeaf(vec2 uv, vec2 c, float ang, float size, out float vein, out float rib) {
  float ca = cos(ang), sa = sin(ang);
  vec2 q = uv - c;
  q = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca) / size;
  // lanceolate outline
  float w = (1.0 - abs(q.y)) * 0.42 * (1.0 - q.y * 0.35);
  float body = smoothstep(w, w - 0.05, abs(q.x)) * step(abs(q.y), 1.0);
  rib = smoothstep(0.022, 0.0, abs(q.x)) * body;
  float vpat = abs(fract((q.y * 7.0 + abs(q.x) * 5.0)) - 0.5) * 2.0;
  vein = smoothstep(0.80, 1.0, vpat) * body;
  return body;
}

void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.0;
  float cover = 0.0;
  float veins = 0.0;
  float ribs = 0.0;
  float idAcc = 0.0;
  // 14 leaves, each drawn nine times against the wrapped copies of the tile so
  // the card is seamless in both axes.
  for (int i = 0; i < 14; i++) {
    vec3 r = obHash33(vec3(float(i) * 3.1, 7.0, uSeed));
    float ang = r.z * OB_TAU;
    float size = mix(0.15, 0.28, obHash13(vec3(float(i), 2.0, uSeed)));
    float depth = 0.45 + r.z * 0.4;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 c = vec2(r.x, r.y) + vec2(float(ox), float(oy));
        float vein = 0.0;
        float rib = 0.0;
        float b = obLeaf(uv, c, ang, size, vein, rib);
        if (b * depth > h) { h = b * depth; idAcc = r.x; }
        cover = max(cover, b);
        veins = max(veins, vein);
        ribs = max(ribs, rib);
      }
    }
  }
  float curl = obFbm(uv * 8.0, vec2(8.0), 3, 0.5, uSeed + 3.0);
  h += cover * (curl - 0.5) * 0.18;
  h += ribs * 0.10 - veins * 0.05;
  h0 = vec4(clamp(h, 0.0, 1.0), cover, idAcc, veins);
  h1 = vec4(ribs, curl, 0.0, 0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float cover = h0.y, id = h0.z, veins = h0.w;
  float ribs = h1.x, curl = h1.y;

  vec3 fresh = obRGB( 74,  98,  46);
  vec3 deep  = obRGB( 44,  64,  30);
  vec3 dry   = obRGB(132, 120,  56);

  vec3 col = mix(deep, fresh, id);
  col = mix(col, dry, smoothstep(0.72, 1.0, id) * 0.8);
  col *= mix(0.85, 1.12, curl);
  col = mix(col, col * 1.25, veins * 0.5);
  col = mix(col, col * 1.35, ribs * 0.6);
  col = mix(col, deep * 0.6, obSat(d.cavity * 1.4 + (1.0 - d.ao)) * 0.4);

  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.68 + curl * 0.16, 0.4, 1.0);
  o.alpha = smoothstep(0.15, 0.42, cover);
}`,
  },
};

/* ----------------------------------------------------------------- flesh -- */

const flesh: MaterialArchetype = {
  id: 'flesh',
  label: 'Skin',
  surface: 'flesh',
  detail: 'micro',
  shader: { pom: false, detailScale: 44 },
  recipe: {
    id: 'flesh',
    seed: 431,
    size: 512,
    geometry: { tile: 0.4, depth: 0.0012 },
    normalGain: 1.8,
    normalWide: 0.25,
    aoRadius: 0.012,
    aoStrength: 0.6,
    aoAlbedo: 0.25,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // dermal micro-relief: the polygonal cell pattern of real skin
  vec3 v = obVoronoiEdgeP(uv * 120.0, vec2(120.0), 1.0, uSeed);
  float furrow = 1.0 - smoothstep(0.0, 0.10, v.x);
  float h = 0.68 - furrow * 0.30;
  h += (obFbm(uv * 300.0, vec2(300.0), 3, 0.5, uSeed + 3.0) - 0.5) * 0.10;
  // pores
  vec3 p = obWorleyP(uv * 260.0, vec2(260.0), 1.0, uSeed + 5.0);
  h -= smoothstep(0.18, 0.0, p.x) * step(0.7, p.z) * 0.20;
  h0 = vec4(clamp(h, 0.0, 1.0), furrow, v.y, p.z);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  vec3 base = obRGB(186, 142, 118);
  vec3 blood = obRGB(178, 104,  92);
  vec3 shade = obRGB(132,  94,  78);
  float blotch = obFbm(uv * 8.0, vec2(8.0), 4, 0.5, uSeed + 61.0);
  vec3 col = mix(base, blood, blotch * 0.55);
  col = mix(col, shade, obSat(d.cavity * 1.4 + (1.0 - d.ao)) * 0.4);
  float stubble = obSplatter(uv, 60.0, 0.30, uSeed + 71.0);
  col = mix(col, obRGB(84, 70, 60), stubble * 0.35);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.52 + blotch * 0.16, 0.3, 0.9);
}`,
  },
};

/* -------------------------------------------------------------- emissive -- */

const monitor: MaterialArchetype = {
  id: 'monitor',
  label: 'CRT monitor',
  surface: 'plastic',
  detail: 'none',
  emissive: 'monitor',
  shader: { triplanar: false, pom: false },
  recipe: {
    id: 'monitor',
    seed: 501,
    size: 512,
    geometry: { tile: 0.5, depth: 0.0008 },
    normalGain: 1.0,
    aoStrength: 0.3,
    aoAlbedo: 0.1,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float h = 0.7 + (obValueP(uv * 200.0, vec2(200.0), uSeed) - 0.5) * 0.06;
  h0 = vec4(h, 0.0, 0.0, 0.0);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  // a plausible tactical readout: header bar, panels, waveform, text rows
  vec3 bg = obRGB(6, 14, 12);
  vec3 fg = obRGB(96, 226, 168);
  vec3 warn = obRGB(232, 158, 62);
  vec3 col = bg;

  float header = step(0.90, uv.y);
  col = mix(col, fg * 0.35, header);

  // three panels
  float px = floor(uv.x * 3.0);
  vec2 pl = fract(uv * vec2(3.0, 1.0));
  float frame = step(0.02, pl.x) * step(pl.x, 0.98) * step(0.06, uv.y) * step(uv.y, 0.86);
  float border = frame - step(0.05, pl.x) * step(pl.x, 0.95) * step(0.09, uv.y) * step(uv.y, 0.83);
  col = mix(col, fg * 0.55, border);

  // text rows
  float rowY = floor(uv.y * 44.0);
  float rowOn = step(0.45, obHash13(vec3(rowY, px, uSeed)));
  float glyph = step(0.42, obValueP(vec2(uv.x * 160.0, rowY * 3.0), vec2(160.0, 44.0 * 3.0), uSeed + 3.0));
  float text = rowOn * glyph * frame * step(0.10, uv.y) * step(uv.y, 0.82);
  col = mix(col, fg, text * 0.85);

  // a waveform in the middle panel
  float wave = obFbm(vec2(uv.x * 40.0, 0.0), vec2(40.0, 1.0), 3, 0.5, uSeed + 5.0);
  float line = smoothstep(0.012, 0.0, abs(uv.y - (0.45 + (wave - 0.5) * 0.22))) * step(0.33, uv.x) * step(uv.x, 0.66);
  col = mix(col, warn, line);

  // phosphor mask (visible even when the animation is off)
  float mask = 0.82 + 0.18 * cos(uv.y * 900.0);
  col *= mask;

  o.albedo = col;
  o.metal = 0.0;
  o.rough = 0.22;
}`,
  },
};

const lightPanel: MaterialArchetype = {
  id: 'fluorescent',
  label: 'Fluorescent diffuser',
  surface: 'plastic',
  detail: 'none',
  emissive: 'fluorescent',
  shader: { triplanar: false, pom: false },
  recipe: {
    id: 'fluorescent',
    seed: 503,
    size: 512,
    geometry: { tile: 1.2, depth: 0.002 },
    normalGain: 1.2,
    aoStrength: 0.4,
    aoAlbedo: 0.15,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // prismatic diffuser: a pyramid grid
  vec2 p = fract(uv * 60.0) - 0.5;
  float pyr = 1.0 - (abs(p.x) + abs(p.y)) * 2.0;
  float h = 0.55 + pyr * 0.30;
  float end = smoothstep(0.10, 0.16, min(uv.x, 1.0 - uv.x));
  h -= (1.0 - end) * 0.25;
  h0 = vec4(clamp(h, 0.0, 1.0), end, pyr, 0.0);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float end = h0.y;
  vec3 lit = obRGB(232, 240, 228);
  vec3 cap = obRGB(84, 86, 88);
  vec3 col = mix(cap, lit, end);
  // dust and dead insects on the inside of the diffuser
  float dust = obSplatter(uv, 9.0, 0.22, uSeed + 61.0) * end;
  col = mix(col, obRGB(120, 112, 92), dust * 0.55);
  float grime = obSat(d.cavity * 1.4 + (1.0 - d.ao)) * end;
  col = mix(col, obRGB(150, 148, 132), grime * 0.35);
  o.albedo = col;
  o.metal = (1.0 - end) * 0.6;
  o.rough = mix(0.45, 0.30, end);
}`,
  },
};

const strobe: MaterialArchetype = {
  id: 'strobe',
  label: 'Hazard beacon lens',
  surface: 'plastic',
  detail: 'none',
  emissive: 'strobe',
  shader: { triplanar: false, pom: false },
  recipe: {
    id: 'strobe',
    seed: 509,
    size: 256,
    geometry: { tile: 0.3, depth: 0.004 },
    normalGain: 1.4,
    aoStrength: 0.5,
    aoAlbedo: 0.2,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  // fresnel rings around the lens
  float rings = abs(fract(uv.y * 26.0) - 0.5) * 2.0;
  float h = 0.5 + rings * 0.4;
  h0 = vec4(clamp(h, 0.0, 1.0), rings, 0.0, 0.0);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  vec3 lens = obRGB(226, 108, 26);
  vec3 col = lens * mix(0.75, 1.15, h0.y);
  float grime = obSat(d.cavity * 1.5 + (1.0 - d.ao)) ;
  col = mix(col, obRGB(120, 74, 40), grime * 0.4);
  o.albedo = col;
  o.metal = 0.0;
  o.rough = clamp(0.18 + grime * 0.3, 0.1, 0.8);
}`,
  },
};

const hotMetal: MaterialArchetype = {
  id: 'hotMetal',
  label: 'Hot metal',
  surface: 'metal',
  detail: 'metal',
  emissive: 'hotMetal',
  shader: { pom: false, detailScale: 22 },
  recipe: {
    id: 'hotMetal',
    seed: 521,
    size: 512,
    geometry: { tile: 1.0, depth: 0.006 },
    normalGain: 1.2,
    aoRadius: 0.03,
    aoAlbedo: 0.3,
    height: /* glsl */ `
void obHeightFn(vec2 uv, out vec4 h0, out vec4 h1) {
  float scale = obWorleyFbm(uv * 60.0, vec2(60.0), 3, 1.0, uSeed);
  float h = 0.55 + (scale - 0.5) * 0.40;
  h += (obFbm(uv * 5.0, vec2(5.0), 4, 0.5, uSeed + 3.0) - 0.5) * 0.20;
  float crack = obCracks(uv, vec2(1.0), 7.0, 0.035, uSeed + 5.0);
  h -= crack * 0.45;
  h0 = vec4(clamp(h, 0.0, 1.0), crack, scale, 0.0);
  h1 = vec4(0.0);
}`,
    shade: /* glsl */ `
void obShadeFn(vec2 uv, vec4 h0, vec4 h1, ObDerived d, inout ObOut o) {
  float crack = h0.y, scale = h0.z;
  // cooled oxide scale on the surface, glowing metal in the fissures
  vec3 oxide = mix(obRGB(38, 34, 32), obRGB(72, 62, 54), scale);
  vec3 col = oxide;
  o.albedo = col;
  o.metal = 0.25;
  o.rough = clamp(0.75 - crack * 0.2, 0.2, 1.0);
  // heat mask lives in the AO slot; the emissive shader reads ORM.a (height)
  o.ao = 1.0;
}`,
  },
};

export const MISC_ARCHETYPES: MaterialArchetype[] = [
  glass, glassThick, puddle, foliage, flesh, monitor, lightPanel, strobe, hotMetal,
];
