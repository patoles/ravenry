#!/usr/bin/env node
// The README's screenshots (docs/screenshot.png, docs/screenshot-phone.png),
// drawn from a real board on a made-up demo: five projects with briefs,
// sessions in each state, a menu waiting on an answer, a plan at a gate and
// a few neutral pictures. Nothing in it comes from a real board, so the
// pictures can be public (docs/PUBLISHING.md).
//
//   node tools/readme-shot.mjs [outDir]      (default: docs)
//
// A test board on :4693 with its data in .tmp/readme-demo, whose HOME is a
// demo home there too (so folders read ~/Projects/<name>), tools/fake-cmux.mjs
// as its cmux (it refuses every write), tools/stub-ps.mjs as its ps and lsof
// (made-up processes, never this Mac's), and hook events written as
// hooks/events.mjs writes them. Headless Chromium, dark theme: 1440x900 and
// 390x844. Never touches the board on :4600. The PNGs carry no text chunks.
import './test-guard.mjs'; // first: keeps this off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs'));
const T = path.join(ROOT, '.tmp', 'readme-demo');
fs.rmSync(T, { recursive: true, force: true });
const HOME = path.join(T, 'home');
const PROJECTS = path.join(HOME, 'Projects');
const MC = path.join(HOME, '.ravenry');
const CLAUDE = path.join(HOME, '.claude', 'projects');
const SCRATCH = path.join(T, 'scratch');
for (const d of [OUT, PROJECTS, path.join(MC, 'events'), CLAUDE, SCRATCH]) fs.mkdirSync(d, { recursive: true });
const PORT = 4693;
const BASE = `http://127.0.0.1:${PORT}`;
const MIN = 60000;
const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ pictures
// Neutral placeholders (tools/fixtures/gallery-placeholders.json).
const svgs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/gallery-placeholders.json'), 'utf8'));
const browser = await chromium.launch();
async function draw(name, file, ageMin) {
  const svg = svgs[name];
  const w = Number(svg.match(/width="(\d+)"/)[1]), h = Number(svg.match(/height="(\d+)"/)[1]);
  const pg = await browser.newPage({ viewport: { width: w, height: h } });
  await pg.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await pg.screenshot({ path: file });
  await pg.close();
  const t = new Date(Date.now() - ageMin * MIN);
  fs.utimesSync(file, t, t);
  return file;
}

// ------------------------------------------------------------ screens
const W = 100;
const RULE = '─'.repeat(W);
const banner = (dir) => ` ▐▛███▛█   Claude Code v2.1.317\n▝▜██████▀  Opus 5.5 with high effort\n ▝▝   ▝▝   ~/Projects/${dir}\n\n`;
const prompt = (footer = '  ⏵⏵ auto mode on (shift+tab to cycle)') => `${RULE}\n❯ \n${RULE}\n${footer}\n`;
const SCREENS = {
  garden: banner('garden-planner') +
    '❯ Add reminders to the planting calendar\n\n' +
    '⏺ The calendar now knows each bed\'s sowing window. Two kinds of reminder fit: one\n' +
    '  a week before a sowing window opens, one on the first frost-free day.\n\n' +
    `${RULE}\n ☐ Reminders \n\nWhich reminder should go out first?\n\n` +
    '❯ 1. A week before sowing\n     Gives time to buy seeds\n' +
    '  2. First frost-free day\n     Safe to plant out\n' +
    '  3. Both, on the same screen\n     One card with two dates\n' +
    `  4. Type something.\n${RULE}\n  5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`,
  boat: banner('paper-boat') +
    '❯ Make the boat rock with the waves\n\n' +
    '⏺ Read(src/water.js)\n  ⎿  Read 182 lines\n\n' +
    '⏺ Update(src/boat.js)\n  ⎿  Updated src/boat.js with 14 additions and 3 removals\n\n' +
    '⏺ The hull now follows the wave height under its middle. Next: tilt it with the slope.\n\n' +
    '✻ Tilting the hull… (1m 42s · ↓ 3.1k tokens · esc to interrupt)\n\n' + prompt('  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'),
  notes: banner('notes-app') +
    '❯ Check the settings screen on a phone\n\n' +
    '⏺ Bash(node tools/shoot.mjs --settings)\n  ⎿  wrote shots/settings.png (1600 x 900)\n\n' +
    '⏺ Read(shots/settings.png)\n  ⎿  Read image (88KB)\n\n' +
    '⏺ The settings screen fits at 390 wide: the toggles line up and nothing scrolls\n' +
    '  sideways. The plan is at its gate: ready to ship the beta to testers.\n\n' +
    '✻ Worked for 4m 10s · done 10:41 AM\n\n' + prompt(),
  recipes: banner('recipe-box') +
    '❯ Import recipes from the old export\n\n' +
    '⏺ Imported 214 of 220 recipes. Six use the old format with no units.\n\n' +
    '  Should I keep the old import format working, or drop it?\n\n' +
    '✻ Worked for 2m 55s · done 10:12 AM\n\n' + prompt(),
  weather: banner('weather-widget') +
    '❯ Round the temperatures\n\n⏺ Done: whole degrees everywhere, tests pass.\n\n' +
    '✻ Worked for 48s · done 9:12 AM\n\n' + prompt(),
};

