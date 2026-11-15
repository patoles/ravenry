// Proves who acts as the person on the hub's HTTP API (server/person.mjs
// ROUTES, docs/PERSON.md):
//   - every route the server has is classed: each `p === '/api/...'` and
//     `case '/api/...'`, each plan action and each idea action in
//     server/index.mjs has a row, and a POST no row names is a person's;
//   - against a real board and a real ravenryd (RAVENRYD_BIN), every
//     person row sent with curl from inside a real pane gets 403 and changes
//     nothing (no file of the board, its home or the project, no pane, the
//     checkpoint and the plan's gate stay open), while the open rows from
//     the same pane go through;
//   - the same calls from this test process, outside every pane, pass the
//     check, and the ones with an effect that is safe here take effect: the
//     plan's gate is passed, the checkpoint answered, a machine added and
//     removed, the hand-off settings saved.
// HOME, the board's data, Claude's settings and the daemon's folders are
// all scratch; ssh, Finder, the clipboard and every model run are stubs.
// Without RAVENRYD_BIN only the first part runs (the hub job on Linux CI).
// Usage: RAVENRYD_BIN=../daemon/ravenryd node tools/person-routes-test.mjs
import { withStubMachine } from './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as person from '../server/person.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eg = (r) => (typeof r.p === 'string' ? r.p : r.eg);

