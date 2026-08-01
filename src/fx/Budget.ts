/**
 * Frame-time budget governor.
 *
 * A quality preset is a guess about a machine. This is the correction: it
 * watches what frames actually cost and walks a fixed, ordered ladder of
 * concessions until the frame time the player *feels* fits the budget the
 * preset promised.
 *
 * ## Why it controls the tail and not the mean
 *
 * The complaint that produced this file was "very unplayable and not smooth …
 * fps was really bad". At the time, `ultra` at 1080p on an RTX 3080 Ti measured
 * a 15.4 ms median — a perfectly respectable 65 fps — and a 39.9 ms p99. The
 * median was never the problem. Smoothness is a property of the tail, so the
 * governor holds a high percentile and ignores the mean entirely.
 *
 * Hard gates in the playtest harness are **p99** and **frames over 50 ms**. A
 * governor that only watched p90 could sit on a no-op rung while a single
 * rebuild hitch kept failing those gates. The signal below is therefore
 * `max(p90, p99)` so a tail the player feels is a tail the dial reacts to.
 *
 * ## Why the ladder is ordered the way it is
 *
 * From `tools/_g6-exp.mjs`, live mode, 1920x1080, RTX 3080 Ti, scripted
 * firefight, ultra preset (Δ against a 16.91 ms p50 baseline):
 *
 *   shadow atlas every 2nd frame     -1.98 ms   1728 → 1139 draw calls
 *   shadow atlas every 3rd frame     -4.11 ms   1728 →  908 draw calls
 *   shadowCascades 4 → 3             -1.65 ms   1728 → 1455 draw calls
 *   shadowCascades 4 → 2             -2.38 ms   1728 → 1238 draw calls
 *   shadows off entirely             -5.66 ms   1728 →  516 draw calls
 *
 * The shadow atlas is **70% of every draw call in the frame** and the largest
 * single cost in it. So every early rung of the ladder is a shadow rung, and
 * the post-processing knobs — the ones a settings menu usually leads with —
 * come last, because they were worth tenths of a millisecond each.
 *
 * ## Determinism
 *
 * The governor never runs in capture mode and never touches anything the fixed
 * step reads. It only writes `settings.gfx` presentation knobs. A capture run,
 * a replay and a network session all see the preset exactly as authored.
 */

import { bus } from '../core/EventBus';
import { PRESETS, settings, type GfxSettings, type QualityPreset } from '../core/Settings';

/** One rung. `apply` is cumulative on top of every rung below it. */
interface Rung {
  name: string;
  apply(g: GfxSettings, base: GfxSettings): void;
}

/** Lowers an update rate towards `hz`; 0 in the source means "every frame". */
function slowTo(current: number, hz: number): number {
  return current === 0 ? hz : Math.min(current, hz);
}

/**
 * Index of the first rung that reallocates the G-buffer / particle pools.
 * Atlas cascade cuts above this are cheaper one-off stalls; render-scale rungs
 * resize every target and are last.
 */
const FIRST_REALLOC_RUNG = 6;

/**
 * The ladder, cheapest concession first.
 *
 * Rung 0 is the preset untouched. Each later rung is applied *in addition to*
 * all the ones before it, so the dial is a single monotonic number and the
 * result is a pure function of (preset, dial) — no drift, no accumulated state.
 *
 * ## Rungs 1–5 are allocation-free, and that is load-bearing
 *
 * Changing `renderScale` resizes the G-buffer and every post target — multi-ms
 * stalls that manufacture the spikes this governor exists to remove. Measured:
 * `high` at 1080p went to a 90.7 ms p99 when scale led the ladder. So free rungs
 * only touch uniforms, booleans and update rates.
 *
 * ## Relative to the live preset
 *
 * `high` authors 2 cascades @ 1024, 24 Hz, contact/prepass off. An early
 * `shadows-40hz` or `contact-off` rung is therefore a no-op on high and must
 * not consume a dial step. Free rungs start below the authored base, and
 * `nextEffectiveDial` skips anything that does not change gfx.
 *
 * REALLOC rungs are last and require a long dwell: walking into them mid-
 * firefight was measured to *create* the over50 frames the gates forbid.
 */
