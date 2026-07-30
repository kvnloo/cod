/**
 * Session flow — the player journey as an explicit state machine.
 *
 *   boot → mainMenu → party → lobby → matchmaking → loading → preMatch
 *        → live → postMatch → afterAction → lobby (party intact)
 *
 * The whole point of this file is that *illegal transitions cannot be written
 * down*, not merely that they are rejected at runtime. `FLOW` is the single
 * source of truth; every type below is derived from it, so:
 *
 *   flow.at('lobby')?.send('search')     // ✓ compiles
 *   flow.at('lobby')?.send('finished')   // ✗ type error — 'finished' is a live-only event
 *
 * The dynamic `send()` overload exists for the two callers that genuinely do
 * not know the current state at compile time — the UI (`session:request`) and
 * the netcode layer replaying host decisions — and it returns `null` rather
 * than throwing when the event is not legal from where we are.
 *
 * Authority: this machine is *local bookkeeping*. In an online session the host
 * runs the real one and clients call `adopt()` with the host's state and
 * sequence number. Nothing in here talks to the network, the engine or the
 * event bus; `SessionSystem.ts` owns all of that.
 */

/* ------------------------------------------------------------------ table -- */

/**
 * state → { event: nextState }. Exhaustive: if a transition is not in this
 * table it does not exist.
 *
 * Recurring events, kept consistent across every state that has them:
 *   `fail`      unrecoverable local error       → fault
 *   `hostLost`  the session host went away      → migrating
 *   `dropped`   *we* lost our connection        → the safest local state
 */
export const FLOW = {
  /** Engine systems are still initialising. Nothing is interactive. */
  boot: {
    ready: 'mainMenu',
    fail: 'fault',
  },

  /** Front end. No match exists; the world may be rendering behind the menu. */
  mainMenu: {
    party: 'party',
    play: 'lobby',
    quit: 'shutdown',
    fail: 'fault',
  },

  /** Party management. Survives everything below it — that is its whole job. */
  party: {
    play: 'lobby',
    disband: 'mainMenu',
    back: 'mainMenu',
    fail: 'fault',
  },

  /** Mode, map and loadout selection. The idle home of an assembled party. */
  lobby: {
    search: 'matchmaking',
    party: 'party',
    leave: 'mainMenu',
    fail: 'fault',
  },

  /** Looking for a session (or standing one up locally). */
  matchmaking: {
    found: 'loading',
    cancel: 'lobby',
    timeout: 'lobby',
    unfillable: 'lobby',
    hostLost: 'migrating',
    dropped: 'lobby',
    fail: 'fault',
  },

  /** Map/asset load and the first authoritative snapshot. */
  loading: {
    loaded: 'preMatch',
    loadFailed: 'lobby',
    abort: 'lobby',
    hostLost: 'migrating',
    dropped: 'lobby',
    fail: 'fault',
  },

  /** Spawn selected, weapons holstered, countdown running. Non-scoring. */
  preMatch: {
    go: 'live',
    abort: 'lobby',
    hostLost: 'migrating',
    dropped: 'lobby',
    fail: 'fault',
  },

  /** The match. `MatchRunner` owns everything inside this state. */
  live: {
    finished: 'postMatch',
    abandon: 'afterAction',
    hostLost: 'migrating',
    dropped: 'afterAction',
    fail: 'fault',
  },

  /** Frozen scoreboard / final killcam. Simulation is stopped but rendering is not. */
  postMatch: {
    report: 'afterAction',
    hostLost: 'migrating',
    dropped: 'afterAction',
    fail: 'fault',
  },

  /** After-action report: XP ledger, rank-up, unlocks, replay handle. */
  afterAction: {
    toLobby: 'lobby',
    toMenu: 'mainMenu',
    rematch: 'loading',
    fail: 'fault',
  },

  /**
   * Host migration. Explicit resume events rather than "go back where you
   * came from", so the table stays total and the netcode layer has to say
   * what it actually reconnected into.
   */
  migrating: {
    resumeLobby: 'lobby',
    resumeLoading: 'loading',
    resumeLive: 'live',
    resumePostMatch: 'postMatch',
    migrateFailed: 'lobby',
    fail: 'fault',
  },

  /** Something broke badly enough that we cannot continue where we were. */
  fault: {
    recover: 'mainMenu',
    quit: 'shutdown',
  },

  /** Terminal. */
  shutdown: {
  },
} as const;

