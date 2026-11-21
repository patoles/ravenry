#!/usr/bin/env node
// Start, continue and move a session from the phone (docs/FEATURES.md
// SESS-009, SESS-010, SESS-015 to SESS-018, MACH-007, the Phone web column):
// the hub's board at 390 px in headless Chromium, signed in as a phone on the
// Mac's Wi-Fi (the board's test stand-in, hub/tools/as-phone.mjs, so every
// request meets the checks a phone meets), on a made-up board of its own:
// a throwaway HOME in the system's temp folder, its own ravenryd with a stand-in `claude` and
// `codex` that write what they were started with, hub/tools/fake-cmux.mjs as
// cmux, tools/stub-ps.mjs as ps (its processes are `sleep`s this check
// started, the only ones a move ever ends), and a machine "devbox" reached
// through a fake ssh (a second ravenryd with its own HOME). Nothing real is
// read or touched; it never opens a window.
//
//   node tools/sessions-web-check.mjs [OUT]
//
// RAVENRY_PLAYWRIGHT (a playwright index.mjs) and RAVENRY_CHROME (a Chrome
// binary) pick the browser; by default the hub's Playwright and its Chromium.
//
// It checks, each by the person's taps and where it lands:
// - the top bar's + opens New session and New project; New session is a
//   full screen (Runs on, Project, the own-copy line, Assistant, Model,
//   First message); Start posts the folder, the assistant, the model, the
//   project and the words with worktree (another session works in
//   paper-boat), and the new session's live screen opens with the hub's
//   toast; the stand-in ran in its own worktree with the words;
// - a project's New session opens it with that project picked; Runs on
//   devbox starts the stand-in on devbox (machine posted, a pane there);
// - an idle project's Last conversation: Continue this conversation resumes
//   it (`--resume <id>` in its folder) and opens it;
// - one still open in iTerm2: no Continue, Move to Ravenry ends this
//   check's process and resumes it here;
// - a session in cmux at rest: Move to Ravenry, the same; one mid-turn:
//   the band waits ("Moves to Ravenry when Claude finishes its turn in
//   cmux."), and once its turn ends the move goes;
// - the hub refuses none of it to a phone, and still refuses Add a machine
//   (MACH-010).
// Pictures at 390 x 844 in OUT: dark, and New session light too.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { freePort, lanAddress, phoneEnv, phoneProxy } from '../../../hub/tools/as-phone.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const HUBDIR = path.join(REPO, 'hub');
const T = path.join(HUBDIR, 'tools');
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'sessions-web-check'));
// In the system's temp folder: a board whose data is there may take the phone stand-in (hub/server/testphone.mjs).
const WORK = path.join(os.tmpdir(), 'ravenry-sessions-web');
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
const pw = process.env.RAVENRY_PLAYWRIGHT ? await import(process.env.RAVENRY_PLAYWRIGHT) : createRequire(path.join(HUBDIR, 'package.json'))('playwright');
const LAN = lanAddress();
if (!LAN) { console.error('This check needs a private Wi-Fi address on this Mac (only named in the Host header; nothing listens there).'); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'pass' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };
async function until(fn, ms = 15000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const MIN = 60000;
const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');

// ---- the made-up board
const HOME = path.join(WORK, 'home');
const ROOT = path.join(HOME, 'Projects');
const MC = path.join(HOME, '.ravenry');
const CLAUDE = path.join(HOME, '.claude', 'projects');
const STAND = path.join(WORK, 'standin');
const FAKESSH = path.join(WORK, 'fakessh');
const DEVBOX_HOME = path.join(WORK, 'devbox-home');
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const tmp = (p) => { const d = fs.mkdtempSync(path.join(SHORT, p)); fs.chmodSync(d, 0o700); return d; };
const RT = tmp('rvs-');
const RR = tmp('rvr-');
for (const d of [ROOT, path.join(MC, 'events'), CLAUDE, STAND, FAKESSH, DEVBOX_HOME, path.join(HOME, '.codex')]) fs.mkdirSync(d, { recursive: true });
// Signed in, as the Start screen reads it (hub/server/firstlaunch.mjs).
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' } }));
fs.writeFileSync(path.join(HOME, '.codex', 'auth.json'), '{}');
fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), '# Working rules\n');
const RAN = path.join(WORK, 'ran.log');
const script = (dir, name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
// The stand-in assistants: where and with what they started, then what is typed.
// After a second it reports SessionStart through ravenryd hook, as the
// assistants' hooks do (the resumed session's own id, else a new one).
for (const name of ['claude', 'codex']) script(STAND, name, `printf '%s|%s|%s\\n' '${name}' "$PWD" "$*" >> '${RAN}'
printf '${name} stand-in: %s\\n' "$*"
sid=$(/usr/bin/uuidgen | tr A-Z a-z); prev=''
for a in "$@"; do [ "$prev" = --resume ] || [ "$prev" = resume ] && sid="$a"; prev="$a"; done
(sleep 1; printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"startup","model":"claude-opus-5-5"}' "$sid" "$PWD" | ravenryd hook --assistant ${name} >/dev/null 2>&1 || printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"startup","model":"claude-opus-5-5"}' "$sid" "$PWD" | '${BIN}' hook --assistant ${name} >/dev/null 2>&1) &
exec cat`);
fs.symlinkSync(BIN, path.join(FAKESSH, 'ravenryd'));
const DEVBOX_ENV = { HOME: DEVBOX_HOME, PATH: `${FAKESSH}:${STAND}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RR, RAVENRY_STATE_DIR: path.join(WORK, 'devbox-state') };
script(FAKESSH, 'ssh', `while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) shift; [ "$1" = "--" ] && shift; break ;;
  esac
done
exec env -i ${Object.entries(DEVBOX_ENV).map(([k, v]) => `${k}='${v}'`).join(' ')} SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' SSH_CLIENT='127.0.0.1 50022 22' /bin/sh -c "$*"`);
const localEnv = { HOME, PATH: `${STAND}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };

// The processes a move may end: this check's own.
const holders = [];
const holder = () => { const h = spawn('/bin/sleep', ['900'], { stdio: 'ignore' }); holders.push(h); return h; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const PS = path.join(WORK, 'stub-ps.json');
const FAKE = path.join(WORK, 'fake-cmux.json');
const ps = [], workspaces = [], screens = {}, projects = [];
const RULE = '─'.repeat(60);
const git = (folder, ...a) => execFileSync('git', ['-C', folder, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', ...a], { encoding: 'utf8' });
function transcript(folder, sid, { title = null, ask, answer, m, working = false }) {
  const f = path.join(CLAUDE, slug(folder), sid + '.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const rec = (type, extra, at) => JSON.stringify({ type, cwd: folder, sessionId: sid, timestamp: at, ...extra });
  fs.writeFileSync(f, [
    ...(title ? [rec('ai-title', { aiTitle: title }, ago(m + 2))] : []),
    rec('user', { message: { role: 'user', content: ask } }, ago(m + 1)),
    rec('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], usage: { input_tokens: 8, cache_creation_input_tokens: 3000, cache_read_input_tokens: 120000, output_tokens: 300 } } }, ago(m)),
    ...(working ? [] : [rec('system', { subtype: 'turn_duration' }, ago(m))]),
  ].join('\n') + '\n');
  return f;
}
const files = {};
// A project, its folder a git repository with a brief; `cmux`: a session in a cmux tab, its process this check's.
function addProject(id, { cmux = null, k = 0 } = {}) {
  const folder = path.join(ROOT, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'BRIEF.md'), `# ${id}\n\nGoal: The ${id} project.\n\n## Hand-off\n`);
  git(folder, 'init', '-q', '-b', 'main'); git(folder, 'add', '.'); git(folder, 'commit', '-q', '-m', 'Start');
  if (!cmux) { projects.push({ id, name: id, folder, brief: 'BRIEF.md', workspaces: [] }); return folder; }
  const sf = `5F000000-0000-4000-8000-00000000000${k}`;
  const ws = `3A000000-0000-4000-8000-00000000000${k}`;
  workspaces.push({ id: ws, ref: `workspace:${k}`, title: id, cwd: folder, surfaces: [{ id: sf, ref: `surface:${k}`, title: cmux.title }] });
  screens[sf] = `❯ ${cmux.ask}\n\n⏺ ${cmux.answer}\n\n${RULE}\n❯ \n${RULE}\n`;
  projects.push({ id, name: id, folder, brief: 'BRIEF.md', workspaces: [ws] });
  const TR = transcript(folder, cmux.sid, { ask: cmux.ask, answer: cmux.answer, m: 1, working: cmux.working });
  const h = holder();
  const evFile = path.join(MC, 'events', cmux.sid + '.jsonl');
  const evLine = (event, mm, extra = {}) => JSON.stringify({ at: ago(mm), event, session_id: cmux.sid, assistant: 'claude', cwd: folder, transcript_path: TR, workspace_id: ws, surface_id: sf, terminal: 'cmux', claude_pid: h.pid, ...(event === 'Stop' ? { ends_on_question: false, background_tasks: 0 } : {}), ...(event === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : {}), ...extra });
  fs.writeFileSync(evFile, [evLine('SessionStart', 20), evLine('UserPromptSubmit', 2), ...(cmux.working ? [] : [evLine('Stop', 1)])].join('\n') + '\n');
  ps.push({ pid: h.pid, ppid: process.pid, rssKb: 400000, startedAt: ago(21), command: `claude --resume ${cmux.sid}`, cwd: folder, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${ws} CMUX_SURFACE_ID=${sf}` });
  files[id] = { evFile, evLine, TR, h, sid: cmux.sid };
  return folder;
}
const S_BOAT = 'b2b2b2b2-0000-4000-8000-000000000002';
const S_NOTES = 'c3c3c3c3-0000-4000-8000-000000000003';
const S_PORT = 'f6f6f6f6-0000-4000-8000-000000000006';
const S_MOSS = 'a7a7a7a7-0000-4000-8000-000000000007';
addProject('paper-boat', { k: 1, cmux: { sid: S_BOAT, title: '⠂ Hull tilt', ask: 'Make the hull tilt with the waves', answer: 'Tilting the hull now.', working: true } });
addProject('notes-app', { k: 2, cmux: { sid: S_NOTES, title: '✳ Sync settings', ask: 'Finish the sync settings screen', answer: 'The sync settings screen is done and the tests pass.' } });
const PORTF = addProject('portfolio');
transcript(PORTF, S_PORT, { title: 'Dark theme for the gallery', ask: 'Make the cards follow the dark theme too, and check it at phone width.', answer: 'Done. The cards and the lightbox follow the theme now, checked at 390 px. Next I can tidy the footer links.', m: 26 * 60 });
const MOSS = addProject('moss');
transcript(MOSS, S_MOSS, { title: 'Moss on the north wall', ask: 'Will it spread?', answer: 'Slowly, only where it stays damp.', m: 20 });
const mossH = holder();
ps.push({ pid: mossH.pid, ppid: process.pid, rssKb: 300000, startedAt: ago(40), command: `claude --resume ${S_MOSS}`, cwd: MOSS, env: 'TERM_PROGRAM=iTerm.app ITERM_SESSION_ID=w0t0p0:9A9A9A9A-0000-4000-8000-0000000000A9' });
for (const id of ['garden-planner', 'kite', 'trail-map']) addProject(id);
// recipe-box lives on devbox, in devbox's home.
const DEVBOX_FOLDER = path.join(DEVBOX_HOME, 'code', 'recipe-box');
fs.mkdirSync(DEVBOX_FOLDER, { recursive: true });
projects.push({ id: 'recipe-box', name: 'recipe-box', folder: DEVBOX_FOLDER, brief: 'BRIEF.md', workspaces: [], machine: 'devbox' });
fs.writeFileSync(PS, JSON.stringify(ps));
fs.writeFileSync(FAKE, JSON.stringify({ workspaces, screens }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(HOME, '.claude', 'CLAUDE.md'), backupDir: path.join(WORK, 'backups'), projectsRoot: ROOT, contextWindow: 1000000, machines: [{ name: 'devbox', host: 'devbox' }] },
  projects,
}, null, 2));

execFileSync(BIN, ['serve', '--detach'], { env: localEnv });
const PORT = await freePort();
const STANDIN = await freePort();
const hubEnv = {
  PATH: `${STAND}:${process.env.PATH}`, HOME, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '0', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
  RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'cmux,ravenry', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'),
  RAVENRY_SSH: path.join(FAKESSH, 'ssh'), RAVENRY_DAEMON_BIN: BIN, RAVENRY_MACHINE_RETRY_MS: '300',
  CMUX_BIN: path.join(T, 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE, MC_CODEX_HOME: path.join(HOME, '.codex'),
  MC_PROJECTS_ROOT: ROOT, MC_GLOBAL_CLAUDE_MD: path.join(HOME, '.claude', 'CLAUDE.md'), MC_BACKUP_DIR: path.join(WORK, 'backups'), MC_SCRATCH_ROOT: path.join(WORK, 'scratch'),
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(T, 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(WORK, 'open.jsonl'), CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  MC_PS_BIN: path.join(T, 'stub-ps.mjs'), MC_LSOF_BIN: path.join(T, 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_OSASCRIPT_BIN: path.join(T, 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(T, 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(WORK, 'osascript.jsonl'),
  RAVENRY_HUB_BIND: '127.0.0.1', MC_CLAUDE_BIN: path.join(T, 'stub-claude.mjs'), MC_PRINT_COMMAND: JSON.stringify([process.execPath, path.join(T, 'stub-claude.mjs')]),
  MC_REPEATS_COMMAND: JSON.stringify(['/usr/bin/false']), MC_COPY_COMMAND: JSON.stringify(['/usr/bin/true']), RAVENRY_HUB_NAME: 'MacBook Pro', LANG: 'en_US.UTF-8',
  ...phoneEnv(STANDIN),
};
let hubLog = '';
const hub = spawn(process.execPath, [path.join(HUBDIR, 'server', 'index.mjs')], { cwd: HOME, env: hubEnv, stdio: ['ignore', 'pipe', 'pipe'] });
hub.stdout.on('data', (d) => { hubLog += d; });
hub.stderr.on('data', (d) => { hubLog += d; });
const base = `http://127.0.0.1:${PORT}`;
const PH = `http://${LAN}:${PORT}`;
const state = async () => (await fetch(base + '/api/state')).json();
const sessOf = (st, sid) => { for (const p of st.projects || []) for (const s of p.sessions || []) if (s.sessionId === sid) return { p, s }; return null; };
// An answer without the pane's whole description, for the log.
const brief = (b) => (b && typeof b === 'object' ? { ok: b.ok, surfaceId: b.surfaceId, machine: b.machine, waiting: b.waiting, keep: b.keep, say: b.say, worktree: b.worktree ? b.worktree.branch : undefined, ended: b.ended ? b.ended.map((e) => e.where) : undefined, error: b.error } : b);
const ran = () => (fs.existsSync(RAN) ? fs.readFileSync(RAN, 'utf8').trim().split('\n').filter(Boolean) : []);

let browser = null;
const pictures = [];
try {
  const up = await until(async () => { const st = await state(); return st.generatedAt && sessOf(st, S_BOAT) && sessOf(st, S_NOTES) && (st.machines || []).some((m) => m.name === 'devbox' && m.state === 'connected') ? st : null; }, 30000, 250);
  check('board_up', !!up, up ? '' : hubLog.slice(-1500));
  if (!up) throw new Error('the board did not come up');
  // The phone signs in through the Mac's Wi-Fi address (phone access on, its key).
  await fetch(base + '/api/phone/access', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  await fetch(base + '/api/phone');
  const KEY = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).key;
  // The browser on a HOME of this check's, with nothing of a terminal pane or of Ravenry's in its environment.
  fs.mkdirSync(path.join(WORK, 'browser-home'), { recursive: true });
  const browserEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(WORK, 'browser-home'), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', RAVENRY_DESKTOP_DATA: path.join(WORK, 'browser-home', 'app-data') };
  const launch = { headless: true, env: browserEnv, ...(process.env.RAVENRY_CHROME ? { executablePath: process.env.RAVENRY_CHROME } : {}) };
  browser = await pw.chromium.launch(launch);
  const ctx = async (scheme = 'dark') => browser.newContext({ proxy: phoneProxy(STANDIN), viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  const c = await ctx();
  const p = await c.newPage();
  const posts = [];
  p.on('request', (r) => { if (r.method() === 'POST' && /\/api\/sessions\/(start|resume|move)$/.test(r.url())) posts.push({ path: new URL(r.url()).pathname, body: JSON.parse(r.postData() || '{}') }); });
  const answers = [];
  p.on('response', async (r) => { if (r.request().method() === 'POST' && /\/api\/sessions\/(start|resume|move)$/.test(r.url())) answers.push({ path: new URL(r.url()).pathname, status: r.status(), body: await r.json().catch(() => null) }); });
  p.on('pageerror', (e) => check('no_page_error', false, e.message));
  await p.goto(`${PH}/?k=${encodeURIComponent(KEY)}`);
  const who = await p.evaluate(async () => (await (await fetch('/api/whoami')).json()).local);
  check('signed_in_as_a_phone', who === false, `whoami local ${who}`);
  await p.waitForSelector('#pchips .pchip', { timeout: 20000 });
  // A picture; the toasts of earlier steps (and the sign-in's) left out, but in 03, where the toast is the point.
  const shot = async (name, page = p, { toast = false } = {}) => {
    const f = path.join(OUT, name + '.png');
    if (!toast) await page.evaluate(() => { for (const t of document.querySelectorAll('#toast, #ps-toast')) t.hidden = true; });
    await page.waitForTimeout(350);
    await page.screenshot({ path: f });
    pictures.push(f);
  };
  const lastAnswer = (pth) => until(() => answers.slice().reverse().find((a) => a.path === pth), 20000);
  // A project's page: its chip, else its row in the idle sheet.
  const openProject = async (id) => {
    if (await p.$(`#pchips .pchip[data-id="${id}"]`)) await p.tap(`#pchips .pchip[data-id="${id}"]`);
    else { await p.tap('#pchips [data-idle-open]'); await p.waitForSelector(`#idle-sheet [data-id="${id}"]`, { timeout: 5000 }); await p.tap(`#idle-sheet [data-id="${id}"]`); }
    await until(() => p.evaluate((n) => (document.querySelector('#d-head h1') || {}).textContent === n, id), 10000);
  };
  const closeFull = () => p.evaluate(() => { const b = document.querySelector('#lv-fs:not([hidden]) [data-lv-close]'); if (b) b.click(); });

  // ---- 01a: the + menu
  await p.tap('[data-act="pn-new"]');
  await p.waitForSelector('.ps-newmenu', { timeout: 5000 });
  const items = await p.$$eval('.ps-newmenu .pn-mi', (xs) => xs.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  check('plus_menu_two_items', items.length === 2 && /^New session Claude Code or Codex, in a project$/.test(items[0]) && /^New project A new folder and its brief$/.test(items[1]), JSON.stringify(items));
  await shot('01a-plus-menu');
  // ---- 02a: New session, full screen, from the + (paper-boat busy: own copy)
  await p.tap('[data-act="pn-new-session"]');
  await p.waitForSelector('.ps-row', { timeout: 10000 });
  const full = await p.evaluate(() => { const m = document.querySelector('.ps-modal'); const r = m.getBoundingClientRect(); return { w: r.width, h: r.height, title: document.querySelector('#modal-title').textContent }; });
  check('new_session_full_screen', full.w === 390 && full.h >= 800 && full.title === 'New session', JSON.stringify(full));
  await p.tap('.ps-row[data-ps-folder$="/paper-boat"]');
  const why = await p.textContent('.ps-why');
  check('own_copy_line', /It gets its own copy of the code, on a new branch, because Hull tilt is already working in paper-boat\./.test(why || ''), why);
  const cards = await p.$$eval('.ps-ac', (xs) => xs.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  check('assistants_signed_in', cards.join('|') === 'Claude Code Signed in|Codex Signed in', cards.join('|'));
  const go0 = await p.textContent('#ps-go');
  check('start_button_words', go0 === 'Start Claude Code in paper-boat', go0);
  await p.evaluate(() => window.scrollTo(0, 0));
  await shot('02a-new-session');
  // All projects lists every project of the board on this computer.
  await p.tap('[data-ps-all]');
  const all = await p.$$eval('.ps-row[data-ps-folder]', (xs) => xs.map((x) => x.textContent.trim()));
  check('all_projects', ['paper-boat', 'notes-app', 'portfolio', 'moss', 'garden-planner', 'kite', 'trail-map'].every((n) => all.includes(n)) && !all.includes('recipe-box'), all.join(', '));
  await p.tap('.ps-row[data-ps-folder$="/paper-boat"]');
  await p.selectOption('#ps-model', 'opus');
  await p.fill('#ps-text', 'Make the rain fall on the street');
  // ---- Start: the request, the live screen and the toast (03)
  await p.tap('#ps-go');
  const st0 = await lastAnswer('/api/sessions/start');
  const b0 = (posts.find((x) => x.path === '/api/sessions/start') || {}).body || {};
  check('start_request', b0.folder === path.join(ROOT, 'paper-boat') && b0.assistant === 'claude' && b0.model === 'opus' && b0.projectId === 'paper-boat' && b0.worktree === true && b0.text === 'Make the rain fall on the street' && !b0.machine, JSON.stringify(b0));
  check('start_answered', !!st0 && st0.status === 200 && /^ravenry:/.test(st0.body.surfaceId || '') && st0.body.say === 'Started Claude Code in paper-boat, on its own branch.' && !!st0.body.worktree, JSON.stringify(st0 && brief(st0.body)));
  const runLine = await until(() => ran().find((l) => l.startsWith('claude|') && l.includes('Make the rain fall on the street')), 15000);
  check('stand_in_ran_in_its_worktree', !!runLine && !runLine.split('|')[1].endsWith('/paper-boat') && /--model opus/.test(runLine), (runLine || ran().join(' / ')).slice(0, 160));
  const opened = await until(() => p.evaluate(() => !document.querySelector('#lv-fs').hidden && document.querySelector('#ps-toast') && !document.querySelector('#ps-toast').hidden ? document.querySelector('#ps-toast').innerText.trim() : null), 25000);
  check('live_screen_and_toast', opened === 'Started Claude Code in paper-boat, on its own branch.', String(opened));
  const shows = await until(() => p.evaluate(() => /claude stand-in: .*Make the rain fall on the street/.test(document.querySelector('#lv-lines') ? document.querySelector('#lv-lines').innerText : '')), 15000);
  check('live_screen_is_the_new_session', !!shows);
  await shot('03-after-start-live', p, { toast: true });
  await closeFull();
  await p.waitForTimeout(300);

  // ---- 01b: a project's New session, that project picked; Runs on devbox (MACH-007)
  await openProject('notes-app');
  await p.waitForSelector('.ps-nsbtn', { timeout: 10000 });
  await p.evaluate(() => window.scrollTo(0, document.querySelector('.ps-head').getBoundingClientRect().top + window.scrollY - 200));
  await shot('01b-project-new-session');
  await p.tap('.ps-nsbtn');
  await p.waitForSelector('.ps-row', { timeout: 10000 });
  const picked = await p.$eval('.ps-row.on', (x) => x.textContent.trim());
  check('project_page_picks_its_project', picked === 'notes-app', picked);
  await p.tap('[data-ps-machine="devbox"]');
  await p.waitForSelector('.ps-row.on', { timeout: 5000 });
  const onDevbox = await p.evaluate(() => ({ head: document.querySelector('#ps-top .inp:nth-child(2) > span').textContent, row: document.querySelector('.ps-row.on').innerText.replace(/\s+/g, ' '), go: document.querySelector('#ps-go').textContent, sub: document.querySelector('.ps-ac span').innerText.trim() }));
  check('devbox_words', onDevbox.head === 'Project on devbox' && /^recipe-box /.test(onDevbox.row) && onDevbox.go === 'Start Claude Code on devbox' && onDevbox.sub === 'Runs on devbox', JSON.stringify(onDevbox));
  await shot('02d-new-session-devbox');
  await p.tap('#ps-go');
  const st1 = await until(() => answers.filter((a) => a.path === '/api/sessions/start')[1], 20000);
  const b1 = (posts.filter((x) => x.path === '/api/sessions/start')[1] || {}).body || {};
  check('start_on_devbox_request', b1.machine === 'devbox' && b1.folder === DEVBOX_FOLDER && b1.projectId === 'recipe-box' && b1.assistant === 'claude', JSON.stringify(b1));
  check('start_on_devbox_answered', !!st1 && st1.status === 200 && st1.body.machine === 'devbox' && st1.body.say === 'Started Claude Code on devbox.', JSON.stringify(st1 && brief(st1.body)));
  const devRan = await until(() => ran().find((l) => /^claude\|(\/private)?/.test(l) && l.split('|')[1].endsWith('/devbox-home/code/recipe-box')), 15000);
  check('stand_in_ran_on_devbox', !!devRan, devRan || ran().join(' / '));
  const onBoard = await until(async () => { const st = await state(); const x = (st.projects || []).find((q) => q.id === 'recipe-box'); return x && x.sessions.some((y) => y.surfaceId === st1.body.surfaceId) ? x.id : null; }, 25000);
  check('devbox_session_on_board', onBoard === 'recipe-box', String(onBoard));
  const devLive = await until(() => p.evaluate(() => !document.querySelector('#lv-fs').hidden), 25000);
  check('devbox_live_screen_opens', !!devLive);
  await until(() => p.evaluate(() => !document.querySelector('#lv-fs').hidden), 25000);
  await closeFull();

  // ---- 04: an idle project's Last conversation; Continue
  await openProject('portfolio');
  await p.waitForSelector('#ps-lastc [data-act="ps-continue"]', { timeout: 15000 });
  const card = await p.evaluate(() => ({ head: document.querySelector('#ps-lastc .card-h').textContent, chip: document.querySelector('#ps-lastc .as-tag').textContent, ttl: document.querySelector('#ps-lastc .ttl').textContent, when: document.querySelector('#ps-lastc .when').textContent, live: !document.querySelector('#lv-card').hidden }));
  check('last_conversation_card', card.head === 'Last conversation' && card.chip === 'Claude Code' && card.ttl === 'Dark theme for the gallery' && /^Stopped (yesterday at|on \w+ at) \d+:\d\d [AP]M$/.test(card.when) && !card.live, JSON.stringify(card));
  await p.evaluate(() => window.scrollTo(0, document.querySelector('#ps-lastc').getBoundingClientRect().top + window.scrollY - 330));
  await shot('04-continue-idle-project');
  await p.tap('[data-act="ps-continue"]');
  const rs = await lastAnswer('/api/sessions/resume');
  const rb = (posts.find((x) => x.path === '/api/sessions/resume') || {}).body || {};
  check('continue_request', rb.projectId === 'portfolio' && rb.sessionId === S_PORT, JSON.stringify(rb));
  check('continue_answered', !!rs && rs.status === 200 && /^ravenry:/.test(rs.body.surfaceId || ''), JSON.stringify(rs && brief(rs.body)));
  const resumed = await until(() => ran().find((l) => l === `claude|${fs.realpathSync(PORTF)}|--resume ${S_PORT}` || l === `claude|${PORTF}|--resume ${S_PORT}`), 15000);
  check('continue_resumes_it_in_its_folder', !!resumed, resumed || ran().join(' / '));
  const contLive = await until(() => p.evaluate(() => !document.querySelector('#lv-fs').hidden), 25000);
  check('continue_opens_its_live_screen', !!contLive);
  await closeFull();

  // ---- 05: still open in iTerm2: Move to Ravenry, no Continue
  await openProject('moss');
  await p.waitForSelector('#ps-lastc [data-act="ps-last-move"]', { timeout: 15000 });
  const open5 = await p.evaluate(() => ({ hd: document.querySelector('#ps-lastc .ps-band .hd').textContent, cont: !!document.querySelector('#ps-lastc [data-act="ps-continue"]') }));
  check('still_open_in_iterm2', open5.hd === 'Still open in iTerm2 on your Mac' && !open5.cont, JSON.stringify(open5));
  await p.evaluate(() => window.scrollTo(0, document.querySelector('#ps-lastc').getBoundingClientRect().top + window.scrollY - 330));
  await shot('05-open-elsewhere-move');
  await p.tap('[data-act="ps-last-move"]');
  const mv5 = await lastAnswer('/api/sessions/move');
  const mb5 = (posts.find((x) => x.path === '/api/sessions/move') || {}).body || {};
  check('move_last_request', mb5.projectId === 'moss' && mb5.sessionId === S_MOSS && mb5.keep === 'ravenry', JSON.stringify(mb5));
  check('move_last_answered', !!mv5 && mv5.status === 200 && /^ravenry:/.test(mv5.body.surfaceId || '') && !alive(mossH.pid), JSON.stringify(mv5 && brief(mv5.body)));
  await until(() => p.evaluate(() => !document.querySelector('#lv-fs').hidden), 25000);
  await closeFull();

  // ---- 06a, 06b: a session in cmux mid-turn: Move to Ravenry waits for its turn, then goes
  await openProject('paper-boat');
  // The cmux session (the worktree one started above is another).
  await until(() => p.evaluate(() => { for (const x of document.querySelectorAll('[data-act="session"]')) if (/Hull tilt/.test(x.getAttribute('aria-label') || '')) { x.click(); return true; } return false; }), 10000);
  await p.waitForSelector('#ps-band .ps-band [data-act="ps-move"]', { timeout: 15000 });
  const band = await p.evaluate(() => ({ hd: document.querySelector('#ps-band .hd').textContent, tx: document.querySelector('#ps-band .tx').textContent, b: document.querySelector('#ps-band [data-act="ps-move"]').textContent }));
  check('move_band_words', band.hd === 'Runs in cmux on your Mac' && band.tx === 'Move to Ravenry ends it in cmux and picks up this conversation in a Ravenry pane on your Mac. Claude is working, so it moves when this turn ends.' && band.b === 'Move to Ravenry', JSON.stringify(band));
  await p.evaluate(() => window.scrollTo(0, document.querySelector('#lv-card').getBoundingClientRect().top + window.scrollY - 150));
  await shot('06a-move-from-cmux');
  await p.tap('#ps-band [data-act="ps-move"]');
  const mv6 = await until(() => answers.filter((a) => a.path === '/api/sessions/move')[1], 20000);
  check('move_mid_turn_waits', !!mv6 && mv6.status === 200 && mv6.body.waiting === true && alive(files['paper-boat'].h.pid), JSON.stringify(mv6 && mv6.body));
  const waitTx = await until(() => p.evaluate(() => { const w = document.querySelector('#ps-band .ps-band.wait'); return w ? w.textContent.trim() : null; }), 15000);
  check('waiting_band', waitTx === 'Moves to Ravenry when Claude finishes its turn in cmux.', String(waitTx));
  await shot('06b-move-waiting');
  // Its turn ends: the move goes (this check's process ends, a Ravenry pane resumes it).
  fs.appendFileSync(files['paper-boat'].evFile, files['paper-boat'].evLine('Stop', 0) + '\n');
  const gone = await until(() => !alive(files['paper-boat'].h.pid), 20000);
  const resumed6 = await until(() => ran().find((l) => l.endsWith(`--resume ${S_BOAT}`)), 15000);
  check('move_after_turn_done', !!gone && !!resumed6, `${gone} ${resumed6}`);

  // ---- a session in cmux at rest: Move to Ravenry goes at once
  await openProject('notes-app');
  await until(() => p.evaluate(() => { const rows = document.querySelectorAll('[data-act="session"]'); if (!rows.length) return true; for (const x of rows) if (/Sync settings/.test(x.getAttribute('aria-label') || '')) { x.click(); return true; } return false; }), 10000);
  await p.waitForSelector('#ps-band [data-act="ps-move"]', { timeout: 15000 });
  const tx7 = await p.textContent('#ps-band .tx');
  check('move_band_at_rest', tx7 === 'Move to Ravenry ends it in cmux and picks up this conversation in a Ravenry pane on your Mac.', tx7);
  await p.tap('#ps-band [data-act="ps-move"]');
  const mv7 = await until(() => answers.filter((a) => a.path === '/api/sessions/move')[2], 20000);
  check('move_at_rest', !!mv7 && mv7.status === 200 && /^ravenry:/.test(mv7.body.surfaceId || '') && mv7.body.say === 'Moved it to a Ravenry pane on your Mac.' && !alive(files['notes-app'].h.pid), JSON.stringify(mv7 && brief(mv7.body)));
  const live7 = await until(() => p.evaluate(() => !document.querySelector('#lv-fs').hidden && /Moved it/.test((document.querySelector('#ps-toast') || {}).innerText || '')), 25000);
  check('move_opens_live_screen_with_toast', !!live7);
  await closeFull();

  // ---- 07: open in two places (cmux started it again beside the Ravenry pane): keep one
  const twin = holder();
  const nf = files['notes-app'];
  ps.push({ pid: twin.pid, ppid: process.pid, rssKb: 300000, startedAt: ago(0), command: `claude --resume ${S_NOTES}`, cwd: path.join(ROOT, 'notes-app'), env: 'TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=3A000000-0000-4000-8000-000000000002 CMUX_SURFACE_ID=5F000000-0000-4000-8000-000000000002' });
  fs.writeFileSync(PS, JSON.stringify(ps.filter((x) => alive(x.pid))));
  const also = await until(async () => { const x = sessOf(await state(), S_NOTES); return x && x.s.phoneMove && x.s.phoneMove.kind === 'also' ? x.s : null; }, 70000, 500);
  check('also_open_state', !!also && /^ravenry:/.test(also.surfaceId) && also.alsoOpen && also.alsoOpen.name === 'cmux', JSON.stringify(also && { surfaceId: also.surfaceId, alsoOpen: also.alsoOpen, phoneMove: also.phoneMove }));
  await until(() => p.evaluate(() => { for (const x of document.querySelectorAll('[data-act="session"]')) if (/Sync settings/.test(x.getAttribute('aria-label') || '') && !x.classList.contains('sel')) { x.click(); return false; } return !!document.querySelector('#ps-band [data-keep="outside"]'); }), 15000);
  const band7 = await p.evaluate(() => ({ hd: (document.querySelector('#ps-band .hd') || {}).textContent, tx: (document.querySelector('#ps-band .tx') || {}).textContent, b: [...document.querySelectorAll('#ps-band [data-act="ps-move"]')].map((x) => x.textContent) }));
  check('also_open_band', band7.hd === 'Also open in cmux' && band7.tx === 'This conversation runs in Ravenry and in cmux on your Mac. Both write to it, so keep one.' && band7.b.join('|') === 'Keep it in Ravenry|Keep it in cmux', JSON.stringify(band7));
  await p.evaluate(() => window.scrollTo(0, document.querySelector('#lv-card').getBoundingClientRect().top + window.scrollY - 150));
  await shot('07-also-open-in-cmux');
  await p.tap('#ps-band [data-keep="outside"]');
  const mv8 = await until(() => answers.filter((a) => a.path === '/api/sessions/move')[3], 20000);
  const mb8 = (posts.filter((x) => x.path === '/api/sessions/move')[3] || {}).body || {};
  check('keep_it_there_request', mb8.projectId === 'notes-app' && mb8.sessionId === S_NOTES && mb8.keep === 'outside', JSON.stringify(mb8));
  check('keep_it_there_answered', !!mv8 && mv8.status === 200 && mv8.body.keep === 'outside' && mv8.body.say === 'Kept it in cmux. The Ravenry copy ended.' && alive(twin.pid), JSON.stringify(mv8 && brief(mv8.body)));
  void nf;

  // ---- MACH-010 still holds for a phone; Retry is allowed
  const add = await p.evaluate(async () => { const r = await fetch('/api/machines/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ name: 'x', host: 'x' }) }); return r.status; });
  check('phone_still_refused_add_machine', add === 403, String(add));

  // ---- New session in light (02c)
  const cl = await ctx('light');
  const pl = await cl.newPage();
  await pl.goto(`${PH}/?k=${encodeURIComponent(KEY)}`);
  await pl.waitForSelector('#pchips .pchip', { timeout: 20000 });
  // Light, from the menu's Theme, as a person picks it.
  await pl.tap('#pb-more');
  await pl.tap('[data-theme-pick="light"]');
  await pl.tap('[data-act="pn-menu-close"]');
  check('light_theme', await pl.evaluate(() => document.querySelector('#mc').classList.contains('light')));
  await pl.tap('[data-act="pn-new"]');
  await pl.tap('[data-act="pn-new-session"]');
  await pl.waitForSelector('.ps-row', { timeout: 10000 });
  await shot('02c-new-session-light', pl);
  await cl.close();
  await c.close();
} catch (e) {
  check('ran_through', false, e.stack || e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  hub.kill();
  for (const env of [localEnv, DEVBOX_ENV]) {
    try { for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } } } catch { /* none */ }
  }
  for (const h of holders) try { h.kill('SIGKILL'); } catch { /* gone */ }
  for (const d of [RT, RR]) fs.rmSync(d, { recursive: true, force: true });
}
if (failed) console.log(hubLog.split('\n').filter((l) => /sessions:|refused|error/i.test(l)).slice(-30).join('\n'));
console.log(`pictures: ${pictures.join(', ')}`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
