#!/usr/bin/env node
// server/tasks.mjs reads a transcript once and then only what was appended
// (a cursor per file, kept in memory and, for the Stop hooks, each a process
// of its own, on disk). On 2026-11-07 the board re-read a 67 MB transcript's
// last 64 MB for each Stop report a daemon had kept, and held its main
// thread for 40 s at start. This checks:
//   - the board's answer (runningTasksAsync), the hooks' (runningTasks) and a
//     new process's (from the cursor on disk) are the same, and right;
//   - what is appended counts (a finished notification, a restart, a
//     Monitor started), and a rewritten transcript is read again;
//   - a new process with the cursor on disk reads only what was appended.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', `tasks-cursor-${process.pid}`);
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = process.env.RAVENRY_HOME || path.join(T, 'home');
const tasks = await import('../server/tasks.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

const at = (k) => new Date(Date.UTC(2026, 10, 7, 10, 0, k)).toISOString();
const note = (id, status) => JSON.stringify({ type: 'user', timestamp: at(1), message: { role: 'user', content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>` } }) + '\n';
const launched = (id) => JSON.stringify({ type: 'user', timestamp: at(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: `Async agent launched. agentId: ${id}` }] } }) + '\n';
const monitor = (id) => JSON.stringify({ type: 'user', timestamp: at(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: `Monitor started (task ${id}, timeout 600000ms)` }] } }) + '\n';
const resume = (id) => JSON.stringify({ type: 'assistant', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input: { to: id, message: 'go on' } }] } }).replace(/"to": ?"/, '"to":"') + '\n';
const filler = (n) => { let s = ''; for (let k = 0; k < n; k++) s += JSON.stringify({ type: 'assistant', timestamp: at(0), message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(900) }] } }) + '\n'; return s; };

// A main transcript of about 24 MB, and one subagent's.
const dir = path.join(T, 'projects', 'p');
fs.mkdirSync(dir, { recursive: true });
const main = path.join(dir, 'sess.jsonl');
const subDir = path.join(dir, 'sess', 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(main, filler(12000) + launched('aDone1') + launched('aRun1') + launched('aSub1') + filler(12000) + note('aDone1', 'completed') + monitor('mLive1') + monitor('mDone1') + note('mDone1', 'completed') + launched('aBack1') + note('aBack1', 'completed') + filler(2000));
fs.writeFileSync(path.join(subDir, 'agent-aSub1.jsonl'), filler(200) + 'Command running in background with ID: bSubShell\n' + filler(10));
const input = (ids) => ({ transcript_path: main, background_tasks: ids.map(([id, type]) => ({ id, type, status: 'running' })) });
const ask = [['aDone1', 'subagent'], ['aRun1', 'subagent'], ['aSub1', 'subagent'], ['bSubShell', 'shell'], ['mLive1', 'monitor'], ['mDone1', 'monitor'], ['mArtifact', 'monitor'], ['aBack1', 'subagent'], ['xUnknown', 'shell']];
const ids = (list) => list.map((t) => t.id).sort().join(',');
// Running: aRun1, aSub1 (no notification), bSubShell (its subagent aSub1
// has not finished), mLive1 (launched, not finished), xUnknown (named
// nowhere: running, as Claude Code says). Not: aDone1, mDone1 (finished),
// mArtifact (no Monitor call started it), aBack1 (finished).
const want1 = 'aRun1,aSub1,bSubShell,mLive1,xUnknown';

const fresh = () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(path.join(ROOT, 'server', 'tasks.mjs'))}).then((t) => { const a = Date.now(); const r = t.runningTasks(JSON.parse(process.argv[1])); console.log(JSON.stringify({ ids: r.map((x) => x.id).sort().join(','), ms: Date.now() - a })); });`, JSON.stringify(input(ask))], { env: { ...process.env }, encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ids: 'error: ' + (r.stderr || '').slice(-300), ms: null }; }
};

const sync1 = ids(tasks.runningTasks(input(ask)));
const async1 = ids(await tasks.runningTasksAsync(input(ask)));
check('the hooks\' answer (runningTasks) is right', sync1 === want1, sync1);
check('the board\'s answer (runningTasksAsync) is the same', async1 === want1, async1);

// A new process: a hook. The cursor on disk is there, so it reads nothing again.
const store = path.join(process.env.RAVENRY_HOME, 'cache', 'tasks');
check('the cursor is kept on disk, one small file', fs.existsSync(store) && fs.readdirSync(store).filter((f) => f.endsWith('.json')).length >= 1 && fs.readdirSync(store).every((f) => fs.statSync(path.join(store, f)).size < 64 * 1024), fs.existsSync(store) ? fs.readdirSync(store).join(', ') : 'none');
const p1 = fresh();
check('a new process (a hook) gives the same answer from the cursor on disk', p1.ids === want1, `${p1.ids}, ${p1.ms} ms`);

// Appended: aRun1 finished, aBack1 resumed by a SendMessage, a new monitor.
fs.appendFileSync(main, note('aRun1', 'completed') + resume('aBack1') + monitor('mArtifact'));
const want2 = 'aBack1,aSub1,bSubShell,mArtifact,mLive1,xUnknown';
const sync2 = ids(tasks.runningTasks(input(ask)));
const async2 = ids(await tasks.runningTasksAsync(input(ask)));
const p2 = fresh();
check('what is appended counts: a notification, a restart after one, a Monitor started (hooks)', sync2 === want2, sync2);
check('the same on the board', async2 === want2, async2);
check('the same in a new process', p2.ids === want2, p2.ids);

// A new process reads only what was appended: make the cursor's file
// unreadable before it, and the answer still comes (only the end is read).
const size = fs.statSync(main).size;
fs.appendFileSync(main, note('aSub1', 'completed'));
const t0 = Date.now();
const p3 = fresh();
const want3 = 'mArtifact,mLive1,xUnknown,aBack1'.split(',').sort().join(',');
check('a new process after an append: the subagent finished, so its shell is too', p3.ids === want3, `${p3.ids} (${Date.now() - t0} ms with start-up)`);
const fullMs = (() => { const a = Date.now(); fs.readFileSync(main).toString('utf8').indexOf('<task-id>'); return Date.now() - a; })();
const j = JSON.parse(fs.readFileSync(path.join(store, fs.readdirSync(store).find((f) => { try { return JSON.parse(fs.readFileSync(path.join(store, f), 'utf8')).file === main; } catch { return false; } })), 'utf8'));
check('the cursor on disk is at the end of the transcript', j.size === fs.statSync(main).size && j.size > size, `${j.size} of ${fs.statSync(main).size}`);
console.log(`MEASURE tasks-cursor newProcessMs=${p3.ms} wholeReadMs=${fullMs} transcriptMB=${Math.round(size / 1048576)}`);

// Rewritten (smaller, other content): read again, not trusted.
fs.writeFileSync(main, filler(100) + launched('aRun1') + launched('aSub1') + note('aSub1', 'failed'));
const sync4 = ids(tasks.runningTasks(input([['aRun1', 'subagent'], ['aSub1', 'subagent']])));
const p4 = (() => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(path.join(ROOT, 'server', 'tasks.mjs'))}).then((t) => console.log(t.runningTasks(JSON.parse(process.argv[1])).map((x) => x.id).sort().join(',')))`, JSON.stringify(input([['aRun1', 'subagent'], ['aSub1', 'subagent']]))], { env: { ...process.env }, encoding: 'utf8' }); return r.stdout.trim(); })();
check('a rewritten transcript is read again (in this process and a new one)', sync4 === 'aRun1' && p4 === 'aRun1', `${sync4} / ${p4}`);

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
