/**
 * Deterministic match log.
 *
 * Every decision the director makes that could diverge — a spawn, a phase
 * transition, an objective outcome, a reward roll — is appended here with the
 * fixed-step tick it happened on. Two runs of the same seed must produce
 * byte-identical logs, so the hash is a one-number regression test for
 * determinism and the log itself is a replay script.
 *
 * The log is bounded: beyond `MAX_ENTRIES` it keeps hashing but stops storing,
 * so a long match can never grow without limit.
 */

const MAX_ENTRIES = 4096;

export interface LogEntry {
  /** Fixed-step tick index. */
  tick: number;
  kind: string;
  a: number;
  b: number;
}

export interface ReplaySpec {
  seed: number;
  mode: string;
  /** Bumped whenever the director's decision logic changes. */
  version: number;
  hash: string;
  ticks: number;
}

export const REPLAY_VERSION = 3;

export class MatchLog {
  readonly entries: LogEntry[] = [];
  private h = 2166136261 >>> 0;
  private count = 0;

  reset(): void {
    this.entries.length = 0;
    this.h = 2166136261 >>> 0;
    this.count = 0;
  }

  record(tick: number, kind: string, a = 0, b = 0): void {
    this.count++;
    if (this.entries.length < MAX_ENTRIES) this.entries.push({ tick, kind, a, b });
    this.mix(tick);
    for (let i = 0; i < kind.length; i++) this.mix(kind.charCodeAt(i));
    // Quantise so float noise below a millimetre cannot flip the hash.
    this.mix(Math.round(a * 1000));
    this.mix(Math.round(b * 1000));
  }

  private mix(v: number): void {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 0xff;
      this.h = Math.imul(this.h, 16777619) >>> 0;
      x >>>= 8;
    }
  }

  get length(): number { return this.count; }

  hash(): string { return (this.h >>> 0).toString(16).padStart(8, '0'); }

  /** Compact, diffable dump used when a determinism check fails. */
  serialize(): string {
    return this.entries.map((e) => `${e.tick}|${e.kind}|${e.a.toFixed(3)}|${e.b.toFixed(3)}`).join('\n');
  }

  /** Index of the first divergence between two logs, or -1. */
  static firstDivergence(a: MatchLog, b: MatchLog): number {
    const n = Math.min(a.entries.length, b.entries.length);
    for (let i = 0; i < n; i++) {
      const x = a.entries[i];
      const y = b.entries[i];
      if (x.tick !== y.tick || x.kind !== y.kind
        || Math.round(x.a * 1000) !== Math.round(y.a * 1000)
        || Math.round(x.b * 1000) !== Math.round(y.b * 1000)) return i;
    }
    return a.entries.length === b.entries.length ? -1 : n;
  }
}

const REPLAY_KEY = 'blackout.replay.v1';

/** Persists the seed/mode/hash of the last match so it can be replayed. */
export function saveReplay(spec: ReplaySpec): void {
  try { globalThis.localStorage?.setItem(REPLAY_KEY, JSON.stringify(spec)); } catch { /* ignore */ }
}

export function loadReplay(): ReplaySpec | null {
  try {
    const raw = globalThis.localStorage?.getItem(REPLAY_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ReplaySpec>;
    if (typeof d.seed !== 'number' || typeof d.mode !== 'string') return null;
    return {
      seed: d.seed, mode: d.mode,
      version: typeof d.version === 'number' ? d.version : 0,
      hash: typeof d.hash === 'string' ? d.hash : '',
      ticks: typeof d.ticks === 'number' ? d.ticks : 0,
    };
  } catch { return null; }
}
