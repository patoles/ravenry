#!/usr/bin/env node
// Packages the native Mac app as the one Ravenry a Mac installs:
// Ravenry.app, bundle id dev.ravenry.app, its executable Contents/MacOS/
// Ravenry, as the Electron app is named, so macOS's privacy answers (they
// are kept for the bundle id and the signing team) and the hooks and hub
// service the Electron app wrote (they run Contents/MacOS/Ravenry with
// ELECTRON_RUN_AS_NODE=1, NodeRunner.swift) carry over. Then a zip of it.
//
//   node scripts/package.mjs [--app RavenryMac.app] [--zip OUT.zip] [--out DIR]
//
// DIR (default build/package) is emptied first and gets the app, the zip,
// the feed, the dmg and the test twin.
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
//   Contents/Resources/app-update.json  the GitHub repository its updates
//                               come from (Updater.swift): the public one the
//                               testers' copies read, the root package.json's
//                               ravenry.releases (the npm board's repository);
//                               RAVENRY_UPDATE_REPO=owner/repo in its place
//                               for a build that reads another
//   Contents/MacOS/ravenry      is Contents/MacOS/Ravenry (macOS's file names
//                               ignore case), so no link can sit there: the
//                               executable called by that name runs ravenryd
//                               as `ravenry` (main.swift), which a skill
//                               written by 0.1.33 runs (`.../MacOS/ravenry skill`)
// Beside the zip: latest-mac-native.json, the native updater's feed (its
// version, the zip's name, its SHA-256 and size), and Ravenry-<version>-
// mac-arm64.dmg, the app and a link to /Applications in a window, for a
// first install by hand (UPD-008), with the same file again as
// Ravenry-mac.dmg (a hard link): the name the launch page links on
// releases/latest/download/, the same on every release.
//
// The test twin (SIGN-003): build/package/release-test/Ravenry.app, the same
// bundle (the same executable, ravenryd, Node and hub, byte for byte) with
// RavenryTestHooks in its Info.plist, signed again. Gate.swift: a release
// takes no test hook from its launch (no --offscreen, --sidetest, --selftest,
// RAVENRY_HUB_URL, fixture or update feed); the twin takes them all, and the
// harness (sidetest.mjs SIDETEST_APP, selftest.sh, relaunchcheck, updatecheck,
// installcheck, npmswitchcheck) runs on it. It is never zipped or shipped. Publishing is a person's
// step: tools/publish-testers.mjs (dry run unless --yes) makes the release
// v<version> on that repository with the zip, the feed and both dmgs, which
// the updater reads as releases/latest/download/latest-mac-native.json.
// Info.plist: the Electron app's name, id, version and the words macOS
// shows when a pane asks for a guarded folder, the camera... (read from
// apps/desktop/electron-builder.config.mjs, extendInfo), and the ravenry://
// scheme: ravenry://session/<name> opens that session's tab.
//
// Signing: this Mac's Apple Development identity when the keychain has it
// (apps/desktop/scripts/local-identity.mjs; the keychain is only read),
// every binary inside (the Mac builds in Resources/remote/*.gz too), the
// hardened runtime, the Electron app's entitlements
// (apps/desktop/build/entitlements.mac.plist). Else ad hoc,
// said loudly: macOS then keeps no privacy answer from one build to the
// next. Checked with codesign --verify --deep --strict and the team of
// every Mach-O inside.
//
// The release signing (SIGN-004), switched on by the environment alone, no
// code change: RAVENRY_SIGN_IDENTITY names a Developer ID Application
// identity in the keychain (its SHA-1 or its name, "Developer ID
// Application: ..."), used in place of the Apple Development one, with a
// secure timestamp; the team every Mach-O must carry is read from it. Then,
// with RAVENRY_NOTARY_PROFILE (a profile `xcrun notarytool store-credentials`
// made) or APPLE_API_KEY (the .p8 file), APPLE_API_KEY_ID and
// APPLE_API_ISSUER (release.yml's names), the app is notarized (its zip sent,
// `notarytool submit --wait`) and stapled before the zip and the feed are
// made, and the dmg is signed, notarized and stapled too.
// RAVENRY_NOTARY_DRY=1 prints those commands instead of running them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
const OUT = path.resolve(opt('--out') || path.join(MAC, 'build', 'package'));
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
// Where updates come from: the public releases (the root package.json's ravenry.releases),
// or RAVENRY_UPDATE_REPO. Not GITHUB_REPOSITORY: a fork's CI sets it to the fork.
{
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const slug = process.env.RAVENRY_UPDATE_REPO || rootPkg.ravenry?.releases;
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(slug || ''))) throw new Error(`package.mjs: no GitHub repository for updates (ravenry.releases in package.json, or RAVENRY_UPDATE_REPO=owner/repo): ${slug}`);
  const [owner, repo] = slug.split('/');
  say(`updates from github.com/${owner}/${repo} (app-update.json)`);
  fs.writeFileSync(path.join(R, 'app-update.json'), JSON.stringify({ provider: 'github', owner, repo, feed: 'latest-mac-native.json' }, null, 2) + '\n');
}
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
// The release's Developer ID (RAVENRY_SIGN_IDENTITY), found in the keychain (in CI too), else this Mac's Apple Development one.
function releaseIdentity(want) {
  let out = '';
  try { out = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { /* none */ }
  const line = out.split('\n').find((l) => l.toUpperCase().includes(want.toUpperCase()));
  if (!line) throw new Error(`RAVENRY_SIGN_IDENTITY: no code-signing identity "${want}" in the keychain (security find-identity -v -p codesigning)`);
  const [, hash, name] = /([0-9A-F]{40})\s+"([^"]+)"/i.exec(line) || [];
  return { hash: hash || want, name: name || want, team: null, release: true };
}
const id = process.env.RAVENRY_SIGN_IDENTITY ? releaseIdentity(process.env.RAVENRY_SIGN_IDENTITY) : localIdentity();
const notary = process.env.RAVENRY_NOTARY_PROFILE ? ['--keychain-profile', process.env.RAVENRY_NOTARY_PROFILE]
  : (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ? ['--key', process.env.APPLE_API_KEY, '--key-id', process.env.APPLE_API_KEY_ID, '--issuer', process.env.APPLE_API_ISSUER] : null;
if (notary && !id?.release) throw new Error('notarization needs a Developer ID: set RAVENRY_SIGN_IDENTITY too');
const dry = process.env.RAVENRY_NOTARY_DRY === '1';
/** notarytool and stapler, or what they would run (RAVENRY_NOTARY_DRY=1). */
const xcrun = (args) => {
  if (dry) { say(`would run: xcrun ${args.map((a) => (a === process.env.APPLE_API_KEY_ID || a === process.env.APPLE_API_ISSUER ? '<secret>' : a)).join(' ')}`); return ''; }
  return run('/usr/bin/xcrun', args, { stdio: ['ignore', 'pipe', 'inherit'] });
};
// notarytool exits 0 on an Invalid answer too: its status is read, and Apple's log printed when it is not Accepted.
const notarize = (f) => {
  say(`notarizing ${path.basename(f)} (waits for Apple's answer)`);
  const out = xcrun(['notarytool', 'submit', f, ...notary, '--wait']);
  if (dry) return;
  const sub = (/^\s*id: (\S+)/m.exec(out) || [])[1] || '?';
  const status = [...out.matchAll(/^\s*status: (.+)$/gm)].map((m) => m[1].trim()).pop() || 'unknown';
  say(`notarization ${sub}: ${status}`);
  if (status !== 'Accepted') {
    let log = '';
    try { log = xcrun(['notarytool', 'log', sub, ...notary]); } catch { /* none */ }
    throw new Error(`${path.basename(f)}: notarization ${sub} is ${status}, not Accepted\n${log}`);
  }
};
const staple = (f) => { xcrun(['stapler', 'staple', f]); if (!dry) xcrun(['stapler', 'validate', f]); };
const ents = path.join(DESKTOP, 'build', id ? 'entitlements.mac.plist' : 'entitlements.adhoc.plist');
if (id?.release) say(`signing with ${id.name} (${id.hash.slice(0, 8)}), hardened runtime, a secure timestamp; ${notary ? 'notarized and stapled below' : 'NOT notarized (no RAVENRY_NOTARY_PROFILE or APPLE_API_KEY*)'}`);
else if (id) say(`signing with this Mac's ${id.name} (${id.hash.slice(0, 8)}), hardened runtime; not notarized: for this Mac only`);
else console.log('\n==== UNSIGNED BUILD: signed ad hoc. macOS keeps no privacy answer across builds, and asks again. Never install it as the person\'s Ravenry. ====\n');
const stamp = id?.release ? '--timestamp' : '--timestamp=none';
const sign = (f, ident) => run('/usr/bin/codesign', ['--force', '--sign', id ? id.hash : '-', '--options', 'runtime', stamp, '--entitlements', ents, ...(ident ? ['--identifier', ident] : []), f]);
sign(path.join(C, 'MacOS', 'node'), 'dev.ravenry.app.node');
sign(path.join(C, 'MacOS', 'ravenryd'), 'dev.ravenry.app.ravenryd');
// The Mac builds a remote machine gets (Resources/remote/ravenryd-darwin-*.gz, hub/server/remoteinstall.mjs)
// are Mach-O too, and Apple's notary service looks inside the .gz: each is signed as ravenryd is, gzipped
// again, and builds.json given its new SHA-256 and size (the remote install checks the copy against them).
const remoteTeams = [];
if (id) {
  const rdir = path.join(R, 'remote');
  const bj = path.join(rdir, 'builds.json');
  const builds = fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : { builds: {} };
  for (const [key, b] of Object.entries(builds.builds || {})) {
    if (!key.startsWith('darwin-')) continue;
    const gz = path.join(rdir, b.file);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-remote-')), `ravenryd-${key}`);
    fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(gz)), { mode: 0o755 });
    sign(tmp, 'dev.ravenry.app.ravenryd');
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', tmp], { stdio: 'inherit' });
    const t = (execFileSync('/bin/sh', ['-c', 'codesign -dv "$1" 2>&1', 'sh', tmp], { encoding: 'utf8' }).match(/^TeamIdentifier=(.*)$/m) || [])[1] || 'none';
    remoteTeams.push([t, `Contents/Resources/remote/${b.file}/ravenryd-${key}`]);
    const raw = fs.readFileSync(tmp);
    fs.writeFileSync(gz, zlib.gzipSync(raw, { level: 9 }));
    Object.assign(b, { sha256: crypto.createHash('sha256').update(raw).digest('hex'), size: raw.length });
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
  if (remoteTeams.length) fs.writeFileSync(bj, JSON.stringify(builds, null, 2) + '\n');
}
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
for (const [t, f] of remoteTeams) (teams[t] ||= []).push(f);
say(`teams: ${Object.entries(teams).map(([t, fs_]) => `${t}: ${fs_.join(', ')}`).join('; ')}`);
if (id && (Object.keys(teams).length !== 1 || (id.team && !teams[id.team]) || teams.none)) throw new Error(`a binary inside is not signed by team ${id.team || Object.keys(teams).join(' or ')}`);
say(`requirement: ${execFileSync('/bin/sh', ['-c', 'codesign -d -r- "$1" 2>&1 | sed -n "s/^designated => //p"', 'sh', app], { encoding: 'utf8' }).trim()}`);

