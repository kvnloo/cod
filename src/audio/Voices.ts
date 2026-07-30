/**
 * Spatial voice pool.
 *
 * A "voice" is a pooled channel strip:
 *
 * ```
 *   head ─→ occlusion LP ─→ occlusion gain ─→ air LP ─┬─→ panner (HRTF) ─→ bus
 *                                                     └─→ send gain ─→ reverb rack
 * ```
 *
 * The head is allocated per shot and thrown away on release, which is what lets
 * the caller build an arbitrary one-shot synth graph without leaking nodes into
 * the pooled strip. Everything expensive — above all the HRTF panner — is
 * pooled and reused.
 *
 * Three physical behaviours are modelled here rather than in the sound
 * definitions, because they apply to *everything*:
 *
 * * **Air absorption** — a distance-driven lowpass, so a rifle 200 m away is
 *   all boom and no crack before its own synthesis even gets a say.
 * * **Occlusion / obstruction** — a raycast through the physics world darkens
 *   and attenuates the direct path. Partial obstruction actually *raises* the
 *   reverb send (sound diffracts around the obstacle), full occlusion drops it.
 * * **Distance-decoupled reverb** — the wet send falls off far more slowly than
 *   the dry path, which is the cue that tells you a shot came from outside.
 */

import { settings } from '../core/Settings';
import type { BusName, OcclusionProbe } from './types';
import type { Mixer } from './Mixer';
import type { ReverbRack } from './ReverbZones';
import {
  airAbsorptionHz, clamp, clamp01, dbToGain, filterNode, gainNode, lerp,
} from './Dsp';

export interface VoiceOptions {
  bus: BusName;
  /** World position; omit `spatial` for a head-locked 2D sound. */
  x?: number; y?: number; z?: number;
  spatial?: boolean;
  /** Linear gain applied by the strip head. */
  gain?: number;
  /** 0..1 reverb send before distance weighting. */
  send?: number;
  /** 0..1; low-priority voices are stolen first. */
  priority?: number;
  /** Pre-computed occlusion; when omitted the pool probes physics. */
  occlusion?: number;
  refDistance?: number;
  rolloff?: number;
  maxDistance?: number;
  /** Distance used for air absorption; defaults to the listener distance. */
  airDistance?: number;
  /** Keep re-evaluating position/occlusion until released (loops, movers). */
  track?: boolean;
  /** Stereo width for 2D voices, −1..1 pan. */
  pan?: number;
}

export interface Voice {
  readonly id: number;
  /** Connect the one-shot synth graph here. */
  readonly input: GainNode;
  readonly spatial: boolean;
  /** Occlusion the pool resolved for this voice, 0..1. */
  readonly occl: number;
  setPosition(x: number, y: number, z: number): void;
  setGain(v: number, ramp?: number): void;
  setOcclusion(v: number): void;
  /** Schedules reclamation; the head is disconnected at `time`. */
  releaseAt(time: number): void;
  /** Immediate stop with a short fade to avoid a click. */
  stop(fade?: number): void;
}

interface Strip {
  id: number;
  occl: BiquadFilterNode;
  occlGain: GainNode;
  air: BiquadFilterNode;
  panner: PannerNode | null;
  stereo: StereoPannerNode | null;
  send: GainNode;
  busName: BusName | null;
  busNode: GainNode | null;
}

interface Live extends Voice {
  strip: Strip;
  endsAt: number;
  priority: number;
  audibility: number;
  track: boolean;
  occl: number;
  send: number;
  px: number; py: number; pz: number;
  probeAt: number;
  released: boolean;
}

const VOICE_BUDGET: Record<string, number> = {
  low: 32, medium: 48, high: 64, ultra: 80, cinematic: 104,
};

export class VoicePool {
  readonly ctx: BaseAudioContext;
  readonly mixer: Mixer;
  private reverb: ReverbRack;
  private freeSpatial: Strip[] = [];
  private freeStereo: Strip[] = [];
  private live: Live[] = [];
  private nextId = 1;
  private hrtf: boolean;

  private lx = 0; private ly = 0; private lz = 0;
  private probe: OcclusionProbe | null = null;
  private probeCursor = 0;

  peak = 0;
  starved = 0;

