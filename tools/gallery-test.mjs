#!/usr/bin/env node
// The picture gallery (docs/design/Gallery.dc.html, variant B): the server
// keeps the last 6 pictures the current session's main transcript showed
// the user (its Reads and paths in its text, never a subagent's shots or files
// a command only wrote) with their time, who made them, pixel size and path, under the same rule as the single pick
// (server/pictures.mjs), serves only those, and Show in Finder reveals only
// one of them, on the Mac only.
//
// Unit checks on the module, then a test board on :4679 with a throwaway
// RAVENRY_HOME, fake transcripts, tools/fake-cmux.mjs and
// tools/stub-open.mjs for `open`, then the page headless in Chromium: the
// card's count, opening on the newest, the arrows, the strip, Esc, and a
// swipe at phone width. The pictures are neutral placeholders (app screens,
// a chart, a landscape, shapes), drawn to PNG files. Never touches the
// board on :4600, never opens Finder.
//
// Usage: node tools/gallery-test.mjs [--shots <dir>]
//   --shots: also saves the gallery at 1440x900 and 390x844, light and dark,
//   on the 5th of 6 pictures, where the mockup's B frames are (shapes.png), plus
//   the closed card and a portrait picture.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'gallery-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const SCRATCH = path.join(T, 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.MC_SCRATCH_ROOT = SCRATCH;
const P = await import('../server/pictures.mjs');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; })();

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');
const MIN = 60 * 1000;
const real = (p) => fs.realpathSync(p);

// ------------------------------------------------------------ the pictures
// Placeholder pictures (SVGs in tools/fixtures/gallery-placeholders.json,
// neutral and generic), drawn to PNG at the size the caption shows.
const browser = await (process.env.GL_WEBKIT ? (await import('playwright')).webkit : chromium).launch();
const svgs = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/gallery-placeholders.json'), 'utf8'));
async function draw(svgName, file, ageMin) {
  const svg = svgs[svgName];
  const w = Number(svg.match(/width="(\d+)"/)[1]), h = Number(svg.match(/height="(\d+)"/)[1]);
  const scale = w > h ? 1.8 : 1;
  const pg = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await pg.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await pg.screenshot({ path: file });
  await pg.close();
  const t = new Date(Date.now() - ageMin * MIN);
  fs.utimesSync(file, t, t);
  return file;
}

const H = path.join(T, 'root', 'sketchbook');
fs.mkdirSync(H, { recursive: true });
execFileSync('git', ['init', '-q', H]);
const SID = 'abababab-0000-4000-8000-000000000001';
const OTHER = 'cdcdcdcd-0000-4000-8000-000000000002';
const shot = (n) => path.join(H, 'shots', n);
const pics = {
  old: await draw('home', shot('title-old.png'), 40),      // the 7th: dropped
  home: await draw('home', shot('home.png'), 26),
  phone: await draw('phone', shot('phone-screen.png'), 21),
  chart: await draw('chart', shot('response-times.png'), 15),
  landscape: await draw('landscape', shot('landscape.png'), 9),
  shapes: await draw('shapes', shot('shapes.png'), 4),
  settings: await draw('settings', shot('settings.png'), 1),
};
const outside = path.join(T, 'outside');
const secret = await draw('shapes', path.join(outside, 'private.png'), 0.5);           // newer, outside every root
const otherScratch = await draw('chart', path.join(SCRATCH, slug(H), OTHER, 'scratchpad', 'other.png'), 2); // another session's scratchpad
fs.symlinkSync(secret, shot('link-out.png'));                                          // inside the folder, pointing out
// Newer files the main session never showed the user: none may be kept.
const copy = (from, to, ageMin) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); const t = new Date(Date.now() - ageMin * MIN); fs.utimesSync(to, t, t); return to; };
const unshown = {
  sub: copy(pics.shapes, shot('sub-verify.png'), 0.2),                          // a subagent's own verification shot
  fixture: copy(pics.home, path.join(H, 'tests', 'fixture.png'), 0.3),        // a test script drew it (path in its output)
  before: copy(pics.landscape, shot('before.png'), 0.35),                          // only in a command's input
  written: copy(pics.chart, shot('written.png'), 0.4),                         // a Write target
};

