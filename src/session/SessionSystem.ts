/**
 * SessionSystem — the spine that turns seven independent systems into one game.
 *
 * It owns `Flow` (the player journey), resolves every surrounding system as an
 * optional *port*, and degrades to a fully playable local session when none of
 * them are present. That degradation is the load-bearing property: with no
 * network, no lobby service and no matchmaker, the flow still walks
 * boot → menu → lobby → search → load → pre-match → live → after-action → lobby,
 * and the live state is the single-player match this game already shipped.
 *
 * ## Authority
 *
 * The host decides; clients request and display. Every inbound intent — from the
 * UI, from another peer — arrives as a *request*:
 *
 *     bus.emit('session:request', { event: 'search' })
 *
 * `requestEvent()` applies it locally when we are the host or offline, and
 * forwards it to `NetPort.requestFlow` otherwise. A client only ever changes
 * state through `Flow.adopt()`, driven by the host's broadcast. Nothing in this
 * file mutates another system's state directly.
 *
 * ## What it must never do
 *
 * Start a match that is already running. `GameDirector` boots a match on its own
 * today; when it has, the session *adopts* it — fast-forwards the flow to `live`
 * without touching the director — so the existing single-player experience is
 * bit-for-bit unchanged. In capture mode it does nothing at all.
 *
 * See `docs/SESSION.md` for the journey, the event contract and the failure
 * matrix.
 */

import type { EngineContext, System } from '../core/Engine';
import { ORDER } from '../core/Engine';
import { bus, type EventBus } from '../core/EventBus';
import { CAPTURE_MODE } from '../core/Capture';
import { Rand } from '../core/Rand';
import { Flow, FLOW_META, type FlowEvent, type FlowState, type FlowTransition } from './Flow';
import type { GameModeId, MatchPhase, MatchSummary } from '../game/types';
import type {
  LobbyPhase, LobbySelection, MatchConfig, PlayerId, SessionTeam,
} from './types';
import type { ConnectionState, NetRole } from '../net/types';

/* ------------------------------------------------------------------ ports -- */

/**
 * One seat in the session, flattened from `MemberState` in `./types`. The
 * session needs far less than the lobby read model carries, and keeping the
 * narrow shape here means a lobby implementation can land, change or vanish
 * without touching this file.
 */
export interface SessionMember {
  id: PlayerId;
  name: string;
  team: SessionTeam;
  bot: boolean;
  host: boolean;
  leader: boolean;
  ready: boolean;
  /** 0..1 while loading. */
  loadProgress: number;
  ping: number;
  rank: number;
  /** True for the player sitting at this machine. */
  local: boolean;
}

export interface SessionLobbyView {
  phase: LobbyPhase;
  hostId: PlayerId;
  members: readonly SessionMember[];
  selection: LobbySelection;
  /** Seconds left on the lobby countdown, or -1. */
  countdown: number;
  connected: number;
  capacity: number;
  /** Renderable status line, e.g. "WAITING FOR 2 MORE PLAYERS". */
  message: string;
}

/** What the session needs from a lobby service. Everything optional. */
export interface LobbyPort {
  view(): SessionLobbyView;
  setMode?(mode: GameModeId): void;
  requestLaunch?(): void;
  requestCancel?(): void;
  tick?(dt: number): void;
}

export interface SearchRequest {
  mode: GameModeId;
  party: readonly SessionMember[];
  /** Seconds after which the caller wants a bot-filled session instead. */
  patience: number;
  seed: number;
}

export interface SearchStatus {
  state: 'idle' | 'searching' | 'found' | 'failed';
  elapsed: number;
  /** Human players found so far. */
  players: number;
  /** Human players wanted. */
  target: number;
  region: string;
  error: string | null;
}

/** What the session needs from a matchmaker. */
export interface MatchmakingPort {
  search(req: SearchRequest): void;
  cancel(): void;
  status(): SearchStatus;
  /** The launch order once `status().state === 'found'`. */
  result(): MatchLaunch | null;
  tick?(dt: number): void;
}

/**
 * The launch order. A structural subset of `MatchConfig` in `./types` — the
 * fields the session actually acts on — so a matchmaker may hand us the full
 * `MatchConfig` and it just fits.
 */
export interface MatchLaunch {
  modeId: GameModeId;
  mapId: string;
  levelId?: string;
  seed: number;
  roster?: ReadonlyArray<{ id: string; name: string; bot: boolean; team?: SessionTeam }>;
  matchIndex?: number;
}

export interface LoadStatus {
  progress: number;
  done: boolean;
  error: string | null;
}

/** What the session needs from map/level loading. */
export interface MapLoadPort {
  begin(launch: MatchLaunch): void;
  status(): LoadStatus;
  cancel?(): void;
  tick?(dt: number): void;
}

/** The slice of `DirectorAPI` the session drives. */
export interface MatchPort {
  readonly phase: MatchPhase;
  readonly mode: GameModeId;
  startMatch(mode: GameModeId, seed?: number): void;
  endMatch(win: boolean): void;
}

/** What the session needs from the loadout service — display only, for now. */
export interface LoadoutPort {
  /** Name of the class the local player deploys with. */
  activeName(): string;
  /** True when the class is legal for the local player's unlocks. */
  valid?(): boolean;
}

/** Read-only progression facts for the lobby card and the after-action report. */
export interface ProgressionPort {
  rank(): number;
  rankName(): string;
  xp(): number;
  /** XP into the current rank and what the next one costs. */
  progress(): { into: number; needed: number };
}

/**
 * The netcode seam. `src/net/` is being built in parallel; this is deliberately
 * four members wide so anything they ship satisfies it. When it is null the
 * session behaves as an offline host, which is the single-player case.
 */
export interface NetPort {
  readonly role: NetRole;
  readonly connection: ConnectionState;
  readonly localId: string;
  /** Client → host: "I would like this to happen." Never applied locally. */
  requestFlow?(event: string, reason?: string): void;
  /** Host → clients: "this is where the session is now." */
  publishFlow?(state: FlowState, seq: number): void;
}

export interface SessionPorts {
  lobby: LobbyPort | null;
  matchmaking: MatchmakingPort | null;
  mapLoad: MapLoadPort | null;
  match: MatchPort | null;
  loadout: LoadoutPort | null;
  progression: ProgressionPort | null;
  net: NetPort | null;
}

/* ----------------------------------------------------------------- config -- */

/**
 * The meta-layer objects a build chose to install, kept so anything holding the
 * `SessionSystem` can find them. Deliberately opaque: each subsystem owns its
 * own contract, and re-declaring those here would make this file the place they
 * all have to agree, which is exactly what ports exist to avoid.
 */
export interface SessionSubsystems {
  lobby: object | null;
  matchmaking: object | null;
  loadout: object | null;
  spawns: object | null;
  replay: object | null;
}

