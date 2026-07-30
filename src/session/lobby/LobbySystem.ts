/**
 * `LobbySystem` — the engine wrapper.
 *
 * Plumbing only. It owns a `LobbySession`, ticks it on the variable step,
 * forwards everything onto the global bus, and connects the two ends the rest
 * of the game cares about:
 *
 *   `lobby:launch`   → the game layer starts a match with this config
 *   `match:summary`  → the lobby records the result and recycles the room
 *
 * It deliberately does **not** import `src/core/Engine` at runtime (`System` and
 * `EngineContext` come in as types, which erase), because that would drag
 * three.js and the DOM input singleton into a module that has to run headlessly
 * in node for `tools/session-lobby.mjs`.
 *
 * Registering it is one line in `src/main.ts`, which this agent does not own:
 *
 * ```ts
 * import { LobbySystem } from './session';
 * engine.add(new LobbySystem());
 * ```
 *
 * Until that line exists the system is inert but constructible, and the whole
 * lobby is still reachable through `globalThis.__BLACKOUT_LOBBY__`.
 */

import type { EngineContext, System } from '../../core/Engine';
import { bus } from '../../core/EventBus';
import { hashString } from '../../core/Rand';
import type {
  LobbyResult, LobbySettings, MatchConfig, PlayerId, PlayerProfile, SessionEmitter, SessionTeam,
} from '../types';
import { makeProfile } from '../types';
import { LobbySession } from './LobbySession';
import { PartyRegistry, browserPartyStore } from './Party';
import { soloTransport, type LobbyTransport } from './Transport';
import type { LobbyCatalog } from './Catalog';
import './events';
import '../../game/events';

/**
 * Runs just before `ORDER.GAMEPLAY` (500) so a launch decided this frame is
 * visible to the director in the same frame. Not imported from `ORDER` on
 * purpose — see the note at the top of this file.
 */
export const LOBBY_ORDER = 490;

const PLAYER_ID_KEY = 'blackout.playerId';

/** A stable local identity, persisted so a reload rejoins as the same person. */
export function localPlayerId(): PlayerId {
  try {
    const store = globalThis.localStorage;
    const existing = store?.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    const seed = `${Date.now()}:${globalThis.location?.href ?? 'headless'}`;
    const id = `plr_${(hashString(seed) >>> 4).toString(36)}`;
    store?.setItem(PLAYER_ID_KEY, id);
    return id;
  } catch {
    return 'plr_local';
  }
}

export interface LobbySystemOptions {
  profile?: PlayerProfile;
  /** Netcode transport. Defaults to the offline/solo loopback. */
  transport?: LobbyTransport;
  settings?: Partial<LobbySettings>;
  catalog?: LobbyCatalog;
  emit?: SessionEmitter;
  /** Create the lobby at `init`. Off in capture runs so shots stay untouched. */
  autoCreate?: boolean;
  seed?: number;
}

export class LobbySystem implements System {
  readonly name = 'lobby';
  readonly order = LOBBY_ORDER;

  session!: LobbySession;
  lastLaunch: MatchConfig | null = null;

  private opts: LobbySystemOptions;
  private offs: Array<() => void> = [];

  constructor(opts: LobbySystemOptions = {}) { this.opts = opts; }

  init(_ctx?: EngineContext): void {
    const id = this.opts.profile?.id ?? localPlayerId();
    const profile = this.opts.profile ?? makeProfile(id, 'Player');
    const parties = new PartyRegistry(browserPartyStore());
    parties.restorePersisted();

    this.session = new LobbySession({
      transport: this.opts.transport ?? soloTransport(id),
      profile,
      emit: this.opts.emit ?? ((key, payload) => bus.emit(key, payload)),
      catalog: this.opts.catalog,
      parties,
    });

    if (this.opts.autoCreate !== false) {
      this.session.create({ settings: this.opts.settings, seed: this.opts.seed });
      // Solo lobbies have nobody to wait for.
      this.session.ready(true);
    }

    this.offs.push(bus.on('lobby:launch', (config) => { this.lastLaunch = config; }));
    this.offs.push(bus.on('lobby:state', () => { parties.persist(id); }));
    this.offs.push(bus.on('match:summary', (summary) => this.onMatchSummary(summary)));

    (globalThis as unknown as { __BLACKOUT_LOBBY__?: LobbySystem }).__BLACKOUT_LOBBY__ = this;
  }

  update(dt: number, _ctx: EngineContext): void {
    this.session?.tick(dt);
  }

  /**
   * Closes the loop: a finished match feeds the lobby, which shows the
   * scoreboard and then re-forms with the same people.
   */
  private onMatchSummary(summary: { win: boolean; durationSec: number; score: number }): void {
    const state = this.session?.state;
    if (!state || !this.session.isHost) return;
    if (state.phase !== 'in-match' && state.phase !== 'loading') return;
    const mine = state.members.find((m) => m.id === this.session.localId)?.team ?? 'alpha';
    const other: SessionTeam = mine === 'bravo' ? 'alpha' : 'bravo';
    const result: LobbyResult = {
      matchIndex: state.matchesPlayed,
      mapId: state.selection.mapId,
      modeId: state.selection.modeId,
      winner: summary.win ? mine : other,
      alphaScore: mine === 'alpha' ? summary.score : 0,
      bravoScore: mine === 'bravo' ? summary.score : 0,
      durationSec: Math.round(summary.durationSec),
    };
    this.session.reportResult(result);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.session?.dispose();
  }
}
