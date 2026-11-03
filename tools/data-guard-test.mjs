// The guards that keep tests off the real data folder, after 2026-11-03:
// tools/iterm-mode-test.mjs imported server/terminal.mjs (which loads
// server/home.mjs) before it set RAVENRY_HOME, so home.mjs settled on the
// real ~/.ravenry; the test's in-process registry.importWorkspaces() then
// wrote its scratch registry over the user's projects.json, and their board
// loaded it at its next start.
//
// The "real" data folder in the incident replays is a fake home made under
// the system temp folder, outside the repo's .tmp, so the guards treat it as
// real while nothing here can reach the real ~/.ravenry.
//
// 1. home.mjs: a test process whose data is not in .tmp refuses to load; the
//    incident's order (import, then set RAVENRY_HOME, then save) is refused
//    and the fake real registry is unchanged; a test can never write it.
// 2. tools/test-guard.mjs: a test with RAVENRY_HOME outside .tmp refuses to
//    start; with none it gets a guard home inside .tmp.
// 3. registry.save: never drops more than MAX_DROP projects at once, never
//    writes .tmp paths into a data folder that is not a test's, backs up
//    before a save that adds or loses a project, and update() never replaces
//    an unreadable file; importWorkspaces adds onto the file on disk, not the
//    board's stale copy.
// 4. The projects root: a real board never takes a folder in .tmp.
// 5. tools/open-in-iterm.mjs: a test's settings never reach a real board's
//    start command, and a shell carrying them is refused.
// 6. A board on a test's data never listens on :4600.
//
// Usage: node tools/data-guard-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'data-guard-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = path.join(T, 'mc');
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// The real file's fingerprint, before and after (read only).
const REAL = path.join(os.userInfo().homedir, '.ravenry', 'projects.json');
const realStat = () => { try { const s = fs.statSync(REAL); return `${s.mtimeMs}:${s.size}`; } catch { return 'none'; } };
const realBefore = realStat();

// A home outside the repo's .tmp that the guards treat as the user's own.
const FAKE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ravenry-guard-'));
const FAKE_DATA = path.join(FAKE, '.ravenry');
fs.mkdirSync(FAKE_DATA, { recursive: true });
const realReg = { version: 1, settings: { autoImport: true }, projects: ['arcade', 'paper-boat', 'garden', 'notes', 'porch'].map((id) => ({ id, name: id, folder: `/Users/x/${id}`, workspaces: [`W-${id}`] })) };
fs.writeFileSync(path.join(FAKE_DATA, 'projects.json'), JSON.stringify(realReg, null, 2) + '\n');
const fakeBefore = read(path.join(FAKE_DATA, 'projects.json'));

// A child with HOME at the fake home, no test marker and no RAVENRY_HOME
// unless given: a process the way the incident's test was.
const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RAVENRY_|MC_|TEST_RAVENRY$|PORT$|CMUX_|ITERM_)/.test(k)));
function child(code, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...bare, HOME: FAKE, ...env }, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const S = (f) => JSON.stringify(path.join(ROOT, f));

// ------------------------------------------------------------ 1. home.mjs

let r = child(`await import(${S('server/home.mjs')}); console.log('loaded');`, { TEST_RAVENRY: '1' });
check('home: a test process with no RAVENRY_HOME refuses to load (never falls back to ~/.ravenry)', r.code !== 0 && /must keep its data inside/.test(r.err) && r.out !== 'loaded', r.err.split('\n').find((l) => /Ravenry/.test(l)));
r = child(`await import(${S('server/home.mjs')}); console.log('loaded');`, { MC_TEST: '1', RAVENRY_HOME: path.join(FAKE, 'elsewhere') });
check('home: a test process with RAVENRY_HOME outside .tmp refuses to load', r.code !== 0 && /must keep its data inside/.test(r.err));
r = child(`const h = await import(${S('server/home.mjs')}); console.log(h.RAVENRY_HOME, h.SCRATCH_DATA);`, { TEST_RAVENRY: '1', RAVENRY_HOME: path.join(T, 'child') });
check('home: a test process with its data in .tmp loads, and knows its data is a test\'s', r.code === 0 && r.out === `${path.join(T, 'child')} true`, r.out || r.err);

