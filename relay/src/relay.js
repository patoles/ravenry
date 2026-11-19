// The Ravenry relay (served by src/index.js): one route that hands a sealed alert to Apple's push
// service (APNs) for the Ravenry iPhone and iPad app (docs/PHONE.md
// section 4, "apns", and relay/README.md).
//
//   POST /v1/apns  { token, environment, ttl, push, collapse, body }
//
// The hub on the person's Mac encrypts each alert for one device (RFC 8291,
// aes128gcm) and sends it here; the relay signs a provider token with
// Ravenry's APNs key and posts the sealed bytes to APNs. The app's
// Notification Service Extension decrypts them on the device and draws the
// real alert. The relay cannot read an alert and keeps nothing: no storage
// binding, no logs (observability is off in wrangler.jsonc and nothing here
// writes to the console about a request).
//
// Anyone can call a public relay, so it only ever does one fixed thing:
// - the only words a person can see, if the app cannot open an alert, are
//   the fixed placeholder below; nothing a caller sends is ever shown;
// - the body must have the shape of an aes128gcm record for a P-256 key,
//   and is at most MAX_BODY bytes (APNs takes 4 KB in all);
// - the device token must be a token (hex), so the relay is no open proxy:
//   it only ever calls APNs, for one app (APNS_TOPIC);
// - a device and a network address may each send a bounded number of
//   requests a minute (the rate limiting bindings, counters in Cloudflare's
//   memory at each location, keyed by a hash).

// What iOS shows when the extension cannot open an alert: fixed words, never the caller's.
export const PLACEHOLDER = { title: 'Ravenry', body: 'Open Ravenry to see this alert.' };

const MAX_REQUEST = 8 * 1024;
// The sealed bytes: header (21) + the sender's key (65) + a record of at
// least one byte and its tag (17); at most 2900 bytes, which in base64url
// (3867 characters) with the fixed JSON stays within APNs' 4096.
const MIN_BODY = 21 + 65 + 17;
export const MAX_BODY = 2900;
const MAX_TTL = 7 * 24 * 3600;
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
const COLLAPSE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;
const ORIGINS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
// A provider token is good for an hour; APNs refuses a new one more often
// than every 20 minutes. Made again after 40.
const JWT_MS = 40 * 60 * 1000;

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

const b64u = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const enc = new TextEncoder();

async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------ the request

// Checks a request's JSON: { ok, req } or { ok: false, status, error }.
export function checkRequest(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, status: 400, error: 'Send a JSON object.' };
  const token = typeof b.token === 'string' ? b.token.toLowerCase() : '';
  if (!TOKEN_RE.test(token)) return { ok: false, status: 400, error: 'token is not a device token.' };
  const environment = b.environment == null ? 'production' : b.environment;
  if (!ORIGINS[environment]) return { ok: false, status: 400, error: 'environment is production or sandbox.' };
  const push = b.push == null ? 'alert' : b.push;
  if (push !== 'alert' && push !== 'background') return { ok: false, status: 400, error: 'push is alert or background.' };
  const ttl = b.ttl == null ? 3600 : b.ttl;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) return { ok: false, status: 400, error: `ttl is whole seconds, 0 to ${MAX_TTL}.` };
  if (b.collapse != null && (typeof b.collapse !== 'string' || !COLLAPSE_RE.test(b.collapse))) return { ok: false, status: 400, error: 'collapse is at most 64 letters, digits, - or _.' };
  if (typeof b.body !== 'string' || !B64U_RE.test(b.body) || b.body.length > Math.ceil((MAX_BODY * 4) / 3)) return { ok: false, status: b.body && b.body.length > Math.ceil((MAX_BODY * 4) / 3) ? 413 : 400, error: `body is the sealed alert in base64url, at most ${MAX_BODY} bytes.` };
  let raw;
  try { raw = unb64u(b.body); } catch { return { ok: false, status: 400, error: 'body is not base64url.' }; }
  if (raw.length > MAX_BODY) return { ok: false, status: 413, error: `body is at most ${MAX_BODY} bytes.` };
  // aes128gcm (RFC 8188) for Web Push (RFC 8291): salt(16) rs(4) idlen(1)=65, keyid = an uncompressed P-256 key.
  if (raw.length < MIN_BODY || raw[20] !== 65 || raw[21] !== 4) return { ok: false, status: 400, error: 'body is not an aes128gcm message for a P-256 key.' };
  return { ok: true, req: { token, environment, push, ttl, collapse: b.collapse || null, body: b.body } };
}

// The JSON APNs gets: the fixed placeholder (an alert the extension opens
// and redraws) or a silent wake-up (a close, for the app to take an alert
// off), and the sealed bytes as `e`. Nothing else, and nothing a caller wrote.
export function apnsPayload(r) {
  const aps = r.push === 'background' ? { 'content-available': 1 } : { alert: { ...PLACEHOLDER }, sound: 'default', 'mutable-content': 1 };
  return JSON.stringify({ aps, e: r.body });
}

