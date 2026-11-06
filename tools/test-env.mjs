// Keeps every test tool off the real user's data. The one helper for
// Node: hub/tools/test-guard.mjs (the first import of every hub test) and
// every tool in apps/desktop/tools load it, and its twin for Go is
// daemon/internal/testenv.
//
// On 2026-11-06 a test run started a daemon with the real HOME: with
// RAVENRY_RUNTIME_DIR set but no RAVENRY_STATE_DIR, the daemon kept its
// pane logs and shell files in ~/Library/Application Support/Ravenry, the
// real app's folder. So a test tool may start ravenryd, the hub or the app
// only when every folder they would use is a test's:
//
//   - HOME
//   - the hub's data (RAVENRY_HOME, else MC_HOME, else HOME/.ravenry)
//   - the daemon's runtime and state folders (RAVENRY_RUNTIME_DIR and
//     RAVENRY_STATE_DIR, else where ravenryd derives them from HOME and
//     XDG_*: daemon/internal/paths)
//   - for the app, its data folder (RAVENRY_DESKTOP_DATA: without it
//     Electron uses the real ~/Library/Application Support/Ravenry, whatever
//     HOME says)
//
// A folder is a test's when it is inside a test root (a `.tmp` folder of
// this repository, or a folder named in RAVENRY_TEST_ROOT, several joined
// with ":"), or outside the real user's home folder and runtime folder
// (the system's temporary folders). Anything else is refused before the
// program starts.
//
// guardSpawns() enforces it for the whole tool: every child it starts
// through node:child_process that is ravenryd, the hub or the app is
// checked with the environment it is given, so no tool can forget.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The real user, from the account (not HOME, which a tool may have changed).
function realHome() {
  try { const h = os.userInfo().homedir; if (h) return h; } catch { /* below */ }
  return os.homedir();
}
export const REAL_HOME = realHome();

// The real user's runtime folder on Linux (systemd's /run/user/<uid>): a
// daemon there shares the user's real sockets, though it is not in HOME.
function realRuntime() {
  if (process.platform !== 'linux') return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid == null ? null : `/run/user/${uid}`;
}
const REAL_RUNTIME = realRuntime();

// A path with symlinks resolved as far as it exists (a test's folders are
// often made after the check).
function realOr(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = up;
  }
}
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
const within = (p, dir) => inside(path.resolve(p), path.resolve(dir)) || inside(realOr(p), realOr(dir));

/** The explicit test roots: RAVENRY_TEST_ROOT (absolute folders joined with ":"). */
export function testRoots(env = process.env) {
  return String(env.RAVENRY_TEST_ROOT || '').split(':').filter((d) => d && path.isAbsolute(d));
}

/** Inside a `.tmp` folder of this repository (the repo's own, or a package's). */
export function inRepoTmp(p) {
  for (const q of [path.resolve(p), realOr(p)]) {
    for (const repo of [REPO, realOr(REPO)]) {
      const r = path.relative(repo, q);
      if (r && !r.startsWith('..') && !path.isAbsolute(r) && r.split(path.sep).includes('.tmp')) return true;
    }
  }
  return false;
}

/** Inside the real user's home or runtime folder. */
export function inRealUser(p) {
  return within(p, REAL_HOME) || (!!REAL_RUNTIME && within(p, REAL_RUNTIME));
}

/** Whether a test may use this folder. */
export function isTestPath(p, env = process.env) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  if (inRepoTmp(p) || testRoots(env).some((d) => within(p, d))) return true;
  return !inRealUser(p);
}

/**
 * The folders a ravenryd, a hub or an app started with this environment
 * would use, as they derive them. A missing HOME is the account's home:
 * that is where os.homedir() and the daemon land.
 */
