# `src/session/loadout` — create-a-class

Owns the loadout: what a player carries, what is bolted to it, whether they are
allowed to carry it, and what numbers the gun actually ends up with.

Verified by `node tools/session-loadout.mjs` — 209 checks, including a sweep of
all **29 907** legal attachment combinations on all 8 catalogue weapons against
an independent sanity table.

---

## 1. The shape

```ts
interface Loadout {
  version: 1;
  id: string;  name: string;
  primary:   { weaponId: string; attachments: string[] };
  secondary: { weaponId: string; attachments: string[] };
  lethal: string;  tactical: string;
  perks: [string, string, string];   // one per row, '' = empty
  fieldUpgrade: string;
  killstreaks: string[];             // ordered by cost
}
```

`LoadoutBook` (`Classes.ts`) holds up to `LIMITS.savedClasses` of them, persists
through any `StorageLike`, and emits `BookChange` events for the UI. Every
mutator returns a `ValidationResult` rather than throwing.

## 2. The modifier algebra

The one thing that stops create-a-class producing absurd guns. Stated once in
`Modifiers.ts`, tuned from `data/balance.ts`, never re-implemented per stat.

| Mode | Meaning | Stacking |
|---|---|---|
| `mul` | scales the weapon's base | **diminishing on the helpful side only** |
| `add` | applied after scaling | plain sum |
| `max` | ignores the base entirely (optic zoom) | largest wins |

**Diminishing returns are one-sided.** Beneficial deviations are sorted
largest-first; the first counts in full, the next at `soften`, the next at
`soften²`. Penalties always count in full. A compensator + angled grip +
precision stock give ≈ 39 % recoil reduction, not the naive 44 %, and every
extra recoil part is worth less than the last. Stacking downsides is never
softened — that is what makes a greedy build genuinely bad.

**Order never matters.** Deviations are summed and the sort is stabilised by
source id, so a shuffled attachment list resolves byte-identically. Replay,
killcam and netcode depend on this; the harness samples ~1100 shuffles a run.

**Rails are a safety net, not the balance.** Final value is
`clamp(base × factor + Σadd, lo, hi)` where `lo`/`hi` are the relative rails
(`minMul`/`maxMul`, so an LMG and a pistol get proportionate limits) intersected
with the absolute rails. Two rules that were learned the hard way:

- *An absolute rail never moves a weapon past its own base.* The bolt-action
  ships `spread.ads === 0` — a designer saying "this does not miss when aimed" —
  and a 0.005° floor must not invent spread for it. Weapons outside a rail are
  grandfathered at their base; attachments still cannot push them further out.
- *Rounding is not clamping.* A 5-round magazine × 1.5 is 7.5 rounds and becomes
  8. That is arithmetic. `StatFold.rounded` reports it; `capped` does not.

Conflating those two made 35.6 % of all combinations look railed. The real
figure is **7.9 %**, and the harness now fails above 15 %, and fails outright if
any *stock* weapon touches a rail.

**Reload is railed in seconds.** `reloadTime` is a scale with a base of 1, so
its rails live in scale-space and cannot see that a fair ×1.45 drum penalty on a
4.2 s LMG reload yields a six-second animation. `RELOAD_RAILS` rails the
duration itself — the only place in the system that rails in units rather than
multiples.

## 3. `EffectiveWeaponStats` — the contract for `src/weapons`

`resolveWeapon(weaponId, attachmentIds, { perks, extra })` folds a catalogue
weapon with everything fitted to it and returns one flat, plain-data object.
No three.js, no DOM, no engine — safe to call on a headless host.

```
identity     weaponId weaponName cls attachments meshAttachments
handling     adsTime sprintOut drawTime holsterTime moveScale adsMoveScale
             swayScale flinchScale
reload       reloadTactical reloadEmpty reloadScale
             shellReload reloadPerShell reloadShellIn reloadShellOut
recoil       recoilVerticalScale recoilHorizontalScale recoilFirstShotScale
             recoilRecoverFraction patternVertical[] patternHorizontal[]
spread       hipSpreadDeg adsSpreadDeg bloomPerShotDeg bloomMaxDeg
             bloomDecayDegPerSec
ammo/ballistics
             rpm magSize reserve muzzleVelocity penetration
             damage[] falloffScale damageScale
optics/flags magnification suppressed laser flags[]
diagnostics  capped[] warnings[]
```

Notes for consumers:

