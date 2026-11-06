// Installs ravenryd and the assistants' hooks on a machine reached over
// ssh, and takes them off again: the Machines page's Install, Update and
// Uninstall (POST /api/machines/install and /api/machines/uninstall, person
// routes, docs/PERSON.md).
//
// What it puts there, all inside the remote user's home, never with sudo:
//
//   ~/.ravenry/bin/ravenryd        the app's build for that system, checked
//                                  by SHA-256 against the app's own list
//   ~/.ravenry/bin/ravenry         a link to it (the name people and agents
//                                  type; one binary picks its mode by name)
//   ~/.claude/settings.json        `ravenryd hook --assistant claude`, through
//                                  server/hookinstall.mjs plan() with
//                                  `scripts: false` (no Node there, no hub)
//   ~/.codex/hooks.json, config.toml  the same for Codex and its trust
//                                  entries, when Codex is there
//   ~/.ravenry/remote-install.json what it wrote, replaced and created, so
//                                  uninstall takes off exactly that
//
// The shell integration (OSC 133 marks, OSC 7) is inside ravenryd, which
// writes it into its state folder when it starts a shell
// (daemon/internal/pane/shell.go): nothing else to install for it.
//
// Steps, each shown in the app with what it did or why it stopped:
//   reach    ssh with BatchMode (never a password or a question), and a
//            look around: the system, the free space, what is there
//   system   the build for its uname (darwin or linux, arm64 or x86-64)
//   copy     the binary, unless the same one (by SHA-256) is there;
//            checked there, run once (`version --json`), then moved into
//            place in one rename; a ravenryd it did not put there is kept
//            beside it and put back by uninstall
//   hooks    each settings file read, planned here, written there only if
//            it did not change meanwhile, backed up first. Hooks someone
//            set up by hand (a `ravenryd hook` of another binary) are left
//            alone unless the person asks for Ravenry's (replaceHooks);
//            uninstall then puts theirs back
//   check    the machine's command becomes the installed path, the hub
//            connects again and must reach that version
//
// Run again, it changes nothing that is already right. Every remote command
// is a POSIX sh script sent on standard input (`sh -s`), so the remote
// login shell (bash, zsh, fish) never parses it; only the copy runs a
// one-line `sh -c` while the binary streams in.
//
// The builds come from builds(): the packaged app's
// versions/<version>/remote/ (builds.json and one gzipped binary per
// system, apps/desktop/scripts/pack.mjs), RAVENRY_REMOTE_BUILDS in tests,
// and in development the repo's daemon/ravenryd for this machine's own
// system.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as machines from './machines.mjs';
import * as hk from './hookinstall.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST = '.ravenry/remote-install.json';
export const BIN_DIR = '.ravenry/bin';
export const SYSTEMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
// Room a copy needs beyond the binary: the hooks' backups and some air.
const SPARE = 8 << 20;

// ---------------------------------------------------------------- versions

export function compareVersions(a, b) {
  const split = (v) => {
    const [main, pre] = String(v).split(/-(.*)/s);
    return { parts: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre || '' };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// uname's answer as a build's name: "linux-x64", or null.
export function systemOf(os_, arch) {
  const o = String(os_ || '').trim().toLowerCase();
  const a = String(arch || '').trim().toLowerCase();
  const so = o === 'linux' ? 'linux' : o === 'darwin' ? 'darwin' : null;
  const sa = ['x86_64', 'amd64', 'x64'].includes(a) ? 'x64' : ['aarch64', 'arm64', 'armv8l', 'arm64e'].includes(a) ? 'arm64' : null;
  return so && sa ? `${so}-${sa}` : null;
}

const SYSTEM_NAME = { darwin: 'macOS', linux: 'Linux' };
const ARCH_NAME = { x64: 'x86-64', arm64: 'arm64' };
export const systemName = (key) => { const [o, a] = String(key).split('-'); return `${SYSTEM_NAME[o] || o}, ${ARCH_NAME[a] || a}`; };

// ---------------------------------------------------------------- builds

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// Where the builds are: RAVENRY_REMOTE_BUILDS, else beside the hub's
// ravenryd (the packaged app's versions/<version>/remote), else null.
export function buildsDir(env = process.env) {
  if (env.RAVENRY_REMOTE_BUILDS) return env.RAVENRY_REMOTE_BUILDS;
  const bin = env.RAVENRY_DAEMON_BIN;
  if (bin && bin !== 'none') {
    const real = realOr(bin);
    const d = real ? path.join(path.dirname(real), 'remote') : null;
    if (d && fs.existsSync(path.join(d, 'builds.json'))) return d;
  }
  return null;
}

let devCache = null;
// The builds this hub can install: { version, dir, source, systems: { key:
// { file, sha256, size } } }, or null when it has none.
export function builds(env = process.env) {
  const dir = buildsDir(env);
  if (dir) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'builds.json'), 'utf8'));
      const systems = {};
      for (const [k, b] of Object.entries(j.builds || {})) {
        if (SYSTEMS.includes(k) && b && typeof b.file === 'string' && /^[0-9a-f]{64}$/.test(b.sha256) && !b.file.includes('/')) systems[k] = { file: path.join(dir, b.file), sha256: b.sha256, size: Number(b.size) || 0 };
      }
      return typeof j.version === 'string' ? { version: j.version, dir, source: 'app', systems } : null;
    } catch { return null; }
  }
  // Development: this checkout's build, for this machine's system only.
  if (env.TEST_RAVENRY === '1') return null;
  const dev = path.join(REPO, 'daemon', 'ravenryd');
  let st;
  try { st = fs.statSync(dev); } catch { return null; }
  if (devCache && devCache.mtime === st.mtimeMs) return devCache.value;
  let value = null;
  try {
    const v = JSON.parse(execFileSync(dev, ['version', '--json'], { encoding: 'utf8', timeout: 5000 }));
    const key = systemOf(v.os, v.arch);
    const buf = fs.readFileSync(dev);
    if (key) value = { version: v.version, dir: path.dirname(dev), source: 'dev', systems: { [key]: { file: dev, sha256: sha256(buf), size: buf.length } } };
  } catch { value = null; }
  devCache = { mtime: st.mtimeMs, value };
  return value;
}

