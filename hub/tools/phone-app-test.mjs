#!/usr/bin/env node
// The phone apps' side of the hub, end to end (docs/PHONE.md): the phone
// port (server/phonetls.mjs), pairing and devices (server/phone.mjs),
// push (server/push.mjs) and the terminal stream (server/termproxy.mjs),
// on a throwaway board with tools/fake-cmux.mjs as cmux and a scratch
// RAVENRY_HOME under .tmp/phone-app-test. Never the board on :4600.
//
//   - access off: no phone port at all; on: TLS, and the certificate's key
//     is the pin the pairing link carries, with the check number of the spec;
//   - hello without a token, everything else 401 without one;
//   - pairing: a wrong code, a used code, an old code and five wrong codes
//     in a minute are refused; the right one gives a token that works as
//     `Authorization: Bearer`, and nothing on the phone port is the Mac;
//   - RFC 8291: the encryption gives RFC 8291's own example byte for byte,
//     and a message round-trips through a receiver written here;
//   - a test alert reaches the device's push endpoint (a stub here) as
//     aes128gcm and its event stream as `event: phone`; the messages of
//     an ask, an approve and a secret have the spec's buttons (a secret
//     never has a reply line);
//   - who is the person: a device's token from another address is, the
//     same token from this machine is judged;
//   - revoke: the device's stream ends and its token gets 401 signedOut.
// With RAVENRYD_BIN (a ravenryd build), against a real throwaway daemon:
// a checkpoint opened in a pane reaches the phone as an ask, the terminal
// stream through the phone port shows a pane's bytes, and a method the
// phone may not send (checkpoint.answer) closes it with 1008.
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/phone-app-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'phone-app-test');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const UNIT = path.join(T, 'unit');
for (const d of [MC, UNIT, path.join(T, 'root', 'boat'), path.join(T, 'claude')]) fs.mkdirSync(d, { recursive: true });
process.env.RAVENRY_HOME = UNIT; // the modules imported below keep their files here

const { encrypt, checkpointMessage, projectMessage, checkTarget } = await import('../server/push.mjs');
const phone = await import('../server/phone.mjs');
const { pinOf } = await import('../server/phonetls.mjs');
const person = await import('../server/person.mjs');
const { frameReader } = await import('../server/termproxy.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

// ------------------------------------------------------------ RFC 8291 receiver

function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const rec = body.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ecdh = uaEcdh.computeSecret(asPub);
  const prkKey = hmac(auth, ecdh);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(rec.subarray(rec.length - 16));
  const out = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;
  if (out[end] !== 2) throw new Error('no last-record delimiter');
  return { text: out.subarray(0, end).toString('utf8'), rs };
}

// RFC 8291 section 5, the example.
{
  const as = crypto.createECDH('prime256v1');
  as.setPrivateKey(unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(unb64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
  const auth = unb64u('BTBZMqHH6r4Tts7J_aSIgg');
  const body = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), ua.getPublicKey(), auth, { as, salt: unb64u('DGv6ra1nlYgDCS1FRnbzlw') });
  const want = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  check('RFC 8291 section 5: the example encrypts to the RFC\'s bytes', b64u(body) === want, b64u(body).slice(0, 40));
  const back = decrypt(body, ua, auth);
  check('and decrypts back', back.text === 'When I grow up, I want to be a watermelon' && back.rs === 4096);
}

