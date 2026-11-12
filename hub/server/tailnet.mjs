// Away from home (docs/PHONE.md section 2): Ravenry joins the person's
// Tailscale as a device of its own, "ravenry", with no VPN app on this Mac.
// The device is `ravenryd tailnet` (daemon/internal/tailnet, Tailscale's
// tsnet), a child of this board: it runs only while phone access and the
// Away from home switch are both on and the person signed in, so nothing
// listens on the tailnet otherwise. It passes the owner's own devices to the
// phone port on 127.0.0.1 (TLS end to end: the pin and the device token are
// checked here as on the Wi-Fi) and closes every other caller.
//
// What the phone card shows (card()):
//   off       the switch is off
//   ready     on, not signed in: Sign in with Tailscale
//   starting  the device is starting (from its keys, or for a sign-in)
//   waiting   the sign-in page is open in the person's browser (authURL)
//   on        on the tailnet: name, host (MagicDNS), ips, account
//   offline   signed in, but Tailscale cannot be reached (no internet)
//   failed    the sign-in did not finish; nothing changed
//   paused    signed in, but phone access is off (nothing runs)
//
// Its keys: <RAVENRY_HOME>/tailnet/ (mode 0700). What the device was when it
// last ran (name, host, addresses, account): <RAVENRY_HOME>/tailnet.json
// (mode 0600), which also says it is signed in. Cancel, a failed sign-in and
// Sign out delete both; Sign out first logs the device out, which takes it
// off the tailnet.
//
// MC_TEST_TAILNET_CONTROL=<url> points the device at a test's control server
// (daemon/tools/tailnetlab, http on 127.0.0.1): a test's board only (exit 2
// otherwise, before it listens), and a release of the Mac app run as Node
// quits on it (apps/macos Gate.swift hubTestVars).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RAVENRY_HOME } from './registry.mjs';

export const DIR = path.join(RAVENRY_HOME, 'tailnet');
export const INFO_FILE = path.join(RAVENRY_HOME, 'tailnet.json');
export const SWITCH = 'MC_TEST_TAILNET_CONTROL';
// The sign-in page waits this long for the person, then the sign-in failed.
const SIGNIN_MS = Number(process.env.MC_TAILNET_SIGNIN_MS) > 0 ? Number(process.env.MC_TAILNET_SIGNIN_MS) : 10 * 60 * 1000;

// The control server asked for, or null. Exits 2 when it is set on a board
// whose data is not a test's, or is not http on loopback.
export function controlFrom(env, testData) {
  const v = env[SWITCH];
  if (v === undefined || v === '') return null;
  if (!testData) {
    console.error(`Refused: ${SWITCH} is a test switch (Ravenry would sign in to a test's Tailscale), and this board's data is not a test's. Quitting.`);
    process.exit(2);
  }
  let u = null;
  try { u = new URL(v); } catch { /* below */ }
  if (!u || u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    console.error(`Refused: ${SWITCH}=${JSON.stringify(v)} is not http on this Mac. Quitting.`);
    process.exit(2);
  }
  return v;
}

let cfg = { bin: () => null, forward: 0, control: null, access: () => false, away: () => false, setAway: () => {}, onChange: () => {} };
let child = null;
let signingIn = false;
let state = 'off';
let authURL = null;
let error = null;
let waitTimer = null;
let restartTimer = null;
let refusals = [];
const waiters = new Set();

// bin(): ravenryd's path; forward: the phone port; access(), away(),
// setAway(on): the switches (server/phone.mjs); onChange(): the card
// changed (the board's state goes out again).
export function configure(o) { cfg = { ...cfg, ...o }; }

function info() {
  try {
    const j = JSON.parse(fs.readFileSync(INFO_FILE, 'utf8'));
    return j && typeof j.host === 'string' ? j : null;
  } catch { return null; }
}

function writeInfo(e) {
  const j = { name: e.name || 'ravenry', host: e.host || null, ips: Array.isArray(e.ips) ? e.ips.slice(0, 4) : [], account: e.account || null, at: new Date().toISOString() };
  try {
    fs.mkdirSync(RAVENRY_HOME, { recursive: true });
    const tmp = INFO_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, INFO_FILE);
  } catch (err) { console.error('tailnet.json:', err.message); }
}

// Signed in: the device ran once from the keys it keeps.
export const signedIn = () => !!info() && fs.existsSync(DIR);

function forget() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(INFO_FILE, { force: true });
}

