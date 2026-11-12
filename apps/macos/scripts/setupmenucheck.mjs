#!/usr/bin/env node
// The Ravenry menu's Install the ravenry Command... and Uninstall Ravenry...
// (MachineMenu.swift, install/setup.ts command and uninstall), on a
// package's test twin off every screen, in throwaway HOMEs: its hub service
// run by the stand-in launchctl (apps/desktop/tools/fake-launchctl.mjs, on
// a free port of 127.0.0.1), an npm board's `ravenry` launcher (ravenry-app
// 0.4.0, a stand-in that prints its arguments) on the login shell's PATH.
// The menu items are pressed as a click does and the dialogs' buttons
// through Accessibility (ReportDriver.swift); what they did is read where it
// lands: a new login shell's `command -v ravenry` and what it runs, the
// files, the stand-in launchd's jobs, app.log.
//
//   node scripts/setupmenucheck.mjs PACKAGED_APP [OUT]
//
// line     ~/.local/bin is not first on the PATH (.zshrc puts the npm board's
//          folder first): the launch's toast offers it; Install links
//          ~/.local/bin/ravenry and adds two lines at the end of ~/.zshrc
//          (a backup made); a new terminal's ravenry is the app's (ravenry
//          skill says so), ravenry doctor still reaches the npm board's;
//          Remove puts ~/.zshrc back byte for byte. Then Uninstall Ravenry
//          with the data kept: the hooks Settings set up (Claude Code's and
//          Codex's) and the skills put back as they were, byte for byte, the
//          service unloaded and its file gone, bin/, current and versions/
//          gone, ~/.ravenry kept; Quit ends the app.
// link     ~/.local/bin first (as on the maintainer's Mac): Install adds the link only,
//          no line; Uninstall with the box ticked deletes the data too.
//
// Pictures of the dialogs go to OUT.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';
import { testEnv } from '../../desktop/tools/npm-board-fixture.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const { app: APP } = testApp(process.argv[2] || path.join(MAC, 'build', 'package', 'Ravenry.app'));
const EXE = path.join(APP, 'Contents', 'MacOS', 'Ravenry');
if (!fs.existsSync(path.join(APP, 'Contents', 'Resources', 'setup.mjs'))) { console.error('usage: node scripts/setupmenucheck.mjs PACKAGED_APP [OUT]'); process.exit(2); }
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'setupmenu.'));
const OUT = path.resolve(process.argv[3] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const results = [];
const holders = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); };
async function until(ms, f) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(150); } return null; }

