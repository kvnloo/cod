# Regression ledger

Standing list of **protected greens**. Every subsequent wave re-measures the
entire list. A regression is a wave failure regardless of what else landed.

Measurement instruments: `tools/playtest.mjs` (modes 3 + 4 + hard gates),
`tools/perf-session.mjs` (mode 4), `tools/g2-gunfeel.mjs` (mode 5). Numbers
without a method that would expose their failure are claims, not evidence.

## How to re-run

```bash
npx vite build --outDir dist-gp-h
node tools/playtest.mjs --no-build --json shots/playtest/report.json
node tools/perf-session.mjs --no-build --presets high --ms 8000
npx tsc --noEmit
```

Default TTD cert range is **`--ttd-range 20`** (prompt E). A dual reference at
12 m is also recorded as `combat.ttdAlt` when `--ttd-range-alt 12` (default).

Honesty contract (category J): both tools run with **`capture=0`**. If
`meta.captureSync === true`, the run hard-fails — it measured the instrument
(~7 ms/frame Exposure sync flush), not the game. Reports must carry
`gpuPath`, `presentationPath`, `contamination` (including `busy-host` when
loadavg is high), and `loadavg1`.

Gate `why` strings are **invariants / past-tense failure notes**, not live
diagnoses. Present-tense "is broken today" claims in a `pass: true` row are
ledger lies (category J).

`gpuPath` is the GL class (hardware vs software). `presentationPath` is how
frames reach the eye (`headless-raf-no-vblank` in CI Chromium). Software GL
**cannot pass** frame gates — that grades the rasteriser, not the ship build.

---

## Protected greens

| ID | Gate | Threshold | Instrument | Status | Notes |
|---|---|---|---|---|---|
| `enemies-spawned` | combatants on field | `> 0` | playtest | **green** | BotFallback / actor path |
| `time-to-die` | median TTD vs 3 rifles @ **20 m** | `≤ 8000 ms` | playtest | **green** | 3-trial median; dual ref @ 12 m in `ttdAlt` |
| `down-loop` | last-stand cycles before death | `≤ 1` | playtest | **green** | |
| `ttk-lethal` | weapon×range fails to kill | `== 0` | playtest | **green** | sightline skips excluded |
| `damage-model` | distinct per-hit damage values | `≥ 3` | playtest | **green** | falloff live |
| `hitbox-zones` | distinct zones on **living** enemy scan | `≥ 3` | playtest | **green** | head/chest/stomach/arm/leg bands |
| `death-anim` | fraction of deaths with pose delta | `≥ 0.90` | playtest | **green** | |
| `motion-continuity` | teleports in fixed-step traversal | `== 0` | playtest | **green** | stepSnaps reported separate |
| `no-free-launch` | flat-ground upward launches | `== 0` | playtest | **green** | ramp gains ignored |
| `recoil-bounded` | residual camera recoil @ +2 s | `≤ 0.50°` | playtest | **green** | |
| `no-console-errors` | console exceptions mid-session | `== 0` | playtest | **green** | |
| `frame-capture-sync` | wall sample not under capture sync | `captureSync === false` | playtest / perf-session | **green** | hard-fail if true |
| `display-path-hardware` | `gpuPath === 'hardware'` | hardware GL | playtest / perf-session | env | software fails closed |
| `frame-p99` | p99 wall frame @ 1080p/high | `≤ 16.7 ms` on hardware | playtest | **green** | wave-3 measured **15.73 ms**; re-measure every wave |
| `frame-spikes` | frames > 50 ms after warm-up | `== 0` on hardware | playtest | **open** | sole open hard; wave-3 measured 3× >50 ms |

On a software rasteriser (`llvmpipe` / SwiftShader) `frame-p99` and
`frame-spikes` hard-fail by design so a CI box cannot certify a fake green.

Do **not** re-open `frame-p99` without a re-measure that shows p99 > 16.7 on
idle hardware. Wave-2 ~50 ms notes are historical, not current status.

## Advisory (not CI-blocking yet)

| ID | Target | Notes |
|---|---|---|
| `ttk-band` | 400–900 ms AR core | design band between CoD and Apex |
| `sprint-to-fire` | 80–200 ms | CoD-like commitment; why must not claim "zero today" when measured ~190 ms |
| `ai-agents` | `> 0` | real `src/ai/` stack preferred; measured count is evidence, not a stale "zero agents" claim |
| `ttfc-band` | 3–8 s median | `combat.ttfc` samples (proximity ≤32 m or damage after spawn/respawn) |
| `npe-control-strip` | strip shown, HUD ≤1 s | cold `game:start` + deploy paths |
| `npe-look-hint` | look hint until lock | `CLICK TO LOOK` / `__BLACKOUT_NPE__` |
| `ttk-zone-spread` | head TTK < 0.85 × leg TTK @ 10 m | `combat.ttkZones` head/chest/leg |

## New-player experience (category G)

| Check | Threshold | How |
|---|---|---|
| Control strip on cold match start | once per session on `game:start` **and** MainMenu deploy | lower-third strip, **not** queued behind mode banner |
| Control strip latency vs mode banner | not blocked **> 1 s** | independent of banner queue; `stripHudSec ≤ 1` |
| Keys listed | move, look, fire, ads, jump, crouch, sprint, reload, melee, grenade, weapon, score, pause | `HUD.showFirstMatchControls` |
| Click-to-look | `CLICK TO LOOK` until `input.locked` | `Banners.setLookHint` |
| Playtest NPE rows | advisory gates | `npe-control-strip`, `npe-look-hint` + `report.npe` |

## Honesty fields every report must carry

```
meta.capture            // 0 for wall-clock tools
meta.captureSync        // must be false
meta.gpuPath            // 'hardware' | 'software'
meta.displayPath        // legacy alias of gpuPath (GL class only)
meta.presentationPath   // 'headless-raf-no-vblank' | 'compositor-vblank'
meta.contamination[]    // software-gl | no-vblank | busy-host | capture-sync | …
meta.loadavg1           // host 1-minute load average
meta.cpus               // host CPU count
combat.ttfc             // { samples, medianSec, … } category F instrument
combat.ttkZones         // { headMs, chestMs, legMs } category E instrument
combat.ttd.rangeM       // cert range (default 20)
combat.ttdAlt           // optional dual-range reference (default 12 m)
npe                     // { controlStripShown, stripHudSec, lookHint, … }
```

## Open hard (do not re-litigate without re-measure)

1. **`frame-spikes`** — zero frames > 50 ms after warm-up on hardware GL at
   1080p/high during scripted live play. **Sole open hard gate.** Remains open
   until the performance package (p1) is green. `frame-p99` is protected green
   at wave-3 **15.73 ms** — do not list it as open.
