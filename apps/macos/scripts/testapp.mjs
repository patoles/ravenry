// The app a check drives: a development build (scripts/build.sh) or the
// test twin of a package (scripts/package.mjs: build/package/release-test/
// Ravenry.app), never the release, which takes no test hook from its launch
// (Gate.swift: --offscreen, --sidetest, RAVENRY_HUB_URL... make it quit).
// Given the release, the twin beside it is used, said on stderr; with no
// twin there, the check stops.
//
//   import { testApp } from './testapp.mjs';  const { app, exe } = testApp(path);
//   node scripts/testapp.mjs APP              prints the app to use (selftest.sh)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isRelease = (app) => {
  if (!fs.existsSync(path.join(app, 'Contents', 'Resources', 'build.json'))) return false;
  try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :RavenryTestHooks', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'true'; } catch { return true; }
};

export function testApp(given) {
  let app = path.resolve(given);
  if (isRelease(app)) {
    const twin = path.join(path.dirname(app), 'release-test', 'Ravenry.app');
    if (!fs.existsSync(twin) || isRelease(twin)) throw new Error(`${app} is a release, which takes no test hook (Gate.swift); run the checks on its test twin (scripts/package.mjs makes build/package/release-test/Ravenry.app)`);
    process.stderr.write(`testapp: ${app} is a release; using its test twin ${twin}\n`);
    app = twin;
  }
  // RavenryMac from build.sh, Ravenry in a package.
  const exe = ['RavenryMac', 'Ravenry'].map((n) => path.join(app, 'Contents', 'MacOS', n)).find((f) => fs.existsSync(f)) || path.join(app, 'Contents', 'MacOS', 'RavenryMac');
  return { app, exe };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { console.log(testApp(process.argv[2] || '').app); } catch (e) { console.error(e.message); process.exit(2); }
}
