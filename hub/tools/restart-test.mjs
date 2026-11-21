// Resume after a restart (SESS-053, server/restart.mjs), through the hub:
// a throwaway board (apps/desktop/tools/demo-hub.mjs, its own HOME, a fake
// cmux, a stub ps) following a throwaway ravenryd, with stand-ins for
// `claude` and `codex` first on its PATH (each writes what it was started
// with, where, then reports SessionStart through `ravenryd hook`). Nothing
// real is read, started or resumed.
//
//   1. A running-sessions file from an older boot (MC_BOOT_TIME stands in
//      for this computer's start time): the card lists the four sessions
//      not running now, in order, with their words; a fifth that runs now
//      (the stub ps lists its process) is not on it. The file starts again
//      on this boot.
//   2. Resume all: each resumed with its assistant and model, in its
//      folder, one at a time, in the card's order (never two resuming at
//      once, the next ones "Next"), each back with its pane; then "All 4
//      sessions are back.". The one stopped mid-turn waits in Needs you
//      with "Stopped mid-turn by the restart. Tell it to go on." until the
//      person writes to it.
//   3. Another restart, then Dismiss: the card goes, the two sessions are in
//      Recently closed with their assistant and model.
//   4. The same boot (only the hub restarted): no card.
//   5. The board's own Close takes a session off the file at once; one that
//      stops showing stays a minute (a restart never empties the file); one
//      the person ended leaves at once (the keeper, on its own files).
//
// Needs ravenryd: RAVENRYD_BIN, else ../daemon/ravenryd.
// Usage: node tools/restart-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub, freePort } from '../../apps/desktop/tools/demo-hub.mjs';
import * as restart from '../server/restart.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(ROOT, '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.log(`SKIP  restart-test: no ravenryd at ${BIN}`); process.exit(0); }
const WORK = path.join(ROOT, '.tmp', 'restart-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const RT = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-'));
fs.chmodSync(RT, 0o700);
const DHOME = path.join(WORK, 'daemon-home');
fs.mkdirSync(DHOME, { recursive: true });
const DENV = withTestHome({ HOME: DHOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'daemon-state') });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const post = async (url, body = {}) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ravenry': '1' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => null) }; };

// The stand-ins: `name|folder|args` in RAN, then SessionStart through the pane's daemon.
const STAND = path.join(WORK, 'standin');
const RAN = path.join(WORK, 'ran.log');
fs.mkdirSync(STAND, { recursive: true });
for (const name of ['claude', 'codex']) {
  fs.writeFileSync(path.join(STAND, name), `#!/bin/sh
printf '%s|%s|%s\\n' '${name}' "$PWD" "$*" >> '${RAN}'
printf '${name} stand-in: %s\\n' "$*"
sid=''; prev=''
for a in "$@"; do if [ "$prev" = --resume ] || [ "$prev" = resume ]; then sid="$a"; fi; prev="$a"; done
(sleep 0.5; printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"resume"}' "$sid" "$PWD" | '${BIN}' hook --assistant ${name} >/dev/null 2>&1) &
exec cat
`, { mode: 0o755 });
}
const ran = () => (fs.existsSync(RAN) ? fs.readFileSync(RAN, 'utf8').trim().split('\n').filter(Boolean) : []);

const S = {
  boat: 'b2b2b2b2-0000-4000-8000-0000000000b2',
  notes: 'c3c3c3c3-0000-4000-8000-0000000000c3',
  harbour: 'd4d4d4d4-0000-4000-8000-0000000000d4',
  garden: 'a1a1a1a1-0000-4000-8000-0000000000a1',
  live: 'e5e5e5e5-0000-4000-8000-0000000000e5',
  kite: 'f6f6f6f6-0000-4000-8000-0000000000f6',
  moss: 'a7a7a7a7-0000-4000-8000-0000000000a7',
};
const NOW_BOOT = Math.floor(Date.now() / 1000) - 600;
const OLD_BOOT = NOW_BOOT - 86400;
const entry = (sid, id, assistant, model, topic, ranMin, extra = {}) => ({ sessionId: sid, assistant, model, folder: null, projectId: id, project: id, topic, startedAt: ago(ranMin + 12), lastSeenAt: ago(12), working: false, doing: null, ...extra });
// The order the card keeps: the file's.
const BEFORE = [
  entry(S.boat, 'paper-boat', 'claude', 'claude-opus-5-5', 'Tilting the hull', 130, { working: true, doing: 'rendering the tilt frames' }),
  entry(S.notes, 'notes-app', 'claude', 'claude-opus-5-5', 'Sync settings', 45),
  entry(S.harbour, 'harbour-light', 'codex', 'gpt-5.4', 'Run the tests before the commit', 80),
  entry(S.garden, 'garden-planner', 'claude', 'claude-opus-5-5', 'Planting reminders', 25),
  entry(S.live, 'kite', 'claude', 'claude-opus-5-5', 'Kite tail', 10),
];
const PROJECTS = ['paper-boat', 'notes-app', 'harbour-light', 'garden-planner', 'kite', 'moss'];

