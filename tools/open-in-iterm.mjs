#!/usr/bin/env node
// Opens the board in iTerm2, the way the pinned "Ravenry" workspace holds it
// in cmux: one iTerm2 tab named "Ravenry" with the board page on top (in
// iTerm2's own web browser) and a small terminal below it running
// `npm start` in this repo. A board started there runs in iTerm2 mode
// (server/terminal.mjs, BOARD): it drives iTerm2 only and never asks cmux.
//
//   npm run iterm                     open the Ravenry tab, or bring it forward
//   npm run iterm -- --window         the same, in a new iTerm2 window of its own
//   npm run iterm -- --close          close the Ravenry tab this opened (ends its board)
//   PORT=4602 RAVENRY_HOME=<dir> npm run iterm    a second board on another port
//
// What it does:
// - A tab this tool opened carries the session variable user.ravenryBoard
//   ("<port>:page" and "<port>:server"). When one is open for the port, it
//   is brought forward and nothing new opens; when its board is down, the
//   start command is typed into its terminal again. It never touches a tab
//   without that variable.
// - When a board already answers on the port (started in cmux, by launchd,
//   or by hand), only the page opens.
// - iTerm2's web browser needs its Browser Plugin
//   (/Applications/iTermBrowserPlugin.app, https://iterm2.com/browser-plugin.html).
//   Without it the page opens in the default browser instead, and this says
//   so; the terminal still runs in iTerm2. It never asks iTerm2 for a web
//   page without the plugin (iTerm2 would stop on an alert).
// - The page is a profile iTerm2 loads from
//   ~/Library/Application Support/iTerm2/DynamicProfiles/ravenry.json:
//   "Ravenry board" (Web Browser, first page the board) for :4600,
//   "Ravenry board :<port>" for another port. By hand: iTerm2 > Profiles >
//   Ravenry board opens the page in a new tab.
// - A browser session loads its first page once, so the page opens only
//   after the board answers: the terminal starts first, then the page is
//   split in above it through iTerm2's Python API (`before`, which
//   AppleScript lacks), with the terminal kept 8 rows high. Without the
//   Python API (Settings > General > Magic) the page goes below instead.
//
// The start command carries PORT and every RAVENRY_* and MC_* variable set
// here, so a scratch board started this way is the same scratch board. A
// value inside this repo's .tmp (a test's data folder or projects root) and
// the test markers never reach the real iTerm2: such a run is refused, so a
// test's environment can never start the user's real board (2026-11-03: a test
// registry reached the real ~/.ravenry, and the env path was checked too).
//
// Test hooks: ITERM_OSASCRIPT_BIN (tools/fake-iterm.mjs plays the scripts),
// RAVENRY_ITERM_PROFILES (the profiles folder), RAVENRY_ITERM_BROWSER=0|1
// (plugin missing or there), RAVENRY_ITERM_API=0|1 (Python API off or on),
// RAVENRY_ITERM_PYTHON (the Python, as for server/iterm.mjs),
// RAVENRY_OPEN_BIN (what opens the default browser), RAVENRY_ITERM_WAIT_MS
// (how long to wait for the board).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonBin } from '../server/iterm.mjs';
import { inRepoTmp, isTestEnv } from '../server/home.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const OSASCRIPT = env.ITERM_OSASCRIPT_BIN || '/usr/bin/osascript';
const OPEN = env.RAVENRY_OPEN_BIN || '/usr/bin/open';
const APP = 'application id "com.googlecode.iterm2"';
const ITERM_ID = 'com.googlecode.iterm2';
const PLUGIN_ID = 'com.googlecode.iterm2.iTermBrowserPlugin';
export const VAR = 'user.ravenryBoard';

