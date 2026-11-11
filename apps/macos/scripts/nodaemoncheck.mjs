#!/usr/bin/env node
// WIN-007: a launch that cannot reach or start any daemon says why and
// quits, never an empty window. A copy of the app (a development build, or
// a package's test twin: scripts/package.mjs's release-test/Ravenry.app)
// with its ravenryd unreadable, started off every screen with a throwaway
// HOME, runtime, state and data folder and no daemon running there: it must
// quit within 15 s, with the alert "Ravenry cannot open a terminal" (written,
// not shown, off every screen) naming ravenryd as the reason, and the line in
// its log. A package runs with RAVENRY_SERVICE=off: it copies its ravenryd
// out (which fails) and installs nothing.
//
//   node scripts/nodaemoncheck.mjs APP [OUT]
//   node scripts/nodaemoncheck.mjs --exe EXE APP [OUT]
//
// --exe: this tree's executable (build.sh's RavenryMac) in the copy in
// place of the app's own, signed again ad hoc: the package's layout (its
// Node, setup and hub) with code not packaged yet.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const argv = process.argv.slice(2);
const ei = argv.indexOf('--exe');
const EXE_IN = ei >= 0 ? path.resolve(argv.splice(ei, 2)[1]) : null;
if (!argv[0]) { console.error('usage: node scripts/nodaemoncheck.mjs [--exe EXE] APP [OUT]'); process.exit(2); }
const { app: GIVEN } = testApp(argv[0]);
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'nodaemoncheck.'));
const OUT = path.resolve(argv[1] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? ': ' + String(detail).replace(/\n/g, '\\n') : ''}`); };

const copy = path.join(tmp, path.basename(GIVEN));
execFileSync('/usr/bin/ditto', [GIVEN, copy]);
const exeName = fs.existsSync(path.join(copy, 'Contents', 'MacOS', 'Ravenry')) ? 'Ravenry' : 'RavenryMac';
const exe = path.join(copy, 'Contents', 'MacOS', exeName);
if (EXE_IN) {
  fs.copyFileSync(EXE_IN, exe);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', copy], { stdio: 'ignore' });
}
const packaged = fs.existsSync(path.join(copy, 'Contents', 'Resources', 'build.json')) && fs.existsSync(path.join(copy, 'Contents', 'MacOS', 'node'));
const rd = path.join(copy, 'Contents', 'MacOS', 'ravenryd');
fs.chmodSync(rd, 0o000);
let unreadable = false;
try { fs.accessSync(rd, fs.constants.R_OK); } catch { unreadable = true; }
check('nodaemon_ravenryd_unreadable', unreadable, `${rd} mode ${(fs.statSync(rd).mode & 0o777).toString(8)}`);

const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state'), data = path.join(tmp, 'data');
for (const d of [user, run, state, data]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0', ...(packaged ? { RAVENRY_SERVICE: 'off' } : {}) };
const result = path.join(OUT, 'nodaemon.json');
fs.rmSync(result, { force: true });
const t0 = Date.now();
const a = spawn(exe, ['--offscreen', '--selftest', result], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(OUT, 'nodaemon.log'), 'w')] });
let code = null;
a.on('exit', (c, s) => { code = c ?? s; });
while (code === null && Date.now() - t0 < 15000) await sleep(50);
const secs = (Date.now() - t0) / 1000;
if (code === null) a.kill('SIGKILL');
let j = {};
try { j = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* none */ }
const log = fs.readFileSync(path.join(OUT, 'nodaemon.log'), 'utf8');
const appLog = (() => { try { return fs.readFileSync(path.join(user, 'Library', 'Logs', 'Ravenry', 'app.log'), 'utf8'); } catch { return ''; } })();
check('nodaemon_quits', code !== null && secs < 15, `${packaged ? 'packaged' : 'development build'}: exit ${code} after ${secs.toFixed(1)} s`);
check('nodaemon_alert', j.alert === 'Ravenry cannot open a terminal', JSON.stringify(j));
// The reason: this app's ravenryd, not only that none runs.
check('nodaemon_alert_names_why', /ravenryd/.test(j.error || '') && (packaged ? /could not be copied out|EACCES|permission/i.test(j.error) : /cannot be run/.test(j.error || '')), j.error || 'none');
check('nodaemon_alert_logged', log.includes('alert: Ravenry cannot open a terminal'), log.split('\n').filter((l) => /alert:/.test(l)).join(' | ').slice(0, 400));
// Nothing of the person's: no daemon was started, none runs from this copy.
const left = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(copy));
check('nodaemon_nothing_left_running', left.length === 0, left.join(' | '));
fs.writeFileSync(path.join(OUT, 'nodaemoncheck.json'), JSON.stringify({ app: GIVEN, exe: EXE_IN, packaged, appLog: appLog.split('\n').slice(-6), checks }, null, 2));
fs.chmodSync(rd, 0o755);
fs.rmSync(copy, { recursive: true, force: true });
const failed = checks.filter((c) => !c.ok).length;
console.log(`nodaemoncheck: ${checks.length} checks, ${failed} failed (${OUT})`);
process.exit(failed ? 1 : 0);
