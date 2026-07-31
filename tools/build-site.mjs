#!/usr/bin/env node
/**
 * Builds the full GitHub Pages tree: the VitePress docs at the root and the
 * playable game under /play/.
 *
 *   site/            <- docs (vitepress)
 *   site/play/       <- game (vite)
 *
 * Both need to know the sub-path they will be served from, because project
 * pages live at https://<user>.github.io/<repo>/ rather than at a domain root.
 * Set REPO_BASE to deploy elsewhere (a custom domain uses REPO_BASE=/).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');

// Normalised to always have a leading and trailing slash.
const REPO_BASE = `/${(process.env.REPO_BASE ?? '/cod/').replace(/^\/|\/$/g, '')}/`
  .replace('//', '/');

const run = (cmd, args, env) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log(`Building site for base path ${REPO_BASE}`);

// 1. Docs -> site/
run('npx', ['vitepress', 'build', 'docs'], { DOCS_BASE: REPO_BASE });
const docsDist = path.join(ROOT, 'docs/.vitepress/dist');
if (!existsSync(docsDist)) throw new Error(`vitepress produced no output at ${docsDist}`);
cpSync(docsDist, OUT, { recursive: true });

// 2. Game -> site/play/
run('npx', ['vite', 'build'], { BASE_PATH: `${REPO_BASE}play/` });
const gameDist = path.join(ROOT, 'dist');
if (!existsSync(gameDist)) throw new Error(`vite produced no output at ${gameDist}`);
cpSync(gameDist, path.join(OUT, 'play'), { recursive: true });

// Jekyll would otherwise strip paths beginning with an underscore.
writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log(`\n✓ site/ ready — docs at ${REPO_BASE}, game at ${REPO_BASE}play/`);
