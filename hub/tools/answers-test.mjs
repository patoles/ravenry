#!/usr/bin/env node
// Suggested answers on a hand-back (server/answers.mjs, server/state.mjs):
// a message that ends on a question offering options gets them as buttons
// ({ label, text }: the label on the button, the text typed as the reply),
// read by rules only, no model call (HUB-013).
//
// 1. The three real hand-backs of the pictures round (tools/fixtures/answers/):
//    "B, C, or keep A?" with A, B and C described above it (B recommended,
//    so first); "Want me to do 1 now and draw 2 alongside the page fix?"
//    (Yes and No, no "or" between the keys); a message that asks nothing,
//    whose quoted "which one?" mid-paragraph is no question (the bug: it
//    was taken as one).
// 2. The shapes around them: a numbered list and "1, 2 or 3?", "X or Y?",
//    keys nothing above defines, a question in a code block, a question
//    earlier in the last paragraph, a version number in the question.
// 3. Through describe() as every client reads it (words.quick), and the
//    message's own options winning over the brief's Quick answers (the
//    board's state on a test hub: the demo board's garden-planner).
//
// Each check fails on the code before this feature (0.1.49), except the
// ones named "guard:", which hold what must not change (they pass on both).
// Usage: node tools/answers-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endingQuestion, describe } from '../server/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = (n) => fs.readFileSync(path.join(HERE, 'fixtures', 'answers', `handback-${n}.txt`), 'utf8');

let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (ok) passed++; else failed++; };
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : `, want ${JSON.stringify(want)}`}`);

// The words a session waiting on the person gets, as the board builds them.
const now = Date.now();
function wordsFor(lastText) {
  const q = endingQuestion(lastText);
  const st = q ? { state: 'asked', since: new Date(now - 60000).toISOString(), question: q } : { state: 'handback', since: new Date(now - 60000).toISOString() };
  return describe({ name: 'paper-boat' }, { st, transcript: { lastText, title: 'Launch page hero' }, screen: {} }, 'you', now);
}
const buttons = (w) => (w.quick || []).map((o) => ({ label: o.label, text: o.text }));

// ------------------------------------------------------------ 1. the real hand-backs
{
  const w = wordsFor(text(1));
  same('guard: real 1: "B, C, or keep A?" is the question', w.question, 'B, C, or keep A?');
  same('real 1: B (recommended) first, then C, then Keep A; each its key and short words, cut at 26 on a word', buttons(w), [
    { label: 'B: the app', text: 'B' }, { label: 'C: the app with an alert…', text: 'C' }, { label: 'Keep A: today', text: 'Keep A' }]);
  check('guard: real 1: every label fits 26 characters', w.quick.every((o) => o.label.length <= 26), w.quick.map((o) => o.label.length).join(','));
}
{
  const w = wordsFor(text(2));
  same('real 2: "Want me to do 1 now and draw 2 ...?" is Yes / No (no "or" between the keys)', buttons(w), [{ label: 'Yes', text: 'Yes' }, { label: 'No', text: 'No' }]);
}
{
  const t3 = text(3);
  same('real 3: a quoted "which one?" mid-paragraph is no question', endingQuestion(t3), null);
  const w = wordsFor(t3);
  same('guard: real 3: no buttons', buttons(w), []);
}

// ------------------------------------------------------------ 2. the shapes around them
same('numbered list + "1, 2 or 3?": three keys, each its words', buttons(wordsFor('Three ways to fix it:\n\n1. **Rebuild the index** from scratch (10 min)\n2. Patch the reader\n3. Leave it as it is\n\nWhich one: 1, 2 or 3?')),
  [{ label: '1: Rebuild the index', text: '1' }, { label: '2: Patch the reader', text: '2' }, { label: '3: Leave it as it is', text: '3' }]);
same('a long option is cut at a word, never inside an open bracket', buttons(wordsFor('Two ways:\n\n1. Rebuild the index (10 min)\n2. Patch the reader\n\nWhich, 1 or 2?')),
  [{ label: '1: Rebuild the index…', text: '1' }, { label: '2: Patch the reader', text: '2' }]);
same('"X or Y?": the two sides', buttons(wordsFor('The hull rocks now.\n\nTilt the hull with the slope too, or keep it level?')),
  [{ label: 'Tilt the hull with the…', text: 'Tilt the hull with the slope too' }, { label: 'Keep it level', text: 'Keep it level' }]);
same('"X or Y?" after a lead-in: the lead-in is not an answer', buttons(wordsFor('Which do you want, the blue one or the red one?')),
  [{ label: 'The blue one', text: 'The blue one' }, { label: 'The red one', text: 'The red one' }]);
same('guard: keys nothing above defines: no buttons (no guess)', buttons(wordsFor('Both builds pass.\n\nShip A or B?')), []);
same('a version number in the question is no key and no sentence end', endingQuestion('Release notes are written.\n\nShip 0.1.50 or wait?'), 'Ship 0.1.50 or wait?');
same('a code block (with a blank line in it) that ends the message on "?": no question', endingQuestion('Run this:\n\n```\necho ready\n\nread -p \'go?\'\n```'), null);
same('guard: a code block with "?" in the middle, a plain last paragraph: no question', endingQuestion('Here is the script:\n\n```\nif (ok?) go\n\nthen?\n```\n\nIt runs every night.'), null);
same('a question earlier in the last paragraph, then a statement: no question', endingQuestion('Want me to ship it? I will wait for the tests first.'), null);
same('guard: a question that ends the message after a code block: still the question', endingQuestion('```\nnpm test\n```\n\nShould I run it?'), 'Should I run it?');
same('a question ending inside a bracket still ends the message', endingQuestion('Done.\n\n(Want me to push it?)'), '(Want me to push it?)');
same('the "Option A" shape defines its key', buttons(wordsFor('**Option A**: keep the sheet\n**Option B**: a page of its own\n\nA or B?')),
  [{ label: 'A: keep the sheet', text: 'A' }, { label: 'B: a page of its own', text: 'B' }]);
