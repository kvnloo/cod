/**
 * Zero-allocation-ish typed event bus.
 *
 * Systems communicate through this rather than holding references to each other,
 * which is what lets independent subsystems be developed and swapped in isolation.
 */

import type { Vector3 } from 'three';

export interface GameEvents {
  /* --- lifecycle --- */
  'game:ready': void;
  'game:start': { mode: string };
  'game:over': { win: boolean; score: number };
  'game:pause': { paused: boolean };
  'level:loaded': { name: string };

  /* --- weapons --- */
  'weapon:fire': { weaponId: string; origin: Vector3; direction: Vector3; shotIndex: number; suppressed: boolean };
  'weapon:dryfire': { weaponId: string };
  'weapon:reload:start': { weaponId: string; tactical: boolean };
  'weapon:reload:end': { weaponId: string };
  'weapon:switch': { from: string | null; to: string };
  'weapon:ads': { active: boolean };
  'weapon:overheat': { weaponId: string; heat: number };

  /* --- ballistics / damage --- */
  'bullet:impact': {
    point: Vector3; normal: Vector3; surface: string;
    incoming: Vector3; energy: number; penetrated: boolean;
  };
  'damage:dealt': {
    targetId: number; amount: number; headshot: boolean; killed: boolean;
    point: Vector3; fromPlayer: boolean;
  };
  'damage:taken': { amount: number; fromDirection: Vector3; sourceId: number; lethal: boolean };
  'entity:death': { id: number; byPlayer: boolean; headshot: boolean; name: string; point: Vector3 };

  /* --- explosions / physics --- */
  'explosion': { point: Vector3; radius: number; power: number; kind: string };
  'grenade:thrown': { id: number; kind: string };
  'physics:impact': { point: Vector3; impulse: number; material: string };

  /* --- player --- */
  'player:spawn': { point: Vector3 };
  'player:move:state': { state: string };
  'player:footstep': { point: Vector3; surface: string; sprinting: boolean };
  'player:land': { point: Vector3; force: number; surface: string };
  'player:mantle': void;
  'player:slide': { start: boolean };
  'player:health': { health: number; max: number; regen: boolean };

  /* --- ai --- */
  'ai:alert': { id: number; level: number };
  'ai:fire': { id: number; origin: Vector3; direction: Vector3 };
  'ai:voice': { id: number; line: string };

  /* --- meta --- */
  'score:add': { amount: number; reason: string };
  'killstreak:earned': { name: string; count: number };
  'notify': { text: string; kind?: 'info' | 'warn' | 'reward' };
  'hud:hitmarker': { headshot: boolean; killed: boolean; armor: boolean };
  'quality:changed': { preset: string };
  'settings:changed': { key: string; value: unknown };
}

export type EventKey = keyof GameEvents;
type Handler<K extends EventKey> = (payload: GameEvents[K]) => void;

export class EventBus {
  private map = new Map<EventKey, Set<Handler<never>>>();

  on<K extends EventKey>(key: K, fn: Handler<K>): () => void {
    let set = this.map.get(key);
    if (!set) { set = new Set(); this.map.set(key, set); }
    set.add(fn as Handler<never>);
    return () => { set!.delete(fn as Handler<never>); };
  }

  once<K extends EventKey>(key: K, fn: Handler<K>): () => void {
    const off = this.on(key, ((p: GameEvents[K]) => { off(); fn(p); }) as Handler<K>);
    return off;
  }

  off<K extends EventKey>(key: K, fn: Handler<K>): void {
    this.map.get(key)?.delete(fn as Handler<never>);
  }

  emit<K extends EventKey>(key: K, payload: GameEvents[K]): void {
    const set = this.map.get(key);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Handler<K>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(key)}" threw`, err);
      }
    }
  }

  clear(): void { this.map.clear(); }
}

/** Global bus. Single instance per page; systems import this directly. */
export const bus = new EventBus();
