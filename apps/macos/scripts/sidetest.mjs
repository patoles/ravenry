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
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

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
const screenHub = SCREEN ? {
  plan: true, ideas: true,
  extra: [{ id: 'old-notes', name: 'old-notes' }, { id: 'lighthouse', name: 'lighthouse', conversation: { sid: '1a9b0001-0000-4000-8000-0000000000aa', title: 'Lamp rotation speed', ask: 'How fast should the lamp turn?', answer: 'One turn every ten seconds, like the real one at the harbour.', ago: 600 } }],
  prepare: ({ ROOT }) => { fs.writeFileSync(path.join(ROOT, 'lighthouse', 'BRIEF.md'), LIGHTHOUSE_BRIEF); },
} : { extra: [{ id: 'old-notes', name: 'old-notes' }] };
const hub = await startDemoHub({ dir: path.join(tmp, 'hub'), port, ...screenHub });
const result = path.join(OUT, 'sidetest.json');
for (const f of [result, ...[1, 2].flatMap((n) => [`${result}.arrive-${n}`, `${result}.go-${n}`])]) fs.rmSync(f, { force: true });
const app = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen', '--socket', sock, '--sidetest', result, ...(SCREEN ? ['--screen', SCREEN] : [])], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log') },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const arrivals = [['paper-boat', 'Tilt the hull with the slope too, or keep it level?'], ['notes-app', 'The settings screen is done. Ship the beta to the testers?']];
const t0 = Date.now();
let n = 1;
while (!exited && Date.now() - t0 < 240000) {
  if (n <= 2 && fs.existsSync(`${result}.arrive-${n}`)) {
    await hub.arrive(...arrivals[n - 1]);
    fs.writeFileSync(`${result}.go-${n}`, '1');
    n++;
  }
  await sleep(50);
}
if (!exited) app.kill();
hub.stop();
daemon.kill();
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
