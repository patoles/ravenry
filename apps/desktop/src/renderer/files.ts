// Files changed (19, variant A): in a session's panel, the files its agent
// changed with their added and removed lines, and a file another session
// changed too in orange, with who and when, and what that means (in one
// folder whoever saves last wins; in its own copy it shows at the merge).
// "See all of <project>" opens the grid of every session's files (variant
// B), one row a file, one column a session and you.
// The hub works it out (GET /api/projects/<id>/files): the files each
// pane's hooks named, with git's line counts.

import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import { ago, assistantName } from './model.ts';

export interface FileLine { path: string; added: number; removed: number; at?: string | null; read?: boolean }
export interface SessionFiles { surfaceId: string; topic?: string | null; assistant?: string | null; pane?: string | null; worktree?: boolean; folder?: string | null; files: FileLine[] }
export interface ProjectFiles { ok: boolean; project: string; root?: string; sessions: SessionFiles[]; you: FileLine[] }

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
    const hit = (f: FileLine) => (!f.read && clashOf(f.path, others).length ? 1 : 0);
    const sorted = [...me.files].sort((a, b) => hit(b) - hit(a) || Number(!!a.read) - Number(!!b.read));
    for (const f of sorted) {
      const clash = f.read ? [] : clashOf(f.path, others);
      if (clash.length) {
        const o = clash[0];
        const who = `${assistantName(o.s.assistant) || 'Another agent'}${o.s.topic ? `, in ${o.s.topic},` : ''}`;
        const when = o.f.at ? ` ${ago(o.f.at, this.host.now()) === 'now' ? 'just now' : `${ago(o.f.at, this.host.now())} ago`}` : '';
        const same = !me.worktree && !o.s.worktree;
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
    const cols = (d?.sessions || []).filter((s) => s.files.length);
    const paths = new Map<string, (FileLine | null)[]>();
    cols.forEach((s, i) => { for (const f of s.files) { const row = paths.get(f.path) || Array(cols.length + 1).fill(null); row[i] = f; paths.set(f.path, row); } });
    for (const f of d?.you || []) { const row = paths.get(f.path) || Array(cols.length + 1).fill(null); row[cols.length] = f; paths.set(f.path, row); }
    const rows = [...paths].sort((a, b) => clashes(b[1]) - clashes(a[1]) || a[0].localeCompare(b[0]));
    const cell = (f: FileLine | null) => h('td', f ? (f.read ? h('span.rd', 'read') : [h('span.ad', `+${f.added}`), ' ', h('span.rm', `−${f.removed}`)]) : '');
    replace(el,
      h('div.pg-h', h('div.tt', h('h2', `Who changed what in ${projectName}`), h('div.pg-src', `${cols.length} session${cols.length === 1 ? '' : 's'}${d?.you.length ? ' and you' : ''}, the files each one changed`)),
        h('button.icon-btn.sm', { title: 'Close', 'aria-label': 'Close', on: { click: close } }, svg(I.CLOSE))),
      h('div.pg-b',
        !d ? h('p.t3', 'Reading what each session changed...') : !rows.length ? h('p.t3', 'No session changed a file yet.') : h('div.sec',
          h('table.fgrid',
            h('thead', h('tr', h('th', 'File'), cols.map((s) => h('th', s.topic || 'Session', h('span', assistantName(s.assistant) || ''))), h('th', 'You'))),
            h('tbody', rows.map(([p, r]) => h(`tr${clashes(r) > 1 ? '.clash' : ''}`, h('td', p), r.map(cell))))),
          h('p.t3.small', 'An orange row is a file two sessions changed. "read" means it looked but did not change it.'))));
  }
}

function counts(f: FileLine): HTMLElement {
  return h('span.num', h('span.ad', `+${f.added}`), ' ', h('span.rm', `−${f.removed}`));
}

function clashOf(path: string, others: SessionFiles[]): { s: SessionFiles; f: FileLine }[] {
  const out: { s: SessionFiles; f: FileLine }[] = [];
  for (const s of others) { const f = s.files.find((x) => x.path === path && !x.read); if (f) out.push({ s, f }); }
  return out;
}

const clashes = (row: (FileLine | null)[]) => row.filter((f) => f && !f.read).length;
