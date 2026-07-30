/**
 * `LoadoutService` — the authority-aware half.
 *
 * The rule the whole file is built around: **the host decides, clients request
 * and display.** A client never resolves a loadout into gameplay numbers and
 * applies them; it sends the ids, the host validates them, and what comes back
 * is what everyone runs. That is the only arrangement that survives a modified
 * client, and it is also the arrangement that makes killcam and replay honest,
 * since the resolved stats are a pure function of the granted ids.
 *
 * ```
 *   client                       authority (host)
 *   ------                       ----------------
 *   book.setAttachment(...)
 *   service.request(id, loadout) ──► validateLoadout(untrusted)
 *                                    ├─ ok      → grant, effective stats cached
 *                                    └─ illegal → repair, grant the repair + errors
 *   grant ◄──────────────────────────┘
 *   UI shows the granted build
 * ```
 *
 * ## The netcode seam
 *
 * `src/net/` does not exist as a contract yet, so this module codes against
 * `LoadoutAuthority` (in `types.ts`) and ships `LocalAuthority`, which validates
 * in-process. When the netcode layer lands it needs to provide two things and
 * nothing else:
 *
 *   1. a `LoadoutAuthority` whose `request()` serialises the `Loadout` (it is
 *      plain JSON by construction) to the host and resolves with the host's
 *      `LoadoutGrant`;
 *   2. on the host, a call to `LoadoutService.grant()` per received request, and
 *      a broadcast of the returned grant to every peer.
 *
 * Nothing else in the loadout layer needs to change for it to be networked.
 *
 * ## Respawn semantics
 *
 * Changing class mid-life does not swap the gun in your hands — it queues. The
 * first request for a player (they have not spawned yet) applies immediately;
 * later ones are `pending` until `notifySpawn()`. This is the shipped-shooter
 * rule and it is also what keeps the host from having to reconcile a weapon
 * swap in the middle of a burst.
 */

import { resolveWeapon } from './Effective';
import { perkDef } from './data/perks';
import { fieldUpgradeDef, grenadeKindFor, lethalDef, tacticalDef } from './data/equipment';
import { cloneLoadout, defaultLoadout, validateLoadout } from './Validate';
import type {
  EffectiveWeaponStats, EquipmentDef, FieldUpgradeDef, Loadout, LoadoutAuthority,
  LoadoutFlag, LoadoutGrant, PerkDef, ValidationContext, ValidationError,
} from './types';

/** Everything a spawn needs, resolved once and cached by the host. */
export interface ActiveLoadout {
  playerId: number;
  loadout: Loadout;
  primary: EffectiveWeaponStats;
  secondary: EffectiveWeaponStats;
  perks: PerkDef[];
  lethal: EquipmentDef;
  tactical: EquipmentDef;
  fieldUpgrade: FieldUpgradeDef;
  /** Grenade kinds the weapon module can actually throw for this class. */
  lethalGrenade: 'frag' | 'flash' | 'smoke';
  tacticalGrenade: 'frag' | 'flash' | 'smoke';
  /** Union of every flag from attachments and perks. */
  flags: LoadoutFlag[];
  /** Killstreak ids in cost order, with Hardline already applied to the costs. */
  killstreaks: Array<{ id: string; cost: number }>;
}

/** Resolves a validated loadout into everything a spawn needs. Pure. */
export function activate(playerId: number, loadout: Loadout): ActiveLoadout {
  const perkIds = loadout.perks.filter((p) => p.length > 0);
  const perks = perkIds.map((id) => perkDef(id)).filter((p): p is PerkDef => p !== null);
  const primary = resolveWeapon(loadout.primary.weaponId, loadout.primary.attachments, { perks: perkIds });
  const secondary = resolveWeapon(loadout.secondary.weaponId, loadout.secondary.attachments, { perks: perkIds });

  const lethal = lethalDef(loadout.lethal) ?? lethalDef('eq_frag')!;
  const tactical = tacticalDef(loadout.tactical) ?? tacticalDef('eq_flash')!;
  const fieldUpgrade = fieldUpgradeDef(loadout.fieldUpgrade) ?? fieldUpgradeDef('fu_deadsilence')!;

  const flags = [...new Set([...primary.flags, ...secondary.flags, ...perks.flatMap((p) => p.flags ?? [])])].sort();
  const hardline = flags.includes('hardline');
  const killstreaks = loadout.killstreaks.map((id) => ({
    id,
    cost: Math.max(1, killstreakCost(id) - (hardline ? 1 : 0)),
  }));

  return {
    playerId, loadout, primary, secondary, perks,
    lethal, tactical, fieldUpgrade,
    lethalGrenade: grenadeKindFor(lethal),
    tacticalGrenade: grenadeKindFor(tactical),
    flags, killstreaks,
  };
}

function killstreakCost(id: string): number {
  // Kept local so the loadout layer does not import the game module; the value
  // is asserted against `src/game/Killstreaks.ts` by tools/session-loadout.mjs.
  switch (id) {
    case 'uav': return 3;
    case 'counteruav': return 4;
    case 'carepackage': return 5;
    case 'airstrike': return 7;
    case 'sentry': return 9;
    default: return 5;
  }
}

/* ------------------------------------------------------------- authority */

