// The hook side of the assistant interface (server/assistant.mjs): which
// assistant ran hooks/events.mjs, and its event in the board's shape. No
// imports: the hook loads this on every event and must start fast (as
// server/termenv.mjs for the terminal).
//
//   claude  Claude Code's hooks: the event as it comes (docs/STATE-RULES.md).
//   codex   OpenAI Codex's hooks (0.166.0): the same names for SessionStart,
//           SessionEnd, UserPromptSubmit and Stop. Codex has no Notification
//           event; PermissionRequest (an approval about to be asked) is
//           recorded as Claude Code's permission_prompt Notification, so every
//           rule that reads one (Needs you, the alert) reads it the same.
//           Interrupt (Esc, or a refused approval) is its own event: the turn
//           ended without a Stop.

export const ASSISTANTS = ['claude', 'codex'];

// `--assistant=<kind>` in the hook's command; none is Claude Code.
export function assistantOf(argv = process.argv) {
  const a = (argv.find((x) => String(x).startsWith('--assistant=')) || '').slice('--assistant='.length);
  return ASSISTANTS.includes(a) ? a : 'claude';
}

const cap = (s, n) => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

// The event name and the fields particular to this assistant's input.
// Returns { event, extra } or null for an event the board does not record.
export function shape(assistant, input) {
  const ev = input.hook_event_name;
  if (assistant !== 'codex') return { event: ev, extra: {} };
  if (ev === 'PermissionRequest') {
    const ti = input.tool_input || {};
    const what = (typeof ti.description === 'string' && ti.description) || (typeof ti.command === 'string' ? `Run ${ti.command}` : null) || `Codex asks to use ${input.tool_name || 'a tool'}`;
    return { event: 'Notification', extra: { notification_type: 'permission_prompt', message: cap(what, 300), title: cap(input.tool_name, 100), source_event: 'PermissionRequest' } };
  }
  if (['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Interrupt'].includes(ev)) return { event: ev, extra: {} };
  return null;
}

// Is this Codex hook run by Codex's shared app-server daemon? Codex started
// outside cmux runs its sessions in one daemon (`codex app-server`), and its
// hooks run there with the environment of whichever terminal started the
// daemon, so CMUX_SURFACE_ID, ITERM_SESSION_ID and the like may name another
// session's tab (measured on 0.166.0: a second session in a new cmux tab
// reported the first tab's surface). Inside cmux, cmux's wrapper starts
// Codex with its hooks in the session's own process, which is not the
// daemon. `ps` costs about 10 ms; only Codex's hooks ask.
export async function codexDaemon(ppid = process.ppid) {
  try {
    const { execFileSync } = await import('node:child_process');
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\sapp-server(\s|$)/.test(cmd);
  } catch { return false; }
}
