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
//      POST /api/setup/skills, with the undo records in its data folder;
//      POST /api/settings/theme-import (server/themeimport.mjs, moved from
//      the desktop's themeimport.ts): a Ghostty and an iTerm2 file made
//      into themes, a broken one refused with why, nothing written.
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
{
  const { withHooks } = await import('../server/skills.mjs');
  const rows = [{ kind: 'claude' }, { kind: 'codex' }, { kind: 'x' }];
  const w = withHooks(rows, (k) => (k === 'claude' ? { file: '~/.claude/settings.json', changes: [] } : k === 'codex' ? { file: '~/.codex/hooks.json', changes: [{}] } : (() => { throw new Error('no'); })()));
  check('withHooks: on when setting up changes nothing, off when it would, unavailable when the run fails', w[0].hooks === 'on' && w[0].hooksFile === '~/.claude/settings.json' && w[1].hooks === 'off' && w[2].hooks === 'unavailable' && w[2].hooksFile === null, JSON.stringify(w));
}
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
{
  // The description leads with when to use it (asking the person), within
  // what Claude Code (1,536) and Codex (1,024) show, as a plain YAML scalar.
  const d = sk.DESCRIPTION;
  check('description: asking the person through Ravenry comes first, with ask, pick, approve and secret, under 1,024 characters, one plain YAML line', /^Ask the person through Ravenry, not in your reply\./.test(d) && ['ravenry ask', 'ravenry pick', 'ravenry approve', 'ravenry secret'].every((c) => d.slice(0, 300).includes(c)) && d.length <= 1024 && !/: | #|\n/.test(d) && !/^[`'"&*!|>%@[{]/.test(d) && sk.skillText('/bin/ravenry', '1').includes(`\ndescription: ${d}\n`), `${d.length} characters`);
  // An update: the app's hub at start (refreshSkills) writes a stub of ours
  // with an older description again; a skill the person wrote is left alone.
  const home = homeDir('h-refresh');
  const env = {};
  const stable = path.join(T, 'refresh-bin', 'ravenry');
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, '#!/bin/sh\n', { mode: 0o755 });
  const OLD = "Use Ravenry's terminals from the command line. Open a pane beside you for a server or a build, read its screen, type into it, wait for its output, show the person pictures to pick from, ask them through the board and their phone, and make pages in Ravenry's sidebar (a tracker, a list, a board of notes) for what you work on.";
  const oldText = sk.skillText(stable, '0.1.49').replace(`description: ${d}`, `description: ${OLD}`);
  const ours = path.join(sk.skillDir('claude', env, home), 'SKILL.md');
  fs.mkdirSync(path.dirname(ours), { recursive: true });
  fs.writeFileSync(ours, oldText);
  const theirs = path.join(sk.skillDir('codex', env, home), 'SKILL.md');
  const theirText = `---\nname: ravenry\ndescription: ${OLD}\n---\nMy own notes on Ravenry.\n`;
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, theirText);
  const backups = path.join(T, 'refresh-backups');
  const r1 = sk.refreshSkills({ stable, version: '0.1.50', undoFile: path.join(T, 'refresh-undo.json'), backups, env, home });
  const now = fs.readFileSync(ours, 'utf8');
  check('update: a stub of ours with an older description gets the new one (same command, this version), the old kept in backups', r1.length === 1 && r1[0].kind === 'claude' && now === sk.skillText(stable, '0.1.50') && now.includes(`description: ${d}`) && fs.readFileSync(r1[0].backup, 'utf8') === oldText, JSON.stringify(r1));
  check('update: a ravenry skill the person wrote (no ravenry-stub mark) is left byte for byte', fs.readFileSync(theirs, 'utf8') === theirText);
  const r2 = sk.refreshSkills({ stable, version: '0.1.50', undoFile: path.join(T, 'refresh-undo.json'), backups, env, home });
  check('update: a stub already current is not written again', r2.length === 0 && fs.readdirSync(backups).length === 1);
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
  check('GET /api/setup/start: no folder busy with no session working (sidebar.busyIn, sidebar-test.mjs)', s.j.folders.every((f) => !('busy' in f)), JSON.stringify(s.j.folders));
  const g = await get('/api/setup/skills');
  check('GET /api/setup/skills: both assistants, said with ~, none installed', g.status === 200 && g.j.skills.length === 2 && g.j.skills[0].dir === '~/.claude/skills/ravenry' && g.j.skills[0].name === 'Claude Code' && g.j.skills[0].found && !g.j.skills[0].installed && !g.j.skills[1].found, JSON.stringify(g.j));
  const gh = await get(`/api/setup/skills?ravenryd=${encodeURIComponent(ravenryd)}`);
  check('GET /api/setup/skills?ravenryd=: each row says its hooks (off before set up, unavailable with no file to write), as Settings, Skills shows them', gh.status === 200 && gh.j.skills.length === 2 && ['on', 'off', 'unavailable'].includes(gh.j.skills[0].hooks) && gh.j.skills.every((r) => (r.hooks === 'unavailable') === (r.hooksFile === null)), JSON.stringify(gh.j.skills.map((r) => [r.kind, r.hooks, r.hooksFile])));
  const i = await post('/api/setup/skills', { kind: 'claude', on: true, ravenryd, version: '0.1.23' });
  const md = path.join(bhome, '.claude', 'skills', 'ravenry', 'SKILL.md');
  const text = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
  check('POST /api/setup/skills on: installed, running the ravenry link beside ravenryd, the undo record in the board\'s data', i.status === 200 && i.j.skills[0].ours && i.j.skills[0].version === '0.1.23' && text.includes(`Run \`"${path.join(T, 'board', 'app', 'bin', 'ravenry')}" skill\``) && fs.existsSync(path.join(mc, 'skills-undo.json')), JSON.stringify(i.j));
  const o = await post('/api/setup/skills', { kind: 'claude', on: false });
  check('POST /api/setup/skills off: the folders the install made go', o.status === 200 && !o.j.skills[0].installed && !fs.existsSync(path.join(bhome, '.claude')), JSON.stringify(o.j));
  const nob = await post('/api/setup/skills', { kind: 'claude', on: true, version: '0.1.23' });
  check('POST /api/setup/skills: no command, refused with the app\'s words', nob.status === 400 && /not installed yet/.test(nob.j.error), JSON.stringify(nob));
  const pal = Array.from({ length: 16 }, (_, n) => `palette = ${n}=#${(0x101010 * (n % 15) + 0x0f0f0f).toString(16).padStart(6, '0')}`).join('\n');
  const ghostty = `# Harbour Night\nbackground = #1a1b26\nforeground = #c0caf5\ncursor-color = #c0caf5\n${pal}\n`;
  const before = JSON.stringify(tree(mc));
  const tg = await post('/api/settings/theme-import', { text: ghostty, fileName: 'Harbour_Night.conf' });
  check('POST /api/settings/theme-import: a Ghostty file made a dark theme with its 16 colours, named from the file, its slug', tg.status === 200 && tg.j.theme.name === 'Harbour Night' && tg.j.theme.appearance === 'dark' && tg.j.theme.theme.background === '#1A1B26' && tg.j.theme.theme.brightWhite && tg.j.slug === 'harbour-night', JSON.stringify(tg.j).slice(0, 300));
  const comp = (r, g, b) => `<dict><key>Red Component</key><real>${r}</real><key>Green Component</key><real>${g}</real><key>Blue Component</key><real>${b}</real><key>Color Space</key><string>sRGB</string></dict>`;
  const iterm = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Array.from({ length: 16 }, (_, n) => `<key>Ansi ${n} Color</key>${comp(n / 15, 0.5, 1 - n / 15)}`).join('')}<key>Background Color</key>${comp(0.98, 0.97, 0.94)}<key>Foreground Color</key>${comp(0.2, 0.2, 0.2)}</dict></plist>`;
  const ti = await post('/api/settings/theme-import', { text: iterm, fileName: '/Users/x/Downloads/Linen Day.itermcolors' });
  check('POST /api/settings/theme-import: an .itermcolors file made a light theme', ti.status === 200 && ti.j.theme.name === 'Linen Day' && ti.j.theme.appearance === 'light' && ti.j.slug === 'linen-day', JSON.stringify(ti.j).slice(0, 300));
  const tb = await post('/api/settings/theme-import', { text: 'background = #000000\nforeground = #ffffff\n', fileName: 'half.conf' });
  check('POST /api/settings/theme-import: a theme without its palette refused, saying which colour', tb.status === 400 && /no palette = 0/.test(tb.j.error), JSON.stringify(tb.j));
  const tn = await post('/api/settings/theme-import', { fileName: 'x.conf' });
  check('POST /api/settings/theme-import: no text refused', tn.status === 400, JSON.stringify(tn.j));
  check('POST /api/settings/theme-import writes nothing in the board\'s data', JSON.stringify(tree(mc)) === before);
} finally {
  srv.kill('SIGTERM');
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