// The session's transcript: who made what, as Claude Code writes it.
const CLAUDE = path.join(T, 'claude');
const TD = path.join(CLAUDE, slug(H));
fs.mkdirSync(path.join(TD, SID, 'subagents'), { recursive: true });
let n = 0;
const at = (ageMin) => new Date(Date.now() - ageMin * MIN).toISOString();
const call = (id, name, input, ageMin) => JSON.stringify({ type: 'assistant', timestamp: at(ageMin), cwd: H, sessionId: SID, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, ageMin) => JSON.stringify({ type: 'user', timestamp: at(ageMin), cwd: H, sessionId: SID, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const made = (cmd, file, ageMin) => { const id = 'toolu_' + (++n); return [call(id, 'Bash', { command: cmd }, ageMin), result(id, `wrote ${file} (2880 x 1620)`, ageMin)]; };
const read = (file, ageMin) => call('toolu_' + (++n), 'Read', { file_path: file }, ageMin);
const says = (text, ageMin) => JSON.stringify({ type: 'assistant', timestamp: at(ageMin), cwd: H, sessionId: SID, message: { content: [{ type: 'text', text }] } });
// Each picture is made by a tool call, then shown to the user by a Read or by
// its path in the session's text: only the showing admits it.
const lines = [
  ...made('node tools/shoot.mjs --title', pics.old, 40), says(`The title screen: ${pics.old}`, 39.9),
  ...made(`cd ${H} && node tools/shoot.mjs --home`, pics.home, 26), read(pics.home, 25.9),
  call('toolu_pw', 'mcp__plugin_playwright_playwright__browser_take_screenshot', { filename: pics.phone, fullPage: false }, 21),
  says(`The phone screen: \`${pics.phone}\``, 20.9),
  ...made('python3 tools/plot.py response-times', pics.chart, 15), read(pics.chart, 14.9),
  ...made('node tools/shoot.mjs --landscape', pics.landscape, 9), says(`The landscape at full size:\n\n![landscape](shots/landscape.png)`, 8.9),
  ...made('node tools/shoot.mjs --shapes', pics.shapes, 4),
  read(pics.shapes, 3.5),                                                          // read after being made: still made by shoot.mjs
  ...made('node tools/shoot.mjs --settings', pics.settings, 1), read(pics.settings, 0.8),
  read(secret, 0.5),                                                             // refused: outside
  read(shot('link-out.png'), 0.5),                                               // refused: a symlink out
  says(`Compare ${otherScratch}`, 2),                                            // refused: another session's scratchpad
  ...made('node tests/draw-fixture.mjs', unshown.fixture, 0.3),                  // never shown: a file a command wrote
  call('toolu_cp', 'Bash', { command: `cp shots/home.png ${unshown.before}` }, 0.35), // never shown: only in a command
  call('toolu_wr', 'Write', { file_path: unshown.written, content: 'x' }, 0.4), // never shown: a Write target
];
fs.writeFileSync(path.join(TD, SID + '.jsonl'), lines.join('\n') + '\n');
// A subagent shot, read and named its own verification picture, the newest of all.
fs.writeFileSync(path.join(TD, SID, 'subagents', 'agent-1.jsonl'), [
  JSON.stringify({ type: 'assistant', timestamp: at(0.2), cwd: H, message: { content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Bash', input: { command: 'node tools/shoot.mjs --verify' } }] } }),
  JSON.stringify({ type: 'user', timestamp: at(0.2), cwd: H, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: [{ type: 'text', text: `saved ${unshown.sub}` }] }] } }),
  JSON.stringify({ type: 'assistant', timestamp: at(0.2), cwd: H, message: { content: [{ type: 'tool_use', id: 'toolu_s2', name: 'Read', input: { file_path: unshown.sub } }] } }),
  JSON.stringify({ type: 'assistant', timestamp: at(0.2), cwd: H, message: { content: [{ type: 'text', text: `Checked: ${unshown.sub}` }] } }),
].join('\n') + '\n');
const session = { sessionId: SID, path: path.join(TD, SID + '.jsonl') };

// ------------------------------------------------------------ unit
{
  const L = P.commandLabel;
  check('who: a script run by node is named by its last two path parts', L('cd /Users/x/y && node /Users/x/y/tools/shoot.mjs --landscape') === 'tools/shoot.mjs', L('cd /Users/x/y && node /Users/x/y/tools/shoot.mjs --landscape'));
  check('who: env assignments and flags are skipped', L('FOO=1 node --no-warnings tools/a.mjs') === 'tools/a.mjs');
  check('who: npm run keeps its verb', L('npm run shoot -- --landscape') === 'npm run shoot');
  check('who: a plain command is its first word', L('screencapture -x /tmp/a.png') === 'screencapture');
  check('who: in a chain, the part that names the picture', L('mkdir -p out && node make.mjs out/x.png', 'out/x.png') === 'make.mjs');
  check('who: an inline script says so', L('python3 -c "import x"') === 'python3 -c');
  check('who: a command that only looks (ls, open, cp) says nothing', P.callLabel({ name: 'Bash', input: { command: 'ls -la shots/a.png' } }, 'shots/a.png') === null && P.callLabel({ name: 'Bash', input: { command: 'open shots/a.png' } }) === null);
  check('who: an MCP tool goes by its own name', P.callLabel({ name: 'mcp__plugin_playwright_playwright__browser_take_screenshot', input: {} }) === 'browser_take_screenshot');

  const png = fs.readFileSync(pics.shapes);
  check('size: a PNG header gives 2880 x 1620', JSON.stringify(P.headerSize(png)) === '{"w":2880,"h":1620}', JSON.stringify(P.headerSize(png)));
  const gif = Buffer.from('474946383961' + '4001' + 'f000' + '0000', 'hex');
  check('size: a GIF header', JSON.stringify(P.headerSize(gif)) === '{"w":320,"h":240}');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 3]), Buffer.alloc(16)]);
  check('size: a JPEG frame header (after an APP0)', JSON.stringify(P.headerSize(jpg)) === '{"w":800,"h":600}', JSON.stringify(P.headerSize(jpg)));
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUIntLE(1919, 24, 3); webp.writeUIntLE(1079, 27, 3);
  check('size: a WebP (VP8X) header', JSON.stringify(P.headerSize(webp)) === '{"w":1920,"h":1080}');
  check('size: not an image header is null', P.headerSize(Buffer.from('hello world, not a picture at all')) === null);

  const roots = P.rootsFor(H, [SID]);
  const files = P.sessionTranscripts(session);
  const list = P.listFromTranscripts(files, roots);
  check('keep: 6 pictures, newest first', list.length === 6 && list[0].abs === real(pics.settings) && list[5].abs === real(pics.home), list.map((x) => path.basename(x.abs)).join(' '));
  check('keep: the 7th oldest is dropped', !list.some((x) => x.abs === real(pics.old)));
  check('keep: the newest is today\'s pick, unchanged', P.pickFromTranscripts(files, roots).abs === list[0].abs);
  check('privacy: a newer file outside every root is not kept', !list.some((x) => x.abs === real(secret)));
  check('privacy: a symlink in the folder pointing out is not kept', !list.some((x) => /link-out|private/.test(x.abs)));
  check('privacy: another session\'s scratchpad is not kept', !list.some((x) => x.abs === real(otherScratch)));
  check('privacy: every kept picture passes the same check as the pick', list.every((x) => P.checkFile(x.abs, roots) && P.checkFile(x.abs, roots).abs === x.abs));
  check('shown: a subagent\'s own screenshot is not kept, though it is the newest', !list.some((x) => x.abs === real(unshown.sub)));
  check('shown: a file a command wrote (path only in its output) is not kept', !list.some((x) => x.abs === real(unshown.fixture)));
  check('shown: a path only in a tool call\'s input (a command, a Write target) is not kept', !list.some((x) => x.abs === real(unshown.before) || x.abs === real(unshown.written)));
  const by = Object.fromEntries(list.map((x) => [path.basename(x.abs), x]));
  check('who: a path a script printed is made by that script', by['landscape.png'].by === 'tools/shoot.mjs' && by['landscape.png'].made, JSON.stringify(by['landscape.png'].by));
  check('who: a later Read does not replace who made it', by['shapes.png'].by === 'tools/shoot.mjs' && by['shapes.png'].made);
  check('who: a picture shown only in the session\'s text (a markdown image) keeps its maker', by['landscape.png'].by === 'tools/shoot.mjs' && by['landscape.png'].made);
  check('who: an MCP screenshot', by['phone-screen.png'].by === 'browser_take_screenshot');
  check('who: python3 tools/plot.py', by['response-times.png'].by === 'tools/plot.py');
  {
    const tp = path.join(T, 'read-only.jsonl');
    fs.writeFileSync(tp, call('toolu_x', 'Read', { file_path: pics.home }, 1) + '\n');
    const only = P.listFromTranscripts([tp], roots);
    check('who: a picture the session only read says so (not "made")', only.length === 1 && only[0].by === 'Read' && only[0].made === false);
    // A subagent made it, its hand-back named it, the main session read it.
    const tp2 = path.join(T, 'via-subagent.jsonl');
    fs.writeFileSync(tp2, [call('toolu_ag', 'Agent', { prompt: 'shoot the home screen' }, 2), result('toolu_ag', `Done: ${pics.home}`, 1.5), call('toolu_y', 'Read', { file_path: pics.home }, 1)].join('\n') + '\n');
    const via = P.listFromTranscripts([tp2], roots);
    check('who: a subagent\'s shot the main session read is kept, made by "a subagent"', via.length === 1 && via[0].by === 'a subagent' && via[0].made === true, JSON.stringify(via[0] && via[0].by));
  }

  const e = P.refresh({ id: 'u', folder: H }, session);
  check('refresh: the list runs oldest to newest, the pick is its last', e.list.length === 6 && e.list[5] === e.pick && e.list[0].name === 'home.png' && e.pick.name === 'settings.png', e.list.map((x) => x.name).join(' '));
  check('refresh: each has a key, pixel size and a path relative to the project', e.list.every((x) => /^[0-9a-f]{12}$/.test(x.key)) && e.list[4].w === 2880 && e.list[4].h === 1620 && e.list[4].rel === 'shots/shapes.png' && e.list[1].w === 900 && e.list[1].h === 1950);
  check('route: each of the 6 is served by name and key', e.list.every((x) => P.serveable('u', x.name, x.key) === x.abs));
  check('route: without a key, only the pick answers (as before)', P.serveable('u', 'settings.png') === e.pick.abs && P.serveable('u', 'shapes.png') === null);
  check('route: a key with the wrong name is refused', P.serveable('u', 'home.png', e.list[4].key) === null);
  check('route: the dropped 7th is refused', P.serveable('u', 'title-old.png') === null && P.serveable('u', 'title-old.png', 'abcdefabcdef') === null);
  check('reveal: a key of one of the 6 gives its real path', P.revealable('u', e.list[2].key) === e.list[2].abs);
  check('reveal: a path, a made-up key or nothing is refused', P.revealable('u', pics.shapes) === null && P.revealable('u', '0123456789ab') === null && P.revealable('u', null) === null && P.revealable('u', '../../x') === null);
  fs.utimesSync(pics.chart, new Date(Date.now() - 31 * 24 * 60 * MIN), new Date(Date.now() - 31 * 24 * 60 * MIN));
  check('reveal and route re-check now: a picture past 30 days is refused', P.revealable('u', e.list[2].key) === null && P.serveable('u', 'response-times.png', e.list[2].key) === null);
  fs.utimesSync(pics.chart, new Date(Date.now() - 15 * MIN), new Date(Date.now() - 15 * MIN));
  check('session: a switch drops the 6 at once', P.gallery('u', { sessionId: OTHER, path: session.path }).length === 0 && P.revealable('u', e.list[0].key) === null);
}

