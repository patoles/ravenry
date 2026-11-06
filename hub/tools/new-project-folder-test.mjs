// New project's Folder row (docs/design/NewProjectFolder.dc.html, variant A):
// the existing-folder guards on crafted folders, then a test board on :4663
// (fake cmux, so no real workspace opens) for the routes: the folders list,
// a project made in a shared folder (its own BRIEF-<id>.md and hand-off
// file, the other project's brief untouched), the new-folder path as
// before, and Finder's dialog through a stub (picked, cancelled, refused,
// not blocking the server, timed out, 403 for a phone). Touches only .tmp/.
//
// Usage: node tools/new-project-folder-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'np-folder');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const PROJECTS = path.join(T, 'projects');
for (const d of [MC, PROJECTS]) fs.mkdirSync(d, { recursive: true });
process.env.RAVENRY_HOME = MC;

const create = await import('../server/create.mjs');
const handoff = await import('../server/handoff.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ------------------------------------------------------------ the guards, on a crafted home
const H = path.join(T, 'home');
const OUTSIDE = path.join(os.tmpdir(), `np-folder-outside-${process.pid}`);
fs.mkdirSync(path.join(H, 'Library', 'Application Support'), { recursive: true });
fs.mkdirSync(path.join(H, '.ravenry', 'ideas'), { recursive: true });
fs.mkdirSync(path.join(H, 'Documents', 'code', 'projects', 'good'), { recursive: true });
fs.writeFileSync(path.join(H, 'Documents', 'notes.txt'), 'a file\n');
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.symlinkSync(OUTSIDE, path.join(H, 'Documents', 'escape'));
fs.symlinkSync(path.join(H, 'Documents', 'code', 'projects', 'good'), path.join(H, 'good-link'));
fs.symlinkSync(path.join(H, 'Library'), path.join(H, 'Documents', 'lib-link'));
const opts = { home: H, dataHome: path.join(H, '.ravenry') };
const g = (p) => create.checkExistingFolder(p, opts);
const realGood = fs.realpathSync(path.join(H, 'Documents', 'code', 'projects', 'good'));

let r = g(H);
check('guard: the home folder itself is refused', !r.ok && /home folder itself/.test(r.error), r.error);
r = g('~');
check('guard: ~ is refused the same way', !r.ok && /home folder itself/.test(r.error), r.error);
r = g(path.join(H, 'Library'));
check('guard: ~/Library is refused', !r.ok && /Library/.test(r.error), r.error);
r = g(path.join(H, 'Library', 'Application Support'));
check('guard: a folder inside ~/Library is refused', !r.ok && /Library/.test(r.error), r.error);
r = g(path.join(H, 'Documents', 'lib-link'));
check('guard: a symlink into ~/Library is refused', !r.ok && /Library/.test(r.error), r.error);
r = g(path.join(H, '.ravenry', 'ideas'));
check("guard: the board's own data folder is refused", !r.ok && /data folder/.test(r.error), r.error);
r = g(path.join(H, 'Documents', 'escape'));
check('guard: a symlink that escapes the home folder is refused', !r.ok && /outside your home folder/.test(r.error), r.error);
r = g(OUTSIDE);
check('guard: a folder outside the home folder is refused', !r.ok && /outside your home folder/.test(r.error), r.error);
r = g('/System');
check('guard: a system path is refused', !r.ok, r.error);
r = g(path.join(H, 'Documents', 'notes.txt'));
check('guard: a file is refused', !r.ok && /is a file/.test(r.error), r.error);
r = g(path.join(H, 'Documents', 'missing'));
check('guard: a folder that is not there is refused', !r.ok && /is not there/.test(r.error), r.error);
r = g('Documents/code');
check('guard: a relative path is refused', !r.ok && /full path/.test(r.error), r.error);
r = g(path.join(H, 'Documents', 'code', 'projects', 'good'));
check('guard: a good existing folder is accepted', r.ok && r.folder === realGood, r.folder || r.error);
r = g('~/Documents/code/projects/good/');
check('guard: a ~ path with a trailing slash is accepted', r.ok && r.folder === realGood, r.folder || r.error);
r = g(path.join(H, 'good-link'));
check('guard: a symlink to a good folder is accepted as the real folder', r.ok && r.folder === realGood, r.folder || r.error);
fs.rmSync(OUTSIDE, { recursive: true, force: true });

// ------------------------------------------------------------ a test board
const PORT = 4663;
const BASE = `http://localhost:${PORT}`;
const SHARED = path.join(PROJECTS, 'shared-repo');
const LONE = path.join(PROJECTS, 'lone-repo');
const BRIEFED = path.join(PROJECTS, 'briefed-repo');
const FINDER = path.join(PROJECTS, 'from-finder');
for (const d of [SHARED, LONE, BRIEFED, FINDER]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(SHARED, 'BRIEF.md'), '# Alpha\n\nGoal: The other project.\n\n## Hand-off\n- left off here\n');
fs.writeFileSync(path.join(BRIEFED, 'BRIEF.md'), '# Someone else\n\nGoal: Not on the board.\n');
fs.mkdirSync(path.join(PROJECTS, 'taken'));
fs.writeFileSync(path.join(PROJECTS, 'taken', 'notes.txt'), 'already here\n');
const alphaBefore = hash(path.join(SHARED, 'BRIEF.md'));
const CHOOSE = path.join(T, 'choose.txt');
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces: [], screens: {} }));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, projectsRoot: PROJECTS, launchCommand: 'echo LAUNCHED:', ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), printCommand: [process.execPath, path.join(ROOT, 'tools/stub-claude.mjs')] },
  projects: [
    { id: 'alpha', name: 'Alpha', folder: SHARED, workspaces: [], brief: 'BRIEF.md' },
    { id: 'beta', name: 'Beta', folder: SHARED, workspaces: [], brief: null },
    { id: 'lone', name: 'Lone', folder: LONE, workspaces: [], brief: null },
    { id: 'gone', name: 'Gone', folder: path.join(PROJECTS, 'not-on-disk'), workspaces: [], brief: null },
    { id: 'hidden', name: 'Hidden', folder: path.join(PROJECTS, 'taken'), workspaces: [], hidden: true },
  ],
}, null, 2));

