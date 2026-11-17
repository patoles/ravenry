// The app asks macOS for a folder itself (the Mac app's AccessAsk.swift).
//
// The hub is a background service (launchd), and macOS may never show its
// question to the person for it: on 2026-11-17, after an update changed
// the app's signature, the hub's question about ~/Documents had nobody to
// answer it. When the hub says a folder waits on macOS's answer, or was
// refused (state.access.blocked, or its 503's path before its first
// state), this app, in front with its window on screen, reads that folder
// itself, off the main thread (a worker thread, so neither the window nor
// libuv's pool waits on macOS), so macOS asks the person over the window.
// macOS keeps one answer for Ravenry (its bundle id and signature), and the
// hub's reads are attributed to the same app, so the answer is the hub's
// too; the hub then asks again at once (POST /api/access/retry).
//
// Once per folder and state in a run. A test's run never reads the
// person's own protected folders: the folder is recorded instead.
//
// No Electron here, so tests import it.

import os from 'node:os';
import { Worker } from 'node:worker_threads';

/** A folder to ask about and the hub's state for it. */
export interface Wanted { path: string; state: 'waiting' | 'denied' }

/** A test's run: a test's data, a test's hub or a window off every screen. */
export function isTestRun(env: Record<string, string | undefined>): boolean {
  return env.RAVENRY_HOME !== undefined || env.RAVENRY_DESKTOP_DATA !== undefined || env.RAVENRY_OFFSCREEN === '1';
}

/** The person's own folders macOS protects (their account's home, whatever HOME says). */
export function personsOwn(p: string, home: string = os.userInfo().homedir): boolean {
  const roots = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents'].map((x) => `${home}/${x}`);
  return p.startsWith('/Volumes/') || roots.some((r) => p === r || p.startsWith(r + '/'));
}

/**
 * The folders to ask about in this state: each folder the hub leaves alone,
 * waiting or refused (a slow one is allowed already: asking changes
 * nothing; its words say what does), and the folder the hub's 503 names.
 */
export function wanted(access: unknown, waitingPath: string | null | undefined): Wanted[] {
  const out: Wanted[] = [];
  const blocked = access && typeof access === 'object' ? (access as { blocked?: unknown }).blocked : null;
  for (const b of Array.isArray(blocked) ? blocked : []) {
    const p = b && typeof b.path === 'string' ? b.path : null;
    const s = b && b.state;
    if (!p || !p.startsWith('/') || (s !== 'waiting' && s !== 'denied')) continue;
    out.push({ path: p, state: s });
  }
  if (waitingPath && waitingPath.startsWith('/') && !out.some((x) => x.path === waitingPath)) out.push({ path: waitingPath, state: 'waiting' });
  return out;
}

/** How a read of the folder went: "ok", "EPERM", "EACCES" or "error <code>", and how long it took. */
export type ReadResult = { how: string; ms: number };

const READ_IN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const t0 = Date.now();
let how = 'ok';
try { fs.readdirSync(workerData); } catch (e) { how = e && (e.code === 'EPERM' || e.code === 'EACCES') ? e.code : 'error ' + ((e && (e.code || e.message)) || e); }
parentPort.postMessage({ how, ms: Date.now() - t0 });
`;

/** Lists the folder in a worker thread, so macOS's question waits there and nowhere else. */
export function readOffMain(p: string): Promise<ReadResult> {
  return new Promise((resolve) => {
    const w = new Worker(READ_IN_WORKER, { eval: true, workerData: p });
    // A question never answered must not hold the app's exit.
    w.unref();
    let done = false;
    const end = (r: ReadResult) => { if (!done) { done = true; resolve(r); } };
    w.once('message', (r: ReadResult) => end(r));
    w.once('error', (e) => end({ how: `error ${(e as Error).message || e}`, ms: 0 }));
    w.once('exit', () => end({ how: 'error the reader ended', ms: 0 }));
  });
}

export interface AskerOpts {
  /** A test's run: the person's own protected folders are never read. */
  test: boolean;
  log: (line: string) => void;
  read?: (p: string) => Promise<ReadResult>;
  home?: string;
}

export class AccessAsker {
  /** The folders asked, "<path>|<state>". */
  readonly asked = new Set<string>();
  /** What was read or would have been: "read PATH: ok|EPERM|..." or "skipped PATH". */
  readonly record: string[] = [];
  private opts: AskerOpts;

  constructor(opts: AskerOpts) { this.opts = opts; }

  /**
   * Asks for each folder not asked yet in this state, when the app is in
   * front with its window on screen; `retry` tells the hub once the read
   * returned.
   */
  ask(folders: Wanted[], front: boolean, retry: () => void): void {
    if (!folders.length || !front) return;
    const read = this.opts.read || readOffMain;
    for (const f of folders) {
      const key = `${f.path}|${f.state}`;
      if (this.asked.has(key)) continue;
      this.asked.add(key);
      if (this.opts.test && personsOwn(f.path, this.opts.home)) {
        this.record.push(`skipped ${f.path}`);
        this.opts.log(`access: a test's run does not ask macOS for ${f.path}`);
        continue;
      }
      this.opts.log(`access: the hub has no answer for ${f.path} (${f.state}); this app asks macOS itself`);
      void read(f.path).then((r) => {
        this.record.push(`read ${f.path}: ${r.how}`);
        this.opts.log(`access: macOS answered this app for ${f.path} in ${r.ms} ms (${r.how}); the hub asks again`);
        retry();
      });
    }
  }
}