type Table = typeof FLOW;

/** Every state in the journey. */
export type FlowState = keyof Table;

/** The events legal from a given state — and nothing else. */
export type FlowEventOf<S extends FlowState> = Extract<keyof Table[S], string>;

/** Where a legal `(state, event)` pair lands. */
export type FlowTargetOf<S extends FlowState, E extends FlowEventOf<S>> =
  Extract<Table[S][E], FlowState>;

/** The union of every event name in the table. */
export type FlowEvent = { [S in FlowState]: FlowEventOf<S> }[FlowState];

export const FLOW_STATES = Object.keys(FLOW) as readonly FlowState[];

/* --------------------------------------------------------------- metadata -- */

/**
 * Per-state facts other systems need. `screen` deliberately uses the names
 * already in `src/ui/UiEvents.ts` (`UiScreenName`) so the UI module can map a
 * flow state onto a screen without a translation table; states the UI has no
 * screen for yet fall back to the nearest existing one and are called out in
 * `docs/SESSION.md`.
 */
export interface FlowMeta {
  /** All-caps label for status lines. */
  label: string;
  group: 'boot' | 'frontend' | 'match' | 'recovery';
  /** True while `MatchRunner` should be simulating. */
  inMatch: boolean;
  /** True when the state is meaningless without a live network session. */
  needsNet: boolean;
  /** Suggested `UiScreenName`. */
  screen: 'none' | 'main' | 'loadout' | 'settings' | 'pause' | 'summary';
  /** True when the fixed-step simulation clock should run at scale 1. */
  simulate: boolean;
}

export const FLOW_META: Readonly<Record<FlowState, FlowMeta>> = {
  boot: { label: 'BOOTING', group: 'boot', inMatch: false, needsNet: false, screen: 'none', simulate: false },
  mainMenu: { label: 'MAIN MENU', group: 'frontend', inMatch: false, needsNet: false, screen: 'main', simulate: false },
  party: { label: 'PARTY', group: 'frontend', inMatch: false, needsNet: false, screen: 'main', simulate: false },
  lobby: { label: 'LOBBY', group: 'frontend', inMatch: false, needsNet: false, screen: 'main', simulate: false },
  matchmaking: { label: 'SEARCHING', group: 'frontend', inMatch: false, needsNet: false, screen: 'main', simulate: false },
  loading: { label: 'LOADING', group: 'match', inMatch: false, needsNet: false, screen: 'none', simulate: false },
  preMatch: { label: 'PREPARE', group: 'match', inMatch: true, needsNet: false, screen: 'none', simulate: true },
  live: { label: 'LIVE', group: 'match', inMatch: true, needsNet: false, screen: 'none', simulate: true },
  postMatch: { label: 'MATCH OVER', group: 'match', inMatch: true, needsNet: false, screen: 'none', simulate: false },
  afterAction: { label: 'AFTER ACTION', group: 'match', inMatch: false, needsNet: false, screen: 'summary', simulate: false },
  migrating: { label: 'RECONNECTING', group: 'recovery', inMatch: false, needsNet: true, screen: 'none', simulate: false },
  fault: { label: 'ERROR', group: 'recovery', inMatch: false, needsNet: false, screen: 'main', simulate: false },
  shutdown: { label: 'SHUTTING DOWN', group: 'recovery', inMatch: false, needsNet: false, screen: 'none', simulate: false },
};

/* ------------------------------------------------------------ transitions -- */

export interface FlowTransition {
  from: FlowState;
  to: FlowState;
  event: string;
  /** Free-form provenance: 'local', 'ui', 'host', 'timeout', 'adopt', … */
  reason: string;
  /** Monotonic; the netcode layer orders authoritative updates with this. */
  seq: number;
  /** Seconds of session time when it happened. */
  at: number;
  /** True when the netcode layer snapped us here rather than us deciding. */
  authoritative: boolean;
}

