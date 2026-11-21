// The client against a fake daemon: a WebSocket server written here, so
// the framing (lengths, fragments, ping, close) is checked byte for byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { connectSocket, compareVersions, daemonSockets, runtimeDir, stateDir, RavenryError, FRAME, WS_GUID } from '../index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rvnc-'));

// A server frame (unmasked).
function frame(op, payload, fin = true) {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | op;
  if (n < 126) head[1] = n;
  else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

// Reads client frames, which must be masked.
function reader(onFrame) {
  let buf = Buffer.alloc(0);
  return (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      assert.ok(buf[1] & 0x80, 'a client frame is masked');
      let n = buf[1] & 0x7f, at = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + 4 + n) return;
      const mask = buf.subarray(at, at + 4);
      const p = Buffer.from(buf.subarray(at + 4, at + 4 + n));
      for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + n);
      onFrame(op, p);
    }
  };
}

// A fake daemon: answers hello, then hands every other message to script.
function fakeDaemon(script, { pong = false } = {}) {
  const dir = tmp();
  const sock = path.join(dir, 'ravenryd-9.9.9.sock');
  const seen = [];
  const server = net.createServer((s) => {
    let head = '';
    const onHead = (d) => {
      head += d.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.off('data', onHead);
      const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(head)[1];
      assert.match(head, /^GET \/v1 HTTP\/1\.1\r\n/);
      assert.match(head, /Sec-WebSocket-Protocol: ravenry\.v1\r\n/);
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ravenry.v1\r\n\r\n`);
      const send = (m) => s.write(frame(1, Buffer.from(JSON.stringify(m))));
      s.on('data', reader((op, p) => {
        seen.push({ op, p });
        if (op === 9 && pong) s.write(frame(10, p));
        if (op !== 1) return;
        const m = JSON.parse(p.toString());
        if (m.type === 'hello') send({ v: 1, type: 'result', id: m.id, method: 'hello', result: { protocol: 1, daemon: { version: '9.9.9' }, methods: ['hello', 'pane.list'] } });
        else script(m, { send, raw: (b) => s.write(b), sock: s });
      }));
    };
    s.on('data', onHead);
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, seen, close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } })));
}

test('requests, errors, events and binary frames', async () => {
  const d = await fakeDaemon((m, { send, raw }) => {
    if (m.type === 'pane.list') {
      // An event first, then the result split into two fragments, then a
      // frame of 200 KiB (a 64-bit length), then a ping.
      send({ v: 1, type: 'event', event: 'pane.created', pane: { id: 'p1' } });
      const body = Buffer.from(JSON.stringify({ v: 1, type: 'result', id: m.id, method: 'pane.list', result: { panes: [{ id: 'p1' }] } }));
      raw(Buffer.concat([frame(1, body.subarray(0, 10), false), frame(0, body.subarray(10))]));
      const bin = Buffer.alloc(14 + 200 * 1024, 0x61);
      bin[0] = 1; bin[1] = FRAME.output; bin.writeUInt32BE(7, 2); bin.writeBigUInt64BE(42n, 6);
      raw(frame(2, bin));
      raw(frame(9, Buffer.from('hey')));
    } else if (m.type === 'pane.capture') {
      send({ v: 1, type: 'error', id: m.id, error: { code: 'not_found', message: 'no such pane' } });
    }
  });
  const c = await connectSocket(d.sock, { name: 'test', version: '1' });
  assert.equal(c.hello.daemon.version, '9.9.9');
  assert.ok(c.has('pane.list'));
  assert.ok(!c.has('agent.report'));
  const events = [];
  const frames = [];
  c.on('event', (e) => events.push(e));
  c.on('frame', (f) => frames.push(f));
  const r = await c.request('pane.list', { hidden: true });
  assert.deepEqual(r, { panes: [{ id: 'p1' }] });
  assert.equal(events[0].event, 'pane.created');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].channel, 7);
  assert.equal(frames[0].mark, 42);
  assert.equal(frames[0].data.length, 200 * 1024);
  // The ping was answered with a pong carrying its payload.
  assert.ok(d.seen.some((f) => f.op === 10 && f.p.toString() === 'hey'));
  // The hello carried the client's name, and the list its field.
  const sent = d.seen.filter((f) => f.op === 1).map((f) => JSON.parse(f.p));
  assert.deepEqual(sent[0].client, { name: 'test', version: '1' });
  assert.equal(sent[1].hidden, true);
  assert.equal(sent[1].v, 1);

  await assert.rejects(c.request('pane.capture', { pane: 'px' }), (e) => e instanceof RavenryError && e.code === 'not_found');
  // Input frames and acks.
  c.input(3, 'ls\r');
  c.ack(3, 100);
  await new Promise((res) => setTimeout(res, 50));
  const bin = d.seen.find((f) => f.op === 2);
  assert.equal(bin.p[1], FRAME.input);
  assert.equal(bin.p.readUInt32BE(2), 3);
  assert.equal(bin.p.subarray(14).toString(), 'ls\r');
  assert.ok(d.seen.some((f) => f.op === 1 && JSON.parse(f.p).type === 'ack'));
  c.close();
  d.close();
});

test('a request not answered in time is cancelled; a closed connection fails what waits', async () => {
  let held = null;
  const d = await fakeDaemon((m, { sock }) => {
    if (m.type === 'pane.wait') held = sock;
  });
  const c = await connectSocket(d.sock, { name: 'test' });
  await assert.rejects(c.request('pane.wait', { pane: 'p1', quiet_ms: 1 }, { timeoutMs: 50 }), (e) => e.code === 'timeout');
  await new Promise((res) => setTimeout(res, 30));
  const cancel = d.seen.filter((f) => f.op === 1).map((f) => JSON.parse(f.p)).find((m) => m.type === 'cancel');
  assert.ok(cancel && cancel.request > 0);
  const closed = new Promise((res) => c.on('close', res));
  const pending = c.request('pane.wait', { pane: 'p1', quiet_ms: 1 });
  await new Promise((res) => setTimeout(res, 30));
  held.destroy();
  await assert.rejects(pending, (e) => e.code === 'disconnected');
  await closed;
  await assert.rejects(c.request('pane.list'), (e) => e.code === 'disconnected');
  d.close();
});

test('no daemon there', async () => {
  await assert.rejects(connectSocket(path.join(tmp(), 'nobody.sock')), (e) => e.code === 'disconnected');
});

test('finding daemons', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0-dev', '1.0.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(runtimeDir({ RAVENRY_RUNTIME_DIR: '/r' }), '/r');
  assert.equal(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1' }, 'linux', '/h'), '/run/user/1/ravenry');
  assert.equal(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1' }, 'darwin', '/h'), '/h/Library/Application Support/Ravenry/run');
  assert.equal(stateDir({}, 'linux', '/h'), '/h/.local/state/ravenry');
  const dir = tmp();
  for (const v of ['0.1.0', '0.10.0', '0.2.0-dev']) fs.writeFileSync(path.join(dir, `ravenryd-${v}.sock`), '');
  fs.writeFileSync(path.join(dir, 'other.sock'), '');
  assert.deepEqual(daemonSockets(dir).map((s) => s.version), ['0.10.0', '0.2.0-dev', '0.1.0']);
  assert.deepEqual(daemonSockets(path.join(dir, 'missing')), []);
});

test('ping: the pong comes back, or a connection that stopped answering is told', async () => {
  const d = await fakeDaemon(() => {}, { pong: true });
  const c = await connectSocket(d.sock, { name: 'test' });
  const ms = await c.ping(1000);
  assert.ok(ms >= 0 && ms < 1000);
  c.close();
  d.close();
  // A daemon that never answers a ping (a half-open connection).
  const q = await fakeDaemon(() => {});
  const c2 = await connectSocket(q.sock, { name: 'test' });
  await assert.rejects(c2.ping(100), (e) => e instanceof RavenryError && e.code === 'timeout');
  // A ping on a closed connection fails at once.
  c2.close();
  await assert.rejects(c2.ping(100), (e) => e.code === 'disconnected');
  q.close();
});
