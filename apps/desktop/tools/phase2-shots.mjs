#!/usr/bin/env node
// Screenshots of the Phase 2 screens, never on screen, from real panes:
// a demo board (demo-hub.mjs) and this machine's ravenryd in a throwaway
// HOME, with two stand-in agents that act through ravenryd and the board
// as Claude Code and Codex would, and the shells they drive. Nothing runs
// an assistant: the agents are "puppets", shell loops that run the steps
// this script hands them (a file each) and print a screen like theirs.
//
//   node build.mjs && node tools/phase2-shots.mjs <outDir>
//
// Each frame is shot in dark and light (driver.cjs "theme"), at 1440x900,
// as <outDir>/<frame>-dark.png and -light.png:
//   6-drive-close     an agent asks to close a pane it did not start
//   6a-drive-type     an agent asks to type into the person's dev server
//   6bc-dev-server    what it typed, tinted in the terminal; the pane's
//                     panel with Who can type here and Typed here
//   19a-session       Files it changed (a clash in orange), Panes it uses,
//                     and the sidebar's Using and Waiting lines
//   19-pane-strip     who has the lent pane and who waits, on the pane
//   19-grid           who changed what in the project
//   31a-decisions     the Decisions page, a decision that replaced one,
//                     and the toast with Undo
//   31c-question      a question card with Checked your decisions first
//   16b-filmstrip     the filmstrip sheet, a frame shown in the pane
//   32c-pick-card     a pick in the panel
//   32a-picker        side by side, a part circled with its note
//   33a-new-session   a new session decides on its own copy, and says why
//   33-review-card    done and asks for a review, and Its copy
//   33b-review        the Review tab, line comments
//   33d-after-merge   merged, with Undo the merge
//
// Needs ravenryd: RAVENRYD, else ../../daemon/ravenryd.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startDemoHub } from './demo-hub.mjs';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'phase2-shots'));
const ONLY = process.env.PHASE2_ONLY ? new Set(process.env.PHASE2_ONLY.split(',')) : null;
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const tmp = (p) => { const d = fs.mkdtempSync(path.join(SHORT, p)); fs.chmodSync(d, 0o700); return d; };
const WORK = tmp('rv2w-');
const RT = tmp('rv2r-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------ stand-ins
const STAND = path.join(WORK, 'standin');
fs.mkdirSync(STAND, { recursive: true });
const script = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
fs.symlinkSync(BIN, path.join(STAND, 'ravenryd'));
fs.symlinkSync(BIN, path.join(STAND, 'ravenry'));
// The board's stand-in cmux runs on node; nothing else of this machine's tools is on the PATH.
fs.symlinkSync(process.execPath, path.join(STAND, 'node'));
// npm run dev: a dev server's screen, Shortcuts on h.
script(STAND, 'npm', `
G='\\033[32m'; B='\\033[36m'; D='\\033[2m'; W='\\033[1m'; R='\\033[0m'
case "$*" in
  *--host*) NET="\${B}http://192.168.1.24:5173/\${R}"; MS=398 ;;
  *) NET="\${D}use \${R}\${W}--host\${R}\${D} to expose\${R}"; MS=412 ;;
esac
printf "\\n  \${G}\${W}VITE\${R} \${G}v6.0.3\${R}  \${D}ready in\${R} \${W}%s\${R} ms\\n\\n" "$MS"
printf "  \${G}➜\${R}  \${W}Local\${R}:   \${B}http://localhost:5173/\${R}\\n"
printf "  \${G}➜\${R}  \${D}Network\${R}: %b\\n" "$NET"
[ -z "\${NOHMR:-}" ] && printf "\${D}%s\${R} \${B}[vite]\${R} \${G}hmr update\${R} \${D}/src/boat/hull.ts\${R}\\n" "$(date +%H:%M:%S)"
while IFS= read -r l; do
  case "$l" in
    h) printf "\\n  \${W}Shortcuts\${R}\\n  \${D}press\${R} \${W}r + enter\${R} \${D}to restart the server\${R}\\n  \${D}press\${R} \${W}o + enter\${R} \${D}to open in browser\${R}\\n  \${D}press\${R} \${W}q + enter\${R} \${D}to quit\${R}\\n" ;;
    q) exit 0 ;;
  esac
done`);
// A text interface that flickers: a menu, a blank screen, a half drawn
// menu, progress, and a stall.
const TUI = script(STAND, 'tui-demo', `
E='\\033['; D='\\033[2m'; B='\\033[34m'; R='\\033[0m'
head() { printf "\${E}2;3Htrail-map   \${D}offline tiles\${R}\${E}2;50Hv0.4.1"; }
menu() { printf "\${E}4;3H┌──────────────────────────────────┐\${E}5;3H│ \${B}▸ Download a region\${R}               │\${E}6;3H│   Update saved maps               │\${E}7;3H└──────────────────────────────────┘\${E}9;3H\${D}↑↓ move   ⏎ pick\${R}"; }
half() { printf "\${E}4;3H┌──────────────────────────────────┐\${E}5;3H│ \${B}▸ Download a region\${R}"; }
bar() { n=$1; f=$(printf '%*s' $((n/4)) '' | tr ' ' '█'); e=$(printf '%*s' $((25-n/4)) '' | tr ' ' '░'); printf "\${E}4;3HDownloading Cairngorms, zoom 10 to 15\${E}6;3H⠋ %3s%%  %s%s\${E}8;3H\${D}%s of 1,972 tiles\${R}\${E}10;3H\${D}esc cancel\${R}" "$n" "$f" "$e" "$((n*1972/100))"; }
printf '\\033[?25l'
while :; do
  printf '\\033[2J'; head; menu; sleep 1.6
  printf '\\033[2J'; sleep 0.7
  head; half; sleep 0.06; menu; sleep 1.2
  printf '\\033[2J'; head
  for n in 12 24 37 49 61; do bar $n; sleep 0.9; done
  sleep 9
  printf '\\033[2J'; head; half; sleep 0.05; menu; sleep 2
done`);
// The puppet: runs the steps handed to it, one file each, in order.
const puppet = (name) => script(STAND, name, `
Q="${WORK}/q-${name}"; mkdir -p "$Q"; i=1
while :; do
  while [ ! -f "$Q/$i.sh" ]; do sleep 0.1; done
  . "$Q/$i.sh"
  : > "$Q/$i.done"; i=$((i+1))
done`);
puppet('claude-puppet');
puppet('codex');
fs.writeFileSync(path.join(STAND, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const C = { dim: '\\033[2m', w: '\\033[1m', g: '\\033[32m', y: '\\033[33m', o: '\\033[38;5;173m', box: '\\033[48;5;236m', r: '\\033[0m' };
let seq = { 'claude-puppet': 0, codex: 0 };
/** Hands a puppet a step; with wait, resolves when it ran. */
async function step(who, body, { wait = true, timeout = 60000 } = {}) {
  const n = ++seq[who];
  const q = path.join(WORK, `q-${who}`);
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, `${n}.sh`), body + '\n');
  if (!wait) return n;
  const t0 = Date.now();
  while (!fs.existsSync(path.join(q, `${n}.done`))) { if (Date.now() - t0 > timeout) throw new Error(`${who} step ${n} did not finish:\n${body}`); await sleep(100); }
  return n;
}
const done = async (who, n, timeout = 60000) => { const t0 = Date.now(); while (!fs.existsSync(path.join(WORK, `q-${who}`, `${n}.done`))) { if (Date.now() - t0 > timeout) throw new Error(`${who} step ${n} never finished`); await sleep(100); } };
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const say = (text) => `printf '%b' ${q(text)}`;

// ------------------------------------------------ the demo
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const todayAt = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() > Date.now() ? Date.now() - 3600000 : d.getTime(); };
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const OLD = 'dk3hullz';
function decisionsFile() {
  const now = Date.now();
  const t3 = now - 3 * DAY;
  const old = new Date(t3); old.setHours(21, 10, 0, 0);
  const at = (h, m, back = 0) => { const d = new Date(now - back); d.setHours(h, m, 0, 0); return Math.min(d.getTime(), now - 60000 * (5 + h)); };
  return { version: 1, decisions: [
    { id: OLD, quote: 'Keep the hull level, always. Tilting makes people seasick.', at: iso(old.getTime()), project: 'paper-boat', scope: 'hull tilt', overrides: [], by: 'agent', recorded_by: { pane: 'pzzzzzz2', session: 'b2b2b2b2-0000-4000-8000-000000000002', assistant: 'claude' }, reads: { [dayKey(now - DAY)]: 4 }, last_read_at: iso(now - DAY) },
    { id: 'dpalet3e', quote: 'Keep the dusk palette for waves.', at: iso(at(19, 40, 5 * DAY)), project: 'paper-boat', overrides: [], by: 'agent', recorded_by: { session: 'b2b2b2b2-0000-4000-8000-000000000002', assistant: 'claude' }, reads: { [dayKey(now - 4 * DAY)]: 2 }, last_read_at: iso(now - 4 * DAY) },
    { id: 'dtest5fr', quote: 'Testers get builds on Fridays only, never mid-week.', at: iso(at(18, 22, 3 * DAY)), project: 'notes-app', overrides: [], by: 'agent', recorded_by: { session: 'c3c3c3c3-0000-4000-8000-000000000003', assistant: 'claude' }, reads: { [dayKey(now - 2 * DAY)]: 3 }, last_read_at: iso(now - 2 * DAY) },
    { id: 'dphone2a', quote: 'Phone alerts only for questions and approvals. Finished work can wait for the board.', at: iso(at(16, 5)), project: 'garden-planner', overrides: [], by: 'agent', recorded_by: { session: 'a1a1a1a1-0000-4000-8000-000000000001', assistant: 'claude' }, reads: { [dayKey(now)]: 2 }, last_read_at: iso(now - 30 * 60000) },
    { id: 'dpush3me', quote: 'Push and publish stay with me. Never run them on your own.', at: iso(at(17, 33)), project: null, overrides: [], by: 'agent', recorded_by: { session: 'd4d4d4d4-0000-4000-8000-000000000004', assistant: 'codex' }, reads: { [dayKey(now)]: 5 }, last_read_at: iso(now - 20 * 60000) },
  ] };
}
// Three pictures of a paper boat on a wave, for the pick.
function boat(kind) {
  const tilt = kind === 'a' ? 0 : kind === 'b' ? -28 : -14;
  const spray = kind === 'b' ? 7 : kind === 'c' ? 3 : 0;
  const dots = Array.from({ length: spray }, (_, i) => `<circle cx="${560 + (i % 4) * 14 - 10}" cy="${190 - Math.floor(i / 4) * 16 - (i % 3) * 6}" r="${4 + (i % 3)}" fill="#F4ECE6" opacity=".9"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4E5A86"/><stop offset=".55" stop-color="#C98A88"/><stop offset="1" stop-color="#E7B48E"/></linearGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3E7FA0"/><stop offset="1" stop-color="#1D4466"/></linearGradient></defs>
<rect width="960" height="600" fill="url(#s)"/><circle cx="760" cy="210" r="56" fill="#F6D3A6"/>
<path d="M0 420 C160 380 260 400 360 410 C440 300 520 230 600 240 C700 255 760 330 820 400 C880 420 920 425 960 430 L960 600 L0 600 Z" fill="#6E6F99" opacity=".55"/>
<path d="M0 470 C120 450 220 440 320 430 C420 330 520 250 590 255 C680 262 760 380 840 440 C890 470 930 478 960 480 L960 600 L0 600 Z" fill="url(#w)"/>
<path d="M200 470 C300 445 380 430 440 380" stroke="#E8F0F6" stroke-width="4" fill="none" opacity=".8"/>
<g transform="translate(520 300) rotate(${tilt})"><path d="M-80 0 L80 0 L58 26 L-58 26 Z" fill="#F2EEE8"/><path d="M-6 0 L-6 -92 L52 0 Z" fill="#FBF8F3"/><path d="M-6 -92 L-50 0 L-6 0 Z" fill="#E6E0D7"/></g>
${dots}</svg>`;
}

let hub;
const steps = [];
const R = 'window.__ravenry';
const shot = (name) => {
  if (ONLY && !ONLY.has(name)) return [];
  return [
    { theme: 'dark' }, { js: 'void 0' }, { shot: path.join(OUT, `${name}-dark.png`), settle: 400 },
    { theme: 'light' }, { shot: path.join(OUT, `${name}-light.png`), settle: 400 },
    { theme: 'dark' },
  ];
};
const sig = (n) => path.join(WORK, `${n}.signal`);
const go = (n) => path.join(WORK, `${n}.go`);
/** The app waits here while this script acts: it signals, then waits for go. */
const pause = (n) => [{ signal: sig(n) }, { wait: go(n), timeout: 120000 }];
const at = async (n) => { const t0 = Date.now(); while (!fs.existsSync(sig(n))) { if (Date.now() - t0 > 240000) throw new Error(`the app never reached ${n}`); await sleep(100); } };
const resume = (n) => fs.writeFileSync(go(n), '1');
const click = (sel, text) => ({ js: `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); })()` });
const until = (expr, timeout = 30000) => ({ until: expr, timeout });
const cardKind = (kind) => until(`(() => { const e = document.querySelector('#panel .cp[data-cp]:not(.after)'); return e && ${R}.S.cps.get(e.dataset.cp) && ${R}.S.cps.get(e.dataset.cp).cp.kind === ${JSON.stringify(kind)}; })()`);
const KEY_CLAUDE = `(() => { for (const p of ${R}.S.hub.projects) for (const s of p.sessions) if ((s.topic || '').includes('Tilting')) return p.id + '/' + s.surfaceId; })()`;
const KEY_CODEX = `(() => { for (const p of ${R}.S.hub.projects) for (const s of p.sessions) if ((s.topic || '').includes('Harbour')) return p.id + '/' + s.surfaceId; })()`;
const tabOf = (name) => `${R}.S.tabs.find((t) => t.kind === 'shell' && document.querySelector('#tabs') && (t.title === ${JSON.stringify(name)} || ${R}.store.get(t.pane)?.pane.name === ${JSON.stringify(name)}))`;
const showTab = (name) => [until(`!!${tabOf(name)}`), { js: `${R}.setView({ kind: 'tab', id: ${tabOf(name)}.id })` }, { sleep: 700 }];

try {
  // This machine's daemon, with the stand-ins on its PATH.
  const HOME0 = path.join(WORK, 'daemon-home');
  fs.mkdirSync(HOME0, { recursive: true });
  // PS1: a shell's own prompt would name this machine and its user.
  // The login shell of panes the board starts: zsh without rc files, so
  // /etc's prompt (the machine's and the user's names) never shows.
  const LOGIN = script(STAND, 'login-shell', `PS1='you@mac %1~ %# ' exec /bin/zsh -f "$@"`);
  const local = { HOME: HOME0, PATH: `${STAND}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: LOGIN, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', PS1: 'you@mac %1~ %# ', RAVENRY_PANE_PASS: 'PS1', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') };
  execFileSync(BIN, ['serve', '--detach'], { env: local });
  const port = await freePort();
  hub = await startDemoHub({
    dir: path.join(WORK, 'demo'), port, runtime: RT, alerts: true, panes: ['paper-boat'],
    env: { PATH: `${STAND}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: path.join(STAND, 'login-shell'), PS1: 'you@mac %1~ %# ', MC_NO_EVENTS: '0', RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state') },
    prepare: ({ HOME, ROOT, MC }) => {
      const pb = path.join(ROOT, 'paper-boat');
      const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(pb, rel)), { recursive: true }); fs.writeFileSync(path.join(pb, rel), text); };
      w('src/boat/physics.ts', 'export const GRAVITY = 9.8;\n\nexport function tiltOf(slope: number): number {\n  return 0;\n}\n\nexport function drag(speed: number): number {\n  return speed * 0.02;\n}\n');
      w('src/boat/hull.ts', 'import { tiltOf } from "./physics";\n\nexport class Hull {\n  angle = 0;\n  update(slope: number) {\n    this.angle = tiltOf(slope);\n  }\n}\n');
      w('src/levels/harbour.ts', 'export const buoys = [\n  { x: 120, y: 40, size: 1.2 },\n  { x: 180, y: 52, size: 1.2, bob: 0.8 },\n];\n\nexport function buildWall(level) {\n  const length = 9;\n  for (let i = 0; i < length; i++) {\n    level.place("wall", 4 + i, 14);\n  }\n}\n');
      w('src/boat/spray.ts', 'export const SPRAY = 3;\n');
      execFileSync('git', ['-C', pb, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', pb, '-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', 'The boat and the harbour'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(MC, 'decisions.json'), JSON.stringify(decisionsFile(), null, 2), { mode: 0o600 });
      // The stand-in Codex draws no screen the board knows as a live Codex: let
      // review comments be typed into it all the same (a test registry's switch).
      const reg = JSON.parse(fs.readFileSync(path.join(MC, 'projects.json'), 'utf8'));
      reg.projects.find((p) => p.id === 'paper-boat').sendToAnySurface = true;
      fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify(reg, null, 2));
      fs.writeFileSync(path.join(HOME, '.claude.json'), '{"oauthAccount":{}}');
      fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(HOME, '.codex', 'auth.json'), '{}');
      for (const k of ['a', 'b', 'c']) fs.writeFileSync(path.join(HOME, `tilt-${k}.svg`), boat(k));
    },
  });
  const PB = hub.sessions['paper-boat'];
  const env = { ...local, HOME: hub.home, RAVENRY_HUB_URL: hub.url };
  const rv = (...a) => execFileSync(BIN, a, { env, encoding: 'utf8' }).trim();
  // The person's shells: the dev server and a preview, labelled as the app's shells.
  const dev = rv('new', '--cwd', PB.folder, '--name', 'dev server', '--size', '110x34', '--label', 'ravenry.kind=shell', '--env', 'PS1=%F{green}you@mac%f %F{blue}%1~%f %# ', '--env', 'NOHMR=', '--', '/bin/zsh', '-f');
  const preview = rv('new', '--cwd', PB.folder, '--name', 'preview', '--size', '110x34', '--label', 'ravenry.kind=shell', '--', '/bin/sh', '-c', 'echo "Serving the build on http://localhost:4173/"; exec sleep 100000');
  // Claude in "Tilting the hull": reports through ravenryd hook, as a session the board started.
  // The folder each session works in, as the board knows it (a pane's $PWD can be the /private/var form of it).
  const cwdOf = { claude: PB.folder, codex: null };
  const hook = (assistant, sid, ev, extra = {}) => `printf '%s' ${q(JSON.stringify({ hook_event_name: ev, session_id: sid, cwd: cwdOf[assistant], transcript_path: assistant === 'claude' ? PB.transcript : `${cwdOf.codex}/.no-transcript.jsonl`, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : ev === 'UserPromptSubmit' ? { prompt: '' } : {}), ...extra }))} | ravenryd hook --assistant ${assistant} >/dev/null 2>&1`;
  const claude = rv('new', '--cwd', PB.folder, '--name', 'Tilting the hull', '--size', '110x34', '--label', 'ravenry.session=claude', '--env', `RAVENRY_HUB_URL=${hub.url}`, '--', '/bin/sh', path.join(STAND, 'claude-puppet'));
  await step('claude-puppet', [hook('claude', PB.sid, 'SessionStart'), hook('claude', PB.sid, 'UserPromptSubmit'), `printf '\\033]0;⠂ Tilting the hull\\007'`,
    say(`${C.box} > Make the hull tilt with the slope on steep waves, then let me check it on my phone ${C.r}\\n\\n`)].join('\n'));
  // Codex in "Harbour level", in its own copy of the code: started by the board.
  const st = await (await fetch(hub.url + '/api/sessions/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ projectId: 'paper-boat', assistant: 'codex', worktree: true, name: 'Harbour level', cols: 110, rows: 34 }) })).json();
  if (!st.ok) throw new Error(`the worktree session did not start: ${JSON.stringify(st)}`);
  const CX = 'e7e7e7e7-0000-4000-8000-000000000007';
  const WT = st.worktree.folder;
  cwdOf.codex = WT;
  await step('codex', [hook('codex', CX, 'SessionStart'), hook('codex', CX, 'UserPromptSubmit'), `printf '\\033]0;Harbour level\\007'`,
    say(`${C.dim}›${C.r} Make the buoys in the harbour bob slower, and shorten the wall\\n\\n`),
    `ravenryd new --name tui --size 70x14 --label ravenry.kind=shell -- /bin/sh ${q(TUI)} >/dev/null`].join('\n'));

  // The app: first the person starts the dev server in its shell.
  steps.push({ ready: true },
    until(`${R}.S.hub && ${R}.S.hub.projects.some((p) => p.sessions.some((s) => (s.topic || '').includes('Tilting'))) && ${R}.S.hub.projects.some((p) => p.sessions.some((s) => (s.topic || '').includes('Harbour')))`, 60000),
    ...showTab('dev server'), { type: 'npm run dev\r', after: 1200 },
    ...pause('typed'));

  // 6: close, then type.
  steps.push(until(`${R}.S.cps.open().some((k) => k.cp.kind === 'drive' && k.cp.drive.action === 'close')`, 30000),
    { js: `${R}.pickSession(${KEY_CLAUDE})` }, cardKind('drive'), { sleep: 400 }, ...shot('6-drive-close'),
    click('#panel .cp button', 'Refuse'), until(`!${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`),
    ...pause('closed'),
    until(`${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`), { js: `${R}.pickSession(${KEY_CLAUDE})` }, cardKind('drive'), { sleep: 400 }, ...shot('6a-drive-type'),
    click('#panel .cp button', 'Let it type this'), until(`!${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`),
    // The person is done with the preview: its tab closes, and the pane with it.
    { js: `${R}.S.tabs.filter((t) => t.kind === 'shell' && ${R}.store.get(t.pane)?.pane.name === 'preview').forEach((t) => document.querySelector('#tabs .tab[title^="preview"] .x')?.click())` },
    ...pause('typed-in'),
    // Codex asks to press Enter there once: let it for its session.
    until(`${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`), { js: `${R}.pickSession(${KEY_CODEX})` }, cardKind('drive'),
    click('#panel .cp button', 'Let it use this pane'), until(`!${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`),
    ...showTab('dev server'), { type: 'h\r', after: 1500 },
    { sleep: 2500 }, until(`${R}.marks().marked.length >= 1`, 15000), { sleep: 500 }, ...shot('6bc-dev-server'),
    ...pause('marked'));

  // 19: the lease, the queue, the files.
  steps.push(until(`${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`), { js: `${R}.pickSession(${KEY_CLAUDE})` }, cardKind('drive'),
    click('#panel .cp button', 'Let it use this pane'), until(`!${R}.S.cps.open().some((k) => k.cp.kind === 'drive')`),
    ...pause('leased'),
    until(`[...${R}.store.panes.values()].some((k) => k.pane.lease && (k.pane.lease.waiting || []).length)`, 30000),
    { js: `${R}.pickSession(${KEY_CLAUDE})` }, until(`document.querySelector('#panel .fc-r.clash') && document.querySelector('#panel .pu-w')`, 30000), { sleep: 600 }, ...shot('19a-session'),
    ...showTab('dev server'), until(`!document.getElementById('lstrip').hidden`), { sleep: 400 }, ...shot('19-pane-strip'),
    { js: `${R}.pickSession(${KEY_CLAUDE})` }, until(`document.querySelector('#panel .fch')`), click('#panel .lk', 'See all of'), until(`!document.getElementById('grid').hidden && document.querySelector('.fgrid')`), { sleep: 400 }, ...shot('19-grid'),
    { js: `${R}.pickSession(${KEY_CLAUDE})` });

  // 33 A: a new session in a folder where one works already.
  steps.push({ js: `${R}.onCommand('new-session')` }, until(`document.querySelector('.fl-card')`),
    { js: `(() => { const st = ${R}.S.start; st.folder = ${JSON.stringify(PB.folder)}; st.assistant = 'codex'; ${R}.render(); })()` },
    until(`document.querySelector('.fl-why')`, 20000), { js: `${R}.S.setup = null; ${R}.S.setupAsked = { claude: true, codex: true }; ${R}.render()` }, { sleep: 300 }, ...shot('33a-new-session'),
    { js: `${R}.pickSession(${KEY_CLAUDE})` });

  // 31: a decision that replaces one, then a question that checked them.
  steps.push({ js: `${R}.setView({ kind: 'decisions' })` }, until(`document.querySelector('.dcard')`), ...pause('decide'),
    until(`!document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('Decision')`, 20000), { sleep: 300 }, ...shot('31a-decisions'),
    ...pause('ask'), { js: `${R}.pickSession(${KEY_CLAUDE})` }, cardKind('ask'), until(`document.querySelector('#panel .chkd')`, 20000), { sleep: 300 }, ...shot('31c-question'),
    click('#panel .cp button', 'A little'), until(`!${R}.S.cps.open().some((k) => k.cp.kind === 'ask' && k.cp.projectId === 'paper-boat')`));

  // 16 B: the filmstrip of Codex's text interface.
  steps.push(...showTab('tui'), { sleep: 21000 }, { js: `document.querySelector('#tabs button[aria-label="Filmstrip"]').click()` },
    until(`${R}.film().frames.length > 4`, 20000),
    { js: `(() => { const f = ${R}.film(); const i = f.frames.findIndex((x) => x.tag === 'half' && x.box); f.showFrame(i >= 0 ? i : Math.floor(f.frames.length / 2)); })()` }, { sleep: 500 }, ...shot('16b-filmstrip'),
    { js: `${R}.film().close()` });

  // 32: a pick.
  steps.push(...pause('pick'), { js: `${R}.pickSession(${KEY_CLAUDE})` }, cardKind('pick'), until(`[...document.querySelectorAll('#panel .ptile img')].every((i) => i.complete && i.naturalWidth > 0)`, 20000), { sleep: 300 }, ...shot('32c-pick-card'),
    click('#panel .cp button', 'Open side by side'), until(`!document.getElementById('picker').hidden && [...document.querySelectorAll('#picker img')].every((i) => i.complete && i.naturalWidth > 0)`, 20000),
    { js: `${R}.picker().circle(1, { x: 0.52, y: 0.22, w: 0.2, h: 0.18 }, 'This, but less spray at the bow. It hides the boat.')` }, { sleep: 300 }, ...shot('32a-picker'),
    click('#picker button', 'Send B'), until(`document.getElementById('picker').hidden`), ...pause('picked'));

  // 33: Codex gets the dev server, finishes, asks for a review; the merge.
  steps.push(...showTab('dev server'), until(`!document.getElementById('lstrip').hidden`), click('#lstrip button', 'Hand it to'), ...pause('handed'),
    { js: `${R}.pickSession(${KEY_CODEX})` }, until(`[...document.querySelectorAll('#panel .cp-h')].some((e) => e.textContent.includes('asks for a review'))`, 40000), { sleep: 500 }, ...shot('33-review-card'),
    click('#panel .cp button', 'Review'), until(`!document.getElementById('review').hidden && document.querySelector('.rv-f')`, 20000),
    ...pause('comments'),
    click('.rv-f', 'harbour'), until(`document.querySelectorAll('.cth .c').length >= 3`, 20000), { sleep: 500 }, ...shot('33b-review'),
    click('#centre .rv-h button', 'Merge into'), until(`[...document.querySelectorAll('#panel .cp-h')].some((e) => e.textContent.includes('Merged into'))`, 30000), { sleep: 400 }, ...shot('33d-after-merge'),
    { save: { expr: `({ cps: [...${R}.S.cps.items.values()].map((k) => k.cp), page: document.body.innerText.slice(0, 2000) })`, out: path.join(WORK, 'after.json') } });

  // The tab strip with 3, 6 and 10 tabs: second lines go first, then it scrolls; no name is cut.
  const tabsShot = (n) => [
    until(`${R}.S.tabs.length >= ${n}`, 20000), { sleep: 600 },
    { save: { expr: `[...document.querySelectorAll('#tabs .tab .n')].map((e) => [e.textContent, e.scrollWidth > e.clientWidth + 1])`, out: path.join(WORK, `tabs-${n}.json`) } },
    ...shot(`tabs-${n}`),
  ];
  steps.push(...showTab('dev server'), ...tabsShot(3),
    { js: `(async () => { for (let i = 0; i < 3; i++) await ${R}.newShell(); })()` }, ...tabsShot(6),
    { js: `(async () => { for (let i = 0; i < 4; i++) await ${R}.newShell(); })()` }, ...tabsShot(10));

  const app = runApp({ name: 'phase2', work: WORK, rt: RT, bin: BIN, home: hub.home, hubUrl: hub.url, steps, timeoutMs: 600000, env: { RAVENRY_SERVICE: 'off', PATH: `${STAND}:/usr/bin:/bin:/usr/sbin:/sbin` } });

  const script2 = (async () => {
    await at('typed');
    // 6: Claude asks to close the preview, is refused, then asks to type.
    const nClose = await step('claude-puppet', [
      say(`${C.g}⏺${C.r} ${C.w}Update${C.r}(src/boat/hull.ts)\\n${C.dim}  ⎿  Updated src/boat/hull.ts with 12 additions and 3 removals${C.r}\\n\\n${C.g}⏺${C.r} ${C.w}Bash${C.r}(npm test -- boat)\\n${C.dim}  ⎿  ${C.r}${C.g}PASS${C.r}${C.dim}  22 tests, 1.8 s${C.r}\\n\\n`),
      `ravenryd close ${preview} --reason 'The preview is an old build; the dev server replaces it.' >/dev/null 2>&1 || ${say(`${C.y}⏺${C.r} You kept the preview open. Leaving it.\\n\\n`)}`,
    ].join('\n'), { wait: false });
    resume('typed');
    await at('closed');
    await done('claude-puppet', nClose);
    const nType = await step('claude-puppet', [
      say(`⏺ The tilt works. Your phone can't open the game yet: the dev server only\\n  listens on this Mac. It runs in your "dev server" pane, which I didn't open,\\n  so I'm asking before I type there.\\n\\n${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry send "dev server" --key Ctrl+C --typed "npm run dev -- --host" --key Enter)\\n${C.dim}  ⎿  Waiting for your answer in Ravenry.${C.r}\\n\\n`),
      `ravenryd send ${dev} --key Ctrl+C --delay 40ms --typed 'npm run dev -- --host' --key Enter --reason 'The game only listens on this Mac. --host lets your phone open it on the home Wi-Fi.' >/dev/null 2>&1`,
    ].join('\n'), { wait: false });
    resume('closed');
    await at('typed-in');
    await done('claude-puppet', nType);
    // Codex asks to press Enter in the dev server (it gets the pane for its session).
    const nEnter = await step('codex', `ravenryd send ${dev} --key Enter >/dev/null 2>&1`, { wait: false });
    resume('typed-in');
    await done('codex', nEnter, 120000);
    await at('marked');
    // 19: Claude edits and takes the dev server; Codex edits the same file in its copy, then waits for the pane.
    const edit = (file, from, to) => `perl -0pi -e ${q(`s/${from}/${to}/`)} ${file}`;
    const nLease = await step('claude-puppet', [
      edit('src/boat/physics.ts', 'return 0;', 'const k = Math.min(1, Math.abs(slope) \\/ 0.6);\\n  return slope * 0.5 * k;'),
      edit('src/boat/hull.ts', 'angle = 0;', 'angle = 0;\\n  damping = 0.85;\\n  rest = 0;'),
      `mkdir -p test/boat && printf 'import { tiltOf } from "../../src/boat/physics";\\n\\ntest("half the slope", () => {\\n  expect(tiltOf(0.4)).toBeCloseTo(0.13);\\n});\\n' > test/boat/tilt.test.ts`,
      ...['src/boat/physics.ts', 'src/boat/hull.ts', 'test/boat/tilt.test.ts'].map((f) => hook('claude', PB.sid, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: `${PB.folder}/${f}` } })),
      `ravenryd new --cwd "$PWD" --name tests --size 90x20 --label ravenry.kind=shell -- /bin/sh -c 'printf "PASS  25 tests, 2.0 s\\n"; exec sleep 100000' >/dev/null`,
      say(`${C.g}⏺${C.r} ${C.w}Bash${C.r}(ravenry lease "dev server" --ttl 30m)\\n${C.dim}  ⎿  Holding dev server while I check the reload.${C.r}\\n\\n`),
      `ravenryd lease ${dev} --ttl 30m >/dev/null 2>&1`,
    ].join('\n'), { wait: false });
    resume('marked');
    await at('leased');
    await done('claude-puppet', nLease);
    const nWait = await step('codex', [
      edit('src/boat/physics.ts', 'speed \\* 0.02', 'speed * 0.015'),
      edit('src/levels/harbour.ts', 'bob: 0.8', 'bob: 0.4'),
      `printf 'export const BUOY_COUNT = 2;\\n' > src/levels/buoys.ts`,
      ...['src/boat/physics.ts', 'src/levels/harbour.ts', 'src/levels/buoys.ts'].map((f) => hook('codex', CX, 'PostToolUse', { tool_name: 'apply_patch', tool_input: { file_path: `${WT}/${f}` } })),
      say(`• Waiting for the dev server; Claude has it.\\n`),
      `ravenryd lease ${dev} --ttl 2m --wait 20m >/dev/null 2>&1`,
    ].join('\n'), { wait: false });
    resume('leased');
    // 31: the decision, then the question.
    await at('decide');
    await step('claude-puppet', [
      say(`${C.g}⏺${C.r} ${C.w}Bash${C.r}(ravenry decide "Tilt the hull with the slope, but only half as much as the wave..." --replaces ${OLD})\\n${C.dim}  ⎿  Saved. You can undo it in Ravenry for a minute.${C.r}\\n\\n`),
      `ravenryd decide ${q('Tilt the hull with the slope, but only half as much as the wave. Level looked fake on the steep ones.')} --replaces ${OLD} --scope 'hull tilt' >/dev/null`,
    ].join('\n'));
    resume('decide');
    await at('ask');
    const nAsk = await step('claude-puppet', [
      'ravenryd decisions --search hull >/dev/null 2>&1; ravenryd decisions --search palette >/dev/null 2>&1',
      say(`${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry ask "How much spray at the bow on steep waves?")\\n${C.dim}  ⎿  Waiting for your answer in Ravenry.${C.r}\\n\\n`),
      `ravenryd ask "$(printf 'How much spray at the bow on steep waves?\\nThe tilt is in. A steep wave now throws spray over the bow, and on the phone it covers the boat for half a second.')" --option 'A little, never over the boat' --option 'As it is now' --text >/dev/null`,
    ].join('\n'), { wait: false });
    resume('ask');
    await done('claude-puppet', nAsk, 120000);
    // 32: the pick.
    await at('pick');
    const nPick = await step('claude-puppet', [
      say(`${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry pick "Which tilt reads best on the steep wave?" ...)\\n${C.dim}  ⎿  Waiting for your pick in Ravenry.${C.r}\\n\\n`),
      `ravenryd pick "$(printf 'Which tilt reads best on the steep wave?\\nRendered from the game at the same moment, frame 412 of the storm level.')" --variant "Level=${hub.home}/tilt-a.svg" --variant "Tilt with the slope=${hub.home}/tilt-b.svg" --variant "Half the slope=${hub.home}/tilt-c.svg" --describe "Level=The hull stays flat; the wave moves under it." --describe "Tilt with the slope=The hull follows the wave's angle at the bow." --describe "Half the slope=Follows the wave, half as much. Less spray." > ${WORK}/pick.txt 2>/dev/null`,
    ].join('\n'), { wait: false });
    resume('pick');
    await at('picked');
    await done('claude-puppet', nPick, 60000);
    console.log('the pick came back as:', fs.readFileSync(path.join(WORK, 'pick.txt'), 'utf8').trim().replace(/\n/g, ' | '));
    resume('picked');
    // 33: Claude commits its work on main; Codex gets the pane, commits, stops.
    await step('claude-puppet', `git -c user.name=Demo -c user.email=demo@example.com commit -qam 'Tilt the hull with half the slope' && git -c user.name=Demo -c user.email=demo@example.com add test && git -c user.name=Demo -c user.email=demo@example.com commit -qm 'Test the tilt'`);
    await at('handed');
    await done('codex', nWait, 60000);
    await step('codex', [
      `ravenryd lease ${dev} --release >/dev/null 2>&1`,
      edit('src/levels/harbour.ts', 'const length = 9;', 'const length = 8;'),
      `git -c user.name=Demo -c user.email=demo@example.com add -A && git -c user.name=Demo -c user.email=demo@example.com commit -qm 'Slow the buoys and shorten the wall'`,
      say(`\\n• Done: the buoys bob at 0.4 Hz and the wall is one tile shorter. Ready for your review.\\n`),
      hook('codex', CX, 'Stop'),
    ].join('\n'));
    resume('handed');
    // 33: two review comments kept by the board, one sent; Codex answers the sent one with ravenry review reply.
    await at('comments');
    const sid = encodeURIComponent(st.surfaceId);
    const post = async (p, body) => { const r = await fetch(hub.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(j)}`); return j; };
    const c1 = await post(`/api/sessions/${sid}/review/comment`, { file: 'src/levels/harbour.ts', line: 3, text: 'The buoys bob too fast next to the boat. Slow them down, keep the size.' });
    await post(`/api/sessions/${sid}/review/send`, {});
    await step('codex', `RAVENRY_HUB_URL=${hub.url} ravenryd review reply ${c1.comment.id} 'Done: 0.8 Hz down to 0.4 Hz, size unchanged. Line 3 below.' > ${WORK}/reply.txt 2>&1`);
    await post(`/api/sessions/${sid}/review/comment`, { file: 'src/levels/harbour.ts', line: 8, text: 'Make the harbour wall one tile shorter so the boat fits through on the phone.' });
    resume('comments');
  })();
  await Promise.all([app, script2]);
  console.log('wrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort().join(', '));
} catch (e) {
  if (hub) {
    try { fs.writeFileSync(path.join(OUT, 'board-state.json'), JSON.stringify(await hub.state(), null, 2)); } catch { /* gone */ }
    fs.writeFileSync(path.join(OUT, 'board.log'), hub.log());
  }
  for (const f of fs.readdirSync(WORK)) if (/\.fail\.(png|txt)$/.test(f)) fs.copyFileSync(path.join(WORK, f), path.join(OUT, f));
  throw e;
} finally {
  stopDaemons(BIN, RT);
  hub?.stop();
  if (!process.env.PHASE2_KEEP) { fs.rmSync(WORK, { recursive: true, force: true }); fs.rmSync(RT, { recursive: true, force: true }); }
}
