#!/usr/bin/env node
// Codex support, stage two (docs/design/CodexStage2.dc.html): sections 1
// (variant C, "Not in a project"), 2 (variant A, the assistant tag) and 4
// (variant A, AGENTS.md beside CLAUDE.md in Your rules), and the Codex
// menu's Live screen showing its text once.
//
// - pure: a Codex menu trimmed for the Live screen holds its text and options
//   once; which processes are Codex sessions; the Rules scopes on scratch
//   files (a missing AGENTS.md, an empty one, AGENTS.override.md first);
// - a test board on :4696 with the fake cmux and the ps stub, whose registry
//   holds Paper Boat (a Claude Code and a Codex session), Recipe Box (no
//   session, a CLAUDE.md and no AGENTS.md), a hidden project's workspace and
//   an ignored one; and two workspaces no project lists: kite-tracker, a
//   Codex session at its "Trust this folder?" menu, and scratch, an idle
//   Claude Code session. Driven headless in Chromium:
//   kite-tracker in Needs you as a folder (glyph, dashed chip on the phone),
//   scratch in the Not in a project group; the hidden and ignored ones
//   nowhere; the sheet (Live screen, the menu answered from the board, the
//   message box without Add as note and New session, the Not in a project
//   card); Add to a project writing the registry and the session moving;
//   New project from this folder making a project that lists the workspace
//   and opens nothing; the tags ("Claude", "Codex") on the Sessions card, the
//   Live screen header, the Sessions page and folder rows, and none on
//   project rows; the top bar reading Sessions; Rules in two columns.
//
// --shots <dir>: each item at 1440x900 and 390x844, dark and light.
//
// --real <scratch folder>: the live check (section 3 below), on the real cmux.
//
// Usage: node tools/codex-stage2-test.mjs [--shots <dir>] [--real <scratch folder>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'codex-stage2');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boardEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RAVENRY_|MC_|PORT$|CMUX_|CODEX_HOME$)/.test(k)));

// ------------------------------------------------------------ the screens

// Codex's folder trust menu as Codex 0.166.0 draws it
// (tools/fixtures/codex/01-trust.txt, with this test's folder).
const trust = (folder) => `
  Folder access
  ${folder}

  Trust this folder? Codex can read, edit, and run files here, subject to your permission
  settings. Folder settings can run code automatically, even without a model request. Continue
  only if you trust these files. Your trust decision will be saved.

› 1. Trust and continue
  2. Quit

  enter continue · esc quit
${'\n'.repeat(20)}`;
// Codex at rest (tools/fixtures/codex/10-done2.txt).
const codexRest = (folder, said = 'pong', thread = 'Reply with pong') => `  >_ OpenAI Codex (v0.166.0)
     ${folder}

› Reply with exactly the word: ${said}

• ${said}

  Worked for 1s • 12:04

› Ask Codex to do anything

  GPT-5.6-Luna low · ${folder} · ${thread}
  ← for agents · ? for shortcuts
`;

// ------------------------------------------------------------ 1. pure

const CX = path.join(ROOT, 'tools', 'fixtures', 'codex');
const codex = await import('../server/codex.mjs');
{
  const tr = codex.trimScreen(trust('/Users/you/projects/kite-tracker'));
  const all = JSON.stringify(tr.entries);
  const times = (re) => (all.match(re) || []).length;
  check('trim: a Codex menu\'s text shows once', times(/Trust this folder\?/g) === 1 && times(/Folder access/g) === 1, `${times(/Trust this folder\?/g)}x`);
  check('trim: its options and hint once, as drawn, never as a prompt you sent', times(/1\. Trust and continue/g) === 1 && times(/enter continue · esc quit/g) === 1 && !tr.entries.some((e) => e.k === 'u'), tr.entries.map((e) => e.k).join(''));
  check('trim: the menu is one block, its text above its options', tr.entries.length === 1 && tr.entries[0].k === 'p' && tr.entries[0].l.findIndex((l) => /Folder access/.test(l)) < tr.entries[0].l.findIndex((l) => /1\. Trust/.test(l)));
  if (fs.existsSync(path.join(CX, '01-trust.txt'))) {
    const real = JSON.stringify(codex.trimScreen(fs.readFileSync(path.join(CX, '01-trust.txt'), 'utf8')).entries);
    check('trim: the captured trust screen (01-trust.txt) shows its text once', (real.match(/Trust this folder\?/g) || []).length === 1 && (real.match(/1\. Trust and continue/g) || []).length === 1);
    const perm = codex.trimScreen(fs.readFileSync(path.join(CX, '14-permission.txt'), 'utf8'));
    const pj = JSON.stringify(perm.entries);
    check('trim: a captured approval (14-permission.txt): history read as before, the menu once', (pj.match(/Would you like to run the following command\?/g) || []).length === 1 && (pj.match(/1\. Yes, proceed/g) || []).length === 1 && perm.entries.some((e) => e.k === 'u' && e.l[0] === 'Reply with exactly the word: ping') && perm.entries.some((e) => e.k === 't' && e.n === 'Running'));
  } else console.log('SKIP  captured Codex screens (tools/fixtures/codex/ is not in this copy)');
}

