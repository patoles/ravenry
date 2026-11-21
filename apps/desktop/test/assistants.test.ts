// The assistants are the hub's (GET /api/state assistants.list, the
// registry in hub/server/assistants.mjs): the words and what each can do
// come from that list, Claude Code and Codex before the first state and
// from an older hub, exactly as they read before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantCan, assistantFullName, assistantName, assistants, isAssistant, takeAssistants } from '../src/renderer/model.ts';

test('before any state: Claude Code and Codex, their words as before', () => {
  assert.deepEqual(assistants().map((a) => a.id), ['claude', 'codex']);
  assert.equal(assistantName('claude'), 'Claude');
  assert.equal(assistantName('codex'), 'Codex');
  assert.equal(assistantName('other'), 'Other');
  assert.equal(assistantName(null), null);
  assert.equal(assistantFullName('claude'), 'Claude Code');
  assert.equal(assistantFullName('codex'), 'Codex');
  assert.ok(assistantCan('claude', 'resume') && assistantCan('codex-x', 'resume') && !assistantCan('other', 'resume'));
});

test('an older hub (no list) keeps the built-in one', () => {
  takeAssistants({ projects: [] });
  takeAssistants({ assistants: { startWith: 'claude' } });
  assert.deepEqual(assistants().map((a) => a.id), ['claude', 'codex']);
});

test('the hub\'s list: a third assistant gets its words and its capabilities', () => {
  const caps = (resume: boolean) => ({ resume, model: true, permission: true, context: true, handoff: true, print: true });
  takeAssistants({ assistants: { list: [
    { id: 'claude', name: 'Claude Code', short: 'Claude', chip: 'Claude', caps: caps(true) },
    { id: 'codex', name: 'Codex', short: 'Codex', chip: 'Codex', caps: caps(true) },
    { id: 'fake', name: 'Stand-in Agent', short: 'Stand-in', chip: 'Stand-in', caps: caps(false) },
  ] } });
  assert.deepEqual(assistants().map((a) => a.id), ['claude', 'codex', 'fake']);
  assert.equal(assistantName('fake'), 'Stand-in');
  assert.equal(assistantFullName('fake'), 'Stand-in Agent');
  assert.ok(isAssistant('fake') && !isAssistant('nope'));
  assert.ok(!assistantCan('fake', 'resume'), 'the stand-in cannot resume, so no Move here');
  assert.equal(assistantName('claude'), 'Claude');
  assert.equal(assistantFullName('codex'), 'Codex');
});
