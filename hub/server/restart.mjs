// Resume after a restart (SESS-053). The hub keeps a file of the sessions
// running on this computer, rewritten as they change (a power cut gives no
// warning, so it is never left to the moment of shutdown), with the time
// this computer started. At the hub's next start:
//
// - a different start time means the computer restarted: every session in
//   the file that is not running now is offered on one card, "N sessions
//   were running before the restart", with Resume all and Resume one by one;
// - the same start time means only the hub or the app restarted (the panes
//   still run in ravenryd): no card.
//
// The hub decides everything here; the clients draw `cardView` and post the
// person's clicks (POST /api/restart/resume, /api/restart/dismiss).
//
// Files, in RAVENRY_HOME:
//   running.json  { boot, writtenAt, sessions: [entry] }, entry:
//                 { sessionId, assistant, model, folder, projectId, project,
//                   topic, startedAt, lastSeenAt, working, doing, goneAt? }
//   restart.json  the offer the card shows, until it is dismissed or every
//                 session is back: { boot, restartedAt, rows: [entry + state],
//                 doneAt?, midTurn: { sessionId: resumedAt } }
//
// A session that stops showing is kept GONE_MS before it leaves the file,
// so a restart (whose shutdown ends the sessions a moment before the hub)
// never empties it; one the person ended (/exit, /clear, the board's Close)
// leaves at once.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RAVENRY_HOME } from './registry.mjs';
import { t } from './strings.mjs';
import { modelView } from './models.mjs';

export const RUNNING_PATH = path.join(RAVENRY_HOME, 'running.json');
export const OFFER_PATH = path.join(RAVENRY_HOME, 'restart.json');
export const GONE_MS = 60000;
// How often the file is written again when only the times moved.
export const REWRITE_MS = 30000;
// A card whose sessions are all back is cleared this long after.
export const DONE_KEEP_MS = 60000;
// SessionEnd reasons that are the person's own end of a session (Claude Code's hooks).
const PERSON_ENDS = new Set(['prompt_input_exit', 'clear', 'logout']);

// ------------------------------------------------------------ the boot time

/** `sysctl -n kern.boottime` on macOS: "{ sec = 1732170000, usec = 0 } Thu ...". Seconds, or null. */
export function parseBoottime(text) {
  const m = /\bsec\s*=\s*(\d+)/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** /proc/stat on Linux: its "btime 1732170000" line. Seconds, or null. */
export function parseBtime(text) {
  const m = /^btime\s+(\d+)\s*$/m.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/**
 * When this computer started, in seconds since 1970, or null when it cannot
 * be read. MC_BOOT_TIME stands in for it (a test board's restart).
 */
export function bootTime({ env = process.env, platform = process.platform } = {}) {
  if (env.MC_BOOT_TIME && /^\d+$/.test(env.MC_BOOT_TIME)) return Number(env.MC_BOOT_TIME);
  try {
    if (platform === 'darwin') return parseBoottime(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 3000 }));
    if (platform === 'linux') return parseBtime(fs.readFileSync('/proc/stat', 'utf8'));
  } catch { /* unknown */ }
  return null;
}

// ------------------------------------------------------------ files

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const okEntry = (e) => e && typeof e === 'object' && UUID.test(String(e.sessionId || ''));

/** The running file, or an empty one. */
export function readRunning(p = RUNNING_PATH) {
  const j = readJson(p);
  return { boot: j && Number.isFinite(j.boot) ? j.boot : null, writtenAt: (j && j.writtenAt) || null, sessions: j && Array.isArray(j.sessions) ? j.sessions.filter(okEntry) : [] };
}

// ------------------------------------------------------------ at the hub's start

/**
 * What the hub starts with: the offer to show (or null), and the running
 * list to keep. `running`: the file as it was; `offer`: restart.json as it
 * was; `boot`: this computer's start time now.
 */
export function atStart({ running, offer, boot, now = Date.now() }) {
  // Started again on the same boot, mid-offer (the app's update): the same card.
  const kept = offer && boot != null && offer.boot === boot && Array.isArray(offer.rows) ? { ...offer, midTurn: offer.midTurn || {} } : null;
  if (boot == null || running.boot == null || running.boot === boot) {
    return { offer: kept, sessions: running.boot === boot ? running.sessions : [] };
  }
  // A restart: what ran before it is offered, the list starts again.
  const rows = running.sessions.map((e) => ({ ...e, state: 'waiting' }));
  if (!rows.length) return { offer: null, sessions: [] };
  return { offer: { boot, restartedAt: new Date(boot * 1000).toISOString(), from: running.boot, madeAt: new Date(now).toISOString(), rows, midTurn: {} }, sessions: [] };
}

// ------------------------------------------------------------ each tick

/**
 * The running list after a look at what runs now. `prev`: the list;
 * `live`: entries for the sessions a process holds now (lastSeenAt now);
 * `ended(sid)`: the reason the session's last SessionEnd gives, when it
 * ended since it was last seen, else null; `closed`: ids the board closed.
 */
