// LaunchServices hygiene for every check that puts a copy of a Ravenry app
// (bundle id dev.ravenry.*, Electron or native) on disk.
//
// macOS lists every app bundle it has seen launched or opened. A copy the
// checks left listed is an app of its own to macOS: on 2026-11-10 the person got
// "Ravenry-electron-0.1.23 would like to record this computer's screen and
// audio", named after a copy in /private/tmp, and LaunchServices listed 245
// copies of dev.ravenry.app besides /Applications/Ravenry.app. Two causes:
// `lsregister -u` fails on a bundle that is no longer on disk (-10814), and
// the checks removed their folders (each account, keys, startup) without
// it, or never reached it (a failed step, Ctrl+C, a killed run).
//
//   track(dir)        a folder (or an .app) this run puts app copies in;
//                     its copies leave the list on exit and on SIGINT,
//                     SIGTERM and SIGHUP, whatever happens
//   release(dir)      takes the copies in it out of the list now (they
//                     must still be on disk)
//   removeTree(dir)   release(dir), then removes it
//   checkLeft(name)   the guard, at the end of a run: any copy under a
//                     tracked folder still listed is a FAIL naming its
//                     path (and is taken out); registrations of copies gone
//                     from the temp folders, left by an earlier run, are
//                     taken out too. Returns the paths that were left.
//
//   node tools/launchservices.mjs            lists every dev.ravenry.* app
//                                            LaunchServices knows
//   node tools/launchservices.mjs --clean    takes out every one in the temp
//                                            folders (a copy made by hand)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const MAC = process.platform === 'darwin';
const RAVENRY_ID = /^dev\.ravenry(\.|$)/;
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// A path as LaunchServices writes it (/private/var, not /var), also when it
// is gone: its nearest folder still there, resolved, and the rest.
function canonical(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head) && head !== path.dirname(head)) { tail.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(real(head), ...tail);
}
const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const TEMP = [...new Set([canonical(os.tmpdir()), '/private/tmp', '/private/var/folders'])];
const inTemp = (p) => TEMP.some((t) => under(p, t));

const tracked = new Set();
let hooked = false;

// The .app bundles in a folder (copies sit at most 3 folders down:
// <root>/Applications/Ravenry.app, <root>/prev/Ravenry.app), never inside
// a bundle or through a link.
function bundlesIn(dir, depth = 3) {
  if (dir.endsWith('.app')) return fs.existsSync(dir) ? [dir] : [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name.endsWith('.app')) out.push(p);
    else if (depth > 1) out.push(...bundlesIn(p, depth - 1));
  }
  return out;
}

function unregister(paths) {
  const list = paths.filter((p) => fs.existsSync(p));
  if (MAC && list.length) spawnSync(LSREGISTER, ['-u', ...list], { stdio: 'ignore' });
}

// lsregister -u needs the bundle on disk: for a copy already removed, a
// stand-in bundle with its id goes there for the moment, in the temp
// folders only, and goes again with every folder made for it.
function unregisterGone(app, id) {
  if (!MAC || !inTemp(app) || fs.existsSync(app)) return;
  let top = app;
  while (!fs.existsSync(path.dirname(top))) top = path.dirname(top);
  try {
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
    spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
}

export function release(dir) {
  if (MAC) unregister(bundlesIn(canonical(dir)));
}

export function removeTree(dir) {
  release(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function track(dir) {
  if (!MAC) return dir;
  tracked.add(canonical(dir));
  if (!hooked) {
    hooked = true;
    // After tools/test-env.mjs's reaper (registered first), so the copies'
    // processes are gone; a signal ends the run through process.exit.
    process.on('exit', () => { for (const d of tracked) { try { release(d); } catch { /* best effort */ } } });
    for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => process.exit(128 + n));
  }
  return dir;
}

// Every dev.ravenry.* bundle LaunchServices lists: [{ path, id }].
export function registrations() {
  if (!MAC) return [];
  const out = spawnSync(LSREGISTER, ['-dump', 'Bundle'], { encoding: 'utf8', maxBuffer: 1 << 30 }).stdout || '';
  const found = [];
  let at = null;
  for (const line of out.split('\n')) {
    if (/^-{8,}/.test(line)) at = null;
    let m = line.match(/^path:\s+(.*?)(?: \(0x[0-9a-f]+\))?$/);
    if (m) { at = m[1]; continue; }
    m = line.match(/^identifier:\s+(\S+)/);
    if (m && at && RAVENRY_ID.test(m[1])) { found.push({ path: at, id: m[1] }); at = null; }
  }
  return found;
}

const takeOut = (regs) => { for (const r of regs) { if (fs.existsSync(r.path)) unregister([r.path]); else unregisterGone(r.path, r.id); } };
const installed = (p) => under(p, '/Applications');

export function checkLeft(name) {
  if (!MAC) return [];
  for (const d of tracked) release(d);
  const regs = registrations().filter((r) => !installed(r.path));
  const left = regs.filter((r) => [...tracked].some((d) => under(r.path, d)));
  const stale = regs.filter((r) => !left.includes(r) && inTemp(r.path) && !fs.existsSync(r.path));
  takeOut([...left, ...stale]);
  if (stale.length) console.log(`${name}: took ${stale.length} registration(s) of Ravenry copies an earlier run left in the temp folders out of LaunchServices`);
  if (!left.length) { console.log(`${name}: LaunchServices lists none of the app copies this run made`); return []; }
  const still = new Set(registrations().map((r) => r.path));
  for (const r of left) console.log(`FAIL  ${name}: LaunchServices still listed ${r.path} (${r.id}), a copy this run made: ${still.has(r.path) ? 'and it is STILL listed after lsregister -u' : 'taken out now'}`);
  return left.map((r) => r.path);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const regs = registrations();
  if (process.argv.includes('--clean')) {
    const temp = regs.filter((r) => inTemp(r.path));
    takeOut(temp);
    console.log(`launchservices: took ${temp.length} Ravenry cop${temp.length === 1 ? 'y' : 'ies'} in the temp folders out of LaunchServices`);
  }
  for (const r of process.argv.includes('--clean') ? registrations() : regs) console.log(`${r.id}  ${r.path}${fs.existsSync(r.path) ? '' : '  (gone)'}`);
}
