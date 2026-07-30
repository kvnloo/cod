/**
 * The trust boundary.
 *
 * A loadout arrives from a client. That client may be a stock build, a modified
 * build, or a script that has never run the game. `validateLoadout` therefore
 * takes `unknown` — not `Loadout` — and is written so that *every* path returns
 * a loadout the host is willing to run:
 *
 *   - Structurally broken input (not an object, arrays where records belong,
 *     `NaN`, absurd string lengths, prototype keys) → default class.
 *   - Individually illegal elements (locked content, over the attachment limit,
 *     two perks from the same exclusivity group, a primary in the secondary
 *     slot) → that element is dropped or replaced, everything else survives.
 *
 * `ok === false` means the request was not honoured verbatim. The host should
 * still *run* `result.loadout` — the repaired one — and send the errors back so
 * the client can show the player what was refused. Silently running a different
 * gun than the one on screen is worse than refusing.
 *
 * Nothing here mutates the input, and nothing reads a key off the input object
 * that it does not explicitly ask for, so a `__proto__`-laden payload cannot
 * leak into the result.
 */

import { hasWeapon, weaponDef } from '../../weapons/Catalog';
import { LIMITS } from './data/balance';
import { attachmentEntry, isBaseline } from './data/attachments';
import { perkDef } from './data/perks';
import {
  FIELD_UPGRADES, KILLSTREAK_OPTIONS, LETHALS, TACTICALS,
  fieldUpgradeDef, killstreakOption, lethalDef, tacticalDef,
} from './data/equipment';
import { weaponMinRank } from './data/weapons';
import { mountable } from './Effective';
import type {
  Loadout, LoadoutLimits, PerkRow, ValidationCode, ValidationContext,
  ValidationError, ValidationResult, WeaponSpec,
} from './types';

const DEFAULT_PRIMARY = 'ar_vkr7';
const DEFAULT_SECONDARY = 'pi_sidewinder';
const DEFAULT_LETHAL = 'eq_frag';
const DEFAULT_TACTICAL = 'eq_flash';
const DEFAULT_FIELD_UPGRADE = 'fu_deadsilence';

/** Ids are content keys, not free text: strict charset, strict length. */
const ID_RE = /^[a-z0-9_]{2,48}$/;

/* --------------------------------------------------------------- defaults */

export function defaultLoadout(name = 'CLASS 1', id = 'class-1'): Loadout {
  return {
    version: 1,
    id,
    name,
    primary: { weaponId: DEFAULT_PRIMARY, attachments: [] },
    secondary: { weaponId: DEFAULT_SECONDARY, attachments: [] },
    lethal: DEFAULT_LETHAL,
    tactical: DEFAULT_TACTICAL,
    perks: ['perk_double_time', '', ''],
    fieldUpgrade: DEFAULT_FIELD_UPGRADE,
    killstreaks: ['uav', 'carepackage', 'airstrike'],
  };
}

/** Deep structural copy. Used everywhere a loadout crosses an ownership line. */
export function cloneLoadout(l: Loadout): Loadout {
  return {
    version: 1,
    id: l.id,
    name: l.name,
    primary: { weaponId: l.primary.weaponId, attachments: [...l.primary.attachments] },
    secondary: { weaponId: l.secondary.weaponId, attachments: [...l.secondary.attachments] },
    lethal: l.lethal,
    tactical: l.tactical,
    perks: [l.perks[0], l.perks[1], l.perks[2]],
    fieldUpgrade: l.fieldUpgrade,
    killstreaks: [...l.killstreaks],
  };
}

/** Byte-stable comparison — cheap enough to gate a network send on. */
export function loadoutsEqual(a: Loadout, b: Loadout): boolean {
  return serialiseLoadout(a) === serialiseLoadout(b);
}

/** Canonical serialisation: key order is fixed, so equal loadouts hash equal. */
export function serialiseLoadout(l: Loadout): string {
  return JSON.stringify([
    l.version, l.id, l.name,
    l.primary.weaponId, [...l.primary.attachments].sort(),
    l.secondary.weaponId, [...l.secondary.attachments].sort(),
    l.lethal, l.tactical, l.perks, l.fieldUpgrade, [...l.killstreaks].sort(),
  ]);
}

/* ------------------------------------------------------------- validation */

