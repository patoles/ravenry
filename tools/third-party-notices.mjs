#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.txt: every project whose code, fonts or data
// Ravenry's builds carry, for each thing that ships (ravenryd, the Mac app,
// the Linux desktop app, the Android app), with each licence text in full.
// The apps carry the file (the Mac app and the desktop app in their
// resources, opened from Help, Open Source Licences; the Android app in its
// assets, opened from Settings, Open source licences).
//
//   node tools/third-party-notices.mjs            write the file
//   node tools/third-party-notices.mjs --check    exit 1 when it is out of date
//   node tools/third-party-notices.mjs --android  refresh tools/third-party/android.txt
//                                                 from Gradle first (needs the Android SDK)
//
// Run it after a dependency changes, on a Mac where the daemon has been
// built once (daemon/scripts/libghostty.sh: the Ghostty source and Zig's
// package cache hold the licences of what libghostty-vt is built from) and
// `npm ci` has run. What it reads:
//   Go        go list -deps of ./cmd/... for darwin and linux, arm64 and
//             amd64, and each module's licence file in the module cache
//   npm       the packages esbuild puts in the desktop app's bundles (the
//             same entry points as apps/desktop/build.mjs), from node_modules
//   Ghostty   daemon/.deps/ghostty-src and Zig's package cache
//   Android   tools/third-party/android.txt (the release runtime classpath)
//   the rest  the entries in FIXED below, with texts from this repository
//             and tools/third-party/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt');
const TP = path.join(ROOT, 'tools', 'third-party');
const args = process.argv.slice(2);
const read = (p) => fs.readFileSync(p, 'utf8');
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...o });
const die = (m) => { console.error(`third-party-notices: ${m}`); process.exit(2); };

// The things that ship, in the order the file lists them.
const SHIPS = {
  ravenryd: 'ravenryd, the daemon (inside the Mac app and the Linux desktop app, and installed on every machine Ravenry reaches)',
  mac: 'The Mac app (Ravenry.app), besides ravenryd',
  linux: 'The Linux desktop app (AppImage and .deb), besides ravenryd',
  android: 'The Android app',
};
const entries = [];
const add = (e) => entries.push(e);
const licenceFile = (dir) => {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^(licen[cs]e|copying)([.-].*)?$/i.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort().map((f) => read(path.join(dir, f)));
};

// ---------------------------------------------------------------- Go
const DAEMON = path.join(ROOT, 'daemon');
const goEnv = { ...process.env, CGO_ENABLED: '1' };
const goRoot = run('go', ['env', 'GOROOT'], { cwd: DAEMON }).trim();
const goVersion = run('go', ['env', 'GOVERSION'], { cwd: DAEMON }).trim();
add({ name: 'Go standard library and runtime', version: goVersion, licence: 'BSD-3-Clause', url: 'https://go.dev', ships: ['ravenryd'], texts: licenceFile(goRoot) });
const mods = new Map();
for (const goos of ['darwin', 'linux']) for (const goarch of ['arm64', 'amd64']) {
  const out = run('go', ['list', '-deps', '-f', '{{if .Module}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}', './cmd/...'], { cwd: DAEMON, env: { ...goEnv, GOOS: goos, GOARCH: goarch } });
  for (const line of out.split('\n')) {
    const [p, v, d] = line.trim().split(' ');
    if (!p || p === 'ravenryd') continue;
    mods.set(p, { v, d: d || mods.get(p)?.d });
  }
}
const GO_LICENCE = {
  'github.com/coder/websocket': 'ISC', 'github.com/fxamacker/cbor/v2': 'MIT', 'github.com/gaissmai/bart': 'MIT', 'github.com/creack/pty': 'MIT',
  'github.com/jsimonetti/rtnetlink': 'MIT', 'github.com/mdlayher/netlink': 'MIT', 'github.com/mdlayher/socket': 'MIT', 'github.com/mitchellh/go-ps': 'MIT',
  'github.com/tailscale/certstore': 'MIT', 'github.com/tailscale/wireguard-go': 'MIT', 'github.com/x448/float16': 'MIT', 'go.mitchellh.com/libghostty': 'MIT',
  'github.com/golang/groupcache': 'Apache-2.0', 'github.com/google/btree': 'Apache-2.0', 'github.com/pires/go-proxyproto': 'Apache-2.0',
  'github.com/safchain/ethtool': 'Apache-2.0', 'go4.org/mem': 'Apache-2.0', 'gvisor.dev/gvisor': 'Apache-2.0',
};
for (const [p, { v, d }] of [...mods].sort()) {
  const dir = d || run('go', ['list', '-m', '-f', '{{.Dir}}', `${p}@${v}`], { cwd: DAEMON }).trim();
  const texts = licenceFile(dir);
  if (!texts.length) die(`no licence file in ${p}@${v} (${dir})`);
  add({ name: p, version: v, licence: GO_LICENCE[p] || 'BSD-3-Clause', url: `https://pkg.go.dev/${p}`, ships: ['ravenryd'], texts });
}
const xImage = mods.get('golang.org/x/image');
add({ name: 'Go Mono fonts (golang.org/x/image/font/gofont), drawn into pictures of panes', version: xImage.v, licence: 'BSD-3-Clause', url: 'https://go.dev/blog/go-fonts', ships: ['ravenryd'], texts: [read(path.join(xImage.d, 'font', 'gofont', 'ttfs', 'README'))] });

