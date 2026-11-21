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
//
// Nothing left running: guardSpawns() also stops, when the tool ends (its
// end, an uncaught error, process.exit, SIGINT, SIGTERM or SIGHUP), every
// ravenryd, hub and app it started, and every ravenryd still listening in
// their runtime folders (reapStarted; hub/tools/reap-test.mjs).
//
// launchd: a test never runs the real launchctl, which would load a job
// (a hub, a board) into the person's own session whatever HOME says.
// guardSpawns() refuses /bin/launchctl, and an app that would install its
// hub service (RAVENRY_SERVICE=install) without the stand-in
// apps/desktop/tools/fake-launchctl.mjs as RAVENRY_LAUNCHCTL.
//
// Real terminal apps: a test never drives the person's own cmux, iTerm2 or
// Rex (on 2026-11-06 a run of tools/handoff-e2e.mjs put a cmux workspace on
// the person's screen). guardSpawns() refuses, unless the person ran the
// test with RAVENRY_TEST_REAL_TERMINAL=1, every child that is one of them
// (cmux, osascript, which drives iTerm2, Rex's rex, iTerm2's Python API)
// and every hub whose environment would make it drive one (its terminal's
// command not a test's stand-in, such as tools/fake-cmux.mjs). A test made
// to drive one on purpose says so in its header and calls
// requireRealTerminal() first. Tools never set the variable themselves.
//
// The machine's own processes: a board lists the Claude and Codex
// processes it finds with ps and lsof (server/sessions.mjs), which on the
// person's Mac are their real sessions, folders included. A test's board
// reads a stand-in instead (hub/tools/stub-ps.mjs, as MC_PS_BIN and
// MC_LSOF_BIN, with the made-up processes in STUB_PS_STATE, none without
// it). guardSpawns() makes the stand-in the default for every child of the
// tool, and refuses a board (the hub's server, or `ravenry` start or serve)
// whose environment names the real ps or lsof, or none. withStubMachine(env)
// adds them to an environment built from scratch.

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

// ------------------------------------------------------------ the machine's processes

export const STUB_PS = path.join(REPO, 'hub', 'tools', 'stub-ps.mjs');
const REAL_PS = /^(ps|lsof)$/;
const stubbed = (bin) => !!bin && !REAL_PS.test(path.basename(String(bin)));

/** `env` with the stand-in ps and lsof (hub/tools/stub-ps.mjs), unless it names stand-ins already. */
export function withStubMachine(env = {}) {
  return { ...env, MC_PS_BIN: stubbed(env.MC_PS_BIN) ? env.MC_PS_BIN : STUB_PS, MC_LSOF_BIN: stubbed(env.MC_LSOF_BIN) ? env.MC_LSOF_BIN : STUB_PS };
}

// ------------------------------------------------------------ the assistants
//
// A test never finds or runs the person's own Claude Code, Codex,
// Antigravity CLI or OpenCode, which would call a model on their account.
// On 2026-11-21 the native sidetest's New session started the person's
// OpenCode (it needs no sign-in, so it was the first signed in) in a test
// pane, and it called its model: the test board had the person's PATH.
//
// So guardSpawns() hands every child (and the tool itself) a PATH on which
// each assistant it would find is a stand-in: for each one that resolves to
// the person's own binary (on the PATH, or in the folders its installer uses
// that the hub and the Mac app also look in: assistantfind.mjs findBin,
// StartView.swift onPath), a stand-in folder of this repository's .tmp goes
// first. An assistant a test's PATH does not find stays not found (a test of
// "not installed" still works), and a test's own stand-in (any file of this
// repository, of a test root or of the system's temporary folders) is kept.
// The person's own binary, named by its path, is refused outright.
//
// Opting in: only the two end-to-end tests of a real assistant may reach
// one, each its own, and only by calling useRealAssistant first
// (REAL_ASSISTANT_TESTS). hub/tools/assistants-guard-test.mjs fails when a
// test board could resolve a real assistant without that.

// The commands of the assistants a board finds on its PATH and starts in a
// pane (hub/server/assistants.mjs `bin`). The test assistant is no one's.
export const ASSISTANT_BINS = ['claude', 'codex', 'agy', 'opencode'];
// The tests that may opt in, and to which assistant: hub/tools only.
export const REAL_ASSISTANT_TESTS = { 'opencode-test.mjs': ['opencode'], 'antigravity-test.mjs': ['agy'] };
const realAllowed = new Set();

