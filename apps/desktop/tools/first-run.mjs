#!/usr/bin/env node
// Measures the first run of a packaged app, the "try it in 30 seconds"
// promise: a person opens the downloaded app for the first time and must
// reach a working session with no terminal command. Offscreen, in a
// throwaway HOME that holds only what a new user's Mac would: a project
// folder in ~/code and a stand-in `claude` in ~/.local/bin
// (tools/stand-in-claude.sh: it runs its SessionStart hooks as Claude Code
// does, then draws a banner and a prompt, so no account and no quota are
// used), and no folder of ~/.local/bin on the PATH, as for an app started
// from the Finder.
//
//   node tools/first-run.mjs APP [OUT] [--runs N] [--budget MS]
//
// APP is Ravenry.app (or a .dmg, mounted with hdiutil, never in Finder).
// Two cold runs, each in a fresh HOME, app data folder and daemon runtime
// folder (no daemon and no hub running before):
//
//   shell:   launch, then New Shell, until its first prompt is on screen
//   session: launch, then the first-launch screen's Start Claude in <folder>
//            (with its hook offer accepted first, as a person would), until
//            the stand-in's prompt is on screen and the session is in the
//            sidebar
//
// The app installs its hub service in dry-run mode here (no launchd or
// systemd command runs); this tool starts the hub exactly as the written
// service says the moment the file appears, as launchd would on bootstrap,
// on a spare port (never :4600). Each milestone is the time since the app
// was started, in ms. Results go to OUT/first-run.json.
import { guardSpawns, isTestPath } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

