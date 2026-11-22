// Alerts to the phones (docs/PHONE.md sections 4 and 5).
//
// Each device may have one push target. A paired app sets its own:
// `unifiedpush` (Android: any UnifiedPush distributor, such as ntfy),
// `apns` (the iPhone and iPad app: through a Ravenry relay to Apple's push
// service, relay/), `fcm` (designed; refused until built) or `none`. An iPhone with no Ravenry app yet gets `ntfy` from its setup
// (server/alerts.mjs): a device record with no sign-in, alerted through
// the ntfy iPhone app on its own topic. Sending picks the transport by the
// target's kind (SENDERS), so the trigger, the dedupe and the cooldown are
// the same for every phone.
//
// An app's body is encrypted for that device with Web Push message
// encryption (RFC 8291, aes128gcm, RFC 8188), with the device's own P-256
// key and auth secret, so the distributor, the relay or Apple sees only
// ciphertext.
// It carries the question, the command and the agent's words, with the
// buttons that answer it from the shade. ntfy carries text in clear, so an
// iPhone through ntfy gets only the title and the fixed `line` of the same
// message (server/alertwords.mjs), never the body. The same messages reach
// each app's live event stream (`event: phone`, through `onLive`), so an
// app that holds its connection shows them without push.
//
// What triggers one (server/alerts.mjs calls in): a checkpoint that opened
// (fromCheckpoint), a project that moved into Needs you (fromProject, the
// app's own trigger in alerts.mjs), and a test. `close` takes an alert off
// the phone: the checkpoint closed (syncCheckpoints) or the session left
// Needs you (syncProjects).

import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import * as phone from './phone.mjs';
import { isLoopbackAddr, isPrivateV4Addr, isTailscaleAddr, isUlaAddr } from './phonetls.mjs';
import { sayFolder } from './homes.mjs';
import { keyLine, keyParts } from '../public/keys.mjs';
import { CHANNELS } from './channels.mjs';
import { KINDS as WORDS, CHECKPOINT_LINES } from './alertwords.mjs';
import * as assistants from './assistants.mjs';

const env = process.env;
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const RETRY_MS = num(env.MC_PUSH_RETRY_MS, 30 * 1000);
const TIMEOUT_MS = 10000;
const CAP = 3000;
// An APNs payload is at most 4096 bytes, the sealed body in base64url with
// the relay's fixed JSON around it: the relay takes 2900 sealed bytes, so
// the message is at most 2780 (2780 + 1 + 16 + 86 of header and key + tag).
const APNS_CAP = 2780;
const RS = 4096;
// The relay for an iPhone app that names none (docs/PHONE.md section 4,
// "apns"): RAVENRY_APNS_RELAY, else none. The app's build names its relay
// (the one that holds the APNs key for that app), so this is for a hub
// that must use another one.
const RELAY = () => String(env.RAVENRY_APNS_RELAY || '').trim().replace(/\/+$/, '');

