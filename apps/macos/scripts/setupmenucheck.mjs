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
// link     ~/.local/bin first (as on Simon's Mac): Install adds the link only,
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
    RAVENRY_DESKTOP_DATA: path.join(root, 'data'), RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'state'), RAVENRY_TEST_SINGLE: '1',
  };
  fs.mkdirSync(env.RAVENRY_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(launchd, 'env.json'), JSON.stringify(env));
  const before = { settings: read(path.join(home, '.claude', 'settings.json')), config: read(path.join(home, '.codex', 'config.toml')), zshrc: read(path.join(home, '.zshrc')) };
  return { root, home, env, port, label, launchd, before, url: `http://127.0.0.1:${port}` };
}

/** The app off every screen, driven through its report's command file. */
function launch(h) {
  const report = path.join(h.root, 'report.json');
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

async function runCase(name, zshrc, purge) {
  const h = await makeHome(name, zshrc);
  const a = launch(h);
  try {
    const bin = path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenry');
    // The board up (the service, by the stand-in launchd), the window on it.
    const up = await until(30000, async () => { try { return (await fetch(h.url + '/api/state')).ok; } catch { return false; } });
    check(`${name}_service_board`, up && exists(bin), `the board on ${h.url}: ${!!up}; ${bin}: ${exists(bin)}`);
    // What Settings sets up: the hooks (Claude Code's and Codex's) and the skill for both.
    const hk = await post(h, '/api/setup/hooks', { ravenryd: path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenryd') });
    const sk1 = await post(h, '/api/setup/skills', { kind: 'claude', on: true, ravenryd: path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenryd'), version: '0.1.36' });
    const sk2 = await post(h, '/api/setup/skills', { kind: 'codex', on: true, ravenryd: path.join(h.env.RAVENRY_DESKTOP_DATA, 'bin', 'ravenryd'), version: '0.1.36' });
    const set = read(path.join(h.home, '.claude', 'settings.json'));
    const codexSkill = read(path.join(h.home, '.codex', 'skills', 'ravenry', 'SKILL.md'));
    check(`${name}_set_up_like_settings`, hk.code === 200 && sk1.code === 200 && sk2.code === 200 && set.includes('bin/ravenryd') && !!codexSkill && exists(path.join(h.home, '.codex', 'hooks.json')),
      `hooks ${hk.code}, skills ${sk1.code} ${sk2.code}`);
    // The Codex skill's command runs and prints the guide.
    const skillCmd = (/^Run `"([^"`]+)" skill`/m.exec(codexSkill || '') || [])[1];
    const guide = skillCmd ? spawnSync(skillCmd, ['skill'], { env: { HOME: h.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }) : null;
    check(`${name}_codex_skill_runs`, guide && guide.status === 0 && /ravenry new/.test(guide.stdout), skillCmd ? `${skillCmd} skill: exit ${guide.status}, ${guide.stdout.split('\n')[0]}` : 'no command in the SKILL.md');

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
    const after = shell(h, 'command -v ravenry; ravenry skill | grep "is this program"; ravenry doctor --yes');
    const zshrc = read(path.join(h.home, '.zshrc'));
    const lines = zshrc !== h.before.zshrc;
    const backups = fs.readdirSync(h.home).filter((f) => f.startsWith('.zshrc.ravenry-backup-'));
    check(`${name}_install_lands`, toast && after.stdout.startsWith(path.join(h.home, '.local', 'bin', 'ravenry') + '\n') && /is this program/.test(after.stdout) && /npm board: doctor --yes/.test(after.stdout),
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
    check(`${name}_uninstall_logged`, /uninstall: asked from the Ravenry menu/.test(appLog(h)) && /uninstall: .*hub service stopped/.test(appLog(h)), (appLog(h).match(/uninstall: .*/g) || []).join(' / ').slice(0, 300));
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

try {
  await runCase('line', 'export PATH="$HOME/npm/bin:$PATH"\nPROMPT="~ > "\n', false);
  await runCase('link', 'export PATH="$HOME/.local/bin:$HOME/npm/bin:$PATH"\nPROMPT="~ > "\n', true);
} finally {
  fs.writeFileSync(path.join(OUT, 'setupmenucheck.json'), JSON.stringify({ app: APP, at: new Date().toISOString(), results }, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
