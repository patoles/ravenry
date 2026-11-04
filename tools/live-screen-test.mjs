// The Live screen (docs/design/LiveScreen.dc.html, variant B). Two parts:
//
// 1. Unit checks on server/screen.mjs: trimScreen on real captured screens
//    (tools/fixtures/live/, private: only where that folder is) and on a
//    crafted screen with the prompt box, the agent list and the footer. Then proof that
//    parseScreen, which the state rules, the Sessions close check and the
//    draft detection read, gives the same output as before this work (the
//    module at commit 4acb04b), and that the last 40 lines of a 200-line
//    read are exactly a 40-line read.
// 2. A test board on :4661 with a throwaway RAVENRY_HOME and tools/fake-cmux.mjs
//    (never the real cmux), driven headless in Chromium (1440) and WebKit
//    (iPhone 13 at 390): stick to the bottom, the "N new lines, jump to
//    latest" pill, Slow and Not updating (read times faked by rewriting
//    /api/live), full screen with the composer and Esc, the pinned card on
//    a desktop and the card on a phone's first screen. Read-only: it never
//    presses Send, Add as note or anything else that writes.
//
// Usage: node tools/live-screen-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit, devices } from 'playwright';
import { trimScreen, tailLines, parseScreen } from '../server/screen.mjs';
import { markEntries } from '../server/codespans.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'live-screen-test');
const FIX = path.join(ROOT, 'tools', 'fixtures', 'live');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const allText = (r) => r.entries.map((e) => [...(e.l || []), e.t || '', e.a || '', e.b || '', e.n || ''].join('\n')).join('\n');

// ------------------------------------------------------------ 1. trim rules

const CHROME = [/ctrl\+o to expand/, /⏵⏵/, /auto mode on/, /^Read \d+ files?/m, /› Message from/, /Allowed by auto mode/, /Shell cwd was reset/, /^─{8,}$/m, /◯ /, /\/restart to apply/, /esc to interrupt/, /shift\+tab to cycle/];
function noChrome(label, r) {
  const t = allText(r);
  const hit = CHROME.filter((re) => re.test(t));
  check(`${label}: no Claude Code chrome left`, hit.length === 0, hit.map(String).join(' '));
}

// Checks on real captured screens (tools/fixtures/live/checks.mjs) run only
// where those screens are: the private repo. The public copy has none, so it
// runs the crafted screens below.
const PRIV = fs.existsSync(path.join(FIX, 'checks.mjs')) ? await import(pathToFileURL(path.join(FIX, 'checks.mjs')).href) : null;
if (PRIV) PRIV.trimChecks({ trimScreen, check, noChrome, read, allText });
else console.log('SKIP  trim rules on captured real screens (tools/fixtures/live/ is not in this copy)');

// A crafted screen at 80 columns: every kind of line, the prompt box with a
// half-typed draft, the mode line and the agent list.
const W = 80;
const words = 'This sentence is long enough that Claude Code wraps it at the terminal width of eighty columns and goes on to a second line.'.split(' ');
let l1 = '⏺', k = 0;
while (k < words.length && Array.from(l1 + ' ' + words[k]).length <= W) l1 += ' ' + words[k++];
const l2 = '  ' + words.slice(k).join(' ');
const RULE = '─'.repeat(W);
const crafted = [
  '  the end of a reply that scrolled off the top',
  '',
  '❯ Please check the live screen',
  '',
  l1, l2,
  '',
  '⏺ Bash(node tools/phone-overflow.mjs --w 390)',
  '  ⎿  ok   webkit 390x844 projects',
  '     ok   chromium 390x844 projects',
  '     … +12 lines (ctrl+o to expand)',
  '  ⎿  Allowed by auto mode',
  '',
  '  Read 2 files (ctrl+o to expand)',
  '',
  '⏺ Update(public/app.css)',
  '  ⎿  Updated public/app.css with 3 additions',
  '',
  '› Message from @general-purpose (ctrl+o to expand)',
  '',
  '⏺ Agent "Shoot the board" finished · 2m 3s',
  '',
  '⏺ The table:',
  '  ┌──────┬──────┐',
  '  │ a    │ b    │',
  '  └──────┴──────┘',
  '',
  '❯ stop that',
  '  ⎿  Interrupted · What should Claude do instead?',
  '',
  '✻ Worked for 3m 2s · done 2:15 PM',
  '',
  '※ recap: The board trims the screen.',
  '',
  '✶ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)',
  '  ⎿  ☒ Trim the screen',
  '     ☐ Write the tests',
  '',
  RULE,
  '❯ half typed draft',
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt',
  '  ⏺ main',
  '  ◯ general-purpose  Shoot the board at 390        1m 4s · ↓ 12.1k tokens',
  '  ◯ Explore  Find the composer                      22s · ↓ 3.0k tokens',
  '',
].join('\n');
{
  const r = trimScreen(crafted);
  noChrome('crafted', r);
  const kinds = r.entries.map((e) => e.k).join(' ');
  check('crafted: entry kinds in order', kinds === 'c u c t t t c u o s r todo', kinds);
  check('crafted: the wrapped line is one line', r.entries[2].l.length === 1 && r.entries[2].l[0] === words.join(' '), JSON.stringify(r.entries[2]));
  check('crafted: the orphan reply has no glyph of its own', r.entries[0].orphan === true);
  const [bash, upd, notice] = r.entries.filter((e) => e.k === 't');
  check('crafted: Bash is one line with 2 + 12 output lines', bash.n === 'Bash' && bash.a === 'node tools/phone-overflow.mjs --w 390' && bash.m === 14, JSON.stringify(bash));
  check('crafted: Update is one line with 1 output line', upd.n === 'Update' && upd.a === 'public/app.css' && upd.m === 1, JSON.stringify(upd));
  check('crafted: the agent notice is plain', notice.b === 'Agent "Shoot the board" finished · 2m 3s');
  check('crafted: "Read 2 files" and the message notice are gone', !/Read 2 files|Message from/.test(allText(r)));
  check('crafted: the table stays drawn', r.entries[6].l.length === 4 && r.entries[6].l[1] === '┌──────┬──────┐', JSON.stringify(r.entries[6]));
  check('crafted: an interruption shows', r.entries[8].t === 'Interrupted · What should Claude do instead?');
  check('crafted: the draft in the prompt box is not on screen', !/half typed draft/.test(allText(r)));
  check('crafted: the live spinner leaves the body and its task list stays', r.entries[11].l.join('|') === '☒ Trim the screen|☐ Write the tests' && !/Thinking/.test(allText(r)));
  check('crafted: status busy is the spinner word and time', r.status.busy === 'Thinking… 12s', r.status.busy);
  check('crafted: status agents carry task and time', JSON.stringify(r.status.agents) === JSON.stringify([{ type: 'general-purpose', task: 'Shoot the board at 390', took: '1m 4s' }, { type: 'Explore', task: 'Find the composer', took: '22s' }]), JSON.stringify(r.status.agents));
  check('crafted: status has the done line', r.status.done && r.status.done.when === '2:15 PM');
}
// Background notices (a report on 2026-11-04: "you can see sometimes there's
// this kind of spam"): Claude Code prints one each time an agent stops on
// its own background work, so a run of them is one row with a count.
const WAIT = (who, t) => `⏺ Agent "${who}" is waiting on its own background work · ${t}`;
const noticeScreen = (body) => [...body, RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)', ''].join('\n');
const sixteen = [];
for (let i = 0; i < 16; i++) sixteen.push(WAIT('Finish Claude-only leftovers', `${9 + i}m ${10 + i}s`), '');
{
  const r = trimScreen(noticeScreen(['⏺ Hand-off deferred: not at a clean point.', '', ...sixteen]));
  const t = r.entries.filter((e) => e.k === 't');
  check('notices: 16 of the same notice with blank lines between are one entry with x 16', r.entries.length === 2 && t.length === 1 && t[0].x === 16, JSON.stringify(r.entries));
  check('notices: the folded entry keeps the newest notice\'s text', t[0] && t[0].b === 'Agent "Finish Claude-only leftovers" is waiting on its own background work · 24m 25s', JSON.stringify(t[0]));
  const one = trimScreen(noticeScreen([WAIT('Solo', '1m 2s')])).entries;
  check('notices: a single notice has no count', one.length === 1 && one[0].b && !('x' in one[0]), JSON.stringify(one));
}
{
  const body = [];
  for (let i = 0; i < 4; i++) body.push(WAIT('Alpha', `${i}m 1s`), '', WAIT('Beta', `${i}m 2s`), '');
  const t = trimScreen(noticeScreen(body)).entries;
  check('notices: two agents interleaved do not fold across each other', t.length === 8 && t.every((e) => !e.x) && t.map((e) => e.b.slice(7, 11)).join(' ') === 'Alph Beta Alph Beta Alph Beta Alph Beta', JSON.stringify(t));
}
{
  const t = trimScreen(noticeScreen([WAIT('Alpha', '1m 1s'), '', WAIT('Alpha', '1m 9s'), '', WAIT('Alpha', '2m 0s'), '', '⏺ Bash(git status)', '  ⎿  clean', '', WAIT('Alpha', '3m 1s'), '', WAIT('Alpha', '3m 5s'), ''])).entries;
  check('notices: a tool call between makes two runs', t.length === 3 && t[0].x === 3 && t[1].n === 'Bash' && t[2].x === 2, JSON.stringify(t));
}
{
  const t = trimScreen(noticeScreen([WAIT('Alpha', '1m 1s'), '', WAIT('Alpha', '1m 9s'), '', '⏺ Agent "Alpha" finished · 2m 0s', '', '⏺ Agent "Alpha" finished · 2m 0s', ''])).entries;
  check('notices: the same agent\'s "finished" is its own run', t.length === 2 && t[0].x === 2 && /is waiting/.test(t[0].b) && t[1].x === 2 && /finished/.test(t[1].b), JSON.stringify(t));
}
{
  const shell = 'some output\n\n\nyou@mac:~/x % ls\nREADME.md\nyou@mac:~/x % \n';
  const r = trimScreen(shell);
  check('shell: no Claude, the lines verbatim in one block', !r.live && r.entries.length === 1 && r.entries[0].k === 'p' && r.entries[0].l.join('|') === 'some output||you@mac:~/x % ls|README.md|you@mac:~/x %', JSON.stringify(r.entries));
  check('null screen: nothing', trimScreen(null).entries.length === 0);
}

