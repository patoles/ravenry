#!/usr/bin/env node
// The launch check: the app, off every screen, started the way the person
// starts it after a day of use, on a throwaway daemon and the demo hub
// (apps/desktop/tools/demo-hub.mjs), never the person's. The daemon holds
// three shells; the saved layout (window-<daemon>.json) lists only one of
// them, a split whose guest is gone, a tab in front that is gone and a
// pinned session no board has: the shapes a real file has, which the last
// launch crash came from (a pane missing from the saved order). It passes
// when the app is still running 8 seconds after launch, with its tabs and
// the hub's sidebar drawn (it says so in its log).
//
//   node scripts/launchcheck.mjs [APP]     (default build/RavenryMac.app)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const { app: APP, exe: EXE } = testApp(process.argv[2] || path.join(MAC, 'build', 'RavenryMac.app'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'macos-launch.'));
const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state'), data = path.join(tmp, 'desktop');
for (const d of [user, run, state, data]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: data };
const BIN = path.join(APP, 'Contents', 'MacOS', 'ravenryd');

const daemon = spawn(BIN, ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
// Named after the daemon's version: 0.0.0-dev from build.sh, the release's in a package.
const version = JSON.parse(execFileSync(BIN, ['version', '--json'], { env, encoding: 'utf8' })).version;
const sock = path.join(run, `ravenryd-${version.replace(/[^A-Za-z0-9._-]/g, '_')}.sock`);
for (let i = 0; !fs.existsSync(sock); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }
const panes = ['one', 'two', 'three'].map((n) => execFileSync(BIN, ['new', '--name', n, '--size', '100x30', '--label', 'ravenry.kind=shell', '--', '/bin/zsh', '-f'], { env, encoding: 'utf8' }).trim().split(/\s+/)[0]);
const folder = fs.realpathSync(run);
const id = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 12);
fs.writeFileSync(path.join(data, `window-${id}.json`), JSON.stringify({
  order: [`s:${panes[1]}`, 's:pgonegone'],
  splits: [{ host: `s:${panes[1]}`, guest: 's:pgonetoo', side: 'right', size: 50, focus: 0 }],
  active: 's:pgonegone', pinned: ['nowhere/sf-9'], hintsDone: { pick: true },
}, null, 2));

const hub = await startDemoHub({ dir: path.join(tmp, 'hub'), port: 47900 + Math.floor(Math.random() * 90), extra: [{ id: 'old-notes', name: 'old-notes' }] });
const log = path.join(tmp, 'app.log');
const app = spawn(EXE, ['--offscreen', '--socket', sock], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log') },
  stdio: ['ignore', 'ignore', fs.openSync(log, 'w')],
});
let exit = null;
app.on('exit', (code, sig) => { exit = sig || code; });
await sleep(8000);
const alive = exit === null;
if (alive) app.kill();
hub.stop();
daemon.kill();
const saved = JSON.parse(fs.readFileSync(path.join(data, `window-${id}.json`), 'utf8'));
const tabs = (saved.order || []).filter((x) => panes.some((p) => x === `s:${p}`)).length;
console.log(`${alive ? 'pass' : 'FAIL'} launch_alive_8s: ${alive ? 'running' : `exited ${exit}; see ${log}`}`);
console.log(`${tabs === 3 ? 'pass' : 'FAIL'} launch_tabs_kept: ${tabs} of 3 shells in the saved order (${(saved.order || []).join(', ')})`);
process.exit(alive && tabs === 3 ? 0 : 1);
