// The hub as the page sees it: its state from the live stream, its calls,
// and the protocol v1 stream of a pane, all through the shell.

import { RavenryClient } from '@ravenry/client';
import type { Transport } from '@ravenry/client';
import type { HubState } from '../../desktop/src/renderer/model.ts';
import type { HubCheckpoint } from '../../desktop/src/renderer/checkpoints.ts';
import { b64, current } from './shell.ts';

export interface Reply { status: number; body: Record<string, unknown> }

export async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  const r = await current().call<{ status: number; body: unknown }>('hub.call', { method, path, body: body ?? null });
  const b = r.body && typeof r.body === 'object' ? (r.body as Record<string, unknown>) : { text: r.body };
  if (r.status === 401 && b.signedOut) onSignedOut();
  return { status: r.status, body: b };
}

/** A POST that throws the hub's own words when it did not go through. */
export async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await call('POST', path, body);
  if (r.status !== 200) throw new Error(String(r.body.error || `The computer answered ${r.status}.`));
  return r.body;
}

let signedOutFn: () => void = () => {};
export function onSignedOutDo(fn: () => void): void { signedOutFn = fn; }
function onSignedOut(): void { signedOutFn(); }

// ---------------------------------------------------------------- live state

export interface Live {
  state: HubState | null;
  link: 'up' | 'down' | 'connecting';
  error: string | null;
  machines: { name: string; state: string }[];
}

export const live: Live = { state: null, link: 'connecting', error: null, machines: [] };
const watchers = new Set<() => void>();
export function watch(fn: () => void): () => void { watchers.add(fn); return () => watchers.delete(fn); }
function changed(): void { for (const fn of watchers) fn(); }

export function checkpoints(): HubCheckpoint[] {
  return ((live.state?.checkpoints || []) as HubCheckpoint[]).filter((c) => c && (c.state === 'open' || c.state === 'running'));
}

let started = false;
export async function start(): Promise<void> {
  if (started) return;
  started = true;
  const sh = current();
  sh.on('hub', (m) => {
    if (m.name === 'state') { live.state = m.data as HubState; live.link = 'up'; live.error = null; changed(); }
  });
  sh.on('link', (m) => { live.link = m.state === 'up' ? 'up' : 'down'; live.error = (m.error as string) || null; changed(); });
  await sh.call('hub.events', { on: true });
  const r = await call('GET', '/api/state').catch(() => null);
  if (r && r.status === 200 && !live.state) { live.state = r.body as unknown as HubState; live.link = 'up'; changed(); }
  void loadMachines();
  setInterval(() => void loadMachines(), 30000);
}

async function loadMachines(): Promise<void> {
  const r = await call('GET', '/api/machines').catch(() => null);
  if (r && r.status === 200 && Array.isArray(r.body.machines)) { live.machines = r.body.machines as Live['machines']; changed(); }
}

// ---------------------------------------------------------------- a pane's stream

/** A protocol v1 transport over the shell's socket ops (docs/PHONE.md section 6). */
export async function paneTransport(pane: string): Promise<Transport> {
  const sh = current();
  const { sid } = await sh.call<{ sid: number }>('socket.open', { path: `/api/term?pane=${encodeURIComponent(pane)}`, protocol: 'ravenry.v1' });
  const t: Transport = {
    send: (d) => { void sh.call('socket.send', typeof d === 'string' ? { sid, text: d } : { sid, b64: b64.from(d) }).catch(() => {}); },
    close: () => { off1(); off2(); void sh.call('socket.close', { sid }).catch(() => {}); },
    onmessage: null,
    onclose: null,
  };
  const off1 = sh.on('socket.message', (m) => {
    if (m.sid !== sid) return;
    t.onmessage?.(typeof m.text === 'string' ? m.text : b64.to(String(m.b64)));
  });
  const off2 = sh.on('socket.close', (m) => {
    if (m.sid !== sid) return;
    off1(); off2();
    t.onclose?.(String(m.reason || `closed (${m.code})`));
  });
  return t;
}

export async function paneClient(pane: string): Promise<RavenryClient> {
  return RavenryClient.connect(await paneTransport(pane), { name: 'ravenry-phone', version: current().hello.app });
}
