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

// name -> { m, state, c, child, error, since, tries, timer, version, removed }
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
  for (const m of want) if (!links.has(m.name)) { const l = { m, state: 'connecting', c: null, child: null, error: null, since: new Date().toISOString(), tries: 0, timer: null, removed: false }; links.set(m.name, l); dial(l); }
}

function close(l, removed) {
  l.removed = removed;
  clearTimeout(l.timer);
  if (l.c) l.c.close();
  if (l.child) { try { l.child.kill('SIGTERM'); } catch { /* gone */ } }
}

function dial(l) {
  if (l.removed || !opts) return;
  l.state = 'connecting';
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', l.m.host, '--', l.m.command, 'proxy'];
  let child;
  try { child = spawn(sshBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return down(l, `ssh did not start: ${e.message}`); }
  l.child = child;
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  child.on('error', (e) => { err = `ssh did not start: ${e.message}`; });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.on('error', () => {});
  let settled = false;
  child.on('exit', () => {
    if (!settled) { settled = true; down(l, sshError(err) || 'ssh closed the connection'); }
  });
  opts.connect(stream, { name: 'ravenry-hub', timeoutMs: 15000, answerKey: answerKey() }).then((c) => {
    if (settled || l.removed) { c.close(); return; }
    l.c = c;
    l.state = 'connected';
    l.error = null;
    l.tries = 0;
    l.since = new Date().toISOString();
    l.version = c.hello && c.hello.daemon ? c.hello.daemon.version : null;
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
  }, (e) => {
    if (settled) return;
    settled = true;
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    down(l, sshError(err) || e.message);
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
  if (l.removed || !opts) return;
  const wait = BACKOFF_MS[Math.min(l.tries, BACKOFF_MS.length - 1)];
  l.tries++;
  l.timer = setTimeout(() => dial(l), Number(process.env.RAVENRY_MACHINE_RETRY_MS) || wait);
  l.timer.unref();
}

// The connected machines: [{ name, c }].
export function connected() {
  return [...links.values()].filter((l) => l.state === 'connected' && l.c && !l.c.closed).map((l) => ({ name: l.m.name, c: l.c, version: l.version }));
}

// What the board and the app show: every configured machine with its state.
export function status() {
  const list = opts ? opts.list() : configured();
  return list.map((m) => {
    const l = links.get(m.name);
    return { name: m.name, host: m.host, command: m.command, state: l ? l.state : 'off', error: l && l.state !== 'connected' ? l.error : null, since: l ? l.since : null, version: l && l.state === 'connected' ? l.version : null, answers: l && l.state === 'connected' ? l.person : null };
  });
}

// Tries again now (the board's Retry), instead of at the next backoff.
export function retry(name) {
  const l = links.get(name);
  if (!l || l.state === 'connected' || l.state === 'connecting') return false;
  clearTimeout(l.timer);
  l.tries = 0;
  dial(l);
  return true;
}
