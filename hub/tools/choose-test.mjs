// Choosing a menu option from the board (server/choose.mjs): arrow keys to
// the option, Enter, each step read back from the screen, never the digit.
//
// 1. readMenu and keysFor on real captured screens (tools/fixtures/menus/,
//    Claude Code 2.1.317 in cmux 0.64.20): the folder-trust prompt (whose
//    unnumbered options ignore digits), a Bash permission prompt with a
//    wrapped option, and an AskUserQuestion question whose last option sits
//    under a rule. The fake cmux's arrow keys turn each screen into the one
//    the real terminal showed after the same keys.
// 2. chooseOption with an in-memory menu: a lost arrow key is nudged again, a
//    menu that never moves gets no Enter, a menu still open after Enter is a
//    failure, a menu that changes on its own stops it, a refused key.
// 3. A test board on :4666 (RAVENRY_HOME under .tmp/choose-test, the fake
//    cmux playing the three menus): POST /api/send with a choice moves and
//    takes the option with arrows and Enter, no digit typed, and says
//    plainly when it was not taken.
// 4. With --real <scratch folder>: a throwaway cmux workspace mc-test-choose-*
//    running a real `claude` in that new folder, whose first screen is the
//    folder-trust prompt, answered "Yes, I trust this folder" through a test
//    board on :4667's choice route; the screen read afterwards shows Claude's
//    prompt. The workspace is closed at the end. Only that workspace is ever
//    written to.
//
// Usage: node tools/choose-test.mjs [--real <scratch folder>]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'choose-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const FIX = path.join(ROOT, 'tools', 'fixtures', 'menus');
const fx = (n) => fs.readFileSync(path.join(FIX, n + '.txt'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

const { readMenu, keysFor, chooseOption } = await import('../server/choose.mjs');
const { parseScreen } = await import('../server/screen.mjs');

// ------------------------------------------------------------ 1. real screens

const labels = (m) => m.options.map((o) => `${o.n}:${o.label}`).join(' | ');
const trust = readMenu(fx('trust'));
check('folder trust: two unnumbered options, "No, exit" selected', trust && trust.options.length === 2 && trust.options[0].label === 'No, exit' && trust.options[1].label === 'Yes, I trust this folder' && trust.at === 0, trust && labels(trust));
check('folder trust: "Yes, I trust this folder" is one Down then Enter', JSON.stringify(keysFor(trust, 2)) === '["down","enter"]');
const perm = readMenu(fx('permission'));
check('permission: four options, the first selected, the question read', perm && perm.options.length === 4 && perm.at === 0 && perm.question === 'Do you want to proceed?' && perm.options[3].label === 'No', perm && labels(perm));
check('permission: "No" is three Downs then Enter', JSON.stringify(keysFor(perm, 4)) === '["down","down","down","enter"]');
const perm4 = readMenu(fx('permission-at-4'));
check('permission moved to No: the same menu, "No" selected', perm4 && perm4.sig === perm.sig && perm4.at === 3);
check('permission from No back to Yes: three Ups then Enter', JSON.stringify(keysFor(perm4, 1)) === '["up","up","up","enter"]');
const ask = readMenu(fx('ask'));
check('AskUserQuestion: five options (the last under a rule), the first selected', ask && ask.options.length === 5 && ask.at === 0 && ask.question === 'Which board size?' && ask.options[4].label === 'Chat about this', ask && labels(ask));
const ask2 = readMenu(fx('ask-at-2'));
check('AskUserQuestion moved to 80 cm: the same menu, option 2 selected', ask2 && ask2.sig === ask.sig && ask2.at === 1);
check('an option that is not there gives no keys', keysFor(ask, 9) === null);
check('a screen with no menu reads as no menu', readMenu(`\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  ⏵⏵ auto mode on\n`) === null);
const old = readMenu(`⏺ Earlier I listed:\n❯ 1. First idea\n  2. Second idea\n\n${fx('ask').split('\n').slice(-12).join('\n')}`);
check('an older numbered list above the menu is not part of it', old && old.options.length === 5 && old.options[0].label === '60 cm' && old.at === 0, old && labels(old));

// The fake cmux against the real terminal: the same keys, the same screen.
const FAKE1 = path.join(T, 'fake-unit.json');
const fake = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'fake-cmux.mjs'), ...args], { env: { ...process.env, FAKE_CMUX_STATE: FAKE1 }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const strip = (t) => t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
fs.writeFileSync(FAKE1, JSON.stringify({ workspaces: [], screens: { p: fx('permission'), a: fx('ask'), t: fx('trust') }, menus: { p: {}, a: {}, t: {} } }));
for (let k = 0; k < 3; k++) fake('send-key', '--workspace', 'w', '--surface', 'p', '--', 'down');
fake('send-key', '--workspace', 'w', '--surface', 'a', '--', 'down');
fake('send', '--workspace', 'w', '--surface', 't', '--', '2');
let fs1 = JSON.parse(fs.readFileSync(FAKE1, 'utf8'));
check('fake cmux: three Downs on the permission prompt give the screen the real one showed', strip(fs1.screens.p) === strip(fx('permission-at-4')));
check('fake cmux: one Down on the question gives the screen the real one showed', strip(fs1.screens.a) === strip(fx('ask-at-2')));
check('fake cmux: a typed "2" leaves the trust prompt as it was, as the real one did', fs1.screens.t === fx('trust') && fs1.keys.t[0] === 'text:2');
let refused = false;
try { fake('send-key', '--workspace', 'w', '--surface', 'not-a-menu', '--', 'enter'); } catch { refused = true; }
check('fake cmux: a surface that is not a menu still refuses every write', refused);

// ------------------------------------------------------------ 2. chooseOption, in memory

function memMenu(text, { lag = 0, frozen = false, stuck = false, after = '', changeAfter = -1, refuse = null } = {}) {
  const st = { text, keys: [] };
  let n = 0;
  return {
    st,
    read: async () => st.text,
    key: async (k) => {
      st.keys.push(k);
      if (refuse === k) return { ok: false, err: 'cmux: no such surface' };
      n++;
      if (n === changeAfter) { st.text = fx('permission'); return { ok: true }; }
      if (k === 'up' || k === 'down') {
        if (frozen) return { ok: true };
        if (lag > 0) { lag--; return { ok: true }; }
        const lines = st.text.split('\n');
        const idx = lines.map((l, i) => (/^\s*(?:❯ | {2})(?:\d+\.\s+\S|Yes\b|No\b)/.test(l) ? i : -1)).filter((i) => i >= 0 && i > lines.length - 25);
        const cur = idx.findIndex((i) => /^\s*❯ /.test(lines[i]));
        const nx = Math.max(0, Math.min(idx.length - 1, cur + (k === 'down' ? 1 : -1)));
        if (nx !== cur) {
          const a = idx[cur], b = idx[nx], col = lines[a].indexOf('❯');
          lines[a] = lines[a].slice(0, col) + '  ' + lines[a].slice(col + 2);
          lines[b] = lines[b].slice(0, col) + '❯ ' + lines[b].slice(col + 2);
          st.text = lines.join('\n');
        }
      } else if (k === 'enter' && !stuck) st.text = after;
      return { ok: true };
    },
  };
}
const quick = { settleMs: 400, afterMs: 600, pollMs: 30 };
const atRest = `\n⏺ 80 cm\n\n✻ Crunched for 5s · done 5:25 PM\n\n${'─'.repeat(99)}\n❯ \n${'─'.repeat(99)}\n  ⏸ manual mode on · ? for shortcuts\n`;
let m = memMenu(fx('ask'), { after: atRest });
let r = await chooseOption({ ...m, want: 2, ...quick });
check('choose: 80 cm by Down and Enter, the menu closed', r.ok && r.sent === '80 cm' && r.after === 'closed' && m.st.keys.join(' ') === 'down enter', JSON.stringify(r));
m = memMenu(fx('ask'), { lag: 1, after: atRest });
r = await chooseOption({ ...m, want: 3, ...quick });
check('choose: a lost arrow key is pressed again before Enter', r.ok && r.sent === '100 cm' && m.st.keys.join(' ') === 'down down down enter', m.st.keys.join(' '));
m = memMenu(fx('trust'), { frozen: true, after: atRest });
r = await chooseOption({ ...m, want: 2, ...quick });
check('choose: a menu that never moves gets no Enter, and says so', !r.ok && !m.st.keys.includes('enter') && /did not move to "Yes, I trust this folder" \(it shows "No, exit"\), so Enter was not pressed/.test(r.error), r.error);
m = memMenu(fx('permission'), { stuck: true });
r = await chooseOption({ ...m, want: 1, ...quick });
check('choose: a menu still open after Enter is a failure, not "sent"', !r.ok && m.st.keys.join(' ') === 'enter' && /Pressed Enter on "Yes" but the menu is still open/.test(r.error), r.error);
m = memMenu(fx('ask'), { changeAfter: 1 });
r = await chooseOption({ ...m, want: 3, ...quick });
check('choose: a menu replaced while moving stops before Enter', !r.ok && !m.st.keys.includes('enter') && /The menu changed while moving to "100 cm"/.test(r.error), r.error);
m = memMenu(fx('permission'), { after: fx('ask') });
r = await chooseOption({ ...m, want: 1, ...quick });
check('choose: a different menu after Enter counts as moved on', r.ok && r.after === 'next');
m = memMenu(fx('ask'), { refuse: 'down' });
r = await chooseOption({ ...m, want: 2, ...quick });
check('choose: a key cmux refuses is a plain failure', !r.ok && r.status === 500 && /no such surface/.test(r.error), r.error);
m = memMenu(fx('permission'), { stuck: true });
let reads = 0;
r = await chooseOption({ ...m, read: async () => (++reads > 1 ? null : m.st.text), want: 1, ...quick });
check('choose: failed reads after Enter are not taken as the menu closing', !r.ok && /still open/.test(r.error), r.error);
m = memMenu(fx('ask'));
r = await chooseOption({ ...m, want: 7, ...quick });
check('choose: an option no longer on screen presses nothing', !r.ok && m.st.keys.length === 0 && r.error === 'That option is no longer on screen.');
m = memMenu(fx('ask').replace('❯ 1. 60 cm', '  1. 60 cm'));
r = await chooseOption({ ...m, want: 2, ...quick });
check('choose: no ❯ seen, nothing pressed', !r.ok && m.st.keys.length === 0 && /Could not see which option is selected/.test(r.error), r.error);

// ------------------------------------------------------------ 3. the test board

const H = { 'Content-Type': 'application/json', 'X-Ravenry': '1' };
async function startBoard({ port, mc, env: extra }) {
  const env = {
    ...process.env, RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0',
    MC_CLAUDE_PROJECTS: path.join(T, 'claude-projects'), MC_PROJECTS_ROOT: path.join(T, 'root'),
    MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups'), ...extra,
  };
  fs.mkdirSync(env.MC_CLAUDE_PROJECTS, { recursive: true });
  const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { board, log: '' };
  board.stdout.on('data', (d) => { out.log += d; });
  board.stderr.on('data', (d) => { out.log += d; });
  const base = `http://127.0.0.1:${port}`;
  out.base = base;
  out.post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    let j = null;
    try { j = await res.json(); } catch { /* none */ }
    return { status: res.status, j };
  };
  out.state = async () => (await fetch(base + '/api/state')).json();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const s = await out.state(); if (s && s.projects && s.projects.length) return out; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error('test board did not come up:\n' + out.log);
}
function registry(mc, projects) {
  fs.mkdirSync(mc, { recursive: true });
  fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify({
    version: 1,
    settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root'), repeatsAuto: false },
    projects,
  }, null, 2));
}

