# Playtest and performance gates

Eight iteration waves verified this game with **still screenshots**. The first
human to actually play the build found, in about thirty seconds, that:

> "when i was running around and inspecting gameplay it felt very unplayable and
> not smooth. fps was really bad (maybe it was an ultra mode test). after getting
> downed i would just get shot at for 60s without dying. it didn't really play
> like cod."

Not one of those is visible in a screenshot. These two tools exist so they can
never ship unnoticed again.

| Tool | Question it answers |
|---|---|
| `tools/playtest.mjs` | Does the game *play*? Movement, lethality, survivability, animation, and the frame time of real play. |
| `tools/perf-session.mjs` | How fast does it run, at every quality preset, during a firefight — and is the cost CPU or GPU? |

Both **exit non-zero when a gate is violated**, so they drop straight into CI.

---

## Quick start

```bash
node tools/playtest.mjs                     # build, play a session, print gates
node tools/playtest.mjs --no-build          # reuse the existing dist-gp-h
node tools/perf-session.mjs                 # all four presets
node tools/perf-session.mjs --no-build --presets high,ultra
```

Reports are written to `shots/playtest/report.json` and
`shots/perf-session/perf-session.json`. `perf-session` also writes
`shots/perf-session/worst-<preset>.png` — the view reconstructed from the camera
transform of that preset's single worst frame.

Both tools default to **port 9901** and **`dist-gp-h`**. They serve the
production build (`vite preview`), never the dev server: a dev-server profile
measures Vite, not the game.

---

## How the measurements are taken

Two clocks are used deliberately, and never mixed.

**SIM time** — `engine.stepFrame(1/120)` driven in a tight loop. Every *gameplay*
number (time-to-kill, time-to-die, damage cadence, movement continuity, recoil)
is measured here. It is exactly reproducible for a given seed and completely
independent of how fast the host machine is, so a slow CI box cannot turn a
gameplay regression into a flake or vice versa. During these phases the renderer
is disabled (`render.enabled = false`) — the fixed step does not depend on it,
and it makes a 60-second simulation take four seconds of wall clock.

**WALL time** — the real `requestAnimationFrame` loop, free-running with
`--disable-gpu-vsync --disable-frame-rate-limit`. Every *frame-time* number is
measured here, because that is the only clock a player feels. `Engine.frame` is
wrapped on the instance so each frame records both the interval since the last
frame started (what the player feels) and the time spent inside the frame body
(what separates a CPU-bound frame from a GPU-bound one).

### Driving the game

The tools drive the shipping bundle through three doors, all public:

* `window.engine` — the `Engine`, and through it every registered `System`.
* `window.__BLACKOUT__` — the capture API from `src/core/CaptureAPI.ts`.
* `window.__BLACKOUT_GAME__` — the `GameDirector`, and through it the match,
  the lifecycle and the actor backend.

Synthetic input is the one thing with no public door: `input` is a module
singleton. The probe recovers it by patching `Set.prototype.add` for the
duration of a single `__BLACKOUT__.act([{ press: [sentinel], frames: 0 }])`
call, which funnels the sentinel through `downEdges` and then `state.actions`
and hands both sets back. `frames: 0` steps no frames, so nothing about the game
is perturbed. After that, holding an action is a `Set.add` and releasing it is a
`Set.delete`.

Everything else the probe hooks is a public field or a prototype method
(`BotFallback.prototype.hurt`, `PlayerSystem.applyDamage`,
`PhysicsSystem.raycast`, …). The production build does **not** mangle property
names — verified against `dist/assets/index-*.js` — so the probe works against a
real `vite build`, which is the only build worth measuring.

### Chromium and disk space

Chromium writes its whole throwaway profile into `TMPDIR`, and on the shared
build box `/tmp` is a 7.8 GB tmpfs. When it fills, the browser dies with
`FATAL … No space left on device` *after* the game has already booted, which
looks exactly like a mysterious 180-second readiness timeout. Both tools call
`ensureScratchTmp()` at startup, which repoints `TMPDIR` at `/dev/shm` (or
`./.playtest-tmp`) whenever the current one has under 2 GB free.

---

## `tools/playtest.mjs`

Seven phases, in order. Phases 1-6 are sim-time; phase 7 is wall-time.

