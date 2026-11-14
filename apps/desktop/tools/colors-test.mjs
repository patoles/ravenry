#!/usr/bin/env node
// Colours in Ravenry's terminals, as the shell asks for them
// (0.1.20; 2026-11-08: "there's no colors in Ravenry, links or commands
// are the same as normal text").
//
// A new shell is the account's login shell, interactive, as a terminal
// starts it, here zsh with oh-my-zsh (a copy of ~/.oh-my-zsh in a throwaway
// HOME, its usual .zshrc lines: the robbyrussell theme, the git plugin),
// in a git folder. In it:
//   - printf: red and green (the theme's ANSI colours), colour 208 of the
//     256, and a truecolor one;
//   - ls -G (the alias oh-my-zsh makes): a folder and an executable in
//     their LSCOLORS colours;
//   - the prompt: its green arrow, its cyan folder, its git:(branch).
// Each sample is checked twice: the cell's colour in xterm.js's buffer (what
// the program sent survived the daemon), and the pixels drawn there (the
// renderer drew it in that colour). In a fresh shell, after a tab switch
// (the pane drawn again from the daemon's snapshot), after a relaunch, and
// in the dark and the light theme. Pictures of each.
//
//   node tools/colors-test.mjs [OUT] [--exe APP_EXECUTABLE]
//   (--exe: a packaged app, its test twin; the release check runs it so)
// Needs ~/.oh-my-zsh (only read; its copy is the test's). Without it the
// prompt row says so and the rest still runs.
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
const argv = process.argv.slice(2);
const exeAt = argv.indexOf('--exe');
const EXE = exeAt >= 0 ? path.resolve(argv.splice(exeAt, 2)[1]) : null;
const BIN = path.resolve(process.env.RAVENRYD || (EXE ? path.join(path.dirname(EXE), '..', 'Resources', 'ravenryd') : path.join(APP, '..', '..', 'daemon', 'ravenryd')));
const OUT = path.resolve(argv[0] || path.join(APP, '.tmp', 'colors-test'));
fs.mkdirSync(OUT, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvco-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== '' ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500) : ''}`); if (!ok) fails++; };

// The throwaway HOME: oh-my-zsh (a copy), its usual .zshrc lines, and a git
// folder with a folder and an executable in it.
const OMZ = path.join(os.homedir(), '.oh-my-zsh');
const omz = fs.existsSync(path.join(OMZ, 'oh-my-zsh.sh'));
if (omz) {
  fs.cpSync(OMZ, path.join(home, '.oh-my-zsh'), { recursive: true, filter: (s) => !s.includes(`${path.sep}cache${path.sep}`) && !s.endsWith(`${path.sep}cache`) && !s.includes(`${path.sep}.git${path.sep}`) });
  fs.writeFileSync(path.join(home, '.zshrc'), [
    'export ZSH="$HOME/.oh-my-zsh"', 'ZSH_THEME="robbyrussell"', 'DISABLE_AUTO_UPDATE=true', "zstyle ':omz:update' mode disabled", 'plugins=(git)', 'source $ZSH/oh-my-zsh.sh', '',
  ].join('\n'));
}
const proj = path.join(home, 'projsample');
fs.mkdirSync(path.join(proj, 'dirsample'), { recursive: true });
fs.writeFileSync(path.join(proj, 'exsample'), '#!/bin/sh\n');
fs.chmodSync(path.join(proj, 'exsample'), 0o755);
const genv = { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', proj], { env: genv });

// The board: nothing on it (the shells are what this is about).
let state = { generatedAt: new Date().toISOString(), cmuxOk: true, board: { kind: 'ravenry', name: 'Ravenry', installed: true }, settings: {}, views: {}, homes: { '': home }, checkpoints: [], machines: [], pages: [], sessions: { totalKb: 0, rows: [] }, projects: [] };
const streams = new Set();
const srv = http.createServer((q, r) => {
  if (q.url.startsWith('/api/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(r); r.on('close', () => streams.delete(r)); r.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); return; }
  if (q.url.startsWith('/api/state')) { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(hubState(state))); return; }
  r.writeHead(404, { 'Content-Type': 'application/json' }); r.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tick = setInterval(() => { state = { ...state, generatedAt: new Date().toISOString() }; for (const s of streams) s.write(`event: state\ndata: ${JSON.stringify(hubState(state))}\n\n`); }, 1000);
const hubUrl = `http://127.0.0.1:${srv.address().port}`;

