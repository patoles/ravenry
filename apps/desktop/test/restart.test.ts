// Resume after a restart (SESS-053): the card the window draws in its
// middle from the hub's state.restart (src/renderer/restart.ts), the calls
// its clicks make, and what follows each state (tabs, the front, the toast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actOf, cardHtml, cardShows, postFor, restartOf, RestartFollow } from '../src/renderer/restart.ts';
import type { RestartCard, RestartRow, RestartRowState } from '../src/renderer/restart.ts';

const NOTE = 'It stopped in the middle of a turn. Resuming opens the conversation where it was; it does not run that turn again. Tell it to go on.';
const SIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];

function row(i: number, state: RestartRowState = 'waiting'): RestartRow {
  const base = [
    { project: 'paper-boat', topic: 'Tilting the hull', chip: 'Claude Opus 5.5', ran: 'Ran 2 h 10 min', doing: 'Was working: rendering the tilt frames', midTurn: true },
    { project: 'notes-app', topic: 'Sync settings', chip: 'Claude Opus 5.5', ran: 'Ran 45 min', doing: 'At its prompt', midTurn: false },
    { project: 'harbour-light', topic: 'Run the tests before the commit', chip: 'Codex gpt-5.4', ran: 'Ran 1 h 20 min', doing: 'At its prompt', midTurn: false },
    { project: 'garden-planner', topic: 'Planting reminders', chip: 'Claude Opus 5.5', ran: 'Ran 25 min', doing: 'At its prompt', midTurn: false },
  ][i];
  const pane = state === 'back' ? `pabcdef${i + 2}` : null;
  return {
    sessionId: SIDS[i], projectId: `proj-${i}`, ...base, assistant: i === 2 ? 'codex' : 'claude', model: null,
    midTurnTag: base.midTurn ? 'Mid-turn' : null, midTurnNote: base.midTurn ? NOTE : null,
    state, stateWord: state === 'resuming' ? 'Resuming...' : state === 'next' ? 'Next' : state === 'back' ? 'Back' : null,
    error: state === 'failed' ? 'It did not resume.' : null,
    pane, surfaceId: pane ? `ravenry:${pane}` : null,
  };
}

function card(states: RestartRowState[] = ['waiting', 'waiting', 'waiting', 'waiting']): RestartCard {
  const rows = states.map((s, i) => row(i, s));
  const back = rows.filter((r) => r.state === 'back').length;
  const running = states.some((s) => s === 'resuming' || s === 'next');
  const phase = back === rows.length ? 'done' : running ? 'resuming' : 'offer';
  return {
    id: '1732170000', phase, count: rows.length, back,
    title: '4 sessions were running before the restart',
    body: 'This Mac restarted at 9:12 and they stopped. Each one picks up its conversation in its own folder, with its own assistant.',
    rows, resume: 'Resume', show: 'Show',
    resumeAll: running ? `Resuming ${back + 1} of 4...` : 'Resume all 4', resumeAllBusy: running,
    dismiss: 'Dismiss', dismissNote: 'Dismiss keeps them in Recently closed on the Sessions page, each with Reopen.',
    toast: phase === 'done' ? 'All 4 sessions are back.' : null,
  };
}

/** The card's rows, as their HTML pieces, in order. */
const rowsOf = (html: string): string[] => html.split('<div class="rc-row ').slice(1);
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the offer card: title, body, the four rows in order with their chip, time and doing line', () => {
  const html = cardHtml(card());
  assert.match(html, /<h2>4 sessions were running before the restart<\/h2>/);
  assert.match(html, /This Mac restarted at 9:12 and they stopped\./);
  const rows = rowsOf(html);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => /<span class="rc-pj">([^<]+)</.exec(r)![1]), ['paper-boat', 'notes-app', 'harbour-light', 'garden-planner']);
  assert.match(text(rows[0]), /paper-boat Tilting the hull Mid-turn Resume Claude Opus 5\.5 Ran 2 h 10 min · Was working: rendering the tilt frames/);
  assert.match(text(rows[2]), /harbour-light Run the tests before the commit Resume Codex gpt-5\.4 Ran 1 h 20 min · At its prompt/);
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, 'no em dash');
});

test('the offer card: the Mid-turn tag and its note on the mid-turn row only', () => {
  const rows = rowsOf(cardHtml(card()));
  assert.match(rows[0], /<span class="rc-tag">Mid-turn<\/span>/);
  assert.match(rows[0], /class="rc-note"/);
  assert.ok(rows[0].includes('It stopped in the middle of a turn.'));
  for (const r of rows.slice(1)) { assert.doesNotMatch(r, /rc-tag|rc-note/); }
});

test('the offer card: a Resume per row, Resume all 4, Dismiss and its note', () => {
  const html = cardHtml(card());
  const ones = [...html.matchAll(/data-act="resume" data-sid="([^"]+)"[^>]*>Resume</g)].map((m) => m[1]);
  assert.deepEqual(ones, SIDS);
  assert.match(html, /<button class="btn pri rc-all" data-act="resume-all">Resume all 4<\/button>/);
  assert.match(html, /<button class="btn rc-dis" data-act="dismiss">Dismiss<\/button>/);
  assert.match(html, /<span class="rc-fn">Dismiss keeps them in Recently closed on the Sessions page, each with Reopen\.<\/span>/);
  assert.equal(cardShows(card()), true);
});

