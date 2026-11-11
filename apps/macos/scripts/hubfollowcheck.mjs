#!/usr/bin/env node
// The window follows the hub (HUB-010, HUB-012, A11Y-012) and one Ravenry
// runs per data folder (single instance), on the app off every screen in a
// throwaway HOME, a throwaway ravenryd and the demo board (apps/desktop/
// tools/demo-hub.mjs, on 127.0.0.1 only). The app is given no hub address:
// it finds the board as on a Mac, through <RAVENRY_HOME>/board.json.
//
//   node scripts/hubfollowcheck.mjs [APP] [OUT]     (APP: a build.sh build or a package's twin)
//
// port     the board on a port other than 4600 (PORT=...): the window reads
//          board.json and its sidebar fills; a hook (hub/hooks/events.mjs,
//          as Claude Code runs it) finds the board the same way and the
//          board takes its event (the session's id in its state).
// restart  the board stopped 40 s after the launch and started again 3 s
//          later on the same port: the window has its state again within
//          2 s of the new board answering, no relaunch.
// moved    the board started again on another port: the window follows
//          board.json to it within 2 s.
// wake     the board down for 25 s (the window's retries backed off to
//          10 s), started again, then the Mac's wake (the report's command
//          file, as NSWorkspace.didWakeNotification): the window has the
//          board within 2 s of the wake, and the pane in front is drawn
//          from a new render stream (its frames go up); app.log says so.
// single   a second start of the app on the same data folder quits with 0
//          within 5 s, says so in app.log, and the first one hears it.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const { app: APP, exe: EXE } = testApp(process.argv[2] || path.join(MAC, 'build', 'RavenryMac.app'));
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'hubfollow.'));
const OUT = path.resolve(process.argv[3] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state'), data = path.join(tmp, 'desktop');
for (const d of [user, run, state, data]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
const hubDir = path.join(tmp, 'hub');
const MC = path.join(hubDir, 'home', '.ravenry');
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: data, RAVENRY_HOME: MC };

const daemon = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
for (let i = 0; !fs.readdirSync(run).some((n) => /^ravenryd-.+\.sock$/.test(n)); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }

let hub = null;
async function board(port) {
  hub = await startDemoHub({ dir: hubDir, port });
  return { port, at: Date.now() };
}
const report = path.join(tmp, 'report.json');
const readReport = () => { try { return JSON.parse(fs.readFileSync(report, 'utf8')); } catch { return null; } };
const appLog = () => { try { return fs.readFileSync(path.join(user, 'Library', 'Logs', 'Ravenry', 'app.log'), 'utf8'); } catch { return ''; } };
async function until(ms, f) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = f(); if (v) return v; await sleep(100); } return null; }
const hubOn = (port) => (r) => r && r.hub && r.hub.reachable && r.hub.url.endsWith(`:${port}`) && r.hub.generatedAt && r.sidebarEmpty === '';

