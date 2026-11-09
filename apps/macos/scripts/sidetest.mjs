#!/usr/bin/env node
// The sidebar's and the panel's self-test (SelfTestBoard.swift), never on
// screen and never on the person's hub or daemon: a throwaway ravenryd
// (HOME, runtime and state folders in the repository's .tmp), the demo hub
// of the desktop's screenshots (apps/desktop/tools/demo-hub.mjs: five
// made-up projects, a fake cmux that refuses every write), then the app
// with its window off every screen on both (RAVENRY_HUB_URL). It adds the
// two arrivals the app waits on, prints a line a check, and leaves the
// pictures in OUT.
//
//   node scripts/sidetest.mjs [OUT]      (after scripts/build.sh)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const APP = process.env.SIDETEST_APP || path.join(MAC, 'build', 'RavenryMac.app');
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'macos-sidetest.'));
const OUT = path.resolve(process.argv[2] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state');
for (const d of [user, run, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
fs.writeFileSync(path.join(user, '.zshenv'), 'skip_global_compinit=1\n');
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: path.join(tmp, 'desktop') };

const daemon = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
const sock = path.join(run, 'ravenryd-0.0.0-dev.sock');
for (let i = 0; !fs.existsSync(sock); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }

const port = 47700 + Math.floor(Math.random() * 200);
const hub = await startDemoHub({ dir: path.join(tmp, 'hub'), port, extra: [{ id: 'old-notes', name: 'old-notes' }] });
const result = path.join(OUT, 'sidetest.json');
for (const f of [result, ...[1, 2].flatMap((n) => [`${result}.arrive-${n}`, `${result}.go-${n}`])]) fs.rmSync(f, { force: true });
const app = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen', '--socket', sock, '--sidetest', result], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log') },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const arrivals = [['paper-boat', 'Tilt the hull with the slope too, or keep it level?'], ['notes-app', 'The settings screen is done. Ship the beta to the testers?']];
const t0 = Date.now();
let n = 1;
while (!exited && Date.now() - t0 < 240000) {
  if (n <= 2 && fs.existsSync(`${result}.arrive-${n}`)) {
    await hub.arrive(...arrivals[n - 1]);
    fs.writeFileSync(`${result}.go-${n}`, '1');
    n++;
  }
  await sleep(50);
}
if (!exited) app.kill();
hub.stop();
daemon.kill();
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`sidetest: no result; see ${path.join(tmp, 'app.log')}`); process.exit(1); }
// The layout file is kept by daemon: this test's daemon is not the Electron
// app's, so the window writes window-<daemon>.json, never window.json.
const files = fs.existsSync(env.RAVENRY_DESKTOP_DATA) ? fs.readdirSync(env.RAVENRY_DESKTOP_DATA) : [];
r.checks.push({ name: 'layout_file_by_daemon', ok: files.some((f) => /^window-[0-9a-f]{12}\.json$/.test(f)) && !files.includes('window.json'), detail: files.join(', ') });
r.failed += r.checks[r.checks.length - 1].ok ? 0 : 1;
for (const c of r.checks) console.log(`${c.ok ? 'pass' : 'FAIL'} ${c.name}${c.detail ? ': ' + String(c.detail).replace(/\n/g, '\\n') : ''}`);
console.log(`sidetest: ${r.checks.length} checks, ${r.failed} failed; pictures in ${OUT}`);
process.exit(r.failed ? 1 : 0);
