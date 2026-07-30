/**
 * Parties: the group that outlives the match.
 *
 * A lobby is transactional — it forms, plays, dissolves. A party is not. It is
 * the same four people who queue together for an hour, and every social feature
 * a shooter has (staying on one team, following the leader into a new lobby,
 * "you've played 37 matches with this squad") hangs off that persistence.
 *
 * So the registry is deliberately independent of any one lobby:
 *
 * - it survives `post-match → forming`, because the lobby never clears it;
 * - it survives a page reload, because `persist()` writes the local player's
 *   party to storage and `restorePersisted()` reads it back with the room code
 *   needed to rejoin;
 * - it survives host migration, because `snapshot()` / `restore()` round-trip
 *   the whole registry as JSON inside `LobbySnapshot`.
 *
 * Nothing here talks to the network. The host owns a registry, mutates it in
 * response to validated commands, and ships the result inside the lobby state.
 */

import { hashString } from '../../core/Rand';
import type { PartyId, PartyRecord, PlayerId, RoomCode } from '../types';

const STORAGE_KEY = 'blackout.party.v1';
const PARTY_COLOURS = 6;

export interface Party {
  id: PartyId;
  leaderId: PlayerId;
  members: PlayerId[];
  /** Lobby clock seconds at creation. */
  createdAt: number;
  matchesTogether: number;
  colour: number;
  lobbyCode: RoomCode | null;
}

/* --------------------------------------------------------------- storage -- */

export interface PartyStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** localStorage, wrapped so a private-mode browser cannot throw into gameplay. */
export function browserPartyStore(): PartyStore {
  return {
    read(key) {
      try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
    },
    write(key, value) {
      try { globalThis.localStorage?.setItem(key, value); } catch { /* quota / private mode */ }
    },
    remove(key) {
      try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
    },
  };
}

export function memoryPartyStore(): PartyStore {
  const map = new Map<string, string>();
  return {
    read: (k) => map.get(k) ?? null,
    write: (k, v) => { map.set(k, v); },
    remove: (k) => { map.delete(k); },
  };
}

/** What `persist()` writes and `restorePersisted()` reads back. */
export interface PersistedParty {
  version: 1;
  id: PartyId;
  leaderId: PlayerId;
  members: PlayerId[];
  matchesTogether: number;
  colour: number;
  lobbyCode: RoomCode | null;
}

/* -------------------------------------------------------------- registry -- */

export class PartyRegistry {
  private parties = new Map<PartyId, Party>();
  private byPlayer = new Map<PlayerId, PartyId>();
  private counter = 0;

  constructor(private store: PartyStore = memoryPartyStore()) { }

  /* --- reads --- */

  get size(): number { return this.parties.size; }
  all(): Party[] { return [...this.parties.values()]; }
  get(id: PartyId): Party | null { return this.parties.get(id) ?? null; }
  partyOf(playerId: PlayerId): Party | null {
    const id = this.byPlayer.get(playerId);
    return id ? this.parties.get(id) ?? null : null;
  }
  /** Party ids that have at least two members present in `present`. */
  groupsAmong(present: ReadonlySet<PlayerId>): Party[] {
    const out: Party[] = [];
    for (const p of this.parties.values()) {
      let n = 0;
      for (const m of p.members) if (present.has(m)) n++;
      if (n >= 2) out.push(p);
    }
    return out;
  }

  /* --- writes --- */

  /**
   * Creates a party led by `leaderId`. Ids are derived from the leader and a
   * monotonic counter, never `Math.random`, so two hosts replaying the same
   * command stream produce the same ids.
   */
  create(leaderId: PlayerId, now = 0, seedTag = ''): Party {
    const existing = this.partyOf(leaderId);
    if (existing) return existing;
    const n = this.counter++;
    const id: PartyId = `pty_${(hashString(`${leaderId}:${seedTag}:${n}`) >>> 8).toString(36)}`;
    const party: Party = {
      id,
      leaderId,
      members: [leaderId],
      createdAt: now,
      matchesTogether: 0,
      colour: n % PARTY_COLOURS,
      lobbyCode: null,
    };
    this.parties.set(id, party);
    this.byPlayer.set(leaderId, id);
    return party;
  }

  /** Adds a player, moving them out of any party they were already in. */
  join(id: PartyId, playerId: PlayerId): Party | null {
    const party = this.parties.get(id);
    if (!party) return null;
    if (party.members.includes(playerId)) return party;
    this.leave(playerId);
    party.members.push(playerId);
    this.byPlayer.set(playerId, id);
    // A changed roster is a different squad; the shared-match counter resets.
    party.matchesTogether = 0;
    return party;
  }

