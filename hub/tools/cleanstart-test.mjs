#!/usr/bin/env node
// A fresh session starts even when the person's shell asks something at
// startup (2026-11-15: oh-my-zsh's "Would you like to update? [Y/n]" ate a
// hand-off's typed command). On a real ravenryd of this test's own (its
// own HOME, socket and state; never the user's) and a test board in Ravenry
// mode on 127.0.0.1, for four shell startups (zsh, with HOME/.zshrc):
//   omz    asks "[oh-my-zsh] Would you like to update? [Y/n]" and waits
//   slow   sleeps 3 s before the prompt
//   zshrc  puts the stand-in's folder on the PATH, and only there
//   plain  nothing
// The assistant is a stand-in named claude (never the real one): it writes
// its argv, folder and PATH to a log, reports SessionStart through the
// board's own hook (hooks/events.mjs, which records the session's PATH) and
// draws Claude Code's prompt box.
//
// Per startup: an "old" session runs in a pane (the person types `claude`
// at its prompt, answering the startup question first where there is one),
// its hand-off is written, and the board's hand-off start (POST
// /api/handoff/start) must start the stand-in with the exact prompt in the
// project's folder, and the hand-off become `resumed` only once it is seen;
// then New session (POST /api/sessions/start) with words must start it with
// exactly those words. In omz, with the session PATHs gone and the board's
// own PATH without the stand-in (so its command can only be typed), the
// start must end in a resumeError that names the question, nothing typed
// into the question; Retry with the PATH back must then resume.
//
// HUB_DIR=<a hub folder> runs the same against another hub (the code before
// this fix, exported with git archive), to show where it fails.
//
// Usage: RAVENRYD_BIN=<ravenryd> node tools/cleanstart-test.mjs [--only omz,slow] [--json out.json]
import { withStubMachine } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = process.env.RAVENRYD_BIN;
if (!BIN) { console.log('SKIP  cleanstart-test: set RAVENRYD_BIN to a ravenryd binary'); process.exit(0); }
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HUB = path.resolve(process.env.HUB_DIR || HERE);
const OLD = HUB !== HERE;
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const ONLY = arg('--only') ? arg('--only').split(',') : ['omz', 'slow', 'zshrc', 'plain'];
const JSON_OUT = arg('--json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let fails = 0;
const check = (variant, name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${variant} ${name}${detail ? '  ' + detail : ''}`);
  results.push({ variant, name, ok: !!ok, detail });
  if (!ok) fails++;
};
async function until(fn, ms = 10000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const RC = {
  omz: `printf '[oh-my-zsh] Would you like to update? [Y/n] '\nread -r -k 1 option\necho\n`,
  slow: 'sleep 3\n',
  zshrc: 'export PATH="$HOME/bin:$PATH"\n',
  plain: '',
};

async function variant(v) {
  // The board's data in the hub's .tmp (its guard), the daemon's folders short (a socket path).
  const T = fs.mkdtempSync(path.join(HUB, '.tmp', `cleanstart-${v}-`));
  const MC = path.join(T, 'mc');
  const PROJ = path.join(T, 'proj');
  const TH = path.join(T, 'home');
  for (const d of [MC, PROJ, TH]) fs.mkdirSync(d, { recursive: true });
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-'));
  const DHOME = path.join(D, 'home');
  const SIN = path.join(DHOME, 'bin');
  fs.mkdirSync(SIN, { recursive: true });
  const RUN = path.join(D, 'run');
  fs.writeFileSync(path.join(DHOME, '.zshrc'), `PROMPT='%1~ %# '\n${RC[v]}`);
  execFileSync('git', ['init', '-q', PROJ]);
  fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), `# Clean start\n\nGoal: Start a fresh session whatever the shell asks.\n\n## Hand-off\n- 2026-11-15 10:00 Older hand-off.\n`);
  fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { handoffAutoStart: false, autoImport: false }, projects: [{ id: 'clean', name: 'Clean', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
  const port = await freePort();
  const BOARD = `http://127.0.0.1:${port}`;
  // The stand-in claude, in $HOME/bin of the daemon's account.
  const LOG = path.join(T, 'standin.log');
  fs.writeFileSync(path.join(T, 'standin.cjs'), `
const fs = require('fs'), cp = require('child_process'), crypto = require('crypto');
const args = process.argv.slice(2);
const sid = crypto.randomUUID();
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ pid: process.pid, pane: process.env.RAVENRY_PANE || '', cwd: process.cwd(), sid, args, path: process.env.PATH }) + '\\n');
try {
  cp.execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.join(HUB, 'hooks', 'events.mjs'))}], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, cwd: process.cwd(), source: 'startup', model: 'claude-opus-5-5' }),
    env: { ...process.env, RAVENRY_HOME: ${JSON.stringify(MC)}, MC_BOARD_URL: ${JSON.stringify(BOARD)}, TEST_RAVENRY: '1' }, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
} catch {}
const w = Math.max(20, Math.min(100, (process.stdout.columns || 80) - 2));
process.stdout.write('\\x1b[H\\x1b[2JClaude Code (a stand-in)\\r\\nasked: ' + args.join(' ') + '\\r\\n\\r\\n' + '\\u2500'.repeat(w) + '\\r\\n\\u276f \\r\\n' + '\\u2500'.repeat(w) + '\\r\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { if (String(d).includes('\\x03')) process.exit(0); });
`);
  fs.writeFileSync(path.join(SIN, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(T, 'standin.cjs'))} "$@"\n`, { mode: 0o755 });
  const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // zshrc: the stand-in's folder only on the PATH .zshrc makes.
  const DPATH = v === 'zshrc' ? '/usr/bin:/bin' : `/usr/bin:/bin:${SIN}`;
  const DENV = { HOME: DHOME, PATH: DPATH, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
  const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let dlog = '';
  daemon.stderr.on('data', (d) => { dlog += d; });
  const rv = (...a) => execFileSync(BIN, a, { env: DENV, encoding: 'utf8', timeout: 8000 });
  await until(() => { try { rv('ls', '--json'); return true; } catch { return false; } }, 8000);
  // The board: Ravenry mode on this daemon; its own PATH never holds the stand-in.
  const henv = {
    PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: TH, LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir(), TEST_RAVENRY: '1',
    RAVENRY_HOME: MC, PORT: String(port), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN, RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state'),
    MC_NO_EVENTS: '0', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CLAUDE: '1', MC_CODEX: '0', MC_CLAUDE_PROJECTS: path.join(T, 'claude-projects'), MC_APPS: 'ravenry',
  };
  fs.mkdirSync(henv.MC_CLAUDE_PROJECTS, { recursive: true });
  const hub = spawn(process.execPath, [path.join(HUB, 'server', 'index.mjs')], { env: withStubMachine(henv), stdio: ['ignore', 'pipe', 'pipe'] });
  let hlog = '';
  hub.stdout.on('data', (d) => { hlog += d; });
  hub.stderr.on('data', (d) => { hlog += d; });
  const get = async (p) => (await fetch(BOARD + p)).json();
  const post = async (p, body) => { const r = await fetch(BOARD + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json().catch(() => null) }; };
  await until(async () => { try { return !!(await get('/api/state')).generatedAt; } catch { return false; } }, 20000, 250);
  const screen = (pane) => { try { return rv('capture', pane); } catch { return ''; } };
  const panesNow = () => { const j = JSON.parse(rv('ls', '--json')); return Array.isArray(j) ? j : j.panes || []; };
  const newPane = (name) => { const out = rv('new', '--cwd', PROJ, '--name', name, '--json'); try { const j = JSON.parse(out); return j.id || (j.pane && j.pane.id); } catch { return out.trim(); } };
  const marker = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(MC, 'handoffs', sid + '.json'), 'utf8')); } catch { return null; } };
  const writeMarker = (sid, surfaceId) => {
    fs.mkdirSync(path.join(MC, 'handoffs'), { recursive: true });
    const at = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(path.join(MC, 'handoffs', sid + '.json'), JSON.stringify({ sessionId: sid, state: 'written', queuedAt: at, writtenAt: at, cwd: PROJ, folder: PROJ, surfaceId, handoffFile: path.join(PROJ, 'BRIEF.md'), history: [{ state: 'written', at }] }, null, 2));
  };
  const PROMPT = 'Read the Hand-off section of BRIEF.md and continue from it.';
  try {
    // The old session: a pane with the login shell; the person answers the
    // startup question (omz) and types claude at the prompt.
    const p0 = newPane('old');
    const ready = await until(() => (v === 'omz' ? /\[Y\/n\]/.test(screen(p0)) : /%\s*$/m.test(screen(p0))), 15000);
    if (v === 'omz') { rv('send', p0, '--typed', 'n'); await until(() => /%\s*$/m.test(screen(p0)), 8000); }
    rv('send', p0, '--typed', "claude 'the old session'", '--key', 'Enter');
    const old = await until(() => log().find((r) => r.args.join(' ') === 'the old session'), 15000);
    check(v, 'old_session_runs', ready && old, old ? `pane ${old.pane}` : screen(p0).slice(-300));
    if (!old) return;
    const oldTab = 'ravenry:' + old.pane;
    const seen = await until(async () => { const s = await get('/api/state'); return (s.projects || []).some((p) => p.sessions.some((x) => x.sessionId === old.sid)); }, 20000, 400);
    check(v, 'board_sees_old_session', seen, seen ? '' : hlog.slice(-500));

    // The hand-off's fresh session.
    writeMarker(old.sid, oldTab);
    await sleep(2500);
    const n0 = log().length;
    const t0 = Date.now();
    const r = await post('/api/handoff/start', { projectId: 'clean', sessionId: old.sid });
    const fresh = await until(() => log().slice(n0).find((x) => x.args.includes(PROMPT) || x.args.some((a) => a.startsWith('Read the Hand-off'))), 25000);
    const ms = fresh ? Date.now() - t0 : null;
    check(v, 'handoff_starts_assistant', r.status === 200 && fresh && fresh.args.length === 1 && fresh.args[0].startsWith(PROMPT) && fs.realpathSync(fresh.cwd) === fs.realpathSync(PROJ),
      `POST ${r.status} ${JSON.stringify(r.j)}; ${fresh ? `argv ${JSON.stringify(fresh.args)} cwd ${fresh.cwd} in ${ms} ms` : 'not started; ' + log().slice(n0).map((x) => JSON.stringify(x.args)).join(' ')}`);
    const resumed = await until(() => { const m = marker(old.sid); return m && m.state === 'resumed' ? m : null; }, 25000, 300);
    const m1 = marker(old.sid);
    // What the fresh tab shows when nothing started there (the old code: the question ate the typing).
    if (!fresh && m1 && m1.resumeSurfaceId) console.log(`      ${v} fresh tab's screen: ${screen(m1.resumeSurfaceId.replace('ravenry:', '')).split('\n').filter(Boolean).slice(-4).join(' / ')}`);
    check(v, 'handoff_resumed_when_seen', resumed && fresh && (OLD || resumed.resumedBy === 'seen' || resumed.resumedBy === 'screen'),
      `state ${m1 && m1.state}, by ${m1 && m1.resumedBy}, how ${m1 && m1.resumeHow}, error ${m1 && m1.resumeError}`);
    if (!OLD && fresh) {
      const fp = panesNow().find((x) => x.id === fresh.pane);
      check(v, 'handoff_tab_runs_program', fp && Array.isArray(fp.command) && fp.command[4] === 'ravenry-start' && fp.command.slice(8).join(' ').includes(PROMPT) && fp.command[8] === path.join(SIN, 'claude'),
        fp ? JSON.stringify(fp.command.slice(0, 2).concat(fp.command.slice(4))) : 'no pane ' + fresh.pane);
      // Its shell after the assistant: the person's login shell, in the folder.
      rv('send', fresh.pane, '--key', 'Ctrl+C');
      // (omz: that shell's own startup asks its question, as in a tab opened by hand.)
      const back = await until(() => /%\s*$/m.test(screen(fresh.pane)) || (v === 'omz' && /\[Y\/n\]\s*$/.test(screen(fresh.pane).trim())), 15000);
      // With Ravenry's shell integration (its prompt marks), as a pane opened by hand has.
      const marks = v === 'omz' || await until(() => { const x = panesNow().find((y) => y.id === fresh.pane); return x && x.shell && x.shell.state === 'prompt'; }, 5000);
      check(v, 'handoff_tab_falls_back_to_shell', back && marks, screen(fresh.pane).split('\n').filter(Boolean).slice(-3).join(' / ') + `; marks ${marks}`);
    }

    // New session with words (the app's New session).
    const n1 = log().length;
    const WORDS = "it's $HOME -x \"quoted\"";
    const ns = await post('/api/sessions/start', { projectId: 'clean', text: WORDS });
    const nsr = await until(() => log().slice(n1).find((x) => x.args.includes(WORDS)), 25000);
    check(v, 'new_session_starts_assistant', ns.status === 200 && nsr && nsr.args.length === 1 && fs.realpathSync(nsr.cwd) === fs.realpathSync(PROJ),
      `POST ${ns.status} ${JSON.stringify(ns.j && (ns.j.error || ns.j.surfaceId))}; ${nsr ? `argv ${JSON.stringify(nsr.args)} cwd ${nsr.cwd}` : 'not started; ' + log().slice(n1).map((x) => JSON.stringify(x.args)).join(' ')}`);

    // omz, with nothing but typing left: a resumeError, nothing typed; Retry with the PATH back resumes.
    if (v === 'omz' && !OLD) {
      const saved = path.join(T, 'sessionenv-saved');
      fs.renameSync(path.join(MC, 'sessionenv'), saved);
      const p2 = newPane('old2');
      await until(() => /\[Y\/n\]/.test(screen(p2)), 15000);
      rv('send', p2, '--typed', 'n');
      await until(() => /%\s*$/m.test(screen(p2)), 8000);
      rv('send', p2, '--typed', "claude 'the second old session'", '--key', 'Enter');
      const old2 = await until(() => log().find((x) => x.args.join(' ') === 'the second old session'), 15000);
      fs.rmSync(path.join(MC, 'sessionenv'), { recursive: true, force: true }); // its own PATH too
      await until(async () => { const s = await get('/api/state'); return (s.projects || []).some((p) => p.sessions.some((x) => x.sessionId === old2.sid)); }, 20000, 400);
      writeMarker(old2.sid, 'ravenry:' + old2.pane);
      await sleep(2500);
      const n2 = log().length;
      const r2 = await post('/api/handoff/start', { projectId: 'clean', sessionId: old2.sid });
      const failed = await until(() => { const m = marker(old2.sid); return m && m.resumeError ? m : null; }, 40000, 300);
      const h = await until(async () => {
        const st = await get('/api/state');
        const x = (st.projects || []).flatMap((p) => p.sessions).find((y) => y.sessionId === old2.sid);
        return x && x.handoff && x.handoff.resumeError ? x.handoff : null;
      }, 10000, 300);
      const tabScreen = failed && failed.resumeSurfaceId ? screen(failed.resumeSurfaceId.replace('ravenry:', '')) : '';
      check(v, 'typed_start_into_question_is_an_error', r2.status !== 200 && failed && failed.state === 'written' && /terminal was asking something/.test(failed.resumeError) && log().length === n2
        && /\[Y\/n\]\s*$/.test(tabScreen.trim()) && h && h.resumeError === failed.resumeError && /^cd '/.test(h.resumeCommand || '') && /Would you like to update/.test(h.resumeQuestion || ''),
        `POST ${r2.status} ${JSON.stringify(r2.j)}; marker ${failed && JSON.stringify({ state: failed.state, error: failed.resumeError, q: failed.resumeQuestion, cmd: failed.resumeCommand })}; tab ends "${tabScreen.trim().split('\n').pop()}"; started ${log().length - n2}`);
      // New session, with only typing left: an error, nothing typed into the question.
      const n3 = log().length;
      const ns3 = await post('/api/sessions/start', { projectId: 'clean', text: 'words for nobody' });
      await sleep(1500);
      check(v, 'typed_new_session_into_question_is_an_error', ns3.status !== 200 && /asking something/.test((ns3.j && ns3.j.error) || '') && log().length === n3,
        `POST ${ns3.status} ${JSON.stringify(ns3.j)}; started ${log().length - n3}`);
      // Retry, with the session's PATH back: the program starts, and it resumes.
      fs.renameSync(saved, path.join(MC, 'sessionenv'));
      const r3 = await post('/api/handoff/start', { projectId: 'clean', sessionId: old2.sid });
      const fresh3 = await until(() => log().slice(n2).find((x) => x.args.some((a) => a.startsWith('Read the Hand-off'))), 25000);
      const res3 = await until(() => { const m = marker(old2.sid); return m && m.state === 'resumed' ? m : null; }, 25000, 300);
      check(v, 'retry_resumes', r3.status === 200 && fresh3 && res3, `POST ${r3.status} ${JSON.stringify(r3.j)}; marker ${JSON.stringify(marker(old2.sid) && { state: marker(old2.sid).state, err: marker(old2.sid).resumeError })}`);
    }
  } finally {
    hub.kill('SIGTERM');
    daemon.kill('SIGTERM');
    await sleep(500);
    if (process.env.KEEP !== '1') { fs.rmSync(D, { recursive: true, force: true }); fs.rmSync(T, { recursive: true, force: true }); }
    if (fails && process.env.VERBOSE === '1') console.log(hlog.slice(-3000), dlog.slice(-1000));
  }
}

for (const v of ONLY) await variant(v);
console.log(`\n${OLD ? `[hub at ${HUB}] ` : ''}${results.filter((r) => r.ok).length}/${results.length} passed`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ hub: HUB, results }, null, 2));
process.exit(fails ? 1 : 0);
