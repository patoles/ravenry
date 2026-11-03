#!/usr/bin/env node
// The Sessions page rules (server/sessions.mjs, docs/SESSIONS.md) on crafted
// input: which processes count, how a process maps to a session, which group
// a session lands in, and the Recently closed records. Pure functions plus a
// throwaway RAVENRY_HOME under .tmp/; no ps, no cmux, no real session touched.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MC = fs.mkdtempSync(path.join(ROOT, '.tmp', 'sessions-test-'));
process.env.RAVENRY_HOME = MC;
const s = await import('../server/sessions.mjs');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// ---------------------------------------------------------------- processes
const ps = [
  `  101     1 665808 Sat Oct 24 00:52:52 2026     /Users/x/.local/bin/claude --settings {"hooks":{}} --resume ${A} --permission-mode auto`,
  `  102     1 400000 Mon Nov  2 19:41:45 2026     /Users/x/.local/bin/claude --session-id ${B} --settings {}`,
  '  103     1   9552 Wed Sep 30 18:58:37 2026     /Users/x/.local/bin/claude --chrome-native-host',
  '  104     1  50000 Wed Sep 30 18:58:37 2026     /Applications/Claude.app/Contents/MacOS/Claude',
  '  105     1  60000 Wed Sep 30 18:58:37 2026     node .local/tv-page.mjs /private/tmp/claude-501/x',
  `  106     1 300000 Wed Sep 30 18:58:37 2026     /Users/x/.local/bin/claude --resume ${A} --fork-session`,
].join('\n');
const procs = s.parsePs(ps);
check('only argv[0] named claude counts; the desktop app and node scripts do not', procs.map((p) => p.pid).join() === '101,102,103,106');
check('--chrome-native-host is a helper, not a session', procs.find((p) => p.pid === 103).kind === 'helper');
check('lstart with a one-digit day parses', procs.find((p) => p.pid === 102).startedAt === new Date('Mon Nov  2 19:41:45 2026').toISOString());
check('--resume <id> and --session-id <id> are read from argv', s.argvSession(procs[0].command) === A && s.argvSession(procs[1].command) === B);
check('a fork names its parent, so its argv id is not used', s.argvSession(procs[3].command) === null);

const env = s.parseEnv(`101 /x/claude --settings {"a":"CMUX_SURFACE_ID=not-a-uuid"} TERM=xterm CMUX_WORKSPACE_ID=95959595-0000-4000-8000-000000009595 CMUX_SURFACE_ID=1C1C1C1C-0000-4000-8000-000000001C1C HOME=/x\n102 /x/claude PATH=/bin`);
check('CMUX_SURFACE_ID comes from the environment', env.get(101).surfaceId === '1C1C1C1C-0000-4000-8000-000000001C1C' && env.get(101).workspaceId === '95959595-0000-4000-8000-000000009595');
check('a process outside cmux has no surface', env.get(102).surfaceId === null);
const cwd = s.parseLsof('p101\nfcwd\nn/Users/x/projects/paper\np102\nfcwd\nn/Users/x\n');
check('lsof cwd per pid', cwd.get(101) === '/Users/x/projects/paper' && cwd.get(102) === '/Users/x');

// ---------------------------------------------------------------- mapping
const p = { pid: 101, startedAt: '2026-10-24T00:00:00.000Z', surfaceId: 'SURF-1', argvSession: A };
const ev = (sid, pid, at, extra = {}) => [sid, { sessionId: sid, pid, pidAt: at, endedAt: null, ...extra }];
let m = s.mapProcess(p, { evAll: new Map([ev(B, 101, '2026-11-02T10:00:00.000Z')]), hooks: [], boardTab: null });
check('1. the hook pid wins over the launch argument (a /clear moved it on)', m.sessionId === B && m.method === 'hook events (pid)');
m = s.mapProcess(p, { evAll: new Map([ev(B, 101, '2026-10-01T10:00:00.000Z')]), hooks: [], boardTab: null });
check('a pid recorded before the process started is an older process, not this one', m.sessionId === A && m.method === 'launch argument');
m = s.mapProcess(p, { evAll: new Map(), hooks: [{ pid: 101, sessionId: B, pidAlive: true, updatedAt: '2026-11-01T00:00:00.000Z' }], boardTab: null });
check('2. cmux hook record by pid', m.sessionId === B && m.method === 'cmux hook record (pid)');
m = s.mapProcess(p, { evAll: new Map(), hooks: [], boardTab: new Map([['SURF-1', { sessionId: B, method: 'cmux resume binding' }]]) });
check('3. the board\'s mapping of its tab', m.sessionId === B && m.method === 'its tab (cmux resume binding)');
m = s.mapProcess(p, { evAll: new Map(), hooks: [], boardTab: new Map([['SURF-1', { sessionId: B, method: 'newest transcript in the folder (guess)' }]]) });
check('a guessed tab mapping is not used', m.sessionId === A && m.method === 'launch argument');
m = s.mapProcess({ ...p, argvSession: null }, { evAll: new Map(), hooks: [], boardTab: null });
check('nothing names it: unmapped, never guessed', m === null);

