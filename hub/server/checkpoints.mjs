// Checkpoints (PROTOCOL.md section 4): an agent waits for a person. Each
// ravenryd holds its own; the hub follows every daemon it reaches, this
// machine's and the remote ones (server/ravenryd.mjs), keeps them here for
// the board, the app and the phone, alerts the phone when one opens
// (server/alerts.mjs), and passes a person's answer back to the daemon
// that holds it.
//
// A secret a person types goes through answer() to the daemon and nowhere
// else: it is never kept here, written to checkpoints.json, put in the
// board's state, an alert or a log line. The daemon's Checkpoint never
// holds one either (its answer says only `delivered`).
//
// <RAVENRY_HOME>/checkpoints.json keeps the last closed ones, for the
// board's history; the open ones come back from the daemons' own lists
// when the hub restarts.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const FILE = path.join(RAVENRY_HOME, 'checkpoints.json');
const KEEP_CLOSED = 100;
const FINAL = new Set(['answered', 'declined', 'cancelled', 'expired']);
const KINDS = new Set(['ask', 'approve', 'secret', 'drive', 'pick']);
// How long a drive grant lasts (checkpoint.answer `allow`): this input,
// or the rest of the asking agent's session.
const ALLOW = new Set(['once', 'session']);
export const MAX_NOTE = 4000;

// id -> checkpoint (the daemon's object) plus { machine, daemon }
let byId = null;
let seen = null; // ids alerted or known closed, so a re-listed one does not alert again

function load() {
  if (byId) return;
  byId = new Map();
  seen = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const cp of Array.isArray(j.closed) ? j.closed : []) if (cp && cp.id) { byId.set(cp.id, cp); seen.add(cp.id); }
    for (const id of Array.isArray(j.seen) ? j.seen : []) seen.add(id);
  } catch { /* none yet */ }
}

function save() {
  const closed = [...byId.values()].filter((c) => FINAL.has(c.state)).sort((a, b) => (a.closed_at || '') < (b.closed_at || '') ? -1 : 1).slice(-KEEP_CLOSED);
  const open = [...byId.values()].filter((c) => !FINAL.has(c.state)).map((c) => c.id);
  try {
    assertDataWrite(FILE);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ closed: closed.map(clean), seen: open }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('checkpoints:', e.message); }
}

// Only the fields the protocol defines, so nothing else a daemon might send
// is ever stored or shown.
const FIELDS = ['id', 'kind', 'state', 'title', 'pane', 'assistant', 'options', 'free_text', 'command', 'cwd', 'why', 'warning', 'env', 'secret', 'drive', 'variants', 'created_at', 'expires_at', 'closed_at', 'reason', 'answer', 'run', 'machine', 'daemon'];
function clean(cp) {
  const out = {};
  for (const k of FIELDS) if (cp[k] !== undefined) out[k] = cp[k];
  if (out.secret) out.secret = { to: out.secret.to, ...(out.secret.pane ? { pane: out.secret.pane } : {}), ...(out.secret.env ? { env: out.secret.env } : {}), ...(out.secret.enter === false ? { enter: false } : {}) };
  if (out.answer) {
    const a = out.answer;
    out.answer = { at: a.at, ...(a.choice != null ? { choice: a.choice, option: a.option } : {}), ...(a.text != null ? { text: a.text } : {}), ...(a.approved ? { approved: true } : {}), ...(typeof a.command === 'string' && a.command ? { command: a.command } : {}), ...(a.delivered ? { delivered: true } : {}), ...(a.declined ? { declined: true } : {}), ...(typeof a.allow === 'string' && a.allow ? { allow: a.allow } : {}), ...(a.pick && typeof a.pick === 'object' ? { pick: cleanPick(a.pick) } : {}), ...(typeof a.reason === 'string' && a.reason ? { reason: a.reason } : {}), ...(a.by ? { by: a.by } : {}) };
  }
  if (out.variants) out.variants = (Array.isArray(out.variants) ? out.variants : []).slice(0, 4).map((v) => ({ label: String(v && v.label || ''), path: String(v && v.path || ''), type: v && v.type === 'html' ? 'html' : 'image', ...(Number.isFinite(v && v.size) ? { size: v.size } : {}), ...(v && typeof v.pane === 'string' ? { pane: v.pane } : {}) }));
  if (out.drive) { const d = out.drive; out.drive = { pane: String(d.pane || ''), ...(d.agent && typeof d.agent === 'object' ? { agent: cleanSource(d.agent) } : {}), ...(typeof d.input === 'string' ? { input: d.input } : {}), ...(['input', 'close', 'restart', 'override'].includes(d.action) ? { action: d.action } : {}) }; }
  return out;
}