const LADDER: Rung[] = [
  { name: 'full', apply: () => { /* the preset, as authored */ } },

  // 1 — atlas below high's 24 Hz + contact/prepass out (real on ultra with
  // adaptive; no-op-safe on high via nextEffectiveDial).
  {
    name: 'shadows-16hz+contact-off+prepass-off',
    apply: (g) => {
      g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 16);
      g.contactShadows = false;
      g.depthPrepass = false;
    },
  },

  // 2 — metering + DoF out.
  {
    name: 'meter-15hz+dof-off',
    apply: (g) => { g.exposureUpdateHz = slowTo(g.exposureUpdateHz, 15); g.dof = false; },
  },

  // 3 — far shadow range, motion blur, atlas 12 Hz.
  {
    name: 'shadow-dist-70%+motionblur-off+shadows-12hz',
    apply: (g, b) => {
      g.shadowDistance = b.shadowDistance * 0.7;
      g.motionBlur = false;
      g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 12);
    },
  },

  // 4 — SSR and SSAO out, atlas 10 Hz.
  {
    name: 'ssr-off+ssao-off+shadows-10hz',
    apply: (g) => {
      g.ssr = false;
      g.ssao = false;
      g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 10);
      g.lensDirt = 0;
    },
  },

  // 5 — last allocation-free rung: volumetrics out, shorter TAA, atlas 8 Hz.
  // Do NOT touch maxParticles/maxDecals here — those reallocate GPU pools and
  // were measured as the 50–80 ms hitch that kept frame-spikes red after p99
  // was already green.
  {
    name: 'volumetrics-off+taa-8+shadows-8hz',
    apply: (g, b) => {
      g.volumetrics = false;
      g.taaSamples = Math.min(b.taaSamples, 8);
      g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 8);
      g.shadowDistance = b.shadowDistance * 0.5;
      g.pcssSoftness = Math.min(g.pcssSoftness, 0.35);
    },
  },

  // 6 — first real reallocation (G-buffer + particle/decal pools). Long dwell.
  {
    name: 'REALLOC scale-85%+pools-50%',
    apply: (g, b) => {
      g.shadowCascades = 2;
      g.renderScale = b.renderScale * 0.85;
      g.maxParticles = Math.round(b.maxParticles * 0.5);
      g.maxDecals = Math.round(b.maxDecals * 0.5);
      g.shadowMapSize = Math.max(512, Math.min(g.shadowMapSize, 1024));
    },
  },

  // 7 — the floor.
  {
    name: 'REALLOC scale-70%+minimum',
    apply: (g, b) => {
      g.shadowCascades = 2;
      g.renderScale = b.renderScale * 0.7;
      g.shadowMapSize = Math.max(512, Math.round(b.shadowMapSize / 2));
      g.maxDecals = Math.round(b.maxDecals * 0.3);
      g.maxParticles = Math.round(b.maxParticles * 0.25);
      g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 6);
    },
  },
];

export const BUDGET_LADDER = LADDER.map((r) => r.name);

/** Frames sampled before the governor is allowed to act on the estimate. */
const WINDOW = 96;
/**
 * A frame this long is a load, a first-draw compile or a tab switch, not a
 * budget signal, and it is excluded from the estimate.
 *
 * 80 ms rather than something larger because of what the measurements actually
 * contain: a scripted 12 s firefight has exactly two frames over 50 ms, both
 * around 85 ms, both at a one-off resource upload. Letting those into a 96-frame
 * window is enough to push `low` — running at 2.4 ms, a third of its budget —
 * four rungs down the ladder and keep it there. Nothing the ladder can do would
 * have prevented either frame, so reacting to them only costs image quality.
 *
 * Frames in the 50–80 ms band (rebuild hitches, dial commits that force a full
 * atlas rebuild) are deliberately *kept*: hard gates are p99 and over50, and
 * those are exactly the frames the dial must close.
 */
const SPIKE_MS = 80;

/** Gfx keys the ladder mutates — compared to detect no-op rungs. */
const LADDER_KEYS: (keyof GfxSettings)[] = [
  'shadowUpdateHz', 'exposureUpdateHz', 'contactShadows', 'depthPrepass',
  'dof', 'motionBlur', 'shadowDistance', 'ssr', 'volumetrics', 'shadowCascades',
  'ssao', 'taaSamples', 'renderScale', 'maxParticles', 'lensDirt', 'shadowMapSize',
  'pcssSoftness',
  'maxDecals',
];

