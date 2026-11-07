// The pure parts of the Phase 2 screens: what an input typed and how it
// echoes (6), what a drive asks and the words of its card (6), a pick's
// variant names (32), the filmstrip's marks (16), the review's diff (33),
// and the checkpoint store, which never reopens an answered checkpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Checkpoint } from '@ravenry/client';
import { echoParts, inputParts, keyLabel, sameSource } from '../src/renderer/panes.ts';
import { afterOf, Checkpoints, driveVerb, heading, markOf } from '../src/renderer/checkpoints.ts';
import { analyse, pickThumbs, summary } from '../src/renderer/filmstrip.ts';
import { parseDiff } from '../src/renderer/review.ts';

const base = (over: Partial<Checkpoint>): Checkpoint => ({
  id: 'cdrive01', kind: 'drive', title: 'Let the agent in pane pa type into "dev server" (pane pb)?', state: 'open', created_at: '2026-11-07T10:00:00.000Z', expires_at: '2026-11-07T11:00:00.000Z', assistant: 'claude', ...over,
} as Checkpoint);

test('an input is its text and keys in order, and echoes as its text and ^C', () => {
  assert.deepEqual(inputParts('<Ctrl+C>npm run dev -- --host<Enter>'), [
    { kind: 'key', text: 'Ctrl C' }, { kind: 'text', text: 'npm run dev -- --host' }, { kind: 'key', text: 'Enter' },
  ]);
  assert.deepEqual(echoParts('<Ctrl+C>npm run dev -- --host<Enter>'), ['^C', 'npm run dev -- --host']);
  assert.deepEqual(echoParts('<Enter>'), []);
  assert.deepEqual(echoParts('h<Enter>'), ['h']);
  assert.equal(keyLabel('<Shift+Tab>'), 'Shift Tab');
  assert.ok(sameSource({ kind: 'agent', pane: 'pa' }, { kind: 'agent', pane: 'pa' }));
  assert.ok(!sameSource({ kind: 'agent', pane: 'pa' }, { kind: 'agent', pane: 'pb' }));
});

test('a drive says its action in its heading, its buttons and its row', () => {
  const type = base({ drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' }, input: '<Ctrl+C>npm run dev<Enter>' } });
  assert.equal(heading(type), 'Claude wants to type');
  assert.deepEqual([driveVerb(type).once, driveVerb(type).session, driveVerb(type).row], ['Let it type this', 'Let it use this pane', 'Wants to type in']);
  const close = base({ drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' }, action: 'close' } });
  assert.equal(heading(close), 'Claude wants to close');
  assert.equal(driveVerb(close).once, 'Let it close');
  assert.equal(driveVerb(close).session, null, 'a close is let once, never for a session');
  assert.equal(driveVerb(base({ drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' }, action: 'restart' } })).once, 'Let it restart');
  const answered = { ...type, state: 'answered', closed_at: '2026-11-07T10:01:00.000Z', answer: { approved: true, allow: 'session', by: 'desktop', at: '2026-11-07T10:01:00.000Z' } } as unknown as Checkpoint;
  assert.match(afterOf(answered, Date.parse('2026-11-07T10:02:00.000Z'), 'darwin').text, /until its session ends/);
});

test('a pick says how many in its row, and an answered drive or pick leaves the panel at once', () => {
  const pick = base({ kind: 'pick', title: 'Which tilt reads best?\nRendered at frame 412.', variants: [{ label: 'A', description: 'Flat', path: '/a.png', type: 'image', size: 1 }, { label: 'B', path: '/b.png', type: 'image', size: 1 }, { label: 'C', path: '/c.png', type: 'image', size: 1 }] });
  assert.equal(heading(pick), 'Claude asks you to pick');
  assert.equal(markOf(pick).text, 'Pick one of 3: Which tilt reads best?');
  const s = new Checkpoints();
  s.fromDaemon('sock', pick, 1);
  assert.equal(s.forPane(pick.pane || '', null, 2)?.cp.id, undefined);
  const drive = base({ pane: 'pa', drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' } } });
  s.fromDaemon('sock', drive, 1);
  assert.equal(s.forPane('pa', null, 2)?.cp.id, 'cdrive01', 'open: its card shows');
  s.fromDaemon('sock', { ...drive, state: 'answered', closed_at: '2026-11-07T10:01:00.000Z' } as Checkpoint, 3);
  assert.equal(s.forPane('pa', null, 4), null, 'answered: its card leaves the panel');
  const ask = base({ id: 'cask0001', kind: 'ask', pane: 'pq', drive: undefined });
  s.fromDaemon('sock', ask, 1);
  s.fromDaemon('sock', { ...ask, state: 'answered', closed_at: '2026-11-07T10:01:00.000Z' } as Checkpoint, 3);
  assert.equal(s.forPane('pq', null, 4)?.cp.id, 'cask0001', 'an answered question says how it went');
  s.settle('pq', 5);
  assert.equal(s.forPane('pq', null, 6), null, 'until its session moves on');
});

test('the filmstrip marks blank and half drawn frames and stalls between changes', () => {
  const t = 1_000_000;
  const marks = analyse([{ at: t, blank: false }, { at: t + 400, blank: false }, { at: t + 450, blank: true }, { at: t + 1200, blank: false }, { at: t + 10_200, blank: false }], t + 12_000);
  assert.deepEqual(marks.map((m) => m.tag), [null, 'half', 'blank', null, null]);
  assert.equal(marks[3].still, 9000, 'a stall of 9 s between two changes');
  assert.equal(marks[4].still, 0, 'the last frame standing until now is no stall');
  assert.equal(summary(marks), '2 frames half drawn, 1 stall of 9 s');
  assert.deepEqual(pickThumbs(marks, 3, 0), [0, 2, 3], "the selected one, a blank one and the stall");
  assert.equal(pickThumbs(Array(20).fill({ tag: null, still: 0 }), 6, 10).length, 6);
});

test('a review reads each file of a unified diff with its line numbers', () => {
  const d = parseDiff([
    'diff --git a/src/levels/harbour.ts b/src/levels/harbour.ts',
    '--- a/src/levels/harbour.ts',
    '+++ b/src/levels/harbour.ts',
    '@@ -1,3 +1,3 @@ export const buoys',
    ' export const buoys = [',
    '-  { x: 180, bob: 0.8 },',
    '+  { x: 180, bob: 0.4 },',
    ' ];',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1 @@',
    '+export const N = 2;',
  ].join('\n'));
  const h = d.get('src/levels/harbour.ts')!;
  assert.deepEqual(h.map((l) => [l.kind, l.oldNo, l.newNo]), [['hunk', null, null], ['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['ctx', 3, 3]]);
  assert.equal(h[0].text, '@@ export const buoys @@');
  assert.deepEqual(d.get('src/new.ts')!.map((l) => l.kind), ['hunk', 'add']);
});

test('an answered checkpoint is never reopened by a late copy of the hub\'s state', () => {
  const s = new Checkpoints();
  const open = base({});
  s.fromHub([open as never], 1);
  s.fromDaemon('sock', { ...open, state: 'declined', closed_at: '2026-11-07T10:01:00.000Z' } as Checkpoint, 2);
  s.fromHub([open as never], 3);
  assert.equal(s.get('cdrive01')!.cp.state, 'declined');
  assert.equal(s.open().length, 0);
});
