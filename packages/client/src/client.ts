// A client of protocol v1 over any Transport: requests matched to results
// by id, events, and pane streams with acknowledgements.

import { decodeFrame, inputFrame, KIND_OUTPUT, KIND_SNAPSHOT } from './frames.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import type { Channel, DaemonEvent, DaemonMessage, HelloResult, Input, Mark, Method, Methods, PaneId } from './protocol.ts';
import type { Transport } from './transport.ts';

/** A request the daemon refused or could not do. `code` is the protocol's error code. */
export class RavenryError extends Error {
  code: string;
  method: string;
  constructor(method: string, code: string, message: string) {
    super(`${method}: ${message} (${code})`);
    this.name = 'RavenryError';
    this.code = code;
    this.method = method;
  }
}

export interface FrameInfo {
  /** True for a frame that rebuilds the screen rather than continuing it. */
  snapshot: boolean;
  /** The output position of the frame's first byte (a snapshot: the position it shows). */
  mark: Mark;
  /** Acknowledges this frame's bytes. Safe to call more than once; only the first counts. */
  ack: () => void;
}

/** Where a stream's frames go. */
export interface StreamSink {
  /**
   * Terminal bytes to write as they are. `snapshot` is true for a frame that
   * rebuilds the screen (it starts with a full reset). With acknowledgement
   * on (the default), call info.ack() once they are processed, for xterm.js
   * as the write callback (term.write(data, info.ack)), or the daemon holds
   * further output back.
   */
  data(data: Uint8Array, info: FrameInfo): void;
  /** The pane's output ended: its program exited or the pane was closed. */
  end?(mark: Mark): void;
}

export interface SubscribeOptions {
  /** Start with the raw output from this mark instead of a snapshot, when the daemon still holds it. */
  since?: Mark;
  /** Acknowledge processed bytes (default true), so the daemon bundles output by backlog. */
  ack?: boolean;
  /** How far behind (bytes) before the daemon sends a fresh snapshot instead. */
  window?: number;
}

/** One pane's output stream on this connection. */
export class PaneStream {
  readonly pane: PaneId;
  readonly channel: Channel;
  readonly acking: boolean;
  /** The output position written so far (after the last frame). */
  mark = 0;
  ended = false;
  private client: RavenryClient;
  private owed = 0;
  private flushQueued = false;

  constructor(client: RavenryClient, pane: PaneId, channel: Channel, acking: boolean) {
    this.client = client;
    this.pane = pane;
    this.channel = channel;
    this.acking = acking;
  }

  /** Keystrokes or other bytes for the pane, as they are (a binary input frame). */
  input(data: string | Uint8Array): void {
    if (this.ended) return;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    if (bytes.byteLength) this.client.sendRaw(inputFrame(this.channel, bytes));
  }

  /**
   * Says n more payload bytes were processed. Acks made in the same turn of
   * the event loop go out as one message, at once after it.
   */
  ack(n: number): void {
    if (!this.acking || this.ended || n <= 0) return;
    this.owed += n;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const bytes = this.owed;
      this.owed = 0;
      if (bytes > 0 && !this.ended) this.client.sendJson({ v: PROTOCOL_VERSION, type: 'ack', channel: this.channel, bytes });
    });
  }

  /** Stops the stream. Nothing more arrives for it. */
  async unsubscribe(): Promise<void> {
    if (this.ended) return;
    this.client.dropStream(this.channel);
    this.ended = true;
    try {
      await this.client.request('pane.unsubscribe', { channel: this.channel });
    } catch (e) {
      // The stream already ended on the daemon's side, or the connection is gone.
      if (!(e instanceof RavenryError) || e.code !== 'not_found') {
        if (!this.client.closed) throw e;
      }
    }
  }
}

const encoder = new TextEncoder();

interface Pending {
  method: string;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

interface Route {
  stream: PaneStream | null;
  sink: StreamSink;
  early: { data: Uint8Array; snapshot: boolean; mark: Mark }[];
  endMark: Mark | null;
}

export interface ConnectOptions {
  /** Who the client is, for the daemon's logs. */
  name: string;
  version?: string;
}

export class RavenryClient {
  hello!: HelloResult;
  closed = false;
  closeReason = '';
  private t: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private routes = new Map<Channel, Route>();
  private dropped = new Set<Channel>();
  private eventHandlers = new Set<(e: DaemonEvent) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  private errorHandlers = new Set<(e: RavenryError) => void>();

  private constructor(t: Transport) {
    this.t = t;
    t.onmessage = (d) => this.receive(d);
    t.onclose = (reason) => this.gone(reason);
  }

