#!/usr/bin/env node
// The switch from the npm board to the packaged app, and the way back, on
// data the npm board 0.4.0 really wrote (tools/npm-board-fixture.mjs: the
// package from npm, its setup, its API). macOS only, as the npm board is.
//
//   node tools/npm-switch-test.mjs APP [OUT]
//
// APP is Ravenry.app (release/mac-arm64/Ravenry.app). Everything runs in
// throwaway HOMEs under OUT, offscreen, on spare ports; launchd is
// tools/fake-launchctl.mjs (the app's service and the npm board's login
// start are loaded there, never into the real launchd).
//
//   login   the board starts at login and runs: the app shows the switch,
//           the person agrees, the board stops, its login start is off,
//           the hooks move, the app's hub starts on the same data and
//           port, and every project, session, idea, picture, plan, rule,
//           setting and note is there; a new session reaches it through
//           the moved hooks; an idea is made in the app. Then the way back:
//           the app's hub stops and leaves, the login start is back and
//           starts the board, the hooks are the npm board's exact commands
//           again, and the npm board shows everything, the new idea too.
//   by hand the board was started by hand (`ravenry --no-open`), with no
//           login start: Not now changes nothing (every file of the data,
//           the hook settings and LaunchAgents hash the same, launchd was
//           asked nothing, the board still serves); then the switch from
//           the bar, and the way back, which leaves the board to start as
//           before with the command it ran.
//
// Pictures of the placeholder screens go to OUT.
import { guardSpawns } from '../../../tools/test-env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NPM_LOGIN_LABEL as LABEL, api, hookEvent, makeNpmUser, startNpmBoard, stopBoard } from './npm-board-fixture.mjs';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'darwin') { console.log('npm-switch: the npm board runs on macOS only; nothing to test here'); process.exit(0); }
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!pos[0]) { console.error('usage: npm-switch-test.mjs APP [OUT]'); process.exit(2); }
const APP_PATH = path.resolve(pos[0]);
const OUT = path.resolve(pos[1] || path.join(os.tmpdir(), 'ravenry-npm-switch'));
const EXE = path.join(APP_PATH, 'Contents', 'MacOS', 'Ravenry');
if (!fs.existsSync(EXE)) { console.error(`npm-switch: no executable at ${EXE}`); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const PKG_DIR = path.join(os.tmpdir(), 'ravenry-npm-0.4.0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 600) : ''}`); if (!ok) fails++; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Every file under `dir` (but `skip`), as rel -> sha1.
function hashes(dir, skip = () => false) {
  const out = {};
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

// The hooks of a settings document: event -> sorted commands.
function hookCmds(json) {
  const out = {};
  for (const [ev, list] of Object.entries((json && json.hooks) || {})) out[ev] = (list || []).flatMap((g) => (g.hooks || []).map((h) => h.command)).sort();
  return out;
}
const jobs = (u) => readJson(path.join(u.launchd, 'jobs.json')) || {};
const calls = (u) => { try { return fs.readFileSync(path.join(u.launchd, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args); } catch { return []; } };

// What the npm board shows: the things the person would miss.
async function seen(url) {
  const st = await api(url, 'GET', '/api/state');
  const ideas = await api(url, 'GET', '/api/ideas');
  const handoff = await api(url, 'GET', '/api/settings/handoff');
  const proj = st.projects.find((p) => p.id === 'weather-api') || {};
  return {
    projects: st.projects.map((p) => p.name).sort(),
    plan: proj.plan ? proj.plan.title : null,
    ideas: (ideas.ideas || []).filter((i) => !i.archived).map((i) => i.name).sort(),
    picture: ((ideas.ideas || []).find((i) => i.name === 'Rain alerts') || {}).img || null,
    threshold: handoff.settings.handoffThreshold,
  };
}

async function runSteps(u, name, steps, more = {}) {
  const work = path.join(u.root, 'app-run');
  fs.mkdirSync(work, { recursive: true });
  const rt = path.join(u.root, 'rt');
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  const env = {
    ...u.env, RAVENRY_SERVICE: 'install', RAVENRY_DESKTOP_DATA: u.appData, RAVENRY_STATE_DIR: path.join(u.root, 'state'), RAVENRY_UPDATES: '0',
    SHELL: '/bin/zsh', ...more,
  };
  try {
    return await runApp({ name, work, rt, home: u.home, exe: EXE, hubUrl: u.url, steps, shell: '', env, timeoutMs: 180000 });
  } finally {
    stopDaemons(path.join(u.appData, 'bin', 'ravenryd'), rt);
  }
}

const R = 'window.__ravenryNpm';
const view = (cond) => `${R} && ${R}.view() && (${cond})`;

// ------------------------------------------------------------ login

async function loginCase() {
  console.log('\n== the board starts at login and runs');
  const root = path.join(OUT, 'login');
  const u = await makeNpmUser(root, { pkgDir: PKG_DIR, login: true, log: (s) => console.log('  ' + s) });
  u.root = root;
  u.appData = path.join(root, 'app-data');
  const before = await seen(u.url);
  const npmPid = jobs(u)[LABEL].pid;
  const claudeBefore = readJson(path.join(u.home, '.claude', 'settings.json'));
  const codexBefore = readJson(path.join(u.home, '.codex', 'hooks.json'));
  const configBefore = fs.readFileSync(path.join(u.home, '.codex', 'config.toml'), 'utf8');
  const plist = path.join(u.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const plistBefore = fs.readFileSync(plist, 'utf8');
  check('the npm board shows the project, plan, ideas, picture and setting', before.projects.includes('weather-api') && before.plan && before.ideas.length === 2 && before.picture && before.threshold === 55, JSON.stringify(before));

  const log = await runSteps(u, 'switch', [
    { ready: true, timeout: 30000 },
    { until: view(`${R}.view().offer === 'screen'`), timeout: 30000 },
    { shot: path.join(OUT, 'login-1-screen.png') },
    { js: `${R}.switch()` },
    { until: view(`['switched', 'error'].includes(${R}.view().phase)`), timeout: 120000 },
    { shot: path.join(OUT, 'login-2-switched.png') },
    { save: { expr: `${R}.view()`, out: path.join(root, 'switch-view.json') } },
  ]);
  fs.writeFileSync(path.join(OUT, 'login-switch-app.log'), log);
  const v = readJson(path.join(root, 'switch-view.json'));
  check('the window showed the switch and it ended switched', v && v.phase === 'switched', v && (v.message || v.log.join(' | ')));
  const rec = readJson(path.join(u.home, '.ravenry', 'switch.json'));
  check('switch.json records the npm copy, its login start and its hooks', rec && rec.state === 'switched' && rec.from.version === '0.4.0' && rec.login.length === 1 && rec.login[0].loaded && rec.hooks.claude.length === 6 && rec.hooks.codex.length === 7, JSON.stringify(rec).slice(0, 400));
  const j = jobs(u);
  check('the login start is off and its file is in the backup', !j[LABEL] && !fs.existsSync(plist) && fs.existsSync(path.join(u.home, '.ravenry', rec.login[0].kept)));
  check('the npm board stopped', !alive(npmPid), npmPid);
  check("the app's hub service is installed and loaded", !!j['dev.ravenry.hub'] && fs.existsSync(path.join(u.home, 'Library', 'LaunchAgents', 'dev.ravenry.hub.plist')), JSON.stringify(j));
  const backup = path.join(u.home, '.ravenry', rec.backup);
  check('the backup holds the data and the hook settings as they were', ['ravenry/projects.json', 'ravenry/ideas.json', 'ravenry/rules.json', 'ravenry/events/sess-one-aaaaaa.jsonl', 'outside/claude-settings.json', 'outside/codex-hooks.json'].every((f) => fs.existsSync(path.join(backup, f))) && JSON.stringify(readJson(path.join(backup, 'outside/claude-settings.json'))) === JSON.stringify(claudeBefore));
  const after = await seen(u.url);
  check("the app's hub serves the same project, plan, ideas, picture and setting", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  const st = await api(u.url, 'GET', '/api/state');
  check("the app's hub serves this data on the same port", st.registryPath && st.registryPath.endsWith('.ravenry/projects.json') && readJson(path.join(u.home, '.ravenry', 'board.json')).pid === j['dev.ravenry.hub'].pid);
  const pic = await fetch(u.url + after.picture);
  check('the idea picture is served', pic.ok && (await pic.arrayBuffer()).byteLength > 50);
  check('the rule taken in the npm board is still decided', !!(readJson(path.join(u.home, '.ravenry', 'rules.json')).decisions || {}).feedback_pictures && /Show a picture before building anything visual/.test(fs.readFileSync(path.join(u.home, '.claude', 'CLAUDE.md'), 'utf8')));
  check('the note is still in the brief', /Ask about the rate limit/.test(fs.readFileSync(path.join(u.project, 'BRIEF.md'), 'utf8')));
  check('both sessions are in the events', u.sessions.every((s) => fs.existsSync(path.join(u.home, '.ravenry', 'events', `${s}.jsonl`))));
  const claude = readJson(path.join(u.home, '.claude', 'settings.json'));
  const all = Object.values(hookCmds(claude)).flat();
  check("Claude Code's hooks run the app's copy, with ravenryd, and none of the npm board's", !all.some((c) => c.includes(u.pkg)) && all.filter((c) => /\/versions\/[^/]+\/hub\/hooks\/events\.mjs --ravenryd$/.test(c) && c.startsWith('ELECTRON_RUN_AS_NODE=1 ')).length === 5 && all.filter((c) => / hook --assistant claude$/.test(c)).length === 6, JSON.stringify(hookCmds(claude)));
  check("the person's own hook and settings stay", all.includes('echo mine') && claude.model === 'opus');
  const codex = Object.values(hookCmds(readJson(path.join(u.home, '.codex', 'hooks.json')))).flat();
  check("Codex's hooks run the app's copy too", !codex.some((c) => c.includes(u.pkg)) && codex.some((c) => /hooks\/events\.mjs --assistant=codex --ravenryd$/.test(c)), JSON.stringify(codex));
  // A new session, as Claude Code runs the moved hook.
  hookEvent(u.home, { ...u.env, PATH: u.env.PATH }, 'SessionStart', { session_id: 'sess-three-cccccc', cwd: u.project, transcript_path: path.join(u.home, 'x.jsonl'), source: 'startup' });
  check('a new session reaches the data through the moved hooks', fs.existsSync(path.join(u.home, '.ravenry', 'events', 'sess-three-cccccc.jsonl')));
  // An idea made in the app, with a picture.
  const made = await api(u.url, 'POST', '/api/ideas/add', { name: 'Made in the app', pitch: 'After the switch.' });
  const png = fs.readFileSync(path.join(backup, 'ravenry', 'ideas', fs.readdirSync(path.join(backup, 'ravenry', 'ideas'))[0]));
  await api(u.url, 'POST', `/api/ideas/${made.id}/image`, png, { 'Content-Type': 'image/png', 'X-Filename': 'made.png' });
  check('the ideas moved to pages/ideas with their own backup', fs.existsSync(path.join(u.home, '.ravenry', 'pages', 'ideas', '.ravenry', 'migrated.json')) && fs.readdirSync(path.join(u.home, '.ravenry', 'backups')).some((n) => /^ideas-\d/.test(n)));

  // The way back.
  const log2 = await runSteps(u, 'back', [
    { ready: true, timeout: 30000 },
    { until: view(`${R}.view().detect && ${R}.view().detect.record && ${R}.view().detect.record.state === 'switched'`), timeout: 30000 },
    { js: `${R}.confirmBack(true)` },
    { until: `document.querySelector('#npm-switch [data-act=back]')`, timeout: 10000 },
    { shot: path.join(OUT, 'login-3-confirm-back.png') },
    { js: `${R}.back()` },
    { until: view(`['back', 'error'].includes(${R}.view().phase)`), timeout: 120000 },
    { shot: path.join(OUT, 'login-4-back.png') },
    { save: { expr: `${R}.view()`, out: path.join(root, 'back-view.json') } },
  ]);
  fs.writeFileSync(path.join(OUT, 'login-back-app.log'), log2);
  const b = readJson(path.join(root, 'back-view.json'));
  check('the way back ended back', b && b.phase === 'back' && b.result && b.result.started, b && (b.message || b.log.join(' | ')));
  const j2 = jobs(u);
  check("the app's hub service is stopped and removed", !j2['dev.ravenry.hub'] && !fs.existsSync(path.join(u.home, 'Library', 'LaunchAgents', 'dev.ravenry.hub.plist')), JSON.stringify(j2));
  check('the login start is back, the same file, and loaded', !!j2[LABEL] && fs.readFileSync(plist, 'utf8') === plistBefore);
  check("Claude Code's hooks are the npm board's exact commands again", JSON.stringify(hookCmds(readJson(path.join(u.home, '.claude', 'settings.json')))) === JSON.stringify(hookCmds(claudeBefore)), JSON.stringify(hookCmds(readJson(path.join(u.home, '.claude', 'settings.json')))));
  check("Codex's hooks and trust entries are the npm board's again", JSON.stringify(hookCmds(readJson(path.join(u.home, '.codex', 'hooks.json')))) === JSON.stringify(hookCmds(codexBefore)) && fs.readFileSync(path.join(u.home, '.codex', 'config.toml'), 'utf8') === configBefore);
  const back = await seen(u.url);
  check('the npm board serves everything again, the idea made in the app too', JSON.stringify({ ...back, ideas: back.ideas.filter((n) => n !== 'Made in the app') }) === JSON.stringify(before) && back.ideas.includes('Made in the app'), JSON.stringify(back));
  const madeBack = ((await api(u.url, 'GET', '/api/ideas')).ideas || []).find((i) => i.name === 'Made in the app');
  const pic2 = madeBack && madeBack.img ? await fetch(u.url + madeBack.img) : null;
  check("the app's idea picture is where the npm board reads it", !!pic2 && pic2.ok);
  check('switch.json says back', readJson(path.join(u.home, '.ravenry', 'switch.json')).state === 'back');
  // Stop the board launchd started.
  spawnSync(process.execPath, [path.join(HERE, 'fake-launchctl.mjs'), 'bootout', `gui/${process.getuid()}/${LABEL}`], { env: u.env });
}

// ------------------------------------------------------------ by hand

async function byHandCase() {
  console.log('\n== the board was started by hand, with no login start');
  const root = path.join(OUT, 'by-hand');
  const u = await makeNpmUser(root, { pkgDir: PKG_DIR, login: false, log: (s) => console.log('  ' + s) });
  u.root = root;
  u.appData = path.join(root, 'app-data');
  const before = await seen(u.url);
  const pid = readJson(path.join(u.home, '.ravenry', 'board.json')).pid;
  // What the app must not touch: the data, the hook settings, LaunchAgents.
  const volatile = (rel) => /^\.ravenry\/logs\//.test(rel);
  const snap = () => ({ data: hashes(path.join(u.home, '.ravenry'), volatile), claude: hashes(path.join(u.home, '.claude')), codex: hashes(path.join(u.home, '.codex')), agents: hashes(path.join(u.home, 'Library'), (rel) => rel === path.join('Logs', 'Ravenry', 'app.log')) }); // the app's log of what it did is not a service
  const s0 = snap();
  const log = await runSteps(u, 'not-now', [
    { ready: true, timeout: 30000 },
    { until: view(`${R}.view().offer === 'screen'`), timeout: 30000 },
    { until: `!document.getElementById('start').hidden && document.querySelector('#start .sw [data-act=switch]') && /ravenry --no-open/.test(document.querySelector('#start .sw').textContent)`, timeout: 10000 },
    { shot: path.join(OUT, 'by-hand-1-screen.png') },
    { js: `${R}.notNow()` },
    { until: view(`${R}.view().offer === 'bar'`), timeout: 10000 },
    { sleep: 3000 },
    { shot: path.join(OUT, 'by-hand-2-not-now-bar.png') },
    // What needs the app's hub points at the npm board, which runs.
    { js: `document.querySelector('#side .brand .icon-btn').click()` },
    { until: `document.querySelector('#start:not([hidden]) .npm-ptr [data-act=open-board]') && /Starting a session needs the app's own hub/.test(document.querySelector('#start .npm-ptr').textContent)`, timeout: 10000 },
    { js: `document.querySelector('#side .m-foot').click()` },
    { until: `document.querySelector('#start:not([hidden]) .npm-ptr') && /Machines needs the app's own hub/.test(document.querySelector('#start .npm-ptr').textContent) && document.getElementById('machines').hidden`, timeout: 10000 },
    { save: { expr: `document.querySelector('#start .npm-ptr').textContent`, out: path.join(root, 'pointer-running.txt') } },
  ]);
  fs.writeFileSync(path.join(OUT, 'by-hand-not-now-app.log'), log);
  const s1 = snap();
  check('Not now: no file of the data changed', diff(s0.data, s1.data).length === 0, diff(s0.data, s1.data).join(', '));
  check("Not now: Claude Code's and Codex's settings are as they were", diff(s0.claude, s1.claude).length === 0 && diff(s0.codex, s1.codex).length === 0, [...diff(s0.claude, s1.claude), ...diff(s0.codex, s1.codex)].join(', '));
  check('Not now: no service and no login item written', diff(s0.agents, s1.agents).length === 0, diff(s0.agents, s1.agents).join(', '));
  check('Not now: launchd was asked nothing', calls(u).every((a) => a[0] === 'print'), JSON.stringify(calls(u)));
  check('Not now: what needs the app\'s hub (New session, Machines) points at the running npm board', /Do it on the npm board/.test(fs.readFileSync(path.join(root, 'pointer-running.txt'), 'utf8')));
  check('Not now: the npm board still runs and serves', alive(pid) && JSON.stringify(await seen(u.url)) === JSON.stringify(before));
  check('the app said why it starts no hub of its own', /npm board: running \(pid \d+/.test(log), log.slice(-1500));

  // Later, from the bar.
  const log2 = await runSteps(u, 'switch', [
    { ready: true, timeout: 30000 },
    { until: view(`${R}.view().offer === 'bar'`), timeout: 30000 },
    { until: `document.querySelector('#npm-bar:not([hidden]) [data-act=switch]')`, timeout: 10000 },
    { js: `document.querySelector('#npm-bar [data-act=switch]').click()` },
    { until: view(`['switched', 'error'].includes(${R}.view().phase)`), timeout: 120000 },
    { save: { expr: `${R}.view()`, out: path.join(root, 'switch-view.json') } },
  ]);
  fs.writeFileSync(path.join(OUT, 'by-hand-switch-app.log'), log2);
  const v = readJson(path.join(root, 'switch-view.json'));
  check('the switch from the bar ended switched', v && v.phase === 'switched', v && (v.message || v.log.join(' | ')));
  check('the board run by hand stopped', !alive(pid));
  check("the app's hub serves the same things", JSON.stringify(await seen(u.url)) === JSON.stringify(before));
  const log3 = await runSteps(u, 'back', [
    { ready: true, timeout: 30000 },
    { until: view(`${R}.view().detect && ${R}.view().detect.record && ${R}.view().detect.record.state === 'switched'`), timeout: 30000 },
    { js: `${R}.back()` },
    { until: view(`['back', 'error'].includes(${R}.view().phase)`), timeout: 120000 },
    { until: `document.querySelector('#npm-bar:not([hidden]) .code1') && document.querySelector('#npm-bar .code1').textContent === 'ravenry --no-open'`, timeout: 10000 },
    // No first-session form with nothing to run it: the main area says how to start the npm board.
    { until: `document.querySelector('#start:not([hidden]) .npm-ptr [data-act=copy]') && /ravenry --no-open/.test(document.querySelector('#start .npm-ptr').textContent) && !document.querySelector('#start .fl-go .btn.pri:not([data-act])')`, timeout: 10000 },
    { shot: path.join(OUT, 'by-hand-3-back-bar.png') },
    { save: { expr: `${R}.view()`, out: path.join(root, 'back-view.json') } },
  ]);
  fs.writeFileSync(path.join(OUT, 'by-hand-back-app.log'), log3);
  const b = readJson(path.join(root, 'back-view.json'));
  check('the way back ends with the board stopped and its command to start it as before', b && b.phase === 'back' && b.result && !b.result.started && /bin\/ravenry\.mjs --no-open$/.test(b.result.command || '') && b.result.again === 'ravenry --no-open', b && JSON.stringify(b.result));
  check("the app's hub is gone", !jobs(u)['dev.ravenry.hub'] && !fs.existsSync(path.join(u.home, '.ravenry', 'board.json')));
  // The person starts it as before.
  startNpmBoard(u.pkg, u.env, path.join(u.home, '.ravenry', 'logs', 'board.out.log'));
  let again = null;
  for (let i = 0; i < 100 && !again; i++) { try { again = await seen(u.url); } catch { await sleep(150); } }
  check('started as before, the npm board shows everything', JSON.stringify(again) === JSON.stringify(before), JSON.stringify(again));
  stopBoard(u.home);
}

try {
  await loginCase();
  await byHandCase();
} catch (e) {
  fails++;
  console.error(e.stack || e.message);
} finally {
  for (const c of ['login', 'by-hand']) {
    const home = path.join(OUT, c, 'home');
    stopBoard(home);
    const j = readJson(path.join(OUT, c, 'launchd', 'jobs.json')) || {};
    for (const job of Object.values(j)) { try { process.kill(job.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
}
console.log(fails ? `\nnpm-switch: ${fails} check(s) failed (${OUT})` : `\nnpm-switch: every check passed (${OUT})`);
process.exit(fails ? 1 : 0);
