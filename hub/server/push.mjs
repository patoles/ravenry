// Alerts to the phone apps (docs/PHONE.md sections 4 and 5).
//
// Each paired device may have one push target, which the device sets
// itself: `unifiedpush` (built: any UnifiedPush distributor, such as ntfy),
// `apns` and `fcm` (designed: through a relay; refused until built) or
// `none`. Every body is encrypted for that device with Web Push message
// encryption (RFC 8291, aes128gcm, RFC 8188), with the device's own P-256
// key and auth secret, so the distributor or a relay sees only ciphertext.
//
// Unlike the third-party channels (server/channels.mjs), an app alert
// carries the question, the command and the agent's words, with the
// buttons that answer it from the shade. The same messages reach each
// device's live event stream (`event: phone`, through `onLive`), so an app
// that holds its connection shows them without push.
//
// What triggers one (server/alerts.mjs calls in): a checkpoint that opened
// (fromCheckpoint), a project that moved into Needs you (fromProject, the
// app's own trigger in alerts.mjs), and a test. `close` takes an alert off
// the phone: the checkpoint closed (syncCheckpoints) or the session left
// Needs you (syncProjects).

import crypto from 'node:crypto';
import os from 'node:os';
import * as phone from './phone.mjs';
import { sayFolder } from './homes.mjs';

const env = process.env;
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const RETRY_MS = num(env.MC_PUSH_RETRY_MS, 30 * 1000);
const TIMEOUT_MS = 10000;
const CAP = 3000;
const RS = 4096;

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

function endpointOk(u) {
  let x;
  try { x = new URL(String(u || '')); } catch { return false; }
  if (x.username || x.password) return false;
  if (x.protocol === 'https:') return true;
  const h = x.hostname.replace(/^\[|\]$/g, '');
  return x.protocol === 'http:' && (h === '127.0.0.1' || h === 'localhost' || h === '::1');
}

// A device's push target, checked: { ok, target } or { ok: false, status, error }.
export function checkTarget(b) {
  const body = b && typeof b === 'object' ? b : {};
  const kind = String(body.kind || '');
  if (!KINDS.has(kind)) return { ok: false, status: 400, error: 'Unknown push kind. This hub knows unifiedpush and none.' };
  if (kind === 'none') return { ok: true, target: null };
  if (kind !== 'unifiedpush') return { ok: false, status: 400, error: `Push through ${kind} is not built yet. Use unifiedpush, or none.` };
  if (!endpointOk(body.endpoint)) return { ok: false, status: 400, error: 'The endpoint is not an https address.' };
  const p = unb64u(body.p256dh), a = unb64u(body.auth);
  if (p.length !== 65 || p[0] !== 4) return { ok: false, status: 400, error: 'p256dh is not an uncompressed P-256 public key in base64url.' };
  if (a.length !== 16) return { ok: false, status: 400, error: 'auth is not 16 bytes in base64url.' };
  return { ok: true, target: { kind, endpoint: String(body.endpoint), p256dh: b64u(p), auth: b64u(a), at: new Date().toISOString() } };
}

// ------------------------------------------------------------ live streams

let live = () => {};
// `fn(deviceId, message)` writes to that device's open event streams.
export function onLive(fn) { live = fn; }

// ------------------------------------------------------------ sending

const timers = new Set();
export const last = { at: null, ok: null, error: null };

