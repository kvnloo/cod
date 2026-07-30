/**
 * Subtitles for radio traffic and squad callouts.
 *
 * Rendered as DOM text so the browser's own font scaling and assistive
 * technology work, and announced through an `aria-live` region. Lines arrive
 * either explicitly (`ui:subtitle`) or by translating the audio module's
 * `ai:voice` line identifiers through a lookup table, so voice lines are captioned
 * without the audio module knowing the UI exists.
 */

import { bus } from '../../core/EventBus';
import { el } from '../menus/Dom';
import { ui } from '../UiSettings';
import type { UiSubtitleRequest } from '../UiEvents';

/** Canonical voice-line identifiers → caption text. */
const VOICE_LINES: Record<string, { speaker: string; text: string }> = {
  contact: { speaker: 'SQUAD', text: 'Contact front!' },
  contactLeft: { speaker: 'SQUAD', text: 'Contact left!' },
  contactRight: { speaker: 'SQUAD', text: 'Contact right!' },
  reloading: { speaker: 'SQUAD', text: 'Reloading — cover me!' },
  grenade: { speaker: 'SQUAD', text: 'Grenade! Move!' },
  flanking: { speaker: 'SQUAD', text: "They're flanking — watch the right." },
  manDown: { speaker: 'SQUAD', text: 'Man down!' },
  clear: { speaker: 'SQUAD', text: 'Area clear.' },
  pushing: { speaker: 'SQUAD', text: 'Pushing up — on me.' },
  suppressed: { speaker: 'SQUAD', text: "I'm pinned! Suppressing fire!" },
  objectiveCaptured: { speaker: 'OVERLORD', text: 'Uplink secured. Hold that position.' },
  objectiveLost: { speaker: 'OVERLORD', text: 'We lost the uplink — take it back.' },
  uav: { speaker: 'OVERLORD', text: 'UAV is online, scanning the sector.' },
  counterUav: { speaker: 'OVERLORD', text: 'Enemy radar jammed.' },
  airstrike: { speaker: 'OVERLORD', text: 'Ordnance inbound — keep your heads down.' },
  extract: { speaker: 'OVERLORD', text: 'Extraction is on station. Move to the LZ.' },
  lowHealth: { speaker: 'OVERLORD', text: 'You are hit — find cover and regroup.' },
};

interface Line {
  speaker: string;
  text: string;
  age: number;
  life: number;
  priority: number;
}

export class Subtitles {
  readonly root: HTMLElement;
  private lineEl: HTMLElement;
  private current: Line | null = null;
  private queue: Line[] = [];
  private suppressed = false;
  private readonly off: Array<() => void> = [];

  constructor() {
    this.lineEl = el('span', { class: 'ob-subs-line' });
    this.root = el('div', {
      class: 'ob-subs',
      role: 'status',
      aria: { live: 'polite', atomic: 'true' },
    }, this.lineEl);

    this.off.push(bus.on('ui:subtitle', (e) => this.say(e)));
    this.off.push(bus.on('ai:voice', (e) => {
      const entry = VOICE_LINES[e.line];
      if (entry) this.say({ speaker: entry.speaker, text: entry.text, priority: 0 });
      else this.say({ speaker: 'SQUAD', text: humanise(e.line), priority: 0 });
    }));
  }

  /** Hides captions without discarding them (menus own the screen). */
  setSuppressed(v: boolean): void {
    if (this.suppressed === v) return;
    this.suppressed = v;
    this.root.style.display = v ? 'none' : '';
  }

  say(req: UiSubtitleRequest): void {
    if (!ui.prefs.subtitles) return;
    const line: Line = {
      speaker: req.speaker ?? '',
      text: req.text,
      age: 0,
      life: req.duration ?? Math.max(1.6, 0.9 + req.text.length * 0.055),
      priority: req.priority ?? 0,
    };
    if (this.current && line.priority > this.current.priority) {
      this.current = line;
      this.render();
      return;
    }
    if (!this.current) {
      this.current = line;
      this.render();
      return;
    }
    this.queue.push(line);
    if (this.queue.length > 4) this.queue.shift();
  }

  clear(): void {
    this.current = null;
    this.queue.length = 0;
    // Suppress the fade: callers clear on a hard state reset (round start, a new
    // capture shot) where a 220 ms tail would bleed into the next state.
    snapClass(this.root, 'is-on', false);
  }

  update(dt: number): void {
    if (!ui.prefs.subtitles) {
      if (this.current) { this.current = null; this.root.classList.remove('is-on'); }
      return;
    }
    if (!this.current) {
      const next = this.queue.shift();
      if (next) { this.current = next; this.render(); }
      return;
    }
    this.current.age += dt;
    if (this.current.age >= this.current.life) {
      this.current = null;
      this.root.classList.remove('is-on');
    }
  }

  private render(): void {
    const line = this.current;
    if (!line) return;
    while (this.lineEl.firstChild) this.lineEl.removeChild(this.lineEl.firstChild);
    if (line.speaker) {
      this.lineEl.appendChild(el('span', { class: 'ob-subs-speaker', text: `${line.speaker}:` }));
    }
    this.lineEl.appendChild(document.createTextNode(line.text));
    this.root.style.fontSize = `${ui.prefs.subtitleSize.toFixed(2)}em`;
    this.root.classList.add('is-on');
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}

/** Toggles a class with the element's transition momentarily disabled. */
function snapClass(el: HTMLElement, cls: string, on: boolean): void {
  const prev = el.style.transition;
  el.style.transition = 'none';
  el.classList.toggle(cls, on);
  void el.offsetHeight;
  el.style.transition = prev;
}

/** Fallback caption for an unknown voice-line id: "contactLeft" → "Contact left". */
function humanise(id: string): string {
  const spaced = id.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
