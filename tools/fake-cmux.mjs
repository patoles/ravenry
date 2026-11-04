#!/usr/bin/env node
// A stand-in for the cmux CLI, for test boards (CMUX_BIN=tools/fake-cmux.mjs).
// It answers the reads server/cmux.mjs makes from a fixture file and refuses
// every write, so a test board never reaches the user's real cmux workspaces.
//
// Fixture: $FAKE_CMUX_STATE (JSON), re-read on every call:
//   { "workspaces": [{ "id", "ref", "title", "cwd", "surfaces": [{ "id", "ref", "title" }] }],
//     "screens": { "<surface id>": "<screen text>" },
//     "menus": { "<surface id>": { "after", "frozen", "stuck", "lagKeys" } } }
// A surface listed in "menus" (and only such a surface) plays a Claude Code
// menu on its screen: `send-key up|down` moves the ❯ between the option
// lines, `send-key enter` replaces the screen with "after" (unless "stuck"),
// "frozen" ignores the arrows, "lagKeys" drops that many arrow keys, and
// `send` (typed text, such as a digit) changes nothing, as the folder-trust
// prompt does. Every key and text is appended to "keys" (by surface) and the
// file is written back. `notify` (a Mac notification) is appended to
// <fixture>.notify.log instead of shown, or refused when "notifyFail" is set.
// `new-workspace` is appended to <fixture>.new-workspace.log, then refused.
// `new-surface` (Revive's new tab) is appended to <fixture>.new-surface.log,
// then refused, unless the fixture has "newSurfaces": true: then the tab is
// added to its workspace as a prompt surface (below) with an empty body, so
// the command pasted into it and its Enter land in its "sent".
// A surface listed in "prompts" (and only such a surface) plays Claude
// Code's prompt box under its "body" text: { body, ghost, typed, bash,
// noStyle, sent }. "ghost" is Claude's dim suggested reply, shown while
// nothing is typed. `send` types (a "!" on an empty prompt turns on bash
// mode, as the real one does), `paste-buffer` pastes a `set-buffer` buffer,
// `send-key backspace` deletes (on an empty bash prompt it leaves bash
// mode), `send-key enter` appends what was typed to "sent" and empties the
// prompt. `rpc terminal.replay` returns the box's render grid with the
// suggestion's spans faint, or is refused under "noStyle" (a terminal with
// no styled read).
import fs from 'node:fs';

