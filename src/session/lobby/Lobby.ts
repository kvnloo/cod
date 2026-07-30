/**
 * `LobbyHost` — the authority.
 *
 * Exactly one peer runs this at a time. It owns the member list, the vote, the
 * countdown, team assignment and the launch order; everyone else holds a
 * read-only `LobbyState` and sends `LobbyCommand`s. There is no code path in
 * this file that trusts a client for anything except its own profile.
 *
 * Three properties are load-bearing:
 *
 * **Every timer terminates.** The vote closes on a timeout, the countdown
 * launches or aborts, the loading phase drops stragglers, the post-match
 * scoreboard rolls back to `forming`. A lobby can never sit in a phase waiting
 * for something that will not happen.
 *
 * **Nothing important comes from an RNG stream.** The vote board, the tie-break
 * and team assignment are all derived from stable hashes of ids, so a host that
 * takes over halfway through computes the same answers the old one would have.
 * The seeded `Rand` is used only for things nobody can observe across a
 * migration (the room code at creation, bot names).
 *
 * **The lobby outlives the match.** `post-match → forming` keeps the members,
 * keeps the parties, keeps the room code, clears the ready flags and opens a
 * fresh vote. That loop is the entire difference between a game that feels
 * social and one that feels transactional.
 */

import { Rand, hashString } from '../../core/Rand';
import type {
  CountdownAbortReason, CountdownState, GameModeId, LobbyId, LobbyPhase, LobbyResult,
  LobbySelection, LobbySettings, LobbySnapshot, LobbyState, MatchConfig, MatchRosterEntry,
  MemberConnection, MemberState, PartyId, PartyView, PlayerId, PlayerProfile, RoomCode,
  SessionEmitter, SessionTeam,
} from '../types';
import { defaultLobbySettings, makeProfile, nullEmitter } from '../types';
import {
  DEFAULT_CATALOG, fallbackPair, findMap, findMode, modeFits, type LobbyCatalog,
} from './Catalog';
import { PartyRegistry } from './Party';
import { buildCandidates, candidateId, VoteBooth } from './Vote';
import { assignTeams, canSwitchTeam, summariseTeams, type BalanceMember } from './Teams';
import { codeFromSeed, lobbyIdForCode, makeRoomCode, normalizeRoomCode } from './RoomCode';
import { fail, LEADER_ONLY, OK, type CommandResult, type LobbyCommand } from './Commands';
import './events';

/** Bot callsigns. Deterministic draw, never `Math.random`. */
const BOT_NAMES: readonly string[] = [
  'Reaper', 'Kilo', 'Vagrant', 'Sable', 'Nomad', 'Fenrir', 'Dusty', 'Prowler',
  'Sierra', 'Havoc', 'Bishop', 'Ozone', 'Ranger', 'Tundra', 'Vulture', 'Wraith',
];

interface Member {
  id: PlayerId;
  profile: PlayerProfile;
  partyId: PartyId | null;
  team: SessionTeam;
  connection: MemberConnection;
  ready: boolean;
  loadProgress: number;
  joinedAt: number;
  ping: number;
  slot: number;
  teamLocked: boolean;
  splitFromParty: boolean;
  /** Lobby clock at the last heartbeat. */
  lastSeen: number;
}

export interface LobbyHostOptions {
  hostId: PlayerId;
  hostProfile?: PlayerProfile;
  settings?: Partial<LobbySettings>;
  /** Drives the room code and every match seed. */
  seed?: number;
  code?: RoomCode;
  id?: LobbyId;
  emit?: SessionEmitter;
  catalog?: LobbyCatalog;
  /** Pass an existing registry to carry a party in from the main menu. */
  parties?: PartyRegistry;
  /**
   * Set by `LobbyHost.adopt`. A resumed lobby is the *same* room with a new
   * authority, so it must not announce itself as a new one — a front end that
   * treats `lobby:created` as "you are now in a new lobby" would tear its own
   * screen down mid-migration.
   */
  resuming?: boolean;
}

export class LobbyHost {
  readonly id: LobbyId;
  readonly code: RoomCode;
  readonly parties: PartyRegistry;

  settings: LobbySettings;
  hostId: PlayerId;
  leaderId: PlayerId;
  phase: LobbyPhase = 'forming';
  phaseTime = 0;
  clock = 0;
  epoch = 0;
  seq = 0;
  matchIndex = 0;
  lastMapId: string | null = null;
  lastResult: LobbyResult | null = null;

  private members: Member[] = [];
  private catalog: LobbyCatalog;
  private emit: SessionEmitter;
  private rand: Rand;
  private seed: number;
  private booth: VoteBooth;
  private countdown: CountdownState = {
    active: false, secondsLeft: 0, total: 0, label: '', abortedBy: null,
  };
  private forcedStart = false;
  private loadTimer = 0;
  private postTimer = 0;
  private selection: LobbySelection;
  private splitParties: PartyId[] = [];
  private skillGap = 0;
  private nextSlot = 0;
  private botCounter = 0;
  private dirty = true;
  private pending = true;
  private cached: LobbyState | null = null;
  private announcedSecond = -1;
  private publishedSecond = -1;
  private closed = false;

