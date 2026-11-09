// What a person has seen of Ravenry's onboarding, kept by the hub so every
// client (the desktop app, the native Mac app, a second computer's window
// on this board) shows it once, not once per client:
//
//   hints  the one-time hints dismissed ("needs-you", "agent-pane", "pick")
//   learn  the Learn Ravenry cards ticked once that part was used ("panes",
//          "needs", "phone", "pick", "review", "film", "decisions")
//   setup  the assistants whose step 2 (their hooks and the Ravenry skill,
//          before the first session) was answered ("claude", "codex")
//
// Kept in <RAVENRY_HOME>/onboarding.json, the union of every mark ever
// sent: a mark is never taken back, so nothing seen is shown again.
//
// Routes (server/index.mjs):
//
//   GET /api/onboarding
//     -> { ok: true, hints: { "<id>": true }, learn: { "<key>": true }, setup: { "<kind>": true } }
//
//   POST /api/onboarding  (a person's: server/person.mjs)
//     { hints?: { "<id>": true }, learn?: {...}, setup?: {...} }
//     marks them (a value that is not true, or a name that is not a short
//     lowercase word, is left out) and answers the union, as GET does. A
//     client sends what it kept before the hub did (the desktop's store),
//     and what it marked while the board was not up, the same way.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const FILE = path.join(RAVENRY_HOME, 'onboarding.json');
export const GROUPS = ['hints', 'learn', 'setup'];
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX = 64; // names per group

let cache = null;

function empty() { return { hints: {}, learn: {}, setup: {} }; }

function clean(o) {
  const out = empty();
  if (!o || typeof o !== 'object') return out;
  for (const g of GROUPS) {
    const m = o[g];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m)) if (v === true && NAME.test(k) && Object.keys(out[g]).length < MAX) out[g][k] = true;
  }
  return out;
}

/** The marks as kept (a missing or broken file is no marks). */
export function read() {
  if (cache) return cache;
  try { cache = clean(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cache = empty(); }
  return cache;
}

/** GET /api/onboarding's answer. */
export function view() {
  const r = read();
  return { hints: { ...r.hints }, learn: { ...r.learn }, setup: { ...r.setup } };
}

/** Adds the marks in `body` (POST /api/onboarding); written only when one is new. */
export function mark(body) {
  const cur = read();
  const add = clean(body);
  let changed = false;
  for (const g of GROUPS) {
    for (const k of Object.keys(add[g])) {
      if (cur[g][k] || Object.keys(cur[g]).length >= MAX) continue;
      cur[g][k] = true;
      changed = true;
    }
  }
  if (changed) {
    assertDataWrite(FILE);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...cur }, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  }
  return view();
}
