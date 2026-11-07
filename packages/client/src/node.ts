// Node only: finding the daemon on this machine (PROTOCOL.md section 9),
// starting one, and a WebSocket transport over its unix socket.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { PATH, SUBPROTOCOL } from './protocol.ts';
import type { Transport } from './transport.ts';
import { RavenryClient } from './client.ts';
import type { ConnectOptions } from './client.ts';

type Env = Record<string, string | undefined>;

/** The longest unix socket path the OS takes (sun_path, less its terminating NUL). */
export const MAX_SOCKET_PATH = process.platform === 'darwin' ? 103 : 107;

/** Where the daemon keeps its logs: RAVENRY_STATE_DIR, else the platform's state folder. */
export function stateDir(env: Env = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  if (env.RAVENRY_STATE_DIR) return env.RAVENRY_STATE_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ravenry');
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'ravenry');
  return path.join(home, '.local', 'state', 'ravenry');
}

/** Where the daemons' sockets live: RAVENRY_RUNTIME_DIR, else XDG_RUNTIME_DIR/ravenry on Linux, else <state>/run. */
export function runtimeDir(env: Env = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  if (env.RAVENRY_RUNTIME_DIR) return env.RAVENRY_RUNTIME_DIR;
  if (platform !== 'darwin' && env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'ravenry');
  return path.join(stateDir(env, platform, home), 'run');
}

/** Compares two daemon versions (semver, with prereleases before their release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.replace(/^v/, '').split('+')[0].split(/-(.*)/s, 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split('.'), ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]), yn = /^\d+$/.test(ys[i]);
    if (xn && yn) { const d = Number(xs[i]) - Number(ys[i]); if (d) return Math.sign(d); continue; }
    if (xn !== yn) return xn ? -1 : 1;
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/** The ravenryd-<version>.sock files in a runtime folder, newest version first. */
export function listSockets(dir: string): { version: string; socket: string }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((n) => /^ravenryd-(.+)\.sock$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ version: m[1], socket: path.join(dir, m[0]) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** A WebSocket transport over a daemon's unix socket. */
export function openUnixSocket(socket: string, opts: { timeoutMs?: number } = {}): Promise<Transport> {
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
    return Promise.reject(new Error(`socket path ${socket} is ${Buffer.byteLength(socket)} bytes, over the limit of ${MAX_SOCKET_PATH}`));
  }
  return new Promise((resolve, reject) => {
    // The socket is connected as it is named, never through a URL: a
    // ws+unix URL percent-encodes its path, and on a Mac the daemons'
    // folder is ~/Library/Application Support/Ravenry/run, so every
    // connection went to ".../Application%20Support/..." and the app found
    // no daemon (2026-11-07).
    const ws = new WebSocket(`ws://localhost${PATH}`, SUBPROTOCOL, {
      createConnection: () => net.connect({ path: socket }),
      perMessageDeflate: false,
      handshakeTimeout: opts.timeoutMs ?? 3000,
      maxPayload: 32 * 1024 * 1024,
    });
    let open = false;
    const t: Transport = {
      send: (d) => ws.send(d, { binary: typeof d !== 'string' }),
      close: () => ws.close(1000),
      onmessage: null,
      onclose: null,
    };
    ws.on('open', () => {
      if (ws.protocol !== SUBPROTOCOL) { ws.terminate(); reject(new Error(`${socket} did not accept ${SUBPROTOCOL}`)); return; }
      open = true;
      resolve(t);
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) t.onmessage?.(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      else t.onmessage?.(buf.toString('utf8'));
    });
    ws.on('error', (e: Error) => { if (!open) reject(e); });
    ws.on('close', (code: number, reason: Buffer) => {
      if (!open) { reject(new Error(`${socket} closed during the handshake (${code})`)); return; }
      t.onclose?.(reason.toString() || `closed (${code})`);
    });
  });
}

export interface FoundDaemon {
  socket: string;
  client: RavenryClient;
}

export interface FindOptions extends ConnectOptions {
  /** A socket to use rather than looking (a pinned socket, section 9 step 1). */
  socket?: string;
  env?: Env;
  /** The ravenryd binary to start when none runs. Without it, none is started. */
  start?: string;
  /** How long to wait for a started daemon's socket. Default 5000 ms. */
  startTimeoutMs?: number;
  /** Extra environment for a daemon this starts (the panes inherit it). */
  startEnv?: Env;
}

/**
 * Connects to the daemon new panes belong to: the pinned socket when given
 * (or RAVENRY_SOCKET), else the newest running daemon that is not draining,
 * else one started with `ravenryd serve --detach`.
 */
export async function findDaemon(opts: FindOptions): Promise<FoundDaemon> {
  const env = opts.env || process.env;
  const pinned = opts.socket || env.RAVENRY_SOCKET;
  if (pinned) return { socket: pinned, client: await connectSocket(pinned, opts) };
  const dir = runtimeDir(env);
  let lastError = '';
  const tryAll = async (): Promise<FoundDaemon | null> => {
    let draining: FoundDaemon | null = null;
    for (const s of listSockets(dir)) {
      let client: RavenryClient;
      // A stale socket file; its error is said if no daemon answers at all.
      try { client = await connectSocket(s.socket, opts); } catch (e) { lastError = `${s.socket}: ${(e as Error).message || e}`; continue; }
      if (client.hello.daemon.draining) { if (!draining) draining = { socket: s.socket, client }; else client.close(); continue; }
      draining?.client.close();
      return { socket: s.socket, client };
    }
    return draining;
  };
  const found = await tryAll();
  if (found) return found;
  if (!opts.start) throw new Error(`no ravenryd is running in ${dir}${lastError ? ` (${lastError})` : ''}`);
  await startDaemon(opts.start, { ...env, ...(opts.startEnv || {}) });
  const until = Date.now() + (opts.startTimeoutMs ?? 5000);
  while (Date.now() < until) {
    const f = await tryAll();
    if (f) return f;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`started ${opts.start} but no daemon answered in ${dir}${lastError ? ` (${lastError})` : ''}`);
}

export async function connectSocket(socket: string, opts: ConnectOptions): Promise<RavenryClient> {
  const t = await openUnixSocket(socket);
  return RavenryClient.connect(t, opts);
}

/** Runs `ravenryd serve --detach` and waits for it to return. */
export function startDaemon(bin: string, env: Env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['serve', '--detach'], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} serve --detach exited with ${code}: ${err.trim()}`));
    });
  });
}
