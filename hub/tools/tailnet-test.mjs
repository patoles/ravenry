#!/usr/bin/env node
// Away from home, end to end (server/tailnet.mjs, docs/PHONE.md section 2):
// a throwaway board whose Ravenry device joins a tailnet of this Mac
// (daemon/tools/tailnetlab: Tailscale's test control server and a relay on
// 127.0.0.1, never a real tailnet), and phone stand-ins on that tailnet.
//
//   - nothing joins or listens while phone access or the switch is off;
//   - Sign in with Tailscale answers with the sign-in page, Cancel leaves no
//     keys; the page opened (the person's browser): on as ravenry, its name,
//     address and account on the card, its keys in a 0700 folder;
//   - the pairing link lists the Wi-Fi first, then ravenry's MagicDNS name
//     and its 100.x address;
//   - the owner's phone pairs over the tailnet (the hub's real pairing code,
//     its pin the one the link carries), and its token reads the board by
//     the MagicDNS name; another account's device is closed at the
//     connection and never reaches the board;
//   - phone access off, or the switch off: the device stops (nothing
//     answers); on again: back from its keys with no sign-in;
//   - Sign out: Tailscale takes the log-out, the keys and the switch go;
//   - a sign-in left unfinished fails ("nothing changed"), Try again works;
//   - no internet: offline, the name kept;
//   - the board gone: its device goes too.
//
// Usage: RAVENRYD_BIN=../apps/macos/build/ravenryd [TAILNETLAB_BIN=...] node tools/tailnet-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
const T = path.join(ROOT, '.tmp', 'tailnet-test');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
for (const d of [MC, path.join(T, 'root', 'boat'), path.join(T, 'claude'), path.join(T, 'home')]) fs.mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

const BIN = process.env.RAVENRYD_BIN ? path.resolve(process.env.RAVENRYD_BIN) : null;
if (!BIN || !fs.existsSync(BIN)) { console.error('tailnet-test: RAVENRYD_BIN names a ravenryd build (apps/macos/scripts/build.sh makes apps/macos/build/ravenryd)'); process.exit(2); }
let LAB = process.env.TAILNETLAB_BIN;
if (!LAB) {
  LAB = path.join(T, 'tailnetlab');
  execFileSync('go', ['build', '-o', LAB, './tools/tailnetlab'], { cwd: path.join(REPO, 'daemon'), stdio: ['ignore', 'ignore', 'inherit'] });
}

