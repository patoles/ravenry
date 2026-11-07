// The person's review comments on a worktree session's work, kept by the
// hub so they survive a window closing and the hub restarting
// (hub/docs/SESSIONS.md, Review comments). A comment is pending until the
// person sends it: then it is typed into the session through the
// composer's send path, with its id, and the agent answers it with
// `ravenry review reply <id> "..."`, which joins the comment's thread.
//
// <RAVENRY_HOME>/reviews.json (mode 0600, written atomically):
//   { "version": 1, "reviews": { "<surfaceId>": [ {
//       id: "rc" + 7 of a-z2-7, file, line, side: "new" | "old", text, at,
//       state: "pending" | "sent", sent_at?,
//       replies: [ { id: "rr" + 7, text, at, by: "agent", pane? } ] } ] } }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const FILE = path.join(RAVENRY_HOME, 'reviews.json');
export const MAX_TEXT = 4000;
const MAX_FILE = 1000;
const MAX_PER_SESSION = 500;
const MAX_REPLIES = 50;
export const COMMENT_ID = /^rc[a-z2-7]{7}$/;

function newId(prefix) {
  const a = 'abcdefghijklmnopqrstuvwxyz234567';
  return prefix + [...crypto.randomBytes(7)].map((x) => a[x & 31]).join('');
}

export function load(file = FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j.reviews === 'object' && j.reviews ? j.reviews : {};
  } catch { return {}; }
}

function save(all, file = FILE) {
  assertDataWrite(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, reviews: all }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A session's comments, oldest first. */
export function list(surfaceId, file = FILE) {
  return (load(file)[surfaceId] || []).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Checks a comment's fields: null when fine, else the words of the 400. */
export function problem({ file, line, side, text }) {
  if (typeof file !== 'string' || !file.trim() || file.length > MAX_FILE) return 'file is the path the comment is on.';
  if (!(Number.isInteger(line) && line >= 1)) return 'line is a line number, from 1.';
  if (side != null && side !== 'old' && side !== 'new') return 'side is old or new.';
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return `Type the comment (at most ${MAX_TEXT} characters).`;
  return null;
}

/** Adds a comment to a session: pending, or already sent (the old comment route types it at once). */
export function add(surfaceId, { file, line, side = null, text, state = 'pending' }, f = FILE) {
  const all = load(f);
  const mine = all[surfaceId] || [];
  if (mine.length >= MAX_PER_SESSION) return { ok: false, status: 409, error: `This session has ${MAX_PER_SESSION} comments already.` };
  const at = new Date().toISOString();
  const c = { id: newId('rc'), file: file.trim(), line, side: side || 'new', text: text.trim(), at, state, ...(state === 'sent' ? { sent_at: at } : {}), replies: [] };
  all[surfaceId] = [...mine, c];
  save(all, f);
  return { ok: true, comment: c };
}

/** Takes a pending comment back. */
export function remove(surfaceId, id, f = FILE) {
  const all = load(f);
  const mine = all[surfaceId] || [];
  const c = mine.find((x) => x.id === id);
  if (!c) return { ok: false, status: 404, error: 'No such comment.' };
  if (c.state !== 'pending') return { ok: false, status: 409, error: 'That comment was sent already.' };
  all[surfaceId] = mine.filter((x) => x.id !== id);
  save(all, f);
  return { ok: true };
}

/** The pending comments to send: the ones named, or all. */
export function pending(surfaceId, ids = null, f = FILE) {
  return list(surfaceId, f).filter((c) => c.state === 'pending' && (!ids || ids.includes(c.id)));
}

export function markSent(surfaceId, id, f = FILE) {
  const all = load(f);
  const c = (all[surfaceId] || []).find((x) => x.id === id);
  if (!c) return null;
  c.state = 'sent';
  c.sent_at = new Date().toISOString();
  save(all, f);
  return c;
}

/** The words a comment reaches the session with, its id and how to answer included. */
export function sendText(c) {
  const where = `${c.file} line ${c.line}${c.side === 'old' ? ' (the old side of the diff)' : ''}`;
  return `Review comment ${c.id} on ${where}: ${String(c.text).replace(/\s*\n\s*/g, ' ').trim()} (reply with: ravenry review reply ${c.id} "...")`;
}

/** Where a comment is: { surfaceId, comment } or null. */
export function find(id, f = FILE) {
  for (const [surfaceId, cs] of Object.entries(load(f))) {
    const c = (cs || []).find((x) => x.id === id);
    if (c) return { surfaceId, comment: c };
  }
  return null;
}

/** An agent's answer joins a comment's thread. */
export function reply(id, text, pane, f = FILE) {
  const all = load(f);
  for (const cs of Object.values(all)) {
    const c = (cs || []).find((x) => x.id === id);
    if (!c) continue;
    if ((c.replies || []).length >= MAX_REPLIES) return { ok: false, status: 409, error: 'That comment has enough replies already.' };
    const r = { id: newId('rr'), text: String(text).trim(), at: new Date().toISOString(), by: 'agent', ...(pane ? { pane } : {}) };
    c.replies = [...(c.replies || []), r];
    save(all, f);
    return { ok: true, comment: c, reply: r };
  }
  return { ok: false, status: 404, error: 'No such comment.' };
}