// ------------------------------------------------------------ every route is classed
const src = fs.readFileSync(path.join(ROOT, 'server/index.mjs'), 'utf8');
// The literals a write compares the path with (a read's are open), the
// plan's actions, and the idea routes' actions.
const lits = new Set([...src.matchAll(/(?<!req\.method === 'GET' && )p === '(\/api\/[^']+)'/g), ...src.matchAll(/case '(\/api\/[^']+)':/g)].map((m) => m[1]));
const planSrc = src.slice(src.indexOf('async function planWrite('));
const planActs = [...planSrc.slice(0, planSrc.indexOf('\n}\n')).matchAll(/act === '(\w+)'/g)].map((m) => '/api/plan/' + m[1]);
const ideaRoutes = [];
const acts = src.match(/\\\/api\\\/ideas\\\/\(\[\\w-\]\+\)\\\/\(([\w|]+)\)\$/);
if (acts) for (const a of acts[1].split('|')) ideaRoutes.push(`/api/ideas/x/${a}`);
const mock = src.match(/\\\/api\\\/ideas\\\/\(\[\\w-\]\+\)\\\/mockups\(\?:\\\/\(([\w|]+)\)\)\?\$/);
if (mock) { ideaRoutes.push('/api/ideas/x/mockups'); for (const a of mock[1].split('|')) ideaRoutes.push(`/api/ideas/x/mockups/${a}`); }
const dynamic = ['/api/rules/x', '/api/repeats/x', '/api/inbox/x', '/api/sessions/x/comment', '/api/sessions/x/merge', '/api/sessions/x/discard', '/api/sessions/x/unmerge', '/api/sessions/x/delete-branch', '/api/sessions/x/filmstrip', '/api/sessions/x/review/comment', '/api/sessions/x/review/remove', '/api/sessions/x/review/send', ...ideaRoutes];
const missing = [...lits, ...planActs, ...dynamic].filter((p) => !person.routeOf('POST', p) && !person.routeOf('GET', p));
check(`every write route has a row (${lits.size} paths, ${planActs.length} plan actions, ${ideaRoutes.length} idea actions)`, missing.length === 0 && planActs.length >= 12 && ideaRoutes.length >= 8, missing.join(', '));
const rows = person.ROUTES;
check('every row has a reason, and every person row the words of its refusal', rows.every((r) => r.why && (r.c === 'open' || r.what)));
const known = new Set([...lits, ...planActs, ...dynamic, ...[...src.matchAll(/p === '(\/api\/[^']+)'/g)].map((m) => m[1])]);
check('the pages\' routes are among them', lits.has('/api/pages/item/set') && lits.has('/api/pages/run') && lits.has('/api/pages/check'));
check('every row names a route the server has', rows.every((r) => known.has(eg(r))), rows.filter((r) => !known.has(eg(r))).map(eg).join(', '));
check('a POST no row names is a person\'s; a read no row names is open', !!person.personRoute('POST', '/api/something-new') && !person.personRoute('GET', '/api/state') && !person.personRoute('POST', '/api/note'));
const docs = fs.readFileSync(path.join(ROOT, 'docs/PERSON.md'), 'utf8');
const undoc = rows.filter((r) => !docs.includes('`' + (r.m === 'GET' ? 'GET ' : '') + (typeof r.p === 'string' ? r.p : r.doc || r.eg) + '`'));
check('docs/PERSON.md lists every row', undoc.length === 0, undoc.map(eg).join(', '));
const personRows = rows.filter((r) => r.c === 'person');
console.log(`MEASURE  routes: ${personRows.length} person, ${rows.length - personRows.length} open, ${rows.filter((r) => /^Ambiguous/.test(r.why)).length} judged ambiguous`);

const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  the live part: set RAVENRYD_BIN to a ravenryd binary');
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
}

// ------------------------------------------------------------ a real board and daemon
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'person-routes-'));
const MC = path.join(T, 'mc');
const HOME = path.join(T, 'home');
const PROJ = path.join(T, 'proj');
for (const d of [MC, HOME, PROJ, path.join(HOME, '.claude')]) fs.mkdirSync(d, { recursive: true });
const BRIEF = path.join(PROJ, 'BRIEF.md');
fs.writeFileSync(BRIEF, [
  '# Proj', '', 'Goal: Test who acts as the person.', '',
  '## Plan', '### Hello file', 'Runs on its own. Started: 2026-11-03 09:00. Not in the plan: stop and ask.', 'Goal: "Make hello.txt say hi"', '',
  '- [x] Do: Create hello.txt containing hi',
  '- [?] Gate: Ask me before adding a second line', '  - Choices: Add it | Leave it', '  - Question: hello.txt says hi. Add a second line?',
  '- [ ] Do: Add a second line',
  '- [ ] Gate: Ask me before adding a third line', '  - Choices: Add it | Leave it',
  '- [ ] Do: Add a third line', '',
  '## Next step', 'Go.', '', '## Notes', '- [ ] "a note"', '',
].join('\n'));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'proj', name: 'Proj', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
// A page of the person's with a note, and a page that came with the
// project, so every pages row has something it would change.
fs.mkdirSync(path.join(MC, 'pages', 'notes', '.archive'), { recursive: true });
fs.writeFileSync(path.join(MC, 'pages', 'notes.page.yaml'), [
  'version: 1', 'id: notes', 'title: Notes', 'nav: { icon: flag, count: { status: new } }', 'source:', '  folder: notes/', '  fields:', '    status: { type: enum, values: [new, done] }',
  'sections:', '  - view: list', '    item:', '      title: title', '      checklist: body', '      actions:', '        - { label: Done, set: { status: done } }', '        - { label: Tick, toggle: body }',
  'actions:', '  - { label: New note, create: { status: new } }', '  - label: Ask', '    ask: { session: proj, background: "Look at the notes" }', '  - label: Run it', '    run: { argv: [touch, ran.txt] }', '',
].join('\n'));
const NOTE_TEXT = '---\ntitle: A note\nstatus: new\n---\n- [ ] a box\n';
fs.writeFileSync(path.join(MC, 'pages', 'notes', 'a-note.md'), NOTE_TEXT);
fs.writeFileSync(path.join(MC, 'pages', 'notes', '.archive', 'old.md'), '---\ntitle: Old\nstatus: done\n---\n');
fs.mkdirSync(path.join(PROJ, '.ravenry', 'pages'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.ravenry', 'pages', 'tiles.page.yaml'), 'version: 1\nid: tiles\ntitle: Tiles\nnav: { icon: table }\nsource:\n  folder: regions/\n  fields:\n    status: { type: enum, values: [checked, stale] }\nsections:\n  - view: table\n    columns: [title, status]\n');
const NOTE_HASH = crypto.createHash('sha256').update(NOTE_TEXT).digest('hex');
const SETTINGS = path.join(T, 'claude-settings.json');
fs.writeFileSync(SETTINGS, '{}');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvp-'));
const RUN = path.join(D, 'run');
const PORT = 4793;
const DENV = { HOME, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RUN, RAVENRY_STATE_DIR: path.join(D, 'state') };
const FALSE = JSON.stringify(['/usr/bin/false']);
const daemon = spawn(BIN, ['serve'], { env: DENV, stdio: 'ignore' });
let boardLog = '';
const env = {
  ...DENV, PATH: process.env.PATH, RAVENRY_HOME: MC, PORT: String(PORT), RAVENRY_TERMINAL: 'ravenry', RAVENRY_DAEMON_BIN: BIN,
  MC_CLAUDE_SETTINGS: SETTINGS, MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects'), MC_GLOBAL_CLAUDE_MD: path.join(HOME, '.claude', 'CLAUDE.md'),
  MC_CODEX: '0', TEST_RAVENRY: '1', MC_TEST: '1', MC_CLAUDE_BIN: '/usr/bin/false', MC_PRINT_COMMAND: FALSE, MC_MOCKUP_COMMAND: FALSE, MC_PLAN_COMMAND: FALSE, MC_REPEATS_COMMAND: FALSE,
  RAVENRY_SSH: '/usr/bin/false', MC_OPEN_COMMAND: JSON.stringify(['/usr/bin/true']), MC_COPY_COMMAND: JSON.stringify(['/bin/sh', '-c', 'cat >/dev/null']),
  MC_CHOOSE_FOLDER_COMMAND: JSON.stringify(['/bin/echo', PROJ]), MC_ALERT_BOARD_URL: `http://localhost:${PORT}/`,
};
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: withStubMachine(env), stdio: ['ignore', 'pipe', 'pipe'] });
board.stdout.on('data', (d) => { boardLog += d; });
board.stderr.on('data', (d) => { boardLog += d; });
process.on('exit', () => { board.kill('SIGTERM'); daemon.kill('SIGTERM'); try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ } });

const base = `http://localhost:${PORT}`;
async function call(method, p, body) {
  const r = await fetch(base + p, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const state = async () => (await call('GET', '/api/state')).body;
const first = await until(async () => { const s = await state(); return s && s.generatedAt && s.projects.find((x) => x.id === 'proj')?.plan ? s : null; }, 20000);
const plan0 = first && first.projects.find((x) => x.id === 'proj').plan;
check('the board answers, and the project\'s plan waits at its gate', !!plan0 && plan0.state === 'gate', JSON.stringify(plan0 && { state: plan0.state }) + boardLog.slice(-600));

// A pane where an agent would run, with an open checkpoint of its own.
const { connectSocket } = await import('../../packages/node-client/index.mjs');
const SOCK = await until(async () => { const n = fs.readdirSync(RUN).find((x) => x.endsWith('.sock')); return n ? path.join(RUN, n) : null; });
const dc = await connectSocket(SOCK, { name: 'person-routes-test' });
const agentPane = (await dc.request('pane.new', { command: ['/bin/sh', '-c', 'exec sleep 600'], cols: 80, rows: 10 })).pane;
const agentEnv = { ...DENV, RAVENRY_PANE: agentPane.id, RAVENRY_SOCKET: SOCK };
const cpId = spawnSync(BIN, ['approve', '--no-wait', '--cwd', T, 'true'], { env: agentEnv, encoding: 'utf8' }).stdout.trim();
const cpOpen = async () => ((await call('GET', '/api/checkpoints')).body.checkpoints.find((c) => c.id === cpId) || {}).state;
check('a checkpoint is open', (await until(async () => (await cpOpen()) === 'open')) === true || (await cpOpen()) === 'open', cpId);

// A body for each row: one that would act, where it can.
const bodies = {
  '/api/checkpoints/answer': { id: cpId, approve: true },
  '/api/plan/answer': { projectId: 'proj', choice: 'Add it' },
  '/api/send': { projectId: 'proj', surfaceId: 'ravenry:' + agentPane.id, text: 'yes' },
  '/api/sessions/start': { projectId: 'proj', assistant: 'claude', text: 'hello' },
  '/api/sessions/resume': { projectId: 'proj', sessionId: '00000000-0000-4000-8000-000000000000' },
  '/api/sessions/close': { surfaceIds: ['ravenry:' + agentPane.id] },
  '/api/handoff': { projectId: 'proj', sessionId: 'x' },
  '/api/machines/add': { name: 'box', host: 'box' },
  '/api/machines/remove': { name: 'box' },
  '/api/machines/retry': { name: 'box' },
  '/api/machines/install': { name: 'box' },
  '/api/machines/uninstall': { name: 'box', endSessions: true },
  '/api/setup/hooks': { ravenryd: BIN, dry: true },
  '/api/settings/handoff': { handoffEnabled: false },
  '/api/settings/assistant': { start: 'codex' },
  '/api/settings/projects-root': { path: PROJ },
  '/api/alerts/switch': { enabled: true },
  '/api/alerts/desktop': { enabled: false },
  '/api/alerts/webhook': { url: 'http://localhost:9/hook' },
  '/api/ideas/x/update': { name: 'changed' },
  '/api/ideas/brainstorm': { seed: 'x' },
  '/api/project/new': { name: 'Made by an agent' },
  '/api/project/assistant': { projectId: 'proj', assistant: 'codex' },
  '/api/project/model': { projectId: 'proj', assistant: 'claude', model: 'opus' },
  '/api/project/revive': { projectId: 'proj', text: 'hi' },
  '/api/project/open-folder': { projectId: 'proj' },
  '/api/open': { projectId: 'proj', surfaceId: 'ravenry:' + agentPane.id },
  '/api/rules/x': { action: 'add' },
  '/api/repeats/x': { action: 'add' },
  '/api/pages/item/set': { key: 'notes', file: 'a-note.md', hash: NOTE_HASH, patch: { status: 'done' } },
  '/api/pages/item/toggle': { key: 'notes', file: 'a-note.md', line: 5, text: 'a box' },
  '/api/pages/item/archive': { key: 'notes', file: 'a-note.md' },
  '/api/pages/item/restore': { key: 'notes', file: 'old.md' },
  '/api/pages/trust': { key: 'proj/tiles' },
  '/api/pages/approve': { key: 'notes' },
  '/api/pages/dismiss': { key: 'notes' },
  '/api/pages/customize': { key: 'objectives' },
  '/api/pages/ask': { key: 'notes', at: { scope: 'page', index: 1 } },
  '/api/pages/run': { key: 'notes', at: { scope: 'page', index: 2 } },
  '/api/phone/pair': { code: 'ABCDEFGHJKMNPQRS', name: 'An agent' },
  '/api/phone/push': { kind: 'unifiedpush', endpoint: 'https://push.invalid/up', p256dh: 'x', auth: 'x' },
  '/api/phone/access': { on: true },
  '/api/phone/devices/rename': { id: 'dnone', name: 'An agent' },
  '/api/phone/devices/revoke': { id: 'dnone' },
  '/api/decisions/add': { quote: 'Ship it on Fridays only', project: 'proj' },
  '/api/decisions/undo': { id: 'daaaaaaa' },
  '/api/decisions/edit': { id: 'daaaaaaa', quote: 'Changed by an agent' },
  '/api/decisions/remove': { id: 'daaaaaaa' },
  '/api/sessions/x/comment': { file: 'a.txt', line: 1, text: 'Use a constant here' },
  '/api/sessions/x/merge': { mode: 'ff' },
  '/api/sessions/x/discard': {},
  '/api/sessions/x/unmerge': {},
  '/api/sessions/x/delete-branch': {},
  '/api/sessions/x/filmstrip': { pane: 'paaaaaaa' },
  '/api/sessions/x/review/comment': { file: 'a.txt', line: 1, text: 'Use a constant here' },
  '/api/sessions/x/review/remove': { id: 'rcaaaaaaa' },
  '/api/sessions/x/review/send': {},
};
const bodyOf = (r) => bodies[eg(r)] || { projectId: 'proj' };

// ------------------------------------------------------------ what "nothing changed" means
// Every file of the board's data, its home, Claude's settings and the
// project, by hash. Files the board rewrites by itself (its ticks) are
// found by looking twice with nothing sent, and left out.
function snap() {
  const out = new Map();
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out.set(f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    }
  };
  walk(T);
  return out;
}
const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f) !== b.get(f));
const panesNow = async () => (await dc.request('pane.list', { hidden: true })).panes.map((p) => p.id).sort();
const sA = snap();
await sleep(2500);
const sB = snap();
const noisy = new Set(diff(sA, sB));
const panesBefore = await panesNow();

