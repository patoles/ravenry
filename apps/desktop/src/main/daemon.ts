// The local ravenryd: found or started here, then piped to the window.
//
// The renderer runs the protocol client (@ravenry/client) itself. A sandboxed
// page cannot open a unix socket, so for each connection it asks for, this
// opens a WebSocket on the daemon's socket and pipes it through a
// MessagePort: text frames as strings, binary frames as bytes, and
// { closed } once the socket is gone.

import { MessageChannelMain } from 'electron';
import type { WebContents } from 'electron';
import { findDaemon, openUnixSocket, runtimeDir } from '@ravenry/client/node';
import { daemonBinary, daemonEnv } from './spawn.ts';

const CLIENT = { name: 'ravenry-desktop', version: process.env.npm_package_version || '0.1.0' };

export class DaemonLink {
  socket: string | null = null;
  version: string | null = null;
  private appRoot: string;
  private finding: Promise<string> | null = null;

  constructor(appRoot: string) {
    this.appRoot = appRoot;
  }

  /** The socket of the daemon new panes go to, starting one when none runs. */
  ensure(): Promise<string> {
    if (this.finding) return this.finding;
    this.finding = (async () => {
      const bin = daemonBinary(this.appRoot);
      const env = daemonEnv();
      const { client, socket } = await findDaemon({ ...CLIENT, env, start: bin || undefined, startEnv: env });
      this.version = client.hello.daemon.version;
      client.close();
      this.socket = socket;
      return socket;
    })();
    this.finding.catch(() => { this.finding = null; });
    return this.finding;
  }

  /** Forgets the daemon, so the next ensure() looks again (after it went away). */
  reset(): void {
    this.finding = null;
    this.socket = null;
  }

  where(): string {
    return runtimeDir();
  }

  /** Opens a connection to the daemon and hands the renderer its end of a MessagePort pipe. */
  async connect(wc: WebContents, req: number, pinned: string | null = null): Promise<void> {
    let socket: string;
    let t;
    if (pinned) {
      // A pane that lives in a given daemon (its panes outlive an update).
      socket = pinned;
      t = await openUnixSocket(socket);
    } else {
      socket = await this.ensure();
      try {
        t = await openUnixSocket(socket);
      } catch {
        // The daemon we knew is gone (an update finished, or it was stopped): look again.
        this.reset();
        socket = await this.ensure();
        t = await openUnixSocket(socket);
      }
    }
    const { port1, port2 } = new MessageChannelMain();
    let open = true;
    t.onmessage = (d) => {
      if (!open) return;
      // A structured clone copies a view's whole buffer, and ws hands out
      // views into large read buffers: send a tight copy instead.
      if (typeof d !== 'string' && (d.byteOffset !== 0 || d.byteLength !== d.buffer.byteLength)) d = d.slice();
      port1.postMessage(d);
    };
    t.onclose = (reason) => {
      if (!open) return;
      open = false;
      port1.postMessage({ closed: reason || 'the daemon closed the connection' });
      port1.close();
    };
    port1.on('message', (ev) => {
      const d = ev.data as unknown;
      if (typeof d === 'string' || d instanceof Uint8Array) { if (open) t.send(d); return; }
      if (d instanceof ArrayBuffer) { if (open) t.send(new Uint8Array(d)); return; }
      if (d && typeof d === 'object' && 'close' in d) {
        open = false;
        t.close();
        port1.close();
      }
    });
    port1.on('close', () => { if (open) { open = false; t.close(); } });
    port1.start();
    wc.postMessage('daemon:port', { socket, req }, [port2]);
  }
}
