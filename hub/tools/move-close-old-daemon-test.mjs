// Proves that a move's old pane closes when it is on an older ravenryd:
// after Move here, the hub resumes the session in a new pane of the newest
// daemon and closes the pane it was in (closeOldPane in server/index.mjs,
// term.ravenryClose, server/ravenryd.mjs close). That pane can be on an
// older daemon still running beside the newest after an update (0.1.22
// beside 0.1.23 on 2026-11-10), so the close must find the daemon that
// holds it, not only the newest.
//
// Two daemons run in one throwaway runtime folder, as after an update: an
// older release's (OLD_RAVENRYD, default the 0.1.22 one the Electron app
// left in ~/Library/Application Support/Ravenry/versions, copied into the
// test's folder and run from there) and this tree's (RAVENRYD_BIN). Each
// gets a pane; the old pane runs a process that stands for the assistant.
// The adapter (term.ravenryClose, as closeOldPane calls it) closes the old
// daemon's pane: it is gone from that daemon's list, its process ended,
// and the newer daemon's pane still runs. Never the person's daemons: the
// runtime and state folders are the test's own.
//
// Usage: RAVENRYD_BIN=<this tree's ravenryd built as a later version, as
// apps/macos/scripts/resizebench.mjs --daemons builds it> [OLD_RAVENRYD=...]
//        node tools/move-close-old-daemon-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = process.env.RAVENRYD_BIN;
const OLD_SRC = process.env.OLD_RAVENRYD || path.join(os.homedir(), 'Library', 'Application Support', 'Ravenry', 'versions', '0.1.22', 'ravenryd');
if (!BIN || !fs.existsSync(OLD_SRC)) {
  console.log(`SKIP  move-close-old-daemon-test: set RAVENRYD_BIN to this tree's ravenryd and OLD_RAVENRYD to an older release's (${OLD_SRC} not found)`);
  process.exit(0);
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'move-close-old-'));
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [] }, null, 2));
// The daemons' folders: short, outside the repo (a socket path takes at most 103 bytes).
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvo-'));
const DHOME = path.join(D, 'home');
fs.mkdirSync(DHOME);
const RUN = path.join(D, 'run');
const OLD = path.join(D, 'old-ravenryd');
fs.copyFileSync(OLD_SRC, OLD);
fs.chmodSync(OLD, 0o755);
process.env.RAVENRY_HOME = MC;
process.env.RAVENRY_RUNTIME_DIR = RUN;
process.env.RAVENRY_STATE_DIR = path.join(D, 'state');
process.env.RAVENRY_DAEMON_BIN = BIN;
const DENV = { HOME: DHOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: process.env.RAVENRY_STATE_DIR };

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(25);
  }
}
const version = (bin) => JSON.parse(execFileSync(bin, ['version', '--json'], { env: DENV, encoding: 'utf8' })).version;
const oldV = version(OLD), newV = version(BIN);

const daemons = [];
let dlog = '';
for (const bin of [OLD, BIN]) {
  const d = spawn(bin, ['serve'], { env: DENV, stdio: ['ignore', 'ignore', 'pipe'] });
  d.stderr.on('data', (x) => { dlog += x; });
  daemons.push(d);
}
const cleanup = () => { for (const d of daemons) d.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);

const { daemonSockets } = await import('../../packages/node-client/index.mjs');
const up = await until(() => daemonSockets(RUN).length === 2, 8000);
check(`both daemons run in the test's runtime folder (${oldV} and ${newV})`, !!up && oldV !== newV, up ? '' : dlog);
// The newest first, as the hub and the app pick it: RAVENRYD_BIN must be built as a later version (-X main.version).
check(`this tree's daemon is the newest there (${daemonSockets(RUN).map((s) => s.version).join(', ')})`, up && daemonSockets(RUN)[0].version === newV);
const sockOf = (v) => daemonSockets(RUN).find((s) => s.version === v).socket;

// A pane on each, made with each daemon's own command; the old one runs the stand-in for the assistant.
const mk = (bin, v, cmd) => JSON.parse(execFileSync(bin, ['new', '--socket', sockOf(v), '--label', 'ravenry.session=test', '--cwd', DHOME, '--json', '--', ...cmd], { env: DENV, encoding: 'utf8' })).pane;
const oldPane = mk(OLD, oldV, ['/bin/sh', '-c', 'sleep 600']);
const newPane = mk(BIN, newV, ['/bin/sh', '-c', 'sleep 600']);
const listOf = (bin, v) => { const l = JSON.parse(execFileSync(bin, ['ls', '--socket', sockOf(v), '--json'], { env: DENV, encoding: 'utf8' })); return l.panes || l; };
check('the old pane runs on the older daemon, the new one on the newer', listOf(OLD, oldV).some((p) => p.id === oldPane.id) && listOf(BIN, newV).some((p) => p.id === newPane.id), `${oldPane.id} ${newPane.id}`);
const oldPid = oldPane.pid;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const term = await import('../server/terminal.mjs');
// As closeOldPane does it.
const t0 = Date.now();
const r = await term.ravenryClose(`ravenry:${oldPane.id}`).catch((e) => ({ ok: false, err: e.message }));
check('closeOldPane\'s call closes a pane on the older daemon', r.ok, JSON.stringify(r));
const gone = await until(() => !listOf(OLD, oldV).some((p) => p.id === oldPane.id && p.state === 'running'), 5000);
check(`the old pane is gone from the older daemon's list (${Date.now() - t0} ms)`, !!gone, JSON.stringify(listOf(OLD, oldV).map((p) => [p.id, p.state])));
check('the process that ran in it ended', !oldPid || !!(await until(() => !alive(oldPid), 5000)), `pid ${oldPid}`);
check('the newer daemon\'s pane still runs', listOf(BIN, newV).some((p) => p.id === newPane.id && (p.state || 'running') === 'running'));
// A pane the hub listed before (where it is cached) closes too: the newer one.
const r2 = await term.ravenryClose(`ravenry:${newPane.id}`).catch((e) => ({ ok: false, err: e.message }));
check('and a pane on the newer daemon closes the same way', r2.ok && !!(await until(() => !listOf(BIN, newV).some((p) => p.id === newPane.id && p.state === 'running'), 5000)), JSON.stringify(r2));

console.log(fails ? `move-close-old-daemon-test: ${fails} failed` : 'move-close-old-daemon-test: all passed');
process.exit(fails ? 1 : 0);
