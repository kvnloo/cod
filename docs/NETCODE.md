# Operation Blackout — Netcode Architecture

> **This document is the contract.** Every module under `src/net/` is written
> against it. If your design contradicts something here, change this document
> first (and tell the other net agents), then write the code.
>
> Code contracts: `src/net/types.ts` (vocabulary) and `src/net/Protocol.ts`
> (wire format + pure helpers). Both import **nothing** — not `three`, not the
> DOM, not the engine — so they run unchanged in a browser, in a headless Node
> authority, and in `tools/net-protocol.mjs`.
>
> Verify with `node tools/net-protocol.mjs` (100 assertions, prints the
> bandwidth numbers quoted below and the cross-module drift alarms in §0.1).

---

## 0. As-built map, and where this spec and the code disagree

**Read this section first.** This wave was built concurrently, not serially, so
the net stack already exists in `src/net/` and did **not** all come from these
contracts. This document is the architecture spec; the table below is the
ground truth of what is on disk. Where they differ, the divergence is called
out rather than hidden — closing these is the integration work.

### What exists

| Directory | What it is | Its own vocabulary |
|---|---|---|
| `src/net/types.ts`, `Protocol.ts`, `index.ts` | **contracts** — wire envelope, message kinds, versioning, ack window, sanitation, size model | `NetTick`, `ClientId`, `InputCommand`, `WorldSnapshot`, `NetMessage`, `AuthoritativeSim` |
| `src/net/NetSystem.ts` | engine-facing `System`, orders receive → reconcile → sample → predict → step → send | — |
| `src/net/host/` | `AuthorityCore`, `PeerHost`, snapshot writer, checkpoints, migration, `DefaultSim` | `PeerId`, `StableId`, `Tick`, `InputCommand`, `EntityState`, `Snapshot`, `NetEvent` |
| `src/net/transport/` | WebRTC / WebSocket / loopback transports, signalling, stats | `Transport`, `ChannelConfig`, `Reliability`, `TransportStats` |
| `src/net/wire/` | bit-level `BitWriter`/`BitReader`, range quantizers, `DeltaEncoder`/`DeltaDecoder`, bandwidth meter | `Range`, `WorldBounds`, `NetVec3`, `PackedQuat` |
| `src/net/prediction/` | input buffer, predictor, reconciler, metrics | `MovementSim`, `MoveCommand`, `ReconcileResult` |
| `src/net/interp/` | snapshot buffer, interpolator, extrapolation, clock | `Vec3`, `Quat`, `EntityState`, `Snapshot`, `TimeSource` |
| `src/net/lagcomp/` | hitbox history, rewind, hit validation | `HitPart`, `LagCompConfig`, `RejectReason` |

### Known divergences — decide these, do not let them drift

| Topic | This spec | As built | Recommendation |
|---|---|---|---|
| **Tick rate** | 60 Hz sim, 20 Hz snapshots (separate rates) | `DEFAULT_AUTHORITY_CONFIG.tickRate = 30`, sim **and** snapshots both 30 Hz | Split the two. 30 Hz sim means 33 ms of input granularity, which is felt in an FPS; 30 Hz snapshots for 16 players costs ~1.5 Mbps of peer uplink (§4). 60/20 costs 1.02 Mbps *and* halves input latency. |
| **Protocol versioning** | `[MAGIC][VERSION]` on every datagram, `contentHash` in the handshake, clean reject | **partly closed.** `PeerHost` now gates the join on `msg.v !== PROTOCOL_VERSION` and replies `reject`. But it reads a *second*, independently declared `PROTOCOL_VERSION` in `src/net/host/types.ts`, and there is still no `contentHash` gate and no magic byte on the datagram. | Two version constants is the drift trap itself. `src/net/host/types.ts` should become `export { PROTOCOL_VERSION } from '../Protocol';` — one line, additive. Until then §12 of `tools/net-protocol.mjs` fails the build if they ever disagree. `contentHash` still buys the case that matters more: same protocol version, different tuning constants, silent divergence. |
| **`InputCommand`** | `{seq, clientTick, dtMs, moveX, moveZ, yaw, pitch, buttons, weaponSlot, fireCount}` | `host/types.ts`: `{tick, seq, moveX, moveZ, yaw, pitch, buttons}` | Converge on the as-built shape **plus** `fireCount` and `weaponSlot`. Without `fireCount` firing is level-triggered on a button bit, so a duplicated or reordered input packet can produce an extra bullet (§6 step 7). |
| **Quantization** | `quantize*()` in `Protocol.ts`, fixed 16-bit ranges | `wire/Quantize.ts`, configurable bit ranges, smallest-three quats | **`wire/Quantize.ts` wins** — it is strictly more capable. Treat the `Protocol.ts` helpers as the reference/spec and the error bounds in `tools/net-protocol.mjs` §6 as the acceptance test. |
| **Channels** | 5 logical (`control`/`input`/`state`/`event`/`bulk`) | 3 transport channels (`control`, `state`, `sys`) | Keep 3 DataChannels; treat the 5 as message *routing classes* that map onto them (§5). |
| **Identity** | `ClientId` (number) everywhere | `PeerId` (string, transport) + `StableId` (string, identity) + `ClientId` (number, match slot) | The as-built three-way split is better and should win: transport address, persistent identity and compact slot really are different things. |
| **Input sanitation** | `sanitizeInput()`, clamps every field, **rejects NaN outright** | **partly closed.** `host/Authority.ts` clamps `moveX`, `moveZ` and `pitch` inline, and `DefaultSim` clamps again. Neither rejects NaN, and `clamp(NaN, -1, 1)` is `NaN` in every implementation in this tree. | Adopt `sanitizeInput()` at the single point where a command enters the authority. A `NaN` that reaches the integrator poisons a position permanently and replicates to every client. It is a security boundary (§11), it is one call, and it is tested. |

