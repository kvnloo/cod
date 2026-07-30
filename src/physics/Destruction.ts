/**
 * Destruction: debris chunks and glass shattering.
 *
 * Both paths are fully procedural — chunk geometry is generated from a seeded
 * RNG at spawn time and the meshes come from a recycled pool, so a firefight
 * that spawns two hundred chunks allocates nothing once the pool has warmed up.
 *
 * Chunks are built on fixed topologies (a jittered icosahedron for rubble, an
 * extruded quad for glass) rather than a general convex-hull mesher: the
 * topology is known ahead of time, so the visual mesh can never come out
 * degenerate, while Rapier still gets an exact `convexHull` collider from the
 * same points.
 *
 * Budget policy: a hard cap on live pieces, sleep detection, a lifetime and a
 * shrink-out tail. Asleep pieces are reclaimed first so the chunks the player is
 * actually watching survive longest.
 */

import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { Rand } from '../core/Rand';
import type { SurfaceType } from '../core/Surfaces';
import { surface as surfaceProps } from '../core/Surfaces';
import type { DebrisOptions, GlassShatterOptions } from './types';
import { LAYER } from './types';
import { groups, defaultMask } from './Layers';
import type { ColliderRegistry } from './Registry';

export interface DestructionHost {
  readonly world: RAPIER.World;
  readonly registry: ColliderRegistry;
  /** Scene node every debris mesh is parented to. */
  readonly debrisRoot: THREE.Group;
}

interface Piece {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  age: number;
  lifetime: number;
  sleepTime: number;
  alive: boolean;
}

/** Seconds of continuous sleep before a piece is retired early. */
const SLEEP_RETIRE = 3.5;
/** Length of the shrink-out tail. */
const FADE = 0.55;

const vTmp = new THREE.Vector3();
const vTmp2 = new THREE.Vector3();
const vNormal = new THREE.Vector3();
const vTangent = new THREE.Vector3();
const vBitangent = new THREE.Vector3();
const box = new THREE.Box3();
const rv = { x: 0, y: 0, z: 0 };

/* --------------------------------------------------------- chunk topology -- */

/** Unit icosahedron: 12 vertices, 20 outward-wound faces. */
const ICO_V = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
  ];
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const l = Math.hypot(raw[i], raw[i + 1], raw[i + 2]);
    out[i] = raw[i] / l; out[i + 1] = raw[i + 1] / l; out[i + 2] = raw[i + 2] / l;
  }
  return out;
})();

const ICO_F = new Uint16Array([
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
  1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
  4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
]);

/**
 * Extruded quad: 8 points laid out as (top₀, bottom₀, top₁, bottom₁, …) around a
 * four-corner ring. 12 triangles — two caps and four sides.
 */
const SHARD_F = new Uint16Array([
  0, 2, 4, 0, 4, 6,           // +Z cap
  1, 7, 5, 1, 5, 3,           // −Z cap
  0, 1, 3, 0, 3, 2,           // side 0→1
  2, 3, 5, 2, 5, 4,           // side 1→2
  4, 5, 7, 4, 7, 6,           // side 2→3
  6, 7, 1, 6, 1, 0,           // side 3→0
]);

export class DestructionSystem {
  /** Maximum simultaneous debris pieces. Driven by the quality preset. */
  budget = 220;

  private pieces: Piece[] = [];
  private geometryPool: THREE.BufferGeometry[] = [];
  private meshPool: THREE.Mesh[] = [];
  private materials = new Map<SurfaceType, THREE.Material>();
  private seedCounter = 1;
  private points = new Float32Array(12 * 3);
  private soup = new Float32Array(20 * 3 * 3);

  constructor(private host: DestructionHost) { }

  get count(): number { return this.pieces.length; }

  /* ------------------------------------------------------------------ debris */

