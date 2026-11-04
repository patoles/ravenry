#!/usr/bin/env node
// Claude Code's suggested reply told apart from a half-typed one
// (server/suggestion.mjs, docs/STATE-RULES.md "The suggested reply").
//
// 1. The styled read on real captured render grids (tools/fixtures/prompt/,
//    Claude Code 2.1.318 in cmux 0.64.20): the suggestion is faint, typed
//    text is not, bash mode's "!" box. The same screens as plain text, which
//    parseScreen reads as a draft (the bug).
// 2. The history of reads: a suggestion at the turn's end, the user typing
//    over it, text typed during the turn, a turn shorter than a read, text
//    that shows up long after the turn, a suggestion back after the user
//    deleted their text, and a board started while the session sat at rest.
// 3. The state rules (server/state.mjs, server/sessions.mjs) on a judged
//    screen: a suggestion is at rest (asked), typed text is a draft.
// 4. The probe with an in-memory prompt that behaves as the real one did:
//    over a suggestion, over typed text, the "!" of a "! command", a prompt
//    that ignores the character, a cursor in the middle of the text.
// 5. A test board on :4690 (the fake cmux playing prompts): Send over a
//    suggestion (styled read, and probe when the terminal has no styled
//    read), over typed text (refused, the text left as it was), a "! command"
//    over a suggestion; the snapshot's draft flags; Close.
// 6. With --real <scratch folder>: a throwaway cmux workspace
//    mc-test-suggest-* running a real `claude`, asked a question so it
//    suggests a reply, then the board's real Send over that suggestion (with
//    and without the styled read), and over a real half-typed reply (refused
//    and left intact). Only that workspace is ever typed into; it is closed
//    at the end.
//
// Usage: node tools/suggestion-test.mjs [--real <scratch folder> [--first styled]]
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'suggestion-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const FIX = path.join(ROOT, 'tools', 'fixtures', 'prompt');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };

const sg = await import('../server/suggestion.mjs');
const { parseScreen } = await import('../server/screen.mjs');
const { chooseOption } = await import('../server/choose.mjs');
const { sessionState } = await import('../server/state.mjs');
const { DEFAULT_SETTINGS } = await import('../server/registry.mjs');
process.env.RAVENRY_HOME = path.join(T, 'unit-home');
fs.mkdirSync(process.env.RAVENRY_HOME, { recursive: true });
const sess = await import('../server/sessions.mjs');

// ------------------------------------------------------------ 1. styled read

const gs = sg.gridPrompt(JSON.parse(fx('suggestion.grid.json')));
check('grid: the suggestion is read as faint text', gs && gs.marker === '❯' && gs.text === 'yes, write the poem' && gs.ghost === true, JSON.stringify(gs));
const gt = sg.gridPrompt(JSON.parse(fx('typed.grid.json')));
check('grid: typed text is not faint', gt && gt.text === 'my half reply' && gt.ghost === false, JSON.stringify(gt));
const gb = sg.gridPrompt(JSON.parse(fx('bash.grid.json')));
check('grid: bash mode\'s "!" box, empty', gb && gb.marker === '!' && gb.text === '' && gb.ghost === false, JSON.stringify(gb));
check('grid: no prompt box, nothing read', sg.gridPrompt({ row_spans: [{ row: 0, column: 0, style_id: 0, text: 'hello' }], styles: [] }) === null);

const ps = parseScreen(fx('suggestion.txt'));
check('plain read: parseScreen takes the suggestion for a draft (why this module exists)', ps.claudeLive && ps.draft === 'yes, write the poem');
const pt = parseScreen(fx('typed.txt'));
check('plain read: parseScreen reads typed text as a draft', pt.draft === 'my half reply');
let v = sg.judgePrompt({ text: ps.draft, styled: gs });
check('verdict: the styled read says suggestion, for sure', v.kind === 'suggestion' && v.sure && v.by === 'style');
v = sg.judgePrompt({ text: pt.draft, styled: gt });
check('verdict: the styled read says typed, for sure', v.kind === 'draft' && v.sure);
v = sg.judgePrompt({ text: 'yes, write the poem!', styled: gs });
check('verdict: a styled read of other text (the prompt moved) is not used', v.kind === 'unknown' && !v.sure);
const js = sg.withPrompt(ps, sg.judgePrompt({ text: ps.draft, styled: gs }));
check('judged screen: a suggestion leaves draft empty and moves to suggestion', js.draft === '' && js.suggestion === 'yes, write the poem' && js.prompt.kind === 'suggestion');
const jt = sg.withPrompt(pt, sg.judgePrompt({ text: pt.draft, styled: gt }));
check('judged screen: typed text stays the draft', jt.draft === 'my half reply' && jt.suggestion === null);
check('prompt box of a plain read: bash mode', JSON.stringify(sg.promptBox(fx('bash.txt'))) === JSON.stringify({ marker: '!', text: '' }));