function set(s, extra = {}) {
  const before = `${state}|${authURL}|${error}`;
  state = s;
  if ('authURL' in extra) authURL = extra.authURL;
  if ('error' in extra) error = extra.error;
  if (s !== 'waiting') authURL = null;
  if (s !== 'failed' && !('error' in extra)) error = null;
  for (const w of [...waiters]) w();
  if (before !== `${state}|${authURL}|${error}`) cfg.onChange();
}

function env() {
  const out = {};
  // None of Tailscale's own knobs (TS_AUTHKEY, TS_CONTROL_URL...) from here.
  for (const [k, v] of Object.entries(process.env)) if (!/^(TS_|TSNET_)/.test(k)) out[k] = v;
  return out;
}

function args(extra = []) {
  const a = ['tailnet', '--dir', DIR, '--forward', String(cfg.forward), ...extra];
  if (cfg.control) a.push('--control-url', cfg.control);
  return a;
}

// Starts the device (keys kept in DIR). Its states come as JSON lines.
function start() {
  if (child) return;
  const bin = cfg.bin();
  if (!bin) {
    set(signingIn ? 'failed' : 'offline', { error: 'ravenryd is not installed, so Ravenry cannot join Tailscale.' });
    signingIn = false;
    return;
  }
  clearTimeout(restartTimer);
  const c = spawn(bin, args(), { stdio: ['pipe', 'pipe', 'pipe'], env: env() });
  child = c;
  if (state !== 'waiting') set('starting');
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let e = null;
      try { e = JSON.parse(line); } catch { continue; }
      if (c === child) event(e);
    }
  });
  let ebuf = '';
  c.stderr.on('data', (d) => {
    ebuf += d;
    let i;
    while ((i = ebuf.indexOf('\n')) >= 0) { console.log(ebuf.slice(0, i)); ebuf = ebuf.slice(i + 1); }
  });
  c.stdin.on('error', () => {});
  c.on('error', (err) => console.error(`tailnet: ${err.message}`));
  c.on('exit', (code, sig) => {
    if (c !== child) return;
    child = null;
    console.log(`tailnet: the device stopped (${sig || `exit ${code}`})`);
    if (signingIn) { failSignIn('The sign-in did not finish, so nothing changed.'); return; }
    // Still wanted: again in a few seconds.
    if (wanted()) { set('offline'); restartTimer = setTimeout(sync, 3000); }
  });
}

function stop() {
  clearTimeout(restartTimer);
  const c = child;
  child = null;
  if (!c) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 4000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    // The end of its input: off the tailnet for now, its keys kept.
    try { c.stdin.end(); } catch { /* gone */ }
    try { c.kill('SIGTERM'); } catch { /* gone */ }
  });
}

function event(e) {
  if (e.refused) {
    refusals = [{ from: e.refused.from, why: e.refused.why, at: new Date().toISOString() }, ...refusals].slice(0, 20);
    console.log(`tailnet: refused ${e.refused.from}: ${e.refused.why}`);
    return;
  }
  switch (e.state) {
    case 'needs-login':
      if (signingIn) {
        clearTimeout(waitTimer);
        waitTimer = setTimeout(() => failSignIn('The sign-in did not finish, so nothing changed.'), SIGNIN_MS);
        set('waiting', { authURL: e.authURL || null });
      } else {
        // Its keys no longer count (signed out in Tailscale, or expired):
        // signed out here too; the card asks to sign in again.
        console.log('tailnet: Tailscale asks to sign in again; the keys are dropped');
        void stop().then(() => { forget(); set(cfg.away() ? 'ready' : 'off'); });
      }
      break;
    case 'running':
      clearTimeout(waitTimer);
      signingIn = false;
      writeInfo(e);
      console.log(`tailnet: on the tailnet as ${e.host || e.name}`);
      set('on');
      break;
    case 'offline':
      if (e.host) writeInfo(e);
      set('offline');
      break;
    case 'error':
      console.error(`tailnet: ${e.error || 'error'}`);
      if (signingIn) failSignIn('The sign-in did not finish, so nothing changed.');
      break;
    default:
      break;
  }
}

function failSignIn(why) {
  clearTimeout(waitTimer);
  signingIn = false;
  void stop().then(() => {
    // Nothing changed: no device, no keys.
    if (!info()) fs.rmSync(DIR, { recursive: true, force: true });
    set('failed', { error: why });
  });
}

// Whether the device should run now.
const wanted = () => cfg.access() && cfg.away() && (signingIn || signedIn());