// ------------------------------------------------------------ the provider token (ES256)

let jwtCache = null; // { id, at, jwt }: a provider token, never request data

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function providerToken(env, now = Date.now()) {
  const id = `${env.APNS_KEY_ID}.${env.APNS_TEAM_ID}`;
  if (jwtCache && jwtCache.id === id && now - jwtCache.at < JWT_MS) return jwtCache.jwt;
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(env.APNS_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })));
  const claims = b64u(enc.encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })));
  // Web Crypto's ECDSA signature is r || s, which is JWS's ES256 form.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  const jwt = `${head}.${claims}.${b64u(sig)}`;
  jwtCache = { id, at: now, jwt };
  return jwt;
}

export function _forgetToken() { jwtCache = null; }

// ------------------------------------------------------------ APNs

// Sends one request to APNs. Resolves the relay's answer: 200 sent; 410 the
// app is gone from the device (Unregistered), so the hub drops it; 400 a
// token APNs refuses (BadDeviceToken, DeviceTokenNotForTopic: also a debug
// build's token sent to production, or the other way); 429 too many for
// this device; 502 anything on our side or Apple's.
async function toApns(r, env) {
  const origin = (env.APNS_ORIGIN && env.APNS_ORIGIN.trim()) || ORIGINS[r.environment];
  const headers = {
    authorization: `bearer ${await providerToken(env)}`,
    'apns-topic': env.APNS_TOPIC,
    'apns-push-type': r.push,
    'apns-priority': r.push === 'background' ? '5' : '10',
    'apns-expiration': String(r.ttl ? Math.floor(Date.now() / 1000) + r.ttl : 0),
    'content-type': 'application/json',
  };
  if (r.collapse && r.push === 'alert') headers['apns-collapse-id'] = r.collapse;
  let res;
  try {
    res = await fetch(`${origin}/3/device/${r.token}`, { method: 'POST', headers, body: apnsPayload(r), redirect: 'manual', signal: AbortSignal.timeout(10000) });
  } catch {
    return json(502, { ok: false, error: 'APNs did not answer.' });
  }
  if (res.status === 200) { await res.arrayBuffer().catch(() => null); return json(200, { ok: true }); }
  let reason = null;
  try { const j = await res.json(); reason = typeof j.reason === 'string' ? j.reason.slice(0, 64) : null; } catch { /* no body */ }
  if (res.status === 410) return json(410, { ok: false, reason: reason || 'Unregistered', error: 'The app is gone from this device.' });
  if (res.status === 403) {
    // Our provider token: made again next time, and the hub tries again.
    if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') jwtCache = null;
    return json(502, { ok: false, reason, error: 'The relay could not sign in to APNs.' });
  }
  if (res.status === 429) return json(429, { ok: false, reason, error: 'Too many alerts for this device.' });
  if (res.status === 400 || res.status === 413) return json(400, { ok: false, reason, error: 'APNs refused it.' });
  return json(502, { ok: false, reason, error: `APNs answered ${res.status}.` });
}

// ------------------------------------------------------------ the Worker

async function limited(env, token, ip) {
  // No binding (a self-hosted relay without them, the tests): no limit.
  if (env.PER_DEVICE) { const r = await env.PER_DEVICE.limit({ key: `d:${await sha256Hex(token)}` }); if (!r.success) return true; }
  if (env.PER_ADDRESS && ip) { const r = await env.PER_ADDRESS.limit({ key: `a:${await sha256Hex(ip)}` }); if (!r.success) return true; }
  return false;
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_REQUEST) return { status: 413 };
  if (!request.body) return { status: 400 };
  // Read at most MAX_REQUEST bytes, whatever the header said.
  const reader = request.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_REQUEST) { await reader.cancel().catch(() => {}); return { status: 413 }; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  try { return { body: JSON.parse(new TextDecoder().decode(all)) }; } catch { return { status: 400 }; }
}

// The Worker's handler (src/index.js exports it: an entry module exports
// handlers only).
export const handler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response('Ravenry relay. It keeps nothing.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (url.pathname !== '/v1/apns') return json(404, { ok: false, error: 'Not here.' });
    if (request.method !== 'POST') return json(405, { ok: false, error: 'POST only.' }, { Allow: 'POST' });
    if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return json(503, { ok: false, error: 'This relay has no APNs key set up.' });
    const got = await readJson(request);
    if (!got.body) return json(got.status, { ok: false, error: got.status === 413 ? `At most ${MAX_REQUEST} bytes.` : 'Send JSON.' });
    const c = checkRequest(got.body);
    if (!c.ok) return json(c.status, { ok: false, error: c.error });
    if (await limited(env, c.req.token, request.headers.get('cf-connecting-ip'))) return json(429, { ok: false, error: 'Too many requests. Try again in a minute.' }, { 'Retry-After': '60' });
    try {
      return await toApns(c.req, env);
    } catch {
      // A key that does not import or sign: the relay's own setup.
      return json(503, { ok: false, error: 'The relay could not sign its request to APNs.' });
    }
  },
};
