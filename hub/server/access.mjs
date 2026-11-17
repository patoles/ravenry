// macOS's privacy answers, and the gate every read of a protected folder
// goes through.
//
// macOS asks the person before an app reads ~/Documents, ~/Desktop,
// ~/Downloads, iCloud Drive or another volume, and a read made before they
// answer does not fail: it waits until they do, possibly for ever (the hub
// is a background service; nobody may be at the Mac). On 2026-11-07 the
// 0.1.2 hub sat in a synchronous read of a brief in ~/Documents and
// answered nothing. On 2026-11-17 the signed 0.1.65 replaced an app signed
// with another certificate: macOS no longer matched Ravenry's Full Disk
// Access entry, asked for ~/Documents (answered after 24 s), and then sent
// every file the hub read there to its privacy daemon one by one (about
// 11 ms each, 20,000 in 4 minutes): the hub's main thread was held for
// minutes and the window got nothing at all, not even the words.
//
// So nothing of the board ever waits on a protected folder:
//
// - guard() (installed first thing by server/accessguard.mjs) wraps fs and
//   child_process: a read, write, watch or child's folder inside a
//   protected folder whose answer is not "allowed" fails at once (EPERM,
//   as a refusal does; existsSync says false), never waits. The first such
//   use asks for that folder.
// - Asking is one read in a child process of the hub (macOS asks the person
//   for the hub, the same process tree), followed by a few timed opens: a
//   folder macOS allows but checks file by file (the stale entry above)
//   counts as "slow", like a refusal. A read that never returns holds that
//   child only: not the main thread, not libuv's pool, and not the hub's
//   exit (a thread of the hub held in the question would keep the process
//   from ever exiting; the child is killed when the hub exits).
// - Past GRACE_MS (3 s) without an answer the folder counts as "waiting":
//   the board is built and served without it (its projects marked as
//   waiting) and the read goes on in the background. A refused or slow
//   folder is asked again each minute; retry() asks again now (the app
//   asked macOS itself, POST /api/access/retry).
//
// MC_ACCESS_PROBE (tests): a JSON object { "<root>": "<how>" } whose roots
// count as protected on any system and are asked by opening <how> as a
// file (a FIFO stands for a read that does not return yet), or "!EPERM"
// (refused) or "!slow" (allowed, each open checked one by one).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { t } from './strings.mjs';

const PROBES = (() => { try { return process.env.MC_ACCESS_PROBE ? JSON.parse(process.env.MC_ACCESS_PROBE) : {}; } catch { return {}; } })();
/** How long the board holds its first state for an answer. */
export const GRACE_MS = Number(process.env.MC_ACCESS_GRACE_MS) || 3000;
/** A folder re-asked after this long refused or slow. */
const AGAIN_MS = Number(process.env.MC_ACCESS_AGAIN_MS) || 60000;
/** A median open slower than this is macOS checking file by file (a healthy one takes a few hundredths of a ms). */
const SLOW_MS = 4;
// The hub's own files are never gated: a hub run from a repo in ~/Documents
// (the npm board) reads its own pages and strings there (the folder above
// hub/: the repo, or the app's version folder).
const OWN = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const state = new Map(); // root -> { state: 'asking' | 'waiting' | 'ok' | 'denied' | 'slow', since, asked, error, ms }
const workers = new Map(); // root -> the probe's child while it runs
const orig = {}; // the unwrapped fs functions, once guard() ran
let changed = () => {};

/** Called when a folder's answer comes or changes (the board ticks again). */
export function onChange(fn) { changed = typeof fn === 'function' ? fn : () => {}; }

/** What macOS calls the folder in its prompt and in Settings. */
export function label(root, home = os.homedir()) {
  const rel = path.relative(home, root);
  if (rel === 'Documents' || rel === 'Desktop' || rel === 'Downloads') return rel;
  if (rel === path.join('Library', 'Mobile Documents')) return 'iCloud Drive';
  if (root.startsWith('/Volumes/')) return 'Removable Volumes';
  return path.basename(root);
}

