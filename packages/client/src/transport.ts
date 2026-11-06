// How the client reaches a daemon. The client speaks protocol v1 over any
// Transport: a WebSocket in a browser or WebView, a WebSocket over the unix
// socket in Node (./node.ts), or a MessagePort that another process pipes
// to a WebSocket (the Electron renderer).
//
// A text WebSocket frame travels as a string, a binary frame as a
// Uint8Array.

import { SUBPROTOCOL } from './protocol.ts';

export interface Transport {
  send(data: string | Uint8Array): void;
  close(): void;
  /** Set by the client: one call per WebSocket message. */
  onmessage: ((data: string | Uint8Array) => void) | null;
  /** Set by the client: called once when the connection is gone. */
  onclose: ((reason: string) => void) | null;
}

/** The parts of the browser WebSocket this file uses. */
interface BrowserWebSocket {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

type WebSocketCtor = new (url: string, protocols: string | string[]) => BrowserWebSocket;

/**
 * Opens a WebSocket to a daemon (the url ends in /v1) and resolves once it
 * is open. In a browser or a WebView, the global WebSocket is used.
 */
export function openWebSocket(url: string, Ctor?: WebSocketCtor): Promise<Transport> {
  const WS = Ctor || ((globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket);
  return new Promise((resolve, reject) => {
    const ws = new WS(url, SUBPROTOCOL);
    ws.binaryType = 'arraybuffer';
    let open = false;
    const t: Transport = {
      send: (d) => ws.send(d),
      close: () => ws.close(1000),
      onmessage: null,
      onclose: null,
    };
    ws.onopen = () => { open = true; resolve(t); };
    ws.onerror = () => { if (!open) reject(new Error(`could not connect to ${url}`)); };
    ws.onmessage = (ev) => {
      const d = ev.data;
      t.onmessage?.(typeof d === 'string' ? d : new Uint8Array(d as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (!open) { reject(new Error(`could not connect to ${url}: ${ev.reason || ev.code}`)); return; }
      t.onclose?.(ev.reason || `closed (${ev.code})`);
    };
  });
}

/** The parts of a MessagePort this file uses (DOM and Electron alike). */
interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

/**
 * A transport over a MessagePort whose other end pipes a WebSocket. The pipe
 * posts strings for text frames, Uint8Array (or ArrayBuffer) for binary
 * frames, and { closed: reason } once the WebSocket has closed.
 */
export function messagePortTransport(port: PortLike): Transport {
  const t: Transport = {
    send: (d) => port.postMessage(d),
    close: () => { port.postMessage({ close: true }); },
    onmessage: null,
    onclose: null,
  };
  let gone = false;
  port.onmessage = (ev) => {
    const d = ev.data;
    if (typeof d === 'string') t.onmessage?.(d);
    else if (d instanceof Uint8Array) t.onmessage?.(d);
    else if (d instanceof ArrayBuffer) t.onmessage?.(new Uint8Array(d));
    else if (d && typeof d === 'object' && 'closed' in d && !gone) {
      gone = true;
      port.close();
      t.onclose?.(String((d as { closed: unknown }).closed || 'closed'));
    }
  };
  port.start?.();
  return t;
}
