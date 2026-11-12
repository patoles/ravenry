#!/usr/bin/env node
// Where the board listens (server/boardlisten.mjs, home.mjs hubBind,
// docs/PHONE.md section 2). The person's board listens on this Mac only
// (127.0.0.1 and ::1) while phone access is off, and on the network's
// addresses too only while it is on, switched live by the switch.
//
// A test board with RAVENRY_HUB_BIND=phone listens as the person's does, on
// a free port, data under .tmp/board-bind; it is on the Wi-Fi only between
// this test's own "on" and "off" (a few seconds, phone access with a key
// nobody has, pairing by the code this test reads). Never touches :4600.
//
// 1. Off: lsof shows 127.0.0.1 and ::1 only; a TCP connection to the Mac's
//    Wi-Fi address on the board's port and on the phone port is refused
//    (ECONNREFUSED, not a 403); loopback answers 200 on both families.
// 2. The app's own connection (the event stream on 127.0.0.1) stays open
//    and keeps getting states through on and off.
// 3. On (POST /api/phone/access, what the apps' switches post): the Wi-Fi
//    address answers on the board's port (a real request over it, and as a
//    phone signed in with the key through the stand-in); the card's pairing
//    hosts are the Wi-Fi's then the Tailscale one; pairing with the code
//    over TLS on the Wi-Fi address works at once.
// 4. Off again: the Wi-Fi address is refused again on both ports, the
//    connection held open over it is closed, loopback answers.
// 5. A second board on a taken port (a board of this tree, or a program
//    listening on every address, as an older board does) exits without
//    listening; RAVENRY_HUB_BIND=127.0.0.1 stays there with access on; a
//    test's board is 127.0.0.1 only; hubBind's rules.
// Usage: node tools/board-bind-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, lanAddress, phoneEnv, phoneRequest } from './as-phone.mjs';
import { hubBind } from '../server/home.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'board-bind');
fs.rmSync(T, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

const LAN = lanAddress();
if (!LAN) { console.log('FAIL  this Mac has no private LAN IPv4 address: nothing to prove the Wi-Fi side with'); process.exit(1); }

function home(name) {
  const h = path.join(T, name);
  for (const d of [h, path.join(T, 'root'), path.join(T, 'claude')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(h, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], projectsRoot: path.join(T, 'root') }, projects: [] }));
  return h;
}
function board(h, port, extra = {}) {
  const env = {
    ...process.env, RAVENRY_HOME: h, PORT: String(port), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0', RAVENRY_HUB_NAME: 'Test hub',
    CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'), MC_CLAUDE_PROJECTS: path.join(T, 'claude'),
    MC_PROJECTS_ROOT: path.join(T, 'root'), RAVENRY_PHONE_HOSTS: '100.101.102.103', ...extra,
  };
  const c = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withTestHome(env), stdio: ['ignore', 'pipe', 'pipe'] });
  c.log = '';
  c.stdout.on('data', (d) => { c.log += d; });
  c.stderr.on('data', (d) => { c.log += d; });
  c.exited = new Promise((r) => c.on('exit', (code) => r(code)));
  return c;
}
const listens = (pid) => { try { return execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-nP', '-Fn'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)).sort(); } catch { return []; } };
// 'open', or the connection's error code (ECONNREFUSED: nothing listens there).
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 2000);
  s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('open'); });
  s.once('error', (e) => { clearTimeout(t); resolve(e.code); });
});
const until = async (f, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await sleep(100); } return null; };
function get(host, port, p, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host, port, path: p, headers: { Host: `${host.includes(':') ? `[${host}]` : host}:${port}`, ...headers }, agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.end();
  });
}
function post(port, p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1', Origin: `http://127.0.0.1:${port}` }, agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* none */ } resolve({ status: res.statusCode, j }); }); });
    r.on('error', (e) => resolve({ status: 0, error: e.code }));
    r.end(data);
  });
}