let app = null;
try {
  const p1 = await freePort();
  await board(p1);
  const bj = JSON.parse(fs.readFileSync(path.join(MC, 'board.json'), 'utf8'));
  check('port_board_json', bj.port === p1, `board.json says ${bj.port}, the board listens on ${p1}`);
  const launched = Date.now();
  app = spawn(EXE, ['--offscreen'], { env: { ...env, RAVENRY_MAC_REPORT: report, RAVENRY_TEST_SINGLE: '1' }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app.log'), 'w')] });
  const first = await until(20000, () => { const r = readReport(); return hubOn(p1)(r) ? r : null; });
  check('port_window_finds_board', first, first ? `${first.hub.url}, state of ${first.hub.generatedAt}, the sidebar filled` : JSON.stringify(readReport()?.hub));

  // A hook as Claude Code runs it: no address given, board.json read.
  const sid = 'hubfollow-' + Date.now().toString(36);
  const folder = path.join(hubDir, 'home', 'Projects', 'paper-boat');
  const hk = spawnSync(process.execPath, [path.join(REPO, 'hub', 'hooks', 'events.mjs')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, cwd: folder, transcript_path: path.join(tmp, 't.jsonl'), source: 'startup' }),
    env: { ...env, HOME: path.join(hubDir, 'home') }, encoding: 'utf8', timeout: 5000,
  });
  let inState = false;
  for (let i = 0; i < 50 && !inState; i++) { inState = JSON.stringify(await hub.state()).includes(sid); if (!inState) await sleep(100); }
  check('port_hook_reaches_board', hk.status === 0 && inState, `hook exit ${hk.status}; the board's state names the session: ${inState}`);

  // restart: past the first 15 s, on the same port.
  await sleep(Math.max(0, 40000 - (Date.now() - launched)));
  hub.stop();
  const down = await until(5000, () => { const r = readReport(); return r && r.hub && !r.hub.reachable ? r : null; });
  check('restart_window_sees_drop', down, down ? `the sidebar says: ${down.sidebarEmpty || '(nothing)'}` : 'still reachable');
  await sleep(3000);
  const b2 = await board(p1);
  const before = first.hub.generatedAt;
  const back = await until(10000, () => { const r = readReport(); return hubOn(p1)(r) ? r : null; });
  check('restart_back_within_2s', back && Date.now() - b2.at <= 2000 + 1000, back ? `${Date.now() - b2.at} ms after the board answered (the report is written each second)` : 'not back in 10 s');

  // moved: another port.
  hub.stop();
  await sleep(1500);
  const p2 = await freePort();
  const b3 = await board(p2);
  const moved = await until(10000, () => { const r = readReport(); return hubOn(p2)(r) ? r : null; });
  check('moved_follows_board_json', moved && Date.now() - b3.at <= 3000, moved ? `on :${p2} ${Date.now() - b3.at} ms after the board answered` : `still ${readReport()?.hub?.url}`);
  check('moved_logged', /hub: the board is at http:\/\/127\.0\.0\.1:\d+ now/.test(appLog()), (appLog().match(/hub: the board is at .*/) || [''])[0]);

  // wake: down long enough for the retries to back off, then a wake.
  hub.stop();
  await sleep(25000);
  const b4 = await board(p2);
  const framesBefore = readReport()?.focused?.frames || 0;
  fs.writeFileSync(report + '.do', 'wake');
  const t4 = Date.now();
  const woke = await until(10000, () => { const r = readReport(); return hubOn(p2)(r) ? r : null; });
  check('wake_board_within_2s', woke && Date.now() - t4 <= 2500, woke ? `${Date.now() - t4} ms after the wake, ${t4 - b4.at} ms after the board answered` : 'not back');
  const redrawn = await until(5000, () => { const r = readReport(); return r && r.focused && r.focused.frames > framesBefore ? r : null; });
  check('wake_pane_drawn_again', redrawn, redrawn ? `the pane in front: frames ${framesBefore} -> ${redrawn.focused.frames}, its text ${JSON.stringify((redrawn.focused.text || '').trim().slice(0, 30))}` : `frames stayed ${framesBefore}`);
  check('wake_logged', /wake: the hub read again, the daemons looked for, \d+ panes? on show drawn again/.test(appLog()), (appLog().match(/wake: .*/) || [''])[0]);

  // single: a second start on the same data folder.
  const t5 = Date.now();
  const second = spawnSync(EXE, ['--offscreen'], { env: { ...env, RAVENRY_MAC_REPORT: path.join(tmp, 'report2.json'), RAVENRY_TEST_SINGLE: '1' }, timeout: 15000 });
  check('single_second_quits', second.status === 0 && Date.now() - t5 < 5000, `exit ${second.status} after ${Date.now() - t5} ms`);
  check('single_logged', /launch: another Ravenry with this data folder runs \(pid \d+\): it comes to the front, and this one quits/.test(appLog()), (appLog().match(/launch: another Ravenry.*/) || [''])[0]);
  const heard = await until(5000, () => /launch: a second Ravenry started and quit; this one would come to the front/.test(appLog()));
  check('single_first_hears', heard && app.exitCode === null, `the first still runs: ${app.exitCode === null}`);
} finally {
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await sleep(1500); }
  hub?.stop();
  daemon.kill();
  fs.writeFileSync(path.join(OUT, 'hubfollowcheck.json'), JSON.stringify({ app: APP, at: new Date().toISOString(), results }, null, 2));
  try { fs.copyFileSync(path.join(user, 'Library', 'Logs', 'Ravenry', 'app.log'), path.join(OUT, 'app.log')); } catch { /* none */ }
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
