/**
 * Data-authored animation clips.
 *
 * There are no animation files in this project, so clips are written as
 * keyframe tables in TypeScript: a list of times, each carrying a partial pose
 * expressed in degrees per bone. `compileClip` turns that into per-bone
 * quaternion tracks with per-key easing, and `Clip.sample` evaluates them with
 * shortest-arc slerp.
 *
 * Two conventions keep the authoring readable:
 *
 *  - Angles are degrees, applied in YXZ order, as a *delta from rest*. Because
 *    the rest pose is identity everywhere, `{ lowerLegL: [70, 0, 0] }` simply
 *    means "bend the left knee 70°".
 *  - A bone omitted from a key is not animated *at that key*; its track only
 *    contains the keys that mention it. That is what lets a walk cycle
 *    interleave a 4-key leg track with a 2-key spine track without padding.
 */

import { BONE_COUNT, BONE_INDEX } from '../Rig';
import type { BoneName } from '../types';
import { eulerYXZInto, slerpInto, type Pose } from './Pose';

export type Ease = 'linear' | 'sine' | 'inOut' | 'out' | 'in' | 'step';

export type PoseSpec = Partial<Record<BoneName, readonly [number, number, number]>>;
export type OffsetSpec = Partial<Record<BoneName, readonly [number, number, number]>>;

export interface KeySpec {
  /** Normalised time within the clip, 0..1. */
  t: number;
  pose?: PoseSpec;
  /** Local translation offsets in metres (hips bob, root motion). */
  offset?: OffsetSpec;
  ease?: Ease;
}

export interface ClipDef {
  name: string;
  /** Seconds at playback rate 1. */
  duration: number;
  loop?: boolean;
  keys: KeySpec[];
}

interface Track {
  bone: number;
  times: Float32Array;
  quats: Float32Array;
  eases: Ease[];
}

interface OffsetTrack {
  bone: number;
  times: Float32Array;
  values: Float32Array;
  eases: Ease[];
}

const DEG = Math.PI / 180;

function easeFn(e: Ease, t: number): number {
  switch (e) {
    case 'sine': return 0.5 - 0.5 * Math.cos(Math.PI * t);
    case 'inOut': return t * t * (3 - 2 * t);
    case 'out': return 1 - (1 - t) * (1 - t);
    case 'in': return t * t;
    case 'step': return 0;
    default: return t;
  }
}

export class Clip {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  /** Per-bone authority mask: 1 where the clip animates a bone. */
  readonly mask = new Float32Array(BONE_COUNT);
  private tracks: Track[] = [];
  private offsets: OffsetTrack[] = [];

  constructor(def: ClipDef) {
    this.name = def.name;
    this.duration = def.duration;
    this.loop = def.loop ?? true;

    const keys = [...def.keys].sort((a, b) => a.t - b.t);
    const byBone = new Map<number, { t: number; e: readonly [number, number, number]; ease: Ease }[]>();
    const byOffset = new Map<number, { t: number; e: readonly [number, number, number]; ease: Ease }[]>();

    for (const k of keys) {
      if (k.pose) {
        for (const name of Object.keys(k.pose) as BoneName[]) {
          const idx = BONE_INDEX[name];
          if (idx === undefined) continue;
          const e = k.pose[name];
          if (!e) continue;
          const list = byBone.get(idx) ?? [];
          list.push({ t: k.t, e, ease: k.ease ?? 'inOut' });
          byBone.set(idx, list);
        }
      }
      if (k.offset) {
        for (const name of Object.keys(k.offset) as BoneName[]) {
          const idx = BONE_INDEX[name];
          if (idx === undefined) continue;
          const e = k.offset[name];
          if (!e) continue;
          const list = byOffset.get(idx) ?? [];
          list.push({ t: k.t, e, ease: k.ease ?? 'inOut' });
          byOffset.set(idx, list);
        }
      }
    }

    for (const [bone, list] of byBone) {
      const times = new Float32Array(list.length);
      const quats = new Float32Array(list.length * 4);
      const eases: Ease[] = [];
      for (let i = 0; i < list.length; i++) {
        times[i] = list[i].t;
        eulerYXZInto(list[i].e[0] * DEG, list[i].e[1] * DEG, list[i].e[2] * DEG, quats, i * 4);
        eases.push(list[i].ease);
      }
      this.tracks.push({ bone, times, quats, eases });
      this.mask[bone] = 1;
    }

    for (const [bone, list] of byOffset) {
      const times = new Float32Array(list.length);
      const values = new Float32Array(list.length * 3);
      const eases: Ease[] = [];
      for (let i = 0; i < list.length; i++) {
        times[i] = list[i].t;
        values[i * 3] = list[i].e[0];
        values[i * 3 + 1] = list[i].e[1];
        values[i * 3 + 2] = list[i].e[2];
        eases.push(list[i].ease);
      }
      this.offsets.push({ bone, times, values, eases });
      this.mask[bone] = 1;
    }
  }

