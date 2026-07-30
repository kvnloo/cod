/**
 * The authority's movement step — the *same* movement the client predicts.
 *
 * The host loop (src/net/host) is deliberately gameplay-agnostic: it owns the
 * tick, the entity table, spawns and the damage ledger, and delegates "how does
 * a body move" to a `SimStepper`. Its built-in `ArenaSim` is a placeholder that
 * integrates a simplified capsule so the host could be tested before movement
 * existed. Shipping that would be the classic desync bug: two movement models,
 * one on each side of the wire, drifting apart on every slope and every slide.
 *
 * This stepper plugs the real `Movement` state machine into that seam. Client
 * and host then run byte-identical code over byte-identical commands, and any
 * disagreement left is float noise, which is what the reconciler's tolerance is
 * for. Prediction is only honest if the thing being predicted is the thing being
 * simulated.
 *
 *   const stepper = new MovementStepper({
 *     tickRate: 64,
 *     createMovement: () => { const m = new Movement(); m.attach(physics); return m; },
 *   });
 *   new PeerHost({ ..., sim: stepper });
 *
 * `Movement` itself is never imported here: the caller injects a factory. That
 * keeps this file free of THREE and of Rapier, so a headless Node host can
 * supply a physics implementation of its own choosing, and so the unit tests can
 * run without a GPU or a wasm build.
 */

import { createMoveCommand, BTN, type MoveCommand } from '../../player/MoveCommand';
import { createMovementState, type MovementState } from '../../player/MovementState';
import type { RandomStream, SimOps, SimStepper } from '../host/ports';
import {
  ENT, ENTITY_FLAG,
  type ClientId, type EntityState, type InputCommand, type WorldState,
} from '../host/types';
import { fromHostInput, movementStateFromEntity, writeEntityFromMovement } from './HostBridge';
import type { MovementSim } from './types';

/** Buttons that mean "the instant it went down", not "it is being held". */
const EDGE_TRIGGERED = BTN.JUMP | BTN.FIRE | BTN.MELEE | BTN.RELOAD
  | BTN.USE | BTN.GRENADE | BTN.TACTICAL | BTN.SWITCH;

export interface MovementStepperOptions {
  /** Ticks per second. Must match the authority's `AuthorityConfig.tickRate`. */
  tickRate?: number;
  /** Builds a movement simulation for one player. One instance per player. */
  createMovement: (clientId: ClientId, entityId: number) => MovementSim;
  /** Tear-down hook when a player leaves, e.g. to free a physics controller. */
  disposeMovement?: (sim: MovementSim, clientId: ClientId) => void;
  /** Places a freshly spawned player. Must be deterministic — use `rand`. */
  placeSpawn?: (state: WorldState, ent: EntityState, rand: RandomStream) => void;
  /**
   * Runs after a player's movement for that tick, with the command that drove
   * it. This is where weapons/abilities hook in without forking the loop.
   */
  onPlayerStepped?: (
    ent: EntityState, cmd: MoveCommand, sim: MovementSim, ops: SimOps, state: WorldState,
  ) => void;
}

interface PlayerMovement {
  sim: MovementSim;
  entityId: number;
  scratch: MovementState;
  lastCmd: MoveCommand;
  hasCmd: boolean;
  lastSeq: number;
  /** Set when the authority moved the entity behind our back (spawn/respawn). */
  reseed: boolean;
  /** Ticks this player supplied no input and we had to extrapolate. */
  starvedTicks: number;
}

export interface MovementStepperStats {
  players: number;
  ticksStepped: number;
  commandsExecuted: number;
  starvedTicks: number;
  reseeds: number;
}

export class MovementStepper implements SimStepper {
  readonly name = 'movement';
  readonly dt: number;
  readonly stats: MovementStepperStats = {
    players: 0, ticksStepped: 0, commandsExecuted: 0, starvedTicks: 0, reseeds: 0,
  };

  private readonly players = new Map<ClientId, PlayerMovement>();
  private readonly opts: MovementStepperOptions;

  constructor(opts: MovementStepperOptions) {
    this.opts = opts;
    this.dt = 1 / (opts.tickRate ?? 64);
  }

  /** Deterministic spawn placement, then bind a movement sim to the entity. */
  spawnPlayer(state: WorldState, ent: EntityState, rand: RandomStream): void {
    if (this.opts.placeSpawn) {
      this.opts.placeSpawn(state, ent, rand);
    } else {
      // Ring spawn. Seeded RNG only — never Math.random, or replay dies.
      const angle = rand.range(0, Math.PI * 2);
      const radius = rand.range(6, 12);
      ent.px = Math.cos(angle) * radius;
      ent.py = 1;
      ent.pz = Math.sin(angle) * radius;
      ent.vx = 0; ent.vy = 0; ent.vz = 0;
      ent.yaw = Math.atan2(-ent.px, -ent.pz);
      ent.pitch = 0;
    }
    ent.flags &= ~ENTITY_FLAG.DEAD;
    const rec = this.players.get(ent.owner);
    if (rec) rec.reseed = true;
  }

