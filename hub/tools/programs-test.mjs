#!/usr/bin/env node
// A plain program's status on the board (docs/FEATURES.md SESS-056): a
// build or a deploy that says its state with OSC 7501 is one more session
// row of the project whose folder it runs in (server/programs.mjs).
//
// 1. In process: a pane's program read from the daemon's pane (and from an
//    older daemon's agent state), its words, the project it belongs to,
//    its sidebar row (Shell, progress, Done or Failed held in Idle), the
//    alert's kind and fixed words, and the phone app's alert carrying
//    none of the program's own text.
// 2. A test board with a real ravenryd built from this tree
//    (RAVENRYD_BIN, else ../daemon/ravenryd), in throwaway folders: zsh
//    panes with the daemon's shell integration, where stand-ins named npm
//    and make print OSC 7501 and wait on files of this test. Each step is
//    read back from GET /api/state:
//    - recipe-box: npm run deploy, working at 60% -> blocked (auth) ->
//      answered by POST /api/program/reply (the stand-in reads the line) ->
//      done: its row under recipe-box in Working, then Needs you with the
//      project, the alert in fixed words only (the Mac's notification
//      through the app's stream, and a webhook channel's text), then Done
//      held in Idle with the green dot, still there ticks later, and gone
//      once a new command starts in that shell;
//    - star-map: make release ending in error -> Failed held until
//      POST /api/program/seen, then gone, and still gone after the board
//      restarts (what was seen is kept); a make that says only working
//      and exits 1: Failed from the exit status;
//    - a program in no project's folder: a card of its own;
//    - the reply route refused (403) to curl from inside a pane, and the
//      waiting program gets nothing.
//    With --shots <dir>: headless Chromium pictures of the board at 1440
//    and the phone at 390 px, blocked, working, done and failed.
// Never a real assistant, npm or make; never the person's board or daemon.
// Usage: [RAVENRYD_BIN=../daemon/ravenryd] node tools/programs-test.mjs [--shots <dir>]
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'programs-'));
// What was seen is kept under RAVENRY_HOME: the in-process part's own.
process.env.RAVENRY_HOME = path.join(T, 'inproc');
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });
const programs = await import('../server/programs.mjs');
const sidebar = await import('../server/sidebar.mjs');
const alerts = await import('../server/alerts.mjs');
const push = await import('../server/push.mjs');

let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (ok) passed++; else failed++; };
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;

