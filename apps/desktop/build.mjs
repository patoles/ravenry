// Builds the app into dist/: the main process and the preload script for
// Node (CommonJS, as Electron loads them), and the page with its CSS.
//   node build.mjs [--release]
//
// --release (scripts/pack.mjs, for what people install): the main process
// without its test hooks (src/main/gate.ts): RAVENRY_TEST_HOOKS is false
// and the code it guards is left out (minifySyntax drops it). Without it, a
// development or test build, with them. Either way the bundle requires no
// package from outside it but electron: ws's optional natives (bufferutil,
// utf-8-validate) resolve to a module that throws, so NODE_PATH can never
// put one there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { tokensCss } from '../../shared/tokens/css.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RELEASE = process.argv.includes('--release');
const OUT = path.join(ROOT, 'dist');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const common = { bundle: true, sourcemap: 'linked', logLevel: 'warning', legalComments: 'none' };
const absent = {
  name: 'absent',
  setup(b) {
    b.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (a) => ({ path: a.path, namespace: 'absent' }));
    b.onLoad({ filter: /.*/, namespace: 'absent' }, (a) => ({ contents: `throw new Error(${JSON.stringify(`${a.path} is not part of the app`)});`, loader: 'js' }));
  },
};
// The design tokens (shared/tokens/tokens.json) as CSS variables: app.css
// and settings.css start with @import "ravenry-tokens.css", which is this.
const tokens = {
  name: 'tokens',
  setup(b) {
    b.onResolve({ filter: /^ravenry-tokens\.css$/ }, (a) => ({ path: a.path, namespace: 'tokens' }));
    b.onLoad({ filter: /.*/, namespace: 'tokens' }, () => ({ contents: tokensCss(), loader: 'css', watchFiles: [fileURLToPath(new URL('../../shared/tokens/tokens.json', import.meta.url))] }));
  },
};
const node = { ...common, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], plugins: [absent] };

const builds = [
  { ...node, entryPoints: { main: 'src/main/main.ts' }, outExtension: { '.js': '.cjs' }, define: { RAVENRY_TEST_HOOKS: RELEASE ? 'false' : 'true' }, minifySyntax: true },
  { ...node, entryPoints: { preload: 'src/preload/preload.ts' }, outExtension: { '.js': '.cjs' } },
  { ...common, platform: 'browser', format: 'iife', target: 'chrome140', entryPoints: { renderer: 'src/renderer/app.ts' }, plugins: [tokens] },
  // The Settings window (src/main/settings.ts): its preload and its page.
  { ...node, entryPoints: { 'settings-preload': 'src/preload/settings-preload.ts' }, outExtension: { '.js': '.cjs' } },
  { ...common, platform: 'browser', format: 'iife', target: 'chrome140', entryPoints: { settings: 'src/settings/settings.ts' }, plugins: [tokens] },
];
await Promise.all(builds.map((b) => esbuild.build({ ...b, absWorkingDir: ROOT, outdir: OUT })));
fs.copyFileSync(path.join(ROOT, 'src/renderer/index.html'), path.join(OUT, 'index.html'));
fs.copyFileSync(path.join(ROOT, 'src/settings/settings.html'), path.join(OUT, 'settings.html'));
// What pack.mjs checks before it packs: the build's kind.
fs.writeFileSync(path.join(ROOT, '.build-kind'), RELEASE ? 'release\n' : 'test-hooks\n');
console.log(`built dist/ (${RELEASE ? 'release: no test hooks' : 'development: test hooks on'})`);
