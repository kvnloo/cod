/**
 * Director debug HUD.
 *
 * The shipping combat HUD belongs to `src/ui` and, once it exists, it renders
 * the director's events far better than this does — so this defers to it. Four
 * modes:
 *
 *   hidden     nothing (the default; the real HUD is on screen)
 *   telemetry  a director state card: pacing beat, intensity, spawn budget
 *   summary    the post-match screen, from the real `MatchSummary`
 *   selftest   the deterministic state-machine report
 *   full       the complete stand-in HUD, for when `src/ui` is still a stub
 *
 * It is only ever mounted by the `--debug game` scene.
 */

import { bus } from '../core/EventBus';
import { formatClock } from './Match';
import type { DirectorSnapshot } from './types';
import type { SelfTestReport } from './SelfTest';
import './events';

const CSS = `
#dbg-hud { position:absolute; inset:0; z-index:30; pointer-events:none;
  font-family:'Barlow',system-ui,sans-serif;
  color:#e9f0fa; letter-spacing:.02em; text-shadow:0 1px 3px rgba(0,0,0,.85); }
#dbg-hud .mono { font-family:'JetBrains Mono',monospace; }
#dbg-hud .cond { font-family:'Barlow Condensed','Barlow',sans-serif; text-transform:uppercase; }

#dbg-hud .panel { background:linear-gradient(180deg,rgba(8,12,18,.72),rgba(8,12,18,.42));
  border:1px solid rgba(190,215,255,.16); border-left:2px solid rgba(140,190,255,.5);
  backdrop-filter:blur(3px); }

/* top-left mode block */
#dbg-mode { position:absolute; left:26px; top:22px; min-width:206px; padding:9px 13px 10px; }
#dbg-mode .t { font-size:11px; letter-spacing:.32em; color:#8fb4e0; }
#dbg-mode .v { font-size:29px; font-weight:700; line-height:1.02; }
#dbg-mode .s { font-size:11.5px; letter-spacing:.16em; color:#a8bdd6; margin-top:3px; }
#dbg-mode .bar { height:3px; margin-top:8px; background:rgba(255,255,255,.12); }
#dbg-mode .bar > i { display:block; height:100%; background:linear-gradient(90deg,#ff7a3c,#ffd08a); }

/* score strip */
#dbg-score { position:absolute; left:50%; top:20px; transform:translateX(-50%);
  display:flex; align-items:center; gap:16px; padding:7px 20px; }
#dbg-score .team { font-size:27px; font-weight:700; line-height:1; }
#dbg-score .team.f { color:#7fc4ff; } #dbg-score .team.e { color:#ff8a72; }
#dbg-score .clock { font-size:16px; letter-spacing:.14em; color:#dbe7f6; }

/* objective banner */
#dbg-obj { position:absolute; left:50%; top:96px; transform:translateX(-50%);
  text-align:center; width:min(640px,72vw); }
#dbg-obj .lab { font-size:23px; font-weight:700; letter-spacing:.14em; }
#dbg-obj .hint { font-size:12.5px; letter-spacing:.1em; color:#b7c9de; margin-top:2px; }
#dbg-obj .bar { height:4px; margin:8px auto 0; width:230px; background:rgba(255,255,255,.13); }
#dbg-obj .bar > i { display:block; height:100%; background:#6fd0ff; box-shadow:0 0 10px rgba(110,200,255,.85); }
#dbg-obj.contested .bar > i { background:#ffa33c; box-shadow:0 0 10px rgba(255,163,60,.9); }
#dbg-obj .tmr { font-size:12px; letter-spacing:.22em; color:#ffcf8a; margin-top:5px; }

/* announcement */
#dbg-ann { position:absolute; left:50%; top:196px; transform:translateX(-50%);
  font-size:38px; font-weight:700; letter-spacing:.2em; color:#ffe9c2;
  text-shadow:0 0 26px rgba(255,190,110,.6),0 2px 4px #000; opacity:0; }

/* banner */
#dbg-banner { position:absolute; left:50%; top:240px; transform:translateX(-50%);
  text-align:center; opacity:0; }
#dbg-banner .a { font-size:30px; font-weight:700; letter-spacing:.18em; }
#dbg-banner .b { font-size:13px; letter-spacing:.16em; color:#b9cbe0; margin-top:3px; }

/* minimap */
#dbg-map { position:absolute; right:26px; top:22px; width:186px; height:186px;
  border:1px solid rgba(190,215,255,.2); background:rgba(6,10,16,.55); }
#dbg-map canvas { width:100%; height:100%; display:block; }
#dbg-map .cap { position:absolute; left:8px; bottom:6px; font-size:9.5px; letter-spacing:.22em; color:#8fb4e0; }

/* health + rank */
#dbg-vitals { position:absolute; left:26px; bottom:26px; width:290px; }
#dbg-vitals .hp { height:7px; background:rgba(255,255,255,.13); border:1px solid rgba(255,255,255,.16); }
#dbg-vitals .hp > i { display:block; height:100%; background:linear-gradient(90deg,#4dff9a,#b7ffd4); }
#dbg-vitals .hp.low > i { background:linear-gradient(90deg,#ff4b3a,#ff9d7a); }
#dbg-vitals .row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px; }
#dbg-vitals .rank { font-size:12px; letter-spacing:.2em; color:#9fb8d4; }
#dbg-vitals .xp { height:3px; margin-top:7px; background:rgba(255,255,255,.1); }
#dbg-vitals .xp > i { display:block; height:100%; background:linear-gradient(90deg,#5c8cff,#a9c8ff); }
#dbg-vitals .num { font-size:26px; font-weight:700; }

/* killstreaks */
#dbg-ks { position:absolute; right:26px; bottom:26px; display:flex; gap:9px; align-items:flex-end; }
#dbg-ks .slot { width:78px; padding:8px 6px 7px; text-align:center; }
#dbg-ks .slot .n { font-size:12.5px; font-weight:700; letter-spacing:.1em; }
#dbg-ks .slot .c { font-size:9.5px; letter-spacing:.18em; color:#94aec9; margin-top:2px; }
#dbg-ks .slot.sel { border-left-color:#ffb347; box-shadow:0 0 0 1px rgba(255,179,71,.35) inset; }
#dbg-ks .slot.act { border-left-color:#5fe8a0; }
#dbg-ks .next { padding:8px 11px; font-size:11px; letter-spacing:.16em; color:#a8bdd6; }

/* buy menu */
#dbg-buy { position:absolute; left:50%; bottom:26px; transform:translateX(-50%);
  display:flex; gap:11px; }
#dbg-buy .card { width:186px; padding:11px 13px 12px; }
#dbg-buy .card .k { font-size:10px; letter-spacing:.24em; color:#8fb4e0; }
#dbg-buy .card .n { font-size:15px; font-weight:700; margin-top:3px; }
#dbg-buy .card .d { font-size:11px; color:#a9bdd3; margin-top:3px; min-height:26px; }
#dbg-buy .card .p { font-size:16px; font-weight:700; color:#ffd479; margin-top:5px; }
#dbg-buy .card.no { opacity:.42; }

/* feed */
#dbg-feed { position:absolute; right:26px; top:224px; width:246px; text-align:right; }
#dbg-feed div { font-size:11.5px; letter-spacing:.06em; color:#cfdcec; margin-bottom:3px; }
#dbg-feed b { color:#ffd479; font-weight:700; }

/* crosshair */
#dbg-cross { position:absolute; left:50%; top:50%; width:22px; height:22px; margin:-11px 0 0 -11px; }
#dbg-cross i { position:absolute; background:rgba(233,240,250,.9); box-shadow:0 0 4px rgba(0,0,0,.9); }

/* summary */
#dbg-sum { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
  background:radial-gradient(120% 90% at 50% 45%,rgba(6,10,16,.82),rgba(3,5,8,.94)); }
#dbg-sum.on { display:flex; }
#dbg-sum .box { width:min(880px,86vw); padding:30px 38px 32px; }
#dbg-sum .hd { font-size:40px; font-weight:700; letter-spacing:.16em; }
#dbg-sum .sub { font-size:12px; letter-spacing:.3em; color:#93b0cf; margin-top:2px; }
#dbg-sum .grid { display:grid; grid-template-columns:repeat(5,1fr); gap:14px 22px; margin-top:24px; }
#dbg-sum .cell .k { font-size:10px; letter-spacing:.22em; color:#8fb4e0; }
#dbg-sum .cell .v { font-size:22px; font-weight:700; margin-top:2px; }
#dbg-sum .xpbar { margin-top:26px; }
#dbg-sum .xpbar .t { display:flex; justify-content:space-between; font-size:11.5px; letter-spacing:.16em; color:#a9bdd3; }
#dbg-sum .xpbar .b { height:6px; margin-top:6px; background:rgba(255,255,255,.12); }
#dbg-sum .xpbar .b > i { display:block; height:100%; background:linear-gradient(90deg,#5c8cff,#a9c8ff); }
#dbg-sum .rows { margin-top:22px; column-count:2; column-gap:38px; }
#dbg-sum .rows div { display:flex; justify-content:space-between; font-size:12px;
  padding:3px 0; border-bottom:1px solid rgba(255,255,255,.07); break-inside:avoid; }
#dbg-sum .rows span:last-child { color:#ffd479; font-weight:700; }

/* telemetry */
#dbg-tel { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(620px,72vw); padding:22px 26px 24px; display:none; }
#dbg-tel.on { display:block; }
#dbg-tel .hd { font-size:23px; font-weight:700; letter-spacing:.18em; margin-bottom:14px; }
#dbg-tel .g { display:grid; grid-template-columns:repeat(3,1fr); gap:12px 20px; }
#dbg-tel .c .k { font-size:9.5px; letter-spacing:.22em; color:#8fb4e0; }
#dbg-tel .c .v { font-size:19px; font-weight:700; margin-top:1px; }
#dbg-tel .meter { margin-top:16px; }
#dbg-tel .meter .l { display:flex; justify-content:space-between; font-size:10px;
  letter-spacing:.2em; color:#a9bdd3; }
#dbg-tel .meter .b { height:6px; margin:5px 0 10px; background:rgba(255,255,255,.11); position:relative; }
#dbg-tel .meter .b > i { display:block; height:100%; background:linear-gradient(90deg,#ff7a3c,#ffd08a); }
#dbg-tel .meter .b > u { position:absolute; top:-3px; width:2px; height:12px; background:#8fd4ff; }

/* self-test */
#dbg-test { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(760px,84vw); padding:24px 30px 26px; display:none; }
#dbg-test.on { display:block; }
#dbg-test .hd { font-size:26px; font-weight:700; letter-spacing:.16em; }
#dbg-test .hd em { font-style:normal; }
#dbg-test .ln { display:flex; justify-content:space-between; gap:18px; font-size:12px;
  padding:4px 0; border-bottom:1px solid rgba(255,255,255,.07); }
#dbg-test .ok { color:#6fe8a4; } #dbg-test .no { color:#ff7a63; }
#dbg-test .det { color:#8fa6bf; font-size:11px; }
#dbg-test .tr { margin-top:14px; font-size:11.5px; color:#a9bdd3; letter-spacing:.08em; }
`;

