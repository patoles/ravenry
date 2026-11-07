// Proves the switch from the npm board and the way back, on the hub's side
// (server/npmswitch.mjs), with a copy of the npm board's layout under .tmp:
// its package in node_modules/ravenry-app, its hooks in Claude Code's and
// Codex's settings as its setup writes them, its ideas.json with a picture,
// a mockup and an archived idea. No board runs and no launchd command runs
// (apps/desktop/tools/npm-switch-test.mjs runs the real npm board 0.4.0 and
// the packaged app on macOS).
//
//   - an npm copy's hooks are Ravenry's: the app's setup rewrites them in
//     place instead of adding a second set (each event recorded once)
//   - detect finds the npm board by its hooks, and not the app's own
//   - the ideas move waits while another board's board.json names a live
//     process, and runs once it is gone
//   - switch: a backup of the data and the hook settings, the hooks moved to
//     this copy with ravenryd, switch.json saying what was done
//   - back: ideas.json written again from the folder (an idea made after
//     the switch included, its picture and the mockups back in ideas/), the
//     folder set aside, the hooks and Codex's trust entries exactly the npm
//     board's again; and a second switch moves the ideas again
import './test-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'npmswitch-'));
const HOME = path.join(T, 'home');
const DATA = path.join(HOME, '.ravenry');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
process.env.HOME = HOME;
process.env.RAVENRY_HOME = DATA;
process.env.MC_CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
process.env.MC_CODEX_HOME = path.join(HOME, '.codex');
process.env.MC_CODEX = '1';
// Never the real board's port, and no launchd.
process.env.PORT = '1';
process.env.RAVENRY_LAUNCHCTL = '/usr/bin/false';

