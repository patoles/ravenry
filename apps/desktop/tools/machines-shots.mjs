#!/usr/bin/env node
// Screenshots of the Machines page (src/renderer/machines.ts), never on
// screen, from a real board and real installs: every "machine" is a
// throwaway home folder reached through a fake ssh that runs the command
// line there through sh, as sshd does (hub/tools/remote-install-test.mjs
// proves the same installer). Stand-ins on a machine's PATH make it look
// otherwise: uname for FreeBSD, df for a full disk, a slow gzip so the copy
// can be caught half way. Nothing reads ~/.ssh; real ssh never runs.
//
//   node build.mjs && RAVENRYD=<new build> RAVENRYD_OLD=<older build> \
//     node tools/machines-shots.mjs <outDir>
//
// RAVENRYD is the app's build (also what it installs); RAVENRYD_OLD, an
// older version, is put on gpu-box first, so it shows as older and is
// updated while a session runs there. Writes to <outDir>:
//   0-toast.png            the board elsewhere: the toast and the dot
//   1-list.png             the page: older, cannot connect, not installed,
//                          connected
//   2-add.png              Add a machine, with ~/.ssh/config's hosts
//   3-installing.png       an install half way (the copy's bar)
//   4-installed.png        done, every step said
//   5-failures.png         the failures together, then each card:
//   5a-ssh.png 5b-system.png 5c-disk.png 5d-hooks.png 5e-protocol.png
//   6-updated.png          gpu-box after the update, its session on the
//                          old version until it ends
//   7-uninstall.png        Uninstall asks first
//   8-uninstall-sessions.png  sessions still run there
//   9-light-narrow.png     light, 900x700, with a newer machine
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startDemoHub } from './demo-hub.mjs';
import { APP, runApp, stopDaemons, cliEnv } from './run-app.mjs';

guardSpawns();

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'machines-shots'));
const WORK = path.join(OUT, '.work');
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
const OLD = process.env.RAVENRYD_OLD ? path.resolve(process.env.RAVENRYD_OLD) : null;
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const SHORT = process.env.RAVENRY_SHORT_TMP || os.tmpdir();
const tmp = (p) => { const d = fs.mkdtempSync(path.join(SHORT, p)); fs.chmodSync(d, 0o700); return d; };
const RT = tmp('rvm-');
const D = tmp('rvh-'); // the machines, short for their sockets
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const version = (bin) => JSON.parse(execFileSync(bin, ['version', '--json'], { env: cliEnv(RT, WORK), encoding: 'utf8' }));
const V = version(BIN);
const KEY = `${V.os}-${V.arch === 'amd64' ? 'x64' : V.arch}`;

// The app's builds.
function builds(name, bin) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const raw = fs.readFileSync(bin);
  fs.writeFileSync(path.join(dir, `ravenryd-${KEY}.gz`), zlib.gzipSync(raw));
  fs.writeFileSync(path.join(dir, 'builds.json'), JSON.stringify({ version: version(bin).version, builds: { [KEY]: { file: `ravenryd-${KEY}.gz`, sha256: sha(raw), size: raw.length } } }));
  return dir;
}