  /** Says hello over an open transport. */
  static async connect(t: Transport, opts: ConnectOptions): Promise<RavenryClient> {
    const c = new RavenryClient(t);
    const client: { name: string; version?: string } = { name: opts.name };
    if (opts.version) client.version = opts.version;
    try {
      c.hello = await c.request('hello', { client });
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  /** True when the daemon lists the method in hello (section 10). */
  supports(method: string): boolean {
    return !!this.hello && this.hello.methods.includes(method);
  }

  request<M extends Method>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    return this.requestWithId(method, params).promise;
  }

  /** As request, with the id, for `cancel`. */
  requestWithId<M extends Method>(method: M, params: Methods[M]['params']): { id: number; promise: Promise<Methods[M]['result']> } {
    const id = this.nextId++;
    const promise = new Promise<Methods[M]['result']>((resolve, reject) => {
      if (this.closed) { reject(new RavenryError(method, 'closed', this.closeReason || 'the connection is closed')); return; }
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.sendJson({ v: PROTOCOL_VERSION, type: method, id, ...params });
    });
    return { id, promise };
  }

  /** Starts a pane's stream. Frames go to the sink; the stream's first frame is a snapshot unless `since` was honoured. */
  async subscribe(pane: PaneId, sink: StreamSink, opts: SubscribeOptions = {}): Promise<PaneStream> {
    const acking = opts.ack !== false;
    const params: Methods['pane.subscribe']['params'] = { pane, ack: acking };
    if (opts.since !== undefined) params.since = opts.since;
    if (opts.window !== undefined) params.window = opts.window;
    const { channel } = await this.request('pane.subscribe', params);
    // The result comes before the channel's first frame, so frames that
    // arrive meanwhile can only be in this same message batch; route them.
    let route = this.routes.get(channel);
    if (!route) { route = { stream: null, sink, early: [], endMark: null }; this.routes.set(channel, route); }
    route.sink = sink;
    const stream = new PaneStream(this, pane, channel, acking);
    route.stream = stream;
    for (const f of route.early.splice(0)) this.deliver(route, f.data, f.snapshot, f.mark);
    if (route.endMark !== null) this.endRoute(channel, route, route.endMark);
    return stream;
  }

  /** Receives every event (after events.subscribe for pane and daemon events; stream.end always). */
  onEvent(fn: (e: DaemonEvent) => void): () => void {
    this.eventHandlers.add(fn);
    return () => this.eventHandlers.delete(fn);
  }

  onClose(fn: (reason: string) => void): () => void {
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  /** Errors the daemon could not tie to a request. */
  onError(fn: (e: RavenryError) => void): () => void {
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  /** Sends text to a pane as one paste: bracketed when the program asked for it, newlines as Enter otherwise. */
  paste(pane: PaneId, text: string): Promise<Methods['pane.send']['result']> {
    return this.request('pane.send', { pane, input: [{ text, mode: 'paste' }] });
  }

  send(pane: PaneId, input: Input[]): Promise<Methods['pane.send']['result']> {
    return this.request('pane.send', { pane, input });
  }

  close(): void {
    if (this.closed) return;
    try { this.t.close(); } catch { /* already gone */ }
    this.gone('closed by the client');
  }

  // ---------------------------------------------------------- internals

  /** @internal */
  sendJson(msg: object): void {
    if (this.closed) return;
    this.t.send(JSON.stringify(msg));
  }

  /** @internal */
  sendRaw(bytes: Uint8Array): void {
    if (this.closed) return;
    this.t.send(bytes);
  }

  /** @internal */
  dropStream(channel: Channel): void {
    this.routes.delete(channel);
    this.dropped.add(channel);
  }

  private receive(d: string | Uint8Array): void {
    if (typeof d !== 'string') { this.receiveFrame(d); return; }
    let m: DaemonMessage;
    try { m = JSON.parse(d); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      p.resolve(m.result);
    } else if (m.type === 'error') {
      const err = new RavenryError(m.id !== undefined ? this.pending.get(m.id)?.method || '?' : 'daemon', m.error.code, m.error.message);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.reject(err); return; }
      }
      for (const fn of this.errorHandlers) fn(err);
    } else if (m.type === 'event') {
      if (m.event === 'stream.end' && !this.dropped.has(m.channel)) {
        let route = this.routes.get(m.channel);
        if (route && route.stream) this.endRoute(m.channel, route, m.mark);
        else if (route) route.endMark = m.mark;
        else {
          // A subscribe whose result has not been read yet.
          route = { stream: null, sink: { data() {} }, early: [], endMark: m.mark };
          this.routes.set(m.channel, route);
        }
      }
      const { v: _v, type: _t, ...ev } = m;
      for (const fn of this.eventHandlers) fn(ev as DaemonEvent);
    }
    // Unknown types are ignored (section 10).
  }

  private receiveFrame(buf: Uint8Array): void {
    const f = decodeFrame(buf);
    if (!f || f.version !== 1) return;
    if (f.kind !== KIND_OUTPUT && f.kind !== KIND_SNAPSHOT) return; // unknown kinds are ignored
    const snapshot = f.kind === KIND_SNAPSHOT;
    if (this.dropped.has(f.channel)) return;
    let route = this.routes.get(f.channel);
    if (!route) {
      route = { stream: null, sink: { data() {} }, early: [], endMark: null };
      this.routes.set(f.channel, route);
    }
    if (!route.stream) { route.early.push({ data: f.payload, snapshot, mark: f.mark }); return; }
    this.deliver(route, f.payload, snapshot, f.mark);
  }

  private deliver(route: Route, data: Uint8Array, snapshot: boolean, mark: Mark): void {
    const s = route.stream!;
    s.mark = snapshot ? mark : mark + data.byteLength;
    let acked = false;
    const n = data.byteLength;
    route.sink.data(data, { snapshot, mark, ack: () => { if (!acked) { acked = true; s.ack(n); } } });
  }

  private endRoute(channel: Channel, route: Route, mark: Mark): void {
    this.routes.delete(channel);
    const s = route.stream!;
    s.ended = true;
    route.sink.end?.(mark);
  }

  private gone(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, p] of this.pending) p.reject(new RavenryError(p.method, 'closed', reason || 'the connection closed'));
    this.pending.clear();
    // Streams stop without end(): the pane did not end, the connection did.
    for (const [, r] of this.routes) if (r.stream) r.stream.ended = true;
    this.routes.clear();
    for (const fn of this.closeHandlers) fn(reason);
  }
}
