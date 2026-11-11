#!/usr/bin/env node
// The updater's dialogs and times (Updater.swift) that updatecheck.mjs does
// not reach, on a package's test twin off every screen in a throwaway HOME,
// its feed a server on 127.0.0.1 that logs each request. Check for Updates...
// is pressed in the app menu as a click does and each dialog is read and
// pictured (ReportDriver.swift); Open the Releases Page is pressed and what
// would open is read from the app (Outside, off every screen).
//
//   node scripts/updatedialogcheck.mjs PACKAGED_APP [OUT]
//
// times     RAVENRY_UPDATE_TEST=launch: the first request to the feed comes
//           about 15 s after the launch (UPD-012), then one every
//           RAVENRY_UPDATE_EVERY seconds (4 here, the 4 hours' place); with
//           RAVENRY_UPDATES=0 none comes in 30 s
// current   the feed says this version: "Ravenry is up to date", "You have
//           <version>, the newest version." (UPD-009)
// failed    the feed answers 500: "Could not check for updates" with Open the
//           Releases Page, which opens the repository's releases (UPD-009)
// adhoc     a copy signed ad hoc: the dialog says it is not signed for a team,
//           offers the Releases page, and nothing asks the feed (UPD-010)
// nosource  a copy with no app-update.json (signed again with this Mac's
//           identity) and no feed named: the dialog says the build does not
//           say where its updates come from (UPD-010)
// each      the app quits within 5 s of a SIGTERM, a dialog up or not
//           (<name>_quits_on_sigterm); one that does not is killed
import { guardSpawns } from '../../../tools/test-env.mjs';
import { track, removeTree } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';
import { localIdentity } from '../../desktop/scripts/local-identity.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const { app: TWIN } = testApp(process.argv[2] || path.join(MAC, 'build', 'package', 'Ravenry.app'));
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'updatedialog.'));
track(tmp);
const OUT = path.resolve(process.argv[3] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const VERSION = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(TWIN, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); };
async function until(ms, f) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(150); } return null; }

// The feed: what it answers, and each request it got.
let mode = 'current';
const hits = [];
const server = http.createServer((req, res) => {
  hits.push({ at: Date.now(), url: req.url });
  if (mode === '500') { res.writeHead(500); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ version: VERSION, url: `RavenryNative-${VERSION}.zip`, sha256: '0'.repeat(64), size: 1 }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FEED = `http://127.0.0.1:${server.address().port}/latest-mac-native.json`;

let n = 0;
const apps = [];
function launch(app, name, extra) {
  const root = path.join(tmp, name);
  const home = path.join(root, 'home');
  for (const d of [home, path.join(root, 'run'), path.join(root, 'state'), path.join(root, 'data')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='~ > '\n");
  const report = path.join(root, 'report.json');
  const env = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: path.join(root, 'data'),
    RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'state'), RAVENRY_HOME: path.join(home, '.ravenry'), RAVENRY_MAC_REPORT: report, ...extra };
  const p = spawn(path.join(app, 'Contents', 'MacOS', 'Ravenry'), ['--offscreen'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(root, 'app.err'), 'w')] });
  apps.push(p);
  let k = 0;
  return {
    p, at: Date.now(), home,
    async cmd(line) {
      const want = ++k;
      fs.writeFileSync(report + '.do', line);
      const r = await until(10000, () => { const l = (read(report + '.done') || '').trim().split('\n').filter(Boolean); return l.length >= want ? JSON.parse(l[want - 1]) : null; });
      if (!r) throw new Error(`${name}: the app did not take "${line}"`);
      return r;
    },
    async dialog(title) { return until(10000, async () => { const s = await this.cmd('state'); return s.dialog && s.dialog.title === title ? s : null; }); },
    // A SIGTERM must end the app whatever dialog is up (main.swift); one that
    // ran on was left behind by every run, so it is a check, then killed.
    async stop() {
      const gone = () => p.exitCode !== null || p.signalCode !== null;
      if (gone()) return;
      p.kill('SIGTERM');
      const ok = await until(5000, gone);
      const s = ok ? null : await this.cmd('state').catch(() => null);
      check(`${name}_quits_on_sigterm`, ok, ok ? '' : `still running 5 s after a SIGTERM${s && s.dialog ? `, the dialog "${s.dialog.title}" up` : ''}`);
      if (!ok) { p.kill('SIGKILL'); await until(3000, gone); }
    },
  };
}
const shot = async (a, file) => { const r = await a.cmd(`shot ${path.join(OUT, file)}`); return r.ok; };