const FAKE = path.join(T, 'fake-board.json');
const MC = path.join(T, 'mc');
const IDS = ['trust', 'perm', 'ask', 'stuck', 'frozen'];
const folder = (id) => { const d = path.join(T, 'projs', id); fs.mkdirSync(d, { recursive: true }); return d; };
registry(MC, IDS.map((id) => ({ id, name: 'Menu ' + id, folder: folder(id), workspaces: ['ws-' + id], brief: null })));
const welcome = `\n ▐▛███▛█   Claude Code v2.1.317\n\n${'─'.repeat(99)}\n❯ Try "how does <filepath> work?"\n${'─'.repeat(99)}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
const permAfter = `\n⏺ Bash(mkdir -p zz-made && echo made)\n  ⎿  made\n\n✶ Moseying… (12s · ↓ 92 tokens)\n\n${'─'.repeat(99)}\n❯ \n${'─'.repeat(99)}\n  ⏸ manual mode on · esc to interrupt\n`;
const askAfter = `\n⏺ User answered Claude's questions:\n  ⎿  · Which board size? → 80 cm\n\n⏺ 80 cm\n\n✻ Crunched for 5s · done 5:25 PM\n\n${'─'.repeat(99)}\n❯ \n${'─'.repeat(99)}\n  ⏸ manual mode on · ? for shortcuts\n`;
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: IDS.map((id, k) => ({ id: 'ws-' + id, ref: 'workspace:' + (k + 1), title: 'Menu ' + id, cwd: folder(id), surfaces: [{ id: 'sf-' + id, ref: 'surface:' + (k + 1), title: '✳ Menu ' + id }] })),
  screens: { 'sf-trust': fx('trust'), 'sf-perm': fx('permission'), 'sf-ask': fx('ask'), 'sf-stuck': fx('permission'), 'sf-frozen': fx('trust') },
  menus: { 'sf-trust': { after: welcome }, 'sf-perm': { after: permAfter }, 'sf-ask': { after: askAfter }, 'sf-stuck': { stuck: true }, 'sf-frozen': { frozen: true } },
}));
const fb = await startBoard({ port: 4666, mc: MC, env: { CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE } });
const fst = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));
try {
  let s = await fb.state();
  const quickOf = (id) => { const p = s.projects.find((x) => x.id === id); return p ? (p.quick || []).map((q) => `${q.choice}:${q.label}`).join(' | ') : ''; };
  check('board: the trust prompt\'s choices are offered as buttons', /2:Yes, I trust this folder/.test(quickOf('trust')), quickOf('trust'));

  let res = await fb.post('/api/send', { projectId: 'trust', surfaceId: 'sf-trust', choice: 2 });
  let st = fst();
  check('board, folder trust: "Yes, I trust this folder" taken with Down and Enter', res.status === 200 && res.j.sent === 'Yes, I trust this folder' && res.j.after === 'closed' && st.keys['sf-trust'].join(' ') === 'down enter', `${res.status} ${JSON.stringify(res.j)} keys ${st.keys['sf-trust']}`);
  check('board, folder trust: the screen moved on to Claude\'s prompt', !parseScreen(st.screens['sf-trust']).dialog && parseScreen(st.screens['sf-trust']).claudeLive);

  res = await fb.post('/api/send', { projectId: 'perm', surfaceId: 'sf-perm', choice: 4 });
  st = fst();
  check('board, permission: "No" taken with three Downs and Enter', res.status === 200 && res.j.sent === 'No' && st.keys['sf-perm'].join(' ') === 'down down down enter', `${res.status} ${JSON.stringify(res.j)} keys ${st.keys['sf-perm']}`);

  res = await fb.post('/api/send', { projectId: 'ask', surfaceId: 'sf-ask', choice: 2 });
  st = fst();
  check('board, AskUserQuestion: "80 cm" taken with Down and Enter, the answer on screen', res.status === 200 && res.j.sent === '80 cm' && st.keys['sf-ask'].join(' ') === 'down enter' && /→ 80 cm/.test(st.screens['sf-ask']), `${res.status} ${JSON.stringify(res.j)} keys ${st.keys['sf-ask']}`);
  check('board: no digit was ever typed into a menu', !Object.values(st.keys).flat().some((k) => /^text:/.test(k)));

  res = await fb.post('/api/send', { projectId: 'stuck', surfaceId: 'sf-stuck', choice: 1 });
  check('board: a menu still open after Enter is an error the page shows, not "Sent"', res.status === 502 && /Pressed Enter on "Yes" but the menu is still open\. Answer it in cmux\./.test(res.j.error), `${res.status} ${JSON.stringify(res.j)}`);
  res = await fb.post('/api/send', { projectId: 'frozen', surfaceId: 'sf-frozen', choice: 2 });
  st = fst();
  check('board: a menu that ignores the arrows gets no Enter, and the page is told', res.status === 502 && !st.keys['sf-frozen'].includes('enter') && /did not move to "Yes, I trust this folder"/.test(res.j.error), `${res.status} ${JSON.stringify(res.j)} keys ${st.keys['sf-frozen']}`);
  res = await fb.post('/api/send', { projectId: 'trust', surfaceId: 'sf-trust', choice: 2 });
  check('board: no menu open any more, a choice is refused (nothing typed)', res.status === 400 || res.status === 409, `${res.status} ${JSON.stringify(res.j)}`);
  check('board: the log names what was pressed', /choose: "80 cm" taken in ask \(down enter; menu closed\)/.test(fb.log) && /choose: option 1 in stuck not taken \(enter\)/.test(fb.log));
} finally {
  fb.board.kill();
}