test('the resuming card: Back with Show, Resuming..., Next, and the busy Resume all', () => {
  const c = card(['back', 'resuming', 'next', 'next']);
  assert.equal(c.phase, 'resuming');
  const html = cardHtml(c);
  const rows = rowsOf(html);
  assert.match(rows[0], /class="rc-st ok"><svg[^]*<\/svg>Back<\/span><button class="rc-lk" data-act="show" data-sid="11111111-[^"]+"[^>]*>Show<\/button>/);
  assert.doesNotMatch(rows[0], /rc-note/, 'the note only while it waits');
  assert.match(rows[1], /class="rc-st run"><svg class="rc-spin"[^]*<\/svg>Resuming\.\.\.<\/span>/);
  assert.match(rows[2], /class="rc-st q">Next<\/span>/);
  assert.match(rows[3], /class="rc-st q">Next<\/span>/);
  for (const r of rows) assert.doesNotMatch(r, /data-act="resume"/);
  assert.match(html, /<button class="btn pri rc-all" data-act="resume-all" disabled><svg class="rc-spin"[^]*<\/svg>Resuming 2 of 4\.\.\.<\/button>/);
  assert.equal(cardShows(c), true);
});

test('a row that did not resume offers Resume again and says why', () => {
  const html = cardHtml(card(['failed', 'waiting', 'waiting', 'waiting']));
  const r0 = rowsOf(html)[0];
  assert.match(r0, /data-act="resume" data-sid="11111111-[^"]+"[^>]*>Resume</);
  assert.match(r0, /<div class="rc-err">It did not resume\.<\/div>/);
  assert.doesNotMatch(r0, /rc-note/);
});

test('the words are escaped', () => {
  const c = card();
  c.rows[1].topic = '<b>Sync</b> & "settings"';
  const html = cardHtml(c);
  assert.ok(html.includes('&lt;b&gt;Sync&lt;/b&gt; &amp; &quot;settings&quot;'));
  assert.equal(html.includes('<b>Sync</b>'), false);
});

test('the card comes from the state, and none is drawn once all are back', () => {
  assert.equal(restartOf({ projects: [] }), null);
  assert.equal(restartOf({ restart: null }), null);
  assert.equal(restartOf({ restart: { id: 'x', rows: [] } }), null);
  const c = card();
  assert.equal(restartOf({ restart: c }), c);
  const done = card(['back', 'back', 'back', 'back']);
  assert.equal(done.phase, 'done');
  assert.equal(cardShows(done), false);
  assert.equal(cardShows(null), false);
});

test('clicks post the right bodies to the right routes', () => {
  const size = { cols: 120, rows: 40 };
  const html = cardHtml(card());
  const acts = [...html.matchAll(/data-act="([^"]+)"(?: data-sid="([^"]+)")?/g)].map((m) => actOf(m[1], m[2]));
  assert.deepEqual(acts.map((a) => postFor(a!, size)), [
    ...SIDS.map((sid) => ({ path: '/api/restart/resume', body: { sessionId: sid, cols: 120, rows: 40 } })),
    { path: '/api/restart/resume', body: { cols: 120, rows: 40 } },
    { path: '/api/restart/dismiss', body: {} },
  ]);
  const show = actOf('show', SIDS[0]);
  assert.deepEqual(show, { act: 'show', sessionId: SIDS[0] });
  assert.equal(postFor(show!, size), null, 'Show posts nothing: it brings the tab to the front');
  assert.equal(actOf('resume', null), null);
  assert.equal(actOf('nothing', SIDS[0]), null);
});

test('each session that comes back opens as a tab once; when all are back the first is in front and the toast is said once', () => {
  const f = new RestartFollow();
  assert.deepEqual(f.step(card()), { open: [], front: null, toast: null });
  const s1 = f.step(card(['back', 'resuming', 'next', 'next']));
  assert.deepEqual(s1.open, [{ sessionId: SIDS[0], key: 'proj-0/ravenry:pabcdef2', pane: 'pabcdef2' }]);
  assert.equal(s1.front, null);
  assert.equal(s1.toast, null);
  // The same state again: nothing new (a tab the person closed stays closed).
  assert.deepEqual(f.step(card(['back', 'resuming', 'next', 'next'])), { open: [], front: null, toast: null });
  const s2 = f.step(card(['back', 'back', 'back', 'resuming']));
  assert.deepEqual(s2.open.map((b) => b.sessionId), [SIDS[1], SIDS[2]]);
  const done = f.step(card(['back', 'back', 'back', 'back']));
  assert.deepEqual(done.open.map((b) => b.sessionId), [SIDS[3]]);
  assert.deepEqual(done.front, { sessionId: SIDS[0], key: 'proj-0/ravenry:pabcdef2', pane: 'pabcdef2' });
  assert.equal(done.toast, 'All 4 sessions are back.');
  assert.deepEqual(f.step(card(['back', 'back', 'back', 'back'])), { open: [], front: null, toast: null }, 'the toast once per card');
  assert.deepEqual(f.step(null), { open: [], front: null, toast: null });
});

test('a card already done when the window first sees it says nothing and moves nothing', () => {
  const f = new RestartFollow();
  assert.deepEqual(f.step(card(['back', 'back', 'back', 'back'])), { open: [], front: null, toast: null });
});
