// The window's connections to ravenryd, one per daemon. New panes go to
// the newest daemon; a pane made before an update stays in the daemon that
// runs it, so a tab remembers its daemon's socket.

import { messagePortTransport, RavenryClient } from '@ravenry/client';
import type { DaemonEvent } from '@ravenry/client';
import { api } from './api.ts';

let nextReq = 1;

function connectOnce(socket?: string): Promise<{ client: RavenryClient; socket: string }> {
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; req?: number; socket?: string; message?: string; where?: string };
      if (ev.source !== window || !d || d.req !== req) return;
      if (d.type === 'ravenry:daemon-port') {
        window.removeEventListener('message', onMsg);
        const t = messagePortTransport(ev.ports[0] as unknown as Parameters<typeof messagePortTransport>[0]);
        RavenryClient.connect(t, { name: 'ravenry-desktop', version: '0.1.0' })
          .then((client) => resolve({ client, socket: d.socket! }), reject);
      } else if (d.type === 'ravenry:daemon-error') {
        window.removeEventListener('message', onMsg);
        reject(new Error(d.message || 'could not reach ravenryd'));
      }
    };
    window.addEventListener('message', onMsg);
    api().connectDaemon(req, socket);
  });
}

export class Daemons {
  /** The daemon new panes go to. */
  newest: { client: RavenryClient; socket: string } | null = null;
  private clients = new Map<string, Promise<RavenryClient>>();
  private onEvent: (socket: string, e: DaemonEvent) => void;
  private onLost: (socket: string) => void;
  private onReady: (socket: string, client: RavenryClient) => void;

  /**
   * onEvent: each event of each daemon. onLost: a daemon's connection
   * closed. onReady: a daemon was reached and subscribed to (list what it
   * holds then: events only tell what changes).
   */
  constructor(onEvent: (socket: string, e: DaemonEvent) => void, onLost: (socket: string) => void, onReady: (socket: string, client: RavenryClient) => void = () => {}) {
    this.onEvent = onEvent;
    this.onLost = onLost;
    this.onReady = onReady;
  }

  /** The client of the daemon new panes go to, connecting (and starting it) when needed. */
  async forNew(): Promise<{ client: RavenryClient; socket: string }> {
    if (this.newest && !this.newest.client.closed && !this.newest.client.hello.daemon.draining) return this.newest;
    const c = await connectOnce();
    // Already held (a tab of it was restored): one connection per daemon.
    const known = this.clients.get(c.socket);
    if (known) {
      try {
        const k = await known;
        if (!k.closed) { c.client.close(); this.newest = { client: k, socket: c.socket }; return this.newest; }
      } catch { /* that one failed: use the new one */ }
    }
    this.adopt(c.socket, c.client);
    this.newest = c;
    return c;
  }

  /**
   * The client of the daemon that holds a pane: the newest first, then the
   * others this window knows, then every other daemon running in the
   * runtime folder, of any version. A pane made before an update lives in
   * the older daemon until it ends (2026-11-07: a session resumed in 0.1.3's
   * daemon could not be shown by 0.1.4).
   */
  async holding(pane: string): Promise<RavenryClient | null> {
    const cands: RavenryClient[] = [];
    try { cands.push((await this.forNew()).client); } catch { /* none running */ }
    for (const p of this.clients.values()) { try { const c = await p; if (!cands.includes(c)) cands.push(c); } catch { /* gone */ } }
    let sockets: string[] = [];
    try { sockets = await api().daemonSockets(); } catch { /* none */ }
    for (const s of sockets) { try { const c = await this.get(s); if (!cands.includes(c)) cands.push(c); } catch { /* a stale socket */ } }
    for (const c of cands) {
      try { const { panes } = await c.request('pane.list', { hidden: true }); if (panes.some((x) => x.id === pane)) return c; } catch { /* next */ }
    }
    return null;
  }

  /** The client of a given daemon. */
  get(socket: string): Promise<RavenryClient> {
    const known = this.clients.get(socket);
    if (known) return known;
    const p = connectOnce(socket).then(({ client }) => { this.adopt(socket, client, false); return client; });
    this.clients.set(socket, p);
    p.catch(() => { if (this.clients.get(socket) === p) this.clients.delete(socket); });
    return p;
  }

  private adopt(socket: string, client: RavenryClient, set = true): void {
    if (set) this.clients.set(socket, Promise.resolve(client));
    client.onEvent((e) => {
      if (e.event === 'daemon.draining') {
        // A newer version runs beside this one: new panes go there from now on.
        if (this.newest && this.newest.socket === socket) this.newest = null;
        api().resetDaemon();
      }
      this.onEvent(socket, e);
    });
    client.onClose(() => {
      this.clients.delete(socket);
      if (this.newest && this.newest.socket === socket) this.newest = null;
      this.onLost(socket);
    });
    // A window shows panes to a person, so it asks for pane.focus, and for
    // pane.activity (output in the tabs it does not show). A daemon from
    // before a field refuses it: ask again without.
    void (async () => {
      for (const p of [{ display: true, activity: true }, { display: true }, {}]) {
        try { await client.request('events.subscribe', p); break; } catch { /* an older daemon */ }
      }
      if (!client.closed) this.onReady(socket, client);
    })();
  }
}