// ------------------------------------------------------------ projects
const P = [
  { id: 'garden-planner', name: 'Garden Planner', key: 'garden', title: '✳ Planting reminders', sid: 'a1a1a1a1-0000-4000-8000-000000000001', ctx: 312000,
    brief: '# Garden Planner\n\nGoal: A planting calendar for a small garden that says what to sow and when, bed by bed.\nDone means: A season planned from the calendar alone.\nKind: Web app\nStage: Build\n\n## Plan\n### Reminders\n- [x] Sowing windows per bed\n- [x] Frost dates by region\n- [?] Pick the first reminder\n- [ ] Send reminders as notifications\n\n## Next step\nPick which reminder goes out first.\n\n## Notes\n- [ ] "The bed names should be editable"\n- [x] "Show the frost date on the calendar"\n',
    events: [['SessionStart', 40], ['UserPromptSubmit', 6], ['Notification', 1, { notification_type: 'elicitation_dialog', message: 'Which reminder should go out first?' }]],
    turns: [['Add reminders to the planting calendar', 'The calendar now knows each bed\'s sowing window.', 5]] },
  { id: 'paper-boat', name: 'Paper Boat', key: 'boat', title: '⠂ Tilting the hull', sid: 'b2b2b2b2-0000-4000-8000-000000000002', ctx: 184000,
    brief: '# Paper Boat\n\nGoal: A calm little game: fold a paper boat and steer it down a rainy street.\nDone means: Ten people play a full run without being told how.\nKind: Web game\nStage: Mockup\n\n## Plan\n### Water\n- [x] Waves on the gutter\n- [>] The boat rocks with the waves\n- [ ] Rain drops that push the boat\n\n## Next step\nMake the boat rock with the waves.\n',
    events: [['SessionStart', 25], ['UserPromptSubmit', 2]],
    turns: [['Make the boat rock with the waves', 'The hull now follows the wave height under its middle.', 0.3]] },
  { id: 'notes-app', name: 'Notes App', key: 'notes', title: '✳ Settings on a phone', sid: 'c3c3c3c3-0000-4000-8000-000000000003', ctx: 547000,
    brief: '# Notes App\n\nGoal: Quick notes that sync between a phone and a laptop, with nothing to set up.\nDone means: The beta testers use it every day for a week.\nKind: Mobile and web app\nStage: Trial\n\n## Plan\n### Beta\n- [x] Sync between two devices\n- [x] Settings screen\n- [x] Fits a phone at 390 wide\n- [?] Gate: ship the beta to testers?\n- [ ] Collect the first week of feedback\n\n## Next step\nShip the beta to the testers.\n\n## Hand-off\n- 2026-11-03 10:40 Settings screen done and checked on a phone; the beta is ready.\nQuick answers: Ship it | Show me first\n\n## Pictures\n- shots/settings.png | The settings screen\n',
    events: [['SessionStart', 90], ['UserPromptSubmit', 8], ['Stop', 3]],
    turns: [['Check the settings screen on a phone', 'The settings screen fits at 390 wide: the toggles line up and nothing scrolls sideways. The plan is at its gate: ready to ship the beta to testers.', 3]],
    pictures: [['home', 'home.png', 30], ['phone', 'phone-screen.png', 24], ['chart', 'sync-times.png', 18], ['landscape', 'onboarding-art.png', 12], ['shapes', 'icons.png', 7], ['settings', 'settings.png', 4]] },
  { id: 'recipe-box', name: 'Recipe Box', key: 'recipes', title: '✳ Old recipe import', sid: 'd4d4d4d4-0000-4000-8000-000000000004', ctx: 96000,
    brief: '# Recipe Box\n\nGoal: Every family recipe in one place, searchable by what is in the fridge.\nDone means: Dinner picked from the fridge search three nights in a row.\nKind: Web app\nStage: Build\n\n## Next step\nDecide what to do with the old import format.\n',
    events: [['SessionStart', 50], ['UserPromptSubmit', 33], ['Stop', 28, { ends_on_question: true, question: 'Should I keep the old import format working, or drop it?' }]],
    turns: [['Import recipes from the old export', 'Imported 214 of 220 recipes. Six use the old format with no units.\n\nShould I keep the old import format working, or drop it?', 28]] },
  { id: 'weather-widget', name: 'Weather Widget', key: 'weather', title: '✳ Rounding', sid: 'e5e5e5e5-0000-4000-8000-000000000005', ctx: 61000,
    brief: '# Weather Widget\n\nGoal: A desktop widget with the next six hours of weather, readable at a glance.\nKind: Mac widget\nStage: Live\n\n## Next step\nNothing planned.\n',
    events: [['SessionStart', 60 * 75], ['UserPromptSubmit', 60 * 74], ['Stop', 60 * 73.5]],
    turns: [['Round the temperatures', 'Done: whole degrees everywhere, tests pass.', 60 * 73.5]] },
];

