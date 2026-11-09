// The checkpoint cards' states (what each says, open and after), the store
// that merges the daemons' and the hub's checkpoints, the sidebar marks, and
// how the secret field holds a secret: only in the field, gone on blur and
// once taken for the answer call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Checkpoint } from '@ravenry/client';
import {
  afterOf, changedRange, characters, Checkpoints, daemonAnswer, digitChoice, duration, givesUp, heading, hubAnswer, markOf, ranCommand, riskOf, runLabel, SecretField, warningsOf,
  secretProblem, shortCommand, splitTitle, waiting, wantsLine,
} from '../src/renderer/checkpoints.ts';
import type { HubCheckpoint } from '../src/renderer/checkpoints.ts';
import { board } from '../src/renderer/model.ts';
import type { HubState } from '../src/renderer/model.ts';
// @ts-ignore: the hub's module, plain JavaScript
import { build, marksOf, withGroups } from '../../../hub/server/sidebar.mjs';

const NOW = new Date(2026, 10, 6, 17, 36, 0).getTime();
const at = (min: number) => new Date(NOW - min * 60000).toISOString();

const ask: Checkpoint = {
  id: 'cask0001', kind: 'ask', state: 'open', title: 'Ship the beta to the testers?\nThe settings screen is done and all 64 tests pass.',
  pane: 'paaaaaaa', assistant: 'claude', options: ['Ship it', 'Not yet'], free_text: true, created_at: at(2), expires_at: new Date(2026, 10, 6, 18, 4).toISOString(),
};
const approve: HubCheckpoint = {
  id: 'capp0001', kind: 'approve', state: 'open', title: 'git push origin main && npm publish', command: 'git push origin main && npm publish', cwd: '/home/you/code/recipe-box',
  why: 'The import tests pass.', pane: 'pbbbbbbb', assistant: 'codex', created_at: at(3), expires_at: new Date(2026, 10, 6, 18, 3).toISOString(), machine: 'devbox',
};
const secret: Checkpoint = {
  id: 'csec0001', kind: 'secret', state: 'open', title: 'Mail service API key', command: 'npx wrangler secret put MAIL_API_KEY', cwd: '/home/you/Projects/garden-planner',
  secret: { to: 'run', enter: true }, pane: 'pccccccc', assistant: 'claude', created_at: at(1), expires_at: new Date(2026, 10, 6, 18, 1).toISOString(),
};

test('an open card says who waits, since when, and until when', () => {
  assert.equal(heading(ask), 'Claude asks');
  assert.equal(heading(approve), 'Codex wants to run');
  assert.equal(heading(secret), 'Claude needs a secret');
  assert.equal(heading({ ...ask, assistant: undefined }), 'The agent asks');
  assert.equal(heading({ ...ask, kind: 'poll' }), 'Claude is waiting');
  assert.equal(waiting(ask, NOW), 'waiting 2 min');
  assert.equal(waiting({ ...ask, created_at: at(0.2) }, NOW), 'just now');
  assert.equal(waiting({ ...ask, created_at: at(130) }, NOW), 'waiting 2 h');
  assert.equal(givesUp(ask, NOW), 'Gives up at 18:04');
  assert.match(givesUp({ ...ask, expires_at: new Date(2026, 10, 7, 9, 0).toISOString() }, NOW), /^Gives up at \w{3} 09:00$/);
  assert.deepEqual(splitTitle(ask.title), { head: 'Ship the beta to the testers?', body: 'The settings screen is done and all 64 tests pass.' });
  assert.deepEqual(splitTitle('One line'), { head: 'One line', body: null });
});

test('the approve card names the machine, warns when it cannot be undone', () => {
  assert.equal(runLabel('devbox', 'darwin'), 'Run on devbox');
  assert.equal(runLabel(null, 'darwin'), 'Run on this Mac');
  assert.equal(runLabel(null, 'linux'), 'Run on this computer');
  assert.equal(riskOf('git push origin main && npm publish'), 'Publishing to npm can\'t be undone');
  assert.equal(riskOf('npm --workspace x publish --tag beta'), 'Publishing to npm can\'t be undone');
  assert.equal(riskOf('git push --force origin main'), 'A force push can\'t be undone');
  assert.equal(riskOf('rm -rf build'), 'Deleting with rm -rf can\'t be undone');
  assert.equal(riskOf('git push origin main'), null);
  assert.equal(riskOf('npm test'), null);
  assert.equal(riskOf('psql -c "DROP TABLE users"'), 'Dropping data can\'t be undone');
});

