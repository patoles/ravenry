// The phone port (docs/PHONE.md section 2): TLS for the phone apps, only
// while phone access is on.
//
// - The key: one ECDSA P-256 key and a self-signed certificate for it,
//   made on first use with Node's crypto alone (the DER below), kept in
//   <RAVENRY_HOME>/phone-tls/ (key mode 0600). The phone pins the key, not
//   the certificate's names or its signer: the pin is the base64url
//   SHA-256 of the certificate's SubjectPublicKeyInfo.
// - The server: https on RAVENRY_PHONE_PORT (default the board's port plus
//   one), on every interface, but a connection that arrives on any local
//   address other than loopback, a private LAN IPv4 address or a Tailscale
//   address is closed before TLS. With phone access off nothing listens.
// - Every request on it is a phone's (server/index.mjs gate): the device
//   token is required, and nothing here is ever the Mac.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { RAVENRY_HOME } from './registry.mjs';
import { hubBind } from './home.mjs';

export const TLS_DIR = path.join(RAVENRY_HOME, 'phone-tls');
const KEY_FILE = path.join(TLS_DIR, 'key.pem');
const CERT_FILE = path.join(TLS_DIR, 'cert.pem');

// ------------------------------------------------------------ DER

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const ctx = (n, body) => tlv(0xa0 | n, body);
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const parts = [];
    let x = v;
    do { parts.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x > 0);
    for (let i = 0; i < parts.length - 1; i++) parts[i] |= 0x80;
    out.push(...parts);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const CN = '2.5.4.3';

// A self-signed X.509 v3 certificate for `key` (a P-256 KeyObject pair),
// valid from yesterday for 20 years. No extensions: the phone checks the
// key, nothing else.
export function selfSigned({ privateKey, publicKey }, name = 'Ravenry hub', now = new Date()) {
  const alg = seq(oid(ECDSA_SHA256));
  const dn = seq(set(seq(oid(CN), utf8(name))));
  const from = new Date(now.getTime() - 24 * 3600 * 1000);
  const to = new Date(from.getTime());
  to.setUTCFullYear(from.getUTCFullYear() + 20);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(serial), alg, dn, seq(utcTime(from), utcTime(to)), dn, spki);
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, alg, bits(sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

// The pin of a certificate (PEM or X509Certificate): base64url SHA-256 of
// its SubjectPublicKeyInfo.
export function pinOf(cert) {
  const x = cert instanceof crypto.X509Certificate ? cert : new crypto.X509Certificate(cert);
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('base64url');
}

let cached = null;

// { key, cert, pin }, made on first use.
export function identity() {
  if (cached) return cached;
  let key = null, cert = null;
  try {
    key = fs.readFileSync(KEY_FILE, 'utf8');
    cert = fs.readFileSync(CERT_FILE, 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (!x.checkPrivateKey(crypto.createPrivateKey(key))) throw new Error('mismatch');
  } catch {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    key = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    cert = selfSigned(pair);
    fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
    const tk = KEY_FILE + '.tmp';
    fs.writeFileSync(tk, key, { mode: 0o600 });
    fs.chmodSync(tk, 0o600);
    fs.renameSync(tk, KEY_FILE);
    const tc = CERT_FILE + '.tmp';
    fs.writeFileSync(tc, cert, { mode: 0o644 });
    fs.renameSync(tc, CERT_FILE);
  }
  cached = { key, cert, pin: pinOf(cert) };
  return cached;
}

// ------------------------------------------------------------ addresses

const v4 = (a) => { const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(a); return m ? m.slice(1).map(Number) : null; };

export function isLoopbackAddr(a) {
  const s = String(a || '');
  const q = v4(s);
  return q ? q[0] === 127 : s === '::1';
}
export function isPrivateV4Addr(a) {
  const q = v4(String(a || ''));
  return !!q && (q[0] === 10 || (q[0] === 172 && q[1] >= 16 && q[1] <= 31) || (q[0] === 192 && q[1] === 168));
}
export function isTailscaleAddr(a) {
  const s = String(a || '').toLowerCase();
  const q = v4(s);
  if (q) return q[0] === 100 && q[1] >= 64 && q[1] <= 127;
  return /^fd7a:115c:a1e0:/.test(s);
}

// An IPv6 unique local address (fc00::/7), a home network's own range;
// Tailscale's fd7a:115c:a1e0::/48 is one.
export function isUlaAddr(a) {
  return /^f[cd][0-9a-f]{2}:/i.test(String(a || ''));
}

// Whether a connection that arrived on this local address may talk to the
// phone port.
export function localAddressOk(a) {
  return isLoopbackAddr(a) || isPrivateV4Addr(a) || isTailscaleAddr(a);
}

// This machine's Tailscale addresses (IPv4 first).
export function tailscaleAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) {
    if (!i.internal && isTailscaleAddr(i.address)) out.push(i.address);
  }
  return out.sort((a, b) => (b.includes('.') - a.includes('.')));
}