| # | Phase | What it produces |
|---|---|---|
| 1 | Warm-up | 7.5 s of simulation so the match is past `warmup` and the first wave is on the field. |
| 2 | Movement traversal | 12 scripted beats (idle, walk, sprint, slide, slide-jump, strafe, bunny-hop ×2, backpedal, crouch-walk, settle). Peak and mean horizontal speed, distance travelled, airborne steps and vertical rise per beat, plus continuity analysis of every one of the ~1500 fixed steps. |
| 3 | Time-to-kill sweep | Every weapon × every range against a frozen, non-shooting target, ADS, perfect tracking with recoil compensation. TTK in ms, shots, hits, damage per hit, and what `WeaponSystem.damageAtRange()` says the damage *should* be. |
| 4 | Execute a squad | Six staged kills. Grades whether each death played an animation, and scans a **living** enemy band by band for hit zones. |
| 5 | Recoil + sprint-to-fire | Empties a magazine, then measures residual camera recoil 2 s later. Then sprints and measures the delay to the first round. |
| 6 | Time-to-die | Stands perfectly still, facing N enemies, and does not fight back. Times first damage, health zero, last stand and real death — plus how many last-stand cycles it took. Run three times; the gate reads the **median**. |
| 7 | Live play | Free-running rAF with a scripted firefight timeline. Frame-time percentiles, threshold counts, draw calls, triangles, GPU time, bound classification, worst 1% with context. |

### Options

```
--port 9901          --dist dist-gp-h      --quality high
--w 1920 --h 1080    --seed 1337           --mode operation
--live-ms 14000      --warmup-ms 2000      --p99 16.7
--ttd-enemies 3      --ttd-range 12        --ttd-cap 60      --ttd-accuracy 0
--ttd-trials 3
--weapons ar_vkr7,smg_hornet,lmg_vulcan,pi_sidewinder
--ranges 10,25,50
--json shots/playtest/report.json
--no-build           --quiet
```

`--ttd-accuracy 0` means "leave the director's own difficulty scalar alone",
which is the point: the survivability number has to describe the game as
shipped, not a normalised lab version of it. Pass a number to force it.

Time-to-die is the noisiest gameplay measurement in the suite: the bots' fire
timers and burst cadence come off a shared RNG whose position depends on
everything that happened before, so a single trial can swing by several seconds.
It therefore runs `--ttd-trials` times from the same staging position and gates
on the median, with every trial reported in `toDeathMsAll`. A hard gate that
flaps is worse than no gate.

---

## The gates

A **hard** gate failing exits the process non-zero. An **advisory** gate is
printed as `WARN` and never fails CI — those are the numbers this wave is still
actively choosing, so failing on them would be noise instead of signal.

### Hard gates

| Gate | Target | What a failure means |
|---|---|---|
| `enemies-spawned` | `> 0` | No combatant reached the world. There is no game to test. |
| `time-to-die` | `<= 8000 ms` (median of 3) | Standing in the open in front of three rifles has to be lethal. This is the direct gate on the reported bug. |
| `down-loop` | `<= 1 cycle` | `Lifecycle.ts:201` self-revives after 7 s without damage while bleedout only counts down, so sparse incoming fire can loop down → revive → down forever. More than one cycle before death means the loop is live. |
| `frame-p99` | `<= 16.7 ms` | The 60 fps budget at 1080p/high. p99 rather than mean, because the framerate a player complains about is the bad frames. |
| `frame-spikes` | `0 frames > 50 ms` | A 50 ms frame is a visible hitch. After warm-up there is no excuse for one. |
| `ttk-lethal` | `0 failures` | A weapon that cannot kill a stationary target with perfect tracking in twelve seconds is broken. Pairs with no sightline are excluded and counted separately as `ttkSkippedNoSightline`, so a level without a 50 m lane cannot masquerade as a broken gun. |
| `damage-model` | `>= 3 distinct damage values` | The weapon damage model is not being applied. If every weapon at every range does exactly the same damage, the whole of `src/weapons/` damage falloff is dead code. |
| `hitbox-zones` | `>= 3 zones` | A bullet ray fired at the head, chest, stomach, arm and leg of a **living** enemy must not come back with the same zone every time. Deliberately a structural scan, not a histogram: a histogram counts corpse ragdolls and the player's own capsule and looks healthy while living enemies have no zones at all. |
| `death-anim` | `>= 0.90` | Fraction of deaths where the body's skeleton actually moved in the 0.5 s after death. A clip that compiled to a single key holds a pose that is bit-identical every frame; that is what this catches. |
| `motion-continuity` | `0 teleports` | A fixed step where the player moved further than `max(0.25 m, speed × dt × 3)`. Mostly-vertical hops within the controller's own 0.45 m step height are classified as `stepSnaps` and reported separately, because a stair climb is not a desync. |
| `no-free-launch` | `0 launches` | A grounded step that gained more than 0.5 m/s of upward speed with no jump input **on ground whose normal is within 8° of vertical**. Walking onto a ramp legitimately gains upward velocity, so slope cases are counted separately as `rampGainsIgnored` and never fail the gate. |
| `recoil-bounded` | `<= 0.50°` | Residual camera recoil two seconds after a full magazine. Anything above this means recoil is accumulating rather than recovering. |
| `no-console-errors` | `0` | An exception thrown mid-session invalidates every other number in the report. |

### Advisory gates