// Code blocks, inline code and Copy (a report on 2026-11-04 with a phone
// screenshot: "some formatting issue"). The message as Claude wrote it; the
// screen as Claude Code draws it (no backticks, a fenced block's lines at the
// text column, every row word-wrapped at the terminal's width with the rest
// of a wrapped row at the same column). One code block per fenced block,
// whose text is the whole command; inline code stays inline.
const NPM_CMD = '! cd ~/work/side-projects/ravenry-public && git push && npm publish --otp=<code>';
const NPM_MD = 'Run this, with your npm code in place of `<code>`:\n\n```\n' + NPM_CMD + '\n```\n\nIf publish answers 404, your npm login has expired: run `! npm login`, then the line again. Once it\'s published, I\'ll install 0.3.0 on your Mac and restart the board so you see the switch and the folded notices.';
// Markdown to Claude Code's screen rows at width w: backticks and fence lines
// gone, each paragraph or code line greedily wrapped, "⏺ " on the first row.
function drawReply(md, w) {
  const rows = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    const text = inFence ? line : line.replace(/`/g, '');
    if (!text.trim()) { rows.push(''); continue; }
    const lead = text.match(/^ */)[0];
    let cur = '  ' + lead;
    let started = false;
    for (const word of text.slice(lead.length).split(' ')) {
      if (started && Array.from(cur + ' ' + word).length > w) { rows.push(cur); cur = '  ' + lead + word; continue; }
      cur += (started ? ' ' : '') + word;
      started = true;
    }
    rows.push(cur);
  }
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  rows[0] = '⏺ ' + rows[0].slice(2);
  return rows;
}
const spanScreen = (rows, w) => [...rows, '', '─'.repeat(w), '❯ ', '─'.repeat(w), '  ⏵⏵ auto mode on (shift+tab to cycle)', ''].join('\n');
let spanFile = 0;
function marked(md, rows, w) {
  const file = path.join(T, 'spans', `t${spanFile++}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'x' + spanFile, message: { role: 'assistant', content: [{ type: 'text', text: md }] } }) + '\n');
  const es = markEntries(trimScreen(spanScreen(rows, w)).entries, file);
  return es.find((e) => e.k === 'c') || {};
}
for (const w of [194, 80, 60]) {
  const e = marked(NPM_MD, drawReply(NPM_MD, w), w);
  const cs = e.cs || [];
  const blocks = cs.filter((x) => x.b);
  check(`code: at ${w} columns the fenced command is one code block whose text is the whole command`, blocks.length === 1 && blocks[0].t === NPM_CMD && blocks[0].whole === true && blocks[0].cmd === true, JSON.stringify(cs));
  check(`code: at ${w} columns "<code>" in the sentence and "! npm login" are inline, not blocks`, JSON.stringify(cs.filter((x) => !x.b).map((x) => x.t)) === JSON.stringify(['<code>', '! npm login']), JSON.stringify(cs));
  check(`code: at ${w} columns every piece is on screen text, "<code>" kept as text`, cs.every((x) => x.r.every(([li, a, z]) => e.l[li].slice(a, z).length > 0)) && e.l.join('\n').split('<code>').length === 3, JSON.stringify(e.l));
}
{
  // The command wrapped by the terminal where the browser split it: the
  // rest of the row on its own row at the text column.
  const rows = drawReply(NPM_MD, 194);
  const k = rows.findIndex((r) => r.includes('--otp='));
  rows.splice(k, 1, rows[k].replace('<code>', ''), '  <code>');
  const e = marked(NPM_MD, rows, 194);
  const b = (e.cs || []).filter((x) => x.b);
  check('code: a command row broken before "<code>" is still one block with the whole command', b.length === 1 && b[0].t === NPM_CMD && b[0].whole, JSON.stringify(e));
}
{
  // A multi-line block with indentation, a blank line, && and quotes.
  const code = ['npm ci', '  node tools/x.mjs --name "a b" && echo \'done <ok>\'', '', 'npm test'];
  const md = 'Then:\n\n```sh\n' + code.join('\n') + '\n```\n\nThe last word is `npm test`';
  const e = marked(md, drawReply(md, 100), 100);
  const b = (e.cs || []).filter((x) => x.b);
  check('code: a multi-line block is one block copying its source exactly (indent, blank line, && and quotes)', b.length === 1 && b[0].t === code.join('\n') && b[0].whole && !b[0].cmd, JSON.stringify(e.cs));
  const end = (e.cs || []).find((x) => !x.b);
  check('code: inline code at the end of a line stays inline', !!end && end.t === 'npm test' && e.l[end.r[0][0]].endsWith('npm test'), JSON.stringify(e.cs));
  // Its first line scrolled off: the rest is a block of what is on screen.
  const rows = drawReply(md, 100);
  const cut = rows.slice(rows.findIndex((r) => /node tools/.test(r)));
  const p = marked(md, cut, 100);
  const pb = (p.cs || []).filter((x) => x.b);
  check('code: part of a block on screen is a block of the lines shown', pb.length === 1 && !pb[0].whole && pb[0].t === [code[1].trim(), code[3]].join('\n'), JSON.stringify(p.cs));
}

