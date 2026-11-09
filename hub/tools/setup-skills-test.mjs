#!/usr/bin/env node
// The first launch's Start screen (server/firstlaunch.mjs) and the Ravenry
// skill (server/skills.mjs), moved from the desktop app into the hub:
//   1. in process, on crafted homes under .tmp: the folders that look like
//      projects, the assistants found and signed in, the board's folders
//      first and the one asked for first; the skill installed then removed
//      leaves the folder as it was (a skill of the person's kept, a ravenry
//      skill that was there back, folders the install made gone); a
//      client's old undo records adopted, and bad ones refused;
//   2. a test board (fake cmux, no daemon): GET /api/setup/start, GET and
//      POST /api/setup/skills, with the undo records in its data folder.
// Touches only .tmp/.
// Usage: node tools/setup-skills-test.mjs
import { withTestHome } from './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'setup-skills');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = path.join(T, 'unit-mc');
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });

const fl = await import('../server/firstlaunch.mjs');
const sk = await import('../server/skills.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tree = (d) => {
  const out = {};
  const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) { out[path.relative(d, f) + '/'] = ''; walk(f); } else out[path.relative(d, f)] = fs.readFileSync(f, 'utf8'); } };
  if (fs.existsSync(d)) walk(d);
  return out;
};
const homeDir = (n) => { const h = path.join(T, n); fs.mkdirSync(h, { recursive: true }); return h; };

// ------------------------------------------------------------ 1. in process: the Start screen
{
  const home = homeDir('h-start');
  check('no project root: no folders', fl.findProjectFolders(home).folders.length === 0 && fl.findProjectFolders(home).root === null);
  for (const [n, marker] of [['app', '.git'], ['site', 'package.json'], ['notes', null]]) {
    const d = path.join(home, 'code', n);
    fs.mkdirSync(d, { recursive: true });
    if (marker === '.git') fs.mkdirSync(path.join(d, marker));
    else if (marker) fs.writeFileSync(path.join(d, marker), '{}');
  }
  const f = fl.findProjectFolders(home);
  check('folders that look like projects, from ~/code, said with ~', f.root === path.join(home, 'code') && f.folders.map((x) => x.name).sort().join() === 'app,site' && f.folders[0].short.startsWith('~/code/'), JSON.stringify(f));
  const none = fl.findAssistants({ PATH: '' }, home);
  check('no assistant: both listed, neither found', JSON.stringify(none.map((a) => [a.kind, a.found])) === '[["claude",false],["codex",false]]');
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount": {}}');
  const a = fl.findAssistants({ PATH: '' }, home);
  check('claude in ~/.local/bin, off the PATH, found and signed in; codex not', a[0].found && a[0].signedIn && a[0].path === path.join(bin, 'claude') && !a[1].found, JSON.stringify(a));
  const known = path.join(home, 'elsewhere', 'kite');
  fs.mkdirSync(known, { recursive: true });
  const v = fl.startView({ home, env: { PATH: '' }, known: [known, path.join(home, 'code', 'app')] });
  check('startView: the board\'s folders first, then the scan\'s, none twice, the root said with ~', v.root === '~/code' && v.folders[0].path === known && v.folders[0].short === '~/elsewhere/kite' && v.folders.filter((x) => x.name === 'app').length === 1 && v.folders.length === 3 && v.assistants.length === 2, JSON.stringify(v.folders));
  const want = path.join(home, 'wanted');
  const w = fl.startView({ home, env: { PATH: '' }, want });
  check('startView: a folder asked for comes first; a relative one is ignored', w.folders[0].path === want && w.folders[0].name === 'wanted' && fl.startView({ home, env: { PATH: '' }, want: 'rel' }).folders.every((x) => x.path !== 'rel'));
}

