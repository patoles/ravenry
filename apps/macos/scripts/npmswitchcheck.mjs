#!/usr/bin/env node
// The switch from the npm board as the native app runs it (NpmSwitch.swift
// runs these same setup commands, with these arguments, on the Node the app
// carries): on data the npm board 0.4.0 really wrote
// (apps/desktop/tools/npm-board-fixture.mjs: the package from npm, its
// setup, its API), in a throwaway HOME on a spare port, launchd being
// apps/desktop/tools/fake-launchctl.mjs. Never the person's board, data,
// hooks or launchd.
//
//   node scripts/npmswitchcheck.mjs APP [OUT]
//
// APP is the packaged native app (build/package/Ravenry.app). The window's
// side (the offer, the steps, the bar, the sheet) is sidetest.mjs --screen
// updates.
//
// The board starts at login and runs: the launch says `offer` and starts no
// hub of the app's; Not now makes it the bar; the switch says each step on
// standard error as the window shows them, stops the board, turns its
// login start off, moves the hooks and starts the app's hub on the same
// port and data, whose counts it answers; a relaunch after it says `hub`
// with the menu's way back (record switched); going back removes the app's
// hub, turns the login start on again (the board answers again) and puts
// the npm board's hooks back.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { testApp } from './testapp.mjs';
import { NPM_LOGIN_LABEL as LABEL, api, makeNpmUser, stopBoard } from '../../desktop/tools/npm-board-fixture.mjs';

