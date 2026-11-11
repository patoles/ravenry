#!/usr/bin/env node
// Packages the native Mac app as the one Ravenry a Mac installs:
// Ravenry.app, bundle id dev.ravenry.app, its executable Contents/MacOS/
// Ravenry, as the Electron app is named, so macOS's privacy answers (they
// are kept for the bundle id and the signing team) and the hooks and hub
// service the Electron app wrote (they run Contents/MacOS/Ravenry with
// ELECTRON_RUN_AS_NODE=1, NodeRunner.swift) carry over. Then a zip of it.
//
//   node scripts/package.mjs [--app RavenryMac.app] [--zip OUT.zip]
//
// Inside, beside what scripts/build.sh builds:
//   Contents/MacOS/ravenryd     the daemon, the desktop app's version, as
//                               apps/desktop/scripts/pack.mjs --stage-only
//                               stages it (Resources/ravenryd links to it)
//   Contents/MacOS/node         Node.js (NODE_VERSION below, the one
//                               Electron 45 carries), from nodejs.org, its
//                               SHA-256 checked against the release's
//                               SHASUMS256.txt: the hub service, the setup
//                               and the hooks run on it
//   Contents/Resources/hub, remote, build.json   as the Electron app has them
//   Contents/Resources/setup.mjs  install/setup.ts, bundled (Install.swift)
//   Contents/Resources/AppIcon.icns
// Info.plist: the Electron app's name, id, version and the words macOS
// shows when a pane asks for a guarded folder, the camera... (read from
// apps/desktop/electron-builder.config.mjs, extendInfo), and the ravenry://
// scheme: ravenry://session/<name> opens that session's tab.
//
// Signing: this Mac's Apple Development identity when the keychain has it
// (apps/desktop/scripts/local-identity.mjs; the keychain is only read),
// every binary inside, the hardened runtime, the Electron app's
// entitlements (apps/desktop/build/entitlements.mac.plist). Else ad hoc,
// said loudly: macOS then keeps no privacy answer from one build to the
// next. Checked with codesign --verify --deep --strict and the team of
// every Mach-O inside.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { localIdentity } from '../../desktop/scripts/local-identity.mjs';

const NODE_VERSION = '24.22.2';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const DESKTOP = path.join(REPO, 'apps', 'desktop');
const STAGE = path.join(DESKTOP, '.stage');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const say = (s) => console.log(`package: ${s}`);
const run = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...o });
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const OUT = path.join(MAC, 'build', 'package');
const ZIP = path.resolve(opt('--zip') || path.join(OUT, `RavenryNative-${pkg.version}.zip`));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('package.mjs: an Apple silicon Mac only (Node and ravenryd are this machine\'s)');

// 1. ravenryd (this version), the hub, remote/ and build.json.
say('staging ravenryd and the hub (apps/desktop/scripts/pack.mjs --stage-only)');
execFileSync(process.execPath, [path.join(DESKTOP, 'scripts', 'pack.mjs'), '--stage-only'], { stdio: 'inherit' });
const build = { ...JSON.parse(fs.readFileSync(path.join(STAGE, 'build.json'), 'utf8')), app: 'macos' };

// 2. The app (scripts/build.sh), unless one is given.
let built = opt('--app');
if (!built) {
  const dir = path.join(MAC, 'build', 'for-package');
  built = run(path.join(HERE, 'build.sh'), [dir]).trim().split('\n').pop();
}
built = path.resolve(built);
if (!fs.existsSync(path.join(built, 'Contents', 'MacOS', 'RavenryMac'))) throw new Error(`not a RavenryMac.app: ${built}`);