test('the agent\'s warning shows as its own, and never hides Ravenry\'s guess', () => {
  // Only Ravenry's guess: the fallback, labelled as Ravenry's.
  assert.deepEqual(warningsOf(approve), [{ from: 'ravenry', label: 'Ravenry\'s guess:', text: 'Publishing to npm can\'t be undone' }]);
  // The agent declares one: shown as its words, and the guess stays.
  const reassuring = { ...approve, warning: 'Nothing here can go wrong' };
  assert.deepEqual(warningsOf(reassuring).map((w) => `${w.from}|${w.label} ${w.text}`), [
    'agent|Codex warns: Nothing here can go wrong',
    'ravenry|Ravenry\'s guess: Publishing to npm can\'t be undone',
  ]);
  // The agent's warning alone, on a command Ravenry has no guess for.
  assert.deepEqual(warningsOf({ ...approve, command: 'make deploy', warning: 'This restarts the production server' }).map((w) => w.from), ['agent']);
  // While the person edits, the guess follows the edited text.
  assert.deepEqual(warningsOf(approve, 'git push origin main'), []);
  assert.deepEqual(warningsOf({ ...approve, warning: '  ' }, 'npm test'), []);
});

test('edit then run, and refuse with a reason: the answer carries them, the card says so after', () => {
  assert.deepEqual(daemonAnswer('capp0001', { approve: true, command: 'npm publish --tag beta' }), { checkpoint: 'capp0001', by: 'desktop', approve: true, command: 'npm publish --tag beta' });
  assert.deepEqual(hubAnswer('capp0001', { approve: true, command: 'npm publish --tag beta' }), { id: 'capp0001', by: 'desktop', approve: true, command: 'npm publish --tag beta' });
  assert.deepEqual(hubAnswer('capp0001', { decline: true, reason: 'Run the tests first' }), { id: 'capp0001', by: 'desktop', decline: true, reason: 'Run the tests first' });
  const ed = { ...approve, state: 'answered' as const, answer: { approved: true, command: 'npm publish --tag beta', by: 'desktop', at: at(1) }, closed_at: at(0), run: { pane: 'pd', exit: { code: 0 } } };
  assert.equal(ranCommand(ed), 'npm publish --tag beta');
  const after = afterOf(ed, NOW, 'darwin');
  assert.equal(after.command, 'npm publish --tag beta');
  assert.equal(after.edited, true);
  assert.match(after.text, /You edited it and approved it here; codex has the output and knows you changed it\./i);
  const running = afterOf({ ...ed, state: 'running', run: { pane: 'pd' } }, NOW, 'darwin');
  assert.match(running.text, /You edited it and approved it here\. Codex gets the output when it ends, and is told you changed it\./);
  const plain = afterOf({ ...ed, answer: { approved: true, by: 'desktop', at: at(1) } }, NOW, 'darwin');
  assert.equal(plain.command, approve.command);
  assert.equal(plain.edited, false);
  const refused = afterOf({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, reason: 'Run the tests first', by: 'desktop', at: at(0) } }, NOW, 'darwin');
  assert.equal(refused.text, 'You said no here: "Run the tests first". Codex was told.');
  assert.equal(afterOf({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, by: 'phone', at: at(0) } }, NOW, 'darwin').text, 'You said no on your phone. Codex was told.');
});

test('number keys pick an answer; edits are tinted where they changed', () => {
  assert.equal(digitChoice('1', ask), 0);
  assert.equal(digitChoice('2', ask), 1);
  assert.equal(digitChoice('3', ask), null);
  assert.equal(digitChoice('a', ask), null);
  assert.equal(digitChoice('1', approve), null);
  const cmd = 'git push origin main && npm publish';
  assert.deepEqual(changedRange(cmd, cmd + ' --tag beta'), [cmd.length, cmd.length + 11]);
  assert.deepEqual(changedRange(cmd, cmd.replace('main', 'beta')), [16, 20]);
  assert.equal(changedRange(cmd, cmd), null);
});

test('the sidebar mark says what kind of answer waits', () => {
  assert.deepEqual(markOf(ask), { kind: 'ask', text: 'Ship the beta to the testers?', code: false });
  assert.deepEqual(markOf(approve), { kind: 'approve', text: 'git push origin main && npm publish', code: true });
  assert.deepEqual(markOf(secret), { kind: 'secret', text: 'Wants the mail service API key', code: false });
  assert.equal(wantsLine('GitHub token'), 'Wants the GitHub token');
  assert.equal(wantsLine('AWS secret key'), 'Wants the AWS secret key');
});

