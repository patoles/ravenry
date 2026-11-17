// The guard every read of a protected folder goes through
// (server/access.mjs guard). A FIFO stands for macOS's question: opening
// it waits until a writer comes, as a read of ~/Documents waits for the
// person's answer, and a file named like a brief inside the protected
// folder is a FIFO too, so a read that got past the guard would hang this
// test (it is killed after 20 s and fails).
//
//   - before the answer, every way the hub touches a file there fails at
//     once: the synchronous calls throw EPERM, existsSync says false, the
//     callback and promise calls fail on the next turn, a watch throws, a
//     child started in the folder fails as in a missing folder (never
//     waits), and the first touch asked for the folder off the main thread;
//   - a folder outside stays untouched by the guard;
//   - after the answer the same calls read the folder.
//
// Usage: node tools/access-guard-test.mjs
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { readFileSync as namedRead } from 'node:fs';
import { execFileSync } from 'node:child_process';

const S = fs.mkdtempSync(path.join(process.env.RAVENRY_TEST_SCRATCH || os.tmpdir(), 'access-guard-'));
const DOCS = path.join(S, 'Documents');
const OUT = path.join(S, 'code');
fs.mkdirSync(path.join(DOCS, 'kite'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'BRIEF.md'), 'outside\n');
const ASK = path.join(S, 'documents-read');
execFileSync('mkfifo', [ASK]);
// A brief that would hold any read that got past the guard.
execFileSync('mkfifo', [path.join(DOCS, 'kite', 'BRIEF.md')]);
process.env.MC_ACCESS_PROBE = JSON.stringify({ [DOCS]: ASK });
process.env.MC_ACCESS_GRACE_MS = '300';

const access = await import('../server/access.mjs');
access.guard();
const killer = setTimeout(() => { console.log('FAIL  a read got past the guard and waited (20 s)'); process.exit(1); }, 20000);
killer.unref();

let fails = 0;
let passes = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 400) : ''}`); if (ok) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BRIEF = path.join(DOCS, 'kite', 'BRIEF.md');
const code = (f) => { try { f(); return 'none'; } catch (e) { return e.code; } };

const t0 = Date.now();
check('readFileSync in the folder not answered: EPERM at once', code(() => fs.readFileSync(BRIEF, 'utf8')) === 'EPERM');
check('and a named import of it too', code(() => namedRead(BRIEF, 'utf8')) === 'EPERM');
check('statSync, readdirSync, openSync, realpathSync: EPERM', ['statSync', 'readdirSync', 'openSync', 'realpathSync'].every((f) => code(() => fs[f](f === 'readdirSync' ? path.join(DOCS, 'kite') : BRIEF)) === 'EPERM'));
check('a write there: EPERM, nothing written', code(() => fs.writeFileSync(path.join(DOCS, 'kite', 'new.md'), 'x')) === 'EPERM');
check('existsSync says false', fs.existsSync(BRIEF) === false && fs.existsSync(path.join(DOCS, 'kite')) === false);
const cb = await new Promise((r) => fs.readFile(BRIEF, (e) => r(e && e.code)));
check('the callback call fails on the next turn', cb === 'EPERM');
const pr = await fs.promises.readFile(BRIEF).then(() => 'read', (e) => e.code);
check('the promise call is refused', pr === 'EPERM');
check('a watch there throws', code(() => fs.watch(path.join(DOCS, 'kite'))) === 'EPERM');
const sp = cp.spawnSync('/bin/cat', ['BRIEF.md'], { cwd: path.join(DOCS, 'kite'), timeout: 5000 });
check('a child started in the folder fails as in a missing folder (never waits)', !!sp.error && sp.error.code === 'ENOENT', JSON.stringify(sp.error));
const asy = await new Promise((r) => { const c = cp.spawn('/bin/cat', ['BRIEF.md'], { cwd: path.join(DOCS, 'kite') }); c.on('error', (e) => r(e.code)); c.on('exit', (n) => r('exit ' + n)); });
check('and so does an async child', asy === 'ENOENT', asy);
check('all of it took no time (under 1 s)', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
check('outside the folder nothing is in the way', fs.readFileSync(path.join(OUT, 'BRIEF.md'), 'utf8') === 'outside\n' && fs.existsSync(OUT));
check('the first touch asked for the folder', access.view().blocked.some((b) => b.path === DOCS));
await sleep(500);
check('past the grace it is "waiting", named', access.view().waiting && access.view().waiting.path === DOCS && access.view().waiting.name === 'Documents', JSON.stringify(access.view()));

// The answer comes: the brief becomes a plain file (the test's own setup,
// past the guard) and the read returns.
fs.writeFileSync(path.join(OUT, 'kite.md'), '# Kite\n');
execFileSync('/bin/mv', ['-f', path.join(OUT, 'kite.md'), BRIEF]);
const w = fs.openSync(ASK, 'w');
fs.closeSync(w);
for (let i = 0; i < 50 && access.view().blocked.length; i++) await sleep(50);
check('answered: nothing blocked any more', access.view().blocked.length === 0, JSON.stringify(access.view()));
check('and the same calls read the folder (the refused write left nothing)', fs.readFileSync(BRIEF, 'utf8') === '# Kite\n' && fs.existsSync(BRIEF) && namedRead(BRIEF, 'utf8') === '# Kite\n' && !fs.existsSync(path.join(DOCS, 'kite', 'new.md')));
const sp2 = cp.spawnSync('/bin/cat', ['BRIEF.md'], { cwd: path.join(DOCS, 'kite'), encoding: 'utf8' });
check('and a child starts there', sp2.stdout === '# Kite\n', JSON.stringify(sp2.error));

// A hub whose question is never answered still exits at once (a thread of
// its own held in the question would keep the process alive for ever).
const ASK2 = path.join(S, 'never');
execFileSync('mkfifo', [ASK2]);
const exitAt = Date.now();
const hold = cp.spawnSync(process.execPath, ['--input-type=module', '-e', `
  process.env.MC_ACCESS_PROBE = ${JSON.stringify(JSON.stringify({ [DOCS + '2']: ASK2 }))};
  const a = await import(${JSON.stringify(new URL('../server/access.mjs', import.meta.url).href)});
  a.guard();
  const fs = (await import('node:fs')).default;
  fs.existsSync(${JSON.stringify(path.join(DOCS + '2', 'x'))});
  setTimeout(() => process.exit(0), 300);
`], { timeout: 10000, env: { ...process.env, TEST_RAVENRY: '1' } });
check('a hub whose question is never answered still exits at once', hold.status === 0 && Date.now() - exitAt < 5000, `${hold.status} ${hold.signal} ${Date.now() - exitAt} ms ${String(hold.stderr).slice(0, 300)}`);

fs.rmSync(S, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nALL PASS (${passes})`);
process.exit(fails ? 1 : 0);
