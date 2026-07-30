/**
 * `LobbySession` — one peer's view of the lobby, host or not.
 *
 * This is the object the rest of the game holds. It hides the only thing the
 * caller must never get wrong: *am I allowed to write this?* Call `submit()`
 * and it does the right thing — apply locally when we are the host, put it on
 * the wire when we are not. Read `state` and you get the last authoritative
 * snapshot either way.
 *
 * Migration is handled here rather than in `LobbyHost` because it is a change
 * of *role*, not of state. The host broadcasts a full `LobbySnapshot` on a slow
 * timer; when the transport reports that authority moved to us, we rebuild a
 * host from the newest snapshot we hold and carry on. Every peer runs the same
 * election over data it already has (see `Migration.ts`), so there is no
 * handshake to lose.
 */

import type {
  LobbyId, LobbyResult, LobbySettings, LobbySnapshot, LobbyState, PlayerId, PlayerProfile,
  RoomCode, SessionEmitter,
} from '../types';
import { nullEmitter } from '../types';
import type { LobbyCatalog } from './Catalog';
import { LobbyHost, type LobbyHostOptions } from './Lobby';
import { PartyRegistry } from './Party';
import { pickSuccessor, shouldAdopt, snapshotFromState } from './Migration';
import { normalizeRoomCode } from './RoomCode';
import type { CommandResult, LobbyCommand } from './Commands';
import { fail, OK } from './Commands';
import type { LobbyMessage, LobbyTransport } from './Transport';
import './events';

export interface LobbySessionOptions {
  transport: LobbyTransport;
  profile: PlayerProfile;
  emit?: SessionEmitter;
  catalog?: LobbyCatalog;
  parties?: PartyRegistry;
  /** Seconds between full snapshot broadcasts. Cheap insurance for migration. */
  snapshotIntervalSec?: number;
}

export class LobbySession {
  readonly localId: PlayerId;
  readonly parties: PartyRegistry;
  profile: PlayerProfile;

  private transport: LobbyTransport;
  private emit: SessionEmitter;
  private catalog: LobbyCatalog | undefined;
  private hostImpl: LobbyHost | null = null;
  private remote: LobbyState | null = null;
  private lastSnapshot: LobbySnapshot | null = null;
  private snapshotTimer = 0;
  private snapshotInterval: number;
  private offs: Array<() => void> = [];
  private disposed = false;

  constructor(opts: LobbySessionOptions) {
    this.transport = opts.transport;
    this.localId = opts.transport.localId;
    this.profile = { ...opts.profile, id: opts.transport.localId };
    this.emit = opts.emit ?? nullEmitter;
    this.catalog = opts.catalog;
    this.parties = opts.parties ?? new PartyRegistry();
    this.snapshotInterval = opts.snapshotIntervalSec ?? 2;

    this.offs.push(this.transport.onCommand((cmd, from) => this.onCommand(cmd, from)));
    this.offs.push(this.transport.onMessage((msg) => this.onMessage(msg)));
    this.offs.push(this.transport.onAuthority((hostId) => this.onAuthority(hostId)));
    this.offs.push(this.transport.onPeerLost((id) => this.onPeerLost(id)));
  }

  /* --------------------------------------------------------------- reads -- */

  get isHost(): boolean { return this.hostImpl !== null; }
  get host(): LobbyHost | null { return this.hostImpl; }
  get state(): LobbyState | null { return this.hostImpl ? this.hostImpl.state : this.remote; }
  get code(): RoomCode | null { return this.state?.code ?? null; }
  get id(): LobbyId | null { return this.state?.id ?? null; }
  /** True when the local player is the lobby leader (not necessarily the host). */
  get isLeader(): boolean { return this.state?.leaderId === this.localId; }

  /* -------------------------------------------------------------- create -- */

  /** Stands up a new lobby with this peer as host. */
  create(opts: Omit<LobbyHostOptions, 'hostId' | 'emit' | 'catalog' | 'parties'> = {}): LobbyHost {
    this.teardownHost();
    this.hostImpl = new LobbyHost({
      ...opts,
      hostId: this.localId,
      hostProfile: this.profile,
      emit: this.hostEmitter(),
      catalog: this.catalog,
      parties: this.parties,
    });
    this.remote = this.hostImpl.state;
    this.emit('lobby:joined', {
      id: this.hostImpl.id, code: this.hostImpl.code, localId: this.localId,
      member: this.hostImpl.member(this.localId)!,
    });
    this.broadcastSnapshot();
    return this.hostImpl;
  }

  /** Asks the current host to let us in. Resolves through the next state. */
  join(code: RoomCode, partyId: string | null = null): CommandResult {
    const normalised = normalizeRoomCode(code);
    if (!normalised) return fail('bad-code', 'That is not a valid room code.');
    return this.submit({ t: 'join', code: normalised, profile: this.profile, partyId });
  }

  /* -------------------------------------------------------------- writes -- */

  /**
   * The one write path. As host it applies immediately and returns the real
   * result; as a client it is a request, and `ok` only means "sent".
   */
  submit(cmd: LobbyCommand): CommandResult {
    if (this.disposed) return fail('not-allowed', 'Session closed.');
    if (this.hostImpl) return this.hostImpl.submit(cmd, this.localId);
    this.transport.send(cmd);
    return OK;
  }

