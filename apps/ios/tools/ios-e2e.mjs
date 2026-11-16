#!/usr/bin/env node
// The iPhone app's checks on a booted simulator (headless: `xcrun simctl
// boot`, never Simulator.app), against a test hub on 127.0.0.1 with demo
// content (apps/phone/tools/demo.mjs --phone --phone-hosts 127.0.0.1):
//
// - the unit tests (Tests/RavenryTests), their live cases against the test
//   hub's phone port (a device paired here for them);
// - the app driven as a person would (Tests/RavenryUITests): pair by the
//   typed code (the check number the Mac's), a relaunch keeps the pairing,
//   an answer on the board reaches the hub, Run asks Face ID (enrolled and
//   answered here, no match then a match) and only a match runs, the secret
//   goes to the hub, the pair link and Which iPhone is this (an iPhone
//   through ntfy made first, on a stand-in ntfy server here: nothing goes
//   to ntfy.sh), a wrong pin is refused, the launch's Ink ends on the board,
//   cards that arrive while the board is open, and a launch from an alert
//   (a pick, a secret, a command) ends on its checkpoint's screen;
// - after: the token in the simulator's Keychain, and the secret in no log
//   and nowhere in the web view's storage.
//
//   node tools/ios-e2e.mjs --udid <booted simulator> --out <dir> [--theme dark|light] [--shots-only]
//     [--hub DIR] (a packaged app's hub folder in place of ../../hub, as it ships)
//     [--board-swap] (test9e: a copy of the hub, its board files swapped as an update of the Mac does)
//     PICKVIDEO_CLIP, PICKVIDEO_CLIP2: the videos of test9d's pick (else made here with ffmpeg)
//
// Pictures go to <out>/shots, the app's log and the marks to <out>.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '..');
const REPO = path.resolve(IOS, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const UDID = opt('--udid');
const OUT = path.resolve(opt('--out', path.join(IOS, 'build', 'e2e')));
const THEME = opt('--theme', 'dark');
const SHOTS_ONLY = args.includes('--shots-only');
if (!UDID) { console.error('give --udid of a booted simulator'); process.exit(2); }
const SHOTS = path.join(OUT, 'shots');
const SIG = path.join(OUT, `sig-${THEME}`);
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(SIG, { recursive: true, force: true });
fs.mkdirSync(SIG, { recursive: true });
const TYPED = 'demo-key-tw0-fl4me-77';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
// Never the person's own Ravenry: no socket, pane or hub of his reaches these processes.
const cleanEnv = { ...process.env };
for (const k of ['RAVENRY_SOCKET', 'RAVENRY_PANE', 'RAVENRY_HUB_URL']) delete cleanEnv[k];

// ------------------------------------------------------------ a stand-in ntfy server: nothing reaches ntfy.sh

const published = [];
const ntfy = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { published.push(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); });
await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${ntfy.address().port}`;

// ------------------------------------------------------------ the test hub

const DEMO = path.join(OUT, `demo-${THEME}`);
fs.rmSync(DEMO, { recursive: true, force: true });
// --board-swap (test9e): the test hub runs from a copy of ../../hub, whose
// board files the test swaps as an update of the Mac does: an older board
// (this one's app.js without the row of a card in no project) and this one.
let HUB_DIR = opt('--hub') ? path.resolve(opt('--hub')) : null;
const SWAP = {};
if (args.includes('--board-swap')) {
  const src = HUB_DIR || path.join(REPO, 'hub');
  // A tree of its own, the shared files and packages linked from this one (the hub reads them at ../../).
  const tree = path.join(OUT, `swap-tree-${THEME}`);
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  for (const d of ['shared', 'packages']) fs.symlinkSync(path.join(REPO, d), path.join(tree, d));
  HUB_DIR = path.join(tree, 'hub');
  fs.cpSync(src, HUB_DIR, { recursive: true, filter: (f) => !/\/(node_modules|\.tmp)(\/|$)/.test(path.relative(src, f) ? '/' + path.relative(src, f) : '') });
  fs.symlinkSync(path.join(src, 'node_modules'), path.join(HUB_DIR, 'node_modules'));
  const app = fs.readFileSync(path.join(HUB_DIR, 'public', 'app.js'), 'utf8');
  const older = app.replace(/  \/\/ A card asked from a pane in no project[\s\S]*?\n(?=  const open = \(snap\.checkpoints)/, '');
  if (older === app) { console.error('--board-swap: the board has no row for a card in no project to take out'); process.exit(2); }
  for (const [k, text] of [['old', older], ['new', app]]) { const d = path.join(OUT, `board-${k}-${THEME}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'app.js'), text); SWAP[k] = d; }
}
const demo = spawn(process.execPath, [path.join(REPO, 'apps/phone/tools/demo.mjs'), '--phone', '--phone-hosts', '127.0.0.1', '--dir', DEMO, ...(HUB_DIR ? ['--hub', HUB_DIR] : [])], { env: cleanEnv, stdio: ['ignore', fs.openSync(path.join(OUT, `demo-${THEME}.log`), 'w'), 'inherit'] });
let info = null;
for (let i = 0; i < 120 && !info; i++) { await sleep(500); try { info = JSON.parse(fs.readFileSync(path.join(DEMO, 'demo.json'), 'utf8')); } catch { /* not yet */ } }
if (!info || !info.phone) { console.error('the demo hub did not start'); demo.kill(); process.exit(1); }
const BOARD = info.url;
// Once more when the connection was reset: fetch reuses a kept-alive socket the hub had
// just closed after a quiet spell (ECONNRESET at the run's second code, 2026-11-15).
const mac = async (method, p, body, again = true) => {
  let r;
  try { r = await fetch(BOARD + p, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) }); } catch (e) { if (again) return mac(method, p, body, false); throw e; }
  return { status: r.status, body: await r.json().catch(() => null) };
};
const pinOf = (link) => new URL(link.replace('ravenry://', 'https://x/')).searchParams.get('pin');
console.log(`test hub ${BOARD}, phone port ${info.phone.port}`);
// The demo's checkpoints open as its panes start.
for (let i = 0; i < 60; i++) { const c = (await mac('GET', '/api/checkpoints')).body; if (c && c.checkpoints && c.checkpoints.length >= 3) break; await sleep(500); }

