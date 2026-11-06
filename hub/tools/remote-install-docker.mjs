// The remote installer (server/remoteinstall.mjs) against real sshd, in
// Linux containers: real login shells, real Linux builds of ravenryd, real
// BusyBox tools, a real full disk and a jump host. Run by hand (it needs
// Docker and takes a few minutes); tools/remote-install-test.mjs is the
// quick one through a fake ssh that CI runs.
//
//   RAVENRY_LINUX_BUILDS=<dir> node tools/remote-install-docker.mjs [--keep] [--assistants]
//
// <dir> holds ravenryd-linux-arm64 and/or ravenryd-linux-x64 (the release
// workflow's artifacts, or apps/desktop/scripts/build-ravenryd.sh run in a
// Linux container). The machines:
//   deb-bash, deb-zsh, deb-fish  Debian users whose login shell is bash,
//                                zsh and fish; each one's startup files
//                                print a banner on stdout, and sshd prints
//                                a MOTD
//   deb-tiny                     a home on a 12 MB tmpfs: the copy does not
//                                fit
//   deb-fill                     ~/.ravenry on a 6 MB tmpfs while the home
//                                has room: the disk fills during the copy
//   alpine                       BusyBox's sh, base64, df, gzip, sha256sum
//   amd64                        on an arm64 Docker, Debian under
//                                linux/amd64 emulation, for the linux-x64
//                                build (Rosetta: checked up to its hooks)
//   jumped                       reached only through another container
//                                with ProxyJump
// Each gets installed, checked (connected at the build's version, the hook
// command run in a real pane there reports the agent to its daemon, the
// shell's prompt marks there), installed again (nothing changes) and
// uninstalled (nothing of Ravenry's left). ssh runs with a throwaway key,
// known_hosts and config (-F) in a temporary folder: ~/.ssh is never read.
// sshd listens on 127.0.0.1 only. The containers, their network and the
// images built here are removed at the end (--keep leaves them).
// --assistants also runs the real Claude Code and Codex (from npm, no
// account) on the hook entries the installer writes: see below.
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUILDS = process.env.RAVENRY_LINUX_BUILDS && path.resolve(process.env.RAVENRY_LINUX_BUILDS);
const KEEP = process.argv.includes('--keep');
if (!BUILDS) { console.log('SKIP  remote-install-docker: set RAVENRY_LINUX_BUILDS to a folder with ravenryd-linux-arm64 and/or ravenryd-linux-x64'); process.exit(0); }
try { execFileSync('docker', ['info'], { stdio: 'ignore' }); } catch { console.log('SKIP  remote-install-docker: Docker is not running'); process.exit(0); }

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'remote-install-docker-'));
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: {}, projects: [] }));
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvd-'));
const LABEL = 'ravenry-rit=1';
const TAG = `ravenry-rit-${process.pid}`;
const NET = `${TAG}-net`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + String(detail).slice(0, 600) : ''}`); if (!ok) fails++; };
const say = (s) => console.log(`--    ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100); } }
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();

// ------------------------------------------------------------ the builds
const builds = {};
let version = null;
for (const key of ['linux-arm64', 'linux-x64']) {
  const f = path.join(BUILDS, `ravenryd-${key}`);
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f);
  fs.writeFileSync(path.join(D, `ravenryd-${key}.gz`), zlib.gzipSync(raw));
  builds[key] = { file: `ravenryd-${key}.gz`, sha256: sha(raw), size: raw.length };
}
// The containers run natively on Docker's own architecture; on an arm64
// Docker the linux-x64 build also runs under linux/amd64 emulation.
const NATIVE = /^(aarch64|arm64)$/.test(docker('info', '--format', '{{.Architecture}}')) ? 'linux-arm64' : 'linux-x64';
if (!builds[NATIVE]) { console.error(`no ravenryd-${NATIVE} in ${BUILDS}: Docker here runs ${NATIVE}`); process.exit(1); }
const EMULATE = NATIVE === 'linux-arm64' && builds['linux-x64'];

