// The Dock icon's badge (src/main/badge.ts, ALERT-018): the number is the
// hub's own Needs you count (hub/server/sidebar.mjs build), cleared at 0 and
// when the hub is out of reach. The last test runs the app's hub stream
// (hub.ts HubFeed) against a stand-in board on 127.0.0.1, wired as main.ts
// wires it, and reads what reached Electron's setBadgeCount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DockBadge, needsYou } from '../src/main/badge.ts';
import { HubFeed } from '../src/main/hub.ts';
// @ts-ignore: the hub's module, plain JavaScript
import { build } from '../../../hub/server/sidebar.mjs';

const sess = (surfaceId: string, state: string) => ({ surfaceId, state, topic: surfaceId, assistant: 'claude' });
const proj = (id: string, state: string, sessions: object[]) => ({ id, name: id, state, sessions, primary: (sessions[0] as { surfaceId: string } | undefined)?.surfaceId ?? null });
/** A state as the hub sends it: its sidebar built by the hub's own code. */
const stateOf = (projects: object[]) => ({ generatedAt: new Date().toISOString(), projects, sidebar: build(projects, {}) });

const TWO = stateOf([proj('a', 'you', [sess('s1', 'asked'), sess('s2', 'handback')]), proj('b', 'work', [sess('s3', 'working')])]);
const NONE = stateOf([proj('b', 'work', [sess('s3', 'working')]), proj('c', 'idle', [sess('s4', 'idle')])]);
const THREE = stateOf([proj('a', 'you', [sess('s1', 'asked'), sess('s2', 'handback')]), proj('d', 'you', [sess('s5', 'dialog')])]);

function fakeApp() {
  const calls: number[] = [];
  return { calls, setBadgeCount(n: number) { calls.push(n); return true; } };
}

test('the number is the hub sidebar count of Needs you', () => {
  assert.equal(needsYou(TWO), 2);
  assert.equal(needsYou(TWO), (TWO.sidebar.sections.find((s: { group: string }) => s.group === 'you') as { count: number }).count);
  assert.equal(needsYou(NONE), 0);
  assert.equal(needsYou(THREE), 3);
  assert.equal(needsYou({ projects: [] }), null);
  assert.equal(needsYou(null), null);
});

test('shown, changed, cleared at 0, cleared when the hub is out of reach', () => {
  const app = fakeApp();
  const b = new DockBadge(app, 'darwin');
  b.state(TWO);
  b.state(TWO);
  assert.deepEqual(app.calls, [2], 'the same number is not set again');
  b.state(THREE);
  b.state(NONE);
  assert.deepEqual(app.calls, [2, 3, 0]);
  b.state(TWO);
  b.status({ reachable: false });
  assert.deepEqual(app.calls, [2, 3, 0, 2, 0]);
  assert.equal(b.shown, 0);
  b.status({ reachable: true });
  assert.deepEqual(app.calls, [2, 3, 0, 2, 0], 'back in reach, the next state sets it');
  b.state({ projects: [] });
  assert.deepEqual(app.calls, [2, 3, 0, 2, 0], 'a state with no sidebar shows none');
});

test('macOS and Linux only', () => {
  const linux = fakeApp();
  new DockBadge(linux, 'linux').state(TWO);
  assert.deepEqual(linux.calls, [2]);
  const win = fakeApp();
  new DockBadge(win, 'win32').state(TWO);
  assert.deepEqual(win.calls, []);
});

test('from the app hub stream: the count, 0 clears, the board gone clears', async () => {
  const states = [TWO, NONE, THREE];
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/events')) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const next = () => {
      if (i < states.length) { res.write(`event: state\ndata: ${JSON.stringify(states[i++])}\n\n`); setTimeout(next, 80); } else { res.end(); server.close(); }
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = fakeApp();
  const badge = new DockBadge(app, 'darwin');
  const feed = new HubFeed(url, (s) => badge.state(s), (st) => badge.status(st));
  feed.start();
  const until = Date.now() + 5000;
  while (app.calls.length < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  feed.stop();
  server.closeAllConnections();
  assert.deepEqual(app.calls, [2, 0, 3, 0], 'two, none, three, then the board closed');
});