// ------------------------------------------------------------ 1. in process
const MSG = 'Waiting for the 2FA code';
const tab = (agent, extra = {}) => ({ id: 'ravenry:pabcdefg', paneId: 'pabcdefg', machine: null, cwd: '/w/recipe-box/web', shell: { state: 'running', command: 'npm run deploy' }, agent, ...extra });
{
  const r = programs.fromTab(tab({ state: 'needs_you', source: 'program', assistant: 'deploy', since: 'S', need: { kind: 'auth', message: MSG }, program: { state: 'blocked', kind: 'auth', message: MSG, app: 'deploy', since: '2026-11-22T14:09:00.000Z' } }));
  same('a blocked program from its pane', r && [r.state, r.kind, r.message, r.command, r.since], ['blocked', 'auth', MSG, 'npm run deploy', '2026-11-22T14:09:00.000Z']);
  const old = programs.fromTab(tab({ state: 'working', source: 'program', assistant: 'deploy', since: '2026-11-22T14:00:00.000Z' }));
  same('an older daemon: working from the agent state alone', old && [old.state, old.progress, old.since], ['working', null, '2026-11-22T14:00:00.000Z']);
  same('an older daemon\'s idle program: nothing', programs.fromTab(tab({ state: 'idle', source: 'program', assistant: 'deploy' })), null);
  same('a hook session\'s pane: nothing', programs.fromTab(tab({ state: 'working', source: 'hook', assistant: 'claude' })), null);
  const st = programs.fromTab(tab({ state: 'idle', source: 'daemon', assistant: 'make', program: { state: 'error', since: 'X' } }, { shell: { state: 'prompt', command: 'make check', exit_code: 1 } }));
  same('failed from the exit status: said so', st && [st.state, st.byStatus, st.exitCode, programs.reason(st, Date.now()).source], ['failed', true, 1, 'shell']);
  same('words: blocked', programs.words(r), { line: `npm run deploy: ${MSG}`, headline: MSG, quick: [], question: null, dialog: null, draft: null });
  same('words: the reason line', programs.reason({ ...r, since: new Date(Date.now() - 180000).toISOString() }, Date.now()), { source: 'program', text: 'it said it waits for you to sign in, 3 min ago' });
  const projects = [{ id: 'recipe-box', folder: '/w/recipe-box' }, { id: 'web', folder: '/w/recipe-box/web' }, { id: 'other', folder: '/w/recipe' }, { id: 'away', folder: '/w/recipe-box/web', machine: 'mini' }];
  same('its project: the deepest folder that holds it, on its machine', programs.ownerOf(r, projects).id, 'web');
  same('in no project\'s folder: none', programs.ownerOf({ ...r, cwd: '/tmp/x' }, projects), null);

  // Held until seen, kept in the file.
  const done = { ...r, state: 'done', kind: null, since: '2026-11-22T14:11:00.000Z' };
  check('done: held', programs.held(done) && programs.shown(done));
  check('seen: no longer held, and saved', programs.markSeen(done) && !programs.held(done) && fs.existsSync(programs.SEEN_FILE));
  programs._reset();
  check('seen survives a restart (read back from the file)', !programs.held(done));
  check('a later done of the same pane is held again', programs.held({ ...done, since: '2026-11-22T15:00:00.000Z' }));
  programs.prune([]);
  programs._reset();
  check('pruned with its pane gone', programs.held(done));

  // The sidebar: Shell, its progress, Done held in Idle.
  const sess = (state, program, extra = {}) => ({ surfaceId: 'ravenry:p' + state.slice(0, 7).padEnd(7, 'x'), topic: program.command, state, assistant: 'shell', program: { ...program, held: program.state === 'done' || program.state === 'failed' }, ...extra });
  const work = sess('working', { state: 'working', progress: 60, message: 'Uploading build 3 of 5', command: 'npm run deploy' });
  const fail = sess('idle', { state: 'failed', progress: null, message: 'Tests failed: 3 of 212', command: 'make release' });
  const sb = sidebar.build(sidebar.withGroups([
    { id: 'recipe-box', name: 'recipe-box', state: 'work', since: null, primary: work.surfaceId, sessions: [work] },
    { id: 'star-map', name: 'star-map', state: 'idle', since: '2026-11-22T14:10:00.000Z', primary: fail.surfaceId, sessions: [fail] },
    { id: 'weather', name: 'weather-widget', state: 'idle', since: '2026-11-20T14:10:00.000Z', primary: null, sessions: [] },
  ]));
  const rowOf = (g, id) => (sb.sections.find((s) => s.group === g) || { projects: [] }).projects.find((p) => p.id === id);
  const wr = rowOf('work', 'recipe-box');
  same('sidebar: the program\'s row under its project in Working, Shell and its progress', wr && wr.rows.map((x) => [x.name, x.assistant, x.model, x.pct, x.program, x.line]), [['npm run deploy', 'Shell', null, null, { state: 'working', progress: 60 }, 'Uploading build 3 of 5']]);
  const fr = rowOf('idle', 'star-map');
  same('sidebar: Failed held under its project in Idle', fr && fr.rows.map((x) => [x.name, x.program, x.line, x.group]), [['make release', { state: 'failed', progress: null }, 'Tests failed: 3 of 212', 'idle']]);
  same('sidebar: an idle project with nothing held is one line', rowOf('idle', 'weather').rows, []);
  same('sidebar: Idle counts the held row', sb.counts.idle, 2);

  // The alert: kind program, fixed words by its kind, never its text.
  const blocked = sess('blocked', { state: 'blocked', kind: 'auth', progress: null, message: MSG, command: 'npm run deploy --token=SECRET' }, { since: '2026-11-22T14:09:00.000Z', words: programs.words({ ...r, command: 'npm run deploy --token=SECRET' }) });
  const bp = { id: 'recipe-box', name: 'recipe-box', state: 'you', primary: blocked.surfaceId, sessions: [blocked], line: `npm run deploy --token=SECRET: ${MSG}`, headline: MSG, quick: [] };
  same('alert: the kind is program', alerts.kindOf(bp), 'program');
  same('alert: the fixed words of its kind', [alerts.kindText('program', bp), alerts.localKindText('program', bp)], ['Needs you to sign in', 'Needs you to sign in']);
  same('alert: the other kinds', ['permission', 'question', 'other'].map((k) => alerts.kindText('program', { ...bp, sessions: [{ ...blocked, program: { ...blocked.program, kind: k } }] })), ['Waiting for permission', 'Asked you a question', 'Waits for you']);
  const msg = push.projectMessage({ kind: 'program', body: alerts.kindText('program', bp), url: null }, bp);
  const flat = JSON.stringify(msg);
  check('phone app alert: title and fixed words, no message, no command line', msg.title === 'recipe-box needs you' && msg.body === 'Needs you to sign in' && msg.line === 'Needs you to sign in' && !flat.includes('2FA') && !flat.includes('SECRET') && msg.actions.length === 1 && msg.actions[0].id === 'open', flat.slice(0, 400));
}

