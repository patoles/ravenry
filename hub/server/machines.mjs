// Remote machines: ravenryd on other machines, reached the way PROTOCOL.md
// section 1 says, `ssh <host> ravenryd proxy`. SSH does the
// authentication and honours ~/.ssh/config (aliases, jump hosts, keys);
// nothing listens on the remote machine. The hub keeps one connection per
// machine, and server/ravenryd.mjs uses it beside the local daemons, so
// every pane, agent report, hook decision and checkpoint of a remote
// machine reaches the board the same way, tagged with its machine.
//
// Answers: over ssh the remote daemon cannot see this machine, so it takes
// a person's answers (checkpoints, hook decisions) only from a connection
// that gives the answer key it trusts, the first one it was given
// (server/person.mjs). The hub gives its key on every connection, so the
// first hub to connect pairs; `answers` in status() says whether this one
// did.
//
// The list lives in the registry's settings (projects.json, "machines"):
// [{ name, host, command }]. `name` is what the board shows, `host` what
// ssh is given (a ~/.ssh/config alias, user@host, ...), `command` the
// remote ravenryd (default "ravenryd"; a full path when it is not on the
// PATH of a non-interactive ssh session).
//
// ssh runs with BatchMode=yes: it never asks for a password or to trust a
// new host key, since nobody is there to answer. A host it cannot reach
// that way shows its error; the user fixes it with ssh in a terminal.
//
// A connection that drops (the network, a sleeping laptop, the remote
// daemon updating) is tried again after 1, 2, 5, 10, then every 30
// seconds; the remote daemon keeps its panes meanwhile.
//
// Versions (PROTOCOL.md section 9). `proxy` reaches the newest daemon
// there. After an update (server/remoteinstall.mjs) an older daemon keeps
// its panes until they end, so once the newest one answers the hub asks
// `<command> daemons --json --no-start` and keeps a second connection,
// `<command> proxy --version <v>`, to each older daemon that still has
// panes; it is not tried again once it closes (the old daemon exits when
// its last pane ends). A command that is not there (exit 127) marks the
// machine `missing`; a daemon that does not speak protocol 1 is asked
// `<command> version --json`, and the machine says which version and
// protocol it has (`remote`), so the app can offer the installer instead
// of failing quietly.

import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as registry from './registry.mjs';
import { answerKey } from './person.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// A host as ssh takes it: an alias, user@host, host:port is not ssh's form.
const HOST_RE = /^(?!-)[A-Za-z0-9._@%+-]{1,255}$/;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export const sshBin = (env = process.env) => env.RAVENRY_SSH || 'ssh';

// The machines in the registry, cleaned.
export function configured(reg = registry.load()) {
  const list = reg && reg.settings && Array.isArray(reg.settings.machines) ? reg.settings.machines : [];
  return list.filter((m) => m && NAME_RE.test(m.name) && HOST_RE.test(m.host)).map((m) => ({ name: m.name, host: m.host, command: typeof m.command === 'string' && m.command.trim() ? m.command.trim() : 'ravenryd' }));
}

