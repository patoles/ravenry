// Plain programs in Ravenry's panes (docs/FEATURES.md SESS-056): a build
// or a deploy that says its own state with OSC 7501 (PROTOCOL.md, The
// agent in a pane). ravenryd keeps what each one said in its pane's
// `agent.program` (working, blocked, done, error); the hub lists the panes
// (server/ravenryd.mjs listTabs) and makes each program one more session
// row of the project whose folder it runs in, or a card of its own when
// it runs in no project's folder, as a session in no project is
// (hub/docs/STATE-RULES.md, "A program in a pane").
//
// Working and blocked show while the program says so. Done and failed are
// held until the person sees them (opens the row on the board, the phone
// or the Mac: POST /api/program/seen) or a new command starts in that
// shell (the daemon then clears the record). What was seen is kept in
// <RAVENRY_HOME>/programs-seen.json, so a hub that restarts does not show
// them again.
//
// Pure apart from that file; tested in hub/tools/programs-test.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const SEEN_FILE = path.join(RAVENRY_HOME, 'programs-seen.json');

// The daemon's program states, as the board says them.
const STATE = { working: 'working', blocked: 'blocked', done: 'done', error: 'failed' };
const KINDS = new Set(['auth', 'permission', 'question']);
const MAX_LINE = 300;

const oneLine = (s) => {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 3).replace(/\s+\S*$/, '') + '...' : t;
};

/**
 * A pane's program, from the pane as the ravenryd adapter lists it
 * ({ id, paneId, machine, cwd, shell, agent }), or null when no program in
 * it says working, blocked, done or error. An older daemon keeps no
 * `program`: its working and needs_you from a program's own report count
 * (done and error read as idle there, so they are not shown).
 */
export function fromTab(tab) {
  const a = tab && tab.agent;
  if (!a || !tab.paneId) return null;
  let p = a.program || null;
  if (!p && a.source === 'program' && (a.state === 'working' || a.state === 'needs_you')) {
    p = { state: a.state === 'working' ? 'working' : 'blocked', kind: a.need ? a.need.kind : null, message: a.need ? a.need.message : null, app: a.assistant, since: a.since };
  }
  if (!p || !STATE[p.state]) return null;
  const sh = tab.shell || null;
  const state = STATE[p.state];
  // Done or failed after its record said working: the daemon read it from
  // the command's exit status (it said nothing itself).
  const byStatus = (state === 'done' || state === 'failed') && a.source === 'daemon';
  return {
    pane: tab.paneId,
    surfaceId: tab.id,
    machine: tab.machine || null,
    state,
    kind: state === 'blocked' ? (KINDS.has(p.kind) ? p.kind : 'other') : null,
    progress: Number.isInteger(p.progress) && p.progress >= 0 && p.progress <= 100 ? p.progress : null,
    message: oneLine(p.message) || null,
    app: p.app && p.app !== 'program' ? String(p.app) : null,
    command: oneLine(sh && sh.command) || null,
    exitCode: byStatus && sh && Number.isInteger(sh.exit_code) ? sh.exit_code : null,
    byStatus,
    cwd: tab.cwd || null,
    since: p.since || a.since || null,
  };
}

/** What the person calls it: its command line, else its app's name. */
export const nameOf = (rec) => rec.command || rec.app || 'Program';

// ------------------------------------------------------------ seen

let seen = null; // `${machine}|${pane}` -> the since of the done or failed record seen

const keyOf = (rec) => `${rec.machine || ''}|${rec.pane}`;

function loadSeen() {
  if (seen) return seen;
  seen = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    for (const [k, v] of Object.entries(j && typeof j === 'object' ? j : {})) if (typeof v === 'string') seen.set(k, v);
  } catch { /* none yet */ }
  return seen;
}

function saveSeen() {
  try {
    assertDataWrite(SEEN_FILE);
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    const tmp = SEEN_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(loadSeen())) + '\n');
    fs.renameSync(tmp, SEEN_FILE);
  } catch (e) { console.error('programs: could not save what was seen:', e.message); }
}

/** Done or failed, and not seen yet: its row stays. */
export function held(rec) {
  return (rec.state === 'done' || rec.state === 'failed') && loadSeen().get(keyOf(rec)) !== (rec.since || '');
}

/** Whether the board shows it: working and blocked always, done and failed until seen. */
export const shown = (rec) => rec.state === 'working' || rec.state === 'blocked' || held(rec);

/** The person saw a done or failed program: its row goes. Returns whether it was held. */
export function markSeen(rec) {
  if (!held(rec)) return false;
  loadSeen().set(keyOf(rec), rec.since || '');
  saveSeen();
  return true;
}

