// Who drives each pane, as the daemons this window holds say it
// (PROTOCOL.md section 4, Panes and who drives them): every pane's creator
// and lease (with who waits for it), its input log and the grants on it.
// The panes come from pane.list when a daemon is reached, then from its
// events (pane.lease, pane.created, pane.updated, pane.closed, pane.input).
// Input logs and grants are read when a pane is looked at.
//
// Pure lookups over the store, so the panel, the sidebar and the terminal
// ask the same questions the same way.

import type { DaemonEvent, Grant, InputRecord, Lease, Pane, RavenryClient, Source } from '@ravenry/client';

export interface Known { socket: string; pane: Pane }

const MAX_INPUTS = 400;

export class PaneStore {
  /** Every pane of every daemon this window holds, by id. */
  readonly panes = new Map<string, Known>();
  private inputs = new Map<string, InputRecord[]>();
  private loaded = new Set<string>();
  private grants = new Map<string, Grant[]>();
  private again = new Map<string, ReturnType<typeof setTimeout>>();
  /** Called when something the window shows changed. */
  onChange: (what: { pane: string; kind: 'lease' | 'input' | 'pane' | 'grants' }) => void = () => {};

  /** A daemon was reached: what it holds now. */
  async load(socket: string, client: RavenryClient): Promise<void> {
    try {
      const { panes } = await client.request('pane.list', { hidden: true });
      for (const [id, k] of [...this.panes]) if (k.socket === socket && !panes.some((p) => p.id === id)) this.panes.delete(id);
      for (const p of panes) this.panes.set(p.id, { socket, pane: p });
      this.onChange({ pane: '', kind: 'pane' });
    } catch { /* an older daemon, or it went away */ }
  }

  drop(socket: string): void {
    for (const [id, k] of [...this.panes]) if (k.socket === socket) this.panes.delete(id);
  }

  /** A daemon's event; true when it was one of the store's. */
  event(socket: string, e: DaemonEvent): boolean {
    switch (e.event) {
      case 'pane.lease': {
        const had = this.panes.get(e.pane.id);
        this.panes.set(e.pane.id, { socket, pane: { ...(had?.pane || {}), ...e.pane, lease: e.pane.lease } as Pane });
        if (!e.pane.lease && had) delete (this.panes.get(e.pane.id)!.pane as { lease?: Lease }).lease;
        this.onChange({ pane: e.pane.id, kind: 'lease' });
        return true;
      }
      case 'pane.input': {
        const list = this.inputs.get(e.pane.id);
        if (list && !list.some((r) => r.seq === e.input.seq)) {
          list.push(e.input);
          if (list.length > MAX_INPUTS) list.splice(0, list.length - MAX_INPUTS);
        } else if (!list) this.inputs.set(e.pane.id, [e.input]);
        // A gathered record of keystrokes grows: the same seq again.
        else { const i = list.findIndex((r) => r.seq === e.input.seq); if (i >= 0) list[i] = e.input; }
        // Keystrokes gather into one record while they come less than 2 s
        // apart, and the daemon tells only of the first: read it again after.
        if (e.input.kind === 'keys') { clearTimeout(this.again.get(e.pane.id)); this.again.set(e.pane.id, setTimeout(() => { this.loaded.delete(e.pane.id); this.inputsOf(e.pane.id); }, 2300)); }
        this.onChange({ pane: e.pane.id, kind: 'input' });
        return true;
      }
      case 'pane.created': case 'pane.updated': case 'pane.title': case 'pane.cwd': case 'pane.exited': {
        const had = this.panes.get(e.pane.id);
        this.panes.set(e.pane.id, { socket, pane: { ...(had?.pane || {}), ...e.pane } as Pane });
        // A new pane's event may not say who started it: the list does.
        if (e.event === 'pane.created' && !e.pane.creator) void this.client(socket).then((c) => this.load(socket, c)).catch(() => {});
        return false;
      }
      case 'pane.closed':
        this.panes.delete(e.pane.id);
        this.inputs.delete(e.pane.id);
        this.loaded.delete(e.pane.id);
        this.grants.delete(e.pane.id);
        return false;
      case 'checkpoint.closed':
        // A drive answered for its session adds a grant.
        if (e.checkpoint.kind === 'drive' && e.checkpoint.drive) void this.loadGrants(socket, e.checkpoint.drive.pane);
        return false;
    }
    return false;
  }

  private client: (socket: string) => Promise<RavenryClient> = () => Promise.reject(new Error('no daemon'));
  useClients(get: (socket: string) => Promise<RavenryClient>): void { this.client = get; }

  get(pane: string): Known | null { return this.panes.get(pane) || null; }

