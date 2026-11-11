#!/usr/bin/env node
// The icons as SVG files, one per icon, for clients that cannot import the
// desktop's TypeScript (the native Mac app reads them at launch). Written
// from apps/desktop/src/renderer/icons.ts, which stays the one source: a
// constant becomes <name>.svg (RING_YOU: ring-you.svg), a function (PLUS)
// is called with its defaults, and the NAV object gives nav-<page>.svg;
// MACHINES_ICON comes from machines.ts. Colours stay as the desktop writes
// them: `currentColor` and `var(--token)`, filled in by the reader from
// shared/tokens/tokens.json.
//
//   node --experimental-strip-types shared/icons/export.mjs          # write
//   node --experimental-strip-types shared/icons/export.mjs --check  # exit 1 when a file differs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'apps', 'desktop', 'src', 'renderer');
const I = await import(pathToFileURL(path.join(SRC, 'icons.ts')).href);
const kebab = (s) => s.toLowerCase().replace(/_/g, '-');
const out = new Map();
for (const [name, v] of Object.entries(I)) {
  if (typeof v === 'string' && v.startsWith('<svg')) out.set(`${kebab(name)}.svg`, v);
  else if (typeof v === 'function') { const s = v(); if (typeof s === 'string' && s.startsWith('<svg')) out.set(`${kebab(name)}.svg`, s); }
  else if (v && typeof v === 'object') for (const [k, s] of Object.entries(v)) if (typeof s === 'string' && s.startsWith('<svg')) out.set(`${kebab(name)}-${kebab(k)}.svg`, s);
}
const m = /export const MACHINES_ICON = '([^']+)'/.exec(fs.readFileSync(path.join(SRC, 'machines.ts'), 'utf8'));
if (m) out.set('machines.svg', m[1]);
// The Settings window's tabs (src/settings/settings.ts I).
const st = fs.readFileSync(path.join(SRC, '..', 'settings', 'settings.ts'), 'utf8');
for (const [k, f] of [['APPEAR', 'settings-appearance'], ['BEHAV', 'settings-behavior'], ['SKILLS', 'settings-skills']]) {
  const x = new RegExp(`\\b${k}: '([^']+)'`).exec(st);
  if (x) out.set(`${f}.svg`, x[1]);
}
// The switch from the npm board's marks (npmswitch.ts ICON): npm-board.svg, npm-login.svg.
const npm = fs.readFileSync(path.join(SRC, 'npmswitch.ts'), 'utf8');
for (const k of ['board', 'login']) {
  const x = new RegExp(`\\n  ${k}: '([^']+)'`).exec(npm);
  if (x) out.set(`npm-${k}.svg`, x[1]);
}
// The SVG namespace, so a reader that is not a browser draws them.
const file = (s) => s.replace(/^<svg(?![^>]*xmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"') + '\n';
const check = process.argv.includes('--check');
let bad = 0;
for (const [f, s] of out) {
  const p = path.join(HERE, f);
  if (check) { let was = null; try { was = fs.readFileSync(p, 'utf8'); } catch { /* missing */ } if (was !== file(s)) { console.log(`differs: shared/icons/${f}`); bad++; } }
  else fs.writeFileSync(p, file(s));
}
console.log(check ? `${out.size} icons, ${bad} differ` : `${out.size} icons written to shared/icons`);
process.exit(bad ? 1 : 0);
