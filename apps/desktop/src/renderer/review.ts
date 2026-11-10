// Review (33, variant A): a Review tab beside a worktree session's
// terminal, with its files on the left and the diff on the right. A
// comment goes on a line and waits until Send N comments types them into
// the session (one review comment each, through the hub's send path);
// Merge into main merges its branch, keeping its commits. In the session's
// panel: the card when it is done and asks for a review, "Its copy", and
// after a merge the card that says what landed, with Undo the merge and
// Delete the branch.
// The hub does the git (hub/docs/SESSIONS.md, Worktrees).

import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import { assistantName } from './model.ts';
import type { HubProject, HubSession } from './model.ts';

export interface Worktree { branch: string; folder: string; base?: string; baseBranch?: string | null; state: 'open' | 'merged' | 'discarded'; merged?: { mode: string; commit: string; before?: string; tip?: string; at: string } | null; branch_deleted_at?: string | null }
export interface DiffFile { path: string; added: number; removed: number; status: string; binary?: boolean }
export interface Diff { ok: boolean; files: DiffFile[]; diff: string; truncated?: boolean; uncommitted?: string[]; check?: { clean: boolean; conflicts: string[]; moved: number; ahead: number }; error?: string; lines?: Record<string, Line[]>; mergeMode?: 'ff' | 'merge' }

export interface ReviewHost {
  call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  now(): number;
  toast(text: string): void;
  rerender(): void;
  /** Leaves the review for the session's terminal. */
  back(): void;
  tilde(p: string): string;
}

/** A review comment as the hub keeps it (hub/docs/SESSIONS.md, Review comments). */
export interface Comment { id: string; file: string; line: number; side: 'new' | 'old'; text: string; at: string; state: 'pending' | 'sent'; sent_at?: string; replies?: { id: string; text: string; at: string; by: 'agent'; pane?: string }[] }
interface Line { kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }

const enc = (s: string) => encodeURIComponent(s);
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Splits a unified diff into its files' lines: an older hub's answer only (the hub sends `lines`, hub/server/reviewview.mjs). */
export function parseDiff(text: string): Map<string, Line[]> {
  const out = new Map<string, Line[]>();
  let cur: Line[] | null = null;
  let o = 0, n = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = null; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '');
      cur = [];
      out.set(p === '/dev/null' ? '' : p, cur);
      continue;
    }
    if (raw.startsWith('--- ') || !cur) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (m) { o = Number(m[1]); n = Number(m[2]); cur.push({ kind: 'hunk', text: m[3] ? `@@ ${m[3].trim()} @@` : '@@', oldNo: null, newNo: null }); continue; }
    if (raw.startsWith('+')) cur.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: n++ });
    else if (raw.startsWith('-')) cur.push({ kind: 'del', text: raw.slice(1), oldNo: o++, newNo: null });
    else if (raw.startsWith(' ') || raw === '') { if (raw === '' && !cur.length) continue; cur.push({ kind: 'ctx', text: raw.slice(1), oldNo: o++, newNo: n++ }); }
  }
  for (const [k, v] of out) while (v.length && v[v.length - 1].kind === 'ctx' && !v[v.length - 1].text) { v.pop(); out.set(k, v); }
  return out;
}

export class Review {
  key: string | null = null;
  private surfaceId = '';
  private diff: Diff | null = null;
  private files = new Map<string, Line[]>();
  private sel: string | null = null;
  /** The session's comments, as the hub keeps them, by file. */
  private comments = new Map<string, Comment[]>();
  private commentsAt = 0;
  private composing: { file: string; line: number; side: 'new' | 'old'; text: string } | null = null;
  private busy = false;
  private loadedAt = 0;
  /** Each worktree session's last diff, for its cards (the review may be closed). */
  private known = new Map<string, { at: number; diff: Diff | null; loading: boolean }>();

  private el: HTMLElement;
  private host: ReviewHost;
  constructor(el: HTMLElement, host: ReviewHost) { this.el = el; this.host = host; }

  /** Shows a session's review. */
  show(key: string, p: HubProject, s: HubSession): void {
    if (this.key !== key) { this.key = key; this.surfaceId = s.surfaceId; this.diff = null; this.sel = null; this.composing = null; this.comments.clear(); this.commentsAt = 0; }
    if (!this.diff || this.host.now() - this.loadedAt > 15000) void this.load();
    // The comments and the agent's replies: read again every few seconds while it shows.
    if (this.host.now() - this.commentsAt > 3000) void this.loadComments();
    this.render(p, s);
  }

