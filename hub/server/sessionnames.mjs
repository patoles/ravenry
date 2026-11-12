// Session names (2026-11-10, the maintainer: a way to link to a session). Claude Code
// gives each running session a name other sessions use for it ("ravenry-19",
// "lighthouse-8e"): <CLAUDE_CONFIG_DIR or ~/.claude>/sessions/<pid>.json
// holds it with the process's pid. The hook events record that pid
// (claude_pid), so a name is the session the events of that process name
// (the newest since the process started), else the session id the file
// gives. The file goes when the process ends; the board keeps the name
// (<RAVENRY_HOME>/session-names.json, 14 days), so a hand-off that names a
// session still finds it after it ended.
//
// A name resolves to its live session first (a process that still runs and
// still bears the name), else the newest session that had it.
//
// The Mac app reads the table (GET /api/session-names, read again when the
// state's sessionNames.rev changes) and draws each name and session id it
// knows as a link in terminal text; a click opens that session's tab. The
// names are never shown as such (the maintainer, 2026-11-10: "that's not useful for
// the user").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RAVENRY_HOME, assertDataWrite } from './home.mjs';

export const STORE_FILE = path.join(RAVENRY_HOME, 'session-names.json');
export const KEEP_MS = 14 * 24 * 3600 * 1000;
const MAX = 2000;
// A name only of the characters a terminal link is cut from, with a dash
// inside: a plain word ("ravenry") is never a name, so ordinary text never
// becomes a link.
export const NAME = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

// The name files, read again only when one changed: [{ pid, sessionId,
// name, startedAt }]. `cache` (a Map) keeps each file's last read.
export function readNameFiles(dir = sessionsDir(), cache = new Map()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { cache.clear(); return []; }
  const out = [];
  const seen = new Set();
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    const p = path.join(dir, f);
    seen.add(p);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const c = cache.get(p);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) { if (c.rec) out.push(c.rec); continue; }
    let rec = null;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const pid = Number(j.pid) || Number(f.slice(0, -5));
      const name = typeof j.name === 'string' ? j.name.trim() : '';
      if (pid > 1 && NAME.test(name) && name.length <= 80) {
        rec = { pid, name, sessionId: UUID.test(String(j.sessionId || '')) ? String(j.sessionId).toLowerCase() : null, startedAt: Number(j.startedAt) || null };
      }
    } catch { /* half written */ }
    cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, rec });
    if (rec) out.push(rec);
  }
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return out;
}

// The session a name file's process runs now: the newest session its hook
// events name with that pid since the process started, else the file's own.
export function sessionOf(file, evAll) {
  let best = null;
  const born = file.startedAt ? file.startedAt - 2000 : 0;
  for (const e of (evAll && evAll.values ? evAll.values() : [])) {
    if (e.pid !== file.pid || !e.pidAt) continue;
    if (Date.parse(e.pidAt) < born) continue;
    if (!best || e.pidAt > best.pidAt) best = e;
  }
  return (best && best.sessionId) || file.sessionId || null;
}

// The store: { records: [{ name, sessionId, pid, firstAt, lastAt }] }, one
// per name and session (a session continued later may get another name;
// the old name still finds it).
export function load(file = STORE_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const records = (Array.isArray(j.records) ? j.records : []).filter((r) => r && NAME.test(String(r.name || '')) && UUID.test(String(r.sessionId || '')));
    return { records, savedAt: Date.now(), dirty: false };
  } catch { return { records: [], savedAt: 0, dirty: false }; }
}

export function save(store, file = STORE_FILE) {
  try {
    assertDataWrite(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const records = store.records.map(({ name, sessionId, pid, firstAt, lastAt }) => ({ name, sessionId, pid, firstAt, lastAt }));
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, records }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    store.dirty = false;
    store.savedAt = Date.now();
  } catch (e) { console.error('session names:', e.message); }
}

// One tick: the name files read now (`files`), the sessions' events
// (`evAll`, events.scan) and the pids of the assistant processes running
// (`livePids`, a Set; null while the board has not listed them yet, then
// every file counts as live). Marks each record live or not and returns
// whether the table changed (a name came, went live or ended).
export function note(store, files, evAll, livePids, now = Date.now()) {
  let changed = false;
  const live = new Set();
  for (const f of files) {
    if (livePids && !livePids.has(f.pid)) continue;
    const sid = sessionOf(f, evAll);
    if (!sid) continue;
    let r = store.records.find((x) => x.name === f.name && x.sessionId === sid);
    if (!r) {
      r = { name: f.name, sessionId: sid, pid: f.pid, firstAt: now, lastAt: now };
      store.records.push(r);
      store.dirty = true;
      changed = true;
    }
    if (r.pid !== f.pid) { r.pid = f.pid; store.dirty = true; }
    // The time it was last seen live, saved once a minute at most.
    if (now - r.lastAt > 60000) { r.lastAt = now; store.dirty = true; }
    live.add(r);
  }
  for (const r of store.records) {
    const was = !!r.live;
    r.live = live.has(r);
    if (was !== r.live) changed = true;
  }
  const keep = store.records.filter((r) => r.live || now - r.lastAt < KEEP_MS).sort((a, b) => a.lastAt - b.lastAt).slice(-MAX);
  if (keep.length !== store.records.length) { store.records = keep; store.dirty = true; changed = true; }
  if (changed) store.rev = (store.rev || 0) + 1;
  return changed;
}

// The session a name stands for: its live one, else the newest that had it.
const better = (r, best) => !best || (r.live && !best.live) || (!!r.live === !!best.live && r.lastAt > best.lastAt);
export function resolve(store, name) {
  let best = null;
  for (const r of store.records) if (r.name === name && better(r, best)) best = r;
  return best;
}

// Every name, resolved: { name: { sessionId, projectId, live } }.
// `projectOf(sessionId)` is the project the board gives that session (null
// when none: the app then opens it only if the board shows it).
export function table(store, projectOf = () => null) {
  const best = new Map();
  for (const r of store.records) if (better(r, best.get(r.name))) best.set(r.name, r);
  const out = {};
  for (const [name, r] of best) out[name] = { sessionId: r.sessionId, projectId: projectOf(r.sessionId) || null, live: !!r.live };
  return out;
}
