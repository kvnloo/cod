/**
 * The combat facade killstreaks and objectives talk to.
 *
 * Anything that wants to hurt an enemy or ask where one is goes through here,
 * which keeps damage attribution in one place: the match sets the credited
 * source before the damage lands so the kill feed, scoring and XP all agree on
 * who did it.
 */

import type * as THREE from 'three';

export interface CombatBridge {
  /** Applies damage from a named source. Returns true when it was lethal. */
  damage(
    id: number, amount: number, source: string,
    point?: THREE.Vector3, direction?: THREE.Vector3,
  ): boolean;
  /** Radial damage to everything hostile in range, with square falloff. */
  explode(center: THREE.Vector3, radius: number, power: number, source: string): void;
  /** Nearest live hostile within `maxDist`; writes its position into `out`. */
  nearestEnemy(from: THREE.Vector3, maxDist: number, out?: THREE.Vector3): number;
  enemyPosition(id: number, out: THREE.Vector3): boolean;
  /** Live hostile positions written into `out` (grown as needed); returns count. */
  enemyPositions(out: THREE.Vector3[]): number;
  countWithin(center: THREE.Vector3, radius: number): number;
  /** Ground height under a point, used to place props; falls back to `fallback`. */
  groundAt(x: number, z: number, fallback: number): number;
}
