// Proves hooks/events.mjs by piping crafted hook input for each of its five
// events into it, against a throwaway RAVENRY_HOME under .tmp/, and proves
// tools/install-hook.mjs on a scratch settings file. Touches nothing else:
// the board URL points at ports only this script listens on (or nothing).
// Usage: node tools/events-hook-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'hooks', 'events.mjs');
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'events-test-'));
const MC = path.join(T, 'mc');
const DIR = path.join(MC, 'events');
const DOWN = 'http://127.0.0.1:4619'; // nothing listens here

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

// Async, so a test server in this process can answer while the hook runs.
function run(input, env = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(process.execPath, [HOOK], { env: { ...process.env, RAVENRY_HOME: MC, MC_BOARD_URL: DOWN, CMUX_WORKSPACE_ID: 'ws-test', CMUX_SURFACE_ID: 'sf-test', ...env } });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    c.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const lines = (sid) => { try { return fs.readFileSync(path.join(DIR, sid + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const last = (sid) => lines(sid).slice(-1)[0] || null;
const base = (sid, ev, extra = {}) => ({ session_id: sid, transcript_path: `/tmp/x/${sid}.jsonl`, cwd: '/Users/x/projects/ravenry', permission_mode: 'auto', hook_event_name: ev, ...extra });
const clean = (r) => r.code === 0 && r.out === '' && r.err === '';

const SID = 'aaaaaaaa-1111-4222-8333-444444444444';

// 1. Each event, board down.
let r = await run(base(SID, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' }));
let e = last(SID);
check('SessionStart: one line, exit 0, silent', clean(r) && lines(SID).length === 1 && e.event === 'SessionStart' && e.source === 'startup' && e.model === 'claude-opus-5-5', `${r.ms.toFixed(0)} ms`);
check('common fields: time, session, cwd, transcript, cmux ids', !!Date.parse(e.at) && e.session_id === SID && e.cwd.endsWith('ravenry') && e.transcript_path.endsWith(SID + '.jsonl') && e.workspace_id === 'ws-test' && e.surface_id === 'sf-test');

r = await run(base(SID, 'UserPromptSubmit', { prompt: 'secret words the board does not need' }));
e = last(SID);
check('UserPromptSubmit: line written, prompt text NOT stored', clean(r) && e.event === 'UserPromptSubmit' && !JSON.stringify(e).includes('secret'), `${r.ms.toFixed(0)} ms`);

r = await run(base(SID, 'Notification', { message: 'Claude needs your permission to use Bash', title: 'Permission needed', notification_type: 'permission_prompt' }));
e = last(SID);
check('Notification permission_prompt: type, message, title', clean(r) && e.notification_type === 'permission_prompt' && e.message === 'Claude needs your permission to use Bash' && e.title === 'Permission needed', `${r.ms.toFixed(0)} ms`);

r = await run(base(SID, 'Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }));
check('Notification idle_prompt', clean(r) && last(SID).notification_type === 'idle_prompt');

r = await run(base(SID, 'Notification', { message: 'x'.repeat(5000), notification_type: 'permission_prompt' }));
check('a long message is capped at 300 chars', clean(r) && last(SID).message.length === 300);

r = await run(base(SID, 'Stop', { stop_hook_active: false, last_assistant_message: 'Built the hook.\n\nShould I also wire the installer?', background_tasks: [], session_crons: [] }));
e = last(SID);
check('Stop ending on a question: ends_on_question + the question', clean(r) && e.event === 'Stop' && e.ends_on_question === true && e.question === 'Should I also wire the installer?' && e.background_tasks === 0, `${r.ms.toFixed(0)} ms`);

r = await run(base(SID, 'Stop', { stop_hook_active: true, last_assistant_message: 'Done. Committed as abc123.', background_tasks: [{ id: 't1', type: 'shell', status: 'running' }, { id: 't2', type: 'subagent', status: 'completed' }], session_crons: [{ id: 'c1' }] }));
e = last(SID);
check('Stop: no question, 1 running task of 2, cron, stop_hook_active', clean(r) && e.ends_on_question === false && !e.question && e.background_tasks === 1 && e.crons === 1 && e.stop_hook_active === true);

// Claude Code can keep a finished agent listed as running; its transcript
// holds the completed notification, so it is not counted. The raw ids,
// types and statuses (never descriptions or commands) go to the task log.
const TRX = path.join(T, 'leak.jsonl');
fs.writeFileSync(TRX, [
  { type: 'user', toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a0000000000000leak' }, timestamp: '2026-11-03T10:00:00Z' },
  { type: 'user', message: { content: '<task-notification>\n<task-id>a0000000000000leak</task-id>\n<status>completed</status>\n</task-notification>' }, timestamp: '2026-11-03T10:05:00Z' },
  { type: 'user', toolUseResult: { backgroundTaskId: 'bstillrunning1' }, timestamp: '2026-11-03T10:06:00Z' },
].map((x) => JSON.stringify(x)).join('\n') + '\n');
r = await run(base(SID, 'Stop', { transcript_path: TRX, last_assistant_message: 'Done.', background_tasks: [
  { id: 'a0000000000000leak', type: 'subagent', status: 'running', description: 'secret task words', agent_type: 'general-purpose' },
  { id: 'bstillrunning1', type: 'shell', status: 'running', description: 'x', command: 'secret command words' },
] }));
const tlog = fs.readFileSync(path.join(MC, 'logs', 'background-tasks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(-1)[0];
check('Stop: a finished agent still listed as running is not counted; the running shell is', clean(r) && last(SID).background_tasks === 1, `${last(SID).background_tasks}`);
check('task log: ids, types and statuses only, and which still run', tlog && tlog.listed.length === 2 && tlog.listed[0].status === 'running' && tlog.listed[0].agent_type === 'general-purpose' && JSON.stringify(tlog.running) === '["bstillrunning1"]' && !JSON.stringify(tlog).includes('secret'));

r = await run(base(SID, 'Stop', { last_assistant_message: 'Hand-off deferred: not at a clean point.' }));
check('Stop on the hand-off deferral line: deferred, question left to the transcript', clean(r) && last(SID).deferred === true && last(SID).ends_on_question === undefined);

r = await run(base(SID, 'SessionEnd', { reason: 'prompt_input_exit' }));
check('SessionEnd: reason', clean(r) && last(SID).event === 'SessionEnd' && last(SID).reason === 'prompt_input_exit', `${r.ms.toFixed(0)} ms`);

r = await run(base('bbbbbbbb-2222', 'Stop', {}), { CMUX_WORKSPACE_ID: '', CMUX_SURFACE_ID: '' });
check('outside cmux: no cmux ids in the line', clean(r) && last('bbbbbbbb-2222') && !('surface_id' in last('bbbbbbbb-2222')));

// 2. Bad input: exit 0, silent, nothing written.
const before = fs.readdirSync(DIR).length;
for (const [name, input] of [['garbage', 'not json {'], ['empty', ''], ['bad session id', { session_id: '../../etc', hook_event_name: 'Stop' }], ['no event name', { session_id: SID }]]) {
  r = await run(input);
  check(`bad input (${name}): exit 0, silent`, clean(r));
}
check('bad input wrote no file', fs.readdirSync(DIR).length === before);

// 3. Timing, board down (connection refused), 15 runs.
const times = [];
for (let i = 0; i < 15; i++) times.push((await run(base(SID, 'UserPromptSubmit'))).ms);
times.sort((a, b) => a - b);
const med = times[7];
check('board down: median under 50 ms', med < 50, `median ${med.toFixed(0)} ms, max ${times[14].toFixed(0)} ms`);

// 4. Board up: the POST arrives with the line and the board's write header.
const got = [];
const up = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push({ url: req.url, h: req.headers, body: b }); res.end('{"ok":true}'); }); });
await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
const upUrl = `http://127.0.0.1:${up.address().port}`;
const upTimes = [];
for (let i = 0; i < 5; i++) upTimes.push((await run(base(SID, 'Stop', { last_assistant_message: 'ok' }), { MC_BOARD_URL: upUrl })).ms);
const posted = got[0] && JSON.parse(got[0].body);
check('board up: POST /api/hook-event with x-ravenry (and the pre-rename x-mission-control) and the same line', got.length === 5 && got[0].url === '/api/hook-event' && got[0].h['x-ravenry'] === '1' && got[0].h['x-mission-control'] === '1' && posted.event === 'Stop' && posted.at === lines(SID).slice(-5)[0].at, `median ${upTimes.sort((a, b) => a - b)[2].toFixed(0)} ms`);
up.close();

// 5. Board hung (accepts, never answers): gives up after 300 ms, exit 0.
const hung = net.createServer(() => { /* never answers */ });
await new Promise((ok) => hung.listen(0, '127.0.0.1', ok));
r = await run(base(SID, 'Stop', {}), { MC_BOARD_URL: `http://127.0.0.1:${hung.address().port}` });
check('board hung: exit 0 in under 450 ms, line still written', clean(r) && r.ms < 450 && last(SID).event === 'Stop', `${r.ms.toFixed(0)} ms`);
hung.close();

// 6. Bounded files: a file past 128 KB is cut to its last 200 lines.
const BIG = 'cccccccc-3333';
fs.writeFileSync(path.join(DIR, BIG + '.jsonl'), Array.from({ length: 1500 }, (_, i) => JSON.stringify({ at: new Date(Date.now() - 1e6 + i).toISOString(), event: 'Stop', session_id: BIG, n: i, pad: 'p'.repeat(80) })).join('\n') + '\n');
r = await run(base(BIG, 'UserPromptSubmit'));
const big = lines(BIG);
check('rotation: trimmed to 200 lines, newest kept', clean(r) && big.length === 200 && big[199].event === 'UserPromptSubmit' && big[0].n === 1301, `${(fs.statSync(path.join(DIR, BIG + '.jsonl')).size / 1024).toFixed(0)} KB after, ${r.ms.toFixed(0)} ms`);

// 7. Old files go at the next SessionStart.
const OLD = path.join(DIR, 'dddddddd-4444.jsonl');
fs.writeFileSync(OLD, '{}\n');
const t20 = new Date(Date.now() - 20 * 86400000);
fs.utimesSync(OLD, t20, t20);
r = await run(base(SID, 'SessionStart', { source: 'resume' }));
check('prune: a file untouched for 20 days is deleted at SessionStart', clean(r) && !fs.existsSync(OLD) && fs.existsSync(path.join(DIR, SID + '.jsonl')));

// 7b. MC_HOME, the override's name from before the rename, still works.
const LEG = path.join(T, 'legacy-home');
const leg = await new Promise((resolve) => {
  const env = { ...process.env, MC_HOME: LEG, MC_BOARD_URL: DOWN };
  delete env.RAVENRY_HOME;
  const c = spawn(process.execPath, [HOOK], { env });
  c.on('close', (code) => resolve(code));
  c.stdin.end(JSON.stringify(base('eeeeeeee-5555', 'UserPromptSubmit')));
});
check('MC_HOME alone (pre-rename name) still picks the data folder', leg === 0 && fs.existsSync(path.join(LEG, 'events', 'eeeeeeee-5555.jsonl')));

// 8. The installer, on a scratch settings file holding Agent Flow-like hooks.
// The Node it names: this one, through a PATH entry when one is the same binary.
const NODE = (await import('../server/hookinstall.mjs')).stableNode();
const S = path.join(T, 'settings.json');
const agentFlow = { hooks: [{ type: 'command', command: 'node /Users/x/.claude/other-tool/hook.js' }] };
const original = { model: 'opus', hooks: { Stop: [agentFlow], SessionStart: [{ matcher: 'startup', ...agentFlow }], PreToolUse: [agentFlow] } };
fs.writeFileSync(S, JSON.stringify(original, null, 2));
const inst = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'install-hook.mjs'), ...a], { env: { ...process.env, MC_CLAUDE_SETTINGS: S }, encoding: 'utf8' });
const read = () => JSON.parse(fs.readFileSync(S, 'utf8'));
const ours = (h, script) => (/(ravenry|mission-control)\/hooks\//.test(h.command) || h.command.includes(path.join(ROOT, 'hooks') + '/')) && h.command.endsWith('/hooks/' + script);
const has = (s, ev, script) => (s.hooks[ev] || []).some((x) => (x.hooks || []).some((h) => ours(h, script)));
const afOk = (s) => JSON.stringify(s.hooks.Stop[0]) === JSON.stringify(agentFlow) && JSON.stringify(s.hooks.PreToolUse) === JSON.stringify([agentFlow]) && s.hooks.SessionStart[0].matcher === 'startup' && s.model === 'opus';

let ir = inst('--dry-run');
check('installer --dry-run: lists 6 additions, writes nothing', ir.status === 0 && (ir.stdout.match(/added/g) || []).length === 6 && JSON.stringify(read()) === JSON.stringify(original));
ir = inst();
let s1 = read();
const evs = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop'];
check('installer: events hook on all five events, hand-off on Stop', ir.status === 0 && evs.every((ev) => has(s1, ev, 'events.mjs')) && has(s1, 'Stop', 'handoff-stop.mjs') && !has(s1, 'PreToolUse', 'events.mjs'));
check('installer: Agent Flow entries and other settings untouched', afOk(s1));
check('installer: backup of the file as it was', fs.readdirSync(T).some((f) => f.startsWith('settings.json.bak-') && fs.readFileSync(path.join(T, f), 'utf8') === JSON.stringify(original, null, 2)));
ir = inst();
check('installer: second run changes nothing', ir.status === 0 && /Nothing to change/.test(ir.stdout) && JSON.stringify(read()) === JSON.stringify(s1));
// A moved Node: the entry is updated in place, not duplicated.
const s2 = read();
for (const x of s2.hooks.Notification) for (const h of x.hooks) if (h.command.includes('events.mjs')) h.command = '/old/node ' + h.command.split(' ').slice(1).join(' ');
fs.writeFileSync(S, JSON.stringify(s2, null, 2));
ir = inst();
const s3 = read();
check('installer: a stale Node path is updated in place', ir.status === 0 && s3.hooks.Notification.length === 1 && s3.hooks.Notification[0].hooks[0].command.startsWith(NODE + ' '));
// The pre-rename path (mission-control/hooks/...), as ~/.claude/settings.json
// holds it today, with a second copy of the same script on Stop: rewritten in
// place to this repo, the copy dropped, Agent Flow untouched, via --settings.
const s5 = read();
for (const ev of evs) for (const x of s5.hooks[ev]) for (const h of x.hooks) {
  for (const sc of ['events.mjs', 'handoff-stop.mjs']) if (ours(h, sc)) h.command = `/old/node /Users/old/projects/mission-control/hooks/${sc}`;
}
s5.hooks.Stop.push({ hooks: [{ type: 'command', command: `${NODE} ${path.join(ROOT, 'hooks', 'events.mjs')}`, timeout: 5 }] });
fs.writeFileSync(S, JSON.stringify(s5, null, 2));
const viaFlag = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'install-hook.mjs'), '--settings', S, ...a], { env: { ...process.env, MC_CLAUDE_SETTINGS: path.join(T, 'not-this.json') }, encoding: 'utf8' });
ir = viaFlag();
const s6 = read();
const cmds = (s, ev) => (s.hooks[ev] || []).flatMap((x) => (x.hooks || []).map((h) => h.command));
const want = (sc) => `${NODE} ${path.join(ROOT, 'hooks', sc)}`;
check('installer --settings: old mission-control paths rewritten in place, duplicate dropped', ir.status === 0 && !fs.existsSync(path.join(T, 'not-this.json')) && evs.every((ev) => cmds(s6, ev).filter((c) => c === want('events.mjs')).length === 1 && !cmds(s6, ev).some((c) => c.includes('/Users/old/'))) && cmds(s6, 'Stop').filter((c) => c === want('handoff-stop.mjs')).length === 1 && JSON.stringify(s6) === JSON.stringify(s1), ir.stdout.trim().split('\n').length - 2 + ' changes');
check('installer --settings: Agent Flow entries untouched', afOk(s6));
ir = viaFlag();
check('installer --settings: second run changes nothing', ir.status === 0 && /Nothing to change/.test(ir.stdout) && JSON.stringify(read()) === JSON.stringify(s6));
ir = inst('--remove');
const s4 = read();
check('installer --remove: both gone, Agent Flow kept, empty events dropped', ir.status === 0 && !evs.some((ev) => has(s4, ev, 'events.mjs')) && !has(s4, 'Stop', 'handoff-stop.mjs') && afOk(s4) && !('SessionEnd' in s4.hooks) && !('Notification' in s4.hooks) && s4.hooks.Stop.length === 1);
check('installer: remove after install gives back the original hooks', JSON.stringify(s4) === JSON.stringify(original));

console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