// ------------------------------------------------------------ RFC 8291

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Encrypts `plaintext` for a user agent's `p256dh` (65 bytes, uncompressed
// P-256) and `auth` (16 bytes). `as` (an ECDH of P-256 with its keys) and
// `salt` are for known-answer tests only. Returns the aes128gcm body:
// salt(16) | rs(4) | idlen(1) | keyid (the sender's public key, 65) | record.
export function encrypt(plaintext, p256dh, auth, { as = null, salt = null } = {}) {
  const ua = Buffer.from(p256dh);
  const secret = Buffer.from(auth);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error('p256dh is not an uncompressed P-256 key');
  if (secret.length !== 16) throw new Error('auth is not 16 bytes');
  const e = as || (() => { const x = crypto.createECDH('prime256v1'); x.generateKeys(); return x; })();
  const asPub = e.getPublicKey();
  const ecdh = e.computeSecret(ua);
  const s = salt ? Buffer.from(salt) : crypto.randomBytes(16);
  // RFC 8291 section 3.4.
  const prkKey = hmac(secret, ecdh);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  // RFC 8188 section 2.2 and 2.3.
  const prk = hmac(s, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (data.length + 16 > RS) throw new Error('too long for one record');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const rec = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  s.copy(head, 0);
  head.writeUInt32BE(RS, 16);
  head[20] = asPub.length;
  return Buffer.concat([head, asPub, rec]);
}

// ------------------------------------------------------------ targets

const KINDS = new Set(['unifiedpush', 'apns', 'fcm', 'none']);

// https to anywhere. http only to an address written as a number on this
// computer, the home network (10/8, 172.16/12, 192.168/16, IPv6 fc00::/7)
// or Tailscale (100.64/10): a self-hosted distributor, such as ntfy on a
// computer at home, is often plain http there, and every body is
// encrypted for the phone anyway (RFC 8291). A host name is never taken
// over http, since what it points to can change; nor a public address.
export function endpointOk(u) {
  let x;
  try { x = new URL(String(u || '')); } catch { return false; }
  if (x.username || x.password) return false;
  if (x.protocol === 'https:') return true;
  if (x.protocol !== 'http:') return false;
  const h = x.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (!net.isIP(h)) return false;
  return isLoopbackAddr(h) || isPrivateV4Addr(h) || isTailscaleAddr(h) || isUlaAddr(h);
}

// A device's push target, checked: { ok, target } or { ok: false, status, error }.
export function checkTarget(b) {
  const body = b && typeof b === 'object' ? b : {};
  const kind = String(body.kind || '');
  if (!KINDS.has(kind)) return { ok: false, status: 400, error: 'Unknown push kind. This hub knows unifiedpush, apns and none.' };
  if (kind === 'none') return { ok: true, target: null };
  if (kind !== 'unifiedpush' && kind !== 'apns') return { ok: false, status: 400, error: `Push through ${kind} is not built yet. Use unifiedpush, apns, or none.` };
  const p = unb64u(body.p256dh), a = unb64u(body.auth);
  const keys = () => {
    if (p.length !== 65 || p[0] !== 4) return 'p256dh is not an uncompressed P-256 public key in base64url.';
    if (a.length !== 16) return 'auth is not 16 bytes in base64url.';
    return null;
  };
  if (kind === 'apns') {
    // The iPhone and iPad app: its APNs device token, the relay that holds
    // the key for its build, and which APNs it registered with (a debug
    // build: sandbox; TestFlight and the App Store: production).
    const relay = String(body.relay || RELAY()).trim().replace(/\/+$/, '');
    if (!relay) return { ok: false, status: 400, error: 'Which relay? Send relay (https://...), or set RAVENRY_APNS_RELAY on this Mac.' };
    if (!endpointOk(relay) || /[?#]/.test(relay)) return { ok: false, status: 400, error: 'The relay must be https (or http to an address on this computer, the home network or Tailscale), with no query.' };
    const token = String(body.token || '').toLowerCase();
    if (!/^[0-9a-f]{64,200}$/.test(token)) return { ok: false, status: 400, error: 'token is not an APNs device token (hex).' };
    const environment = body.environment == null ? 'production' : String(body.environment);
    if (environment !== 'production' && environment !== 'sandbox') return { ok: false, status: 400, error: 'environment is production or sandbox.' };
    const e = keys();
    if (e) return { ok: false, status: 400, error: e };
    return { ok: true, target: { kind, relay, token, environment, p256dh: b64u(p), auth: b64u(a), at: new Date().toISOString() } };
  }
  if (!endpointOk(body.endpoint)) return { ok: false, status: 400, error: 'The endpoint must be https, or http to an address on this computer, the home network or Tailscale (such as http://192.168.1.20:8080/...).' };
  const e = keys();
  if (e) return { ok: false, status: 400, error: e };
  return { ok: true, target: { kind, endpoint: String(body.endpoint), p256dh: b64u(p), auth: b64u(a), at: new Date().toISOString() } };
}

// The words of the last line an iPhone's old ntfy topic gets, when the
// Ravenry app takes its alerts over (fixed words: ntfy carries them in clear).
export const MOVED_LINE = 'Alerts for this iPhone now come from the Ravenry app. You can delete ntfy.';

// Sets a device's push target (checked by checkTarget) from the app. An
// iPhone that got its alerts through ntfy and now has the app's own (the
// takeover, docs/PHONE.md section 4) keeps the ntfy target in `push.was`,
// with `moved` (when), and its old topic gets one last line; from then on
// alerts go through the app only. A new token for the same app keeps both.
// Resolves { ok, moved }.
export async function setTarget(id, target) {
  const rec = phone.deviceRecord(id);
  if (!rec) return { ok: false };
  const old = rec.push || null;
  let farewell = null;
  if (target && target.kind === 'apns') {
    if (old && old.kind === 'ntfy' && old.confirmed) {
      target.was = { ...old };
      target.moved = target.at;
      farewell = old;
    } else if (old && old.kind === 'apns' && old.was) {
      target.was = old.was;
      if (old.moved) target.moved = old.moved;
    } else if (!old && rec.gone && rec.gone.was) {
      // The app back after Apple said it was gone: its ntfy target stays the one to go back to.
      target.was = rec.gone.was;
    }
  }
  phone.updateRecord(id, (t) => { t.push = target || null; delete t.gone; });
  if (farewell) {
    const r = await CHANNELS.ntfy.send({ test: false, title: 'Ravenry', body: MOVED_LINE, url: null }, { server: farewell.server, topic: farewell.topic }).catch(() => ({ ok: false }));
    console.log(`push: ${rec.name} moved from ntfy to the Ravenry app${r.ok ? '' : ' (the last ntfy line did not go)'}`);
  }
  return { ok: true, moved: !!farewell };
}

// Use ntfy again: an iPhone whose app Apple said is gone gets its alerts
// through its old ntfy topic again (docs/PHONE.md section 4). There is no
// silent fall back: the person asks for it on the Mac.
export function ntfyAgain(id) {
  const rec = phone.deviceRecord(id);
  if (!rec || !rec.gone || !rec.gone.was) return false;
  phone.updateRecord(id, (t) => { t.push = { ...t.gone.was }; delete t.gone; });
  return true;
}

// ------------------------------------------------------------ live streams

let live = () => {};
// `fn(deviceId, message)` writes to that device's open event streams.
export function onLive(fn) { live = fn; }

// ------------------------------------------------------------ sending

const timers = new Set();
export const last = { at: null, ok: null, error: null };
// device id -> { at, ok, error } of its last send (the phones list's line).
const lastBy = new Map();

async function post(t, body) {
  try {
    const r = await fetch(t.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' }, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    await r.arrayBuffer().catch(() => null);
    return { ok: r.ok, status: r.status, error: r.ok ? null : `the endpoint answered ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.cause && e.cause.code) || (e && e.name) || 'error' };
  }
}

// Apple said the app is gone from this device (410 from the relay): the
// target is dropped, and the row says so, with Use ntfy again when it came
// from ntfy (`gone.was`). No alert goes to ntfy by itself: the person was
// told ntfy could go.
function appGone(dev, status) {
  phone.updateRecord(dev.id, (t) => { t.gone = { at: new Date().toISOString(), was: (t.push && t.push.was) || null }; t.push = null; });
  console.log(`push: Apple says the Ravenry app is gone from ${dev.name} (${status}); dropped`);
}

// The iPhone and iPad app through the relay to APNs: the whole message,
// sealed for the device as Android's is (the relay and Apple see only
// ciphertext), at most APNS_CAP bytes; the app's Notification Service
// Extension opens it and draws the alert. A close goes as a silent
// background push: the app takes that alert off. `collapse` (a hash of the
// alert's id, nothing readable) makes a resent alert replace the first.
async function sendApns(dev, msg) {
  const t = dev.push;
  let body;
  try {
    let m = msg.type === 'close' ? msg : capped(JSON.parse(JSON.stringify(msg)), APNS_CAP);
    // Still too long (a pick's many variants): what the alert needs, the rest in the app.
    if (Buffer.byteLength(JSON.stringify(m)) > APNS_CAP) {
      const cp = m.checkpoint ? { id: m.checkpoint.id, kind: m.checkpoint.kind, expires_at: m.checkpoint.expires_at || null } : null;
      m = capped({ v: m.v, type: m.type, id: m.id, at: m.at, kind: m.kind, title: m.title, body: m.body, detail: m.detail, line: m.line, project: m.project, machine: m.machine, session: m.session, checkpoint: cp, decision: m.decision, actions: [{ id: 'open', label: 'Open' }], reply: null }, APNS_CAP);
    }
    body = encrypt(Buffer.from(JSON.stringify(m)), unb64u(t.p256dh), unb64u(t.auth));
  } catch (e) { return { ok: false, final: true, error: e.message }; }
  const close = msg.type === 'close';
  const req = { token: t.token, environment: t.environment || 'production', ttl: 3600, push: close ? 'background' : 'alert', body: b64u(body) };
  if (!close && msg.id) req.collapse = crypto.createHash('sha256').update(String(msg.id)).digest('base64url').slice(0, 22);
  let r;
  try {
    const res = await fetch(`${t.relay}/v1/apns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    let j = null;
    try { j = await res.json(); } catch { /* no JSON */ }
    const why = j && (j.reason || j.error);
    r = { ok: res.ok, status: res.status, error: res.ok ? null : `the relay answered ${res.status}${why ? ` (${String(why).slice(0, 80)})` : ''}` };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.cause && e.cause.code) || (e && e.name) || 'error' };
  }
  if (r.status === 410) { appGone(dev, r.status); return { ...r, final: true }; }
  // A token APNs refuses, or a request the relay refuses: trying again changes nothing.
  if (r.status === 400 || r.status === 413) return { ...r, final: true };
  return r;
}

// An app through UnifiedPush: the whole message, encrypted for it.
async function sendUnifiedPush(dev, msg) {
  const t = dev.push;
  let body;
  try { body = encrypt(Buffer.from(JSON.stringify(msg)), unb64u(t.p256dh), unb64u(t.auth)); } catch (e) { return { ok: false, final: true, error: e.message }; }
  const r = await post(t, body);
  if (!r.ok && (r.status === 404 || r.status === 410)) {
    // The distributor forgot this endpoint: the device sets a new one.
    phone.setPush(dev.id, null);
    console.log(`push: ${dev.name}'s endpoint is gone (${r.status}); dropped`);
    return { ...r, final: true };
  }
  return r;
}

// What a transport that carries text in clear may be sent: an alert's
// title and its fixed line (never a decision: its only use is Undo), and a
// test. Never a close: ntfy cannot take a notification back on iOS.
export const clearOk = (msg) => msg && (msg.type === 'test' || (msg.type === 'alert' && msg.kind !== 'decision' && typeof msg.line === 'string' && !!msg.line));

// The JSON an iPhone's ntfy topic is sent (the ntfy channel's own publish,
// server/channels.mjs): the title as the app's, the line, the board's
// session link to open, priority 4 (a test 3).
export function ntfyAlert(msg, click) {
  return { test: msg.type === 'test', title: String(msg.title || ''), body: String(msg.line || ''), url: click || null };
}

// An iPhone through ntfy: the title and the line, in clear, on its own topic.
async function sendNtfy(dev, msg, { click = null } = {}) {
  const t = dev.push;
  const r = await CHANNELS.ntfy.send(ntfyAlert(msg, click), { server: t.server, topic: t.topic });
  return { ok: r.ok, status: 0, error: r.ok ? null : r.error };
}

// The transports, by the push target's kind (docs/PHONE.md section 4).
// One more kind (`fcm`) is one more entry: the device record, the trigger,
// the dedupe and the cooldown stay as they are. The ntfy target the iPhone
// app's own replaced waits in `push.was` (the takeover, docs/PHONE.md
// section 4).
//   transport: what the phones list says it gets alerts through ('app', 'ntfy');
//   clear: the message travels in clear, so only what clearOk() allows goes.
export const SENDERS = {
  unifiedpush: { transport: 'app', clear: false, send: sendUnifiedPush },
  apns: { transport: 'app', clear: false, send: sendApns },
  ntfy: { transport: 'ntfy', clear: true, send: sendNtfy },
};

// What a device gets its alerts through, for the phones list: an app
// (its own push, or the connection it holds), else its transport's.
export function transportOf(rec) {
  const s = rec && rec.push && SENDERS[rec.push.kind];
  if (s) return s.transport;
  return rec && rec.hash ? 'app' : null;
}

function note(dev, r) {
  const at = new Date().toISOString();
  last.at = at;
  last.ok = r.ok;
  last.error = r.ok ? null : r.error || 'no answer';
  lastBy.set(dev.id, { at, ok: r.ok, error: last.error });
}

// One device's push. Resolves { ok, error } (skipped: { ok: true, skipped }).
async function pushTo(dev, msg, opts = {}, attempt = 1) {
  const t = dev.push;
  const s = t && SENDERS[t.kind];
  if (!s) return { ok: true, skipped: true };
  if (s.clear && !clearOk(msg)) return { ok: true, skipped: true };
  let r;
  try { r = await s.send(dev, msg, opts); } catch (e) { r = { ok: false, error: e.message }; }
  note(dev, r);
  if (r.ok || r.final) return r;
  console.log(`push: ${dev.name}: ${r.error}${attempt === 1 && opts.retry !== false ? `; trying again in ${Math.round(RETRY_MS / 1000)} s` : ''}`);
  if (attempt === 1 && opts.retry !== false) {
    const tm = setTimeout(() => { timers.delete(tm); const d = phone.deviceRecord(dev.id); if (d && d.push) pushTo(d, msg, opts, 2); }, RETRY_MS);
    if (tm.unref) tm.unref();
    timers.add(tm);
  }
  return r;
}

// Sends a message to every device alerts reach: an app's push target and
// live streams, an iPhone's ntfy topic. `opts.click` is the board's link
// for the alert (a clear transport opens it on a tap).
export function send(msg, opts = {}) {
  const devs = phone.alertRecords();
  for (const d of devs) {
    if (d.hash) { try { live(d.id, msg); } catch { /* a stream that went */ } }
    if (d.push) pushTo(d, msg, opts).catch((e) => console.error('push:', e.message));
  }
  return devs.length;
}

// One device only, whatever its state (a phone's Send a test, an iPhone's
// setup before it is confirmed): its live streams and its push, once, no
// retry. Resolves { ok, error, held } (held: an app with no push target,
// reached on its connection only).
export async function sendTo(id, msg, opts = {}) {
  const d = phone.deviceRecord(id);
  if (!d) return { ok: false, error: 'No such phone.' };
  if (d.hash) { try { live(d.id, msg); } catch { /* a stream that went */ } }
  if (!d.push || !SENDERS[d.push.kind]) return { ok: true, held: true };
  return pushTo(d, msg, { ...opts, retry: false });
}

// The devices alerts reach, for the phones list: { id, name, platform,
// transport, last, moved, gone, ntfyBack } (no topic, token, endpoint or
// key). `moved`: when the iPhone app took the alerts over from ntfy;
// `gone`: when Apple said the app is gone from the device (no alerts
// since), `ntfyBack` whether Use ntfy again can bring the old topic back.
export const phones = () => phone.alertRecords().map((d) => ({
  id: d.id, name: d.name || 'A phone', platform: d.platform || null, form: phone.formOf(d), transport: transportOf(d), last: lastBy.get(d.id) || null,
  moved: (d.push && d.push.kind === 'apns' && d.push.moved) || null, gone: (d.gone && d.gone.at) || null, ntfyBack: !!(d.gone && d.gone.was),
}));

// The apps' names, for the board's alerts section and older clients (the
// phones that get alerts through the Ravenry app; `phones` has them all).
export const appNames = () => phones().filter((d) => d.transport === 'app').map((d) => d.name);

// Whether any device gets alerts (the phones' trigger runs only then).
export const ready = () => phone.alertRecords().length > 0;

// ------------------------------------------------------------ messages (section 5)

const who = (a) => assistants.chipOf(String(a || '').toLowerCase()) || 'The agent';
// A message's session with its assistant's word from the registry
// (`assistantName`: "Claude"), so an app draws it without a list of its own.
const withName = (x) => { const n = assistants.chipOf(String(x.assistant || '').toLowerCase()); return n ? { ...x, assistantName: n } : x; };
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, Math.max(0, n - 3)) + '...' : t; };
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Keeps a message within `cap` bytes, cutting its longest texts first.
export function capped(msg, cap = CAP) {
  const size = () => Buffer.byteLength(JSON.stringify(msg));
  let n = 1000;
  while (size() > cap && n > 20) {
    for (const k of ['detail', 'body', 'command', 'title']) if (typeof msg[k] === 'string') msg[k] = clip(msg[k], n);
    if (msg.checkpoint && typeof msg.checkpoint.command === 'string') msg.checkpoint.command = clip(msg.checkpoint.command, n);
    for (const a of msg.actions || []) a.label = clip(a.label, Math.max(12, Math.floor(n / 4)));
    n = Math.floor(n * 0.7);
  }
  return msg;
}

// At most three buttons: when there are more answers than fit, the first
// ones and Open.
function fit(answers, room) {
  if (answers.length <= room) return answers;
  return [...answers.slice(0, room - 1), { id: 'open', label: 'Open' }];
}

const sessionOf = (project, pane) => {
  if (!project || !pane) return null;
  return (project.sessions || []).find((s) => s.surfaceId === `ravenry:${pane}`) || null;
};

// The program a command runs, past npx, sudo and the like: "wrangler".
export function program(command) {
  const words = String(command || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && /^(?:npx|bunx|sudo|env|exec|command|pnpm|yarn)$/.test(words[0])) words.shift();
  if (words.length > 1 && words[0] === 'dlx') words.shift();
  return words[0] || null;
}

// A checkpoint's alert.
export function checkpointMessage(cp, { project = null, machine = null, paneName = null, askerName = null } = {}) {
  const s = sessionOf(project, cp.pane);
  const topic = (s && s.topic) || null;
  // Where it asks from, as the person knows it: the project, never the
  // session's own name (2026-11-13: a session's name or id is never shown).
  // A drive from a pane that is in no project: that tab's name.
  const place = project ? project.name : (cp.kind === 'drive' && askerName ? clip(String(askerName), 80) : null);
  const name = place || who(cp.assistant);
  const mac = phone.sayMac(machine) || phone.hubName();
  const [head, ...rest] = String(cp.title || '').replace(/\r/g, '').trim().split('\n');
  const more = rest.join('\n').trim();
  const until = cp.expires_at ? ` waits until ${hhmm(cp.expires_at)}.` : ' waits for you.';
  const msg = {
    v: 1, type: 'alert', id: `cp:${cp.id}`, at: cp.created_at || new Date().toISOString(), kind: cp.kind,
    title: '', body: head || '', detail: null, line: CHECKPOINT_LINES.answer,
    project: project ? { id: project.id, name: project.name } : null,
    machine: machine || null,
    session: s ? withName({ surfaceId: s.surfaceId, topic, assistant: s.assistant || cp.assistant || null }) : (cp.pane ? withName({ surfaceId: `ravenry:${cp.pane}`, topic: null, assistant: cp.assistant || null }) : null),
    checkpoint: { id: cp.id, kind: cp.kind, expires_at: cp.expires_at || null },
    actions: [], reply: null,
  };
  if (cp.kind === 'ask') {
    msg.title = `${name} asks`;
    msg.detail = more || `${who(cp.assistant)}${until}`;
    const opts = (Array.isArray(cp.options) ? cp.options : []).map((o, i) => ({ id: `choice:${i}`, label: String(o) }));
    msg.actions = fit(opts, cp.free_text ? 2 : 3);
    if (cp.free_text) msg.reply = { action: 'text', label: 'Answer', hint: 'Answer in your own words' };
    if (!msg.actions.length && !msg.reply) msg.actions = [{ id: 'open', label: 'Open' }];
  } else if (cp.kind === 'approve') {
    msg.title = `${name} wants to run a command`;
    msg.line = CHECKPOINT_LINES.approve(mac);
    msg.body = String(cp.command || '');
    msg.detail = `on ${mac}${cp.cwd ? `, in ${sayFolder(cp.cwd, machine)}` : ''}`;
    msg.checkpoint.command = String(cp.command || '');
    msg.checkpoint.cwd = cp.cwd || null;
    if (cp.warning) msg.checkpoint.warning = clip(cp.warning, 300);
    msg.actions = [{ id: 'run', label: 'Run', biometric: true }, { id: 'refuse', label: 'Refuse' }, { id: 'open', label: 'Open' }];
  } else if (cp.kind === 'secret') {
    msg.title = `${who(cp.assistant)} needs a secret${place ? ` for ${place}` : ''}`;
    msg.line = CHECKPOINT_LINES.secret;
    const to = cp.secret && cp.secret.to;
    const prog = cp.command ? program(cp.command) : null;
    msg.detail = `${prog && to !== 'input' ? `for ${prog} ` : ''}on ${mac}. Type it in the app.`;
    msg.actions = [{ id: 'open', label: 'Type it' }, { id: 'decline', label: 'Not now' }];
    msg.reply = null;
  } else if (cp.kind === 'drive') {
    // An agent asks to type into a pane it did not start. Allowing it is as
    // strong as running a command there, so it takes a fingerprint, like
    // Run. The asker is named by its project (never its session's name);
    // the pane it would act on as the sidebar names it (`paneName`), never
    // by ids; the daemon's own title only when the pane is not known.
    const d = cp.drive || {};
    const asker = `${who(cp.assistant)}${place ? `, in ${place},` : ''}`;
    const pn = paneName ? clip(String(paneName), 80) : null;
    const what = { close: `close ${pn}`, restart: `restart ${pn}`, override: `change how ${pn} runs` }[d.action] || `type in ${pn}`;
    // Fixed words when the tab is not known: never the agent's own title.
    msg.title = pn ? `${asker} wants to ${what}` : `${who(cp.assistant)} wants to use another tab`;
    const reason = typeof d.reason === 'string' && d.reason.trim() ? clip(d.reason.replace(/\s*\n\s*/g, ' ').trim(), 300) : null;
    // What it would type, with its keys as people read them ("[Ctrl C] npm
    // run dev [Enter]", public/keys.mjs), never as tokens; the parts go
    // along so the app draws the keys as chips.
    const input = d.input ? clip(String(d.input), 300) : null;
    const typed = input ? keyLine(input) : null;
    msg.body = reason ? `${who(cp.assistant)} says: ${reason}` : (typed || '');
    msg.detail = reason && typed ? `It would type: ${typed}` : `on ${mac}`;
    msg.checkpoint.drive = { pane: d.pane || null, action: d.action || 'input', name: pn, session: place, ...(reason ? { reason } : {}), ...(input ? { keys: keyParts(input) } : {}) };
    msg.actions = [{ id: 'allow:once', label: 'Allow once', biometric: true }, { id: 'allow:session', label: 'This session', biometric: true }, { id: 'refuse', label: 'Refuse' }];
  } else if (cp.kind === 'pick') {
    // Pictures to choose from. The shade picks a variant by its label; the
    // region and the note ("this, but...") are in the app. Each variant's
    // file is GET /api/checkpoints/<id>/variants/<n> with the device token.
    const vs = Array.isArray(cp.variants) ? cp.variants : [];
    msg.title = `${name} wants you to pick`;
    msg.detail = `${vs.length} variants.`;
    msg.checkpoint.variants = vs.map((v, i) => ({ label: String(v.label || ''), type: v.type === 'html' || v.type === 'video' ? v.type : 'image', ...(typeof v.description === 'string' && v.description ? { description: clip(v.description, 200) } : {}), url: `/api/checkpoints/${encodeURIComponent(cp.id)}/variants/${i}` }));
    msg.actions = fit(vs.map((v, i) => ({ id: `pick:${i}`, label: String(v.label || '') })), 3);
  } else {
    msg.title = `${name} waits for you`;
    msg.actions = [{ id: 'open', label: 'Open' }];
  }
  return capped(msg);
}

// A project's alert, from the app's trigger (alerts.mjs): `alert` is the
// trigger's ({ kind, projectId, project, ... }), `p` the project as the
// board shows it.
export function projectMessage(alert, p) {
  const s = (p.sessions || []).find((x) => x.surfaceId === p.primary) || null;
  const w = (s && s.words) || {};
  const topic = (s && s.topic) || null;
  // The project names it, never the session (its name is not shown).
  const name = p.name;
  const kind = alert.kind;
  const id = kind === 'gate'
    ? `gate:${crypto.createHash('sha256').update(String(alert.gateKey || '')).digest('base64url').slice(0, 16)}`
    : `s:${p.id}:${s ? s.surfaceId : ''}:${(s && s.since) || ''}`;
  const quick = (Array.isArray(p.quick) ? p.quick : Array.isArray(w.quick) ? w.quick : []).map((o, k) => (o && o.choice != null ? { id: `quick:${o.choice}`, label: String(o.label) } : { id: `quick:${k}`, label: String(o && o.label), text: String((o && o.text) || (o && o.label)) }));
  const question = p.question || w.question || null;
  const head = p.headline || w.headline || null;
  const msg = {
    v: 1, type: 'alert', id, at: new Date().toISOString(), kind,
    title: `${name} needs you`, body: '', detail: null, line: WORDS[kind] || null,
    project: { id: p.id, name: p.name }, machine: p.machine || (s && s.machine) || null,
    session: s ? withName({ surfaceId: s.surfaceId, topic, assistant: s.assistant || null }) : null,
    checkpoint: null, actions: [], reply: null,
  };
  if (kind === 'permission') {
    msg.body = question || head || 'Waiting for permission';
    msg.detail = head && head !== msg.body ? head : null;
    msg.actions = quick.length ? fit(quick, 3) : [{ id: 'open', label: 'Open' }];
  } else if (kind === 'question') {
    msg.body = question || head || 'Asked you a question';
    msg.detail = head && head !== msg.body ? head : null;
    // Its first two answers beside Reply (an alert has room for three; a
    // tap on the alert opens it, so no Open), a press types the answer's text.
    msg.actions = quick.length ? quick.slice(0, 2) : [{ id: 'open', label: 'Open' }];
    if (s) msg.reply = { action: 'send', label: 'Reply', hint: `Reply to ${who(s.assistant)}` };
  } else if (kind === 'handback') {
    msg.body = head || p.line || 'Handed back';
    msg.actions = [{ id: 'open', label: 'Open' }];
    if (s) msg.reply = { action: 'send', label: 'Reply', hint: `Reply to ${who(s.assistant)}` };
  } else if (kind === 'program') {
    // A plain program that waits (SESS-056): the fixed words of what it
    // waits for (alert.body, server/alertwords.mjs PROGRAM_KINDS), never
    // its own message or its command line; a tap opens it on the board.
    msg.body = alert.body || 'Waits for you';
    msg.line = msg.body;
    msg.session = s ? { surfaceId: s.surfaceId, topic: null, assistant: null } : null;
    msg.actions = [{ id: 'open', label: 'Open' }];
  } else if (kind === 'gate') {
    msg.title = `${p.name}: plan gate`;
    msg.body = (p.planGate && (p.planGate.question || p.planGate.short)) || 'A plan waits at a gate';
    // The line travels in clear (an iPhone through ntfy): the kind's fixed
    // words, never the plan's question, short or long.
    msg.line = WORDS.gate;
    msg.actions = [{ id: 'open', label: 'Open' }];
  } else {
    msg.body = alert.body || '';
    // Fixed words only where the message travels in clear.
    msg.line = WORDS[kind] || null;
    msg.actions = [{ id: 'open', label: 'Open' }];
  }
  return capped(msg);
}

export function testMessage() {
  const at = new Date().toISOString();
  const body = `Alerts from ${phone.hubName()} will land here.`;
  return { v: 1, type: 'test', id: `test:${at}`, at, kind: 'test', title: 'Ravenry test', body, line: body, actions: [] };
}

// ------------------------------------------------------------ what is on the phone

// alert id -> { projectId } for the session alerts, so leaving Needs you
// takes them off; checkpoint alerts are "cp:<id>".
const shownAlerts = new Map();

// `where.click`: the board's link for the alert (server/alerts.mjs
// sessionUrl), which an iPhone through ntfy opens on a tap.
export function fromCheckpoint(cp, where = {}) {
  if (!ready()) return null;
  const msg = checkpointMessage(cp, where);
  shownAlerts.set(msg.id, { checkpoint: cp.id });
  send(msg, { click: where.click || null });
  return msg;
}

// "Saved your decision": an agent recorded the person's words in the
// ledger (server/decisions.mjs). Undo, for a minute, takes it back
// (POST /api/decisions/undo { id }).
export function decisionMessage(d, { project = null } = {}) {
  return capped({
    v: 1, type: 'alert', id: `dec:${d.id}`, at: d.at, kind: 'decision',
    title: 'Saved your decision', body: clip(d.quote.replace(/\s*\n\s*/g, ' '), 600), line: null,
    detail: `${who(d.recorded_by && d.recorded_by.assistant)} recorded it${project ? ` for ${project.name}` : ''}.`,
    project: project ? { id: project.id, name: project.name } : null, machine: (d.recorded_by && d.recorded_by.machine) || null, session: null,
    decision: { id: d.id, undo_until: new Date(Date.parse(d.at) + 60000).toISOString() },
    actions: [{ id: 'undo', label: 'Undo' }], reply: null,
  });
}

export function fromDecision(d, where = {}) {
  if (!ready()) return null;
  const msg = decisionMessage(d, where);
  send(msg);
  // Undo lasts a minute; then the alert has nothing left to offer.
  const tm = setTimeout(() => { timers.delete(tm); send({ v: 1, type: 'close', id: msg.id }); }, 60000);
  if (tm.unref) tm.unref();
  timers.add(tm);
  return msg;
}

// Takes a decision's alert off the phone (undone).
export const closeDecision = (id) => send({ v: 1, type: 'close', id: `dec:${id}` });

export function fromProject(alert, p) {
  if (!ready()) return null;
  const msg = projectMessage(alert, p);
  shownAlerts.set(msg.id, { projectId: p.id, surfaceId: msg.session ? msg.session.surfaceId : null, kind: alert.kind });
  send(msg, { click: alert.url || null });
  return msg;
}

function close(id) {
  shownAlerts.delete(id);
  send({ v: 1, type: 'close', id });
}

// The open checkpoints' ids, each tick: an alerted one that is gone closes.
export function syncCheckpoints(openIds) {
  const open = new Set(openIds);
  for (const [id, v] of shownAlerts) if (v.checkpoint && !open.has(v.checkpoint)) close(id);
}

// The board's projects, each tick: a session alert whose project left
// Needs you (or whose session is no longer the one that waits) closes.
export function syncProjects(projects) {
  for (const [id, v] of shownAlerts) {
    if (!v.projectId) continue;
    const p = projects.find((x) => x.id === v.projectId);
    const still = p && p.state === 'you' && (v.kind === 'gate' ? !!p.planGate : p.primary === v.surfaceId);
    if (!still) close(id);
  }
}

export function _reset() { shownAlerts.clear(); lastBy.clear(); for (const t of timers) clearTimeout(t); timers.clear(); }
