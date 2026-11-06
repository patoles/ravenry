#!/usr/bin/env node
// A stand-in for iTerm2, for test boards. It plays both programs the iTerm2
// adapter (server/iterm.mjs) runs:
//   ITERM_OSASCRIPT_BIN=tools/fake-iterm.mjs   osascript -e <script> <args>;
//     the operation is the script's first line ("-- ravenry:list", read,
//     write, enter, backspace, focus, open, close).
//   RAVENRY_ITERM_PYTHON=tools/fake-iterm.mjs  python3 -I iterm-keys.py <id> <keys>
// so a test board never reaches the user's real iTerm2.
//
// Fixture: $FAKE_ITERM_STATE (JSON), re-read on every call and written
// back after every write:
//   { "running": true,
//     "sessions": [{ "uuid", "windowId", "tty", "title" }],
//     "screens": { "<UUID>": "<screen text>" },
//     "menus": { "<UUID>": { "after", "frozen", "stuck", "lagKeys" } },
//     "noPython": false }
// Every write is appended to "keys" by session: "text:<text>" (AppleScript
// write text), "osa:enter", "osa:backspace", "py:up", "py:down", "py:enter". A session in
// "menus" plays a Claude Code menu as tools/fake-cmux.mjs does: the arrows
// move the ❯, Enter replaces the screen with "after". "focused", "opened"
// and "closed" record those calls. "noPython": true makes the Python side
// fail as if iTerm2's Python API were off.
import fs from 'node:fs';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const FILE = process.env.FAKE_ITERM_STATE;
let st = { running: true, sessions: [], screens: {} };
try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* empty */ }
st.sessions = st.sessions || [];
st.screens = st.screens || {};
const save = () => { const tmp = FILE + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); };
const done = (out = '') => { process.stdout.write(out); process.exit(0); };
const fail = (msg, n, code = 1) => { process.stderr.write(`0:10: execution error: ${msg} (${n})\n`); process.exit(code); };
const has = (u) => st.sessions.some((s) => s.uuid === u);
const log = (u, k) => { st.keys = st.keys || {}; (st.keys[u] = st.keys[u] || []).push(k); };

function key(u, k) {
  const m = st.menus && st.menus[u];
  if (!m) return;
  if ((k === 'up' || k === 'down') && !m.frozen) {
    if (m.lagKeys > 0) m.lagKeys--;
    else st.screens[u] = moveMarker(st.screens[u], k === 'down' ? 1 : -1);
  } else if (k === 'enter' && !m.stuck) st.screens[u] = m.after != null ? m.after : '';
}

if (argv[1] && argv[1].endsWith('iterm-keys.py')) {
  // The Python API side: arrows (and Enter) for one session.
  if (st.noPython || !st.running) { process.stderr.write('could not reach iTerm2: Connection refused\n'); process.exit(1); }
  const [u, ...keys] = argv.slice(2);
  if (!has(u)) { process.stderr.write(`no iTerm2 session ${u}\n`); process.exit(3); }
  for (const k of keys) { log(u, 'py:' + k); key(u, k); }
  save();
  done();
}

if (argv[1] && argv[1].endsWith('iterm-board-split.py')) {
  // tools/open-in-iterm.mjs through the Python API: the page above a terminal.
  if (st.noPython || !st.running) { process.stderr.write('could not reach iTerm2: Connection refused\n'); process.exit(1); }
  const [u, profile, tag, rows] = argv.slice(2);
  const s = st.sessions.find((x) => x.uuid === u);
  if (!s) { process.stderr.write(`no iTerm2 session ${u}\n`); process.exit(3); }
  const id = crypto.randomUUID().toUpperCase();
  st.sessions.push({ uuid: id, windowId: s.windowId, tab: s.tab, title: '', profile, vars: { 'user.ravenryBoard': tag }, above: true });
  s.rows = Number(rows);
  save();
  done(id + '\n');
}

if (argv[0] !== '-e') fail('fake iTerm2: not a script', -2700);
const op = ((argv[1] || '').match(/^-- ravenry:([\w-]+)/) || [])[1];
const args = argv.slice(2);
if (!st.running && op !== 'board-running' && op !== 'board-find') fail('iTerm2 is not running.', 1000);
const need = (u) => { if (!has(u)) fail('That iTerm2 tab is closed.', 1001); };

