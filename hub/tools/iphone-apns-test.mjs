#!/usr/bin/env node
// The iPhone and iPad app's alerts through APNs (docs/PHONE.md section 4,
// "apns"), end to end on this Mac: the hub's sender, the real relay
// (relay/src/relay.js, served here on 127.0.0.1) and a stand-in APNs that
// opens each sealed alert with the device's own key, as the app's
// Notification Service Extension will. A stand-in ntfy records every
// publish. Nothing goes to Apple, ntfy.sh or any real server.
//
// What it proves:
// - the target: relay, token, keys and environment are checked; a relay
//   from RAVENRY_APNS_RELAY when the app names none;
// - the takeover: an iPhone through ntfy that sets an apns target keeps the
//   ntfy one in push.was, its old topic gets one last fixed line, and its
//   row says "Ravenry app" with when it moved;
// - one trigger reaches each phone once: the iPhone app through APNs (the
//   whole message, sealed, with its buttons, never through its old ntfy
//   topic), an Android app through UnifiedPush, an iPhone that still uses
//   ntfy through ntfy in clear (title and line only, as before);
// - APNs sees the fixed placeholder and ciphertext only; a close goes as a
//   silent background push; the biggest message fits APNs' 4 KB; a debug
//   build's sandbox target goes to sandbox;
// - 410 from APNs (through the relay) drops the target, the row says Apple
//   says the app is gone, no alert goes anywhere by itself, and Use ntfy
//   again brings the old topic back; a refused token is not retried; an
//   APNs outage is tried once more.
//
// Usage: node tools/iphone-apns-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'iphone-apns-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (ok) passes++; else fails++; };
const b64u = (b) => Buffer.from(b).toString('base64url');

// RFC 8291, the receiving side: what the app's extension does.
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

// ------------------------------------------------------------ stand-ins: APNs, ntfy, and the real relay

// The devices' keys, made on the "phones".
const ipKey = crypto.createECDH('prime256v1'); ipKey.generateKeys();
const ipAuth = crypto.randomBytes(16);
const ipToken = crypto.randomBytes(32).toString('hex');
const pixelKey = crypto.createECDH('prime256v1'); pixelKey.generateKeys();
const pixelAuth = crypto.randomBytes(16);

const apnsReqs = [];
let apnsAnswer = () => [200, ''];
const apns = http.createServer((req, res) => {
  const ch = [];
  req.on('data', (d) => ch.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(ch);
    let json = null;
    try { json = JSON.parse(raw.toString('utf8')); } catch { /* none */ }
    let msg = null;
    try { msg = json && json.e ? decrypt(Buffer.from(json.e, 'base64url'), ipKey, ipAuth) : null; } catch { msg = 'undecryptable'; }
    apnsReqs.push({ url: req.url, headers: req.headers, raw, json, msg, at: Date.now() });
    const [st, b] = apnsAnswer(req);
    res.writeHead(st, { 'Content-Type': 'application/json' });
    res.end(b);
  });
});
await new Promise((r) => apns.listen(0, '127.0.0.1', r));

