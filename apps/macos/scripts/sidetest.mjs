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
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';
import { writeLedger, recordLive } from './decisions-fixture.mjs';
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

const daemon = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
const sock = path.join(run, 'ravenryd-0.0.0-dev.sock');
for (let i = 0; !fs.existsSync(sock); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }

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
  extra: [{ id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }],
} : SCREEN ? {
  plan: true, ideas: true,
  // --screen machines: ssh never reaches anything from this board.
  env: { RAVENRY_SSH: '/usr/bin/false' },
  extra: [{ id: 'old-notes', name: 'old-notes' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }],
  // --screen decisions: a ledger of every shape (decisions-fixture.mjs).
  prepare: ({ ROOT, MC }) => { fs.writeFileSync(path.join(ROOT, 'lighthouse', 'BRIEF.md'), LIGHTHOUSE_BRIEF); if (SCREEN === 'decisions') writeLedger(MC); },
} : { extra: [{ id: 'old-notes', name: 'old-notes' }] };
const hub = await startDemoHub({ dir: PAGES ? path.join(PD, 'hub') : path.join(tmp, 'hub'), port, ...screenHub });
const result = path.join(OUT, 'sidetest.json');
// --screen machines: every shape the page draws, with the hub's own cards.
const FIXTURE = path.join(OUT, 'machines-fixture.json');
if (SCREEN === 'machines') fs.writeFileSync(FIXTURE, JSON.stringify({ ok: true, machines: SHAPES.map((m) => ({ ...m, card: machineCard(m) })), hosts: HOSTS, builds: BUILDS }));
for (const f of [result, ...[1, 2].flatMap((n) => [`${result}.arrive-${n}`, `${result}.go-${n}`])]) fs.rmSync(f, { force: true });
const app = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen', '--socket', sock, '--sidetest', result, ...(SCREEN ? ['--screen', SCREEN] : [])], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log'), ...(SCREEN === 'machines' ? { RAVENRY_MAC_FIXTURE: FIXTURE } : {}) },
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
    if (PAGES) await writeFixtures(); else if (SCREEN === 'decisions') await recordLive(hub.url, n); else await hub.arrive(...arrivals[n - 1]);
    fs.writeFileSync(`${result}.go-${n}`, '1');
    n++;
  }
  await sleep(50);
}
if (!exited) app.kill();
hub.stop();
daemon.kill();
if (PD) fs.rmSync(PD, { recursive: true, force: true });
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`sidetest: no result; see ${path.join(tmp, 'app.log')}`); process.exit(1); }
// The layout file is kept by daemon: this test's daemon is not the Electron
// app's, so the window writes window-<daemon>.json, never window.json.
const files = fs.existsSync(env.RAVENRY_DESKTOP_DATA) ? fs.readdirSync(env.RAVENRY_DESKTOP_DATA) : [];
if (!SCREEN) r.checks.push({ name: 'layout_file_by_daemon', ok: files.some((f) => /^window-[0-9a-f]{12}\.json$/.test(f)) && !files.includes('window.json'), detail: files.join(', ') });
if (!SCREEN) r.failed += r.checks[r.checks.length - 1].ok ? 0 : 1;
for (const c of r.checks) console.log(`${c.ok ? 'pass' : 'FAIL'} ${c.name}${c.detail ? ': ' + String(c.detail).replace(/\n/g, '\\n') : ''}`);
console.log(`sidetest: ${r.checks.length} checks, ${r.failed} failed; pictures in ${OUT}`);
process.exit(r.failed ? 1 : 0);
