#!/usr/bin/env node
// The sidebar the hub sends ready to draw (server/sidebar.mjs): its
// sections, rows, order and counts, and the marks open checkpoints and
// worktree reviews put on rows. Pure functions on crafted state; no hub.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { build, marksOf, sessionGroup, withGroups, paneOf } from '../server/sidebar.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const NOW = Date.parse('2026-11-06T12:00:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const sess = (surfaceId, state, extra = {}) => ({ surfaceId, state, topic: surfaceId, assistant: 'claude', ...extra });
const proj = (id, state, sessions, extra = {}) => ({ id, name: id, state, sessions, primary: sessions[0] ? sessions[0].surfaceId : null, ...extra });

const PROJECTS = [
  proj('old-ask', 'you', [sess('s1', 'asked', { since: at(30), words: { line: 'Keep  the\nold format?' }, ctx: { tokens: 100000, window: 1000000, pct: 10 } })], { since: at(30) }),
  proj('new-ask', 'you', [sess('s2', 'dialog', { words: { question: 'Allow it?' } }), sess('s2b', 'working')], { since: at(2) }),
  proj('busy', 'work', [sess('s3', 'working', { ctx: { tokens: 584000, window: 1000000, pct: 58.4 } }), sess('s3b', 'working'), sess('s3c', 'idle')]),
  proj('gate', 'you', [sess('s4', 'idle')], { since: at(5), primary: 's4' }),
  proj('quiet', 'idle', [sess('s5', 'stale')], { since: at(60 * 72), machine: 'devbox' }),
  proj('waiting', 'wait', [sess('s6', 'idle')], { since: at(10), waitingOn: 'design' }),
];

{
  const b = build(PROJECTS, { threshold: 50, now: NOW });
  const S = b.sections;
  check('sections in order', eq(S.map((g) => g.title), ['Needs you', 'Working', 'Waiting on others', 'Idle']));
  check('Needs you: newest first', eq(S[0].projects.map((p) => p.id), ['new-ask', 'gate', 'old-ask']));
  check('Working: a project at work, then another project\'s working session', eq(S[1].projects.map((p) => p.id), ['busy', 'new-ask']));
  check('Idle: an idle session of a project at work, then an idle project', eq(S[3].projects.map((p) => p.id), ['busy', 'quiet']));
  check('counts per section', eq(S.map((g) => g.count), [3, 3, 1, 2]) && eq(b.counts, { you: 3, work: 3, wait: 1, idle: 2 }));
  check('each session in the section of its own state', eq(S[0].projects[0].rows.map((r) => r.key), ['new-ask/s2']) && eq(S[1].projects.map((p) => p.rows.map((r) => r.key)), [['busy/s3', 'busy/s3b'], ['new-ask/s2b']]));
  check('a plan gate shows its main session', eq(S[0].projects[1].rows.map((r) => r.key), ['gate/s4']));
  check('waiting on others shows its main session', eq(S[2].projects[0].rows.map((r) => r.key), ['waiting/s6']));
  check('the question on one line', S[0].projects[0].rows[0].line === 'Allow it?' && S[0].projects[2].rows[0].line === 'Keep the old format?');
  const r = S[1].projects[0].rows[0];
  check('context and its warning', r.pct === 58 && r.pctWarn === true && r.assistant === 'Claude' && r.group === 'work');
  check('times: clock for Needs you, ago for Working', S[0].projects[2].time.style === 'clock' && S[0].projects[2].time.at === at(30) && S[1].projects[0].time.style === 'ago' && S[1].projects[0].time.at === null);
  const q = S[3].projects[1];
  check('an idle project is one line, with its machine', q.rows.length === 0 && q.machine === 'devbox' && q.time.style === 'ago' && q.time.at === at(60 * 72));
  check('JSON round trip', eq(JSON.parse(JSON.stringify(b)), b));
}