function gfxEqual(a: GfxSettings, b: GfxSettings): boolean {
  for (let i = 0; i < LADDER_KEYS.length; i++) {
    const k = LADDER_KEYS[i];
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export interface BudgetTelemetry {
  enabled: boolean;
  dial: number;
  rung: string;
  p90Ms: number;
  p99Ms: number;
  targetMs: number;
  samples: number;
  downshifts: number;
  upshifts: number;
  frozen: boolean;
}

export class FrameBudget {
  /** Off in capture mode; a governor that reacts to load is not reproducible. */
  enabled = true;
  /** Current rung index into `LADDER`. */
  dial = 0;

  private ring = new Float32Array(WINDOW);
  private cursor = 0;
  private filled = 0;
  private scratch = new Float32Array(WINDOW);
  private sinceEval = 0;
  private p90 = 0;
  private p99 = 0;

  /** Seconds the current verdict has held; the ladder only moves on conviction. */
  private overFor = 0;
  private underFor = 0;
  /** Blocks an immediate re-evaluation after a change, so the ring can refill. */
  private settle = 0;

  private base: GfxSettings;
  private basePreset: QualityPreset;
  private downshifts = 0;
  private upshifts = 0;
  private applyHook: (() => void) | null = null;

  constructor() {
    this.basePreset = settings.preset;
    this.base = { ...settings.gfx };
    bus.on('quality:changed', () => this.rebase());
    bus.on('settings:changed', (e) => {
      // The player moved a slider. Fold it into the base so the next dial move
      // does not silently undo it.
      const key = String((e as { key?: string })?.key ?? '');
      if (!key.startsWith('gfx.')) return;
      const k = key.slice(4) as keyof GfxSettings;
      if (k in this.base) (this.base as unknown as Record<string, unknown>)[k] = settings.gfx[k];
    });
  }

  /** Called by the renderer after it applies a new gfx state. */
  onApply(fn: () => void): void { this.applyHook = fn; }

  /** Re-reads the preset as the new ceiling and returns to rung 0. */
  rebase(): void {
    this.basePreset = settings.preset;
    this.base = { ...settings.gfx };
    this.dial = 0;
    this.filled = 0;
    this.cursor = 0;
    this.overFor = 0;
    this.underFor = 0;
    this.settle = 1.0;
  }

  get targetMs(): number {
    const t = settings.gfx.targetFrameMs;
    return Number.isFinite(t) && t > 0 ? t : 16.7;
  }

  /** Applies rungs `1..dial` onto a fresh copy of the base. */
  private applyRungs(dial: number): GfxSettings {
    const g = { ...this.base };
    const n = Math.max(0, Math.min(LADDER.length - 1, dial));
    for (let i = 1; i <= n; i++) LADDER[i].apply(g, this.base);
    return g;
  }

  /**
   * Next dial above `from` that actually changes gfx relative to `from`.
   * Returns `from` when nothing left on the ladder changes anything.
   */
  private nextEffectiveDial(from: number): number {
    const cur = this.applyRungs(from);
    for (let d = from + 1; d < LADDER.length; d++) {
      if (!gfxEqual(cur, this.applyRungs(d))) return d;
    }
    return from;
  }

  /**
   * Previous dial below `from` that actually changes gfx relative to `from`.
   * Used on upshift so restoring a no-op rung is free and skipped.
   */
  private prevEffectiveDial(from: number): number {
    const cur = this.applyRungs(from);
    for (let d = from - 1; d >= 0; d--) {
      if (!gfxEqual(cur, this.applyRungs(d))) return d;
    }
    return 0;
  }

  /**
   * Feeds one real frame interval, in seconds, and moves the dial if the
   * evidence has held long enough.
   *
   * `dtSeconds` must be the *unscaled* wall interval — slow-motion is a gameplay
   * effect and must not read as a performance problem.
   */
  update(dtSeconds: number): void {
    if (!this.enabled || !settings.gfx.adaptive) return;
    const ms = dtSeconds * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return;

    if (this.settle > 0) {
      this.settle -= dtSeconds;
      return;
    }
    // See SPIKE_MS: a frame this long is a one-off, and no rung would have
    // prevented it. Letting it into the window only costs image quality.
    if (ms > SPIKE_MS) return;

    this.ring[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;

    this.sinceEval += dtSeconds;
    // Evaluate often enough that a 12 s playtest is not stuck on a no-op dial
    // while p99 is already failing. Still need a minimum sample count.
    if (this.filled < Math.min(WINDOW, 48) || this.sinceEval < 0.15) return;
    this.sinceEval = 0;

    this.p90 = this.percentile(0.90);
    this.p99 = this.percentile(0.99);
    // Hard gates are p99 and over50. Holding only p90 left the dial on a no-op
    // while a rebuild hitch owned the p99 tail. max(p90, p99) makes that hitch
    // a budget signal without ignoring the bulk of the window.
    const signal = Math.max(this.p90, this.p99);
    const target = this.targetMs;
    // Any in-window frame over 50 ms is a hard-gate failure; weight it so the
    // dial cannot sit still while over50 > 0.
    let over50 = 0;
    for (let i = 0; i < this.filled; i++) if (this.ring[i] > 50) over50++;

    if (signal > target * 1.06 || over50 > 0) {
      this.overFor += 0.15;
      this.underFor = 0;
    } else if (signal < target * 0.78 && over50 === 0) {
      this.underFor += 0.15;
      this.overFor = 0;
    } else {
      this.overFor = 0;
      this.underFor = 0;
    }

    // Down fast, up slow. A wrong downshift costs a little image quality for a
    // few seconds; a wrong upshift costs the player a stutter, which is the
    // exact thing being fixed.
    const next = this.nextEffectiveDial(this.dial);
    // Crossing into the reallocating rungs costs a one-off stall, so it needs
    // more evidence than a free rung does — otherwise a two-second dip in a
    // firefight buys a hitch and a permanent resolution drop.
    // over50 failures are already hard-gate red; dwell shorter so they close.
    // REALLOC always needs a long dwell — even with over50 — because entering
    // it mid-firefight was measured to manufacture the over50 frames the
    // gates forbid (G-buffer resize stalls of 50–90 ms). Free rungs react
    // fast; resolution rungs do not.
    const downDwell = next >= FIRST_REALLOC_RUNG
      ? 4.0
      : over50 > 0 ? 0.2 : 0.35;

    if (this.overFor >= downDwell && next > this.dial) {
      // One effective rung is roughly a 10–15% saving. Take rungs proportional
      // to how far out it is, then converge — but never skip *into* the
      // reallocating rungs on a single verdict. over50 forces at least one
      // real concession immediately.
      const over = signal / target;
      const jump = over50 > 0 ? Math.max(1, over > 1.6 ? 2 : 1)
        : over > 2.5 ? 3 : over > 1.6 ? 2 : 1;

      let targetDial = this.dial;
      for (let s = 0; s < jump; s++) {
        const n = this.nextEffectiveDial(targetDial);
        if (n === targetDial) break;
        // A multi-rung jump must stop at the last allocation-free rung.
        if (targetDial < FIRST_REALLOC_RUNG && n >= FIRST_REALLOC_RUNG && s > 0) break;
        if (targetDial < FIRST_REALLOC_RUNG && n >= FIRST_REALLOC_RUNG && over50 === 0 && over <= 1.6) {
          // Enter realloc only with its own longer dwell (handled above).
          if (this.overFor < 2.5) break;
        }
        targetDial = n;
      }

      if (targetDial > this.dial) {
        this.dial = targetDial;
        this.downshifts++;
        this.commit();
      }
    } else if (this.underFor >= 4.0 && this.dial > 0) {
      const under = signal / target;
      const jump = under < 0.40 ? 3 : under < 0.60 ? 2 : 1;
      let targetDial = this.dial;
      for (let s = 0; s < jump; s++) {
        const p = this.prevEffectiveDial(targetDial);
        if (p === targetDial) break;
        targetDial = p;
      }
      if (targetDial < this.dial) {
        this.dial = targetDial;
        this.upshifts++;
        this.commit();
      }
    }
  }

  /** Forces a dial position. Used by tools and by the settings menu's "reset". */
  setDial(dial: number): void {
    this.dial = Math.max(0, Math.min(LADDER.length - 1, Math.round(dial)));
    this.commit();
  }

  /** Rebuilds `settings.gfx` from the preset base plus rungs `1..dial`. */
  private commit(): void {
    const g = this.applyRungs(this.dial);
    // Mutated in place, never replaced: `__RENDER__.gfx`, `PassContext.settings`
    // and the settings menu all hold a reference to this object.
    Object.assign(settings.gfx, g);
    this.filled = 0;
    this.cursor = 0;
    this.overFor = 0;
    this.underFor = 0;
    this.settle = 1.0;
    this.applyHook?.();
  }

  private percentile(p: number): number {
    const n = this.filled;
    const s = this.scratch.subarray(0, n);
    s.set(this.ring.subarray(0, n));
    s.sort();
    return s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  }

  telemetry(): BudgetTelemetry {
    return {
      enabled: this.enabled && settings.gfx.adaptive,
      dial: this.dial,
      rung: LADDER[this.dial]?.name ?? '?',
      p90Ms: +this.p90.toFixed(2),
      p99Ms: +this.p99.toFixed(2),
      targetMs: this.targetMs,
      samples: this.filled,
      downshifts: this.downshifts,
      upshifts: this.upshifts,
      frozen: this.settle > 0,
    };
  }

  /** The preset this governor is currently working down from. */
  get preset(): QualityPreset { return this.basePreset; }

  /** The untouched preset values, for anything that needs the authored ceiling. */
  get ceiling(): GfxSettings { return { ...(PRESETS[this.basePreset] ?? this.base) }; }
}
