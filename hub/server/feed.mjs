// The board's live feed for programs on this computer: GET /api/feed, what
// `ravenry events` (daemon/cmd/ravenryd/events.go) follows besides the
// daemons it reaches itself. Server-sent events, on 127.0.0.1 only:
//
//   event: board    data: one of the board's own events, as the CLI prints it
//                         ({ event, at, machine, ... }): session.started,
//                         session.ended, session.needs_you,
//                         session.needs_you_cleared, handoff.ready, and
//                         daemon.up / daemon.down for another machine's
//                         connection (machines.mjs)
//   event: daemon   data: { machine, daemon, event }: a raw event of another
//                         machine's daemon (the CLI cannot reach those; it
//                         reads this machine's daemons itself, so this
//                         machine's are never relayed and nothing is said
//                         twice)
//
// The event names are API (packages/protocol/PROTOCOL.md, "The feed for
// agents"). A card's answer is never relayed (only its asker gets it, from
// its own daemon), and neither is a secret, a command's environment or a
// pick's files.
//
// The board's own events come from the state each tick builds: a session's
// group in the sidebar (sidebar.mjs: dialog, asked, draft, handback, or an
// open card's mark, is Needs you) and its hand-off's state. The first full
// read is the baseline and says nothing; a tick that could not read every
// terminal (fullRead false) is skipped, so a session it misses does not
// look ended.

import { sessionGroup, sessionKey } from './sidebar.mjs';

const subs = new Set();
const PANE_RE = /^ravenry:(p[a-z2-7]{7})$/;

/** Adds a reader: the request and its response, held open until it goes. */
export function add(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': ravenry feed 1\n\n');
  subs.add(res);
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  req.on('close', () => { subs.delete(res); clearInterval(hb); });
}

/** How many read it now. */
export const readers = () => subs.size;

function send(type, obj) {
  if (!subs.size) return;
  const s = `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
  for (const r of subs) { try { r.write(s); } catch { /* gone: its close removes it */ } }
}

const stamp = (ms = Date.now()) => new Date(ms).toISOString();

// ------------------------------------------------------------ other machines

// The daemon events the feed says (the rest, pane.input, pane.lease,
// agent.decision, ..., stay between the daemon and the board).
const RELAYED = new Set(['pane.created', 'pane.title', 'pane.cwd', 'pane.prompt', 'pane.updated', 'pane.exited', 'pane.closed', 'agent.report', 'checkpoint.opened', 'checkpoint.running', 'checkpoint.closed', 'daemon.draining']);

/** A remote daemon's event (server/ravenryd.mjs follow): relayed, without what only its asker may read. */
export function relayDaemon(e, { machine = null, version = null } = {}) {
  if (!machine || !e || !RELAYED.has(e.event)) return;
  const out = { v: e.v, type: 'event', event: e.event };
  if (e.pane) out.pane = e.pane;
  if (e.newer) out.newer = e.newer;
  if (e.report) { const { data: _data, ...rest } = e.report; out.report = rest; }
  if (e.checkpoint) {
    // Kept: what the card is and how it ended. Never its answer, its run,
    // a command's environment, a secret's target or a pick's files.
    const { answer: _a, run: _r, env: _e, secret: _s, variants: _v, drive: _d, command: _c, ...rest } = e.checkpoint;
    out.checkpoint = rest;
  }
  send('daemon', { machine, daemon: version, event: out });
}

/** A machine's connection came up or went down (server/machines.mjs). */
export function machine(name, up, version = null) {
  if (!name) return;
  send('board', { event: up ? 'daemon.up' : 'daemon.down', at: stamp(), machine: name, ...(version ? { daemon: version } : {}) });
}

// ------------------------------------------------------------ the board's own

/** Each session on the board, by its tab: what the feed compares tick to tick. */
export function sessionsOf(projects, marks = new Map()) {
  const out = new Map();
  for (const p of projects || []) for (const s of p.sessions || []) {
    if (!s || !s.surfaceId || out.has(s.surfaceId)) continue;
    const mark = marks.get(sessionKey(p.id, s)) || null;
    const needs = !s.handed && (mark ? true : sessionGroup(s) === 'you');
    const w = s.words || {};
    const pm = PANE_RE.exec(s.surfaceId);
    out.set(s.surfaceId, {
      session: s.sessionId || null,
      surface: s.surfaceId,
      pane: pm ? pm[1] : null,
      machine: s.machine || p.machine || 'local',
      project: p.id,
      project_name: p.name || null,
      assistant: s.assistant || null,
      name: s.topic || null,
      needs,
      why: needs ? (mark ? mark.kind : s.state) || null : null,
      line: needs ? (mark ? mark.text : w.question || w.line || null) || null : null,
      handoff: s.handoff && s.handoff.state === 'written' ? { file: s.handoff.file || null } : null,
    });
  }
  return out;
}

function eventOf(name, s, at) {
  const e = { event: name, at, machine: s.machine };
  for (const k of ['session', 'surface', 'pane', 'project', 'project_name', 'assistant', 'name']) if (s[k]) e[k] = s[k];
  if (name === 'session.needs_you') { if (s.why) e.why = s.why; if (s.line) e.line = String(s.line).replace(/\s+/g, ' ').trim().slice(0, 300); }
  if (name === 'handoff.ready' && s.handoff) e.handoff = s.handoff;
  return e;
}

/** The events between two looks at the board's sessions (pure: tested on its own). */
export function diff(prev, next, at = stamp()) {
  const out = [];
  const gone = (o) => { if (o.needs) out.push(eventOf('session.needs_you_cleared', o, at)); out.push(eventOf('session.ended', o, at)); };
  const came = (n) => { out.push(eventOf('session.started', n, at)); if (n.needs) out.push(eventOf('session.needs_you', n, at)); if (n.handoff) out.push(eventOf('handoff.ready', n, at)); };
  for (const [k, n] of next) {
    const o = prev.get(k);
    // A new session in the same tab (a /clear): the old one ended.
    if (!o || (o.session && n.session && o.session !== n.session)) {
      if (o) gone(o);
      came(n);
      continue;
    }
    if (!o.needs && n.needs) out.push(eventOf('session.needs_you', n, at));
    if (o.needs && !n.needs) out.push(eventOf('session.needs_you_cleared', n, at));
    if (!o.handoff && n.handoff) out.push(eventOf('handoff.ready', n, at));
  }
  for (const [k, o] of prev) if (!next.has(k)) gone(o);
  return out;
}

let last = null;

/** Called with each fully read tick's projects and the sidebar's marks. */
export function observe(projects, marks, now = Date.now()) {
  const next = sessionsOf(projects, marks);
  if (last) for (const e of diff(last, next, stamp(now))) send('board', e);
  last = next;
}
