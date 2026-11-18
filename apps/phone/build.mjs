// Builds the phone board into one folder the shells ship: index.html,
// app.js and app.css, and for the demo the board's own page (board/) and
// its recording (demo/). The colours and scales come from the design tokens
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
// The demo's bar (src/demo.ts), in both: the app's own screens and the board.
const demoCss = fs.readFileSync(path.join(ROOT, 'src', 'demo.css'), 'utf8');
// "Ravenry Glyphs": the agents' symbols as text (tools/glyph-font.py).
const glyphs = fs.readFileSync(path.join(ROOT, 'src', 'glyphs.css'), 'utf8');
// The design tokens (shared/tokens/tokens.json) as CSS variables, first.
const tokens = tokensCss();
const css = await esbuild.transform(`${tokens}\n${glyphs}\n${own}\n${demoCss}`, { loader: 'css', minify: true, target: TARGET, legalComments: 'none' });
fs.writeFileSync(path.join(OUT, 'app.css'), css.code);
// board.css: the app's layer over the hub's board (src/board.ts), with the glyph font.
const boardCss = await esbuild.transform(`${glyphs}\n${fs.readFileSync(path.join(ROOT, 'src', 'board.css'), 'utf8')}\n${demoCss}`, { loader: 'css', minify: true, target: TARGET, legalComments: 'none' });
fs.writeFileSync(path.join(OUT, 'board.css'), boardCss.code);
fs.copyFileSync(path.join(ROOT, 'src', 'index.html'), path.join(OUT, 'index.html'));
// The projects the app is built with and their licences (Settings, Open
// source licences: src/licences.ts reads it).
fs.copyFileSync(path.join(ROOT, '..', '..', 'THIRD_PARTY_NOTICES.txt'), path.join(OUT, 'licences.txt'));

// The demo (src/demo.ts): the board's own page, as the hub serves it, from
// the same files (hub/public) copied at each build into board/, never a copy
// kept by hand; and the recording of the sample board (src/demo/, from
// tools/demo-sample.mjs) into demo/, with files.json: which hub path each
// picture of the recording answers (the shells serve them from it).
const PUBLIC = path.join(ROOT, '..', '..', 'hub', 'public');
fs.cpSync(PUBLIC, path.join(OUT, 'board'), { recursive: true, filter: (f) => !f.endsWith('.d.mts') });
const DEMO = path.join(ROOT, 'src', 'demo');
fs.mkdirSync(path.join(OUT, 'demo'), { recursive: true });
for (const f of fs.readdirSync(DEMO)) if (/\.(json|png|jpg|svg|webp)$/.test(f)) fs.copyFileSync(path.join(DEMO, f), path.join(OUT, 'demo', f));
const sample = JSON.parse(fs.readFileSync(path.join(DEMO, 'sample.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(sample.get).filter(([, g]) => g.file).map(([k, g]) => [k, { file: g.file, type: g.type }]));
fs.writeFileSync(path.join(OUT, 'demo', 'files.json'), JSON.stringify(files));
console.log(`built ${path.relative(process.cwd(), OUT) || '.'}`);
