#!/usr/bin/env node
// The assistant interface (server/assistant.mjs, docs/ASSISTANTS.md) on
// captured screens and crafted input. Touches only .tmp/.
//
// 1. Claude Code reads exactly as before: every captured Claude screen
//    (tools/fixtures/live/, menus/, prompt/) is Claude Code's through
//    parseAny, with the same parseScreen output as server/screen.mjs at
//    76873a4 (before the interface; skipped where that history is absent),
//    and the same menu.
// 2. Codex's screen (tools/fixtures/codex/, captured from a scratch Codex
//    0.166.0 session in cmux; private, skipped where absent): composer,
//    placeholder, typed text, shell mode, spinner, done line, the approval
//    and folder-trust menus, the exit screens, the Live screen's trim.
// 3. Choosing a Codex menu option with the arrows, against the captured menus.
// 4. The events hook with --assistant=codex on Codex's real hook inputs: its
//    lines, PermissionRequest as a permission_prompt Notification, Interrupt.
//    Then the state rules on them.
// 5. A Codex rollout read like a transcript: context, window, model, last
//    message, prompts, turn ends, an interrupt.
// 6. Codex's hook trust hash against the five cmux wrote (and Codex
//    accepted), then setup and uninstall on a scratch CODEX_HOME holding
//    cmux's hooks: every cmux entry kept, ours added with trust entries,
//    removal giving back both files.
// 7. The hand-off hook with --assistant=codex blocks a stop past the line,
//    with the Codex wording, reading the rollout's own window.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'assistant-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
process.env.RAVENRY_HOME = MC;
const CODEX_HOME = path.join(T, 'codex-home');
process.env.MC_CODEX_HOME = CODEX_HOME;

