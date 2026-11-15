// Starting an assistant in a NEW tab without typing into a shell that may
// not be ready (2026-11-15: oh-my-zsh asked "Would you like to update?
// [Y/n]" while a hand-off typed its command, and ate it). Every place the
// board opens a tab for an assistant goes through startInTab():
//
// 1. Where the terminal can open a tab with a program (a Ravenry pane, a
//    Rex window, an iTerm2 tab), the assistant IS the tab's program: its
//    absolute path, with the PATH the session it follows ran with
//    (server/sessionenv.mjs), started by a small zsh that reads no startup
//    file (`zsh -f`), so nothing the person's shell asks at startup ever
//    sees it. When the assistant exits, that zsh becomes the person's
//    login shell in the same folder (`exec -l $SHELL`), as a tab opened by
//    hand would be. In a Ravenry pane the shell keeps Ravenry's shell
//    integration: ravenryd injects it for a zsh program, and the wrapper
//    gives the assistant the person's own ZDOTDIR back, as the
//    integration's .zshenv does.
// 2. Where it cannot (cmux, whose CLI only types a command; a pane on
//    another machine, whose assistant the board cannot find), the tab opens
//    with its shell and the command is typed only once the screen shows a
//    quiet prompt. A screen that asks something ([Y/n], (y/n), a line
//    ending in "?") is never answered and nothing is typed: the caller says
//    so, with the command to copy.
//
// The caller confirms the start where it matters (the hand-off,
// server/index.mjs confirmStarts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------ the command

// A launch command as words, when it is plain words (`claude`,
// `codex -m gpt-5`, `/path/to/claude --model x`); null for anything a shell
// would read differently (quotes, $, ;, |, an alias the board cannot see
// is still a word, and is caught when it is not found).
const SAFE_WORD = /^[A-Za-z0-9_./:=@%+,~-]+$/;
export function words(command, home = os.homedir()) {
  const ws = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (!ws.length || !ws.every((w) => SAFE_WORD.test(w))) return null;
  if (ws[0] === '~' || ws[0].startsWith('~/')) ws[0] = path.join(home, ws[0].slice(1));
  return ws;
}

// A shell word: single quotes, a quote inside closed, escaped and reopened.
export const shellWord = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The line a person would type for it (and copies from a failed start):
// `cd '<cwd>' && <command> '<arg>' ...`. An option, `--` or a session id
// stays bare (`claude --resume <id>`, `codex -- '<words>'`); any other word
// is one quoted shell word.
const BARE = /^(--?[A-Za-z0-9][\w.-]*|--|[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}|resume)$/;
export function typedLine({ cwd = null, command, args = [] }) {
  const line = [String(command).trim(), ...args.map((a) => (BARE.test(String(a)) ? String(a) : shellWord(a)))].join(' ');
  return cwd ? `cd ${shellWord(cwd)} && ${line}` : line;
}

