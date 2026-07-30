/**
 * Pause menu.
 *
 * Overlaid on the frozen frame: the mission objective and a compact stat line on
 * the left, the action list on the right. Opening emits `game:pause` so the
 * simulation stops; closing resumes it.
 */

import { bus } from '../../core/EventBus';
import { clockString } from '../Draw';
import type { HudModel } from '../Model';
import { el, stagger } from './Dom';
import { keyHint, menuFrame, Screen, type ScreenHost } from './MenuStack';

export interface PauseActions {
  resume(): void;
  loadout(): void;
  settings(): void;
  restart(): void;
  quit(): void;
}

export class PauseMenu extends Screen {
  private statLine: HTMLElement | null = null;
  private clockLine: HTMLElement | null = null;

  constructor(host: ScreenHost, private actions: PauseActions, private model: () => HudModel) {
    super('pause', host);
  }

  protected build(): void {
    const parts = menuFrame(this, 'PAUSED', 'Simulation Halted', 'cols-2');
    parts.body.style.alignItems = 'start';

    const stats = el('div', { class: 'ob-card-meta' });
    this.statLine = stats;
    const clock = el('div', {
      style: {
        fontFamily: 'var(--ob-cond)', fontSize: 'calc(var(--ob-u)*44)', fontWeight: '700',
        letterSpacing: '.12em', color: 'var(--ob-ink)',
      },
    });
    this.clockLine = clock;

    const left = el('div', { class: 'ob-panel ob-stagger' },
      el('div', { class: 'ob-panel-title' },
        el('span', { text: 'Current Objective' }),
        el('span', { text: 'DOMINATION' }),
      ),
      el('div', {
        style: {
          fontFamily: 'var(--ob-cond)', fontSize: 'calc(var(--ob-u)*30)', fontWeight: '700',
          letterSpacing: '.16em', color: 'var(--ob-accent)',
        }, text: 'SECURE THE UPLINK',
      }),
      el('div', {
        style: {
          fontFamily: 'var(--ob-sans)', fontSize: 'calc(var(--ob-u)*13)', color: 'var(--ob-dim)',
          lineHeight: '1.5', marginTop: 'calc(var(--ob-u)*6)', maxWidth: '48ch',
        },
        text: 'Hold objective B until the transfer completes. Reinforcements arrive '
          + 'from the north-east once the counter-attack begins.',
      }),
      el('div', { style: { marginTop: 'calc(var(--ob-u)*20)' } },
        el('div', { class: 'ob-brand-sub', text: 'Time Remaining' }),
        clock,
      ),
      el('div', { style: { marginTop: 'calc(var(--ob-u)*14)' } },
        el('div', { class: 'ob-brand-sub', text: 'Performance' }),
        stats,
      ),
    );
    stagger(left, 0);

    const nav = el('div', { class: 'ob-nav' });
    const items: Array<[string, () => void]> = [
      ['Resume', () => this.actions.resume()],
      ['Loadout', () => this.actions.loadout()],
      ['Settings', () => this.actions.settings()],
      ['Restart Mission', () => this.actions.restart()],
      ['Quit to Menu', () => this.actions.quit()],
    ];
    items.forEach(([label, run], i) => {
      const b = el('button', {
        class: 'ob-nav-item ob-stagger-x', type: 'button',
        on: {
          click: run,
          mouseenter: () => bus.emit('ui:sound', { cue: 'menuMove' }),
        },
      },
        el('span', { class: 'ob-nav-idx', text: String(i + 1).padStart(2, '0') }),
        el('span', { text: label.toUpperCase() }),
      );
      stagger(b, i);
      nav.appendChild(b);
    });

    parts.body.append(left, el('div', { style: { alignSelf: 'center' } }, nav));
    parts.footerLeft.append(keyHint('ESC', 'Resume'), keyHint('TAB', 'Scoreboard'));
  }

  override onOpen(): void {
    const m = this.model();
    if (this.clockLine) this.clockLine.textContent = clockString(m.match.timeLeft);
    if (this.statLine) {
      this.statLine.textContent =
        `SCORE ${Math.round(m.score)}  ·  HEALTH ${Math.round(m.health)}  ·  `
        + `${m.weapon.name} ${m.weapon.ammo}/${m.weapon.reserve}`;
    }
    bus.emit('game:pause', { paused: true });
  }

  override onClose(): void {
    bus.emit('game:pause', { paused: false });
  }
}