export function validateLoadout(input: unknown, ctx: ValidationContext = {}): ValidationResult {
  const limits: LoadoutLimits = { ...LIMITS, ...(ctx.limits ?? {}) };
  const errors: ValidationError[] = [];
  const repairs: string[] = [];
  const fail = (code: ValidationCode, path: string, message: string, id?: string): void => {
    errors.push(id === undefined ? { code, path, message } : { code, path, message, id });
  };

  const src = isRecord(input) ? input : null;
  if (!src) {
    fail('malformed', '', 'loadout must be an object');
    return { ok: false, loadout: defaultLoadout(), errors, repairs: ['replaced with the default class'] };
  }

  const out = defaultLoadout();

  /* --- identity ------------------------------------------------------- */
  const rawId = src['id'];
  if (typeof rawId === 'string' && rawId.length > 0 && rawId.length <= 64) out.id = rawId;
  else if (rawId !== undefined) { repairs.push('class id replaced'); }

  const rawName = src['name'];
  if (typeof rawName === 'string') {
    const clean = sanitiseName(rawName, limits.nameMaxLength);
    if (clean.length === 0) {
      fail('name_invalid', 'name', 'class name is empty after sanitising');
      repairs.push('name replaced with the default');
    } else {
      if (clean !== rawName) repairs.push('name sanitised');
      out.name = clean;
    }
  } else if (rawName !== undefined) {
    fail('name_invalid', 'name', 'class name must be a string');
  }

  const rawVersion = src['version'];
  if (rawVersion !== undefined && rawVersion !== 1) {
    fail('malformed', 'version', `unsupported loadout version ${String(rawVersion)}`);
    repairs.push('version forced to 1');
  }

  /* --- perks (resolved first: Overkill changes what the weapon slots accept) */
  const rawPerks = Array.isArray(src['perks']) ? (src['perks'] as unknown[]) : null;
  if (src['perks'] !== undefined && !rawPerks) fail('malformed', 'perks', 'perks must be an array');
  const perks: [string, string, string] = ['', '', ''];
  const groupsUsed = new Map<string, string>();
  const perkIdsSeen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const row = (i + 1) as PerkRow;
    const raw = rawPerks ? rawPerks[i] : undefined;
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || !ID_RE.test(raw)) {
      fail('perk_unknown', `perks[${i}]`, 'perk id must be a content id string');
      continue;
    }
    const def = perkDef(raw);
    if (!def) { fail('perk_unknown', `perks[${i}]`, `unknown perk "${raw}"`, raw); continue; }
    if (def.row !== row) {
      fail('perk_row', `perks[${i}]`, `"${raw}" is a row-${def.row} perk, offered in row ${row}`, raw);
      continue;
    }
    if (perkIdsSeen.has(raw)) { fail('perk_duplicate', `perks[${i}]`, `"${raw}" equipped twice`, raw); continue; }
    if (def.group) {
      const owner = groupsUsed.get(def.group);
      if (owner) {
        fail('perk_conflict', `perks[${i}]`, `"${raw}" conflicts with "${owner}" (both "${def.group}")`, raw);
        continue;
      }
    }
    if (isLocked(raw, def.minRank, ctx)) {
      fail('locked', `perks[${i}]`, `"${raw}" unlocks at rank ${def.minRank}`, raw);
      continue;
    }
    perkIdsSeen.add(raw);
    if (def.group) groupsUsed.set(def.group, raw);
    perks[i] = raw;
  }
  if (rawPerks) {
    out.perks = perks;
    if (rawPerks.length > 3) fail('malformed', 'perks', 'at most three perks, one per row');
  }
  const overkill = perks.some((p) => perkDef(p)?.flags?.includes('overkill'));

  /* --- weapons -------------------------------------------------------- */
  out.primary = readWeapon(src['primary'], 'primary', 'primary', limits, ctx, fail, repairs, false);
  out.secondary = readWeapon(src['secondary'], 'secondary', 'secondary', limits, ctx, fail, repairs, overkill);
  if (out.primary.weaponId === out.secondary.weaponId) {
    fail('duplicate_weapon', 'secondary.weaponId',
      `"${out.secondary.weaponId}" cannot fill both slots`, out.secondary.weaponId);
    out.secondary = { weaponId: DEFAULT_SECONDARY, attachments: [] };
    repairs.push('secondary replaced with the default sidearm');
  }

  /* --- equipment ------------------------------------------------------ */
  out.lethal = readEquipment(src['lethal'], 'lethal', ctx, fail, repairs);
  out.tactical = readEquipment(src['tactical'], 'tactical', ctx, fail, repairs);

  const rawFu = src['fieldUpgrade'];
  if (typeof rawFu === 'string' && ID_RE.test(rawFu)) {
    const def = fieldUpgradeDef(rawFu);
    if (!def) {
      fail('field_upgrade_unknown', 'fieldUpgrade', `unknown field upgrade "${rawFu}"`, rawFu);
      repairs.push('field upgrade replaced with the default');
    } else if (isLocked(rawFu, def.minRank, ctx)) {
      fail('locked', 'fieldUpgrade', `"${rawFu}" unlocks at rank ${def.minRank}`, rawFu);
      repairs.push('field upgrade replaced with the default');
    } else out.fieldUpgrade = rawFu;
  } else if (rawFu !== undefined) {
    fail('field_upgrade_unknown', 'fieldUpgrade', 'field upgrade must be a content id string');
  }

  /* --- killstreaks ---------------------------------------------------- */
  const rawKs = src['killstreaks'];
  if (Array.isArray(rawKs)) {
    const picked: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rawKs.length; i++) {
      const id = rawKs[i];
      if (typeof id !== 'string' || !ID_RE.test(id)) {
        fail('killstreak_unknown', `killstreaks[${i}]`, 'killstreak id must be a content id string');
        continue;
      }
      const def = killstreakOption(id);
      if (!def) { fail('killstreak_unknown', `killstreaks[${i}]`, `unknown killstreak "${id}"`, id); continue; }
      if (seen.has(id)) { fail('killstreak_duplicate', `killstreaks[${i}]`, `"${id}" selected twice`, id); continue; }
      if (isLocked(id, def.minRank, ctx)) {
        fail('locked', `killstreaks[${i}]`, `"${id}" unlocks at rank ${def.minRank}`, id);
        continue;
      }
      if (picked.length >= limits.killstreaks) {
        fail('killstreak_limit', `killstreaks[${i}]`,
          `at most ${limits.killstreaks} killstreaks, dropped "${id}"`, id);
        continue;
      }
      seen.add(id);
      picked.push(id);
    }
    picked.sort((a, b) => (killstreakOption(a)?.cost ?? 0) - (killstreakOption(b)?.cost ?? 0));
    out.killstreaks = picked;
  } else if (rawKs !== undefined) {
    fail('malformed', 'killstreaks', 'killstreaks must be an array');
  }

  return { ok: errors.length === 0, loadout: out, errors, repairs };
}

