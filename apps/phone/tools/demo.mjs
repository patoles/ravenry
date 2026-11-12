#!/usr/bin/env node
// A made-up board for the phone board's screenshots and checks: the hub in
// ../../hub, run as it is on a throwaway HOME (apps/desktop/tools/
// demo-hub.mjs), with real sessions in real ravenryd panes:
//
//   notes-app       waits on `ravenry ask` (a question with two answers)
//   recipe-box      on "devbox", a second daemon reached with a fake ssh,
//                   waits on `ravenry approve`
//   garden-planner  waits on `ravenry secret`
//   weather-widget  a live screen with a question and its choices
//
// and the sidebar's pages, with a playtest notes board (the page format's
// own fixture). Nothing leaves this machine: the commands the checkpoints
// would run are stand-ins.
//
//   node tools/demo.mjs [--port N] [--phone] [--hold] [--e2e]
//
// --hub DIR runs that hub folder in place of ../../hub, with the node running
// this script: a packaged app's own (Contents/Resources/hub, run by its
// Contents/MacOS/node), to pair a phone with the board as it ships.
//
// --e2e (tools/phone-e2e.mjs): the board opens sessions in Ravenry panes
// (RAVENRY_TERMINAL=ravenry, so New session starts a real pane), `claude`
// there is a stand-in that prints its words and then echoes what is typed,
// and portfolio gets a session in a wide pane (140 x 40): long lines, one
// that the width wraps, and more lines than a phone's screen, then `cat`,
// so what the phone types shows in the pane.
//
// --phone turns phone access on, so the hub listens with TLS on the phone
// port (docs/PHONE.md section 2) for an emulator (10.0.2.2), and prints the
// pairing link. It runs until stopped, and writes what it started to
// .tmp/demo/demo.json (the hub's url, its pid, the link).
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PHONE = args.includes('--phone');
const E2E = args.includes('--e2e');
const WORK = path.resolve(opt('--dir', path.join(APP, '.tmp', 'demo')));
const BIN = path.resolve(process.env.RAVENRYD || path.join(REPO, 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const tmp = (p) => { const d = fs.mkdtempSync(path.join(SHORT, p)); fs.chmodSync(d, 0o700); return d; };
const RT = tmp('rvp-');
const RR = tmp('rvq-');
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = Number(opt('--port', 0)) || await freePort();

// The stand-in commands, and the fake ssh with ravenryd beside it.
const STAND = path.join(WORK, 'standin');
const FAKE = path.join(WORK, 'fakessh');
const DEVBOX_HOME = path.join(WORK, 'devbox-home');
for (const d of [STAND, FAKE, DEVBOX_HOME]) fs.mkdirSync(d, { recursive: true });
const script = (dir, name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
script(STAND, 'git', `case "$1" in push) sleep 2; echo "To devbox:code/recipe-box.git"; echo "   4be1f0a..9c2d7e1  main -> main";; *) exec /usr/bin/git "$@";; esac`);
script(STAND, 'npm', `case "$1" in publish) sleep 3; echo "+ recipe-box@2.3.0";; *) echo "npm $*";; esac`);
// The stand-in claude a New session starts (--e2e): its words, then what is typed.
// After 3 s it reports SessionStart, as Claude Code's hooks do, so the board
// moves it from Starting to a session of its own.
script(STAND, 'claude', `printf 'claude stand-in: %s\\n' "$*"
(sleep 3; printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"startup","model":"claude-opus-5-5"}' "$(/usr/bin/uuidgen | tr A-Z a-z)" "$PWD" | '${BIN}' hook --assistant claude >/dev/null 2>&1) &
exec cat`);
script(STAND, 'npx', `[ "$1" = wrangler ] || exit 1; printf "? Enter a secret value: "; IFS= read -r v; [ \${#v} -ge 4 ] || exit 1; echo; echo "Success! Uploaded secret MAIL_API_KEY"`);
fs.symlinkSync(BIN, path.join(FAKE, 'ravenryd'));
const DEVBOX_ENV = { HOME: DEVBOX_HOME, PATH: `${FAKE}:${STAND}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: RR, RAVENRY_STATE_DIR: path.join(WORK, 'devbox-state') };
script(FAKE, 'ssh', `while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) shift; [ "$1" = "--" ] && shift; break ;;
  esac
done
exec env -i ${Object.entries(DEVBOX_ENV).map(([k, v]) => `${k}='${v}'`).join(' ')} SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' SSH_CLIENT='127.0.0.1 50022 22' /bin/sh -c "$*"`);
const localEnv = (home) => ({ HOME: home, PATH: `${STAND}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: path.join(WORK, 'state') });

// A demo session in a pane: it reports through ravenryd hook, draws a
// screen like Claude Code's, then waits.
const C = { dim: '\x1b[38;5;245m', w: '\x1b[97m', g: '\x1b[32m', y: '\x1b[33m', o: '\x1b[38;5;173m', b: '\x1b[38;5;75m', box: '\x1b[48;5;235m', add: '\x1b[48;5;22m', del: '\x1b[48;5;52m', r: '\x1b[0m' };
function sessionScript(s, { screen, wait, after = '', title = s.topic }) {
  const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
  const f = path.join(WORK, `session-${s.sid.slice(0, 4)}.sh`);
  fs.writeFileSync(f, [
    hook('SessionStart'), hook('UserPromptSubmit'),
    `printf '\\033]0;✳ ${title}\\007'`,
    `printf '%b' '${screen.replace(/'/g, "'\\''")}'`,
    // The board knows the session before its agent asks, as in real use.
    'sleep 6',
    `${wait} >/dev/null 2>"$HOME/.cp-err-${s.sid.slice(0, 4)}"`,
    `printf '%b' '${after.replace(/'/g, "'\\''")}'`,
    'exec sleep 100000',
  ].join('\n') + '\n', { mode: 0o755 });
  return f;
}