test('after an answer the card says how it ended', () => {
  const asked = afterOf({ ...ask, state: 'answered', closed_at: at(0), answer: { choice: 0, option: 'Ship it', by: 'phone', at: at(0) } }, NOW, 'darwin');
  assert.deepEqual([asked.ok, asked.head, asked.small, asked.big, asked.text, asked.time], [true, 'Answered', 'Ship the beta to the testers?', 'Ship it', 'You answered on your phone.', '17:36']);
  const typed = afterOf({ ...ask, state: 'answered', closed_at: at(0), answer: { text: 'Not yet, after the fix', by: 'desktop', at: at(0) } }, NOW, 'darwin');
  assert.equal(typed.big, 'Not yet, after the fix');
  assert.equal(typed.text, 'You answered here.');
  const ran = afterOf({ ...approve, state: 'answered', answer: { approved: true, by: 'desktop', at: at(0.1) }, closed_at: new Date(NOW - 6000 + 6000).toISOString(), run: { pane: 'pdddddddd', exit: { code: 0 } } }, NOW, 'darwin');
  assert.equal(ran.head, 'Ran on devbox');
  assert.equal(ran.text, 'Finished in 6 s with no errors. You approved it here; Codex has the output.');
  assert.equal(ran.runPane, 'pdddddddd');
  const failed = afterOf({ ...approve, machine: null, state: 'answered', answer: { approved: true, by: 'desktop', at: at(1) }, closed_at: at(0), run: { pane: 'pd', exit: { code: 2 } } }, NOW, 'darwin');
  assert.equal(failed.ok, false);
  assert.equal(failed.head, 'Ran on this Mac');
  assert.match(failed.text, /^Ended with exit code 2 after 1 min\./);
  const running = afterOf({ ...approve, state: 'running', answer: { approved: true, by: 'desktop', at: at(0) }, run: { pane: 'pd' } }, NOW, 'darwin');
  assert.equal(running.head, 'Running on devbox');
  const sent = afterOf({ ...secret, state: 'answered', closed_at: at(0), answer: { delivered: true, by: 'desktop', at: at(0) } }, NOW, 'darwin');
  assert.deepEqual([sent.head, sent.big], ['Secret sent', 'Mail service API key']);
  assert.equal(sent.text, 'Sent to wrangler secret put. Ravenry didn\'t keep a copy, so it can\'t be shown again. To change it, Claude has to ask again.');
  assert.equal(afterOf({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, by: 'desktop', at: at(0) } }, NOW, 'darwin').head, 'Refused');
  assert.equal(afterOf({ ...ask, state: 'expired', closed_at: at(0) }, NOW, 'darwin').head, 'Nobody answered');
  assert.match(afterOf({ ...ask, state: 'cancelled', reason: 'done another way', closed_at: at(0) }, NOW, 'darwin').text, /withdrew it: done another way/);
  assert.equal(shortCommand('npx wrangler secret put MAIL_API_KEY'), 'wrangler secret put');
  assert.equal(shortCommand('gh secret set TOKEN'), 'gh secret set');
  assert.equal(duration(6000), '6 s');
  assert.equal(duration(80000), '1 min 20 s');
});

test('the store merges a daemon\'s checkpoints with the hub\'s, and keeps a closed one a while', () => {
  const st = new Checkpoints();
  assert.deepEqual(st.fromDaemon('/s1', ask, NOW), { opened: true, closed: false });
  // The hub lists the same one: it adds where it runs, the daemon stays the way to answer.
  const r = st.fromHub([{ ...ask, machine: null, projectId: 'notes-app', surfaceId: 'ravenry:paaaaaaa' }, approve], NOW);
  assert.deepEqual(r.opened, ['capp0001']);
  assert.equal(st.get('cask0001')!.socket, '/s1');
  assert.equal(st.get('cask0001')!.hub, true);
  assert.equal(st.get('cask0001')!.cp.projectId, 'notes-app');
  // A daemon event later keeps the hub's extras.
  st.fromDaemon('/s1', { ...ask, state: 'answered', answer: { choice: 0, option: 'Ship it', at: at(0) }, closed_at: at(0) }, NOW);
  assert.equal(st.get('cask0001')!.cp.projectId, 'notes-app');
  assert.equal(st.forPane('paaaaaaa', null, NOW)!.cp.state, 'answered');
  assert.equal(st.forPane('paaaaaaa', null, NOW + 31 * 60000), null);
  // Its turn ended: the closed card goes.
  st.settle('paaaaaaa', NOW + 1000);
  assert.equal(st.forPane('paaaaaaa', null, NOW + 2000), null);
  // The hub stopped listing the remote one and no daemon of this window told how it ended.
  assert.deepEqual(st.fromHub([], NOW).gone, ['capp0001']);
  assert.equal(st.forPane('pbbbbbbb', 'devbox', NOW)!.cp.id, 'capp0001');
  assert.equal(st.forPane('pbbbbbbb', null, NOW), null);
  st.dropDaemon('/s1');
  assert.equal(st.get('cask0001')!.socket, null);
  st.prune(NOW + 31 * 60000);
  assert.equal(st.get('cask0001'), null);
});