// The incident, replayed against the fake home: a module that loads
// home.mjs first, RAVENRY_HOME set after, then the registry import saves.
r = child(`
  await import(${S('server/terminal.mjs')});
  process.env.RAVENRY_HOME = ${JSON.stringify(path.join(T, 'late'))};
  const registry = await import(${S('server/registry.mjs')});
  console.log('path', registry.REGISTRY_PATH);
  try {
    registry.importWorkspaces({ version: 1, settings: { projectsRoot: ${JSON.stringify(path.join(T, 'root'))} }, projects: [{ id: 'arcade', folder: ${JSON.stringify(path.join(T, 'root', 'arcade-sdk'))}, workspaces: ['A0'] }] }, [{ id: 'E9', ref: 'workspace:9', title: '', surfaces: [] }], () => null);
    console.log('wrote');
  } catch (e) { console.log('refused', e.code, e.message); }
`);
check('incident: the registry settled on the (fake) real data folder before RAVENRY_HOME was set', r.out.includes(`path ${path.join(FAKE_DATA, 'projects.json')}`), r.out || r.err);
check('incident: the save is refused, saying RAVENRY_HOME changed after the data folder was settled', /refused EREFUSED .*RAVENRY_HOME is now/.test(r.out) && !/wrote/.test(r.out), r.out || r.err);
check('incident: the (fake) real projects.json is unchanged', read(path.join(FAKE_DATA, 'projects.json')) === fakeBefore);

// A test (marked) that somehow settled on the real folder: no write at all.
r = child(`
  const h = await import(${S('server/home.mjs')});
  process.env.TEST_RAVENRY = '1';
  try { h.assertDataWrite(${JSON.stringify(path.join(FAKE_DATA, 'projects.json'))}); console.log('allowed'); } catch (e) { console.log('refused', e.message); }
  try { h.assertDataWrite(${JSON.stringify(REAL)}); console.log('allowed'); } catch (e) { console.log('refused', e.message); }
  try { h.assertDataWrite(${JSON.stringify(path.join(T, 'x', 'projects.json'))}); console.log('allowed'); } catch (e) { console.log('refused', e.message); }
`);
const lines = r.out.split('\n');
check('home: a test never writes the (fake) real data folder', /^refused .*a test never writes/.test(lines[0] || ''), lines[0]);
check('home: ...nor the account\'s own ~/.ravenry, whatever HOME says', /^refused /.test(lines[1] || ''), lines[1]);
check('home: ...and writes inside .tmp are fine', lines[2] === 'allowed', lines[2]);

// ------------------------------------------------------------ 2. test-guard.mjs

r = child(`await import(${S('tools/test-guard.mjs')}); console.log('started');`, { RAVENRY_HOME: path.join(FAKE, 'data') });
check('guard: a test with RAVENRY_HOME outside .tmp refuses to start', r.code === 1 && /Refused: RAVENRY_HOME=/.test(r.err) && r.out !== 'started', r.err);
r = child(`const g = await import(${S('tools/test-guard.mjs')}); const h = await import(${S('server/home.mjs')}); console.log(g.GUARD_HOME, h.RAVENRY_HOME, process.env.TEST_RAVENRY);`);
check('guard: a test with no RAVENRY_HOME gets a guard home inside .tmp, before home.mjs loads', r.code === 0 && r.out.split(' ')[0].startsWith(path.join(ROOT, '.tmp') + path.sep) && r.out.split(' ')[0] === r.out.split(' ')[1] && r.out.endsWith(' 1'), r.out || r.err);
const tests = fs.readdirSync(path.join(ROOT, 'tools')).filter((f) => /-(test|e2e)\.mjs$/.test(f));
const unguarded = tests.filter((f) => !/^import '\.\/test-guard\.mjs';/m.test((read(path.join(ROOT, 'tools', f)) || '').split('\n').find((l) => l.startsWith('import ')) || ''));
check(`guard: every test (${tests.length}) imports test-guard.mjs first`, unguarded.length === 0, unguarded.join(', '));