// ------------------------------------------------------------ messages
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const auth = crypto.randomBytes(16);
{
  const proj = { id: 'boat', name: 'paper-boat', sessions: [{ surfaceId: 'ravenry:pabcdefg', topic: 'Tilting the hull', assistant: 'claude' }] };
  const ask = checkpointMessage({ id: 'c1234567', kind: 'ask', title: 'Ship the beta to the testers?', options: ['Ship it', 'Not yet', 'Wait', 'Never'], free_text: true, pane: 'pabcdefg', assistant: 'claude', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }, { project: proj });
  check('an ask: its options as choice buttons (two with a free answer, the rest behind Open) and the Answer reply line', ask.id === 'cp:c1234567' && ask.kind === 'ask' && JSON.stringify(ask.actions.map((a) => a.id)) === '["choice:0","open"]' && ask.reply && ask.reply.label === 'Answer' && ask.body === 'Ship the beta to the testers?' && ask.session.topic === 'Tilting the hull', JSON.stringify(ask));
  const ask3 = checkpointMessage({ id: 'c2', kind: 'ask', title: 'Pick', options: ['A', 'B', 'C'], free_text: false });
  check('an ask without a free answer: up to three options, no reply line', JSON.stringify(ask3.actions.map((a) => a.label)) === '["A","B","C"]' && ask3.reply === null);
  const ap = checkpointMessage({ id: 'c3', kind: 'approve', title: 'Publish', command: 'git push origin main && npm publish', cwd: '/x/recipe-box', assistant: 'codex' }, { machine: 'devbox' });
  check('an approve: Run (fingerprint), Refuse, Open, and the command', JSON.stringify(ap.actions.map((a) => a.id)) === '["run","refuse","open"]' && ap.actions[0].biometric === true && ap.body === 'git push origin main && npm publish' && ap.reply === null && /devbox/.test(ap.detail));
  const se = checkpointMessage({ id: 'c4', kind: 'secret', title: 'Mail service API key', command: 'npx wrangler secret put MAIL_API_KEY', secret: { to: 'run' }, assistant: 'claude' });
  check('a secret: Type it and Not now, and never a reply line', JSON.stringify(se.actions.map((a) => [a.id, a.label])) === '[["open","Type it"],["decline","Not now"]]' && se.reply === null && !JSON.stringify(se).includes('reply":{'));
  const long = checkpointMessage({ id: 'c5', kind: 'approve', title: 'x', command: 'y'.repeat(9000) });
  check('a message stays within 3000 bytes', Buffer.byteLength(JSON.stringify(long)) <= 3000, String(Buffer.byteLength(JSON.stringify(long))));
  const perm = projectMessage({ kind: 'permission' }, { id: 'lp', name: 'landing-page', primary: 's1', state: 'you', question: 'Allow npm install sharp?', quick: [{ label: 'Yes', choice: 1 }, { label: 'Yes, always', choice: 2 }, { label: 'No', choice: 3 }, { label: 'Other', choice: 4 }], sessions: [{ surfaceId: 's1', topic: 'Lazy-load gallery', since: '2026-11-06T10:00:00Z' }] });
  check('a permission menu of four: its first two answers and Open', JSON.stringify(perm.actions.map((a) => a.id)) === '["quick:1","quick:2","open"]' && perm.title === 'Lazy-load gallery needs you' && perm.reply === null, JSON.stringify(perm.actions));
  const q = projectMessage({ kind: 'question' }, { id: 'w', name: 'weather-api', primary: 's2', state: 'you', question: 'Which do you want: 10 minutes or 30?', quick: [{ label: '10 minutes' }, { label: '30 minutes' }], sessions: [{ surfaceId: 's2', assistant: 'claude' }] });
  check('a question in a session: its quick answers (typed ones say their text) and Reply', JSON.stringify(q.actions) === '[{"id":"quick:0","label":"10 minutes","text":"10 minutes"},{"id":"quick:1","label":"30 minutes","text":"30 minutes"}]' && q.reply && q.reply.label === 'Reply');
  check('push targets: unifiedpush is checked, apns is not built yet, none clears', checkTarget({ kind: 'unifiedpush', endpoint: 'https://ntfy.example/up1?up=1', p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) }).ok && checkTarget({ kind: 'apns' }).status === 400 && checkTarget({ kind: 'none' }).target === null);
  // http: only to an address written as a number on this computer, the
  // home network or Tailscale (a self-hosted ntfy); never a host name or a
  // public address.
  const ep = (endpoint) => checkTarget({ kind: 'unifiedpush', endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) });
  const httpOk = ['http://127.0.0.1:2586/up1?up=1', 'http://localhost/up1', 'http://[::1]/up1', 'http://10.0.2.2:2586/upAbc?up=1', 'http://172.16.4.1/up1', 'http://172.31.255.1/up1', 'http://192.168.1.20:8080/up1', 'http://100.64.0.1/up1', 'http://100.127.9.9/up1', 'http://[fd7a:115c:a1e0::1]/up1', 'http://[fc00::5]/up1'];
  const httpNo = ['http://ntfy.example/up', 'http://ntfy.local/up', 'http://10.0.0.1.nip.io/up', 'http://8.8.8.8/up', 'http://172.32.0.1/up', 'http://100.128.0.1/up', 'http://[2001:db8::1]/up', 'http://[fc::1]/up', 'http://[fe80::1]/up', 'http://u:p@10.0.0.1/up', 'ftp://10.0.0.1/up', 'not a url'];
  const wrongOk = httpOk.filter((u) => !ep(u).ok);
  const wrongNo = httpNo.filter((u) => ep(u).ok);
  check('http endpoints: taken on loopback, the home network and Tailscale, refused to host names and public addresses', !wrongOk.length && !wrongNo.length, JSON.stringify({ refused: wrongOk, taken: wrongNo }));
  const said = ep('http://ntfy.example/up');
  check('a refused http endpoint says what is taken', said.status === 400 && /https, or http to an address on this computer, the home network or Tailscale/.test(said.error), said.error);
}

