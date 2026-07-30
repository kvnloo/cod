/**
 * Lets node scripts under tools/ import the project's TypeScript sources directly.
 *
 * Node 22.18+/23+ strips types natively, but ESM still demands explicit file
 * extensions, and the codebase (correctly, for a bundler) writes
 * `import { x } from './Foo'`. This resolve hook fills in `.ts` / `/index.ts`.
 *
 * Only import modules that are free of Three.js / DOM / Rapier this way —
 * `src/net/host/**` is deliberately kept that way so the authoritative
 * simulation can be tested and later hosted headlessly.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAS_EXT = /\.[cm]?[jt]sx?$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !HAS_EXT.test(specifier)) {
      const parent = context.parentURL;
      if (parent) {
        const base = new URL(specifier, parent);
        for (const ext of ['.ts', '/index.ts', '.mts']) {
          const candidate = new URL(base.href + ext);
          if (existsSync(fileURLToPath(candidate))) {
            return { url: candidate.href, format: 'module', shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
