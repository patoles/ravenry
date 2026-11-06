// Quick mockups on idea cards (docs/design/IdeaMockups.dc.html, variant A):
// the answer parser on crafted replies, then a test board on :4664 (fake
// cmux) whose model is tools/stub-mockup-claude.mjs (no quota): a round
// writes 3 pages and 3 PNGs drawn with JavaScript off, the pictures are
// served only through the idea-picture rules, Pick sets the cover and the
// dropped picture can come back, the next round carries the picked page and
// the note, and bad JSON, a time-out and Stop each end the round cleanly.
// Dragging into the Mockup column starts nothing. Touches only .tmp/.
//
// Usage: node tools/idea-mockups-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'idea-mockups');
fs.rmSync(T, { recursive: true, force: true });
const MC = path.join(T, 'mc');
const IDEAS = path.join(MC, 'ideas');
fs.mkdirSync(IDEAS, { recursive: true });
process.env.RAVENRY_HOME = MC;
const mk = await import('../server/mockups.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the parser
const page = (t) => `<!doctype html><html><body><svg width="800" height="500"><text>${t}</text></svg></body></html>`;
const three = [1, 2, 3].map((k) => ({ title: `V${k}`, note: `n${k}`, html: page(k) }));
check('parse: a plain JSON array of 3', mk.parseVariants(JSON.stringify(three))?.length === 3);
check('parse: inside a code fence', mk.parseVariants('```json\n' + JSON.stringify(three) + '\n```')?.length === 3);
check('parse: with prose around it', mk.parseVariants('Here you go:\n' + JSON.stringify(three) + '\nEnjoy.')?.length === 3);
check('parse: prose only is refused', mk.parseVariants('A top view, a side view and a close-up.') === null);
check('parse: broken JSON is refused', mk.parseVariants('[{"title": "A", "html": "<svg>') === null);
check('parse: only 2 usable variants is refused', mk.parseVariants(JSON.stringify([three[0], three[1], { title: 'x', html: 'no markup' }])) === null);
check('parse: a page over 40 KB does not count', mk.parseVariants(JSON.stringify([three[0], three[1], { title: 'big', html: page('x'.repeat(41 * 1024)) }])) === null);
const stripped = mk.parseVariants(JSON.stringify([{ ...three[0], html: page(1) + '<script>alert(1)</script>' }, three[1], three[2]]));
check('parse: scripts are taken out', stripped && !/script/i.test(stripped[0].html));
check('parse: em dashes become commas', mk.parseVariants(JSON.stringify([{ ...three[0], title: 'Low \u2014 angle' }, three[1], three[2]]))[0].title === 'Low, angle');
const env = mk.unwrap(JSON.stringify({ result: '[]', is_error: false, total_cost_usd: 0.1, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 900, output_tokens_details: { thinking_tokens: 300 } } }));
check('unwrap: tokens from the JSON envelope', env.usage.input === 152 && env.usage.output === 900 && env.usage.thinking === 300 && env.usage.costUsd === 0.1, JSON.stringify(env.usage));
check('unwrap: an error envelope is an error', !!mk.unwrap(JSON.stringify({ is_error: true, result: 'overloaded' })).error);

// ------------------------------------------------------------ a test board
const PORT = 4664;
const BASE = `http://localhost:${PORT}`;
const LOG = path.join(T, 'prompts.jsonl');
const FAKE = path.join(T, 'fake-cmux.json');
fs.writeFileSync(FAKE, JSON.stringify({ workspaces: [], screens: {} }));
fs.copyFileSync(path.join(ROOT, 'brand/ravenry/icon-256.png'), path.join(IDEAS, 'kites-drop.png'));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), printCommand: [process.execPath, path.join(ROOT, 'tools/stub-mockup-claude.mjs')], claudeTimeoutMs: 4000 }, projects: [] }, null, 2));
const ID = 'kitestest';
fs.writeFileSync(path.join(MC, 'ideas.json'), JSON.stringify({ version: 1, seededAt: new Date().toISOString(), ideas: [
  { id: ID, name: 'KITES', stage: 'spark', pitch: 'Paper kites racing over rooftops.', status: 'Not greenlit.', img: 'kites-drop.png', alt: 'KITES', thread: [{ who: 'you', text: 'Is the low angle readable?', at: new Date().toISOString() }, { who: 'claude', text: 'Mostly.', at: new Date().toISOString() }], created: new Date().toISOString(), updated: new Date().toISOString() },
  { id: 'other', name: 'Other', stage: 'spark', pitch: 'x', status: '', img: null, alt: null, thread: [], created: new Date().toISOString(), updated: new Date().toISOString() },
] }, null, 2));

