/**
 * Loadout / class selection.
 *
 * Left: the weapon list. Right: the weapon itself — drawn as a live technical
 * schematic — with its stat bars and five attachment slots. Fitting an
 * attachment applies its stat deltas immediately and the bars animate to the new
 * values with a green/red delta overlay, which is the whole point of the screen.
 *
 * Equipping publishes the result so the HUD's ammo panel and the weapon system
 * can pick it up; nothing is reached into directly.
 */

import { bus } from '../../core/EventBus';
import { weaponGlyph } from '../Glyphs';
import type { WeaponKind } from '../Model';
import { el, statBar, stagger } from './Dom';
import { keyHint, menuFrame, Screen, type ScreenHost } from './MenuStack';
import { drawWeaponSchematic, HARDPOINTS, SPECS } from './WeaponSchematic';

export interface LoadoutStats {
  damage: number;
  accuracy: number;
  range: number;
  fireRate: number;
  mobility: number;
  control: number;
}

export interface AttachmentOption {
  name: string;
  delta: Partial<LoadoutStats>;
}

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  className: string;
  level: number;
  magSize: number;
  reserve: number;
  fireMode: 'AUTO' | 'SEMI' | 'BURST' | 'PUMP' | 'BOLT';
  stats: LoadoutStats;
  blurb: string;
}

export interface EquippedLoadout {
  weapon: WeaponDef;
  attachments: Record<string, string | null>;
  stats: LoadoutStats;
}

const SLOTS = ['MUZZLE', 'BARREL', 'OPTIC', 'UNDERBARREL', 'MAGAZINE'] as const;
type SlotName = (typeof SLOTS)[number];

const ATTACHMENTS: Record<SlotName, AttachmentOption[]> = {
  MUZZLE: [
    { name: 'None', delta: {} },
    { name: 'Suppressor', delta: { range: -0.06, control: 0.05, accuracy: 0.03 } },
    { name: 'Compensator', delta: { control: 0.12, mobility: -0.03 } },
    { name: 'Flash Guard', delta: { control: 0.05, accuracy: 0.04 } },
  ],
  BARREL: [
    { name: 'Stock', delta: {} },
    { name: 'Long Barrel', delta: { range: 0.16, damage: 0.05, mobility: -0.09 } },
    { name: 'Short Barrel', delta: { mobility: 0.12, range: -0.11 } },
    { name: 'Heavy Barrel', delta: { control: 0.1, accuracy: 0.06, mobility: -0.08 } },
  ],
  OPTIC: [
    { name: 'Iron Sights', delta: {} },
    { name: 'Reflex', delta: { accuracy: 0.07 } },
    { name: 'Holographic', delta: { accuracy: 0.1, mobility: -0.02 } },
    { name: '4× Scope', delta: { accuracy: 0.16, range: 0.06, mobility: -0.07 } },
  ],
  UNDERBARREL: [
    { name: 'None', delta: {} },
    { name: 'Vertical Grip', delta: { control: 0.14, mobility: -0.04 } },
    { name: 'Angled Grip', delta: { accuracy: 0.08, control: 0.05, mobility: -0.02 } },
    { name: 'Bipod', delta: { control: 0.2, mobility: -0.1 } },
  ],
  MAGAZINE: [
    { name: 'Standard', delta: {} },
    { name: 'Extended', delta: { mobility: -0.06 } },
    { name: 'Fast Mag', delta: { fireRate: 0.04, mobility: 0.02 } },
    { name: 'Drum', delta: { mobility: -0.14, control: -0.04 } },
  ],
};

