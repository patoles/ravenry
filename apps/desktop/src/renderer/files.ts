// Files changed (19, variant A): in a session's panel, the files its agent
// changed with their added and removed lines, and a file another session
// changed too in orange, with who and when, and what that means (in one
// folder whoever saves last wins; in its own copy it shows at the merge).
// "See all of <project>" opens the grid of every session's files (variant
// B), one row a file, one column a session and you.
// The hub works it out (GET /api/projects/<id>/files): the files each
// pane's hooks named, with git's line counts, the file another session
// changed too (`clash` on a file) and the grid (`grid`; hub/server/
// reviewview.mjs withClashes). An older hub without them: worked out here.

import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import { ago, assistantName } from './model.ts';

/** Another session that changed the same file, as the hub says it (reviewview.mjs withClashes). */
export interface Clash { surfaceId: string; topic: string | null; assistant: string | null; at: string | null; worktree: boolean; same: boolean }
export interface FileLine { path: string; added: number; removed: number; at?: string | null; read?: boolean; clash?: Clash }
interface GridCell { added: number; removed: number; read: boolean }
export interface FilesGrid { cols: { surfaceId: string; topic: string | null; assistant: string | null }[]; you: boolean; rows: { path: string; cells: (GridCell | null)[]; clash: boolean }[] }
export interface SessionFiles { surfaceId: string; topic?: string | null; assistant?: string | null; pane?: string | null; worktree?: boolean; folder?: string | null; files: FileLine[] }
export interface ProjectFiles { ok: boolean; project: string; root?: string; sessions: SessionFiles[]; you: FileLine[]; grid?: FilesGrid }

export interface FilesHost {
  call(method: 'GET' | 'POST', p: string): Promise<{ status: number; body: unknown }>;
  now(): number;
  rerender(): void;
  openGrid(projectId: string): void;
}

const FRESH_MS = 4000;

export class Files {
  private cache = new Map<string, { at: number; data: ProjectFiles | null; loading: boolean }>();
  private host: FilesHost;
  constructor(host: FilesHost) { this.host = host; }

  /** The project's files, read again when older than a few seconds. */
  of(projectId: string): ProjectFiles | null {
    const c = this.cache.get(projectId);
    if (!c || (!c.loading && this.host.now() - c.at > FRESH_MS)) void this.load(projectId);
    return c?.data || null;
  }

  async load(projectId: string): Promise<void> {
    const had = this.cache.get(projectId);
    this.cache.set(projectId, { at: had?.at || 0, data: had?.data || null, loading: true });
    let data: ProjectFiles | null = null;
    try {
      const r = await this.host.call('GET', `/api/projects/${encodeURIComponent(projectId)}/files`);
      if (r.status === 200) data = r.body as ProjectFiles;
    } catch { /* the hub is away */ }
    const before = JSON.stringify(had?.data || null);
    this.cache.set(projectId, { at: this.host.now(), data, loading: false });
    if (JSON.stringify(data) !== before) this.host.rerender();
  }

  /** "Files it changed", for a session's panel; null when it changed none. */
  section(projectId: string, projectName: string, surfaceId: string): HTMLElement | null {
    const d = this.of(projectId);
    const me = d?.sessions.find((s) => s.surfaceId === surfaceId);
    if (!d || !me || !me.files.length) return null;
    const added = me.files.reduce((n, f) => n + f.added, 0);
    const removed = me.files.reduce((n, f) => n + f.removed, 0);
    const others = d.sessions.filter((s) => s.surfaceId !== surfaceId);
    const rows: HTMLElement[] = [];
    // The hub's clash on each file (it sends `grid` with them), else worked out here.
    const clashFor = (f: FileLine): Clash | null => (f.read ? null : d.grid ? f.clash || null : clashOf(f.path, others, me));
    const hit = (f: FileLine) => (clashFor(f) ? 1 : 0);
    const sorted = [...me.files].sort((a, b) => hit(b) - hit(a) || Number(!!a.read) - Number(!!b.read));
    for (const f of sorted) {
      const o = clashFor(f);
      if (o) {
        const who = `${assistantName(o.assistant) || 'Another agent'}${o.topic ? `, in ${o.topic},` : ''}`;
        const when = o.at ? ` ${ago(o.at, this.host.now()) === 'now' ? 'just now' : `${ago(o.at, this.host.now())} ago`}` : '';
        const same = o.same;
        rows.push(h('div.fc-r.clash', svg(I.WARN), h('span.fp', h('bdi', f.path)), counts(f)));
        rows.push(h('div.clash-n',
          h('span', `${who} changed this file too${when}. ${same ? 'Both are in the same folder, so whoever saves last wins.' : 'Each has its own copy, so it shows when you merge.'}`),
          h('button.lk.self', { on: { click: () => this.host.openGrid(projectId) } }, 'See both changes')));
      } else {
        rows.push(h(`div.fc-r${f.read ? '.faint' : ''}`, h('span.fp', h('bdi', f.path)), f.read ? h('span.ro', 'read only') : counts(f)));
      }
    }
    return h('div.sec',
      h('div.sec-h', 'Files it changed', h('span.sp'), h('span.light.num', `${me.files.filter((f) => !f.read).length} file${me.files.length === 1 ? '' : 's'}, +${added} −${removed}`)),
      h('div.fch', rows),
      h('button.lk.self', { on: { click: () => this.host.openGrid(projectId) } }, `See all of ${projectName}`));
  }

