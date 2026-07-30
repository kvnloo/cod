# Session and meta layer

*The spine that turns seven independent systems into one game.*

This document is the contract. `src/session/Flow.ts` is the journey as code,
`src/session/SessionSystem.ts` is the engine-facing system that owns it, and
everything below describes what other modules may rely on.

Verified by `node tools/session-flow.mjs` — it drives the entire journey
headlessly, then does it again injecting a failure at every stage.

---

## 1. The journey

```
                         ┌──────────────────────────────────────────┐
                         │                                          │
  boot ──ready──► mainMenu ──play──► lobby ──search──► matchmaking   │
                    │  ▲   ◄─leave────┘  ▲                  │        │
                 party  │                │               found       │
                    │   └───disband──────┘                  ▼        │
                    └────play────────────┘             loading       │
                                                          │          │
                                                       loaded        │
                                                          ▼          │
                                                      preMatch       │
                                                          │          │
                                                         go          │
                                                          ▼          │
                                                        live         │
                                                          │          │
                                                      finished       │
                                                          ▼          │
                                                     postMatch       │
                                                          │          │
                                                       report        │
                                                          ▼          │
                                                    afterAction ─────┘
                                                     toLobby
```

Thirteen states. `migrating`, `fault` and `shutdown` are the recovery group and
are drawn separately in §4 because every match state can enter them.

| State | What is true | Who is simulating |
|---|---|---|
| `boot` | Engine systems initialising. Nothing is interactive. | nothing |
| `mainMenu` | Front end. No match exists; the world renders behind the menu. | nothing |
| `party` | Party management. Survives everything below it — that is the point. | nothing |
| `lobby` | Mode, map and loadout selection. Home of an assembled party. | nothing |
| `matchmaking` | Searching for a session, or standing one up locally. | nothing |
| `loading` | Map/asset load and the first authoritative snapshot. | nothing |
| `preMatch` | Spawned, weapons holstered, countdown running. Non-scoring. | `MatchRunner` (`warmup`) |
| `live` | The match. `MatchRunner` owns everything inside this state. | `MatchRunner` |
| `postMatch` | Frozen scoreboard / final killcam. Sim stopped, rendering not. | `MatchRunner` (`ending`) |
| `afterAction` | XP ledger, rank-up, unlocks, replay handle. | nothing |
| `migrating` | Host migration in flight. | nothing |
| `fault` | Unrecoverable-in-place error. | nothing |
| `shutdown` | Terminal. | nothing |

**The session flow and the match phase machine are different things and must not
be conflated.** `MatchPhase` (`idle → warmup → live ⇄ intermission → ending →
ended`, in `src/game/types.ts`) describes the *inside* of a round and is owned by
`MatchRunner`. `FlowState` describes the client's journey *around* rounds. The
session never writes a match phase and the match never writes a flow state; they
meet at exactly two points — `SessionSystem` calls `DirectorAPI.startMatch()` on
entering `live`, and observes `game:over` / `MatchPhase === 'ended'` to leave it.

### Relationship to `LobbyPhase`

`src/session/types.ts` defines `LobbyPhase` (`forming | ready | loading |
in-match | post-match`) for the lobby's own read model. That is a *server-side*
view of one lobby; `FlowState` is *this client's* view of its own journey. They
correspond, but not one-to-one — a client that joins in progress is in
`FlowState.loading` while the lobby is already `in-match`.

| `LobbyPhase` | Typical `FlowState` |
|---|---|
| `forming` | `lobby` (or `party`, `matchmaking`) |
| `ready` | `lobby`, countdown armed |
| `loading` | `loading` |
| `in-match` | `preMatch`, `live`, `postMatch` |
| `post-match` | `afterAction` |

---

## 2. Transitions

The full table is `FLOW` in `src/session/Flow.ts` and it is exhaustive: **if a
transition is not in that table it does not exist.** Every type in the module is
derived from the table, so an illegal transition is a compile error, not a
runtime check:

```ts
flow.at('lobby')?.send('search')     // ✓ compiles
flow.at('lobby')?.send('finished')   // ✗ TS2345 — 'finished' is a live-only event
```

`tools/session-flow.mjs` proves this by running `tsc` over both snippets and
asserting the second one fails with TS2345.