// ------------------------------------------------------------ from inside a real pane
const OUT = path.join(T, 'pane-out');
fs.mkdirSync(OUT);
const lines = [];
personRows.forEach((r, i) => {
  fs.writeFileSync(path.join(OUT, `${i}.body`), JSON.stringify(bodyOf(r)));
  const data = r.m === 'GET' ? '' : `-X POST -H 'Content-Type: application/json' -H 'X-Ravenry: 1' --data @'${OUT}/${i}.body'`;
  lines.push(`c=$(curl -s -o '${OUT}/${i}.json' -w '%{http_code}' ${data} 'http://localhost:${PORT}${eg(r)}'); echo "${i} $c" >> '${OUT}/codes'`);
});
// And one that leaves the pane's tree first, as a daemon does: a double
// fork into a session of its own, its environment wiped, then curl from a
// child of launchd or init. The daemon saw its middle process (macOS: the
// fork watch) or it carries the pane's mark (Linux).
const ansIdx = personRows.findIndex((r) => r.p === '/api/plan/answer');
lines.push(`/usr/bin/env -i /usr/bin/perl -e 'use POSIX; exit if fork; POSIX::setsid(); exit if fork; sleep 1; printf STDERR "ppid=%d\\n", getppid(); exec "/usr/bin/curl", "-s", "-o", "${OUT}/detached.json", "-w", "%{http_code}", "-X", "POST", "-H", "Content-Type: application/json", "-H", "X-Ravenry: 1", "--data", "@${OUT}/${ansIdx}.body", "http://localhost:${PORT}/api/plan/answer"' > '${OUT}/detached-code' 2> '${OUT}/detached-ppid'`);
lines.push(`while ! [ -s '${OUT}/detached-code' ]; do sleep 0.1; done`);
lines.push(`echo done > '${OUT}/finished'`, 'echo all-tried', 'exec sleep 60');
const SCRIPT = path.join(T, 'in-pane.sh');
fs.writeFileSync(SCRIPT, lines.join('\n') + '\n');
const curlPane = (await dc.request('pane.new', { command: ['/bin/sh', SCRIPT], cols: 200, rows: 10 })).pane;
const t0 = Date.now();
await until(async () => fs.existsSync(path.join(OUT, 'finished')), 120000);
const inPaneMs = Date.now() - t0;
const codes = new Map(fs.readFileSync(path.join(OUT, 'codes'), 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([i, c]) => [Number(i), Number(c)]));
const notRefused = personRows.map((r, i) => {
  let b = null;
  try { b = JSON.parse(fs.readFileSync(path.join(OUT, `${i}.json`), 'utf8')); } catch { /* none */ }
  return codes.get(i) === 403 && b && b.notPerson && /^Only a person can /.test(b.error) && /inside pane/.test(b.error) ? null : `${r.m} ${eg(r)}: ${codes.get(i)} ${JSON.stringify(b)}`;
}).filter(Boolean);
const dcode = fs.readFileSync(path.join(OUT, 'detached-code'), 'utf8').trim();
const dppid = fs.readFileSync(path.join(OUT, 'detached-ppid'), 'utf8').trim();
// Its parent: launchd on macOS; on Linux init, or a subreaper above the
// pane where the machine has one.
check('from a pane, a double-forked curl with its environment wiped, a child of launchd or init, gets 403 too', dcode === '403' && (dppid === 'ppid=1' || (process.platform === 'linux' && /^ppid=\d+$/.test(dppid))), `${dcode} ${dppid} ${(() => { try { return fs.readFileSync(path.join(OUT, 'detached.json'), 'utf8'); } catch { return ''; } })()}`);
check(`from a pane, all ${personRows.length} person rows get 403 with a plain message`, notRefused.length === 0 && codes.size === personRows.length, notRefused.join('\n      '));
// The remote installer's two routes by name: each from a pane got 403,
// before its body was read, so no ssh ran.
const installRows = ['/api/machines/install', '/api/machines/uninstall'].map((x) => personRows.findIndex((r) => eg(r) === x));
check('from a pane, installing on and uninstalling from a machine get 403', installRows.every((i) => i >= 0 && codes.get(i) === 403 && /^Only a person can (install|uninstall) Ravenry/.test((() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, `${i}.json`), 'utf8')).error; } catch { return ''; } })())), JSON.stringify(installRows.map((i) => codes.get(i))));
console.log(`MEASURE  ${personRows.length} refused calls from a pane in ${inPaneMs} ms (one ravenryd peer each)`);
await dc.request('pane.close', { pane: curlPane.id });
await sleep(500);
const sC = snap();
const changed = diff(sB, sC).filter((f) => !noisy.has(f) && !f.startsWith(OUT + path.sep) && f !== SCRIPT);
check('and nothing changed: no file of the board, its home, Claude\'s settings or the project', changed.length === 0, changed.map((f) => path.relative(T, f)).join(', '));
check('no pane was started or closed', JSON.stringify(await panesNow()) === JSON.stringify(panesBefore), JSON.stringify({ before: panesBefore, after: await panesNow() }));
check('the checkpoint is still open, and the plan still waits at its gate', (await cpOpen()) === 'open' && (await state()).projects.find((x) => x.id === 'proj').plan.state === 'gate');
check('the board logged the refusals', (boardLog.match(/refused (POST|GET) \/api\/\S+: process \d+ \(curl\) runs inside pane/g) || []).length === personRows.length && /refused a checkpoint answer: process \d+ \(curl\)/.test(boardLog));