// The shims a cmux tab puts first on its PATH start a wrapper that needs
// cmux around it: never the program of a tab elsewhere, and left off its PATH.
const isShimDir = (d) => /\/cmux-cli-shims(\/|$)/.test(d) || /\/Contents\/Resources\/bin\/?$/.test(d);
export function cleanPath(p) {
  const seen = new Set();
  const out = [];
  for (const d of String(p || '').split(':')) {
    if (!d || !path.isAbsolute(d) || isShimDir(d) || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(':');
}

const runnable = (f, has) => { try { return has(f); } catch { return false; } };
const isExec = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };

// The program and the PATH it runs with: `paths` are PATHs to look in, in
// order (the session's own, the newest of its assistant, the board's); the
// first that holds the command's first word wins. { argv, path, from } or
// null (not plain words, or found nowhere).
export function program({ command, args = [], paths = [], has = isExec, home = os.homedir() }) {
  const ws = words(command, home);
  if (!ws) return null;
  const [first, ...rest] = ws;
  if (path.isAbsolute(first)) {
    if (!runnable(first, has)) return null;
    const p = paths.map((x) => cleanPath(x && x.path)).find(Boolean) || '';
    return { argv: [first, ...rest, ...args], path: p, from: 'absolute' };
  }
  if (first.includes('/')) return null;
  for (const c of paths) {
    const p = cleanPath(c && c.path);
    if (!p) continue;
    const dir = p.split(':').find((d) => runnable(path.join(d, first), has));
    if (dir) return { argv: [path.join(dir, first), ...rest, ...args], path: p, from: c.from || 'path' };
  }
  return null;
}

// The small zsh that runs the assistant, then the login shell. Its
// positional words: the folder, the PATH for the assistant, the shell to
// fall back on when SHELL is unset, then the assistant's argv. No single
// quote in it, so it stays one word in any quoting.
export const WRAP_NAME = 'ravenry-start';
const OWN_ZDOTDIR = '{ if [[ -n ${RAVENRY_ZSH_ZDOTDIR+X} ]]; then export ZDOTDIR=$RAVENRY_ZSH_ZDOTDIR; else unset ZDOTDIR; fi; unset RAVENRY_ZSH_ZDOTDIR; }';
const INTEGRATED = '[[ -r ${ZDOTDIR-}/ravenry-integration.zsh ]]';
export const WRAP_SCRIPT = [
  'cd -- "$1" 2>/dev/null',
  'p=$2; s=${SHELL:-$3}; shift 3',
  '[[ -n $s ]] || s=/bin/zsh',
  'trap : INT QUIT',
  `( ${INTEGRATED} && ${OWN_ZDOTDIR}; [[ -n $p ]] && export PATH=$p; exec "$@" )`,
  'trap - INT QUIT',
  `[[ \${s:t} == zsh ]] || { ${INTEGRATED} && ${OWN_ZDOTDIR}; }`,
  'exec -l $s',
].join('; ');
export const ZSH = '/bin/zsh';

export function loginShell() {
  try { const s = os.userInfo().shell; if (s && path.isAbsolute(s)) return s; } catch { /* below */ }
  return process.env.SHELL || '/bin/zsh';
}

// The tab's program: [zsh, -f, -c, script, name, cwd, PATH, shell, ...argv].
export function wrapped({ argv, path: p = '', cwd = '', shell = loginShell() }) {
  return [ZSH, '-f', '-c', WRAP_SCRIPT, WRAP_NAME, cwd || '', p || '', shell || '', ...argv];
}

// The same as one command line, for a terminal that takes a string (iTerm2).
export const asLine = (argv) => argv.map(shellWord).join(' ');

// The assistant's own argv inside a wrapped command, or null (the Mac app
// shows it in place of the wrapper, Panel.swift).
export function unwrap(command) {
  if (!Array.isArray(command) || command[0] !== ZSH || command[3] !== WRAP_SCRIPT || command[4] !== WRAP_NAME) return null;
  return command.slice(8);
}

// ------------------------------------------------------------ the screen

// The question a screen ends on, or null: its last line asks for a y or n
// ([Y/n], [y/N], (y/n), [yes/no]), or ends in "?" (compinit's "Ignore
// insecure directories and continue [y] or abort compinit [n]?").
const ASKS = [/[[(]\s*(y|yes)\s*\/\s*(n|no)\s*[\])]\s*[:?]?\s*$/i, /\?\s*$/];
export function questionOf(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return ASKS.some((re) => re.test(last)) ? last.trim().slice(0, 200) : null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for a quiet prompt: the screen shows something and has not changed
// for `quietMs`. { ok: true } then; { ok: false, question } when the quiet
// screen asks something; { ok: false, question: null } when nothing quiet
// came within `limitMs`.
export async function waitReady(read, { limitMs = 15000, quietMs = 700, everyMs = 150, sleep = pause, now = Date.now } = {}) {
  const t0 = now();
  let last = null;
  let since = t0;
  for (;;) {
    let text = '';
    try { text = String((await read(40)) || '').replace(/\s+$/, ''); } catch { text = ''; }
    if (text !== last) { last = text; since = now(); }
    const q = text ? questionOf(text) : null;
    if (text && now() - since >= quietMs) return q ? { ok: false, question: q, screen: text } : { ok: true, screen: text };
    if (now() - t0 >= limitMs) return { ok: false, question: q, screen: text };
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------ the tab

// Opens a NEW tab of `kind` for an assistant and starts it there.
// t: the terminal interface (server/terminal.mjs: openTab, readScreen,
// pasteText, pressKey, startsCommand). open: the adapter's openTab options
// (near, session, label, workspaceId, paneId, machine). command: the launch
// command as set (`claude`, a path, with options); args: its words after
// (the prompt, `--resume <id>`); paths: where to find it (program()).
// Returns { ok, surfaceId, surfaceRef, how: 'program' | 'typed', command }
// or { ok: false, err, question, command, surfaceId? } (surfaceId when a
// tab opened and nothing was typed into it).
// typeCd false: a terminal that opens the tab in `cwd` itself (cmux) gets
// the command without the `cd`.
export async function startInTab(t, { kind, open = {}, cwd = null, command, args = [], paths = [], limitMs = 15000, typeCd = true }) {
  const line = typedLine({ cwd: typeCd ? cwd : null, command, args });
  const prog = t.startsCommand(kind) && !open.machine ? program({ command, args, paths }) : null;
  if (prog) {
    const made = await t.openTab(kind, { ...open, cwd, command: wrapped({ argv: prog.argv, path: prog.path, cwd }) });
    if (made.ok) return { ...made, ok: true, how: 'program', command: line, argv: prog.argv };
    console.error(`launch: ${kind} did not open a tab with the program (${made.err || 'no answer'}); opening one to type into`);
  }
  const made = await t.openTab(kind, { ...open, cwd });
  if (!made.ok) return { ok: false, err: made.err || 'no answer', command: line };
  const tab = { kind, surfaceId: made.surfaceId, ...(open.workspaceId ? { workspaceId: open.workspaceId } : {}) };
  const r = await typeWhenReady(t, tab, line, { limitMs });
  if (!r.ok) return { ...r, opened: true, surfaceId: made.surfaceId, surfaceRef: made.surfaceRef, machine: made.machine };
  return { ...made, ok: true, how: 'typed', command: line };
}

// Types `line` and Enter into a tab that runs a shell, once its screen shows
// a quiet prompt; never into a screen that asks something. { ok } or
// { ok: false, err, question, command }.
export async function typeWhenReady(t, tab, line, { limitMs = 15000 } = {}) {
  const r = await waitReady((n) => t.readScreen(tab, n), { limitMs });
  if (!r.ok) {
    return { ok: false, question: r.question, command: line,
      err: r.question ? `the terminal was asking something ("${r.question}"), so nothing was typed` : `the terminal showed no prompt within ${Math.round(limitMs / 1000)} s, so nothing was typed` };
  }
  const a = await t.pasteText(tab, line);
  const b = a.ok ? await t.pressKey(tab, 'enter') : a;
  if (!b.ok) return { ok: false, command: line, err: 'the new tab opened but the command was not typed: ' + (b.err || '') };
  return { ok: true, command: line };
}
