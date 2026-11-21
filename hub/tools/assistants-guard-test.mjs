// No test reaches the person's own assistants (Claude Code, Codex,
// Antigravity CLI, OpenCode): every test, its boards, its ravenryd and its
// app find a stand-in for each one they would find as the person's own
// (tools/test-env.mjs, the assistants). On 2026-11-21 a test board with the
// person's PATH started their OpenCode, which called its model.
//
// Fails when:
// - this test, or a child of it, finds the person's own assistant;
// - a test board started with the person's whole PATH (and a scratch HOME)
//   lists one (GET /api/setup/start, the hub's own findBin);
// - a PATH holding a person's assistant comes back without a stand-in in
//   front (a made-up "person's" folder, so it holds on any machine);
// - the person's own binary, named by its path, starts (as a program or in
//   a shell command line);
// - a tool other than hub/tools/opencode-test.mjs (OpenCode) or
//   antigravity-test.mjs (agy) opts in, or one of them to another assistant;
// - a tool that starts a board, ravenryd or an app does it outside the
//   guard (guardSpawns, test-guard.mjs or standInPath; selftest.sh through
//   `node tools/test-env.mjs path`).
//
// Board on :4719. Touches only .tmp/.
//
//   node tools/assistants-guard-test.mjs
import { withTestHome } from './test-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_BINS, STAND_INS, assistantsFound, isStandIn, realAssistantsIn, standInPath, REPO } from '../../tools/test-env.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'assistants-guard-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + String(detail).slice(0, 1500) : ''}`); if (!ok) fails++; return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const standInOrNone = (f) => !f || isStandIn(f);

// The PATH the person ran this test with (the guard put its stand-ins first).
const PERSON_PATH = String(process.env.PATH || '').split(path.delimiter).filter((d) => d && !d.startsWith(STAND_INS + path.sep)).join(path.delimiter);
const realHere = realAssistantsIn({ PATH: PERSON_PATH, HOME: process.env.HOME });
console.log(`the person's own assistants on this machine: ${realHere.map((r) => `${r.bin} ${r.file}`).join(', ') || 'none'}`);

// ------------------------------------------------------------ the test's own process and its children
{
  const found = assistantsFound(process.env);
  check('this test finds a stand-in or nothing for each assistant', ASSISTANT_BINS.every((b) => standInOrNone(found[b])), JSON.stringify(found));
  const sh = spawnSync('/bin/sh', ['-c', `for b in ${ASSISTANT_BINS.join(' ')}; do command -v "$b" || echo none; done`], { encoding: 'utf8' });
  const lines = sh.stdout.trim().split('\n');
  check('a shell it starts finds a stand-in or nothing', lines.length === 4 && lines.every((l) => l === 'none' || isStandIn(l)), sh.stdout + sh.stderr);
  // A child given the person's whole PATH from scratch, and the real HOME's install folders.
  const fb = spawnSync('/bin/sh', ['-c', `for b in ${ASSISTANT_BINS.join(' ')}; do command -v "$b" || echo none; done`], { env: { PATH: PERSON_PATH, HOME: process.env.HOME }, encoding: 'utf8' });
  const fl = fb.stdout.trim().split('\n');
  check('a child given the person\'s PATH finds a stand-in or nothing', fl.length === 4 && fl.every((l) => l === 'none' || isStandIn(l)), fb.stdout + fb.stderr);
  const hub = spawnSync(process.execPath, ['--input-type=module', '-e', `import('${path.join(ROOT, 'server', 'assistantfind.mjs')}').then((m) => console.log(JSON.stringify(['claude','codex','antigravity','opencode'].map((k) => m.findBin(k)))))`], { env: { PATH: PERSON_PATH, HOME: process.env.HOME, TEST_RAVENRY: '1' }, encoding: 'utf8' });
  let bins = null;
  try { bins = JSON.parse(hub.stdout.trim().split('\n').pop()); } catch { /* below */ }
  check('the hub\'s findBin, in a child with the person\'s PATH and HOME, finds a stand-in or nothing', Array.isArray(bins) && bins.every(standInOrNone), hub.stdout + hub.stderr);
}