Nothing in `src/net/types.ts` or `src/net/Protocol.ts` imports anything, so
adopting a piece of it is always additive and can never break what already
runs. `npx tsc --noEmit` is clean across all of `src/net/`.

### 0.1 The button mask — four definitions, three incompatible

This is the sharpest divergence in the tree and the compiler cannot see it,
because every button mask in this repo is a bare `number`.

| Bit | `src/net/types.ts` `BUTTON` (**normative**) | `src/session/replay` `BTN` | `src/net/host/types.ts` `BTN` | `src/player/MoveCommand.ts` `BTN` |
|---|---|---|---|---|
| 0 | FIRE | fire | FIRE | JUMP |
| 1 | ADS | ads | ADS | CROUCH |
| 2 | JUMP | jump | JUMP | PRONE |
| 3 | CROUCH | crouch | CROUCH | SPRINT |
| 4 | PRONE | prone | **SPRINT** | ADS |
| 5 | SPRINT | sprint | **RELOAD** | LEAN_L |
| 6 | RELOAD | reload | **USE** | LEAN_R |
| 7 | MELEE | melee | MELEE | **FIRE** |
| 8 | USE | use | — | RELOAD |
| 9–13 | GRENADE, TACTICAL, LEAN_LEFT, LEAN_RIGHT, SWITCH | same | — | MELEE, USE, GRENADE, TACTICAL, SWITCH |

`session/replay` is bit-identical to the normative layout and says so in its own
comment; it is fine. The other two are not, and they sit on either side of the
prediction seam:

- **`src/net/host/`** simulates with the HOST layout. `NetSystem.ts` builds its
  command in that same layout, so today the host path is self-consistent.
- **`src/net/prediction/AuthoritativeMovement.ts`** predicts with the PLAYER
  layout, because it shares `src/player/Movement.ts`.

Prediction's entire purpose is to run the same movement the host runs. The
moment anyone wires `NetSystem`'s command into the shared movement sim — which
is the obvious next integration step, and `NetSystem.predictor` is already the
hole for it — bit 0 flips meaning: **firing predicts a jump, and jumping
predicts a shot.** It will look like a physics bug, not a netcode bug.

Because the contracts layer owns none of those three files, the resolution is
declared here as data and enforced by test:

```ts
import { BUTTON_LAYOUT_NET, BUTTON_LAYOUT_HOST, BUTTON_LAYOUT_PLAYER,
         remapButtons } from './net';

// At any seam between two layouts. Never pass a raw mask across.
cmd.buttons = remapButtons(netMask, BUTTON_LAYOUT_NET, BUTTON_LAYOUT_PLAYER);
```

`remapButtons` is allocation-free (14 iterations) and **drops** actions the
target layout cannot express rather than inventing a bit — the host layout has
no PRONE, and silently granting one would be acting on intent the player never
sent. `buttonActions(mask, layout)` is the debug counterpart.

`tools/net-protocol.mjs` §12 parses the three foreign `BTN` declarations out of
their source text on every run and fails if any of them moves a bit away from
the mirrors in `types.ts`. **If §12 fails, do not "fix" the test** — either
update the mirror and this table deliberately, or revert the bit that moved.