- **Times are seconds, angles are degrees, `*Scale` fields are multipliers.**
- `patternVertical` / `patternHorizontal` are the catalogue recoil pattern
  already multiplied through — feed them straight to `RecoilState`.
- `damage[]` is the full falloff curve with both distance *and* damage already
  modified; `effectiveDamageAt(eff, m)` and `effectiveShotsToKill(eff, m, zone)`
  read it.
- `meshAttachments` is exactly the id list the view-model builder needs.
- **Shell reloaders**: shotguns have `reloadTactical === 0`. Branch on
  `shellReload`, not on the class. All four shell fields are already scaled, so
  Sleight of Hand and quickdraw magazines speed a shotgun up like anything else.
  (They previously did nothing at all.)
- `capped` lists stats the safety net touched — surface it in the armoury so a
  player can see a part is doing nothing.
- `warnings` is diagnostics only. Resolution never throws and always returns a
  runnable weapon.

### Integration point

`toResolvedStats(eff)` returns the weapons module's own `ResolvedStats`
(`src/weapons/Attachments.ts`) so no call site has to change:

```ts
// src/weapons/WeaponSystem.ts — replace the local resolve with:
import { resolveWeapon, toResolvedStats } from '../session/loadout';

const eff = resolveWeapon(spec.weaponId, spec.attachments, { perks: loadout.perks });
this.stats = toResolvedStats(eff);       // drop-in for resolveStats(def, list)
this.viewModel.setParts(eff.meshAttachments);
```

Prefer `EffectiveWeaponStats` directly where you can — `ResolvedStats` has no
field for the recoil pattern, sway, flinch, bloom decay, the damage curve or the
shell-reload timings, all of which the loadout can now modify.

## 4. Trust boundary

`validateLoadout(input, ctx)` treats its argument as hostile: it is `unknown`,
not `Loadout`. It rejects over-limit attachment counts, unknown or non-mountable
ids, duplicate slots, locked content below the player's rank, conflicting perks
and duplicated perk rows, over-budget killstreaks, and names carrying control
characters or markup. The harness fires 24 hostile payloads at it; every one
produces a runnable loadout rather than a crash or an illegal gun.

`repairLoadout` is the same pass without the complaints — the client-side call,
so the armoury silently drops a part you just lost access to.

## 5. Authority

Built host-authoritative from day one. `LoadoutAuthority` is the narrow
interface the netcode layer must satisfy:

```ts
interface LoadoutAuthority {
  readonly isHost: boolean;
  request(playerId: number, loadout: Loadout): Promise<LoadoutGrant>;
  onGrant(fn: (grant: LoadoutGrant) => void): () => void;
}
```

Clients **request**; the host **decides** and broadcasts a `LoadoutGrant`
carrying the validated loadout plus the errors it corrected. `LocalAuthority`
implements it in-process for offline and listen-host play. A remote
implementation belongs in `src/net/` and is not written here.

A grant does not take effect mid-life: `LoadoutService.notifySpawn(playerId)`
promotes the pending loadout at respawn, which is why changing class in the
middle of a firefight does not change the gun in your hands.

## 6. Tuning

Balance is data. `data/balance.ts` (stat rules, rails, limits),
`data/attachments.ts`, `data/perks.ts`, `data/equipment.ts`, `data/weapons.ts`
(unlock ranks), `data/presets.ts`. `applyTuningPatch(json)` applies a sparse
override to all of them at boot and returns a note per change, so a balance pass
is a JSON blob rather than a rebuild. Unknown ids are ignored.

`auditAttachments()` proves the no-free-lunch rule over the whole table: every
non-baseline attachment must pay for its upside with a stat moving the wrong way
or a genuine drawback flag. The harness fails if any attachment is free, and a
separate pass fails if any attachment strictly dominates another.

## 7. What the UI should show

This module owns no pixels. `statBars(eff)` returns six normalised 0..1 bars
(`damage accuracy range fireRate mobility control`) scaled across the whole
armoury, not per weapon, so a pistol genuinely reads short-ranged next to an
LMG — the shape `src/ui/menus/LoadoutMenu.ts` already draws. Alongside it the
armoury should read `AttachmentEntry.pros` / `.cons` / `.description` for the
tooltip, `ModifierStack.fold(stat, base).contributions` for per-source
attribution ("−18 % recoil from the Compensator"), `eff.capped` to grey out a
part that is doing nothing, and `describeErrors()` for rejection text.
