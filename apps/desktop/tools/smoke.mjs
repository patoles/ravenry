#!/usr/bin/env node
// The app end to end, offscreen (CI runs it on Linux under xvfb): it finds
// no daemon and starts one, shows the first launch with no board running,
// opens a real shell, types, pastes, checks the pane's size, opens a second
// shell and switches back (a fresh snapshot brings the first one's screen
// back), and closes a tab, which ends its pane in the daemon.
//
//   node build.mjs && RAVENRYD=../../daemon/ravenryd node tools/smoke.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP, runApp, stopDaemons } from './run-app.mjs';

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'smoke'));
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}`); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
const WORK = path.join(OUT, '.work');
const HOME = path.join(WORK, 'home');
fs.mkdirSync(HOME, { recursive: true });
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvk-'));
fs.chmodSync(RT, 0o700);

const R = 'window.__ravenry';
const has = (s) => `${R}.text().includes(${JSON.stringify(s)})`;
const attachedTo = (i) => `${R}.term().ready && ${R}.term().attached.pane === ${R}.S.tabs[${i}].pane`;
// bash without its startup files: the same on a Mac and on Linux.
const shell = fs.existsSync('/bin/bash') ? '/bin/bash --noprofile --norc' : '/bin/sh';
const steps = [
  { ready: true },
  // No board: the first launch shows, and a plain shell works anyway.
  { until: `${R}.S.hubStatus && !${R}.S.hubStatus.reachable && !document.getElementById('start').hidden` },
  { shot: path.join(OUT, 'smoke-first.png') },
  { js: `${R}.newShell()` },
  { until: `${attachedTo(0)} && ${has('$ ')}`, timeout: 20000 },
  { type: 'echo smoke-$((40+2))\r' },
  { until: has('smoke-42') },
  // A paste goes to the daemon as one paste.
  { js: `(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'echo pasted-$((1+1))'); document.querySelector('#term textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()` },
  { sleep: 300 },
  { key: 'Return', char: '\r' },
  { until: has('pasted-2') },
  // The pane has the terminal's size.
  { type: 'stty size\r' },
  { until: `${R}.text().includes(${R}.term().term.rows + ' ' + ${R}.term().term.cols)` },
  // A second shell, then back: the first comes back from a snapshot.
  // Keys typed at once, while the new shell is still being attached, are kept.
  { js: `${R}.newShell()` },
  { until: `${R}.S.tabs.length === 2` },
  { type: 'echo second-tab\r', after: 0 },
  { until: `${attachedTo(1)} && ${has('second-tab')} && !${has('smoke-42')}`, timeout: 20000 },
  { js: `${R}.onCommand('next-tab', 1)` },
  { until: `${attachedTo(0)} && ${has('smoke-42')} && ${has('pasted-2')}` },
  { shot: path.join(OUT, 'smoke-shell.png') },
  { save: { expr: `({ tabs: ${R}.S.tabs.map((t) => t.pane), renderer: ${R}.term().renderer, cols: ${R}.term().term.cols, rows: ${R}.term().term.rows })`, out: path.join(WORK, 'before-close.json') } },
  // Closing the tab ends its pane.
  { js: `${R}.onCommand('close-tab')` },
  { until: `${R}.S.tabs.length === 1 && ${attachedTo(0)}` },
  { sleep: 500 },
];

let failed = false;
try {
  await runApp({ name: 'smoke', work: WORK, rt: RT, bin: BIN, home: HOME, hubUrl: 'http://127.0.0.1:9', steps, shell, width: 1200, height: 760, env: { PS1: '$ ' } });
  const before = JSON.parse(fs.readFileSync(path.join(WORK, 'before-close.json'), 'utf8'));
  const ls = JSON.parse(execFileSync(BIN, ['ls', '--all', '--json', '--no-start'], { env: { ...process.env, RAVENRY_RUNTIME_DIR: RT }, encoding: 'utf8' }));
  const ids = (Array.isArray(ls) ? ls : ls.panes || []).map((p) => p.id);
  if (ids.includes(before.tabs[0])) throw new Error(`the closed tab's pane ${before.tabs[0]} is still in the daemon: ${ids}`);
  if (!ids.includes(before.tabs[1])) throw new Error(`the open tab's pane ${before.tabs[1]} is gone: ${ids}`);
  console.log(`smoke: ok (renderer ${before.renderer}, ${before.cols}x${before.rows}, panes left ${ids.length})`);
} catch (e) {
  failed = true;
  console.error('smoke: FAILED\n' + (e.stack || e));
} finally {
  stopDaemons(BIN, RT);
  fs.rmSync(RT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