  constructor(opts: LobbyHostOptions) {
    this.seed = opts.seed ?? 1337;
    this.rand = new Rand(this.seed);
    this.code = normalizeRoomCode(opts.code ?? '') || codeFromSeed(`${this.seed}:${opts.hostId}`);
    this.id = opts.id ?? lobbyIdForCode(this.code);
    this.settings = defaultLobbySettings(opts.settings);
    this.catalog = opts.catalog ?? DEFAULT_CATALOG;
    this.emit = opts.emit ?? nullEmitter;
    this.parties = opts.parties ?? new PartyRegistry();
    this.hostId = opts.hostId;
    this.leaderId = opts.hostId;

    const { map, mode } = fallbackPair(this.catalog, 1);
    this.selection = {
      mapId: map.id, mapName: map.name, modeId: mode.id, modeName: mode.name,
      seed: this.matchSeed(map.id, mode.id),
    };
    this.booth = new VoteBooth(this.id, 0, null);

    this.insert(opts.hostProfile ?? makeProfile(opts.hostId, 'Host'));
    this.parties.setLobbyCode(this.code);
    // A resumed lobby throws all of this away a few lines later in `adopt` —
    // announcing a new room, a new board and a new state here would only tell
    // every listener a lie it has to un-hear.
    if (!opts.resuming) {
      this.emit('lobby:created', { id: this.id, code: this.code, hostId: this.hostId });
      this.openVote();
      this.publish();
    }
  }

  /* ------------------------------------------------------------- reading -- */

  get state(): LobbyState { return this.dirty || !this.cached ? this.build() : this.cached; }
  get memberCount(): number { return this.members.filter((m) => m.connection !== 'dropped').length; }
  get isClosed(): boolean { return this.closed; }

  member(id: PlayerId): MemberState | null {
    const m = this.members.find((x) => x.id === id);
    return m ? this.view(m) : null;
  }

  has(id: PlayerId): boolean {
    return this.members.some((m) => m.id === id && m.connection !== 'dropped');
  }

  /* ------------------------------------------------------------ commands -- */

  /**
   * The single entry point for every mutation. `from` is supplied by the
   * transport, never by the payload, so a client cannot act as somebody else.
   */
  submit(cmd: LobbyCommand, from: PlayerId): CommandResult {
    if (this.closed) return fail('wrong-phase', 'Lobby closed.');
    const result = this.dispatch(cmd, from);
    if (!result.ok && result.code) {
      this.emit('lobby:error', { code: result.code, error: result.error ?? '', playerId: from });
    }
    this.publish();
    return result;
  }

  private dispatch(cmd: LobbyCommand, from: PlayerId): CommandResult {
    if (LEADER_ONLY.has(cmd.t) && from !== this.leaderId) {
      return fail('not-leader', 'Only the lobby leader can do that.');
    }
    switch (cmd.t) {
      case 'join': return this.cmdJoin(cmd.code, cmd.profile, from, cmd.partyId ?? null);
      case 'leave': return this.remove(from, 'left');
      case 'kick': return this.cmdKick(cmd.target, from);
      case 'promote': return this.cmdPromote(cmd.target);
      case 'ready': return this.cmdReady(from, cmd.ready);
      case 'vote': return this.cmdVote(from, cmd.candidateId);
      case 'settings': return this.cmdSettings(cmd.patch);
      case 'pin': return this.cmdPin(cmd.mapId, cmd.modeId);
      case 'switchTeam': return this.cmdSwitchTeam(from, cmd.team);
      case 'party:create': return this.cmdPartyCreate(from);
      case 'party:invite': return this.cmdPartyInvite(from, cmd.target);
      case 'party:accept': return this.cmdPartyAccept(from, cmd.partyId);
      case 'party:leave': return this.cmdPartyLeave(from);
      case 'party:promote': return this.cmdPartyPromote(from, cmd.target);
      case 'start': return this.cmdStart();
      case 'cancel': return this.cmdCancel();
      case 'loading': return this.cmdLoading(from, cmd.progress);
      case 'heartbeat': return this.cmdHeartbeat(from, cmd.ping);
      case 'matchEnded': return this.cmdMatchEnded(cmd.result, from);
      default: return fail('unknown-command', 'Unknown command.');
    }
  }

  private cmdJoin(
    code: RoomCode, profile: PlayerProfile, from: PlayerId, partyId: PartyId | null,
  ): CommandResult {
    if (normalizeRoomCode(code) !== this.code) return fail('bad-code', 'That room code does not match.');

    const existing = this.members.find((m) => m.id === from);
    if (existing) {
      // Reconnect: the same identity coming back after a drop or a migration.
      const wasDropped = existing.connection === 'dropped';
      existing.connection = this.phase === 'loading' ? 'loading' : 'connected';
      existing.profile = { ...profile, id: from };
      existing.lastSeen = this.clock;
      if (wasDropped) {
        this.emit('lobby:member:connection', { id: from, connection: existing.connection });
        this.rebalance();
      }
      this.mark();
      return OK;
    }

    if (this.memberCount >= this.settings.maxPlayers) return fail('full', 'This lobby is full.');
    if (this.phase === 'loading' || this.phase === 'in-match') {
      if (!this.settings.allowJoinInProgress) return fail('wrong-phase', 'Match already in progress.');
    }

    const m = this.insert({ ...profile, id: from });
    if (partyId && this.parties.get(partyId)) {
      this.parties.join(partyId, from);
      m.partyId = partyId;
    } else {
      const known = this.parties.partyOf(from);
      m.partyId = known ? known.id : null;
    }
    this.emit('lobby:member:join', {
      member: this.view(m), count: this.memberCount, capacity: this.settings.maxPlayers,
    });
    // Somebody new has not readied, so an armed launch is no longer honest.
    if (this.phase === 'ready') this.abortCountdown('member-joined');
    this.rebalance();
    return OK;
  }

  private cmdKick(target: PlayerId, from: PlayerId): CommandResult {
    if (target === from) return fail('not-allowed', 'You cannot kick yourself.');
    if (target === this.hostId) return fail('not-allowed', 'You cannot kick the host.');
    if (!this.has(target)) return fail('unknown-target', 'That player is not in the lobby.');
    return this.remove(target, 'kicked');
  }

