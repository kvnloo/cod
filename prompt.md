# The prompt

This is the original prompt that produced this repository, kept verbatim as the record.

```
I want you to build a first-person shooter at the level of the most recent Call of Duty games. It should be utterly perfect, visually beautiful, with every single thing done at AAA quality—from textures to physics to anything you could think of.

Fan out sub-agents and have sub-agents tackle each one individually so that the game is utterly perfect. You should /loop on each item and have a separate sub-agent check it visually to ensure it looks triple A. That separate sub-agent should be a really harsh critic, and if it doesn't look triple A, it should keep going.

Don't stop until each sub-agent is utterly wowed with the quality when compared with the actual Call of Duty game. It should literally compare them side by side blind and say which one looks better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out sub-agents and ultracode.
```

Subsequent direction, also verbatim:

```
essentially we need to make sure all the animations and movement feels perfect. i prefer apex
legends movement tbh, so let's just do that. make the movement engine apex legends, but have
everything else feel like cod. we can also increase ttk since movement is more important now.
we don't want healing like in apex tho, i like fast paced healing like cod where it auto heals
or u can stim while fighting.
```

```
think through what additional gaps there could be in our approach and improve prompt.md to do
other specific types of checks like for animations, gameplay, how satisfying the effects are,
the gameplay needs to be FUN and addicting like cod.
```

---

# The design target

**Apex Legends movement. Call of Duty everything else. Higher TTK than CoD, because movement now
carries the skill expression. CoD healing — passive regen plus a stim usable mid-fight — never
Apex's shield-battery and med-kit loop.**

---

# Verification doctrine

## Why this section exists

Eight iteration waves verified this game **exclusively from still screenshots**. Ten independent
audits ran; five were visual and five were not; only the visual findings were ever dispatched as
fix work. The result was a game that measurably improved in every lighting and material metric
while remaining, in the user's words after actually playing it:

> "it felt very unplayable and not smooth. fps was really bad. after getting downed i would just
> get shot at for 60s without dying. it didn't really play like cod."

Every one of those defects was **invisible to a screenshot** and would have been caught in thirty
seconds of play. The lesson generalises: *the verification method silently defines what quality
means.* A loop that only looks at frames will only ever produce a game that photographs well.

The rule that follows from this:

> **No quality claim is admissible unless it was measured by the method that would expose its
> failure.** Feel is measured by playing. Smoothness is measured over a session, not a frame.
> Fun is measured by a loop, not a still.

## The seven verification modes

Every wave must state which modes it used. A wave that uses only mode 1 must say so and must not
claim anything outside mode 1's reach.

| # | Mode | Exposes | Instrument |
|---|---|---|---|
| 1 | **Still frame** | Lighting, materials, composition, geometry | Screenshot + `docs/VISUAL-BAR.md` |
| 2 | **Motion clip** | Animation, blending, popping, footsliding, camera behaviour | Frame sequence at ≥60 fps, played back and inspected |
| 3 | **Played session** | Feel, responsiveness, pacing, difficulty, the 60-second-to-die class of bug | `tools/playtest.mjs`, scripted multi-minute sessions |
| 4 | **Sustained profile** | Stutter, hitching, memory growth, thermal/frame-time drift | `tools/perf-session.mjs`, percentiles not averages |
| 5 | **Instrumented event trace** | Input→response latency, audio-visual sync, effect timing | Timestamped event log across input, sim, render, audio |
| 6 | **Loop analysis** | Progression, reward cadence, addiction, session retention | Multi-match simulation with reward accounting |
| 7 | **Blind A/B against reference** | Whether it actually beats the target game | Side-by-side with labels hidden, one-second verdict |

## Check categories

Each category lists what to measure and the gate. Numbers are starting targets — beat them or
justify a change with a source, never quietly drop one.

### A. Responsiveness — the contract with the player's hands

Every player action must be acknowledged **visually and audibly within 50 ms**, independent of
what the simulation later decides. This is the single most-felt property in a shooter and the
easiest to lose to a frame-quantised clock.