| From | Event | To | Meaning |
|---|---|---|---|
| `boot` | `ready` | `mainMenu` | Engine init finished |
| `mainMenu` | `party` | `party` | Open party management |
| `mainMenu` | `play` | `lobby` | Enter the lobby |
| `mainMenu` | `quit` | `shutdown` | Leave the game |
| `party` | `play` | `lobby` | Take the party into a lobby |
| `party` | `disband` / `back` | `mainMenu` | Break up / go back |
| `lobby` | `search` | `matchmaking` | Start looking for a session |
| `lobby` | `party` | `party` | Back to party management |
| `lobby` | `leave` | `mainMenu` | Leave the lobby |
| `matchmaking` | `found` | `loading` | A session exists; here is the launch order |
| `matchmaking` | `cancel` | `lobby` | Player cancelled |
| `matchmaking` | `timeout` | `lobby` | Search exceeded `searchTimeout` |
| `matchmaking` | `unfillable` | `lobby` | Could not form a session at all |
| `loading` | `loaded` | `preMatch` | Map ready, first snapshot applied |
| `loading` | `loadFailed` | `lobby` | Load errored or timed out |
| `loading` | `abort` | `lobby` | Player backed out |
| `preMatch` | `go` | `live` | Countdown elapsed; match starts |
| `preMatch` | `abort` | `lobby` | Player backed out |
| `live` | `finished` | `postMatch` | The match ended normally |
| `live` | `abandon` | `afterAction` | Player quit out mid-match |
| `postMatch` | `report` | `afterAction` | Scoreboard beat elapsed |
| `afterAction` | `toLobby` | `lobby` | **Back to the lobby, party intact** |
| `afterAction` | `toMenu` | `mainMenu` | Leave the lobby entirely |
| `afterAction` | `rematch` | `loading` | Run it back, same session |
| `fault` | `recover` | `mainMenu` | Acknowledge the error |
| `fault` | `quit` | `shutdown` | Give up |

Three events recur on every state that can suffer them: `fail` → `fault`,
`hostLost` → `migrating`, `dropped` → the safest local state. See §4.

### `deploy` — the one pseudo-event

`SessionSystem.request('deploy')` (and `SessionSystem.deploy(mode?)`) is **not** a
flow edge. It is a goal — *"get me into a match from wherever I am"* — and it
walks whatever front-end edges are needed:

```
afterAction --toLobby--> lobby --search--> matchmaking
mainMenu    --play-----> lobby --search--> matchmaking
fault       --recover--> mainMenu --play--> lobby --search--> matchmaking
```

It exists because the UI's Deploy button fires from the main menu, the party
screen and the after-action report, and making every caller know the
intermediate edges would be a trap. Everything else the UI sends must be a real
event name.

### Routing

`route(from, to)` returns the shortest legal event sequence. It deliberately
never uses a recovery state as a *stepping stone*, only as a destination —
without that rule the shortest path from `boot` to `live` is
`search → hostLost → resumeLive`, which is legal, shorter and completely wrong:
planning a journey through error handling would flash "RECONNECTING" on a clean
single-player boot. (This was a real bug caught by the verifier.)

---

## 3. Authority

> **The host decides. Clients request and display.**

`src/net/` is being built in parallel. The session codes against a four-member
seam, `NetPort`, and behaves as an offline host when it is absent — which is
exactly the single-player case, so there is no separate "SP code path".

```ts
interface NetPort {
  readonly role: NetRole;              // 'host' | 'client' | 'offline'  (src/net/types.ts)
  readonly connection: ConnectionState;
  readonly localId: string;
  requestFlow?(event: string, reason?: string): void;   // client → host
  publishFlow?(state: FlowState, seq: number): void;    // host → clients
}
```

| Role | `request(event)` does | State changes via |
|---|---|---|
| host / offline | applies locally, then `publishFlow(to, seq)` | `Flow.send` |
| client | `net.requestFlow(event, reason)`, **nothing local** | `Flow.adopt(state, seq)` only |

`Flow.adopt()` is the only way to reach a state without a legal edge. It is
reserved for the netcode layer: a client must never invent a state, but it must
be able to follow the host anywhere. Updates with a `seq` at or behind the
current one are ignored, so out-of-order packets cannot rewind the front end.