  private cmdPromote(target: PlayerId): CommandResult {
    const m = this.members.find((x) => x.id === target && x.connection !== 'dropped');
    if (!m) return fail('unknown-target', 'That player is not in the lobby.');
    if (m.profile.bot) return fail('not-allowed', 'Bots cannot lead.');
    const previous = this.leaderId;
    this.leaderId = target;
    this.emit('lobby:leader', { id: target, name: m.profile.name, previous });
    this.mark();
    return OK;
  }

  private cmdReady(from: PlayerId, ready: boolean): CommandResult {
    const m = this.members.find((x) => x.id === from && x.connection !== 'dropped');
    if (!m) return fail('not-member', 'You are not in this lobby.');
    if (this.phase !== 'forming' && this.phase !== 'ready') {
      return fail('wrong-phase', 'Cannot change ready state now.');
    }
    if (m.ready === ready) return OK;
    m.ready = ready;
    this.emit('lobby:member:ready', {
      id: from, name: m.profile.name, ready,
      readyCount: this.readyCount(), total: this.humanCount(),
    });
    if (!ready && this.phase === 'ready' && !this.forcedStart) this.abortCountdown('unready');
    this.mark();
    return OK;
  }

  private cmdVote(from: PlayerId, id: string): CommandResult {
    if (this.phase !== 'forming') return fail('wrong-phase', 'Voting is closed.');
    if (!this.has(from)) return fail('not-member', 'You are not in this lobby.');
    if (!this.booth.cast(from, id)) return fail('unknown-candidate', 'No such option.');
    this.emit('lobby:vote:cast', {
      playerId: from, candidateId: id, cast: this.booth.castCount, total: this.humanCount(),
    });
    this.mark();
    return OK;
  }

  private cmdSettings(patch: Partial<LobbySettings>): CommandResult {
    const before = this.settings;
    const next: LobbySettings = { ...before, ...patch };
    next.maxPlayers = Math.max(1, Math.min(32, Math.round(next.maxPlayers)));
    next.minPlayers = Math.max(1, Math.min(next.maxPlayers, Math.round(next.minPlayers)));
    next.voteCandidates = Math.max(1, Math.min(6, Math.round(next.voteCandidates)));
    next.countdownSec = Math.max(1, next.countdownSec);
    next.fullCountdownSec = Math.max(1, next.fullCountdownSec);
    next.voteSec = Math.max(1, next.voteSec);
    next.teamCount = next.teamCount === 1 ? 1 : 2;
    this.settings = next;

    if (this.phase === 'ready') this.abortCountdown('settings-changed');
    if (next.voteCandidates !== before.voteCandidates && this.booth.open) this.openVote();
    if (next.teamCount !== before.teamCount || next.maxPlayers !== before.maxPlayers) {
      for (const m of this.members) m.teamLocked = false;
      this.rebalance();
    }
    this.mark();
    return OK;
  }

  private cmdPin(mapId: string | null, modeId: GameModeId | null): CommandResult {
    if (mapId && !findMap(this.catalog, mapId)) return fail('bad-argument', 'No such map.');
    if (modeId && !findMode(this.catalog, modeId)) return fail('bad-argument', 'No such mode.');
    this.settings.pinnedMapId = mapId;
    this.settings.pinnedModeId = modeId;
    if (this.phase === 'ready') this.abortCountdown('settings-changed');
    this.openVote();
    this.mark();
    return OK;
  }

  private cmdSwitchTeam(from: PlayerId, team: SessionTeam): CommandResult {
    if (this.phase !== 'forming') return fail('wrong-phase', 'Teams are locked.');
    const check = canSwitchTeam(this.balanceMembers(), from, team, {
      teamCount: this.settings.teamCount, maxPlayers: this.settings.maxPlayers,
    });
    if (!check.ok) return fail('team-full', check.reason);
    const m = this.members.find((x) => x.id === from)!;
    m.team = team;
    m.teamLocked = true;
    this.emitTeams();
    this.mark();
    return OK;
  }

  private cmdPartyCreate(from: PlayerId): CommandResult {
    if (!this.has(from)) return fail('not-member', 'You are not in this lobby.');
    const party = this.parties.create(from, this.clock, this.id);
    const m = this.members.find((x) => x.id === from)!;
    m.partyId = party.id;
    this.parties.setLobbyCode(this.code);
    this.emitParties();
    this.mark();
    return OK;
  }

  private cmdPartyInvite(from: PlayerId, target: PlayerId): CommandResult {
    if (!this.has(from)) return fail('not-member', 'You are not in this lobby.');
    if (!this.has(target)) return fail('unknown-target', 'That player is not in the lobby.');
    let party = this.parties.partyOf(from);
    if (!party) {
      party = this.parties.create(from, this.clock, this.id);
      const me = this.members.find((x) => x.id === from)!;
      me.partyId = party.id;
    }
    const inviter = this.members.find((x) => x.id === from)!;
    this.emit('lobby:party:invite', {
      from, fromName: inviter.profile.name, to: target, partyId: party.id,
    });
    this.mark();
    return OK;
  }

  private cmdPartyAccept(from: PlayerId, partyId: PartyId): CommandResult {
    if (!this.has(from)) return fail('not-member', 'You are not in this lobby.');
    const party = this.parties.join(partyId, from);
    if (!party) return fail('unknown-target', 'That party no longer exists.');
    const m = this.members.find((x) => x.id === from)!;
    m.partyId = party.id;
    m.teamLocked = false;
    this.parties.setLobbyCode(this.code);
    this.emitParties();
    this.rebalance();
    return OK;
  }

