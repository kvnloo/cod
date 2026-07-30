/**
 * Influence-field visualisation for a debug scene.
 *
 * Three layers, all unlit and depth-write-free so they read as an overlay:
 *
 *   • a ground quad per influence cell, blue where the friendly team owns the
 *     ground, red where the enemy does, grey in no-man's-land;
 *   • one marker per candidate spawn, its colour showing zone suitability and
 *     its height showing accumulated death heat — a killzone grows spikes;
 *   • a ring per zone, coloured by current owner and dashed-bright while the
 *     zone is suppressed, so a spawn flip is visible the instant it happens.
 *
 * This is the only file in the module that imports three. Everything it draws
 * comes from `DebugField.ts`, which the headless benchmark prints as ASCII, so
 * the picture on screen and the numbers in CI are the same data.
 *
 * Usage from a debug scene (which this module does not own):
 * ```ts
 * const view = new SpawnDebugView(director);
 * scene.add(view.group);
 * // per frame: view.update(matchTime);
 * ```
 */

import * as THREE from 'three';
import { clamp } from './Math';
import { influenceColor } from './DebugField';
import type { SpawnDirector } from './SpawnDirector';
import type { SpawnTeam } from './types';

export interface SpawnDebugOptions {
  /** Team the suitability colouring is computed for. */
  team?: SpawnTeam;
  /** Height above the field the overlay floats at, metres. */
  height?: number;
  /** Opacity of the ground field. */
  opacity?: number;
}

const RING_SEGMENTS = 32;

export class SpawnDebugView {
  readonly group = new THREE.Group();
  team: SpawnTeam;

  private readonly director: SpawnDirector;
  private readonly height: number;

  private fieldMesh: THREE.Mesh | null = null;
  private fieldColors: Float32Array = new Float32Array(0);
  private fieldGeom: THREE.BufferGeometry | null = null;
  private cellCount = 0;

  private markers: THREE.Points | null = null;
  private markerColors: Float32Array = new Float32Array(0);
  private markerPositions: Float32Array = new Float32Array(0);

  private rings: THREE.LineSegments | null = null;
  private ringColors: Float32Array = new Float32Array(0);

  private readonly rgb = { r: 0, g: 0, b: 0 };

  constructor(director: SpawnDirector, opts: SpawnDebugOptions = {}) {
    this.director = director;
    this.team = opts.team ?? 'friendly';
    this.height = opts.height ?? 0.08;
    this.group.name = 'SpawnDebugView';
    this.group.renderOrder = 900;
    this.build(opts.opacity ?? 0.34);
  }

  get visible(): boolean { return this.group.visible; }
  set visible(v: boolean) { this.group.visible = v; }

  /** Rebuilds geometry when the candidate set or grid changed, then recolours. */
  update(now: number): void {
    if (!this.group.visible) return;
    const field = this.director.field;
    if (field.nx * field.nz !== this.cellCount) this.build(0.34);
    this.updateField();
    this.updateMarkers(now);
    this.updateRings(now);
  }

  dispose(): void {
    this.group.clear();
    this.fieldGeom?.dispose();
    (this.fieldMesh?.material as THREE.Material | undefined)?.dispose();
    this.markers?.geometry.dispose();
    (this.markers?.material as THREE.Material | undefined)?.dispose();
    this.rings?.geometry.dispose();
    (this.rings?.material as THREE.Material | undefined)?.dispose();
    this.fieldMesh = null;
    this.markers = null;
    this.rings = null;
  }

  /* ------------------------------------------------------------- building -- */

  private build(opacity: number): void {
    this.dispose();
    this.buildField(opacity);
    this.buildMarkers();
    this.buildRings();
  }

  private buildField(opacity: number): void {
    const field = this.director.field;
    const nx = field.nx, nz = field.nz;
    this.cellCount = nx * nz;
    if (this.cellCount === 0) return;

    const cell = field.config.cell;
    const quads = this.cellCount;
    const positions = new Float32Array(quads * 6 * 3);
    const colors = new Float32Array(quads * 6 * 3);
    const inset = cell * 0.46;
    let v = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const cx = field.originX + (ix + 0.5) * cell;
        const cz = field.originZ + (iz + 0.5) * cell;
        const y = this.height;
        // two triangles, CCW when viewed from above
        const quad = [
          cx - inset, y, cz - inset,
          cx + inset, y, cz - inset,
          cx + inset, y, cz + inset,
          cx - inset, y, cz - inset,
          cx + inset, y, cz + inset,
          cx - inset, y, cz + inset,
        ];
        for (let i = 0; i < quad.length; i++) positions[v * 3 + i] = quad[i];
        v += 6;
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 900;
    this.fieldGeom = geom;
    this.fieldColors = colors;
    this.fieldMesh = mesh;
    this.group.add(mesh);
  }