- Input→first visible response, per action (fire, ADS, jump, slide, mantle, reload, melee, swap):
  **≤ 50 ms p99**, measured from event timestamp to the frame the response appears.
- Every gameplay clock runs on the **fixed step**, never the display frame. Prove frame-rate
  independence by measuring the same action at 30 / 60 / 144 / 540 fps and showing identical
  results. *(Fire rate failed exactly this and compounded its error.)*
- Animation **cancel windows** exist and are honoured: sprint cancels reload, fire cancels
  inspect, slide cancels sprint. List every cancel and its window in ms.
- No input is dropped or coalesced away under load. Measure at p99.9, not p50.

### B. Feedback and juice — why landing a shot feels good

This is the category the project has never once measured, and it is most of what "feels like CoD"
actually means. Reference: Swink, *Game Feel*; the CoD "gunfeel sandwich" is input → animation →
sound → impact → reward, all inside ~100 ms.

- **Hitmarker**: appears ≤ 60 ms after the shot lands, with distinct states for normal / armour /
  headshot / kill. Each state distinguishable in a single frame *and* in a single sound.
- **Hitstop**: a brief freeze or slow on impactful hits. Measure its duration; confirm it is
  applied to presentation only and never to the authoritative simulation.
- **Camera kick and shake**: magnitude, decay curve, and fixed-step independence. Must be
  tunable and must never fight the player's aim for longer than the recovery window.
- **Kill confirmation**: sound, visual, and reward all land within 150 ms of the killing blow.
- **Impact effects vary by surface material** — concrete, metal, wood, glass, flesh, dirt each
  produce a distinct spark/debris/decal/sound set. Show all of them.
- **Damage direction indicator** appears within 100 ms and points correctly.
- **Tracers, muzzle flash, shell ejection, smoke, blood** all originate from the correct world
  position. *(Muzzle flash was measured floating 150 px off the barrel and brass ejecting in
  front of the muzzle — both invisible to every prior check.)*
- Screen effects on damage taken: readable, not disabling, and they decay.

### C. Audio-visual synchrony

- Every impact sound lands **within one frame** of its visual. Measure the delta; report p99.
- Footstep audio fires on the **foot plant**, not on a timer.
- Reload audio beats align with the animation beats that produce them (magazine out, magazine
  in, bolt release) — measure each beat's audio/visual delta separately.
- Weapon report is layered (mechanical, body, crack, tail) and localises correctly. Measure the
  octave-band split; a shot that is mostly low-frequency thump destroys localisation.

### D. Animation quality

- **No popping**: every state transition blends. Measure per-joint angular velocity across
  transitions and flag discontinuities.
- **No footsliding**: world-space drift of a planted foot **< 2 cm** through a walk cycle.
- **Every authored clip compiles to more than one key.** *(Death clips compiled to a single key
  and enemies simply did not play death animations — a compiler bug no screenshot could show.)*
- Death and hit reactions vary — at minimum directional deaths, and no two consecutive deaths
  identical.
- Weapon and body are coherent: hands are on the weapon, the weapon is in the hands, and both
  agree about where the world is.
- Secondary motion exists where a AAA game would have it (slings, pouches, cloth, antennae).

### E. Combat integrity

- **The player must be able to die.** Time-to-die standing still in front of 3 engaging enemies
  at 20 m: **≤ 8 s**, as a hard CI gate.
- Real hitboxes with distinct zones (head / chest / stomach / arms / legs) and distinct
  multipliers. Headshot TTK must be materially shorter than leg TTK — measure both.
- Enemy shots resolve through the **same ballistics and hitbox path the player uses**. A random
  roll deciding damage is a structural failure, not a placeholder. *(It was `rng.bool(chance)`.)*
- TTK table authored per weapon class at 10 / 25 / 50 m, measured within 10% of target, and
  deliberately **above** CoD's because movement carries more skill here.
- Regen: stated out-of-combat delay, stated heal duration, both measured. Stim usable mid-fight
  with a real cost. No healing items to manage.

### F. Fun and addiction — the loop

