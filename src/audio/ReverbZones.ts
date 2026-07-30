/**
 * Reverb zones and the convolution rack.
 *
 * The level publishes boxes tagged with an impulse response. As the listener
 * moves, zone weights are recomputed from a feathered signed distance to each
 * box, the top few are kept, and their convolver gains are crossfaded. Walking
 * out of a stairwell into a street therefore *slides* between the two spaces
 * over a few tenths of a second rather than snapping.
 *
 * On the `low` preset convolution is replaced wholesale by a Schroeder
 * comb/allpass network whose decay and damping are driven from the same zone
 * spec. It is a fraction of the cost and still sells the space change.
 */

import { clamp, clamp01, gainNode, filterNode, delayNode, comb, allpass, lerp } from './Dsp';
import { IMPULSE_SPECS, buildImpulse } from './Impulses';
import type { ImpulseId, ReverbZoneDesc } from './types';
import type { Mixer } from './Mixer';

const MAX_ACTIVE = 3;
const CROSSFADE = 0.22;

interface Slot {
  id: ImpulseId;
  gain: GainNode;
  node: AudioNode;
  weight: number;
}

/* -------------------------------------------------- algorithmic fallback -- */

class AlgoReverb {
  readonly input: GainNode;
  readonly output: GainNode;
  private combs: ReturnType<typeof comb>[] = [];
  private preDelay: DelayNode;
  private tone: BiquadFilterNode;

  constructor(private ctx: BaseAudioContext) {
    this.input = gainNode(ctx, 1);
    // Six parallel combs summing into three allpasses has substantial raw gain;
    // the convolution path is energy-normalised, so this has to be trimmed to
    // match or the `low` preset is drowned in reverb.
    this.output = gainNode(ctx, 0.22);
    this.preDelay = delayNode(ctx, 0.012, 0.12);
    this.tone = filterNode(ctx, 'lowpass', 6000, 0.7);

    this.input.connect(this.preDelay);
    // Mutually prime comb lengths avoid a metallic pitched response.
    const times = [0.0297, 0.0371, 0.0411, 0.0437, 0.0501, 0.0563];
    for (const t of times) {
      const c = comb(ctx, t, 0.78, 5200);
      this.preDelay.connect(c.input);
      c.output.connect(this.tone);
      this.combs.push(c);
    }
    const a1 = allpass(ctx, 0.0051, 0.7);
    const a2 = allpass(ctx, 0.0117, 0.7);
    const a3 = allpass(ctx, 0.0231, 0.62);
    this.tone.connect(a1.input);
    a1.output.connect(a2.input);
    a2.output.connect(a3.input);
    a3.output.connect(this.output);
  }

  configure(id: ImpulseId): void {
    const spec = IMPULSE_SPECS[id];
    const t = this.ctx.currentTime;
    this.preDelay.delayTime.setTargetAtTime(clamp(spec.predelay, 0.001, 0.1), t, 0.1);
    this.tone.frequency.setTargetAtTime(clamp(spec.tone, 400, 16000), t, 0.15);
    for (const c of this.combs) {
      const d = c.delay.delayTime.value;
      // feedback for the desired RT60 at this delay length
      const fb = Math.pow(10, (-3 * d) / Math.max(0.08, spec.rt60));
      c.feedback.gain.setTargetAtTime(clamp(fb, 0, 0.965), t, 0.15);
      c.damping.frequency.setTargetAtTime(clamp(spec.tone * 0.8, 350, 15000), t, 0.15);
    }
  }
}

/* ---------------------------------------------------------------- rack -- */

export interface ReverbRackOptions {
  /** Skip convolution; use the algorithmic network. */
  cheap?: boolean;
  /** Impulse length scale, 1 normally, 0.5 on constrained presets. */
  lengthScale?: number;
  densityScale?: number;
}

export class ReverbRack {
  /** Voices connect their reverb send here. */
  readonly send: GainNode;

  private ctx: BaseAudioContext;
  private mixer: Mixer;
  private slots = new Map<ImpulseId, Slot>();
  private zones: ReverbZoneDesc[] = [];
  private fallback: ImpulseId = 'openField';
  private returnGain: GainNode;
  private algo: AlgoReverb | null = null;
  private opts: ReverbRackOptions;
  private weights: Array<{ id: ImpulseId; w: number }> = [];

  /** Blended values other systems read to size weapon tails. */
  activeIr: ImpulseId = 'openField';
  activeRt60 = 1.0;
  activeWet = 0.3;
  activeZoneId = 'default';

  private lastListener = { x: 0, y: 0, z: 0 };
  private repathAccum = 0;

  constructor(ctx: BaseAudioContext, mixer: Mixer, opts: ReverbRackOptions = {}) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.opts = opts;
    this.send = gainNode(ctx, 1);
    this.returnGain = gainNode(ctx, 0.9);
    this.returnGain.connect(mixer.bus('reverb'));

