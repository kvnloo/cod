# Contributing

Thanks for taking a look. This is an experimental codebase, so the bar for
"useful contribution" is lower than you might expect — bug reports, questions
about why something is built the way it is, and small fixes are all genuinely
helpful.

## Setup

```sh
npm install
npm run dev        # http://127.0.0.1:5173
```

Node 20+ and a WebGL2 browser.

## The four rules

These are not style preferences. Breaking them breaks tooling.

1. **No binary assets.** No `.gltf`, `.png`, `.wav`, `.hdr` — nothing that
   isn't text. Textures are rendered on the GPU at boot, meshes are built from
   `BufferGeometry`, audio is synthesised. If you need an asset, generate it.

2. **No `Math.random()`.** All randomness comes from `src/core/Rand.ts`. The
   capture and regression tooling depends on a given seed producing an
   identical run — one stray `Math.random()` makes a whole capture
   non-reproducible and the failure is miserable to track down.

3. **Talk through the bus.** Cross-system communication goes through `bus`
   (`src/core/EventBus.ts`). Add new names to `GameEvents` rather than reaching
   into another system's internals. FX, audio and HUD must keep working when no
   gameplay system knows they exist.

4. **Simulation is fixed-step.** Physics, movement, AI and ballistics belong in
   `fixedUpdate` (120 Hz). Anything frame-rate dependent — camera smoothing,
   interpolation, visual effects — belongs in `update`/`lateUpdate`.

## Before you open a PR

```sh
npm run typecheck            # must be clean
npm run build                # must succeed
node tools/net-protocol.mjs  # if you touched src/net/
node tools/session-flow.mjs  # if you touched src/session/
node tools/smoke.mjs         # if you touched gameplay
```

There is CI on pull requests that runs typecheck, build and the contract
harnesses. It has to be green.

## Docs are contracts, not commentary

`docs/NETCODE.md` and `docs/SESSION.md` are the source of truth for their
subsystems, not descriptions written after the fact. **If your change
contradicts one, update the document in the same PR.** A PR that silently
diverges from a contract will be asked to change one or the other.

If you find a place where code and contract already disagree, that is a real
bug worth reporting even if you don't fix it. `NETCODE.md` §0.1 tracks the
known ones.

## Visual work

Changes to materials, lighting or world art are scored against
[`docs/VISUAL-BAR.md`](docs/VISUAL-BAR.md). Read the "seven tells" section
first — it is specific about what fails and why.

For before/after comparison:

```sh
npm run shots                # capture screenshots
node tools/contactsheet.mjs  # assemble a contact sheet
node tools/ab.mjs            # A/B two configurations
```

Capture output is gitignored. Attach the images to your PR rather than
committing them — the repository's history was already cleaned of 95 MB of
capture PNGs once.

## Commit and PR style

- Present tense, imperative: "fix shader link failure on Mac", not "fixed".
- Say *why* in the body when the change isn't self-evident.
- One logical change per PR where you can manage it. The existing history has
  some enormous multi-subsystem commits; that was an artifact of how the repo
  was generated and isn't a pattern to follow.

## Reporting bugs

Include your **OS, browser and GPU** — most rendering issues are driver- or
platform-specific, and "it looks wrong" is not reproducible without them. A
screenshot and anything from the browser console helps a lot.