const { handler } = await import('../../relay/src/relay.js');
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const RELAY_ENV = { APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), APNS_KEY_ID: 'TESTKEYID1', APNS_TEAM_ID: 'TESTTEAM01', APNS_TOPIC: 'dev.ravenry.ios', APNS_ORIGIN: `http://127.0.0.1:${apns.address().port}` };
const relayReqs = [];
let relayDown = false;
const relay = http.createServer((req, res) => {
  const ch = [];
  req.on('data', (d) => ch.push(d));
  req.on('end', async () => {
    const raw = Buffer.concat(ch);
    try { relayReqs.push(JSON.parse(raw.toString('utf8'))); } catch { relayReqs.push(null); }
    if (relayDown) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"APNs answered 503."}'); }
    const r = await handler.fetch(new Request(`http://relay.test${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? raw : undefined }), RELAY_ENV);
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${relay.address().port}`;

const ntfyReqs = [];
const ntfy = http.createServer((req, res) => {
  const ch = [];
  req.on('data', (d) => ch.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(ch);
    let json = null;
    try { json = JSON.parse(raw.toString('utf8')); } catch { /* encrypted */ }
    ntfyReqs.push({ url: req.url, raw, json, body: raw.toString('utf8') });
    if (req.url.startsWith('/up/')) { res.writeHead(201); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
const NTFY = `http://127.0.0.1:${ntfy.address().port}`;

const counts = () => [apnsReqs.length, ntfyReqs.length, relayReqs.length];
async function settle(want, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !want()) await sleep(20);
  await sleep(150);
}
const toTopic = (list, topic) => list.filter((r) => r.json && r.json.topic === topic);
const toUp = (list) => list.filter((r) => r.url.startsWith('/up/'));

// ------------------------------------------------------------ the hub, in process

const UNIT = path.join(T, 'unit');
fs.mkdirSync(UNIT, { recursive: true });
process.env.RAVENRY_HOME = UNIT;
process.env.RAVENRY_HUB_NAME = 'Test Mac';
process.env.MC_ALERT_PRIME_MS = '0';
process.env.MC_PUSH_RETRY_MS = '400';
const now = new Date().toISOString();
const IP_TOPIC = 'ravenry-iphoneoldtopic0001';
const IP2_TOPIC = 'ravenry-iphonetwontfy00002';
fs.writeFileSync(path.join(UNIT, 'phone.json'), JSON.stringify({ key: 'k'.repeat(48), access: true, away: false, tokens: [
  // An Android app through UnifiedPush.
  { hash: 'a'.repeat(64), id: 'dpixel8', name: 'Pixel 8', platform: 'android', app: '0.4.2', created: now, lastSeen: now,
    push: { kind: 'unifiedpush', endpoint: `${NTFY}/up/pixel`, p256dh: b64u(pixelKey.getPublicKey()), auth: b64u(pixelAuth), at: now } },
  // The iPhone app, just took over an iPhone through ntfy: signed in, still on its ntfy target.
  { hash: 'b'.repeat(64), id: 'diphone1', name: 'iPhone', platform: 'ios', app: '0.1.71', created: now, lastSeen: now, tookOver: now,
    push: { kind: 'ntfy', server: NTFY, topic: IP_TOPIC, confirmed: now } },
  // Another iPhone, through ntfy only (no app).
  { hash: null, id: 'diphone2', name: 'iPhone 2', platform: 'ios', app: null, created: now, lastSeen: null,
    push: { kind: 'ntfy', server: NTFY, topic: IP2_TOPIC, confirmed: now } },
] }), { mode: 0o600 });
const al = await import('../server/alerts.mjs');
const push = await import('../server/push.mjs');
const phone = await import('../server/phone.mjs');
const BU = 'http://192.168.1.50:4600/';
const SECRET = 'SECRET-WORDS-Q7';
const rec = (id) => JSON.parse(fs.readFileSync(path.join(UNIT, 'phone.json'), 'utf8')).tokens.find((t) => t.id === id);

// ------------------------------------------------------------ the target

{
  const k = { p256dh: b64u(ipKey.getPublicKey()), auth: b64u(ipAuth) };
  const ok = push.checkTarget({ kind: 'apns', relay: `${RELAY}/`, token: ipToken.toUpperCase(), environment: 'sandbox', ...k });
  check('an apns target: relay (no trailing slash), token (lower case), environment, keys', ok.ok && ok.target.relay === RELAY && ok.target.token === ipToken && ok.target.environment === 'sandbox' && ok.target.p256dh === k.p256dh, JSON.stringify(ok));
  const bad = [
    ['no relay and none set on this Mac', { kind: 'apns', token: ipToken, ...k }, /relay/i],
    ['a relay over http to a host name', { kind: 'apns', relay: 'http://relay.example', token: ipToken, ...k }, /https/],
    ['a relay with a query', { kind: 'apns', relay: 'https://relay.example/?x=1', token: ipToken, ...k }, /query/],
    ['a token that is not hex', { kind: 'apns', relay: RELAY, token: 'not-a-token', ...k }, /token/],
    ['an environment other than production or sandbox', { kind: 'apns', relay: RELAY, token: ipToken, environment: 'dev', ...k }, /environment/],
    ['no keys', { kind: 'apns', relay: RELAY, token: ipToken }, /p256dh/],
  ];
  for (const [name, b, re] of bad) { const r = push.checkTarget(b); check(`refused: ${name}`, !r.ok && r.status === 400 && re.test(r.error), r.error); }
  process.env.RAVENRY_APNS_RELAY = 'https://relay.example.org/';
  const def = push.checkTarget({ kind: 'apns', token: ipToken, ...k });
  check('no relay from the app: RAVENRY_APNS_RELAY on this Mac', def.ok && def.target.relay === 'https://relay.example.org' && def.target.environment === 'production');
  const app = push.checkTarget({ kind: 'apns', relay: RELAY, token: ipToken, ...k });
  check('the app\'s own relay wins over it (its build knows which relay holds its key)', app.ok && app.target.relay === RELAY);
  delete process.env.RAVENRY_APNS_RELAY;
}

// ------------------------------------------------------------ the takeover

let [na, nn] = counts();
const t1 = push.checkTarget({ kind: 'apns', relay: RELAY, token: ipToken, environment: 'production', p256dh: b64u(ipKey.getPublicKey()), auth: b64u(ipAuth) });
const set = await push.setTarget('diphone1', t1.target);
await settle(() => ntfyReqs.length > nn);
let r1 = rec('diphone1');
check('the takeover: push is the apns target, the ntfy one kept in push.was, with when it moved', set.ok && set.moved && r1.push.kind === 'apns' && r1.push.was.kind === 'ntfy' && r1.push.was.topic === IP_TOPIC && r1.push.moved === r1.push.at, JSON.stringify(r1.push));
let last = toTopic(ntfyReqs.slice(nn), IP_TOPIC);
check('its old ntfy topic gets one last line, in fixed words', last.length === 1 && last[0].json.message === push.MOVED_LINE && last[0].json.message === 'Alerts for this iPhone now come from the Ravenry app. You can delete ntfy.', last[0] && last[0].body);
check('nothing went to APNs for it', apnsReqs.length === na);
let row = push.phones().find((p) => p.id === 'diphone1');
check('its row: same name, "Ravenry app", moved from ntfy at that time', row.name === 'iPhone' && row.transport === 'app' && row.moved === r1.push.moved && row.gone === null, JSON.stringify(row));
check('the board\'s line: the Pixel and the iPhone through the app, iPhone 2 through ntfy', JSON.stringify(al.status().phones) === '[{"name":"Pixel 8","transport":"app"},{"name":"iPhone","transport":"app"},{"name":"iPhone 2","transport":"ntfy"}]', JSON.stringify(al.status().phones));
{
  // A new token for the same app (iOS gives one now and then): still moved, still remembers ntfy, no second line.
  [na, nn] = counts();
  const t2 = push.checkTarget({ kind: 'apns', relay: RELAY, token: ipToken, p256dh: b64u(ipKey.getPublicKey()), auth: b64u(ipAuth) });
  const again = await push.setTarget('diphone1', t2.target);
  await sleep(200);
  r1 = rec('diphone1');
  check('the app sets its target again: push.was and moved kept, no second ntfy line', !again.moved && r1.push.was && r1.push.was.topic === IP_TOPIC && !!r1.push.moved && ntfyReqs.length === nn);
}

// ------------------------------------------------------------ one trigger, each phone once

const cpProj = { id: 'paper-boat', name: 'paper-boat', sessions: [{ surfaceId: 'ravenry:pq1', sessionId: 'c0ffee00-0000-4000-8000-000000000001', assistant: 'claude' }] };
[na, nn] = counts();
al.checkpointAlert({ id: 'cpappr1', kind: 'approve', title: `${SECRET} ship it?`, command: `npm publish --otp ${SECRET}`, cwd: '/x/paper-boat', pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
await settle(() => apnsReqs.length > na && ntfyReqs.length >= nn + 2);
let ap = apnsReqs.slice(na), nt = ntfyReqs.slice(nn);
check('a checkpoint: the iPhone app once through APNs, the Pixel once, iPhone 2 once through ntfy; the old topic nothing',
  ap.length === 1 && toUp(nt).length === 1 && toTopic(nt, IP2_TOPIC).length === 1 && toTopic(nt, IP_TOPIC).length === 0, `${ap.length} ${toUp(nt).length} ${toTopic(nt, IP2_TOPIC).length} ${toTopic(nt, IP_TOPIC).length}`);
const a1 = ap[0] || { headers: {}, json: {}, msg: null };
check('APNs gets the device\'s token, an alert with priority 10, the app\'s topic, a collapse id that says nothing',
  a1.url === `/3/device/${ipToken}` && a1.headers['apns-push-type'] === 'alert' && a1.headers['apns-priority'] === '10' && a1.headers['apns-topic'] === 'dev.ravenry.ios' && /^[A-Za-z0-9_-]{22}$/.test(a1.headers['apns-collapse-id'] || ''), JSON.stringify(a1.headers));
check('what Apple can read: the fixed placeholder and mutable-content, never the question or the command',
  JSON.stringify(a1.json.aps) === JSON.stringify({ alert: { title: 'Ravenry', body: 'Open Ravenry to see this alert.' }, sound: 'default', 'mutable-content': 1 }) && !a1.raw.toString().includes(SECRET) && !a1.raw.toString().includes('paper-boat'));
check('the relay was sent no readable word either', relayReqs.length > 0 && !JSON.stringify(relayReqs).includes(SECRET) && !JSON.stringify(relayReqs).includes('paper-boat'));
const m1 = a1.msg;
check('the device opens it: the whole message, the command, Run (fingerprint) Refuse Open',
  m1 && m1.type === 'alert' && m1.id === 'cp:cpappr1' && m1.title === 'paper-boat wants to run a command' && m1.body.includes(SECRET) && m1.actions.map((x) => `${x.id}${x.biometric ? '+bio' : ''}`).join() === 'run+bio,refuse,open', m1 && JSON.stringify(m1).slice(0, 200));
const ip2 = toTopic(nt, IP2_TOPIC)[0];
check('iPhone 2 through ntfy, as before: the title and the fixed line, the session\'s link, priority 4; never the command',
  ip2 && JSON.stringify(ip2.json) === JSON.stringify({ topic: IP2_TOPIC, title: 'paper-boat wants to run a command', message: 'On Test Mac. Run or refuse on the board.', priority: 4, click: `${BU}#paper-boat/c0ffee00-0000-4000-8000-000000000001` }), ip2 && ip2.body);
check('the Pixel gets the same message, sealed for it', toUp(nt)[0] && decrypt(toUp(nt)[0].raw, pixelKey, pixelAuth).body.includes(SECRET));

// A project moving into Needs you: the same, once each.
const proj = (state) => ({ id: 'boat', name: 'boat', state, primary: 'sf-boat', question: `${SECRET} 10 or 30 minutes?`, quick: [{ label: '10 minutes' }, { label: '30 minutes' }], sessions: [{ surfaceId: 'sf-boat', sessionId: 'c0ffee00-0000-4000-8000-0000000000b0', state: state === 'you' ? 'asked' : 'working', since: '2026-11-19T10:00:00Z', words: {}, assistant: 'claude' }] });
al.observe([proj('work')], { now: Date.now(), boardUrl: BU });
[na, nn] = counts();
al.observe([proj('you')], { now: Date.now() + 1000, boardUrl: BU });
await settle(() => apnsReqs.length > na && ntfyReqs.length >= nn + 2);
ap = apnsReqs.slice(na); nt = ntfyReqs.slice(nn);
check('a question: once each (APNs, the Pixel, iPhone 2), the old topic nothing', ap.length === 1 && toUp(nt).length === 1 && toTopic(nt, IP2_TOPIC).length === 1 && toTopic(nt, IP_TOPIC).length === 0, `${ap.length} ${nt.length}`);
check('the iPhone app opens the question with its answers and Reply', ap[0] && ap[0].msg && ap[0].msg.body.includes(SECRET) && ap[0].msg.actions.map((x) => x.label).join() === '10 minutes,30 minutes' && ap[0].msg.reply && ap[0].msg.reply.label === 'Reply');
[na, nn] = counts();
al.observe([proj('work')], { now: Date.now() + 2000, boardUrl: BU });
al.observe([proj('you')], { now: Date.now() + 3000, boardUrl: BU });
await settle(() => apnsReqs.length > na, 800);
ap = apnsReqs.slice(na);
check('the same moment again (a blip): no second alert to the iPhone (only its close)', ap.every((x) => x.msg && x.msg.type === 'close') && toTopic(ntfyReqs.slice(nn), IP2_TOPIC).length === 0, JSON.stringify(ap.map((x) => x.msg && x.msg.type)));

// ------------------------------------------------------------ a close

[na] = counts();
push.syncCheckpoints([]);
await settle(() => apnsReqs.length > na, 1500);
ap = apnsReqs.slice(na);
const cl = ap.find((x) => x.msg && x.msg.id === 'cp:cpappr1');
check('a close: a silent background push (priority 5, no alert) the app opens to take the alert off',
  cl && cl.headers['apns-push-type'] === 'background' && cl.headers['apns-priority'] === '5' && JSON.stringify(cl.json.aps) === '{"content-available":1}' && cl.msg.type === 'close', cl && JSON.stringify(cl.json.aps));

// ------------------------------------------------------------ the biggest message

{
  [na] = counts();
  const vs = Array.from({ length: 4 }, (_, i) => ({ label: `Variant ${i} ${'x'.repeat(150)}`, type: 'image', description: `${SECRET} ${'d'.repeat(400)}` }));
  al.checkpointAlert({ id: 'cpbig1', kind: 'pick', title: `${SECRET} ${'long question '.repeat(400)}`, variants: vs, pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
  await settle(() => apnsReqs.length > na);
  const big = apnsReqs.slice(na).find((x) => x.msg && x.msg.id === 'cp:cpbig1');
  check('a pick with long words and four variants: sent, within APNs\' 4096 bytes, still the pick (cut, not dropped)',
    big && big.raw.length <= 4096 && big.msg.kind === 'pick' && big.msg.title === 'paper-boat wants you to pick' && big.msg.body.startsWith(SECRET), big && `${big.raw.length} bytes`);
  const huge = push.checkpointMessage({ id: 'cphuge', kind: 'pick', title: 'q', variants: Array.from({ length: 30 }, (_, i) => ({ label: `v${i}`, description: 'd'.repeat(200) })) }, { project: cpProj });
  [na] = counts();
  push.send(huge);
  await settle(() => apnsReqs.length > na);
  const h = apnsReqs.slice(na).find((x) => x.msg && x.msg.id === 'cp:cphuge');
  check('one with too many variants to fit: what the alert needs and Open (the rest is in the app)', h && h.raw.length <= 4096 && h.msg.actions.map((x) => x.id).join() === 'open' && h.msg.checkpoint.id === 'cphuge', h && `${h.raw.length}`);
}

// ------------------------------------------------------------ sandbox

{
  phone.updateRecord('diphone1', (t) => { t.push.environment = 'sandbox'; });
  const n = relayReqs.length;
  await push.sendTo('diphone1', push.testMessage());
  check('a debug build\'s target asks the relay for sandbox', relayReqs.slice(n).length === 1 && relayReqs[n].environment === 'sandbox' && relayReqs[n].token === ipToken);
  phone.updateRecord('diphone1', (t) => { t.push.environment = 'production'; });
}

// ------------------------------------------------------------ errors

{
  // APNs down, through the relay: tried once more.
  relayDown = true;
  const n = relayReqs.length;
  push.send(push.testMessage());
  await sleep(150);
  relayDown = false;
  await settle(() => relayReqs.length >= n + 2, 2000);
  check('the relay answering 502: tried once more, after the retry wait', relayReqs.length - n === 2, String(relayReqs.length - n));
  // A token APNs refuses: not retried, the target kept.
  apnsAnswer = () => [400, '{"reason":"BadDeviceToken"}'];
  const m = relayReqs.length;
  const x = await push.sendTo('diphone1', push.testMessage());
  push.send(push.testMessage());
  await sleep(900);
  apnsAnswer = () => [200, ''];
  check('a token APNs refuses (400 BadDeviceToken): an error with the reason, no retry, the target kept', !x.ok && /400 \(BadDeviceToken\)/.test(x.error) && relayReqs.length - m === 2 && rec('diphone1').push.kind === 'apns', `${x.error} ${relayReqs.length - m}`);
  row = push.phones().find((p) => p.id === 'diphone1');
  check('the row\'s last send says what failed', row.last && row.last.ok === false && /BadDeviceToken/.test(row.last.error), JSON.stringify(row.last));
}

// ------------------------------------------------------------ the app deleted: 410

apnsAnswer = (req) => (req.url.includes(ipToken) ? [410, '{"reason":"Unregistered","timestamp":1}'] : [200, '']);
[na, nn] = counts();
const g = await push.sendTo('diphone1', push.testMessage());
r1 = rec('diphone1');
check('410 from APNs, through the relay: the target is dropped, the record keeps when and its old ntfy target', !g.ok && r1.push === null && !!r1.gone && !!r1.gone.at && r1.gone.was && r1.gone.was.topic === IP_TOPIC, JSON.stringify(r1));
row = push.phones().find((p) => p.id === 'diphone1');
check('its row: still there, gone since then, Use ntfy again offered', row && row.gone === r1.gone.at && row.ntfyBack === true && row.moved === null, JSON.stringify(row));
[na, nn] = counts();
al.checkpointAlert({ id: 'cpask9', kind: 'ask', title: `${SECRET}?`, options: ['Yes', 'No'], pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
await settle(() => ntfyReqs.length >= nn + 2, 1500);
nt = ntfyReqs.slice(nn);
check('after it: nothing to APNs, nothing to its old topic (no silent fall back), the others still get it', apnsReqs.length === na && toTopic(nt, IP_TOPIC).length === 0 && toTopic(nt, IP2_TOPIC).length === 1 && toUp(nt).length === 1, `${apnsReqs.length - na} ${toTopic(nt, IP_TOPIC).length}`);
check('Use ntfy again for a phone with nothing to go back to: refused', push.ntfyAgain('dpixel8') === false && push.ntfyAgain('nope') === false);
check('Use ntfy again: its old topic is its target again', push.ntfyAgain('diphone1') && rec('diphone1').push.kind === 'ntfy' && rec('diphone1').push.topic === IP_TOPIC && !rec('diphone1').gone);
[na, nn] = counts();
al.checkpointAlert({ id: 'cpask10', kind: 'ask', title: `${SECRET}?`, options: ['Yes', 'No'], pane: 'pq1', assistant: 'claude' }, { project: cpProj, boardUrl: BU });
await settle(() => ntfyReqs.length >= nn + 3, 1500);
nt = ntfyReqs.slice(nn);
const back = toTopic(nt, IP_TOPIC)[0];
check('and the next alert reaches it there, in clear words only', back && back.json.title === 'paper-boat asks' && back.json.message === 'Answer on the board.' && !back.body.includes(SECRET) && apnsReqs.length === na, back && back.body);
row = push.phones().find((p) => p.id === 'diphone1');
check('its row: through ntfy again', row.transport === 'ntfy' && row.gone === null);
{
  // Gone, then the app back (installed again and paired on the same record): it remembers ntfy.
  phone.updateRecord('diphone1', (t) => { t.gone = { at: now, was: { ...t.push } }; t.push = null; });
  const t3 = push.checkTarget({ kind: 'apns', relay: RELAY, token: ipToken, p256dh: b64u(ipKey.getPublicKey()), auth: b64u(ipAuth) });
  await push.setTarget('diphone1', t3.target);
  const r3 = rec('diphone1');
  check('the app back after it was gone: apns again, its old ntfy target still the one to go back to', r3.push.kind === 'apns' && r3.push.was && r3.push.was.topic === IP_TOPIC && !r3.gone);
}

push._reset();
apns.close(); relay.close(); ntfy.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
