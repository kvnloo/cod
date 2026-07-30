/**
 * Interest management — who is allowed to know about what, and how often.
 *
 * This is the feature that decides whether the netcode scales past a small
 * match. Without it, cost is O(entities x clients) every tick and 200 entities
 * across 12 clients saturates a home uplink. With it, each client pays for the
 * handful of entities that can actually affect them this second.
 *
 * Three mechanisms, in order of importance:
 *
 *  1. SPATIAL CULL — a uniform grid over XZ. A client only considers entities in
 *     the cells within `cullRadius`. Everything else costs one cell lookup, not
 *     one entity comparison.
 *
 *  2. FORCED RELEVANCE — some things must be known regardless of distance: the
 *     entity you control, objectives and other `alwaysRelevant` classes, your
 *     teammates, and anything that just made noise near you (a gunshot behind a
 *     wall must produce a real entity, not a guess).
 *
 *  3. PRIORITY + RATE TIERS — every candidate gets a score from distance, view
 *     direction, class importance and *staleness*. Distant entities are assigned
 *     a coarser LOD, which both raises their minimum update interval and drops
 *     their cosmetic fields. When the budget truncates the list, the entities
 *     that were dropped gain priority every tick they wait, so nothing starves.
 *
 * The grid is rebuilt once per network tick (O(n), no per-move bookkeeping in
 * the gameplay code — that keeps the hooks into the simulation to exactly one
 * call). At 20 Hz with a few thousand entities this is far cheaper than the
 * snapshot encoding it feeds.
 */

import type { ClientId, EntityId, NetTick, Vec3Like } from './types';
import type { Replicator, RepEntity } from './Replicator';

export interface ClientView {
  pos: Vec3Like;
  /** Normalised look direction. Used for the in-view priority bonus. */
  forward: Vec3Like;
  team: number;
  /** The entity this client controls, or -1. Always force-relevant. */
  controlled: EntityId;
}

export interface RelevanceEntry {
  id: EntityId;
  priority: number;
  /** 0 = full detail .. 3 = coarsest. Selects which fields survive. */
  lod: number;
  forced: boolean;
  distance: number;
}

export interface InterestConfig {
  /** Grid cell edge, metres. Should be ~= the shortest sightline you care about. */
  cellSize: number;
  /** Hard spatial cull, metres. Beyond this only forced entities are relevant. */
  cullRadius: number;
  /** Upper distance bound of LOD 0, 1, 2. Anything further is LOD 3. */
  lodDistances: [number, number, number];
  /** Minimum ticks between updates at LOD 0..3. */
  lodIntervals: [number, number, number, number];
  /** Hard cap on entities considered per snapshot, before the byte budget. */
  maxEntitiesPerTick: number;
  /** cos(half FOV) for the in-view bonus. */
  fovCos: number;
  /** Priority multiplier when the entity is outside the view cone. */
  behindFactor: number;
  /** Distance at which the falloff term reaches 1/2. */
  refDistance: number;
  /** Priority gained per tick since last sent. */
  staleWeight: number;
  teamBoost: number;
  noiseBoost: number;
  /** How long a noise event keeps its entity relevant. */
  noiseTtlTicks: number;
  /** Heartbeat: resend even an unchanged entity after this many ticks. */
  forceResendTicks: number;
}

export const DEFAULT_INTEREST: InterestConfig = {
  cellSize: 24,
  cullRadius: 160,
  lodDistances: [28, 70, 120],
  lodIntervals: [1, 2, 4, 8],
  maxEntitiesPerTick: 96,
  fovCos: Math.cos(1.2),
  behindFactor: 0.55,
  refDistance: 22,
  staleWeight: 0.45,
  teamBoost: 1.7,
  noiseBoost: 3.0,
  noiseTtlTicks: 20,
  forceResendTicks: 120,
};

/** Degradation ladder applied when a client is over budget. */
const DEGRADE_INTERVAL_MUL = [1, 1.5, 2.5, 4];
const DEGRADE_LOD_BIAS = [0, 0, 1, 1];
const DEGRADE_COUNT_SCALE = [1, 0.8, 0.6, 0.4];

interface NoiseEvent {
  id: EntityId;
  x: number; y: number; z: number;
  radius: number;
  expires: NetTick;
}

export interface InterestStats {
  candidates: number;
  spatialCulled: number;
  rateLimited: number;
  clean: number;
  selected: number;
  forced: number;
  cellsVisited: number;
}

export class InterestManager {
  readonly config: InterestConfig;
  private rep: Replicator;

  private cells = new Map<number, RepEntity[]>();
  private globals: RepEntity[] = [];
  private gridTick = -1;

  private views = new Map<ClientId, ClientView>();
  private sent = new Map<ClientId, Map<EntityId, NetTick>>();
  private results = new Map<ClientId, RelevanceEntry[]>();
  private noise: NoiseEvent[] = [];

  private stamp = 0;
  private seen = new Int32Array(1024);