export const portOf = (e = env) => Number(e.PORT || 4600);
export const boardUrl = (port) => `http://localhost:${port}/`;
export const pageName = (port) => (port === 4600 ? 'Ravenry board' : `Ravenry board :${port}`);
export const profilesDir = (e = env) => e.RAVENRY_ITERM_PROFILES || path.join(os.homedir(), 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles');
const PROFILE_FILE = 'ravenry.json';
const SPLIT_PY = path.join(REPO, 'tools', 'iterm-board-split.py');
export const TERMINAL_ROWS = 8;

// The dynamic profiles file with this port's page profile in it (others
// kept as they are). "Custom Command": "Browser" makes a Web Browser
// profile; "Initial URL" is its first page. (A data: URL there loads
// nothing, measured on iTerm2 3.7.6, so the first page is the board itself.)
// "Icon": 2 is iTerm2's iTermProfileIconCustom and "Custom Icon Path" its
// image (ITAddressBookMgr.h): the tab shows the Perch mark, the 32 px small
// cut from brand/ravenry/ (a 16 pt tab icon on a Retina screen).
export const TAB_ICON = path.join(REPO, 'brand', 'ravenry', 'favicon-32.png');
export function withPageProfile(json, port) {
  const doc = json && Array.isArray(json.Profiles) ? json : { Profiles: [] };
  const guid = `ravenry-board-page-${port}`;
  const p = { Name: pageName(port), Guid: guid, 'Custom Command': 'Browser', 'Initial URL': boardUrl(port), Icon: 2, 'Custom Icon Path': TAB_ICON, Tags: ['Ravenry'] };
  return { ...doc, Profiles: [...doc.Profiles.filter((x) => x.Guid !== guid), p] };
}

export function withoutPageProfile(json, port) {
  const doc = json && Array.isArray(json.Profiles) ? json : { Profiles: [] };
  return { ...doc, Profiles: doc.Profiles.filter((x) => x.Guid !== `ravenry-board-page-${port}`) };
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The variables that would carry a test into a real board: values inside
// the repo's .tmp, and the test markers.
export function testVars(e = env) {
  const keys = Object.keys(e).filter((k) => (k === 'PORT' || /^(RAVENRY|MC)_/.test(k)) && inRepoTmp(e[k]));
  if (isTestEnv(e)) keys.push(e.TEST_RAVENRY === '1' ? 'TEST_RAVENRY' : 'MC_TEST');
  return keys.sort();
}

// `cd <repo> && PORT=.. RAVENRY_HOME=.. npm start`: the port and every
// RAVENRY_* / MC_* variable set here go along (not the test hooks above).
// `run` replaces `npm start`: an installed Ravenry (`ravenry` in an iTerm2
// tab) passes its own Node and bin, since its folder has no npm scripts
// that matter and a PATH in a fresh tab may hold another Node.
export function startCommand(e = env, repo = REPO, run = 'npm start') {
  // The tool's own switches stay here; RAVENRY_ITERM_PYTHON is the board's too.
  const skip = new Set(['RAVENRY_ITERM_PROFILES', 'RAVENRY_ITERM_BROWSER', 'RAVENRY_ITERM_API', 'RAVENRY_OPEN_BIN', 'RAVENRY_ITERM_WAIT_MS', 'MC_TEST']);
  // Only a fake iTerm2 (a test) ever gets a test's scratch values.
  const fake = !!e.ITERM_OSASCRIPT_BIN;
  const pass = Object.keys(e).filter((k) => (k === 'PORT' || /^(RAVENRY|MC)_/.test(k)) && !skip.has(k) && (fake || !inRepoTmp(e[k]))).sort();
  const vars = pass.map((k) => `${k}=${sh(e[k])}`).join(' ');
  return `cd ${sh(repo)} && ${vars ? vars + ' ' : ''}${run}`;
}

function run(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, encoding: 'utf8' }, (err, out, stderr) => {
      const msg = String(stderr || '').trim().split('\n').pop() || (err && err.message) || '';
      resolve(err ? { ok: false, out: out || '', err: msg.replace(/^.*?execution error: /, '').replace(/\s*\(-?\d+\)\s*$/, '') } : { ok: true, out: out || '' });
    });
  });
}