// The Mac's own Tailscale app's addresses, only while that app is connected:
// a 100.x address can stay on its interface while the app is stuck
// connecting, and a phone would wait on it for nothing (Simon's playtest,
// 2026-11-12). The app's CLI (`tailscale status --json`, read only) says
// whether it runs; asked in the background at most every 30 s, and an
// answer that does not come in 3 s counts as not connected. With no CLI to
// ask (a Tailscale without one) the addresses are listed as before.
// RAVENRY_TAILSCALE_CLI names the CLI (a test's stand-in); empty: none.
const TS_CLIS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'];
const tsState = { at: 0, up: null, asking: false };
function tailscaleCli() {
  if ('RAVENRY_TAILSCALE_CLI' in process.env) return process.env.RAVENRY_TAILSCALE_CLI || null;
  return TS_CLIS.find((f) => fs.existsSync(f)) || null;
}
export function systemTailscaleRunning(text) {
  let j = null;
  try { j = JSON.parse(String(text || '')); } catch { return false; }
  return !!j && j.BackendState === 'Running' && !(j.Self && j.Self.Online === false);
}
function askTailscale(cli) {
  if (tsState.asking || Date.now() - tsState.at < 30000) return;
  tsState.asking = true;
  import('node:child_process').then(({ execFile }) => {
    execFile(cli, ['status', '--json'], { timeout: 3000, maxBuffer: 8 << 20 }, (err, out) => {
      tsState.up = !err && systemTailscaleRunning(out);
      tsState.at = Date.now();
      tsState.asking = false;
    });
  }).catch(() => { tsState.asking = false; });
}
export function systemTailscale() {
  const addrs = tailscaleAddresses();
  if (!addrs.length) return [];
  const cli = tailscaleCli();
  if (!cli) return addrs;
  askTailscale(cli);
  return tsState.up ? addrs : [];
}

// ------------------------------------------------------------ the server

export function phonePort(boardPort) {
  const p = Number(process.env.RAVENRY_PHONE_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : boardPort + 1;
}

let server = null;
let listening = false;
const sockets = new Set();

// Starts the phone port with `handler(req, res)` and `onUpgrade(req, socket,
// head)`. Every request it hands on has req.mcTls set.
export function start(port, handler, onUpgrade) {
  if (server) return server;
  const id = identity();
  server = https.createServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.2' }, (req, res) => { req.mcTls = true; handler(req, res); });
  server.on('connection', (sock) => {
    if (!localAddressOk(sock.localAddress)) { sock.destroy(); return; }
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  server.on('upgrade', (req, sock, head) => { req.mcTls = true; onUpgrade(req, sock, head); });
  server.on('tlsClientError', () => {});
  server.on('error', (e) => { console.error(`phone port :${port}: ${e.message}`); listening = false; });
  // A test's board: the phone port on this Mac only, never the Wi-Fi's (home.mjs hubBind).
  // The person's: every address (it is open only while phone access is on).
  const bind = hubBind() || undefined;
  server.listen(port, bind, () => { listening = true; console.log(`phone access on: TLS on ${bind || ''}:${port}`); });
  return server;
}

export function stop() {
  if (!server) return;
  const s = server;
  server = null;
  listening = false;
  s.close();
  for (const sock of sockets) sock.destroy();
  sockets.clear();
  console.log('phone access off: the phone port is closed');
}

export const running = () => !!server && listening;