The hardest category and the one that most needs an explicit instrument. CoD is addictive because
of a **reward cadence**, not because of any single frame. Measure the loop, not the moment.

- **Time-to-first-contact after respawn**: 3–8 s. Longer is boring; shorter is spawn-trapping.
  Report the distribution across 50 respawns, not the mean.
- **Engagement frequency**: meaningful combat encounters per minute over a 10-minute session.
- **Reward cadence**: something must be earned — XP, progress, a streak, an unlock — on a rhythm.
  Report the interval distribution. Long empty stretches are the failure mode.
- **Downtime audit**: measure the fraction of session time spent doing nothing interesting
  (walking to contact, waiting to respawn, reloading in cover). Name the longest dead stretch.
- **Death→respawn→re-engage** total loop time: CoD is ~5–8 s. Anything longer breaks flow.
- **Killstreaks / escalation**: does a good run feel increasingly powerful?
- **Skill expression gap**: measure the performance difference between an optimal scripted player
  and a naive one, for movement and for gunplay separately. **A small gap means the game is not
  worth mastering** — this is the most important single number in this category.
- **Session curve**: is minute 10 as engaging as minute 1? Report what changes.

### G. New player experience

- The first 30 seconds must be legible without instruction. Verify by scripting a naive player
  who does not know the controls.
- The game must feel good **before** the player is good at it. Movement and shooting must be
  satisfying at low skill, with headroom above.

### H. Performance as a feel property

Frame *consistency* is felt far more than frame *rate*. Averages hide exactly the failure players
notice.

- p99 frame time **≤ 16.7 ms** at 1080p on the default preset, with gameplay running — not a
  static camera.
- **Zero frames > 50 ms** after warm-up. A single 100 ms hitch in a firefight is worse than 10
  fps of average loss.
- Presets must be **honest**: if the game cannot hold 60 fps at ultra, ultra must not be default,
  and the preset table must say what each targets and on what hardware.
- Report percentiles and the worst 1% of frames with what was on screen. Never report an average
  alone.

### I. Regression protection

Fixes in this project have been silently re-broken by later waves. Therefore:

- Every wave that certifies something as **at bar** adds it to a standing regression list with
  its measurement and threshold.
- Every subsequent wave **re-measures the entire list** and reports it. A regression is a wave
  failure regardless of what else landed.
- Critics must name what is now genuinely good, so it is not re-litigated and not re-broken.

### J. Honest instrumentation

The verification apparatus is itself a source of silent failure and must be audited.

- Assert the **hardware** path. *(`--use-angle=gl-egl` silently fell back to Mesa llvmpipe under
  contention; three separate audits graded a software rasteriser at 3,734 ms/frame without
  noticing. The renderer string was being read and never checked.)*
- Assert the **display** path. A latency measurement in headless Chromium says nothing about a
  540 Hz panel, because there is no vblank to align to.
- Record contamination. If the box was busy — a human playing, another agent rendering — say so
  next to the number.
- A self-reported passing gate is a **claim**, not evidence. Critics re-measure independently.
- Report measured-vs-threshold for every gate. **Never tune to a number you cannot defend**; if a
  gate is unreachable, say so with the measurement and the reason.

---

# How to run a wave

1. **Audit** — independent agents, one per domain, read-only, each returning findings with
   `file:line` and a severity. Cover visual *and* non-visual domains every time.
2. **Synthesise** — merge duplicates, rank by how far a blind side-by-side moves, and split into
   packages with **strictly disjoint file ownership**. Two agents editing one file loses work.
3. **Fix** — one agent per package, each carrying its verbatim findings and a runnable acceptance
   test with numeric gates. Each agent verifies its own work with the mode that would expose its
   failure.
4. **Critique** — independent blind critics who re-measure rather than trust, do the labels-hidden
   comparison, and state plainly what is now at bar.
5. **Land** — typecheck, build, run the regression list, commit with the measurements in the
   message.
6. **Loop** on everything still failing.

Size waves to *finish*. A wave that dies mid-edit leaves a broken tree and lands nothing.