  /**
   * Spawns convex chunks at `point`, thrown along `normal` in a cone.
   * `source` supplies the material and, for meshes, the chunk scale.
   * Returns the number of chunks actually created.
   */
  spawnDebris(
    point: THREE.Vector3, normal: THREE.Vector3, source: THREE.Object3D | null,
    opts: DebrisOptions = {},
  ): number {
    const tag: SurfaceType = opts.surface
      ?? (source?.userData?.surface as SurfaceType | undefined)
      ?? 'concrete';
    const props = surfaceProps(tag);
    if (props.debris <= 0) return 0;

    const seed = opts.seed ?? hashPoint(point, this.seedCounter++);
    const rand = new Rand(seed);

    let size = opts.size ?? 0;
    if (size <= 0) {
      size = 0.06;
      const mesh = source as THREE.Mesh | null;
      if (mesh?.isMesh && mesh.geometry) {
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        if (bb) {
          box.copy(bb).applyMatrix4(mesh.matrixWorld);
          box.getSize(vTmp);
          size = THREE.MathUtils.clamp(Math.min(vTmp.x, vTmp.y, vTmp.z) * 0.14, 0.025, 0.22);
        }
      }
    }

    const wanted = Math.max(1, Math.round((opts.count ?? 6) * props.debris));
    if (this.pieces.length >= this.budget + 8) return 0;
    const count = Math.min(wanted, 24);
    this.enforceBudget(count);

    vNormal.copy(normal);
    if (vNormal.lengthSq() < 1e-8) vNormal.set(0, 1, 0);
    vNormal.normalize();
    basisFromNormal(vNormal, vTangent, vBitangent);

    const material = this.materialFor(tag, source);
    const speed = opts.speed ?? 3.4;
    const lifetime = opts.lifetime ?? 9;
    const parent = opts.parent ?? this.host.debrisRoot;

    let made = 0;
    for (let i = 0; i < count; i++) {
      const scale = size * rand.range(0.45, 1.3);
      const jx = rand.signed() * size, jy = rand.signed() * size, jz = rand.signed() * size;
      const px = point.x + vNormal.x * scale * 0.7 + vTangent.x * jx + vBitangent.x * jy;
      const py = point.y + vNormal.y * scale * 0.7 + vTangent.y * jx + vBitangent.y * jy;
      const pz = point.z + vNormal.z * scale * 0.7 + vTangent.z * jx + vBitangent.z * jy;
      void jz;

      // Cone about the surface normal, biased outward and a little upward.
      vTmp.copy(vNormal)
        .addScaledVector(vTangent, rand.signed() * 0.65)
        .addScaledVector(vBitangent, rand.signed() * 0.65)
        .normalize()
        .multiplyScalar(speed * rand.range(0.4, 1.25));
      vTmp.y += 1.2 * rand.next();
      if (opts.inherit) vTmp.add(opts.inherit);

      this.buildChunkPoints(rand, scale);
      const piece = this.makePiece(this.points, ICO_F, tag, material, parent, props.density);
      if (!piece) break;
      piece.lifetime = lifetime * rand.range(0.75, 1.25);

      rv.x = px; rv.y = py; rv.z = pz;
      piece.body.setTranslation(rv, false);
      rv.x = vTmp.x; rv.y = vTmp.y; rv.z = vTmp.z;
      piece.body.setLinvel(rv, true);
      rv.x = rand.signed() * 20; rv.y = rand.signed() * 20; rv.z = rand.signed() * 20;
      piece.body.setAngvel(rv, true);
      made++;
    }
    return made;
  }

  /* ------------------------------------------------------------------- glass */