// ------------------------------------------------------------ a PATH holding a person's assistant (any machine)
{
  const person = path.join(T, 'person-bin');
  fs.mkdirSync(person, { recursive: true });
  for (const b of ASSISTANT_BINS) fs.writeFileSync(path.join(person, b), '#!/bin/sh\necho REAL\n', { mode: 0o755 });
  const asPerson = (f) => !f.startsWith(person + path.sep) && isStandIn(f);
  const env = { PATH: `/usr/bin:${person}:/bin`, HOME: path.join(T, 'home') };
  check('a made-up person\'s folder reads as the person\'s own, all four', realAssistantsIn(env, { isStand: asPerson }).length === 4);
  const PATH = standInPath(env, { isStand: asPerson });
  const after = assistantsFound({ ...env, PATH });
  check('standInPath puts a stand-in first for each of them', ASSISTANT_BINS.every((b) => after[b] && after[b].startsWith(STAND_INS + path.sep)) && realAssistantsIn({ ...env, PATH }, { isStand: asPerson }).length === 0, PATH);
  check('the rest of the PATH is kept in its order', PATH.split(':').slice(4).join(':') === env.PATH, PATH);
  const only = standInPath({ PATH: '/usr/bin:/bin', HOME: env.HOME }, { isStand: asPerson });
  check('a PATH that finds no assistant stays as it was (a test of "not installed" still works)', only === '/usr/bin:/bin', only);
  const opted = standInPath(env, { isStand: asPerson, allowed: new Set(['opencode']) });
  check('one opted in is left as the person\'s; the other three get stand-ins', assistantsFound({ ...env, PATH: opted }).opencode === path.join(person, 'opencode') && ['claude', 'codex', 'agy'].every((b) => assistantsFound({ ...env, PATH: opted })[b].startsWith(STAND_INS)), opted);
  const kept = path.join(T, 'own-stand-in');
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'claude'), '#!/bin/sh\necho OWN\n', { mode: 0o755 });
  const k = standInPath({ PATH: `${kept}:/usr/bin:/bin`, HOME: env.HOME });
  check('a test\'s own stand-in first on its PATH is kept', k === `${kept}:/usr/bin:/bin`, k);
  // A child started with the made-up person's folder only: through the guard, its stand-ins.
  const r = spawnSync('/bin/sh', ['-c', 'claude; codex; agy; opencode'], { env: { PATH: `${person}:/usr/bin:/bin`, HOME: env.HOME }, encoding: 'utf8' });
  check('a test\'s own folder of assistants (in .tmp) is the test\'s: the guard leaves it', /REAL/.test(r.stdout), r.stdout + r.stderr);
}

// ------------------------------------------------------------ the person's own binary, named by its path
if (realHere.length) {
  const own = realHere[0].file;
  let err = null;
  try { spawnSync(own, ['--version'], { encoding: 'utf8' }); } catch (e) { err = e; }
  check(`the person's own ${realHere[0].bin} by its path is refused`, !!err && /Refused to start/.test(err.message), err ? err.message : 'it started');
  err = null;
  try { execFileSync('/bin/sh', ['-c', `${own} --version`], { encoding: 'utf8' }); } catch (e) { err = e; }
  check('and in a shell command line', !!err && /Refused to start/.test(err.message), err ? err.message : 'it started');
  err = null;
  try { spawnSync(own, ['--version'], { encoding: 'utf8', shell: true }); } catch (e) { err = e; }
  check('and with shell: true', !!err && /Refused to start/.test(err.message), err ? err.message : 'it started');
} else console.log('SKIP  the person\'s own binary refused: none on this machine');

