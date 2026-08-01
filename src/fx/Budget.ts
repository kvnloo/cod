/**
 * Frame-time budget governor.
 *
 * A quality preset is a guess about a machine. This is the correction: it
 * watches what frames actually cost and walks a fixed, ordered ladder of
 * concessions until the frame time the player *feels* fits the budget the
 * preset promised.
 *
 * ## Why it controls p90 and not the mean
 *
 * The complaint that produced this file was "very unplayable and not smooth …
 * fps was really bad". At the time, `ultra` at 1080p on an RTX 3080 Ti measured
 * a 15.4 ms median — a perfectly respectable 65 fps — and a 39.9 ms p99. The
 * median was never the problem. Smoothness is a property of the tail, so the
 * governor holds a high percentile and ignores the mean entirely.
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
 * Index of the first rung that reallocates GPU memory. See `REALLOC` below.
 */
const FIRST_REALLOC_RUNG = 8;

/**
 * The ladder, cheapest concession first.
 *
 * Rung 0 is the preset untouched. Each later rung is applied *in addition to*
 * all the ones before it, so the dial is a single monotonic number and the
 * result is a pure function of (preset, dial) — no drift, no accumulated state.
 *
 * ## Rungs 1–7 are allocation-free, and that is the load-bearing property
 *
 * The first version of this ladder led with `renderScale`, the way a settings
 * menu does. It made things worse, measurably: `high` at 1080p went to a
 * 90.7 ms p99 with 22 frames over 50 ms in a 12 s window. Changing the render
 * scale resizes the G-buffer, the scratch pool and every post-pass target, and
 * each of those reallocations is a multi-millisecond stall — so a governor
 * chasing a smooth frame time was *manufacturing* the exact spikes it existed
 * to remove.
 *
 * It was also buying almost nothing. Measured on the reference machine,
 * `renderScale` 1.0 → 0.75 moved GPU time 9.92 → 6.42 ms and the frame time by
 * 0.30 ms, because the frame is bound on draw submission, not on pixels.
 * Resolution is a GPU lever, and this frame does not have a GPU problem.
 *
 * So every rung up to 7 changes only uniforms, booleans and update rates —
 * things that take effect on the next frame at zero cost. Rungs 8 and 9 do
 * reallocate, and they are last precisely because a machine that needs them is
 * one where a single one-off hitch is a good trade for a permanently cheaper
 * frame.
 */
