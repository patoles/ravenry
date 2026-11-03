// The one terminal interface (docs/TERMINALS.md). The rest of the board
// reaches a terminal only through this module: every cmux call and every
// iTerm2 call goes through here, and nothing else imports an adapter.
//
// A tab is { kind, surfaceId, workspaceId? }:
//   cmux   { kind: 'cmux', workspaceId, surfaceId } (cmux's UUIDs)
//   iterm  { kind: 'iterm', surfaceId: 'iterm:<UUID>' } (server/iterm.mjs)
// The board's ids keep their old shape for cmux (a bare UUID), so a
// surface id with no prefix is a cmux tab.
//
// Which terminal a session runs in comes from its hook events
// (hooks/events.mjs records `terminal` and `terminal_id`). A terminal with
// no adapter here is watch only: the board shows what the events say and
// its controls say why they are off (cannotDrive).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cmuxAdapter from './cmux.mjs';
import * as iterm from './iterm.mjs';

// The board's own terminal (docs/TERMINALS.md, The board's terminal): the
// one it opens new work in (New project, Revive, Reopen, a hand-off's
// fresh session) and the only one besides iTerm2 it ever asks.
//   RAVENRY_TERMINAL=cmux|iterm   wins
//   CMUX_SURFACE_ID or CMUX_WORKSPACE_ID   started inside cmux: cmux
//   ITERM_SESSION_ID or TERM_PROGRAM=iTerm.app   started in iTerm2: iterm
//   otherwise (launchd, another terminal)   cmux when cmux is installed,
//                                          else iterm (iTerm2 installed or
//                                          not: with neither, every session
//                                          is watch only, and iTerm2 mode is
//                                          the one that never needs its app)
// In iTerm2 mode the board never runs the cmux CLI: `cmux` below is a stand
// in that answers "nothing there" without starting a process.
export function boardKind(env = process.env, has = fs.existsSync) {
  const want = String(env.RAVENRY_TERMINAL || '').toLowerCase().replace(/^iterm2$/, 'iterm');
  if (want === 'cmux' || want === 'iterm') return want;
  if (env.CMUX_SURFACE_ID || env.CMUX_WORKSPACE_ID) return 'cmux';
  if (env.ITERM_SESSION_ID || env.TERM_PROGRAM === 'iTerm.app') return 'iterm';
  if (has(env.CMUX_BIN || cmuxAdapter.DEFAULT_CMUX_BIN)) return 'cmux';
  return 'iterm';
}

export const BOARD = boardKind();

// Is the board's own terminal app on this Mac? Without it every session is
// watch only, and the page says so in one line with where to get iTerm2.
// MC_APPS=<kinds> (comma separated, "none" for neither) stands in for the
// Mac's apps in tests.
export function appInstalled(kind, env = process.env, has = fs.existsSync) {
  if (env.MC_APPS != null) return env.MC_APPS.split(',').map((x) => x.trim()).includes(kind);
  if (kind === 'cmux') return has(env.CMUX_BIN || cmuxAdapter.DEFAULT_CMUX_BIN);
  if (kind === 'iterm') return [path.join('/Applications', 'iTerm.app'), path.join(os.homedir(), 'Applications', 'iTerm.app')].some((p) => has(p));
  return false;
}
export const BOARD_INSTALLED = appInstalled(BOARD);

const NO_CMUX = {
  CMUX_BIN: cmuxAdapter.CMUX_BIN, DEFAULT_CMUX_BIN: cmuxAdapter.DEFAULT_CMUX_BIN,
  listWorkspaces: async () => [],
  listHookSessions: async () => [],
  sidebarState: async () => null,
  resumeBinding: async () => null,
  currentWorkspace: async () => null,
  watchEvents: () => () => {},
  newWorkspace: async () => ({ ok: false, out: '', err: 'this board runs in iTerm2 mode, so it does not open cmux workspaces' }),
  notify: async () => ({ ok: false, out: '', err: 'this board runs in iTerm2 mode' }),
  pool: cmuxAdapter.pool,
};

// cmux's own listing and extras (workspaces, its hook store, sidebar,
// resume bindings, events, new workspace, notifications), used where the
// board is built around cmux workspaces. In iTerm2 mode, the stand in.
export const cmux = BOARD === 'cmux' ? cmuxAdapter : NO_CMUX;

// What the board calls each terminal the hook can name.
const NAMES = {
  cmux: 'cmux', iterm: 'iTerm2', 'apple-terminal': 'Terminal', tmux: 'tmux', vscode: 'VS Code',
  ghostty: 'Ghostty', wezterm: 'WezTerm', kitty: 'kitty', warp: 'Warp', alacritty: 'Alacritty', hyper: 'Hyper', zed: 'Zed',
};

export function nameOf(kind) {
  if (!kind) return 'an unknown terminal';
  return NAMES[kind] || kind;
}

// The kind of terminal a board surface id belongs to.
export function kindOf(surfaceId) {
  return String(surfaceId || '').startsWith(iterm.PREFIX) ? 'iterm' : 'cmux';
}