const sess = await import('../server/sessions.mjs');
{
  const ps = [
    '  201     1 120000 Wed Nov  4 10:00:00 2026     /Users/x/.nvm/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex',
    '  202     1  90000 Wed Nov  4 10:00:00 2026     /Users/x/bin/codex resume 0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a',
    '  203     1  68976 Fri Oct  2 21:52:11 2026     /Users/x/.vscode/extensions/openai.chatgpt/bin/macos-aarch64/codex -c features.code_mode_host=true app-server --analytics-default-enabled',
    '  204     1  50000 Wed Nov  4 10:00:00 2026     /Users/x/bin/codex exec --json --ephemeral -',
    '  205     1  40000 Wed Nov  4 10:00:00 2026     node /Users/x/.nvm/bin/codex',
    '  206     1  30000 Wed Nov  4 10:00:00 2026     /Users/x/bin/codex-code-mode-host',
    '  207     1  80000 Wed Nov  4 10:00:00 2026     /Users/x/bin/codex -m gpt-6 please review the end screen',
    '  208     1 600000 Wed Nov  4 10:00:00 2026     /Users/x/.local/bin/claude --resume aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  ].join('\n');
  const procs = sess.parsePs(ps);
  const kind = (pid) => { const p = procs.find((x) => x.pid === pid); return p ? `${p.assistant}:${p.kind}` : 'none'; };
  check('ps: the Codex binary is a Codex session; resume is one too', kind(201) === 'codex:session' && kind(202) === 'codex:session');
  check('ps: Codex helpers (app-server behind -c, exec) are not sessions', kind(203) === 'codex:helper' && kind(204) === 'codex:helper');
  check('ps: its node launcher and other binaries are not Codex at all', kind(205) === 'none' && kind(206) === 'none');
  check('ps: a prompt that says "review" after an option is still a session', kind(207) === 'codex:session');
  check('ps: Claude Code still reads as before', kind(208) === 'claude:session' && sess.claudeKind('/x/claude --chrome-native-host') === 'helper');
  check('ps: `codex resume <id>` names its session', sess.codexArgvSession(procs.find((x) => x.pid === 202).command) === '0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a');
}

// ------------------------------------------------------------ the scratch world

const PROJ = path.join(T, 'projects');
const BOAT = path.join(PROJ, 'paper-boat');
const RECIPE = path.join(PROJ, 'recipe-box');
const KITE = path.join(PROJ, 'kite-tracker');
const SCR = path.join(PROJ, 'scratch');
const HID = path.join(PROJ, 'hidden-one');
const IGN = path.join(PROJ, 'ignored-one');
for (const d of [BOAT, RECIPE, KITE, SCR, HID, IGN]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(BOAT, 'BRIEF.md'), '# Paper Boat\n\nGoal: A paper boat that floats.\n\n## Next step\nTilt the hull.\n\n## Hand-off\n');
fs.writeFileSync(path.join(BOAT, 'CLAUDE.md'), '# Paper Boat\n\n- Run `node tools/shoot.mjs` after any change to a screen.\n- The boat is drawn in canvas; never add DOM inside the game.\n');
fs.writeFileSync(path.join(BOAT, 'AGENTS.md'), '# Paper Boat\n\n- Run `node tools/shoot.mjs` after any change to a screen.\n- Use npm, not pnpm.\n');
fs.writeFileSync(path.join(RECIPE, 'CLAUDE.md'), '# Recipe Box\n\n- Keep the old import format readable.\n');
const GLOBAL_MD = path.join(T, 'CLAUDE.md');
fs.writeFileSync(GLOBAL_MD, '# Rules\n\n## Doing what I asked\n- Change only the part I named; mention anything else in one line.\n- Ask before deleting files you did not make.\n\n## Writing\n- Commit messages say why, not what.\n');
const CODEX_HOME = path.join(T, 'codex-home');
fs.mkdirSync(CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(CODEX_HOME, 'AGENTS.md'), '## Doing what I asked\n- Change only the part I named; mention anything else in one line.\n\n## Writing\n- Commit messages say why, not what.\n- Keep replies short: the result first, then the detail.\n');

{
  process.env.MC_CODEX_HOME = CODEX_HOME;
  const rf = await import('../server/rulefiles.mjs');
  const projects = [
    { id: 'paper-boat', name: 'Paper Boat', folder: BOAT },
    { id: 'recipe-box', name: 'Recipe Box', folder: RECIPE },
    { id: 'kite', name: 'Kite', folder: KITE },
  ];
  const sc = rf.scopes({ globalClaudeMd: GLOBAL_MD }, projects, { codex: CODEX_HOME });
  const boat = sc.find((x) => x.name === 'Paper Boat');
  const recipe = sc.find((x) => x.name === 'Recipe Box');
  check('rules: every project first, with ~/.claude/CLAUDE.md beside <CODEX_HOME>/AGENTS.md', sc[0].key === 'global' && sc[0].claude.exists && sc[0].codex.exists && /codex-home\/AGENTS\.md$/.test(sc[0].codex.path) && sc[0].codex.groups.map((g) => g.heading).join() === 'Doing what I asked,Writing');
  check('rules: a project with both files shows both, whole', boat && boat.claude.count === 2 && boat.codex.count === 2 && boat.codex.groups[0].heading === 'Paper Boat' && boat.codex.groups[0].rules[1] === 'Use npm, not pnpm.');
  check('rules: a missing AGENTS.md says so; a folder with neither file is left out', recipe && recipe.claude.exists && !recipe.codex.exists && recipe.codex.path === 'AGENTS.md' && !sc.some((x) => x.name === 'Kite'));
  fs.writeFileSync(path.join(BOAT, 'AGENTS.override.md'), '');
  check('rules: an empty AGENTS.override.md is passed over', rf.scopes({ globalClaudeMd: GLOBAL_MD }, projects, { codex: CODEX_HOME }).find((x) => x.name === 'Paper Boat').codex.path === 'AGENTS.md');
  fs.writeFileSync(path.join(BOAT, 'AGENTS.override.md'), '- Only this.\n');
  const ov = rf.scopes({ globalClaudeMd: GLOBAL_MD }, projects, { codex: CODEX_HOME }).find((x) => x.name === 'Paper Boat').codex;
  check('rules: AGENTS.override.md is the one Codex reads when it holds something', ov.path === 'AGENTS.override.md' && ov.count === 1 && ov.groups[0].heading === 'AGENTS.override.md');
  fs.rmSync(path.join(BOAT, 'AGENTS.override.md'));
}

// ------------------------------------------------------------ 2. the board

const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
const REG = path.join(MC, 'projects.json');
fs.writeFileSync(REG, JSON.stringify({
  version: 1,
  ignoreWorkspaces: ['ws-ignored'],
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: GLOBAL_MD, backupDir: path.join(T, 'backups'), projectsRoot: PROJ, repeatsAuto: false, launchCommand: 'claude' },
  projects: [
    { id: 'paper-boat', name: 'Paper Boat', folder: BOAT, workspaces: ['ws-boat'], brief: 'BRIEF.md' },
    { id: 'recipe-box', name: 'Recipe Box', folder: RECIPE, workspaces: [], brief: null },
    { id: 'hidden-one', name: 'Hidden One', folder: HID, workspaces: ['ws-hidden'], brief: null, hidden: true },
  ],
}, null, 2));

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = { boatC: id(1), boatX: id(2), kite: id(3), scr: id(4), hid: id(5), ign: id(6) };
const SID = { boatC: 'c1c1c1c1-1111-4111-8111-c1c1c1c1c1c1', boatX: 'd2d2d2d2-2222-4222-8222-d2d2d2d2d2d2', kite: 'e3e3e3e3-3333-4333-8333-e3e3e3e3e3e3', scr: 'f4f4f4f4-4444-4444-8444-f4f4f4f4f4f4' };
const CLAUDE_BODY = '\n⏺ The hull now follows the wave height under its middle. Next: tilt it with the slope.\n\n✻ Worked for 1m 12s\n';
const FAKE = path.join(T, 'fake-cmux.json');
const NOW = new Date().toISOString();
const hookRec = (agent, sid, surface, ws, cwd, pid) => ({ agent, session_id: sid, surface_id: surface, workspace_id: ws, agent_lifecycle: 'idle', active_for_surface: true, cwd, updated_at: NOW, pid, stored_pid_exists: true });
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: [
    { id: 'ws-boat', ref: 'workspace:1', title: 'Paper Boat', cwd: BOAT, surfaces: [{ id: S.boatC, ref: 'surface:1', title: '✳ Tilting the hull' }, { id: S.boatX, ref: 'surface:2', title: 'Fix the end screen on small phones | paper-boat' }] },
    { id: 'ws-kite', ref: 'workspace:2', title: 'kite-tracker', cwd: KITE, surfaces: [{ id: S.kite, ref: 'surface:3', title: 'kite-tracker' }] },
    { id: 'ws-scratch', ref: 'workspace:3', title: 'scratch', cwd: SCR, surfaces: [{ id: S.scr, ref: 'surface:4', title: '✳ CSV parser' }] },
    { id: 'ws-hidden', ref: 'workspace:4', title: 'Hidden One', cwd: HID, surfaces: [{ id: S.hid, ref: 'surface:5', title: '✳ Hidden work' }] },
    { id: 'ws-ignored', ref: 'workspace:5', title: 'Ravenry', cwd: IGN, surfaces: [{ id: S.ign, ref: 'surface:6', title: '✳ Ignored work' }] },
  ],
  screens: { [S.boatX]: codexRest(BOAT, 'done', 'Fix the end screen on small phones'), [S.kite]: trust(KITE) },
  prompts: { [S.boatC]: { body: CLAUDE_BODY }, [S.scr]: { body: '\n⏺ Done: the CSV now parses.\n\n✻ Worked for 20s\n' }, [S.hid]: { body: CLAUDE_BODY }, [S.ign]: { body: CLAUDE_BODY } },
  menus: { [S.kite]: { after: codexRest(KITE, 'ready', 'kite-tracker') } },
  hookSessions: [
    hookRec('claude', SID.boatC, S.boatC, 'ws-boat', BOAT, 9001),
    hookRec('codex', SID.boatX, S.boatX, 'ws-boat', BOAT, 9002),
    hookRec('codex', SID.kite, S.kite, 'ws-kite', KITE, 9003),
    hookRec('claude', SID.scr, S.scr, 'ws-scratch', SCR, 9004),
  ],
}));
const PS = path.join(T, 'ps.json');
const started = new Date(Date.now() - 3600e3).toISOString();
fs.writeFileSync(PS, JSON.stringify([
  { pid: 9001, rssKb: 844800, startedAt: started, command: `/Users/x/.local/bin/claude --resume ${SID.boatC}`, cwd: BOAT, env: `CMUX_SURFACE_ID=${S.boatC}` },
  { pid: 9002, rssKb: 317440, startedAt: started, command: '/Users/x/bin/codex', cwd: BOAT, env: `CMUX_SURFACE_ID=${S.boatX}` },
  { pid: 9003, rssKb: 122880, startedAt: started, command: '/Users/x/bin/codex', cwd: KITE, env: `CMUX_SURFACE_ID=${S.kite}` },
  { pid: 9004, rssKb: 92160, startedAt: started, command: `/Users/x/.local/bin/claude --resume ${SID.scr}`, cwd: SCR, env: `CMUX_SURFACE_ID=${S.scr}` },
]));

