/**
 * Mixing bus architecture.
 *
 * ```
 *  voices ─┬─ weapon ────┐
 *          ├─ impact ────┤
 *          ├─ explosion ─┤        each bus: comp → duck → level
 *          ├─ foley ─────┤
 *          ├─ voice ─────┼─→ preMaster ─→ deafFilter ─→ deafGain ─┐
 *          ├─ ambience ──┤                                        │
 *          ├─ music ─────┤    tinnitus/heartbeat ─────────────────┤
 *          └─ ui ────────┘                                        │
 *                                                                 ▼
 *   reverb sends ─→ [convolvers] ─→ reverb bus ────────→  multiband ─→ limiter
 *                                                             ─→ safety clip ─→ out
 * ```
 *
 * Two behaviours are worth calling out because they are what make a game mix
 * sound "big" rather than just loud:
 *
 * **HDR ducking.** A close explosion or a rifle next to your ear does not just
 * play louder — it *suppresses everything else* for a few hundred milliseconds.
 * `duck()` schedules a fast attack / slow release on every bus except the one
 * that caused it, weighted per bus so ambience collapses hard while weapon fire
 * barely moves.
 *
 * **Deafness bus.** After a flashbang or a near miss the whole mix (except the
 * tinnitus tone and heartbeat, which are injected after the filter) is dragged
 * through a lowpass and pulled down. Recovery is a slow, non-linear ramp.
 */

import { settings } from '../core/Settings';
import type { BusName } from './types';
import {
  clamp, clamp01, dbToGain, filterNode, gainNode, limitCurve,
  multibandCompressor, shaperNode, compressor,
} from './Dsp';

interface BusStrip {
  name: BusName;
  input: GainNode;
  duck: GainNode;
  level: GainNode;
  /** 0..1 — how strongly this bus responds to a duck request. */
  duckWeight: number;
  /** Which settings volume multiplies this bus. */
  volumeKind: 'sfx' | 'music' | 'ui';
  /** Author-set trim in dB. */
  trimDb: number;
  /** Runtime multiplier from AudioAPI.setBusVolume. */
  userGain: number;
}

const BUS_CONFIG: Array<{
  name: BusName; duckWeight: number; volumeKind: BusStrip['volumeKind']; trimDb: number;
  comp?: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number };
}> = [
    {
      name: 'weapon', duckWeight: 0.18, volumeKind: 'sfx', trimDb: -1.0,
      comp: { threshold: -14, ratio: 3.2, attack: 0.0018, release: 0.09, knee: 4, makeup: 1.5 },
    },
    {
      name: 'impact', duckWeight: 0.55, volumeKind: 'sfx', trimDb: -4.0,
      comp: { threshold: -20, ratio: 3.0, attack: 0.002, release: 0.11, knee: 6, makeup: 1.55 },
    },
    {
      name: 'explosion', duckWeight: 0.0, volumeKind: 'sfx', trimDb: 0.5,
      comp: { threshold: -10, ratio: 2.4, attack: 0.006, release: 0.28, knee: 8, makeup: 1.25 },
    },
    {
      name: 'foley', duckWeight: 0.8, volumeKind: 'sfx', trimDb: -7.5,
      comp: { threshold: -24, ratio: 3.6, attack: 0.006, release: 0.16, knee: 8, makeup: 1.9 },
    },
    {
      name: 'voice', duckWeight: 0.35, volumeKind: 'sfx', trimDb: -3.0,
      comp: { threshold: -22, ratio: 4.5, attack: 0.004, release: 0.2, knee: 10, makeup: 2.0 },
    },
    { name: 'ambience', duckWeight: 0.95, volumeKind: 'sfx', trimDb: -12.0 },
    { name: 'music', duckWeight: 0.7, volumeKind: 'music', trimDb: -8.0 },
    { name: 'ui', duckWeight: 0.15, volumeKind: 'ui', trimDb: -8.0 },
    {
      name: 'reverb', duckWeight: 0.5, volumeKind: 'sfx', trimDb: -4.5,
      comp: { threshold: -22, ratio: 2.4, attack: 0.02, release: 0.35, knee: 10, makeup: 1.3 },
    },
  ];