// The npm board's copy, as `npm i -g ravenry-app` lays it out.
const NPM = path.join(T, 'npm', 'lib', 'node_modules', 'ravenry-app');
fs.mkdirSync(path.join(NPM, 'hooks'), { recursive: true });
fs.mkdirSync(path.join(NPM, 'bin'), { recursive: true });
fs.writeFileSync(path.join(NPM, 'package.json'), JSON.stringify({ name: 'ravenry-app', version: '0.4.0' }));
for (const f of ['hooks/events.mjs', 'hooks/handoff-stop.mjs', 'bin/ravenry.mjs']) fs.writeFileSync(path.join(NPM, f), '// stand-in\n');
const NODE = process.execPath;
const BIN = path.join(T, 'bin', 'ravenryd');
fs.mkdirSync(path.dirname(BIN));
fs.writeFileSync(BIN, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const hk = await import('../server/hookinstall.mjs');
const ideasfiles = await import('../server/ideasfiles.mjs');
const sw = await import('../server/npmswitch.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 500) : ''}`); if (!ok) fails++; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cmds = (json) => Object.fromEntries(Object.entries((json && json.hooks) || {}).map(([ev, l]) => [ev, l.flatMap((g) => (g.hooks || []).map((h) => h.command)).sort()]));

// The person's own settings, then the npm board's setup (its commands: no
// ELECTRON_RUN_AS_NODE, no ravenryd).
fs.writeFileSync(process.env.MC_CLAUDE_SETTINGS, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-hook', timeout: 3 }] }] } }, null, 2));
fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), 'model = "gpt"\n');
{
  const cur = hk.readSettings();
  const p = hk.plan(cur.json, { root: NPM, node: NODE, electron: false });
  hk.writeSettings(cur.file, cur.raw, p.settings);
  hk.codexWrite(hk.codexPlan({ root: NPM, node: NODE, electron: false }));
}
const claudeNpm = read(process.env.MC_CLAUDE_SETTINGS);
const codexNpm = read(path.join(HOME, '.codex', 'hooks.json'));
const configNpm = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8');
check('setup as npm writes it: the npm copy\'s commands', cmds(claudeNpm).SessionStart[0] === `${NODE} ${path.join(NPM, 'hooks', 'events.mjs')}`, JSON.stringify(cmds(claudeNpm)));

// What the person types to start the board again, from its command line.
fs.mkdirSync(path.join(T, 'npm', 'bin'), { recursive: true });
fs.symlinkSync(path.join(NPM, 'bin', 'ravenry.mjs'), path.join(T, 'npm', 'bin', 'ravenry'));
check('the command to start it again: ravenry and its arguments, through npm\'s link or the package\'s bin', sw.startCommand(`node ${path.join(T, 'npm', 'bin', 'ravenry')} --no-open`) === 'ravenry --no-open' && sw.startCommand(`${NODE} ${path.join(NPM, 'bin', 'ravenry.mjs')} serve`) === 'ravenry serve' && sw.startCommand('node /elsewhere/server.js') === 'node /elsewhere/server.js');

// 1. An npm copy's hook is Ravenry's: a dry run of the app's setup rewrites
// it, never adds a second.
check('an npm copy\'s hook (…/ravenry-app/hooks/events.mjs) is recognised as Ravenry\'s', hk.isOurs({ command: cmds(claudeNpm).SessionStart[0] }, hk.OURS[1], { root: ROOT }));
{
  const p = hk.plan(claudeNpm, { root: ROOT, ravenryd: BIN });
  const ev = cmds(p.settings).SessionStart.filter((c) => /hooks\/events\.mjs/.test(c));
  check('the app\'s setup rewrites it in place: one events hook per event', ev.length === 1 && ev[0].includes(path.join(ROOT, 'hooks', 'events.mjs')), JSON.stringify(ev));
}

// The npm board's ideas: two live (one with a picture and a mockup round),
// one archived.
fs.mkdirSync(path.join(DATA, 'ideas', 'idea-b', 'mockups'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'ideas', 'idea-a-1.png'), 'png-a');
fs.writeFileSync(path.join(DATA, 'ideas', 'idea-b', 'mockups', 'r1-a.png'), 'png-b');
const ideasNpm = { version: 1, seededAt: '2026-11-01T00:00:00.000Z', ideas: [
  { id: 'idea-a', name: 'Rain alerts', stage: 'spark', pitch: 'A note when rain starts.', status: 'Added 1 Nov.', img: 'idea-a-1.png', alt: null, thread: [{ who: 'you', text: 'hi', at: '2026-11-01T00:00:00.000Z' }], created: '2026-11-01T00:00:00.000Z', updated: '2026-11-01T00:00:00.000Z' },
  { id: 'idea-b', name: 'Wind map', stage: 'mock', pitch: 'Wind for sailors.', status: '', img: 'idea-b/mockups/r1-a.png', alt: null, thread: [], mockups: [{ n: 1 }], created: '2026-11-02T00:00:00.000Z', updated: '2026-11-02T00:00:00.000Z' },
  { id: 'idea-c', name: 'Pollen count', stage: 'park', pitch: '', status: '', img: null, alt: null, thread: [], archived: true, created: '2026-11-03T00:00:00.000Z', updated: '2026-11-03T00:00:00.000Z' },
] };
fs.writeFileSync(path.join(DATA, 'ideas.json'), JSON.stringify(ideasNpm, null, 2) + '\n');
fs.writeFileSync(path.join(DATA, 'projects.json'), JSON.stringify({ version: 1, settings: { handoffThreshold: 55 }, projects: [] }, null, 2));

// 2. detect: the npm board by its hooks; no board, no login start here.
let d = await sw.detect();
check('detect: the npm board is found by its hooks', d.npm && !d.board && d.hooks.claude.length === 6 && d.hooks.codex.length === 7 && d.copy && d.copy.root === fs.realpathSync(NPM) && d.copy.version === '0.4.0' && d.copy.node === NODE, JSON.stringify({ npm: d.npm, board: d.board, n: [d.hooks.claude.length, d.hooks.codex.length], copy: d.copy }));

// A board is this data's only when this data's board.json names it: a
// board answering on a port with "~/.ravenry" (any home's) is not taken.
{
  const http = await import('node:http');
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ projects: [], registryPath: '~/.ravenry/projects.json' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  process.env.PORT = String(port);
  const none = await sw.findBoard();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(DATA, 'board.json'), JSON.stringify({ port, pid: sleeper.pid }));
  const notHolder = await sw.findBoard();
  fs.writeFileSync(path.join(DATA, 'board.json'), JSON.stringify({ port, pid: process.pid }));
  const named = await sw.findBoard();
  check('a board is found only through this data\'s board.json, and only the process holding its port', none === null && (process.platform !== 'darwin' || notHolder === null) && named && named.pid === process.pid && named.port === port, JSON.stringify({ none, notHolder, named }));
  sleeper.kill('SIGKILL');
  fs.rmSync(path.join(DATA, 'board.json'));
  process.env.PORT = '1';
  await new Promise((r) => srv.close(r));
}

// 3. The ideas move waits while another board runs on this data.
const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(DATA, 'board.json'), JSON.stringify({ port: 4999, pid: other.pid }));
const quiet = { log: () => {} };
let m = ideasfiles.migrate(DATA, quiet);
check('the ideas move waits while another board\'s board.json names a live process', !m.done && /another board/.test(m.why) && !fs.existsSync(path.join(DATA, 'pages', 'ideas')), JSON.stringify(m));
other.kill('SIGKILL');
await new Promise((r) => other.on('exit', r));

