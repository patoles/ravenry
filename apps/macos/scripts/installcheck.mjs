#!/usr/bin/env node
// The install check: the packaged native app (scripts/package.mjs) as the
// one Ravenry on a Mac, run off every screen in throwaway HOMEs, its hub
// service loaded into the real launchd under a label of the check's own
// (dev.ravenry.hub.test-<random>, never dev.ravenry.hub) and booted out at
// the end, whatever happens, as apps/desktop/tools/release-check.mjs does
// for the Electron app. ps, lsof, cmux, open and osascript are the hub's
// stand-ins; nothing runs the real claude.
//
//   node scripts/installcheck.mjs NATIVE_APP ELECTRON_APP OLD_RAVENRYD [OUT]
//
// NATIVE_APP    build/package/Ravenry.app
// ELECTRON_APP  the Electron build the person has installed
//               (apps/desktop/release/mac-arm64/Ravenry.app)
// OLD_RAVENRYD  a ravenryd of an older version (apps/desktop/scripts/
//               build-ravenryd.sh OUT 0.1.22), standing for a daemon left
//               from an update before
//
// fresh   a Mac with no Ravenry: the app copies its ravenryd and hub to
//         versions/<version>, links bin/, installs the hub service (run as
//         the app's executable, which runs its Node), the hub answers and
//         points current/ at its folder, the app starts its own daemon,
//         its window opens a shell on it and draws it, typed text is drawn,
//         and the hooks (as the hub writes them on this app, and as the
//         Electron app wrote them) run.
// update  a Mac where the Electron app is installed and ran: its version
//         folder, bin/, its hub service running on the Electron executable,
//         its daemon with three shells, an older daemon with a shell, its
//         hooks. The native app replaces the Electron app at the same
//         path: the Electron app's hooks run on it at once, before it is
//         launched; launched, it restages the version, the service is
//         rewritten and exactly one hub answers, on its Node; the window
//         opens on the running daemon (no new one) with its three shells
//         as tabs in the saved order, the one in front drawn; the older
//         daemon and its shell keep running and its folder is kept.
// access  while the hub waits for macOS's answer about ~/Documents (its
//         503 on every route, hub/server/access.mjs), the sidebar says so;
//         while it answers 503 "starting" (before its first read), the
//         sidebar says the board is starting (HUB-004).
// skill   (in fresh) a Ravenry skill a 0.1.33 app wrote, running
//         <app>/Contents/MacOS/ravenry, is written again by the hub service
//         at its start to run <data>/bin/ravenry, the old one kept; the
//         command it names prints the guide; one installed now (Codex's,
//         POST /api/setup/skills as Settings does) names bin/ravenry too.
//
// NATIVE_APP is the test twin (build/package/release-test/Ravenry.app): the
// release takes no --offscreen or RAVENRY_MAC_REPORT (Gate.swift).
import { guardSpawns, withStubMachine } from '../../../tools/test-env.mjs';
import { track, removeTree, checkLeft } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const HUB = path.join(REPO, 'hub');
const [NATIVE, ELECTRON, OLD] = process.argv.slice(2, 5).map((p, i) => p && (i === 0 ? testApp(p).app : path.resolve(p)));
if (!NATIVE || !ELECTRON || !OLD || !fs.existsSync(path.join(NATIVE, 'Contents', 'MacOS', 'node'))) {
  console.error('usage: node scripts/installcheck.mjs NATIVE_APP ELECTRON_APP OLD_RAVENRYD [OUT]');
  process.exit(2);
}
const OUT = path.resolve(process.argv[5] || path.join(REPO, '.tmp', 'installcheck'));
fs.mkdirSync(OUT, { recursive: true });
const BUILD = JSON.parse(fs.readFileSync(path.join(NATIVE, 'Contents', 'Resources', 'build.json'), 'utf8'));
const EBUILD = JSON.parse(fs.readFileSync(path.join(ELECTRON, 'Contents', 'Resources', 'build.json'), 'utf8'));
const UID = process.getuid();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const launchctl = (...a) => spawnSync('/bin/launchctl', a, { encoding: 'utf8' });
const loaded = (label) => launchctl('print', `gui/${UID}/${label}`).status === 0;
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const results = { native: BUILD.id, electron: EBUILD.id, at: new Date().toISOString(), steps: [] };
const labels = [];
const accounts = [];
const apps = [];

