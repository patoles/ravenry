// The built-in providers of page files (packages/page-format,
// schema/providers-1.json): one adapter per provider id, each building its
// items in the contract's field names from what the hub already computes.
// Their field names freeze at the public launch; a field with no value is
// left out, so `has:` works on all of them.
//
//   projects    the board's projects (index.mjs buildProject, the snapshot)
//   brief       each project's BRIEF.md (brief.mjs readBrief, in the snapshot)
//   plans       every plan in every brief, through planfmt.mjs derive
//   plan-files  the PLAN, ROADMAP and TODO files (plans.mjs plansFor)
//   git         one per repository (ship.mjs shipView), with the Ship
//               card's status line as `status` and `status_text`
//   rule-files  every rules file (rulefiles.mjs scopes)
//   repeats     the Suggested rules (repeats.mjs view)
//   sessions    the Sessions page's rows (index.mjs buildSessions)
//
// Ravenry's own pieces (ravenry:objective-rows, ravenry:plan-row) need more
// than the frozen fields: those ride along in `$ravenry`, a key no field can
// have (field names start with a letter), so no page can name it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { derive } from './planfmt.mjs';
import { rowModel } from '../public/plan-view.js';
import { sayPath } from '../public/homepath.mjs';
import { sayFolder, sayLocal } from './homes.mjs';

const HOME = os.homedir();
const short = (p) => sayPath(p, HOME);

// Drops the keys with no value, so `has:` and `not: { has: }` tell them apart.
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

const TASK_STATES = new Set(['done', 'now', 'you', 'wait', 'todo']);
const taskState = (s) => (TASK_STATES.has(s) ? s : 'todo');

// An objective as a whole: done when every task is, else the most urgent of
// its tasks' states.
function objectiveState(tasks) {
  if (!tasks.length) return 'todo';
  if (tasks.every((t) => t.state === 'done')) return 'done';
  for (const s of ['you', 'now', 'wait']) if (tasks.some((t) => t.state === s)) return s;
  return 'todo';
}

const lower = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

// The Objectives card's rows, as the board draws them (public/app.js
// objRow and planRow): the brief's objectives, the running plan's row in its
// place, then the plan files.
function objectiveRows(p) {
  const rows = [];
  for (const o of (p.brief && p.brief.plan) || []) {
    if (p.plan && o.plan && o.title === p.plan.title) {
      const m = rowModel(p.plan);
      rows.push({ kind: 'plan', title: o.title, dots: m.dots, count: m.count, next: m.next, wash: m.wash });
      continue;
    }
    const tasks = (o.tasks || []).map((t) => ({ text: t.text, state: taskState(t.state) }));
    if (tasks.length) {
      const done = tasks.filter((t) => t.state === 'done').length;
      const nxt = tasks.find((t) => t.state !== 'done');
      const next = !nxt ? 'Done' : nxt.state === 'you' ? 'Next: you' : nxt.state === 'wait' ? 'Next: someone else' : 'Next: ' + lower(nxt.text);
      rows.push({ kind: 'tasks', title: o.title, plan: !!o.plan, tasks, count: `${done} of ${tasks.length}`, next });
    } else {
      rows.push({ kind: 'none', title: o.title, plan: !!o.plan });
    }
  }
  for (const f of p.plans || []) {
    rows.push({ kind: 'file', title: f.title, done: f.done, total: f.total, count: `${f.done} of ${f.total}`, updated: f.updatedAt || null, source: f.source || null });
  }
  return rows;
}

function newest(...dates) {
  const ts = dates.filter(Boolean).map((d) => ({ d, t: Date.parse(d) })).filter((x) => !Number.isNaN(x.t)).sort((a, b) => b.t - a.t);
  return ts.length ? new Date(ts[0].t).toISOString() : null;
}

function mtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

function briefFields(b) {
  if (!b) return null;
  return clean({
    path: b.path, goal: b.goal, done_means: b.doneMeans, kind: b.kind, stage: b.stage, next: b.next,
    waiting_on: b.waitingOn, status: b.status, draft: b.draft ? true : undefined,
  });
}

function objectivesOf(b) {
  return ((b && b.plan) || []).map((o) => {
    const tasks = (o.tasks || []).map((t) => clean({ text: t.text, state: taskState(t.state) }));
    return clean({ title: o.title, state: objectiveState(tasks), done: tasks.filter((t) => t.state === 'done').length, total: tasks.length, plan: !!o.plan, tasks });
  });
}