  readonly stats: InterestStats = {
    candidates: 0, spatialCulled: 0, rateLimited: 0, clean: 0,
    selected: 0, forced: 0, cellsVisited: 0,
  };

  constructor(rep: Replicator, config: Partial<InterestConfig> = {}) {
    this.rep = rep;
    this.config = { ...DEFAULT_INTEREST, ...config };
  }

  /* --------------------------------------------------------------- clients */

  setView(clientId: ClientId, view: ClientView): void {
    this.views.set(clientId, view);
    if (!this.sent.has(clientId)) this.sent.set(clientId, new Map());
  }

  view(clientId: ClientId): ClientView | undefined { return this.views.get(clientId); }

  removeClient(clientId: ClientId): void {
    this.views.delete(clientId);
    this.sent.delete(clientId);
    this.results.delete(clientId);
  }

  markSent(clientId: ClientId, id: EntityId, tick: NetTick): void {
    let m = this.sent.get(clientId);
    if (!m) { m = new Map(); this.sent.set(clientId, m); }
    m.set(id, tick);
  }

  forgetEntity(clientId: ClientId, id: EntityId): void {
    this.sent.get(clientId)?.delete(id);
  }

  lastSent(clientId: ClientId, id: EntityId): NetTick {
    const m = this.sent.get(clientId);
    if (!m) return -1;
    const t = m.get(id);
    return t === undefined ? -1 : t;
  }

  /**
   * "Something happened here" — a gunshot, an explosion, a door. Any client
   * inside `radius` gets the entity forced into their set for a short window,
   * even through walls and beyond the cull radius. This is what stops an enemy
   * from firing at you from just outside your interest bubble and being invisible.
   */
  reportNoise(id: EntityId, x: number, y: number, z: number, radius: number, ttlTicks?: number): void {
    const expires = this.rep.tick + (ttlTicks ?? this.config.noiseTtlTicks);
    for (const n of this.noise) {
      if (n.id === id) {
        n.x = x; n.y = y; n.z = z; n.radius = radius; n.expires = expires;
        return;
      }
    }
    this.noise.push({ id, x, y, z, radius, expires });
  }

  /* ------------------------------------------------------------------ grid */

  private key(cx: number, cz: number): number {
    return (((cx & 0xffff) << 16) | (cz & 0xffff)) >>> 0;
  }

  /** Rebuilds the spatial index. Idempotent within a tick. */
  refresh(tick: NetTick): void {
    if (this.gridTick === tick) return;
    this.gridTick = tick;
    for (const arr of this.cells.values()) arr.length = 0;
    this.globals.length = 0;
    const cs = this.config.cellSize;
    for (const e of this.rep.all()) {
      if (e.cls.alwaysRelevant || e.cls.positionWord < 0) {
        this.globals.push(e);
        continue;
      }
      const k = this.key(Math.floor(e.x / cs), Math.floor(e.z / cs));
      let arr = this.cells.get(k);
      if (!arr) { arr = []; this.cells.set(k, arr); }
      arr.push(e);
    }
    for (let i = this.noise.length - 1; i >= 0; i--) {
      if (this.noise[i].expires <= tick) this.noise.splice(i, 1);
    }
  }

  private markSeen(id: EntityId): boolean {
    if (id >= this.seen.length) {
      let n = this.seen.length * 2;
      while (n <= id) n *= 2;
      const nb = new Int32Array(n);
      nb.set(this.seen);
      this.seen = nb;
    }
    if (this.seen[id] === this.stamp) return false;
    this.seen[id] = this.stamp;
    return true;
  }

  /* -------------------------------------------------------------- evaluate */

