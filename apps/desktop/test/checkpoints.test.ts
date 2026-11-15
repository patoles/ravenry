// The checkpoint cards' clocks and how the window fills the hub's words
// (what each card says is the hub's: hub/tools/cpwords-test.mjs), the store
// that merges the daemons' and the hub's checkpoints and asks the hub for
// the words a daemon's copy lacks, the sidebar marks, and how the secret
// field holds a secret: only in the field, gone on blur and once taken for
// the answer call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Checkpoint } from '@ravenry/client';
import {
  changedRange, characters, Checkpoints, daemonAnswer, digitChoice, fill, givesUp, hubAnswer, SecretField, secretProblem, timeOf, waiting, warningsFor, wordsBody, wordsOf,
} from '../src/renderer/checkpoints.ts';
import type { CheckpointWords, HubCheckpoint, Reader } from '../src/renderer/checkpoints.ts';
// @ts-ignore: the hub's module, plain JavaScript
import { withWords } from '../../../hub/server/cpwords.mjs';
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

const worded = (cp: HubCheckpoint): HubCheckpoint => withWords(cp, { platform: 'darwin', hubName: 'Studio' });
const desk: Reader = { me: 'desktop', onHub: true, time: (iso) => timeOf(iso, NOW) };
const phone: Reader = { me: 'phone', onHub: false, time: (iso) => timeOf(iso, NOW) };

test('an open card says since when and until when, against the window\'s clock', () => {
  assert.equal(waiting(ask, NOW), 'waiting 2 min');
  assert.equal(waiting({ ...ask, created_at: at(0.2) }, NOW), 'just now');
  assert.equal(waiting({ ...ask, created_at: at(130) }, NOW), 'waiting 2 h');
  assert.equal(givesUp(ask, NOW), 'Gives up at 18:04');
  assert.match(givesUp({ ...ask, expires_at: new Date(2026, 10, 7, 9, 0).toISOString() }, NOW), /^Gives up at \w{3} 09:00$/);
});

