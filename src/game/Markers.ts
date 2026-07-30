/**
 * World-space objective markers, built from `BufferGeometry` in code.
 *
 * Three pieces make an objective read at a glance from anywhere on the map:
 * a ground ring that says *where*, a soft light column that says *there*, and a
 * segmented progress arc that says *how far along*. The arc is an
 * `InstancedMesh` whose `count` is the progress — no geometry rebuilds, no
 * per-frame allocation.
 *
 * Everything lives on the TRANSPARENT render layer so it composites after the
 * opaque pass and never pollutes SSR or the depth prepass.
 */

import * as THREE from 'three';
import { LAYERS } from '../render/types';
import { settings } from '../core/Settings';

const ARC_SEGMENTS = 64;
const COLUMN_SEGMENTS = 28;

function additive(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
}

/** Ring + column + progress arc. One per active objective. */
export class ZoneMarker {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private shadow: THREE.Mesh;
  private shadowMat: THREE.MeshBasicMaterial;
  private inner: THREE.Mesh;
  private column: THREE.Mesh;
  private arc: THREE.InstancedMesh;
  private ringMat: THREE.MeshBasicMaterial;
  private innerMat: THREE.MeshBasicMaterial;
  private columnMat: THREE.MeshBasicMaterial;
  private arcMat: THREE.MeshBasicMaterial;
  private pulse = 0;
  private progress = 0;
  private baseColor = new THREE.Color(0x66b8ff);
  private radius: number;

  constructor(radius: number, color = 0x66b8ff) {
    this.radius = radius;
    const lowSpec = settings.preset === 'low';
    const seg = lowSpec ? 40 : 72;

    this.ringMat = additive(color, 0.85);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.965, radius, seg, 1),
      this.ringMat,
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.035;

    // A dark, *non*-additive contrast band under the glowing ring. Additive
    // alone disappears on a bright surface; this keeps the marker legible on
    // white concrete and on night asphalt alike.
    this.shadowMat = new THREE.MeshBasicMaterial({
      color: 0x05070c, transparent: true, opacity: 0.5, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.shadow = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.9, radius * 1.045, seg, 1),
      this.shadowMat,
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.028;

    this.innerMat = additive(color, 0.05);
    this.inner = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.96, seg), this.innerMat);
    this.inner.rotation.x = -Math.PI / 2;
    this.inner.position.y = 0.02;

    // A vertical shaft with a vertex-alpha falloff — the classic "beam of light
    // over the objective" without any texture. Deliberately short and faint:
    // the ring is the read, the column is only there to be visible over cover.
    this.columnMat = additive(color, 0.2);
    this.columnMat.vertexColors = true;
    this.column = new THREE.Mesh(
      buildColumn(radius * 0.985, Math.min(5.5, radius * 0.85), lowSpec ? 16 : COLUMN_SEGMENTS),
      this.columnMat,
    );

    this.arcMat = additive(0xffffff, 1);
    this.arc = new THREE.InstancedMesh(
      new THREE.BoxGeometry(radius * 0.055, 0.05, 0.16),
      this.arcMat,
      ARC_SEGMENTS,
    );
    this.arc.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arc.count = 0;
    this.arc.frustumCulled = false;
    layoutArc(this.arc, radius * 1.055);

    for (const o of [this.shadow, this.ring, this.inner, this.column, this.arc]) {
      o.layers.set(LAYERS.TRANSPARENT);
      o.userData.noCollide = true;
      o.renderOrder = 8;
      this.group.add(o);
    }
    this.shadow.renderOrder = 7;
    this.setColor(color);
  }

  setColor(hex: number): void {
    this.baseColor.setHex(hex);
    this.ringMat.color.copy(this.baseColor);
    this.innerMat.color.copy(this.baseColor);
    this.columnMat.color.copy(this.baseColor);
    this.arcMat.color.copy(this.baseColor).lerp(new THREE.Color(0xffffff), 0.6);
  }

  setProgress(p: number): void {
    this.progress = THREE.MathUtils.clamp(p, 0, 1);
    this.arc.count = Math.round(this.progress * ARC_SEGMENTS);
  }

  setPosition(p: THREE.Vector3): void { this.group.position.copy(p); }

  setRadius(r: number): void {
    if (Math.abs(r - this.radius) < 0.01) return;
    const s = r / this.radius;
    this.group.scale.setScalar(this.group.scale.x * s);
    this.radius = r;
  }

  /** `intensity` lifts the whole marker when the objective is contested. */
  update(dt: number, intensity: number): void {
    this.pulse += dt * (1.6 + intensity * 3.4);
    const s = 0.5 + 0.5 * Math.sin(this.pulse);
    this.ringMat.opacity = 0.55 + 0.4 * s + intensity * 0.2;
    this.columnMat.opacity = 0.055 + 0.045 * s + intensity * 0.05;
    this.innerMat.opacity = 0.022 + 0.02 * s + intensity * 0.02;
    this.arc.rotation.y = -this.pulse * 0.18;
    this.shadowMat.opacity = 0.42 + 0.14 * s;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ring.geometry.dispose();
    this.shadow.geometry.dispose();
    this.shadowMat.dispose();
    this.inner.geometry.dispose();
    this.column.geometry.dispose();
    this.arc.geometry.dispose();
    this.ringMat.dispose();
    this.innerMat.dispose();
    this.columnMat.dispose();
    this.arcMat.dispose();
    this.arc.dispose();
  }
}