// 6. The zip, as macOS's Archive Utility makes it; a release notarized and stapled first.
fs.mkdirSync(path.dirname(ZIP), { recursive: true });
fs.rmSync(ZIP, { force: true });
if (notary) {
  const sub = path.join(os.tmpdir(), `rvn-notary-${process.pid}.zip`);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, sub]);
  try { notarize(sub); } finally { fs.rmSync(sub, { force: true }); }
  staple(app);
}
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, ZIP]);
// The feed beside the zip (Updater.swift reads it from the release).
const zipBytes = fs.readFileSync(ZIP);
const FEED = path.join(path.dirname(ZIP), 'latest-mac-native.json');
fs.writeFileSync(FEED, JSON.stringify({
  version: pkg.version, url: path.basename(ZIP), sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'), size: zipBytes.length,
  minimumSystemVersion: config.mac.minimumSystemVersion, releaseDate: new Date().toISOString(), build: build.id,
}, null, 2) + '\n');
// The dmg: the app and a link to /Applications, as electron-builder's (title "Ravenry <version>").
const DMG = path.join(path.dirname(ZIP), `Ravenry-${pkg.version}-mac-arm64.dmg`);
{
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-dmg-'));
  run('/usr/bin/ditto', [app, path.join(src, 'Ravenry.app')]);
  fs.symlinkSync('/Applications', path.join(src, 'Applications'));
  fs.rmSync(DMG, { force: true });
  run('/usr/bin/hdiutil', ['create', '-quiet', '-volname', `Ravenry ${pkg.version}`, '-srcfolder', src, '-fs', 'HFS+', '-format', 'UDZO', '-ov', DMG]);
  fs.rmSync(src, { recursive: true, force: true });
  if (id) run('/usr/bin/codesign', ['--force', '--sign', id.hash, stamp, DMG]);
  run('/usr/bin/hdiutil', ['verify', '-quiet', DMG]);
  if (notary) { notarize(DMG); staple(DMG); }
}
// The same dmg under the name the launch page links, on every release.
const DMG_FIXED = path.join(path.dirname(ZIP), 'Ravenry-mac.dmg');
fs.rmSync(DMG_FIXED, { force: true });
try { fs.linkSync(DMG, DMG_FIXED); } catch { fs.copyFileSync(DMG, DMG_FIXED); }
// The test twin: the same bundle with the test hooks on (Gate.swift), signed again.
const TWIN = path.join(OUT, 'release-test', 'Ravenry.app');
fs.mkdirSync(path.dirname(TWIN), { recursive: true });
run('/usr/bin/ditto', [app, TWIN]);
run('/usr/bin/plutil', ['-replace', 'RavenryTestHooks', '-bool', 'YES', path.join(TWIN, 'Contents', 'Info.plist')]);
sign(TWIN);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', TWIN], { stdio: 'inherit' });
say(`${app}`);
say(`${DMG} (${(fs.statSync(DMG).size / 1048576).toFixed(1)} MiB), and as ${path.basename(DMG_FIXED)}`);
say(`${TWIN}: the test twin (test hooks on; the checks run it, never shipped)`);
say(`${ZIP} (${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MiB), ${build.id}`);
say(`${FEED}: the updater's feed; to publish: node tools/publish-testers.mjs (a dry run; --yes publishes)`);