test('the hub\'s words, their tokens filled by the window\'s rule', () => {
  const w = worded({ ...approve, machine: null }).words!;
  assert.equal(w.heading, 'Codex wants to run');
  assert.equal(fill(w.runLabel, w, desk), 'Run on this Mac');
  assert.equal(fill(w.runLabel, w, phone), 'Run on Studio');
  const closed = worded({ ...ask, state: 'answered', closed_at: at(0), answer: { choice: 0, option: 'Ship it', by: 'phone', at: at(0) } });
  const a = closed.words!.after!;
  assert.equal(fill(a.text, closed.words!, desk), 'You answered on your phone.');
  assert.equal(fill(a.text, closed.words!, phone), 'You answered here.');
  assert.equal(desk.time(a.at), '17:36');
  const ex = worded({ ...ask, state: 'expired', closed_at: at(0) }).words!;
  assert.equal(fill(ex.after!.text, ex, desk), 'Claude gave up waiting at 17:36.');
  // A drive's pane: the window's own name for it, else the hub's.
  const dr = worded({ ...ask, kind: 'drive', title: 'Let it type into "dev server" (pane pb)?', drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' } } } as HubCheckpoint).words!;
  assert.equal(fill(dr.drive!.title, dr, { ...desk, pane: 'Dev server' }), 'Let it type in Dev server?');
  assert.equal(fill(dr.drive!.title, dr, desk), 'Let it type in dev server?');
});

test('the guess follows the edited command at once, from the hub\'s rules', () => {
  const cp = worded({ ...approve, warning: 'Nothing here can go wrong' });
  const w = cp.words!;
  assert.deepEqual(warningsFor(cp, w, cp.command).map((x) => `${x.from}|${x.label} ${x.text}`), ['agent|Codex warns: Nothing here can go wrong', 'ravenry|Ravenry\'s guess: Publishing to npm can\'t be undone']);
  assert.deepEqual(warningsFor(cp, w, 'git push origin main').map((x) => x.from), ['agent']);
  assert.deepEqual(warningsFor(cp, w, 'git push --force origin main').map((x) => x.text), ['Nothing here can go wrong', 'A force push can\'t be undone']);
  const plain = worded(approve);
  assert.deepEqual(warningsFor(plain, plain.words!, 'npm test'), []);
});

test('the store asks the hub for the words a copy lacks, once per state, and keeps them for that state only', () => {
  const st = new Checkpoints();
  st.fromDaemon('/s1', ask, NOW);
  assert.equal(wordsOf(st.get('cask0001')!.cp), null, 'a daemon\'s copy has no words');
  const want = st.wordsWanted(NOW);
  assert.deepEqual(want.map((c) => c.id), ['cask0001']);
  assert.deepEqual(st.wordsWanted(NOW), [], 'asked once');
  // The hub answers: the card can be drawn.
  const w = worded(ask).words as CheckpointWords;
  assert.equal(st.setWords({ cask0001: w }), true);
  assert.equal(wordsOf(st.get('cask0001')!.cp)!.heading, 'Claude asks');
  // The daemon says it was answered: the open words stay but are not this state's, so they are asked for.
  st.fromDaemon('/s1', { ...ask, state: 'answered', answer: { choice: 0, option: 'Ship it', by: 'desktop', at: at(0) }, closed_at: at(0) }, NOW);
  assert.equal(wordsOf(st.get('cask0001')!.cp), null);
  const again = st.wordsWanted(NOW);
  assert.equal(again[0].state, 'answered');
  // Words made for another state are not kept.
  assert.equal(st.setWords({ cask0001: w }), false);
  // The hub did not answer: asked again a little later, not at once.
  st.wordsFailed(again, NOW);
  assert.deepEqual(st.wordsWanted(NOW + 500), []);
  assert.equal(st.wordsWanted(NOW + 2500).length, 1);
  // The hub's copy carries its words: nothing to ask.
  const st2 = new Checkpoints();
  st2.fromHub([worded(approve)], NOW);
  assert.deepEqual(st2.wordsWanted(NOW), []);
  // What is sent to be worded carries no old words and never a secret.
  const typed = ['typed', 'value', 'not', 'sent'].join('-');
  const body = wordsBody([{ ...secret, state: 'answered', answer: { delivered: true, secret: typed } as never, words: w }]);
  assert.ok(!JSON.stringify(body).includes(typed));
  assert.equal((body.checkpoints[0] as HubCheckpoint).words, undefined);
});

test('edit then run, and refuse with a reason: the answer carries them', () => {
  assert.deepEqual(daemonAnswer('capp0001', { approve: true, command: 'npm publish --tag beta' }), { checkpoint: 'capp0001', by: 'desktop', approve: true, command: 'npm publish --tag beta' });
  assert.deepEqual(hubAnswer('capp0001', { approve: true, command: 'npm publish --tag beta' }), { id: 'capp0001', by: 'desktop', approve: true, command: 'npm publish --tag beta' });
  assert.deepEqual(hubAnswer('capp0001', { decline: true, reason: 'Run the tests first' }), { id: 'capp0001', by: 'desktop', decline: true, reason: 'Run the tests first' });
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

test('a card the person answered in the terminal instead leaves the panel at once', () => {
  const st = new Checkpoints();
  st.fromDaemon('/s1', ask, NOW);
  st.fromDaemon('/s1', { ...ask, state: 'cancelled', reason: 'the person answered you in the terminal instead: read their message there', answered_in: 'terminal', closed_at: at(0) } as typeof ask, NOW);
  assert.equal(st.get('cask0001')!.cp.state, 'cancelled');
  assert.equal(st.forPane('paaaaaaa', null, NOW), null);
  // A plain withdrawal still says how it ended.
  const st2 = new Checkpoints();
  st2.fromDaemon('/s1', ask, NOW);
  st2.fromDaemon('/s1', { ...ask, state: 'cancelled', reason: 'done by hand', closed_at: at(0) }, NOW);
  assert.equal(st2.forPane('paaaaaaa', null, NOW)!.cp.state, 'cancelled');
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
  assert.deepEqual(g[0].projects[0].rows[0].mark, { kind: 'ask', text: 'Ship the beta to the testers?', code: false, label: 'Checkpoint:', since: ask.created_at });
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
