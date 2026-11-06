// Proves the remote installer (server/remoteinstall.mjs) and the versions
// a machine reports (server/machines.mjs), against real ravenryd builds
// behind a fake ssh. Each "machine" is a throwaway home folder with its
// own daemon folders; the fake ssh runs the command line there through sh,
// as sshd does through the login shell, with stand-ins on its PATH where a
// machine must look otherwise (uname for Linux or FreeBSD, df for a full
// disk, gzip and cat for a disk that fills up), and every login prints a
// banner on stdout first. Nothing reads ~/.ssh, and real ssh is never run
// (tools/remote-install-docker.mjs runs real sshd in containers). It checks:
//   - a fresh machine shows as not installed (its command exits 127);
//   - install: every step done, the binary in ~/.ravenry/bin with the
//     app's SHA-256, the `ravenry` link, the daemon's hook in Claude Code's
//     settings and in Codex's hooks.json with its trust entries (the
//     person's own hooks and settings kept, each file backed up), the
//     manifest, and the board connected to that version;
//   - run again: nothing copied, no file written, no new backup;
//   - another system (uname says so) gets its own build; hooks set up by hand
//     are left alone (a warning), then replaced when asked;
//   - ssh that needs a password, a system with no build, a full disk
//     (before the copy and while copying, nothing left behind);
//   - versions: older (an update while a session runs there keeps the
//     session, reached on the old daemon beside the new one), newer, and a
//     ravenryd that speaks another protocol;
//   - uninstall: stops and asks while a session runs, then removes exactly
//     what was installed and puts back the hooks it replaced.
//
// Usage: RAVENRYD_BIN=../daemon/ravenryd [RAVENRYD_OLD_BIN=<an older build>
//        RAVENRYD_NEW_BIN=<a newer build>] node tools/remote-install-test.mjs
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = process.env.RAVENRYD_BIN && path.resolve(process.env.RAVENRYD_BIN);
if (!BIN) {
  console.log('SKIP  remote-install-test: set RAVENRYD_BIN to a ravenryd binary');
  process.exit(0);
}
const OLD = process.env.RAVENRYD_OLD_BIN && path.resolve(process.env.RAVENRYD_OLD_BIN);
const NEW = process.env.RAVENRYD_NEW_BIN ? path.resolve(process.env.RAVENRYD_NEW_BIN) : BIN;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'remote-install-test-'));
const MC = path.join(T, 'mc');
fs.mkdirSync(MC, { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { handoffThreshold: 50, contextWindow: 1000000 }, projects: [] }, null, 2));
// Short folders outside the repo (unix socket paths are short).
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvi-'));
const HOSTS = path.join(D, 'hosts');
const FAKE = path.join(D, 'fakebin');
fs.mkdirSync(FAKE, { recursive: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const QUIET = { HOME: D, PATH: '/usr/bin:/bin', RAVENRY_RUNTIME_DIR: path.join(D, 'vrun'), RAVENRY_STATE_DIR: path.join(D, 'vstate') };
const vjson = (bin) => JSON.parse(execFileSync(bin, ['version', '--json'], { encoding: 'utf8', env: QUIET }));
const HOST_V = vjson(BIN);
const HOST_KEY = `${HOST_V.os}-${HOST_V.arch === 'amd64' ? 'x64' : HOST_V.arch}`;

// The fake ssh: the host's folder says how that machine is; unknown hosts
// do not resolve, a host with `deny` wants a password.
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
echo "$host $*" >> '${D}/ssh-log'
if [ ! -d "$h" ]; then echo "ssh: Could not resolve hostname $host: nodename nor servname provided, or not known" >&2; exit 255; fi
if [ -f "$h/deny" ]; then echo "$host: Permission denied (publickey,password)." >&2; exit 255; fi
# A login shell whose startup files print on stdout, as a .bashrc that
# echoes does: nothing may take it for the daemon's or the script's output.
echo "Welcome to $host"
exec env -i HOME="$h/home" PATH="$h/stubs:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/sh LANG=en_US.UTF-8 RAVENRY_RUNTIME_DIR="$h/run" RAVENRY_STATE_DIR="$h/state" SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' /bin/sh -c "$*"
`, { mode: 0o755 });

function machine(name, { stubs = {}, claude = null, codex = null, deny = false } = {}) {
  const h = path.join(HOSTS, name);
  for (const d of ['home', 'run', 'state', 'stubs']) fs.mkdirSync(path.join(h, d), { recursive: true, mode: 0o700 });
  for (const [n, body] of Object.entries(stubs)) fs.writeFileSync(path.join(h, 'stubs', n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (claude != null) { fs.mkdirSync(path.join(h, 'home', '.claude'), { recursive: true }); fs.writeFileSync(path.join(h, 'home', '.claude', 'settings.json'), claude); }
  if (codex != null) { fs.mkdirSync(path.join(h, 'home', '.codex'), { recursive: true }); if (codex) fs.writeFileSync(path.join(h, 'home', '.codex', 'config.toml'), codex); }
  if (deny) fs.writeFileSync(path.join(h, 'deny'), '');
  return { name, dir: h, home: path.join(h, 'home'), env: { HOME: path.join(h, 'home'), PATH: `${path.join(h, 'stubs')}:/usr/bin:/bin`, RAVENRY_RUNTIME_DIR: path.join(h, 'run'), RAVENRY_STATE_DIR: path.join(h, 'state') } };
}

// The app's builds: builds.json and one gzipped binary per system.
function buildsDir(name, entries) {
  const dir = path.join(D, name);
  fs.mkdirSync(dir, { recursive: true });
  const builds = {};
  let version = null;
  for (const [key, file, ver] of entries) {
    const raw = fs.readFileSync(file);
    fs.writeFileSync(path.join(dir, `ravenryd-${key}.gz`), zlib.gzipSync(raw));
    builds[key] = { file: `ravenryd-${key}.gz`, sha256: sha(raw), size: raw.length };
    version = version || ver;
  }
  fs.writeFileSync(path.join(dir, 'builds.json'), JSON.stringify({ version, builds }, null, 2));
  return dir;
}
// A build for another Linux: a script that is this machine's ravenryd, so
// the fake machine (uname says that system) runs it for real. And a system
// the app has no build for.
const LIN_KEY = HOST_KEY === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
const NONE_KEY = ['linux-arm64', 'darwin-x64', 'linux-x64'].find((k) => k !== HOST_KEY && k !== LIN_KEY);
const unameFor = (key) => { const [o, a] = key.split('-'); return `case "$1" in -s) echo ${o === 'linux' ? 'Linux' : 'Darwin'};; -m) echo ${a === 'x64' ? 'x86_64' : o === 'linux' ? 'aarch64' : 'arm64'};; *) echo ${o === 'linux' ? 'Linux' : 'Darwin'};; esac`; };
const LINUX = path.join(D, 'ravenryd-linux-stand-in');
fs.writeFileSync(LINUX, `#!/bin/sh\nexec '${NEW}' "$@"\n`, { mode: 0o755 });
const NEW_V = vjson(NEW).version;
const APP = buildsDir('app', [[HOST_KEY, NEW, NEW_V], [LIN_KEY, LINUX, NEW_V]]);