interface FeedLine { text: string; ttl: number; el: HTMLElement; }

export class DebugHud {
  readonly root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private map: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D | null;
  private feed: FeedLine[] = [];
  private announceText = '';
  private announceTtl = 0;
  private unsubs: Array<() => void> = [];
  private testReport: SelfTestReport | null = null;
  private lastSnapshot: DirectorSnapshot | null = null;
  private mode: HudMode = 'hidden';
  private telemetry: TelemetrySource | null = null;

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.id = 'dbg-hud-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'dbg-hud';
    this.root.innerHTML = `
      <div id="dbg-mode" class="panel">
        <div class="t cond" data-k="modeName">OPERATION</div>
        <div class="v cond" data-k="waveTitle">WAVE 1</div>
        <div class="s cond" data-k="waveLabel">PROBING ATTACK</div>
        <div class="bar"><i data-k="intensity"></i></div>
      </div>

      <div id="dbg-score" class="panel">
        <div class="team f cond" data-k="teamScore">0</div>
        <div class="clock mono" data-k="clock">--:--</div>
        <div class="team e cond" data-k="enemyScore">0</div>
      </div>

      <div id="dbg-obj">
        <div class="lab cond" data-k="objLabel"></div>
        <div class="hint" data-k="objHint"></div>
        <div class="bar"><i data-k="objBar"></i></div>
        <div class="tmr mono" data-k="objTimer"></div>
      </div>

      <div id="dbg-ann" class="cond"></div>
      <div id="dbg-banner"><div class="a cond" data-k="bTitle"></div><div class="b cond" data-k="bSub"></div></div>

      <div id="dbg-map"><canvas width="372" height="372"></canvas><div class="cap mono">TACMAP</div></div>
      <div id="dbg-feed"></div>

      <div id="dbg-vitals">
        <div class="row">
          <div class="num cond" data-k="hpNum">100</div>
          <div class="rank cond" data-k="rank">RECRUIT · 1</div>
        </div>
        <div class="hp"><i data-k="hpBar"></i></div>
        <div class="xp"><i data-k="xpBar"></i></div>
      </div>

      <div id="dbg-ks"></div>
      <div id="dbg-buy"></div>

      <div id="dbg-cross">
        <i style="left:10px;top:0;width:2px;height:7px"></i>
        <i style="left:10px;bottom:0;width:2px;height:7px"></i>
        <i style="top:10px;left:0;height:2px;width:7px"></i>
        <i style="top:10px;right:0;height:2px;width:7px"></i>
      </div>

      <div id="dbg-sum"><div class="box panel">
        <div class="hd cond" data-k="sumTitle">MISSION ACCOMPLISHED</div>
        <div class="sub cond" data-k="sumSub">OPERATION</div>
        <div class="grid" data-k="sumGrid"></div>
        <div class="xpbar"><div class="t cond"><span data-k="sumRank">SERGEANT · 9</span><span data-k="sumXp">+0 XP</span></div>
          <div class="b"><i data-k="sumXpBar"></i></div></div>
        <div class="rows" data-k="sumRows"></div>
      </div></div>

      <div id="dbg-tel" class="panel">
        <div class="hd cond">PACING DIRECTOR — LIVE STATE</div>
        <div class="g" data-k="telGrid"></div>
        <div class="meter">
          <div class="l cond"><span>INTENSITY</span><span data-k="telInt">0.00</span></div>
          <div class="b"><i data-k="telIntBar"></i><u data-k="telIntMark"></u></div>
          <div class="l cond"><span>ENGAGEMENT PRESSURE</span><span data-k="telPre">0 / 0</span></div>
          <div class="b"><i data-k="telPreBar"></i></div>
        </div>
      </div>

      <div id="dbg-test" class="panel">
        <div class="hd cond" data-k="testTitle">MATCH STATE MACHINE — SELF TEST</div>
        <div data-k="testBody"></div>
        <div class="tr mono" data-k="testTransitions"></div>
      </div>
    `;
    parent.appendChild(this.root);

    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('[data-k]'))) {
      this.els[el.dataset.k!] = el;
    }
    this.map = this.root.querySelector('canvas')!;
    this.ctx2d = this.map.getContext('2d');

    this.unsubs.push(bus.on('hud:snapshot', (s) => this.apply(s)));
    this.unsubs.push(bus.on('hud:announce', (e) => { this.announceText = e.text; this.announceTtl = 1.8; }));
    this.unsubs.push(bus.on('hud:score', (e) => this.push(`${e.reason} <b>+${e.amount}</b>`)));
    this.unsubs.push(bus.on('killstreak:ready', (e) => this.push(`${e.name.toUpperCase()} <b>READY</b>`)));
    this.unsubs.push(bus.on('entity:death', (e) => {
      if (e.name !== 'player') this.push(`<b>YOU</b> ▸ ${e.name.toUpperCase()}${e.headshot ? ' ⌖' : ''}`);
    }));
    this.unsubs.push(bus.on('objective:complete', (e) => this.push(`OBJECTIVE <b>${e.label}</b>`)));
    this.unsubs.push(bus.on('ai:voice', (e) => this.push(`“${e.line}”`)));
  }

  /** Chooses what, if anything, this overlay draws. */
  setMode(mode: HudMode): void {
    this.mode = mode;
    const full = mode === 'full';
    for (const id of COMBAT_PIECES) {
      const el = this.root.querySelector<HTMLElement>(`#${id}`);
      if (el) el.style.display = full ? '' : 'none';
    }
    this.root.querySelector<HTMLElement>('#dbg-sum')!.style.display =
      (mode === 'summary' || full) ? '' : 'none';
    this.root.querySelector<HTMLElement>('#dbg-test')!.classList.toggle('on', mode === 'selftest');
    this.root.querySelector<HTMLElement>('#dbg-tel')!.classList.toggle('on', mode === 'telemetry');
    this.root.style.display = mode === 'hidden' ? 'none' : '';
  }

  setTelemetrySource(src: TelemetrySource | null): void { this.telemetry = src; }

  setSelfTest(report: SelfTestReport | null): void {
    this.testReport = report;
    if (!report) return;
    const title = this.els.testTitle;
    title.innerHTML = `MATCH STATE MACHINE — <em class="${report.pass ? 'ok' : 'no'}">${report.pass ? 'PASS' : 'FAIL'}</em> · ${report.ms.toFixed(0)}MS`;
    this.els.testBody.innerHTML = report.cases.map((c) => `
      <div class="ln"><span class="${c.pass ? 'ok' : 'no'}">${c.pass ? '✓' : '✗'} ${escapeHtml(c.name)}</span>
      <span class="det mono">${escapeHtml(c.detail)}</span></div>`).join('');
    this.els.testTransitions.textContent =
      `phases: ${report.transitions.join(' → ')}   ·   hashes: ${Object.entries(report.hashes).map(([k, v]) => `${k}=${v}`).join('  ')}`;
  }

  private push(html: string): void {
    const el = document.createElement('div');
    el.innerHTML = html;
    const feedEl = this.root.querySelector('#dbg-feed')!;
    feedEl.insertBefore(el, feedEl.firstChild);
    this.feed.unshift({ text: html, ttl: 6, el });
    while (this.feed.length > 6) {
      const last = this.feed.pop()!;
      last.el.remove();
    }
  }

  update(dt: number): void {
    if (this.mode === 'telemetry') this.drawTelemetry();
    if (this.mode !== 'full') return;
    if (this.announceTtl > 0) {
      this.announceTtl -= dt;
      const el = this.root.querySelector<HTMLElement>('#dbg-ann')!;
      el.textContent = this.announceText;
      el.style.opacity = String(Math.min(1, this.announceTtl * 2.4));
    }
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.ttl -= dt;
      f.el.style.opacity = String(Math.max(0, Math.min(1, f.ttl)));
      if (f.ttl <= 0) { f.el.remove(); this.feed.splice(i, 1); }
    }
    if (this.lastSnapshot) this.drawMap(this.lastSnapshot);
  }

  private apply(s: DirectorSnapshot): void {
    this.lastSnapshot = s;
    if (this.mode === 'hidden' || this.mode === 'telemetry' || this.mode === 'selftest') return;
    const e = this.els;

    e.modeName.textContent = s.modeName;
    e.waveTitle.textContent = s.mode === 'tdm'
      ? 'TEAM DEATHMATCH'
      : `${s.mode === 'firefight' ? 'BEAT' : 'WAVE'} ${Math.max(1, s.wave)}${s.waveTotal ? ` / ${s.waveTotal}` : ''}`;
    e.waveLabel.textContent = s.waveLabel || s.phase.toUpperCase();
    e.intensity.style.width = `${Math.round(s.intensity * 100)}%`;

    e.teamScore.textContent = String(s.mode === 'tdm' ? s.teamScore : s.score);
    e.enemyScore.textContent = String(s.mode === 'tdm' ? s.enemyScore : s.enemiesAlive);
    e.clock.textContent = s.timeRemaining >= 0 ? formatClock(s.timeRemaining) : formatClock(s.matchTime);

    /* objective */
    const obj = s.objectives.find((o) => o.state === 'active') ?? s.objectives[0] ?? null;
    const objBox = this.root.querySelector<HTMLElement>('#dbg-obj')!;
    objBox.style.opacity = obj ? '1' : '0';
    objBox.classList.toggle('contested', !!obj?.contested);
    if (obj) {
      e.objLabel.textContent = obj.label;
      e.objHint.textContent = obj.hint;
      e.objBar.style.width = `${Math.round(obj.progress * 100)}%`;
      e.objTimer.textContent = obj.timer >= 0 ? formatClock(obj.timer) : '';
    }

    /* banner */
    const bannerBox = this.root.querySelector<HTMLElement>('#dbg-banner')!;
    if (s.banner) {
      bannerBox.style.opacity = String(Math.min(1, s.banner.ttl * 1.6));
      e.bTitle.textContent = s.banner.title;
      e.bSub.textContent = s.banner.subtitle;
    } else bannerBox.style.opacity = '0';

    /* vitals */
    const hp = s.maxHealth > 0 ? s.health / s.maxHealth : 0;
    e.hpNum.textContent = String(Math.max(0, Math.round(s.health)));
    e.hpBar.style.width = `${Math.round(hp * 100)}%`;
    e.hpBar.parentElement!.classList.toggle('low', hp < 0.4);
    e.rank.textContent = `${s.rankName} · ${s.rank}`;
    e.xpBar.style.width = `${Math.round((s.xpIntoRank / Math.max(1, s.xpForNext)) * 100)}%`;

    /* killstreaks */
    const ks = this.root.querySelector<HTMLElement>('#dbg-ks')!;
    const next = s.killstreaks.length === 0
      ? `<div class="next panel cond">Streak ${s.streak}</div>` : '';
    ks.innerHTML = next + s.killstreaks.map((k) => `
      <div class="slot panel ${k.selected ? 'sel' : ''} ${k.active ? 'act' : ''}">
        <div class="n cond">${escapeHtml(shortName(k.name))}</div>
        <div class="c mono">${k.active && k.remaining >= 0 ? `${Math.ceil(k.remaining)}s` : `×${k.cost}`}</div>
      </div>`).join('');

    /* buy menu */
    const buy = this.root.querySelector<HTMLElement>('#dbg-buy')!;
    if (s.phase === 'intermission' && s.offers.length) {
      buy.innerHTML = s.offers.slice(0, 3).map((o, i) => `
        <div class="card panel ${o.affordable ? '' : 'no'}">
          <div class="k mono">[${i + 1}] ${o.kind.toUpperCase()}</div>
          <div class="n cond">${escapeHtml(o.name)}</div>
          <div class="d">${escapeHtml(o.detail)}</div>
          <div class="p mono">$${o.cost}</div>
        </div>`).join('');
      buy.style.display = 'flex';
    } else buy.style.display = 'none';

    /* summary */
    const sum = this.root.querySelector<HTMLElement>('#dbg-sum')!;
    if (s.summary) {
      sum.classList.add('on');
      const m = s.summary;
      e.sumTitle.textContent = m.win ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
      e.sumSub.textContent = `${m.modeName} · SEED ${m.seed} · REPLAY ${m.replayHash}`;
      e.sumGrid.innerHTML = [
        ['SCORE', String(m.score)], ['KILLS', String(m.kills)], ['DEATHS', String(m.deaths)],
        ['HEADSHOTS', String(m.headshots)], ['BEST STREAK', String(m.bestStreak)],
        ['ACCURACY', `${(m.accuracy * 100).toFixed(0)}%`], ['ASSISTS', String(m.assists)],
        ['OBJECTIVES', String(m.objectivesComplete)], ['WAVES', String(m.wavesCleared)],
        ['TIME', formatClock(m.durationSec)],
      ].map(([k, v]) => `<div class="cell"><div class="k mono">${k}</div><div class="v cond">${v}</div></div>`).join('');
      e.sumRank.textContent = `${m.rankName.toUpperCase()} · ${m.rankAfter}`;
      e.sumXp.textContent = `+${m.xpEarned} XP`;
      e.sumXpBar.style.width = `${Math.round((m.xpIntoRank / Math.max(1, m.xpForNext)) * 100)}%`;
      e.sumRows.innerHTML = m.rows.filter((r) => r.xp !== undefined)
        .map((r) => `<div><span>${escapeHtml(r.label)}</span><span>${escapeHtml(r.value)}</span></div>`).join('')
        || m.rows.slice(0, 8).map((r) => `<div><span>${escapeHtml(r.label)}</span><span>${escapeHtml(r.value)}</span></div>`).join('');
    } else sum.classList.remove('on');
  }

  /** Radar: player-centred, north-up, with UAV contacts and objective rings. */
  private drawMap(s: DirectorSnapshot): void {
    const g = this.ctx2d;
    if (!g) return;
    const w = this.map.width;
    const h = this.map.height;
    const cx = w / 2;
    const cy = h / 2;
    const scale = w / 150;

    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(8,14,22,0.55)';
    g.fillRect(0, 0, w, h);

    g.strokeStyle = 'rgba(150,190,240,0.10)';
    g.lineWidth = 2;
    for (let i = 1; i <= 3; i++) {
      g.beginPath();
      g.arc(cx, cy, (i / 3) * (w * 0.46), 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.moveTo(0, cy); g.lineTo(w, cy); g.stroke();

    const px = s.contacts.length ? 0 : 0;
    void px;

    /* objectives */
    for (const o of s.objectives) {
      if (!o.position || o.state !== 'active') continue;
      g.strokeStyle = o.contested ? 'rgba(255,163,60,0.9)' : 'rgba(110,200,255,0.9)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx + o.position[0] * scale, cy + o.position[2] * scale, Math.max(6, o.radius * scale), 0, Math.PI * 2);
      g.stroke();
    }

    /* contacts */
    for (const c of s.contacts) {
      const x = cx + c.x * scale;
      const y = cy + c.z * scale;
      g.fillStyle = c.hostile ? 'rgba(255,96,72,0.95)' : 'rgba(110,200,255,0.95)';
      g.beginPath();
      g.moveTo(x, y - 7); g.lineTo(x + 6, y + 5); g.lineTo(x - 6, y + 5);
      g.closePath();
      g.fill();
    }

    /* the operator */
    g.fillStyle = 'rgba(235,244,255,0.98)';
    g.beginPath();
    g.moveTo(cx, cy - 9); g.lineTo(cx + 7, cy + 7); g.lineTo(cx, cy + 3); g.lineTo(cx - 7, cy + 7);
    g.closePath();
    g.fill();

    if (s.contacts.length === 0) {
      g.fillStyle = 'rgba(143,180,224,0.55)';
      g.font = "600 15px 'JetBrains Mono', monospace";
      g.textAlign = 'center';
      g.fillText('NO UAV', cx, h - 26);
    }
  }

  private drawTelemetry(): void {
    const t = this.telemetry;
    const s = this.lastSnapshot;
    if (!t || !s) return;
    const e = this.els;
    e.telGrid.innerHTML = [
      ['MODE', s.modeName], ['PHASE', s.phase.toUpperCase()], ['PACING BEAT', t.beat.toUpperCase()],
      ['WAVE', `${Math.max(1, s.wave)} / ${s.waveTotal || '—'}`], ['THREAT', t.threat.toFixed(2)],
      ['SPAWN BUDGET', t.budget < 0 ? '∞' : String(t.budget)],
      ['ALIVE', String(t.alive)], ['SPAWNED', String(t.spawned)], ['NAV NODES', String(t.nodes)],
      ['LIFECYCLE', t.lifecycle.toUpperCase()], ['SEED', String(t.seed)],
      ['REPLAY HASH', `${t.replayHash} · ${t.logEntries}`],
    ].map(([k, v]) => `<div class="c"><div class="k mono">${k}</div><div class="v cond">${escapeHtml(v)}</div></div>`).join('');
    e.telInt.textContent = `${t.intensity.toFixed(2)} → ${t.target.toFixed(2)}`;
    e.telIntBar.style.width = `${Math.round(t.intensity * 100)}%`;
    e.telIntMark.style.left = `${Math.round(t.target * 100)}%`;
    e.telPre.textContent = `${t.pressure.toFixed(1)} / ${t.pressureTarget.toFixed(1)}`;
    e.telPreBar.style.width = `${Math.round(Math.min(1, t.pressure / Math.max(0.001, t.pressureTarget)) * 100)}%`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
    document.getElementById('dbg-hud-style')?.remove();
  }
}

/** Live director numbers the telemetry card renders. */
export interface TelemetrySource {
  beat: string;
  intensity: number;
  target: number;
  pressure: number;
  pressureTarget: number;
  budget: number;
  alive: number;
  spawned: number;
  threat: number;
  nodes: number;
  lifecycle: string;
  seed: number;
  replayHash: string;
  logEntries: number;
}

export type HudMode = 'hidden' | 'telemetry' | 'summary' | 'selftest' | 'full';

const COMBAT_PIECES = [
  'dbg-mode', 'dbg-score', 'dbg-obj', 'dbg-map', 'dbg-feed',
  'dbg-vitals', 'dbg-ks', 'dbg-buy', 'dbg-cross', 'dbg-banner', 'dbg-ann',
];

function shortName(name: string): string {
  return name.replace(' Recon', '').replace('Precision ', '').replace(' Turret', '').toUpperCase();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}