// ------------------------------------------------------------ pairing, in process
{
  phone.setAccess(true);
  const c = phone.pairingCode(1000);
  check('a pairing code is 16 characters of Crockford base32', /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c.code) && c.display === c.code.match(/.{4}/g).join('-'));
  const old = phone.pair({ code: c.code, name: 'x' }, 1000 + 10 * 60 * 1000 + 1);
  check('a code older than 10 minutes is refused', !old.ok && old.status === 401 && /out of date/.test(old.error));
  phone._resetPairing();
  check('the check number is the pin\'s first five bytes, modulo 10^12, as two groups of six', phone.checkNumber(b64u(Buffer.from([0, 0, 0, 1, 0, 9, 9]))) === '000000 000256' && /^\d{6} \d{6}$/.test(phone.checkNumber(b64u(crypto.randomBytes(32)))));
  const had = process.env.RAVENRY_HUB_NAME;
  delete process.env.RAVENRY_HUB_NAME;
  const plain = phone.hubName();
  process.env.RAVENRY_HUB_NAME = 'MacBook Pro';
  check('the hub\'s name: the host name up to its first dot, unless RAVENRY_HUB_NAME says', !plain.includes('.') && plain.length > 0 && phone.hubName() === 'MacBook Pro');
  if (had === undefined) delete process.env.RAVENRY_HUB_NAME; else process.env.RAVENRY_HUB_NAME = had;
  check('a typed code is read the Crockford way', phone.normalizeCode('abcd-efgh ijkl-mnoo') === 'ABCDEFGH1JK1MN00');
}

// ------------------------------------------------------------ who is the person
{
  const far = { mcPhone: 'h', socket: { remoteAddress: '192.0.2.7', remotePort: 5, localPort: 6 } };
  const here = { mcPhone: 'h', socket: { remoteAddress: '127.0.0.1', remotePort: 5, localPort: 6 } };
  const a = await person.fromPerson(far, '/usr/bin/false');
  const b = await person.fromPerson(here, '/usr/bin/false');
  const c = await person.fromPerson({ mcTls: true, mcPairing: true, socket: far.socket }, '/usr/bin/false');
  const d = await person.fromPerson({ mcTls: true, mcPairing: true, socket: here.socket }, '/usr/bin/false');
  check('a device\'s token from another address is the person', a.ok);
  check('the same token from this machine is judged (here: refused, nobody could say who)', !b.ok);
  check('a pairing on the phone port from another address is taken (its code is checked after); from here it is judged', c.ok && !d.ok);
  check('the new routes are person rows', ['/api/phone/pair', '/api/phone/unpair', '/api/phone/push', '/api/phone/devices/revoke', '/api/phone/devices/rename', '/api/phone/access'].every((p) => person.personRoute('POST', p)) && !!person.personRoute('GET', '/api/term') && !person.personRoute('GET', '/api/phone/me'));
}

