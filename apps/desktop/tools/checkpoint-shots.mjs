#!/usr/bin/env node
// Screenshots of the checkpoint cards, never on screen, from real
// checkpoints: three demo sessions run in real ravenryd panes and report
// through `ravenryd hook`, as a session started by the board does, then
// wait on `ravenryd ask`, `approve` and `secret`. recipe-box runs on
// "devbox", a second daemon the board reaches with `ssh devbox ravenryd
// proxy` (a fake ssh that runs it here, as the hub's machines test does),
// so its approval goes through the board. The commands the checkpoints run
// (git push, npm publish, npx wrangler) are stand-ins in a folder of their
// own that print what the real ones would; nothing leaves this machine.
//
//   node build.mjs && node tools/checkpoint-shots.mjs <outDir>
//
// Needs ravenryd: RAVENRYD, else ../../daemon/ravenryd. Writes to <outDir>
// each card open, the edit state of the command, the typed secret and each
// after state, at 1440x900 (wide) and 900x700 (narrow), and the first
// launch's hook offer (hooks-offer.png; its Set up runs against the
// throwaway HOME only and is checked there).
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startDemoHub } from './demo-hub.mjs';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'checkpoint-shots'));
const WORK = path.join(OUT, '.work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const tmp = (p) => { const d = fs.mkdtempSync(path.join(SHORT, p)); fs.chmodSync(d, 0o700); return d; };
const RT = tmp('rvc-'); // this machine's daemons
const RR = tmp('rvd-'); // devbox's
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// The stand-in commands, and the fake ssh with ravenryd beside it.
const STAND = path.join(WORK, 'standin');
const FAKE = path.join(WORK, 'fakessh');
const DEVBOX_HOME = path.join(WORK, 'devbox-home');
for (const d of [STAND, FAKE, DEVBOX_HOME]) fs.mkdirSync(d, { recursive: true });
const script = (dir, name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
script(STAND, 'git', `case "$1" in push) sleep 2; echo "To devbox:code/recipe-box.git"; echo "   4be1f0a..9c2d7e1  main -> main";; *) exec /usr/bin/git "$@";; esac`);
script(STAND, 'npm', `case "$1" in publish) sleep 3; echo "+ recipe-box@2.3.0"; [ $# -gt 1 ] && echo "npm $*";; *) echo "npm $*";; esac`);
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

const HOME_STATE = path.join(WORK, 'state');
const localEnv = (home) => ({ HOME: home, PATH: `${STAND}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', RAVENRY_RUNTIME_DIR: RT, RAVENRY_STATE_DIR: HOME_STATE });

// A demo session in a pane: it says it started and was given a prompt
// (through ravenryd hook, so the board follows it), draws a screen like
// Claude Code's, then waits on the checkpoint.
const C = { dim: '\x1b[38;5;245m', w: '\x1b[97m', g: '\x1b[32m', y: '\x1b[33m', o: '\x1b[38;5;173m', box: '\x1b[48;5;235m', r: '\x1b[0m' };
function sessionScript(s, { screen, wait, after }) {
  const hook = (ev) => `printf '%s' '${JSON.stringify({ hook_event_name: ev, session_id: s.sid, cwd: s.folder, transcript_path: s.transcript, ...(ev === 'SessionStart' ? { source: 'startup', model: 'claude-opus-5-5' } : { prompt: '' }) })}' | '${BIN}' hook --assistant claude >/dev/null 2>&1`;
  const f = path.join(WORK, `session-${s.sid.slice(0, 4)}.sh`);
  fs.writeFileSync(f, [
    hook('SessionStart'), hook('UserPromptSubmit'),
    // Its title, as Claude Code sets it: the board's name for the session.
    `printf '\\033]0;✳ ${s.topic}\\007'`,
    `printf '%b' '${screen.replace(/'/g, "'\\''")}'`,
    `${wait} >/dev/null 2>"$HOME/.cp-err-${s.sid.slice(0, 4)}"`,
    `printf '%b' '${after.replace(/'/g, "'\\''")}'`,
    'exec sleep 100000',
  ].join('\n') + '\n', { mode: 0o755 });
  return f;
}

const run = (name, o) => runApp({ name, work: WORK, rt: RT, bin: BIN, ...o });
const sig = (n) => path.join(WORK, `${n}.signal`);
const go = (n) => path.join(WORK, `${n}.go`);
const shot = (f) => ({ shot: path.join(OUT, f), settle: 300 });