const LADDER: Rung[] = [
  { name: 'full', apply: () => { /* the preset, as authored */ } },

  // 1 — shadow atlas cadence. Largest saving per unit of visual harm by a wide
  // margin: static world shadows are bit-identical, only moving casters lag.
  { name: 'shadows-40hz', apply: (g) => { g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 40); } },

  // 2 — metering cadence and the depth-of-field pass. Eye adaptation is a ~1 s
  // exponential; DoF in a first-person shooter is an ADS affectation.
  {
    name: 'meter-20hz+dof-off',
    apply: (g) => { g.exposureUpdateHz = slowTo(g.exposureUpdateHz, 20); g.dof = false; },
  },

  // 3 — shadows to 30 Hz, contact shadows out. Contact shadows are a per-pixel
  // ray march in every opaque shader, and they are the reason the depth prepass
  // has to exist at all.
  {
    name: 'shadows-30hz+contact-off',
    apply: (g) => { g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 30); g.contactShadows = false; },
  },

  // 4 — the far half of the shadow range, and motion blur. The longest shadows
  // in the level are also the least legible ones.
  {
    name: 'shadow-dist-75%+motionblur-off',
    apply: (g, b) => { g.shadowDistance = b.shadowDistance * 0.75; g.motionBlur = false; },
  },

  // 5 — screen-space reflections. A full-screen ray march for an effect that
  // reads as "wet floor" and nothing else.
  { name: 'ssr-off', apply: (g) => { g.ssr = false; } },

  // 6 — volumetrics out, shadows to 24 Hz.
  {
    name: 'volumetrics-off+shadows-24hz',
    apply: (g) => { g.volumetrics = false; g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 24); },
  },

  // 7 — the last allocation-free rung: ambient occlusion, a shorter TAA
  // sequence, half the shadow range, and shadows at 20 Hz.
  {
    name: 'ssao-off+shadows-20hz',
    apply: (g, b) => {
      g.ssao = false;
      g.taaSamples = Math.min(b.taaSamples, 8);
      g.shadowUpdateHz = slowTo(g.shadowUpdateHz, 20);
      g.shadowDistance = b.shadowDistance * 0.55;
      g.lensDirt = 0;
    },
  },

  // 8 — first rung that reallocates. One cascade out, 85% render scale, half
  // the particle budget. Costs a one-time stall to buy a permanently cheaper
  // frame; only worth it on a machine that could not be saved above.
  {
    name: 'REALLOC cascades-1+scale-85%',
    apply: (g, b) => {
      g.shadowCascades = Math.max(2, b.shadowCascades - 1);
      g.renderScale = b.renderScale * 0.85;
      g.maxParticles = Math.round(b.maxParticles * 0.5);
    },
  },

  // 9 — the floor. Still lit, still shadowed, still playable.
  {
    name: 'REALLOC scale-70%+minimum',
    apply: (g, b) => {
      g.shadowCascades = 2;
      g.renderScale = b.renderScale * 0.7;
      g.shadowMapSize = Math.max(512, Math.round(b.shadowMapSize / 2));
      g.maxDecals = Math.round(b.maxDecals * 0.35);
      g.maxParticles = Math.round(b.maxParticles * 0.3);
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
 */
const SPIKE_MS = 80;

export interface BudgetTelemetry {
  enabled: boolean;
  dial: number;
  rung: string;
  p90Ms: number;
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
    if (this.filled < WINDOW || this.sinceEval < 0.25) return;
    this.sinceEval = 0;

    this.p90 = this.percentile(0.90);
    const target = this.targetMs;

    if (this.p90 > target * 1.06) {
      this.overFor += 0.25;
      this.underFor = 0;
    } else if (this.p90 < target * 0.78) {
      this.underFor += 0.25;
      this.overFor = 0;
    } else {
      this.overFor = 0;
      this.underFor = 0;
    }

    // Down fast, up slow. A wrong downshift costs a little image quality for a
    // few seconds; a wrong upshift costs the player a stutter, which is the
    // exact thing being fixed.
    const next = this.dial + 1;
    // Crossing into the reallocating rungs costs a one-off stall, so it needs
    // more evidence than a free rung does — otherwise a two-second dip in a
    // firefight buys a hitch and a permanent resolution drop.
    const downDwell = next >= FIRST_REALLOC_RUNG ? 3.0 : 0.5;

    if (this.overFor >= downDwell && this.dial < LADDER.length - 1) {
      // One rung is roughly a 10–15% saving, so a machine at three times budget
      // would need most of a minute to arrive if it could only step once at a
      // time. Take rungs proportional to how far out it is, then converge —
      // but never skip *into* the reallocating rungs on a single verdict.
      const over = this.p90 / target;
      const jump = over > 2.5 ? 3 : over > 1.6 ? 2 : 1;
      // A multi-rung jump must stop at the last allocation-free rung. Entering
      // the reallocating ones is always its own decision, taken with its own
      // (much longer) dwell above — otherwise a jump from rung 5 would land on
      // rung 8 with half a second of evidence and reallocate every target.
      const capped = this.dial < FIRST_REALLOC_RUNG
        ? Math.min(FIRST_REALLOC_RUNG - 1, this.dial + jump)
        : this.dial + jump;
      this.dial = Math.min(LADDER.length - 1, Math.max(this.dial + 1, capped));
      this.downshifts++;
      this.commit();
    } else if (this.underFor >= 4.0 && this.dial > 0) {
      // Symmetric to the downshift jump, and needed for the same reason: a
      // machine sitting at a third of its budget should not spend twenty
      // seconds climbing back one rung at a time from a dip it has long left
      // behind. Still slower than the way down — an upshift that turns out to
      // be wrong costs a stutter.
      const under = this.p90 / target;
      const jump = under < 0.40 ? 3 : under < 0.60 ? 2 : 1;
      this.dial = Math.max(0, this.dial - jump);
      this.upshifts++;
      this.commit();
    }
  }

  /** Forces a dial position. Used by tools and by the settings menu's "reset". */
  setDial(dial: number): void {
    this.dial = Math.max(0, Math.min(LADDER.length - 1, Math.round(dial)));
    this.commit();
  }

  /** Rebuilds `settings.gfx` from the preset base plus rungs `1..dial`. */
  private commit(): void {
    const g = { ...this.base };
    for (let i = 1; i <= this.dial; i++) LADDER[i].apply(g, this.base);
    // Mutated in place, never replaced: `__RENDER__.gfx`, `PassContext.settings`
    // and the settings menu all hold a reference to this object.
    Object.assign(settings.gfx, g);
    this.filled = 0;
    this.cursor = 0;
    this.overFor = 0;
    this.underFor = 0;
    this.settle = 0.75;
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