switch (op) {
  case 'list':
    done(st.sessions.map((s) => [s.uuid, s.windowId || '1', s.tty || '/dev/ttys999', s.title || ''].join('\t') + '\n').join(''));
    break;
  case 'read': {
    need(args[0]);
    // Like iTerm2: the whole visible screen, rows padded with spaces.
    const t = st.screens[args[0]];
    done(t == null ? '' : String(t).split('\n').map((l) => l + '   ').join('\n') + '\n\n\n');
    break;
  }
  case 'write': need(args[0]); log(args[0], 'text:' + args[1]); save(); done(); break;
  case 'enter': need(args[0]); log(args[0], 'osa:enter'); key(args[0], 'enter'); save(); done(); break;
  case 'backspace': need(args[0]); log(args[0], 'osa:backspace'); save(); done(); break;
  case 'focus': need(args[0]); (st.focused = st.focused || []).push(args[0]); save(); done('ok'); break;
  case 'close': need(args[0]); st.sessions = st.sessions.filter((s) => s.uuid !== args[0]); (st.closed = st.closed || []).push(args[0]); save(); done('ok'); break;
  case 'open': {
    const near = st.sessions.find((s) => s.uuid === args[0]);
    const u = crypto.randomUUID().toUpperCase();
    st.sessions.push({ uuid: u, windowId: near ? near.windowId : '1', tty: '/dev/ttys998', title: '' });
    st.screens[u] = '➜  ~\n';
    (st.opened = st.opened || []).push({ uuid: u, near: args[0] || null, windowId: near ? near.windowId : '1' });
    save();
    done(u + '\n');
    break;
  }
  // tools/open-in-iterm.mjs: sessions carry "vars" ({ "user.ravenryBoard": "<port>:page" }),
  // "profile" (a page session's profile name), "windowId" and "tab".
  case 'board-running': done(st.running ? 'true' : 'false'); break;
  case 'board-find': {
    const want = args[0];
    done(st.sessions.filter((s) => s.vars && [want + ':page', want + ':server'].includes(s.vars['user.ravenryBoard']))
      .map((s) => [s.windowId || '1', s.tab || 1, s.uuid, s.vars['user.ravenryBoard']].join('\t') + '\n').join(''));
    break;
  }
  case 'board-open': {
    const [port, page, cmd] = args;
    if (page && !(st.profiles || []).includes(page)) fail(`Can't find a profile named ${page}.`, 1);
    const w = st.sessions.length ? st.sessions[st.sessions.length - 1].windowId || '1' : '1';
    const tab = Math.max(0, ...st.sessions.filter((s) => (s.windowId || '1') === w).map((s) => s.tab || 1)) + 1;
    let out = '';
    const add = (role, extra) => { const u = crypto.randomUUID().toUpperCase(); st.sessions.push({ uuid: u, windowId: w, tab, tty: '/dev/ttys997', title: role === 'server' ? 'Ravenry' : '', vars: { 'user.ravenryBoard': port + ':' + role }, ...extra }); out += role + '\t' + u + '\n'; return u; };
    if (page) add('page', { profile: page });
    if (cmd) { const u = add('server', {}); log(u, 'text:' + cmd); log(u, 'osa:enter'); }
    (st.boardOpened = st.boardOpened || []).push({ port, page, cmd, windowId: w, tab });
    save();
    done(out);
    break;
  }
  case 'board-split': {
    need(args[0]);
    if (!(st.profiles || []).includes(args[1])) fail(`Can't find a profile named ${args[1]}.`, 1);
    const s = st.sessions.find((x) => x.uuid === args[0]);
    const id = crypto.randomUUID().toUpperCase();
    st.sessions.push({ uuid: id, windowId: s.windowId, tab: s.tab, title: '', profile: args[1], vars: { 'user.ravenryBoard': args[2] }, above: false });
    s.rows = 8;
    save();
    done(id + '\n');
    break;
  }
  case 'board-focus': (st.focused = st.focused || []).push('board:' + args.join('/')); save(); done('ok'); break;
  case 'board-type': need(args[0]); log(args[0], 'text:' + args[1]); log(args[0], 'osa:enter'); save(); done('ok'); break;
  case 'board-close':
    if (!has(args[0])) done('gone');
    st.sessions = st.sessions.filter((s) => s.uuid !== args[0]); (st.closed = st.closed || []).push(args[0]);
    save(); done('ok'); break;
  default: fail(`fake iTerm2: unknown operation ${op}`, -2700);
}

// The ❯ of the menu at the bottom of a screen moved one option up or down
// (the same as tools/fake-cmux.mjs).
function moveMarker(text, dir) {
  const lines = String(text).split('\n');
  const opts = [];
  for (let i = Math.max(0, lines.length - 24); i < lines.length; i++) {
    if (/^\s*(?:❯ | {2})(?:\d+\.\s+\S|Yes\b|No\b)/.test(lines[i])) opts.push(i);
  }
  const cur = opts.findIndex((i) => /^\s*❯ /.test(lines[i]));
  if (cur < 0) return text;
  const next = Math.min(opts.length - 1, Math.max(0, cur + dir));
  if (next === cur) return text;
  const a = opts[cur], b = opts[next];
  const col = lines[a].indexOf('❯');
  lines[a] = lines[a].slice(0, col) + '  ' + lines[a].slice(col + 2);
  lines[b] = lines[b].slice(0, col) + '❯ ' + lines[b].slice(col + 2);
  return lines.join('\n');
}