export interface SessionConfig {
  /** Seconds the lobby idles before searching. -1 waits for the player. */
  lobbyDwell: number;
  /** Seconds to wait for human players before filling with bots. */
  searchPatience: number;
  /**
   * Hard search failure after this. It is a *hang detector*, not a patience
   * knob: the matchmaker owns the decision to give up and bot-fill (its own
   * `hardTimeout` is 120 s on the core playlists), so this must sit above that
   * or the session cancels searches the matchmaker would have resolved.
   */
  searchTimeout: number;
  /** Hard load failure after this. */
  loadTimeout: number;
  /** Pre-match countdown. */
  preMatch: number;
  /** Frozen scoreboard beat after the match ends. */
  postMatch: number;
  /** After-action dwell before returning to the lobby. -1 waits for the player. */
  afterAction: number;
  /** Host-migration window before we give up and drop to the lobby. */
  migrate: number;
  /** Snapshot publish period in seconds. */
  publishPeriod: number;
  /** Fill an unfillable session with bots rather than failing. */
  botFill: boolean;
}

export function defaultSessionConfig(patch: Partial<SessionConfig> = {}): SessionConfig {
  return {
    lobbyDwell: -1,
    searchPatience: 6,
    searchTimeout: 25,
    loadTimeout: 30,
    preMatch: 4,
    postMatch: 6,
    afterAction: 12,
    migrate: 8,
    publishPeriod: 0.25,
    botFill: true,
    ...patch,
  };
}

/* --------------------------------------------------------------- read model -- */

export type SessionFaultKind =
  | 'boot' | 'search-timeout' | 'unfillable' | 'load-failed' | 'load-timeout'
  | 'host-lost' | 'migrate-failed' | 'disconnected' | 'match-failed' | 'internal';

export interface SessionFault {
  kind: SessionFaultKind;
  /** All-caps headline, renderable verbatim. */
  title: string;
  detail: string;
  /** True when the player can retry from where they were. */
  recoverable: boolean;
  at: number;
}

/** The after-action report, assembled once per match. */
export interface SessionReport {
  mode: GameModeId;
  map: string;
  win: boolean;
  summary: MatchSummary | null;
  rankBefore: number;
  rankAfter: number;
  rankName: string;
  xpEarned: number;
  xpIntoRank: number;
  xpForNext: number;
  /** True when the match ended because we left/dropped, so nothing was banked. */
  abandoned: boolean;
  /** Deterministic fingerprint, for the replay handle. */
  replayHash: string;
  seed: number;
}

/** Everything the UI needs to draw any front-end screen, in one object. */
export interface SessionSnapshot {
  state: FlowState;
  previous: FlowState;
  seq: number;
  /** Seconds in the current state. */
  elapsed: number;
  /** Renderable state label, e.g. "SEARCHING". */
  label: string;
  /** Suggested `UiScreenName` — see `FLOW_META`. */
  screen: string;

  online: boolean;
  isHost: boolean;
  connection: ConnectionState;
  localId: string;

  mode: GameModeId;
  map: string;
  loadoutName: string;

  members: readonly SessionMember[];
  partySize: number;
  /** Human players found; equals `members.length` minus bots. */
  humans: number;

  /** Seconds to the next automatic transition, or -1 when we are waiting. */
  countdown: number;
  countdownLabel: string;
  searchElapsed: number;
  searchTarget: number;
  loadProgress: number;

  rank: number;
  rankName: string;
  xpIntoRank: number;
  xpForNext: number;

  /** Flow events legal right now — the UI renders its buttons from this. */
  legal: readonly string[];
  statusLine: string;
  fault: SessionFault | null;
  report: SessionReport | null;
  /** Non-null while the session is running on a fallback instead of a real service. */
  degraded: readonly string[];
}

/* ------------------------------------------------------------------ events -- */

declare module '../core/EventBus' {
  interface GameEvents {
    /** Fired on every flow transition. The one event the UI must handle. */
    'session:state': {
      state: FlowState; previous: FlowState; event: string; reason: string;
      seq: number; authoritative: boolean; online: boolean; isHost: boolean;
    };
    /** Throttled full read model. Read it, do not retain it. */
    'session:snapshot': SessionSnapshot;
    /** UI/peer → session. The ONLY inbound channel; the host decides. */
    'session:request': { event: string; reason?: string };
    /** Seconds ticking down to an automatic transition. */
    'session:countdown': { seconds: number; total: number; label: string };
    /** Matchmaking progress. */
    'session:search': { elapsed: number; players: number; target: number; region: string };
    /** Map/level load progress. */
    'session:load': { map: string; progress: number; done: boolean };
    /** Something went wrong. Always paired with a flow transition. */
    'session:fault': SessionFault;
    /** After-action report, once per match. */
    'session:report': SessionReport;
    /** Free-form toast for the front end. */
    'session:notice': { text: string; kind: 'info' | 'warn' | 'error' };
  }
}

/* --------------------------------------------------------------- fallbacks -- */

const VALID_MODES: readonly GameModeId[] = ['operation', 'tdm', 'firefight'];

/**
 * The UI's main menu currently deploys with `mode: 'domination'`, which is not
 * a mode this build ships. Rather than break the button, map unknown ids onto
 * the nearest thing that exists and say so in the log. Documented in
 * `docs/SESSION.md` under "Reconciliations".
 */
export function normaliseMode(id: string | undefined | null): GameModeId {
  if (id && (VALID_MODES as readonly string[]).includes(id)) return id as GameModeId;
  switch (id) {
    case 'domination': case 'hardpoint': case 'deathmatch': case 'ffa': return 'tdm';
    case 'survival': case 'zombies': case 'horde': return 'firefight';
    default: return 'operation';
  }
}

function localMember(id: string, name: string, rank: number): SessionMember {
  return {
    id, name, team: 'alpha', bot: false, host: true, leader: true, ready: true,
    loadProgress: 1, ping: 0, rank, local: true,
  };
}

function botMember(id: string, name: string, team: SessionTeam): SessionMember {
  return {
    id, name, team, bot: true, host: false, leader: false, ready: true,
    loadProgress: 1, ping: 0, rank: 1, local: false,
  };
}

/** Solo lobby: one seat, the local player's, mode from the URL or the profile. */
class LocalLobby implements LobbyPort {
  phase: LobbyPhase = 'forming';
  members: SessionMember[];
  selection: LobbySelection;

  constructor(mode: GameModeId, map: string, seed: number, me: SessionMember) {
    this.members = [me];
    this.selection = {
      mapId: map, mapName: map.toUpperCase().replace(/[_-]/g, ' '),
      modeId: mode, modeName: modeName(mode), seed,
    };
  }

  view(): SessionLobbyView {
    return {
      phase: this.phase,
      hostId: this.members[0]?.id ?? 'local',
      members: this.members,
      selection: this.selection,
      countdown: -1,
      connected: this.members.length,
      capacity: 12,
      message: 'PRIVATE LOBBY',
    };
  }

  setMode(mode: GameModeId): void {
    this.selection.modeId = mode;
    this.selection.modeName = modeName(mode);
  }
}

/**
 * Solo matchmaker: never finds a human, so it always falls through to the bot
 * fill after `patience` seconds. That is not a stub — it is the correct
 * behaviour for an offline session, and it exercises the same timeout edge the
 * real matchmaker will.
 */
class LocalMatchmaking implements MatchmakingPort {
  private req: SearchRequest | null = null;
  private t = 0;
  private launch: MatchLaunch | null = null;
  private st: SearchStatus['state'] = 'idle';

  constructor(private map: string, private botFill: boolean) { }