// ------------------------------------------------------------ a board
const BIN = process.env.RAVENRYD_BIN ? path.resolve(process.env.RAVENRYD_BIN) : null;
const PORT = 4841;
const PPORT = 4842;
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces: [], screens: {} }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false },
  projects: [{ id: 'boat', name: 'paper-boat', folder: path.join(T, 'root', 'boat'), workspaces: [] }],
}, null, 2));
let daemon = null;
let RUN = null;
let D = null;
if (BIN) {
  D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvph-'));
  RUN = path.join(D, 'run');
  daemon = spawn(BIN, ['serve'], { env: { HOME: path.join(T, 'home'), PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') }, stdio: 'ignore' });
}
const env = withTestHome({
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_PHONE_PORT: String(PPORT), RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_HUB_NAME: 'Test hub',
  MC_NO_EVENTS: BIN ? '0' : '1', MC_REPEATS_AUTO: '0', MC_ALERT_PRIME_MS: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: path.join(T, 'claude'),
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  RAVENRY_DAEMON_BIN: BIN || 'none', MC_PUSH_RETRY_MS: '60000',
  // The daemon's folders are always a test's, a daemon or not (on Linux they
  // would default to the real /run/user).
  ...(BIN ? { RAVENRY_TERMINAL: 'ravenry', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') } : { RAVENRY_RUNTIME_DIR: path.join(T, 'run'), RAVENRY_STATE_DIR: path.join(T, 'state') }),
});
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
process.on('exit', () => { board.kill('SIGTERM'); if (daemon) daemon.kill('SIGTERM'); if (D) { try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } } });

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const mac = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// A request on the phone port, as the app makes it.
function phoneReq(method, p, { token = null, body = null, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `10.0.2.2:${PPORT}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) { headers['Content-Type'] = 'application/json'; headers['X-Ravenry'] = '1'; }
    const q = tlsRequest({ method, path: p, headers }, (res) => {
      if (stream) return resolve({ status: res.statusCode, res, req: q });
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: j, text: b }); });
    });
    q.on('error', reject);
    if (body) q.write(JSON.stringify(body));
    q.end();
  });
}
const https = await import('node:https');
const tlsRequest = (o, cb) => https.request({ host: '127.0.0.1', port: PPORT, rejectUnauthorized: false, agent: false, ...o }, cb);

const up = await until(async () => (await mac('GET', '/api/state')).status === 200, 20000);
check('the board answers', !!up, log.slice(-500));

const portOpen = () => new Promise((resolve) => { const s = net.connect(PPORT, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
check('phone access off: nothing listens on the phone port', !(await portOpen()));
const c0 = await mac('GET', '/api/phone');
check('the Mac\'s card says access is off and has no app pairing', c0.status === 200 && c0.body.access === false && !c0.body.app, JSON.stringify(c0.body).slice(0, 200));

const on = await mac('POST', '/api/phone/access', { on: true });
const card = on.body && on.body.app;
check('access on: the card has the pairing link, its QR, the code and the check number', on.status === 200 && on.body.access === true && !!card && /^ravenry:\/\/pair\?/.test(card.link) && /<svg/.test(card.svg) && /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(card.code) && /^\d{6} \d{6}$/.test(card.check), JSON.stringify(on.body).slice(0, 300));
const link = new URL(card.link.replace(/^ravenry:/, 'https:'));
const L = Object.fromEntries(link.searchParams);
check('the link is version 1 with the hub\'s name, its hosts (the emulator\'s last), the phone port, the pin and the code', L.v === '1' && L.name === 'Test hub' && L.hosts.split(',').at(-1) === '10.0.2.2' && L.port === String(PPORT) && /^[A-Za-z0-9_-]{43}$/.test(L.pin) && L.code === card.code.replace(/-/g, ''), JSON.stringify(L));
check('the check number is the pin\'s', card.check === phone.checkNumber(L.pin));
const again = await mac('GET', '/api/phone');
check('a card that refreshes keeps its code', again.body.app && again.body.app.code === card.code);
check('the phone port listens now', await until(portOpen, 5000));

const peer = await new Promise((resolve, reject) => { const s = tls.connect({ host: '127.0.0.1', port: PPORT, rejectUnauthorized: false }, () => { const c = s.getPeerX509Certificate(); s.destroy(); resolve(c); }); s.on('error', reject); });
check('TLS: the certificate\'s key is the pinned one (SHA-256 of its SubjectPublicKeyInfo)', pinOf(peer) === L.pin);

const hello = await phoneReq('GET', '/api/phone/hello');
check('hello needs no token', hello.status === 200 && hello.body.name === 'Test hub' && hello.body.api === 1);
const noTok = await phoneReq('GET', '/api/state');
check('anything else without a token: 401, signed out', noTok.status === 401 && noTok.body.signedOut === true);
const notMac = await phoneReq('GET', '/api/phone');
check('nothing on the phone port is the Mac, loopback included', notMac.status === 401);

const wrong = await phoneReq('POST', '/api/phone/pair', { body: { code: 'ZZZZZZZZZZZZZZZZ', name: 'Pixel', platform: 'android', app: '0.1.0' } });
check('a wrong code: 401', wrong.status === 401, wrong.text);
const paired = await phoneReq('POST', '/api/phone/pair', { body: { code: card.code, name: 'Pixel', platform: 'android', app: '0.1.0' } });
const TOKEN = paired.body && paired.body.token;
const DEV = paired.body && paired.body.device && paired.body.device.id;
check('the right code pairs: a token, the device, and the hub with the same pin', paired.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(TOKEN) && paired.body.device.name === 'Pixel' && paired.body.hub.pin === L.pin && paired.body.hub.api === 1, paired.text);
const reuse = await phoneReq('POST', '/api/phone/pair', { body: { code: card.code, name: 'Other' } });
check('the same code a second time: 401', reuse.status === 401);
const fresh = (await mac('GET', '/api/phone?code=new')).body.app.code;
for (let i = 0; i < 5; i++) await phoneReq('POST', '/api/phone/pair', { body: { code: 'ZZZZZZZZZZZZZZZ' + i } });
const locked = await phoneReq('POST', '/api/phone/pair', { body: { code: fresh } });
check('five wrong codes in a minute lock pairing, even for the right code', locked.status === 429, locked.text);
const raw = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8'));
check('phone.json keeps the token\'s hash only, mode 0600', !JSON.stringify(raw).includes(TOKEN) && raw.tokens.some((t) => t.id === DEV && t.platform === 'android') && (fs.statSync(path.join(MC, 'phone.json')).mode & 0o777) === 0o600);

const me = await phoneReq('GET', '/api/phone/me', { token: TOKEN });
check('the token works as a bearer: /api/phone/me', me.status === 200 && me.body.device.id === DEV && me.body.hub.api === 1, me.text);
const st = await phoneReq('GET', '/api/state', { token: TOKEN });
check('and every route of the board with it (/api/state)', st.status === 200 && Array.isArray(st.body.projects));
const macOnly = await phoneReq('GET', '/api/phone/devices', { token: TOKEN });
check('a phone cannot list or revoke devices', macOnly.status === 403);

// Push: a stub endpoint, and the device's event stream.
const got = [];
const stub = http.createServer((req, res) => { const ch = []; req.on('data', (d) => ch.push(d)); req.on('end', () => { got.push({ headers: req.headers, body: Buffer.concat(ch) }); res.writeHead(201); res.end(); }); });
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${stub.address().port}/up/abc?up=1`;
const setp = await phoneReq('POST', '/api/phone/push', { token: TOKEN, body: { kind: 'unifiedpush', endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } });
check('the device sets its push target', setp.status === 200 && setp.body.push === 'unifiedpush', setp.text);
const apns = await phoneReq('POST', '/api/phone/push', { token: TOKEN, body: { kind: 'apns', token: 'x' } });
check('apns is refused until it is built', apns.status === 400 && /not built yet/.test(apns.body.error));
const ev = await phoneReq('GET', '/api/events', { token: TOKEN, stream: true });
let evText = '';
let evEnded = false;
ev.res.on('data', (d) => { evText += d; });
ev.res.on('end', () => { evEnded = true; });
ev.res.on('close', () => { evEnded = true; });
await until(async () => evText.includes('event: state'), 5000);
const tst = await mac('POST', '/api/alerts/test', {});
check('Send a test reaches the paired app', tst.status === 200, JSON.stringify(tst.body));
await until(async () => got.length >= 1, 5000);
const g = got[0];
let msg = null;
try { msg = JSON.parse(decrypt(g.body, ua, auth).text); } catch (e) { msg = { error: e.message }; }
check('it reaches the push endpoint as aes128gcm with TTL and Urgency, and decrypts to a v1 test message', !!g && g.headers['content-encoding'] === 'aes128gcm' && g.headers.ttl === '3600' && g.headers.urgency === 'high' && msg.v === 1 && msg.type === 'test', JSON.stringify(msg));
await until(async () => evText.includes('event: phone'), 5000);
check('and the device\'s event stream as `event: phone`', /event: phone\ndata: \{"v":1,"type":"test"/.test(evText));

// With a daemon: a checkpoint opened in a pane reaches the phone as an ask.
let dc = null;
let pane = null;
if (BIN) {
  const { connectSocket } = await import('../../packages/node-client/index.mjs');
  const SOCK = await until(async () => { const n = fs.readdirSync(RUN).find((x) => x.endsWith('.sock')); return n ? path.join(RUN, n) : null; });
  dc = await connectSocket(SOCK, { name: 'phone-app-test' });
  pane = (await dc.request('pane.new', { command: ['/bin/sh', '-c', 'printf "hello from the pane\\n"; exec sleep 600'], cols: 80, rows: 10 })).pane;
  const n0 = got.length;
  const cp = (await dc.request('checkpoint.new', { kind: 'ask', title: 'Ship the beta to the testers?', options: ['Ship it', 'Not yet'], free_text: true, pane: pane.id })).checkpoint;
  await until(async () => got.length > n0, 10000);
  let m = null;
  try { m = JSON.parse(decrypt(got.at(-1).body, ua, auth).text); } catch (e) { m = { error: e.message }; }
  check('a checkpoint opened in a pane reaches the phone: an ask with its options and the Answer line', m.type === 'alert' && m.id === `cp:${cp.id}` && m.kind === 'ask' && JSON.stringify(m.actions.map((a) => a.label)) === '["Ship it","Not yet"]' && m.reply && m.reply.label === 'Answer', JSON.stringify(m).slice(0, 300));
  const ans = await phoneReq('POST', '/api/checkpoints/answer', { token: TOKEN, body: { id: cp.id, choice: 0, by: 'phone' } });
  check('the phone answers it with its token', ans.status === 200 && ans.body.checkpoint.state === 'answered' && ans.body.checkpoint.answer.by === 'phone', ans.text);
  await until(async () => got.length > n0 + 1, 10000);
  let cl = null;
  try { cl = JSON.parse(decrypt(got.at(-1).body, ua, auth).text); } catch { /* below */ }
  check('and the alert comes off the phone: close', !!cl && cl.type === 'close' && cl.id === `cp:${cp.id}`, JSON.stringify(cl));

  // The terminal through the phone port.
  const ws = await wsOpen(`/api/term?pane=${pane.id}`, TOKEN);
  check('the terminal stream opens: 101 with ravenry.v1', ws.status === 101 && /ravenry\.v1/i.test(ws.head), ws.head.split('\r\n')[0]);
  ws.send(JSON.stringify({ v: 1, type: 'hello', id: 1, client: { name: 'phone-app-test', version: '0' } }));
  await until(async () => ws.texts.some((t) => t.type === 'result' && t.id === 1), 5000);
  ws.send(JSON.stringify({ v: 1, type: 'pane.subscribe', id: 2, pane: pane.id }));
  await until(async () => Buffer.concat(ws.bins).toString('latin1').includes('hello from the pane'), 5000);
  check('a pane\'s bytes come through the hub from the daemon', Buffer.concat(ws.bins).toString('latin1').includes('hello from the pane'), JSON.stringify(ws.texts.slice(0, 3)).slice(0, 300));
  ws.send(JSON.stringify({ v: 1, type: 'checkpoint.answer', id: 3, checkpoint: 'cxxxxxxx', approve: true }));
  await until(async () => ws.closeCode !== null, 5000);
  check('a method the phone may not send (checkpoint.answer) closes the stream with 1008', ws.closeCode === 1008, String(ws.closeCode));
  const lo = await wsOpen(`/api/term?pane=${pane.id}`, null, { plain: true });
  if (lo.status === 101) lo.send(JSON.stringify({ v: 1, type: 'hello', id: 1, client: { name: 'phone-app-test', version: '0' } }));
  await until(async () => lo.texts.some((t) => t.type === 'result' && t.id === 1), 5000);
  check('on the board\'s own port, from this machine outside every pane (a dev server), the terminal stream opens too', lo.status === 101 && lo.texts.some((t) => t.type === 'result' && t.id === 1), lo.head.split('\r\n')[0]);
  const bad = await wsOpen('/api/term?pane=pzzzzzzz', TOKEN);
  check('a pane no daemon has: 404', /^HTTP\/1\.1 404/.test(bad.head));
  const noTokWs = await wsOpen(`/api/term?pane=${pane.id}`, null);
  check('the terminal stream without a token: 401', /^HTTP\/1\.1 401/.test(noTokWs.head));
}

// Rename on the Mac's card: the phone's own settings read the new name.
const rn = await mac('POST', '/api/phone/devices/rename', { id: DEV, name: '  Kitchen   phone ' });
const me2 = await phoneReq('GET', '/api/phone/me', { token: TOKEN });
check('the Mac renames the device, and the phone reads the new name', rn.status === 200 && rn.body.devices.some((d) => d.id === DEV && d.name === 'Kitchen phone') && me2.body.device.name === 'Kitchen phone', rn.text);
const rnEmpty = await mac('POST', '/api/phone/devices/rename', { id: DEV, name: '   ' });
const rnPhone = await phoneReq('POST', '/api/phone/devices/rename', { token: TOKEN, body: { id: DEV, name: 'Mine' } });
check('an empty name is refused, and a phone cannot rename', rnEmpty.status === 404 && rnPhone.status === 403);

// Revoke: its stream ends, its token is signed out.
const rv = await mac('POST', '/api/phone/devices/revoke', { id: DEV });
await until(async () => evEnded, 5000);
check('the Mac revokes the device: its event stream ends', rv.status === 200 && evEnded && !rv.body.devices.some((d) => d.id === DEV));
const after = await phoneReq('GET', '/api/phone/me', { token: TOKEN });
check('and its token gets 401 signedOut', after.status === 401 && after.body.signedOut === true);
const off = await mac('POST', '/api/phone/access', { on: false });
await sleep(300);
check('access off again: the phone port closes', off.body.access === false && !(await portOpen()));
stub.close();
if (dc) dc.close();

console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);

// ------------------------------------------------------------ a small WebSocket client over TLS
async function wsOpen(p, token, { plain = false } = {}) {
  return new Promise((resolve, reject) => {
    const s = plain ? net.connect(PORT, '127.0.0.1') : tls.connect({ host: '127.0.0.1', port: PPORT, rejectUnauthorized: false });
    const key = crypto.randomBytes(16).toString('base64');
    const out = { status: 0, head: '', texts: [], bins: [], closeCode: null, send: null };
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const read = frameReader((f) => {
      if (f.op === 1) { try { out.texts.push(JSON.parse(f.payload.toString('utf8'))); } catch { /* not JSON */ } } else if (f.op === 2) out.bins.push(f.payload);
      else if (f.op === 8) out.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
      return true;
    });
    out.send = (text) => {
      const pl = Buffer.from(text);
      const mask = crypto.randomBytes(4);
      const hdr = pl.length < 126 ? Buffer.from([0x81, 0x80 | pl.length]) : Buffer.from([0x81, 0x80 | 126, pl.length >> 8, pl.length & 255]);
      const m = Buffer.from(pl);
      for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
      s.write(Buffer.concat([hdr, mask, m]));
    };
    s.on(plain ? 'connect' : 'secureConnect', () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: ${plain ? `127.0.0.1:${PORT}` : `10.0.2.2:${PPORT}`}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: ravenry.v1\r\n${token ? `Authorization: Bearer ${token}\r\n` : ''}\r\n`);
    });
    s.on('data', (d) => {
      if (upgraded) return read(d);
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      out.head = buf.subarray(0, i).toString('latin1');
      out.status = Number(out.head.split(' ')[1]);
      upgraded = out.status === 101;
      const rest = buf.subarray(i + 4);
      resolve(out);
      if (upgraded && rest.length) read(rest);
    });
    s.on('error', reject);
    s.on('close', () => { if (!out.head) resolve(out); });
  });
}