function step(name, ok, detail = {}) {
  results.steps.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'pass' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail).slice(0, 600)}`}`);
}
async function until(fn, ms = 20000, every = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(every); }
}

// A throwaway Mac account (release-check.mjs account()): its HOME, data
// folder, runtime folder (with a space, as the real one has), ports,
// launchd label and the hub's stand-ins.
async function account(name) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `rvn${name[0]}-`)));
  const home = path.join(root, 'h');
  const data = path.join(home, 'Library', 'Application Support', 'Ravenry');
  const rt = path.join(root, 'App Support', 'run');
  for (const d of [data, rt, path.join(home, '.ravenry'), path.join(home, '.local', 'bin'), path.join(home, '.claude'), path.join(root, 'Applications')]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(rt, 0o700);
  fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='~ > '\n");
  // Nothing named claude runs but this stand-in, which says so and exits.
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "stand-in claude"\n', { mode: 0o755 });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const f of ['stub-ps.mjs', 'fake-cmux.mjs', 'stub-open.mjs', 'stub-osascript.mjs']) { fs.copyFileSync(path.join(HUB, 'tools', f), path.join(bin, f)); fs.chmodSync(path.join(bin, f), 0o755); }
  fs.writeFileSync(path.join(root, 'stub-ps.json'), '[]');
  fs.writeFileSync(path.join(root, 'fake-cmux.json'), JSON.stringify({ workspaces: [], screens: {} }));
  const label = `dev.ravenry.hub.test-${crypto.randomBytes(5).toString('hex')}`;
  labels.push(label);
  const port = await freePort();
  const env = withStubMachine({
    HOME: home, USER: os.userInfo().username, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir(),
    PATH: `${path.dirname(process.execPath)}:${path.join(home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: data, RAVENRY_HUB_URL: `http://127.0.0.1:${port}`, PORT: String(port), RAVENRY_PHONE_PORT: String(await freePort()),
    RAVENRY_SERVICE: 'install', RAVENRY_SERVICE_LABEL: label, RAVENRY_UPDATES: '0',
    MC_PS_BIN: path.join(bin, 'stub-ps.mjs'), MC_LSOF_BIN: path.join(bin, 'stub-ps.mjs'), STUB_PS_STATE: path.join(root, 'stub-ps.json'),
    CMUX_BIN: path.join(bin, 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(root, 'fake-cmux.json'), MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(bin, 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(root, 'open.jsonl'),
    MC_CODEX: '0', MC_PHONE_LAN: 'none', MC_REPEATS_AUTO: '0',
    MC_OSASCRIPT_BIN: path.join(bin, 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(bin, 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(root, 'osascript.jsonl'),
    MC_COPY_COMMAND: JSON.stringify(['/usr/bin/true']),
  });
  const a = { name, root, home, data, rt, label, port, env, app: path.join(root, 'Applications', 'Ravenry.app') };
  a.exe = path.join(a.app, 'Contents', 'MacOS', 'Ravenry');
  accounts.push(a);
  return a;
}

function retire(a) {
  if (loaded(a.label)) launchctl('bootout', `gui/${UID}/${a.label}`);
  try {
    for (const line of execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
      const m = line.trim().match(/^(\d+) (.*)$/);
      if (m && m[2].includes(a.root)) { try { process.kill(Number(m[1]), 'SIGTERM'); } catch { /* gone */ } }
    }
  } catch { /* none */ }
  // (Kept, its copy still leaves LaunchServices' list at the end.)
  if (process.env.IC_KEEP) return;
  // Its app copy out of LaunchServices' list first: lsregister -u cannot
  // name a copy once it is gone (tools/launchservices.mjs).
  try { removeTree(a.root); } catch { /* left */ }
}

const rvd = (a, args, bin = path.join(a.data, 'bin', 'ravenryd')) => execFileSync(bin, args, { env: a.env, encoding: 'utf8', cwd: a.home }).trim();
const hubState = async (a) => { try { const r = await fetch(`http://127.0.0.1:${a.port}/api/state`, { signal: AbortSignal.timeout(2000) }); return r.status === 200 ? await r.json() : null; } catch { return null; } };
const listeners = (port) => { try { return execFileSync('/usr/sbin/lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean); } catch { return []; } };
const commandOf = (pid) => spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
const parentOf = (pid) => Number(spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
const sockets = (a) => fs.readdirSync(a.rt).filter((f) => /^ravenryd-.*\.sock$/.test(f)).sort();
const daemonPids = (a) => execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().match(/^(\d+) (.*ravenryd serve.*)$/)).filter((m) => m && m[2].includes(a.root)).map((m) => Number(m[1]));

// The native app, off every screen, writing what its window shows to a report.
function launchNative(a, name) {
  const report = path.join(a.root, `${name}-report.json`);
  const log = fs.openSync(path.join(a.root, `${name}-app.log`), 'w');
  const p = spawn(a.exe, ['--offscreen'], { env: { ...a.env, RAVENRY_MAC_REPORT: report, RAVENRY_MAC_EVENTS_LOG: path.join(a.root, 'events.log'), RAVENRY_PRUNE_AFTER: '3' }, stdio: ['ignore', log, log] });
  apps.push(p);
  return { p, report: () => json(report) };
}

// A hook as an assistant runs it: through sh -c, the event on its stdin.
function runHook(a, command, sid) {
  const ev = JSON.stringify({ session_id: sid, hook_event_name: 'SessionStart', cwd: a.home, transcript_path: path.join(a.home, 't.jsonl'), source: 'startup' });
  const r = spawnSync('/bin/sh', ['-c', command], { input: ev, env: a.env, encoding: 'utf8', timeout: 15000 });
  const file = path.join(a.home, '.ravenry', 'events', `${sid}.jsonl`);
  return { status: r.status, err: (r.stderr || '').slice(0, 300), wrote: (read(file) || '').includes('SessionStart') };
}
// The hook commands the hub writes when it runs on `node` (hookinstall.mjs hookCommand).
function hubHookCommand(a, node) {
  const src = `import('${path.join(a.data, 'current', 'hub', 'server', 'hookinstall.mjs')}').then((m) => console.log(m.oursFor('claude', { root: '${path.join(a.data, 'current', 'hub')}' }).find((o) => o.script === 'events.mjs').command))`;
  return execFileSync(node, ['-e', src], { env: a.env, encoding: 'utf8' }).trim();
}
// As the Electron app wrote it: ELECTRON_RUN_AS_NODE=1 <the app's executable> <data>/current/hub/hooks/events.mjs.
const electronHook = (a) => `ELECTRON_RUN_AS_NODE=1 '${a.exe}' '${path.join(a.data, 'current', 'hub', 'hooks', 'events.mjs')}'`;

// IC_ONLY=fresh,access runs only those scenarios.
const only = (name) => !process.env.IC_ONLY || process.env.IC_ONLY.split(',').includes(name);
try {
  // ------------------------------------------------------------ fresh
  if (only('fresh')) {
    const a = await account('fresh');
    execFileSync('/usr/bin/ditto', [NATIVE, a.app]);
    // The skill a 0.1.33 app wrote: its command inside the app.
    const oldStub = path.join(a.home, '.claude', 'skills', 'ravenry', 'SKILL.md');
    fs.mkdirSync(path.dirname(oldStub), { recursive: true });
    const oldText = `---\nname: ravenry\ndescription: Use Ravenry's terminals from the command line.\nmetadata:\n  ravenry-stub: "1"\n  ravenry-version: "0.1.33"\n---\n<!-- Installed by Ravenry. Remove it in Ravenry: Settings, Skills. -->\n\nRun \`"${path.join(a.app, 'Contents', 'MacOS', 'ravenry')}" skill\` and follow the guide it prints.\n`;
    fs.writeFileSync(oldStub, oldText);
    const t0 = Date.now();
    const n = launchNative(a, 'fresh');
    const r = await until(() => { const x = n.report(); return x && x.focused && x.focused.draws > 0 && /~ >/.test(x.focused.text) ? x : null; }, 30000);
    step('fresh: the window opens a shell on a daemon the app started, and draws its prompt', !!r && r.tabs.length === 1 && r.daemon === BUILD.version, { report: r, ms: Date.now() - t0 });
    const st = await until(() => hubState(a), 90000, 500);
    const v = path.join(a.data, 'versions', BUILD.version);
    step('fresh: ravenryd and the hub copied to versions/<version>, bin/ravenryd and bin/ravenry linked to it', json(path.join(v, '.build.json'))?.id === BUILD.id && real(path.join(a.data, 'bin', 'ravenryd')) === real(path.join(v, 'ravenryd')) && real(path.join(a.data, 'bin', 'ravenry')) === real(path.join(v, 'ravenryd')), { marker: json(path.join(v, '.build.json')), bin: real(path.join(a.data, 'bin', 'ravenryd')) });
    const plist = read(path.join(a.home, 'Library', 'LaunchAgents', `${a.label}.plist`)) || '';
    const lis = listeners(a.port);
    const hubCmd = lis.length ? commandOf(lis[0]) : '';
    const sup = lis.length ? commandOf(parentOf(lis[0])) : '';
    step('fresh: the hub service is installed and loaded, run as the app\'s executable (ELECTRON_RUN_AS_NODE=1), which runs the hub on the app\'s Node as its child; the hub answers', !!st && loaded(a.label) && plist.includes(`<string>${a.exe}</string>`) && plist.includes('ELECTRON_RUN_AS_NODE') && lis.length === 1 && hubCmd.startsWith(path.join(a.app, 'Contents', 'MacOS', 'node')) && sup.startsWith(a.exe), { hub: hubCmd, parent: sup, listeners: lis });
    step('fresh: the hub pointed current/ at its version folder', real(path.join(a.data, 'current')) === real(v), { current: real(path.join(a.data, 'current')) });
    const sock = sockets(a);
    const pane = r && r.focused.pane;
    let typed = null;
    if (pane) {
      rvd(a, ['send', pane, '--raw', 'echo native-$((6*7))\r']);
      typed = await until(() => { const x = n.report(); return x && /native-42/.test(x.focused.text) ? x : null; }, 10000);
    }
    step('fresh: one daemon, of this version, runs; a line typed in its pane is drawn by the window', sock.length === 1 && sock[0] === `ravenryd-${BUILD.version}.sock` && !!typed, { sockets: sock, text: typed && typed.focused.text.slice(0, 300) });
    const node = path.join(a.app, 'Contents', 'MacOS', 'node');
    const newHook = hubHookCommand(a, node);
    const h1 = runHook(a, newHook, 'freshhook001');
    const h2 = runHook(a, electronHook(a), 'freshhook002');
    step('fresh: the hooks run: as the hub writes them on this app (its Node), and as the Electron app wrote them (its executable as Node)', h1.wrote && h1.status === 0 && h2.wrote && h2.status === 0, { newHook, h1, h2 });
    // The skill: the old stub written again at the hub's start, its command the guide.
    const binRavenry = path.join(a.data, 'bin', 'ravenry');
    const stubCmd = (f) => (/^Run `"([^"`]+)" skill`/m.exec(read(f) || '') || [])[1] || null;
    // (By real folder: the hub names /private/var where the check says /var.)
    const isBin = (c) => !!c && path.basename(c) === 'ravenry' && real(path.dirname(c)) === real(path.dirname(binRavenry));
    const fixed = await until(() => isBin(stubCmd(oldStub)), 20000, 250);
    const guide = fixed ? spawnSync(stubCmd(oldStub), ['skill'], { env: a.env, encoding: 'utf8' }) : null;
    const backups = fs.existsSync(path.join(a.home, '.ravenry', 'skills-backup')) ? fs.readdirSync(path.join(a.home, '.ravenry', 'skills-backup')) : [];
    step('skill: a 0.1.33 stub running <app>/Contents/MacOS/ravenry is written again at the hub\'s start to run <data>/bin/ravenry (the old one kept), which prints the guide; its description says it makes pages', !!fixed && guide?.status === 0 && /^# Ravenry/.test(guide.stdout) && /make pages in Ravenry's sidebar/.test(read(oldStub) || '') && backups.some((f) => f.startsWith('claude-SKILL.md.')) && read(path.join(a.home, '.ravenry', 'skills-backup', backups[0])) === oldText, { stub: read(oldStub), backups, guide: guide && guide.stdout.slice(0, 80) });
    const oldGuide = spawnSync(path.join(a.app, 'Contents', 'MacOS', 'ravenry'), ['skill'], { env: a.env, encoding: 'utf8' });
    step('skill: <app>/Contents/MacOS/ravenry (the old stub\'s command) is the ravenry command too', oldGuide.status === 0 && /^# Ravenry/.test(oldGuide.stdout), { status: oldGuide.status, out: (oldGuide.stdout || oldGuide.stderr).slice(0, 120) });
    const inst = await fetch(`http://127.0.0.1:${a.port}/api/setup/skills`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ kind: 'codex', on: true, ravenryd: path.join(a.data, 'bin', 'ravenryd'), version: BUILD.version }) });
    const codexStub = path.join(a.home, '.codex', 'skills', 'ravenry', 'SKILL.md');
    const cg = stubCmd(codexStub) ? spawnSync(stubCmd(codexStub), ['skill'], { env: a.env, encoding: 'utf8' }) : null;
    step('skill: installed now (POST /api/setup/skills, as Settings), it runs <data>/bin/ravenry, and that command prints the guide', inst.status === 200 && isBin(stubCmd(codexStub)) && cg?.status === 0 && /^# Ravenry/.test(cg.stdout), { status: inst.status, cmd: stubCmd(codexStub) });
    const logText = read(path.join(a.home, 'Library', 'Logs', 'Ravenry', 'app.log')) || '';
    step('fresh: app.log says what the app did (staged, daemon started, service installed)', /launch: native app/.test(logText) && /daemon: starting this app's/.test(logText) && /service: installed/.test(logText), { log: logText.split('\n').slice(-8) });
    n.p.kill('SIGTERM');
    await sleep(500);
    step('fresh: quitting the window leaves the daemon, its pane and the hub running', daemonPids(a).length === 1 && !!(await hubState(a)) && rvd(a, ['ls', '--json']).includes(pane || 'none'), { daemons: daemonPids(a) });
    retire(a);
  }

  // ------------------------------------------------------------ update
  if (only('update')) {
    const a = await account('update');
    // The Electron app installed and run: its own setup (install.ts, the same
    // code the native app's setup.mjs runs) with the Electron app's resources
    // and executable, its daemon with three shells, an older daemon with one.
    execFileSync('/usr/bin/ditto', [ELECTRON, a.app]);
    const setup = path.join(NATIVE, 'Contents', 'Resources', 'setup.mjs');
    const node = path.join(NATIVE, 'Contents', 'MacOS', 'node');
    const eRes = path.join(a.app, 'Contents', 'Resources');
    const before = JSON.parse(execFileSync(node, [setup, 'hub', '--resources', eRes, '--exe', a.exe], { env: a.env, encoding: 'utf8', timeout: 150000 }).trim().split('\n').pop());
    const eHub = await until(() => hubState(a), 60000, 500);
    const ePid = listeners(a.port)[0];
    step('update (before): the Electron app\'s layout: versions/<version> of its build, its hub service running on the Electron executable', before.ok && before.service === 'installed' && !!eHub && commandOf(ePid).startsWith(a.exe) && json(path.join(a.data, 'versions', EBUILD.version, '.build.json'))?.id === EBUILD.id, { before, hub: ePid && commandOf(ePid) });
    const oldDir = path.join(a.data, 'versions', '0.1.22');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.copyFileSync(OLD, path.join(oldDir, 'ravenryd'));
    fs.chmodSync(path.join(oldDir, 'ravenryd'), 0o755);
    fs.writeFileSync(path.join(oldDir, '.build.json'), JSON.stringify({ version: '0.1.22', id: '0.1.22+old' }));
    rvd(a, ['serve', '--detach'], path.join(oldDir, 'ravenryd'));
    const oldSock = path.join(a.rt, 'ravenryd-0.1.22.sock');
    await until(() => fs.existsSync(oldSock), 5000, 50);
    const oldPane = rvd(a, ['new', '--socket', oldSock, '--name', 'old', '--label', 'ravenry.kind=shell', '--', '/bin/zsh']).split(/\s+/)[0];
    rvd(a, ['serve', '--detach'], path.join(a.data, 'versions', EBUILD.version, 'ravenryd'));
    const sock = path.join(a.rt, `ravenryd-${EBUILD.version}.sock`);
    await until(() => fs.existsSync(sock), 5000, 50);
    const daemonsBefore = daemonPids(a);
    const panes = ['one', 'two', 'three'].map((nm) => rvd(a, ['new', '--socket', sock, '--name', nm, '--size', '100x30', '--label', 'ravenry.kind=shell', '--', '/bin/zsh']).split(/\s+/)[0]);
    await sleep(800);
    rvd(a, ['send', '--socket', sock, panes[1], '--raw', 'echo in-pane-two\r']);
    // The saved order (window-<daemon>.json for a runtime folder that is
    // not the person's): two, three, one, two in front.
    // (The app names the folder as Foundation resolves it: /var, not /private/var.)
    const id = crypto.createHash('sha256').update(fs.realpathSync(a.rt).replace(/^\/private(?=\/(var|tmp|etc)\/)/, '')).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(a.data, `window-${id}.json`), JSON.stringify({ order: [`s:${panes[1]}`, `s:${panes[2]}`, `s:${panes[0]}`], splits: [], active: `s:${panes[1]}`, pinned: [] }, null, 2));
    // The native app replaces the Electron app at the same path.
    removeTree(a.app);
    execFileSync('/usr/bin/ditto', [NATIVE, a.app]);
    const h0 = runHook(a, electronHook(a), 'updhook0001');
    step('update: right after the swap, before the native app runs, the Electron app\'s hooks run on the native executable', h0.wrote && h0.status === 0, h0);
    const n = launchNative(a, 'update');
    const r = await until(() => { const x = n.report(); return x && x.tabs.length === 3 && x.focused.draws > 0 && /in-pane-two/.test(x.focused.text) ? x : null; }, 30000);
    step('update: the window opens on the running daemon (no new one), its three shells as tabs in the saved order, the one in front drawn with what it showed', !!r && r.daemon === EBUILD.version && JSON.stringify(r.tabs.map((t) => t.host)) === JSON.stringify([panes[1], panes[2], panes[0]]) && r.front === panes[1], { report: r && { ...r, focused: { ...r.focused, text: r.focused.text.slice(0, 200) } }, panes });
    const done = await until(async () => {
      const lis = listeners(a.port);
      const plist = read(path.join(a.home, 'Library', 'LaunchAgents', `${a.label}.plist`)) || '';
      return lis.length === 1 && commandOf(lis[0]).startsWith(path.join(a.app, 'Contents', 'MacOS', 'node')) && plist.includes(BUILD.id) && (await hubState(a)) ? { lis, plist } : null;
    }, 120000, 500);
    const lis = listeners(a.port);
    step('update: the service is rewritten for this build and exactly one hub answers, on the app\'s Node; the Electron hub is gone', !!done && lis.length === 1 && !lis.includes(ePid), { hub: lis.map(commandOf), parent: lis.map((p) => commandOf(parentOf(p))), electronHub: ePid });
    const v = path.join(a.data, 'versions', EBUILD.version);
    step('update: versions/<version> holds this build now, bin/ and current/ point at it', json(path.join(v, '.build.json'))?.id === BUILD.id && real(path.join(a.data, 'bin', 'ravenryd')) === real(path.join(v, 'ravenryd')) && real(path.join(a.data, 'current')) === real(v), { marker: json(path.join(v, '.build.json')), current: real(path.join(a.data, 'current')) });
    await sleep(5000); // the prune runs 3 s after the service (RAVENRY_PRUNE_AFTER)
    const after = daemonPids(a);
    step('update: every daemon that ran before still runs (none started), the older one\'s shell too, and its version folder is kept', JSON.stringify(after.sort()) === JSON.stringify(daemonsBefore.sort()) && sockets(a).length === 2 && rvd(a, ['ls', '--socket', oldSock, '--json']).includes(oldPane) && fs.existsSync(path.join(oldDir, 'ravenryd')), { before: daemonsBefore, after, sockets: sockets(a) });
    const h1 = runHook(a, electronHook(a), 'updhook0002');
    const h2 = runHook(a, hubHookCommand(a, node), 'updhook0003');
    step('update: after the update the hooks still run, the Electron app\'s and the ones the hub now writes', h1.wrote && h2.wrote, { h1, h2 });
    n.p.kill('SIGTERM');
    retire(a);
  }

  // ------------------------------------------------------------ access
  if (only('access')) {
    const a = await account('access');
    execFileSync('/usr/bin/ditto', [NATIVE, a.app]);
    const srv = http.createServer((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ starting: true, waitingFor: '~/Documents', folder: 'Documents', error: 'macOS is asking' })); });
    await new Promise((r) => srv.listen(a.port, '127.0.0.1', r));
    a.env.RAVENRY_SERVICE = 'off';
    const n = launchNative(a, 'access');
    const r = await until(() => { const x = n.report(); return x && /macOS lets Ravenry read ~\/Documents/.test(x.sidebarEmpty || '') ? x : null; }, 20000);
    step('access: while macOS asks about ~/Documents, the sidebar says the sessions show up once it lets Ravenry read it', !!r, { sidebar: n.report()?.sidebarEmpty });
    n.p.kill('SIGTERM');
    srv.close();
    // HUB-004: before its first read the hub answers 503 "starting" (index.mjs /api/state) and a state with no generatedAt.
    const srv2 = http.createServer((req, res) => {
      if (req.url.startsWith('/api/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`event: state\ndata: ${JSON.stringify({ generatedAt: null, cmuxOk: false, error: 'starting', projects: [] })}\n\n`); return; }
      res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ generatedAt: null, starting: true, waitingFor: null, folder: null, error: 'Ravenry is starting: reading your projects.' }));
    });
    await new Promise((r) => srv2.listen(a.port, '127.0.0.1', r));
    const n2 = launchNative(a, 'starting');
    const r2 = await until(() => { const x = n2.report(); return x && /board is starting/.test(x.sidebarEmpty || '') ? x : null; }, 20000);
    step('starting: while the hub answers 503 "starting", the sidebar says the board is starting', !!r2, { sidebar: n2.report()?.sidebarEmpty });
    n2.p.kill('SIGTERM');
    srv2.close();
    retire(a);
  }
} finally {
  for (const p of apps) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const l of labels) if (loaded(l)) launchctl('bootout', `gui/${UID}/${l}`);
  for (let i = 0; i < 50 && labels.some(loaded); i++) await sleep(200);
  for (const a of accounts) retire(a);
  results.labelsLeft = labels.filter(loaded);
  // The guard: none of this run's app copies left in LaunchServices' list.
  results.launchServicesLeft = checkLeft('installcheck');
  fs.writeFileSync(path.join(OUT, 'installcheck.json'), JSON.stringify(results, null, 2) + '\n');
}
const failed = results.steps.filter((s) => !s.ok);
if (results.labelsLeft.length) console.log(`installcheck: test launchd label(s) still loaded: ${results.labelsLeft.join(', ')}`);
if (results.launchServicesLeft.length) console.log(`installcheck: app copies left in LaunchServices' list: ${results.launchServicesLeft.join(', ')}`);
console.log(failed.length ? `\ninstallcheck: ${failed.length} step(s) FAILED (${OUT}/installcheck.json)` : `\ninstallcheck: every step passed for ${BUILD.id} (${OUT}/installcheck.json)`);
process.exit(failed.length || results.labelsLeft.length || results.launchServicesLeft.length ? 1 : 0);