  private cmdPartyLeave(from: PlayerId): CommandResult {
    this.parties.leave(from);
    const m = this.members.find((x) => x.id === from);
    if (m) m.partyId = null;
    // Anyone whose party dissolved underneath them loses the tag too.
    for (const x of this.members) {
      if (x.partyId && !this.parties.get(x.partyId)) x.partyId = null;
    }
    this.emitParties();
    this.rebalance();
    return OK;
  }

  private cmdPartyPromote(from: PlayerId, target: PlayerId): CommandResult {
    const party = this.parties.partyOf(from);
    if (!party) return fail('not-allowed', 'You are not in a party.');
    if (party.leaderId !== from) return fail('not-allowed', 'Only the party leader can do that.');
    if (!this.parties.transferLeader(party.id, target)) {
      return fail('unknown-target', 'They are not in your party.');
    }
    this.emitParties();
    this.mark();
    return OK;
  }

  private cmdStart(): CommandResult {
    if (this.phase !== 'forming') return fail('wrong-phase', 'Already starting.');
    if (this.humanCount() < this.settings.minPlayers) {
      return fail('not-allowed', 'Not enough players yet.');
    }
    this.forcedStart = true;
    this.armCountdown('STARTING');
    return OK;
  }

  private cmdCancel(): CommandResult {
    if (this.phase !== 'ready') return fail('wrong-phase', 'Nothing to cancel.');
    this.abortCountdown('leader-cancelled');
    return OK;
  }

  private cmdLoading(from: PlayerId, progress: number): CommandResult {
    const m = this.members.find((x) => x.id === from && x.connection !== 'dropped');
    if (!m) return fail('not-member', 'You are not in this lobby.');
    m.loadProgress = Math.max(0, Math.min(1, progress));
    m.lastSeen = this.clock;
    if (this.phase === 'loading') {
      const total = this.loadingMembers().length;
      const loaded = this.loadingMembers().filter((x) => x.loadProgress >= 1).length;
      this.emit('lobby:loading', { loaded, total, progress: total ? loaded / total : 1 });
    }
    this.mark();
    return OK;
  }

  private cmdHeartbeat(from: PlayerId, ping: number): CommandResult {
    const m = this.members.find((x) => x.id === from);
    if (!m) return fail('not-member', 'You are not in this lobby.');
    m.lastSeen = this.clock;
    m.ping = Math.max(0, Math.round(ping));
    return OK;
  }

  private cmdMatchEnded(result: LobbyResult, from: PlayerId): CommandResult {
    if (from !== this.hostId) return fail('not-host', 'Only the host reports results.');
    if (this.phase !== 'in-match' && this.phase !== 'loading') {
      return fail('wrong-phase', 'No match is running.');
    }
    this.finishMatch(result);
    return OK;
  }

  /* --------------------------------------------------------- membership -- */

  private insert(profile: PlayerProfile): Member {
    const m: Member = {
      id: profile.id,
      profile,
      partyId: this.parties.partyOf(profile.id)?.id ?? null,
      team: 'none',
      connection: 'connected',
      ready: profile.bot,
      loadProgress: 0,
      joinedAt: this.clock,
      ping: profile.bot ? 0 : -1,
      slot: this.nextSlot++,
      teamLocked: false,
      splitFromParty: false,
      lastSeen: this.clock,
    };
    this.members.push(m);
    this.mark();
    return m;
  }

  private remove(
    id: PlayerId, reason: 'left' | 'kicked' | 'dropped' | 'timeout' | 'load-timeout',
  ): CommandResult {
    const i = this.members.findIndex((m) => m.id === id);
    if (i < 0) return fail('not-member', 'Not in this lobby.');
    const [m] = this.members.splice(i, 1);
    this.parties.leave(id);
    for (const x of this.members) {
      if (x.partyId && !this.parties.get(x.partyId)) x.partyId = null;
    }
    this.booth.withdraw(id);
    this.emit('lobby:member:leave', {
      id, name: m.profile.name, count: this.memberCount, reason,
    });

    if (this.leaderId === id) this.promoteSuccessor();
    if (this.phase === 'ready') {
      this.abortCountdown(reason === 'left' || reason === 'kicked' ? 'member-left' : 'member-dropped');
    }
    this.emitParties();
    this.rebalance();
    return OK;
  }

  /** Transport-driven: a peer's connection died. */
  dropMember(id: PlayerId, reason: 'dropped' | 'timeout' = 'dropped'): void {
    if (!this.members.some((m) => m.id === id)) return;
    this.remove(id, reason);
    this.publish();
  }

  /** Picks the next leader when the current one leaves. Deterministic. */
  private promoteSuccessor(): void {
    const candidates = this.members
      .filter((m) => m.connection !== 'dropped' && !m.profile.bot)
      .sort((a, b) => {
        const ah = a.id === this.hostId ? 0 : 1;
        const bh = b.id === this.hostId ? 0 : 1;
        if (ah !== bh) return ah - bh;
        if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
        return a.slot - b.slot;
      });
    const next = candidates[0];
    if (!next) return;
    const previous = this.leaderId;
    this.leaderId = next.id;
    this.emit('lobby:leader', { id: next.id, name: next.profile.name, previous });
  }

  /* --------------------------------------------------------------- vote -- */