The long-term fix is one layout. Whoever owns `src/player/MoveCommand.ts` and
`src/net/host/types.ts` should re-order both onto `BUTTON` and delete the
bridge; it is a mechanical change, but it is not the contracts layer's to make.

---

## 1. The rule

**The server owns truth. Clients send intent, never state.**

A client is allowed to send exactly one thing that affects the simulation: an
`InputCommand` — movement axes, view angles, a button mask, a weapon slot and a
monotonic fire counter. Thirteen bytes of intent.

A client never sends a position, a velocity, a health value, a hit, a kill, or
a damage number. If a client could send it, a cheater could forge it.

Everything a client renders that has not yet been confirmed by the authority is
**prediction** — a plausible guess that will be corrected. Muzzle flash, recoil,
footsteps, view-model animation and your own movement are predicted. Damage,
kills, ammo counts after the fact, pickups, objective state and every other
player's position are **authoritative** and arrive from the host.

---

## 2. Topology: peer-host now, dedicated later, same simulation

Today the "server" is one of the players, hosting over WebRTC DataChannels, so
a group of friends can play with zero infrastructure. That is a *deployment*
choice, not an *architecture* choice.

The seam is `AuthoritativeSim` in `src/net/types.ts`:

```ts
interface AuthoritativeSim {
  readonly tick: NetTick;
  readonly matchSeed: number;
  addClient(id, info): EntityId;
  removeClient(id, reason): void;
  queueInput(id, cmd): void;
  step(dt): void;                       // exactly one net tick
  viewOf(id): InterestView | null;
  snapshotFor(id, baselineTick, budget): WorldSnapshot;
  drainEvents(): NetEvent[];
  handleRpc(id, req): RpcResponse;
  serialize(): Uint8Array;
  restore(data): void;
}
```

Whatever implements that interface is the server. The network layer above it
never learns whether it is talking to a browser tab or a Linux box.

| Concern | Peer-host (today) | Dedicated (later) | What actually changes |
|---|---|---|---|
| Simulation | `AuthoritativeSim` in a browser tab | *the same class* in Node | **nothing** |
| Transport | `WebRtcTransport` | `WebSocketTransport` / WebTransport | a new `NetTransport` impl |
| Tick source | `requestAnimationFrame` + accumulator | `setInterval` + `hrtime` | a new host clock driver |
| Rendering | host also renders its own view | none | host runs headless |
| Identity | host assigns `ClientId` | server assigns `ClientId` | **nothing** |
| Host migration | required | disabled | one config flag |
| Trust | host is a player (see §11) | operator-owned | threat model shrinks |

**Rules that keep this true — reviewers must enforce them:**

1. `AuthoritativeSim` and everything it calls must not import `three`, touch the
   DOM, read `window`, load textures, or emit audio. If the simulation needs
   geometry (raycasts against level collision), it goes through
   `src/physics/types.ts` `PhysicsAPI`, which Rapier implements in both
   environments.
2. `step()` advances exactly one net tick and is a pure function of
   *(previous state, queued inputs, tick)*. That single property is what makes
   client prediction, server rewind and replay all agree.
3. All randomness comes from a `Rand` (`src/core/Rand.ts`) seeded from
   `matchSeed`. One `Math.random()` in the simulation path breaks prediction,
   lag compensation and replay simultaneously.

**Rejected:** deterministic lockstep peer-to-peer (RTS style). Input delay
becomes worst-case RTT for everybody, one desync kills the match, and there is
no authority to port to a dedicated server later. **Rejected:**
client-authoritative movement with server validation — it is simpler, it is
what lets teleport hacks through, and the validation logic is throwaway work
the moment you move the host off a peer.

---

## 3. Determinism, and how prediction stays in sync

The client predicts its own player by running *the same movement/weapon code*
the host runs. For the two to agree:

- **Predict with quantized input, not raw input.** `quantizeCommand()` rounds a
  command through the wire quantizers. The client must feed the *rounded* values
  into its local prediction, or it diverges by the rounding error every tick.
  (`tools/net-protocol.mjs` §6 asserts `quantizeCommand` is idempotent.)
- **Seed RNG from replicated facts.** Any draw that affects the simulation —
  bullet spread, recoil pattern index — must be seeded from
  `(matchSeed, clientId, monotonic counter)`, e.g. a `Rand` constructed from
  `matchSeed + ":shot:" + clientId + ":" + fireCount`. Then the client and the
  host draw the *identical* spread without exchanging a byte. Cosmetic-only
  randomness (debris direction, shell tumble) may use any local stream.