const asst = await import('../server/assistant.mjs');
const { parseScreen } = await import('../server/screen.mjs');
const { readMenu } = await import('../server/choose.mjs');
const codexRollout = await import('../server/codexrollout.mjs');
const cx = await import('../server/codexhooks.mjs');
const hk = await import('../server/hookinstall.mjs');
const events = await import('../server/events.mjs');
const state = await import('../server/state.mjs');
const { DEFAULT_SETTINGS } = await import('../server/registry.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`); if (!ok) fails++; };
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const FIX = path.join(ROOT, 'tools', 'fixtures');

// ------------------------------------------------------------ 1. Claude Code as before
const claudeFiles = [];
for (const d of ['live', 'menus', 'prompt']) {
  const dir = path.join(FIX, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.txt')) claudeFiles.push(path.join(d, f));
}
let OLD = null;
try {
  const src = execFileSync('git', ['-C', ROOT, 'show', '76873a4:server/screen.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const p = path.join(T, 'screen-76873a4.mjs');
  fs.writeFileSync(p, src);
  OLD = await import(pathToFileURL(p).href);
} catch { console.log('SKIP  parseScreen at 76873a4 (that history is not in this copy)'); }
const crafted = [
  '',
  'user@host:~/x % ',
  ['⏺ Done.', '', '✻ Worked for 3s · done 1:09 AM', '', '────────────────────────────────────────', '❯ half typed', '────────────────────────────────────────', '  ⏵⏵ auto mode on'].join('\n'),
  ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel · Tab to amend'].join('\n'),
];
let n = 0; let kinds = 0; let olds = 0; let menus = 0;
for (const f of claudeFiles) {
  const text = fs.readFileSync(path.join(FIX, f), 'utf8');
  const a = asst.parseAny(text);
  n++;
  if (a.kind === 'claude' && same(a.screen, parseScreen(text)) && same(asst.parseScreen(text, 'claude'), parseScreen(text))) kinds++;
  else console.log('      differs:', f, a.kind);
  if (OLD && same(OLD.parseScreen(text), parseScreen(text)) && same(OLD.parseScreen(text), a.screen)) olds++;
  if (same(asst.readMenu('claude', text), readMenu(text))) menus++;
}
for (const text of crafted) {
  const a = asst.parseAny(text);
  n++;
  if (a.kind === 'claude' && same(a.screen, parseScreen(text))) kinds++;
  if (OLD && same(OLD.parseScreen(text), a.screen)) olds++;
  if (same(asst.readMenu('claude', text), readMenu(text))) menus++;
}
check(`Claude Code: every captured and crafted screen (${n}) reads as Claude Code's, exactly as server/screen.mjs reads it`, kinds === n, `${kinds} of ${n}`);
if (OLD) check(`Claude Code: the same parseScreen output as before the interface (76873a4) on all ${n}`, olds === n, `${olds} of ${n}`);
check(`Claude Code: the same menu on all ${n}`, menus === n, `${menus} of ${n}`);
check('a session or event with no assistant is Claude Code', asst.kindOf({}) === 'claude' && asst.kindOf(null) === 'claude' && asst.kindOf({ assistant: 'nope' }) === 'claude' && asst.kindOf({ assistant: 'codex' }) === 'codex');
check('what each shows: Claude Code everything, Codex no pictures, suggestion, background tasks or process memory',
  ['suggestion', 'pictures', 'backgroundTasks', 'processes', 'handoff'].every((w) => asst.supports('claude', w)) && ['suggestion', 'pictures', 'backgroundTasks', 'processes'].every((w) => !asst.supports('codex', w)) && asst.supports('codex', 'handoff'));
{
  const t = (x) => asst.parseTitle(x, 'codex');
  check('Codex titles: a spinner is working, the thread is the topic, an approval and the folder alone read right',
    t('⠙ Reply with board-ok | work').busy && t('⠙ Reply with board-ok | work').topic === 'Reply with board-ok' && !t('Reply with board-ok | work').busy && t('Reply with board-ok | work').topic === 'Reply with board-ok'
    && t('[ ! ] Action Required | Reply with board-ok | work').topic === 'Reply with board-ok' && t('⠙ work').busy && t('⠙ work').topic === null && !t('work').claude && !t('user@host:~/x').claude);
}
check('rules files: CLAUDE.md and AGENTS.md', asst.rulesFile('claude') === 'CLAUDE.md' && asst.rulesFile('codex') === 'AGENTS.md');

// ------------------------------------------------------------ 2. Codex's screen
const CX = path.join(FIX, 'codex');
const HAVE = fs.existsSync(path.join(CX, '10-done2.txt'));
const rd = (f) => fs.readFileSync(path.join(CX, f), 'utf8');
if (!HAVE) console.log('SKIP  Codex screens (tools/fixtures/codex/ is not in this copy)');
else {
  const p = (f) => asst.parseAny(rd(f));
  const at = p('10-done2.txt');
  check('Codex at rest: its screen, live, the placeholder is no draft, the done line read', at.kind === 'codex' && at.screen.claudeLive && at.screen.draft === '' && !at.screen.working && at.screen.done && at.screen.done.took === '1s' && at.screen.done.when === '12:04', JSON.stringify(at.screen.done));
  check('Codex at rest: Claude Code\'s reading does not claim it', !parseScreen(rd('10-done2.txt')).claudeLive);
  const typed = p('03-typed.txt').screen;
  check('Codex: typed text in the composer is a draft', typed.draft === 'Reply with exactly the word: pong');
  check('Codex: a two-line draft keeps both lines', p('23-draft-multi.txt').screen.draft === 'first line of a draft\nsecond line of the draft');
  check('Codex: shell mode ("!") is typed text', p('21-bang.txt').screen.draft === '!');
  const w = p('09-w-1.txt').screen;
  check('Codex working: the spinner line, its words', w.working && w.busyLine === 'Working (0s • esc to interrupt)', w.busyLine);
  const tool = p('17-tool-running.txt').screen;
  check('Codex working on a tool, a history prompt above it is not the composer', tool.working && tool.draft === '' && tool.claudeLive);
  check('Codex working with a reply typed: working and a draft', p('18-typed-while-working.txt').screen.working && p('18-typed-while-working.txt').screen.draft === 'Then reply with exactly: queued-ok');
  const perm = p('14-permission.txt');
  check('Codex approval: Codex\'s (not Claude Code\'s, whose reading also matches it)', perm.kind === 'codex' && parseScreen(rd('14-permission.txt')).claudeLive);
  const d = perm.screen.dialog;
  check('Codex approval: question, three options, the first selected, a wrapped option joined', d && /^Reason: Do you want to allow/.test(d.question) && d.options.length === 3 && d.options[0].selected && d.options[0].label === 'Yes, proceed (y)' && /outside\.txt` \(p\)$/.test(d.options[1].label) && d.options[2].label === 'No, and tell Codex what to do differently (esc)', JSON.stringify(d && d.options));
  const wrapped = rd('14-permission.txt').replace('  Reason: Do you want to allow creating the requested file outside the workspace?', '  Reason: Allow creating the requested file outside the workspace writable\n  root?');
  check('Codex approval: a reason wrapped onto two lines is one question', asst.parseScreen(wrapped, 'codex').dialog.question === 'Reason: Allow creating the requested file outside the workspace writable root?', asst.parseScreen(wrapped, 'codex').dialog.question);
  const no = p('15-perm-no.txt').screen.dialog;
  check('Codex approval moved to No: the third selected', no && no.options[2].selected && !no.options[0].selected);
  const trust = p('01-trust.txt');
  check('Codex folder trust: a menu of two, the first selected', trust.kind === 'codex' && trust.screen.dialog && trust.screen.dialog.options.map((o) => o.label).join('|') === 'Trust and continue|Quit' && trust.screen.dialog.options[0].selected);
  const ex = asst.parseScreen(rd('06-exited.txt'), 'codex');
  check('Codex exited: a shell, exited, the resume id', !ex.claudeLive && ex.shell && ex.exited && ex.resumeId === (rd('06-exited.txt').match(/codex resume (\S+)/) || [])[1], JSON.stringify({ s: ex.shell, e: ex.exited, r: ex.resumeId }));
  const dm = asst.parseScreen(rd('26-exited-daemon.txt'), 'codex');
  check('Codex exited from its daemon ("Disconnected from this task."): a shell, exited, its own resume id', !dm.claudeLive && dm.exited && dm.resumeId === [...rd('26-exited-daemon.txt').matchAll(/codex resume (\S+)/g)].pop()[1] && dm.resumeId !== ex.resumeId);
  check('Codex interrupted (Esc): at rest, empty', p('24-esc.txt').screen.claudeLive && !p('24-esc.txt').screen.working && p('24-esc.txt').screen.draft === '');
  check('every captured Codex screen is Codex\'s or a shell, never Claude Code\'s', fs.readdirSync(CX).filter((f) => f.endsWith('.txt')).every((f) => { const a = asst.parseAny(rd(f)); return a.kind === 'codex' || !a.screen.claudeLive; }));
  const tr = asst.trimScreen(rd('12-blocked.txt'), 'codex');
  const ks = tr.entries.map((e) => e.k).join('');
  check('Codex Live screen: prompts, replies, the hook\'s block as a tool line, done lines; no composer or footer',
    tr.live && tr.entries.some((e) => e.k === 'u' && e.l[0] === 'Reply with exactly the word: ping') && tr.entries.some((e) => e.k === 'c' && e.l[0] === 'BLOCKED-AND-CONTINUED') && tr.entries.some((e) => e.k === 't' && e.n === 'Blocked by hook' && e.m === 1) && tr.entries.filter((e) => e.k === 's').length === 2 && !JSON.stringify(tr).includes('for shortcuts') && !JSON.stringify(tr).includes('Ask Codex to do anything'), ks);
  const tr2 = asst.trimScreen(rd('20-after-steer.txt'), 'codex');
  check('Codex Live screen: a command run is one line with its output counted, a Tip under a reply dropped', tr2.entries.some((e) => e.k === 't' && e.n === 'Ran' && e.a === 'sleep 12' && e.m === 0) && !JSON.stringify(tr2).includes('Tip:'), JSON.stringify(tr2.entries.filter((e) => e.k === 't')));
  const tr4 = asst.trimScreen(rd('31-handoff-done.txt'), 'codex');
  check('Codex Live screen: a bare "└" output line and "+ 2 lines" folded count for the tool', tr4.entries.some((e) => e.k === 't' && /^pwd && sed/.test(e.a) && e.m === 4) && !tr4.entries.some((e) => e.k === 'p' && e.l.some((l) => /Goal: prove/.test(l))), JSON.stringify(tr4.entries.filter((e) => e.k === 't').map((e) => [e.a.slice(0, 12), e.m])));
  check('Codex Live screen: "Exited (status 1) <command>" is a tool line', asst.trimScreen(rd('17-tool-running.txt'), 'codex').entries.some((e) => e.k === 't' && e.n === 'Exited (status 1)' && /^touch /.test(e.a)));
  const tr3 = asst.trimScreen(rd('14-permission.txt'), 'codex');
  check('Codex Live screen: an open approval shows as it is drawn', tr3.entries.some((e) => e.k === 'p' && e.l.some((l) => /1\. Yes, proceed/.test(l))));
  check('Codex Live screen: the spinner\'s words in the status', asst.trimScreen(rd('09-w-1.txt'), 'codex').status.busy === 'Working (0s • esc to interrupt)');

  // ------------------------------------------------------------ 3. a menu option
  // A fake tab that plays the captured approval: Down and Up move its "›"
  // (as the real one did, 15-perm-no.txt), Enter closes it.
  const base = rd('14-permission.txt').split('\n');
  const optAt = (n) => base.findIndex((l) => new RegExp(`^[› ] ${n}\\. `).test(l));
  const frame = (sel) => base.map((l, i) => ([1, 2, 3].some((n) => optAt(n) === i) ? (i === optAt(sel) ? '›' : ' ') + l.slice(1) : l)).join('\n');
  check('the fake approval puts "›" where the real one did after Down Down', asst.parseScreen(frame(3), 'codex').dialog.options.map((o) => o.selected).join() === asst.parseScreen(rd('15-perm-no.txt'), 'codex').dialog.options.map((o) => o.selected).join());
  let sel = 1; let closed = false; const keys = [];
  const r = await asst.chooseOption('codex', {
    read: async () => (closed ? rd('16-after-no.txt') : frame(sel)),
    key: async (k) => { keys.push(k); if (k === 'down') sel++; if (k === 'up') sel--; if (k === 'enter') closed = true; return { ok: true }; },
    want: 3, where: 'cmux', pollMs: 5, settleMs: 200, afterMs: 200,
  });
  check('Codex menu: No chosen with Down Down Enter, the menu gone after', r.ok && r.sent === 'No, and tell Codex what to do differently (esc)' && keys.join(' ') === 'down down enter' && r.after === 'closed', JSON.stringify(r));
}

// ------------------------------------------------------------ 4. the events hook for Codex
const inputs = HAVE ? fs.readFileSync(path.join(CX, 'hook-inputs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
if (inputs.length) {
  const EV = path.join(MC, 'events');
  const env = { ...process.env, RAVENRY_HOME: MC, MC_BOARD_URL: 'http://127.0.0.1:9' };
  delete env.CMUX_SURFACE_ID; delete env.CMUX_WORKSPACE_ID;
  const t0 = Date.now();
  for (const x of inputs) spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'events.mjs'), '--assistant=codex'], { input: JSON.stringify(x), env, encoding: 'utf8' });
  const ms = (Date.now() - t0) / inputs.length;
  const sid = inputs[inputs.length - 1].session_id;
  const lines = fs.readFileSync(path.join(EV, sid + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('Codex events: every line says assistant codex, none claude_pid', lines.every((l) => l.assistant === 'codex' && !l.claude_pid && l.codex_pid));
  const perm = lines.find((l) => l.source_event === 'PermissionRequest');
  check('Codex PermissionRequest: recorded as a permission_prompt Notification with its reason', perm && perm.event === 'Notification' && perm.notification_type === 'permission_prompt' && perm.message === 'Do you want to allow creating the requested file outside the workspace?' && perm.title === 'Bash', JSON.stringify(perm));
  check('Codex Interrupt: its own event', lines.some((l) => l.event === 'Interrupt'));
  const stops = lines.filter((l) => l.event === 'Stop');
  check('Codex Stop: no background tasks, the hook\'s continuation marked', stops.length === 4 && stops.every((s) => s.background_tasks === 0) && stops.some((s) => s.stop_hook_active), JSON.stringify(stops.map((s) => [s.background_tasks, s.stop_hook_active])));
  console.log(`      (${ms.toFixed(0)} ms per event, with a board that does not answer)`);
  // The state rules on them.
  const all = events.scan();
  const s = all.get(sid);
  check('the summary carries assistant codex', s && s.assistant === 'codex');
  const settings = { ...DEFAULT_SETTINGS };
  const at = (e) => Date.parse(e.at);
  const upTo = (pred) => { const i = lines.findIndex(pred); return events.summarize(sid, lines.slice(0, i + 1)); };
  const sp = upTo((l) => l.source_event === 'PermissionRequest');
  const st1 = state.eventState({ ev: sp, screen: null, screenAt: null, title: null, transcript: null }, settings, at(sp.last) + 1000);
  check('state: Codex asking for approval is a dialog (Needs you), its reason as the line', st1 && st1.state === 'dialog' && st1.ntype === 'permission_prompt' && /outside the workspace/.test(st1.message), JSON.stringify(st1));
  const si = upTo((l) => l.event === 'Interrupt');
  const st2 = state.eventState({ ev: si, screen: null, screenAt: null, title: null, transcript: null }, settings, at(si.last) + 1000);
  check('state: after an Interrupt, at rest (handback), "turn interrupted"', st2 && st2.state === 'handback' && /turn interrupted/.test(st2.reasons[0]), JSON.stringify(st2));
  const lastPrompt = events.summarize(sid, lines.slice(0, lines.findIndex((l, i) => i > lines.findIndex((x) => x.event === 'Interrupt') && l.event === 'UserPromptSubmit') + 1));
  const st3 = state.eventState({ ev: lastPrompt, screen: null, screenAt: null, title: null, transcript: null }, settings, at(lastPrompt.last) + 1000);
  check('state: a prompt sent is working', st3 && st3.state === 'working');
}

// Codex's daemon: its hooks carry another terminal's ids, so none are kept.
{
  const { codexDaemon } = await import('../server/assistanthook.mjs');
  const { spawn } = await import('node:child_process');
  const d = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)', 'app-server', '--listen', 'unix://'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  check('a parent that is `codex app-server` is the daemon; this test is not', (await codexDaemon(d.pid)) && !(await codexDaemon(process.pid)));
  d.kill();
}

// ------------------------------------------------------------ 5. a rollout
if (HAVE) {
  const t = asst.readTranscript('codex', path.join(CX, 'rollout.jsonl'));
  check('Codex rollout: context from the last request, the model\'s own window, the model', t && t.contextTokens === 13152 && t.contextWindow === 258400 && t.model === 'gpt-5.6-luna', JSON.stringify(t && { c: t.contextTokens, w: t.contextWindow, m: t.model }));
  check('Codex rollout: the last thing Codex said, the last prompt typed, its cwd', t.lastText === 'queued-ok' && /sleep 20, then reply with exactly: late$/.test(t.lastPrompt) && /codex-live\/work$/.test(t.cwd), `${t.lastText} | ${t.lastPrompt}`);
  check('Codex rollout: a hook\'s reason and Codex\'s own context are not prompts; an interrupt ends the turn', !/BLOCKED/.test(t.lastPrompt) && t.lastInterruptAt && t.lastTurnEndAt === t.lastInterruptAt && !t.inTurn);
  check('Codex rollout: turns with their text, newest first; a "! command" turn has none', JSON.stringify(t.turns.map((x) => x.text)) === JSON.stringify(['queued-ok', 'BLOCKED-AND-CONTINUED', 'pong']), JSON.stringify(t.turns.map((x) => x.text)));
  check('Codex rollout: the first prompt, for a hand-off\'s fresh session', asst.firstPrompt('codex', path.join(CX, 'rollout.jsonl')) === 'Reply with exactly the word: pong');
  check('Codex rollout: no folder guess from tool calls (scripts), so the hook\'s cwd decides', asst.workFolder('codex', path.join(CX, 'rollout.jsonl')) === null);
  // Found by session id under a scratch CODEX_HOME.
  const day = path.join(CODEX_HOME, 'sessions', '2026', '11', '04');
  fs.mkdirSync(day, { recursive: true });
  const rid = JSON.parse(fs.readFileSync(path.join(CX, 'rollout.jsonl'), 'utf8').split('\n')[0]).payload.id;
  fs.copyFileSync(path.join(CX, 'rollout.jsonl'), path.join(day, `rollout-2026-11-04T12-04-15-${rid}.jsonl`));
  check('Codex rollout found by session id', asst.findTranscript('codex', rid) === path.join(day, `rollout-2026-11-04T12-04-15-${rid}.jsonl`));
}

// ------------------------------------------------------------ 6. trust and setup
const CM = HAVE ? JSON.parse(fs.readFileSync(path.join(CX, 'cmux-hooks.json'), 'utf8')) : null;
if (CM) {
  const LABEL = { PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', SessionStart: 'session_start', Stop: 'stop', UserPromptSubmit: 'user_prompt_submit' };
  let ok = 0;
  for (const [ev, groups] of Object.entries(CM.hooks.hooks)) if (cx.trustHash(ev, groups[0], groups[0].hooks[0]) === CM.trusted[`${LABEL[ev]}:0:0`]) ok++;
  check('Codex trust hash: the same as Codex accepted for all five of cmux\'s hooks', ok === 5, `${ok} of 5`);

  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const HF = path.join(CODEX_HOME, 'hooks.json');
  const CF = path.join(CODEX_HOME, 'config.toml');
  const hooksRaw = JSON.stringify(CM.hooks, null, 2) + '\n';
  // cmux's own config: its feature flag and its trust entries, with this file's path.
  const cmuxToml = ['model = "gpt-5.6-luna"', '', '[projects."/Users/x/project"]', 'trust_level = "trusted"', '', '[features]', 'hooks = true', '',
    ...Object.entries(CM.trusted).flatMap(([k, h]) => [`[hooks.state."${HF}:${k}"]`, `trusted_hash = "${h}"`]), ''].join('\n');
  fs.writeFileSync(HF, hooksRaw);
  fs.writeFileSync(CF, cmuxToml);
  const plan = hk.codexPlan();
  check('setup plan for Codex: our two scripts on their events, the trust entries', plan.changes.filter((c) => / added /.test(c)).length === 7 && plan.changes.some((c) => /config\.toml/.test(c)), plan.changes.join(' | '));
  hk.codexWrite(plan);
  const j = JSON.parse(fs.readFileSync(HF, 'utf8'));
  const cmds = (ev) => (j.hooks[ev] || []).flatMap((g) => g.hooks.map((h) => h.command));
  check('setup: every cmux hook kept as it was, first in its list', Object.keys(CM.hooks.hooks).every((ev) => JSON.stringify(j.hooks[ev][0]) === JSON.stringify(CM.hooks.hooks[ev][0])));
  check('setup: events.mjs --assistant=codex on SessionStart, SessionEnd, UserPromptSubmit, Stop, PermissionRequest, Interrupt; handoff-stop.mjs on Stop',
    ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Interrupt'].every((ev) => cmds(ev).some((c) => c.endsWith(path.join(ROOT, 'hooks', 'events.mjs') + ' --assistant=codex'))) && cmds('Stop').some((c) => c.endsWith('handoff-stop.mjs --assistant=codex')));
  check('setup: SessionEnd and Interrupt timeouts within Codex\'s 3 s', ['SessionEnd', 'Interrupt'].every((ev) => j.hooks[ev].every((g) => g.hooks.every((h) => h.timeout <= 3))));
  const toml = fs.readFileSync(CF, 'utf8');
  check('setup: config.toml keeps every line it had, and adds one marked block', toml.startsWith(cmuxToml.trimEnd()) && (toml.match(/ravenry-codex-hook-trust begin/g) || []).length === 1);
  const st = hk.codexStatus();
  check('status after setup: ok, every hook of ours trusted', st.state === 'ok' && st.untrusted.length === 0, JSON.stringify(st));
  check('backups of both files as they were', fs.readdirSync(CODEX_HOME).filter((f) => /^hooks\.json\.bak-/.test(f)).map((f) => fs.readFileSync(path.join(CODEX_HOME, f), 'utf8')).includes(hooksRaw) && fs.readdirSync(CODEX_HOME).filter((f) => /^config\.toml\.bak-/.test(f)).map((f) => fs.readFileSync(path.join(CODEX_HOME, f), 'utf8')).includes(cmuxToml));
  check('setup again: nothing to change', hk.codexPlan().changes.length === 0, hk.codexPlan().changes.join(' | '));
  // A trust entry Codex's /hooks wrote for one of ours is never doubled.
  const key = `${HF}:stop:1:0`;
  fs.writeFileSync(CF, fs.readFileSync(CF, 'utf8').replace('# ravenry-codex-hook-trust begin', `[hooks.state."${key}"]\ntrusted_hash = "sha256:old"\n\n# ravenry-codex-hook-trust begin`));
  const again = hk.codexPlan();
  check('a trust entry for one of ours outside the block is replaced, never doubled', (again.config.text.split(`[hooks.state."${key}"]`).length - 1) === 1 && !again.config.text.includes('sha256:old'));
  hk.codexWrite(again);
  // Something added after ours in the same list keeps its trust when ours go.
  const j2 = JSON.parse(fs.readFileSync(HF, 'utf8'));
  j2.hooks.Stop.push({ hooks: [{ type: 'command', command: '/usr/local/bin/later-tool stop', timeout: 5 }] });
  fs.writeFileSync(HF, JSON.stringify(j2, null, 2) + '\n');
  const laterKey = `${HF}:stop:${j2.hooks.Stop.length - 1}:0`;
  fs.writeFileSync(CF, fs.readFileSync(CF, 'utf8') + `\n[hooks.state."${laterKey}"]\ntrusted_hash = "${cx.trustHash('Stop', j2.hooks.Stop.at(-1), j2.hooks.Stop.at(-1).hooks[0])}"\n`);
  const rm = hk.codexPlan({ remove: true });
  hk.codexWrite(rm);
  const j3 = JSON.parse(fs.readFileSync(HF, 'utf8'));
  const t3 = fs.readFileSync(CF, 'utf8');
  const newKey = `${HF}:stop:${j3.hooks.Stop.length - 1}:0`;
  check('uninstall: only ours removed, the later tool kept with its trust under its new index', JSON.stringify(j3.hooks.Stop[0]) === JSON.stringify(CM.hooks.hooks.Stop[0]) && j3.hooks.Stop.length === 2 && t3.includes(`[hooks.state."${newKey}"]`) && !t3.includes(`[hooks.state."${laterKey}"]`) && !/ravenry/.test(JSON.stringify(j3)) && !/ravenry-codex-hook-trust/.test(t3), `${newKey} ${laterKey}`);
  // Without the later tool, uninstall gives back exactly what cmux had.
  fs.writeFileSync(HF, hooksRaw); fs.writeFileSync(CF, cmuxToml);
  hk.codexWrite(hk.codexPlan());
  hk.codexWrite(hk.codexPlan({ remove: true }));
  check('uninstall after setup: hooks.json the same hooks as before, config.toml its exact bytes', same(JSON.parse(fs.readFileSync(HF, 'utf8')), CM.hooks) && fs.readFileSync(CF, 'utf8') === cmuxToml);
  // No hooks.json or config.toml at all.
  fs.rmSync(CODEX_HOME, { recursive: true, force: true });
  hk.codexWrite(hk.codexPlan());
  check('setup on a Codex with no hooks.json or config.toml: both made, status ok', hk.codexStatus().state === 'ok');
  check('hooks turned off in config.toml are seen and left as they are', cx.hooksDisabled('[features]\nhooks = false\n') && !cx.hooksDisabled('[features]\nhooks = true\n') && !cx.hooksDisabled('model = "x"\n'));
  check('a test never reaches the real ~/.codex: Codex counts as not installed without MC_CODEX_HOME', !hk.codexInstalled({ ...process.env, MC_CODEX_HOME: '' }));
}

// ------------------------------------------------------------ 7. the hand-off hook for Codex
if (HAVE) {
  // A rollout past the line: 200k of Codex's 258.4k window.
  const big = fs.readFileSync(path.join(CX, 'rollout.jsonl'), 'utf8').replace(/"total_tokens":\d+/g, '"total_tokens":200000');
  const tp = path.join(T, 'rollout-big.jsonl');
  fs.writeFileSync(tp, big);
  fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [] }));
  const input = { session_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', transcript_path: tp, cwd: T, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done with the fix.' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'handoff-stop.mjs'), '--assistant=codex'], { input: JSON.stringify(input), env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* none */ }
  check('hand-off hook (Codex): blocks the stop past the line with the reason', out && out.decision === 'block' && /^\[ravenry hand-off\]/.test(out.reason), r.stdout.slice(0, 200));
  check('hand-off hook (Codex): the window is the rollout\'s (77% of 258k), the wording names Codex', out && /Context is at 77% \(200k of 258k\)/.test(out.reason) && /past the 70% ceiling/.test(out.reason) && /let Codex compact/.test(out.reason) && !/Claude/.test(out.reason), out && out.reason.split('\n')[1]);
  const mk = JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', input.session_id + '.json'), 'utf8'));
  check('hand-off hook (Codex): its marker says requested and names the assistant', mk.state === 'requested' && mk.assistant === 'codex' && mk.window === 258400);
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'handoff-stop.mjs'), '--assistant=codex'], { input: JSON.stringify({ ...input, session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', stop_hook_active: true }), env: { ...process.env, RAVENRY_HOME: MC }, encoding: 'utf8' });
  check('hand-off hook (Codex): never blocks while Codex is already continuing for a stop hook', r2.status === 0 && r2.stdout.trim() === '');
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll assistant checks pass');
process.exit(fails ? 1 : 0);
