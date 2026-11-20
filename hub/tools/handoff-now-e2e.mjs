// Hand off now on sessions at rest, end to end through the hub's
// POST /api/handoff (server/index.mjs requestHandoff, server/handoffnow.mjs):
// a throwaway demo board (apps/desktop/tools/demo-hub.mjs) following a
// throwaway ravenryd (its own HOME, runtime and state folders), with three
// sessions in real panes of that daemon. Each pane reports through
// `ravenryd hook` (started, a prompt, stopped: at rest) and then runs
// tools/fake-claude.mjs, which draws Claude Code's prompt box and prints
// every line it receives. No real pane, board or data is touched.
//
//   paper-boat:     asked in its chat to hand off, it wrote the hand-off and
//                   finished (the 2026-11-20 case): Hand off now counts it as
//                   written, and nothing is typed.
//   notes-app:      not written, at an empty prompt: the hook's request is
//                   typed now; the marker is requested.
//   garden-planner: not written, with text typed in its prompt: nothing is
//                   typed; it waits for its next stop, as before.
//
// Needs ravenryd: RAVENRYD_BIN, else ../daemon/ravenryd.
// Usage: node tools/handoff-now-e2e.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  handoff-now-e2e: no ravenryd at ${BIN}`); process.exit(0); }
const WORK = path.join(ROOT, '.tmp', 'handoff-now-e2e');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
// The daemon's runtime folder: short, outside the repo (a unix socket path is limited to about 100 bytes).
const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-'));
fs.chmodSync(RT, 0o700);
const DHOME = path.join(WORK, 'daemon-home');
fs.mkdirSync(DHOME, { recursive: true });
const DENV = withTestHome({ HOME: DHOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'daemon-state') });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const stamp = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const cli = (...args) => execFileSync(BIN, args, { env: DENV, encoding: 'utf8' });