// 4. The switch.
const sres = await sw.doSwitch({ ravenryd: BIN });
const rec = sw.readRecord();
check('switch: done, and switch.json says what it changed', sres.ok && rec.state === 'switched' && rec.from.root === fs.realpathSync(NPM) && rec.hooks.claude.length === 6, JSON.stringify(sres).slice(0, 400));
check('switch: a stale board.json (its process gone) is removed', !fs.existsSync(path.join(DATA, 'board.json')));
const bk = path.join(DATA, rec.backup);
check('switch: the backup holds the data and the hook settings as they were', fs.readFileSync(path.join(bk, 'ravenry', 'ideas.json'), 'utf8') === JSON.stringify(ideasNpm, null, 2) + '\n' && fs.existsSync(path.join(bk, 'ravenry', 'ideas', 'idea-b', 'mockups', 'r1-a.png')) && JSON.stringify(read(path.join(bk, 'outside', 'claude-settings.json'))) === JSON.stringify(claudeNpm) && fs.existsSync(path.join(bk, 'outside', 'codex-hooks.json')));
const cs = cmds(read(process.env.MC_CLAUDE_SETTINGS));
check('switch: Claude Code\'s hooks run this copy with ravenryd, none the npm copy, theirs kept', !Object.values(cs).flat().some((c) => c.includes(NPM)) && cs.SessionStart.some((c) => c.endsWith(`${path.join(ROOT, 'hooks', 'events.mjs')} --ravenryd`)) && cs.SessionStart.includes(`${BIN} hook --assistant claude`) && cs.Stop.includes('their-hook') && cs.SessionStart.filter((c) => /events\.mjs/.test(c)).length === 1, JSON.stringify(cs));
check('switch: Codex\'s too', !Object.values(cmds(read(path.join(HOME, '.codex', 'hooks.json')))).flat().some((c) => c.includes(NPM)));
d = await sw.detect();
check('after the switch, detect finds no npm board (this copy\'s hooks are the app\'s)', !d.npm, JSON.stringify(d.hooks));

// 5. The app's hub moves the ideas, and an idea is made there.
m = ideasfiles.migrate(DATA, quiet);
check('the app\'s hub then moves the ideas', m.done && m.ideas === 2 && m.archived === 1, JSON.stringify(m));
const D = ideasfiles.dirsOf(DATA);
fs.writeFileSync(path.join(D.pictures, 'idea-n-1.png'), 'png-n');
const made = { id: 'idea-n', name: 'Made in the app', stage: 'spark', pitch: 'After the switch.', status: '', img: 'idea-n-1.png', alt: null, thread: [], created: '2026-11-07T00:00:00.000Z', updated: '2026-11-07T00:00:00.000Z' };
ideasfiles.saveIdea(made, DATA);
ideasfiles.saveBoard({ ...ideasfiles.readBoard(DATA), order: ['idea-n', ...(ideasfiles.readBoard(DATA).order || [])] }, DATA);

// 6. The way back.
const back = await sw.goBack({ log: () => {} });
check('back: done', back.ok && back.ideas.done && back.ideas.ideas === 3 && back.ideas.archived === 1, JSON.stringify(back).slice(0, 400));
const ij = read(path.join(DATA, 'ideas.json'));
const key = (x) => ({ id: x.id, name: x.name, stage: x.stage, pitch: x.pitch, status: x.status, img: x.img, archived: !!x.archived, thread: x.thread, mockups: x.mockups || null });
check('back: ideas.json has every idea as the npm board keeps them, the new one first', JSON.stringify(ij.ideas.map(key)) === JSON.stringify([made, ...ideasNpm.ideas].map(key)) && ij.seededAt === ideasNpm.seededAt, JSON.stringify(ij.ideas.map(key)));
check('back: the pictures and the mockup round are where the npm board reads them', fs.readFileSync(path.join(DATA, 'ideas', 'idea-n-1.png'), 'utf8') === 'png-n' && fs.readFileSync(path.join(DATA, 'ideas', 'idea-a-1.png'), 'utf8') === 'png-a' && fs.existsSync(path.join(DATA, 'ideas', 'idea-b', 'mockups', 'r1-a.png')));
check('back: the folder and the ideas.json it replaced are kept aside', !fs.existsSync(D.dir) && fs.existsSync(path.join(back.ideas.backup, 'pages-ideas', '.ravenry', 'migrated.json')) && fs.existsSync(path.join(back.ideas.backup, 'ideas.json')));
check('back: Claude Code\'s hooks are exactly the npm board\'s again', JSON.stringify(cmds(read(process.env.MC_CLAUDE_SETTINGS))) === JSON.stringify(cmds(claudeNpm)), JSON.stringify(cmds(read(process.env.MC_CLAUDE_SETTINGS))));
check('back: Codex\'s hooks and trust entries are the npm board\'s again', JSON.stringify(cmds(read(path.join(HOME, '.codex', 'hooks.json')))) === JSON.stringify(cmds(codexNpm)) && fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8') === configNpm);
check('back: switch.json says back; the npm board is found again', sw.readRecord().state === 'back' && (await sw.detect()).npm);
check('back twice is refused (nothing switched)', !(await sw.goBack()).ok);

// 7. A second switch moves the ideas again, with what the npm board changed.
const ij2 = read(path.join(DATA, 'ideas.json'));
ij2.ideas[1].pitch = 'Changed on the npm board.';
fs.writeFileSync(path.join(DATA, 'ideas.json'), JSON.stringify(ij2, null, 2) + '\n');
const s2 = await sw.doSwitch({ ravenryd: BIN });
m = ideasfiles.migrate(DATA, quiet);
const again = ideasfiles.readAll(DATA);
check('a second switch moves the ideas again, with the npm board\'s change', s2.ok && m.done && again.length === 4 && again.find((x) => x.id === 'idea-a').pitch === 'Changed on the npm board.', JSON.stringify(m));

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
