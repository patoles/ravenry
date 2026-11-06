// The wire types of protocol v1 (../../protocol/PROTOCOL.md and
// schema/v1.json). Only what a client sends and reads; the daemon may add
// fields, which a client ignores (section 10).

export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = 'ravenry.v1';
export const PATH = '/v1';

export type PaneId = string;
export type Mark = number;
export type Channel = number;

export interface Exit {
  code: number;
  signal?: string;
}

/** A shell's state from its OSC 133 marks (section 3, Shell marks). */
export interface Shell {
  state: 'prompt' | 'running';
  command?: string;
  exit_code?: number;
  mark?: Mark;
  at?: string;
}

export type AgentStateName = 'working' | 'needs_you' | 'idle' | 'ended';

export interface Need {
  kind: 'permission' | 'question' | 'auth' | 'other';
  message?: string;
}

/** The agent running in a pane (section 3, The agent in a pane). */
export interface AgentStatus {
  state: AgentStateName;
  since?: string;
  assistant?: string;
  session?: string;
  need?: Need;
  event?: string;
  at?: string;
  source?: 'hook' | 'program' | 'daemon';
  seq?: number;
}

export interface AgentReport {
  seq: number;
  at: string;
  pane?: PaneId;
  assistant: string;
  source: 'hook' | 'program' | 'daemon';
  event: string;
  session?: string;
  state?: AgentStateName;
  need?: Need;
  message?: string;
  cwd?: string;
  pid?: number;
  data?: Record<string, unknown>;
}

export interface Process {
  pid: number;
  argv: string[];
  exe?: string;
  cwd?: string;
  started_at?: string;
}