// parseScreen is unchanged: the same outputs as the module before this work.
{
  const before = path.join(T, 'screen-before.mjs');
  let oldSrc = null;
  try { oldSrc = execFileSync('git', ['show', '4acb04b:server/screen.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not in this history */ }
  if (oldSrc) fs.writeFileSync(before, oldSrc);
  const old = oldSrc ? await import(pathToFileURL(before).href) : null;
  const screens = { ...(PRIV ? PRIV.screens(read) : {}), crafted, shell: 'a\nyou@mac:~/x % \n', none: null };
  let same = 0;
  // The module before this work lives only in the private history; a fresh
  // clone has no commit 4acb04b, so the comparison is skipped there.
  if (!old) console.log('SKIP  parseScreen against commit 4acb04b (not in this history)');
  else for (const [name, text] of Object.entries(screens)) {
    try { assert.deepStrictEqual(parseScreen(text), old.parseScreen(text)); same++; } catch (e) { check(`parseScreen unchanged on ${name}`, false, e.message.slice(0, 300)); }
    try { assert.deepStrictEqual(parseScreen(tailLines(text, 40)), old.parseScreen(tailLines(text, 40))); } catch (e) { check(`parseScreen unchanged on ${name} (last 40)`, false, e.message.slice(0, 300)); }
  }
  if (old) check(`parseScreen: the same output as before on all ${Object.keys(screens).length} screens (and their last 40 lines)`, same === Object.keys(screens).length);
  if (PRIV) {
    const { r40, r200 } = PRIV.tail(read);
    check('tailLines: the last 40 of a 200-line read are exactly the 40-line read', tailLines(r200, 40) === r40);
    assert.deepStrictEqual(parseScreen(tailLines(r200, 40)), parseScreen(r40));
    check('state rules: parseScreen of that tail equals parseScreen of the 40-line read (draft, dialog, working, done, agents, body)', true);
  } else console.log('SKIP  tailLines on a captured 200-line read (not in this copy)');
  const keys = ['claudeLive', 'shell', 'exited', 'working', 'busyLine', 'done', 'recap', 'draft', 'dialog', 'agentsRunning', 'resumeId', 'body', 'footer'];
  check('parseScreen: still returns every field the state rules read', keys.every((x) => x in parseScreen(crafted)));
  check('parseScreen on the crafted screen: working, draft, 2 agents', parseScreen(crafted).working && parseScreen(crafted).draft === 'half typed draft' && parseScreen(crafted).agentsRunning === 2);
}

// ------------------------------------------------------------ 2. the board

const PORT = 4661;
const MC = path.join(T, 'mc');
const FAKE = path.join(T, 'fake-cmux.json');
const FOLDER = path.join(T, 'live-project');
fs.mkdirSync(MC, { recursive: true });
fs.mkdirSync(FOLDER, { recursive: true });
execFileSync('git', ['init', '-q', FOLDER]);
const WS = 'aaaaaaaa-1111-4111-8111-000000000001';
const SID = 'bbbbbbbb-2222-4222-8222-000000000002';
const BW = 100;
const BRULE = '─'.repeat(BW);
let steps = 0;
const block = (n) => [`⏺ Step ${n}: the session prints a line of text so the live screen has something to follow.`, ''];
function screenText(n, tail = [], { agents = true, menu = null } = {}) {
  const body = [];
  for (let i = 1; i <= n; i++) body.push(...block(i));
  // A menu replaces the prompt box and everything under it.
  if (menu) return [...body, ...tail, ...MENU, ''].join('\n');
  return [...body, ...tail, BRULE, '❯ ', BRULE, '  ⏵⏵ auto mode on (shift+tab to cycle)', ...(agents ? ['  ◯ general-purpose  Shoot the board at 390        1m 4s · ↓ 12.1k tokens'] : []), ''].join('\n');
}
function setSteps(n, tail, opts) {
  steps = n;
  // opts.menu: the screen after Enter on the menu (tools/fake-cmux.mjs plays it).
  fs.writeFileSync(FAKE + '.tmp', JSON.stringify({ workspaces: [{ id: WS, ref: 'workspace:1', title: 'Live test', cwd: FOLDER, surfaces: [{ id: SID, ref: 'surface:1', title: '✳ Live test' }] }], screens: { [SID]: screenText(n, tail, opts) }, ...(opts && opts.menu ? { menus: { [SID]: { after: opts.menu } } } : {}) }));
  fs.renameSync(FAKE + '.tmp', FAKE);
}
// Code spans (docs/design/LiveCode.dc.html, C): a fake transcript for the
// session, and the screen Claude Code draws from it (backticks gone, rows
// wrapped at the terminal's width).
const TRANSCRIPT = path.join(T, 'claude', FOLDER.replace(/[^A-Za-z0-9-]/g, '-'), 'cccccccc-3333-4333-8333-000000000003.jsonl');
fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
const MD = {
  plain: 'Plain words this time: npm login and ravenry-public, said again without any code at all.',
  cmd: 'Your browser may keep the old favicon for a while. To publish the package, run `! npm login` in this prompt, then I run `npm publish --access public --tag next --registry https://registry.npmjs.org/` from `ravenry-public`. After that, npm login is not needed again.',
  broken: 'The fixture lives in `tools/fixtures/live/checks.mjs` and the test reads it.\n\n```sh\nnode tools/live-screen-test.mjs\n```',
  npm: NPM_MD,
  alone: 'If it asks who you are, check the login first:\n\n`! npm whoami`',
};
const rec = (text, n) => JSON.stringify({ type: 'assistant', uuid: 'u' + n, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const writeTranscript = (keys) => fs.writeFileSync(TRANSCRIPT, keys.map((k, n) => rec(MD[k], n)).join('\n') + '\n');
// Greedy word wrap at the board's 100 columns, as Claude Code draws a reply.
function wrapRows(text) {
  const rows = [];
  let cur = '⏺';
  for (const w of text.split(' ')) {
    if (Array.from(cur + ' ' + w).length > BW) { rows.push(cur); cur = ' '; }
    cur += ' ' + w;
  }
  rows.push(cur);
  return rows;
}
const strip = (md) => md.replace(/`/g, '');
// A Bash permission prompt as Claude Code draws it (tools/fixtures/menus/
// permission.txt), with a long second option.
const DASH = ' ' + '╌'.repeat(BW - 1);
const MENU_OPTS = ['Yes', 'Yes, and always allow access to /work/garden-planner/packages/core/dist/ from this project', 'No'];
const MENU = [
  '⏺ Bash(npm publish --access public)', '  ⎿  Waiting…', '',
  BRULE,
  ' Bash command',
  ' Publish the package to the public registry',
  DASH, ' npm publish --access public', DASH,
  ' Do you want to proceed?',
  ...MENU_OPTS.map((o, k) => `${k ? '  ' : ' ❯'} ${k + 1}. ${o}`),
  '',
  ' Esc to cancel · Tab to amend',
];
const fakeKeys = () => { try { return (JSON.parse(fs.readFileSync(FAKE, 'utf8')).keys || {})[SID] || []; } catch { return []; } };
const SPAN_TAIL = [
  '❯ run ! npm login and npm publish --access public for me', '',
  '⏺ Bash(npm login)', '  ⎿  npm error code E401', '',
  ...wrapRows(strip(MD.cmd)), '',
  ...wrapRows(MD.plain), '',
  // A row the terminal broke inside a path, its rest indented further than
  // a wrapped row: two logical lines, so the span is two pieces.
  '⏺ The fixture lives in tools/fixtures/', '    live/checks.mjs and the test reads it.', '',
  '  node tools/live-screen-test.mjs', '',
];

setSteps(130); // 262 lines: more than the 200 the board reads, so old lines scroll off
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: T },
  projects: [{ id: 'live', name: 'Live test', folder: FOLDER, workspaces: [WS] }],
}, null, 2));
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
  env: { ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
    CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: path.join(T, 'claude'),
    MC_SCRATCH_ROOT: path.join(T, 'scratch'), MC_PROJECTS_ROOT: T, MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.log = '';
child.stdout.on('data', (d) => { child.log += d; });
child.stderr.on('data', (d) => { child.log += d; });
const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { reject(e); } }); }).on('error', reject);
});
const waitFor = async (page, fn, arg, ms = 9000) => { try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
const SHOTS = process.env.LIVE_SHOTS || T;
fs.mkdirSync(SHOTS, { recursive: true });
const liveNow = async (fn, ms = 12000) => { for (let i = 0; i < ms / 250; i++) { const b = (await getJson(`/api/live?surface=${SID}`)).body; if (b.entries && fn(b)) return b; await sleep(250); } return null; };
const cmdEntry = (b) => b.entries.find((e) => e.k === 'c' && /To publish the package/.test(e.l.join(' ')));

// A menu on screen in full screen (docs/design/LiveMenu.dc.html, V1): the
// options take the message box's place and send through the answer card's
// path; the box and its draft come back once the menu is gone.
async function menuChecks(page, tag, phone) {
  const w = phone ? 390 : 1440;
  setSteps(2, []);
  await waitFor(page, () => !document.querySelector('#d-ask .q-opts'), null, 12000);
  await page.click(phone ? '#lv-tap' : '#lv-exp');
  await page.waitForTimeout(400);
  await page.fill('#compose', 'bump the changelog first, then');
  check(`${tag}: menu: no panel while no menu is open, the message box shows`, await page.evaluate(() => !document.querySelector('#lv-menu') && getComputedStyle(document.querySelector('#lv-fs #composer')).display !== 'none'));
  setSteps(2, [], { menu: screenText(2, ['⏺ The publish was declined. What should I change first?', '']) });
  const shown = await waitFor(page, () => document.querySelector('#lv-fs #lv-menu .lvm-o button') && /Do you want to proceed\?/.test(document.querySelector('#lv-lines').textContent), null, 12000);
  const v = await page.evaluate(() => {
    const m = document.querySelector('#lv-menu');
    const c = getComputedStyle(m);
    const bs = Array.from(m.querySelectorAll('.lvm-o button'));
    const comp = document.querySelector('#composer');
    return {
      head: m.querySelector('.lvm-h b').textContent, ctx: (m.querySelector('.lvm-h .ctx') || {}).textContent, icon: !!m.querySelector('.lvm-h svg'),
      labels: bs.map((b) => b.textContent), pri: bs.map((b) => b.classList.contains('pri')),
      foot: m.querySelector('.lvm-f') && m.querySelector('.lvm-f').textContent,
      boxHidden: getComputedStyle(comp).display === 'none', after: m.nextElementSibling === comp, inFs: !!m.closest('#lv-fs-body'),
      bg: c.backgroundColor, ring: c.boxShadow,
      heights: bs.map((b) => Math.round(b.getBoundingClientRect().height)), widths: bs.map((b) => Math.round(b.getBoundingClientRect().width)), font: getComputedStyle(bs[0]).fontSize, align: getComputedStyle(bs[1]).textAlign,
      panelW: Math.round(m.getBoundingClientRect().width), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      plain: !document.querySelector('#lv-lines button, #lv-lines [data-k], #lv-lines [data-lv-menu-k], #lv-lines [data-act]'), plainWhy: Array.from(document.querySelectorAll('#lv-lines button')).map((b) => b.closest('.e').outerHTML.slice(0, 200)),
    };
  });
  check(`${tag}: menu: with a menu open the panel replaces the message box in full screen`, shown && v.boxHidden && v.after && v.inFs, JSON.stringify(v));
  check(`${tag}: menu: header has the icon, the question and the context`, v.icon && v.head === 'Do you want to proceed?' && v.ctx === 'Bash: npm publish --access public', JSON.stringify([v.head, v.ctx]));
  check(`${tag}: menu: the answer card's options, first one blue, then the foot line`, JSON.stringify(v.labels) === JSON.stringify(MENU_OPTS) && JSON.stringify(v.pri) === '[true,false,false]' && v.foot === 'The message box comes back after you answer. Its draft is kept.', JSON.stringify(v));
  check(`${tag}: menu: tinted panel with the you-coloured ring, left-aligned labels`, /rgba\(255, 159, 10, 0\.11\)/.test(v.bg) && /inset/.test(v.ring) && v.align === 'left', JSON.stringify([v.bg, v.ring, v.align]));
  if (phone) check(`${tag}: menu: phone buttons stack full width, 44 px or more, 15 px text`, v.heights.every((h) => h >= 44) && v.widths.every((x) => Math.abs(x - v.widths[0]) <= 1 && x >= v.panelW - 30) && v.font === '15px' && v.sw <= v.cw, JSON.stringify(v));
  else check(`${tag}: menu: desktop buttons sit in a row, the long one wraps in the panel`, v.heights[0] <= 34 && v.sw <= v.cw, JSON.stringify(v));
  check(`${tag}: menu: the menu lines in the Live screen stay plain text`, v.plain, JSON.stringify(v.plainWhy));
  await page.screenshot({ path: path.join(SHOTS, `menu-open-${w}.png`) });
  // The answer card's buttons are the same options (one sender for both).
  check(`${tag}: menu: the answer card carries the same options`, await page.evaluate((o) => JSON.stringify(Array.from(document.querySelectorAll('#d-ask .q-opts button')).map((b) => b.textContent)) === JSON.stringify(o), MENU_OPTS));
  // Click "No": the existing choice path moves to it and presses Enter.
  const sends = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/send')) sends.push(r.postDataJSON()); });
  await page.click('#lv-menu .lvm-o button:nth-child(3)');
  const locked = await page.waitForFunction(() => { const m = document.querySelector('#lv-menu'); if (!m) return 'gone'; const bs = Array.from(m.querySelectorAll('.lvm-o button')); return bs[2].classList.contains('chosen') && bs[0].classList.contains('dimmed') && bs[1].classList.contains('dimmed') && bs.every((b) => b.disabled) && /Sent "No"/.test(m.querySelector('.lvm-sent').textContent) ? 'locked' : false; }, null, { timeout: 8000, polling: 'raf' }).then((h) => h.jsonValue()).catch(() => 'timeout');
  if (locked === 'locked') await page.screenshot({ path: path.join(SHOTS, `menu-sent-${w}.png`) });
  check(`${tag}: menu: after the click the panel locks on "No" (green ring, others dim, Sent "No")`, locked === 'locked', locked);
  const back = await waitFor(page, () => !document.querySelector('#lv-menu') && getComputedStyle(document.querySelector('#lv-fs #composer')).display !== 'none', null, 12000);
  check(`${tag}: menu: the choice went through the answer card's path as option 3`, sends.length === 1 && sends[0].choice === 3 && sends[0].surfaceId === SID, JSON.stringify(sends));
  check(`${tag}: menu: fake cmux got Down, Down, Enter`, fakeKeys().join(' ') === 'down down enter', fakeKeys().join(' '));
  check(`${tag}: menu: when the read shows the menu gone, the box comes back with its draft`, back && (await page.inputValue('#compose')) === 'bump the changelog first, then');
  await page.screenshot({ path: path.join(SHOTS, `menu-closed-${w}.png`) });
  // A send that fails shows today's toast and leaves the panel open.
  setSteps(2, [], { menu: screenText(2, []) });
  await waitFor(page, () => document.querySelector('#lv-menu .lvm-o button'), null, 12000);
  await page.route('**/api/send', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The menu changed before the choice was taken.' }) }));
  await page.click('#lv-menu .lvm-o button:nth-child(1)');
  const err = await waitFor(page, () => /The menu changed before the choice was taken/.test(document.body.textContent), null, 4000);
  const still = await page.evaluate(() => { const m = document.querySelector('#lv-menu'); return !!m && !m.querySelector('.chosen') && Array.from(m.querySelectorAll('button')).every((b) => !b.disabled); });
  check(`${tag}: menu: a failed send shows the toast and the options stay open`, err && still, String(still));
  await page.unroute('**/api/send');
  if (!phone) {
    await page.evaluate(() => document.querySelector('#theme').click());
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `menu-open-${w}-light.png`) });
    await page.evaluate(() => document.querySelector('#theme').click());
  }
  setSteps(2, []);
  await waitFor(page, () => !document.querySelector('#lv-menu'), null, 12000);
  await page.fill('#compose', '');
  await page.click('#lv-fs [data-lv-close]');
  await page.waitForTimeout(300);
  check(`${tag}: menu: closing full screen puts the message box back on the answer card`, await page.evaluate(() => !!document.querySelector('#d-ask #composer') && getComputedStyle(document.querySelector('#composer')).display !== 'none'));
}

// Every chip copies (a plain command like npm start is worth copying too): on a
// desktop a Copy floats past any chip's end on hover, nothing at rest; on a
// phone a tap on any chip copies it and rings it green with a check. The
// copied text is the whole span, a wrapped one too; "! npm login" in its
// sentence is such a chip. The code block's own Copy is checked above.
async function plainChipChecks(page, tag, phone) {
  const w = phone ? 390 : 1440;
  const SHOT = process.env.CHIP_SHOTS || SHOTS;
  fs.mkdirSync(SHOT, { recursive: true });
  const chip = (t) => page.locator('#lv-lines .cd.pl', { hasText: t }).first();
  const rec = () => page.evaluate(() => window.__copied.splice(0));
  const fsOpen = () => page.evaluate(() => !document.querySelector('#lv-fs').hidden);
  const restCph = () => page.evaluate(() => Array.from(document.querySelectorAll('#lv-lines .cph')).map((b) => getComputedStyle(b).display));
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1700); // the command's Copied above runs out
  await rec();
  const rest = await restCph();
  check(`${tag}: chips: every plain chip carries a Copy, none shows at rest`, rest.length >= 3 && rest.every((d) => d === 'none'), JSON.stringify(rest));
  const pl = await page.evaluate(() => { const c = Array.from(document.querySelectorAll('#lv-lines .cd.pl')).find((x) => /^ravenry-public/.test(x.textContent)); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, cmdIcon: document.querySelector('#lv-lines .cp svg').outerHTML }; });
  if (!phone) {
    // Desktop: hover shows it, the line does not move, the icon is the command's.
    await chip('ravenry-public').hover();
    await page.waitForTimeout(100);
    const h = await page.evaluate(() => { const c = Array.from(document.querySelectorAll('#lv-lines .cd.pl')).find((x) => /^ravenry-public/.test(x.textContent)); const b = c.querySelector('.cph'); const r = c.getBoundingClientRect(); const sc = c.closest('.lv-scroll').getBoundingClientRect(); const br = b.getBoundingClientRect(); return { d: getComputedStyle(b).display, text: b.textContent.trim(), icon: b.querySelector('svg').outerHTML, x: r.x, y: r.y, w: r.width, inside: br.right <= sc.right && br.left >= sc.left, others: Array.from(document.querySelectorAll('#lv-lines .cph')).filter((x) => x !== b && getComputedStyle(x).display !== 'none').length }; });
    check(`${tag}: chips: hover on a plain chip shows the command's icon and "Copy", only there, inside the screen`, h.d !== 'none' && h.text === 'Copy' && h.icon === pl.cmdIcon && h.others === 0 && h.inside, JSON.stringify({ ...h, icon: h.icon === pl.cmdIcon }));
    check(`${tag}: chips: hovering does not move the chip or its line`, h.x === pl.x && h.y === pl.y && h.w === pl.w, JSON.stringify([pl, h]));
    fs.mkdirSync(SHOT, { recursive: true });
    await page.screenshot({ path: path.join(SHOT, `desktop-hover-${w}.png`) });
    await (await page.$('#lv-card')).screenshot({ path: path.join(SHOT, `desktop-hover-${w}-card.png`) });
    await chip('ravenry-public').locator('.cph').click();
    const done = await waitFor(page, () => { const b = Array.from(document.querySelectorAll('#lv-lines .cph.done')); return b.length && /Copied/.test(b[0].textContent); }, null, 3000);
    const c1 = await rec();
    const real1 = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
    check(`${tag}: chips: Copy on a plain chip writes "ravenry-public" with navigator.clipboard and shows Copied`, done && c1.length === 1 && c1[0].via === 'clipboard' && c1[0].t === 'ravenry-public' && real1 === 'ravenry-public', JSON.stringify([c1, real1]));
    await page.mouse.move(2, 2);
    await page.waitForTimeout(100);
    check(`${tag}: chips: Copied stays for its 1.5 s after the pointer leaves`, await page.evaluate(() => Array.from(document.querySelectorAll('#lv-lines .cph')).some((b) => getComputedStyle(b).display !== 'none' && /Copied/.test(b.textContent))));
    await (await page.$('#lv-card')).screenshot({ path: path.join(SHOT, `desktop-copied-${w}-card.png`) });
    await page.waitForTimeout(1700);
    check(`${tag}: chips: then nothing at rest again`, (await restCph()).every((d) => d === 'none'));
    // A span wrapped into two pieces: the first piece's hover shows the Copy
    // on the last, and it copies the whole span.
    await chip('tools/fixtures/').hover();
    await page.waitForTimeout(100);
    const wr = await page.evaluate(() => { const e = Array.from(document.querySelectorAll('#lv-lines > .e')).find((x) => /The fixture lives/.test(x.textContent)); const b = e.querySelector('.cph'); return { d: getComputedStyle(b).display, onLast: b.closest('.cd').textContent.startsWith('live/checks.mjs') }; });
    check(`${tag}: chips: hover on a wrapped span's first piece shows the Copy at its end`, wr.d !== 'none' && wr.onLast, JSON.stringify(wr));
    await page.locator('#lv-lines .cd.pl.lst', { hasText: 'live/checks.mjs' }).first().locator('.cph').click();
    await page.waitForTimeout(200);
    const c2 = await rec();
    const real2 = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
    check(`${tag}: chips: a wrapped span copies whole`, c2.length === 1 && c2[0].t === 'tools/fixtures/live/checks.mjs' && real2 === 'tools/fixtures/live/checks.mjs', JSON.stringify([c2, real2]));
    // Plain http on the LAN: the textarea path, the exact text.
    await page.evaluate(() => navigator.clipboard.writeText('something else'));
    await rec();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
    await chip('ravenry-public').hover();
    await chip('ravenry-public').locator('.cph').click();
    await page.waitForTimeout(200);
    const c3 = await rec();
    const real3 = await page.evaluate(() => window.__clip.readText().catch((e) => 'ERR ' + e.message));
    check(`${tag}: chips: without navigator.clipboard, the fallback copies the exact text`, c3.length === 1 && c3[0].via === 'execCommand' && c3[0].t === 'ravenry-public' && real3 === 'ravenry-public', JSON.stringify([c3, real3]));
    await page.evaluate(() => { delete navigator.clipboard; });
    check(`${tag}: chips: copying never opened full screen`, !(await fsOpen()));
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1700);
    return;
  }
  // Phone: no hover, a tap on the chip copies. In the card first, where a
  // tap elsewhere opens full screen.
  await page.waitForTimeout(1700);
  await chip('ravenry-public').tap();
  const done = await waitFor(page, () => Array.from(document.querySelectorAll('#lv-lines .cd.pl.done')).some((c) => /^ravenry-public/.test(c.textContent)), null, 3000);
  const c1 = await rec();
  const st = await page.evaluate(() => { const c = document.querySelector('#lv-lines .cd.pl.done'); const s = getComputedStyle(c); const a = getComputedStyle(c, '::after'); return { color: s.color, ring: s.boxShadow, check: a.content !== 'none' && a.width === '11px', cph: Array.from(document.querySelectorAll('#lv-lines .cph')).every((b) => getComputedStyle(b).display === 'none') }; });
  check(`${tag}: chips: a tap on a plain chip copies "ravenry-public" with navigator.clipboard`, done && c1.length === 1 && c1[0].via === 'clipboard' && c1[0].t === 'ravenry-public', JSON.stringify(c1));
  check(`${tag}: chips: the tapped chip turns green, ringed, with a check; no hover button on a phone`, st.color === 'rgb(48, 209, 88)' && /rgba\(48, 209, 88/.test(st.ring) && st.check && st.cph, JSON.stringify(st));
  check(`${tag}: chips: the tap did not open full screen`, !(await fsOpen()));
  await (await page.$('#lv-card')).screenshot({ path: path.join(SHOT, `phone-tapped-${w}-card.png`) });
  await page.waitForTimeout(1700);
  check(`${tag}: chips: the green goes after 1.5 s`, await page.evaluate(() => !document.querySelector('#lv-lines .cd.done')));
  // A wrapped span: a tap on its first piece copies all of it, both pieces go green, the check on the last.
  await chip('tools/fixtures/').tap();
  await page.waitForTimeout(200);
  const c2 = await rec();
  const wr = await page.evaluate(() => { const e = Array.from(document.querySelectorAll('#lv-lines > .e')).find((x) => /The fixture lives/.test(x.textContent)); const p = Array.from(e.querySelectorAll('.cd.pl')).filter((c) => c.dataset.lvChip === 'tools/fixtures/live/checks.mjs'); return { n: p.length, done: p.map((c) => c.classList.contains('done')), check: p.map((c) => getComputedStyle(c, '::after').content !== 'none') }; });
  check(`${tag}: chips: a tap on a wrapped span's first piece copies it whole`, c2.length === 1 && c2[0].t === 'tools/fixtures/live/checks.mjs' && !(await fsOpen()), JSON.stringify(c2));
  check(`${tag}: chips: both pieces go green, the check only on the last`, wr.n === 2 && wr.done.every(Boolean) && JSON.stringify(wr.check) === '[false,true]', JSON.stringify(wr));
  // The phone page on plain http: the textarea path.
  await page.waitForTimeout(1700);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await chip('ravenry-public').tap();
  await page.waitForTimeout(200);
  const c3 = await rec();
  check(`${tag}: chips: without navigator.clipboard, a tap copies the exact text through the fallback`, c3.length === 1 && c3[0].via === 'execCommand' && c3[0].t === 'ravenry-public' && !(await fsOpen()), JSON.stringify(c3));
  await page.evaluate(() => { delete navigator.clipboard; });
  // A code block's own text copies too; its pill shows Copied.
  await page.waitForTimeout(1700);
  await page.locator('#lv-lines .cb').first().tap({ position: { x: 6, y: 6 } });
  await page.waitForTimeout(200);
  const c4 = await rec();
  const pill = await page.$eval('#lv-lines .cpm', (b) => b.classList.contains('done') && /Copied/.test(b.textContent));
  check(`${tag}: chips: a tap on a code block's text copies the block and its pill says Copied`, c4.length === 1 && c4[0].t === 'node tools/live-screen-test.mjs' && pill && !(await fsOpen()), JSON.stringify(c4));
  // "! npm login" in its sentence is a chip like any other: a tap copies it, no pill.
  await page.waitForTimeout(1700);
  await chip('! npm login').tap();
  await page.waitForTimeout(200);
  const c6 = await rec();
  check(`${tag}: chips: a tap on "! npm login" in its sentence copies it`, c6.length === 1 && c6[0].t === '! npm login' && !(await fsOpen()), JSON.stringify(c6));
  // Full screen: the tapped state as he sees it.
  await page.waitForTimeout(1700);
  await page.tap('#lv-tap');
  await page.waitForTimeout(400);
  await chip('ravenry-public').tap();
  await page.waitForTimeout(150);
  const c5 = await rec();
  check(`${tag}: chips: in full screen a tap copies too and full screen stays`, c5.length === 1 && c5[0].t === 'ravenry-public' && (await fsOpen()), JSON.stringify(c5));
  await page.screenshot({ path: path.join(SHOT, `phone-tapped-${w}-full.png`) });
  await page.tap('#lv-fs [data-lv-close]');
  await page.waitForTimeout(1700);
}

// The page side of the code spans, and the S2 dot.
async function spanChecks(page, ctx, tag, phone) {
  const w = phone ? 390 : 1440;
  if (!phone) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${PORT}` });
  // The reply on screen before its message is in the transcript: no marks.
  writeTranscript(['plain', 'broken']);
  setSteps(2, SPAN_TAIL);
  check(`${tag}: spans: the screen shows the reply, unmarked while its message is not in the transcript`, !!(await liveNow((b) => { const e = cmdEntry(b); return e && !e.cs && b.entries.some((x) => x.cs); })));
  check(`${tag}: spans: page shows the reply`, await waitFor(page, () => /To publish the package/.test(document.querySelector('#lv-lines').textContent) && document.querySelectorAll('#lv-lines .cd').length > 0));
  const cmdDiv = () => Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((n) => /To publish the package/.test(n.textContent));
  check(`${tag}: spans: no chip in the reply yet`, await page.evaluate((f) => !(new Function('return ' + f)())().querySelector('.cd'), cmdDiv.toString()));
  // Mark the other entries, to see they are not redrawn.
  await page.evaluate(() => { for (const n of document.querySelectorAll('#lv-lines > .e')) n.dataset.kept = '1'; });
  // The message lands in the transcript: the next read marks it in place.
  writeTranscript(['plain', 'cmd', 'broken']);
  const got = await waitFor(page, () => { const n = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /To publish the package/.test(x.textContent)); return n && n.querySelector('.cd'); }, null, 12000);
  const inc = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#lv-lines > .e'));
    const re = all.find((x) => /To publish the package/.test(x.textContent));
    return { reDrawn: re && !re.dataset.kept, othersKept: all.filter((x) => x !== re).every((x) => x.dataset.kept === '1'), count: all.length };
  });
  check(`${tag}: spans: incremental update redraws the reply when its spans arrive, and only it`, got && inc.reDrawn && inc.othersKept, JSON.stringify(inc));
  const marks = await page.evaluate(() => {
    const text = (cd) => (cd.querySelector('.cbt') ? cd.querySelector('.cbt').textContent : Array.from(cd.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
    const ent = (re) => Array.from(document.querySelectorAll('#lv-lines > .e')).find((x) => re.test(x.textContent));
    const chips = (n) => (n ? Array.from(n.querySelectorAll('.cd')).map(text) : []);
    const cmd = ent(/To publish the package/);
    const st = (el) => { const c = getComputedStyle(el); return { color: c.color, bg: c.backgroundColor, radius: c.borderTopLeftRadius, clone: c.boxDecorationBreak || c.webkitBoxDecorationBreak }; };
    const long = Array.from(cmd.querySelectorAll('.cd')).find((c) => /registry/.test(text(c)));
    return {
      cmd: chips(cmd),
      plain: chips(ent(/^\s*Plain words/)),
      user: chips(document.querySelector('#lv-lines > .e.u')),
      tool: chips(document.querySelector('#lv-lines > .e.t')),
      broken: chips(ent(/The fixture lives/)),
      buttons: Array.from(document.querySelectorAll('#lv-lines .cp[data-lv-copy], #lv-lines .cpm[data-lv-copy]')).map((b) => b.dataset.lvCopy),
      cmdButtons: cmd.querySelectorAll('.cp, .cpm').length,
      blocks: Array.from(document.querySelectorAll('#lv-lines .cb')).map(text),
      style: st(cmd.querySelector('.cd')),
      longLines: long ? long.getClientRects().length : 0,
      cmdText: cmd.textContent,
    };
  });
  check(`${tag}: spans: the reply's three spans are chips, exactly`, JSON.stringify(marks.cmd) === JSON.stringify(['! npm login', 'npm publish --access public --tag next --registry https://registry.npmjs.org/', 'ravenry-public']), JSON.stringify(marks.cmd));
  check(`${tag}: spans: "npm login" said again later in the reply is not marked`, /After that, npm login is not needed again/.test(marks.cmdText), marks.cmdText.slice(-80));
  check(`${tag}: spans: a message without code marks nothing, though its words are code elsewhere`, marks.plain.length === 0, JSON.stringify(marks.plain));
  check(`${tag}: spans: user and tool lines are never marked`, marks.user.length === 0 && marks.tool.length === 0, JSON.stringify([marks.user, marks.tool]));
  check(`${tag}: spans: a span broken over two lines is two pieces, and the fenced block's line is marked`, JSON.stringify(marks.broken) === JSON.stringify(['tools/fixtures/', 'live/checks.mjs', 'node tools/live-screen-test.mjs']), JSON.stringify(marks.broken));
  check(`${tag}: spans: only the code block has a copy button (icon and pill); "! npm login" in its sentence has none`, JSON.stringify(marks.buttons) === JSON.stringify(['node tools/live-screen-test.mjs', 'node tools/live-screen-test.mjs']) && marks.cmdButtons === 0 && JSON.stringify(marks.blocks) === JSON.stringify(['node tools/live-screen-test.mjs']), JSON.stringify(marks));
  check(`${tag}: spans: chip is periwinkle on an 8% tint, 4 px radius, cloned across wraps`, marks.style.color === 'rgb(177, 185, 249)' && marks.style.bg === 'rgba(255, 255, 255, 0.08)' && marks.style.radius === '4px' && marks.style.clone === 'clone', JSON.stringify(marks.style));
  check(`${tag}: spans: the long span wraps over lines in the card`, marks.longLines >= 2, String(marks.longLines));

  // The copy button: the one this width shows.
  const sel = phone ? '#lv-lines .cpm' : '#lv-lines .cp';
  const vis = await page.evaluate(() => ({ cp: getComputedStyle(document.querySelector('#lv-lines .cp')).display, cpm: getComputedStyle(document.querySelector('#lv-lines .cpm')).display }));
  check(`${tag}: spans: ${phone ? 'the pill shows, the icon does not' : 'the icon shows, the pill does not'}`, phone ? vis.cpm === 'flex' && vis.cp === 'none' : vis.cp === 'flex' && vis.cpm === 'none', JSON.stringify(vis));
  if (phone) {
    const geo = await page.evaluate(() => { const b = document.querySelector('#lv-lines .cpm').getBoundingClientRect(); const c = document.querySelector('#lv-lines .cb').getBoundingClientRect(); return { h: b.height, same: Math.abs(b.bottom - c.bottom) <= 3 && b.left >= c.right }; });
    check(`${tag}: spans: the pill is 32 px, after its block, at the block's end`, geo.h === 32 && geo.same, JSON.stringify(geo));
  } else {
    await page.hover('#lv-lines .cb');
    const hov = await page.$eval('#lv-lines .cp', (b) => ({ word: getComputedStyle(b.querySelector('.w')).display, text: b.textContent.trim() }));
    check(`${tag}: spans: hover on the chip shows "Copy"`, hov.word !== 'none' && hov.text === 'Copy', JSON.stringify(hov));
    await page.screenshot({ path: path.join(SHOTS, `spans-card-hover-${w}.png`) });
  }
  // Both clipboard paths, each writing the exact text.
  await page.evaluate(() => {
    window.__copied = [];
    document.addEventListener('copy', (e) => { const t = e.target && e.target.value != null ? e.target.value : String(getSelection()); window.__copied.push({ via: 'execCommand', t }); });
    window.__clip = navigator.clipboard;
    if (navigator.clipboard) {
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t) => { window.__copied.push({ via: 'clipboard', t }); return orig(t).catch(() => {}); };
    }
  });
  const before = await page.evaluate(() => !document.querySelector('#lv-fs').hidden);
  await page.click(sel);
  const done1 = await waitFor(page, (q) => { const b = document.querySelector(q); return b.classList.contains('done') && /Copied/.test(b.textContent); }, sel, 3000);
  const c1 = await page.evaluate(() => window.__copied.slice());
  check(`${tag}: spans: copy writes the block with navigator.clipboard, then shows Copied`, done1 && c1.length && c1[0].via === 'clipboard' && c1[0].t === 'node tools/live-screen-test.mjs', JSON.stringify(c1));
  if (!phone) {
    const real = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
    check(`${tag}: spans: the clipboard really holds the block`, real === 'node tools/live-screen-test.mjs', real);
  }
  check(`${tag}: spans: tapping the button does not open full screen`, (await page.evaluate(() => !document.querySelector('#lv-fs').hidden)) === before);
  await page.screenshot({ path: path.join(SHOTS, `spans-copied-${w}.png`) });
  await page.waitForTimeout(1700);
  check(`${tag}: spans: Copied goes after 1.5 s`, await page.$eval(sel, (b) => !b.classList.contains('done') && /Copy/.test(b.textContent) && !/Copied/.test(b.textContent)));
  // The phone page over plain http on the LAN has no navigator.clipboard.
  if (!phone) await page.evaluate(() => navigator.clipboard.writeText('something else'));
  await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
  await page.click(sel);
  const done2 = await waitFor(page, (q) => document.querySelector(q).classList.contains('done'), sel, 3000);
  const c2 = await page.evaluate(() => window.__copied.slice());
  check(`${tag}: spans: without navigator.clipboard, a hidden textarea and execCommand copy the exact text`, done2 && c2.length === 1 && c2[0].via === 'execCommand' && c2[0].t === 'node tools/live-screen-test.mjs', JSON.stringify(c2));
  if (!phone) {
    const real = await page.evaluate(() => window.__clip.readText().catch((e) => 'ERR ' + e.message));
    check(`${tag}: spans: the fallback really put the block on the clipboard`, real === 'node tools/live-screen-test.mjs', real);
  }
  check(`${tag}: spans: the fallback leaves no textarea behind`, await page.evaluate(() => !document.querySelector('body > textarea')));
  await page.evaluate(() => { delete navigator.clipboard; });
  await plainChipChecks(page, tag, phone);

  // Full screen shows the chips too.
  await page.click(phone ? '#lv-tap' : '#lv-exp');
  await page.waitForTimeout(400);
  check(`${tag}: spans: full screen shows the chips`, await page.evaluate(() => document.querySelectorAll('#lv-fs .cd').length >= 6));
  if (!phone) await page.hover('#lv-lines .cb');
  await page.screenshot({ path: path.join(SHOTS, `spans-full-${w}.png`) });
  if (phone) {
    await page.click('#lv-fs .cpm');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `spans-full-copied-${w}.png`) });
  }
  await page.click('#lv-fs [data-lv-close]');
  await page.waitForTimeout(300);

  // S2: the working dot breathing left of "Doing now", only while it works.
  const dot = () => page.evaluate(() => {
    const h = document.querySelector('#d-ask-top h2');
    const svg = h && h.querySelector('svg.doing');
    if (!svg) return { label: h && h.textContent, svg: false };
    const c = getComputedStyle(svg);
    const r = svg.getBoundingClientRect(); const t = h.getBoundingClientRect();
    return { label: h.textContent, svg: true, anim: c.animationName, dur: c.animationDuration, timing: c.animationTimingFunction, opacity: c.opacity, transform: c.transform, left: r.left - t.left, size: svg.getAttribute('width') };
  });
  const d1 = await dot();
  check(`${tag}: S2: the breathing dot is left of "Doing now" while it works`, d1.svg && d1.label === 'Doing now' && d1.anim === 'doing' && d1.dur === '1.6s' && d1.timing === 'ease-in-out' && d1.left < 2 && d1.size === '14', JSON.stringify(d1));
  await page.$eval('#d-ask', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await (await page.$('#d-ask')).screenshot({ path: path.join(SHOTS, `s2-doing-${w}-dark.png`) });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const d2 = await dot();
  check(`${tag}: S2: under reduced motion it is still and solid`, d2.svg && d2.anim === 'none' && d2.opacity === '1' && d2.transform === 'none', JSON.stringify(d2));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  setSteps(2, SPAN_TAIL, { agents: false });
  const off = await waitFor(page, () => { const h = document.querySelector('#d-ask-top h2'); return h && h.textContent !== 'Doing now'; }, null, 12000);
  const d3 = await dot();
  check(`${tag}: S2: no dot once it stops working`, off && !d3.svg && (await page.evaluate(() => !document.querySelector('#d-ask svg.doing'))), JSON.stringify(d3));
  // Light page: the Live screen stays dark, chips the same.
  await page.evaluate(() => document.querySelector('#theme').click());
  setSteps(2, SPAN_TAIL);
  await waitFor(page, () => document.querySelector('#d-ask-top h2').textContent === 'Doing now', null, 12000);
  await page.waitForTimeout(400);
  await page.$eval('#lv-card', (el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(SHOTS, `spans-card-${w}-light.png`) });
  await page.$eval('#d-ask', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await (await page.$('#d-ask')).screenshot({ path: path.join(SHOTS, `s2-doing-${w}-light.png`) });
  await page.click(phone ? '#lv-tap' : '#lv-exp');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `spans-full-${w}-light.png`) });
  await page.click('#lv-fs [data-lv-close]');
  await page.evaluate(() => document.querySelector('#theme').click());
  await page.waitForTimeout(200);
}

