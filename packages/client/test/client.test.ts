// The client against a small fake daemon on a unix socket: hello, request
// ids, errors, events, a stream's snapshot then output, acks, input frames,
// stream.end, frames that arrive in the same batch as the subscribe result,
// and the transports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import http from 'node:http';
import {
  RavenryError, decodeFrame, encodeFrame, KIND_INPUT, KIND_OUTPUT, KIND_SNAPSHOT, messagePortTransport,
} from '../src/index.ts';
import { openUnixSocket, connectSocket } from '../src/node.ts';

interface Fake {
  socket: string;
  received: unknown[];
  frames: ReturnType<typeof decodeFrame>[];
  conns: WebSocket[];
  close(): Promise<void>;
}

// A daemon that knows hello, pane.list, pane.subscribe (a snapshot, then
// "out" once the client acked it), pane.unsubscribe, events.subscribe, and
// echoes input frames back as output.
async function fakeDaemon(opts: { sameBatch?: boolean } = {}): Promise<Fake> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-'));
  const socket = path.join(dir, 'ravenryd-9.9.9.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (ps) => (ps.has('ravenry.v1') ? 'ravenry.v1' : false) });
  const fake: Fake = { socket, received: [], frames: [], conns: [], close: async () => {} };
  let channel = 0;
  const marks = new Map<number, number>();
  wss.on('connection', (ws) => {
    fake.conns.push(ws);
    const send = (o: object) => ws.send(JSON.stringify({ v: 1, ...o }));
    const out = (ch: number, kind: number, text: string) => {
      const mark = marks.get(ch) || 0;
      const b = Buffer.from(text);
      ws.send(encodeFrame(kind, ch, mark, b));
      if (kind === KIND_OUTPUT) marks.set(ch, mark + b.length);
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeFrame(new Uint8Array(data as Buffer));
        fake.frames.push(f);
        if (f && f.kind === KIND_INPUT) out(f.channel, KIND_OUTPUT, Buffer.from(f.payload).toString());
        return;
      }
      const m = JSON.parse(String(data));
      fake.received.push(m);
      switch (m.type) {
        case 'hello': return send({ type: 'result', id: m.id, method: 'hello', result: { protocol: 1, daemon: { version: '9.9.9', pid: 1, os: 'test', arch: 'test', started_at: '2026-11-06T00:00:00.000Z' }, methods: ['hello', 'pane.list', 'pane.subscribe'] } });
        case 'pane.list': return send({ type: 'result', id: m.id, method: 'pane.list', result: { panes: [], extra: 'ignored' } });
        case 'events.subscribe':
          send({ type: 'result', id: m.id, method: 'events.subscribe', result: {} });
          return send({ type: 'event', event: 'pane.title', pane: { id: 'p1', title: 'hi' } });
        case 'pane.subscribe': {
          if (m.pane === 'nope') return send({ type: 'error', id: m.id, error: { code: 'not_found', message: 'no such pane' } });
          const ch = ++channel;
          marks.set(ch, 100);
          if (opts.sameBatch) {
            // Result, snapshot and output in one go: the client reads them in one turn.
            send({ type: 'result', id: m.id, method: 'pane.subscribe', result: { pane: m.pane, channel: ch } });
            ws.send(encodeFrame(KIND_SNAPSHOT, ch, 100, Buffer.from('\x1bcSNAP')));
            out(ch, KIND_OUTPUT, 'early');
            return;
          }
          send({ type: 'result', id: m.id, method: 'pane.subscribe', result: { pane: m.pane, channel: ch } });
          ws.send(encodeFrame(KIND_SNAPSHOT, ch, 100, Buffer.from('\x1bcSNAP')));
          return;
        }
        case 'ack':
          if (m.bytes === 6) out(m.channel, KIND_OUTPUT, 'out'); // after the snapshot's ack
          return;
        case 'pane.unsubscribe': return send({ type: 'result', id: m.id, method: 'pane.unsubscribe', result: {} });
        case 'end': return;
        default: return send({ type: 'error', id: m.id, error: { code: 'unknown_method', message: 'unknown' } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  fake.close = async () => {
    for (const c of fake.conns) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return fake;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('hello, requests by id, unknown fields ignored, errors carry the code', async () => {
  const fake = await fakeDaemon();
  try {
    const c = await connectSocket(fake.socket, { name: 'test', version: '1' });
    assert.equal(c.hello.daemon.version, '9.9.9');
    assert.ok(c.supports('pane.list'));
    assert.ok(!c.supports('pane.wait'));
    assert.deepEqual(fake.received[0], { v: 1, type: 'hello', id: 1, client: { name: 'test', version: '1' } });
    const r = await c.request('pane.list', {});
    assert.deepEqual(r.panes, []);
    await assert.rejects(c.request('pane.capture', { pane: 'x' }), (e: unknown) => e instanceof RavenryError && e.code === 'unknown_method' && e.method === 'pane.capture');
    c.close();
    await assert.rejects(c.request('pane.list', {}), (e: unknown) => e instanceof RavenryError && e.code === 'closed');
  } finally { await fake.close(); }
});

test('a stream: snapshot first, output after the ack, input frames, unsubscribe', async () => {
  const fake = await fakeDaemon();
  try {
    const c = await connectSocket(fake.socket, { name: 'test' });
    const got: { text: string; snapshot: boolean; mark: number }[] = [];
    const s = await c.subscribe('p1', {
      data(d, info) {
        got.push({ text: Buffer.from(d).toString(), snapshot: info.snapshot, mark: info.mark });
        info.ack();
        info.ack(); // only the first counts
      },
    });
    await tick();
    assert.deepEqual(got[0], { text: '\x1bcSNAP', snapshot: true, mark: 100 });
    // The ack for the snapshot went out, and the output followed it.
    const acks = fake.received.filter((m) => (m as { type: string }).type === 'ack');
    assert.deepEqual(acks[0], { v: 1, type: 'ack', channel: s.channel, bytes: 6 });
    assert.deepEqual(got[1], { text: 'out', snapshot: false, mark: 100 });
    assert.equal(s.mark, 103);
    s.input('ls\r');
    await tick();
    assert.equal(fake.frames.length, 1);
    assert.equal(fake.frames[0]!.kind, KIND_INPUT);
    assert.equal(fake.frames[0]!.channel, s.channel);
    assert.equal(fake.frames[0]!.mark, 0);
    assert.equal(Buffer.from(fake.frames[0]!.payload).toString(), 'ls\r');
    assert.equal(got[2].text, 'ls\r');
    await s.unsubscribe();
    s.input('ignored');
    await tick();
    assert.equal(fake.frames.length, 1);
    await assert.rejects(c.subscribe('nope', { data() {} }), (e: unknown) => e instanceof RavenryError && e.code === 'not_found');
    c.close();
  } finally { await fake.close(); }
});

test('acks made in one turn go out as one message', async () => {
  const fake = await fakeDaemon();
  try {
    const c = await connectSocket(fake.socket, { name: 'test' });
    const s = await c.subscribe('p1', { data() {} });
    s.ack(1); s.ack(2); s.ack(3);
    await tick();
    const acks = fake.received.filter((m) => (m as { type: string }).type === 'ack');
    assert.deepEqual(acks, [{ v: 1, type: 'ack', channel: s.channel, bytes: 6 }]);
    c.close();
  } finally { await fake.close(); }
});

test('frames in the same batch as the subscribe result reach the sink in order', async () => {
  const fake = await fakeDaemon({ sameBatch: true });
  try {
    const c = await connectSocket(fake.socket, { name: 'test' });
    const got: string[] = [];
    await c.subscribe('p1', { data(d) { got.push(Buffer.from(d).toString()); } });
    await tick();
    assert.deepEqual(got, ['\x1bcSNAP', 'early']);
    c.close();
  } finally { await fake.close(); }
});

test('events, and stream.end ends the stream with its mark', async () => {
  const fake = await fakeDaemon();
  try {
    const c = await connectSocket(fake.socket, { name: 'test' });
    const evs: unknown[] = [];
    c.onEvent((e) => evs.push(e));
    await c.request('events.subscribe', {});
    let ended: number | null = null;
    const s = await c.subscribe('p1', { data() {}, end(m) { ended = m; } });
    for (const ws of fake.conns) ws.send(JSON.stringify({ v: 1, type: 'event', event: 'stream.end', channel: s.channel, mark: 7, more: 1 }));
    await tick();
    assert.equal(ended, 7);
    assert.ok(s.ended);
    assert.deepEqual(evs[0], { event: 'pane.title', pane: { id: 'p1', title: 'hi' } });
    assert.deepEqual(evs[1], { event: 'stream.end', channel: s.channel, mark: 7, more: 1 });
    c.close();
  } finally { await fake.close(); }
});

test('a lost connection rejects what is pending and says why, without ending streams', async () => {
  const fake = await fakeDaemon();
  try {
    const c = await connectSocket(fake.socket, { name: 'test' });
    let ended = false;
    let why = '';
    c.onClose((r) => { why = r; });
    const s = await c.subscribe('p1', { data() {}, end() { ended = true; } });
    for (const ws of fake.conns) ws.close(1001, 'bye');
    await tick(50);
    assert.ok(c.closed);
    assert.equal(why, 'bye');
    assert.ok(s.ended);
    assert.equal(ended, false);
  } finally { await fake.close(); }
});

test('a socket path over the OS limit is refused before connecting', async () => {
  await assert.rejects(openUnixSocket('/x/' + 'a'.repeat(200)), /over the limit/);
});

test('messagePortTransport pipes strings, bytes and the close', async () => {
  const { port1, port2 } = new MessageChannel();
  const t = messagePortTransport(port1 as unknown as Parameters<typeof messagePortTransport>[0]);
  const got: unknown[] = [];
  let closed = '';
  t.onmessage = (d) => got.push(typeof d === 'string' ? d : Array.from(d));
  t.onclose = (r) => { closed = r; };
  const fromClient: unknown[] = [];
  port2.onmessage = (ev) => fromClient.push(ev.data);
  t.send('{"a":1}');
  t.send(new Uint8Array([1, 2]));
  port2.postMessage('text');
  port2.postMessage(new Uint8Array([3]));
  port2.postMessage(new Uint8Array([4]).buffer);
  port2.postMessage({ closed: 'gone' });
  await tick();
  assert.deepEqual(got, ['text', [3], [4]]);
  assert.equal(closed, 'gone');
  assert.deepEqual(fromClient.slice(0, 2), ['{"a":1}', new Uint8Array([1, 2])]);
  port2.close();
});
