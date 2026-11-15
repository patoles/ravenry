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
  /** pane.process: when its executable file was last modified. */
  exe_modified_at?: string;
  /** pane.process: the git work tree of its working directory. */
  git?: GitState;
  /** pane.process: whether its code changed since it started (left out when its start is unknown). */
  changed?: boolean;
  /** Why it changed: HEAD moved, tracked files edited, executable rebuilt. */
  changes?: ('head' | 'files' | 'exe')[];
}

/** The git work tree a process works in (pane.process). */
export interface GitState {
  root: string;
  head?: string;
  branch?: string;
  /** The commit HEAD named when the process started, from the HEAD reflog. */
  started_on?: string;
  /** Tracked files modified since it started, newest first, at most 20. */
  edited?: string[];
  /** Not every tracked file was checked. */
  partial?: true;
}

export interface Reply {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

/** Key-value tags for programs (PROTOCOL.md section 3, Name and labels). */
export type Labels = Record<string, string>;

export interface Pane {
  id: PaneId;
  name?: string;
  labels?: Labels;
  command: string[];
  /** Where it started, then the last folder its program reported with OSC 7. */
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  /** The history lines it keeps (pane.new, pane.update). */
  scrollback?: number;
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
  /** With pane.list's `processes`, on a running pane: the processes that belong to it now (PROTOCOL.md section 3). */
  pids?: number[];
  /** Who started it: an agent drives the panes it created and asks for any other. */
  creator?: Source;
  /** The driver that holds it now (pane.lease). */
  lease?: Lease;
  /** Its test conditions (pane.override). */
  overrides?: Overrides;
}

/** Where input, a pane or a lease comes from (PROTOCOL.md section 4, Panes and who drives them). */
export interface Source {
  kind: 'person' | 'agent' | 'client';
  /** agent: the pane it runs in. */
  pane?: PaneId;
  client?: string;
  /** Who typed it, as a person's client said: composer, phone. */
  by?: string;
}

export interface Lease {
  holder: Source;
  acquired_at: string;
  expires_at: string;
  /** Who waits for it, in turn: the first is handed it when it ends. */
  waiting?: Source[];
}

export interface Overrides {
  cols?: number;
  rows?: number;
  slow_bps?: number;
  /** The TERM of its next restart. */
  term?: string;
}

/** One entry of a pane's input log: who typed what. */
export interface InputRecord {
  seq: number;
  at: string;
  source: Source;
  kind: 'send' | 'keys' | 'secret' | 'restart';
  mark: Mark;
  bytes: number;
  /** Absent for a secret and when masked (a password prompt). */
  text?: string;
  /** What a window shows: the lines entered after line editing, no keys that type nothing; '' when nothing (a menu answered with arrows, a lone Esc). Absent from an older daemon. */
  shown?: string;
  masked?: boolean;
  truncated?: boolean;
  until?: string;
  /** The person typed while this other driver held the lease: marked, never held back. */
  lease_holder?: Source;
}

/** A person let an agent drive a pane it did not create, for its session. */
export interface Grant {
  id: string;
  pane: PaneId;
  agent: Source;
  action?: DriveAction;
  allow: 'session';
  session?: string;
  checkpoint?: CheckpointId;
  created_at: string;
}

export interface FileTouch {
  path: string;
  sources: ('hook' | 'git')[];
  tool?: string;
  count?: number;
  at?: string;
  status?: string;
}

/** A window's terminal colours, "#rrggbb" each: pictures of a pane drawn as the window shows it live. */
export interface Theme {
  foreground: string;
  background: string;
  cursor?: string;
  /** 16 colours, or none. */
  palette?: string[];
}

export interface FilmFrame {
  at: string;
  mark: Mark;
  /** format png: the frame, base64. */
  png?: string;
  /** Rows blank here that the frames before and after both have drawn (a redraw seen half done); a newer daemon always sends it. */
  missing_rows?: number;
}

export interface FramesResult {
  pane?: PaneId;
  format: 'png' | 'gif' | 'apng';
  frames: FilmFrame[];
  from?: string;
  to?: string;
  skipped?: number;
  /** png: frames listed without a png, their pictures over the answer's 12 MiB. */
  unpictured?: number;
  /** gif or apng: the animation, base64. */
  data?: string;
  width?: number;
  height?: number;
}

export interface FixtureEvent {
  /** Milliseconds after the start. */
  t: number;
  /** Output, base64. */
  data?: string;
  cols?: number;
  rows?: number;
}

/** A recording of a pane's output with its timing: a test fixture. */
export interface Fixture {
  format: 'ravenry.fixture';
  version: 1;
  pane?: PaneId;
  command?: string[];
  term?: string;
  cols: number;
  rows: number;
  started_at?: string;
  from: Mark;
  to: Mark;
  events: FixtureEvent[];
}

/** drive: who asks to type into which pane, and a preview of what. */
export interface Drive {
  pane: PaneId;
  agent: Source;
  input?: string;
  /** The agent's own words on why it asks, when it gave them. */
  reason?: string;
  /** What it asks to do to the pane; absent means input. */
  action?: DriveAction;
}

export type DriveAction = 'input' | 'close' | 'restart' | 'override';

/** One choice of a pick: a file on the daemon's machine (a shot of `pane` when set). */
export interface Variant {
  label: string;
  /** The agent's words on this variant, shown under its picture. */
  description?: string;
  path: string;
  type: 'image' | 'html';
  size: number;
  pane?: PaneId;
}

/** A part of a variant, in fractions of its width and height. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A person's pick: a variant, perhaps a region of it and a note ("this, but..."). */
export interface Pick {
  label: string;
  region?: Region;
  note?: string;
}

export interface FileInfo {
  path: string;
  type: 'file' | 'dir' | 'other' | 'none';
  size?: number;
  modified_at?: string;
}

export interface FileReadResult {
  path: string;
  size: number;
  modified_at: string;
  from: number;
  to: number;
  text?: string;
  data?: string;
}

export type CheckpointId = string;
export type CheckpointKind = 'ask' | 'approve' | 'secret' | 'drive' | 'pick';
export type CheckpointState = 'open' | 'running' | 'answered' | 'declined' | 'cancelled' | 'expired';

/** Where a secret goes; never to the agent. */
export interface SecretTarget {
  to: 'input' | 'run' | 'env';
  pane?: PaneId;
  enter?: boolean;
  env?: string;
}

/** What a person answered. Never holds a secret: only `delivered`. */
export interface CheckpointAnswer {
  choice?: number;
  option?: string;
  text?: string;
  approved?: boolean;
  /** The command as the person edited it, only when it differs from the proposed one: this is what ran. */
  command?: string;
  delivered?: boolean;
  declined?: boolean;
  /** Why the person declined, when they said. */
  reason?: string;
  /** An approved drive: for that input once, or for the agent's session. */
  allow?: 'once' | 'session';
  pick?: Pick;
  by?: string;
  at: string;
}

export interface CheckpointRun {
  pane: PaneId;
  exit?: Exit;
  output?: string;
  truncated?: boolean;
}

/** A point where an agent waits for a person (PROTOCOL.md section 4, Checkpoints). */
export interface Checkpoint {
  id: CheckpointId;
  /** A kind this client does not know: show the title and offer decline. */
  kind: CheckpointKind | string;
  state: CheckpointState;
  title: string;
  pane?: PaneId;
  assistant?: string;
  options?: string[];
  free_text?: boolean;
  /** As the agent proposed it; answer.command is what ran when the person edited it. */
  command?: string;
  cwd?: string;
  /** The agent's words: why it should run. */
  why?: string;
  /** approve: the agent's own warning (what can't be undone). Show it as the agent's words. */
  warning?: string;
  /** approve: the variables the command runs with (a page's button passes an item's values this way). Show them beside the command. */
  env?: Record<string, string>;
  secret?: SecretTarget;
  drive?: Drive;
  variants?: Variant[];
  created_at: string;
  expires_at: string;
  closed_at?: string;
  reason?: string;
  /** A cancelled one the person answered another way instead: terminal, in the agent's own terminal. */
  answered_in?: 'terminal';
  /** A closed one no client was waiting on as it closed (checkpoint.wait): the hub types the answer into the asking session. */
  nobody_waiting?: boolean;
  answer?: CheckpointAnswer;
  run?: CheckpointRun;
}

/**
 * checkpoint.answer: exactly one of choice, text, approve, secret, decline.
 * An approve may carry `command`, the command as the person edited it
 * (it runs instead); a decline may carry `reason`, for the agent.
 */
export type CheckpointReply =
  | { choice: number }
  | { text: string }
  | { approve: true; command?: string; allow?: 'once' | 'session' }
  | { secret: string }
  | { pick: Pick }
  | { decline: true; reason?: string };

export interface HelloResult {
  protocol: 1;
  daemon: {
    version: string;
    pid: number;
    os: string;
    arch: string;
    started_at: string;
    /** The home folder of the user the daemon runs as: say this machine's folders with ~. */
    home?: string;
    draining?: string;
  };
  methods: string[];
  /** This connection may act as the person: answer checkpoints, decide for hooks (PROTOCOL.md section 4, Who acts as the person). */
  person: boolean;
}

/** One input event of a render stream (docs/RENDERING.md): exactly one field. */
export type RenderEvent =
  | {
      key: {
        code: string;
        action?: 'press' | 'repeat' | 'release';
        mods?: number;
        consumed?: number;
        text?: string;
        unshifted?: number;
        composing?: boolean;
        option_as_alt?: '' | 'left' | 'right' | 'both';
      };
    }
  | {
      mouse: {
        action: 'press' | 'release' | 'motion';
        button?: '' | 'left' | 'right' | 'middle' | 'wheel_up' | 'wheel_down' | 'wheel_left' | 'wheel_right';
        mods?: number;
        x: number;
        y: number;
        cell_width: number;
        cell_height: number;
        held?: boolean;
      };
    }
  | { text: string }
  | { paste: string }
  | { focus: boolean }
  | { wheel: { rows: number; mods?: number; x?: number; y?: number; cell_width?: number; cell_height?: number } }
  | {
      select: {
        action: 'press' | 'drag' | 'release' | 'all' | 'clear';
        col?: number;
        row?: number;
        x?: number;
        y?: number;
        cell_width?: number;
        cell_height?: number;
        extend?: boolean;
        rect?: boolean;
      };
    }
  | { paths: string[] };

/** A cell in screen coordinates: row 0 is the oldest scrollback row kept. */
export interface RenderPoint {
  x: number;
  y: number;
}

export type Input =
  | { text: string; mode: 'raw' | 'paste' }
  | { text: string; mode: 'typed'; delay_ms?: number }
  | { key: string };

export interface SendResult {
  pane: PaneId;
  bytes: number;
  mark: Mark;
}

export interface RowChange {
  row: number;
  before: string;
  after: string;
}

export interface WaitResult {
  pane: PaneId;
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
  hello: { params: { client: { name: string; version?: string }; answer_key?: string }; result: HelloResult };
  cancel: { params: { request: number }; result: Record<string, never> };
  'events.subscribe': { params: { display?: boolean; activity?: boolean }; result: Record<string, never> };
  'pane.new': {
    params: {
      command?: string[];
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      name?: string;
      labels?: Labels;
      hidden?: boolean;
      ttl_ms?: number;
      scrollback?: number;
    };
    result: { pane: Pane };
  };
  'pane.list': { params: { hidden?: boolean; labels?: Labels; processes?: boolean }; result: { panes: Pane[] } };
  'pane.update': { params: { pane: PaneId; name?: string; labels?: Record<string, string | null>; scrollback?: number }; result: { pane: Pane } };
  'pane.close': { params: { pane: PaneId; grace_ms?: number; no_wait?: boolean; reason?: string }; result: { pane: Pane; signalled: number } };
  'pane.resize': { params: { pane: PaneId; cols: number; rows: number }; result: { pane: Pane } };
  'pane.capture': {
    params: { pane: PaneId; styles?: boolean; history?: number; vt?: boolean };
    result: CaptureResult;
  };
  'pane.read': {
    params: { pane: PaneId; since: Mark; limit?: number; format?: 'text' | 'raw' };
    result: ReadResult;
  };
  'pane.send': { params: { pane: PaneId; input: Input[]; by?: string; no_wait?: boolean; reason?: string }; result: SendResult };
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
  'pane.restart': {
    params: { pane: PaneId; grace_ms?: number; shell_command?: boolean; no_wait?: boolean; reason?: string };
    result: { pane: Pane; replaced: Pane; command?: string; mark?: Mark; stopped_by?: 'interrupt' | 'SIGTERM' | 'SIGKILL' };
  };
  'pane.focus': { params: { pane: PaneId }; result: { displays: number } };
  /** Cmd+K: clears the screen and scrollback; the prompt stays at the top. `cleared` is false on the alternate screen (nothing changed). Check supports('pane.clear') first. */
  'pane.clear': { params: { pane: PaneId }; result: { pane: Pane; cleared: boolean } };
  /** The render stream (docs/RENDERING.md): the screen as frames of changed rows (binary kind 4), for a client that draws it itself. */
  'pane.render': {
    params: { pane: PaneId; cols?: number; rows?: number; fps?: number; window?: number; keybinds?: 'macos' | 'none' };
    result: { pane: PaneId; channel: number; format: number };
  };
  'render.scroll': { params: { channel: number; offset: number }; result: Record<string, never> };
  'render.input': { params: { channel: number; events: RenderEvent[] }; result: Record<string, never> };
  'render.text': { params: { channel: number; from: RenderPoint; to: RenderPoint; rect?: boolean }; result: { text: string } };
  'render.copy': { params: { channel: number }; result: { text: string } };
  /** case_sensitive and regex: a daemon older than them refuses them (bad_request); pattern_error: the regex does not parse, and why; rows and lines: where a scrollbar marks the matches (none from an older daemon). */
  'render.find': { params: { channel: number; needle: string; step?: -1 | 0 | 1; case_sensitive?: boolean; regex?: boolean }; result: { count: number; selected: number; pattern_error?: string; rows?: number[]; lines?: number } };
  'render.link': { params: { channel: number; at: RenderPoint }; result: { uri?: string; from?: RenderPoint; to?: RenderPoint } };
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
    params: { pane: PaneId; input: Input[]; quiet_ms?: number; timeout_ms?: number; by?: string; no_wait?: boolean; reason?: string };
    result: { sent: SendResult; wait: WaitResult };
  };
  'pane.subscribe': {
    params: { pane: PaneId; since?: Mark; ack?: boolean; window?: number; kitty_keyboard?: boolean };
    result: { pane: PaneId; channel: Channel };
  };
  'pane.unsubscribe': { params: { channel: Channel }; result: Record<string, never> };
  'file.stat': { params: { paths: string[] }; result: { files: FileInfo[] } };
  'file.read': { params: { path: string; offset?: number; tail?: number; limit?: number; format?: 'text' | 'raw' }; result: FileReadResult };
  'checkpoint.new': {
    params: {
      kind: CheckpointKind;
      title: string;
      pane?: PaneId;
      options?: string[];
      free_text?: boolean;
      command?: string;
      cwd?: string;
      why?: string;
      warning?: string;
      env?: Record<string, string>;
      secret?: SecretTarget;
      drive?: { pane: PaneId; action?: DriveAction; reason?: string };
      variants?: { label: string; description?: string; path?: string; pane?: PaneId }[];
      timeout_ms?: number;
    };
    result: { checkpoint: Checkpoint };
  };
  'checkpoint.list': { params: { all?: boolean }; result: { checkpoints: Checkpoint[] } };
  'checkpoint.wait': { params: { checkpoint: CheckpointId; timeout_ms?: number }; result: { checkpoint: Checkpoint } };
  'checkpoint.answer': { params: { checkpoint: CheckpointId; by?: string } & CheckpointReply; result: { checkpoint: Checkpoint } };
  'checkpoint.cancel': { params: { checkpoint: CheckpointId; reason?: string; answered_in?: 'terminal' }; result: { checkpoint: Checkpoint } };
  'pane.inputs': { params: { pane: PaneId; since?: number; limit?: number }; result: { pane: PaneId; inputs: InputRecord[]; seq: number; truncated: boolean } };
  'pane.grants': { params: { pane?: PaneId }; result: { grants: Grant[] } };
  'pane.revoke': { params: { grant: string }; result: { grant: Grant } };
  'pane.lease': {
    params: { pane: PaneId; ttl_ms?: number; wait_ms?: number; release?: boolean; refuse_waiting?: boolean; no_wait?: boolean; reason?: string };
    result: { pane: PaneId; lease?: Lease };
  };
  'pane.files': { params: { pane: PaneId; no_git?: boolean }; result: { pane: PaneId; files: FileTouch[]; git_root?: string; partial?: boolean } };
  'pane.shot': {
    params: { pane: PaneId; cols?: number; rows?: number; font_size?: number; cursor?: boolean; theme?: Theme };
    result: { pane: PaneId; mark: Mark; cols: number; rows: number; width: number; height: number; png: string };
  };
  'pane.frames': {
    params: { pane: PaneId; last_ms?: number; format?: 'png' | 'gif' | 'apng'; max_frames?: number; font_size?: number; theme?: Theme };
    result: FramesResult;
  };
  'pane.recording': {
    params: { pane: PaneId; from?: Mark; to?: Mark; last_ms?: number; limit?: number };
    result: { fixture: Fixture; truncated: boolean };
  };
  'pane.replay': {
    params: {
      fixture: Fixture;
      speed?: number;
      cols?: number;
      rows?: number;
      slow_bps?: number;
      term?: string;
      headless?: boolean;
      shot?: boolean;
      frames?: 'png' | 'gif' | 'apng';
      font_size?: number;
      name?: string;
    };
    result: { pane?: Pane; capture?: Omit<CaptureResult, 'pane'> & { pane?: PaneId }; png?: string; frames?: FramesResult };
  };
  'pane.override': {
    params: { pane: PaneId; cols?: number; rows?: number; slow_bps?: number; term?: string; clear?: boolean; restart?: boolean; no_wait?: boolean; reason?: string };
    result: { pane: Pane };
  };
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
  | 'internal'
  | 'forbidden'
  | 'leased';

export type DaemonEvent =
  | { event: 'pane.created'; pane: Pane }
  | { event: 'pane.title'; pane: Pane }
  | { event: 'pane.exited'; pane: Pane }
  | { event: 'pane.closed'; pane: Pane }
  | { event: 'pane.prompt'; pane: Pane }
  | { event: 'pane.cwd'; pane: Pane }
  | { event: 'pane.updated'; pane: Pane }
  | { event: 'pane.activity'; pane: Pane }
  | { event: 'pane.bell'; pane: Pane }
  | { event: 'pane.focus'; pane: Pane }
  | { event: 'pane.input'; pane: Pane; input: InputRecord }
  | { event: 'pane.lease'; pane: Pane }
  | { event: 'checkpoint.opened'; checkpoint: Checkpoint }
  | { event: 'checkpoint.running'; checkpoint: Checkpoint }
  | { event: 'checkpoint.closed'; checkpoint: Checkpoint }
  | { event: 'agent.report'; report: AgentReport; pane?: Pane }
  | { event: 'agent.decision'; request: number; report: AgentReport; timeout_ms: number }
  | { event: 'daemon.draining'; newer: string }
  | { event: 'stream.end'; channel: Channel; mark: Mark };

/** What the daemon sends as JSON. Fields a client does not know are kept. */
export type DaemonMessage =
  | { v: number; type: 'result'; id: number; method: string; result: unknown }
  | { v: number; type: 'error'; id?: number; error: { code: ErrorCode | string; message: string; checkpoint?: CheckpointId; lease?: Lease } }
  | ({ v: number; type: 'event' } & DaemonEvent);
