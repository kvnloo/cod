/**
 * Post-match summary.
 *
 * Result lockup, a line-by-line score breakdown that counts itself up, medals,
 * an XP bar that animates from the pre-match level to the new one, and the final
 * scoreboard. The count-up is driven from `tick()` rather than CSS so it stays in
 * step with the rest of the frame and with reduced-motion settings.
 */

import { Rand } from '../../core/Rand';
import { clamp01, Ease, motion } from '../Anim';
import { el, stagger } from './Dom';
import { keyHint, menuFrame, Screen, type ScreenHost } from './MenuStack';

export interface ScoreLine {
  name: string;
  count: number;
  points: number;
}

export interface MatchSummary {
  win: boolean;
  mode: string;
  map: string;
  durationSeconds: number;
  scoreFriendly: number;
  scoreHostile: number;
  lines: ScoreLine[];
  medals: string[];
  kills: number;
  deaths: number;
  assists: number;
  accuracy: number;
  longestStreak: number;
  xpStart: number;
  xpEnd: number;
  xpPerLevel: number;
  level: number;
}

export function demoSummary(win: boolean, seed = 'ob-summary'): MatchSummary {
  const r = new Rand(seed);
  const kills = r.int(18, 34);
  const deaths = r.int(6, 17);
  return {
    win,
    mode: 'DOMINATION',
    map: 'BLACKOUT · UPLINK',
    durationSeconds: 8 * 60 + r.int(0, 59),
    scoreFriendly: win ? 200 : r.int(120, 186),
    scoreHostile: win ? r.int(120, 186) : 200,
    lines: [
      { name: 'Eliminations', count: kills, points: kills * 100 },
      { name: 'Assists', count: r.int(4, 12), points: r.int(4, 12) * 50 },
      { name: 'Objectives Captured', count: r.int(2, 6), points: r.int(2, 6) * 200 },
      { name: 'Objective Defends', count: r.int(1, 7), points: r.int(1, 7) * 100 },
      { name: 'Headshots', count: r.int(3, 11), points: r.int(3, 11) * 50 },
      { name: 'Killstreaks Earned', count: r.int(1, 4), points: r.int(1, 4) * 300 },
      { name: 'Match Bonus', count: 1, points: win ? 1500 : 500 },
    ],
    medals: win
      ? ['Hardpoint Hero', 'Marksman', 'Frontline', 'Untouchable']
      : ['Marksman', 'Frontline'],
    kills,
    deaths,
    assists: r.int(4, 12),
    accuracy: r.range(0.22, 0.48),
    longestStreak: r.int(3, 11),
    xpStart: 0.32,
    xpEnd: 0.86,
    xpPerLevel: 12000,
    level: 42,
  };
}

export class SummaryMenu extends Screen {
  private data: MatchSummary = demoSummary(true);
  private t = 0;
  private pointNodes: HTMLElement[] = [];
  private totalNode: HTMLElement | null = null;
  private xpFill: HTMLElement | null = null;
  private resultNode: HTMLElement | null = null;
  private subNode: HTMLElement | null = null;
  private breakHost: HTMLElement | null = null;
  private medalHost: HTMLElement | null = null;
  private statHost: HTMLElement | null = null;

  constructor(host: ScreenHost, private onContinue: () => void) {
    super('summary', host);
  }

  setData(data: MatchSummary): void {
    this.data = data;
    if (this.built) this.render();
  }