// Follows the switches: the device runs while it is wanted, else not.
export function sync() {
  if (wanted()) {
    if (!child) start();
    return;
  }
  if (signingIn) { signingIn = false; clearTimeout(waitTimer); fs.rmSync(DIR, { recursive: true, force: true }); }
  if (child) void stop();
  // Off; signed in but phone access off (paused); else ready to sign in,
  // or still saying the last sign-in failed.
  if (!cfg.away()) set('off');
  else if (signedIn()) set('paused');
  else set(state === 'failed' ? 'failed' : 'ready', state === 'failed' ? { error } : {});
}

// The switch.
export function setOn(on) {
  cfg.setAway(!!on);
  if (!on && state === 'failed') set('off');
  if (on && !signedIn()) set('ready');
  sync();
}

function until(ok, ms) {
  return new Promise((resolve) => {
    const done = () => { if (ok()) { waiters.delete(done); clearTimeout(t); resolve(true); } };
    const t = setTimeout(() => { waiters.delete(done); resolve(false); }, ms);
    waiters.add(done);
    done();
  });
}

// Sign in with Tailscale: starts the device for a sign-in and resolves once
// its sign-in page is known (state waiting, authURL), or it is on. { ok,
// status, error }.
export async function signIn() {
  if (!cfg.access()) return { ok: false, status: 409, error: 'Phone access is off. Turn it on first.' };
  if (!cfg.away()) cfg.setAway(true);
  if (signedIn()) { sync(); return { ok: true }; }
  if (signingIn && authURL) return { ok: true };
  await stop();
  signingIn = true;
  set('starting');
  start();
  const ok = await until(() => state === 'waiting' || state === 'on' || state === 'failed', 30000);
  if (!ok) failSignIn('The sign-in did not finish, so nothing changed.');
  if (state === 'failed') return { ok: false, status: 502, error: error || 'The sign-in did not finish, so nothing changed.' };
  return { ok: true };
}

// Cancel: the sign-in stops and nothing is kept.
export async function cancel() {
  signingIn = false;
  clearTimeout(waitTimer);
  if (!signedIn()) {
    await stop();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  set(cfg.away() ? 'ready' : 'off');
  sync();
}

// Sign out: the device logs out (Tailscale takes it off the tailnet), its
// keys are deleted and the switch goes off. { ok, removed }: removed is
// false when Tailscale could not be reached (the device then stays listed
// in the tailnet's admin page until it is removed there).
export async function signOut() {
  signingIn = false;
  clearTimeout(waitTimer);
  await stop();
  let removed = true;
  const bin = cfg.bin();
  if (bin && fs.existsSync(DIR)) {
    removed = await new Promise((resolve) => {
      const c = spawn(bin, args(['--logout']), { stdio: ['ignore', 'pipe', 'pipe'], env: env() });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l) console.log(l); });
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 25000);
      c.on('error', () => { clearTimeout(t); resolve(false); });
      c.on('exit', () => {
        clearTimeout(t);
        const last = out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).pop();
        resolve(!!(last && last.state === 'signed-out' && last.removed));
      });
    });
  }
  forget();
  cfg.setAway(false);
  console.log(`tailnet: signed out${removed ? '' : ' here; Tailscale could not be reached to take the device off the tailnet'}`);
  set('off');
  return { ok: true, removed };
}

// The hosts a phone tries away from home, in order: the device's MagicDNS
// name, then its Tailscale IPv4 address. Only while it runs.
export function hosts() {
  if (state !== 'on' && state !== 'offline') return [];
  const i = info();
  if (!i) return [];
  return [i.host, ...(i.ips || []).filter((a) => a.includes('.'))].filter(Boolean);
}

// The card's part (Mac only): the switch, the state and what the device is.
export function card() {
  const i = info();
  const out = { on: cfg.away(), state, name: i ? i.name : null, host: i ? i.host : null, ips: i ? i.ips : [], account: i ? i.account : null };
  if (state === 'waiting' && authURL) out.authURL = authURL;
  if (error) out.error = error;
  if (!(state === 'on' || state === 'offline' || state === 'paused')) { out.name = null; out.host = null; out.ips = []; out.account = null; }
  out.listening = !!child && state === 'on';
  out.refused = refusals.length;
  return out;
}

// For a test: the device's process, or null.
export const running = () => (child ? { pid: child.pid } : null);

// The board is going away: the device too (its keys kept).
export function shutdown() { if (child) { try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* gone */ } } }
