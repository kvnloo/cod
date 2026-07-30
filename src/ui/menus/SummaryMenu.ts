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
import type { ScoreRow } from '../widgets/Scoreboard';
import { el, stagger } from './Dom';
import { keyHint, menuFrame, Screen, type ScreenHost } from './MenuStack';

const CALLSIGNS = [
  'REAPER', 'VULTURE', 'HAVOC', 'SABLE', 'IRONHIDE', 'NOMAD', 'ZEALOT', 'KESTREL',
  'BADGER', 'CINDER', 'WRAITH', 'TALON', 'ONYX', 'MAVERICK', 'HALYARD', 'GRIT',
];
const STREAK_TAGS = ['—', 'UAV', 'CUAV', 'UAV·CLST', 'CLST', 'UAV·CUAV'];

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
  /** Final rosters. Optional so game modes can omit them and still get a screen. */
  friendly?: ScoreRow[];
  hostile?: ScoreRow[];
}

export function demoSummary(win: boolean, seed = 'ob-summary'): MatchSummary {
  const r = new Rand(seed);
  const kills = r.int(18, 34);
  const deaths = r.int(6, 17);
  const names = r.shuffle([...CALLSIGNS]);
  const roster = (n: number, offset: number, isPlayerAt = -1): ScoreRow[] => {
    const out: ScoreRow[] = [];
    for (let i = 0; i < n; i++) {
      const k = i === isPlayerAt ? kills : r.int(3, 26);
      out.push({
        name: i === isPlayerAt ? 'GHOST-ACTUAL' : names[offset + i],
        kills: k,
        deaths: i === isPlayerAt ? deaths : r.int(3, 22),
        assists: r.int(0, 9),
        score: k * 100 + r.int(0, 12) * 50,
        streak: r.pick(STREAK_TAGS),
        isPlayer: i === isPlayerAt,
      });
    }
    return out.sort((a, b) => b.score - a.score);
  };
  return {
    friendly: roster(6, 0, 0),
    hostile: roster(6, 8),
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
  private friendlyBody: HTMLElement | null = null;
  private hostileBody: HTMLElement | null = null;
  /** Objective-control strip along the bottom of the standings panel. */
  private readonly flowNode = el('div', {
    style: {
      display: 'flex', alignItems: 'flex-end', gap: '1px',
      height: 'calc(var(--ob-u)*54)', marginTop: 'calc(var(--ob-u)*10)',
    },
  });

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
    // Row 1 hugs its content; row 2 (final standings) stretches to the bottom
    // of the frame. `alignItems: start` on the whole grid would stop that.
    parts.body.style.alignItems = 'stretch';

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
    left.style.alignSelf = 'start';
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
    right.style.alignSelf = 'start';
    stagger(right, 1);

    // Final standings fill the bottom half. Without them a 16:9 summary is two
    // panels floating in a large void, which is the layout tell that separates a
    // mock-up from a shipped after-action report.
    this.friendlyBody = el('tbody');
    this.hostileBody = el('tbody');
    const standings = el('div', { class: 'ob-panel ob-stagger', style: { gridColumn: '1 / -1' } },
      el('div', { class: 'ob-panel-title' },
        el('span', { text: 'Final Standings' }),
        el('span', { text: `${this.data.mode}  ·  ${this.data.map}` }),
      ),
      el('div', { class: 'ob-sb-teams' },
        rosterTable('Task Force', 'var(--ob-friendly)', this.friendlyBody),
        rosterTable('Hostiles', 'var(--ob-hostile)', this.hostileBody),
      ),
      el('div', { class: 'ob-panel-title', style: { marginTop: 'calc(var(--ob-u)*20)' } },
        el('span', { text: 'Match Flow' }),
        el('span', { text: 'OBJECTIVE CONTROL OVER TIME' }),
      ),
      this.flowNode,
    );
    standings.style.display = 'grid';
    standings.style.gridTemplateRows = 'auto auto auto minmax(0,1fr)';
    stagger(standings, 2);

    parts.body.append(left, right, standings);
    parts.body.style.gridTemplateRows = 'auto minmax(0,1fr)';
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

    fillRoster(this.friendlyBody, d.friendly ?? []);
    fillRoster(this.hostileBody, d.hostile ?? []);
    this.renderFlow();
  }

  /**
   * Objective-control strip: one column per ~12 s of match time, its height and
   * colour showing which side held the majority of the objectives. Derived from
   * the same seeded RNG as the rest of the summary, so a capture is stable.
   */
  private renderFlow(): void {
    const host = this.flowNode;
    while (host.firstChild) host.removeChild(host.firstChild);
    const d = this.data;
    const r = new Rand(`flow-${d.mode}-${d.scoreFriendly}-${d.scoreHostile}`);
    const columns = 48;
    // Random walk biased toward the eventual winner so the strip tells the same
    // story as the score line above it.
    const bias = (d.scoreFriendly - d.scoreHostile) / 200;
    // Start on the losing side and drift across, so a 200–173 finish reads as a
    // match that was genuinely contested rather than a wall of one colour.
    let hold = -Math.sign(bias || 1) * 0.55;
    for (let i = 0; i < columns; i++) {
      hold = Math.max(-1, Math.min(1, hold + r.range(-0.5, 0.5) + bias * 0.14));
      const mag = Math.abs(hold);
      const friendly = hold >= 0;
      const bar = el('div', {
        style: {
          flex: '1 1 0',
          height: `${(18 + mag * 82).toFixed(1)}%`,
          background: friendly
            ? `rgba(79,195,255,${(0.22 + mag * 0.62).toFixed(2)})`
            : `rgba(255,61,51,${(0.22 + mag * 0.62).toFixed(2)})`,
        },
      });
      host.appendChild(bar);
    }
  }
}

/* ------------------------------------------------------------- standings -- */

function rosterTable(label: string, tint: string, body: HTMLElement): HTMLElement {
  return el('div', {},
    el('div', { class: 'ob-sb-team-name', style: { color: tint }, text: label.toUpperCase() }),
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
}

function fillRoster(body: HTMLElement | null, rows: ScoreRow[]): void {
  if (!body) return;
  while (body.firstChild) body.removeChild(body.firstChild);
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