// The message from the report ("some formatting issue"), on the page: the
// fenced command is one code block whose Copy copies all of it, "<code>" is
// text, and "! npm login" stays in its sentence at the text's line height.
async function npmMessageChecks(page, tag, w, phone) {
  writeTranscript(['plain', 'cmd', 'broken', 'npm', 'alone']);
  setSteps(2, [...SPAN_TAIL, ...drawReply(NPM_MD, BW), '', ...drawReply(MD.alone, BW), '']);
  const shown = await waitFor(page, () => { const e = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /Run this, with your npm code/.test(x.textContent)); return e && e.querySelector('.cb'); }, null, 12000);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1700);
  const v = await page.evaluate(() => {
    const ent = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /Run this, with your npm code/.test(x.textContent));
    const blocks = Array.from(ent.querySelectorAll('.cb'));
    const b = blocks[0];
    const chips = Array.from(ent.querySelectorAll('.cd')).map((c) => (c.querySelector('.cbt') ? c.querySelector('.cbt').textContent : Array.from(c.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')));
    const para = Array.from(ent.querySelectorAll('.x > div')).find((d) => /If publish answers 404/.test(d.textContent));
    const lh = parseFloat(getComputedStyle(document.querySelector('#lv-scroll')).lineHeight);
    const range = document.createRange();
    range.selectNodeContents(para);
    // Line tops: a chip's box starts a pixel above its line's text, so tops
    // within 4 px are one line.
    const tops = [];
    for (const t of Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => r.top).sort((x, y) => x - y)) if (!tops.length || t - tops[tops.length - 1] > 4) tops.push(t);
    // The words as read: buttons (hidden or not) are not text.
    const words = (n) => { const c = n.cloneNode(true); for (const x of c.querySelectorAll('button')) x.remove(); return c.textContent; };
    const rows = Math.round(para.getBoundingClientRect().height / lh);
    const sc = document.querySelector('#lv-scroll').getBoundingClientRect();
    const wrap = b.closest('.cbw').getBoundingClientRect();
    return {
      blocks: blocks.length,
      text: b.querySelector('.cbt').textContent,
      oneBox: b.querySelector('.cbt').children.length === 0,
      copies: Array.from(b.closest('.cbw').querySelectorAll('[data-lv-copy]')).map((x) => x.dataset.lvCopy),
      chips,
      codeEls: document.querySelectorAll('#lv-lines code').length,
      prose: /in place of <code>:/.test(words(ent)),
      paraButtons: para.querySelectorAll('.cp, .cpm, .cbw').length,
      paraShown: Array.from(para.querySelectorAll('button')).filter((x) => getComputedStyle(x).display !== 'none').length,
      inSentence: /run ! npm login, then the line again/.test(words(para)),
      lh, rows, h: para.getBoundingClientRect().height, steps: tops.slice(1).map((t, k) => Math.round((t - tops[k]) * 10) / 10),
      inside: wrap.right <= sc.right + 0.5 && wrap.left >= sc.left,
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    };
  });
  const CMD = NPM_CMD;
  const alone = await page.evaluate(() => { const ent = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /check the login first/.test(x.textContent)); const b = ent && ent.querySelector('.cb'); return b ? { text: b.querySelector('.cbt').textContent, copy: b.querySelector('[data-lv-copy]').dataset.lvCopy, inline: ent.querySelectorAll('.cd.pl').length } : null; });
  check(`${tag}: npm: a "! " command alone on its line is a code block with Copy`, !!alone && alone.text === '! npm whoami' && alone.copy === '! npm whoami' && alone.inline === 0, JSON.stringify(alone));
  check(`${tag}: npm: the fenced command is one code block showing the whole command`, shown && v.blocks === 1 && v.text === CMD && v.oneBox, JSON.stringify(v));
  check(`${tag}: npm: its Copy copies the whole command, <code> included`, v.copies.length === 2 && v.copies.every((c) => c === CMD), JSON.stringify(v.copies));
  check(`${tag}: npm: the reply's code is "<code>", the block and "! npm login", nothing split`, JSON.stringify(v.chips) === JSON.stringify(['<code>', CMD, '! npm login']), JSON.stringify(v.chips));
  check(`${tag}: npm: "<code>" is shown as text, never as markup`, v.prose && v.codeEls === 0, JSON.stringify(v));
  check(`${tag}: npm: "! npm login" stays in its sentence, no button in the line at rest`, v.inSentence && v.paraButtons === 0 && v.paraShown === 0, JSON.stringify(v));
  check(`${tag}: npm: the sentence keeps its line height (every line step is one line)`, v.steps.length >= 1 && v.steps.every((d) => Math.abs(d - v.lh) <= 1) && Math.abs(v.h - v.rows * v.lh) <= 1, JSON.stringify({ lh: v.lh, steps: v.steps, h: v.h, rows: v.rows }));
  check(`${tag}: npm: the block fits the screen, no sideways scroll`, v.inside && v.sw <= v.cw, JSON.stringify(v));
  // The message itself in view, from its first line.
  const toMessage = () => page.evaluate(() => { const ent = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /Run this, with your npm code/.test(x.textContent)); const sc = document.querySelector('#lv-scroll'); sc.scrollTop += ent.getBoundingClientRect().top - sc.getBoundingClientRect().top - 12; });
  await page.$eval('#lv-card', (el) => el.scrollIntoView({ block: 'start' }));
  await toMessage();
  await page.waitForTimeout(200);
  await (await page.$('#lv-card')).screenshot({ path: path.join(SHOTS, `npm-message-${w}-card.png`) });
  // Copy, with the button this width shows.
  await page.evaluate(() => {
    window.__copied = [];
    if (!window.__npmHook) {
      window.__npmHook = true;
      document.addEventListener('copy', (e) => { const t = e.target && e.target.value != null ? e.target.value : String(getSelection()); window.__copied.push({ via: 'execCommand', t }); });
      if (navigator.clipboard) { const orig = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__copied.push({ via: 'clipboard', t }); return orig(t); }; }
    }
  });
  const btn = phone ? '.cpm' : '.cp';
  await page.evaluate((q) => { const ent = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /Run this, with your npm code/.test(x.textContent)); ent.querySelector(q).click(); }, btn);
  const done = await waitFor(page, (q) => { const ent = Array.from(document.querySelectorAll('#lv-lines > .e.c')).find((x) => /Run this, with your npm code/.test(x.textContent)); const b = ent.querySelector(q); return b.classList.contains('done') && /Copied/.test(b.textContent); }, btn, 3000);
  const got = await page.evaluate(() => window.__copied.splice(0));
  check(`${tag}: npm: Copy puts exactly the command on the clipboard and says Copied`, done && got.length >= 1 && got[got.length - 1].t === CMD, JSON.stringify(got));
  await page.waitForTimeout(1700);
  await page.click(phone ? '#lv-tap' : '#lv-exp');
  await page.waitForTimeout(400);
  const fs1 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, n: document.querySelectorAll('#lv-fs .cb').length }));
  check(`${tag}: npm: full screen shows the same block, no sideways scroll`, fs1.n >= 2 && fs1.sw <= fs1.cw, JSON.stringify(fs1));
  await toMessage();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, `npm-message-${w}-full.png`) });
  await page.click('#lv-fs [data-lv-close]');
  await page.waitForTimeout(300);
  setSteps(130);
  await waitFor(page, () => /Step 130:/.test(document.querySelector('#lv-lines').textContent), null, 12000);
}

