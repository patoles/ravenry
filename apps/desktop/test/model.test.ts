// The sidebar's board from the hub's state, the checkpoints that open the
// panel, and the hub and machine helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ago, arrivals, board, clock, isEmpty, machineOf, memoryLine, paneOf, secondLine, sessionGroup, sessionOfPane, tokens } from '../src/renderer/model.ts';
import type { HubProject, HubSession, HubState } from '../src/renderer/model.ts';
import { hubUrl, parseEvent } from '../src/main/hub.ts';
import { daemonEnv } from '../src/main/spawn.ts';
import { findAssistants, findProjectFolders, shortPath } from '../src/main/local.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60000).toISOString();
const sess = (surfaceId: string, state: string, extra: Partial<HubSession> = {}): HubSession => ({ surfaceId, state, topic: surfaceId, assistant: 'claude', ...extra });
const proj = (id: string, state: HubProject['state'], sessions: HubSession[], extra: Partial<HubProject> = {}): HubProject => ({ id, name: id, state, sessions, primary: sessions[0]?.surfaceId ?? null, ...extra });

const STATE: HubState = {
  settings: { handoffThreshold: 50 },
  projects: [
    proj('old-ask', 'you', [sess('s1', 'asked', { since: at(30), words: { line: 'Keep  the\nold format?' }, ctx: { tokens: 100000, window: 1000000, pct: 10 } })], { since: at(30) }),
    proj('new-ask', 'you', [sess('s2', 'dialog', { words: { question: 'Allow it?' } }), sess('s2b', 'working')], { since: at(2) }),
    proj('busy', 'work', [sess('s3', 'working', { ctx: { tokens: 584000, window: 1000000, pct: 58.4 } }), sess('s3b', 'working'), sess('s3c', 'idle')]),
    proj('gate', 'you', [sess('s4', 'idle')], { since: at(5), primary: 's4' }),
    proj('quiet', 'idle', [sess('s5', 'stale')], { since: at(60 * 72), machine: 'devbox' }),
    proj('waiting', 'wait', [sess('s6', 'idle')], { since: at(10), waitingOn: 'design' }),
  ],
};

test('groups come in order, newest first, with counts', () => {
  const b = board(STATE, NOW);
  assert.deepEqual(b.map((g) => g.title), ['Needs you', 'Working', 'Waiting on others', 'Idle']);
  assert.deepEqual(b[0].projects.map((p) => p.project.id), ['new-ask', 'gate', 'old-ask']);
  assert.equal(b[0].count, 3);
  assert.equal(b[3].count, 1);
});

test('rows: only the sessions of the group, else the primary; lines, context and the warning', () => {
  const b = board(STATE, NOW);
  const you = b[0].projects;
  assert.deepEqual(you[0].rows.map((r) => r.key), ['new-ask/s2']); // its working session is not repeated
  assert.equal(you[0].rows[0].line, 'Allow it?');
  assert.deepEqual(you[1].rows.map((r) => r.key), ['gate/s4']); // a plan gate: the primary session
  assert.equal(you[2].rows[0].line, 'Keep the old format?');
  const work = b[1].projects[0];
  assert.deepEqual(work.rows.map((r) => r.key), ['busy/s3', 'busy/s3b']);
  assert.equal(work.rows[0].pct, 58);
  assert.ok(work.rows[0].pctWarn);
  assert.equal(work.time, 'now');
  assert.equal(b[3].projects[0].rows.length, 0); // idle projects are one line
  assert.equal(b[3].projects[0].time, '3 d');
  assert.equal(b[3].projects[0].machine, 'devbox');
});

test('a session that moves into Needs you is an arrival; the first state is not', () => {
  const before: HubState = { projects: [proj('a', 'work', [sess('x', 'working')])] };
  const after: HubState = { projects: [proj('a', 'you', [sess('x', 'asked')])] };
  assert.deepEqual(arrivals(null, after), []);
  assert.deepEqual(arrivals(before, after), ['a/x']);
  assert.deepEqual(arrivals(after, after), []);
});