// An input source (PROTOCOL.md: person, an agent's pane, an API client).
function cleanSource(s) {
  return { kind: String(s.kind || ''), ...(typeof s.pane === 'string' ? { pane: s.pane } : {}), ...(typeof s.client === 'string' ? { client: s.client } : {}), ...(typeof s.by === 'string' ? { by: s.by } : {}) };
}

// A pick answer: the variant's label, a region on it (each 0 to 1), a note.
function cleanPick(p) {
  const r = p.region;
  return { label: String(p.label || ''), ...(r && typeof r === 'object' ? { region: { x: +r.x, y: +r.y, w: +r.w, h: +r.h } } : {}), ...(typeof p.note === 'string' && p.note ? { note: p.note } : {}) };
}

// A pick from a client: { label, region?, note? }, checked against the
// checkpoint's variants. Returns the params' pick or an error string.
export function checkPick(cp, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'pick is { label, region?, note? }.';
  const extra = Object.keys(p).filter((k) => !['label', 'region', 'note'].includes(k));
  if (extra.length) return `This board does not know pick.${extra.join(', pick.')}, so it did not pass the answer on.`;
  if (typeof p.label !== 'string' || !(cp.variants || []).some((v) => v.label === p.label)) return 'Pick one of the variants by its label.';
  const out = { label: p.label };
  if (p.region != null) {
    const r = p.region;
    const ok = r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && r[k] >= 0 && r[k] <= 1) && r.x + r.w <= 1.000001 && r.y + r.h <= 1.000001 && r.w > 0 && r.h > 0;
    if (!ok) return 'The region is { x, y, w, h }, each from 0 to 1 of the picture, inside it.';
    out.region = { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  if (p.note != null) {
    if (typeof p.note !== 'string' || Buffer.byteLength(p.note) > MAX_NOTE) return `The note is text, at most ${MAX_NOTE} bytes.`;
    if (p.note.trim()) out.note = p.note.trim();
  }
  return out;
}

// A checkpoint a daemon reported (an event, or its list). Returns true
// when it opened and nobody was told yet: the caller alerts.
export function take(cp, { machine = null, daemon = null } = {}) {
  load();
  if (!cp || typeof cp.id !== 'string') return false;
  const had = byId.get(cp.id);
  const next = clean({ ...cp, machine, daemon });
  byId.set(cp.id, next);
  const fresh = next.state === 'open' && !seen.has(cp.id);
  if (fresh || (FINAL.has(next.state) && !(had && FINAL.has(had.state)))) { seen.add(cp.id); save(); }
  return fresh;
}

// Forgets the open checkpoints of a daemon the hub lost: they come back
// from its list when it connects again.
export function dropDaemon(daemon) {
  load();
  for (const [id, cp] of byId) if (cp.daemon === daemon && !FINAL.has(cp.state)) byId.delete(id);
}

export function get(id) { load(); return byId.get(id) || null; }

// Open and running ones, oldest first; with all, the recent closed ones too.
export function list({ all = false } = {}) {
  load();
  return [...byId.values()].filter((c) => all || !FINAL.has(c.state)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

// A person's answer, from the board's API: { id, choice | text | approve |
// secret | pick | decline, by }, with `allow` (approve on a drive: once
// or session), `command` (approve: the command as the
// person edited it, which runs instead) or `reason` (decline: why, for the
// agent). Every field the person gave reaches the daemon or the answer is
// refused: an edited command never runs as proposed because a field was
// dropped on the way. `send(daemon, params)` reaches the daemon that holds
// it. The reply never echoes a secret back.
export async function answer(body, send) {
  load();
  const b = body && typeof body === 'object' ? body : {};
  const cp = typeof b.id === 'string' ? byId.get(b.id) : null;
  if (!cp) return { ok: false, status: 404, error: 'No such checkpoint. It may have closed already.' };
  if (cp.state !== 'open') return { ok: false, status: 409, error: `It was ${cp.state === 'running' ? 'approved already and is running' : cp.state} already.` };
  const keys = ['choice', 'text', 'approve', 'secret', 'pick', 'decline'].filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== false);
  if (keys.length !== 1) return { ok: false, status: 400, error: 'Answer with exactly one of choice, text, approve, secret, pick or decline.' };
  const k = keys[0];
  // Fields this board does not know are refused, not dropped.
  const known = new Set(['id', 'by', 'choice', 'text', 'approve', 'secret', 'pick', 'decline', 'command', 'reason', 'allow']);
  const unknown = Object.keys(b).filter((x) => !known.has(x));
  if (unknown.length) return { ok: false, status: 400, error: `This board does not know ${unknown.join(', ')}, so it did not pass the answer on.` };
  const hasCommand = b.command !== undefined && b.command !== null;
  const hasReason = b.reason !== undefined && b.reason !== null;
  if (hasCommand && k !== 'approve') return { ok: false, status: 400, error: 'An edited command goes with approve.' };
  if (hasReason && k !== 'decline') return { ok: false, status: 400, error: 'A reason goes with decline.' };
  if (hasCommand && (typeof b.command !== 'string' || !b.command.trim())) return { ok: false, status: 400, error: 'The edited command is empty.' };
  if (hasReason && typeof b.reason !== 'string') return { ok: false, status: 400, error: 'The reason is text.' };
  const hasAllow = b.allow !== undefined && b.allow !== null;
  if (hasAllow && (k !== 'approve' || cp.kind !== 'drive')) return { ok: false, status: 400, error: 'allow goes with approve, on a request to type into a pane.' };
  if (hasAllow && !ALLOW.has(b.allow)) return { ok: false, status: 400, error: 'allow is once or session.' };
  if (hasCommand && cp.kind !== 'approve') return { ok: false, status: 400, error: 'Only a command to approve can be edited.' };
  const params = { checkpoint: cp.id, ...(typeof b.by === 'string' && b.by ? { by: b.by.slice(0, 64) } : {}) };
  if (k === 'choice') {
    if (!Number.isInteger(b.choice)) return { ok: false, status: 400, error: 'choice is a number.' };
    params.choice = b.choice;
  } else if (k === 'text') params.text = String(b.text);
  else if (k === 'secret') {
    if (typeof b.secret !== 'string' || b.secret.length < 4) return { ok: false, status: 400, error: 'Type the whole secret (at least 4 characters).' };
    params.secret = b.secret;
  } else if (k === 'pick') {
    if (cp.kind !== 'pick') return { ok: false, status: 400, error: 'Only a pick is answered with a pick.' };
    const pk = checkPick(cp, b.pick);
    if (typeof pk === 'string') return { ok: false, status: 400, error: pk };
    params.pick = pk;
  } else params[k] = true;
  if (hasAllow) params.allow = b.allow;
  if (hasCommand) params.command = b.command;
  // An empty reason is no reason.
  if (hasReason && b.reason.trim()) params.reason = b.reason.trim();
  if (!KINDS.has(cp.kind) && k !== 'decline') return { ok: false, status: 400, error: 'This board does not know that kind of checkpoint; it can only decline it.' };
  try {
    const r = await send(cp.daemon, params);
    take(r.checkpoint, { machine: cp.machine, daemon: cp.daemon });
    return { ok: true, checkpoint: byId.get(cp.id) };
  } catch (e) {
    // The daemon's own words, never the request (it may hold the secret).
    if (e && e.code === 'forbidden') return { ok: false, status: 403, error: `${cp.machine ? cp.machine : 'The daemon'} did not take the answer from this hub: ${e.message}` };
    // A daemon older than the field refuses it: nothing ran.
    if (e && e.code === 'bad_request' && (params.command || params.reason || params.allow || params.pick)) return { ok: false, status: 400, error: `${cp.machine ? `ravenryd on ${cp.machine}` : 'ravenryd'} did not take the answer, so nothing ran: ${e.message}. An older ravenryd cannot take every field of this answer; update it there.` };
    const why = e && e.code === 'not_found' ? 'It closed already: answered somewhere else, cancelled or expired.' : `The daemon did not take the answer (${e && e.code ? e.code : 'unreachable'}).`;
    return { ok: false, status: e && e.code === 'not_found' ? 409 : 502, error: why };
  } finally {
    if (params.secret) params.secret = '';
  }
}

// For tests.
export function _reset() { byId = null; seen = null; }
