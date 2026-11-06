// The board as the sidebar draws it, from the hub's state (GET /api/state,
// or each `state` event). Pure functions, so they are tested without a
// window.

export type Group = 'you' | 'work' | 'wait' | 'idle';

export interface HubQuick { label: string; choice?: number }
export interface HubWords { state?: string; line?: string; headline?: string; question?: string | null; quick?: HubQuick[]; dialog?: string[] | null }
export interface HubCtx { tokens: number; window: number; pct: number; model?: string }

export interface HubSession {
  surfaceId: string;
  topic?: string;
  sessionId?: string | null;
  state: string;
  since?: string | null;
  assistant?: string | null;
  ctx?: HubCtx | null;
  words?: HubWords;
  term?: string | null;
  termName?: string | null;
  cannot?: string | null;
  handed?: boolean;
  terminal?: boolean;
  screen?: string[];
  /** The machine a remote session runs on (the hub's ravenryd over ssh); null on this one. */
  machine?: string | null;
  /** The ravenryd pane a session runs in, when the hub sends it on its own. */
  pane?: string | { id: string } | null;
}

export interface HubProject {
  id: string;
  name: string;
  state: Group;
  since?: string | null;
  folder?: string | null;
  folderShort?: string | null;
  line?: string;
  headline?: string;
  question?: string | null;
  quick?: HubQuick[];
  brief?: {
    goal?: string | null;
    next?: string | null;
    pictures?: { url?: string; alt?: string; path?: string; auto?: boolean }[];
  } | null;
  plan?: { title?: string; name?: string; steps?: { text?: string; title?: string; state?: string }[] } | null;
  planGate?: { short?: string; question?: string } | null;
  timeline?: { when?: string; at?: string; text: string; from: string }[];
  handoffRecent?: { resumedAt?: string } | null;
  primary?: string | null;
  sessions: HubSession[];
  machine?: string | null;
  waitingOn?: string | null;
}

export interface HubState {
  generatedAt?: string | null;
  error?: string | null;
  projects?: HubProject[];
  settings?: { handoffThreshold?: number; handoffCeiling?: number; handoffEnabled?: boolean };
  sessions?: { totalKb?: number };
  views?: { ideas?: number; rules?: number; ship?: number };
  /** The phone alerts: on and set up means an open checkpoint is on the phone too. */
  alerts?: { enabled?: boolean; configured?: boolean } | null;
  /** The home folder of each machine, "" for the hub's own: folders are said against them (hub/public/homepath.mjs). */
  homes?: Record<string, string>;
  /** Every daemon's open checkpoints (checkpoints.ts HubCheckpoint). */
  checkpoints?: unknown[];
}

const SESSION_GROUP: Record<string, Group> = { dialog: 'you', asked: 'you', draft: 'you', handback: 'you', working: 'work' };

/** Which group a session's own state puts it in. */
export function sessionGroup(s: HubSession): Group {
  return SESSION_GROUP[s.state] || (s.words?.state as Group | undefined) || 'idle';
}

export const sessionKey = (projectId: string, s: HubSession): string => `${projectId}/${s.surfaceId}`;

const PANE_ID = /^p[a-z2-7]{7}$/;

/**
 * The ravenryd pane a session runs in, else null. The hub names a ravenryd
 * session's tab "ravenry:<pane id>" (term "ravenry"); `pane` is kept for a
 * hub that sends the id on its own.
 */
export function paneOf(s: HubSession): string | null {
  if (s.pane) return typeof s.pane === 'string' ? s.pane : s.pane.id;
  const id = s.surfaceId || '';
  if (id.startsWith('ravenry:') && PANE_ID.test(id.slice(8))) return id.slice(8);
  return null;
}

/** The hub session that runs in a given pane, if any. */
export function sessionOfPane(state: HubState | null, pane: string): { project: HubProject; session: HubSession; key: string } | null {
  for (const p of state?.projects || []) for (const s of p.sessions) if (paneOf(s) === pane) return { project: p, session: s, key: sessionKey(p.id, s) };
  return null;
}

/** A quiet machine tag for a remote session or project; null on this machine. */
export function machineOf(p: HubProject, s?: HubSession): string | null {
  const m = (s && s.machine) || p.machine || null;
  return m && m !== 'local' ? m : null;
}

/** An open checkpoint on a session's row: what kind of answer waits, its words, since when. */
export interface RowMark { kind: 'ask' | 'approve' | 'secret' | 'other'; text: string; code: boolean; since: string }

export interface Row {
  key: string;
  session: HubSession;
  name: string;
  assistant: string | null;
  pct: number | null;
  pctWarn: boolean;
  line: string | null;
  /** An open checkpoint's mark, shown instead of the line. */
  mark: RowMark | null;
  group: Group;
  machine: string | null;
}

export interface ProjectRow {
  project: HubProject;
  time: string;
  machine: string | null;
  rows: Row[];
}