  /**
   * Returns this client's relevant entities, highest priority first. The array
   * is owned by the manager and is valid until the next `evaluate` for the same
   * client.
   */
  evaluate(clientId: ClientId, tick: NetTick, degradeLevel = 0): RelevanceEntry[] {
    this.refresh(tick);
    // Bind the per-client last-sent table BEFORE any `consider` call. Without
    // this every lookup fell through to client -1, which has no table, so every
    // entity looked "never sent": rate limiting never fired and every candidate
    // got the x4 first-sight priority bonus.
    this.activeClient = clientId;
    const cfg = this.config;
    const view = this.views.get(clientId);
    let out = this.results.get(clientId);
    if (!out) { out = []; this.results.set(clientId, out); }
    out.length = 0;
    if (!view) return out;

    this.stamp++;
    const st = this.stats;
    st.candidates = 0; st.spatialCulled = 0; st.rateLimited = 0;
    st.clean = 0; st.selected = 0; st.forced = 0; st.cellsVisited = 0;

    const deg = degradeLevel < 0 ? 0 : degradeLevel > 3 ? 3 : degradeLevel;
    const intervalMul = DEGRADE_INTERVAL_MUL[deg];
    const lodBias = DEGRADE_LOD_BIAS[deg];
    const limit = Math.max(8, Math.floor(cfg.maxEntitiesPerTick * DEGRADE_COUNT_SCALE[deg]));

    const ackedTick = this.rep.clients.get(clientId)?.ackedTick ?? -1;
    const cull2 = cfg.cullRadius * cfg.cullRadius;

    // 1. forced: controlled entity + always-relevant classes.
    if (view.controlled >= 0) {
      const own = this.rep.get(view.controlled);
      if (own) this.consider(out, own, view, tick, ackedTick, intervalMul, lodBias, true, 1e6, cull2);
    }
    for (const e of this.globals) {
      this.consider(out, e, view, tick, ackedTick, intervalMul, lodBias, true, 1e5, cull2);
    }

    // 2. noise events near this client force their entity in.
    for (const n of this.noise) {
      const dx = n.x - view.pos.x, dy = n.y - view.pos.y, dz = n.z - view.pos.z;
      if (dx * dx + dy * dy + dz * dz > n.radius * n.radius) continue;
      const e = this.rep.get(n.id);
      if (e) this.consider(out, e, view, tick, ackedTick, intervalMul, lodBias, true, 0, cull2, cfg.noiseBoost);
    }

    // 3. spatial: every cell overlapping the cull radius.
    const cs = cfg.cellSize;
    const r = Math.ceil(cfg.cullRadius / cs);
    const ccx = Math.floor(view.pos.x / cs);
    const ccz = Math.floor(view.pos.z / cs);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const arr = this.cells.get(this.key(ccx + dx, ccz + dz));
        if (!arr || arr.length === 0) continue;
        st.cellsVisited++;
        for (let i = 0; i < arr.length; i++) {
          this.consider(out, arr[i], view, tick, ackedTick, intervalMul, lodBias, false, 0, cull2);
        }
      }
    }

    out.sort(byPriority);
    if (out.length > limit) out.length = limit;
    st.selected = out.length;
    return out;
  }

  private consider(
    out: RelevanceEntry[],
    e: RepEntity,
    view: ClientView,
    tick: NetTick,
    ackedTick: NetTick,
    intervalMul: number,
    lodBias: number,
    forced: boolean,
    forceScore: number,
    cull2: number,
    extraBoost = 1,
  ): void {
    if (!this.markSeen(e.id)) return;
    const cfg = this.config;
    this.stats.candidates++;

    const dx = e.x - view.pos.x;
    const dy = e.y - view.pos.y;
    const dz = e.z - view.pos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!forced && d2 > cull2) { this.stats.spatialCulled++; return; }
    const dist = Math.sqrt(d2);

    let lod = 3;
    const ld = cfg.lodDistances;
    if (dist <= ld[0]) lod = 0;
    else if (dist <= ld[1]) lod = 1;
    else if (dist <= ld[2]) lod = 2;
    // The entity a client drives is always sent at full detail. In practice the
    // force-relevance pass above has already caught it; this is belt and braces.
    if (view.controlled === e.id) lod = 0;
    lod = Math.min(3, lod + lodBias);
    if (forced && forceScore >= 1e6) lod = 0;

    const lastSentTick = this.lastSent(this.activeClient, e.id);
    const since = lastSentTick < 0 ? 1e4 : tick - lastSentTick;

    // Rate tier: distant things update less often. Forced entities bypass it.
    const interval = Math.max(1, Math.round(cfg.lodIntervals[lod] * intervalMul));
    if (!forced && since < interval) { this.stats.rateLimited++; return; }

    // Nothing new to say? Only the heartbeat keeps it alive.
    const changed = e.lastChangeTick > ackedTick;
    const neverSent = lastSentTick < 0;
    if (!neverSent && !changed && since < cfg.forceResendTicks) { this.stats.clean++; return; }

    let score = e.cls.basePriority * e.priorityBias * extraBoost;
    score *= cfg.refDistance / (cfg.refDistance + dist);
    if (view.forward) {
      const inv = dist > 0.001 ? 1 / dist : 0;
      const dot = (dx * view.forward.x + dy * view.forward.y + dz * view.forward.z) * inv;
      if (dot < cfg.fovCos) score *= cfg.behindFactor;
    }
    if (e.team === view.team && e.team !== 0) score *= cfg.teamBoost;
    score *= 1 + Math.min(since, 240) * cfg.staleWeight;
    if (neverSent) score *= 4;
    score += forceScore;
    if (forced) this.stats.forced++;

    out.push({ id: e.id, priority: score, lod, forced, distance: dist });
  }

  /**
   * Client whose set is being evaluated right now. `evaluate` sets it; nothing
   * else should need to.
   */
  private activeClient: ClientId = -1;

  /** @internal escape hatch for tests that call `consider` paths directly. */
  setActiveClient(clientId: ClientId): void { this.activeClient = clientId; }
}

function byPriority(a: RelevanceEntry, b: RelevanceEntry): number {
  return b.priority - a.priority;
}
