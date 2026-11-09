#!/usr/bin/env node
// Who typed what, on the screen (src/renderer/marks.ts), in a pane whose
// program redraws its region as Claude Code does (tools/redraw-claude.mjs).
// On 2026-11-07 the person's own typing and an image paste were marked as
// "ravenry-desktop", with a box over an unrelated line and the label drawn
// on the text. Here:
//   - the person types a line and pastes an image's path in the window:
//     neither is marked (no box, no bar, no label);
//   - an agent (a program in another pane, which started this one) sends a
//     line: one bar in the right gutter, outside the cells, its name and
//     time on hover;
//   - after 50 more lines of output nothing of a mark overlaps the cells.
// Pictures in dark and light.
//
//   node tools/marks-test.mjs [OUT]
import { hubState } from './stub-state.mjs';
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'marks-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvmk-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500) : ''}`); if (!ok) fails++; };
const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };

const denv = { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(root, 'state') };
execFileSync(BIN, ['serve', '--detach'], { env: denv });
const { connectSocket } = await import(path.join(APP, '..', '..', 'packages', 'node-client', 'index.mjs'));
let sock = null;
for (let i = 0; i < 100 && !sock; i++) { const n = fs.readdirSync(rt).find((x) => x.endsWith('.sock')); if (n) sock = path.join(rt, n); else await new Promise((r) => setTimeout(r, 50)); }
const dc = await connectSocket(sock, { name: 'marks-test' });
// The agent: a program in a pane that starts the Claude-like pane (so it
// may drive it), then, when told, sends it a line.
const script = [
  'P=$("$RVBIN" new --name claude --label ravenry.session=claude --label ravenry.project=kite --size 100x30 -- "$RVNODE" "$RVTOOL")',
  'echo "$P" > "$RVWORK/p.id"',
  'while [ ! -f "$RVWORK/agent.go" ]; do sleep 0.1; done',
  '"$RVBIN" send "$P" --raw "agent line from the helper" --key Enter',
  'echo sent > "$RVWORK/agent.done"',
  'exec sleep 600',
].join('\n');
await dc.request('pane.new', { cols: 80, rows: 10, name: 'the agent', command: ['/bin/sh', '-c', script], env: { RVBIN: BIN, RVNODE: process.execPath, RVTOOL: path.join(HERE, 'redraw-claude.mjs'), RVWORK: work } });
dc.close();
const pane = await until(() => { try { return fs.readFileSync(path.join(work, 'p.id'), 'utf8').trim() || null; } catch { return null; } }, 15000);
if (!pane) { console.log('FAIL  the agent started the Claude-like pane'); process.exit(1); }

// The stub hub: the session is that pane.
let state = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fixtures', 'live-session-in-pane.json'), 'utf8').replace(/PANE/g, pane));
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); }, 300);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
// The screen's text, from the terminal's buffer (its renderer draws on a canvas).
const SCREEN = `(() => { const b = ${R}.term().term.buffer.active; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true)); return out.join('\\n'); })()`;
// Where the marks are: every bar on screen, the cells' right edge, and anything painted over cells.
const GEOM = `(() => {
  const scr = document.querySelector('.term-host .xterm-screen').getBoundingClientRect();
  const guts = [...document.querySelectorAll('.am-gut')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0 && r.bottom > scr.top && r.top < scr.bottom).map((r) => ({ left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), h: Math.round(r.height) }));
  const m = ${R}.marks();
  return { screenRight: Math.round(scr.right), guts, overCells: document.querySelectorAll('.am-tint, .am-say').length, label: (() => { const l = document.querySelector('.am-gut .am-lbl'); return l ? getComputedStyle(l).display : null; })(),
    lines: m.lines(), marked: m.marked, known: m.known.map((r) => ({ seq: r.seq, kind: r.source.kind, client: r.source.client || null, text: r.text })) };
})()`;
const geom = (n) => path.join(work, `${n}.json`);
const read = (n) => { try { return JSON.parse(fs.readFileSync(geom(n), 'utf8')); } catch { return null; } };