guardSpawns();
const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const RUNS = Number(opt('--runs') || 1);
// Fails when a run reaches its working session later than this (ms).
const BUDGET = Number(opt('--budget') || 30000);
const pos = argv.filter((a) => !a.startsWith('--'));
if (!pos[0]) { console.error('usage: first-run.mjs APP [OUT] [--runs N]'); process.exit(2); }
const APP_PATH = path.resolve(pos[0]);
const OUT = path.resolve(pos[1] || path.join(os.tmpdir(), 'ravenry-first-run'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const SCRATCH = isTestPath(OUT) ? OUT : fs.mkdtempSync(path.join(os.tmpdir(), 'ravenry-first-run-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];

let target = APP_PATH;
if (APP_PATH.endsWith('.dmg')) {
  const mnt = path.join(SCRATCH, '.mnt');
  fs.mkdirSync(mnt, { recursive: true });
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, APP_PATH], { stdio: 'ignore' });
  cleanups.push(() => spawnSync('hdiutil', ['detach', mnt, '-quiet']));
  target = path.join(mnt, 'Ravenry.app');
}
// A Mac app, or Linux's unpacked folder (electron-builder's linux-unpacked).
const exe = process.platform === 'darwin' ? path.join(target, 'Contents', 'MacOS', 'Ravenry') : fs.statSync(target).isDirectory() ? path.join(target, 'ravenry') : target;
if (!fs.existsSync(exe)) { console.error(`first-run: no executable at ${exe}`); process.exit(1); }

const spare = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// A new user's home: a project folder and a stand-in Claude Code, signed in.
function makeHome(home) {
  const proj = path.join(home, 'code', 'weather-api');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# weather-api\n');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'stand-in-claude.sh'), path.join(bin, 'claude'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' } }));
  return proj;
}

async function oneRun(kind, n) {
  const name = `${kind}-${n}`;
  const work = path.join(SCRATCH, name);
  const home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'rvf-'));
  fs.chmodSync(rt, 0o700);
  const data = path.join(work, 'data');
  const state = path.join(work, 'state');
  const proj = makeHome(home);
  const port = await spare();
  if (port === 4600) throw new Error('refusing :4600');
  const marks = path.join(work, 'marks.json');
  const R = 'window.__ravenry';
  const has = (s) => `${R}.text().includes(${JSON.stringify(s)})`;
  const mark = (k) => ({ js: `(window.__marks = window.__marks || {})[${JSON.stringify(k)}] = Date.now()` });
  const startBtn = `document.querySelector('#start .fl-go .btn.pri')`;
  const steps = [
    { ready: true, timeout: 30000 }, mark('window'),
    { until: `!document.getElementById('start').hidden && ${startBtn} && /^Start Claude in /.test(${startBtn}.textContent)`, timeout: 30000 }, mark('screen'),
    { shot: path.join(OUT, `${name}-first-launch.png`) },
  ];
  if (kind === 'shell') {
    steps.push(
      { js: `${R}.newShell()` },
      { until: `${R}.term().ready && ${R}.S.tabs.length === 1 && ${R}.term().attached.pane === ${R}.S.tabs[0].pane && /[%$#] *$/m.test(${R}.text())`, timeout: 30000 }, mark('prompt'),
      { shot: path.join(OUT, `${name}-prompt.png`) },
    );
  } else {
    steps.push(
      // The hub answers, so the session starts through it (in the sidebar, with its hooks).
      { until: `${R}.S.hubStatus && ${R}.S.hubStatus.reachable`, timeout: 30000 }, mark('hub'),
      // The hook offer, accepted as a person would, when it shows.
      // It shows once the hub answered the dry run (up to 10 s here; none when nothing would change).
      { js: `new Promise((r) => { const t0 = Date.now(); const f = () => { const b = document.querySelector('#start .fl-hooks .btn.pri'); if (b) { b.click(); r(true); } else if (Date.now() - t0 > 10000) r(false); else setTimeout(f, 20); }; f(); })` },
      { until: `!document.querySelector('#start .fl-hooks') || ${R}.S.hooks.asked`, timeout: 15000 }, mark('hooks'),
      { js: `${startBtn}.click()` }, mark('click'),
      { until: `${R}.term().ready && ${has('Welcome to Claude Code')} && /^> *$/m.test(${R}.text())`, timeout: 30000 }, mark('claude'),
      { until: `document.querySelector('#side .grp .ss, #side .grp .idl')`, timeout: 15000 }, mark('sidebar'),
      // No tab says its name twice (a session named after its folder: "weather-api weather-api").
      { until: `document.querySelector('#tabs .tab .n') && [...document.querySelectorAll('#tabs .tab')].every((t) => { const p = t.querySelector('.p'); return !p || p.textContent.trim().toLowerCase() !== t.querySelector('.n').textContent.trim().toLowerCase(); })`, timeout: 5000 },
      { shot: path.join(OUT, `${name}-session.png`) },
    );
  }
  steps.push({ save: { expr: 'window.__marks', out: marks } });

  // The hub, started as the written service says the moment it appears (launchd would).
  let hub = null, hubLog = '', hubAt = null, stop = false;
  const plist = path.join(home, 'Library', 'LaunchAgents', 'gg.ravenry.hub.plist');
  const unit = path.join(home, '.config', 'systemd', 'user', 'ravenry-hub.service');
  const watcher = (async () => {
    while (!stop) {
      if (fs.existsSync(plist) || fs.existsSync(unit)) break;
      await sleep(20);
    }
    if (stop) return;
    let svcExe, svcArgs, svcEnv;
    if (fs.existsSync(plist)) {
      await sleep(20);
      const j = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
      [svcExe, ...svcArgs] = j.ProgramArguments;
      svcEnv = j.EnvironmentVariables;
    } else {
      await sleep(20);
      const t = fs.readFileSync(unit, 'utf8');
      const unq = (s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\$\$/g, '$').replace(/%%/g, '%');
      [svcExe, ...svcArgs] = /^ExecStart=(.*)$/m.exec(t)[1].match(/"(?:\\.|[^"\\])*"/g).map(unq);
      svcEnv = Object.fromEntries([...t.matchAll(/^Environment=(".*")$/gm)].map((m) => { const kv = unq(m[1]); const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    }
    hubAt = Date.now();
    hub = spawn(svcExe, svcArgs, {
      // Its agent status channel on (sessions reach the sidebar through it);
      // never this machine's own cmux, iTerm2 or Rex.
      env: { ...svcEnv, HOME: home, RAVENRY_HOME: path.join(home, '.ravenry'), PORT: String(port), RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state, RAVENRY_NO_OPEN: '1', CMUX_BIN: '/usr/bin/false', ITERM_OSASCRIPT_BIN: '/usr/bin/false', RAVENRY_REX_BIN: 'none', MC_APPS: 'none' },
      cwd: path.dirname(path.dirname(svcArgs[0])), stdio: ['ignore', 'pipe', 'pipe'],
    });
    hub.stdout.on('data', (d) => { hubLog += d; });
    hub.stderr.on('data', (d) => { hubLog += d; });
  })();

  const t0 = Date.now();
  let log = '';
  let err = null;
  try {
    log = await runApp({
      name, work, rt, home, exe, hubUrl: `http://127.0.0.1:${port}`, steps, width: 1440, height: 900,
      shell: '',
      env: { SHELL: fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash', RAVENRY_SERVICE: 'dry-run', RAVENRY_DESKTOP_DATA: data, RAVENRY_STATE_DIR: state },
      timeoutMs: 120000,
    });
  } catch (e) { err = e; }
  stop = true;
  await watcher;
  fs.writeFileSync(path.join(OUT, `${name}-app.log`), log || String(err && err.message));
  fs.writeFileSync(path.join(OUT, `${name}-hub.log`), hubLog);
  if (hub) hub.kill('SIGTERM');
  const link = path.join(data, 'bin', 'ravenryd');
  try { stopDaemons(link, rt); } catch { /* none */ }
  fs.rmSync(rt, { recursive: true, force: true });
  if (fs.existsSync(path.join(home, '.stand-in-refused'))) throw new Error(`${name}: a hook would have started the app itself: ${fs.readFileSync(path.join(home, '.stand-in-refused'), 'utf8')}`);
  if (err) throw err;
  const m = JSON.parse(fs.readFileSync(marks, 'utf8'));
  const rel = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v - t0]));
  if (hubAt) rel.hubStarted = hubAt - t0;
  return rel;
}

const results = { app: APP_PATH, at: new Date().toISOString(), machine: `${os.cpus()[0]?.model || ''}, ${os.platform()} ${os.release()}`, runs: [] };
try {
  for (let n = 1; n <= RUNS; n++) {
    for (const kind of ['shell', 'session']) {
      const r = await oneRun(kind, n);
      results.runs.push({ kind, ...r });
      console.log(`first-run: ${kind} #${n}: ${Object.entries(r).map(([k, v]) => `${k} ${v} ms`).join(', ')}`);
    }
  }
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
  fs.writeFileSync(path.join(OUT, 'first-run.json'), JSON.stringify(results, null, 2) + '\n');
}
const over = results.runs.filter((r) => (r.kind === 'shell' ? r.prompt : r.sidebar) > BUDGET);
if (over.length) { console.error(`first-run: over the ${BUDGET} ms budget: ${JSON.stringify(over)}`); process.exit(1); }
console.log(`first-run: every run reached a working session within ${BUDGET} ms (${OUT}/first-run.json)`);
