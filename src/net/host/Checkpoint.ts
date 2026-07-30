/**
 * Checkpoints: turning live authoritative state into something a *different*
 * machine can resume from.
 *
 * The rule this enforces: if it is not in the checkpoint, it does not survive
 * host migration. `verifyCheckpoint` exists so a standby refuses to promote on
 * state it received half-written, rather than resuming a corrupt match.
 */

import {
  fnv1a, type EntityState, type HostCheckpoint, type PlayerSlot,
  type RosterEntry, type WorldState,
} from './types';

function cloneEntity(e: EntityState): EntityState {
  return {
    id: e.id, kind: e.kind, owner: e.owner, team: e.team,
    px: e.px, py: e.py, pz: e.pz,
    vx: e.vx, vy: e.vy, vz: e.vz,
    yaw: e.yaw, pitch: e.pitch,
    health: e.health, armor: e.armor,
    weapon: e.weapon, ammo: e.ammo, flags: e.flags, respawnTick: e.respawnTick,
    nextFireTick: e.nextFireTick,
  };
}

function clonePlayer(p: PlayerSlot): PlayerSlot {
  return {
    clientId: p.clientId, stableId: p.stableId, name: p.name, team: p.team,
    entityId: p.entityId, score: p.score, kills: p.kills, deaths: p.deaths,
    lastAckedInputTick: p.lastAckedInputTick, connected: p.connected,
    lastSeenTick: p.lastSeenTick,
  };
}

/** Body used for the checksum — deterministic key order, no floats-as-strings surprises. */
function checkpointBody(cp: Omit<HostCheckpoint, 'checksum'>): string {
  const ents = cp.entities.map((e) => [
    e.id, e.kind, e.owner, e.team,
    round(e.px), round(e.py), round(e.pz),
    round(e.vx), round(e.vy), round(e.vz),
    round(e.yaw), round(e.pitch),
    e.health, e.armor, e.weapon, e.ammo, e.flags, e.respawnTick, e.nextFireTick,
  ].join(','));
  const players = cp.players.map((p) => [
    p.clientId, p.stableId, p.team, p.entityId, p.score, p.kills, p.deaths,
    p.lastAckedInputTick, p.connected ? 1 : 0,
  ].join(','));
  return [
    cp.epoch, cp.tick, cp.seed, cp.nextEntityId, cp.nextClientId,
    ents.join('|'), players.join('|'),
    JSON.stringify(cp.mode),
  ].join(';');
}

/** Quantise to 1e-4 so a checksum is not hostage to the last float bit. */
function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function exportCheckpoint(state: WorldState, roster: readonly RosterEntry[]): HostCheckpoint {
  const body: Omit<HostCheckpoint, 'checksum'> = {
    epoch: state.epoch,
    tick: state.tick,
    seed: state.seed,
    nextEntityId: state.nextEntityId,
    nextClientId: state.nextClientId,
    entities: [...state.entities.values()].sort((a, b) => a.id - b.id).map(cloneEntity),
    players: [...state.players.values()].sort((a, b) => a.clientId - b.clientId).map(clonePlayer),
    mode: { ...state.mode },
    roster: roster.map((r) => ({ ...r })),
  };
  return { ...body, checksum: fnv1a(checkpointBody(body)) };
}

export function verifyCheckpoint(cp: HostCheckpoint): boolean {
  if (!cp || !Array.isArray(cp.entities) || !Array.isArray(cp.players)) return false;
  if (!Number.isFinite(cp.tick) || !Number.isFinite(cp.epoch)) return false;
  const { checksum, ...body } = cp;
  return fnv1a(checkpointBody(body)) === checksum;
}

/** Rebuild live state from a checkpoint. Used by a promoted standby. */
export function importCheckpoint(cp: HostCheckpoint): WorldState {
  const state: WorldState = {
    tick: cp.tick,
    seed: cp.seed,
    epoch: cp.epoch,
    nextEntityId: cp.nextEntityId,
    nextClientId: cp.nextClientId,
    entities: new Map(),
    players: new Map(),
    mode: { ...cp.mode },
  };
  for (const e of cp.entities) state.entities.set(e.id, cloneEntity(e));
  for (const p of cp.players) state.players.set(p.clientId, clonePlayer(p));
  return state;
}

/** Deep copy of live state — used by tests and by the replay recorder. */
export function cloneWorldState(state: WorldState): WorldState {
  return importCheckpoint(exportCheckpoint(state, []));
}