/** Typed view of the machine while it is provably in one specific state. */
export interface FlowHandle<S extends FlowState> {
  readonly state: S;
  /** Only events legal from `S` type-check here. */
  send<E extends FlowEventOf<S>>(event: E, reason?: string): FlowTransition;
  /** Compile-time lookup of where an event would land. */
  target<E extends FlowEventOf<S>>(event: E): FlowTargetOf<S, E>;
}

const TABLE = FLOW as unknown as Record<string, Record<string, string> | undefined>;

/** Runtime lookup used by the dynamic path. */
export function nextState(from: FlowState, event: string): FlowState | null {
  const row = TABLE[from];
  const to = row ? row[event] : undefined;
  return (to as FlowState | undefined) ?? null;
}

export function legalEvents(from: FlowState): readonly string[] {
  const row = TABLE[from];
  return row ? Object.keys(row) : [];
}

/**
 * Shortest legal event sequence from `from` to `to`, or null when unreachable.
 * Used to fast-forward the machine when we adopt a match that is already
 * running, and by the verification harness to walk the journey without
 * hard-coding it.
 *
 * Recovery states (`migrating`, `fault`, `shutdown`) are never used as
 * *stepping stones*, only as destinations. Without that rule the shortest path
 * from `boot` to `live` runs `search → hostLost → resumeLive`, which is legal,
 * shorter, and completely wrong: planning a journey through error handling
 * would make the UI flash "RECONNECTING" on a clean single-player boot.
 */
export function route(from: FlowState, to: FlowState): readonly string[] | null {
  if (from === to) return [];
  const seen = new Set<FlowState>([from]);
  const queue: Array<{ state: FlowState; path: string[] }> = [{ state: from, path: [] }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const event of legalEvents(cur.state)) {
      const next = nextState(cur.state, event);
      if (!next || seen.has(next)) continue;
      const path = [...cur.path, event];
      if (next === to) return path;
      seen.add(next);
      if (FLOW_META[next].group === 'recovery') continue;
      queue.push({ state: next, path });
    }
  }
  return null;
}

/** Structural check of the table itself. The harness asserts on this. */
export function validateFlow(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const states = new Set<string>(FLOW_STATES);
  for (const state of FLOW_STATES) {
    if (!FLOW_META[state]) problems.push(`state "${state}" has no metadata`);
    for (const event of legalEvents(state)) {
      const to = nextState(state, event);
      if (!to || !states.has(to)) problems.push(`${state}.${event} → "${to}" is not a state`);
    }
  }
  // Every state except the terminal one must be reachable from boot, and every
  // non-terminal state must be able to reach the lobby again.
  for (const state of FLOW_STATES) {
    if (state !== 'boot' && route('boot', state) === null) problems.push(`"${state}" is unreachable from boot`);
    if (state !== 'shutdown' && route(state, 'lobby') === null) problems.push(`"${state}" cannot return to the lobby`);
  }
  return { ok: problems.length === 0, problems };
}

const HISTORY_LIMIT = 64;

/* ------------------------------------------------------------------- Flow -- */

export class Flow {
  private cur: FlowState;
  private prev: FlowState;
  private n = 0;
  private t = 0;
  private stateT = 0;
  private why = 'init';
  private readonly log: FlowTransition[] = [];
  private listeners = new Set<(t: FlowTransition) => void>();

  constructor(start: FlowState = 'boot') {
    this.cur = start;
    this.prev = start;
  }

  get state(): FlowState { return this.cur; }
  get previous(): FlowState { return this.prev; }
  /** Monotonic transition counter; also the netcode ordering key. */
  get seq(): number { return this.n; }
  /** Seconds since the machine was created. */
  get time(): number { return this.t; }
  /** Seconds spent in the current state. */
  get elapsed(): number { return this.stateT; }
  get reason(): string { return this.why; }
  get meta(): FlowMeta { return FLOW_META[this.cur]; }
  get history(): readonly FlowTransition[] { return this.log; }

  /** Advances the state clock. Purely bookkeeping — no transitions fire here. */
  tick(dt: number): void {
    if (!(dt > 0)) return;
    this.t += dt;
    this.stateT += dt;
  }