// A run of 16 of the same background notice on the page: one row, the text
// cut with an ellipsis where it does not fit, the count always in view.
async function noticeChecks(page, tag, w) {
  setSteps(2, ['⏺ Hand-off deferred: not at a clean point. The hook asks again at a later stop.', '', ...sixteen]);
  const shown = await waitFor(page, () => /×16/.test(document.querySelector('#lv-lines').textContent), null, 12000);
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#lv-lines > .e')).filter((e) => /is waiting on its own background work/.test(e.textContent));
    const row = rows[0];
    if (!row) return { rows: 0 };
    const tb = row.querySelector('.tn .tb');
    const more = row.querySelector('.tn .more');
    const x = row.querySelector('.x').getBoundingClientRect();
    const m = more.getBoundingClientRect();
    return { rows: rows.length, count: more.textContent, cut: tb.scrollWidth > tb.clientWidth, ellipsis: getComputedStyle(tb).textOverflow, inView: m.width > 0 && m.right <= x.right + 0.5 && m.left >= x.left, colour: getComputedStyle(more).color, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  check(`${tag}: notices: 16 of the same notice are one row ending in ×16`, shown && v.rows === 1 && v.count === '×16', JSON.stringify(v));
  check(`${tag}: notices: the count stays in view, in the dim "+N lines" colour`, v.inView && v.colour === 'rgb(74, 74, 80)' && v.ellipsis === 'ellipsis' && v.sw <= v.cw, JSON.stringify(v));
  if (w < 600) check(`${tag}: notices: on a phone the text is cut, not the count`, v.cut, JSON.stringify(v));
  await page.$eval('#lv-card', (el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, `notices-${w}.png`) });
  await (await page.$('#lv-card')).screenshot({ path: path.join(SHOTS, `notices-${w}-card.png`) });
  setSteps(130);
  await waitFor(page, () => /Step 130:/.test(document.querySelector('#lv-lines').textContent), null, 12000);
}

