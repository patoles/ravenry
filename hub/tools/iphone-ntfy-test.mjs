#!/usr/bin/env node
// An iPhone through ntfy (docs/PHONE.md section 4, "An iPhone through
// ntfy"), proved against a local stand-in ntfy server on 127.0.0.1 that
// records every publish. Nothing ever goes to ntfy.sh or any real server.
//
// 1. In process: the device record (the same store as paired phones, no
//    sign-in), its own topic (never the channel's), Send a test and It
//    arrived; then ONE trigger (a checkpoint, a project moving into Needs
//    you) reaches the Android app (a fake UnifiedPush endpoint, decrypted
//    here), the iPhone and the ntfy channel once each; the exact JSON the
//    iPhone's topic gets (title as Android's, the fixed line, the board's
//    session link, priority 4) and never the question, the command or the
//    agent's words; a decision and a close are not sent; the line of every
//    kind; Remove forgets the topic. The model leaves room for the iPhone
//    app later: a target of a kind built later, with the ntfy one kept in
//    `push.was`, is sent through that kind's sender and never through ntfy.
// 2. A test board (RAVENRY_HOME under .tmp/iphone-ntfy-test, 127.0.0.1
//    only, a phone on the stand-in for the Wi-Fi, tools/as-phone.mjs): the
//    routes as the iPhone's Safari page and the Mac call them, who may call
//    which, the QR (the sign-in link + #iphone), the status's phones with
//    their transport and no topic anywhere a phone reads.
// 3. The #iphone page in headless WebKit at 390 px (iPhone width), dark and
//    light: the QR's link signs Safari in and lands on it, Copy the code
//    copies the topic, Send a test publishes, It arrived confirms. With
//    --shots DIR its pictures go there.
//
// Usage: node tools/iphone-ntfy-test.mjs [--shots DIR]
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, lanAddress, phoneEnv, phoneFetch, phoneProxy } from './as-phone.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'iphone-ntfy-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots') ? path.resolve(argv[argv.indexOf('--shots') + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (ok) passes++; else fails++; };
const b64u = (b) => Buffer.from(b).toString('base64url');

// ------------------------------------------------------------ the stand-in ntfy server