function rootsFor(home, platform) {
  const roots = Object.keys(PROBES).map((r) => path.resolve(r));
  if (platform === 'darwin') roots.push(...['Documents', 'Desktop', 'Downloads', path.join('Library', 'Mobile Documents')].map((r) => path.join(home, r)));
  return roots;
}

const bootLinks = new Map(); // /Volumes/<name> -> whether it is the start-up disk (a link to /)
/** The protected folder this path is in (macOS; and the test roots), or null. */
export function rootOf(p, { home = os.homedir(), platform = process.platform } = {}) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return null;
  const abs = path.resolve(p);
  for (const r of rootsFor(home, platform)) if (abs === r || abs.startsWith(r + path.sep)) return r;
  if (platform === 'darwin' && abs.startsWith('/Volumes/') && abs.split('/')[2]) {
    const v = `/Volumes/${abs.split('/')[2]}`;
    if (!bootLinks.has(v)) {
      let boot = false;
      try { boot = (orig.readlinkSync || fs.readlinkSync)(v) === '/'; } catch { /* not a link */ }
      bootLinks.set(v, boot);
    }
    return bootLinks.get(v) ? null : v;
  }
  return null;
}

/** The protected folders these folders are in (macOS; and the test roots). */
export function protectedRoots(folders, opts = {}) {
  const out = new Set();
  for (const f of folders) { const r = rootOf(f, opts); if (r) out.add(r); }
  return [...out];
}

