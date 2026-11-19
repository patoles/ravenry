#!/usr/bin/env node
// The relay (relay/src/relay.js, served by relay/src/index.js) in Node, against a stand-in APNs on
// 127.0.0.1 that records every request. Nothing goes to Apple: the APNs key
// is made here for the run, and APNS_ORIGIN points at the stand-in (a fetch
// to Apple's own hosts is caught and refused, see `realHosts`).
//
// What it proves: an alert reaches APNs as the fixed placeholder, the sealed
// bytes, mutable-content and the headers APNs needs, signed with a valid
// ES256 provider token (made once, made again when APNs says it expired);
// a close goes as a silent background push; production and sandbox go to
// their own hosts; APNs' answers map to what the hub acts on (410 gone, 400
// refused, 429, 502); anything that is not a sealed alert for a device
// token is refused before APNs is called; the rate limits answer 429 and
// see only hashes; nothing is ever written to the console.
//
// Usage: node relay/test/relay-test.mjs
import crypto from 'node:crypto';
import http from 'node:http';
import worker from '../src/index.js';
import { MAX_BODY, PLACEHOLDER, _forgetToken, apnsPayload } from '../src/relay.js';

let fails = 0, passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (ok) passes++; else fails++; };
const b64u = (b) => Buffer.from(b).toString('base64url');

// Nothing the relay does may reach the console.
const said = [];
const realLog = console.log;
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => { if (a[0] && /^(PASS|FAIL)  /.test(String(a[0]))) return orig(...a); said.push([k, a]); };
}
void realLog;

// ------------------------------------------------------------ the stand-in APNs

const reqs = [];
let answer = () => [200, ''];
const apns = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    reqs.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    const [status, body] = answer(req);
    res.writeHead(status, { 'Content-Type': 'application/json', 'apns-id': crypto.randomUUID() });
    res.end(body);
  });
});
await new Promise((r) => apns.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${apns.address().port}`;

// Apple's hosts are never called: a fetch there is recorded and refused.
const realHosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (/push\.apple\.com/.test(s)) { realHosts.push(s); return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }); }
  return realFetch(u, init);
};

// ------------------------------------------------------------ an APNs key made for this run

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const limits = { device: [], address: [], deny: null };
const limiter = (name) => ({ limit: async ({ key }) => { limits[name].push(key); return { success: limits.deny !== name }; } });
const ENV = { APNS_KEY: PEM, APNS_KEY_ID: 'TESTKEYID1', APNS_TEAM_ID: 'TESTTEAM01', APNS_TOPIC: 'dev.ravenry.ios', APNS_ORIGIN: ORIGIN, PER_DEVICE: limiter('device'), PER_ADDRESS: limiter('address') };

const TOKEN = crypto.randomBytes(32).toString('hex');
// A body with the shape of an aes128gcm message for a P-256 key.
function sealed(n = 400) {
  const head = Buffer.alloc(21);
  crypto.randomBytes(16).copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = 65;
  return Buffer.concat([head, Buffer.from([4]), crypto.randomBytes(64), crypto.randomBytes(Math.max(17, n - 86))]);
}
const call = async (body, { method = 'POST', path = '/v1/apns', env = ENV, ip = '203.0.113.9', raw = null } = {}) => {
  const init = { method, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip } };
  if (method === 'POST') init.body = raw != null ? raw : JSON.stringify(body);
  const res = await worker.fetch(new Request(`https://relay.example${path}`, init), env);
  let j = null;
  const t = await res.text();
  try { j = JSON.parse(t); } catch { /* text */ }
  return { status: res.status, j, t, headers: res.headers };
};
const verifyJwt = (jwt) => {
  const [h, c, s] = String(jwt).split('.');
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return { ok, head: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) };
};

// ------------------------------------------------------------ an alert

let n = reqs.length;
const body = b64u(sealed(900));
let r = await call({ token: TOKEN, environment: 'production', ttl: 3600, push: 'alert', collapse: 'aBc_-12', body });
let got = reqs.slice(n);
check('an alert: 200 { ok: true }, one request to APNs', r.status === 200 && r.j && r.j.ok === true && got.length === 1, `${r.status} ${r.t}`);
const a = got[0] || { headers: {}, body: '{}' };
check('to /3/device/<token>, POST', a.method === 'POST' && a.url === `/3/device/${TOKEN}`, a.url);
const now = Math.floor(Date.now() / 1000);
check('headers: topic, push type alert, priority 10, expiration in an hour, the collapse id',
  a.headers['apns-topic'] === 'dev.ravenry.ios' && a.headers['apns-push-type'] === 'alert' && a.headers['apns-priority'] === '10'
  && Math.abs(Number(a.headers['apns-expiration']) - (now + 3600)) < 5 && a.headers['apns-collapse-id'] === 'aBc_-12', JSON.stringify(a.headers));
