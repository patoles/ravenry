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

export type HubStatus = { reachable: boolean; url: string; error?: string };

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

  constructor(url: string, onState: (s: unknown) => void, onStatus: (s: HubStatus) => void) {
    this.url = url;
    this.onState = onState;
    this.onStatus = onStatus;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private setStatus(s: HubStatus): void {
    if (this.status && s.reachable === this.status.reachable && s.error === this.status.error) return;
    this.status = s;
    this.onStatus(s);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const res = await fetch(this.url + '/api/events', { signal: this.abort.signal, headers: { Accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new Error(`the board answered ${res.status}`);
        this.setStatus({ reachable: true, url: this.url });
        this.retryMs = 1000;
        await this.read(res.body);
        throw new Error('the board closed the stream');
      } catch (e) {
        if (this.stopped) return;
        this.setStatus({ reachable: false, url: this.url, error: String((e as Error).message || e) });
        await new Promise((r) => setTimeout(r, this.retryMs));
        this.retryMs = Math.min(this.retryMs * 2, 10000);
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

/** POST to a hub API path, as the board's own page does (X-Ravenry: 1). */
export async function hubPost(url: string, p: string, body: unknown): Promise<unknown> {
  const res = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error || `${p}: the board answered ${res.status}`);
  return j;
}
