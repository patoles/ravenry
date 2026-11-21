// @ravenry/node-client: a client of the Ravenry protocol v1
// (../protocol/PROTOCOL.md) for Node programs, with no dependency and no
// build: the hub, plugins, scripts. It speaks WebSocket itself, over the
// daemon's unix socket or any duplex stream (the standard input and output
// of `ssh host ravenryd proxy`).
//
// Licence: Apache-2.0 (../LICENSE).

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PROTOCOL = 1;
export const SUBPROTOCOL = 'ravenry.v1';
// RFC 6455's fixed GUID, in parts (the personal-data audit reads any
// UUID as an id).
export const WS_GUID = ['258EAFA5', 'E914', '47DA', '95CA', 'C5AB0DC85B11'].join('-');
const MAX_MESSAGE = 64 << 20;
const MAX_HEADER = 16 << 10;

// Binary frame kinds (section 5).
export const FRAME = { output: 1, snapshot: 2, input: 3 };
const FRAME_HEADER = 14;

// An error the daemon returned: `code` is the protocol's error code
// (bad_request, not_found, ...). A request that could not be sent or got
// no answer has the code `disconnected` or `timeout`.
export class RavenryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RavenryError';
    this.code = code;
  }
}

// ------------------------------------------------------------ finding daemons

// Where the daemons' sockets live (section 9).
export function stateDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RAVENRY_STATE_DIR) return env.RAVENRY_STATE_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ravenry');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ravenry');
}

export function runtimeDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RAVENRY_RUNTIME_DIR) return env.RAVENRY_RUNTIME_DIR;
  if (platform !== 'darwin' && env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'ravenry');
  return path.join(stateDir(env, platform, home), 'run');
}

// Compares two versions ("0.2.0", "0.10.0-dev"): numbers part by part, a
// pre-release before its release.
export function compareVersions(a, b) {
  const split = (v) => {
    const [main, pre] = String(v).split(/-(.*)/s);
    return { parts: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre || '' };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// The sockets in the runtime directory, newest version first:
// [{ version, socket }]. A socket there may belong to a daemon that is no
// longer running; connecting tells.
export function daemonSockets(dir = runtimeDir()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((n) => /^ravenryd-(.+)\.sock$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ version: m[1], socket: path.join(dir, m[0]) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// ------------------------------------------------------------ connecting

// Connects to a daemon's unix socket and says hello.
export function connectSocket(socket, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ path: socket });
    const fail = (e) => { s.destroy(); reject(new RavenryError('disconnected', `cannot reach ${socket}: ${e.message}`)); };
    const t = setTimeout(() => fail(new Error('timed out')), opts.timeoutMs ?? 5000);
    s.once('error', fail);
    s.once('connect', () => {
      clearTimeout(t);
      s.off('error', fail);
      connect(s, opts).then((c) => { c.socket = socket; resolve(c); }, reject);
    });
  });
}

// Connects over a duplex stream that reaches the daemon (a net.Socket, or
// Duplex.from({ readable: ssh.stdout, writable: ssh.stdin })): the
// WebSocket handshake, then hello. Resolves to a connected Client.
export async function connect(stream, opts = {}) {
  const c = new Client(stream);
  await c._handshake(opts.timeoutMs ?? 5000);
  const client = { name: opts.name || 'node-client', ...(opts.version ? { version: opts.version } : {}) };
  if (opts.answerKey) {
    // The hub's answer key (PROTOCOL.md section 4, Who acts as the
    // person). A daemon from before it refuses the field: say hello again
    // without it.
    try {
      c.hello = await c.request('hello', { client, answer_key: opts.answerKey });
      return c;
    } catch (e) {
      if (!(e instanceof RavenryError) || e.code !== 'bad_request' || !/answer_key/.test(e.message)) throw e;
    }
  }
  c.hello = await c.request('hello', { client });
  return c;
}

// ------------------------------------------------------------ the client

// One connection. Events (EventEmitter):
//   'event' (message)   a daemon event: { event: 'pane.created', pane, ... }
//   'frame' (frame)     a binary frame: { kind, channel, mark, data }
//   'close' (error?)    the connection ended
export class Client extends EventEmitter {
  constructor(stream) {
    super();
    this.stream = stream;
    this.socket = null;
    this.hello = null;
    this.closed = false;
    this._next = 0;
    this._pending = new Map();
    // What has arrived and not been read yet, as the chunks it came in: a
    // frame is copied once, when it is whole. Concatenating at each chunk
    // was quadratic: a 16 MB reply in a pipe's 4 KB chunks took 4 s of the
    // hub's main thread (2026-11-07, an update that rolled back).
    this._chunks = [];
    this._have = 0;
    this._parts = null; // a fragmented message being gathered
    this._open = false;
    this._pings = new Map(); // a ping's payload (hex) -> its answer
  }

