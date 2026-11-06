// The client against the real daemon. Runs when RAVENRYD_BIN names a
// ravenryd binary (CI builds one), with a throwaway HOME, runtime and
// state folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connectSocket, daemonSockets, FRAME } from '../index.mjs';

const BIN = process.env.RAVENRYD_BIN;

async function daemon(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvnd-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const env = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', RAVENRY_RUNTIME_DIR: path.join(dir, 'run'), RAVENRY_STATE_DIR: path.join(dir, 'state') };
  const child = spawn(BIN, ['serve'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    const s = daemonSockets(env.RAVENRY_RUNTIME_DIR)[0];
    if (s) { try { return { socket: (await connectSocket(s.socket, { name: 'probe' })).socket, dir }; } catch { /* not yet */ } }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('ravenryd did not start');
}

test('the real daemon: panes, streams, agent reports and decisions', { skip: !BIN && 'set RAVENRYD_BIN to a ravenryd binary' }, async (t) => {
  const { socket, dir } = await daemon(t);
  const c = await connectSocket(socket, { name: 'node-client-test', version: '0' });
  for (const m of ['pane.new', 'agent.report', 'agent.decisions', 'pane.process']) assert.ok(c.has(m), m);
  await c.request('events.subscribe', {});
  const events = [];
  c.on('event', (e) => events.push(e));

  const { pane } = await c.request('pane.new', { command: ['/bin/sh', '-c', 'echo hello; exec cat'], cwd: dir, cols: 40, rows: 5 });
  const w = await c.request('pane.wait', { pane: pane.id, text: 'hello', since: 0, timeout_ms: 5000 });
  assert.equal(w.condition, 'text');

  // A stream: the snapshot first, then the echo of an input frame.
  const frames = [];
  c.on('frame', (f) => frames.push(f));
  const { channel } = await c.request('pane.subscribe', { pane: pane.id });
  for (let i = 0; i < 100 && !frames.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(frames[0].kind, FRAME.snapshot);
  assert.match(frames[0].data.toString(), /hello/);
  c.input(channel, 'typed\r');
  await c.request('pane.wait', { pane: pane.id, text: 'typed', since: frames[0].mark, timeout_ms: 5000 });

  // A decider on another connection answers a hook's report.
  const hub = await connectSocket(socket, { name: 'hub' });
  await hub.request('agent.decisions', {});
  hub.on('event', (e) => {
    if (e.event !== 'agent.decision') return;
    hub.request('agent.decide', { request: e.request, reply: { stdout: `held ${e.report.event}` } });
  });
  const r = await c.request('agent.report', { pane: pane.id, assistant: 'claude', event: 'Stop', state: 'idle', decide: true, timeout_ms: 2000 });
  assert.equal(r.asked, 1);
  assert.equal(r.reply.stdout, 'held Stop');
  const ev = events.find((e) => e.event === 'agent.report');
  assert.equal(ev.report.event, 'Stop');
  assert.equal(ev.pane.agent.state, 'idle');
  const { reports } = await c.request('agent.events', { pane: pane.id });
  assert.equal(reports.length, 1);

  await c.request('pane.close', { pane: pane.id });
  hub.close();
  c.close();
});

test('the real daemon: labels, files and a checkpoint a person answers', { skip: !BIN && 'set RAVENRYD_BIN to a ravenryd binary' }, async (t) => {
  const { socket, dir } = await daemon(t);
  const agent = await connectSocket(socket, { name: 'agent' });
  const app = await connectSocket(socket, { name: 'app' });
  const events = [];
  app.on('event', (e) => events.push(e));
  await app.request('events.subscribe', { activity: true });

  const { pane } = await agent.request('pane.new', { command: ['/bin/cat'], labels: { 'ravenry.kind': 'shell' } });
  const { pane: renamed } = await agent.request('pane.update', { pane: pane.id, name: 'Shell 1', labels: { 'ravenry.kind': null, 'test/x': '1' } });
  assert.equal(renamed.name, 'Shell 1');
  assert.deepEqual(renamed.labels, { 'test/x': '1' });
  assert.equal((await agent.request('pane.list', { labels: { 'test/x': '1' } })).panes.length, 1);

  const f = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  const r = await agent.request('file.read', { path: f, tail: 6 });
  assert.equal(r.text, 'three\n');
  assert.equal((await agent.request('file.stat', { paths: [f] })).files[0].type, 'file');

  const { checkpoint } = await agent.request('checkpoint.new', { kind: 'ask', pane: pane.id, title: 'Ready?', options: ['Yes', 'No'] });
  const waiting = agent.request('checkpoint.wait', { checkpoint: checkpoint.id });
  for (let i = 0; i < 100 && !events.some((e) => e.event === 'checkpoint.opened'); i++) await new Promise((res) => setTimeout(res, 20));
  await app.request('checkpoint.answer', { checkpoint: checkpoint.id, choice: 0, by: 'test' });
  const done = await waiting;
  assert.equal(done.checkpoint.state, 'answered');
  assert.equal(done.checkpoint.answer.option, 'Yes');
  assert.ok(events.some((e) => e.event === 'pane.updated' && e.pane.id === pane.id));

  await agent.request('pane.close', { pane: pane.id });
  agent.close();
  app.close();
});
