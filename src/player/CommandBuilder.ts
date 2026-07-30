/**
 * Turns raw local input into a `MoveCommand`.
 *
 * Everything client-preference-shaped is resolved *here*, on the client, and
 * never reaches the simulation: crouch/ADS toggle vs hold, auto-sprint, key
 * bindings. The server must produce identical movement for two players who press
 * the same physical buttons but configured their options differently, so the
 * command carries resolved *held* state only.
 *
 * Press edges are derived from the previous raw key state rather than
 * `input.pressed()`. `pressed()` stays true for a whole render frame, so at
 * 120 Hz simulation with a 60 Hz display it fires on two consecutive fixed
 * steps — which silently double-toggles crouch. Edge-from-held is both correct
 * and reproducible during replay.
 */

import { input } from '../core/Input';
import { settings } from '../core/Settings';
import { BTN, createMoveCommand, quantizeMoveCommand, type MoveCommand } from './MoveCommand';

export class CommandBuilder {
  /** Sequence of the next command produced. */
  seq = 0;
  /** Client's estimate of the server tick the next command lands on. */
  tick = 0;

  /** Latched toggle state. Persisted across respawns; cleared by `reset`. */
  crouchToggle = false;
  proneToggle = false;
  adsToggle = false;

  private prevCrouchKey = false;
  private prevProneKey = false;
  private prevAdsKey = false;
  private readonly cmd = createMoveCommand();

  /**
   * Produces the command for one fixed step and advances the sequence.
   * The returned object is reused — copy it if you need to keep it.
   */
  build(dt: number, yaw: number, pitch: number): MoveCommand {
    const s = input.state;
    const g = settings.game;

    const crouchKey = input.held('crouch');
    const crouchEdge = crouchKey && !this.prevCrouchKey;
    this.prevCrouchKey = crouchKey;
    if (g.toggleCrouch) { if (crouchEdge) this.crouchToggle = !this.crouchToggle; }
    else this.crouchToggle = crouchKey;

    const proneKey = input.held('prone');
    const proneEdge = proneKey && !this.prevProneKey;
    this.prevProneKey = proneKey;
    if (proneEdge) this.proneToggle = !this.proneToggle;
    if (this.proneToggle) this.crouchToggle = false;

    const adsKey = input.held('ads');
    const adsEdge = adsKey && !this.prevAdsKey;
    this.prevAdsKey = adsKey;
    if (g.toggleAds) { if (adsEdge) this.adsToggle = !this.adsToggle; }
    else this.adsToggle = adsKey;

    let buttons = 0;
    if (input.held('jump')) buttons |= BTN.JUMP;
    if (this.crouchToggle) buttons |= BTN.CROUCH;
    if (this.proneToggle) buttons |= BTN.PRONE;
    // Auto-sprint is a client option; the sim only ever sees "wants to sprint".
    if (input.held('sprint') || g.autoSprint) buttons |= BTN.SPRINT;
    if (this.adsToggle) buttons |= BTN.ADS;
    if (input.held('leanLeft')) buttons |= BTN.LEAN_L;
    if (input.held('leanRight')) buttons |= BTN.LEAN_R;
    if (input.held('fire')) buttons |= BTN.FIRE;
    if (input.held('reload')) buttons |= BTN.RELOAD;
    if (input.held('melee')) buttons |= BTN.MELEE;
    if (input.held('use')) buttons |= BTN.USE;
    if (input.held('grenade')) buttons |= BTN.GRENADE;
    if (input.held('tactical')) buttons |= BTN.TACTICAL;
    if (input.held('switchWeapon')) buttons |= BTN.SWITCH;

    const c = this.cmd;
    c.seq = this.seq++;
    c.tick = this.tick++;
    c.dt = dt;
    c.moveX = s.moveX;
    c.moveY = s.moveY;
    c.yaw = yaw;
    c.pitch = pitch;
    c.buttons = buttons;
    // Predict from the exact bits the host will decode.
    return quantizeMoveCommand(c);
  }

  /** Clears latched toggles and edge memory (respawn, menu, pointer unlock). */
  reset(): void {
    this.crouchToggle = false;
    this.proneToggle = false;
    this.adsToggle = false;
    this.prevCrouchKey = false;
    this.prevProneKey = false;
    this.prevAdsKey = false;
  }
}