    if (opts.cheap) {
      this.algo = new AlgoReverb(ctx);
      this.send.connect(this.algo.input);
      this.algo.output.connect(this.returnGain);
      this.algo.configure(this.fallback);
    } else {
      this.ensureSlot(this.fallback).gain.gain.value = 1;
    }
  }

  /** Number of convolvers currently instantiated (debug/stat surface). */
  get loaded(): number { return this.slots.size; }

  private ensureSlot(id: ImpulseId): Slot {
    const hit = this.slots.get(id);
    if (hit) return hit;
    const conv = this.ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = buildImpulse(this.ctx, id, {
      lengthScale: this.opts.lengthScale ?? 1,
      densityScale: this.opts.densityScale ?? 1,
    });
    const g = gainNode(this.ctx, 0);
    this.send.connect(conv);
    conv.connect(g);
    g.connect(this.returnGain);
    const slot: Slot = { id, gain: g, node: conv, weight: 0 };
    this.slots.set(id, slot);
    return slot;
  }

  setZones(zones: ReverbZoneDesc[], fallback: ImpulseId = 'openField'): void {
    this.zones = zones.slice();
    this.fallback = fallback;
    if (!this.opts.cheap) {
      this.ensureSlot(fallback);
      for (const z of zones) this.ensureSlot(z.ir);
    }
    this.repathAccum = 1e3; // force an immediate recompute
  }

  /**
   * Feathered membership of a point in a zone box. Inside the box the weight
   * eases up from 0.55 at the wall to 1 one feather-length in, so stepping
   * through a doorway blends rather than snaps.
   */
  private zoneWeight(z: ReverbZoneDesc, x: number, y: number, zz: number): number {
    const dx = Math.abs(x - z.center[0]) - z.half[0];
    const dy = Math.abs(y - z.center[1]) - z.half[1];
    const dz = Math.abs(zz - z.center[2]) - z.half[2];
    const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
    const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
    const feather = Math.max(0.25, z.feather ?? 2.5);
    if (outside <= 0) {
      // Inside: full weight, but ease off near the boundary so leaving is smooth.
      const inset = Math.min(-dx, Math.min(-dy, -dz));
      return clamp01(0.55 + 0.45 * clamp01(inset / feather)) * (1 + (z.priority ?? 0) * 0.25);
    }
    if (outside >= feather) return 0;
    return clamp01(1 - outside / feather) * 0.55 * (1 + (z.priority ?? 0) * 0.25);
  }

  zoneAt(x: number, y: number, z: number): string {
    let best = 'default';
    let bestW = 0;
    for (const zone of this.zones) {
      const w = this.zoneWeight(zone, x, y, z);
      if (w > bestW) { bestW = w; best = zone.id; }
    }
    return best;
  }

  /** Recomputes crossfades. Cheap; call every frame. */
  update(dt: number, lx: number, ly: number, lz: number): void {
    const moved = Math.abs(lx - this.lastListener.x) + Math.abs(ly - this.lastListener.y)
      + Math.abs(lz - this.lastListener.z);
    this.repathAccum += dt + moved;
    if (this.repathAccum < 0.1) return;
    this.repathAccum = 0;
    this.lastListener.x = lx; this.lastListener.y = ly; this.lastListener.z = lz;

    this.weights.length = 0;
    let total = 0;
    let bestZone = 'default';
    let bestW = 0;
    for (const z of this.zones) {
      const w = this.zoneWeight(z, lx, ly, lz);
      if (w <= 0.001) continue;
      total += w;
      const existing = this.weights.find((e) => e.id === z.ir);
      if (existing) existing.w += w; else this.weights.push({ id: z.ir, w });
      if (w > bestW) { bestW = w; bestZone = z.id; }
    }
    // Whatever weight is unaccounted for belongs to the level's open default.
    const outside = clamp01(1 - total);
    if (outside > 0.001) {
      const existing = this.weights.find((e) => e.id === this.fallback);
      if (existing) existing.w += outside;
      else this.weights.push({ id: this.fallback, w: outside });
      total += outside;
    }
    if (total <= 0) { this.weights.push({ id: this.fallback, w: 1 }); total = 1; }

    this.weights.sort((a, b) => b.w - a.w);
    if (this.weights.length > MAX_ACTIVE) this.weights.length = MAX_ACTIVE;
    let sum = 0;
    for (const e of this.weights) sum += e.w;
    const inv = sum > 0 ? 1 / sum : 1;

    // Blended descriptive values for weapon tails and debug.
    let rt = 0, wet = 0;
    for (const e of this.weights) {
      const spec = IMPULSE_SPECS[e.id];
      const w = e.w * inv;
      rt += spec.rt60 * w;
      wet += spec.wet * w;
    }
    this.activeIr = this.weights[0].id;
    this.activeRt60 = rt;
    this.activeWet = wet;
    this.activeZoneId = bestZone;

    const t = this.ctx.currentTime;
    if (this.algo) {
      this.algo.configure(this.activeIr);
      this.returnGain.gain.setTargetAtTime(wet * 1.1, t, CROSSFADE);
      return;
    }

    for (const slot of this.slots.values()) slot.weight = 0;
    for (const e of this.weights) {
      const slot = this.ensureSlot(e.id);
      slot.weight = e.w * inv;
    }
    for (const slot of this.slots.values()) {
      // Equal-power crossfade keeps the tail level constant through a blend.
      const g = Math.sqrt(slot.weight);
      slot.gain.gain.setTargetAtTime(g, t, CROSSFADE);
    }
    this.returnGain.gain.setTargetAtTime(clamp(wet * 1.35, 0.05, 1.6), t, CROSSFADE);
  }

  /** Per-shot tail length hint, seconds. */
  tailSeconds(distance: number): number {
    return clamp(this.activeRt60 * lerp(0.8, 1.9, clamp01(distance / 180)), 0.18, 4.2);
  }

  dispose(): void {
    try { this.send.disconnect(); } catch { /* closed */ }
    try { this.returnGain.disconnect(); } catch { /* closed */ }
    this.slots.clear();
  }
}