// The machines and the fake ssh.
const HOSTS = path.join(D, 'h');
const FAKE = path.join(WORK, 'fakessh');
fs.mkdirSync(FAKE, { recursive: true });
fs.writeFileSync(path.join(FAKE, 'ssh'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) host=$1; shift; [ "$1" = "--" ] && shift; break ;;
  esac
done
h='${HOSTS}'/"$host"
if [ ! -d "$h" ]; then echo "ssh: Could not resolve hostname $host: nodename nor servname provided, or not known" >&2; exit 255; fi
if [ -f "$h/deny" ]; then echo "$host: Permission denied (publickey,password)." >&2; exit 255; fi
exec env -i HOME="$h/home" USER=you LOGNAME=you PATH="$h/s:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/sh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR="$h/r" RAVENRY_STATE_DIR="$h/st" SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' /bin/sh -c "$*"
`, { mode: 0o755 });
function machine(name, { stubs = {}, bin = null, deny = false, claude = null } = {}) {
  const h = path.join(HOSTS, name);
  for (const d of ['home', 'r', 'st', 's']) fs.mkdirSync(path.join(h, d), { recursive: true, mode: 0o700 });
  // "you", whatever this machine's user is called.
  fs.writeFileSync(path.join(h, 's', 'id'), '#!/bin/sh\necho you\n', { mode: 0o755 });
  for (const [n, body] of Object.entries(stubs)) fs.writeFileSync(path.join(h, 's', n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (bin) { fs.mkdirSync(path.join(h, 'home', '.ravenry', 'bin'), { recursive: true }); fs.copyFileSync(bin, path.join(h, 'home', '.ravenry', 'bin', 'ravenryd')); fs.chmodSync(path.join(h, 'home', '.ravenry', 'bin', 'ravenryd'), 0o755); }
  if (claude) { fs.mkdirSync(path.join(h, 'home', '.claude'), { recursive: true }); fs.writeFileSync(path.join(h, 'home', '.claude', 'settings.json'), claude); }
  if (deny) fs.writeFileSync(path.join(h, 'deny'), '');
  return { name, home: path.join(h, 'home'), env: { HOME: path.join(h, 'home'), PATH: '/usr/bin:/bin', RAVENRY_RUNTIME_DIR: path.join(h, 'r'), RAVENRY_STATE_DIR: path.join(h, 'st') } };
}
const cmdOf = (m) => path.join(m.home, '.ravenry', 'bin', 'ravenryd');
const all = [];
const gpu = machine('gpu-box', { bin: OLD || BIN }); all.push(gpu);
const devbox = machine('devbox', { bin: BIN }); all.push(devbox);
// The copy waits a while before it reads, so the bar can be caught.
const build = machine('build-mac', { stubs: { gzip: 'sleep 6; exec /usr/bin/gzip "$@"' } }); all.push(build);
const lab = machine('lab-pi', { deny: true }); all.push(lab);
const nas = machine('nas', { stubs: { uname: 'case "$1" in -s) echo FreeBSD;; -m) echo amd64;; *) echo FreeBSD;; esac' } }); all.push(nas);
const tiny = machine('tiny', { stubs: { df: 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/disk3 52000 49000 3000 95% /"' } }); all.push(tiny);
const linbox = machine('linbox', { claude: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/ravenryd hook --assistant claude', timeout: 10 }] }] } }, null, 2) + '\n' }); all.push(linbox);
const odd = machine('old-box'); all.push(odd);
const ODD = path.join(odd.home, 'bin', 'ravenryd');
fs.mkdirSync(path.dirname(ODD), { recursive: true });
fs.writeFileSync(ODD, '#!/bin/sh\ncase "$1" in version) echo \'{"version":"0.1.0","protocol":0,"os":"linux","arch":"amd64"}\';; proxy) cat >/dev/null & printf "HTTP/1.1 400 Bad Request\\r\\n\\r\\n"; exit 1;; esac\n', { mode: 0o755 });

const run = (name, o) => runApp({ name, work: WORK, rt: RT, bin: BIN, ...o });
const shot = (f, el) => ({ shot: path.join(OUT, f), settle: 300, ...(el ? { el } : {}) });
// A card, scrolled into the window first.
const cardShot = (f, el) => [{ js: `document.querySelector(${JSON.stringify(el)}).scrollIntoView({ block: 'center' })` }, { sleep: 150 }, shot(f, el)];
const R = 'window.__ravenry';
const card = (n) => `#machines [data-machine="${n}"]`;
const click = (n, label) => ({ js: `[...document.querySelectorAll('${card(n)} button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()` });
const jobIs = (n, state, timeout = 30000) => ({ until: `(() => { const m = ${R}.machines().list.find((x) => x.name === ${JSON.stringify(n)}); return m && m.job && m.job.state === ${JSON.stringify(state)}; })()`, timeout });
const stateIs = (n, expr, timeout = 30000) => ({ until: `(() => { const m = ${R}.machines().list.find((x) => x.name === ${JSON.stringify(n)}); return m && (${expr}); })()`, timeout });
const addHost = (host) => [
  { js: `document.querySelector('#machines .pg-h .btn.pri').click()` }, { until: `document.getElementById('m-host')` },
  { js: `(() => { const i = document.getElementById('m-host'); i.focus(); i.value = ''; })()` }, { type: host, after: 100 },
  { js: `[...document.querySelectorAll('#machines .m-add button')].find((b) => b.textContent === 'Add and install').click()` },
  { until: `document.querySelector('${card(host)}')`, timeout: 10000 },
];

let hub;
try {
  execFileSync(BIN, ['serve', '--detach'], { env: cliEnv(RT, WORK, path.join(WORK, 'state')) });
  // A session on gpu-box's (older) daemon, which the update must keep.
  execFileSync(OLD || BIN, ['new', '--name', 'Train the model', '--', '/bin/sh', '-c', 'echo training; exec sleep 100000'], { env: gpu.env, encoding: 'utf8' });
  const APPB = builds('app-builds', BIN);
  hub = await startDemoHub({
    dir: path.join(WORK, 'demo'), port: await freePort(), runtime: RT,
    env: { MC_NO_EVENTS: '0', RAVENRY_SSH: path.join(FAKE, 'ssh'), RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state'), RAVENRY_MACHINE_RETRY_MS: '400', RAVENRY_REMOTE_BUILDS: APPB },
    settings: { machines: [
      { name: 'gpu-box', host: 'gpu-box', command: cmdOf(gpu) },
      { name: 'lab-pi', host: 'lab-pi' },
      { name: 'build-mac', host: 'build-mac' },
      { name: 'devbox', host: 'devbox', command: cmdOf(devbox) },
    ] },
    prepare: ({ HOME }) => {
      fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true });
      fs.writeFileSync(path.join(HOME, '.ssh', 'config'), ['devbox', 'gpu-box', 'build-mac', 'lab-pi', 'nas', 'tiny', 'linbox', 'old-box', '*.internal'].map((h) => `Host ${h}\n  HostName ${h}.example.com\n`).join('\n'));
    },
  });
  const steps = [
    { ready: true },
    // The board elsewhere: an older machine says so once, with the way there.
    { until: `${R}.machines().list.length === 4 && ${R}.machines().list.find((m) => m.name === 'gpu-box').compare === ${JSON.stringify(OLD ? 'older' : 'same')}`, timeout: 30000 },
    ...(OLD ? [{ until: `!document.getElementById('toast').hidden && document.querySelector('.m-foot .bdot')`, timeout: 10000 }, shot('0-toast.png')] : []),
    { js: `${R}.setView({ kind: 'machines' })` },
    stateIs('lab-pi', `m.state === 'down'`), stateIs('build-mac', `m.missing`), stateIs('devbox', `m.state === 'connected'`),
    { sleep: 300 }, shot('1-list.png'),
    // Add a machine.
    { js: `document.querySelector('#machines .pg-h .btn.pri').click()` }, { until: `document.getElementById('m-host')` },
    { type: 'linbox', after: 150 }, shot('2-add.png'),
    { js: `[...document.querySelectorAll('#machines .m-add button')].find((b) => b.textContent === 'Cancel').click()` },
    // An install, half way and done.
    click('build-mac', 'Install'),
    { until: `(() => { const s = document.querySelector('${card('build-mac')} .m-step.running[data-step="copy"] .m-bar i'); return s && parseFloat(s.style.width) > 0; })()`, timeout: 20000 },
    { sleep: 500 }, shot('3-installing.png'), ...cardShot('3-installing-card.png', card('build-mac')),
    jobIs('build-mac', 'done', 60000), { sleep: 300 }, shot('4-installed.png'), ...cardShot('4-installed-card.png', card('build-mac')),
    { js: `[...document.querySelectorAll('${card('build-mac')} button')].find((b) => b.textContent === 'Hide steps').click()` },
    // The failures.
    // lab-pi has no Install while ssh fails; the installer says the same.
    { js: `${R}.machines().install('lab-pi')` }, jobIs('lab-pi', 'failed'),
    ...addHost('nas'), jobIs('nas', 'failed'),
    ...addHost('tiny'), jobIs('tiny', 'failed'),
    ...addHost('linbox'), jobIs('linbox', 'done', 60000),
    // old-box runs a ravenryd from before protocol 1 (its command is that
    // binary's path), so the board asks it its version.
    { signal: path.join(WORK, 'oddbox.signal') }, { wait: path.join(WORK, 'oddbox.go'), timeout: 20000 },
    stateIs('old-box', `m.compare === 'protocol'`, 30000),
    { sleep: 400 }, shot('5-failures.png'),
    ...cardShot('5a-ssh.png', card('lab-pi')), ...cardShot('5b-system.png', card('nas')), ...cardShot('5c-disk.png', card('tiny')), ...cardShot('5d-hooks.png', card('linbox')), ...cardShot('5e-protocol.png', card('old-box')),
  ];
  if (OLD) {
    steps.push(
      click('gpu-box', 'Update gpu-box'), jobIs('gpu-box', 'done', 60000),
      stateIs('gpu-box', `m.older && m.older.length`, 20000), { sleep: 400 },
      { js: `document.querySelector('#machines .pg-b').scrollTop = 0` }, shot('6-updated.png'), ...cardShot('6-updated-card.png', card('gpu-box')),
    );
  }
  steps.push(
    { js: `[...document.querySelectorAll('${card('devbox')} button')].find((b) => b.textContent === 'Uninstall').click()` },
    { until: `document.querySelector('${card('devbox')} .m-confirm')` }, ...cardShot('7-uninstall.png', card('devbox')),
    { js: `[...document.querySelectorAll('${card('devbox')} .m-confirm button')].find((b) => b.textContent === 'Cancel').click()` },
  );
  if (OLD) {
    steps.push(
      { js: `${R}.machines().uninstall('gpu-box')` }, jobIs('gpu-box', 'needs'), { sleep: 300 },
      ...cardShot('8-uninstall-sessions.png', card('gpu-box')),
    );
  }
  const app = run('machines', { home: hub.home, hubUrl: hub.url, steps, timeoutMs: 300000, env: { RAVENRY_SERVICE: 'off' } });
  // old-box joins with its odd ravenryd's path as its command.
  const odd = (async () => {
    while (!fs.existsSync(path.join(WORK, 'oddbox.signal'))) await new Promise((r) => setTimeout(r, 50));
    const ad = await fetch(hub.url + '/api/machines/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify({ name: 'old-box', host: 'old-box', command: ODD }) });
    if (!ad.ok) throw new Error(`old-box: ${ad.status} ${await ad.text()}`);
    fs.writeFileSync(path.join(WORK, 'oddbox.go'), '1');
  })();
  await Promise.all([app, odd]).catch(async (e) => {
    console.error(`the board said:\n${hub.log().slice(-3000)}\nmachines: ${JSON.stringify((await (await fetch(hub.url + '/api/machines')).json()).machines.map((m) => [m.name, m.state, m.version, m.compare, m.error]))}`);
    throw e;
  });
  hub.stop(); hub = null;

  // ------------------------------------------------ light, narrow, an app older than devbox
  if (OLD) {
    hub = await startDemoHub({
      dir: path.join(WORK, 'demo-light'), port: await freePort(), runtime: RT,
      env: { MC_NO_EVENTS: '0', RAVENRY_SSH: path.join(FAKE, 'ssh'), RAVENRY_DAEMON_BIN: BIN, RAVENRY_STATE_DIR: path.join(WORK, 'hub-state2'), RAVENRY_MACHINE_RETRY_MS: '400', RAVENRY_REMOTE_BUILDS: builds('old-builds', OLD) },
      settings: { machines: [{ name: 'devbox', host: 'devbox', command: cmdOf(devbox) }, { name: 'build-mac', host: 'build-mac', command: cmdOf(build) }] },
    });
    await run('light', {
      home: hub.home, hubUrl: hub.url, width: 900, height: 700, env: { RAVENRY_SERVICE: 'off', RAVENRY_THEME: 'light' },
      steps: [
        { ready: true }, { js: `${R}.setView({ kind: 'machines' })` },
        stateIs('devbox', `m.compare === 'newer'`), stateIs('build-mac', `m.state === 'connected'`), { sleep: 300 },
        shot('9-light-narrow.png'),
      ],
    });
  }
  console.log(`shots in ${OUT}`);
} finally {
  if (hub) hub.stop();
  stopDaemons(BIN, RT);
  for (const m of all) for (const b of [cmdOf(m), BIN, OLD].filter(Boolean)) { if (fs.existsSync(b)) stopDaemons(b, m.env.RAVENRY_RUNTIME_DIR); }
  fs.rmSync(D, { recursive: true, force: true });
}
