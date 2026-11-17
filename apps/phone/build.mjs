// Builds the phone board into one folder the shells ship: index.html,
// app.js and app.css. The colours and scales come from the design tokens
// (shared/tokens/tokens.json), written first in app.css as CSS variables.
//   node build.mjs [--out <dir>] [--watch]
//
// board.js is the app's layer over the hub's own board (src/board.ts),
// which the shell injects first into the board's page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { tokensCss } from '../../shared/tokens/css.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(outArg >= 0 ? args[outArg + 1] : path.join(ROOT, 'dist'));
const TARGET = ['chrome100', 'safari15'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

await esbuild.build({
  absWorkingDir: ROOT,
  // app: the app's own screens (index.html); board: its layer over the
  // hub's board, the home (src/board.ts).
  entryPoints: { app: 'src/main.ts', board: 'src/board.ts' },
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

const own = fs.readFileSync(path.join(ROOT, 'src', 'phone.css'), 'utf8');
// "Ravenry Glyphs": the agents' symbols as text (tools/glyph-font.py).
const glyphs = fs.readFileSync(path.join(ROOT, 'src', 'glyphs.css'), 'utf8');
// The design tokens (shared/tokens/tokens.json) as CSS variables, first.
const tokens = tokensCss();
const css = await esbuild.transform(`${tokens}\n${glyphs}\n${own}`, { loader: 'css', minify: true, target: TARGET, legalComments: 'none' });
fs.writeFileSync(path.join(OUT, 'app.css'), css.code);
// board.css: the app's layer over the hub's board (src/board.ts), with the glyph font.
const boardCss = await esbuild.transform(`${glyphs}\n${fs.readFileSync(path.join(ROOT, 'src', 'board.css'), 'utf8')}`, { loader: 'css', minify: true, target: TARGET, legalComments: 'none' });
fs.writeFileSync(path.join(OUT, 'board.css'), boardCss.code);
fs.copyFileSync(path.join(ROOT, 'src', 'index.html'), path.join(OUT, 'index.html'));
// The projects the app is built with and their licences (Settings, Open
// source licences: src/licences.ts reads it).
fs.copyFileSync(path.join(ROOT, '..', '..', 'THIRD_PARTY_NOTICES.txt'), path.join(OUT, 'licences.txt'));
console.log(`built ${path.relative(process.cwd(), OUT) || '.'}`);