  /**
   * A typed handle, or null when we are not in `state`. This is the safe path:
   * the returned handle only accepts events legal from that state.
   */
  at<S extends FlowState>(state: S): FlowHandle<S> | null {
    if (this.cur !== state) return null;
    const flow = this;
    return {
      state,
      send<E extends FlowEventOf<S>>(event: E, reason = 'local'): FlowTransition {
        const t = flow.send(event as string, reason);
        // Unreachable: the type system already proved this pair is in the table.
        if (!t) throw new Error(`[Flow] "${String(event)}" is not legal from "${state}"`);
        return t;
      },
      target<E extends FlowEventOf<S>>(event: E): FlowTargetOf<S, E> {
        return nextState(state, event as string) as FlowTargetOf<S, E>;
      },
    };
  }

  /** True when `event` is legal right now. */
  can(event: string): boolean { return nextState(this.cur, event) !== null; }

  /** Every event name legal right now — the UI renders its buttons from this. */
  legal(): readonly string[] { return legalEvents(this.cur); }

  /**
   * Dynamic transition. Returns null (and changes nothing) when the event is
   * not legal from the current state. Callers that know the state at compile
   * time should use `at()` instead.
   */
  send(event: string, reason = 'local'): FlowTransition | null {
    const to = nextState(this.cur, event);
    if (!to) return null;
    return this.commit(to, event, reason, false);
  }

  /** Same as `send`, but throws instead of returning null. */
  must(event: FlowEvent, reason = 'local'): FlowTransition {
    const t = this.send(event, reason);
    if (!t) {
      throw new Error(
        `[Flow] illegal transition "${this.cur}" --${event}--> (legal: ${this.legal().join(', ') || 'none'})`,
      );
    }
    return t;
  }

  /**
   * Snap to a state on someone else's authority (the session host). This is the
   * only way to reach a state without a legal edge, and it is reserved for the
   * netcode layer: a client must never invent a state, but it must be able to
   * follow the host anywhere. Stale updates (`seq` at or behind ours) are
   * ignored so out-of-order packets cannot rewind the front end.
   */
  adopt(state: FlowState, seq: number, reason = 'host'): FlowTransition | null {
    if (seq <= this.n) return null;
    if (state === this.cur) { this.n = seq; return null; }
    const t = this.commit(state, this.eventFor(state) ?? 'authority', reason, true);
    this.n = seq;
    t.seq = seq;
    return t;
  }

  /** The event that would take us to `to` from here, when one exists. */
  eventFor(to: FlowState): string | null {
    for (const event of this.legal()) if (nextState(this.cur, event) === to) return event;
    return null;
  }

  /** Shortest legal path from here to `to`, or null. */
  routeTo(to: FlowState): readonly string[] | null { return route(this.cur, to); }

  /**
   * Walks `routeTo(to)`, firing every intermediate transition. Returns the
   * events taken, or null when `to` is unreachable. Used when the session
   * adopts a match that started before the flow existed.
   */
  fastForward(to: FlowState, reason = 'adopt'): readonly string[] | null {
    const path = this.routeTo(to);
    if (!path) return null;
    for (const event of path) {
      if (!this.send(event, reason)) return null;
    }
    return path;
  }

  onTransition(fn: (t: FlowTransition) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  reset(state: FlowState = 'boot'): void {
    this.cur = state;
    this.prev = state;
    this.n = 0;
    this.t = 0;
    this.stateT = 0;
    this.why = 'reset';
    this.log.length = 0;
  }

  private commit(to: FlowState, event: string, reason: string, authoritative: boolean): FlowTransition {
    this.prev = this.cur;
    this.cur = to;
    this.n++;
    this.stateT = 0;
    this.why = reason;
    const t: FlowTransition = {
      from: this.prev, to, event, reason, seq: this.n, at: this.t, authoritative,
    };
    this.log.push(t);
    if (this.log.length > HISTORY_LIMIT) this.log.shift();
    for (const fn of this.listeners) {
      try { fn(t); } catch (err) { console.error('[Flow] transition listener threw', err); }
    }
    return t;
  }
}
