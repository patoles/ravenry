// The terminal on the phone (docs/PHONE.md section 6): GET /api/term?pane=<id>,
// a WebSocket upgrade with the subprotocol ravenry.v1. The hub finds the
// daemon that holds the pane (this machine's, or a machine's through
// `ssh host ravenryd proxy`) and joins the two byte streams, so the phone
// speaks protocol v1 (packages/protocol/PROTOCOL.md) to the daemon itself,
// handshake included.
//
// The daemon takes the hub as the person, so the hub reads every text frame
// the phone sends and lets through only what draws and types into a pane;
// anything else (an answer, a hook decision, a new pane) closes the
// connection with 1008. Answers go through the HTTP API, where the person
// check is. Binary frames (input) and control frames pass as they are.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

import * as machines from './machines.mjs';
import { localSockets, machineOfTab } from './ravenryd.mjs';

export const ALLOWED = new Set(['hello', 'cancel', 'pane.list', 'pane.capture', 'pane.read', 'pane.subscribe', 'pane.unsubscribe', 'pane.resize', 'pane.send', 'ack']);
const PANE_RE = /^p[a-z2-7]{7}$/;
const KEY_RE = /^[A-Za-z0-9+/]{22}==$/;

// ------------------------------------------------------------ frames

// Reads client frames (masked) off a byte stream. `onFrame(frame)` gets
// { fin, op, payload (unmasked), raw (as it came) }; returns false to stop.
export function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  let stopped = false;
  return (chunk) => {
    if (stopped) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80);
      const op = buf[0] & 0x0f;
      const masked = !!(buf[1] & 0x80);
      let n = buf[1] & 0x7f;
      let at = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; } else if (n === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(64 << 20)) { stopped = true; onFrame({ bad: 'too big' }); return; }
        n = Number(big); at = 10;
      }
      const mlen = masked ? 4 : 0;
      if (buf.length < at + mlen + n) return;
      const raw = buf.subarray(0, at + mlen + n);
      let payload = buf.subarray(at + mlen, at + mlen + n);
      if (masked) {
        const m = buf.subarray(at, at + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      buf = buf.subarray(at + mlen + n);
      if (onFrame({ fin, op, masked, payload, raw: Buffer.from(raw) }) === false) { stopped = true; return; }
    }
  };
}

// A close frame from the server side (unmasked).
export function closeFrame(code, reason = '') {
  const r = Buffer.from(String(reason).slice(0, 100));
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return Buffer.concat([Buffer.from([0x88, p.length]), p]);
}

// Whether a text frame from the phone may reach the daemon: { ok, why }.
export function allowedText(text) {
  let m;
  try { m = JSON.parse(text); } catch { return { ok: false, why: 'not JSON' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, why: 'not a message' };
  const t = String(m.type || '');
  return ALLOWED.has(t) ? { ok: true } : { ok: false, why: `${t || 'a message without a type'} is not allowed from the phone` };
}

// ------------------------------------------------------------ where the pane is

// { socket } for a pane of a daemon on this machine, { machine } for a
// remote one's, or null.
export async function paneHome(pane, { connectSocket } = {}) {
  const machine = machineOfTab(`ravenry:${pane}`);
  if (machine) return { machine };
  const socks = await localSockets();
  if (!connectSocket) {
    const lib = await import('@ravenry/node-client').catch(() => import(new URL('../../packages/node-client/index.mjs', import.meta.url).href));
    connectSocket = lib.connectSocket;
  }
  for (const s of socks) {
    let c = null;
    try {
      c = await connectSocket(s.socket, { name: 'ravenry-hub-term', timeoutMs: 2000 });
      const { panes } = await c.request('pane.list', { hidden: true }, { timeoutMs: 3000 });
      if (panes.some((x) => x.id === pane)) return { socket: s.socket };
    } catch { /* a socket left by a daemon that is gone */ } finally { if (c) c.close(); }
  }
  return null;
}

function openStream(home) {
  if (home.socket) return net.connect(home.socket);
  const m = machines.configured().find((x) => x.name === home.machine);
  if (!m) return null;
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', m.host, '--', m.command, 'proxy'];
  const child = spawn(machines.sshBin(), args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const d = Duplex.from({ readable: child.stdout, writable: child.stdin });
  d.on('close', () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
  child.on('exit', () => d.destroy());
  child.on('error', () => d.destroy());
  return d;
}

// ------------------------------------------------------------ the upgrade

function refuse(sock, status, text) {
  try { sock.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`); } catch { /* gone */ }
}

// Joins the phone's upgrade to the pane's daemon. The person check is the
// caller's (server/index.mjs), done before this.
export async function handle(req, sock, head, url) {
  sock.on('error', () => {});
  const pane = url.searchParams.get('pane') || '';
  const key = String(req.headers['sec-websocket-key'] || '');
  const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim());
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !KEY_RE.test(key)) return refuse(sock, '400 Bad Request', 'Send a WebSocket upgrade.');
  if (!protos.includes('ravenry.v1')) return refuse(sock, '400 Bad Request', 'Offer the subprotocol ravenry.v1.');
  if (!PANE_RE.test(pane)) return refuse(sock, '400 Bad Request', 'Name a Ravenry pane: ?pane=p and seven characters.');
  const home = await paneHome(pane).catch(() => null);
  if (!home) return refuse(sock, '404 Not Found', 'That pane is closed, or no daemon this hub reaches has it.');
  const up = openStream(home);
  if (!up) return refuse(sock, '404 Not Found', 'That machine is not set up on this hub.');
  up.on('error', () => { try { sock.destroy(); } catch { /* gone */ } });
  up.write(`GET /v1 HTTP/1.1\r\nHost: ravenryd\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: ravenry.v1\r\n\r\n`);
  let closed = false;
  const kill = (code, why) => {
    if (closed) return;
    closed = true;
    try { sock.end(closeFrame(code, why)); } catch { /* gone */ }
    try { up.destroy(); } catch { /* gone */ }
  };
  const read = frameReader((f) => {
    if (f.bad) { kill(1009, f.bad); return false; }
    if (!f.masked) { kill(1002, 'client frames are masked'); return false; }
    if (f.op === 0x1) {
      if (!f.fin) { kill(1008, 'fragmented text frames are not taken'); return false; }
      const a = allowedText(f.payload.toString('utf8'));
      if (!a.ok) { console.log(`term: closed a phone's stream to ${pane}: ${a.why}`); kill(1008, a.why); return false; }
    }
    up.write(f.raw);
    return true;
  });
  if (head && head.length) read(head);
  sock.on('data', read);
  up.on('data', (d) => { if (!closed) sock.write(d); });
  up.on('end', () => { closed = true; try { sock.end(); } catch { /* gone */ } });
  up.on('close', () => { closed = true; try { sock.destroy(); } catch { /* gone */ } });
  sock.on('close', () => { closed = true; try { up.destroy(); } catch { /* gone */ } });
}
