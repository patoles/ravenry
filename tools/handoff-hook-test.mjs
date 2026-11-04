// Proves hooks/handoff-stop.mjs by piping crafted Stop-hook input into it,
// against a throwaway RAVENRY_HOME and project folder. Touches nothing else.
// Usage: node tools/handoff-hook-test.mjs [<real transcript to copy>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'hooks', 'handoff-stop.mjs');
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'handoff-test-'));
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const BARE = path.join(T, 'bare');
const TR = path.join(T, 'transcripts');
// A launch folder holding two repos, like ~/projects: one
// workspace whose tabs work in REPO_A and REPO_B, each repo its own project
// with its brief outside the repo, in RAVENRY_HOME/briefs.
const LAUNCH = path.join(T, 'launch');
const REPO_A = path.join(LAUNCH, 'repo-a');
const REPO_B = path.join(LAUNCH, 'repo-b');
for (const d of [MC, PROJ, BARE, TR, REPO_A, REPO_B, path.join(MC, 'briefs')]) fs.mkdirSync(d, { recursive: true });
for (const d of [PROJ, BARE, REPO_A, REPO_B]) execFileSync('git', ['init', '-q', d]);
const BRIEF_A = path.join(MC, 'briefs', 'repo-a.md');
const BRIEF_B = path.join(MC, 'briefs', 'repo-b.md');
for (const [f, n] of [[BRIEF_A, 'A'], [BRIEF_B, 'B']]) fs.writeFileSync(f, `status: draft (from test), review me\n\n# Repo ${n}\n\nGoal: Prove a brief outside the repo.\n\n## Hand-off\n- 2026-11-01 10:00 Older hand-off.\n\n## Notes\n- [ ] a note\n`);
const BRIEF = path.join(PROJ, 'BRIEF.md');
fs.writeFileSync(BRIEF, '# Test\n\nGoal: Prove the hook.\n\n## Next step\nKeep going.\n\n## Hand-off\n- 2026-11-01 10:00 Older hand-off.\n\n## Notes\n- [ ] a note\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1, settings: {},
  projects: [
    { id: 'proj', name: 'Proj', folder: PROJ, workspaces: ['ws-proj'], brief: 'BRIEF.md' },
    { id: 'bare', name: 'Bare', folder: BARE, workspaces: ['ws-bare'], brief: 'BRIEF.md' },
    { id: 'repo-a', name: 'Repo A', folder: REPO_A, workspaces: ['ws-split'], brief: BRIEF_A },
    { id: 'repo-b', name: 'Repo B', folder: REPO_B, workspaces: ['ws-split'], surfaces: ['sf-b'], brief: BRIEF_B },
  ],
}, null, 2));

// A transcript whose last assistant record used `tokens` of context.
function transcript(name, tokens, text = 'Done. Committed as abc123.') {
  const p = path.join(TR, name + '.jsonl');
  const recs = [
    { type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: '2026-11-02T20:00:00Z' },
    { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 6, cache_creation_input_tokens: 2000, cache_read_input_tokens: tokens - 2006, output_tokens: 300 } }, timestamp: '2026-11-02T20:01:00Z' },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-11-02T20:01:01Z' },
  ];
  fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}
function run(input, env = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, RAVENRY_HOME: MC, CMUX_WORKSPACE_ID: 'ws-proj', CMUX_SURFACE_ID: 'sf-1', ...env }, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let out = null;
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { out = { raw: r.stdout }; }
  return { code: r.status, out, ms, stderr: r.stderr };
}
const marker = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', sid + '.json'), 'utf8')); } catch { return null; } };
const stop = (sid, tp, extra = {}) => ({ session_id: sid, transcript_path: tp, cwd: PROJ, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], session_crons: [], ...extra });

// 1. Below the line: silent exit 0, no marker.
const low = transcript('low', 180000);
let r = run(stop('sess-low-0001', low));
check('below 50%: exit 0, no output, no marker', r.code === 0 && r.out === null && !marker('sess-low-0001'), `${r.ms.toFixed(0)} ms`);