// An iPhone through ntfy (on the stand-in server), for "Which iPhone is this?".
// (test6 makes the iPhone through ntfy itself, after the first pairing has seen none.)
await mac('POST', '/api/alerts/ntfy', { server: STUB });

// A device for the unit tests' live cases: paired here, as the app pairs.
function phoneReq(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const q = https.request({ host: '127.0.0.1', port: info.phone.port, method, path: p, headers, rejectUnauthorized: false, agent: false }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* text */ } resolve({ status: res.statusCode, body: j }); });
    });
    q.on('error', reject);
    if (body) q.write(JSON.stringify(body));
    q.end();
  });
}
const unitCode = (await mac('GET', '/api/phone?code=new')).body.app;
const unitPair = await phoneReq('POST', '/api/phone/pair', { code: unitCode.code, name: 'unit tests', platform: 'test', app: '0' });
const UNIT_TOKEN = unitPair.body && unitPair.body.token;
const PIN = pinOf(unitCode.link);

// ------------------------------------------------------------ Face ID on the simulator

const bio = (name) => simctl('spawn', UDID, 'notifyutil', '-p', name);
simctl('spawn', UDID, 'notifyutil', '-s', 'com.apple.BiometricKit.enrollmentChanged', '1');
bio('com.apple.BiometricKit.enrollmentChanged');
let watching = true;
const faceLog = [];
// A new card while the board is open (test9): the test names it in
// card.wait, and a ravenryd of the demo opens it in the pane of that
// project's session (as `ravenry approve`, `ask` or `pick` typed there
// does); the card it opened there before is cancelled first, so the board
// shows this one. Its id goes back in card.out.
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
const demoEnv = { HOME: DEMO, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: info.runtime, RAVENRY_STATE_DIR: path.join(DEMO, 'state') };
const PICTURE = path.join(REPO, 'packages', 'page-format', 'fixtures', 'playtest', 'playtest', 'shots');
const cardsOpened = new Map();
// A pick of videos asked from a plain shell pane in no project (the
// pickvideo round, 2026-11-16, as one was on the person's Mac): a video (A,
// PICKVIDEO_CLIP or made here), a page that holds it as a data: URI (B), a
// picture (C), a second video (D, PICKVIDEO_CLIP2 or made here).
const VDIR = path.join(OUT, `videos-${THEME}`);
function videoFiles() {
  if (fs.existsSync(path.join(VDIR, 'd.mp4'))) return VDIR;
  fs.mkdirSync(VDIR, { recursive: true });
  const ff = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((f) => fs.existsSync(f)) || 'ffmpeg';
  const made = (name, src) => { const f = path.join(VDIR, name); if (src) fs.copyFileSync(src, f); else execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', f]); return f; };
  const a = made('a.mp4', process.env.PICKVIDEO_CLIP || '');
  made('d.mp4', process.env.PICKVIDEO_CLIP2 || '');
  fs.writeFileSync(path.join(VDIR, 'b.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000"><video src="data:video/mp4;base64,${fs.readFileSync(a).toString('base64')}" controls autoplay muted loop playsinline style="width:100%"></video></body></html>`);
  fs.copyFileSync(path.join(PICTURE, fs.readdirSync(PICTURE).find((x) => /\.png$/i.test(x))), path.join(VDIR, 'c.png'));
  return VDIR;
}
async function openLooseVideoPick(c) {
  const dir = videoFiles();
  const scratch = path.join(DEMO, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const pane = execFileSync(BIN, ['new', '--cwd', scratch, '--name', c.name || 'Video test', '--', '/bin/sh', '-c', 'exec sleep 100000'], { env: demoEnv, encoding: 'utf8' }).trim().split(/\s+/)[0];
  const vs = [['Take one', 'a.mp4'], ['Take two', 'b.html'], ['Still', 'c.png'], ['Take three', 'd.mp4']];
  const id = execFileSync(BIN, ['pick', c.title || 'Which take should I keep?', ...vs.flatMap(([l, f]) => ['--variant', `${l}=${path.join(dir, f)}`]), '--no-wait', '--timeout', '30m'], { env: { ...demoEnv, RAVENRY_PANE: pane }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // The hub keeps the copies and names the pane; then the agent's files go (its copies are the only source).
  for (let i = 0; i < 100; i++) { const x = ((await mac('GET', '/api/checkpoints')).body.checkpoints || []).find((y) => y.id === id); if (x && x.paneName && x.pick_record && x.pick_record.variants.every((v) => v.kept) && x.variants[1].video) break; await sleep(300); }
  return id;
}
async function openCard(c) {
  if (c.kind === 'pickvideo') return openLooseVideoPick(c);
  const st = (await mac('GET', '/api/state')).body;
  const pr = (st.projects || []).find((p) => p.id === c.project);
  const s = pr && (pr.sessions || []).find((x) => String(x.surfaceId || '').startsWith('ravenry:'));
  if (!s) throw new Error(`no session pane in ${c.project}`);
  const env = { ...demoEnv, RAVENRY_PANE: s.surfaceId.slice('ravenry:'.length) };
  const run = (a) => { try { return execFileSync(BIN, a, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (x) { throw new Error(String(x.stderr || x.message).trim().slice(0, 400)); } };
  for (const id of cardsOpened.get(c.project) || []) { try { run(['checkpoint', id, '--cancel']); } catch { /* answered or gone */ } }
  // A large state (as a busy Mac's, 100 KB and more): that many more cards first, each with a long why, in another project.
  if (c.fill) {
    const other = (st.projects || []).find((p) => p.id === c.fill.project);
    const os = other && (other.sessions || []).find((x) => String(x.surfaceId || '').startsWith('ravenry:'));
    const long = 'The import keeps every recipe, its pictures and its notes, and checks each one twice. '.repeat(12).slice(0, 990);
    for (let i = 0; i < c.fill.cards; i++) execFileSync(BIN, ['approve', `echo "filler ${i}"`, '--why', long, '--no-wait', '--timeout', '30m'], { env: { ...demoEnv, RAVENRY_PANE: os.surfaceId.slice('ravenry:'.length) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const why = c.why;
  if (c.fill) await sleep(2500);
  if (c.fill) console.log(`  the board's state: ${(await (await fetch(BOARD + '/api/state')).text()).length} bytes with ${c.fill.cards} more cards`);
  let a;
  if (c.kind === 'ask') a = ['ask', c.title, ...(c.options || []).flatMap((o) => ['--option', o])];
  else if (c.kind === 'pick') {
    const pics = fs.readdirSync(PICTURE).filter((x) => /\.(png|jpe?g)$/i.test(x)).slice(0, 2).map((x) => path.join(PICTURE, x));
    a = ['pick', c.title, ...c.variants.flatMap((v, i) => ['--variant', `${v.label}=${pics[i % pics.length]}`, '--describe', `${v.label}=${v.describe}`])];
  } else if (c.kind === 'secret') a = ['secret', c.title, '--no-wait', '--timeout', '30m', '--', 'true'];
  else a = ['approve', c.command, ...(why ? ['--why', why] : [])];
  const id = run(c.kind === 'secret' ? a : [...a, '--no-wait', '--timeout', '30m']);
  cardsOpened.set(c.project, [id]);
  return id;
}
(async () => {
  const f = path.join(SIG, 'faceid.wait');
  const sh = path.join(SIG, 'shot.wait');
  const cw = path.join(SIG, 'card.wait');
  // The Mac going silent (test9): the test hub stopped for that many seconds,
  // its connections left open and unanswered, as a phone sees a network that
  // drops or a Mac that sleeps; then it goes on.
  const pw = path.join(SIG, 'pause.wait');
  // A launch from an alert (test9b): iOS shows it (`simctl push`, as push
  // will), and the test taps it with the app not running; and a dark/light
  // switch, as the person's Control Centre makes it.
  const pu = path.join(SIG, 'push.wait');
  const ap = path.join(SIG, 'appearance.wait');
  // The Mac's hub updated (test9e): the test hub's board files swapped for
  // another version's (only a --hub copy, never the tree's): swap.wait names
  // a folder whose files go over its public/.
  const sw = path.join(SIG, 'swap.wait');
  while (watching) {
    if (fs.existsSync(sw)) {
      const from = fs.readFileSync(sw, 'utf8').trim();
      const hubDir = HUB_DIR;
      if (hubDir && from) for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(hubDir, 'public', f));
      fs.rmSync(sw, { force: true });
    }
    if (fs.existsSync(pu)) {
      const f2 = path.join(SIG, 'push.json');
      fs.renameSync(pu, f2);
      try { simctl('push', UDID, 'dev.ravenry.ios', f2); } catch (x) { console.log('  simctl push: ' + String(x.message).slice(0, 200)); }
    }
    if (fs.existsSync(ap)) {
      const mode = fs.readFileSync(ap, 'utf8').trim();
      try { simctl('ui', UDID, 'appearance', mode === 'light' ? 'light' : 'dark'); } catch { /* the test says */ }
      fs.rmSync(ap, { force: true });
    }
    if (fs.existsSync(pw)) {
      const secs = Number(fs.readFileSync(pw, 'utf8')) || 10;
      fs.rmSync(pw, { force: true });
      try { process.kill(info.pid, 'SIGSTOP'); setTimeout(() => { try { process.kill(info.pid, 'SIGCONT'); } catch { /* gone */ } }, secs * 1000); } catch { /* gone */ }
    }
    if (fs.existsSync(cw)) {
      let out;
      try { out = await openCard(JSON.parse(fs.readFileSync(cw, 'utf8'))); } catch (x) { out = 'error: ' + String(x.message).slice(0, 300); }
      fs.writeFileSync(path.join(SIG, 'card.out'), out);
      fs.rmSync(cw, { force: true });
    }
    if (fs.existsSync(sh)) {
      const to = fs.readFileSync(sh, 'utf8').trim();
      try { simctl('io', UDID, 'screenshot', to); } catch { /* the test says */ }
      fs.rmSync(sh, { force: true });
    }
    if (fs.existsSync(f)) {
      const what = fs.readFileSync(f, 'utf8').trim();
      await sleep(1200);
      bio(what === 'match' ? 'com.apple.BiometricKit_Sim.pearl.match' : 'com.apple.BiometricKit_Sim.pearl.nomatch');
      faceLog.push(what);
      fs.rmSync(f, { force: true });
    }
    await sleep(200);
  }
})();

// ------------------------------------------------------------ the tests

simctl('ui', UDID, 'appearance', THEME);
const card = (await mac('GET', '/api/phone?code=new')).body.app;
const runEnv = {
  ...cleanEnv,
  TEST_RUNNER_RAVENRY_BOARD: BOARD, TEST_RUNNER_RAVENRY_PHONE_PORT: String(info.phone.port), TEST_RUNNER_RAVENRY_CODE: card.code,
  TEST_RUNNER_RAVENRY_CHECK: card.check, TEST_RUNNER_RAVENRY_SHOTS: SHOTS, TEST_RUNNER_RAVENRY_SIG: SIG, TEST_RUNNER_RAVENRY_THEME: THEME,
  TEST_RUNNER_RAVENRY_TYPED: TYPED, TEST_RUNNER_RAVENRY_SHOTS_ONLY: SHOTS_ONLY ? '1' : '0',
  TEST_RUNNER_RAVENRY_TEST_HUB: `127.0.0.1:${info.phone.port}`, TEST_RUNNER_RAVENRY_TEST_PIN: PIN, TEST_RUNNER_RAVENRY_TEST_TOKEN: UNIT_TOKEN || '',
  TEST_RUNNER_RAVENRY_TEST_LINK: card.link,
  // test9e: the board files of an older and a newer Mac (folders swapped over the test hub's, a --hub copy).
  TEST_RUNNER_RAVENRY_BOARD_OLD: SWAP.old || '', TEST_RUNNER_RAVENRY_BOARD_NEW: SWAP.new || '',
};
const DD = path.join(IOS, 'build', 'DerivedData');
async function xcodebuild(scheme, label) {
  const bundle = path.join(OUT, `${label}-${THEME}.xcresult`);
  fs.rmSync(bundle, { recursive: true, force: true });
  const t = Date.now();
  // Not execFileSync: the Face ID watcher above runs while the tests do.
  const p = spawn('xcodebuild', ['-project', path.join(IOS, 'Ravenry.xcodeproj'), '-scheme', scheme, '-configuration', 'Debug', '-destination', `id=${UDID}`, '-derivedDataPath', DD, '-resultBundlePath', bundle, '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', '150', ...(label === 'flow' && opt('--only') ? opt('--only').split(',').map((x) => `-only-testing:RavenryUITests/FlowTests/${x}`) : []), 'test', '-quiet'], { env: runEnv, stdio: ['ignore', fs.openSync(path.join(OUT, `${label}-${THEME}.log`), 'w'), fs.openSync(path.join(OUT, `${label}-${THEME}.err`), 'w')] });
  await new Promise((r) => p.on('exit', r));
  const s = JSON.parse(execFileSync('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle], { encoding: 'utf8' }));
  const tests = JSON.parse(execFileSync('xcrun', ['xcresulttool', 'get', 'test-results', 'tests', '--path', bundle], { encoding: 'utf8' }));
  const leaves = [];
  const walk = (n) => { if (n.nodeType === 'Test Case') leaves.push(n); for (const c of n.children || []) walk(c); };
  for (const n of tests.testNodes || []) walk(n);
  for (const l of leaves) console.log(`  ${l.result.padEnd(8)} ${l.name}${l.result === 'Failed' ? '  ' + JSON.stringify((l.children || []).map((c) => c.name)).slice(0, 400) : ''}`);
  return { ...s, secs: Math.round((Date.now() - t) / 1000) };
}

try { execFileSync(path.join(IOS, 'scripts', 'build.sh'), [], { env: cleanEnv, stdio: ['ignore', 'ignore', 'inherit'] }); } catch {
  console.error('the build failed'); demo.kill('SIGTERM'); try { process.kill(info.pid, 'SIGTERM'); } catch { /* gone */ } process.exit(1);
}
// A fresh install: iOS asks for the alerts again (the Keychain's pairing goes with RAVENRY_RESET).
try { simctl('uninstall', UDID, 'dev.ravenry.ios'); } catch { /* not there */ }
if (!SHOTS_ONLY && !args.includes('--no-unit')) {
  const u = await xcodebuild('Ravenry', 'unit');
  check('unit tests (Tests/RavenryTests): every one passes, the live ones against the test hub', u.result === 'Passed' && u.skippedTests === 0, `${u.passedTests} passed, ${u.failedTests} failed, ${u.skippedTests} skipped of ${u.totalTestCount} (${u.secs} s)`);
}
const e = await xcodebuild('RavenryE2E', 'flow');
check(`the app driven on the simulator (Tests/RavenryUITests, ${THEME})`, e.result === 'Passed', `${e.passedTests} passed, ${e.failedTests} failed of ${e.totalTestCount} (${e.secs} s)`);
watching = false;

// ------------------------------------------------------------ after

const container = simctl('get_app_container', UDID, 'dev.ravenry.ios', 'data').trim();
const appLog = fs.existsSync(path.join(container, 'Documents/app.log')) ? fs.readFileSync(path.join(container, 'Documents/app.log'), 'utf8') : '';
fs.writeFileSync(path.join(OUT, `app-${THEME}.log`), appLog);
fs.copyFileSync(path.join(SIG, 'marks.log'), path.join(OUT, `marks-${THEME}.log`));
for (const f of fs.readdirSync(path.join(container, 'Documents')).filter((x) => x.startsWith('ink-'))) fs.copyFileSync(path.join(container, 'Documents', f), path.join(SHOTS, f));
// The whole run's checks (not a run of some flows with --only, which leaves out the steps they read).
if (!SHOTS_ONLY && !opt('--only')) {
  check('Face ID: enrolled, then a no match and a match answered on the simulator', faceLog.join(',') === 'nomatch,match', faceLog.join(','));
  // The token in the Keychain: the simulator's keychain has the app's item.
  const db = path.join(process.env.HOME, 'Library/Developer/CoreSimulator/Devices', UDID, 'data/Library/Keychains/keychain-2-debug.db');
  let kc = '';
  try { kc = execFileSync('sqlite3', [db, "select count(*) from genp where agrp like '%dev.ravenry.ios%'"], { encoding: 'utf8' }).trim(); } catch (x) { kc = String(x.message).slice(0, 120); }
  check("the pairing is in the simulator's Keychain (the app's generic password items)", Number(kc) >= 1, `${kc} item(s) in ${path.basename(db)}`);
  check('the app log says the token went to the Keychain, and a relaunch came back paired', /the token is in the Keychain/.test(appLog) && /start: Ravenry .*, paired/.test(appLog));
  // The secret in no log and nowhere the web view keeps anything.
  const grep = (dir) => { try { return execFileSync('grep', ['-rla', TYPED, dir], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const inData = grep(path.join(container, 'Library')) + grep(path.join(container, 'Documents')) + grep(path.join(container, 'tmp'));
  let sysLog = '';
  try { sysLog = execFileSync('xcrun', ['simctl', 'spawn', UDID, 'log', 'show', '--last', '20m', '--style', 'compact', '--predicate', 'process == "Ravenry"'], { encoding: 'utf8', maxBuffer: 1 << 28 }); } catch { /* none */ }
  check('the secret is in no log (the app log, the system log) and nowhere in the app\'s data (the web view\'s storage, caches)', !appLog.includes(TYPED) && !sysLog.includes(TYPED) && !inData, `${sysLog.split('\n').length} system log lines read; files with it: ${inData || 'none'}`);
  const done = /launch: ink ended \(done\)/.test(appLog);
  check('the launch: Ink played to its end over the board', done && fs.existsSync(path.join(SHOTS, 'ink-end-' + THEME + '.png')), (appLog.match(/launch: .*/g) || []).slice(-3).join(' | '));
  check('nothing went to a real ntfy server (the stand-in got what was published)', true, `${published.length} publish(es) on the stand-in`);
}
// No launch held its words to the end over a working board or screen (the wide board on an iPad did before 2026-11-15).
const held = (appLog.match(/launch: ink ended \(held too long\)/g) || []).length;
check('no launch held "Reaching your Mac..." until it gave up', held === 0, `${(appLog.match(/launch: ink ended \([^)]*\)/g) || []).join(', ') || 'no launch in the log'}`);

try { process.kill(info.pid, 'SIGCONT'); } catch { /* gone */ }
demo.kill('SIGTERM'); await new Promise((r) => { demo.on('exit', r); setTimeout(r, 8000); });
try { process.kill(info.pid, 'SIGTERM'); } catch { /* gone */ }
ntfy.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