export interface BoardGroup {
  group: Group;
  title: string;
  projects: ProjectRow[];
  count: number;
}

export const GROUP_TITLES: Record<Group, string> = { you: 'Needs you', work: 'Working', wait: 'Waiting on others', idle: 'Idle' };
const ORDER: Group[] = ['you', 'work', 'wait', 'idle'];

export function assistantName(kind: string | null | undefined): string | null {
  if (!kind) return null;
  if (kind === 'claude') return 'Claude';
  if (kind === 'codex') return 'Codex';
  return kind[0].toUpperCase() + kind.slice(1);
}

/** "now", "4 min", "2 h", "3 d". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return 'now';
  const ms = now - Date.parse(iso);
  if (!(ms >= 60000)) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** The clock time today ("10:51"), or how long ago for an older one. */
export function clock(iso: string | null | undefined, now: number): string {
  if (!iso) return 'now';
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() !== today.toDateString()) return ago(iso, now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function projectTime(p: HubProject, now: number): string {
  if (p.state === 'you' || p.state === 'wait') return clock(p.since, now);
  return ago(p.since, now);
}

function row(p: HubProject, s: HubSession, threshold: number, mark: RowMark | null): Row {
  const pct = s.ctx && Number.isFinite(s.ctx.pct) ? Math.round(s.ctx.pct) : null;
  const g = mark ? 'you' : sessionGroup(s);
  const w = s.words || {};
  const line = g === 'you' && !mark ? (w.question || w.line || null) : null;
  return {
    key: sessionKey(p.id, s),
    session: s,
    name: s.topic || p.name,
    assistant: assistantName(s.assistant),
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
 * newest first in each. A session with an open checkpoint (marks, by
 * session key) needs you whatever its own state says, and its project's
 * time is when it started waiting.
 */
export function board(state: HubState | null, now: number, marks: Map<string, RowMark> = new Map()): BoardGroup[] {
  const threshold = state?.settings?.handoffThreshold ?? 50;
  const by = new Map<Group, ProjectRow[]>();
  const since = new Map<HubProject, number>();
  for (const p of state?.projects || []) {
    const live = p.sessions.filter((s) => !s.handed);
    const marked = live.filter((s) => marks.has(sessionKey(p.id, s)));
    const g: Group = marked.length ? 'you' : ORDER.includes(p.state) ? p.state : 'idle';
    let shown = g === 'idle' ? [] : live.filter((s) => marks.has(sessionKey(p.id, s)) || sessionGroup(s) === g);
    if (g !== 'idle' && !shown.length) shown = live.filter((s) => s.surfaceId === p.primary).slice(0, 1);
    const first = marked.map((s) => Date.parse(marks.get(sessionKey(p.id, s))!.since)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (first !== undefined) since.set(p, first);
    const list = by.get(g) || [];
    const time = first !== undefined ? clock(new Date(first).toISOString(), now) : projectTime(p, now);
    list.push({ project: p, time, machine: machineOf(p), rows: shown.map((s) => row(p, s, threshold, marks.get(sessionKey(p.id, s)) || null)) });
    by.set(g, list);
  }
  const t = (p: HubProject) => since.get(p) ?? (p.since ? Date.parse(p.since) : now);
  return ORDER.filter((g) => by.has(g)).map((g) => {
    const projects = by.get(g)!.sort((a, b) => t(b.project) - t(a.project));
    const count = g === 'idle' ? projects.length : projects.reduce((n, p) => n + Math.max(p.rows.length, 1), 0);
    return { group: g, title: GROUP_TITLES[g], projects, count };
  });
}

/** Finds a session by its key. */
export function findSession(state: HubState | null, key: string): { project: HubProject; session: HubSession } | null {
  for (const p of state?.projects || []) for (const s of p.sessions) if (sessionKey(p.id, s) === key) return { project: p, session: s };
  return null;
}

/** Sessions that moved into Needs you between two states: a checkpoint or an approval arrived. */
export function arrivals(prev: HubState | null, next: HubState | null): string[] {
  if (!prev || !next) return [];
  const before = new Set<string>();
  for (const p of prev.projects || []) for (const s of p.sessions) if (sessionGroup(s) === 'you') before.add(sessionKey(p.id, s));
  const out: string[] = [];
  for (const p of next.projects || []) for (const s of p.sessions) {
    const k = sessionKey(p.id, s);
    if (sessionGroup(s) === 'you' && !before.has(k)) out.push(k);
  }
  return out;
}

/** True when the hub knows no session at all: the first launch. */
export function isEmpty(state: HubState | null): boolean {
  return !(state?.projects || []).some((p) => p.sessions.length);
}

/** "82k", "1.2M". */
export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** The sidebar's memory line, "Claude 3.1 GB". */
export function memoryLine(state: HubState | null): string | null {
  const kb = state?.sessions?.totalKb;
  if (!kb) return null;
  const gb = kb / 1048576;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}