const jwt = (a.headers.authorization || '').replace(/^bearer /, '');
const v = verifyJwt(jwt);
check('the provider token: ES256, signed by the key, kid and iss from the secrets, iat now', v.ok && v.head.alg === 'ES256' && v.head.kid === 'TESTKEYID1' && v.claims.iss === 'TESTTEAM01' && Math.abs(v.claims.iat - now) < 5, JSON.stringify([v.head, v.claims]));
let p = {};
try { p = JSON.parse(a.body); } catch { /* checked below */ }
check('the payload: the fixed placeholder, sound, mutable-content 1, the sealed bytes as e, nothing else',
  JSON.stringify(p) === JSON.stringify({ aps: { alert: PLACEHOLDER, sound: 'default', 'mutable-content': 1 }, e: body }), a.body.slice(0, 160));
check('the placeholder is fixed words', PLACEHOLDER.title === 'Ravenry' && PLACEHOLDER.body === 'Open Ravenry to see this alert.');

n = reqs.length;
await call({ token: TOKEN.toUpperCase(), body });
got = reqs.slice(n);
check('a second alert: the same provider token (made once, not per request); defaults production, ttl 3600; an upper-case token is the same token',
  got.length === 1 && got[0].headers.authorization === a.headers.authorization && got[0].url === `/3/device/${TOKEN}` && !got[0].headers['apns-collapse-id']);

// ------------------------------------------------------------ a close (background)

n = reqs.length;
r = await call({ token: TOKEN, push: 'background', collapse: 'x1', ttl: 0, body });
got = reqs.slice(n);
let pb = {};
try { pb = JSON.parse(got[0].body); } catch { /* checked */ }
check('a close: a silent background push (content-available, priority 5, no alert, no collapse), expiration 0',
  r.status === 200 && got.length === 1 && got[0].headers['apns-push-type'] === 'background' && got[0].headers['apns-priority'] === '5' && !got[0].headers['apns-collapse-id']
  && got[0].headers['apns-expiration'] === '0' && JSON.stringify(pb) === JSON.stringify({ aps: { 'content-available': 1 }, e: body }), got[0] && got[0].body.slice(0, 120));

// ------------------------------------------------------------ production and sandbox

{
  const env = { ...ENV, APNS_ORIGIN: '' };
  realHosts.length = 0;
  await call({ token: TOKEN, environment: 'production', body }, { env });
  await call({ token: TOKEN, environment: 'sandbox', body }, { env });
  check('production goes to api.push.apple.com, sandbox to api.sandbox.push.apple.com (caught here, never sent)',
    realHosts[0] === `https://api.push.apple.com/3/device/${TOKEN}` && realHosts[1] === `https://api.sandbox.push.apple.com/3/device/${TOKEN}`, JSON.stringify(realHosts));
}

// ------------------------------------------------------------ APNs' answers

const answers = [
  [410, { reason: 'Unregistered', timestamp: 1 }, 410, 'the app gone from the device (410 Unregistered): 410, so the hub drops it'],
  [400, { reason: 'BadDeviceToken' }, 400, 'a token APNs refuses (400 BadDeviceToken): 400 with the reason'],
  [400, { reason: 'DeviceTokenNotForTopic' }, 400, 'a token for another app: 400 with the reason'],
  [429, { reason: 'TooManyRequests' }, 429, 'too many for this device: 429'],
  [500, { reason: 'InternalServerError' }, 502, 'APNs down: 502'],
  [503, { reason: 'ServiceUnavailable' }, 502, 'APNs unavailable: 502'],
];
for (const [st, j, want, name] of answers) {
  answer = () => [st, JSON.stringify(j)];
  r = await call({ token: TOKEN, body });
  check(name, r.status === want && (st === 500 || st === 503 || r.j.reason === j.reason), `${r.status} ${r.t}`);
}
answer = () => [403, JSON.stringify({ reason: 'ExpiredProviderToken' })];
const before = reqs.length;
r = await call({ token: TOKEN, body });
answer = () => [200, ''];
await new Promise((res) => setTimeout(res, 1100));
await call({ token: TOKEN, body });
const after = reqs.slice(before);
check('403 ExpiredProviderToken: 502 (the hub tries again), and the next request carries a new provider token',
  r.status === 502 && after.length === 2 && after[0].headers.authorization !== after[1].headers.authorization && verifyJwt(after[1].headers.authorization.slice(7)).ok);
{
  const env = { ...ENV, APNS_ORIGIN: 'http://127.0.0.1:1' };
  r = await call({ token: TOKEN, body }, { env });
  check('APNs not reachable: 502', r.status === 502, `${r.status} ${r.t}`);
}

