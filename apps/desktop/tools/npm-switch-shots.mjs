#!/usr/bin/env node
// Pictures of the switch from the npm board, as the packaged app draws
// them, dark and light, at 1440 x 900, to hold against the mock: the offer
// in the first-launch place, the steps under way, the end with what the
// app's hub shows, the quiet bar after Not now, the way back's question and
// the bar after it. macOS only (the npm board is). Each theme gets its own
// throwaway HOME with data the npm board 0.4.0 wrote (npm-board-fixture.mjs),
// its board started by hand as most people start it; offscreen, on spare
// ports, with tools/fake-launchctl.mjs in place of launchd.
//
//   node tools/npm-switch-shots.mjs APP [OUT]
//
// Every picture is of the real state but one: the steps under way are the
// finished switch's steps drawn again with the hub still starting
// (window.__ravenryNpm.preview), as the real ones pass in a second.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNpmUser, stopBoard } from './npm-board-fixture.mjs';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
if (process.platform !== 'darwin') { console.log('npm-switch-shots: the npm board runs on macOS only'); process.exit(0); }
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!pos[0]) { console.error('usage: npm-switch-shots.mjs APP [OUT]'); process.exit(2); }
const EXE = path.join(path.resolve(pos[0]), 'Contents', 'MacOS', 'Ravenry');
const OUT = path.resolve(pos[1] || path.join(os.tmpdir(), 'ravenry-npm-switch-shots'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const PKG_DIR = path.join(os.tmpdir(), 'ravenry-npm-0.4.0');
const R = 'window.__ravenryNpm';
const view = (cond) => `${R} && ${R}.view() && (${cond})`;
// The sidebar has the person's session before a picture is taken.
const sidebar = { until: `document.querySelector('#side .grp .ss, #side .grp .idl')`, timeout: 20000 };

async function run(u, theme, name, steps) {
  const rt = path.join(u.root, 'rt');
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(u.root, 'app-run'), { recursive: true });
  try {
    await runApp({
      name: `${theme}-${name}`, work: path.join(u.root, 'app-run'), rt, home: u.home, exe: EXE, hubUrl: u.url, steps, shell: '', width: 1440, height: 900,
      env: { ...u.env, RAVENRY_THEME: theme, RAVENRY_SERVICE: 'install', RAVENRY_DESKTOP_DATA: u.appData, RAVENRY_STATE_DIR: path.join(u.root, 'state'), RAVENRY_UPDATES: '0', SHELL: '/bin/zsh' },
      timeoutMs: 180000,
    });
  } finally { stopDaemons(path.join(u.appData, 'bin', 'ravenryd'), rt); }
}

const shot = (theme, n, what) => ({ shot: path.join(OUT, `${theme}-${n}-${what}.png`) });
for (const theme of ['dark', 'light']) {
  const root = path.join(OUT, `home-${theme}`);
  fs.mkdirSync(root, { recursive: true });
  const u = await makeNpmUser(root, { pkgDir: PKG_DIR, login: false, log: (s) => console.log(`${theme}: ${s}`) });
  u.root = root;
  u.appData = path.join(root, 'app-data');
  try {
    await run(u, theme, 'offer', [
      { ready: true, timeout: 30000 }, sidebar,
      { until: `!document.getElementById('start').hidden && document.querySelector('#start .sw [data-act=switch]')`, timeout: 30000 },
      shot(theme, 1, 'offer'),
      { js: `${R}.notNow()` },
      { until: `document.querySelector('#npm-bar:not([hidden])')`, timeout: 10000 },
      { js: `window.__ravenry.setView({ kind: 'none' })` }, { sleep: 400 },
      shot(theme, 4, 'not-now-bar'),
    ]);
    await run(u, theme, 'switch', [
      { ready: true, timeout: 30000 }, sidebar,
      { until: `document.querySelector('#npm-bar:not([hidden]) [data-act=switch]')`, timeout: 10000 },
      { js: `document.querySelector('#npm-bar [data-act=switch]').click()` },
      { until: view(`${R}.view().phase === 'switched' && ${R}.view().counts`), timeout: 120000 },
      sidebar, { sleep: 600 },
      shot(theme, 3, 'done'),
      { js: `(() => { const v = JSON.parse(JSON.stringify(${R}.view())); v.phase = 'switching'; v.counts = null; v.steps = v.steps.map((s) => (s.id === 'hub' ? { ...s, done: false } : s)); ${R}.preview(v); })()` },
      { sleep: 300 },
      shot(theme, 2, 'switching'),
    ]);
    await run(u, theme, 'back', [
      { ready: true, timeout: 30000 }, sidebar,
      { until: view(`${R}.view().detect && ${R}.view().detect.record && ${R}.view().detect.record.state === 'switched'`), timeout: 30000 },
      { js: `${R}.confirmBack(true)` },
      { until: `document.querySelector('#npm-switch:not([hidden]) [data-act=back]')`, timeout: 10000 },
      shot(theme, 5, 'confirm-back'),
      { js: `${R}.back()` },
      { until: view(`${R}.view().phase === 'back'`), timeout: 120000 },
      { until: `document.querySelector('#npm-bar:not([hidden]) .code1')`, timeout: 10000 },
      { sleep: 400 },
      shot(theme, 6, 'back-bar'),
    ]);
  } finally {
    stopBoard(u.home);
  }
}
console.log(`npm-switch-shots: ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} pictures in ${OUT}`);