try {
  let st = null;
  for (let i = 0; i < 80; i++) {
    try { const r = await getJson('/api/state'); st = r.body; if (st.projects[0] && st.projects[0].sessions.length) break; } catch { /* starting */ }
    await sleep(150);
  }
  const s0 = st && st.projects[0] && st.projects[0].sessions[0];
  check('board: the test session is found, with its read time in the snapshot', !!(s0 && s0.surfaceId === SID && typeof s0.screenAt === 'number'), child.log.slice(-300));
  let r = await getJson(`/api/live?surface=${SID}`);
  check('api: /api/live sends the trimmed screen with its read time and the server clock', r.status === 200 && r.body.live && r.body.entries.length > 0 && typeof r.body.at === 'number' && typeof r.body.now === 'number');
  check('api: the long buffer is 200 lines of scrollback', r.body.lines === 200, String(r.body.lines));
  check('api: the trimmed screen ends at the newest step', r.body.entries[r.body.entries.length - 1].l[0].startsWith('Step 130:'));
  const v0 = r.body.ver;
  const at0 = r.body.at;
  await sleep(2500);
  r = await getJson(`/api/live?surface=${SID}&v=${v0}`);
  check('api: a newer read of an unchanged screen answers "same" with the new read time, without the buffer', r.body.same === true && r.body.ver === v0 && r.body.at > at0 && !r.body.entries, JSON.stringify(r.body).slice(0, 200));
  r = await getJson('/api/live?surface=nope');
  check('api: an unknown tab is a 404', r.status === 404);
  await sleep(2500);
  const st2 = (await getJson('/api/state')).body;
  const ss = st2.projects[0].sessions[0];
  {
    // Code spans from the transcript, on the API.
    writeTranscript(['plain', 'cmd', 'broken']);
    setSteps(2, SPAN_TAIL);
    const b = await liveNow((x) => { const e = cmdEntry(x); return e && e.cs; });
    const e = b && cmdEntry(b);
    check('api: spans: the reply carries its three code spans, each placed in its line', !!e && JSON.stringify(e.cs.map((x) => x.t)) === JSON.stringify(['! npm login', 'npm publish --access public --tag next --registry https://registry.npmjs.org/', 'ravenry-public']) && e.cs.every((x) => x.r.every(([li, a, z]) => e.l[li].slice(a, z).length > 0)), JSON.stringify(e && e.cs));
    check('api: spans: only the "! " span is a command', !!e && e.cs.filter((x) => x.cmd).map((x) => x.t).join() === '! npm login');
    check('api: spans: user, tool and plain entries carry none', !!b && b.entries.filter((x) => x.cs).every((x) => x.k === 'c') && !b.entries.some((x) => x.k === 'c' && /Plain words/.test(x.l.join(' ')) && x.cs), JSON.stringify(b && b.entries.map((x) => [x.k, !!x.cs])));
    const v1 = b.ver;
    await sleep(2300);
    const same1 = (await getJson(`/api/live?surface=${SID}&v=${v1}`)).body;
    check('api: spans: an unchanged screen and transcript still answer "same"', same1.same === true, JSON.stringify(same1).slice(0, 120));
    fs.appendFileSync(TRANSCRIPT, rec('A later message with `nothing` on screen.', 9) + '\n');
    await sleep(300);
    const moved = (await getJson(`/api/live?surface=${SID}&v=${v1}`)).body;
    check('api: spans: a new Claude message in the transcript moves the version', !moved.same && moved.ver > v1 && moved.entries, JSON.stringify(moved).slice(0, 120));
    setSteps(130);
  }
  check('snapshot: no long buffer in it, only the last 10 lines and a read time per session, as before', ss.screen.length <= 10 && !JSON.stringify(st2).includes('Step 100:') && typeof ss.screenAt === 'number', `${ss.screen.length} lines, ${Buffer.byteLength(JSON.stringify(st2))} bytes`);

  for (const en of ['chromium', 'webkit']) {
    const phone = en === 'webkit';
    const browser = await (phone ? webkit : chromium).launch({ headless: true });
    const ctx = await browser.newContext(phone ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'dark' } : { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    if (process.env.LIVE_DEBUG) page.on('response', async (res) => { if (res.url().includes('/api/live')) { try { const j = await res.json(); console.log('   live', en, j.same ? 'same' : j.lines, j.entries ? j.entries.length : '', j.entries && j.entries[0] ? (j.entries[0].l || [''])[0].slice(0, 9) : ''); } catch { /* */ } } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const tag = phone ? 'webkit 390' : 'chromium 1440';
    setSteps(130);
    // The board has read the reset screen before the page opens.
    for (let i = 0; i < 40; i++) { const x = (await getJson(`/api/live?surface=${SID}`)).body; if (x.entries && /^Step 130:/.test(x.entries[x.entries.length - 1].l[0])) break; await sleep(250); }
    await page.goto(`http://127.0.0.1:${PORT}/?theme=dark#live`);
    await page.waitForSelector('#lv-lines .e', { timeout: 15000 });
    await page.waitForTimeout(800);
    const atBottom = () => page.$eval('#lv-scroll', (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
    check(`${tag}: the card opens at the bottom`, await atBottom());
    const lineH = await page.$eval('#lv-scroll', (el) => ({ h: el.clientHeight, lh: parseFloat(getComputedStyle(el).lineHeight) }));
    const rows = Math.round((lineH.h - 24) / lineH.lh);
    check(`${tag}: default height is ${phone ? 14 : 18} lines`, rows === (phone ? 14 : 18), `${rows} lines, ${lineH.h}px`);
    check(`${tag}: freshness says Live`, await waitFor(page, () => /^Live/.test(document.querySelector('#lv-card [data-fresh]').textContent)));
    check(`${tag}: the status row reads the agent list`, await waitFor(page, () => /1 background agent/.test(document.querySelector('#lv-st').textContent) && /Shoot the board at 390/.test(document.querySelector('#lv-st').textContent)));

    // Stick to the bottom while lines arrive.
    setSteps(133);
    check(`${tag}: new lines arrive`, await waitFor(page, () => /Step 133:/.test(document.querySelector('#lv-lines').textContent)));
    check(`${tag}: still stuck to the bottom`, await atBottom());

    // Scrolled up: no following, a pill counts the new lines.
    await page.$eval('#lv-scroll', (el) => { el.scrollTop = Math.round(el.scrollHeight / 3); el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(300);
    const firstSeen = await page.$eval('#lv-scroll', (sc) => { for (const n of sc.querySelectorAll('#lv-lines > *')) if (n.offsetTop + n.offsetHeight > sc.scrollTop) return { text: n.textContent.slice(0, 12), off: n.offsetTop - sc.scrollTop }; return null; });
    setSteps(137);
    check(`${tag}: the pill says 4 new lines`, await waitFor(page, () => { const b = document.querySelector('#lv-jump'); return b && !b.hidden && b.textContent.trim() === '4 new lines, jump to latest'; }), await page.$eval('#lv-jump', (b) => b.hidden + ' ' + b.textContent));
    const stay = await page.$eval('#lv-scroll', (sc) => { for (const n of sc.querySelectorAll('#lv-lines > *')) if (n.offsetTop + n.offsetHeight > sc.scrollTop) return { text: n.textContent.slice(0, 12), off: n.offsetTop - sc.scrollTop }; return null; });
    check(`${tag}: the line being read stays put while old lines scroll off the top`, stay && firstSeen && stay.text === firstSeen.text && Math.abs(stay.off - firstSeen.off) < 2, JSON.stringify([firstSeen, stay]));
    check(`${tag}: not pulled to the bottom`, !(await atBottom()));
    if (phone) await page.screenshot({ path: path.join(T, 'pill-390.png') });
    await page.click('#lv-jump');
    await page.waitForTimeout(300);
    check(`${tag}: the pill jumps to the latest and goes`, (await atBottom()) && await page.$eval('#lv-jump', (b) => b.hidden));
    setSteps(138);
    check(`${tag}: following again after the jump`, await waitFor(page, () => /Step 138:/.test(document.querySelector('#lv-lines').textContent)) && await atBottom());

    // The last entry goes while the first stays (a report on 2026-11-03:
    // "Sometimes I see null"): Claude's reply, then the spinner's task line under
    // "Waiting for 1 background agent", which the next read no longer has.
    // The screen keeps its height, so the 200-line window starts at the same
    // entry and only the tail shrinks. In full screen on the phone, as it was seen.
    if (phone) { await page.click('#lv-tap'); await page.waitForTimeout(300); }
    const reply = '⏺ It finishes by rebuilding the public copy as one clean commit, with the audit and tests run again.';
    setSteps(138, [reply, '', '✻ Waiting for 1 background agent (esc to interrupt)', '  ⎿  ☐ Rebuild the public copy', '']);
    check(`${tag}: the spinner's task line shows`, await waitFor(page, () => /Rebuild the public copy/.test(document.querySelector('#lv-lines').textContent)));
    setSteps(138, [reply, '', '✻ Waiting for 1 background agent (esc to interrupt)', '', '']);
    const gone = await waitFor(page, () => !/Rebuild the public copy/.test(document.querySelector('#lv-lines').textContent));
    const tailDom = await page.$eval('#lv-lines', (b) => ({ text: b.textContent, stray: Array.from(b.childNodes).filter((n) => n.nodeType !== 1).map((n) => n.textContent), last: b.lastElementChild ? b.lastElementChild.textContent : '' }));
    check(`${tag}: when the last entry goes, nothing is left in its place (no "null")`, gone && !/\bnull\b|\bundefined\b/.test(tailDom.text) && tailDom.stray.length === 0 && /rebuilding the public copy/.test(tailDom.last), JSON.stringify({ gone, stray: tailDom.stray, last: tailDom.last.slice(0, 60) }));
    await page.screenshot({ path: path.join(T, `tail-gone-${phone ? 390 : 1440}.png`) });
    if (phone) { await page.click('#lv-fs [data-lv-close]'); await page.waitForTimeout(300); }
    setSteps(138);
    check(`${tag}: back to the plain screen`, await waitFor(page, () => !/rebuilding the public copy/.test(document.querySelector('#lv-lines').textContent)));

    // Freshness from a faked read time.
    const fake = async (ageMs) => {
      await page.unroute('**/api/live*').catch(() => {});
      await page.route('**/api/live*', async (route) => {
        const res = await route.fetch({ url: route.request().url().replace(/&v=\d+/, '') });
        const j = await res.json();
        j.at = j.now - ageMs;
        delete j.same;
        await route.fulfill({ response: res, json: j });
      });
    };
    await fake(12000);
    check(`${tag}: 12 s old reads Slow, in orange`, await waitFor(page, () => { const f = document.querySelector('#lv-card [data-fresh]'); return f.classList.contains('slow') && /^Slow/.test(f.textContent); }), await page.$eval('#lv-card [data-fresh]', (f) => f.className + ' ' + f.textContent));
    await fake(41000);
    check(`${tag}: 41 s old reads Not updating, in red, text dimmed`, await waitFor(page, () => { const f = document.querySelector('#lv-card [data-fresh]'); return f.classList.contains('stale') && /^Not updating/.test(f.textContent) && document.querySelector('#lv').classList.contains('stale') && getComputedStyle(document.querySelector('#lv .measure')).opacity === '0.6'; }), await page.$eval('#lv-card [data-fresh]', (f) => f.className + ' ' + f.textContent));
    if (!phone) await page.screenshot({ path: path.join(T, 'stale-1440.png') });
    await page.unroute('**/api/live*');
    check(`${tag}: back to Live when reads land again`, await waitFor(page, () => /^Live/.test(document.querySelector('#lv-card [data-fresh]').textContent)));

    if (!phone) {
      // Pinned while the left column scrolls (a test-only spacer gives this
      // one-project board a left column as long as a real one).
      await page.evaluate(() => { document.querySelector('.col-l').insertAdjacentHTML('beforeend', '<div id="test-spacer" style="height: 2400px"></div>'); window.scrollTo(0, 600); });
      await page.waitForTimeout(200);
      const top = await page.$eval('#lv-card', (c) => c.getBoundingClientRect().top);
      check(`${tag}: the card stays pinned at the top while the page scrolls`, Math.abs(top - 12) < 1.5, String(top));
      await page.evaluate(() => { document.querySelector('#test-spacer').remove(); window.scrollTo(0, 0); });
      const split = await page.$eval('.col-l', (l) => [l.offsetWidth, document.querySelector('.col-r').offsetWidth]);
      check(`${tag}: the columns split evenly`, Math.abs(split[0] - split[1]) <= 1, JSON.stringify(split));
    } else {
      // As on desktop, the folder line follows the title, then the hand-off
      // details; the card comes next, right above the answer card.
      const geo = await page.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { title: r('#d-head h1').bottom, meta: r('#d-meta').top, metaEnd: r('#d-meta').bottom, handoffEnd: r('#d-handoff').bottom, card: r('#lv-card').top, cardEnd: r('#lv-card').bottom, ask: r('#d-ask').top }; });
      check(`${tag}: the folder line under the title, then the card, the answer card right under it`, geo.meta > geo.title && geo.meta - geo.title < 12 && geo.card > geo.metaEnd && geo.card >= geo.handoffEnd && geo.ask > geo.cardEnd && geo.ask - geo.cardEnd <= 24, JSON.stringify(geo));
    }

    // Full screen with the composer, and back.
    await page.click(phone ? '#lv-tap' : '#lv-exp');
    await page.waitForTimeout(400);
    const fsState = await page.evaluate(() => ({ open: !document.querySelector('#lv-fs').hidden, lv: !!document.querySelector('#lv-fs #lv'), composer: !!document.querySelector('#lv-fs #composer'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, chars: Math.round(document.querySelector('#lv-fs .measure').clientWidth / (parseFloat(getComputedStyle(document.querySelector('#lv-scroll')).fontSize) * 0.6)) }));
    check(`${tag}: full screen holds the terminal and the composer`, fsState.open && fsState.lv && fsState.composer, JSON.stringify(fsState));
    check(`${tag}: full screen does not scroll sideways`, fsState.sw <= fsState.cw, JSON.stringify(fsState));
    if (!phone) check(`${tag}: full screen reading width is about 125 characters`, fsState.chars >= 118 && fsState.chars <= 132, String(fsState.chars));
    check(`${tag}: full screen opens at the bottom`, await atBottom());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => ({ hidden: document.querySelector('#lv-fs').hidden, lvHome: !!document.querySelector('#lv-card #lv'), composerHome: !!document.querySelector('#d-ask #composer') }));
    check(`${tag}: Esc closes it and puts the terminal and composer back`, back.hidden && back.lvHome && back.composerHome, JSON.stringify(back));
    if (phone) {
      // Tapping the card itself opens it too; Back closes it.
      await page.click('#lv-scroll');
      await page.waitForTimeout(300);
      const open = await page.$eval('#lv-fs', (l) => !l.hidden);
      await page.click('#lv-fs [data-lv-close]');
      await page.waitForTimeout(300);
      check(`${tag}: a tap on the card opens full screen, Back closes it`, open && await page.$eval('#lv-fs', (l) => l.hidden));
    } else {
      await page.click('#lv-exp');
      await page.waitForTimeout(200);
      await page.click('#lv-fs [data-lv-close]');
      await page.waitForTimeout(200);
      check(`${tag}: the Exit full screen button closes it`, await page.$eval('#lv-fs', (l) => l.hidden));
    }
    await noticeChecks(page, tag, phone ? 390 : 1440);
    await spanChecks(page, ctx, tag, phone);
    await npmMessageChecks(page, tag, phone ? 390 : 1440, phone);
    await menuChecks(page, tag, phone);
    check(`${tag}: no page errors`, errs.length === 0, errs.join(' | '));
    await browser.close();
  }
  {
    // A phone in Chrome on Android, 412 wide.
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/?theme=dark#live`);
    await page.waitForSelector('#lv-lines .e', { timeout: 15000 });
    await noticeChecks(page, 'chromium 412', 412);
    await npmMessageChecks(page, 'chromium 412', 412, true);
    check('chromium 412: no page errors', errs.length === 0, errs.join(' | '));
    await browser.close();
  }
} finally {
  child.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll live screen checks pass');
process.exit(fails ? 1 : 0);
