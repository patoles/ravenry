#!/usr/bin/env node
// Packages the desktop app with electron-builder (electron-builder.config.mjs).
//
//   node scripts/pack.mjs [--mac | --linux] [--arch arm64,x64] [--dir]
//                         [--ravenryd DIR] [--skip-build]
//                         [--test-twin | --no-test-twin]
//   node scripts/pack.mjs --stage-only
//
// Defaults: this machine's platform and architecture. --dir makes the
// unpacked app only (no DMG, zip, AppImage or .deb). --ravenryd DIR takes
// ravenryd from DIR/ravenryd-<platform>-<arch> (CI builds each on a machine
// of that platform and architecture); without it, ravenryd is built here
// for this machine (scripts/build-ravenryd.sh). Output: release/.
//
// What goes in release/ is a release build (build.mjs --release): no test
// hooks (src/main/gate.ts), checked in its main.cjs before it is packed.
// Beside it, for one architecture of this machine's platform, its test
// twin in release-test/ (unpacked only): the same stage (ravenryd, hub,
// build.json) with the test hooks on, for the tools that drive the window
// (tools/release-check.mjs runs its window steps on it, CI's first-run.mjs
// too). The twin is never published and never installed. Made by default
// outside CI; --test-twin makes it in CI, --no-test-twin skips it.
//
// --stage-only makes .stage/ and stops: the native Mac app
// (apps/macos/scripts/package.mjs) carries the same ravenryd, hub, remote/
// and build.json.
//
// What goes inside the app, staged in .stage/ first:
//   resources/ravenryd     the daemon, this app's version
//   resources/remote/      ravenryd for the machines the app installs on
//                          over ssh (hub/server/remoteinstall.mjs): every
//                          ravenryd-<platform>-<arch> in --ravenryd DIR (CI
//                          gives all four: darwin and linux, arm64 and x64),
//                          else this machine's; each gzipped, with
//                          builds.json (the version, and each binary's
//                          SHA-256 and size)
//   resources/hub/         the hub (hub/package.json "files"), with
//                          @ravenry/node-client in its node_modules and
//                          the repository's shared/ (words, tokens)
//   resources/build.json   version, commit and build id (install.ts)
//
// Signing, macOS. Signed when a Developer ID certificate is given:
//   CSC_LINK               the .p12 (a path, or its base64), and
//   CSC_KEY_PASSWORD       its password.
// Notarized when signed and one of these is given as well:
//   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
// Without a certificate, on the maintainer's Mac, the app is signed with
// the maintainer's Apple Development identity when the keychain has it
// (scripts/local-identity.mjs): macOS then knows each build as the same
// app, and stops asking again for Documents and the rest at every build.
// The keychain is only read, never changed. Anywhere
// else (CI, another Mac) the app is signed ad hoc, which runs only on the
// machine that built it or after the quarantine is removed, and cannot
// update itself; this says so loudly. RAVENRY_LOCAL_IDENTITY=- forces ad
// hoc; RAVENRY_LOCAL_IDENTITY=<SHA-1> names another identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertTestEnv } from '../../../tools/test-env.mjs';
import { localIdentity } from './local-identity.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP, '..', '..');
const STAGE = path.join(APP, '.stage');
const OUT = path.join(APP, 'release');
const TWIN_OUT = path.join(APP, 'release-test');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const platform = flag('--mac') ? 'darwin' : flag('--linux') ? 'linux' : process.platform;
if (platform !== 'darwin' && platform !== 'linux') { console.error(`pack: no packaging for ${platform} yet`); process.exit(1); }
const arches = (opt('--arch') || process.arch).split(',').map((a) => a.trim()).filter(Boolean);
for (const a of arches) if (a !== 'arm64' && a !== 'x64') { console.error(`pack: unknown architecture ${a}`); process.exit(1); }
const dirOnly = flag('--dir');
const twin = (flag('--test-twin') || (!flag('--no-test-twin') && !process.env.GITHUB_ACTIONS)) && platform === process.platform && arches.length === 1 && arches[0] === process.arch;
const ravenrydDir = opt('--ravenryd') ? path.resolve(opt('--ravenryd')) : null;

