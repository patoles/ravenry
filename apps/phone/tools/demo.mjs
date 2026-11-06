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
//   node tools/demo.mjs [--port N] [--phone] [--hold]
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
function preparePages({ MC }) {
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
if (PHONE) Object.assign(extraEnv, { RAVENRY_PHONE_HOSTS: '10.0.2.2', RAVENRY_PHONE_PORT: String(Number(opt('--phone-port', PORT + 1))) });
const hub = await startDemoHub({
  dir: path.join(WORK, 'hub'), port: PORT, runtime: RT, alerts: false,
  panes: ['notes-app', 'recipe-box', 'garden-planner', 'weather-widget'],
  env: extraEnv,
  settings: { machines: [{ name: 'devbox', host: 'devbox' }] },
  extra: [{ id: 'notes-cli' }, { id: 'portfolio' }, { id: 'trail-map' }],
  prepare: preparePages,
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
const newPane = (env, s, file, name) => execFileSync(BIN, ['new', '--cwd', s.folder, '--name', name, '--size', '56x40', '--label', 'ravenry.session=claude', '--', '/bin/sh', file], { env, encoding: 'utf8' }).trim();
newPane(localEnv(WORK), S['weather-widget'], liveS, 'Cache forecasts');
// --hold: the three checkpoints open only once <dir>/go exists, so a phone
// paired first gets their alerts as they open.
const openCheckpoints = () => {
  newPane(localEnv(WORK), S['notes-app'], askS, 'Sync settings');
  newPane(DEVBOX_ENV, S['recipe-box'], approveS, 'Old recipe import');
  newPane(localEnv(WORK), S['garden-planner'], secretS, 'Reminder emails');
};
if (args.includes('--hold')) {
  const t = setInterval(() => { if (fs.existsSync(path.join(WORK, 'go'))) { clearInterval(t); openCheckpoints(); console.log('checkpoints opened'); } }, 300);
} else openCheckpoints();

const info = { url: hub.url, port: PORT, runtime: RT, home: hub.home, phone: null };
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