  search(req: SearchRequest): void {
    this.req = req;
    this.t = 0;
    this.st = 'searching';
    this.launch = null;
  }

  cancel(): void { this.st = 'idle'; this.req = null; this.launch = null; }

  status(): SearchStatus {
    return {
      state: this.st,
      elapsed: this.t,
      players: this.req ? this.req.party.length : 0,
      target: this.req ? this.req.party.length : 1,
      region: 'local',
      error: this.st === 'failed' ? 'no session could be formed' : null,
    };
  }

  result(): MatchLaunch | null { return this.launch; }

  tick(dt: number): void {
    if (this.st !== 'searching' || !this.req) return;
    this.t += dt;
    if (this.t < this.req.patience) return;
    if (!this.botFill) { this.st = 'failed'; return; }
    this.st = 'found';
    this.launch = {
      modeId: this.req.mode, mapId: this.map, seed: this.req.seed, matchIndex: 0,
      roster: this.req.party.map((m) => ({ id: m.id, name: m.name, bot: m.bot, team: m.team })),
    };
  }
}

/**
 * The level is already in memory — `WorldSystem` builds it at boot — so the
 * local loader only has to pace the transition. It still reports progress so
 * the load screen is real rather than a fixed splash.
 */
class InstantMapLoad implements MapLoadPort {
  private t = 0;
  private running = false;
  private map = '';

  begin(launch: MatchLaunch): void { this.t = 0; this.running = true; this.map = launch.mapId; }
  cancel(): void { this.running = false; }

  status(): LoadStatus {
    const p = this.running ? Math.min(1, this.t / 0.6) : 0;
    return { progress: p, done: this.running && p >= 1, error: null };
  }

  tick(dt: number): void { if (this.running) this.t += dt; }
  get mapId(): string { return this.map; }
}

function modeName(id: GameModeId): string {
  return id === 'tdm' ? 'Team Deathmatch' : id === 'firefight' ? 'Firefight' : 'Operation';
}

/* ------------------------------------------------------------------ system -- */

export interface SessionOptions {
  config?: Partial<SessionConfig>;
  ports?: Partial<SessionPorts>;
  /** Private bus for tests; defaults to the global one. */
  bus?: EventBus;
  seed?: number;
  /** Display name of the local player. */
  playerName?: string;
  map?: string;
  mode?: GameModeId;
  /** Never auto-start a match (capture mode sets this). */
  passive?: boolean;
}

export class SessionSystem implements System {
  readonly name = 'session';
  /** Just ahead of `director` so the session decides before the match steps. */
  readonly order = ORDER.GAMEPLAY - 10;

  readonly flow = new Flow('boot');
  readonly config: SessionConfig;
  readonly ports: SessionPorts;
  /**
   * Raw handles for the subsystems this session was installed with. Discovery
   * only — `src/game/Services.ts` reads this to find the meta layer without
   * importing it. The session drives subsystems through `ports`, never here.
   */
  readonly subsystems: SessionSubsystems = {
    lobby: null, matchmaking: null, loadout: null, spawns: null, replay: null,
  };

  private readonly bus: EventBus;
  private readonly rng: Rand;
  private readonly degraded = new Set<string>();
  private readonly unsubs: Array<() => void> = [];

  private me: SessionMember;
  private members: SessionMember[];
  private mode: GameModeId;
  private map: string;
  private seed: number;
  private passive: boolean;

  private fault: SessionFault | null = null;
  private report: SessionReport | null = null;
  private lastSummary: MatchSummary | null = null;
  private abandoned = false;
  /** True when the director started this match before we existed. */
  private adopted = false;
  /** True while `adoptRunningMatch` is fast-forwarding; suppresses side effects. */
  private adopting = false;
  /** True once we have asked the director to start the current match. */
  private launched = false;
  private launch: MatchLaunch | null = null;
  private publishAcc = 0;
  private countdown = -1;
  private countdownTotal = 0;
  private countdownLabel = '';
  private lastCountdownSent = -1;
  private resumeFrom: FlowState = 'lobby';
  private snap: SessionSnapshot;
  /** Stand-in view used only until a real lobby has state. */
  private fallbackLobby: LocalLobby | null = null;

  constructor(opts: SessionOptions = {}) {
    this.config = defaultSessionConfig(opts.config);
    this.bus = opts.bus ?? bus;
    this.seed = opts.seed ?? 1337;
    this.rng = new Rand(this.seed);
    this.mode = opts.mode ?? 'operation';
    this.map = opts.map ?? 'blackout';
    this.passive = opts.passive ?? CAPTURE_MODE;

    this.me = localMember('local', opts.playerName ?? 'OPERATOR', 1);
    this.members = [this.me];

    this.ports = {
      lobby: opts.ports?.lobby ?? null,
      matchmaking: opts.ports?.matchmaking ?? null,
      mapLoad: opts.ports?.mapLoad ?? null,
      match: opts.ports?.match ?? null,
      loadout: opts.ports?.loadout ?? null,
      progression: opts.ports?.progression ?? null,
      net: opts.ports?.net ?? null,
    };

    this.snap = this.buildSnapshot();
    this.flow.onTransition((t) => this.onTransition(t));
  }

  /* ------------------------------------------------------------- lifecycle -- */

  /** Engine entry point. Resolves ports from the registry, then boots. */
  init(ctx: EngineContext): void {
    this.resolveFromEngine(ctx);
    this.boot();
  }

  /**
   * Headless entry point: supply ports directly, skip the engine entirely.
   * `tools/session-flow.mjs` drives the whole journey through this.
   */
  attach(ports: Partial<SessionPorts>): void {
    for (const key of Object.keys(ports) as Array<keyof SessionPorts>) {
      const v = ports[key];
      if (v !== undefined) (this.ports as unknown as Record<string, unknown>)[key] = v;
    }
  }

  /**
   * Fills in whatever the engine can provide. Every lookup is duck-typed and
   * optional — exactly the pattern `src/game/Services.ts` uses — so a system
   * that has not landed yet, or one that changed shape, costs us a fallback
   * rather than a crash.
   */
  private resolveFromEngine(ctx: EngineContext): void {
    const e = ctx.engine;
    this.ports.match ??= asMatchPort(e.tryGet('director'));
    this.ports.lobby ??= lobbyPortFrom(e.tryGet('lobby'), () => this.baselineLobbyView());
    this.ports.matchmaking ??= matchmakingPortFrom(e.tryGet('matchmaking'), { map: this.map });
    this.ports.mapLoad ??= asMapLoadPort(e.tryGet('maploader') ?? e.tryGet('world'));
    this.ports.loadout ??= loadoutPortFrom(e.tryGet('loadout'));
    this.ports.net ??= asNetPort(e.tryGet('net'));
    this.ports.progression ??= asProgressionPort(e.tryGet('director'));
  }

  /**
   * What the front end shows while a real lobby is still coming up: our own
   * party, our own selection. Never authoritative — the moment the lobby
   * module has a `LobbyState`, that wins.
   */
  private baselineLobbyView(): SessionLobbyView {
    this.fallbackLobby ??= new LocalLobby(this.mode, this.map, this.seed, this.me);
    return this.fallbackLobby.view();
  }

