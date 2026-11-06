// Where new projects go (docs/design/ProjectsRoot.dc.html), proved without
// a real Finder dialog: Finder is tools/stub-choose-folder.mjs.
//
// 1. In process, on a crafted home under .tmp: the order (MC_PROJECTS_ROOT,
//    the setting, the folder most projects share, asking), the first-run
//    suggestion (~/Developer, ~/Projects, ~/Code, ~/dev, ~/src, else
//    ~/Projects made on first use), the root guards (the same as an
//    existing project folder), and adopt() saving the shared folder once.
// 2. A test board on :4668 (fake cmux, no shared setting): the shared folder
//    saved as the setting on its first look, with a backup; Change through
//    the stubbed dialog; the guards through the route; a new project made in
//    the new root; "Change for this one" making one project's folder under
//    another parent (guarded, its own taken check, the default unchanged);
//    a phone refused with 403.
// 3. A board on :4669 with MC_PROJECTS_ROOT: locked, saving refused.
// 4. A board on :4670 with no projects: the first-run question's data, and
//    its answer saved.
// Touches only .tmp/.
//
// Usage: node tools/projects-root-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'projects-root');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = path.join(T, 'unit-mc');
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });
delete process.env.MC_PROJECTS_ROOT;

const pr = await import('../server/projectsroot.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 1. in process
const H = path.join(T, 'home');
const DATA = path.join(H, '.ravenry');
const DEV = path.join(H, 'Documents', 'DEV', 'projects');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(H, 'Library', 'Caches'), { recursive: true });
for (const n of ['a', 'b', 'c']) fs.mkdirSync(path.join(DEV, n), { recursive: true });
fs.mkdirSync(path.join(H, 'Work', 'x'), { recursive: true });
fs.mkdirSync(path.join(H, 'loose'), { recursive: true });
const o = { home: H, dataHome: DATA, env: '' };
const P = (id, folder, extra = {}) => ({ id, name: id, folder, ...extra });
const three = [P('a', path.join(DEV, 'a')), P('b', path.join(DEV, 'b')), P('c', path.join(DEV, 'c')), P('w', path.join(H, 'Work', 'x'))];

let r = pr.resolve({ settings: {}, projects: three }, o);
check('order 3: no setting, the folder most projects share (3 of 4)', r.source === 'shared' && r.path === DEV && r.count === 3 && r.total === 4, JSON.stringify(r));
r = pr.resolve({ settings: { projectsRoot: path.join(H, 'Work'), projectsRootFrom: 'chosen' }, projects: three }, o);
check('order 2: the setting beats the shared folder, with where it came from', r.source === 'setting' && r.path === path.join(H, 'Work') && r.from === 'chosen' && r.count === 1, JSON.stringify(r));
r = pr.resolve({ settings: { projectsRoot: path.join(H, 'Work') }, projects: three }, { ...o, env: path.join(H, 'Elsewhere') });
check('order 1: MC_PROJECTS_ROOT beats the setting', r.source === 'env' && r.path === path.join(H, 'Elsewhere'), JSON.stringify(r));
r = pr.resolve({ settings: {}, projects: [] }, o);
check('order 4: no projects and nothing set asks, with ~/Projects to be made as the suggestion', r.source === 'ask' && r.suggestion && r.suggestion.path === path.join(H, 'Projects') && r.suggestion.exists === false && r.path === path.join(H, 'Projects'), JSON.stringify(r));
r = pr.resolve({ settings: {}, projects: [P('h', path.join(H, 'loose')), P('h2', path.join(H, 'loose'), { hidden: true })] }, o);
check('order 4: projects whose shared parent is the home folder itself do not count, so it asks', r.source === 'ask', JSON.stringify(r));
r = pr.resolve({ settings: {}, projects: [P('n', null), P('h', path.join(DEV, 'a'), { hidden: true })] }, o);
check('first run: projects with no folder, or hidden, are nothing to go on', r.source === 'ask');
const v = pr.view({ settings: {}, projects: [] }, o);
check('first run: the view asks and names the suggestion with ~', v.ask === true && v.suggestion.path === '~/Projects' && v.path === '~/Projects' && !v.locked, JSON.stringify(v));

