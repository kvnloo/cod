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

Honesty contract (category J): both tools run with **`capture=0`**. If
`meta.captureSync === true`, the run hard-fails — it measured the instrument
(~7 ms/frame Exposure sync flush), not the game. Reports must carry
`gpuPath`, `presentationPath`, `contamination` (including `busy-host` when
loadavg is high), and `loadavg1`.

`gpuPath` is the GL class (hardware vs software). `presentationPath` is how
frames reach the eye (`headless-raf-no-vblank` in CI Chromium). Software GL
**cannot pass** frame gates — that grades the rasteriser, not the ship build.

---

## Protected greens

| ID | Gate | Threshold | Instrument | Status | Notes |
|---|---|---|---|---|---|
| `enemies-spawned` | combatants on field | `> 0` | playtest | **green** | BotFallback path |
| `time-to-die` | median TTD vs 3 rifles @ ~12 m | `≤ 8000 ms` | playtest | **green** | 3-trial median |
| `down-loop` | last-stand cycles before death | `≤ 1` | playtest | **green** | |
| `ttk-lethal` | weapon×range fails to kill | `== 0` | playtest | **green** | sightline skips excluded |
| `damage-model` | distinct per-hit damage values | `≥ 3` | playtest | **green** | falloff live |
| `hitbox-zones` | distinct zones on **living** enemy scan | `≥ 3` | playtest | **green** | wave-2 promoted; head/chest/stomach/arm/leg bands |
| `death-anim` | fraction of deaths with pose delta | `≥ 0.90` | playtest | **green** | |
| `motion-continuity` | teleports in fixed-step traversal | `== 0` | playtest | **green** | stepSnaps reported separate |
| `no-free-launch` | flat-ground upward launches | `== 0` | playtest | **green** | ramp gains ignored |
| `recoil-bounded` | residual camera recoil @ +2 s | `≤ 0.50°` | playtest | **green** | |
| `no-console-errors` | console exceptions mid-session | `== 0` | playtest | **green** | |
| `frame-capture-sync` | wall sample not under capture sync | `captureSync === false` | playtest / perf-session | **green** | hard-fail if true |
| `display-path-hardware` | `gpuPath === 'hardware'` | hardware GL | playtest / perf-session | env | software fails closed |
| `frame-p99` | p99 wall frame @ 1080p/high | `≤ 16.7 ms` on hardware | playtest | **open** | wave-2 measured ~50 ms p99 under load; p1 target |
| `frame-spikes` | frames > 50 ms after warm-up | `== 0` on hardware | playtest | **open** | remains hard-open until p1 green; software cannot pass |

On a software rasteriser (`llvmpipe` / SwiftShader) `frame-p99` and
`frame-spikes` hard-fail by design so a CI box cannot certify a fake green.
Until p1 lands frame consistency, treat both frame hard gates as open on
hardware too; do not re-litigate without a re-measure on idle hardware.

## Advisory (not CI-blocking yet)

| ID | Target | Notes |
|---|---|---|
| `ttk-band` | 400–900 ms AR core | design band between CoD and Apex |
| `sprint-to-fire` | 80–200 ms | CoD-like commitment |
| `ai-agents` | `> 0` | ActorAPI package still pending |

## New-player experience (category G)

| Check | Threshold | How |
|---|---|---|
| Control strip on first Deploy | once per profile (`localStorage`) | lower-third strip, **not** queued behind mode banner |
| Control strip latency vs mode banner | not blocked **> 1 s** | independent of banner queue |
| Keys listed | move, look, fire, ads, jump, crouch, sprint, reload, melee, grenade, weapon, score, pause | `HUD.showFirstMatchControls` |
| Click-to-look | `CLICK TO LOOK` until `input.locked` | `Banners.setLookHint` |

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
```

## Open hard (do not re-litigate without re-measure)

1. **`frame-spikes`** — zero frames > 50 ms after warm-up on hardware GL at
   1080p/high during scripted live play. Remains the sole open hard gate until
   the performance package (p1) is green.
