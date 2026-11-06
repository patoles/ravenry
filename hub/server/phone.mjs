// Phone access (docs/design/PhoneQR.dc.html, variant A). The board listens on
// every interface so a phone on the home Wi-Fi can open it, and this module
// decides who gets in:
//
// - Host check: only localhost, 127.0.0.1, [::1] or one of the Mac's current
//   private LAN IPv4 addresses (with the port). Anything else is refused with
//   421, which blocks DNS-rebinding pages.
// - Loopback (the Mac itself) needs no key.
// - Every other request needs a phone cookie, except the sign-in: GET /?k=<key>
//   with the key the QR code carries. A match issues a per-phone token as an
//   HttpOnly cookie and redirects to / so the key leaves the address bar.
// - New key rotates the key and forgets every token.
//
// The phone apps (docs/PHONE.md) build on the same store: each token is a
// device ({ id, name, platform, app }), carried as the cookie by a phone
// browser or as `Authorization: Bearer` by an app on the phone port
// (server/phonetls.mjs). An app pairs with a one-time pairing code the
// Mac's card shows (pairingCode, pair), only while phone access is on
// (the `access` switch).
//
// State: <RAVENRY_HOME>/phone.json (mode 0600): { key, access, tokens: [{
// hash, id, name, platform, app, ua, created, lastSeen, push }] }. Tokens
// are kept as SHA-256 hashes. The key, a token and a pairing code are
// never logged.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RAVENRY_HOME } from './registry.mjs';
import { encode } from './vendor/uqr.mjs';

export const PHONE_FILE = path.join(RAVENRY_HOME, 'phone.json');
export const COOKIE = 'mc_phone';
// A short-lived readable cookie that tells the page it was just signed in,
// so it shows the one-time toast.
export const NEW_COOKIE = 'mc_new';
const YEAR_S = 365 * 24 * 3600;
const SEEN_SAVE_MS = 60 * 1000;

let data = null;
let lastSave = 0;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const shaHex = (s) => sha(s).toString('hex');
const newSecret = () => crypto.randomBytes(32).toString('base64url');
const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
const newId = () => 'd' + [...crypto.randomBytes(10)].map((b) => B32[b & 31]).join('');

// A phone browser's name from its user agent: "iPhone", "Android", else "Browser".
function browserName(ua) {
  const u = String(ua || '');
  if (/iPhone/.test(u)) return 'iPhone';
  if (/iPad/.test(u)) return 'iPad';
  if (/Android/.test(u)) return 'Android';
  return 'Browser';
}

function save() {
  fs.mkdirSync(RAVENRY_HOME, { recursive: true });
  const tmp = PHONE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, PHONE_FILE);
  lastSave = Date.now();
}

// Created on first use.
function load() {
  if (data) return data;
  let d = null;
  try { d = JSON.parse(fs.readFileSync(PHONE_FILE, 'utf8')); } catch { /* none yet */ }
  if (d && typeof d.key === 'string' && d.key.length >= 43) {
    data = { key: d.key, access: d.access === true, tokens: Array.isArray(d.tokens) ? d.tokens.filter((t) => t && typeof t.hash === 'string') : [] };
    try { fs.chmodSync(PHONE_FILE, 0o600); } catch { /* ignore */ }
    // A token from before devices (a phone browser's cookie) gets an id.
    let added = false;
    for (const t of data.tokens) if (typeof t.id !== 'string') { t.id = newId(); t.platform = t.platform || 'browser'; t.name = t.name || browserName(t.ua); added = true; }
    if (added) { try { save(); } catch { /* next time */ } }
  } else {
    data = { key: newSecret(), access: false, tokens: [] };
    save();
  }
  return data;
}

// ------------------------------------------------------------ network

function isPrivateV4(a) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

let lanCache = { at: 0, list: [] };

