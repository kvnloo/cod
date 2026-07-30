/**
 * Adapter from the global event bus to the narrow `EventPort` progression
 * consumes. Kept in its own file so every other module here stays importable
 * from a plain node script with no engine in scope.
 */

import { bus } from '../../core/EventBus';
import type { EventPort } from './types';
import './events';

let cached: EventPort | null = null;

/** The global bus as an `EventPort`. Safe to call from anywhere. */
export function busPort(): EventPort {
  if (!cached) {
    cached = {
      emit: (key, payload) => { bus.emit(key, payload); },
      on: (key, fn) => bus.on(key, fn),
    };
  }
  return cached;
}

/** An `EventPort` that records everything — the seam headless tests drive. */
export function recordingPort(): EventPort & { events: Array<{ key: string; payload: unknown }> } {
  const handlers = new Map<string, Set<(p: never) => void>>();
  const events: Array<{ key: string; payload: unknown }> = [];
  return {
    events,
    emit: (key, payload) => {
      events.push({ key: String(key), payload });
      const set = handlers.get(String(key));
      if (!set) return;
      for (const fn of set) (fn as (p: unknown) => void)(payload);
    },
    on: (key, fn) => {
      const k = String(key);
      let set = handlers.get(k);
      if (!set) { set = new Set(); handlers.set(k, set); }
      set.add(fn as (p: never) => void);
      return () => { set!.delete(fn as (p: never) => void); };
    },
  };
}
