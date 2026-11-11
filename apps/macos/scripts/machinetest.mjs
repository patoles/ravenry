#!/usr/bin/env node
// The cards' and the machines' round (SelfTestRemote.swift, --screen
// remote), never on the person's hub, daemons or machines: a throwaway
// ravenryd (HOME, runtime and state folders of its own), the demo hub of the
// desktop's screenshots following it (it holds and words its checkpoints, as
// the person's board does), and a second throwaway ravenryd standing in for
// a machine called testbox, reached through a fake `ssh` that runs `ravenryd
// proxy` here with that machine's environment (as hub/tools/machines-test.mjs
// does). The board knows a project there, remote-lab, and the `claude` it
// starts there is a stand-in shell. Then the app, with its window off every
// screen, on both; it prints a line a check and leaves pictures in OUT.
//
//   node scripts/machinetest.mjs [OUT]      (after scripts/build.sh)
//
// MACHINETEST_APP names another build (default build/RavenryMac.app).
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub, freePort } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const APP = process.env.MACHINETEST_APP || path.join(MAC, 'build', 'RavenryMac.app');
const EXE = ['RavenryMac', 'Ravenry'].map((n) => path.join(APP, 'Contents', 'MacOS', n)).find((f) => fs.existsSync(f));
const RD = path.join(APP, 'Contents', 'MacOS', 'ravenryd');
if (!EXE || !fs.existsSync(RD)) { console.log(`machinetest: no app at ${APP}`); process.exit(1); }
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'macos-machinetest.'));
const OUT = path.resolve(process.argv[2] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = path.join(OUT, 'machinetest.json');
fs.rmSync(result, { force: true });

// This Mac's test daemon. Short folders: unix socket paths are short.
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvmt-'));
const user = path.join(tmp, 'user'), run = path.join(D, 'run'), state = path.join(D, 'state');
for (const d of [user, run, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
fs.writeFileSync(path.join(user, '.zshenv'), 'skip_global_compinit=1\n');
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: path.join(tmp, 'desktop') };
const daemon = spawn(RD, ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
let sock;
for (let i = 0; !sock; i++) { const f = fs.readdirSync(run).find((n) => /^ravenryd-.+\.sock$/.test(n)); if (f) sock = path.join(run, f); else { if (i > 200) throw new Error('the daemon did not start'); await sleep(50); } }

// testbox: a second daemon with its own HOME, runtime and state, behind a fake ssh.
const R = { home: path.join(D, 'rhome'), run: path.join(D, 'rrun'), state: path.join(D, 'rstate') };
for (const d of Object.values(R)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const FAKE = path.join(D, 'fakebin');
fs.mkdirSync(FAKE);
fs.symlinkSync(RD, path.join(FAKE, 'ravenryd'));
fs.symlinkSync(RD, path.join(FAKE, 'ravenry'));
// The assistant the hub starts there: a shell that says it is ready.
// It reports to the board through its pane's daemon as Claude Code's hooks do (a session start and a prompt), so the board lists it.
fs.writeFileSync(path.join(FAKE, 'claude'), `#!/bin/sh
SID=$(/usr/bin/uuidgen | tr A-Z a-z)
TR="$HOME/transcript-$SID.jsonl"
printf '{"type":"user","cwd":"%s","sessionId":"%s","timestamp":"%s","message":{"role":"user","content":"Launch the boat"}}\\n' "$PWD" "$SID" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$TR"
for ev in SessionStart UserPromptSubmit; do
  printf '{"session_id":"%s","hook_event_name":"%s","cwd":"%s","transcript_path":"%s","source":"startup","prompt":"go"}' "$SID" "$ev" "$PWD" "$TR" | ravenryd hook --assistant claude >/dev/null 2>&1
done
echo 'stand-in ready'
PS1='testbox$ ' exec /bin/sh
`, { mode: 0o755 });
fs.writeFileSync(path.join(FAKE, 'ssh'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) host=$1; shift; [ "$1" = "--" ] && shift; break ;;
  esac
done
[ "$host" = testbox ] || { echo "ssh: Could not resolve hostname $host" >&2; exit 255; }
exec env -i HOME='${R.home}' PATH='${FAKE}:/usr/bin:/bin' SHELL=/bin/sh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR='${R.run}' RAVENRY_STATE_DIR='${R.state}' SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' SSH_CLIENT='127.0.0.1 50022 22' /bin/sh -c "$*"
`, { mode: 0o755 });
const RPROJ = path.join(R.home, 'remote-lab');
fs.mkdirSync(path.join(RPROJ, '.git'), { recursive: true });
fs.writeFileSync(path.join(RPROJ, 'BRIEF.md'), '# Remote lab\n\nGoal: Launch the paper boat from another machine.\n');
// What the stand-in runs when the test types `sh ask.sh` into it (MACH-005).
fs.writeFileSync(path.join(RPROJ, 'ask.sh'), "ravenry ask 'Launch the boat from testbox?' --option 'Launch' --option 'Wait' > ans.txt 2>&1\n");
const REMOTE_ENV = { HOME: R.home, PATH: `${FAKE}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: R.run, RAVENRY_STATE_DIR: R.state };

const DEPLOYS = `version: 1
id: deploys
title: Deploys
nav: { label: Deploys, icon: ship }
source:
  folder: deploys/
  fields:
    title: { type: string }
sections:
  - view: list
    item:
      title: title
actions:
  - { label: Build, run: { argv: [/bin/sh, -c, "echo built-by-page > page-run.txt"] } }
`;
let RUNFILE = '';
const port = await freePort();
const hub = await startDemoHub({
  dir: path.join(tmp, 'hub'), port, runtime: run,
  settings: { machines: [{ name: 'testbox', host: 'testbox' }] },
  // Phone alerts on (ntfy on this Mac, which takes nothing), so a card says On your phone too (PANEL-025).
  alerts: true,
  // An HTML variant drawn as a picture (PANEL-030): Playwright's Chromium where this Mac keeps it (the test's HOME has none).
  env: { RAVENRY_DAEMON_BIN: RD, RAVENRY_SSH: path.join(FAKE, 'ssh'), MC_NO_EVENTS: '0', MC_PHONE_LAN: 'none', RAVENRY_MACHINE_RETRY_MS: '500', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') },
  prepare: ({ ROOT, MC }) => {
    const d = path.join(ROOT, 'garden-planner', '.ravenry', 'pages');
    fs.mkdirSync(path.join(d, 'deploys'), { recursive: true });
    fs.writeFileSync(path.join(d, 'deploys.page.yaml'), DEPLOYS);
    fs.writeFileSync(path.join(d, 'deploys', 'first.md'), '---\ntitle: First deploy\n---\n');
    RUNFILE = path.join(ROOT, 'garden-planner', 'page-run.txt');
    const f = path.join(MC, 'projects.json');
    const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
    reg.projects.push({ id: 'remote-lab', name: 'remote-lab', folder: RPROJ, machine: 'testbox', brief: 'BRIEF.md', workspaces: [] });
    fs.writeFileSync(f, JSON.stringify(reg, null, 2));
  },
});
const app = spawn(EXE, ['--offscreen', '--socket', sock, '--sidetest', result, '--screen', 'remote'], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_EVENTS_LOG: path.join(tmp, 'events.log'),
    RAVENRY_MAC_REMOTE: JSON.stringify({ rd: RD, env: REMOTE_ENV, rproj: RPROJ, out: OUT, runFile: RUNFILE }) },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const t0 = Date.now();
while (!exited && Date.now() - t0 < 300000) await sleep(100);
if (!exited) app.kill();
fs.writeFileSync(path.join(tmp, 'hub.log'), hub.log ? hub.log() : '');
hub.stop();
daemon.kill();
try {
  const ds = JSON.parse(execFileSync(RD, ['daemons', '--json', '--no-start'], { env: REMOTE_ENV, encoding: 'utf8' }) || '[]');
  for (const d of ds) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
} catch { /* none */ }
await sleep(300);
fs.rmSync(D, { recursive: true, force: true });
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`machinetest: no result; see ${path.join(tmp, 'app.log')}`); process.exit(1); }
for (const c of r.checks) console.log(`${c.ok ? 'pass' : 'FAIL'} ${c.name}${c.detail ? ': ' + String(c.detail).replace(/\n/g, '\\n') : ''}`);
console.log(`machinetest: ${r.checks.length} checks, ${r.failed} failed; pictures in ${OUT}, logs in ${tmp}`);
process.exit(r.failed ? 1 : 0);