let hub = null;
try {
  execFileSync(BIN, ['serve', '--detach'], { env: DENV });
  hub = await startDemoHub({
    dir: path.join(WORK, 'demo'), port: await freePort(), runtime: RT,
    panes: ['paper-boat', 'notes-app', 'garden-planner'],
    env: { MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state') },
  });
  const S = hub.sessions;
  const HANDOFFS = path.join(hub.home, '.ravenry', 'handoffs');
  const marker = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(HANDOFFS, sid + '.json'), 'utf8')); } catch { return null; } };
  const rec = (s, type, extra, at) => JSON.stringify({ type, cwd: s.folder, sessionId: s.sid, timestamp: at, ...extra }) + '\n';
  const usage = { input_tokens: 8, cache_creation_input_tokens: 3000, cache_read_input_tokens: 200000, output_tokens: 300 };

  // Each transcript ends on a finished turn.
  for (const id of Object.keys(S)) fs.appendFileSync(S[id].transcript, rec(S[id], 'system', { subtype: 'turn_duration' }, ago(1)));
  // paper-boat: asked in its chat, it wrote the hand-off into its brief and finished.
  const PB = S['paper-boat'];
  const PB_BRIEF = path.join(PB.folder, 'BRIEF.md');
  fs.appendFileSync(PB.transcript, [
    rec(PB, 'user', { message: { role: 'user', content: 'I can hand off this session' } }, ago(0.6)),
    rec(PB, 'assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: PB_BRIEF, old_string: '## Next step', new_string: '## Hand-off' } }], usage } }, ago(0.5)),
    rec(PB, 'assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The hand-off is written in the brief.' }], usage } }, ago(0.4)),
    rec(PB, 'system', { subtype: 'turn_duration' }, ago(0.4)),
  ].join(''));
  fs.appendFileSync(PB_BRIEF, `\n## Hand-off\n- ${stamp(new Date())} The hull rocks with the waves; the rain is next.\n  - State: committed.\n`);

  // A pane per session: started, given a prompt and stopped (through ravenryd hook), then a prompt box.
  const panes = {};
  for (const id of Object.keys(S)) {
    const s = S[id];
    const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : ev === 'Stop' ? { stop_hook_active: false } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
    const f = path.join(WORK, `session-${id}.sh`);
    fs.writeFileSync(f, [hook('SessionStart'), hook('UserPromptSubmit'), hook('Stop'), `exec '${process.execPath}' '${path.join(ROOT, 'tools', 'fake-claude.mjs')}'`].join('\n') + '\n', { mode: 0o755 });
    panes[id] = cli('new', '--cwd', s.folder, '--name', id, '--size', '100x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', f).trim();
  }
  const capture = (id) => { try { return cli('capture', panes[id]); } catch (e) { return String(e.message); } };
  const sessionOf = (st, id) => (st.projects.find((p) => p.id === id)?.sessions || []).find((x) => x.sessionId === S[id].sid);
  // The board follows each one, at rest at its prompt.
  const ready = await until(async () => {
    const st = await hub.state();
    return Object.keys(S).every((id) => { const x = sessionOf(st, id); return x && x.live && !x.working && !x.dialog && /^ravenry:/.test(x.surfaceId) && /❯/.test(capture(id)); });
  }, 30000);
  const st0 = await hub.state();
  check('the board follows the three sessions, at rest in their panes', !!ready, Object.keys(S).map((id) => { const x = sessionOf(st0, id); return x ? { id, state: x.state, live: x.live, sf: x.surfaceId } : { id, missing: true }; }));

  // Text typed into garden-planner's prompt, not sent.
  cli('send', panes['garden-planner'], '--typed', 'also check the');
  await until(() => /❯ also check the/.test(capture('garden-planner')), 5000);

  const press = async (id) => {
    const st = await hub.state();
    const x = sessionOf(st, id);
    const r = await fetch(`${hub.url}/api/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ravenry': '1' }, body: JSON.stringify({ projectId: id, surfaceId: x && x.surfaceId }) });
    return { status: r.status, j: await r.json().catch(() => null) };
  };

  // 1. Written already: counted as written, nothing typed.
  const a = await press('paper-boat');
  const ma = marker(PB.sid);
  check('1. written since its last prompt: the answer says so', a.status === 200 && a.j.state === 'written' && a.j.delivered === 'written' && /already wrote its hand-off/.test(a.j.say), a);
  check('1. its marker is written, from its brief', ma && ma.state === 'written' && ma.handoffFile === PB_BRIEF && ma.cwd === PB.folder, ma);
  await sleep(500);
  check('1. nothing typed into its pane', !/received:/.test(capture('paper-boat')), capture('paper-boat').slice(-300));

  // 2. Not written, at an empty prompt: the request typed now.
  const b = await press('notes-app');
  const mb = marker(S['notes-app'].sid);
  check('2. asked now: the answer says so', b.status === 200 && b.j.state === 'requested' && b.j.delivered === 'now' && /Asked it to hand off now/.test(b.j.say), b);
  check('2. its marker records the ask', mb && mb.state === 'requested' && mb.asks === 1 && mb.askedBy === 'board' && mb.handoffFile === path.join(S['notes-app'].folder, 'BRIEF.md'), mb);
  const got = await until(() => /received: \[ravenry hand-off\]/.test(capture('notes-app')), 8000);
  check('2. the hook\'s request reached its prompt', !!got, capture('notes-app').slice(-400));

  // Text in the prompt: never typed into; at the next stop, as before.
  const c = await press('garden-planner');
  const mc = marker(S['garden-planner'].sid);
  check('text in its prompt: not typed, queued for its next stop', c.status === 200 && c.j.state === 'queued' && c.j.delivered === 'next stop' && /text in its prompt/.test(c.j.why || '') && /next stop/.test(c.j.say), c);
  check('...its marker stays queued, asked by hand', mc && mc.state === 'queued' && !!mc.manualAt && !mc.asks, mc);
  await sleep(500);
  const gp = capture('garden-planner');
  check('...and its prompt holds only what was typed there', !/received:/.test(gp) && /❯ also check the/.test(gp), gp.slice(-300));
} catch (e) {
  check('the test ran', false, String(e.stack || e).slice(0, 1500));
} finally {
  if (hub) { if (fails) console.log(hub.log().slice(-3000)); hub.stop(); }
  try {
    const out = execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: DENV, encoding: 'utf8' });
    for (const d of JSON.parse(out)) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  fs.rmSync(RT, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