  ready(ready: boolean): CommandResult { return this.submit({ t: 'ready', ready }); }
  vote(candidateId: string): CommandResult { return this.submit({ t: 'vote', candidateId }); }
  leave(): CommandResult { return this.submit({ t: 'leave' }); }
  kick(target: PlayerId, reason?: string): CommandResult {
    return this.submit({ t: 'kick', target, reason });
  }
  promote(target: PlayerId): CommandResult { return this.submit({ t: 'promote', target }); }
  configure(patch: Partial<LobbySettings>): CommandResult {
    return this.submit({ t: 'settings', patch });
  }
  reportLoadProgress(progress: number): CommandResult {
    return this.submit({ t: 'loading', progress });
  }
  /** Host-only: hand the match result back to the lobby so it can recycle. */
  reportResult(result: LobbyResult): CommandResult {
    if (!this.hostImpl) return fail('not-host', 'Only the host reports results.');
    return this.hostImpl.reportResult(result);
  }

  /* ---------------------------------------------------------------- tick -- */

  tick(dt: number): void {
    if (this.disposed) return;
    if (!this.hostImpl) return;
    this.hostImpl.tick(dt);
    this.snapshotTimer += dt;
    if (this.snapshotTimer >= this.snapshotInterval) {
      this.snapshotTimer = 0;
      this.broadcastSnapshot();
    }
  }

  /* ------------------------------------------------------------- plumbing -- */

  /**
   * The emitter handed to `LobbyHost`. Everything the host announces goes to
   * the local bus *and*, for the two events clients need, onto the wire.
   */
  private hostEmitter(): SessionEmitter {
    return ((key, payload) => {
      this.emit(key, payload);
      if (key === 'lobby:state') {
        this.remote = payload as LobbyState;
        this.transport.broadcast({ t: 'state', state: payload as LobbyState });
      }
    }) as SessionEmitter;
  }

  private broadcastSnapshot(): void {
    if (!this.hostImpl) return;
    this.lastSnapshot = this.hostImpl.export();
    this.transport.broadcast({ t: 'snapshot', snapshot: this.lastSnapshot });
  }

  private onCommand(cmd: LobbyCommand, from: PlayerId): void {
    if (!this.hostImpl) return;
    const result = this.hostImpl.submit(cmd, from);
    if (!result.ok && result.code && from !== this.localId) {
      this.transport.sendTo(from, {
        t: 'error', to: from, code: result.code, error: result.error ?? '',
      });
    }
    if (cmd.t === 'join' && result.ok) this.broadcastSnapshot();
  }

  private onMessage(msg: LobbyMessage): void {
    switch (msg.t) {
      case 'state': {
        if (this.hostImpl) return;               // we are authoritative; ignore
        if (this.remote && msg.state.epoch < this.remote.epoch) return;
        if (this.remote && msg.state.epoch === this.remote.epoch && msg.state.seq < this.remote.seq) return;
        const first = this.remote === null;
        this.remote = msg.state;
        this.emit('lobby:state', msg.state);
        if (first) {
          const me = msg.state.members.find((m) => m.id === this.localId);
          if (me) {
            this.emit('lobby:joined', {
              id: msg.state.id, code: msg.state.code, localId: this.localId, member: me,
            });
          }
        }
        break;
      }
      case 'snapshot': {
        if (this.hostImpl) return;
        this.lastSnapshot = msg.snapshot;
        break;
      }
      case 'launch': {
        if (this.hostImpl) return;               // the host already emitted it
        this.emit('lobby:launch', msg.config);
        break;
      }
      case 'error': {
        if (msg.to !== this.localId) return;
        this.emit('lobby:error', { code: msg.code, error: msg.error, playerId: this.localId });
        break;
      }
      case 'closed': {
        this.emit('lobby:closed', { id: this.remote?.id ?? '', reason: msg.reason });
        this.remote = null;
        break;
      }
    }
  }

  private onPeerLost(id: PlayerId): void {
    this.hostImpl?.dropMember(id, 'dropped');
  }

  /**
   * Authority moved. Either we just became the host — rebuild from the newest
   * snapshot we hold — or somebody else did and we stand down.
   */
  private onAuthority(hostId: PlayerId): void {
    if (hostId === this.localId) {
      if (this.hostImpl) return;
      const snapshot = this.lastSnapshot
        ?? (this.remote ? snapshotFromState(this.remote) : null);
      if (!snapshot) return;
      const departed = snapshot.state.hostId === this.localId ? null : snapshot.state.hostId;
      this.hostImpl = LobbyHost.adopt(snapshot, {
        hostId: this.localId,
        emit: this.hostEmitter(),
        catalog: this.catalog,
        departed,
      });
      this.parties.restore(snapshot.parties);
      this.remote = this.hostImpl.state;
      this.snapshotTimer = 0;
      this.broadcastSnapshot();
      return;
    }
    // Somebody else owns the lobby now.
    if (this.hostImpl) {
      this.lastSnapshot = this.hostImpl.export();
      this.teardownHost();
    }
  }

  /** Who this peer believes should take over if the host disappears right now. */
  successor(): PlayerId | null {
    const state = this.state;
    return state ? pickSuccessor(state, state.hostId) : null;
  }

  wouldAdopt(): boolean {
    const state = this.state;
    return state ? shouldAdopt(state, this.localId, state.hostId) : false;
  }

  private teardownHost(): void {
    this.hostImpl = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.hostImpl = null;
    this.remote = null;
  }
}