// ---------------------------------------------------------------- libghostty-vt
// The C library behind go.mitchellh.com/libghostty, built by
// daemon/scripts/libghostty.sh with Ravenry's patches (daemon/patches) and
// linked into ravenryd, with what the Ghostty build puts in it.
const GSRC = path.join(DAEMON, '.deps', 'ghostty-src');
if (!fs.existsSync(path.join(GSRC, 'LICENSE'))) die('daemon/.deps/ghostty-src is missing: run daemon/scripts/libghostty.sh once');
const gcommit = run('git', ['-C', GSRC, 'rev-parse', '--short=12', 'HEAD']).trim();
const ZIGP = path.join(os.homedir(), '.cache', 'zig', 'p');
const zon = (rel) => read(path.join(GSRC, rel));
const zigTar = (hash, files) => {
  const tgz = path.join(ZIGP, `${hash}.tar.gz`);
  const dir = path.join(ZIGP, hash);
  return files.map((f) => {
    if (fs.existsSync(path.join(dir, f))) return read(path.join(dir, f));
    if (!fs.existsSync(tgz)) die(`Zig's package cache has no ${hash}: build libghostty-vt once (daemon/scripts/libghostty.sh)`);
    return run('tar', ['-xzOf', tgz, `${hash}/${f}`]);
  });
};
const hashIn = (rel, key) => {
  const t = zon(rel);
  const at = key ? t.indexOf(`.${key} = .{`) : 0;
  const m = /\.hash = "([^"]+)"/.exec(t.slice(at));
  if (!m) die(`no .hash in ${rel}${key ? ` for ${key}` : ''}`);
  return m[1];
};
const verIn = (rel, name) => (new RegExp(`\\.name = "${name}"[^}]*\\.version = "([^"]+)"`).exec(zon(rel)) || [])[1] || '';
add({ name: `libghostty-vt, from Ghostty (with Ravenry's patches in daemon/patches)`, version: gcommit, licence: 'MIT', url: 'https://github.com/ghostty-org/ghostty', ships: ['ravenryd'], texts: [read(path.join(GSRC, 'LICENSE'))] });
add({ name: 'simdutf (in libghostty-vt)', version: (/\.version = "([^"]+)"/.exec(zon('pkg/simdutf/build.zig.zon')) || [])[1], licence: 'Apache-2.0 OR MIT, used under MIT', url: 'https://github.com/simdutf/simdutf', ships: ['ravenryd'], texts: [read(path.join(GSRC, 'pkg/simdutf/vendor/LICENSE-MIT'))] });
add({ name: 'Highway (in libghostty-vt)', version: verIn('pkg/highway/build.zig.zon', 'highway'), licence: 'Apache-2.0 OR BSD-3-Clause, used under BSD-3-Clause', url: 'https://github.com/google/highway', ships: ['ravenryd'], texts: zigTar(hashIn('pkg/highway/build.zig.zon'), ['LICENSE-BSD3']) });
add({ name: 'Wuffs (in libghostty-vt)', version: verIn('pkg/wuffs/build.zig.zon', 'wuffs'), licence: 'Apache-2.0 OR MIT, used under MIT', url: 'https://github.com/google/wuffs', ships: ['ravenryd'], texts: zigTar(hashIn('pkg/wuffs/build.zig.zon', 'wuffs'), ['LICENSE-MIT']) });
const uuHash = hashIn('build.zig.zon', 'uucode');
add({ name: 'uucode, with Unicode data and a UTF-8 decoder (in libghostty-vt)', version: uuHash.split('-')[1], licence: 'MIT AND Unicode-3.0', url: 'https://github.com/jacobsandlund/uucode', ships: ['ravenryd'], texts: [...zigTar(uuHash, ['LICENSE.md']), read(path.join(TP, 'uucode-LICENSE_Bjoern_Hoehrmann.txt')), read(path.join(TP, 'uucode-LICENSE_unicode.txt'))] });
const zigLic = path.join(path.dirname(path.dirname(fs.realpathSync(run('which', ['zig']).trim()))), 'LICENSE');
add({ name: "Zig's runtime library, compiler_rt (in libghostty-vt)", version: run('zig', ['version']).trim(), licence: 'MIT', url: 'https://ziglang.org', ships: ['ravenryd'], texts: [read(zigLic)] });
add({ name: 'The GNU C Library (Linux builds only, linked statically)', version: '', licence: 'LGPL-2.1-or-later', url: 'https://www.gnu.org/software/libc/', ships: ['ravenryd'], note: "ravenryd's whole source is published under the GPL (LICENSE), so it can be linked again with a changed glibc.", texts: [read(path.join(TP, 'LGPL-2.1.txt'))] });

// ---------------------------------------------------------------- fixed entries
const OFL = read(path.join(ROOT, 'daemon', 'internal', 'render', 'fonts', 'OFL.txt'));
const mit = (holders) => `MIT License\n\n${holders.map((h) => `Copyright (c) ${h}`).join('\n')}\n\n${MIT_BODY}`;
const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const APACHE = read(path.join(ROOT, 'packages', 'LICENSE'));
const topComment = (file) => read(file).split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
const nodeVersion = (/const NODE_VERSION = '([^']+)'/.exec(read(path.join(ROOT, 'apps', 'macos', 'scripts', 'package.mjs'))) || [])[1];
const pkgVersion = (name) => JSON.parse(read(path.join(ROOT, 'node_modules', name, 'package.json'))).version;