process.env.RAVENRY_HOME = MC;
process.env.RAVENRY_RUNTIME_DIR = path.join(D, 'lrun');
process.env.RAVENRY_STATE_DIR = path.join(D, 'lstate');
process.env.RAVENRY_DAEMON_BIN = 'none';
process.env.RAVENRY_SSH = path.join(FAKE, 'ssh');
process.env.RAVENRY_MACHINE_RETRY_MS = '300';
process.env.RAVENRY_REMOTE_BUILDS = APP;

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}
const all = [];
function cleanup() {
  for (const m of all) {
    try {
      for (const b of [path.join(m.home, '.ravenry', 'bin', 'ravenryd'), BIN, NEW, OLD].filter(Boolean)) {
        if (!fs.existsSync(b)) continue;
        const ds = JSON.parse(execFileSync(b, ['daemons', '--json', '--no-start'], { env: m.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '[]');
        for (const d of ds) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
      }
    } catch { /* none */ }
  }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

const machines = await import('../server/machines.mjs');
const ri = await import('../server/remoteinstall.mjs');
const nc = await import('../../packages/node-client/index.mjs');
machines.start({ connect: nc.connect });

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const view = (n) => ri.view().find((m) => m.name === n);
const files = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } }; try { walk(dir); } catch { /* none */ } return out.sort(); };
const tree = (m) => files(m.home).filter((f) => !f.startsWith('.local/') && !f.startsWith('Library/'));
const stepsOf = (j) => j.steps.map((s) => `${s.id}:${s.state}`).join(' ');
async function run(name, o = {}, kind = 'install') {
  const r = kind === 'install' ? ri.install(name, o) : ri.uninstall(name, o);
  if (!r.ok) return { error: r.error };
  await ri.settled(name);
  return ri.job(name);
}
const daemonsOn = (m, bin = BIN) => { try { return JSON.parse(execFileSync(bin, ['daemons', '--json', '--no-start'], { env: m.env, encoding: 'utf8' })); } catch { return []; } };