async function post(t, body) {
  try {
    const r = await fetch(t.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' }, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    await r.arrayBuffer().catch(() => null);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.cause && e.cause.code) || (e && e.name) || 'error' };
  }
}

async function pushTo(dev, msg, attempt = 1) {
  const t = dev.push;
  if (!t || t.kind !== 'unifiedpush') return;
  let body;
  try { body = encrypt(Buffer.from(JSON.stringify(msg)), unb64u(t.p256dh), unb64u(t.auth)); } catch (e) { console.error(`push: ${dev.name}: ${e.message}`); return; }
  const r = await post(t, body);
  last.at = new Date().toISOString();
  last.ok = r.ok;
  last.error = r.ok ? null : r.error || `the endpoint answered ${r.status}`;
  if (r.ok) return;
  if (r.status === 404 || r.status === 410) {
    // The distributor forgot this endpoint: the device sets a new one.
    phone.setPush(dev.id, null);
    console.log(`push: ${dev.name}'s endpoint is gone (${r.status}); dropped`);
    return;
  }
  console.log(`push: ${dev.name}: ${last.error}${attempt === 1 ? `; trying again in ${Math.round(RETRY_MS / 1000)} s` : ''}`);
  if (attempt === 1) {
    const tm = setTimeout(() => { timers.delete(tm); const d = phone.deviceRecord(dev.id); if (d && d.push) pushTo(d, msg, 2); }, RETRY_MS);
    if (tm.unref) tm.unref();
    timers.add(tm);
  }
}

// Sends a message to every paired app: its push target and its live streams.
export function send(msg) {
  const devs = phone.devices().filter((d) => d.platform !== 'browser');
  for (const d of devs) {
    try { live(d.id, msg); } catch { /* a stream that went */ }
    const rec = phone.deviceRecord(d.id);
    if (rec && rec.push) pushTo(rec, msg).catch((e) => console.error('push:', e.message));
  }
  return devs.length;
}

// Whether any app is paired (the app trigger runs only then).
export const ready = () => phone.devices().some((d) => d.platform !== 'browser');

// ------------------------------------------------------------ messages (section 5)

const ASSISTANT = { claude: 'Claude', codex: 'Codex' };
const who = (a) => ASSISTANT[String(a || '').toLowerCase()] || 'The agent';
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, Math.max(0, n - 3)) + '...' : t; };
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// Keeps a message within CAP bytes, cutting its longest texts first.
export function capped(msg) {
  const size = () => Buffer.byteLength(JSON.stringify(msg));
  let n = 1000;
  while (size() > CAP && n > 20) {
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
export function checkpointMessage(cp, { project = null, machine = null } = {}) {
  const s = sessionOf(project, cp.pane);
  const topic = (s && s.topic) || null;
  const name = topic || (project ? project.name : null) || who(cp.assistant);
  const [head, ...rest] = String(cp.title || '').replace(/\r/g, '').trim().split('\n');
  const more = rest.join('\n').trim();
  const until = cp.expires_at ? ` waits until ${hhmm(cp.expires_at)}.` : ' waits for you.';
  const msg = {
    v: 1, type: 'alert', id: `cp:${cp.id}`, at: cp.created_at || new Date().toISOString(), kind: cp.kind,
    title: '', body: head || '', detail: null,
    project: project ? { id: project.id, name: project.name } : null,
    machine: machine || null,
    session: s ? { surfaceId: s.surfaceId, topic, assistant: s.assistant || cp.assistant || null } : (cp.pane ? { surfaceId: `ravenry:${cp.pane}`, topic: null, assistant: cp.assistant || null } : null),
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
    msg.body = String(cp.command || '');
    msg.detail = `on ${machine || phone.hubName()}${cp.cwd ? `, in ${sayFolder(cp.cwd, machine)}` : ''}`;
    msg.checkpoint.command = String(cp.command || '');
    msg.checkpoint.cwd = cp.cwd || null;
    if (cp.warning) msg.checkpoint.warning = clip(cp.warning, 300);
    msg.actions = [{ id: 'run', label: 'Run', biometric: true }, { id: 'refuse', label: 'Refuse' }, { id: 'open', label: 'Open' }];
  } else if (cp.kind === 'secret') {
    msg.title = `${who(cp.assistant)} needs a secret${topic ? ` for ${topic}` : ''}`;
    const to = cp.secret && cp.secret.to;
    const prog = cp.command ? program(cp.command) : null;
    msg.detail = `${prog && to !== 'input' ? `for ${prog} ` : ''}on ${machine || phone.hubName()}. Type it in the app.`;
    msg.actions = [{ id: 'open', label: 'Type it' }, { id: 'decline', label: 'Not now' }];
    msg.reply = null;
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
  const name = topic || p.name;
  const kind = alert.kind;
  const id = kind === 'gate'
    ? `gate:${crypto.createHash('sha256').update(String(alert.gateKey || '')).digest('base64url').slice(0, 16)}`
    : `s:${p.id}:${s ? s.surfaceId : ''}:${(s && s.since) || ''}`;
  const quick = (Array.isArray(p.quick) ? p.quick : Array.isArray(w.quick) ? w.quick : []).map((o, k) => (o && o.choice != null ? { id: `quick:${o.choice}`, label: String(o.label) } : { id: `quick:${k}`, label: String(o && o.label), text: String(o && o.label) }));
  const question = p.question || w.question || null;
  const head = p.headline || w.headline || null;
  const msg = {
    v: 1, type: 'alert', id, at: new Date().toISOString(), kind,
    title: `${name} needs you`, body: '', detail: null,
    project: { id: p.id, name: p.name }, machine: p.machine || (s && s.machine) || null,
    session: s ? { surfaceId: s.surfaceId, topic, assistant: s.assistant || null } : null,
    checkpoint: null, actions: [], reply: null,
  };
  if (kind === 'permission') {
    msg.body = question || head || 'Waiting for permission';
    msg.detail = head && head !== msg.body ? head : null;
    msg.actions = quick.length ? fit(quick, 3) : [{ id: 'open', label: 'Open' }];
  } else if (kind === 'question') {
    msg.body = question || head || 'Asked you a question';
    msg.detail = head && head !== msg.body ? head : null;
    msg.actions = quick.length ? fit(quick, 2) : [{ id: 'open', label: 'Open' }];
    if (s) msg.reply = { action: 'send', label: 'Reply', hint: `Reply to ${who(s.assistant)}` };
  } else if (kind === 'handback') {
    msg.body = head || p.line || 'Handed back';
    msg.actions = [{ id: 'open', label: 'Open' }];
    if (s) msg.reply = { action: 'send', label: 'Reply', hint: `Reply to ${who(s.assistant)}` };
  } else if (kind === 'gate') {
    msg.title = `${p.name}: plan gate`;
    msg.body = (p.planGate && (p.planGate.question || p.planGate.short)) || 'A plan waits at a gate';
    msg.actions = [{ id: 'open', label: 'Open' }];
  } else {
    msg.body = alert.body || '';
    msg.actions = [{ id: 'open', label: 'Open' }];
  }
  return capped(msg);
}

export function testMessage() {
  const at = new Date().toISOString();
  return { v: 1, type: 'test', id: `test:${at}`, at, kind: 'test', title: 'Ravenry test', body: `Alerts from ${phone.hubName()} will land here.`, actions: [] };
}

// ------------------------------------------------------------ what is on the phone

// alert id -> { projectId } for the session alerts, so leaving Needs you
// takes them off; checkpoint alerts are "cp:<id>".
const shownAlerts = new Map();

export function fromCheckpoint(cp, where = {}) {
  if (!ready()) return null;
  const msg = checkpointMessage(cp, where);
  shownAlerts.set(msg.id, { checkpoint: cp.id });
  send(msg);
  return msg;
}

export function fromProject(alert, p) {
  if (!ready()) return null;
  const msg = projectMessage(alert, p);
  shownAlerts.set(msg.id, { projectId: p.id, surfaceId: msg.session ? msg.session.surfaceId : null, kind: alert.kind });
  send(msg);
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

export function _reset() { shownAlerts.clear(); for (const t of timers) clearTimeout(t); timers.clear(); }