// A build's bytes as they go over ssh: gzipped when the file is (and the
// machine has gzip), else plain. Checked against its SHA-256 here first.
export function loadBuild(b, { gzip = false } = {}) {
  const file = fs.readFileSync(b.file);
  const gz = b.file.endsWith('.gz');
  const raw = gz ? zlib.gunzipSync(file) : file;
  if (sha256(raw) !== b.sha256) throw new Error(`the app's build ${path.basename(b.file)} does not match its SHA-256; reinstall the app`);
  return gz && gzip ? { bytes: file, gzip: true, size: raw.length } : { bytes: raw, gzip: false, size: raw.length };
}

// ---------------------------------------------------------------- remote sh

// Shell functions every script starts with. Output lines are "RVN key=value"
// (a login shell's banner on stdout is ignored); values that may hold
// anything are base64.
const PRELUDE = `
P() { printf 'RVN %s=%s\\n' "$1" "$2"; }
b64() { if command -v base64 >/dev/null 2>&1; then base64 | tr -d '\\n'; else openssl base64 -A; fi; }
b64d() { if printf 'YQ==' | base64 -d >/dev/null 2>&1; then base64 -d; elif command -v openssl >/dev/null 2>&1; then openssl base64 -d -A; else base64 -D; fi; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= *//'; fi; }
`;

// A value safe inside a double-quoted sh string we write ourselves (paths
// from the remote are base64 there instead).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function parse(out) {
  const kv = {};
  for (const line of String(out).split('\n')) {
    const m = /^RVN ([a-z0-9_]+)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (m) kv[m[1]] = m[2];
  }
  return kv;
}
const unb64 = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

// Runs a script there through `sh -s`: { code, kv, err }.
async function script(host, body, { timeoutMs = 30000 } = {}) {
  const r = await machines.runSsh(host, 'sh -s', { input: PRELUDE + body + '\n', timeoutMs });
  return { code: r.code, kv: parse(r.out), err: r.err, out: r.out };
}

// What ssh's own failure means for a person: { why, fix }.
export function sshFailure(host, err) {
  const lines = String(err || '').split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !/^Warning: Permanently added/.test(s));
  const last = (lines[lines.length - 1] || 'ssh closed the connection').replace(/\.$/, '');
  const all = lines.join(' ');
  if (/Permission denied|password|keyboard-interactive|Too many authentication failures/i.test(all)) {
    return { why: `ssh asked for a password (${last}). Ravenry runs ssh without asking anything, so it needs your key on ${host}.`, fix: `ssh-copy-id ${host}`, fixWhat: 'Run this once in a terminal, then try again:' };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key/i.test(all)) {
    return { why: `ssh does not trust ${host}'s host key yet, or the key changed (${last}). Connect once in a terminal to check it and say yes.`, fix: `ssh ${host}`, fixWhat: 'Then try again:' };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(all)) return { why: `ssh could not find ${host} (${last}). Check the name, or its Host entry in ~/.ssh/config.` };
  if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset/i.test(all)) return { why: `ssh could not reach ${host} (${last}). Is it on, and on this network?` };
  if (/ssh did not start/.test(all)) return { why: `ssh is not installed on this computer (${last}).` };
  return { why: `ssh failed: ${last}` };
}

const NO_SPACE = /No space left on device|Disk quota exceeded|ENOSPC|write error/i;

// ---------------------------------------------------------------- jobs

// name -> the job the app shows: { kind, state: running | done | failed |
// needs, steps: [{ id, title, state, detail, fix, fixWhat, progress,
// action }], startedAt, endedAt, needs }
const jobs = new Map();

export function job(name) { return jobs.get(name) || null; }

// Every machine as the app shows it: machines.status() with this hub's
// build version (`ours`), how theirs compares (`compare`: older, newer,
// same, protocol, missing), and the last install or uninstall.
export function view(env = process.env) {
  const b = builds(env);
  const ours = b ? b.version : null;
  return machines.status().map((m) => {
    let compare = null;
    if (m.state === 'connected' && m.protocol != null && m.protocol !== machines.PROTOCOL) compare = 'protocol';
    else if (m.state === 'connected' && ours && m.version) compare = ['older', 'same', 'newer'][compareVersions(m.version, ours) + 1];
    else if (m.missing) compare = 'missing';
    else if (m.remote && m.remote.protocol !== machines.PROTOCOL) compare = 'protocol';
    const j = jobs.get(m.name);
    // A connection ssh itself refused, said as the installer says it.
    const explain = m.state === 'down' && m.error && !m.missing && compare !== 'protocol' ? sshFailure(m.host, m.error) : null;
    return { ...m, ours, compare, job: j ? publicJob(j) : null, explain: explain && !/^ssh failed: /.test(explain.why) ? explain : null };
  });
}

function publicJob(j) {
  return { kind: j.kind, state: j.state, steps: j.steps.map((s) => ({ ...s })), startedAt: j.startedAt, endedAt: j.endedAt, needs: j.needs || null, version: j.version || null };
}

function newJob(name, kind, titles) {
  const j = { name, kind, state: 'running', steps: titles.map(([id, title]) => ({ id, title, state: 'pending', detail: null })), startedAt: new Date().toISOString(), endedAt: null, needs: null };
  jobs.set(name, j);
  return j;
}
const stepOf = (j, id) => j.steps.find((s) => s.id === id);
function begin(j, id, title) { const s = stepOf(j, id); s.state = 'running'; if (title) s.title = title; s.at = Date.now(); return s; }
function end(j, id, state, detail, extra = {}) {
  const s = stepOf(j, id);
  Object.assign(s, { state, detail, ...extra });
  if (s.at) { s.ms = Date.now() - s.at; delete s.at; }
  if (state === 'failed') { j.state = 'failed'; j.endedAt = new Date().toISOString(); for (const x of j.steps) if (x.state === 'pending') x.state = 'skipped'; }
  return s;
}
function finish(j, state = 'done') { j.state = state; j.endedAt = new Date().toISOString(); }