/** Floating chevron used for "move here" waypoints and care-package drops. */
export class BeaconMarker {
  readonly group = new THREE.Group();
  private mat: THREE.MeshBasicMaterial;
  private mesh: THREE.Mesh;
  private halo: THREE.Mesh;
  private haloMat: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(color = 0x8fd4ff, size = 0.55) {
    this.mat = additive(color, 0.95);
    this.mesh = new THREE.Mesh(buildChevron(size), this.mat);
    this.haloMat = additive(color, 0.3);
    this.halo = new THREE.Mesh(new THREE.RingGeometry(size * 1.5, size * 1.75, 32, 1), this.haloMat);
    this.halo.rotation.x = -Math.PI / 2;
    for (const o of [this.mesh, this.halo]) {
      o.layers.set(LAYERS.TRANSPARENT);
      o.userData.noCollide = true;
      o.renderOrder = 9;
      this.group.add(o);
    }
    this.mesh.position.y = 1.9;
  }

  setColor(hex: number): void { this.mat.color.setHex(hex); this.haloMat.color.setHex(hex); }
  setPosition(p: THREE.Vector3): void { this.group.position.copy(p); }

  update(dt: number): void {
    this.t += dt;
    this.mesh.rotation.y += dt * 1.1;
    this.mesh.position.y = 1.9 + Math.sin(this.t * 2.1) * 0.16;
    this.mat.opacity = 0.7 + 0.3 * Math.sin(this.t * 3.4);
    const s = 1 + 0.06 * Math.sin(this.t * 2.6);
    this.halo.scale.setScalar(s);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.halo.geometry.dispose();
    this.mat.dispose();
    this.haloMat.dispose();
  }
}

/* ------------------------------------------------------------- geometry -- */

/** Open cylinder whose vertex alpha fades to zero at the top. */
function buildColumn(radius: number, height: number, radial: number): THREE.BufferGeometry {
  // Slight taper so the shaft reads as light rather than as a glass cylinder.
  const g = new THREE.CylinderGeometry(radius * 0.86, radius, height, radial, 1, true);
  g.translate(0, height / 2, 0);
  const pos = g.getAttribute('position');
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / height;
    // Bright at the base, gone by two-thirds up: reads as a shaft of light.
    const a = Math.pow(Math.max(0, 1 - y * 1.05), 2.6);
    colors[i * 4 + 0] = 1;
    colors[i * 4 + 1] = 1;
    colors[i * 4 + 2] = 1;
    colors[i * 4 + 3] = a;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  return g;
}

/** Downward-pointing chevron, four faces, no texture. */
function buildChevron(size: number): THREE.BufferGeometry {
  const h = size * 1.45;
  const w = size;
  const verts = new Float32Array([
    // four triangles from the apex to a square rim
    0, -h, 0, -w, 0, -w, w, 0, -w,
    0, -h, 0, w, 0, -w, w, 0, w,
    0, -h, 0, w, 0, w, -w, 0, w,
    0, -h, 0, -w, 0, w, -w, 0, -w,
    // rim cap so it reads from above too
    -w, 0, -w, w, 0, w, w, 0, -w,
    -w, 0, -w, -w, 0, w, w, 0, w,
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

function layoutArc(mesh: THREE.InstancedMesh, radius: number): void {
  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const a = (i / ARC_SEGMENTS) * Math.PI * 2 - Math.PI / 2;
    _p.set(Math.cos(a) * radius, 0.06, Math.sin(a) * radius);
    _q.setFromAxisAngle(_up, -a);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }
  mesh.instanceMatrix.needsUpdate = true;
}