// ------------------------------------------------------------ 2. history

const S = 'yes, write the poem';
const scr = (o) => ({ readable: true, claudeLive: true, working: false, agentsRunning: 0, dialog: null, draft: '', done: { verb: 'Cooked', took: '2s', when: '11:05 AM' }, ...o });
const working = (o) => scr({ working: true, done: { verb: 'Worked', took: '3s', when: '11:04 AM' }, ...o });
const t0 = Date.parse('2026-11-04T11:05:00Z');
let tr = sg.createTracker();
tr.see('a', working(), t0 - 4000);
tr.see('a', scr(), t0);
tr.see('a', scr(), t0 + 2000);
let k = tr.see('a', scr({ draft: S }), t0 + 4000);
check('history: text that shows up 4 s after the turn ends, not typed during it: suggestion', k === 'suggestion');
check('history: and still a suggestion a minute later, unchanged', tr.see('a', scr({ draft: S }), t0 + 60000) === 'suggestion');
check('history: the user types over it: draft', tr.see('a', scr({ draft: 'n' }), t0 + 62000) === 'draft' && tr.see('a', scr({ draft: 'no, a haiku' }), t0 + 64000) === 'draft');
check('history: they delete it all and the suggestion comes back: suggestion again', tr.see('a', scr({ draft: S }), t0 + 66000) === 'suggestion');

tr = sg.createTracker();
tr.see('b', working({ draft: 'and also' }), t0 - 4000);
check('history: text typed while the turn ran is a draft at the turn\'s end', tr.see('b', scr({ draft: 'and also' }), t0) === 'draft');
check('history: and a draft after the user edits it', tr.see('b', scr({ draft: 'and also this' }), t0 + 2000) === 'draft');

tr = sg.createTracker();
tr.see('c', scr({ done: { verb: 'Worked', took: '1m', when: '10:50 AM' } }), t0 - 60000);
check('history: a turn shorter than a read (only the done line changed): suggestion', tr.see('c', scr({ draft: S }), t0) === 'suggestion');

tr = sg.createTracker();
tr.see('d', working(), t0 - 4000);
tr.see('d', scr(), t0);
check('history: text that shows up 5 minutes after the turn ended: draft (typed later)', tr.see('d', scr({ draft: 'ok go' }), t0 + 300000) === 'draft');

tr = sg.createTracker();
tr.see('e', working(), t0 - 4000);
tr.see('e', scr({ draft: 'y' }), t0);
check('history: text that keeps changing after the turn is typing: draft', tr.see('e', scr({ draft: 'yes ple' }), t0 + 2000) === 'draft');

tr = sg.createTracker();
k = tr.see('f', scr({ draft: S }), t0);
check('history: the board started while the session sat at rest: unknown', k === 'unknown');
const ju = sg.withPrompt(ps, sg.judgePrompt({ text: S, history: k }));
check('history: unknown shows as NOT a draft (the suggestion field holds it)', ju.draft === '' && ju.suggestion === S && ju.prompt.kind === 'unknown' && !ju.prompt.sure);
check('history: after that session\'s next turn, it is known', (tr.see('f', working(), t0 + 10000), tr.see('f', scr({ draft: 'next one' }), t0 + 14000)) === 'suggestion');
check('history: a heuristic verdict is never "sure"', sg.judgePrompt({ text: S, history: 'suggestion' }).sure === false);
check('history: a dialog keeps what was known', (tr.see('f', scr({ dialog: { options: [] }, draft: '' }), t0 + 15000), tr.see('f', scr({ draft: 'next one' }), t0 + 16000)) === 'suggestion');
tr.see('f', { readable: true, claudeLive: false }, t0 + 20000);
check('history: Claude gone from the tab forgets it', !tr.has('f'));

// ------------------------------------------------------------ 3. the state rules

