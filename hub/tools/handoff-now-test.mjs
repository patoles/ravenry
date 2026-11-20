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
  ['not a Ravenry pane (cmux, iTerm2, Rex, Terminal)', { text: IDLE, session: { pane: false } }, /Ravenry pane/],
  ['on another machine', { text: IDLE, session: { local: false } }, /Ravenry pane/],
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

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