export const STAND_INS = path.join(REPO, '.tmp', 'assistant-stand-ins');
const standInText = (bin) => `#!/bin/sh
# A stand-in for ${bin} on a test board (tools/test-env.mjs): the person's own
# assistant is never run by a test.
case "$1" in
  --version|-v|version) echo "0.0.0 (a stand-in)"; exit 0 ;;
  models|debug|login|logout|auth|mcp) exit 0 ;;
esac
echo "${bin} (a stand-in on a test board): $*"
exec /bin/sleep 3600
`;

function writeStandIn(file, bin) {
  const text = standInText(bin);
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* write it */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o755 });
  fs.renameSync(tmp, file);
}

/** The folder holding the guard's stand-in for one assistant (written if missing). */
export function standInDir(bin) {
  const dir = path.join(STAND_INS, bin);
  writeStandIn(path.join(dir, bin), bin);
  return dir;
}

const TEMP_ROOTS = [...new Set([os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((d) => { try { return fs.realpathSync(d); } catch { return d; } }))];
/** Whether this executable is a test's stand-in, not a person's assistant:
 * a file of this repository (its tools, its .tmp), of a test root, or of
 * the system's temporary folders, its links followed. */
export function isStandIn(file, env = process.env) {
  let real;
  try { real = fs.realpathSync(file); } catch { return true; }
  return [REPO, realOr(REPO), ...testRoots(env), ...TEMP_ROOTS].some((d) => inside(real, d));
}

const executable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

/** Where a board with this environment would find each assistant: its PATH,
 * then the install folders the hub (assistantfind.mjs) and the Mac app
 * (StartView.swift) also look in, under its HOME. { bin: file|null }.
 * homeDirs false: the folders under HOME are left out (a child that is not
 * a board, a hook say, finds a program on its PATH only; the system-wide
 * install folders stay, a shell's path_helper puts them on its PATH). */
export function assistantsFound(env = process.env, { homeDirs = true } = {}) {
  const home = env.HOME || REAL_HOME;
  const under = homeDirs ? [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.opencode', 'bin')] : [];
  const dirs = [...String(env.PATH || '').split(path.delimiter), ...under.slice(0, 2), '/opt/homebrew/bin', '/usr/local/bin', ...under.slice(2)];
  const out = {};
  for (const bin of ASSISTANT_BINS) {
    out[bin] = null;
    for (const d of dirs) {
      if (!d || !path.isAbsolute(d)) continue;
      const p = path.join(d, bin);
      if (executable(p)) { out[bin] = p; break; }
    }
  }
  return out;
}

/** The person's own assistants a board with this environment would find and
 * run, not opted in: [{ bin, file }]. `isStand` decides what a stand-in is. */
export function realAssistantsIn(env = process.env, { allowed = realAllowed, isStand = (f) => isStandIn(f, env), homeDirs = true } = {}) {
  return Object.entries(assistantsFound(env, { homeDirs })).filter(([bin, f]) => f && !allowed.has(bin) && !isStand(f)).map(([bin, file]) => ({ bin, file }));
}

/** `env`'s PATH with the guard's stand-in first for each assistant it would
 * find as the person's own (not opted in); the same PATH when there is none. */
export function standInPath(env = process.env, opts = {}) {
  const real = realAssistantsIn(env, opts);
  const PATH = String(env.PATH || '');
  if (!real.length) return PATH;
  const add = real.map((r) => standInDir(r.bin));
  // No PATH at all: a child looks in the system's default one, kept after.
  const rest = (PATH || '/usr/bin:/bin').split(path.delimiter).filter((d) => d && !add.includes(d));
  return [...add, ...rest].join(path.delimiter);
}

/**
 * A test that drives one real assistant end to end opts in to it, before it
 * looks for it: only the tests in REAL_ASSISTANT_TESTS, each its own
 * assistant. Its own process and its children may then find that one (the
 * other three stay stand-ins). Anything else ends the tool.
 */
export function useRealAssistant(bin, script = process.argv[1] || '') {
  const name = path.basename(script);
  const mine = path.relative(path.join(REPO, 'hub', 'tools'), path.resolve(script)) === name && (REAL_ASSISTANT_TESTS[name] || []).includes(bin);
  if (!mine) throw new Error(`Refused: ${name || 'this tool'} may not run the person's own ${bin}. Only ${Object.entries(REAL_ASSISTANT_TESTS).map(([t, b]) => `hub/tools/${t} (${b.join(', ')})`).join(' and ')} opt in to a real assistant (tools/test-env.mjs REAL_ASSISTANT_TESTS).`);
  realAllowed.add(bin);
  const dir = path.join(STAND_INS, bin);
  process.env.PATH = String(process.env.PATH || '').split(path.delimiter).filter((d) => d !== dir).join(path.delimiter);
}

/** Why this child is the person's own assistant, named by its path (or a
 * shell command line running one), not opted in; or null. */
function realAssistantChild(file, args, env) {
  const f = String(file || '');
  const base = path.basename(f);
  if (ASSISTANT_BINS.includes(base) && !realAllowed.has(base)) {
    if (path.isAbsolute(f) || f.includes('/')) return isStandIn(path.resolve(f), env) ? null : f;
  }
  if (/^(ba|z|da)?sh$/.test(base) && args[0] === '-c') {
    const re = new RegExp(`(?:^|[\\s;&|('"=])(/[^\\s;&|()'"]*/(${ASSISTANT_BINS.join('|')}))(?=['"\\s;&|)]|$)`, 'g');
    for (const m of String(args[1] || '').matchAll(re)) if (!realAllowed.has(m[2]) && executable(m[1]) && !isStandIn(m[1], env)) return m[1];
  }
  return null;
}

/**
 * A PATH for a test board on which every assistant is a stand-in, even one
 * the person does not have (a board that must list all four): each
 * assistant the PATH holds as a test's own stand-in is kept; for each other
 * one a stand-in in `dir`, first on the PATH, says what it is and waits
 * (`--version`, `models` and the like answer at once, with nothing).
 */
export function assistantStandIns(dir, PATH = process.env.PATH || '', env = process.env) {
  fs.mkdirSync(dir, { recursive: true });
  const found = assistantsFound({ ...env, PATH });
  for (const bin of ASSISTANT_BINS) {
    if (found[bin] && isStandIn(found[bin], env) && PATH.split(path.delimiter).some((d) => d && path.join(d, bin) === found[bin])) continue;
    writeStandIn(path.join(dir, bin), bin);
  }
  return `${dir}${path.delimiter}${PATH}`;
}

/** Why a board started with this environment would read the machine's own processes, or null. */
export function machineProblem(file, args = [], env = process.env) {
  if (childKind(file, args, env) !== 'hub') return null;
  const words = (args || []).filter((a) => typeof a === 'string' && !a.startsWith('-'));
  const script = words[0] || '';
  const sub = words[1] || '';
  const board = /server[/\\]index\.mjs$/.test(script) || (/bin[/\\]ravenry\.mjs$/.test(script) && ['', 'start', 'serve'].includes(sub));
  if (!board) return null;
  const bad = ['MC_PS_BIN', 'MC_LSOF_BIN'].filter((k) => !stubbed(env[k]));
  return bad.length ? `it would list this machine's own processes with the real ${bad.map((k) => (k === 'MC_PS_BIN' ? 'ps' : 'lsof')).join(' and ')} (set ${bad.join(' and ')} to hub/tools/stub-ps.mjs: withStubMachine(env))` : null;
}

// ------------------------------------------------------------ which children

const NODE_NAMES = new Set(['node', 'nodejs']);
const isNode = (file, env) => file === process.execPath || NODE_NAMES.has(path.basename(file)) || (env && env.ELECTRON_RUN_AS_NODE === '1');
const HUB_SCRIPT = /(^|[/\\])(server[/\\]index\.mjs|bin[/\\]ravenry\.mjs)$/;
const DAEMON_NAME = /^ravenryd?(-[\w.+-]+)?$/;
// The ravenryd and the Node an app bundle carries beside its executable
// (Ravenry.app/Contents/MacOS/ravenryd, .../node) are a daemon and a Node,
// not the app: taken for the app, a test's daemon call there was held to the
// app's rules and refused, and relaunchcheck's clean-up (ravenryd daemons,
// in a catch) never stopped the daemon its copy started (2026-11-11).
const isApp = (file) => !/^(ravenryd|node)$/.test(path.basename(file)) && (/[/\\]electron[/\\]dist[/\\]/.test(file) || /\.app[/\\]Contents[/\\]MacOS[/\\]/.test(file) || /\.AppImage$/.test(file) || /[/\\]linux(-[\w]+)?-unpacked[/\\]ravenry$/.test(file));
// ravenryd named in a shell command line, as a program (not a folder name).
const DAEMON_IN_SHELL = /(^|[\s;&|('"/])ravenryd['"]?(\s|$)/;

/** What a child is: 'daemon', 'hub', 'app', or null for anything else. */
export function childKind(file, args = [], env = null) {
  const f = String(file || '');
  if (!f) return null;
  if (isApp(f) && !(env && env.ELECTRON_RUN_AS_NODE === '1')) return 'app';
  // macOS's open starting an app bundle (open -a X, open X.app): the app
  // gets the caller's environment (2026-11-07, an app opened from a pane).
  if (/^\/usr\/bin\/open$|^open$/.test(f) && (args || []).some((a, i) => /\.app\/?$/.test(String(a)) || (args[i - 1] === '-a' || /^-[a-zA-Z]*a$/.test(String(args[i - 1] || ''))))) return 'app';
  if (isNode(f, env)) {
    const script = (args || []).find((a) => typeof a === 'string' && !a.startsWith('-'));
    return script && HUB_SCRIPT.test(script) ? 'hub' : null;
  }
  if (DAEMON_NAME.test(path.basename(f))) return 'daemon';
  if (/^(ba|z|da)?sh$/.test(path.basename(f)) && args[0] === '-c' && DAEMON_IN_SHELL.test(String(args[1] || ''))) return 'daemon';
  return null;
}

const NAMES = { daemon: 'ravenryd', hub: 'the hub', app: 'the app' };

// ------------------------------------------------------------ real terminal apps

export const REAL_TERMINAL_VAR = 'RAVENRY_TEST_REAL_TERMINAL';
/** The person asked for a test that drives their real cmux, iTerm2 or Rex. */
export const realTerminalAllowed = (env = process.env) => env[REAL_TERMINAL_VAR] === '1';

const REAL_APP_BIN = /[/\\](cmux|iTerm|iTerm2|Rex)\.app[/\\]/;
const TERMINAL_NAMES = { cmux: 'cmux', osascript: 'iTerm2 (through osascript)', rex: 'Rex' };
const TERMINAL_IN_SHELL = /(^|[\s;&|('"/])(cmux|osascript|rex)['"]?(\s|$)/;

/** The real terminal app a child would drive, or null: cmux, osascript
 * (iTerm2's scripting), Rex's command, iTerm2's Python API, or a shell
 * command line running one of them. */
export function realTerminalOf(file, args = []) {
  const f = String(file || '');
  if (!f) return null;
  const base = path.basename(f);
  if (REAL_APP_BIN.test(f)) return /cmux/.test(f) ? 'cmux' : /Rex/.test(f) ? 'Rex' : 'iTerm2';
  if (TERMINAL_NAMES[base]) return TERMINAL_NAMES[base];
  if (/^python3?$/.test(base) && (args || []).some((a) => /iterm-keys\.py$/.test(String(a)))) return 'iTerm2 (its Python API)';
  if (/^(ba|z|da)?sh$/.test(base) && args[0] === '-c') {
    const m = String(args[1] || '').match(TERMINAL_IN_SHELL);
    if (m) return TERMINAL_NAMES[m[2]];
  }
  return null;
}

// A stand-in a test gives the hub for a terminal's command: anything that
// is not the real app's (tools/fake-cmux.mjs, a stub, "none").
const realBin = (bin) => !bin || !!realTerminalOf(bin);

/** The real terminal app a hub started with this environment would drive
 * as its board's terminal (server/terminal.mjs boardKind), or null. */
export function boardRealTerminal(env) {
  const want = String(env.RAVENRY_TERMINAL || '').toLowerCase().replace(/^iterm2$/, 'iterm');
  const kind = want || (env.CMUX_SURFACE_ID || env.CMUX_WORKSPACE_ID ? 'cmux' : env.ITERM_SESSION_ID ? 'iterm' : env.REX_SESSION ? 'rex' : 'cmux');
  if (kind === 'cmux' && realBin(env.CMUX_BIN)) return 'cmux';
  if (kind === 'iterm' && realBin(env.ITERM_OSASCRIPT_BIN) && env.MC_APPS !== 'none') return 'iTerm2';
  if (kind === 'rex' && realBin(env.RAVENRY_REX_BIN)) return 'Rex';
  return null;
}

/** Ends a test made to drive a real terminal app unless the person asked
 * for it (RAVENRY_TEST_REAL_TERMINAL=1). `what`: the app, for the message. */
export function requireRealTerminal(what, why = 'this test') {
  if (realTerminalAllowed()) return;
  console.error(`Refused: ${why} drives the real ${what}, which puts windows on your screen. Run it yourself with ${REAL_TERMINAL_VAR}=1 when you mean to.`);
  process.exit(2);
}

function checkTerminal(file, args, env, kind) {
  if (realTerminalAllowed()) return;
  const t = realTerminalOf(file, args) || (kind === 'hub' ? boardRealTerminal(env) : null);
  if (t) throw new Error(`Refused to start ${path.basename(String(file))}${args && args.length ? ' ' + args.slice(0, 2).join(' ') : ''}: it would drive the real ${t}. A test uses a stand-in (tools/fake-cmux.mjs, stub-osascript.mjs, fake-rex.mjs), or runs with ${REAL_TERMINAL_VAR}=1 when the person asks for it.`);
}

// The release check (apps/desktop/tools/release-check.mjs) runs the
// packaged app under the real launchd, with a label of its own that no
// person's service has: `dev.ravenry.hub.test-<random>`. launchctl may act
// on such a label (print, bootout, kickstart), or bootstrap such a plist
// from a test's folder; nothing else.
export const TEST_LAUNCHD_LABEL = /^dev\.ravenry\.hub\.test-[a-z0-9]{4,32}$/;
function testLaunchctl(args, env) {
  const [verb, ...rest] = (args || []).map(String);
  if (['print', 'bootout', 'kickstart'].includes(verb)) {
    const target = rest.filter((a) => !a.startsWith('-'));
    return target.length === 1 && /^gui\/\d+\/[^/]+$/.test(target[0]) && TEST_LAUNCHD_LABEL.test(target[0].split('/')[2]);
  }
  if (verb === 'bootstrap') {
    const [domain, plist] = rest;
    return /^gui\/\d+$/.test(domain || '') && !!plist && isTestPath(plist, env) && TEST_LAUNCHD_LABEL.test(path.basename(plist, '.plist'));
  }
  return false;
}

/** Why starting this child would touch the person's launchd, or null. */
export function launchdProblem(file, args = [], env = process.env, platform = process.platform) {
  const base = path.basename(String(file || ''));
  if (base === 'launchctl') return testLaunchctl(args, env) ? null : 'it is the real launchctl, which loads jobs into the person\'s own session';
  if (/^(ba|z|da)?sh$/.test(base) && args[0] === '-c' && /(^|[\s;&|('"/])launchctl['"]?(\s|$)/.test(String(args[1] || ''))) return 'it runs the real launchctl';
  if (platform === 'darwin' && childKind(file, args, env) === 'app' && env.RAVENRY_SERVICE === 'install' && (!env.RAVENRY_LAUNCHCTL || path.basename(env.RAVENRY_LAUNCHCTL) === 'launchctl') && !TEST_LAUNCHD_LABEL.test(env.RAVENRY_SERVICE_LABEL || '')) return 'it would install its hub service with the real launchctl (set RAVENRY_LAUNCHCTL to tools/fake-launchctl.mjs)';
  return null;
}

// The variables a Ravenry pane (or another terminal) puts in its
// processes. An app started with them takes its whole window for that
// pane: on 2026-11-07 an app opened from inside a Ravenry pane inherited
// RAVENRY_PANE and RAVENRY_SOCKET, and the daemon read every key typed in
// it as the pane's own program typing (PROTOCOL.md section 4, rule 1). No
// tool starts the app with any of them.
export const PANE_VARS = ['RAVENRY_PANE', 'RAVENRY_SOCKET', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'];
export function paneVarsIn(env) {
  // A terminal's own pane variables only: a test's settings (CMUX_BIN, the
  // stand-in cmux) are not one.
  return Object.keys(env || {}).filter((k) => PANE_VARS.includes(k) || /^(CMUX_(SURFACE|WORKSPACE|PANEL|TAB)_ID|CMUX_SOCKET_PATH|ITERM_SESSION_ID|TMUX|TMUX_PANE|REX_BLOCK)$/.test(k));
}

// A tool that proves the app's own answer to a start from a pane
// (apps/desktop/tools/relaunch-check.mjs) says so first; even then only an
// app in the relaunch test mode, which keeps the test's folders, may start
// with them.
let paneLaunchAllowed = false;
export function allowPaneLaunch() { paneLaunchAllowed = true; }

function check(file, args, opts) {
  const env = (opts && opts.env) || process.env;
  if (childKind(file, args, env) === 'app' && !(paneLaunchAllowed && /^(1|foreground)$/.test(String(env.RAVENRY_RELAUNCH_TEST || '')))) {
    const leak = paneVarsIn(env);
    if (leak.length) throw new Error(`Refused to start the app (${path.basename(String(file))}): its environment has a terminal pane's variables (${leak.join(', ')}); start it with a clean one.`);
  }
  const ld = launchdProblem(file, args, env);
  if (ld) throw new Error(`Refused to start ${path.basename(String(file))}: ${ld}.`);
  const mp = machineProblem(file, args, env);
  if (mp) throw new Error(`Refused to start ${path.basename(String(file))}${args && args.length ? ' ' + args.slice(0, 2).join(' ') : ''}: ${mp}.`);
  const kind = childKind(file, args, env);
  if (kind) assertTestEnv(env, `${NAMES[kind]} (${path.basename(String(file))}${args && args.length ? ' ' + args.slice(0, 2).join(' ') : ''})`, { app: kind === 'app' });
  checkTerminal(file, args, env, kind);
  const own = realAssistantChild(file, args || [], env);
  if (own) throw new Error(`Refused to start ${own}: it is the person's own assistant, which a test never runs (a stand-in is on the PATH: tools/test-env.mjs). Only ${Object.keys(REAL_ASSISTANT_TESTS).join(' and ')} opt in to one (useRealAssistant).`);
  const left = realAssistantsIn(env, { homeDirs: !!kind });
  if (left.length) throw new Error(`Refused to start ${path.basename(String(file))}: it could find the person's own ${left.map((r) => `${r.bin} (${r.file})`).join(', ')}.`);
  return { kind, env };
}

// The options a child starts with, its PATH holding a stand-in first for
// each assistant it would otherwise find as the person's own. A child that
// inherits this process's environment gets the fix in process.env itself.
// The folders under HOME count for a board, ravenryd or an app (where the
// hub and the Mac app look), and for a child inheriting this process's
// environment (the tool's own, as guardSpawns() made it).
function withStandIns(file, args, opts) {
  if (!opts || typeof opts !== 'object' || !opts.env) {
    const PATH = standInPath(process.env);
    if (PATH !== String(process.env.PATH || '')) process.env.PATH = PATH;
    return opts;
  }
  const PATH = standInPath(opts.env, { homeDirs: !!childKind(file, args, opts.env) });
  return PATH === String(opts.env.PATH || '') ? opts : { ...opts, env: { ...opts.env, PATH } };
}

// ------------------------------------------------------------ nothing left running
// On 2026-11-07 five test daemons and a test hub from runs the day before
// were still running: a tool stopped by a signal or a time-out never ran its
// own clean-up. So guardSpawns() also remembers every ravenryd, hub and app
// a tool starts, and the runtime folder each was given, and when the tool
// ends (its last line, an uncaught error, process.exit, or SIGINT, SIGTERM
// or SIGHUP) stops them: each child, then every ravenryd still listening in
// those runtime folders (one a hub or `serve --detach` started is not the
// tool's child). Only a test's folder is ever looked in.
const started = new Set();   // child processes: ravenryd, hubs, apps
const runtimes = new Set();  // RAVENRY_RUNTIME_DIR of each
let origSync = null;         // execFileSync before the guard
let reaped = false;

function remember(kind, env, child) {
  if (!kind) return;
  if (child && typeof child.kill === 'function' && child.pid) started.add(child);
  const rt = env && env.RAVENRY_RUNTIME_DIR;
  if (rt && isTestPath(rt, env)) runtimes.add(path.resolve(rt));
}

/** The ravenryd processes listening in a runtime folder (lsof on its sockets). */
function daemonsIn(dir) {
  const out = new Set();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.sock')); } catch { return out; }
  for (const n of names) {
    let pids = '';
    try { pids = origSync('lsof', ['-t', '--', path.join(dir, n)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); } catch (e) { pids = (e && e.stdout) || ''; }
    for (const p of String(pids).split(/\s+/).map(Number).filter((x) => x > 0 && x !== process.pid)) {
      let comm = '';
      try { comm = origSync('ps', ['-o', 'comm=', '-p', String(p)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); } catch { continue; }
      if (/^ravenryd/.test(path.basename(comm))) out.add(p);
    }
  }
  return out;
}

/** Stops every ravenryd, hub and app this tool started. Safe to call twice. */
export function reapStarted() {
  if (reaped) return;
  reaped = true;
  for (const c of started) { if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGTERM'); } catch { /* gone */ } } }
  if (!origSync) return;
  for (const dir of runtimes) for (const pid of daemonsIn(dir)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

let guarded = false;

/**
 * From now on, every ravenryd, hub or app this process starts through
 * node:child_process is checked first (assertTestEnv), and so is every
 * child that would drive a real terminal app (checkTerminal): a refused one
 * throws before it starts. ESM named imports see it too.
 */
export function guardSpawns() {
  if (guarded) return;
  guarded = true;
  // Children that inherit this process's environment read the stand-in.
  for (const k of ['MC_PS_BIN', 'MC_LSOF_BIN']) if (!stubbed(process.env[k])) process.env[k] = STUB_PS;
  // And a stand-in for each assistant they would find as the person's own.
  process.env.PATH = standInPath(process.env);
  const cp = createRequire(import.meta.url)('node:child_process');
  origSync = cp.execFileSync;
  const split = (args, opts) => (Array.isArray(args) ? [args, opts] : [[], args]);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const orig = cp[name];
    cp[name] = function guardedChild(file, a, b, ...rest) {
      const [args, given] = split(a, b);
      const opts = withStandIns(given && given.shell ? '/bin/sh' : file, given && given.shell ? ['-c', [file, ...args].join(' ')] : args, given);
      if (opts !== given) { if (Array.isArray(a)) b = opts; else a = opts; }
      const c = opts && opts.shell ? check('/bin/sh', ['-c', [file, ...args].join(' ')], opts) : check(file, args, opts);
      const r = orig.call(this, file, a, b, ...rest);
      remember(c.kind, c.env, name === 'spawn' || name === 'execFile' ? r : null);
      return r;
    };
  }
  const fork = cp.fork;
  cp.fork = function guardedFork(mod, a, b, ...rest) {
    const [args, given] = split(a, b);
    const opts = withStandIns(process.execPath, [String(mod), ...args], given);
    if (opts !== given) { if (Array.isArray(a)) b = opts; else a = opts; }
    const c = check(process.execPath, [String(mod), ...args], opts);
    const r = fork.call(this, mod, a, b, ...rest);
    remember(c.kind, c.env, r);
    return r;
  };
  process.on('exit', reapStarted);
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(sig, () => { reapStarted(); process.exit(128 + n); });
  }
  for (const name of ['exec', 'execSync']) {
    const orig = cp[name];
    cp[name] = function guardedExec(command, given, ...rest) {
      const opts = withStandIns('/bin/sh', ['-c', String(command)], typeof given === 'object' ? given : null);
      check('/bin/sh', ['-c', String(command)], opts);
      return orig.call(this, command, opts && opts !== given ? opts : given, ...rest);
    };
  }
  syncBuiltinESMExports();
}

// For a launcher that is not Node (apps/macos/scripts/selftest.sh):
//   node tools/test-env.mjs path PATH HOME
// prints PATH with the stand-ins first, as guardSpawns() gives a child.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'path') {
  console.log(standInPath({ PATH: process.argv[3] || '', HOME: process.argv[4] || REAL_HOME }));
}