  /** "Who changed what in <project>": the grid, in the middle and right columns. */
  grid(el: HTMLElement, projectId: string, projectName: string, close: () => void): void {
    const d = this.of(projectId);
    // The hub's grid, else worked out here (an older hub).
    const g = d ? d.grid || gridOf(d) : null;
    const cols = g ? g.cols : [];
    const rows = g ? g.rows : [];
    const cell = (f: GridCell | null) => h('td', f ? (f.read ? h('span.rd', 'read') : [h('span.ad', `+${f.added}`), ' ', h('span.rm', `−${f.removed}`)]) : '');
    replace(el,
      h('div.pg-h', h('div.tt', h('h2', `Who changed what in ${projectName}`), h('div.pg-src', `${cols.length} session${cols.length === 1 ? '' : 's'}${g?.you ? ' and you' : ''}, the files each one changed`)),
        h('button.icon-btn.sm', { title: 'Close', 'aria-label': 'Close', on: { click: close } }, svg(I.CLOSE))),
      h('div.pg-b',
        !d ? h('p.t3', 'Reading what each session changed...') : !rows.length ? h('p.t3', 'No session changed a file yet.') : h('div.sec',
          h('table.fgrid',
            h('thead', h('tr', h('th', 'File'), cols.map((s) => h('th', s.topic || 'Session', h('span', assistantName(s.assistant) || ''))), h('th', 'You'))),
            h('tbody', rows.map((r) => h(`tr${r.clash ? '.clash' : ''}`, h('td', r.path), r.cells.map(cell))))),
          h('p.t3.small', 'An orange row is a file two sessions changed. "read" means it looked but did not change it.'))));
  }
}

function counts(f: FileLine): HTMLElement {
  return h('span.num', h('span.ad', `+${f.added}`), ' ', h('span.rm', `−${f.removed}`));
}

/** An older hub's answer: the first other session that changed the file too, as the hub says it. */
function clashOf(path: string, others: SessionFiles[], me: SessionFiles): Clash | null {
  for (const s of others) {
    const f = s.files.find((x) => x.path === path && !x.read);
    if (f) return { surfaceId: s.surfaceId, topic: s.topic || null, assistant: s.assistant || null, at: f.at || null, worktree: !!s.worktree, same: !me.worktree && !s.worktree };
  }
  return null;
}

/** An older hub's answer: the grid as the hub sends it (reviewview.mjs withClashes). */
function gridOf(d: ProjectFiles): FilesGrid {
  const cols = d.sessions.filter((s) => s.files.length);
  const paths = new Map<string, (GridCell | null)[]>();
  const cell = (f: FileLine): GridCell => ({ added: f.added || 0, removed: f.removed || 0, read: !!f.read });
  cols.forEach((s, i) => { for (const f of s.files) { const row = paths.get(f.path) || Array(cols.length + 1).fill(null); row[i] = cell(f); paths.set(f.path, row); } });
  for (const f of d.you || []) { const row = paths.get(f.path) || Array(cols.length + 1).fill(null); row[cols.length] = cell(f); paths.set(f.path, row); }
  const changed = (row: (GridCell | null)[]) => row.filter((f) => f && !f.read).length;
  return {
    cols: cols.map((s) => ({ surfaceId: s.surfaceId, topic: s.topic || null, assistant: s.assistant || null })),
    you: (d.you || []).length > 0,
    rows: [...paths].sort((a, b) => changed(b[1]) - changed(a[1]) || a[0].localeCompare(b[0])).map(([path, cells]) => ({ path, cells, clash: changed(cells) > 1 })),
  };
}
