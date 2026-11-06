// A throwaway board (the hub in ../../hub, run as it is) on a made-up demo,
// for the desktop app's screenshots and checks. Nothing in it comes from a
// real board: five neutral projects, sessions in each state, a question
// waiting, a brief and one picture.
//
// Its HOME, data folder and hook events are all under the folder given; its
// cmux is the hub's tools/fake-cmux.mjs (it refuses every write) and its ps
// and lsof are stubs, so it never reads or touches this machine's sessions.
//
//   const hub = await startDemoHub({ dir, port, empty });
//   hub.url; await hub.arrive('paper-boat'); hub.stop();
//
// With `panes` (project ids), those projects get no cmux session: their
// session is started by the caller in a real ravenryd pane, which reports
// through `ravenryd hook` (hub.sessions[id] has its session id, folder and
// transcript). `runtime` is the ravenryd runtime folder the board follows
// (a test board follows none without it), `env` adds to the board's
// environment, `settings` to its registry's (machines), and `alerts` turns
// phone alerts on, sent to a closed local port. `extra` adds projects with
// no session (each { id, name }: a folder under Projects), and
// `prepare({ HOME, ROOT, MC })` writes more of the demo (pages, briefs)
// before the board starts.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, '..', '..', '..', 'hub');
const MIN = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');