// The pages: the page format's playtest board, its notes dated around now.
function preparePages({ HOME, MC }) {
  // The person's rules (the Rules page's Mine), so the phone's Rules view
  // has cards to lay out (tools/phone-overflow.mjs measures it).
  fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), [
    '# Working rules', '',
    '## Writing',
    '- Say what changed in plain words, then the check that proves it.',
    '- A path like `apps/phone/tools/demo.mjs` or a long command stays whole on a phone screen.', '',
    '## Checks',
    '- Run the one check the change touches before saying it is done.',
    '- Never test on the real board: a test hub on 127.0.0.1 with its own data.', '',
  ].join('\n'));
  const src = path.join(REPO, 'packages', 'page-format', 'fixtures', 'playtest');
  const dst = path.join(MC, 'pages');
  fs.mkdirSync(path.join(dst, 'playtest', 'shots'), { recursive: true });
  fs.copyFileSync(path.join(src, 'playtest.page.yaml'), path.join(dst, 'playtest.page.yaml'));
  const notes = fs.readdirSync(path.join(src, 'playtest')).filter((f) => f.endsWith('.md'));
  notes.forEach((f, i) => {
    fs.copyFileSync(path.join(src, 'playtest', f), path.join(dst, 'playtest', f));
    const t = new Date(Date.now() - (i * 47 + 12) * 60000);
    fs.utimesSync(path.join(dst, 'playtest', f), t, t);
  });
  for (const f of fs.readdirSync(path.join(src, 'playtest', 'shots'))) fs.copyFileSync(path.join(src, 'playtest', 'shots', f), path.join(dst, 'playtest', 'shots', f));
}