  /** Installs fallbacks, subscribes to the bus and leaves `boot`. */
  boot(): void {
    if (!this.ports.net) this.degraded.add('net');
    if (!this.ports.loadout) this.degraded.add('loadout');
    if (!this.ports.progression) this.degraded.add('progression');

    if (this.ports.net) {
      this.me = { ...this.me, id: this.ports.net.localId || this.me.id, host: this.isHost };
      this.members = [this.me, ...this.members.slice(1)];
    }

    if (!this.ports.lobby) {
      this.degraded.add('lobby');
      this.ports.lobby = new LocalLobby(this.mode, this.map, this.seed, this.me);
    }
    if (!this.ports.matchmaking) {
      this.degraded.add('matchmaking');
      this.ports.matchmaking = new LocalMatchmaking(this.map, this.config.botFill);
    }
    if (!this.ports.mapLoad) {
      this.degraded.add('mapLoad');
      this.ports.mapLoad = new InstantMapLoad();
    }
    if (!this.ports.match) this.degraded.add('match');

    this.subscribe();

    // Leaving `boot` is always a local decision: you cannot be in somebody
    // else's session before your own systems have come up. Everything after
    // this point goes through `request()` and obeys authority.
    this.flow.at('boot')?.send('ready', 'boot');
    this.adoptRunningMatch();
  }

  private subscribe(): void {
    const b = this.bus;
    this.unsubs.push(b.on('session:request', (p) => this.request(p.event, p.reason ?? 'ui')));

    // The match layer announces its own start; a *front-end* state means the UI
    // pressed Deploy, anything else is `MatchRunner` echoing our own launch.
    this.unsubs.push(b.on('game:start', (p) => {
      if (!this.inFrontEnd()) return;
      this.deploy(normaliseMode(p.mode), 'ui:deploy');
    }));

    this.unsubs.push(b.on('match:summary', (s) => { this.lastSummary = s; }));
    this.unsubs.push(b.on('game:over', () => {
      if (this.flow.state === 'live') this.request('finished', 'match');
    }));

    /*
     * The lobby module (`src/session/lobby`) has not declared its events on the
     * bus yet, so we subscribe structurally and validate at runtime. When the
     * typed keys land this becomes a plain `b.on('lobby:launch', ...)`.
     */
    const loose = b as unknown as {
      on(key: string, fn: (p: unknown) => void): () => void;
    };
    this.unsubs.push(loose.on('lobby:launch', (p) => this.onLobbyLaunch(p)));
  }