| Gate | Target | Source of the target |
|---|---|---|
| `ttk-band` | `400..900 ms` | CoD MW2019 AR core TTK is ~250-400 ms; Apex Legends' R-301 against a 200 HP target is ~750-1000 ms. The brief asks for CoD gunplay with a raised TTK because movement now carries the skill expression, so the band sits between the two. |
| `sprint-to-fire` | `80..200 ms` | CoD MW2019 sprint-to-fire runs 80-250 ms by weapon class and is the single biggest reason its gunfights feel committed. |
| `ai-agents` | `> 0` | Advisory until the `ActorAPI` package lands, because today the enemy the player fights is `BotFallback` and `src/ai/` builds its cover graph and nav grid for nobody. |

### What counts as a pass

`node tools/playtest.mjs` exiting `0`. That requires **every hard gate green**.
Advisory warnings are expected while a design number is in flight; they should
be read, not ignored, and promoted to hard once the wave settles them.

---

## `tools/perf-session.mjs`

Runs the *same* scripted firefight at every preset, so the numbers are
comparable — sprinting through the level while shooting, which is when
particles, tracers, decals, dynamic lights and character animation are all live
at once. `tools/perf.mjs` measures a parked camera on a fixed shot with no
enemies and no movement; that profile can be green while the game is unplayable,
which is exactly what happened.

```
--port 9901        --dist dist-gp-h    --presets low,medium,high,ultra
--w 1920 --h 1080  --ms 12000          --warmup-ms 2500
--seed 1337        --mode operation    --out shots/perf-session
--budgets low=8,high=20               --no-build   --no-shots
```

### Per-preset p99 budgets

The brief fixes one of these; the rest follow from what each preset is *for*,
measured on the reference machine (RTX 3080 Ti at 1080p).

| Preset | Budget | Why |
|---|---|---|
| `low` | 6.94 ms (144 fps) | `low` exists so a competitive player can run at a high refresh rate, and `ARCHITECTURE.md` additionally requires it to survive integrated graphics — which needs roughly 5× headroom on this GPU. |
| `medium` | 8.33 ms (120 fps) | The console-parity preset. CoD ships 120 Hz modes on Series X / PS5; a 3080 Ti has to clear that comfortably. |
| `high` | 16.70 ms (60 fps) | The brief's gate. |
| `ultra` | 16.70 ms (60 fps) | Ultra may cost more than high, but a preset that cannot hold 60 fps on a 3080 Ti at 1080p is not a preset, it is a screenshot mode. |

Override any of them with `--budgets`. A preset fails if `p99 > budget` **or**
any frame after warm-up exceeded 50 ms.

### CPU vs GPU bound

Each frame records the wall interval, the time inside the frame body, and the
`EXT_disjoint_timer_query_webgl2` GPU time from `RenderSystem.stats()`.

* frame body ≥ 85% of the wall interval → **cpu-bound**
* GPU timer ≥ 85% of the wall interval → **gpu-bound**
* otherwise → *leaning*, with both percentages printed

This is the difference between "turn down the shadows" and "the frame body is
too expensive", and it is the thing the tool exists to say out loud.

### The verdict line

When both `low` and `ultra` are profiled the tool prints a direct answer to
"was it an ultra mode test?" — the p50 ratio between them, which presets are
inside budget, and, if none are, that the framerate is a whole-build problem
rather than a quality-setting one.

---

## Reading a report

`shots/playtest/report.json` and `shots/perf-session/perf-session.json` carry
everything the console prints plus the raw supporting rows: per-beat movement
samples, every TTK row with its sightline flag, the health trace of the
time-to-die run, the per-death pose deltas, and the worst 1% of frames with the
position, camera angles, player state, enemy count, draw calls and triangle
count of each.

Notes on interpreting them:

* **Frame times move between runs on a shared box.** These tools take the real
  GPU, and other agents' capture runs contend for it. A single p99 that is 3×
  a previous run is contention, not a regression; re-run with a longer `--ms`
  (20 s or more) before believing a swing. Gameplay numbers do not have this
  problem — they are sim-time and reproducible.
* **`blockedByGeometry` on a movement beat** means the player ran into level
  geometry and that beat's speed numbers describe a wall. Each beat is teleported
  back to the same known-open spot first, and re-oriented down the most open
  direction, so this should be rare.
* **`lineOfSight: false` on a TTK row** means the level had no sightline at that
  range from the staging point, not that the weapon is broken. The lethality
  gate already excludes those rows.

---

## CI

```yaml
- run: npx tsc --noEmit
- run: npx vite build --outDir dist-gp-h
- run: node tools/playtest.mjs --no-build --port 9901
- run: node tools/perf-session.mjs --no-build --port 9901 --no-shots
```

Both tools reuse an already-running static server on their port, so a single
`vite preview` serves both steps.