// ------------------------------------------------------------ 1. in process: the skill
{
  const home = homeDir('h-skill1');
  const env = {};
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'rex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'rex', 'SKILL.md'), 'theirs\n');
  const before = tree(home);
  const undo = path.join(T, 'undo1', 'skills-undo.json');
  const st = sk.installSkill('claude', '/Apps/Ravenry/bin/ravenry', '0.1.21', undo, env, home);
  const text = fs.readFileSync(path.join(sk.skillDir('claude', env, home), 'SKILL.md'), 'utf8');
  check('install: ours, with its version, running the stable command', st.installed && st.ours && st.version === '0.1.21' && /^---\nname: ravenry\n/.test(text) && text.includes('Run `"/Apps/Ravenry/bin/ravenry" skill`'));
  sk.removeSkill('claude', undo, env, home);
  check('install then remove: the skills folder as it was, a skill of the person\'s kept', JSON.stringify(tree(home)) === JSON.stringify(before));
}
{
  const home = homeDir('h-skill2');
  const env = {};
  const undo = path.join(T, 'undo2', 'u.json');
  sk.installSkill('codex', '/bin/ravenry', '0.1.21', undo, env, home);
  const made = fs.existsSync(path.join(home, '.codex', 'skills', 'ravenry', 'SKILL.md'));
  sk.removeSkill('codex', undo, env, home);
  check('Codex\'s folder the install made goes with Remove', made && !fs.existsSync(path.join(home, '.codex')));
  const dir = sk.skillDir('claude', env, home);
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'mine\n');
  fs.writeFileSync(path.join(dir, 'refs', 'a.md'), 'a\n');
  const before = tree(path.join(home, '.claude'));
  const notOurs = sk.skillStatus('claude', env, home).ours === false;
  sk.installSkill('claude', '/bin/ravenry', '0.1.21', undo, env, home);
  sk.removeSkill('claude', undo, env, home);
  const back = JSON.stringify(tree(path.join(home, '.claude'))) === JSON.stringify(before);
  sk.removeSkill('claude', undo, env, home);
  check('someone\'s own ravenry skill comes back file for file, and Remove leaves it alone after', notOurs && back && JSON.stringify(tree(path.join(home, '.claude'))) === JSON.stringify(before));
}
{
  // The desktop's undo records from before the hub kept them.
  const home = homeDir('h-adopt');
  const env = {};
  const appUndo = path.join(T, 'app-data', 'skills-undo.json');
  const dir = sk.skillDir('claude', env, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'mine\n');
  const before = tree(path.join(home, '.claude'));
  sk.installSkill('claude', '/bin/ravenry', '0.1.21', appUndo, env, home);
  const records = JSON.parse(fs.readFileSync(appUndo, 'utf8'));
  const hubUndo = path.join(T, 'hub-data', 'skills-undo.json');
  const bad = { [dir]: { made: ['/etc'], before: null, after: '' }, [sk.skillDir('codex', env, home)]: { made: [], before: { '../../x': 'eA==' }, after: '' }, '/tmp/elsewhere': { made: [], before: null, after: '' } };
  check('adopt: records for another folder, made folders an install cannot make, or files outside the folder are refused', sk.adoptUndo(bad, hubUndo, env, home) === 0 && !fs.existsSync(hubUndo));
  check('adopt: the app\'s record taken', sk.adoptUndo(records, hubUndo, env, home) === 1);
  sk.removeSkill('claude', hubUndo, env, home);
  check('adopt: Remove through the hub then puts the person\'s skill back as it was', JSON.stringify(tree(path.join(home, '.claude'))) === JSON.stringify(before), JSON.stringify(tree(path.join(home, '.claude'))));
  const r = sk.setSkill({ kind: 'claude', on: true, ravenryd: 'relative/ravenryd', version: '1' }, hubUndo, env, home);
  const q = sk.setSkill({ kind: 'claude', on: true, ravenryd: '/x"; rm -rf /', version: '1' }, hubUndo, env, home);
  check('setSkill: a relative or quoted command is refused', !r.ok && !q.ok && /not installed yet/.test(r.error));
  check('setSkill: no such assistant', sk.setSkill({ kind: 'gemini', on: true }, hubUndo, env, home).ok === false);
}

