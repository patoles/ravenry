#!/usr/bin/env node
// A stand-in for Rex's `rex` command, for test boards
// (RAVENRY_REX_BIN=tools/fake-rex.mjs), so no test reaches the user's real
// Rex. It answers the calls server/rex.mjs makes, with the shapes Rex Beta
// 0.1.0 (1829), API revision 11, printed:
//   whoami --json, ls --json, window ls -s S --json, block call -b B title,
//   block inspect B --json, capture -b B --trim, send -b B -- TEXT,
//   send-key -b B KEY, focus -s S TARGET, client ls --json,
//   -C CLIENT do session.select session_id=S window_id=W,
//   window new -s S LABEL -c DIR --focus=false --json, new LABEL -c DIR --json,
//   block close B, events (ends at once).
//
// Fixture: $FAKE_REX_STATE (JSON), re-read on every call and written back
// after every change:
//   { "running": true, "apiRevision": 11,
//     "sessions": [{ "id": "session:<uuid>", "label",
//                    "windows": [{ "id": "window:<uuid>", "label", "blocks": ["block:<uuid>"] }] }],
//     "blocks": { "block:<uuid>": { "title", "screen" } },
//     "menus": { "block:<uuid>": { "after", "frozen", "stuck" } },
//     "app": true, "remoteControl": false }
// Every call's argv is appended, one JSON line each, to $FAKE_REX_STATE.calls,
// and only a write saves the fixture, so a tick's listing running beside a
// write never undoes it. Writes are appended to "keys"
// by block: "text:<text>", "key:<name>". A block in "menus" plays a Claude
// Code menu as tools/fake-cmux.mjs does: the arrows move the ❯, Enter
// replaces the screen with "after". "focused", "selected", "opened"
// (window new), "created" (new) and "closed" record those calls.
// $FAKE_REX_PS (optional, a tools/stub-ps.mjs state file): closing a block
// also ends the processes whose env names it, as closing a real pane does.
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = process.env.FAKE_REX_STATE;
let st = {};
try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* empty */ }
st.sessions = st.sessions || [];
st.blocks = st.blocks || {};
if (st.running == null) st.running = true;
const save = () => { const tmp = FILE + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); };
const out = (x) => { process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n'); };
const fail = (msg, code) => { process.stderr.write(`Error: ${msg}\n`); process.exit(code); };
const id = (kind) => `${kind}:${crypto.randomUUID()}`;

// Global flags, then the command words.
const argv = process.argv.slice(2);
fs.appendFileSync(FILE + '.calls', JSON.stringify(argv) + '\n');
let client = null;
const words = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { opts['--'] = argv.slice(i + 1); break; }
  if (a === '-C') { client = argv[++i]; continue; }
  if (a === '-s' || a === '-b' || a === '-c' || a === '-w' || a === '-S' || a === '--timeout') { opts[a] = argv[++i]; continue; }
  if (a.startsWith('--')) { const [k, v] = a.split('='); opts[k] = v == null ? true : v; continue; }
  words.push(a);
}
const cmd = words[0] === 'do' && words[1] === 'session.select' ? 'do-session-select' : words.join(' ');
if (!st.running) { fail('no Rex server is running at /fake/rex/server.sock, and autostart is disabled', 4); }

const sessionOf = (b) => st.sessions.find((s) => s.windows.some((w) => w.blocks.includes(b)));
const windowOf = (b) => { const s = sessionOf(b); return s && s.windows.find((w) => w.blocks.includes(b)); };
const needBlock = (b) => { if (!b || !st.blocks[b] || !sessionOf(b)) { fail(`block target "${b}" not found: no block matches`, 3); } return b; };
const needSession = (sid) => { const s = st.sessions.find((x) => x.id === sid); if (!s) { fail(`session target "${sid}" not found`, 3); } return s; };
const log = (b, k) => { st.keys = st.keys || {}; (st.keys[b] = st.keys[b] || []).push(k); };
const newBlock = (cwd) => { const b = id('block'); st.blocks[b] = { title: '', screen: `➜  ${cwd || '~'}\n`, cwd: cwd || null }; return b; };

function key(b, k) {
  const m = st.menus && st.menus[b];
  if (!m) return;
  if ((k === 'up' || k === 'down') && !m.frozen) st.blocks[b].screen = moveMarker(st.blocks[b].screen, k === 'down' ? 1 : -1);
  else if (k === 'enter' && !m.stuck) st.blocks[b].screen = m.after != null ? m.after : '';
}

