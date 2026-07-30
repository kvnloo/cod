/**
 * UI-owned additions to the global event vocabulary.
 *
 * The HUD is a pure listener for everything gameplay already publishes, but it
 * also needs to *ask* for things — a UI sound cue, a subtitle, an objective
 * marker. Rather than editing the shared `GameEvents` table (owned by core), the
 * UI module declares its own `ui:*` namespace by interface merging. Any other
 * system can subscribe to these without importing anything from `src/ui`.
 *
 * All keys are prefixed `ui:` so this namespace can never collide with another
 * module's events.
 */

import type { Vector3 } from 'three';

/** Distinct interface sound cues. The audio module maps these to synth patches. */
export type UiCue =
  | 'hit'            // generic hit marker
  | 'hitArmor'       // armour absorbed the round
  | 'hitCrit'        // headshot / critical
  | 'hitKill'        // confirmed kill
  | 'streakReady'    // killstreak available
  | 'xp'             // score popup
  | 'objective'      // objective banner
  | 'alarm'          // danger / low health
  | 'lowAmmo'
  | 'menuMove'
  | 'menuSelect'
  | 'menuBack'
  | 'menuOpen'
  | 'menuClose'
  | 'promptComplete';

export interface UiObjectiveMarker {
  id: string;
  /** Single-character or short glyph shown inside the marker. */
  label: string;
  /** World position; omit for a compass-only bearing marker. */
  position?: Vector3;
  kind?: 'primary' | 'secondary' | 'hostile' | 'friendly' | 'extract';
  /** Optional 0..1 capture/progress ring. */
  progress?: number;
}

export interface UiPromptRequest {
  id: string;
  /** Verb line, e.g. "PLANT CHARGE". */
  label: string;
  /** Key cap glyph, e.g. "F". */
  key?: string;
  /** Seconds of hold required; 0/undefined for a tap prompt. */
  hold?: number;
  /** Optional sub-label, e.g. "C4 x1". */
  detail?: string;
}

export interface UiSubtitleRequest {
  /** Speaker tag rendered in the accent colour, e.g. "OVERLORD". */
  speaker?: string;
  text: string;
  /** Seconds to hold; defaults to a length-derived duration. */
  duration?: number;
  /** Priority 0..2 — higher replaces lower immediately. */
  priority?: number;
}

export type UiScreenName =
  | 'none' | 'main' | 'loadout' | 'settings' | 'pause' | 'summary';

declare module '../core/EventBus' {
  interface GameEvents {
    /** HUD → audio: play an interface cue. */
    'ui:sound': { cue: UiCue; gain?: number };
    /** Anyone → HUD: add/replace/remove an objective marker (null clears). */
    'ui:objective': { marker: UiObjectiveMarker | null; id?: string };
    /** Anyone → HUD: show or clear an interaction prompt. */
    'ui:prompt': { prompt: UiPromptRequest | null };
    /** Anyone → HUD: display a subtitle line. */
    'ui:subtitle': UiSubtitleRequest;
    /** Anyone → HUD: full-width objective banner. */
    'ui:banner': { title: string; sub?: string; kind?: 'objective' | 'warn' | 'reward' };
    /** HUD → world: a menu screen opened or closed (gameplay should pause input). */
    'ui:screen': { screen: UiScreenName; open: boolean };
    /** Anyone → HUD: killstreak slot state. */
    'ui:killstreak': { slot: number; name: string; progress: number; ready: boolean; charges?: number };
    /** Anyone → HUD: equipment counts. */
    'ui:equipment': { lethal: number; tactical: number; field: number; fieldName?: string };
  }
}

export { };