// ------------------------------------------------------------ 3. registry.save

const registry = await import('../server/registry.mjs');
const home = await import('../server/home.mjs');
check('registry: this test\'s registry is inside .tmp', registry.REGISTRY_PATH === path.join(T, 'mc', 'projects.json') && home.SCRATCH_DATA);
const F = path.join(T, 'unit', 'projects.json');
fs.mkdirSync(path.dirname(F), { recursive: true });
const five = { version: 1, settings: {}, projects: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id, folder: `/Users/x/${id}`, workspaces: [] })) };
fs.writeFileSync(F, JSON.stringify(five, null, 2) + '\n');
const baks = () => fs.readdirSync(path.dirname(F)).filter((n) => /\.bak-\d{8}-\d{6}-structure/.test(n));
let threw = null;
try { registry.save({ ...five, projects: five.projects.slice(0, 2) }, { file: F, scratch: false }); } catch (e) { threw = e; }
check(`registry: a save that would drop 3 projects at once is refused (at most ${registry.MAX_DROP})`, threw && threw.code === 'EREFUSED' && /drop 3 projects/.test(threw.message) && JSON.parse(read(F)).projects.length === 5, threw && threw.message);
threw = null;
try { registry.save({ ...five, projects: [...five.projects, { id: 'idea', folder: path.join(T, 'home', 'projects', 'arcade-sdk') }] }, { file: F, scratch: false }); } catch (e) { threw = e; }
check('registry: a save naming paths inside the repo\'s .tmp is refused for a data folder that is not a test\'s', threw && threw.code === 'EREFUSED' && /inside the repo's \.tmp/.test(threw.message) && JSON.parse(read(F)).projects.length === 5, threw && threw.message);
threw = null;
try { registry.save({ ...five, settings: { projectsRoot: path.join(T, 'home', 'projects') } }, { file: F, scratch: false }); } catch (e) { threw = e; }
check('registry: ...a projectsRoot setting inside .tmp too', threw && threw.code === 'EREFUSED');
check('registry: refused saves made no backup', baks().length === 0, baks().join(', '));
registry.save({ ...five, projects: [...five.projects, { id: 'f', name: 'f', folder: '/Users/x/f', workspaces: [] }] }, { file: F, scratch: false });
check('registry: a save that adds a project is written, with a timestamped -structure backup of the file before it', JSON.parse(read(F)).projects.length === 6 && baks().length === 1 && JSON.parse(read(path.join(path.dirname(F), baks()[0]))).projects.length === 5, baks().join(', '));
registry.save({ ...five, projects: JSON.parse(read(F)).projects.slice(0, 4) }, { file: F, scratch: false });
check('registry: dropping 2 at once is allowed (hand edits), and backed up first', JSON.parse(read(F)).projects.length === 4 && baks().length === 2);
const before = read(F);
registry.save({ ...JSON.parse(before), settings: { handbackHours: 12 } }, { file: F, scratch: false });
check('registry: a save that only changes settings makes no structural backup', baks().length === 2);
registry.save({ ...five, projects: [...five.projects, { id: 'g', folder: path.join(T, 'p', 'g') }] }, { file: path.join(T, 'unit', 'scratch.json'), scratch: true });
check('registry: a test\'s own data folder may hold .tmp paths', JSON.parse(read(path.join(T, 'unit', 'scratch.json'))).projects.length === 6);
check('registry: refuseSave names the real data folder as off limits to a test', /a test never writes/.test(registry.refuseSave(five, null, { file: REAL, scratch: false }) || ''), registry.refuseSave(five, null, { file: REAL, scratch: false }));

// update() never replaces a file it cannot read.
fs.writeFileSync(registry.REGISTRY_PATH, '{ "version": 1, "projects": [ broken');
threw = null;
try { registry.update((x) => { x.projects.push({ id: 'z' }); }); } catch (e) { threw = e; }
check('registry: update() on an unreadable projects.json throws and leaves it as it is', threw && /cannot read/.test(threw.message) && read(registry.REGISTRY_PATH).endsWith('broken'), threw && threw.message);
threw = null;
try { registry.importWorkspaces(null, [{ id: 'W-1', ref: 'workspace:1', title: 'One', surfaces: [] }], () => null); } catch (e) { threw = e; }
check('registry: a first import (nothing loaded) never replaces a projects.json that is there but unreadable', threw && threw.code === 'EREFUSED' && read(registry.REGISTRY_PATH).endsWith('broken'), threw && threw.message);

// importWorkspaces adds onto the file on disk: the board's stale copy (here
// the registry before three projects were added by hand) never drops them.
fs.writeFileSync(registry.REGISTRY_PATH, JSON.stringify({ version: 1, settings: { autoImport: true }, projects: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id, folder: null, workspaces: [`W-${id}`] })) }, null, 2) + '\n');
const stale = { version: 1, settings: { autoImport: true }, projects: ['a', 'b'].map((id) => ({ id, name: id, folder: null, workspaces: [`W-${id}`] })) };
const imp = registry.importWorkspaces(stale, [{ id: 'W-new', ref: 'workspace:3', title: '✳ New thing', surfaces: [] }], () => null);
const disk = JSON.parse(read(registry.REGISTRY_PATH));
check('registry: a new workspace is added onto the file on disk, keeping the projects the board\'s copy lacked', imp.added.length === 1 && disk.projects.map((p) => p.id).join(',') === 'a,b,c,d,e,new-thing' && imp.reg.projects.length === 6, disk.projects.map((p) => p.id).join(','));

