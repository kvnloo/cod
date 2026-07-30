/**
 * Layout generators: brick / tile / plank / hex / panel grids with per-cell
 * randomisation, plus the wear vocabulary (scratches, cracks, streaks, weave).
 *
 * All of these are periodic over uv ∈ [0,1] as long as the cell counts are
 * integers, so the resulting texture tiles seamlessly.
 */

export const PATTERNS_GLSL = /* glsl */ `
#ifndef OB_PATTERNS_INCLUDED
#define OB_PATTERNS_INCLUDED

/**
 * A cell produced by one of the layout generators.
 *   local  — uv inside the cell, [0,1]
 *   id     — integer cell coordinate (already wrapped)
 *   rnd    — three stable per-cell randoms
 *   edge   — normalised distance to the nearest cell border, 0 at the border
 *   aspect — cell size in uv units, used to keep gap widths isotropic
 */
struct ObCell {
  vec2 local;
  vec2 id;
  vec3 rnd;
  float edge;
  vec2 size;
};

float obCellEdge(vec2 local, vec2 size, float gap) {
  vec2 d = min(local, 1.0 - local) * size;
  return min(d.x, d.y) - gap * 0.5;
}

/* ------------------------------------------------------------------ bricks */

/**
 * Running-bond brick courses.
 *  counts   — bricks across, courses up
 *  offset   — row shift per course (0.5 = classic running bond)
 *  jitter   — random per-course extra shift
 */
ObCell obBrick(vec2 uv, vec2 counts, float offset, float jitter, float seed) {
  ObCell c;
  vec2 p = uv * counts;
  float row = floor(p.y);
  float rowRnd = obHash13(vec3(0.0, mod(row, counts.y), seed));
  float shift = offset * row + (rowRnd - 0.5) * jitter;
  p.x += shift;
  vec2 id = vec2(floor(p.x), row);
  c.local = fract(p);
  c.id = vec2(mod(id.x, counts.x), mod(id.y, counts.y));
  c.rnd = obHash33(vec3(c.id, seed));
  c.size = 1.0 / counts;
  c.edge = 0.0;
  return c;
}

/**
 * Brick with per-brick length variation: courses are split at random positions
 * so no two rows share a joint pattern. Returns the same ObCell contract.
 */
ObCell obBrickVaried(vec2 uv, vec2 counts, float offset, float lenVar, float seed) {
  ObCell c;
  vec2 p = uv * counts;
  float row = floor(p.y);
  float rowRnd = obHash13(vec3(7.0, mod(row, counts.y), seed));
  float x = p.x + offset * row + rowRnd * 0.37;
  // Warp the x axis slightly per course so brick widths differ.
  float wob = (obHash13(vec3(floor(x), mod(row, counts.y), seed + 3.0)) - 0.5) * lenVar;
  float xi = floor(x + wob * 0.0);
  c.local = vec2(fract(x), fract(p.y));
  c.id = vec2(mod(xi, counts.x * 2.0), mod(row, counts.y));
  c.rnd = obHash33(vec3(c.id, seed));
  c.rnd.z = mix(c.rnd.z, wob * 0.5 + 0.5, 0.5);
  c.size = 1.0 / counts;
  c.edge = 0.0;
  return c;
}

/* ------------------------------------------------------------------- tiles */

ObCell obGrid(vec2 uv, vec2 counts, float seed) {
  ObCell c;
  vec2 p = uv * counts;
  vec2 id = floor(p);
  c.local = fract(p);
  c.id = mod(id, counts);
  c.rnd = obHash33(vec3(c.id, seed));
  c.size = 1.0 / counts;
  c.edge = 0.0;
  return c;
}

/* ------------------------------------------------------------------ planks */

/**
 * Floor/wall planks: fixed-width columns (or rows), randomly staggered joints
 * along their length.
 *  counts.x — planks across
 *  counts.y — nominal boards along the run
 */
ObCell obPlanks(vec2 uv, vec2 counts, float stagger, float seed) {
  ObCell c;
  vec2 p = uv * counts;
  float col = floor(p.x);
  float colRnd = obHash13(vec3(mod(col, counts.x), 3.0, seed));
  float y = p.y + colRnd * stagger * counts.y;
  vec2 id = vec2(col, floor(y));
  c.local = vec2(fract(p.x), fract(y));
  c.id = vec2(mod(id.x, counts.x), mod(id.y, counts.y));
  c.rnd = obHash33(vec3(c.id, seed));
  c.size = 1.0 / counts;
  c.edge = 0.0;
  return c;
}

/* --------------------------------------------------------------------- hex */

/** Hexagonal tiling. 'counts' is columns across; rows are derived. */
ObCell obHex(vec2 uv, float count, float seed) {
  ObCell c;
  vec2 p = uv * vec2(count, count * 1.1547005);   // 2/sqrt(3)
  vec2 a = mod(p, vec2(1.0, 1.7320508)) - vec2(0.5, 0.8660254);
  vec2 b = mod(p - vec2(0.5, 0.8660254), vec2(1.0, 1.7320508)) - vec2(0.5, 0.8660254);
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = p - g;
  c.local = g + 0.5;
  c.id = floor(id * 4.0) * 0.25;
  c.rnd = obHash33(vec3(c.id, seed));
  c.size = vec2(1.0 / count);
  // distance to hex border, 0 at border, ~0.5 at centre
  vec2 ag = abs(g);
  c.edge = 0.5 - max(ag.x * 0.8660254 + ag.y * 0.5, ag.y);
  return c;
}

/* ------------------------------------------------------------------ panels */

/**
 * Recursive binary subdivision → industrial panelling, ceiling grids, crate
 * faces. 'splits' controls depth (3–5 reads well).
 */
ObCell obPanels(vec2 uv, vec2 counts, int splits, float seed) {
  vec2 lo = floor(uv * counts) / counts;
  vec2 hi = lo + 1.0 / counts;
  vec2 rid = floor(uv * counts);
  float s = seed + rid.x * 13.0 + rid.y * 71.0;
  for (int i = 0; i < 6; i++) {
    if (i >= splits) break;
    vec2 sz = hi - lo;
    float r = obHash13(vec3(lo * 97.0, s + float(i)));
    float cut = mix(0.32, 0.68, obHash13(vec3(lo * 31.0, s + float(i) + 5.0)));
    if (sz.x * (1.0 + 0.001) > sz.y || r > 0.75) {
      float m = lo.x + sz.x * cut;
      if (uv.x < m) hi.x = m; else lo.x = m;
    } else {
      float m = lo.y + sz.y * cut;
      if (uv.y < m) hi.y = m; else lo.y = m;
    }
  }
  ObCell c;
  vec2 sz = max(hi - lo, vec2(1e-4));
  c.local = (uv - lo) / sz;
  c.id = lo;
  c.rnd = obHash33(vec3(lo * 211.0, seed));
  c.size = sz;
  c.edge = 0.0;
  return c;
}

/* ------------------------------------------------------------- corrugation */

/** Sinusoidal corrugation profile in [0,1]; 'freq' must be an integer to tile. */
float obCorrugate(float x, float freq, float plateau) {
  float t = fract(x * freq);
  float s = smoothstep(0.0, plateau, t) * smoothstep(1.0, 1.0 - plateau, t);
  return mix(0.5 - 0.5 * cos(t * OB_TAU), s, 0.35);
}

/** Trapezoidal (box-profile) roofing rib. */
float obRib(float x, float freq, float width) {
  float t = fract(x * freq);
  float d = abs(t - 0.5) * 2.0;
  return smoothstep(width + 0.14, width - 0.14, d);
}

/* ---------------------------------------------------------- diamond plate */

/** Classic five-bar / diamond tread plate. */
float obDiamondPlate(vec2 uv, float count, float seed) {
  vec2 p = uv * count;
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  float par = mod(cell.x + cell.y, 2.0);
  // two alternating diagonal lozenges
  float ang = par > 0.5 ? 0.7853981 : -0.7853981;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = vec2(f.x * ca - f.y * sa, f.x * sa + f.y * ca);
  q *= vec2(1.0, 3.1);
  float d = abs(q.x) + abs(q.y);
  return smoothstep(0.40, 0.16, d);
}

/* ------------------------------------------------------------------- weave */

/** Over/under fabric weave. Returns (height, isWarp). */
vec2 obWeave(vec2 uv, float count, float seed) {
  vec2 p = uv * count;
  vec2 f = fract(p);
  vec2 id = floor(p);
  float par = mod(id.x + id.y, 2.0);
  float warp = sin(f.x * OB_PI);
  float weft = sin(f.y * OB_PI);
  float h = par > 0.5 ? warp * 0.9 + weft * 0.35 : weft * 0.9 + warp * 0.35;
  return vec2(h, par);
}

/* ----------------------------------------------------------- wear elements */

/**
 * Anisotropic scratches: thin bright lines running mostly along 'dir'.
 * 'density' ~ number of scratch bands, 'sharp' controls thinness.
 */
float obScratches(vec2 uv, float bands, float shear, float sharp, float coverage, float seed) {
  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float dens = bands * (1.0 + fi * 2.0);
    float sh = shear + fi * 2.0;
    float y = (uv.y + uv.x * sh) * dens;
    float band = floor(y);
    float r0 = obHash13(vec3(mod(band, dens), fi, seed));
    float r1 = obHash13(vec3(mod(band, dens), fi + 9.0, seed));
    if (r0 > coverage) continue;
    // Wobble along the scratch, periodic in x.
    float wob = (obValueP(vec2(uv.x * 12.0, band * 2.7), vec2(12.0, dens * 2.7), seed + fi) - 0.5) * 0.7;
    float t = abs(fract(y - wob) - 0.5) * 2.0;
    float line = pow(1.0 - t, sharp * mix(0.6, 1.6, r1));
    // Break the line into segments so it never runs the whole tile.
    float seg = obValueP(vec2(uv.x * 26.0, band * 5.3), vec2(26.0, dens * 5.3), seed + fi * 3.1);
    line *= smoothstep(0.36, 0.66, seg);
    acc = max(acc, line);
  }
  return obSat(acc);
}

/** Crack network from Voronoi borders; returns depth in [0,1]. */
float obCracks(vec2 uv, vec2 period, float scale, float width, float seed) {
  vec2 p = obWarp(uv * scale, period * scale, 0.28, seed);
  vec3 v = obVoronoiEdgeP(p, period * scale, 1.0, seed);
  float d = v.x;
  float crack = 1.0 - smoothstep(0.0, width, d);
  // Not every border cracks.
  float gate = obFbm(uv * scale, period * scale, 3, 0.5, seed + 17.0);
  crack *= smoothstep(0.34, 0.62, gate);
  return obSat(crack);
}

/**
 * Gravity-driven streaks: dirt/rust washing down a vertical surface, anchored
 * at high points of 'source' and fading downward.
 */
float obStreaks(vec2 uv, float count, float len, float seed) {
  float x = uv.x * count;
  float col = floor(x);
  float rnd = obHash13(vec3(mod(col, count), 0.0, seed));
  float rnd2 = obHash13(vec3(mod(col, count), 1.0, seed + 5.0));
  float w = abs(fract(x) - 0.5) * 2.0;
  float band = pow(1.0 - w, mix(1.2, 4.0, rnd));
  float start = mix(0.55, 1.0, rnd2);
  float run = obSat((start - uv.y) / max(len * mix(0.5, 1.5, rnd), 1e-3));
  float fade = pow(obSat(1.0 - run), 1.4) * step(uv.y, start);
  float grain = obFbm(vec2(uv.x * count * 2.0, uv.y * 6.0), vec2(count * 2.0, 6.0), 4, 0.5, seed + 9.0);
  return obSat(band * fade * mix(0.55, 1.25, grain) * step(0.35, rnd));
}

/** Splatter/spray blobs — mould colonies, paint overspray, blood mist. */
float obSplatter(vec2 uv, float count, float coverage, float seed) {
  vec3 w = obWorleyP(uv * count, vec2(count), 1.0, seed);
  float blob = 1.0 - smoothstep(0.0, mix(0.12, 0.46, w.z), w.x);
  float gate = step(1.0 - coverage, w.z);
  float edge = obFbm(uv * count * 4.0, vec2(count * 4.0), 4, 0.5, seed + 3.0);
  return obSat(blob * gate * smoothstep(0.25, 0.7, edge + blob * 0.4));
}

/**
 * Directional brushing (aluminium, steel). Anisotropy comes from unequal
 * frequencies on the two axes, so it stays periodic; swap uv.xy at the call
 * site to change direction.
 */
float obBrushed(vec2 uv, float along, float across, float seed) {
  float n = obValueP(vec2(uv.x * along, uv.y * across), vec2(along, across), seed);
  float n2 = obValueP(vec2(uv.x * along * 3.0, uv.y * across * 2.0), vec2(along * 3.0, across * 2.0), seed + 4.0);
  float n3 = obValueP(vec2(uv.x * along * 9.0, uv.y * across * 4.0), vec2(along * 9.0, across * 4.0), seed + 8.0);
  return n * 0.5 + n2 * 0.32 + n3 * 0.18;
}

/** Stencil-style block character bar — crate markings, hazard stripes. */
float obHazardStripes(vec2 uv, float freq, float duty) {
  float t = fract((uv.x + uv.y) * freq);
  return smoothstep(duty - 0.06, duty + 0.06, abs(t - 0.5) * 2.0);
}

#endif
`;