const tilde = (home, p) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// The look around: who, where, which system, how much room, and what of
// Ravenry's and the assistants' is already there.
const PROBE = `
P ok 1
P user "$(id -un 2>/dev/null || whoami 2>/dev/null)"
P home "$HOME"
P os "$(uname -s 2>/dev/null)"
P arch "$(uname -m 2>/dev/null)"
P avail "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
command -v gzip >/dev/null 2>&1 && P gzip 1
P shatool "$(command -v sha256sum || command -v shasum || command -v openssl)"
R="$HOME/.ravenry"; B="$R/bin/ravenryd"
[ -d "$R" ] && P hasdir 1
[ -d "$R/bin" ] && P hasbin 1
if [ -f "$B" ]; then P binsha "$(sha "$B")"; P binver "$("$B" version --json 2>/dev/null | b64)"; fi
if [ -L "$R/bin/ravenry" ]; then P linkto "$(readlink "$R/bin/ravenry" | b64)"; elif [ -e "$R/bin/ravenry" ]; then P linkfile 1; fi
[ -f "$R/remote-install.json" ] && P manifest "$(b64 < "$R/remote-install.json")"
C="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
P claudedir "$(printf %s "$C" | b64)"
[ -d "$C" ] && P claudehas 1
if [ -f "$C/settings.json" ]; then P claude "$(b64 < "$C/settings.json")"; P claudesha "$(sha "$C/settings.json")"; fi
X="\${CODEX_HOME:-$HOME/.codex}"
P codexdir "$(printf %s "$X" | b64)"
if [ -d "$X" ] || command -v codex >/dev/null 2>&1; then P codexhas 1; fi
[ -d "$X" ] && P codexdirhas 1
if [ -f "$X/hooks.json" ]; then P codexhooks "$(b64 < "$X/hooks.json")"; P codexhookssha "$(sha "$X/hooks.json")"; fi
if [ -f "$X/config.toml" ]; then P codexconfig "$(b64 < "$X/config.toml")"; P codexconfigsha "$(sha "$X/config.toml")"; fi
`;

async function reach(j, m) {
  begin(j, 'reach', `Reach ${m.name} over ssh`);
  const r = await script(m.host, PROBE + `[ -x "$B" ] && P daemons "$("$B" daemons --json --no-start 2>/dev/null | b64)"\n`, { timeoutMs: 40000 });
  if (r.code === 255 || r.code === -1 || !r.kv.ok) {
    const f = r.code === 255 || r.code === -1 ? sshFailure(m.host, r.err) : { why: `${m.name} answered over ssh, but sh did not run there (${(r.err || r.out || '').trim().split('\n').pop() || `exit ${r.code}`}).` };
    end(j, 'reach', 'failed', f.why, { fix: f.fix || null, fixWhat: f.fixWhat || null });
    return null;
  }
  const kv = r.kv;
  const p = {
    user: kv.user || '', home: kv.home || '', os: kv.os || '', arch: kv.arch || '', avail: kv.avail ? Number(kv.avail) * 1024 : null, gzip: kv.gzip === '1', shatool: kv.shatool || '',
    hasdir: kv.hasdir === '1', hasbin: kv.hasbin === '1', binsha: kv.binsha || null, binver: null, linkto: kv.linkto ? unb64(kv.linkto) : null, linkfile: kv.linkfile === '1', manifest: null,
    claude: { dir: unb64(kv.claudedir), has: kv.claudehas === '1', raw: kv.claude != null ? unb64(kv.claude) : null, sha: kv.claudesha || null },
    codex: { dir: unb64(kv.codexdir), has: kv.codexhas === '1', dirhas: kv.codexdirhas === '1', hooks: kv.codexhooks != null ? unb64(kv.codexhooks) : null, hookssha: kv.codexhookssha || null, config: kv.codexconfig != null ? unb64(kv.codexconfig) : null, configsha: kv.codexconfigsha || null },
    daemons: null,
  };
  try { p.binver = kv.binver ? JSON.parse(unb64(kv.binver)) : null; } catch { p.binver = null; }
  try { p.manifest = kv.manifest ? JSON.parse(unb64(kv.manifest)) : null; } catch { p.manifest = null; }
  try { p.daemons = kv.daemons ? JSON.parse(unb64(kv.daemons)) : null; } catch { p.daemons = null; }
  if (!p.home.startsWith('/')) { end(j, 'reach', 'failed', `${m.name} did not say where its home folder is ($HOME is "${p.home}").`); return null; }
  end(j, 'reach', 'done', `Signed in as ${p.user || 'you'}, home ${p.home}`);
  return p;
}

// Writes one file there (content as base64 inside the script), only if it
// still is what was read (its SHA-256, or "none"), the old one kept as
// <file>.bak-<time> first. Returns { ok, backup, why }.
async function writeRemote(m, file, text, { expect, backup = true, mode = null, force = false }) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const want = sha256(Buffer.from(text, 'utf8'));
  const body = `
f=${shq(file)}; d=$(dirname "$f")
if [ -d "$d" ]; then :; else mkdir -p "$d" || { P error mkdir; exit 3; }; P madedir 1; fi
cur=none; [ -f "$f" ] && cur=$(sha "$f")
if [ ${force ? 1 : 0} = 0 ] && [ "$cur" != ${shq(expect || 'none')} ]; then P error changed; exit 8; fi
t="$f.ravenry-tmp"
if e=$(printf %s ${shq(b64)} | b64d 2>&1 >"$t"); then :; else rm -f "$t"; P error "write $(printf %s "$e" | b64)"; exit 4; fi
[ "$(sha "$t")" = ${shq(want)} ] || { rm -f "$t"; P error "short $(printf %s "$e" | b64)"; exit 4; }
${mode ? `chmod ${mode} "$t"` : ''}
if [ -f "$f" ] && [ ${backup ? 1 : 0} = 1 ]; then b="$f.bak-${stamp()}"; cp -p "$f" "$b" || { rm -f "$t"; P error "backup"; exit 4; }; P backup "$(printf %s "$b" | b64)"; fi
mv -f "$t" "$f" || { rm -f "$t"; P error mv; exit 7; }
P sha "$(sha "$f")"
`;
  const r = await script(m.host, body, { timeoutMs: 30000 });
  if (r.code === 255 || r.code === -1) return { ok: false, why: sshFailure(m.host, r.err).why };
  const e = r.kv.error || '';
  if (e === 'changed') return { ok: false, why: `${file} changed while Ravenry was writing it. Nothing was written; try again.` };
  if (e.startsWith('write') || e.startsWith('short') || e === 'backup') {
    const detail = unb64(e.split(' ')[1] || '');
    return { ok: false, full: NO_SPACE.test(detail) || e.startsWith('short'), why: NO_SPACE.test(detail) || e.startsWith('short') ? `${m.name}'s disk is full: ${file} could not be written (${detail.trim() || 'short write'}). Nothing was changed.` : `${file} could not be written (${detail.trim() || e}).` };
  }
  if (e) return { ok: false, why: `${file} could not be written (${e}).` };
  if (r.kv.sha !== want) return { ok: false, why: `${file} on ${m.name} does not hold what was written (SHA-256 differs).` };
  return { ok: true, backup: r.kv.backup ? unb64(r.kv.backup) : null, madeDir: r.kv.madedir === '1' };
}