- **Fixed step only.** The engine's fixed step is 1/120 s; a net tick is 1/60 s
  = exactly `ENGINE_STEPS_PER_NET_TICK` (2) engine steps. Keep that an integer.

---

## 4. Rates and bandwidth — the numbers

### The choice

| Rate | Value | Why |
|---|---|---|
| Engine fixed step | **120 Hz** | pre-existing (`Time.fixedDelta`), physics quality |
| **Simulation / net tick** | **60 Hz** (16.67 ms) | 2 engine steps exactly |
| **Snapshot rate** | **20 Hz** (50 ms) default | bandwidth, see below |
| Input send rate | **60 Hz**, 3× redundancy | one command per tick, survives 2 consecutive losses |
| Interpolation delay | **100 ms** | 2 snapshot intervals + jitter headroom |
| Max lag-comp rewind | **250 ms** | covers 200 ms RTT players; beyond that they get "shot behind cover" |
| Snapshot history | **64** (3.2 s) | > rewind + interp, and covers delta baselines through a loss burst |

Snapshot rate scales with lobby size (`SNAPSHOT_HZ_BY_PLAYER_COUNT`):
**≤8 players → 30 Hz**, **≤16 → 20 Hz**, **≤32 → 15 Hz**.

> **As built:** `DEFAULT_AUTHORITY_CONFIG.tickRate = 30` drives simulation *and*
> snapshots from one number (§0). Splitting them is the recommendation below —
> the tick rate is a latency decision and the snapshot rate is a bandwidth
> decision, and tying them together forces you to pay for both.

### The arithmetic

All figures below are produced by `node tools/net-protocol.mjs` §10 from
`estimatePackedBytes()`, which models the **binary** layout. JSON is the
reference codec for debuggability only — it is 17.4× larger and nobody should
size a budget from it.

Per-datagram overhead below our payload is **69 bytes** (IPv4 20 + UDP 8 +
DTLS ~13 + SCTP common 12 + DATA chunk 16). At 60 Hz that is 4.1 KB/s of pure
overhead per stream, which is why **every message for a peer is coalesced into
one datagram per send opportunity**. Batching is a protocol feature
(`NetCodec.encode(messages[])`), not an optimisation.

**Entity records** — 18 B for a typical moving-player delta
(`POS|ROT|FLAGS|ANIM`), 31 B for a full keyframe record.

**Downstream, 16 players at 20 Hz:**

| Case | Snapshot payload | On the wire | Per client | Host uplink (15 clients) |
|---|---|---|---|---|
| Worst case, all 15 others relevant + 4 projectiles | 356 B | 427 B | 8.3 KB/s (68 kbps) | **1.02 Mbps** |
| Typical, interest-managed to 10 entities | 204 B | 273 B | 5.3 KB/s | **0.66 Mbps** |
| 8 players at 30 Hz (7 others + 4 projectiles) | 212 B | 283 B | 8.3 KB/s | **0.48 Mbps** |

**Upstream, per client:** an input packet carrying 3 redundant commands is 52 B
of payload, 123 B on the wire; at 60 Hz that is **7.2 KB/s (59 kbps)** up per
client, and **0.89 Mbps** down at the host for 15 clients.

**Why not snapshots at the full 60 Hz tick rate?** Measured: **3.07 Mbps** of
host uplink for 16 players. A peer host on a typical residential connection
(5–20 Mbps up, and we design against a 2 Mbps floor) would bufferbloat its own
game. 20 Hz costs 1.02 Mbps worst case and the visual difference is absorbed by
interpolation. **Rejected.**

**Why not a 128 Hz tick?** It doubles simulation CPU on a machine that is also
rendering the host's own view at 60+ fps, doubles input packet rate, and the
win is sub-frame. **Why not 30 Hz?** 33 ms of input granularity is felt in an
FPS. 60 Hz is the floor for the feel we want and the ceiling for what a peer
host can carry.

### Scaling past one lobby

Interest management is what makes larger counts possible — with a naive
"replicate everyone" snapshot the host uplink grows as O(N²):

| Players | Snapshot Hz | Naive host uplink | Interest-managed (≤12 relevant) |
|---|---|---|---|
| 8 | 30 | 0.37 Mbps | 0.37 Mbps |
| 16 | 20 | 0.87 Mbps | 0.74 Mbps |
| 32 | 15 | 2.42 Mbps | **1.15 Mbps** |
| 64 | 15 | 9.28 Mbps | **2.34 Mbps** |

