#!/usr/bin/env node
/**
 * Codebase index — answers "what exists and where" without reading whole files.
 *
 * An agent that needs the shape of a module currently reads all of it:
 * MaterialShaders.ts alone is ~1200 lines, almost all of which is bodies it does
 * not care about. This prints declarations only, so the same question costs a
 * few hundred tokens instead of tens of thousands.
 *
 * It is a FINDING AID, not a compiler. TypeScript 7 in this repo is the native
 * port and exposes no compiler API, and pulling in a parser just to list symbols
 * is not worth a dependency. Instead it scans lines, relying on the house style
 * this codebase actually follows: top-level declarations begin at column 0 and
 * class/interface members at column 2. That is reliable here because the tree is
 * always tsc-clean and consistently formatted. When you need certainty about
 * types, run tsc; when you need to find something, run this.
 *
 *   node tools/nexus.mjs map                        # module sizes + export counts
 *   node tools/nexus.mjs api src/net                # exported surface of a dir
 *   node tools/nexus.mjs outline src/render/Sky.ts  # every declaration in a file
 *   node tools/nexus.mjs find 'Exposure|Sky'        # declarations by name
 *   node tools/nexus.mjs refs setBlendWeights       # where a symbol is used
 *   node tools/nexus.mjs imports src/world/World.ts # what a file depends on
 *
 * Add --json for machine-readable output.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const [cmd, arg] = argv;
const asJson = argv.includes('--json');
const rel = (p) => path.relative(ROOT, p);

function tsFiles(target) {
  const abs = path.resolve(ROOT, target || 'src');
  let st;
  try { st = statSync(abs); } catch { return []; }
  if (st.isFile()) return abs.endsWith('.ts') ? [abs] : [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out.sort();
}

/* --------------------------------------------------------------- scan --- */

// A top-level declaration at column 0.
const DECL = new RegExp(
  '^(export\\s+)?(?:declare\\s+)?(?:default\\s+)?' +
  '(abstract\\s+class|class|interface|type|enum|function|const|let|var|async\\s+function)\\s+' +
  '([A-Za-z_$][\\w$]*)',
);
// A member at column 2 inside a class or interface.
const MEMBER = new RegExp(
  '^ {2}(?!\\*|//|})(?:(?:public|protected|readonly|static|abstract|override|async|get|set|declare)\\s+)*' +
  '([A-Za-z_$][\\w$]*)\\s*[(<:?]',
);
const CONTAINER = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface)\b/;

const tidy = (s) => s.replace(/\s+/g, ' ').trim();

