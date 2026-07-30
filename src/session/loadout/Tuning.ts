/**
 * Live balance tuning.
 *
 * A balance pass should be a data change, not a rebuild. `applyTuningPatch`
 * takes a sparse JSON object — stat rails, structural limits, individual
 * attachment and perk multipliers — and folds it into the tables the resolver
 * reads. Everything resolved *after* the call uses the new numbers; nothing
 * caches, so a designer can retune between rounds.
 *
 * ```ts
 * applyTuningPatch({
 *   attachments: { stock_none: { recoilVertical: 1.45 } },
 *   stats: { hipSpread: { minMul: 0.5 } },
 * });
 * ```
 *
 * The patch is validated the same way a loadout is: unknown ids and non-finite
 * numbers are ignored rather than trusted, because a tuning blob can arrive
 * from the same places a loadout can.
 */

import { applyStatTuning, type TuningPatch } from './data/balance';
import { applyAttachmentTuning } from './data/attachments';
import { applyPerkTuning } from './data/perks';

export type { TuningPatch } from './data/balance';

/** Applies a patch. Returns a note per field that actually changed. */
export function applyTuningPatch(patch: unknown): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [];
  const p = patch as TuningPatch;
  return [
    ...applyStatTuning(p),
    ...applyAttachmentTuning(p),
    ...applyPerkTuning(p),
  ];
}