try {
  // times, current, failed: the twin as it is.
  mode = 'current';
  hits.length = 0;
  let a = launch(TWIN, 't', { RAVENRY_UPDATE_TEST: 'launch', RAVENRY_UPDATE_FEED: FEED, RAVENRY_UPDATE_EVERY: '4' });
  const first = await until(30000, () => hits[0]);
  const after = first ? (first.at - a.at) / 1000 : null;
  check('times_first_check_15s', after != null && after >= 14 && after <= 20, after != null ? `the first request ${after.toFixed(1)} s after the launch` : 'no request in 30 s');
  // The repeat (every 4 hours), at RAVENRY_UPDATE_EVERY=4 s in its place.
  await until(15000, () => hits.length >= 3);
  const gaps = hits.slice(0, 3).map((h, i, all) => (i ? (h.at - all[i - 1].at) / 1000 : null)).filter((g) => g != null);
  check('times_repeats', gaps.length === 2 && gaps.every((g) => g >= 3.5 && g <= 5.5), `gaps between checks: ${gaps.map((g) => g.toFixed(1)).join(', ')} s (every 4 s in the 4 hours' place)`);
  await a.cmd('menu Check for Updates…');
  let s = await a.dialog('Ravenry is up to date');
  check('current_up_to_date_dialog', s && s.dialog.text === `You have ${VERSION}, the newest version.` && s.dialog.buttons.join(',') === 'OK', s ? s.dialog.text : 'none');
  if (s) { await shot(a, 'update-up-to-date.png'); await a.cmd('press OK'); }
  mode = '500';
  await sleep(500);
  await a.cmd('menu Check for Updates…');
  s = await a.dialog('Could not check for updates');
  check('failed_could_not_dialog', s && s.dialog.buttons.join(',') === 'Open the Releases Page,OK', s ? `${s.dialog.text} [${s.dialog.buttons}]` : 'none');
  if (s) {
    await shot(a, 'update-could-not-check.png');
    const r = await a.cmd('press Open the Releases Page');
    const opened = await until(12000, async () => { const x = await a.cmd('state'); return (x.outside || []).find((o) => /^open https:\/\/github\.com\/[^/]+\/[^/]+\/releases$/.test(o)) || null; });
    check('failed_opens_releases', !!opened, opened || JSON.stringify((await a.cmd('state')).outside));
  }
  await a.stop();
  // Updates off.
  hits.length = 0;
  a = launch(TWIN, 'o', { RAVENRY_UPDATE_TEST: 'launch', RAVENRY_UPDATE_FEED: FEED, RAVENRY_UPDATES: '0' });
  await sleep(30000);
  check('times_updates_off_no_request', hits.length === 0, `${hits.length} requests in 30 s`);
  await a.stop();

  // adhoc: a copy signed ad hoc.
  const adhoc = path.join(tmp, 'adhoc', 'Ravenry.app');
  fs.mkdirSync(path.dirname(adhoc), { recursive: true });
  execFileSync('/usr/bin/ditto', [TWIN, adhoc]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', adhoc], { stdio: 'ignore' });
  hits.length = 0;
  a = launch(adhoc, 'a', { RAVENRY_UPDATE_FEED: FEED });
  await a.cmd('menu Check for Updates…');
  s = await a.dialog('Updates');
  check('adhoc_says_not_signed', s && /not signed for a team/.test(s.dialog.text) && s.dialog.buttons.join(',') === 'Open the Releases Page,OK' && hits.length === 0,
    s ? `${s.dialog.text} [${s.dialog.buttons}]; feed requests: ${hits.length}` : 'none');
  if (s) await shot(a, 'update-not-signed.png');
  await a.stop();

  // nosource: no app-update.json and no feed named.
  const id = localIdentity();
  if (!id) check('nosource_says_so', false, 'this Mac has no Apple Development identity to sign the copy with');
  else {
    const ns = path.join(tmp, 'nosource', 'Ravenry.app');
    fs.mkdirSync(path.dirname(ns), { recursive: true });
    execFileSync('/usr/bin/ditto', [TWIN, ns]);
    fs.rmSync(path.join(ns, 'Contents', 'Resources', 'app-update.json'), { force: true });
    execFileSync('/usr/bin/codesign', ['--force', '--sign', id.hash, '--options', 'runtime', '--timestamp=none', '--entitlements', path.join(REPO, 'apps', 'desktop', 'build', 'entitlements.mac.plist'), ns], { stdio: 'ignore' });
    a = launch(ns, 'n', {});
    await a.cmd('menu Check for Updates…');
    s = await a.dialog('Updates');
    check('nosource_says_so', s && s.dialog.text === 'This build does not say where its updates come from.' && s.dialog.buttons.join(',') === 'OK', s ? `${s.dialog.text} [${s.dialog.buttons}]` : 'none');
    if (s) await shot(a, 'update-no-source.png');
    await a.stop();
  }
} finally {
  server.close();
  // None of the check's apps outlives it, whatever failed on the way.
  for (const p of apps) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  fs.writeFileSync(path.join(OUT, 'updatedialogcheck.json'), JSON.stringify({ app: TWIN, version: VERSION, at: new Date().toISOString(), results }, null, 2));
  for (const d of ['adhoc', 'nosource']) removeTree(path.join(tmp, d));
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} checks failed` : `all ${results.length} checks pass`);
process.exit(failed.length ? 1 : 0);