// 3. Node, checked against the release's sums.
const nodeDir = path.join(MAC, 'build', 'node', NODE_VERSION);
const nodeBin = path.join(nodeDir, 'bin', 'node');
if (!fs.existsSync(nodeBin)) {
  const name = `node-v${NODE_VERSION}-darwin-arm64`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  say(`downloading ${name}.tar.gz`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = (sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`)) || '').split(' ')[0];
  const tgz = Buffer.from(await (await fetch(`${base}/${name}.tar.gz`)).arrayBuffer());
  const got = crypto.createHash('sha256').update(tgz).digest('hex');
  if (!want || got !== want) throw new Error(`${name}.tar.gz: SHA-256 ${got}, the release says ${want || 'nothing'}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-node-'));
  fs.writeFileSync(path.join(tmp, 'node.tgz'), tgz);
  run('/usr/bin/tar', ['-xzf', path.join(tmp, 'node.tgz'), '-C', tmp, `${name}/bin/node`, `${name}/LICENSE`]);
  fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(tmp, name, 'bin', 'node'), nodeBin);
  fs.chmodSync(nodeBin, 0o755);
  fs.copyFileSync(path.join(tmp, name, 'LICENSE'), path.join(nodeDir, 'LICENSE'));
  fs.rmSync(tmp, { recursive: true, force: true });
  say(`Node ${NODE_VERSION}: SHA-256 ${got.slice(0, 16)}... matches the release`);
}

// 4. The app as Ravenry.app.
const app = path.join(OUT, 'Ravenry.app');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
run('/usr/bin/ditto', [built, app]);
const C = path.join(app, 'Contents');
const R = path.join(C, 'Resources');
fs.renameSync(path.join(C, 'MacOS', 'RavenryMac'), path.join(C, 'MacOS', 'Ravenry'));
fs.copyFileSync(path.join(STAGE, 'ravenryd', 'darwin-arm64', 'ravenryd'), path.join(C, 'MacOS', 'ravenryd'));
fs.chmodSync(path.join(C, 'MacOS', 'ravenryd'), 0o755);
fs.copyFileSync(nodeBin, path.join(C, 'MacOS', 'node'));
fs.chmodSync(path.join(C, 'MacOS', 'node'), 0o755);
fs.copyFileSync(path.join(nodeDir, 'LICENSE'), path.join(R, 'LICENSE.node.txt'));
fs.symlinkSync(path.join('..', 'MacOS', 'ravenryd'), path.join(R, 'ravenryd'));
fs.cpSync(path.join(STAGE, 'hub'), path.join(R, 'hub'), { recursive: true });
fs.cpSync(path.join(STAGE, 'hub-modules'), path.join(R, 'hub', 'node_modules'), { recursive: true });
fs.cpSync(path.join(STAGE, 'remote'), path.join(R, 'remote'), { recursive: true });
fs.writeFileSync(path.join(R, 'build.json'), JSON.stringify(build, null, 2) + '\n');
await esbuild.build({ entryPoints: [path.join(MAC, 'install', 'setup.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: path.join(R, 'setup.mjs'), logLevel: 'warning', legalComments: 'none' });

// The icon, from the brand's 1024 px picture.
const iconset = path.join(OUT, 'AppIcon.iconset');
fs.mkdirSync(iconset);
const src = path.join(REPO, 'hub', 'brand', 'ravenry', 'icon-1024.png');
for (const s of [16, 32, 128, 256, 512]) {
  run('/usr/bin/sips', ['-z', String(s), String(s), src, '--out', path.join(iconset, `icon_${s}x${s}.png`)]);
  run('/usr/bin/sips', ['-z', String(s * 2), String(s * 2), src, '--out', path.join(iconset, `icon_${s}x${s}@2x.png`)]);
}
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(R, 'AppIcon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });

// Info.plist: the Electron app's name, id and version, and its words.
const { default: config } = await import(path.join(DESKTOP, 'electron-builder.config.mjs'));
const plist = path.join(C, 'Info.plist');
const set = (k, v) => run('/usr/bin/plutil', ['-replace', k, '-string', v, plist]);
set('CFBundleExecutable', 'Ravenry');
set('CFBundleIdentifier', config.appId);
set('CFBundleName', config.productName);
set('CFBundleDisplayName', config.productName);
set('CFBundleShortVersionString', pkg.version);
set('CFBundleVersion', pkg.version);
set('CFBundleIconFile', 'AppIcon');
set('LSMinimumSystemVersion', config.mac.minimumSystemVersion);
set('LSApplicationCategoryType', config.mac.category);
set('NSHumanReadableCopyright', config.copyright);
for (const [k, v] of Object.entries(config.mac.extendInfo)) set(k, v);
// ravenry://session/<name> opens that session's tab (SessionLinks.swift).
run('/usr/bin/plutil', ['-replace', 'CFBundleURLTypes', '-json', JSON.stringify([{ CFBundleURLName: 'dev.ravenry.app.session', CFBundleURLSchemes: ['ravenry'] }]), plist]);

// 5. Signing, every binary inside first, then the app.
const id = localIdentity();
const ents = path.join(DESKTOP, 'build', id ? 'entitlements.mac.plist' : 'entitlements.adhoc.plist');
if (id) say(`signing with this Mac's ${id.name} (${id.hash.slice(0, 8)}), hardened runtime; not notarized: for this Mac only`);
else console.log('\n==== UNSIGNED BUILD: signed ad hoc. macOS keeps no privacy answer across builds, and asks again. Never install it as the person\'s Ravenry. ====\n');
const sign = (f, ident) => run('/usr/bin/codesign', ['--force', '--sign', id ? id.hash : '-', '--options', 'runtime', '--timestamp=none', '--entitlements', ents, ...(ident ? ['--identifier', ident] : []), f]);
sign(path.join(C, 'MacOS', 'node'), 'dev.ravenry.app.node');
sign(path.join(C, 'MacOS', 'ravenryd'), 'dev.ravenry.app.ravenryd');
sign(app);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const teams = {};
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { walk(f); continue; }
    const head = Buffer.alloc(4);
    const fd = fs.openSync(f, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (!['cffaedfe', 'cafebabe', 'feedfacf', 'bebafeca'].includes(head.toString('hex'))) continue;
    const t = (execFileSync('/bin/sh', ['-c', 'codesign -dv "$1" 2>&1', 'sh', f], { encoding: 'utf8' }).match(/^TeamIdentifier=(.*)$/m) || [])[1] || 'none';
    (teams[t] ||= []).push(path.relative(app, f));
  }
};
walk(app);
say(`teams: ${Object.entries(teams).map(([t, fs_]) => `${t}: ${fs_.join(', ')}`).join('; ')}`);
if (id && (Object.keys(teams).length !== 1 || !teams[id.team])) throw new Error(`a binary inside is not signed by team ${id.team}`);
say(`requirement: ${execFileSync('/bin/sh', ['-c', 'codesign -d -r- "$1" 2>&1 | sed -n "s/^designated => //p"', 'sh', app], { encoding: 'utf8' }).trim()}`);

// 6. The zip, as macOS's Archive Utility makes it.
fs.mkdirSync(path.dirname(ZIP), { recursive: true });
fs.rmSync(ZIP, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, ZIP]);
say(`${app}`);
say(`${ZIP} (${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MiB), ${build.id}`);