// ------------------------------------------------------------ the board
const PORT = 4679;
const MC = path.join(T, 'mc');
const FAKE = path.join(T, 'fake-cmux.json');
fs.mkdirSync(path.join(MC, 'briefs'), { recursive: true });
fs.writeFileSync(path.join(MC, 'briefs', 'sketchbook.md'), '# Sketchbook\n\n## Goal\nA drawing app that reads at a glance.\n');
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: [{ id: 'ws-h', ref: 'workspace:1', title: 'Sketchbook', cwd: H, surfaces: [{ id: 'sf-h', ref: 'surface:1', title: 'Sketchbook' }] }],
  screens: { 'sf-h': `Resume this session with:\nclaude --resume ${SID}\n~/sketchbook $ ` },
}));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root') },
  projects: [{ id: 'sketchbook', name: 'Sketchbook', folder: H, brief: path.join(MC, 'briefs', 'sketchbook.md'), workspaces: ['ws-h'] }],
}, null, 2));
const OPEN_LOG = path.join(T, 'open.jsonl');
const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
  env: { ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
    CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE, MC_SCRATCH_ROOT: SCRATCH,
    MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'),
    STUB_OPEN_LOG: OPEN_LOG, MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-open.mjs')]) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const base = `http://localhost:${PORT}`;
const opens = () => { try { return fs.readFileSync(OPEN_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const post = async (p, body, headers = { 'X-Ravenry': '1' }) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const LAN = (() => {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
  out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  return out[0] && out[0].address;
})();

try {
  let gal = null;
  for (let i = 0; i < 80; i++) {
    try {
      const st = await (await fetch(base + '/api/state')).json();
      const p = st.projects.find((x) => x.id === 'sketchbook');
      const auto = p && p.brief && p.brief.pictures.find((x) => x.auto);
      if (auto && auto.gallery && auto.gallery.length) { gal = auto.gallery; break; }
    } catch { /* starting */ }
    await sleep(200);
  }
  check('board: the snapshot carries the session\'s last 6, oldest first', gal && gal.length === 6 && gal[0].name === 'home.png' && gal[5].name === 'settings.png', gal ? gal.map((x) => x.name).join(' ') : log.slice(-500));
  const shapes = gal[4];
  check('board: each carries its time, who made it, pixel size, path relative to the project', shapes.by === 'tools/shoot.mjs' && shapes.made && shapes.w === 2880 && shapes.h === 1620 && shapes.rel === 'shots/shapes.png' && Date.now() - Date.parse(shapes.at) > 3 * MIN && Date.now() - Date.parse(shapes.at) < 5 * MIN, JSON.stringify(shapes));
  check('board: no refused or unshown picture is in the snapshot', !JSON.stringify(gal).match(/private|link-out|other\.png|title-old|sub-verify|fixture|before|written/));
  for (const g of gal) {
    const r = await fetch(base + g.url);
    if (!(r.ok && r.headers.get('content-type') === 'image/png')) check(`route: serves ${g.name}`, false, String(r.status));
  }
  check('route: all 6 are served', true);
  for (const [what, u] of [
    ['the dropped 7th', '/api/pic/sketchbook?auto=title-old.png'],
    ['the outside file', '/api/pic/sketchbook?auto=private.png'],
    ['a real name with another picture\'s key', `/api/pic/sketchbook?auto=home.png&k=${shapes.key}`],
    ['a path through ?p=', `/api/pic/sketchbook?p=${encodeURIComponent(pics.shapes)}`],
  ]) { const r = await fetch(base + u); check(`route: refuses ${what}`, r.status === 404, String(r.status)); }

  let r = await post('/api/project/reveal-picture', { projectId: 'sketchbook', key: shapes.key });
  check('reveal: Show in Finder runs open -R on that picture\'s real path', r.status === 200 && opens().length === 1 && JSON.stringify(opens()[0].args) === JSON.stringify(['-R', real(pics.shapes)]), `${r.status} ${JSON.stringify(opens())}`);
  r = await post('/api/project/reveal-picture', { projectId: 'sketchbook', key: 'abcdefabcdef', path: secret });
  check('reveal: a key that is not one of the 6 is 404, a path from the page is ignored', r.status === 404 && opens().length === 1, `${r.status} ${r.j.error}`);
  r = await post('/api/project/reveal-picture', { projectId: 'sketchbook', path: pics.shapes });
  check('reveal: a path alone (no key) is refused', r.status === 404 && opens().length === 1, String(r.status));
  r = await post('/api/project/reveal-picture', { projectId: 'nope', key: shapes.key });
  check('reveal: an unknown project is 404', r.status === 404 && opens().length === 1);
  r = await post('/api/project/reveal-picture', { projectId: 'sketchbook', key: shapes.key }, {});
  check('reveal: the write guard holds (no board header is 403)', r.status === 403 && opens().length === 1, String(r.status));
  if (!LAN) check('phone: needs a private LAN address to arrive as one', false, 'no LAN address on this Mac');
  else {
    const ph = (q, cookie) => new Promise((resolve, reject) => {
      const rq = http.request({ host: LAN, port: PORT, path: q.path, method: q.method || 'GET', headers: { Host: `${LAN}:${PORT}`, ...(cookie ? { Cookie: cookie } : {}), ...(q.headers || {}) } }, (res) => { const b = []; res.on('data', (d) => b.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b) })); });
      rq.on('error', reject);
      rq.end(q.body || undefined);
    });
    let x = await ph({ path: shapes.url });
    check('phone: a picture with no sign-in is 401', x.status === 401, String(x.status));
    await fetch(base + '/api/phone');
    const KEY = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).key;
    const si = await ph({ path: '/?k=' + encodeURIComponent(KEY) });
    const COOKIE = [].concat(si.headers['set-cookie'] || []).find((c) => c.startsWith('mc_phone=')).split(';')[0];
    x = await ph({ path: shapes.url }, COOKIE);
    check('phone: a signed-in phone gets the picture', x.status === 200 && x.headers['content-type'] === 'image/png');
    x = await ph({ method: 'POST', path: '/api/project/reveal-picture', headers: { 'X-Ravenry': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'sketchbook', key: shapes.key }) }, COOKIE);
    check('phone: Show in Finder is 403 for a phone, nothing opened', x.status === 403 && opens().length === 1, `${x.status} ${x.body}`);
  }

  // ---------------------------------------------------------- the page
  async function page(vp, theme, extra = {}) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, ...extra });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`${base}/?theme=${theme}#sketchbook`);
    await pg.waitForSelector('.picard', { timeout: 15000 });
    await pg.waitForFunction(() => { const i = document.querySelector('.picard img'); return i && i.complete && i.naturalWidth > 0; });
    return { ctx, pg, errs };
  }
  const cur = (pg) => pg.evaluate(() => { const l = document.querySelector('#gl-fs'); if (!l || l.hidden) return null; const on = [...l.querySelectorAll('.gl-thumb')].findIndex((b) => b.classList.contains('on')); return { on, src: l.querySelector('#gl-im').getAttribute('src'), cap: l.querySelector('#gl-cap').textContent, thumbs: l.querySelectorAll('.gl-thumb').length, times: [...l.querySelectorAll('.gl-time')].map((t) => t.textContent) }; });
  const settle = async (pg) => {
    await pg.waitForFunction(() => { const i = document.querySelector('#gl-im'); return [...document.querySelectorAll('#gl-fs img')].every((x) => x.complete && x.naturalWidth > 0) && i && i.complete; });
    await pg.evaluate(() => Promise.all([...document.querySelectorAll('#gl-fs img')].map((x) => x.decode().catch(() => {}))));
  };

  {
    const { ctx, pg, errs } = await page({ width: 1440, height: 900 }, 'dark');
    const badge = await pg.$eval('.picard', (b) => ({ n: (b.querySelector('.pic-hint') || {}).textContent, cursor: getComputedStyle(b).cursor }));
    check('card: the count "6" in its corner and a zoom-in cursor', badge.n === '6' && badge.cursor === 'zoom-in', JSON.stringify(badge));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await (await pg.$('#d-pics')).screenshot({ path: path.join(SHOTS, 'card-desk-dark.png') }); }
    await pg.click('.picard');
    await settle(pg);
    let c = await cur(pg);
    check('open: the whole window, on the newest (the last thumbnail)', c && c.on === 5 && c.thumbs === 6 && /settings\.png/.test(c.src), JSON.stringify(c));
    check('open: the caption says who made it, its age, size and path, with Show in Finder and Copy path', c && /Made by tools\/shoot\.mjs/.test(c.cap) && /1 min ago/.test(c.cap) && /2880 x 1620/.test(c.cap) && /shots\/settings\.png/.test(c.cap) && /Show in Finder/.test(c.cap) && /Copy path/.test(c.cap), c && c.cap);
    check('open: each thumbnail has its age', c && JSON.stringify(c.times) === JSON.stringify(['26 min', '21 min', '15 min', '9 min', '4 min', '1 min']), c && JSON.stringify(c.times));
    const nextOff = await pg.$eval('[data-gl-step="1"]', (b) => b.disabled);
    check('open: Next is off on the newest', nextOff === true);
    await pg.keyboard.press('ArrowLeft');
    await settle(pg);
    c = await cur(pg);
    check('keys: the left arrow goes back one', c.on === 4 && /shapes\.png/.test(c.src) && /4 min ago/.test(c.cap), JSON.stringify(c));
    const fit = await pg.$eval('#gl-im', (i) => ({ fit: getComputedStyle(i).objectFit, w: i.getBoundingClientRect().width }));
    check('picture: shown whole (contain), about 1200 px wide at 1440', fit.fit === 'contain' && fit.w > 1150 && fit.w <= 1248, JSON.stringify(fit));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'B-desk-dark.png') });
    await pg.click('[data-gl-reveal]');
    await sleep(400);
    check('reveal: the button reveals the picture shown', opens().length === 2 && opens()[1].args[1] === real(pics.shapes), JSON.stringify(opens()));
    await pg.click('[data-gl-go="1"]');
    c = await cur(pg);
    check('strip: a thumbnail opens that picture', c.on === 1 && /phone-screen\.png/.test(c.src));
    const portrait = await pg.$eval('#gl-im', (i) => { const r = i.getBoundingClientRect(); return { box: r.height, natural: i.naturalWidth / i.naturalHeight }; });
    check('picture: a portrait shot is not cropped (contain)', portrait.natural < 1, JSON.stringify(portrait));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'B-desk-dark-portrait.png') });
    await pg.keyboard.press('ArrowRight');
    c = await cur(pg);
    check('keys: the right arrow goes forward one', c.on === 2);
    await pg.keyboard.press('Escape');
    c = await cur(pg);
    check('keys: Esc closes', c === null);
    check('page: no script errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // ------------------------------------------------------------ zoom
  // The picture shown zooms: the wheel and a trackpad pinch (ctrl+wheel)
  // around the pointer, a drag pans it, held so it never leaves the view,
  // a double click toggles, Fit and the first Esc go back, the arrows still
  // move and a new picture opens whole.
  const zs = (pg) => pg.evaluate(() => {
    const v = document.querySelector('#gl-view'), i = document.querySelector('#gl-im');
    if (!v || !i) return null;
    const m = new DOMMatrix(getComputedStyle(i).transform === 'none' ? '' : getComputedStyle(i).transform);
    const r = v.getBoundingClientRect();
    const k = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight);
    const on = [...document.querySelectorAll('.gl-thumb')].findIndex((b) => b.classList.contains('on'));
    const fit = document.querySelector('[data-gl-fit]');
    return { s: +m.a.toFixed(3), x: +m.e.toFixed(1), y: +m.f.toFixed(1), vw: r.width, vh: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, fw: i.naturalWidth * k, fh: i.naturalHeight * k, on, open: !document.querySelector('#gl-fs').hidden, fit: fit && !fit.hidden ? fit.textContent : null };
  });
  // The picture's own spot (in fit pixels from its centre) under a screen point.
  const spot = (z, px, py) => [(px - z.cx - z.x) / z.s, (py - z.cy - z.y) / z.s];
  const near = (a, b, e = 1.5) => Math.abs(a - b) <= e;
  {
    const { ctx, pg, errs } = await page({ width: 1440, height: 900 }, 'dark');
    await pg.click('.picard');
    await settle(pg);
    await pg.keyboard.press('ArrowLeft'); // shapes.png, 2880 x 1620
    await settle(pg);
    let z = await zs(pg);
    check('zoom desk: opens whole, scale 1, no Fit button', z.s === 1 && z.x === 0 && z.y === 0 && z.fit === null, JSON.stringify(z));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'zoom-desk-fit.png') });
    const P1 = [z.cx + 220, z.cy - 120];
    const before = spot(z, ...P1);
    await pg.mouse.move(...P1);
    await pg.mouse.wheel(0, -300);
    await sleep(120);
    z = await zs(pg);
    check('zoom desk: the wheel zooms in', z.s > 1.15 && z.s < 2, JSON.stringify(z));
    let after = spot(z, ...P1);
    check('zoom desk: around the pointer (the spot under it stays)', near(before[0], after[0]) && near(before[1], after[1]), JSON.stringify({ before, after }));
    await pg.keyboard.down('Control');
    for (let k = 0; k < 5; k++) { await pg.mouse.wheel(0, -10); await sleep(30); }
    await pg.keyboard.up('Control');
    await sleep(120);
    const z2 = await zs(pg);
    after = spot(z2, ...P1);
    check('zoom desk: a trackpad pinch (ctrl+wheel) zooms on, around the pointer', z2.s > z.s * 1.2 && near(before[0], after[0]) && near(before[1], after[1]), JSON.stringify({ s0: z.s, s: z2.s, before, after }));
    const pageZoom = await pg.evaluate(() => [window.visualViewport ? visualViewport.scale : 1, document.documentElement.clientWidth]);
    check('zoom desk: the page itself did not zoom', pageZoom[0] === 1 && pageZoom[1] === 1440, JSON.stringify(pageZoom));
    check('zoom desk: the Fit button shows the zoom', z2.fit && new RegExp('^' + Math.round(z2.s * 100) + '%Fit$').test(z2.fit), z2.fit);
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'zoom-desk-zoomed.png') });
    // Drag pans by as much as the mouse moved.
    z = z2;
    await pg.mouse.move(z.cx, z.cy); await pg.mouse.down(); await pg.mouse.move(z.cx - 150, z.cy - 60, { steps: 6 }); await pg.mouse.up();
    let z3 = await zs(pg);
    check('zoom desk: a drag pans', near(z3.x, z.x - 150) && near(z3.y, z.y - 60), JSON.stringify({ from: [z.x, z.y], to: [z3.x, z3.y] }));
    // Dragged far: held at the edge, the picture still covering the view.
    await pg.mouse.move(z.cx, z.cy); await pg.mouse.down(); await pg.mouse.move(z.cx + 4000, z.cy + 4000, { steps: 8 }); await pg.mouse.up();
    z3 = await zs(pg);
    const mx = (z3.fw * z3.s - z3.vw) / 2, my = Math.max(0, (z3.fh * z3.s - z3.vh) / 2);
    check('zoom desk: panning is held at the picture\'s edge', near(z3.x, mx) && near(z3.y, my), JSON.stringify({ x: z3.x, mx, y: z3.y, my }));
    check('zoom desk: dragging did not move to another picture or close', z3.on === 4 && z3.open);
    // Zoomed all the way: 5x (this picture's own pixels are nearer).
    await pg.mouse.move(z3.cx, z3.cy);
    for (let k = 0; k < 12; k++) await pg.mouse.wheel(0, -300);
    await sleep(100);
    z3 = await zs(pg);
    check('zoom desk: at most 5x', z3.s === 5, String(z3.s));
    await pg.keyboard.press('Escape');
    await sleep(300);
    z3 = await zs(pg);
    check('zoom desk: the first Esc goes back to fit, the gallery stays open', z3.s === 1 && z3.open && z3.on === 4, JSON.stringify(z3));
    await pg.mouse.dblclick(z3.cx + 100, z3.cy + 50);
    await sleep(300);
    z3 = await zs(pg);
    check('zoom desk: a double click zooms in (2.5x)', z3.s === 2.5, String(z3.s));
    await pg.click('[data-gl-fit]');
    await sleep(300);
    z3 = await zs(pg);
    check('zoom desk: Fit goes back to the whole picture', z3.s === 1 && z3.fit === null, JSON.stringify(z3));
    // WebKit (cmux's browser, Safari) sends a trackpad pinch as gesture
    // events, not ctrl+wheel; Playwright cannot make real ones, so these are
    // made by hand with the fields WebKit's GestureEvent carries.
    const gest = await pg.evaluate(([x, y]) => {
      const v = document.querySelector('#gl-view');
      const ev = (type, scale) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(e, { scale: { value: scale }, clientX: { value: x }, clientY: { value: y } }); v.dispatchEvent(e); return e.defaultPrevented; };
      const a = ev('gesturestart', 1), b = ev('gesturechange', 1.6), c = ev('gesturechange', 2.2); ev('gestureend', 2.2);
      return [a, b, c];
    }, [z3.cx - 200, z3.cy + 80]);
    z3 = await zs(pg);
    check('zoom desk: a WebKit trackpad pinch (gesture events) zooms, the page zoom held off', z3.s === 2.2 && gest.every(Boolean), JSON.stringify({ s: z3.s, prevented: gest }));
    await pg.click('[data-gl-fit]');
    await sleep(300);
    await pg.mouse.dblclick(z3.cx, z3.cy);
    await sleep(300);
    await pg.mouse.dblclick(z3.cx, z3.cy);
    await sleep(300);
    check('zoom desk: a second double click goes back to fit', (await zs(pg)).s === 1);
    await pg.mouse.dblclick(z3.cx, z3.cy);
    await sleep(300);
    await pg.keyboard.press('ArrowRight');
    await settle(pg);
    z3 = await zs(pg);
    check('zoom desk: zoomed, the right arrow still moves, and the next picture opens whole', z3.on === 5 && z3.s === 1 && z3.fit === null, JSON.stringify(z3));
    await pg.mouse.dblclick(z3.cx, z3.cy);
    await sleep(300);
    await pg.click('.gb-stage [data-gl-step="-1"]');
    await settle(pg);
    z3 = await zs(pg);
    check('zoom desk: zoomed, Previous still moves, the picture opens whole', z3.on === 4 && z3.s === 1, JSON.stringify(z3));
    await pg.keyboard.press('Escape');
    check('zoom desk: at fit, Esc closes', (await cur(pg)) === null);
    check('zoom desk: no script errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // ------------------------------------------------------- a real board
  // A user's screenshot (2026-11-03 19:36): a pane about 1273 x 764 in cmux's
  // browser (WebKit), the page scrolled down a long project, a permission
  // prompt open (its terminal rule lines 200 columns wide), the Live screen
  // and the picture card in the right column. The gallery got hidden by the
  // Live screen when scrolling down, and the "Do you want to proceed"
  // dialog ran out of its card.
  {
    const W = 200;
    const rule = (c) => c.repeat(W);
    const heredoc = Array.from({ length: 14 }, (_, k) => `  const r${k} = await pg.evaluate(() => (document.elementFromPoint(${k * 40}, 300) || {}).className); console.log('probe ${k}', r${k});`);
    const screen = [
      'Resume this session with:', `claude --resume ${SID}`, `~/sketchbook $ claude --resume ${SID}`, '',
      '⏺ Bash(cd /private/tmp/claude-501/-Users-you-projects-app/abababab-0000-4000-8000-0000000000aa/scratchpad/gallery-fix && node real.mjs)',
      '  ⎿  Waiting…', '',
      rule('─'),
      ' Bash command', '',
      '   cat > real.mjs <<\'EOF\'',
      ...heredoc.map((l) => '   ' + l),
      '   EOF',
      '   cd /private/tmp/claude-501/-Users-you-projects-app/abababab-0000-4000-8000-0000000000aa/scratchpad/gallery-fix && node real.mjs',
      rule('╌'), rule('╌'), '',
      ' Dangerous rm operation not ruled out, the shell may read this command differently',
      ' ⚠ Claude Code will automatically block this request in 1:36, to avoid', ' holding up an unattended session', '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to /private/tmp/claude-501/-Users-you-projects-app/abababab-0000-4000-8000-0000000000aa/scratchpad/gallery-fix/ from this project',
      '   3. No', '',
      ' Esc to cancel · Tab to amend',
    ].join('\n');
    const st = JSON.parse(fs.readFileSync(FAKE, 'utf8'));
    st.screens['sf-h'] = screen;
    fs.writeFileSync(FAKE, JSON.stringify(st));
    // Text that runs out of the card it sits in: each text box's right edge,
    // cut by any box between it and the card that clips (overflow hidden).
    const spill = (pg, sel) => pg.evaluate((s) => {
      const card = document.querySelector(s);
      if (!card) return ['no ' + s];
      const edge = card.getBoundingClientRect().right;
      const out = [];
      const tw = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        if (!t.textContent.trim()) continue;
        const r = document.createRange(); r.selectNodeContents(t);
        let right = Math.max(0, ...[...r.getClientRects()].map((x) => x.right));
        for (let e = t.parentElement; e && e !== card; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.overflowX !== 'visible') right = Math.min(right, e.getBoundingClientRect().right);
        }
        if (right > edge + 1) out.push(`${Math.round(right - edge)}px: ${t.textContent.trim().slice(0, 40)}`);
      }
      return out;
    }, sel);
    for (const [vp, tag] of [[{ width: 1273, height: 740 }, 'desk'], [{ width: 390, height: 844 }, 'phone']]) {
      const phone = tag === 'phone';
      const { ctx, pg, errs } = await page(vp, 'dark', phone ? { hasTouch: true, isMobile: true } : {});
      await pg.waitForFunction(() => /Do you want to proceed/.test((document.querySelector('#d-ask-top') || {}).textContent || '') && /Dangerous rm/.test((document.querySelector('#lv-lines') || {}).textContent || ''), null, { timeout: 15000 });
      // As long as a real project's page: a big project's sessions,
      // objectives and timeline run several screens down.
      await pg.evaluate(() => document.querySelector('#d-timeline').insertAdjacentHTML('afterend', '<div class="card" id="test-long" style="height: 2600px"></div>'));
      await sleep(2300); // a render tick or two while it sits there
      for (const sel of ['#d-ask', '#lv-card']) {
        const s = await spill(pg, sel);
        check(`${tag}: no screen text runs out of ${sel === '#d-ask' ? 'the answer card' : 'the Live screen card'}`, s.length === 0, s.slice(0, 4).join(' | '));
      }
      // A rule 200 columns wide is one clipped row, not rows of dashes.
      const rows = await pg.evaluate(() => [...document.querySelectorAll('#d-ask-top div, #lv-lines div')].filter((d) => !d.children.length && /^\s*[─╌]{6,}\s*$/.test(d.textContent)).map((d) => Math.round(d.getBoundingClientRect().height / parseFloat(getComputedStyle(d).lineHeight))));
      check(`${tag}: each terminal rule line is one row, in the answer card and the Live screen`, rows.length >= 4 && rows.every((n) => n === 1), JSON.stringify(rows));
      const wide = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${tag}: the page does not scroll sideways`, wide <= 0, String(wide));
      if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `real-${tag}-top.png`) });
      if (!phone) {
        // Scrolled down, the way he reads the left column.
        for (const y of [400, 900, 1600]) {
          await pg.evaluate((yy) => window.scrollTo(0, yy), y);
          await sleep(150);
          const r = await pg.evaluate(() => {
            const pic = document.querySelector('#d-pics').getBoundingClientRect();
            const lv = document.querySelector('#lv-card').getBoundingClientRect();
            const hidden = [];
            for (let fy = 0.05; fy < 1; fy += 0.15) for (let fx = 0.1; fx < 1; fx += 0.2) {
              const x = pic.left + pic.width * fx, y = pic.top + pic.height * fy;
              if (y < 0 || y > innerHeight) continue;
              const el = document.elementFromPoint(x, y);
              if (!el || !el.closest('#d-pics')) hidden.push(`${Math.round(x)},${Math.round(y)}:${el && (el.closest('#lv-card') ? 'lv-card' : el.className)}`);
            }
            return { scrollY: Math.round(scrollY), pic: [Math.round(pic.top), Math.round(pic.bottom)], lv: [Math.round(lv.top), Math.round(lv.bottom)], overlap: Math.max(0, Math.round(Math.min(pic.bottom, lv.bottom) - Math.max(pic.top, lv.top))), hidden };
          });
          check(`${tag} scrolled ${y}: the Live screen never covers the picture card`, r.overlap === 0 && r.hidden.length === 0, JSON.stringify(r));
          if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `real-${tag}-scrolled-${y}.png`) });
        }
        // The column pins as one: with room, the Live screen stays at the
        // top while the long left column scrolls past.
        const fits = await pg.evaluate(() => document.querySelector('.col-r').getBoundingClientRect().height + 24 <= innerHeight);
        const lvTop = await pg.$eval('#lv-card', (c) => Math.round(c.getBoundingClientRect().top));
        const colBottom = await pg.$eval('.col-r', (c) => Math.round(c.getBoundingClientRect().bottom));
        check(`${tag}: scrolled far down, the right column is pinned in view (its top at 12 when it fits, its foot on screen when not)`, fits ? lvTop === 12 : (colBottom <= vp.height && colBottom >= vp.height - 13), JSON.stringify({ fits, lvTop, colBottom }));
        // Scrolling back up a little brings the Live screen's head back.
        await pg.evaluate(() => window.scrollTo(0, scrollY - 300));
        await sleep(150);
        const back = await pg.$eval('#lv-card', (c) => Math.round(c.getBoundingClientRect().top));
        check(`${tag}: scrolling up a little brings the Live screen's head back to the top`, back === 12, String(back));
        await pg.evaluate(() => window.scrollTo(0, 1600));
        await sleep(150);
        // The gallery opened from down there covers the whole window.
        await pg.$eval('.picard', (b) => b.click());
        await settle(pg);
        await pg.mouse.move(600, 400);
        for (let k = 0; k < 4; k++) { await pg.mouse.wheel(0, 400); await sleep(60); }
        await sleep(2300);
        const g = await pg.evaluate(() => {
          const l = document.querySelector('#gl-fs'), r = l.getBoundingClientRect();
          const pts = [[20, 20], [innerWidth - 20, 60], [innerWidth / 2, innerHeight / 2], [20, innerHeight - 20], [innerWidth - 20, innerHeight - 20]];
          return { rect: [r.left, r.top, r.width, r.height].map(Math.round), bad: pts.filter(([x, y]) => !l.contains(document.elementFromPoint(x, y))).map(([x, y]) => `${x},${y}`) };
        });
        check(`${tag}: the gallery opened scrolled down covers the whole window`, g.bad.length === 0 && g.rect.join() === `0,0,${vp.width},${vp.height}`, JSON.stringify(g));
        if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `real-${tag}-gallery.png`) });
        await pg.keyboard.press('Escape');
      } else {
        await pg.evaluate(() => document.querySelector('#d-ask').scrollIntoView());
        await sleep(150);
        if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `real-${tag}-answer.png`) });
      }
      check(`${tag}: no script errors`, errs.length === 0, errs.join(' | '));
      await ctx.close();
    }
    st.screens['sf-h'] = `Resume this session with:\nclaude --resume ${SID}\n~/sketchbook $ `;
    fs.writeFileSync(FAKE, JSON.stringify(st));
  }
  {
    const { ctx, pg } = await page({ width: 1440, height: 900 }, 'light');
    await pg.click('.picard');
    await settle(pg);
    await pg.keyboard.press('ArrowLeft');
    await settle(pg);
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'B-desk-light.png') });
    await pg.click('[data-gl-close]');
    check('close: the Close button closes', (await cur(pg)) === null);
    await ctx.close();
  }
  for (const theme of ['dark', 'light']) {
    const { ctx, pg, errs } = await page({ width: 390, height: 844 }, theme, { hasTouch: true, isMobile: true });
    await pg.click('.picard');
    await settle(pg);
    let c = await cur(pg);
    const bar = await pg.$eval('#gl-bar', (b) => b.textContent);
    check(`phone ${theme}: opens on the newest, "6 of 6", no Show in Finder`, c.on === 5 && /6 of 6/.test(bar) && !/Show in Finder/.test(c.cap) && c.times.length === 0, `${bar} | ${c.cap}`);
    // Like turning pages: a finger moving right goes back, left goes forward.
    // Playwright's WebKit has no Touch constructor, so under GL_WEBKIT=1
    // the swipe is left to the Chromium run.
    const swipe = (from, to) => pg.evaluate(([a, b]) => {
      const el = document.querySelector('.gb-stage');
      let t;
      try { t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 }); t(a); } catch { return false; }
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t(a)], changedTouches: [t(a)] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t(b)] }));
      return true;
    }, [from, to]);
    if (await swipe(80, 300)) {
      c = await cur(pg);
      check(`phone ${theme}: a swipe to the right goes back one`, c.on === 4, JSON.stringify(c));
      await swipe(300, 80);
      c = await cur(pg);
      check(`phone ${theme}: a swipe to the left goes forward one`, c.on === 5);
    } else if (!process.env.GL_WEBKIT) check(`phone ${theme}: a swipe can be sent`, false, 'no Touch constructor');
    else console.log(`SKIP  phone ${theme}: swipe (no Touch constructor in WebKit)`);
    await pg.click('.gb-ctl [data-gl-step="-1"]');
    await settle(pg);
    c = await cur(pg);
    const caption = await pg.$eval('#gl-cap', (x) => x.innerText);
    check(`phone ${theme}: Previous, and the caption under the picture`, c.on === 4 && /shapes\.png\s+Made by tools\/shoot\.mjs, 4 min ago/.test(caption), caption);
    const sq = await pg.$eval('.gl-thumb', (b) => { const r = b.getBoundingClientRect(); return Math.abs(r.width - r.height) < 1; });
    check(`phone ${theme}: square thumbnails`, sq);
    const over = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`phone ${theme}: nothing scrolls sideways`, !over);
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `B-phone-${theme}.png`) });
    await pg.click('[data-gl-close]');
    check(`phone ${theme}: the X closes`, (await cur(pg)) === null);
    check(`phone ${theme}: no script errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // Zoom on a phone: a real two-finger pinch (CDP touch events, so the
  // browser's own touch handling runs), a one-finger pan, a double tap,
  // and the swipe and the X still working at fit.
  if (!process.env.GL_WEBKIT) {
    const { ctx, pg, errs } = await page({ width: 390, height: 844 }, 'dark', { hasTouch: true, isMobile: true });
    const cdp = await ctx.newCDPSession(pg);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const pinch = async (cx, cy, d0, d1, steps = 10) => {
      await touch('touchStart', [[cx - d0, cy], [cx + d0, cy]]);
      for (let k = 1; k <= steps; k++) { const dd = d0 + (d1 - d0) * k / steps; await touch('touchMove', [[cx - dd, cy], [cx + dd, cy]]); await sleep(16); }
      await touch('touchEnd', []);
    };
    const drag = async (x0, y0, x1, y1, steps = 8) => {
      await touch('touchStart', [[x0, y0]]);
      for (let k = 1; k <= steps; k++) { await touch('touchMove', [[x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps]]); await sleep(16); }
      await touch('touchEnd', []);
    };
    const tap = async (x, y) => { await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []); };
    await pg.click('.picard');
    await settle(pg);
    await pg.click('.gb-ctl [data-gl-step="-1"]'); // shapes.png
    await settle(pg);
    let z = await zs(pg);
    check('zoom phone: opens whole', z.s === 1 && z.on === 4, JSON.stringify(z));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'zoom-phone-fit.png') });
    const before = spot(z, z.cx + 40, z.cy);
    await pinch(z.cx + 40, z.cy, 30, 90);
    await sleep(150);
    let z2 = await zs(pg);
    const after = spot(z2, z.cx + 40, z.cy);
    check('zoom phone: a two-finger pinch zooms in (about 3x for fingers 3x apart)', z2.s > 2.7 && z2.s < 3.2, String(z2.s));
    check('zoom phone: around the fingers (the spot between them stays)', near(before[0], after[0], 2) && near(before[1], after[1], 2), JSON.stringify({ before, after }));
    check('zoom phone: the pinch neither moved to another picture nor closed', z2.on === 4 && z2.open, JSON.stringify(z2));
    const vv = await pg.evaluate(() => (window.visualViewport ? visualViewport.scale : 1));
    check('zoom phone: the page itself did not zoom', vv === 1, String(vv));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'zoom-phone-zoomed.png') });
    // A one-finger sideways drag pans, and is not a swipe.
    await drag(z2.cx + 100, z2.cy, z2.cx - 40, z2.cy + 30);
    await sleep(150);
    let z3 = await zs(pg);
    check('zoom phone: a one-finger drag pans the zoomed picture', near(z3.x, z2.x - 140, 2) && near(z3.y, z2.y + 30, 2), JSON.stringify({ from: [z2.x, z2.y], to: [z3.x, z3.y] }));
    check('zoom phone: the pan is not a swipe (same picture)', z3.on === 4 && z3.open);
    await drag(z2.cx - 150, z2.cy, z2.cx + 200, z2.cy);
    await drag(z2.cx - 150, z2.cy, z2.cx + 200, z2.cy);
    z3 = await zs(pg);
    const mx = (z3.fw * z3.s - z3.vw) / 2;
    check('zoom phone: the pan is held at the picture\'s edge, still on the same picture', near(z3.x, mx, 1.5) && z3.on === 4, JSON.stringify({ x: z3.x, mx, on: z3.on }));
    // Pinching in again goes back to fit, never smaller.
    await pinch(z3.cx, z3.cy, 120, 10);
    await sleep(150);
    z3 = await zs(pg);
    check('zoom phone: pinching in stops at fit', z3.s === 1 && z3.x === 0 && z3.on === 4 && z3.open, JSON.stringify(z3));
    await tap(z3.cx - 60, z3.cy + 20); await sleep(90); await tap(z3.cx - 60, z3.cy + 20);
    await sleep(300);
    z3 = await zs(pg);
    check('zoom phone: a double tap zooms in (2.5x)', z3.s === 2.5 && z3.on === 4 && z3.open, JSON.stringify(z3));
    await tap(z3.cx, z3.cy); await sleep(90); await tap(z3.cx, z3.cy);
    await sleep(300);
    z3 = await zs(pg);
    check('zoom phone: a second double tap goes back to fit', z3.s === 1 && z3.on === 4 && z3.open, JSON.stringify(z3));
    await drag(z3.cx - 120, z3.cy, z3.cx + 120, z3.cy);
    await sleep(150);
    z3 = await zs(pg);
    check('zoom phone: at fit a real swipe right still goes back one', z3.on === 3 && z3.s === 1, JSON.stringify(z3));
    await drag(z3.cx + 120, z3.cy, z3.cx - 120, z3.cy);
    await sleep(150);
    z3 = await zs(pg);
    check('zoom phone: and a swipe left forward one', z3.on === 4);
    await pinch(z3.cx, z3.cy, 40, 100);
    await sleep(150);
    await pg.click('.gb-ctl [data-gl-step="1"]');
    await settle(pg);
    z3 = await zs(pg);
    check('zoom phone: zoomed, Next still moves, the next picture opens whole', z3.on === 5 && z3.s === 1, JSON.stringify(z3));
    await pg.click('[data-gl-close]');
    check('zoom phone: the X closes', (await cur(pg)) === null);
    check('zoom phone: no script errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  } else console.log('SKIP  zoom phone (CDP touch is Chromium only)');
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  child.kill();
  await browser.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
