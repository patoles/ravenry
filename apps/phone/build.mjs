// Builds the phone board into one folder the shells ship: index.html,
// app.js and app.css.
//   node build.mjs [--out <dir>] [--watch]
//
// The pages are drawn by the desktop app's own code (pages.ts), so their
// look comes from the desktop's stylesheet too: the whole of it, nested
// under .pgx, which the phone puts around a page. Its window layout then
// matches nothing on the phone (.pgx html, .pgx .mc), and every rule a page
// uses applies there as on the desktop. esbuild flattens the nesting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(outArg >= 0 ? args[outArg + 1] : path.join(ROOT, 'dist'));
const DESKTOP_CSS = path.join(ROOT, '..', 'desktop', 'src', 'renderer', 'app.css');
const TARGET = ['chrome100', 'safari15'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: { app: 'src/main.ts' },
  outdir: OUT,
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: TARGET,
  legalComments: 'none',
  logLevel: 'warning',
  loader: { '.css': 'empty' },
});

const pages = `.pgx {\n${fs.readFileSync(DESKTOP_CSS, 'utf8')}\n}\n`;
const xterm = fs.readFileSync(path.join(ROOT, '..', '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
const own = fs.readFileSync(path.join(ROOT, 'src', 'phone.css'), 'utf8');
// "Ravenry Glyphs": the agents' symbols as text (tools/glyph-font.py).
const glyphs = fs.readFileSync(path.join(ROOT, 'src', 'glyphs.css'), 'utf8');
const css = await esbuild.transform(`${glyphs}\n${xterm}\n${pages}\n${own}`, { loader: 'css', minify: true, target: TARGET, legalComments: 'none' });
fs.writeFileSync(path.join(OUT, 'app.css'), css.code);
fs.copyFileSync(path.join(ROOT, 'src', 'index.html'), path.join(OUT, 'index.html'));
console.log(`built ${path.relative(process.cwd(), OUT) || '.'}`);