// ------------------------------------------------------------ the builds
check('the hub finds the app\'s builds', (() => { const b = ri.builds(); return b && b.version === NEW_V && b.systems[HOST_KEY] && b.systems[LIN_KEY] && b.source === 'app'; })(), JSON.stringify(ri.builds()));
check('uname answers map to builds', ri.systemOf('Linux', 'x86_64') === 'linux-x64' && ri.systemOf('Linux', 'aarch64') === 'linux-arm64' && ri.systemOf('Darwin', 'arm64') === 'darwin-arm64' && ri.systemOf('Darwin', 'x86_64') === 'darwin-x64' && ri.systemOf('FreeBSD', 'amd64') === null && ri.systemOf('Linux', 'riscv64') === null);

// ------------------------------------------------------------ a fresh machine
const CLAUDE0 = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/their-hook --x', timeout: 3 }] }] } }, null, 2) + '\n';
const CODEX0 = 'model = "gpt-5"\n\n[features]\nweb_search = true\n';
const dev = machine('devbox', { claude: CLAUDE0, codex: CODEX0 });
all.push(dev);
const before = tree(dev);
machines.add({ name: 'devbox', host: 'devbox' });
const miss = await until(() => { const v = view('devbox'); return v && v.state === 'down' && v.missing ? v : null; });
check('a machine with no ravenryd shows as not installed (its command exits 127)', !!miss && miss.compare === 'missing', JSON.stringify(view('devbox')));