async function removeRemote(m, file, { expect, backup = true }) {
  const body = `
f=${shq(file)}
[ -f "$f" ] || { P gone 1; exit 0; }
[ "$(sha "$f")" = ${shq(expect)} ] || { P error changed; exit 8; }
${backup ? `b="$f.bak-${stamp()}"; cp -p "$f" "$b" && P backup "$(printf %s "$b" | b64)"` : ''}
rm -f "$f" && P ok 1
`;
  const r = await script(m.host, body);
  if (r.code === 255 || r.code === -1) return { ok: false, why: sshFailure(m.host, r.err).why };
  if (r.kv.error === 'changed') return { ok: false, why: `${file} changed while Ravenry was removing it. Nothing was removed; try again.` };
  return { ok: !!(r.kv.ok || r.kv.gone), backup: r.kv.backup ? unb64(r.kv.backup) : null };
}

// ---------------------------------------------------------------- install

const INSTALL_STEPS = [['reach', 'Reach the machine over ssh'], ['system', 'Find its system'], ['copy', 'Copy ravenryd'], ['hooks', 'Hooks for Claude Code and Codex'], ['check', 'Check']];

// Starts an install (or an update: the same, over what is there). Returns
// { ok, job } at once; the job runs on. { replaceHooks } uses Ravenry's
// hooks in place of ones set up by hand.
export function install(name, { replaceHooks = false, env = process.env } = {}) {
  const m = machines.configured().find((x) => x.name === name);
  if (!m) return { ok: false, status: 404, error: `No machine is called ${name}.` };
  const cur = jobs.get(name);
  if (cur && cur.state === 'running') return { ok: false, status: 409, error: `Ravenry is already ${cur.kind === 'install' ? 'installing on' : 'uninstalling from'} ${name}.` };
  const b = builds(env);
  if (!b) return { ok: false, status: 409, error: 'This copy of Ravenry carries no ravenryd to install. The desktop app does.' };
  const j = newJob(name, 'install', INSTALL_STEPS);
  j.version = b.version;
  j.done = runInstall(j, m, b, { replaceHooks }).catch((e) => {
    const s = j.steps.find((x) => x.state === 'running') || j.steps.find((x) => x.state === 'pending');
    if (s) end(j, s.id, 'failed', `Something went wrong here: ${e.message}`);
    else finish(j, 'failed');
  });
  return { ok: true, job: publicJob(j) };
}

