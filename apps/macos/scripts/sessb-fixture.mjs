// sidetest.mjs --screen sessb (SelfTestSessB.swift): the sessions rows the
// first sessions round left unproven, on a demo hub in Ravenry mode (as the
// app's own hub runs, apps/desktop/src/main/install.ts) that starts its
// sessions in panes of this test's daemon. Its Claude and Codex are
// stand-ins (STAND_IN below): each says where it runs and what it was asked,
// reports its start (and Codex its permission request) through `ravenryd
// hook` as the real ones do, and draws Claude Code's prompt box, which takes
// what is typed and Enter, so a reply the hub types lands on its screen.
//
// The app asks the driver for what only a test can make (<out>.do-N,
// answered in <out>.done-N): "events" appends hook records to a demo
// session's events, "brief" rewrites a project's brief, "marker" writes a
// hand-off marker, "pane" reads a pane's screen and its stand-in's log,
// "screenonly" lists a stand-in process with no hook events, "hubdown" and
// "hubup" stop and start the board for the second launch (sessb2).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freePort } from '../../desktop/tools/demo-hub.mjs';

const sq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;

// The stand-in of Claude Code and of Codex: one Node script, the assistant by its name.
const STAND_IN_SRC = `
const fs = require('fs'), cp = require('child_process'), crypto = require('crypto');
const kind = process.env.SB_KIND || 'claude';
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const sid = at >= 0 ? args[at + 1] : crypto.randomUUID();
fs.appendFileSync(process.env.SB_LOG, JSON.stringify({ pid: process.pid, pane: process.env.RAVENRY_PANE || '', cwd: process.cwd(), kind, sid, args }) + '\\n');
const hook = (ev, extra = {}) => {
  try { cp.execFileSync(process.env.SB_RAVENRYD, ['hook', '--assistant', kind], { input: JSON.stringify({ hook_event_name: ev, session_id: sid, cwd: process.cwd(), ...extra }), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }); } catch {}
};
const said = [];
let typed = '';
const draw = () => {
  const w = Math.max(20, Math.min(100, (process.stdout.columns || 80) - 2));
  let s = '\\x1b[H\\x1b[2J';
  s += (kind === 'codex' ? 'Codex (a stand-in)' : 'Claude Code (a stand-in)') + '\\r\\n';
  s += 'asked: ' + (args.join(' ') || '(nothing)') + '\\r\\n\\r\\n';
  for (const l of said.slice(-8)) s += '> ' + l + '\\r\\n';
  s += '\\r\\n' + '\\u2500'.repeat(w) + '\\r\\n' + '\\u276f ' + typed + '\\r\\n' + '\\u2500'.repeat(w) + '\\r\\n';
  process.stdout.write(s);
};
// "make dev": a pane of its own named dev server; "wait dev": the lease of that pane, waiting
// while another agent holds it (the person is asked first for a pane it did not start). Each is
// a turn of its own: the session works while it runs.
const run = (a, done) => { const p = cp.spawn(process.env.SB_RAVENRYD, a, { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('exit', (code) => done(o.trim(), code)); };
const act = (line) => {
  if (line === 'make dev' || line === 'wait dev') hook('UserPromptSubmit', { prompt: line });
  if (line === 'make dev') run(['new', '--name', 'dev server', '--json', '--', '/bin/sleep', '900'], (o) => {
    let id = ''; try { const j = JSON.parse(o); id = j.id || (j.pane && j.pane.id) || ''; } catch { said.push('new: ' + o.slice(0, 60)); draw(); return; }
    said.push('made ' + id); draw();
  });
  if (line === 'wait dev') run(['ls', '--json'], (o) => {
    let id = ''; try { const j = JSON.parse(o); const l = Array.isArray(j) ? j : (j.panes || []); const p = l.find((x) => x.name === 'dev server'); id = p ? p.id : ''; } catch {}
    if (!id) { said.push('no dev server'); draw(); return; }
    said.push('waiting for ' + id); draw();
    run(['lease', id, '--wait', '5m', '--reason', 'I need the dev server too.'], (o2, c2) => { said.push(c2 === 0 ? 'holds ' + id : 'lease: ' + o2.slice(0, 60)); draw(); });
  });
};
hook('SessionStart', { source: at >= 0 ? 'resume' : 'startup', model: kind === 'codex' ? 'gpt-5' : 'claude-opus-5-5' });
if (kind === 'codex') {
  hook('UserPromptSubmit', { prompt: args.join(' ') });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests before the commit' } });
}
draw();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  const s = String(d).replace(/\\x1b\\[20[01]~/g, '');
  for (const c of s) {
    if (c === '\\r' || c === '\\n') { if (typed) { said.push(typed); act(typed); } typed = ''; }
    else if (c === '\\x7f' || c === '\\b') typed = typed.slice(0, -1);
    else if (c === '\\x03') process.exit(0);
    else if (c >= ' ') typed += c;
  }
  draw();
});
process.stdout.on('resize', draw);
`;