// 2. Past the line: one block naming the brief.
const high = transcript('high', 523000);
const SID = 'sess-high-0001';
r = run(stop(SID, high));
check('past 50%: blocks', r.code === 0 && r.out && r.out.decision === 'block', `${r.ms.toFixed(0)} ms`);
check('reason: 50% line, clean point, deferral line, the brief path', r.out && /past the 50% hand-off line/.test(r.out.reason) && /clean point/.test(r.out.reason) && r.out.reason.includes('Hand-off deferred: not at a clean point.') && r.out.reason.includes(BRIEF));
const { hasTag } = await import('../server/handoff.mjs');
check('reason: starts with the [ravenry hand-off] tag; the board knows it and the pre-rename tag', r.out && r.out.reason.startsWith('[ravenry hand-off]\n') && !/Mission Control/.test(r.out.reason) && hasTag(r.out.reason) && hasTag('[mission-control hand-off] Context is at 55%') && !hasTag('a prompt from the user'));
check('marker: requested, asks 1, workspace from env', marker(SID)?.state === 'requested' && marker(SID).asks === 1 && marker(SID).workspaceId === 'ws-proj' && marker(SID).surfaceId === 'sf-1');
if (r.out) fs.writeFileSync(path.join(T, 'reason-50.txt'), r.out.reason);