const say = (s) => console.log(`pack: ${s}`);
const loud = (title, lines) => {
  const bar = '='.repeat(72);
  console.log(`\n${bar}\n  ${title}\n${lines.map((l) => `  ${l}`).join('\n')}\n${bar}\n`);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=${title}::${lines.join(' ')}`);
};

// ------------------------------------------------------------- the stage

function stageHub() {
  const src = path.join(REPO, 'hub');
  const dst = path.join(STAGE, 'hub');
  const hubPkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  // What npm would publish: "files", plus package.json, README and LICENSE.
  const entries = [...hubPkg.files, 'package.json', 'README.md', 'LICENSE'];
  for (const e of entries) {
    const star = e.match(/^(.*)\/\*(\.[A-Za-z0-9]+)$/);
    if (star) {
      for (const f of fs.readdirSync(path.join(src, star[1]))) {
        if (f.endsWith(star[2])) fs.cpSync(path.join(src, star[1], f), path.join(dst, star[1], f));
      }
    } else {
      const rel = e.replace(/\/$/, '');
      fs.cpSync(path.join(src, rel), path.join(dst, rel), { recursive: true });
    }
  }
  // The hub imports @ravenry/node-client (zero dependencies). It is staged
  // apart and lands in resources/hub/node_modules: electron-builder drops a
  // node_modules at the top of an extraResources folder.
  const nc = path.join(REPO, 'packages', 'node-client');
  const ncDst = path.join(STAGE, 'hub-modules', '@ravenry', 'node-client');
  const ncPkg = JSON.parse(fs.readFileSync(path.join(nc, 'package.json'), 'utf8'));
  for (const f of [...ncPkg.files, 'package.json']) fs.cpSync(path.join(nc, f), path.join(ncDst, f), { recursive: true });
  if (fs.existsSync(path.join(REPO, 'packages', 'LICENSE'))) fs.cpSync(path.join(REPO, 'packages', 'LICENSE'), path.join(ncDst, 'LICENSE'));
  // The words and design tokens every client shares (shared/README.md): the
  // hub reads them from hub/shared/ when shipped (server/strings.mjs), as
  // ../../shared/ from the repository.
  fs.cpSync(path.join(REPO, 'shared'), path.join(dst, 'shared'), { recursive: true });
  if (!fs.existsSync(path.join(dst, 'server', 'index.mjs'))) throw new Error('the hub has no server/index.mjs');
}

// Its version, asked with throwaway folders only (tools/test-env.mjs): a
// ravenryd started here never uses the real user's.
function ravenrydVersion(bin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenry-pack-'));
  const env = { PATH: '/usr/bin:/bin', HOME: tmp, LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: path.join(tmp, 'run'), RAVENRY_STATE_DIR: path.join(tmp, 'state') };
  try {
    assertTestEnv(env, 'ravenryd version --json');
    return JSON.parse(execFileSync(bin, ['version', '--json'], { encoding: 'utf8', env }));
  } catch { return null; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// The Go toolchain daemon/go.mod names: `toolchain goX` when it has one,
// else `go X` (the go command switches to that release, GOTOOLCHAIN=auto).
function goModToolchain() {
  const mod = fs.readFileSync(path.join(REPO, 'daemon', 'go.mod'), 'utf8');
  const tc = /^toolchain\s+(go\S+)\s*$/m.exec(mod);
  if (tc) return tc[1];
  const go = /^go\s+(\S+)\s*$/m.exec(mod);
  if (!go) throw new Error('daemon/go.mod has no go line');
  return `go${go[1]}`;
}

const goParts = (g) => String(g).replace(/^go/, '').split(/[^0-9]+/).filter(Boolean).map(Number);
function goOlder(have, want) {
  const a = goParts(have), b = goParts(want);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return false;
}

function stageRavenryd(arch) {
  const goos = platform;
  const dst = path.join(STAGE, 'ravenryd', `${platform}-${arch}`, 'ravenryd');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (ravenrydDir) {
    const src = path.join(ravenrydDir, `ravenryd-${platform}-${arch}`);
    if (!fs.existsSync(src)) throw new Error(`no ${src}`);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  } else if (process.platform === platform && process.arch === arch) {
    execFileSync(path.join(APP, 'scripts', 'build-ravenryd.sh'), [dst, pkg.version], { stdio: 'inherit' });
  } else {
    throw new Error(`ravenryd for ${platform}-${arch} cannot be built on this machine: pass --ravenryd DIR`);
  }
  // Check what can be checked here: the version (when it runs on this
  // machine) and the file type.
  const v = process.platform === goos ? ravenrydVersion(dst) : null;
  if (v) {
    const goarch = arch === 'x64' ? 'amd64' : arch;
    if (v.version !== pkg.version || v.os !== goos || v.arch !== goarch) {
      throw new Error(`${dst} is ravenryd ${v.version} for ${v.os}/${v.arch}; the app needs ${pkg.version} for ${goos}/${goarch}`);
    }
    // Built with the Go daemon/go.mod asks for or newer (its toolchain line,
    // else its go line; an older go switches to it, GOTOOLCHAIN=auto): a fix
    // in Go reaches the app through go.mod, so a ravenryd an older Go built
    // (a --ravenryd folder made elsewhere) is refused.
    const goWant = goModToolchain();
    if (goOlder(v.go, goWant)) throw new Error(`${dst} was built with ${v.go}; daemon/go.mod asks for ${goWant} or newer`);
    say(`ravenryd ${v.version} ${v.os}/${v.arch} (libghostty-vt ${v.libghostty_vt}, ${v.go})`);
  } else {
    say(`ravenryd for ${platform}-${arch}: ${execFileSync('file', ['-b', dst], { encoding: 'utf8' }).trim()}`);
  }
}

// The builds a remote machine gets. Every app carries all it was given, so
// a Mac reaches a Linux box and a Linux laptop a Mac: the app installs from
// what it holds, with no download and the SHA-256 it was built with.
function stageRemote() {
  const dst = path.join(STAGE, 'remote');
  fs.mkdirSync(dst, { recursive: true });
  const builds = {};
  const add = (key, src) => {
    const raw = fs.readFileSync(src);
    const file = `ravenryd-${key}.gz`;
    fs.writeFileSync(path.join(dst, file), zlib.gzipSync(raw, { level: 9 }));
    builds[key] = { file, sha256: crypto.createHash('sha256').update(raw).digest('hex'), size: raw.length };
  };
  if (ravenrydDir) {
    for (const f of fs.readdirSync(ravenrydDir).sort()) {
      const m = /^ravenryd-(darwin|linux)-(arm64|x64)$/.exec(f);
      if (m) add(`${m[1]}-${m[2]}`, path.join(ravenrydDir, f));
    }
  } else {
    for (const a of arches) add(`${platform}-${a}`, path.join(STAGE, 'ravenryd', `${platform}-${a}`, 'ravenryd'));
  }
  fs.writeFileSync(path.join(dst, 'builds.json'), JSON.stringify({ version: pkg.version, builds }, null, 2) + '\n');
  const bytes = Object.keys(builds).reduce((n, k) => n + fs.statSync(path.join(dst, builds[k].file)).size, 0);
  say(`remote builds: ${Object.keys(builds).join(', ') || 'none'} (${(bytes / 1048576).toFixed(1)} MiB gzipped)`);
}

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  stageHub();
  for (const a of arches) stageRavenryd(a);
  stageRemote();
  const c = commit();
  const builtAt = new Date().toISOString();
  const build = { version: pkg.version, commit: c, builtAt, id: `${pkg.version}+${c.slice(0, 12)}.${builtAt.replace(/\D/g, '').slice(0, 14)}` };
  fs.writeFileSync(path.join(STAGE, 'build.json'), JSON.stringify(build, null, 2) + '\n');
  fs.copyFileSync(path.join(REPO, 'hub', 'brand', 'ravenry', 'icon-1024.png'), path.join(STAGE, 'icon.png'));
  say(`staged ${build.id}`);
}

// ------------------------------------------------------------- signing

function signing() {
  if (platform !== 'darwin') return;
  const env = process.env;
  const cert = !!(env.CSC_LINK || env.CSC_NAME);
  const api = !!(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  const appleId = !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
  // Never look for an identity in a keychain: sign with what is given, or ad hoc.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  if (!cert) {
    env.RAVENRY_SIGNED = '0';
    env.RAVENRY_NOTARIZE = '0';
    delete env.CSC_LINK;
    const local = localIdentity();
    if (local) {
      env.RAVENRY_SIGN_IDENTITY = local.hash;
      say(`signing with this Mac's ${local.name} (${local.hash.slice(0, 8)}), library validation on; not notarized: for this Mac only, never publish it`);
      return;
    }
    delete env.RAVENRY_SIGN_IDENTITY;
    loud('UNSIGNED BUILD: not signed with a Developer ID and not notarized', [
      'No CSC_LINK (Developer ID Application certificate) was given, so the app is signed ad hoc.',
      'macOS will refuse to open it after a download ("damaged" or "unidentified developer"),',
      'and it cannot update itself. Fine for testing on this machine; never publish it.',
    ]);
    return;
  }
  env.RAVENRY_SIGNED = '1';
  env.RAVENRY_NOTARIZE = api || appleId ? '1' : '0';
  if (!api && !appleId) {
    loud('SIGNED BUT NOT NOTARIZED', [
      'A Developer ID certificate was given but no notarization credentials',
      '(APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID).',
      'Gatekeeper will still warn on first open. Never publish it.',
    ]);
  } else {
    say(`signing with the given Developer ID and notarizing through ${api ? 'an App Store Connect API key' : 'an Apple ID'}`);
  }
}