const settings = { ...DEFAULT_SETTINGS };
const now = t0 + 60000;
const tq = { lastTurnEndAt: new Date(t0).toISOString(), lastTextAt: new Date(t0).toISOString(), lastText: 'Since your cat is round, Mochi fits: do you want the poem?' };
let st = sessionState({ screen: js, title: { claude: true, busy: false }, transcript: tq, hook: null }, settings, now);
check('state: a suggestion in the prompt reads as asked, not draft', st.state === 'asked' && st.reasons.some((r) => /suggested reply \(its text is dim\)/.test(r)), `${st.state} ${st.reasons.join('; ')}`);
st = sessionState({ screen: jt, title: { claude: true, busy: false }, transcript: tq, hook: null }, settings, now);
check('state: typed text reads as draft', st.state === 'draft');
st = sessionState({ screen: ps, title: { claude: true, busy: false }, transcript: tq, hook: null }, settings, now);
check('state: the raw plain read would have said draft (the bug)', st.state === 'draft');
const old48 = new Date(t0 - 48 * 3600000).toISOString();
const base = { st: { state: 'asked' }, t: { ...tq, lastTurnEndAt: old48, lastTextAt: old48, lastActivityAt: old48 }, ev: null, marker: null };
check('sessions: a suggestion is not tagged draft', sess.classify({ ...base, screen: js }, 24 * 3600000, now).tag !== 'draft');
check('sessions: typed text is tagged draft', sess.classify({ ...base, screen: jt }, 24 * 3600000, now).tag === 'draft');

// ------------------------------------------------------------ 4. the probe

// A prompt that behaves as the real one did (measured on 2.1.318): a typed
// character or a paste replaces the suggestion, a "!" on an empty prompt is
// bash mode, Backspace to empty brings the suggestion back.
function memPrompt({ ghost = null, typed = '', cursor = null, deaf = false } = {}) {
  const p = { ghost, typed, cursor: cursor == null ? typed.length : cursor, bash: false, keys: [] };
  const rule = '─'.repeat(60);
  p.read = async () => `\n${rule}\n${p.bash ? '! ' + p.typed : '❯ ' + (p.typed || p.ghost || '')}\n${rule}\n  ⏵⏵ auto mode on\n`;
  p.type = async (c) => {
    p.keys.push('text:' + c);
    if (deaf) return { ok: true };
    if (c === '!' && !p.typed && !p.bash) { p.bash = true; return { ok: true }; }
    p.typed = p.typed.slice(0, p.cursor) + c + p.typed.slice(p.cursor);
    p.cursor++;
    return { ok: true };
  };
  p.key = async (k2) => {
    p.keys.push(k2);
    if (k2 === 'backspace') {
      if (p.cursor > 0) { p.typed = p.typed.slice(0, p.cursor - 1) + p.typed.slice(p.cursor); p.cursor--; } else p.bash = false;
    }
    return { ok: true };
  };
  return p;
}
const quick = { wait: 1, tries: 3 };
let m = memPrompt({ ghost: S });
let r = await sg.probePrompt({ ...m, old: S, ...quick });
check('probe over a suggestion: suggestion, the digit taken back, the suggestion shows again', r.kind === 'suggestion' && m.keys.join(' ') === 'text:1 backspace' && (await m.read()).includes('❯ ' + S), m.keys.join(' '));
m = memPrompt({ typed: 'my half reply' });
r = await sg.probePrompt({ ...m, old: 'my half reply', ...quick });
check('probe over typed text: draft, the text exactly as it was', r.kind === 'draft' && m.typed === 'my half reply' && m.keys.join(' ') === 'text:1 backspace', m.keys.join(' '));
m = memPrompt({ typed: 'my half reply', cursor: 3 });
r = await sg.probePrompt({ ...m, old: 'my half reply', ...quick });
check('probe with the cursor mid-text: draft, the text as it was', r.kind === 'draft' && m.typed === 'my half reply', m.typed);
m = memPrompt({ ghost: S });
r = await sg.probePrompt({ ...m, old: S, bang: true, ...quick });
check('probe with a "! command" over a suggestion: suggestion, bash mode left on for the command', r.kind === 'suggestion' && r.bash && m.bash && m.keys.join(' ') === 'text:!', m.keys.join(' '));
m = memPrompt({ typed: 'my half reply' });
r = await sg.probePrompt({ ...m, old: 'my half reply', bang: true, ...quick });
check('probe with a "! command" over typed text: draft, the "!" taken back', r.kind === 'draft' && m.typed === 'my half reply' && !m.bash && m.keys.join(' ') === 'text:! backspace', m.keys.join(' '));
m = memPrompt({ typed: 'my half reply', deaf: true });
r = await sg.probePrompt({ ...m, old: 'my half reply', ...quick });
check('probe on a prompt that ignores the digit: unknown, no Backspace pressed', r.kind === 'unknown' && m.keys.join(' ') === 'text:1' && m.typed === 'my half reply', `${r.kind} ${m.keys.join(' ')} ${r.error}`);
m = memPrompt({ typed: 'other text' });
r = await sg.probePrompt({ ...m, old: 'my half reply', ...quick });
check('probe when the prompt no longer shows what the board saw: unknown, nothing typed', r.kind === 'unknown' && m.keys.length === 0);

