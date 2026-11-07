#!/usr/bin/env node
// The terminal's keys, typed in the window (real key events through
// Electron, offscreen) into a pane whose program prints every byte it gets:
// each row of the Keys table (apps/desktop/README.md) must arrive as exactly
// its bytes, and no app shortcut may swallow one. macOS's keys on a Mac;
// elsewhere the rows that hold there.
//
// Usage: node build.mjs && node tools/keys-test.mjs [OUT] [--exe APP_EXECUTABLE]
// Needs ravenryd: RAVENRYD, else ../../daemon/ravenryd.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const args = process.argv.slice(2);
const exeAt = args.indexOf('--exe');
const EXE = exeAt >= 0 ? args.splice(exeAt, 2)[1] : null;
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
const OUT = path.resolve(args[0] || path.join(APP, '.tmp', 'keys-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvk-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const mac = process.platform === 'darwin';

// The program in the pane: raw mode (and no Ctrl+O discard or Ctrl+V
// literal: -iexten), every byte as [xx] on a line of its own (perl: bash's
// read gives up on some control bytes).
const echo = path.join(root, 'echo.sh');
fs.writeFileSync(echo, `exec /usr/bin/perl -e 'system("stty raw -echo -iexten"); $|=1; print "READY\\r\\n"; while (sysread(STDIN, my $c, 1)) { printf("[%02x]\\r\\n", ord($c)); }'\n`);

const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
const CSI = '\x1b[';
// [name, keyCode, modifiers, the bytes]
const rows = [
  ...(mac ? [
    ['Cmd+Left: start of the line', 'Left', ['meta'], '\x01'],
    ['Cmd+Right: end of the line', 'Right', ['meta'], '\x05'],
    ['Cmd+Backspace: delete to the line start', 'Backspace', ['meta'], '\x15'],
    ['Option+Left: a word back', 'Left', ['alt'], '\x1bb'],
    ['Option+Right: a word on', 'Right', ['alt'], '\x1bf'],
    ['Option+Backspace: delete a word', 'Backspace', ['alt'], '\x1b\x7f'],
  ] : [
    ['Alt+Left', 'Left', ['alt'], `${CSI}1;3D`],
    ['Alt+Right', 'Right', ['alt'], `${CSI}1;3C`],
  ]),
  ['Ctrl+Left', 'Left', ['control'], `${CSI}1;5D`],
  ['Ctrl+Right', 'Right', ['control'], `${CSI}1;5C`],
  ['Ctrl+Up', 'Up', ['control'], `${CSI}1;5A`],
  ['Ctrl+Down', 'Down', ['control'], `${CSI}1;5B`],
  ['Shift+Left', 'Left', ['shift'], `${CSI}1;2D`],
  ['Shift+Right', 'Right', ['shift'], `${CSI}1;2C`],
  ['Option+Up', 'Up', ['alt'], `${CSI}1;3A`],
  ['Option+Down', 'Down', ['alt'], `${CSI}1;3B`],
  ['Left', 'Left', [], `${CSI}D`],
  ['Home', 'Home', [], `${CSI}H`],
  ['End', 'End', [], `${CSI}F`],
  ['PageUp', 'PageUp', [], `${CSI}5~`],
  ['PageDown', 'PageDown', [], `${CSI}6~`],
  ['Shift+Tab (Claude Code: modes)', 'Tab', ['shift'], `${CSI}Z`],
  ['Shift+Enter (Claude Code, Codex: a newline)', 'Return', ['shift'], '\n'],
  ['Enter', 'Return', [], '\r'],
  ...(mac ? [['Option+Enter (Claude Code: a newline)', 'Return', ['alt'], '\x1b\r']] : []),
  ['Esc (Claude Code: interrupt)', 'Escape', [], '\x1b'],
  ['Ctrl+O (Claude Code: transcript)', 'O', ['control'], '\x0f'],
  ['Ctrl+R (Claude Code: history)', 'R', ['control'], '\x12'],
  ['Ctrl+C', 'C', ['control'], '\x03'],
  ...(mac ? [['Cmd+V: paste', 'V', ['meta'], 'pasted']] : [['Ctrl+Shift+V: paste', 'V', ['control', 'shift'], 'pasted']]),
];

const R = 'window.__ravenry';
const TOKENS = `(${R}.text().match(/\\[[0-9a-f]{2}\\]/g) || []).map((t) => t.slice(1, 3))`;
const steps = [
  { ready: true },
  { until: `${R}.S.tabs.length === 1 && ${R}.term().ready && ${R}.text().includes('READY')`, timeout: 15000 },
  { js: `${R}.term().focus()` },
];
rows.forEach((r, i) => {
  steps.push({ save: { expr: TOKENS, out: path.join(work, `b${i}.json`) } });
  steps.push({ key: r[1], modifiers: r[2], after: 400 });
  steps.push({ save: { expr: TOKENS, out: path.join(work, `a${i}.json`) } });
});
// The window's own: select all, copy (nothing typed), then clear.
const selAll = mac ? { key: 'A', modifiers: ['meta'] } : { key: 'A', modifiers: ['control', 'shift'] };
const copy = mac ? { key: 'C', modifiers: ['meta'] } : { key: 'C', modifiers: ['control', 'shift'] };
steps.push({ save: { expr: TOKENS, out: path.join(work, 'acts0.json') } });
steps.push({ ...selAll, after: 300 }, { save: { expr: `${R}.term().term.hasSelection()`, out: path.join(work, 'selected.json') } });
steps.push({ ...copy, after: 300 }, { save: { expr: TOKENS, out: path.join(work, 'acts1.json') } });
if (mac) steps.push({ key: 'K', modifiers: ['meta'], after: 400 }, { save: { expr: `({ tokens: ${TOKENS}, lines: ${R}.term().term.buffer.active.length, rows: ${R}.term().term.rows, ready: ${R}.text().includes('READY') })`, out: path.join(work, 'cleared.json') } },
  // Cleared in the daemon: another tab and back, and the history stays gone.
  { js: `${R}.onCommand('new-shell')` }, { until: `${R}.S.tabs.length === 2 && ${R}.term().ready`, timeout: 10000 },
  { js: `${R}.setView({ kind: 'tab', id: ${R}.S.tabs[0].id })` }, { until: `${R}.term().ready && ${R}.term().attached.pane === ${R}.S.tabs[0].pane`, timeout: 10000 }, { sleep: 500 },
  { save: { expr: `({ tokens: ${TOKENS}.length, ready: ${R}.text().includes('READY') })`, out: path.join(work, 'back.json') } });
steps.push({ shot: path.join(OUT, 'keys.png') });

const log = path.join(root, 'open.jsonl');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };
try {
  await runApp({
    name: 'keys', work, rt, bin: BIN, home, hubUrl: 'http://127.0.0.1:9', shell: `/bin/bash ${echo}`, steps, ...(EXE ? { exe: EXE } : {}),
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_DESKTOP_DATA: path.join(root, 'data'), RAVENRY_TEST_CLIPBOARD: 'pasted', RAVENRY_OPEN_LOG: log },
  });
  const j = (f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8'));
  rows.forEach((r, i) => {
    const got = j(`a${i}.json`).slice(j(`b${i}.json`).length).join(' ');
    check(`${r[0]}: ${hex(r[3])}`, got === hex(r[3]), `got ${got || 'nothing'}`);
  });
  check(`${mac ? 'Cmd' : 'Ctrl+Shift'}+A selects all, ${mac ? 'Cmd' : 'Ctrl+Shift'}+C copies it, and neither types anything`, j('selected.json') === true && j('acts1.json').length === j('acts0.json').length && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"kind":"copy"'));
  if (mac) {
    const c = j('cleared.json');
    check('Cmd+K clears the scrollback and types nothing', c.tokens.length === 0 && !c.ready && c.lines <= c.rows, JSON.stringify({ lines: c.lines, rows: c.rows, tokens: c.tokens.length }));
    const b = j('back.json');
    check('Cmd+K clears it in the daemon: back from another tab, the history stays gone', b.tokens === 0 && !b.ready, JSON.stringify(b));
  }
} finally {
  stopDaemons(BIN, rt);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