  /**
   * Accepts a `MatchConfig` from the lobby module without importing it at
   * runtime. Anything malformed is ignored rather than trusted.
   */
  private onLobbyLaunch(payload: unknown): void {
    const cfg = payload as Partial<MatchConfig> | null;
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.modeId !== 'string' || typeof cfg.seed !== 'number') return;
    const launch: MatchLaunch = {
      modeId: normaliseMode(cfg.modeId),
      mapId: typeof cfg.mapId === 'string' ? cfg.mapId : this.map,
      levelId: typeof cfg.levelId === 'string' ? cfg.levelId : undefined,
      seed: cfg.seed,
      matchIndex: typeof cfg.matchIndex === 'number' ? cfg.matchIndex : 0,
    };
    // Move the flow first: entering the lobby clears any pending launch order,
    // so recording ours before walking through it would throw it away.
    if (this.inFrontEnd()) this.request('deploy', 'lobby');
    this.launch = launch;
    this.setMode(launch.modeId);
    this.map = launch.mapId;
    this.seed = launch.seed;
    if (this.flow.state === 'matchmaking') this.request('found', 'lobby');
  }

  /**
   * If a match is already running we did not start it — adopt it. This is what
   * guarantees the single-player experience cannot regress: the director keeps
   * running exactly as it did, and the flow simply catches up to reality.
   */
  private adoptRunningMatch(): void {
    const m = this.ports.match;
    if (!m || m.phase === 'idle') return;
    this.setMode(m.mode);
    // Adoption is bookkeeping, not a journey: the intermediate states are still
    // announced (the UI must see them) but none of their side effects run —
    // entering `lobby` would clear the launch flags and entering `matchmaking`
    // would start a search for a match that is already being played.
    this.adopting = true;
    this.flow.fastForward('live', 'adopt');
    this.adopting = false;
    this.adopted = true;
    this.launched = true;
    if (m.phase === 'ending' || m.phase === 'ended') this.request('finished', 'adopt');
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  /* ---------------------------------------------------------------- intent -- */

  get isHost(): boolean {
    const n = this.ports.net;
    return !n || n.role === 'host' || n.role === 'offline';
  }

  get online(): boolean {
    const n = this.ports.net;
    return !!n && n.role !== 'offline' && n.connection !== 'offline' && n.connection !== 'closed';
  }

  /**
   * Apply an intent. The host applies it; a client forwards it and waits.
   * Returns the transition when one happened.
   *
   * `'deploy'` is the one pseudo-event: it is not a flow edge but a *goal*
   * ("get me into a match from wherever I am"), because the UI's Deploy button
   * fires from the main menu, the party screen and the after-action report, and
   * making every caller know the intermediate edges would be a trap.
   */
  request(event: string, reason = 'local'): FlowTransition | null {
    if (!this.isHost) {
      this.ports.net?.requestFlow?.(event, reason);
      return null;
    }
    if (event === 'deploy') return this.deployLocal(reason);
    return this.apply(event, reason);
  }

  /** Host-side application. Illegal events are dropped, never thrown. */
  private apply(event: string, reason: string): FlowTransition | null {
    const t = this.flow.send(event, reason);
    if (!t) return null;
    this.ports.net?.publishFlow?.(t.to, t.seq);
    return t;
  }

  /**
   * Follow the host. The only path a client changes state by; the netcode layer
   * calls this when an authoritative flow update arrives.
   */
  adopt(state: FlowState, seq: number, reason = 'host'): void {
    this.flow.adopt(state, seq, reason);
  }

  /** Typed convenience for callers that know where they are. */
  send(event: FlowEvent, reason = 'local'): FlowTransition | null {
    return this.request(event, reason);
  }

  /**
   * "Take me into a match." Walks the front-end edges needed to reach the
   * lobby, then starts the search. Safe from any front-end state; a no-op once
   * a match is already forming.
   */
  deploy(mode?: GameModeId, reason = 'ui'): FlowTransition | null {
    if (mode) this.setMode(mode);
    return this.request('deploy', reason);
  }

  private deployLocal(reason: string): FlowTransition | null {
    if (this.flow.state === 'afterAction') this.apply('toLobby', reason);
    if (this.flow.state === 'fault') this.apply('recover', reason);
    if (this.flow.state === 'mainMenu' || this.flow.state === 'party') this.apply('play', reason);
    return this.apply('search', reason);
  }

  setMode(mode: GameModeId): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.ports.lobby?.setMode?.(mode);
  }

  private inFrontEnd(): boolean {
    const s = this.flow.state;
    return s === 'mainMenu' || s === 'party' || s === 'lobby' || s === 'afterAction' || s === 'fault';
  }

  /* -------------------------------------------------------------- reactions -- */

  private onTransition(t: FlowTransition): void {
    this.countdown = -1;
    this.countdownLabel = '';
    this.lastCountdownSent = -1;

    if (this.adopting) { this.announce(t); return; }

    switch (t.to) {
      case 'lobby':
        this.launched = false;
        this.launch = null;
        this.adopted = false;
        this.abandoned = false;
        this.arm(this.config.lobbyDwell, 'READY');
        break;

      case 'matchmaking':
        this.beginSearch();
        break;

      case 'loading':
        this.beginLoad();
        break;

      case 'preMatch':
        this.arm(this.config.preMatch, 'DEPLOYING');
        break;

      case 'live':
        this.startMatchIfNeeded();
        break;

      case 'postMatch':
        this.arm(this.config.postMatch, 'MATCH OVER');
        break;

      case 'afterAction':
        this.buildReport();
        this.arm(this.config.afterAction, 'CONTINUE');
        break;

      case 'migrating':
        this.resumeFrom = t.from === 'migrating' ? this.resumeFrom : t.from;
        this.arm(this.config.migrate, 'RECONNECTING');
        break;

      case 'fault':
        break;

      default:
        break;
    }

    this.announce(t);
  }

  private announce(t: FlowTransition): void {
    this.bus.emit('session:state', {
      state: t.to, previous: t.from, event: t.event, reason: t.reason,
      seq: t.seq, authoritative: t.authoritative,
      online: this.online, isHost: this.isHost,
    });
    this.publish(true);
  }

  private arm(seconds: number, label: string): void {
    this.countdown = seconds;
    this.countdownTotal = seconds;
    this.countdownLabel = label;
  }

  private beginSearch(): void {
    const mm = this.ports.matchmaking;
    if (!mm) { this.raise('internal', 'NO MATCHMAKER', 'matchmaking port missing', false); return; }
    this.seed = (this.rng.u32() ^ this.seed) >>> 0;
    mm.search({
      mode: this.mode,
      party: this.members,
      patience: this.config.searchPatience,
      seed: this.seed,
    });
  }

  private beginLoad(): void {
    const launch = this.launch ?? this.ports.matchmaking?.result() ?? {
      modeId: this.mode, mapId: this.map, seed: this.seed,
    };
    this.launch = launch;
    this.setMode(normaliseMode(launch.modeId));
    this.map = launch.mapId || this.map;
    this.seed = launch.seed || this.seed;
    if (launch.roster && launch.roster.length) this.adoptRoster(launch.roster);
    this.ports.mapLoad?.begin(launch);
  }

  private adoptRoster(roster: NonNullable<MatchLaunch['roster']>): void {
    const next: SessionMember[] = [];
    for (const r of roster) {
      if (r.id === this.me.id) { next.push(this.me); continue; }
      next.push(r.bot
        ? botMember(r.id, r.name, r.team ?? 'bravo')
        : { ...botMember(r.id, r.name, r.team ?? 'bravo'), bot: false });
    }
    if (!next.some((m) => m.local)) next.unshift(this.me);
    this.members = next;
  }

  /**
   * The only place a match is ever started. `adopted` and `launched` between
   * them make a double-start impossible, which is the whole reason the existing
   * single-player boot path is safe.
   */
  private startMatchIfNeeded(): void {
    if (this.launched || this.adopted || this.passive) return;
    const m = this.ports.match;
    if (!m) { this.degraded.add('match'); this.launched = true; return; }
    this.launched = true;
    try {
      m.startMatch(this.mode, this.seed);
    } catch (err) {
      this.raise('match-failed', 'DEPLOY FAILED', String((err as Error)?.message ?? err), true, ['abort']);
    }
  }

  private buildReport(): void {
    const p = this.ports.progression;
    const s = this.lastSummary;
    const prog = p?.progress() ?? { into: 0, needed: 1 };
    this.report = {
      mode: this.mode,
      map: this.map,
      win: s?.win ?? false,
      summary: s,
      rankBefore: s?.rankBefore ?? p?.rank() ?? 1,
      rankAfter: s?.rankAfter ?? p?.rank() ?? 1,
      rankName: s?.rankName ?? p?.rankName() ?? 'Recruit',
      xpEarned: this.abandoned ? 0 : (s?.xpEarned ?? 0),
      xpIntoRank: s?.xpIntoRank ?? prog.into,
      xpForNext: s?.xpForNext ?? prog.needed,
      abandoned: this.abandoned,
      replayHash: s?.replayHash ?? '',
      seed: s?.seed ?? this.seed,
    };
    this.bus.emit('session:report', this.report);
  }

  /**
   * Records a fault and routes the flow out along the most specific legal exit.
   * `prefer` is tried in order first so the transition that gets logged says
   * what actually went wrong ('timeout', not the generic 'unfillable' that also
   * happens to leave `matchmaking`).
   */
  private raise(
    kind: SessionFaultKind, title: string, detail: string,
    recoverable: boolean, prefer: readonly string[] = [],
  ): void {
    this.fault = { kind, title, detail, recoverable, at: this.flow.time };
    this.bus.emit('session:fault', this.fault);
    this.bus.emit('session:notice', { text: `${title}: ${detail}`, kind: recoverable ? 'warn' : 'error' });
    if (!recoverable) { this.request('fail', kind); return; }
    for (const event of [...prefer, 'abort', 'cancel', 'migrateFailed', 'toLobby']) {
      if (this.flow.can(event) && this.request(event, kind)) return;
    }
    this.request('fail', kind);
  }

  /* --------------------------------------------------------------- signals -- */

  /** The netcode layer calls this when the session host disappears. */
  notifyHostLost(detail = 'host left the session'): void {
    this.fault = {
      kind: 'host-lost', title: 'HOST LOST', detail, recoverable: true, at: this.flow.time,
    };
    this.bus.emit('session:fault', this.fault);
    if (!this.request('hostLost', 'net')) this.request('fail', 'net');
  }

  /** The netcode layer calls this when *we* lose our connection. */
  notifyDropped(detail = 'connection lost'): void {
    this.fault = {
      kind: 'disconnected', title: 'CONNECTION LOST', detail, recoverable: true, at: this.flow.time,
    };
    this.bus.emit('session:fault', this.fault);
    this.abandoned = this.flow.state === 'live';
    if (!this.request('dropped', 'net')) this.request('fail', 'net');
  }

  /** The netcode layer calls this when migration succeeded. */
  notifyMigrated(): void {
    if (this.flow.state !== 'migrating') return;
    const event = RESUME_EVENTS[this.resumeFrom] ?? 'migrateFailed';
    this.request(event, 'net');
  }

  /* ---------------------------------------------------------------- update -- */

  update(dt: number, _ctx?: EngineContext): void {
    this.step(dt);
  }

  /** Engine-free tick, so the headless harness drives the same code path. */
  step(dt: number): void {
    this.flow.tick(dt);
    this.ports.lobby?.tick?.(dt);
    this.ports.matchmaking?.tick?.(dt);
    this.ports.mapLoad?.tick?.(dt);

    switch (this.flow.state) {
      case 'lobby': this.tickCountdown(dt, 'search'); break;
      case 'matchmaking': this.tickSearch(dt); break;
      case 'loading': this.tickLoad(dt); break;
      case 'preMatch': this.tickCountdown(dt, 'go'); break;
      case 'live': this.tickLive(); break;
      case 'postMatch': this.tickCountdown(dt, 'report'); break;
      case 'afterAction': this.tickCountdown(dt, 'toLobby'); break;
      case 'migrating': this.tickCountdown(dt, 'migrateFailed'); break;
      default: break;
    }

    this.publishAcc += dt;
    if (this.publishAcc >= this.config.publishPeriod) this.publish(false);
  }

  /** Counts an armed timer down and fires `event` at zero. -1 waits forever. */
  private tickCountdown(dt: number, event: string): void {
    if (this.countdown < 0) return;
    this.countdown -= dt;
    const whole = Math.max(0, Math.ceil(this.countdown));
    if (whole !== this.lastCountdownSent) {
      this.lastCountdownSent = whole;
      this.bus.emit('session:countdown', {
        seconds: whole, total: this.countdownTotal, label: this.countdownLabel,
      });
    }
    if (this.countdown <= 0) {
      this.countdown = -1;
      this.request(event, 'timer');
    }
  }

  private tickSearch(dt: number): void {
    const mm = this.ports.matchmaking;
    if (!mm) return;
    const st = mm.status();
    this.bus.emit('session:search', {
      elapsed: st.elapsed, players: st.players, target: st.target, region: st.region,
    });
    if (st.state === 'found') {
      const r = mm.result();
      if (r) this.launch = { ...r, modeId: normaliseMode(r.modeId) };
      this.request('found', 'matchmaking');
      return;
    }
    if (st.state === 'failed') {
      this.raise('unfillable', 'NO SESSION FOUND', st.error ?? 'could not fill a session', true, ['unfillable']);
      return;
    }
    if (st.elapsed >= this.config.searchTimeout) {
      mm.cancel();
      this.raise('search-timeout', 'SEARCH TIMED OUT',
        `no session in ${this.config.searchTimeout | 0}s`, true, ['timeout']);
    }
  }

  private tickLoad(_dt: number): void {
    const ml = this.ports.mapLoad;
    if (!ml) { this.request('loaded', 'noloader'); return; }
    const st = ml.status();
    this.bus.emit('session:load', { map: this.map, progress: st.progress, done: st.done });
    if (st.error) {
      this.raise('load-failed', 'LOAD FAILED', st.error, true, ['loadFailed']);
      return;
    }
    if (st.done) { this.request('loaded', 'maploader'); return; }
    if (this.flow.elapsed >= this.config.loadTimeout) {
      ml.cancel?.();
      this.raise('load-timeout', 'LOAD TIMED OUT', `map "${this.map}" did not load`, true, ['loadFailed']);
    }
  }

  /**
   * The match owns itself while live; we only watch for it finishing. `game:over`
   * normally beats this, but polling the phase means a match that ends without
   * announcing still moves the session on.
   */
  private tickLive(): void {
    const m = this.ports.match;
    if (!m) return;
    if (m.phase === 'ended') this.request('finished', 'match');
  }

  /* -------------------------------------------------------------- snapshot -- */

  snapshot(): SessionSnapshot {
    return this.buildSnapshot();
  }

  private buildSnapshot(): SessionSnapshot {
    const meta = FLOW_META[this.flow.state];
    const lobby = this.ports.lobby?.view();
    const search = this.ports.matchmaking?.status();
    const load = this.ports.mapLoad?.status();
    const prog = this.ports.progression;
    const p = prog?.progress() ?? { into: 0, needed: 1 };
    const members = lobby && lobby.members.length ? lobby.members : this.members;

    const s: SessionSnapshot = {
      state: this.flow.state,
      previous: this.flow.previous,
      seq: this.flow.seq,
      elapsed: this.flow.elapsed,
      label: meta.label,
      screen: meta.screen,

      online: this.online,
      isHost: this.isHost,
      connection: this.ports.net?.connection ?? 'offline',
      localId: this.me.id,

      mode: this.mode,
      map: lobby?.selection.mapName ?? this.map,
      loadoutName: this.ports.loadout?.activeName() ?? 'DEFAULT',

      members,
      partySize: members.filter((m) => !m.bot).length,
      humans: members.filter((m) => !m.bot).length,

      countdown: this.countdown,
      countdownLabel: this.countdownLabel,
      searchElapsed: search?.elapsed ?? 0,
      searchTarget: search?.target ?? 0,
      loadProgress: load?.progress ?? 0,

      rank: prog?.rank() ?? 1,
      rankName: prog?.rankName() ?? 'Recruit',
      xpIntoRank: p.into,
      xpForNext: p.needed,

      legal: this.flow.legal(),
      statusLine: this.statusLine(lobby, search, load),
      fault: this.fault,
      report: this.report,
      degraded: [...this.degraded],
    };
    this.snap = s;
    return s;
  }

  private statusLine(
    lobby: SessionLobbyView | undefined,
    search: SearchStatus | undefined,
    load: LoadStatus | undefined,
  ): string {
    switch (this.flow.state) {
      case 'boot': return 'INITIALISING';
      case 'mainMenu': return 'READY';
      case 'party': return `PARTY · ${this.members.length}`;
      case 'lobby': return lobby?.message ?? 'PRIVATE LOBBY';
      case 'matchmaking':
        return search
          ? `SEARCHING · ${search.players}/${search.target} · ${search.elapsed.toFixed(0)}S`
          : 'SEARCHING';
      case 'loading': return `LOADING ${this.map.toUpperCase()} · ${Math.round((load?.progress ?? 0) * 100)}%`;
      case 'preMatch': return `DEPLOYING IN ${Math.max(0, Math.ceil(this.countdown))}`;
      case 'live': return modeName(this.mode).toUpperCase();
      case 'postMatch': return 'MATCH OVER';
      case 'afterAction': return this.report?.abandoned ? 'MATCH ABANDONED' : 'AFTER ACTION REPORT';
      case 'migrating': return 'MIGRATING HOST';
      case 'fault': return this.fault ? `${this.fault.title} · ${this.fault.detail}` : 'ERROR';
      case 'shutdown': return 'SHUTTING DOWN';
      default: return '';
    }
  }

  private publish(force: boolean): void {
    if (!force && this.publishAcc < this.config.publishPeriod) return;
    this.publishAcc = 0;
    this.bus.emit('session:snapshot', this.buildSnapshot());
  }

  /** Last published snapshot, without rebuilding it. */
  get lastSnapshot(): SessionSnapshot { return this.snap; }
}

