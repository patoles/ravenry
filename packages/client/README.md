# @ravenry/client

A TypeScript client of the [Ravenry protocol v1](../protocol/PROTOCOL.md),
the protocol `ravenryd` speaks. The desktop app uses it, and so will the
Android app's WebView. It has no dependency in a browser; in Node it uses
`ws` for the unix socket.

Licence: Apache-2.0 ([../LICENSE](../LICENSE)), so a client built on it may
use any licence.

## Use

```ts
import { findDaemon } from '@ravenry/client/node';

// The daemon new panes belong to (section 9 of the spec), started when none runs.
const { client } = await findDaemon({ name: 'my-client', start: '/path/to/ravenryd' });
const { pane } = await client.request('pane.new', { cols: 80, rows: 24 });

// Snapshot first, then live bytes. Acknowledge each frame once it is drawn,
// so the daemon bundles output by backlog and never waits on a slow window.
const stream = await client.subscribe(pane.id, {
  data(bytes, info) { term.write(bytes, info.ack); },
  end() { /* the program exited or the pane was closed */ },
});
term.onData((d) => stream.input(d));             // keystrokes, as they are
await client.paste(pane.id, 'git status\n');     // one paste, bracketed when the program asks
await client.request('pane.resize', { pane: pane.id, cols: 120, rows: 40 });
```

In a browser or a WebView, open the transport yourself and connect:

```ts
import { openWebSocket, RavenryClient } from '@ravenry/client';
const client = await RavenryClient.connect(await openWebSocket(url), { name: 'phone' });
```

`messagePortTransport(port)` connects over a MessagePort whose other end
pipes a WebSocket (how the Electron renderer reaches the daemon through
the main process).

## What it covers

- **Requests** for every v1 method, typed (`client.request(method, params)`),
  matched to results by id. A refused request rejects with a
  `RavenryError` whose `code` is the protocol's error code.
- **Events** (`client.onEvent`) after `events.subscribe`, and `stream.end`.
- **Streams** (`client.subscribe`): frames in order, including frames that
  arrive in the same read as the subscribe result; acknowledgements batched
  per turn of the event loop; input frames.
- **Finding the daemon** (`@ravenry/client/node`): the runtime folder,
  sockets newest version first, draining daemons skipped, `ravenryd serve
  --detach` when none runs.
- **xterm.js** (`suppressTerminalQueries(term.parser)`): the daemon answers
  the programs' terminal queries, so a client that draws a pane with
  xterm.js must not answer them too. This swallows the queries and leaves
  every other sequence to xterm.js.

## Tests

```sh
npm test                                  # a fake daemon, no build needed
RAVENRYD=../../daemon/ravenryd npm test   # plus the real daemon
```
