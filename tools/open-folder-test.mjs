#!/usr/bin/env node
// Open the folder: the folder path in a project's header opens it in Finder
// on the Mac, through POST /api/project/open-folder. A test board on :4675
// (fake cmux, tools/stub-open.mjs for `open`): the registered folder only,
// never a path from the page; 403 for a phone and for a page that is not the
// board; 404 for an unknown project; 409 for a folder not on disk. A second
// board on :4676 with no stub refuses to run the real `open`. No Finder
// window, no real cmux. Touches only .tmp/.
//
// Usage: node tools/open-folder-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'open-folder');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ boards
const LAN = (() => {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
  out.sort((a, b) => (b.name === 'en0') - (a.name === 'en0'));
  return out[0] && out[0].address;
})();

const PROJ = path.join(T, 'projects', 'scratch');
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Scratch\n\n## Goal\nTry files in plans.\n\n## Next step\nNothing yet.\n');
const GONE = path.join(T, 'projects', 'gone');
const servers = [];
async function board(name, port, extraEnv = {}) {
  const mc = path.join(T, name, 'mc');
  fs.mkdirSync(mc, { recursive: true });
  const fake = path.join(T, name, 'fake-cmux.json');
  fs.writeFileSync(fake, JSON.stringify({ workspaces: [], screens: {} }));
  fs.writeFileSync(path.join(T, name, 'CLAUDE.md'), '# Rules\n\n## Pictures\n- Show me a picture before building anything visual.\n');
  fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, name, 'CLAUDE.md'), backupDir: path.join(T, name, 'backups'), launchCommand: 'claude' }, projects: [
    { id: 'scratch', name: 'Scratch', folder: PROJ, workspaces: [], brief: 'BRIEF.md' },
    { id: 'gone', name: 'Gone', folder: GONE, workspaces: [], brief: null },
  ] }, null, 2));
  const env = {
    ...process.env, RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
    CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: fake, MC_CLAUDE_PROJECTS: path.join(T, name, 'claude'),
    MC_PROJECTS_ROOT: path.join(T, 'projects'), MC_GLOBAL_CLAUDE_MD: path.join(T, name, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, name, 'backups'),
    STUB_OPEN_LOG: path.join(T, name, 'open.jsonl'),
    MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-open.mjs')]), ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  servers.push(srv);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* not yet */ } await sleep(250); }
  await sleep(2600); // a tick or so, so the snapshot holds the projects
  const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    mc, base, fake, log: () => log,
    opens: () => lines(env.STUB_OPEN_LOG),
    state: async () => (await fetch(base + '/api/state')).json(),
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), j: await r.json().catch(() => null) }; },
    post: async (p, body, headers = { 'X-Ravenry': '1' }) => { const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: res.status, j: await res.json() }; },
  };
}

try {
  const b = await board('b1', 4675);
  // ---- open the folder
  let r = await b.post('/api/project/open-folder', { projectId: 'scratch' });
  check('open: the Mac opens the project\'s folder', r.status === 200 && b.opens().length === 1 && JSON.stringify(b.opens()[0].args) === JSON.stringify([PROJ]), `${r.status} ${JSON.stringify(b.opens())}`);
  r = await b.post('/api/project/open-folder', { projectId: 'scratch', folder: '/etc', path: '/etc' });
  check('open: a path from the page is ignored, only the registered folder opens', r.status === 200 && JSON.stringify(b.opens()[1].args) === JSON.stringify([PROJ]));
  r = await b.post('/api/project/open-folder', { projectId: 'nope' });
  check('open: an unknown project is 404, nothing opened', r.status === 404 && b.opens().length === 2, `${r.status} ${r.j.error}`);
  r = await b.post('/api/project/open-folder', { projectId: 'gone' });
  check('open: a folder that is not on disk is 409, nothing opened', r.status === 409 && /not on disk/.test(r.j.error) && b.opens().length === 2, `${r.status} ${r.j.error}`);
  r = await b.post('/api/project/open-folder', { projectId: 'scratch' }, {});
  check('open: the write guard holds (no board header is 403)', r.status === 403 && b.opens().length === 2, `${r.status}`);
  r = await b.post('/api/project/open-folder', { projectId: 'scratch' }, { 'X-Ravenry': '1', Origin: 'http://evil.example' });
  check('open: another site\'s page is 403', r.status === 403 && b.opens().length === 2, `${r.status}`);

  // A phone, signed in through the Mac's Wi-Fi address.
  let COOKIE = null;
  const phoneReq = (q) => new Promise((resolve, reject) => {
    const rq = http.request({ host: LAN, port: 4675, path: q.path, method: q.method || 'GET', headers: { Host: `${LAN}:4675`, ...(COOKIE ? { Cookie: COOKIE } : {}), ...(q.headers || {}) } }, (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s })); });
    rq.on('error', reject);
    rq.end(q.body || undefined);
  });
  if (!LAN) check('open: a phone gets 403 (needs a private LAN address to arrive as one)', false, 'no LAN address on this Mac');
  else {
    await fetch(b.base + '/api/phone');
    const KEY = JSON.parse(fs.readFileSync(path.join(b.mc, 'phone.json'), 'utf8')).key;
    const si = await phoneReq({ path: '/?k=' + encodeURIComponent(KEY) });
    COOKIE = [].concat(si.headers['set-cookie'] || []).find((c) => c.startsWith('mc_phone=')).split(';')[0];
    const ph = await phoneReq({ method: 'POST', path: '/api/project/open-folder', headers: { 'X-Ravenry': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'scratch' }) });
    check('open: a signed-in phone gets 403, nothing opened', ph.status === 403 && /Only the Mac/.test(JSON.parse(ph.body).error) && b.opens().length === 2, `${ph.status} ${ph.body}`);
    const who = JSON.parse((await phoneReq({ path: '/api/whoami' })).body);
    check('open: the page knows it is a phone (local false), so the path stays plain text', who.local === false);
  }

  // ---- a board with no stub never runs the real `open`
  const b2 = await board('b2', 4676, { MC_OPEN_COMMAND: null });
  r = await b2.post('/api/project/open-folder', { projectId: 'scratch' });
  check('safety: a test board with no MC_OPEN_COMMAND refuses to run the real open', r.status === 503 && /does not open Finder/.test(r.j.error) && b2.opens().length === 0, `${r.status} ${r.j.error}`);
} catch (err) {
  console.error(err);
  fails++;
} finally {
  for (const s of servers) s.kill();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