export const WEAPONS: WeaponDef[] = [
  {
    id: 'ar_vector', name: 'VKR-7', kind: 'ar', className: 'Assault Rifle', level: 42,
    magSize: 30, reserve: 210, fireMode: 'AUTO',
    stats: { damage: 0.62, accuracy: 0.7, range: 0.66, fireRate: 0.68, mobility: 0.58, control: 0.6 },
    blurb: 'Balanced 5.56 platform. Predictable first-shot recoil and a flat climb '
      + 'that rewards controlled bursts past thirty metres.',
  },
  {
    id: 'smg_wraith', name: 'WRAITH-9', kind: 'smg', className: 'Submachine Gun', level: 31,
    magSize: 36, reserve: 252, fireMode: 'AUTO',
    stats: { damage: 0.46, accuracy: 0.52, range: 0.34, fireRate: 0.92, mobility: 0.9, control: 0.44 },
    blurb: 'Extremely high cyclic rate and the fastest ADS in the armoury. Falls off '
      + 'hard past twenty metres.',
  },
  {
    id: 'lmg_bastion', name: 'BASTION', kind: 'lmg', className: 'Light Machine Gun', level: 27,
    magSize: 100, reserve: 300, fireMode: 'AUTO',
    stats: { damage: 0.72, accuracy: 0.5, range: 0.78, fireRate: 0.6, mobility: 0.24, control: 0.38 },
    blurb: 'Belt-fed suppression. Deploy the bipod and the recoil pattern collapses '
      + 'to almost nothing.',
  },
  {
    id: 'sn_longbow', name: 'LONGBOW', kind: 'sniper', className: 'Sniper Rifle', level: 38,
    magSize: 5, reserve: 40, fireMode: 'BOLT',
    stats: { damage: 0.98, accuracy: 0.94, range: 0.98, fireRate: 0.16, mobility: 0.3, control: 0.5 },
    blurb: 'Bolt-action .338. One shot, one kill above the waist at any range the '
      + 'engine will draw.',
  },
  {
    id: 'sg_breaker', name: 'BREAKER-12', kind: 'shotgun', className: 'Shotgun', level: 19,
    magSize: 8, reserve: 40, fireMode: 'PUMP',
    stats: { damage: 0.9, accuracy: 0.3, range: 0.14, fireRate: 0.34, mobility: 0.66, control: 0.32 },
    blurb: 'Room clearance. Devastating inside ten metres, useless outside it.',
  },
  {
    id: 'pi_sidewinder', name: 'SIDEWINDER', kind: 'pistol', className: 'Sidearm', level: 12,
    magSize: 15, reserve: 90, fireMode: 'SEMI',
    stats: { damage: 0.4, accuracy: 0.6, range: 0.3, fireRate: 0.6, mobility: 0.98, control: 0.62 },
    blurb: 'Fast swap, fast reload. The answer when the primary runs dry mid-push.',
  },
];

const STAT_ORDER: Array<[keyof LoadoutStats, string]> = [
  ['damage', 'Damage'],
  ['accuracy', 'Accuracy'],
  ['range', 'Range'],
  ['fireRate', 'Fire Rate'],
  ['mobility', 'Mobility'],
  ['control', 'Control'],
];

export class LoadoutMenu extends Screen {
  private selected = 0;
  private attachments: Record<string, number> = {};
  private canvas: HTMLCanvasElement | null = null;
  private cctx: CanvasRenderingContext2D | null = null;
  private statHost: HTMLElement | null = null;
  private attHost: HTMLElement | null = null;
  private infoHost: HTMLElement | null = null;
  private listHost: HTMLElement | null = null;
  private t = 0;

  constructor(host: ScreenHost, private onEquip: (l: EquippedLoadout) => void) {
    super('loadout', host);
    for (const s of SLOTS) this.attachments[s] = 0;
  }

  protected build(): void {
    const parts = menuFrame(this, 'LOADOUT', 'Class Configuration', 'cols-nav');

    /* -------------------------------------------------- weapon list -- */
    const list = el('div', { class: 'ob-weapon-list' });
    this.listHost = list;
    const leftPanel = el('div', {
      class: 'ob-panel ob-stagger',
      style: { display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', minHeight: '0' },
    },
      el('div', { class: 'ob-panel-title' },
        el('span', { text: 'Primary' }),
        el('span', { text: `${WEAPONS.length} UNLOCKED` }),
      ),
      el('div', { class: 'ob-scroll' }, list),
    );
    stagger(leftPanel, 0);

    /* ------------------------------------------------------ detail --- */
    const canvas = el('canvas', { class: 'ob-schematic' });
    this.canvas = canvas;
    this.cctx = canvas.getContext('2d');

    const info = el('div', {});
    this.infoHost = info;

    const stats = el('div', {});
    this.statHost = stats;

    const atts = el('div', { class: 'ob-attachments' });
    this.attHost = atts;

    const rightPanel = el('div', {
      class: 'ob-panel ob-stagger',
      style: {
        display: 'grid',
        gridTemplateRows: 'auto minmax(0,1fr) auto auto',
        gap: 'calc(var(--ob-u)*10)', minHeight: '0',
      },
    },
      el('div', { class: 'ob-panel-title' },
        el('span', { text: 'Weapon' }),
        el('span', { text: 'FIELD SCHEMATIC' }),
      ),
      el('div', { style: { position: 'relative', minHeight: '0' } }, canvas),
      el('div', {
        style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 'calc(var(--ob-u)*22)' },
      }, info, stats),
      atts,
    );
    stagger(rightPanel, 1);

    parts.body.append(leftPanel, rightPanel);

    parts.footerLeft.append(
      keyHint('↑↓', 'Select Weapon'),
      keyHint('CLICK', 'Cycle Attachment'),
      keyHint('ESC', 'Back'),
    );
    parts.footerRight.textContent = '';
    parts.footerRight.appendChild(el('button', {
      class: 'ob-btn is-primary', type: 'button', text: 'Save & Equip',
      on: { click: () => { this.equip(); this.host.back(); } },
    }));

    this.renderList();
    this.renderDetail();
  }

