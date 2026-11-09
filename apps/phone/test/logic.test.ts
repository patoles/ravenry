// The phone board's own rules (src/logic.ts) and the bridge's wire
// (src/shell.ts), without a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksOf, connLabel, distributorName, dropLine, KEYS, markLabel, mmss, parentOf, quickAnswers, driveWords, paneInTitle, regionOf, strip, topLabel, variantOf, waitOf } from '../src/logic.ts';
import { BRIDGE_VERSION, Wire } from '../src/shell.ts';
import { board } from '../../desktop/src/renderer/model.ts';
import type { HubProject } from '../../desktop/src/renderer/model.ts';
// @ts-ignore: the hub's module, plain JavaScript
import { build, withGroups } from '../../../hub/server/sidebar.mjs';
import type { HubCheckpoint } from '../../desktop/src/renderer/checkpoints.ts';

const NOW = Date.parse('2026-11-06T17:38:00Z');
const cp = (x: Partial<HubCheckpoint>): HubCheckpoint => ({ id: 'cabc1234', kind: 'ask', state: 'open', title: 'Ship it?', created_at: new Date(NOW - 2 * 60000).toISOString(), expires_at: new Date(NOW + 26 * 60000).toISOString(), ...x } as HubCheckpoint);

test('the strip has one part per group, as wide as its sessions', () => {
  const projects = withGroups([
    { id: 'a', name: 'a', state: 'you', sessions: [{ surfaceId: 's1', state: 'asked' }], primary: 's1' },
    { id: 'b', name: 'b', state: 'work', sessions: [{ surfaceId: 's2', state: 'working' }, { surfaceId: 's3', state: 'working' }], primary: 's2' },
    { id: 'c', name: 'c', state: 'idle', sessions: [], primary: null },
  ]) as HubProject[];
  const groups = board({ projects, sidebar: build(projects, { now: NOW }) }, NOW);
  assert.deepEqual(strip(groups), [{ group: 'you', n: 1 }, { group: 'work', n: 2 }, { group: 'idle', n: 1 }]);
});

test('the word for a checkpoint\'s kind on a session row', () => {
  assert.equal(markLabel('ask'), 'Checkpoint:');
  assert.equal(markLabel('approve'), 'Wants to run:');
  assert.equal(markLabel('secret'), 'Needs a secret:');
});

test('quick answers leave out the lines that open a field', () => {
  const q = quickAnswers({ surfaceId: 's', state: 'dialog', words: { quick: [{ label: '10 minutes', choice: 1 }, { label: '30 minutes', choice: 2 }, { label: 'Type something.', choice: 3 }, { label: 'Chat about this', choice: 4 }] } });
  assert.deepEqual(q.map((x) => x.label), ['10 minutes', '30 minutes']);
  const perm = quickAnswers({ surfaceId: 's', state: 'dialog', words: { quick: [{ label: 'Yes', choice: 1 }, { label: 'Yes, and don\'t ask again', choice: 2 }, { label: 'No, and tell Claude what to do differently', choice: 3 }] } });
  assert.equal(perm.length, 3);
  assert.deepEqual(quickAnswers(null), []);
});

test('the key bar sends what a terminal expects', () => {
  const by = Object.fromEntries(KEYS.map((k) => [k.aria, k.bytes]));
  assert.equal(by.Escape, '\x1b');
  assert.equal(by.Up, '\x1b[A');
  assert.equal(by.Enter, '\r');
  assert.equal(by['Control C'], '\x03');
  assert.equal(KEYS.length, 8);
});

test('the connection chip names this computer, then the machines it reaches', () => {
  assert.equal(connLabel('MacBook Pro', [{ name: 'devbox', state: 'connected' }, { name: 'gpu', state: 'down' }]), 'MacBook Pro + devbox');
  assert.equal(connLabel('MacBook Pro', []), 'MacBook Pro');
});

test('the clock says how long the agent waited and when it gives up', () => {
  const w = waitOf(cp({}), NOW);
  assert.equal(w.label, 'Waiting 2 min');
  assert.match(w.until!, /^\d\d:\d\d$/);
  assert.ok(w.pct > 6 && w.pct < 8, String(w.pct));
  assert.equal(waitOf(cp({ created_at: new Date(NOW - 20000).toISOString() }), NOW).label, 'Waiting since just now');
});

test('a numbered list in the question becomes its checks', () => {
  const c = checksOf('Build 0.9.4 is on the tablet.\n1. The lobby loads in under 10 seconds\n2. Both hands show');
  assert.equal(c.text, 'Build 0.9.4 is on the tablet.');
  assert.deepEqual(c.checks, ['The lobby loads in under 10 seconds', 'Both hands show']);
  assert.deepEqual(checksOf('One line only').checks, []);
  assert.equal(checksOf(null).text, null);
});

