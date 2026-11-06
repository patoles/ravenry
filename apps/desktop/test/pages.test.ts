// The pages' pure parts (pages.ts): times, tones, the line diff of See
// what changed. The drawing is checked offscreen (tools/pages-test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, diffLines, timeText, toneOf } from '../src/renderer/pages.ts';

const NOW = new Date(2026, 10, 6, 17, 30).getTime(); // a Friday

test('a date as a time: today, yesterday, this week, else the day', () => {
  assert.equal(timeText(new Date(2026, 10, 6, 16, 52).toISOString(), NOW), '16:52');
  assert.equal(timeText(new Date(2026, 10, 5, 9, 0).toISOString(), NOW), 'Yesterday');
  assert.equal(timeText(new Date(2026, 10, 2, 9, 0).toISOString(), NOW), 'Mon');
  assert.equal(timeText('2026-10-30', NOW), 'Oct 30');
  assert.equal(timeText('2025-10-30', NOW), 'Oct 30, 2025');
  assert.equal(timeText('not a date', NOW), 'not a date');
});

test('how long ago', () => {
  assert.equal(agoText(new Date(NOW - 2 * 3600e3).toISOString(), NOW), '2 h ago');
  assert.equal(agoText(new Date(NOW - 3 * 86400e3).toISOString(), NOW), '3 days ago');
});

test('tones: what is fine, what needs you, and git\'s status as the Ship card colours it', () => {
  assert.equal(toneOf('fixed'), 'ok');
  assert.equal(toneOf('checked'), 'ok');
  assert.equal(toneOf('out of date'), 'you');
  assert.equal(toneOf('needs a look'), null);
  assert.deepEqual(['ahead', 'changed', 'no_upstream', 'clean'].map(toneOf), ['you', 'muted', 'faint', 'ok']);
});

test('the lines a new default added', () => {
  const a = 'item:\n  title: name\n  subtitle: brief.goal\n';
  const b = 'item:\n  title: name\n  badges: [machine]\n  subtitle: brief.goal\n  time: plan.gate_since\n';
  assert.deepEqual(diffLines(a, b).filter((r) => r.add).map((r) => r.text), ['  badges: [machine]', '  time: plan.gate_since']);
});