// ------------------------------------------------------------ 4. the real folder-trust prompt

const ri = process.argv.indexOf('--real');
if (ri >= 0) {
  const CMUX = process.env.CMUX_BIN_REAL || '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const cm = (args, json) => {
    const out = execFileSync(CMUX, json ? ['--json', '--id-format', 'both', ...args] : args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } });
    return json ? JSON.parse(out) : out;
  };
  const tree = () => cm(['tree', '--all'], true).windows.flatMap((w) => w.workspaces);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const dir = path.join(path.resolve(process.argv[ri + 1] || '.'), 'mc-test-choose-' + stamp);
  fs.mkdirSync(dir, { recursive: true });
  const name = 'mc-test-choose-' + stamp;
  let ws = null;
  let rb = null;
  try {
    cm(['new-workspace', '--name', name, '--focus', 'false', '--cwd', dir, '--command', 'claude']);
    for (let k = 0; k < 40 && !ws; k++) { await sleep(250); ws = tree().find((w) => w.title === name) || null; }
    if (!ws) throw new Error('the scratch workspace did not appear');
    const sf = ws.panes.flatMap((p) => p.surfaces)[0];
    const read = () => cm(['read-screen', '--workspace', ws.id, '--surface', sf.id, '--lines', '40']);
    let first = null;
    for (let k = 0; k < 60; k++) { await sleep(500); const t = read(); const mm = readMenu(t); if (mm) { first = { t, mm }; break; } }
    fs.writeFileSync(path.join(T, 'real-before.txt'), first ? first.t : read());
    check('real: the new folder opens on the folder-trust prompt, "No, exit" selected', first && first.mm.options.map((o) => o.label).join('|') === 'No, exit|Yes, I trust this folder' && first.mm.at === 0, first ? labels(first.mm) : 'no menu seen');
    const RMC = path.join(T, 'mc-real');
    registry(RMC, [{ id: name, name, folder: dir, workspaces: [ws.id], brief: null }]);
    rb = await startBoard({ port: 4667, mc: RMC, env: {} });
    const t0 = Date.now();
    const res = await rb.post('/api/send', { projectId: name, surfaceId: sf.id, choice: 2 });
    const took = Date.now() - t0;
    check('real: the board\'s choice route answered "Yes, I trust this folder"', res.status === 200 && res.j.sent === 'Yes, I trust this folder', `${res.status} ${JSON.stringify(res.j)} in ${took} ms`);
    let after = '';
    let ps = null;
    for (let k = 0; k < 30; k++) { await sleep(300); after = read(); ps = parseScreen(after); if (ps.claudeLive && !ps.dialog && /Claude Code v/.test(after)) break; }
    fs.writeFileSync(path.join(T, 'real-after.txt'), after);
    check('real: the trust prompt is gone and Claude Code\'s prompt is on screen', ps && ps.claudeLive && !ps.dialog && /Claude Code v/.test(after) && !/Yes, I trust this folder/.test(after), after.split('\n').filter((l) => l.trim()).slice(-4).join(' / '));
    check('real: the board logged the keys it pressed', /choose: "Yes, I trust this folder" taken in mc-test-choose-\d+ \(down enter; menu closed\)/.test(rb.log), (rb.log.match(/choose:.*$/m) || [''])[0]);
    console.log('\n--- real screen before ---\n' + fs.readFileSync(path.join(T, 'real-before.txt'), 'utf8').split('\n').filter((l) => l.trim()).slice(-6).join('\n'));
    console.log('--- real screen after ---\n' + after.split('\n').filter((l) => l.trim()).slice(-8).join('\n') + '\n');
  } finally {
    if (rb) rb.board.kill();
    if (ws) { try { cm(['close-workspace', '--workspace', ws.id]); console.log('closed scratch workspace', ws.id); } catch (e) { console.log('could not close', ws.id, e.message); } }
    check('real: the scratch workspace is closed', ws && !tree().some((w) => w.id === ws.id));
  }
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