// Checks a machine to add. Returns an error for people, or null.
export function checkMachine(m, list = configured()) {
  if (!m || typeof m !== 'object') return 'Send { host, name, command }.';
  if (!HOST_RE.test(String(m.host || ''))) return 'The host is a name from ~/.ssh/config, a host name or user@host.';
  const name = m.name == null || m.name === '' ? String(m.host).replace(/^.*@/, '') : String(m.name);
  if (!NAME_RE.test(name)) return 'The name is 1 to 40 letters, digits, ".", "_" or "-".';
  if (name === 'local' || name === os.hostname()) return `"${name}" is this machine.`;
  if (list.some((x) => x.name === name)) return `A machine is already called ${name}.`;
  if (m.command != null && (typeof m.command !== 'string' || !/^[^\0\n'"`$;&|<>]{1,300}$/.test(m.command))) return 'The command is the path of ravenryd on that machine.';
  return null;
}

export function add(m) {
  const list = configured();
  const why = checkMachine(m, list);
  if (why) return { ok: false, status: 400, error: why };
  const entry = { name: m.name || String(m.host).replace(/^.*@/, ''), host: m.host, ...(m.command && m.command !== 'ravenryd' ? { command: m.command } : {}) };
  const w = registry.writeSettings({ machines: [...list.map(({ name, host, command }) => ({ name, host, ...(command !== 'ravenryd' ? { command } : {}) })), entry] });
  if (!w.ok) return w;
  sync();
  return { ok: true, machine: entry, reg: w.reg };
}

// Changes a machine's command (the installer points it at what it put
// there), and connects again.
export function update(name, patch) {
  const list = configured();
  const m = list.find((x) => x.name === name);
  if (!m) return { ok: false, status: 404, error: `No machine is called ${name}.` };
  if (patch.command != null && (typeof patch.command !== 'string' || !/^[^\0\n'"`$;&|<>]{1,300}$/.test(patch.command))) return { ok: false, status: 400, error: 'The command is the path of ravenryd on that machine.' };
  const next = list.map((x) => (x.name === name ? { ...x, ...patch } : x)).map(({ name: n, host, command }) => ({ name: n, host, ...(command && command !== 'ravenryd' ? { command } : {}) }));
  const w = registry.writeSettings({ machines: next });
  if (!w.ok) return w;
  sync();
  return { ok: true, reg: w.reg };
}

export function remove(name) {
  const list = configured();
  if (!list.some((m) => m.name === name)) return { ok: false, status: 404, error: `No machine is called ${name}.` };
  const rest = list.filter((m) => m.name !== name).map(({ name: n, host, command }) => ({ name: n, host, ...(command !== 'ravenryd' ? { command } : {}) }));
  const w = registry.writeSettings({ machines: rest.length ? rest : undefined });
  if (!w.ok) return w;
  sync();
  return { ok: true, reg: w.reg };
}

// The hosts in ~/.ssh/config, for "Add a machine" (read only; patterns
// with * or ? are left out).
export function sshHosts(file = path.join(os.homedir(), '.ssh', 'config')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const h of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(h) && HOST_RE.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------- connections

// name -> { m, state, c, child, error, since, tries, timer, version, removed,
// held, missing, remote, subs (version -> a link to an older daemon) }
const links = new Map();
let opts = null;

// Starts keeping a connection to every configured machine. `connect` is
// node-client's connect(stream, opts); `onUp(link)` runs when one
// connects (server/ravenryd.mjs follows its events then), `onDown(link)`
// when it drops.
export function start(o) {
  opts = { list: configured, ...o };
  sync();
}

export function stop() {
  opts = null;
  for (const l of links.values()) close(l, true);
  links.clear();
}

// Connects new machines and drops removed ones.
export function sync() {
  if (!opts) return;
  const want = opts.list();
  for (const [name, l] of links) {
    const m = want.find((x) => x.name === name);
    if (!m || m.host !== l.m.host || m.command !== l.m.command) { close(l, true); links.delete(name); }
  }
  for (const m of want) if (!links.has(m.name)) { const l = { m, id: `ssh:${m.name}`, state: 'connecting', c: null, child: null, error: null, since: new Date().toISOString(), tries: 0, timer: null, removed: false, held: false, subs: new Map() }; links.set(m.name, l); dial(l); }
}

function close(l, removed) {
  l.removed = removed;
  clearTimeout(l.timer);
  if (l.c) l.c.close();
  if (l.child) { try { l.child.kill('SIGTERM'); } catch { /* gone */ } }
  if (l.subs) for (const s of l.subs.values()) close(s, true);
}

// The ssh options every connection and remote command uses: never a
// question (BatchMode), and a dead connection noticed within a minute.
export const SSH_OPTS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

function dial(l) {
  if (l.removed || l.held || !opts) return;
  l.state = 'connecting';
  const sub = !!l.parent;
  // ssh runs the command through the remote login shell, as one line.
  const args = [...SSH_OPTS, l.m.host, '--', `${l.m.command} proxy${sub ? ` --version ${l.version}` : ''}`];
  let child;
  try { child = spawn(sshBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return down(l, `ssh did not start: ${e.message}`); }
  l.child = child;
  let err = '';
  let code = null;
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  child.on('error', (e) => { err = `ssh did not start: ${e.message}`; });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.on('error', () => {});
  let settled = false;
  child.on('exit', (c) => {
    code = c;
    if (!settled) { settled = true; failed(l, err, code, null); }
  });
  opts.connect(stream, { name: 'ravenry-hub', timeoutMs: 15000, answerKey: answerKey() }).then((c) => {
    if (settled || l.removed) { c.close(); return; }
    l.c = c;
    l.state = 'connected';
    l.error = null;
    l.tries = 0;
    l.missing = false;
    l.remote = null;
    l.asked = false;
    l.since = new Date().toISOString();
    l.version = c.hello && c.hello.daemon ? c.hello.daemon.version : l.version || null;
    l.os = c.hello && c.hello.daemon ? c.hello.daemon.os || null : null;
    l.arch = c.hello && c.hello.daemon ? c.hello.daemon.arch || null : null;
    l.protocol = c.hello ? c.hello.protocol : null;
    // Whether that machine takes this hub's answers (PROTOCOL.md section
    // 4, Who acts as the person): it trusts this hub's answer key.
    l.person = !!(c.hello && c.hello.person);
    c.on('close', () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      down(l, sshError(err) || 'the connection dropped');
    });
    if (opts.onUp) opts.onUp(l);
    if (!sub) findOlder(l);
  }, (e) => {
    if (settled) return;
    settled = true;
    // The remote command may be exiting: its code says why (127: not
    // there). Wait a moment for it before stopping ssh.
    let done = false;
    const finish = () => { if (done) return; done = true; try { child.kill('SIGTERM'); } catch { /* gone */ } failed(l, err, code, e); };
    if (code !== null) finish();
    else { const t = setTimeout(finish, 500); child.once('exit', (c) => { clearTimeout(t); code = c; finish(); }); }
  });
}

// Why a connection failed, and what that machine has instead: the
// command is not there (127), or ssh worked and the command ran but did
// not speak protocol 1 (it is asked its version once).
function failed(l, err, code, e) {
  const why = sshError(err);
  l.missing = code === 127 || (!!why && /is not on that machine's PATH/.test(why));
  const sshFailed = code === 255;
  if (!l.parent && !l.missing && !sshFailed && e && !l.asked) {
    l.asked = true;
    remoteVersion(l.m).then((v) => {
      l.remote = v;
      if (otherProtocol(l) && l.state !== 'connected') l.error = otherProtocol(l);
    });
  }
  if (l.missing || sshFailed) l.remote = null;
  down(l, otherProtocol(l) || why || (e ? e.message : 'ssh closed the connection'));
}

// What a daemon of another protocol said of itself, for people.
function otherProtocol(l) {
  const v = l.remote;
  if (!v || v.protocol === PROTOCOL) return null;
  return `${l.m.name} runs ravenryd ${v.version}, which ${v.protocol == null ? `does not speak protocol ${PROTOCOL}` : `speaks protocol ${v.protocol}`}; this hub speaks protocol ${PROTOCOL}.`;
}

export const PROTOCOL = 1;

// `<command> version --json` on a machine: { version, protocol, os, arch }
// or null.
export function remoteVersion(m, timeoutMs = 15000) {
  return runSsh(m.host, `${m.command} version --json`, { timeoutMs }).then((r) => {
    if (r.code !== 0) return null;
    try { const v = JSON.parse(r.out); return v && typeof v.version === 'string' ? { version: v.version, protocol: Number.isInteger(v.protocol) ? v.protocol : null, os: v.os || null, arch: v.arch || null } : null; } catch { return null; }
  });
}

// Runs one command line over ssh: { code, out, err }. `input` goes to its
// standard input.
export function runSsh(host, line, { timeoutMs = 30000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(sshBin(), [...SSH_OPTS, host, '--', line], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: '', err: `ssh did not start: ${e.message}` }); return; }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.stdin.on('error', () => {});
    const t = setTimeout(() => { err += `\ntimed out after ${Math.round(timeoutMs / 1000)} s`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { err = `ssh did not start: ${e.message}`; });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.stdin.end(input == null ? '' : input);
  });
}

// The older daemons on a machine that still have panes, each reached with
// its own `proxy --version`.
function findOlder(l) {
  if (!opts || l.removed) return;
  runSsh(l.m.host, `${l.m.command} daemons --json --no-start`, { timeoutMs: 20000 }).then((r) => {
    if (r.code !== 0 || l.removed || l.state !== 'connected') return;
    let rows = [];
    try { rows = JSON.parse(r.out); } catch { return; }
    for (const d of Array.isArray(rows) ? rows : []) {
      if (!d || typeof d.version !== 'string' || d.version === l.version || !(d.panes > 0) || l.subs.has(d.version)) continue;
      if (!/^[0-9A-Za-z.+-]{1,64}$/.test(d.version)) continue;
      const s = { m: l.m, id: `ssh:${l.m.name}@${d.version}`, parent: l, version: d.version, state: 'connecting', c: null, child: null, error: null, since: new Date().toISOString(), tries: 0, timer: null, removed: false, subs: new Map() };
      l.subs.set(d.version, s);
      dial(s);
    }
  });
}

// The line of ssh's stderr that says why, or of the remote command's.
export function sshError(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !/^Warning: Permanently added/.test(s));
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  if (/command not found|No such file/.test(last)) return `ravenryd is not on that machine's PATH (${last}). Install it there, or give its full path.`;
  return last;
}

function down(l, why) {
  const was = l.state;
  l.c = null;
  l.child = null;
  l.state = l.removed ? 'removed' : 'down';
  l.error = why;
  l.since = new Date().toISOString();
  if (was === 'connected' && opts && opts.onDown) opts.onDown(l);
  // A connection to an older daemon is not tried again: that daemon exits
  // once its panes end, and the next connection finds the ones still there.
  if (l.parent) { l.removed = true; if (l.parent.subs.get(l.version) === l) l.parent.subs.delete(l.version); return; }
  if (l.removed || l.held || !opts) return;
  const wait = BACKOFF_MS[Math.min(l.tries, BACKOFF_MS.length - 1)];
  l.tries++;
  l.timer = setTimeout(() => dial(l), Number(process.env.RAVENRY_MACHINE_RETRY_MS) || wait);
  l.timer.unref();
}

// The connected daemons: [{ name, id, c, version }], each machine's newest
// first, then the older ones it still reaches.
export function connected() {
  const up = (l) => l.state === 'connected' && l.c && !l.c.closed;
  const out = [];
  for (const l of links.values()) {
    if (!up(l)) continue;
    out.push({ name: l.m.name, id: l.id, c: l.c, version: l.version });
    for (const s of l.subs.values()) if (up(s)) out.push({ name: l.m.name, id: s.id, c: s.c, version: s.version });
  }
  return out;
}

// What the board and the app show: every configured machine with its state.
// `os`, `arch` and `protocol` come from the daemon's hello; `older` lists
// the older daemons still reached for their panes; `missing` says ravenryd
// is not there; `remote` is what a daemon that would not talk said of
// itself (`ravenryd version --json`).
export function status() {
  const list = opts ? opts.list() : configured();
  return list.map((m) => {
    const l = links.get(m.name);
    const on = l && l.state === 'connected';
    return {
      name: m.name, host: m.host, command: m.command, state: l ? (l.held ? 'held' : l.state) : 'off', error: l && !on ? l.error : null, since: l ? l.since : null,
      version: on ? l.version : null, answers: on ? l.person : null, os: on ? l.os || null : null, arch: on ? l.arch || null : null, protocol: on ? l.protocol ?? null : null,
      older: on ? [...l.subs.values()].filter((s) => s.state === 'connected').map((s) => s.version) : [],
      missing: !!(l && !on && l.missing), remote: l && !on ? l.remote || null : null,
    };
  });
}

// Tries again now (the board's Retry), instead of at the next backoff.
export function retry(name) {
  const l = links.get(name);
  if (!l || l.held || l.state === 'connected' || l.state === 'connecting') return false;
  clearTimeout(l.timer);
  l.tries = 0;
  l.asked = false;
  dial(l);
  return true;
}

// Drops the connection and dials again at once: after an install, the new
// version's proxy starts its daemon beside the old one.
export function redial(name) {
  const l = links.get(name);
  if (!l || l.held) return false;
  links.delete(name);
  close(l, true);
  sync();
  return true;
}

// Stops dialing a machine (the uninstaller ends its daemons) until
// released; `held` shows meanwhile.
export function hold(name, on) {
  const l = links.get(name);
  if (!l) return false;
  l.held = !!on;
  if (on) {
    clearTimeout(l.timer);
    for (const s of l.subs.values()) close(s, true);
    l.subs.clear();
    if (l.c) l.c.close();
    if (l.child) { try { l.child.kill('SIGTERM'); } catch { /* gone */ } }
  } else if (l.state !== 'connected') { l.tries = 0; dial(l); }
  return true;
}
