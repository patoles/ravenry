// Mac notifications, the board's bell: when a project starts needing the user,
// one notification on this Mac, sent by the server, so it works with no
// page open (the old page-side web Notification needed the page open and
// never showed inside cmux's browser pane).
//
// It goes through `cmux notify --title "<Project> needs you" --body <kind>
// --workspace <the project's workspace> [--surface <its session's tab>]`,
// so clicking it opens that workspace. When the project has no open
// workspace, or cmux refuses or is missing, it falls back to
// `osascript -e 'display notification ...'`. A board in iTerm2 mode or Rex
// mode (server/terminal.mjs, BOARD) never asks cmux and always uses osascript.
// The triggers, wording and dedupe are the phone alerts' (server/alerts.mjs
// runs a second, separate trigger for this channel), and the text is never
// the session's: only "<Project> needs you" and the kind.
//
// A test board (RAVENRY_HOME or MC_HOME set) never runs the real cmux or
// the real osascript for this, so no automated test puts a notification on
// the user's screen: it needs stubs (CMUX_BIN, MC_OSASCRIPT_BIN) or
// MC_DESKTOP_REAL=1.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { cmux, BOARD } from './terminal.mjs';
import { HOME_OVERRIDE } from './home.mjs';

const env = process.env;
const REAL_OSASCRIPT = '/usr/bin/osascript';
export const OSASCRIPT_BIN = env.MC_OSASCRIPT_BIN || REAL_OSASCRIPT;
const TIMEOUT_MS = 10000;

// A board whose HOME is not the account's own (the release check's
// throwaway HOMEs, where the hub runs under launchd with no RAVENRY_HOME):
// a test, whose notifications must never reach the person's screen.
function scratchHome() {
  try { return !!env.HOME && path.resolve(env.HOME) !== path.resolve(os.userInfo().homedir); } catch { return false; }
}

// On a test board, a real binary stays unrun unless MC_DESKTOP_REAL=1.
function held(bin, real) {
  return (!!HOME_OVERRIDE || scratchHome()) && env.MC_DESKTOP_REAL !== '1' && (bin === real || bin === 'osascript' || bin === 'cmux');
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

// The Ravenry app, when it runs, posts the notification itself (Electron's
// Notification: "Ravenry" with its icon, its own entry in System Settings >
// Notifications, a click opens the session) and answers whether macOS
// showed it (2026-11-08: osascript exited 0 and nothing showed, and the
// board said "shown"). server/index.mjs gives the channel: the app's event
// stream (GET /api/events?app=1) and its answer (POST
// /api/alerts/desktop/result).
let appChannel = null;
const waiting = new Map();
let seq = 0;
const APP_TIMEOUT_MS = Number(env.MC_DESKTOP_APP_TIMEOUT_MS) || 8000;

/** { connected(): boolean, send(payload): void } */
export function useApp(channel) { appChannel = channel; }

/** The app's answer for one it was sent: { id, ok, error, denied }. */
export function appResult(b) {
  const id = String((b && b.id) || '');
  const w = waiting.get(id);
  if (!w) return { ok: false, status: 404, error: 'No notification waits for that answer.' };
  waiting.delete(id);
  w({ ok: !!b.ok, error: b.ok ? null : String(b.error || 'It was not shown.').slice(0, 300), denied: !b.ok && !!b.denied });
  return { ok: true };
}

function viaApp(alert) {
  if (!appChannel || !appChannel.connected()) return null;
  const id = `n${Date.now().toString(36)}${(++seq).toString(36)}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'the Ravenry app did not answer', denied: false }); }, APP_TIMEOUT_MS);
    waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
    appChannel.send({ id, title: alert.title, body: alert.body, kind: alert.kind || null, projectId: alert.projectId || null, surfaceId: alert.surfaceId || null });
  });
}

// { ok, via: 'app' | 'cmux' | 'osascript', error, denied, unconfirmed }.
// Never throws. The app when it runs (its answer is what macOS did); else
// cmux (a click opens its workspace); else osascript, which macOS may drop
// without a word: said so (unconfirmed).
export async function send(alert) {
  const a = viaApp(alert);
  if (a) {
    const r = await a;
    return r.ok ? { ok: true, via: 'app' } : { ok: false, via: 'app', error: r.error, denied: r.denied };
  }
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
  if (o.ok) return { ok: true, via: 'osascript', unconfirmed: true, fallbackFrom: why ? `${why}; the Ravenry app is not running` : 'the Ravenry app is not running' };
  return { ok: false, via: null, error: why ? `${why}; ${o.error}` : o.error };
}