// ------------------------------------------------------------ 2. a test board
const PORT = 4673;
const mc = path.join(T, 'board', 'mc');
const bhome = path.join(T, 'board', 'home');
const proj = path.join(bhome, 'Elsewhere', 'kite');
for (const d of [mc, proj, path.join(bhome, 'code', 'app', '.git'), path.join(bhome, '.local', 'bin'), path.join(T, 'board', 'app', 'bin')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bhome, '.local', 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
const ravenryd = path.join(T, 'board', 'app', 'bin', 'ravenryd');
fs.writeFileSync(ravenryd, '#!/bin/sh\n', { mode: 0o755 });
fs.writeFileSync(path.join(T, 'board', 'app', 'bin', 'ravenry'), '#!/bin/sh\n', { mode: 0o755 });
fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'kite', name: 'kite', folder: proj, workspaces: [], brief: null }] }, null, 2));
const fake = path.join(T, 'board', 'fake-cmux.json');
fs.writeFileSync(fake, JSON.stringify({ workspaces: [], screens: {} }));
const env = {
  ...process.env, RAVENRY_HOME: mc, PORT: String(PORT), RAVENRY_PHONE_PORT: String(PORT + 1000), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0',
  CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: fake, PATH: '/usr/bin:/bin',
};
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'RAVENRY_DAEMON_BIN']) delete env[k];
const benv = withTestHome(env, T);
benv.HOME = bhome;
const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: benv, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
process.on('exit', () => srv.kill('SIGTERM'));
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* not yet */ } await sleep(250); }
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, j: await r.json() }; };
const post = async (p, body, headers = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1', ...headers }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };

try {
  const s = await get('/api/setup/start');
  check('GET /api/setup/start: the board\'s folder first, then ~/code\'s, claude found off the PATH', s.status === 200 && s.j.ok && s.j.root === '~/code' && s.j.folders[0].path === proj && s.j.folders[0].short === '~/Elsewhere/kite' && s.j.folders.some((f) => f.name === 'app') && s.j.assistants[0].kind === 'claude' && s.j.assistants[0].found && !s.j.assistants[1].found, JSON.stringify(s.j) + log.slice(-400));
  const w = await get(`/api/setup/start?folder=${encodeURIComponent(path.join(bhome, 'other'))}`);
  check('GET /api/setup/start?folder=: that folder first', w.j.folders[0].path === path.join(bhome, 'other'), JSON.stringify(w.j.folders));
  const g = await get('/api/setup/skills');
  check('GET /api/setup/skills: both assistants, said with ~, none installed', g.status === 200 && g.j.skills.length === 2 && g.j.skills[0].dir === '~/.claude/skills/ravenry' && g.j.skills[0].name === 'Claude Code' && g.j.skills[0].found && !g.j.skills[0].installed && !g.j.skills[1].found, JSON.stringify(g.j));
  const i = await post('/api/setup/skills', { kind: 'claude', on: true, ravenryd, version: '0.1.23' });
  const md = path.join(bhome, '.claude', 'skills', 'ravenry', 'SKILL.md');
  const text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
  check('POST /api/setup/skills on: installed, running the ravenry link beside ravenryd, the undo record in the board\'s data', i.status === 200 && i.j.skills[0].ours && i.j.skills[0].version === '0.1.23' && text.includes(`Run \`"${path.join(T, 'board', 'app', 'bin', 'ravenry')}" skill\``) && fs.existsSync(path.join(mc, 'skills-undo.json')), JSON.stringify(i.j));
  const o = await post('/api/setup/skills', { kind: 'claude', on: false });
  check('POST /api/setup/skills off: the folders the install made go', o.status === 200 && !o.j.skills[0].installed && !fs.existsSync(path.join(bhome, '.claude')), JSON.stringify(o.j));
  const nob = await post('/api/setup/skills', { kind: 'claude', on: true, version: '0.1.23' });
  check('POST /api/setup/skills: no command, refused with the app\'s words', nob.status === 400 && /not installed yet/.test(nob.j.error), JSON.stringify(nob));
} finally {
  srv.kill('SIGTERM');
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