execFileSync(BIN, ['serve', '--detach'], { env: localEnv(WORK) });
const extraEnv = { MC_NO_EVENTS: '0', RAVENRY_SSH: path.join(FAKE, 'ssh'), RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), RAVENRY_MACHINE_RETRY_MS: '300' };
Object.assign(extraEnv, { RAVENRY_HUB_NAME: 'MacBook Pro' });
if (E2E) Object.assign(extraEnv, { RAVENRY_TERMINAL: 'ravenry', PATH: `${STAND}:${process.env.PATH}` });
if (PHONE) Object.assign(extraEnv, { RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_PHONE_PORT: String(Number(opt('--phone-port', PORT + 1))) });
const hub = await startDemoHub({
  dir: path.join(WORK, 'hub'), port: PORT, runtime: RT, alerts: false, ...(opt('--hub') ? { hubDir: path.resolve(opt('--hub')) } : {}),
  panes: ['notes-app', 'recipe-box', 'garden-planner', 'weather-widget', 'paper-boat'],
  env: extraEnv,
  settings: { machines: [{ name: 'devbox', host: 'devbox' }] },
  extra: [{ id: 'notes-cli' }, { id: 'portfolio' }, { id: 'trail-map' }],
  prepare: preparePages,
  ideas: true,
});
const S = hub.sessions;
const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const askS = sessionScript(S['notes-app'], {
  screen: `${C.box} > Finish the sync settings screen, then ask me before the beta goes out ${C.r}\\n\\n${C.g}⏺${C.r} ${C.w}Bash${C.r}(npm test)\\n${C.dim}  ⎿  ${C.g}PASS${C.dim}  64 tests, 3.1 s${C.r}\\n\\n${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry ask "Ship the beta to the testers?")\\n${C.dim}  ⎿  Waiting for your answer in Ravenry.${C.r}\\n`,
  wait: `'${BIN}' ask "$(printf 'Ship the beta to the testers?\\nThe settings screen is done and all 64 tests pass. Build 0.6.0 would go to the 12 testers.')" --option 'Ship it' --option 'Not yet' --text --timeout 30m`,
  after: `\\n${C.g}⏺${C.r} Got your answer.\\n`,
});
const approveS = sessionScript(S['recipe-box'], {
  screen: `${C.dim}›${C.r} ${C.w}Publish 2.3.0 once the import tests pass${C.r}\\n\\n• Ran ${C.w}npm test -- import${C.r}\\n${C.dim}  └ ${C.g}48 passed${C.dim}, 0 failed (2.4 s)${C.r}\\n\\n${C.y}•${C.r} Waiting for approval in Ravenry\\n${C.dim}  └ git push origin main && npm publish${C.r}\\n`,
  wait: `'${BIN}' approve 'git push origin main && npm publish' --why ${q('The import tests pass. This pushes the 2.3.0 commit and publishes it.')} --timeout 30m`,
  after: `\\n• Published recipe-box 2.3.0.\\n`,
});
const secretS = sessionScript(S['garden-planner'], {
  screen: `${C.box} > Send the first reminder email when a sowing window opens ${C.r}\\n\\n${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry secret "Mail service API key" -- npx wrangler secret put MAIL_API_KEY)\\n${C.dim}  ⎿  Waiting for the secret in Ravenry.${C.r}\\n`,
  wait: `'${BIN}' secret 'Mail service API key' --timeout 30m -- npx wrangler secret put MAIL_API_KEY`,
  after: `\\n${C.g}⏺${C.r} The key is set.\\n`,
});
// The live screen of picture 3: a cache, a diff, the tests, then a question
// with its two answers in Claude Code's menu.
const liveS = sessionScript(S['weather-widget'], {
  screen: [
    `${C.g}dev@devbox${C.r}:${C.b}~/code/weather-widget${C.r}$ git pull`, 'Already up to date.',
    `${C.g}dev@devbox${C.r}:${C.b}~/code/weather-widget${C.r}$ claude`, '',
    `${C.box} > Cache the forecast calls so we stop hitting the provider's rate limit ${C.r}`, '',
    `${C.w}⏺${C.r} I'll put a small cache in front of the forecast client, keyed by city.`, '',
    `${C.g}⏺${C.r} ${C.w}Read${C.r}(src/forecast.ts)`, `${C.dim}  ⎿  Read 64 lines${C.r}`, '',
    `${C.g}⏺${C.r} ${C.w}Update${C.r}(src/forecast.ts)`, `${C.dim}  ⎿  Updated src/forecast.ts with 6 additions and 1 removal${C.r}`,
    `${C.add}  13 + import { TtlCache } from "./cache";${C.r}`, `${C.add}  15 + const cache = new TtlCache(10 * 60_000);${C.r}`,
    `${C.dim}  17   export async function getForecast(city) {${C.r}`, `${C.del}  18 -   return fetchJson(\`\${BASE}/forecast?q=\${city}\`);${C.r}`,
    `${C.add}  18 +   const hit = cache.get(city);${C.r}`, '',
    `${C.g}⏺${C.r} ${C.w}Bash${C.r}(npm test -- forecast)`, `${C.dim}  ⎿  ${C.g}PASS${C.dim}  test/forecast.test.ts (5 tests, 1.1 s)${C.r}`, '',
    `${C.w}⏺${C.r} Done. Forecasts are now cached for 10 minutes per city, and the tests pass.`, '',
    '─'.repeat(54), ` ${C.w}Cache length${C.r}`, '', 'Which do you want: 10 minutes or 30?', '',
    `${C.b}❯ 1. 10 minutes${C.r}`, '     Fresh enough for a widget', '  2. 30 minutes', '     A third of the calls', '  3. Type something.', '',
    `${C.dim}Enter to select · ↑/↓ to navigate · Esc to cancel${C.r}`, '',
  ].join('\\n'),
  wait: 'sleep 100000',
  title: 'Cache forecasts',
});
// Every symbol Claude Code and Codex can print (tools/agent-glyphs.txt), so
// a look at this pane shows whether the phone draws each one as text.
const glyphLines = fs.readFileSync(path.join(HERE, 'agent-glyphs.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const glyphS = sessionScript(S['paper-boat'], {
  screen: glyphLines.map((l) => (/^[A-Z]/.test(l) ? `\n${C.w}${l}${C.r}` : l)).join('\n') + '\n',
  wait: 'sleep 100000',
  title: 'Glyph check',
});
// recipe-box lives on devbox, in devbox's own home, so its folder is said
// against devbox's home (hub/public/homepath.mjs), not this computer's.
const DEVBOX_FOLDER = path.join(DEVBOX_HOME, 'code', 'recipe-box');
fs.mkdirSync(DEVBOX_FOLDER, { recursive: true });
const newPane = (env, s, file, name, cwd = s.folder) => execFileSync(BIN, ['new', '--cwd', cwd, '--name', name, '--size', '56x40', '--label', 'ravenry.session=claude', '--', '/bin/sh', file], { env, encoding: 'utf8' }).trim();
newPane(localEnv(WORK), S['weather-widget'], liveS, 'Cache forecasts');
newPane(localEnv(WORK), S['paper-boat'], glyphS, 'Glyph check');
// --hold: the three checkpoints open only once <dir>/go exists, so a phone
// paired first gets their alerts as they open.
const openCheckpoints = () => {
  newPane(localEnv(WORK), S['notes-app'], askS, 'Sync settings');
  newPane(DEVBOX_ENV, S['recipe-box'], approveS, 'Old recipe import', DEVBOX_FOLDER);
  newPane(localEnv(WORK), S['garden-planner'], secretS, 'Reminder emails');
};
if (args.includes('--hold')) {
  const t = setInterval(() => { if (fs.existsSync(path.join(WORK, 'go'))) { clearInterval(t); openCheckpoints(); console.log('checkpoints opened'); } }, 300);
} else openCheckpoints();

