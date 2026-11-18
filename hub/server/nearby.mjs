// The hub on the Wi-Fi by Bonjour (docs/PHONE.md, Finding the Mac on the
// Wi-Fi): while phone access is on, the phone port is advertised as
// `_ravenry._tcp`, so a paired phone whose saved Wi-Fi address no longer
// answers (the Mac got a new address from the router, another network, a
// router restart) finds the Mac where it is now, without pairing again.
//
// - What is said: the service type, the phone port, and in its TXT record
//   `v=1` and `id`, a short id made from the phone port's pinned key
//   (hubId). Never the Mac's name, the person's name or anything private:
//   the instance name is "Ravenry " and the first characters of the id.
//   The phone takes only a service whose id is its own Mac's, and the TLS
//   pin stays the check that it is that Mac.
// - How: macOS's own mDNSResponder, through /usr/bin/dns-sd -R, a child
//   process for as long as the advertisement lasts. Stopped when phone
//   access goes off (or the hub exits); started again if it ends by
//   itself, after 2 s doubling to 60 s. No dns-sd (not a Mac): nothing.
// - A test's board never advertises (its phone port is on 127.0.0.1 only:
//   home.mjs hubBind); RAVENRY_NEARBY=0 turns it off; RAVENRY_NEARBY_BIN
//   names a stand-in for dns-sd (tools/nearby-test.mjs).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const SERVICE = '_ravenry._tcp';
const DNS_SD = '/usr/bin/dns-sd';

// The id the phone matches: the first 12 bytes of the SHA-256 of the pin's
// bytes (the pin is base64url SHA-256 of the key), as base64url: 16
// characters. The Android and iOS apps compute the same (Pins.hubId).
export function hubId(pin) {
  return crypto.createHash('sha256').update(Buffer.from(String(pin), 'base64url')).digest().subarray(0, 12).toString('base64url');
}

// The dns-sd arguments for this pin and port.
export function args(pin, port) {
  const id = hubId(pin);
  return ['-R', `Ravenry ${id.slice(0, 6)}`, SERVICE, 'local', String(port), 'v=1', `id=${id}`];
}

let want = null; // { pin, port } while the advertisement is wanted
let child = null;
let retry = null;
let wait = 2000;

function bin(env = process.env) {
  if ('RAVENRY_NEARBY_BIN' in env) return env.RAVENRY_NEARBY_BIN || null;
  return fs.existsSync(DNS_SD) ? DNS_SD : null;
}

function run() {
  if (!want || child) return;
  const b = bin();
  if (!b) return;
  const a = args(want.pin, want.port);
  const c = spawn(b, a, { stdio: 'ignore' });
  child = c;
  const started = Date.now();
  c.on('error', (e) => { console.error(`nearby: ${e.message}`); });
  c.on('exit', () => {
    if (child === c) child = null;
    if (!want) return;
    // Ran a good while: the next one at once-ish; died quickly: wait longer each time.
    if (Date.now() - started > 60000) wait = 2000;
    clearTimeout(retry);
    retry = setTimeout(() => { retry = null; run(); }, wait);
    retry.unref?.();
    wait = Math.min(wait * 2, 60000);
  });
  console.log(`phone access on: the Mac is advertised on the Wi-Fi as ${SERVICE} (id ${hubId(want.pin)}) on :${want.port}`);
}

// Advertise the phone port (phone access on). `bind`: the phone port's bind
// address (home.mjs hubBind); a test board's 127.0.0.1 is never advertised.
export function start({ pin, port, bind = null, env = process.env }) {
  if (bind || env.RAVENRY_NEARBY === '0') return false;
  if (want && want.pin === pin && want.port === port && child) return true;
  stop(true);
  want = { pin, port };
  wait = 2000;
  run();
  return true;
}

export function stop(quiet = false) {
  const had = !!want;
  want = null;
  clearTimeout(retry); retry = null;
  if (child) { const c = child; child = null; try { c.kill('SIGTERM'); } catch { /* gone */ } }
  if (had && !quiet) console.log('phone access off: the Mac is no longer advertised on the Wi-Fi');
}

export const running = () => !!child;

process.once('exit', () => { if (child) try { child.kill('SIGTERM'); } catch { /* gone */ } });