// The open rows go through from the same kind of pane.
const OPEN = [
  ['/api/note', { projectId: 'proj', text: 'from an agent' }, 200],
  ['/api/ideas/add', { name: 'An agent\'s idea', text: 'x' }, 200],
  ['/api/hook-event', {}, 400],
  ['/api/pages/check', { text: 'version: 1\nid: x\n' }, 200],
  ['/api/pages/item/create', { key: 'notes', action: { scope: 'page', index: 0 }, fields: { title: 'From an agent' } }, 200],
  ['/api/decisions/record', { quote: 'Keep the tabs on the left.', project: 'proj', recorded_by: { pane: 'pforged1' } }, 400],
  ['/api/decisions/record', { quote: 'Keep the tabs on the left.', project: 'proj' }, 200],
];
const olines = OPEN.map(([p, b], i) => {
  fs.writeFileSync(path.join(OUT, `open${i}.body`), JSON.stringify(b));
  return `c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'X-Ravenry: 1' --data @'${OUT}/open${i}.body' 'http://localhost:${PORT}${p}'); echo "${i} $c" >> '${OUT}/open-codes'`;
});
fs.writeFileSync(SCRIPT, olines.join('\n') + `\necho done > '${OUT}/open-finished'\nexec sleep 60\n`);
const openPane = (await dc.request('pane.new', { command: ['/bin/sh', SCRIPT], cols: 200, rows: 10 })).pane;
await until(async () => fs.existsSync(path.join(OUT, 'open-finished')), 30000);
const ocodes = fs.readFileSync(path.join(OUT, 'open-codes'), 'utf8').trim().split('\n').map((l) => Number(l.split(' ')[1]));
check('from a pane, the open rows go through (a note, an idea, a hook event, a page check, a new page item)', OPEN.every(([, , want], i) => ocodes[i] === want) && fs.readFileSync(BRIEF, 'utf8').includes('from an agent') && fs.existsSync(path.join(MC, 'pages', 'notes', 'from-an-agent.md')), JSON.stringify(ocodes));
const recorded = (() => { try { return JSON.parse(fs.readFileSync(path.join(MC, 'decisions.json'), 'utf8')).decisions; } catch { return []; } })();
check('from a pane, a decision is recorded as the agent\'s, marked with the pane its process runs in (never one the body names)', recorded.length === 1 && recorded[0].by === 'agent' && recorded[0].recorded_by && recorded[0].recorded_by.pane === openPane.id && recorded[0].project === 'proj', JSON.stringify(recorded));
await dc.request('pane.close', { pane: openPane.id });

