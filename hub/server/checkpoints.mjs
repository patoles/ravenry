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
const KINDS = new Set(['ask', 'approve', 'secret']);

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
const FIELDS = ['id', 'kind', 'state', 'title', 'pane', 'assistant', 'options', 'free_text', 'command', 'cwd', 'why', 'secret', 'created_at', 'expires_at', 'closed_at', 'reason', 'answer', 'run', 'machine', 'daemon'];
function clean(cp) {
  const out = {};
  for (const k of FIELDS) if (cp[k] !== undefined) out[k] = cp[k];
  if (out.secret) out.secret = { to: out.secret.to, ...(out.secret.pane ? { pane: out.secret.pane } : {}), ...(out.secret.env ? { env: out.secret.env } : {}), ...(out.secret.enter === false ? { enter: false } : {}) };
  if (out.answer) {
    const a = out.answer;
    out.answer = { at: a.at, ...(a.choice != null ? { choice: a.choice, option: a.option } : {}), ...(a.text != null ? { text: a.text } : {}), ...(a.approved ? { approved: true } : {}), ...(a.delivered ? { delivered: true } : {}), ...(a.declined ? { declined: true } : {}), ...(a.by ? { by: a.by } : {}) };
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
// secret | decline, by }. `send(daemon, params)` reaches the daemon that
// holds it. The reply never echoes a secret back.
export async function answer(body, send) {
  load();
  const b = body && typeof body === 'object' ? body : {};
  const cp = typeof b.id === 'string' ? byId.get(b.id) : null;
  if (!cp) return { ok: false, status: 404, error: 'No such checkpoint. It may have closed already.' };
  if (cp.state !== 'open') return { ok: false, status: 409, error: `It was ${cp.state === 'running' ? 'approved already and is running' : cp.state} already.` };
  const keys = ['choice', 'text', 'approve', 'secret', 'decline'].filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== false);
  if (keys.length !== 1) return { ok: false, status: 400, error: 'Answer with exactly one of choice, text, approve, secret or decline.' };
  const k = keys[0];
  const params = { checkpoint: cp.id, ...(typeof b.by === 'string' && b.by ? { by: b.by.slice(0, 64) } : {}) };
  if (k === 'choice') {
    if (!Number.isInteger(b.choice)) return { ok: false, status: 400, error: 'choice is a number.' };
    params.choice = b.choice;
  } else if (k === 'text') params.text = String(b.text);
  else if (k === 'secret') {
    if (typeof b.secret !== 'string' || b.secret.length < 4) return { ok: false, status: 400, error: 'Type the whole secret (at least 4 characters).' };
    params.secret = b.secret;
  } else params[k] = true;
  if (!KINDS.has(cp.kind) && k !== 'decline') return { ok: false, status: 400, error: 'This board does not know that kind of checkpoint; it can only decline it.' };
  try {
    const r = await send(cp.daemon, params);
    take(r.checkpoint, { machine: cp.machine, daemon: cp.daemon });
    return { ok: true, checkpoint: byId.get(cp.id) };
  } catch (e) {
    // The daemon's own words, never the request (it may hold the secret).
    if (e && e.code === 'forbidden') return { ok: false, status: 403, error: `${cp.machine ? cp.machine : 'The daemon'} did not take the answer from this hub: ${e.message}` };
    const why = e && e.code === 'not_found' ? 'It closed already: answered somewhere else, cancelled or expired.' : `The daemon did not take the answer (${e && e.code ? e.code : 'unreachable'}).`;
    return { ok: false, status: e && e.code === 'not_found' ? 409 : 502, error: why };
  } finally {
    if (params.secret) params.secret = '';
  }
}

// For tests.
export function _reset() { byId = null; seen = null; }