  constructor(ctx: BaseAudioContext, mixer: Mixer, reverb: ReverbRack) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.reverb = reverb;
    this.hrtf = settings.preset !== 'low';
  }

  get budget(): number { return VOICE_BUDGET[settings.preset] ?? 48; }
  get activeCount(): number { return this.live.length; }

  /**
   * Voices still producing sound. A stolen or stopped voice lingers in the list
   * for its fade-out, and counting those against the budget would let the list
   * grow without bound whenever the audio clock advances more slowly than the
   * simulation — exactly what happens on the deterministic capture path.
   */
  get liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.live.length; i++) if (!this.live[i].released) n++;
    return n;
  }

  setOcclusionProbe(p: OcclusionProbe | null): void { this.probe = p; }

  /** Web Audio's listener. Orientation vectors must be unit length. */
  setListener(
    x: number, y: number, z: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
    smooth: number,
  ): void {
    this.lx = x; this.ly = y; this.lz = z;
    const l = this.ctx.listener as AudioListener & {
      positionX?: AudioParam; forwardX?: AudioParam; upX?: AudioParam;
    };
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, smooth);
      l.positionY!.setTargetAtTime(y, t, smooth);
      l.positionZ!.setTargetAtTime(z, t, smooth);
      l.forwardX!.setTargetAtTime(fx, t, smooth);
      l.forwardY!.setTargetAtTime(fy, t, smooth);
      l.forwardZ!.setTargetAtTime(fz, t, smooth);
      l.upX!.setTargetAtTime(ux, t, smooth);
      l.upY!.setTargetAtTime(uy, t, smooth);
      l.upZ!.setTargetAtTime(uz, t, smooth);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(x, y, z);
      legacy.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  listenerPosition(out: { x: number; y: number; z: number }): void {
    out.x = this.lx; out.y = this.ly; out.z = this.lz;
  }

  distanceTo(x: number, y: number, z: number): number {
    const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ---------------------------------------------------------- allocation -- */

  private makeStrip(spatial: boolean): Strip {
    const ctx = this.ctx;
    const occl = filterNode(ctx, 'lowpass', 21000, 0.62);
    const occlGain = gainNode(ctx, 1);
    const air = filterNode(ctx, 'lowpass', 21000, 0.55);
    occl.connect(occlGain);
    occlGain.connect(air);

    let panner: PannerNode | null = null;
    let stereo: StereoPannerNode | null = null;
    if (spatial) {
      panner = ctx.createPanner();
      panner.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.maxDistance = 900;
      panner.rolloffFactor = 1.05;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;
      air.connect(panner);
    } else {
      stereo = ctx.createStereoPanner();
      air.connect(stereo);
    }

    const send = gainNode(ctx, 0);
    air.connect(send);
    send.connect(this.reverb.send);

    return {
      id: this.nextId++, occl, occlGain, air, panner, stereo, send,
      busName: null, busNode: null,
    };
  }

  private takeStrip(spatial: boolean): Strip {
    const pool = spatial ? this.freeSpatial : this.freeStereo;
    const s = pool.pop();
    return s ?? this.makeStrip(spatial);
  }

  private connectBus(strip: Strip, bus: BusName): void {
    const node = this.mixer.bus(bus);
    if (strip.busNode === node) return;
    const tail: AudioNode = strip.panner ?? strip.stereo!;
    if (strip.busNode) { try { tail.disconnect(strip.busNode); } catch { /* not connected */ } }
    tail.connect(node);
    strip.busNode = node;
    strip.busName = bus;
  }

  /**
   * Acquires a voice. Returns null only when the sound is inaudible or the
   * budget is full of higher-priority voices — callers should treat null as
   * "skip this sound", never as an error.
   */
  acquire(o: VoiceOptions): Voice | null {
    const spatial = o.spatial !== false && o.x !== undefined;
    const x = o.x ?? this.lx, y = o.y ?? this.ly, z = o.z ?? this.lz;
    const dist = spatial ? this.distanceTo(x, y, z) : 0;
    const maxDist = o.maxDistance ?? 260;
    const gain = o.gain ?? 1;

    // Audibility estimate drives both culling and voice stealing.
    const ref = o.refDistance ?? 3;
    const atten = spatial ? ref / Math.max(ref, ref + (o.rolloff ?? 1.05) * (dist - ref)) : 1;
    const audibility = gain * atten * (1 - clamp01(o.occlusion ?? 0) * 0.65);
    if (spatial && (dist > maxDist || audibility < 0.0016)) return null;

    if (this.liveCount >= this.budget && !this.steal(audibility * (o.priority ?? 0.5))) {
      this.starved++;
      return null;
    }

    const strip = this.takeStrip(spatial);
    this.connectBus(strip, o.bus);
    const head = gainNode(this.ctx, gain);
    head.connect(strip.occl);

    if (strip.panner) {
      const p = strip.panner;
      p.refDistance = ref;
      p.rolloffFactor = o.rolloff ?? 1.05;
      p.maxDistance = maxDist;
      if (p.positionX) {
        p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
      } else {
        (p as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(x, y, z);
      }
    } else if (strip.stereo) {
      strip.stereo.pan.value = clamp(o.pan ?? 0, -1, 1);
    }

    const pool = this;
    const voice: Live = {
      id: strip.id,
      input: head,
      spatial,
      strip,
      endsAt: Infinity,
      priority: o.priority ?? 0.5,
      audibility,
      track: !!o.track,
      occl: 0,
      send: (o.send ?? 0.25) * pool.mixer.sendScale(o.bus),
      px: x, py: y, pz: z,
      probeAt: 0,
      released: false,
      setPosition(nx: number, ny: number, nz: number): void {
        this.px = nx; this.py = ny; this.pz = nz;
        const p = strip.panner;
        if (!p) return;
        const t = pool.ctx.currentTime;
        if (p.positionX) {
          p.positionX.setTargetAtTime(nx, t, 0.02);
          p.positionY.setTargetAtTime(ny, t, 0.02);
          p.positionZ.setTargetAtTime(nz, t, 0.02);
        } else {
          (p as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(nx, ny, nz);
        }
      },
      setGain(v: number, ramp = 0.02): void {
        head.gain.setTargetAtTime(Math.max(0, v), pool.ctx.currentTime, Math.max(0.001, ramp));
      },
      setOcclusion(v: number): void {
        this.occl = clamp01(v);
        pool.applyAcoustics(this, false);
      },
      releaseAt(time: number): void {
        this.endsAt = time;
        this.released = true;
      },
      stop(fade = 0.02): void {
        const t = pool.ctx.currentTime;
        head.gain.cancelScheduledValues(t);
        head.gain.setValueAtTime(Math.max(0.0001, head.gain.value), t);
        head.gain.exponentialRampToValueAtTime(0.0001, t + fade);
        this.endsAt = t + fade + 0.01;
        this.released = true;
      },
    };

    voice.occl = clamp01(o.occlusion ?? (spatial && this.probe ? this.runProbe(x, y, z) : 0));
    this.applyAcoustics(voice, true, o.airDistance ?? dist);
    this.live.push(voice);
    if (this.live.length > this.peak) this.peak = this.live.length;
    // Safety net: if the context clock is not advancing (deterministic capture
    // stepping, or a suspended context) released voices never reach their
    // reclaim time. Reap the oldest of them rather than leaking strips.
    if (this.live.length > this.budget * 2) {
      for (let i = 0; i < this.live.length && this.live.length > this.budget; i++) {
        if (!this.live[i].released) continue;
        this.recycle(this.live[i]);
        this.live.splice(i, 1);
        i--;
      }
    }
    return voice;
  }

  /**
   * Five rays: the direct line plus four offsets around it. Sampling the
   * neighbourhood rather than a single line is what separates "behind a thin
   * pole" from "in another room", and it costs four extra raycasts on a
   * *sound trigger*, not per frame.
   */
  private runProbe(x: number, y: number, z: number): number {
    const p = this.probe;
    if (!p) return 0;
    return clamp01(p(this.lx, this.ly, this.lz, x, y, z));
  }

  private applyAcoustics(v: Live, immediate: boolean, distance?: number): void {
    const strip = v.strip;
    const t = this.ctx.currentTime;
    const smooth = immediate ? 0.001 : 0.06;
    const d = distance ?? this.distanceTo(v.px, v.py, v.pz);

    const occ = v.occl;
    // 21 kHz clear → 420 Hz fully occluded, exponential in the occlusion amount.
    const occHz = 420 * Math.pow(21000 / 420, 1 - occ);
    const airHz = airAbsorptionHz(d);
    if (immediate) {
      strip.occl.frequency.value = occHz;
      strip.occlGain.gain.value = dbToGain(-16 * occ * occ);
      strip.air.frequency.value = airHz;
    } else {
      strip.occl.frequency.setTargetAtTime(occHz, t, smooth);
      strip.occlGain.gain.setTargetAtTime(dbToGain(-16 * occ * occ), t, smooth);
      strip.air.frequency.setTargetAtTime(airHz, t, smooth);
    }

    // Wet send.
    //
    // It has to fall off *more slowly* than the dry path — that difference is
    // the cue that tells you a sound came from far away — but it must still
    // fall off. Ignoring distance entirely (the obvious shortcut, since the
    // send is taken upstream of the panner) makes an explosion 250 m away as
    // loud as one at your feet, because its wet component never attenuates.
    // So: apply the panner's own inverse-distance law, softened by an exponent,
    // then add the "more reverberant with distance" boost on top.
    const ref = strip.panner ? strip.panner.refDistance : 1;
    const roll = strip.panner ? strip.panner.rolloffFactor : 0;
    const dry = ref / Math.max(ref, ref + roll * (d - ref));
    const wetAtten = Math.pow(dry, 0.55);
    const distWet = clamp(0.85 + d / 90, 0.85, 2.2);
    const diffract = lerp(1, 1.35, clamp01(occ * 2)) * lerp(1, 0.35, clamp01((occ - 0.5) * 2));
    const send = v.send * wetAtten * distWet * diffract;
    if (immediate) strip.send.gain.value = send;
    else strip.send.gain.setTargetAtTime(send, t, smooth);
  }

  /** Steals the least valuable live voice if it is worth less than `value`. */
  private steal(value: number): boolean {
    let worstIdx = -1;
    let worst = value;
    for (let i = 0; i < this.live.length; i++) {
      const v = this.live[i];
      if (v.released) continue; // already fading; stealing it again buys nothing
      const score = v.audibility * (0.25 + v.priority);
      if (score < worst) { worst = score; worstIdx = i; }
    }
    if (worstIdx < 0) return false;
    this.live[worstIdx].stop(0.012);
    return true;
  }

  /** Reclaims finished voices and re-evaluates tracked ones. */
  update(dt: number): void {
    const now = this.ctx.currentTime;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const v = this.live[i];
      if (now >= v.endsAt) {
        this.recycle(v);
        this.live.splice(i, 1);
        continue;
      }
      if (v.track) {
        v.probeAt -= dt;
        if (v.spatial && v.probeAt <= 0 && this.probe) {
          // Round-robin so a hundred tracked loops never re-probe on one frame.
          if ((this.probeCursor++ & 3) === 0) {
            v.occl = clamp01(this.runProbe(v.px, v.py, v.pz));
            v.probeAt = 0.14 + (v.id % 7) * 0.01;
          }
        }
        this.applyAcoustics(v, false);
      }
    }
  }

  private recycle(v: Live): void {
    try { v.input.disconnect(); } catch { /* already gone */ }
    const strip = v.strip;
    strip.send.gain.cancelScheduledValues(this.ctx.currentTime);
    strip.occl.frequency.cancelScheduledValues(this.ctx.currentTime);
    strip.occlGain.gain.cancelScheduledValues(this.ctx.currentTime);
    strip.air.frequency.cancelScheduledValues(this.ctx.currentTime);
    (v.spatial ? this.freeSpatial : this.freeStereo).push(strip);
  }

  /** Hard reset — used on level change and disposal. */
  stopAll(): void {
    for (const v of this.live) { try { v.input.disconnect(); } catch { /* gone */ } this.recycle(v); }
    this.live.length = 0;
  }

  dispose(): void {
    this.stopAll();
    for (const s of [...this.freeSpatial, ...this.freeStereo]) {
      try { s.occl.disconnect(); s.occlGain.disconnect(); s.air.disconnect(); s.send.disconnect(); } catch { /* closed */ }
      try { s.panner?.disconnect(); s.stereo?.disconnect(); } catch { /* closed */ }
    }
    this.freeSpatial.length = 0;
    this.freeStereo.length = 0;
  }
}
