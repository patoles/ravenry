# @ravenry/node-client

A client of the [Ravenry protocol v1](../protocol/PROTOCOL.md) for Node
programs: the hub, plugins, scripts. Plain JavaScript with no dependency
and no build step, so it runs in any Node 22, in Electron's Node, and in a
program that is never installed with npm. It speaks WebSocket itself, over
the daemon's unix socket or any duplex stream, such as the standard input
and output of `ssh host ravenryd proxy`.

For a browser, a WebView or the Electron renderer, with types and xterm.js
helpers, use [@ravenry/client](../client/README.md).

Licence: Apache-2.0 ([../LICENSE](../LICENSE)), so a plugin or client built
on it may use any licence.

## Use

```js
import { connectSocket, daemonSockets } from '@ravenry/node-client';

// The newest daemon in the runtime folder (section 9 of the spec).
const [newest] = daemonSockets();
const c = await connectSocket(newest.socket, { name: 'my-plugin', version: '1.0.0' });

await c.request('events.subscribe', {});
c.on('event', (e) => {
  if (e.event === 'agent.report') console.log(e.report.pane, e.pane?.agent?.state);
});

const { pane } = await c.request('pane.new', { cwd: process.cwd() });
await c.request('pane.send', { pane: pane.id, input: [{ text: 'make test', mode: 'paste' }, { key: 'Enter' }] });
const done = await c.request('pane.wait', { pane: pane.id, prompt: true, timeout_ms: 600000 });
```

Over SSH:

```js
import { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { connect } from '@ravenry/node-client';

const ssh = spawn('ssh', ['devbox', 'ravenryd', 'proxy']);
const c = await connect(Duplex.from({ readable: ssh.stdout, writable: ssh.stdin }), { name: 'my-plugin' });
```

Deciding what an assistant's hook answers (the hub does this for the
hand-off):

```js
await c.request('agent.decisions', {});
c.on('event', (e) => {
  if (e.event !== 'agent.decision') return;
  const hold = e.report.event === 'Stop' && wantsToHold(e.report);
  c.request('agent.decide', { request: e.request, ...(hold ? { reply: { stdout: '{"decision":"block","reason":"..."}\n' } } : {}) });
});
```

## API

- `connectSocket(path, { name, version, timeoutMs })` and
  `connect(duplex, opts)`: the handshake and `hello`. Resolve to a Client.
- `client.request(method, params, { timeoutMs, signal })`: resolves to the
  result, rejects with a `RavenryError` whose `code` is the protocol's
  error code (or `disconnected`, `timeout`, `cancelled`). A request that
  times out or is aborted is cancelled on the daemon.
- `client.hello`, `client.has(method)`: what the daemon said and supports.
- Events: `'event'` (each daemon event), `'frame'` (`{ kind, channel,
  mark, data }`, a pane stream's binary frame), `'close'`.
- `client.input(channel, bytes)`, `client.ack(channel, bytes)`,
  `client.close()`.
- `runtimeDir()`, `stateDir()`, `daemonSockets(dir)` (newest version
  first), `compareVersions(a, b)`.

## Tests

```sh
npm test                                     # against a fake daemon
RAVENRYD_BIN=../../daemon/ravenryd npm test  # and the real one
```
