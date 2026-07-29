# Operation Blackout — Architecture

A first-person shooter in Three.js targeting the visual and mechanical bar of a
modern Call of Duty title. Everything is procedurally generated at load time —
there are **no binary assets** in the repository. Geometry, PBR textures, audio
and animation are all authored in code.

## Ground rules

1. **No binary assets.** No `.gltf`, `.png`, `.wav`, `.hdr`. Textures are rendered
   on the GPU into render targets at boot; meshes are built from
   `BufferGeometry`; audio is synthesised with the Web Audio API. This keeps the
   whole game inspectable, diffable and reviewable as source.
2. **TypeScript, strict.** `npx tsc --noEmit` must be clean for the files you own.
3. **Systems, not singletons.** Everything the frame loop touches implements
   `System` (`src/core/Engine.ts`) and is registered in `src/main.ts`.
4. **Talk through the bus.** Cross-system communication uses `bus` from
   `src/core/EventBus.ts`. Add new event names to `GameEvents` rather than
   reaching into another system's internals. FX, audio and HUD are *pure
   listeners* — they must work without any gameplay system knowing they exist.
5. **Determinism.** All randomness comes from `src/core/Rand.ts`. Never call
   `Math.random()`. Capture runs must be reproducible for a given seed.
6. **Fixed step for simulation.** Physics, movement, AI and ballistics live in
   `fixedUpdate` (120 Hz). Presentation lives in `update` / `lateUpdate`.
7. **Budget-aware.** Read `settings.gfx` every frame; honour quality presets.
   A `low` preset must run on integrated graphics.

## Frame schedule

```
input.beginFrame
  → N × fixedUpdate   physics → player → weapons → ballistics → ai → gameplay
  → update            world → fx → audio → camera → ui
  → lateUpdate        camera-attached effects, culling, LOD
  → render            RenderSystem drives the whole frame graph
input.endFrame
```

Systems declare an `order` from the `ORDER` table in `src/core/Engine.ts`.

## Module map and ownership

| Path | System | Responsibility |
|---|---|---|
| `src/core/` | — | Engine loop, time, input, events, settings, RNG, capture API, surface table |
| `src/render/` | `render` | WebGL context, HDR frame graph, shadows, sky/IBL, all post-processing |
| `src/material/` | `materials` | Procedural PBR texture generation, material library, shader extensions |
| `src/physics/` | `physics` | Rapier backend, raycasts, character controller, ragdolls, destruction |
| `src/world/` | `world` | Level geometry, props, lighting design, nav data, capture shot list |
| `src/player/` | `player` | Movement state machine, camera rig, health, interaction |
| `src/weapons/` | `weapons` | Weapon definitions, view model + procedural animation, recoil, ballistics |
| `src/ai/` | `ai` | Perception, navigation, cover selection, squad tactics, combat behaviour |
| `src/fx/` | `fx` | GPU particles, impacts, tracers, muzzle flashes, explosions, decals |
| `src/audio/` | `audio` | Synthesised 3D audio, reverb zones, occlusion, mixing |
| `src/ui/` | `hud` | Combat HUD, menus, killfeed, scoreboard, damage indicators |
| `src/game/` | `director` | Game modes, objectives, wave pacing, scoring, progression |

**Do not edit files outside the directory you own.** If you need a change to a
shared contract (`src/core/*`, another module's `types.ts`), implement everything
you can without it and report the exact change you need.

## Key contracts

- `src/core/Engine.ts` — `System`, `EngineContext`, `ORDER`
- `src/core/EventBus.ts` — `GameEvents`, the full gameplay event vocabulary
- `src/core/Surfaces.ts` — `SurfaceType` + physical properties driving
  penetration, ricochet, impact VFX, footstep audio and decals
- `src/core/Settings.ts` — `GfxSettings` quality knobs and presets
- `src/core/CaptureAPI.ts` — deterministic capture contract used by the harness
- `src/physics/types.ts` — `PhysicsAPI`, `RayHit`, collision layers
- `src/render/types.ts` — `RenderAPI`, render layers, decal/light/screen-effect
  requests

## Verification

The game runs in headless Chromium with **hardware** WebGL2 (RTX 3080 Ti via
ANGLE/EGL), so screenshots are real GPU renders.

```bash
npx tsc --noEmit                       # types
node tools/capture.mjs --label mypass  # build + screenshot every registered shot
node tools/perf.mjs                    # frame-time percentiles under load
```

Screenshots land in `shots/<label>/`. Register new camera shots by returning
`ShotDef`s from `WorldSystem.captureShots()`.

`tools/harness.mjs` is the shared driver — it exposes `openSession()` for any
custom automation you need.

## Quality bar

Every visual system is reviewed by an adversarial critic that compares
screenshots against real Call of Duty reference. The standard is not "looks
good for a browser game" — it is "indistinguishable from a shipped AAA title in
a blind side-by-side". Specifically:

- No flat, untextured surfaces. Every material needs albedo variation, normal
  detail, roughness breakup and grime in crevices.
- No uniform lighting. Bounce light, contact shadows, and directional contrast
  are what separate AAA from hobby work.
- Correct exposure and tonemapping. Highlights must roll off, not clip.
- Silhouettes and composition matter: props must break up straight lines,
  and sightlines must have depth layers (foreground, midground, background).