/** A Mac with the npm board's launcher on the PATH and Claude Code and Codex set up by hand. */
async function makeHome(name, zshrc) {
  const root = path.join(tmp, name);
  const home = path.join(root, 'home');
  const pkg = path.join(home, 'npm', 'lib', 'node_modules', 'ravenry-app');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'npm', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"ravenry-app","version":"0.4.0"}\n');
  fs.writeFileSync(path.join(pkg, 'bin', 'ravenry.mjs'), '#!/bin/sh\necho "npm board: $*"\n', { mode: 0o755 });
  fs.symlinkSync('../lib/node_modules/ravenry-app/bin/ravenry.mjs', path.join(home, 'npm', 'bin', 'ravenry'));
  fs.writeFileSync(path.join(home, '.zshrc'), zshrc);
  fs.writeFileSync(path.join(home, '.zshenv'), 'skip_global_compinit=1\n');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/true # the person\'s own' }] }] } }, null, 2) + '\n');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-6"\n');
  const port = await freePort();
  const launchd = path.join(root, 'launchd');
  fs.mkdirSync(launchd, { recursive: true });
  const label = `dev.ravenry.hub.test-${crypto.randomBytes(4).toString('hex')}`;
  const env = {
    ...testEnv(home, port, { RAVENRY_LAUNCHCTL: path.join(REPO, 'apps', 'desktop', 'tools', 'fake-launchctl.mjs'), RAVENRY_FAKE_LAUNCHD: launchd }),
    SHELL: '/bin/zsh', RAVENRY_HUB_BIND: '127.0.0.1', RAVENRY_HUB_URL: `http://127.0.0.1:${port}`, MC_PHONE_LAN: 'none', RAVENRY_SERVICE: 'install', RAVENRY_SERVICE_LABEL: label,
    RAVENRY_DESKTOP_DATA: path.join(root, 'data'), RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'state'), RAVENRY_TEST_SINGLE: '1', RAVENRY_PRUNE_AFTER: '3',
  };
  fs.mkdirSync(env.RAVENRY_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(launchd, 'env.json'), JSON.stringify(env));
  // Two old version folders: one nothing names, one a running process names (UPD-013).
  for (const v of ['0.1.25', '0.1.22']) {
    fs.mkdirSync(path.join(env.RAVENRY_DESKTOP_DATA, 'versions', v, 'hub', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(env.RAVENRY_DESKTOP_DATA, 'versions', v, 'hub', 'hooks', 'events.mjs'), '// the hook\n');
    fs.writeFileSync(path.join(env.RAVENRY_DESKTOP_DATA, 'versions', v, 'ravenryd'), 'binary\n');
  }
  holders.push(spawn('/bin/sh', ['-c', 'sleep 300; :', path.join(env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.22', 'ravenryd')], { stdio: 'ignore' }));
  const before = { settings: read(path.join(home, '.claude', 'settings.json')), config: read(path.join(home, '.codex', 'config.toml')), zshrc: read(path.join(home, '.zshrc')) };
  return { root, home, env, port, label, launchd, before, url: `http://127.0.0.1:${port}` };
}

/** The app off every screen, driven through its report's command file. */
function launch(h) {
  const report = path.join(h.root, 'report.json');
  fs.rmSync(report + '.done', { force: true });
  const p = spawn(EXE, ['--offscreen'], { env: { ...h.env, RAVENRY_MAC_REPORT: report }, stdio: ['ignore', 'ignore', fs.openSync(path.join(h.root, 'app.err'), 'w')] });
  let n = 0;
  const done = report + '.done';
  return {
    p, report,
    async cmd(line, ms = 8000) {
      const want = ++n;
      fs.writeFileSync(report + '.do', line);
      const r = await until(ms, () => { const l = (read(done) || '').trim().split('\n').filter(Boolean); return l.length >= want ? JSON.parse(l[want - 1]) : null; });
      if (!r) throw new Error(`the app did not take "${line}"`);
      return r;
    },
  };
}
const appLog = (h) => read(path.join(h.home, 'Library', 'Logs', 'Ravenry', 'app.log')) || '';
const shell = (h, script) => spawnSync('/bin/zsh', ['-l', '-i', '-c', script], { env: { HOME: h.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: h.env.RAVENRY_RUNTIME_DIR, RAVENRY_STATE_DIR: h.env.RAVENRY_STATE_DIR }, encoding: 'utf8', timeout: 15000 });
const post = async (h, p, body) => { const r = await fetch(h.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { code: r.status, j: await r.json().catch(() => ({})) }; };
const loaded = (h) => { const j = json(path.join(h.launchd, 'jobs.json')) || {}; return !!(j[h.label] && j[h.label].loaded !== false && !j[h.label].unloaded); };

/** Samples, every 500 ms, the network sockets of the app, the hub service and every process they started (lsof). */
function watchNet(h, appPid) {
  const seen = new Map();
  let samples = 0, n = 0;
  const tree = () => {
    const rows = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const roots = [appPid, ...Object.values(json(path.join(h.launchd, 'jobs.json')) || {}).map((j) => j.pid).filter(Boolean)];
    const all = new Set(roots);
    for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (all.has(pp) && !all.has(p)) { all.add(p); grew = true; } }
    return [...all];
  };
  const t = setInterval(() => {
    const pids = tree();
    n = pids.length;
    const r = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-i'], { encoding: 'utf8' });
    samples++;
    for (const l of (r.stdout || '').split('\n').slice(1)) {
      const m = /^(\S+)\s.*\s(TCP|UDP)\s(\S+?)(?:->(\S+))?(?:\s\((\w+)\))?$/.exec(l.trim());
      if (m) seen.set(`${m[1]} ${m[3]} ${m[4] || ''}`, { cmd: m[1], local: m[3], remote: m[4] || null, state: m[5] || '' });
    }
  }, 500);
  return { stop: () => { clearInterval(t); return [...seen.values()]; }, get samples() { return samples; }, pids: () => n };
}

/** UPD-003, UPD-013: an update whose hub service does not start (launchd refuses it): no prune after it, tried again when the app comes to the front and at each launch, stopped after 3 with Try again. */
async function failedCase() {
  const h = await makeHome('failed', 'PROMPT="~ > "\n');
  const fl = path.join(h.root, 'refusing-launchctl');
  fs.writeFileSync(fl, '#!/bin/sh\necho "$@" >> "$0.log"\n[ "$1" = print ] && exit 113\necho "Bootstrap failed: 5: Input/output error" >&2\nexit 5\n', { mode: 0o755 });
  h.env = { ...h.env, RAVENRY_LAUNCHCTL: fl };
  // An install from before: the service names an older version's hub.
  const plist = path.join(h.home, 'Library', 'LaunchAgents', `${h.label}.plist`);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${h.label}</string><key>ProgramArguments</key><array><string>${path.join(h.env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.30', 'hub', 'server', 'index.mjs')}</string></array></dict></plist>\n`);
  const attempts = () => (appLog(h).match(/launch: update to [\d.]+, attempt \d/g) || []).map((x) => Number(x.slice(-1)));
  const failures = () => (appLog(h).match(/service: failed/g) || []).length;
  let a = launch(h);
  const f1 = await until(60000, () => failures() >= 1);
  await sleep(6000);
  check('failed_no_prune_after', f1 && exists(path.join(h.env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.25', 'ravenryd')) && !/install: removed versions/.test(appLog(h)),
    `attempts ${attempts().join(',')}; 0.1.25 whole ${exists(path.join(h.env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.25', 'ravenryd'))} 9 s after the failure (the prune comes 3 s after a setup that worked)`);
  await a.cmd('activate');
  const f2 = await until(60000, () => failures() >= 2);
  check('failed_retry_on_front', f2 && /tried again \(the app came to the front\)/.test(appLog(h)) && attempts().join(',') === '1,2', `attempts ${attempts().join(',')}`);
  a.p.kill('SIGTERM'); await until(10000, () => a.p.exitCode !== null);
  a = launch(h);
  await until(60000, () => failures() >= 3);
  check('failed_retry_at_launch', attempts().join(',') === '1,2,3', `attempts ${attempts().join(',')}`);
  a.p.kill('SIGTERM'); await until(10000, () => a.p.exitCode !== null);
  a = launch(h);
  const stopped = await until(30000, async () => { const s = await a.cmd('state'); return (s.toasts || []).find((x) => /did not start after 3 tries/.test(x)) || null; });
  check('failed_stops_after_3', stopped && /stopped after 3 failed attempts/.test(appLog(h)) && failures() === 3, stopped || `toasts: ${JSON.stringify((await a.cmd('state')).toasts)}`);
  if (stopped) {
    await a.cmd('toast Try again');
    const again = await until(60000, () => /update tried again from the window/.test(appLog(h)) && failures() >= 4);
    check('failed_try_again', again && attempts().slice(-1)[0] === 1, `attempts ${attempts().join(',')}`);
  }
  a.p.kill('SIGTERM'); await until(10000, () => a.p.exitCode !== null);
}

async function runCase(name, zshrc, purge) {
  const h = await makeHome(name, zshrc);
  const a = launch(h);
  try {
    const bin = path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenry');
    // The board up (the service, by the stand-in launchd), the window on it.
    const up = await until(30000, async () => { try { return (await fetch(h.url + '/api/state')).ok; } catch { return false; } });
    check(`${name}_service_board`, up && exists(bin), `the board on ${h.url}: ${!!up}; ${bin}: ${exists(bin)}`);
    const net = watchNet(h, a.p.pid);
    // What Settings sets up: the hooks (Claude Code's and Codex's) and the skill for both.
    const hk = await post(h, '/api/setup/hooks', { ravenryd: path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenryd') });
    const sk1 = await post(h, '/api/setup/skills', { kind: 'claude', on: true, ravenryd: path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenryd'), version: '0.1.36' });
    const sk2 = await post(h, '/api/setup/skills', { kind: 'codex', on: true, ravenryd: path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenryd'), version: '0.1.36' });
    const set = read(path.join(h.home, '.claude', 'settings.json'));
    const codexSkill = read(path.join(h.home, '.codex', 'skills', 'ravenry', 'SKILL.md'));
    check(`${name}_set_up_like_settings`, hk.code === 200 && sk1.code === 200 && sk2.code === 200 && set.includes('bin/ravenryd') && !!codexSkill && exists(path.join(h.home, '.codex', 'hooks.json')),
      `hooks ${hk.code}, skills ${sk1.code} ${sk2.code}`);
    // Each skill's command (Claude Code's and Codex's SKILL.md) runs and prints the guide.
    for (const [who, f] of [['claude', path.join(h.home, '.claude', 'skills', 'ravenry', 'SKILL.md')], ['codex', path.join(h.home, '.codex', 'skills', 'ravenry', 'SKILL.md')]]) {
      const skillCmd = (/^Run `"([^"`]+)" skill`/m.exec(read(f) || '') || [])[1];
      const guide = skillCmd ? spawnSync(skillCmd, ['skill'], { env: { HOME: h.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }) : null;
      check(`${name}_${who}_skill_runs`, guide && guide.status === 0 && /ravenry new/.test(guide.stdout) && skillCmd === bin, skillCmd ? `${skillCmd} skill: exit ${guide.status}, ${guide.stdout.split('\n')[0]}` : 'no command in the SKILL.md');
    }
    // Codex itself lists the skill it finds in its home (codex debug prompt-input: no model call), when Codex is on this Mac.
    const codexBin = spawnSync('/bin/sh', ['-c', 'command -v codex'], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).stdout.trim();
    if (codexBin) {
      const pi = spawnSync(codexBin, ['debug', 'prompt-input', 'hi'], { env: { HOME: h.home, CODEX_HOME: path.join(h.home, '.codex'), PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 });
      const line = ((pi.stdout || '').match(/- ravenry: [^\\]*\(file: [^)]*ravenry\/SKILL\.md\)/) || [])[0];
      check(`${name}_codex_lists_skill`, !!line, line || `codex debug prompt-input: exit ${pi.status}`);
    }
    // The prune a few seconds after the service is set up (RAVENRY_PRUNE_AFTER=3 for the minute): the folder nothing names goes, the one a process names stays.
    const pruned = await until(15000, () => exists(path.join(h.env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.25', 'REMOVED')));
    check(`${name}_prune_after_launch`, pruned && exists(path.join(h.env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.22', 'ravenryd')) && /install: removed versions nothing runs from: 0\.1\.25/.test(appLog(h)),
      `0.1.25 left as hook stubs: ${!!pruned}; 0.1.22 (a process names it) whole: ${exists(path.join(h.env.RAVENRY_DESKTOP_DATA, 'versions', '0.1.22', 'ravenryd'))}`);

    // ravenry doctor (HUB-019), as a person types it: the board found through board.json, everything set up.
    const denv = { HOME: h.home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...Object.fromEntries(['RAVENRY_DESKTOP_DATA', 'RAVENRY_HOME', 'RAVENRY_SERVICE_LABEL', 'RAVENRY_LAUNCHCTL', 'RAVENRY_FAKE_LAUNCHD', 'RAVENRY_RUNTIME_DIR', 'RAVENRY_STATE_DIR'].map((k) => [k, h.env[k]])) };
    const doc1 = spawnSync(bin, ['doctor'], { env: denv, encoding: 'utf8', timeout: 30000 });
    check(`${name}_doctor_all_good`, doc1.status === 0 && /ok {4}The board answers on :\d+/.test(doc1.stdout) && /ok {4}The hub service .* is loaded/.test(doc1.stdout) && /ok {4}Claude Code's hooks are set up/.test(doc1.stdout) && /ok {4}Codex's hooks are set up/.test(doc1.stdout) && /ok {4}The Ravenry skill for Codex/.test(doc1.stdout),
      `exit ${doc1.status}: ${doc1.stdout.trim().split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('ok') || /hooks|board|service/.test(l)).join(' | ')}; the board's hooks answer: ${JSON.stringify(await (await fetch(h.url + '/api/setup/hooks')).json()).slice(0, 700)}`);
    const sf = path.join(h.home, '.claude', 'settings.json');
    const was = read(sf);
    const cut = JSON.parse(was);
    for (const e of cut.hooks.Stop || []) e.hooks = (e.hooks || []).filter((x) => !/ravenryd["']? hook/.test(x.command));
    fs.writeFileSync(sf, JSON.stringify(cut, null, 2));
    const doc2 = spawnSync(bin, ['doctor'], { env: denv, encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(sf, was);
    check(`${name}_doctor_hook_removed`, doc2.status === 1 && /fix {3}Claude Code's hooks are partial/.test(doc2.stdout), `exit ${doc2.status}: ${(doc2.stdout.match(/.*Claude Code's hooks.*/) || [''])[0].trim()}`);

    // The launch's offer, when another ravenry answers in a terminal.
    const offered = await until(15000, async () => { const r = await a.cmd('state'); return (r.toasts || []).find((x) => x.includes('ravenry in your terminals runs')) || null; });
    check(`${name}_offer_toast`, offered && offered.includes("the npm board's ravenry (ravenry-app 0.4.0)"), offered || 'no toast');
    const before = shell(h, 'command -v ravenry').stdout.trim();
    // Install the ravenry Command...
    let r = await a.cmd('menu Install the ravenry Command…');
    const d1 = await until(8000, async () => { const s = await a.cmd('state'); return s.dialog && s.dialog.title.startsWith('Make ravenry') ? s.dialog : null; });
    check(`${name}_install_dialog`, d1 && d1.buttons.join(',') === 'Install,Cancel', d1 ? `${d1.title} ${d1.text}` : JSON.stringify(r));
    await a.cmd(`shot ${path.join(OUT, `${name}-command-install-dialog.png`)}`);
    await a.cmd('press Install');
    const toast = await until(15000, async () => { const s = await a.cmd('state'); return (s.toasts || []).find((x) => x.startsWith('ravenry in a new terminal')) || null; });
    const after = shell(h, 'command -v ravenry; ravenry skill | grep "is this program"; ravenry setup --yes');
    const zshrc = read(path.join(h.home, '.zshrc'));
    const lines = zshrc !== h.before.zshrc;
    const backups = fs.readdirSync(h.home).filter((f) => f.startsWith('.zshrc.ravenry-backup-'));
    check(`${name}_install_lands`, toast && after.stdout.startsWith(path.join(h.home, '.local', 'bin', 'ravenry') + '\n') && /is this program/.test(after.stdout) && /npm board: setup --yes/.test(after.stdout),
      `before: ${before}; after: ${after.stdout.replace(/\n/g, ' | ').slice(0, 300)}`);
    check(`${name}_install_${purge ? 'link_only' : 'adds_line'}`, purge ? !lines && !backups.length : lines && backups.length === 1 && zshrc.endsWith('export PATH="$HOME/.local/bin:$PATH"\n'), `.zshrc changed: ${lines}; backups: ${backups.join(',')}`);
    // Remove the ravenry Command...
    r = await a.cmd('state');
    check(`${name}_menu_says_remove`, r.menu.includes('Remove the ravenry Command…'), r.menu.join(' / '));
    await a.cmd('menu Remove the ravenry Command…');
    const d2 = await until(8000, async () => { const s = await a.cmd('state'); return s.dialog && s.dialog.title === 'Remove the ravenry command?' ? s.dialog : null; });
    if (!purge) await a.cmd(`shot ${path.join(OUT, `${name}-command-remove-dialog.png`)}`);
    await a.cmd('press Remove');
    await until(15000, async () => { const s = await a.cmd('state'); return (s.toasts || []).find((x) => x.startsWith('The ravenry command is gone')) || null; });
    const back = shell(h, 'command -v ravenry').stdout.trim();
    check(`${name}_remove_puts_back`, d2 && read(path.join(h.home, '.zshrc')) === h.before.zshrc && !exists(path.join(h.home, '.local', 'bin', 'ravenry')) && back === before, `a new terminal's ravenry: ${back}`);

    // No telemetry (HUB-013): every connection the app, the hub service and what they started had while this ran.
    const seen = net.stop();
    const away = seen.filter((c) => !/^(127\.0\.0\.1|\[::1\]|localhost|\*)[:]/.test(c.local) || (c.remote && !/^(127\.0\.0\.1|\[::1\]|localhost)[:]/.test(c.remote)));
    check(`${name}_no_connection_away`, net.samples > 20 && seen.length > 0 && away.length === 0, `${net.samples} samples of ${net.pids()} processes, ${seen.length} connections, all on this Mac's loopback${away.length ? `; away: ${away.map((c) => `${c.cmd} ${c.local}->${c.remote}`).join(', ')}` : ''}`);

    // Uninstall Ravenry...
    await a.cmd('menu Uninstall Ravenry…');
    const d3 = await until(8000, async () => { const s = await a.cmd('state'); return s.dialog && s.dialog.title === 'Uninstall Ravenry?' ? s.dialog : null; });
    check(`${name}_uninstall_dialog`, d3 && d3.buttons.join(',') === 'Uninstall,Cancel' && d3.box && d3.box.on === false, d3 ? `${d3.text} [${d3.box && d3.box.title}]` : 'none');
    if (purge) await a.cmd('box on');
    await a.cmd(`shot ${path.join(OUT, `${name}-uninstall-dialog.png`)}`);
    await a.cmd('press Uninstall');
    const d4 = await until(30000, async () => { const s = await a.cmd('state'); return s.dialog && /uninstalled/.test(s.dialog.title) ? s.dialog : null; });
    await a.cmd(`shot ${path.join(OUT, `${name}-uninstall-done.png`)}`);
    const data = h.env.RAVENRY_DESKTOP_DATA, mc = path.join(h.home, '.ravenry');
    const settingsBack = read(path.join(h.home, '.claude', 'settings.json')) === h.before.settings;
    const codexBack = !exists(path.join(h.home, '.codex', 'hooks.json')) && read(path.join(h.home, '.codex', 'config.toml')) === h.before.config;
    const skillsGone = !exists(path.join(h.home, '.claude', 'skills', 'ravenry')) && !exists(path.join(h.home, '.codex', 'skills', 'ravenry'));
    const plist = path.join(h.home, 'Library', 'LaunchAgents', `${h.label}.plist`);
    const calls = read(path.join(h.launchd, 'calls.log')) || '';
    const bootout = calls.includes(`"bootout","gui/${process.getuid()}/${h.label}"`);
    const boardGone = await until(10000, async () => { try { await fetch(h.url + '/api/state', { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } });
    check(`${name}_uninstall_done_dialog`, d4 && d4.title === 'Ravenry is uninstalled' && d4.buttons.join(',') === 'Quit', d4 ? d4.text.replace(/\n/g, ' | ') : 'none');
    check(`${name}_uninstall_hooks_back`, settingsBack && codexBack, `settings.json as before: ${settingsBack}; Codex's hooks.json gone and config.toml as before: ${codexBack}`);
    check(`${name}_uninstall_skills_gone`, skillsGone);
    check(`${name}_uninstall_service_gone`, bootout && !exists(plist) && boardGone, `bootout called: ${bootout}; plist there: ${exists(plist)}; the board stopped: ${!!boardGone}`);
    check(`${name}_uninstall_program_gone`, ['bin', 'current', 'versions'].every((n) => !exists(path.join(data, n))), fs.existsSync(data) ? fs.readdirSync(data).join(',') : '(data gone)');
    check(`${name}_uninstall_data_${purge ? 'deleted' : 'kept'}`, purge ? !exists(mc) && !exists(data) : exists(mc) && exists(data), `~/.ravenry there: ${exists(mc)}; data there: ${exists(data)}`);
    check(`${name}_uninstall_logged`, /uninstall: asked from the Ravenry menu/.test(appLog(h)) && /uninstall: .*background service stopped/.test(appLog(h)), (appLog(h).match(/uninstall: .*/g) || []).join(' / ').slice(0, 300));
    // Quit ends the app before it can answer.
    fs.writeFileSync(a.report + '.do', 'press Quit');
    const ended = await until(10000, () => a.p.exitCode !== null);
    check(`${name}_quit_after`, ended && a.p.exitCode === 0, `exit ${a.p.exitCode}`);
  } finally {
    if (a.p.exitCode === null) { a.p.kill('SIGTERM'); await sleep(1500); }
    // Whatever the stand-in launchd still runs.
    const j = json(path.join(h.launchd, 'jobs.json')) || {};
    for (const v of Object.values(j)) { try { if (v.pid) process.kill(v.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
}

/** UPD-014: quit 1 s after a first launch: the service's file is whole and the service loads. */
async function quitCase() {
  const h = await makeHome('quit', 'PROMPT="~ > "\n');
  const a = launch(h);
  // A quit while the service is being set up: as soon as the setup says it started (a fresh bundle's first exec can take seconds).
  await until(30000, () => /launch: native app/.test(appLog(h)));
  a.p.kill('SIGTERM');
  await until(10000, () => a.p.exitCode !== null);
  const plist = path.join(h.home, 'Library', 'LaunchAgents', `${h.label}.plist`);
  const up = await until(40000, async () => { try { return (await fetch(h.url + '/api/state')).ok; } catch { return false; } });
  const lint = spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' });
  const calls = read(path.join(h.launchd, 'calls.log')) || '';
  check('quit_soon_service_whole', a.p.exitCode !== null && lint.status === 0 && calls.includes('"bootstrap"') && up, `the app ended (${a.p.exitCode}) as its setup began; plutil -lint: ${lint.stdout.trim()}; bootstrap called: ${calls.includes('"bootstrap"')}; the board answers: ${!!up}`);
  const penv = (() => { try { return JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout).EnvironmentVariables || {}; } catch { return null; } })();
  const bad = penv ? Object.keys(penv).filter((k) => ['RAVENRY_PANE', 'RAVENRY_SOCKET', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'].includes(k)) : ['(no plist)'];
  check('service_env_clean', penv && bad.length === 0, `the service's variables: ${penv ? Object.keys(penv).join(', ') : 'none'}${bad.length ? `; not its own: ${bad.join(', ')}` : ''}`);
  const j = json(path.join(h.launchd, 'jobs.json')) || {};
  for (const v of Object.values(j)) { try { if (v.pid) process.kill(v.pid, 'SIGTERM'); } catch { /* gone */ } }
}

try {
  const only = (n) => !process.env.SMC_ONLY || process.env.SMC_ONLY.split(',').includes(n);
  if (only('quit')) await quitCase();
  if (only('failed')) await failedCase();
  if (only('line')) await runCase('line', 'export PATH="$HOME/npm/bin:$PATH"\nPROMPT="~ > "\n', false);
  if (only('link')) await runCase('link', 'export PATH="$HOME/.local/bin:$HOME/npm/bin:$PATH"\nPROMPT="~ > "\n', true);
} finally {
  for (const p of holders) p.kill();
  fs.writeFileSync(path.join(OUT, 'setupmenucheck.json'), JSON.stringify({ app: APP, at: new Date().toISOString(), results }, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