// ------------------------------------------------------------ 5. the test board

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
  const b = `http://127.0.0.1:${port}`;
  out.post = async (p, body) => {
    const res = await fetch(b + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
    let j = null;
    try { j = await res.json(); } catch { /* none */ }
    return { status: res.status, j };
  };
  out.state = async () => (await fetch(b + '/api/state')).json();
  const s0 = Date.now();
  while (Date.now() - s0 < 15000) {
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
const body = '\n⏺ Since your cat is round, Mochi fits: do you want the poem?\n\n✻ Cooked for 2s · done 11:05 AM\n';
const PROMPTS = {
  ghost: { body, ghost: S },
  'ghost-plain': { body, ghost: S, noStyle: true },
  typed: { body, typed: 'my half reply' },
  'typed-plain': { body, typed: 'my half reply', noStyle: true },
  bang: { body, ghost: S, noStyle: true },
};
const IDS = Object.keys(PROMPTS);
const folder = (id) => { const d = path.join(T, 'projs', id); fs.mkdirSync(d, { recursive: true }); return d; };
registry(MC, IDS.map((id) => ({ id, name: 'Prompt ' + id, folder: folder(id), workspaces: ['ws-' + id], brief: null })));
fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: IDS.map((id, n) => ({ id: 'ws-' + id, ref: 'workspace:' + (n + 1), title: 'Prompt ' + id, cwd: folder(id), surfaces: [{ id: 'sf-' + id, ref: 'surface:' + (n + 1), title: '✳ Prompt ' + id }] })),
  screens: {},
  prompts: Object.fromEntries(IDS.map((id) => ['sf-' + id, PROMPTS[id]])),
}));
const fb = await startBoard({ port: 4690, mc: MC, env: { CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE } });
const fst = () => JSON.parse(fs.readFileSync(FAKE, 'utf8'));
try {
  const s = await fb.state();
  const sOf = (id) => s.projects.find((x) => x.id === id).sessions[0];
  check('board: a suggestion (styled read) is not shown as a draft', sOf('ghost').draft === false && sOf('ghost').state !== 'draft', `${sOf('ghost').state} ${sOf('ghost').reasons.join('; ')}`);
  check('board: a suggestion with no styled read and no history is not shown as a draft either', sOf('ghost-plain').draft === false && sOf('ghost-plain').state !== 'draft', sOf('ghost-plain').state);
  check('board: typed text (styled read) is shown as a draft', sOf('typed').draft === true && sOf('typed').state === 'draft');
  check('board: nothing was typed by the ticks', !Object.keys(fst().keys || {}).length, JSON.stringify(fst().keys || {}));

  let res = await fb.post('/api/send', { projectId: 'ghost', surfaceId: 'sf-ghost', text: 'no, a haiku' });
  let f = fst();
  check('send over a suggestion (styled read): sent, no probe keys', res.status === 200 && f.prompts['sf-ghost'].sent[0] === 'no, a haiku' && f.keys['sf-ghost'].join(' ') === 'paste:no, a haiku enter', `${res.status} ${JSON.stringify(res.j)} keys ${f.keys['sf-ghost']}`);
  res = await fb.post('/api/send', { projectId: 'ghost-plain', surfaceId: 'sf-ghost-plain', text: 'no, a haiku' });
  f = fst();
  check('send over a suggestion (no styled read): the probe, then sent', res.status === 200 && f.prompts['sf-ghost-plain'].sent[0] === 'no, a haiku' && f.keys['sf-ghost-plain'].join(' ') === 'text:1 backspace paste:no, a haiku enter', `${res.status} ${JSON.stringify(res.j)} keys ${f.keys['sf-ghost-plain']}`);
  res = await fb.post('/api/send', { projectId: 'typed', surfaceId: 'sf-typed', text: 'no, a haiku' });
  f = fst();
  check('send over typed text (styled read): refused with the old words, nothing typed', res.status === 409 && /There is half-typed text in its prompt\. Finish it in cmux so it is not mixed in\./.test(res.j.error) && !(f.keys && f.keys['sf-typed']) && f.prompts['sf-typed'].typed === 'my half reply', `${res.status} ${JSON.stringify(res.j)}`);
  res = await fb.post('/api/send', { projectId: 'typed-plain', surfaceId: 'sf-typed-plain', text: 'no, a haiku' });
  f = fst();
  check('send over typed text (no styled read): refused, the probe\'s digit taken back, text intact', res.status === 409 && /half-typed text/.test(res.j.error) && f.keys['sf-typed-plain'].join(' ') === 'text:1 backspace' && f.prompts['sf-typed-plain'].typed === 'my half reply' && !f.prompts['sf-typed-plain'].sent, `${res.status} keys ${f.keys['sf-typed-plain']} typed "${f.prompts['sf-typed-plain'].typed}"`);
  res = await fb.post('/api/send', { projectId: 'bang', surfaceId: 'sf-bang', text: '! ls -la' });
  f = fst();
  check('send a "! command" over a suggestion (no styled read): the probe\'s "!" is the bash "!", one "!" only', res.status === 200 && f.prompts['sf-bang'].sent[0] === '!ls -la' && f.keys['sf-bang'].join(' ') === 'text:! paste:ls -la enter', `${res.status} keys ${f.keys['sf-bang']} sent ${JSON.stringify(f.prompts['sf-bang'].sent)}`);
  check('board: the log says the suggestion was typed over', /send: the prompt in ghost held Claude's suggested reply \(style\)/.test(fb.log) && /send: the prompt in ghost-plain held Claude's suggested reply \(probe: text:1 backspace\)/.test(fb.log));
} finally {
  fb.board.kill();
}

