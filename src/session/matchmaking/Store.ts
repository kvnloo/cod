/**
 * Local persistence for matchmaking records.
 *
 * Same shape and defensiveness as `src/game/Progression.ts`: one JSON blob in
 * localStorage, every field validated on the way in, a corrupt store silently
 * yields fresh records. Ratings live here until there is a service to own them
 * — when one appears, `RatingStore` becomes its cache and only `load`/`save`
 * change.
 *
 * The store holds the *local* player plus every peer we have seen, because
 * rating a match needs the opponents' ratings and the host may not have them
 * to hand for a player who just left.
 */

import { newRating, ratingFromRank, RD_DEFAULT, RATING_DEFAULT, VOL_DEFAULT } from './Rating';
import type { PlayerId, PlayerRecord, RegionId, SkillRating } from './types';
import { REGIONS } from './types';

const STORAGE_KEY = 'blackout.mm.v1';
const MAX_PEERS = 400;

interface StoredBlob {
  version: 1;
  localId: PlayerId;
  records: PlayerRecord[];
}

export function defaultRecord(id: PlayerId, name: string, region: RegionId): PlayerRecord {
  return {
    id, name, region,
    rating: newRating(),
    rank: 1,
    avgScorePerMin: 0,
    wins: 0,
    losses: 0,
    quits: 0,
  };
}

export class RatingStore {
  private records = new Map<PlayerId, PlayerRecord>();
  localId: PlayerId = 'local';

  constructor(private storage: Storage | null = safeStorage()) { }

  setStorage(storage: Storage | null): void { this.storage = storage; }

  load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<StoredBlob>;
      if (typeof data.localId === 'string' && data.localId) this.localId = data.localId;
      if (!Array.isArray(data.records)) return;
      for (const r of data.records.slice(0, MAX_PEERS)) {
        const rec = sanitise(r);
        if (rec) this.records.set(rec.id, rec);
      }
    } catch { /* corrupt store — start clean */ }
  }

  save(): void {
    if (!this.storage) return;
    try {
      // Keep the local player plus the most-played peers; the rest is noise.
      const all = [...this.records.values()];
      const local = all.filter((r) => r.id === this.localId);
      const peers = all
        .filter((r) => r.id !== this.localId)
        .sort((a, b) => b.rating.matches - a.rating.matches)
        .slice(0, MAX_PEERS - local.length);
      const blob: StoredBlob = { version: 1, localId: this.localId, records: [...local, ...peers] };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(blob));
    } catch { /* quota / private mode */ }
  }

  get(id: PlayerId): PlayerRecord | undefined { return this.records.get(id); }

  has(id: PlayerId): boolean { return this.records.has(id); }

  /** Fetches or creates a record. New records seed their rating from rank. */
  ensure(id: PlayerId, name: string, region: RegionId, rank = 1): PlayerRecord {
    const found = this.records.get(id);
    if (found) {
      if (name && found.name !== name) found.name = name;
      if (rank > found.rank) found.rank = rank;
      return found;
    }
    const rec = defaultRecord(id, name || id, region);
    rec.rank = Math.max(1, Math.floor(rank));
    if (rec.rank > 1) rec.rating = ratingFromRank(rec.rank);
    this.records.set(id, rec);
    return rec;
  }

  put(rec: PlayerRecord): void { this.records.set(rec.id, rec); }

  /** Rating for an id we may never have met — an unrated 1500/350 by default. */
  ratingOf(id: PlayerId): SkillRating {
    return this.records.get(id)?.rating ?? newRating();
  }

  all(): PlayerRecord[] { return [...this.records.values()]; }

  get size(): number { return this.records.size; }

  setLocal(id: PlayerId): void { this.localId = id; }

  local(): PlayerRecord {
    return this.records.get(this.localId) ?? this.ensure(this.localId, 'Player', 'na-east');
  }

  clear(): void {
    this.records.clear();
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

/* --------------------------------------------------------------- helpers -- */

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function sanitise(raw: unknown): PlayerRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<PlayerRecord> & { rating?: Partial<SkillRating> };
  if (typeof r.id !== 'string' || !r.id) return null;
  const region = (typeof r.region === 'string' && (REGIONS as readonly string[]).includes(r.region))
    ? r.region as RegionId
    : 'na-east';
  const rec = defaultRecord(r.id, typeof r.name === 'string' ? r.name : r.id, region);
  rec.rank = num(r.rank, 1, 1, 100);
  rec.avgScorePerMin = num(r.avgScorePerMin, 0, 0, 100000);
  rec.wins = num(r.wins, 0, 0, 1e7);
  rec.losses = num(r.losses, 0, 0, 1e7);
  rec.quits = num(r.quits, 0, 0, 1e7);
  const rt: Partial<SkillRating> = r.rating ?? {};
  rec.rating = {
    rating: num(rt.rating, RATING_DEFAULT, 100, 4000),
    rd: num(rt.rd, RD_DEFAULT, 20, RD_DEFAULT),
    vol: num(rt.vol, VOL_DEFAULT, 0.005, 0.4),
    matches: num(rt.matches, 0, 0, 1e7),
    lastPlayed: num(rt.lastPlayed, 0, 0, 1e13),
  };
  return rec;
}

function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    s.setItem('blackout.mm.probe', '1');
    s.removeItem('blackout.mm.probe');
    return s;
  } catch { return null; }
}