// The test control server is a test's switch only: a person's board quits
// on it (exit 2) before it listens, so does one that names a server that is
// not on this Mac, and ravenryd takes no control server but Tailscale's or
// one on loopback.
const switchRun = (ctl, test) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { controlFrom } from ${JSON.stringify(path.join(ROOT, 'server', 'tailnet.mjs'))}; controlFrom({ MC_TEST_TAILNET_CONTROL: ${JSON.stringify(ctl)} }, ${test}); console.log('took it');`], { encoding: 'utf8', env: withTestHome({ ...process.env, RAVENRY_HOME: path.join(T, 'unit') }) });
let r = switchRun('http://127.0.0.1:1', false);
check('the test control server on a person\'s board: exit 2, refused', r.status === 2 && /test switch/.test(r.stderr) && !r.stdout.includes('took it'), `exit ${r.status} ${r.stderr.trim()}`);
r = switchRun('https://controlplane.tailscale.com', true);
check('a test\'s board naming a server off this Mac: exit 2', r.status === 2 && /not http on this Mac/.test(r.stderr) && !r.stdout.includes('took it'), `exit ${r.status} ${r.stderr.trim()}`);
r = switchRun('http://127.0.0.1:1', true);
check('a test\'s board with a server on 127.0.0.1: taken', r.status === 0 && r.stdout.includes('took it'), `exit ${r.status} ${r.stderr.trim()}`);
r = spawnSync(BIN, ['tailnet', '--dir', path.join(T, 'x'), '--forward', '1', '--control-url', 'http://203.0.113.5:80'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(T, 'home') }, timeout: 10000 });
check('ravenryd tailnet refuses a control server off this Mac', r.status !== 0 && /must be http on this Mac/.test(r.stderr) && !fs.existsSync(path.join(T, 'x')), `exit ${r.status} ${r.stderr.trim()}`);

// The tailnet of this Mac.
const lab = spawn(LAB, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const labUp = await new Promise((resolve) => { let b = ''; lab.stdout.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) resolve(JSON.parse(b.slice(0, i))); }); });
const labCall = async (method, p, body) => { const r = await fetch(labUp.admin + p, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); };
const ravenryNode = async () => (await labCall('GET', '/nodes')).find((n) => n.name === 'ravenry') || null;

const PORT = 4851;
const PPORT = 4852;
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces: [], screens: {} }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false },
  projects: [{ id: 'boat', name: 'paper-boat', folder: path.join(T, 'root', 'boat'), workspaces: [] }],
}, null, 2));
const SIGNIN_MS = 6000;
const env = withTestHome({
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_PHONE_PORT: String(PPORT), RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_HUB_NAME: 'Test hub',
  MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_ALERT_PRIME_MS: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: path.join(T, 'claude'),
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: path.join(T, 'run'), RAVENRY_STATE_DIR: path.join(T, 'state'),
  MC_TEST_TAILNET_CONTROL: labUp.control, MC_TAILNET_SIGNIN_MS: String(SIGNIN_MS),
});
let log = '';
function startBoard() {
  const b = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  b.stdout.on('data', (d) => { log += d; });
  b.stderr.on('data', (d) => { log += d; });
  return b;
}
let board = startBoard();
process.on('exit', () => { try { board.kill('SIGTERM'); } catch { /* gone */ } try { lab.stdin.end(); lab.kill('SIGTERM'); } catch { /* gone */ } });

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}
const mac = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const away = async () => (await mac('GET', '/api/phone')).body.away;
const DIR = path.join(MC, 'tailnet');
const INFO = path.join(MC, 'tailnet.json');
const devicePids = () => { try { return execFileSync('/usr/bin/pgrep', ['-f', `tailnet --dir ${DIR}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };

const up = await until(async () => (await mac('GET', '/api/state')).status === 200, 20000);
check('the board answers', !!up, log.slice(-500));

// Off.
const a0 = await away();
check('off: the switch is off, nothing runs, ravenry is not on the tailnet', a0 && a0.on === false && a0.state === 'off' && devicePids().length === 0 && !(await ravenryNode()), JSON.stringify(a0));
const sw = await mac('POST', '/api/phone/away', { on: true });
check('the switch on with phone access off: ready, still nothing runs', sw.status === 200 && sw.body.away.on === true && sw.body.away.state === 'ready' && devicePids().length === 0, JSON.stringify(sw.body.away));
const noAccess = await mac('POST', '/api/phone/away/signin');
check('Sign in with phone access off: 409, nothing runs', noAccess.status === 409 && devicePids().length === 0, JSON.stringify(noAccess.body));
await mac('POST', '/api/phone/access', { on: true });
check('phone access on, not signed in: ready, nothing joined', (await away()).state === 'ready' && devicePids().length === 0 && !(await ravenryNode()));