export function foldersOf(env, { app = false, platform = process.platform } = {}) {
  const home = env.HOME || REAL_HOME;
  const state = env.RAVENRY_STATE_DIR || (platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Ravenry')
    : path.isAbsolute(env.XDG_STATE_HOME || '') ? path.join(env.XDG_STATE_HOME, 'ravenry') : path.join(home, '.local', 'state', 'ravenry'));
  let runtime = env.RAVENRY_RUNTIME_DIR;
  if (!runtime && platform === 'linux' && path.isAbsolute(env.XDG_RUNTIME_DIR || '') && fs.existsSync(env.XDG_RUNTIME_DIR)) runtime = path.join(env.XDG_RUNTIME_DIR, 'ravenry');
  if (!runtime) runtime = path.join(state, 'run');
  const out = { HOME: home, 'the hub\'s data (RAVENRY_HOME)': env.RAVENRY_HOME || env.MC_HOME || path.join(home, '.ravenry'), 'the daemon\'s runtime folder (RAVENRY_RUNTIME_DIR)': runtime, 'the daemon\'s state folder (RAVENRY_STATE_DIR)': state };
  if (app) out['the app\'s data folder (RAVENRY_DESKTOP_DATA)'] = env.RAVENRY_DESKTOP_DATA || (platform === 'darwin' ? path.join(REAL_HOME, 'Library', 'Application Support', 'Ravenry') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Ravenry'));
  return out;
}

/** What is wrong with starting ravenryd, the hub or (app) the app with this environment: a list of lines, empty when it is fine. */
export function problems(env, { app = false } = {}) {
  const out = [];
  for (const [name, dir] of Object.entries(foldersOf(env, { app }))) {
    if (!isTestPath(dir, { ...process.env, ...env })) out.push(`${name} is ${dir}, inside the real user's folders`);
  }
  return out;
}

/** Throws unless a test may start `what` with this environment. */
export function assertTestEnv(env, what, opts = {}) {
  const p = problems(env, opts);
  if (p.length) {
    throw new Error(`Refused to start ${what}: a test keeps every folder of Ravenry's in a test root (a .tmp folder of this repository, RAVENRY_TEST_ROOT, or the system's temporary folders), never in the real user's.\n  ${p.join('\n  ')}`);
  }
}

// ------------------------------------------------------------ which children

const NODE_NAMES = new Set(['node', 'nodejs']);
const isNode = (file, env) => file === process.execPath || NODE_NAMES.has(path.basename(file)) || (env && env.ELECTRON_RUN_AS_NODE === '1');
const HUB_SCRIPT = /(^|[/\\])(server[/\\]index\.mjs|bin[/\\]ravenry\.mjs)$/;
const DAEMON_NAME = /^ravenryd?(-[\w.+-]+)?$/;
const isApp = (file) => /[/\\]electron[/\\]dist[/\\]/.test(file) || /\.app[/\\]Contents[/\\]MacOS[/\\]/.test(file) || /\.AppImage$/.test(file) || /[/\\]linux(-[\w]+)?-unpacked[/\\]ravenry$/.test(file);
// ravenryd named in a shell command line, as a program (not a folder name).
const DAEMON_IN_SHELL = /(^|[\s;&|('"/])ravenryd['"]?(\s|$)/;

/** What a child is: 'daemon', 'hub', 'app', or null for anything else. */
export function childKind(file, args = [], env = null) {
  const f = String(file || '');
  if (!f) return null;
  if (isApp(f) && !(env && env.ELECTRON_RUN_AS_NODE === '1')) return 'app';
  if (isNode(f, env)) {
    const script = (args || []).find((a) => typeof a === 'string' && !a.startsWith('-'));
    return script && HUB_SCRIPT.test(script) ? 'hub' : null;
  }
  if (DAEMON_NAME.test(path.basename(f))) return 'daemon';
  if (/^(ba|z|da)?sh$/.test(path.basename(f)) && args[0] === '-c' && DAEMON_IN_SHELL.test(String(args[1] || ''))) return 'daemon';
  return null;
}

const NAMES = { daemon: 'ravenryd', hub: 'the hub', app: 'the app' };

function check(file, args, opts) {
  const env = (opts && opts.env) || process.env;
  const kind = childKind(file, args, env);
  if (kind) assertTestEnv(env, `${NAMES[kind]} (${path.basename(String(file))}${args && args.length ? ' ' + args.slice(0, 2).join(' ') : ''})`, { app: kind === 'app' });
}

let guarded = false;

/**
 * From now on, every ravenryd, hub or app this process starts through
 * node:child_process is checked first (assertTestEnv): a refused one
 * throws before it starts. ESM named imports see it too.
 */
export function guardSpawns() {
  if (guarded) return;
  guarded = true;
  const cp = createRequire(import.meta.url)('node:child_process');
  const split = (args, opts) => (Array.isArray(args) ? [args, opts] : [[], args]);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const orig = cp[name];
    cp[name] = function guardedChild(file, a, b, ...rest) {
      const [args, opts] = split(a, b);
      if (opts && opts.shell) check('/bin/sh', ['-c', [file, ...args].join(' ')], opts);
      else check(file, args, opts);
      return orig.call(this, file, a, b, ...rest);
    };
  }
  const fork = cp.fork;
  cp.fork = function guardedFork(mod, a, b, ...rest) {
    const [args, opts] = split(a, b);
    check(process.execPath, [String(mod), ...args], opts);
    return fork.call(this, mod, a, b, ...rest);
  };
  for (const name of ['exec', 'execSync']) {
    const orig = cp[name];
    cp[name] = function guardedExec(command, opts, ...rest) {
      check('/bin/sh', ['-c', String(command)], typeof opts === 'object' ? opts : null);
      return orig.call(this, command, opts, ...rest);
    };
  }
  syncBuiltinESMExports();
}