// The suggestion: the first of the usual folders that exists.
fs.mkdirSync(path.join(H, 'src'));
check('suggestion: ~/src when it is the only one there', pr.suggestion({ home: H }).path === path.join(H, 'src'));
fs.mkdirSync(path.join(H, 'Code'));
check('suggestion: ~/Code comes before ~/src', pr.suggestion({ home: H }).path === path.join(H, 'Code'));
fs.mkdirSync(path.join(H, 'Developer'));
check('suggestion: ~/Developer comes first, and exists', pr.suggestion({ home: H }).path === path.join(H, 'Developer') && pr.suggestion({ home: H }).exists === true);
for (const n of ['src', 'Code', 'Developer']) fs.rmSync(path.join(H, n), { recursive: true });

// The guards: the same as an existing project folder.
const g = (p) => pr.checkRoot(p, { home: H, dataHome: DATA });
for (const [label, p, re] of [
  ['the home folder itself', H, /home folder itself/], ['~/Library', path.join(H, 'Library'), /Library/], ['inside ~/Library', path.join(H, 'Library', 'Caches'), /Library/],
  ["the board's data folder", DATA, /data folder/], ['a file', path.join(H, 'Work', 'x', 'f.txt'), /is a file/], ['outside the home folder', os.tmpdir(), /outside your home folder|system folder/],
  ['a missing folder that is not the suggestion', path.join(H, 'Nope'), /is not there/],
]) {
  if (label === 'a file') fs.writeFileSync(path.join(H, 'Work', 'x', 'f.txt'), 'x');
  const x = g(p);
  check(`guard: ${label} is refused`, !x.ok && re.test(x.error), x.error);
}
let x = g(path.join(H, 'Work'));
check('guard: a folder inside the home folder is accepted', x.ok && x.folder === fs.realpathSync(path.join(H, 'Work')));
x = g(path.join(H, 'Projects'));
check('guard: the missing ~/Projects suggestion is accepted, to be made on first use', x.ok && x.missing === true);

// ------------------------------------------------------------ boards
const LAN = (() => {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
  out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  return out[0] && out[0].address;
})();

const servers = [];
async function board(name, port, regJson, extraEnv = {}) {
  const mc = path.join(T, name, 'mc');
  fs.mkdirSync(mc, { recursive: true });
  const fake = path.join(T, name, 'fake-cmux.json');
  fs.writeFileSync(fake, JSON.stringify({ workspaces: [], screens: {} }));
  if (regJson) fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify(regJson, null, 2));
  const choose = path.join(T, name, 'choose.txt');
  fs.writeFileSync(choose, 'cancel\n');
  const env = {
    ...process.env, RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
    CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: fake,
    MC_CHOOSE_FOLDER_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-choose-folder.mjs')]),
    STUB_CHOOSE_FILE: choose, ...extraEnv,
  };
  if (!('MC_PROJECTS_ROOT' in extraEnv)) delete env.MC_PROJECTS_ROOT;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  servers.push(srv);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* not yet */ } await sleep(250); }
  await sleep(700);
  return {
    mc, choose, base, log: () => log,
    reg: () => JSON.parse(fs.readFileSync(path.join(mc, 'projects.json'), 'utf8')),
    state: async () => (await fetch(base + '/api/state')).json(),
    get: async (p) => (await fetch(base + p)).json(),
    post: async (p, body) => { const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) }); return { status: res.status, j: await res.json() }; },
  };
}

