// The phone's New session, Last conversation and Move to Ravenry without a
// page (hub/public/sessions-view.js): the rows drawn from GET
// /api/setup/start, the request sent, the time a conversation stopped.
// What each choice says is the hub's (hub/tools/phonesessions-test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: the board's module, plain JavaScript
import { fill, startState, projectRows, assistantCards, modelMenu, busyLine, goLabel, startBody, stoppedWhen, moveBody, target } from '../../../hub/public/sessions-view.js';
import en from '../../../shared/strings/en.json' with { type: 'json' };

const E = en as Record<string, string>;
const S = (k: string, v?: Record<string, string | number>) => fill(E[k] ?? k, v);
// The words GET /api/setup/start sends (hub/server/phonesessions.mjs startWords).
const W = {
  names: { claude: 'Claude Code', codex: 'Codex' }, signedIn: 'Signed in', notSignedIn: 'Not signed in', notFound: 'Not on your Mac', onMachine: E['start.onMachine'],
  go: E['start.goAssistant'], goOn: E['start.goAssistantOnly'], ownCopyB: E['start.ownCopyB'], ownCopy: E['start.ownCopy'], inFolderLink: E['start.inFolderLink'],
  inFolderB: E['start.inFolderB'], inFolder: E['start.inFolder'], ownCopyLink: E['start.ownCopyLink'],
};
const f = (name: string, extra: object = {}) => ({ name, path: `/Users/x/Projects/${name}`, short: `~/Projects/${name}`, projectId: name, ...extra });
const V = {
  folders: [f('paper-boat', { busy: { projectId: 'paper-boat', project: 'paper-boat', topic: 'Hull tilt' }, models: { claude: 'sonnet', codex: null } }), f('notes-app'), f('garden-planner'), f('kite')],
  all: [f('paper-boat'), f('notes-app'), f('garden-planner'), f('kite'), f('portfolio'), f('moss'), f('trail-map'), f('weather-widget')],
  assistants: [{ kind: 'claude', found: true, signedIn: true }, { kind: 'codex', found: true, signedIn: false }],
  machines: [{ name: 'devbox', up: true, projects: [{ name: 'recipe-box', path: '/srv/code/recipe-box', short: '~/recipe-box', projectId: 'recipe-box' }] }],
  models: { claude: [{ id: '', label: "Claude Code's default" }, { id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet' }], codex: [{ id: '', label: "Codex's default" }] },
};

test('New session opens on the project it was asked from, else the first folder; the signed-in assistant first', () => {
  assert.equal(startState(V, {}).folder, '/Users/x/Projects/paper-boat');
  assert.equal(startState(V, { folder: '/Users/x/Projects/moss' }).folder, '/Users/x/Projects/moss');
  assert.equal(startState(V, { folder: '/nowhere' }).folder, '/Users/x/Projects/paper-boat');
  assert.equal(startState({ ...V, assistants: [{ kind: 'claude', found: false }, { kind: 'codex', found: true, signedIn: true }] }, {}).assistant, 'codex');
});

test('three recent projects, then All projects with its count; the folder picked stays in sight', () => {
  const st = startState(V, {});
  const r = projectRows(V, st);
  assert.deepEqual(r.rows.map((x: { name: string }) => x.name), ['paper-boat', 'notes-app', 'garden-planner']);
  assert.equal(r.more, 8);
  assert.equal(r.rows[0].on, true);
  const all = projectRows(V, { ...st, showAll: true });
  assert.equal(all.rows.length, 8);
  assert.equal(all.more, 0);
  const moss = projectRows(V, { ...st, folder: '/Users/x/Projects/moss' });
  assert.deepEqual(moss.rows.map((x: { name: string }) => x.name), ['moss', 'paper-boat', 'notes-app']);
  // No All projects when every project is listed already.
  assert.equal(projectRows({ ...V, all: V.all.slice(0, 2) }, st).more, 0);
});

test('on a machine: its projects, the one picked with its path, or a folder typed there', () => {
  const st = { ...startState(V, {}), machine: 'devbox', machineFolder: '/srv/code/recipe-box' };
  const r = projectRows(V, st);
  assert.deepEqual(r.rows.map((x: { name: string; on: boolean }) => [x.name, x.on]), [['recipe-box', true]]);
  assert.deepEqual(target(V, st), { folder: '/srv/code/recipe-box', name: 'recipe-box', projectId: 'recipe-box' });
  assert.deepEqual(target(V, { ...st, typed: '/srv/code/scratch/' }), { folder: '/srv/code/scratch/', name: 'scratch' });
  assert.equal(goLabel(V, st, W), 'Start Claude Code on devbox');
  assert.deepEqual(assistantCards(V, st, W).map((c: { sub: string }) => c.sub), ['Runs on devbox', 'Runs on devbox']);
});

test('the assistant cards say signed in, not signed in, or not on the Mac', () => {
  const st = startState(V, {});
  const cards = assistantCards({ ...V, assistants: [{ kind: 'claude', found: true, signedIn: true }, { kind: 'codex', found: false }] }, st, W);
  assert.deepEqual(cards.map((c: { name: string; sub: string; ok: boolean; on: boolean }) => [c.name, c.sub, c.ok, c.on]), [['Claude Code', 'Signed in', true, true], ['Codex', 'Not on your Mac', false, false]]);
  assert.equal(assistantCards(V, st, W)[1].sub, 'Not signed in');
});

test('the cards follow the hub\'s list: a third assistant gets its card, its name from the list', () => {
  const st = startState(V, {});
  const three = { ...V, assistants: [...V.assistants, { kind: 'fake', name: 'Stand-in Agent', found: true, signedIn: true }] };
  const cards = assistantCards(three, st, W);
  assert.deepEqual(cards.map((c: { kind: string; name: string; ok: boolean }) => [c.kind, c.name, c.ok]), [['claude', 'Claude Code', true], ['codex', 'Codex', true], ['fake', 'Stand-in Agent', true]]);
  assert.equal(goLabel(three, { ...st, assistant: 'fake' }, { ...W, names: { ...W.names, fake: 'Stand-in Agent' } }), 'Start Stand-in Agent in paper-boat');
  assert.equal(modelMenu(three, { ...st, assistant: 'fake' }).menu.length, 0);
  // An older hub that sends none: Claude Code and Codex, not found.
  assert.deepEqual(assistantCards({ ...V, assistants: [] }, st, W).map((c: { kind: string; ok: boolean }) => [c.kind, c.ok]), [['claude', false], ['codex', false]]);
});

test('the Model menu is the assistant\'s, the folder\'s remembered model picked until the person picks', () => {
  const st = startState(V, {});
  assert.equal(modelMenu(V, st).picked, 'sonnet');
  assert.equal(modelMenu(V, { ...st, model: 'opus' }).picked, 'opus');
  assert.equal(modelMenu(V, { ...st, assistant: 'codex' }).menu.length, 1);
});

test('another session works there: its own copy, or in the folder when asked', () => {
  const st = startState(V, {});
  const b = busyLine(V, st, W);
  assert.equal(b.bold + b.rest, 'It gets its own copy of the code, on a new branch, because Hull tilt is already working in paper-boat. You review and merge it when it\'s done.');
  assert.equal(b.link, 'Work in the folder instead');
  assert.equal(busyLine(V, { ...st, inFolder: true }, W).worktree, false);
  assert.equal(busyLine(V, { ...st, folder: '/Users/x/Projects/notes-app' }, W), null);
});

test('Start sends the folder, the assistant, the model, the project, the words and worktree', () => {
  const st = { ...startState(V, {}), model: 'opus', text: '  Make the rain fall  ' };
  assert.equal(goLabel(V, st, W), 'Start Claude Code in paper-boat');
  assert.deepEqual(startBody(V, st).body, { folder: '/Users/x/Projects/paper-boat', assistant: 'claude', projectId: 'paper-boat', worktree: true, model: 'opus', text: 'Make the rain fall' });
  assert.equal(startBody(V, { ...st, inFolder: true }).body.worktree, undefined);
  // The default model is sent as '' once picked, so the hub remembers it; never sent when the menu has none.
  assert.equal(startBody(V, { ...st, model: '' }).body.model, '');
  assert.equal('model' in startBody({ ...V, models: {} }, st).body, false);
  const dev = { ...st, machine: 'devbox', machineFolder: '/srv/code/recipe-box', model: null, text: '' };
  assert.deepEqual(startBody(V, dev).body, { folder: '/srv/code/recipe-box', assistant: 'claude', machine: 'devbox', projectId: 'recipe-box' });
  assert.deepEqual(startBody(V, { ...st, folder: null }), { error: 'noProject' });
});

test('when a conversation stopped, against the phone\'s clock', () => {
  const now = new Date(2026, 10, 21, 15, 30).getTime();
  assert.equal(stoppedWhen(new Date(now - 20 * 60000).toISOString(), S, now), '20 min ago');
  assert.equal(stoppedWhen(new Date(now - 30000).toISOString(), S, now), 'just now');
  assert.equal(stoppedWhen(new Date(2026, 10, 21, 9, 5).toISOString(), S, now), 'at 9:05 AM');
  assert.equal(stoppedWhen(new Date(2026, 10, 20, 18, 40).toISOString(), S, now), 'yesterday at 6:40 PM');
  assert.equal(stoppedWhen(new Date(2026, 10, 17, 12, 0).toISOString(), S, now), 'on Tue at 12:00 PM');
  assert.equal(stoppedWhen(new Date(2026, 10, 2, 8, 0).toISOString(), S, now), 'on Nov 2');
  assert.equal(stoppedWhen(null, S, now), '');
  assert.equal(fill(E['project.stoppedAt'], { when: 'yesterday at 6:40 PM' }), 'Stopped yesterday at 6:40 PM');
});

test('Move to Ravenry and Keep it there send the session and which copy stays', () => {
  assert.deepEqual(moveBody('notes-app', 'c3c3', 'ravenry'), { projectId: 'notes-app', sessionId: 'c3c3', keep: 'ravenry' });
  assert.deepEqual(moveBody('notes-app', 'c3c3', 'outside'), { projectId: 'notes-app', sessionId: 'c3c3', keep: 'outside' });
  assert.equal(moveBody('p', 's', 'anything').keep, 'ravenry');
});

test('the + menu\'s and the page\'s own words are in the shared strings', () => {
  for (const k of ['pstart.plus', 'pstart.menuSession', 'pstart.menuSessionSub', 'pstart.menuProject', 'pstart.menuProjectSub', 'pstart.button', 'pstart.loading', 'pstart.noProject', 'psess.moving', 'psess.minAgo', 'psess.justNow', 'psess.todayAt', 'psess.yesterdayAt', 'psess.dayAt', 'psess.onDate']) assert.ok(E[k], k);
  assert.equal(S('pstart.menuSessionSub'), 'Claude Code or Codex, in a project');
});
