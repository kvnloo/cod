/**
 * Main menu.
 *
 * Sits over the live rendered scene — the background is the game, not a picture —
 * with a dark radial scrim so the type stays legible. Nav items are large
 * condensed caps that shift right and gain an accent rule on hover; the operator
 * card, mission brief and activity feed fill the right column.
 */

import { bus } from '../../core/EventBus';
import { Rand } from '../../core/Rand';
import { el, stagger } from './Dom';
import { keyHint, menuFrame, Screen, type ScreenHost } from './MenuStack';

export interface MainMenuActions {
  deploy(): void;
  loadout(): void;
  settings(): void;
  quit(): void;
}

interface NavSpec {
  label: string;
  note: string;
  run: () => void;
  disabled?: boolean;
}

export class MainMenu extends Screen {
  private rand = new Rand('ob-main-menu');

  constructor(host: ScreenHost, private actions: MainMenuActions) {
    super('main', host);
  }

  protected build(): void {
    const parts = menuFrame(this, 'OPERATION BLACKOUT', 'Tactical Response Division', 'cols-nav');

    parts.topRight.append(
      el('div', { class: 'ob-chip', text: 'EU-WEST · 18 MS' }),
      el('div', { class: 'ob-chip', text: 'SEASON 01' }),
      el('div', { class: 'ob-chip', text: 'BUILD 1.0.0' }),
    );

    /* --------------------------------------------------------- nav --- */
    const items: NavSpec[] = [
      { label: 'Deploy', note: 'Blackout · Uplink', run: () => this.actions.deploy() },
      { label: 'Loadout', note: '3 Classes', run: () => this.actions.loadout() },
      { label: 'Barracks', note: 'Locked', run: () => { }, disabled: true },
      { label: 'Settings', note: '', run: () => this.actions.settings() },
      { label: 'Quit', note: '', run: () => this.actions.quit() },
    ];

    const nav = el('div', { class: 'ob-nav' });
    items.forEach((it, i) => {
      const btn = el('button', {
        class: 'ob-nav-item ob-stagger-x',
        type: 'button',
        disabled: it.disabled,
        on: {
          click: () => { if (!it.disabled) it.run(); },
          mouseenter: () => { if (!it.disabled) bus.emit('ui:sound', { cue: 'menuMove' }); },
        },
      },
        el('span', { class: 'ob-nav-idx', text: String(i + 1).padStart(2, '0') }),
        el('span', { text: it.label.toUpperCase() }),
        it.note ? el('span', { class: 'ob-nav-note', text: it.note.toUpperCase() }) : null,
      );
      stagger(btn, i);
      nav.appendChild(btn);
    });

    const left = el('div', {},
      stagger(el('div', { class: 'ob-panel ob-stagger', style: { marginBottom: 'calc(var(--ob-u)*20)' } },
        el('div', { class: 'ob-panel-title' }, el('span', { text: 'Operator' })),
        el('div', { class: 'ob-card' },
          el('div', { class: 'ob-rank', text: '42' }),
          el('div', {},
            el('div', { class: 'ob-card-name', text: 'GHOST-ACTUAL' }),
            el('div', { class: 'ob-card-meta', text: 'RANK 42 · 128,940 XP · PRESTIGE I' }),
            (() => {
              const bar = el('div', { class: 'ob-xpbar' });
              const fill = el('i');
              fill.style.width = '64%';
              bar.appendChild(fill);
              return bar;
            })(),
          ),
        ),
      ), 0),
      nav,
    );

    /* -------------------------------------------------------- right -- */
    const brief = el('div', { class: 'ob-panel ob-stagger' },
      el('div', { class: 'ob-panel-title' },
        el('span', { text: 'Mission Brief' }),
        el('span', { text: 'PRIORITY ALPHA' }),
      ),
      el('div', {
        style: {
          fontFamily: 'var(--ob-cond)', fontSize: 'calc(var(--ob-u)*34)',
          fontWeight: '700', letterSpacing: '.16em', color: 'var(--ob-ink)',
        },
        text: 'BLACKOUT · UPLINK',
      }),
      el('div', {
        style: {
          fontFamily: 'var(--ob-sans)', fontSize: 'calc(var(--ob-u)*13.5)',
          color: 'var(--ob-dim)', lineHeight: '1.55',
          marginTop: 'calc(var(--ob-u)*8)', maxWidth: '62ch',
        },
        text: 'Hostile signals intelligence has seized the district relay. Secure the '
          + 'uplink, hold it through the counter-attack and extract before the grid '
          + 'comes back online. Expect entrenched infantry and rooftop overwatch.',
      }),
      el('div', {
        style: { display: 'flex', gap: 'calc(var(--ob-u)*10)', marginTop: 'calc(var(--ob-u)*14)' },
      },
        el('div', { class: 'ob-medal', text: 'Domination' }),
        el('div', { class: 'ob-medal', text: '6 v 6' }),
        el('div', { class: 'ob-medal', text: 'Dusk · Light Rain' }),
      ),
    );
    stagger(brief, 1);

    const feed = el('div', { class: 'ob-panel ob-stagger' },
      el('div', { class: 'ob-panel-title' }, el('span', { text: 'Recent Activity' })),
      el('div', { class: 'ob-scroll', style: { maxHeight: 'calc(var(--ob-u)*230)' } },
        ...this.activity().map((line, i) => el('div', {
          style: {
            display: 'flex', justifyContent: 'space-between',
            padding: 'calc(var(--ob-u)*5) 0',
            borderBottom: '1px solid rgba(157,178,204,.07)',
            fontFamily: 'var(--ob-cond)', fontSize: 'calc(var(--ob-u)*13.5)',
            letterSpacing: '.12em',
            color: i === 0 ? 'var(--ob-accent)' : 'var(--ob-dim)',
          },
        },
          el('span', { text: line[0] }),
          el('span', { style: { fontFamily: 'var(--ob-mono)', fontSize: 'calc(var(--ob-u)*10.5)' }, text: line[1] }),
        )),
      ),
    );
    stagger(feed, 2);

    const right = el('div', {
      style: {
        display: 'grid', gridTemplateRows: 'auto auto 1fr',
        gap: 'calc(var(--ob-u)*20)', minHeight: '0',
      },
    }, brief, feed, el('div'));

    parts.body.append(left, right);

    parts.footerLeft.append(
      keyHint('↑↓', 'Navigate'),
      keyHint('ENTER', 'Select'),
      keyHint('ESC', 'Back'),
    );
  }

  /** Deterministic filler so the panel is never empty and never uses Math.random. */
  private activity(): Array<[string, string]> {
    const verbs = [
      'UNLOCKED  VKR-7 EXTENDED MAG',
      'CHALLENGE  MARKSMAN III COMPLETE',
      'PROMOTED  RANK 42',
      'UNLOCKED  SUPPRESSOR · MK2',
      'MATCH  VICTORY · UPLINK',
      'CHALLENGE  CLOSE QUARTERS II',
      'UNLOCKED  CLUSTER STRIKE',
    ];
    const out: Array<[string, string]> = [];
    for (let i = 0; i < verbs.length; i++) {
      const h = this.rand.int(1, 46);
      out.push([verbs[i], `${h}H AGO`]);
    }
    return out;
  }
}
