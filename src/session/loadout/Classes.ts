/**
 * `LoadoutBook` — the saved custom classes and the editing API behind them.
 *
 * This is the *client's* model. It is deliberately allowed to hold a loadout the
 * host has not seen: the player edits here, and `Service.ts` is what asks the
 * authority to actually run it. Every mutation repairs itself against the same
 * validator the host uses, so the menu can never get into a state that the host
 * will later refuse — the edit simply does not take, and the caller gets the
 * errors to show.
 *
 * Persistence is a `localStorage`-shaped interface, injected, defaulting to real
 * `localStorage` when there is one and to memory when there is not (node tools,
 * private mode, dedicated servers).
 *
 * ## What the UI should render
 *
 * `src/ui/menus/LoadoutMenu.ts` owns the screen; this owns the data. The screen
 * needs, per class: the name, both weapons with their fitted attachments, the
 * three perk rows, lethal / tactical / field upgrade / killstreaks, and — for
 * the bars — `statBars(book.effective(i).primary)`. Every setter returns the
 * validation result so the UI can flash the row red and print the message.
 */

import { LIMITS } from './data/balance';
import { attachmentEntry } from './data/attachments';
import { PRESET_CLASSES } from './data/presets';
import { resolveWeapon, slotsFor } from './Effective';
import { weaponDef, hasWeapon } from '../../weapons/Catalog';
import {
  cloneLoadout, defaultLoadout, serialiseLoadout, validateLoadout,
} from './Validate';
import type {
  EffectiveWeaponStats, Loadout, LoadoutSlot, PerkRow, ValidationContext,
  ValidationResult,
} from './types';

/** The slice of `Storage` this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LoadoutBookOptions {
  storage?: StorageLike | null;
  storageKey?: string;
  /** Unlock/limit context used to repair every edit. */
  context?: ValidationContext;
}

export type BookChange =
  | 'loaded' | 'created' | 'removed' | 'renamed' | 'selected'
  | 'edited' | 'reset' | 'duplicated';

const STORAGE_KEY = 'blackout.loadouts.v1';

export interface ResolvedClass {
  loadout: Loadout;
  primary: EffectiveWeaponStats;
  secondary: EffectiveWeaponStats;
}

export class LoadoutBook {
  private classes: Loadout[] = [];
  private selectedIndex = 0;
  private storage: StorageLike | null;
  private key: string;
  private ctx: ValidationContext;
  private listeners = new Set<(change: BookChange, book: LoadoutBook) => void>();
  /** Bumped on every mutation — cheap dirty check for the UI and the netcode. */
  revision = 0;

  constructor(opts: LoadoutBookOptions = {}) {
    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    this.key = opts.storageKey ?? STORAGE_KEY;
    this.ctx = opts.context ?? {};
    this.resetToPresets();
  }

  /* ------------------------------------------------------------ context -- */

  /** Swap the unlock context (rank up mid-session) and re-validate everything. */
  setContext(ctx: ValidationContext): void {
    this.ctx = ctx;
    this.classes = this.classes.map((l) => validateLoadout(l, this.ctx).loadout);
    this.emit('edited');
  }

  get context(): ValidationContext { return this.ctx; }

  /* ------------------------------------------------------------- access -- */

  get count(): number { return this.classes.length; }
  get selected(): number { return this.selectedIndex; }
  list(): readonly Loadout[] { return this.classes; }
  at(index: number): Loadout | null { return this.classes[index] ?? null; }
  current(): Loadout { return this.classes[this.selectedIndex] ?? defaultLoadout(); }

  /** Resolved stats for a class — what the bars and the weapon system read. */
  effective(index = this.selectedIndex): ResolvedClass {
    const l = this.classes[index] ?? defaultLoadout();
    const perks = l.perks.filter((p) => p.length > 0);
    return {
      loadout: l,
      primary: resolveWeapon(l.primary.weaponId, l.primary.attachments, { perks }),
      secondary: resolveWeapon(l.secondary.weaponId, l.secondary.attachments, { perks }),
    };
  }