// ------------------------------------------------------------ a gate ticked in the file
// A plan's gate lives in BRIEF.md, which the agent can edit. From inside a
// real pane, the "agent" ticks its own gate and writes an Answer under it:
// the board does not take it (server/gates.mjs). The plan stays waiting at
// the gate, the project needs you, and the gate says it was marked passed
// in the file, not by you. The person reopens it from outside (the [?] is
// back, the file's Answer gone), then answers it; at the next gate the
// agent ticks it again and the person confirms it.
const GATES = path.join(MC, 'plan-gates.json');
const ledger = () => { try { return Object.values(JSON.parse(fs.readFileSync(GATES, 'utf8')).plans).find((x) => x.title === 'Hello file') || null; } catch { return null; } };
async function inPane(script, flag) {
  const pn = (await dc.request('pane.new', { command: ['/bin/sh', '-c', `${script}; echo done > '${OUT}/${flag}'; exec sleep 60`], cols: 120, rows: 10 })).pane;
  await until(async () => fs.existsSync(path.join(OUT, flag)), 20000);
  return pn;
}
const projNow = async () => (await state()).projects.find((x) => x.id === 'proj');
const tickIn = (gate, extra = '') => `/usr/bin/perl -0pi -e 's/- \\[[ ?]\\] Gate: ${gate}\\n/${extra}- [x] Gate: ${gate}\\n  - Answer: Add it (09:30)\\n/' '${BRIEF}'`;
const tp = await inPane(tickIn('Ask me before adding a second line'), 'ticked1');
const ticked = await until(async () => { const p = await projNow(); return p.plan && p.plan.gate && p.plan.gate.fileOnly ? p : null; });
check('from a pane, an agent can tick its gate in BRIEF.md', /- \[x\] Gate: Ask me before adding a second line\n {2}- Answer: Add it \(09:30\)/.test(fs.readFileSync(BRIEF, 'utf8')));
check('but the board does not take it: the plan still waits at that gate, marked passed in the file, not by you', !!ticked && ticked.plan.state === 'gate' && ticked.plan.gate.n === 2 && ticked.plan.gate.fileOnly === 'ticked' && ticked.plan.steps[1].state === 'you' && !!ticked.planGate && ticked.state === 'you', JSON.stringify(ticked && { state: ticked.state, plan: ticked.plan.state, gate: ticked.plan.gate, planGate: !!ticked.planGate }));
check('the hub\'s own record of the gate holds no answer', !!ledger() && Object.keys(ledger().passed).length === 0 && ledger().expected.length === 2, JSON.stringify(ledger()));
await dc.request('pane.close', { pane: tp.id });
const early = await call('POST', '/api/plan/answer', bodies['/api/plan/answer']);
check('an answer to a gate passed in the file is refused until it is confirmed or reopened', early.status === 409, early.text);
const ro = await call('POST', '/api/plan/reopen', { projectId: 'proj' });
const afterReopen = fs.readFileSync(BRIEF, 'utf8');
check('from outside, reopen: the gate is [?] again and the file\'s Answer is gone', ro.status !== 403 && /- \[\?\] Gate: Ask me before adding a second line/.test(afterReopen) && !/Answer: Add it \(09:30\)/.test(afterReopen) && /you reopened the gate; it was marked passed in the file, not by you/.test(afterReopen), ro.text);
const reopened = await until(async () => { const p = await projNow(); return p.plan && p.plan.gate && !p.plan.gate.fileOnly && p.plan.gate.n === 2 ? p : null; });
check('and the plan waits at it as a plain gate', !!reopened && reopened.plan.state === 'gate' && reopened.plan.gate.choices.join('|') === 'Add it|Leave it');

