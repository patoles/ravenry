// Finding the daemon (PROTOCOL.md section 9), and, when RAVENRYD names a
// ravenryd binary, the client against the real daemon: start it, open a
// shell, stream it with acks, type, paste, resize, close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, findDaemon, listSockets, runtimeDir, stateDir } from '../src/node.ts';
import { suppressTerminalQueries } from '../src/xterm.ts';
import type { XtermParserLike } from '../src/xterm.ts';

test('runtime and state folders follow section 9', () => {
  assert.equal(runtimeDir({ RAVENRY_RUNTIME_DIR: '/r' }, 'linux', '/h'), '/r');
  assert.equal(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1' }, 'linux', '/h'), '/run/user/1/ravenry');
  assert.equal(runtimeDir({}, 'linux', '/h'), '/h/.local/state/ravenry/run');
  assert.equal(runtimeDir({ XDG_STATE_HOME: '/s' }, 'linux', '/h'), '/s/ravenry/run');
  assert.equal(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1' }, 'darwin', '/h'), '/h/Library/Application Support/Ravenry/run');
  assert.equal(runtimeDir({ RAVENRY_STATE_DIR: '/st' }, 'darwin', '/h'), '/st/run');
  assert.equal(stateDir({}, 'darwin', '/h'), '/h/Library/Application Support/Ravenry');
});

test('versions sort as semver, a prerelease before its release', () => {
  const vs = ['0.1.0', '0.1.0-dev', '0.10.0', '0.2.0', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0'];
  assert.deepEqual([...vs].sort(compareVersions), ['0.1.0-dev', '0.1.0', '0.2.0', '0.10.0', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0']);
  assert.equal(compareVersions('1.2.3+build', '1.2.3'), 0);
});

test('sockets are listed newest first, other files ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-'));
  try {
    for (const n of ['ravenryd-0.9.0.sock', 'ravenryd-0.10.0.sock', 'ravenryd-0.10.0-dev.sock', 'other.sock', 'ravenryd.log']) fs.writeFileSync(path.join(dir, n), '');
    assert.deepEqual(listSockets(dir).map((s) => s.version), ['0.10.0', '0.10.0-dev', '0.9.0']);
    assert.deepEqual(listSockets(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no daemon and nothing to start says where it looked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvn-'));
  try {
    await assert.rejects(findDaemon({ name: 'test', env: { RAVENRY_RUNTIME_DIR: dir } }), /no ravenryd is running/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('query handlers swallow queries only', () => {
  const csi: { id: string; cb: (p: (number | number[])[]) => boolean | Promise<boolean> }[] = [];
  const osc: { n: number; cb: (d: string) => boolean | Promise<boolean> }[] = [];
  let disposed = 0;
  const parser: XtermParserLike = {
    registerCsiHandler(id, cb) { csi.push({ id: `${id.prefix || ''}${id.intermediates || ''}${id.final}`, cb }); return { dispose: () => { disposed++; } }; },
    registerDcsHandler() { return { dispose: () => { disposed++; } }; },
    registerOscHandler(n, cb) { osc.push({ n, cb }); return { dispose: () => { disposed++; } }; },
  };
  const d = suppressTerminalQueries(parser);
  const ids = csi.map((c) => c.id);
  for (const id of ['c', '>c', 'n', '?n', '$p', '?$p', '>q', '?u', 't']) assert.ok(ids.includes(id), id);
  const t = csi.find((c) => c.id === 't')!;
  assert.equal(t.cb([14]), true);
  assert.equal(t.cb([22, 0]), false);
  const o11 = osc.find((o) => o.n === 11)!;
  assert.equal(o11.cb('?'), true);
  assert.equal(o11.cb('rgb:00/00/00'), false);
  const o4 = osc.find((o) => o.n === 4)!;
  assert.equal(o4.cb('1;?'), true);
  assert.equal(o4.cb('1;rgb:ff/00/00'), false);
  d.dispose();
  assert.equal(disposed, csi.length + osc.length + 2);
});

// --------------------------------------------------- the real daemon
const BIN = process.env.RAVENRYD;
const real = BIN && fs.existsSync(BIN) ? test : test.skip;

real('against ravenryd: start, shell, stream with acks, type, paste, resize, close', async () => {
  // Short private folders: a unix socket path has a length limit.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));
  fs.chmodSync(base, 0o700);
  const rt = path.join(base, 'r');
  const env = { ...process.env, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(base, 's'), HOME: base };
  const { client, socket } = await findDaemon({ name: 'client-test', env, start: BIN, startEnv: env });
  try {
    assert.match(path.basename(socket), /^ravenryd-.+\.sock$/);
    assert.equal(client.hello.protocol, 1);
    const { pane } = await client.request('pane.new', { command: ['/bin/sh'], cwd: base, cols: 80, rows: 24, env: { PS1: '$ ' } });
    let text = '';
    let snapshots = 0;
    let ended = false;
    const dec = new TextDecoder();
    const s = await client.subscribe(pane.id, {
      data(d, info) {
        if (info.snapshot) snapshots++;
        text += dec.decode(d);
        info.ack();
      },
      end() { ended = true; },
    });
    const until = async (re: RegExp, ms = 5000) => {
      const t0 = Date.now();
      while (!re.test(text)) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}; got ${JSON.stringify(text.slice(-300))}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(/\$ /);
    assert.equal(snapshots, 1);
    s.input('echo typed-$((40+2))\r');
    await until(/typed-42/);
    // A paste goes through pane.send: newlines become Enter without bracketed paste on.
    await client.paste(pane.id, 'echo pasted-$((1+1))\n');
    await until(/pasted-2/);
    const r = await client.request('pane.resize', { pane: pane.id, cols: 100, rows: 30 });
    assert.equal(r.pane.cols, 100);
    s.input('stty size\r');
    await until(/30 100/);
    await client.request('pane.close', { pane: pane.id, grace_ms: 200 });
    const t0 = Date.now();
    while (!ended && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(ended, 'stream.end after close');
  } finally {
    client.close();
    // Stop the daemon this test started: it exits once its panes are gone and
    // its socket is removed; signal it to be sure.
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(BIN!, ['daemons', '--json'], { env, encoding: 'utf8' });
      for (const d of JSON.parse(out) as { pid: number }[]) process.kill(d.pid, 'SIGTERM');
    } catch { /* gone already */ }
    fs.rmSync(base, { recursive: true, force: true });
  }
});