const PROJ = path.join(T, 'b1', 'projs');
const ELSE = path.join(T, 'b1', 'elsewhere');
for (const n of ['one', 'two', 'three']) fs.mkdirSync(path.join(PROJ, n), { recursive: true });
fs.mkdirSync(path.join(ELSE, 'four'), { recursive: true });
const NEWROOT = path.join(T, 'b1', 'chosen-root');
fs.mkdirSync(NEWROOT, { recursive: true });
const base1 = { version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), launchCommand: 'echo LAUNCHED:' },
  projects: [...['one', 'two', 'three'].map((n) => ({ id: n, name: n, folder: path.join(PROJ, n), workspaces: [], brief: null })), { id: 'four', name: 'four', folder: path.join(ELSE, 'four'), workspaces: [], brief: null }] };

try {
  // ---- 2. shared folder adopted, then Change
  const b = await board('b1', 4668, base1);
  let rg = b.reg();
  check('board: the shared folder is saved as the setting on the first look', rg.settings.projectsRoot === PROJ && rg.settings.projectsRootFrom === 'shared', JSON.stringify({ root: rg.settings.projectsRoot, from: rg.settings.projectsRootFrom }));
  const baks = fs.readdirSync(b.mc).filter((f) => f.startsWith('projects.json.bak-'));
  check('board: that write made a backup of projects.json first', baks.length === 1 && !JSON.parse(fs.readFileSync(path.join(b.mc, baks[0]), 'utf8')).settings.projectsRoot, baks.join(','));
  let st = await b.state();
  check('board: the snapshot says where it came from: 3 of 4 projects', st.projectsRoot && st.projectsRoot.from === 'shared' && st.projectsRoot.count === 3 && st.projectsRoot.total === 4 && !st.projectsRoot.ask && !st.projectsRoot.locked, JSON.stringify(st.projectsRoot));
  let meta = await b.get('/api/meta');
  check('board: New project\'s path line uses it', meta.projectsRoot === PROJ.replace(os.homedir(), '~'), meta.projectsRoot);

  let y = await b.post('/api/settings/projects-root', { path: path.join(os.homedir(), 'Library'), from: 'chosen' });
  check('route: ~/Library refused with a sentence', y.status === 400 && /Library/.test(y.j.error), y.j.error);
  y = await b.post('/api/settings/projects-root', { path: os.homedir(), from: 'chosen' });
  check('route: the home folder refused', y.status === 400 && /home folder itself/.test(y.j.error), y.j.error);
  y = await b.post('/api/settings/projects-root', { path: b.mc, from: 'chosen' });
  check("route: the board's own data folder refused", y.status === 400 && /data folder/.test(y.j.error), y.j.error);
  y = await b.post('/api/settings/projects-root', { path: path.join(PROJ, 'one', 'nope'), from: 'chosen' });
  check('route: a folder that is not there refused', y.status === 400 && /not there/.test(y.j.error), y.j.error);
  check('route: nothing changed after the refusals', b.reg().settings.projectsRoot === PROJ);

  // Change: Finder's dialog (stubbed) through the existing endpoint, then saved.
  fs.writeFileSync(b.choose, NEWROOT + '\n');
  const ch = await b.post('/api/project/choose-folder', { purpose: 'root' });
  check('change: the choose-folder endpoint returns the picked folder', ch.status === 200 && ch.j.entry && ch.j.entry.folder === fs.realpathSync(NEWROOT), JSON.stringify(ch.j).slice(0, 120));
  y = await b.post('/api/settings/projects-root', { path: ch.j.entry.folder, from: 'chosen' });
  rg = b.reg();
  check('change: saved as the setting, marked chosen', y.status === 200 && rg.settings.projectsRoot === fs.realpathSync(NEWROOT) && rg.settings.projectsRootFrom === 'chosen' && y.j.from === 'chosen', JSON.stringify(y.j));
  check('change: the projects already on the board did not move', rg.projects.every((p) => p.folder === base1.projects.find((q) => q.id === p.id).folder));
  fs.writeFileSync(b.choose, 'cancel\n');
  y = await b.post('/api/project/choose-folder', { purpose: 'root' });
  check('change: a cancelled dialog changes nothing', y.status === 200 && y.j.cancelled && b.reg().settings.projectsRoot === fs.realpathSync(NEWROOT));
  await sleep(600);
  y = await b.post('/api/project/new', { name: 'Fresh root', goal: 'Prove the root.', kind: 'Tool or CLI' });
  check('change: a new project is made in the new root', y.status === 200 && fs.existsSync(path.join(NEWROOT, 'fresh-root', 'BRIEF.md')), JSON.stringify(y.j).slice(0, 160));
  meta = await b.get('/api/meta');
  check('change: the New project path line follows it', meta.projectsRoot === fs.realpathSync(NEWROOT).replace(os.homedir(), '~'), meta.projectsRoot);
  // Restarting does not re-adopt: the chosen setting stays.
  check('change: no second adopt on later ticks', b.reg().settings.projectsRootFrom === 'chosen');

  // ---- "Change for this one": another parent for one project's new folder
  const OTHER = path.join(T, 'b1', 'other-parent');
  fs.mkdirSync(path.join(OTHER, 'busy'), { recursive: true });
  fs.writeFileSync(path.join(OTHER, 'busy', 'notes.txt'), 'already here\n');
  fs.writeFileSync(b.choose, OTHER + '\n');
  const cp = await b.post('/api/project/choose-folder', { purpose: 'parent' });
  check('this one: the dialog returns the parent and the names taken in it', cp.status === 200 && cp.j.entry && cp.j.entry.folder === fs.realpathSync(OTHER) && Array.isArray(cp.j.taken) && cp.j.taken.some((t) => t.name === 'busy'), JSON.stringify(cp.j).slice(0, 200));
  const rootBefore = b.reg().settings.projectsRoot;
  y = await b.post('/api/project/new', { name: 'Side quest', goal: 'Prove one parent.', kind: 'Tool or CLI', parentFolder: cp.j.entry.folder });
  const SQ = path.join(fs.realpathSync(OTHER), 'side-quest');
  check('this one: the new folder is made under the chosen parent, with git init and BRIEF.md', y.status === 200 && fs.existsSync(path.join(SQ, '.git')) && fs.existsSync(path.join(SQ, 'BRIEF.md')), JSON.stringify(y.j).slice(0, 160));
  check('this one: registered in that folder', (b.reg().projects.find((p) => p.id === 'side-quest') || {}).folder === SQ);
  check('this one: the default in Settings stays as it is', b.reg().settings.projectsRoot === rootBefore && !fs.existsSync(path.join(rootBefore, 'side-quest')));
  y = await b.post('/api/project/new', { name: 'Busy', goal: 'Taken name.', parentFolder: cp.j.entry.folder });
  check('this one: a name taken in the chosen parent is refused and points at Existing', y.status === 409 && y.j.code === 'exists' && /other-parent\/busy already exists/.test(y.j.error), y.j.error);
  y = await b.post('/api/project/new', { name: 'Busy', goal: 'Not taken in the default.' });
  check('this one: the same name in the default root is still free', y.status === 200 && fs.existsSync(path.join(rootBefore, 'busy', 'BRIEF.md')), JSON.stringify(y.j).slice(0, 120));
  for (const [label, pp, re] of [['~/Library', path.join(os.homedir(), 'Library'), /Library/], ['the home folder', os.homedir(), /home folder itself/], ["the board's data folder", b.mc, /data folder/], ['a missing folder', path.join(OTHER, 'gone'), /not there/]]) {
    y = await b.post('/api/project/new', { name: 'Guarded', goal: 'Refused.', parentFolder: pp });
    check(`this one: ${label} as the parent is refused`, y.status === 400 && re.test(y.j.error), y.j.error);
  }
  check('this one: nothing was made for the refused ones', !b.reg().projects.some((p) => p.name === 'Guarded'));

  if (!LAN) check('phone: 403 (needs a private LAN address to arrive as one)', false, 'no LAN address on this Mac');
  else {
    const req = (q) => new Promise((resolve, reject) => {
      const rq = http.request({ host: LAN, port: 4668, path: q.path, method: q.method || 'GET', headers: { Host: `${LAN}:4668`, ...(q.headers || {}) } }, (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s })); });
      rq.on('error', reject);
      rq.end(q.body || undefined);
    });
    await fetch(b.base + '/api/phone');
    const KEY = JSON.parse(fs.readFileSync(path.join(b.mc, 'phone.json'), 'utf8')).key;
    const si = await req({ path: '/?k=' + encodeURIComponent(KEY) });
    const COOKIE = [].concat(si.headers['set-cookie'] || []).find((c) => c.startsWith('mc_phone=')).split(';')[0];
    const ph = await req({ method: 'POST', path: '/api/settings/projects-root', headers: { Cookie: COOKIE, 'X-Ravenry': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: PROJ, from: 'chosen' }) });
    check('phone: saving is refused with 403 and "Change it on the Mac"', ph.status === 403 && /Change it on the Mac/.test(JSON.parse(ph.body).error), `${ph.status} ${ph.body}`);
    const pg = await req({ path: '/api/settings/projects-root', headers: { Cookie: COOKIE } });
    const pj = JSON.parse(pg.body);
    check('phone: reads the path, marked not local', pg.status === 200 && pj.local === false && /chosen-root$/.test(pj.path), pg.body.slice(0, 160));
  }

  // ---- 3. MC_PROJECTS_ROOT
  const LOCK = path.join(T, 'b2', 'locked-root');
  fs.mkdirSync(LOCK, { recursive: true });
  const b2 = await board('b2', 4669, { ...base1, settings: { ...base1.settings, projectsRoot: PROJ } }, { MC_PROJECTS_ROOT: LOCK });
  st = await b2.state();
  check('env: the row is locked on MC_PROJECTS_ROOT', st.projectsRoot.locked === true && st.projectsRoot.source === 'env' && st.projectsRoot.path === LOCK.replace(os.homedir(), '~'), JSON.stringify(st.projectsRoot));
  y = await b2.post('/api/settings/projects-root', { path: PROJ, from: 'chosen' });
  check('env: saving is refused while MC_PROJECTS_ROOT holds it', y.status === 409 && /MC_PROJECTS_ROOT/.test(y.j.error), y.j.error);
  check('env: the setting in the file is left alone', b2.reg().settings.projectsRoot === PROJ);

  // ---- 4. first run, no projects
  const b3 = await board('b3', 4670, { version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups') }, projects: [] });
  st = await b3.state();
  check('first run: the snapshot asks, with a suggestion', st.projectsRoot.ask === true && st.projectsRoot.suggestion && /^~\//.test(st.projectsRoot.suggestion.path), JSON.stringify(st.projectsRoot));
  check('first run: nothing is written while it asks', !b3.reg().settings.projectsRoot);
  const ANS = path.join(T, 'b3', 'answer');
  fs.mkdirSync(ANS, { recursive: true });
  y = await b3.post('/api/settings/projects-root', { path: ANS, from: 'first-run' });
  st = await b3.state();
  await sleep(300);
  st = await b3.state();
  check('first run: the answer is saved, marked first-run, and it stops asking', y.status === 200 && b3.reg().settings.projectsRootFrom === 'first-run' && st.projectsRoot.ask === false, JSON.stringify(st.projectsRoot));
  y = await b3.post('/api/settings/projects-root', { path: ANS, from: 'whatever' });
  check('route: an unknown "from" is refused', y.status === 400);
} catch (e) {
  console.error('ERROR', e);
  fails++;
} finally {
  for (const s of servers) s.kill();
}
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
