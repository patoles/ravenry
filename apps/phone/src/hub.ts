// The hub as the page sees it: its state from the live stream and its
// calls, through the shell.

import { takeAssistants, type HubState } from '../../desktop/src/renderer/model.ts';
import type { HubCheckpoint } from '../../desktop/src/renderer/checkpoints.ts';
import { current } from './shell.ts';

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
    // The assistants' names and tags are the hub's list (assistants.list), for the checkpoint screens.
    if (m.name === 'state') { live.state = m.data as HubState; takeAssistants(live.state); live.link = 'up'; live.error = null; changed(); }
  });
  sh.on('link', (m) => { live.link = m.state === 'up' ? 'up' : 'down'; live.error = (m.error as string) || null; changed(); });
  await sh.call('hub.events', { on: true });
  const r = await call('GET', '/api/state').catch(() => null);
  if (r && r.status === 200 && !live.state) { live.state = r.body as unknown as HubState; takeAssistants(live.state); live.link = 'up'; changed(); }
  void loadMachines();
  setInterval(() => void loadMachines(), 30000);
}

async function loadMachines(): Promise<void> {
  const r = await call('GET', '/api/machines').catch(() => null);
  if (r && r.status === 200 && Array.isArray(r.body.machines)) { live.machines = r.body.machines as Live['machines']; changed(); }
}
