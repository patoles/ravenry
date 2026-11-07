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
//
// Usage: node hub/tools/startup-load-test.mjs [--exe APP_EXECUTABLE --hub HUB_DIR]
//   (the packaged app's hub: its executable as Node, ELECTRON_RUN_AS_NODE=1)
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
  for (let i = 0; i < 23; i++) {
    const name = `project-${i}`;
    const dir = path.join(root, 'proj', name);
    const files = i < 5 ? 30000 : 5000;
    for (let f = 0; f < files; f++) { const d = path.join(dir, 'src', `d${f % 300}`, `e${f % 7}`); if (f < 2100) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `f${f}.ts`), ''); }
    fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });
    for (let k = 0; k < 60; k++) fs.writeFileSync(path.join(dir, 'docs', k < 30 ? '' : 'plans', `PLAN-${k}.md`), `# Plan ${k}\n\n${Array.from({ length: 12 }, (_, j) => `- [${j % 3 ? ' ' : 'x'}] step ${j}`).join('\n')}\n`);
    for (let k = 0; k < 20; k++) fs.writeFileSync(path.join(dir, `NOTES-${k}.md`), `# Notes ${k}\n- [ ] a\n- [x] b\n`);
    fs.writeFileSync(path.join(dir, 'BRIEF.md'), `# ${name}\n\nGoal: A thing that works.\n\n## Next step\n- Make it faster.\n`);
    git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', 'BRIEF.md', 'docs', '.'); git(dir, 'commit', '-q', '-m', 'start');
    projects.push({ id: name, name, folder: dir, brief: 'BRIEF.md' });
  }
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
  fs.writeFileSync(path.join(root, 'ps.json'), JSON.stringify(procs));
  fs.writeFileSync(path.join(root, 'cmux.json'), JSON.stringify({ workspaces: [], screens: {} }));
  console.log(`made the data in ${Math.round((Date.now() - t0) / 1000)} s: 23 projects, 240,000 files, 1,840 plan files, 20 sessions of 20 MB`);

  const free = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const port = await free();
  const T = (p) => path.join(HERE, p);
  fs.mkdirSync(path.join(root, 'run'), { mode: 0o700 });
  const env = {
    HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', PORT: String(port), RAVENRY_PHONE_PORT: String(await free()),
    RAVENRY_TERMINAL: 'ravenry', RAVENRY_RUNTIME_DIR: path.join(root, 'run'), RAVENRY_STATE_DIR: path.join(root, 'state'),
    MC_PS_BIN: T('stub-ps.mjs'), MC_LSOF_BIN: T('stub-ps.mjs'), STUB_PS_STATE: path.join(root, 'ps.json'), CMUX_BIN: T('fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(root, 'cmux.json'),
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, T('stub-open.mjs')]), STUB_OPEN_LOG: path.join(root, 'open.jsonl'), MC_PHONE_LAN: 'none', MC_CODEX: '0',
    ...(EXE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  const started = Date.now();
  let listenAt = null;
  let out = '';
  // STARTUP_PROF=<dir>: a CPU profile of the hub (Node only).
  const prof = !EXE && process.env.STARTUP_PROF ? ['--cpu-prof', '--cpu-prof-dir', process.env.STARTUP_PROF] : [];
  const child = spawn(EXE || process.execPath, [...prof, path.join(HUB, 'server', 'index.mjs')], { env, cwd: HUB, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; if (!listenAt && /Ravenry on http/.test(out)) listenAt = Date.now(); });
  child.stderr.on('data', (d) => { out += d; });
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
      const end = listenAt + 30000;
      while (Date.now() < end) {
        const a = Date.now();
        const c = await ask('/api/state');
        const ms = Date.now() - a;
        if (ms > worst.ms) worst = { ms, at: a - listenAt };
        if (c === 200 && ready == null) ready = Date.now() - listenAt;
        await new Promise((r) => setTimeout(r, 100));
      }
      void s;
      check('no answer in its first 30 s takes over 1 s', worst.ms <= 1000, `slowest ${worst.ms} ms, ${worst.at} ms after listen`);
      check('its state is ready within 10 s', ready != null && ready <= 10000, `${ready} ms after listen`);
      console.log(`MEASURE startup-load firstAnswerMs=${first} slowestMs=${worst.ms} stateReadyMs=${ready}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (fails) console.log(out.split('\n').slice(-15).join('\n'));
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