  private openVote(): void {
    const pinnedMap = findMap(this.catalog, this.settings.pinnedMapId);
    const pinnedMode = findMode(this.catalog, this.settings.pinnedModeId);
    this.booth.reset(this.matchIndex, this.lastMapId);

    if (pinnedMap && pinnedMode) {
      this.booth.pin({
        id: candidateId(pinnedMap.id, pinnedMode.id),
        mapId: pinnedMap.id, modeId: pinnedMode.id,
        label: pinnedMap.name.toUpperCase(), sublabel: pinnedMode.name.toUpperCase(),
        tagline: pinnedMode.tagline, votes: 0, voters: [], recommended: true,
      });
      this.applySelection(pinnedMap.id, pinnedMode.id);
      this.mark();
      return;
    }

    const candidates = buildCandidates(this.catalog, {
      lobbyId: this.id,
      matchIndex: this.matchIndex,
      players: Math.max(1, this.humanCount()),
      lastMapId: this.lastMapId,
      count: this.settings.voteCandidates,
    });
    this.booth.openBoard(candidates, this.settings.voteSec);
    if (candidates.length) this.applySelection(candidates[0].mapId, candidates[0].modeId);
    this.emit('lobby:vote:open', {
      candidates: this.booth.state().candidates, seconds: this.settings.voteSec,
    });
    this.mark();
  }

  private closeVote(): void {
    const result = this.booth.close(this.leaderId);
    if (!result) return;
    const map = findMap(this.catalog, result.candidate.mapId);
    const mode = findMode(this.catalog, result.candidate.modeId);
    if (map && mode) this.applySelection(map.id, mode.id);
    this.emit('lobby:vote:result', {
      candidateId: result.candidate.id,
      mapId: this.selection.mapId, mapName: this.selection.mapName,
      modeId: this.selection.modeId, modeName: this.selection.modeName,
      resolvedBy: result.resolvedBy,
    });
    this.mark();
  }

  private applySelection(mapId: string, modeId: GameModeId): void {
    const map = findMap(this.catalog, mapId) ?? this.catalog.maps[0];
    const mode = findMode(this.catalog, modeId) ?? this.catalog.modes[0];
    this.selection = {
      mapId: map.id, mapName: map.name, modeId: mode.id, modeName: mode.name,
      seed: this.matchSeed(map.id, mode.id),
    };
    if (mode.teamCount !== this.settings.teamCount) {
      this.settings.teamCount = mode.teamCount;
      this.rebalance();
    }
  }

  private matchSeed(mapId: string, modeId: string): number {
    const h = hashString(`${this.seed}:${this.matchIndex}:${mapId}:${modeId}`);
    return (h % 2147483629) + 1;
  }

  /* ---------------------------------------------------------- countdown -- */

  private armCountdown(label = 'LAUNCHING'): void {
    const full = this.memberCount >= this.settings.maxPlayers;
    const total = full ? this.settings.fullCountdownSec : this.settings.countdownSec;
    this.countdown = { active: true, secondsLeft: total, total, label, abortedBy: null };
    this.announcedSecond = -1;
    this.setPhase('ready');
    this.emit('lobby:countdown', { secondsLeft: total, total, label });
  }

  private abortCountdown(reason: CountdownAbortReason): void {
    if (!this.countdown.active) return;
    this.countdown = {
      active: false, secondsLeft: 0, total: this.countdown.total, label: '', abortedBy: reason,
    };
    this.forcedStart = false;
    this.setPhase('forming');
    this.emit('lobby:countdown:abort', { reason, text: ABORT_TEXT[reason] });
    this.mark();
  }

  /* -------------------------------------------------------------- phases -- */

  private setPhase(phase: LobbyPhase): void {
    if (this.phase === phase) return;
    const previous = this.phase;
    this.phase = phase;
    this.phaseTime = 0;
    this.emit('lobby:phase', { phase, previous, clock: this.clock });
    this.mark();
  }

  /** Arms the countdown once the room is genuinely ready. */
  private evaluateGate(): void {
    if (this.phase !== 'forming') return;
    if (this.humanCount() < this.settings.minPlayers) return;
    if (!this.allReady()) return;
    this.armCountdown();
  }

  private beginLoading(): void {
    if (!this.booth.resolved) this.closeVote();
    if (this.settings.fillWithBots) this.fillBots();
    this.rebalance(true);

    this.countdown = { active: false, secondsLeft: 0, total: this.countdown.total, label: '', abortedBy: null };
    this.forcedStart = false;
    this.loadTimer = this.settings.loadTimeoutSec;
    for (const m of this.members) {
      if (m.connection === 'dropped') continue;
      m.connection = 'loading';
      m.loadProgress = m.profile.bot ? 1 : 0;
    }
    this.setPhase('loading');

    const config = this.launchConfig();
    this.emit('lobby:launch', config);
    this.emit('lobby:loading', {
      loaded: this.loadingMembers().filter((m) => m.loadProgress >= 1).length,
      total: this.loadingMembers().length,
      progress: 0,
    });
    this.mark();
  }

  private goLive(): void {
    for (const m of this.members) {
      if (m.connection === 'dropped') continue;
      m.connection = 'connected';
      m.loadProgress = 1;
    }
    this.setPhase('in-match');
  }

  private finishMatch(result: LobbyResult): void {
    this.lastResult = result;
    this.lastMapId = this.selection.mapId;
    const present = new Set(this.members.filter((m) => !m.profile.bot).map((m) => m.id));
    this.parties.noteMatchPlayed(present);
    this.matchIndex++;
    this.postTimer = this.settings.postMatchSec;
    this.setPhase('post-match');
    this.emit('lobby:result', result);
    this.mark();
  }