switch (cmd) {
  case 'whoami':
    out({ rex_version: st.version || '0.0.1-fake', api_revision: st.apiRevision ?? 11, session_count: st.sessions.length });
    break;
  case 'ls':
    out({ sessions: st.sessions.map((s) => ({ session_id: s.id, label: s.label })) });
    break;
  case 'window ls': {
    const s = needSession(opts['-s']);
    out({
      revision: 1, session_id: s.id, label: s.label, active_window_id: (s.windows[0] || {}).id,
      windows: s.windows.map((w) => ({
        window_id: w.id, label: w.label, focused_block_id: w.blocks[0],
        layers: [{ layer_id: 'layer:1', kind: 'tiled', blocks: w.blocks.map((b) => ({ block_id: b, label: 'shell', creator_name: 'com.superlogical.terminal', flavor: 'com.superlogical.terminal.shell' })) }],
      })),
    });
    break;
  }
  case 'block call title': {
    const b = needBlock(opts['-b']);
    out(JSON.stringify({ title: st.blocks[b].title || '', owner: { pid: 1, name: 'zsh' } }) + '\n');
    break;
  }
  case 'capture': {
    const b = needBlock(opts['-b']);
    // Like Rex: the scrollback and screen, trailing blank lines dropped with --trim.
    const t = String(st.blocks[b].screen || '');
    out(opts['--trim'] ? t.replace(/\n+$/, '') + '\n' : t + '\n\n\n');
    break;
  }
  case 'send': {
    const b = needBlock(opts['-b']);
    const text = opts['--'] ? opts['--'].join(' ') : words.slice(1).join(' ');
    log(b, 'text:' + text);
    break;
  }
  case 'client ls':
    out({ clients: st.app === false ? [] : [{ client_id: 'client:fake-app', info: { kind: 'app', platform: 'macos', name: 'Rex Beta', version: '0.1.0 (fake)' }, connection_state: 'connected' }] });
    break;
  case 'do-session-select': {
    if (client !== 'client:fake-app') { fail(`client target "${client}" not found`, 3); }
    // How the fake refuses with Remote Control off; the real refusal's words
    // were not measured (the board passes Rex's own words on, below its own).
    if (!st.remoteControl) { fail('the client refused the action: Remote Control is off in its settings', 1); }
    const kv = Object.fromEntries(words.slice(2).map((w) => w.split('=')));
    (st.selected = st.selected || []).push({ client, ...kv });
    break;
  }
  default:
    if (words[0] === 'focus') {
      const s = needSession(opts['-s']);
      (st.focused = st.focused || []).push({ session: s.id, target: words[1] });
      break;
    }
    if (words[0] === 'block' && words[1] === 'inspect') {
      const b = needBlock(words[2]);
      out({ session_id: sessionOf(b).id, block: { block_id: b, window_id: windowOf(b).id, label: 'shell' } });
      break;
    }
    if (words[0] === 'block' && words[1] === 'close') {
    const b = needBlock(words[2]);
    for (const s of st.sessions) for (const w of s.windows) w.blocks = w.blocks.filter((x) => x !== b);
    for (const s of st.sessions) s.windows = s.windows.filter((w) => w.blocks.length);
    delete st.blocks[b];
    (st.closed = st.closed || []).push(b);
    if (process.env.FAKE_REX_PS) {
      try {
        const procs = JSON.parse(fs.readFileSync(process.env.FAKE_REX_PS, 'utf8'));
        fs.writeFileSync(process.env.FAKE_REX_PS, JSON.stringify(procs.filter((p) => !String(p.env || '').includes('REX_BLOCK=' + b))));
      } catch { /* none */ }
    }
    break;
    }
    if (cmd.startsWith('send-key')) {
      const b = needBlock(opts['-b']);
      for (const k of words.slice(1)) { log(b, 'key:' + k); key(b, k); }
      break;
    }
    if (cmd.startsWith('window new')) {
      const s = needSession(opts['-s']);
      const b = newBlock(opts['-c']);
      const w = { id: id('window'), label: words[2] || 'Window', blocks: [b] };
      s.windows.push(w);
      (st.opened = st.opened || []).push({ session: s.id, label: words[2] || null, cwd: opts['-c'] || null, focus: opts['--focus'] ?? null, block: b });
      out({ window_id: w.id, block_ids: [b], revision: 2 });
      break;
    }
    if (words[0] === 'new') {
      const b = newBlock(opts['-c']);
      const s = { id: id('session'), label: words[1] || 'Session', windows: [{ id: id('window'), label: 'Window', blocks: [b] }] };
      st.sessions.push(s);
      (st.created = st.created || []).push({ session: s.id, label: words[1] || null, cwd: opts['-c'] || null, block: b });
      out({ session_id: s.id, initial_windows: [{ window_id: s.windows[0].id, block_ids: [b], revision: 1 }] });
      break;
    }
    if (words[0] === 'events') break;
    fail(`fake rex: unknown command "${cmd}"`, 2);
}
if (/^(send|send-key|focus|do-session-select|block close|window new|new)( |$)/.test(cmd)) save();

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