// ------------------------------------------------------------ images
const SSHD = 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nPrintMotd yes\nAllowTcpForwarding yes\nUsePAM no\n';
const DEBIAN = `FROM debian:bookworm-slim
RUN apt-get update -q && apt-get install -y -q --no-install-recommends openssh-server bash zsh fish procps && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && ssh-keygen -A
RUN for u in bash zsh fish; do useradd -m -s /bin/$u u$u || useradd -m -s /usr/bin/$u u$u; done; useradd -m -s /bin/bash utiny; useradd -m -s /bin/bash ufill; useradd -m -s /bin/bash ujump; for u in ubash uzsh ufish utiny ufill ujump; do usermod -p '*' $u; done
RUN printf '${SSHD.replace(/\n/g, '\\n')}' > /etc/ssh/sshd_config.d/ravenry.conf && echo 'Welcome to a test box (MOTD).' > /etc/motd
`;
const ALPINE = `FROM alpine:3.20
RUN apk add --no-cache openssh-server && ssh-keygen -A && adduser -D -s /bin/sh uash && passwd -u uash >/dev/null 2>&1 || true
RUN printf '${SSHD.replace(/\n/g, '\\n')}' > /etc/ssh/sshd_config.d/ravenry.conf 2>/dev/null || printf '${SSHD.replace(/\n/g, '\\n')}' >> /etc/ssh/sshd_config
`;
// At start: the key for every user, then the banners each shell prints on
// stdout when sshd runs a command through it, then sshd.
const ENTRY = `#!/bin/sh
for h in /home/*; do
  u=$(basename "$h"); id "$u" >/dev/null 2>&1 || continue
  mkdir -p "$h/.ssh" && cp /keys/id.pub "$h/.ssh/authorized_keys"
  echo 'echo "bashrc says hello"' > "$h/.bashrc"
  echo 'echo "zshenv says hello"' > "$h/.zshenv"
  mkdir -p "$h/.config/fish" && echo 'echo "config.fish says hello"' > "$h/.config/fish/config.fish"
  echo 'echo "profile says hello"' > "$h/.profile"
  chown -R "$u:$u" "$h/.ssh" "$h/.bashrc" "$h/.zshenv" "$h/.config" "$h/.profile"; chmod 700 "$h/.ssh"; chmod 600 "$h/.ssh/authorized_keys"
done
exec /usr/sbin/sshd -D -e
`;
function image(name, dockerfile, platform = null) {
  const tag = `${TAG}-${name}`;
  const t0 = Date.now();
  const r = spawnSync('docker', ['build', '-q', '--label', LABEL, ...(platform ? ['--platform', platform] : []), '-t', tag, '-'], { input: dockerfile, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker build ${name}: ${r.stderr}`);
  say(`image ${tag} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return tag;
}

// ------------------------------------------------------------ ssh: a throwaway key, known_hosts and config
const SSH = path.join(D, 'ssh');
fs.mkdirSync(SSH, { mode: 0o700 });
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ravenry-test', '-f', path.join(SSH, 'id')]);
fs.mkdirSync(path.join(D, 'keys'));
fs.copyFileSync(path.join(SSH, 'id.pub'), path.join(D, 'keys', 'id.pub'));
fs.writeFileSync(path.join(D, 'entry.sh'), ENTRY, { mode: 0o755 });
const CONFIG = path.join(SSH, 'config');
const WRAP = path.join(D, 'ssh-wrap');
// The installer's ssh, with this config only: never ~/.ssh.
fs.writeFileSync(WRAP, `#!/bin/sh\nexec ssh -F '${CONFIG}' "$@"\n`, { mode: 0o755 });
const hostBlock = (alias, user, port, extra = '') => `Host ${alias}\n  HostName 127.0.0.1\n  Port ${port}\n  User ${user}\n${extra}`;
const COMMON = `Host *\n  IdentityFile ${path.join(SSH, 'id')}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${path.join(SSH, 'known_hosts')}\n  StrictHostKeyChecking accept-new\n  LogLevel ERROR\n`;

const containers = [];
function run(name, img, args = [], platform = null) {
  const cname = `${TAG}-${name}`;
  docker('run', '-d', '--name', cname, '--label', LABEL, '--network', NET, '--network-alias', name, ...(platform ? ['--platform', platform] : []),
    '-v', `${path.join(D, 'keys')}:/keys:ro`, '-v', `${path.join(D, 'entry.sh')}:/entry.sh:ro`, ...args, img, '/entry.sh');
  containers.push(cname);
  return cname;
}
const portOf = (c) => Number(docker('port', c, '22/tcp').split('\n')[0].split(':').pop());
const sh = (c, user, line) => { const r = spawnSync('docker', ['exec', '-u', user, c, 'sh', '-c', line], { encoding: 'utf8' }); return (r.stdout || '') + (r.stderr || ''); };

function cleanup() {
  if (KEEP) { console.log(`kept: ${containers.join(' ')} (network ${NET})`); return; }
  for (const c of containers) spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', NET], { stdio: 'ignore' });
  for (const t of ['debian', 'alpine', 'debian-amd64']) spawnSync('docker', ['rmi', '-f', `${TAG}-${t}`], { stdio: 'ignore' });
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const t0 = Date.now();
docker('network', 'create', '--label', LABEL, NET);
const DEB = image('debian', DEBIAN);
const ALP = image('alpine', ALPINE);
const AMD = EMULATE ? image('debian-amd64', DEBIAN, 'linux/amd64') : null;
const uid = (img, u) => Number(docker('run', '--rm', img, 'id', '-u', u));
const tinyId = uid(DEB, 'utiny');
const fillId = uid(DEB, 'ufill');
const pub = ['-p', '127.0.0.1::22'];
// A user's home in the containers (built, so no literal home path is here).
const homeDir = (u) => ['', 'home', u].join('/');
const deb = run('deb', DEB, [...pub, '--tmpfs', `${homeDir('utiny')}:rw,size=12m,mode=0755,uid=${tinyId},gid=${tinyId}`, '--tmpfs', `${homeDir('ufill')}/.ravenry:rw,size=6m,mode=0700,uid=${fillId},gid=${fillId}`]);
const alp = run('alpine', ALP, pub);
const amd = AMD ? run('amd64', AMD, pub, 'linux/amd64') : null;
// The jump host is published; the machine behind it is not.
const jump = run('jump', DEB, pub);
const inner = run('inner', DEB, []);
await sleep(1500);
const P = { deb: portOf(deb), alpine: portOf(alp), jump: portOf(jump), ...(amd ? { amd64: portOf(amd) } : {}) };
fs.writeFileSync(CONFIG, [
  hostBlock('deb-bash', 'ubash', P.deb), hostBlock('deb-zsh', 'uzsh', P.deb), hostBlock('deb-fish', 'ufish', P.deb),
  hostBlock('deb-tiny', 'utiny', P.deb), hostBlock('deb-fill', 'ufill', P.deb), hostBlock('alpine', 'uash', P.alpine),
  ...(amd ? [hostBlock('amd64', 'ubash', P.amd64)] : []),
  hostBlock('jumphost', 'ujump', P.jump),
  `Host jumped\n  HostName inner\n  User ubash\n  ProxyJump jumphost\n`,
  COMMON,
].join('\n'));
say(`containers up in ${Math.round((Date.now() - t0) / 1000)} s (sshd on 127.0.0.1 only: ${JSON.stringify(P)})`);
check('every published sshd listens on 127.0.0.1 only', [deb, alp, jump, amd].filter(Boolean).every((c) => /^127\.0\.0\.1:\d+$/.test(docker('port', c, '22/tcp').split('\n')[0])), [deb, alp, jump].map((c) => docker('port', c, '22/tcp')).join(' | '));
for (const h of ['deb-bash', 'alpine', 'jumped']) {
  const r = await until(() => { const x = spawnSync(WRAP, ['-o', 'BatchMode=yes', h, 'true'], { encoding: 'utf8' }); return x.status === 0 ? x : null; }, 30000);
  check(`ssh reaches ${h} with the throwaway key`, !!r);
}
const banner = spawnSync(WRAP, ['-T', '-o', 'BatchMode=yes', 'deb-bash', '--', 'echo', 'hi'], { encoding: 'utf8' });
check('the login shell prints a banner on stdout before the command\'s output (what the installer must ignore)', /bashrc says hello\nhi/.test(banner.stdout), JSON.stringify(banner.stdout));

// ------------------------------------------------------------ the hub
process.env.RAVENRY_HOME = MC;
process.env.RAVENRY_RUNTIME_DIR = path.join(D, 'lrun');
process.env.RAVENRY_STATE_DIR = path.join(D, 'lstate');
process.env.RAVENRY_DAEMON_BIN = 'none';
process.env.RAVENRY_SSH = WRAP;
process.env.RAVENRY_MACHINE_RETRY_MS = '500';
const machines = await import('../server/machines.mjs');
const ri = await import('../server/remoteinstall.mjs');
const nc = await import('../../packages/node-client/index.mjs');
const hk = await import('../server/hookinstall.mjs');
machines.start({ connect: nc.connect });

// The version the builds say (ask the arm64 one in a container).
const vout = docker('run', '--rm', '-v', `${BUILDS}:/b:ro`, DEB, `/b/ravenryd-${NATIVE}`, 'version', '--json');
version = JSON.parse(vout).version;
fs.writeFileSync(path.join(D, 'builds.json'), JSON.stringify({ version, builds }));
process.env.RAVENRY_REMOTE_BUILDS = D;
say(`builds ${Object.keys(builds).join(', ')}, version ${version}`);

const stepsOf = (j) => j.steps.map((s) => `${s.id}:${s.state}`).join(' ');
async function job(name, o = {}, kind = 'install') {
  const r = kind === 'install' ? ri.install(name, o) : ri.uninstall(name, o);
  if (!r.ok) return { error: r.error, steps: [], state: 'refused' };
  await ri.settled(name);
  return ri.job(name);
}
const view = (n) => ri.view().find((m) => m.name === n);
const homeOf = { 'deb-bash': [deb, 'ubash'], 'deb-zsh': [deb, 'uzsh'], 'deb-fish': [deb, 'ufish'], 'deb-tiny': [deb, 'utiny'], 'deb-fill': [deb, 'ufill'], alpine: [alp, 'uash'], ...(amd ? { amd64: [amd, 'ubash'] } : {}), jumped: [inner, 'ubash'] };
const filesIn = (c, u) => sh(c, u, 'cd && find . -type f -o -type l | grep -v "^./.ssh/" | grep -v -E "^./(.bashrc|.zshenv|.profile|.config/fish/config.fish)$" | grep -v "^./.local/state/" | sort').trim().split('\n').filter(Boolean);

// A session's hook, run for real in a pane there by the user's login shell:
// the daemon then knows the pane's agent.
async function hookInPane(name) {
  const link = machines.connected().find((x) => x.name === name);
  if (!link) return { ok: false, why: 'not connected' };
  const { pane } = await link.c.request('pane.new', { cols: 100, rows: 20 });
  const bin = '~/.ravenry/bin/ravenryd';
  const line = `echo '{"hook_event_name":"SessionStart","session_id":"s-${name}","cwd":"/tmp","source":"startup"}' | ${bin} hook --assistant claude && echo hook-ran-0`;
  // The shell's first prompt drawn (or a moment, for a shell with no marks).
  await until(async () => { const { panes } = await link.c.request('pane.list', {}); const x = panes.find((y) => y.id === pane.id); return x && x.shell; }, 4000);
  await link.c.request('pane.send', { pane: pane.id, input: [{ text: line, mode: 'paste' }, { key: 'Enter' }] });
  const seen = await until(async () => {
    const { panes } = await link.c.request('pane.list', {});
    const p = panes.find((x) => x.id === pane.id);
    return p && p.agent ? p : null;
  }, 15000);
  const cap = await link.c.request('pane.capture', { pane: pane.id, history: 40 });
  const text = cap.lines.map((l) => l.text).join('\n');
  const { panes } = await link.c.request('pane.list', {});
  const p = panes.find((x) => x.id === pane.id);
  await link.c.request('pane.close', { pane: pane.id }).catch(() => {});
  return { ok: !!seen && /hook-ran-0/.test(text), agent: seen && seen.agent, shell: p && p.shell, mark: p && p.mark, text: text.trim().split('\n').slice(-3).join(' / ') };
}

// ------------------------------------------------------------ each machine
// Docker Desktop on Apple silicon runs linux/amd64 through Rosetta, which
// trips its own assertion (is_rosetta_process) inside ravenryd's daemon
// once a client connects, as it does in procps: there the install is checked up to its hooks, and the
// daemon of the linux-x64 build is proven on real x86-64 by desktop.yml's
// smoke job instead.
const rosetta = amd ? /VirtualApple/.test(sh(amd, 'root', 'cat /proc/cpuinfo')) : false;
const hostsOk = ['deb-bash', 'deb-zsh', 'deb-fish', 'alpine', ...(amd ? ['amd64'] : []), 'jumped'];
for (const name of hostsOk) {
  try { await oneMachine(name); } catch (e) { check(`${name}: no exception`, false, e.stack || e); }
}
async function oneMachine(name) {
  const [c, u] = homeOf[name];
  const base = filesIn(c, u);
  machines.add({ name, host: name });
  const t1 = Date.now();
  const j = await job(name);
  const secs = ((Date.now() - t1) / 1000).toFixed(1);
  const want = name === 'amd64' ? 'linux-x64' : NATIVE;
  if (name === 'amd64' && rosetta) {
    check(`amd64 (Rosetta): the ${want} build is found, copied, checked by SHA-256, run once, and the hooks written (${secs} s)`, ['reach', 'system', 'copy', 'hooks'].every((id) => j.steps.find((x) => x.id === id).state === 'done') && (j.steps[1].detail || '').includes(want) && sh(c, u, 'cat ~/.claude/settings.json').includes(`/home/${u}/.ravenry/bin/ravenryd hook --assistant claude`), stepsOf(j));
    console.log(`SKIP  amd64: the daemon under Rosetta (${(j.steps[4].detail || '').slice(0, 120)})`);
    const u0 = await job(name, { endSessions: true }, 'uninstall');
    const left0 = filesIn(c, u).filter((f) => !/\.bak-/.test(f) && !base.includes(f));
    check('amd64 (Rosetta): uninstall, nothing of Ravenry\'s left', u0.state === 'done' && left0.length === 0, stepsOf(u0) + ' ' + left0.join(', '));
    return;
  }
  check(`${name}: install, every step done (${secs} s)`, j.state === 'done' && j.steps.every((s) => s.state === 'done'), stepsOf(j) + ' ' + JSON.stringify(j.steps.filter((s) => s.state !== 'done')));
  check(`${name}: the ${want} build`, (j.steps[1].detail || '').includes(want), j.steps[1].detail);
  const v = view(name);
  check(`${name}: connected to ravenryd ${version} (${v.os}/${v.arch}), takes the hub's answers`, v.state === 'connected' && v.version === version && v.answers === true && v.os === 'linux', JSON.stringify({ state: v.state, version: v.version, os: v.os, arch: v.arch, error: v.error }));
  const set = sh(c, u, 'cat ~/.claude/settings.json');
  check(`${name}: Claude Code's settings run the installed ravenryd hook`, set.includes(`/home/${u}/.ravenry/bin/ravenryd hook --assistant claude`), set.slice(0, 200));
  const h = await hookInPane(name);
  check(`${name}: the hook command, run in a real pane by its login shell, reports the agent to the daemon there`, h.ok && h.agent && h.agent.assistant === 'claude', JSON.stringify(h));
  // ravenryd integrates bash, zsh and fish; BusyBox's ash gets no marks.
  if (name !== 'alpine') check(`${name}: the login shell in a pane there sends Ravenry's prompt marks (shell integration)`, !!h.shell, JSON.stringify({ shell: h.shell, mark: h.mark }));
  else check('alpine: BusyBox ash in a pane there runs without marks, as documented', !h.shell, JSON.stringify(h.shell));
  const sums = () => sh(c, u, 'cd && find . -type f ! -path ./.ravenry/remote-install.json ! -path "./.local/*" -exec sha256sum {} + | sort');
  const before = sums();
  const j2 = await job(name);
  const after = sums();
  check(`${name}: run again, nothing copied, nothing changed but the record`, j2.state === 'done' && /nothing copied/.test(j2.steps[2].detail) && /nothing changed/.test(j2.steps[3].detail) && before === after, `${stepsOf(j2)} ${before} | ${after}`);
  const u1 = await job(name, { endSessions: true }, 'uninstall');
  // The shell the pane ran keeps its history: that is the shell's, not Ravenry's.
  const left = filesIn(c, u).filter((f) => !/\.bak-/.test(f) && !base.includes(f) && !/^\.\/(\.(ash|sh|bash|zsh)_history|\.local\/share\/fish\/.*|\.config\/fish\/fish_variables)$/.test(f));
  check(`${name}: uninstall, nothing of Ravenry's left in the home`, u1.state === 'done' && left.length === 0 && !view(name), stepsOf(u1) + ' ' + left.join(', '));
  // From /proc, not pgrep (procps crashes under Rosetta's amd64 emulation).
  const count = () => sh(c, 'root', `n=0; for p in /proc/[0-9]*; do [ "$(stat -c %U $p 2>/dev/null)" = ${u} ] && tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q ravenryd && n=$((n+1)); done; echo $n`).trim();
  const procs = await until(() => (count() === '0' ? '0' : null), 5000);
  check(`${name}: and its daemon stopped`, procs === '0', count());
}


// ------------------------------------------------------------ a full disk
machines.add({ name: 'deb-tiny', host: 'deb-tiny' });
const ft = await job('deb-tiny');
check('a home on a 12 MB tmpfs: the copy is refused before it starts, saying how much is free', ft.state === 'failed' && ft.steps[2].state === 'failed' && /MB free in \/home\/utiny; ravenryd needs/.test(ft.steps[2].detail) && filesIn(deb, 'utiny').length === 0, ft.steps[2].detail);
machines.add({ name: 'deb-fill', host: 'deb-fill' });
const ff = await job('deb-fill');
const fillLeft = sh(deb, 'ufill', 'ls -A ~/.ravenry ~/.ravenry/bin 2>&1; df -k ~/.ravenry | tail -1');
check('~/.ravenry on a 6 MB tmpfs: the disk fills during the copy, says so, and the part is removed', ff.state === 'failed' && ff.steps[2].state === 'failed' && /disk filled up/.test(ff.steps[2].detail) && !/ravenryd\.part/.test(fillLeft), `${ff.steps[2].detail} | ${fillLeft}`);

// ------------------------------------------------------------ hooks set up by hand, on a real machine
const HAND = '/usr/local/bin/ravenryd hook --assistant claude';
sh(deb, 'ubash', `mkdir -p ~/.claude && printf '%s' '${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }] } })}' > ~/.claude/settings.json`);
machines.add({ name: 'deb-hand', host: 'deb-bash' });
const jh = await job('deb-hand');
check('hooks set up by hand there: left alone, with the warning', jh.state === 'done' && jh.steps[3].state === 'warn' && sh(deb, 'ubash', 'cat ~/.claude/settings.json').includes(HAND), stepsOf(jh));
const jr = await job('deb-hand', { replaceHooks: true });
check('use Ravenry\'s instead: replaced', jr.steps[3].state === 'done' && !sh(deb, 'ubash', 'cat ~/.claude/settings.json').includes(HAND));
const ju = await job('deb-hand', { endSessions: true }, 'uninstall');
const back = JSON.parse(sh(deb, 'ubash', 'cat ~/.claude/settings.json'));
check('uninstall puts the hand-made hook back', ju.state === 'done' && JSON.stringify(back) === JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }] } }), JSON.stringify(back));
// ------------------------------------------------------------ the real assistants read what was installed
// --assistants: Claude Code and Codex from npm, in a Node container, with
// the settings the installer writes (the same plan, for that home), a fake
// key and no account. Each starts a session that fails at the API; before
// that it runs its hooks, and a stand-in at the installed ravenryd's path
// writes down what it was run with. Codex runs a hook only when its trust
// entry in config.toml matches, so this proves those too.
if (process.argv.includes('--assistants')) {
  const A = path.join(D, 'assistants');
  const NODE = homeDir('node');
  const BIN = `${NODE}/.ravenry/bin/ravenryd`;
  fs.mkdirSync(path.join(A, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(A, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(A, '.claude', 'settings.json'), JSON.stringify(hk.plan({}, { ravenryd: BIN, scripts: false }).settings, null, 2));
  const cp = hk.codexPlanOf({ file: `${NODE}/.codex/hooks.json`, raw: null, json: {} }, { file: `${NODE}/.codex/config.toml`, raw: null }, { ravenryd: BIN, scripts: false });
  fs.writeFileSync(path.join(A, '.codex', 'hooks.json'), JSON.stringify(cp.hooks.json, null, 2));
  fs.writeFileSync(path.join(A, '.codex', 'config.toml'), cp.config.text);
  fs.writeFileSync(path.join(A, 'stand-in'), '#!/bin/sh\necho "ran: $*" >> /tmp/hook.log\nhead -c 400 >> /tmp/hook.log\necho >> /tmp/hook.log\n', { mode: 0o755 });
  const script = [
    'npm i -g @anthropic-ai/claude-code @openai/codex >/dev/null 2>&1',
    `mkdir -p ${NODE}/.ravenry/bin /work && cp /a/stand-in ${BIN} && cp -r /a/.claude /a/.codex ${NODE}/ && chown -R node ${NODE} /work`,
    'echo "claude $(claude --version)"; echo "codex $(codex --version)"',
    `cd /work && su node -c "HOME=${NODE} ANTHROPIC_API_KEY=sk-ant-api03-not-a-key timeout 90 claude -p hi" >/dev/null 2>&1; echo "== claude"; cat /tmp/hook.log; : > /tmp/hook.log`,
    `su node -c "HOME=${NODE} OPENAI_API_KEY=sk-not-a-key timeout 30 codex exec --skip-git-repo-check hi" >/dev/null 2>&1; echo "== codex"; cat /tmp/hook.log`,
  ].join('; ');
  const r = spawnSync('docker', ['run', '--rm', '--label', LABEL, '-v', `${A}:/a:ro`, 'node:22-bookworm-slim', 'sh', '-c', script], { encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const [, claudeLog = '', codexLog = ''] = out.split(/^== (?:claude|codex)$/m);
  say(out.split('\n').filter((l) => /^(claude|codex) /.test(l)).join(', '));
  check('Claude Code runs the installed `ravenryd hook --assistant claude` on SessionStart, UserPromptSubmit and SessionEnd', ['SessionStart', 'UserPromptSubmit', 'SessionEnd'].every((ev) => new RegExp(`ran: hook --assistant claude\\n\\{[^\\n]*"hook_event_name":"${ev}"`).test(claudeLog)), claudeLog.slice(0, 400));
  check('Codex runs the installed `ravenryd hook --assistant codex` (its trust entries match)', /ran: hook --assistant codex\n\{[^\n]*"hook_event_name":"SessionStart"/.test(codexLog), codexLog.slice(0, 400));
}

machines.stop();
console.log(`\nMEASURE  remote-install-docker: ${Math.round((Date.now() - t0) / 1000)} s in all`);
console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
