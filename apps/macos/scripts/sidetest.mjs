#!/usr/bin/env node
// The sidebar's and the panel's self-test (SelfTestBoard.swift), never on
// screen and never on the person's hub or daemon: a throwaway ravenryd
// (HOME, runtime and state folders in the repository's .tmp), the demo hub
// of the desktop's screenshots (apps/desktop/tools/demo-hub.mjs: five
// made-up projects, a fake cmux that refuses every write), then the app
// with its window off every screen on both (RAVENRY_HUB_URL). It adds the
// two arrivals the app waits on, prints a line a check, and leaves the
// pictures in OUT.
//
//   node scripts/sidetest.mjs [OUT]      (after scripts/build.sh)
//   node scripts/sidetest.mjs --screen brief [OUT]
//
// With --screen, one screen's checks only (SelfTestScreens.swift), on the
// demo hub with its running plan, its idea and the lighthouse project, whose
// brief has every shape a brief takes (LIGHTHOUSE_BRIEF below).
//
//   SIDETEST_OLD_RAVENRYD=PATH node scripts/sidetest.mjs --screen daemons [OUT]
//
// --screen daemons (SelfTestDaemons.swift): the window on two daemons, as
// after an update. An older ravenryd (PATH: a release's, 0.1.23 or later)
// runs with two shells, one busy, and the app starts on it with no
// --socket; at arrival 1 this tree's ravenryd, built as the desktop app's
// version (or SIDETEST_NEW_RAVENRYD), starts beside it with two shells of
// its own. Then the app is started again on both, and its report must list
// every shell of both as a tab, in the order the first run saved. A Claude
// stand-in runs mid-turn in a pane of the older daemon as recipe-box's
// session (it reports through that daemon's `ravenryd hook`; the demo hub
// follows the runtime folder, tells the person by this tree's ravenryd and
// lists the stand-in as the session's process); the
// panel's Move here goes to the hub's own move, which ends it and resumes
// the conversation with a stand-in launch command in a pane of the newer.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';
import { writeLedger, recordLive } from './decisions-fixture.mjs';
import { cardFixtures } from './cards-fixture.mjs';
import { pagesPrepare } from './pages-fixture.mjs';
import { machineCard } from '../../../hub/server/machineview.mjs';
import { SHAPES, HOSTS, BUILDS } from '../../../hub/tools/machine-shapes.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const APP = process.env.SIDETEST_APP || path.join(MAC, 'build', 'RavenryMac.app');
const argv = process.argv.slice(2);
const sAt = argv.indexOf('--screen');
const SCREEN = sAt >= 0 ? argv.splice(sAt, 2)[1] : null;
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'macos-sidetest.'));
const OUT = path.resolve(argv[0] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state');
for (const d of [user, run, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
fs.writeFileSync(path.join(user, '.zshenv'), 'skip_global_compinit=1\n');
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: path.join(tmp, 'desktop') };

// --screen daemons: an older daemon first, a newer one at arrival 1 (below).
const DAEMONS = SCREEN === 'daemons';
const OLD = process.env.SIDETEST_OLD_RAVENRYD;
if (DAEMONS && !OLD) throw new Error('sidetest --screen daemons: SIDETEST_OLD_RAVENRYD names an older release\'s ravenryd');
const versionOf = (bin) => JSON.parse(execFileSync(bin, ['version', '--json'], { env, encoding: 'utf8' })).version;
const daemonsUp = [];
async function serve(bin, log) {
  const v = versionOf(bin);
  const d = spawn(bin, ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, log), 'w')] });
  daemonsUp.push(d);
  const s = path.join(run, `ravenryd-${v.replace(/[^A-Za-z0-9._-]/g, '_')}.sock`);
  for (let i = 0; !fs.existsSync(s); i++) { if (i > 200) throw new Error(`the daemon ${v} did not start`); await sleep(50); }
  return { v, s, bin };
}
// Two shells in a daemon, as its tabs: one prints 30 lines a second.
const BUSY = 'i=0; while :; do i=$((i+1)); echo "busy $i the quick brown fox jumps over the lazy dog"; sleep 0.033; done';
function shells(d, tag) {
  const opt = ['--socket', d.s, '--label', 'ravenry.kind=shell', '--cwd', user, '--json'];
  execFileSync(d.bin, ['new', ...opt, '--name', `${tag}-busy`, '--', '/bin/sh', '-c', BUSY], { env });
  execFileSync(d.bin, ['new', ...opt, '--name', `${tag}-shell`, '--', '/bin/zsh', '-l'], { env });
}
const goEnv = () => Object.fromEntries(['GOCACHE', 'GOPATH', 'GOMODCACHE', 'GOROOT'].map((k, i) => [k, execFileSync('go', ['env', k], { encoding: 'utf8' }).trim()]));
// This tree's ravenryd as the next version (build.sh's way, with the version).
function buildNew() {
  if (process.env.SIDETEST_NEW_RAVENRYD) return process.env.SIDETEST_NEW_RAVENRYD;
  const ver = JSON.parse(fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'package.json'), 'utf8')).version;
  const out = path.join(tmp, 'new-ravenryd');
  execFileSync('/bin/sh', ['-c', 'pc=$(scripts/libghostty.sh) && PKG_CONFIG_PATH=$pc CGO_CPPFLAGS="-DRAVENRY_LIBGHOSTTY=$(basename "$(dirname "$(dirname "$pc")")")" go build -ldflags "-X main.version=$VER" -o "$OUT" ./cmd/ravenryd'],
    // The test's folders (the spawn guard's rule), Go's own caches as they are.
    { cwd: path.join(REPO, 'daemon'), env: { ...env, PATH: process.env.PATH, ...goEnv(), VER: ver, OUT: out }, stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}
let sock, daemon, NEW;
if (DAEMONS) {
  NEW = buildNew();
  const old = await serve(OLD, 'daemon-old.log');
  shells(old, 'old');
  sock = old.s;
} else {
  daemon = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
  sock = path.join(run, 'ravenryd-0.0.0-dev.sock');
  for (let i = 0; !fs.existsSync(sock); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }
}

const port = 47700 + Math.floor(Math.random() * 200);
// A brief with every shape: fields, headings, nested lists, a checklist of
// each mark, code, links (the web, a file beside it, a scheme never opened),
// a bare URL, a long word and a Next step of dated entries.
const LIGHTHOUSE_BRIEF = `# Lighthouse

Goal: A lighthouse model whose **lamp** turns at the real speed.
Done means: The lamp turns once every ten seconds, and the beam sweeps the rocks.

## Next step
2026-11-08: Fitted the new lamp. The beam is too narrow. Next: widen it, then test at dusk.
2026-11-07: Printed the gallery rail. It needed a second try.
2026-11-05: Started the model from the harbour photos.

## Notes
Read [the lamp makers](https://example.com/lamps) first, then [the notes](notes/lamp.md), or [mail the keeper](mailto:keeper@example.com). Tides: https://example.org/tides.
A long word: LlanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogochLlanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch.

### Parts
- The tower, in three rings
  - The inner ring, *printed* in white
  - The outer ring
- The lamp, with \`a 10 s turn\`
1. Glue
2. Paint

## Plan
- [x] Print the tower
- [>] Fit the lamp
- [?] Pick the beam colour
- [-] Drop the fog horn
- [ ] Test at dusk

\`\`\`
ravenryd serve --lamp 10s
echo "a very long line of code that goes on and on past the edge of the column to show how a code block wraps"
\`\`\`
`;
// The pages from files (--screen pages): the demo hub the Electron
// references were made on (plan, ideas, lighthouse, outside any git repo, so
// Ship shows the same projects), with a copy of the shipped pages as its
// defaults. After the five pages, the app asks for the shapes the demo has
// not (arrive-1): a board, a table, stats, a form and a document with boxes
// in pages of their own, a project's page not trusted, a page with a
// mistake under its last good version, and a copy of Plans whose default
// changed since.
const PAGES = SCREEN === 'pages';
const SESSIONS_SCREEN = SCREEN === 'sessions';
const PD = PAGES ? fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-pages-')) : null;
if (PAGES) fs.cpSync(path.join(REPO, 'hub', 'pages', 'defaults'), path.join(PD, 'defaults'), { recursive: true });
const BUGS = `version: 1
id: bugs
title: Bugs
nav: { label: Bugs, icon: bug, count: { status: [new, fixing] }, count_label: open }
source:
  folder: bugs/
  fields:
    title: { type: string, required: true }
    status: { type: enum, values: [new, fixing, fixed], default: new }
    size: { type: number, default: 1 }
    due: { type: date }
    tags: { type: list }
tabs:
  - label: Board
    count: { status: [new, fixing] }
    sections:
      - view: board
        group_by: status
        item:
          title: title
          badges: [tags]
          excerpt: body
          time: due
          actions:
            - { label: Mark fixed, set: { status: fixed }, when: { status: [new, fixing] } }
            - { label: Archive, archive: true, confirm: "Archive {title}? Undo brings it back." }
            - { label: Ask later, ask: { session: garden-planner, background: "Look at the bug {title}" } }
  - label: Table
    sections:
      - view: table
        columns: [title, status, { field: size, label: Size, align: end }, due]
        item: { actions: [{ label: Copy, copy: "{title}: {status}" }] }
  - label: Numbers
    sections:
      - view: stats
        stats:
          - { label: Open, count: { status: [new, fixing] }, note: New or fixing }
          - { label: Size, sum: size, note: Every bug }
          - { label: Next due, min: due }
actions:
  - { label: New bug, create: { status: new } }
`;
const NOTES = `version: 1
id: notes
title: Release notes
nav: { label: Notes, icon: doc }
source:
  folder: notes/
  fields:
    title: { type: string }
    kind: { type: enum, values: [release, idea] }
sections:
  - view: document
    group_by: kind
    item:
      title: title
      badges: [kind]
      actions:
        - { label: Tick, toggle: body }
`;
const BROKEN_GOOD = `version: 1
id: broken
title: Broken page
nav: { label: Broken, icon: flag }
source: { folder: broken/ }
sections:
  - view: list
    item: { title: title }
`;
const DEPLOYS = `version: 1
id: deploys
title: Deploys
nav: { label: Deploys, icon: ship }
source:
  folder: deploys/
  fields:
    title: { type: string }
    status: { type: enum, values: [waiting, done] }
sections:
  - view: list
    item:
      title: title
      badges: [status]
      actions:
        - { label: Ask, ask: { prefill: "Check {title}" } }
actions:
  - { label: Build, run: { argv: [npm, run, build] } }
`;
const md = (front, body) => `---\n${Object.entries(front).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n${body}\n`;
async function writeFixtures() {
  const P = path.join(hub.home, '.ravenry', 'pages');
  const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  w(path.join(P, 'bugs.page.yaml'), BUGS);
  w(path.join(P, 'bugs', 'dock-clip.md'), md({ title: 'Boat clips through the dock', status: 'new', size: 3, due: '2026-11-12', tags: ['physics', 'left turn'] }, 'Turning left past the dock at half speed, the bow goes inside the planks.'));
  w(path.join(P, 'bugs', 'rain-flicker.md'), md({ title: 'Rain flickers on the menu', status: 'fixing', size: 2, due: '2026-11-20', tags: ['render'] }, 'Only with the reduced motion setting on.'));
  w(path.join(P, 'bugs', 'save-lost.md'), md({ title: 'Save lost after a crash', status: 'fixed', size: 5 }, 'Fixed by writing to a temp file first.'));
  w(path.join(P, 'notes.page.yaml'), NOTES);
  w(path.join(P, 'notes', 'release-04.md'), md({ title: 'Release 0.4', kind: 'release' }, '# Release 0.4\n\n- [x] Bump the version\n- [ ] Write the changelog\n- [ ] Tag the release\n\n> Ship on a Tuesday.\n\n\`\`\`\nnpm run release\n\`\`\`'));
  w(path.join(P, 'notes', 'wish.md'), md({ title: 'A lighter boat', kind: 'idea' }, 'The boat could be **lighter** in the rain, with \`drag: 0.2\`.\n\n- [ ] Try it'));
  w(path.join(P, 'broken.page.yaml'), BROKEN_GOOD);
  w(path.join(P, 'broken', 'one.md'), md({ title: 'Still listed' }, ''));
  w(path.join(hub.root, 'garden-planner', '.ravenry', 'pages', 'deploys.page.yaml'), DEPLOYS);
  w(path.join(hub.root, 'garden-planner', '.ravenry', 'pages', 'deploys', 'first.md'), md({ title: 'First deploy', status: 'waiting' }, ''));
  // Plans customized, then its default moves on a revision.
  await sleep(2500);
  await fetch(hub.url + '/api/pages/customize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ key: 'plans' }) });
  const def = path.join(PD, 'defaults', 'plans.page.yaml');
  w(path.join(PD, 'history', 'plans-r1.page.yaml'), fs.readFileSync(def, 'utf8'));
  fs.writeFileSync(def, fs.readFileSync(def, 'utf8').replace('revision: 1', 'revision: 2').replace('    empty: No plan is running.', '    limit: 20\n    empty: No plan is running.'));
  // The good version seen, then a mistake: the page keeps it under the problem.
  w(path.join(P, 'broken.page.yaml'), BROKEN_GOOD.replace('    item:', '    sort: [titel]\n    item:'));
  await sleep(3000);
}
const screenHub = PAGES ? {
  plan: true, ideas: true, env: { RAVENRY_PAGE_DEFAULTS: path.join(PD, 'defaults') },
  // harbour-light has the lighthouse's brief (its goal in Markdown: "whose **lamp** turns"); lighthouse has none (Write the brief).
  prepare: (a) => { fs.mkdirSync(path.join(a.ROOT, 'harbour-light'), { recursive: true }); fs.writeFileSync(path.join(a.ROOT, 'harbour-light', 'BRIEF.md'), LIGHTHOUSE_BRIEF); return pagesPrepare(a); },
  extra: [{ id: 'harbour-light', name: 'harbour-light' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }],
} : SCREEN ? {
  plan: true, ideas: true,
  // --screen machines: ssh never reaches anything from this board.
  // --screen settings: the projects' folder is the registry's setting (not
  // MC_PROJECTS_ROOT), so the Hand-off tab's Change can change it.
  env: { RAVENRY_SSH: '/usr/bin/false', ...(SCREEN === 'settings' ? { MC_PROJECTS_ROOT: '' } : {}) },
  // --screen sessions: each session's process in its cmux tab (closable), quiet for 36 s is idle.
  ...(SESSIONS_SCREEN ? { cmuxIds: true, settings: { idleHours: 0.01 } } : {}),
  extra: [{ id: 'old-notes', name: 'old-notes' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }],
  // --screen decisions: a ledger of every shape (decisions-fixture.mjs).
  prepare: ({ ROOT, MC }) => { fs.writeFileSync(path.join(ROOT, 'lighthouse', 'BRIEF.md'), LIGHTHOUSE_BRIEF); if (SCREEN === 'decisions') writeLedger(MC); if (SCREEN === 'review') reviewRepo(ROOT); },
} : { extra: [{ id: 'old-notes', name: 'old-notes' }] };
// --screen review: notes-app is a git repository; its session works in a
// worktree on its own branch (as POST /api/sessions/start with worktree
// makes one), with two commits of work; the main folder has a change of the
// person's and one another session made to the same file.
const GENV = { HOME: user, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: GENV, encoding: 'utf8' }).trim();
let REVIEW = null;
function reviewRepo(ROOT) {
  const repo = path.join(ROOT, 'notes-app');
  const put = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  if (!fs.existsSync(path.join(repo, '.git'))) git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ravenry Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(repo, 'config', k, v);
  put(repo, 'app/sync.js', 'export function sync(settings) {\n  const every = 60;\n  return push(settings, every);\n}\n');
  put(repo, 'app/settings.js', 'export const defaults = { theme: "light", sync: true };\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'Notes app');
  const wt = path.join(ROOT, 'notes-app-sync-settings');
  git(repo, 'worktree', 'add', '-q', '-b', 'ravenry/sync-settings', wt, 'HEAD');
  const base = git(repo, 'rev-parse', 'HEAD');
  put(wt, 'app/sync.js', 'export function sync(settings) {\n  const every = 30;\n  if (!settings.sync) return null;\n  return push(settings, every);\n}\n');
  git(wt, 'commit', '-q', '-am', 'Sync every 30 s, and not at all when it is off');
  put(wt, 'app/settings-screen.js', 'export function settingsScreen(s) {\n  return [toggle("Sync", s.sync), choice("Theme", s.theme)];\n}\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'The settings screen');
  // In the main folder: another session's change to the same file, and the person's own.
  put(repo, 'app/sync.js', 'export function sync(settings) {\n  const every = 60;\n  log("sync");\n  return push(settings, every);\n}\n');
  put(repo, 'NOTES.md', 'Ask the testers about offline.\n');
  REVIEW = { repo, wt, base };
}
// --screen daemons: the stand-ins of Claude, on the older daemon and as the
// launch command a move resumes with.
const STAND = path.join(tmp, 'stand');
const RESUMED = path.join(STAND, 'resumed.log');
const NEW_CLAUDE = path.join(STAND, 'claude-resumed');
const NEW_PID = path.join(STAND, 'new-claude.pid');
// Each resume's session id and pane (the move's, the Continue's).
const PANES = path.join(STAND, 'resumed-panes.log');
const CONTINUED = '1a9b0001-0000-4000-8000-0000000000aa';
// The resumed stand-in's process, listed as ps would once it started.
let newListed = false;
function listResumed() {
  if (newListed || !fs.existsSync(NEW_PID)) return;
  const [pid, pane] = fs.readFileSync(NEW_PID, 'utf8').trim().split(' ');
  if (!pid || !pane) return;
  const ps = JSON.parse(fs.readFileSync(hub.ps, 'utf8'));
  ps.push({ pid: Number(pid), ppid: 1, rssKb: 280000, startedAt: new Date().toISOString(), command: `claude --resume ${OLDER.sid}`, cwd: OLDER.folder, env: `TERM_PROGRAM=ravenry RAVENRY_PANE=${pane}` });
  fs.writeFileSync(hub.ps, JSON.stringify(ps));
  newListed = true;
}
// --screen links (SelfTestLinks.swift): Claude's name files for three of the
// demo's sessions (the pids its ps lists), and lighthouse's conversation as a
// named session that ended (its events, and the name the board kept), which a
// click continues in a pane of this test's daemon with a stand-in of Claude.
const LINKS = SCREEN === 'links';
const STAND_IN = path.join(tmp, 'claude-continued');
if (LINKS) {
  fs.writeFileSync(STAND_IN, "#!/bin/sh\nprintf 'Claude Code (a stand-in), continued\\n\\n> '\nexec sleep 100000\n", { mode: 0o755 });
  const first = screenHub.prepare;
  Object.assign(screenHub, {
    runtime: run, settings: { launchCommand: STAND_IN },
    env: { ...screenHub.env, RAVENRY_DAEMON_BIN: path.join(APP, 'Contents', 'MacOS', 'ravenryd') },
    prepare: (a) => { first(a); linksPrepare(a); },
  });
}
function linksPrepare({ HOME, ROOT, MC }) {
  const dir = path.join(HOME, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const named = [[4107, 'a1a1a1a1-0000-4000-8000-000000000001', 'garden-planner', 'garden-planner-3f'], [4121, 'b2b2b2b2-0000-4000-8000-000000000002', 'paper-boat', 'paper-boat-7c'], [4128, 'c3c3c3c3-0000-4000-8000-000000000003', 'notes-app', 'notes-app-b2']];
  for (const [pid, sessionId, id, name] of named) fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: path.join(ROOT, id), startedAt: Date.now() - 3600000, kind: 'interactive', name, nameSource: 'derived' }));
  const at = (m) => new Date(Date.now() - m * 60000).toISOString();
  const cwd = path.join(ROOT, 'lighthouse');
  fs.writeFileSync(path.join(MC, 'events', `${CONTINUED}.jsonl`), [{ at: at(620), event: 'SessionStart', session_id: CONTINUED, cwd, source: 'startup', claude_pid: 4999 }, { at: at(600), event: 'SessionEnd', session_id: CONTINUED, cwd, reason: 'prompt_input_exit', claude_pid: 4999 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(MC, 'session-names.json'), JSON.stringify({ version: 1, records: [{ name: 'lighthouse-4d', sessionId: CONTINUED, pid: 4999, firstAt: Date.now() - 620 * 60000, lastAt: Date.now() - 600 * 60000 }] }));
}
if (DAEMONS) Object.assign(screenHub, { runtime: run, panes: ['recipe-box'], env: { ...screenHub.env, MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: NEW }, settings: { launchCommand: NEW_CLAUDE } });
const hub = await startDemoHub({ dir: PAGES ? path.join(PD, 'hub') : path.join(tmp, 'hub'), port, ...screenHub });
// --screen sessions: the fake cmux closes a tab when asked (its Claude ends) and opens one for Reopen.
if (SESSIONS_SCREEN) { const f = JSON.parse(fs.readFileSync(hub.fake, 'utf8')); fs.writeFileSync(hub.fake, JSON.stringify({ ...f, closeSurfaces: true, newSurfaces: true })); }
const sq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
const hookLine = (bin, S, ev, sid = S.sid) => `printf '%s' ${sq(JSON.stringify({ hook_event_name: ev, session_id: sid, cwd: S.folder, transcript_path: S.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) }))} | ${sq(bin)} hook --assistant claude >/dev/null 2>&1`;
let OLDER = null;
if (DAEMONS) {
  const S = hub.sessions['recipe-box'];
  fs.mkdirSync(STAND, { recursive: true });
  const pidFile = path.join(STAND, 'old-claude.pid');
  // Mid-turn on the older daemon: a prompt with no Stop after it.
  const old = path.join(STAND, 'claude-old');
  fs.writeFileSync(old, [`echo $$ > ${sq(pidFile)}`, hookLine(OLD, S, 'SessionStart'), hookLine(OLD, S, 'UserPromptSubmit'),
    `printf '\\033]0;Old recipe import\\007'`, `printf 'Claude Code (a stand-in) on the older ravenryd\\n\\n> Import the old recipes\\n\\n  Working...\\n'`, 'exec sleep 100000'].join('\n') + '\n');
  // The resume: logged, then it says it runs in its new pane.
  // The moved one says it started (its folder's hook, its process listed); a continued one only runs.
  fs.writeFileSync(NEW_CLAUDE, ['#!/bin/sh', `echo "$PWD|$*" >> ${sq(RESUMED)}`, `echo "$2 $RAVENRY_PANE" >> ${sq(PANES)}`,
    `if [ "$2" = ${sq(S.sid)} ]; then`, `echo "$$ $RAVENRY_PANE" > ${sq(NEW_PID)}`, hookLine(NEW, S, 'SessionStart').replace(`"session_id":"${S.sid}"`, `"session_id":"'"$2"'"`), 'fi',
    `printf 'Claude Code (a stand-in), resumed on the newer ravenryd\\n\\n> '`, 'exec sleep 100000'].join('\n') + '\n', { mode: 0o755 });
  const out = execFileSync(OLD, ['new', '--socket', sock, '--cwd', S.folder, '--name', 'Old recipe import', '--label', 'ravenry.session=claude', '--json', '--',
    '/bin/sh', '-c', `/bin/sh ${sq(old)}; exec /bin/zsh -f -i`], { env, encoding: 'utf8' });
  const j = JSON.parse(out);
  const pane = j.id || j.pane?.id;
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) { try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { await sleep(50); } }
  if (!pane || !pid) throw new Error(`the older Claude stand-in did not start: ${out}`);
  // Its process, as ps lists one in a Ravenry pane.
  const ps = JSON.parse(fs.readFileSync(hub.ps, 'utf8'));
  ps.push({ pid, ppid: 1, rssKb: 310000, startedAt: new Date(Date.now() - 120000).toISOString(), command: `claude --resume ${S.sid}`, cwd: S.folder, env: `TERM_PROGRAM=ravenry RAVENRY_PANE=${pane}` });
  fs.writeFileSync(hub.ps, JSON.stringify(ps));
  OLDER = { pane, pid, sid: S.sid, folder: S.folder };
}
const result = path.join(OUT, 'sidetest.json');
// --screen machines: every shape the page draws, with the hub's own cards.
const FIXTURE = path.join(OUT, 'machines-fixture.json');
// --screen cards: one checkpoint of each kind with the hub's words, on the demo's sessions.
const CARDS = path.join(OUT, 'cards-fixture.json');
if (SCREEN === 'cards') fs.writeFileSync(CARDS, JSON.stringify(cardFixtures(await hub.state(), path.join(hub.home, '.ravenry'))));
// --screen review: the worktree's record, as the hub keeps it, and the project's files as the hub works them out.
const FILES = path.join(OUT, 'review-files.json');
if (SCREEN === 'review') {
  const st = await hub.state();
  const p = st.projects.find((x) => x.id === 'notes-app');
  const s = p.sessions[0];
  const MC = path.join(hub.home, '.ravenry');
  const rec = { surfaceId: s.surfaceId, pane: null, machine: null, projectId: 'notes-app', repo: REVIEW.repo, folder: REVIEW.wt, cwd: REVIEW.wt, branch: 'ravenry/sync-settings', base: REVIEW.base, baseBranch: 'main', name: 'sync-settings', created_at: new Date(Date.now() - 40 * 60000).toISOString(), state: 'open' };
  fs.writeFileSync(path.join(MC, 'worktrees.json'), JSON.stringify({ version: 1, worktrees: [rec] }, null, 2));
  process.env.RAVENRY_HOME = MC;
  const { projectFiles } = await import('../../../hub/server/filesview.mjs');
  const at = (m) => new Date(Date.now() - m * 60000).toISOString();
  const touches = { pwork001: [['app/sync.js', 12], ['app/settings-screen.js', 8], ['app/settings.js', 20, true]], pmain001: [['app/sync.js', 3]] };
  const answer = await projectFiles({
    projectId: 'notes-app', folder: REVIEW.repo,
    sessions: [{ surfaceId: s.surfaceId, topic: s.topic, assistant: 'claude', pane: 'pwork001', machine: null, worktree: rec }, { surfaceId: 'offline-mode', topic: 'Offline mode', assistant: 'codex', pane: 'pmain001', machine: null, worktree: null }],
    filesOf: async (pane) => touches[pane].map(([f, m, read]) => ({ path: path.join(pane === 'pwork001' ? REVIEW.wt : REVIEW.repo, f), sources: read ? ['git'] : ['hook'], at: at(m) })),
  });
  // A file it only read: the hub's files say so (read), as the panel shows it.
  answer.sessions[0].files.push({ path: 'app/settings.js', added: 0, removed: 0, read: true });
  const { withClashes } = await import('../../../hub/server/reviewview.mjs');
  fs.writeFileSync(FILES, JSON.stringify({ path: '/api/projects/notes-app/files', answer: withClashes(answer) }));
  // That other session's change was saved elsewhere since: the main folder's sync.js is back, so the merge goes through.
  git(REVIEW.repo, 'checkout', '--', 'app/sync.js');
}
if (SCREEN === 'machines') fs.writeFileSync(FIXTURE, JSON.stringify({ ok: true, machines: SHAPES.map((m) => ({ ...m, card: machineCard(m) })), hosts: HOSTS, builds: BUILDS }));
for (const f of [result, ...[1, 2].flatMap((n) => [`${result}.arrive-${n}`, `${result}.go-${n}`])]) fs.rmSync(f, { force: true });
// --screen settings: the folder the Hand-off tab's Change picks for new projects (in the demo board's HOME).
function settingsRoot() { const d = path.join(hub.home, 'Work'); fs.mkdirSync(d, { recursive: true }); return d; }
// --screen daemons: no --socket (every daemon of the runtime folder).
const app = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen', ...(DAEMONS ? [] : ['--socket', sock]), '--sidetest', result, ...(SCREEN ? ['--screen', SCREEN] : [])], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log'), ...(SCREEN === 'machines' ? { RAVENRY_MAC_FIXTURE: FIXTURE } : {}), ...(SCREEN === 'cards' ? { RAVENRY_MAC_CARDS: CARDS } : {}), ...(SCREEN === 'review' ? { RAVENRY_MAC_FILES: FILES } : {}), ...(SCREEN === 'settings' ? { RAVENRY_SETTINGS_IMPORT: path.join(tmp, 'Harbour_Night.conf'), RAVENRY_SETTINGS_PROJECTS_ROOT: settingsRoot() } : {}) },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const arrivals = [['paper-boat', 'Tilt the hull with the slope too, or keep it level?'], ['notes-app', 'The settings screen is done. Ship the beta to the testers?']];
const t0 = Date.now();
let n = 1;
while (!exited && Date.now() - t0 < (PAGES ? 420000 : 240000)) {
  if (n <= 2 && fs.existsSync(`${result}.arrive-${n}`)) {
    // Decisions: an agent saves one now (inside its undo minute).
    if (PAGES) await writeFixtures(); else if (SCREEN === 'decisions') await recordLive(hub.url, n); else if (DAEMONS) shells(await serve(NEW, 'daemon-new.log'), 'new'); else await hub.arrive(...arrivals[n - 1]);
    fs.writeFileSync(`${result}.go-${n}`, '1');
    n++;
  }
  if (DAEMONS) listResumed();
  await sleep(50);
}
if (!exited) app.kill();
// --screen daemons: the app again on both daemons (a launch after the
// update): its report lists every tab of both, in the saved order: the
// shells, the session moved here and the one continued.
let again = null;
if (DAEMONS) {
  const report = path.join(OUT, 'report.json');
  fs.rmSync(report, { force: true });
  const a2 = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen'], {
    env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_REPORT: report }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app-again.log'), 'w')],
  });
  for (let i = 0; i < 200 && !again; i++) {
    await sleep(100);
    try { const j = JSON.parse(fs.readFileSync(report, 'utf8')); if (j.daemons?.length === 2 && j.tabs?.length >= 4) again = j; } catch {}
  }
  await sleep(1500);
  try { again = JSON.parse(fs.readFileSync(report, 'utf8')); } catch {}
  a2.kill();
}
hub.stop();
daemon?.kill();
for (const d of daemonsUp) d.kill();
if (PD) fs.rmSync(PD, { recursive: true, force: true });
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`sidetest: no result; see ${path.join(tmp, 'app.log')}`); process.exit(1); }
// The layout file is kept by daemon: this test's daemon is not the Electron
// app's, so the window writes window-<daemon>.json, never window.json.
const files = fs.existsSync(env.RAVENRY_DESKTOP_DATA) ? fs.readdirSync(env.RAVENRY_DESKTOP_DATA) : [];
if (!SCREEN) r.checks.push({ name: 'layout_file_by_daemon', ok: files.some((f) => /^window-[0-9a-f]{12}\.json$/.test(f)) && !files.includes('window.json'), detail: files.join(', ') });
if (!SCREEN) r.failed += r.checks[r.checks.length - 1].ok ? 0 : 1;
if (DAEMONS) {
  const files = fs.existsSync(env.RAVENRY_DESKTOP_DATA) ? fs.readdirSync(env.RAVENRY_DESKTOP_DATA).filter((f) => /^window.*\.json$/.test(f)) : [];
  const saved = files.length === 1 ? JSON.parse(fs.readFileSync(path.join(env.RAVENRY_DESKTOP_DATA, files[0]), 'utf8')) : {};
  const order = (saved.order || []).map((s) => s.replace(/^s:/, ''));
  const tabs = (again?.tabs || []).map((t) => t.host);
  const by = Object.fromEntries((again?.tabs || []).map((t) => [t.host, t.daemon]));
  const add = (name, ok, detail) => { r.checks.push({ name, ok, detail }); if (!ok) r.failed++; };
  add('daemons_again_both', again?.daemons?.length === 2, JSON.stringify(again?.daemons || []));
  add('daemons_again_tabs_of_both', new Set(Object.values(by)).size === 2 && tabs.length === order.length, tabs.map((h) => `${h}@${by[h]}`).join(', '));
  add('daemons_again_saved_order', tabs.join(',') === order.join(','), `saved ${order.join(',')}; restored ${tabs.join(',')}; one layout file: ${files.join(', ')}`);
  add('daemons_again_front_drawn', (again?.focused?.frames || 0) > 0, `front ${again?.front} frames ${again?.focused?.frames}`);
  // The moved session and the continued one: tabs again, each in its saved place.
  const resumedPanes = Object.fromEntries((fs.existsSync(PANES) ? fs.readFileSync(PANES, 'utf8').trim().split('\n') : []).map((l) => l.split(' ')));
  for (const [what, sid] of [['moved', OLDER.sid], ['continued', CONTINUED]]) {
    const p = resumedPanes[sid];
    add(`daemons_again_${what}_session_tab`, !!p && tabs.includes(p) && tabs.indexOf(p) === order.indexOf(p) && by[p] === versionOf(NEW),
      `pane ${p || 'none'} at ${p ? tabs.indexOf(p) : -1} (saved at ${p ? order.indexOf(p) : -1}) on ${p ? by[p] : '?'}`);
  }
  // The move: the stand-in on the older daemon ended, the conversation resumed by id in its folder.
  let alive = true; try { process.kill(OLDER.pid, 0); } catch { alive = false; }
  add('older_move_old_process_ended', !alive, `pid ${OLDER.pid}`);
  const resumed = fs.existsSync(RESUMED) ? fs.readFileSync(RESUMED, 'utf8').trim().split('\n') : [];
  const moves = resumed.filter((l) => l.endsWith(`|--resume ${OLDER.sid}`));
  add('older_move_resumed_once', moves.length === 1 && fs.realpathSync(moves[0].split('|')[0]) === fs.realpathSync(OLDER.folder), resumed.join(' / '));
  const conts = resumed.filter((l) => l.endsWith(`|--resume ${CONTINUED}`));
  add('continue_resumed_once', conts.length === 1 && conts[0].split('|')[0].endsWith(`${path.sep}lighthouse`), conts.join(' / '));
}
for (const c of r.checks) console.log(`${c.ok ? 'pass' : 'FAIL'} ${c.name}${c.detail ? ': ' + String(c.detail).replace(/\n/g, '\\n') : ''}`);
console.log(`sidetest: ${r.checks.length} checks, ${r.failed} failed; pictures in ${OUT}`);
process.exit(r.failed ? 1 : 0);