add({ name: 'Noto Sans Mono, Noto Sans Symbols 2, Noto Sans Math, Noto Sans Symbols and Noto Emoji, subsets (pictures of panes)', version: '', licence: 'OFL-1.1', url: 'https://github.com/notofonts', ships: ['ravenryd'], texts: [OFL] });
add({ name: 'Shell integration for zsh and bash, parts based on the shell integration of Ghostty and of kitty', version: '', licence: 'GPL-3.0-or-later, used under GPL-3.0-only', url: 'https://github.com/kovidgoyal/kitty', ships: ['ravenryd'], note: 'daemon/internal/pane/shell/zsh/.zshenv and daemon/internal/pane/shell/bash/ravenry.bash say which parts; the GPL text is LICENSE beside this file.', texts: [] });

add({ name: 'Node.js (runs the hub, the setup and the hooks)', version: nodeVersion, licence: 'MIT, with the licences of the projects Node.js includes', url: 'https://nodejs.org', ships: ['mac'], note: "Its full licence, with every project Node.js includes, is LICENSE.node.txt beside this file in the app's resources.", texts: [] });
add({ name: 'uqr (the hub, the phone pairing QR code)', version: '0.1.2', licence: 'MIT', url: 'https://github.com/unjs/uqr', ships: ['mac', 'linux'], texts: [topComment(path.join(ROOT, 'hub', 'server', 'vendor', 'uqr.mjs')).split('\nMIT License\n')[1] ? 'MIT License\n' + topComment(path.join(ROOT, 'hub', 'server', 'vendor', 'uqr.mjs')).split('\nMIT License\n')[1] : die('no MIT text in hub/server/vendor/uqr.mjs')] });
add({ name: 'yaml (the hub, the page files)', version: pkgVersion('yaml'), licence: 'ISC', url: 'https://github.com/eemeli/yaml', ships: ['mac', 'linux'], texts: licenceFile(path.join(ROOT, 'node_modules', 'yaml')) });
add({ name: 'Ravenry Glyphs, the terminal glyph font: subsets of Noto Sans Mono, Noto Sans Symbols 2, Noto Sans Math and Noto Sans Symbols', version: '', licence: 'OFL-1.1', url: 'https://github.com/notofonts', ships: ['mac', 'android'], texts: [read(path.join(ROOT, 'apps', 'phone', 'src', 'OFL.txt'))] });
add({ name: 'Terminal themes: Solarized, Dracula, Nord, GitHub Light (colour palettes)', version: '', licence: 'MIT', url: 'https://github.com/altercation/solarized', ships: ['mac', 'linux'], texts: [mit(['2011 Ethan Schoonover (Solarized)', '2023 Dracula Theme (Dracula)', '2016-present Sven Greb (Nord)', '2020 Primer (GitHub Light)'])] });