  async loadComments(): Promise<void> {
    this.commentsAt = this.host.now();
    const r = await this.host.call('GET', `/api/sessions/${enc(this.surfaceId)}/review`);
    if (r.status !== 200) return;
    const list = ((r.body as { comments?: Comment[] }).comments || []);
    const by = new Map<string, Comment[]>();
    for (const c of list) { const l = by.get(c.file) || []; l.push(c); by.set(c.file, l); }
    const was = JSON.stringify([...this.comments]);
    this.comments = by;
    if (JSON.stringify([...by]) !== was) this.host.rerender();
  }

  async load(): Promise<void> {
    const r = await this.host.call('GET', `/api/sessions/${enc(this.surfaceId)}/diff`);
    this.loadedAt = this.host.now();
    this.diff = r.status === 200 ? r.body as Diff : { ok: false, files: [], diff: '', error: (r.body as { error?: string }).error || 'The board could not read its work.' };
    // Each file's lines as the hub split them (GET .../diff `lines`), else split here.
    this.files = this.diff.lines ? new Map(Object.entries(this.diff.lines)) : parseDiff(this.diff.diff || '');
    this.known.set(this.surfaceId, { at: this.loadedAt, diff: this.diff, loading: false });
    if (!this.sel || !this.diff.files.some((f) => f.path === this.sel)) this.sel = this.diff.files[0]?.path || null;
    this.host.rerender();
  }

  private pending(): Comment[] { return [...this.comments.values()].flat().filter((c) => c.state === 'pending'); }