export interface DuckRequest {
  /** Depth in dB (positive number, e.g. 14 means −14 dB at full weight). */
  depthDb: number;
  attack: number;
  hold: number;
  release: number;
  /** Bus that caused it — exempt from the duck. */
  source?: BusName;
}

export class Mixer {
  readonly ctx: BaseAudioContext;
  readonly out: AudioNode;

  private strips = new Map<BusName, BusStrip>();
  private preMaster: GainNode;
  private deafFilter: BiquadFilterNode;
  private deafGain: GainNode;
  private postDeaf: GainNode;
  private master: GainNode;
  /** Injection point that bypasses the deafness filter (tinnitus, heartbeat). */
  readonly bypass: GainNode;

  /** 0..1 — current hearing damage. */
  private deafness = 0;
  private deafTarget = 0;
  /** Seconds of full deafness left before recovery begins. */
  private deafHold = 0;

  private duckUntil = 0;
  private lowQuality: boolean;

  constructor(ctx: BaseAudioContext, destination: AudioNode, lowQuality = false) {
    this.ctx = ctx;
    this.lowQuality = lowQuality;

    this.master = gainNode(ctx, 1);
    const safety = shaperNode(ctx, limitCurve(), lowQuality ? 'none' : '2x');

    // Final limiter: fast, transparent until it is genuinely needed.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3.5;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.0015;
    lim.release.value = 0.09;

    // Master multi-band glue. Skipped entirely on `low`: four extra biquads and
    // three compressors per frame is not free on an integrated GPU laptop.
    let headIn: AudioNode;
    let headOut: AudioNode;
    if (lowQuality) {
      const g = gainNode(ctx, 1);
      headIn = g; headOut = g;
    } else {
      const mb = multibandCompressor(ctx, [
        { hi: 170, comp: { threshold: -16, ratio: 2.6, attack: 0.012, release: 0.24, knee: 8, makeup: 1.2 } },
        { hi: 2600, comp: { threshold: -18, ratio: 2.2, attack: 0.005, release: 0.16, knee: 10, makeup: 1.15 } },
        { hi: Infinity, comp: { threshold: -20, ratio: 2.8, attack: 0.002, release: 0.1, knee: 8, makeup: 1.2 } },
      ]);
      headIn = mb.input; headOut = mb.output;
    }

    headOut.connect(lim);
    lim.connect(safety);
    safety.connect(this.master);
    this.master.connect(destination);
    this.out = destination;

    this.postDeaf = gainNode(ctx, 1);
    this.postDeaf.connect(headIn);

    this.bypass = gainNode(ctx, 1);
    this.bypass.connect(this.postDeaf);

    this.deafGain = gainNode(ctx, 1);
    this.deafGain.connect(this.postDeaf);

    this.deafFilter = filterNode(ctx, 'lowpass', 20000, 0.7);
    this.deafFilter.connect(this.deafGain);

    this.preMaster = gainNode(ctx, 1);
    this.preMaster.connect(this.deafFilter);

    for (const cfg of BUS_CONFIG) {
      const input = gainNode(ctx, 1);
      const duck = gainNode(ctx, 1);
      const level = gainNode(ctx, dbToGain(cfg.trimDb));
      let head: AudioNode = input;
      if (cfg.comp && !lowQuality) {
        const c = compressor(ctx, cfg.comp);
        head.connect(c.input);
        head = c.output;
      }
      head.connect(duck);
      duck.connect(level);
      level.connect(this.preMaster);
      this.strips.set(cfg.name, {
        name: cfg.name, input, duck, level,
        duckWeight: cfg.duckWeight, volumeKind: cfg.volumeKind,
        trimDb: cfg.trimDb, userGain: 1,
      });
    }

    this.applySettings();
  }

  /** Where voices of a given category connect. */
  bus(name: BusName): GainNode {
    const s = this.strips.get(name);
    if (s) return s.input;
    return this.strips.get('foley')!.input;
  }

  get masterNode(): GainNode { return this.master; }
  get deafnessAmount(): number { return this.deafness; }

  /* ------------------------------------------------------------ volumes -- */

  setBusVolume(name: BusName, v: number): void {
    const s = this.strips.get(name);
    if (!s) return;
    s.userGain = clamp(v, 0, 4);
    this.applySettings();
  }

