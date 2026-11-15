// The sidebar, ready to draw: its sections, the projects in each, their rows
// and their order, sent in the board's state as `sidebar` (GET /api/state
// and each `state` event; also GET /api/sidebar). Every client (the desktop
// app, the phone, the native Mac app) draws it as it comes and decides
// nothing. Pure functions, tested in hub/tools/sidebar-test.mjs.
//
// The shape (docs/FEATURES.md, BRD rows; hub/docs/STATE-RULES.md, "The
// sidebar"):
//
//   sidebar: {
//     sections: [{
//       group: 'you' | 'work' | 'wait' | 'idle',
//       title: 'Needs you' | 'Working' | 'Waiting on others' | 'Idle',
//       count: number,              // its rows (a project with none counts 1)
//       projects: [{
//         id, name,                 // the project (its id in state.projects)
//         machine: string | null,   // a remote machine's name, null here
//         time: { at: ISO | null, style: 'clock' | 'ago' },
//         rows: [{                  // empty: the project is one line
//           key,                    // "<project id>/<surfaceId>"
//           surfaceId, name,
//           assistant: string | null,      // "Claude", "Codex"
//           model: string | null,          // "Opus 5.5", "gpt-5.4" (server/models.mjs)
//           modelShort: string | null,     // "Opus", "Codex": for a narrow sidebar
//           pct: number | null, pctWarn: boolean,
//           line: string | null,           // its question, one line
//           mark: { kind, text, code, label, since } | null,  // shown instead of line;
//                                          // label: the word before it ("Wants to run:")
//           group,                         // its dot's colour
//           machine: string | null,
//         }],
//       }],
//     }],
//     counts: { you, work, wait, idle },
//   }
//
// `time` is drawn by the client against its own clock: style 'clock' is the
// time of day today ("10:51"), else how long ago ("4 min", "2 h", "3 d");
// 'ago' is always how long ago ("now" under a minute). Each session in
// state.projects also carries `group`, the section of its own state.

import { assistantName, markLabel, markOf } from './cpwords.mjs';
import { t } from './strings.mjs';

// The section titles from the shared strings (shared/strings/en.json, group.*).
export const GROUP_TITLES = { you: t('group.you'), work: t('group.work'), wait: t('group.wait'), idle: t('group.idle') };
export const ORDER = ['you', 'work', 'wait', 'idle'];

const SESSION_GROUP = { dialog: 'you', asked: 'you', draft: 'you', handback: 'you', working: 'work' };

/** Which group a session's own state puts it in. */
export function sessionGroup(s) {
  return SESSION_GROUP[s.state] || (s.words && s.words.state) || 'idle';
}

export const sessionKey = (projectId, s) => `${projectId}/${s.surfaceId}`;

const PANE_ID = /^p[a-z2-7]{7}$/;

/** The ravenryd pane a session runs in ("ravenry:<pane id>"), else null. */
export function paneOf(s) {
  if (s.pane) return typeof s.pane === 'string' ? s.pane : s.pane.id;
  const id = s.surfaceId || '';
  if (id.startsWith('ravenry:') && PANE_ID.test(id.slice(8))) return id.slice(8);
  return null;
}

export function machineOf(p, s) {
  const m = (s && s.machine) || p.machine || null;
  return m && m !== 'local' ? m : null;
}

/**
 * A session already working in a folder's project on this machine, if any:
 * not handed, not idle, not in a worktree still open. A new session there
 * gets its own copy of the code (a worktree) unless asked to work in the
 * folder. Moved from the desktop's busyIn (app.ts) so both apps say the same;
 * GET /api/setup/start puts it on each folder as `busy`.
 */
export function busyIn(projects, folder) {
  if (typeof folder !== 'string' || !folder) return null;
  for (const p of projects || []) {
    if (!p.folder || (folder !== p.folder && !folder.startsWith(p.folder + '/')) || p.machine) continue;
    const s = (p.sessions || []).find((x) => !x.handed && !machineOf(p, x) && sessionGroup(x) !== 'idle' && !(x.worktree && x.worktree.state === 'open'));
    if (s) return { projectId: p.id, project: p.name, topic: s.topic || p.name };
  }
  return null;
}

const OPEN = new Set(['open', 'running']);

/** Each session's group, on the session itself (state.projects[].sessions[].group). */
export function withGroups(projects) {
  for (const p of projects || []) for (const s of p.sessions || []) s.group = sessionGroup(s);
  return projects;
}

/** A pane's name as the sidebar says it: its session's topic, else its project's name; null when no session runs in it. */
export function paneNameIn(projects, pane) {
  if (!pane) return null;
  for (const p of projects || []) for (const s of p.sessions || []) if (paneOf(s) === pane) return s.topic || p.name;
  return null;
}

/**
 * The marks on the rows, by session key: a worktree session done with
 * files to review (`reviewFiles(session)` gives their number, or null), then
 * every open checkpoint on the session whose pane asked (by its project and
 * session, else by its pane and machine), oldest first; a checkpoint wins
 * over a review mark, and the first checkpoint over a later one.
 */
