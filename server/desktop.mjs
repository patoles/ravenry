// Mac notifications, the board's bell: when a project starts needing the user,
// one notification on this Mac, sent by the server, so it works with no
// page open (the old page-side web Notification needed the page open and
// never showed inside cmux's browser pane).
//
// It goes through `cmux notify --title "<Project> needs you" --body <kind>
// --workspace <the project's workspace> [--surface <its session's tab>]`,
// so clicking it opens that workspace. When the project has no open
// workspace, or cmux refuses or is missing, it falls back to
// `osascript -e 'display notification ...'`. A board in iTerm2 mode
// (server/terminal.mjs, BOARD) never asks cmux and always uses osascript.
// The triggers, wording and dedupe are the phone alerts' (server/alerts.mjs
// runs a second, separate trigger for this channel), and the text is never
// the session's: only "<Project> needs you" and the kind.
//
// A test board (RAVENRY_HOME or MC_HOME set) never runs the real cmux or
// the real osascript for this, so no automated test puts a notification on
// the user's screen: it needs stubs (CMUX_BIN, MC_OSASCRIPT_BIN) or
// MC_DESKTOP_REAL=1.

import { execFile } from 'node:child_process';

import { cmux, BOARD } from './terminal.mjs';
import { HOME_OVERRIDE } from './home.mjs';

const env = process.env;
const REAL_OSASCRIPT = '/usr/bin/osascript';
export const OSASCRIPT_BIN = env.MC_OSASCRIPT_BIN || REAL_OSASCRIPT;
const TIMEOUT_MS = 10000;

// On a test board, a real binary stays unrun unless MC_DESKTOP_REAL=1.
function held(bin, real) {
  return !!HOME_OVERRIDE && env.MC_DESKTOP_REAL !== '1' && (bin === real || bin === 'osascript' || bin === 'cmux');
}

// AppleScript string literal: backslashes and double quotes escaped, line
// breaks turned into spaces.
export function appleString(s) {
  return '"' + String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function osascriptArgs({ title, body }) {
  return ['-e', `display notification ${appleString(body)} with title ${appleString(title)}`];
}

function runOsascript(alert) {
  if (held(OSASCRIPT_BIN, REAL_OSASCRIPT)) return Promise.resolve({ ok: false, error: 'a test board does not run the real osascript' });
  return new Promise((resolve) => {
    execFile(OSASCRIPT_BIN, osascriptArgs(alert), { timeout: TIMEOUT_MS }, (err, _out, stderr) => {
      resolve(err ? { ok: false, error: `osascript: ${(String(stderr || '').trim().split('\n').pop() || err.message).slice(0, 160)}` } : { ok: true });
    });
  });
}

// Where a click should go: the workspace holding the session that needs
// the user, with its tab, else the project's first open workspace.
export function targetFor(p) {
  const s = (p.sessions || []).find((x) => x.surfaceId === p.primary);
  if (s && s.workspaceId) return { workspaceId: s.workspaceId, surfaceId: s.surfaceId || null };
  const w = (p.workspaces || []).find((x) => x && x.open && x.id);
  return { workspaceId: w ? w.id : null, surfaceId: null };
}

// { ok, via: 'cmux' | 'osascript', error }. Never throws.
export async function send(alert) {
  let why = null;
  if (alert.workspaceId && BOARD === 'cmux') {
    if (held(cmux.CMUX_BIN, cmux.DEFAULT_CMUX_BIN)) why = 'a test board does not run the real cmux';
    else {
      try {
        const r = await cmux.notify(alert);
        if (r.ok) return { ok: true, via: 'cmux' };
        why = `cmux: ${(r.err || 'no answer').split('\n').pop().slice(0, 160)}`;
      } catch (e) { why = `cmux: ${e.message}`; }
    }
  }
  const o = await runOsascript(alert);
  if (o.ok) return { ok: true, via: 'osascript', fallbackFrom: why };
  return { ok: false, via: null, error: why ? `${why}; ${o.error}` : o.error };
}