// --json and --id-format <x> lead some calls (new-surface); they change nothing here.
const args = process.argv.slice(2).filter((a, i, all) => a !== '--json' && a !== '--id-format' && all[i - 1] !== '--id-format');
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
let st = { workspaces: [], screens: {} };
try { st = JSON.parse(fs.readFileSync(process.env.FAKE_CMUX_STATE, 'utf8')); } catch { /* empty */ }
const out = (x) => { process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
const refuse = () => { process.stderr.write(`fake cmux: ${args[0] || '?'} refused\n`); process.exit(1); };

switch (args[0]) {
  case 'tree':
    out({ windows: [{ id: 'win-fake', workspaces: st.workspaces.map((w) => ({
      id: w.id, ref: w.ref, title: w.title, selected: false,
      panes: [{ id: 'pane-' + w.id, surfaces: w.surfaces.map((s) => ({ id: s.id, ref: s.ref, title: s.title || '', type: 'terminal' })) }],
    })) }] });
    break;
  case 'sessions': out({ sessions: [] }); break;
  case 'sidebar-state': {
    const w = st.workspaces.find((x) => x.id === opt('--workspace'));
    out(w ? `cwd=${w.cwd || ''}\nfocused_cwd=${w.cwd || ''}\ngit_branch=none\n` : '');
    break;
  }
  case 'read-screen': {
    if (st.prompts && st.prompts[opt('--surface')]) render(opt('--surface'));
    const t = st.screens[opt('--surface')];
    if (t == null) refuse();
    // Like cmux, the last --lines lines (the text ends with a newline).
    const n = Number(opt('--lines')) || 0;
    const parts = String(t).split('\n');
    const keep = String(t).endsWith('\n') ? n + 1 : n;
    out(n && parts.length > keep ? parts.slice(-keep).join('\n') : t);
    break;
  }
  case 'notify': {
    // A Mac notification (server/desktop.mjs): recorded, never shown.
    // "notifyFail": true in the fixture refuses it, like a cmux that is gone.
    // Appended one JSON line each to <fixture>.notify.log, so two sends at
    // once never lose one (the fixture is rewritten whole).
    if (st.notifyFail) refuse();
    fs.appendFileSync(process.env.FAKE_CMUX_STATE + '.notify.log', JSON.stringify({ title: opt('--title'), body: opt('--body'), workspace: opt('--workspace'), subtitle: opt('--subtitle'), argv: args, envSurface: process.env.CMUX_SURFACE_ID || null, envWorkspace: process.env.CMUX_WORKSPACE_ID || null }) + '\n');
    out('OK\n');
    break;
  }
  case 'new-workspace': {
    // Recorded (one JSON line in <fixture>.new-workspace.log), then refused
    // like every write, so a test can read the command a Revive would run.
    fs.appendFileSync(process.env.FAKE_CMUX_STATE + '.new-workspace.log', JSON.stringify({ argv: args }) + '\n');
    refuse();
    break;
  }
  case 'new-surface': {
    fs.appendFileSync(process.env.FAKE_CMUX_STATE + '.new-surface.log', JSON.stringify({ argv: args }) + '\n');
    const w = st.newSurfaces && st.workspaces.find((x) => x.id === opt('--workspace'));
    if (!w) refuse();
    const n = w.surfaces.length + 1;
    const id = `${String(n).padStart(8, '0')}-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`;
    const ref = `surface:${90 + n}`;
    w.surfaces.push({ id, ref, title: 'zsh' });
    (st.prompts = st.prompts || {})[id] = { body: '' };
    render(id);
    save();
    out({ surface_id: id, surface_ref: ref });
    break;
  }
  case 'surface': if (args[1] === 'resume' && args[2] === 'show') out({ resume_binding: null }); refuse(); break;
  case 'set-buffer': {
    // Kept for a later paste-buffer; it names no surface.
    st.buffers = st.buffers || {};
    st.buffers[opt('--name')] = args[args.length - 1];
    save();
    out('OK\n');
    break;
  }
  case 'paste-buffer': {
    const sf = opt('--surface');
    const pr = st.prompts && st.prompts[sf];
    const b = st.buffers && st.buffers[opt('--name')];
    if (!pr || b == null) refuse();
    pr.typed = (pr.typed || '') + b;
    log(sf, 'paste:' + b);
    render(sf);
    save();
    out('OK\n');
    break;
  }
  case 'rpc': {
    if (args[1] !== 'terminal.replay') refuse();
    let p = {};
    try { p = JSON.parse(args[2] || '{}'); } catch { /* none */ }
    const pr = st.prompts && st.prompts[p.surface_id];
    if (!pr || pr.noStyle) refuse();
    out({ render_grid: grid(pr) });
    break;
  }
  case 'send':
  case 'send-key': {
    const sf = opt('--surface');
    const k = args[args.length - 1];
    const pr = st.prompts && st.prompts[sf];
    if (pr) {
      log(sf, args[0] === 'send' ? 'text:' + k : k);
      if (args[0] === 'send') {
        for (const c of k) {
          if (c === '!' && !pr.typed && !pr.bash) pr.bash = true;
          else pr.typed = (pr.typed || '') + c;
        }
      } else if (k === 'backspace') {
        if (pr.typed) pr.typed = pr.typed.slice(0, -1);
        else pr.bash = false;
      } else if (k === 'enter') {
        (pr.sent = pr.sent || []).push((pr.bash ? '!' : '') + (pr.typed || ''));
        pr.typed = '';
        pr.bash = false;
        pr.ghost = null;
      }
      render(sf);
      save();
      out(`OK ${sf}\n`);
    }
    const m = st.menus && st.menus[sf];
    if (!m) refuse();
    st.keys = st.keys || {};
    (st.keys[sf] = st.keys[sf] || []).push(args[0] === 'send' ? 'text:' + k : k);
    if (args[0] === 'send-key') {
      if ((k === 'up' || k === 'down') && !m.frozen) {
        if (m.lagKeys > 0) m.lagKeys--;
        else st.screens[sf] = moveMarker(st.screens[sf], k === 'down' ? 1 : -1);
      } else if (k === 'enter' && !m.stuck) st.screens[sf] = m.after != null ? m.after : '';
    }
    const tmp = process.env.FAKE_CMUX_STATE + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, process.env.FAKE_CMUX_STATE);
    out(`OK ${sf}\n`);
    break;
  }
  default: refuse();
}

function save() {
  const tmp = process.env.FAKE_CMUX_STATE + '.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, process.env.FAKE_CMUX_STATE);
}
function log(sf, k) { st.keys = st.keys || {}; (st.keys[sf] = st.keys[sf] || []).push(k); }

// A prompt surface's screen: its body, then the box as Claude Code draws it
// (a typed "!" on an empty prompt shows bash mode's "!" marker).
function render(sf) {
  const pr = st.prompts[sf];
  const rule = '─'.repeat(99);
  const line = pr.bash ? '! ' + (pr.typed || '') : '❯ ' + (pr.typed || pr.ghost || '');
  st.screens[sf] = `${pr.body || ''}\n${rule}\n${line}\n${rule}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
}
// The render grid cmux's terminal.replay returns, for the box only: style 0
// plain, style 1 faint (the suggestion).
function grid(pr) {
  const rule = '─'.repeat(99);
  const base = { blink: false, bold: false, inverse: false, italic: false, foreground: '#FFFFFF', background: '#1E1E1E' };
  const spans = [
    { row: 10, column: 0, cell_width: 99, style_id: 0, text: rule },
    { row: 12, column: 0, cell_width: 99, style_id: 0, text: rule },
  ];
  if (pr.bash) spans.push({ row: 11, column: 0, cell_width: 2, style_id: 0, text: '! ' + (pr.typed || '') });
  else if (pr.typed) spans.push({ row: 11, column: 0, cell_width: 2 + pr.typed.length, style_id: 0, text: '❯ ' + pr.typed });
  else {
    spans.push({ row: 11, column: 0, cell_width: 2, style_id: 0, text: '❯ ' });
    if (pr.ghost) spans.push({ row: 11, column: 2, cell_width: pr.ghost.length, style_id: 1, text: pr.ghost });
  }
  return {
    format: 'cmux.render-grid.v1', columns: 99, rows: 14, cursor: { row: 11, column: 2 + (pr.typed || '').length, visible: true },
    styles: [{ id: 0, faint: false, ...base }, { id: 1, faint: true, ...base }], row_spans: spans,
  };
}

// The option lines of the menu at the bottom of a screen ("❯ 1. Yes",
// "  2. No", " ❯ No, exit", "   Yes, I trust this folder") and the ❯ moved
// one up or down, at the same column, stopping at either end.
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
