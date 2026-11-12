#!/usr/bin/env node
// Tabs and splits shared with the Electron app (UPD-016), both ways, on one
// daemon in the Electron app's runtime folder and one data folder, as on a
// Mac where the person switches from one app to the other:
//
//   1. window.json as the Electron app writes it (three shells in an order
//      of the person's, the one in front, a key of its own): the native app
//      opens them as its tabs in that order;
//   2. in the native app, Shell > Split Right (the menu item pressed as a
//      click does) splits the tab in front; quitting, it writes window.json;
//   3. the Electron app (this tree's build, apps/desktop/dist, with
//      Electron from node_modules) opens that file: the same tabs in the
//      same order, the split on the same tab with the same pane beside it
//      on the right, the same tab in front.
//
// Both apps off every screen (the native app's window off every screen,
// the Electron app's offscreen rendering), in a throwaway HOME under /tmp
// (the daemon's socket path must stay under 104 bytes), with a hub URL
// nobody answers, no hub service, no updates.
//
//   node scripts/roundtripcheck.mjs [NATIVE_APP] [OUT]   (default build/RavenryMac.app)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';
import { runApp, stopDaemons } from '../../desktop/tools/run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { app: APP, exe: EXE } = testApp(process.argv[2] || path.join(HERE, '..', 'build', 'RavenryMac.app'));
const RD = path.join(APP, 'Contents', 'MacOS', 'ravenryd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.realpathSync(fs.mkdtempSync('/tmp/rvrt-'));
const OUT = path.resolve(process.argv[3] || path.join(root, 'out'));
fs.mkdirSync(OUT, { recursive: true });
const home = path.join(root, 'h');
const data = path.join(home, 'Library', 'Application Support', 'Ravenry');
const rt = path.join(data, 'run');
const state = path.join(root, 'state');
const work = path.join(root, 'w');
for (const d of [home, rt, state, work]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='~ > '\n");
const file = path.join(data, 'window.json');
const base = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: data };
const results = [];
let failed = 0;
function step(name, ok, detail = {}) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail).slice(0, 900)}`}`);
}
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(150); } }
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const daemon = spawn(RD, ['serve'], { env: base, stdio: ['ignore', 'ignore', fs.openSync(path.join(root, 'daemon.log'), 'w')] });
let sock = null;
let native = null;
try {
  for (let i = 0; !sock; i++) { const f = fs.readdirSync(rt).find((n) => /^ravenryd-.+\.sock$/.test(n)); if (f) sock = path.join(rt, f); else { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); } }
  const rvd = (args) => execFileSync(RD, args, { env: base, encoding: 'utf8' }).trim();
  const panes = ['one', 'two', 'three'].map((nm) => rvd(['new', '--socket', sock, '--name', nm, '--size', '100x30', '--label', 'ravenry.kind=shell', '--', '/bin/zsh']).split(/\s+/)[0]);
  const id = (p) => `s:${p}`;
  // 1. As the Electron app writes it (app.ts save()): the person's order, the tab in front, its own keys.
  const order0 = [id(panes[2]), id(panes[0]), id(panes[1])];
  fs.writeFileSync(file, JSON.stringify({ hintsDone: { 'agent-pane': true, 'needs-you': true, pick: true }, pinned: [], order: order0, splits: [], active: id(panes[0]), panelPref: 'auto', shellsLabelled: true, electronOnly: 'kept' }, null, 2));

  const report = path.join(root, 'report.json');
  native = spawn(EXE, ['--offscreen'], { env: { ...base, RAVENRY_HUB_URL: 'http://127.0.0.1:9', RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_MAC_REPORT: report }, stdio: ['ignore', 'ignore', fs.openSync(path.join(root, 'native.log'), 'w')] });
  const r1 = await until(() => { const r = json(report); return r && r.tabs?.length === 3 ? r : null; }, 30000);
  step('1 the native app opens the Electron app\'s window.json: its three shells as tabs in the person\'s order, the same tab in front', r1 && r1.tabs.map((t) => id(t.host)).join(',') === order0.join(',') && r1.front === panes[0],
    { tabs: r1?.tabs, front: r1?.front, order0 });

  // 2. Shell > Split Right in the native app, then quit.
  fs.writeFileSync(report + '.do', 'menu Shell>Split Right');
  const r2 = await until(() => { const r = json(report); return r && r.tabs?.some((t) => t.host === panes[0] && t.guest) ? r : null; }, 15000);
  const guest = r2?.tabs.find((t) => t.host === panes[0])?.guest || '';
  step('2 Shell > Split Right in the native app splits the tab in front with a new pane', !!r2 && !!guest && !panes.includes(guest), { tabs: r2?.tabs });
  await sleep(1200);
  native.kill('SIGTERM');
  await until(() => native.exitCode !== null || native.signalCode !== null, 10000);
  const w = json(file) || {};
  const sp = (w.splits || [])[0] || {};
  const order2 = [id(panes[2]), id(panes[0]), id(guest), id(panes[1])];
  step('2 quitting, the native app writes window.json: the order with the new pane after its tab, the split as the Electron app writes one, the tab in front, the Electron app\'s own key kept',
    (w.order || []).join(',') === order2.join(',') && sp.host === id(panes[0]) && sp.guest === id(guest) && sp.side === 'right' && w.active === id(panes[0]) && w.electronOnly === 'kept' && !fs.readdirSync(data).some((n) => /^window-.+\.json$/.test(n)),
    { written: w, files: fs.readdirSync(data) });

  // 3. The Electron app opens that file.
  const out = path.join(work, 'electron-state.json');
  await runApp({
    name: 'roundtrip', work, rt, bin: RD, home, hubUrl: 'http://127.0.0.1:9', shell: '/bin/zsh -f', width: 1200, height: 800, hints: true,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_UPDATES: '0', RAVENRY_DESKTOP_DATA: data, RAVENRY_STATE_DIR: state },
    steps: [
      { until: 'document.body.dataset.ready', timeout: 30000 },
      { until: 'window.__ravenry && window.__ravenry.S.tabs.filter((t) => t.kind === "shell").length >= 4', timeout: 20000, soft: true },
      { sleep: 500 },
      { save: { expr: '({ tabs: window.__ravenry.S.tabs.map((t) => ({ id: t.id, kind: t.kind, split: t.split || null })), view: window.__ravenry.S.view })', out } },
    ],
  });
  const e = json(out) || {};
  const tabs = e.tabs || [];
  const host = tabs.find((t) => t.id === id(panes[0])) || {};
  step('3 the Electron app opens the window.json the native app wrote: the same tabs in the same order', tabs.map((t) => t.id).join(',') === order2.join(','), { tabs, want: order2 });
  step('3 ... the split on the same tab, the native app\'s new pane beside it on the right', host.split && host.split.guest === id(guest) && host.split.side === 'right', { host });
  step('3 ... the same tab in front', e.view && e.view.kind === 'tab' && e.view.id === id(panes[0]), { view: e.view });
} catch (err) {
  step('the check ran to its end', false, { error: String(err && err.stack || err) });
} finally {
  if (native && native.exitCode === null) native.kill('SIGKILL');
  daemon.kill();
  stopDaemons(RD, rt);
  fs.writeFileSync(path.join(OUT, 'roundtripcheck.json'), JSON.stringify({ app: APP, at: new Date().toISOString(), failed, steps: results }, null, 2));
  for (const f of ['native.log', 'daemon.log']) { try { fs.copyFileSync(path.join(root, f), path.join(OUT, f)); } catch { /* none */ } }
  try { fs.copyFileSync(file, path.join(OUT, 'window.json')); } catch { /* none */ }
  if (process.argv[3]) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.log(`roundtripcheck: ${root} left`); } }
}
console.log(failed ? `roundtripcheck: ${failed} of ${results.length} steps failed` : `roundtripcheck: all ${results.length} steps pass`);
process.exit(failed ? 1 : 0);
