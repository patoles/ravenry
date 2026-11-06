// One hook event as the board records it (<RAVENRY_HOME>/events/<id>.jsonl,
// docs/STATE-RULES.md): what hooks/events.mjs writes for an event it gets
// on its standard input, and what server/ravenryd.mjs records for an event
// a ravenryd pane's hook reported through its daemon (`ravenryd hook`).
// Loaded by the hook on every event, so its imports stay the hook's own.

import { endingQuestion } from './state.mjs';
import { runningTasks, logTasks } from './tasks.mjs';
import { terminalOf } from './termenv.mjs';
import { shape } from './assistanthook.mjs';

const cap = (s, n) => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

// The record of one event, or null for an event the board does not
// record. `input` is the hook's input; `env` the environment the hook ran
// in (which terminal, which tab); `ppid` the assistant's process; `daemon`
// true when Codex's shared app-server ran the hook (its environment is
// another terminal's); `home` the data folder, for the task log; `at` the
// event's time (default now).
export function record(assistant, input, { env = {}, ppid = 0, daemon = false, home = null, at = null } = {}) {
  const sh = shape(assistant, input);
  if (!sh) return null;
  const ev = sh.event;
  const r = {
    at: at || new Date().toISOString(),
    event: ev,
    session_id: input.session_id,
    assistant,
    cwd: input.cwd || undefined,
    transcript_path: input.transcript_path || undefined,
    workspace_id: env.CMUX_WORKSPACE_ID || undefined,
    surface_id: env.CMUX_SURFACE_ID || undefined,
  };
  // The Claude process this session runs in, so the board can tie a process
  // (and its memory) to a session. Claude Code runs a hook through `sh -c`,
  // which execs a single command, so the hook's parent is Claude itself. It
  // costs nothing; the board trusts it only when that pid is a live claude
  // process that started before this event.
  // Codex's hooks run under Codex or its app-server daemon, which holds many
  // sessions, so its pid is kept under its own name and never mapped.
  if (ppid > 1) r[assistant === 'claude' ? 'claude_pid' : assistant + '_pid'] = ppid;
  // Which terminal the session runs in, and its id there (iTerm2's and
  // Terminal's session ids, Rex's block and session, a ravenryd pane), so
  // the board picks the adapter that can reach it, or shows it watch only
  // (docs/TERMINALS.md, server/termenv.mjs). Not from Codex's daemon, whose
  // environment is another terminal's.
  if (daemon) {
    delete r.workspace_id; delete r.surface_id;
    r.codex_daemon = true;
  } else {
    Object.assign(r, terminalOf(env));
    // Pane ids of terminals with no adapter yet, recorded for a later one.
    const pane = env.TMUX_PANE || env.WEZTERM_PANE || env.KITTY_WINDOW_ID;
    if (pane) r.pane = pane;
  }
  if (input.agent_id) r.agent_id = input.agent_id;
  if (ev === 'SessionStart') { r.source = input.source || undefined; r.model = input.model || undefined; }
  else if (ev === 'SessionEnd') r.reason = input.reason || undefined;
  else if (ev === 'Notification' && sh.extra.notification_type) Object.assign(r, sh.extra);
  else if (ev === 'Notification') {
    r.notification_type = input.notification_type || undefined;
    r.message = cap(input.message, 300);
    r.title = cap(input.title, 100);
  } else if (ev === 'Stop') {
    const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
    // The hand-off hook's bookkeeping line: the board reads the question
    // from the transcript instead (it skips that line).
    if (last.startsWith('Hand-off deferred:')) r.deferred = true;
    else {
      const q = last ? endingQuestion(last) : null;
      r.ends_on_question = !!q;
      if (q) r.question = cap(q, 300);
    }
    // Only tasks still running: Claude Code can keep a finished one listed
    // (server/tasks.mjs checks the transcript). What it sent is logged.
    const running = runningTasks(input);
    if (home) logTasks(home, input, running);
    r.background_tasks = running.length;
    if (Array.isArray(input.session_crons) && input.session_crons.length) r.crons = input.session_crons.length;
    if (input.stop_hook_active) r.stop_hook_active = true;
  }
  return r;
}
