/**
 * The seam between the player system and the netcode.
 *
 * `PlayerSystem` knows nothing about networking. When a driver is attached it
 * hands over the movement step; when none is attached it samples local input and
 * runs the same step directly. That keeps single-player and offline builds
 * completely free of net code, and — more importantly — means the networked
 * path is not a fork of the local one, it is the local one with a different
 * source of commands.
 *
 * `src/net/prediction/ClientPrediction.ts` implements this.
 */

import type { MovementOutput } from './Movement';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PlayerNetDriver {
  /**
   * Advances the local player's movement by one fixed step, using whatever
   * command source the driver owns. Called from `PlayerSystem.fixedUpdate` in
   * place of `Movement.step`.
   */
  fixedStep(dt: number, yaw: number, pitch: number): MovementOutput;

  /** Called once per render frame to decay the visible correction. */
  updateVisual(dt: number): void;

  /**
   * World-space offset the camera should add so a simulation snap is not a
   * visual snap. Zero when the prediction is in agreement with the server.
   */
  readonly visualOffset: Vec3Like;
}
