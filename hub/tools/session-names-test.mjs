#!/usr/bin/env node
// Session names (server/sessionnames.mjs): a name from Claude Code's
// sessions/<pid>.json is the session the hook events of that pid name,
// kept after the session ends, and resolved to its live session first,
// else the newest that had it. A plain word is never a name.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from '../server/events.mjs';
import * as names from '../server/sessionnames.mjs';

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); if (!ok) fails++; };
const TMP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.tmp', 'session-names-test');
fs.rmSync(TMP, { recursive: true, force: true });
const DIR = path.join(TMP, 'claude', 'sessions');
fs.mkdirSync(DIR, { recursive: true });
const STORE = path.join(process.env.RAVENRY_HOME, 'session-names.json');
// The guard's home (hub/.tmp/session-names-test/guard-home) is not inside
// TMP above, so the last run's store is still there: start without it.
fs.rmSync(STORE, { force: true });

const S1 = 'aaaa0001-0000-4000-8000-000000000001';
const S2 = 'aaaa0002-0000-4000-8000-000000000002';
const S3 = 'aaaa0003-0000-4000-8000-000000000003';
const T0 = Date.UTC(2026, 10, 10, 10, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const file = (pid, j) => fs.writeFileSync(path.join(DIR, `${pid}.json`), JSON.stringify({ pid, startedAt: T0, ...j }));

// ravenry-19 runs in pid 100; its file still has the session it started
// with (S1), its events say it moved on to S2 (a /clear).
file(100, { sessionId: S1, name: 'ravenry-19' });
file(200, { sessionId: S3, name: 'lighthouse-8e' });
file(300, { sessionId: S3, name: 'ravenry' });       // a plain word: never a name
file(400, { sessionId: S3, name: 'odd.name-2' });    // a dot: not text a link is cut from
fs.writeFileSync(path.join(DIR, '500.json'), '{"pid": 5');  // half written
const evAll = new Map([
  [S1, summarize(S1, [{ at: iso(T0 + 1000), event: 'SessionStart', session_id: S1, claude_pid: 100 }])],
  [S2, summarize(S2, [{ at: iso(T0 + 5000), event: 'SessionStart', session_id: S2, claude_pid: 100, source: 'clear' }])],
]);

const cache = new Map();
const files = names.readNameFiles(DIR, cache);
check('the name files with a name of a dashed word are read; a plain word, a dot and a half-written file are not',
  files.map((f) => f.name).sort().join(',') === 'lighthouse-8e,ravenry-19', files);
check('a name file unchanged is not read again', names.readNameFiles(DIR, cache).length === 2 && cache.size === 5);

let store = names.load(STORE);
check('no store yet: empty', store.records.length === 0);
let changed = names.note(store, files, evAll, new Set([100, 200]), T0 + 10000);
check('the first tick adds both names', changed && store.records.length === 2 && store.rev === 1);
check('a name is the session its pid\'s newest events name (S2 after the /clear), not the file\'s', names.resolve(store, 'ravenry-19').sessionId === S2, names.resolve(store, 'ravenry-19'));
check('with no events, the file\'s own session id', names.resolve(store, 'lighthouse-8e').sessionId === S3);
check('both are live', names.resolve(store, 'ravenry-19').live && names.resolve(store, 'lighthouse-8e').live);
check('a tick with nothing new changes nothing', !names.note(store, files, evAll, new Set([100, 200]), T0 + 12000) && store.rev === 1);
names.save(store, STORE);

// pid 100 ends: its file goes. The name stays, no longer live.
fs.rmSync(path.join(DIR, '100.json'));
changed = names.note(store, names.readNameFiles(DIR, cache), evAll, new Set([200]), T0 + 20000);
check('the process ends: the name stays, not live, and the table changes', changed && names.resolve(store, 'ravenry-19') && !names.resolve(store, 'ravenry-19').live && names.resolve(store, 'ravenry-19').sessionId === S2);
check('a file left by a process that is gone does not count as live', !names.note(store, [{ pid: 999, name: 'ghost-1', sessionId: S1, startedAt: T0 }], evAll, new Set([200]), T0 + 21000) || !names.resolve(store, 'ghost-1'));

// The board starts again: the store on disk still has the name.
names.save(store, STORE);
store = names.load(STORE);
check('kept across a restart', store.records.some((r) => r.name === 'ravenry-19' && r.sessionId === S2));

// The same name again later, for another session (pid 600, S3), live:
// the live one wins over the older ended one.
names.note(store, [{ pid: 600, name: 'ravenry-19', sessionId: S3, startedAt: T0 + 30000 }], new Map(), new Set([600]), T0 + 40000);
check('a name on two sessions: the live one first', names.resolve(store, 'ravenry-19').sessionId === S3 && names.resolve(store, 'ravenry-19').live);
// Then it ends too: the newest that had it.
names.note(store, [], new Map(), new Set(), T0 + 200000);
check('none live: the newest that had it', names.resolve(store, 'ravenry-19').sessionId === S3 && !names.resolve(store, 'ravenry-19').live);

const tb = names.table(store, (sid) => (sid === S3 ? 'ravenry' : null));
check('the table: each name once, resolved, with its project', tb['ravenry-19'] && tb['ravenry-19'].sessionId === S3 && tb['ravenry-19'].projectId === 'ravenry' && tb['lighthouse-8e'] && Object.keys(tb).length === 2, tb);

// Older than 14 days and not live: forgotten.
changed = names.note(store, [], new Map(), new Set(), T0 + names.KEEP_MS + 300000);
check('names unseen for 14 days are forgotten', changed && store.records.length === 0, store.records);

check('CLAUDE_CONFIG_DIR moves the name files', names.sessionsDir({ CLAUDE_CONFIG_DIR: '/x/y' }) === '/x/y/sessions');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