const PORT = 4696;
const base = `http://localhost:${PORT}`;
const env = {
  ...boardEnv, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
  MC_CLAUDE_PROJECTS: path.join(T, 'claude-projects'), MC_PROJECTS_ROOT: PROJ, MC_GLOBAL_CLAUDE_MD: GLOBAL_MD, MC_BACKUP_DIR: path.join(T, 'backups'),
  MC_CODEX_HOME: CODEX_HOME, MC_CODEX: '0',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE,
  MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: PS,
};
fs.mkdirSync(env.MC_CLAUDE_PROJECTS, { recursive: true });
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
const state = async () => (await fetch(base + '/api/state')).json();
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json().catch(() => null) }; };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(200); } return v; };
const regNow = () => JSON.parse(fs.readFileSync(REG, 'utf8'));
const fst = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));

let browser = null;
try {
  let s = await until(async () => { const x = await state(); return x.generatedAt && x.sessions && x.sessions.at && x.projects.some((p) => p.id === 'ws:ws-kite') ? x : null; }, 15000);
  const kite = s && s.projects.find((p) => p.id === 'ws:ws-kite');
  const scr = s && s.projects.find((p) => p.id === 'ws:ws-scratch');
  check('board: kite-tracker, in a workspace no project lists, is on the board, keyed ws:<workspace>', !!kite && kite.unowned && kite.name === 'kite-tracker' && kite.folder === KITE && kite.workspaceTitle === 'kite-tracker');
  check('board: waiting on its trust menu it needs you, a Codex session with the menu\'s options', !!kite && kite.state === 'you' && kite.sessions.length === 1 && kite.sessions[0].assistant === 'codex' && kite.sessions[0].dialog && (kite.quick || []).map((q) => q.label).join('|') === 'Trust and continue|Quit', JSON.stringify(kite && { state: kite.state, quick: kite.quick }));
  check('board: scratch, an idle Claude Code session, is not in a project and quiet', !!scr && scr.unowned && scr.state === 'idle' && scr.sessions[0].assistant === 'claude', scr && scr.state);
  check('board: a hidden project\'s workspace and an ignored one show nowhere', !s.projects.some((p) => p.sessions.some((x) => x.surfaceId === S.hid || x.surfaceId === S.ign)));
  check('board: an unowned card has no brief, plan files or shared folder', !!kite && !kite.brief && !(kite.plans || []).length && !kite.shared.length);
  const boat = s.projects.find((p) => p.id === 'paper-boat');
  check('board: Paper Boat has its Claude Code and its Codex session', !!boat && boat.sessions.map((x) => x.assistant).sort().join() === 'claude,codex');
  const rows = s.sessions.rows;
  const row = (sid) => rows.find((r) => r.sessionId === sid);
  check('Sessions: Codex sessions are listed, with their memory', !!row(SID.boatX) && row(SID.boatX).assistant === 'codex' && row(SID.boatX).memKb === 317440 && row(SID.boatX).label === 'Paper Boat' && !row(SID.boatX).unowned, JSON.stringify(rows.map((r) => [r.label, r.assistant, r.group, r.method])));
  check('Sessions: kite-tracker and scratch are Not in a project, by folder name', !!row(SID.kite) && row(SID.kite).unowned && row(SID.kite).label === 'kite-tracker' && !!row(SID.scr) && row(SID.scr).unowned && row(SID.scr).label === 'scratch');
  check('Sessions: Close idle never ticks a Codex session', !row(SID.boatX).closable && /Claude Code sessions only/.test(row(SID.boatX).blocked || ''));
  check('Sessions: the total counts both assistants', s.sessions.count === 4 && s.sessions.totalKb === 844800 + 317440 + 122880 + 92160);
  check('board: the Codex session on the Paper Boat sheet carries its memory', boat.sessions.find((x) => x.assistant === 'codex').memKb === 317440);

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#' + encodeURIComponent('ws:ws-kite'));
  await page.waitForSelector('.un-card');
  await page.waitForFunction(() => document.querySelectorAll('#lv-lines .e').length > 0, null, { timeout: 8000 }).catch(() => {});
  const L = await page.evaluate(() => {
    const grp = (h) => [...document.querySelectorAll('#list section.grp')].find((g) => g.querySelector('.grp-h span').textContent === h);
    const you = grp('Needs you');
    const un = grp('Not in a project');
    const kr = you && you.querySelector('.row[data-id="ws:ws-kite"]');
    return {
      kiteInYou: !!kr, kiteGlyph: !!(kr && kr.querySelector('.un-ic svg')), kiteTag: kr && kr.querySelector('.as-tag') ? kr.querySelector('.as-tag').textContent : null,
      scrInUn: !!(un && un.querySelector('.row[data-id="ws:ws-scratch"]')), scrTag: un && un.querySelector('.row[data-id="ws:ws-scratch"] .as-tag') ? un.querySelector('.row[data-id="ws:ws-scratch"] .as-tag').textContent : null,
      unLast: !!un && un === [...document.querySelectorAll('#list section.grp')].pop(),
      projectTags: [...document.querySelectorAll('#list .row:not(.un-row) .as-tag')].length,
      strip: document.querySelector('#d-strip > span').textContent,
      meta: document.querySelector('#d-meta').textContent,
      card: document.querySelector('.un-card') ? document.querySelector('.un-card').textContent : '',
      note: document.querySelector('#note').hidden, ns: document.querySelector('#ns').hidden,
      noPlan: !document.querySelector('#d-plan').innerHTML && document.querySelector('#d-notes').hidden && document.querySelector('#d-timeline').hidden,
      buttons: [...document.querySelectorAll('#d-ask-top .q-opts .btn')].map((b) => b.textContent),
      lvTag: document.querySelector('#lv-tag') && !document.querySelector('#lv-tag').hidden ? document.querySelector('#lv-tag').textContent : null,
      lvTip: document.querySelector('.lv-h .fresh') ? document.querySelector('.lv-h .fresh').title : '',
      lvTrust: (document.querySelector('#lv-lines').textContent.match(/Trust this folder\?/g) || []).length,
      mem: document.querySelector('#memchip').textContent,
    };
  });
  check('page: kite-tracker in Needs you, with the folder glyph and the Codex tag', L.kiteInYou && L.kiteGlyph && L.kiteTag === 'Codex', JSON.stringify(L).slice(0, 300));
  check('page: scratch in a Not in a project group under Idle, tagged Claude', L.scrInUn && L.unLast && L.scrTag === 'Claude');
  check('page: project rows stay unmarked', L.projectTags === 0, String(L.projectTags));
  check('page: the sheet says Not in a project, its folder and cmux workspace', /^Not in a project/.test(L.strip) && L.meta.includes('kite-tracker') && L.meta.includes('cmux workspace kite-tracker'), L.meta);
  check('page: the Not in a project card with Add to a project and New project from this folder', /No project lists this cmux workspace/.test(L.card) && /Add to a project/.test(L.card) && /New project from this folder/.test(L.card));
  check('page: the message box has no Add as note and no New session switch; no plan, notes or hand-backs', L.note && L.ns && L.noPlan);
  check('page: the trust menu\'s options are the answer card\'s buttons', L.buttons.join('|') === 'Trust and continue|Quit', L.buttons.join('|'));
  check('page: the Live screen header carries the Codex tag, and its tooltip names Codex', L.lvTag === 'Codex' && /reads Codex's screen/.test(L.lvTip), `${L.lvTag} / ${L.lvTip}`);
  check('page: the Live screen shows the menu\'s text once', L.lvTrust === 1, String(L.lvTrust));
  check('page: the top bar reads Sessions, not Claude', /^Sessions/.test(L.mem.trim()), L.mem);

  const shoot = async (name, fn) => {
    if (!SHOTS) return;
    for (const theme of ['dark', 'light']) {
      for (const [w, h] of [[1440, 900], [390, 844]]) {
        const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
        const pg = await c.newPage();
        await pg.addInitScript((t) => { try { localStorage.setItem('mc.theme', JSON.stringify(t)); } catch { /* none */ } }, theme);
        await fn(pg, w < 700);
        await sleep(600);
        await pg.screenshot({ path: path.join(SHOTS, `${name}-${w}-${theme}.png`), fullPage: false });
        await c.close();
      }
    }
  };
  const openKite = async (pg, phone) => {
    await pg.goto(base + '/#' + encodeURIComponent('ws:ws-kite'));
    await pg.waitForSelector('.un-card');
    await pg.waitForFunction(() => document.querySelectorAll('#lv-lines .e').length > 0, null, { timeout: 8000 }).catch(() => {});
    if (phone) await pg.evaluate(() => window.scrollTo(0, 0));
  };
  await shoot('s1-kite', openKite);
  await shoot('s1-kite-card', async (pg, phone) => { await openKite(pg, phone); if (phone) await pg.evaluate(() => { const e = document.querySelector('.un-card'); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 200); }); });
  await shoot('s1-add-menu', async (pg, phone) => { await openKite(pg, phone); await pg.click('[data-un="pick"]'); if (phone) await pg.evaluate(() => { const e = document.querySelector('.un-card'); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 120); }); });
  await shoot('s1-new-project', async (pg) => { await pg.goto(base + '/#' + encodeURIComponent('ws:ws-scratch')); await pg.waitForSelector('.un-card'); await pg.click('[data-un="new"]'); await pg.waitForSelector('#modal-form'); });
  await shoot('s2-boat', async (pg, phone) => {
    await pg.goto(base + '/#paper-boat'); await pg.waitForSelector('#d-sessions .sess');
    await pg.waitForFunction(() => document.querySelectorAll('#lv-lines .e').length > 0, null, { timeout: 8000 }).catch(() => {});
    if (phone) await pg.evaluate(() => { const e = document.querySelector('#d-sessions'); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 300); });
  });
  await shoot('s2-sessions', async (pg, phone) => { await pg.goto(base + '/#/sessions'); await pg.waitForSelector('#s-right .card'); if (phone) await pg.evaluate(() => { const e = document.querySelector('#s-right'); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 20); }); });
  await shoot('s4-rules', async (pg) => { await pg.goto(base + '/#/rules'); await pg.waitForSelector('.rl-cols'); });

  // ---- tags on the Paper Boat sheet and the Sessions page
  await page.goto(base + '/#paper-boat');
  await page.waitForSelector('#d-sessions .sess');
  const B = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#d-sessions .sess')].map((r) => [r.querySelector('.ss-n').textContent, r.querySelector('.as-tag') ? r.querySelector('.as-tag').textContent : null]),
    lvTag: document.querySelector('#lv-tag').textContent,
  }));
  check('page: every Sessions card row carries its tag: Claude or Codex, never "Claude Code"', B.rows.length === 2 && B.rows.map((r) => r[1]).sort().join() === 'Claude,Codex', JSON.stringify(B.rows));
  await page.click('#d-sessions .sess:has(.as-tag:text-is("Codex"))');
  await page.waitForFunction(() => document.querySelector('#lv-tag').textContent === 'Codex', null, { timeout: 4000 }).catch(() => {});
  const lt2 = await page.evaluate(() => [document.querySelector('#lv-tag').textContent, document.querySelector('.lv-h .fresh').title]);
  check('page: the Live screen header follows the session chosen', B.lvTag !== lt2[0] && lt2[0] === 'Codex' && /Codex's/.test(lt2[1]), JSON.stringify([B.lvTag, ...lt2]));
  await page.click('#d-sessions .sess:has(.as-tag:text-is("Claude"))');
  await page.waitForFunction(() => document.querySelector('#lv-tag').textContent === 'Claude', null, { timeout: 4000 }).catch(() => {});
  const lt3 = await page.evaluate(() => document.querySelector('.lv-h .fresh').title);
  check('page: a Claude Code session\'s tooltip still reads "Claude\'s screen"', lt3 === "The board reads Claude's screen every 2 s", lt3);
  await page.goto(base + '/#/sessions');
  await page.waitForSelector('#s-right .card');
  const P = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#s-right .card')].map((c) => ({ h: c.querySelector('.card-h span').textContent, rows: [...c.querySelectorAll('.card-r')].map((r) => [r.querySelector('b') ? r.querySelector('b').textContent : '', r.querySelector('.as-tag') ? r.querySelector('.as-tag').textContent : null]) }));
    return { cards, head: document.querySelector('#s-head').textContent };
  });
  const card = (h) => P.cards.find((c) => c.h === h);
  check('Sessions page: In use lists the Codex session with its tag', !!card('In use') && card('In use').rows.some((r) => r[0] === 'Paper Boat' && r[1] === 'Codex') && card('In use').rows.some((r) => r[0] === 'Paper Boat' && r[1] === 'Claude'), JSON.stringify(P.cards));
  check('Sessions page: a Not in a project card holds kite-tracker and scratch, tagged', !!card('Not in a project') && card('Not in a project').rows.map((r) => r.join(':')).sort().join() === 'kite-tracker:Codex,scratch:Claude');
  check('Sessions page: the head counts sessions, not Claude sessions', /4 sessions hold/.test(P.head), P.head);

  // ---- Rules: two columns per scope
  await page.goto(base + '/#/rules');
  await page.waitForSelector('.rl-cols');
  const R = await page.evaluate(() => [...document.querySelectorAll('.rl-scope')].map((h) => {
    const cols = h.nextElementSibling;
    return { name: h.childNodes[0].textContent, cols: [...cols.querySelectorAll('.rl-col')].map((c) => ({ file: c.querySelector('.rl-file .mono').textContent, tag: c.querySelector('.rl-file .as-tag').textContent, none: c.querySelector('.rl-none') ? c.querySelector('.rl-none').textContent : null, cards: c.querySelectorAll('.yr-card').length })), x: [...cols.querySelectorAll('.rl-col')].map((c) => Math.round(c.getBoundingClientRect().left)) };
  }));
  check('Rules: every project, then each project, each as two columns CLAUDE.md (Claude) and AGENTS.md (Codex)', R.map((r) => r.name).join('|') === 'Every project|Paper Boat|Recipe Box' && R.every((r) => r.cols.length === 2 && r.cols[0].tag === 'Claude' && r.cols[1].tag === 'Codex' && /CLAUDE\.md$/.test(r.cols[0].file) && /AGENTS\.md$/.test(r.cols[1].file)), JSON.stringify(R).slice(0, 400));
  check('Rules: side by side on a desktop', R.every((r) => r.x[1] > r.x[0] + 200));
  check('Rules: a missing AGENTS.md says so', R[2] && R[2].cols[1].none === 'No AGENTS.md in this project.' && R[2].cols[1].cards === 0 && R[2].cols[0].cards === 1);
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pp = await ph.newPage();
  await pp.goto(base + '/#/rules');
  await pp.waitForSelector('.rl-cols');
  const st = await pp.evaluate(() => { const c = [...document.querySelector('.rl-cols').querySelectorAll('.rl-col')].map((x) => x.getBoundingClientRect()); return { stacked: c[1].top > c[0].bottom - 1 && Math.abs(c[1].left - c[0].left) < 2, wide: document.documentElement.scrollWidth <= 390 }; });
  check('Rules: the columns stack on the phone, no sideways scroll', st.stacked && st.wide, JSON.stringify(st));
  // The phone's chips: the dashed kite-tracker chip among Needs you.
  await pp.goto(base + '/#' + encodeURIComponent('ws:ws-kite'));
  await pp.waitForSelector('#pchips .pchip');
  const C = await pp.evaluate(() => ({ chips: [...document.querySelectorAll('#pchips .pchip')].map((c) => [c.className, c.textContent.trim(), !!c.querySelector('.un-ic')]), outline: getComputedStyle(document.querySelector('#pchips .pchip.un') || document.body).outlineStyle }));
  check('phone: kite-tracker is a chip with the folder glyph, first, among Needs you', C.chips[0] && /\bun\b/.test(C.chips[0][0]) && C.chips[0][1] === 'kite-tracker' && C.chips[0][2], JSON.stringify(C.chips));
  // Idle: Paper Boat (both its sessions at rest), Recipe Box, and scratch.
  check('phone: scratch is behind the idle chip, which counts it', C.chips.some((c) => /idle/.test(c[0]) && /^3\s*idle/.test(c[1])));
  await pp.click('#pchips [data-idle-open]');
  await pp.waitForSelector('#idle-sheet .row');
  const IS = await pp.evaluate(() => [...document.querySelectorAll('#idle-sheet .row')].map((r) => [r.dataset.id, !!r.querySelector('.un-ic'), r.querySelector('.as-tag') ? r.querySelector('.as-tag').textContent : null]));
  check('phone: in the idle sheet scratch is a folder row with its tag; projects stay unmarked', IS.some((r) => r[0] === 'ws:ws-scratch' && r[1] && r[2] === 'Claude') && IS.filter((r) => r[0] !== 'ws:ws-scratch').every((r) => !r[1] && !r[2]), JSON.stringify(IS));
  check('phone: a folder chip is dashed until chosen', C.outline === 'none' || C.outline === 'dashed');
  await ph.close();

  // ---- answer the trust menu from the board, then Add to a project
  await page.goto(base + '/#' + encodeURIComponent('ws:ws-kite'));
  await page.waitForSelector('#d-ask-top .q-opts .btn');
  await page.click('#d-ask-top .q-opts .btn:text-is("Trust and continue")');
  const keys = await until(() => { const k = (fst().keys || {})[S.kite]; return k && k.includes('enter') ? k : null; });
  check('answer: Trust and continue is chosen on the board, with Enter, in kite-tracker\'s tab only', !!keys && keys.join() === 'enter' && Object.keys(fst().keys || {}).join() === S.kite, JSON.stringify(fst().keys));
  s = await until(async () => { const x = await state(); const k = x.projects.find((p) => p.id === 'ws:ws-kite'); return k && k.state !== 'you' ? x : null; });
  check('answer: with the menu gone, kite-tracker leaves Needs you for Not in a project', !!s && s.projects.find((p) => p.id === 'ws:ws-kite').state === 'idle');
  await page.waitForSelector('#list section.un-grp .row[data-id="ws:ws-kite"]', { timeout: 6000 }).catch(() => {});
  check('page: and its row moved to the Not in a project group', await page.evaluate(() => !!document.querySelector('#list section.un-grp .row[data-id="ws:ws-kite"]')));

  const bad = await post('/api/project/add-workspace', { from: 'ws:ws-kite', projectId: 'no-such' });
  check('add: an unknown project is refused, the registry untouched', bad.status === 404 && !regNow().projects.some((p) => (p.workspaces || []).includes('ws-kite')));
  const foreign = await fetch(base + '/api/project/add-workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ from: 'ws:ws-kite', projectId: 'paper-boat' }) });
  check('add: a write from another site is refused', foreign.status === 403 && !regNow().projects.some((p) => (p.workspaces || []).includes('ws-kite')));
  await page.click('[data-un="pick"]');
  await page.waitForSelector('.un-pop [data-un-add="paper-boat"]');
  const menu = await page.evaluate(() => [...document.querySelectorAll('.un-pop [data-un-add]')].map((b) => b.textContent));
  check('add: the menu lists the projects, never a folder session', menu.join('|') === 'Paper Boat|Recipe Box', menu.join('|'));
  await page.click('.un-pop [data-un-add="paper-boat"]');
  const moved = await until(() => regNow().projects.find((p) => p.id === 'paper-boat').workspaces.includes('ws-kite'));
  check('add: Add to a project writes the workspace into the project\'s workspaces', !!moved && regNow().projects.find((p) => p.id === 'paper-boat').workspaces.join() === 'ws-boat,ws-kite');
  s = await until(async () => { const x = await state(); return !x.projects.some((p) => p.id === 'ws:ws-kite') && x.projects.find((p) => p.id === 'paper-boat').sessions.some((y) => y.surfaceId === S.kite) ? x : null; });
  check('add: the session moved into Paper Boat; no kite-tracker card is left', !!s);
  check('add: the page follows it to Paper Boat', await until(() => page.evaluate(() => location.hash === '#paper-boat' && document.querySelector('#d-head h1').textContent === 'Paper Boat')));
  check('add: a backup of the registry was made first', fs.readdirSync(MC).some((f) => /^projects\.json\.bak-/.test(f)));

  // ---- New project from this folder (scratch)
  await page.goto(base + '/#' + encodeURIComponent('ws:ws-scratch'));
  await page.waitForSelector('[data-un="new"]');
  await page.click('[data-un="new"]');
  await page.waitForSelector('#modal-form');
  const M = await page.evaluate(() => ({ name: document.querySelector('#modal-form [name="name"]').value, mode: document.querySelector('[data-fmode].on').dataset.fmode, path: document.querySelector('#m-folder .fpath').textContent, hint: document.querySelector('#m-folder .fhint').textContent, go: document.querySelector('#m-go').textContent }));
  check('new: the form has the name and the folder filled in, on Existing', M.name === 'Scratch' && M.mode === 'existing' && /scratch$/.test(M.path) && /The workspace and its session join the project/.test(M.hint), JSON.stringify(M));
  await page.fill('#modal-form [name="goal"]', 'Parse the CSV exports.');
  await page.click('#m-go');
  const made = await until(() => regNow().projects.find((p) => p.name === 'Scratch'));
  check('new: the project lists the scratch workspace, in its folder, with the session\'s assistant', !!made && made.workspaces.join() === 'ws-scratch' && fs.realpathSync(made.folder) === fs.realpathSync(SCR) && made.assistant === 'claude', JSON.stringify(made));
  check('new: nothing was opened in cmux, and the brief was written', !fs.existsSync(FAKE + '.new-workspace.log') && fs.existsSync(path.join(SCR, 'BRIEF.md')));
  s = await until(async () => { const x = await state(); return !x.projects.some((p) => p.unowned) ? x : null; });
  check('new: no session is left Not in a project', !!s && s.projects.find((p) => p.id === made.id).sessions.some((y) => y.surfaceId === S.scr));
  check('page: no script errors', !errors.length, errors.join(' | '));
} catch (e) {
  fails++;
  console.log('FAIL  ' + (e.stack || e));
  console.log(log.slice(-3000));
} finally {
  if (browser) await browser.close();
  board.kill();
}
// ------------------------------------------------------------ 3. --real

