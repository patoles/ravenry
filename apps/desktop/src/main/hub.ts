// The hub: the board's server, which knows every session and what it needs.
// The window reads it through here (the page is a file, so the hub's
// same-origin API is reached from the main process), and gets each new
// state as the hub pushes it.
//
// Where it is: RAVENRY_HUB_URL, else the port the running board wrote to
// <RAVENRY_HOME or ~/.ravenry>/board.json, else the board's default port.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PORT = 4600;

export function hubUrl(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.RAVENRY_HUB_URL) return env.RAVENRY_HUB_URL.replace(/\/+$/, '');
  const dataDir = env.RAVENRY_HOME || path.join(home, '.ravenry');
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dataDir, 'board.json'), 'utf8')) as { port?: number };
    if (b && Number.isInteger(b.port)) return `http://127.0.0.1:${b.port}`;
  } catch { /* not running, or never ran */ }
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

/**
 * `starting`: the hub answers but is not reading yet, with the folder macOS
 * is asking about (hub/server/access.mjs): its 503 says so, as ~/Documents
 * (waitingFor), as System Settings names it (folder), its path (for the app
 * to ask macOS itself, accessask.ts) and the pane of System Settings its
 * words name (settings).
 */
export type HubStatus = { reachable: boolean; url: string; error?: string; starting?: { waitingFor: string | null; folder: string | null; path?: string | null; settings?: string | null } };

/** Reads the hub's server-sent events (event: state) and calls back with each state. */
export class HubFeed {
  url: string;
  /** Null until the first try to reach the hub has an answer. */
  status: HubStatus | null = null;
  last: unknown = null;
  private onState: (s: unknown) => void;
  private onStatus: (s: HubStatus) => void;
  private stopped = false;
  private abort: AbortController | null = null;
  private retryMs = 1000;
  private startedAt = 0;

  /** This app's id on the hub: with two apps (this one and the native Mac app), notifications go to the one focused last. */
  readonly client = randomUUID();

  /** A Mac notification the hub asks this app to post (event: notify). */
  onNotify: (n: unknown) => void = () => {};

  constructor(url: string, onState: (s: unknown) => void, onStatus: (s: HubStatus) => void) {
    this.url = url;
    this.onState = onState;
    this.onStatus = onStatus;
  }

  start(): void {
    this.startedAt = Date.now();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private setStatus(s: HubStatus): void {
    if (this.status && s.reachable === this.status.reachable && s.error === this.status.error && JSON.stringify(s.starting) === JSON.stringify(this.status.starting)) return;
    this.status = s;
    this.onStatus(s);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        // ?app=1: the app's own stream, which the hub sends Mac notifications to.
        const res = await fetch(this.url + `/api/events?app=1&client=${this.client}`, { signal: this.abort.signal, headers: { Accept: 'text/event-stream' } });
        if (res.status === 503) {
          // Starting: waiting for macOS to say whether it may read a folder.
          let j: { error?: string; waitingFor?: string; folder?: string; path?: string; settings?: string } = {};
          try { j = await res.json() as typeof j; } catch { /* not JSON */ }
          this.setStatus({ reachable: false, url: this.url, error: j.error || 'The board is starting.', starting: { waitingFor: j.waitingFor || null, folder: j.folder || null, path: j.path || null, settings: j.settings || null } });
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (!res.ok || !res.body) throw new Error(`the board answered ${res.status}`);
        this.setStatus({ reachable: true, url: this.url });
        this.retryMs = 1000;
        await this.read(res.body);
        throw new Error('the board closed the stream');
      } catch (e) {
        if (this.stopped) return;
        this.setStatus({ reachable: false, url: this.url, error: String((e as Error).message || e) });
        // On a first launch the hub service starts with the window and
        // answers about a second later: asked every 250 ms for the first
        // 15 s, so the sidebar and the hook offer come as soon as it does.
        const early = Date.now() - this.startedAt < 15000;
        await new Promise((r) => setTimeout(r, early ? 250 : this.retryMs));
        if (!early) this.retryMs = Math.min(this.retryMs * 2, 10000);
      }
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseEvent(block);
        if (ev && ev.event === 'state') {
          try { this.last = JSON.parse(ev.data); this.onState(this.last); } catch { /* a cut message */ }
        } else if (ev && ev.event === 'notify') {
          try { this.onNotify(JSON.parse(ev.data)); } catch { /* a cut message */ }
        }
      }
    }
  }
}

export function parseEvent(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** GET a hub API path, as JSON. */
export async function hubGet(url: string, p: string): Promise<unknown> {
  const res = await fetch(url + p);
  if (!res.ok) throw new Error(`${p}: the board answered ${res.status}`);
  return res.json();
}

/**
 * A person's answer to a checkpoint (POST /api/checkpoints/answer). Never
 * throws: the status tells a refusal (403: this process is not the person)
 * from other failures, and nothing of the request, which may hold a
 * secret, is logged or echoed.
 */
export async function hubAnswer(url: string, body: unknown): Promise<{ ok: boolean; status: number; error?: string; checkpoint?: unknown }> {
  try {
    const res = await fetch(url + '/api/checkpoints/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({})) as { error?: string; checkpoint?: unknown };
    return res.ok ? { ok: true, status: res.status, checkpoint: j.checkpoint } : { ok: false, status: res.status, error: j.error || `the board answered ${res.status}` };
  } catch {
    return { ok: false, status: 0, error: 'the board is not reachable' };
  }
}

/** A call whose answer the page reads whatever its status (a conflict, a
 * button that needs approval): { status, body }, status 0 when the hub is
 * not reachable. */
export async function hubCall(url: string, method: string, p: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url + p, method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: { error: 'The board is not reachable.' } };
  }
}

/** POST to a hub API path, as the board's own page does (X-Ravenry: 1). */
export async function hubPost(url: string, p: string, body: unknown): Promise<unknown> {
  const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `${p}: the board answered ${res.status}`);
  return j;
}