  override onOpen(): void {
    this.renderList();
    this.renderDetail();
  }

  override tick(dt: number): void {
    this.t += dt;
    this.drawSchematic();
  }

  /* ---------------------------------------------------------- render -- */

  private renderList(): void {
    const list = this.listHost;
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    WEAPONS.forEach((w, i) => {
      const item = el('button', {
        class: `ob-weapon-item${i === this.selected ? ' is-on' : ''}`,
        type: 'button',
        on: {
          click: () => {
            this.selected = i;
            for (const s of SLOTS) this.attachments[s] = 0;
            bus.emit('ui:sound', { cue: 'menuSelect' });
            this.renderList();
            this.renderDetail();
          },
          mouseenter: () => bus.emit('ui:sound', { cue: 'menuMove' }),
        },
      },
        (() => {
          const c = el('canvas');
          c.width = 136; c.height = 60;
          const ctx = c.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, 136, 60);
            ctx.save();
            ctx.scale(2, 2);
            weaponGlyph(ctx, w.kind, 34, 15, 62, i === this.selected ? '#ffc24b' : '#92a2b8');
            ctx.restore();
          }
          c.style.width = 'calc(var(--ob-u)*34)';
          c.style.height = 'calc(var(--ob-u)*15)';
          return c;
        })(),
        el('div', {},
          el('div', { class: 'ob-weapon-name', text: w.name }),
          el('div', { class: 'ob-weapon-class', text: w.className.toUpperCase() }),
        ),
        el('div', { class: 'ob-weapon-lvl', text: `LV ${w.level}` }),
      );
      list.appendChild(item);
    });
  }

  private currentStats(): { base: LoadoutStats; final: LoadoutStats } {
    const w = WEAPONS[this.selected];
    const base = { ...w.stats };
    const final = { ...w.stats };
    for (const slot of SLOTS) {
      const opt = ATTACHMENTS[slot][this.attachments[slot] ?? 0];
      if (!opt) continue;
      for (const [k, v] of Object.entries(opt.delta) as Array<[keyof LoadoutStats, number]>) {
        final[k] = Math.max(0.02, Math.min(1, final[k] + v));
      }
    }
    return { base, final };
  }

  private renderDetail(): void {
    const w = WEAPONS[this.selected];
    const { base, final } = this.currentStats();

    if (this.infoHost) {
      const info = this.infoHost;
      while (info.firstChild) info.removeChild(info.firstChild);
      info.append(
        el('div', {
          style: {
            fontFamily: 'var(--ob-cond)', fontSize: 'calc(var(--ob-u)*34)', fontWeight: '700',
            letterSpacing: '.14em', color: 'var(--ob-ink)',
          }, text: w.name,
        }),
        el('div', {
          style: {
            fontFamily: 'var(--ob-mono)', fontSize: 'calc(var(--ob-u)*10)', letterSpacing: '.22em',
            color: 'var(--ob-faint)', marginTop: 'calc(var(--ob-u)*2)',
          }, text: `${w.className.toUpperCase()}  ·  ${w.fireMode}  ·  ${w.magSize} RND`,
        }),
        el('div', {
          style: {
            fontFamily: 'var(--ob-sans)', fontSize: 'calc(var(--ob-u)*12.5)', color: 'var(--ob-dim)',
            lineHeight: '1.5', marginTop: 'calc(var(--ob-u)*10)', maxWidth: '46ch',
          }, text: w.blurb,
        }),
      );
    }

    if (this.statHost) {
      const host = this.statHost;
      while (host.firstChild) host.removeChild(host.firstChild);
      for (const [key, label] of STAT_ORDER) {
        const row = statBar(label, final[key], String(Math.round(final[key] * 100)));
        const track = row.querySelector('.ob-stat-track');
        const delta = final[key] - base[key];
        if (track && Math.abs(delta) > 0.005) {
          const mark = el('i');
          mark.style.position = 'absolute';
          mark.style.top = '0';
          mark.style.bottom = '0';
          const lo = Math.min(base[key], final[key]);
          const hi = Math.max(base[key], final[key]);
          mark.style.left = `${lo * 100}%`;
          mark.style.width = `${(hi - lo) * 100}%`;
          mark.style.background = delta > 0 ? 'rgba(99,230,168,.75)' : 'rgba(255,74,58,.75)';
          track.appendChild(mark);
        }
        host.appendChild(row);
      }
    }

    if (this.attHost) {
      const host = this.attHost;
      while (host.firstChild) host.removeChild(host.firstChild);
      SLOTS.forEach((slot) => {
        const idx = this.attachments[slot] ?? 0;
        const opt = ATTACHMENTS[slot][idx];
        const btn = el('button', {
          class: `ob-att${idx > 0 ? ' is-filled' : ''}`,
          type: 'button',
          on: {
            click: () => {
              this.attachments[slot] = (idx + 1) % ATTACHMENTS[slot].length;
              bus.emit('ui:sound', { cue: 'menuSelect' });
              this.renderDetail();
            },
            mouseenter: () => bus.emit('ui:sound', { cue: 'menuMove' }),
          },
        },
          el('div', { class: 'ob-att-slot', text: slot }),
          el('div', { class: 'ob-att-name', text: opt.name.toUpperCase() }),
        );
        host.appendChild(btn);
      });
    }
  }

  private drawSchematic(): void {
    const canvas = this.canvas;
    const c = this.cctx;
    if (!canvas || !c) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(64, Math.floor(rect.width));
    const h = Math.max(64, Math.floor(rect.height || rect.width * 0.36));
    const bw = Math.floor(w * dpr);
    const bh = Math.floor(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w0 = WEAPONS[this.selected];
    const spec = { ...SPECS[w0.kind] };
    // Attachments visibly change the silhouette.
    const optic = this.attachments.OPTIC ?? 0;
    spec.optic = optic === 0 ? 'iron' : optic === 3 ? 'scope' : 'reflex';
    spec.foregrip = (this.attachments.UNDERBARREL ?? 0) > 0;
    const mag = this.attachments.MAGAZINE ?? 0;
    if (mag === 3) spec.magazine = 'drum';
    const barrel = this.attachments.BARREL ?? 0;
    if (barrel === 1) spec.barrel = Math.min(0.4, spec.barrel + 0.05);
    if (barrel === 2) spec.barrel = Math.max(0.06, spec.barrel - 0.05);

    drawWeaponSchematic(c, w, h, spec, {
      ink: '#dce6f4', dim: '#92a2b8', faint: '#5c6a7d',
      accent: '#ffc24b', hair: 'rgba(157,178,204,.14)',
    }, this.t);

    // Slot callouts, pinned to the same x as the leader lines and clamped so
    // they never run off the plate.
    const gl = Math.min(w * spec.length, (h * 0.74) / 0.44);
    const ox = (w - gl) / 2;
    const slotSize = Math.max(9, Math.round(h * 0.030));
    const nameSize = Math.max(10, Math.round(h * 0.034));
    for (const hp of HARDPOINTS) {
      const px = Math.max(60, Math.min(w - 60, ox + hp.x * gl));
      const up = hp.y <= 0;
      c.textAlign = 'center';
      c.textBaseline = up ? 'bottom' : 'top';
      const idx = this.attachments[hp.slot] ?? 0;
      const nm = ATTACHMENTS[hp.slot as SlotName]?.[idx]?.name ?? '';
      const slotY = up ? h * 0.13 : h * 0.87;
      c.font = `600 ${slotSize}px ui-monospace, monospace`;
      c.fillStyle = 'rgba(255,194,75,.9)';
      c.fillText(hp.slot, px, slotY);
      c.font = `700 ${nameSize}px ui-monospace, monospace`;
      c.fillStyle = 'rgba(222,234,248,.82)';
      c.fillText(nm.toUpperCase(), px, up ? slotY - slotSize * 1.35 : slotY + slotSize * 1.35);
    }
  }

  private equip(): void {
    const w = WEAPONS[this.selected];
    const { final } = this.currentStats();
    const attachments: Record<string, string | null> = {};
    for (const slot of SLOTS) {
      const idx = this.attachments[slot] ?? 0;
      attachments[slot] = idx === 0 ? null : ATTACHMENTS[slot][idx].name;
    }
    this.onEquip({ weapon: w, attachments, stats: final });
    bus.emit('ui:sound', { cue: 'menuSelect' });
  }

  /** Currently configured loadout, for the HUD's initial state. */
  current(): EquippedLoadout {
    const w = WEAPONS[this.selected];
    const { final } = this.currentStats();
    const attachments: Record<string, string | null> = {};
    for (const slot of SLOTS) {
      const idx = this.attachments[slot] ?? 0;
      attachments[slot] = idx === 0 ? null : ATTACHMENTS[slot][idx].name;
    }
    return { weapon: w, attachments, stats: final };
  }

  /** Selects a weapon by id (used by the debug scene). */
  selectById(id: string): void {
    const i = WEAPONS.findIndex((w) => w.id === id);
    if (i >= 0) {
      this.selected = i;
      this.renderList();
      this.renderDetail();
    }
  }

  setAttachment(slot: string, index: number): void {
    if (slot in this.attachments) {
      this.attachments[slot] = index;
      this.renderDetail();
    }
  }
}