  /**
   * Shatters a pane into radial shards.
   *
   * The pane's local XY plane is diced into a jittered polar grid centred on the
   * impact — the classic radial-plus-concentric crack pattern — and each cell is
   * extruded into a thin prism. Shards inherit the pane's own material so the
   * break is seamless with what was on screen the frame before.
   */
  shatterGlass(pane: THREE.Mesh, opts: GlassShatterOptions): number {
    if (!pane.geometry || (pane.userData as Record<string, unknown>).shattered) return 0;
    pane.updateWorldMatrix(true, false);
    pane.geometry.computeBoundingBox();
    const bb = pane.geometry.boundingBox;
    if (!bb) return 0;

    const size = bb.getSize(vTmp).clone();
    const centre = bb.getCenter(vTmp2).clone();
    const halfW = Math.max(0.02, size.x * 0.5);
    const halfH = Math.max(0.02, size.y * 0.5);
    const thickness = Math.max(0.004, size.z * 0.5);

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    pane.matrixWorld.decompose(worldPos, worldQuat, worldScale);

    const local = new THREE.Vector3().copy(opts.point);
    pane.worldToLocal(local);
    const ix = THREE.MathUtils.clamp(local.x - centre.x, -halfW * 0.9, halfW * 0.9);
    const iy = THREE.MathUtils.clamp(local.y - centre.y, -halfH * 0.9, halfH * 0.9);

    const rand = new Rand(opts.seed ?? hashPoint(opts.point, 7919));
    const rings = 3;
    const sectors = Math.max(6, Math.min(18, opts.shards ?? 12));
    const maxR = Math.hypot(halfW, halfH) * 1.2;
    const power = opts.power ?? 1;

    const material = (Array.isArray(pane.material) ? pane.material[0] : pane.material)
      ?? this.materialFor('glass', pane);

    const cells = Math.min(rings * sectors, 48);
    this.enforceBudget(cells);

    const dirLocal = new THREE.Vector3().copy(opts.direction);
    if (dirLocal.lengthSq() < 1e-8) dirLocal.set(0, 0, -1);
    dirLocal.applyQuaternion(worldQuat.clone().invert()).normalize();

    const radii: number[] = [0.015];
    for (let r = 1; r <= rings; r++) {
      radii.push(maxR * Math.pow(r / rings, 0.7) * rand.range(0.85, 1.18));
    }

    const pts = new Float32Array(8 * 3);
    let made = 0;
    for (let r = 0; r < rings && made < cells; r++) {
      const r0 = radii[r];
      const r1 = radii[r + 1];
      for (let s = 0; s < sectors && made < cells; s++) {
        const a0 = (s / sectors) * Math.PI * 2 + rand.signed() * 0.08;
        const a1 = ((s + 1) / sectors) * Math.PI * 2 + rand.signed() * 0.08;

        const corners: Array<[number, number]> = [[r0, a0], [r1, a0], [r1, a1], [r0, a1]];
        let cxx = 0, cyy = 0, n = 0;
        for (const [rr, aa] of corners) {
          const x = THREE.MathUtils.clamp(ix + Math.cos(aa) * rr, -halfW, halfW);
          const y = THREE.MathUtils.clamp(iy + Math.sin(aa) * rr, -halfH, halfH);
          cxx += x; cyy += y;
          pts[n++] = x; pts[n++] = y; pts[n++] = thickness;
          pts[n++] = x; pts[n++] = y; pts[n++] = -thickness;
        }
        cxx *= 0.25; cyy *= 0.25;
        for (let k = 0; k < 8; k++) { pts[k * 3] -= cxx; pts[k * 3 + 1] -= cyy; }

        // Reject slivers: a degenerate cell makes a bad hull and a worse shard.
        if (quadArea(pts) < 1e-4) continue;

        const piece = this.makePiece(pts, SHARD_F, 'glass', material, this.host.debrisRoot, 2500);
        if (!piece) break;
        piece.lifetime = 7 + rand.next() * 4;

        vTmp.set(centre.x + cxx, centre.y + cyy, centre.z)
          .multiply(worldScale).applyQuaternion(worldQuat).add(worldPos);
        rv.x = vTmp.x; rv.y = vTmp.y; rv.z = vTmp.z;
        piece.body.setTranslation(rv, false);
        piece.body.setRotation({ x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w }, false);

        const dcx = cxx - ix, dcy = cyy - iy;
        const d = Math.hypot(dcx, dcy) + 1e-3;
        const falloff = THREE.MathUtils.clamp(1 - d / maxR, 0.12, 1);
        vTmp.set(
          dirLocal.x * 2.4 * power * falloff + (dcx / d) * 1.7 * falloff,
          dirLocal.y * 2.4 * power * falloff + (dcy / d) * 1.7 * falloff,
          dirLocal.z * 2.4 * power * falloff,
        ).applyQuaternion(worldQuat);
        vTmp.y += rand.range(-0.4, 0.9);
        rv.x = vTmp.x; rv.y = vTmp.y; rv.z = vTmp.z;
        piece.body.setLinvel(rv, true);
        rv.x = rand.signed() * 9; rv.y = rand.signed() * 9; rv.z = rand.signed() * 9;
        piece.body.setAngvel(rv, true);
        made++;
      }
    }

    pane.visible = false;
    (pane.userData as Record<string, unknown>).shattered = true;
    return made;
  }

  /* ------------------------------------------------------------------ pieces */

  /** Jittered ellipsoid points — irregular but always a valid convex hull. */
  private buildChunkPoints(rand: Rand, scale: number): void {
    const sx = rand.range(0.55, 1.0), sy = rand.range(0.5, 1.0), sz = rand.range(0.55, 1.0);
    for (let i = 0; i < 12; i++) {
      const j = rand.range(0.62, 1.0) * scale;
      this.points[i * 3] = ICO_V[i * 3] * j * sx;
      this.points[i * 3 + 1] = ICO_V[i * 3 + 1] * j * sy;
      this.points[i * 3 + 2] = ICO_V[i * 3 + 2] * j * sz;
    }
  }

  private makePiece(
    points: Float32Array, faces: Uint16Array, tag: SurfaceType,
    material: THREE.Material, parent: THREE.Object3D, density: number,
  ): Piece | null {
    const desc = RAPIER.ColliderDesc.convexHull(points);
    if (!desc) return null;

    const props = surfaceProps(tag);
    const body = this.host.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setLinearDamping(0.06)
        .setAngularDamping(0.35)
        .setSoftCcdPrediction(0.2)
        .setCanSleep(true),
    );