const R = 'window.__ravenry';
const T = `${R}.term()`;
const SCREEN = `(() => { const b = ${T}.term.buffer.active; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y).translateToString(true)); return out.join('\\n'); })()`;
const TRUE = [120, 80, 255];
// What each sample is, and the colour it must be: a theme key (one of
// several: bold text may take the bright one), or [r, g, b].
const SAMPLES = [
  ['red', 'REDSAMPLE', ['red', 'brightRed']],
  ['green', 'GREENSAMPLE', ['green', 'brightGreen']],
  ['256-colour 208', 'C208SAMPLE', [[0xff, 0x87, 0x00]]],
  ['truecolor', 'TRUESAMPLE', [TRUE]],
  ['an OSC 8 link as Claude Code prints it (bright blue)', 'LINKSAMPLE', ['brightBlue', 'blue']],
  ['ls -G: a folder', 'dirsample', ['cyan', 'brightCyan']],
  ['ls -G: an executable', 'exsample', ['red', 'brightRed']],
  ...(omz ? [['the prompt: its folder', 'projsample', ['cyan', 'brightCyan']], ['the prompt: git:(', 'git:(', ['blue', 'brightBlue']]] : []),
];
const PRINT = `printf '\\033[31mREDSAMPLE\\033[0m \\033[32mGREENSAMPLE\\033[0m \\033[38;5;208mC208SAMPLE\\033[0m \\033[38;2;${TRUE.join(';')}mTRUESAMPLE\\033[0m \\033]8;;https://example.com/x\\007\\033[94mLINKSAMPLE\\033[39m\\033]8;;\\007\\n'; ls\r`;

// For each sample: where its first cell is in the window (CSS pixels), what
// the buffer says of its colour, and the colours it may be drawn in.
const PROBE = `(() => {
  const t = ${T}.term; const b = t.buffer.active; const th = t.options.theme || {};
  const scr = document.querySelector('.term-host .xterm-screen').getBoundingClientRect(); const cw = scr.width / t.cols, ch = scr.height / t.rows;
  const hex = (s) => { const m = /^#?([0-9a-f]{6})/i.exec(s || ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const out = {};
  for (const [name, text, want] of ${JSON.stringify(SAMPLES)}) {
    let found = null;
    for (let y = b.length - 1; y >= 0 && !found; y--) { const l = b.getLine(y); const x = l ? l.translateToString(true).lastIndexOf(text) : -1; if (x >= 0) found = { x, y, l }; }
    if (!found) { out[name] = { missing: true }; continue; }
    const c = found.l.getCell(found.x);
    const mode = c.isFgRGB() ? 'rgb' : c.isFgPalette() ? 'palette' : 'default';
    const vy = found.y - b.viewportY;
    out[name] = { mode, fg: c.getFgColor(), bold: !!c.isBold(),
      box: vy >= 0 && vy < t.rows ? { x: Math.floor(scr.left + found.x * cw), y: Math.floor(scr.top + vy * ch), w: Math.ceil(cw * Math.min(text.length, 6)), h: Math.ceil(ch) } : null,
      want: want.map((w) => typeof w === 'string' ? hex(th[w]) : w).filter(Boolean) };
  }
  return out;
})()`;
// The pixels: in each sample's box, the pixel nearest one of its colours.
const PIXELS = (out) => `
  const probe = await win.webContents.executeJavaScript(${JSON.stringify(PROBE)});
  const img = await win.webContents.capturePage();
  const scale = img.getSize().width / win.getContentBounds().width;
  const bmp = img.toBitmap(); const W = img.getSize().width;
  for (const k of Object.keys(probe)) {
    const p = probe[k]; if (!p.box) continue;
    let best = 1e9, at = null;
    for (let y = Math.floor(p.box.y * scale); y < (p.box.y + p.box.h) * scale; y++) for (let x = Math.floor(p.box.x * scale); x < (p.box.x + p.box.w) * scale; x++) {
      const i = (y * W + x) * 4; const px = [bmp[i + 2], bmp[i + 1], bmp[i]];
      for (const w of p.want) { const d = Math.hypot(px[0] - w[0], px[1] - w[1], px[2] - w[2]); if (d < best) { best = d; at = px; } }
    }
    p.nearest = Math.round(best); p.pixel = at;
  }
  require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(probe, null, 2));
  return probe;`;