(players only, no projectiles; the 16-player row in the table above adds those.)

---

## 5. Channels

Five **logical** routing classes (`CHANNELS` / `MSG_CHANNEL` in `types.ts`)
riding **three** physical DataChannels (`DEFAULT_CHANNELS` in
`transport/Transport.ts`). `MSG_CHANNEL` fixes which class each message kind
belongs to — the sender does not get to choose.

| Logical class | Reliability | Carries | Physical channel |
|---|---|---|---|
| `control` | reliable, ordered | hello/welcome, join, rpc, migration, disconnect | `control` (`reliable-ordered`) |
| `input` | unreliable, app-sequenced | client → host `InputCommand` windows | `state` (`unreliable-sequenced`) |
| `state` | unreliable, app-sequenced | host → client snapshots, ack | `state` (`unreliable-sequenced`) |
| `event` | reliable, unordered | gameplay facts (kills, hits, explosions) | `control` |
| `bulk` | reliable, ordered, low priority | loadouts, map params, large payloads | `control` |

Ping/pong rides the tiny `sys` channel (`unreliable`, 64 B cap) so liveness
probes never queue behind a snapshot.

Three physical channels is the right count: each one costs an SCTP stream and a
separate congestion story, and the only *hard* requirement is separating "must
arrive" from "must arrive now".

**On "unreliable-sequenced":** SCTP has no such mode. `ordered:true` with
`maxRetransmits:0` reintroduces head-of-line delay while the stack waits to see
whether a gap gets filled — exactly the latency we are avoiding. So the
transport uses `ordered:false, maxRetransmits:0` and we sequence in the
application: every datagram carries a 16-bit `seq`, and the receiver drops
anything older than the newest it has applied. True unreliable-sequenced, no
HOL stall. Sequence comparison is wrap-safe (`seqNewer`, `seqDiff`).

Loss is acknowledged with a rolling 33-packet window (`AckState`: `latest` +
a 32-bit field). It doubles as the loss estimator — measured within 0.2 % of
injected loss over 20 000 packets in the test harness.

---

## 6. Message flow: one shot fired

Client at 100 ms RTT, host tick 1000, snapshot every 3rd tick.

**t = 0 ms — client, tick 1005** (`predictedServerTick` puts the client
5 ticks ≈ 83 ms ahead so its input lands just before the host needs it):

1. Input sampler builds `InputCommand{ seq: 812, clientTick: 1005,
   buttons: FIRE|ADS, fireCount: 41 → 42 }` and runs it through
   `quantizeCommand()`.
2. The client **predicts immediately**: recoil kick, muzzle flash, tracer,
   view-model animation, local ammo decrement, and a spread vector drawn from
   `Rand(matchSeed:shot:clientId:42)` — the same seed the host will use.
   It does **not** predict damage, hitmarkers or kills.
3. It stores the command in its pending buffer (for replay) and sends
   `INPUT{ commands: [810, 811, 812], ackSnapshotTick: 997, ackEventId: 41 }`
   on the `input` channel. Commands 810 and 811 are redundant copies — two
   consecutive packet losses cost nothing.

**t ≈ 50 ms — host, tick ~1003:**

4. Decode. Wrong magic or wrong `PROTOCOL_VERSION` → drop and disconnect.
   `isClientOriginated(k)` rejects anything a client must not send (a client
   sending `SNAPSHOT` or `JOIN_ACCEPT` is `bad-message`, disconnect).
5. `sanitizeInput()` clamps every field and rejects NaN/Infinity. Commands with
   `seq` not newer than the last applied are dropped as duplicates.
6. The command is queued against `clientTick: 1005`. The host runs it when it
   reaches tick 1005. If it arrives late (host already at 1006) the host runs it
   at 1006 and reports the client's lead in `SnapshotMessage.ackClientTick` so
   the client can increase its lead.

**Host, tick 1005 — the shot is resolved:**

7. Fire is **edge-triggered on `fireCount`**, not on the FIRE bit: the host
   fires `min(fireCount − lastFireCount, rateLimit)` shots. Duplicated or
   reordered packets cannot produce extra bullets.
8. Validation: fire-rate interval, ammo, reload state, alive, weapon actually
   owned in that slot. Any failure = no shot, and no event is emitted. The
   client's predicted muzzle flash was cosmetic and simply is not confirmed.
9. **Lag compensation:** rewind every other player's hitboxes to the world this
   client actually saw —
   `rewindTo = serverTime − (rtt/2 + interpDelayMs)`, clamped to
   `maxLagCompMs` (250 ms), reconstructed from the 64-snapshot history. RTT is
   the host's own measurement, never a number the client claims.