let hub = null;
const hubDir = (n) => path.join(WORK, `board-${n}`);
// A board whose last running file is `running`, on boot `boot`; `ps`: the processes running now.
async function board(n, { running, boot, ps = [] }) {
  const dir = hubDir(n);
  return startDemoHub({
    dir, port: await freePort(), runtime: RT, empty: true,
    extra: PROJECTS.map((id) => ({ id, name: id })),
    env: { PATH: `${STAND}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, MC_NO_EVENTS: '0', MC_CODEX: '1', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, `hub-state-${n}`), MC_BOOT_TIME: String(boot), RAVENRY_HUB_NAME: 'MacBook Pro' },
    prepare: ({ ROOT: PR, MC }) => {
      const r = { ...running, sessions: running.sessions.map((e) => ({ ...e, folder: path.join(PR, e.projectId) })) };
      fs.writeFileSync(path.join(MC, 'running.json'), JSON.stringify(r, null, 2));
      // Each session's hook events, as they were before the restart (its assistant, its folder).
      for (const e of r.sessions) {
        const ev = (event, m, more = {}) => JSON.stringify({ at: ago(m), event, session_id: e.sessionId, assistant: e.assistant, cwd: e.folder, terminal: 'ravenry', ...more });
        fs.writeFileSync(path.join(MC, 'events', `${e.sessionId}.jsonl`), [ev('SessionStart', 200, { source: 'startup' }), ev('UserPromptSubmit', 190)].join('\n') + '\n');
      }
      fs.writeFileSync(path.join(dir, 'stub-ps.json'), JSON.stringify(ps.map((p) => ({ ...p, cwd: path.join(PR, p.project) }))));
    },
  });
}
const card = async () => (await hub.state()).restart || null;

try {
  execFileSync(BIN, ['serve', '--detach'], { env: DENV });

  // ---- 1. the card after a restart
  hub = await board(1, { running: { boot: OLD_BOOT, writtenAt: ago(12), sessions: BEFORE }, boot: NOW_BOOT, ps: [{ pid: 4990, ppid: 1, rssKb: 300000, startedAt: ago(3), command: `claude --resume ${S.live}`, project: 'kite' }] });
  const c = await until(card, 20000);
  check('1. the card is in the state after a restart', !!c, hub.log().slice(-1500));
  if (!c) throw new Error('no card');
  const clock = restart.sayClock(new Date(NOW_BOOT * 1000).toISOString());
  check('1. its title and words', c.title === '4 sessions were running before the restart' && c.body === `This Mac restarted at ${clock} and they stopped. Each one picks up its conversation in its own folder, with its own assistant.`
    && c.dismissNote === 'Dismiss keeps them in Recently closed on the Sessions page, each with Reopen.' && c.resumeAll === 'Resume all 4' && c.dismiss === 'Dismiss' && c.phase === 'offer', { title: c.title, body: c.body, resumeAll: c.resumeAll, phase: c.phase });
  check('1. the four not running now, in order; the one running now is not on it', c.rows.map((r) => r.project).join(',') === 'paper-boat,notes-app,harbour-light,garden-planner', c.rows.map((r) => r.project));
  const [rb, rn, rh] = c.rows;
  check('1. a row: project, topic, assistant and model, how long it ran, what it was doing', rb.topic === 'Tilting the hull' && rb.chip === 'Claude Opus 5.5' && rb.ran === 'Ran 2 h 10 min' && rb.doing === 'Was working: rendering the tilt frames' && rb.midTurn && rb.midTurnTag === 'Mid-turn'
    && /^It stopped in the middle of a turn\. Resuming opens the conversation where it was; it does not run that turn again\. Tell it to go on\.$/.test(rb.midTurnNote), rb);
  check('1. at its prompt; a Codex row', rn.doing === 'At its prompt' && !rn.midTurn && rn.ran === 'Ran 45 min' && rh.chip === 'Codex gpt-5.4' && rh.ran === 'Ran 1 h 20 min', [rn, rh]);
  const file1 = JSON.parse(fs.readFileSync(path.join(hub.home, '.ravenry', 'running.json'), 'utf8'));
  check('1. the running file starts again on this boot', file1.boot === NOW_BOOT, { boot: file1.boot, sessions: file1.sessions.map((e) => e.sessionId) });

  // ---- 2. Resume all
  const seen = [];
  let watching = true;
  const watcher = (async () => { while (watching) { const x = await card().catch(() => null); if (x) seen.push(x.rows.map((r) => r.state)); await sleep(40); } })();
  const r = await post(hub.url + '/api/restart/resume', { cols: 100, rows: 30 });
  check('2. Resume all is taken', r.status === 200 && r.j.ok && r.j.queued.length === 4, r);
  const done = await until(async () => { const x = await card(); return x && x.phase === 'done' ? x : null; }, 60000, 100);
  watching = false;
  await watcher;
  if (done) seen.push(done.rows.map((x) => x.state));
  check('2. every one back, then the toast words', !!done && done.rows.every((x) => x.state === 'back' && x.pane) && done.toast === 'All 4 sessions are back.', done ? { rows: done.rows.map((x) => [x.state, x.pane, x.error]), toast: done.toast } : hub.log().slice(-1500));
  check('2. never two resuming at once', seen.every((s) => s.filter((x) => x === 'resuming').length <= 1), seen.slice(0, 5));
  check('2. while one resumes, the ones after it wait as Next', seen.some((s) => s[1] === 'resuming' && s[0] === 'back' && s[2] === 'next' && s[3] === 'next'), seen.find((s) => s.includes('resuming')));
  // Each back before the next one starts: the order the card gives.
  const firstBack = [0, 1, 2, 3].map((i) => seen.findIndex((s) => s[i] === 'back'));
  check('2. back one at a time, in the card\'s order', firstBack.every((v, i) => v >= 0 && (i === 0 || v >= firstBack[i - 1])), firstBack);
  const lines = ran();
  const want = [
    ['claude', 'paper-boat', `--model claude-opus-5-5 --resume ${S.boat}`],
    ['claude', 'notes-app', `--model claude-opus-5-5 --resume ${S.notes}`],
    ['codex', 'harbour-light', `-m gpt-5.4 resume ${S.harbour}`],
    ['claude', 'garden-planner', `--model claude-opus-5-5 --resume ${S.garden}`],
  ];
  const got = lines.map((l) => l.split('|'));
  const okRan = got.length === 4 && want.every(([a, f, args], i) => got[i][0] === a && got[i][1].endsWith(`/Projects/${f}`) && got[i][2] === args);
  check('2. each started with its assistant and model, in its folder, in order', okRan, okRan ? lines : done && done.rows.map((x) => { try { return execFileSync(BIN, ['capture', x.pane], { env: DENV, encoding: 'utf8' }).trim().slice(-300); } catch (e) { return String(e.message).slice(0, 200); } }));

  // The mid-turn one waits for the person in Needs you.
  const pb = async () => (await hub.state()).projects.find((p) => p.id === 'paper-boat');
  const waits = await until(async () => { const p = await pb(); return p && p.state === 'you' && p.line === 'Stopped mid-turn by the restart. Tell it to go on.' ? p : null; }, 20000);
  const p0 = waits || await pb();
  check('2. the one stopped mid-turn waits in Needs you with its line', !!waits, p0 ? { state: p0.state, line: p0.line, sessions: p0.sessions.map((s) => [s.sessionId, s.state, s.surfaceId]) } : null);
  const sb = (await hub.state()).sidebar;
  const youRows = ((sb && sb.sections) || []).filter((x) => x.group === 'you').flatMap((x) => (x.projects || []).map((y) => JSON.stringify(y)));
  check('2. ...in the sidebar\'s Needs you', youRows.some((y) => y.includes('paper-boat')), youRows.slice(0, 2));
  check('2. the others are not in Needs you', (await hub.state()).projects.filter((p) => ['notes-app', 'garden-planner', 'harbour-light'].includes(p.id)).every((p) => p.state !== 'you'), (await hub.state()).projects.map((p) => [p.id, p.state]));
  // The person writes to it: it waits no more.
  fs.appendFileSync(path.join(hub.home, '.ravenry', 'events', `${S.boat}.jsonl`), JSON.stringify({ at: new Date().toISOString(), event: 'UserPromptSubmit', session_id: S.boat, assistant: 'claude', cwd: path.join(hub.root, 'paper-boat'), terminal: 'ravenry' }) + '\n');
  const gone = await until(async () => { const p = await pb(); return p && p.line !== 'Stopped mid-turn by the restart. Tell it to go on.' ? p : null; }, 20000);
  check('2. once written to, it waits no more', !!gone, gone ? { state: gone.state, line: gone.line } : null);
  const again = await post(hub.url + '/api/restart/resume', { sessionId: S.notes });
  check('2. a session already back is not started again', again.status === 200 && again.j.queued.length === 0 && ran().length === 4, { again, ran: ran().length });
  hub.stop(); hub = null;
  await sleep(500);

  // ---- 3. another restart, then Dismiss
  const two = [entry(S.kite, 'kite', 'claude', 'claude-opus-5-5', 'Kite tail', 20), entry(S.moss, 'moss', 'codex', 'gpt-5.4', 'Moss on the wall', 30, { working: true, doing: 'npm test' })];
  hub = await board(3, { running: { boot: OLD_BOOT, sessions: two }, boot: NOW_BOOT });
  const c3 = await until(card, 20000);
  check('3. a card of two', !!c3 && c3.count === 2 && c3.rows.map((x) => x.project).join(',') === 'kite,moss', c3 && c3.rows.map((x) => x.project));
  const d = await post(hub.url + '/api/restart/dismiss');
  check('3. Dismiss is taken', d.status === 200 && d.j.closed.length === 2, d);
  const closed = await until(async () => { const st = await hub.state(); return !st.restart && (st.sessions.closed || []).length === 2 ? st.sessions.closed : null; }, 15000);
  check('3. the card goes; both in Recently closed, with their assistant and model', !!closed && closed.some((x) => x.id === S.kite && x.assistant === 'claude' && x.model === 'claude-opus-5-5' && x.label === 'kite' && x.cwd.endsWith('/kite'))
    && closed.some((x) => x.id === S.moss && x.assistant === 'codex' && x.model === 'gpt-5.4'), closed);
  check('3. its offer file is gone', !fs.existsSync(path.join(hub.home, '.ravenry', 'restart.json')));
  hub.stop(); hub = null;
  await sleep(500);

  // ---- 4. the same boot: only the hub restarted
  hub = await board(4, { running: { boot: NOW_BOOT, sessions: two }, boot: NOW_BOOT });
  await until(async () => (await hub.state()).sessions && (await hub.state()).sessions.at, 15000);
  await sleep(1500);
  const st4 = await hub.state();
  check('4. the same boot: no card', !st4.restart && /only the hub restarted/.test(hub.log()), { restart: st4.restart, log: hub.log().split('\n').filter((l) => /restart/.test(l)) });
  hub.stop(); hub = null;

  // ---- 5. the keeper's file: Close, a session that stops showing, one the person ended
  const K = path.join(WORK, 'keeper');
  fs.mkdirSync(K, { recursive: true });
  const files = { running: path.join(K, 'running.json'), offer: path.join(K, 'restart.json'), log: () => {} };
  const t0 = Date.now();
  const k1 = restart.keeper({ boot: 100, ...files, now: t0 });
  const live = (ids) => ids.map((sid) => ({ sessionId: sid, assistant: 'claude', model: null, folder: '/x', projectId: 'x', project: 'x', topic: null, startedAt: new Date(t0).toISOString(), lastSeenAt: new Date(t0).toISOString(), working: false }));
  k1.observe(live([S.boat, S.notes, S.garden]), { now: t0 });
  k1.forget(S.boat);
  const onFile = () => JSON.parse(fs.readFileSync(files.running, 'utf8')).sessions.map((e) => e.sessionId);
  check('5. the board\'s Close: off the file at once', !onFile().includes(S.boat) && onFile().length === 2, onFile());
  // Shutdown: the sessions end a moment before the hub; the person ended notes-app with /exit before.
  k1.observe(live([]), { now: t0 + 5000, ended: (sid) => (sid === S.notes ? 'prompt_input_exit' : sid === S.garden ? 'other' : null) });
  check('5. one the person ended leaves at once; one that stopped showing stays', onFile().join(',') === S.garden, onFile());
  k1.observe(live([]), { now: t0 + restart.GONE_MS + 10000 });
  check('5. ...a minute later it leaves', onFile().length === 0, onFile());
  // A restart right after the shutdown: garden-planner is offered, nothing else.
  const k2a = restart.keeper({ boot: 100, ...files, now: t0 });
  k2a.observe(live([S.garden]), { now: t0 });
  k2a.observe(live([]), { now: t0 + 2000, ended: () => 'other' });
  const k2 = restart.keeper({ boot: 200, ...files, now: t0 + 60000 });
  check('5. after the restart, the one cut off is offered', k2.rows.map((x) => x.sessionId).join(',') === S.garden, k2.rows);
  check('5. boot times read: sysctl and /proc/stat', restart.parseBoottime('{ sec = 1732170000, usec = 0 } Thu Nov 21 06:20:00 2024') === 1732170000 && restart.parseBtime('cpu 1 2\nbtime 1732170000\nprocesses 5\n') === 1732170000 && Number.isFinite(restart.bootTime({ env: {} })));
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
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
