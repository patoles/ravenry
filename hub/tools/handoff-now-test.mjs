// Hand off now on a session at rest at its prompt (server/handoffnow.mjs,
// docs/HANDOFF.md, Hand off now), against a throwaway RAVENRY_HOME, a
// scratch brief and crafted transcripts. The pane is a stand-in: nothing
// is typed into any terminal.
//
// The real case (2026-11-20): the person told a session in its chat to hand
// off; it wrote the hand-off into the brief and finished its turn. Hand off
// now pressed after that made a queued marker that the Stop hook was to act
// on at the next stop, which never came: the session sat at its prompt and
// the hand-off stayed queued for good.
//   1. Written since its last prompt: the press counts it as written (and
//      the old rule, a write since the press, would not have seen it).
//   2. Not written, at an empty prompt in a Ravenry pane: the hook's own
//      request is typed now and the marker records the ask; the stop that
//      ends that turn (the real hook) finds the hand-off written.
//   Never typed: working, a dialog, background agents, typed text in the
//   prompt, not a Ravenry pane, another machine, not at rest; a failed
//   typing leaves it queued. Claude Code's dim suggestion is typed over.
//   A hand-off written before the last prompt is not this request's.
//
// The waits that never ended (2026-11-24): Hand off now pressed 11 s after
// a session's stop said "(it is working)": the stop listed a dev server
// left running in the background. The board counted it as work, the hook
// as a task, and no stop came until the person typed in its chat. So:
//   - a shell or a monitor left running holds back neither the board's
//     check (restOf) nor the hook; an agent still does;
//   - a wait says why (a code the board words), a dialog is no longer
//     called "working";
//   - the tick delivers a waiting request once the session is at rest:
//     queued while it works, then at rest, then asked, with the press's
//     time kept; and a request put off (DEFERRED) once its hold is over.
// Usage: node tools/handoff-now-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'handoff-now-test-'));
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'proj');
const TR = path.join(T, 'transcripts');
for (const d of [MC, PROJ, TR]) fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q', PROJ]);
process.env.RAVENRY_HOME = MC;
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
const h = await import('../server/handoff.mjs');
const now = await import('../server/handoffnow.mjs');
const { parseScreen } = await import('../server/screen.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''}`); if (!ok) fails++; };

const BRIEF = path.join(PROJ, 'BRIEF.md');
const OLD_BRIEF = '# Test\n\nGoal: Prove Hand off now at rest.\n\n## Next step\nKeep going.\n\n## Hand-off\n- 2026-11-01 10:00 Older hand-off.\n';
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const withBullet = (at, text) => OLD_BRIEF.replace('## Hand-off\n', `## Hand-off\n- ${stamp(at)} ${text}\n  - State: done.\n`);

let n = 0;
const sidOf = () => `5e55a000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const usage = { input_tokens: 6, cache_creation_input_tokens: 2000, cache_read_input_tokens: 300000, output_tokens: 300 };
const prompt = (text, at) => ({ type: 'user', cwd: PROJ, message: { role: 'user', content: text }, timestamp: at });
const said = (text, at) => ({ type: 'assistant', cwd: PROJ, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage }, timestamp: at });
const wrote = (at) => ({ type: 'assistant', cwd: PROJ, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu' + n, name: 'Edit', input: { file_path: BRIEF, old_string: '## Hand-off\n', new_string: '## Hand-off\n- ...' } }], usage }, timestamp: at });
const done = (at) => ({ type: 'system', subtype: 'turn_duration', cwd: PROJ, timestamp: at });
function transcript(sid, recs) {
  const f = path.join(TR, sid + '.jsonl');
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}

// Screens as Claude Code draws them.
const RULE = '─'.repeat(60);
const screen = (above, inBox = '', below = '  ? for shortcuts') => `${above}\n\n${RULE}\n❯ ${inBox}\n${RULE}\n${below}\n`;
const IDLE = screen('⏺ The work is committed.\n\n✻ Worked for 2m 3s · done 3:47 PM');
const WORKING = screen('⏺ Bash(npm test)\n\n✻ Running the tests… (12s · esc to interrupt)', '', '  esc to interrupt');
const DIALOG = '⏺ Bash(rm -rf build)\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n';
const AGENTS = screen('⏺ Started a background agent.\n\n✻ Worked for 4s · done 3:47 PM', '', '  ◯ research agent (running)');
const DRAFT = screen('⏺ The work is committed.\n\n✻ Worked for 2m 3s · done 3:47 PM', 'also check the', '  ? for shortcuts');

fs.writeFileSync(BRIEF, OLD_BRIEF);
const target = h.resolveHandoffFile({ cwd: PROJ, projectId: 'proj', projects: h.loadSettings().projects });
check('the hand-off goes to the project brief', target.file === BRIEF, target);

// A stand-in pane: what it shows, what was typed, and whether a styled read says the prompt holds a suggestion.
function pane(text, { suggestion = false, typeOk = true } = {}) {
  const p = { typed: [], reads: 0 };
  p.read = async () => { p.reads++; return parseScreen(text); };
  p.suggestion = async () => suggestion;
  p.type = async (t) => { p.typed.push(t); return typeOk ? { ok: true } : { ok: false, error: 'the pane refused the text' }; };
  return p;
}
const AT_REST = { atRest: true, local: true, pane: true, kind: 'claude' };
const ctx = { pct: 31, tokens: 310000, window: 1000000 };
async function press(sid, tr, p, session = {}) {
  return now.request({ session: { sessionId: sid, workspaceId: null, surfaceId: 'ravenry:p' + sid.slice(-7), ...AT_REST, ...session }, prev: h.readMarker(sid), target, cwd: PROJ, transcriptPath: tr, ctx, settings: {}, pane: p });
}

// ---- 1. The real case: asked in the chat, written, finished; then Hand off now.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [
    prompt('Build the booth list.', ago(90)), said('Built.', ago(80)), done(ago(80)),
    prompt('I can hand off this session', ago(3)), wrote(ago(2)), said('The hand-off is written in the brief.', ago(2)), done(ago(2)),
  ]);
  fs.writeFileSync(BRIEF, withBullet(new Date(Date.now() - 2 * 60000), 'The booth list is done; the last contacts are next.'));
  // The rule before this fix: a queued marker sees only a write since it was queued.
  check('before: a write since the press cannot see it (the bug)', h.writtenWhileQueued({ state: 'queued', handoffFile: BRIEF, queuedAt: new Date().toISOString(), cwd: PROJ }, tr) === false);
  const p = pane(IDLE);
  const r = await press(sid, tr, p);
  const m = h.readMarker(sid);
  check('1. written since its last prompt: counted as written', r.state === 'written' && r.delivered === 'written', r);
  check('1. the marker is written, with where the fresh session starts', m && m.state === 'written' && m.handoffFile === BRIEF && m.cwd === PROJ && m.manualAt && m.writtenSeenBy === 'board', m);
  check('1. nothing typed into its pane', p.typed.length === 0 && p.reads === 0);
  // The hook at a later stop leaves a written hand-off alone.
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'handoff-stop.mjs')], { input: JSON.stringify({ session_id: sid, transcript_path: tr, cwd: PROJ, hook_event_name: 'Stop' }), env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' });
  check('1. the hook asks nothing more', hook.status === 0 && !hook.stdout.trim(), hook.stdout + hook.stderr);
}

// ---- A hand-off written in an earlier turn, before the last prompt: not this request's.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [
    prompt('Write a hand-off.', ago(30)), wrote(ago(29)), said('Written.', ago(29)), done(ago(29)),
    prompt('Now fix the header.', ago(5)), said('Fixed and committed.', ago(4)), done(ago(4)),
  ]);
  fs.writeFileSync(BRIEF, withBullet(new Date(Date.now() - 29 * 60000), 'An older hand-off.'));
  const p = pane(IDLE);
  const r = await press(sid, tr, p);
  check('a hand-off written before the last prompt is not counted: it is asked instead', r.state === 'requested' && r.delivered === 'now' && p.typed.length === 1, r);
}

// ---- 2. Not written, at rest at an empty prompt in a Ravenry pane: asked now.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build the booth list.', ago(10)), said('Built and committed.', ago(8)), done(ago(8))]);
  const p = pane(IDLE);
  const r = await press(sid, tr, p);
  const m = h.readMarker(sid);
  check('2. asked now', r.state === 'requested' && r.delivered === 'now', r);
  check('2. typed once: the hook\'s own words, tagged, for a request by hand, naming the brief', p.typed.length === 1 && p.typed[0].startsWith(h.TAG) && p.typed[0].includes('The user asked for a hand-off from Ravenry') && p.typed[0].includes(BRIEF), p.typed[0] && p.typed[0].slice(0, 200));
  check('2. the marker records the ask as the hook does', m.state === 'requested' && m.asks === 1 && !!m.lastAskAt && m.handoffFile === BRIEF && m.handoffBase === h.handoffHash(BRIEF) && m.transcriptPath === tr && m.manualAt && m.askedBy === 'board', m);
  // The turn the request started: the session writes the hand-off and stops; the real hook decides.
  fs.appendFileSync(tr, [prompt(p.typed[0], new Date().toISOString()), wrote(new Date().toISOString()), said(`Hand-off written to ${BRIEF}.`, new Date().toISOString()), done(new Date().toISOString())].map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(BRIEF, withBullet(new Date(), 'The booth list is done; the last contacts are next.'));
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'handoff-stop.mjs')], { input: JSON.stringify({ session_id: sid, transcript_path: tr, cwd: PROJ, hook_event_name: 'Stop', last_assistant_message: `Hand-off written to ${BRIEF}.` }), env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' });
  const m2 = h.readMarker(sid);
  check('2. the stop that ends that turn finds it written and lets it stop', hook.status === 0 && !hook.stdout.trim() && m2.state === 'written' && m2.writtenSeenBy === 'hook', { out: hook.stdout, state: m2.state });
}

// ---- Claude Code's dim suggestion in the prompt (a styled read says so): typed over.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
  const p = pane(screen('⏺ Built.\n\n✻ Worked for 9s · done 3:47 PM', 'commit this'), { suggestion: true });
  const r = await press(sid, tr, p);
  check('a suggestion in the prompt (sure by its style): asked now', r.delivered === 'now' && p.typed.length === 1, r);
}

// ---- Never typed: each keeps today's behaviour, at the next stop.
const refusals = [
  ['working on screen', { text: WORKING }, /working/],
  ['a dialog open', { text: DIALOG }, /dialog/],
  ['background agents running', { text: AGENTS }, /background agents/],
  ['typed text in its prompt', { text: DRAFT }, /text in its prompt/],
  ['a shell, not the assistant', { text: 'user@host:~/proj %' }, /does not show the assistant/],
  ['no tab the board can type into (Terminal, a watch-only tab)', { text: IDLE, session: { pane: false } }, /cannot type/],
  ['on another machine', { text: IDLE, session: { local: false } }, /cannot type/],
  ['not at rest by its events', { text: IDLE, session: { atRest: false } }, /working/],
];
for (const [name, o, why] of refusals) {
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
  const p = pane(o.text, { suggestion: !!o.suggestion });
  const r = await press(sid, tr, p, o.session || {});
  const m = h.readMarker(sid);
  check(`never typed: ${name}; queued for its next stop`, p.typed.length === 0 && r.delivered === 'next stop' && r.state === 'queued' && m.state === 'queued' && !!m.manualAt && !m.asks && why.test(r.why || ''), { r, state: m.state });
}

// ---- Typing failed: back to queued, no ask recorded.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
  const p = pane(IDLE, { typeOk: false });
  const r = await press(sid, tr, p);
  const m = h.readMarker(sid);
  check('a refused typing leaves it queued, with no ask recorded', r.delivered === 'next stop' && m.state === 'queued' && !m.asks && !m.lastAskAt && /could not be typed/.test(r.why), { r, m });
}

// ---- Each wait carries its code, recorded on the marker for the board's words.
{
  const codes = [
    ['working on screen', { text: WORKING }, 'working'],
    ['a dialog open on screen', { text: DIALOG }, 'dialog'],
    ['background agents in its footer', { text: AGENTS }, 'agents'],
    ['typed text in its prompt', { text: DRAFT }, 'draft'],
    ['a dialog by its events (it used to say "it is working")', { text: IDLE, session: { atRest: false, busy: 'dialog' } }, 'dialog'],
    ['agents by its last stop', { text: IDLE, session: { atRest: false, busy: 'agents' } }, 'agents'],
  ];
  for (const [name, o, code] of codes) {
    fs.writeFileSync(BRIEF, OLD_BRIEF);
    const sid = sidOf();
    const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
    const r = await press(sid, tr, pane(o.text), o.session || {});
    const m = h.readMarker(sid);
    check(`the wait says why: ${name}`, r.wait === code && r.why === now.WAITS[code] && m.wait && m.wait.code === code, { r, wait: m.wait });
  }
}

// ---- Root cause 1 (2026-11-24): its last stop listed a dev server left running.
{
  const stop = (kinds, n = 1) => ({ event: 'Stop', at: ago(0.2), background_tasks: n, ...(kinds ? { background_kinds: kinds } : {}) });
  const shell = now.restOf({ live: true, working: true, dialog: false, last: stop(['shell']) });
  check('restOf: working only because a shell is left running: at rest, the fresh read decides', shell.atRest === true && shell.busy === null, shell);
  const mon = now.restOf({ live: true, working: true, dialog: false, last: stop(['monitor', 'shell'], 2) });
  check('restOf: a monitor and a shell: at rest', mon.atRest === true, mon);
  const agent = now.restOf({ live: true, working: true, dialog: false, last: stop(['shell', 'subagent'], 2) });
  check('restOf: an agent still running: it waits for the agents', agent.atRest === false && agent.busy === 'agents', agent);
  const old = now.restOf({ live: true, working: true, dialog: false, last: stop(null) });
  check('restOf: a stop recorded before the kinds were: at rest, the read decides', old.atRest === true, old);
  const turn = now.restOf({ live: true, working: true, dialog: false, last: { event: 'UserPromptSubmit', at: ago(0.1) } });
  check('restOf: mid-turn by its events: working', turn.atRest === false && turn.busy === 'working', turn);
  const dlg = now.restOf({ live: true, working: false, dialog: true, last: null });
  check('restOf: a dialog: dialog, not "working"', dlg.atRest === false && dlg.busy === 'dialog', dlg);
  check('restOf: not live: gone', now.restOf({ live: false }).busy === 'gone');

  // The press itself, as the hub makes it: a session at rest at its prompt with a dev server left running.
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Restart the dev server and fix the header.', ago(3)), said('Fixed; the dev server runs on port 5300.', ago(0.2)), done(ago(0.2))]);
  const p = pane(screen('⏺ Fixed; the dev server runs on port 5300.\n\n✻ Worked for 40s · done 3:47 PM', '', '  1 shell · ? for shortcuts'));
  const r = await press(sid, tr, p, { atRest: shell.atRest, busy: shell.busy });
  check('root cause 1: a dev server left running no longer holds Hand off now: asked now', r.delivered === 'now' && p.typed.length === 1, r);
  check('root cause 1: the words say a server left running is not a task', p.typed[0] && p.typed[0].includes('A server or watcher left running in the background'), p.typed[0] && p.typed[0].slice(0, 120));

  // The record a Stop makes carries the kinds the board reads.
  const { record } = await import('../server/hookrecord.mjs');
  const rec = record('claude', { hook_event_name: 'Stop', session_id: sid, transcript_path: tr, cwd: PROJ, background_tasks: [{ id: 'bdev1', type: 'shell', status: 'running' }, { id: 'adone', type: 'dream', status: 'running' }] }, { tasks: true });
  check('the Stop record names the kinds still running (housekeeping left out)', rec && rec.background_tasks === 1 && JSON.stringify(rec.background_kinds) === '["shell"]', rec && { n: rec.background_tasks, kinds: rec.background_kinds });
}

// ---- Root cause 1, the hook's half: at a stop with a dev server left running, a request by hand is asked; an agent still holds it.
{
  const hookAt = (sid, tr, tasks) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'handoff-stop.mjs')], { input: JSON.stringify({ session_id: sid, transcript_path: tr, cwd: PROJ, hook_event_name: 'Stop', last_assistant_message: 'Done.', background_tasks: tasks }), env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' });
  const SHELL = [{ id: 'bdevsrv1', type: 'shell', status: 'running', description: 'dev server' }];
  const AGENT = [{ id: 'aresearch1', type: 'subagent', status: 'running', agent_type: 'general-purpose' }];
  for (const [name, tasks, manual, asked] of [
    ['by hand, a dev server left running: asked', SHELL, true, true],
    ['by hand, a background agent running: it waits', [...SHELL, ...AGENT], true, false],
    ['past the line on its own, a dev server running: it waits, as before', SHELL, false, false],
  ]) {
    fs.writeFileSync(BRIEF, OLD_BRIEF);
    const sid = sidOf();
    const tr = transcript(sid, [prompt('Fix the header.', ago(3)), said('Fixed.', ago(1)), done(ago(1))]);
    if (manual) h.writeMarker(sid, { state: 'queued', manualAt: ago(0.5), queuedAt: ago(0.5) });
    else fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { handoffThreshold: 10 }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
    const out = hookAt(sid, tr, tasks);
    if (!manual) fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
    const m = h.readMarker(sid);
    const blocked = /"decision"\s*:\s*"block"/.test(out.stdout);
    check(`hook: ${name}`, out.status === 0 && blocked === asked && m && m.state === (asked ? 'requested' : 'queued'), { out: out.stdout.slice(0, 120), err: out.stderr.slice(0, 200), state: m && m.state, why: m && m.lastCheck && m.lastCheck.why });
  }
}

// ---- waiting(): which requests the tick takes up again.
{
  const t0 = Date.now();
  const iso = (msAgo) => new Date(t0 - msAgo).toISOString();
  check('waiting: queued by hand', now.waiting({ state: 'queued', manualAt: iso(1000) }, t0) === true);
  check('waiting: queued past the line, not by hand: the hook\'s', now.waiting({ state: 'queued' }, t0) === false);
  check('waiting: asked and not answered yet: the stop that ends its turn has it', now.waiting({ state: 'requested', manualAt: iso(60000), lastAskAt: iso(30000) }, t0) === false);
  check('waiting: asked, put off, its hold still on', now.waiting({ state: 'requested', manualAt: iso(600000), lastAskAt: iso(120000), deferredAt: iso(60000) }, t0) === false);
  check('waiting: asked, put off, its hold over (10 min)', now.waiting({ state: 'requested', manualAt: iso(1800000), lastAskAt: iso(1300000), deferredAt: iso(1200000) }, t0) === true);
  check('waiting: put off, then Hand off now pressed again', now.waiting({ state: 'requested', manualAt: iso(1000), lastAskAt: iso(120000), deferredAt: iso(60000) }, t0) === true);
  check('waiting: written', now.waiting({ state: 'written', manualAt: iso(1000) }, t0) === false);
}

// ---- Queued while it works, then it comes to rest: the tick delivers it.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build the booth list.', ago(10)), said('Building.', ago(9))]);
  const busy = pane(WORKING);
  const r1 = await press(sid, tr, busy, { atRest: false, busy: 'working' });
  const m1 = h.readMarker(sid);
  check('queued: pressed while it works, nothing typed, it says it waits for the turn', r1.delivered === 'next stop' && r1.wait === 'working' && busy.typed.length === 0 && m1.state === 'queued' && now.waiting(m1), { r1, m1: m1.wait });
  // Still working at the next tick: the same wait is not written again.
  await new Promise((r) => setTimeout(r, 15));
  const again = await now.request({ session: { sessionId: sid, surfaceId: 'ravenry:p1', ...AT_REST, atRest: false, busy: 'working' }, prev: h.readMarker(sid), target, cwd: PROJ, transcriptPath: tr, ctx, pane: busy, by: 'tick' });
  const m1b = h.readMarker(sid);
  check('the tick, still working: same wait, the marker left as it was', again.delivered === 'next stop' && m1b.updatedAt === m1.updatedAt && m1b.manualAt === m1.manualAt, { a: m1.updatedAt, b: m1b.updatedAt });
  // The turn ends; the session sits at its prompt with Claude's dim suggestion.
  fs.appendFileSync(tr, [said('Built and committed.', ago(1)), done(ago(1))].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const idle = pane(screen('⏺ Built and committed.\n\n✻ Worked for 9m · done 3:47 PM', 'commit this'), { suggestion: true });
  const probes = [];
  idle.suggestion = async (_sc, o = {}) => { probes.push(o.probe); return true; };
  const r2 = await now.request({ session: { sessionId: sid, surfaceId: 'ravenry:p1', ...AT_REST }, prev: h.readMarker(sid), target, cwd: PROJ, transcriptPath: tr, ctx, pane: idle, by: 'tick' });
  const m2 = h.readMarker(sid);
  check('delivered: at rest now, the tick asks it to hand off', r2.delivered === 'now' && idle.typed.length === 1 && idle.typed[0].includes('The user asked for a hand-off from Ravenry'), r2);
  check('delivered: the press\'s time kept, the ask recorded, the wait cleared', m2.state === 'requested' && m2.manualAt === m1.manualAt && m2.queuedAt === m1.queuedAt && m2.asks === 1 && m2.askedBy === 'board' && m2.wait === null && !now.waiting(m2), m2);
  check('the tick never probes the prompt (a styled read only)', probes.length === 1 && probes[0] === false, probes);
}

// ---- Asked by hand, put off (DEFERRED), the session at rest when the hold ends: asked again.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Run the long tests.', ago(30)), said('Tests pass.', ago(12)), done(ago(12))]);
  h.writeMarker(sid, { state: 'requested', manualAt: ago(25), queuedAt: ago(25), requestedAt: ago(24), lastAskAt: ago(24), asks: 1, deferredAt: ago(23), askedBy: 'board' });
  const p = pane(IDLE);
  const prev = h.readMarker(sid);
  check('put off 23 min ago: waiting again', now.waiting(prev));
  const r = await now.request({ session: { sessionId: sid, surfaceId: 'ravenry:p2', ...AT_REST }, prev, target, cwd: PROJ, transcriptPath: tr, ctx, pane: p, by: 'tick' });
  const m = h.readMarker(sid);
  check('put off, hold over, at rest: asked again by the tick', r.delivered === 'now' && p.typed.length === 1 && m.asks === 2 && m.manualAt === prev.manualAt && !now.waiting(m), { r, asks: m.asks });
}

// ---- The tick in a terminal with no styled read (iTerm2, Rex): text it cannot judge waits, said as such; nothing typed.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
  h.writeMarker(sid, { state: 'queued', manualAt: ago(1), queuedAt: ago(1) });
  const p = pane(screen('⏺ Built.\n\n✻ Worked for 9s · done 3:47 PM', 'commit this'));
  p.suggestion = async (_sc, o = {}) => (o.probe ? true : 'unsure');
  const r = await now.request({ session: { sessionId: sid, surfaceId: 'iterm:x', ...AT_REST }, prev: h.readMarker(sid), target, cwd: PROJ, transcriptPath: tr, ctx, pane: p, by: 'tick' });
  check('the tick, unsure of the text in an iTerm2 prompt: nothing typed, its wait says so', p.typed.length === 0 && r.wait === 'unsure' && h.readMarker(sid).wait.code === 'unsure', r);
}

// ---- The hook asked at a stop while the tick read the screen: the tick types nothing.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
  h.writeMarker(sid, { state: 'queued', manualAt: ago(1), queuedAt: ago(1) });
  const prev = h.readMarker(sid);
  const p = pane(IDLE);
  const read = p.read;
  p.read = async () => { h.writeMarker(sid, { state: 'requested', asks: 1, lastAskAt: new Date().toISOString(), askedBy: undefined }); return read(); };
  const r = await now.request({ session: { sessionId: sid, surfaceId: 'ravenry:p4', ...AT_REST }, prev, target, cwd: PROJ, transcriptPath: tr, ctx, pane: p, by: 'tick' });
  const m = h.readMarker(sid);
  check('asked by the hook meanwhile: the tick types nothing and leaves the ask as the hook made it', p.typed.length === 0 && r.delivered === 'next stop' && m.state === 'requested' && m.asks === 1, { r, asks: m.asks });
}

// ---- A refused typing from the tick: still waiting, tried again later, nothing recorded as asked.
{
  fs.writeFileSync(BRIEF, OLD_BRIEF);
  const sid = sidOf();
  const tr = transcript(sid, [prompt('Build it.', ago(10)), said('Built.', ago(8)), done(ago(8))]);
  h.writeMarker(sid, { state: 'queued', manualAt: ago(1), queuedAt: ago(1), wait: { code: 'working', why: now.WAITS.working, at: ago(1) } });
  const r = await now.request({ session: { sessionId: sid, surfaceId: 'ravenry:p3', ...AT_REST }, prev: h.readMarker(sid), target, cwd: PROJ, transcriptPath: tr, ctx, pane: pane(IDLE, { typeOk: false }), by: 'tick' });
  const m = h.readMarker(sid);
  check('a refused typing: queued, waiting, its wait says so', r.wait === 'typing' && m.state === 'queued' && !m.asks && m.wait.code === 'typing' && now.waiting(m), { r, m: m.wait });
}

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