const reqs = [];
const server = http.createServer((req, res) => {
  let b = Buffer.alloc(0);
  req.on('data', (d) => { b = Buffer.concat([b, d]); });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(b.toString('utf8')); } catch { /* an encrypted body */ }
    reqs.push({ method: req.method, url: req.url, headers: req.headers, raw: b, body: b.toString('utf8'), json, at: Date.now() });
    if (req.url.startsWith('/up/')) { res.writeHead(201); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'standin', event: 'message', topic: json && json.topic }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${server.address().port}`;
const since = (n) => reqs.slice(n);
async function settle(n, count, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && reqs.length < n + count) await sleep(20);
  await sleep(150);
  return since(n);
}
const toTopic = (list, topic) => list.filter((r) => r.json && r.json.topic === topic);
const toUp = (list) => list.filter((r) => r.url.startsWith('/up/'));

// RFC 8291, the receiving side (as tools/phone-app-test.mjs): what the Android app reads.
function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const rec = body.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(auth, uaEcdh.computeSecret(asPub));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(rec.subarray(rec.length - 16));
  const out = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;
  return JSON.parse(out.subarray(0, end).toString('utf8'));
}

// ------------------------------------------------------------ 1. in process

const UNIT = path.join(T, 'unit');
fs.mkdirSync(UNIT, { recursive: true });
process.env.RAVENRY_HOME = UNIT;
process.env.RAVENRY_HUB_NAME = 'Test Mac';
process.env.MC_ALERT_PRIME_MS = '0';
process.env.MC_ALERT_RETRY_MS = '400';
process.env.MC_PUSH_RETRY_MS = '400';
process.env.MC_COPY_COMMAND = JSON.stringify(['/bin/sh', '-c', `cat > ${path.join(T, 'unit-copied.txt')}`]);
// A paired Android app with a UnifiedPush target on the stand-in.
const pixelKey = crypto.createECDH('prime256v1');
pixelKey.generateKeys();
const pixelAuth = crypto.randomBytes(16);
fs.writeFileSync(path.join(UNIT, 'phone.json'), JSON.stringify({ key: 'k'.repeat(48), access: true, away: false, tokens: [
  { hash: 'a'.repeat(64), id: 'dpixel8', name: 'Pixel 8', platform: 'android', app: '0.4.2', created: new Date().toISOString(), lastSeen: new Date().toISOString(),
    push: { kind: 'unifiedpush', endpoint: `${STUB}/up/pixel`, p256dh: b64u(pixelKey.getPublicKey()), auth: b64u(pixelAuth), at: new Date().toISOString() } },
] }), { mode: 0o600 });
const al = await import('../server/alerts.mjs');
const push = await import('../server/push.mjs');
const phone = await import('../server/phone.mjs');
const BU = 'http://192.168.1.50:4600/';
const SECRET = 'SECRET-WORDS-Q7';

// The ntfy channel on the stand-in too, with its own topic.
al.setNtfyServer(STUB);
al.newTopic();
al.choose('ntfy', true);
const chanTopic = JSON.parse(fs.readFileSync(path.join(UNIT, 'alerts.json'), 'utf8')).ntfy.topic;

let st = al.status();
check('before: the Pixel is the one phone, through the Ravenry app', JSON.stringify(st.phones) === '[{"name":"Pixel 8","transport":"app"}]' && JSON.stringify(st.apps) === '["Pixel 8"]', JSON.stringify(st.phones));

const s1 = al.iphoneStart('mac');
const s1b = al.iphoneStart('mac');
const rec0 = JSON.parse(fs.readFileSync(path.join(UNIT, 'phone.json'), 'utf8')).tokens.find((t) => t.id === s1.id);
check('Add an iPhone: a device record in the phones\' own store, with no sign-in', !!rec0 && rec0.name === 'iPhone' && rec0.platform === 'ios' && rec0.app === null && rec0.hash === null
  && rec0.push.kind === 'ntfy' && rec0.push.server === STUB && rec0.push.topic === s1.topic && rec0.push.confirmed === null, JSON.stringify(rec0));
check('its topic is its own: random, and not the channel\'s', /^ravenry-[a-z0-9]{20}$/.test(s1.topic) && s1.topic !== chanTopic && s1.mac === 'Test Mac');
check('asked again by the same caller: the same code, not a second one', s1b.id === s1.id && s1b.topic === s1.topic);
check('a code nobody confirmed is not a phone yet: not in the list, not in the sign-ins', al.status().phones.length === 1 && !phone.devices().some((d) => d.id === s1.id));
let n = reqs.length;
let r = await al.iphoneTest(s1.id, 'someone-else', BU);
check('another caller cannot test this code', !r.ok && r.status === 404 && since(n).length === 0);
r = await al.iphoneTest(s1.id, 'mac', BU);
let got = toTopic(await settle(n, 1), s1.topic);
check('Send a test: one publish on the iPhone\'s topic, exactly the ntfy JSON (title, line, the board, priority 3)', r.ok && got.length === 1 && got[0].method === 'POST' && got[0].url === '/'
  && JSON.stringify(got[0].json) === JSON.stringify({ topic: s1.topic, title: 'Ravenry test', message: 'Alerts from Test Mac will land here.', priority: 3, click: BU }), got[0] && got[0].body);
r = al.iphoneConfirm(s1.id, 'mac');
st = al.status();
check('It arrived: the iPhone joins the phones, "through ntfy", beside the Pixel', r.ok && JSON.stringify(st.phones) === '[{"name":"Pixel 8","transport":"app"},{"name":"iPhone","transport":"ntfy"}]' && JSON.stringify(st.apps) === '["Pixel 8"]', JSON.stringify(st.phones));
check('the status carries no topic', !JSON.stringify(st).includes(s1.topic));

// One trigger: a checkpoint (an approve, with a command and words that must stay on the Mac).
const cpProj = { id: 'paper-boat', name: 'paper-boat', sessions: [{ surfaceId: 'ravenry:pq1', sessionId: 'c0ffee00-0000-4000-8000-000000000001', assistant: 'claude' }] };
n = reqs.length;
al.checkpointAlert({ id: 'cpappr1', kind: 'approve', title: `${SECRET} ship it?`, command: `npm publish --otp ${SECRET}`, cwd: '/x/paper-boat', pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
let all = await settle(n, 3);
let ip = toTopic(all, s1.topic), ch = toTopic(all, chanTopic), up = toUp(all);
check('a checkpoint: the Pixel, the iPhone and the ntfy channel each get it once', ip.length === 1 && ch.length === 1 && up.length === 1 && all.length === 3, all.map((x) => x.url + ' ' + (x.json ? x.json.topic : 'encrypted')).join(', '));
check('the iPhone\'s: the title as Android\'s, the fixed line, the session\'s link, priority 4', ip[0] && JSON.stringify(ip[0].json) === JSON.stringify({ topic: s1.topic, title: 'paper-boat wants to run a command', message: 'On Test Mac. Run or refuse on the board.', priority: 4, click: `${BU}#paper-boat/c0ffee00-0000-4000-8000-000000000001` }), ip[0] && ip[0].body);
const pix = up[0] ? decrypt(up[0].raw, pixelKey, pixelAuth) : null;
check('the Pixel\'s: the same message, encrypted, with the command and its buttons', pix && pix.title === 'paper-boat wants to run a command' && pix.body.includes(SECRET) && pix.line === 'On Test Mac. Run or refuse on the board.' && pix.actions.map((a) => a.id).join() === 'run,refuse,open', pix && JSON.stringify(pix).slice(0, 200));
check('no clear publish carries the question, the command or the agent\'s words', ![...ip, ...ch].some((x) => x.body.includes(SECRET)));

// One trigger: a project moving into Needs you (a question).
const proj = (state, extra = {}) => ({ id: 'boat', name: 'boat', state, primary: 'sf-boat', question: `${SECRET} 10 or 30 minutes?`, sessions: [{ surfaceId: 'sf-boat', sessionId: 'c0ffee00-0000-4000-8000-0000000000b0', state: state === 'you' ? 'asked' : 'working', since: '2026-11-14T10:00:00Z', words: { headline: `${SECRET} headline` }, assistant: 'claude' }], ...extra });
al.observe([proj('work')], { now: Date.now(), boardUrl: BU });
n = reqs.length;
al.observe([proj('you')], { now: Date.now() + 1000, boardUrl: BU });
all = await settle(n, 3);
ip = toTopic(all, s1.topic); ch = toTopic(all, chanTopic); up = toUp(all);
check('a question: one trigger, the Pixel, the iPhone and the channel once each', ip.length === 1 && ch.length === 1 && up.length === 1, `${ip.length} ${ch.length} ${up.length}`);
check('the iPhone\'s: "boat needs you", "Asked you a question", the session\'s link, priority 4', ip[0] && JSON.stringify(ip[0].json) === JSON.stringify({ topic: s1.topic, title: 'boat needs you', message: 'Asked you a question', priority: 4, click: `${BU}#boat/c0ffee00-0000-4000-8000-0000000000b0` }), ip[0] && ip[0].body);
check('the Pixel still gets the question itself', up[0] && decrypt(up[0].raw, pixelKey, pixelAuth).body.includes(SECRET));
check('and no clear publish carries it', ![...ip, ...ch].some((x) => x.body.includes(SECRET)));
n = reqs.length;
al.observe([proj('work')], { now: Date.now() + 2000, boardUrl: BU });
al.observe([proj('you')], { now: Date.now() + 3000, boardUrl: BU });
all = await settle(n, 1, 800);
const ups = toUp(all).map((x) => decrypt(x.raw, pixelKey, pixelAuth));
check('the same moment again (a blip): no second alert to any of them (one dedupe; the Pixel only hears its close)', toTopic(all, s1.topic).length === 0 && toTopic(all, chanTopic).length === 0 && ups.every((m) => m.type === 'close'), JSON.stringify(ups.map((m) => m.type)));
n = reqs.length;
push.fromDecision({ id: 'dec1', at: new Date().toISOString(), quote: `${SECRET} decided`, recorded_by: { assistant: 'claude' } }, {});
all = await settle(n, 1, 800);
check('a saved decision: the Pixel only (its only use is Undo), never the iPhone', toUp(all).length === 1 && toTopic(all, s1.topic).length === 0, String(all.length));
n = reqs.length;
push.syncCheckpoints([]);
all = await settle(n, 1, 800);
check('a close: the Pixel only (ntfy cannot take a notification back on iOS)', toUp(all).length >= 1 && toTopic(all, s1.topic).length === 0, String(all.length));

// The line of every kind (the table in docs/PHONE.md section 5).
{
  const P = { id: 'paper-boat', name: 'paper-boat', primary: 's1', state: 'you', question: SECRET, headline: SECRET, planGate: { short: 'show me a picture?', question: `${SECRET} long` }, sessions: [{ surfaceId: 's1', since: 't', assistant: 'claude' }] };
  const lines = Object.fromEntries(['handback', 'question', 'permission', 'gate'].map((k) => [k, push.projectMessage({ kind: k }, k === 'gate' ? P : { ...P, planGate: null })]));
  const cps = Object.fromEntries(['ask', 'approve', 'secret', 'pick', 'drive'].map((k) => [k, push.checkpointMessage({ id: `c${k}`, kind: k, title: `${SECRET} title`, command: `${SECRET} cmd`, options: ['a'], pane: 'pq1', assistant: 'claude', drive: { pane: 'pz' } }, { project: cpProj, machine: null })]));
  const want = { handback: ['paper-boat needs you', 'Handed back'], question: ['paper-boat needs you', 'Asked you a question'], permission: ['paper-boat needs you', 'Waiting for permission'], gate: ['paper-boat: plan gate', 'Plan gate'] };
  const cwant = { ask: ['paper-boat asks', 'Answer on the board.'], approve: ['paper-boat wants to run a command', 'On Test Mac. Run or refuse on the board.'], secret: ['Claude needs a secret for paper-boat', 'Type it on the Mac.'], pick: ['paper-boat wants you to pick', 'Answer on the board.'], drive: ['Claude wants to use another tab', 'Answer on the board.'] };
  const bad = [...Object.entries(want).filter(([k, [t, l]]) => lines[k].title !== t || lines[k].line !== l), ...Object.entries(cwant).filter(([k, [t, l]]) => cps[k].title !== t || cps[k].line !== l)];
  check('each kind\'s title (as Android\'s) and line (fixed words) as the table says', bad.length === 0, JSON.stringify(bad.map(([k]) => [k, (lines[k] || cps[k]).title, (lines[k] || cps[k]).line])));
  check('a drive with no tab known: fixed words, never the agent\'s own title', !cps.drive.title.includes(SECRET));
  check('what a clear transport may carry: an alert with its line and a test; never a decision or a close',
    push.clearOk(lines.question) && push.clearOk(push.testMessage()) && !push.clearOk(push.decisionMessage({ id: 'x', at: new Date().toISOString(), quote: 'q', recorded_by: {} })) && !push.clearOk({ v: 1, type: 'close', id: 'cp:x' }));
}

// Send a test from the phones list: one phone only.
n = reqs.length;
r = await al.phoneTest(s1.id, BU);
all = await settle(n, 1, 800);
check('a phone\'s own Send a test: that iPhone only', r.ok && all.length === 1 && toTopic(all, s1.topic).length === 1, String(all.length));
n = reqs.length;
r = await al.phoneTest('dpixel8', BU);
all = await settle(n, 1, 800);
check('the Pixel\'s Send a test: the Pixel only', r.ok && all.length === 1 && toUp(all).length === 1, String(all.length));
const lastIp = push.phones().find((p) => p.id === s1.id).last;
check('each phone keeps its last send for its line', lastIp && lastIp.ok === true && !!lastIp.at, JSON.stringify(lastIp));

// Remove: the record and its topic are forgotten; it gets nothing after.
r = al.iphoneRemove('dpixel8');
check('Remove is for an iPhone through ntfy, never a paired app', !r.ok && r.status === 404);
r = al.iphoneRemove(s1.id);
check('Remove: gone from the phones and from phone.json, its topic with it', r.ok && JSON.stringify(al.status().phones) === '[{"name":"Pixel 8","transport":"app"}]' && !fs.readFileSync(path.join(UNIT, 'phone.json'), 'utf8').includes(s1.topic));
n = reqs.length;
al.checkpointAlert({ id: 'cpask2', kind: 'ask', title: 'q?', pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
all = await settle(n, 2);
check('after Remove an alert never reaches the old topic', toTopic(all, s1.topic).length === 0 && toUp(all).length === 1, String(all.length));
const keyBefore = JSON.parse(fs.readFileSync(path.join(UNIT, 'phone.json'), 'utf8')).key;
const s2 = al.iphoneStart('mac');
al.iphoneConfirm(s2.id, 'mac');
phone.rotate();
const afterKey = JSON.parse(fs.readFileSync(path.join(UNIT, 'phone.json'), 'utf8'));
check('New key signs every phone out and keeps an iPhone through ntfy (it holds no key)', afterKey.key !== keyBefore && afterKey.tokens.length === 1 && afterKey.tokens[0].id === s2.id && al.status().phones.length === 1, JSON.stringify(afterKey.tokens.map((t) => t.id)));

// Room for the Ravenry iPhone app later: a target of a kind built later on
// the same record (the takeover), the ntfy target kept in `push.was`.
{
  const sent = [];
  push.SENDERS.relaylater = { transport: 'app', clear: false, send: async (dev, msg) => { sent.push({ id: dev.id, msg }); return { ok: true }; } };
  phone.updateRecord(s2.id, (t) => { t.hash = 'c'.repeat(64); t.app = '1.0.0'; t.push = { kind: 'relaylater', relay: 'https://relay.example', token: 'tok', was: { ...t.push } }; });
  const stored = JSON.parse(fs.readFileSync(path.join(UNIT, 'phone.json'), 'utf8')).tokens.find((t) => t.id === s2.id);
  n = reqs.length;
  al.checkpointAlert({ id: 'cpask3', kind: 'ask', title: `${SECRET}?`, pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
  all = await settle(n, 1, 800);
  check('a future kind: the same record, the old ntfy target kept in push.was', stored.name === 'iPhone' && stored.platform === 'ios' && stored.push.kind === 'relaylater' && stored.push.was.kind === 'ntfy' && stored.push.was.topic === s2.topic);
  check('it is sent through its own sender, once, the whole message; never through ntfy', sent.length === 1 && sent[0].id === s2.id && sent[0].msg.title === 'paper-boat asks' && sent[0].msg.body.includes(SECRET) && toTopic(all, s2.topic).length === 0, `${sent.length} ${toTopic(all, s2.topic).length}`);
  check('the phones list says "Ravenry app" for it: same row, the transport changed', JSON.stringify(al.status().phones) === '[{"name":"iPhone","transport":"app"}]', JSON.stringify(al.status().phones));
  delete push.SENDERS.relaylater;
  let threw = null;
  try { push.send(push.testMessage()); await sleep(100); } catch (e) { threw = e; }
  check('a kind with no sender here (an older hub than the record): skipped, nothing thrown, nothing sent', !threw && push.ready());
}
push._reset();

// ------------------------------------------------------------ 2. a test board

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false }, projects: [] }, null, 2));
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces: [], screens: {} }));
const COPY_LOG = path.join(T, 'copied.txt');
const LAN = lanAddress();
const STANDIN = await freePort();
const PB = LAN ? `http://${LAN}:${PORT}` : null;
const env = {
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_PHONE_PORT: String(await freePort()), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: path.join(T, 'claude-projects'),
  MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  MC_ALERT_BOARD_URL: `http://192.168.1.50:${PORT}/`, RAVENRY_HUB_NAME: 'Test Mac',
  MC_COPY_COMMAND: JSON.stringify(['/bin/sh', '-c', `cat > ${COPY_LOG}`]),
  ...phoneEnv(STANDIN),
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withTestHome(env), stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
const H = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
const api = async (p, body, base = BASE, extra = {}) => {
  const res = await (base === PB ? (u, i) => phoneFetch(STANDIN, u, i) : fetch)(base + p, body === undefined ? { headers: extra } : { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(body) });
  let j = null;
  try { j = await res.json(); } catch { /* none */ }
  return { status: res.status, j };
};
let browser = null;
try {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(BASE + '/api/state')).status === 200) break; } catch { /* starting */ } await sleep(100); }
  let x = await api('/api/alerts/ntfy', { server: STUB });
  check('board: the Mac sets the ntfy server (the stand-in)', x.status === 200);
  x = await api('/api/alerts/setup');
  check('board: phone access off, the QR is withheld and the setup says so', x.status === 200 && x.j.iphone && x.j.iphone.access === false && x.j.iphone.qr === null && x.j.iphone.server === STUB && x.j.iphone.pending === null, JSON.stringify(x.j.iphone));
  x = await api('/api/phone/access', { on: true });
  x = await api('/api/alerts/setup');
  const KEY = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).key;
  if (!LAN) check('board: this Mac has a private Wi-Fi address for the QR and the phone\'s Host', false);
  else {
    check('board: phone access on, the QR is there', x.j.iphone.access === true && /^<svg class="qr-svg"/.test(x.j.iphone.qr || ''));
    // The QR decodes to the board's sign-in link and #iphone.
    const { chromium, webkit } = await import('playwright');
    const jsQR = (await import('jsqr')).default;
    browser = await chromium.launch({ headless: true });
    const qp = await browser.newPage({ viewport: { width: 300, height: 300 } });
    await qp.setContent(`<body style="margin:0;background:#fff;padding:20px">${x.j.iphone.qr.replace('width="156" height="156"', 'width="240" height="240"')}</body>`);
    const png = await qp.screenshot({ clip: { x: 0, y: 0, width: 280, height: 280 } });
    const img = await qp.evaluate(async (b) => { const im = new Image(); im.src = 'data:image/png;base64,' + b; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return { w: im.width, h: im.height, d: Array.from(g.getImageData(0, 0, im.width, im.height).data) }; }, png.toString('base64'));
    const code = jsQR(Uint8ClampedArray.from(img.d), img.w, img.h);
    const QR = `${PB}/?k=${KEY}#iphone`;
    check('board: the QR is the board\'s Safari sign-in link + #iphone', code && code.data === QR, code ? code.data.replace(KEY, '<key>') : 'no QR found');
    await qp.close();

    // A phone browser, signed in by that link.
    const si = await phoneFetch(STANDIN, `${PB}/?k=${encodeURIComponent(KEY)}`);
    const cookie = (si.headers.get('set-cookie') || '').split(/,(?=\s*mc_)/).map((c) => c.split(';')[0].trim()).filter((c) => c.startsWith('mc_phone=')).join('; ');
    const PH = { Cookie: cookie, Origin: PB };
    x = await api('/api/alerts/iphone/start', {}, PB, PH);
    const a1 = x.j;
    check('board: the iPhone\'s page gets its own code', x.status === 200 && /^ravenry-[a-z0-9]{20}$/.test(a1.topic) && a1.server === STUB && a1.mac === 'Test Mac', JSON.stringify({ ...a1, topic: '<topic>' }));
    for (const [p, b] of [['/api/alerts/iphone/copy', {}], ['/api/alerts/iphone/remove', { id: a1.id }], ['/api/alerts/phone/test', { id: a1.id }]]) {
      x = await api(p, b, PB, PH);
      check(`board: a phone may not POST ${p} (the Mac's)`, x.status === 403, String(x.status));
    }
    x = await api('/api/alerts/setup', undefined, PB, PH);
    check('board: a phone still may not read the setup', x.status === 403);
    n = reqs.length;
    x = await api('/api/alerts/iphone/test', { id: a1.id }, PB, PH);
    got = toTopic(await settle(n, 1), a1.topic);
    check('board: Send a test from the iPhone\'s page publishes on its topic, with the board\'s link', x.status === 200 && got.length === 1 && JSON.stringify(got[0].json) === JSON.stringify({ topic: a1.topic, title: 'Ravenry test', message: 'Alerts from Test Mac will land here.', priority: 3, click: `http://192.168.1.50:${PORT}/` }), got[0] && got[0].body);
    x = await api('/api/alerts/iphone/confirm', { id: a1.id }, PB, PH);
    const sx = await api('/api/alerts', undefined, PB, PH);
    check('board: It arrived; the status (as a phone reads it) lists it "ntfy", no topic', x.status === 200 && JSON.stringify(sx.j.phones) === '[{"name":"iPhone","transport":"ntfy"}]' && !JSON.stringify(sx.j).includes(a1.topic), JSON.stringify(sx.j.phones));
    const setup = (await api('/api/alerts/setup')).j;
    const row = setup.phones.find((p) => p.id === a1.id);
    check('board: the Mac\'s setup has the row with its id, transport and last send', row && row.transport === 'ntfy' && row.platform === 'ios' && row.last && row.last.ok === true && !JSON.stringify(setup.phones).includes(a1.topic), JSON.stringify(row));
    let snap = null;
    for (let i = 0; i < 60; i++) { snap = await (await fetch(BASE + '/api/state')).json(); if (snap.alerts && snap.alerts.phones && snap.alerts.phones.length) break; await sleep(100); }
    check('board: the snapshot\'s alerts list it, no topic anywhere in the snapshot', JSON.stringify(snap.alerts.phones) === '[{"name":"iPhone","transport":"ntfy"}]' && !JSON.stringify(snap).includes(a1.topic));
    const devs = (await api('/api/phone/devices')).j.devices;
    check('board: the phone card\'s sign-ins do not list it (no sign-in)', !devs.some((d) => d.id === a1.id) && devs.some((d) => d.platform === 'browser'), JSON.stringify(devs.map((d) => d.name)));
    n = reqs.length;
    x = await api('/api/alerts/phone/test', { id: a1.id });
    got = toTopic(await settle(n, 1), a1.topic);
    check('board: the Mac\'s Send a test on the iPhone row publishes once', x.status === 200 && got.length === 1);
    x = await api('/api/alerts/iphone/copy', {});
    const macCode = fs.readFileSync(COPY_LOG, 'utf8');
    const pend = (await api('/api/alerts/setup')).j.iphone.pending;
    check('board: Copy the code instead puts a code of its own on the Mac\'s clipboard, never in the answer', x.status === 200 && /^ravenry-[a-z0-9]{20}$/.test(macCode) && macCode !== a1.topic && !JSON.stringify(x.j).includes(macCode) && pend && pend.id === x.j.id);
    x = await api('/api/alerts/iphone/remove', { id: a1.id });
    check('board: Remove from the Mac forgets it and its topic', x.status === 200 && (await api('/api/alerts')).j.phones.length === 0 && !fs.readFileSync(path.join(MC, 'phone.json'), 'utf8').includes(a1.topic));
    check('board: no topic in the board\'s log', !log.includes(a1.topic) && !log.includes(macCode));

    // ------------------------------------------------------------ 3. the #iphone page
    await browser.close();
    browser = await webkit.launch({ headless: true });
    const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const ctx = await browser.newContext({ proxy: phoneProxy(STANDIN), viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA });
    const pg = await ctx.newPage();
    await pg.goto(QR);
    await pg.waitForSelector('#iph .iph-step', { timeout: 10000 });
    check('page: the QR\'s link signs Safari in and lands on Alerts on this iPhone (#iphone kept, key gone)', pg.url() === `${PB}/#iphone` && (await pg.textContent('#iph h2')) === 'Alerts on this iPhone', pg.url().replace(KEY, '<key>'));
    const text = await pg.$eval('#iph', (el) => el.innerText);
    check('page: from the Mac by its name, the three steps as drawn', /From Test Mac, through the ntfy app\./.test(text) && /1 · Get ntfy/i.test(text) && /2 · Subscribe/i.test(text) && /3 · Check/i.test(text) && /In ntfy: \+, paste, Subscribe\./.test(text), text.replace(/\n/g, ' | '));
    const store = await pg.$eval('#iph a.btn', (a) => a.href);
    check('page: Get ntfy is ntfy\'s App Store page', store === 'https://apps.apple.com/app/ntfy/id1625396347', store);
    const pageCode = await pg.$eval('#iph-code', (el) => el.value);
    check('page: a code for this iPhone (a new one: the last was confirmed and removed)', /^ravenry-[a-z0-9]{20}$/.test(pageCode) && pageCode !== a1.topic && pageCode !== macCode);
    const wide = await pg.evaluate(() => document.documentElement.scrollWidth);
    check('page: nothing wider than the iPhone (390 px)', wide <= 390, String(wide));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'iphone-page-dark.png') });
    // Copy the code: the page is http on the Wi-Fi address (not a secure
    // page, no clipboard API), so it selects the field and copies.
    await pg.evaluate(() => { window.__copied = null; document.addEventListener('copy', () => { const f = document.activeElement; window.__copied = f && 'value' in f ? f.value.slice(f.selectionStart, f.selectionEnd) : String(getSelection()); }); });
    await pg.tap('[data-iph="copy"]');
    await pg.waitForFunction(() => document.querySelector('[data-iph="copy"]') && document.querySelector('[data-iph="copy"]').textContent === 'Copied', null, { timeout: 3000 }).catch(() => {});
    const copied = await pg.evaluate(() => window.__copied);
    const secure = await pg.evaluate(() => window.isSecureContext);
    check('page: Copy the code copies the topic (WebKit, not a secure page: the field selected and copied)', copied === pageCode && !secure && (await pg.textContent('[data-iph="copy"]')) === 'Copied', JSON.stringify({ copied: copied && copied.slice(0, 12), secure }));
    n = reqs.length;
    await pg.tap('[data-iph="test"]');
    await pg.waitForSelector('#iph .iph-res.ok', { timeout: 5000 }).catch(() => {});
    got = toTopic(await settle(n, 1), pageCode);
    check('page: Send a test publishes on this iPhone\'s topic and says so', got.length === 1 && /Sent/.test(await pg.textContent('#iph .iph-res')), String(got.length));
    // Light: the same page and code, again from the board's address.
    const lp = await ctx.newPage();
    await lp.goto(`${PB}/?theme=light#iphone`);
    await lp.waitForSelector('#iph .iph-step');
    check('page: opened again, the same code (one waiting per iPhone)', (await lp.$eval('#iph-code', (el) => el.value)) === pageCode);
    const bg = await lp.$eval('#iph', (el) => getComputedStyle(el).backgroundColor);
    check('page: light follows the board\'s theme', bg === 'rgb(241, 240, 237)', bg);
    if (SHOTS) await lp.screenshot({ path: path.join(SHOTS, 'iphone-page-light.png') });
    await pg.tap('[data-iph="arrived"]');
    await pg.waitForSelector('[data-iph="board"]', { timeout: 5000 }).catch(() => {});
    const done = await pg.$eval('#iph', (el) => el.innerText);
    const ph = (await api('/api/alerts')).j.phones;
    check('page: It arrived confirms: done on the page, the iPhone in the phones list', /Done\. This iPhone gets alerts from Test Mac\./.test(done) && JSON.stringify(ph) === '[{"name":"iPhone","transport":"ntfy"}]', JSON.stringify(ph));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'iphone-page-dark-done.png') });
    await lp.tap('[data-iph="arrived"]');
    await lp.waitForSelector('[data-iph="board"]', { timeout: 5000 }).catch(() => {});
    check('page: It arrived twice is the same iPhone, not a second one', (await api('/api/alerts')).j.phones.length === 1);
    if (SHOTS) await lp.screenshot({ path: path.join(SHOTS, 'iphone-page-light-done.png') });
    await pg.tap('[data-iph="board"]');
    await pg.waitForTimeout(300);
    check('page: Open the board closes it and leaves #iphone', !(await pg.$('#iph')) && !pg.url().includes('#iphone'), pg.url());
    await ctx.close();
    // The board's Settings on the Mac: the phones line names the iPhone with its transport.
    const mctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const mp = await mctx.newPage();
    await mp.goto(`${BASE}/`);
    await mp.waitForSelector('#gear');
    await mp.click('#gear');
    await mp.waitForSelector('#pa-apps-row:not([hidden])', { timeout: 5000 }).catch(() => {});
    const line = await mp.textContent('#pa-apps').catch(() => '');
    const onL = await mp.textContent('#pa-on-l').catch(() => '');
    check('board Settings: the phones line says how each gets alerts, the channels as "Also"', line === 'iPhone gets alerts through ntfy.' && onL.startsWith('Also send alerts to'), JSON.stringify([line, onL]));
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, 'board-settings-phones.png') });
    await mctx.close();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  board.kill();
  server.close();
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