export function marksOf(projects, checkpoints, { reviewFiles = () => null, now = Date.now() } = {}) {
  const out = new Map();
  for (const p of projects || []) for (const s of p.sessions || []) {
    const n = reviewFiles(s);
    if (n) out.set(sessionKey(p.id, s), { kind: 'review', text: `Done. ${n} file${n === 1 ? '' : 's'} to review`, code: false, label: markLabel('review'), since: s.since || new Date(now).toISOString() });
  }
  const open = (checkpoints || []).filter((cp) => cp && OPEN.has(cp.state)).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const target = (cp) => {
    if (cp.projectId && cp.surfaceId) {
      const p = (projects || []).find((x) => x.id === cp.projectId);
      if (p && p.sessions.some((s) => s.surfaceId === cp.surfaceId)) return `${cp.projectId}/${cp.surfaceId}`;
    }
    if (cp.pane) for (const p of projects || []) for (const s of p.sessions || []) {
      if (paneOf(s) === cp.pane && ((s.machine || p.machine || null) === (cp.machine || null))) return sessionKey(p.id, s);
    }
    return null;
  };
  for (const cp of open) {
    const t = target(cp);
    if (!t || (out.has(t) && out.get(t).kind !== 'review')) continue;
    const name = cp.drive ? (cp.drive.name || paneNameIn(projects, cp.drive.pane)) : null;
    out.set(t, { ...markOf(cp, name), since: cp.created_at });
  }
  return out;
}

function row(p, s, threshold, mark) {
  const pct = s.ctx && Number.isFinite(s.ctx.pct) ? Math.round(s.ctx.pct) : null;
  const g = mark ? 'you' : sessionGroup(s);
  const w = s.words || {};
  const line = g === 'you' && !mark ? (w.question || w.line || null) : null;
  return {
    key: sessionKey(p.id, s),
    surfaceId: s.surfaceId,
    name: s.topic || p.name,
    assistant: assistantName(s.assistant),
    // The model its transcript last named (server/models.mjs): whole where
    // the row is wide ("Opus 5.5", "gpt-5.4"), its family where it is
    // narrow ("Opus", "Codex"); null until it named one (the assistant then).
    model: s.modelName || null,
    modelShort: s.modelShort || null,
    pct,
    pctWarn: pct !== null && pct >= threshold,
    line: line ? String(line).replace(/\s+/g, ' ').trim() : null,
    mark,
    group: g,
    machine: machineOf(p, s),
  };
}

/**
 * The sidebar: Needs you first, then Working, Waiting on others and Idle,
 * newest first in each. Each session sits in the section of its own state
 * (2026-11-08: a session done and waiting for you showed under Working,
 * beside its project's working one), so a project can be in more than one
 * section, its header in each. A project in a section for its own reason
 * (a brief waiting on someone, a plan gate) with no session of that state
 * shows its main session there. A project with every session idle is one
 * line in Idle; an idle session of a project at work is a row there under
 * its project. A section's count is its rows (one at least a project). A
 * session with an open checkpoint (marks, by session key) needs you
 * whatever its own state says, and its project's time there is when it
 * started waiting.
 */
export function build(projects, { threshold = 50, marks = new Map(), now = Date.now() } = {}) {
  const by = new Map();
  const since = new Map();
  for (const p of projects || []) {
    const live = (p.sessions || []).filter((s) => !s.handed);
    const markOf = (s) => marks.get(sessionKey(p.id, s)) || null;
    const own = (s) => (markOf(s) ? 'you' : sessionGroup(s));
    const g = live.some(markOf) ? 'you' : ORDER.includes(p.state) ? p.state : 'idle';
    const add = (k, sessions) => {
      const marked = sessions.map((s) => markOf(s)).filter(Boolean);
      const first = marked.map((m) => Date.parse(m.since)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const time = first !== undefined
        ? { at: new Date(first).toISOString(), style: 'clock' }
        : { at: p.since || null, style: p.state === 'you' || p.state === 'wait' ? 'clock' : 'ago' };
      const pr = { id: p.id, name: p.name, machine: machineOf(p), time, rows: sessions.map((s) => row(p, s, threshold, markOf(s))) };
      since.set(pr, first !== undefined ? first : p.since ? Date.parse(p.since) : now);
      by.set(k, [...(by.get(k) || []), pr]);
    };
    if (g === 'idle') { add('idle', []); continue; }
    const buckets = new Map();
    for (const s of live) buckets.set(own(s), [...(buckets.get(own(s)) || []), s]);
    // In its section for its own reason: its main session there.
    if (!(buckets.get(g) || []).length) {
      const main = live.find((s) => s.surfaceId === p.primary) || null;
      if (main) buckets.set(own(main), (buckets.get(own(main)) || []).filter((s) => s !== main));
      buckets.set(g, main ? [main] : []);
    }
    for (const k of ORDER) { const list = buckets.get(k); if (list && (list.length || k === g)) add(k, list); }
  }
  const counts = { you: 0, work: 0, wait: 0, idle: 0 };
  const sections = ORDER.filter((g) => by.has(g)).map((g) => {
    const list = by.get(g).sort((a, b) => since.get(b) - since.get(a));
    const count = list.reduce((n, pr) => n + Math.max(pr.rows.length, 1), 0);
    counts[g] = count;
    return { group: g, title: GROUP_TITLES[g], count, projects: list };
  });
  return { sections, counts };
}