{
  // An open checkpoint on a working session's pane: it needs you, its time is when it asked.
  const projects = [proj('w', 'work', [sess('ravenry:pabcdefg', 'working'), sess('other', 'working')], { since: at(50) })];
  const cps = [
    { id: 'c2', kind: 'secret', state: 'open', title: 'Mail service API key\nFor sending', created_at: at(3), pane: 'pabcdefg', machine: null },
    { id: 'c1', kind: 'approve', state: 'running', command: 'npm publish\n--tag x', created_at: at(4), projectId: 'w', surfaceId: 'ravenry:pabcdefg' },
    { id: 'c3', kind: 'ask', state: 'answered', title: 'Old', created_at: at(9), projectId: 'w', surfaceId: 'other' },
    { id: 'c4', kind: 'drive', state: 'open', title: 'Let Claude type', drive: { pane: 'pzzzzzzz', action: 'close', name: 'dev server' }, created_at: at(1), projectId: 'w', surfaceId: 'other' },
  ];
  const marks = marksOf(projects, cps, { now: NOW });
  check('the oldest open checkpoint marks its session; closed ones do not', marks.get('w/ravenry:pabcdefg')?.kind === 'approve' && marks.get('w/ravenry:pabcdefg')?.text === 'npm publish' && marks.get('w/ravenry:pabcdefg')?.code === true);
  check('a drive names the pane it acts on', marks.get('w/other')?.text === 'Wants to close dev server');
  const b = build(projects, { marks, now: NOW });
  check('marked sessions need you, their time is the first ask', b.sections[0].group === 'you' && b.sections[0].count === 2 && b.sections[0].projects[0].time.at === at(4) && b.sections[0].projects[0].time.style === 'clock');
  check('a marked row shows its mark, not its line', b.sections[0].projects[0].rows[0].mark.since === at(4) && b.sections[0].projects[0].rows[0].line === null && b.sections[0].projects[0].rows[0].group === 'you');
  // A secret by pane only.
  const m2 = marksOf(projects, [cps[0]], { now: NOW });
  check('by pane when the hub could not tell the session; a secret says what it wants', m2.get('w/ravenry:pabcdefg')?.text === 'Wants the mail service API key');
  const m3 = marksOf(projects, [{ ...cps[0], machine: 'gpu' }], { now: NOW });
  check('a pane on another machine is not this one', m3.size === 0);
}

{
  // A worktree session done with files to review; a checkpoint wins over it.
  const projects = [proj('t', 'idle', [sess('a', 'idle', { since: at(6), worktree: { state: 'open' } }), sess('b', 'idle', { worktree: { state: 'open' } })])];
  const marks = marksOf(projects, [{ id: 'x', kind: 'ask', state: 'open', title: 'Which one?\nmore', created_at: at(2), projectId: 't', surfaceId: 'b' }], { reviewFiles: () => 3, now: NOW });
  check('review mark', eq(marks.get('t/a'), { kind: 'review', text: 'Done. 3 files to review', code: false, since: at(6) }));
  check('a checkpoint wins over a review', marks.get('t/b')?.kind === 'ask' && marks.get('t/b')?.text === 'Which one?');
  const b = build(projects, { marks, now: NOW });
  check('an idle project with a marked session is in Needs you', b.sections.length === 1 && b.sections[0].group === 'you' && b.sections[0].count === 2);
}

check('session groups', sessionGroup(sess('a', 'handback')) === 'you' && sessionGroup(sess('a', 'working')) === 'work' && sessionGroup(sess('a', 'handed')) === 'idle' && sessionGroup(sess('a', 'x', { words: { state: 'wait' } })) === 'wait');
check('each session carries its group', withGroups([proj('a', 'work', [sess('x', 'working')])])[0].sessions[0].group === 'work');
check('panes', paneOf(sess('ravenry:pk3m7q2x', 'working')) === 'pk3m7q2x' && paneOf(sess('ravenry:nope', 'working')) === null && paneOf(sess('a', 'w', { pane: { id: 'pq' } })) === 'pq');
check('an empty board', eq(build([], {}), { sections: [], counts: { you: 0, work: 0, wait: 0, idle: 0 } }));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