  /** The pane's input log, oldest first; read from its daemon the first time. */
  inputsOf(pane: string): InputRecord[] {
    const k = this.panes.get(pane);
    if (k && !this.loaded.has(pane)) {
      this.loaded.add(pane);
      void this.client(k.socket).then((c) => c.request('pane.inputs', { pane, limit: 1000 })).then((r) => {
        const live = this.inputs.get(pane) || [];
        const seen = new Set(r.inputs.map((x) => x.seq));
        this.inputs.set(pane, [...r.inputs, ...live.filter((x) => !seen.has(x.seq))].sort((a, b) => a.seq - b.seq));
        this.onChange({ pane, kind: 'input' });
      }).catch(() => { this.loaded.delete(pane); });
    }
    return this.inputs.get(pane) || [];
  }

  grantsOf(pane: string): Grant[] {
    const k = this.panes.get(pane);
    if (k && !this.grants.has(pane)) { this.grants.set(pane, []); void this.loadGrants(k.socket, pane); }
    return this.grants.get(pane) || [];
  }

  async loadGrants(socket: string, pane: string): Promise<void> {
    try {
      const c = await this.client(socket);
      const { grants } = await c.request('pane.grants', { pane });
      this.grants.set(pane, grants);
      this.onChange({ pane, kind: 'grants' });
    } catch { /* an older daemon */ }
  }

  /** A person ends a grant. */
  async revoke(pane: string, grant: string): Promise<void> {
    const k = this.panes.get(pane);
    if (!k) throw new Error('That pane is gone.');
    const c = await this.client(k.socket);
    await c.request('pane.revoke', { grant });
    await this.loadGrants(k.socket, pane);
  }

  /** The person releases a pane's lease: to the first in line, or back to themselves. */
  async release(pane: string, takeBack: boolean): Promise<void> {
    const k = this.panes.get(pane);
    if (!k) throw new Error('That pane is gone.');
    const c = await this.client(k.socket);
    await c.request('pane.lease', { pane, release: true, ...(takeBack ? { refuse_waiting: true } : {}) });
  }

  leaseOf(pane: string): Lease | null {
    const l = this.panes.get(pane)?.pane.lease;
    if (!l) return null;
    return Date.parse(l.expires_at) > Date.now() ? l : null;
  }

  /** The panes an agent's pane holds the lease of, other than its own. */
  heldBy(agentPane: string): Known[] {
    return [...this.panes.values()].filter((k) => k.pane.id !== agentPane && this.leaseOf(k.pane.id)?.holder.pane === agentPane);
  }

  /** The panes an agent's pane waits for, with who holds each. */
  waitedBy(agentPane: string): { k: Known; holder: Source }[] {
    const out: { k: Known; holder: Source }[] = [];
    for (const k of this.panes.values()) {
      const l = this.leaseOf(k.pane.id);
      if (l && (l.waiting || []).some((w) => w.pane === agentPane)) out.push({ k, holder: l.holder });
    }
    return out;
  }

  /** The panes an agent's pane started (its own) and the others it drives or holds. */
  usedBy(agentPane: string): { k: Known; how: 'own' | 'lent' }[] {
    const own = [...this.panes.values()].filter((k) => k.pane.creator?.kind === 'agent' && k.pane.creator.pane === agentPane && k.pane.state === 'running');
    const lent = this.heldBy(agentPane);
    return [...own.map((k) => ({ k, how: 'own' as const })), ...lent.filter((k) => !own.includes(k)).map((k) => ({ k, how: 'lent' as const }))];
  }
}

/** Two Sources are the same driver. */
export function sameSource(a: Source | null | undefined, b: Source | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'agent') return a.pane === b.pane;
  if (a.kind === 'client') return a.client === b.client;
  return true;
}

/** A key typed as its token in the input log ("<Ctrl+C>"), as people read it ("Ctrl C"). */
export function keyLabel(token: string): string {
  return token.replace(/^</, '').replace(/>$/, '').replace(/\+/g, ' ');
}

/** What an input typed, as text and keys in order: "npm run dev", "Enter". */
export function inputParts(text: string | undefined): { kind: 'text' | 'key'; text: string }[] {
  const out: { kind: 'text' | 'key'; text: string }[] = [];
  const re = /<([A-Za-z0-9+/]+)>/g;
  let at = 0;
  const t = String(text || '');
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index > at) out.push({ kind: 'text', text: t.slice(at, m.index) });
    out.push({ kind: 'key', text: keyLabel(m[0]) });
    at = m.index + m[0].length;
  }
  if (at < t.length) out.push({ kind: 'text', text: t.slice(at) });
  return out;
}

/**
 * What a terminal shows for an input's typing: its text, and ^C for a
 * control key the line discipline echoes. Each part is one stretch to find
 * on screen; Enter and the like show nothing.
 */
export function echoParts(text: string | undefined): string[] {
  const out: string[] = [];
  for (const p of inputParts(text)) {
    if (p.kind === 'text') { for (const line of p.text.split(/\r|\n/)) if (line.trim()) out.push(line); continue; }
    const m = /^Ctrl ([A-Z])$/.exec(p.text);
    if (m && 'CZ\\'.includes(m[1])) out.push(`^${m[1]}`);
  }
  return out;
}