10. Raycast through `PhysicsAPI` with the deterministically-seeded spread,
    resolve penetration/damage, apply to authoritative state.
11. Emit `NetEvent`s: `weapon:fire` (broadcast), `bullet:impact` (broadcast),
    `damage:dealt` (**target = the shooter only** — that is the hitmarker),
    `entity:death` (broadcast) if it killed.

**Host, next snapshot boundary (tick 1005):**

12. Per client, `snapshotFor(id, baselineTick, budget)` produces a delta against
    the newest tick that client acked. The victim's record carries
    `SNAP_FIELD.HEALTH`; the shooter's carries `WEAPON|ANIM|FLAGS`. Entities
    outside the viewer's interest set are simply absent — a client is never
    sent data it should not be able to see.
13. `SNAPSHOT` goes on `state` (unreliable — a lost one is covered by the next
    delta against an older baseline). `EVENT` goes on `event` (reliable — a lost
    kill would never be re-derived).

**t ≈ 100 ms — client:**

14. `SnapshotMessage.ackInputSeq = 812` → drop commands ≤ 812 from the pending
    buffer.
15. Compare the locally predicted state at tick 1005 against the authoritative
    one. Under threshold (≈2 cm), keep predicting. Over it, snap to the
    authoritative state and **replay** commands 813… through the same movement
    code, then smooth the visual residual over ~100 ms.
16. Remote entities are rendered at `serverTime − 100 ms`, interpolating between
    the two bracketing snapshots. Never extrapolate more than one interval;
    beyond that, freeze.
17. The event router re-emits each `NetEvent` onto the local `bus` using its
    `GameEvents` key. **FX, audio and the HUD do not know the network exists** —
    `bullet:impact` looks identical whether it came from the local simulation or
    the wire. That is why `NetEvent.kind` should be a `GameEvents` key.

**Net result:** the shooter sees his own flash at 0 ms and his hitmarker at
~100 ms; the victim sees the tracer ~100 ms after the trigger pull; nobody's
client ever decided anything.

---

## 7. Handshake, versioning and rejection

```
client                                  host
  |-- HELLO {protocol, build, hash} ------>|   control
  |<------------ WELCOME {id, clock, cfg} -|   (or JOIN_REJECT)
  |-- JOIN_REQUEST {name, team, loadout} ->|
  |<-- JOIN_ACCEPT {id, entity, seed, ...} |
  |<-- SNAPSHOT (keyframe, baseline = -1) -|   state
  |-- INPUT ------------------------------>|   ...live
```

Every datagram starts with `[MAGIC 0xB1][PROTOCOL_VERSION]`. A mismatch is
rejected at `decode()` with `error: 'version'` — **a mismatched build
disconnects on its first packet instead of desyncing mysteriously twenty
seconds later.**

> **Not yet wired in.** The as-built codec in `host/` and `transport/` has no
> version byte and no compatibility gate (§0). Until `checkCompatibility()` is
> called on join, two different builds will connect and diverge silently. This
> is the single highest-value item in the divergence table.

Beyond the protocol version, `HELLO` carries a `contentHash`.
`PROTOCOL_CONTENT_HASH` already folds in the protocol version, the default
config (tick rates!), the channel table and the quantization constants. Gameplay
modules that own simulation-affecting tables (weapon damage, movement constants)
**should fold their own canonical string in** with `foldHash()` and pass the
result. Two builds with the same protocol but different weapon damage would
diverge silently; with the hash they get a clean `content-mismatch`.

**Versioning policy:**

- Adding an optional field, or a new `MSG` kind, does **not** need a bump — old
  receivers ignore what they do not know.
- Changing the type/meaning of an existing field, or removing one, **requires**
  bumping `PROTOCOL_VERSION`.
- `types.ts` and `Protocol.ts` are **additive-only** once other modules depend
  on them. Renaming a field breaks seven agents at once. Add and deprecate.

---

## 8. Interest management and the bandwidth budget

Two independent mechanisms, both mandatory:

**Interest (relevance)** — `InterestPolicy.relevance(view, entity)` returns
0…1. Zero means the entity is *not transmitted at all*. Baseline policy:

- `RELEVANCE.CRITICAL` — the viewer's own entity, objectives, match state.
- `RELEVANCE.HIGH` — inside the view cone and within ~60 m.
- `RELEVANCE.MEDIUM` — within audible range (~40 m) but not visible. Needed for
  footsteps, radar and the sound of someone flanking you.