/**
 * Repairs without complaining — the client-side call. Use this to keep a menu's
 * state legal as the player edits it; use `validateLoadout` on the host.
 */
export function repairLoadout(input: unknown, ctx: ValidationContext = {}): Loadout {
  return validateLoadout(input, ctx).loadout;
}

/* ------------------------------------------------------------- internals */

type Fail = (code: ValidationCode, path: string, message: string, id?: string) => void;

function readWeapon(
  raw: unknown,
  path: string,
  slot: 'primary' | 'secondary',
  limits: LoadoutLimits,
  ctx: ValidationContext,
  fail: Fail,
  repairs: string[],
  allowPrimaryInSecondary: boolean,
): WeaponSpec {
  const fallback = slot === 'primary' ? DEFAULT_PRIMARY : DEFAULT_SECONDARY;
  if (!isRecord(raw)) {
    if (raw !== undefined) fail('malformed', path, `${path} must be an object`);
    return { weaponId: fallback, attachments: [] };
  }

  let weaponId = fallback;
  const rawId = raw['weaponId'];
  if (typeof rawId !== 'string' || !ID_RE.test(rawId) || !hasWeapon(rawId)) {
    fail('unknown_weapon', `${path}.weaponId`, `unknown weapon "${String(rawId)}"`,
      typeof rawId === 'string' ? rawId : undefined);
    repairs.push(`${path} replaced with ${fallback}`);
  } else {
    const def = weaponDef(rawId);
    const legalSlot = def.slot === slot || (slot === 'secondary' && allowPrimaryInSecondary && def.slot === 'primary');
    if (!legalSlot) {
      fail('slot_mismatch', `${path}.weaponId`,
        `"${rawId}" is a ${def.slot} weapon${slot === 'secondary' ? ' — Overkill is required to carry it here' : ''}`, rawId);
      repairs.push(`${path} replaced with ${fallback}`);
    } else if (isLocked(rawId, weaponMinRank(rawId), ctx)) {
      fail('locked', `${path}.weaponId`, `"${rawId}" unlocks at rank ${weaponMinRank(rawId)}`, rawId);
      repairs.push(`${path} replaced with ${fallback}`);
    } else weaponId = rawId;
  }

  const def = weaponDef(weaponId);
  const attachments: string[] = [];
  const usedSlots = new Map<string, string>();
  const seen = new Set<string>();
  const rawList = raw['attachments'];
  if (Array.isArray(rawList)) {
    for (let i = 0; i < rawList.length; i++) {
      const id = rawList[i];
      const at = `${path}.attachments[${i}]`;
      if (typeof id !== 'string' || !ID_RE.test(id)) {
        fail('attachment_unknown', at, 'attachment id must be a content id string');
        continue;
      }
      const entry = attachmentEntry(id);
      if (!entry) { fail('attachment_unknown', at, `unknown attachment "${id}"`, id); continue; }
      if (seen.has(id)) { fail('attachment_duplicate', at, `"${id}" fitted twice`, id); continue; }
      seen.add(id);
      if (isBaseline(entry)) continue;            // "None" is not an attachment
      if (!mountable(def, entry)) {
        fail('attachment_incompatible', at, `"${id}" cannot be fitted to a ${def.cls} (${weaponId})`, id);
        continue;
      }
      const owner = usedSlots.get(entry.slot);
      if (owner) {
        fail('attachment_slot_conflict', at, `slot "${entry.slot}" already holds "${owner}"`, id);
        continue;
      }
      const clash = (entry.conflicts ?? []).find((c) => attachments.includes(c));
      if (clash) { fail('attachment_conflict', at, `"${id}" conflicts with "${clash}"`, id); continue; }
      if (isLocked(id, entry.minRank, ctx)) {
        fail('locked', at, `"${id}" unlocks at rank ${entry.minRank}`, id);
        continue;
      }
      if (attachments.length >= limits.attachmentsPerWeapon) {
        fail('attachment_limit', at,
          `at most ${limits.attachmentsPerWeapon} attachments, dropped "${id}"`, id);
        continue;
      }
      usedSlots.set(entry.slot, id);
      attachments.push(id);
    }
  } else if (rawList !== undefined) {
    fail('malformed', `${path}.attachments`, 'attachments must be an array');
  }

  return { weaponId, attachments };
}