// ------------------------------------------------------------ 4. projects root

const pr = await import('../server/projectsroot.mjs');
const TROOT = path.join(T, 'home', 'projects');
fs.mkdirSync(TROOT, { recursive: true });
let v = pr.resolve({ settings: { projectsRoot: TROOT }, projects: [] }, { env: '', home: FAKE, dataHome: FAKE_DATA, scratch: false });
check('root: a real board ignores a projectsRoot setting inside the repo\'s .tmp', v.source !== 'setting' && v.path !== TROOT, JSON.stringify(v));
v = pr.resolve({ settings: {}, projects: [] }, { env: TROOT, home: FAKE, dataHome: FAKE_DATA, scratch: false });
check('root: ...and MC_PROJECTS_ROOT inside .tmp', v.source !== 'env', JSON.stringify(v));
v = pr.resolve({ settings: { projectsRoot: TROOT }, projects: [] }, { env: '', home: FAKE, dataHome: FAKE_DATA, scratch: true });
check('root: a test board keeps its .tmp root', v.source === 'setting' && v.path === TROOT);
const cr = pr.checkRoot(TROOT, { home: path.dirname(ROOT), dataHome: FAKE_DATA, scratch: false });
check('root: Change refuses a folder inside .tmp on a real board', cr.ok === false && /scratch folder/.test(cr.error), JSON.stringify(cr));
const sp = pr.sharedParent([{ id: 'a', folder: path.join(TROOT, 'a') }, { id: 'b', folder: path.join(TROOT, 'b') }], { home: path.dirname(ROOT), dataHome: FAKE_DATA, scratch: false });
check('root: projects in .tmp never make the shared folder on a real board', sp === null, JSON.stringify(sp));
r = child(`const reg = await import(${S('server/registry.mjs')}); const { config } = await import(${S('server/config.mjs')}); const i = reg.importWorkspaces({ version: 1, settings: { projectsRoot: ${JSON.stringify(TROOT)} }, projects: reg.load().projects }, [], () => null); console.log(JSON.stringify(config({ projectsRoot: ${JSON.stringify(TROOT)} }).projectsRoot), reg.settingRoot({ projectsRoot: ${JSON.stringify(TROOT)} }));`);
check('root: a real board\'s config and import never use a .tmp projectsRoot', r.code === 0 && r.out === 'null null', r.out || r.err);
r = child(`const reg = await import(${S('server/registry.mjs')}); const i = reg.importWorkspaces(reg.load(), [{ id: 'W-tmp', ref: 'workspace:4', title: '', surfaces: [] }], () => ${JSON.stringify(path.join(T, 'home', 'projects', 'arcade-sdk'))}); console.log(JSON.stringify(i.added.map((p) => p.folder)));`);
check('root: a real board imports a workspace sitting in .tmp with no folder (so it never writes a .tmp path)', r.code === 0 && r.out === '[null]', r.out || r.err);
fs.writeFileSync(path.join(FAKE_DATA, 'projects.json'), fakeBefore);

