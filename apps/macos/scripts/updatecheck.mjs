#!/usr/bin/env node
// The updater's check (Updater.swift): the packaged native app
// (scripts/package.mjs) updated from a local feed, a copy of it in a
// throwaway folder, never /Applications, run off every screen in a
// throwaway HOME with no hub service (RAVENRY_SERVICE=off). Nothing is
// published and no network is used: the feed is a server on 127.0.0.1.
//
//   node scripts/updatecheck.mjs APP [OUT]
//
// APP is build/package/Ravenry.app, signed with this Mac's identity (an ad
// hoc build never updates itself). The newer versions are copies of it with
// a higher version in their Info.plist, signed again with the same
// identity (their build.json stays: the daemon and the hub's folder are the
// same build, so this checks the swap, not a new daemon; installcheck.mjs
// checks a new version's daemon and hub after an install by hand, which is
// what the updated app then does).
//
// refused  a zip whose SHA-256 is not the feed's, and a copy signed ad hoc
//          (no team): each is refused, said in app.log, the app untouched
// quit     a newer version, RAVENRY_UPDATE_TEST=quit: downloaded, checked,
//          the app quits, the new bundle is in place, not started again
// restart  a newer one again, RAVENRY_UPDATE_TEST=restart: in place and
//          started again through LaunchServices with the clean environment
//          (no variable the launch had besides the kept ones); the daemon that ran keeps running (same pid) and the new
//          app uses it; a process running the old bundle's executable as
//          Node (as the hub service does) keeps running through the swap
import { guardSpawns } from '../../../tools/test-env.mjs';
import { track, removeTree } from '../../../tools/launchservices.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';
import { localIdentity } from '../../desktop/scripts/local-identity.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
// The test twin (testapp.mjs): the release takes no update feed of a test's.
const APP = process.argv[2] ? testApp(process.argv[2]).app : '';
if (!fs.existsSync(path.join(APP, 'Contents', 'MacOS', 'node'))) { console.error('usage: node scripts/updatecheck.mjs PACKAGED_APP [OUT]'); process.exit(2); }
const OUT = path.resolve(process.argv[3] || path.join(REPO, '.tmp', 'updatecheck'));
fs.mkdirSync(OUT, { recursive: true });
const id = localIdentity();
if (!id) { console.error('updatecheck: this Mac has no signing identity; an ad hoc build never updates itself'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const plistGet = (app, k) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${k}`, path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const VERSION = plistGet(APP, 'CFBundleShortVersionString');
const bump = (v, n) => { const p = v.split('-')[0].split('.').map(Number); p[2] += n; return p.join('.'); };
const results = { app: APP, version: VERSION, at: new Date().toISOString(), steps: [] };
let fails = 0;
function step(name, ok, detail = {}) {
  results.steps.push({ name, ok: !!ok, detail });
  if (!ok) fails++;
  console.log(`${ok ? 'pass' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(detail).slice(0, 700)}`}`);
}
async function until(fn, ms = 20000, every = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(every); }
}
const procs = () => execFileSync('/bin/ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().match(/^(\d+) (.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), cmd: m[2] }));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The throwaway account: short paths (a socket path stays under 104 bytes).
const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'rvnu-')));
const home = path.join(root, 'h');
const data = path.join(home, 'Library', 'Application Support', 'Ravenry');
const rt = path.join(root, 'run');
for (const d of [data, rt, path.join(root, 'Applications'), path.join(root, 'feed')]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='~ > '\n");
const app = path.join(root, 'Applications', 'Ravenry.app');
const exe = path.join(app, 'Contents', 'MacOS', 'Ravenry');
const appLog = path.join(home, 'Library', 'Logs', 'Ravenry', 'app.log');
const env = {
  HOME: home, USER: os.userInfo().username, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  RAVENRY_DESKTOP_DATA: data, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: data, RAVENRY_HUB_URL: 'http://127.0.0.1:9', RAVENRY_SERVICE: 'off',
  RAVENRY_OFFSCREEN: '1', RAVENRY_RELAUNCH_TEST: '1',
  // A variable of the launch's own, which the restarted app must not carry
  // (test-env.mjs refuses a launch with a terminal's TERM_PROGRAM).
  RAVENRY_UPDATE_CHECK_MARK: 'dropped',
};

// The feed: a server on 127.0.0.1 over the feed folder.
const server = http.createServer((q, s) => {
  const f = path.join(root, 'feed', path.basename(decodeURIComponent(q.url.split('?')[0])));
  if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-length': fs.statSync(f).size });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FEED = `http://127.0.0.1:${server.address().port}/latest-mac-native.json`;

/** A copy of APP at `version`, signed with `sign` (an identity's SHA-1, or - for ad hoc), zipped into the feed; the feed says `sha` (else the zip's). */
function publish(version, { sign = id.hash, sha = null } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'new-'));
  const nb = path.join(dir, 'Ravenry.app');
  execFileSync('/usr/bin/ditto', [APP, nb]);
  for (const k of ['CFBundleShortVersionString', 'CFBundleVersion']) execFileSync('/usr/bin/plutil', ['-replace', k, '-string', version, path.join(nb, 'Contents', 'Info.plist')]);
  const ents = path.join(REPO, 'apps', 'desktop', 'build', sign === '-' ? 'entitlements.adhoc.plist' : 'entitlements.mac.plist');
  if (sign === '-') {
    // Every binary inside ad hoc too: a bundle of no team at all.
    for (const b of ['node', 'ravenryd']) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', ents, path.join(nb, 'Contents', 'MacOS', b)]);
  }
  execFileSync('/usr/bin/codesign', ['--force', '--sign', sign, '--options', 'runtime', '--timestamp=none', '--entitlements', ents, nb]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', nb]);
  const zip = path.join(root, 'feed', `RavenryNative-${version}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', nb, zip]);
  const bytes = fs.readFileSync(zip);
  fs.writeFileSync(path.join(root, 'feed', 'latest-mac-native.json'), JSON.stringify({ version, url: path.basename(zip), sha256: sha || crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length }));
  fs.rmSync(dir, { recursive: true, force: true });
}

const started = [];
function launch(name, test) {
  const log = fs.openSync(path.join(OUT, `${name}.log`), 'w');
  const p = spawn(exe, [], { env: { ...env, RAVENRY_UPDATE_FEED: FEED, RAVENRY_UPDATE_TEST: test }, stdio: ['ignore', log, log], detached: false });
  started.push(p);
  return p;
}
const exited = (p) => new Promise((r) => { if (p.exitCode !== null) r(p.exitCode); else p.once('exit', (c) => r(c)); });
const logSince = (n) => read(appLog).slice(n);

try {
  execFileSync('/usr/bin/ditto', [APP, app]);
  // A process running the bundle's executable as Node, as the hub service does.
  const hubLike = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', detached: true });
  hubLike.unref();

  // ------------------------------------------------------------ refused
  {
    publish(bump(VERSION, 1), { sha: 'ab'.repeat(32) });
    const at = read(appLog).length;
    const p = launch('refused-sha', 'check');
    const said = await until(() => /did not match the release/.test(logSince(at)), 60000, 300);
    step('refused: a zip whose SHA-256 is not the feed\'s is refused, and said in app.log', said && plistGet(app, 'CFBundleShortVersionString') === VERSION, { log: logSince(at).split('\n').slice(-4) });
    p.kill('SIGTERM'); await exited(p);
    step('refused: quitting after it leaves the app as it was', plistGet(app, 'CFBundleShortVersionString') === VERSION && !/installing/.test(logSince(at)));
  }
  {
    publish(bump(VERSION, 1), { sign: '-' });
    const at = read(appLog).length;
    const p = launch('refused-team', 'check');
    const said = await until(() => /signed by team none, not|signature did not check out/.test(logSince(at)), 60000, 300);
    step(`refused: a copy signed ad hoc (no team) is refused: not team ${id.team}`, said && plistGet(app, 'CFBundleShortVersionString') === VERSION, { log: logSince(at).split('\n').slice(-4) });
    p.kill('SIGTERM'); await exited(p);
  }

  // The daemon the app started, which must outlive every update.
  const daemons = () => procs().filter((x) => /ravenryd serve/.test(x.cmd) && x.cmd.includes(root));
  const d0 = daemons().map((x) => x.pid);
  step('a daemon of the app\'s runs (started by the launches above)', d0.length === 1, { d0 });

  // ------------------------------------------------------------ quit
  {
    const v1 = bump(VERSION, 1);
    publish(v1);
    const at = read(appLog).length;
    const t0 = Date.now();
    const p = launch('quit', 'quit');
    const code = await Promise.race([exited(p), sleep(90000).then(() => 'timeout')]);
    const done = await until(() => plistGet(app, 'CFBundleShortVersionString') === v1 && /installed/.test(logSince(at)), 30000, 200);
    const log = logSince(at);
    step('quit: downloaded, checked (SHA-256, codesign, Team ID), installed once the app quit', code === 0 && done && /is ready at .*SHA-256, codesign --verify --deep --strict and Team ID/.test(log), { code, ms: Date.now() - t0, log: log.split('\n').slice(-6) });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    step('quit: the app in place passes codesign --verify --deep --strict, and nothing was started again', !procs().some((x) => /Applications\/Ravenry\.app\/Contents\/MacOS\/Ravenry( |$)/.test(x.cmd) && x.cmd.includes(path.basename(root)) && !x.cmd.includes(' -e ')), {});
    step('quit: the update\'s folder holds no old copy', !fs.existsSync(path.join(home, 'Library', 'Caches', 'Ravenry', 'Updates', 'previous.app')));
  }

  // ------------------------------------------------------------ restart
  {
    const v2 = bump(VERSION, 2);
    publish(v2);
    const at = read(appLog).length;
    const t0 = Date.now();
    const p = launch('restart', 'restart');
    const code = await Promise.race([exited(p), sleep(90000).then(() => 'timeout')]);
    // (LaunchServices names it by its real path: /private/var/... for /var/....)
    const realExe = path.join(fs.realpathSync(root), path.relative(root, exe));
    const isApp = (c) => (c === exe || c === realExe || c.startsWith(exe + ' ') || c.startsWith(realExe + ' ')) && !c.includes(' -e ');
    const relaunched = await until(() => procs().find((x) => isApp(x.cmd)), 30000, 200);
    const ms = Date.now() - t0;
    step('restart: the app quit, the new version is in place and started again', code === 0 && !!relaunched && plistGet(app, 'CFBundleShortVersionString') === v2, { code, relaunched, ms, log: logSince(at).split('\n').slice(-6) });
    let penv = '';
    if (relaunched) penv = spawnSync('/bin/ps', ['eww', '-o', 'command=', '-p', String(relaunched.pid)], { encoding: 'utf8' }).stdout;
    step('restart: started with the clean environment (no launch variable it does not keep, the system PATH)', !!penv && !/RAVENRY_UPDATE_CHECK_MARK=/.test(penv) && /RAVENRY_DESKTOP_DATA=/.test(penv) && /PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/.test(penv), { env: penv.split(' ').filter((w) => /^[A-Z_]+=/.test(w)).map((w) => w.split('=')[0]) });
    const usedDaemon = await until(() => /daemon: using/.test(logSince(at).split('update: restarting')[1] || ''), 20000, 300);
    const d1 = daemons().map((x) => x.pid);
    step('restart: the daemon that ran keeps running, the same process, and the new app uses it', usedDaemon && d1.length === 1 && d1[0] === d0[0], { d0, d1, log: logSince(at).split('\n').slice(-4) });
    step('restart: a process running the old bundle\'s executable as Node (as the hub service does) kept running through the swap', alive(hubLike.pid));
    if (relaunched) { try { process.kill(relaunched.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  try { process.kill(hubLike.pid, 'SIGTERM'); } catch { /* gone */ }
} catch (e) {
  step('the check ran to its end', false, { error: String(e && e.stack || e) });
} finally {
  server.close();
  for (const p of started) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  for (const x of procs()) if (x.cmd.includes(root)) { try { process.kill(x.pid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(500);
  try { fs.copyFileSync(appLog, path.join(OUT, 'app.log')); } catch { /* none written */ }
  fs.writeFileSync(path.join(OUT, 'updatecheck.json'), JSON.stringify(results, null, 2));
  try { removeTree(root); } catch { /* left */ }
  console.log(`updatecheck: ${results.steps.length} steps, ${fails} failed; ${OUT}`);
  process.exit(fails ? 1 : 0);
}
