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
// --screen strip: SIDETEST_FILM_CONTENT=PATH runs that zsh script in the
// filmstrip's picked-frame panes (SelfTestFilmPick.swift) in place of
// their own scrolling output (a replayed Claude tab, say).
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
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';
import { writeLedger, recordLive } from './decisions-fixture.mjs';
import { cardFixtures, boatPng } from './cards-fixture.mjs';
import { testApp } from './testapp.mjs';
import { pagesPrepare } from './pages-fixture.mjs';
import { writeHub, writeEnv, writeArrive, trafficProxy } from './write-fixture.mjs';
import { machineCard } from '../../../hub/server/machineview.mjs';
import { SHAPES, HOSTS, BUILDS } from '../../../hub/tools/machine-shapes.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
// RavenryMac from build.sh, Ravenry in the packaged app's test twin (scripts/package.mjs; testapp.mjs).
const { app: APP, exe: EXE } = testApp(process.env.SIDETEST_APP || path.join(MAC, 'build', 'RavenryMac.app'));
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
  // Its socket is named after its version: 0.0.0-dev from build.sh, the release's in a packaged app (SIDETEST_APP).
  const found = () => { const f = fs.readdirSync(run).find((n) => /^ravenryd-.+\.sock$/.test(n)); return f ? path.join(run, f) : null; };
  for (let i = 0; !(sock = found()); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }
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
  env: { RAVENRY_SSH: '/usr/bin/false', ...(SCREEN === 'settings' ? { MC_PROJECTS_ROOT: '', PATH: `${stubCodex()}:${process.env.PATH}` } : {}), ...(SCREEN === 'settingsroot' ? { MC_PROJECTS_ROOT: lockedRoot() } : {}) },
  // --screen sessions: each session's process in its cmux tab (closable), quiet for 36 s is idle.
  ...(SESSIONS_SCREEN ? { cmuxIds: true, settings: { idleHours: 0.01 } } : {}),
  extra: [{ id: 'old-notes', name: 'old-notes' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }],
  // --screen decisions: a ledger of every shape (decisions-fixture.mjs).
  prepare: ({ ROOT, MC }) => { fs.writeFileSync(path.join(ROOT, 'lighthouse', 'BRIEF.md'), LIGHTHOUSE_BRIEF); if (SCREEN === 'decisions') writeLedger(MC); if (SCREEN === 'review') reviewRepo(ROOT); },
} : { extra: [{ id: 'old-notes', name: 'old-notes' }] };
// --screen machines: the hub carries a build to install (a few bytes, never run:
// ssh is /usr/bin/false), so Install and Update get the hub's 200 and start a job
// on the machines the screen registers after the empty page (SelfTestLearn.swift).
if (SCREEN === 'machines') {
  const dir = path.join(tmp, 'remote-builds');
  fs.mkdirSync(dir, { recursive: true });
  const raw = Buffer.from('#!/bin/sh\necho stand-in ravenryd\n');
  const builds = {};
  for (const k of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
    fs.writeFileSync(path.join(dir, `ravenryd-${k}.gz`), zlib.gzipSync(raw));
    builds[k] = { file: `ravenryd-${k}.gz`, sha256: crypto.createHash('sha256').update(raw).digest('hex'), size: raw.length };
  }
  fs.writeFileSync(path.join(dir, 'builds.json'), JSON.stringify({ version: '0.1.24', builds }));
  screenHub.env = { ...screenHub.env, RAVENRY_REMOTE_BUILDS: dir };
}
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
// The whole run (no --screen): Move here really moves (the hub follows this
// test's daemon and resumes with a stand-in of Claude), so move_here_posted
// gets the hub's 200, not "a test board does not reach the real ravenryd".
// --screen sessions too (SelfTestSessFns.swift: Move here and Keep it in for
// real); each stand-in says its pid, pane, session and folder in STAND_IN.log,
// so the driver can list it as ps would (doRequests below).
if (!SCREEN || SESSIONS_SCREEN) {
  fs.writeFileSync(STAND_IN, `#!/bin/sh\necho "$$ $RAVENRY_PANE $2 $PWD" >> '${STAND_IN}.log'\nprintf 'Claude Code (a stand-in), moved here\\n\\n> '\nexec sleep 100000\n`, { mode: 0o755 });
  Object.assign(screenHub, { runtime: run, settings: { ...(screenHub.settings || {}), launchCommand: STAND_IN }, env: { ...(screenHub.env || {}), RAVENRY_DAEMON_BIN: path.join(APP, 'Contents', 'MacOS', 'ravenryd') } });
}
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
  // paper-boat's brief names sessions in its goal, its next step, a hand-off,
  // a code span, bold and the Plan (paper-boat-7c three times, a link once).
  fs.writeFileSync(path.join(ROOT, 'paper-boat', 'BRIEF.md'), '# Paper Boat\n\nGoal: A calm little game, steered as garden-planner-3f planned it.\n\n'
    + '## Next step\n2026-11-11: Handed the sail to garden-planner-3f. Next: ask `lighthouse-4d` about the tide.\n\n'
    + '## Hand-off\nWritten by paper-boat-7c for the next session. Not links: /tmp/paper-boat-7c/notes, paper-boat-7c.json, ravenry-99 and garden-planner.\n\n'
    + '## Plan\n### Rock with the waves\n- [x] Tilt the hull\n- [>] Ask **garden-planner-3f** about the wind\n');
}
// --screen phone: the two devices the card lists (SelfTestLearn.swift) are the
// board's own, so Rename and Sign out reach real ones (the hub's 200, not 404).
if (SCREEN === 'phone') {
  const first = screenHub.prepare;
  screenHub.prepare = (a) => {
    first?.(a);
    const at = (h) => new Date(Date.now() - h * 3600000).toISOString();
    fs.writeFileSync(path.join(a.MC, 'phone.json'), JSON.stringify({ key: 'k'.repeat(48), access: false, tokens: [
      { hash: 'a'.repeat(64), id: 'd1a2', name: 'Pixel 8', platform: 'android', app: '0.4.2', created: at(48), lastSeen: at(0.05) },
      { hash: 'b'.repeat(64), id: 'd3b4', name: null, platform: 'browser', created: at(72), lastSeen: at(26) },
    ] }), { mode: 0o600 });
  };
}
// --screen cards: the hub follows a second test daemon, the agents', whose
// panes hold real checkpoints (realCheckpoints below). The app is on the
// first only (--socket), so the agents' checkpoints reach it from the hub,
// as the fixture's cards, never as loose ones of its own daemon.
const AGENT_RUN = path.join(tmp, 'arun');
let agentSock = null;
if (SCREEN === 'cards') {
  fs.mkdirSync(AGENT_RUN, { recursive: true, mode: 0o700 });
  daemonsUp.push(spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env: { ...env, RAVENRY_RUNTIME_DIR: AGENT_RUN }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon-agents.log'), 'w')] }));
  for (let i = 0; !agentSock; i++) { const f = fs.readdirSync(AGENT_RUN).find((n) => /^ravenryd-.+\.sock$/.test(n)); if (f) agentSock = path.join(AGENT_RUN, f); else { if (i > 100) throw new Error('the agents\' daemon did not start'); await sleep(50); } }
}
if (SCREEN === 'cards') Object.assign(screenHub, { runtime: AGENT_RUN, env: { ...screenHub.env, MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: path.join(APP, 'Contents', 'MacOS', 'ravenryd') } });
if (DAEMONS) Object.assign(screenHub, { runtime: run, panes: ['recipe-box'], env: { ...screenHub.env, MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: NEW }, settings: { launchCommand: NEW_CLAUDE } });
// --screen write (write-fixture.mjs): the board in Ravenry mode on this test's daemon, the app behind a proxy that logs the hub's answers.
const WRITE = SCREEN === 'write';
if (WRITE) Object.assign(screenHub, writeHub({ APP, run, tmp }));
// --screen proofs (SelfTestProofs.swift): the audit's unproven rows on a
// board that holds what they act on: rules from two projects' memory and
// a repeated ask in two sessions' transcripts (the repeats seed, as a model
// run leaves its cluster), a slow plan stub (5 s) to press Stop in, and
// (after the start) a finished hand-off, a page to change under the
// screen, recipe-box's session at its prompt (the fake cmux's prompt box).
// Then --screen proofs2: the app again on the same board (ONB-006).
const PROOFS = SCREEN === 'proofs';
const PROOFS_FILE = path.join(OUT, 'proofs.json');
const PH = path.join(tmp, 'hub', 'home'), PROOT = path.join(PH, 'Projects');
const cpd = (folder) => path.join(PH, '.claude', 'projects', folder.replace(/[^A-Za-z0-9-]/g, '-'));
if (PROOFS) {
  const src = (id) => ({ label: id, folder: path.join(PROOT, id), memory: path.join(cpd(path.join(PROOT, id)), 'memory'), claudeMd: path.join(PROOT, id, 'CLAUDE.md'), agentsMd: path.join(PROOT, id, 'AGENTS.md') });
  const seedFile = path.join(tmp, 'repeats-seed.json');
  const first = screenHub.prepare;
  Object.assign(screenHub, {
    env: { ...screenHub.env, STUB_PLAN_DELAY_MS: '5000', MC_REPEATS_SEED: seedFile },
    settings: { ruleSources: [src('paper-boat'), src('garden-planner')] },
    prepare: (a) => {
      first(a);
      // A repeated ask: typed in a paper-boat session and a garden-planner one.
      const said = [['e1e1e1e1-0000-4000-8000-0000000000e1', 'paper-boat', 'Use pnpm, not npm, for every install here.', 50], ['e2e2e2e2-0000-4000-8000-0000000000e2', 'garden-planner', 'Again: use pnpm, not npm.', 30]];
      const refs = [];
      for (const [sid, id, text, h] of said) {
        const ts = new Date(Date.now() - h * 3600000).toISOString();
        const dir = cpd(path.join(PROOT, id));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${sid}`, sessionId: sid, timestamp: ts, cwd: path.join(PROOT, id), isSidechain: false, message: { role: 'user', content: text } }) + '\n');
        refs.push([sid, ts]);
      }
      fs.writeFileSync(seedFile, JSON.stringify({ cutoff: null, clusters: [{ id: 'use-pnpm', rule: 'Use pnpm, not npm', line: '- Use pnpm, not npm. (use-pnpm)', match: null, quote: { session: 'e1e1e1e1', excerpt: 'Use pnpm, not npm', name: 'paper-boat' }, refs }] }));
      // Rules only in paper-boat's memory.
      const mem = path.join(cpd(path.join(PROOT, 'paper-boat')), 'memory');
      fs.mkdirSync(mem, { recursive: true });
      for (const [id, text] of [['short-commits', 'Keep commit titles under 60 characters'], ['tilt-hull', 'Tilt the hull, never the deck']]) fs.writeFileSync(path.join(mem, `${id}.md`), `---\nname: ${id}\ndescription: ${text}\ntype: feedback\n---\n${text}.\n`);
    },
  });
}
// --screen pages: Rules on what the board really holds (PAGE-010): two
// repeated asks, each typed in a paper-boat and a garden-planner session (the
// repeats seed, loaded at the first look as a board loads it at its start),
// and paper-boat's memory, where the check writes its notes once it saw the
// empty state. The page's Run starts a real approval in this test's daemon,
// and its asks type into garden-planner's session at its prompt (the fake
// cmux's prompt box): every POST the screen makes gets the hub's 2xx.
const RULES_FILE = path.join(OUT, 'rules-env.json');
if (PAGES) {
  const PHP = path.join(PD, 'hub', 'home'), PR = path.join(PHP, 'Projects');
  const cpdP = (f) => path.join(PHP, '.claude', 'projects', f.replace(/[^A-Za-z0-9-]/g, '-'));
  const src = (id) => ({ label: id, folder: path.join(PR, id), memory: path.join(cpdP(path.join(PR, id)), 'memory'), claudeMd: path.join(PR, id, 'CLAUDE.md'), agentsMd: path.join(PR, id, 'AGENTS.md') });
  const seedFile = path.join(PD, 'repeats-seed.json');
  const first = screenHub.prepare;
  Object.assign(screenHub, {
    runtime: run,
    env: { ...screenHub.env, RAVENRY_DAEMON_BIN: path.join(APP, 'Contents', 'MacOS', 'ravenryd'), MC_REPEATS_SEED: seedFile },
    settings: { ruleSources: [src('paper-boat'), src('garden-planner')] },
    prepare: (a) => {
      const r = first(a);
      const said = { 'rp-run-tests': ['Run the tests before a commit, please.', 'Again: run the tests before a commit.'], 'use-pnpm': ['Use pnpm, not npm, here.', 'Use pnpm, not npm, again.'] };
      const sessions = [['f1f1f1f1-0000-4000-8000-0000000000f1', 'paper-boat', 0], ['f2f2f2f2-0000-4000-8000-0000000000f2', 'garden-planner', 1]];
      const refs = {};
      for (const [sid, id, k] of sessions) {
        const dir = cpdP(path.join(PR, id));
        fs.mkdirSync(dir, { recursive: true });
        const lines = [];
        Object.entries(said).forEach(([cid, texts], j) => {
          const ts = new Date(Date.now() - (60 - 10 * k - j) * 3600000).toISOString();
          lines.push(JSON.stringify({ type: 'user', uuid: `u-${sid}-${cid}`, sessionId: sid, timestamp: ts, cwd: path.join(PR, id), isSidechain: false, message: { role: 'user', content: texts[k] } }));
          (refs[cid] ||= []).push([sid, ts]);
        });
        fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
      }
      fs.writeFileSync(seedFile, JSON.stringify({ cutoff: null, clusters: [
        { id: 'rp-run-tests', rule: 'Run the tests before a commit', line: '- Run the tests before a commit. (run-tests)', match: null, quote: { session: 'f1f1f1f1', excerpt: 'Run the tests before a commit', name: 'paper-boat' }, refs: refs['rp-run-tests'] },
        { id: 'use-pnpm', rule: 'Use pnpm, not npm', line: '- Use pnpm, not npm. (use-pnpm)', match: null, quote: { session: 'f1f1f1f1', excerpt: 'Use pnpm, not npm', name: 'paper-boat' }, refs: refs['use-pnpm'] },
      ] }));
      return r;
    },
  });
  fs.writeFileSync(RULES_FILE, JSON.stringify({ memory: path.join(cpdP(path.join(PR, 'paper-boat')), 'memory'), global: path.join(PHP, '.claude', 'CLAUDE.md'), projectClaudeMd: path.join(PR, 'paper-boat', 'CLAUDE.md'), fake: path.join(PD, 'hub', 'fake-cmux.json') }));
}
const hub = await startDemoHub({ dir: PAGES ? path.join(PD, 'hub') : path.join(tmp, 'hub'), port, ...screenHub });
const proxy = WRITE ? await trafficProxy(hub.url, path.join(OUT, 'hub-traffic.jsonl')) : null;
// --screen sessions: the fake cmux closes a tab when asked (its Claude ends) and opens one for Reopen.
// --screen plan, review and pages: each session's cmux tab plays Claude's prompt box, so a
// message the board types there (a plan paused or resumed, review comments sent, a page's ask) is taken
// (fake-cmux "prompts", what was sent kept in its "sent"), not refused.
if (SCREEN === 'plan' || SCREEN === 'review' || PAGES) { const f = JSON.parse(fs.readFileSync(hub.fake, 'utf8')); f.prompts = Object.fromEntries((f.workspaces || []).flatMap((w) => (w.surfaces || []).map((s) => [s.id, { body: '' }]))); fs.writeFileSync(hub.fake, JSON.stringify(f)); }
if (SESSIONS_SCREEN || !SCREEN) { const f = JSON.parse(fs.readFileSync(hub.fake, 'utf8')); fs.writeFileSync(hub.fake, JSON.stringify({ ...f, closeSurfaces: true, newSurfaces: true, ...(SESSIONS_SCREEN ? { focusLog: true } : {}) })); }
// --screen sessions: a project with a brief and no earlier conversation (the project page's New session here and Open brief).
if (SESSIONS_SCREEN) { fs.mkdirSync(path.join(hub.root, 'old-notes'), { recursive: true }); fs.writeFileSync(path.join(hub.root, 'old-notes', 'BRIEF.md'), '# Old notes\n\nGoal: Keep the notes from before the app.\n'); }
// --screen sessions: what the app asks the driver for (<result>.do-N, answered in <result>.done-N):
// "cmux" a process of session `sid` in cmux (a sleep of ours, listed as ps would list it) and every
// stand-in that started, listed with its pane; then a pane the hub has not seen, so it reads the
// processes again at once. "read" the fake cmux's focus log. "arrive" a question on a session.
const ours = new Set(), sleeps = [];
let doSeen = 0;
async function doRequests() {
  const f = `${result}.do-${doSeen + 1}`;
  if (!fs.existsSync(f)) return;
  doSeen++;
  let req = {};
  try { req = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* empty */ }
  let ans = { ok: true };
  // "arrive": a question arrives on the first of these projects whose session still reports (the screen closed some).
  if (req.do === 'arrive') for (const id of req.projects || []) { try { await hub.arrive(id, req.question); ans.project = id; break; } catch (e) { (ans.errors ||= []).push(`${id}: ${e.message}`); } }
  // "unowned": a session at work in a cmux workspace whose folder no project holds (Not in a project, Add to a project);
  // "end": that session ends (its process gone, its SessionEnd), its tab closed.
  const UW = '3A000000-0000-4000-8000-0000000000B1', US = '5F000000-0000-4000-8000-0000000000B1', USID = 'f6f6f6f6-0000-4000-8000-000000000006';
  const evOf = (sid) => path.join(hub.home, '.ravenry', 'events', `${sid}.jsonl`);
  if (req.do === 'unowned') {
    const folder = path.join(hub.home, 'Scratch', 'tide-notes');
    fs.mkdirSync(folder, { recursive: true });
    const f = JSON.parse(fs.readFileSync(hub.fake, 'utf8'));
    f.workspaces.push({ id: UW, ref: 'workspace:9', title: 'tide-notes', cwd: folder, surfaces: [{ id: US, ref: 'surface:9', title: '✳ Sort the tide notes' }] });
    f.screens[US] = 'Claude Code\n\n> Sort the tide notes by harbour\n\n  Working...\n';
    fs.writeFileSync(hub.fake, JSON.stringify(f));
    const s = spawn('/bin/sleep', ['900'], { stdio: 'ignore' });
    sleeps.push(s); ours.add(s.pid);
    const ps = JSON.parse(fs.readFileSync(hub.ps, 'utf8'));
    ps.push({ pid: s.pid, ppid: 1, rssKb: 300000, startedAt: new Date().toISOString(), command: `claude --resume ${USID}`, cwd: folder, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${UW} CMUX_SURFACE_ID=${US}` });
    fs.writeFileSync(hub.ps, JSON.stringify(ps));
    const ev = (event, extra = {}) => JSON.stringify({ at: new Date().toISOString(), event, session_id: USID, cwd: folder, workspace_id: UW, surface_id: US, terminal: 'cmux', claude_pid: s.pid, ...extra });
    fs.writeFileSync(evOf(USID), [ev('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }), ev('UserPromptSubmit', { prompt: 'Sort the tide notes by harbour' })].join('\n') + '\n');
    Object.assign(ans, { project: `ws:${UW}`, surface: US, sid: USID, pid: s.pid });
  }
  if (req.do === 'end') {
    for (const s of sleeps) if (s.pid && JSON.parse(fs.readFileSync(hub.ps, 'utf8')).some((p) => p.pid === s.pid && p.cwd.endsWith('tide-notes'))) { try { s.kill(); } catch { /* gone */ } }
    fs.appendFileSync(evOf(req.sid), JSON.stringify({ at: new Date().toISOString(), event: 'SessionEnd', session_id: req.sid, reason: 'prompt_input_exit', terminal: 'cmux', workspace_id: UW, surface_id: US }) + '\n');
    const f = JSON.parse(fs.readFileSync(hub.fake, 'utf8'));
    f.workspaces = f.workspaces.filter((w) => w.id !== UW);
    fs.writeFileSync(hub.fake, JSON.stringify(f));
  }
  if (req.do === 'read') ans.text = (() => { try { return fs.readFileSync(hub.fake + '.focus.log', 'utf8'); } catch { return ''; } })();
  if (req.do === 'cmux') {
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // A stand-in a move just started: its shell may take a moment to say so.
    const fresh = () => (fs.existsSync(STAND_IN + '.log') ? fs.readFileSync(STAND_IN + '.log', 'utf8').trim().split('\n') : []).some((l) => { const pid = Number(l.split(' ')[0]); return pid && !ours.has(pid) && alive(pid); });
    for (let i = 0; req.standin && i < 100 && !fresh(); i++) await sleep(100);
    let ps = JSON.parse(fs.readFileSync(hub.ps, 'utf8')).filter((p) => !ours.has(p.pid) || alive(p.pid));
    const s = spawn('/bin/sleep', ['900'], { stdio: 'ignore' });
    sleeps.push(s);
    ours.add(s.pid);
    ps.push({ pid: s.pid, ppid: 1, rssKb: 250000, startedAt: new Date().toISOString(), command: `claude --resume ${req.sid}`, cwd: path.join(hub.root, req.project), env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=3A000000-0000-4000-8000-00000000AAAA CMUX_SURFACE_ID=5F000000-0000-4000-8000-${String(s.pid).padStart(12, '0')}` }); // ids as cmux gives them (36 characters)
    for (const l of (fs.existsSync(STAND_IN + '.log') ? fs.readFileSync(STAND_IN + '.log', 'utf8').trim().split('\n') : [])) {
      const [pid, pane, sid, cwd] = l.split(' ');
      (ans.standins ||= []).push(`${pid} ${pane} ${ours.has(Number(pid)) ? 'listed' : alive(Number(pid)) ? 'alive' : 'gone'}`);
      if (!pid || ours.has(Number(pid)) || !alive(Number(pid))) continue;
      ours.add(Number(pid));
      ps.push({ pid: Number(pid), ppid: 1, rssKb: 280000, startedAt: new Date().toISOString(), command: `claude --resume ${sid}`, cwd, env: `TERM_PROGRAM=ravenry RAVENRY_PANE=${pane}` });
      // Its hook's SessionStart, as Claude's would say it: the session is this process's now.
      fs.appendFileSync(path.join(hub.home, '.ravenry', 'events', `${sid}.jsonl`), JSON.stringify({ at: new Date().toISOString(), event: 'SessionStart', session_id: sid, cwd, source: 'resume', claude_pid: Number(pid), terminal: 'ravenry', terminal_id: pane }) + '\n');
    }
    fs.writeFileSync(hub.ps, JSON.stringify(ps));
    execFileSync(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['new', '--socket', sock, '--json', '--', '/bin/sleep', '20'], { env });
    ans.pid = s.pid;
  }
  fs.writeFileSync(`${result}.done-${doSeen}`, JSON.stringify(ans));
}
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
// --screen cards: agents in panes of the test daemon ask, propose a command, ask
// for a secret and show a pick (ravenry ask/approve/secret/pick), each waiting
// for its answer into a file; the cards' fixture keeps its words and lists
// these real ids (`real`), which the self-test answers when an answer should
// land (SelfTestCardsReal.swift); its made-up ids stay for the refusals.
const CP = path.join(tmp, 'cp');
const AGENTS = { ask: [], approve: [], secret: [], pick: [] };
async function realCheckpoints() {
  fs.mkdirSync(path.join(CP, 'bin'), { recursive: true });
  const rd = path.join(APP, 'Contents', 'MacOS', 'ravenryd');
  fs.symlinkSync(rd, path.join(CP, 'bin', 'ravenry'));
  const pics = [[0, [196, 86, 64]], [0.12, [72, 120, 190]], [-0.08, [90, 160, 96]]].map(([tilt, hull], n) => { const f = path.join(CP, `boat-${n}.png`); fs.writeFileSync(f, boatPng(tilt, hull)); return f; });
  const make = (kind, n, before, after = '') => {
    const name = `${kind}-${n}`, id = path.join(CP, `${name}.id`), out = path.join(CP, `${name}.out`);
    const sh = `export PATH=${sq(path.join(CP, 'bin'))}:/usr/bin:/bin; ${before} --no-wait ${after} > ${sq(id)} 2>&1; ravenry checkpoint "$(cat ${sq(id)})" --wait > ${sq(out)} 2>&1; echo "EXIT $?" >> ${sq(out)}; exec sleep 100000`;
    execFileSync(rd, ['new', '--socket', agentSock, '--cwd', user, '--name', name, '--json', '--', '/bin/sh', '-c', sh], { env: { ...env, RAVENRY_RUNTIME_DIR: AGENT_RUN } });
    AGENTS[kind].push({ name, idFile: id, out, file: path.join(CP, `${name}.file`) });
  };
  for (let n = 0; n < 2; n++) make('ask', n, `ravenry ask ${sq('Tilt the hull with the slope too, or keep it level?')} --option ${sq('Tilt it with the slope')} --option ${sq('Keep it level')} --option ${sq('Try both and show me')} --text`);
  for (let n = 0; n < 3; n++) make('approve', n, `ravenry approve --why ${sq('The settings screen is done.')} --warn ${sq('It publishes the beta.')}`, `-- /bin/sh -c ${sq(`echo approved-${n} > ${path.join(CP, `approve-${n}.file`)}`)}`);
  for (let n = 0; n < 3; n++) make('secret', n, `ravenry secret ${sq('Paste the Cloudflare API token for the map tiles')} --env TILES_TOKEN`, `-- /bin/sh -c ${sq(`printf %s "$TILES_TOKEN" > ${path.join(CP, `secret-${n}.file`)}`)}`);
  for (let n = 0; n < 2; n++) make('pick', n, `ravenry pick ${sq('Which hull shape for the boat?')} ${['Flat hull', 'V hull', 'Round hull'].map((l, i) => `--variant ${sq(`${l}=${pics[i]}`)}`).join(' ')}`);
  const ids = () => Object.values(AGENTS).flat().map((a) => { try { return fs.readFileSync(a.idFile, 'utf8').trim(); } catch { return ''; } });
  for (let i = 0; i < 100 && !ids().every((x) => /^c[a-z0-9]{6,}$/.test(x)); i++) await sleep(100);
  for (const a of Object.values(AGENTS).flat()) a.id = fs.readFileSync(a.idFile, 'utf8').trim();
  // The hub lists them (it follows this daemon) before the app starts.
  let listed = [];
  for (let i = 0; i < 100; i++) { const st = await hub.state(); listed = (st.checkpoints || []).map((c) => c.id); if (Object.values(AGENTS).flat().every((a) => listed.includes(a.id))) break; await sleep(200); }
  const missing = Object.values(AGENTS).flat().filter((a) => !listed.includes(a.id));
  if (missing.length) console.log(`sidetest: the hub does not list ${missing.map((a) => `${a.name} ${a.id}`).join(', ')}; it lists ${listed.join(', ') || 'none'}\n${hub.log().split('\n').filter((l) => /daemon|checkpoint|ravenryd/i.test(l)).slice(-8).join('\n')}`);
}
if (SCREEN === 'cards') {
  await realCheckpoints();
  const cps = cardFixtures(await hub.state(), path.join(hub.home, '.ravenry'));
  for (const c of cps) c.real = (AGENTS[c.kind] || []).map((a) => a.id);
  fs.writeFileSync(CARDS, JSON.stringify(cps));
}
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
// --screen alerts: an ntfy server of the person's own on this Mac (ALERT-014); what it is sent goes to ntfy-received.jsonl.
let NTFY = null;
if (SCREEN === 'alerts') {
  const http = await import('node:http');
  const log = path.join(OUT, 'ntfy-received.jsonl');
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, body: b }) + '\n'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"stand-in"}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  NTFY = { url: `http://127.0.0.1:${srv.address().port}`, log };
}
if (SCREEN === 'machines') fs.writeFileSync(FIXTURE, JSON.stringify({ ok: true, machines: SHAPES.map((m) => ({ ...m, card: machineCard(m) })), hosts: HOSTS, builds: BUILDS }));
if (PROOFS) {
  const st = await hub.state();
  const MC = path.join(hub.home, '.ravenry');
  // A hand-off finished an hour ago, read by the project's session (hub/server/handoff.mjs markers).
  const hp = st.projects.find((p) => (p.timeline || []).some((t) => t.from === 'brief') && (p.sessions || []).some((s) => s.sessionId));
  if (hp) { const sid = hp.sessions.find((s) => s.sessionId).sessionId; fs.mkdirSync(path.join(MC, 'handoffs'), { recursive: true }); fs.writeFileSync(path.join(MC, 'handoffs', `${sid}.json`), JSON.stringify({ sessionId: sid, state: 'resumed', writtenAt: new Date(Date.now() - 3900000).toISOString(), resumedAt: new Date(Date.now() - 3600000).toISOString() })); }
  // recipe-box's session at its prompt (it stopped on a question): the fake cmux's prompt box, which keeps what is typed.
  const pb = st.projects.find((p) => p.id === 'recipe-box');
  const sf = pb && (pb.sessions.find((s) => s.surfaceId === pb.primary) || pb.sessions[0])?.surfaceId;
  const fk = JSON.parse(fs.readFileSync(hub.fake, 'utf8'));
  fs.writeFileSync(hub.fake, JSON.stringify({ ...fk, prompts: { ...(fk.prompts || {}), [sf]: { body: '', sent: [] } } }));
  // A page whose item the check changes under the screen.
  const P = path.join(MC, 'pages');
  fs.mkdirSync(path.join(P, 'bugs'), { recursive: true });
  fs.writeFileSync(path.join(P, 'bugs.page.yaml'), BUGS);
  fs.writeFileSync(path.join(P, 'bugs', 'dock-clip.md'), md({ title: 'Boat clips through the dock', status: 'new', size: 3, due: '2026-11-12', tags: ['physics'] }, 'Turning left past the dock.'));
  fs.writeFileSync(CARDS, JSON.stringify(cardFixtures(st, MC)));
  fs.writeFileSync(PROOFS_FILE, JSON.stringify({
    handoffProject: hp ? hp.id : '', bugFile: path.join(P, 'bugs', 'dock-clip.md'), globalClaudeMd: path.join(hub.home, '.claude', 'CLAUDE.md'),
    memGlobal: 'short-commits', memLocal: 'tilt-hull', projectClaudeMd: path.join(hub.root, 'paper-boat', 'CLAUDE.md'),
    planProject: 'recipe-box', planBrief: path.join(hub.root, 'recipe-box', 'BRIEF.md'), fakeCmux: hub.fake, planSurface: sf || '',
  }));
  // The repeats seed loads at the first look, as a real board loads it at its start (repeatsAuto).
  for (let i = 0; i < 100; i++) { const j = await (await fetch(hub.url + '/api/rules/repeats')).json(); if (j.seeded && j.count > 0) break; await sleep(100); }
}
for (const f of [result, ...[1, 2].flatMap((n) => [`${result}.arrive-${n}`, `${result}.go-${n}`])]) fs.rmSync(f, { force: true });
for (const f of fs.readdirSync(path.dirname(result))) if (/^sidetest\.json\.(do|done)-\d+$/.test(f)) fs.rmSync(path.join(path.dirname(result), f), { force: true });
// --screen settings: the folder the Hand-off tab's Change picks for new projects (in the demo board's HOME).
// --screen settings: Codex found on the hub's PATH (a stand-in that never runs), so Skills has its row (SET-014).
function stubCodex() { const d = path.join(tmp, 'stub-bin'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); return d; }
// --screen settingsroot: the board started with MC_PROJECTS_ROOT (SET-015).
function lockedRoot() { const d = path.join(tmp, 'p'); fs.mkdirSync(d, { recursive: true }); return d; }
function settingsRoot() { const d = path.join(hub.home, 'Work'); fs.mkdirSync(d, { recursive: true }); return d; }
// --screen daemons: no --socket (every daemon of the runtime folder).
const app = spawn(EXE, ['--offscreen', ...(DAEMONS ? [] : ['--socket', sock]), '--sidetest', result, ...(SCREEN ? ['--screen', SCREEN] : [])], {
  env: { ...env, RAVENRY_HUB_URL: proxy ? proxy.url : hub.url, ...(WRITE ? { RAVENRY_MAC_WRITE: writeEnv(hub, OUT, path.join(OUT, 'hub-traffic.jsonl')) } : {}), RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log'), ...(SCREEN === 'machines' ? { RAVENRY_MAC_FIXTURE: FIXTURE } : {}), ...(SCREEN === 'cards' ? { RAVENRY_MAC_CARDS: CARDS } : {}), ...(PROOFS ? { RAVENRY_MAC_CARDS: CARDS, RAVENRY_MAC_PROOFS: PROOFS_FILE } : {}), ...(PAGES ? { RAVENRY_MAC_RULES: RULES_FILE } : {}), ...(process.env.SIDETEST_FILM_CONTENT ? { RAVENRY_MAC_FILM_CONTENT: process.env.SIDETEST_FILM_CONTENT } : {}), ...(SCREEN === 'review' ? { RAVENRY_MAC_FILES: FILES } : {}), ...(SCREEN === 'settings' ? { RAVENRY_SETTINGS_IMPORT: path.join(tmp, 'Harbour_Night.conf'), RAVENRY_SETTINGS_PROJECTS_ROOT: settingsRoot() } : {}), RAVENRY_MAC_HUB_HOME: hub.home, ...(SCREEN === 'settingsroot' ? { RAVENRY_MAC_LOCKED_ROOT: lockedRoot() } : {}), ...(NTFY ? { RAVENRY_MAC_NTFY_SERVER: NTFY.url, RAVENRY_MAC_NTFY_LOG: NTFY.log } : {}) },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const arrivals = [['paper-boat', 'Tilt the hull with the slope too, or keep it level?'], ['notes-app', 'The settings screen is done. Ship the beta to the testers?']];
const t0 = Date.now();
let n = 1;
while (!exited && Date.now() - t0 < (PAGES || WRITE ? 420000 : 240000)) {
  if (n <= 2 && fs.existsSync(`${result}.arrive-${n}`)) {
    // Decisions: an agent saves one now (inside its undo minute). --screen panel: the board goes down.
    if (PAGES) await writeFixtures(); else if (WRITE) writeArrive(hub, n); else if (SCREEN === 'decisions') await recordLive(hub.url, n); else if (DAEMONS) shells(await serve(NEW, 'daemon-new.log'), 'new'); else if (SCREEN === 'panel') hub.stop(); else await hub.arrive(...arrivals[n - 1]);
    fs.writeFileSync(`${result}.go-${n}`, '1');
    n++;
  }
  if (DAEMONS) listResumed();
  if (SESSIONS_SCREEN) await doRequests();
  await sleep(50);
}
for (const s of sleeps) { try { s.kill(); } catch { /* gone */ } }
if (!exited) app.kill();
// --screen daemons: the app again on both daemons (a launch after the
// update): its report lists every tab of both, in the saved order: the
// shells, the session moved here and the one continued.
let again = null;
if (DAEMONS) {
  const report = path.join(OUT, 'report.json');
  fs.rmSync(report, { force: true });
  const a2 = spawn(EXE, ['--offscreen'], {
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
// --screen proofs: the app again on the same board and daemon (ONB-006), and a second client's read of the marks.
// --screen termnav (SelfTestTermNav.swift): a session pane's process ends
// while Ravenry is not running, then the app again on the same board and
// daemon (--screen termnav2): that tab closes quietly, the one in front
// comes back in front, the sidebar's width is the one dragged.
let termnav2 = null;
if (SCREEN === 'termnav') {
  let note = {};
  try { note = JSON.parse(fs.readFileSync(`${result}.termnav`, 'utf8')); } catch { /* none */ }
  if (note.deadPid) { try { process.kill(note.deadPid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(1500);
  const r2 = path.join(OUT, 'sidetest-termnav2.json');
  fs.rmSync(r2, { force: true });
  const a4 = spawn(EXE, ['--offscreen', '--socket', sock, '--sidetest', r2, '--screen', 'termnav2'], { env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events-termnav2.log') }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app-termnav2.log'), 'w')] });
  let done4 = false;
  a4.on('exit', () => { done4 = true; });
  for (let i = 0; i < 1200 && !done4; i++) await sleep(100);
  if (!done4) a4.kill();
  try { termnav2 = JSON.parse(fs.readFileSync(r2, 'utf8')); } catch { /* none */ }
}
let proofs2 = null, marks2 = null;
if (PROOFS) {
  const r2 = path.join(OUT, 'sidetest-proofs2.json');
  fs.rmSync(r2, { force: true });
  const a3 = spawn(EXE, ['--offscreen', '--socket', sock, '--sidetest', r2, '--screen', 'proofs2'], { env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_CARDS: CARDS, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events2.log') }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app-proofs2.log'), 'w')] });
  let done2 = false;
  a3.on('exit', () => { done2 = true; });
  for (let i = 0; i < 1200 && !done2; i++) await sleep(100);
  if (!done2) a3.kill();
  try { proofs2 = JSON.parse(fs.readFileSync(r2, 'utf8')); } catch { /* none */ }
  try { marks2 = (await (await fetch(hub.url + '/api/onboarding')).json()).hints || null; } catch { /* none */ }
}
if (WRITE) { try { fs.writeFileSync(path.join(OUT, 'hub.log'), hub.log()); } catch { /* gone */ } proxy.close(); }
// The demo hub's own log, kept beside the app's.
try { fs.writeFileSync(path.join(tmp, 'hub.log'), hub.log()); } catch { /* none */ }
hub.stop();
daemon?.kill();
for (const d of daemonsUp) d.kill();
if (PD) fs.rmSync(PD, { recursive: true, force: true });
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`sidetest: no result; see ${path.join(tmp, 'app.log')}`); process.exit(1); }
if (PROOFS) {
  for (const c of proofs2?.checks || [{ name: 'onb_relaunch_ran', ok: false, detail: 'no result' }]) { if (c.name === 'hub_state') continue; r.checks.push(c); if (!c.ok) r.failed++; }
  const ok = marks2 && marks2.pick === true && marks2['needs-you'] === true;
  r.checks.push({ name: 'onb_second_client_reads_marks', ok: !!ok, detail: JSON.stringify(marks2) });
  if (!ok) r.failed++;
}
if (SCREEN === 'termnav') for (const c of termnav2?.checks || [{ name: 'termnav2_ran', ok: false, detail: 'no result' }]) { if (c.name === 'hub_state') continue; r.checks.push(c); if (!c.ok) r.failed++; }
// The layout file is kept by daemon: this test's daemon is not the Electron
// app's, so the window writes window-<daemon>.json, never window.json.
const files = fs.existsSync(env.RAVENRY_DESKTOP_DATA) ? fs.readdirSync(env.RAVENRY_DESKTOP_DATA) : [];
if (!SCREEN) r.checks.push({ name: 'layout_file_by_daemon', ok: files.some((f) => /^window-[0-9a-f]{12}\.json$/.test(f)) && !files.includes('window.json'), detail: files.join(', ') });
if (!SCREEN) r.failed += r.checks[r.checks.length - 1].ok ? 0 : 1;
// HUB-008: the app's quit is a line in its app.log (the test's HOME), and the hub's log says the move it was asked for.
if (!SCREEN) {
  const al = (() => { try { return fs.readFileSync(path.join(user, 'Library', 'Logs', 'Ravenry', 'app.log'), 'utf8'); } catch { return ''; } })();
  const quit = al.split('\n').filter((l) => / quit: /.test(l));
  const moves = hub.log().split('\n').filter((l) => l.startsWith('sessions: move ') && l.includes('asked by this Mac'));
  for (const [name, ok, detail] of [['applog_quit', quit.length > 0, quit.slice(-1)[0] || al.split('\n').slice(-3).join(' | ')], ['hub_log_move', moves.length > 0, moves.slice(-2).join(' | ')]]) { r.checks.push({ name, ok, detail }); if (!ok) r.failed++; }
}
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
// --screen cards: what each agent got, where it lands (its command's output, the file its program wrote).
if (SCREEN === 'cards') {
  const out = (a) => { try { return fs.readFileSync(a.out, 'utf8').trim(); } catch { return ''; } };
  const file = (a) => { try { return fs.readFileSync(a.file, 'utf8').trim(); } catch { return null; } };
  const [ask0, ask1] = AGENTS.ask, [ap0, ap1, ap2] = AGENTS.approve, [se0, se1, se2] = AGENTS.secret, [pk0, pk1] = AGENTS.pick;
  const add = (name, ok, detail) => { r.checks.push({ name, ok, detail }); if (!ok) r.failed++; };
  const say = (...as) => as.map((a) => `${a.name}: ${out(a).replace(/\n/g, ' / ').slice(0, 160)}${file(a) != null ? ` [file: ${file(a)}]` : ''}`).join(' | ');
  add('cards_agent_ask_got_option', /Try both and show me/.test(out(ask0)) && /EXIT 0/.test(out(ask0)), say(ask0));
  add('cards_agent_ask_got_words', /Tilt it, but only half the slope/.test(out(ask1)) && /EXIT 0/.test(out(ask1)), say(ask1));
  add('cards_agent_approve_ran', file(ap0) === 'approved-0', say(ap0));
  add('cards_agent_approve_refused_with_reason', file(ap1) == null && /Wait for the release notes/.test(out(ap1)), say(ap1));
  add('cards_agent_approve_refused', file(ap2) == null && /declined/.test(out(ap2)), say(ap2));
  add('cards_agent_secret_got_it', file(se0) === 'abc_tiles_9f8e7d' && !out(se0).includes('abc_tiles_9f8e7d'), say(se0));
  add('cards_agent_secret_enter_got_it', file(se1) === 'typed_then_enter', say(se1));
  add('cards_agent_secret_declined', file(se2) == null && /declined/.test(out(se2)), say(se2));
  add('cards_agent_pick_got_v_hull', /V hull/.test(out(pk0)) && /0\.3/.test(out(pk0)) && /Keep this bow, but rounder/.test(out(pk0)), say(pk0));
  add('cards_agent_pick_declined', !/V hull|Flat hull|Round hull/.test(out(pk1).split('\n')[0] || '') && /blue paper/.test(out(pk1)), say(pk1));
}
for (const c of r.checks) console.log(`${c.ok ? 'pass' : 'FAIL'} ${c.name}${c.detail ? ': ' + String(c.detail).replace(/\n/g, '\\n') : ''}`);
console.log(`sidetest: ${r.checks.length} checks, ${r.failed} failed; pictures in ${OUT}`);
process.exit(r.failed ? 1 : 0);