// ------------------------------------------------------------ 2. a test board and a real ravenryd
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) {
  console.log(`SKIP  the board part: no ravenryd at ${BIN} (set RAVENRYD_BIN)`);
  finish();
}
const HOME = path.join(T, 'home');
const MC = path.join(HOME, '.ravenry');
const RECIPE = path.join(HOME, 'Projects', 'recipe-box');
const STARS = path.join(HOME, 'Projects', 'star-map');
const LOOSE = path.join(HOME, 'scratch', 'photos-sync');
const STUB = path.join(T, 'bin');
const CTL = path.join(T, 'ctl');
for (const d of [MC, RECIPE, STARS, LOOSE, STUB, CTL, path.join(HOME, '.claude', 'projects')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(RECIPE, 'BRIEF.md'), '# Recipe Box\n\nGoal: Import old recipes and publish 2.3.0.\n\nStage: Build\n');
fs.writeFileSync(path.join(STARS, 'BRIEF.md'), '# Star Map\n\nGoal: A release of star-core.\n');
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [
  { id: 'recipe-box', name: 'Recipe Box', folder: RECIPE, workspaces: [], brief: 'BRIEF.md' },
  { id: 'star-map', name: 'Star Map', folder: STARS, workspaces: [], brief: 'BRIEF.md' },
] }, null, 2));
// A webhook channel to a stub on this machine: what travels in clear.
const hooks = [];
const stubSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { hooks.push(JSON.parse(b)); } catch { hooks.push({ raw: b }); } res.writeHead(200); res.end('ok'); }); });
await new Promise((r) => stubSrv.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(MC, 'alerts.json'), JSON.stringify({ enabled: true, channel: 'webhook', telegram: {}, webhook: { url: `http://127.0.0.1:${stubSrv.address().port}/services/T0123/B0456/StubToken789` }, ntfy: { server: 'https://ntfy.sh' }, last: null, desktop: { enabled: true, last: null } }), { mode: 0o600 });
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');