  /**
   * Removes a player. The party dissolves at one member — a "party of one" is
   * just a solo player, and leaving one behind makes team balancing lie.
   */
  leave(playerId: PlayerId): void {
    const id = this.byPlayer.get(playerId);
    if (!id) return;
    const party = this.parties.get(id);
    this.byPlayer.delete(playerId);
    if (!party) return;
    const i = party.members.indexOf(playerId);
    if (i >= 0) party.members.splice(i, 1);
    if (party.members.length <= 1) {
      for (const m of party.members) this.byPlayer.delete(m);
      this.parties.delete(id);
      return;
    }
    if (party.leaderId === playerId) party.leaderId = party.members[0];
  }

  disband(id: PartyId): void {
    const party = this.parties.get(id);
    if (!party) return;
    for (const m of party.members) this.byPlayer.delete(m);
    this.parties.delete(id);
  }

  transferLeader(id: PartyId, playerId: PlayerId): boolean {
    const party = this.parties.get(id);
    if (!party || !party.members.includes(playerId)) return false;
    party.leaderId = playerId;
    return true;
  }

  /** Every party currently in `present` has now finished a match together. */
  noteMatchPlayed(present: ReadonlySet<PlayerId>): void {
    for (const p of this.parties.values()) {
      let n = 0;
      for (const m of p.members) if (present.has(m)) n++;
      if (n >= 2) p.matchesTogether++;
    }
  }

  /** Stamps the room the party is currently sitting in, for reload-rejoin. */
  setLobbyCode(code: RoomCode | null): void {
    for (const p of this.parties.values()) p.lobbyCode = code;
  }

  /* --- serialisation (host migration) --- */

  snapshot(): PartyRecord[] {
    return this.all().map((p) => ({
      id: p.id,
      leaderId: p.leaderId,
      members: [...p.members],
      createdAt: p.createdAt,
      matchesTogether: p.matchesTogether,
      colour: p.colour,
      lobbyCode: p.lobbyCode,
    }));
  }

  restore(records: readonly PartyRecord[]): void {
    this.parties.clear();
    this.byPlayer.clear();
    this.counter = 0;
    for (const r of records) {
      const party: Party = {
        id: r.id,
        leaderId: r.leaderId,
        members: [...r.members],
        createdAt: r.createdAt,
        matchesTogether: r.matchesTogether,
        colour: r.colour,
        lobbyCode: r.lobbyCode,
      };
      this.parties.set(party.id, party);
      for (const m of party.members) this.byPlayer.set(m, party.id);
      this.counter++;
    }
  }

  /* --- persistence (page reload) --- */

  /**
   * Writes the local player's party to storage. Call this whenever the party
   * changes; it is a few hundred bytes and the write is best-effort.
   */
  persist(localId: PlayerId): void {
    const party = this.partyOf(localId);
    if (!party || party.members.length < 2) { this.store.remove(STORAGE_KEY); return; }
    const blob: PersistedParty = {
      version: 1,
      id: party.id,
      leaderId: party.leaderId,
      members: [...party.members],
      matchesTogether: party.matchesTogether,
      colour: party.colour,
      lobbyCode: party.lobbyCode,
    };
    try { this.store.write(STORAGE_KEY, JSON.stringify(blob)); } catch { /* ignore */ }
  }

  /**
   * Reads back the party saved by a previous session. The front end uses
   * `lobbyCode` to offer "rejoin your squad" on the main menu.
   */
  restorePersisted(): PersistedParty | null {
    const raw = this.store.read(STORAGE_KEY);
    if (!raw) return null;
    try {
      const blob = JSON.parse(raw) as PersistedParty;
      if (!blob || blob.version !== 1 || !Array.isArray(blob.members)) return null;
      if (blob.members.length < 2 || typeof blob.leaderId !== 'string') return null;
      const party: Party = {
        id: blob.id,
        leaderId: blob.leaderId,
        members: [...blob.members],
        createdAt: 0,
        matchesTogether: blob.matchesTogether | 0,
        colour: blob.colour | 0,
        lobbyCode: blob.lobbyCode ?? null,
      };
      this.parties.set(party.id, party);
      for (const m of party.members) this.byPlayer.set(m, party.id);
      this.counter = Math.max(this.counter, this.parties.size);
      return blob;
    } catch {
      this.store.remove(STORAGE_KEY);
      return null;
    }
  }

  clearPersisted(): void { this.store.remove(STORAGE_KEY); }
}