// The read and the timed opens, in a child. A FIFO's open, or macOS's
// question, holds that child only.
const PROBE_JS = `
const fs = require('node:fs');
const path = require('node:path');
const [root, how] = process.argv.slice(1);
const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
try {
  if (how === '!EPERM') { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
  let names = [];
  if (how && !how.startsWith('!')) fs.closeSync(fs.openSync(how, 'r'));
  else names = fs.readdirSync(root);
  const items = names.filter((n) => n !== '.DS_Store').slice(0, 8).map((n) => path.join(root, n));
  while (items.length < 8) items.push(root);
  const times = [];
  for (const p of items) {
    const t0 = process.hrtime.bigint();
    try { fs.opendirSync(p).closeSync(); } catch { try { fs.closeSync(fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* gone, or not ours */ } }
    if (how === '!slow') pause(12);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  say({ ok: true, ms: times[Math.floor(times.length / 2)] });
} catch (e) { say({ ok: false, code: e && e.code, message: String(e && e.message) }); }
`;
// The children still asking, killed when the hub exits.
process.on('exit', () => { for (const c of workers.values()) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

function probe(root, { force = false } = {}) {
  const was = state.get(root);
  if (workers.has(root)) return;
  if (was && !force && !((was.state === 'denied' || was.state === 'slow') && Date.now() - was.since > AGAIN_MS)) return;
  const asked = Date.now();
  // Asked again after a refusal, it stays refused until the answer comes.
  if (!was || was.state === 'ok') state.set(root, { state: 'asking', since: asked, asked, error: null, ms: null });
  else state.set(root, { ...was, asked });
  let w;
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_OPTIONS;
    w = (orig.spawn || cp.spawn)(process.execPath, ['-e', PROBE_JS, root, PROBES[root] || ''], { stdio: ['ignore', 'pipe', 'ignore'], env });
  } catch (e) {
    state.set(root, { state: 'denied', since: Date.now(), asked, error: e.code || 'ESPAWN', ms: null });
    return;
  }
  workers.set(root, w);
  // A child held in macOS's question never keeps the hub alive.
  w.unref();
  if (w.stdout) w.stdout.unref?.();
  const first = !was;
  // A folder whose read is out for longer than the grace counts as not answered.
  const late = setTimeout(() => {
    const s = state.get(root);
    if (workers.get(root) !== w || !s || s.state !== 'asking') return;
    state.set(root, { ...s, state: 'waiting' });
    console.log(`access: macOS has not answered for ${root} in ${GRACE_MS} ms; the board goes on without it and keeps asking`);
    changed(root);
  }, GRACE_MS);
  late.unref();
  const done = (m) => {
    clearTimeout(late);
    if (workers.get(root) !== w) return;
    workers.delete(root);
    try { w.kill('SIGKILL'); } catch { /* gone */ }
    const took = Date.now() - asked;
    const before = state.get(root);
    let next;
    if (m && m.ok) next = m.ms >= SLOW_MS ? { state: 'slow', error: null, ms: m.ms } : { state: 'ok', error: null, ms: m.ms };
    else {
      const refused = m && (m.code === 'EPERM' || m.code === 'EACCES');
      // Anything else (the folder is gone, a disk ejected): nothing to ask.
      next = refused ? { state: 'denied', error: m.code, ms: null } : { state: 'ok', error: null, ms: null };
    }
    state.set(root, { ...next, since: Date.now(), asked });
    const moved = !before || before.state !== next.state;
    if (first || moved) {
      const how = next.state === 'ok' ? 'allowed' : next.state === 'slow' ? `allowed, but each read waits ${m.ms.toFixed(1)} ms on macOS's check` : `refused (${next.error})`;
      console.log(`access: macOS answered for ${root} in ${took} ms (${how})`);
      if (next.state === 'denied') console.error(`access: macOS did not let the board read ${root} (${next.error})`);
      if (next.state === 'slow') console.error(`access: macOS checks each read of ${root} one by one; the board leaves it alone until Ravenry is added to Full Disk Access again`);
    }
    if (moved) changed(root);
  };
  let out = '';
  if (w.stdout) w.stdout.on('data', (d) => { out += d; });
  w.once('error', (e) => done({ ok: false, code: e && e.code, message: String(e && e.message) }));
  w.once('close', () => {
    let m = null;
    try { m = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
    done(m || { ok: false, code: 'EEXIT' });
  });
}

/**
 * Asks for each protected folder of these folders not asked yet (and again
 * for one refused or slow a minute ago). Never waits.
 */
export function ask(folders) {
  for (const r of protectedRoots(folders)) probe(r);
}

/** A folder asked less than GRACE_MS ago with no answer yet, or null (the board holds its first state that long). */
export function asking() {
  for (const [r, s] of state) if (s.state === 'asking') return r;
  return null;
}

/** The old name: a folder asked whose answer has not come within the grace. */
export const pending = asking;

/** The protected folder holding this path when the board may not read it now (asking for it the first time), else null. */
export function blockedRoot(p) {
  const r = rootOf(p);
  if (!r) return null;
  if (p === OWN || p.startsWith(OWN + path.sep)) return null;
  const s = state.get(r);
  if (s && s.state === 'ok') return null;
  if (!s) probe(r);
  return r;
}

/** This folder's access for the state ({ state, folder, name }), or null when the board may read it. */
export function folderView(p, say = (x) => x) {
  const r = rootOf(p);
  const s = r && state.get(r);
  if (!r || (s && s.state === 'ok') || p === OWN || p.startsWith(OWN + path.sep)) return null;
  const st = !s || s.state === 'asking' ? 'waiting' : s.state;
  return { state: st, folder: say(r), name: label(r) };
}

/** Whether any folder asked has no answer yet (asking or waiting): refused and slow ones are answers. */
export function anyWaiting() {
  for (const s of state.values()) if (s.state === 'asking' || s.state === 'waiting') return true;
  return false;
}

/** Whether any folder asked is not allowed (yet). */
export function anyBlocked() {
  for (const s of state.values()) if (s.state !== 'ok') return true;
  return false;
}

/** Asks again now for every folder not allowed (the app asked macOS itself, or the person changed Settings). */
export function retry() {
  const roots = [...state].filter(([, s]) => s.state !== 'ok').map(([r]) => r);
  for (const r of roots) probe(r, { force: true });
  return roots;
}

/**
 * For the state. waiting: the first folder whose answer has not come;
 * denied: refused ones; slow: allowed ones macOS checks file by file;
 * blocked: every folder the board leaves alone now, each with its state;
 * each said as ~/... (folder), named as Settings names it (name), with its
 * path; words: what the window says about them; settings: the pane its
 * button opens.
 */
export function view(say = (p) => p) {
  const one = ([r, s]) => ({ folder: say(r), name: label(r), path: r, state: s.state === 'asking' ? 'waiting' : s.state, since: new Date(s.since).toISOString() });
  const all = [...state].filter(([, s]) => s.state !== 'ok').map(one);
  const waiting = all.find((x) => x.state === 'waiting') || null;
  const refused = all.filter((x) => x.state !== 'waiting');
  const pick = ({ folder, name, path: p }) => ({ folder, name, path: p });
  return {
    waiting: waiting ? { ...pick(waiting), since: waiting.since } : null,
    denied: all.filter((x) => x.state === 'denied').map(pick),
    slow: all.filter((x) => x.state === 'slow').map(pick),
    blocked: all,
    // macOS's question first (its dialog is up), then what it refused.
    words: waiting ? waitingWords(waiting.path, say) : refused.length ? refusedWords(refused.map((x) => x.path), say) : null,
    settings: waiting ? SETTINGS_FILES : refused.length ? SETTINGS_FULL_DISK : null,
  };
}

/** The panes of System Settings the words name. */
export const SETTINGS_FILES = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
export const SETTINGS_FULL_DISK = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/** The words for a folder whose answer has not come. */
export function waitingWords(root, say = (p) => p) {
  return `macOS is asking whether Ravenry may read ${say(root)}. Click Allow in the dialog. If the dialog is gone: System Settings > Privacy & Security > Files & Folders > Ravenry, turn on ${label(root)}.`;
}

/** The words for folders macOS refused, or allows but checks file by file (a Full Disk Access entry gone stale after an update). */
export function refusedWords(roots, say = (p) => p) {
  const list = (Array.isArray(roots) ? roots : [roots]).map(say).join(', ');
  // The window's words (shared/strings/en.json, the Mac app's access card and sidebar note).
  return `${t('start.deniedT', { folders: list })} ${t('start.denied')}`;
}

// ------------------------------------------------------------ the guard

let guarded = false;

function blockedErr(syscall, p, root) {
  const e = new Error(`EPERM: macOS has not let Ravenry read ${root} yet, ${syscall} '${p}'`);
  e.code = 'EPERM';
  e.errno = -1;
  e.syscall = syscall;
  e.path = p;
  return e;
}

function asPath(a) {
  if (typeof a === 'string') return a;
  if (a instanceof URL) { try { return a.protocol === 'file:' ? fileURLToPath(a) : null; } catch { return null; } }
  if (Buffer.isBuffer(a)) return a.toString();
  return null;
}

// The folder that stops this call, from its path arguments.
function stopper(args, idx) {
  for (const i of idx) {
    const s = asPath(args[i]);
    if (!s) continue;
    const r = blockedRoot(path.isAbsolute(s) ? path.resolve(s) : path.resolve(s));
    if (r) return { r, p: s };
  }
  return null;
}

// fs functions by the arguments that are paths.
const SYNC = { readFileSync: [0], writeFileSync: [0], appendFileSync: [0], statSync: [0], lstatSync: [0], readdirSync: [0], openSync: [0], accessSync: [0], mkdirSync: [0], rmSync: [0], rmdirSync: [0], unlinkSync: [0], renameSync: [0, 1], copyFileSync: [0, 1], cpSync: [0, 1], readlinkSync: [0], symlinkSync: [1], linkSync: [0, 1], utimesSync: [0], chmodSync: [0], opendirSync: [0], mkdtempSync: [0], truncateSync: [0], statfsSync: [0] };
const ASYNC = { readFile: [0], writeFile: [0], appendFile: [0], stat: [0], lstat: [0], readdir: [0], open: [0], access: [0], mkdir: [0], rm: [0], rmdir: [0], unlink: [0], rename: [0, 1], copyFile: [0, 1], cp: [0, 1], readlink: [0], symlink: [1], link: [0, 1], utimes: [0], chmod: [0], opendir: [0], mkdtemp: [0], truncate: [0], realpath: [0], statfs: [0] };
// A child started in a folder the board may not read starts nowhere: it
// fails as a child in a missing folder does (ENOENT), never waits.
const NOWHERE = '/var/empty/ravenry-access-waiting';
const CHILD = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

/**
 * Wraps fs and child_process so that nothing of the hub reads, writes,
 * watches or starts a child inside a protected folder it may not read now.
 * Once, before the hub's modules load (server/accessguard.mjs). The
 * probe is its own process, never wrapped.
 */
export function guard() {
  if (guarded) return;
  guarded = true;
  for (const [name, idx] of Object.entries(SYNC)) {
    const f = fs[name];
    if (typeof f !== 'function') continue;
    orig[name] = f;
    fs[name] = function guardedSync(...args) {
      const s = stopper(args, idx);
      if (s) throw blockedErr(name.replace(/Sync$/, ''), s.p, s.r);
      return f.apply(this, args);
    };
  }
  orig.existsSync = fs.existsSync;
  fs.existsSync = function guardedExists(p) { return stopper([p], [0]) ? false : orig.existsSync(p); };
  const rp = fs.realpathSync;
  orig.realpathSync = rp;
  const rpg = function guardedRealpath(...args) { const s = stopper(args, [0]); if (s) throw blockedErr('realpath', s.p, s.r); return rp.apply(this, args); };
  rpg.native = function guardedRealpathNative(...args) { const s = stopper(args, [0]); if (s) throw blockedErr('realpath', s.p, s.r); return rp.native.apply(this, args); };
  fs.realpathSync = rpg;
  for (const [name, idx] of Object.entries(ASYNC)) {
    const f = fs[name];
    if (typeof f !== 'function') continue;
    fs[name] = function guardedCallback(...args) {
      const s = stopper(args, idx);
      if (!s) return f.apply(this, args);
      const cb = [...args].reverse().find((a) => typeof a === 'function');
      if (cb) process.nextTick(cb, blockedErr(name, s.p, s.r));
      return undefined;
    };
  }
  const fsp = fs.promises;
  for (const [name, idx] of Object.entries(ASYNC)) {
    const f = fsp[name];
    if (typeof f !== 'function') continue;
    fsp[name] = function guardedPromise(...args) {
      const s = stopper(args, idx);
      return s ? Promise.reject(blockedErr(name, s.p, s.r)) : f.apply(this, args);
    };
  }
  orig.watch = fs.watch;
  fs.watch = function guardedWatch(...args) { const s = stopper(args, [0]); if (s) throw blockedErr('watch', s.p, s.r); return orig.watch.apply(this, args); };
  // A file watched by polling: each poll is a stat in libuv's pool, which a
  // waiting folder would hold. Not watched until it may be read.
  orig.watchFile = fs.watchFile;
  fs.watchFile = function guardedWatchFile(...args) {
    if (!stopper(args, [0])) return orig.watchFile.apply(this, args);
    const idle = { ref: () => idle, unref: () => idle, on: () => idle, once: () => idle };
    return idle;
  };
  for (const name of ['createReadStream', 'createWriteStream']) {
    const f = fs[name];
    fs[name] = function guardedStream(p, ...rest) { return f.call(this, stopper([p], [0]) ? NOWHERE : p, ...rest); };
  }
  for (const name of CHILD) {
    const f = cp[name];
    if (typeof f !== 'function') continue;
    orig[name] = f;
    cp[name] = function guardedChild(...args) {
      const at = args.findIndex((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a));
      const cwd = at > 0 ? asPath(args[at].cwd) : null;
      if (cwd && blockedRoot(path.resolve(cwd))) args[at] = { ...args[at], cwd: NOWHERE };
      return f.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}

/** The unwrapped functions (a test's own setup). */
export function unguarded() { return { ...fs, ...orig }; }

/** Whether guard() ran. */
export function isGuarded() { return guarded; }