same('at most four buttons', buttons(wordsFor('A) one\nB) two\nC) three\nD) four\nE) five\n\nA, B, C, D or E?')).length, 4);

// ------------------------------------------------------------ 3. the message's options win over the brief's
// The board's state on a test hub (the demo board, its own HOME on 127.0.0.1):
// garden-planner asks "A week before sowing, or on the first frost-free day?",
// and its brief gets Quick answers; notes-app's question offers none.
{
  const { startDemoHub, freePort } = await import('../../apps/desktop/tools/demo-hub.mjs');
  const TMP = path.join(HERE, '..', '.tmp', 'answers-test');
  const hub = await startDemoHub({ dir: TMP, port: await freePort(), prepare: ({ ROOT }) => {
    for (const id of ['garden-planner', 'notes-app']) {
      const f = path.join(ROOT, id, 'BRIEF.md');
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.splice(1, 0, '', 'Quick answers: Go on | Stop here');
      fs.writeFileSync(f, lines.join('\n'));
    }
  } });
  try {
    await hub.arrive('notes-app', 'The settings screen is done. Ship the beta to the testers?');
    let st = null;
    for (let i = 0; i < 100; i++) {
      st = await hub.state();
      const np = st.projects.find((p) => p.id === 'notes-app');
      if (np && np.state === 'you') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const gp = st.projects.find((p) => p.id === 'garden-planner');
    const np = st.projects.find((p) => p.id === 'notes-app');
    same('hub: the message\'s own options win over the brief\'s Quick answers', (gp.quick || []).map((o) => o.text), ['A week before sowing', 'On the first frost-free day']);
    same('hub: the primary session\'s words carry them too', ((gp.sessions.find((s) => s.surfaceId === gp.primary) || {}).words || {}).quick?.map((o) => o.label), ['A week before sowing', 'On the first frost-free…']);
    same('guard: hub: a question with no options of its own keeps the brief\'s Quick answers', (np.quick || []).map((o) => o.label), ['Go on', 'Stop here']);
  } finally { hub.stop(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