/** Which resume event leaves `migrating` for each state we could have left. */
const RESUME_EVENTS: Partial<Record<FlowState, string>> = {
  lobby: 'resumeLobby',
  matchmaking: 'resumeLobby',
  loading: 'resumeLoading',
  preMatch: 'resumeLoading',
  live: 'resumeLive',
  postMatch: 'resumePostMatch',
};

/* ------------------------------------------------------------- port guards -- */

function isFn(v: unknown): v is (...args: never[]) => unknown { return typeof v === 'function'; }

function asMatchPort(sys: unknown): MatchPort | null {
  const d = sys as Partial<MatchPort> | undefined;
  if (!d || !isFn(d.startMatch) || !isFn(d.endMatch)) return null;
  if (typeof d.phase !== 'string') return null;
  return sys as MatchPort;
}

function asLobbyPort(sys: unknown): LobbyPort | null {
  const l = sys as Partial<LobbyPort> | undefined;
  return l && isFn(l.view) ? (sys as LobbyPort) : null;
}

function asMatchmakingPort(sys: unknown): MatchmakingPort | null {
  const m = sys as Partial<MatchmakingPort> | undefined;
  if (!m || !isFn(m.search) || !isFn(m.cancel) || !isFn(m.status) || !isFn(m.result)) return null;
  return sys as MatchmakingPort;
}

