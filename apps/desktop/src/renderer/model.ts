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
  /** The section of its own state, decided by the hub (hub/server/sidebar.mjs). */
  group?: Group;
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
  /** Why it cannot be typed into from here (a cmux tab Ravenry only reads). */
  cannotType?: string | null;
  /** In a terminal outside Ravenry: whether its process still runs there (Move here ends it first). */
  outside?: { name: string; open: boolean; resumable: boolean } | null;
  /** In a Ravenry pane, and another process (in cmux, iTerm2, Rex) holds the same session too. */
  alsoOpen?: { name: string; term: string; surfaceId: string | null; pid?: number } | null;
  /** A Move here waiting for the turn to end. */
  moving?: { waiting: boolean; keep: 'ravenry' | 'outside'; name: string } | null;
  /** The last move done (for a minute). */
  moved?: { at: number; keep: 'ravenry' | 'outside'; ended: { pid: number; where: string; signal?: string; ms?: number; skipped?: boolean }[]; surfaceId: string | null; replaced?: string[] } | null;
  /** In a Ravenry pane: the conversation went on in another process since. */
  movedOn?: { name: string; pid: number } | null;
  /** Its last turns from its transcript, oldest first, when no screen of it is read. */
  conversation?: { at?: string | null; ask?: string | null; text?: string | null; working?: boolean }[];
  /** The machine a remote session runs on (the hub's ravenryd over ssh); null on this one. */
  machine?: string | null;
  /** The ravenryd pane a session runs in, when the hub sends it on its own. */
  pane?: string | { id: string } | null;
  /** A session started in a git worktree of its own (hub/docs/SESSIONS.md, Worktrees). */
  worktree?: { branch: string; folder: string; base?: string; baseBranch?: string | null; state: 'open' | 'merged' | 'discarded'; merged?: { mode: string; commit: string; before?: string; tip?: string; at: string } | null; branch_deleted_at?: string | null } | null;
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
  /** macOS's privacy answers for the protected folders the board reads (hub/server/access.mjs). */
  access?: { waiting: { folder: string; name: string } | null; denied: { folder: string; name: string }[] } | null;
  /** The phone alerts: on and set up means an open checkpoint is on the phone too. */
  alerts?: { enabled?: boolean; configured?: boolean } | null;
  /** The home folder of each machine, "" for the hub's own: folders are said against them (hub/public/homepath.mjs). */
  homes?: Record<string, string>;
  /** Every daemon's open checkpoints (checkpoints.ts HubCheckpoint). */
  checkpoints?: unknown[];
  /** The sidebar ready to draw (hub/server/sidebar.mjs has the shape). */
  sidebar?: HubSidebar | null;
}

/** A row as the hub sends it (hub/server/sidebar.mjs). */
export interface HubRow { key: string; surfaceId: string; name: string; assistant: string | null; pct: number | null; pctWarn: boolean; line: string | null; mark: RowMark | null; group: Group; machine: string | null }
export interface HubSidebar {
  sections: { group: Group; title: string; count: number; projects: { id: string; name: string; machine: string | null; time: { at: string | null; style: 'clock' | 'ago' }; rows: HubRow[] }[] }[];
  counts: Record<Group, number>;
}

/** Which group a session's own state puts it in: the hub says (hub/server/sidebar.mjs). */
export function sessionGroup(s: HubSession): Group {
  return s.group || 'idle';
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
/**
 * A title's grey second line, or null when it would only say the title
 * again (a session named after its project's folder: "weather-api
 * weather-api"). Every tab, row and header that shows a name beside a
 * second line takes its second line through here, in the app and on the
 * phone.
 */
export function secondLine(name: string | null | undefined, second: string | null | undefined): string | null {
  const a = String(name || '').trim().toLowerCase();
  const b = String(second || '').trim();
  return b && b.toLowerCase() !== a ? b : null;
}

export function machineOf(p: HubProject, s?: HubSession): string | null {
  const m = (s && s.machine) || p.machine || null;
  return m && m !== 'local' ? m : null;
}

/** An open checkpoint on a session's row: what kind of answer waits, its words, since when. */
/** A row's mark, as the hub words it (hub/server/cpwords.mjs markOf); label is the word before it ("Wants to run:"). */
export interface RowMark { kind: 'ask' | 'approve' | 'secret' | 'drive' | 'pick' | 'review' | 'other'; text: string; code: boolean; label: string; since: string }

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

/**
 * The sidebar as the hub sends it (state.sidebar, hub/server/sidebar.mjs:
 * the sections, their projects and rows, in order, with their counts),
 * with each project and session found in the state for the drawing, and
 * each time said against this clock.
 */
export function board(state: HubState | null, now: number): BoardGroup[] {
  const sb = state?.sidebar;
  if (!sb) return [];
  const projects = new Map((state?.projects || []).map((p) => [p.id, p]));
  return sb.sections.map((g) => ({
    group: g.group,
    title: g.title,
    count: g.count,
    projects: g.projects.map((pr) => {
      const project = projects.get(pr.id) || { id: pr.id, name: pr.name, state: g.group, sessions: [] };
      return {
        project,
        time: pr.time.style === 'clock' ? clock(pr.time.at, now) : ago(pr.time.at, now),
        machine: pr.machine,
        rows: pr.rows.map(({ surfaceId, ...r }) => ({ ...r, session: project.sessions.find((x) => x.surfaceId === surfaceId) || { surfaceId, state: 'idle' } })),
      };
    }),
  }));
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
  for (const p of prev.projects || []) for (const s of p.sessions) if (sessionGroup(s) === 'you') { before.add(sessionKey(p.id, s)); if (s.sessionId) before.add(`sid:${s.sessionId}`); }
  const out: string[] = [];
  for (const p of next.projects || []) for (const s of p.sessions) {
    const k = sessionKey(p.id, s);
    // The same session under a new key (its tab was found or lost) has not arrived.
    if (sessionGroup(s) === 'you' && !before.has(k) && !(s.sessionId && before.has(`sid:${s.sessionId}`))) out.push(k);
  }
  return out;
}

/**
 * Sessions whose key changed between two states while they stayed the same
 * session: the hub names a session by its tab, and a tab it finds or loses
 * (cmux starting or stopping to answer) changes the key. Old key -> new key.
 */
export function rekeyed(prev: HubState | null, next: HubState | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!prev || !next) return out;
  const now = new Map<string, string>();
  const keys = new Set<string>();
  for (const p of next.projects || []) for (const s of p.sessions) { const k = sessionKey(p.id, s); keys.add(k); if (s.sessionId) now.set(s.sessionId, k); }
  for (const p of prev.projects || []) for (const s of p.sessions) {
    const k = sessionKey(p.id, s);
    const n = s.sessionId ? now.get(s.sessionId) : undefined;
    if (n && n !== k && !keys.has(k)) out.set(k, n);
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