  /** Slots the given class's weapon exposes, for drawing the attachment rail. */
  slots(index = this.selectedIndex, which: 'primary' | 'secondary' = 'primary'): LoadoutSlot[] {
    const l = this.classes[index];
    if (!l) return [];
    const id = which === 'primary' ? l.primary.weaponId : l.secondary.weaponId;
    return hasWeapon(id) ? slotsFor(weaponDef(id)) : [];
  }

  /* ----------------------------------------------------------- lifecycle -- */

  resetToPresets(): void {
    this.classes = PRESET_CLASSES.map((p) => validateLoadout(cloneLoadout(p as Loadout), this.ctx).loadout);
    this.selectedIndex = 0;
    this.emit('reset');
  }

  /** Reads the store. Corrupt or absent data yields the presets, never a throw. */
  load(): boolean {
    if (!this.storage) return false;
    let raw: string | null = null;
    try { raw = this.storage.getItem(this.key); } catch { return false; }
    if (!raw) return false;
    try {
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object') return false;
      const rec = data as { classes?: unknown; selected?: unknown };
      if (!Array.isArray(rec.classes) || rec.classes.length === 0) return false;
      const limit = this.limit();
      this.classes = rec.classes.slice(0, limit).map((c) => validateLoadout(c, this.ctx).loadout);
      const sel = typeof rec.selected === 'number' ? Math.floor(rec.selected) : 0;
      this.selectedIndex = Math.max(0, Math.min(this.classes.length - 1, sel));
      this.emit('loaded');
      return true;
    } catch {
      return false;
    }
  }