guardSpawns();
// The test twin (testapp.mjs): the release quits on --offscreen.
const APP = process.argv[2] ? testApp(process.argv[2]).app : '';
const R = path.join(APP, 'Contents', 'Resources');
const NODE = path.join(APP, 'Contents', 'MacOS', 'node');
const EXE = path.join(APP, 'Contents', 'MacOS', 'Ravenry');
if (!fs.existsSync(path.join(R, 'setup.mjs')) || !fs.existsSync(NODE)) { console.error('usage: node scripts/npmswitchcheck.mjs PACKAGED_APP [OUT]'); process.exit(2); }
if (process.platform !== 'darwin') { console.log('npmswitchcheck: the npm board runs on macOS only'); process.exit(0); }
const OUT = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-npmcheck-')));
fs.mkdirSync(OUT, { recursive: true });
const PKG_DIR = path.join(os.tmpdir(), 'ravenry-npm-0.4.0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'pass' : 'FAIL'} ${name}${!ok && detail ? '  ' + String(detail).slice(0, 700) : ''}`); if (!ok) fails++; };

/** One setup command as NpmSwitch.swift runs it: its stderr lines as they come, its JSON answer. */
function setup(env, args) {
  return new Promise((resolve) => {
    const p = spawn(NODE, ['--disable-sigusr1', path.join(R, 'setup.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const lines = [];
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; let i; while ((i = err.indexOf('\n')) >= 0) { const l = err.slice(0, i); err = err.slice(i + 1); if (l.trim()) lines.push({ at: Date.now(), l }); } });
    p.on('close', () => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { j = { ok: false, error: out.slice(-400) }; } resolve({ j, lines }); });
  });
}
const hookCmds = (f) => Object.values((readJson(f) || {}).hooks || {}).flat().flatMap((g) => (g.hooks || []).map((h) => h.command));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvnn-'));
let u = null;
try {
  u = await makeNpmUser(root, { pkgDir: PKG_DIR, login: true, log: (s) => console.log('  ' + s) });
  const jobs = () => readJson(path.join(root, 'launchd', 'jobs.json')) || {};
  const env = { ...u.env, RAVENRY_SERVICE: 'install', RAVENRY_DESKTOP_DATA: path.join(root, 'app-data'), RAVENRY_STATE_DIR: path.join(root, 'state'), RAVENRY_RUNTIME_DIR: path.join(root, 'rt'), RAVENRY_HUB_URL: u.url };
  fs.mkdirSync(env.RAVENRY_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const npmPid = jobs()[LABEL] && jobs()[LABEL].pid;
  const claudeBefore = hookCmds(path.join(u.home, '.claude', 'settings.json'));
  check('the npm board runs, started at login, its hooks in Claude Code\'s settings', !!npmPid && alive(npmPid) && claudeBefore.some((c) => c.includes(u.pkg)), JSON.stringify(jobs()));

  // The launch: the offer, no hub of the app's.
  const l1 = await setup(env, ['hub', '--resources', R, '--exe', EXE]);
  check('launch: the plan is offer, the window offers the switch full size, no hub service of the app\'s', l1.j.plan === 'offer' && l1.j.offer === 'screen' && l1.j.detect?.npm === true && l1.j.detect?.board?.port === u.port && !jobs()['dev.ravenry.hub'], JSON.stringify(l1.j).slice(0, 500));
  const nn = await setup(env, ['npm-choice', '--set', 'not-now']);
  const l2 = await setup(env, ['hub', '--resources', R, '--exe', EXE]);
  check('Not now: kept, and the next launch shows the quiet bar, the board untouched', nn.j.ok && l2.j.offer === 'bar' && alive(npmPid) && !jobs()['dev.ravenry.hub'], JSON.stringify(l2.j).slice(0, 300));

  // The switch.
  const t0 = Date.now();
  const sw = await setup(env, ['npm-switch', '--resources', R, '--exe', EXE]);
  const ms = Date.now() - t0;
  const steps = sw.lines.filter((x) => x.l.startsWith('@step ')).map((x) => JSON.parse(x.l.slice(6)));
  const ids = steps.map((s) => s.id + (s.id === 'hub' ? `:${s.done}` : ''));
  // (A board started at login stops with its login start: no step of its own, the window ticks it with the login's.)
  const order = ['login', 'backup', 'hooks', 'hub:false', 'hub:true'];
  check('switch: each step said as it is done, in order (login start off, which stops the board; backup; hooks; the hub starting, then up)', order.every((s) => ids.includes(s)) && order.every((s, i) => i === 0 || ids.indexOf(order[i - 1]) < ids.indexOf(s)), ids.join(', '));
  check(`switch: switched in ${(ms / 1000).toFixed(1)} s, the counts from the app's hub`, sw.j.ok && sw.j.phase === 'switched' && sw.j.counts && sw.j.counts.projects >= 1 && sw.j.counts.ideas >= 1, JSON.stringify(sw.j).slice(0, 500));
  check('switch: the npm board stopped, its login start off, the app\'s hub service loaded', !alive(npmPid) && !jobs()[LABEL] && !!jobs()['dev.ravenry.hub'], JSON.stringify(jobs()));
  const st = await api(u.url, 'GET', '/api/state');
  check('switch: the app\'s hub answers on the npm board\'s port with its project', st.projects.some((p) => p.id === 'weather-api'));
  const claudeAfter = hookCmds(path.join(u.home, '.claude', 'settings.json'));
  check('switch: Claude Code\'s hooks run the app\'s copy, none of the npm board\'s; the person\'s own stays', !claudeAfter.some((c) => c.includes(u.pkg)) && claudeAfter.some((c) => / hook --assistant claude$/.test(c)) && claudeAfter.includes('echo mine'), claudeAfter.join(' | '));
  check('switch: the choice is kept as switched', readJson(path.join(env.RAVENRY_DESKTOP_DATA, 'npm-choice.json'))?.choice === 'switched');
  const l3 = await setup(env, ['hub', '--resources', R, '--exe', EXE]);
  check('relaunch after it: the hub is the app\'s, no offer, the record says switched (the menu\'s Go Back)', l3.j.plan === 'hub' && l3.j.offer === 'none' && l3.j.detect?.record?.state === 'switched', JSON.stringify(l3.j).slice(0, 400));

  // The way back.
  const bk = await setup(env, ['npm-back', '--resources', R]);
  const npmAgain = await (async () => { for (let i = 0; i < 60; i++) { const j = jobs()[LABEL]; if (j && j.pid && alive(j.pid)) { try { await api(u.url, 'GET', '/api/state'); return j.pid; } catch { /* not yet */ } } await sleep(500); } return null; })();
  check('back: the app\'s hub service removed, the login start loaded again and the npm board answers', bk.j.ok && bk.j.phase === 'back' && bk.j.offer === 'bar' && !jobs()['dev.ravenry.hub'] && !!npmAgain, JSON.stringify(bk.j).slice(0, 400));
  const claudeBack = hookCmds(path.join(u.home, '.claude', 'settings.json'));
  check('back: Claude Code\'s hooks are the npm board\'s exact commands again', JSON.stringify(claudeBack.sort()) === JSON.stringify(claudeBefore.sort()), `${claudeBack.length} vs ${claudeBefore.length}`);
  check('back: the log said what it did', bk.lines.some((x) => /hub service .*stopped and removed|was not installed/.test(x.l)), bk.lines.map((x) => x.l).join(' | ').slice(0, 400));
  fs.writeFileSync(path.join(OUT, 'npmswitchcheck.json'), JSON.stringify({ launch: l1.j, switch: sw.j, steps: ids, back: bk.j, ms }, null, 2));
} catch (e) {
  check('the check ran to its end', false, e && e.stack);
} finally {
  if (u) stopBoard(u.home);
  // Every process this check started (the boards, hubs, daemons) runs from its folders.
  const { execFileSync } = await import('node:child_process');
  for (const line of execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
    const m = line.trim().match(/^(\d+) (.*)$/);
    if (m && (m[2].includes(root))) { try { process.kill(Number(m[1]), 'SIGTERM'); } catch { /* gone */ } }
  }
  await sleep(500);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`npmswitchcheck: ${fails} failed; ${OUT}`);
  process.exit(fails ? 1 : 0);
}