  /**
   * The loop that makes the lobby social: same room, same people, same parties,
   * cleared readies, fresh vote.
   */
  private recycle(): void {
    this.members = this.members.filter((m) => m.connection !== 'dropped' && !m.profile.bot);
    for (const m of this.members) {
      m.ready = false;
      m.loadProgress = 0;
      m.connection = 'connected';
      m.splitFromParty = false;
      if (this.settings.autoBalance) m.teamLocked = false;
    }
    if (!this.members.some((m) => m.id === this.leaderId)) this.promoteSuccessor();
    this.countdown = { active: false, secondsLeft: 0, total: 0, label: '', abortedBy: null };
    this.forcedStart = false;
    this.setPhase('forming');
    this.openVote();
    this.rebalance();
    this.parties.setLobbyCode(this.code);
    this.mark();
  }

  /* ----------------------------------------------------------------- tick -- */

  /** Advances every timer. Call once per frame with real seconds. */
  tick(dt: number): void {
    if (this.closed || dt <= 0) return;
    this.clock += dt;
    this.phaseTime += dt;

    if (this.settings.heartbeatTimeoutSec > 0) {
      for (const m of [...this.members]) {
        if (m.profile.bot || m.id === this.hostId) continue;
        if (this.clock - m.lastSeen > this.settings.heartbeatTimeoutSec) this.remove(m.id, 'timeout');
      }
    }

    switch (this.phase) {
      case 'forming': {
        if (this.booth.tick(dt, this.humanCount(), this.leaderId)) this.closeVote();
        this.evaluateGate();
        break;
      }
      case 'ready': {
        if (this.humanCount() < this.settings.minPlayers) { this.abortCountdown('too-few-players'); break; }
        if (!this.forcedStart && !this.allReady()) { this.abortCountdown('unready'); break; }
        this.countdown.secondsLeft = Math.max(0, this.countdown.secondsLeft - dt);
        const whole = Math.ceil(this.countdown.secondsLeft);
        if (whole !== this.announcedSecond) {
          this.announcedSecond = whole;
          this.emit('lobby:countdown', {
            secondsLeft: whole, total: this.countdown.total, label: this.countdown.label,
          });
          this.mark();
        }
        if (this.countdown.secondsLeft <= 0) this.beginLoading();
        break;
      }
      case 'loading': {
        const loading = this.loadingMembers();
        const loaded = loading.filter((m) => m.loadProgress >= 1).length;
        if (loading.length === 0 || loaded >= loading.length) { this.goLive(); break; }
        this.loadTimer -= dt;
        if (this.loadTimer <= 0) {
          // Stragglers are dropped — but never the host. Evicting the authority
          // from its own room leaves a lobby with a host and no members, which
          // is the one state nothing downstream can recover from.
          for (const m of loading) {
            if (m.loadProgress >= 1) continue;
            if (m.id === this.hostId) { m.loadProgress = 1; continue; }
            this.remove(m.id, 'load-timeout');
          }
          if (this.memberCount > 0) this.goLive();
          else { this.setPhase('forming'); this.openVote(); }
        }
        break;
      }
      case 'in-match': break;
      case 'post-match': {
        this.postTimer -= dt;
        if (this.postTimer <= 0) this.recycle();
        break;
      }
    }

    // A 1 Hz floor on state publishing keeps every visible clock (vote,
    // countdown, post-match) moving without shipping a full state per frame.
    const second = Math.floor(this.clock);
    if (second !== this.publishedSecond) { this.publishedSecond = second; this.mark(); }
    this.publish();
  }

  /* --------------------------------------------------------------- teams -- */

  private balanceMembers(): BalanceMember[] {
    return this.members
      .filter((m) => m.connection !== 'dropped')
      .map((m) => ({
        id: m.id, skill: m.profile.skill, partyId: m.partyId,
        team: m.team, teamLocked: m.teamLocked, bot: m.profile.bot,
      }));
  }

  /** Re-runs the balancer and writes the result back onto the members. */
  private rebalance(force = false): void {
    if (!force && !this.settings.autoBalance && this.phase === 'forming') { this.mark(); return; }
    const result = assignTeams(this.balanceMembers(), {
      teamCount: this.settings.teamCount,
      maxPlayers: this.settings.maxPlayers,
      keepPartiesTogether: this.settings.keepPartiesTogether,
      salt: this.id,
    });
    for (const a of result.assignments) {
      const m = this.members.find((x) => x.id === a.playerId);
      if (!m) continue;
      m.team = a.team;
      m.splitFromParty = a.splitFromParty;
    }
    this.splitParties = result.splitParties;
    this.skillGap = Math.round(result.skillGap * 100) / 100;
    this.emitTeams();
    this.mark();
  }

  private emitTeams(): void {
    this.emit('lobby:teams', {
      teams: summariseTeams(this.balanceMembers(), findMode(this.catalog, this.selection.modeId), {
        teamCount: this.settings.teamCount, maxPlayers: this.settings.maxPlayers,
      }),
      splitParties: [...this.splitParties],
      skillGap: this.skillGap,
    });
  }

  private emitParties(): void {
    this.emit('lobby:party:update', {
      parties: this.partyViews(),
      localPartyId: this.parties.partyOf(this.hostId)?.id ?? null,
    });
  }

  /* ---------------------------------------------------------------- bots -- */

  private fillBots(): void {
    const mode = findMode(this.catalog, this.selection.modeId);
    const cap = Math.min(this.settings.maxPlayers, mode?.maxPlayers ?? this.settings.maxPlayers);
    while (this.memberCount < cap) {
      const name = BOT_NAMES[this.rand.int(0, BOT_NAMES.length - 1)];
      const id = `bot_${this.botCounter++}`;
      const profile = makeProfile(id, name, {
        bot: true,
        platform: 'bot',
        rank: this.rand.int(4, 40),
        skill: Math.round(this.rand.range(0.3, 0.75) * 100) / 100,
      });
      const m = this.insert(profile);
      m.ready = true;
    }
  }