    desc.setFriction(props.friction)
      .setRestitution(props.restitution)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      .setDensity(THREE.MathUtils.clamp(density, 200, 2600))
      .setCollisionGroups(groups(LAYER.DYNAMIC, defaultMask(LAYER.DYNAMIC)))
      .setContactSkin(0.001);
    const collider = this.host.world.createCollider(desc, body);

    const geometry = this.geometryFor(points, faces);
    const mesh = this.meshPool.pop() ?? new THREE.Mesh(geometry, material);
    mesh.geometry = geometry;
    mesh.material = material;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.visible = true;
    mesh.scale.set(1, 1, 1);
    parent.add(mesh);

    this.host.registry.add({
      handle: collider.handle,
      bodyId: -1,
      object: mesh,
      surface: tag,
      entityId: -1,
      zone: 'none',
      layer: LAYER.DYNAMIC,
      ranges: null,
      ragdollId: -1,
      debris: true,
    });

    const piece: Piece = {
      body, collider, mesh, geometry,
      age: 0, lifetime: 8, sleepTime: 0, alive: true,
    };
    this.pieces.push(piece);
    return piece;
  }

  /** De-indexes a fixed topology into a flat soup and fixes face winding. */
  private geometryFor(points: Float32Array, faces: Uint16Array): THREE.BufferGeometry {
    const need = faces.length * 3;
    if (this.soup.length < need) this.soup = new Float32Array(need);
    const soup = this.soup;
    for (let f = 0, o = 0; f < faces.length; f++) {
      const i = faces[f] * 3;
      soup[o++] = points[i]; soup[o++] = points[i + 1]; soup[o++] = points[i + 2];
    }
    orientOutward(soup, need);

    const geo = this.geometryPool.pop() ?? new THREE.BufferGeometry();
    const attr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr && attr.count === need / 3) {
      (attr.array as Float32Array).set(soup.subarray(0, need));
      attr.needsUpdate = true;
    } else {
      geo.setAttribute('position', new THREE.BufferAttribute(soup.slice(0, need), 3));
    }
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    geo.setDrawRange(0, need / 3);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  private materialFor(tag: SurfaceType, source: THREE.Object3D | null): THREE.Material {
    const mesh = source as THREE.Mesh | null;
    if (mesh?.isMesh) {
      const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (m) return m;
    }
    let m = this.materials.get(tag);
    if (!m) {
      const props = surfaceProps(tag);
      const glassy = tag === 'glass' || tag === 'glassThick';
      m = new THREE.MeshStandardMaterial({
        color: DEBRIS_TINT[tag] ?? 0x8b8880,
        roughness: THREE.MathUtils.clamp(1 - props.reflectivity * 0.7, 0.18, 0.98),
        metalness: tag.startsWith('metal') || tag === 'pipe' ? 0.9 : 0.0,
        transparent: glassy,
        opacity: glassy ? 0.4 : 1,
        side: THREE.DoubleSide,
      });
      this.materials.set(tag, m);
    }
    return m;
  }

  /* ------------------------------------------------------------------ update */

  fixedUpdate(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      if (p.body.isSleeping()) p.sleepTime += dt; else p.sleepTime = 0;
      const over = Math.max(p.age - p.lifetime, p.sleepTime - SLEEP_RETIRE);
      if (over > FADE) {
        this.release(p);
        this.pieces.splice(i, 1);
      }
    }
  }

  /** Presentation sync: drives the debris meshes from their bodies. */
  update(): void {
    for (const p of this.pieces) {
      const t = p.body.translation();
      const r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const over = Math.max(p.age - p.lifetime, p.sleepTime - SLEEP_RETIRE);
      // Shrink out rather than fade: no per-piece material clone needed.
      p.mesh.scale.setScalar(over > 0 ? Math.max(0.001, 1 - over / FADE) : 1);
    }
  }

  applyExplosion(centre: THREE.Vector3, radius: number, power: number): void {
    for (const p of this.pieces) {
      const t = p.body.translation();
      vTmp.set(t.x - centre.x, t.y - centre.y, t.z - centre.z);
      const d = vTmp.length();
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      if (d < 1e-4) vTmp.set(0, 1, 0); else vTmp.multiplyScalar(1 / d);
      vTmp.y += 0.4;
      vTmp.normalize().multiplyScalar(power * falloff * falloff * 0.05);
      rv.x = vTmp.x; rv.y = vTmp.y; rv.z = vTmp.z;
      p.body.applyImpulse(rv, true);
    }
  }

  clear(): void {
    for (const p of this.pieces) this.release(p);
    this.pieces.length = 0;
  }

  private enforceBudget(incoming: number): void {
    let over = this.pieces.length + incoming - this.budget;
    if (over <= 0) return;
    // Reclaim asleep pieces first, then the oldest.
    this.pieces.sort((a, b) => (b.sleepTime - a.sleepTime) || (b.age - a.age));
    while (over > 0 && this.pieces.length > 0) {
      const p = this.pieces.shift();
      if (!p) break;
      this.release(p);
      over--;
    }
  }

  private release(p: Piece): void {
    if (!p.alive) return;
    p.alive = false;
    this.host.registry.remove(p.collider.handle);
    if (this.host.world.bodies.contains(p.body.handle)) {
      this.host.world.removeRigidBody(p.body);
    }
    p.mesh.removeFromParent();
    p.mesh.visible = false;
    if (this.geometryPool.length < 128) this.geometryPool.push(p.geometry);
    else p.geometry.dispose();
    if (this.meshPool.length < 128) this.meshPool.push(p.mesh);
  }

  dispose(): void {
    this.clear();
    for (const g of this.geometryPool) g.dispose();
    this.geometryPool.length = 0;
    this.meshPool.length = 0;
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}