/**
 * The offline / listen-host authority: validates in-process and grants
 * immediately. This is what runs in single player and what the host runs behind
 * a networked authority.
 */
export class LocalAuthority implements LoadoutAuthority {
  readonly isHost = true;
  private listeners = new Set<(g: LoadoutGrant) => void>();
  private tick = 0;

  /** `contextFor` lets the host apply per-player unlock state. */
  constructor(private contextFor: (playerId: number) => ValidationContext = () => ({})) { }

  /** Advance the authoritative tick — the netcode layer will drive this. */
  setTick(tick: number): void { this.tick = tick; }

  async request(playerId: number, loadout: Loadout): Promise<LoadoutGrant> {
    return this.decide(playerId, loadout, false);
  }

  /** Synchronous host-side decision. `request()` is the async wrapper. */
  decide(playerId: number, loadout: unknown, pending: boolean): LoadoutGrant {
    const res = validateLoadout(loadout, this.contextFor(playerId));
    const grant: LoadoutGrant = {
      playerId, accepted: res.ok, loadout: res.loadout,
      errors: res.errors, tick: this.tick, pending,
    };
    for (const fn of this.listeners) {
      try { fn(grant); } catch (err) { console.error('[loadout] grant listener threw', err); }
    }
    return grant;
  }

  onGrant(fn: (g: LoadoutGrant) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

/* --------------------------------------------------------------- service */

export interface LoadoutServiceOptions {
  authority?: LoadoutAuthority;
  /** Per-player unlock context, host-side. */
  contextFor?: (playerId: number) => ValidationContext;
}

export class LoadoutService {
  readonly authority: LoadoutAuthority;
  private active = new Map<number, ActiveLoadout>();
  private pending = new Map<number, Loadout>();
  private spawned = new Set<number>();
  private listeners = new Set<(a: ActiveLoadout) => void>();
  private unsubscribe: () => void;

  constructor(opts: LoadoutServiceOptions = {}) {
    this.authority = opts.authority ?? new LocalAuthority(opts.contextFor ?? (() => ({})));
    // Grants can arrive unsolicited (another player changed class, or the host
    // corrected ours), so the service reacts to the stream rather than only to
    // its own promises.
    this.unsubscribe = this.authority.onGrant((g) => this.applyGrant(g));
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.active.clear();
    this.pending.clear();
    this.spawned.clear();
  }

  /**
   * Ask the authority to run `loadout` for `playerId`.
   *
   * The returned grant is authoritative: if `accepted` is false the host still
   * granted `grant.loadout` (the repair), and the UI must show that build.
   */
  async request(playerId: number, loadout: Loadout): Promise<LoadoutGrant> {
    const grant = await this.authority.request(playerId, cloneLoadout(loadout));
    this.applyGrant(grant);
    return grant;
  }

  /** Host-side entry point for a request that arrived over the wire. */
  grant(playerId: number, untrusted: unknown, context: ValidationContext = {}): LoadoutGrant {
    const res = validateLoadout(untrusted, context);
    const grant: LoadoutGrant = {
      playerId, accepted: res.ok, loadout: res.loadout, errors: res.errors,
      tick: 0, pending: this.spawned.has(playerId),
    };
    this.applyGrant(grant);
    return grant;
  }

  private applyGrant(grant: LoadoutGrant): void {
    const queue = grant.pending || this.spawned.has(grant.playerId);
    if (queue && this.active.has(grant.playerId)) {
      this.pending.set(grant.playerId, grant.loadout);
      return;
    }
    this.install(grant.playerId, grant.loadout);
  }

  private install(playerId: number, loadout: Loadout): ActiveLoadout {
    const a = activate(playerId, loadout);
    this.active.set(playerId, a);
    this.pending.delete(playerId);
    for (const fn of this.listeners) {
      try { fn(a); } catch (err) { console.error('[loadout] active listener threw', err); }
    }
    return a;
  }

  /**
   * Call on every respawn. Promotes a queued class and returns what the player
   * should spawn with — the weapon system reads `primary`/`secondary` from it.
   */
  notifySpawn(playerId: number): ActiveLoadout {
    const queued = this.pending.get(playerId);
    const result = queued
      ? this.install(playerId, queued)
      : this.active.get(playerId) ?? this.install(playerId, defaultLoadout());
    this.spawned.add(playerId);
    return result;
  }

  /** Forget a player entirely (disconnect, match end). */
  release(playerId: number): void {
    this.active.delete(playerId);
    this.pending.delete(playerId);
    this.spawned.delete(playerId);
  }

  /** Everyone starts unspawned again — call between matches. */
  resetSpawnState(): void { this.spawned.clear(); }

  activeFor(playerId: number): ActiveLoadout | null { return this.active.get(playerId) ?? null; }
  pendingFor(playerId: number): Loadout | null { return this.pending.get(playerId) ?? null; }
  hasPending(playerId: number): boolean { return this.pending.has(playerId); }

  /** Fires whenever a player's active loadout actually changes. */
  onActive(fn: (a: ActiveLoadout) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

/** The errors a UI should surface, formatted for a one-line toast. */
export function describeErrors(errors: readonly ValidationError[]): string[] {
  return errors.map((e) => (e.id ? `${e.message}` : e.message));
}