// The board's tab id for a session the events place in a terminal with an
// adapter other than cmux (cmux sessions carry their surface id already).
export function tabIdFor(kind, terminalId) {
  if (kind === 'iterm') return iterm.tabIdOf(terminalId);
  return null;
}

const ADAPTERS = {
  cmux: {
    readScreen: (t, n) => cmuxAdapter.readScreen(t.workspaceId, t.surfaceId, n),
    pasteText: (t, text) => cmuxAdapter.pasteText(t.workspaceId, t.surfaceId, text),
    typeText: (t, text) => cmuxAdapter.typeText(t.workspaceId, t.surfaceId, text),
    pressKey: (t, k) => cmuxAdapter.pressKey(t.workspaceId, t.surfaceId, k),
    focus: (t) => cmuxAdapter.focusSurface(t.workspaceId, t.surfaceId),
    close: (t) => cmuxAdapter.closeSurface(t.workspaceId, t.surfaceId),
    openTab: (o) => cmuxAdapter.newTerminalSurface({ workspaceId: o.workspaceId, paneId: o.paneId || null, cwd: o.cwd || null }),
  },
  iterm: {
    listTabs: () => iterm.listTabs(),
    readScreen: (t, n) => iterm.readScreen(t.surfaceId, n),
    pasteText: (t, text) => iterm.pasteText(t.surfaceId, text),
    // AppleScript `write text` with no newline arrives as typed input.
    typeText: (t, text) => iterm.pasteText(t.surfaceId, text),
    pressKey: (t, k) => iterm.pressKey(t.surfaceId, k),
    focus: (t) => iterm.focus(t.surfaceId),
    close: (t) => iterm.close(t.surfaceId),
    openTab: (o) => iterm.openTab({ near: o.near || null }),
  },
};

// Terminals the board can type into, read and open tabs in. A board in
// iTerm2 mode leaves cmux alone, so its sessions there are watch only.
export function canDrive(kind) {
  if (kind === 'cmux' && BOARD !== 'cmux') return false;
  return !!ADAPTERS[kind];
}

// Why the board cannot act on a session in this terminal, in plain words
// (null when it can). `open` is false when the terminal has an adapter but
// the session's tab was not found in it.
export function cannotDrive(kind, { open = true } = {}) {
  if (!kind) return "The board does not know which terminal this session runs in, so it only shows what the session's hook events say. Answer it in its own window.";
  if (kind === 'cmux' && BOARD !== 'cmux') return `This session runs in cmux, and this board runs in ${nameOf(BOARD)}, so it only shows what the session's hook events say. Answer it in cmux.`;
  if (!canDrive(kind)) return `This session runs in ${nameOf(kind)}. The board cannot read or type into ${nameOf(kind)} yet, so it only shows what the session's hook events say. Answer it in ${nameOf(kind)}.`;
  if (!open) return `The board cannot find this session's ${nameOf(kind)} tab, so it only shows what the session's hook events say.`;
  return null;
}

// The same, short, for the composer: why nothing can be typed from here.
export function cannotType(kind, { open = true } = {}) {
  if (!kind) return 'The board does not know which terminal this session runs in, so it cannot type into it.';
  if (kind === 'cmux' && BOARD !== 'cmux') return `This session runs in cmux and this board runs in ${nameOf(BOARD)}, so it cannot type into it. Answer it in cmux.`;
  if (!canDrive(kind)) return `This session runs in ${nameOf(kind)}, so the board cannot type into it. Answer it in ${nameOf(kind)}.`;
  if (!open) return `The board cannot find this session's ${nameOf(kind)} tab, so it cannot type into it.`;
  return null;
}

function adapter(tab) {
  const a = tab && ADAPTERS[tab.kind || 'cmux'];
  if (!a) throw new Error(`no adapter for ${nameOf(tab && tab.kind)}`);
  return a;
}

// The tabs of a terminal that lists its own (iTerm2): [{ id, title, ... }].
export async function listTabs(kind) {
  const a = ADAPTERS[kind];
  if (!a || !a.listTabs) return [];
  return a.listTabs();
}

// The last `lines` lines of a tab as plain text, or null.
export const readScreen = (tab, lines = 40) => adapter(tab).readScreen(tab, lines);
// Text as written (newlines kept, no Enter). { ok, err }.
export const pasteText = (tab, text) => adapter(tab).pasteText(tab, text);
// Text as keystrokes (no paste), for the "!" that turns on bash mode.
export const typeText = (tab, text) => adapter(tab).typeText(tab, text);
// One named key: enter, up, down. { ok, err }.
export const pressKey = (tab, key) => adapter(tab).pressKey(tab, key);
// Brings the terminal forward on that tab. { ok, err }.
export const focus = (tab) => adapter(tab).focus(tab);
// Closes one tab (ends the Claude in it). { ok, err }.
export const close = (tab) => adapter(tab).close(tab);
// A NEW tab: cmux { workspaceId, paneId, cwd }, iTerm2 { near } (a session
// id whose window gets the tab). { ok, surfaceId, surfaceRef } or { ok: false, err }.
export const openTab = (kind, opts) => adapter({ kind }).openTab(opts || {});

// A small pool so one tick does not spawn 50 processes at once.
export const pool = cmuxAdapter.pool;