const picUrl = (pid, pic) => (pic && pic.url ? pic.url : pic && pic.path ? `/api/pic/${encodeURIComponent(pid)}?p=${encodeURIComponent(pic.path)}` : null);

// ---------------------------------------------------------------- projects

export function projects(ctx) {
  return (ctx.projects || []).filter((p) => !p.unowned && !p.loose).map((p) => {
    const b = p.brief;
    const plan = p.plan ? clean({ title: p.plan.title, state: ['running', 'gate', 'paused'].includes(p.plan.state) ? p.plan.state : 'running', step: p.plan.current, total: p.plan.total, question: p.plan.gate ? p.plan.gate.question : null }) : null;
    const planFiles = (p.plans || []).map((f) => clean({ title: f.title, source: f.source, done: f.done, total: f.total, updated: f.updatedAt }));
    return {
      ...clean({
        id: p.id, name: p.name, state: ['you', 'work', 'idle'].includes(p.state) ? p.state : 'idle', since: p.since,
        updated: newest(b ? mtime(b.file) : null, p.plan && p.plan.lastAt, ...planFiles.map((f) => f.updated)),
        line: p.line, question: p.question, folder: p.folderShort || sayFolder(p.folder, p.machine), machine: p.machine,
        sessions: (p.sessions || []).length, picture: b ? picUrl(p.id, (b.pictures || [])[0]) : null,
        brief: briefFields(b), objectives: b ? objectivesOf(b) : null, plan,
        plan_files: planFiles.length ? planFiles : null,
      }),
      $ravenry: { rows: objectiveRows(p), hasFolder: !!p.folder, brief: !!b },
    };
  });
}

// ---------------------------------------------------------------- brief

export function brief(ctx) {
  return (ctx.projects || []).filter((p) => p.brief && !p.unowned).map((p) => {
    const b = p.brief;
    const tasksOf = (list) => (list || []).map((t) => clean({ text: t.text, state: taskState(t.state) }));
    return clean({
      project: p.id, project_name: p.name, path: b.path, updated: mtime(b.file),
      goal: b.goal, done_means: b.doneMeans, kind: b.kind, stage: b.stage, next: b.next, waiting_on: b.waitingOn, status: b.status,
      draft: b.draft ? true : undefined, parked: b.parked ? true : undefined,
      open_notes: (b.notes || []).filter((n) => !n.fixed).length,
      rules: (b.rules || []).length ? b.rules.map((r) => (typeof r === 'string' ? r : r.text || '')) : null,
      notes: (b.notes || []).length ? b.notes.map((n) => clean({ text: n.text, fixed: !!n.fixed })) : null,
      objectives: objectivesOf(b).map(({ tasks: _t, ...o }) => o),
      ship: (b.ship || []).length ? tasksOf(b.ship) : null,
    });
  });
}

// ---------------------------------------------------------------- plans