  /**
   * Samples the clip at normalised phase `p` (0..1) into `out`. Bones the clip
   * does not animate are left at identity, and `out.weight` receives the mask so
   * the caller can do a masked blend without consulting the clip again.
   */
  sample(p: number, out: Pose): void {
    out.identity();
    const t = this.loop ? p - Math.floor(p) : Math.min(1, Math.max(0, p));

    for (const tr of this.tracks) {
      const n = tr.times.length;
      if (n === 1) {
        out.rot.set(tr.quats.subarray(0, 4), tr.bone * 4);
        out.weight[tr.bone] = 1;
        continue;
      }
      let i = 0;
      while (i < n - 1 && tr.times[i + 1] <= t) i++;
      let a = i, b = i + 1;
      let span: number, local: number;
      if (t < tr.times[0]) {
        if (this.loop) {
          a = n - 1; b = 0;
          span = tr.times[0] + (1 - tr.times[n - 1]);
          local = (t + (1 - tr.times[n - 1])) / (span || 1);
        } else {
          out.rot.set(tr.quats.subarray(0, 4), tr.bone * 4);
          out.weight[tr.bone] = 1;
          continue;
        }
      } else if (b >= n) {
        if (this.loop) {
          a = n - 1; b = 0;
          span = tr.times[0] + (1 - tr.times[n - 1]);
          local = (t - tr.times[n - 1]) / (span || 1);
        } else {
          out.rot.set(tr.quats.subarray((n - 1) * 4, n * 4), tr.bone * 4);
          out.weight[tr.bone] = 1;
          continue;
        }
      } else {
        span = tr.times[b] - tr.times[a];
        local = span > 1e-6 ? (t - tr.times[a]) / span : 0;
      }
      const f = easeFn(tr.eases[a], Math.min(1, Math.max(0, local)));
      slerpInto(tr.quats, a * 4, tr.quats, b * 4, f, out.rot, tr.bone * 4);
      out.weight[tr.bone] = 1;
    }

    for (const tr of this.offsets) {
      const n = tr.times.length;
      const o = tr.bone * 3;
      if (n === 1) {
        out.pos[o] = tr.values[0]; out.pos[o + 1] = tr.values[1]; out.pos[o + 2] = tr.values[2];
        out.weight[tr.bone] = 1;
        continue;
      }
      let i = 0;
      while (i < n - 1 && tr.times[i + 1] <= t) i++;
      let a = i, b = i + 1;
      let span: number, local: number;
      if (t < tr.times[0] || b >= n) {
        if (this.loop) {
          a = n - 1; b = 0;
          span = tr.times[0] + (1 - tr.times[n - 1]);
          local = t < tr.times[0]
            ? (t + (1 - tr.times[n - 1])) / (span || 1)
            : (t - tr.times[n - 1]) / (span || 1);
        } else {
          const k = t < tr.times[0] ? 0 : n - 1;
          out.pos[o] = tr.values[k * 3];
          out.pos[o + 1] = tr.values[k * 3 + 1];
          out.pos[o + 2] = tr.values[k * 3 + 2];
          out.weight[tr.bone] = 1;
          continue;
        }
      } else {
        span = tr.times[b] - tr.times[a];
        local = span > 1e-6 ? (t - tr.times[a]) / span : 0;
      }
      const f = easeFn(tr.eases[a], Math.min(1, Math.max(0, local)));
      out.pos[o] = tr.values[a * 3] + (tr.values[b * 3] - tr.values[a * 3]) * f;
      out.pos[o + 1] = tr.values[a * 3 + 1] + (tr.values[b * 3 + 1] - tr.values[a * 3 + 1]) * f;
      out.pos[o + 2] = tr.values[a * 3 + 2] + (tr.values[b * 3 + 2] - tr.values[a * 3 + 2]) * f;
      out.weight[tr.bone] = 1;
    }
  }
}

/** Builds a per-bone mask from a bone-name list, with optional falloff. */
export function maskOf(bones: readonly BoneName[], value = 1): Float32Array {
  const m = new Float32Array(BONE_COUNT);
  for (const b of bones) m[BONE_INDEX[b]] = value;
  return m;
}