// The Mac's private LAN IPv4 addresses, en0 (Wi-Fi) first. MC_PHONE_LAN=none
// pretends there is none (tests and the off-Wi-Fi screenshot).
export function lanAddresses() {
  if (process.env.MC_PHONE_LAN === 'none') return [];
  if (Date.now() - lanCache.at < 2000) return lanCache.list;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPrivateV4(a.address)) out.push({ name, address: a.address });
    }
  }
  out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  lanCache = { at: Date.now(), list: out };
  return out;
}

export function hostOk(host, port) {
  const h = String(host || '').toLowerCase();
  const names = ['localhost', '127.0.0.1', '[::1]', ...lanAddresses().map((a) => a.address)];
  return names.some((n) => h === `${n}:${port}`);
}

export function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// ------------------------------------------------------------ cookies

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// The token a request carries: `Authorization: Bearer <token>` (an app),
// else the phone cookie (a phone browser).
export function tokenOf(req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})\s*$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : cookies(req)[COOKIE] || null;
}

// { ok, hash, id } for a valid device token; { ok: false, had } otherwise.
export function check(req) {
  const tok = tokenOf(req);
  if (!tok) return { ok: false, had: false };
  const d = load();
  const hash = shaHex(tok);
  const t = d.tokens.find((x) => x.hash === hash);
  if (!t) return { ok: false, had: true };
  t.lastSeen = new Date().toISOString();
  if (Date.now() - lastSave > SEEN_SAVE_MS) { try { save(); } catch { /* next time */ } }
  return { ok: true, hash, id: t.id };
}

function keyMatches(given) {
  // Hash both sides so the comparison is constant time whatever the length.
  return crypto.timingSafeEqual(sha(given), sha(load().key));
}

// GET /?k=<key> from a phone. Answers the request either way.
export function signIn(req, res, given) {
  const already = check(req);
  if (!keyMatches(given)) {
    if (already.ok) return redirect(res, []);
    return signedOutPage(res, 401, 'This code is out of date. Scan the code on the Mac again.');
  }
  const set = [`${NEW_COOKIE}=1; SameSite=Strict; Path=/; Max-Age=120`];
  if (!already.ok) {
    const tok = newSecret();
    const now = new Date().toISOString();
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    load().tokens.push({ hash: shaHex(tok), id: newId(), name: browserName(ua), platform: 'browser', app: null, ua, created: now, lastSeen: now, push: null });
    save();
    set.unshift(`${COOKIE}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${YEAR_S}`);
  }
  return redirect(res, set);
}