  /* -------------------------------------------------------------- launch -- */

  launchConfig(): MatchConfig {
    const map = findMap(this.catalog, this.selection.mapId) ?? this.catalog.maps[0];
    const mode = findMode(this.catalog, this.selection.modeId) ?? this.catalog.modes[0];
    const roster: MatchRosterEntry[] = this.members
      .filter((m) => m.connection !== 'dropped')
      .map((m) => ({
        id: m.id,
        name: m.profile.name,
        team: m.team,
        partyId: m.partyId,
        bot: m.profile.bot,
        skill: m.profile.skill,
        profile: { ...m.profile },
      }));
    return {
      lobbyId: this.id,
      code: this.code,
      matchIndex: this.matchIndex,
      hostId: this.hostId,
      modeId: mode.id,
      mapId: map.id,
      levelId: map.levelId,
      hour: map.hour,
      rain: map.rain,
      fog: map.fog,
      wind: map.wind,
      seed: this.selection.seed,
      teamCount: this.settings.teamCount,
      teamNames: [...mode.teamNames] as [string, string],
      roster,
    };
  }

  /** Convenience for the game layer: report the match result to the lobby. */
  reportResult(result: LobbyResult): CommandResult {
    return this.submit({ t: 'matchEnded', result }, this.hostId);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('lobby:closed', { id: this.id, reason });
  }

  /* ------------------------------------------------------------ counting -- */

  private humans(): Member[] {
    return this.members.filter((m) => m.connection !== 'dropped' && !m.profile.bot);
  }
  private humanCount(): number { return this.humans().length; }
  private readyCount(): number { return this.humans().filter((m) => m.ready).length; }
  private allReady(): boolean {
    const h = this.humans();
    return h.length > 0 && h.every((m) => m.ready);
  }
  private loadingMembers(): Member[] {
    return this.members.filter((m) => m.connection === 'loading');
  }

  /* --------------------------------------------------------- read model -- */

  private view(m: Member): MemberState {
    return {
      id: m.id,
      profile: { ...m.profile },
      partyId: m.partyId,
      team: m.team,
      connection: m.connection,
      ready: m.ready,
      loadProgress: m.loadProgress,
      host: m.id === this.hostId,
      leader: m.id === this.leaderId,
      partyLeader: this.parties.partyOf(m.id)?.leaderId === m.id,
      joinedAt: Math.round(m.joinedAt * 100) / 100,
      ping: m.ping,
      vote: this.booth.voteOf(m.id),
      slot: m.slot,
      teamLocked: m.teamLocked,
    };
  }

  private partyViews(): PartyView[] {
    const present = new Set(this.members.filter((m) => m.connection !== 'dropped').map((m) => m.id));
    return this.parties.all()
      .filter((p) => p.members.some((id) => present.has(id)))
      .map((p) => ({
        id: p.id,
        leaderId: p.leaderId,
        members: p.members.filter((id) => present.has(id)),
        matchesTogether: p.matchesTogether,
        colour: p.colour,
        split: this.splitParties.includes(p.id),
      }));
  }

  private statusLine(): string {
    switch (this.phase) {
      case 'forming': {
        const missing = this.settings.minPlayers - this.humanCount();
        if (missing > 0) return `WAITING FOR ${missing} MORE PLAYER${missing === 1 ? '' : 'S'}`;
        const notReady = this.humanCount() - this.readyCount();
        if (notReady > 0) return `WAITING FOR ${notReady} PLAYER${notReady === 1 ? '' : 'S'} TO READY UP`;
        return 'READY';
      }
      case 'ready': return `${this.countdown.label} IN ${Math.ceil(this.countdown.secondsLeft)}`;
      case 'loading': {
        const l = this.loadingMembers();
        const done = l.filter((m) => m.loadProgress >= 1).length;
        return `LOADING ${done}/${l.length}`;
      }
      case 'in-match': return 'MATCH IN PROGRESS';
      case 'post-match': return `NEXT MATCH IN ${Math.ceil(Math.max(0, this.postTimer))}`;
    }
  }

  private build(): LobbyState {
    const state: LobbyState = {
      id: this.id,
      code: this.code,
      phase: this.phase,
      phaseTime: Math.round(this.phaseTime * 100) / 100,
      clock: Math.round(this.clock * 100) / 100,
      epoch: this.epoch,
      seq: this.seq,
      hostId: this.hostId,
      leaderId: this.leaderId,
      settings: { ...this.settings },
      members: this.members.map((m) => this.view(m)),
      parties: this.partyViews(),
      teams: summariseTeams(this.balanceMembers(), findMode(this.catalog, this.selection.modeId), {
        teamCount: this.settings.teamCount, maxPlayers: this.settings.maxPlayers,
      }),
      vote: this.booth.state(),
      countdown: { ...this.countdown, secondsLeft: Math.round(this.countdown.secondsLeft * 10) / 10 },
      selection: { ...this.selection },
      readyCount: this.readyCount(),
      connectedCount: this.memberCount,
      capacity: this.settings.maxPlayers,
      matchesPlayed: this.matchIndex,
      lastResult: this.lastResult ? { ...this.lastResult } : null,
      message: this.statusLine(),
    };
    this.cached = state;
    this.dirty = false;
    return state;
  }

  /**
   * `dirty` invalidates the cached read model; `pending` remembers that the
   * change has not been announced yet. They are separate because reading
   * `.state` must never swallow the next `lobby:state` emit.
   */
  private mark(): void { this.dirty = true; this.pending = true; }

