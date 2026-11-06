// The iTerm2 adapter (docs/TERMINALS.md). The only module that talks to
// iTerm2: AppleScript (osascript) lists its sessions, reads a session's
// screen, writes text, presses Enter, focuses, opens a tab and closes one;
// iTerm2's Python API presses the arrow keys (server/iterm-keys.py).
//
// A session is named by its unique ID, the part after the colon of the
// ITERM_SESSION_ID the hook records ("w0t1p0:<UUID>"); the board's id for
// it is "iterm:<UUID>". Every script first checks that iTerm2 is running,
// so the board never launches it.
//
// A test board (RAVENRY_HOME or MC_HOME set) never runs the real osascript
// or Python for this: it needs stubs (ITERM_OSASCRIPT_BIN,
// RAVENRY_ITERM_PYTHON, see tools/fake-iterm.mjs) or MC_ITERM_REAL=1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME_OVERRIDE } from './home.mjs';

const env = process.env;
const REAL_OSASCRIPT = '/usr/bin/osascript';
export const OSASCRIPT_BIN = env.ITERM_OSASCRIPT_BIN || REAL_OSASCRIPT;
const KEYS_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'iterm-keys.py');
// Where tools/install-iterm.mjs puts the iterm2 package (always under the
// real ~/.ravenry, so a board with another RAVENRY_HOME finds it too).
export const VENV_PYTHON = path.join(os.homedir(), '.ravenry', 'iterm2-py', 'bin', 'python3');
const APP = 'application id "com.googlecode.iterm2"';
export const PREFIX = 'iterm:';
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

// "w0t1p0:<UUID>" or "<UUID>" or "iterm:<UUID>" -> "<UUID>", else null.
export function uuidOf(id) {
  const m = String(id || '').match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})$/i);
  return m ? m[1].toUpperCase() : null;
}

export function tabIdOf(itermSessionId) {
  const u = uuidOf(itermSessionId);
  return u ? PREFIX + u : null;
}

function held(bin, real) {
  return !!HOME_OVERRIDE && env.MC_ITERM_REAL !== '1' && bin === real;
}

// The Python with the iterm2 package: RAVENRY_ITERM_PYTHON, the venv
// tools/install-iterm.mjs makes, else the runtime iTerm2 installs for its
// own scripts (Scripts > Manage > Install Python Runtime).
export function pythonBin() {
  if (env.RAVENRY_ITERM_PYTHON) return env.RAVENRY_ITERM_PYTHON;
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'iTerm2');
  try {
    for (const d of fs.readdirSync(base).filter((x) => x.startsWith('iterm2env')).sort().reverse()) {
      const vs = path.join(base, d, 'versions');
      for (const v of fs.readdirSync(vs).sort().reverse()) {
        const py = path.join(vs, v, 'bin', 'python3');
        if (fs.existsSync(py)) return py;
      }
    }
  } catch { /* no runtime */ }
  return null;
}

function run(bin, args, { timeout = 6000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const msg = String(stderr || '').trim().split('\n').pop() || (err && err.message) || '';
      if (err) resolve({ ok: false, out: stdout || '', err: msg, code: err.code });
      else resolve({ ok: true, out: stdout, err: '' });
    });
  });
}

// One AppleScript, its arguments passed as argv (never pasted into the
// source, so no text from the board is ever read as script). The first line
// names the operation, for tools/fake-iterm.mjs.
function osa(op, body, args = [], opts) {
  if (held(OSASCRIPT_BIN, REAL_OSASCRIPT)) return Promise.resolve({ ok: false, out: '', err: 'a test board does not run the real osascript' });
  const src = `-- ravenry:${op}
${FIND}
on run argv
  if not (${APP} is running) then error "iTerm2 is not running." number 1000
${body}
end run`;
  return run(OSASCRIPT_BIN, ['-e', src, ...args.map(String)], opts).then((r) => (r.ok ? r : { ...r, err: plainError(r.err) }));
}

// The window, tab and session of a session's unique ID.
const FIND = `on findSession(sid)
  tell ${APP}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (unique ID of s) is sid then return {w, t, s}
        end repeat
      end repeat
    end repeat
  end tell
  error "That iTerm2 tab is closed." number 1001
end findSession`;

// osascript prints "execution error: <message> (<number>)"; keep the
// message, and say the macOS permission plainly.
function plainError(e) {
  const t = String(e || '').replace(/^.*?execution error: /, '').replace(/\s*\(-?\d+\)\s*$/, '').trim();
  if (/-1743|not authori[sz]ed/i.test(e)) return 'macOS has not allowed the board to control iTerm2 (System Settings > Privacy & Security > Automation).';
  return t || 'osascript gave no answer';
}

// ---------------------------------------------------------------- reads

// Every iTerm2 session: { id: "iterm:<UUID>", uuid, windowId, tty, title }.
// An empty list when iTerm2 is not running; throws when it cannot be asked.
export async function listTabs() {
  // (AppleScript names ignore case: the separator must not be called T
  // next to a tab called t.)
  const r = await osa('list', `  set sep to character id 9
  set out to ""
  tell ${APP}
    repeat with w in windows
      set wid to (id of w) as text
      repeat with t in tabs of w
        repeat with s in sessions of t
          set out to out & (unique ID of s) & sep & wid & sep & (tty of s) & sep & (name of s) & linefeed
        end repeat
      end repeat
    end repeat
  end tell
  return out`);
  if (!r.ok) {
    if (/not running/.test(r.err)) return [];
    throw new Error('iTerm2: ' + r.err);
  }
  const out = [];
  for (const line of r.out.split('\n')) {
    const [uuid, windowId, tty, ...name] = line.split('\t');
    if (!UUID.test(uuid || '')) continue;
    out.push({ id: PREFIX + uuid.toUpperCase(), uuid: uuid.toUpperCase(), windowId: windowId || null, tty: tty || null, title: name.join('\t').trim() });
  }
  return out;
}

