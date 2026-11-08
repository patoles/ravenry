#!/usr/bin/env node
// The hub answers at once after it listens, whatever the data (2026-11-07:
// the 0.1.11 update rolled back because the new hub, on a real set of 23
// projects, printed its listen line and then answered nothing for 30 s; its
// first tick ran two git commands per plan file on the main thread).
//
// A made-up set of the same size: 23 projects (5 of 30,000 files, 18 of
// 5,000), each a git repository with 80 committed plan files in its root and
// docs/; 20 sessions with 20 MB transcripts full of tool calls, live in the
// stub process list. The hub starts on it, and:
//   - its first HTTP answer comes within 1 s of its listen line;
//   - no answer in its first 30 s takes over 1 s (a request every 100 ms);
//   - its state is ready (200) within 10 s.
// The hub runs beside a busy Mac: 4 panes print without a pause (STARTUP_BUSY).
// And a ravenryd beside it whose report ring is full (2,100 reports of about
// 8 KB, 16 MB, which the hub reads back at start in pages of 1,000): a big
// reply read over the socket in a unix socket's small chunks once took the
// hub's main thread for seconds (the node client concatenated its whole
// buffer at each chunk; 2026-11-07, 0.1.12's update that rolled back).
//
// And the session of 2026-11-07 that held 0.1.14's hub for 40 s: a 70 MB
// transcript holding 200 Agent, Task and Monitor launches and their finished
// notifications, 10 subagent transcripts, and 761 hook reports for it in the
// daemon's ring, a Stop in every 5 listing 26 background tasks. The hub read
// the transcript's last 64 MB again for each such Stop. Now:
//   - its first state is ready within 3 s of its listen line;
//   - its main thread is never held over 200 ms in the first 30 s (the
//     hub's own stall lines, RAVENRY_STALL_MS=200);
//   - the board's count of that session's running tasks is right.
//
// Usage: node hub/tools/startup-load-test.mjs [--exe APP_EXECUTABLE --hub HUB_DIR]
//   (the packaged app's hub: its executable as Node, ELECTRON_RUN_AS_NODE=1)
//   --ravenryd BIN: the daemon (else RAVENRYD_BIN, else daemon/ravenryd)
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { guardSpawns } from '../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const EXE = opt('--exe');
const HUB = path.resolve(opt('--hub') || path.join(HERE, '..'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvload-'));
const home = path.join(root, 'h');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const git = (dir, ...a) => execFileSync('/usr/bin/git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' });

try {
  const t0 = Date.now();
  fs.mkdirSync(path.join(home, '.ravenry', 'events'), { recursive: true });
  const projects = [];
  // The 23 projects' folders (240,000 files, in git) are made once per
  // machine and kept: made and removed at each run, they set macOS's
  // file-event service to work on every core for a minute and more, which
  // took the processor from the hub under test (2026-11-08: stalls where
  // the hub itself ran 110 ms of 368). Made again when not whole or changed.
  const CACHE = path.join(os.tmpdir(), 'rvload-projects-v1');
  const cached = fs.existsSync(path.join(CACHE, 'done')) && (() => { try { return Array.from({ length: 23 }, (_, i) => execFileSync('/usr/bin/git', ['-C', path.join(CACHE, `project-${i}`), 'status', '--porcelain'], { encoding: 'utf8' })).every((x) => x === ''); } catch { return false; } })();
  if (!cached) fs.rmSync(CACHE, { recursive: true, force: true });
  for (let i = 0; i < 23; i++) {
    const name = `project-${i}`;
    const dir = path.join(CACHE, name);
    if (cached) { projects.push({ id: name, name, folder: dir, brief: 'BRIEF.md' }); continue; }
    const files = i < 5 ? 30000 : 5000;
    for (let f = 0; f < files; f++) { const d = path.join(dir, 'src', `d${f % 300}`, `e${f % 7}`); if (f < 2100) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `f${f}.ts`), ''); }
    fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
    for (let k = 0; k < 60; k++) fs.writeFileSync(path.join(dir, 'docs', k < 30 ? '' : 'plans', `PLAN-${k}.md`), `# Plan ${k}\n\n${Array.from({ length: 12 }, (_, j) => `- [${j % 3 ? ' ' : 'x'}] step ${j}`).join('\n')}\n`);
    for (let k = 0; k < 20; k++) fs.writeFileSync(path.join(dir, `NOTES-${k}.md`), `# Notes ${k}\n- [ ] a\n- [x] b\n`);
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), `# ${name}\n\nGoal: A thing that works.\n\n## Next step\n- Make it faster.\n`);
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', 'BRIEF.md', 'docs', '.'); git(dir, 'commit', '-q', '-m', 'start');
    projects.push({ id: name, name, folder: dir, brief: 'BRIEF.md' });
  }
  if (!cached) fs.writeFileSync(path.join(CACHE, 'done'), '');
  console.log(cached ? `the projects' folders: kept from an earlier run (${CACHE})` : 'the projects\' folders: made, and kept for the next run');
  fs.writeFileSync(path.join(home, '.ravenry', 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects }, null, 2));
  // 20 sessions, 20 MB each, live.
  const procs = [];
  const line = (cwd, sid, k) => JSON.stringify({ type: 'assistant', cwd, sessionId: sid, timestamp: new Date(Date.now() - 3600e3 + k).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'src', `d${k % 300}`, `e${k % 7}`, `f${k}.ts`) } }, { type: 'text', text: 'x'.repeat(400) }] } });
  for (let i = 0; i < 20; i++) {
    const sid = `5e55107e-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const cwd = projects[i].folder;
    const tdir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    fs.mkdirSync(tdir, { recursive: true });
    const tr = path.join(tdir, `${sid}.jsonl`);
    const fd = fs.openSync(tr, 'w');
    let size = 0;
    for (let k = 0; size < 20 * 1024 * 1024; k++) { const l = line(cwd, sid, k) + '\n'; fs.writeSync(fd, l); size += l.length; }
    fs.closeSync(fd);
    const at = (m) => new Date(Date.now() - m * 60000).toISOString();
    const ev = (event, m) => JSON.stringify({ at: at(m), event, session_id: sid, assistant: 'claude', cwd, transcript_path: tr, claude_pid: 90000 + i, terminal: 'iterm' });
    fs.writeFileSync(path.join(home, '.ravenry', 'events', `${sid}.jsonl`), [ev('SessionStart', 60), ev('UserPromptSubmit', 5), ev('Stop', 4)].join('\n') + '\n');
    procs.push({ pid: 90000 + i, ppid: 1, rssKb: 400000, startedAt: at(60), command: `claude --resume ${sid}`, cwd, env: 'TERM_PROGRAM=iTerm.app' });
  }
  // The big session: 70 MB, 200 launches (120 agents, 40 shells, 40
  // monitors), every 12th still running, one finished agent resumed later.
  const bigSid = '5e55107e-0000-4000-8000-0000000000bb';
  const bigCwd = projects[20].folder;
  const bigDir = path.join(home, '.claude', 'projects', bigCwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(bigDir, { recursive: true });
  const bigTr = path.join(bigDir, `${bigSid}.jsonl`);
  const hex = (k, n) => k.toString(16).padStart(n, '0');
  const launches = Array.from({ length: 200 }, (_, k) => (k < 120 ? { id: `a${hex(k, 16)}`, type: 'subagent' } : k < 160 ? { id: `b${hex(k, 8)}`, type: 'shell' } : { id: `m${hex(k, 8)}`, type: 'monitor' }));
  const rec = (role, content, k) => JSON.stringify({ type: role, cwd: bigCwd, sessionId: bigSid, timestamp: new Date(Date.now() - 7200e3 + k).toISOString(), message: { role, content } }) + '\n';
  const launchLine = (t, k) => (t.type === 'monitor'
    ? rec('user', [{ type: 'tool_result', tool_use_id: `toolu_${k}`, content: `Monitor started (task ${t.id}, timeout 3600000ms). You will be notified on each event.` }], k)
    : t.type === 'shell'
      ? rec('user', [{ type: 'tool_result', tool_use_id: `toolu_${k}`, content: `Command running in background with ID: ${t.id}` }], k)
      : rec('assistant', [{ type: 'tool_use', id: `toolu_${k}`, name: 'Agent', input: { description: `Part ${k}`, prompt: 'Do the part.', run_in_background: true } }], k) + rec('user', [{ type: 'tool_result', tool_use_id: `toolu_${k}`, content: `Async agent launched successfully. agentId: ${t.id}` }], k));
  const noteLine = (t, k) => rec('user', `<task-notification>\n<task-id>${t.id}</task-id>\n<status>completed</status>\n<summary>Part done</summary>\n</task-notification>`, k);
  const running = new Set(launches.filter((_, k) => k % 12 === 5).map((t) => t.id));
  const resumed = launches[7].id; // finished, then resumed by a SendMessage
  running.add(resumed);
  {
    const fd = fs.openSync(bigTr, 'w');
    let size = 0;
    const put = (l) => { fs.writeSync(fd, l); size += Buffer.byteLength(l); };
    const per = Math.floor(70 * 1024 * 1024 / 200);
    let k = 0;
    for (let n = 0; n < 200; n++) {
      put(launchLine(launches[n], k++));
      // Its notification a few launches later, in the next stretch.
      if (n >= 3 && !running.has(launches[n - 3].id) || n >= 3 && launches[n - 3].id === resumed) put(noteLine(launches[n - 3], k++));
      if (n === 150) put(rec('assistant', [{ type: 'tool_use', id: 'toolu_resume', name: 'SendMessage', input: { to: resumed, message: 'one more thing' } }], k++).replace(/"to": ?"/, '"to":"'));
      while (size < per * (n + 1)) put(line(bigCwd, bigSid, k++) + '\n');
    }
    for (const t of launches.slice(197)) if (!running.has(t.id)) put(noteLine(t, k++));
    fs.closeSync(fd);
  }
  // 10 subagents' transcripts, 1 MB each.
  const subDir = path.join(bigDir, bigSid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (let i = 0; i < 10; i++) {
    let body = '';
    while (body.length < 1024 * 1024) body += line(bigCwd, bigSid, i) + '\n';
    fs.writeFileSync(path.join(subDir, `agent-${launches[i * 11].id}.jsonl`), body);
  }
  // What each Stop lists as in flight: every running one, 6 finished ones
  // Claude Code still holds, 2 watches no Monitor call started, and a
  // shell named nowhere (running, as Claude Code says).
  const listed = [...launches.filter((t) => running.has(t.id)), ...launches.filter((t) => !running.has(t.id)).slice(20, 26), { id: 'mwatch01', type: 'monitor' }, { id: 'mwatch02', type: 'monitor' }, { id: 'bnowhere', type: 'shell' }]
    .map((t) => ({ id: t.id, type: t.type, status: 'running', ...(t.type === 'subagent' ? { agent_type: 'general-purpose' } : {}) }));
  const bigRunning = running.size + 1;
  procs.push({ pid: 90100, ppid: 1, rssKb: 900000, startedAt: new Date(Date.now() - 7200e3).toISOString(), command: `claude --resume ${bigSid}`, cwd: bigCwd, env: 'TERM_PROGRAM=ravenry' });
  console.log(`the big session: ${Math.round(fs.statSync(bigTr).size / 1048576)} MB, 200 launches, ${listed.length} tasks listed at each Stop, ${bigRunning} really running`);
  fs.writeFileSync(path.join(root, 'ps.json'), JSON.stringify(procs));
  fs.writeFileSync(path.join(root, 'cmux.json'), JSON.stringify({ workspaces: [], screens: {} }));
  // The 20 sessions say they run in iTerm2: the stand-in answers for it,
  // never the person's own (it once waited 6 s on osascript at each tick).
  fs.writeFileSync(path.join(root, 'iterm.json'), JSON.stringify({ running: true, sessions: [], screens: {} }));
  console.log(`made the data in ${Math.round((Date.now() - t0) / 1000)} s: 23 projects, 240,000 files, 1,840 plan files, 20 sessions of 20 MB`);

  // The daemon, its report ring full.
  const BIN = path.resolve(opt('--ravenryd') || process.env.RAVENRYD_BIN || path.join(HERE, '..', '..', 'daemon', 'ravenryd'));
  const rt = path.join(root, 'run');
  fs.mkdirSync(rt, { mode: 0o700 });
  const denv = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'dstate') };
  execFileSync(BIN, ['serve', '--detach'], { env: denv, stdio: 'ignore' });
  const { connectSocket } = await import(path.join(HERE, '..', '..', 'packages', 'node-client', 'index.mjs'));
  let sock = null;
  for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
  const dc = await connectSocket(sock, { name: 'startup-load-test' });
  const { pane } = await dc.request('pane.new', { command: ['/bin/sh', '-c', 'exec sleep 900'], cols: 80, rows: 24 });
  // Panes that print all the time, as busy sessions do.
  for (let i = 0; i < (process.env.STARTUP_BUSY ? Number(process.env.STARTUP_BUSY) : 4); i++) await dc.request('pane.new', { command: ['/bin/sh', '-c', `while :; do head -c 600 /dev/urandom | base64; done`], cols: 120, rows: 40 });
  const big = { cwd: '/' + 'c'.repeat(4000), transcript_path: '/' + 't'.repeat(4000) };
  for (let i = 0; i < 2100; i++) await dc.request('agent.report', { pane: pane.id, assistant: 'claude', event: 'PostToolUse', session: procs[0].command.split(' ').pop(), data: { hook_event_name: 'PostToolUse', session_id: procs[0].command.split(' ').pop(), tool_name: 'Read', ...big } });
  // 761 reports for the big session after them, as its daemon kept them.
  // The last one a Stop, as a session at rest leaves it.
  const kinds = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUse', 'Stop'];
  for (let i = 0; i < 761; i++) {
    const event = kinds[(i + 4) % 5];
    // The session's last Stop comes after its turn, not in the same instant
    // as its prompt (the board orders a session's events by their times).
    if (i === 760) await new Promise((r) => setTimeout(r, 1100));
    const data = { hook_event_name: event, session_id: bigSid, cwd: bigCwd, transcript_path: bigTr, ...(event.endsWith('ToolUse') ? { tool_name: 'Bash' } : {}), ...(event === 'Stop' ? { background_tasks: listed, last_assistant_message: '' } : {}) };
    await dc.request('agent.report', { pane: pane.id, assistant: 'claude', event, session: bigSid, pid: 90100, cwd: bigCwd, data });
  }
  const backlog = await dc.request('agent.events', { since: 0, limit: 1000 });
  dc.close();
  console.log(`a ravenryd with ${backlog.reports.length}+ reports in its ring, ${Math.round(JSON.stringify(backlog).length / 1048576)} MB in its first page`);

  // The files made above (240,000 of them) set macOS's file-event service
  // (fseventsd) to work for many seconds, on every core it can take: on a
  // real Mac those files were there long before the hub started. Started
  // only once that has settled (its CPU under 25% for 2 s, 30 s at most), so
  // the hub is measured beside the busy panes, not beside this test's set-up.
  if (process.platform === 'darwin') {
    const t0 = Date.now();
    let calm = 0;
    while (Date.now() - t0 < 30000 && calm < 4) {
      let pct = 0;
      try { pct = execFileSync('/bin/ps', ['-A', '-o', '%cpu=,comm='], { encoding: 'utf8' }).split('\n').filter((l) => /fseventsd$/.test(l.trim())).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0]) || n, 0); } catch { /* none */ }
      calm = pct < 25 ? calm + 1 : 0;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`the file-event service settled ${Date.now() - t0} ms after the set-up`);
  }
  const free = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const port = await free();
  const T = (p) => path.join(HERE, p);
  const env = {
    HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', PORT: String(port), RAVENRY_PHONE_PORT: String(await free()),
    RAVENRY_TERMINAL: 'ravenry', RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'state'),
    MC_PS_BIN: T('stub-ps.mjs'), MC_LSOF_BIN: T('stub-ps.mjs'), STUB_PS_STATE: path.join(root, 'ps.json'), CMUX_BIN: T('fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(root, 'cmux.json'),
    ITERM_OSASCRIPT_BIN: T('fake-iterm.mjs'), RAVENRY_ITERM_PYTHON: T('fake-iterm.mjs'), FAKE_ITERM_STATE: path.join(root, 'iterm.json'), MC_OSASCRIPT_BIN: T('stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(root, 'osascript.jsonl'),
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, T('stub-open.mjs')]), STUB_OPEN_LOG: path.join(root, 'open.jsonl'), MC_PHONE_LAN: 'none', MC_CODEX: '0',
    // As the app's service runs it: its start-up record and the CPU profile.
    RAVENRY_HUB_SERVICE: '1', RAVENRY_APP_VERSION: 'load-test', RAVENRY_STALL_MS: process.env.STARTUP_STALL_MS || '50',
    ...(EXE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  const started = Date.now();
  let listenAt = null;
  let out = '';
  let slowestStall = 0;
  let slowestOwn = 0;
  // STARTUP_PROF=<dir>: a CPU profile of the hub (Node only).
  const prof = !EXE && process.env.STARTUP_PROF ? ['--cpu-prof', '--cpu-prof-dir', process.env.STARTUP_PROF] : [];
  const child = spawn(EXE || process.execPath, [...prof, path.join(HUB, 'server', 'index.mjs')], { env, cwd: HUB, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; if (!listenAt && /Ravenry on http/.test(out)) listenAt = Date.now(); });
  child.stderr.on('data', (d) => { out += d; });
  const getText = (p) => new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: p, timeout: 10000 }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => r(b)); }); q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); }); });
  const ask = (p, ms = 30000) => new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: p, timeout: ms }, (res) => { res.resume(); res.on('end', () => r(res.statusCode)); }); q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); }); });
  try {
    while (!listenAt && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 5));
    check('the hub listens', !!listenAt, `${listenAt ? listenAt - started : '-'} ms after it started`);
    if (listenAt) {
      const s = Date.now();
      const code = await ask('/api/state');
      const first = Date.now() - listenAt;
      check('its first HTTP answer comes within 1 s of its listen line', first <= 1000 && code != null, `${first} ms, ${code}`);
      let ready = null;
      let worst = { ms: 0, at: 0 };
      let tasksRight = null;
      let tasksSeen = null;
      let lastBody = null;
      const end = listenAt + 30000;
      while (Date.now() < end) {
        const a = Date.now();
        const c = await ask('/api/state');
        const ms = Date.now() - a;
        if (ms > worst.ms) worst = { ms, at: a - listenAt };
        if (c === 200 && ready == null) ready = Date.now() - listenAt;
        if (c === 200 && tasksRight == null) {
          const body = await getText('/api/state');
          lastBody = body;
          const m = body && body.match(new RegExp(`"sessionId":"${bigSid}"[^]*?waiting on (\\d+) background task`));
          tasksSeen = m ? Number(m[1]) : tasksSeen;
          if (m && Number(m[1]) === bigRunning) tasksRight = Date.now() - listenAt;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      void s;
      check('no answer in its first 30 s takes over 1 s', worst.ms <= 1000, `slowest ${worst.ms} ms, ${worst.at} ms after listen`);
      check('its first state is ready within 3 s', ready != null && ready <= 3000, `${ready} ms after listen`);
      // Every hold over 50 ms is said (RAVENRY_STALL_MS=50), so the slowest
      // is measured, with how much of it the hub itself ran ("it ran X ms
      // of Y": its process's CPU time in that stretch). The gate is the
      // hub's own hold, at most what it ran: on a busy Mac (load average
      // 25 to 57 on 10 cores, 2026-11-08) the system took the processor
      // from it for up to 500 ms while it ran 80, and no code of the hub's
      // can hold what it is not given. The wall-clock stall is reported.
      const held = (l) => Number((l.match(/held (\d+) ms/) || [])[1]);
      const ran = (l) => { const m = l.match(/it ran (\d+) ms of/); return m ? Number(m[1]) : held(l); };
      const own = (l) => Math.min(held(l), ran(l));
      const early = out.split('\n').filter((l) => /^stall:/.test(l) && Number((l.match(/(\d+) ms after start/) || [])[1]) <= (listenAt - started) + 30000);
      const stalls = early.filter((l) => own(l) > 200);
      slowestStall = early.reduce((m, l) => Math.max(m, held(l)), 0);
      slowestOwn = early.reduce((m, l) => Math.max(m, own(l)), 0);
      check('its main thread is never held over 200 ms by the hub itself in its first 30 s', !stalls.length, stalls.slice(0, 5).join(' | ') || 'none');
      check(`the big session's running tasks are counted right (${bigRunning} of the ${listed.length} listed) within 30 s`, tasksRight != null, tasksRight != null ? `${tasksRight} ms after listen` : `saw ${tasksSeen}`);
      if (tasksRight == null && lastBody) {
        // What the state says of that session, to read why.
        try {
          const j = JSON.parse(lastBody);
          const hits = [];
          const walk = (v) => { if (v && typeof v === 'object') { if (v.sessionId === bigSid) hits.push(v); for (const x of Object.values(v)) walk(x); } };
          walk(j);
          console.log('the big session in the state: ' + JSON.stringify(hits.slice(0, 2)).slice(0, 3000));
        } catch (e) { console.log('state unreadable: ' + e.message); }
      }
      const replay = (out.match(/start: daemon [^\n]*: (\d+) reports taken in (\d+) ms/g) || []).join('; ');
      console.log(`MEASURE startup-load firstAnswerMs=${first} slowestMs=${worst.ms} stateReadyMs=${ready} stalls=${stalls.length} tasksRightMs=${tasksRight} slowestStallMs=${slowestStall} slowestOwnStallMs=${slowestOwn}`);
      console.log(`replay: ${replay}`);
      // The hub's own record of its start (hub/server/startlog.mjs).
      const rec = out.split('\n').filter((l) => /^(start:|stall:|tick \d phases)/.test(l));
      console.log(rec.join('\n'));
      const prof = path.join(home, 'Library', 'Logs', 'Ravenry');
      const parts = fs.existsSync(prof) ? fs.readdirSync(prof).filter((f) => f.endsWith('.cpuprofile')) : [];
      check('the hub writes its start-up CPU profile in parts as it goes', process.platform !== 'darwin' || parts.some((f) => /^start-load-test\.\d+-\d+s\.cpuprofile$/.test(f)), parts.join(', ') || 'none');
      check('the hub logs each phase of its first ticks', rec.some((l) => /^tick 1 phases \(ms\): registry \d+, /.test(l)), rec.find((l) => l.startsWith('tick 1')) || 'none');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (fails) console.log(out.split('\n').slice(-15).join('\n'));
    // STARTUP_KEEP=<dir>: the hub's log folder (its CPU profile) and output kept there, to read a stall.
    if (process.env.STARTUP_KEEP) { try { fs.cpSync(path.join(home, 'Library', 'Logs', 'Ravenry'), process.env.STARTUP_KEEP, { recursive: true }); fs.writeFileSync(path.join(process.env.STARTUP_KEEP, 'hub-out.txt'), out); } catch { /* none */ } }
  }
} finally {
  try { const ds = JSON.parse(execFileSync(path.resolve(opt('--ravenryd') || process.env.RAVENRYD_BIN || path.join(HERE, '..', '..', 'daemon', 'ravenryd')), ['daemons', '--json', '--no-start'], { env: { HOME: home, PATH: '/usr/bin:/bin', RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'dstate') }, encoding: 'utf8' })); for (const d of ds) process.kill(d.pid, 'SIGTERM'); } catch { /* none */ }
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