// ------------------------------------------------------------ 6. a real Claude Code

const ri = process.argv.indexOf('--real');
if (ri >= 0) {
  const CMUX = process.env.CMUX_BIN_REAL || '/Applications/cmux.app/Contents/Resources/bin/cmux';
  const cm = (args, json) => {
    const out = execFileSync(CMUX, json ? ['--json', '--id-format', 'both', ...args] : args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } });
    return json ? JSON.parse(out) : out;
  };
  const tree = () => cm(['tree', '--all'], true).windows.flatMap((w) => w.workspaces);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const name = 'mc-test-suggest-' + stamp;
  const dir = path.join(path.resolve(process.argv[ri + 1] || '.'), name);
  fs.mkdirSync(dir, { recursive: true });
  let ws = null;
  const boards = [];
  try {
    cm(['new-workspace', '--name', name, '--focus', 'false', '--cwd', dir, '--command', 'claude']);
    for (let n = 0; n < 40 && !ws; n++) { await sleep(250); ws = tree().find((w) => w.title === name) || null; }
    if (!ws) throw new Error('the scratch workspace did not appear');
    const sf = ws.panes.flatMap((p) => p.surfaces)[0];
    const W = ['--workspace', ws.id, '--surface', sf.id];
    const read = () => cm(['read-screen', ...W, '--lines', '40']);
    const styled = () => { try { return sg.gridPrompt(JSON.parse(cm(['rpc', 'terminal.replay', JSON.stringify({ workspace_id: ws.id, surface_id: sf.id })])).render_grid); } catch { return null; } };
    const box = () => sg.promptBox(read());
    const until = async (what, ms, fn) => { const s0 = Date.now(); while (Date.now() - s0 < ms) { const x = fn(); if (x) return x; await sleep(500); } throw new Error('timed out waiting for ' + what + '\n' + read().split('\n').slice(-8).join('\n')); };
    // The folder-trust prompt, then the prompt.
    await until('the folder-trust prompt', 30000, () => /Yes, I trust this folder/.test(read()));
    await sleep(1000);
    // Down and Enter, each read back (a key pressed before the menu is ready is lost).
    const tr0 = await chooseOption({ read: async () => read(), key: async (k2) => { cm(['send-key', ...W, k2]); return { ok: true }; }, want: 2 });
    if (!tr0.ok) throw new Error('the folder-trust prompt was not answered: ' + tr0.error);
    await until('Claude Code\'s prompt', 30000, () => { const b = box(); return b && b.marker === '❯' && !/Yes, I trust/.test(read()); });
    const doneNow = () => JSON.stringify(parseScreen(read()).done);
    // One turn: the done line changes and Claude is at rest; then a
    // suggested reply, if Claude Code offers one within 30 s.
    const turn = async (prev) => {
      await until('the turn to end', 180000, () => { const p = parseScreen(read()); return !p.working && JSON.stringify(p.done) !== prev; });
      const end = Date.now();
      const g = await until('a suggested reply', 30000, () => { const x = styled(); return x && x.ghost && x.text ? x : null; }).catch(() => null);
      return { g, ms: Date.now() - end };
    };
    const ask = async (q) => { const prev = doneNow(); cm(['send', ...W, '--', q]); await sleep(300); cm(['send-key', ...W, 'enter']); return turn(prev); };
    // Claude Code does not offer a suggestion after every turn: ask again.
    const QS = [
      'Reply in one short sentence, no tools: should I call my cat Pixel or Mochi? End with a yes/no question to me.',
      'In one sentence, offer to write a 3-line poem about my cat and ask if I want it.',
      'In one sentence, ask me whether you should go on.',
      'Reply in one sentence: is orange or grey the better colour for a cat? Ask me which I prefer.',
    ];
    const suggested = async (first) => {
      let x = first;
      for (const q of QS) { if (x && x.g) return x; x = await ask(q); }
      if (x && x.g) return x;
      throw new Error('Claude Code offered no suggested reply after ' + QS.length + ' questions');
    };
    let a = await suggested(null);
    const before = read();
    fs.writeFileSync(path.join(T, 'real-suggestion.txt'), before);
    check('real: a suggested reply shows after the turn, faint in the styled read', a.g.ghost, `"${a.g.text}" ${a.ms} ms after the turn ended`);
    check('real: the plain read puts it after the ❯, as parseScreen\'s draft', parseScreen(before).draft === a.g.text, JSON.stringify(sg.promptBox(before)));
    console.log('--- real screen with the suggestion ---\n' + before.split('\n').filter((l) => l.trim()).slice(-5).join('\n'));

    // The probe on the real prompt, straight from the module.
    const tab = { read: async () => read(), type: async (c) => { cm(['send', ...W, '--', c]); return { ok: true }; }, key: async (k2) => { cm(['send-key', ...W, k2]); return { ok: true }; } };
    let r = await sg.probePrompt({ ...tab, old: a.g.text });
    await sleep(500);
    check('real: the probe calls it a suggestion and leaves the suggestion showing', r.kind === 'suggestion' && box().text === a.g.text, `${r.kind} ${r.keys.join(' ')} now "${box().text}"`);

    const RMC = path.join(T, 'mc-real');
    registry(RMC, [{ id: name, name, folder: dir, workspaces: [ws.id], brief: null }]);
    const lineOf = (re) => read().split('\n').find((l) => re.test(l)) || '';
    const S1 = a.g.text;

    // A real half-typed reply over that suggestion: refused and left intact,
    // with the styled read and with the probe.
    cm(['send', ...W, '--', 'my half reply']);
    await sleep(800);
    check('real: typed text in the styled read is not faint', styled() && styled().ghost === false && box().text === 'my half reply', JSON.stringify(styled()));
    let rb = await startBoard({ port: 4692, mc: RMC, env: {} });
    boards.push(rb);
    let res = await rb.post('/api/send', { projectId: name, surfaceId: sf.id, text: 'should not arrive' });
    await sleep(500);
    check('real: Send over a half-typed reply (styled read) is refused and the text left as it was', res.status === 409 && /half-typed text/.test(res.j.error) && box().text === 'my half reply', `${res.status} now "${box().text}"`);
    rb.board.kill();
    rb = await startBoard({ port: 4691, mc: RMC, env: { MC_NO_STYLED_READ: '1' } });
    boards.push(rb);
    res = await rb.post('/api/send', { projectId: name, surfaceId: sf.id, text: 'should not arrive' });
    await sleep(500);
    check('real: Send over a half-typed reply (probe path) is refused and the text left as it was', res.status === 409 && /half-typed text/.test(res.j.error) && box().text === 'my half reply', `${res.status} now "${box().text}"`);
    res = await rb.post('/api/send', { projectId: name, surfaceId: sf.id, text: '! echo should-not-run' });
    await sleep(500);
    check('real: a "! command" over a half-typed reply (probe path) is refused, the "!" taken back', res.status === 409 && box().text === 'my half reply' && box().marker === '❯', `${res.status} now ${JSON.stringify(box())}`);
    fs.writeFileSync(path.join(T, 'real-typed.txt'), read());
    console.log('--- real screen with the half-typed reply, after the refusals ---\n' + read().split('\n').filter((l) => l.trim()).slice(-4).join('\n'));
    // Deleting the typed text brings the suggestion back.
    for (let n = 0; n < 'my half reply'.length; n++) cm(['send-key', ...W, 'backspace']);
    await sleep(800);
    check('real: Backspace to an empty prompt brings the suggestion back, faint', box().text === S1 && styled() && styled().ghost, JSON.stringify(styled()));

    rb.board.kill();
    await sleep(800); // its port is taken again below
    // Send over a suggestion through a board without the styled read (the
    // probe path) and through a normal board (the styled read). Claude Code
    // rarely offers a second suggestion after one was typed over, so the
    // second send may be skipped; `--first styled` swaps the order.
    const sendProbe = async () => {
      const pb = await startBoard({ port: 4691, mc: RMC, env: { MC_NO_STYLED_READ: '1' } });
      boards.push(pb);
      const prev = doneNow();
      const M1 = 'Yes, she is round. In one sentence, offer a 3-line poem and ask if I want it.';
      const r1 = await pb.post('/api/send', { projectId: name, surfaceId: sf.id, text: M1 });
      check('real: Send over the suggestion (probe path) is accepted', r1.status === 200, `${r1.status} ${JSON.stringify(r1.j)}`);
      check('real: the board logged the probe', /held Claude's suggested reply \(probe: text:1 backspace\)/.test(pb.log), (pb.log.match(/send:.*$/m) || [''])[0]);
      const nx = await turn(prev);
      check('real: the probe-path message reached Claude exactly as written', lineOf(/she is round/).trim() === '❯ ' + M1, JSON.stringify(lineOf(/she is round/).trim()));
      pb.board.kill();
      return nx;
    };
    const sendStyled = async () => {
      const sb = await startBoard({ port: 4692, mc: RMC, env: {} });
      boards.push(sb);
      fs.writeFileSync(path.join(T, 'real-before-styled-send.txt'), read());
      const prev = doneNow();
      const M2 = 'No thanks. In one sentence, ask me if I want a haiku instead.';
      const r2 = await sb.post('/api/send', { projectId: name, surfaceId: sf.id, text: M2 });
      check('real: Send over the suggestion (styled read) is accepted, no probe', r2.status === 200 && /held Claude's suggested reply \(style\), typing/.test(sb.log), `${r2.status} ${JSON.stringify(r2.j)} ${(sb.log.match(/send:.*$/m) || [''])[0]}`);
      const nx = await turn(prev);
      check('real: the styled-path message reached Claude exactly as written', lineOf(/No thanks\. In one/).trim() === '❯ ' + M2, JSON.stringify(lineOf(/No thanks/).trim()));
      sb.board.kill();
      return nx;
    };
    const fi = process.argv.indexOf('--first');
    const order = fi >= 0 && process.argv[fi + 1] === 'styled' ? [['styled read', sendStyled], ['probe path', sendProbe]] : [['probe path', sendProbe], ['styled read', sendStyled]];
    let next = await order[0][1]();
    check('real: nothing the board refused reached Claude', !/should not arrive|should-not-run/.test(read()));
    try { next = await suggested(next); } catch { next = null; }
    if (!next) console.log(`SKIP  real: Send over a suggestion (${order[1][0]}): Claude Code offered no second suggestion`);
    else await order[1][1]();
  } finally {
    for (const b of boards) b.board.kill();
    if (ws) { try { cm(['close-workspace', '--workspace', ws.id]); console.log('closed scratch workspace', ws.id); } catch (e) { console.log('could not close', ws.id, e.message); } }
    check('real: the scratch workspace is closed', ws && !tree().some((w) => w.id === ws.id));
  }
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