// One AppleScript, arguments as argv; the first line names it for the fake.
function osa(op, body, args = []) {
  return run(OSASCRIPT, ['-e', `-- ravenry:${op}\non run argv\n${body}\nend run`, ...args.map(String)]);
}

// Where macOS has an app by its bundle id, or null.
async function appPath(id) {
  const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import("AppKit"); const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("${id}"); u.isNil() ? "" : ObjC.unwrap(u.path)`]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

export async function hasBrowserPlugin(e = env) {
  if (e.RAVENRY_ITERM_BROWSER === '0') return false;
  if (e.RAVENRY_ITERM_BROWSER === '1') return true;
  return !!(await appPath(PLUGIN_ID));
}

// { up, ours }: something answers on the port, and it is a Ravenry board.
export async function boardAnswers(port) {
  try {
    const res = await fetch(boardUrl(port) + 'api/state', { signal: AbortSignal.timeout(1500) });
    const j = await res.json().catch(() => null);
    return { up: true, ours: !!(j && 'projects' in j) };
  } catch {
    return { up: false, ours: false };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sessions this tool opened for the port: [{ windowId, tab, uuid, role }].
export async function findBoardTab(port) {
  const r = await osa('board-find', `  set want to item 1 of argv
  set sep to character id 9
  set out to ""
  tell ${APP}
    if not running then return ""
    repeat with w in windows
      set k to 0
      repeat with t in tabs of w
        set k to k + 1
        repeat with s in sessions of t
          set v to ""
          try
            tell s to set v to (variable named "${VAR}")
          end try
          if v is (want & ":page") or v is (want & ":server") then set out to out & (id of w) & sep & k & sep & (unique ID of s) & sep & v & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out`, [port]);
  if (!r.ok) throw new Error(r.err || 'iTerm2 did not answer');
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [windowId, tab, uuid, v] = l.split('\t');
    return { windowId, tab: Number(tab), uuid, role: String(v).split(':')[1] };
  });
}

async function ensureRunning() {
  const r = await osa('board-running', `  return (${APP} is running) as text`);
  if (r.ok && r.out.trim() === 'true') return true;
  await run(OPEN, ['-b', ITERM_ID]);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const x = await osa('board-running', `  return (${APP} is running) as text`);
    if (x.ok && x.out.trim() === 'true') return true;
  }
  return false;
}

// A new tab (in iTerm2's current window, else a new window, 1280 by 860
// points, since a profile's own 80 by 25 leaves the page a strip) holding either
// the page (`page` names its profile) or the terminal running `command`.
// Returns "<role>\t<UUID>" lines.
async function openBoardTab({ port, page, command, newWindow = false }) {
  return osa('board-open', `  set boardPort to item 1 of argv
  set pageProfile to item 2 of argv
  set cmd to item 3 of argv
  set out to ""
  tell ${APP}
    set w to missing value
    if (count of windows) > 0 and (item 4 of argv) is not "window" then set w to current window
    if pageProfile is not "" then
      if w is missing value then
        set w to (create window with profile pageProfile)
        set bounds of w to {60, 40, 1340, 900}
        set t to current tab of w
      else
        tell w to set t to (create tab with profile pageProfile)
      end if
      set b to current session of t
      tell b to set variable named "${VAR}" to (boardPort & ":page")
      tell w to select
      tell t to select
      activate
      return "page" & character id 9 & (unique ID of b) & linefeed
    else
      if w is missing value then
        set w to (create window with default profile)
        set bounds of w to {60, 40, 1340, 900}
        set t to current tab of w
      else
        tell w to set t to (create tab with default profile)
      end if
      set s to current session of t
    end if
    tell s
      set name to "Ravenry"
      set variable named "${VAR}" to (boardPort & ":server")
      write text cmd
    end tell
    set out to out & "server" & character id 9 & (unique ID of s) & linefeed
    tell w to select
    tell t to select
    activate
  end tell
  return out`, [port, page || '', command || '', newWindow ? 'window' : 'tab']);
}

// The page next to the board's terminal: above it through the Python API
// when it is on, else below it through AppleScript. Returns the page's id.
async function addPage({ port, page, serverId }) {
  const tag = `${port}:page`;
  const py = env.RAVENRY_ITERM_API === '0' ? null : pythonBin();
  if (py && (env.RAVENRY_ITERM_API === '1' || (await apiOn()))) {
    const r = await run(py, ['-I', SPLIT_PY, serverId, page, tag, String(TERMINAL_ROWS)], 20000);
    const id = r.ok && r.out.trim().split('\n').pop();
    if (id) return { ok: true, id, above: true };
  }
  const r = await osa('board-split', `  tell ${APP}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (unique ID of s) is (item 1 of argv) then
            tell s to set b to (split horizontally with profile (item 2 of argv))
            tell b to set variable named "${VAR}" to (item 3 of argv)
            tell s to set rows to ${TERMINAL_ROWS}
            return unique ID of b
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "That iTerm2 tab is closed."`, [serverId, page, tag]);
  return r.ok ? { ok: true, id: r.out.trim(), above: false } : { ok: false, err: r.err };
}

// iTerm2's Python API switch (Settings > General > Magic > Enable Python
// API). Read from its settings, so nothing asks iTerm2 while it is off.
async function apiOn() {
  const r = await run('/usr/bin/defaults', ['read', ITERM_ID, 'EnableAPIServer']);
  return r.ok && r.out.trim() === '1';
}

async function focusTab(found) {
  const f = found[0];
  return osa('board-focus', `  set wid to (item 1 of argv) as integer
  set k to (item 2 of argv) as integer
  tell ${APP}
    set w to window id wid
    tell w to select
    tell tab k of w to select
    activate
  end tell
  return "ok"`, [f.windowId, f.tab]);
}

async function typeInto(uuid, command) {
  return osa('board-type', `  tell ${APP}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (unique ID of s) is (item 1 of argv) then
            tell s to write text (item 2 of argv)
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "That iTerm2 tab is closed."`, [uuid, command]);
}

// One session at a time: a list walked while one of its sessions closes
// goes stale, and the second close was lost (measured on iTerm2 3.7.6).
async function closeSessions(found) {
  const errs = [];
  for (const f of found) {
    const r = await osa('board-close', `  tell ${APP}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (unique ID of s) is (item 1 of argv) then
            tell s to close
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "gone"`, [f.uuid]);
    if (!r.ok) errs.push(r.err);
  }
  return errs.length ? { ok: false, err: errs.join('; ') } : { ok: true };
}

function readProfiles(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf8')); } catch { return null; }
}

function writeProfiles(dir, doc) {
  const file = path.join(dir, PROFILE_FILE);
  if (!doc.Profiles.length) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(300); }
  return false;
}

export async function main(argv = process.argv.slice(2), say = console.log, { run: runCmd } = {}) {
  const port = portOf();
  const url = boardUrl(port);
  const tv = env.ITERM_OSASCRIPT_BIN ? [] : testVars();
  if (tv.length) { say(`Refused: this shell carries a test's settings (${tv.join(', ')}), and a board started from it would run on a test's data. Open a fresh shell, or unset them, and run this again.`); return 1; }
  if (!(await appPath(ITERM_ID)) && !env.ITERM_OSASCRIPT_BIN) { say(`iTerm2 is not installed (https://iterm2.com). Start the board with ${runCmd ? 'ravenry' : 'npm start'} in your terminal instead.`); return 1; }

  if (argv.includes('--close')) {
    const found = await findBoardTab(port).catch(() => []);
    const c = found.length ? await closeSessions(found) : { ok: true };
    writeProfiles(profilesDir(), withoutPageProfile(readProfiles(profilesDir()), port));
    if (!c.ok) { say(`iTerm2 did not close all of the Ravenry tab for :${port}: ${c.err}`); return 1; }
    // The board in its terminal ends with the tab, a moment later.
    if (found.some((f) => f.role === 'server') && !(await waitFor(async () => !(await boardAnswers(port)).up, Number(env.RAVENRY_ITERM_WAIT_MS) || 10000))) say(`The tab is closed but a board still answers on ${url}.`);
    say(found.length ? `Closed the Ravenry tab for :${port}.` : `No Ravenry tab for :${port} is open.`);
    return 0;
  }

  if (!(await ensureRunning())) { say('iTerm2 did not start.'); return 1; }
  const plugin = await hasBrowserPlugin();
  const board = await boardAnswers(port);
  if (board.up && !board.ours) { say(`:${port} answers but it is not a Ravenry board. Stop it or set PORT.`); return 1; }
  const command = startCommand(env, REPO, runCmd);
  let found = await findBoardTab(port);

  const page = plugin ? pageName(port) : '';
  // iTerm2 loads a changed profiles file on its own, a moment later.
  if (plugin) writeProfiles(profilesDir(), withPageProfile(readProfiles(profilesDir()), port));
  const wait = Number(env.RAVENRY_ITERM_WAIT_MS) || 30000;
  const waitUp = async () => board.up || (await waitFor(async () => (await boardAnswers(port)).up, wait));
  const noPlugin = async () => {
    await run(OPEN, [url]);
    say(`iTerm2's web browser needs its Browser Plugin, which is not installed, so the board page opened in your default browser. Install it from https://iterm2.com/browser-plugin.html (put it in /Applications) and run this again to see the page inside iTerm2.`);
  };
  // A profile iTerm2 has not loaded yet reads as "Can't find a profile".
  const retry = async (fn) => { let r; for (let i = 0; i < 12; i++) { r = await fn(); if (r.ok || !/profile/i.test(r.err || '')) break; await sleep(500); } return r; };

  if (found.length) {
    await focusTab(found);
    const server = found.find((f) => f.role === 'server');
    const restart = !board.up && server;
    if (restart) await typeInto(server.uuid, command);
    if (!found.some((f) => f.role === 'page')) {
      if (!plugin) await noPlugin();
      else if (server && (await waitUp())) await retry(() => addPage({ port, page, serverId: server.uuid }));
    }
    say(restart ? `Brought the Ravenry tab forward and started the board again in it (${url}).` : `Brought the Ravenry tab forward (${url}).`);
    return 0;
  }

  const newWindow = argv.includes('--window');
  if (board.up) {
    // A board already runs (in cmux, by launchd, by hand): only the page.
    if (!plugin) { await noPlugin(); return 0; }
    const r = await retry(() => openBoardTab({ port, page, command: '', newWindow }));
    if (!r.ok) { say('iTerm2 did not open the board page: ' + r.err); return 1; }
    say(`Opened the board page in iTerm2 (${url}); the board was already running.`);
    return 0;
  }
  const r = await openBoardTab({ port, page: '', command, newWindow });
  if (!r.ok) { say('iTerm2 did not open the Ravenry tab: ' + r.err); return 1; }
  const serverId = (r.out.split('\n').find((l) => l.startsWith('server\t')) || '').split('\t')[1];
  if (!(await waitUp())) { say(`The board has not answered on ${url} after ${Math.round(wait / 1000)} s; look at the terminal in the Ravenry tab.`); return 1; }
  if (!plugin) { await noPlugin(); say(`Opened the Ravenry tab in iTerm2: the board runs in its terminal (${url}).`); return 0; }
  const a = await retry(() => addPage({ port, page, serverId }));
  if (!a.ok) { say('The board runs in the Ravenry tab, but iTerm2 did not open its page: ' + a.err); return 1; }
  say(`Opened the Ravenry tab in iTerm2: the board page${a.above ? '' : ' (below; turn on the Python API to have it above)'} with the board's terminal${a.above ? ' below it' : ' above it'} (${url}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