function redirect(res, setCookie) {
  res.writeHead(303, { Location: '/', 'Set-Cookie': setCookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

export function phoneCount() { return load().tokens.length; }

// New key: a fresh key, every token forgotten. Phone access stays as it was.
export function rotate() {
  const access = load().access;
  data = { key: newSecret(), access, tokens: [] };
  pairing = null;
  save();
}

// ------------------------------------------------------------ devices (docs/PHONE.md section 3)

export const access = () => load().access === true;

export function setAccess(on) {
  const d = load();
  d.access = !!on;
  if (!on) pairing = null;
  save();
}

const pub = (t) => ({ id: t.id, name: t.name || null, platform: t.platform || null, app: t.app || null, created: t.created || null, lastSeen: t.lastSeen || null, push: t.push ? t.push.kind : null });

// Every device, without its hash or push secrets.
export const devices = () => load().tokens.map(pub);
export function device(id) { const t = load().tokens.find((x) => x.id === id); return t ? pub(t) : null; }

// The device record itself (push.mjs reads its target).
export function deviceRecord(id) { return load().tokens.find((x) => x.id === id) || null; }

// Signs one device out. Returns whether it was there.
export function revoke(id) {
  const d = load();
  const n = d.tokens.length;
  d.tokens = d.tokens.filter((t) => t.id !== id);
  if (d.tokens.length === n) return false;
  save();
  return true;
}

// Sets (or clears, with null) a device's push target (server/push.mjs checks it).
export function setPush(id, target) {
  const t = load().tokens.find((x) => x.id === id);
  if (!t) return false;
  t.push = target || null;
  save();
  return true;
}

// Every device with a push target.
export const pushDevices = () => load().tokens.filter((t) => t.push && t.push.kind && t.push.kind !== 'none');

// What the phone calls this computer.
export function hubName() {
  return String(process.env.RAVENRY_HUB_NAME || os.hostname() || 'Ravenry').replace(/\.local\.?$/i, '') || 'Ravenry';
}

// ------------------------------------------------------------ pairing

const PAIR_MS = 10 * 60 * 1000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let pairing = null;   // { hash, expires }
let misses = [];      // times of wrong codes in the last minute
let lockedUntil = 0;

// A new one-time pairing code, 16 characters of Crockford base32 (80 bits),
// good for 10 minutes; the one before stops working.
export function pairingCode(now = Date.now()) {
  const bytes = crypto.randomBytes(10);
  let bitsLeft = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bitsLeft += 8;
    while (bitsLeft >= 5) { out += CROCKFORD[(acc >> (bitsLeft - 5)) & 31]; bitsLeft -= 5; }
    acc &= (1 << bitsLeft) - 1;
  }
  // The code itself stays in memory only, so the card can show it again.
  pairing = { hash: sha(out), code: out, expires: now + PAIR_MS };
  return { code: out, display: out.match(/.{4}/g).join('-'), expires: new Date(now + PAIR_MS).toISOString() };
}

// A typed code, cleaned the Crockford way: case, dashes and spaces ignored,
// O as 0, I and L as 1.
export function normalizeCode(c) {
  return String(c || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

// The check number of a pin (docs/PHONE.md section 3): its first five
// bytes as a big-endian number, modulo 10^12, as two groups of six digits.
export function checkNumber(pin) {
  const b = Buffer.from(String(pin), 'base64url');
  let n = 0n;
  for (const x of b.subarray(0, 5)) n = (n << 8n) | BigInt(x);
  const s = String(n % 1000000000000n).padStart(12, '0');
  return `${s.slice(0, 6)} ${s.slice(6)}`;
}

// The pairing link of docs/PHONE.md section 3.
export function pairLink({ name, hosts, port, pin, code }) {
  const q = new URLSearchParams({ v: '1', name, hosts: hosts.join(','), port: String(port), pin, code });
  return `ravenry://pair?${q}`;
}

// A pairing: { ok, token, device } or { ok: false, status, error }.
export function pair({ code, name, platform, app, ua }, now = Date.now()) {
  if (!access()) return { ok: false, status: 403, error: 'Phone access is off on the computer. Turn it on there, then scan the code again.' };
  misses = misses.filter((t) => now - t < 60000);
  if (now < lockedUntil) return { ok: false, status: 429, error: 'Too many wrong codes. Wait a minute, then scan the code again.' };
  const given = normalizeCode(code);
  const ok = !!pairing && now <= pairing.expires && /^[0-9A-Z]{16}$/.test(given) && crypto.timingSafeEqual(sha(given), pairing.hash);
  if (!ok) {
    misses.push(now);
    if (misses.length >= 5) { lockedUntil = now + 60000; misses = []; }
    const old = pairing && now > pairing.expires;
    return { ok: false, status: 401, error: old ? 'This code is out of date. Show the code on the computer again.' : 'That code is wrong or used already. Show the code on the computer again.' };
  }
  pairing = null;
  const tok = newSecret();
  const at = new Date(now).toISOString();
  const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const t = { hash: shaHex(tok), id: newId(), name: clip(name, 60) || 'Phone', platform: clip(platform, 20) || 'unknown', app: clip(app, 30), ua: String(ua || '').slice(0, 300), created: at, lastSeen: at, push: null };
  load().tokens.push(t);
  save();
  return { ok: true, token: tok, device: { id: t.id, name: t.name } };
}

// For tests: forget the pairing state kept in memory.
export function _resetPairing() { pairing = null; misses = []; lockedUntil = 0; }

// ------------------------------------------------------------ the card

export function qrSvg(text, px = 168, label = 'QR code for the board address') {
  const q = encode(text, { ecc: 'L', border: 4 });
  const W = q.size;
  let d = '';
  q.data.forEach((row, y) => {
    for (let x = 0; x < W; x++) {
      if (!row[x]) continue;
      let n = 1;
      while (x + n < W && row[x + n]) n++;
      d += `M${x} ${y}h${n}v1h-${n}z`;
      x += n - 1;
    }
  });
  return `<svg class="qr-svg" width="${px}" height="${px}" viewBox="0 0 ${W} ${W}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${W}" height="${W}" fill="#FFFFFF"/><path d="${d}" fill="#1D1D1F"/></svg>`;
}

// What the Mac's card shows. The key itself never leaves the server except
// inside the QR picture.
//
// `app` ({ port, pin, hosts }, the phone port's) adds, while phone access
// is on, what pairs the app (docs/PHONE.md section 3): the pairing link,
// its QR picture, the code as it is typed and the check number. The code
// shown is the live one while it has two minutes left, so a card that
// refreshes while a phone scans keeps its code; `fresh` makes a new one
// (the card opened again), and the one before stops working.
export function card(port, app = null, { fresh = false } = {}) {
  const lan = lanAddresses()[0];
  const phones = phoneCount();
  const out = lan
    ? { address: `http://${lan.address}:${port}/?k=`, svg: qrSvg(`http://${lan.address}:${port}/?k=${load().key}`), phones }
    : { address: null, svg: null, phones };
  out.access = access();
  out.devices = devices();
  if (app && out.access) {
    const c = !fresh && pairing && pairing.code && pairing.expires - Date.now() > 2 * 60 * 1000 ? shown(pairing) : pairingCode();
    const link = pairLink({ name: hubName(), hosts: app.hosts, port: app.port, pin: app.pin, code: c.code });
    out.app = { name: hubName(), hosts: app.hosts, port: app.port, link, svg: qrSvg(link, 168, 'QR code that pairs the Ravenry app'), code: c.display, expires: c.expires, check: checkNumber(app.pin) };
  }
  return out;
}

const shown = (p) => ({ code: p.code, display: p.code.match(/.{4}/g).join('-'), expires: new Date(p.expires).toISOString() });

// Where a phone finds this computer, in order: the Wi-Fi's addresses, then
// Tailscale's, then RAVENRY_PHONE_HOSTS (comma separated; an emulator's
// 10.0.2.2).
export function phoneHosts(tailscale = []) {
  const extra = String(process.env.RAVENRY_PHONE_HOSTS || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9.:-]{1,253}$/.test(x));
  return [...new Set([...lanAddresses().map((a) => a.address), ...tailscale, ...extra])];
}

// ------------------------------------------------------------ signed out

const PAGE_CSS = 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#161618;color:#A1A1A8;font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;padding:24px;box-sizing:border-box;text-align:center}@media (prefers-color-scheme: light){body{background:#F1F0ED;color:#5F5F66}}p{margin:0;max-width:320px}';

// A plain page for a phone without a valid cookie. A cross-site link drops
// SameSite=Strict cookies on the first navigation, so the page asks once,
// same-origin, whether the phone is in fact signed in, and reloads if so,
// keeping the #project an alert's link selects.
export function signedOutPage(res, status, text) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ravenry</title><style>${PAGE_CSS}</style></head><body><p>${text}</p><script>try{var k='mc-retry',t=Number(sessionStorage.getItem(k)||0);if(Date.now()-t>10000&&!/[?&]k=/.test(location.search)){fetch('/api/whoami',{credentials:'same-origin'}).then(function(r){if(r.ok){sessionStorage.setItem(k,String(Date.now()));location.replace('/'+location.hash);}});}}catch(e){}</script></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}

export const SIGNED_OUT = 'Signed out. Scan the code on the Mac again.';
export const NOT_SIGNED_IN = 'Scan the code on the Mac to open the board on this phone.';