  /** Publishes a new state if anything changed. The only emitter of `lobby:state`. */
  publish(): LobbyState {
    if (!this.pending && this.cached) return this.cached;
    this.pending = false;
    this.seq++;
    this.dirty = true;
    const state = this.build();
    this.emit('lobby:state', state);
    return state;
  }

  /* ----------------------------------------------------- host migration -- */

  /** The complete authoritative state, as JSON. */
  export(): LobbySnapshot {
    const state = this.state;
    return {
      version: 1,
      state: JSON.parse(JSON.stringify(state)) as LobbyState,
      seed: this.seed,
      matchIndex: this.matchIndex,
      lastMapId: this.lastMapId,
      parties: this.parties.snapshot(),
      phaseTimer: this.phase === 'loading' ? this.loadTimer
        : this.phase === 'post-match' ? this.postTimer
          : this.countdown.secondsLeft,
      ballot: this.booth.ballot(),
      forcedStart: this.forcedStart,
    };
  }

  /**
   * Rebuilds a host from a snapshot on a different machine.
   *
   * The successor bumps `epoch` so stale messages from the old host are
   * ignored, drops the peer that vanished, and — if a countdown was armed —
   * extends it by `hostMigrationGraceSec` rather than launching into a
   * half-connected room.
   */
  static adopt(
    snapshot: LobbySnapshot,
    opts: {
      hostId: PlayerId;
      emit?: SessionEmitter;
      catalog?: LobbyCatalog;
      /** Peer that went away; removed from the roster. */
      departed?: PlayerId | null;
      /**
       * The successor's own registry. Passing it keeps one party book on this
       * machine — without it the resumed host and the surrounding session would
       * each hold a copy and drift apart on the next invite.
       */
      parties?: PartyRegistry;
    },
  ): LobbyHost {
    const s = snapshot.state;
    const host = new LobbyHost({
      hostId: opts.hostId,
      hostProfile: s.members.find((m) => m.id === opts.hostId)?.profile
        ?? makeProfile(opts.hostId, 'Host'),
      settings: s.settings,
      seed: snapshot.seed,
      code: s.code,
      id: s.id,
      emit: opts.emit,
      catalog: opts.catalog,
      parties: opts.parties,
      resuming: true,
    });

    host.parties.restore(snapshot.parties);
    host.parties.setLobbyCode(s.code);
    host.matchIndex = snapshot.matchIndex;
    host.lastMapId = snapshot.lastMapId;
    host.lastResult = s.lastResult;
    host.selection = { ...s.selection };
    host.clock = s.clock;
    host.phaseTime = s.phaseTime;
    host.epoch = s.epoch + 1;
    host.seq = s.seq;
    host.forcedStart = snapshot.forcedStart;
    host.settings = { ...s.settings };

    // Rebuild the roster, minus whoever we just lost.
    host.members = [];
    host.nextSlot = 0;
    for (const mv of s.members) {
      if (mv.id === opts.departed) continue;
      if (mv.connection === 'dropped') continue;
      host.members.push({
        id: mv.id,
        profile: { ...mv.profile },
        partyId: mv.partyId,
        team: mv.team,
        connection: mv.connection === 'joining' ? 'connected' : mv.connection,
        ready: mv.ready,
        loadProgress: mv.loadProgress,
        joinedAt: mv.joinedAt,
        ping: mv.ping,
        slot: mv.slot,
        teamLocked: mv.teamLocked,
        splitFromParty: false,
        lastSeen: s.clock,
      });
      host.nextSlot = Math.max(host.nextSlot, mv.slot + 1);
    }
    host.botCounter = host.members.filter((m) => m.profile.bot).length;

    host.leaderId = host.members.some((m) => m.id === s.leaderId && !m.profile.bot)
      ? s.leaderId
      : opts.hostId;

    host.booth = new VoteBooth(s.id, snapshot.matchIndex, snapshot.lastMapId);
    host.booth.load(s.vote, snapshot.ballot);

    host.phase = s.phase;
    host.countdown = { ...s.countdown };
    if (s.phase === 'loading') host.loadTimer = Math.max(snapshot.phaseTimer, 5);
    else if (s.phase === 'post-match') host.postTimer = snapshot.phaseTimer;

    // Give the room a moment to notice the handover before launching it.
    if (host.phase === 'ready' && host.countdown.active) {
      host.countdown.secondsLeft = Math.max(
        snapshot.phaseTimer, host.settings.hostMigrationGraceSec,
      );
      host.countdown.total = Math.max(host.countdown.total, host.countdown.secondsLeft);
      host.announcedSecond = -1;
    }

    host.emit('lobby:host:migrated', {
      from: s.hostId, to: opts.hostId, epoch: host.epoch,
      graceSec: host.phase === 'ready' ? host.settings.hostMigrationGraceSec : 0,
    });
    host.mark();
    host.publish();
    return host;
  }
}

const ABORT_TEXT: Record<CountdownAbortReason, string> = {
  'member-left': 'LAUNCH ABORTED — PLAYER LEFT',
  'member-dropped': 'LAUNCH ABORTED — PLAYER DISCONNECTED',
  'member-joined': 'LAUNCH ABORTED — PLAYER JOINED',
  'unready': 'LAUNCH ABORTED — PLAYER NOT READY',
  'settings-changed': 'LAUNCH ABORTED — SETTINGS CHANGED',
  'leader-cancelled': 'LAUNCH CANCELLED',
  'too-few-players': 'LAUNCH ABORTED — NOT ENOUGH PLAYERS',
  'host-migrated': 'LAUNCH HELD — HOST MIGRATED',
};