/** Signature = the declaration head, stopping before the body. */
function head(lines, i) {
  let text = '';
  for (let n = i; n < Math.min(i + 6, lines.length); n++) {
    text += ` ${lines[n]}`;
    const t = tidy(text);
    // Stop at the body brace, the initialiser, or a complete statement.
    const cut = t.search(/\s(?:\{|=>)|\s=\s|;$/);
    if (cut > 0) return t.slice(0, t[cut] === ';' ? cut : cut).trim();
    if (/[;{]\s*$/.test(t)) return t.replace(/[{;]\s*$/, '').trim();
  }
  const t = tidy(text);
  return t.length > 200 ? `${t.slice(0, 197)}...` : t;
}

/** First sentence of the JSDoc block immediately above a line, if any. */
function docAbove(lines, i) {
  let end = i - 1;
  while (end >= 0 && /^\s*(?:\/\/|@)/.test(lines[end])) end--;
  if (end < 0 || !/^\s*\*\//.test(lines[end])) return '';
  let start = end;
  while (start >= 0 && !/^\s*\/\*\*/.test(lines[start])) start--;
  if (start < 0) return '';
  const body = lines.slice(start, end + 1)
    .map((l) => l.replace(/^\s*\/?\*+\/?/, '').trim())
    .filter(Boolean).join(' ');
  const t = tidy(body);
  const stop = t.search(/\.(\s|$)/);
  const first = stop > 0 ? t.slice(0, stop + 1) : t;
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

function declarations(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  let current = null;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlockComment) { if (line.includes('*/')) inBlockComment = false; continue; }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) { inBlockComment = true; continue; }

    const m = DECL.exec(line);
    if (m) {
      current = {
        kind: tidy(m[2]).replace('async function', 'function').replace('abstract class', 'class'),
        name: m[3],
        exported: Boolean(m[1]),
        line: i + 1,
        signature: head(lines, i),
        doc: docAbove(lines, i),
      };
      if (CONTAINER.test(line)) current.members = [];
      out.push(current);
      continue;
    }
    if (current?.members) {
      const mm = MEMBER.exec(line);
      if (mm) current.members.push({ name: mm[1], line: i + 1, signature: head(lines, i) });
      else if (/^\}/.test(line)) current = null;
    }
  }
  return out;
}

/* ----------------------------------------------------------- commands --- */

function print(rows, { showAll }) {
  for (const { file, decls } of rows) {
    if (!decls.length) continue;
    console.log(`\n${file}`);
    for (const d of decls) {
      console.log(`  ${d.exported ? '+' : ' '} ${String(d.line).padStart(4)}  ${d.signature}`);
      if (d.doc) console.log(`         ${d.doc}`);
      if (showAll || d.exported) {
        for (const mem of d.members ?? []) console.log(`         . ${mem.signature}`);
      }
    }
  }
}

function cmdOutline(target) {
  const rows = tsFiles(target).map((f) => ({ file: rel(f), decls: declarations(f) }));
  if (asJson) return console.log(JSON.stringify(rows, null, 1));
  print(rows, { showAll: true });
}

function cmdApi(target) {
  const rows = tsFiles(target)
    .map((f) => ({ file: rel(f), decls: declarations(f).filter((d) => d.exported) }))
    .filter((r) => r.decls.length);
  if (asJson) return console.log(JSON.stringify(rows, null, 1));
  print(rows, { showAll: true });
  const n = rows.reduce((a, r) => a + r.decls.length, 0);
  console.error(`\n${rows.length} files, ${n} exported symbols`);
}

function cmdFind(pattern) {
  const re = new RegExp(pattern, 'i');
  const hits = [];
  for (const f of tsFiles('src')) {
    for (const d of declarations(f)) if (re.test(d.name)) hits.push({ file: rel(f), ...d });
  }
  if (asJson) return console.log(JSON.stringify(hits, null, 1));
  for (const h of hits) {
    console.log(`${h.file}:${h.line}  ${h.exported ? '+' : ' '} ${h.signature}`);
    if (h.doc) console.log(`    ${h.doc}`);
  }
  console.error(`\n${hits.length} declarations matching /${pattern}/i`);
}

function cmdRefs(name) {
  const declared = [];
  for (const f of tsFiles('src')) {
    for (const d of declarations(f)) {
      if (d.name === name) declared.push({ file: rel(f), line: d.line, signature: d.signature });
    }
  }
  const rg = spawnSync('rg', ['-n', '--no-heading', `\\b${name}\\b`, 'src', 'tools'], {
    cwd: ROOT, encoding: 'utf8',
  });
  const refs = (rg.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    const [file, line, ...rest] = l.split(':');
    return { file, line: Number(line), text: rest.join(':').trim().slice(0, 140) };
  });
  if (asJson) return console.log(JSON.stringify({ declared, refs }, null, 1));
  console.log(`declared (${declared.length}):`);
  for (const d of declared) console.log(`  ${d.file}:${d.line}  ${d.signature}`);
  const byFile = new Map();
  for (const r of refs) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  console.log(`\nreferenced in ${byFile.size} files (${refs.length} mentions):`);
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${file}`);
  }
}

function cmdImports(target) {
  const rows = [];
  for (const f of tsFiles(target)) {
    const text = readFileSync(f, 'utf8');
    const specs = [];
    const re = /^(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(text))) specs.push({ from: m[2], names: tidy(m[1]).replace(/[{}]/g, '').trim() });
    rows.push({ file: rel(f), imports: specs });
  }
  if (asJson) return console.log(JSON.stringify(rows, null, 1));
  for (const { file, imports } of rows) {
    if (!imports.length) continue;
    console.log(`\n${file}`);
    for (const i of imports) console.log(`  ${i.from.padEnd(42)} ${i.names}`);
  }
}

function cmdMap() {
  const rows = [];
  for (const e of readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const files = tsFiles(path.join('src', e.name));
    let lines = 0, exported = 0;
    for (const f of files) {
      lines += readFileSync(f, 'utf8').split('\n').length;
      exported += declarations(f).filter((d) => d.exported).length;
    }
    rows.push({ module: e.name, files: files.length, lines, exported });
  }
  rows.sort((a, b) => b.lines - a.lines);
  if (asJson) return console.log(JSON.stringify(rows, null, 1));
  console.log('module          files   lines  exports');
  for (const r of rows) {
    console.log(`${r.module.padEnd(14)} ${String(r.files).padStart(5)} ${String(r.lines).padStart(7)} ${String(r.exported).padStart(8)}`);
  }
  const t = rows.reduce((a, r) => ({ f: a.f + r.files, l: a.l + r.lines, e: a.e + r.exported }), { f: 0, l: 0, e: 0 });
  console.log(`${'TOTAL'.padEnd(14)} ${String(t.f).padStart(5)} ${String(t.l).padStart(7)} ${String(t.e).padStart(8)}`);
}

const USAGE = `nexus — query the codebase without reading files

  map                per-module file/line/export counts
  api <path>         exported surface only — use this to learn a module's API
  outline <path>     every top-level declaration in a file or directory
  find <regex>       declarations whose name matches
  refs <symbol>      where a symbol is declared and which files use it
  imports <path>     what a file or directory depends on

  --json             machine-readable output

A finding aid, not a compiler. Run tsc when you need certainty about types.`;

switch (cmd) {
  case 'outline': cmdOutline(arg); break;
  case 'api': cmdApi(arg); break;
  case 'find': cmdFind(arg); break;
  case 'refs': cmdRefs(arg); break;
  case 'imports': cmdImports(arg); break;
  case 'map': cmdMap(); break;
  default: console.log(USAGE); process.exit(cmd ? 1 : 0);
}