// The visible screen of a session as plain text (iTerm2's AppleScript gives
// no scrollback), trailing spaces and blank rows trimmed, ending in a
// newline like cmux's read-screen; the last `lines` lines. null on failure.
export async function readScreen(id, lines = 40) {
  const u = uuidOf(id);
  if (!u) return null;
  const r = await osa('read', `  set {w, t, s} to my findSession(item 1 of argv)
  tell ${APP} to return contents of s`, [u], { timeout: 4000 });
  if (!r.ok) return null;
  return tidy(r.out, lines);
}

export function tidy(text, lines) {
  const rows = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  const keep = lines > 0 ? rows.slice(-lines) : rows;
  return keep.length ? keep.join('\n') + '\n' : '';
}

// ---------------------------------------------------------------- writes
// Callers must have checked the target (server/index.mjs). Nothing here decides.

// Text as typed, with no Enter. A line break would be Enter in iTerm2, so
// text that holds one goes as a bracketed paste (ESC[200~ ... ESC[201~),
// which Claude Code's prompt takes as pasted text, newlines and all.
export async function pasteText(id, text) {
  const u = uuidOf(id);
  if (!u) return { ok: false, err: 'no iTerm2 session named' };
  const t = String(text);
  const body = /[\r\n]/.test(t) ? `\x1b[200~${t.replace(/\r\n?/g, '\n')}\x1b[201~` : t;
  return osa('write', `  set {w, t, s} to my findSession(item 1 of argv)
  tell ${APP} to tell s to write text (item 2 of argv) newline no`, [u, body]);
}

const ARROWS = new Set(['up', 'down']);

// One named key. Enter goes through AppleScript (`write text "" newline
// yes`), Backspace as the DEL character (`write text (character id 127)`),
// Up and Down through iTerm2's Python API (server/iterm-keys.py), as
// agreed for menus (server/choose.mjs).
export async function pressKey(id, key) {
  const u = uuidOf(id);
  if (!u) return { ok: false, err: 'no iTerm2 session named' };
  if (key === 'enter') {
    return osa('enter', `  set {w, t, s} to my findSession(item 1 of argv)
  tell ${APP} to tell s to write text "" newline yes`, [u]);
  }
  // Backspace is the DEL character, written as typed input.
  if (key === 'backspace') {
    return osa('backspace', `  set {w, t, s} to my findSession(item 1 of argv)
  tell ${APP} to tell s to write text (character id 127) newline no`, [u]);
  }
  if (!ARROWS.has(key)) return { ok: false, err: `the board does not send the ${key} key to iTerm2` };
  const py = pythonBin();
  if (!py) return { ok: false, err: "iTerm2's Python package is not set up, so the board cannot press arrow keys there. Run ravenry setup once to set it up." };
  if (HOME_OVERRIDE && env.MC_ITERM_REAL !== '1' && !env.RAVENRY_ITERM_PYTHON) return { ok: false, err: 'a test board does not run the real iTerm2 Python API' };
  const r = await run(py, ['-I', KEYS_PY, u, key], { timeout: 8000 });
  if (r.ok) return r;
  if (r.code === 3) return { ...r, err: 'That iTerm2 tab is closed.' };
  return { ...r, err: 'iTerm2 Python API: ' + (r.err || 'no answer') + (/connect|refused|No such file/i.test(r.err) ? ' (is the Python API on in iTerm2 > Settings > General > Magic?)' : '') };
}

// "Open in iTerm2": brings iTerm2 forward on that window, tab and session.
export async function focus(id) {
  const u = uuidOf(id);
  if (!u) return { ok: false, err: 'no iTerm2 session named' };
  return osa('focus', `  set {w, t, s} to my findSession(item 1 of argv)
  tell ${APP}
    tell w to select
    tell t to select
    tell s to select
    activate
  end tell
  return "ok"`, [u]);
}

// A NEW tab with the default profile: in the window of `near` (a session's
// id) when it is open, else iTerm2's current window, else a new window. It
// runs the login shell; the caller types the command into it (as for cmux),
// so the tab outlives the command. iTerm2 selects a new tab in its window;
// iTerm2 itself is not brought forward. Returns { ok, surfaceId, surfaceRef }.
export async function openTab({ near = null } = {}) {
  const u = uuidOf(near) || '';
  const r = await osa('open', `  set nearId to item 1 of argv
  set w to missing value
  if nearId is not "" then
    try
      set {w, t, s} to my findSession(nearId)
    end try
  end if
  tell ${APP}
    if w is missing value and (count of windows) > 0 then set w to current window
    if w is missing value then
      set nw to (create window with default profile)
      return unique ID of current session of nw
    end if
    tell w to set nt to (create tab with default profile)
    return unique ID of current session of nt
  end tell`, [u]);
  if (!r.ok) return r;
  const id = uuidOf(r.out.trim());
  if (!id) return { ok: false, err: 'iTerm2 did not name the new tab' };
  return { ok: true, surfaceId: PREFIX + id, surfaceRef: 'iTerm2 tab' };
}

// Closes ONE session (its tab when it is the only one), which ends the
// Claude in it; its transcript stays. The caller re-checks it first.
export async function close(id) {
  const u = uuidOf(id);
  if (!u) return { ok: false, out: '', err: 'no tab named, nothing closed' };
  return osa('close', `  set {w, t, s} to my findSession(item 1 of argv)
  tell ${APP} to tell s to close
  return "ok"`, [u]);
}