/** The hub's options for --screen sessb, added to the screens' own. */
export function sessbHub({ tmp, APP, run, base }) {
  const dir = path.join(tmp, 'sessb');
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'stand-in.cjs');
  fs.writeFileSync(js, STAND_IN_SRC);
  const ravenryd = path.join(APP, 'Contents', 'MacOS', 'ravenryd');
  const log = path.join(dir, 'stand-in.log');
  const mk = (name, kind) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\nSB_KIND=${kind} SB_LOG=${sq(log)} SB_RAVENRYD=${sq(ravenryd)} exec ${sq(process.execPath)} ${sq(js)} "$@"\n`, { mode: 0o755 });
    return f;
  };
  const claude = mk('claude', 'claude'), codex = mk('codex', 'codex');
  const first = base.prepare;
  return {
    log, claude, codex,
    hub: {
      ...base,
      cmuxIds: true, runtime: run,
      // Quiet for 36 s is idle (a stand-in at rest can be closed from its project's row).
      settings: { ...(base.settings || {}), launchCommand: claude, handoffCommand: claude, codexCommand: codex, handoffAutoStart: false, idleHours: 0.01 },
      // MC_NO_EVENTS 0: the hub follows the daemon's agent reports (what the stand-ins' hooks say).
      env: { ...(base.env || {}), MC_NO_EVENTS: '0', RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: ravenryd, MC_CODEX: '1', MC_NO_AUTOSTART: '0' },
      extra: [...(base.extra || []), { id: 'harbour-light', name: 'harbour-light' }],
      prepare: (a) => {
        if (first) first(a);
        fs.mkdirSync(path.join(a.ROOT, 'old-notes'), { recursive: true });
        fs.writeFileSync(path.join(a.ROOT, 'old-notes', 'BRIEF.md'), '# Old notes\n\nGoal: Keep the notes from before the app.\n');
        fs.mkdirSync(path.join(a.ROOT, 'harbour-light'), { recursive: true });
        fs.writeFileSync(path.join(a.ROOT, 'harbour-light', 'BRIEF.md'), '# Harbour light\n\nGoal: A light the boats can see from the bay.\n');
        // Two decisions lighthouse's sessions are told to check: its own and one for every project.
        const now = Date.now();
        fs.writeFileSync(path.join(a.MC, 'decisions.json'), JSON.stringify({ version: 1, decisions: [
          { id: 'dlampaaa', quote: 'The lamp turns once every ten seconds.', at: new Date(now - 3600000).toISOString(), project: 'lighthouse', overrides: [], by: 'person' },
          { id: 'dallaaaa', quote: 'No em dashes anywhere.', at: new Date(now - 7200000).toISOString(), project: null, overrides: [], by: 'person' },
        ] }, null, 2), { mode: 0o600 });
      },
    },
  };
}

/** What the app asks the driver for; returns the answer's fields. */
// Each stand-in that started, listed as ps lists an assistant in a Ravenry
// pane (the hub's stub ps): its session is the pane's from its first state.
const listed = new Set();
function listStandIns(hub, sb) {
  if (!sb || !hub.ps || !fs.existsSync(sb.log)) return;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let ps = JSON.parse(fs.readFileSync(hub.ps, 'utf8'));
  let changed = false;
  for (const l of fs.readFileSync(sb.log, 'utf8').trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(l);
    if (listed.has(r.pid) || !alive(r.pid)) continue;
    listed.add(r.pid);
    changed = true;
    ps.push({ pid: r.pid, ppid: 1, rssKb: 240000, startedAt: new Date().toISOString(), command: r.kind === 'codex' ? `codex resume ${r.sid}` : `claude --resume ${r.sid}`, cwd: r.cwd, env: `TERM_PROGRAM=ravenry RAVENRY_PANE=${r.pane}` });
  }
  // One that ended (closed from the board) leaves the list, as ps would.
  const before = ps.length;
  ps = ps.filter((p) => !listed.has(p.pid) || alive(p.pid));
  if (changed || ps.length !== before) fs.writeFileSync(hub.ps, JSON.stringify(ps));
  // A pane the hub has not seen: it reads the processes again at once.
  if (changed && ctxDaemon.sock) { try { execFileSync(ctxDaemon.bin, ['new', '--socket', ctxDaemon.sock, '--json', '--', '/bin/sleep', '15'], { env: ctxDaemon.env, stdio: 'ignore' }); } catch { /* the next tick */ } }
}
const ctxDaemon = {};

export async function sessbDo(req, { hub, sb, sock, APP, env, startHub }) {
  const ans = {};
  listStandIns(hub.current, sb);
  const st = async () => (await fetch(hub.current.url + '/api/state')).json();
  if (req.do === 'events') {
    // Hook records appended to a session's events file, as its hook writes them.
    const s = (await st()).projects.flatMap((p) => p.sessions.map((x) => ({ ...x, projectId: p.id }))).find((x) => x.sessionId === req.sid);
    const f = path.join(hub.current.home, '.ravenry', 'events', `${req.sid}.jsonl`);
    const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const base = prev[prev.length - 1] || {};
    const keep = Object.fromEntries(['session_id', 'cwd', 'transcript_path', 'workspace_id', 'surface_id', 'terminal', 'claude_pid'].filter((k) => base[k] != null).map((k) => [k, base[k]]));
    for (const e of req.events || []) fs.appendFileSync(f, JSON.stringify({ ...keep, at: new Date().toISOString(), ...e }) + '\n');
    ans.found = !!s;
  }
  if (req.do === 'brief') {
    const f = path.join(hub.current.root, req.project, 'BRIEF.md');
    if (req.append) fs.appendFileSync(f, req.append);
    if (req.replace) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(req.replace[0], req.replace[1]));
    ans.text = fs.readFileSync(f, 'utf8');
  }
  if (req.do === 'marker') {
    const d = path.join(hub.current.home, '.ravenry', 'handoffs');
    fs.mkdirSync(d, { recursive: true });
    // With `error` (and `question`, `command`): a hand-off whose fresh session did not start, as the hub records one.
    const failed = req.error ? { resumeStartedAt: new Date().toISOString(), resumeError: req.error, resumeQuestion: req.question || null, resumeCommand: req.command || null } : {};
    fs.writeFileSync(path.join(d, `${req.sid}.json`), JSON.stringify({ sessionId: req.sid, state: 'written', writtenAt: new Date().toISOString(), cwd: req.cwd, folder: req.cwd, surfaceId: req.surfaceId || null, workspaceId: req.workspaceId || null, handoffFile: path.join(req.cwd, 'BRIEF.md'), ...failed, history: [{ state: 'written', at: new Date().toISOString() }] }, null, 2));
  }
  if (req.do === 'pane') {
    // A pane's screen as the daemon holds it, and what each stand-in was asked.
    try { ans.screen = execFileSync(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['capture', '--socket', sock, req.pane], { env, encoding: 'utf8', timeout: 5000 }); } catch (e) { ans.screen = ''; ans.error = String(e.message).slice(0, 200); }
  }
  if (req.do === 'log') ans.text = fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8') : '';
  if (req.do === 'file') { ans.exists = fs.existsSync(req.path); ans.size = ans.exists ? fs.statSync(req.path).size : 0; }
  if (req.do === 'git') {
    try { ans.worktrees = execFileSync('git', ['-C', req.repo, 'worktree', 'list'], { encoding: 'utf8' }); } catch (e) { ans.worktrees = ''; }
    try { ans.branches = execFileSync('git', ['-C', req.repo, 'branch', '--list'], { encoding: 'utf8' }); } catch (e) { ans.branches = ''; }
    try { ans.head = execFileSync('git', ['-C', req.repo, 'log', '--oneline', '-1', 'main'], { encoding: 'utf8' }).trim(); } catch { ans.head = ''; }
  }
  if (req.do === 'open') ans.text = (() => { try { return fs.readFileSync(path.join(path.dirname(hub.current.home), 'open.jsonl'), 'utf8'); } catch { return ''; } })();
  if (req.do === 'endcmux') {
    // A session in cmux ends there: its process gone from ps, its SessionEnd in its events.
    const ps = JSON.parse(fs.readFileSync(hub.current.ps, 'utf8'));
    fs.writeFileSync(hub.current.ps, JSON.stringify(ps.filter((p) => !String(p.command || '').includes(req.sid))));
    const f = path.join(hub.current.home, '.ravenry', 'events', `${req.sid}.jsonl`);
    const last = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop()) : {};
    fs.appendFileSync(f, JSON.stringify({ ...last, at: new Date().toISOString(), event: 'SessionEnd', reason: 'prompt_input_exit' }) + '\n');
    ans.ended = true;
  }
  if (req.do === 'wenton') {
    // The conversation goes on in another process, in cmux: listed as ps lists it, its hooks after the pane's.
    const { spawn } = await import('node:child_process');
    const p = spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: false });
    const ps = JSON.parse(fs.readFileSync(hub.current.ps, 'utf8'));
    const WS = '3A000000-0000-4000-8000-0000000000C1', SF = '5F000000-0000-4000-8000-0000000000C1';
    ps.push({ pid: p.pid, ppid: 1, rssKb: 200000, startedAt: new Date().toISOString(), command: `claude --resume ${req.sid}`, cwd: req.cwd, env: `TERM_PROGRAM=ghostty CMUX_WORKSPACE_ID=${WS} CMUX_SURFACE_ID=${SF}` });
    fs.writeFileSync(hub.current.ps, JSON.stringify(ps));
    const f = path.join(hub.current.home, '.ravenry', 'events', `${req.sid}.jsonl`);
    const ev = (event, extra = {}) => JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), event, session_id: req.sid, cwd: req.cwd, terminal: 'cmux', workspace_id: WS, surface_id: SF, claude_pid: p.pid, ...extra });
    fs.appendFileSync(f, [ev('SessionStart', { source: 'resume' }), ev('UserPromptSubmit', { prompt: 'Go on from here' }), ev('Stop', { ends_on_question: false, background_tasks: 0 })].join('\n') + '\n');
    if (ctxDaemon.sock) { try { execFileSync(ctxDaemon.bin, ['new', '--socket', ctxDaemon.sock, '--json', '--', '/bin/sleep', '15'], { env: ctxDaemon.env, stdio: 'ignore' }); } catch { /* the next tick */ } }
    ans.pid = p.pid;
  }
  if (req.do === 'hubdown') { hub.current.stop(); ans.stopped = true; }
  if (req.do === 'hubup') { await startHub(); ans.url = hub.current.url; }
  return ans;
}

/** The driver's side of the app's asks (<result>.do-N), one at a time. */
export function sessbDriver(ctx) {
  let seen = 0;
  if (ctx.sock) Object.assign(ctxDaemon, { sock: ctx.sock, env: ctx.env, bin: path.join(ctx.APP, 'Contents', 'MacOS', 'ravenryd') });
  return async (result) => {
    try { listStandIns(ctx.hub.current, ctx.sb); } catch { /* the next turn */ }
    const f = `${result}.do-${seen + 1}`;
    if (!fs.existsSync(f)) return;
    seen++;
    let req = {};
    try { req = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* empty */ }
    const ans = { ok: true };
    try {
      if (req.do === 'arrive') {
        for (const id of req.projects || []) { try { await ctx.hub.current.arrive(id, req.question); ans.project = id; break; } catch (e) { (ans.errors ||= []).push(`${id}: ${e.message}`); } }
      } else Object.assign(ans, await sessbDo(req, ctx));
    } catch (e) { ans.ok = false; ans.error = String(e.message || e); }
    // Whole or not at all: the app reads the answer as soon as the file is
    // there, and a long one (the stand-ins' log) was read half written under
    // load, as no stand-in at all (sb_revive_runs_on_brief took an older one).
    fs.writeFileSync(`${result}.done-${seen}.part`, JSON.stringify(ans));
    fs.renameSync(`${result}.done-${seen}.part`, `${result}.done-${seen}`);
  };
}

/**
 * --screen sessb2: the app started with no board (a new data folder, a
 * daemon with no pane), then the board comes up on the port it was given
 * when the app asks ("hubup"). Returns the app's checks.
 */
export async function sessbSecond({ EXE, APP, env, tmp, OUT, startDemoHub, spawn, sleep }) {
  const run2 = path.join(tmp, 'run2'), state2 = path.join(tmp, 'state2'), desk2 = path.join(tmp, 'desktop2');
  for (const d of [run2, state2, desk2]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const env2 = { ...env, RAVENRY_RUNTIME_DIR: run2, RAVENRY_STATE_DIR: state2, RAVENRY_DESKTOP_DATA: desk2 };
  const d2 = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env: env2, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon2.log'), 'w')] });
  let sock2 = null;
  for (let i = 0; i < 100 && !sock2; i++) { const n = fs.readdirSync(run2).find((x) => /^ravenryd-.+\.sock$/.test(x)); if (n) sock2 = path.join(run2, n); else await sleep(50); }
  const port2 = await freePort();
  const r2 = path.join(OUT, 'sidetest-sessb2.json');
  fs.rmSync(r2, { force: true });
  const ref = { current: { stop() {} } };
  const drive = sessbDriver({ hub: ref, startHub: async () => { ref.current = await startDemoHub({ dir: path.join(tmp, 'hub2'), port: port2, empty: true }); } });
  const a = spawn(EXE, ['--offscreen', '--socket', sock2, '--sidetest', r2, '--screen', 'sessb2'], { env: { ...env2, RAVENRY_HUB_URL: `http://127.0.0.1:${port2}` }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app-sessb2.log'), 'w')] });
  let done = false;
  a.on('exit', () => { done = true; });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 180000) { await drive(r2); await sleep(50); }
  if (!done) a.kill();
  try { ref.current.stop(); } catch { /* none */ }
  d2.kill();
  try { return JSON.parse(fs.readFileSync(r2, 'utf8')).checks || []; } catch { return [{ name: 'sb2_ran', ok: false, detail: 'no result' }]; }
}

/** --screen sessb3: the app started again on the same data folder, daemon and board (the relaunch). */
export async function sessbThird({ EXE, env, sock, url, OUT, tmp, spawn, sleep }) {
  const r3 = path.join(OUT, 'sidetest-sessb3.json');
  fs.rmSync(r3, { force: true });
  const a = spawn(EXE, ['--offscreen', '--socket', sock, '--sidetest', r3, '--screen', 'sessb3'], { env: { ...env, RAVENRY_HUB_URL: url }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'app-sessb3.log'), 'w')] });
  let done = false;
  a.on('exit', () => { done = true; });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 120000) await sleep(100);
  if (!done) a.kill();
  try { return JSON.parse(fs.readFileSync(r3, 'utf8')).checks || []; } catch { return [{ name: 'sb3_ran', ok: false, detail: 'no result' }]; }
}
