// The onboarding marks (src/renderer/onboarding.ts): what the app's store
// held before the hub kept them is read, sent once for what the board
// lacks, and a mark is never taken back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleared, fromStore, missing, union } from '../src/renderer/onboarding.ts';

test('the store\'s keys from before the hub kept them are read; anything but true is left out', () => {
  const o = fromStore({ hintsDone: { 'needs-you': true, pick: false }, learnUsed: { film: true }, setupAsked: { claude: true }, selected: { key: 'x' }, other: 1 });
  assert.deepEqual(o, { hints: { 'needs-you': true }, learn: { film: true }, setup: { claude: true } });
  assert.deepEqual(fromStore({ hintsDone: null, learnUsed: 'x', setupAsked: [true] }), { hints: {}, learn: {}, setup: {} });
});

test('the union keeps every mark from both sides', () => {
  const a = { hints: { pick: true }, learn: {}, setup: { codex: true } };
  assert.deepEqual(union(a, { hints: { 'needs-you': true, pick: false }, learn: { panes: true } }), { hints: { pick: true, 'needs-you': true }, learn: { panes: true }, setup: { codex: true } });
  assert.deepEqual(union(a, null), a);
});

test('only what the board lacks is sent, and nothing when it has it all', () => {
  const mine = { hints: { pick: true, 'agent-pane': true }, learn: { film: true }, setup: {} };
  assert.deepEqual(missing(mine, { hints: { pick: true }, learn: { film: true }, setup: { claude: true } }), { hints: { 'agent-pane': true } });
  assert.equal(missing(mine, { hints: { pick: true, 'agent-pane': true }, learn: { film: true, panes: true } }), null);
  assert.deepEqual(missing(mine, null), { hints: { pick: true, 'agent-pane': true }, learn: { film: true } });
});

test('once on the board, the store\'s three keys are emptied', () => {
  assert.deepEqual(cleared(), { hintsDone: null, learnUsed: null, setupAsked: null });
});