  save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify({
        version: 1, selected: this.selectedIndex, classes: this.classes,
      }));
    } catch { /* quota, private mode — the book still works in memory */ }
  }

  /* ------------------------------------------------------------- classes -- */

  private limit(): number {
    return this.ctx.limits?.savedClasses ?? LIMITS.savedClasses;
  }

  /** Adds a class. Returns its index, or −1 when the book is full. */
  create(name?: string): number {
    if (this.classes.length >= this.limit()) return -1;
    const n = this.classes.length + 1;
    const l = defaultLoadout(name ?? `CUSTOM ${n}`, `custom-${n}-${this.revision}`);
    this.classes.push(validateLoadout(l, this.ctx).loadout);
    this.emit('created');
    return this.classes.length - 1;
  }

  duplicate(index: number): number {
    const src = this.classes[index];
    if (!src || this.classes.length >= this.limit()) return -1;
    const copy = cloneLoadout(src);
    copy.id = `${src.id}-copy-${this.revision}`;
    copy.name = `${src.name} B`.slice(0, LIMITS.nameMaxLength);
    this.classes.push(copy);
    this.emit('duplicated');
    return this.classes.length - 1;
  }

  remove(index: number): boolean {
    if (this.classes.length <= 1 || !this.classes[index]) return false;
    this.classes.splice(index, 1);
    if (this.selectedIndex >= this.classes.length) this.selectedIndex = this.classes.length - 1;
    this.emit('removed');
    return true;
  }

  rename(index: number, name: string): ValidationResult {
    return this.edit(index, (l) => { l.name = name; }, 'renamed');
  }

  select(index: number): boolean {
    if (!this.classes[index]) return false;
    this.selectedIndex = index;
    this.emit('selected');
    return true;
  }

  /** Replaces a class wholesale — used when the host hands back a repaired one. */
  replace(index: number, loadout: Loadout): ValidationResult {
    const res = validateLoadout(loadout, this.ctx);
    if (this.classes[index]) this.classes[index] = res.loadout;
    this.emit('edited');
    return res;
  }

  /* --------------------------------------------------------------- edits -- */

  /**
   * Fits (or, with `null`, removes) an attachment.
   *
   * Fitting into an occupied slot swaps — that is what the player means when
   * they click a second optic, and making them un-equip first is the kind of
   * friction that makes a menu feel cheap.
   */
  setAttachment(
    index: number,
    which: 'primary' | 'secondary',
    slot: LoadoutSlot,
    attachmentId: string | null,
  ): ValidationResult {
    return this.edit(index, (l) => {
      const spec = which === 'primary' ? l.primary : l.secondary;
      spec.attachments = spec.attachments.filter((id) => attachmentEntry(id)?.slot !== slot);
      if (attachmentId) spec.attachments.push(attachmentId);
    }, 'edited');
  }

  /** Swaps a weapon and drops any attachment the new weapon cannot mount. */
  setWeapon(index: number, which: 'primary' | 'secondary', weaponId: string): ValidationResult {
    return this.edit(index, (l) => {
      const spec = which === 'primary' ? l.primary : l.secondary;
      spec.weaponId = weaponId;
      // The validator drops what does not fit; clearing here keeps the errors
      // out of the player's face for a swap they did not ask about.
      if (hasWeapon(weaponId)) {
        const def = weaponDef(weaponId);
        const legal = new Set(slotsFor(def));
        spec.attachments = spec.attachments.filter((id) => {
          const e = attachmentEntry(id);
          if (!e || !legal.has(e.slot)) return false;
          return e.classes === 'all' || e.classes.includes(def.cls);
        });
      }
    }, 'edited');
  }

  setPerk(index: number, row: PerkRow, perkId: string): ValidationResult {
    return this.edit(index, (l) => { l.perks[row - 1] = perkId; }, 'edited');
  }

  setLethal(index: number, id: string): ValidationResult {
    return this.edit(index, (l) => { l.lethal = id; }, 'edited');
  }

  setTactical(index: number, id: string): ValidationResult {
    return this.edit(index, (l) => { l.tactical = id; }, 'edited');
  }

  setFieldUpgrade(index: number, id: string): ValidationResult {
    return this.edit(index, (l) => { l.fieldUpgrade = id; }, 'edited');
  }

  setKillstreaks(index: number, ids: readonly string[]): ValidationResult {
    return this.edit(index, (l) => { l.killstreaks = [...ids]; }, 'edited');
  }

  /**
   * Applies a mutation to a copy, validates it, and keeps it only if the result
   * is legal *or* repairable. The stored class is always the repaired one, so
   * the book cannot hold something the host would refuse.
   */
  private edit(index: number, mutate: (l: Loadout) => void, change: BookChange): ValidationResult {
    const src = this.classes[index];
    if (!src) {
      return {
        ok: false, loadout: defaultLoadout(), repairs: [],
        errors: [{ code: 'malformed', path: '', message: `no class at index ${index}` }],
      };
    }
    const draft = cloneLoadout(src);
    mutate(draft);
    const res = validateLoadout(draft, this.ctx);
    const before = serialiseLoadout(src);
    this.classes[index] = res.loadout;
    if (serialiseLoadout(res.loadout) !== before) this.emit(change);
    return res;
  }

  /* -------------------------------------------------------------- events -- */

  /** Subscribe to mutations. Returns the unsubscribe function. */
  onChange(fn: (change: BookChange, book: LoadoutBook) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(change: BookChange): void {
    this.revision++;
    for (const fn of this.listeners) {
      try { fn(change, this); } catch (err) { console.error('[loadout] listener threw', err); }
    }
  }
}

/** In-memory storage — the default outside a browser. */
export class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

function defaultStorage(): StorageLike {
  try {
    const s = globalThis.localStorage;
    if (s) {
      s.setItem('blackout.loadout.probe', '1');
      s.removeItem('blackout.loadout.probe');
      return s;
    }
  } catch { /* private mode throws on write */ }
  return new MemoryStorage();
}