  private buildMarkers(): void {
    const points = this.director.points;
    if (points.length === 0) return;
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].position.x;
      positions[i * 3 + 1] = points[i].position.y + 0.5;
      positions[i * 3 + 2] = points[i].position.z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.85, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false,
    });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 901;
    this.markerPositions = positions;
    this.markerColors = colors;
    this.markers = pts;
    this.group.add(pts);
  }

  private buildRings(): void {
    const zones = this.director.zones.zones;
    if (zones.length === 0) return;
    const segs = RING_SEGMENTS;
    const positions = new Float32Array(zones.length * segs * 2 * 3);
    const colors = new Float32Array(zones.length * segs * 2 * 3);
    let o = 0;
    for (const z of zones) {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        positions[o] = z.x + Math.cos(a0) * z.radius;
        positions[o + 1] = z.y + 0.12;
        positions[o + 2] = z.z + Math.sin(a0) * z.radius;
        positions[o + 3] = z.x + Math.cos(a1) * z.radius;
        positions[o + 4] = z.y + 0.12;
        positions[o + 5] = z.z + Math.sin(a1) * z.radius;
        o += 6;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, toneMapped: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 902;
    this.ringColors = colors;
    this.rings = lines;
    this.group.add(lines);
  }

  /* ------------------------------------------------------------ recolour -- */

  private updateField(): void {
    if (!this.fieldMesh || !this.fieldGeom) return;
    const net = this.director.field.net;
    const colors = this.fieldColors;
    for (let c = 0; c < this.cellCount; c++) {
      influenceColor(net[c], this.rgb);
      const base = c * 18;
      for (let k = 0; k < 6; k++) {
        colors[base + k * 3] = this.rgb.r;
        colors[base + k * 3 + 1] = this.rgb.g;
        colors[base + k * 3 + 2] = this.rgb.b;
      }
    }
    (this.fieldGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateMarkers(now: number): void {
    if (!this.markers) return;
    const points = this.director.points;
    const zones = this.director.zones;
    const colors = this.markerColors;
    const positions = this.markerPositions;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const zone = zones.get(p.zone);
      const suit = zone ? zones.suitability(zone, this.team, now) : 0.5;
      const heat = clamp(p.deaths / 3, 0, 1);
      // green = good spawn, amber = marginal, red = hot with recent deaths
      colors[i * 3] = clamp(1.4 - suit * 1.6 + heat, 0, 1);
      colors[i * 3 + 1] = clamp(suit * 1.5 - heat * 0.8, 0, 1);
      colors[i * 3 + 2] = clamp(0.25 + (p.enabled ? 0 : 0.6) - heat * 0.2, 0, 1);
      positions[i * 3 + 1] = p.position.y + 0.5 + heat * 1.6;
    }
    (this.markers.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.markers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateRings(now: number): void {
    if (!this.rings) return;
    const zones = this.director.zones.zones;
    const colors = this.ringColors;
    const stride = RING_SEGMENTS * 2 * 3;
    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      const suppressed = now < z.suppressedUntil;
      let r: number, g: number, b: number;
      if (z.owner === 'friendly') { r = 0.2; g = 0.7; b = 1.0; }
      else if (z.owner === 'hostile') { r = 1.0; g = 0.35; b = 0.22; }
      else { r = 0.7; g = 0.7; b = 0.7; }
      if (suppressed) { r = Math.min(1, r + 0.4); g *= 0.4; b *= 0.4; }
      const base = zi * stride;
      for (let k = 0; k < RING_SEGMENTS * 2; k++) {
        colors[base + k * 3] = r;
        colors[base + k * 3 + 1] = g;
        colors[base + k * 3 + 2] = b;
      }
    }
    (this.rings.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}