export function nextRunning(prev, live, { now = Date.now(), ended = () => null, closed = new Set() } = {}) {
  const out = [];
  const liveIds = new Set(live.map((e) => e.sessionId));
  for (const e of live) out.push({ ...e, goneAt: undefined });
  for (const e of prev) {
    if (liveIds.has(e.sessionId) || closed.has(e.sessionId)) continue;
    const why = ended(e.sessionId);
    if (why && PERSON_ENDS.has(why)) continue;
    const goneAt = e.goneAt || new Date(now).toISOString();
    if (now - Date.parse(goneAt) > GONE_MS) continue;
    out.push({ ...e, goneAt });
  }
  return out.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
}

/** Whether two lists differ in more than the times last seen. */
export function changed(a, b) {
  const key = (l) => JSON.stringify(l.map(({ lastSeenAt: _l, ...e }) => e).sort((x, y) => x.sessionId.localeCompare(y.sessionId)));
  return key(a) !== key(b);
}

// ------------------------------------------------------------ the words

/** "2 h 10 min", "45 min", "1 min". */
export function sayDuration(ms) {
  const m = Math.max(1, Math.round((Number(ms) || 0) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** "9:12": the hour and minutes of a time, here. */
export function sayClock(iso) {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const cut = (s, n) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 3).replace(/\s+\S*$/, '') + '...' : v; };

// "Rendering the frames" reads on after "Was working:" as "rendering the frames"; "README" and "npm test" stay.
const lowerLead = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s).replace(/\u2026$/, '');

/** A row's chip: "Claude Opus 5.5", "Codex gpt-5.4", else the assistant ("Claude Code"). */
export function chipOf(e) {
  const v = modelView(e.model, e.assistant);
  if (v.modelTitle) return v.modelTitle;
  return e.assistant === 'codex' ? 'Codex' : 'Claude Code';
}

/**
 * The card as clients draw it, or null. `offer`: restart.json; `queue`: the
 * ids waiting their turn, in order; `busy`: the id resuming now; `machine`:
 * "This Mac".
 */
export function cardView(offer, { queue = [], busy = null, machine = t('restart.machineMac') } = {}) {
  if (!offer || !Array.isArray(offer.rows) || !offer.rows.length) return null;
  const n = offer.rows.length;
  const time = sayClock(offer.restartedAt);
  const rows = offer.rows.map((r) => {
    const state = r.sessionId === busy ? 'resuming' : queue.includes(r.sessionId) ? 'next' : r.state === 'back' ? 'back' : r.state === 'failed' ? 'failed' : 'waiting';
    const ranMs = Date.parse(r.lastSeenAt || r.startedAt) - Date.parse(r.startedAt || r.lastSeenAt);
    return {
      sessionId: r.sessionId, projectId: r.projectId || null, project: r.project || path.basename(r.folder || '') || r.sessionId.slice(0, 8),
      topic: r.topic || null, assistant: r.assistant || 'claude', model: r.model || null, chip: chipOf(r),
      ran: Number.isFinite(ranMs) && r.startedAt ? t('restart.ran', { duration: sayDuration(ranMs) }) : null,
      doing: r.working ? (r.doing ? t('restart.wasWorking', { what: lowerLead(cut(r.doing, 90)) }) : t('restart.wasWorkingNoLine')) : t('restart.atPrompt'),
      midTurn: !!r.working, midTurnTag: r.working ? t('restart.midTurn') : null, midTurnNote: r.working ? t('restart.midTurnNote') : null,
      state, stateWord: state === 'resuming' ? t('restart.resuming') : state === 'next' ? t('restart.next') : state === 'back' ? t('restart.back') : null,
      error: state === 'failed' ? r.error || t('restart.failed') : null,
      pane: r.pane || null, surfaceId: r.surfaceId || null,
    };
  });
  const back = rows.filter((r) => r.state === 'back').length;
  const running = !!busy || queue.length > 0;
  const allBack = back === n;
  const phase = allBack ? 'done' : running ? 'resuming' : 'offer';
  return {
    id: String(offer.boot), phase, count: n, back,
    title: t(n === 1 ? 'restart.titleOne' : 'restart.title', { n }),
    body: t(n === 1 ? 'restart.bodyOne' : 'restart.body', { machine, time }),
    bodyShort: t(n === 1 ? 'restart.bodyShortOne' : 'restart.bodyShort', { machine, time }),
    restartedAt: offer.restartedAt,
    rows,
    resume: t('restart.resume'), show: t('restart.show'),
    resumeAll: running ? t('restart.resumingOf', { i: Math.min(n, back + 1), n }) : t(n === 1 ? 'restart.resumeOne' : 'restart.resumeAll', { n }),
    resumeAllBusy: running,
    dismiss: t('restart.dismiss'), dismissNote: t('restart.dismissNote'),
    phoneNote: t('restart.phoneNote', { machine: machine === t('restart.machineMac') ? t('restart.yourMac') : t('restart.yourComputer') }),
    toast: allBack ? t(n === 1 ? 'restart.allBackOne' : 'restart.allBack', { n }) : null,
    doneAt: offer.doneAt || null,
  };
}

// ------------------------------------------------------------ the keeper

/**
 * The hub's side, holding the files. `boot`: this computer's start time
 * (bootTime()); `paths` for a test.
 */
export function keeper({ boot = bootTime(), running: runningPath = RUNNING_PATH, offer: offerPath = OFFER_PATH, now = Date.now(), log = console.log } = {}) {
  const was = readRunning(runningPath);
  const start = atStart({ running: was, offer: readJson(offerPath), boot, now });
  let offer = start.offer;
  let list = start.sessions;
  let writtenAt = 0;
  if (offer && boot !== was.boot && was.boot != null) log(`restart: this computer started at ${new Date(boot * 1000).toISOString()}, after ${new Date(was.boot * 1000).toISOString()}: ${offer.rows.length} session(s) were running before`);
  else if (boot != null && was.boot === boot) log(`restart: the same boot as before (${was.sessions.length} session(s) listed): only the hub restarted`);
  // Kept while it has rows or a session resumed mid-turn still waits for the person.
  const saveOffer = () => { if (offer && (offer.rows.length || Object.keys(offer.midTurn || {}).length)) writeJson(offerPath, offer); else { try { fs.unlinkSync(offerPath); } catch { /* none */ } } };
  const saveList = (t0) => { if (boot == null) return; writeJson(runningPath, { boot, writtenAt: new Date(t0).toISOString(), sessions: list }); writtenAt = t0; };
  saveOffer();
  // The list starts on this boot at once, so a second start never offers again.
  saveList(now);
  // Checked once the first process list is in: what runs already is not offered.
  let firstLook = true;
  const midTurn = new Map(Object.entries((offer && offer.midTurn) || {}));
  return {
    get boot() { return boot; },
    get offer() { return offer; },
    get sessions() { return list; },
    /** A look at what runs now: `live` entries, `ended`, `closed` (nextRunning). */
    observe(live, opts = {}) {
      const t0 = opts.now || Date.now();
      const next = nextRunning(list, live, { ...opts, now: t0 });
      const moved = changed(list, next);
      list = next;
      if (moved || t0 - writtenAt > REWRITE_MS) saveList(t0);
      if (offer && offer.rows.length) {
        const ids = new Set(live.map((e) => e.sessionId));
        // A session that runs again without the card (resumed by hand): off the card.
        const before = offer.rows.length;
        offer.rows = offer.rows.filter((r) => r.state === 'back' || !ids.has(r.sessionId) || opts.resuming === r.sessionId);
        if (firstLook || offer.rows.length !== before) {
          if (offer.rows.length !== before) log(`restart: ${before - offer.rows.length} of the sessions run again already, off the card`);
          saveOffer();
        }
        firstLook = false;
        // Every one back a minute ago: the card is done with.
        if (offer.doneAt && t0 - Date.parse(offer.doneAt) > DONE_KEEP_MS) { offer.rows = []; delete offer.doneAt; saveOffer(); }
      }
    },
    /** The board closed a session (Close idle): off the list at once. */
    forget(sid) {
      const n = list.length;
      list = list.filter((e) => e.sessionId !== sid);
      if (list.length !== n) saveList(Date.now());
    },
    row(sid) { return offer ? offer.rows.find((r) => r.sessionId === sid) || null : null; },
    /** The card's rows, in order (none: no card). */
    get rows() { return offer ? offer.rows : []; },
    /** A row's outcome: back (with its pane) or failed (with why). */
    settle(sid, r) {
      const row = this.row(sid);
      if (!row) return;
      Object.assign(row, r.ok ? { state: 'back', error: null, pane: r.pane || null, surfaceId: r.surfaceId || null, projectId: r.projectId || row.projectId, resumedAt: new Date().toISOString() } : { state: 'failed', error: r.error || null });
      if (r.ok && row.working) midTurn.set(sid, row.resumedAt);
      if (offer.rows.every((x) => x.state === 'back')) offer.doneAt = new Date().toISOString();
      offer.midTurn = Object.fromEntries(midTurn);
      saveOffer();
    },
    /** Dismiss: the card goes; the rows not back are returned for Recently closed. */
    dismiss() {
      if (!offer) return [];
      const left = offer.rows.filter((r) => r.state !== 'back');
      offer.rows = [];
      delete offer.doneAt;
      saveOffer();
      return left;
    },
    /** When a session resumed mid-turn waits for the person: its resume time, until they write to it. */
    midTurnSince(sid) { return midTurn.get(sid) || null; },
    /** The person wrote to it (or it works again): it waits no more. */
    midTurnDone(sid) {
      if (!midTurn.delete(sid)) return;
      if (offer) { offer.midTurn = Object.fromEntries(midTurn); saveOffer(); }
      if (offer && !offer.rows.length && !midTurn.size) offer = null;
    },
    get midTurnIds() { return [...midTurn.keys()]; },
  };
}
