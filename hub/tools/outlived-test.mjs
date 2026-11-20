#!/usr/bin/env node
// A session ended in one place may run on in another (server/events.mjs
// outlivedEnds): Move here's "Keep it in cmux" ends the Ravenry copy while
// the cmux one runs on. The release check's session A left the board so.
// And the other way: Move here ends the copy in cmux, then resumes it in a
// Ravenry pane, whose hooks report through its daemon. That copy's state is
// the session's, never the cmux copy's SessionEnd (2026-11-20: a session
// moved into a pane worked all day while the board said it had ended).
import { GUARD_HOME } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { summarize, outlivedEnds, ingestDaemon, scan } from '../server/events.mjs';
import { recordOf } from '../server/ravenryd.mjs';
import { eventState, sessionState } from '../server/state.mjs';
import { DEFAULT_SETTINGS } from '../server/registry.mjs';

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

// ------------------------------------------------------------ Move here into a pane
// The copy in cmux (pid 2814) works, then Move here ends it (its SessionEnd
// on disk) and resumes the session in pane pmovedaa (pid 7278). The pane's
// hooks run `ravenryd hook`, so its events reach the board only as the
// daemon's reports (server/ravenryd.mjs recordOf, events.ingestDaemon):
// its start, a prompt, and then one PostToolUse per tool call, hundreds in
// a long turn.
const SM = '5e55107e-0000-4000-8000-0000000000c3';
const PANE = 'pmovedaa';
const t0 = Date.parse('2026-11-20T00:20:00.000Z');
const ts = (s) => new Date(t0 + s * 1000).toISOString();
const SF = 'CCCC3333-0000-4000-8000-0000000000C3';
const EVD = path.join(GUARD_HOME, 'events');
fs.rmSync(EVD, { recursive: true, force: true });
fs.mkdirSync(EVD, { recursive: true });
const cmuxLine = (event, s, extra = {}) => JSON.stringify({ at: ts(s), event, session_id: SM, assistant: 'claude', cwd: '/x/kite', claude_pid: 2814, terminal: 'cmux', surface_id: SF, ...extra });
fs.writeFileSync(path.join(EVD, SM + '.jsonl'), [
  cmuxLine('SessionStart', 0, { source: 'startup' }),
  cmuxLine('UserPromptSubmit', 10),
  cmuxLine('Stop', 30, { background_tasks: 0 }),
  cmuxLine('SessionEnd', 268, { reason: 'other' }),
].join('\n') + '\n');
const report = (hook, s, extra = {}) => ({ source: 'hook', pane: PANE, assistant: 'claude', at: ts(s), pid: 7278, data: { hook_event_name: hook, session_id: SM, cwd: '/x/kite', ...extra } });
const take = (rep) => { const r = recordOf(rep); if (r) ingestDaemon(r); return r; };
take(report('SessionStart', 278, { source: 'resume' }));
take(report('UserPromptSubmit', 300));
for (let i = 0; i < 640; i++) take(report('PostToolUse', 301 + i * 0.5, { tool_name: 'Read' }));
const settings = DEFAULT_SETTINGS;
const nowM = t0 + 700 * 1000;
let sm = scan().get(SM);
check('moved into a pane: the cmux copy\'s SessionEnd does not end the session', !!sm && !sm.endedAt, sm && { endedAt: sm.endedAt });
check('moved into a pane: 640 tool calls later, its last state event is still the pane copy\'s prompt', !!sm && !!sm.last && sm.last.event === 'UserPromptSubmit' && sm.last.terminal_id === PANE, sm && sm.last && { event: sm.last.event, at: sm.last.at });
let stm = eventState({ ev: sm, screen: { readable: false }, screenAt: null, title: {}, transcript: null }, settings, nowM);
check('moved into a pane: the board says working, from the pane copy', !!stm && stm.state === 'working', stm);
check('moved into a pane: the session is in its pane, by the pane copy\'s process', !!sm && sm.terminal === 'ravenry' && sm.terminalId === PANE && sm.pid === 7278, sm && { terminal: sm.terminal, terminalId: sm.terminalId, pid: sm.pid });
take(report('Stop', 960, { last_assistant_message: 'Done: the map loads.' }));
sm = scan().get(SM);
stm = eventState({ ev: sm, screen: { readable: false }, screenAt: null, title: {}, transcript: null }, settings, nowM + 60000);
check('moved into a pane: its Stop puts it at rest (handback), not ended', !!stm && stm.state === 'handback', stm);

// The hub restarted late: the daemon's reports no longer hold the pane
// copy's start or prompt, only its latest tool calls. Activity after the
// end still means the session runs on: not ended, and with no state event
// since, its screen decides (a pane's screen is always read).
const SR = '5e55107e-0000-4000-8000-0000000000d4';
fs.writeFileSync(path.join(EVD, SR + '.jsonl'), [
  cmuxLine('UserPromptSubmit', 10, { session_id: SR }),
  cmuxLine('Stop', 30, { session_id: SR }),
  cmuxLine('SessionEnd', 268, { session_id: SR, reason: 'other' }),
].join('\n') + '\n');
for (let i = 0; i < 5; i++) { const r = recordOf({ ...report('PostToolUse', 900 + i), data: { hook_event_name: 'PostToolUse', session_id: SR, cwd: '/x/kite', tool_name: 'Read' } }); ingestDaemon(r); }
const sr = scan().get(SR);
check('only tool calls left after the end: not ended, the end is not its state', !!sr && !sr.endedAt && !(sr.last && sr.last.event === 'SessionEnd'), sr && { endedAt: sr.endedAt, last: sr.last && sr.last.event });
const busyScreen = { readable: true, claudeLive: true, working: false, agentsRunning: 3 };
const str = eventState({ ev: sr, screen: busyScreen, screenAt: nowM, title: {}, transcript: null }, settings, nowM)
  || sessionState({ screen: busyScreen, title: {}, transcript: null, hook: null }, settings, nowM);
check('only tool calls left after the end: its screen (3 agents running) says working', str.state === 'working', str);

// No event from the pane copy at all (no hook reached the board): its
// process, started after the end, keeps the session going in its pane.
const SN = '5e55107e-0000-4000-8000-0000000000e5';
all = new Map([[SN, summarize(SN, [
  { at: ts(30), event: 'Stop', session_id: SN, claude_pid: 2814, terminal: 'cmux', surface_id: SF },
  { at: ts(268), event: 'SessionEnd', session_id: SN, claude_pid: 2814, terminal: 'cmux', surface_id: SF, reason: 'other' },
])]]);
moved = outlivedEnds(all, [{ pid: 7278, startedAt: ts(277), argvSession: SN, ravenryId: PANE }]);
const sn = all.get(SN);
check('moved into a pane, no event from it yet: its process there keeps it going in its pane, the screen to say what it does', moved.length === 1 && !sn.endedAt && sn.terminal === 'ravenry' && sn.terminalId === PANE && sn.pid === 7278 && sn.last === null && sn.surfaceId === null, { moved, terminal: sn.terminal, terminalId: sn.terminalId, last: sn.last && sn.last.event, surfaceId: sn.surfaceId });
all = new Map([[SN, summarize(SN, [{ at: ts(268), event: 'SessionEnd', session_id: SN, claude_pid: 2814, terminal: 'cmux', surface_id: SF, reason: 'other' }])]]);
check('a pane copy started before the end is still the board\'s own case (it went on elsewhere)', outlivedEnds(all, [{ pid: 7278, startedAt: ts(200), argvSession: SN, ravenryId: PANE }]).length === 0 && !!all.get(SN).endedAt);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