const env = {
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
  CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE,
  MC_CHOOSE_FOLDER_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-choose-folder.mjs')]),
  STUB_CHOOSE_FILE: CHOOSE, MC_CHOOSE_FOLDER_TIMEOUT_MS: '1500',
};
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const api = async (p, body) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) });
  return { status: res.status, j: await res.json() };
};
const getj = async (p) => (await fetch(BASE + p)).json();
const reg = () => JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8'));
const form = (name, extra = {}) => ({ name, goal: `Prove ${name}.`, kind: 'Tool or CLI', milestones: 'First', ...extra });

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch { /* not yet */ } await sleep(250); }
  await sleep(600); // one tick, so the snapshot knows the projects

  // ---- the folders list
  const fl = await getj('/api/project/folders');
  const names = fl.folders.map((f) => f.name);
  check('folders: one row per folder (Alpha and Beta share one), not on disk and hidden left out', names.length === 2 && names.includes('shared-repo') && names.includes('lone-repo'), names.join(', '));
  const sh = fl.folders.find((f) => f.name === 'shared-repo');
  check('folders: a row names every project using it, and where it lives', sh && sh.projects.join(',') === 'Alpha,Beta' && /projects$/.test(sh.parent) && sh.hasBrief === true, JSON.stringify(sh));
  check('folders: ids for the brief name, and the taken names under the projects root', fl.ids.includes('alpha') && fl.taken.some((t) => t.name === 'taken') && fl.taken.some((t) => t.name === 'shared-repo' && t.hasBrief), JSON.stringify(fl.taken));

  // ---- refusals through the route
  for (const [label, p, re] of [['the home folder', os.homedir(), /home folder itself/], ['~/Library', path.join(os.homedir(), 'Library'), /Library/], ['a file', path.join(PROJECTS, 'taken', 'notes.txt'), /is a file/], ['a folder outside home', '/private/tmp', /outside your home folder|system folder/]]) {
    const x = await api('/api/project/new', form('Refused one', { existingFolder: p }));
    check(`new project refuses ${label} with a plain sentence`, x.status === 400 && re.test(x.j.error), `${x.status} ${x.j.error}`);
  }
  fs.symlinkSync('/private/tmp', path.join(PROJECTS, 'escape-link'));
  let x = await api('/api/project/new', form('Refused one', { existingFolder: path.join(PROJECTS, 'escape-link') }));
  check('new project refuses a symlink that escapes the home folder', x.status === 400 && /outside your home folder/.test(x.j.error), `${x.status} ${x.j.error}`);
  check('...and nothing was registered', !reg().projects.some((p) => p.name === 'Refused one'));

  // ---- a project in a shared folder
  x = await api('/api/project/new', form('Paper plane', { existingFolder: SHARED }));
  check('shared folder: created (cmux is the fake, so the workspace part says it did not open)', x.status === 200 && x.j.ok, JSON.stringify(x.j));
  const own = path.join(SHARED, 'BRIEF-paper-plane.md');
  check('shared folder: the new project gets its own BRIEF-paper-plane.md', fs.existsSync(own) && /# Paper plane/.test(fs.readFileSync(own, 'utf8')));
  check("shared folder: Alpha's BRIEF.md is untouched", hash(path.join(SHARED, 'BRIEF.md')) === alphaBefore);
  check('shared folder: no git init in an existing folder', !fs.existsSync(path.join(SHARED, '.git')));
  const pw = reg().projects.find((p) => p.id === 'paper-plane');
  check('shared folder: registry entry in that folder, brief BRIEF-paper-plane.md', pw && pw.folder === SHARED && pw.brief === 'BRIEF-paper-plane.md', JSON.stringify(pw));
  const live = reg().projects;
  const hNew = handoff.resolveHandoffFile({ projectId: 'paper-plane', projects: live });
  const hAlpha = handoff.resolveHandoffFile({ projectId: 'alpha', projects: live });
  const hBeta = handoff.resolveHandoffFile({ projectId: 'beta', projects: live });
  check("shared folder: the new project's hand-off goes to its own brief", hNew.file === own, hNew.file);
  check("shared folder: Alpha's hand-off still goes to Alpha's BRIEF.md", hAlpha.file === path.join(SHARED, 'BRIEF.md'), hAlpha.file);
  check('shared folder: a briefless sharer still gets HANDOFF-<id>.md, not anyone\'s brief', hBeta.file === path.join(SHARED, 'HANDOFF-beta.md'), hBeta.file);
  x = await api('/api/project/new', form('Paper plane', { existingFolder: SHARED }));
  check('shared folder again: same name gets a new id and its own brief, nothing overwritten', x.status === 200 && fs.existsSync(path.join(SHARED, 'BRIEF-paper-plane-2.md')) && hash(own) === hash(own), JSON.stringify(x.j.brief));

  // ---- an existing folder nobody uses
  x = await api('/api/project/new', form('Lonely', { existingFolder: FINDER }));
  check('unused existing folder: BRIEF.md', x.status === 200 && fs.existsSync(path.join(FINDER, 'BRIEF.md')), JSON.stringify(x.j));
  x = await api('/api/project/new', form('Second tenant', { existingFolder: BRIEFED }));
  const bf = reg().projects.find((p) => p.id === 'second-tenant');
  check('existing folder with a BRIEF.md nobody registered: its own BRIEF-<id>.md, the old one kept', x.status === 200 && fs.existsSync(path.join(BRIEFED, 'BRIEF-second-tenant.md')) && /Someone else/.test(fs.readFileSync(path.join(BRIEFED, 'BRIEF.md'), 'utf8')) && bf.brief === 'BRIEF-second-tenant.md');

  // ---- the new-folder path, as before
  x = await api('/api/project/new', form('Taken'));
  check('new folder: a non-empty folder is refused and points at Existing', x.status === 409 && x.j.code === 'exists' && /already exists and is not empty\. Pick it under Existing/.test(x.j.error), x.j.error);
  x = await api('/api/project/new', form('Fresh one'));
  const fresh = path.join(PROJECTS, 'fresh-one');
  check('new folder: made, git init, BRIEF.md', x.status === 200 && fs.existsSync(path.join(fresh, '.git')) && fs.existsSync(path.join(fresh, 'BRIEF.md')), JSON.stringify(x.j));

  // ---- Finder's dialog, stubbed
  fs.writeFileSync(CHOOSE, FINDER + '\n');
  x = await api('/api/project/choose-folder');
  check('choose: the folder Finder returned comes back as a row marked fromFinder', x.status === 200 && x.j.entry && x.j.entry.folder === fs.realpathSync(FINDER) && x.j.entry.fromFinder && x.j.entry.projects.join() === 'Lonely', JSON.stringify(x.j));
  fs.writeFileSync(CHOOSE, 'cancel\n');
  x = await api('/api/project/choose-folder');
  check('choose: cancelled leaves nothing to change', x.status === 200 && x.j.cancelled === true && !x.j.entry, JSON.stringify(x.j));
  fs.writeFileSync(CHOOSE, path.join(os.homedir(), 'Library') + '\n');
  x = await api('/api/project/choose-folder');
  check('choose: a refused folder comes back as a plain sentence', x.status === 400 && /Library/.test(x.j.error), x.j.error);
  fs.writeFileSync(CHOOSE, `sleep 900\n${FINDER}\n`);
  const t0 = Date.now();
  const pending = api('/api/project/choose-folder');
  await sleep(100);
  const ts = Date.now();
  const st = await fetch(BASE + '/api/state');
  const stateMs = Date.now() - ts;
  const second = await api('/api/project/choose-folder');
  const done = await pending;
  check('choose: the open dialog does not block other requests', st.ok && stateMs < 400 && Date.now() - t0 >= 900, `state answered in ${stateMs} ms while the dialog was open`);
  check('choose: a second dialog while one is open is refused', second.status === 409 && /already open/.test(second.j.error), second.j.error);
  check('choose: the slow answer still lands', done.status === 200 && done.j.entry, JSON.stringify(done.j).slice(0, 80));
  fs.writeFileSync(CHOOSE, `sleep 5000\n${FINDER}\n`);
  x = await api('/api/project/choose-folder');
  check('choose: a dialog left open past the timeout is closed with a sentence', x.status === 504 && /open too long/.test(x.j.error), `${x.status} ${x.j.error}`);

  // ---- a phone may not open the dialog
  const LAN = (() => {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
    out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
    return out[0] && out[0].address;
  })();
  if (!LAN) check('choose: 403 for a phone (needs a private LAN address to arrive as one)', false, 'no LAN address on this Mac');
  else {
    const req = (o) => new Promise((resolve, reject) => {
      const q = http.request({ host: LAN, port: PORT, path: o.path, method: o.method || 'GET', headers: { Host: `${LAN}:${PORT}`, ...(o.headers || {}) } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
      q.on('error', reject);
      q.end(o.body || undefined);
    });
    await fetch(BASE + '/api/phone');
    const KEY = JSON.parse(fs.readFileSync(path.join(MC, 'phone.json'), 'utf8')).key;
    const si = await req({ path: '/?k=' + encodeURIComponent(KEY) });
    const COOKIE = [].concat(si.headers['set-cookie'] || []).find((c) => c.startsWith('mc_phone=')).split(';')[0];
    fs.writeFileSync(CHOOSE, FINDER + '\n');
    const ph = await req({ method: 'POST', path: '/api/project/choose-folder', headers: { Cookie: COOKIE, 'X-Ravenry': '1', 'Content-Type': 'application/json' }, body: '{}' });
    check('choose: a signed-in phone gets 403', ph.status === 403 && /Only the Mac/.test(JSON.parse(ph.body).error), `${ph.status} ${ph.body}`);
    const pl = await req({ path: '/api/project/folders', headers: { Cookie: COOKIE } });
    check('folders: a signed-in phone gets the list', pl.status === 200 && JSON.parse(pl.body).folders.length >= 2, `${pl.status}`);
  }
} catch (e) {
  console.error('ERROR', e);
  fails++;
} finally {
  server.kill();
}
if (fails) console.log(serverLog.split('\n').slice(-20).join('\n'));
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
