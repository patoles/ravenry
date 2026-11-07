#!/usr/bin/env node
// A session ended in one place may run on in another (server/events.mjs
// outlivedEnds): Move here's "Keep it in cmux" ends the Ravenry copy while
// the cmux one runs on. The release check's session A left the board so.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { summarize, outlivedEnds } from '../server/events.mjs';

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); if (!ok) fails++; };
const SA = '5e55107e-0000-4000-8000-0000000000a1';
const SB = '5e55107e-0000-4000-8000-0000000000b2';
const at = (s) => new Date(Date.UTC(2026, 10, 7, 21, 0, s)).toISOString();
// A in cmux first (pid 100), then a Ravenry copy (pid 200) that ended.
const events = [
  { at: at(0), event: 'SessionStart', session_id: SA, claude_pid: 100, terminal: 'cmux', surface_id: 'BBBB2222-0000-4000-8000-0000000000A1' },
  { at: at(5), event: 'Stop', session_id: SA, claude_pid: 100, terminal: 'cmux', surface_id: 'BBBB2222-0000-4000-8000-0000000000A1' },
  { at: at(10), event: 'SessionStart', session_id: SA, claude_pid: 200, terminal: 'ravenry', terminal_id: 'ppppaaaa', pane: 'ppppaaaa' },
  { at: at(15), event: 'Stop', session_id: SA, claude_pid: 200, terminal: 'ravenry', terminal_id: 'ppppaaaa', pane: 'ppppaaaa' },
  { at: at(20), event: 'SessionEnd', session_id: SA, claude_pid: 200, terminal: 'ravenry', terminal_id: 'ppppaaaa', reason: 'pane_exited' },
];
// (The cmux copy also reports: its events after the Ravenry copy's start
// leave pid 100 as the session's last known pid; the end is still the
// Ravenry copy's own.)
events.splice(4, 0, { at: at(18), event: 'Stop', session_id: SA, claude_pid: 100, terminal: 'cmux', surface_id: 'BBBB2222-0000-4000-8000-0000000000A1' });
const cmuxProc = { pid: 100, startedAt: at(-5), argvSession: SA, surfaceId: 'BBBB2222-0000-4000-8000-0000000000A1', workspaceId: 'AAAA1111-0000-4000-8000-0000000000AA' };

let all = new Map([[SA, summarize(SA, events)]]);
check('the Ravenry copy\'s SessionEnd ends A as the events read', !!all.get(SA).endedAt);
let moved = outlivedEnds(all, [cmuxProc]);
const a = all.get(SA);
check('with its cmux process alive, A is not ended: it runs on in cmux, at rest', moved.length === 1 && !a.endedAt && a.terminal === 'cmux' && a.surfaceId === cmuxProc.surfaceId && a.pid === 100 && a.last && a.last.event === 'Stop', { moved, a: { endedAt: a.endedAt, terminal: a.terminal, surfaceId: a.surfaceId, pid: a.pid, last: a.last && a.last.event } });

all = new Map([[SA, summarize(SA, events)]]);
check('with no process left for it, A stays ended', outlivedEnds(all, []).length === 0 && !!all.get(SA).endedAt);

all = new Map([[SA, summarize(SA, events)]]);
check('the copy that ended is not a reason (its own pid)', outlivedEnds(all, [{ ...cmuxProc, pid: 200, surfaceId: null }]).length === 0 && !!all.get(SA).endedAt);

// A process launched for A that has since become B (a /clear): A stays ended.
all = new Map([[SA, summarize(SA, events)], [SB, summarize(SB, [{ at: at(30), event: 'SessionStart', session_id: SB, claude_pid: 100, terminal: 'cmux', source: 'clear' }])]]);
check('a process launched for A that reported as another session since does not revive A', outlivedEnds(all, [cmuxProc]).length === 0 && !!all.get(SA).endedAt);

// The other way round, the board's own case: the cmux copy ended and the
// Ravenry pane's copy runs on. Not revived here (the pane says the
// conversation went on in cmux: tools/outside-terminal-test.mjs).
all = new Map([[SA, summarize(SA, events)]]);
check('a copy in a Ravenry pane is left to the board (not revived here)', outlivedEnds(all, [{ pid: 300, startedAt: at(-5), argvSession: SA, ravenryId: 'pqqqrrrr' }]).length === 0 && !!all.get(SA).endedAt);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