/* --------------------------------------------------- real-subsystem bridges -- */

/**
 * The seven session subsystems were written in parallel and do not all speak
 * the port vocabulary above. Rather than ask another module to change shape —
 * or import it and drag the whole subsystem into the bundle — the disagreements
 * are reconciled here, structurally: each bridge takes `unknown`, proves the
 * shape at runtime, and returns a port or `null`.
 *
 * Reconciled (see `docs/SESSION.md` §8):
 *
 * - `lobby/LobbySystem` owns a `LobbySession` that publishes a fat `LobbyState`;
 *   `LobbyPort` wants a flat `view()`.               → `lobbyPortFrom`
 * - `matchmaking/MatchmakingService` is ticket-shaped and clocked in *absolute*
 *   seconds; `MatchmakingPort` is search/status/result shaped and clocked in
 *   deltas.                                          → `matchmakingPortFrom`
 * - `loadout/LoadoutBook` is the client's saved classes; the session only needs
 *   the active class name.                           → `loadoutPortFrom`
 *
 * None of these bridges mutate the subsystem they wrap beyond the commands that
 * subsystem already exposes to its own UI, so authority stays where it was.
 */

interface MemberStateLike {
  id: string;
  profile: { name: string; rank: number; bot: boolean };
  team: SessionTeam;
  ready: boolean;
  loadProgress: number;
  host: boolean;
  leader: boolean;
  ping: number;
}

interface LobbyStateLike {
  phase: LobbyPhase;
  hostId: string;
  members: MemberStateLike[];
  selection: LobbySelection;
  countdown: { secondsLeft: number };
  connectedCount: number;
  capacity: number;
  message: string;
}

interface LobbySessionLike {
  readonly localId: string;
  readonly state: LobbyStateLike | null;
  submit(cmd: unknown): unknown;
  ready(ready: boolean): unknown;
  tick(dt: number): void;
}

/** A `LobbySession`, or anything that owns one (`LobbySystem.session`). */
function asLobbySession(src: unknown): LobbySessionLike | null {
  const direct = src as Partial<LobbySessionLike> | undefined;
  if (direct && isFn(direct.submit) && isFn(direct.tick) && isFn(direct.ready)) {
    return src as LobbySessionLike;
  }
  const owner = src as { session?: unknown } | undefined;
  const inner = owner?.session as Partial<LobbySessionLike> | undefined;
  if (inner && inner !== direct && isFn(inner.submit) && isFn(inner.tick) && isFn(inner.ready)) {
    return owner!.session as LobbySessionLike;
  }
  return null;
}

function memberFrom(m: MemberStateLike, hostId: string, localId: string): SessionMember {
  return {
    id: m.id,
    name: m.profile?.name ?? m.id,
    team: m.team,
    bot: m.profile?.bot === true,
    host: m.host || m.id === hostId,
    leader: m.leader === true,
    ready: m.ready === true,
    loadProgress: typeof m.loadProgress === 'number' ? m.loadProgress : 0,
    ping: typeof m.ping === 'number' ? m.ping : 0,
    rank: m.profile?.rank ?? 1,
    local: m.id === localId,
  };
}

/**
 * Bridges the lobby module onto `LobbyPort`. `fallback` is used for the frames
 * before the lobby exists (a `LobbySystem` creates its room in `init`, and a
 * client has none until the host answers) — without it the front end would
 * flash an empty room.
 */
export function lobbyPortFrom(src: unknown, fallback?: () => SessionLobbyView): LobbyPort | null {
  const alreadyAPort = asLobbyPort(src);
  if (alreadyAPort) return alreadyAPort;
  const session = asLobbySession(src);
  if (!session) return null;

  return {
    view(): SessionLobbyView {
      const s = session.state;
      if (!s) return fallback ? fallback() : EMPTY_LOBBY_VIEW;
      const localId = session.localId;
      return {
        phase: s.phase,
        hostId: s.hostId,
        members: s.members.map((m) => memberFrom(m, s.hostId, localId)),
        selection: s.selection,
        countdown: s.countdown?.secondsLeft ?? -1,
        connected: s.connectedCount ?? s.members.length,
        capacity: s.capacity ?? s.members.length,
        message: s.message ?? '',
      };
    },
    // `pin` is the leader-only shortcut for `settings`; a non-leader's command
    // is rejected by the host, which is the correct authority answer.
    setMode(mode: GameModeId): void { session.submit({ t: 'pin', mapId: null, modeId: mode }); },
    requestLaunch(): void { session.ready(true); session.submit({ t: 'start' }); },
    requestCancel(): void { session.submit({ t: 'cancel' }); },
    tick(dt: number): void { session.tick(dt); },
  };
}

const EMPTY_LOBBY_VIEW: SessionLobbyView = {
  phase: 'forming',
  hostId: 'local',
  members: [],
  selection: {
    mapId: 'blackout', mapName: 'Blackout', modeId: 'operation', modeName: 'Operation', seed: 1337,
  },
  countdown: -1,
  connected: 0,
  capacity: 0,
  message: '',
};

interface MmSnapshotLike {
  state: 'idle' | 'searching' | 'found' | 'joining' | 'in-match';
  waited: number;
  candidates: number;
  roster: MmRosterLike | null;
}

interface MmSlotLike {
  kind: 'human' | 'bot';
  playerId?: string;
  botId?: string;
  name: string;
  team: number;
}

interface MmRosterLike {
  mode: string;
  seed: number;
  slots: MmSlotLike[];
}

interface MatchmakingServiceLike {
  requestJoin(playlist: string, party?: unknown[], now?: number): unknown;
  leaveQueue(): void;
  update(now: number): unknown;
  snapshot(): MmSnapshotLike;
}

/** Playlist chosen for a mode when the caller does not pick one. */
const PLAYLIST_FOR_MODE: Readonly<Record<GameModeId, string>> = {
  tdm: 'core-tdm-6v6',
  operation: 'operation-coop-4',
  firefight: 'firefight-coop-4',
};

export interface MatchmakingBridgeOptions {
  /** Map id stamped onto the launch order; the roster does not carry one. */
  map?: string;
  /** Override the mode → playlist choice (ranked, private match, …). */
  playlistFor?: (mode: GameModeId) => string;
}

/**
 * Bridges `matchmaking/MatchmakingService` onto `MatchmakingPort`. The service
 * owns no clock by design, so the bridge keeps one and advances it from the
 * session's `tick(dt)` — which means matchmaking inherits the session's
 * determinism instead of wall time.
 */