let hub;
try {
  // This machine's daemon first, with the stand-ins on its PATH, so the
  // panes it starts find them; the app finds it running.
  execFileSync(BIN, ['serve', '--detach'], { env: localEnv(WORK) });
  hub = await startDemoHub({
    dir: path.join(WORK, 'demo'), port: await freePort(), runtime: RT, alerts: true,
    panes: ['notes-app', 'recipe-box', 'garden-planner'],
    env: { MC_NO_EVENTS: '0', RAVENRY_SSH: path.join(FAKE, 'ssh'), RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), RAVENRY_MACHINE_RETRY_MS: '300' },
    settings: { machines: [{ name: 'devbox', host: 'devbox' }] },
  });
  const S3 = hub.sessions;
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const ask = sessionScript(S3['notes-app'], {
    screen: `${C.box} > Finish the sync settings screen, then ask me before the beta goes out ${C.r}\\n\\n${C.g}⏺${C.r} ${C.w}Update${C.r}(src/settings/SyncScreen.tsx)\\n${C.dim}  ⎿  Updated src/settings/SyncScreen.tsx with 18 additions and 4 removals${C.r}\\n\\n${C.g}⏺${C.r} ${C.w}Bash${C.r}(npm test)\\n${C.dim}  ⎿  ${C.g}PASS${C.dim}  64 tests, 3.1 s${C.r}\\n\\n⏺ The settings screen is done and the tests pass. Asking before the beta goes out.\\n\\n${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry ask "Ship the beta to the testers?" --option "Ship it" --option "Not yet")\\n${C.dim}  ⎿  Waiting for your answer in Ravenry.${C.r}\\n\\n${C.o}✻${C.r} ${C.dim}Waiting for you…${C.r}\\n`,
    wait: `'${BIN}' ask "$(printf 'Ship the beta to the testers?\\nThe settings screen is done and all 64 tests pass. Build 0.6.0 would go to the 12 testers.')" --option 'Ship it' --option 'Not yet' --text --timeout 30m`,
    after: `\\n${C.g}⏺${C.r} You said: Ship it. Shipping build 0.6.0.\\n`,
  });
  const approve = sessionScript(S3['recipe-box'], {
    screen: `${C.dim}›${C.r} ${C.w}Publish 2.3.0 once the import tests pass${C.r}\\n\\n• Ran ${C.w}npm test -- import${C.r}\\n${C.dim}  └ ${C.g}48 passed${C.dim}, 0 failed (2.4 s)${C.r}\\n\\n• The import tests pass. Pushing and publishing are on your list of things\\n  I can not run alone, so I asked Ravenry to run them once you approve.\\n\\n${C.y}•${C.r} Waiting for approval in Ravenry\\n${C.dim}  └ git push origin main && npm publish${C.r}\\n`,
    wait: `'${BIN}' approve 'git push origin main && npm publish' --why ${q('The import tests pass. This pushes the 2.3.0 commit and publishes it.')} --warn ${q('Everyone who installs recipe-box gets 2.3.0 at once')} --timeout 30m`,
    after: `\\n• Published recipe-box 2.3.0.\\n`,
  });
  const secret = sessionScript(S3['garden-planner'], {
    screen: `${C.box} > Send the first reminder email when a sowing window opens ${C.r}\\n\\n${C.g}⏺${C.r} ${C.w}Write${C.r}(src/mail/send.ts)\\n${C.dim}  ⎿  Wrote 41 lines to src/mail/send.ts${C.r}\\n\\n⏺ The worker needs the mail service key as a secret before it can send anything.\\n  I will ask for it through Ravenry so it goes to wrangler and I never see it.\\n\\n${C.y}⏺${C.r} ${C.w}Bash${C.r}(ravenry secret "Mail service API key" -- npx wrangler secret put MAIL_API_KEY)\\n${C.dim}  ⎿  Waiting for the secret in Ravenry. It goes to the command, not to Claude.${C.r}\\n\\n${C.o}✻${C.r} ${C.dim}Waiting for you…${C.r}\\n`,
    wait: `'${BIN}' secret 'Mail service API key' --timeout 30m -- npx wrangler secret put MAIL_API_KEY`,
    after: `\\n${C.g}⏺${C.r} The key is set. Sending the first reminder.\\n`,
  });
  const newPane = (env, s, file, name) => execFileSync(BIN, ['new', '--cwd', s.folder, '--name', name, '--size', '100x30', '--label', 'ravenry.session=claude', '--', '/bin/sh', file], { env, encoding: 'utf8' }).trim();
  newPane(localEnv(WORK), S3['notes-app'], ask, 'Sync settings');
  newPane(DEVBOX_ENV, S3['recipe-box'], approve, 'Old recipe import');
  newPane(localEnv(WORK), S3['garden-planner'], secret, 'Reminder emails');

  const R = 'window.__ravenry';
  const keyOf = (kind) => `(() => { const k = [...${R}.S.cps.items.values()].find((x) => x.cp.kind === '${kind}'); return k.cp.projectId + '/' + k.cp.surfaceId; })()`;
  const pick = (kind) => ({ js: `${R}.pickSession(${keyOf(kind)})` });
  const cardIs = (kind) => ({ until: `(() => { const e = document.querySelector('#panel .cp[data-cp]:not(.after)'); return e && ${R}.S.cps.get(e.dataset.cp).cp.kind === '${kind}' && !document.getElementById('panel').hidden; })()`, timeout: 15000 });
  const afterIs = (head) => ({ until: `[...document.querySelectorAll('#panel .cp.after .cp-h')].some((e) => e.textContent.includes(${JSON.stringify(head)}))`, timeout: 30000 });
  const button = (label) => ({ js: `[...document.querySelectorAll('#panel .cp button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()` });
  const narrowAfter = (kind) => ({ js: `(() => { const k = ${keyOf(kind)}; ${R}.pickSession(k); ${R}.S.panelKey = k; ${R}.S.overlay = true; ${R}.render(); })()` });
  // A made-up key, new on each run: 32 characters, as the picture's.
  const SECRET = crypto.randomBytes(24).toString('base64url');
  const steps = [
    { ready: true },
    { until: `[...${R}.S.cps.items.values()].filter((k) => k.cp.projectId && k.cp.state === 'open').length === 3`, timeout: 60000 },
    { until: `document.querySelectorAll('.ss-q.k').length === 3`, timeout: 20000 },
    // Wide: each card open, the command being edited, the secret being typed.
    pick('ask'), cardIs('ask'), shot('ask-wide.png'),
    pick('approve'), cardIs('approve'), shot('approve-wide.png'),
    // Refuse opens the reason field; Back closes it again.
    button('Refuse'), { until: `document.querySelector('#panel .cp input.rsn')` },
    { js: `document.querySelector('#panel .cp input.rsn').focus()` },
    { type: 'Run the full test suite first', after: 200 }, shot('approve-refuse-wide.png'),
    button('Back'), { until: `!document.querySelector('#panel .cp input.rsn')` },
    button('Edit'), { until: `document.querySelector('#panel .cmd-in')` }, { sleep: 200 },
    { type: ' --tag beta', after: 200 }, shot('approve-edit-wide.png'),
    button('Cancel'),
    pick('secret'), cardIs('secret'), { sleep: 300 }, shot('secret-wide.png'),
    { js: `document.querySelector('#panel .cp input.si').focus()` },
    { type: SECRET, after: 200 }, shot('secret-typing-wide.png'),
    // Narrow: the panel opens over the terminal.
    { js: `${R}.setView({ kind: 'none' }); ${R}.S.overlay = false; ${R}.S.panelKey = null;` },
    { size: [900, 700] }, { js: 'window.dispatchEvent(new Event("resize"))' },
    pick('ask'), cardIs('ask'), shot('ask-narrow.png'),
    { js: `document.querySelector('#panel .cp .fi').focus()` },
    { type: 'Not yet. Wait for the dark mode fix first.', after: 200 }, shot('ask-typing-narrow.png'),
    pick('approve'), cardIs('approve'), shot('approve-narrow.png'),
    button('Edit'), { until: `document.querySelector('#panel .cmd-in')` }, { sleep: 200 },
    { type: ' --tag beta', after: 200 }, shot('approve-edit-narrow.png'),
    button('Cancel'),
    pick('secret'), cardIs('secret'), { sleep: 300 },
    { js: `document.querySelector('#panel .cp input.si').focus()` },
    { type: SECRET, after: 200 }, shot('secret-typing-narrow.png'),
    // The answers: the question on the phone (the board's API, as the phone
    // calls it), the command and the secret here.
    { size: [1440, 900] }, { js: 'window.dispatchEvent(new Event("resize"))' },
    { js: `${R}.S.overlay = false; ${R}.S.panelKey = null;` },
    { save: { expr: `[...${R}.S.cps.items.values()].find((x) => x.cp.kind === 'ask').cp.id`, out: path.join(WORK, 'ask-id.json') } },
    { signal: sig('phone') }, { wait: go('phone') },
    pick('ask'), afterIs('Answered'), shot('ask-after-wide.png'),
    // Edit then run, through the board (devbox is reached through the hub):
    // the edited command runs there.
    pick('approve'), cardIs('approve'), button('Edit'), { until: `document.querySelector('#panel .cmd-in')` }, { sleep: 200 },
    { type: ' --tag beta', after: 200 }, button('Run edited command'), afterIs('Ran on devbox'), shot('approve-after-wide.png'),
    pick('secret'), cardIs('secret'), { js: `document.querySelector('#panel .cp input.si').focus()` },
    { type: SECRET, after: 200 }, button('Send to the terminal'), afterIs('Secret sent'), shot('secret-after-wide.png'),
    { size: [900, 700] }, { js: 'window.dispatchEvent(new Event("resize"))' },
    narrowAfter('ask'), afterIs('Answered'), shot('ask-after-narrow.png'),
    narrowAfter('approve'), afterIs('Ran on devbox'), shot('approve-after-narrow.png'),
    narrowAfter('secret'), afterIs('Secret sent'), shot('secret-after-narrow.png'),
    { save: { expr: `({ page: document.documentElement.outerHTML, cps: [...${R}.S.cps.items.values()].map((k) => k.cp) })`, out: path.join(WORK, 'after.json') } },
  ];
  const app = run('checkpoints', { home: hub.home, hubUrl: hub.url, steps, timeoutMs: 300000, env: { RAVENRY_SERVICE: 'off' } });
  const phone = (async () => {
    while (!fs.existsSync(sig('phone'))) await sleep(50);
    const id = JSON.parse(fs.readFileSync(path.join(WORK, 'ask-id.json'), 'utf8'));
    const r = await fetch(hub.url + '/api/checkpoints/answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ id, choice: 0, by: 'phone' }) });
    if (!r.ok) throw new Error(`the phone's answer: ${r.status} ${await r.text()}`);
    fs.writeFileSync(go('phone'), '1');
  })();
  await Promise.all([app, phone]);
  const after = fs.readFileSync(path.join(WORK, 'after.json'), 'utf8');
  if (after.includes(SECRET)) throw new Error('the secret is in the window after it was sent');
  const ended = JSON.parse(after).cps.map((c) => `${c.kind}:${c.state}:${c.answer && c.answer.by}`).sort();
  const rb = JSON.parse(after).cps.find((c) => c.kind === 'approve');
  if (!rb || rb.answer?.command !== 'git push origin main && npm publish --tag beta' || !/npm publish --tag beta/.test(rb.run?.output || '')) throw new Error(`the edited command did not run on devbox through the board: ${JSON.stringify(rb)}`);
  console.log('edited on devbox, through the board:', rb.answer.command);
  console.log('answered:', ended.join(', '));
  stopDaemons(BIN, RT);
  hub.stop(); hub = null;

  // ------------------------------------------------ the first launch's hook offer
  const emptyHub = await startDemoHub({ dir: path.join(WORK, 'demo-empty'), port: await freePort(), empty: true });
  hub = emptyHub;
  const settings = path.join(emptyHub.home, '.claude', 'settings.json');
  await run('hooks', {
    home: emptyHub.home, hubUrl: emptyHub.url, env: { RAVENRY_SERVICE: 'off' },
    steps: [
      { ready: true },
      { until: `document.querySelector('.fl-hooks')`, timeout: 20000 },
      shot('hooks-offer.png'),
      { js: `[...document.querySelectorAll('.fl-hooks button')].find((b) => b.textContent === 'Set them up').click()` },
      { until: `!document.querySelector('.fl-hooks') && !document.getElementById('toast').hidden`, timeout: 20000 },
      shot('hooks-done.png'),
    ],
  });
  const set = fs.readFileSync(settings, 'utf8');
  if (!set.includes(`${BIN} hook --assistant claude`) && !set.includes('hook --assistant claude')) throw new Error(`the hooks were not set up in the throwaway HOME: ${set.slice(0, 400)}`);
  console.log('hooks: set up in the throwaway HOME', path.relative(OUT, settings));
  console.log('wrote', fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).join(', '));
} catch (e) {
  // What the board saw, beside the app's own failure files.
  if (hub) {
    try { fs.writeFileSync(path.join(WORK, 'board-state.json'), JSON.stringify(await hub.state(), null, 2)); } catch { /* gone */ }
    fs.writeFileSync(path.join(WORK, 'board.log'), hub.log());
  }
  throw e;
} finally {
  stopDaemons(BIN, RT);
  try {
    const ds = JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: DEVBOX_ENV, encoding: 'utf8' }) || '[]');
    for (const d of ds) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  hub?.stop();
  fs.rmSync(RT, { recursive: true, force: true });
  fs.rmSync(RR, { recursive: true, force: true });
}