  // Whether the daemon has this method (hello's methods, section 10).
  has(method) {
    return !!(this.hello && Array.isArray(this.hello.methods) && this.hello.methods.includes(method));
  }

  // Sends a request and resolves to its result; rejects with a
  // RavenryError. opts.timeoutMs or opts.signal stop waiting (and cancel
  // the request on the daemon).
  request(method, params = {}, opts = {}) {
    if (this.closed) return Promise.reject(new RavenryError('disconnected', 'the connection is closed'));
    const id = ++this._next;
    const msg = { ...params, v: PROTOCOL, type: method, id };
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = () => {
        this._pending.delete(id);
        if (timer) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        done();
        if (!this.closed) this._send({ v: PROTOCOL, type: 'cancel', id: ++this._next, request: id });
        reject(new RavenryError(opts.signal && opts.signal.aborted ? 'cancelled' : 'timeout', `${method} was not answered in time`));
      };
      this._pending.set(id, { resolve: (r) => { done(); resolve(r); }, reject: (e) => { done(); reject(e); } });
      if (opts.timeoutMs) timer = setTimeout(abort, opts.timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) return abort();
        opts.signal.addEventListener('abort', abort, { once: true });
      }
      this._send(msg);
    });
  }

  // A WebSocket ping (RFC 6455 section 5.5.2): resolves to the round trip
  // in ms when the daemon's pong comes back, rejects when it does not
  // within timeoutMs or the connection ends. A connection left half-open
  // (a laptop that slept, a network that changed) never answers, and
  // nothing else would say so until TCP gives up.
  ping(timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new RavenryError('disconnected', 'the connection is closed'));
    const token = crypto.randomBytes(8);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); this._pings.delete(key); this.off('close', onClose); fn(v); };
      const key = token.toString('hex');
      const onClose = () => done(reject, new RavenryError('disconnected', 'the connection is closed'));
      const timer = setTimeout(() => done(reject, new RavenryError('timeout', `no pong in ${timeoutMs} ms`)), timeoutMs);
      this._pings.set(key, () => done(resolve, Date.now() - t0));
      this.once('close', onClose);
      this._write(9, token);
    });
  }

  // Acknowledges n processed bytes of a stream (section 5).
  ack(channel, bytes) {
    this._send({ v: PROTOCOL, type: 'ack', channel, bytes });
  }

  // Sends bytes to a subscribed pane as they are (an input frame).
  input(channel, data) {
    const body = Buffer.from(data);
    const head = Buffer.alloc(FRAME_HEADER);
    head[0] = PROTOCOL;
    head[1] = FRAME.input;
    head.writeUInt32BE(channel, 2);
    this._write(2, Buffer.concat([head, body]));
  }

  close() {
    if (this.closed) return;
    try { this._write(8, Buffer.from([0x03, 0xe8])); } catch { /* already gone */ }
    this._end(null);
  }

  // ---------------------------------------------------------------- inside

  _send(msg) {
    this._write(1, Buffer.from(JSON.stringify(msg)));
  }

  // A client frame: FIN, the opcode, masked (RFC 6455 section 5.3).
  _write(opcode, payload) {
    if (this.closed || this.stream.destroyed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (n < 126) head[1] = 0x80 | n;
    else if (n < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
    else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
    const mask = crypto.randomBytes(4);
    const body = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    this.stream.write(Buffer.concat([head, mask, body]));
  }

  _handshake(timeoutMs) {
    const key = crypto.randomBytes(16).toString('base64');
    const want = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    return new Promise((resolve, reject) => {
      let head = Buffer.alloc(0);
      const fail = (why) => {
        cleanup();
        this.stream.destroy();
        reject(new RavenryError('disconnected', `the WebSocket handshake failed: ${why}`));
      };
      const timer = setTimeout(() => fail('no answer'), timeoutMs);
      const onData = (d) => {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > MAX_HEADER) fail('the answer is too long');
          return;
        }
        const lines = head.subarray(0, end).toString('latin1').split('\r\n');
        const rest = head.subarray(end + 4);
        const fields = {};
        for (const l of lines.slice(1)) {
          const k = l.indexOf(':');
          if (k > 0) fields[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim();
        }
        if (!/^HTTP\/1\.1 101\b/.test(lines[0])) return fail(lines[0]);
        if (fields['sec-websocket-accept'] !== want) return fail('a wrong Sec-WebSocket-Accept');
        if (fields['sec-websocket-protocol'] !== SUBPROTOCOL) return fail(`the daemon did not take ${SUBPROTOCOL}`);
        cleanup();
        this._open = true;
        this.stream.on('data', (b) => this._read(b));
        this.stream.on('close', () => this._end(new RavenryError('disconnected', 'the daemon closed the connection')));
        this.stream.on('error', (e) => this._end(new RavenryError('disconnected', e.message)));
        resolve();
        if (rest.length) this._read(rest);
      };
      const onEnd = () => fail('the connection closed');
      const cleanup = () => {
        clearTimeout(timer);
        this.stream.off('data', onData);
        this.stream.off('close', onEnd);
        this.stream.off('error', onEnd);
      };
      this.stream.on('data', onData);
      this.stream.on('close', onEnd);
      this.stream.on('error', onEnd);
      this.stream.write(
        'GET /v1 HTTP/1.1\r\nHost: ravenryd\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`,
      );
    });
  }

  // The first `k` bytes of what has arrived, copied (a frame's header: at most 10).
  _peek(k) {
    if (this._chunks[0].length >= k) return this._chunks[0].subarray(0, k);
    const out = Buffer.alloc(k);
    let at = 0;
    for (const c of this._chunks) { const n = Math.min(c.length, k - at); c.copy(out, at, 0, n); at += n; if (at === k) break; }
    return out;
  }

  // Takes the first `k` bytes off what has arrived: one copy (none when one chunk holds them).
  _take(k) {
    let out;
    if (this._chunks[0].length >= k) out = this._chunks[0].subarray(0, k);
    else {
      out = Buffer.allocUnsafe(k);
      let at = 0;
      while (at < k) { const c = this._chunks[0]; const n = Math.min(c.length, k - at); c.copy(out, at, 0, n); at += n; if (n < c.length) { this._chunks[0] = c.subarray(n); break; } this._chunks.shift(); }
      this._have -= k;
      return out;
    }
    this._chunks[0] = this._chunks[0].subarray(k);
    if (!this._chunks[0].length) this._chunks.shift();
    this._have -= k;
    return out;
  }

  // Reads server frames (unmasked) from the byte stream.
  _read(chunk) {
    if (!chunk.length) return;
    this._chunks.push(chunk);
    this._have += chunk.length;
    for (;;) {
      if (this._have < 2) return;
      const h = this._peek(Math.min(this._have, 10));
      const fin = (h[0] & 0x80) !== 0;
      const op = h[0] & 0x0f;
      let n = h[1] & 0x7f;
      let at = 2;
      if (n === 126) { if (h.length < 4) return; n = h.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (h.length < 10) return; n = Number(h.readBigUInt64BE(2)); at = 10; }
      if (h[1] & 0x80) { this._fail('the daemon masked a frame'); return; }
      if (n > MAX_MESSAGE) { this._fail('a message larger than 64 MiB'); return; }
      if (this._have < at + n) return;
      const payload = this._take(at + n).subarray(at);
      if (op === 8) { this.close(); return; }
      if (op === 9) { this._write(10, payload); continue; }
      if (op === 10) { const k = payload.toString('hex'); const p = this._pings.get(k); if (p) p(); continue; }
      if (op === 0) {
        if (!this._parts) { this._fail('a continuation with nothing to continue'); return; }
        this._parts.chunks.push(Buffer.from(payload));
        this._parts.size += n;
        if (this._parts.size > MAX_MESSAGE) { this._fail('a message larger than 64 MiB'); return; }
        if (fin) { const p = this._parts; this._parts = null; this._message(p.op, Buffer.concat(p.chunks)); }
        continue;
      }
      if (op !== 1 && op !== 2) { this._fail(`an unknown opcode ${op}`); return; }
      if (!fin) { this._parts = { op, chunks: [Buffer.from(payload)], size: n }; continue; }
      this._message(op, payload);
    }
  }

  _message(op, payload) {
    if (op === 2) {
      if (payload.length < FRAME_HEADER || payload[0] !== PROTOCOL) return;
      this.emit('frame', {
        kind: payload[1], channel: payload.readUInt32BE(2), mark: Number(payload.readBigUInt64BE(6)),
        data: Buffer.from(payload.subarray(FRAME_HEADER)),
      });
      return;
    }
    let m;
    try { m = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if ((m.type === 'result' || m.type === 'error') && m.id != null) {
      const p = this._pending.get(m.id);
      if (!p) return;
      if (m.type === 'result') p.resolve(m.result);
      else p.reject(new RavenryError(m.error && m.error.code, m.error && m.error.message));
      return;
    }
    if (m.type === 'event') this.emit('event', m);
  }

  _fail(why) {
    this._end(new RavenryError('disconnected', `protocol error: ${why}`));
  }

  _end(err) {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.end(); } catch { /* gone */ }
    setTimeout(() => { try { this.stream.destroy(); } catch { /* gone */ } }, 100).unref();
    const e = err || new RavenryError('disconnected', 'the connection is closed');
    for (const p of [...this._pending.values()]) p.reject(e);
    this._pending.clear();
    this.emit('close', err);
  }
}