// A throwaway cmux workspace mc-test-stage2-* (never focused) running a real
// `claude` in a new folder under the scratch folder: its folder-trust
// question shows on a test board on :4697 (real cmux; every workspace open
// before this one is in its ignoreWorkspaces, so only this one is not in a
// project) as a folder in Needs you; the page answers it, then adds the
// workspace to a scratch project, and the session moves there; then the
// workspace is closed. Only that workspace is typed into.
const ri = process.argv.indexOf('--real');
if (ri >= 0) {
  const { execFileSync } = await import('node:child_process');
  const CMUX = process.env.CMUX_BIN_REAL || '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const cm = (args, json) => {
    const out = execFileSync(CMUX, json ? ['--json', '--id-format', 'both', ...args] : args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } });
    return json ? JSON.parse(out) : out;
  };
  const tree = () => cm(['tree', '--all'], true).windows.flatMap((w) => w.workspaces);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const name = 'mc-test-stage2-' + stamp;
  const dir = path.join(path.resolve(process.argv[ri + 1] || '.'), name);
  fs.mkdirSync(dir, { recursive: true });
  const RT = path.join(T, 'real');
  const LIVE = path.join(RT, 'live-test');
  fs.mkdirSync(LIVE, { recursive: true });
  const RMC = path.join(RT, 'mc');
  fs.mkdirSync(RMC, { recursive: true });
  const RREG = path.join(RMC, 'projects.json');
  const before = tree().map((w) => w.id);
  fs.writeFileSync(RREG, JSON.stringify({ version: 1, ignoreWorkspaces: before, settings: { autoImport: false, ruleSources: [], globalClaudeMd: GLOBAL_MD, projectsRoot: RT, repeatsAuto: false, launchCommand: 'claude' }, projects: [{ id: 'live-test', name: 'Live Test', folder: LIVE, workspaces: [], brief: null }] }, null, 2));
  fs.writeFileSync(path.join(RT, 'ps.json'), '[]');
  let ws = null;
  let rb = null;
  let rlog = '';
  let rbrowser = null;
  const rbase = 'http://localhost:4697';
  const rstate = async () => (await fetch(rbase + '/api/state')).json();
  try {
    cm(['new-workspace', '--name', name, '--focus', 'false', '--cwd', dir, '--command', 'claude']);
    for (let k = 0; k < 40 && !ws; k++) { await sleep(250); ws = tree().find((w) => w.title === name) || null; }
    if (!ws) throw new Error('the scratch workspace did not appear');
    const sf = ws.panes.flatMap((p) => p.surfaces)[0];
    const renv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RAVENRY_|MC_|PORT$)/.test(k)));
    Object.assign(renv, { RAVENRY_HOME: RMC, PORT: '4697', MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_GLOBAL_CLAUDE_MD: GLOBAL_MD, MC_CODEX_HOME: CODEX_HOME, MC_CODEX: '0', MC_PS_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools', 'stub-ps.mjs'), STUB_PS_STATE: path.join(RT, 'ps.json') });
    rb = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: renv, stdio: ['ignore', 'pipe', 'pipe'] });
    rb.stdout.on('data', (d) => { rlog += d; });
    rb.stderr.on('data', (d) => { rlog += d; });
    const key = 'ws:' + ws.id;
    const st1 = await until(async () => { const x = await rstate(); const p = x.projects.find((y) => y.id === key); return p && p.state === 'you' && p.sessions.some((y) => y.dialog) ? x : null; }, 40000);
    const p1 = st1 && st1.projects.find((y) => y.id === key);
    check('real: the trust question in a workspace no project lists is in Needs you, by its folder name', !!p1 && p1.unowned && p1.name === name && (p1.quick || []).some((q) => /Yes, I trust this folder/.test(q.label)), JSON.stringify(p1 && { name: p1.name, state: p1.state, quick: p1.quick }));
    check('real: only that workspace is Not in a project', !!st1 && st1.projects.filter((y) => y.unowned).map((y) => y.id).join() === key, st1 ? st1.projects.filter((y) => y.unowned).map((y) => y.name).join() : '');
    rbrowser = await chromium.launch();
    const pg = await (await rbrowser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await pg.goto(rbase + '/#' + encodeURIComponent(key));
    await pg.waitForSelector('#list .row.un-row[data-id="' + key + '"]');
    check('real: the page shows it in Needs you with the folder glyph and the Claude tag', await pg.evaluate((k) => { const r = document.querySelector('#list .row[data-id="' + k + '"]'); return !!r && r.closest('section').querySelector('.grp-h span').textContent === 'Needs you' && !!r.querySelector('.un-ic') && r.querySelector('.as-tag').textContent === 'Claude'; }, key));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'real-1-trust.png') });
    await pg.click('#d-ask-top .q-opts .btn:has-text("Yes, I trust this folder")');
    const st2 = await until(async () => { const x = await rstate(); const p = x.projects.find((y) => y.id === key); return p && p.state !== 'you' && p.sessions.some((y) => y.live && !y.dialog) ? x : null; }, 30000);
    check('real: answered from the board, the question is gone and it moved to Not in a project', !!st2 && st2.projects.find((y) => y.id === key).state === 'idle', (rlog.match(/choose:.*$/m) || [''])[0]);
    await pg.waitForSelector('#list section.un-grp .row[data-id="' + key + '"]', { timeout: 8000 }).catch(() => {});
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'real-2-answered.png') });
    await pg.click('[data-un="pick"]');
    await pg.click('.un-pop [data-un-add="live-test"]');
    const moved = await until(() => JSON.parse(fs.readFileSync(RREG, 'utf8')).projects.find((p) => p.id === 'live-test').workspaces.includes(ws.id), 8000);
    check('real: Add to a project wrote the workspace into Live Test', !!moved);
    const st3 = await until(async () => { const x = await rstate(); return !x.projects.some((y) => y.id === key) && x.projects.find((y) => y.id === 'live-test').sessions.some((y) => y.surfaceId === sf.id) ? x : null; }, 10000);
    check('real: the session moved into Live Test', !!st3);
    await pg.waitForFunction(() => document.querySelector('#d-head h1') && document.querySelector('#d-head h1').textContent === 'Live Test', null, { timeout: 6000 }).catch(() => {});
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'real-3-moved.png') });
    check('real: the board typed only into that tab', !/choose: .* taken in (?!ws:)/.test(rlog) && (rlog.match(/choose: "Yes, I trust this folder" taken in ws:[^ ]+/g) || []).every((l) => l.includes(ws.id)), (rlog.match(/choose:.*$/m) || [''])[0]);
  } catch (e) {
    fails++;
    console.log('FAIL  real: ' + (e.stack || e));
    console.log(rlog.slice(-2000));
  } finally {
    if (rbrowser) await rbrowser.close();
    if (rb) rb.kill();
    if (ws) { try { cm(['close-workspace', '--workspace', ws.id]); console.log('closed scratch workspace', ws.id); } catch (e) { console.log('could not close', ws.id, e.message); } }
    check('real: the scratch workspace is closed', !!ws && !tree().some((w) => w.id === ws.id));
  }
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