const workspaces = [], screens = {}, projects = [];
let k = 0;
for (const p of P) {
  k++;
  const dir = path.join(PROJECTS, p.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BRIEF.md'), p.brief);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${p.name}\n`);
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'Start the project');
  const sf = `sf-${k}`;
  workspaces.push({ id: `ws-${k}`, ref: `workspace:${k}`, title: p.name, cwd: dir, surfaces: [{ id: sf, ref: `surface:${k}`, title: p.title }] });
  screens[sf] = SCREENS[p.key];
  projects.push({ id: p.id, name: p.name, folder: dir, brief: 'BRIEF.md', workspaces: [`ws-${k}`] });

  // The transcript, where Claude Code keeps it for this folder.
  const TD = path.join(CLAUDE, slug(dir));
  fs.mkdirSync(TD, { recursive: true });
  const TR = path.join(TD, p.sid + '.jsonl');
  const rec = (type, extra, at) => JSON.stringify({ type, cwd: dir, sessionId: p.sid, timestamp: at, ...extra });
  const lines = [];
  let n = 0;
  for (const [pr, text, m] of p.turns) {
    lines.push(rec('user', { message: { role: 'user', content: pr } }, ago(m + 2)));
    for (const [svg, file, age] of p.pictures || []) {
      const f = await draw(svg, path.join(dir, 'shots', file), age);
      const id = `toolu_${k}_${++n}`;
      lines.push(rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `node tools/shoot.mjs --${svg}` } }] } }, ago(age)));
      lines.push(rec('user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content: `wrote ${f}` }] } }, ago(age)));
      lines.push(rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: id + 'r', name: 'Read', input: { file_path: f } }] } }, ago(age - 0.1)));
    }
    lines.push(rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 8, cache_creation_input_tokens: 3000, cache_read_input_tokens: p.ctx - 3008, output_tokens: 400 } } }, ago(m)));
    if (p.key !== 'boat') lines.push(rec('system', { subtype: 'turn_duration' }, ago(m)));
  }
  fs.writeFileSync(TR, lines.join('\n') + '\n');

  // Hook events, as hooks/events.mjs writes them.
  const ev = p.events.map(([event, m, extra]) => JSON.stringify({ at: ago(m), event, session_id: p.sid, cwd: dir, transcript_path: TR, workspace_id: `ws-${k}`, surface_id: sf, ...(event === 'Stop' ? { ends_on_question: false, background_tasks: 0 } : {}), ...(event === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : {}), ...(extra || {}) }));
  fs.writeFileSync(path.join(MC, 'events', p.sid + '.jsonl'), ev.join('\n') + '\n');
}
// Made-up Claude processes (tools/stub-ps.mjs), one per session, so the
// board's memory line and idle count come from the demo, not this Mac.
const PS = path.join(T, 'stub-ps.json');
fs.writeFileSync(PS, JSON.stringify(P.map((p, i) => ({ pid: 4100 + i * 7, ppid: 4000 + i * 7, rssKb: [612000, 845000, 1290000, 433000, 298000][i], startedAt: ago(p.events[0][1] + 1), command: `claude --resume ${p.sid}`, cwd: path.join(PROJECTS, p.id) }))));
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces, screens }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(HOME, '.claude', 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: PROJECTS },
  projects,
}, null, 2));
fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), '# Working rules\n');