test('a session waiting at a checkpoint needs you, with its mark and the time it started waiting', () => {
  const state: HubState = {
    projects: [
      { id: 'notes-app', name: 'notes-app', state: 'work', since: at(1), primary: 'ravenry:paaaaaaa', sessions: [{ surfaceId: 'ravenry:paaaaaaa', state: 'working', topic: 'Sync settings', assistant: 'claude' }] },
      { id: 'trail-map', name: 'trail-map', state: 'idle', since: at(3000), primary: 's2', sessions: [{ surfaceId: 's2', state: 'idle' }] },
    ],
  };
  // The hub marks the session and puts it in Needs you (hub/server/sidebar.mjs); the window draws it.
  const cps = [{ ...ask, pane: 'paaaaaaa', machine: null }];
  const g = board({ ...state, sidebar: build(state.projects, { marks: marksOf(state.projects, cps, { now: NOW }), now: NOW }) }, NOW);
  assert.equal(g[0].group, 'you');
  assert.equal(g[0].projects[0].time, '17:34');
  assert.deepEqual(g[0].projects[0].rows[0].mark, { kind: 'ask', text: 'Ship the beta to the testers?', code: false, since: ask.created_at });
  assert.equal(g[0].projects[0].rows[0].line, null);
  assert.equal(board({ ...state, sidebar: build(withGroups(state.projects), { now: NOW }) }, NOW)[0].group, 'work');
});

/** An input element as far as the secret field needs one. */
class FakeInput {
  value = '';
  private fns = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void): void { this.fns.set(type, [...(this.fns.get(type) || []), fn]); }
  fire(type: string): void { for (const fn of this.fns.get(type) || []) fn(); }
  type(text: string): void { this.value += text; this.fire('input'); }
}

test('a secret lives only in its field: cleared on blur and once taken, never kept', () => {
  const KEY = 'test-secret-kept-out-of-the-logs';
  const input = new FakeInput();
  let changes = 0;
  const f = new SecretField(input, () => { changes++; });
  input.type(KEY);
  assert.equal(f.count, KEY.length);
  assert.equal(characters(f.count), '32 characters');
  assert.equal(f.problem, null);
  // Nothing but the element holds it.
  assert.ok(!JSON.stringify(Object.entries(f).filter(([k]) => k !== 'input')).includes(KEY));
  // Focus leaves the field: it is gone.
  input.fire('blur');
  assert.equal(input.value, '');
  assert.equal(f.count, 0);
  // Typed again and sent: take() hands it over once and empties the field.
  input.type(KEY + '\n');
  assert.equal(input.value, KEY, 'a pasted line break is dropped');
  const v = f.take();
  assert.equal(v, KEY);
  assert.equal(input.value, '');
  assert.equal(f.take(), '');
  assert.ok(changes >= 4);
  // The answer call's params hold it, and only there.
  assert.deepEqual(daemonAnswer('csec0001', { secret: v }), { checkpoint: 'csec0001', by: 'desktop', secret: KEY });
  assert.deepEqual(hubAnswer('csec0001', { secret: v }), { id: 'csec0001', by: 'desktop', secret: KEY });
});

test('a secret must be one line of 4 to 4096 bytes', () => {
  assert.equal(secretProblem(''), 'Type or paste it first.');
  assert.equal(secretProblem('abc'), 'That is too short for a secret.');
  assert.equal(secretProblem('abcd'), null);
  assert.equal(secretProblem('ab\ncd'), 'A secret is one line.');
  assert.equal(secretProblem('x'.repeat(4097)), 'That is longer than a secret can be (4 KiB).');
});