- `RELEVANCE.LOW` — far away; send at a reduced cadence (every 2nd or 4th
  snapshot).
- `RELEVANCE.NONE` — culled. Emit an entry in `WorldSnapshot.removed` once so
  the client can retire its interpolation buffer.

Culling is also the strongest anti-wallhack measure available: an entity that
was never transmitted cannot be drawn by a modified client.

**Budget** — `BandwidthBudget.bytesPerSnapshot` (`budgetFor()` derives it:
12 000 B/s ÷ 20 Hz = 600 B). The snapshot writer sorts candidate entities by
relevance × staleness and fills up to the budget; whatever does not fit waits
for the next snapshot. A snapshot must never exceed the MTU (1200 B) without
being explicitly split. **A snapshot is never allowed to grow unbounded** — the
correct failure mode is a slightly staler distant enemy, not a 3 KB datagram
that fragments and gets dropped whole.

Delta compression is against **per-client acked baselines**, not a global
"previous snapshot": clients ack different ticks, so the host keeps
`snapshotHistory` (64) ticks of state and deltas each client against the
newest tick *that client* confirmed. If a client has not acked within the
history window, send a keyframe (`baselineTick = NO_BASELINE`).

---

## 9. Client-side model, in order

Per frame, using `NET_ORDER` slots (which sit between the `ORDER` constants in
`src/core/Engine.ts`):

1. `RECEIVE` (10) — drain transports, decode, apply acks, ingest snapshots.
2. `SAMPLE` (20) — build this tick's `InputCommand`, quantize it, buffer it.
3. `RECONCILE` (190) — if the newest snapshot disagrees with prediction, snap +
   replay unacked commands. Runs just before `PLAYER` (200).
4. `INTERPOLATE` (650) — place remote entities at `serverTime − interpDelayMs`.
   Runs after `WORLD` (600) so `FX` (700) and `AUDIO` (800) see final positions.
5. `SEND` (990) — coalesce and flush, once, just before `RENDER` (1000).

The host runs the same receive/send slots plus `HOST_APPLY` (90), which feeds
queued inputs into the simulation immediately before `PHYSICS` (100).

---

## 10. Host migration

Peer hosting means the host can quit or crash. `MigrationPlan` carries an
ordered succession list and an `epoch` nonce.

- Succession is ranked at join time (`PeerInfo.migrationRank`) by measured
  uplink and RTT-to-everyone. Lowest rank wins.
- Clean handoff: the outgoing host sends `HOST_MIGRATE` with `stateB64` =
  `serialize()`. The successor `restore()`s it, resumes at `plan.resumeTick`
  and every peer redials.
- Hard loss (host disappeared): after `timeoutMs`, the successor promotes its
  own most recent authoritative snapshot. Some prediction is lost; the match
  continues.
- `epoch` monotonically increases and every peer echoes it in
  `HOST_MIGRATE_ACK`. A stale host that comes back cannot re-assert authority
  because its epoch is old.
- `serialize()`/`restore()` must round-trip bit-for-bit, or migration desyncs.
  That is also exactly what a dedicated server needs for save/restore and what
  a replay system needs, so it is not migration-specific work.

---

## 11. Threat model

### A malicious **client** can

- Send garbage, huge or malformed packets → `sanitizeInput()` clamps every
  field and rejects non-finite values; `decode()` caps packet size
  (`MAX_PACKET_BYTES`) and batch length (`MAX_MESSAGES_PER_PACKET`); unknown
  kinds are rejected. Every one of these is asserted in the test harness.
- Replay or duplicate input packets → 16-bit sequence dedupe; firing is
  edge-triggered on `fireCount` and rate-limited, so duplicates cannot produce
  extra bullets.
- Claim an absurd `dtMs` to move further per tick → clamped to 2 ticks.
- Claim an old `clientTick` to get a bigger lag-comp rewind → rewind is computed
  from the **host's own RTT measurement**, clamped to `maxLagCompMs`.
- Flood a channel → per-channel rate limits and `bufferedBytes` back-pressure;
  repeated violation is `rate-limit` disconnect.
- Aim perfectly (aimbot). This is **indistinguishable from skill at the protocol
  level** — view angles are legitimate client data. It needs statistical
  detection, which is out of scope for the transport layer. Interest culling at
  least denies the information a wallhack needs.

### A malicious client **cannot**

- Set its own position, velocity or health. It has no message that carries them.
- Deal damage, register a hit, or declare a kill. Only the host emits
  `damage:dealt` / `entity:death`.