// The stand-ins: `npm run deploy` and `make <target>`, each printing OSC
// 7501 as a real one would, stepping when this test writes a file.
const lib = `st() { printf '\\033]7501;%s\\033\\\\' "$1"; }
b() { printf '%s' "$1" | base64 | tr -d '\\n'; }
until_go() { while [ ! -f "$CTL/$1" ]; do sleep 0.1; done; }
`;
fs.writeFileSync(path.join(STUB, 'npm'), `#!/bin/sh
${lib}
echo "> recipe-box@2.3.0 deploy"
echo "Building 2.3.0 ... done (41 s)"
st "state=working:app=deploy:progress=60:msg=$(b 'Uploading build 3 of 5')"
until_go deploy-block
echo "The store asks for a sign-in to go on."
st "state=blocked:kind=auth:app=deploy:msg=$(b '${MSG}')"
printf 'Enter the 2FA code from your phone: '
read code
printf '%s' "$code" > "$CTL/code"
st "state=working:app=deploy:progress=90:msg=$(b 'Uploading build 5 of 5')"
until_go deploy-done
st "state=done:app=deploy:msg=$(b 'Deployed 2.3.0 to the store')"
echo "Deployed."
`, { mode: 0o755 });
fs.writeFileSync(path.join(STUB, 'make'), `#!/bin/sh
${lib}
case "$1" in
  release)
    echo "cc -O2 -c src/star.c"
    st "state=working:app=make:progress=44:msg=$(b 'Compiling 212 of 480')"
    until_go release-end
    echo "Tests failed: 3 of 212"
    st "state=error:app=make:msg=$(b 'Tests failed: 3 of 212')"
    exit 2 ;;
  check)
    st "state=working:app=make:msg=$(b 'Checking')"
    until_go check-end
    exit 1 ;;
  sync)
    st "state=working:app=sync:progress=12:msg=$(b 'Syncing 40 photos')"
    until_go sync-end
    st "state=clear"
    exit 0 ;;
esac
`, { mode: 0o755 });
// zsh with this test's stand-ins first on its PATH (after macOS's path_helper).
fs.writeFileSync(path.join(HOME, '.zshrc'), `export PATH="${STUB}:$PATH"\nexport CTL="${CTL}"\nPS1='%~ > '\n`);

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvpg-'));
const RUN = path.join(D, 'run');
const DENV = { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
const PORT = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let board = null;
let log = '';
const startBoard = () => {
  board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
    env: withStubMachine({ ...DENV, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_HUB_BIND: '127.0.0.1', RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN, MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_CODEX_HOME: path.join(HOME, '.codex'), TEST_RAVENRY: '1', MC_TEST: '1', MC_NO_AUTOSTART: '1', MC_ALERT_PRIME_MS: '0', MC_ALERT_COOLDOWN_MS: '0', MC_ALERT_BOARD_URL: `http://127.0.0.1:${PORT}/` }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  board.stdout.on('data', (d) => { log += d; });
  board.stderr.on('data', (d) => { log += d; });
};
let browser = null;
const cleanup = () => { try { if (browser) browser.close(); } catch { /* gone */ } if (board) board.kill('SIGKILL'); daemon.kill('SIGTERM'); stubSrv.close(); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
startBoard();
const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}
const proj = (s, id) => s && s.projects.find((p) => p.id === id);
const sessOf = (s, id, sid) => { const p = proj(s, id); return p && p.sessions.find((x) => x.surfaceId === sid); };
const rowsOf = (s, sid) => s.sidebar.sections.flatMap((sec) => sec.projects.flatMap((p) => p.rows.filter((r) => r.surfaceId === sid).map((r) => ({ group: sec.group, project: p.id, ...r }))));
const ready = await until(async () => { const s = await get('/api/state'); return s.generatedAt ? s : null; }, 20000);
check('board: answers', !!ready, ready ? '' : log.slice(-600));

// The Mac app's notification stream: what a Mac notification would say.
const notes = [];
{
  const ac = new AbortController();
  process.on('exit', () => ac.abort());
  (async () => {
    try {
      const r = await fetch(`${base}/api/events?app=1&client=programs-test`, { signal: ac.signal });
      const rd = r.body.getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += Buffer.from(value).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!/^event: notify$/m.test(block)) continue;
          const n = JSON.parse(block.split('\n').find((l) => l.startsWith('data: ')).slice(6));
          notes.push(n);
          post('/api/alerts/desktop/result', { id: n.id, ok: true }).catch(() => {});
        }
      }
    } catch { /* the test ended */ }
  })();
}

const { connectSocket, daemonSockets } = await import('../../packages/node-client/index.mjs');
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { try { sock = daemonSockets(RUN)[0]?.socket || null; } catch { /* not yet */ } if (!sock) await sleep(50); }
check('the daemon is up', !!sock);
const c = await connectSocket(sock, { name: 'programs-test' });
const newShell = async (cwd) => (await c.request('pane.new', { cwd, name: path.basename(cwd), cols: 100, rows: 30 })).pane.id;
const type = (pane, line) => c.request('pane.send', { pane, input: [{ text: line + '\n', mode: 'raw' }] });
const atPrompt = async (pane) => until(async () => { const { panes } = await c.request('pane.list', {}); const p = panes.find((x) => x.id === pane); return p && p.shell && p.shell.state === 'prompt' ? p : null; }, 15000);
const go = (name) => fs.writeFileSync(path.join(CTL, name), '');