test('helpers: groups, times, tokens, memory, empty, seams', () => {
  assert.equal(sessionGroup(sess('a', 'handback')), 'you');
  assert.equal(sessionGroup(sess('a', 'working')), 'work');
  assert.equal(sessionGroup(sess('a', 'handed')), 'idle');
  assert.equal(ago(at(0.5), NOW), 'now');
  assert.equal(ago(at(5), NOW), '5 min');
  assert.equal(ago(at(125), NOW), '2 h');
  assert.match(clock(at(5), NOW), /^\d\d:\d\d$/);
  assert.equal(clock(at(60 * 50), NOW), '2 d');
  assert.equal(tokens(82000), '82k');
  assert.equal(tokens(1000000), '1M');
  assert.equal(tokens(1200000), '1.2M');
  assert.equal(memoryLine({ sessions: { totalKb: 3250586 } }), '3.1 GB');
  assert.equal(memoryLine({}), null);
  assert.ok(isEmpty({ projects: [proj('a', 'idle', [])] }));
  assert.ok(!isEmpty(STATE));
  assert.equal(paneOf(sess('a', 'working')), null);
  assert.equal(paneOf(sess('a', 'working', { pane: 'pabc1234' })), 'pabc1234');
  assert.equal(paneOf(sess('a', 'working', { pane: { id: 'pabc1234' } })), 'pabc1234');
  // The hub names a ravenryd session's tab "ravenry:<pane id>".
  assert.equal(paneOf(sess('ravenry:pk3m7q2x', 'working', { term: 'ravenry' })), 'pk3m7q2x');
  assert.equal(paneOf(sess('ravenry:nope', 'working')), null);
  const st: HubState = { projects: [proj('r', 'work', [sess('ravenry:pk3m7q2x', 'working')])] };
  assert.equal(sessionOfPane(st, 'pk3m7q2x')?.key, 'r/ravenry:pk3m7q2x');
  assert.equal(sessionOfPane(st, 'pzzzzzzz'), null);
  assert.equal(machineOf(proj('a', 'idle', [], { machine: 'local' })), null);
  assert.equal(machineOf(proj('a', 'idle', []), sess('a', 'idle', { machine: 'gpu-box' })), 'gpu-box');
});

test('the hub: server-sent events and where the board runs', () => {
  assert.deepEqual(parseEvent('event: state\ndata: {"a":\ndata: 1}'), { event: 'state', data: '{"a":\n1}' });
  assert.equal(parseEvent(': hb'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvd-'));
  try {
    assert.equal(hubUrl({ RAVENRY_HUB_URL: 'http://127.0.0.1:9/' }, dir), 'http://127.0.0.1:9');
    assert.equal(hubUrl({ RAVENRY_HOME: dir }, dir), 'http://127.0.0.1:4600');
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ port: 4700 }));
    assert.equal(hubUrl({ RAVENRY_HOME: dir }, dir), 'http://127.0.0.1:4700');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a daemon the app starts does not inherit Electron variables', () => {
  const env = daemonEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('first launch: project folders and assistants from HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvh-'));
  try {
    assert.deepEqual(findProjectFolders(home).folders, []);
    for (const [n, marker] of [['app', '.git'], ['site', 'package.json'], ['notes', null]] as const) {
      const d = path.join(home, 'code', n);
      fs.mkdirSync(d, { recursive: true });
      if (marker === '.git') fs.mkdirSync(path.join(d, marker));
      else if (marker) fs.writeFileSync(path.join(d, marker), '{}');
    }
    const f = findProjectFolders(home);
    assert.equal(f.root, path.join(home, 'code'));
    assert.deepEqual(f.folders.map((x) => x.name).sort(), ['app', 'site']);
    assert.equal(f.folders[0].short.startsWith('~/code/'), true);
    assert.equal(shortPath(home, home), '~');
    assert.deepEqual(findAssistants({ PATH: '' }, home).map((a) => [a.kind, a.found]), [['claude', false], ['codex', false]]);
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount": {}}');
    const a = findAssistants({ PATH: '' }, home);
    assert.deepEqual([a[0].found, a[0].signedIn, a[1].found], [true, true, false]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a grey second line never says its title again', () => {
  assert.equal(secondLine('weather-api', 'weather-api'), null);
  assert.equal(secondLine('Weather-API', ' weather-api '), null);
  assert.equal(secondLine('Fix the login', 'weather-api'), 'weather-api');
  assert.equal(secondLine('zsh', ''), null);
  assert.equal(secondLine('zsh', null), null);
});