  private async sendComments(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.host.call('POST', `/api/sessions/${enc(this.surfaceId)}/review/send`, {});
      if (r.status !== 200) throw new Error((r.body as { error?: string }).error || `the board answered ${r.status}`);
      const n = ((r.body as { sent?: string[] }).sent || []).length;
      this.host.toast(`Sent ${n} comment${n === 1 ? '' : 's'}.`);
    } catch (e) {
      this.host.toast(`Could not send them: ${(e as Error).message}`);
    } finally { this.busy = false; await this.loadComments(); this.host.rerender(); }
  }

  async merge(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.host.rerender();
    try {
      // How it merges, as the hub says it (mergeMode), else from how far the base moved.
      const mode = this.diff?.mergeMode || (this.diff?.check && this.diff.check.moved > 0 ? 'merge' : 'ff');
      const r = await this.host.call('POST', `/api/sessions/${enc(this.surfaceId)}/merge`, { mode });
      if (r.status !== 200) throw new Error((r.body as { error?: string }).error || `the board answered ${r.status}`);
      this.host.back();
    } catch (e) {
      this.host.toast((e as Error).message);
    } finally { this.busy = false; this.host.rerender(); }
  }

  render(p: HubProject, s: HubSession): void {
    const d = this.diff;
    const wt = s.worktree as Worktree | undefined;
    const topic = s.topic || p.name;
    const added = d ? d.files.reduce((n, f) => n + f.added, 0) : 0;
    const removed = d ? d.files.reduce((n, f) => n + f.removed, 0) : 0;
    const pend = this.pending().length;
    const base = wt?.baseBranch || 'main';
    const done = s.state !== 'working';
    const check = d?.check;
    const head = h('div.rv-h',
      h('div.tt',
        h('div.rv-t', svg(I.REVIEW), done ? `${topic}, ready to merge` : `${topic}, its work so far`),
        h('div.rv-s',
          wt ? h('span', svg(I.BRANCH), ' ', h('span.mono', wt.branch.replace(/^ravenry\//, ''))) : null,
          d ? h('span.num', `${d.files.length} file${d.files.length === 1 ? '' : 's'}, +${added} −${removed}`) : h('span', 'Reading its work...'),
          d?.uncommitted?.length ? h('span.bad', svg(I.WARN), `${d.uncommitted.length} not committed yet`) : null,
          check ? (check.clean ? h('span.okk', svg(I.CHECK_C), `No clashes with ${base}`) : h('span.bad', svg(I.WARN), `Clashes with ${base} in ${check.conflicts.length} file${check.conflicts.length === 1 ? '' : 's'}`)) : null)),
      pend ? h('button.btn.sm', { disabled: this.busy, on: { click: () => void this.sendComments() } }, `Send ${pend} comment${pend === 1 ? '' : 's'}`) : null,
      h('button.btn.sm.pri', { disabled: this.busy || !wt || wt.state !== 'open' || !d || !d.files.length, on: { click: () => void this.merge() } }, svg(I.MERGE), `Merge into ${base}`));
    if (!d) { replace(this.el, head, h('div.rv-b', h('p.t3', { style: { padding: '20px' } }, 'Reading its work...'))); return; }
    if (!d.ok) { replace(this.el, head, h('div.rv-b', h('p.t3', { style: { padding: '20px' } }, d.error || 'Nothing to review.'))); return; }
    const list = h('div.rv-fl', h('div.h', `${d.files.length} file${d.files.length === 1 ? '' : 's'}`),
      d.files.map((f) => {
        const n = (this.comments.get(f.path) || []).length;
        return h(`button.rv-f${f.path === this.sel ? '.on' : ''}`, { title: f.path, on: { click: () => { this.sel = f.path; this.host.rerender(); } } },
          h('span.fp', f.path), n ? h('span.cc', String(n)) : null, h('span.ad.num', `+${f.added}`), h('span.rm.num', `−${f.removed}`));
      }));
    const f = d.files.find((x) => x.path === this.sel);
    const lines = this.sel ? this.files.get(this.sel) || [] : [];
    const view = h('div.rv-d',
      f ? h('div.rv-dh', f.path, h('span.t3.num', `+${f.added} −${f.removed}`)) : null,
      f && f.binary ? h('p', { style: { padding: '0 16px' } }, 'A binary file.') : null,
      lines.map((l) => this.line(f!.path, l, assistantName(s.assistant) || 'the agent')));
    replace(this.el, head, h('div.rv-b', list, view));
  }

  private line(file: string, l: Line, who: string): (HTMLElement | null)[] {
    if (l.kind === 'hunk') return [h('div.dl.hunk', h('span.ln'), h('span.sg'), h('span', l.text))];
    const no = l.newNo ?? l.oldNo!;
    const side: 'new' | 'old' = l.newNo !== null ? 'new' : 'old';
    const cs = (this.comments.get(file) || []).filter((c) => c.line === no && c.side === side);
    const comp = this.composing && this.composing.file === file && this.composing.line === no && this.composing.side === side ? this.composing : null;
    const row = h(`div.dl.${l.kind}${cs.length || comp ? '.cmt' : ''}`, { title: 'Comment on this line', on: { dblclick: () => this.compose(file, no, side) } },
      h('span.ln.num', String(no)), h('span.sg', l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''), h('span', l.text),
      h('button.cm-btn', { 'aria-label': 'Comment on this line', on: { click: () => this.compose(file, no, side) } }, '+'));
    const out: (HTMLElement | null)[] = [row];
    if (cs.length || comp) {
      out.push(h('div.cth',
        cs.map((c) => [
          h('div.c', h('div.ch', h('b', 'You'), h('span.t3.num', hm(c.at)), c.state === 'sent' ? h('span.st2.sent', svg(I.CHECK_C), `Sent to ${who}`) : [h('span.st2.wait', 'Not sent yet'), h('button.lk', { style: { marginLeft: '8px' }, on: { click: () => void this.remove(c) } }, 'Take back')]), h('div', c.text)),
          (c.replies || []).map((r) => h('div.c', h('div.ch', h('b', who), h('span.t3.num', hm(r.at))), h('div', r.text))),
        ]),
        comp ? this.composer(comp) : null));
    }
    return out;
  }

  private compose(file: string, line: number, side: 'new' | 'old'): void {
    this.composing = { file, line, side, text: '' };
    this.host.rerender();
    requestAnimationFrame(() => (this.el.querySelector('.cth textarea') as HTMLTextAreaElement | null)?.focus());
  }

  private composer(c: { file: string; line: number; side: 'new' | 'old'; text: string }): HTMLElement {
    const ta = h('textarea', { placeholder: 'Say what to change here' }) as HTMLTextAreaElement;
    ta.value = c.text;
    const add = async () => {
      const t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      const r = await this.host.call('POST', `/api/sessions/${enc(this.surfaceId)}/review/comment`, { file: c.file, line: c.line, side: c.side, text: t });
      if (r.status !== 200) { this.host.toast((r.body as { error?: string }).error || 'The board did not keep the comment.'); return; }
      this.composing = null;
      await this.loadComments();
      this.host.rerender();
    };
    ta.addEventListener('input', () => { c.text = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); }
      if (e.key === 'Escape') { e.preventDefault(); this.composing = null; this.host.rerender(); }
      e.stopPropagation();
    });
    return h('div', h('div.c', ta), h('div.qa', h('button.btn.sm.pri', { on: { click: () => void add() } }, 'Add comment'), h('button.btn.sm.ghost', { on: { click: () => { this.composing = null; this.host.rerender(); } } }, 'Cancel')));
  }

  private async remove(c: Comment): Promise<void> {
    const r = await this.host.call('POST', `/api/sessions/${enc(this.surfaceId)}/review/remove`, { id: c.id });
    if (r.status !== 200) this.host.toast((r.body as { error?: string }).error || 'Could not take it back.');
    await this.loadComments();
  }

  // ------------------------------------------------ the panel's cards

  /** A session's diff for its cards, read again when older than 20 s while its work is open. */
  diffOf(s: HubSession): Diff | null {
    const c = this.known.get(s.surfaceId);
    const open = s.worktree && s.worktree.state === 'open';
    if (open && (!c || (!c.loading && this.host.now() - c.at > 20000))) {
      this.known.set(s.surfaceId, { at: c?.at || 0, diff: c?.diff || null, loading: true });
      void this.host.call('GET', `/api/sessions/${enc(s.surfaceId)}/diff`).then((r) => {
        this.known.set(s.surfaceId, { at: this.host.now(), diff: r.status === 200 ? r.body as Diff : c?.diff || null, loading: false });
        this.host.rerender();
      });
    }
    return c?.diff || null;
  }

  /** Done and with work to review: its row in the sidebar says so. */
  readyFiles(s: HubSession): number | null {
    if (!s.worktree || s.worktree.state !== 'open' || s.state === 'working') return null;
    const d = this.diffOf(s);
    return d && d.ok && d.files.length ? d.files.length : null;
  }

  /** "Codex is done and asks for a review", or after a merge, what landed. */
  panelCards(p: HubProject, s: HubSession, openReview: () => void): (HTMLElement | null)[] {
    const wt = s.worktree as Worktree | undefined;
    if (!wt) return [];
    const who = assistantName(s.assistant) || 'The agent';
    const topic = s.topic || p.name;
    const base = wt.baseBranch || 'main';
    const branch = wt.branch.replace(/^ravenry\//, '');
    if (wt.state === 'merged' && wt.merged) {
      const d = this.known.get(s.surfaceId)?.diff;
      const n = d ? d.files.length : null;
      const c = d?.check?.ahead || null;
      return [h('div.sec.cp.merged',
        h('div.cp-h', h('span.kd', svg(I.CHECK_C)), `Merged into ${base}`, h('span.sp'), h('span.t3.num', hm(wt.merged.at))),
        h('div.cp-q', topic),
        h('p.cp-d', `${n ? `${n} file${n === 1 ? '' : 's'} and ${c ? `${c} commit${c === 1 ? '' : 's'}` : 'its commits'}` : 'Its commits'} ${n ? 'are' : 'are'} on ${base} now. Its copy is removed; the branch `, h('span.mono', branch), wt.branch_deleted_at ? ' is deleted too.' : ' stays until you delete it.'),
        h('div.mg-acts',
          h('button.btn.sm', { on: { click: () => void this.unmerge(s) } }, svg(I.UNDO), 'Undo the merge'),
          wt.branch_deleted_at ? null : h('button.btn.sm.ghost', { on: { click: () => void this.deleteBranch(s) } }, 'Delete the branch')))];
    }
    if (wt.state !== 'open') return [];
    const out: (HTMLElement | null)[] = [];
    const known = this.diffOf(s);
    if (s.state !== 'working' && (!known || known.files.length)) {
      const check = known?.check;
      const moved = check && check.moved ? ` ${base} moved ${check.moved} commit${check.moved === 1 ? '' : 's'} since it started; it ${check.clean ? 'still merges cleanly' : 'clashes now'}.` : '';
      out.push(h('div.sec.ask.cp',
        h('div.cp-h', h('span.kd', svg(I.REVIEW)), `${who} is done and asks for a review`),
        h('div.cp-q', topic),
        h('p.cp-d', `Built in its own copy on `, h('span.mono', branch), `.${moved}`),
        h('div.qa', h('button.btn.sm.pri', { on: { click: openReview } }, 'Review'), h('button.btn.sm', { on: { click: () => { this.key = null; this.surfaceId = s.surfaceId; void this.merge(); } } }, 'Merge without reviewing'))));
    }
    out.push(h('div.sec',
      h('div.sec-h', 'Its copy'),
      h('div.kv',
        h('span', 'Branch'), h('span.mono', branch),
        h('span', 'Folder'), h('span.mono', this.host.tilde(wt.folder)),
        h('span', 'After'), h('span', 'Merge removes the copy and keeps the branch'))));
    return out;
  }

  private async unmerge(s: HubSession): Promise<void> {
    const r = await this.host.call('POST', `/api/sessions/${enc(s.surfaceId)}/unmerge`, {});
    this.host.toast(r.status === 200 ? 'The merge is undone. Its copy is back on its branch.' : (r.body as { error?: string }).error || 'Could not undo the merge.');
    this.host.rerender();
  }

  private async deleteBranch(s: HubSession): Promise<void> {
    const r = await this.host.call('POST', `/api/sessions/${enc(s.surfaceId)}/delete-branch`, {});
    this.host.toast(r.status === 200 ? 'The branch is deleted.' : (r.body as { error?: string }).error || 'Could not delete the branch.');
    this.host.rerender();
  }
}