// ------------------------------------------------------------- build

// The build in dist/ is the kind wanted: a release has no test hooks
// (no driver, no "test hooks on" line), the twin has them.
function checkBuild(kind) {
  let got = '';
  try { got = fs.readFileSync(path.join(APP, '.build-kind'), 'utf8').trim(); } catch { /* none */ }
  const main = fs.readFileSync(path.join(APP, 'dist', 'main.cjs'), 'utf8');
  const hooks = main.includes('require(process.env.RAVENRY_DRIVER)') || main.includes('its test hooks on');
  if (got !== kind || (kind === 'release') === hooks) throw new Error(`dist/ is not a ${kind} build (build.mjs says ${got || 'nothing'}; test hooks ${hooks ? 'in' : 'not in'} main.cjs)`);
  say(kind === 'release' ? 'dist/: a release build, no test hooks' : 'dist/: the test twin, test hooks on');
}

function size(n) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(0)} KiB`; }

async function main() {
  if (flag('--stage-only')) { stage(); return; }
  if (!flag('--skip-build')) execFileSync(process.execPath, [path.join(APP, 'build.mjs'), '--release'], { cwd: APP, stdio: 'inherit' });
  checkBuild('release');
  stage();
  signing();
  fs.rmSync(OUT, { recursive: true, force: true });
  // The config reads RAVENRY_SIGNED and RAVENRY_NOTARIZE, set above.
  const { default: config } = await import(path.join(APP, 'electron-builder.config.mjs'));
  const { build, Platform, Arch } = await import('electron-builder');
  const P = platform === 'darwin' ? Platform.MAC : Platform.LINUX;
  const targets = dirOnly ? ['dir'] : platform === 'darwin' ? ['dmg', 'zip'] : ['AppImage', 'deb'];
  const files = await build({
    projectDir: APP,
    config,
    publish: 'never',
    targets: P.createTarget(targets, ...arches.map((a) => Arch[a])),
  });
  // What a release carries: the packages, their block maps (for
  // differential updates) and the update files.
  const names = [...new Set([...files.map((f) => path.relative(OUT, f)), ...fs.readdirSync(OUT)])]
    .filter((f) => !f.includes(path.sep) && /^(Ravenry-.*|latest.*\.yml)$/.test(f) && fs.statSync(path.join(OUT, f)).isFile())
    .sort();
  const rows = names.map((f) => ({ file: `release/${f}`, bytes: fs.statSync(path.join(OUT, f)).size }));
  fs.writeFileSync(path.join(OUT, 'artifacts.json'), JSON.stringify({ platform, arches, signed: process.env.RAVENRY_SIGNED === '1', notarized: process.env.RAVENRY_NOTARIZE === '1', files: rows }, null, 2) + '\n');
  for (const r of rows) say(`${r.file}  ${size(r.bytes)}`);
  if (platform === 'darwin' && process.env.RAVENRY_SIGNED !== '1') say(process.env.RAVENRY_SIGN_IDENTITY ? 'signed for this Mac only (Apple Development), not notarized: never publish it.' : 'UNSIGNED: see the banner above.');
  if (twin) {
    // The test twin: the same stage, dist/ rebuilt with the test hooks,
    // unpacked only. dist/ stays a development build after it.
    execFileSync(process.execPath, [path.join(APP, 'build.mjs')], { cwd: APP, stdio: 'inherit' });
    checkBuild('test-hooks');
    fs.rmSync(TWIN_OUT, { recursive: true, force: true });
    // The config afresh: electron-builder changes the object it was given.
    const { default: fresh } = await import(`${pathToFileURL(path.join(APP, 'electron-builder.config.mjs')).href}?twin`);
    await build({
      projectDir: APP,
      config: { ...fresh, directories: { ...fresh.directories, output: 'release-test' } },
      publish: 'never',
      targets: P.createTarget(['dir'], Arch[process.arch]),
    });
    fs.writeFileSync(path.join(TWIN_OUT, 'README.txt'), 'The test twin of the build in release/: the same ravenryd, hub and build.json, with the test hooks on\n(src/main/gate.ts) for the tools that drive the window. Never install or publish it.\n');
    say(`release-test/: the test twin (test hooks on; tools only)`);
  }
}

main().catch((e) => { console.error(`pack: ${e.stack || e}`); process.exit(1); });