// ---------------------------------------------------------------- the rules
const H = 3600000;
const now = Date.parse('2026-11-03T00:00:00.000Z');
const ago = (h) => new Date(now - h * H).toISOString();
const rest = { st: { state: 'stale' }, t: { lastActivityAt: ago(48), lastText: 'Pushed the wave tuning. Nothing else open.' }, ev: null, marker: null, screen: { readable: true, claudeLive: true } };
const g = (x) => s.classify({ ...rest, ...x }, 24 * H, now);
check('no activity for 24 h: idle', g({}).group === 'idle');
check('active 2 h ago: in use', g({ t: { ...rest.t, lastActivityAt: ago(2) } }).group === 'use');
check('a hook event 2 h ago counts as activity', g({ ev: { lastEventAt: ago(2), last: { event: 'Stop' } } }).group === 'use');
check('working: in use', g({ st: { state: 'working' } }).group === 'use');
check('a dialog open: in use', g({ st: { state: 'dialog' } }).group === 'use');
check('background tasks at the last Stop: in use', g({ ev: { lastEventAt: ago(30), last: { event: 'Stop', background_tasks: 2 }, lastStop: { background_tasks: 2 } } }).group === 'use');
check('a scheduled loop: in use', g({ ev: { lastEventAt: ago(30), last: { event: 'Stop' }, lastStop: { crons: 1 } } }).group === 'use');
check('agents running on screen: in use', g({ screen: { readable: true, claudeLive: true, agentsRunning: 1 } }).group === 'use');
const asked = g({ t: { ...rest.t, lastText: 'Done.\n\nShould the sky use real star positions?' } });
check('ends on a question: left for you, tagged', asked.group === 'left' && asked.tag === 'asked' && asked.question === 'Should the sky use real star positions?');
const draft = g({ screen: { readable: true, claudeLive: true, draft: 'yes but' } });
check('half-typed reply: left for you, tagged', draft.group === 'left' && draft.tag === 'draft');
const handed = g({ t: { ...rest.t, lastActivityAt: ago(1) }, marker: { state: 'resumed', writtenAt: ago(1) } });
check('handed off 1 h ago: listed at any age', handed.group === 'handed');
check('handed off but working: in use', g({ st: { state: 'working' }, marker: { state: 'written' } }).group === 'use');
check('a test override makes 1 minute idle', s.classify({ ...rest, t: { ...rest.t, lastActivityAt: ago(0.05) } }, 60000, now).group === 'idle');
check('overrides parse only "<uuid>=<minutes>"', s.idleOverrides(`${A}=1,junk,${B}=x`).get(A) === 60000 && s.idleOverrides(`${A}=1,junk`).size === 1);
check('MC_CLOSE_ALLOW unset: no allowlist', s.closeAllow('') === null && s.closeAllow(A).has(A));
check('the last line is the last paragraph', s.lastLine({ t: rest.t, cls: g({}) }) === 'Pushed the wave tuning. Nothing else open.');
check('a folder outside every project is shortened', s.folderLabel('/private/tmp/a/b/clips') === '/.../b/clips');

// ---------------------------------------------------------------- records
s.writeClosed({ id: A, cwd: '/x', label: 'Shooter', memKb: 650000, closedAt: new Date().toISOString() });
s.writeClosed({ id: B, cwd: '/y', label: 'Old', memKb: 1, closedAt: new Date(Date.now() - 15 * 86400000).toISOString() });
const list = s.listClosed();
check('a record is listed', list.length === 1 && list[0].id === A);
check('a record older than 14 days is deleted', !fs.existsSync(path.join(MC, 'closed', B + '.json')));
s.dropClosed(A);
check('Reopen drops the record', s.listClosed().length === 0);
let threw = false;
try { s.writeClosed({ id: '../../etc/passwd', closedAt: 'x' }); } catch { threw = true; }
check('a record id must be a session uuid', threw);

fs.rmSync(MC, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