async function runInstall(j, m, b, { replaceHooks }) {
  const p = await reach(j, m);
  if (!p) return;
  const home = p.home;
  const t = (x) => tilde(home, x);
  const old = p.manifest && p.manifest.by === 'Ravenry' ? p.manifest : null;

  // ---- system
  begin(j, 'system');
  const key = systemOf(p.os, p.arch);
  if (!key) {
    end(j, 'system', 'failed', `${m.name} runs ${p.os || 'an unknown system'} on ${p.arch || 'an unknown processor'}. Ravenry has ravenryd for macOS and Linux, on arm64 and x86-64, so there is nothing to put there.`);
    return;
  }
  const build = b.systems[key];
  if (!build) {
    const have = Object.keys(b.systems).map(systemName).join('; ') || 'none';
    end(j, 'system', 'failed', `${m.name} runs ${systemName(key)}, and this copy of Ravenry carries no ravenryd for it (it has: ${have}). ${b.source === 'dev' ? 'A development build has only this computer\'s; the packaged app carries all four.' : 'Update the app, or reinstall it.'}`);
    return;
  }
  if (!p.shatool) { end(j, 'system', 'failed', `${m.name} has no sha256sum, shasum or openssl, so Ravenry cannot check what it copies there.`); return; }
  end(j, 'system', 'done', `${p.os} on ${p.arch}: the ${key} build`);

  // ---- copy
  const binDir = `${home}/${BIN_DIR}`;
  const bin = `${binDir}/ravenryd`;
  const s = begin(j, 'copy', `Copy ravenryd ${b.version}`);
  let copied = false;
  let replacedBin = old && old.replaced ? old.replaced.bin || null : null;
  if (p.binsha === build.sha256) {
    end(j, 'copy', 'done', `Already there, same SHA-256: nothing copied (${t(bin)})`);
  } else {
    let load;
    try { load = loadBuild(build, { gzip: p.gzip }); } catch (e) { end(j, 'copy', 'failed', e.message); return; }
    const need = load.size + SPARE;
    if (p.avail != null && p.avail < need) {
      end(j, 'copy', 'failed', `${m.name} has ${mb(p.avail)} free in ${home}; ravenryd needs ${mb(need)}. Nothing was copied. Free some space there, then try again.`);
      return;
    }
    s.progress = { done: 0, total: load.bytes.length };
    s.detail = `Into ${t(bin)}`;
    const up = await upload(m, load, s);
    if (!up.ok) {
      // The folders the copy made go too, so nothing is left behind.
      if (!p.hasbin) await script(m.host, `rmdir "$HOME/${BIN_DIR}" 2>/dev/null${p.hasdir ? '' : '; rmdir "$HOME/.ravenry" 2>/dev/null'}; P ok 1`);
      end(j, 'copy', 'failed', up.why, { progress: null });
      return;
    }
    // Checked there, run once, then moved into place. A ravenryd Ravenry
    // did not put there is kept beside it.
    const keep = p.binsha && !(old && old.sha256 === p.binsha) && !(old && old.files && old.files.includes(`${BIN_DIR}/ravenryd`)) ? `ravenryd.bak-${stamp()}` : null;
    const act = await script(m.host, `
d="$HOME/${BIN_DIR}"; t="$d/.ravenryd.part"
s=$(sha "$t"); if [ "$s" != ${shq(build.sha256)} ]; then rm -f "$t"; P error "sha $s"; exit 5; fi
chmod 755 "$t"
if v=$("$t" version --json 2>&1); then P ran "$(printf %s "$v" | b64)"; else rm -f "$t"; P error run; P runout "$(printf %s "$v" | b64)"; exit 6; fi
${keep ? `if [ -e "$d/ravenryd" ]; then mv "$d/ravenryd" "$d/${keep}" && P kept ${keep}; fi` : ''}
mv -f "$t" "$d/ravenryd" || { rm -f "$t"; P error mv; exit 7; }
if [ -L "$d/ravenry" ] || [ ! -e "$d/ravenry" ]; then ln -sfn ravenryd "$d/ravenry" && P link 1; fi
P ok 1
`);
    if (act.code === 255 || act.code === -1) { end(j, 'copy', 'failed', sshFailure(m.host, act.err).why, { progress: null }); return; }
    const e = act.kv.error || '';
    if (e.startsWith('sha')) { end(j, 'copy', 'failed', `The copy on ${m.name} does not match the app's build (SHA-256 ${e.slice(4, 16) || 'missing'}..., expected ${build.sha256.slice(0, 12)}...). It was removed; try again.`, { progress: null }); return; }
    if (e === 'run') { end(j, 'copy', 'failed', `The ${key} build would not run on ${m.name}: ${unb64(act.kv.runout).trim().split('\n').pop() || 'no output'}. It was removed.`, { progress: null }); return; }
    if (e || !act.kv.ok) { end(j, 'copy', 'failed', `ravenryd could not be put in place on ${m.name} (${e || 'no answer'}).`, { progress: null }); return; }
    if (act.kv.kept) replacedBin = `${BIN_DIR}/${act.kv.kept}`;
    copied = true;
    end(j, 'copy', 'done', `${t(bin)}, SHA-256 matches the app's build${load.gzip ? ` (${mb(load.bytes.length)} sent, ${mb(load.size)} unpacked)` : ` (${mb(load.size)})`}${act.kv.kept ? `. The ravenryd that was there is kept as ${act.kv.kept}` : ''}`, { progress: null });
  }

  // ---- hooks
  begin(j, 'hooks');
  const hooks = { claude: old && old.hooks ? old.hooks.claude || null : null, codex: old && old.hooks ? old.hooks.codex || null : null };
  const lines = [];
  let warn = null;
  const mine = (h) => hk.splitCommand(h.command)[hk.splitCommand(h.command).indexOf('hook') - 1] === bin;
  const handOf = (json, assistant) => {
    const out = [];
    for (const [ev, list] of Object.entries((json && json.hooks) || {})) for (const g of Array.isArray(list) ? list : []) for (const h of (g && g.hooks) || []) if (hk.isRavenrydHook(h, assistant) && !mine(h)) out.push({ event: ev, command: h.command });
    return out;
  };

  // Claude Code: always (its settings are read once it is installed there).
  const cfile = `${p.claude.dir}/settings.json`;
  let cjson = {};
  if (p.claude.raw != null && p.claude.raw.trim()) {
    try { cjson = JSON.parse(p.claude.raw); } catch (e) { end(j, 'hooks', 'failed', `${t(cfile)} on ${m.name} is not valid JSON (${e.message}), so Ravenry leaves it alone. Fix it, then try again.`); return; }
  }
  const chand = handOf(cjson, 'claude');
  if (chand.length && !replaceHooks) {
    warn = { assistant: 'Claude Code', bin: hk.splitCommand(chand[0].command)[hk.splitCommand(chand[0].command).indexOf('hook') - 1] };
    lines.push(`Claude Code's hooks there already run ${warn.bin} hook, set up by hand: left as they are`);
  } else {
    const pl = hk.plan(cjson, { ravenryd: bin, scripts: false, daemonMatch: replaceHooks ? null : mine });
    if (!pl.changes.length) lines.push(`Claude Code: already there in ${t(cfile)}, nothing changed`);
    else {
      const w = await writeRemote(m, cfile, JSON.stringify(pl.settings, null, 2) + '\n', { expect: p.claude.raw == null ? 'none' : p.claude.sha });
      if (!w.ok) { end(j, 'hooks', 'failed', w.why); return; }
      const prev = hooks.claude || {};
      hooks.claude = { file: cfile, bin, created: prev.created ?? p.claude.raw == null, madeDir: prev.madeDir ?? (w.madeDir || false), replaced: [...(prev.replaced || []), ...(replaceHooks ? chand : [])] };
      lines.push(`Claude Code: ${p.claude.raw == null ? 'written to' : 'added to'} ${t(cfile)}${w.backup ? `, the old file kept as ${path.basename(w.backup)}` : ''}${replaceHooks && chand.length ? `, in place of the hooks set up by hand (uninstall puts them back)` : ''}`);
    }
    if (!hooks.claude && !pl.changes.length) hooks.claude = { file: cfile, bin, created: false, madeDir: false, replaced: [] };
  }

  // Codex: only when it is there.
  if (!p.codex.has) {
    lines.push('Codex is not installed there, so nothing for it');
  } else {
    const hfile = `${p.codex.dir}/hooks.json`;
    const tfile = `${p.codex.dir}/config.toml`;
    let hjson = {};
    if (p.codex.hooks != null && p.codex.hooks.trim()) {
      try { hjson = JSON.parse(p.codex.hooks); } catch (e) { end(j, 'hooks', 'failed', `${t(hfile)} on ${m.name} is not valid JSON (${e.message}), so Ravenry leaves it alone. Fix it, then try again.`); return; }
    }
    const xhand = handOf(hjson, 'codex');
    if (xhand.length && !replaceHooks) {
      const hb = hk.splitCommand(xhand[0].command)[hk.splitCommand(xhand[0].command).indexOf('hook') - 1];
      warn = warn || { assistant: 'Codex', bin: hb };
      lines.push(`Codex's hooks there already run ${hb} hook, set up by hand: left as they are`);
    } else {
      const cp = hk.codexPlanOf({ file: hfile, raw: p.codex.hooks, json: hjson }, { file: tfile, raw: p.codex.config }, { ravenryd: bin, scripts: false, daemonMatch: replaceHooks ? null : mine });
      const hooksText = JSON.stringify(cp.hooks.json, null, 2) + '\n';
      const hooksChanged = JSON.stringify(cp.hooks.json) !== JSON.stringify(hjson) || p.codex.hooks == null;
      const confChanged = cp.config.text !== String(p.codex.config || '');
      const prev = hooks.codex || {};
      const backups = [];
      let madeDir = false;
      if (hooksChanged) {
        const w = await writeRemote(m, hfile, hooksText, { expect: p.codex.hooks == null ? 'none' : p.codex.hookssha });
        if (!w.ok) { end(j, 'hooks', 'failed', w.why); return; }
        if (w.backup) backups.push(path.basename(w.backup));
        madeDir = w.madeDir;
      }
      if (confChanged) {
        const w = await writeRemote(m, tfile, cp.config.text, { expect: p.codex.config == null ? 'none' : p.codex.configsha });
        if (!w.ok) { end(j, 'hooks', 'failed', w.why); return; }
        if (w.backup) backups.push(path.basename(w.backup));
      }
      hooks.codex = { file: hfile, config: tfile, bin, created: prev.created ?? p.codex.hooks == null, configCreated: prev.configCreated ?? p.codex.config == null, madeDir: prev.madeDir ?? madeDir, replaced: [...(prev.replaced || []), ...(replaceHooks ? xhand : [])] };
      lines.push(hooksChanged || confChanged ? `Codex: added to ${t(hfile)} with its trust entries in ${t(tfile)}${backups.length ? `, the old files kept as ${backups.join(' and ')}` : ''}${cp.hooksOff ? '. Codex\'s hooks are turned off in its config.toml; they run once you turn them on' : ''}` : `Codex: already there in ${t(hfile)}, nothing changed`);
    }
  }

  // What was installed, for uninstall (and the next run).
  const manifest = {
    by: 'Ravenry', format: 1, version: b.version, system: key, sha256: build.sha256,
    installedAt: old && old.installedAt ? old.installedAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
    files: [`${BIN_DIR}/ravenryd`, `${BIN_DIR}/ravenry`],
    dirs: old && old.dirs ? old.dirs : [...(p.hasbin ? [] : [BIN_DIR]), ...(p.hasdir ? [] : ['.ravenry'])],
    replaced: { bin: replacedBin },
    hooks: { claude: hooks.claude, codex: hooks.codex },
  };
  // The manifest is Ravenry's own file: written whatever it held.
  const mw = await writeRemote(m, `${home}/${MANIFEST}`, JSON.stringify(manifest, null, 2) + '\n', { force: true, backup: false });
  if (!mw.ok) { end(j, 'hooks', 'failed', mw.why); return; }
  if (warn) end(j, 'hooks', 'warn', lines.join('. ') + '. Sessions there still report through those hooks.', { action: 'replaceHooks', title: 'Hooks already set up by hand' });
  else end(j, 'hooks', 'done', lines.join('. '));

  // ---- check
  begin(j, 'check');
  const cmdLine = bin;
  const st0 = machines.status().find((x) => x.name === m.name);
  if (m.command !== cmdLine) {
    const u = machines.update(m.name, { command: cmdLine });
    if (!u.ok) { end(j, 'check', 'failed', u.error); return; }
    if (u.reg && onRegistry) onRegistry(u.reg);
  } else if (copied || !st0 || st0.state !== 'connected' || st0.version !== b.version) machines.redial(m.name);
  const t0 = Date.now();
  let st = null;
  for (;;) {
    st = machines.status().find((x) => x.name === m.name);
    if (st && st.state === 'connected' && st.version === b.version) break;
    if (Date.now() - t0 > 30000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!st || st.state !== 'connected') { end(j, 'check', 'failed', `ravenryd ${b.version} is there, but the board could not connect to it: ${(st && st.error) || 'no answer in 30 s'}.`); return; }
  if (st.version !== b.version) { end(j, 'check', 'failed', `The board reached ravenryd ${st.version} there, not ${b.version}.`); return; }
  // The daemons that were there with panes stay for them: wait a moment for
  // the board to reach them too, so the check can say so.
  const kept = (Array.isArray(p.daemons) ? p.daemons : []).filter((d) => d && d.version !== b.version && d.panes > 0).map((d) => d.version);
  for (const t1 = Date.now(); kept.length && Date.now() - t1 < 10000;) {
    st = machines.status().find((x) => x.name === m.name) || st;
    if (kept.every((v) => (st.older || []).includes(v))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const olderNote = st.older && st.older.length ? `; sessions started before keep running on ${st.older.join(', ')} until they end` : '';
  end(j, 'check', 'done', `ravenryd ${b.version} runs there and the board is connected${st.answers ? ' and takes your answers' : ''}${olderNote}`);
  finish(j);
}

// Streams the binary into ~/.ravenry/bin/.ravenryd.part, counting bytes.
function upload(m, load, step) {
  return new Promise((resolve) => {
    const line = `sh -c 'umask 077; d="$HOME/${BIN_DIR}"; mkdir -p "$d" || exit 3; t="$d/.ravenryd.part"; if e=$(${load.gzip ? 'gzip -dc' : 'cat'} 2>&1 >"$t"); then echo "RVN wrote=1"; else rm -f "$t"; echo "RVN error=write $(echo $e)"; exit 4; fi'`;
    let child;
    try { child = spawn(machines.sshBin(), [...machines.SSH_OPTS, m.host, '--', line], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, why: `ssh did not start: ${e.message}` }); return; }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { err += '\ntimed out'; child.kill('SIGKILL'); }, Math.max(120000, load.bytes.length / 50));
    child.on('error', (e) => { err = `ssh did not start: ${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const kv = parse(out);
      if (code === 255 || code === -1) { resolve({ ok: false, why: sshFailure(m.host, err).why }); return; }
      if (kv.wrote === '1') { resolve({ ok: true }); return; }
      const msg = (kv.error || '').replace(/^write ?/, '') || err.trim().split('\n').pop() || `exit ${code}`;
      if (NO_SPACE.test(msg) || NO_SPACE.test(err) || NO_SPACE.test(out)) resolve({ ok: false, full: true, why: `${m.name}'s disk filled up while ravenryd was copied (${msg.trim()}). The part copied was removed. Free some space there, then try again.` });
      else if (code === 3) resolve({ ok: false, why: `Ravenry could not make ${BIN_DIR} in ${m.name}'s home folder.` });
      else resolve({ ok: false, why: `The copy to ${m.name} stopped: ${msg.trim()}` });
    });
    // Written in pieces, so the step can say how far it is.
    const CH = 256 * 1024;
    let off = 0;
    const pump = () => {
      while (off < load.bytes.length) {
        const piece = load.bytes.subarray(off, Math.min(off + CH, load.bytes.length));
        off += piece.length;
        step.progress = { done: off, total: load.bytes.length };
        if (!child.stdin.write(piece)) { child.stdin.once('drain', pump); return; }
      }
      child.stdin.end();
    };
    pump();
  });
}

// ---------------------------------------------------------------- uninstall

const UNINSTALL_STEPS = [['reach', 'Reach the machine over ssh'], ['sessions', 'Stop ravenryd there'], ['hooks', 'Take the hooks out'], ['files', 'Remove ravenryd'], ['forget', 'Take it off the list']];

// Starts an uninstall. { endSessions } ends the sessions still running
// there; without it, an uninstall that finds some stops and asks.
export function uninstall(name, { endSessions = false } = {}) {
  const m = machines.configured().find((x) => x.name === name);
  if (!m) return { ok: false, status: 404, error: `No machine is called ${name}.` };
  const cur = jobs.get(name);
  if (cur && cur.state === 'running') return { ok: false, status: 409, error: `Ravenry is already ${cur.kind === 'install' ? 'installing on' : 'uninstalling from'} ${name}.` };
  const j = newJob(name, 'uninstall', UNINSTALL_STEPS);
  j.done = runUninstall(j, m, { endSessions }).catch((e) => {
    const s = j.steps.find((x) => x.state === 'running') || j.steps.find((x) => x.state === 'pending');
    if (s) end(j, s.id, 'failed', `Something went wrong here: ${e.message}`);
    else finish(j, 'failed');
  }).finally(() => { if (j.state !== 'done') machines.hold(name, false); });
  return { ok: true, job: publicJob(j) };
}

let onRegistry = null;
// The hub's registry changed (a machine's command, a machine removed).
export function onRegistryChange(fn) { onRegistry = fn; }

async function runUninstall(j, m, { endSessions }) {
  const p = await reach(j, m);
  if (!p) return;
  const home = p.home;
  const t = (x) => tilde(home, x);
  const man = p.manifest && p.manifest.by === 'Ravenry' ? p.manifest : null;

  // ---- sessions
  begin(j, 'sessions');
  // The panes still running there, as the board sees them, else as the
  // daemons there count them.
  let running = 0;
  const live = machines.connected().filter((x) => x.name === m.name);
  if (live.length) {
    for (const d of live) {
      try { const { panes } = await d.c.request('pane.list', {}, { timeoutMs: 5000 }); running += panes.filter((x) => x.state === 'running').length; } catch { /* gone */ }
    }
  } else if (Array.isArray(p.daemons)) running = p.daemons.reduce((n, d) => n + (Number(d.panes) || 0), 0);
  if (running && !endSessions) {
    j.needs = { kind: 'sessions', count: running };
    end(j, 'sessions', 'failed', `${running} ${running === 1 ? 'session still runs' : 'sessions still run'} on ${m.name}. Uninstalling stops ravenryd there, which ends ${running === 1 ? 'it' : 'them'}. Close ${running === 1 ? 'it' : 'them'} first, or end ${running === 1 ? 'it' : 'them'} now.`, { action: 'endSessions' });
    j.state = 'needs';
    return;
  }
  machines.hold(m.name, true);
  const pids = (Array.isArray(p.daemons) ? p.daemons : []).map((d) => Number(d.pid)).filter((n) => Number.isInteger(n) && n > 1);
  if (pids.length) {
    const k = await script(m.host, `${pids.map((n) => `kill ${n} 2>/dev/null && P killed ${n}`).join('\n')}\nP ok 1\n`);
    if (k.code === 255) { end(j, 'sessions', 'failed', sshFailure(m.host, k.err).why); return; }
    end(j, 'sessions', 'done', `Stopped ${pids.length === 1 ? 'its daemon' : `its ${pids.length} daemons`}${running ? `, which ended ${running} ${running === 1 ? 'session' : 'sessions'}` : ''}`);
  } else end(j, 'sessions', 'done', 'No ravenryd was running there');

  if (!man) {
    for (const id of ['hooks', 'files']) end(j, id, 'skipped', null);
    stepOf(j, 'files').detail = `Ravenry did not install anything on ${m.name} (no ${MANIFEST} there), so nothing was removed.`;
    stepOf(j, 'files').state = 'done';
    return forget(j, m);
  }

  // ---- hooks
  begin(j, 'hooks');
  const lines = [];
  const restore = (json, replaced, bin) => {
    // The hooks set up by hand that Ravenry's replaced get their command back.
    const out = JSON.parse(JSON.stringify(json || {}));
    for (const r of replaced || []) {
      const list = (out.hooks && out.hooks[r.event]) || [];
      let done = false;
      for (const g of list) for (const h of (g && g.hooks) || []) {
        if (done || !h || typeof h.command !== 'string') continue;
        const w = hk.splitCommand(h.command);
        if (w[w.indexOf('hook') - 1] === bin) { h.command = r.command; done = true; }
      }
    }
    return out;
  };
  const ch = man.hooks && man.hooks.claude;
  if (ch && ch.file) {
    const raw = ch.file === `${p.claude.dir}/settings.json` ? p.claude.raw : null;
    if (raw == null) lines.push(`Claude Code: ${t(ch.file)} is not there any more`);
    else {
      let json;
      try { json = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { end(j, 'hooks', 'failed', `${t(ch.file)} is not valid JSON any more (${e.message}); Ravenry leaves it alone. Fix it, then try again.`); return; }
      const mine = (h) => { const w = hk.splitCommand(h.command); return w[w.indexOf('hook') - 1] === ch.bin; };
      const back = restore(json, ch.replaced, ch.bin);
      const pl = hk.plan(back, { remove: false, ravenryd: false, scripts: false, daemonMatch: mine });
      if (pl.settings.hooks && !Object.keys(pl.settings.hooks).length) delete pl.settings.hooks;
      const empty = !Object.keys(pl.settings).length;
      if (JSON.stringify(pl.settings) === JSON.stringify(json)) lines.push(`Claude Code: nothing of Ravenry's left in ${t(ch.file)}`);
      else if (ch.created && empty) {
        const r = await removeRemote(m, ch.file, { expect: p.claude.sha, backup: false });
        if (!r.ok) { end(j, 'hooks', 'failed', r.why); return; }
        lines.push(`Claude Code: removed ${t(ch.file)}, which Ravenry had made`);
      } else {
        const w = await writeRemote(m, ch.file, JSON.stringify(pl.settings, null, 2) + '\n', { expect: p.claude.sha });
        if (!w.ok) { end(j, 'hooks', 'failed', w.why); return; }
        lines.push(`Claude Code: taken out of ${t(ch.file)}${(ch.replaced || []).length ? ', your own hooks put back' : ''}${w.backup ? `, the old file kept as ${path.basename(w.backup)}` : ''}`);
      }
    }
  }
  const cx = man.hooks && man.hooks.codex;
  if (cx && cx.file) {
    const same = cx.file === `${p.codex.dir}/hooks.json`;
    const raw = same ? p.codex.hooks : null;
    if (raw == null) lines.push(`Codex: ${t(cx.file)} is not there any more`);
    else {
      let json;
      try { json = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { end(j, 'hooks', 'failed', `${t(cx.file)} is not valid JSON any more (${e.message}); Ravenry leaves it alone.`); return; }
      const mine = (h) => { const w = hk.splitCommand(h.command); return w[w.indexOf('hook') - 1] === cx.bin; };
      const back = restore(json, cx.replaced, cx.bin);
      const cp = hk.codexPlanOf({ file: cx.file, raw, json: back }, { file: cx.config, raw: p.codex.config }, { remove: true, scripts: false, daemonMatch: mine });
      const hooksEmpty = !Object.keys(cp.hooks.json).length || (Object.keys(cp.hooks.json).length === 1 && cp.hooks.json.hooks && !Object.keys(cp.hooks.json.hooks).length);
      if (JSON.stringify(cp.hooks.json) !== JSON.stringify(json)) {
        const r = cx.created && hooksEmpty ? await removeRemote(m, cx.file, { expect: p.codex.hookssha, backup: false }) : await writeRemote(m, cx.file, JSON.stringify(cp.hooks.json, null, 2) + '\n', { expect: p.codex.hookssha });
        if (!r.ok) { end(j, 'hooks', 'failed', r.why); return; }
      }
      if (cp.config.text !== String(p.codex.config || '')) {
        const r = cx.configCreated && !cp.config.text.trim() ? await removeRemote(m, cx.config, { expect: p.codex.configsha, backup: false }) : await writeRemote(m, cx.config, cp.config.text, { expect: p.codex.configsha });
        if (!r.ok) { end(j, 'hooks', 'failed', r.why); return; }
      }
      lines.push(`Codex: taken out of ${t(cx.file)} and its trust entries out of ${t(cx.config)}${(cx.replaced || []).length ? ', your own hooks put back' : ''}`);
    }
  }
  end(j, 'hooks', 'done', lines.join('. ') || 'Ravenry had added no hooks there');

  // ---- files
  begin(j, 'files');
  const back = man.replaced && man.replaced.bin ? man.replaced.bin : null;
  const dirs = Array.isArray(man.dirs) ? man.dirs.filter((d) => d === BIN_DIR || d === '.ravenry') : [];
  const fr = await script(m.host, `
R="$HOME/.ravenry"; d="$HOME/${BIN_DIR}"
if [ -L "$d/ravenry" ] && [ "$(readlink "$d/ravenry")" = ravenryd ]; then rm -f "$d/ravenry" && P link 1; fi
if [ -f "$d/ravenryd" ]; then rm -f "$d/ravenryd" && P bin 1; fi
${back && /^\.ravenry\/bin\/ravenryd\.bak-[0-9A-Za-z-]+$/.test(back) ? `if [ -f "$HOME/${back}" ]; then mv "$HOME/${back}" "$d/ravenryd" && P restored 1; fi` : ''}
rm -f "$d/.ravenryd.part" "$R/remote-install.json" && P manifest 1
${dirs.map((x) => `rmdir "$HOME/${x}" 2>/dev/null && P rmdir ${x === '.ravenry' ? 'top' : 'bin'}`).join('\n')}
P ok 1
`);
  if (fr.code === 255 || fr.code === -1) { end(j, 'files', 'failed', sshFailure(m.host, fr.err).why); return; }
  if (!fr.kv.ok) { end(j, 'files', 'failed', `Ravenry could not remove its files there (${(fr.err || '').trim() || 'no answer'}).`); return; }
  end(j, 'files', 'done', `Removed ${t(home + '/' + BIN_DIR + '/ravenryd')}${fr.kv.link ? ' and the ravenry link' : ''}${fr.kv.restored ? '; the ravenryd that was there before is back' : ''}${fr.kv.rmdir ? `; ${fr.kv.rmdir === 'top' ? '~/.ravenry' : '~/' + BIN_DIR} was empty and went too` : ''}. The pane logs stay in ravenryd's state folder there.`);
  return forget(j, m);
}

function forget(j, m) {
  begin(j, 'forget');
  const r = machines.remove(m.name);
  if (!r.ok) { end(j, 'forget', 'failed', r.error); return; }
  if (r.reg && onRegistry) onRegistry(r.reg);
  end(j, 'forget', 'done', `${m.name} is off the list. Add it again any time.`);
  finish(j);
}

// For tests: the promise of a machine's running job.
export function settled(name) { const j = jobs.get(name); return j && j.done ? j.done : Promise.resolve(); }
export function forgetJob(name) { jobs.delete(name); }