export interface Reply {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

export interface Pane {
  id: PaneId;
  name?: string;
  command: string[];
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  hidden: boolean;
  ttl_ms?: number;
  created_at: string;
  title: string;
  mark: Mark;
  last_output_at?: string;
  state: 'running' | 'exited';
  exit?: Exit;
  exited_at?: string;
  /** Once its shell sent OSC 133 marks. */
  shell?: Shell;
  /** Once an agent reported. */
  agent?: AgentStatus;
}

export interface HelloResult {
  protocol: 1;
  daemon: {
    version: string;
    pid: number;
    os: string;
    arch: string;
    started_at: string;
    draining?: string;
  };
  methods: string[];
}

export type Input =
  | { text: string; mode: 'raw' | 'paste' }
  | { text: string; mode: 'typed'; delay_ms?: number }
  | { key: string };

export interface SendResult {
  bytes: number;
  mark: Mark;
}

export interface RowChange {
  row: number;
  before: string;
  after: string;
}

export interface WaitResult {
  condition: 'text' | 'quiet' | 'exit' | 'prompt' | 'timeout';
  since: Mark;
  mark: Mark;
  output: string;
  truncated?: boolean;
  match?: string;
  groups?: string[];
  exit?: Exit;
  changes: RowChange[];
  screen: string[];
  shell?: Shell;
}

export interface Span {
  col: number;
  width: number;
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  blink?: boolean;
  inverse?: boolean;
  invisible?: boolean;
  strike?: boolean;
  fg?: number | string;
  bg?: number | string;
}

export interface CaptureResult {
  mark: Mark;
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  alt_screen: boolean;
  title: string;
  history: number;
  lines: { text: string; spans?: Span[] }[];
  vt?: string;
}

export interface ReadResult {
  from: Mark;
  to: Mark;
  end: Mark;
  truncated: boolean;
  text?: string;
  data?: string;
}

/** Each method's request fields (without v, type and id) and its result. */
export interface Methods {
  hello: { params: { client: { name: string; version?: string } }; result: HelloResult };
  cancel: { params: { request: number }; result: Record<string, never> };
  'events.subscribe': { params: { display?: boolean }; result: Record<string, never> };
  'pane.new': {
    params: {
      command?: string[];
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      name?: string;
      hidden?: boolean;
      ttl_ms?: number;
      scrollback?: number;
    };
    result: { pane: Pane };
  };
  'pane.list': { params: { hidden?: boolean }; result: { panes: Pane[] } };
  'pane.close': { params: { pane: PaneId; grace_ms?: number }; result: { pane: Pane; signalled: number } };
  'pane.resize': { params: { pane: PaneId; cols: number; rows: number }; result: { pane: Pane } };
  'pane.capture': {
    params: { pane: PaneId; styles?: boolean; history?: number; vt?: boolean };
    result: CaptureResult;
  };
  'pane.read': {
    params: { pane: PaneId; since: Mark; limit?: number; format?: 'text' | 'raw' };
    result: ReadResult;
  };
  'pane.send': { params: { pane: PaneId; input: Input[] }; result: SendResult };
  'pane.wait': {
    params: {
      pane: PaneId;
      text?: string;
      screen?: boolean;
      quiet_ms?: number;
      exit?: boolean;
      prompt?: boolean;
      since?: Mark;
      timeout_ms?: number;
    };
    result: WaitResult;
  };
  'pane.process': { params: { pane: PaneId }; result: { pane: PaneId; foreground: Process } };
  'pane.restart': { params: { pane: PaneId; grace_ms?: number }; result: { pane: Pane; replaced: Pane } };
  'pane.focus': { params: { pane: PaneId }; result: { displays: number } };
  'agent.report': {
    params: {
      pane?: PaneId;
      assistant: string;
      event: string;
      session?: string;
      state?: AgentStateName;
      need?: Need;
      message?: string;
      cwd?: string;
      pid?: number;
      data?: Record<string, unknown>;
      decide?: boolean;
      timeout_ms?: number;
    };
    result: { seq: number; asked: number; reply?: Reply };
  };
  'agent.events': { params: { pane?: PaneId; since?: number; limit?: number }; result: { reports: AgentReport[]; seq: number; truncated: boolean } };
  'agent.decisions': { params: Record<string, never>; result: Record<string, never> };
  'agent.decide': { params: { request: number; reply?: Reply }; result: Record<string, never> };
  'pane.settle': {
    params: { pane: PaneId; input: Input[]; quiet_ms?: number; timeout_ms?: number };
    result: { sent: SendResult; wait: WaitResult };
  };
  'pane.subscribe': {
    params: { pane: PaneId; since?: Mark; ack?: boolean; window?: number };
    result: { pane: PaneId; channel: Channel };
  };
  'pane.unsubscribe': { params: { channel: Channel }; result: Record<string, never> };
}

export type Method = keyof Methods;

export type ErrorCode =
  | 'bad_request'
  | 'hello_required'
  | 'unknown_method'
  | 'not_found'
  | 'pane_closed'
  | 'failed'
  | 'cancelled'
  | 'shutting_down'
  | 'internal';

export type DaemonEvent =
  | { event: 'pane.created'; pane: Pane }
  | { event: 'pane.title'; pane: Pane }
  | { event: 'pane.exited'; pane: Pane }
  | { event: 'pane.closed'; pane: Pane }
  | { event: 'pane.prompt'; pane: Pane }
  | { event: 'pane.focus'; pane: Pane }
  | { event: 'agent.report'; report: AgentReport; pane?: Pane }
  | { event: 'agent.decision'; request: number; report: AgentReport; timeout_ms: number }
  | { event: 'daemon.draining'; newer: string }
  | { event: 'stream.end'; channel: Channel; mark: Mark };

/** What the daemon sends as JSON. Fields a client does not know are kept. */
export type DaemonMessage =
  | { v: number; type: 'result'; id: number; method: string; result: unknown }
  | { v: number; type: 'error'; id?: number; error: { code: ErrorCode | string; message: string } }
  | ({ v: number; type: 'event' } & DaemonEvent);
