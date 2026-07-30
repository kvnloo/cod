/**
 * A stand-in weapon.
 *
 * The weapons module owns the real view models; this is the third-person prop a
 * character holds so its hands have something to grip, and so the character
 * module can be verified in isolation. It is built in *weapon space*: origin at
 * the pistol grip, +Z down the bore, +Y up — the same frame `Animator`'s carry
 * poses and grip offsets use.
 */

import * as THREE from 'three';
import { SkinMeshBuilder, SLOT, BIND } from './geom/Builder';
import { boneSegments, type RigInstance } from './Rig';
import type { CharacterMaterials } from './Materials';
import type { CharacterFaction } from './types';

export type PropKind = 'rifle' | 'smg' | 'lmg' | 'sniper' | 'shotgun';

interface Spec {
  barrel: number;
  handguard: number;
  stock: number;
  mag: number;
  optic: 'red-dot' | 'scope' | 'irons';
  drum: boolean;
}

const SPECS: Record<PropKind, Spec> = {
  rifle: { barrel: 0.30, handguard: 0.26, stock: 0.20, mag: 0.20, optic: 'red-dot', drum: false },
  smg: { barrel: 0.18, handguard: 0.18, stock: 0.15, mag: 0.22, optic: 'red-dot', drum: false },
  lmg: { barrel: 0.38, handguard: 0.30, stock: 0.22, mag: 0.16, optic: 'irons', drum: true },
  sniper: { barrel: 0.44, handguard: 0.30, stock: 0.26, mag: 0.14, optic: 'scope', drum: false },
  shotgun: { barrel: 0.34, handguard: 0.28, stock: 0.20, mag: 0.10, optic: 'irons', drum: false },
};

const DARK = new THREE.Color(0.20, 0.20, 0.21);
const POLY = new THREE.Color(0.26, 0.26, 0.25);
const STEEL = new THREE.Color(0.55, 0.56, 0.58);

/**
 * Builds the prop geometry. It reuses the character mesh builder purely for its
 * primitives; the resulting mesh is a plain `Mesh`, not skinned.
 */
export function buildWeaponProp(
  rig: RigInstance, materials: CharacterMaterials, faction: CharacterFaction, kind: PropKind = 'rifle',
): THREE.Object3D {
  const spec = SPECS[kind];
  const b = new SkinMeshBuilder(rig, boneSegments(rig));
  b.bind(BIND.chest);

  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  const tiltGrip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.22);
  const tiltMag = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.16);

  /* receiver */
  b.slot(SLOT.METAL).color(DARK);
  b.roundedBox(v.set(0, 0.062, 0.075), s.set(0.052, 0.082, 0.245), 0.010, 2);
  /* upper rail */
  b.color(DARK, 1.2);
  b.roundedBox(v.set(0, 0.106, 0.090), s.set(0.030, 0.012, 0.300), 0.004, 1);

  /* handguard with rail slots */
  b.slot(SLOT.HARD).color(POLY);
  b.roundedBox(v.set(0, 0.062, 0.075 + 0.122 + spec.handguard * 0.5), s.set(0.048, 0.058, spec.handguard), 0.012, 2);
  b.slot(SLOT.METAL).color(DARK, 0.9);
  for (let i = 0; i < 3; i++) {
    const z = 0.075 + 0.128 + spec.handguard * (0.2 + i * 0.28);
    b.roundedBox(v.set(0, 0.032, z), s.set(0.026, 0.010, 0.030), 0.003, 1);
  }

  /* barrel + muzzle device */
  b.slot(SLOT.METAL).color(STEEL, 0.55);
  const z0 = 0.075 + 0.122;
  b.cylinder(
    new THREE.Vector3(0, 0.062, z0),
    new THREE.Vector3(0, 0.062, z0 + spec.barrel),
    0.011, 0.0095, 10, true,
  );
  b.color(DARK, 1.1);
  b.cylinder(
    new THREE.Vector3(0, 0.062, z0 + spec.barrel - 0.01),
    new THREE.Vector3(0, 0.062, z0 + spec.barrel + 0.055),
    0.017, 0.016, 10, true,
  );

  /* pistol grip */
  b.slot(SLOT.HARD).color(POLY, 0.85);
  b.roundedBox(v.set(0, -0.055, -0.012), s.set(0.034, 0.115, 0.052), 0.014, 2, tiltGrip);

  /* trigger guard */
  b.slot(SLOT.METAL).color(DARK);
  b.roundedBox(v.set(0, -0.018, 0.042), s.set(0.024, 0.008, 0.070), 0.004, 1);

  /* magazine */
  b.slot(SLOT.HARD).color(POLY, 0.75);
  if (spec.drum) {
    b.roundedBox(v.set(0, -0.075, 0.115), s.set(0.075, 0.130, 0.130), 0.045, 3);
  } else {
    b.roundedBox(v.set(0, -0.020 - spec.mag * 0.5, 0.108), s.set(0.028, spec.mag, 0.075), 0.010, 2, tiltMag);
  }

  /* stock */
  b.slot(SLOT.METAL).color(DARK, 0.9);
  b.cylinder(
    new THREE.Vector3(0, 0.058, -0.048),
    new THREE.Vector3(0, 0.050, -0.048 - spec.stock * 0.55),
    0.017, 0.017, 8, true,
  );
  b.slot(SLOT.HARD).color(POLY, 0.9);
  b.roundedBox(v.set(0, 0.046, -0.048 - spec.stock * 0.62), s.set(0.042, 0.088, spec.stock * 0.62), 0.014, 2);
  b.roundedBox(v.set(0, 0.030, -0.048 - spec.stock * 0.95), s.set(0.046, 0.115, 0.030), 0.010, 2);

  /* optic */
  b.slot(SLOT.METAL).color(DARK, 1.05);
  if (spec.optic === 'scope') {
    b.cylinder(
      new THREE.Vector3(0, 0.150, 0.030),
      new THREE.Vector3(0, 0.150, 0.240),
      0.024, 0.028, 12, true,
    );
    b.roundedBox(v.set(0, 0.125, 0.060), s.set(0.024, 0.045, 0.030), 0.006, 1);
    b.roundedBox(v.set(0, 0.125, 0.190), s.set(0.024, 0.045, 0.030), 0.006, 1);
  } else if (spec.optic === 'red-dot') {
    b.roundedBox(v.set(0, 0.130, 0.115), s.set(0.036, 0.050, 0.075), 0.008, 2);
    b.roundedBox(v.set(0, 0.108, 0.115), s.set(0.030, 0.020, 0.045), 0.005, 1);
  } else {
    b.roundedBox(v.set(0, 0.126, 0.210), s.set(0.014, 0.036, 0.010), 0.003, 1);
    b.roundedBox(v.set(0, 0.126, 0.010), s.set(0.020, 0.032, 0.010), 0.003, 1);
  }

  /* sling loops */
  b.slot(SLOT.METAL).color(STEEL, 0.4);
  b.cylinder(new THREE.Vector3(-0.024, 0.062, -0.040), new THREE.Vector3(0.024, 0.062, -0.040), 0.005, 0.005, 6, true);

  const { geometry, slots } = b.build();
  geometry.deleteAttribute('skinIndex');
  geometry.deleteAttribute('skinWeight');
  const mats = slots.map((slot) => materials.get(slot as 0 | 1 | 2 | 3 | 4, faction));
  const mesh = new THREE.Mesh(geometry, mats);
  mesh.name = `weapon-prop:${kind}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