  protected build(): void {
    const parts = menuFrame(this, 'MATCH SUMMARY', 'After Action Report', 'cols-2');
    parts.body.style.gridTemplateColumns = 'minmax(0,1.05fr) minmax(0,1fr)';
    parts.body.style.alignItems = 'start';

    const result = el('div', { class: 'ob-result' });
    const sub = el('div', { class: 'ob-result-sub' });
    this.resultNode = result;
    this.subNode = sub;

    const breaks = el('div', {});
    this.breakHost = breaks;

    const total = el('div', { class: 'ob-break-pts', style: { fontSize: 'calc(var(--ob-u)*26)' } });
    this.totalNode = total;

    const xp = el('div', { class: 'ob-xpbar' });
    const fill = el('i');
    this.xpFill = fill;
    xp.appendChild(fill);

    const left = el('div', { class: 'ob-panel ob-stagger' },
      result,
      sub,
      el('div', { class: 'ob-sb-bar' }),
      breaks,
      el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginTop: 'calc(var(--ob-u)*10)',
        },
      },
        el('div', { class: 'ob-break-name', text: 'Total Score' }),
        total,
      ),
      el('div', { style: { marginTop: 'calc(var(--ob-u)*16)' } },
        el('div', { class: 'ob-brand-sub', text: 'Rank Progress' }),
        xp,
      ),
    );
    stagger(left, 0);

    const medals = el('div', { class: 'ob-medals' });
    this.medalHost = medals;
    const statTable = el('div', {});
    this.statHost = statTable;

    const right = el('div', { class: 'ob-panel ob-stagger' },
      el('div', { class: 'ob-panel-title' }, el('span', { text: 'Performance' })),
      statTable,
      el('div', { class: 'ob-panel-title', style: { marginTop: 'calc(var(--ob-u)*18)' } },
        el('span', { text: 'Medals' })),
      medals,
    );
    stagger(right, 1);

    parts.body.append(left, right);
    parts.footerLeft.append(keyHint('ENTER', 'Continue'));
    parts.footerRight.textContent = '';
    parts.footerRight.appendChild(el('button', {
      class: 'ob-btn is-primary', type: 'button', text: 'Continue',
      on: { click: () => this.onContinue() },
    }));

    this.render();
  }

  override onOpen(): void {
    this.t = 0;
    this.render();
  }

  override tick(dt: number): void {
    this.t += dt;
    const reveal = motion() > 0.02 ? this.t : 99;
    let running = 0;
    for (let i = 0; i < this.data.lines.length; i++) {
      const line = this.data.lines[i];
      const start = 0.28 + i * 0.13;
      const k = Ease.outQuart(clamp01((reveal - start) / 0.42));
      const shown = Math.round(line.points * k);
      running += shown;
      const node = this.pointNodes[i];
      if (node) node.textContent = shown > 0 ? `+${shown}` : '—';
    }
    if (this.totalNode) this.totalNode.textContent = String(running);
    if (this.xpFill) {
      const k = Ease.outQuart(clamp01((reveal - 1.15) / 1.6));
      const v = this.data.xpStart + (this.data.xpEnd - this.data.xpStart) * k;
      this.xpFill.style.width = `${(v * 100).toFixed(1)}%`;
    }
  }

  private render(): void {
    const d = this.data;
    if (this.resultNode) {
      this.resultNode.textContent = d.win ? 'VICTORY' : 'DEFEAT';
      this.resultNode.classList.toggle('is-win', d.win);
      this.resultNode.classList.toggle('is-loss', !d.win);
    }
    if (this.subNode) {
      const mins = Math.floor(d.durationSeconds / 60);
      const secs = d.durationSeconds % 60;
      this.subNode.textContent =
        `${d.mode}  ·  ${d.map}  ·  ${d.scoreFriendly} – ${d.scoreHostile}  ·  `
        + `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    if (this.breakHost) {
      const host = this.breakHost;
      while (host.firstChild) host.removeChild(host.firstChild);
      this.pointNodes = [];
      for (const line of d.lines) {
        const pts = el('div', { class: 'ob-break-pts', text: '—' });
        this.pointNodes.push(pts);
        host.appendChild(el('div', { class: 'ob-break' },
          el('div', { class: 'ob-break-name', text: line.name }),
          el('div', { class: 'ob-break-count', text: `×${line.count}` }),
          pts,
        ));
      }
    }

    if (this.statHost) {
      const host = this.statHost;
      while (host.firstChild) host.removeChild(host.firstChild);
      const rows: Array<[string, string]> = [
        ['Eliminations', String(d.kills)],
        ['Deaths', String(d.deaths)],
        ['Assists', String(d.assists)],
        ['K/D Ratio', (d.kills / Math.max(1, d.deaths)).toFixed(2)],
        ['Accuracy', `${Math.round(d.accuracy * 100)}%`],
        ['Longest Streak', String(d.longestStreak)],
      ];
      for (const [name, value] of rows) {
        host.appendChild(el('div', { class: 'ob-break' },
          el('div', { class: 'ob-break-name', text: name }),
          el('div', { class: 'ob-break-count', text: '' }),
          el('div', { class: 'ob-break-pts', text: value }),
        ));
      }
    }

    if (this.medalHost) {
      const host = this.medalHost;
      while (host.firstChild) host.removeChild(host.firstChild);
      for (const m of d.medals) host.appendChild(el('div', { class: 'ob-medal', text: m }));
    }
  }
}