The single exception is leaving `boot`: you cannot be in somebody else's session
before your own systems have come up, so `boot --ready--> mainMenu` is always
local.

**What the netcode layer needs to call** (nothing else is required):

```ts
session.adopt(state, seq)          // authoritative flow update from the host
session.notifyHostLost(detail?)    // the session host went away
session.notifyMigrated()           // migration succeeded; resume where we were
session.notifyDropped(detail?)     // *we* lost our connection
```

`notifyMigrated()` picks the resume event from the state we left:
`live → resumeLive`, `postMatch → resumePostMatch`, `loading`/`preMatch →
resumeLoading`, anything else → `resumeLobby`.

---

## 4. Failure paths

Every one of these is exercised by `tools/session-flow.mjs`.

| Failure | Where | Event taken | Lands in | Player sees |
|---|---|---|---|---|
| Match cannot fill | `matchmaking` | `unfillable` | `lobby` | `NO SESSION FOUND` |
| Search exceeds `searchTimeout` | `matchmaking` | `timeout` | `lobby` | `SEARCH TIMED OUT` |
| Player cancels the search | `matchmaking` | `cancel` | `lobby` | — |
| Map load errors | `loading` | `loadFailed` | `lobby` | `LOAD FAILED` |
| Map load exceeds `loadTimeout` | `loading` | `loadFailed` | `lobby` | `LOAD TIMED OUT` |
| `startMatch()` throws | `live` | `abort` → `fail` | `fault` | `DEPLOY FAILED` |
| Host drops | any match state | `hostLost` | `migrating` | `RECONNECTING` |
| Migration succeeds | `migrating` | `resume*` | back where we were | — |
| Migration exceeds `migrate` | `migrating` | `migrateFailed` | `lobby` | — |
| **We** disconnect, in a match | `live` / `postMatch` | `dropped` | `afterAction` | `CONNECTION LOST` |
| **We** disconnect, in the front end | `matchmaking` / `loading` / `preMatch` | `dropped` | `lobby` | `CONNECTION LOST` |
| Anything unrecoverable | any | `fail` | `fault` | the fault title |

Rules the implementation guarantees:

1. **A failed load never starts a match.** Verified.
2. **Migration never restarts a running match.** Resuming `live` re-enters the
   state without calling `startMatch` again. Verified.
3. **An abandoned or dropped match still produces an after-action report**, with
   `abandoned: true` and `xpEarned: 0`. This matches `Progression`'s existing
   rule that the XP ledger is only banked on `commit()`, so leaving a match
   awards nothing. Verified.
4. **Every non-terminal state can reach the lobby again.** Asserted structurally
   by `validateFlow()`.

---

## 5. Events — the UI contract

The UI module (`src/ui/`) owns every pixel; the session owns every fact. The
interface between them is these events, declared by interface merging in
`SessionSystem.ts` so no shared file is edited.

### Session → UI

| Event | Payload | When |
|---|---|---|
| `session:state` | `{ state, previous, event, reason, seq, authoritative, online, isHost }` | Every transition. **The one event the UI must handle.** |
| `session:snapshot` | `SessionSnapshot` | Throttled (default 4 Hz) and on every transition. Read it, do not retain it. |
| `session:countdown` | `{ seconds, total, label }` | Once per whole second while a timer is armed. `label` is renderable verbatim: `DEPLOYING`, `MATCH OVER`, `CONTINUE`, `RECONNECTING`. |
| `session:search` | `{ elapsed, players, target, region }` | Every frame while `matchmaking`. |
| `session:load` | `{ map, progress, done }` | Every frame while `loading`. `progress` is 0..1. |
| `session:fault` | `SessionFault` | On any failure. `{ kind, title, detail, recoverable, at }`; `title` is an all-caps headline, `detail` a one-liner. |
| `session:report` | `SessionReport` | Once per match, on entering `afterAction`. |
| `session:notice` | `{ text, kind: 'info' \| 'warn' \| 'error' }` | Free-form toast. |

### UI → Session

Exactly one event. There is no other inbound channel, and it is a *request* —
the host may ignore it.

```ts
bus.emit('session:request', { event: 'deploy' });          // take me into a match
bus.emit('session:request', { event: 'cancel' });          // stop searching
bus.emit('session:request', { event: 'toLobby' });         // leave the AAR
bus.emit('session:request', { event: 'rematch' });         // run it back
bus.emit('session:request', { event: 'recover' });         // acknowledge an error
```