- Modify another player's state, spawn entities, or change match/score state
  except through validated `RPC`.
- See entities that interest management culled — they are not on the wire.
- Impersonate the host: `isClientOriginated()` rejects host-only kinds, and the
  transport knows which link a packet arrived on.

### A malicious **host** can do anything

This is the honest cost of peer hosting. The host owns truth: it can see every
player, teleport, decide every hit, and there is no cryptographic fix within a
peer topology. Mitigations are social and structural, not technical:

1. Peer hosting is for **private lobbies with people you chose to play with**.
2. Ranked/public play runs on a dedicated authority — which is why §2 exists and
   why the seam is `AuthoritativeSim` rather than "the host is special".
3. Migration succession is data (`migrationRank`), so a client that has been
   reported can be moved to the back of the list.

### Transport-level

- DTLS gives encryption and integrity on every DataChannel; nobody on the path
  can read or forge packets.
- **WebRTC exposes peers' IP addresses to each other**, which enables targeted
  DDoS. Route through a TURN relay when one is configured; document the
  trade-off to the player rather than hiding it.
- Signalling is out of band (a link/room code). Treat any signalling payload as
  hostile input.

---

## 12. File layout and ownership

`src/net/index.ts` re-exports **only** `types.ts` and `Protocol.ts`.
Implementation modules are imported by path:

```ts
import { PROTOCOL_VERSION, JsonCodec, MSG } from './net';       // contracts
import { WebRtcTransport } from './net/WebRtcTransport';        // impl
```

That way adding a module can never break the barrel, and the contract layer
stays free of heavy dependencies.

See the as-built table in §0 for what each directory currently contains.
Ownership:

| Area | Path | Owns |
|---|---|---|
| **Contracts** | `types.ts`, `Protocol.ts`, `index.ts`, this doc | vocabulary, wire envelope, versioning, sanitation, size model |
| Engine glue | `NetSystem.ts` | the only file in `src/net/` allowed to touch `three` / DOM |
| Authority | `host/` | `AuthorityCore`, input queues, tick loop, validation, checkpoints, migration |
| Transport | `transport/` | WebRTC + WebSocket + loopback, signalling, link stats |
| Replication | `wire/` | bit packing, quantization, delta encode/decode, bandwidth meter |
| Client | `prediction/`, `interp/` | prediction + reconciliation; snapshot buffer + interpolation |
| Lag comp | `lagcomp/` | hitbox history, rewind, hit validation |

**House rules for everyone working in `src/net/`:**

1. Do not edit `types.ts` or `Protocol.ts` without telling the contracts owner.
   Additive changes only; nothing gets renamed once it ships.
2. Everything on the wire goes through `NetCodec`. No ad-hoc `JSON.stringify`
   into a DataChannel — it bypasses versioning and the size model.
3. Budget bandwidth with `estimatePackedBytes()` / `entitySnapshotBytes()`,
   never with the JSON codec's length (17× off).
4. Every net module ships a runnable `tools/net-*.mjs` that prints PASS/FAIL
   with numbers. "It compiles" is not evidence for netcode.

---

## 13. Verification

```bash
npx tsc --noEmit             # strict types
node tools/net-protocol.mjs  # 100 assertions + the bandwidth table above
```

The harness compiles `src/net/{types,Protocol,index}.ts` and `src/core/Rand.ts`
standalone — proving the contracts really are dependency-free and really do run
outside a browser, which is the whole premise of §2. Sections in order:

| § | What it proves |
|---|---|
| 1–3 | codec round-trip for every message kind; datagram batching; version + malformed rejection |
| 4–5 | 16-bit sequence arithmetic across the wrap; the ack window under seeded loss and reordering |
| 6 | quantization error bounds (position, velocity, yaw, pitch) |
| 7 | hostile input sanitation — NaN, infinities, out-of-range, wrong types |
| 8–9 | message origin rules (client-originated vs host-originated); clock sync and prediction lead |
| 10–11 | the bandwidth model and interest-management scaling quoted in §4 and §8 |
| 12 | **cross-module drift alarms** — see §0.1 |

§12 is the one that will fail first, and deliberately so: it reads the button
masks, protocol version and channel names out of *other* agents' source files
and fails if they drift from what the contracts mirror. Everything else in this
harness tests code that cannot break, because nothing else imports it.

The seeded RNG comes from `src/core/Rand.ts`; there is no `Math.random()`
anywhere in the harness, so a failure reproduces exactly.