function readEquipment(
  raw: unknown,
  kind: 'lethal' | 'tactical',
  ctx: ValidationContext,
  fail: Fail,
  repairs: string[],
): string {
  const fallback = kind === 'lethal' ? DEFAULT_LETHAL : DEFAULT_TACTICAL;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !ID_RE.test(raw)) {
    fail('equipment_unknown', kind, `${kind} must be a content id string`);
    return fallback;
  }
  const def = kind === 'lethal' ? lethalDef(raw) : tacticalDef(raw);
  if (!def) {
    fail('equipment_unknown', kind, `unknown ${kind} "${raw}"`, raw);
    repairs.push(`${kind} replaced with the default`);
    return fallback;
  }
  if (isLocked(raw, def.minRank, ctx)) {
    fail('locked', kind, `"${raw}" unlocks at rank ${def.minRank}`, raw);
    repairs.push(`${kind} replaced with the default`);
    return fallback;
  }
  return raw;
}

/** The rank gate. Explicit grants (challenges, care packages) bypass it. */
export function isLocked(id: string, minRank: number, ctx: ValidationContext): boolean {
  if (ctx.enforceUnlocks === false) return false;
  const u = ctx.unlocks;
  if (!u) return false;
  if (u.isUnlocked && u.isUnlocked(id)) return false;
  return u.rank < minRank;
}

/**
 * Class names are shown in the HUD, the scoreboard and the killfeed, so they are
 * treated as hostile: control characters stripped, markup characters removed,
 * length capped, whitespace collapsed.
 */
export function sanitiseName(raw: string, maxLength: number): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code === 0x2028 || code === 0x2029) continue;
    // Markup characters - this string lands in the HUD and the scoreboard.
    if (ch === '<' || ch === '>' || ch === '&') continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Everything the armoury can offer, for building menus without a data import. */
export function contentIndex(): {
  lethals: typeof LETHALS;
  tacticals: typeof TACTICALS;
  fieldUpgrades: typeof FIELD_UPGRADES;
  killstreaks: typeof KILLSTREAK_OPTIONS;
} {
  return {
    lethals: LETHALS, tacticals: TACTICALS,
    fieldUpgrades: FIELD_UPGRADES, killstreaks: KILLSTREAK_OPTIONS,
  };
}