// ------------------------------------------------------------ what is refused before APNs

n = reqs.length;
const refusals = [
  ['GET /v1/apns: 405', await call(null, { method: 'GET' }), 405],
  ['another path: 404', await call({ token: TOKEN, body }, { path: '/v1/fcm' }), 404],
  ['not JSON: 400', await call(null, { raw: 'hello' }), 400],
  ['a request over 8 KB: 413', await call(null, { raw: JSON.stringify({ token: TOKEN, body: 'A'.repeat(9000) }) }), 413],
  ['no token: 400', await call({ body }), 400],
  ['a token that is not hex (a URL, a path): 400', await call({ token: `../../x/${TOKEN}`, body }), 400],
  ['a short token: 400', await call({ token: 'abcd', body }), 400],
  ['an environment other than production or sandbox: 400', await call({ token: TOKEN, environment: 'https://evil.example', body }), 400],
  ['push other than alert or background: 400', await call({ token: TOKEN, push: 'voip', body }), 400],
  ['a ttl that is not whole seconds within a week: 400', await call({ token: TOKEN, ttl: 99999999, body }), 400],
  ['a collapse id with other characters: 400', await call({ token: TOKEN, collapse: 'hello world', body }), 400],
  ['free text as the body (words a person would see): 400', await call({ token: TOKEN, body: b64u(Buffer.from('Your account is locked. Open this link to unlock it now. '.repeat(4))) }), 400],
  ['a body that is not base64url: 400', await call({ token: TOKEN, body: 'not base64 at all!' }), 400],
  [`a body over ${MAX_BODY} bytes: 413`, await call({ token: TOKEN, body: b64u(sealed(MAX_BODY + 1)) }), 413],
  ['a relay with no APNs key set up: 503', await call({ token: TOKEN, body }, { env: { ...ENV, APNS_KEY: '' } }), 503],
];
for (const [name, res, want] of refusals) check(name, res.status === want && res.j && res.j.ok === false, `${res.status} ${res.t.slice(0, 100)}`);
check('none of them reached APNs', reqs.length === n, String(reqs.length - n));
{
  const env = { ...ENV, APNS_KEY: ['-----BEGIN', 'PRIVATE KEY-----\nAAAA\n-----END', 'PRIVATE KEY-----'].join(' ') };
  _forgetToken();
  r = await call({ token: TOKEN, body }, { env });
  check('a key that does not import: 503, nothing sent', r.status === 503 && reqs.length === n, `${r.status}`);
  _forgetToken();
}

// ------------------------------------------------------------ size

{
  const big = b64u(sealed(MAX_BODY));
  const bytes = Buffer.byteLength(apnsPayload({ push: 'alert', body: big }));
  check(`the largest body allowed (${MAX_BODY} bytes) makes a payload within APNs' 4096`, bytes <= 4096, `${bytes} bytes`);
  n = reqs.length;
  r = await call({ token: TOKEN, body: big });
  check('and it is sent', r.status === 200 && reqs.length === n + 1);
}

// ------------------------------------------------------------ rate limits

limits.device.length = 0; limits.address.length = 0;
limits.deny = 'device';
n = reqs.length;
r = await call({ token: TOKEN, body });
check('a device over its limit: 429 with Retry-After, nothing sent', r.status === 429 && r.headers.get('retry-after') === '60' && reqs.length === n);
limits.deny = 'address';
r = await call({ token: TOKEN, body });
check('an address over its limit: 429, nothing sent', r.status === 429 && reqs.length === n);
limits.deny = null;
const keys = [...limits.device, ...limits.address];
check('the limits see only hashes, never the token or the address', keys.length >= 3 && keys.every((k) => /^[da]:[0-9a-f]{32}$/.test(k) && !k.includes(TOKEN.slice(0, 16)) && !k.includes('203.0.113.9')), JSON.stringify(keys.slice(0, 3)));
{
  const env = { ...ENV, PER_DEVICE: undefined, PER_ADDRESS: undefined };
  r = await call({ token: TOKEN, body }, { env });
  check('a relay without the limit bindings (self-hosted): still works', r.status === 200);
}

// ------------------------------------------------------------ the rest

r = await call(null, { method: 'GET', path: '/' });
check('GET /: one line that says what it is', r.status === 200 && /keeps nothing/.test(r.t));
check('nothing was written to the console, ever', said.length === 0, JSON.stringify(said).slice(0, 200));

apns.close();
process.stdout.write(`\n${passes} passed, ${fails} failed\n`);
process.exit(fails ? 1 : 0);