// `gatesFor(briefFile, objective)`: the hub's record of the plan's gates
// (gates.mjs forPlan); `working(projectId)`: its session works now.
export function plans(ctx) {
  const out = [];
  for (const p of ctx.projects || []) {
    const b = p.brief;
    if (!b || p.unowned) continue;
    for (const o of b.plan || []) {
      if (!o.plan) continue;
      let d;
      try { d = derive(o, { working: p.state === 'work', gates: ctx.gatesFor ? ctx.gatesFor(b.file, o) : null }); } catch { continue; }
      const done = d.steps.filter((s) => s.state === 'done' || s.state === 'skip').length;
      out.push({
        ...clean({
          id: `${p.id}/${d.title}`, project: p.id, project_name: p.name, title: d.title, goal: d.goal, state: d.state,
          step: d.current, total: d.total, done, question: d.gate ? d.gate.question : null,
          started: d.startedAt, last: d.lastAt, brief_path: b.path,
        }),
        $ravenry: { row: d.steps.length ? (({ dots, count, next, wash }) => ({ dots, count, next, wash }))(rowModel(d)) : null },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- plan-files

export function planFiles(ctx) {
  const out = [];
  for (const p of ctx.projects || []) {
    if (p.unowned) continue;
    for (const f of p.plans || []) {
      out.push(clean({ id: `${p.id}/${f.source}`, project: p.id, project_name: p.name, title: f.title, source: f.source, done: f.done, total: f.total, updated: f.updatedAt }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- git

// The Ship card's status line (public/app.js renderShip): the first that
// holds, in this order.
export function gitStatus(r) {
  if (r.ahead > 0) return { status: 'ahead', status_text: `${r.ahead} commit${r.ahead > 1 ? 's' : ''} to push` };
  if (r.changed > 0) return { status: 'changed', status_text: 'Uncommitted changes' };
  if (!r.upstream) return { status: 'no_upstream', status_text: 'No upstream' };
  return { status: 'clean', status_text: 'Pushed and clean' };
}

export function git(ctx) {
  const v = ctx.ship;
  if (!v || !Array.isArray(v.repos)) return [];
  return v.repos.map((r) => {
    const ship = r.projects.flatMap((p) => p.ship || []).map((t) => clean({ text: t.text, state: taskState(t.state) }));
    const cmd = r.projects.map((p) => p.shipCommand).find(Boolean);
    const pic = r.projects.map((p) => (p.picture ? { p, pic: p.picture } : null)).find(Boolean);
    return clean({
      path: r.topShort || sayLocal(r.top), project: r.projects[0] && r.projects[0].id, projects: r.projects.map((p) => p.name),
      branch: r.branch, upstream: r.upstream, ahead: r.ahead, behind: r.behind, changed: r.changed,
      ...gitStatus(r),
      last_commit: r.lastCommit ? clean({ hash: r.lastCommit.hash, at: r.lastCommit.at, subject: r.lastCommit.subject }) : null,
      ship: ship.length ? ship : null,
      ship_waiting: ship.length ? ship.filter((t) => t.state === 'you').length : 0,
      ship_command: cmd || null,
      picture: pic ? picUrl(pic.p.id, pic.pic) : null,
    });
  });
}

// ---------------------------------------------------------------- rule-files

// `scopes`: rulefiles.scopes(...); `read(path)`: a file's text by its
// short path (the scopes carry short paths only).
export function ruleFiles(ctx) {
  const out = [];
  for (const s of ctx.scopes || []) {
    for (const [assistant, f] of [['claude', s.claude], ['codex', s.codex]]) {
      if (!f) continue;
      const fileName = path.basename(f.path || '');
      const body = f.exists && ctx.read ? ctx.read(f.path) : null;
      out.push(clean({
        scope: s.key === 'global' ? 'global' : s.folder, scope_name: s.name, assistant, file_name: fileName,
        path: s.key === 'global' ? f.path : s.folder ? `${s.folder}/${f.path}` : f.path,
        exists: !!f.exists, count: f.count || 0, body,
        groups: (f.groups || []).length ? f.groups.map((g) => ({ heading: g.heading, rules: g.rules })) : null,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- repeats

export function repeats(ctx) {
  const v = ctx.repeats;
  if (!v || !Array.isArray(v.rows)) return [];
  return v.rows.map((r) => ({
    ...clean({
      id: r.id, rule: r.rule, kind: r.kind, button: r.button, messages: r.messages, sessions: r.sessions,
      sessions_text: r.sessionsText, last: r.lastTs, tail: r.tail, assistants: r.assistants, targets: r.targets,
      quote: r.quote ? clean({ text: r.quote.text, project: r.quote.project, date: r.quote.date }) : null,
    }),
    $ravenry: { preview: r.preview || null },
  }));
}

// ---------------------------------------------------------------- sessions

export function sessions(ctx) {
  const v = ctx.sessions;
  if (!v || !Array.isArray(v.rows)) return [];
  const machineOf = new Map();
  for (const p of ctx.projects || []) for (const s of p.sessions || []) if (s.sessionId && s.machine) machineOf.set(s.sessionId, s.machine);
  return v.rows.map((r) => clean({
    id: r.sessionId || `pid:${r.pid}`, project: r.projectId, project_name: r.label, assistant: r.assistant,
    state: r.state, group: r.group, line: r.line, folder: r.folder, machine: r.sessionId ? machineOf.get(r.sessionId) : null,
    since: r.since, memory_kb: r.memKb, closable: !!r.closable, blocked: r.blocked,
  }));
}

export const BUILDERS = {
  projects, brief, plans, 'plan-files': planFiles, git, 'rule-files': ruleFiles, repeats, sessions,
};

/** The items of a built-in provider, or null for an unknown id. */
export function itemsOf(id, ctx) {
  const b = BUILDERS[id];
  if (!b) return null;
  try { return b(ctx); } catch (e) { console.error(`pages: provider ${id}:`, e.message); return []; }
}