test('a photo and a voice note arrive as one line with their paths', () => {
  const d = dropLine({ at: Date.parse('2026-11-06T10:58:00'), topic: 'Tablet build check', answer: 'Didn\'t work', drops: [{ kind: 'photo', name: 'photo-1058.jpg', path: '~/p/.inbox/photo-1058.jpg' }, { kind: 'voice', name: 'voice-1058.m4a', path: '~/p/.inbox/voice-1058.m4a', ms: 7000 }], note: '' });
  assert.equal(d.head, 'Photo and voice note from your phone, 10:58, sent to Tablet build check');
  assert.deepEqual(d.lines, ['Answer: Didn\'t work', 'photo-1058.jpg, voice-1058.m4a (voice note 0:07)']);
  assert.match(d.text, /photo at ~\/p\/\.inbox\/photo-1058\.jpg/);
  assert.match(d.text, /voice note 0:07 at ~\/p\/\.inbox\/voice-1058\.m4a/);
  assert.equal(mmss(65000), '1:05');
});

test('the top label says who waits and for what', () => {
  assert.equal(topLabel(cp({ assistant: 'claude' }), 'Claude'), 'Claude is waiting for you');
  assert.equal(topLabel(cp({ kind: 'approve' }), 'Codex'), 'Codex wants to run a command');
  assert.equal(topLabel(cp({ kind: 'secret' }), 'Claude'), 'Claude needs a secret');
  assert.equal(topLabel(cp({ kind: 'approve', page: { title: 'Map tiles', label: 'Rebuild' } }), 'Claude'), 'Map tiles wants to run a command');
});

test('Back goes up a level, and the sessions are the top', () => {
  assert.equal(parentOf('/'), null);
  assert.equal(parentOf('/s/x'), '/');
  assert.equal(parentOf('/fb/c1'), '/cp/c1');
});

test('a push distributor is called by the name people know', () => {
  assert.equal(distributorName('io.heckel.ntfy'), 'ntfy');
  assert.equal(distributorName(null), null);
  assert.equal(distributorName('org.example.pusher'), 'pusher');
});

test('the wire matches replies to requests and passes events on', async () => {
  const sent: string[] = [];
  const w = new Wire((t) => sent.push(t));
  const got: unknown[] = [];
  w.on('link', (m) => got.push(m.state));
  const a = w.call<{ x: number }>('hub.call', { method: 'GET', path: '/api/state' });
  const b = w.call('biometric', { title: 'Run' });
  const [m1, m2] = sent.map((s) => JSON.parse(s));
  assert.equal(m1.v, BRIDGE_VERSION);
  assert.equal(m1.op, 'hub.call');
  assert.equal(m1.path, '/api/state');
  w.receive(JSON.stringify({ event: 'link', state: 'up' }));
  w.receive(JSON.stringify({ id: m2.id, ok: false, error: 'No fingerprint is set up on this phone.' }));
  w.receive(JSON.stringify({ id: m1.id, ok: true, result: { x: 1 } }));
  assert.deepEqual(await a, { x: 1 });
  await assert.rejects(b, /No fingerprint/);
  assert.deepEqual(got, ['up']);
  w.receive('not json');
  w.receive(JSON.stringify({ id: 999, ok: true }));
});

test('a pick names each variant by its letter and its whole label, and the agent\'s words come from its description', () => {
  assert.deepEqual(variantOf({ label: 'Level' }, 0, 'Claude'), { letter: 'A', name: 'Level', says: null });
  assert.deepEqual(variantOf({ label: 'Tilt with the slope', description: 'The hull follows the wave\'s angle at the bow.' }, 1, 'Claude'), { letter: 'B', name: 'Tilt with the slope', says: 'Claude: The hull follows the wave\'s angle at the bow.' });
  assert.deepEqual(variantOf({ label: 'Half. The slope' }, 2, 'Codex'), { letter: 'C', name: 'Half. The slope', says: null });
  assert.equal(topLabel(cp({ kind: 'pick' }), 'Claude'), 'Claude wants you to pick');
  assert.equal(topLabel(cp({ kind: 'drive' }), 'Claude'), 'Claude is asking first');
});

test('the circled part is the box around the finger\'s path, in fractions of the picture, inside it', () => {
  assert.deepEqual(regionOf([[0.4, 0.3], [0.6, 0.25], [0.62, 0.5], [0.38, 0.48]]), { x: 0.38, y: 0.25, w: 0.24, h: 0.25 });
  assert.deepEqual(regionOf([[-0.2, 0.9], [0.1, 1.4]]), { x: 0, y: 0.9, w: 0.1, h: 0.1 });
  assert.equal(regionOf([[0.5, 0.5], [0.51, 0.505]]), null);
  assert.equal(regionOf([[0.5, 0.5]]), null);
});


test('a drive says its action and names the pane, never its id', () => {
  const input = driveWords(undefined, 'Claude', 'dev server');
  assert.equal(input.title, 'Claude wants to type in dev server');
  assert.deepEqual(input.yes.map((y) => [y.allow, y.label]), [['once', 'Allow once'], ['session', 'This session']]);
  const close = driveWords('close', 'Claude', 'dev server');
  assert.equal(close.title, 'Claude wants to close dev server');
  assert.deepEqual(close.yes.map((y) => [y.allow, y.label]), [['once', 'Let it close']]);
  assert.equal(driveWords('restart', 'Codex', 'tests').title, 'Codex wants to restart tests');
  assert.equal(driveWords('override', 'Codex', 'tui').title, 'Codex wants to change how tui runs');
  assert.equal(paneInTitle('Let Claude close "dev server" (pane pk3m9q2x)?'), 'dev server');
  assert.equal(paneInTitle('Let Claude close pane pk3m9q2x?'), null);
});