// Sign in, Cancel, Sign in again.
let si = await mac('POST', '/api/phone/away/signin');
check('Sign in with Tailscale: waiting, with the sign-in page', si.status === 200 && si.body.away.state === 'waiting' && String(si.body.away.authURL).startsWith(labUp.control + '/auth/') && devicePids().length === 1, JSON.stringify(si.body.away));
const cancelled = await mac('POST', '/api/phone/away/cancel');
check('Cancel: ready again, the device stopped, no keys kept', cancelled.status === 200 && cancelled.body.away.state === 'ready' && !cancelled.body.away.authURL && (await until(async () => devicePids().length === 0, 5000)) && !fs.existsSync(DIR), JSON.stringify(cancelled.body.away));
si = await mac('POST', '/api/phone/away/signin');
check('Sign in again: a new sign-in page', si.body.away.state === 'waiting' && !!si.body.away.authURL);
const signinsBefore = (await labCall('GET', '/signins')).count;
const page = await fetch(si.body.away.authURL);
check('the sign-in page opened (the person\'s browser)', page.status === 200);
const on = await until(async () => { const a = await away(); return a.state === 'on' ? a : null; }, 30000);
check('on: reachable as ravenry on the account\'s Tailscale', !!on && on.name === 'ravenry' && on.host === 'ravenry.tail1234.ts.net' && /^100\./.test(on.ips[0]) && /@/.test(on.account) && on.listening === true, `${JSON.stringify(on)} at ${secs()}`);
const dirMode = fs.statSync(DIR).mode & 0o777, infoMode = fs.statSync(INFO).mode & 0o777;
check('its keys in a 0700 folder of the data, what it is in a 0600 file', dirMode === 0o700 && infoMode === 0o600 && fs.existsSync(path.join(DIR, 'tailscaled.state')), `${dirMode.toString(8)} ${infoMode.toString(8)}`);
check('the sign-in URL is in no log line', !log.includes('/auth/'));
const signinsOn = (await labCall('GET', '/signins')).count;

// The pairing link.
const card = (await mac('GET', '/api/phone')).body;
const hosts = new URL(card.app.link.replace(/^ravenry:/, 'https:')).searchParams.get('hosts').split(',');
const wifi = card.wifi;
const iName = hosts.indexOf('ravenry.tail1234.ts.net'), iIp = hosts.indexOf(on.ips[0]);
check('the pairing link: the Wi-Fi first, then ravenry\'s MagicDNS name, then its 100.x address', iName >= 0 && iIp === iName + 1 && (!wifi || hosts[0] === wifi) && hosts.at(-1) === '10.0.2.2', hosts.join(','));
const pin = new URL(card.app.link.replace(/^ravenry:/, 'https:')).searchParams.get('pin');

// The owner's phone, over the tailnet.
const addr = `${on.ips[0]}:${PPORT}`;
const paired = await labCall('POST', '/phone', { name: 'pixel', kind: 'owner', addr, method: 'POST', path: '/api/phone/pair', body: JSON.stringify({ code: card.app.code, name: 'Pixel away', platform: 'android', app: '0.4.2' }) });
let tok = null;
try { tok = JSON.parse(paired.body).token; } catch { /* below */ }
check('the owner\'s phone pairs over the tailnet with the card\'s code, and the key is the pinned one', paired.status === 200 && !!tok && paired.pin === pin, JSON.stringify(paired).slice(0, 300));
const devs = (await mac('GET', '/api/phone/devices')).body.devices;
check('the card lists it', devs.some((d) => d.name === 'Pixel away'));
const byName = await labCall('POST', '/phone', { name: 'pixel', kind: 'owner', addr: `ravenry.tail1234.ts.net:${PPORT}`, method: 'GET', path: '/api/phone/me', token: tok });
check('its token reads the board by the MagicDNS name', byName.status === 200 && /"Pixel away"/.test(byName.body), JSON.stringify(byName).slice(0, 200));
const noTok = await labCall('POST', '/phone', { name: 'pixel', kind: 'owner', addr, method: 'GET', path: '/api/state' });
check('the hub\'s own checks still hold over the tailnet: no token, 401', noTok.status === 401);

// Another account's device.
const nDev = devs.length;
const stranger = await labCall('POST', '/phone', { name: 'stranger', kind: 'stranger', addr, method: 'POST', path: '/api/phone/pair', body: JSON.stringify({ code: card.app.code, name: 'Not mine' }) });
check('another account\'s device is closed at the connection', stranger.status === 0 && !!stranger.error && !stranger.pin, JSON.stringify(stranger));
check('it never reached the board', (await mac('GET', '/api/phone/devices')).body.devices.length === nDev && !!(await until(async () => /tailnet: refused 100\.[\d.]+: a device of another account/.test(log), 3000)));