// A small PNG (a chart: a sky, a sun and six bars), so the panel has a picture.
function png(file) {
  const W = 320, H = 200;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const bars = [0.4, 0.65, 0.9, 0.7, 0.5, 0.35];
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let c = [238, 243, 248];
      if (y < 26) c = [255, 255, 255];
      const dx = x - 262, dy = y - 62;
      if (dx * dx + dy * dy < 24 * 24) c = [255, 194, 75];
      const bi = Math.floor((x - 26) / 46);
      if (x >= 26 && bi < 6 && (x - 26) % 46 < 30 && y > H - 20 - bars[bi] * 70 && y < H - 20) c = [125, 181, 240];
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const W = 100;
const RULE = '─'.repeat(W);
const banner = (dir) => ` ▐▛███▜▌   Claude Code\n▝▜█████▛▘  Opus with high effort\n  ▘▘ ▝▝    ~/Projects/${dir}\n\n`;
const prompt = (footer = '  ? for shortcuts') => `${RULE}\n❯ \n${RULE}\n${footer}\n`;

const PROJECTS = [
  { id: 'garden-planner', name: 'garden-planner', title: '✳ Planting reminders', sid: 'a1a1a1a1-0000-4000-8000-000000000001', ctx: 312000,
    brief: '# Garden Planner\n\nGoal: A planting calendar that says what to sow and when, bed by bed.\nKind: Web app\nStage: Build\n\n## Next step\nPick which reminder goes out first.\n\n## Hand-off\n- 2026-11-05 18:20 Sowing windows and frost dates are in. Next: the reminders.\n\n## Pictures\n- shots/calendar.png | The calendar, new layout\n',
    screen: banner('garden-planner') + '❯ Add reminders to the planting calendar\n\n⏺ The calendar knows each bed\'s sowing window. Two kinds of reminder fit.\n\n  Should the first reminder go out a week before sowing, or on the first frost-free day?\n\n' + prompt(),
    events: [['SessionStart', 40], ['UserPromptSubmit', 6], ['Stop', 2, { ends_on_question: true, question: 'A week before sowing, or on the first frost-free day?' }]],
    turn: ['Add reminders to the planting calendar', 'The calendar knows each bed\'s sowing window. Two kinds of reminder fit.\n\nA week before sowing, or on the first frost-free day?', 2],
    picture: 'calendar.png' },
  { id: 'recipe-box', name: 'recipe-box', title: '✳ Old recipe import', sid: 'd4d4d4d4-0000-4000-8000-000000000004', ctx: 96000,
    brief: '# Recipe Box\n\nGoal: Every family recipe in one place, searchable by what is in the fridge.\n\n## Next step\nDecide what to do with the old import format.\n',
    screen: banner('recipe-box') + '❯ Import recipes from the old export\n\n⏺ Imported 214 of 220 recipes. Six use the old format with no units.\n\n  Keep the old import format working?\n\n' + prompt(),
    events: [['SessionStart', 50], ['UserPromptSubmit', 33], ['Stop', 9, { ends_on_question: true, question: 'Keep the old import format working?' }]],
    turn: ['Import recipes from the old export', 'Imported 214 of 220 recipes. Six use the old format with no units.\n\nKeep the old import format working?', 9], machine: 'devbox' },
  { id: 'paper-boat', name: 'paper-boat', title: '⠂ Tilting the hull', sid: 'b2b2b2b2-0000-4000-8000-000000000002', ctx: 584000,
    brief: '# Paper Boat\n\nGoal: A calm little game: fold a paper boat and steer it down a rainy street.\n\n## Next step\nMake the boat rock with the waves.\n',
    screen: banner('paper-boat') + '❯ Make the boat rock with the waves\n\n⏺ Update(src/boat.js)\n  ⎿  Updated src/boat.js with 14 additions and 3 removals\n\n✻ Tilting the hull… (1m 42s · esc to interrupt)\n\n' + prompt('  esc to interrupt'),
    events: [['SessionStart', 25], ['UserPromptSubmit', 2]],
    turn: ['Make the boat rock with the waves', 'The hull now follows the wave height under its middle.', 0.3], working: true },
  { id: 'notes-app', name: 'notes-app', title: '✳ Sync settings', sid: 'c3c3c3c3-0000-4000-8000-000000000003', ctx: 120000,
    brief: '# Notes App\n\nGoal: Quick notes that sync between a phone and a laptop.\n',
    screen: banner('notes-app') + '❯ Sync the settings too\n\n⏺ Bash(npm test)\n  ⎿  Running…\n\n✻ Running the tests… (32s · esc to interrupt)\n\n' + prompt('  esc to interrupt'),
    events: [['SessionStart', 15], ['UserPromptSubmit', 1]],
    turn: ['Sync the settings too', 'Settings now sync with the notes.', 0.2], working: true },
  { id: 'weather-widget', name: 'weather-widget', title: '✳ Rounding', sid: 'e5e5e5e5-0000-4000-8000-000000000005', ctx: 61000,
    brief: '# Weather Widget\n\nGoal: The next six hours of weather, readable at a glance.\n',
    screen: banner('weather-widget') + '❯ Round the temperatures\n\n⏺ Done: whole degrees everywhere, tests pass.\n\n' + prompt(),
    events: [['SessionStart', 60 * 75], ['UserPromptSubmit', 60 * 74], ['Stop', 60 * 73.5]],
    turn: ['Round the temperatures', 'Done: whole degrees everywhere, tests pass.', 60 * 73.5], machine: 'gpu-box' },
];

export async function startDemoHub({ dir, port, empty = false, panes = [], runtime = null, env: moreEnv = {}, settings: moreSettings = {}, alerts = false, extra = [], prepare = null }) {
  fs.rmSync(dir, { recursive: true, force: true });
  const HOME = path.join(dir, 'home');
  const ROOT = path.join(HOME, 'Projects');
  const MC = path.join(HOME, '.ravenry');
  const CLAUDE = path.join(HOME, '.claude', 'projects');
  for (const d of [ROOT, path.join(MC, 'events'), CLAUDE, path.join(dir, 'scratch')]) fs.mkdirSync(d, { recursive: true });
  const FAKE = path.join(dir, 'fake-cmux.json');
  const PS = path.join(dir, 'stub-ps.json');
  const workspaces = [], screens = {}, projects = [], ps = [];
  const files = {};
  const sessions = {};
  let k = 0;
  for (const p of empty ? [] : PROJECTS) {
    k++;
    const folder = path.join(ROOT, p.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'BRIEF.md'), p.brief);
    fs.writeFileSync(path.join(folder, 'README.md'), `# ${p.name}\n`);
    const git = (...a) => execFileSync('git', ['-C', folder, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'Start');
    const sf = `sf-${k}`;
    const inPane = panes.includes(p.id);
    if (!inPane) workspaces.push({ id: `ws-${k}`, ref: `workspace:${k}`, title: p.name, cwd: folder, surfaces: [{ id: sf, ref: `surface:${k}`, title: p.title }] });
    if (!inPane) screens[sf] = p.screen;
    projects.push({ id: p.id, name: p.name, folder, brief: 'BRIEF.md', workspaces: inPane ? [] : [`ws-${k}`] });
    const TD = path.join(CLAUDE, slug(folder));
    fs.mkdirSync(TD, { recursive: true });
    const TR = path.join(TD, p.sid + '.jsonl');
    const rec = (type, extra, at) => JSON.stringify({ type, cwd: folder, sessionId: p.sid, timestamp: at, ...extra });
    const [q, a, m] = p.turn;
    const lines = [rec('user', { message: { role: 'user', content: q } }, ago(m + 2))];
    if (p.picture) {
      const f = path.join(folder, 'shots', p.picture);
      png(f);
      const t = new Date(Date.now() - (m + 1) * MIN); fs.utimesSync(f, t, t);
      lines.push(rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_pic', name: 'Read', input: { file_path: f } }] } }, ago(m + 1)));
    }
    lines.push(rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: a }], usage: { input_tokens: 8, cache_creation_input_tokens: 3000, cache_read_input_tokens: p.ctx - 3008, output_tokens: 400 } } }, ago(m)));
    if (!p.working) lines.push(rec('system', { subtype: 'turn_duration' }, ago(m)));
    fs.writeFileSync(TR, lines.join('\n') + '\n');
    if (inPane) { sessions[p.id] = { sid: p.sid, folder, transcript: TR, topic: p.title.replace(/^\S+\s/, '') }; continue; }
    const evFile = path.join(MC, 'events', p.sid + '.jsonl');
    // A remote session's records say its machine, as the board's ravenryd
    // adapter tags them.
    const evLine = ([event, mm, extra]) => JSON.stringify({ at: ago(mm), event, session_id: p.sid, cwd: folder, transcript_path: TR, workspace_id: `ws-${k}`, surface_id: sf, ...(p.machine ? { machine: p.machine } : {}), ...(event === 'Stop' ? { ends_on_question: false, background_tasks: 0 } : {}), ...(event === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : {}), ...(extra || {}) });
    fs.writeFileSync(evFile, p.events.map(evLine).join('\n') + '\n');
    files[p.id] = { evFile, evLine, TR, rec, sf, p };
    ps.push({ pid: 4100 + k * 7, ppid: 4000 + k * 7, rssKb: [612000, 445000, 845000, 690000, 298000][k - 1], startedAt: ago(p.events[0][1] + 1), command: `claude --resume ${p.sid}`, cwd: folder });
  }
  for (const x of extra) {
    const folder = path.join(ROOT, x.id);
    fs.mkdirSync(folder, { recursive: true });
    projects.push({ id: x.id, name: x.name || x.id, folder, brief: 'BRIEF.md', workspaces: [] });
  }
  fs.writeFileSync(PS, JSON.stringify(ps));
  fs.writeFileSync(FAKE, JSON.stringify({ workspaces, screens }));
  fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
    version: 1,
    settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(HOME, '.claude', 'CLAUDE.md'), backupDir: path.join(dir, 'backups'), projectsRoot: ROOT, contextWindow: 1000000, ...moreSettings },
    projects,
  }, null, 2));
  fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), '# Working rules\n');
  if (alerts) fs.writeFileSync(path.join(MC, 'alerts.json'), JSON.stringify({ enabled: true, channel: 'ntfy', ntfy: { server: 'http://127.0.0.1:9', topic: 'demo-board-alerts' } }), { mode: 0o600 });

  if (prepare) await prepare({ HOME, ROOT, MC });
  const T = path.join(HUB, 'tools');
  const env = {
    PATH: process.env.PATH, HOME, RAVENRY_HOME: MC, PORT: String(port), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
    CMUX_BIN: path.join(T, 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE, MC_SCRATCH_ROOT: path.join(dir, 'scratch'),
    MC_PROJECTS_ROOT: ROOT, MC_GLOBAL_CLAUDE_MD: path.join(HOME, '.claude', 'CLAUDE.md'), MC_BACKUP_DIR: path.join(dir, 'backups'),
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(T, 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(dir, 'open.jsonl'), CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
    MC_PS_BIN: path.join(T, 'stub-ps.mjs'), MC_LSOF_BIN: path.join(T, 'stub-ps.mjs'), STUB_PS_STATE: PS,
    MC_OSASCRIPT_BIN: path.join(T, 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(T, 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(dir, 'osascript.jsonl'),
    MC_CODEX: '0', MC_CODEX_HOME: path.join(HOME, '.codex'),
    ...(runtime ? { RAVENRY_RUNTIME_DIR: runtime } : {}),
    ...moreEnv,
  };
  const child = spawn(process.execPath, [path.join(HUB, 'server', 'index.mjs')], { cwd: HOME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const want = empty ? 0 : PROJECTS.length - panes.length;
  let st = null;
  for (let i = 0; i < 200; i++) {
    try {
      st = await (await fetch(url + '/api/state')).json();
      if (st.generatedAt && (st.projects || []).filter((p) => p.sessions && p.sessions.length).length === want) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  if (!st || !st.generatedAt) { child.kill(); throw new Error('the demo board did not start:\n' + log.slice(-2000)); }

  return {
    url, home: HOME, root: ROOT, log: () => log, sessions,
    state: async () => (await fetch(url + '/api/state')).json(),
    /** A working session stops on a question: a checkpoint arrives. */
    async arrive(id, question = 'Tilt the hull with the slope too, or keep it level?') {
      const f = files[id];
      fs.appendFileSync(f.evFile, f.evLine(['Stop', 0, { ends_on_question: true, question }]) + '\n');
      fs.appendFileSync(f.TR, f.rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: f.p.turn[1] + '\n\n' + question }], usage: { input_tokens: 8, cache_creation_input_tokens: 3000, cache_read_input_tokens: f.p.ctx, output_tokens: 300 } } }, ago(0)) + '\n' + f.rec('system', { subtype: 'turn_duration' }, ago(0)) + '\n');
      const s = JSON.parse(fs.readFileSync(FAKE, 'utf8'));
      s.screens[f.sf] = banner(id) + `❯ ${f.p.turn[0]}\n\n⏺ ${f.p.turn[1]}\n\n  ${question}\n\n` + prompt();
      const sf = s.workspaces.find((w) => w.surfaces[0].id === f.sf).surfaces[0];
      sf.title = sf.title.replace(/^\S+/, '✳');
      fs.writeFileSync(FAKE, JSON.stringify(s));
    },
    stop() { child.kill(); },
  };
}