export function matchmakingPortFrom(
  src: unknown,
  opts: MatchmakingBridgeOptions = {},
): MatchmakingPort | null {
  const alreadyAPort = asMatchmakingPort(src);
  if (alreadyAPort) return alreadyAPort;
  const svc = src as Partial<MatchmakingServiceLike> | undefined;
  if (!svc || !isFn(svc.requestJoin) || !isFn(svc.update) || !isFn(svc.snapshot)) return null;
  const service = src as MatchmakingServiceLike;

  const pick = opts.playlistFor ?? ((m: GameModeId) => PLAYLIST_FOR_MODE[m] ?? 'core-tdm-6v6');
  let clock = 0;
  let searching = false;
  let target = 0;

  return {
    search(req: SearchRequest): void {
      const party = req.party
        .filter((m) => !m.bot)
        .map((m) => ({ playerId: m.id, name: m.name, rank: m.rank }));
      if (!party.length) party.push({ playerId: 'local', name: 'OPERATOR', rank: 1 });
      searching = true;
      service.requestJoin(pick(req.mode), party, clock);
    },
    cancel(): void {
      searching = false;
      if (isFn(service.leaveQueue)) service.leaveQueue();
    },
    status(): SearchStatus {
      const s = service.snapshot();
      const roster = s.roster;
      if (roster) target = roster.slots.length;
      const humans = roster ? roster.slots.filter((x) => x.kind === 'human').length : 0;
      const state: SearchStatus['state'] = !searching
        ? 'idle'
        : s.state === 'searching' || s.state === 'idle' ? 'searching' : 'found';
      return {
        state,
        elapsed: s.waited ?? clock,
        players: roster ? humans : (s.candidates ?? 0) + 1,
        target,
        region: 'local',
        // The service reports "still looking", never "gave up" — the session's
        // own `searchTimeout` is what turns a hopeless search into a failure.
        error: null,
      };
    },
    result(): MatchLaunch | null {
      const roster = service.snapshot().roster;
      if (!roster) return null;
      return {
        modeId: normaliseMode(roster.mode),
        mapId: opts.map ?? 'blackout',
        seed: roster.seed,
        roster: roster.slots.map((s) => ({
          id: (s.kind === 'human' ? s.playerId : s.botId) ?? s.name,
          name: s.name,
          bot: s.kind === 'bot',
          team: s.team === 1 ? ('bravo' as SessionTeam) : ('alpha' as SessionTeam),
        })),
        matchIndex: 0,
      };
    },
    tick(dt: number): void {
      clock += dt;
      service.update(clock);
    },
  };
}

/* ------------------------------------------------------------ installation -- */

/** The slice of `Engine` installation needs. Anything else can stand in. */
export interface SystemRegistry {
  add<T extends System>(system: T): T;
  tryGet<T extends System>(name: string): T | undefined;
}

export interface InstallSessionOptions extends SessionOptions {
  /** A `LobbySystem`, or a bare `LobbySession`. A `System` is registered too. */
  lobby?: unknown;
  /** A `MatchmakingService`. */
  matchmaking?: unknown;
  /** A `LoadoutBook`. */
  loadout?: unknown;
  /** A `SpawnDirector`. Registered for discovery; the match layer drives it. */
  spawns?: unknown;
  /** A replay recorder/theater. Registered for discovery. */
  replay?: unknown;
}

function looksLikeSystem(v: unknown): v is System {
  const s = v as Partial<System> | undefined;
  return !!s && typeof s.name === 'string' && typeof s.order === 'number';
}

/**
 * The one call that turns the meta layer on:
 *
 * ```ts
 * installSession(engine, { lobby: new LobbySystem(), matchmaking: mm });
 * ```
 *
 * Everything is optional. `installSession(engine)` alone gives you the local
 * session — menu, lobby, bot fill, after-action report — with no network and no
 * subsystems, which is exactly what single player is. Subsystems handed in here
 * are bridged onto ports (see above) and, when they are `System`s in their own
 * right, registered so the engine ticks them.
 *
 * Idempotent: a session already in the registry is returned untouched.
 */
export function installSession(
  registry: SystemRegistry,
  opts: InstallSessionOptions = {},
): SessionSystem {
  const existing = registry.tryGet('session');
  if (existing) return existing as unknown as SessionSystem;

  const { lobby, matchmaking, loadout, spawns, replay, ...sessionOpts } = opts;
  const session = new SessionSystem(sessionOpts);
  const subs = session.subsystems as unknown as Record<string, object | null>;
  subs.lobby = (lobby as object) ?? null;
  subs.matchmaking = (matchmaking as object) ?? null;
  subs.loadout = (loadout as object) ?? null;
  subs.spawns = (spawns as object) ?? null;
  subs.replay = (replay as object) ?? null;

  if (lobby && looksLikeSystem(lobby) && !registry.tryGet(lobby.name)) registry.add(lobby);

  const ports: Partial<SessionPorts> = {};
  const lobbyPort = lobbyPortFrom(lobby);
  if (lobbyPort) ports.lobby = lobbyPort;
  const mmPort = matchmakingPortFrom(matchmaking, { map: opts.map });
  if (mmPort) ports.matchmaking = mmPort;
  const loadoutPort = loadoutPortFrom(loadout);
  if (loadoutPort) ports.loadout = loadoutPort;
  if (Object.keys(ports).length) session.attach(ports);

  registry.add(session);
  return session;
}

/** Bridges `loadout/LoadoutBook` (or anything with `current()`) onto `LoadoutPort`. */
export function loadoutPortFrom(src: unknown): LoadoutPort | null {
  const already = asLoadoutPort(src);
  if (already) return already;
  const book = src as { current?: unknown } | undefined;
  if (!book || !isFn(book.current)) return null;
  const read = (): { name?: string; primary?: unknown; secondary?: unknown } | null => {
    try { return (book.current as () => never)(); } catch { return null; }
  };
  return {
    activeName: () => read()?.name ?? 'DEFAULT',
    valid: () => {
      const l = read();
      return !!l && !!l.primary && !!l.secondary;
    },
  };
}

function asMapLoadPort(sys: unknown): MapLoadPort | null {
  const m = sys as Partial<MapLoadPort> | undefined;
  return m && isFn(m.begin) && isFn(m.status) ? (sys as MapLoadPort) : null;
}

function asLoadoutPort(sys: unknown): LoadoutPort | null {
  const l = sys as Partial<LoadoutPort> | undefined;
  return l && isFn(l.activeName) ? (sys as LoadoutPort) : null;
}

function asNetPort(sys: unknown): NetPort | null {
  const n = sys as Partial<NetPort> | undefined;
  if (!n || typeof n.role !== 'string' || typeof n.connection !== 'string') return null;
  return sys as NetPort;
}

/**
 * `GameDirector` owns a `MatchRunner`, which owns a `Progression`. Rather than
 * import either (and drag the whole match layer into the session module), reach
 * for the shape and give up quietly if it is not there.
 */
function asProgressionPort(sys: unknown): ProgressionPort | null {
  const d = sys as { match?: { progression?: unknown } } | undefined;
  const p = d?.match?.progression as {
    rank?: number; xp?: number; progressInRank?: () => { into: number; needed: number };
  } | undefined;
  if (!p || typeof p.rank !== 'number' || !isFn(p.progressInRank)) return null;
  const names = sys as { match?: { progression: { rank: number; xp: number } } };
  return {
    rank: () => names.match!.progression.rank,
    rankName: () => `Rank ${names.match!.progression.rank}`,
    xp: () => names.match!.progression.xp,
    progress: () => p.progressInRank!(),
  };
}
