/**
 * Minimal module hook so node can import the game's TypeScript sources directly.
 *
 * Node strips types natively; it just will not resolve the extensionless
 * relative imports the bundler uses ("./Movement"). This maps those onto .ts
 * files. No build step, no extra dependency, and the test therefore runs the
 * exact source the game ships rather than a copy.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !extname(specifier)) {
      const parentPath = context.parentURL && context.parentURL.startsWith('file:')
        ? dirname(fileURLToPath(context.parentURL))
        : process.cwd();
      const base = resolvePath(parentPath, specifier);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

// The settings store touches localStorage lazily; give it somewhere to go so a
// headless run behaves like a fresh browser profile rather than throwing.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
