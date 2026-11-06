// Which terminal a Claude session runs in, from the variables each terminal
// sets in its tabs. hooks/events.mjs records it on every event, so the
// board knows per session which adapter (server/terminal.mjs) can reach it.
// No imports: the hook loads this on every event and must start fast.
//
//   cmux       CMUX_SURFACE_ID (the board's own ids; checked first, since a
//              cmux tab may inherit another terminal's variables)
//   tmux       TMUX: the outer terminal's ids would name the tmux client,
//              not this pane, so a session inside tmux is watch only
//   rex        REX_BLOCK ("block:<uuid>"), kept as terminal_id, with
//              REX_SESSION as terminal_session. Before iTerm2: a Rex server
//              started from an iTerm2 tab hands ITERM_SESSION_ID to every
//              Rex pane, so with both set TERM_PROGRAM (Rex sets "rex")
//              says which terminal is the pane's own
//   iterm      ITERM_SESSION_ID ("w0t1p0:<UUID>"), kept as terminal_id
//   apple-terminal  TERM_PROGRAM=Apple_Terminal with TERM_SESSION_ID
//   anything else   TERM_PROGRAM (vscode, ghostty, WezTerm, ...), else none
const PROGRAMS = {
  'iTerm.app': 'iterm', Apple_Terminal: 'apple-terminal', vscode: 'vscode', ghostty: 'ghostty',
  WezTerm: 'wezterm', WarpTerminal: 'warp', rex: 'rex', Hyper: 'hyper', zed: 'zed', Alacritty: 'alacritty', kitty: 'kitty',
};

export function terminalOf(env) {
  const e = env || {};
  if (e.CMUX_SURFACE_ID) return { terminal: 'cmux' };
  if (e.TMUX) return { terminal: 'tmux' };
  if (e.REX_BLOCK && (e.TERM_PROGRAM === 'rex' || !e.ITERM_SESSION_ID)) {
    const r = { terminal: 'rex', terminal_id: String(e.REX_BLOCK).slice(0, 80) };
    if (e.REX_SESSION) r.terminal_session = String(e.REX_SESSION).slice(0, 80);
    return r;
  }
  if (e.ITERM_SESSION_ID) return { terminal: 'iterm', terminal_id: String(e.ITERM_SESSION_ID).slice(0, 80) };
  if (e.TERM_PROGRAM === 'Apple_Terminal' && e.TERM_SESSION_ID) return { terminal: 'apple-terminal', terminal_id: String(e.TERM_SESSION_ID).slice(0, 80) };
  if (e.WEZTERM_PANE) return { terminal: 'wezterm' };
  if (e.KITTY_WINDOW_ID) return { terminal: 'kitty' };
  const tp = String(e.TERM_PROGRAM || '').trim();
  if (tp) return { terminal: PROGRAMS[tp] || tp.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 40) };
  return {};
}