const j1 = await run('devbox');
check('install: every step done', j1.state === 'done' && j1.steps.every((s) => s.state === 'done'), stepsOf(j1) + ' ' + JSON.stringify(j1.steps.filter((s) => s.state !== 'done')));
const RB = path.join(dev.home, '.ravenry', 'bin');
check('install: ravenryd is in ~/.ravenry/bin with the app\'s SHA-256, executable', sha(fs.readFileSync(path.join(RB, 'ravenryd'))) === sha(fs.readFileSync(NEW)) && (fs.statSync(path.join(RB, 'ravenryd')).mode & 0o111) !== 0);
check('install: the ravenry link points at it', fs.readlinkSync(path.join(RB, 'ravenry')) === 'ravenryd');
const cs = json(path.join(dev.home, '.claude', 'settings.json'));
const RBIN = path.join(RB, 'ravenryd');
const claudeHooks = Object.entries(cs.hooks).flatMap(([ev, l]) => l.flatMap((g) => g.hooks.map((h) => [ev, h.command])));
check('install: Claude Code runs `ravenryd hook --assistant claude` on its six events, with the full path', ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop'].every((ev) => claudeHooks.some(([e, c]) => e === ev && c === `${RBIN} hook --assistant claude`)), JSON.stringify(claudeHooks));
check('install: no Node scripts on the machine (no Node there)', !claudeHooks.some(([, c]) => /hooks\/(events|handoff-stop)\.mjs/.test(c)));
check('install: the person\'s own hook and settings stay', cs.model === 'opus' && claudeHooks.some(([e, c]) => e === 'Stop' && c === '/usr/local/bin/their-hook --x'));
check('install: settings.json was backed up first', fs.readdirSync(path.join(dev.home, '.claude')).some((f) => f.startsWith('settings.json.bak-') && read(path.join(dev.home, '.claude', f)) === CLAUDE0));
const xh = json(path.join(dev.home, '.codex', 'hooks.json'));
const xt = read(path.join(dev.home, '.codex', 'config.toml'));
check('install: Codex gets the daemon\'s hook and its trust entries; its config is kept', !!xh && Object.values(xh.hooks).flat().some((g) => g.hooks.some((h) => h.command === `${RBIN} hook --assistant codex`)) && /ravenry-codex-hook-trust begin/.test(xt) && xt.startsWith('model = "gpt-5"'), xt.slice(0, 300));
const man = json(path.join(dev.home, '.ravenry', 'remote-install.json'));
check('install: the manifest says what was installed', man && man.by === 'Ravenry' && man.version === NEW_V && man.system === HOST_KEY && man.hooks.claude.created === false && man.hooks.codex.created === true && man.dirs.includes('.ravenry') && man.dirs.includes('.ravenry/bin'), JSON.stringify(man));
const up1 = view('devbox');
check('install: the machine now runs the installed path, and the board is connected to that version', up1.command === RBIN && up1.state === 'connected' && up1.version === NEW_V && up1.compare === 'same' && up1.answers === true, JSON.stringify(up1));
check('install: the steps say what they did', /Signed in as/.test(j1.steps[0].detail) && /SHA-256 matches/.test(j1.steps[2].detail) && /settings\.json/.test(j1.steps[3].detail) && /board is connected/.test(j1.steps[4].detail), JSON.stringify(j1.steps.map((s) => s.detail)));
const outside = files(dev.dir).filter((f) => !f.startsWith('home/') && !f.startsWith('run/') && !f.startsWith('state/') && !f.startsWith('stubs/'));
check('install: nothing outside the machine\'s home and ravenryd\'s own folders', outside.length === 0, outside.join(', '));

// ------------------------------------------------------------ again
const snapA = Object.fromEntries(tree(dev).map((f) => [f, read(path.join(dev.home, f))]));
const logLen = read(path.join(D, 'ssh-log')).split('\n').length;
const j2 = await run('devbox');
const snapB = Object.fromEntries(tree(dev).map((f) => [f, read(path.join(dev.home, f))]));
const changedAgain = Object.keys({ ...snapA, ...snapB }).filter((f) => f !== '.ravenry/remote-install.json' && snapA[f] !== snapB[f]);
check('run again: every step done, nothing copied', j2.state === 'done' && /Already there, same SHA-256: nothing copied/.test(j2.steps[2].detail), stepsOf(j2) + ' ' + j2.steps[2].detail);
check('run again: no file changed or added (no new backup)', changedAgain.length === 0, changedAgain.join(', '));
check('run again: the hooks step says nothing changed', /already there.*nothing changed/i.test(j2.steps[3].detail), j2.steps[3].detail);
check('run again: no upload went over ssh', !read(path.join(D, 'ssh-log')).split('\n').slice(logLen - 1).some((l) => /ravenryd\.part/.test(l)));

// ------------------------------------------------------------ a Linux machine, hooks set up by hand
const HAND = '/usr/local/bin/ravenryd hook --assistant claude';
const lin = machine('linbox', { stubs: { uname: unameFor(LIN_KEY) }, claude: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }], SessionStart: [{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }] } }, null, 2) + '\n' });
all.push(lin);
machines.add({ name: 'linbox', host: 'linbox' });
const j3 = await run('linbox');
const lset = json(path.join(lin.home, '.claude', 'settings.json'));
check(`another system (${LIN_KEY}): its build is copied`, j3.steps[1].detail.includes(LIN_KEY) && sha(fs.readFileSync(path.join(lin.home, '.ravenry', 'bin', 'ravenryd'))) === sha(fs.readFileSync(LINUX)), j3.steps[1].detail);
check('hooks set up by hand: a warning that names their binary, and they are left as they were', j3.state === 'done' && j3.steps[3].state === 'warn' && j3.steps[3].action === 'replaceHooks' && /\/usr\/local\/bin\/ravenryd hook, set up by hand/.test(j3.steps[3].detail) && JSON.stringify(lset.hooks.Stop) === JSON.stringify([{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }]) && !lset.hooks.Notification, j3.steps[3].detail);
check('hooks set up by hand: the rest still installs and connects', j3.steps[4].state === 'done' && view('linbox').state === 'connected', stepsOf(j3));
const j4 = await run('linbox', { replaceHooks: true });
const lset2 = json(path.join(lin.home, '.claude', 'settings.json'));
const LBIN = path.join(lin.home, '.ravenry', 'bin', 'ravenryd');
const lcmds = Object.values(lset2.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
check('use Ravenry\'s instead: theirs replaced by the installed path, once per event', j4.steps[3].state === 'done' && !lcmds.includes(HAND) && lcmds.filter((c) => c === `${LBIN} hook --assistant claude`).length === 6, JSON.stringify(lcmds));
const lman = json(path.join(lin.home, '.ravenry', 'remote-install.json'));
check('the manifest keeps the commands it replaced', lman.hooks.claude.replaced.length === 2 && lman.hooks.claude.replaced.every((r) => r.command === HAND), JSON.stringify(lman.hooks.claude));

// ------------------------------------------------------------ failures
machine('locked', { deny: true });
machines.add({ name: 'locked', host: 'locked' });
const f1 = await run('locked');
check('ssh wants a password: the first step fails, says so, and gives ssh-copy-id', f1.state === 'failed' && f1.steps[0].state === 'failed' && /asked for a password/.test(f1.steps[0].detail) && f1.steps[0].fix === 'ssh-copy-id locked' && f1.steps.slice(1).every((s) => s.state === 'skipped'), JSON.stringify(f1.steps[0]));
machines.add({ name: 'nowhere', host: 'nowhere.invalid' });
const f1b = await run('nowhere');
check('an unknown host: ssh could not find it', f1b.steps[0].state === 'failed' && /could not find nowhere\.invalid/.test(f1b.steps[0].detail), f1b.steps[0].detail);
const bsd = machine('bsd', { stubs: { uname: 'case "$1" in -s) echo FreeBSD;; -m) echo amd64;; esac' } });
all.push(bsd);
machines.add({ name: 'bsd', host: 'bsd' });
const f2 = await run('bsd');
check('a system with no build: it says which, and nothing is copied', f2.steps[1].state === 'failed' && /FreeBSD on amd64.*macOS and Linux/.test(f2.steps[1].detail) && tree(bsd).length === 0, f2.steps[1].detail);
const arm = machine('armbox', { stubs: { uname: unameFor(NONE_KEY) } });
all.push(arm);
machines.add({ name: 'armbox', host: 'armbox' });
const f2b = await run('armbox');
check('a system this app carries no build for: it says which builds it has', f2b.steps[1].state === 'failed' && new RegExp(`${ri.systemName(NONE_KEY)}.*carries no ravenryd for it`).test(f2b.steps[1].detail), f2b.steps[1].detail);
const full = machine('full', { stubs: { df: 'echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/x 100000 99000 1000 99% /"' } });
all.push(full);
machines.add({ name: 'full', host: 'full' });
const f3 = await run('full');
check('a full disk, before the copy: says how much is free and needed, nothing left behind', f3.steps[2].state === 'failed' && /has 1\.0 MB free.*needs/.test(f3.steps[2].detail) && tree(full).length === 0, f3.steps[2].detail + ' ' + tree(full).join(','));
const fillw = machine('fills', { stubs: { gzip: 'head -c 100000 >/dev/null; echo "gzip: stdout: No space left on device" >&2; exit 1', cat: 'head -c 100000 >/dev/null; echo "cat: write error: No space left on device" >&2; exit 1' } });
all.push(fillw);
machines.add({ name: 'fills', host: 'fills' });
const f4 = await run('fills');
check('a disk that fills up while copying: says so, and the part copied is gone', f4.steps[2].state === 'failed' && /disk filled up/.test(f4.steps[2].detail) && !tree(fillw).some((f) => /ravenryd/.test(f)), f4.steps[2].detail + ' ' + tree(fillw).join(','));

// ------------------------------------------------------------ another protocol
const p2 = machine('proto2');
all.push(p2);
const STUB = path.join(p2.home, 'odd', 'ravenryd');
fs.mkdirSync(path.dirname(STUB), { recursive: true });
fs.writeFileSync(STUB, '#!/bin/sh\ncase "$1" in version) echo \'{"version":"9.0.0","protocol":2,"os":"linux","arch":"amd64"}\';; proxy) cat >/dev/null & printf "HTTP/1.1 400 Bad Request\\r\\n\\r\\nprotocol 2 only\\r\\n"; exit 1;; esac\n', { mode: 0o755 });
machines.add({ name: 'proto2', host: 'proto2', command: STUB });
const pv = await until(() => { const v = view('proto2'); return v && v.remote && v.compare === 'protocol' ? v : null; }, 20000);
check('a ravenryd that speaks another protocol: the machine says its version and protocol', !!pv && pv.remote.version === '9.0.0' && pv.remote.protocol === 2 && /speaks protocol 2; this hub speaks protocol 1/.test(pv.error), JSON.stringify(view('proto2')));

// ------------------------------------------------------------ versions: older, the update, newer
if (OLD && ri.compareVersions(vjson(OLD).version, NEW_V) < 0) {
  const OLD_V = vjson(OLD).version;
  const OLDB = buildsDir('old', [[HOST_KEY, OLD, OLD_V]]);
  const ob = machine('oldbox');
  all.push(ob);
  machines.add({ name: 'oldbox', host: 'oldbox' });
  process.env.RAVENRY_REMOTE_BUILDS = OLDB;
  const o1 = await run('oldbox');
  process.env.RAVENRY_REMOTE_BUILDS = APP;
  const ov = view('oldbox');
  check(`older: a machine on ${OLD_V} shows as older than this app's ${NEW_V}`, o1.state === 'done' && ov.version === OLD_V && ov.compare === 'older' && ov.ours === NEW_V, JSON.stringify(ov));
  // A session there, on the old daemon.
  const link = machines.connected().find((x) => x.name === 'oldbox');
  const { pane } = await link.c.request('pane.new', { command: ['/bin/sh', '-c', 'echo still-here; exec sleep 600'], cols: 80, rows: 10 });
  const o2 = await run('oldbox');
  const nv = await until(() => { const v = view('oldbox'); return v && v.state === 'connected' && v.version === NEW_V && v.older.includes(OLD_V) ? v : null; }, 20000);
  check('update: the same installer puts the new version there', o2.state === 'done' && /SHA-256 matches/.test(o2.steps[2].detail) && sha(fs.readFileSync(path.join(ob.home, '.ravenry', 'bin', 'ravenryd'))) === sha(fs.readFileSync(NEW)), stepsOf(o2));
  check('update: the board reaches the new daemon, and the old one beside it for its session', !!nv && nv.compare === 'same', JSON.stringify(view('oldbox')));
  check('update: the check says the session keeps running on the old version', new RegExp(`keep running on ${OLD_V.replace(/\./g, '\\.')}`).test(o2.steps[4].detail), o2.steps[4].detail);
  const oldLink = machines.connected().find((x) => x.name === 'oldbox' && x.version === OLD_V);
  const panesOld = oldLink ? (await oldLink.c.request('pane.list', {})).panes : [];
  check('update: the session on the old daemon still runs, reached through it', panesOld.some((p) => p.id === pane.id && p.state === 'running'), JSON.stringify(panesOld.map((p) => [p.id, p.state])));
  const ds = daemonsOn(ob, NEW);
  check('update: two daemons run there, the new one and the old one with its pane', ds.some((d) => d.version === NEW_V) && ds.some((d) => d.version === OLD_V && d.panes === 1), JSON.stringify(ds));
  // Newer: the app's builds are the old version now.
  process.env.RAVENRY_REMOTE_BUILDS = OLDB;
  const nw = view('oldbox');
  check(`newer: a machine on ${NEW_V} shows as newer than an app with ${OLD_V}`, nw.compare === 'newer' && nw.ours === OLD_V, JSON.stringify(nw));
  process.env.RAVENRY_REMOTE_BUILDS = APP;
  // Uninstall: asks first while the session runs.
  const u0 = await run('oldbox', {}, 'uninstall');
  check('uninstall with a session running: it stops and asks, nothing removed', u0.state === 'needs' && u0.needs.kind === 'sessions' && u0.needs.count >= 1 && u0.steps[1].action === 'endSessions' && fs.existsSync(path.join(ob.home, '.ravenry', 'bin', 'ravenryd')), JSON.stringify(u0));
  const u1 = await run('oldbox', { endSessions: true }, 'uninstall');
  check('uninstall, ending them: done, its daemons stopped', u1.state === 'done' && /Stopped its 2 daemons/.test(u1.steps[1].detail), stepsOf(u1) + ' ' + u1.steps[1].detail);
  check('uninstall: nothing of Ravenry\'s is left in that home, and the machine is off the list', tree(ob).filter((f) => !f.startsWith('.claude/settings.json.bak-')).length === 0 && !view('oldbox'), tree(ob).join(', '));
} else {
  console.log('SKIP  versions: set RAVENRYD_OLD_BIN to a build older than RAVENRYD_NEW_BIN (or RAVENRYD_BIN)');
}

// ------------------------------------------------------------ uninstall: exactly what was installed
const u2 = await run('devbox', { endSessions: true }, 'uninstall');
check('uninstall: every step done', u2.state === 'done' && u2.steps.every((s) => s.state === 'done'), stepsOf(u2) + ' ' + JSON.stringify(u2.steps.filter((s) => s.state !== 'done')));
const after = tree(dev).filter((f) => !/\.bak-/.test(f));
check('uninstall: the home holds what it held before (backups aside)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
check('uninstall: Claude Code\'s settings are what they were', JSON.stringify(json(path.join(dev.home, '.claude', 'settings.json'))) === JSON.stringify(JSON.parse(CLAUDE0)), JSON.stringify(json(path.join(dev.home, '.claude', 'settings.json'))));
check('uninstall: Codex\'s hooks.json, which Ravenry made, is gone, and config.toml is as it was', !fs.existsSync(path.join(dev.home, '.codex', 'hooks.json')) && read(path.join(dev.home, '.codex', 'config.toml')) === CODEX0, JSON.stringify(read(path.join(dev.home, '.codex', 'config.toml'))));
check('uninstall: ~/.ravenry, which Ravenry made, is gone', !fs.existsSync(path.join(dev.home, '.ravenry')));
check('uninstall: devbox is off the list and its daemon stopped', !view('devbox') && (await until(() => daemonsOn(dev).length === 0, 5000)), JSON.stringify(daemonsOn(dev)));
const u3 = await run('linbox', { endSessions: true }, 'uninstall');
const lset3 = json(path.join(lin.home, '.claude', 'settings.json'));
check('uninstall after "use Ravenry\'s": the hooks set up by hand are back', u3.state === 'done' && JSON.stringify(lset3.hooks.Stop) === JSON.stringify([{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }]) && JSON.stringify(lset3.hooks.SessionStart) === JSON.stringify([{ hooks: [{ type: 'command', command: HAND, timeout: 10 }] }]) && Object.keys(lset3.hooks).length === 2, JSON.stringify(lset3));

machines.stop();
console.log(fails ? `\n${fails} failed  (scratch: ${T})` : `\nall passed  (scratch: ${T})`);
process.exit(fails ? 1 : 0);