const PORT = await freePort();
const PPORT = await freePort();
const STANDIN = await freePort();
const MC = home('mc');
const procs = [];
const A = board(MC, PORT, { RAVENRY_HUB_BIND: 'phone', RAVENRY_PHONE_PORT: String(PPORT), ...phoneEnv(STANDIN) });
procs.push(A);
let stream = null;
let held = null;
try {
  const up = await until(async () => (await get('127.0.0.1', PORT, '/api/state')).status === 200, 20000);
  check('the board is up on loopback', !!up, up ? '' : A.log.slice(-400));

  // 1. Off.
  let l = listens(A.pid);
  check('access off: the board listens on 127.0.0.1 and ::1 only (and the test\'s stand-in on 127.0.0.1)', JSON.stringify(l) === JSON.stringify([`127.0.0.1:${PORT}`, `127.0.0.1:${STANDIN}`, `[::1]:${PORT}`].sort()), l.join(', '));
  let w = await tcp(LAN, PORT), wp = await tcp(LAN, PPORT);
  check(`access off: ${LAN}:<board> and :<phone port> are refused at TCP`, w === 'ECONNREFUSED' && wp === 'ECONNREFUSED', `board ${w}, phone port ${wp}`);
  const v4 = await get('127.0.0.1', PORT, '/api/whoami'), v6 = await get('::1', PORT, '/api/whoami');
  check('access off: loopback answers 200 (127.0.0.1 and ::1)', v4.status === 200 && v6.status === 200, `${v4.status} ${v6.status}`);

  // 2. The app's own stream, open through every switch.
  let states = 0;
  let ended = false;
  stream = http.get({ host: '127.0.0.1', port: PORT, path: '/api/events?app=1', headers: { Accept: 'text/event-stream' }, agent: false }, (res) => {
    res.on('data', (d) => { states += (String(d).match(/^event: state$/gm) || []).length || (/data:/.test(String(d)) ? 1 : 0); });
    res.on('close', () => { ended = true; });
  });
  stream.on('error', () => { ended = true; });
  await until(() => states > 0, 5000);
  const s0 = states;

  // 3. On.
  const on = await post(PORT, '/api/phone/access', { on: true });
  check('POST /api/phone/access on: 200, access on', on.status === 200 && on.j && on.j.access === true, JSON.stringify(on.j || on.error).slice(0, 160));
  w = await until(async () => (await tcp(LAN, PORT)) === 'open' && 'open', 3000);
  check(`access on: ${LAN}:<board> takes a connection at once`, w === 'open');
  l = listens(A.pid);
  check('access on: the board listens on every address too, and the phone port opened', l.includes(`*:${PORT}`) && l.includes(`*:${PPORT}`) && l.includes(`127.0.0.1:${PORT}`) && l.includes(`[::1]:${PORT}`), l.join(', '));
  const wifi = await get(LAN, PORT, '/api/whoami');
  check(`access on: a request over ${LAN} gets the board's answer (a caller off this Mac: not the Mac)`, wifi.status >= 200 && wifi.status < 500 && !(wifi.status === 200 && JSON.parse(wifi.body || '{}').local === true), `HTTP ${wifi.status} ${String(wifi.body).slice(0, 120)}`);
  const key = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).key;
  const signIn = await phoneRequest(STANDIN, `http://${LAN}:${PORT}/?k=${encodeURIComponent(key)}`);
  const cookie = String([].concat(signIn.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const asPhone = cookie ? await phoneRequest(STANDIN, `http://${LAN}:${PORT}/api/state`, { headers: { Cookie: cookie } }) : { status: 0 };
  check('access on: a phone signs in with the key and reads the board (the stand-in)', !!cookie && asPhone.status === 200, `sign-in ${signIn.status}, state ${asPhone.status}`);
  const card = await get('127.0.0.1', PORT, '/api/phone');
  const app = card.status === 200 ? JSON.parse(card.body).app : null;
  const hosts = app ? new URL(app.link.replace(/^ravenry:/, 'https:')).searchParams.get('hosts').split(',') : [];
  check('access on: the pairing link names the Wi-Fi address first, then Tailscale\'s', hosts[0] === LAN && hosts.includes('100.101.102.103') && hosts.indexOf('100.101.102.103') > 0, hosts.join(','));
  const pair = await new Promise((resolve) => {
    const body = JSON.stringify({ code: app && app.code, name: 'Pixel', platform: 'android', app: '0.1.0' });
    const r = https.request({ host: LAN, port: PPORT, method: 'POST', path: '/api/phone/pair', rejectUnauthorized: false, agent: false, headers: { 'Content-Type': 'application/json', Host: `${LAN}:${PPORT}` } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', (e) => resolve({ status: 0, body: e.code }));
    r.end(body);
  });
  check(`access on: pairing with the code over TLS on ${LAN}:<phone port> works at once`, pair.status === 200 && /"token"/.test(pair.body), `HTTP ${pair.status} ${pair.body.slice(0, 120)}`);
  // A connection over the Wi-Fi held open (keep-alive), closed when access goes off.
  held = net.connect({ host: LAN, port: PORT });
  let heldClosed = false;
  held.on('close', () => { heldClosed = true; });
  held.on('error', () => {});
  await until(() => held.readyState === 'open', 2000);

  // 4. Off again.
  const off = await post(PORT, '/api/phone/access', { on: false });
  check('POST /api/phone/access off: 200, access off', off.status === 200 && off.j && off.j.access === false);
  w = await until(async () => { const a = await tcp(LAN, PORT), b = await tcp(LAN, PPORT); return a === 'ECONNREFUSED' && b === 'ECONNREFUSED' && 'refused'; }, 3000);
  check(`access off again: ${LAN}:<board> and :<phone port> are refused at TCP`, w === 'refused');
  check('access off again: the connection held open over the Wi-Fi was closed', !!(await until(() => heldClosed, 2000)));
  l = listens(A.pid);
  check('access off again: 127.0.0.1 and ::1 only', !l.some((x) => x.startsWith('*:')) && l.includes(`127.0.0.1:${PORT}`) && l.includes(`[::1]:${PORT}`), l.join(', '));
  const back = await get('127.0.0.1', PORT, '/api/state');
  // A state arrives on the stream after the switches (the board's tick).
  await until(() => states > s0 + 1, 8000);
  check('the app\'s stream on loopback stayed open through on and off, states still coming', !ended && states > s0 + 1 && back.status === 200, `ended ${ended}, states ${s0} then ${states}, state ${back.status}`);

  // 5. A taken port.
  const B = board(home('mc-b'), PORT, { RAVENRY_HUB_BIND: 'phone' });
  procs.push(B);
  const bx = await Promise.race([B.exited, sleep(15000).then(() => 'still running')]);
  check('a second board on the same port exits without listening', bx !== 'still running' && listens(B.pid).length === 0 && /already running|is taken/.test(B.log), `exit ${bx}: ${B.log.trim().split('\n').slice(-1)[0]}`);
  const QPORT = await freePort();
  const wild = net.createServer().listen({ port: QPORT, host: '::' });
  await new Promise((r) => wild.once('listening', r));
  const C = board(home('mc-c'), QPORT, { RAVENRY_HUB_BIND: 'phone' });
  procs.push(C);
  const cx = await Promise.race([C.exited, sleep(15000).then(() => 'still running')]);
  check('a port held on every address (as an older board holds it): the board exits, it does not listen beside it on 127.0.0.1', cx !== 'still running' && /already running|is taken/.test(C.log), `exit ${cx}: ${C.log.trim().split('\n').slice(-1)[0]}`);
  wild.close();
  const DPORT = await freePort();
  const D = board(home('mc-d'), DPORT, { RAVENRY_HUB_BIND: '127.0.0.1' });
  procs.push(D);
  await until(async () => (await get('127.0.0.1', DPORT, '/api/state')).status === 200, 20000);
  await post(DPORT, '/api/phone/access', { on: true });
  await sleep(500);
  l = listens(D.pid);
  check('RAVENRY_HUB_BIND=127.0.0.1 with access on: 127.0.0.1 only, the Wi-Fi refused', l.length > 0 && l.every((x) => x.startsWith('127.0.0.1:')) && (await tcp(LAN, DPORT)) === 'ECONNREFUSED', l.join(', '));
  await post(DPORT, '/api/phone/access', { on: false });
  const TEST = path.join(T, 'mc');
  check('hubBind: the person\'s board follows phone access (null), a test\'s is 127.0.0.1, RAVENRY_HUB_BIND wins, =phone follows access',
    hubBind({}, path.join(os.homedir(), '.ravenry')) === null && hubBind({}, TEST) === '127.0.0.1' && hubBind({ RAVENRY_HUB_BIND: '0.0.0.0' }, TEST) === '0.0.0.0' && hubBind({ RAVENRY_HUB_BIND: 'phone' }, TEST) === null);
} finally {
  if (stream) stream.destroy();
  if (held) held.destroy();
  for (const c of procs) c.kill();
}
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