const server = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env: { ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, STUB_PROMPT_LOG: LOG }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const api = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json() }; };
const idea = async () => (await (await fetch(BASE + '/api/ideas')).json()).ideas.find((x) => x.id === ID);
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const DIR = path.join(IDEAS, ID, 'mockups');
const pngSize = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/state')).ok) break; } catch { /* not yet */ } await sleep(250); }

  // ---- dragging into the Mockup column starts nothing
  let r = await api(`/api/ideas/${ID}/update`, { stage: 'mock' });
  await sleep(600);
  let it = await idea();
  check('drag to Mockup: the stage moves, no round starts', r.status === 200 && it.stage === 'mock' && !it.mockups && calls().length === 0);

  // ---- round 1
  r = await api(`/api/ideas/${ID}/mockups`, {});
  check('Mock it up: round 1 starts', r.status === 200 && r.j.round === 1, JSON.stringify(r.j));
  it = await idea();
  check('working state: the job shows with its start time and 3-minute style stop', it.mockups.job && it.mockups.job.round === 1 && it.mockups.job.startedAt && it.mockups.job.timeoutMs === 4000);
  const busy = await api(`/api/ideas/${ID}/say`, { text: 'hello' });
  check('one job at a time: a thread message waits while it draws', busy.status === 409, busy.j.error);
  it = await until(async () => { const x = await idea(); return x.mockups.rounds.length === 1 ? x : null; });
  check('round 1 lands with 3 variants', it && it.mockups.rounds[0].variants.map((v) => v.title).join(',') === 'Top View,Low Angle,Close Up', it ? JSON.stringify(it.mockups.error) : 'timed out');
  const c1 = calls()[0];
  check('the call is claude -p without user settings or MCP servers, with --model sonnet --output-format json, in the ideas folder', c1 && c1.argv.join(' ') === '--strict-mcp-config --setting-sources project,local --model sonnet --output-format json' && fs.realpathSync(c1.cwd) === fs.realpathSync(IDEAS), c1 && c1.argv.join(' '));
  check('the prompt is the idea and its thread, asking for 3 {title, note, html} at 800x500', c1 && /Idea: KITES/.test(c1.prompt) && /Is the low angle readable\?/.test(c1.prompt) && /800x500/.test(c1.prompt) && /\{"title": "2 to 4 words"/.test(c1.prompt) && /Its picture: .*kites-drop\.png/.test(c1.prompt));
  const files = ['a', 'b', 'c'].flatMap((k) => [`r1-${k}.html`, `r1-${k}.png`]);
  check('files: r1-a/b/c .html and .png in ideas/<id>/mockups', files.every((f) => fs.existsSync(path.join(DIR, f))), fs.existsSync(DIR) ? fs.readdirSync(DIR).join(' ') : 'no folder');
  check('each PNG is 800x500', ['a', 'b', 'c'].every((k) => pngSize(path.join(DIR, `r1-${k}.png`)).join('x') === '800x500'));
  check('the pages keep no script', !/<script/i.test(fs.readFileSync(path.join(DIR, 'r1-a.html'), 'utf8')));
  check('the round logs its time and tokens', /mockup round 1 for KITES: 3 variants in \d+ s, 2002 tokens in, 3000 out \(1000 thinking\), \$0\.012/.test(serverLog) && /"round":1,.*"input":2002,"output":3000/.test(fs.readFileSync(path.join(DIR, 'rounds.jsonl'), 'utf8')), (serverLog.match(/ideas: mockup.*/) || [''])[0]);
  check('the round keeps its time and tokens for the card', it.mockups.rounds[0].ms > 0 && it.mockups.rounds[0].tokens.input === 2002);
  const line1 = it.thread.find((m) => m.who === 'board');
  check('thread: one quiet line for the round', line1 && line1.text === 'Mockup round 1: 3 variants.', line1 && line1.text);

  // ---- serving
  const img = it.mockups.rounds[0].variants[1].img;
  const g = await fetch(BASE + img);
  check('the PNG is served through the idea-picture route', g.status === 200 && g.headers.get('content-type') === 'image/png', `${img} ${g.status}`);
  for (const bad of [`${ID}/mockups/r1-a.html`, `${ID}/mockups/../../ideas.json`, `../projects.json`, `nosuch/mockups/r1-a.png`, `${ID}/mockups/r1-d.png`, `${ID}/mockups/rounds.jsonl`, `${ID}/r1-a.png`]) {
    const x = await fetch(`${BASE}/api/ideas/img/${encodeURIComponent(bad)}`);
    check(`not served: ${bad}`, x.status === 404, String(x.status));
  }

  // ---- pick, and the dropped picture back
  r = await api(`/api/ideas/${ID}/mockups/pick`, { round: 1, key: 'b' });
  it = await idea();
  check('Pick B: it is the card cover', r.status === 200 && it.img === img && it.mockups.rounds[0].picked === 'b');
  check('thread line says what was picked', it.thread.find((m) => m.who === 'board').text === 'Mockup round 1: 3 variants. Picked B, Low Angle.');
  check('the dropped picture stays and is offered back', !!it.mockups.dropped && /kites-drop\.png/.test(it.mockups.dropped));
  r = await api(`/api/ideas/${ID}/mockups/pick`, { dropped: true });
  it = await idea();
  check('the dropped picture can be the cover again', r.status === 200 && /kites-drop\.png/.test(it.img) && !it.mockups.dropped);
  await api(`/api/ideas/${ID}/mockups/pick`, { round: 1, key: 'b' });

  // ---- round 2 builds on the pick, with the note
  r = await api(`/api/ideas/${ID}/mockups`, { note: 'Four players, warmer wood', from: { round: 1, key: 'b' } });
  it = await until(async () => { const x = await idea(); return x.mockups.rounds.length === 2 ? x : null; });
  const c2 = calls()[1];
  check('round 2: the picked page and the note go in the prompt', c2 && /Round 1 made 3 variants\. The user picked "Low Angle"\. Its HTML:\n<!doctype html>/.test(c2.prompt) && /The user's note for this round: "Four players, warmer wood"/.test(c2.prompt));
  check('round 2: the thread line from round 1 is in its context', c2 && /Board: Mockup round 1.*Low Angle.*They picked B\./.test(c2.prompt));
  check('round 2 lands next to round 1, the cover unchanged', it && it.mockups.rounds.length === 2 && it.img === img && it.mockups.rounds[1].note === 'Four players, warmer wood');
  check('thread: a second quiet line', it.thread.filter((m) => m.who === 'board').map((m) => m.text).join(' | ') === 'Mockup round 1: 3 variants. Picked B, Low Angle. | Mockup round 2: 3 variants, with your note.');

  // ---- bad JSON
  await api(`/api/ideas/${ID}/mockups`, { note: 'BADJSON please' });
  it = await until(async () => { const x = await idea(); return x.mockups.error ? x : null; });
  check('bad JSON: one plain sentence, round 2 kept', it && it.mockups.error.text === 'Round 3 did not come back: Claude answered, but not with 3 pictures the board could read. Round 2 is kept.' && it.mockups.rounds.length === 2 && !it.mockups.job, it && it.mockups.error.text);
  check('bad JSON: no files for round 3', !fs.readdirSync(DIR).some((f) => f.startsWith('r3-')));
  await api(`/api/ideas/${ID}/mockups`, { note: 'ISERROR please' });
  it = await until(async () => { const x = await idea(); return x.mockups.error && !x.mockups.job && /reported an error/.test(x.mockups.error.text) ? x : null; });
  check('an error answer: one plain sentence', !!it, it && it.mockups.error.text);

  // ---- time-out
  const tt = Date.now();
  await api(`/api/ideas/${ID}/mockups`, { note: 'SLOW please' });
  it = await until(async () => { const x = await idea(); return !x.mockups.job && x.mockups.error ? x : null; }, 12000);
  check('time-out: stopped with one sentence', it && it.mockups.error.text === 'Round 3 did not come back: Claude stopped at 4 seconds without an answer. Round 2 is kept.' && Date.now() - tt >= 3900, it && it.mockups.error.text);

  // ---- Stop
  const n0 = calls().length;
  await api(`/api/ideas/${ID}/mockups`, { note: 'SLOW again' });
  await until(async () => calls().length > n0, 5000);
  r = await api(`/api/ideas/${ID}/mockups/stop`, {});
  it = await idea();
  check('Stop: the job ends at once, no error, nothing written', r.j.stopped === true && !it.mockups.job && !it.mockups.error && !fs.readdirSync(DIR).some((f) => f.startsWith('r3-')), JSON.stringify(it.mockups.error));
  await sleep(4500);
  it = await idea();
  check('Stop: the stopped call never lands later', !it.mockups.job && !it.mockups.error && it.mockups.rounds.length === 2);
  r = await api(`/api/ideas/${ID}/mockups`, {});
  it = await until(async () => { const x = await idea(); return x.mockups.rounds.length === 3 ? x : null; });
  check('after Stop the next round runs as round 3', r.status === 200 && !!it);
  const pk = await api(`/api/ideas/${ID}/mockups/pick`, { round: 9, key: 'a' });
  check('Pick of a round that is not there is refused', pk.status === 400, pk.j.error);
} catch (e) {
  console.error('ERROR', e);
  fails++;
} finally {
  server.kill();
}
if (fails) console.log(serverLog.split('\n').slice(-25).join('\n'));
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
process.exit(fails ? 1 : 0);