// ------------------------------------------------------------ opting in
{
  const TE = path.join(REPO, 'tools', 'test-env.mjs');
  const tryOpt = (bin, script) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { useRealAssistant, assistantsFound } from '${TE}'; useRealAssistant('${bin}', '${script}'); console.log(JSON.stringify(assistantsFound(process.env)));`], { env: { PATH: PERSON_PATH, HOME: process.env.HOME }, encoding: 'utf8' });
  const other = tryOpt('claude', path.join(ROOT, 'tools', 'new-session-test.mjs'));
  check('another test may not opt in to a real assistant', other.status !== 0 && /Refused: new-session-test\.mjs may not run the person's own claude/.test(other.stderr), other.stderr.slice(-400));
  const wrong = tryOpt('agy', path.join(ROOT, 'tools', 'opencode-test.mjs'));
  check('opencode-test may not opt in to agy', wrong.status !== 0 && /Refused/.test(wrong.stderr), wrong.stderr.slice(-400));
  const elsewhere = tryOpt('opencode', path.join(T, 'opencode-test.mjs'));
  check('a file named opencode-test.mjs outside hub/tools may not either', elsewhere.status !== 0 && /Refused/.test(elsewhere.stderr), elsewhere.stderr.slice(-400));
  const ok = tryOpt('opencode', path.join(ROOT, 'tools', 'opencode-test.mjs'));
  check('opencode-test opts in to OpenCode', ok.status === 0, ok.stderr.slice(-400));
  // Only those two call it.
  // Tracked or not; besides them, only where it is defined, exported and tested.
  const callers = execFileSync('git', ['-C', REPO, 'grep', '--untracked', '-l', 'useRealAssistant(', '--', '*.mjs', '*.js', '*.cjs', '*.sh', ':!node_modules', ':!.tmp'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const want = ['hub/tools/antigravity-test.mjs', 'hub/tools/assistants-guard-test.mjs', 'hub/tools/opencode-test.mjs', 'hub/tools/test-guard.mjs', 'tools/test-env.mjs'];
  check('only opencode-test and antigravity-test call useRealAssistant', JSON.stringify(callers) === JSON.stringify(want), callers.join(' '));
  const ag = fs.readFileSync(path.join(ROOT, 'tools', 'antigravity-test.mjs'), 'utf8');
  const at = ag.indexOf("useRealAssistant('agy')");
  check('antigravity-test opts in only after the run asked (--model or --no-model)', at > 0 && ag.lastIndexOf("process.argv.includes('--model')", at) > 0 && ag.lastIndexOf('process.exit', at) > ag.lastIndexOf("process.argv.includes('--model')", at));
}

// ------------------------------------------------------------ every launcher under the guard
{
  const dirs = ['hub/tools', 'apps/desktop/tools', 'apps/phone/tools', 'apps/macos/scripts', 'tools'];
  // Starts a board, ravenryd or an app.
  const STARTS = /server[/\\']+index\.mjs|startDemoHub\(|ravenryd['"]?\)?,?\s*\[\s*'serve'|Contents\/MacOS|electron\b.*spawn|_electron\.launch|spawn\([^)]*\bEXE\b|bin\/ravenry\.mjs/;
  const GUARDED = /test-guard\.mjs|guardSpawns\(\)|standInPath\(/;
  // Modules that start nothing themselves, imported by a guarded tool.
  const IMPORTED = new Set(['apps/macos/scripts/sessb-fixture.mjs', 'apps/macos/scripts/write-fixture.mjs', 'apps/macos/scripts/cards-fixture.mjs', 'apps/macos/scripts/decisions-fixture.mjs', 'apps/macos/scripts/gallery-fixture.mjs', 'apps/macos/scripts/pages-fixture.mjs', 'apps/macos/scripts/testapp.mjs', 'apps/macos/scripts/package.mjs', 'hub/tools/as-phone.mjs', 'hub/tools/machine-shapes.mjs']);
  const loose = [];
  for (const d of dirs) {
    for (const n of fs.readdirSync(path.join(REPO, d))) {
      if (!/\.(mjs|cjs|js)$/.test(n)) continue;
      const rel = `${d}/${n}`;
      // Its code, not its comments.
      const s = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (STARTS.test(s) && !GUARDED.test(s) && !IMPORTED.has(rel)) loose.push(rel);
    }
  }
  check('every tool that starts a board, ravenryd or an app does it under the guard', loose.length === 0, loose.join(' '));
  const st = fs.readFileSync(path.join(REPO, 'apps', 'macos', 'scripts', 'selftest.sh'), 'utf8');
  check('selftest.sh gives its daemon and app the guard\'s PATH', /tools\/test-env\.mjs" path /.test(st) && /PATH=\$testpath /.test(st) && !/PATH=\/usr\/bin:\/bin /.test(st));
}

// ------------------------------------------------------------ a test board with the person's PATH
{
  const PORT = 4719;
  const MC = path.join(T, 'mc');
  fs.mkdirSync(MC, { recursive: true });
  const env = withTestHome({ PATH: PERSON_PATH, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', TEST_RAVENRY: '1', CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'), MC_PROJECTS_ROOT: path.join(T, 'projects'), MC_CLAUDE_PROJECTS: path.join(T, 'claude'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'), RAVENRY_HUB_BIND: '127.0.0.1' }, path.join(T, 'home'));
  const board = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  board.stdout.on('data', (d) => { log += d; });
  board.stderr.on('data', (d) => { log += d; });
  let sv = null;
  for (let i = 0; i < 80 && !sv; i++) { try { sv = await (await fetch(`http://127.0.0.1:${PORT}/api/setup/start`)).json(); } catch { await sleep(250); } }
  const list = (sv && sv.assistants) || [];
  check('a test board started with the person\'s PATH lists only stand-ins (or nothing) for the four', list.length === 4 && list.every((a) => standInOrNone(a.path)), JSON.stringify(list.map((a) => [a.kind, a.path])) + log.slice(-600));
  if (realHere.length) check('and finds a stand-in where the person has the real one', realHere.every((r) => { const a = list.find((x) => x.bin === r.bin); return a && a.path && a.path.startsWith(STAND_INS); }), JSON.stringify(list.map((a) => [a.bin, a.path])));
  board.kill();
}

if (!fails) fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