const electronDir = path.join(ROOT, 'node_modules', 'electron');
add({ name: 'Electron, with Chromium and Node.js', version: pkgVersion('electron'), licence: 'MIT, with the licences of the projects Chromium includes', url: 'https://www.electronjs.org', ships: ['linux'], note: "Chromium's licences, and those of everything it includes, are LICENSES.chromium.html in the app's folder.", texts: licenceFile(electronDir) });

// ---------------------------------------------------------------- npm (the desktop app's bundles)
const esbuild = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
const D = path.join(ROOT, 'apps', 'desktop');
const absent = { name: 'absent', setup(b) { b.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (a) => ({ path: a.path, namespace: 'absent' })); b.onLoad({ filter: /.*/, namespace: 'absent' }, () => ({ contents: '', loader: 'js' })); } };
const tokens = { name: 'tokens', setup(b) { b.onResolve({ filter: /^ravenry-tokens\.css$/ }, (a) => ({ path: a.path, namespace: 'tokens' })); b.onLoad({ filter: /.*/, namespace: 'tokens' }, () => ({ contents: '', loader: 'css' })); } };
const pkgs = new Map();
for (const o of [
  { entryPoints: ['src/main/main.ts', 'src/preload/preload.ts', 'src/preload/settings-preload.ts'], platform: 'node', format: 'cjs', external: ['electron'], plugins: [absent], define: { RAVENRY_TEST_HOOKS: 'false' }, minifySyntax: true },
  { entryPoints: ['src/renderer/app.ts', 'src/settings/settings.ts'], platform: 'browser', format: 'iife', plugins: [tokens] },
]) {
  const r = await esbuild.build({ ...o, absWorkingDir: D, bundle: true, write: false, outdir: path.join(os.tmpdir(), 'rvn-notices'), metafile: true, logLevel: 'error' });
  for (const f of Object.keys(r.metafile.inputs)) {
    const m = f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
    if (!m) continue;
    const name = m[m.length - 1].replace('node_modules/', '');
    const dir = path.resolve(D, f.slice(0, f.lastIndexOf(`node_modules/${name}/`) + `node_modules/${name}`.length));
    pkgs.set(name, dir);
  }
}
for (const [name, dir] of [...pkgs].sort()) {
  if (name === 'yaml') { entries.find((e) => e.name.startsWith('yaml ')).ships.push('linux'); continue; }
  const p = JSON.parse(read(path.join(dir, 'package.json')));
  const lic = typeof p.license === 'string' ? p.license : p.license?.type;
  if (!lic) die(`${name} names no licence`);
  let texts = licenceFile(dir);
  let note;
  if (!texts.length) {
    if (lic !== 'MIT') die(`${name} has no licence file and is not MIT`);
    const author = typeof p.author === 'string' ? p.author : p.author?.name;
    texts = [mit([author.replace(/\s*<[^>]*>/, '')])];
    note = 'The package has no licence file; its package.json says MIT, by its author named here.';
  }
  add({ name, version: p.version, licence: lic, url: `https://www.npmjs.com/package/${name}`, ships: ['linux'], note, texts });
}