const pRecipe = await newShell(RECIPE);
const pStar = await newShell(STARS);
const pLoose = await newShell(LOOSE);
const pCurl = await newShell(LOOSE);
check('four zsh panes at their prompt (the daemon\'s shell integration)', !!(await atPrompt(pRecipe)) && !!(await atPrompt(pStar)) && !!(await atPrompt(pLoose)) && !!(await atPrompt(pCurl)));
const SR = 'ravenry:' + pRecipe, SS = 'ravenry:' + pStar, SL = 'ravenry:' + pLoose;

// ---- working
await type(pRecipe, 'npm run deploy');
await type(pStar, 'make release');
await type(pLoose, 'make sync');
const sWork = await until(async () => { const s = await get('/api/state'); const a = sessOf(s, 'recipe-box', SR), b = sessOf(s, 'star-map', SS); return a && b && a.program.progress === 60 && b.program.progress === 44 && s.projects.some((p) => p.loose && p.sessions.some((x) => x.surfaceId === SL)) ? s : null; });
check('working: both programs on the board', !!sWork, sWork ? '' : log.slice(-800));
if (sWork) {
  const a = sessOf(sWork, 'recipe-box', SR);
  same('working: a session of recipe-box, Shell, its command, progress and line', [a.state, a.group, a.assistant, a.topic, a.program.state, a.program.progress, a.program.message, a.program.folder], ['working', 'work', 'shell', 'npm run deploy', 'working', 60, 'Uploading build 3 of 5', '~/Projects/recipe-box']);
  same('working: recipe-box and star-map are Working', [proj(sWork, 'recipe-box').state, proj(sWork, 'star-map').state], ['work', 'work']);
  same('working: the sidebar rows, Shell where the model is, the progress where the context is', [...rowsOf(sWork, SR), ...rowsOf(sWork, SS)].map((r) => [r.group, r.project, r.name, r.assistant, r.program, r.line]), [['work', 'recipe-box', 'npm run deploy', 'Shell', { state: 'working', progress: 60 }, 'Uploading build 3 of 5'], ['work', 'star-map', 'make release', 'Shell', { state: 'working', progress: 44 }, 'Compiling 212 of 480']]);
  same('working: the project\'s line says the program', proj(sWork, 'recipe-box').line, 'npm run deploy: Uploading build 3 of 5');
  const lc = sWork.projects.find((p) => p.loose && p.sessions.some((x) => x.surfaceId === SL));
  same('in no project\'s folder: a card of its own, named after its folder', lc && [lc.name, lc.state, lc.sessions.length, rowsOf(sWork, SL).map((r) => r.project === lc.id)], ['photos-sync', 'work', 1, [true]]);
}
if (SHOTS) await shots('working', 'recipe-box', SR);

// ---- blocked
go('deploy-block');
const sBlock = await until(async () => { const s = await get('/api/state'); return proj(s, 'recipe-box').state === 'you' ? s : null; });
check('blocked: recipe-box goes to Needs you', !!sBlock, sBlock ? '' : log.slice(-800));
if (sBlock) {
  const p = proj(sBlock, 'recipe-box');
  const a = sessOf(sBlock, 'recipe-box', SR);
  same('blocked: its session waits, kind auth, its message, the reason line', [a.state, a.group, a.program.kind, a.program.message, a.source, /^it said it waits for you to sign in/.test(a.reasons[0])], ['blocked', 'you', 'auth', MSG, 'program', true]);
  same('blocked: the project\'s primary, line and headline', [p.primary, p.line, p.headline], [SR, `npm run deploy: ${MSG}`, MSG]);
  same('blocked: the row in Needs you under recipe-box', rowsOf(sBlock, SR).map((r) => [r.group, r.project, r.program]), [['you', 'recipe-box', { state: 'blocked', progress: 60 }]]);
}
const note = await until(async () => notes.find((n) => n.projectId === 'recipe-box'), 10000);
same('blocked: the Mac notification in fixed words, on the program\'s pane', note && [note.title, note.body, note.kind, note.surfaceId], ['Recipe Box needs you', 'Needs you to sign in', 'program', SR]);
const hook = await until(async () => hooks.find((h) => JSON.stringify(h).includes('Recipe Box')), 10000);
check('blocked: the webhook\'s text says the kind\'s fixed words', !!hook && JSON.stringify(hook).includes('Needs you to sign in'), JSON.stringify(hook));
check('no alert carries the program\'s own words or its command line', ![...notes, ...hooks].some((x) => /2FA|Uploading|npm run|Deployed|Tests failed|Compiling/.test(JSON.stringify(x))), JSON.stringify([...notes, ...hooks]).slice(0, 400));
if (SHOTS) await shots('blocked', 'recipe-box', SR);

