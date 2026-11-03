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
// State: <RAVENRY_HOME>/phone.json (mode 0600): { key, tokens: [{ hash, ua,
// created, lastSeen }] }. Tokens are kept as SHA-256 hashes. The key is never
// logged.

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
    data = { key: d.key, tokens: Array.isArray(d.tokens) ? d.tokens.filter((t) => t && typeof t.hash === 'string') : [] };
    try { fs.chmodSync(PHONE_FILE, 0o600); } catch { /* ignore */ }
  } else {
    data = { key: newSecret(), tokens: [] };
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

// { ok, hash } for a valid phone cookie; { ok: false, had } otherwise.
export function check(req) {
  const tok = cookies(req)[COOKIE];
  if (!tok) return { ok: false, had: false };
  const d = load();
  const hash = shaHex(tok);
  const t = d.tokens.find((x) => x.hash === hash);
  if (!t) return { ok: false, had: true };
  t.lastSeen = new Date().toISOString();
  if (Date.now() - lastSave > SEEN_SAVE_MS) { try { save(); } catch { /* next time */ } }
  return { ok: true, hash };
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
    load().tokens.push({ hash: shaHex(tok), ua: String(req.headers['user-agent'] || '').slice(0, 300), created: now, lastSeen: now });
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

// New key: a fresh key, every token forgotten.
export function rotate() {
  load();
  data = { key: newSecret(), tokens: [] };
  save();
}

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
export function card(port) {
  const lan = lanAddresses()[0];
  const phones = phoneCount();
  if (!lan) return { address: null, svg: null, phones };
  const origin = `http://${lan.address}:${port}`;
  return { address: `${origin}/?k=`, svg: qrSvg(`${origin}/?k=${load().key}`), phones };
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