Illegal events are dropped silently. To know which buttons to enable, read
`SessionSnapshot.legal` — it is the list of event names legal right now, straight
from the table. Render buttons from that array and you cannot desynchronise from
the machine.

### Rendering hints

`FLOW_META[state]` carries `label` (all-caps status), `group`, `inMatch`,
`needsNet`, `simulate` and `screen`. `screen` uses the names already in
`src/ui/UiEvents.ts` (`UiScreenName`), so no translation table is needed:

| Flow state | `screen` | Note |
|---|---|---|
| `boot`, `loading`, `preMatch`, `live`, `postMatch`, `migrating`, `shutdown` | `none` | HUD only |
| `mainMenu`, `party`, `lobby`, `matchmaking`, `fault` | `main` | — |
| `afterAction` | `summary` | — |

**Requested of the UI module:** `UiScreenName` has no `lobby`, `party`,
`matchmaking` or `aar` member yet, so four distinct states currently collapse
onto `main`. When those screens exist, add the names and I will point `FLOW_META`
at them — that is a one-line change per state on my side and no change anywhere
else.

### `SessionSnapshot`

One object, everything a front-end screen needs. Full definition in
`SessionSystem.ts`; the fields that matter most:

```
state, previous, seq, elapsed, label, screen
online, isHost, connection, localId
mode, map, loadoutName
members[], partySize, humans
countdown, countdownLabel, searchElapsed, searchTarget, loadProgress
rank, rankName, xpIntoRank, xpForNext
legal[]          // flow events legal right now — render buttons from this
statusLine       // one renderable line, correct for every state
fault, report
degraded[]       // which services are running on a local fallback
```

---

## 6. Ports — how the surrounding systems attach

Every peer system is optional and duck-typed out of the engine registry, exactly
the pattern `src/game/Services.ts` uses. A system that has not landed yet, or one
that changed shape, costs a fallback rather than a crash.

| Port | Engine name | Fallback when absent |
|---|---|---|
| `MatchPort` | `director` | none — session runs without a match |
| `LobbyPort` | `lobby` | `LocalLobby`: one seat, mode from URL/profile |
| `MatchmakingPort` | `matchmaking` | `LocalMatchmaking`: bot-fills after `searchPatience` |
| `MapLoadPort` | `maploader`, else `world` | `InstantMapLoad`: the level is already in memory |
| `LoadoutPort` | `loadout` | name `DEFAULT` |
| `ProgressionPort` | `director.match.progression` | rank 1 |
| `NetPort` | `net` | offline host |

`SessionSnapshot.degraded` lists which fallbacks are live, so the state is
visible rather than silent.

A port may also be injected directly — `new SessionSystem({ ports })` or
`session.attach({ ... })` — which is how the headless verifier drives real code
with fake peers.

**Implementers:** satisfy the interface in `SessionSystem.ts` and register your
system under the engine name above. Nothing else is required; there is no
registration call and no ordering constraint.

### 6.1 Bridges — for the modules that already exist

The six session subsystems were written in parallel with this file and none of
them speak the port vocabulary above, because none of them should have to. The
adapters live here, in `SessionSystem.ts`, and are structural: each takes
`unknown`, proves the shape at runtime and returns a port or `null`. Nothing in
another agent's module was changed to make this work.

| Bridge | Accepts | Produces |
|---|---|---|
| `lobbyPortFrom(src, fallback?)` | a `LobbySession`, or anything owning one (`LobbySystem.session`), or an existing `LobbyPort` | `LobbyPort` |
| `matchmakingPortFrom(src, opts?)` | a `MatchmakingService` (`requestJoin` / `update` / `snapshot`) | `MatchmakingPort` |
| `loadoutPortFrom(src)` | a `LoadoutBook` (`current()`) | `LoadoutPort` |

What each one has to reconcile:

- **Lobby.** `LobbyState` is fat (parties, votes, teams, settings, epochs);
  `SessionLobbyView` is the flat slice the front end draws. `MemberState`
  flattens to `SessionMember`, `countdown.secondsLeft` to `countdown`. Intents
  go back out as the lobby's own commands — `setMode` → `{ t: 'pin' }`,
  `requestLaunch` → `ready(true)` then `{ t: 'start' }`, `requestCancel` →
  `{ t: 'cancel' }` — so the host still adjudicates every one of them and a
  non-leader's command is refused exactly as it would be from the lobby UI.
  `fallback` covers the frames before a lobby exists, so the front end shows
  your own party instead of flashing an empty room.
- **Matchmaking.** The service is ticket-shaped and *deliberately owns no
  clock*: `update(now)` takes absolute seconds. The bridge keeps that clock and
  advances it from the session's `tick(dt)`, so matchmaking inherits the
  session's determinism instead of wall time. `search()` enqueues humans only
  (bots are the matchmaker's job, not the party's) on the playlist for the mode
  — `tdm → core-tdm-6v6`, `operation → operation-coop-4`,
  `firefight → firefight-coop-4`, overridable via `opts.playlistFor`. A formed
  `MatchRoster` becomes a `MatchLaunch`, with roster team indices `0/1` mapped
  onto `alpha/bravo`. The service reports "still looking", never "gave up", so
  the session's own `searchTimeout` is what turns a hopeless search into a
  failure.
- **Loadout.** The module has two faces: `LoadoutBook` is the client's saved
  classes, `LoadoutService` is the host's grant authority. The session only ever
  needs the active class *name*, so it bridges the book. The host face is
  exposed through the service registry instead (§7.1).

Measured, end to end: the real `MatchmakingService` fills a solo search with 11
bots into a 12-slot roster after 25 s of simulated queue time, and the real
`LobbySystem` and `LoadoutBook` bind on the first frame.

---

## 7. Installation, and why single-player cannot regress

There is exactly one call:

```ts
import { installSession } from './session/SessionSystem';

installSession(engine);                       // local session — this is single player
installSession(engine, {                      // …or hand it the meta layer
  lobby: new LobbySystem(),                   // a System — registered for you
  matchmaking: new MatchmakingService({ seed }),
  loadout: book,
});
```

Everything is optional, subsystems are bridged onto ports (§6.1), any subsystem
that is itself a `System` is registered so the engine ticks it, and the call is
idempotent — a session already in the registry is returned untouched.

**`src/main.ts` does not call it.** `main.ts` belongs to another agent, so
`src/game/Services.ts` arms the session instead: `resolveServices()` — which
`GameDirector.init` already calls — subscribes once to `game:ready` and installs
there. Three details are load-bearing:

1. **Deferred to `game:ready`.** `Engine.init()` walks `this.systems` with
   `for…of` while we are inside `GameDirector.init`, and `Engine.add` pushes
   *and re-sorts* that same array — which can make the loop revisit or skip a
   system. `game:ready` fires once the loop has finished, so adding there is
   safe. `init` is then called by hand because the engine will not run its init
   pass again.

2. **Dynamically imported.** `src/session/` sits *around* the match, not under
   it. A static import would invert that and pull the whole meta layer into
   every headless game test; the dynamic one keeps `src/game` standalone and
   lets the bundler split it into its own chunk. Any failure is caught and
   logged — the game then runs exactly as it did before the session existed.

3. **It never starts a match that is already running.** `GameDirector` boots a
   match on its own today. When it has, the session **adopts** it: fast-forwards
   the flow to `live` with every intermediate state announced but *no side
   effects run*, sets `adopted`/`launched`, and leaves the director completely
   alone. Adoption is bookkeeping to catch up with reality, not a journey.

   In capture mode the session is installed `passive` and never starts anything,
   so it cannot spawn soldiers into another module's shots — verified in the real
   browser build by `tools/session-live.mjs`.

`startMatchIfNeeded()` is the only place a match is ever started, and `adopted`
and `launched` between them make a double-start impossible. The verifier asserts
`starts === 0` for an adopted match and `starts === 1` for a fresh one.

*If `main.ts` ever wants the session earlier or with subsystems attached, the
change is one line — `installSession(engine, { … })` next to the other
`engine.add` calls — and `armSessionLayer` will then no-op, because installation
is idempotent.*

### 7.1 The service registry

`src/game/Services.ts` is how the match layer *finds* the meta layer without
depending on it. `resolveServices()` fills `GameServices.meta` with:

| Field | Resolved from | Surface |
|---|---|---|
| `session` | engine `session` | `state()`, `isHost()`, `online()`, `request(event, reason?)` |
| `lobby` | engine `lobby`, else `session.subsystems.lobby` | `phase()`, `members()`, `launch()` |
| `loadout` | engine `loadout`, else `session.subsystems.loadout` | `activeName()`, `activeFor(id)`, `notifySpawn(id)` |
| `matchmaking` | engine `matchmaking`, else `session.subsystems.matchmaking` | `state()`, `waited()`, `roster()` |
| `spawns`, `replay` | engine, else `session.subsystems` | opaque handles |

Three rules govern this table:

- **No imports.** Every bridge is structural, so `src/game` never depends on
  `src/session` and still compiles, runs and self-tests with the whole session
  layer deleted. `NO_META` is what a build with no meta layer resolves to.
- **Accessors, not fields.** These read live state; a snapshot taken at resolve
  time would be a lie one frame later.
- **Most of the meta layer is not a `System`.** A `MatchmakingService` or a
  `LoadoutBook` has no frame to consume, so it never appears in the engine
  registry. `SessionSystem.subsystems` is where `installSession` records the raw
  handles, and it is the fallback for every lookup above.

`session.request()` is a *request*, not a command, in the registry exactly as it
is on the bus: the host applies it, a client forwards it, and the caller must
re-read `state()` rather than assume.

---

## 8. Reconciliations

Where two modules disagreed, this is what was changed and why. **Nobody else's
files were edited** — every reconciliation is absorbed on the session side.

1. **`game:start` carries `mode: 'domination'`.**
   `src/ui/HUD.ts` wires the main menu's Deploy button to
   `bus.emit('game:start', { mode: 'domination' })`, but this build ships
   `operation | tdm | firefight`. Rather than break the button, `normaliseMode()`
   maps unknown ids onto the nearest shipping mode
   (`domination|hardpoint|deathmatch|ffa → tdm`, `survival|zombies|horde →
   firefight`, anything else → `operation`) and the session deploys.
   *If the modes module lands `dom` for real, delete that alias.*

2. **`game:start` is both an intent and an announcement.**
   The UI emits it to mean "deploy"; `MatchRunner.start()` emits it to mean "a
   match has begun". The session disambiguates by state: in a front-end state it
   is a deploy request, anywhere else it is the match layer echoing our own
   launch and is ignored. Verified both ways.

3. **`LobbyPhase` vs `FlowState`.** Kept separate; mapping in §1. The lobby's
   phase is the server's view of a lobby, the flow state is this client's view of
   its journey, and a join-in-progress client makes them differ legitimately.

4. **`lobby:launch` is not on the typed bus yet.**
   `src/session/types.ts` documents `MatchConfig` being emitted on `lobby:launch`,
   but the lobby module has not declared the key on `GameEvents`. The session
   subscribes structurally and validates the payload at runtime (`modeId` string,
   `seed` number, everything else optional), so a malformed order is ignored
   rather than trusted. When the typed key lands this becomes a plain
   `bus.on('lobby:launch', …)` and the runtime validation can stay as defence.

5. **`MatchLaunch` vs `MatchConfig`.** `MatchLaunch` is a structural *subset* of
   `MatchConfig` — the fields the session acts on — so a matchmaker or lobby can
   hand over the full `MatchConfig` and it simply fits. No adapter, no drift.

6. **Team vocabulary.** `SessionTeam` (`alpha | bravo | none`, absolute) and
   `Team` (`friendly | hostile`, player-relative) both exist and both are right.
   The session speaks `SessionTeam`; `toGameTeam()` in `src/session/types.ts`
   converts at the boundary.

7. **The session does not touch the simulation clock.** `FLOW_META.simulate`
   reports whether the sim *should* be running, but `MatchRunner.setPaused()`
   owns `time.scale`. Two writers on one clock would fight; the session reports
   and the match decides.

8. **`LobbySystem` is a `System`; `LobbyPort` wanted a plain `view()`.**
   Neither side changed. `lobbyPortFrom` reaches through `.session` for the
   `LobbyState` and flattens it (§6.1). The same bridge accepts a bare
   `LobbySession`, so a build that never registers `LobbySystem` still works.

