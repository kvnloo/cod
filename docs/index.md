---
layout: home

hero:
  name: Operation Blackout
  text: A first-person shooter with no assets
  tagline: >-
    Every mesh, PBR texture, sound and animation is generated in code at load
    time. There is not a single binary file in this repository.
  actions:
    - theme: brand
      text: Play in the browser
      link: /play/
    - theme: alt
      text: Read the architecture
      link: /ARCHITECTURE
    - theme: alt
      text: View on GitHub
      link: https://github.com/kvnloo/cod

features:
  - title: Zero binary assets
    details: >-
      No .gltf, .png, .wav or .hdr anywhere. Textures are rendered on the GPU
      into render targets at boot, meshes are built from BufferGeometry, and
      audio is synthesised with the Web Audio API. The entire game is readable
      and diffable as source.
  - title: Deterministic by construction
    details: >-
      All randomness flows through a single seeded generator. Math.random() is
      banned. The same seed produces the same world, which is what makes the
      automated capture and regression tooling possible.
  - title: Systems, not singletons
    details: >-
      Everything in the frame loop implements a System interface and talks over
      an event bus. FX, audio and HUD are pure listeners — no gameplay system
      knows they exist.
  - title: Contracts you can execute
    details: >-
      The netcode and session layers are specified in prose and verified by
      headless harnesses. `node tools/net-protocol.mjs` asserts 100 properties
      of the wire format and prints real bandwidth numbers.
---

## What this is

A browser FPS built in [Three.js](https://threejs.org) and TypeScript, with
[Rapier](https://rapier.rs) for physics. Roughly 148k lines across sixteen
subsystems: rendering, materials, world generation, weapons, characters,
animation, AI, audio, FX, UI, physics, networking and the session/meta layer.

The organising constraint is that **nothing is loaded from disk**. A wall's
albedo, roughness and normal maps are rendered procedurally on the GPU during
boot. A rifle is `BufferGeometry` assembled from parts in code. A gunshot is
synthesised. This makes the project unusually reviewable — every visual result
traces back to source you can read, rather than to a binary someone exported
from Blender years ago.

## How it was built

This repository was produced by Claude Code from [a single
prompt](https://github.com/kvnloo/cod/blob/main/prompt.md), fanning out parallel
subagents per subsystem with adversarial critics scoring the output against
shipped AAA titles. [The visual bar](/VISUAL-BAR) is the rubric those critics
used, and it is worth reading on its own — it is a concrete list of the specific
tells that make real-time WebGL look like a hobby project.

That origin is the reason for some of the conventions here. The documents under
this site are written as *contracts*: they describe what a subsystem guarantees
so that independent authors can build against it without coordinating. They are
the source of truth, and the code follows them.

## Quick start

```sh
git clone https://github.com/kvnloo/cod.git
cd cod
npm install
npm run dev
```

Then open the printed URL. Requires Node 20+ and a browser with WebGL2.

::: warning Honest status
This is an experiment, not a shipped game. Expect rough edges, unfinished
subsystems and places where the code and these contracts have drifted apart —
[NETCODE](/NETCODE) documents its own known divergences rather than hiding them.
Bug reports and PRs are welcome.
:::
