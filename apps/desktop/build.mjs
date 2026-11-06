// Builds the app into dist/: the main process and the preload script for
// Node (CommonJS, as Electron loads them), and the page with its CSS.
//   node build.mjs [--watch]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'dist');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const common = { bundle: true, sourcemap: 'linked', logLevel: 'warning', legalComments: 'none' };
const node = { ...common, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'bufferutil', 'utf-8-validate'] };

const builds = [
  { ...node, entryPoints: { main: 'src/main/main.ts' }, outExtension: { '.js': '.cjs' } },
  { ...node, entryPoints: { preload: 'src/preload/preload.ts' }, outExtension: { '.js': '.cjs' } },
  { ...common, platform: 'browser', format: 'iife', target: 'chrome140', entryPoints: { renderer: 'src/renderer/app.ts' } },
];
await Promise.all(builds.map((b) => esbuild.build({ ...b, absWorkingDir: ROOT, outdir: OUT })));
fs.copyFileSync(path.join(ROOT, 'src/renderer/index.html'), path.join(OUT, 'index.html'));
console.log('built dist/');