// 3. The stop right after (stop_hook_active): never blocks. Claude deferred,
// so the marker records the deferral and the board's line says when it asks.
r = run(stop(SID, high, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
check('stop_hook_active: no block', r.code === 0 && r.out === null);
check('marker stays requested', marker(SID)?.state === 'requested');
const HOLD = /^deferred at \d\d:\d\d; asks again after your next message or at \d\d:\d\d$/;
check('deferral recorded: deferredAt, deferrals 1, the board line', !!marker(SID)?.deferredAt && marker(SID).deferrals === 1 && HOLD.test(marker(SID).lastCheck?.why), marker(SID)?.lastCheck?.why);

// 4. After a deferral the hook asks again only once something changed. The
// stops a session waiting on agents or on the user makes do not count.
const addRec = (tp, rec) => fs.appendFileSync(tp, JSON.stringify({ timestamp: new Date().toISOString(), ...rec }) + '\n');
r = run(stop(SID, high));
check('deferral, then an ordinary stop with nothing new: no ask', r.out === null && marker(SID).asks === 1 && HOLD.test(marker(SID).lastCheck.why), marker(SID).lastCheck.why);
const highS = path.join(TR, 'high-sid.jsonl');
fs.copyFileSync(high, highS);
addRec(highS, { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "work" completed</summary>\n</task-notification>' } });
r = run(stop(SID, highS));
check('deferral, then a task-notification stop: no ask', r.out === null && marker(SID).asks === 1);
addRec(highS, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] } });
addRec(highS, { type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\n[ravenry hand-off]\nContext is at 52%' } });
addRec(highS, { type: 'user', message: { role: 'user', content: '[ravenry hand-off]\nContext is at 52%' } });
addRec(highS, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
r = run(stop(SID, highS));
check("deferral, then a tool result, the hook's own reason fed back and an interrupt: no ask", r.out === null && marker(SID).asks === 1);
r = run(stop(SID, highS, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
check('a later stop still showing the DEFERRED line does not push the cooldown on', marker(SID).deferrals === 1);
addRec(highS, { type: 'user', message: { role: 'user', content: 'looks good, carry on' } });
r = run(stop(SID, highS, { background_tasks: [{ id: 'blive-s001', type: 'shell', status: 'running', description: 'x' }] }));
check('deferral, then a new user prompt while a shell runs: no ask, queued for the shell', r.out === null && marker(SID).asks === 1 && marker(SID).lastCheck.why === '1 background task running', marker(SID).lastCheck.why);
r = run(stop(SID, highS));
check('deferral, then a new user prompt with nothing running: asks', r.out && r.out.decision === 'block' && marker(SID).asks === 2);

// 5. Claude writes the hand-off; the stop after it records "written".
fs.writeFileSync(BRIEF, fs.readFileSync(BRIEF, 'utf8').replace('## Hand-off\n', '## Hand-off\n- 2026-11-02 21:10 Finished the hook.\n  - State: done\n  - Next step: board side\n'));
r = run(stop(SID, high, { stop_hook_active: true, last_assistant_message: 'Hand-off written to BRIEF.md.' }));
check('after the hand-off: no block, marker written', r.out === null && marker(SID)?.state === 'written');

// 6. Once per session: no more asks after written.
r = run(stop(SID, high));
check('after written: silent for good', r.out === null && marker(SID).state === 'written');
check('history: requested -> written', JSON.stringify(marker(SID).history.map((x) => x.state)) === '["requested","written"]', JSON.stringify(marker(SID).history.map((x) => x.state)));

// 7. A note added to the brief while requested is not a hand-off.
const SN = 'sess-note-0001';
const high2 = transcript('high2', 530000);
run(stop(SN, high2));
fs.appendFileSync(BRIEF, '- [ ] a note added from the board\n');
r = run(stop(SN, high2, { stop_hook_active: true }));
check('a new note is not mistaken for the hand-off', marker(SN)?.state === 'requested');

// 8. Ceiling wording.
const ceil = transcript('ceil', 720000);
r = run(stop('sess-ceil-0001', ceil));
check('past 70%: ceiling wording', r.out && /past the 70% ceiling/.test(r.out.reason) && /Hand off now/.test(r.out.reason) && !r.out.reason.includes('Hand-off deferred'));
if (r.out) fs.writeFileSync(path.join(T, 'reason-70.txt'), r.out.reason);

// 9. Manual request from the board, below the line.
const SM = 'sess-manual-001';
fs.mkdirSync(path.join(MC, 'handoffs'), { recursive: true });
fs.writeFileSync(path.join(MC, 'handoffs', SM + '.json'), JSON.stringify({ sessionId: SM, state: 'queued', manualAt: new Date().toISOString(), history: [{ state: 'queued', at: new Date().toISOString() }] }));
r = run(stop(SM, low));
check('manual request below 50%: blocks, says the user asked', r.out && /The user asked for a hand-off/.test(r.out.reason) && marker(SM).state === 'requested');

// 10. Background work running: not a clean point, no block.
r = run(stop('sess-bg-00001', high, { background_tasks: [{ id: 't1', type: 'shell', status: 'running', description: 'npm test' }] }));
check('background task running: no block, queued', r.out === null && marker('sess-bg-00001')?.state === 'queued' && /background task/.test(marker('sess-bg-00001').lastCheck.why));

// 10b. Background tasks in the shape Claude Code really sends (read from its
// source in 2.1.316/2.1.317 and captured from a real Stop): only running or
// pending entries, { id, type, status, description, agent_type | command }.
// A long session can keep finished ones listed as running (one real
// session listed 11 for hours), so the transcript settles it.
const agentIds = Array.from({ length: 12 }, (_, i) => 'a' + String(i).padStart(16, '0'));
function taskTranscript(name, { done = [], open = [], resumed = [], extra = [] } = {}) {
  const p = transcript(name, 523000);
  const recs = [];
  let n = 0;
  const at = () => `2026-11-02T20:00:${String(10 + (n++ % 40)).padStart(2, '0')}Z`;
  for (const id of [...done, ...open]) {
    recs.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-' + id, name: 'Agent', input: { description: 'work', run_in_background: true } }] }, timestamp: at() });
    recs.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-' + id, content: 'Async agent launched' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id }, timestamp: at() });
  }
  for (const id of done) recs.push({ type: 'user', message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu-${id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "work" completed</summary>\n</task-notification>` }, timestamp: at() });
  for (const id of resumed) recs.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'sm-' + id, name: 'SendMessage', input: { to: id, message: 'one more change' } }] }, timestamp: at() });
  recs.push(...extra);
  const body = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(p, [body[0], ...recs.map((r) => JSON.stringify(r)), ...body.slice(1)].join('\n') + '\n');
  return p;
}
const listed = (ids, extra = {}) => ids.map((id) => ({ id, type: 'subagent', status: 'running', description: 'work', agent_type: 'general-purpose', ...extra }));
const { runningTasks } = await import('../server/handoff.mjs');

const t11 = taskTranscript('t11', { done: agentIds.slice(0, 11) });
r = run(stop('sess-t11-00001', t11, { background_tasks: listed(agentIds.slice(0, 11)) }));
check('11 finished agents still listed as running, 0 running: clean, asks', r.out && r.out.decision === 'block' && marker('sess-t11-00001')?.lastCheck?.clean === true, marker('sess-t11-00001')?.lastCheck?.why || JSON.stringify(r.out));

const t12 = taskTranscript('t12', { done: agentIds.slice(0, 11), open: [agentIds[11]] });
r = run(stop('sess-t12-00001', t12, { background_tasks: listed(agentIds) }));
check('11 finished + 1 running agent: queued, "1 background task running"', r.out === null && marker('sess-t12-00001')?.state === 'queued' && marker('sess-t12-00001').lastCheck.why === '1 background task running', marker('sess-t12-00001')?.lastCheck?.why);

const pend = runningTasks({ transcript_path: t12, background_tasks: [{ id: agentIds[11], type: 'subagent', status: 'pending', description: 'w', agent_type: 'Explore' }] });
check('a launched agent listed as pending counts as running', pend.length === 1);
const odd = runningTasks({ transcript_path: t12, background_tasks: [{ id: agentIds[11], type: 'subagent', status: 'completed' }, { id: 'b-weird-01', type: 'shell', status: 'somethingnew' }, { id: 'b-nostatus1', type: 'shell' }] });
check('allow-list: completed, an unknown status and no status are not running', odd.length === 0, JSON.stringify(odd));
const house = runningTasks({ transcript_path: t12, background_tasks: [{ id: 'd1', type: 'dream', status: 'running' }, { id: 'm1', type: 'auto-mode scan', status: 'running' }, { id: 'm2', type: 'memory import', status: 'pending' }] });
check("Claude Code's housekeeping (dream, auto-mode scan, memory import) is not the session's work", house.length === 0);

const tres = taskTranscript('tres', { done: [agentIds[0]], resumed: [agentIds[0]] });
check('an agent resumed by SendMessage after its notification is running again', runningTasks({ transcript_path: tres, background_tasks: listed([agentIds[0]]) }).length === 1);

// A shell a subagent started: settled by that subagent's transcript.
const tsub = taskTranscript('tsub', { done: [agentIds[0]], open: [agentIds[1]] });
const subDir = path.join(tsub.replace(/\.jsonl$/, ''), 'subagents');
fs.mkdirSync(subDir, { recursive: true });
const subRec = (sh) => JSON.stringify({ type: 'user', isSidechain: true, toolUseResult: { backgroundTaskId: sh, stdout: '' }, timestamp: '2026-11-02T20:00:20Z' }) + '\n';
fs.writeFileSync(path.join(subDir, `agent-${agentIds[0]}.jsonl`), subRec('bdoneowner1'));
fs.writeFileSync(path.join(subDir, `agent-${agentIds[1]}.jsonl`), subRec('bliveowner1'));
const shells = runningTasks({ transcript_path: tsub, background_tasks: [{ id: 'bdoneowner1', type: 'shell', status: 'running', description: 'x', command: 'npm test' }, { id: 'bliveowner1', type: 'shell', status: 'running', description: 'x', command: 'npm test' }] });
check("a subagent's shell: finished once its subagent finished, running while it runs", shells.length === 1 && shells[0].id === 'bliveowner1', JSON.stringify(shells.map((x) => x.id)));

// Monitors. Claude Code lists watches it keeps for itself (one per page
// published with the Artifact tool, for good) as running monitors that no
// Monitor call started; six of them held a real session queued for hours.
// A Monitor the session started and that is still open does count.
const tmon = taskTranscript('tmon', { done: [agentIds[0]] });
fs.appendFileSync(tmon, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mon1', content: 'Monitor started (task mlive00001, expires in 30m unless the source ends first).' }] }, timestamp: '2026-11-02T20:00:30Z' }) + '\n');
const mons = runningTasks({ transcript_path: tmon, background_tasks: ['sart00001', 'sart00002', 'sart00003', 'sart00004', 'sart00005', 'sart00006'].map((id) => ({ id, type: 'monitor', status: 'running' })).concat([{ id: 'mlive00001', type: 'monitor', status: 'running' }]) });
check('six monitors no Monitor call started are not work; a started, open Monitor is', mons.length === 1 && mons[0].id === 'mlive00001', JSON.stringify(mons.map((x) => x.id)));

// 10c. A hand-off written while the marker was still queued (here the 11
// leaked tasks kept it queued; the user then asked by hand). The stop after the
// write takes a fresh base, so only the bullet's date and the session's own
// write can show it.
const SQ = 'sess-queued-w01';
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const tq = taskTranscript('tq', { done: agentIds.slice(0, 3) });
r = run(stop(SQ, tq, { background_tasks: [{ id: 'blive-0001', type: 'shell', status: 'running', description: 'x', command: 'sleep 99' }] }));
check('queued while a shell runs', marker(SQ)?.state === 'queued');
const SQ2 = 'sess-queued-o01';
const tq2 = transcript('tq2', 523000);
run(stop(SQ2, tq2, { background_tasks: [{ id: 'blive-0002', type: 'shell', status: 'running', description: 'x' }] }));
check('a second session on the same brief: queued too', marker(SQ2)?.state === 'queued');
// The first session writes the hand-off with a Bash call, after it was queued.
await new Promise((res) => setTimeout(res, 1100));
const now = new Date();
fs.writeFileSync(BRIEF, fs.readFileSync(BRIEF, 'utf8').replace('## Hand-off\n', `## Hand-off\n- ${stamp(now)} Wrote it while queued.\n  - State: done\n`));
fs.appendFileSync(tq, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: `python3 - <<'EOF'\np='${BRIEF}'\nEOF` } }] }, timestamp: now.toISOString() }) + '\n');
const { writtenWhileQueued } = await import('../server/handoff.mjs');
check('board check: the writer counts as written, the other session does not', writtenWhileQueued(marker(SQ), tq) === true && writtenWhileQueued(marker(SQ2), tq2) === false);
// A queued stop in between (a shell still running) must not swallow it.
r = run(stop(SQ, tq, { background_tasks: [{ id: 'blive-0001', type: 'shell', status: 'running', description: 'x' }] }));
check('stop after a hand-off written while queued: marker written, no block', r.out === null && marker(SQ)?.state === 'written' && marker(SQ).writtenSeenBy === 'hook', marker(SQ)?.state);
r = run(stop(SQ2, tq2, { background_tasks: [{ id: 'blive-0002', type: 'shell', status: 'running', description: 'x' }] }));
check('the other session stays queued', marker(SQ2)?.state === 'queued');

// 11. Ended on a question to the user: a clean point now. The hand-off
// carries the question in its open items.
r = run(stop('sess-ask-0001', high, { last_assistant_message: 'The board is done.\n\nShould the button be blue or grey?' }));
check('ended on a question: asks', r.out && r.out.decision === 'block' && marker('sess-ask-0001')?.state === 'requested' && marker('sess-ask-0001').lastCheck.clean === true);
check("reason: waiting on the user's answer is a clean point, the question goes in the open items", r.out && !/or are waiting on the user's answer, do not hand off/.test(r.out.reason) && /even if you are waiting on the user's answer/.test(r.out.reason) && /put it word for word in "Open items:"/.test(r.out.reason));

// 11b. The cooldown: 10 minutes after a deferral the hook asks again.
const SC = 'sess-cool-0001';
run(stop(SC, high));
run(stop(SC, high, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
r = run(stop(SC, high));
check('cooldown: no ask inside 10 minutes', r.out === null && marker(SC).asks === 1);
const setMarker = (sid, patch, dir = MC) => { const f = path.join(dir, 'handoffs', sid + '.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch })); };
setMarker(SC, { deferredAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
r = run(stop(SC, high));
check('cooldown: 11 minutes after the deferral, asks again', r.out && r.out.decision === 'block' && marker(SC).asks === 2);

// 11c. Hand off now pressed inside the cooldown: asks at the next stop.
const SMD = 'sess-mandef-01';
run(stop(SMD, high));
run(stop(SMD, high, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
r = run(stop(SMD, high));
check('manual inside the cooldown: held before the press', r.out === null && marker(SMD).asks === 1);
setMarker(SMD, { manualAt: new Date().toISOString() });
r = run(stop(SMD, high));
check('manual inside the cooldown: the press asks at the next stop', r.out && r.out.decision === 'block' && /The user asked for a hand-off/.test(r.out.reason) && marker(SMD).asks === 2);
run(stop(SMD, high, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
r = run(stop(SMD, high));
check('manual, deferred again: held again until something new', r.out === null && marker(SMD).asks === 2 && marker(SMD).deferrals === 2);

// 11d. The ceiling: the first stop past it asks even inside a cooldown taken
// below it; after that the cooldown holds past it too. Its words offer no
// deferral line, so a stop that answered it without a hand-off is the deferral.
const SCE = 'sess-ceildef-1';
run(stop(SCE, high));
run(stop(SCE, high, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
r = run(stop(SCE, ceil));
check('ceiling: the first stop past it asks inside a cooldown taken below it', r.out && /past the 70% ceiling/.test(r.out.reason) && marker(SCE).asks === 2);
r = run(stop(SCE, ceil, { stop_hook_active: true, last_assistant_message: 'Finishing the step first; agents still running.' }));
check('ceiling: answered without a hand-off, counts as a deferral past the ceiling', r.out === null && marker(SCE).deferrals === 2 && marker(SCE).deferredOver === true && HOLD.test(marker(SCE).lastCheck.why), marker(SCE).lastCheck?.why);
r = run(stop(SCE, ceil));
check('ceiling: the cooldown holds past it too', r.out === null && marker(SCE).asks === 2);

// 11e. Codex: the rollout says when the user last typed; a Stop hook's
// reason comes back as a <hook_prompt>, which is not the user.
const rollout = (name) => {
  const p = path.join(TR, name + '.jsonl');
  const ts = '2026-11-02T20:00:00Z';
  const recs = [
    { timestamp: ts, type: 'session_meta', payload: { id: name, cwd: PROJ } },
    { timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5.5', cwd: PROJ } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 150000 }, model_context_window: 258400 } } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  fs.writeFileSync(p, recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return p;
};
const runCx = (input) => { const x = spawnSync(process.execPath, [HOOK, '--assistant=codex'], { input: JSON.stringify(input), env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' }); try { return x.stdout.trim() ? JSON.parse(x.stdout) : null; } catch { return { raw: x.stdout }; } };
const SX = 'cccccccc-3333-4333-8333-cccccccccccc';
const rx = rollout('rollout-cx');
let o = runCx(stop(SX, rx, { last_assistant_message: 'Done.' }));
check('Codex: past the line, asks', o && o.decision === 'block' && /Codex/.test(o.reason));
runCx(stop(SX, rx, { stop_hook_active: true, last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
check('Codex: deferral recorded', marker(SX)?.deferrals === 1);
addRec(rx, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<hook_prompt>[ravenry hand-off] Context is at 58%</hook_prompt>' }] } });
o = runCx(stop(SX, rx, { last_assistant_message: 'Still waiting on the build.' }));
check("Codex: deferral, then a stop after the hook's own <hook_prompt>: no ask", o === null && marker(SX).asks === 1, JSON.stringify(o));
addRec(rx, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok, go on' }] } });
o = runCx(stop(SX, rx, { last_assistant_message: 'Done.' }));
check('Codex: deferral, then a new user prompt: asks', o && o.decision === 'block' && marker(SX).asks === 2);

// 12. A project with no BRIEF.md: HANDOFF.md at the repo root.
r = run(stop('sess-bare-0001', high, { cwd: BARE }), { CMUX_WORKSPACE_ID: 'ws-bare' });
check('no BRIEF.md: reason names HANDOFF.md at the repo root', r.out && r.out.reason.includes(path.join(fs.realpathSync(BARE), 'HANDOFF.md')), r.out ? '' : JSON.stringify(r));

// 12b. A brief in RAVENRY_HOME/briefs (not named BRIEF*): the reason asks for a
// bullet in its Hand-off section, never to replace the file.
const workIn = (name, dir) => {
  const p = transcript(name, 523000);
  const tool = { type: 'assistant', cwd: LAUNCH, message: { model: 'claude-opus-5-5', content: Array.from({ length: 8 }, (_, i) => ({ type: 'tool_use', id: 't' + i, name: 'Read', input: { file_path: path.join(dir, `f${i}.js`) } })) }, timestamp: '2026-11-02T20:00:30Z' };
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  lines.splice(1, 0, JSON.stringify(tool));
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
};
r = run(stop('sess-split-a01', workIn('split-a', REPO_A), { cwd: LAUNCH }), { CMUX_WORKSPACE_ID: 'ws-split', CMUX_SURFACE_ID: 'sf-a' });
check('split workspace, tab working in repo-a: names the brief in RAVENRY_HOME/briefs', r.out && r.out.reason.includes(BRIEF_A) && !r.out.reason.includes(BRIEF_B), r.out ? r.out.reason.split('\n').find((l) => l.startsWith('1.')) : JSON.stringify(r));
check('brief outside the repo: asks for a bullet in its Hand-off section, not a replace', r.out && /add a new bullet at the top of the "## Hand-off" section/.test(r.out.reason) && !/Create or replace/.test(r.out.reason));
r = run(stop('sess-split-b01', workIn('split-b', REPO_A), { cwd: LAUNCH }), { CMUX_WORKSPACE_ID: 'ws-split', CMUX_SURFACE_ID: 'sf-b' });
check('split workspace, tab named in "surfaces": that project wins', r.out && r.out.reason.includes(BRIEF_B));
r = run(stop('sess-split-c01', workIn('split-c', REPO_B), { cwd: LAUNCH }), { CMUX_WORKSPACE_ID: 'ws-split', CMUX_SURFACE_ID: 'sf-new' });
check('split workspace, a new tab working in repo-b: repo-b by its tool calls', r.out && r.out.reason.includes(BRIEF_B));
const beforeNote = fs.readFileSync(BRIEF_A, 'utf8');
fs.writeFileSync(BRIEF_A, beforeNote.replace('## Hand-off\n', '## Hand-off\n- 2026-11-02 21:10 Finished.\n  - State: done\n'));
r = run(stop('sess-split-a01', workIn('split-a', REPO_A), { cwd: LAUNCH, stop_hook_active: true }), { CMUX_WORKSPACE_ID: 'ws-split', CMUX_SURFACE_ID: 'sf-a' });
check('brief outside the repo: hand-off seen as written', marker('sess-split-a01')?.state === 'written');

// 12c. The board's Settings card: hand-off off, and a moved line. Each runs
// against its own RAVENRY_HOME holding the same projects with other settings.
function mcWith(name, settings) {
  const dir = path.join(T, name);
  fs.mkdirSync(path.join(dir, 'handoffs'), { recursive: true });
  const reg = JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ ...reg, settings }, null, 2));
  return { env: { RAVENRY_HOME: dir }, marker: (sid) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'handoffs', sid + '.json'), 'utf8')); } catch { return null; } }, dir };
}
const off = mcWith('mc-off', { handoffEnabled: false });
r = run(stop('sess-off-high1', high), off.env);
check('hand-off off, past the 50% line: no ask, no marker', r.code === 0 && r.out === null && !off.marker('sess-off-high1'), `${r.ms.toFixed(0)} ms`);
r = run(stop('sess-off-ceil1', ceil), off.env);
check('hand-off off, past the 70% ceiling: no ask, no marker', r.code === 0 && r.out === null && !off.marker('sess-off-ceil1'));
fs.writeFileSync(path.join(off.dir, 'handoffs', 'sess-off-man01.json'), JSON.stringify({ sessionId: 'sess-off-man01', state: 'queued', manualAt: new Date().toISOString(), history: [{ state: 'queued', at: new Date().toISOString() }] }));
r = run(stop('sess-off-man01', ceil), off.env);
check('hand-off off, Hand off now pressed (past the ceiling too): asks, in the manual wording', r.out && r.out.decision === 'block' && /The user asked for a hand-off/.test(r.out.reason) && !/ceiling/.test(r.out.reason) && off.marker('sess-off-man01').state === 'requested', r.out ? '' : JSON.stringify(r));
// A line queued before hand-off was turned off asks nothing after.
fs.writeFileSync(path.join(off.dir, 'handoffs', 'sess-off-old01.json'), JSON.stringify({ sessionId: 'sess-off-old01', state: 'queued', queuedAt: new Date().toISOString(), history: [{ state: 'queued', at: new Date().toISOString() }] }));
r = run(stop('sess-off-old01', high), off.env);
check('hand-off off, queued by the line before it was turned off: no ask', r.out === null && off.marker('sess-off-old01').state === 'queued');
const at60 = mcWith('mc-60', { handoffThreshold: 60, handoffCeiling: 80 });
r = run(stop('sess-60-at52-1', high), at60.env);
check('line at 60%: 52% asks nothing', r.out === null && !at60.marker('sess-60-at52-1'));
r = run(stop('sess-60-at61-1', transcript('at61', 612000)), at60.env);
check('line at 60%: 61% asks, naming the 60% line', r.out && r.out.decision === 'block' && /past the 60% hand-off line/.test(r.out.reason), r.out ? r.out.reason.split('\n')[1] : JSON.stringify(r));
r = run(stop('sess-60-at72-1', ceil), at60.env);
check('ceiling at 80%: 72% is not past it', r.out && /past the 60% hand-off line/.test(r.out.reason) && !/ceiling/.test(r.out.reason));

// 13. Garbage input never fails a stop.
const g = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' });
check('garbage input: exit 0, no output', g.status === 0 && !g.stdout.trim());

// 14. Speed on a real, large transcript (a copy), below the line.
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  const copy = path.join(TR, 'real.jsonl');
  fs.copyFileSync(real, copy);
  const sz = (fs.statSync(copy).size / 1e6).toFixed(0);
  const times = [];
  let last;
  fs.mkdirSync(path.join(T, 'mc-big'), { recursive: true });
  fs.writeFileSync(path.join(T, 'mc-big', 'projects.json'), JSON.stringify({ settings: { contextWindow: 1e9 }, projects: [] }));
  for (let i = 0; i < 5; i++) { last = run(stop('sess-real-0001', copy), { RAVENRY_HOME: path.join(T, 'mc-big') }); times.push(last.ms); }
  times.sort((a, b) => a - b);
  check(`real ${sz} MB transcript, window 1e9 (below): silent, median under 200 ms`, last.out === null && times[2] < 200, `median ${times[2].toFixed(0)} ms, all ${times.map((x) => x.toFixed(0)).join('/')}`);
  // The same real transcript with a smaller window, so it is past the line.
  const tokens = JSON.parse(execFileSync(process.execPath, ['-e', `import('${path.join(ROOT, 'server', 'handoff.mjs')}').then((h) => console.log(JSON.stringify(h.lastUsage(process.argv[1]).tokens)))`, copy], { encoding: 'utf8' }));
  fs.writeFileSync(path.join(T, 'mc-big', 'projects.json'), JSON.stringify({ settings: { contextWindow: Math.round(tokens / 0.6) }, projects: [] }));
  last = run(stop('sess-real-0002', copy), { RAVENRY_HOME: path.join(T, 'mc-big') });
  check(`real transcript (${tokens} tokens) at 60% of its window: blocks once`, last.out && last.out.decision === 'block' && /60% \(/.test(last.out.reason), `${last.ms.toFixed(0)} ms`);
  last = run(stop('sess-real-0002', copy, { stop_hook_active: true }), { RAVENRY_HOME: path.join(T, 'mc-big') });
  check('real transcript, stop_hook_active: no block', last.out === null);
  fs.rmSync(copy);
}

if (!fails && !process.env.KEEP) fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}${fails || process.env.KEEP ? `  (fixtures in ${T})` : ''}`);
process.exit(fails ? 1 : 0);