// ------------------------------------------------------------ from outside every pane
const pa = await call('POST', '/api/plan/answer', bodies['/api/plan/answer']);
const briefNow = fs.readFileSync(BRIEF, 'utf8');
check('from outside, the plan\'s gate is passed and the answer written under it', pa.status !== 403 && /- \[x\] Gate: Ask me before adding a second line/.test(briefNow) && /Answer: Add it/.test(briefNow), pa.text);
const passed = ledger() && Object.entries(ledger().passed);
check('and the hub\'s own record has the answer, by the board', !!passed && passed.length === 1 && passed[0][0] === '0|Ask me before adding a second line' && passed[0][1].answer === 'Add it' && passed[0][1].by === 'board', JSON.stringify(ledger()));
// The next gate: the agent does step 3 and ticks gate 4 in the file; the
// person confirms it, and only then is it passed.
const tp2 = await inPane(`/usr/bin/perl -0pi -e 's/- \\[ \\] Do: Add a second line/- [x] Do: Add a second line/' '${BRIEF}' && ${tickIn('Ask me before adding a third line')}`, 'ticked2');
const ticked2 = await until(async () => { const p = await projNow(); return p.plan && p.plan.gate && p.plan.gate.fileOnly && p.plan.gate.n === 4 ? p : null; });
check('the next gate ticked in the file waits too', !!ticked2 && ticked2.plan.state === 'gate' && ticked2.plan.gate.fileOnly === 'ticked');
await dc.request('pane.close', { pane: tp2.id });
const cf = await call('POST', '/api/plan/confirm', { projectId: 'proj' });
const confirmed = await until(async () => { const p = await projNow(); return p.plan && p.plan.state !== 'gate' ? p : null; });
check('from outside, confirm: the gate counts as passed, the plan goes on to step 5', cf.status === 200 && cf.body.confirmed === 'ticked' && !!confirmed && confirmed.plan.current === 5 && ledger().passed['0|Ask me before adding a third line'].how === 'confirmed' && /you confirmed the gate "Ask me before adding a third line", marked passed in the file/.test(fs.readFileSync(BRIEF, 'utf8')), cf.text + JSON.stringify(confirmed && confirmed.plan.state));
const ca = await call('POST', '/api/checkpoints/answer', bodies['/api/checkpoints/answer']);
check('from outside, the checkpoint is answered', ca.status === 200 && ['running', 'answered'].includes(ca.body.checkpoint.state), ca.text);
const ma = await call('POST', '/api/machines/add', bodies['/api/machines/add']);
const mr = await call('POST', '/api/machines/remove', bodies['/api/machines/remove']);
check('from outside, a machine is added and removed', ma.status === 200 && ma.body.machines.some((m) => m.name === 'box') && mr.status === 200 && !mr.body.machines.some((m) => m.name === 'box'), ma.text + ' ' + mr.text);
const hs = await call('POST', '/api/settings/handoff', bodies['/api/settings/handoff']);
check('from outside, the hand-off settings are saved', hs.status === 200 && hs.body.settings && hs.body.settings.handoffEnabled === false, hs.text);
const ps = await call('POST', '/api/pages/item/set', bodies['/api/pages/item/set']);
const pt = await call('POST', '/api/pages/trust', bodies['/api/pages/trust']);
check('from outside, a page\'s item is changed and a project page trusted', ps.status === 200 && /status: done/.test(fs.readFileSync(path.join(MC, 'pages', 'notes', 'a-note.md'), 'utf8')) && pt.status === 200 && JSON.parse(fs.readFileSync(path.join(MC, 'pages.json'), 'utf8')).trust.length === 1, ps.text + pt.text);
const pr = await call('POST', '/api/pages/run', bodies['/api/pages/run']);
const prCp = pr.body && pr.body.checkpoint;
check('from outside, a page\'s run button opens an approve checkpoint for the person, and nothing runs yet', pr.status === 200 && prCp && prCp.kind === 'approve' && prCp.state === 'open' && prCp.command === 'touch ran.txt' && !fs.existsSync(path.join(MC, 'pages', 'ran.txt')), pr.text);
const done = new Set(['/api/plan/answer', '/api/checkpoints/answer', '/api/machines/add', '/api/machines/remove', '/api/settings/handoff', '/api/pages/item/set', '/api/pages/trust', '/api/pages/run']);
const blocked = [];
for (const r of personRows) {
  if (done.has(eg(r))) continue;
  const res = await call(r.m, eg(r), bodyOf(r));
  if (res.status === 403 && res.body && res.body.notPerson) blocked.push(`${r.m} ${eg(r)}: ${res.text}`);
}
check(`from outside, every other person row passes the check (${personRows.length - done.size} calls)`, blocked.length === 0, blocked.join('\n      '));
dc.close();

console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
