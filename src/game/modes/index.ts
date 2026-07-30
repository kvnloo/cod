/**
 * The mode registry.
 *
 * A mode is a `ModeDef` (data) plus a rules object (behaviour); this is the one
 * place the two are married, so adding a mode is a definition in `ModeDefs.ts`
 * and one line here. `MatchRunner` is the only caller that needs `createMode`;
 * everything else — lobby, playlist, tooling, netcode — should enumerate
 * `MODE_CATALOG` and never construct a mode by hand.
 */

import { GameMode } from './Mode';
import { OperationMode } from './Operation';
import { FirefightMode } from './Firefight';
import { TeamDeathmatchMode } from './TeamDeathmatch';
import { DominationMode } from './Domination';
import { SearchAndDestroyMode } from './SearchAndDestroy';
import { HardpointMode } from './Hardpoint';
import { KillConfirmedMode } from './KillConfirmed';
import { FreeForAllMode } from './FreeForAll';
import { MODE_DEFS, type ModeDef, type ModeId } from './ModeDefs';

export type ModeFactory = () => GameMode;

const FACTORIES: Record<ModeId, ModeFactory> = {
  operation: () => new OperationMode(),
  firefight: () => new FirefightMode(),
  tdm: () => new TeamDeathmatchMode(),
  dom: () => new DominationMode(),
  snd: () => new SearchAndDestroyMode(),
  hardpoint: () => new HardpointMode(),
  kc: () => new KillConfirmedMode(),
  ffa: () => new FreeForAllMode(),
};

/** Unknown ids fall back to Operation, which is the only always-loadable mode. */
export function createMode(id: ModeId): GameMode {
  return (FACTORIES[id] ?? FACTORIES.operation)();
}

export function hasMode(id: string): id is ModeId {
  return Object.prototype.hasOwnProperty.call(FACTORIES, id);
}

export interface ModeCatalogEntry {
  id: ModeId;
  def: ModeDef;
  create: ModeFactory;
}

/** Everything playable, in playlist order. */
export const MODE_CATALOG: readonly ModeCatalogEntry[] =
  (['tdm', 'dom', 'snd', 'hardpoint', 'kc', 'ffa', 'operation', 'firefight'] as ModeId[])
    .map((id) => ({ id, def: MODE_DEFS[id], create: FACTORIES[id] }));

export { GameMode, type MatchHost, type ModeOffer } from './Mode';
export * from './ModeDefs';
export {
  TeamMode, type ModeOrder, type ModeState, type OrderKind, type RosterEntry,
  type RoundRecord, type RoundWinner, type Stage,
} from './TeamMode';
export { TeamDeathmatchMode } from './TeamDeathmatch';
export { DominationMode } from './Domination';
export { SearchAndDestroyMode } from './SearchAndDestroy';
export { HardpointMode } from './Hardpoint';
export { KillConfirmedMode, } from './KillConfirmed';
export { FreeForAllMode, type FfaStanding } from './FreeForAll';