const probeSteps = (name) => [{ sleep: 400 }, { main: PIXELS(path.join(work, `${name}.json`)) }, { shot: path.join(OUT, `colors-${name}.png`) }];
const ENVF = path.join(home, 'shell-env.txt');
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(work, `${name}.json`), 'utf8')); } catch { return null; } };
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0' };
// The same shell as a terminal starts: the account's login shell (no RAVENRY_NEW_SHELL).
const run = (name, steps) => runApp({ name, work, rt, bin: EXE ? undefined : BIN, exe: EXE || undefined, home, hubUrl, env, shell: '', width: 1200, height: 760, steps });
// A wait for the prompt: oh-my-zsh's arrow, or a plain shell's % or $.
const PROMPT = `/➜ |[%$#] *$/m.test(${SCREEN}.trimEnd())`;

function judge(label, p) {
  if (!p) { check(`${label}: the app answered`, false); return; }
  for (const [name] of SAMPLES) {
    const s = p[name] || {};
    const sent = !s.missing && s.mode !== 'default';
    const drawn = sent && s.nearest !== undefined && s.nearest < 70;
    check(`${label}: ${name} is in colour, in the buffer and on screen`, sent && drawn, { mode: s.mode, fg: s.fg, nearest: s.nearest, pixel: s.pixel, want: s.want, missing: !!s.missing });
  }
}

try {
  await run('first', [
    { ready: true },
    { until: `${T}.attached && ${T}.ready`, timeout: 20000 },
    { until: PROMPT, timeout: 20000 },
    { js: `${T}.focus()` },
    { type: `cd ${proj} && clear\r`, after: 600 },
    { until: PROMPT, timeout: 10000 },
    { type: `echo "TERM=$TERM COLORTERM=$COLORTERM FORCE_HYPERLINK=$FORCE_HYPERLINK LSCOLORS=$LSCOLORS login=$([[ -o login ]] && echo yes) interactive=$([[ -o interactive ]] && echo yes) ls=$(alias ls)" > ${ENVF} && clear\r`, after: 600 },
    { until: PROMPT, timeout: 10000 },
    { type: PRINT, after: 800 },
    { until: `${SCREEN}.includes('TRUESAMPLE') && ${SCREEN}.includes('exsample')`, timeout: 10000 },
    ...probeSteps('fresh-dark'),
    // A tab switch: another shell in front, then this one, drawn again from the daemon.
    { js: `${R}.newShell()` },
    { until: `${R}.S.tabs.length === 2 && ${T}.attached && ${T}.ready`, timeout: 10000 },
    { sleep: 600 },
    { click: `#tabs .tabrow > .tab[data-tab]` },
    { until: `${SCREEN}.includes('TRUESAMPLE')`, timeout: 10000 },
    ...probeSteps('switch-dark'),
    { theme: 'light', after: 800 },
    ...probeSteps('switch-light'),
    { theme: 'dark', after: 500 },
  ]);
  let envLine = '';
  try { envLine = fs.readFileSync(ENVF, 'utf8').trim(); } catch { /* below */ }
  console.log(`  the shell said: ${envLine}`);
  check('a new shell is a login shell, interactive, with TERM=xterm-256color, COLORTERM=truecolor and FORCE_HYPERLINK=1 (its links are drawn: Claude Code then prints them as links, in colour)', /TERM=xterm-256color COLORTERM=truecolor FORCE_HYPERLINK=1 /.test(envLine) && /login=yes interactive=yes/.test(envLine), envLine);
  if (omz) check('oh-my-zsh ran: ls is its alias with -G, LSCOLORS is set', /ls=ls='ls -G'/.test(envLine) && /LSCOLORS=\S+/.test(envLine), envLine);
  else console.log('  (no ~/.oh-my-zsh here: the prompt rows are not run)');
  judge('a fresh shell, dark', read('fresh-dark'));
  judge('after a tab switch, dark', read('switch-dark'));
  judge('after a tab switch, light', read('switch-light'));

  // Relaunched: the shell comes back, drawn from the daemon's snapshot.
  await run('second', [
    { ready: true },
    { until: `${T}.attached && ${T}.ready && ${SCREEN}.includes('TRUESAMPLE')`, timeout: 20000 },
    { click: `#tabs .tabrow > .tab[data-tab]` },
    { until: `${SCREEN}.includes('TRUESAMPLE')`, timeout: 10000 },
    ...probeSteps('relaunch-dark'),
    { theme: 'light', after: 800 },
    ...probeSteps('relaunch-light'),
  ]);
  judge('after a relaunch, dark', read('relaunch-dark'));
  judge('after a relaunch, light', read('relaunch-light'));
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

function save(name, expr) { return { save: { expr, out: path.join(work, `${name}.json`) } }; }