// ---------------------------------------------------------------- Android
if (args.includes('--android')) {
  const a = path.join(ROOT, 'apps', 'android');
  const out = run(path.join(a, 'gradlew'), ['-q', ':app:dependencies', '--configuration', 'releaseRuntimeClasspath'], { cwd: a });
  const coords = new Map();
  for (const m of out.matchAll(/--- ([\w.-]+):([\w.-]+):([^\s]+)(?: -> ([^\s]+))?/g)) {
    if (m[2].endsWith('-bom')) continue;
    coords.set(`${m[1]}:${m[2]}`, m[4] || m[3]);
  }
  fs.writeFileSync(path.join(TP, 'android.txt'), [...coords].sort().map(([k, v]) => `${k}:${v}`).join('\n') + '\n');
}
const ANDROID_LICENCE = [
  [/^androidx\./, 'Apache-2.0', 'The Android Open Source Project'],
  [/^org\.jetbrains\.kotlinx?(:|$)/, 'Apache-2.0', 'JetBrains s.r.o. and Kotlin Programming Language contributors'],
  [/^org\.jetbrains$/, 'Apache-2.0', 'JetBrains s.r.o.'],
  [/^com\.squareup\./, 'Apache-2.0', 'Square, Inc.'],
  [/^com\.google\.zxing$/, 'Apache-2.0', 'ZXing authors'],
  [/^com\.google\.(crypto\.tink|code\.gson|errorprone|guava|auto\.value|code\.findbugs)$/, 'Apache-2.0', 'Google LLC and its authors'],
  [/^org\.jspecify$/, 'Apache-2.0', 'The JSpecify Authors'],
  [/^org\.unifiedpush\.android$/, 'Apache-2.0', 'UnifiedPush contributors'],
  [/^com\.google\.protobuf$/, 'BSD-3-Clause', 'Google Inc.'],
];
const androidLines = read(path.join(TP, 'android.txt')).trim().split('\n');
for (const line of androidLines) {
  const [g, a, v] = line.split(':');
  const rule = ANDROID_LICENCE.find(([re]) => re.test(g));
  if (!rule) die(`no licence known for the Android dependency ${line}: add its group to ANDROID_LICENCE`);
  add({ name: `${g}:${a}`, version: v, licence: rule[1], url: `https://mvnrepository.com/artifact/${g}/${a}`, ships: ['android'], holder: rule[2], texts: [rule[1] === 'BSD-3-Clause' ? read(path.join(TP, 'protobuf-LICENSE.txt')) : APACHE] });
}
add({ name: 'The Public Suffix List (inside OkHttp, com.squareup.okhttp3:okhttp)', version: '', licence: 'MPL-2.0', url: 'https://publicsuffix.org', ships: ['android'], note: 'publicsuffixes.gz is compiled from https://publicsuffix.org/list/public_suffix_list.dat, which is its source, under the Mozilla Public License, version 2.0: https://mozilla.org/MPL/2.0/', texts: [] });

// ---------------------------------------------------------------- write
const norm = (t) => t.replace(/\s+/g, '');
const texts = new Map(); // hash -> { text, users }
for (const e of entries) {
  e.refs = e.texts.map((t) => {
    const h = crypto.createHash('sha256').update(norm(t)).digest('hex');
    if (!texts.has(h)) texts.set(h, { text: t.replace(/\r/g, '').trimEnd(), users: [], n: 0 });
    texts.get(h).users.push(`${e.name}${e.version ? ' ' + e.version : ''}`);
    return h;
  });
}
let n = 0;
for (const t of texts.values()) t.n = ++n;
const L = [];
L.push('Third-party notices for Ravenry');
L.push('');
L.push('Ravenry is free software: everything outside packages/ is under the GNU');
L.push('General Public License, version 3 only (LICENSE), and packages/ is under');
L.push('the Apache License, Version 2.0 (packages/LICENSE); LICENSING.md says');
L.push('which is which. Its builds include the work of the projects below, each');
L.push('under its own licence. They are listed for each thing that ships, then');
L.push('each licence text follows in full, numbered.');
L.push('');
L.push('This file is written by tools/third-party-notices.mjs. Do not edit it by hand.');
for (const [k, title] of Object.entries(SHIPS)) {
  const list = entries.filter((e) => e.ships.includes(k));
  if (!list.length) continue;
  L.push('', '', '='.repeat(76), title, '='.repeat(76), '');
  for (const e of list) {
    L.push(`${e.name}${e.version ? ' ' + e.version : ''}`);
    L.push(`  Licence: ${e.licence}${e.refs.length ? ` (text ${e.refs.map((h) => texts.get(h).n).join(', ')})` : ''}`);
    if (e.holder) L.push(`  Copyright: ${e.holder}`);
    L.push(`  ${e.url}`);
    if (e.note) L.push(`  ${e.note}`);
  }
}
L.push('', '', '='.repeat(76), 'Licence texts', '='.repeat(76));
for (const t of texts.values()) {
  const users = [...new Set(t.users)];
  L.push('', '-'.repeat(76), `Text ${t.n}, for ${users.length > 6 ? `${users.slice(0, 6).join(', ')} and ${users.length - 6} more` : users.join(', ')}`, '-'.repeat(76), '', t.text);
}
const body = L.join('\n').replace(/[ \t]+$/gm, '') + '\n';
if (args.includes('--check')) {
  const cur = fs.existsSync(OUT) ? read(OUT) : '';
  if (cur !== body) { console.error('THIRD_PARTY_NOTICES.txt is out of date: run node tools/third-party-notices.mjs'); process.exit(1); }
  console.log('THIRD_PARTY_NOTICES.txt is current');
} else {
  fs.writeFileSync(OUT, body);
  console.log(`wrote THIRD_PARTY_NOTICES.txt: ${entries.length} entries, ${texts.size} licence texts, ${(body.length / 1024).toFixed(0)} KiB`);
}