try {
  await runApp({ name: 'marks', work, rt, bin: BIN, home, hubUrl, width: 1100, height: 720,
    env: { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0', RAVENRY_TEST_CLIPBOARD: '/Users/you/Desktop/shot 1.png' },
    steps: [
      { ready: true },
      { until: `${R}.term().attached && ${R}.term().attached.pane === ${JSON.stringify(pane)}`, timeout: 15000 },
      { until: `${SCREEN}.includes('for shortcuts')`, timeout: 10000 },
      // The person types in the input box, sends it, then pastes an image's path.
      { type: 'hello claude, as the person' },
      { sleep: 300 },
      { type: '\r' },
      { sleep: 500 },
      // Cmd+V (the stand-in clipboard); on Linux the paste event's own call.
      process.platform === 'darwin' ? { key: 'v', modifiers: ['meta'] } : { js: `${R}.term().attached.client.paste(${R}.term().attached.pane, '/Users/you/Desktop/shot 1.png')` },
      { sleep: 500 },
      { type: '\r' },
      { sleep: 800 },
      // The agent sends a line.
      { signal: path.join(work, 'agent.go') },
      { wait: path.join(work, 'agent.done'), timeout: 15000 },
      { until: `${R}.marks().known.some((r) => r.source.kind === 'agent') && ${R}.marks().marked.length > 0`, timeout: 10000 },
      { sleep: 400 },
      { save: { expr: GEOM, out: geom('after-agent') } },
      { shot: path.join(OUT, 'marks-dark.png') },
      { hover: '.am-gut' },
      { sleep: 200 },
      { save: { expr: GEOM, out: geom('hover') } },
      { shot: path.join(OUT, 'marks-hover-dark.png') },
      { hover: [20, 20] },
      { theme: 'light' },
      { sleep: 300 },
      { shot: path.join(OUT, 'marks-light.png') },
      { hover: '.am-gut' },
      { sleep: 200 },
      { shot: path.join(OUT, 'marks-hover-light.png') },
      { hover: [20, 20] },
      { theme: 'dark' },
      // 50 more lines of output.
      { type: 'MORE 50\r' },
      { sleep: 1200 },
      { save: { expr: GEOM, out: geom('after-more') } },
      { shot: path.join(OUT, 'marks-after-50-dark.png') },
    ] });
  const a = read('after-agent');
  const person = (a?.known || []).filter((r) => r.kind !== 'agent');
  const agent = (a?.known || []).filter((r) => r.kind === 'agent');
  check('the person\'s typing and paste are in the pane\'s input log', person.some((r) => r.kind === 'person' && /^h/.test(r.text)) && person.some((r) => /shot 1\.png/.test(r.text)), a?.known);
  check('the person\'s typing and paste are never marked', !!a && person.every((r) => !a.marked.includes(r.seq)), { marked: a?.marked, person });
  check('the agent\'s line is marked, once', agent.length === 1 && a.marked.length === 1 && a.marked[0] === agent[0].seq, { marked: a?.marked, agent });
  check('the bar is beside the line that shows the agent\'s text', !!a && a.lines.length === 1 && /agent line from the helper/.test(a.lines[0].text), a?.lines);
  check('one bar on screen, in the right gutter, outside the cells', a?.guts.length === 1 && a.guts[0].left >= a.screenRight, a);
  check('nothing painted over the cells (no box, no label on the text)', a?.overCells === 0, a);
  const hv = read('hover');
  check('its name and time show on hover', hv?.label === 'block', hv?.label);
  const m = read('after-more');
  check('after 50 more lines: no bar inside the cells, nothing painted over them', !!m && m.overCells === 0 && m.guts.every((g) => g.left >= m.screenRight), m);
  check('after 50 more lines: still only the agent\'s input marked', !!m && m.marked.length === 1 && m.marked[0] === agent[0]?.seq, m?.marked);
  console.log(`pictures: ${OUT}`);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 2000));
} finally {
  clearInterval(tick);
  for (const s of streams) s.end();
  srv.close();
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