// ------------------------------------------------------------ 5. the iTerm2 opener

const tool = await import('./open-in-iterm.mjs');
const testEnv = { PORT: '4684', RAVENRY_HOME: path.join(T, 'mc2'), MC_PROJECTS_ROOT: TROOT, MC_TEST: '1', RAVENRY_ITERM_PYTHON: '/usr/bin/python3' };
const cmdReal = tool.startCommand(testEnv);
check('iterm: a real iTerm2\'s start command never carries a .tmp RAVENRY_HOME or projects root, or the test marker', !/\.tmp/.test(cmdReal) && !/MC_TEST/.test(cmdReal) && /PORT='4684'/.test(cmdReal), cmdReal);
check('iterm: the fake iTerm2 (a test) still gets the scratch board\'s settings', /RAVENRY_HOME='[^']*\.tmp/.test(tool.startCommand({ ...testEnv, ITERM_OSASCRIPT_BIN: '/x' })));
check('iterm: a second real board (PORT and a RAVENRY_HOME of its own) is passed as before', tool.startCommand({ PORT: '4602', RAVENRY_HOME: '/Users/x/scratch' }).endsWith(`PORT='4602' RAVENRY_HOME='/Users/x/scratch' npm start`));
check('iterm: testVars names what would carry a test into a real board', tool.testVars(testEnv).join(',') === 'MC_PROJECTS_ROOT,MC_TEST,RAVENRY_HOME', tool.testVars(testEnv).join(','));
r = child(`const t = await import(${S('tools/open-in-iterm.mjs')}); const out = []; const code = await t.main([], (l) => out.push(l)); console.log(code, out.join(' | '));`, { RAVENRY_HOME: path.join(T, 'mc2'), PORT: '4684' });
check('iterm: npm run iterm from a shell with a test\'s RAVENRY_HOME is refused before iTerm2 is touched', r.code === 0 && /^1 Refused: this shell carries a test's settings \(RAVENRY_HOME\)/.test(r.out), r.out || r.err);

// ------------------------------------------------------------ 6. the real port

r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { cwd: ROOT, env: { ...bare, RAVENRY_HOME: path.join(T, 'board'), PORT: '4600', MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json') }, encoding: 'utf8', timeout: 20000 });
check('board: a board on a test\'s data refuses :4600, the real board\'s port', r.status === 1 && /is a test's, and :4600 is the real board's port/.test(r.stderr), (r.stderr || '').trim().split('\n').pop());

fs.rmSync(FAKE, { recursive: true, force: true });
check('the real ~/.ravenry/projects.json is untouched by this test', realStat() === realBefore, `${realBefore} -> ${realStat()}`);
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