const info = { url: hub.url, port: PORT, runtime: RT, home: hub.home, phone: null, wide: null };
if (E2E) {
  // portfolio's session in a 140 x 40 pane, as a Mac window would size it.
  const folder = path.join(hub.home, 'Projects', 'portfolio');
  fs.mkdirSync(folder, { recursive: true });
  const w = { sid: 'f6f6f6f6-0000-4000-8000-000000000006', folder, transcript: path.join(WORK, 'wide.jsonl') };
  const rule = '\u2500'.repeat(140);
  const para = 'The intro now opens with what the portfolio is for and who it is for, then three projects with one picture each, and the contact line moves to the top so a phone shows it without scrolling; the old about page folds into it.';
  const steps = Array.from({ length: 24 }, (_, i) => [`${C.w}\u23fa${C.r} Section ${String(i + 1).padStart(2, '0')} of the intro page is built: its links, its pictures and its text checked at three widths, nothing left to fix there.`, '']).flat();
  const screen = [`${C.box} > Rewrite the portfolio intro so it reads well on a phone, and keep the contact line in sight ${C.r}`, '',
    `${C.w}\u23fa${C.r} I'll rewrite the intro, move the contact line up and check every section at a phone's width before I touch the pictures.`, '',
    `${C.w}\u23fa${C.r} ${para}`, '', ...steps, `${C.g}\u23fa${C.r} ${C.w}Bash${C.r}(npm run build -- --report)`, `  \u23bf  built 24 sections in 3.2 s`, '',
    `${C.w}\u23fa${C.r} Done. The intro is shorter, the contact line is first, and every section passed at 360, 412 and 1440 pixels wide.`, '',
    ''].join('\n');
  const f = sessionScript(w, { screen: screen.replace(/\n/g, '\\n'), wait: 'true', title: 'Portfolio intro' });
  // Its prompt box, the cursor in it, and each line typed there answered
  // above it as a new entry (escape bytes shown as text), as Claude Code
  // takes a message.
  const loop = [`RULE='${rule}'`,
    `box() { printf '%s\\n\\342\\235\\257 \\n%s\\033[1A\\r\\033[2C' "$RULE" "$RULE"; }`,
    'box',
    'while IFS= read -r l; do',
    `  l=$(printf '%s' "$l" | tr -d '\\033')`,
    `  printf '\\033[2A\\r\\033[J\\342\\217\\272 You said: %s\\n\\n' "$l"`,
    '  box',
    'done'].join('\n');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('exec sleep 100000', loop));
  const out = execFileSync(BIN, ['new', '--cwd', folder, '--name', 'Portfolio intro', '--size', '140x40', '--label', 'ravenry.session=claude', '--', '/bin/sh', f], { env: localEnv(WORK), encoding: 'utf8' }).trim();
  info.wide = { pane: out.split(/\s+/)[0], folder, sid: w.sid };
}
if (PHONE) {
  // Phone access on, as the Mac's switch does (POST /api/phone/access, a
  // person's call: this process is outside every pane), and the app's link.
  const r = await fetch(`${hub.url}/api/phone/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ on: true }) });
  const card = await r.json();
  if (!r.ok || !card.app) { console.error('phone access did not turn on:', JSON.stringify(card)); process.exit(1); }
  info.phone = { link: card.app.link, port: card.app.port, check: card.app.check, code: card.app.code };
  console.log(`phone port ${card.app.port}, pairing link: ${card.app.link}`);
}
fs.writeFileSync(path.join(WORK, 'demo.json'), JSON.stringify(info, null, 2));
console.log(`demo hub on ${hub.url} (data under ${path.relative(process.cwd(), WORK)})`);
const stop = () => {
  hub.stop();
  for (const env of [localEnv(WORK), DEVBOX_ENV]) {
    try {
      for (const d of JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env, encoding: 'utf8' }))) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
    } catch { /* none */ }
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