/* -------------------------------------------------------------------- utils */

const DEBRIS_TINT: Partial<Record<SurfaceType, number>> = {
  concrete: 0x9a968d, brick: 0x8b4b39, stone: 0x8b8981, plaster: 0xcac4b7,
  tile: 0xb8bbbc, metal: 0x8c8f95, metalThin: 0x7c8187, wood: 0x8a6742,
  plywood: 0xb8915b, crate: 0x9b7744, glass: 0xbcd8e6, glassThick: 0xa9c6d6,
  dirt: 0x6a5944, sand: 0xbea77c, gravel: 0x76726b, asphalt: 0x3b3c3f,
  plastic: 0xb0b3b6, cardboard: 0xa98a5f, ice: 0xd4e8f2,
};

/** Deterministic seed derived from a world position. */
function hashPoint(p: THREE.Vector3, salt: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ Math.round(p.x * 128), 16777619);
  h = Math.imul(h ^ Math.round(p.y * 128), 16777619);
  h = Math.imul(h ^ Math.round(p.z * 128), 16777619);
  h = Math.imul(h ^ salt, 16777619);
  return h >>> 0;
}

/** Orthonormal basis around `n`. */
function basisFromNormal(n: THREE.Vector3, t: THREE.Vector3, b: THREE.Vector3): void {
  if (Math.abs(n.y) < 0.92) t.set(0, 1, 0); else t.set(1, 0, 0);
  b.copy(n).cross(t).normalize();
  t.copy(b).cross(n).normalize();
}

/** Projected area of the four-corner ring in an extruded-quad point set. */
function quadArea(pts: Float32Array): number {
  let a = 0;
  for (let k = 0; k < 4; k++) {
    const i = k * 6, j = ((k + 1) % 4) * 6;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(a) * 0.5;
}

/**
 * Flips triangles whose normal points at the centroid. The topologies here are
 * fixed, but jittering their vertices can invert a face; a cheap orientation
 * pass is far more robust than trusting the winding to survive.
 */
function orientOutward(soup: Float32Array, count: number): void {
  let cx = 0, cy = 0, cz = 0;
  const verts = count / 3;
  for (let i = 0; i < count; i += 3) { cx += soup[i]; cy += soup[i + 1]; cz += soup[i + 2]; }
  cx /= verts; cy /= verts; cz /= verts;

  for (let f = 0; f < count; f += 9) {
    const ax = soup[f], ay = soup[f + 1], az = soup[f + 2];
    const e1x = soup[f + 3] - ax, e1y = soup[f + 4] - ay, e1z = soup[f + 5] - az;
    const e2x = soup[f + 6] - ax, e2y = soup[f + 7] - ay, e2z = soup[f + 8] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (nx * (cx - ax) + ny * (cy - ay) + nz * (cz - az) > 0) {
      const t0 = soup[f + 3], t1 = soup[f + 4], t2 = soup[f + 5];
      soup[f + 3] = soup[f + 6]; soup[f + 4] = soup[f + 7]; soup[f + 5] = soup[f + 8];
      soup[f + 6] = t0; soup[f + 7] = t1; soup[f + 8] = t2;
    }
  }
}