// ------------------------------------------------------------ the board
const env = { ...process.env, HOME, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE, MC_SCRATCH_ROOT: SCRATCH,
  MC_PROJECTS_ROOT: PROJECTS, MC_GLOBAL_CLAUDE_MD: path.join(HOME, '.claude', 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-open.mjs')]), STUB_OPEN_LOG: path.join(T, 'open.jsonl'), CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  MC_PS_BIN: path.join(ROOT, 'tools/stub-ps.mjs'), MC_LSOF_BIN: path.join(ROOT, 'tools/stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_OSASCRIPT_BIN: path.join(ROOT, 'tools/stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(ROOT, 'tools/stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(T, 'osascript.jsonl') };
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
let fails = 0;
try {
  let st = null;
  for (let i = 0; i < 150; i++) {
    try { st = await (await fetch(BASE + '/api/state')).json(); if (st.projects && st.projects.filter((p) => p.sessions && p.sessions.length).length === P.length) break; } catch { /* starting */ }
    await sleep(100);
  }
  await sleep(4000); // the process scan (memory per session) runs on its own, slower tick
  st = await (await fetch(BASE + '/api/state')).json();
  for (const p of (st && st.projects) || []) console.log(`${p.id}: ${p.state}${p.sessions ? ' / ' + p.sessions.map((s) => s.state).join(',') : ''}`);

  const shoot = async (file, { w, h, mobile }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: !!mobile, hasTouch: !!mobile, colorScheme: 'dark' });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${BASE}/?theme=dark#garden-planner`);
    await pg.waitForSelector('#list .row', { state: 'attached', timeout: 15000 });
    await pg.waitForTimeout(1500);
    await pg.screenshot({ path: file });
    await ctx.close();
    if (errs.length) { fails++; console.log('page errors: ' + errs.join(' | ')); }
    console.log('wrote ' + path.relative(ROOT, file));
  };
  await shoot(path.join(OUT, 'screenshot.png'), { w: 1440, h: 900 });
  await shoot(path.join(OUT, 'screenshot-phone.png'), { w: 390, h: 844, mobile: true });
} finally {
  child.kill();
  await browser.close();
}
if (fails) { console.log(log.slice(-2000)); process.exit(1); }