// Phone access off, then on.
await mac('POST', '/api/phone/access', { on: false });
const paused = await until(async () => { const a = await away(); return a.state === 'paused' && devicePids().length === 0 ? a : null; }, 8000);
check('phone access off: the device stopped (paused), its keys kept', !!paused && fs.existsSync(path.join(DIR, 'tailscaled.state')), JSON.stringify(paused));
const offReq = await labCall('POST', '/phone', { name: 'pixel', addr, method: 'GET', path: '/api/phone/hello' });
check('nothing answers on the tailnet', offReq.status === 0, JSON.stringify(offReq).slice(0, 200));
await mac('POST', '/api/phone/access', { on: true });
const back = await until(async () => { const a = await away(); return a.state === 'on' ? a : null; }, 30000);
const helloBack = await labCall('POST', '/phone', { name: 'pixel', addr, method: 'GET', path: '/api/phone/hello' });
check('on again: back from its keys with no sign-in, the phone reaches it', !!back && back.host === on.host && (await labCall('GET', '/signins')).count === signinsOn && signinsOn === signinsBefore + 1 && helloBack.status === 200, `${JSON.stringify(back)} signins ${(await labCall('GET', '/signins')).count}`);

// The switch off, then on.
await mac('POST', '/api/phone/away', { on: false });
const swOff = await until(async () => { const a = await away(); return a.state === 'off' && devicePids().length === 0 ? a : null; }, 8000);
check('Away from home off: off, nothing runs', !!swOff);
await mac('POST', '/api/phone/away', { on: true });
check('on again: on, no sign-in', !!(await until(async () => (await away()).state === 'on', 30000)));

// The board gone: its device goes too.
const pids = devicePids();
board.kill('SIGKILL');
check('the board killed: its device ends with it (its input closed)', pids.length === 1 && !!(await until(async () => devicePids().length === 0, 8000)), `pids ${pids}`);
board = startBoard();
await until(async () => (await mac('GET', '/api/state')).status === 200, 20000);
check('a new board: on again from the keys', !!(await until(async () => (await away()).state === 'on', 30000)));

// Sign out.
const so = await mac('POST', '/api/phone/away/signout');
check('Sign out: Tailscale took the log-out, the keys and the switch went', so.status === 200 && so.body.removed === true && so.body.away.state === 'off' && so.body.away.on === false && !fs.existsSync(DIR) && !fs.existsSync(INFO) && devicePids().length === 0, JSON.stringify(so.body.away));

// A sign-in left unfinished.
await mac('POST', '/api/phone/away', { on: true });
si = await mac('POST', '/api/phone/away/signin');
check('signed out, Sign in asks for the page again', si.body.away.state === 'waiting');
const failed = await until(async () => { const a = await away(); return a.state === 'failed' ? a : null; }, SIGNIN_MS + 8000);
check('a sign-in left unfinished: failed, nothing changed (no keys, nothing runs)', !!failed && failed.error === 'The sign-in did not finish, so nothing changed.' && !fs.existsSync(DIR) && devicePids().length === 0, JSON.stringify(failed));
si = await mac('POST', '/api/phone/away/signin');
check('Try again: a new sign-in page', si.body.away.state === 'waiting' && !!si.body.away.authURL);
await fetch(si.body.away.authURL);
const on2 = await until(async () => { const a = await away(); return a.state === 'on' ? a : null; }, 30000);
check('signed in again', !!on2);

// No internet.
await labCall('POST', '/down');
const tOff = Date.now();
const off = await until(async () => { const a = await away(); return a.state === 'offline' ? a : null; }, 70000);
check('no internet: offline, the name kept', !!off && off.host === on2.host, `${JSON.stringify(off)} after ${((Date.now() - tOff) / 1000).toFixed(1)} s`);

console.log(fails ? `\n${fails} FAILED (${secs()})` : `\nall passed (${secs()})`);
if (fails) console.log(log.slice(-3000));
process.exit(fails ? 1 : 0);