// The person-only route: refused to a program in a pane, and nothing typed.
await type(pCurl, `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'X-Ravenry: 1' -d '{"projectId":"recipe-box","surfaceId":"${SR}","text":"999999"}' ${base}/api/program/reply > "$CTL/curl"`);
const curl = await until(async () => { const t = fs.existsSync(path.join(CTL, 'curl')) ? fs.readFileSync(path.join(CTL, 'curl'), 'utf8') : ''; return t.length === 3 ? t : null; }, 15000);
same('reply from inside a pane: refused, 403', curl, '403');
await sleep(800);
check('and the waiting program got nothing', !fs.existsSync(path.join(CTL, 'code')));
// The person's reply from the board.
const bad = await post('/api/program/reply', { projectId: 'recipe-box', surfaceId: 'ravenry:pzzzzzzz', text: '1' });
same('reply to a program not on the board: 404', bad.status, 404);
const rep = await post('/api/program/reply', { projectId: 'recipe-box', surfaceId: SR, text: '424242' });
same('reply from the board: 200', rep.status, 200);
const code = await until(async () => (fs.existsSync(path.join(CTL, 'code')) ? fs.readFileSync(path.join(CTL, 'code'), 'utf8') : null), 10000);
same('the program read the line typed into its pane', code, '424242');
const sBack = await until(async () => { const s = await get('/api/state'); const a = sessOf(s, 'recipe-box', SR); return a && a.program.state === 'working' && a.program.progress === 90 ? s : null; });
check('answered: back to Working, 90%', !!sBack && proj(sBack, 'recipe-box').state === 'work');

// ---- done, held until a new command
go('deploy-done');
const sDone = await until(async () => { const s = await get('/api/state'); const a = sessOf(s, 'recipe-box', SR); return a && a.program.state === 'done' ? s : null; });
check('done: shown', !!sDone, sDone ? '' : log.slice(-600));
if (sDone) {
  const p = proj(sDone, 'recipe-box');
  same('done: the project back to its own state (idle), the row held in Idle with Done and its line', [p.state, rowsOf(sDone, SR).map((r) => [r.group, r.project, r.program, r.line])], ['idle', [['idle', 'recipe-box', { state: 'done', progress: null }, 'Deployed 2.3.0 to the store']]]);
  same('done: the green dot by its name', p.flags.filter((f) => f.kind === 'done').map((f) => f.title), ['npm run deploy is done']);
}