  step(
    state: WorldState,
    commands: ReadonlyMap<ClientId, InputCommand>,
    _rand: RandomStream,
    ops: SimOps,
  ): void {
    this.stats.ticksStepped++;

    for (const [clientId, slot] of state.players) {
      if (!slot.connected) continue;
      const ent = state.entities.get(slot.entityId);
      if (!ent || ent.kind !== ENT.PLAYER) continue;

      const rec = this.ensure(clientId, ent);

      if ((ent.flags & ENTITY_FLAG.DEAD) !== 0) {
        // A corpse does not run the state machine, but it must not resume from
        // stale state either: re-seed from the entity when it comes back.
        rec.reseed = true;
        rec.hasCmd = false;
        continue;
      }

      if (rec.reseed || rec.entityId !== slot.entityId) {
        rec.entityId = slot.entityId;
        movementStateFromEntity(ent, rec.scratch);
        rec.sim.restore(rec.scratch);
        rec.reseed = false;
        rec.hasCmd = false;
        this.stats.reseeds++;
      }

      const input = commands.get(clientId);
      const cmd = rec.lastCmd;
      if (input) {
        fromHostInput(input, this.dt, cmd);
        rec.lastSeq = input.seq;
        rec.hasCmd = true;
        this.stats.commandsExecuted++;
      } else {
        // Starvation: hold the last look and movement, but never re-fire an
        // edge. Repeating a jump bit would give a lagging client free bhops.
        if (!rec.hasCmd) {
          cmd.moveX = 0; cmd.moveY = 0; cmd.buttons = 0;
          cmd.yaw = ent.yaw; cmd.pitch = ent.pitch;
          rec.hasCmd = true;
        }
        cmd.buttons &= ~EDGE_TRIGGERED;
        cmd.seq = rec.lastSeq;
        cmd.dt = this.dt;
        rec.starvedTicks++;
        this.stats.starvedTicks++;
      }
      cmd.tick = state.tick;

      rec.sim.stepCommand(cmd);
      rec.sim.capture(rec.scratch);
      writeEntityFromMovement(ent, rec.scratch, cmd.pitch);

      this.opts.onPlayerStepped?.(ent, cmd, rec.sim, ops, state);
    }
  }

  /** The live movement sim for a player — lag compensation rewinds through it. */
  simFor(clientId: ClientId): MovementSim | undefined {
    return this.players.get(clientId)?.sim;
  }

  /** Authoritative movement state for a player, or null if unknown. */
  capture(clientId: ClientId, out?: MovementState): MovementState | null {
    const rec = this.players.get(clientId);
    if (!rec) return null;
    return rec.sim.capture(out ?? createMovementState());
  }

  /** Last input sequence this player actually had executed. */
  lastExecutedSeq(clientId: ClientId): number {
    return this.players.get(clientId)?.lastSeq ?? -1;
  }

  /** Ticks this player has been extrapolated through for want of input. */
  starvedTicks(clientId: ClientId): number {
    return this.players.get(clientId)?.starvedTicks ?? 0;
  }

  /** Drop a player's movement sim. Safe to call for an unknown client. */
  release(clientId: ClientId): void {
    const rec = this.players.get(clientId);
    if (!rec) return;
    this.players.delete(clientId);
    this.stats.players = this.players.size;
    this.opts.disposeMovement?.(rec.sim, clientId);
  }

  /** Drop every player. Called on match teardown and before host migration. */
  dispose(): void {
    for (const [clientId, rec] of this.players) this.opts.disposeMovement?.(rec.sim, clientId);
    this.players.clear();
    this.stats.players = 0;
  }

  private ensure(clientId: ClientId, ent: EntityState): PlayerMovement {
    let rec = this.players.get(clientId);
    if (rec) return rec;
    const sim = this.opts.createMovement(clientId, ent.id);
    sim.emitEvents = false; // The host has no speakers and no HUD.
    rec = {
      sim,
      entityId: ent.id,
      scratch: createMovementState(),
      lastCmd: createMoveCommand(),
      hasCmd: false,
      lastSeq: -1,
      reseed: true,
      starvedTicks: 0,
    };
    this.players.set(clientId, rec);
    this.stats.players = this.players.size;
    return rec;
  }
}