  /** Re-reads `settings.game.*Volume` and pushes the trims. */
  applySettings(): void {
    const g = settings.game;
    const t = this.ctx.currentTime;
    for (const s of this.strips.values()) {
      const kind = s.volumeKind === 'music' ? g.musicVolume
        : s.volumeKind === 'ui' ? g.sfxVolume
          : g.sfxVolume;
      const target = dbToGain(s.trimDb) * clamp01(kind) * s.userGain;
      s.level.gain.setTargetAtTime(target, t, 0.02);
    }
    this.master.gain.setTargetAtTime(clamp01(g.masterVolume), t, 0.02);
  }

  /* ------------------------------------------------------------ ducking -- */

  /**
   * HDR-style priority duck. Repeated requests take the deeper of the two, and
   * the release is always the longer one, so a burst of explosions holds the
   * mix down instead of stuttering it.
   */
  duck(req: DuckRequest): void {
    const now = this.ctx.currentTime;
    const attack = Math.max(0.005, req.attack);
    const end = now + attack + req.hold + req.release;
    if (end < this.duckUntil && req.depthDb < 6) return;
    this.duckUntil = Math.max(this.duckUntil, end);

    for (const s of this.strips.values()) {
      if (s.name === req.source) continue;
      const w = s.duckWeight;
      if (w <= 0) continue;
      const target = dbToGain(-req.depthDb * w);
      if (target > 0.985) continue;
      const p = s.duck.gain;
      const current = clamp(p.value, 0.0001, 1);
      p.cancelScheduledValues(now);
      p.setValueAtTime(current, now);
      p.linearRampToValueAtTime(Math.min(current, target), now + attack);
      p.setValueAtTime(Math.min(current, target), now + attack + req.hold);
      p.setTargetAtTime(1, now + attack + req.hold, Math.max(0.02, req.release * 0.34));
      p.setValueAtTime(1, now + attack + req.hold + req.release + 0.25);
    }
  }

  /* ---------------------------------------------------------- deafness -- */

  /**
   * Applies hearing damage. `amount` 0..1; a flashbang at your feet is 1, a
   * grenade 8 m away is around 0.35. Never reduces existing damage.
   */
  addDeafness(amount: number, holdSeconds: number): void {
    this.deafTarget = clamp01(Math.max(this.deafTarget, amount));
    this.deafHold = Math.max(this.deafHold, holdSeconds);
    // Snap most of the way instantly — the ear closes fast.
    this.deafness = Math.max(this.deafness, this.deafTarget * 0.92);
    this.pushDeafness(0.012);
  }

  clearDeafness(): void {
    this.deafTarget = 0;
    this.deafHold = 0;
    this.deafness = 0;
    this.pushDeafness(0.25);
  }

  /** Called from the audio system's update. */
  tickDeafness(dt: number): void {
    if (this.deafness <= 0.0005 && this.deafTarget <= 0) return;
    if (this.deafHold > 0) {
      this.deafHold -= dt;
    } else {
      // Non-linear recovery: fast at first, then a long tail of muffled hearing.
      const rate = 0.11 + this.deafness * 0.5;
      this.deafTarget = Math.max(0, this.deafTarget - rate * dt);
      this.deafness = Math.max(this.deafTarget, this.deafness - rate * dt);
      if (this.deafness < 0.004) { this.deafness = 0; this.deafTarget = 0; }
      this.pushDeafness(0.09);
    }
  }

  private pushDeafness(smooth: number): void {
    const t = this.ctx.currentTime;
    const d = clamp01(this.deafness);
    // 20 kHz clear → 380 Hz fully deafened, exponentially.
    const cutoff = 380 * Math.pow(20000 / 380, 1 - d);
    this.deafFilter.frequency.setTargetAtTime(cutoff, t, smooth);
    this.deafFilter.Q.setTargetAtTime(0.7 + d * 0.55, t, smooth);
    this.deafGain.gain.setTargetAtTime(dbToGain(-15 * d), t, smooth);
  }

  /* ------------------------------------------------------------- pause -- */

  setPaused(paused: boolean): void {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(
      paused ? clamp01(settings.game.masterVolume) * 0.25 : clamp01(settings.game.masterVolume),
      t, 0.08,
    );
  }

  dispose(): void {
    try { this.master.disconnect(); } catch { /* context already closed */ }
  }
}
