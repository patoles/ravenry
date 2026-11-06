#!/usr/bin/env node
// Builds server/vendor/page-format.mjs: packages/page-format (the page file
// format, Apache-2.0) and the yaml package it reads YAML with (ISC), in one
// ES module the hub imports with no npm dependency, so `npm i -g
// ravenry-app`, the app's copy of the hub and the hub's Linux CI all run it
// as they are. Minified, so no build path or comment of the machine that
// made it is in it, and it comes out the same everywhere. It also copies
// the shipped pages to pages/defaults/, and the agent docs to pages/pages.md
// (the hub serves them, npm's `ravenry page docs` prints them) and to
// daemon/cmd/ravenryd/pagedocs.md (built into the ravenry binary).
//
//   node hub/tools/vendor-page-format.mjs           write it
//   node hub/tools/vendor-page-format.mjs --check   fail when it is not current
//
// Needs esbuild and yaml from the repository's node_modules (npm ci at the
// top); CI's desktop workflow runs --check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(HUB, '..');
const SRC = path.join(REPO, 'packages', 'page-format', 'src', 'index.ts');
const OUT = path.join(HUB, 'server', 'vendor', 'page-format.mjs');
const yamlPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('yaml'))), '..', 'package.json'), 'utf8'));

const r = await esbuild.build({
  entryPoints: [SRC], bundle: true, format: 'esm', platform: 'neutral', target: 'es2023',
  minify: true, legalComments: 'none', write: false, absWorkingDir: REPO,
  mainFields: ['module', 'main'],
});
const head = `// @ravenry/page-format (packages/page-format in the Ravenry repository,
// Apache-2.0) with yaml ${yamlPkg.version} (https://github.com/eemeli/yaml, ISC), bundled
// and minified by hub/tools/vendor-page-format.mjs. Never edit it by hand:
// change packages/page-format and run that tool.
//
// The yaml package's licence:
//
// Copyright Eemeli Aro <eemeli@gmail.com>
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
// SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
// OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
// CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;
const PF = path.join(REPO, 'packages', 'page-format');
const docs = fs.readFileSync(path.join(PF, 'docs', 'pages.md'), 'utf8');
// The docs go to the hub and into the ravenry binary (`ravenry page docs`).
const want = new Map([[OUT, head + r.outputFiles[0].text], [path.join(HUB, 'pages', 'pages.md'), docs], [path.join(REPO, 'daemon', 'cmd', 'ravenryd', 'pagedocs.md'), docs]]);
for (const f of fs.readdirSync(path.join(PF, 'defaults')).filter((x) => x.endsWith('.page.yaml')).sort()) {
  want.set(path.join(HUB, 'pages', 'defaults', f), fs.readFileSync(path.join(PF, 'defaults', f), 'utf8'));
}
const DEFAULTS = path.join(HUB, 'pages', 'defaults');
const extra = fs.existsSync(DEFAULTS) ? fs.readdirSync(DEFAULTS).map((f) => path.join(DEFAULTS, f)).filter((f) => !want.has(f)) : [];
if (process.argv.includes('--check')) {
  const stale = [...want].filter(([f, text]) => !fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== text).map(([f]) => f);
  if (stale.length || extra.length) {
    console.error(`not current: ${[...stale, ...extra].map((f) => path.relative(REPO, f)).join(', ')}. Run node hub/tools/vendor-page-format.mjs and commit them.`);
    process.exit(1);
  }
  console.log(`${[...want.keys()].map((f) => path.relative(REPO, f)).join(', ')}: current`);
} else {
  for (const f of extra) fs.rmSync(f);
  for (const [f, text] of want) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  console.log(`wrote ${path.relative(REPO, OUT)} (${Math.round(want.get(OUT).length / 1024)} KiB), the shipped pages and pages.md`);
}
