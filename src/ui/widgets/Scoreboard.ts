/**
 * Scoreboard — held on `scoreboard` (Tab).
 *
 * DOM rather than canvas: it is a table of real text, it is not animated per
 * frame, and rendering it as markup means it scales with the browser's own text
 * settings and can be read by assistive technology.
 *
 * Rosters are generated from the seeded RNG so a capture is reproducible, and
 * the live player's row is spliced in from the HUD model.
 */

import { Rand } from '../../core/Rand';
import type { HudModel } from '../Model';
import { clear, el } from '../menus/Dom';

export interface ScoreRow {
  name: string;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  streak: string;
  isPlayer?: boolean;
}

const CALLSIGNS = [
  'REAPER', 'VULTURE', 'HAVOC', 'SABLE', 'IRONHIDE', 'NOMAD', 'ZEALOT', 'KESTREL',
  'BADGER', 'CINDER', 'WRAITH', 'TALON', 'ONYX', 'MAVERICK', 'HALYARD', 'GRIT',
  'MERIDIAN', 'PIKE', 'SABRE', 'DUSTOFF', 'RAVEN', 'HOLLOW', 'CASTOR', 'BRIMSTONE',
];

const STREAKS = ['—', 'UAV', 'CUAV', 'UAV·CLST', 'CLST', 'UAV·CUAV'];

export class Scoreboard {
  readonly root: HTMLElement;
  private friendlyBody: HTMLElement;
  private hostileBody: HTMLElement;
  private titleScore: HTMLElement;
  private open = false;
  private friendly: ScoreRow[] = [];
  private hostile: ScoreRow[] = [];
  private teamScore: [number, number] = [0, 0];
  private scoreLimit = 200;

  constructor() {
    this.friendlyBody = el('tbody');
    this.hostileBody = el('tbody');
    this.titleScore = el('div', { class: 'ob-sb-score' });

    const table = (label: string, tint: string, body: HTMLElement): HTMLElement =>
      el('div', {},
        el('div', { class: 'ob-sb-team-name', style: { color: tint }, text: label }),
        el('table', { class: 'ob-sb' },
          el('thead', {},
            el('tr', {},
              el('th', { text: 'Operator' }),
              el('th', { text: 'Score' }),
              el('th', { text: 'K' }),
              el('th', { text: 'D' }),
              el('th', { text: 'A' }),
              el('th', { text: 'Streak' }),
            ),
          ),
          body,
        ),
      );

    this.root = el('div', { class: 'ob-scoreboard' },
      el('div', { class: 'ob-scoreboard-inner' },
        el('div', { class: 'ob-sb-head' },
          el('div', {},
            el('div', { class: 'ob-sb-title', text: 'UPLINK' }),
            el('div', { class: 'ob-sb-mode', text: 'DOMINATION · SCORE LIMIT 200' }),
          ),
          this.titleScore,
        ),
        el('div', { class: 'ob-sb-teams' },
          table('TASK FORCE', 'var(--ob-friendly)', this.friendlyBody),
          table('HOSTILES', 'var(--ob-hostile)', this.hostileBody),
        ),
      ),
    );

    this.generate('ob-scoreboard');
  }

  /** Builds a deterministic roster. */
  generate(seed: string): void {
    const r = new Rand(seed);
    const names = r.shuffle([...CALLSIGNS]);
    const make = (n: number, offset: number): ScoreRow[] => {
      const out: ScoreRow[] = [];
      for (let i = 0; i < n; i++) {
        const kills = r.int(2, 26);
        out.push({
          name: names[offset + i],
          kills,
          deaths: r.int(2, 22),
          assists: r.int(0, 9),
          score: kills * 100 + r.int(0, 12) * 50,
          streak: r.pick(STREAKS),
        });
      }
      return out;
    };
    this.friendly = make(5, 0);
    this.hostile = make(6, 8);
    // Team scores are match state, not a sum of kills: derive a plausible,
    // decided-looking pair inside the limit.
    const lead = r.int(140, this.scoreLimit - 6);
    const trail = r.int(80, lead - 20);
    this.teamScore = r.bool(0.55) ? [lead, trail] : [trail, lead];
  }

  /** Overrides the header score, e.g. from the game mode's live state. */
  setTeamScore(friendly: number, hostile: number, limit = 200): void {
    this.teamScore = [friendly, hostile];
    this.scoreLimit = limit;
  }

  setOpen(open: boolean, snap = false): void {
    if (this.open === open) return;
    this.open = open;
    if (snap) {
      const prev = this.root.style.transition;
      this.root.style.transition = 'none';
      this.root.classList.toggle('is-open', open);
      void this.root.offsetHeight;
      this.root.style.transition = prev;
    } else {
      this.root.classList.toggle('is-open', open);
    }
  }

  get isOpen(): boolean { return this.open; }

  update(m: HudModel): void {
    if (!this.open) return;
    const me: ScoreRow = {
      name: 'GHOST-ACTUAL',
      score: Math.round(m.score),
      kills: Math.max(0, Math.round(m.score / 100)),
      deaths: 4,
      assists: 3,
      streak: m.streaks.filter((s) => s.ready).map((s) => s.short).join('·') || '—',
      isPlayer: true,
    };
    const friendly = [...this.friendly, me].sort((a, b) => b.score - a.score);
    const hostile = [...this.hostile].sort((a, b) => b.score - a.score);

    clear(this.titleScore);
    this.titleScore.append(
      el('span', { style: { color: 'var(--ob-friendly)' }, text: String(this.teamScore[0]) }),
      el('span', { style: { color: 'var(--ob-faint)' }, text: '  –  ' }),
      el('span', { style: { color: 'var(--ob-hostile)' }, text: String(this.teamScore[1]) }),
    );

    this.fill(this.friendlyBody, friendly);
    this.fill(this.hostileBody, hostile);
  }

  private fill(body: HTMLElement, rows: ScoreRow[]): void {
    clear(body);
    for (const r of rows) {
      body.appendChild(el('tr', { class: r.isPlayer ? 'is-me' : '' },
        el('td', { text: r.name }),
        el('td', { text: String(r.score) }),
        el('td', { text: String(r.kills) }),
        el('td', { text: String(r.deaths) }),
        el('td', { text: String(r.assists) }),
        el('td', { text: r.streak }),
      ));
    }
  }
}