// ---- failed, held until seen
go('release-end');
const sFail = await until(async () => { const s = await get('/api/state'); const a = sessOf(s, 'star-map', SS); return a && a.program.state === 'failed' ? s : null; });
check('failed: shown', !!sFail);
if (sFail) {
  same('failed: its row held in Idle with Failed and the program\'s message', rowsOf(sFail, SS).map((r) => [r.group, r.project, r.program, r.line]), [['idle', 'star-map', { state: 'failed', progress: null }, 'Tests failed: 3 of 212']]);
  const a = sessOf(sFail, 'star-map', SS);
  same('failed: the page reads "From the program: it said it failed"', [a.source, /^it said it failed/.test(a.reasons[0]), proj(sFail, 'star-map').primary], ['program', true, SS]);
}
if (SHOTS) await shots('done-failed', 'star-map', SS);
await sleep(6000);
const sLater = await get('/api/state');
check('held: Done and Failed still there ticks later (6 s)', rowsOf(sLater, SR).length === 1 && rowsOf(sLater, SS).length === 1);
const seen = await post('/api/program/seen', { projectId: 'star-map', surfaceId: SS });
same('seen: 200, it was held', [seen.status, seen.body && seen.body.held], [200, true]);
const sSeen = await until(async () => { const s = await get('/api/state'); return !sessOf(s, 'star-map', SS) ? s : null; });
check('seen: the failed row is gone, star-map back to idle with no red dot', !!sSeen && rowsOf(sSeen, SS).length === 0 && proj(sSeen, 'star-map').state === 'idle' && !proj(sSeen, 'star-map').flags.some((f) => f.kind === 'failed'));
await type(pRecipe, 'true');
const sCmd = await until(async () => { const s = await get('/api/state'); return !sessOf(s, 'recipe-box', SR) ? s : null; });
check('a new command in that shell: the done row is gone', !!sCmd && rowsOf(sCmd, SR).length === 0 && !proj(sCmd, 'recipe-box').flags.some((f) => f.kind === 'done'));

// ---- failed from the exit status
await atPrompt(pStar);
await type(pStar, 'make check');
await until(async () => { const s = await get('/api/state'); const a = sessOf(s, 'star-map', SS); return a && a.program.state === 'working' ? s : null; });
go('check-end');
const sStat = await until(async () => { const s = await get('/api/state'); const a = sessOf(s, 'star-map', SS); return a && a.program.state === 'failed' ? s : null; });
const ast = sStat && sessOf(sStat, 'star-map', SS);
same('it said only working, then exit 1: Failed from the shell\'s status', ast && [ast.source, /^its command ended with status 1/.test(ast.reasons[0]), ast.program.exitCode], ['shell', true, 1]);

// ---- seen kept across a restart of the board
go('sync-end');
await until(async () => { const s = await get('/api/state'); return !s.projects.some((p) => p.sessions.some((x) => x.surfaceId === SL)) ? s : null; });
await post('/api/program/seen', { projectId: 'star-map', surfaceId: SS });
await until(async () => { const s = await get('/api/state'); return !sessOf(s, 'star-map', SS) ? s : null; });
board.kill('SIGTERM');
await new Promise((r) => board.once('exit', r));
startBoard();
const sAgain = await until(async () => { const s = await get('/api/state'); return s.generatedAt && Date.now() - Date.parse(s.generatedAt) < 3000 && s.projects.length >= 2 ? s : null; }, 20000);
await sleep(3000);
const sAfter = await get('/api/state').catch(() => null);
check('after the board restarts: a program it said clear for stays off; the seen Failed stays off', !!sAgain && !!sAfter && rowsOf(sAfter, SS).length === 0 && rowsOf(sAfter, SL).length === 0, sAfter ? JSON.stringify(rowsOf(sAfter, SS)) : log.slice(-500));
const sBlockRows = sAfter ? sAfter.sidebar.sections.flatMap((x) => x.projects.flatMap((p) => p.rows.filter((r) => r.program))) : [];
same('after the restart: no program rows left', sBlockRows.length, 0);

// ------------------------------------------------------------ pictures
// The board at 1440 and the phone's board at 390, headless, each on the
// project of the program, with the program's session chosen (#<project>/<tab>).
async function shots(name, pid, sid) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { console.log('SKIP  pictures: playwright is not installed'); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!browser) browser = await chromium.launch({ headless: true });
  for (const [w, h, tag] of [[1440, 1000, 'board'], [390, 844, 'phone']]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: 'dark' });
    await page.goto(`${base}/#${encodeURIComponent(pid)}/${encodeURIComponent(sid)}`);
    await page.waitForTimeout(2500);
    const f = path.join(SHOTS, `${name}-${tag}-${w}.png`);
    await page.screenshot({ path: f });
    console.log(`SHOT  ${f}`);
    await page.close();
  }
}

finish();
function finish() {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* left for a look */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