/** Forgets what was seen of panes no longer listed (their records are gone). */
export function prune(recs) {
  const s = loadSeen();
  const live = new Set(recs.map(keyOf));
  let n = 0;
  for (const k of [...s.keys()]) if (!live.has(k)) { s.delete(k); n++; }
  if (n) saveSeen();
}

export function _reset() { seen = null; }

// ------------------------------------------------------------ projects

const inside = (folder, dir) => !!folder && !!dir && (dir === folder || dir.startsWith(folder.endsWith('/') ? folder : folder + '/'));

/**
 * The project whose folder it runs in: the deepest folder that holds its
 * working folder, on its machine; null when none does.
 */
export function ownerOf(rec, projects) {
  let best = null;
  for (const p of projects || []) {
    if (p.hidden || !p.folder || (p.machine || null) !== (rec.machine || null)) continue;
    if (!inside(p.folder, rec.cwd)) continue;
    if (!best || p.folder.length > best.folder.length) best = p;
  }
  return best;
}

/**
 * The card of a program in no project's folder, as a session in no project
 * gets (index.mjs looseSessions): its own id, named after its folder, with
 * no folder of its own and nothing written to the registry.
 */
export function looseCard(rec, taken) {
  let id = 'program-' + rec.pane;
  while (taken.has(id)) id += '-p';
  taken.add(id);
  const name = (rec.cwd && path.basename(rec.cwd)) || nameOf(rec);
  return { id, name, folder: null, workspaces: [], brief: null, waitingOn: null, loose: true, sessionIds: [], programPane: rec.pane, programMachine: rec.machine || null, cwd: rec.cwd || null };
}

// ------------------------------------------------------------ words

function ago(now, iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// What a block waits for, in the words after its name ("npm run deploy
// needs you to sign in").
export const NEED_WORDS = { auth: 'needs you to sign in', permission: 'needs your permission', question: 'asks you something', other: 'needs you' };
// The same in the reason line ("it said it waits for you to sign in").
const SAID = { auth: 'it waits for you to sign in', permission: 'it waits for your permission', question: 'it asks you something', other: 'it waits for you' };

/** Its session state: working, blocked, or idle for done and failed (held). */
export const sessionState = (rec) => (rec.state === 'working' ? 'working' : rec.state === 'blocked' ? 'blocked' : 'idle');

/** The reason line's source and words (the board says "From the program: ..."). */
export function reason(rec, now) {
  const when = ago(now, rec.since);
  const at = when ? `, ${when}` : '';
  if (rec.byStatus) return { source: 'shell', text: `its command ended with status ${rec.exitCode ?? '?'}${at}` };
  if (rec.state === 'blocked') return { source: 'program', text: `it said ${SAID[rec.kind] || SAID.other}${at}` };
  if (rec.state === 'done') return { source: 'program', text: `it said it is done${at}` };
  if (rec.state === 'failed') return { source: 'program', text: `it said it failed${at}` };
  return { source: 'program', text: `it said it is working${rec.progress != null ? `, ${rec.progress}%` : ''}${at}` };
}

/** The words of its row and card (the shape of server/state.mjs describe). */
export function words(rec) {
  const name = nameOf(rec);
  const msg = rec.message;
  const out = { line: '', headline: '', quick: [], question: null, dialog: null, draft: null };
  if (rec.state === 'blocked') {
    out.line = `${name}: ${msg || NEED_WORDS[rec.kind] || NEED_WORDS.other}`;
    out.headline = msg || `${name} ${NEED_WORDS[rec.kind] || NEED_WORDS.other}`;
  } else if (rec.state === 'working') {
    out.line = `${name}: ${msg || (rec.progress != null ? `${rec.progress}%` : 'working')}`;
    out.headline = msg || `${name} is working`;
  } else {
    const word = rec.state === 'done' ? 'done' : 'failed';
    out.line = `${name} ${word}${msg ? `: ${msg}` : ''}`;
    out.headline = msg || `${name} ${word}`;
  }
  return out;
}

/** What the state carries of it (state.projects[].sessions[].program). */
export function view(rec, folderShort) {
  return {
    pane: rec.pane, machine: rec.machine, state: rec.state, kind: rec.kind, progress: rec.progress,
    message: rec.message, command: rec.command, app: rec.app, since: rec.since,
    folder: folderShort || null, held: rec.state === 'done' || rec.state === 'failed',
    exitCode: rec.exitCode,
  };
}