9. **`MatchmakingService` is ticket-shaped and clocked in absolute seconds;
   `MatchmakingPort` is search-shaped and clocked in deltas.**
   `matchmakingPortFrom` owns the translation, including the clock — which is
   what makes matchmaking deterministic under the session's fixed step rather
   than dependent on wall time. The mode → playlist choice lives in the bridge
   because the two modules disagree about what the unit of matchmaking is (a
   mode vs a playlist); `opts.playlistFor` is the escape hatch.

10. **The loadout module has two faces.** `LoadoutBook` (client, saved classes)
    and `LoadoutService` (host, grants) are different objects with no common
    interface. `LoadoutPort` bridges the book; `LoadoutBridge` in
    `src/game/Services.ts` accepts *either or both* and answers emptily for the
    half that is absent, so callers never branch on which one a build installed.

11. **Nothing in the meta layer except the lobby is a `System`.**
    `resolveMetaServices` therefore falls back to `SessionSystem.subsystems`,
    the record `installSession` keeps of the raw handles it was given. The
    alternative — asking four other modules to grow a `name`/`order` and a
    frame they do not need — would have been a worse trade.

12. **`src/main.ts` still does not register the session.** It is not this
    agent's file. `armSessionLayer()` in `src/game/Services.ts` installs on
    `game:ready` instead (§7), which is why the session is live in the shipped
    bundle today. Whoever owns `main.ts` can make it explicit whenever they
    like; installation is idempotent, so both paths can coexist.

---

## 9. Verification

```bash
node tools/session-flow.mjs          # 82 checks: journey, failures, bridges, registry, tsc negative test
node tools/session-flow.mjs --quick  # skip the tsc negative test
node tools/session-live.mjs --dist dist-s8 --port 4608   # 8 checks in the real browser build
```

What `session-flow` covers:

- the flow table is structurally sound; every state reachable from `boot`, every
  non-terminal state able to reach `lobby` again
- illegal transitions rejected at runtime **and** rejected by `tsc` (TS2345)
- stale authority updates ignored; non-adjacent authority snaps accepted
- the full happy path, twice, asserting the party survives the round trip
- adoption of an already-running match with `starts === 0`
- capture/passive mode starting nothing
- eleven injected failures: unfillable, search timeout, load error, load timeout,
  a throwing director, host loss + successful migration, host loss + failed
  migration, local disconnect, fatal fault + recovery, client authority, and a
  malformed launch order
- every bridge in §6.1, against fixtures shaped exactly like the real modules:
  the lobby view flattening, intents leaving as lobby commands, the fallback
  view, humans-only queueing on the right playlist, roster → launch order,
  team-index mapping, the matchmaker clocked off the session tick, cancel
- `installSession`: registration, idempotence, subsystems not degraded, and a
  full menu → matchmaking → loading → pre-match → live → post-match →
  after-action → lobby journey driven through those bridges with `starts === 1`
  on the seed the matchmaker chose
- `src/game/Services.ts`: `resolveMetaServices` finding the session, the lobby
  and the non-`System` subsystems, reading live state, forwarding intent, and
  resolving to all-null on a build with no meta layer
- the game layer's own `runSelfTest()` as an upstream probe
- the *real* `LobbySystem`, `MatchmakingService` and `LoadoutBook` binding to
  their ports, as upstream probes

Upstream probes are reported separately and do not gate the exit code —
otherwise another agent's mid-edit tree would mask every session result. That is
not hypothetical: `src/session/matchmaking` was mid-refactor during this pass
and threw from `Queue.tryForm` for several minutes.

What `session-live` covers, in headless Chrome against `npx vite build`:

- the shipped bundle installs the session and registers it with the engine
  (`physics, player, weapons, ai, session, director, materials, world, fx,
  audio, hud, render`)
- a capture run installs it `passive` and starts nothing — `match=idle`,
  `screen=main` — so it cannot pollute another module's shots
- an offline session is the host, and its fallbacks are reported in `degraded`
  rather than hidden (`net, loadout, lobby, matchmaking, mapLoad`)
- the engine still steps, and no new console errors appear

Single-player non-regression is also checked visually: `node tools/capture.mjs
--label s-int --no-build --port 4608 --dist dist-s8 --hud` writes the same 77
shots, with the same draw-call and triangle counts, before and after the session
layer was installed.
