// The switch from the npm board (`ravenry` from npm, 0.4.x) to the app's own
// hub, and the way back. The work is the hub's (hub/server/npmswitch.mjs,
// run here as Node on the app's own executable from the staged hub); this
// file runs it and says what the window offers. No Electron here, so tests
// import it.
//
// At launch the app asks the hub script what of the npm board is here (a
// board serving the data, a login start, its hooks). While there is any,
// the app installs and starts no hub of its own: the two would share the
// data with no lock (hub/server/npmswitch.mjs says why). The window offers
// the switch once, full size; after Not now, or after going back, a quiet
// bar keeps the offer.

import { spawn } from 'node:child_process';
import path from 'node:path';

export interface NpmBoard { port: number; pid: number | null; command: string; cwd: string | null; root: string | null; version: string | null; own: boolean }
export interface NpmLogin { label: string; plist: string; loaded: boolean; root: string | null; version: string | null }
export interface NpmRecord { state: 'switching' | 'switched' | 'back'; at: string; port: number; from: { root: string | null; version: string | null; node: string | null; board: { port: number; pid: number; command: string; cwd: string | null } | null }; login: { label: string; plist: string; loaded: boolean }[]; backup: string; switchedAt?: string; backAt?: string }
export interface NpmDetect {
  ok: boolean;
  error?: string;
  data?: string;
  npm: boolean;
  board: NpmBoard | null;
  login: NpmLogin[];
  hooks: { claude: { event: string; command: string }[]; codex: { event: string; command: string }[] };
  copy: { root: string; version: string | null; node: string | null } | null;
  record: NpmRecord | null;
}

/** What the window shows: nothing, the switch screen, or the quiet bar. */
export type Offer = 'none' | 'screen' | 'bar';

export function offerFor(d: NpmDetect | null, choice: string | null | undefined): Offer {
  if (!d || !d.ok || !d.npm) return 'none';
  if (choice === 'not-now' || choice === 'back' || (d.record && d.record.state === 'back')) return 'bar';
  return 'screen';
}

/** Whether the app may install and start its own hub: never beside an npm board. */
export function mayRunHub(d: NpmDetect | null): boolean {
  return !d || !d.ok || !d.npm;
}

/** The hub script, beside the hub's server in the staged copy (or the repository's, in development). */
export function scriptPath(hubEntry: string): string {
  return path.join(path.dirname(hubEntry), 'npmswitch.mjs');
}

/**
 * Runs the hub script as Node on `exe` (the app's executable, with
 * ELECTRON_RUN_AS_NODE=1) and returns the JSON it prints, with its log
 * lines (on standard error) passed to `onLog` as they come.
 */
export function runScript<T = Record<string, unknown>>(opts: { exe: string; script: string; args: string[]; env?: NodeJS.ProcessEnv; onLog?: (line: string) => void; timeoutMs?: number }): Promise<T & { ok: boolean; error?: string; log?: string[] }> {
  return new Promise((resolve) => {
    const env = { ...(opts.env || process.env), ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(opts.exe, [opts.script, ...opts.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let errAll = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      errAll = (errAll + d).slice(-2000);
      let i: number;
      while ((i = err.indexOf('\n')) >= 0) { const line = err.slice(0, i); err = err.slice(i + 1); if (line.trim()) opts.onLog?.(line); }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 120000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message } as T & { ok: boolean; error: string }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() || '';
      try { resolve(JSON.parse(last)); } catch { resolve({ ok: false, error: `the switch script ended with ${code}${errAll.trim() ? `: ${errAll.trim().slice(-400)}` : ''}` } as T & { ok: boolean; error: string }); }
    });
  });
}
